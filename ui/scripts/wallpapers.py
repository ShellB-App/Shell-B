#!/usr/bin/env python3
"""Regenerate the kiosk desktop wallpapers in src/kiosk/wallpapers/ (run from ui/; no dependencies).

Each wallpaper is a layered landscape drawn at 2560×1600 with preserveAspectRatio "xMidYMax slice": the horizon and
the ground stay anchored to the bottom edge and the middle stays in frame, so the same file fills a 16:9 monitor,
an ultrawide or a portrait tablet without anything important being cut off. Nothing in them is text, and the top
third (behind the top bar and the desktop icons) is kept calm and fairly dark so labels stay readable.

Ridges, trees and stars come from seeded noise, so a re-run gives the same files. A fine grain over every scene keeps
the long dark gradients from banding on 8-bit panels.
"""
import math
import pathlib
import random
import re

W, H = 2560, 1600
OUT = pathlib.Path(__file__).resolve().parent.parent / 'src' / 'kiosk' / 'wallpapers'
SCENERY = pathlib.Path(__file__).resolve().parent.parent / 'src' / 'themes' / 'scenery'


def f(v):
    return f'{v:.1f}'.rstrip('0').rstrip('.')


def mix(a, b, t):
    a, b = a.lstrip('#'), b.lstrip('#')
    ca = [int(a[i:i + 2], 16) for i in (0, 2, 4)]
    cb = [int(b[i:i + 2], 16) for i in (0, 2, 4)]
    return '#' + ''.join(f'{round(x + (y - x) * t):02x}' for x, y in zip(ca, cb))


def noise(seed, octaves=5, base=2.0, persistence=0.5):
    """A smooth 1-D function of x in [0, W], roughly in [-1, 1]: summed sines with seeded phases."""
    rnd = random.Random(seed)
    waves = []
    amp, freq, total = 1.0, base, 0.0
    for _ in range(octaves):
        waves.append((amp, freq * rnd.uniform(0.8, 1.25), rnd.uniform(0, math.tau)))
        total += amp
        amp *= persistence
        freq *= 2.1
    return lambda x: sum(a * math.sin(math.tau * fr * x / W + ph) for a, fr, ph in waves) / total


def ridge(base_y, amp, seed, *, octaves=6, base=1.6, peaky=False, step=6, bottom=H + 2):
    n = noise(seed, octaves, base)
    pts = []
    for x in range(-step * 2, W + step * 3, step):
        v = n(x)
        if peaky:  # ridged noise: sharp summits, rounded valleys
            v = 1 - 2 * abs(v)
        pts.append((x, base_y - amp * v))
    d = f'M{f(pts[0][0])} {bottom} ' + ' '.join(f'L{f(x)} {f(y)}' for x, y in pts) + f' L{f(pts[-1][0])} {bottom}Z'
    return d, lambda x: base_y - amp * ((1 - 2 * abs(n(x))) if peaky else n(x))


def stars(seed, count, top, bottom, color='#ffffff', max_r=1.7):
    rnd = random.Random(seed)
    out = []
    for _ in range(count):
        x, y = rnd.uniform(0, W), top + (bottom - top) * rnd.random() ** 1.6  # thinner toward the horizon
        r = max_r * rnd.random() ** 2.5 + 0.5
        o = 0.25 + 0.65 * rnd.random() * (1 - (y - top) / (bottom - top)) ** 0.5
        out.append(f'<circle cx="{f(x)}" cy="{f(y)}" r="{f(r)}" fill="{color}" opacity="{o:.2f}"/>')
    return '<g>' + ''.join(out) + '</g>'


