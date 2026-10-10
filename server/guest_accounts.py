"""Shell:B Guest accounts: usernames and passwords, optional two-step codes, lockouts, reset links and a sign-in log.

Accounts belong to the gateway, the host-side guest app (guest_app.py on the guest port). Nothing a guest turn can
reach reads these columns, and the per-guest containers planned in docs/plans/guest-cells.md never see a password:
the gateway signs the guest in, then forwards.

- **Sign-up is by invite only.** The owner's invite link (/#invite=CODE) opens "Create your account". The code is
  spent only when the account is made, so a rejected password doesn't burn it. There is no open registration. A
  guest from before accounts existed keeps their signed-in devices, but must choose a username and password before
  anything else works (guest_app's wall).
- **Passwords:** at least 10 characters, not a common or guessable one, hashed with scrypt like the owner's
  (auth._hash). Hashing runs on its own two threads, so a burst of sign-ins never stalls the owner's event loop or
  takes the thread pool her own work uses.
- **Wrong passwords and codes:** 10 per address per 15 minutes (guests._throttle, kept apart from the owner's login
  counters). An account locks for 15 minutes after 8 failures in a row, and that posts to the owner's Activity.
  Every failure waits 0.5 s. Unknown usernames cost a hash too, so timing doesn't tell which accounts exist.
- **Two-step (optional):** RFC 6238 codes (SHA-1, 6 digits, 30 s, ±1 step, a step never accepted twice) plus 10
  one-time recovery codes stored as hashes. Stdlib only.
- **Resets:** the owner makes a one-time reset link (24 h) in Settings → Guests, which signs the guest out
  everywhere, and passes it on or emails it (mailer.py). A guest with an address on the account can also ask for one
  at sign-in ("Forgot password?", forgot_password): same answer either way, no sign-out until the link is used. Two-step still applies after a reset; the owner can turn it
  off for a guest who lost their phone.
- **Sessions** (guests.py): 30 days from last use with "Remember me", 12 hours idle without. A device code can only
  be made from a session that proved the password (PASSWORD_VIAS).
- **Log:** guest_auth_log keeps sign-ins, failures, lockouts and password events for 90 days.
"""
import asyncio
import base64
import hashlib
import hmac
import re
import secrets
import sqlite3
import struct
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request

import auth
import db
import guests
import otp

admin_router = APIRouter(prefix="/api/guests")

MIN_PASSWORD = 10
MAX_PASSWORD = 256
USERNAME = re.compile(r"^[a-z0-9][a-z0-9._-]{2,31}$")
EMAIL = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s.]{2,}$")
LOCK_AFTER = 8
LOCK_FOR = 15 * 60
RESET_TTL = 24 * 3600
TICKET_TTL = 5 * 60
TICKET_TRIES = 5
SETUP_TTL = 15 * 60
LOG_DAYS = 90
RECOVERY_COUNT = 10
RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"  # no 0/o, 1/i/l
TOTP_STEP = 30
ISSUER = "Shell:B Guest"
PASSWORD_VIAS = ("password", "signup", "reset")  # sessions that proved the password; only these make device codes

# Passwords refused outright, and words that make a weak password with a few digits or symbols around them
COMMON = frozenset("""
1234567890 0123456789 0987654321 9876543210 12345678910 123456789012 1234567890a a1234567890 1111111111 0000000000
1q2w3e4r5t 1qaz2wsx3edc qwertyuiop qwertyuiop1 asdfghjkl1 zxcvbnm123 1234qwerasdf qwerty123456 123qweasdzxc
q1w2e3r4t5 abcd123456 abc1234567 a1b2c3d4e5 147258369 1478963250 1234554321 12341234 123123123123
""".split())
BASE_WORDS = ("password", "passwort", "motdepasse", "contraseña", "qwerty", "qwertz", "azerty", "qazwsx", "letmein",
              "welcome", "iloveyou", "admin", "administrator", "shellb", "guest", "evie", "login", "secret", "master",
              "hello", "monkey", "dragon", "football", "baseball", "soccer", "sunshine", "princess", "superman",
              "batman", "starwars", "trustno", "changeme", "default", "abc", "abcdef", "test", "user", "pokemon")
SEQUENCES = ("0123456789012345678901234567890", "abcdefghijklmnopqrstuvwxyzabcdefghij", "qwertyuiopasdfghjklzxcvbnm",
             "1qaz2wsx3edc4rfv5tgb6yhn7ujm", "qwertzuiopasdfghjklyxcvbnm", "azertyuiopqsdfghjklmwxcvbn")
