"""Offline datasets: the big files Shell:B serves with no internet, plus their downloads and scheduled updates.

Two kinds come from the internet and can be kept current:
  protomaps   Worlds' Earth basemap. Protomaps publishes a planet build daily (build-metadata.protomaps.dev/builds.json,
              with sizes and md5s). Lives in ~/shellb/maps as <YYYYMMDD>.pmtiles; planet.pmtiles is a symlink to it.
  kiwix       ZIM archives for the Wiki app (Wikipedia, Wiktionary, Wikivoyage). Kiwix republishes each every month or
              few; the newest is found in the download.kiwix.org directory listing, with a .sha256 next to each file.
              Lives in ~/shellb/wiki as <name>_<YYYY-MM>.zim.
Two more are built here and only tracked (size and date): Worlds' planet and moon mosaics, and the map fonts/sprites.

Downloads run one at a time in a thread (sync httpx), resume from <file>.part with Range requests, check free disk
space first, verify the hash, then swap the new file in and delete the old one. An update keeps the old file serving
until the new one is verified, so it needs room for both for a while. A restart interrupts a download; startup resumes
it from the .part file.

Each updatable dataset has a schedule (off / weekly / monthly). The loop checks a dataset when its period has passed
since the last check and downloads a newer version if there is one. Finished updates and failures go to Activity.
State: data/datasets.json. Changing anything needs the owner (remote.require_admin), like pulling models.
"""
import asyncio
import base64
import hashlib
import json
import os
import re
import shutil
import threading
import time
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException, Request

import activity
import db

router = APIRouter(prefix="/api/datasets")

MAPS = Path.home() / "shellb" / "maps"
WIKI = Path.home() / "shellb" / "wiki"
STATE = db.DATA / "datasets.json"
PROTOMAPS_BUILDS = "https://build-metadata.protomaps.dev/builds.json"
PROTOMAPS_FILES = "https://build.protomaps.com/"
KIWIX = "https://download.kiwix.org/zim/"
UA = {"User-Agent": "ShellB-offline-data/1.0 (personal offline mirror)"}
PERIODS = {"weekly": 7 * 86400, "monthly": 30 * 86400}
DEFAULT_SCHEDULE = "monthly"
DISK_MARGIN = 10 * 2**30   # leave this much free after a download

