"""Calendar and contacts interchange for the Codex: iCalendar (.ics) and vCard (.vcf) in and out, recurrence beyond
"yearly", and reminders. Stdlib plus python-dateutil (already in the venv for pandas), no calendar library.

Events are Codex entries of kind `event` (meta: date, time, endDate, endTime, allDay, location, attendees, recurrence
none|daily|weekly|monthly|yearly|custom, rrule (RFC 5545 text when custom), status, uid, reminderMinutes). Contacts are
kind `contact` (meta: role, company, email/emails, phone/phones, location, birthday, pronouns, aka, urls, uid).

- GET  /api/codex/calendar.ics   every event (or `?collection=`) as one VCALENDAR; subscribe to it from another app.
- POST /api/codex/import/ics     .ics files → events; an event with a UID that is already here is updated, not doubled.
- GET  /api/codex/contacts.vcf   every contact as vCard 3.0.
- POST /api/codex/import/vcf     .vcf files → contacts; matched by UID, then by name (case-insensitive) or email.
- occurrences(meta, start, end)  the dates an event falls on in a window (dateutil.rrule); codex.upcoming_schedule_prompt
  and the calendar grid use it, so weekly and custom repeats show up, not only yearly ones.
- Reminders: `reminderMinutes` on an event posts to Activity (source `calendar`, status `due`) that long before the
  next occurrence starts, once per occurrence (kv `calendar_fired`), so push and email can carry it.

Imports are the owner's own data from their other apps, so they are written as accepted entries (not drafts) by
"import". Agents don't get an import tool; the Codex tool's `add` already makes drafts.
"""
import asyncio
import json
import re
import time
import uuid
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from dateutil import rrule as _rr
from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import Response

import db

router = APIRouter(prefix="/api/codex")
PRODID = "-//Shell:B//Codex//EN"
MAX_IMPORT = 20 * 1024 * 1024
RECUR_FREQ = {"daily": "DAILY", "weekly": "WEEKLY", "monthly": "MONTHLY", "yearly": "YEARLY"}
FREQ_RECUR = {v: k for k, v in RECUR_FREQ.items()}
_task: asyncio.Task | None = None


# ── time helpers ────────────────────────────────────────────────────────────

def tz() -> ZoneInfo | None:
    try:
        name = (db.kv_get("settings") or {}).get("timeZone")
        return ZoneInfo(name) if name else None
    except Exception:  # noqa: BLE001
        return None


def now_local() -> datetime:
    z = tz()
    return datetime.now(z) if z else datetime.now().astimezone()


def _d(s) -> date | None:
    s = str(s or "").strip()
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", s)
    if not m:
        return None
    try:
        return date(int(m[1]), int(m[2]), int(m[3]))
    except ValueError:
        return None


def _t(s) -> tuple[int, int] | None:
    m = re.match(r"^(\d{1,2}):(\d{2})", str(s or "").strip())
    return (int(m[1]), int(m[2])) if m and int(m[1]) < 24 and int(m[2]) < 60 else None


def start_of(meta: dict) -> date | None:
    return _d(meta.get("date") or meta.get("startDate"))


def start_dt(meta: dict, day: date) -> datetime:
    """A local, tz-aware datetime for one occurrence of the event on `day`."""
    t = None if meta.get("allDay") else _t(meta.get("time") or meta.get("startTime"))
    z = tz()
    dt = datetime(day.year, day.month, day.day, *(t or (0, 0)))
    return dt.replace(tzinfo=z) if z else dt.astimezone()


# ── recurrence ──────────────────────────────────────────────────────────────

def rule_for(meta: dict) -> str:
    """The RRULE text (without the `RRULE:` prefix) this event repeats by, or ''."""
    rec = str(meta.get("recurrence") or "none").lower()
    if rec == "custom":
        return re.sub(r"^RRULE:", "", str(meta.get("rrule") or "").strip(), flags=re.I)
    if rec in RECUR_FREQ:
        return f"FREQ={RECUR_FREQ[rec]}"
    return ""


