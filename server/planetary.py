"""Planetary cartography, celestial navigation, and space exploration intelligence.
Serves offline IAU nomenclature queries from ~/shellb/maps/planetary.db, astrophysical world dossiers,
orbital ephemerides and interplanetary transfer windows, alongside online telemetry bridges (NOAA space weather,
NASA near-Earth asteroids, USGS seismic feeds).
"""
import asyncio
import json
import math
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Query

from tools import GUARD_HOOKS, TOOLS, ToolResult, _fn
from weather import DATA, UA

import solsys

router = APIRouter(prefix="/api/planetary")

PLANETARY_DB = Path.home() / "shellb" / "maps" / "planetary.db"
AU_KM = 149_597_870.7
SPEED_OF_LIGHT_KMS = 299_792.458
MU_SUN = 1.32712440018e11  # km^3 / s^2

# Planetary orbital elements (semi-major axis a in AU, orbital period T in days)
ORBITAL_DATA: dict[str, dict[str, Any]] = {
    "mercury": {"a": 0.387098, "e": 0.205630, "T": 87.97, "radius": 2439.7, "mass": "3.3011 × 10²³ kg", "gravity": 3.7, "atmosphere": "Trace exosphere (Na, Mg, He)", "pressure": "< 10⁻¹⁴ bar", "day": "58.6 Earth days", "temp": "-180°C to +430°C"},
    "venus": {"a": 0.723332, "e": 0.006772, "T": 224.70, "radius": 6051.8, "mass": "4.8675 × 10²⁴ kg", "gravity": 8.87, "atmosphere": "96.5% CO₂, 3.5% N₂", "pressure": "92 bar (9.2 MPa)", "day": "-243 Earth days (retrograde)", "temp": "+464°C (runaway greenhouse)"},
    "earth": {"a": 1.000000, "e": 0.016708, "T": 365.256, "radius": 6371.0, "mass": "5.9722 × 10²⁴ kg", "gravity": 9.807, "atmosphere": "78% N₂, 21% O₂, 0.93% Ar", "pressure": "1.013 bar", "day": "24 hours", "temp": "-88°C to +58°C (mean +15°C)"},
    "moon": {"a": 1.000000, "e": 0.054900, "T": 27.322, "radius": 1737.4, "mass": "7.342 × 10²² kg", "gravity": 1.62, "atmosphere": "Extremely tenuous exosphere (He, Ne, H)", "pressure": "3 × 10⁻¹⁵ bar", "day": "27.3 Earth days (tidally locked)", "temp": "-130°C to +120°C"},
    "mars": {"a": 1.523679, "e": 0.093400, "T": 686.98, "radius": 3389.5, "mass": "6.4171 × 10²³ kg", "gravity": 3.72, "atmosphere": "95.3% CO₂, 2.6% N₂, 1.9% Ar", "pressure": "6.1 mbar (0.006 bar)", "day": "24h 37m 22s (sol)", "temp": "-140°C to +20°C (mean -63°C)"},
    "phobos": {"a": 1.523679, "e": 0.015100, "T": 0.319, "radius": 11.26, "mass": "1.0659 × 10¹⁶ kg", "gravity": 0.0057, "atmosphere": "None", "pressure": "0 bar", "day": "7h 39m (tidally locked)", "temp": "-112°C to -4°C"},
    "ceres": {"a": 2.767500, "e": 0.075800, "T": 1681.63, "radius": 469.73, "mass": "9.393 × 10²⁰ kg", "gravity": 0.28, "atmosphere": "Transient water vapor exosphere", "pressure": "< 10⁻¹⁰ bar", "day": "9h 4m", "temp": "-105°C to -73°C"},
    "vesta": {"a": 2.361790, "e": 0.088740, "T": 1325.75, "radius": 262.7, "mass": "2.590 × 10²⁰ kg", "gravity": 0.25, "atmosphere": "None", "pressure": "0 bar", "day": "5h 20m", "temp": "-188°C to -18°C"},
    "io": {"a": 5.204400, "e": 0.004100, "T": 1.769, "radius": 1821.6, "mass": "8.9319 × 10²² kg", "gravity": 1.796, "atmosphere": "90% SO₂ from ~400 active volcanoes", "pressure": "10⁻⁹ to 10⁻⁷ bar", "day": "42.5 hours (tidally locked)", "temp": "-143°C (volcanic hot spots to +1300°C)"},
    "europa": {"a": 5.204400, "e": 0.009000, "T": 3.551, "radius": 1560.8, "mass": "4.7998 × 10²² kg", "gravity": 1.315, "atmosphere": "Tenuous molecular oxygen (O₂)", "pressure": "10⁻¹² bar", "day": "85.2 hours (tidally locked)", "temp": "-220°C to -160°C"},
    "ganymede": {"a": 5.204400, "e": 0.001300, "T": 7.155, "radius": 2634.1, "mass": "1.4819 × 10²³ kg", "gravity": 1.428, "atmosphere": "Tenuous oxygen exosphere", "pressure": "10⁻¹¹ bar", "day": "171.7 hours (tidally locked)", "temp": "-203°C to -121°C"},
    "callisto": {"a": 5.204400, "e": 0.007400, "T": 16.689, "radius": 2410.3, "mass": "1.0759 × 10²³ kg", "gravity": 1.235, "atmosphere": "Thin carbon dioxide and oxygen", "pressure": "7.5 × 10⁻¹² bar", "day": "16.7 Earth days (tidally locked)", "temp": "-193°C to -108°C"},
    "mimas": {"a": 9.582600, "e": 0.020200, "T": 0.942, "radius": 198.2, "mass": "3.75 × 10¹⁹ kg", "gravity": 0.064, "atmosphere": "None", "pressure": "0 bar", "day": "22.6 hours (tidally locked)", "temp": "-209°C"},
    "enceladus": {"a": 9.582600, "e": 0.004700, "T": 1.370, "radius": 252.1, "mass": "1.08 × 10²⁰ kg", "gravity": 0.113, "atmosphere": "Cryovolcanic plume vapor: 91% H₂O, 4% N₂, 3.2% CO₂", "pressure": "Local plume ~10⁻⁹ bar", "day": "32.9 hours (tidally locked)", "temp": "-201°C to -198°C"},
    "tethys": {"a": 9.582600, "e": 0.000100, "T": 1.888, "radius": 531.1, "mass": "6.17 × 10²⁰ kg", "gravity": 0.147, "atmosphere": "None", "pressure": "0 bar", "day": "45.3 hours (tidally locked)", "temp": "-187°C"},
    "dione": {"a": 9.582600, "e": 0.002200, "T": 2.737, "radius": 561.4, "mass": "1.095 × 10²¹ kg", "gravity": 0.232, "atmosphere": "Thin molecular oxygen ions", "pressure": "< 10⁻¹¹ bar", "day": "65.7 hours (tidally locked)", "temp": "-186°C"},
    "rhea": {"a": 9.582600, "e": 0.001258, "T": 4.518, "radius": 763.8, "mass": "2.306 × 10²¹ kg", "gravity": 0.264, "atmosphere": "Tenuous oxygen and carbon dioxide", "pressure": "10⁻¹¹ bar", "day": "108.4 hours (tidally locked)", "temp": "-200°C to -174°C"},
    "titan": {"a": 9.582600, "e": 0.028800, "T": 15.945, "radius": 2574.7, "mass": "1.3452 × 10²³ kg", "gravity": 1.352, "atmosphere": "95% N₂, 4.9% CH₄, 0.1% H₂", "pressure": "1.45 bar (dense orange haze)", "day": "15.9 Earth days (tidally locked)", "temp": "-179°C (liquid methane lakes)"},
    "iapetus": {"a": 9.582600, "e": 0.028613, "T": 79.321, "radius": 735.6, "mass": "1.805 × 10²¹ kg", "gravity": 0.223, "atmosphere": "None", "pressure": "0 bar", "day": "79.3 Earth days (two-toned albedo)", "temp": "-180°C (dark Cassini Regio to -143°C)"},
    "triton": {"a": 30.07000, "e": 0.000016, "T": 5.877, "radius": 1353.4, "mass": "2.14 × 10²² kg", "gravity": 0.779, "atmosphere": "99.9% N₂, trace CH₄, CO", "pressure": "1.4 to 1.9 Pa (14-19 µbar)", "day": "-5.88 Earth days (retrograde orbit)", "temp": "-235°C (cryonitrogen geysers)"},
    "pluto": {"a": 39.48200, "e": 0.248800, "T": 90560.0, "radius": 1188.3, "mass": "1.303 × 10²² kg", "gravity": 0.62, "atmosphere": "N₂ with CH₄ and CO (expands at perihelion)", "pressure": "1.0 Pa (10 µbar)", "day": "-6.39 Earth days (retrograde)", "temp": "-233°C to -223°C"},
    "charon": {"a": 39.48200, "e": 0.000050, "T": 6.387, "radius": 606.0, "mass": "1.586 × 10²¹ kg", "gravity": 0.288, "atmosphere": "None", "pressure": "0 bar", "day": "6.39 Earth days (mutually locked with Pluto)", "temp": "-220°C"},
}


