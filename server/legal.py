"""Legal: offline US and EU law from the full-text index in ~/shellb/legal/index.db.

The corpus (US Code, eCFR incl. EAR/ITAR/OFAC/Customs, Statutes at Large, Public Laws, HTS, Consolidated Screening List,
EUR-Lex legislation incl. the Cyber Resilience Act; the Federal Register and CourtListener case law are downloaded but
not indexed until build_index.py grows their parsers) is fetched by ~/shellb/legal/fetch_legal.py
and indexed by ~/shellb/legal/build_index.py. Each indexed row is one citable unit (a section, article, recital, annex
chunk, tariff heading or list entry). This module only reads the index (opened read-only per call), so re-indexing while
the app runs is safe. Everything an agent gets names its source and snapshot: law changes, the files are a snapshot.
"""
import re
import sqlite3
from pathlib import Path

from fastapi import APIRouter, HTTPException

from tools import TOOLS, ToolResult, _fn

router = APIRouter(prefix="/api/legal")

DB = Path.home() / "shellb" / "legal" / "index.db"
READ_LIMIT = 9000       # agent tool results are cut at 16k chars (agent.py); stay well under it
OUTLINE_LIMIT = 250
NOTICE = "Offline snapshot: check the date, and confirm anything that matters against the official source. Reference only, not legal advice."


def _db() -> sqlite3.Connection:
    c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=30)
    c.row_factory = sqlite3.Row
    return c


def available() -> bool:
    try:
        with _db() as c:
            return c.execute("SELECT 1 FROM units LIMIT 1").fetchone() is not None
    except sqlite3.Error:
        return False


def sources() -> list[dict]:
    try:
        with _db() as c:
            counts = {r["source"]: r["n"] for r in c.execute("SELECT source, count(*) n FROM units GROUP BY source")}
            rows = c.execute("SELECT * FROM sources").fetchall()
    except sqlite3.Error:
        return []
    return [{"id": r["source"], "name": r["name"], "jurisdiction": r["jurisdiction"], "snapshot": r["snapshot"], "note": r["note"],
             "units": counts.get(r["source"], 0)} for r in rows if counts.get(r["source"])]


_CFR = re.compile(r"\b(\d{1,2})\s*C\.?\s*F\.?\s*R\.?\s*(?:parts?\s*|§+\s*|sec(?:tion)?\.?\s*)?(\d+(?:\.\d+[a-z]?)?)", re.I)
_USC = re.compile(r"\b(\d{1,2})\s*U\.?\s*S\.?\s*C\.?\s*(?:§+\s*|sec(?:tion)?\.?\s*)?(\d+[\w-]*)", re.I)
_HTS = re.compile(r"\b(?:HTS(?:US)?\s*)?(\d{4})(?:\.\d{2}){0,3}\b")


def _cite_guess(q: str) -> list[str]:
    """Citations the query names outright ('15 CFR 740.2', '9 USC 2', 'HTS 8471.30'), as index cite strings."""
    out = []
    if m := _CFR.search(q):
        out.append(f"{int(m[1])} CFR § {m[2]}")
    if m := _USC.search(q):
        out.append(f"{int(m[1])} U.S.C. § {m[2]}")
    if "hts" in q.lower() and (m := _HTS.search(q)):
        out.append(f"HTS {m[1]}")
    return out


def _fts_query(q: str, mode: str) -> str | None:
    """Turn free text into an FTS5 query: quoted phrases stay phrases; the rest are terms (AND, or OR as a fallback)."""
    phrases = re.findall(r'"([^"]+)"', q)
    rest = re.sub(r'"[^"]*"', " ", q)
    words = [w for w in re.findall(r"[\w.\-/§]+", rest) if len(w) > 1 or w.isdigit()]
    words = [w.strip(".-/") for w in words]
    stop = {"the", "of", "and", "or", "to", "in", "for", "a", "an", "is", "are", "on", "by", "with", "under", "what", "does", "do", "how"}
    terms = [f'"{p}"' for p in phrases] + [f'"{w}"' for w in words if w and w.lower() not in stop]
    if not terms:
        return None
    return (" OR " if mode == "or" else " ").join(terms)


def _scope(source: str | None, jurisdiction: str | None) -> tuple[str, list]:
    cond, args = "", []
    if source:
        cond += " AND u.source = ?"
        args.append(source.lower())
    if jurisdiction:
        cond += " AND u.source IN (SELECT source FROM sources WHERE upper(jurisdiction) = ?)"
        args.append(jurisdiction.upper())
    return cond, args


