"""Search and retrieval over past conversations (episodic memory).

Provides:
- text_search: SQLite FTS5 BM25 search over conversation messages.
- semantic_search: Embedding cosine similarity over conversation summaries.
- search: Hybrid search merging BM25 and semantic similarity.
- read: Excerpts messages from a conversation with budget clipping.
- recent: Formatted summary lines for the agent's system prompt.
"""
import re
from datetime import datetime
import numpy as np

import db

SEM_MIN = 0.45        # a summary this similar adds weight to a full-text match
SEM_ALONE = 0.55      # ... and this similar counts on its own

STOP = set("""a an the and or but if then of to in on at for with by from about as is are was were be been being do does
did have has had i you we they he she it me my our your this that these those what which who whom how when where why
can could would should will shall may might must not no yes so than too very just also any some all more most such
there here into over under again up down out off only own same other each few both s t don now let lets please tell
talk talked said say did we us conversation chat chats earlier last time remember""".split())


def _conv_meta(conv_ids) -> dict[str, dict]:
    if not conv_ids:
        return {}
    ids = list(conv_ids)
    with db.conn() as c:
        rows = c.execute(f"SELECT c.id, c.title, c.agent_id, c.created, c.updated, c.project_id, c.group_id, p.kind, s.summary "
                         f"FROM conversations c LEFT JOIN projects p ON p.id=c.project_id "
                         f"LEFT JOIN conv_summary s ON s.conv_id=c.id WHERE c.id IN ({','.join('?' * len(ids))})", ids).fetchall()
    out = {}
    for r in rows:
        href = (f"#/{'code' if r['kind'] == 'code' else 'studio'}/{r['project_id']}" if r["project_id"] else f"#/c/{r['id']}")
        out[r["id"]] = {"convId": r["id"], "title": r["title"] or "Untitled", "agentId": r["agent_id"],
                        "createdAt": r["created"] * 1000, "updatedAt": r["updated"] * 1000, "href": href,
                        "where": ("Code" if r["kind"] == "code" else "Studio") if r["project_id"] else ("Project" if r["group_id"] else "Chat"),
                        "summary": r["summary"] or ""}
    return out


def _fts_query(q: str, mode: str) -> str:
    tokens = []
    # Match double quoted phrases first: "some phrase"
    for phrase in re.findall(r'"([^"]+)"', q):
        phrase_clean = " ".join(re.findall(r"[\w][\w'.-]*", phrase.lower()))
        if phrase_clean:
            tokens.append(f'"{phrase_clean}"')

    # Match unquoted words
    unquoted = re.sub(r'"[^"]*"', ' ', q)
    words = [w for w in re.findall(r"[\w][\w'.-]*", unquoted.lower()) if len(w) >= 1]

    if mode == "all":  # prefix-match for every word (like a filter)
        word_tokens = [f'"{w}"*' for w in words[:12]]
        all_tokens = tokens + word_tokens
        return " ".join(all_tokens)

    words_filtered = [w for w in words if w not in STOP] or words
    word_tokens = [f'"{w}"' for w in words_filtered[:16]]
    all_tokens = tokens + word_tokens
    return " OR ".join(all_tokens)


def _plain(snip: str) -> str:
    """A snippet without Markdown noise; matches (marked \x01…\x02 by FTS) come back as [[…]] for the UI."""
    s = re.sub(r"!?\[([^\[\]]*)\]\([^)]*\)?", r"\1", snip)   # [text](url) -> text
    s = re.sub(r"\*\*|__|`+|^#+ |(?<=\s)#+ ", "", s)
    return " ".join(s.replace("\x01", "[[").replace("\x02", "]]").split())


def text_search(q: str, mode="any", limit=60, exclude=None, conv_id=None) -> dict[str, dict]:
    """conv_id -> {"rank": best bm25 (lower is better), "hits": [{msgId, role, createdAt, snippet}]}"""
    fq = _fts_query(q, mode)
    if not fq:
        return {}
    sql = ("SELECT msg_id, conv_id, role, created, snippet(msg_fts, 0, char(1), char(2), '…', 14) AS snip, "
           "bm25(msg_fts) AS rank FROM msg_fts WHERE msg_fts MATCH ?")
    params: list = [fq]
    if conv_id:
        sql += " AND conv_id = ?"
        params.append(conv_id)
    else:  # incognito chats are never found from outside (privacy.py)
        sql += " AND conv_id NOT IN (SELECT id FROM conversations WHERE incognito=1)"
    sql += " ORDER BY rank LIMIT ?"
    params.append(limit)
    with db.conn() as c:
        try:
            rows = c.execute(sql, params).fetchall()
        except Exception:  # noqa: BLE001  odd input the tokenizer still dislikes
            return {}
    out: dict[str, dict] = {}
    for r in rows:
        if r["conv_id"] == exclude:
            continue
        e = out.setdefault(r["conv_id"], {"rank": r["rank"], "hits": []})
        if len(e["hits"]) < 5:
            e["hits"].append({"msgId": r["msg_id"], "role": r["role"], "createdAt": r["created"] * 1000,
                              "snippet": _plain(r["snip"])})
    return out


