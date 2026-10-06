"""Low-precision solar-system positions and local skies: the Python twin of ui/src/maps/sol.ts + sky.ts.

Planets: JPL "Keplerian Elements for Approximate Positions of the Major Planets" (Standish, table 1, 1800-2050).
Ceres/Vesta: JPL SBDB osculating elements. The Moon: the Astronomical Almanac low-precision series. Other moons
sit at their planet's position (fine for distances and light time, not for their own sky positions).
Skies use the IAU WGCCRE 2015 rotation models. Everything is good to about a degree.
"""
from __future__ import annotations

import math
from datetime import datetime, timezone

AU_KM = 149_597_870.7
C_KMS = 299_792.458
J2000 = 2451545.0
DEG = math.pi / 180
EPS = 23.4392911 * DEG

# a (AU), e, I, L, long. of perihelion, node — then rates per Julian century
PLANETS = {
    "mercury": ((0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593),
                (0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081)),
    "venus": ((0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255),
              (0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418)),
    "earth": ((1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0),
              (0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0)),
    "mars": ((1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891),
             (0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343)),
    "jupiter": ((5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909),
                (-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106)),
    "saturn": ((9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448),
               (-0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794)),
    "uranus": ((19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.95427630, 74.01692503),
               (-0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589)),
    "neptune": ((30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574),
                (0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664)),
    "pluto": ((39.48211675, 0.24882730, 17.14001206, 238.92903833, 224.06891629, 110.30393684),
              (-0.00031596, 0.00005170, 0.00004818, 145.20780515, -0.04062942, -0.01183482)),
}
# a, e, i, node, arg. perihelion, M at epoch, n (deg/day), epoch JD
MINOR = {
    "ceres": (2.765552595034094, 0.07969229514816586, 10.58802780183462, 80.24862682043221, 73.29421453021587, 274.4193463761342, 0.21430445064843, 2461200.5),
    "vesta": (2.361365965127599, 0.09020374382834395, 7.143925545058711, 103.701293265032, 151.4686478221564, 81.19015607686903, 0.2716183613599909, 2461200.5),
}
PARENT = {
    "phobos": "mars", "deimos": "mars",
    "io": "jupiter", "europa": "jupiter", "ganymede": "jupiter", "callisto": "jupiter",
    "mimas": "saturn", "enceladus": "saturn", "tethys": "saturn", "dione": "saturn", "rhea": "saturn", "titan": "saturn", "iapetus": "saturn",
    "miranda": "uranus", "ariel": "uranus", "umbriel": "uranus", "titania": "uranus", "oberon": "uranus",
    "triton": "neptune", "charon": "pluto",
}
NAMES = {k: k.capitalize() for k in [*PLANETS, *MINOR, *PARENT, "moon"]}
NAMES["sol"] = "Sun"


def jd(dt: datetime) -> float:
    return dt.timestamp() / 86400.0 + 2440587.5


def _kepler(M: float, e: float) -> float:
    M = (M + math.pi) % (2 * math.pi) - math.pi
    E = M + e * math.sin(M)
    for _ in range(12):
        d = (E - e * math.sin(E) - M) / (1 - e * math.cos(E))
        E -= d
        if abs(d) < 1e-12:
            break
    return E