def pines(seed, base_y, amp, *, min_h, max_h, gap, wobble_seed=None, ground=None, floor=True):
    """A treeline: one path of tiered conifers standing on a gentle ridge, plus the ground under it."""
    rnd = random.Random(seed)
    if ground is None:
        n = noise(wobble_seed if wobble_seed is not None else seed + 1, 4, 1.2)
        ground = lambda x: base_y - amp * n(x)
    parts = []
    x = -20.0
    while x < W + 20:
        h = rnd.uniform(min_h, max_h) * (0.75 + 0.5 * rnd.random() ** 2)
        w = h * rnd.uniform(0.28, 0.36)
        y0 = ground(x) + 4
        tiers = 4 if h > 60 else 3
        left, right = [], []
        for i in range(tiers + 1):
            t = i / tiers
            ty = y0 - h + h * t
            tw = w * (0.12 + 0.88 * t) / 2
            left.append((x - tw, ty))
            right.append((x + tw, ty))
            if 0 < i < tiers:  # notch back in under each tier
                left.append((x - tw * 0.55, ty + h * 0.04))
                right.append((x + tw * 0.55, ty + h * 0.04))
        pts = [(x, y0 - h - h * 0.06)] + right + [(x + w * 0.06, y0 + 6), (x - w * 0.06, y0 + 6)] + left[::-1]
        parts.append('M' + ' L'.join(f'{f(px)} {f(py)}' for px, py in pts) + 'Z')
        x += gap * rnd.uniform(0.35, 1.3)
    if not floor:
        return ''.join(parts)
    return ''.join(parts) + 'M-20 ' + f(H + 2) + ' ' + ' '.join(f'L{x} {f(ground(x) + 2)}' for x in range(-20, W + 40, 12)) + f' L{W + 40} {H + 2}Z'


GRAIN = (
    '<filter id="grain" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">'
    '<feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="4" stitchTiles="stitch"/>'
    '<feColorMatrix type="saturate" values="0"/></filter>'
)
GRAIN_RECT = f'<rect width="{W}" height="{H}" filter="url(#grain)" opacity="0.32" style="mix-blend-mode:overlay"/>'


def svg(defs, body):
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" '
        f'preserveAspectRatio="xMidYMax slice"><defs>{GRAIN}{defs}</defs>{body}{GRAIN_RECT}</svg>\n'
    )


def sky(id_, stops):
    s = ''.join(f'<stop offset="{o}" stop-color="{c}"/>' for o, c in stops)
    return f'<linearGradient id="{id_}" x1="0" y1="0" x2="0" y2="1">{s}</linearGradient>'


def glow(id_, color, stops=((0, 0.9), (0.25, 0.45), (0.6, 0.12), (1, 0))):
    s = ''.join(f'<stop offset="{o}" stop-color="{color}" stop-opacity="{a}"/>' for o, a in stops)
    return f'<radialGradient id="{id_}">{s}</radialGradient>'


def haze_band(y, height, color, opacity):
    """Mist lying in a valley: transparent above, `color` at y, fading out again below."""
    return (f'<rect x="0" y="{f(y - height)}" width="{W}" height="{f(height * 1.6)}" fill="{color}" '
            f'opacity="{opacity}" mask="url(#mist)"/>')


MIST = ('<linearGradient id="mistg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/>'
        '<stop offset="0.62" stop-color="#fff" stop-opacity="1"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>'
        '<mask id="mist" maskContentUnits="objectBoundingBox"><rect width="1" height="1" fill="url(#mistg)"/></mask>')


# ---------------------------------------------------------------------------------------------------------------------

