"""First-visit welcome and the "What's new" card on the new chat page.

Remembered on the server (kv "onboarding") rather than per browser, so a person who has seen the welcome on their laptop
doesn't get it again on their phone. A guest's cell has its own database, so each guest is remembered separately.

What's new is built from docs/changelog.json: an entry with a `news` line (one plain sentence for everyone) shows on
the card once. Entries without one are for Settings → Changelog only. The first time this runs for someone:
- nothing in the database yet → a new person: show the welcome, and count today's news as already seen;
- conversations already there → someone using Shell:B before this shipped: no welcome, show the latest news.
"""
from fastapi import APIRouter, Request

import changelog
import db

router = APIRouter(prefix="/api/onboarding")
KEY = "onboarding"
SHOWN = 3  # news lines on the card at most; older unseen ones are marked seen with them


def _news() -> list[dict]:
    entries, _ = changelog.load()
    return [e for e in entries if e.get("news")]


def _state() -> dict:
    st = db.kv_get(KEY)
    if isinstance(st, dict):
        return st
    with db.conn() as c:
        used = c.execute("SELECT 1 FROM conversations LIMIT 1").fetchone() is not None
    st = {"welcomed": used, "seen": [] if used else [e["title"] for e in _news()]}
    db.kv_set(KEY, st)
    return st


@router.get("")
def get():
    st = _state()
    seen = set(st.get("seen", []))
    fresh = [] if not st.get("welcomed") else [e for e in _news() if e["title"] not in seen]
    return {"welcome": not st.get("welcomed"),
            "news": [{"date": e["date"], "title": e["title"], "news": e["news"]} for e in fresh[:SHOWN]]}


@router.post("/seen")
async def seen(req: Request):
    """{"what": "welcome"} after the welcome is finished or skipped; {"what": "news"} once the card has been shown.
    Either way every current news line counts as seen: a new person shouldn't get a What's new right after the welcome."""
    body = await req.json()
    st = _state()
    if body.get("what") == "welcome":
        st["welcomed"] = True
    st["seen"] = sorted(set(st.get("seen", [])) | {e["title"] for e in _news()})
    db.kv_set(KEY, st)
    return {"ok": True}
