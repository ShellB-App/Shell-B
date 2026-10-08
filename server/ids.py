"""ID checks for anything that becomes a folder name under data/.

IDs come from db.new_id: a prefix, a dash and 12 hex digits. Routes take them from the URL, so a folder helper checks
the shape before it joins the ID onto a path. The middleware already refuses `.`/`..` segments (auth._bad_path); this
is the second line, for IDs that reach a helper some other way (a tool argument, a JSON body).
"""
import re

from fastapi import HTTPException

PATTERNS = {
    "project": re.compile(r"^proj-[0-9a-f]{12}$"),
    "board": re.compile(r"^rb-[0-9a-f]{12}$"),
    "assetlib": re.compile(r"^alib-[0-9a-f]{12}$"),
}


def valid(kind: str, value) -> bool:
    return isinstance(value, str) and bool(PATTERNS[kind].match(value))


def check(kind: str, value, what: str = "") -> str:
    """The ID itself, or a 404 (the same answer as for an unknown ID, so probing learns nothing)."""
    if not valid(kind, value):
        raise HTTPException(404, f"No such {what or kind}")
    return value