def alpenglow():
    """Dusk over a mountain range: ridge after ridge fading into the haze, the sun just gone behind them."""
    defs = sky('sky', [(0, '#10173a'), (0.3, '#262a5c'), (0.52, '#5b3f74'), (0.66, '#b0627a'), (0.75, '#ee9a7c'), (0.82, '#ffd2a0')])
    defs += glow('sun', '#fff1d6') + MIST
    body = f'<rect width="{W}" height="{H}" fill="url(#sky)"/>'
    body += stars(11, 140, 0, H * 0.4, max_r=1.5)
    body += f'<ellipse cx="{W * 0.6}" cy="{H * 0.66}" rx="{W * 0.38}" ry="{H * 0.26}" fill="url(#sun)"/>'
    far, near = '#d78a8a', '#130f24'
    layers = [(0.68, 150, 3), (0.73, 130, 5), (0.79, 120, 8), (0.86, 100, 13), (0.94, 70, 21)]
    for i, (by, amp, seed) in enumerate(layers):
        t = i / (len(layers) - 1)
        d, _ = ridge(H * by, amp, seed, peaky=True, base=0.55 + 0.25 * i, octaves=5)
        body += f'<path d="{d}" fill="{mix(far, near, t ** 0.8)}"/>'
        if i < len(layers) - 1:
            body += haze_band(H * by + amp * 0.6, 160, mix('#ffc9a6', '#6d4a78', t), 0.35 - 0.05 * i)
    return svg(defs, body)


def night_forest():
    """A clear moonlit night over forested hills, mist in the valleys."""
    defs = sky('sky', [(0, '#040914'), (0.4, '#0a1730'), (0.7, '#16305a'), (0.86, '#2a4c78')])
    defs += glow('moon', '#e8f0ff', ((0, 0.5), (0.18, 0.22), (0.5, 0.06), (1, 0))) + MIST
    body = f'<rect width="{W}" height="{H}" fill="url(#sky)"/>'
    body += stars(3, 520, 0, H * 0.72, max_r=1.9)
    mx, my = W * 0.74, H * 0.24
    body += f'<circle cx="{mx}" cy="{my}" r="520" fill="url(#moon)"/>'
    body += f'<circle cx="{mx}" cy="{my}" r="58" fill="#f4f1e6"/>'
    body += f'<circle cx="{mx + 14}" cy="{my - 10}" r="12" fill="#e2ddcf"/><circle cx="{mx - 18}" cy="{my + 16}" r="8" fill="#e6e1d4"/>'
    d, _ = ridge(H * 0.7, 70, 31, base=1.1, octaves=4)
    body += f'<path d="{d}" fill="#1f3a5e"/>'
    body += haze_band(H * 0.74, 140, '#5f7fa8', 0.35)
    for i, (by, amp, hmin, hmax, gap, col) in enumerate([
        (0.76, 40, 26, 46, 14, '#15294a'),
        (0.83, 50, 42, 78, 22, '#0d1c36'),
        (0.93, 46, 80, 150, 40, '#050c1c'),
    ]):
        body += f'<path d="{pines(40 + i, H * by, amp, min_h=hmin, max_h=hmax, gap=gap)}" fill="{col}"/>'
        if i < 2:
            body += haze_band(H * by + 30, 110, '#5f7fa8', 0.28 - 0.08 * i)
    return svg(defs, body)