LEET = str.maketrans("013457", "oieast")  # digits inside a word: p4ssw0rd
SYMBOLS = str.maketrans("@$!", "asi")

LABELS = {
    "signup": "Created the account", "signin": "Signed in", "signin_failed": "Wrong password",
    "twostep_failed": "Wrong two-step code", "locked": "Locked after too many wrong tries", "unlocked": "Unlocked by Evie",
    "password_set": "Chose a username and password", "password_changed": "Changed the password",
    "password_change_failed": "Wrong current password", "reset_issued": "Evie made a reset link", "reset_requested": "Asked for a reset email",
    "reset_used": "Reset the password", "twostep_on": "Turned on two-step sign-in",
    "twostep_off": "Turned off two-step sign-in", "twostep_off_owner": "Evie turned off two-step sign-in",
    "recovery_used": "Signed in with a recovery code", "recovery_new": "Made new recovery codes",
    "device": "Signed in with a device code", "device_code": "Made a device code",
}

_DUMMY_SALT = secrets.token_bytes(16)
_hashing = ThreadPoolExecutor(2, thread_name_prefix="guest-scrypt")  # scrypt here takes 32 MB and ~0.1 s each
_logged = 0
_tickets: dict[str, dict] = {}  # password accepted, two-step code still to come: ticket → {gid, via, remember, ...}
_setup: dict[str, tuple[str, float]] = {}  # gid → (two-step secret being set up, when)


def init():
    """Schema for accounts; called from guests.init after the guests tables exist."""
    with db.conn() as c:
        cols = {r["name"] for r in c.execute("PRAGMA table_info(guests)")}
        for col, typ in (("username", "TEXT"), ("email", "TEXT"), ("pw_salt", "TEXT"), ("pw_hash", "TEXT"),
                         ("pw_set", "REAL"), ("totp_secret", "TEXT"), ("totp_on", "INTEGER DEFAULT 0"),
                         ("totp_last", "INTEGER DEFAULT 0"), ("failed", "INTEGER DEFAULT 0"),
                         ("locked_until", "REAL DEFAULT 0"), ("last_signin", "REAL")):
            if col not in cols:
                c.execute(f"ALTER TABLE guests ADD COLUMN {col} {typ}")
        cols = {r["name"] for r in c.execute("PRAGMA table_info(guest_sessions)")}
        if "via" not in cols:  # how the device signed in; sessions from before accounts were invites
            c.execute("ALTER TABLE guest_sessions ADD COLUMN via TEXT DEFAULT 'invite'")
        if "remember" not in cols:
            c.execute("ALTER TABLE guest_sessions ADD COLUMN remember INTEGER DEFAULT 1")
        c.executescript("""
CREATE UNIQUE INDEX IF NOT EXISTS guests_username ON guests(username);
CREATE TABLE IF NOT EXISTS guest_recovery(guest_id TEXT, hash TEXT, created REAL, used REAL, PRIMARY KEY(guest_id, hash));
CREATE TABLE IF NOT EXISTS guest_auth_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT, guest_id TEXT, ts REAL, event TEXT, ip TEXT, ua TEXT, detail TEXT);
CREATE INDEX IF NOT EXISTS guest_auth_log_guest ON guest_auth_log(guest_id, ts);
""")
        c.execute("DELETE FROM guest_auth_log WHERE ts < ?", (time.time() - LOG_DAYS * 86400,))


# ── small helpers ───────────────────────────────────────────────────────────

def _row(gid: str):
    with db.conn() as c:
        return c.execute("SELECT * FROM guests WHERE id=?", (gid,)).fetchone()


def _by_username(username: str):
    with db.conn() as c:
        return c.execute("SELECT * FROM guests WHERE username=?", (username,)).fetchone()


def _ip(req: Request) -> str:
    return auth._client_ip(req.scope)


def log(gid: str, event: str, req: Request | None = None, detail: str = ""):
    global _logged
    _logged += 1
    with db.conn() as c:
        c.execute("INSERT INTO guest_auth_log(guest_id, ts, event, ip, ua, detail) VALUES(?,?,?,?,?,?)",
                  (gid, time.time(), event, _ip(req) if req else "",
                   (req.headers.get("user-agent") or "")[:200] if req else "", detail[:200]))
        if _logged % 200 == 0:
            c.execute("DELETE FROM guest_auth_log WHERE ts < ?", (time.time() - LOG_DAYS * 86400,))