# Everything the Offline data page lists. `catalog` entries can be installed and updated; `local` ones are only measured.
CATALOG: dict[str, dict] = {
    # ── Earth & Solar System ────────────────────────────────────────────────
    "planet": {"kind": "protomaps", "app": "worlds", "category": "Earth & Worlds", "name": "Earth basemap",
               "desc": "OpenStreetMap vector tiles for the whole planet, street level (Protomaps daily build).",
               "dir": MAPS, "approx": 139e9},

    # ── General Reference ───────────────────────────────────────────────────
    "wikipedia_en_all_nopic": {"kind": "kiwix", "app": "wiki", "category": "General Reference", "project": "wikipedia", "name": "Wikipedia",
                               "desc": "Every English article, text only. The usual choice.", "dir": WIKI, "approx": 49e9},
    "wikipedia_en_all_maxi": {"kind": "kiwix", "app": "wiki", "category": "General Reference", "project": "wikipedia", "name": "Wikipedia with images",
                              "desc": "Every English article with its images. Install this or the text-only one, not both.",
                              "dir": WIKI, "approx": 127e9},
    "wikipedia_en_all_mini": {"kind": "kiwix", "app": "wiki", "category": "General Reference", "project": "wikipedia", "name": "Wikipedia (intros)",
                              "desc": "The lead section of every English article. For when disk is tight.", "dir": WIKI, "approx": 14e9},
    "wiktionary_en_all_nopic": {"kind": "kiwix", "app": "wiki", "category": "General Reference", "project": "wiktionary", "name": "Wiktionary",
                                "desc": "English dictionary: definitions, etymology, translations.", "dir": WIKI, "approx": 9.2e9},
    "wikivoyage_en_all_nopic": {"kind": "kiwix", "app": "wiki", "category": "General Reference", "project": "wikivoyage", "name": "Wikivoyage",
                                "desc": "Travel guides for cities, regions and countries.", "dir": WIKI, "approx": 0.27e9},

    # ── Health & Medicine ───────────────────────────────────────────────────
    "wikipedia_en_medicine_maxi": {"kind": "kiwix", "app": "wiki", "category": "Health & Medicine", "project": "wikipedia", "name": "WikiMed (Medical Encyclopedia)",
                                   "desc": "Peer-reviewed clinical medicine, pharmacology, symptoms, diseases and first aid with diagrams.",
                                   "dir": WIKI, "approx": 2.2e9},
    "wikipedia_en_medicine_nopic": {"kind": "kiwix", "app": "wiki", "category": "Health & Medicine", "project": "wikipedia", "name": "WikiMed (text only)",
                                    "desc": "Peer-reviewed clinical medicine and health guide without images (smaller download).",
                                    "dir": WIKI, "approx": 0.86e9},

    # ── Developer Documentation (DevDocs) ──────────────────────────────────
    "devdocs_en_python": {"kind": "kiwix", "app": "wiki", "category": "Developer Docs", "project": "devdocs", "name": "DevDocs · Python 3",
                          "desc": "Python 3 standard library, syntax, built-ins, and typing reference.", "dir": WIKI, "approx": 4.4e6},
    "devdocs_en_typescript": {"kind": "kiwix", "app": "wiki", "category": "Developer Docs", "project": "devdocs", "name": "DevDocs · TypeScript",
                             "desc": "TypeScript language specification, utility types, and compiler options.", "dir": WIKI, "approx": 1.0e6},
    "devdocs_en_javascript": {"kind": "kiwix", "app": "wiki", "category": "Developer Docs", "project": "devdocs", "name": "DevDocs · JavaScript",
                             "desc": "Modern JavaScript (ECMAScript 6+), DOM, Fetch, and Web platform APIs.", "dir": WIKI, "approx": 2.6e6},
    "devdocs_en_react": {"kind": "kiwix", "app": "wiki", "category": "Developer Docs", "project": "devdocs", "name": "DevDocs · React",
                         "desc": "React 19 hooks, component APIs, server components, and runtime.", "dir": WIKI, "approx": 2.7e6},
    "devdocs_en_tailwindcss": {"kind": "kiwix", "app": "wiki", "category": "Developer Docs", "project": "devdocs", "name": "DevDocs · Tailwind CSS",
                              "desc": "Tailwind CSS utility classes, directives, and theme configuration.", "dir": WIKI, "approx": 0.6e6},
    "devdocs_en_rust": {"kind": "kiwix", "app": "wiki", "category": "Developer Docs", "project": "devdocs", "name": "DevDocs · Rust",
                        "desc": "Rust standard library (std), core types, macros, and Cargo reference.", "dir": WIKI, "approx": 6.2e6},
    "devdocs_en_cpp": {"kind": "kiwix", "app": "wiki", "category": "Developer Docs", "project": "devdocs", "name": "DevDocs · C++",
                       "desc": "C++ standard library (STL), algorithms, containers, and language features.", "dir": WIKI, "approx": 7.3e6},
    "devdocs_en_go": {"kind": "kiwix", "app": "wiki", "category": "Developer Docs", "project": "devdocs", "name": "DevDocs · Go",
                      "desc": "Go standard library packages, runtime, and language specification.", "dir": WIKI, "approx": 1.7e6},
    "devdocs_en_bash": {"kind": "kiwix", "app": "wiki", "category": "Developer Docs", "project": "devdocs", "name": "DevDocs · Bash",
                        "desc": "GNU Bash reference manual: builtins, expansions, and shell scripting.", "dir": WIKI, "approx": 0.6e6},
    "devdocs_en_git": {"kind": "kiwix", "app": "wiki", "category": "Developer Docs", "project": "devdocs", "name": "DevDocs · Git",
                       "desc": "Git version control documentation: commands, workflows, and configuration.", "dir": WIKI, "approx": 1.6e6},
    "devdocs_en_docker": {"kind": "kiwix", "app": "wiki", "category": "Developer Docs", "project": "devdocs", "name": "DevDocs · Docker",
                          "desc": "Docker CLI, Dockerfile instructions, Compose syntax, and engine reference.", "dir": WIKI, "approx": 1.8e6},
    "devdocs_en_sqlite": {"kind": "kiwix", "app": "wiki", "category": "Developer Docs", "project": "devdocs", "name": "DevDocs · SQLite",
                          "desc": "SQLite SQL syntax, functions, pragmas, and C/JSON APIs.", "dir": WIKI, "approx": 3.5e6},
    "devdocs_en_postgresql": {"kind": "kiwix", "app": "wiki", "category": "Developer Docs", "project": "devdocs", "name": "DevDocs · PostgreSQL",
                              "desc": "PostgreSQL SQL language, functions, data types, and server administration.", "dir": WIKI, "approx": 2.6e6},
    "devdocs_en_pytorch": {"kind": "kiwix", "app": "wiki", "category": "Developer Docs", "project": "devdocs", "name": "DevDocs · PyTorch",
                           "desc": "PyTorch tensor library, neural network modules, optimizers, and CUDA APIs.", "dir": WIKI, "approx": 6.4e6},
    "devdocs_en_numpy": {"kind": "kiwix", "app": "wiki", "category": "Developer Docs", "project": "devdocs", "name": "DevDocs · NumPy",
                         "desc": "NumPy multidimensional arrays, math routines, and linear algebra reference.", "dir": WIKI, "approx": 5.2e6},

    # ── Coding & Systems ────────────────────────────────────────────────────
    "stackoverflow.com_en_all": {"kind": "kiwix", "app": "wiki", "category": "Coding & Systems", "project": "stack_exchange", "name": "Stack Overflow",
                                "desc": "Complete programming Q&A archive: questions, accepted answers, code snippets and solutions.",
                                "dir": WIKI, "approx": 115e9},
    "serverfault.com_en_all": {"kind": "kiwix", "app": "wiki", "category": "Coding & Systems", "project": "stack_exchange", "name": "Server Fault",
                               "desc": "Systems engineering, server infrastructure, Linux networks, and devops Q&A.",
                               "dir": WIKI, "approx": 1.6e9},
    "security.stackexchange.com_en_all": {"kind": "kiwix", "app": "wiki", "category": "Coding & Systems", "project": "stack_exchange", "name": "Information Security",
                                          "desc": "Information security, cryptography, vulnerability management, and hardening Q&A.",
                                          "dir": WIKI, "approx": 0.44e9},
    "unix.stackexchange.com_en_all": {"kind": "kiwix", "app": "wiki", "category": "Coding & Systems", "project": "stack_exchange", "name": "Unix & Linux",
                                      "desc": "Linux/Unix systems administration, shell scripting, kernel, networking and CLI tools Q&A.",
                                      "dir": WIKI, "approx": 1.3e9},
    "askubuntu.com_en_all": {"kind": "kiwix", "app": "wiki", "category": "Coding & Systems", "project": "stack_exchange", "name": "Ask Ubuntu",
                             "desc": "Ubuntu Linux troubleshooting, package configuration, and system setup Q&A.",
                             "dir": WIKI, "approx": 2.8e9},
    "superuser.com_en_all": {"kind": "kiwix", "app": "wiki", "category": "Coding & Systems", "project": "stack_exchange", "name": "Super User",
                             "desc": "Computer enthusiast Q&A: hardware diagnostics, networking, operating systems and tools.",
                             "dir": WIKI, "approx": 4.0e9},
    "datascience.stackexchange.com_en_all": {"kind": "kiwix", "app": "wiki", "category": "Coding & Systems", "project": "stack_exchange", "name": "Data Science",
                                             "desc": "Machine learning models, feature engineering, neural networks, and statistics Q&A.",
                                             "dir": WIKI, "approx": 0.27e9},
    "archlinux_en_all_maxi": {"kind": "kiwix", "app": "wiki", "category": "Coding & Systems", "project": "other", "name": "Arch Linux Wiki",
                              "desc": "The definitive Linux reference: package setups, systemd, drivers, and system plumbing.",
                              "dir": WIKI, "approx": 0.04e9},
    "alpinelinux_en_all_maxi": {"kind": "kiwix", "app": "wiki", "category": "Coding & Systems", "project": "other", "name": "Alpine Linux Wiki",
                                "desc": "Alpine Linux documentation: apk package manager, musl libc, OpenRC, and containers.",
                                "dir": WIKI, "approx": 0.003e9},

    # ── Science & STEM ──────────────────────────────────────────────────────
    "math.stackexchange.com_en_all": {"kind": "kiwix", "app": "wiki", "category": "Science & STEM", "project": "stack_exchange", "name": "Mathematics Stack Exchange",
                                      "desc": "Mathematics at all levels: calculus, linear algebra, probability, and proofs Q&A.",
                                      "dir": WIKI, "approx": 7.4e9},
    "phet_en_all": {"kind": "kiwix", "app": "wiki", "category": "Science & STEM", "project": "phet", "name": "PhET Interactive Simulations",
                    "desc": "Interactive HTML5 simulations for physics, chemistry, circuits, and math.",
                    "dir": WIKI, "approx": 0.11e9},

    # ── Resilience & Self-Reliance ──────────────────────────────────────────
    "appropedia_en_all_maxi": {"kind": "kiwix", "app": "wiki", "category": "Resilience & Survival", "project": "other", "name": "Appropedia",
                               "desc": "Appropriate technology, clean water, renewable energy, and low-cost engineering.",
                               "dir": WIKI, "approx": 0.58e9},
    "zimgit-post-disaster_en": {"kind": "kiwix", "app": "wiki", "category": "Resilience & Survival", "project": "other", "name": "Post-Disaster Emergency Guide",
                                "desc": "Field medicine, sanitation, shelter, crisis management, and emergency response.",
                                "dir": WIKI, "approx": 0.65e9},

    # ── Books & Primary Sources ─────────────────────────────────────────────
    "wikibooks_en_all_maxi": {"kind": "kiwix", "app": "wiki", "category": "Books & Learning", "project": "wikibooks", "name": "Wikibooks with images",
                             "desc": "Open textbooks, tutorials and learning manuals: computing, math, science and languages.",
                             "dir": WIKI, "approx": 6.2e9},
    "wikibooks_en_all_nopic": {"kind": "kiwix", "app": "wiki", "category": "Books & Learning", "project": "wikibooks", "name": "Wikibooks (text only)",
                              "desc": "Open textbooks, tutorials and learning manuals without illustrations.",
                              "dir": WIKI, "approx": 3.5e9},
    "wikisource_en_all_maxi": {"kind": "kiwix", "app": "wiki", "category": "Books & Learning", "project": "wikisource", "name": "Wikisource with images",
                              "desc": "Primary historical sources, legal texts, constitutions, classical philosophy and historical scans.",
                              "dir": WIKI, "approx": 8.6e9},
    "wikisource_en_all_nopic": {"kind": "kiwix", "app": "wiki", "category": "Books & Learning", "project": "wikisource", "name": "Wikisource (text only)",
                               "desc": "Primary historical sources, legal charters, treaties, and classical literature without scans.",
                               "dir": WIKI, "approx": 3.9e9},
    "wikiquote_en_all_nopic": {"kind": "kiwix", "app": "wiki", "category": "Books & Learning", "project": "wikiquote", "name": "Wikiquote",
                              "desc": "Quotations, proverbs, citations and attributions across human culture, thinkers and literature.",
                              "dir": WIKI, "approx": 0.33e9},
    "gutenberg_en_all": {"kind": "kiwix", "app": "wiki", "category": "Books & Learning", "project": "gutenberg", "name": "Project Gutenberg (Complete)",
                         "desc": "Over 70,000 public domain books: classical literature, philosophy, science, history and poetry.",
                         "dir": WIKI, "approx": 221e9},

    # ── Law & Policy (primary-law corpora live in ~/shellb/legal, fetched by legal/fetch_legal.py) ──
    "law.stackexchange.com_en_all": {"kind": "kiwix", "app": "wiki", "category": "Law & Policy", "project": "stack_exchange", "name": "Law Stack Exchange",
                                     "desc": "Q&A on US, UK and international law: contracts, IP, employment, criminal and civil procedure. Reference, not legal advice.",
                                     "dir": WIKI, "approx": 0.19e9},
    "patents.stackexchange.com_en_all": {"kind": "kiwix", "app": "wiki", "category": "Law & Policy", "project": "stack_exchange", "name": "Patents Stack Exchange",
                                         "desc": "Patent law and practice: filing, prior art, infringement, freedom to operate.",
                                         "dir": WIKI, "approx": 0.04e9},
    "politics.stackexchange.com_en_all": {"kind": "kiwix", "app": "wiki", "category": "Law & Policy", "project": "stack_exchange", "name": "Politics Stack Exchange",
                                          "desc": "Government, elections, trade policy and public law, with sources.",
                                          "dir": WIKI, "approx": 0.21e9},
    "money.stackexchange.com_en_all": {"kind": "kiwix", "app": "wiki", "category": "Law & Policy", "project": "stack_exchange", "name": "Personal Finance & Money",
                                       "desc": "Tax, banking and contract questions with practical answers.",
                                       "dir": WIKI, "approx": 0.25e9},
    "workplace.stackexchange.com_en_all": {"kind": "kiwix", "app": "wiki", "category": "Law & Policy", "project": "stack_exchange", "name": "The Workplace",
                                           "desc": "Employment practice, HR and workplace-rights questions.",
                                           "dir": WIKI, "approx": 0.25e9},
    "consumerrights.wiki_en_all_maxi": {"kind": "kiwix", "app": "wiki", "category": "Law & Policy", "project": "other", "name": "Consumer Rights Wiki",
                                        "desc": "Consumer-rights issues and corporate practices: warranties, right to repair, licensing, privacy.",
                                        "dir": WIKI, "approx": 0.02e9},

    # ── Hardware & Repair ───────────────────────────────────────────────────
    "ifixit_en_all": {"kind": "kiwix", "app": "wiki", "category": "Hardware & Repair", "project": "ifixit", "name": "iFixit",
                      "desc": "Step-by-step repair manuals, teardowns, and hardware troubleshooting for electronics, tools and devices.",
                      "dir": WIKI, "approx": 3.6e9},
}
LOCAL = {
    "bodies": {"app": "worlds", "category": "Earth & Worlds", "name": "Planet and moon mosaics", "desc": "Raster maps of 18 other worlds, built here by maps/planets/build.py.",
               "path": MAPS / "bodies"},
    "map-assets": {"app": "worlds", "category": "Earth & Worlds", "name": "Map fonts and icons", "desc": "Protomaps basemap glyphs and sprites.",
                   "path": MAPS / "assets"},
}