def _rotate(xp, yp, w, O, I):
    cw, sw, cO, sO, cI, sI = math.cos(w), math.sin(w), math.cos(O), math.sin(O), math.cos(I), math.sin(I)
    return ((cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp,
            (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp,
            sw * sI * xp + cw * sI * yp)


def _orbit(id_: str, JD: float):
    if id_ in PLANETS:
        T = (JD - J2000) / 36525
        a, e, I, L, wbar, O = (v + r * T for v, r in zip(*PLANETS[id_]))
        return a, e, I * DEG, O * DEG, (wbar - O) * DEG, (L - wbar) * DEG
    if id_ in MINOR:
        a, e, i, O, w, M0, n, ep = MINOR[id_]
        return a, e, i * DEG, O * DEG, w * DEG, (M0 + n * (JD - ep)) * DEG
    return None


def semi_major_au(id_: str) -> float | None:
    host = "earth" if id_ == "moon" else PARENT.get(id_, id_)
    o = _orbit(host, J2000)
    return o[0] if o else None


def _moon_geo(JD: float):
    T = (JD - J2000) / 36525
    s = lambda a, b: math.sin((a + b * T) * DEG)  # noqa: E731
    c = lambda a, b: math.cos((a + b * T) * DEG)  # noqa: E731
    lon = (218.32 + 481267.881 * T + 6.29 * s(135.0, 477198.87) - 1.27 * s(259.3, -413335.36) + 0.66 * s(235.7, 890534.22)
           + 0.21 * s(269.9, 954397.74) - 0.19 * s(357.5, 35999.05) - 0.11 * s(186.5, 966404.03) - 1.397 * T)
    lat = 5.13 * s(93.3, 483202.02) + 0.28 * s(228.2, 960400.89) - 0.28 * s(318.3, 6003.15) - 0.17 * s(217.6, -407332.21)
    par = 0.9508 + 0.0518 * c(135.0, 477198.87) + 0.0095 * c(259.3, -413335.36) + 0.0078 * c(235.7, 890534.22) + 0.0028 * c(269.9, 954397.74)
    r = 6378.14 / math.sin(par * DEG) / AU_KM
    return (r * math.cos(lat * DEG) * math.cos(lon * DEG), r * math.cos(lat * DEG) * math.sin(lon * DEG), r * math.sin(lat * DEG))


def positions(dt: datetime) -> dict[str, tuple[float, float, float]]:
    """Heliocentric J2000-ecliptic positions in AU."""
    JD = jd(dt)
    out = {"sol": (0.0, 0.0, 0.0)}
    for id_ in [*PLANETS, *MINOR]:
        a, e, I, O, w, M = _orbit(id_, JD)
        E = _kepler(M, e)
        out[id_] = _rotate(a * (math.cos(E) - e), a * math.sqrt(1 - e * e) * math.sin(E), w, O, I)
    m, bc, k = _moon_geo(JD), out["earth"], 1 / 82.3  # table's "earth" is the Earth-Moon barycentre
    out["earth"] = tuple(bc[i] - m[i] * k for i in range(3))
    out["moon"] = tuple(out["earth"][i] + m[i] for i in range(3))
    for moon, planet in PARENT.items():
        out[moon] = out[planet]
    return out


def _dist(a, b):
    return math.dist(a, b)


def earth_link(target: str, dt: datetime | None = None) -> dict | None:
    """Distance and light time from Earth now, plus an idealised heliocentric Hohmann transfer."""
    dt = dt or datetime.now(timezone.utc)
    P = positions(dt)
    t = target.lower().strip()
    if t not in P or t in ("earth", "sol"):
        return None
    au = _dist(P[t], P["earth"])
    km = au * AU_KM
    out = {"target": NAMES.get(t, t.capitalize()), "timestamp": dt.isoformat(), "distance_au": round(au, 4),
           "distance_km": round(km, 1), "light_time_seconds": round(km / C_KMS, 2), "hohmann_transfer": None}
    r1, r2 = semi_major_au("earth"), semi_major_au(t)
    if r2 and t != "moon" and abs(r2 - r1) > 0.01:
        V1 = 29.7847
        at = (r1 + r2) / 2
        dv1 = V1 / math.sqrt(r1) * abs(math.sqrt(r2 / at) - 1)
        dv2 = V1 / math.sqrt(r2) * abs(1 - math.sqrt(r1 / at))
        T1, T2 = r1 ** 1.5, r2 ** 1.5
        out["hohmann_transfer"] = {
            "duration_days": round(0.5 * at ** 1.5 * 365.25, 1),
            "departure_delta_v_kms": round(dv1, 3), "arrival_delta_v_kms": round(dv2, 3), "total_delta_v_kms": round(dv1 + dv2, 3),
            "synodic_window_days": round(365.25 / abs(1 / T1 - 1 / T2), 1),
            "note": "Heliocentric orbit-to-orbit Δv only; excludes escaping Earth and capturing at the target." + (
                f" Targets {PARENT[t].capitalize()}'s orbit." if t in PARENT else ""),
        }
    return out


# IAU rotation models: (pole RA, pole Dec, prime meridian W) in degrees for d days / T centuries from J2000
def _rot_earth(d, T): return -0.641 * T, 90 - 0.557 * T, 190.147 + 360.9856235 * d
def _rot_mercury(d, T): return 281.0103 - 0.0328 * T, 61.4155 - 0.0049 * T, 329.5988 + 6.1385108 * d
def _rot_venus(d, T): return 272.76, 67.16, 160.2 - 1.4813688 * d
def _rot_mars(d, T): return 317.269202 - 0.10927547 * T, 54.432516 - 0.05827105 * T, 176.049863 + 350.891982443297 * d
def _rot_moon(d, T):
    E1 = (125.045 - 0.0529921 * d) * DEG
    return 269.9949 + 0.0031 * T - 3.8787 * math.sin(E1), 66.5392 + 0.013 * T + 1.5419 * math.cos(E1), 38.3213 + 13.17635815 * d + 3.561 * math.sin(E1)


ROTATION = {"earth": _rot_earth, "moon": _rot_moon, "mercury": _rot_mercury, "venus": _rot_venus, "mars": _rot_mars}
RADIUS_KM = {"earth": 6371.0, "moon": 1737.4, "mercury": 2439.7, "venus": 6051.8, "mars": 3389.5}


def _rz(t, v):
    x, y, z = v
    return (math.cos(t) * x + math.sin(t) * y, -math.sin(t) * x + math.cos(t) * y, z)


def _rx(t, v):
    x, y, z = v
    return (x, math.cos(t) * y + math.sin(t) * z, -math.sin(t) * y + math.cos(t) * z)


def _ecl_to_eq(v):
    x, y, z = v
    return (x, y * math.cos(EPS) - z * math.sin(EPS), y * math.sin(EPS) + z * math.cos(EPS))


def _eq_to_ecl(v):
    x, y, z = v
    return (x, y * math.cos(EPS) + z * math.sin(EPS), -y * math.sin(EPS) + z * math.cos(EPS))


def _unit(v):
    n = math.hypot(*v) or 1.0
    return tuple(c / n for c in v)


def _dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def local_sky(body: str, lat: float, lon: float, dt: datetime | None = None) -> dict | None:
    """Altitude/azimuth of the Sun, planets and near moons from a spot on Earth, the Moon, Mercury, Venus or Mars."""
    dt = dt or datetime.now(timezone.utc)
    b = body.lower().strip()
    if b not in ROTATION:
        return None
    P = positions(dt)
    d = jd(dt) - J2000
    a0, d0, W = ROTATION[b](d, d / 36525)
    to_body = lambda v: _rz(W * DEG, _rx((90 - d0) * DEG, _rz((90 + a0) * DEG, v)))  # noqa: E731
    to_icrf = lambda v: _rz(-(90 + a0) * DEG, _rx(-(90 - d0) * DEG, _rz(-W * DEG, v)))  # noqa: E731
    phi, lam = lat * DEG, lon * DEG
    up = (math.cos(phi) * math.cos(lam), math.cos(phi) * math.sin(lam), math.sin(phi))
    east = (-math.sin(lam), math.cos(lam), 0.0)
    north = (-math.sin(phi) * math.cos(lam), -math.sin(phi) * math.sin(lam), math.cos(phi))
    r = RADIUS_KM[b] / AU_KM
    off = _eq_to_ecl(to_icrf(tuple(c * r for c in up)))
    obs = tuple(P[b][i] + off[i] for i in range(3))

    def look(id_: str) -> dict:
        p = P[id_]
        v = _unit(to_body(_ecl_to_eq(tuple(p[i] - obs[i] for i in range(3)))))
        alt = math.degrees(math.asin(max(-1.0, min(1.0, _dot(v, up)))))
        az = (math.degrees(math.atan2(_dot(v, east), _dot(v, north))) + 360) % 360
        o = {"name": NAMES.get(id_, id_.capitalize()), "alt_deg": round(alt, 1), "az_deg": round(az, 1),
             "distance_km": round(_dist(p, obs) * AU_KM), "visible": alt > 0}
        if id_ != "sol":
            to_sun, to_obs = _unit(tuple(-c for c in p)), _unit(tuple(obs[i] - p[i] for i in range(3)))
            o["illumination"] = f"{round((1 + _dot(to_sun, to_obs)) / 2 * 100)}% lit"
        return o

    sun = look("sol")
    ids = [p for p in PLANETS if p != b] + (["moon"] if b == "earth" else [])
    targets = sorted((look(i) for i in ids), key=lambda t: -t["alt_deg"])
    for t in targets:
        t["type"] = "Moon" if t["name"] == "Moon" else "Dwarf planet" if t["name"] == "Pluto" else "Planet"
    s = sun["alt_deg"]
    state, label = (("day", "Daylight") if s > 0 else ("civil_twilight", "Civil Twilight") if s > -6
                    else ("nautical_twilight", "Nautical Twilight") if s > -12 else ("astronomical_twilight", "Astronomical Twilight")
                    if s > -18 else ("night", "Night Sky"))
    return {"body": NAMES[b], "lat": round(lat, 4), "lon": round(lon, 4), "timestamp": dt.isoformat(),
            "solar_altitude_deg": s, "solar_azimuth_deg": sun["az_deg"], "state": state, "state_label": label,
            "targets": targets, "note": "Computed from JPL orbital elements and IAU rotation models; about 1° accuracy."
            + (" The Sun is up, so only the brightest objects can be seen." if s > 0 and b in ("earth", "mars", "venus") else "")
            + (" Mars's moons Phobos and Deimos are not included." if b == "mars" else "")}