def search_features(q: str, body: str | None = None, limit: int = 10) -> list[dict]:
    """Offline FTS5 search over IAU features across solar system worlds."""
    if not PLANETARY_DB.exists():
        return []
    terms = " ".join(f'"{w}"*' for w in q.strip().split() if w)
    if not terms:
        return []
    con = sqlite3.connect(f"file:{PLANETARY_DB}?mode=ro", uri=True)
    try:
        if body:
            sql = """
                SELECT f.body, f.name, f.clean_name, f.type, f.lat, f.lon, f.diameter, f.origin, f.quad_name, f.approval_date, f.link
                FROM features_fts JOIN features f ON f.id = features_fts.rowid
                WHERE features_fts MATCH ? AND f.body = ?
                ORDER BY rank LIMIT ?
            """
            rows = con.execute(sql, (terms, body.lower(), limit)).fetchall()
        else:
            sql = """
                SELECT f.body, f.name, f.clean_name, f.type, f.lat, f.lon, f.diameter, f.origin, f.quad_name, f.approval_date, f.link
                FROM features_fts JOIN features f ON f.id = features_fts.rowid
                WHERE features_fts MATCH ?
                ORDER BY rank LIMIT ?
            """
            rows = con.execute(sql, (terms, limit)).fetchall()
    finally:
        con.close()

    out = []
    for b, name, cname, ftype, lat, lon, diam, origin, quad, app_dt, link in rows:
        out.append({
            "body": b,
            "name": name,
            "clean_name": cname,
            "type": ftype,
            "lat": lat,
            "lon": lon,
            "diameter_km": diam,
            "origin": origin,
            "quad_name": quad,
            "approval_date": app_dt,
            "link": link
        })
    return out


def inspect_body(body_id: str) -> dict:
    """Return comprehensive scientific dossier for a given world."""
    b = body_id.lower().strip()
    stats = ORBITAL_DATA.get(b)
    if not stats:
        raise HTTPException(404, f"World '{body_id}' not found in solar system catalogue.")
    
    # Check feature count in local DB
    feature_count = 0
    if PLANETARY_DB.exists():
        try:
            con = sqlite3.connect(f"file:{PLANETARY_DB}?mode=ro", uri=True)
            res = con.execute("SELECT COUNT(*) FROM features WHERE body = ?", (b,)).fetchone()
            feature_count = res[0] if res else 0
            con.close()
        except sqlite3.Error:
            pass

    earth_g = 9.807
    rel_g = round(stats["gravity"] / earth_g, 3)

    return {
        "id": b,
        "name": b.capitalize(),
        "radius_km": stats["radius"],
        "mass": stats["mass"],
        "gravity_ms2": stats["gravity"],
        "gravity_relative_earth": rel_g,
        "atmosphere": stats["atmosphere"],
        "surface_pressure": stats["pressure"],
        "day_length": stats["day"],
        "surface_temp": stats["temp"],
        "semi_major_axis_au": stats["a"],
        "orbital_period_days": stats["T"],
        "named_features_count": feature_count,
    }


