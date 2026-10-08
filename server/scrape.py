"""Scraping for asset scouts: find files on web pages, download them and unpack archives.

The `scrape` tool works in the agent's working folder (the chat's /work, or the project it's in), so run_code can
process what it fetched (convert, slice sprite sheets, trim audio) before asset_library adds it to a library.

- links: a page's links and media (images, audio, video, srcset, og:image), sorted into downloadable files and pages.
  browser=true renders the page in a real headless Firefox first, for sites that build their pages with JavaScript;
  it can wait, scroll to load lazy content and click "load more" buttons.
- download: one or many URLs into downloads/ (or `to`), four at a time, unpacking .zip/.tar archives as they land.
- extract: unpack an archive that's already in the folder.

Firefox is driven over its own Marionette socket (geckodriver 0.37 on this arm64 snap drops the session). Each browse
gets a fresh throwaway profile whose proxy settings send private and local addresses to a dead port, so a page can't
reach this machine's services; downloads refuse local addresses on every redirect hop too.
"""
import asyncio
import ipaddress
import json
import re
import shutil
import socket
import tarfile
import tempfile
import time
import zipfile
from pathlib import Path
from urllib.parse import unquote, urljoin, urlparse

import httpx

from tools import GUARD_HOOKS, UA, ToolResult, _blocked_host, _fn

FIREFOX = "/snap/bin/firefox"
SNAP_TMP = Path.home() / "snap" / "firefox" / "common" / "tmp"   # snap Firefox can only read profiles under its own dirs
FILE_LIMIT = 300 * 1024 * 1024
CALL_LIMIT = 2 * 1024 * 1024 * 1024
MAX_URLS = 60
EXTRACT_LIMIT = 4000          # files per archive
ARCHIVE_EXT = (".zip", ".tar", ".tar.gz", ".tgz", ".tar.bz2", ".tbz2", ".tar.xz", ".txz")
MEDIA_EXT = {
    "image": {".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".tga", ".tif", ".tiff", ".svg", ".ico", ".psd", ".exr", ".hdr", ".ktx2", ".dds"},
    "audio": {".mp3", ".wav", ".ogg", ".oga", ".flac", ".m4a", ".aac", ".opus", ".mid", ".midi", ".xm", ".mod", ".it", ".s3m"},
    "video": {".mp4", ".webm", ".mov", ".mkv", ".m4v"},
    "model": {".glb", ".gltf", ".obj", ".fbx", ".stl", ".dae", ".blend", ".ply", ".usdz", ".3ds", ".vox"},
    "font": {".ttf", ".otf", ".woff", ".woff2"},
    "archive": {".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".unitypackage"},
    "data": {".json", ".tmx", ".tsx", ".atlas", ".plist", ".csv", ".xml", ".pdf"},
}
_browser_lock = asyncio.Lock()   # one Firefox at a time: it's a shared box


def ext_kind(url_or_name: str) -> str | None:
    path = unquote(urlparse(url_or_name).path if "://" in url_or_name else url_or_name).lower()
    for k, exts in MEDIA_EXT.items():
        if any(path.endswith(e) for e in exts):
            return k
    return None


def _check_url(url: str) -> str:
    p = urlparse(url)
    if p.scheme not in ("http", "https") or not p.hostname:
        raise ValueError(f"Only http(s) URLs: {url!r}")
    if _blocked_host(p.hostname):
        raise ValueError(f"Local addresses are off limits: {url!r}")
    return url


def client(timeout=60) -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=20), follow_redirects=True,
                             headers={"User-Agent": UA, "Accept": "*/*"}, event_hooks=GUARD_HOOKS)


# ── headless Firefox over Marionette ────────────────────────────────────────

PAC = """function FindProxyForURL(url, host) {
  if (isPlainHostName(host) || host == "localhost" || shExpMatch(host, "*.local") || shExpMatch(host, "*.internal")) return "PROXY 127.0.0.1:9";
  var ip = dnsResolve(host);
  if (!ip) return "DIRECT";
  if (isInNet(ip, "127.0.0.0", "255.0.0.0") || isInNet(ip, "10.0.0.0", "255.0.0.0") || isInNet(ip, "172.16.0.0", "255.240.0.0")
      || isInNet(ip, "192.168.0.0", "255.255.0.0") || isInNet(ip, "169.254.0.0", "255.255.0.0") || isInNet(ip, "100.64.0.0", "255.192.0.0")
      || isInNet(ip, "0.0.0.0", "255.0.0.0")) return "PROXY 127.0.0.1:9";
  return "DIRECT";
}"""