def sea_dawn():
    """Calm open sea at sunrise, a path of light on the water."""
    hy = H * 0.6
    defs = sky('sky', [(0, '#141f45'), (0.25, '#2f3c76'), (0.42, '#6c5f97'), (0.52, '#c4809a'), (0.57, '#f3a98e'), (0.6, '#ffd6a8')])
    defs += '<filter id="cloud" x="-20%" y="-200%" width="140%" height="500%"><feGaussianBlur stdDeviation="14 5"/></filter>'
    defs += sky('sea', [(0, '#6d7fa6'), (0.06, '#3f5683'), (0.35, '#1d3360'), (1, '#0a1530')])
    defs += glow('sun', '#fff0d0', ((0, 0.95), (0.12, 0.6), (0.4, 0.15), (1, 0)))
    defs += f'<clipPath id="above"><rect width="{W}" height="{hy}"/></clipPath>'
    defs += ('<linearGradient id="path" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe6bf" stop-opacity="0.9"/>'
             '<stop offset="1" stop-color="#ffe6bf" stop-opacity="0"/></linearGradient>'
             '<mask id="pathm" maskContentUnits="userSpaceOnUse">'
             f'<rect x="0" y="{hy}" width="{W}" height="{H - hy}" fill="url(#path)"/></mask>')
    body = f'<rect width="{W}" height="{H}" fill="url(#sky)"/>'
    body += stars(5, 70, 0, H * 0.3, max_r=1.2)
    # thin clouds catching the light
    rnd = random.Random(8)
    clouds = ''
    for _ in range(7):
        cy = rnd.uniform(H * 0.32, H * 0.55)
        t = (cy - H * 0.32) / (H * 0.23)
        clouds += (f'<ellipse cx="{f(rnd.uniform(0, W))}" cy="{f(cy)}" rx="{f(rnd.uniform(220, 620))}" ry="{f(rnd.uniform(8, 22))}" '
                   f'fill="{mix("#5d5488", "#ffb48f", t)}" opacity="0.5"/>')
    body += f'<g filter="url(#cloud)">{clouds}</g>'
    body += f'<g clip-path="url(#above)"><circle cx="{W / 2}" cy="{hy + 18}" r="700" fill="url(#sun)"/><circle cx="{W / 2}" cy="{hy + 30}" r="92" fill="#fff4dc"/></g>'
    body += f'<rect y="{hy}" width="{W}" height="{H - hy}" fill="url(#sea)"/>'
    # swell lines, closer together near the horizon
    rnd = random.Random(9)
    lines = []
    for i in range(60):
        t = (i / 60) ** 1.9
        y = hy + 6 + t * (H - hy)
        for _ in range(int(6 + 10 * (1 - t))):
            x = rnd.uniform(-100, W)
            lines.append(f'<rect x="{f(x)}" y="{f(y)}" width="{f(rnd.uniform(60, 380) * (0.4 + t))}" height="{f(1 + 3 * t)}" rx="2"/>')
    body += f'<g fill="#9fb4dc" opacity="0.18">{"".join(lines)}</g>'
    # glitter on the water under the sun
    glints = []
    for i in range(240):
        t = rnd.random() ** 1.4
        y = hy + 4 + t * (H - hy)
        spread = 60 + t * 520
        x = W / 2 + rnd.gauss(0, spread / 2.2)
        glints.append(f'<rect x="{f(x - 20 - 60 * t)}" y="{f(y)}" width="{f(40 + 160 * t * rnd.random())}" height="{f(1.5 + 4 * t)}" rx="2"/>')
    body += f'<g fill="#ffe9c6" mask="url(#pathm)">{"".join(glints)}</g>'
    body += f'<rect y="{hy - 1}" width="{W}" height="2" fill="#ffe2bd" opacity="0.6"/>'
    return svg(defs, body)