def compute_ephemeris(target: str, date: datetime | None = None) -> dict:
    """Distance, light time and an idealised Hohmann transfer from Earth (solsys.py, JPL elements)."""
    eph = solsys.earth_link(target, date)
    if not eph:
        raise HTTPException(404, f"No position for '{target}'. Known: {', '.join(sorted(solsys.NAMES))}.")
    m, sec = divmod(eph["light_time_seconds"], 60)
    h, m = divmod(int(m), 60)
    eph["light_time_one_way"] = f"{h}h {m}m {round(sec)}s" if h else f"{m}m {round(sec)}s" if m else f"{sec:.2f}s"
    return eph


def compute_local_sky(body_id: str, lat: float, lon: float, date: datetime | None = None) -> dict:
    """Sun, planets and near moons in the local sky (solsys.py: JPL elements + IAU rotation models)."""
    sky = solsys.local_sky(body_id, lat, lon, date)
    if not sky:
        raise HTTPException(400, f"Sky view works on {', '.join(sorted(solsys.ROTATION))}; not '{body_id}'.")
    return sky


def compute_great_circle_distance(radius_km: float, lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Computes great-circle distance on a spherical world."""
    p1 = math.radians(lat1)
    l1 = math.radians(lon1)
    p2 = math.radians(lat2)
    l2 = math.radians(lon2)
    dlat = p2 - p1
    dlon = l2 - l1
    a = math.sin(dlat / 2.0)**2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2.0)**2
    c = 2.0 * math.atan2(math.sqrt(max(0.0, a)), math.sqrt(max(0.0, 1.0 - a)))
    return radius_km * c


def compute_initial_bearing(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Computes initial compass bearing from (lat1, lon1) to (lat2, lon2)."""
    p1 = math.radians(lat1)
    l1 = math.radians(lon1)
    p2 = math.radians(lat2)
    l2 = math.radians(lon2)
    dlon = l2 - l1
    y = math.sin(dlon) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dlon)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def slerp_point(lat1: float, lon1: float, lat2: float, lon2: float, f: float) -> tuple[float, float]:
    """Spherical linear interpolation between two points on a sphere."""
    p1 = math.radians(lat1)
    l1 = math.radians(lon1)
    p2 = math.radians(lat2)
    l2 = math.radians(lon2)
    v1 = [math.cos(p1) * math.cos(l1), math.cos(p1) * math.sin(l1), math.sin(p1)]
    v2 = [math.cos(p2) * math.cos(l2), math.cos(p2) * math.sin(l2), math.sin(p2)]
    dot = max(-1.0, min(1.0, sum(a * b for a, b in zip(v1, v2))))
    theta = math.acos(dot)
    if theta < 1e-6:
        return lat1, lon1
    sin_t = math.sin(theta)
    a = math.sin((1.0 - f) * theta) / sin_t
    b = math.sin(f * theta) / sin_t
    v = [a * x + b * y for x, y in zip(v1, v2)]
    lat = math.degrees(math.asin(max(-1.0, min(1.0, v[2]))))
    lon = math.degrees(math.atan2(v[1], v[0]))
    return lat, lon


def resolve_location(body: str, query: str) -> tuple[float, float, str]:
    """Resolves coordinates ('lat, lon') or feature/landing site name on a body."""
    parts = [p.strip() for p in query.replace(';', ',').split(',') if p.strip()]
    if len(parts) == 2:
        try:
            la, lo = float(parts[0]), float(parts[1])
            return la, lo, f"Point ({la:.4f}, {lo:.4f})"
        except ValueError:
            pass
    if PLANETARY_DB.exists():
        terms = " ".join(f'"{w}"*' for w in query.strip().split() if w)
        if terms:
            con = sqlite3.connect(f"file:{PLANETARY_DB}?mode=ro", uri=True)
            try:
                sql = """
                    SELECT f.name, f.type, f.lat, f.lon 
                    FROM features_fts JOIN features f ON f.id = features_fts.rowid
                    WHERE features_fts MATCH ? AND f.body = ?
                    ORDER BY rank LIMIT 1
                """
                row = con.execute(sql, (terms, body.lower())).fetchone()
                if row:
                    return row[2], row[3], f"{row[0]} ({row[1]})"
            finally:
                con.close()
    raise ValueError(f"Could not resolve '{query}' on {body.capitalize()}. Provide decimal coordinates or a recognized named feature.")


def find_features_near(body: str, lat: float, lon: float, radius_km: float = 3389.5, max_dist_km: float = 25.0) -> list[dict]:
    """Finds named IAU features near a surface coordinate."""
    if not PLANETARY_DB.exists():
        return []
    deg_km = (math.pi / 180.0) * radius_km
    delta_lat = max_dist_km / max(1.0, deg_km)
    cos_lat = max(0.1, math.cos(math.radians(lat)))
    delta_lon = delta_lat / cos_lat
    con = sqlite3.connect(f"file:{PLANETARY_DB}?mode=ro", uri=True)
    try:
        sql = """
            SELECT name, type, lat, lon, diameter
            FROM features
            WHERE body = ? AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?
            LIMIT 25
        """
        rows = con.execute(sql, (body.lower(), lat - delta_lat, lat + delta_lat, lon - delta_lon, lon + delta_lon)).fetchall()
    finally:
        con.close()
    out = []
    for n, t, la, lo, diam in rows:
        d = compute_great_circle_distance(radius_km, lat, lon, la, lo)
        if d <= max_dist_km:
            out.append({"name": n, "type": t, "dist_km": round(d, 1), "diameter_km": diam})
    out.sort(key=lambda x: x["dist_km"])
    return out[:3]