async def semantic_search(q: str, settings: dict, k=8, exclude=None) -> dict[str, float]:
    with db.conn() as c:
        rows = c.execute("SELECT conv_id, embedding FROM conv_summary WHERE embedding IS NOT NULL "
                         "AND conv_id NOT IN (SELECT id FROM conversations WHERE incognito=1)").fetchall()
    rows = [r for r in rows if r["conv_id"] != exclude]
    if not rows or not q.strip():
        return {}
    from tools import embed
    v = (await embed([q], settings["embeddingModel"]))[0]
    scores = np.stack([np.frombuffer(r["embedding"], dtype=np.float32) for r in rows]) @ v
    order = np.argsort(-scores)[:k]
    return {rows[i]["conv_id"]: float(scores[i]) for i in order if scores[i] >= SEM_MIN}


async def search(q: str, settings: dict, limit=6, exclude=None) -> list[dict]:
    """Full text and summary similarity, merged: a conversation found both ways ranks first."""
    text = text_search(q, "any", exclude=exclude)
    try:
        sem = await semantic_search(q, settings, k=limit * 2, exclude=exclude)
    except Exception:  # noqa: BLE001  embeddings down: full text still works
        sem = {}
    ids = set(text) | {i for i, s in sem.items() if s >= SEM_ALONE}
    if not ids:
        return []
    ranks = sorted(text, key=lambda i: text[i]["rank"])
    score = {}
    for i in ids:
        t = 1 - ranks.index(i) / max(len(ranks), 1) if i in text else 0  # 1 for the best text match
        s = (sem.get(i, 0) - SEM_MIN) / (1 - SEM_MIN) * 1.2 if i in sem else 0
        score[i] = t + s
    meta = _conv_meta(ids)
    out = []
    for i in sorted(ids, key=lambda i: -score[i])[:limit]:
        if i in meta:
            out.append({**meta[i], "score": round(score[i], 3), "hits": text.get(i, {}).get("hits", [])})
    return out


def _clip(text: str, n: int) -> str:
    text = (text or "").strip()
    return text if len(text) <= n else text[: n * 2 // 3] + " …[cut]… " + text[-n // 3:]


def read(conv_id: str, around: str = "", budget=12000) -> str | None:
    conv = db.get_conversation(conv_id)
    if not conv or conv.get("incognito"):  # incognito chats can't be read back (privacy.py)
        return None
    msgs = [m for m in db.list_messages(conv_id) if (m["content"] or "").strip()]
    start = 0
    if around:
        idx = next((i for i, m in enumerate(msgs) if m["id"] == around), None)
        if idx is not None:
            start = max(0, idx - 3)
            msgs = msgs[start: idx + 5]
    meta = _conv_meta([conv_id]).get(conv_id, {})
    head = (f"# {meta.get('title', conv['title'])} ({meta.get('where', 'Chat')}, "
            f"{datetime.fromtimestamp(meta.get('createdAt', 0) / 1000):%b %d %Y})\n")
    if meta.get("summary"):
        head += f"Summary: {meta['summary']}\n"
    lines, per = [], max(600, budget // max(len(msgs), 1))
    for m in msgs:
        who = "User" if m["role"] == "user" else "Assistant"
        lines.append(f"[{m['id']}] {who}, {datetime.fromtimestamp(m['timestamp'] / 1000):%b %d %H:%M}:\n{_clip(m['content'], per)}")
    body = "\n\n".join(lines)
    if len(body) > budget:
        body = _clip(body, budget)
    return head + ("(excerpt around the requested message)\n" if around and start else "") + "\n" + body


def recent(exclude=None, n=6) -> str:
    """For the system prompt: the latest conversations with summaries, one line each."""
    with db.conn() as c:
        rows = c.execute("SELECT c.id, c.title, c.updated, s.summary FROM conversations c JOIN conv_summary s ON s.conv_id=c.id "
                         "WHERE c.id != ? AND s.summary != '' AND s.msg_count >= 4 AND COALESCE(c.incognito, 0) = 0 "
                         "ORDER BY c.updated DESC LIMIT ?",
                         (exclude or "", n)).fetchall()

    def short(t, n=220):
        return t if len(t) <= n else t[:n].rsplit(" ", 1)[0] + "…"
    return "\n".join(f"- {datetime.fromtimestamp(r['updated']):%b %d}: \"{r['title']}\" ({r['id']}): {short(r['summary'])}"
                     for r in rows)