def occurrences(meta: dict, start: date, end: date, limit: int = 400) -> list[date]:
    """Dates in [start, end] the event falls on. A one-off is included only if its date is in the window."""
    first = start_of(meta)
    if not first or end < start:
        return []
    rule = rule_for(meta)
    if not rule:
        return [first] if start <= first <= end else []
    try:
        rs = _rr.rrulestr(rule, dtstart=datetime(first.year, first.month, first.day))
    except Exception:  # noqa: BLE001  a malformed RRULE: behave like a one-off
        return [first] if start <= first <= end else []
    out = []
    for dt in rs.between(datetime(start.year, start.month, start.day) - timedelta(seconds=1),
                         datetime(end.year, end.month, end.day, 23, 59, 59), inc=True):
        out.append(dt.date())
        if len(out) >= limit:
            break
    return out


def next_occurrence(meta: dict, after: datetime) -> datetime | None:
    """The next start at or after `after`, looking a year ahead."""
    day0 = after.date() - timedelta(days=1)
    for d in occurrences(meta, day0, day0 + timedelta(days=366), limit=60):
        dt = start_dt(meta, d)
        if dt >= after:
            return dt
    return None


# ── iCalendar ───────────────────────────────────────────────────────────────

def _esc(s) -> str:
    return str(s or "").replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\r\n", "\\n").replace("\n", "\\n")


def _unesc(s: str) -> str:
    out, i = [], 0
    while i < len(s):
        c = s[i]
        if c == "\\" and i + 1 < len(s):
            n = s[i + 1]
            out.append("\n" if n in "nN" else n)
            i += 2
        else:
            out.append(c)
            i += 1
    return "".join(out)


def _fold(line: str) -> str:
    b = line.encode()
    if len(b) <= 75:
        return line
    parts, cur = [], b""
    for ch in line:
        e = ch.encode()
        if len(cur) + len(e) > (75 if not parts else 74):
            parts.append(cur.decode())
            cur = b""
        cur += e
    parts.append(cur.decode())
    return "\r\n ".join(parts)


def _ics_dt(day: date, t: tuple[int, int] | None, tzname: str | None) -> tuple[str, str]:
    """(property parameters, value) for DTSTART/DTEND."""
    if t is None:
        return ";VALUE=DATE", day.strftime("%Y%m%d")
    v = f"{day:%Y%m%d}T{t[0]:02d}{t[1]:02d}00"
    return (f";TZID={tzname}" if tzname else ""), v


def event_to_ics(e: dict, tzname: str | None) -> list[str]:
    m = e.get("meta") or {}
    first = start_of(m)
    if not first:
        return []
    all_day = bool(m.get("allDay")) or not _t(m.get("time") or m.get("startTime"))
    st = None if all_day else _t(m.get("time") or m.get("startTime"))
    p, v = _ics_dt(first, st, tzname)
    lines = ["BEGIN:VEVENT", f"UID:{m.get('uid') or e['id'] + '@shellb'}",
             f"DTSTAMP:{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}", f"SUMMARY:{_esc(e.get('title'))}", f"DTSTART{p}:{v}"]
    end_d = _d(m.get("endDate")) or first
    et = None if all_day else _t(m.get("endTime"))
    if all_day:
        if end_d >= first:
            lines.append(f"DTEND;VALUE=DATE:{end_d + timedelta(days=1):%Y%m%d}")
    elif et or end_d != first:
        p2, v2 = _ics_dt(end_d, et or st, tzname)
        lines.append(f"DTEND{p2}:{v2}")
    if m.get("location"):
        lines.append(f"LOCATION:{_esc(m['location'])}")
    desc = str(e.get("body") or "")
    att = [str(a) for a in (m.get("attendees") or []) if a]
    if att:
        desc = (desc + "\n\n" if desc else "") + "With: " + ", ".join(att)
        for a in att:
            lines.append(f"ATTENDEE;CN={_esc(a)};ROLE=REQ-PARTICIPANT:invalid:nomail")
    if desc:
        lines.append(f"DESCRIPTION:{_esc(desc)}")
    rule = rule_for(m)
    if rule:
        lines.append(f"RRULE:{rule}")
    status = str(m.get("status") or "confirmed").upper()
    if status in ("CONFIRMED", "TENTATIVE", "CANCELLED"):
        lines.append(f"STATUS:{status}")
    rm = m.get("reminderMinutes")
    if isinstance(rm, (int, float)) and rm >= 0:
        lines += ["BEGIN:VALARM", "ACTION:DISPLAY", f"DESCRIPTION:{_esc(e.get('title'))}",
                  f"TRIGGER:-PT{int(rm)}M" if rm else "TRIGGER:PT0S", "END:VALARM"]
    lines.append("END:VEVENT")
    return lines


