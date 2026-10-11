"""Deep time for the agents: the prehistoric sites that Worlds shows (prehistory_sites.json, shared with
ui/src/maps/prehistory.ts), sea level at a date in the last 80,000 years, Earth's obliquity, and where the Sun rose or
set at the solstices and equinoxes for any place and year. Pure computation and a static list, so it works the same in a
guest's own Shell:B (cell) and needs no network.

The numbers match the Worlds layers: the sea-level curve is the one in ui/src/maps/deeptime.ts (a smoothed global mean
after Lambeck et al. 2014 and Spratt & Lisiecki 2016), obliquity is Laskar's polynomial, and bearings are for the
Sun's upper limb on a flat sea-level horizon with standard refraction."""
import json
import math
import unicodedata
from datetime import date
from functools import lru_cache
from pathlib import Path

SITES_FILE = Path(__file__).resolve().parent / "prehistory_sites.json"

# [years ago, metres relative to today]; keep in step with CURVE in ui/src/maps/deeptime.ts
CURVE = [
    (0, 0), (6000, -2), (7000, -4), (8000, -14), (9000, -25), (10000, -40), (11000, -52), (12000, -60), (13000, -68),
    (14000, -80), (14700, -100), (16000, -110), (18000, -120), (21000, -130), (26000, -125), (30000, -90), (40000, -80),
    (50000, -75), (60000, -85), (70000, -80), (80000, -60),
]
DEEP_MAX = CURVE[-1][0]

EVENTS = {
    "ws-rise": "winter solstice sunrise", "ws-set": "winter solstice sunset",
    "ss-rise": "summer solstice sunrise", "ss-set": "summer solstice sunset",
    "eq-rise": "equinox sunrise", "eq-set": "equinox sunset",
}
CAVE_KINDS = {"cave", "rockart", "shelter"}

# sea level marks worth naming when an agent asks about a date
SHORES = [
    (21000, "Last Glacial Maximum: Britain joined to Europe, Beringia links Siberia and Alaska, Sundaland and Sahul are dry, "
            "the Cosquer cave's entrance lies kilometres inland"),
    (12000, "end of the Ice Age: Doggerland still a wide plain in the southern North Sea; Beringia flooding"),
    (9000, "Doggerland shrinking; the land bridge across the Dover strait about to break"),
    (8000, "the Storegga slide tsunami (about 8,150 years ago) and the drowning of Doggerland's last islands"),
    (6000, "sea close to today's level; the age of Carnac and the first megaliths"),
]


@lru_cache(maxsize=1)
def sites() -> list[dict]:
    return json.loads(SITES_FILE.read_text(encoding="utf-8"))


def sea_level(years_ago: float) -> float:
    if years_ago <= 0:
        return 0.0
    for (y0, s0), (y1, s1) in zip(CURVE, CURVE[1:]):
        if years_ago <= y1:
            return s0 + (s1 - s0) * (years_ago - y0) / (y1 - y0)
    return float(CURVE[-1][1])


def obliquity(year: float) -> float:
    """Earth's axial tilt in degrees for a calendar year (negative = BC)."""
    t = (year - 2000) / 100
    return 23.439291 - 0.0130042 * t - 1.64e-7 * t * t + 5.04e-7 * t ** 3


def horizon_azimuth(lat: float, dec: float, rising: bool) -> float | None:
    """Bearing from north where the Sun's upper limb meets a flat horizon; None under polar day or night."""
    h = math.radians(-0.833)
    phi, d = math.radians(lat), math.radians(dec)
    c = (math.sin(d) - math.sin(phi) * math.sin(h)) / (math.cos(phi) * math.cos(h))
    if not -1 <= c <= 1:
        return None
    a = math.degrees(math.acos(c))
    return a if rising else 360 - a