def kelp_forest():
    """Under the sea: sun rays through blue water, swaying kelp and a whale passing in the distance."""
    defs = sky('sea', [(0, '#1b7a9c'), (0.18, '#0f5878'), (0.5, '#073654'), (1, '#021428')])
    defs += glow('surface', '#bff2ff', ((0, 0.5), (0.4, 0.15), (1, 0)))
    defs += '<filter id="soft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="24"/></filter>'
    defs += ('<linearGradient id="deepg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/>'
             '<stop offset="0.85" stop-color="#fff" stop-opacity="0"/></linearGradient>'
             f'<mask id="deep" maskUnits="userSpaceOnUse" x="0" y="0" width="{W}" height="{H}"><rect width="{W}" height="{H}" fill="url(#deepg)"/></mask>')
    defs += '<filter id="haze" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="3"/></filter>'
    body = f'<rect width="{W}" height="{H}" fill="url(#sea)"/>'
    body += f'<ellipse cx="{W * 0.45}" cy="-80" rx="{W * 0.6}" ry="{H * 0.45}" fill="url(#surface)"/>'
    rnd = random.Random(21)
    rays = []
    for _ in range(9):
        x = rnd.uniform(W * 0.05, W * 0.95)
        w = rnd.uniform(40, 140)
        sk = rnd.uniform(160, 420)
        rays.append(f'<path d="M{f(x - w / 2)} -40 L{f(x + w / 2)} -40 L{f(x + sk + w * 2)} {H} L{f(x + sk - w * 2)} {H}Z" '
                    f'fill="#d8f6ff" opacity="{rnd.uniform(0.05, 0.11):.2f}"/>')
    body += f'<g filter="url(#soft)" mask="url(#deep)">{"".join(rays)}</g>'
    # the whale, far off and blue with distance
    whale = open(SCENERY / 'whale.svg').read()
    paths = ''.join(f'<path d="{d}"/>' for d in re.findall(r"d='([^']+)'", whale))
    body += f'<g transform="translate({W * 0.56} {H * 0.36}) scale(1.35)" fill="#0d5677" filter="url(#haze)">{paths}</g>'
    # distant then near seafloor
    d, _ = ridge(H * 0.87, 46, 23, base=2.4, octaves=5)
    body += f'<path d="{d}" fill="#053049" opacity="0.85"/>'

    def kelp(x0, height, width, color, seed):
        r = random.Random(seed)
        ph, sway = r.uniform(0, math.tau), r.uniform(40, 90)
        pts = [(x0 + sway * math.sin(ph + t * 2.6) * t, H + 10 - height * t) for t in [i / 48 for i in range(49)]]
        stem = 'M' + ' L'.join(f'{f(x)} {f(y)}' for x, y in pts)
        out = f'<path d="{stem}" stroke="{color}" stroke-width="{f(width)}" fill="none" stroke-linecap="round"/>'
        for i in range(3, 47, 2):  # long blades trailing off the stipe, drifting the same way
            x, y = pts[i]
            side = 1 if i % 4 == 1 else -1
            ln = width * r.uniform(5, 8) * (1 - 0.4 * i / 48)
            tipx, tipy = x + side * ln, y - ln * r.uniform(0.25, 0.6)
            out += (f'<path d="M{f(x)} {f(y)} Q{f(x + side * ln * 0.5)} {f(y - ln * 0.6)} {f(tipx)} {f(tipy)} '
                    f'Q{f(x + side * ln * 0.45)} {f(y - ln * 0.05)} {f(x)} {f(y + width * 1.5)}Z" fill="{color}"/>')
        return out

    for x0, hgt, wd, col, s in [(W * 0.07, H * 0.66, 9, '#0b4560', 1), (W * 0.17, H * 0.5, 8, '#0b4560', 2),
                                (W * 0.26, H * 0.36, 7, '#0b4560', 9), (W * 0.36, H * 0.26, 6, '#0b4560', 11),
                                (W * 0.66, H * 0.3, 6, '#0b4560', 12), (W * 0.76, H * 0.4, 7, '#0b4560', 10),
                                (W * 0.84, H * 0.6, 9, '#0b4560', 3), (W * 0.93, H * 0.46, 8, '#0b4560', 4)]:
        body += kelp(x0, hgt, wd, col, s)
    d, _ = ridge(H * 0.93, 34, 27, base=2.2, octaves=5)
    body += f'<path d="{d}" fill="#021a2c"/>'
    for x0, hgt, wd, col, s in [(W * 0.02, H * 0.86, 14, '#032a40', 5), (W * 0.12, H * 0.72, 12, '#032a40', 6),
                                (W * 0.88, H * 0.8, 14, '#032a40', 7), (W * 0.98, H * 0.68, 12, '#032a40', 8)]:
        body += kelp(x0, hgt, wd, col, s)
    bubbles = ''.join(f'<circle cx="{f(rnd.uniform(0, W))}" cy="{f(rnd.uniform(H * 0.15, H * 0.95))}" r="{f(rnd.uniform(1.5, 6))}" '
                      f'fill="none" stroke="#bfefff" stroke-width="1.2" opacity="{rnd.uniform(0.15, 0.4):.2f}"/>' for _ in range(70))
    body += bubbles
    return svg(defs, body)