def search(q: str, source: str | None = None, jurisdiction: str | None = None, n: int = 10) -> list[dict]:
    cond, args = _scope(source, jurisdiction)
    seen, out = set(), []
    with _db() as c:
        for cite in _cite_guess(q):  # an explicit citation goes first
            for r in c.execute(f"SELECT u.id, u.source, u.cite, u.heading, u.date, substr(u.text,1,240) AS snip FROM units u "
                               f"WHERE u.cite = ? COLLATE NOCASE{cond} ORDER BY u.ord LIMIT 1", [cite, *args]):
                seen.add(r["id"])
                out.append({**dict(r), "snip": re.sub(r"\s+", " ", r["snip"])})
        for mode in ("and", "or"):
            fq = _fts_query(q, mode)
            if not fq or len(out) >= n:
                break
            try:
                rows = c.execute(
                    f"SELECT u.id, u.source, u.cite, u.heading, u.date, snippet(fts, 2, '[', ']', ' … ', 28) AS snip "
                    f"FROM fts JOIN units u ON u.id = fts.rowid WHERE fts MATCH ?{cond} "
                    f"ORDER BY bm25(fts, 6.0, 3.0, 1.0) + CASE WHEN u.source = 'eu' AND u.doc NOT LIKE '3%' THEN 4 ELSE 0 END LIMIT ?", [fq, *args, n * 3]).fetchall()
            except sqlite3.OperationalError as e:
                raise HTTPException(400, f"couldn't search that: {e}")
            for r in rows:
                if r["id"] in seen:
                    continue
                seen.add(r["id"])
                out.append({**dict(r), "snip": re.sub(r"\s+", " ", r["snip"])})
                if len(out) >= n:
                    break
            if out:
                break
    return out[:n]


def _snap(c, source: str) -> str:
    r = c.execute("SELECT snapshot, name FROM sources WHERE source=?", (source,)).fetchone()
    return f"{r['name']} — {r['snapshot']}" if r else source


def read(ref: str | None = None, uid: int | None = None, offset: int = 0) -> str:
    with _db() as c:
        row = None
        if uid:
            row = c.execute("SELECT * FROM units WHERE id=?", (uid,)).fetchone()
        elif ref:
            row = c.execute("SELECT * FROM units WHERE cite = ? COLLATE NOCASE ORDER BY ord LIMIT 1", (ref.strip(),)).fetchone()
            if not row:
                for g in _cite_guess(ref):
                    row = c.execute("SELECT * FROM units WHERE cite = ? COLLATE NOCASE ORDER BY ord LIMIT 1", (g,)).fetchone()
                    if row:
                        break
        if row:
            parts = c.execute("SELECT heading, text FROM units WHERE source=? AND doc=? AND cite=? ORDER BY ord",
                              (row["source"], row["doc"], row["cite"])).fetchall()
            text = "\n".join(p["text"] for p in parts)
            head = (f"{row['cite']}\n{row['doc_title'] or ''}\n[{_snap(c, row['source'])}; file {row['file']}; unit {row['id']}]\n")
            if offset:
                text = text[offset:]
            cut = len(text) > READ_LIMIT
            text = text[:READ_LIMIT].rsplit(" ", 1)[0] if cut else text
            tail = f"\n… [cut at {offset + len(text)} chars; read again with offset={offset + len(text)}]" if cut else ""
            return f"{head}\n{text}{tail}\n\n{NOTICE}"
        # not a unit: a whole document (CELEX number, USC-15, CFR-15, or an act's label) -> outline
        doc = (ref or "").strip()
        rows = c.execute("SELECT DISTINCT cite, heading, doc_title, source FROM units WHERE doc = ? COLLATE NOCASE ORDER BY ord, id", (doc,)).fetchall()
        if not rows:
            rows = c.execute("SELECT DISTINCT u.cite, u.heading, u.doc_title, u.source FROM units u WHERE u.cite LIKE ? ESCAPE '\\' ORDER BY u.ord, u.id LIMIT ?",
                             (re.sub(r"([%_\\])", r"\\\1", doc) + "%", OUTLINE_LIMIT + 1)).fetchall()
        if not rows:
            raise HTTPException(404, f"Nothing cited as {ref!r}. Search first, then read a result's exact cite.")
        seen, lines = set(), []
        for r in rows:
            if r["cite"] in seen:
                continue
            seen.add(r["cite"])
            lines.append(f"- {r['cite']}" + (f" — {r['heading'][:90]}" if r["heading"] and r["heading"] not in r["cite"] else ""))
        more = f"\n… (+{len(lines) - OUTLINE_LIMIT} more)" if len(lines) > OUTLINE_LIMIT else ""
        return (f"{rows[0]['doc_title'] or doc}\n[{_snap(c, rows[0]['source'])}]\nOutline ({len(lines)} units); read one with its exact cite:\n"
                + "\n".join(lines[:OUTLINE_LIMIT]) + more)