def solar(lat: float, year: float, events=None) -> dict[str, float | None]:
    eps = obliquity(year)
    out = {}
    for ev in events or EVENTS:
        sign = 1 if ev.startswith("ss") else -1 if ev.startswith("ws") else 0
        az = horizon_azimuth(lat, sign * eps, ev.endswith("rise"))
        out[ev] = None if az is None else round(az, 1)
    return out


def destination(lat: float, lon: float, az: float, km: float) -> tuple[float, float]:
    d, th = km / 6371.0, math.radians(az)
    p1, l1 = math.radians(lat), math.radians(lon)
    p2 = math.asin(math.sin(p1) * math.cos(d) + math.cos(p1) * math.sin(d) * math.cos(th))
    l2 = l1 + math.atan2(math.sin(th) * math.sin(d) * math.cos(p1), math.cos(d) - math.sin(p1) * math.sin(p2))
    return round(math.degrees(p2), 5), round((math.degrees(l2) + 540) % 360 - 180, 5)


def distance_km(a_lat, a_lon, b_lat, b_lon) -> float:
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp, dl = p2 - p1, math.radians(b_lon - a_lon)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371 * math.asin(min(1, math.sqrt(h)))


def years_ago(site: dict) -> int:
    return 2000 - site["when"][0]


def fmt_when(site: dict) -> str:
    a = site["when"][0]
    b = site["when"][1] if len(site["when"]) > 1 and site["when"][1] is not None else None
    if a < -10000:
        r = lambda y: f"{round((2000 - y) / 1000) * 1000:,}"  # noqa: E731
        return f"about {r(a)}{'–' + r(b) if b is not None and r(b) != r(a) else ''} years ago"
    era = lambda y: "BC" if y < 0 else "AD"  # noqa: E731
    if b is None or b == a:
        return f"c. {abs(a):,} {era(a)}"
    return f"{abs(a):,}–{abs(b):,} {era(b)}" if (a < 0) == (b < 0) else f"{abs(a):,} {era(a)} – {abs(b):,} {era(b)}"