def desert_dusk():
    """Sand dunes after sunset under a violet sky, the first star out."""
    defs = sky('sky', [(0, '#1c1436'), (0.35, '#3e2652'), (0.58, '#87405a'), (0.7, '#d9785a'), (0.78, '#f4b27c')])
    defs += glow('sun', '#ffd8a0', ((0, 0.8), (0.3, 0.35), (0.7, 0.08), (1, 0)))
    body = f'<rect width="{W}" height="{H}" fill="url(#sky)"/>'
    body += stars(17, 120, 0, H * 0.45, max_r=1.4)
    body += f'<circle cx="{W * 0.3}" cy="{H * 0.16}" r="3.2" fill="#fff6e0"/><circle cx="{W * 0.3}" cy="{H * 0.16}" r="14" fill="#fff6e0" opacity="0.15"/>'
    body += f'<ellipse cx="{W * 0.36}" cy="{H * 0.79}" rx="{W * 0.5}" ry="{H * 0.28}" fill="url(#sun)"/>'
    layers = [(0.74, 50, 51, '#b86a5c', '#8a4a4e'), (0.8, 90, 52, '#c27a58', '#6e3a40'), (0.88, 120, 53, '#a85e44', '#4f2a32'),
              (0.97, 140, 54, '#7e4432', '#2a1620')]
    for i, (by, amp, seed, top, bot) in enumerate(layers):
        d, _ = ridge(H * by, amp, seed, base=0.7 + 0.15 * i, octaves=3)
        defs += sky(f'd{i}', [(0, top), (1, bot)])
        body += f'<path d="{d}" fill="url(#d{i})"/>'
        # the crest catching the last light
        body += f'<path d="{d}" fill="none" stroke="#ffc08a" stroke-width="2" opacity="{0.35 - 0.07 * i:.2f}"/>'
    return svg(defs, body)


def aurora():
    """Northern lights over snowy hills and a dark line of pines."""
    defs = sky('sky', [(0, '#030713'), (0.45, '#081a33'), (0.8, '#123358'), (0.9, '#1d4568')])
    defs += '<filter id="blur" x="-10%" y="-50%" width="120%" height="200%"><feGaussianBlur stdDeviation="28 18"/></filter>'
    defs += ('<linearGradient id="curtain" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8a5cff" stop-opacity="0"/>'
             '<stop offset="0.35" stop-color="#7a6cff" stop-opacity="0.25"/><stop offset="0.75" stop-color="#3dffb0" stop-opacity="0.55"/>'
             '<stop offset="1" stop-color="#7dffcf" stop-opacity="0"/></linearGradient>')
    defs += sky('snow', [(0, '#7d93b4'), (1, '#3b5274')])
    defs += sky('snow2', [(0, '#93a8c6'), (1, '#3e5478')])
    body = f'<rect width="{W}" height="{H}" fill="url(#sky)"/>'
    body += stars(7, 420, 0, H * 0.7, max_r=1.7)
    bands = []
    for i, (cy, amp, height, seed) in enumerate([(0.5, 110, 330, 61), (0.4, 80, 260, 62), (0.58, 60, 200, 63)]):
        n = noise(seed, 3, 0.8)
        top = [(x, H * cy - amp * n(x) - height * (0.7 + 0.3 * n(x * 1.7 + 400))) for x in range(-100, W + 120, 20)]
        bot = [(x, H * cy - amp * n(x)) for x in range(W + 100, -120, -20)]
        dpath = 'M' + ' L'.join(f'{f(x)} {f(y)}' for x, y in top + bot) + 'Z'
        bands.append(f'<path d="{dpath}" fill="url(#curtain)" opacity="{0.9 - 0.2 * i:.2f}"/>')
    body += f'<g filter="url(#blur)">{"".join(bands)}</g>'
    d, g = ridge(H * 0.78, 80, 71, base=0.8, octaves=4)
    body += f'<path d="{pines(72, 0, 0, min_h=26, max_h=54, gap=30, ground=lambda x: g(x) + 6, floor=False)}" fill="#122640"/>'
    body += f'<path d="{d}" fill="url(#snow)"/>'
    d, g = ridge(H * 0.9, 60, 73, base=0.7, octaves=4)
    body += f'<path d="{pines(74, 0, 0, min_h=70, max_h=150, gap=70, ground=lambda x: g(x) + 10, floor=False)}" fill="#071224"/>'
    body += f'<path d="{d}" fill="url(#snow2)"/>'
    return svg(defs, body)