_lock = threading.RLock()
_job: dict | None = None          # the download running now (also mirrored into state["job"] so a restart can resume it)
_cancel = threading.Event()
_thread: threading.Thread | None = None
_task: asyncio.Task | None = None
_listeners: list = []             # called with (dataset_id) after an install or removal; wiki.py reopens its archives


# ── state ───────────────────────────────────────────────────────────────────

def _load() -> dict:
    try:
        st = json.loads(STATE.read_text())
    except (OSError, ValueError):
        st = {}
    st.setdefault("datasets", {})
    st.setdefault("queue", [])
    return st


def _save(st: dict):
    tmp = STATE.with_suffix(".tmp")
    tmp.write_text(json.dumps(st, indent=1))
    os.replace(tmp, STATE)


def _update(fn):
    with _lock:
        st = _load()
        out = fn(st)
        _save(st)
        return out


def _rec(st: dict, did: str) -> dict:
    return st["datasets"].setdefault(did, {"schedule": DEFAULT_SCHEDULE, "history": []})


def _file_for(did: str, version: str) -> Path:
    spec = CATALOG[did]
    return spec["dir"] / (f"{version}.pmtiles" if spec["kind"] == "protomaps" else f"{did}_{version}.zim")


def _adopt():
    """Record files that are on disk but not in the state yet (the planet fetched by hand before this module existed)."""
    def go(st):
        for did, spec in CATALOG.items():
            r = st["datasets"].get(did)
            if r and r.get("version"):
                if not _file_for(did, r["version"]).is_file():  # deleted by hand
                    r.update(version=None, file=None, bytes=0)
                continue
            if spec["kind"] == "protomaps":
                link = MAPS / "planet.pmtiles"
                f = link.resolve() if link.exists() else None
                m = re.match(r"^(\d{8})\.pmtiles$", f.name) if f else None
            else:
                files = sorted(spec["dir"].glob(f"{did}_*.zim")) if spec["dir"].is_dir() else []
                f = files[-1] if files else None
                m = re.match(rf"^{re.escape(did)}_(\d{{4}}-\d{{2}}[a-z]?)\.zim$", f.name) if f else None
            if f and m:
                r = _rec(st, did)
                s = f.stat()
                r.update(version=m.group(1), file=str(f), bytes=s.st_size, downloadedAt=s.st_mtime, source="found on disk")
                r["history"].append({"event": "found", "version": m.group(1), "bytes": s.st_size, "at": time.time()})
    _update(go)