@router.get("/sources")
def api_sources():
    return {"available": available(), "sources": sources()}


@router.get("/search")
def api_search(q: str, source: str = "", jurisdiction: str = "", n: int = 20):
    return {"results": search(q, source or None, jurisdiction or None, min(n, 50))}


@router.get("/read")
def api_read(cite: str = "", id: int = 0, offset: int = 0):
    return {"text": read(cite or None, id or None, offset)}


def legal_tool(args, ctx):
    action = str(args.get("action") or "search")
    if not available():
        return ToolResult("The offline legal index isn't built yet (~/shellb/legal/build_index.py).", error=True)
    try:
        if action == "sources":
            return ToolResult("\n".join(f"- {s['id']}: {s['name']} ({s['jurisdiction']}, {s['units']:,} units) — {s['snapshot']}. {s['note']}" for s in sources()))
        if action == "search":
            q = str(args.get("query") or "").strip()
            if not q:
                return ToolResult("query is required", error=True)
            n = max(1, min(int(args.get("n") or 8), 20))
            hits = search(q, args.get("source"), args.get("jurisdiction"), n)
            if not hits:
                return ToolResult(f"Nothing in the offline legal corpus matches {q!r}. Try other words, a citation, or drop the source filter.")
            with _db() as c:
                snaps = {h["source"]: _snap(c, h["source"]) for h in hits}
            lines = [f"- {h['cite']} [{h['source']}, unit {h['id']}]: {h['snip']}" for h in hits]
            return ToolResult(f"Offline legal results for {q!r}:\n" + "\n".join(lines)
                              + "\n\nSnapshots: " + "; ".join(snaps.values())
                              + "\nRead one with action=read and its exact cite (or id).")
        if action == "read":
            ref = str(args.get("cite") or args.get("query") or "").strip()
            uid = int(args["id"]) if str(args.get("id") or "").isdigit() else None
            if not ref and not uid:
                return ToolResult("cite or id is required", error=True)
            return ToolResult(read(ref or None, uid, int(args.get("offset") or 0)))
        return ToolResult("action is search, read or sources", error=True)
    except HTTPException as e:
        return ToolResult(str(e.detail), error=True)
    except sqlite3.Error as e:
        return ToolResult(f"legal index error: {e}", error=True)


async def _legal(args, ctx):
    import asyncio
    return await asyncio.to_thread(legal_tool, args, ctx)


def register():
    TOOLS["legal"] = {
        "fn": _legal, "service": None, "scope": "global", "auto": "when the legal index is built",
        "ui": {"displayName": "Offline Law", "icon": "Scale", "category": "knowledge",
               "description": "Search and read US and EU law offline: statutes, regulations, export controls, tariffs, EU acts, restricted-party lists."},
        "schema": _fn("legal",
                      "Search and read an offline snapshot of US and EU law. Sources: uscode (US Code), ecfr (CFR: 15 CFR 730-774 is the "
                      "EAR and Commerce Control List, 22 CFR 120-130 ITAR, 31 CFR 500+ OFAC, 19 CFR Customs), statutes (Statutes at Large), "
                      "plaw (Public Laws), hts (tariff schedule and duty rates), csl (Consolidated Screening List: Entity List, Denied "
                      "Persons, SDN, etc.), eu (EUR-Lex regulations, directives, decisions, including the Cyber Resilience Act 2024/2847, "
                      "NIS2, GDPR, AI Act, Data Act, RED, Dual-use 2021/821, Union Customs Code), fr (Federal Register), caselaw (US "
                      "opinions) when installed. Use it for legal reference instead of answering from memory, quote the exact text, and give "
                      "the cite and snapshot date. It is a snapshot and not legal advice. search returns cites with snippets; read takes an "
                      "exact cite (e.g. '15 CFR § 740.2', '9 U.S.C. § 2', 'Regulation (EU) 2024/2847, Article 13', 'HTS 8471') or a whole-act "
                      "name/CELEX number for an outline.",
                      {"action": {"type": "string", "enum": ["search", "read", "sources"]},
                       "query": {"type": "string", "description": "search: words or a citation; quote phrases"},
                       "cite": {"type": "string", "description": "read: exact cite from a search result, or an act (CELEX 32024R2847, 'Regulation (EU) 2024/2847') for its outline"},
                       "id": {"type": "integer", "description": "read: unit id from a search result"},
                       "offset": {"type": "integer", "description": "read: continue a cut text from this character"},
                       "source": {"type": "string", "enum": ["uscode", "ecfr", "statutes", "plaw", "hts", "csl", "eu", "fr", "caselaw"]},
                       "jurisdiction": {"type": "string", "enum": ["US", "EU"]},
                       "n": {"type": "integer", "description": "search: results (default 8, max 20)"}},
                      ["action"]),
    }