def plan_traverse(body: str, start: str, dest: str, num_waypoints: int = 6, activity: str = "rover") -> dict:
    """Plans an expedition traverse with geodesic waypoints, headings, and nearby features."""
    b = body.lower().strip()
    radius_km = ORBITAL_DATA.get(b, {}).get("radius", 3389.5)
    
    lat1, lon1, start_name = resolve_location(b, start)
    lat2, lon2, dest_name = resolve_location(b, dest)
    
    total_km = compute_great_circle_distance(radius_km, lat1, lon1, lat2, lon2)
    init_bearing = compute_initial_bearing(lat1, lon1, lat2, lon2)
    n = max(2, min(15, num_waypoints))
    
    waypoints = []
    prev_lat, prev_lon = lat1, lon1
    for i in range(n):
        f = i / (n - 1)
        w_lat, w_lon = slerp_point(lat1, lon1, lat2, lon2, f)
        leg_km = compute_great_circle_distance(radius_km, prev_lat, prev_lon, w_lat, w_lon) if i > 0 else 0.0
        cum_km = compute_great_circle_distance(radius_km, lat1, lon1, w_lat, w_lon)
        bearing = compute_initial_bearing(prev_lat, prev_lon, w_lat, w_lon) if i > 0 else init_bearing
        near = find_features_near(b, w_lat, w_lon, radius_km=radius_km, max_dist_km=25.0)
        
        label = start_name if i == 0 else dest_name if i == n - 1 else f"Waypoint {i}"
        waypoints.append({
            "index": i,
            "name": label,
            "lat": round(w_lat, 4),
            "lon": round(w_lon, 4),
            "leg_dist_km": round(leg_km, 2),
            "cumulative_dist_km": round(cum_km, 2),
            "bearing_deg": round(bearing, 1),
            "nearby_features": near,
        })
        prev_lat, prev_lon = w_lat, w_lon
        
    mid_lat, mid_lon = slerp_point(lat1, lon1, lat2, lon2, 0.5)
    zoom = 13 if total_km < 20 else 10 if total_km < 100 else 7 if total_km < 500 else 5 if total_km < 2000 else 3
    
    # Transit estimates
    robotic_sols = round(total_km / 0.1, 1) # ~100m / sol
    crewed_hours = round(total_km / 8.0, 1) # ~8 km/h LRV
    eva_hours = round(total_km / 3.0, 1)    # ~3 km/h walking
    
    return {
        "body": b.capitalize(),
        "body_id": b,
        "start": {"name": start_name, "lat": round(lat1, 4), "lon": round(lon1, 4)},
        "destination": {"name": dest_name, "lat": round(lat2, 4), "lon": round(lat2, 4)},
        "total_distance_km": round(total_km, 2),
        "total_distance_miles": round(total_km * 0.621371, 2),
        "initial_bearing_deg": round(init_bearing, 1),
        "center": {"lat": round(mid_lat, 4), "lon": round(mid_lon, 4)},
        "recommended_zoom": zoom,
        "transit_estimates": {
            "robotic_rover_sols": robotic_sols,
            "crewed_rover_hours": crewed_hours,
            "eva_walking_hours": eva_hours,
        },
        "waypoints": waypoints,
    }


# ── FASTAPI ROUTES ──────────────────────────────────────────────────────────

# ── live telemetry (NOAA SWPC, JPL CAD, USGS) ───────────────────────────────
# Cached under data/ so the Worlds layers and Atlas keep answering (marked stale) when the internet is down.

async def fetch_space_weather() -> dict:
    """Fetch live planetary space weather from NOAA SWPC."""
    DATA.mkdir(parents=True, exist_ok=True)
    cache_file = DATA / "space_weather.json"
    if cache_file.exists() and time.time() - cache_file.stat().st_mtime < 1800:
        try:
            return json.loads(cache_file.read_text())
        except Exception:
            pass

    url = "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json"
    try:
        async with httpx.AsyncClient(timeout=10, headers=UA, event_hooks=GUARD_HOOKS) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            rows = resp.json()
            latest = rows[-1] if rows else {}
            # Row format: {"time_tag": "...", "Kp": 5.67, "a_running": 67, "station_count": 8}
            kp_raw = latest.get("Kp") if isinstance(latest, dict) else (latest[1] if len(latest) > 1 else 2.0)
            try:
                kp = round(float(kp_raw), 2)
            except (ValueError, TypeError):
                kp = 2.0
            
            # Storm classification
            if kp >= 9:
                storm = "G5 - Extreme Geomagnetic Storm"
            elif kp >= 8:
                storm = "G4 - Severe Geomagnetic Storm"
            elif kp >= 7:
                storm = "G3 - Strong Geomagnetic Storm"
            elif kp >= 6:
                storm = "G2 - Moderate Geomagnetic Storm"
            elif kp >= 5:
                storm = "G1 - Minor Geomagnetic Storm"
            elif kp >= 4:
                storm = "Unsettled"
            else:
                storm = "Quiet to Normal"

            result = {
                "timestamp": latest.get("time_tag") if isinstance(latest, dict) else datetime.now(timezone.utc).isoformat(),
                "kp_index": kp,
                "geomagnetic_condition": storm,
                "aurora_visibility": "High latitudes (Kp 0-3)" if kp < 4 else "Mid-latitudes visible" if kp < 7 else "Low latitudes visible",
                "fetched": time.time()
            }
            cache_file.write_text(json.dumps(result))
            return result
    except Exception as e:  # noqa: BLE001 — offline: serve the last copy
        if cache_file.exists():
            return {**json.loads(cache_file.read_text()), "stale": True}
        return {"kp_index": 2.3, "geomagnetic_condition": "Quiet (Offline default)", "error": str(e)}


