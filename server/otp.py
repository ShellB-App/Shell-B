"""One-time codes shared by the owner login (auth.py) and guest accounts (guest_accounts.py): TOTP (RFC 6238, SHA-1,
6 digits, 30 s) and single-use recovery codes. Stdlib only. Codes are accepted from the step before, the current one
and the one after, and never a step at or before the last one accepted, so a code can't be replayed."""
import base64
import hashlib
import hmac
import re
import secrets
import struct
import time
from urllib.parse import quote

STEP = 30
RECOVERY_COUNT = 10
RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"  # no 0/o, 1/i/l


def new_secret() -> str:
    return base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")


def _key(secret: str) -> bytes:
    return base64.b32decode(secret + "=" * (-len(secret) % 8))


def totp(secret: str, counter: int) -> str:
    mac = hmac.new(_key(secret), struct.pack(">Q", counter), hashlib.sha1).digest()
    o = mac[-1] & 15
    return f"{(struct.unpack('>I', mac[o:o + 4])[0] & 0x7FFFFFFF) % 1_000_000:06d}"


def step_for(secret: str, code: str, last: int, now: float | None = None) -> int | None:
    """The time step this code belongs to (the one before, now, or the one after), never one already used."""
    code = re.sub(r"\s+", "", str(code or ""))
    if not re.fullmatch(r"\d{6}", code):
        return None
    t = int((now or time.time()) // STEP)
    for step in (t - 1, t, t + 1):
        if step > (last or 0) and hmac.compare_digest(totp(secret, step), code):
            return step
    return None


def uri(issuer: str, account: str, secret: str) -> str:
    label = quote(f"{issuer}:{account}")
    return f"otpauth://totp/{label}?secret={secret}&issuer={quote(issuer)}&algorithm=SHA1&digits=6&period={STEP}"


def norm_recovery(code: str) -> str:
    return re.sub(r"[\s-]+", "", str(code or "")).lower()


def sha(code: str) -> str:
    return hashlib.sha256(code.strip().encode()).hexdigest()


def new_recovery_codes(n: int = RECOVERY_COUNT) -> list[str]:
    """Human-readable codes (`xxxxx-xxxxx`); store sha(norm_recovery(code)) and compare the same way."""
    return ["".join(secrets.choice(RECOVERY_ALPHABET) for _ in range(10)) for _ in range(n)]


def pretty(code: str) -> str:
    return f"{code[:5]}-{code[5:]}"
