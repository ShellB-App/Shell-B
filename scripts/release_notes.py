#!/usr/bin/env python3
"""Render release notes from docs/changelog.json.

Entries newer than the previous release tag (the newest v* tag that is not the one being released) are grouped by
area, newest first, as Markdown on stdout. Standard library + git only.

    scripts/release_notes.py                      # notes for everything since the latest tag
    scripts/release_notes.py --tag v2026.10.11    # notes for this tag (entries after the tag before it)
    scripts/release_notes.py --since 2026-10-06   # entries on or after a date, ignoring tags
"""
import argparse
import json
import subprocess
import sys
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHANGELOG = ROOT / "docs" / "changelog.json"


def git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, check=False).stdout.strip()


def tag_date(tag: str) -> date | None:
    out = git("log", "-1", "--format=%cI", tag)
    return datetime.fromisoformat(out).astimezone(timezone.utc).date() if out else None


def previous_tag(current: str | None) -> str | None:
    tags = [t for t in git("tag", "--list", "v*", "--sort=-creatordate").splitlines() if t and t != current]
    return tags[0] if tags else None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tag", help="the tag being released")
    ap.add_argument("--since", help="YYYY-MM-DD: include entries on or after this date instead of using tags")
    a = ap.parse_args()

    entries = json.loads(CHANGELOG.read_text())
    prev = None if a.since else previous_tag(a.tag)
    if a.since:
        floor, strict = date.fromisoformat(a.since), False
    elif prev and (d := tag_date(prev)):
        floor, strict = d, True          # entries dated after the previous tag's day
    else:
        floor, strict = date.min, False  # first release: everything

    picked = [e for e in entries if (date.fromisoformat(e["date"]) > floor if strict else date.fromisoformat(e["date"]) >= floor)]
    if not picked:
        print(f"No changelog entries since {prev or floor}.", file=sys.stderr)
        return 1

    areas: dict[str, list[dict]] = {}
    for e in picked:
        areas.setdefault(e.get("area") or "Other", []).append(e)

    title = a.tag or "Unreleased"
    span = f"{picked[-1]['date']} to {picked[0]['date']}" if picked[-1]["date"] != picked[0]["date"] else picked[0]["date"]
    print(f"## Shell:B {title}\n")
    print(f"{len(picked)} changes, {span}" + (f", since {prev}." if prev else ".") + "\n")
    for area, items in sorted(areas.items(), key=lambda kv: (-len(kv[1]), kv[0])):
        print(f"### {area}\n")
        for e in items:
            print(f"- **{e['title']}** ({e['date']})  \n  {e['summary']}")
        print()
    print("Full detail: [docs/changelog.json](docs/changelog.json), also under Settings → Changelog in the app.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