async def fetch_near_earth_objects() -> list[dict]:
    """Fetch upcoming close-approach Near-Earth Asteroids (NEOs)."""
    DATA.mkdir(parents=True, exist_ok=True)
    cache_file = DATA / "neo.json"
    if cache_file.exists() and time.time() - cache_file.stat().st_mtime < 21600:
        try:
            return json.loads(cache_file.read_text())
        except Exception:
            pass

    # JPL CAD (Close Approach Data) API
    url = "https://ssd-api.jpl.nasa.gov/cad.api"
    params = {"dist-max": "10LD", "date-min": "now", "limit": "10", "sort": "dist"}
    try:
        async with httpx.AsyncClient(timeout=10, headers=UA, event_hooks=GUARD_HOOKS) as client:
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            data = resp.json()
            fields = data.get("fields", [])
            rows = data.get("data", [])
            out = []
            for r in rows:
                item = dict(zip(fields, r))
                des = item.get("des", "Unknown")
                cd = item.get("cd", "")
                dist_ld = float(item.get("dist", 0)) * 389.17  # AU to Lunar Distances (~384,400 km)
                v_rel = float(item.get("v_rel", 0))
                h_mag = float(item.get("h", 25))
                # Approx diameter from absolute magnitude H (assuming albedo 0.14)
                diam_m = round(1329 / math.sqrt(0.14) * (10 ** (-0.2 * h_mag)) * 1000, 1)

                out.append({
                    "designation": des,
                    "close_approach_date": cd,
                    "miss_distance_lunar_distances": round(dist_ld, 2),
                    "miss_distance_km": round(float(item.get("dist", 0)) * AU_KM, 0),
                    "relative_velocity_kms": round(v_rel, 2),
                    "approx_diameter_meters": diam_m,
                    "potential_hazardous": dist_ld < 19.5 and diam_m > 140
                })
            cache_file.write_text(json.dumps(out))
            return out
    except Exception:  # noqa: BLE001 — offline: serve the last copy
        if cache_file.exists():
            return json.loads(cache_file.read_text())
        return []


async def fetch_earthquakes(min_magnitude: float = 2.5, limit: int = 20) -> list[dict]:
    """Fetch live seismic activity from USGS GeoJSON feed."""
    DATA.mkdir(parents=True, exist_ok=True)
    cache_file = DATA / "earthquakes.json"
    if cache_file.exists() and time.time() - cache_file.stat().st_mtime < 600:
        try:
            cached = json.loads(cache_file.read_text())
            return [eq for eq in cached if eq["magnitude"] >= min_magnitude][:limit]
        except Exception:
            pass

    url = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson"
    try:
        async with httpx.AsyncClient(timeout=10, headers=UA, event_hooks=GUARD_HOOKS) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            data = resp.json()
            features = data.get("features", [])
            out = []
            for f in features:
                props = f.get("properties", {})
                geom = f.get("geometry", {})
                coords = geom.get("coordinates", [0, 0, 0])
                mag = props.get("mag")
                if mag is None:
                    continue
                out.append({
                    "id": f.get("id"),
                    "place": props.get("place", "Unknown"),
                    "magnitude": round(float(mag), 1),
                    "time": datetime.fromtimestamp(props.get("time", 0) / 1000.0, tz=timezone.utc).isoformat(),
                    "lon": round(coords[0], 4),
                    "lat": round(coords[1], 4),
                    "depth_km": round(coords[2], 1),
                    "url": props.get("url", "")
                })
            out.sort(key=lambda x: x["magnitude"], reverse=True)
            cache_file.write_text(json.dumps(out))
            return [eq for eq in out if eq["magnitude"] >= min_magnitude][:limit]
    except Exception:  # noqa: BLE001 — offline: serve the last copy
        if cache_file.exists():
            cached = json.loads(cache_file.read_text())
            return [eq for eq in cached if eq["magnitude"] >= min_magnitude][:limit]
        return []


@router.get("/search")
async def search_route(q: str = Query(..., min_length=1), body: str | None = None, limit: int = 15):
    return {"results": search_features(q, body, limit)}


@router.get("/plan_traverse")
async def plan_traverse_route(
    body: str = Query("mars"),
    start: str = Query(...),
    destination: str = Query(...),
    waypoints: int = Query(6)
):
    try:
        return plan_traverse(body, start, destination, waypoints)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.get("/inspect")
async def inspect_route(body: str = Query(...)):
    return inspect_body(body)


@router.get("/ephemeris")
async def ephemeris_route(target: str = Query(...)):
    return compute_ephemeris(target)


@router.get("/sky_view")
async def sky_view_route(body: str = Query("earth"), lat: float = Query(...), lon: float = Query(...)):
    return compute_local_sky(body, lat, lon)


@router.get("/earthquakes.geojson")
async def earthquakes_geojson_route(min_mag: float = 2.5):
    eqs = await fetch_earthquakes(min_magnitude=min_mag, limit=100)
    features = []
    for eq in eqs:
        features.append({
            "type": "Feature",
            "id": eq["id"],
            "properties": {
                "id": eq["id"],
                "mag": eq["magnitude"],
                "place": eq["place"],
                "time": eq["time"],
                "depth_km": eq["depth_km"],
                "url": eq.get("url", "")
            },
            "geometry": {
                "type": "Point",
                "coordinates": [eq["lon"], eq["lat"]]
            }
        })
    return {"type": "FeatureCollection", "features": features}


@router.get("/telemetry")
async def telemetry_route(kind: str = Query("space_weather")):
    if kind == "space_weather":
        return await fetch_space_weather()
    elif kind == "neo" or kind == "asteroids":
        return {"asteroids": await fetch_near_earth_objects()}
    elif kind == "earthquakes":
        return {"earthquakes": await fetch_earthquakes()}
    raise HTTPException(400, "kind must be 'space_weather', 'asteroids', or 'earthquakes'")