def installed(did: str) -> dict | None:
    """{version, file, bytes, downloadedAt} for an installed dataset, else None."""
    r = _load()["datasets"].get(did) or {}
    return r if r.get("version") and r.get("file") and Path(r["file"]).is_file() else None


def on_change(fn):
    _listeners.append(fn)


def _notify(did: str):
    for fn in _listeners:
        try:
            fn(did)
        except Exception as e:  # noqa: BLE001
            print(f"datasets listener failed: {type(e).__name__}: {e}")


# ── finding the newest version ──────────────────────────────────────────────

_LISTING = re.compile(r'href="(?P<name>[\w.-]+?)_(?P<ver>\d{4}-\d{2}[a-z]?)\.zim"')


def _latest(did: str) -> dict:
    """{version, url, bytes, hash: (algo, hex) | None} of the newest published build. Blocking (runs in a thread)."""
    spec = CATALOG[did]
    with httpx.Client(timeout=30, follow_redirects=True, headers=UA) as c:
        if spec["kind"] == "protomaps":
            builds = [b for b in c.get(PROTOMAPS_BUILDS).raise_for_status().json() if re.match(r"^\d{8}\.pmtiles$", b.get("key", ""))]
            b = max(builds, key=lambda b: b["key"])
            h = ("md5", base64.b64decode(b["md5sum"]).hex()) if b.get("md5sum") else None
            return {"version": b["key"][:8], "url": PROTOMAPS_FILES + b["key"], "bytes": int(b["size"]), "hash": h}
        base = f"{KIWIX}{spec['project']}/"
        vers = [m["ver"] for m in _LISTING.finditer(c.get(base).raise_for_status().text) if m["name"] == did]
        if not vers:
            raise RuntimeError(f"{did} is not in the Kiwix listing any more")
        ver = max(vers)
        url = f"{base}{did}_{ver}.zim"
        size = int(c.head(url).raise_for_status().headers.get("content-length", 0))
        try:
            h = ("sha256", c.get(url + ".sha256").raise_for_status().text.split()[0].lower())
        except (httpx.HTTPError, IndexError):
            h = None
        return {"version": ver, "url": url, "bytes": size, "hash": h}


