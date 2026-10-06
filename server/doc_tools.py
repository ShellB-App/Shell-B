"""Document and vision tools: read PDFs, Office files and pictures, look at pages, and identify text (OCR).

Files are addressed the way the sandbox sees them: /work/<name> (chat uploads, or the Studio project root) and
/project/<name> (a chat Project's knowledge files). http(s) URLs are downloaded into /work/downloads first.

Text comes from the file itself where it has any (PyMuPDF for PDFs, python-docx/pptx/openpyxl for Office, LibreOffice
to convert legacy formats). Scanned pages and pictures go through OCR: RapidOCR (PP-OCR on ONNX, CPU, ~1-2 s a page)
for exact text with confidences, or the vision model for layout-aware Markdown (tables, forms, handwriting).
"""
import asyncio
import hashlib
import io
import os
import re
import shutil
import tempfile
import time
from pathlib import Path
from urllib.parse import unquote, urlparse

import httpx
import pymupdf
from PIL import Image, ImageOps

import db
import groups
from tools import GUARD_HOOKS, TOOLS, UA, WORKSPACES, ToolResult, _blocked_host, _fn, _group_files

CACHE = db.DATA / "doc-cache"
CACHE.mkdir(exist_ok=True)

TEXT_LIMIT = 40_000       # chars per read_document call; continue with start=
AUTO_OCR_PAGES = 30       # scanned pages OCR'd per call before asking the model to page through
VIEW_PAGES = 4            # page images per view_document call
DOWNLOAD_LIMIT = 60 * 1024 * 1024

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".avif", ".heic"}
PDF_LIKE = {".pdf", ".xps", ".oxps", ".epub", ".mobi", ".fb2", ".cbz"}       # PyMuPDF opens these natively
OFFICE_NATIVE = {".docx", ".xlsx", ".xlsm", ".pptx"}                       # groups.extract reads these
OFFICE_LEGACY = {".doc": "docx", ".rtf": "docx", ".odt": "docx", ".wpd": "docx", ".pages": "docx",
                 ".xls": "xlsx", ".ods": "xlsx", ".numbers": "xlsx",
                 ".ppt": "pptx", ".odp": "pptx", ".key": "pptx"}
OFFICE_ALL = OFFICE_NATIVE | set(OFFICE_LEGACY)
OCR_LANGS = {"en": "en", "english": "en", "latin": "latin", "es": "latin", "spanish": "latin", "fr": "latin",
             "de": "latin", "pt": "latin", "it": "latin", "ja": "japan", "japanese": "japan", "japan": "japan",
             "zh": "ch", "chinese": "ch", "ch": "ch", "ko": "korean", "korean": "korean", "ru": "cyrillic",
             "cyrillic": "cyrillic"}


# ── locating files ──────────────────────────────────────────────────────────

def _work_root(ctx) -> Path:
    if ctx.project_id:
        return (db.DATA / "projects" / ctx.project_id).resolve()
    d = WORKSPACES / ctx.conv_id
    d.mkdir(exist_ok=True)
    return d.resolve()


def _inside(p: Path, base: Path) -> bool:
    return p == base or str(p).startswith(str(base) + os.sep)


def resolve(ctx, raw: str) -> Path:
    """Map a sandbox-style path (/work/x, /project/x, or plain x) to a real file, refusing anything outside."""
    raw = unquote(str(raw or "").strip())
    if not raw:
        raise ValueError("Give a file path, e.g. /work/report.pdf")
    gdir = _group_files(ctx)
    if raw.startswith("/project/") and gdir:
        base, rel = gdir.resolve(), raw[len("/project/"):]
    else:
        base = _work_root(ctx)
        rel = re.sub(r"^/?work(/|$)", "", raw).lstrip("/")
    p = (base / rel).resolve()
    if not _inside(p, base) or ".git" in p.relative_to(base).parts:
        raise ValueError(f"{raw!r} is outside the files you can read.")
    if not p.is_file():
        # a bare name that only exists in the Project's knowledge
        if gdir and not raw.startswith("/") and (gdir / rel).resolve().is_file():
            return (gdir / rel).resolve()
        raise FileNotFoundError(f"{raw} does not exist. Uploaded files live in /work"
                                + (", Project knowledge in /project" if gdir else "") + ".")
    return p