# ── AGENT TOOLS ─────────────────────────────────────────────────────────────

async def lookup_planetary_feature_tool(args: dict, ctx: Any) -> ToolResult:
    q = str(args.get("query", "")).strip()
    body = args.get("body")
    if body:
        body = str(body).lower().strip()
    limit = int(args.get("limit") or 8)

    results = search_features(q, body, limit)
    if not results:
        return ToolResult(f"No planetary features matching '{q}' found on {body.capitalize() if body else 'any world'}.")

    lines = [f"Found {len(results)} planetary feature(s) for '{q}':"]
    for r in results:
        diam_txt = f" · {r['diameter_km']} km across" if r['diameter_km'] > 0 else ""
        lines.append(f"• **{r['name']}** ({r['body'].capitalize()}) — {r['type']}{diam_txt}")
        lines.append(f"  Coordinates: {r['lat']}°, {r['lon']}° | Origin: {r['origin']}")

    # Provide map card handoff
    first = results[0]
    map_spec = {
        "title": f"{first['name']} ({first['body'].capitalize()})",
        "body": first["body"],
        "markers": [{"lat": r["lat"], "lon": r["lon"], "label": r["name"], "note": r["type"]} for r in results[:5]],
        "center": {"lat": first["lat"], "lon": first["lon"]},
        "zoom": 6 if first["body"] != "earth" else 10
    }
    spec_json = json.dumps(map_spec, indent=2)
    lines.append(f"\nRender in chat and fly to in Worlds with:\n```map\n{spec_json}\n```")

    return ToolResult("\n".join(lines), {"features": [r["name"] for r in results]})


async def world_inspect_tool(args: dict, ctx: Any) -> ToolResult:
    b = str(args.get("body", "mars")).lower().strip()
    try:
        data = inspect_body(b)
    except HTTPException as e:
        return ToolResult(str(e.detail), error=True)

    summary = (
        f"**{data['name']} — Planetary Science Dossier**\n"
        f"• Radius: {data['radius_km']:,} km | Mass: {data['mass']}\n"
        f"• Surface Gravity: {data['gravity_ms2']} m/s² ({data['gravity_relative_earth']}x Earth gravity)\n"
        f"• Atmosphere: {data['atmosphere']} (Surface Pressure: {data['surface_pressure']})\n"
        f"• Day Length: {data['day_length']} | Surface Temp: {data['surface_temp']}\n"
        f"• Orbit: {data['semi_major_axis_au']} AU ({data['orbital_period_days']} Earth days)\n"
        f"• Named IAU Features in Offline Database: {data['named_features_count']:,}\n"
        f"\nExplore in Worlds: `#/worlds/{b}`"
    )
    return ToolResult(summary, {"world": b})


async def solar_system_ephemeris_tool(args: dict, ctx: Any) -> ToolResult:
    target = str(args.get("target_body", "mars")).lower().strip()
    try:
        eph = compute_ephemeris(target)
    except HTTPException as e:
        return ToolResult(str(e.detail), error=True)

    ht = eph["hohmann_transfer"]
    text = (
        f"**Earth ➔ {eph['target']}** (computed from JPL orbital elements, about 1° accuracy)\n"
        f"• Current distance: {eph['distance_au']} AU ({eph['distance_km']:,.0f} km)\n"
        f"• One-way light time: {eph['light_time_one_way']}\n"
    )
    if ht:
        text += (
            f"• Hohmann transfer: {ht['duration_days']} days (~{round(ht['duration_days']/30.4, 1)} months)\n"
            f"• Heliocentric Δv: {ht['departure_delta_v_kms']} km/s at departure + {ht['arrival_delta_v_kms']} km/s at arrival = {ht['total_delta_v_kms']} km/s\n"
            f"• Launch windows recur every {ht['synodic_window_days']} days\n"
            f"• {ht['note']}"
        )
    return ToolResult(text, {"target": target, "distance_au": eph["distance_au"]})


async def planetary_telemetry_tool(args: dict, ctx: Any) -> ToolResult:
    kind = str(args.get("kind", "space_weather")).lower().strip()
    if kind in ("space_weather", "aurora", "solar"):
        sw = await fetch_space_weather()
        text = (
            f"**NOAA Space Weather & Solar Telemetry**\n"
            f"• Planetary Kp Index: {sw['kp_index']}\n"
            f"• Geomagnetic Activity: {sw['geomagnetic_condition']}\n"
            f"• Aurora Forecast: {sw['aurora_visibility']}\n"
            f"• Telemetry Timestamp: {sw['timestamp']}"
        )
        return ToolResult(text, {"kp": sw["kp_index"]})
    elif kind in ("neo", "asteroids", "close_approach"):
        neos = await fetch_near_earth_objects()
        if not neos:
            return ToolResult("No imminent close-approach near-Earth asteroids recorded.")
        lines = [f"**Upcoming Near-Earth Asteroid Close Approaches (NASA JPL):**"]
        for n in neos[:5]:
            haz = " ⚠️ [POTENTIALLY HAZARDOUS]" if n["potential_hazardous"] else ""
            lines.append(f"• **{n['designation']}** ({n['close_approach_date']}){haz}")
            lines.append(f"  Miss Distance: {n['miss_distance_lunar_distances']} Lunar Distances ({n['miss_distance_km']:,} km) | Relative Speed: {n['relative_velocity_kms']} km/s | Approx Diameter: ~{n['approx_diameter_meters']} m")
        return ToolResult("\n".join(lines), {"count": len(neos)})
    elif kind in ("earthquakes", "seismic"):
        min_mag = float(args.get("min_magnitude", 4.0))
        eqs = await fetch_earthquakes(min_magnitude=min_mag, limit=6)
        if not eqs:
            return ToolResult(f"No recent earthquakes ≥ M{min_mag} recorded in past 24h.")
        lines = [f"**Global Seismic Activity (USGS GeoJSON Feed ≥ M{min_mag}):**"]
        markers = []
        for eq in eqs:
            lines.append(f"• **M{eq['magnitude']}** — {eq['place']} (Depth: {eq['depth_km']} km, {eq['time']})")
            markers.append({"lat": eq["lat"], "lon": eq["lon"], "label": f"M{eq['magnitude']} {eq['place']}", "note": f"Depth: {eq['depth_km']}km"})
        
        map_spec = {
            "title": f"Live Earthquakes (≥ M{min_mag})",
            "body": "earth",
            "markers": markers,
            "center": {"lat": eqs[0]["lat"], "lon": eqs[0]["lon"]},
            "zoom": 3
        }
        lines.append(f"\n```map\n{json.dumps(map_spec, indent=2)}\n```")
        return ToolResult("\n".join(lines), {"count": len(eqs)})
    else:
        return ToolResult(f"Unknown telemetry kind '{kind}'. Options: 'space_weather', 'asteroids', 'earthquakes'.", error=True)