def auth_log(gid: str, limit: int = 100) -> list[dict]:
    with db.conn() as c:
        rows = c.execute("SELECT * FROM guest_auth_log WHERE guest_id=? AND ts > ? ORDER BY ts DESC LIMIT ?",
                         (gid, time.time() - LOG_DAYS * 86400, max(1, min(limit, 500)))).fetchall()
    return [{"ts": r["ts"], "event": r["event"], "label": LABELS.get(r["event"], r["event"]), "ip": r["ip"],
             "userAgent": r["ua"], "detail": r["detail"]} for r in rows]


def clean_username(value) -> str:
    u = str(value or "").strip().lower()
    if not USERNAME.match(u):
        raise HTTPException(400, "Usernames are 3 to 32 characters: letters, digits, dots, dashes or underscores, "
                                 "starting with a letter or digit.")
    return u


def clean_email(value) -> str | None:
    e = str(value or "").strip()
    if not e:
        return None
    if len(e) > 254 or not EMAIL.match(e):
        raise HTTPException(400, "That email address doesn't look right. It's optional: leave it empty if you like.")
    return e


def password_problem(password: str, username: str = "") -> str | None:
    """Why this password won't do, or None."""
    if len(password) < MIN_PASSWORD:
        return f"Use at least {MIN_PASSWORD} characters."
    if len(password) > MAX_PASSWORD:
        return f"Use at most {MAX_PASSWORD} characters."
    low = password.lower()
    if low in COMMON or len(set(low)) < 4 or any(low in s or low[::-1] in s for s in SEQUENCES):
        return "That password is too easy to guess. A few unrelated words make a strong one."
    # the letters left once digits and symbols are gone, read plainly and with look-alikes undone
    leet = re.sub(r"(?<=[a-z])\d+(?=[a-z])", lambda m: m.group().translate(LEET), low.translate(SYMBOLS))
    cores = {re.sub(r"[^a-zß-ÿ]", "", low), re.sub(r"[^a-zß-ÿ]", "", leet)}
    own = re.sub(r"[^a-z]", "", username.lower())
    for word in BASE_WORDS + ((own,) if own else ()):
        if any(core.startswith(word) or core.endswith(word) for core in cores if len(core) - len(word) < 4):
            return ("Don't build your password from your username." if word == own
                    else "That password is too easy to guess. A few unrelated words make a strong one.")
    return None


def _check_password(password, username: str = ""):
    if not isinstance(password, str):
        raise HTTPException(400, "Enter a password.")
    problem = password_problem(password, username)
    if problem:
        raise HTTPException(400, problem)


async def _hash(password: str, salt: bytes) -> str:
    return await asyncio.get_running_loop().run_in_executor(_hashing, auth._hash, password[:MAX_PASSWORD], salt)


async def _password_ok(row, password) -> bool:
    """Constant work whether or not the account (or its password) exists."""
    password = password if isinstance(password, str) else ""
    have = row is not None and row["pw_hash"] and row["pw_salt"]
    got = await _hash(password, bytes.fromhex(row["pw_salt"]) if have else _DUMMY_SALT)
    return bool(have) and bool(password) and hmac.compare_digest(got, row["pw_hash"])


async def _store_password(gid: str, password: str, extra: str = "", args: tuple = ()):
    salt = secrets.token_bytes(16)
    digest = await _hash(password, salt)
    with db.conn() as c:
        c.execute(f"UPDATE guests SET pw_salt=?, pw_hash=?, pw_set=?, failed=0, locked_until=0{extra} WHERE id=?",
                  (salt.hex(), digest, time.time(), *args, gid))


def _locked_for(row) -> int:
    return max(0, int((row["locked_until"] or 0) - time.time()))