def calendar_ics(events: list[dict], tzname: str | None) -> str:
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", f"PRODID:{PRODID}", "CALSCALE:GREGORIAN", "X-WR-CALNAME:Shell:B Codex"]
    if tzname:
        lines.append(f"X-WR-TIMEZONE:{tzname}")
    for e in events:
        lines += event_to_ics(e, tzname)
    lines.append("END:VCALENDAR")
    return "\r\n".join(_fold(ln) for ln in lines) + "\r\n"


def _unfold(text: str) -> list[str]:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    out: list[str] = []
    for ln in text.split("\n"):
        if ln[:1] in (" ", "\t") and out:
            out[-1] += ln[1:]
        elif ln.strip():
            out.append(ln)
    return out


def _prop(line: str) -> tuple[str, dict[str, str], str] | None:
    """`NAME;PARAM=a;PARAM2="b":value` → (NAME, {PARAM: a, PARAM2: b}, value). Params may hold quoted colons."""
    i, inq = 0, False
    while i < len(line):
        c = line[i]
        if c == '"':
            inq = not inq
        elif c == ":" and not inq:
            break
        i += 1
    else:
        return None
    head, value = line[:i], line[i + 1:]
    parts = head.split(";")
    params: dict[str, str] = {}
    for p in parts[1:]:
        if "=" in p:
            k, v = p.split("=", 1)
            params[k.upper()] = v.strip('"')
    return parts[0].upper(), params, value


def _blocks(lines: list[str], kind: str) -> list[list[tuple[str, dict, str, int]]]:
    """The properties of each `kind` component as (name, params, value, depth); depth 1 is the component's own line,
    deeper ones belong to nested components (a VEVENT's VALARM)."""
    out, cur, depth = [], None, 0
    for ln in lines:
        p = _prop(ln)
        if not p:
            continue
        name, params, value = p
        if name == "BEGIN" and value.upper() == kind:
            cur, depth = [], 1
            continue
        if cur is not None:
            if name == "BEGIN":
                depth += 1
            elif name == "END":
                depth -= 1
                if depth == 0 and value.upper() == kind:
                    out.append(cur)
                    cur = None
                    continue
            cur.append((name, params, value, depth))
    return out


def _parse_dt(value: str, params: dict, default_tz: ZoneInfo | None) -> tuple[date, tuple[int, int] | None]:
    """RFC 5545 DATE or DATE-TIME → local (date, (h, m) or None for all-day)."""
    v = value.strip()
    if params.get("VALUE") == "DATE" or re.fullmatch(r"\d{8}", v):
        return date(int(v[:4]), int(v[4:6]), int(v[6:8])), None
    m = re.fullmatch(r"(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z?)", v)
    if not m:
        raise ValueError(f"bad date {value!r}")
    dt = datetime(int(m[1]), int(m[2]), int(m[3]), int(m[4]), int(m[5]), int(m[6] or 0))
    if m[7] == "Z":
        dt = dt.replace(tzinfo=ZoneInfo("UTC"))
    elif params.get("TZID"):
        try:
            dt = dt.replace(tzinfo=ZoneInfo(params["TZID"]))
        except Exception:  # noqa: BLE001  unknown zone name (Windows style): treat as local
            dt = dt.replace(tzinfo=default_tz) if default_tz else dt.astimezone()
    else:  # floating: local time
        return dt.date(), (dt.hour, dt.minute)
    local = dt.astimezone(default_tz) if default_tz else dt.astimezone()
    return local.date(), (local.hour, local.minute)