async def check(did: str) -> dict:
    """Ask the publisher for the newest version and remember it. Returns the dataset's view."""
    if did not in CATALOG:
        raise HTTPException(404, "no such dataset")
    try:
        latest = await asyncio.to_thread(_latest, did)
        err = None
    except Exception as e:  # noqa: BLE001
        latest, err = None, f"{type(e).__name__}: {e}"[:300]

    def go(st):
        r = _rec(st, did)
        r["lastCheck"] = time.time()
        r["checkError"] = err
        if latest:
            r["latest"] = {**latest, "hash": list(latest["hash"]) if latest["hash"] else None}
    _update(go)
    return view(did)


# ── downloading ─────────────────────────────────────────────────────────────

def _hash_file(path: Path, algo: str, progress) -> str:
    h = hashlib.new(algo)
    done = 0
    with open(path, "rb") as f:
        while chunk := f.read(8 << 20):
            if _cancel.is_set():
                raise InterruptedError
            h.update(chunk)
            done += len(chunk)
            progress(done)
    return h.hexdigest()


def _run(job: dict):
    """The download thread: fetch → verify → install. Updates the shared job dict as it goes."""
    did, spec = job["id"], CATALOG[job["id"]]
    final = _file_for(did, job["version"])
    part = final.with_name(final.name + ".part")
    final.parent.mkdir(parents=True, exist_ok=True)
    try:
        if not final.is_file():
            have = part.stat().st_size if part.exists() else 0
            need = job["bytes"] - have + DISK_MARGIN
            free = shutil.disk_usage(final.parent).free
            if free < need:
                raise RuntimeError(f"not enough disk: {_gb(free)} free, need {_gb(need)} (incl. {_gb(DISK_MARGIN)} spare)")
            tries = 0
            while have < job["bytes"]:
                if _cancel.is_set():
                    raise InterruptedError
                try:
                    with httpx.Client(timeout=httpx.Timeout(60, connect=30), follow_redirects=True, headers=UA) as c, \
                            c.stream("GET", job["url"], headers={"Range": f"bytes={have}-"} if have else {}) as r:
                        if r.status_code == 200 and have:  # the server ignored Range: start over
                            have = 0
                            part.unlink(missing_ok=True)
                        elif r.status_code not in (200, 206):
                            raise RuntimeError(f"HTTP {r.status_code}")
                        with open(part, "ab") as f:
                            t0, b0 = time.time(), have
                            for chunk in r.iter_bytes(4 << 20):
                                if _cancel.is_set():
                                    raise InterruptedError
                                f.write(chunk)
                                have += len(chunk)
                                now = time.time()
                                if now - t0 >= 2:
                                    job["rate"] = (have - b0) / (now - t0)
                                    t0, b0 = now, have
                                job["done"] = have
                    tries = 0
                except (httpx.HTTPError, RuntimeError) as e:
                    tries += 1
                    if tries > 20:
                        raise RuntimeError(f"download kept failing: {e}") from e
                    job["note"] = f"retrying after {type(e).__name__}"
                    time.sleep(min(60, 5 * tries))
            if have > job["bytes"]:
                raise RuntimeError(f"got {have} bytes, expected {job['bytes']}; delete {part.name} and try again")
            if job.get("hash"):
                algo, want = job["hash"]
                job.update(phase="verify", done=0, rate=None, note=None)
                got = _hash_file(part, algo, lambda n: job.__setitem__("done", n))
                if got != want:
                    part.unlink(missing_ok=True)
                    raise RuntimeError(f"{algo} mismatch (got {got[:12]}…, want {want[:12]}…); the partial file was deleted")
            os.replace(part, final)
        job.update(phase="install", note=None)
        _install(did, job, final)
        job["phase"] = "done"
    except InterruptedError:
        job["phase"] = "cancelled"
    except Exception as e:  # noqa: BLE001
        job.update(phase="failed", error=f"{type(e).__name__}: {e}"[:400])