def _fold(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", s.lower()) if not unicodedata.combining(c))


def find(query: str = "", kind: str = "", country: str = "", near=None, existed_by: float = 0, limit: int = 12) -> list[dict]:
    q = _fold(query.strip())
    out = []
    for s in sites():
        hay = _fold(" ".join([s["id"], s["name"], s.get("nameFr", ""), s["place"], s["country"], s["period"], s["kind"]]))
        if q and not all(w in hay for w in q.split()):
            continue
        if kind:
            k = kind.lower()
            if k in ("caves", "cave art", "palaeolithic", "paleolithic"):
                if s["kind"] not in CAVE_KINDS:
                    continue
            elif k == "neolithic":
                if s["kind"] in CAVE_KINDS:
                    continue
            elif s["kind"] != k:
                continue
        if country and _fold(country) not in _fold(s["country"]):
            continue
        if existed_by and years_ago(s) < existed_by:
            continue
        d = None
        if near:
            d = distance_km(near[0], near[1], s["lat"], s["lon"])
            if near[2] and d > near[2]:
                continue
        out.append((d if d is not None else 0, s))
    out.sort(key=lambda x: (x[0], -years_ago(x[1])) if near else (-years_ago(x[1]),))
    return [s for _, s in out[:max(1, min(limit, 69))]]


def site_text(s: dict, fr: bool = False, full: bool = False) -> str:
    name = (s.get("nameFr") if fr else None) or s["name"]
    line = f"- **{name}** [{s['id']}] ({s['kind']}) · {s['place']}, {s['country']} · {fmt_when(s)} · {s['period']}"
    line += f" · {s['lat']:.4f}, {s['lon']:.4f}{' (approx.)' if s.get('approx') else ''}"
    if not full:
        return line
    desc = s["fr"]["desc"] if fr else s["desc"]
    hl = (s["fr"].get("highlight") if fr else s.get("highlight")) or ""
    extra = [f"discovered {s['discovered']}" if s.get("discovered") else "", f"UNESCO {s['unesco']}" if s.get("unesco") else "",
             {"open": "original open to visitors", "replica": "closed, replica to visit", "closed": "closed to the public",
              "site": "site to see"}.get(s.get("visit", ""), ""), f"replica: {s['replica']}" if s.get("replica") else ""]
    parts = [line, f"  {desc}"]
    if hl:
        parts.append(f"  {hl}")
    if any(extra):
        parts.append("  " + " · ".join(e for e in extra if e))
    if s.get("align"):
        built, now = solar(s["lat"], s["when"][0], s["align"]), solar(s["lat"], date.today().year, s["align"])
        parts.append("  Faces: " + "; ".join(f"{EVENTS[e]} (bearing {built[e]}° when built, {now[e]}° today)" for e in s["align"]))
    return "\n".join(parts)


def map_block(items: list[dict], title: str, lines=None, fr: bool = False) -> str:
    spec = {"title": title, "markers": [{"lat": s["lat"], "lon": s["lon"], "label": (s.get("nameFr") if fr else None) or s["name"],
                                          "note": fmt_when(s)} for s in items]}
    if lines:
        spec["lines"] = lines
    if len(items) == 1:
        spec["center"], spec["zoom"] = {"lat": items[0]["lat"], "lon": items[0]["lon"]}, 11
    return "```map\n" + json.dumps(spec, ensure_ascii=False) + "\n```"


def solar_lines(lat: float, lon: float, year: float, events) -> list[dict]:
    out = []
    for ev, az in solar(lat, year, events).items():
        if az is not None:
            out.append({"points": [[lat, lon], list(destination(lat, lon, az, 8))], "label": f"{EVENTS[ev]} {az}°"})
    return out


async def deep_time_tool(args, ctx):
    from tools import ToolResult
    action = str(args.get("action") or "sites").lower()
    fr = str(args.get("language") or "").lower().startswith("fr")
    try:
        if action == "sea_level":
            y = float(args.get("years_ago") or 0)
            if not 0 <= y <= DEEP_MAX:
                return ToolResult(f"years_ago must be between 0 and {DEEP_MAX:,}.", error=True)
            m = sea_level(y)
            note = next((t for yy, t in SHORES if abs(yy - y) <= 1500), "")
            there = sum(1 for s in sites() if years_ago(s) >= y)
            return ToolResult(
                f"Sea level {y:,.0f} years ago: about {m:.0f} m relative to today (global mean; local coasts differ by tens of metres "
                f"with ice loading and uplift).{' ' + note + '.' if note else ''} {there} of the {len(sites())} prehistoric sites in Worlds "
                "already existed then. In Worlds, Layers → Ice Age coast shows the shoreline for any date.")
        if action == "sun":
            lat = float(args["lat"])
            year = float(args.get("year") if args.get("year") is not None else date.today().year)
            evs = [e for e in (args.get("events") or EVENTS) if e in EVENTS]
            now, then = solar(lat, date.today().year, evs), solar(lat, year, evs)
            rows = "\n".join(f"- {EVENTS[e]}: {then[e] if then[e] is not None else 'no rise/set (polar)'}°"
                             f" (today {now[e] if now[e] is not None else '—'}°)" for e in evs)
            text = (f"Obliquity in {abs(year):.0f} {'BC' if year < 0 else 'AD'}: {obliquity(year):.3f}° (today {obliquity(date.today().year):.3f}°).\n"
                    f"Sun bearings from true north at latitude {lat:.4f}, flat sea-level horizon:\n{rows}\n"
                    "A raised horizon (hills) moves sunrise towards the south in the northern hemisphere by one to two degrees for each degree of horizon altitude at mid latitudes.")
            if args.get("lon") is not None:
                lon = float(args["lon"])
                spec = {"title": f"Solstice and equinox bearings, {abs(year):.0f} {'BC' if year < 0 else 'AD'}",
                        "markers": [{"lat": lat, "lon": lon, "label": "Observer"}], "lines": solar_lines(lat, lon, year, evs),
                        "center": {"lat": lat, "lon": lon}, "zoom": 11}
                text += "\n\nPaste this block in your reply to draw it:\n```map\n" + json.dumps(spec, ensure_ascii=False) + "\n```"
            return ToolResult(text)
        if action == "site":
            key = _fold(str(args.get("id") or args.get("query") or ""))
            s = next((x for x in sites() if x["id"] == key), None) or next(iter(find(key, limit=1)), None)
            if not s:
                return ToolResult(f"No site matches “{args.get('id') or args.get('query')}”. Try action sites with a query.", error=True)
            lines = solar_lines(s["lat"], s["lon"], s["when"][0], s["align"]) if s.get("align") else None
            return ToolResult(site_text(s, fr, full=True) + "\n\nPaste this block in your reply to show it on a map:\n"
                              + map_block([s], (s.get("nameFr") if fr else None) or s["name"], lines, fr))
        near = None
        if args.get("lat") is not None and args.get("lon") is not None:
            near = (float(args["lat"]), float(args["lon"]), float(args.get("radius_km") or 0))
        found = find(str(args.get("query") or ""), str(args.get("kind") or ""), str(args.get("country") or ""), near,
                     float(args.get("existed_by_years_ago") or 0), int(args.get("limit") or 12))
        if not found:
            return ToolResult("No prehistoric sites match. The list holds 69 major painted caves, shelters, Neolithic villages, "
                              "temples and megaliths; for anything else use the wiki or the web.")
        body = "\n".join(site_text(s, fr) for s in found)
        return ToolResult(f"{len(found)} site(s), {'nearest' if near else 'oldest'} first:\n{body}\n\n"
                          "Use action site with an id for the full card. Paste this block to map them:\n"
                          + map_block(found, "Prehistoric sites", fr=fr))
    except (KeyError, TypeError, ValueError) as e:
        return ToolResult(f"Bad arguments for deep_time {action}: {e}", error=True)


def register():
    from tools import TOOLS, _fn
    TOOLS["deep_time"] = {
        "fn": deep_time_tool, "service": None,
        "ui": {"displayName": "Deep time", "icon": "Hourglass", "category": "knowledge",
               "description": "Prehistoric sites, Ice Age sea levels and solstice sunrise bearings for any place and year (deeptime.py)"},
        "schema": _fn(
            "deep_time",
            "Prehistory and deep-time facts, computed locally. action=sites: search the 69 painted caves, rock shelters, "
            "Neolithic villages, temples and megaliths shown in Worlds (query, kind caves|neolithic|cave|rockart|shelter|settlement|"
            "temple|megalith|tomb|find, country, lat/lon/radius_km for nearest, existed_by_years_ago). action=site: one site's full "
            "card (id or query), with the solstice line it faces. action=sea_level: global sea level years_ago (0–80,000). "
            "action=sun: sunrise/sunset bearings at the solstices and equinoxes for lat (and lon to get a map) in a calendar year "
            "(negative = BC), with Earth's tilt then. Results include a ```map``` block to paste into the reply.",
            {"action": {"type": "string", "enum": ["sites", "site", "sea_level", "sun"]},
             "query": {"type": "string"}, "id": {"type": "string"}, "kind": {"type": "string"}, "country": {"type": "string"},
             "lat": {"type": "number"}, "lon": {"type": "number"}, "radius_km": {"type": "number"},
             "existed_by_years_ago": {"type": "number"}, "years_ago": {"type": "number"},
             "year": {"type": "number", "description": "calendar year, negative = BC (sun)"},
             "events": {"type": "array", "items": {"type": "string", "enum": list(EVENTS)}},
             "language": {"type": "string", "description": "fr for French descriptions"},
             "limit": {"type": "integer"}},
            ["action"]),
    }