def _recurrence_from_rrule(rule: str) -> tuple[str, str]:
    """(recurrence, rrule text): a plain FREQ with no extras maps to the simple words; anything else is custom."""
    parts = {k.upper(): v for k, v in (p.split("=", 1) for p in rule.split(";") if "=" in p)}
    extras = set(parts) - {"FREQ", "INTERVAL", "WKST"}
    if not extras and parts.get("INTERVAL", "1") == "1" and parts.get("FREQ") in FREQ_RECUR:
        return FREQ_RECUR[parts["FREQ"]], ""
    return "custom", rule


def ics_events(text: str, default_tz: ZoneInfo | None) -> list[dict]:
    """Codex event fields ({title, body, meta}) from an .ics text. Bad components are skipped, not fatal."""
    out = []
    for props in _blocks(_unfold(text), "VEVENT"):
        get = {name: (params, value) for name, params, value, depth in props if depth == 1 and name not in ("ATTENDEE", "BEGIN", "END")}
        if "DTSTART" not in get:
            continue
        try:
            sd, st = _parse_dt(get["DTSTART"][1], get["DTSTART"][0], default_tz)
        except ValueError:
            continue
        meta: dict = {"date": sd.isoformat(), "allDay": st is None}
        if st:
            meta["time"] = f"{st[0]:02d}:{st[1]:02d}"
        if "DTEND" in get:
            try:
                ed, et = _parse_dt(get["DTEND"][1], get["DTEND"][0], default_tz)
                if st is None and et is None:
                    ed = ed - timedelta(days=1)  # all-day DTEND is exclusive
                if ed != sd:
                    meta["endDate"] = ed.isoformat()
                if et and st and (et != st or ed != sd):
                    meta["endTime"] = f"{et[0]:02d}:{et[1]:02d}"
            except ValueError:
                pass
        elif "DURATION" in get and st:
            m = re.fullmatch(r"P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?", get["DURATION"][1].strip())
            if m:
                end = start_dt(meta, sd) + timedelta(days=int(m[1] or 0), hours=int(m[2] or 0), minutes=int(m[3] or 0))
                if end.date() != sd:
                    meta["endDate"] = end.date().isoformat()
                meta["endTime"] = f"{end.hour:02d}:{end.minute:02d}"
        if "LOCATION" in get and get["LOCATION"][1].strip():
            meta["location"] = _unesc(get["LOCATION"][1])[:300]
        if "RRULE" in get:
            meta["recurrence"], rule = _recurrence_from_rrule(get["RRULE"][1].strip())
            if rule:
                meta["rrule"] = rule
        if "STATUS" in get and get["STATUS"][1].strip().lower() in ("confirmed", "tentative", "cancelled"):
            meta["status"] = get["STATUS"][1].strip().lower()
        if "UID" in get and get["UID"][1].strip():
            meta["uid"] = get["UID"][1].strip()[:200]
        att = [_unesc(params.get("CN") or value.replace("mailto:", "")) for name, params, value, depth in props if name == "ATTENDEE" and depth == 1]
        if att:
            meta["attendees"] = [a for a in att if a and a != "invalid:nomail"][:30]
        for name, params, value, depth in props:  # VALARM's TRIGGER sits inside the event block (depth 2)
            if name == "TRIGGER":
                m = re.fullmatch(r"-?P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?", value.strip())
                if m:
                    meta["reminderMinutes"] = int(m[1] or 0) * 1440 + int(m[2] or 0) * 60 + int(m[3] or 0)
                break
        body = _unesc(get["DESCRIPTION"][1]) if "DESCRIPTION" in get else ""
        body = re.sub(r"\n\nWith: [^\n]*$", "", body).strip()
        out.append({"kind": "event", "title": _unesc(get["SUMMARY"][1]).strip()[:200] if "SUMMARY" in get else "Event",
                    "body": body[:20000], "meta": meta})
    return out