def _locked_error(row) -> HTTPException:
    mins = max(1, -(-_locked_for(row) // 60))
    return HTTPException(429, f"Too many wrong tries, so this account is locked for {mins} more minute"
                              f"{'' if mins == 1 else 's'}. Evie can unlock it sooner.",
                         headers={"Retry-After": str(_locked_for(row) or 60)})


def _ip_failed(req: Request):
    guests._codes_tried.setdefault(_ip(req), []).append(time.time())


async def _failed(row, req: Request, event: str):
    """A wrong password or code for this account: count it, lock the account at LOCK_AFTER, and wait a moment."""
    _ip_failed(req)
    gid = row["id"]
    with db.conn() as c:
        c.execute("UPDATE guests SET failed=coalesce(failed, 0) + 1 WHERE id=?", (gid,))
        n = c.execute("SELECT failed FROM guests WHERE id=?", (gid,)).fetchone()["failed"]
        if n >= LOCK_AFTER:  # the count starts over once the lock ends
            c.execute("UPDATE guests SET failed=0, locked_until=? WHERE id=?", (time.time() + LOCK_FOR, gid))
    log(gid, event, req)
    if n >= LOCK_AFTER:
        log(gid, "locked", req)
        _drop_tickets(gid)
        import activity
        activity.post("guest", "warning", f"{row['name']}'s guest account is locked",
                      f"{LOCK_AFTER} wrong passwords or two-step codes in a row, the last from {_ip(req)}. It unlocks "
                      f"by itself in {LOCK_FOR // 60} minutes. Tools & Connectors → Guests can unlock it now or make a "
                      "reset link.", "#/activity", ref=f"glock-{gid}-{int(time.time())}")
    await asyncio.sleep(0.5)


def _drop_tickets(gid: str):
    for t, v in list(_tickets.items()):
        if v["gid"] == gid:
            _tickets.pop(t, None)


def _signed_in(row, req: Request, via: str, remember: bool) -> dict:
    with db.conn() as c:
        c.execute("UPDATE guests SET failed=0, last_signin=? WHERE id=?", (time.time(), row["id"]))
    log(row["id"], "device" if via == "device" else "signin", req, via)
    return {"token": guests.new_session(row["id"], req, via=via, remember=remember), "guest": guests.get_guest(row["id"]),
            "remember": remember}


def _after_password(row, req: Request, via: str, remember: bool) -> dict:
    """The password was right: a session, or a ticket for the two-step code."""
    if row["disabled"]:
        raise HTTPException(403, "Evie has paused this account. Ask her to turn it back on.")
    if row["totp_on"]:
        now = time.time()
        for t, v in list(_tickets.items()):
            if v["expires"] < now:
                _tickets.pop(t, None)
        ticket = secrets.token_urlsafe(24)
        _tickets[ticket] = {"gid": row["id"], "via": via, "remember": remember, "expires": now + TICKET_TTL, "tries": 0}
        return {"ticket": ticket}
    return _signed_in(row, req, via, remember)


def _code_row(code: str, kinds: tuple[str, ...]):
    code = str(code or "").strip()
    if not code or len(code) > 64:
        return None
    with db.conn() as c:
        return c.execute(f"SELECT * FROM guest_codes WHERE hash=? AND kind IN ({','.join('?' * len(kinds))}) AND expires > ?",
                         (guests._sha(code), *kinds, time.time())).fetchone()


def _spend(code_hash: str) -> bool:
    with db.conn() as c:
        return c.execute("DELETE FROM guest_codes WHERE hash=?", (code_hash,)).rowcount > 0


# ── two-step codes ──────────────────────────────────────────────────────────

def totp(secret: str, counter: int) -> str:
    return otp.totp(secret, counter)


def _totp_step(secret: str, code: str, last: int, now: float | None = None) -> int | None:
    """The time step this code belongs to (the one before, now, or the one after), never one already used."""
    return otp.step_for(secret, code, last, now)


def _norm_recovery(code: str) -> str:
    return re.sub(r"[\s-]+", "", str(code or "")).lower()


def _new_recovery(gid: str) -> list[str]:
    codes = ["".join(secrets.choice(RECOVERY_ALPHABET) for _ in range(10)) for _ in range(RECOVERY_COUNT)]
    now = time.time()
    with db.conn() as c:
        c.execute("DELETE FROM guest_recovery WHERE guest_id=?", (gid,))
        c.executemany("INSERT INTO guest_recovery VALUES(?,?,?,NULL)",
                      [(gid, guests._sha(x), now) for x in codes])
    return [f"{x[:5]}-{x[5:]}" for x in codes]


def _use_recovery(gid: str, code: str) -> bool:
    with db.conn() as c:
        return c.execute("UPDATE guest_recovery SET used=? WHERE guest_id=? AND hash=? AND used IS NULL",
                         (time.time(), gid, guests._sha(_norm_recovery(code)))).rowcount > 0


def recovery_left(gid: str) -> int:
    with db.conn() as c:
        return c.execute("SELECT count(*) FROM guest_recovery WHERE guest_id=? AND used IS NULL", (gid,)).fetchone()[0]


def _clear_two_step(gid: str):
    with db.conn() as c:
        c.execute("UPDATE guests SET totp_on=0, totp_secret=NULL, totp_last=0 WHERE id=?", (gid,))
        c.execute("DELETE FROM guest_recovery WHERE guest_id=?", (gid,))
    _setup.pop(gid, None)
    _drop_tickets(gid)


# ── signing in (guest side, no session needed) ──────────────────────────────

async def sign_in(req: Request, username, password, remember: bool) -> dict:
    guests._throttle(_ip(req))
    uname = str(username or "").strip().lower()
    row = _by_username(uname) if USERNAME.match(uname) else None
    if row is not None and _locked_for(row):
        await asyncio.sleep(0.5)
        raise _locked_error(row)
    if not await _password_ok(row, password):
        if row is not None:
            await _failed(row, req, "signin_failed")
        else:
            _ip_failed(req)
            await asyncio.sleep(0.5)
        raise HTTPException(401, "Wrong username or password.")
    return _after_password(row, req, "password", remember)


async def second_step(req: Request, ticket, code) -> dict:
    guests._throttle(_ip(req))
    t = _tickets.get(str(ticket or ""))
    if not t or t["expires"] < time.time():
        _tickets.pop(str(ticket or ""), None)
        raise HTTPException(401, "That sign-in timed out. Enter your password again.")
    row = _row(t["gid"])
    if row is None or row["disabled"] or not row["totp_on"]:
        _tickets.pop(ticket, None)
        raise HTTPException(401, "That sign-in timed out. Enter your password again.")
    if _locked_for(row):
        _tickets.pop(ticket, None)
        raise _locked_error(row)
    code = re.sub(r"[\s-]+", "", str(code or "")).lower()
    ok, recovery = False, False
    if re.fullmatch(r"\d{6}", code):
        step = _totp_step(row["totp_secret"], code, row["totp_last"])
        if step is not None:
            with db.conn() as c:  # only one request can spend a step, however many race for it
                ok = c.execute("UPDATE guests SET totp_last=? WHERE id=? AND coalesce(totp_last, 0) < ?",
                               (step, row["id"], step)).rowcount > 0
    elif len(code) == 10:
        ok = recovery = _use_recovery(row["id"], code)
    if not ok:
        t["tries"] += 1
        if t["tries"] >= TICKET_TRIES:
            _tickets.pop(ticket, None)
        await _failed(row, req, "twostep_failed")
        raise HTTPException(401, "That code didn't work. Codes change every 30 seconds: try the newest one."
                            if t["tries"] < TICKET_TRIES else "That code didn't work. Enter your password again.")
    _tickets.pop(ticket, None)
    if recovery:
        log(row["id"], "recovery_used", req, f"{recovery_left(row['id'])} left")
    return _signed_in(row, req, t["via"], t["remember"])


async def code_info(req: Request, code) -> dict:
    """What an invite or reset link is for, without spending it (the sign-up and reset forms show the name)."""
    guests._throttle(_ip(req))
    r = _code_row(code, ("invite", "reset"))
    g = guests.get_guest(r["guest_id"]) if r else None
    if not g or g["disabled"]:
        _ip_failed(req)
        await asyncio.sleep(0.5)
        raise HTTPException(401, "That link didn't work. It may have expired or been used already: ask Evie for a new one.")
    if r["kind"] == "invite" and g["passwordSet"]:
        return {"kind": "signin", "name": g["name"], "username": g["username"]}
    return {"kind": r["kind"], "name": g["name"], "username": g["username"] if r["kind"] == "reset" else None}


async def signup(req: Request, code, username, password, email, remember: bool) -> dict:
    """Spend an invite on a new account (or on an existing invite-only guest's first password) and sign in."""
    guests._throttle(_ip(req))
    r = _code_row(code, ("invite",))
    g = guests.get_guest(r["guest_id"]) if r else None
    if not g or g["disabled"]:
        _ip_failed(req)
        await asyncio.sleep(0.5)
        raise HTTPException(401, "That invite didn't work. It may have expired or been used already: ask Evie for a new one.")
    if g["passwordSet"]:
        raise HTTPException(409, "This invite's account already exists. Sign in with its username and password.")
    uname = clean_username(username)
    _check_password(password, uname)
    mail = clean_email(email)
    if _by_username(uname) is not None:
        raise HTTPException(409, "That username is taken. Try another.")
    if not _spend(r["hash"]):
        raise HTTPException(401, "That invite was just used. Ask Evie for a new one.")
    try:
        await _store_password(g["id"], password, ", username=?, email=?", (uname, mail))
    except sqlite3.IntegrityError:
        with db.conn() as c:  # someone took the name in the meantime: give the invite back
            c.execute("INSERT OR IGNORE INTO guest_codes VALUES(?,?,?,?,?)", (r["hash"], g["id"], "invite", r["created"], r["expires"]))
        raise HTTPException(409, "That username is taken. Try another.")
    log(g["id"], "signup", req, uname)
    return _signed_in(_row(g["id"]), req, "signup", remember)


async def reset(req: Request, code, password, remember: bool) -> dict:
    """Spend a reset link on a new password. Every other device is signed out; two-step still applies."""
    guests._throttle(_ip(req))
    r = _code_row(code, ("reset",))
    row = _row(r["guest_id"]) if r else None
    if row is None:
        _ip_failed(req)
        await asyncio.sleep(0.5)
        raise HTTPException(401, "That reset link didn't work. It may have expired or been used already: ask Evie for a new one.")
    _check_password(password, row["username"] or "")
    if row["disabled"]:
        raise HTTPException(403, "Evie has paused this account. Ask her to turn it back on.")
    if not _spend(r["hash"]):
        raise HTTPException(401, "That reset link was just used. Ask Evie for a new one.")
    await _store_password(row["id"], password)
    guests.sign_out(row["id"])
    _drop_tickets(row["id"])
    log(row["id"], "reset_used", req)
    return _after_password(_row(row["id"]), req, "reset", remember)


# ── the signed-in guest's own account ───────────────────────────────────────

def account(g: dict, sess: dict) -> dict:
    return {"username": g["username"], "email": g["email"], "name": g["name"], "passwordSet": g["passwordSet"],
            "twoStep": g["twoStep"], "recoveryLeft": recovery_left(g["id"]) if g["twoStep"] else 0,
            "deviceCodes": sess.get("via") in PASSWORD_VIAS, "log": auth_log(g["id"], 30)}


def update_profile(g: dict, body: dict) -> dict:
    name = " ".join(str(body.get("name") or "").split())[:60] if "name" in body else g["name"]
    mail = clean_email(body.get("email")) if "email" in body else g["email"]
    with db.conn() as c:
        c.execute("UPDATE guests SET name=?, email=? WHERE id=?", (name or g["name"], mail, g["id"]))
    return guests.get_guest(g["id"])


async def create_for_session(req: Request, g: dict, sess: dict, username, password, email):
    """An invite-only guest (from before accounts) chooses a username and password on a device that's signed in."""
    if g["passwordSet"]:
        raise HTTPException(409, "You already have a password. Change it under Account.")
    uname = clean_username(username)
    _check_password(password, uname)
    mail = clean_email(email)
    if _by_username(uname) is not None:
        raise HTTPException(409, "That username is taken. Try another.")
    try:
        await _store_password(g["id"], password, ", username=?, email=?", (uname, mail))
    except sqlite3.IntegrityError:
        raise HTTPException(409, "That username is taken. Try another.")
    with db.conn() as c:
        c.execute("UPDATE guest_sessions SET via='password' WHERE id=?", (sess["id"],))
    log(g["id"], "password_set", req, uname)


async def _confirm(req: Request, g: dict, password, event: str = "password_change_failed"):
    """The current password, for changes that need it. Wrong ones count toward the lockout like a sign-in."""
    row = _row(g["id"])
    if _locked_for(row):
        raise _locked_error(row)
    if not await _password_ok(row, password):
        await _failed(row, req, event)
        raise HTTPException(403, "Your current password isn't right.")


async def change_password(req: Request, g: dict, sess: dict, current, new):
    guests._throttle(_ip(req))
    await _confirm(req, g, current)
    _check_password(new, g["username"] or "")
    await _store_password(g["id"], new)
    guests.sign_out(g["id"], keep=sess["id"])
    _drop_tickets(g["id"])
    with db.conn() as c:
        c.execute("UPDATE guest_sessions SET via='password' WHERE id=?", (sess["id"],))
    log(g["id"], "password_changed", req)


async def two_step_begin(req: Request, g: dict, password) -> dict:
    guests._throttle(_ip(req))
    if not g["passwordSet"]:
        raise HTTPException(409, "Choose a password first.")
    await _confirm(req, g, password)
    secret = base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")
    _setup[g["id"]] = (secret, time.time())
    label = quote(f"{ISSUER}:{g['username']}")
    return {"secret": secret, "uri": f"otpauth://totp/{label}?secret={secret}&issuer={quote(ISSUER)}"
                                     f"&algorithm=SHA1&digits=6&period={TOTP_STEP}"}


def two_step_enable(req: Request, g: dict, code) -> list[str]:
    pending = _setup.get(g["id"])
    if not pending or time.time() - pending[1] > SETUP_TTL:
        raise HTTPException(409, "Setup timed out. Start again.")
    step = _totp_step(pending[0], re.sub(r"\s+", "", str(code or "")), 0)
    if step is None:
        _ip_failed(req)
        raise HTTPException(400, "That code doesn't match. Check the phone's clock, then enter the newest code.")
    with db.conn() as c:
        c.execute("UPDATE guests SET totp_secret=?, totp_on=1, totp_last=? WHERE id=?", (pending[0], step, g["id"]))
    _setup.pop(g["id"], None)
    log(g["id"], "twostep_on", req)
    return _new_recovery(g["id"])


async def two_step_disable(req: Request, g: dict, password):
    guests._throttle(_ip(req))
    await _confirm(req, g, password)
    _clear_two_step(g["id"])
    log(g["id"], "twostep_off", req)


async def new_recovery_codes(req: Request, g: dict, password) -> list[str]:
    guests._throttle(_ip(req))
    if not g["twoStep"]:
        raise HTTPException(409, "Turn on two-step sign-in first.")
    await _confirm(req, g, password)
    log(g["id"], "recovery_new", req)
    return _new_recovery(g["id"])


# ── owner side (/api/guests/{gid}/…, admin only) ────────────────────────────

def reset_link(gid: str, sign_out: bool = True) -> str:
    """A one-time reset link. The owner's signs the guest out at once; a self-service one (forgot_password) doesn't,
    or anyone who knows a username could sign that guest out. Using the link signs out every other device anyway."""
    code = secrets.token_urlsafe(18)
    with db.conn() as c:
        c.execute("DELETE FROM guest_codes WHERE guest_id=? AND kind='reset'", (gid,))
        c.execute("INSERT INTO guest_codes VALUES(?,?,?,?,?)",
                  (guests._sha(code), gid, "reset", time.time(), time.time() + RESET_TTL))
    if sign_out:
        guests.sign_out(gid)
        _drop_tickets(gid)
    log(gid, "reset_issued" if sign_out else "reset_requested")
    base = guests.settings()["url"]
    return f"{base}/#reset={code}" if base else f"#reset={code}"


# ── email (mailer.py): links the owner sends, and "Forgot password?" ────────

FORGOT_PER_IP = 5           # requests per address per hour
FORGOT_EVERY = 15 * 60      # at most one reset email per account this often
_forgot_ip: dict[str, list[float]] = {}
_forgot_sent: dict[str, float] = {}


def _mail(to: str, subject: str, lines: list[str]):
    import mailer
    mailer.send_later("guest", to, subject, "\n".join(lines + ["", "— Shell:B"]))


def _lang(g: dict) -> str:
    return (g.get("config") or {}).get("language", "") or ""


def mail_invite(g: dict, to: str, link: str):
    if _lang(g) == "fr":
        _mail(to, "Votre invitation à Shell:B", [
            f"Bonjour {g['name']},", "", "Evie vous invite sur Shell:B, son espace d'IA privé.",
            "Ouvrez ce lien pour choisir un nom d'utilisateur et un mot de passe (il fonctionne une fois et expire dans 7 jours) :",
            "", link, "", "Si vous n'attendiez pas ce message, vous pouvez l'ignorer."])
        return
    _mail(to, "Your invite to Shell:B", [
        f"Hi {g['name']},", "", "Evie invited you to Shell:B, her private AI workspace.",
        "Open this link to choose a username and password (it works once and expires in 7 days):", "", link, "",
        "If you weren't expecting this, you can ignore it."])


def mail_reset(g: dict, link: str, requested: bool):
    if _lang(g) == "fr":
        why = "Quelqu'un (vous, espérons-le) a demandé à réinitialiser votre mot de passe Shell:B." if requested \
            else "Evie a créé un lien de réinitialisation du mot de passe pour votre compte Shell:B."
        _mail(g["email"], "Réinitialisez votre mot de passe Shell:B", [
            f"Bonjour {g['name']},", "", why,
            "Ouvrez ce lien pour choisir un nouveau mot de passe (il fonctionne une fois et expire dans 24 heures) :",
            "", link, "", "L'utiliser vous déconnecte de vos autres appareils. La connexion en deux étapes reste en place.",
            "Si vous n'êtes pas à l'origine de cette demande, ignorez ce message : votre mot de passe reste le même."])
        return
    why = "Someone (hopefully you) asked to reset your Shell:B password." if requested \
        else "Evie made a password reset link for your Shell:B account."
    _mail(g["email"], "Reset your Shell:B password", [
        f"Hi {g['name']},", "", why, "Open this link to choose a new password (it works once and expires in 24 hours):",
        "", link, "", "Using it signs you out on your other devices. Two-step sign-in still applies.",
        "If you didn't ask for this, ignore it: your password stays the same."])


async def forgot_password(req: Request, who) -> dict:
    """Email a reset link to the account's address. Answers the same whether or not the account exists or has an
    address, so it can't be used to find accounts; rate limited per address and per account."""
    import mailer
    ip, now = _ip(req), time.time()
    tries = [t for t in _forgot_ip.get(ip, []) if now - t < 3600]
    if len(tries) >= FORGOT_PER_IP:
        raise HTTPException(429, "Too many requests. Try again later.", headers={"Retry-After": "900"})
    _forgot_ip[ip] = tries + [now]
    text = str(who or "").strip().lower()[:254]
    row = None
    if USERNAME.match(text):
        row = _by_username(text)
    elif mailer.valid_address(text):
        with db.conn() as c:
            row = c.execute("SELECT * FROM guests WHERE lower(email)=?", (text,)).fetchone()
    if row is not None and row["email"] and row["pw_set"] and not row["disabled"] and mailer.ready() \
            and now - _forgot_sent.get(row["id"], 0) > FORGOT_EVERY:
        _forgot_sent[row["id"]] = now
        g = guests.get_guest(row["id"])
        mail_reset(g, reset_link(row["id"], sign_out=False), requested=True)
    await asyncio.sleep(0.5)
    return {"ok": True, "message": "If that account has an email address, a reset link is on its way. "
                                   "No email? Ask Evie for a reset link."}


def _owned(gid: str, req: Request) -> dict:
    auth.require_admin(req)
    g = guests.get_guest(gid)
    if not g:
        raise HTTPException(404)
    return g


@admin_router.post("/{gid}/unlock")
def api_unlock(gid: str, req: Request):
    _owned(gid, req)
    with db.conn() as c:
        c.execute("UPDATE guests SET failed=0, locked_until=0 WHERE id=?", (gid,))
    log(gid, "unlocked")
    return guests.get_guest(gid)


@admin_router.post("/{gid}/reset")
def api_reset(gid: str, req: Request):
    g = _owned(gid, req)
    if not g["passwordSet"]:
        raise HTTPException(409, f"{g['name']} hasn't made an account yet. Send them an invite link instead.")
    return {"link": reset_link(gid), "expiresIn": RESET_TTL}


@admin_router.post("/{gid}/email-reset")
def api_email_reset(gid: str, req: Request):
    import mailer
    g = _owned(gid, req)
    if not g["passwordSet"]:
        raise HTTPException(409, f"{g['name']} hasn't made an account yet. Email them an invite instead.")
    if not mailer.valid_address(g["email"]):
        raise HTTPException(409, f"{g['name']} has no email address on their account.")
    if not mailer.ready():
        raise HTTPException(409, "Email isn't set up yet (Settings → Notifications → Email).")
    mail_reset(g, reset_link(gid), requested=False)
    return {"ok": True, "to": g["email"]}


@admin_router.post("/{gid}/email-invite")
async def api_email_invite(gid: str, req: Request):
    import mailer
    g = _owned(gid, req)
    if g["passwordSet"]:
        raise HTTPException(409, f"{g['name']} already has an account. Email a reset link instead.")
    to = mailer.valid_address((await req.json()).get("email"))
    if not to:
        raise HTTPException(400, "Enter the address to send the invite to.")
    if not mailer.ready():
        raise HTTPException(409, "Email isn't set up yet (Settings → Notifications → Email).")
    with db.conn() as c:  # it becomes the account's address, which the sign-up form shows and can change
        c.execute("UPDATE guests SET email=? WHERE id=?", (to, gid))
    mail_invite(g, to, guests.invite_link(guests.new_invite(gid)))
    return {"ok": True, "to": to}


@admin_router.post("/{gid}/two-step/off")
def api_two_step_off(gid: str, req: Request):
    _owned(gid, req)
    _clear_two_step(gid)
    log(gid, "twostep_off_owner")
    return guests.get_guest(gid)


@admin_router.get("/{gid}/log")
def api_log(gid: str, req: Request):
    _owned(gid, req)
    return auth_log(gid)