class Marionette:
    """The few Marionette commands a scout needs. Wire format: `<len>:[0, id, command, params]`."""

    def __init__(self, reader, writer):
        self.r, self.w, self.n = reader, writer, 0

    async def _read(self):
        size = b""
        while not size.endswith(b":"):
            size += await self.r.readexactly(1)
        return json.loads(await self.r.readexactly(int(size[:-1])))

    async def cmd(self, name, params=None, timeout=60):
        self.n += 1
        body = json.dumps([0, self.n, name, params or {}]).encode()
        self.w.write(str(len(body)).encode() + b":" + body)
        await self.w.drain()
        while True:
            m = await asyncio.wait_for(self._read(), timeout)
            if m[0] == 1 and m[1] == self.n:
                if m[2]:
                    err = m[2]
                    raise RuntimeError((err.get("message") or err.get("error") or str(err)) if isinstance(err, dict) else str(err))
                return m[3]

    async def run(self, script, args=None, timeout=30):
        return (await self.cmd("WebDriver:ExecuteScript", {"script": script, "args": args or []}, timeout + 5)).get("value")


class Browser:
    """`async with Browser() as b:` launches a throwaway headless Firefox and quits it afterwards."""

    async def __aenter__(self):
        await _browser_lock.acquire()
        try:
            SNAP_TMP.mkdir(parents=True, exist_ok=True)
            s = socket.socket()
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
            s.close()
            self.profile = Path(tempfile.mkdtemp(dir=SNAP_TMP, prefix="scout-"))
            prefs = {"marionette.port": port, "browser.shell.checkDefaultBrowser": False, "datareporting.policy.dataSubmissionEnabled": False,
                     "network.proxy.type": 2, "network.proxy.autoconfig_url": "data:application/x-ns-proxy-autoconfig," + PAC,
                     "network.proxy.allow_hijacking_localhost": True, "network.proxy.failover_direct": False,
                     "browser.download.dir": str(self.profile), "media.autoplay.default": 5, "general.useragent.override": UA}
            (self.profile / "user.js").write_text("".join(f"user_pref({json.dumps(k)}, {json.dumps(v)});\n" for k, v in prefs.items()))
            self.proc = await asyncio.create_subprocess_exec(
                FIREFOX, "--marionette", "--headless", "--no-remote", "--profile", str(self.profile), "--window-size=1366,900",
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
            for _ in range(150):
                try:
                    r, w = await asyncio.open_connection("127.0.0.1", port)
                    break
                except OSError:
                    await asyncio.sleep(0.2)
            else:
                raise RuntimeError("Firefox didn't start")
            self.m = Marionette(r, w)
            await asyncio.wait_for(self.m._read(), 20)   # hello
            await self.m.cmd("WebDriver:NewSession", {"capabilities": {"alwaysMatch": {
                "pageLoadStrategy": "normal", "timeouts": {"pageLoad": 45000, "script": 30000}}}})
            return self
        except BaseException:
            await self._close()
            raise

    async def _close(self):
        try:
            if getattr(self, "m", None):
                await asyncio.wait_for(self.m.cmd("Marionette:Quit", {"flags": ["eForceQuit"]}), 5)
        except Exception:
            pass
        proc = getattr(self, "proc", None)
        if proc and proc.returncode is None:
            try:
                proc.kill()
                await asyncio.wait_for(proc.wait(), 5)
            except Exception:
                pass
        if getattr(self, "profile", None):
            shutil.rmtree(self.profile, ignore_errors=True)
        _browser_lock.release()

    async def __aexit__(self, *exc):
        await self._close()

    async def goto(self, url):
        try:
            await self.m.cmd("WebDriver:Navigate", {"url": url}, timeout=60)
        except RuntimeError as e:   # a page that never finishes loading is still worth reading
            if "timeout" not in str(e).lower():
                raise


COLLECT_JS = r"""
const abs = u => { try { return u ? new URL(u, location.href).href : null } catch (e) { return null } };
const out = {title: document.title, url: location.href, links: [], media: [], text: ''};
for (const a of document.querySelectorAll('a[href]')) out.links.push([abs(a.getAttribute('href')), (a.innerText || a.title || a.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 140), a.hasAttribute('download')]);
for (const i of document.querySelectorAll('img')) {
  out.media.push(['img', abs(i.currentSrc || i.getAttribute('src') || i.getAttribute('data-src')), (i.alt || '').slice(0, 140), i.naturalWidth || 0, i.naturalHeight || 0]);
  const ss = i.getAttribute('srcset') || i.getAttribute('data-srcset');
  if (ss) for (const part of ss.split(',')) { const u = part.trim().split(/\s+/)[0]; if (u) out.media.push(['srcset', abs(u), (i.alt || '').slice(0, 140), 0, 0]); }
}
for (const el of document.querySelectorAll('audio[src], video[src], source[src], track[src], embed[src], object[data]'))
  out.media.push([el.tagName.toLowerCase(), abs(el.getAttribute('src') || el.getAttribute('data')), el.title || '', 0, 0]);
for (const m of document.querySelectorAll('meta[property="og:image"], meta[property="og:audio"], meta[property="og:video"], meta[name="twitter:image"]'))
  out.media.push(['meta', abs(m.content), m.getAttribute('property') || m.name, 0, 0]);
for (const el of document.querySelectorAll('[style*="url("]')) {
  const m = /url\(["']?([^"')]+)/.exec(el.getAttribute('style')); if (m) out.media.push(['css', abs(m[1]), '', 0, 0]);
}
out.text = (document.body ? document.body.innerText : '').replace(/\n{3,}/g, '\n\n').slice(0, arguments[0]);
return out;
"""


def _collect_static(html: str, base: str, text_limit: int) -> dict:
    import lxml.html
    doc = lxml.html.fromstring(html)
    doc.make_links_absolute(base, resolve_base_href=True)
    abs_ = lambda u: urljoin(base, u) if u else None
    out = {"title": (doc.findtext(".//title") or "").strip(), "url": base, "links": [], "media": [], "text": ""}
    for a in doc.iter("a"):
        if a.get("href"):
            out["links"].append([a.get("href"), " ".join(a.text_content().split())[:140] or a.get("title") or "", a.get("download") is not None])
    for i in doc.iter("img"):
        src = i.get("src") or i.get("data-src")
        out["media"].append(["img", abs_(src), (i.get("alt") or "")[:140], int(i.get("width") or 0) if (i.get("width") or "").isdigit() else 0,
                             int(i.get("height") or 0) if (i.get("height") or "").isdigit() else 0])
        for part in (i.get("srcset") or i.get("data-srcset") or "").split(","):
            u = part.strip().split(" ")[0] if part.strip() else ""
            if u:
                out["media"].append(["srcset", abs_(u), (i.get("alt") or "")[:140], 0, 0])
    for tag in ("audio", "video", "source", "track", "embed"):
        for el in doc.iter(tag):
            if el.get("src"):
                out["media"].append([tag, abs_(el.get("src")), el.get("title") or "", 0, 0])
    for m in doc.xpath('//meta[@property="og:image" or @property="og:audio" or @property="og:video" or @name="twitter:image"]'):
        out["media"].append(["meta", abs_(m.get("content")), m.get("property") or m.get("name") or "", 0, 0])
    for el in doc.xpath("//*[contains(@style, 'url(')]"):
        mm = re.search(r"url\([\"']?([^\"')]+)", el.get("style") or "")
        if mm:
            out["media"].append(["css", abs_(mm.group(1)), "", 0, 0])
    if text_limit:
        for bad in doc.xpath("//script|//style|//noscript"):
            bad.drop_tree()
        body = doc.find("body")
        out["text"] = re.sub(r"\n{3,}", "\n\n", (body if body is not None else doc).text_content())[:text_limit]
    return out


async def collect(url: str, browser=False, wait=0.0, scroll=0, click="", text_limit=0) -> dict:
    _check_url(url)
    if not browser:
        async with client(45) as c:
            r = await c.get(url)
            r.raise_for_status()
        if "html" not in r.headers.get("content-type", "html"):
            raise ValueError(f"{url} is not a web page ({r.headers.get('content-type')}); download it instead.")
        return await asyncio.to_thread(_collect_static, r.text, str(r.url), text_limit)
    async with Browser() as b:
        await b.goto(url)
        await asyncio.sleep(min(max(wait, 1.0), 20))
        for _ in range(min(int(scroll or 0), 25)):
            await b.m.run("window.scrollTo(0, document.body.scrollHeight)")
            await asyncio.sleep(1.2)
        if click:
            for _ in range(10):  # "load more" style buttons: press until they stop appearing
                ok = await b.m.run("const e = document.querySelector(arguments[0]); if (!e) return false; e.scrollIntoView(); e.click(); return true;", [click])
                if not ok:
                    break
                await asyncio.sleep(1.5)
        return await b.m.run(COLLECT_JS, [int(text_limit)], timeout=30)


def _summarize(page: dict, match: str, kinds: list[str], same_site: bool, limit: int) -> str:
    rx = re.compile(match, re.I) if match else None
    host = urlparse(page["url"]).hostname or ""
    site = ".".join(host.split(".")[-2:])

    def keep(u):
        if not u or not u.startswith(("http://", "https://")):
            return False
        if same_site and not (urlparse(u).hostname or "").endswith(site):
            return False
        return not rx or bool(rx.search(u))

    files: dict[str, dict] = {}
    for tag, u, label, w, h in page["media"]:
        if keep(u) and u not in files:
            files[u] = {"kind": ext_kind(u) or ("image" if tag in ("img", "srcset") else "audio" if tag == "audio" else "video" if tag == "video" else "file"),
                        "label": label, "dims": f"{w}×{h}" if w and h else "", "via": tag}
    pages: dict[str, str] = {}
    for u, label, dl in page["links"]:
        if not keep(u):
            continue
        u = u.split("#")[0]
        k = ext_kind(u)
        if k or dl:
            files.setdefault(u, {"kind": k or "file", "label": label, "dims": "", "via": "link"})
        elif u != page["url"] and u not in pages:
            pages[u] = label
    if kinds:
        files = {u: f for u, f in files.items() if f["kind"] in kinds}
    out = [f"# {page['title'] or '(untitled)'}\n{page['url']}"]
    by_kind: dict[str, list] = {}
    for u, f in files.items():
        by_kind.setdefault(f["kind"], []).append((u, f))
    if files:
        out.append(f"## Files ({len(files)})")
        for k, rows in sorted(by_kind.items(), key=lambda kv: -len(kv[1])):
            out.append(f"### {k} ({len(rows)})")
            out += [f"- {u}" + (f"  [{f['dims']}]" if f["dims"] else "") + (f"  \"{f['label']}\"" if f["label"] else "") for u, f in rows[:limit]]
            if len(rows) > limit:
                out.append(f"  …and {len(rows) - limit} more (narrow with match=)")
    else:
        out.append("## Files\n(none found" + (" matching the filter" if rx or kinds else "") + ")")
    if pages:
        out.append(f"## Pages ({len(pages)}): follow these to find more")
        out += [f"- {u}" + (f"  \"{label}\"" if label else "") for u, label in list(pages.items())[:limit]]
        if len(pages) > limit:
            out.append(f"  …and {len(pages) - limit} more (narrow with match=)")
    if page.get("text"):
        out.append("## Page text\n" + page["text"])
    return "\n".join(out)


# ── downloads and archives ──────────────────────────────────────────────────

def _filename(resp: httpx.Response, url: str) -> str:
    cd = resp.headers.get("content-disposition", "")
    m = re.search(r"filename\*=(?:UTF-8'')?([^;]+)", cd, re.I) or re.search(r'filename="?([^";]+)"?', cd, re.I)
    name = unquote(m.group(1).strip().strip('"')) if m else unquote(Path(urlparse(str(resp.url)).path).name or Path(urlparse(url).path).name)
    name = re.sub(r"[^\w.\- ()+,]+", "_", Path(name).name).strip(" .") or "download"
    if "." not in name:
        ctype = resp.headers.get("content-type", "").split(";")[0].strip()
        guess = {"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/svg+xml": ".svg",
                 "audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/ogg": ".ogg", "audio/flac": ".flac",
                 "video/mp4": ".mp4", "video/webm": ".webm", "application/zip": ".zip", "model/gltf-binary": ".glb",
                 "font/ttf": ".ttf", "font/otf": ".otf", "font/woff2": ".woff2", "application/json": ".json"}.get(ctype)
        name += guess or ""
    return name[:150]


def _unique(p: Path) -> Path:
    stem, n = p.stem, 1
    while p.exists():
        p = p.with_name(f"{stem}-{n}{p.suffix}")
        n += 1
    return p


def is_archive(p: Path) -> bool:
    n = p.name.lower()
    return any(n.endswith(e) for e in ARCHIVE_EXT)


def extract(archive: Path, dest: Path | None = None) -> list[Path]:
    """Unpack a zip or tar archive next to itself (or into dest), refusing paths that escape it. Returns the files."""
    n = archive.name.lower()
    stem = next((archive.name[:-len(e)] for e in ARCHIVE_EXT if n.endswith(e)), archive.stem)
    dest = dest or _unique(archive.parent / stem)
    dest.mkdir(parents=True, exist_ok=True)
    root = dest.resolve()
    out: list[Path] = []

    def safe(name):
        if name.startswith("__MACOSX") or any(part.startswith("._") or part == ".DS_Store" for part in Path(name).parts):
            return None
        p = (root / name).resolve()
        return p if str(p).startswith(str(root) + "/") else None

    if zipfile.is_zipfile(archive):
        with zipfile.ZipFile(archive) as z:
            infos = [i for i in z.infolist() if not i.is_dir()]
            if len(infos) > EXTRACT_LIMIT:
                raise ValueError(f"{archive.name} holds {len(infos)} files; the limit is {EXTRACT_LIMIT}.")
            if sum(i.file_size for i in infos) > CALL_LIMIT:
                raise ValueError(f"{archive.name} unpacks to more than {CALL_LIMIT // 2**30} GB.")
            for i in infos:
                p = safe(i.filename)
                if p:
                    p.parent.mkdir(parents=True, exist_ok=True)
                    with z.open(i) as src, open(p, "wb") as dst:
                        shutil.copyfileobj(src, dst)
                    out.append(p)
    elif tarfile.is_tarfile(archive):
        with tarfile.open(archive) as t:
            members = [m for m in t.getmembers() if m.isfile()]
            if len(members) > EXTRACT_LIMIT:
                raise ValueError(f"{archive.name} holds {len(members)} files; the limit is {EXTRACT_LIMIT}.")
            # tar headers carry each file's exact size, so a .tar.gz bomb is caught before anything is written
            if sum(m.size for m in members) > CALL_LIMIT:
                raise ValueError(f"{archive.name} unpacks to more than {CALL_LIMIT // 2**30} GB.")
            for m in members:
                p = safe(m.name)
                if p:
                    p.parent.mkdir(parents=True, exist_ok=True)
                    with t.extractfile(m) as src, open(p, "wb") as dst:
                        shutil.copyfileobj(src, dst)
                    out.append(p)
    else:
        raise ValueError(f"{archive.name} isn't a zip or tar archive (7z and rar can't be unpacked here).")
    # a single top-level folder inside the archive: lift its contents up one level
    tops = {p.relative_to(root).parts[0] for p in out}
    if len(tops) == 1 and all(len(p.relative_to(root).parts) > 1 for p in out):
        inner = root / tops.pop()
        moved = []
        for p in out:
            q = root / p.relative_to(inner)
            q.parent.mkdir(parents=True, exist_ok=True)
            p.rename(q)
            moved.append(q)
        shutil.rmtree(inner, ignore_errors=True)
        out = moved
    return out


async def fetch(c: httpx.AsyncClient, url: str, folder: Path, budget: list[int]) -> Path:
    """Stream one URL into folder (unique name). budget[0] is the bytes left for this call."""
    _check_url(url)
    async with c.stream("GET", url) as r:
        r.raise_for_status()
        size = int(r.headers.get("content-length") or 0)
        if size > FILE_LIMIT:
            raise ValueError(f"{size / 2**20:.0f} MB is over the {FILE_LIMIT // 2**20} MB per-file limit")
        if "text/html" in r.headers.get("content-type", "") and not ext_kind(url):
            raise ValueError("that's a web page, not a file (use action=links to find its files)")
        folder.mkdir(parents=True, exist_ok=True)
        dest = _unique(folder / _filename(r, url))
        got = 0
        with open(dest, "wb") as f:
            async for chunk in r.aiter_bytes(1 << 16):
                got += len(chunk)
                if got > FILE_LIMIT or got > budget[0]:
                    f.close()
                    dest.unlink(missing_ok=True)
                    raise ValueError("over the size limit")
                f.write(chunk)
        budget[0] -= got
        return dest


async def download_many(urls: list[str], folder: Path, unpack=True) -> list[dict]:
    budget = [CALL_LIMIT]
    sem = asyncio.Semaphore(4)
    results: list[dict] = [{} for _ in urls]
    async with client(120) as c:
        async def one(i, u):
            async with sem:
                try:
                    p = await fetch(c, u, folder, budget)
                    row = {"url": u, "path": p, "size": p.stat().st_size}
                    if unpack and is_archive(p):
                        files = await asyncio.to_thread(extract, p)
                        row["extracted"] = files
                        p.unlink(missing_ok=True)
                    results[i] = row
                except Exception as e:
                    results[i] = {"url": u, "error": f"{type(e).__name__}: {e}" if not isinstance(e, ValueError) else str(e)}
        await asyncio.gather(*(one(i, u) for i, u in enumerate(urls)))
    return results


# ── tool ────────────────────────────────────────────────────────────────────

def _root(ctx) -> Path:
    import library
    return library._dest_root(ctx)


def _rel(ctx, p: Path) -> str:
    rel = str(p.relative_to(_root(ctx)))
    return rel if ctx.project_id else f"/work/{rel}"


def _describe(ctx, paths: list[Path], cap=40) -> str:
    from collections import Counter
    kinds = Counter(ext_kind(p.name) or "other" for p in paths)
    lines = [f"  {_rel(ctx, p)} ({p.stat().st_size:,} B)" for p in paths[:cap]]
    more = f"\n  …and {len(paths) - cap} more" if len(paths) > cap else ""
    return f"{len(paths)} files (" + ", ".join(f"{n} {k}" for k, n in kinds.most_common()) + "):\n" + "\n".join(lines) + more


async def scrape(args, ctx):
    action = str(args.get("action") or "links").lower()
    try:
        if action == "links":
            url = str(args.get("url") or "").strip()
            kinds = args.get("kinds") or []
            kinds = [kinds] if isinstance(kinds, str) else list(kinds)
            page = await collect(url, bool(args.get("browser")), float(args.get("wait") or 0), int(args.get("scroll") or 0),
                                 str(args.get("click") or ""), 4000 if args.get("text") else 0)
            text = _summarize(page, str(args.get("match") or ""), kinds, bool(args.get("same_site")), int(args.get("limit") or 80))
            if not args.get("browser") and "## Files\n(none found)" in text:
                text += "\n\nNothing found: if the site builds its pages with JavaScript, try again with browser=true."
            return ToolResult(text, {"sources": [{"title": page["title"] or page["url"], "url": page["url"]}]})
        if action == "download":
            urls = args.get("urls") or ([args["url"]] if args.get("url") else [])
            urls = [u.strip() for u in ([urls] if isinstance(urls, str) else urls) if str(u).strip()]
            if not urls:
                return ToolResult("Pass url or urls.", error=True)
            if len(urls) > MAX_URLS:
                return ToolResult(f"At most {MAX_URLS} URLs per call; split the list.", error=True)
            import library
            to = str(args.get("to") or "downloads").strip()
            folder = library._dest(ctx, to)
            t0 = time.time()
            res = await download_many(list(dict.fromkeys(urls)), folder, args.get("extract", True) is not False)
            ok = [r for r in res if "path" in r]
            lines = []
            for r in res:
                if "error" in r:
                    lines.append(f"✗ {r['url']}: {r['error']}")
                elif "extracted" in r:
                    lines.append(f"✓ {r['url']} → unpacked {_describe(ctx, r['extracted'], 25)}")
                else:
                    lines.append(f"✓ {r['url']} → {_rel(ctx, r['path'])} ({r['size']:,} B)")
            total = sum(r["size"] for r in ok)
            head = f"Downloaded {len(ok)}/{len(res)} in {time.time() - t0:.0f}s ({total / 2**20:.1f} MB)."
            tail = ("\nNext: look at what you got (view_document/run_code), then add the keepers with asset_library "
                    "action=add files=[…] (globs like downloads/pack/**/*.png work).") if ok else ""
            return ToolResult(head + "\n" + "\n".join(lines) + tail)
        if action == "extract":
            import library
            p = library._dest(ctx, str(args.get("path") or ""))
            if not p.is_file():
                return ToolResult(f"No archive at {args.get('path')!r}.", error=True)
            dest = library._dest(ctx, str(args["to"])) if args.get("to") else None
            files = await asyncio.to_thread(extract, p, dest)
            return ToolResult("Unpacked " + _describe(ctx, files))
        return ToolResult("Unknown action. Use links, download or extract.", error=True)
    except (ValueError, httpx.HTTPError, RuntimeError, asyncio.TimeoutError) as e:
        msg = str(e) or type(e).__name__
        if isinstance(e, httpx.HTTPStatusError):
            msg = f"HTTP {e.response.status_code} from {e.request.url}"
        return ToolResult(msg, error=True)


GUIDE = ("- scrape finds and fetches files from the web into your working folder: links (url) lists a page's files "
         "(images, audio, models, fonts, archives) and the pages to follow next (browser=true renders JavaScript sites in "
         "headless Firefox; scroll= and click= load more); download (urls) fetches up to 60 files at once and unpacks "
         ".zip/.tar packs; extract unpacks an archive. Then process with run_code and keep the good ones with asset_library add.")


def register():
    from tools import TOOLS
    TOOLS["scrape"] = {
        "fn": scrape, "service": None,
        "ui": {"displayName": "Asset Scraper", "icon": "Download", "category": "web",
               "description": "Finds files on web pages (headless Firefox for JavaScript sites), downloads them and unpacks archives."},
        "schema": _fn("scrape",
                      "Collect files from the web into your working folder. links: list a page's downloadable files "
                      "(images, sounds, music, models, fonts, archives) and the links to follow; browser=true renders the "
                      "page in headless Firefox first (JavaScript sites, lazy-loaded galleries). download: fetch one or many "
                      "file URLs (zip/tar packs are unpacked automatically). extract: unpack an archive already downloaded.",
                      {"action": {"type": "string", "enum": ["links", "download", "extract"]},
                       "url": {"type": "string", "description": "links: the page; download: one file URL"},
                       "urls": {"type": "array", "items": {"type": "string"}, "description": "download: file URLs (max 60)"},
                       "to": {"type": "string", "description": "download/extract: folder in your working dir (default downloads/)"},
                       "extract": {"type": "boolean", "description": "download: unpack archives (default true)"},
                       "path": {"type": "string", "description": "extract: the archive"},
                       "browser": {"type": "boolean", "description": "links: render with headless Firefox (slower; for JS sites)"},
                       "wait": {"type": "number", "description": "links+browser: seconds to let the page settle (default 1)"},
                       "scroll": {"type": "integer", "description": "links+browser: times to scroll to the bottom (lazy loading)"},
                       "click": {"type": "string", "description": "links+browser: CSS selector of a 'load more' button to press"},
                       "match": {"type": "string", "description": "links: regex the URLs must match, e.g. '\\.(png|wav)$' or '/content/'"},
                       "kinds": {"type": "array", "items": {"type": "string", "enum": list(MEDIA_EXT) + ["file"]},
                                 "description": "links: only these file kinds"},
                       "same_site": {"type": "boolean", "description": "links: only URLs on the page's own site"},
                       "text": {"type": "boolean", "description": "links: also return the page's visible text (licenses, credits)"},
                       "limit": {"type": "integer", "description": "links: max entries per group (default 80)"}},
                      ["action"]),
    }