# ── vCard ───────────────────────────────────────────────────────────────────

def contact_to_vcf(e: dict) -> list[str]:
    m = e.get("meta") or {}
    name = str(e.get("title") or "").strip()
    parts = name.split()
    n = f"{parts[-1]};{' '.join(parts[:-1])};;;" if len(parts) > 1 else f"{name};;;;"
    lines = ["BEGIN:VCARD", "VERSION:3.0", f"UID:{m.get('uid') or e['id'] + '@shellb'}", f"FN:{_esc(name)}", f"N:{n}"]
    if m.get("company"):
        lines.append(f"ORG:{_esc(m['company'])}")
    if m.get("role"):
        lines.append(f"TITLE:{_esc(m['role'])}")
    for x in (m.get("emails") or ([m["email"]] if m.get("email") else [])):
        if x:
            lines.append(f"EMAIL;TYPE=INTERNET:{_esc(x)}")
    for x in (m.get("phones") or ([m["phone"]] if m.get("phone") else [])):
        if x:
            lines.append(f"TEL:{_esc(x)}")
    if m.get("location"):
        lines.append(f"ADR;TYPE=HOME:;;{_esc(m['location'])};;;;")
    bd = str(m.get("birthday") or "").strip()
    if bd:
        d = _d(bd)
        lines.append(f"BDAY:{d.isoformat() if d else bd}" if d or re.fullmatch(r"--?\d{2}-?\d{2}", bd) else f"BDAY;VALUE=text:{_esc(bd)}")
    aka = [str(x) for x in (m.get("aka") or []) if x]
    if aka:
        lines.append(f"NICKNAME:{','.join(_esc(x) for x in aka)}")
    for u in (m.get("urls") or []):
        if u:
            lines.append(f"URL:{_esc(u)}")
    if m.get("pronouns"):
        lines.append(f"X-PRONOUNS:{_esc(m['pronouns'])}")
    body = str(e.get("body") or "").strip()
    if body:
        lines.append(f"NOTE:{_esc(body)}")
    lines.append("END:VCARD")
    return lines


def contacts_vcf(contacts: list[dict]) -> str:
    lines: list[str] = []
    for c in contacts:
        lines += contact_to_vcf(c)
    return "\r\n".join(_fold(ln) for ln in lines) + "\r\n"