async def local_sky_view_tool(args: dict, ctx: Any) -> ToolResult:
    b = str(args.get("body", "earth")).lower().strip()
    lat = float(args.get("lat", 0.0))
    lon = float(args.get("lon", 0.0))
    try:
        sky = compute_local_sky(b, lat, lon)
    except HTTPException as e:
        return ToolResult(str(e.detail), error=True)
    
    lines = [
        f"**Local Horizon & Sky Simulation: {sky['body']} ({sky['lat']}°, {sky['lon']}°)**",
        f"• Solar Status: {sky['state_label']} (Sun Altitude: {sky['solar_altitude_deg']}°)",
        f"• {sky['note']}",
        f"• Celestial Targets in the Local Sky:"
    ]
    for t in sky["targets"]:
        vis = "Above horizon" if t.get("visible") else "Below horizon"
        alt = f"Alt: {t['alt_deg']}°, Az: {t['az_deg']}°" if "alt_deg" in t else ""
        phase = f"Phase: {t['phase']}" if "phase" in t else f"Illumination: {t.get('illumination', '')}" if "illumination" in t else ""
        note = f" — {t['note']}" if t.get("note") else ""
        lines.append(f"  • **{t['name']}** ({t.get('type', '')}) — {vis} | {alt} {phase}{note}")
        
    return ToolResult("\n".join(lines), {"targets": [t["name"] for t in sky["targets"] if t.get("visible")]})


async def plan_planetary_traverse_tool(args: dict, ctx: Any) -> ToolResult:
    body = str(args.get("body", "mars")).lower().strip()
    start = str(args.get("start", "")).strip()
    dest = str(args.get("destination", "")).strip()
    waypoints_count = int(args.get("waypoints", 6))
    activity = str(args.get("activity", "rover")).lower().strip()
    
    if not start or not dest:
        return ToolResult("Both 'start' and 'destination' must be specified (names or coordinates).", error=True)
        
    try:
        t = plan_traverse(body, start, dest, num_waypoints=waypoints_count, activity=activity)
    except ValueError as e:
        return ToolResult(f"Traverse Planning Error: {e}", error=True)
        
    lines = [
        f"### 🧭 Expedition Traverse: {t['start']['name']} ➔ {t['destination']['name']} ({t['body']})",
        f"- **Total Geodesic Distance**: **{t['total_distance_km']} km** ({t['total_distance_miles']} miles)",
        f"- **Initial Compass Heading**: {t['initial_bearing_deg']}°",
        f"- **Estimated Travel Times**:"
    ]
    if body == "earth":
        lines.append(f"  • Ground Vehicle (~60 km/h): {round(t['total_distance_km'] / 60.0, 1)} hours")
        lines.append(f"  • Foot / Trek (~4 km/h): {round(t['total_distance_km'] / 4.0, 1)} hours")
    else:
        lines.append(f"  • Robotic Rover (~100 m/sol): **{t['transit_estimates']['robotic_rover_sols']} sols**")
        lines.append(f"  • Pressurized Crew Rover (~8 km/h): **{t['transit_estimates']['crewed_rover_hours']} hours**")
        lines.append(f"  • Surface EVA Suit (~3 km/h): **{t['transit_estimates']['eva_walking_hours']} hours**")
        
    lines.append("\n**Waypoints & Terrain Landmarks:**")
    lines.append("| Leg | Waypoint Name | Coordinates | Leg Dist | Total Dist | Bearing | Nearby Features |")
    lines.append("|---|---|---|---|---|---|---|")
    
    map_markers = []
    map_pts = []
    
    for wp in t["waypoints"]:
        near_str = ", ".join(f"{nf['name']} ({nf['dist_km']}km)" for nf in wp["nearby_features"]) if wp["nearby_features"] else "Open plains"
        lines.append(f"| {wp['index']} | **{wp['name']}** | {wp['lat']}°, {wp['lon']}° | {wp['leg_dist_km']} km | {wp['cumulative_dist_km']} km | {wp['bearing_deg']}° | {near_str} |")
        
        color = "#10b981" if wp["index"] == 0 else "#f43f5e" if wp["index"] == len(t["waypoints"]) - 1 else "#f59e0b"
        map_markers.append({
            "lat": wp["lat"],
            "lon": wp["lon"],
            "label": f"WP {wp['index']}: {wp['name']}",
            "color": color
        })
        map_pts.append([wp["lat"], wp["lon"]])
        
    map_spec = {
        "body": t["body_id"],
        "title": f"Traverse: {t['start']['name']} to {t['destination']['name']}",
        "center": t["center"],
        "zoom": t["recommended_zoom"],
        "markers": map_markers,
        "lines": [{
            "points": map_pts,
            "color": "#f59e0b",
            "label": f"{t['total_distance_km']} km Route"
        }]
    }
    
    lines.append("\n```map")
    lines.append(json.dumps(map_spec, indent=2))
    lines.append("```")
    
    return ToolResult("\n".join(lines), {"traverse": t})