def cave_wall():
    """The painted wall of a cave by torchlight: Lascaux's horses, aurochs and hands on rough limestone."""
    frieze = open(SCENERY / 'lascaux-frieze.svg').read()
    frieze = re.sub(r"id='(\w+)'", r"id='lx-\1'", frieze)
    frieze = re.sub(r"url\(#(\w+)\)", r"url(#lx-\1)", frieze)
    fw = W * 0.86
    fh = fw * 420 / 1600
    frieze = frieze.replace("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1600 420' preserveAspectRatio='xMidYMax slice'>",
                            f"<svg viewBox='0 0 1600 420' x='{f((W - fw) / 2)}' y='{f(H * 0.36)}' width='{f(fw)}' height='{f(fh)}' opacity='0.82'>")
    assert frieze.count('<svg viewBox') == 1, 'lascaux-frieze.svg changed shape; update the replace above'
    defs = sky('wall', [(0, '#5a3a24'), (0.5, '#9a6a42'), (1, '#4a2e1c')])
    defs += ('<filter id="rock" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">'
             '<feTurbulence type="fractalNoise" baseFrequency="0.0022 0.0035" numOctaves="5" seed="12" result="n"/>'
             '<feDiffuseLighting in="n" surfaceScale="38" lighting-color="#ffe2b8" result="lit">'
             '<feDistantLight azimuth="215" elevation="38"/></feDiffuseLighting>'
             '<feComposite in="lit" in2="SourceGraphic" operator="arithmetic" k1="1.15" k2="0" k3="0" k4="0"/></filter>')
    defs += glow('torch', '#ffb766', ((0, 0.45), (0.45, 0.18), (1, 0)))
    defs += ('<radialGradient id="vignette" cx="0.5" cy="0.5" r="0.75"><stop offset="0.45" stop-color="#120a06" stop-opacity="0"/>'
             '<stop offset="1" stop-color="#120a06" stop-opacity="0.85"/></radialGradient>')
    body = f'<rect width="{W}" height="{H}" fill="url(#wall)" filter="url(#rock)"/>'
    body += f'<ellipse cx="{W * 0.42}" cy="{H * 0.62}" rx="{W * 0.55}" ry="{H * 0.55}" fill="url(#torch)" style="mix-blend-mode:screen"/>'
    body += frieze.replace('</svg>', '</svg>', 1)
    body += f'<rect width="{W}" height="{H}" fill="url(#vignette)"/>'
    return svg(defs, body)


def graphite():
    """No scene at all: soft graphite with a little light from above."""
    defs = ('<radialGradient id="light" cx="0.5" cy="0.15" r="0.9"><stop offset="0" stop-color="#2a2d36"/>'
            '<stop offset="0.6" stop-color="#14161c"/><stop offset="1" stop-color="#0b0c10"/></radialGradient>')
    return svg(defs, f'<rect width="{W}" height="{H}" fill="url(#light)"/>')


SCENES = {
    'alpenglow': alpenglow, 'night-forest': night_forest, 'sea-dawn': sea_dawn, 'kelp-forest': kelp_forest,
    'desert-dusk': desert_dusk, 'aurora': aurora, 'cave-wall': cave_wall, 'graphite': graphite,
}

if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    for name, draw in SCENES.items():
        path = OUT / f'{name}.svg'
        path.write_text(draw())
        print(f'{path.relative_to(OUT.parent.parent.parent)}  {path.stat().st_size // 1024} KB')