def _install(did: str, job: dict, final: Path):
    spec = CATALOG[did]
    old = installed(did)
    if spec["kind"] == "protomaps":  # swap the symlink atomically; MapLibre clients pick up the new build on reload
        tmp = MAPS / "planet.pmtiles.new"
        tmp.unlink(missing_ok=True)
        tmp.symlink_to(final.name)
        os.replace(tmp, MAPS / "planet.pmtiles")
    size = final.stat().st_size

    def go(st):
        r = _rec(st, did)
        r.update(version=job["version"], file=str(final), bytes=size, downloadedAt=time.time(), source=job["url"],
                 verified=bool(job.get("hash")))
        r["history"].append({"event": "updated" if old else "installed", "version": job["version"], "bytes": size,
                             "at": time.time(), "from": old["version"] if old else None})
        r["history"] = r["history"][-50:]
    _update(go)
    _notify(did)
    if old and Path(old["file"]) != final:  # open readers keep their file handle; the space comes back when they close
        Path(old["file"]).unlink(missing_ok=True)


def _gb(n: float) -> str:
    if n < 1e9:
        return f"{n / 1e6:.0f} MB"
    return f"{n / 1e9:.1f} GB"


def _start_next():
    """Start the first queued download if nothing is running. Called from the event loop."""
    global _job, _thread
    with _lock:
        if _thread and _thread.is_alive():
            return
        st = _load()
        if not st["queue"]:
            if st.get("job"):
                st["job"] = None
                _save(st)
            return
        nxt = st["queue"][0]
        _cancel.clear()
        _job = {**nxt, "phase": "download", "done": 0, "rate": None, "started": time.time(), "error": None, "note": None}
        part = _file_for(nxt["id"], nxt["version"])
        part = part.with_name(part.name + ".part")
        if part.exists():
            _job["done"] = part.stat().st_size
        st["job"] = nxt
        _save(st)
        _thread = threading.Thread(target=_run, args=(_job,), name=f"dataset-{nxt['id']}", daemon=True)
        _thread.start()


