"""Turn-by-turn directions from a local Valhalla (docker container `shellb-valhalla` on 127.0.0.1:8230).

Tiles are built from the regional extracts in ~/shellb/maps/regions (Florida first), so routing is fully offline
inside those regions. Endpoints of a route may be "lat,lon" or a place name (resolved by places.search).
  GET /api/route?from=&to=&mode=auto|bicycle|pedestrian&via=   geometry, distance, time and steps
  GET /api/route/status                                          whether Valhalla is up, and which regions
The `directions` tool wraps /api/route; the ```route``` chat card draws it.
"""
import re

import httpx
from fastapi import APIRouter, HTTPException, Query

import places
from tools import TOOLS, ToolResult, _fn

router = APIRouter(prefix="/api/route")
VALHALLA = "http://127.0.0.1:8230"
MODES = {"auto": "auto", "car": "auto", "drive": "auto", "driving": "auto", "bicycle": "bicycle", "bike": "bicycle",
         "cycling": "bicycle", "pedestrian": "pedestrian", "walk": "pedestrian", "walking": "pedestrian", "foot": "pedestrian"}
LATLON = re.compile(r"^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$")


def _decode(shape: str, precision: int = 6) -> list[list[float]]:
    """Valhalla's encoded polyline (precision 6) → [[lon, lat], …]."""
    coords, idx, lat, lon, f = [], 0, 0, 0, 10 ** precision
    while idx < len(shape):
        for which in (0, 1):
            shift = result = 0
            while True:
                b = ord(shape[idx]) - 63
                idx += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            d = ~(result >> 1) if result & 1 else result >> 1
            if which == 0:
                lat += d
            else:
                lon += d
        coords.append([round(lon / f, 6), round(lat / f, 6)])
    return coords


async def _resolve(q: str) -> dict:
    m = LATLON.match(q or "")
    if m:
        return {"name": q.strip(), "lat": float(m.group(1)), "lon": float(m.group(2))}
    res = await places.search(q, 1)
    if not res:
        raise HTTPException(404, f"Couldn't find “{q}”.")
    r = res[0]
    return {"name": r["full"], "lat": r["lat"], "lon": r["lon"]}


async def route(frm: str, to: str, mode: str = "auto", via: list[str] | None = None) -> dict:
    costing = MODES.get((mode or "auto").lower())
    if not costing:
        raise HTTPException(400, "mode must be auto, bicycle or pedestrian")
    stops = [await _resolve(frm), *[await _resolve(v) for v in via or []], await _resolve(to)]
    # search_cutoff: Valhalla otherwise snaps a point up to 35 km to the nearest road it has, so a place outside the
    # installed region would silently route to the region's edge instead of failing
    body = {"locations": [{"lat": s["lat"], "lon": s["lon"], "search_cutoff": 3000} for s in stops], "costing": costing,
            "directions_options": {"units": "kilometers", "language": "en-US"}}
    try:
        async with httpx.AsyncClient(timeout=30) as c:
            r = await c.post(f"{VALHALLA}/route", json=body)
    except httpx.HTTPError:
        raise HTTPException(503, "The routing engine (Valhalla) isn't running.")
    d = r.json()
    if r.status_code != 200 or "trip" not in d:
        msg = d.get("error") or d.get("status_message") or f"HTTP {r.status_code}"
        if d.get("error_code") in (154, 171, 442, 443) or "No suitable edges" in str(msg) or "No path" in str(msg):
            msg = f"No route: offline directions cover {', '.join(x['name'].title() for x in places.regions()) or 'no regions'} only, and both ends must be reachable by road."
        raise HTTPException(422, msg)
    trip = d["trip"]
    coords: list[list[float]] = []
    steps = []
    for leg in trip["legs"]:
        shape = _decode(leg["shape"])
        base = len(coords)
        coords += shape if not coords else shape[1:]
        for m in leg.get("maneuvers", []):
            i = max(0, min(len(coords) - 1, base + m.get("begin_shape_index", 0) - (1 if base else 0)))
            steps.append({"text": m.get("instruction", ""), "km": round(m.get("length", 0), 3), "s": round(m.get("time", 0)),
                          "type": m.get("type"), "street": (m.get("street_names") or [None])[0], "at": coords[i] if coords else None})
    xs, ys = [p[0] for p in coords], [p[1] for p in coords]
    return {"from": stops[0], "to": stops[-1], "via": stops[1:-1], "mode": costing,
            "km": round(trip["summary"]["length"], 2), "s": round(trip["summary"]["time"]),
            "coords": coords, "steps": steps, "bbox": [min(xs), min(ys), max(xs), max(ys)] if coords else None}


@router.get("")
async def route_route(frm: str = Query("", alias="from"), to: str = "", mode: str = "auto", via: str = ""):
    """?from=…&to=…; `from` is a Python keyword, hence the alias. Several via points are separated by |."""
    return await route(frm, to, mode, [v for v in via.split("|") if v.strip()])


@router.get("/status")
async def status():
    try:
        async with httpx.AsyncClient(timeout=3) as c:
            r = await c.get(f"{VALHALLA}/status")
            up = r.status_code == 200
    except httpx.HTTPError:
        up = False
    return {"valhalla": up, "regions": [{"name": r["name"], "bytes": r["bytes"]} for r in places.regions()]}


def _dur(s: int) -> str:
    h, m = divmod(round(s / 60), 60)
    return f"{h} h {m} min" if h else f"{m} min"


async def directions_tool(args, ctx):
    frm, to, mode = str(args.get("from", "")), str(args.get("to", "")), str(args.get("mode") or "auto")
    try:
        r = await route(frm, to, mode)
    except HTTPException as e:
        return ToolResult(str(e.detail), error=True)
    mi = r["km"] * 0.621371
    head = (f"{r['from']['name']} → {r['to']['name']} by {r['mode']}: {r['km']:.1f} km ({mi:.1f} mi), about {_dur(r['s'])}.")
    steps = "\n".join(f"{i + 1}. {s['text']}" for i, s in enumerate(r["steps"][:25]))
    more = f"\n… {len(r['steps']) - 25} more steps in the card." if len(r["steps"]) > 25 else ""
    fence = '{"from": "%s", "to": "%s", "mode": "%s"}' % (frm.replace('"', ''), to.replace('"', ''), r["mode"])
    return ToolResult(f"{head}\n{steps}{more}\nShow it with:\n```route\n{fence}\n```", {"route": f"{frm} → {to}"})


def register():
    TOOLS["directions"] = {
        "fn": directions_tool, "service": None, "scope": "global", "auto": "when an offline routing region is installed",
        "ui": {"displayName": "Directions", "icon": "Route", "category": "web",
               "description": "Offline turn-by-turn directions (Valhalla) for driving, cycling and walking."},
        "schema": _fn("directions",
                      "Driving, cycling or walking directions between two places, computed offline: distance, time and "
                      "turn-by-turn steps. Then show the route with a ```route``` block (the result gives the exact block).",
                      {"from": {"type": "string", "description": "Start: a place, address or \"lat,lon\""},
                       "to": {"type": "string", "description": "Destination: a place, address or \"lat,lon\""},
                       "mode": {"type": "string", "enum": ["auto", "bicycle", "pedestrian"]}}, ["from", "to"]),
    }
