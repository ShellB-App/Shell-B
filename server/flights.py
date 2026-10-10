"""Live flights: ADS-B positions from the community feeds (no keys), routes from adsbdb, trails from adsb.lol traces.

This is the one part of Maps that needs the internet. Only the query (a callsign, or a lat/lon box) leaves the Spark.
  GET /api/flights/area?lat=&lon=&radius=   aircraft within radius nautical miles (max 250)
  GET /api/flights/find?q=                  one flight by callsign (ICAO or IATA), registration or ICAO hex,
                                            plus its route and today's trail
The `track_flight` tool wraps /find for agents; the ```flight``` chat card and the Worlds app poll these endpoints.
"""
import asyncio
import math
import re
import time

import httpx
from fastapi import APIRouter, HTTPException

from tools import TOOLS, ToolResult, _fn

router = APIRouter(prefix="/api/flights")

UA = {"User-Agent": "Shell:B personal assistant (self-hosted)"}
FEEDS = [  # tried in order; both serve the readsb v2 JSON shape
    ("adsb.lol", "https://api.adsb.lol/v2"),
    ("adsb.fi", "https://opendata.adsb.fi/api/v2"),
]
_FI_PATHS = {"point": "lat/{lat}/lon/{lon}/dist/{r}", "callsign": "callsign/{q}", "reg": "registration/{q}", "hex": "hex/{q}"}
_LOL_PATHS = {"point": "point/{lat}/{lon}/{r}", "callsign": "callsign/{q}", "reg": "reg/{q}", "hex": "hex/{q}"}

_cache: dict[str, tuple[float, object]] = {}
_client: httpx.AsyncClient | None = None
_pace = {name: asyncio.Lock() for name, _ in FEEDS}
_last = {name: 0.0 for name, _ in FEEDS}


def _http() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=12, headers=UA, follow_redirects=True)
    return _client


async def _cached(key: str, ttl: float, fn):
    hit = _cache.get(key)
    if hit and time.monotonic() - hit[0] < ttl:
        return hit[1]
    val = await fn()
    _cache[key] = (time.monotonic(), val)
    if len(_cache) > 500:  # drop the oldest half
        for k, _ in sorted(_cache.items(), key=lambda kv: kv[1][0])[:250]:
            _cache.pop(k, None)
    return val


async def _feed(kind: str, **kw) -> tuple[list[dict], str]:
    """Query the first feed that answers. Returns (raw aircraft, feed name)."""
    last = None
    for name, base in FEEDS:
        path = (_FI_PATHS if name == "adsb.fi" else _LOL_PATHS)[kind].format(**kw)
        try:
            for attempt in range(2):
                async with _pace[name]:  # the feeds rate-limit bursts (adsb.fi: 1 request/s)
                    wait = _last[name] + (1.05 if name == "adsb.fi" else 0.3) - time.monotonic()
                    if wait > 0:
                        await asyncio.sleep(wait)
                    _last[name] = time.monotonic()
                r = await _http().get(f"{base}/{path}")
                if r.status_code != 429 or attempt:
                    break
                await asyncio.sleep(1.5)
            r.raise_for_status()
            d = r.json()
            return list(d.get("ac") or d.get("aircraft") or []), name
        except (httpx.HTTPError, ValueError) as e:
            last = e
    raise HTTPException(502, f"No flight feed answered ({type(last).__name__}). Live flights need the internet.")


def _num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def norm(a: dict) -> dict | None:
    lat, lon = _num(a.get("lat")), _num(a.get("lon"))
    if lat is None or lon is None:
        lat, lon = _num((a.get("lastPosition") or {}).get("lat")), _num((a.get("lastPosition") or {}).get("lon"))
    if lat is None or lon is None:
        return None
    alt = a.get("alt_baro")
    ground = alt == "ground"
    return {
        "hex": str(a.get("hex", "")).lower().lstrip("~"),
        "callsign": (a.get("flight") or "").strip() or None,
        "reg": a.get("r"), "type": a.get("t"), "desc": a.get("desc"), "operator": a.get("ownOp"),
        "lat": lat, "lon": lon,
        "alt": 0 if ground else _num(alt) if _num(alt) is not None else _num(a.get("alt_geom")),
        "ground": ground,
        "gs": _num(a.get("gs")), "track": _num(a.get("track")) if _num(a.get("track")) is not None else _num(a.get("true_heading")),
        "vrate": _num(a.get("baro_rate")) if _num(a.get("baro_rate")) is not None else _num(a.get("geom_rate")),
        "squawk": a.get("squawk"), "emergency": a.get("emergency") if a.get("emergency") not in (None, "none") else None,
        "category": a.get("category"), "seen": _num(a.get("seen_pos")) if _num(a.get("seen_pos")) is not None else _num(a.get("seen")),
    }


# ── area ────────────────────────────────────────────────────────────────────