def vcf_contacts(text: str) -> list[dict]:
    out = []
    for props in _blocks(_unfold(text), "VCARD"):
        emails, phones, urls, meta, fn, n, note = [], [], [], {}, "", "", ""
        for name, params, value, _depth in props:
            name = name.split(".", 1)[-1]  # vCard 2.1 groups: item1.EMAIL
            v = _unesc(value).strip()
            if name == "FN":
                fn = v
            elif name == "N":
                bits = [b.strip() for b in value.split(";")]
                n = " ".join(x for x in (bits[3] if len(bits) > 3 else "", bits[1] if len(bits) > 1 else "", bits[2] if len(bits) > 2 else "", bits[0]) if x)
            elif name == "EMAIL" and v:
                emails.append(v)
            elif name == "TEL" and v:
                phones.append(re.sub(r"^tel:", "", v))
            elif name == "ORG" and v:
                meta["company"] = _unesc(value.split(";")[0]).strip()[:120]
            elif name == "TITLE" and v:
                meta["role"] = v[:120]
            elif name == "ADR":
                bits = [_unesc(b).strip() for b in value.split(";")]
                loc = ", ".join(x for x in bits[2:7] if x) if len(bits) > 2 else v
                if loc and not meta.get("location"):
                    meta["location"] = loc[:200]
            elif name == "BDAY" and v:
                m = re.fullmatch(r"(\d{4})-?(\d{2})-?(\d{2})", v)
                meta["birthday"] = f"{m[1]}-{m[2]}-{m[3]}" if m else v[:40]
            elif name == "NICKNAME" and v:
                meta["aka"] = [x.strip() for x in v.split(",") if x.strip()][:10]
            elif name == "URL" and v:
                urls.append(v)
            elif name in ("X-PRONOUNS", "PRONOUNS") and v:
                meta["pronouns"] = v[:40]
            elif name == "NOTE" and v:
                note = v
            elif name == "UID" and v:
                meta["uid"] = v[:200]
        title = (fn or n).strip()
        if not title:
            continue
        if emails:
            meta["email"] = emails[0][:200]
            if len(emails) > 1:
                meta["emails"] = emails[:10]
        if phones:
            meta["phone"] = phones[0][:60]
            if len(phones) > 1:
                meta["phones"] = phones[:10]
        if urls:
            meta["urls"] = urls[:10]
        out.append({"kind": "contact", "title": title[:200], "body": note[:20000], "meta": meta})
    return out


# ── importing into the Codex ────────────────────────────────────────────────

def _rows(kind: str) -> list[dict]:
    with db.conn() as c:
        rows = c.execute("SELECT id, title, meta FROM codex_entries WHERE kind=? AND status IN ('ok','draft')", (kind,)).fetchall()
    return [{"id": r["id"], "title": r["title"], "meta": json.loads(r["meta"] or "{}")} for r in rows]


def _match(kind: str, fields: dict, existing: list[dict]) -> dict | None:
    uid = (fields["meta"].get("uid") or "").lower()
    if uid:
        for e in existing:
            if (e["meta"].get("uid") or "").lower() == uid or (e["id"] + "@shellb").lower() == uid:
                return e
    if kind == "contact":
        t = fields["title"].strip().lower()
        em = (fields["meta"].get("email") or "").lower()
        for e in existing:
            if e["title"].strip().lower() == t or (em and (e["meta"].get("email") or "").lower() == em):
                return e
    return None


def import_entries(kind: str, items: list[dict], collection: str | None = None) -> dict:
    import codex
    existing = _rows(kind)
    added = updated = 0
    for f in items:
        hit = _match(kind, f, existing)
        if hit:
            merged = {**hit["meta"], **{k: v for k, v in f["meta"].items() if v not in ("", None, [])}}
            merged.pop("index", None)
            codex.update(hit["id"], {"title": f["title"], "meta": merged, **({"body": f["body"]} if f.get("body") else {})})
            updated += 1
        else:
            if not f["meta"].get("uid"):
                f["meta"]["uid"] = f"{uuid.uuid4()}@shellb"
            e = codex.create({**f, "collectionId": collection}, created_by="import")
            existing.append({"id": e["id"], "title": e["title"], "meta": f["meta"]})
            added += 1
    return {"added": added, "updated": updated, "total": len(items)}


# ── reminders ───────────────────────────────────────────────────────────────

def due_reminders(now: datetime | None = None) -> list[tuple[dict, datetime]]:
    """Events whose next start is within their reminder window and not yet announced for that occurrence."""
    now = now or now_local()
    fired = db.kv_get("calendar_fired") or {}
    out = []
    for e in _rows("event"):
        m = e["meta"]
        rm = m.get("reminderMinutes")
        if not isinstance(rm, (int, float)) or m.get("status") == "cancelled":
            continue
        nxt = next_occurrence(m, now - timedelta(minutes=5))  # a start within the last minutes still counts once
        if not nxt:
            continue
        if now >= nxt - timedelta(minutes=int(rm)) and fired.get(e["id"]) != nxt.isoformat():
            out.append((e, nxt))
    return out


