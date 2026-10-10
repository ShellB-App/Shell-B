"""Me (#/codex/me): everything Shell:B knows about the owner, on one page.

Nothing new is stored here except the portrait. The page is a view over what other modules already keep:
  memory.py       facts about the owner, by category (edits on the page go back through /api/memory)
  codex.py        contacts (the people in their life) and calendar events
  commitments.py  open follow-ups
  episodes.py     what recent conversations were about

The portrait is a short second-person paragraph the local utility model writes from the active memories and contacts.
It is cached in kv `me_portrait` with a hash of its inputs and rewritten in the background when they change, never by a
cloud model.
"""
import asyncio
import hashlib
import json
import re
import time
from datetime import date, datetime, timedelta

from fastapi import APIRouter

import db
import memory
import tokens

router = APIRouter(prefix="/api/me")

UPCOMING_DAYS = 45
_job: dict = {"running": False, "again": False}
_tasks: set = set()

# Contact roles → the circle a person is shown in. First match wins.
CIRCLES = (
    ("family", "Family", r"husband|wife|spouse|partner|fianc|father|mother|dad|mom|mum|parent|sister|brother|sibling|son\b|"
                         r"daughter|child|aunt|uncle|cousin|grand|niece|nephew|in-law|step"),
    ("friends", "Friends", r"friend|roommate|neighbou?r"),
    ("pets", "Pets", r"\bpet\b|\bcat\b|\bdog\b|kitten|puppy"),
    ("work", "Work", r"engineer|manager|director|colleague|co-?worker|boss|lead\b|technician|ceo|cto|founder|recruiter|"
                     r"officer|analyst|designer|developer|supervisor|intern|vp\b|president"),
)
CIRCLE_ORDER = [c[0] for c in CIRCLES] + ["others"]
CIRCLE_LABELS = {**{c[0]: c[1] for c in CIRCLES}, "others": "Others"}


def _circle(meta: dict, owner: str) -> str:
    role = str(meta.get("role") or "").lower()
    for cid, _, pat in CIRCLES:
        if role and re.search(pat, role):
            return cid
    company = str(meta.get("company") or "")
    # "Evie's Apartment Complex" is a place in her life, not where she works
    return "work" if company and not (owner and owner.lower() in company.lower()) else "others"