def _finish():
    """After the thread ends: record the outcome, tell Activity, drop it from the queue, start the next one."""
    global _job
    with _lock:
        job = _job
        if not job or (_thread and _thread.is_alive()):
            return
        _job = None
    name = CATALOG[job["id"]]["name"]
    link = "#/data"
    if job["phase"] == "done":
        activity.post("data", "done", f"{name} {'updated' if job.get('update') else 'installed'}: {job['version']}",
                      f"{_gb(job['bytes'])} in {(time.time() - job['started']) / 60:.0f} min.", link, ref=f"data:{job['id']}:{job['version']}")
    elif job["phase"] == "failed":
        activity.post("data", "failed", f"{name} download failed", job.get("error") or "", link)

    def go(st):
        st["queue"] = [q for q in st["queue"] if q["id"] != job["id"]]
        st["job"] = None
        r = _rec(st, job["id"])
        r["lastError"] = job.get("error") if job["phase"] == "failed" else None
        if job["phase"] == "cancelled":  # a cancel throws the partial file away; a restart keeps it to resume
            p = _file_for(job["id"], job["version"])
            p.with_name(p.name + ".part").unlink(missing_ok=True)
    _update(go)
    _start_next()


def enqueue(did: str, latest: dict, update: bool):
    def go(st):
        if any(q["id"] == did for q in st["queue"]):
            return
        st["queue"].append({"id": did, "version": latest["version"], "url": latest["url"], "bytes": latest["bytes"],
                            "hash": latest.get("hash"), "update": update})
    _update(go)
    _start_next()


# ── the schedule ────────────────────────────────────────────────────────────

async def _tick():
    _finish()
    st = _load()
    for did in CATALOG:
        r = st["datasets"].get(did) or {}
        period = PERIODS.get(r.get("schedule", DEFAULT_SCHEDULE))
        inst = installed(did)
        # never checked: count from the download, so a fresh install isn't replaced the moment it lands
        if not period or not inst or time.time() - (r.get("lastCheck") or inst.get("downloadedAt") or 0) < period:
            continue
        v = await check(did)
        if v.get("updateAvailable") and not any(q["id"] == did for q in _load()["queue"]):
            enqueue(did, v["latest"], update=True)


async def _loop():
    await asyncio.sleep(20)
    _start_next()  # resume what a restart interrupted
    last = 0.0
    while True:
        try:
            _finish()  # notices the download thread's end within a few seconds
            if time.time() - last >= 1800:  # schedules are checked twice an hour
                last = time.time()
                await _tick()
        except Exception as e:  # noqa: BLE001
            print(f"datasets tick failed: {type(e).__name__}: {e}")
        await asyncio.sleep(5)


def init():
    WIKI.mkdir(parents=True, exist_ok=True)
    _adopt()


def start():
    global _task
    if _task is None:
        _task = asyncio.create_task(_loop())


def stop():
    global _task
    if _task and not _task.done():
        _task.cancel()
        _task = None


def running_now() -> dict | None:
    j = _job
    return {"id": j["id"], "phase": j["phase"], "done": j["done"], "bytes": j["bytes"]} if j and j["phase"] in ("download", "verify", "install") else None


def downloads() -> list[dict]:
    """Every large download in flight or waiting, for the top-bar indicator: dataset jobs and queue, plus Ollama pulls."""
    out = []
    j = _job
    if j and j["phase"] in ("download", "verify", "install"):
        out.append({"id": f"data:{j['id']}", "kind": "data", "name": CATALOG[j["id"]]["name"], "detail": j["version"],
                     "phase": j["phase"], "done": j["done"], "total": j["bytes"], "rate": j.get("rate"), "note": j.get("note"),
                     "started": j["started"], "link": "#/data"})
    for q in _load()["queue"]:
        if not (j and q["id"] == j["id"]):
            out.append({"id": f"data:{q['id']}", "kind": "data", "name": CATALOG[q["id"]]["name"], "detail": q["version"],
                         "phase": "queued", "done": 0, "total": q["bytes"], "rate": None, "link": "#/data"})
    try:
        import modelhub
        for p in list(modelhub._pulls.values()):
            if p.get("state") == "running":
                out.append({"id": f"model:{p['name']}", "kind": "model", "name": p["name"], "detail": p.get("status") or "",
                            "phase": "download", "done": p.get("completed") or 0, "total": p.get("total") or 0, "rate": None,
                            "started": (p.get("started") or 0) / 1000, "link": "#/models"})
    except Exception:  # noqa: BLE001
        pass
    try:
        import modelstore
        out += modelstore.running()
    except Exception:  # noqa: BLE001
        pass
    return out


# ── views ───────────────────────────────────────────────────────────────────