async def area(lat: float, lon: float, radius: float) -> dict:
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise HTTPException(400, "lat/lon out of range")
    radius = max(1, min(250, radius))
    # snap so nearby map views share a cache entry and we stay well inside the feeds' rate limits
    key = f"area:{round(lat, 1)}:{round(lon, 1)}:{int(radius // 10 * 10 + 10)}"

    async def get():
        raw, feed = await _feed("point", lat=round(lat, 3), lon=round(lon, 3), r=int(radius))
        return {"now": time.time(), "feed": feed, "aircraft": [x for x in map(norm, raw) if x]}
    return await _cached(key, 4.0, get)


@router.get("/area")
async def area_route(lat: float, lon: float, radius: float = 100):
    return await area(lat, lon, radius)


# ── one flight ──────────────────────────────────────────────────────────────

HEX = re.compile(r"^~?[0-9a-f]{6}$", re.I)
IATA_FLIGHT = re.compile(r"^([A-Z0-9]{2})(\d{1,4}[A-Z]?)$")


async def _route(callsign: str) -> dict | None:
    async def get():
        try:
            r = await _http().get(f"https://api.adsbdb.com/v0/callsign/{callsign}")
            fr = (r.json().get("response") or {}).get("flightroute") if r.status_code == 200 else None
        except (httpx.HTTPError, ValueError):
            return None
        if not isinstance(fr, dict):
            return None

        def ap(x):
            x = x or {}
            return {"iata": x.get("iata_code"), "icao": x.get("icao_code"), "name": x.get("name"),
                    "city": x.get("municipality"), "country": x.get("country_name"),
                    "lat": x.get("latitude"), "lon": x.get("longitude")} if x else None
        al = fr.get("airline") or {}
        return {"callsign": fr.get("callsign_icao") or fr.get("callsign"), "iata": fr.get("callsign_iata"),
                "airline": al.get("name"), "origin": ap(fr.get("origin")), "destination": ap(fr.get("destination"))}
    return await _cached(f"route:{callsign}", 3600, get)


def _plausible(route: dict | None, ac: dict) -> dict | None:
    """adsbdb maps callsigns to routes from a static table that goes stale; keep the route only if the aircraft fits it."""
    if not route:
        return None
    o, t = route.get("origin") or {}, route.get("destination") or {}
    if None in (o.get("lat"), o.get("lon"), t.get("lat"), t.get("lon")):
        return route
    R = 6371.0
    rad = math.radians

    def dist(a, b):  # great-circle km between (lat, lon) pairs
        p1, p2, dl = rad(a[0]), rad(b[0]), rad(b[1] - a[1])
        return 2 * R * math.asin(min(1, math.sqrt(math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2)))

    def bearing(a, b):
        p1, p2, dl = rad(a[0]), rad(b[0]), rad(b[1] - a[1])
        return math.atan2(math.sin(dl) * math.cos(p2), math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl))

    A, B, P = (o["lat"], o["lon"]), (t["lat"], t["lon"]), (ac["lat"], ac["lon"])
    if ac.get("ground"):
        ok = min(dist(P, A), dist(P, B)) < 60
    else:
        d12, d13 = dist(A, B), dist(A, P)
        xt = R * math.asin(max(-1, min(1, math.sin(d13 / R) * math.sin(bearing(A, P) - bearing(A, B)))))
        along = R * math.acos(max(-1, min(1, math.cos(d13 / R) / max(1e-9, math.cos(xt / R)))))
        ok = abs(xt) < max(250, 0.2 * d12) and along < d12 + 150 and dist(P, B) < d12 + 150
    return route if ok else {**route, "origin": None, "destination": None, "stale": True}