def display_path(ctx, p: Path) -> str:
    gdir = _group_files(ctx)
    if gdir and _inside(p, gdir.resolve()):
        return "/project/" + str(p.relative_to(gdir.resolve()))
    return "/work/" + str(p.relative_to(_work_root(ctx)))


_CTYPE_EXT = {"application/pdf": ".pdf", "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp",
              "image/gif": ".gif", "image/tiff": ".tiff",
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
              "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
              "application/msword": ".doc", "application/vnd.ms-excel": ".xls", "application/vnd.ms-powerpoint": ".ppt"}


async def download(ctx, url: str) -> Path:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError(f"Only http(s) URLs can be downloaded: {url!r}")
    if _blocked_host(parsed.hostname):
        raise ValueError(f"Refusing to download {url!r}: local addresses are off limits.")
    async with httpx.AsyncClient(timeout=60, follow_redirects=True, headers={"User-Agent": UA},
                                 event_hooks=GUARD_HOOKS) as c:
        async with c.stream("GET", url) as r:
            r.raise_for_status()
            data = bytearray()
            async for chunk in r.aiter_bytes():
                data += chunk
                if len(data) > DOWNLOAD_LIMIT:
                    raise ValueError(f"{url} is larger than {DOWNLOAD_LIMIT // 1024 // 1024} MB.")
            ctype = r.headers.get("content-type", "").split(";")[0].strip().lower()
            final = str(r.url)
    name = Path(unquote(urlparse(final).path)).name or "download"
    name = re.sub(r"[^\w.\- ]+", "_", name).strip() or "download"
    if not Path(name).suffix and ctype in _CTYPE_EXT:
        name += _CTYPE_EXT[ctype]
    # Studio projects are git-versioned design folders; keep downloads out of them
    d = (CACHE / "downloads" / hashlib.sha1(final.encode()).hexdigest()[:12]) if ctx.project_id \
        else _work_root(ctx) / "downloads"
    d.mkdir(parents=True, exist_ok=True)
    dest = d / name
    dest.write_bytes(bytes(data))
    return dest


async def locate(ctx, raw: str) -> tuple[Path, str]:
    """(file, how to refer to it) for a path or URL."""
    raw = str(raw or "").strip()
    if re.match(r"^https?://", raw, re.I):
        p = await download(ctx, raw)
        shown = display_path(ctx, p) if _inside(p, _work_root(ctx)) else raw
        return p, shown
    p = resolve(ctx, raw)
    return p, display_path(ctx, p)


# ── conversions ─────────────────────────────────────────────────────────────

_soffice_lock = asyncio.Lock()


def _cache_key(p: Path, *extra) -> str:
    st = p.stat()
    return hashlib.sha1(f"{p}|{st.st_size}|{st.st_mtime_ns}|{extra}".encode()).hexdigest()[:20]


