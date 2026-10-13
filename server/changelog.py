"""Feature changelog (Settings → Changelog).

The source of truth is docs/changelog.json, a hand-kept list (newest first) of
{date: YYYY-MM-DD, area, title, summary, news?}. It is versioned with the web tree, so agents and the owner add an entry
in the same change that ships a feature. This module only serves it, so a bad edit shows up as an empty list
with an error note rather than a 500.

`news` is optional: one short, plain sentence for everyone, shown once on the What's new card of the new chat page
(onboarding.py). Give it only to changes a light user would notice and care about, and add its French to
ui/src/i18n/fr.json (tests/changelog_test.py checks).
"""
import json
from pathlib import Path

from fastapi import APIRouter

router = APIRouter()
FILE = Path(__file__).resolve().parent.parent / "docs" / "changelog.json"


def load() -> tuple[list[dict], str]:
    try:
        raw = json.loads(FILE.read_text(encoding="utf-8"))
        if not isinstance(raw, list):
            raise ValueError("expected a list")
    except Exception as e:  # missing file or bad JSON
        return [], f"{FILE.name}: {e}"
    out = []
    for e in raw:
        if isinstance(e, dict) and e.get("title") and e.get("date"):
            out.append({k: str(e.get(k, "")) for k in ("date", "area", "title", "summary", "news")})
    out.sort(key=lambda e: e["date"], reverse=True)  # stable, so same-day entries keep file order
    return out, ""


@router.get("/api/changelog")
def changelog():
    entries, error = load()
    return {"entries": entries, "error": error}