def fire_reminders(now: datetime | None = None) -> int:
    import activity
    now = now or now_local()
    fired = db.kv_get("calendar_fired") or {}
    n = 0
    for e, nxt in due_reminders(now):
        m = e["meta"]
        when = "all day" if m.get("allDay") else nxt.strftime("%H:%M")
        day = "today" if nxt.date() == now.date() else "tomorrow" if nxt.date() == now.date() + timedelta(days=1) else nxt.strftime("%a %b %d")
        where = f" · {m['location']}" if m.get("location") else ""
        activity.post("calendar", "due", f"{e['title']} · {day} {when}{where}", link=f"#/codex/e/{e['id']}", ref=f"cal:{e['id']}:{nxt.isoformat()}")
        fired[e["id"]] = nxt.isoformat()
        n += 1
    if n:
        keep = {eid for eid in (x["id"] for x in _rows("event"))}
        db.kv_set("calendar_fired", {k: v for k, v in fired.items() if k in keep})
    return n


async def _loop():
    await asyncio.sleep(60)
    while True:
        try:
            await asyncio.to_thread(fire_reminders)
        except Exception as e:  # noqa: BLE001
            print(f"calendar reminders: {type(e).__name__}: {e}")
        await asyncio.sleep(60)


def start():
    global _task
    if _task is None:
        _task = asyncio.create_task(_loop())


def stop():
    global _task
    if _task:
        _task.cancel()
        _task = None


# ── routes ──────────────────────────────────────────────────────────────────

def _owner(req: Request):
    import auth
    if not (auth.is_owner(req) or auth.is_admin(req) or req.scope.get("shellb_auth") == "local"):
        raise HTTPException(401, "login-required")


def _full(kind: str, collection: str | None = None) -> list[dict]:
    import codex
    return [codex.get(r["id"], full=True) for r in _rows(kind)
            if not collection or (codex.get(r["id"]) or {}).get("collectionId") == collection]


@router.get("/calendar.ics")
def api_calendar_ics(req: Request, collection: str = ""):
    _owner(req)
    z = tz()
    body = calendar_ics(_full("event", collection or None), z.key if z else None)
    return Response(body, media_type="text/calendar; charset=utf-8",
                    headers={"Content-Disposition": 'attachment; filename="shellb-calendar.ics"'})


@router.get("/contacts.vcf")
def api_contacts_vcf(req: Request):
    _owner(req)
    return Response(contacts_vcf(_full("contact")), media_type="text/vcard; charset=utf-8",
                    headers={"Content-Disposition": 'attachment; filename="shellb-contacts.vcf"'})


async def _texts(files: list[UploadFile]) -> list[str]:
    out = []
    for f in files:
        data = await f.read()
        if len(data) > MAX_IMPORT:
            raise HTTPException(413, f"{f.filename}: files over {MAX_IMPORT // 2**20} MB can't be imported here.")
        out.append(data.decode("utf-8-sig", errors="replace"))
    return out


@router.post("/import/ics")
async def api_import_ics(req: Request, files: list[UploadFile] = File(...), collection: str = ""):
    _owner(req)
    items = [ev for text in await _texts(files) for ev in ics_events(text, tz())]
    if not items:
        raise HTTPException(400, "No events found. Export a .ics file from your calendar app and upload that.")
    return await asyncio.to_thread(import_entries, "event", items, collection or None)


@router.post("/import/vcf")
async def api_import_vcf(req: Request, files: list[UploadFile] = File(...), collection: str = ""):
    _owner(req)
    items = [c for text in await _texts(files) for c in vcf_contacts(text)]
    if not items:
        raise HTTPException(400, "No contacts found. Export a .vcf file from your contacts app and upload that.")
    return await asyncio.to_thread(import_entries, "contact", items, collection or None)