async def soffice_convert(p: Path, fmt: str) -> Path:
    """Convert with headless LibreOffice (cached; one conversion at a time — soffice hates concurrency)."""
    exe = shutil.which("soffice") or shutil.which("libreoffice")
    if not exe:
        raise RuntimeError("LibreOffice is not installed, so this format can't be converted.")
    out = CACHE / f"{_cache_key(p, fmt)}.{fmt}"
    if out.exists():
        return out
    async with _soffice_lock:
        with tempfile.TemporaryDirectory(prefix="shellb-lo-") as tmp:
            profile = Path(tmp) / "profile"
            proc = await asyncio.create_subprocess_exec(
                exe, f"-env:UserInstallation=file://{profile}", "--headless", "--norestore",
                "--convert-to", fmt, "--outdir", tmp, str(p),
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            try:
                _, err = await asyncio.wait_for(proc.communicate(), timeout=180)
            except asyncio.TimeoutError:
                proc.kill()
                raise RuntimeError("LibreOffice took longer than 3 minutes to convert the file.")
            made = Path(tmp) / f"{p.stem}.{fmt}"
            if not made.exists():
                raise RuntimeError(f"LibreOffice couldn't convert {p.name}: {err.decode(errors='replace')[-300:]}")
            shutil.move(str(made), out)
    return out


async def as_pdf(p: Path) -> pymupdf.Document:
    """Anything page-shaped, opened as a PyMuPDF document."""
    ext = p.suffix.lower()
    if ext in PDF_LIKE:
        return pymupdf.open(str(p))
    if ext in IMAGE_EXT:
        return _image_doc(p)
    if ext in OFFICE_ALL or ext in {".html", ".htm", ".txt", ".md", ".csv"}:
        return pymupdf.open(str(await soffice_convert(p, "pdf")))
    raise ValueError(f"Can't render {p.suffix or 'extension-less'} files as pages.")


def _image_doc(p: Path) -> pymupdf.Document:
    """An image (any frame count) as a one-page-per-frame document."""
    doc = pymupdf.open()
    with Image.open(p) as im:
        n = getattr(im, "n_frames", 1)
        for i in range(min(n, 200)):
            im.seek(i)
            frame = ImageOps.exif_transpose(im.convert("RGB"))
            buf = io.BytesIO()
            frame.save(buf, "PNG")
            page = doc.new_page(width=frame.width, height=frame.height)
            page.insert_image(page.rect, stream=buf.getvalue())
    return doc


def parse_pages(spec, total: int) -> list[int]:
    """'3', '1-4', '2,5,7-9', 'last', '-2' (last two) → zero-based indexes."""
    spec = str(spec or "").strip().lower().replace(" ", "")
    if not spec or spec == "all":
        return list(range(total))
    out: list[int] = []
    for part in spec.split(","):
        if not part:
            continue
        if part == "last":
            out.append(total - 1)
        elif re.fullmatch(r"-\d+", part):
            out += list(range(max(0, total - int(part[1:])), total))
        elif m := re.fullmatch(r"(\d+)-(\d*|last)", part):
            hi = total if m.group(2) in ("", "last") else int(m.group(2))
            out += list(range(int(m.group(1)) - 1, min(hi, total)))
        elif part.isdigit():
            out.append(int(part) - 1)
        else:
            raise ValueError(f"Can't read the page range {spec!r}; use e.g. '1-3,7' or 'last'.")
    seen = set()
    return [i for i in out if 0 <= i < total and not (i in seen or seen.add(i))]


def render_page(page: pymupdf.Page, max_px=1600, min_dpi=72, max_dpi=300) -> bytes:
    long_side_in = max(page.rect.width, page.rect.height) / 72
    dpi = max(min_dpi, min(max_dpi, int(max_px / max(long_side_in, 0.1))))
    return page.get_pixmap(dpi=dpi, alpha=False).tobytes("png")


# ── OCR ─────────────────────────────────────────────────────────────────────

_engines: dict[str, object] = {}
_ocr_lock = asyncio.Lock()
_ocr_cache: dict[str, dict] = {}


def _engine(lang: str):
    if lang not in _engines:
        from rapidocr import LangRec, RapidOCR
        _engines[lang] = RapidOCR(params={"Rec.lang_type": LangRec(lang), "Global.log_level": "warning"})
    return _engines[lang]


def _lines(boxes, txts, scores) -> list[dict]:
    """Group detected text boxes into reading-order lines (keeps table columns apart with wide gaps)."""
    items = []
    for b, t, s in zip(boxes, txts, scores):
        xs, ys = [pt[0] for pt in b], [pt[1] for pt in b]
        items.append({"x0": min(xs), "x1": max(xs), "y0": min(ys), "y1": max(ys), "text": t, "conf": float(s)})
    items.sort(key=lambda i: (i["y0"] + i["y1"]) / 2)
    rows: list[list[dict]] = []
    for it in items:
        cy, h = (it["y0"] + it["y1"]) / 2, it["y1"] - it["y0"]
        if rows:
            last = rows[-1]
            ly = sum((r["y0"] + r["y1"]) / 2 for r in last) / len(last)
            lh = sum(r["y1"] - r["y0"] for r in last) / len(last)
            if abs(cy - ly) < 0.5 * min(h, lh):
                last.append(it)
                continue
        rows.append([it])
    out = []
    for row in rows:
        row.sort(key=lambda r: r["x0"])
        h = sum(r["y1"] - r["y0"] for r in row) / len(row)
        text = row[0]["text"]
        for prev, cur in zip(row, row[1:]):
            text += ("   " if cur["x0"] - prev["x1"] > 1.5 * h else " ") + cur["text"]
        out.append({"text": text, "conf": min(r["conf"] for r in row),
                    "box": [round(min(r["x0"] for r in row)), round(min(r["y0"] for r in row)),
                            round(max(r["x1"] for r in row)), round(max(r["y1"] for r in row))]})
    return out


async def ocr_png(png: bytes, lang="en") -> dict:
    key = hashlib.sha1(png).hexdigest() + lang
    if key in _ocr_cache:
        return _ocr_cache[key]

    def run():
        res = _engine(lang)(png)
        if res.boxes is None or not len(res.boxes):
            return {"lines": [], "conf": 0.0}
        lines = _lines(res.boxes.tolist(), list(res.txts), list(res.scores))
        return {"lines": lines, "conf": sum(l["conf"] for l in lines) / len(lines)}

    async with _ocr_lock:  # one page at a time: the ONNX session already uses every core
        out = await asyncio.to_thread(run)
    if len(_ocr_cache) > 500:
        _ocr_cache.pop(next(iter(_ocr_cache)))
    _ocr_cache[key] = out
    return out


def ocr_text(res: dict, low=0.6) -> str:
    return "\n".join(l["text"] + (" [?]" if l["conf"] < low else "") for l in res["lines"])


async def vision_transcribe(pngs: list[bytes], ctx, instruction: str = "") -> str:
    """Layout-aware transcription by the vision model (tables, forms, handwriting, stamps)."""
    from studio_tools import _vision_review
    import projects as P
    ask = ("Transcribe ALL text in this image exactly as written, in reading order, as Markdown. Keep headings, lists "
           "and tables (as Markdown tables). Keep numbers, part numbers, units and punctuation exactly. Mark unreadable "
           "parts as [illegible]. Do not summarize, translate, correct, or add commentary."
           + (f"\nAlso: {instruction}" if instruction else ""))
    parts = []
    for i, png in enumerate(pngs):  # one image per call keeps the model's attention on a single page
        parts.append(await _vision_review([P.b64(P.downscale(png, 1600))], ask, ctx))
    return "\n\n".join(parts)


# ── text extraction ─────────────────────────────────────────────────────────

def _garbled(text: str) -> bool:
    """Text layers from broken font maps come out as replacement chars or private-use glyphs."""
    if not text:
        return False
    bad = sum(1 for ch in text if ch == "�" or "" <= ch <= "")
    return bad / len(text) > 0.15


def _needs_ocr(page: pymupdf.Page, text: str) -> bool:
    if _garbled(text):
        return True
    if len(text.strip()) >= 40:
        return False
    return bool(page.get_images()) or len(page.get_drawings()) > 50  # scanned, or text drawn as vector outlines


async def pdf_text(doc: pymupdf.Document, pages: list[int], lang: str, ocr_mode: str, tables: bool,
                   ocr_cap=AUTO_OCR_PAGES) -> tuple[str, dict]:
    out, ocred, skipped = [], [], []
    for i in pages:
        page = doc[i]
        text = page.get_text("text", sort=True).strip()
        method = ""
        want_ocr = ocr_mode == "always" or (ocr_mode == "auto" and _needs_ocr(page, text))
        if want_ocr:
            if len(ocred) < ocr_cap or ocr_mode == "always":
                res = await ocr_png(render_page(page, max_px=2200), lang)
                o = ocr_text(res)
                if len(o) > len(text) * 0.8 or _garbled(text):
                    text, method = o, f" (OCR, confidence {res['conf']:.2f})"
                ocred.append(i + 1)
            else:
                skipped.append(i + 1)
        if tables and not method:
            try:
                for n, t in enumerate(page.find_tables().tables, 1):
                    md = t.to_markdown().strip()
                    if md:
                        text += f"\n\n[table {n}]\n{md}"
            except Exception:
                pass
        out.append(f"## Page {i + 1}{method}\n{text or '(no text on this page — it may be a picture; use view_document)'}")
    return "\n\n".join(out), {"ocrPages": ocred, "ocrSkipped": skipped}


async def extract_any(p: Path, pages_spec="", lang="en", ocr_mode="auto", tables=False,
                      ocr_cap=AUTO_OCR_PAGES) -> tuple[str, str, dict]:
    """(header, body, info) for any supported file."""
    ext = p.suffix.lower()
    size = p.stat().st_size
    if ext in PDF_LIKE or ext in IMAGE_EXT:
        doc = pymupdf.open(str(p)) if ext in PDF_LIKE else _image_doc(p)
        try:
            if doc.needs_pass:
                return f"{p.name}: password-protected", "", {"error": "This PDF is encrypted with a password."}
            pages = parse_pages(pages_spec, doc.page_count)
            if ext in IMAGE_EXT and ocr_mode == "auto":
                ocr_mode = "always"
            body, info = await pdf_text(doc, pages, lang, ocr_mode, tables, ocr_cap)
            meta = {k: v for k, v in (doc.metadata or {}).items() if v and k in ("title", "author", "subject", "creationDate")}
            kind = "image" if ext in IMAGE_EXT else ext[1:].upper()
            header = (f"{p.name} — {kind}, {doc.page_count} page{'s' if doc.page_count != 1 else ''}, {size:,} bytes"
                      + (f", pages {_ranges([i + 1 for i in pages])} shown" if len(pages) < doc.page_count else "")
                      + "".join(f"\n{k}: {v}" for k, v in meta.items()))
            if ext in IMAGE_EXT:
                body = re.sub(r"^## Page 1", "## Text found in the image", body) if doc.page_count == 1 else body
            return header, body, {**info, "pages": doc.page_count}
        finally:
            doc.close()
    if ext in OFFICE_LEGACY:
        conv = await soffice_convert(p, OFFICE_LEGACY[ext])
        body = await asyncio.to_thread(groups.extract, conv)
        return f"{p.name} — {ext[1:].upper()} (converted with LibreOffice), {size:,} bytes", body, {}
    if ext in OFFICE_NATIVE:
        body = await asyncio.to_thread(groups.extract, p)
        return f"{p.name} — {ext[1:].upper()}, {size:,} bytes", body, {}
    if ext in (".html", ".htm"):
        import trafilatura
        raw = p.read_text(errors="replace")
        body = await asyncio.to_thread(trafilatura.extract, raw, output_format="markdown", include_tables=True,
                                       include_links=True)
        return f"{p.name} — HTML, {size:,} bytes", body or raw, {}
    body = await asyncio.to_thread(groups.extract, p)
    if not body:
        return (f"{p.name} — {ext or 'no extension'}, {size:,} bytes", "",
                {"error": "No readable text: this looks like a binary format. Try run_code to inspect it."})
    return f"{p.name} — text, {size:,} bytes", body, {}


def _ranges(nums: list[int]) -> str:
    out, start, prev = [], None, None
    for n in nums:
        if start is None:
            start = prev = n
        elif n == prev + 1:
            prev = n
        else:
            out.append(f"{start}-{prev}" if prev != start else str(start))
            start = prev = n
    if start is not None:
        out.append(f"{start}-{prev}" if prev != start else str(start))
    return ",".join(out)


def quick_text(p: Path, limit=60_000) -> tuple[str, int, bool]:
    """Fast text layer for an upload (no OCR, no LibreOffice): (text, pages, looks_scanned)."""
    ext = p.suffix.lower()
    if ext in PDF_LIKE:
        with pymupdf.open(str(p)) as doc:
            if doc.needs_pass:
                return "", doc.page_count, False
            parts, empty, n = [], 0, 0
            for i, page in enumerate(doc):
                t = page.get_text("text", sort=True).strip()
                if _needs_ocr(page, t):
                    empty += 1
                parts.append(f"[page {i + 1}]\n{t}")
                n += len(parts[-1])
                if n > limit * 1.2:
                    break
            return "\n\n".join(parts), doc.page_count, empty > doc.page_count / 2
    if ext in OFFICE_NATIVE:
        return groups.extract(p), 0, False
    return "", 0, False


# ── tools ───────────────────────────────────────────────────────────────────

async def read_document(args, ctx):
    try:
        p, shown = await locate(ctx, args.get("path") or args.get("url") or "")
        lang = OCR_LANGS.get(str(args.get("ocr_language") or "en").lower(), "en")
        ocr_mode = {"true": "always", "false": "never"}.get(str(args.get("ocr", "auto")).lower(), "auto")
        header, body, info = await extract_any(p, args.get("pages") or "", lang, ocr_mode, bool(args.get("tables")))
    except (ValueError, FileNotFoundError, RuntimeError) as e:
        return ToolResult(str(e), error=True)
    if info.get("error"):
        return ToolResult(f"{header}\n\n{info['error']}", error=True)
    start = max(0, int(args.get("start") or 0))
    chunk = body[start:start + TEXT_LIMIT]
    more = len(body) - start - len(chunk)
    notes = []
    if info.get("ocrPages"):
        notes.append(f"Pages {_ranges(info['ocrPages'])} had no usable text layer and were read with OCR; lines ending "
                     "in [?] are low-confidence. For tables, forms or handwriting, use ocr with engine=vision.")
    if info.get("ocrSkipped"):
        notes.append(f"Pages {_ranges(info['ocrSkipped'])} also look scanned but weren't OCR'd yet: call read_document "
                     f"again with pages={info['ocrSkipped'][0]}-{info['ocrSkipped'][-1]}.")
    if more > 0:
        notes.append(f"{more:,} more characters: call read_document again with start={start + len(chunk)}.")
    notes.append(f"File: {shown}. To see figures, photos, charts or layout, use view_document.")
    return ToolResult(f"# {header}\n\n{chunk}\n\n---\n" + "\n".join(notes),
                      {"document": {"path": shown, "pages": info.get("pages"), "ocrPages": info.get("ocrPages", [])}})


async def view_document(args, ctx):
    from studio_tools import _deliver_images
    try:
        p, shown = await locate(ctx, args.get("path") or args.get("url") or "")
        doc = await as_pdf(p)
    except (ValueError, FileNotFoundError, RuntimeError) as e:
        return ToolResult(str(e), error=True)
    except Exception as e:
        return ToolResult(f"Couldn't open {args.get('path')}: {e}", error=True)
    try:
        if doc.needs_pass:
            return ToolResult("This PDF is password-protected.", error=True)
        try:
            pages = parse_pages(args.get("pages") or "1", doc.page_count)
        except ValueError as e:
            return ToolResult(str(e), error=True)
        if not pages:
            return ToolResult(f"No such page: the document has {doc.page_count} page(s).", error=True)
        extra = pages[VIEW_PAGES:]
        pages = pages[:VIEW_PAGES]
        pngs = [render_page(doc[i], max_px=1600) for i in pages]
        total = doc.page_count
    finally:
        doc.close()
    which = f"page{'s' if len(pages) > 1 else ''} {_ranges([i + 1 for i in pages])} of {total}"
    caption = f"Here {'are' if len(pages) > 1 else 'is'} {shown}, {which}." + (
        f" (Only {VIEW_PAGES} pages per call; ask for {_ranges([i + 1 for i in extra])} next.)" if extra else "")
    focus = str(args.get("question") or "").strip()
    text, imgs = await _deliver_images(
        ctx, pngs, caption,
        f"These are {which} of the document {p.name}. Describe each page precisely for someone who can't see it: "
        "layout, headings, all text (transcribe it), tables (as Markdown with every value), charts (axes, series, "
        "the numbers you can read), diagrams, photos, logos, signatures and stamps."
        + (f"\nThe person specifically wants to know: {focus}" if focus else ""))
    return ToolResult(text, {"document": {"path": shown, "pages": [i + 1 for i in pages], "total": total}}, model_images=imgs)


async def ocr(args, ctx):
    try:
        p, shown = await locate(ctx, args.get("path") or args.get("url") or "")
        doc = await as_pdf(p)
    except (ValueError, FileNotFoundError, RuntimeError) as e:
        return ToolResult(str(e), error=True)
    except Exception as e:
        return ToolResult(f"Couldn't open {args.get('path')}: {e}", error=True)
    engine = str(args.get("engine") or "fast").lower()
    lang = OCR_LANGS.get(str(args.get("language") or "en").lower(), "en")
    try:
        try:
            pages = parse_pages(args.get("pages") or ("1" if doc.page_count > 1 and engine == "vision" else ""), doc.page_count)
        except ValueError as e:
            return ToolResult(str(e), error=True)
        cap = 4 if engine == "vision" else AUTO_OCR_PAGES
        rest, pages = pages[cap:], pages[:cap]
        region = args.get("region")
        pngs = []
        for i in pages:
            png = render_page(doc[i], max_px=2200)
            if region:
                png = _crop(png, region)
            pngs.append(png)
        total = doc.page_count
    finally:
        doc.close()

    t0 = time.time()
    if engine == "vision":
        body = await vision_transcribe(pngs, ctx, str(args.get("instruction") or ""))
        head = f"Vision transcription of {shown}"
        if len(pages) > 1 or total > 1:
            head += f", pages {_ranges([i + 1 for i in pages])} of {total}"
        notes = ["The vision model may misread or normalize characters. Check critical values (part numbers, "
                 "amounts) against engine=fast."]
    else:
        sections, confs = [], []
        want_boxes = bool(args.get("boxes"))
        for i, png in zip(pages, pngs):
            res = await ocr_png(png, lang)
            confs.append(res["conf"])
            if want_boxes:
                rows = "\n".join(f"{l['box']}  {l['conf']:.2f}  {l['text']}" for l in res["lines"])
                sections.append(f"## Page {i + 1}  (box = [x0,y0,x1,y1] px at {_img_size(png)}, confidence, text)\n{rows}")
            else:
                sections.append((f"## Page {i + 1}  (confidence {res['conf']:.2f})\n" if total > 1 else "")
                                + (ocr_text(res) or "(no text found)"))
        body = "\n\n".join(sections)
        avg = sum(confs) / len(confs) if confs else 0
        head = f"OCR of {shown} ({lang}, {len(pages)} page{'s' if len(pages) != 1 else ''}, average confidence {avg:.2f}, {time.time() - t0:.1f}s)"
        notes = ["Lines ending in [?] are low-confidence."] if not want_boxes and "[?]" in body else []
        if avg and avg < 0.75:
            notes.append("Confidence is low: the scan may be blurry, rotated or handwritten. engine=vision often does better.")
    if rest:
        notes.append(f"Pages {_ranges([i + 1 for i in rest])} not processed yet: call ocr again with those pages.")
    if len(body) > TEXT_LIMIT:
        body = body[:TEXT_LIMIT] + "\n…[truncated: pass fewer pages]"
    return ToolResult(f"# {head}\n\n{body}" + ("\n\n---\n" + "\n".join(notes) if notes else ""),
                      {"ocr": {"path": shown, "engine": engine, "pages": [i + 1 for i in pages]}})


def _img_size(png: bytes) -> str:
    with Image.open(io.BytesIO(png)) as im:
        return f"{im.width}×{im.height}"


def _crop(png: bytes, region) -> bytes:
    """region: [x0, y0, x1, y1] as fractions 0-1 of the page (or pixels, if any value > 1)."""
    if isinstance(region, str):
        region = [float(v) for v in re.findall(r"[\d.]+", region)]
    if not isinstance(region, (list, tuple)) or len(region) != 4:
        return png
    with Image.open(io.BytesIO(png)) as im:
        x0, y0, x1, y1 = (float(v) for v in region)
        if max(x0, y0, x1, y1) <= 1:
            x0, x1, y0, y1 = x0 * im.width, x1 * im.width, y0 * im.height, y1 * im.height
        box = (max(0, int(x0)), max(0, int(y0)), min(im.width, int(x1)), min(im.height, int(y1)))
        if box[2] - box[0] < 8 or box[3] - box[1] < 8:
            return png
        crop = im.crop(box)
        if crop.width < 1200:  # small regions read better upscaled
            s = 1200 / crop.width
            crop = crop.resize((1200, int(crop.height * s)), Image.LANCZOS)
        buf = io.BytesIO()
        crop.save(buf, "PNG")
        return buf.getvalue()


FILE_DESC = ("A file path as the sandbox sees it (/work/<name> for uploads, /project/<name> for Project knowledge) "
             "or an http(s) URL to download.")


def register():
    TOOLS["read_document"] = {
        "fn": read_document, "service": None,
        "ui": {"displayName": "Read Document", "icon": "FileSearch", "category": "documents",
               "description": "Extracts text from PDFs, Word, Excel, PowerPoint, OpenDocument, e-books and pictures, "
                              "with automatic OCR for scanned pages."},
        "schema": _fn("read_document",
                      "Read the text of a document: PDF, DOCX/DOC, XLSX/XLS, PPTX/PPT, ODT/ODS/ODP, RTF, EPUB, HTML, "
                      "or an image. Scanned pages are OCR'd automatically. Use this first for any uploaded or linked "
                      "document; follow with view_document to see figures, charts or layout.",
                      {"path": {"type": "string", "description": FILE_DESC},
                       "pages": {"type": "string", "description": "Pages to read, e.g. '1-5', '2,7', 'last', '-3' (last three). Default: all"},
                       "start": {"type": "integer", "description": "Character offset to continue a long document"},
                       "tables": {"type": "boolean", "description": "Also extract PDF tables as Markdown (slower)"},
                       "ocr": {"type": "string", "enum": ["auto", "true", "false"],
                               "description": "auto (default): OCR pages with no text layer; true: OCR every page"},
                       "ocr_language": {"type": "string", "description": "en (default), latin (Spanish, French, German…), japanese, chinese, korean, cyrillic"}},
                      ["path"]),
    }
    TOOLS["view_document"] = {
        "fn": view_document, "service": None,
        "ui": {"displayName": "View Document", "icon": "ScanEye", "category": "documents",
               "description": "Looks at pages of a PDF, slide deck or document, or at a picture, with the vision model."},
        "schema": _fn("view_document",
                      "Look at document pages or a picture as images: PDF pages, slides, spreadsheets, scans, photos, "
                      "screenshots, diagrams. Use it for charts, figures, drawings, layout, logos, signatures, or "
                      f"anything text extraction misses. Up to {VIEW_PAGES} pages per call.",
                      {"path": {"type": "string", "description": FILE_DESC},
                       "pages": {"type": "string", "description": "Pages to view, e.g. '1', '3-4', 'last' (default: 1)"},
                       "question": {"type": "string", "description": "What you need to find out from the pages, if anything specific"}},
                      ["path"]),
    }
    TOOLS["ocr"] = {
        "fn": ocr, "service": None,
        "ui": {"displayName": "Identify Text (OCR)", "icon": "ScanText", "category": "documents",
               "description": "Finds and transcribes text in pictures and scans: RapidOCR for exact text, or the "
                              "vision model for tables, forms and handwriting."},
        "schema": _fn("ocr",
                      "Identify and transcribe text in an image, photo, screenshot or scanned PDF. engine=fast "
                      "(default) is precise OCR with confidence scores and optional bounding boxes; engine=vision "
                      "transcribes to Markdown and is better for tables, forms, handwriting, labels on products, "
                      "and messy photos. Use region to zoom into part of a page.",
                      {"path": {"type": "string", "description": FILE_DESC},
                       "pages": {"type": "string", "description": "For PDFs: pages to OCR, e.g. '1-3' (default: all for fast, 1 for vision)"},
                       "engine": {"type": "string", "enum": ["fast", "vision"]},
                       "language": {"type": "string", "description": "fast engine: en (default), latin, japanese, chinese, korean, cyrillic"},
                       "region": {"type": "array", "items": {"type": "number"},
                                  "description": "Crop before reading: [x0, y0, x1, y1] as page fractions 0-1, e.g. [0, 0.8, 1, 1] for the bottom fifth"},
                       "boxes": {"type": "boolean", "description": "fast engine: return each line's pixel box and confidence"},
                       "instruction": {"type": "string", "description": "vision engine: extra guidance, e.g. 'only the serial number label'"}},
                      ["path"]),
    }


DOC_TOOLS = ("read_document", "view_document", "ocr")