def _owner(mems) -> str | None:
    try:
        from feedback import _owner_name
        name = _owner_name()
    except Exception:  # noqa: BLE001
        name = "The user"
    if name != "The user":
        return name
    for m in mems:
        hit = m["category"] == "identity" and re.search(r"\b(?:known as|goes by|called)\s+([A-Z][a-z]+)", m["text"])
        if hit:
            return hit.group(1)
    # the learner writes memories as "<Name> prefers …", so the most common opening word is usually the name
    starts = [w.group(1) for m in mems if (w := re.match(r"([A-Z][a-z]{2,})\b(?!’|')", m["text"]))]
    best = max(set(starts), key=starts.count) if starts else None
    return best if best and starts.count(best) >= max(3, len(mems) // 4) else None


def _today() -> date:
    return memory._now(memory._settings()).date()


def _parse_day(value) -> tuple[int | None, int, int] | None:
    """'1998-06-23' → (1998, 6, 23); '06-23' or '--06-23' → (None, 6, 23)."""
    m = re.match(r"^(?:(\d{4})|-)?-?(\d{1,2})-(\d{1,2})", str(value or "").strip())
    if not m:
        return None
    y, mo, d = (int(m.group(1)) if m.group(1) else None), int(m.group(2)), int(m.group(3))
    return (y, mo, d) if 1 <= mo <= 12 and 1 <= d <= 31 else None


def _next(mo: int, d: int, today: date) -> date | None:
    for y in (today.year, today.year + 1):
        try:
            when = date(y, mo, d)
        except ValueError:  # Feb 29 in a common year
            when = date(y, 2, 28) if (mo, d) == (2, 29) else None
        if when and when >= today:
            return when
    return None


MONTHS = "january february march april may june july august september october november december".split()
_BORN = re.compile(r"\bborn\b[^.]*?\bon\s+(" + "|".join(MONTHS) + r")\s+(\d{1,2}),?\s+(\d{4})", re.I)


def _owner_birthday(mems) -> tuple[int, int, int] | None:
    """From an identity memory like '…was born in Harare on April 4, 1995…'."""
    for m in mems:
        if m["category"] == "identity":
            hit = _BORN.search(m["text"])
            if hit:
                return int(hit.group(3)), MONTHS.index(hit.group(1).lower()) + 1, int(hit.group(2))
    return None


# ── people ──────────────────────────────────────────────────────────────────

def _contacts() -> list[dict]:
    with db.conn() as c:
        rs = c.execute("SELECT id, title, meta, body FROM codex_entries WHERE kind='contact' AND status IN ('ok','draft') "
                       "ORDER BY title COLLATE NOCASE").fetchall()
    return [{"id": r["id"], "name": (r["title"] or "").strip(), "meta": json.loads(r["meta"] or "{}"),
             "notes": (r["body"] or "").strip()} for r in rs if (r["title"] or "").strip()]


def _name_keys(name: str, owner: str, aka=()) -> list[re.Pattern]:
    """Patterns that mean a memory is about this person: the full name, a quoted nickname, a nickname kept in the
    contact's `aka`, or the first name (not when it is the owner's own name)."""
    keys = {name, *(str(a).strip() for a in aka or [])}
    keys.update(re.findall(r"[\"“']([^\"”']{2,30})[\"”']", name))
    plain = re.sub(r"[\"“”']([^\"”']*)[\"”']", " ", name).split()
    if plain and len(plain[0]) >= 3 and plain[0].lower() != owner.lower():
        keys.add(plain[0])
    return [re.compile(r"\b" + re.escape(k) + r"\b", re.I) for k in keys if k.strip()]


_DIED = re.compile(r"\b(passed away|died|deceased|was put down|put to sleep)\b", re.I)


def _died(text: str, keys: list[re.Pattern], others: list[re.Pattern]) -> bool:
    """'…Salem and a Lab-Doberman named Oliver, who … passed away …': the death belongs to the name closest before it,
    so another person's name in between means it is about them, not this one."""
    for d in _DIED.finditer(text):
        before = [m.end() for k in keys for m in k.finditer(text, 0, d.start())]
        if before and not any(k.search(text, max(before), d.start()) for k in others):
            return True
    return False


def _people(mems: list[dict], owner: str, today: date) -> tuple[list[dict], list[str]]:
    contacts = _contacts()
    keys = {ct["id"]: _name_keys(ct["name"], owner, ct["meta"].get("aka")) for ct in contacts}
    people, matched = [], set()
    for ct in contacts:
        mine = keys[ct["id"]]
        others = [k for cid, ks in keys.items() if cid != ct["id"] for k in ks]
        about = [m for m in mems if any(k.search(m["text"]) for k in mine)]
        matched.update(m["id"] for m in about)
        meta = ct["meta"]
        gone = bool(meta.get("deceased")) or any(_died(m["text"], mine, others) for m in about)
        bday = _parse_day(meta.get("birthday"))
        nxt = _next(bday[1], bday[2], today) if bday and not gone else None
        people.append({
            "id": ct["id"], "name": ct["name"], "role": meta.get("role") or "", "company": meta.get("company") or "",
            "location": meta.get("location") or "", "email": meta.get("email") or "", "phone": meta.get("phone") or "",
            "notes": ct["notes"][:400], "aka": [str(a) for a in meta.get("aka") or [] if a], "circle": _circle(meta, owner), "memories": [m["id"] for m in about],
            "birthday": meta.get("birthday") or None, "nextBirthday": nxt.isoformat() if nxt else None,
            "turns": (nxt.year - bday[0]) if (nxt and bday and bday[0]) else None, "inMemory": gone,
        })
    loose = [m["id"] for m in mems if m["category"] == "person" and m["id"] not in matched]
    return people, loose


# ── coming up ───────────────────────────────────────────────────────────────

def _events(today: date, end: date) -> list[dict]:
    with db.conn() as c:
        rs = c.execute("SELECT id, title, meta FROM codex_entries WHERE kind='event' AND status IN ('ok','draft')").fetchall()
    out = []
    for r in rs:
        meta = json.loads(r["meta"] or "{}")
        day = _parse_day(meta.get("startDate") or meta.get("date"))
        if not day:
            continue
        yearly = str(meta.get("recurrence") or "").lower() in ("yearly", "annual", "annually")
        try:
            when = _next(day[1], day[2], today) if (yearly or day[0] is None) else date(day[0], day[1], day[2])
        except ValueError:
            continue
        if when and today <= when <= end:
            t = "" if meta.get("allDay") else str(meta.get("startTime") or meta.get("time") or "")
            out.append({"kind": "event", "id": r["id"], "title": r["title"] or "Untitled event", "date": when.isoformat(),
                        "time": t, "detail": meta.get("location") or "", "yearly": yearly})
    return out


def _upcoming(people: list[dict], mems: list[dict], today: date) -> list[dict]:
    end = today + timedelta(days=UPCOMING_DAYS)
    items = _events(today, end)
    seen = {(i["title"].lower(), i["date"]) for i in items}
    # birthdays inside the window, and always the next few even when they are further out
    soonest = sorted((p for p in people if p["nextBirthday"]), key=lambda p: p["nextBirthday"])
    for n, p in enumerate(soonest):
        if p["nextBirthday"] <= end.isoformat() or n < 3:
            title = f"{p['name']}’s birthday"
            # a yearly birthday event in the calendar already covers it
            if not any(i["date"] == p["nextBirthday"] and p["name"].split()[0].lower() in i["title"].lower() for i in items):
                items.append({"kind": "birthday", "id": p["id"], "title": title, "date": p["nextBirthday"], "time": "",
                              "detail": f"turns {p['turns']}" if p["turns"] else "", "yearly": True})
    mine = _owner_birthday(mems)
    if mine:
        nxt = _next(mine[1], mine[2], today)
        if nxt and nxt <= end and ("your birthday", nxt.isoformat()) not in seen:
            items.append({"kind": "birthday", "id": "me", "title": "Your birthday", "date": nxt.isoformat(), "time": "",
                          "detail": f"you turn {nxt.year - mine[0]}", "yearly": True})
    try:
        import commitments
        for c in commitments.rows():
            if commitments._mine(c) and (not c["due"] or c["due"][:10] <= end.isoformat()):
                items.append({"kind": "followup", "id": c["id"], "title": c["text"], "date": (c["due"] or "")[:10],
                              "time": (c["due"] or "")[11:16], "detail": "", "yearly": False,
                              "overdue": bool(c["due"] and c["due"][:10] < today.isoformat()), "convId": c["convId"]})
    except Exception:  # noqa: BLE001  follow-ups are optional here
        pass
    items.sort(key=lambda i: (not i.get("overdue"), i["date"] or "9999", i["time"]))
    return items


# ── over time ───────────────────────────────────────────────────────────────

def _timeline(all_mems: list[dict]) -> list[dict]:
    """Per month: memories first noted, memories forgotten or replaced, and how many chats were started."""
    months: dict[str, dict] = {}
    get = lambda ts: months.setdefault(datetime.fromtimestamp(ts / 1000).strftime("%Y-%m"),  # noqa: E731
                                       {"learned": [], "changed": [], "chats": 0})
    for m in all_mems:
        if m["status"] == "pending":
            continue
        get(m["createdAt"])["learned"].append(m["id"])
        if m["status"] == "retired":
            get(m["updatedAt"])["changed"].append(m["id"])
    with db.conn() as c:
        for r in c.execute("SELECT strftime('%Y-%m', created, 'unixepoch', 'localtime') AS mo, count(*) AS n "
                           "FROM conversations WHERE NOT coalesce(incognito, 0) GROUP BY mo"):
            months.setdefault(r["mo"], {"learned": [], "changed": [], "chats": 0})["chats"] = r["n"]
    return [{"month": k, **v} for k, v in sorted(months.items(), reverse=True)[:24]]


def _recent_chats(limit=6) -> list[dict]:
    with db.conn() as c:
        rs = c.execute("SELECT c.id, c.title, c.updated, s.summary FROM conversations c "
                       "JOIN conv_summary s ON s.conv_id = c.id WHERE NOT coalesce(c.incognito, 0) "
                       "AND coalesce(s.summary, '') != '' ORDER BY c.updated DESC LIMIT ?", (limit,)).fetchall()
    return [{"id": r["id"], "title": r["title"] or "Untitled", "summary": r["summary"], "at": r["updated"] * 1000} for r in rs]


# ── portrait ────────────────────────────────────────────────────────────────

PORTRAIT_PROMPT = """You are Shell:B, a personal AI companion. Write a short portrait of the person you look after, addressed to them in the second person ("You're …").

Use ONLY the facts below. 3 to 5 sentences, about 90 words, plain and warm, no flattery, no headings, no lists, no Markdown. Cover who they are, what they do, the people (and animals) who matter to them, and how they like to work with you. Do not invent anything or guess at feelings. Leave out medical, sexual, immigration and legal details, and street addresses.

Facts:
{facts}

People:
{people}"""


def _portrait_inputs(mems, contacts) -> tuple[str, str]:
    facts = "\n".join(f"- ({m['category']}) {m['text']}" for m in mems)
    people = "\n".join(f"- {c['name']}" + (f": {c['meta']['role']}" if c["meta"].get("role") else "") for c in contacts)
    return facts, people or "(none)"


def _hash(facts: str, people: str) -> str:
    return hashlib.sha1(f"{facts}\n{people}".encode()).hexdigest()[:16]


async def _write_portrait():
    _job["running"] = True
    try:
        while True:
            _job["again"] = False
            mems, contacts = memory.rows(), _contacts()
            facts, people = _portrait_inputs(mems, contacts)
            h = _hash(facts, people)
            if not mems:
                db.kv_set("me_portrait", {"text": "", "hash": h, "at": time.time(), "error": ""})
                break
            settings = memory._settings()
            model = settings.get("utilityModel") or ""
            import providers
            if not model or providers.is_cloud(model):  # the profile never goes to a cloud model for this
                db.kv_set("me_portrait", {**db.kv_get("me_portrait", {}), "errorAt": time.time(),
                                          "error": "Needs a local utility model (Settings → General)."})
                break
            from agent import model_info
            payload = {"model": model, "stream": False, "keep_alive": "2h",
                       "options": {"temperature": 0.4, "num_predict": 260},
                       "messages": [{"role": "user", "content": PORTRAIT_PROMPT.format(facts=facts, people=people)}]}
            if "thinking" in (await model_info(model))["capabilities"]:
                payload["think"] = False
            async with memory._lock:  # one utility-model job at a time on the shared GPU
                import fleet
                r = await fleet.post("/api/chat", payload, timeout=180)
                r.raise_for_status()
            text = (r.json()["message"]["content"] or "").replace("**", "").strip()
            text = re.sub(r"^(here(’|')?s|portrait:).*?\n+", "", text, flags=re.I).strip()
            db.kv_set("me_portrait", {"text": text[:1200], "hash": h, "at": time.time(), "error": ""})
            if not _job["again"]:
                break
    except Exception as e:  # noqa: BLE001
        db.kv_set("me_portrait", {**db.kv_get("me_portrait", {}), "errorAt": time.time(),
                                    "error": f"{type(e).__name__}: {e}"[:200]})
    finally:
        _job["running"] = False


def _refresh_portrait(force=False):
    if _job["running"]:
        _job["again"] = True
        return
    if force:
        db.kv_set("me_portrait", {**db.kv_get("me_portrait", {}), "hash": ""})
    t = asyncio.get_running_loop().create_task(_write_portrait())
    _tasks.add(t)
    t.add_done_callback(_tasks.discard)


# ── HTTP ────────────────────────────────────────────────────────────────────

def overview() -> dict:
    today = _today()
    all_mems = memory.rows(("active", "pending", "retired"))
    active = [m for m in all_mems if m["status"] == "active"]
    owner = _owner(active)
    people, loose = _people(active, owner or "", today)
    facts, plist = _portrait_inputs(active, _contacts())
    p = db.kv_get("me_portrait", {}) or {}
    stale = p.get("hash") != _hash(facts, plist)
    with db.conn() as c:
        chats, first = c.execute("SELECT count(*), min(created) FROM conversations WHERE NOT coalesce(incognito, 0)").fetchone()
    since = min([x for x in (first and first * 1000, *(m["createdAt"] for m in all_mems)) if x] or [0]) or None
    born = _owner_birthday(active)
    return {
        "owner": owner,
        "today": today.isoformat(),
        "age": (today.year - born[0] - ((today.month, today.day) < (born[1], born[2]))) if born else None,
        "portrait": {"text": p.get("text", ""), "at": (p.get("at") or 0) * 1000, "stale": stale,
                     "writing": _job["running"], "error": p.get("error", "")},
        "memories": all_mems,
        "categories": [{"id": c, "label": memory.CATEGORY_LABELS[c], "core": c in memory.CORE} for c in memory.CATEGORIES],
        "people": people, "loosePeople": loose,
        "circles": [{"id": c, "label": CIRCLE_LABELS[c]} for c in CIRCLE_ORDER],
        "upcoming": _upcoming(people, active, today),
        "timeline": _timeline(all_mems),
        "recent": _recent_chats(),
        "stats": {"since": since, "chats": chats, "memories": len(active), "people": len(people),
                  "pending": sum(1 for m in all_mems if m["status"] == "pending"), "tokens": tokens.stats("")},
    }


@router.get("")
async def api_me():
    data = overview()
    if data["portrait"]["stale"] and not data["portrait"]["writing"] and not (
            data["portrait"]["error"] and time.time() - (db.kv_get("me_portrait", {}) or {}).get("errorAt", 0) < 300):
        _refresh_portrait()
        data["portrait"]["writing"] = True
    return data


@router.post("/portrait")
async def api_portrait():
    _refresh_portrait(force=True)
    return {"writing": True}