async def _trail(hex_: str) -> list[list]:
    """Today's positions for this airframe, from its last take-off (or the last 6 h), as [lat, lon, alt_ft|None, unix]."""
    async def trace(kind):
        try:
            r = await _http().get(f"https://globe.adsb.lol/data/traces/{hex_[-2:]}/trace_{kind}_{hex_}.json")
            d = r.json() if r.status_code == 200 else {}
        except (httpx.HTTPError, ValueError):
            d = {}
        t0 = d.get("timestamp") or 0
        return [[t0 + p[0], *p[1:]] for p in d.get("trace") or [] if isinstance(p, list) and len(p) > 3]

    async def get():
        # trace_full is rewritten every few minutes; trace_recent covers the gap up to now
        full, recent = await asyncio.gather(trace("full"), trace("recent"))
        last = full[-1][0] if full else 0
        pts = full + [p for p in recent if p[0] > last]
        t0 = 0
        start = 0
        for i, p in enumerate(pts):  # flags bit 1 (value 2) marks the start of a new leg
            if isinstance(p, list) and len(p) > 6 and isinstance(p[6], int) and p[6] & 2:
                start = i
        out = []
        for p in pts[start:]:
            if not isinstance(p, list) or len(p) < 4:
                continue
            alt = 0 if p[3] == "ground" else _num(p[3])
            out.append([round(p[1], 5), round(p[2], 5), alt, round(t0 + p[0])])
        cutoff = time.time() - 6 * 3600
        out = [p for p in out if p[3] >= cutoff] or out[-1:]
        step = max(1, -(-len(out) // 600))  # keep the payload small; always keep the last point
        return out[::step] + ([out[-1]] if out and (len(out) - 1) % step else [])
    return await _cached(f"trail:{hex_}", 20, get)


async def find(q: str) -> dict:
    q = re.sub(r"\s+", "", q or "").upper()
    if not q or len(q) > 12 or not re.match(r"^[A-Z0-9~-]+$", q):
        raise HTTPException(400, "Give a callsign (UAL123 or UA123), a registration (N12345) or an ICAO hex code")

    async def lookup():
        raw: list = []
        if HEX.match(q):
            raw, _ = await _feed("hex", q=q.lower().lstrip("~"))
        if not raw and "-" not in q:
            raw, _ = await _feed("callsign", q=q)
        if not raw:
            raw, _ = await _feed("reg", q=q)
        if not raw and IATA_FLIGHT.match(q):  # B6195 → JBU195 via adsbdb
            rt = await _route(q)
            if rt and rt.get("callsign") and rt["callsign"] != q:
                raw, _ = await _feed("callsign", q=rt["callsign"])
        return [x for x in map(norm, raw) if x]
    found = await _cached(f"find:{q}", 4.0, lookup)
    if not found:
        return {"query": q, "aircraft": None, "route": await _route(q) if not HEX.match(q) else None, "trail": []}
    ac = min(found, key=lambda a: a.get("seen") if a.get("seen") is not None else 1e9)
    route, trail = await asyncio.gather(_route(ac["callsign"]) if ac.get("callsign") else asyncio.sleep(0), _trail(ac["hex"]))
    return {"query": q, "aircraft": ac, "route": _plausible(route, ac), "trail": trail}


@router.get("/find")
async def find_route(q: str):
    return await find(q)


# ── agent tool ──────────────────────────────────────────────────────────────

def _summary(d: dict) -> str:
    a, rt = d["aircraft"], d.get("route")
    leg = "The published route for this callsign doesn't match where the aircraft is, so the route is unknown; don't guess where it is going. " if rt and rt.get("stale") else ""
    if rt and rt.get("origin") and rt.get("destination"):
        o, t = rt["origin"], rt["destination"]
        leg = f"Route (scheduled for this callsign): {o.get('city') or o.get('name')} ({o.get('iata') or o.get('icao')}) → {t.get('city') or t.get('name')} ({t.get('iata') or t.get('icao')}). "
    if not a:
        return (f"{d['query']} is not being tracked right now: no ADS-B position in the community feeds (it may be on the ground "
                f"with its transponder off, out of receiver range, or not flying today). {leg}").strip()
    alt = "on the ground" if a["ground"] else f"{a['alt']:,} ft" if a.get("alt") is not None else "altitude unknown"
    vs = a.get("vrate")
    trend = "" if a["ground"] or vs is None else ", climbing" if vs > 300 else ", descending" if vs < -300 else ", level"
    who = " · ".join(x for x in (a.get("callsign"), a.get("reg"), a.get("desc") or a.get("type"), rt and rt.get("airline")) if x)
    return (f"{who}\nPosition {a['lat']:.4f}, {a['lon']:.4f}; {alt}{trend}; ground speed {a.get('gs') or '?'} kt; "
            f"track {round(a['track']) if a.get('track') is not None else '?'}°; squawk {a.get('squawk') or '?'}"
            f"{'; EMERGENCY ' + a['emergency'] if a.get('emergency') else ''}; position {a.get('seen') or 0:.0f} s old.\n{leg}\n"
            f"To show it live, put this in your reply:\n```flight\n{{\"q\": \"{a.get('callsign') or a['hex']}\"}}\n```")


SPACECRAFT = re.compile(r"^(iss|tiangong|css|hubble|hst|space ?station|international space station)$", re.I)


async def track_flight(args, ctx):
    q = str(args.get("query", "")).strip()
    if SPACECRAFT.match(q):
        return ToolResult(f"{q} is a spacecraft, not an aircraft. Show it with a satellite card instead:\n"
                          f"```satellite\n{{\"sat\": \"{q.lower().split()[0]}\"}}\n```", error=True)
    try:
        d = await find(q)
    except HTTPException as e:
        return ToolResult(str(e.detail), error=True)
    return ToolResult(_summary(d), {"flight": d["query"]})


def register():
    TOOLS["track_flight"] = {
        "fn": track_flight, "service": None, "scope": "global", "auto": "when the agent has Web Search",
        "ui": {"displayName": "Flight Tracker", "icon": "Plane", "category": "web",
               "description": "Live aircraft positions, routes and trails from the community ADS-B feeds."},
        "schema": _fn("track_flight",
                      "Look up a flight that is in the air right now: position, altitude, speed, route and airline. "
                      "Use for 'where is flight X', 'has UA123 landed', 'what plane is N12345'. Then show it with a "
                      "```flight``` block (the result gives you the exact block).",
                      {"query": {"type": "string", "description": "Callsign (UAL123 or UA123), registration (N12345, G-EUPT) or ICAO hex"}},
                      ["query"]),
    }