def register():
    TOOLS["lookup_planetary_feature"] = {
        "fn": lookup_planetary_feature_tool, "service": None,
        "ui": {"displayName": "Planetary Gazetteer", "icon": "Orbit", "category": "web",
               "description": "Offline search over 15,700 IAU planetary craters, mountains, and historic landing sites across 21 worlds."},
        "schema": _fn("lookup_planetary_feature",
                      "Look up named planetary features (craters, chasmata, montes, maria, landing sites) across Moon, Mars, "
                      "Mercury, Venus, Titan, Europa, and all solar system worlds from the offline IAU database.",
                      {"query": {"type": "string", "description": "Feature name or mission, e.g. 'Olympus Mons', 'Tycho', 'Curiosity'"},
                       "body": {"type": "string", "description": "Optional body filter: 'mars', 'moon', 'mercury', 'venus', 'titan', etc."},
                       "limit": {"type": "integer", "description": "Maximum results (default 8)"}},
                      ["query"]),
    }
    TOOLS["world_inspect"] = {
        "fn": world_inspect_tool, "service": None,
        "ui": {"displayName": "World Dossier", "icon": "Globe", "category": "web",
               "description": "Scientific parameters, gravity, atmosphere, day length, and orbital statistics for all 22 worlds."},
        "schema": _fn("world_inspect",
                      "Retrieve comprehensive scientific parameters for any solar system body (radius, gravity, atmosphere, "
                      "surface pressure, day length, temperature ranges, orbital periods).",
                      {"body": {"type": "string", "description": "Body name: 'earth', 'mars', 'moon', 'titan', 'europa', 'venus', etc."}},
                      ["body"]),
    }
    TOOLS["solar_system_ephemeris"] = {
        "fn": solar_system_ephemeris_tool, "service": None,
        "ui": {"displayName": "Ephemeris & Trajectories", "icon": "Compass", "category": "web",
               "description": "Calculates planetary distances, light-speed delay, and Hohmann transfer orbit delta-v & transit days."},
        "schema": _fn("solar_system_ephemeris",
                      "Calculate current distance from Earth (AU and km), light-time communications delay, and Hohmann transfer "
                      "orbit requirements (transit duration in days, delta-v required) to any planet or moon.",
                      {"target_body": {"type": "string", "description": "Target body, e.g. 'mars', 'venus', 'mercury', 'jupiter', 'saturn', 'titan'"}},
                      ["target_body"]),
    }
    TOOLS["planetary_telemetry"] = {
        "fn": planetary_telemetry_tool, "service": None,
        "ui": {"displayName": "Planetary Telemetry", "icon": "Activity", "category": "web",
               "description": "Live space weather (NOAA SWPC Kp index), close-approach asteroids (NASA JPL), and global earthquakes (USGS)."},
        "schema": _fn("planetary_telemetry",
                      "Query live real-time space and Earth telemetry: 'space_weather' (Kp-index, geomagnetic storm level, aurora), "
                      "'asteroids' (NASA near-Earth asteroid close approaches), or 'earthquakes' (USGS live seismic tremors).",
                      {"kind": {"type": "string", "enum": ["space_weather", "asteroids", "earthquakes"]},
                       "min_magnitude": {"type": "number", "description": "For earthquakes: minimum Richter magnitude (default 4.0)"}},
                      ["kind"]),
    }
    TOOLS["local_sky_view"] = {
        "fn": local_sky_view_tool, "service": None,
        "ui": {"displayName": "Local Horizon & Sky", "icon": "Eye", "category": "web",
               "description": "Simulate celestial visibility, Sun altitude, Earthrise, and visible planets from any surface location on Earth, Mars, or the Moon."},
        "schema": _fn("local_sky_view",
                      "Simulate what an observer looking up into the sky from the surface of Earth, Mars, or the Moon would see right now "
                      "(Sun altitude, day/twilight/night state, visible planets, Earth in Martian/Lunar sky, Phobos/Deimos transits).",
                      {"body": {"type": "string", "description": "Body name: 'earth', 'mars', 'moon'"},
                       "lat": {"type": "number", "description": "Observer latitude in decimal degrees"},
                       "lon": {"type": "number", "description": "Observer longitude in decimal degrees"}},
                      ["lat", "lon"]),
    }
    TOOLS["plan_planetary_traverse"] = {
        "fn": plan_planetary_traverse_tool, "service": None,
        "ui": {"displayName": "Expedition Traverse Planner", "icon": "Navigation", "category": "web",
               "description": "Plan great-circle expeditions and rover traverses across Mars, Moon, Mercury or Earth with waypoint landmarks and map overlays."},
        "schema": _fn("plan_planetary_traverse",
                      "Plan an exploration traverse or rover expedition between two named features or coordinates on Mars, Moon, Mercury, or Earth. "
                      "Generates great-circle geodesic waypoints, distance, bearing, nearby IAU craters/landmarks, and interactive map card with flythrough.",
                      {"body": {"type": "string", "description": "Celestial body: 'mars', 'moon', 'mercury', 'earth', etc."},
                       "start": {"type": "string", "description": "Starting crater/landmark name or 'lat, lon'"},
                       "destination": {"type": "string", "description": "Destination crater/landmark name or 'lat, lon'"},
                       "waypoints": {"type": "integer", "description": "Number of waypoints along the route (default 6, range 2-15)"},
                       "activity": {"type": "string", "enum": ["rover", "crewed", "eva", "flight"], "description": "Expedition mode"}},
                      ["start", "destination"]),
    }