def _du(p: Path) -> tuple[int, float]:
    total, newest = 0, 0.0
    for f in p.rglob("*") if p.is_dir() else []:
        if f.is_file():
            s = f.stat()
            total += s.st_size
            newest = max(newest, s.st_mtime)
    return total, newest


def view(did: str) -> dict:
    spec = CATALOG[did]
    st = _load()
    r = st["datasets"].get(did) or {}
    inst = installed(did)
    latest = r.get("latest")
    j = _job if _job and _job["id"] == did else None
    return {
        "id": did, "kind": spec["kind"], "app": spec["app"], "category": spec.get("category"),
        "name": spec["name"], "desc": spec["desc"], "approxBytes": spec["approx"],
        "updatable": True, "installed": bool(inst),
        "version": inst["version"] if inst else None, "bytes": inst["bytes"] if inst else 0,
        "downloadedAt": inst.get("downloadedAt") if inst else None, "verified": inst.get("verified") if inst else None,
        "schedule": r.get("schedule", DEFAULT_SCHEDULE), "lastCheck": r.get("lastCheck"), "checkError": r.get("checkError"),
        "lastError": r.get("lastError"),
        "latest": {k: latest[k] for k in ("version", "bytes")} if latest else None,
        "updateAvailable": bool(inst and latest and latest["version"] > inst["version"]),
        "queued": any(q["id"] == did for q in st["queue"]) and not j,
        "job": {k: j.get(k) for k in ("phase", "done", "bytes", "rate", "version", "note", "started")} if j else None,
        "history": list(reversed(r.get("history", [])))[:12],
    }


def overview() -> dict:
    items = [view(d) for d in CATALOG]
    for lid, spec in LOCAL.items():
        size, newest = _du(spec["path"])
        items.append({"id": lid, "kind": "local", "app": spec["app"], "category": spec.get("category", "Earth & Worlds"),
                      "name": spec["name"], "desc": spec["desc"],
                      "updatable": False, "installed": size > 0, "bytes": size, "downloadedAt": newest or None})
    du = shutil.disk_usage(MAPS if MAPS.exists() else Path.home())
    return {"datasets": items, "disk": {"free": du.free, "total": du.total},
            "used": sum(i["bytes"] for i in items), "periods": list(PERIODS)}


# ── HTTP ────────────────────────────────────────────────────────────────────

def _owner(req: Request):
    import remote
    remote.require_admin(req)


def _known(did: str):
    if did not in CATALOG:
        raise HTTPException(404, "no such dataset")


@router.get("/downloads")
def api_downloads():
    _finish()
    return {"items": downloads()}


@router.get("")
def api_list():
    _finish()
    return overview()


@router.post("/{did}/check")
async def api_check(did: str, req: Request):
    _owner(req)
    _known(did)
    return await check(did)


@router.post("/{did}/install")
async def api_install(did: str, req: Request):
    """Download the newest version (install, or update an installed one). Checks first if we haven't lately."""
    _owner(req)
    _known(did)
    v = view(did)
    if v["job"] or v["queued"]:
        return v
    if not v["latest"] or time.time() - (v["lastCheck"] or 0) > 3600:
        v = await check(did)
    if not v["latest"]:
        raise HTTPException(502, v.get("checkError") or "couldn't find a version to download")
    if v["installed"] and not v["updateAvailable"]:
        raise HTTPException(409, f"{v['name']} {v['version']} is already the newest")
    latest = _load()["datasets"][did]["latest"]
    enqueue(did, latest, update=v["installed"])
    return view(did)


@router.post("/{did}/schedule")
async def api_schedule(did: str, req: Request):
    _owner(req)
    _known(did)
    sched = str((await req.json()).get("schedule", ""))
    if sched not in ("off", *PERIODS):
        raise HTTPException(400, "schedule is off, weekly or monthly")
    _update(lambda st: _rec(st, did).__setitem__("schedule", sched))
    return view(did)


@router.post("/{did}/cancel")
def api_cancel(did: str, req: Request):
    _owner(req)
    _known(did)
    if _job and _job["id"] == did:
        _cancel.set()
        if _thread:
            _thread.join(timeout=10)
        _finish()
    else:
        _update(lambda st: st.__setitem__("queue", [q for q in st["queue"] if q["id"] != did]))
    return view(did)


@router.delete("/{did}")
def api_remove(did: str, req: Request):
    _owner(req)
    _known(did)
    if _job and _job["id"] == did:
        raise HTTPException(409, "cancel the download first")
    inst = installed(did)
    if not inst:
        raise HTTPException(404, "not installed")
    if CATALOG[did]["kind"] == "protomaps":
        (MAPS / "planet.pmtiles").unlink(missing_ok=True)

    def go(st):
        r = _rec(st, did)
        r["history"].append({"event": "removed", "version": inst["version"], "bytes": inst["bytes"], "at": time.time()})
        r.update(version=None, file=None, bytes=0, downloadedAt=None)
    _update(go)
    _notify(did)
    Path(inst["file"]).unlink(missing_ok=True)
    return view(did)
