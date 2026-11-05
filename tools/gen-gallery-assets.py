#!/usr/bin/env python3
"""Generates the Atlas Showcase Gallery's models and textures.

  python3 tools/gen-gallery-assets.py [--from <dir with the original box models>] [--only name,name]

Two kinds of output, both written to demo-domain-b/assets/gallery/ (rewards go to
demo-domain-{a,b}/assets/rewards/):

  * hand-built models (walls, window units, floor, runner, chests, crate, ruby, pickaxe): boxes and
    extrusions with real normals and UVs and procedural textures;
  * "texturized" models: the original untextured box models are read (from --from, default the files
    already in place, kept once in tools/gallery-source/ so a rerun never textures a textured file),
    flattened to world space, given flat normals and UVs, and a procedural texture picked from the
    material colour. The original base colour stays as a tint, so the palette is unchanged.

Textures are JPEG (opaque, power-of-two), tileable, deterministic (fixed seeds), and embedded in each
GLB: gltf-mini.js reads embedded images only (docs/gltf-mini-materials.md).
"""
import io
import json
import math
import os
import struct
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
OUT = os.path.join(REPO, 'demo-domain-b', 'assets', 'gallery')
SRC = os.path.join(REPO, 'tools', 'gallery-source')
REWARD_OUT = [os.path.join(REPO, 'demo-domain-a', 'assets', 'rewards'), os.path.join(REPO, 'demo-domain-b', 'assets', 'rewards')]

WALL_H = 7.34   # side-wall top: meets the underside of the roof slabs at the eaves
WALL_W = 6.0
WALL_T = 0.5


# ---------------------------------------------------------------- noise and textures
def _filt(shape, sx, sy):
    h, w = shape
    fy = np.fft.fftfreq(h)[:, None]
    fx = np.fft.fftfreq(w)[None, :]
    return np.exp(-2 * (np.pi ** 2) * ((sx * fx) ** 2 + (sy * fy) ** 2))


def noise(h, w, sx, sy=None, seed=0):
    """Periodic (tileable) Gaussian-filtered noise, zero mean and unit variance."""
    sy = sx if sy is None else sy
    a = np.random.default_rng(seed).standard_normal((h, w))
    a = np.real(np.fft.ifft2(np.fft.fft2(a) * _filt((h, w), sx, sy)))
    return (a - a.mean()) / (a.std() + 1e-9)


def smooth(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def rgb(a, tint=(1, 1, 1)):
    a = np.clip(a, 0, 1)
    return np.stack([a * tint[0], a * tint[1], a * tint[2]], axis=-1)


def tex_wood(n=256, seed=1):
    g = noise(n, n, 40, 1.4, seed)
    rings = np.sin(2 * np.pi * (np.arange(n)[:, None] / n * 5 + 0.9 * noise(n, n, 18, 4, seed + 1)))
    fine = noise(n, n, 6, 0.5, seed + 2)
    return rgb(0.80 + 0.07 * g + 0.045 * rings + 0.03 * fine, (1.0, 0.965, 0.92))


def tex_plaster(n=256, seed=3):
    return rgb(0.94 + 0.016 * noise(n, n, 7, 7, seed) + 0.012 * noise(n, n, 1.3, 1.3, seed + 1) + 0.008 * noise(n, n, 0.6, 0.6, seed + 2), (1.0, 0.99, 0.97))


def tex_marble(n=256, seed=5):
    base = 0.90 + 0.04 * noise(n, n, 10, 10, seed)
    warp = noise(n, n, 14, 14, seed + 1)
    vein = np.abs(np.sin(2 * np.pi * (np.arange(n)[None, :] / n * 2 + np.arange(n)[:, None] / n * 1 + 0.35 * warp)))
    base = base - 0.18 * (1 - smooth(0.0, 0.07, vein)) - 0.05 * (1 - smooth(0.0, 0.25, noise(n, n, 5, 5, seed + 2) ** 2))
    return rgb(base, (1.0, 0.985, 0.96))


def tex_brass(n=256, seed=7):
    streak = noise(n, n, 38, 0.7, seed)
    band = 0.5 + 0.5 * np.sin(2 * np.pi * (np.arange(n)[:, None] / n * 2 + 0.3 * noise(n, n, 20, 20, seed + 1)))
    return rgb(0.84 + 0.05 * streak + 0.08 * band * band, (1.0, 0.98, 0.93))


def tex_darkmetal(n=256, seed=9):
    streak = noise(n, n, 42, 0.6, seed)
    scr = noise(n, n, 30, 0.35, seed + 1)
    return rgb(0.86 + 0.06 * streak + 0.035 * scr + 0.02 * noise(n, n, 0.8, 0.8, seed + 2), (0.97, 0.99, 1.0))


def tex_fabric(n=256, seed=11):
    y, x = np.mgrid[0:n, 0:n]
    weave = 0.5 + 0.5 * np.sin(2 * np.pi * x / 8) * np.sin(2 * np.pi * y / 8)
    return rgb(0.84 + 0.07 * weave + 0.04 * noise(n, n, 5, 5, seed) + 0.025 * noise(n, n, 0.7, 0.7, seed + 1))


def tex_leather(n=256, seed=13):
    cells = noise(n, n, 2.2, 2.2, seed)
    crease = 1 - smooth(0.0, 0.12, np.abs(noise(n, n, 4, 4, seed + 1)))
    return rgb(0.87 + 0.05 * cells - 0.10 * crease + 0.03 * noise(n, n, 18, 18, seed + 2), (1.0, 0.98, 0.96))


def tex_leaf(n=256, seed=15):
    veins = 1 - smooth(0.0, 0.10, np.abs(np.sin(2 * np.pi * (np.arange(n)[None, :] / n * 6 + np.arange(n)[:, None] / n * 3))))
    return rgb(0.80 + 0.12 * noise(n, n, 4, 4, seed) - 0.08 * veins + 0.03 * noise(n, n, 0.9, 0.9, seed + 1), (0.98, 1.0, 0.96))


def tex_roof(n=256, seed=17):
    """4 tile columns by 8 rows per tile image (2 m square), alternate rows offset by half a tile."""
    out = np.zeros((n, n, 3))
    rows, cols = 8, 4
    th, tw = n // rows, n // cols
    r = np.random.default_rng(seed)
    grain = noise(n, n, 1.0, 1.0, seed)
    for ry in range(rows):
        for cx in range(cols):
            tone = 0.80 + 0.12 * r.random()
            x0 = (cx * tw + (tw // 2 if ry % 2 else 0)) % n
            for yy in range(th):
                t = yy / th
                shade = tone * (0.80 + 0.28 * (1 - t) ** 0.6) - 0.12 * smooth(0.82, 1.0, np.array(t))
                for xx in range(tw):
                    u = xx / tw
                    s = shade - 0.10 * smooth(0.9, 1.0, np.array(abs(u - 0.5) * 2))
                    out[ry * th + yy, (x0 + xx) % n] = s
    out += 0.025 * grain[..., None]
    return np.clip(out, 0, 1) * np.array([1.0, 0.98, 0.95])


def tex_floor(n=512, seed=19):
    """4 m square image: 1 m stone tiles in two warm tones with grout lines."""
    out = np.zeros((n, n, 3))
    t = n // 4
    r = np.random.default_rng(seed)
    veins = noise(n, n, 6, 6, seed)
    fine = noise(n, n, 1.0, 1.0, seed + 1)
    for ty in range(4):
        for tx in range(4):
            light = (tx + ty) % 2 == 0
            base = np.array([0.80, 0.745, 0.655]) if light else np.array([0.66, 0.61, 0.535])
            base = base * (0.96 + 0.07 * r.random())
            ys, xs = slice(ty * t, (ty + 1) * t), slice(tx * t, (tx + 1) * t)
            m = 1 + 0.03 * veins[ys, xs] + 0.015 * fine[ys, xs]
            out[ys, xs] = base[None, None, :] * m[..., None]
    g = 3
    for k in range(4):
        out[k * t:k * t + g, :] *= 0.55
        out[:, k * t:k * t + g] *= 0.55
        out[(k * t + g):(k * t + g + 1), :] *= 1.12
        out[:, (k * t + g):(k * t + g + 1)] *= 1.12
    return np.clip(out, 0, 1)


def tex_runner(n=256, seed=21):
    """3.2 m wide runner, repeating every 3.2 m: red field, gold border and a diamond lattice."""
    out = np.zeros((n, n, 3))
    red = np.array([0.55, 0.16, 0.17])
    deep = np.array([0.38, 0.09, 0.12])
    gold = np.array([0.86, 0.68, 0.30])
    y, x = np.mgrid[0:n, 0:n]
    u = x / n
    lattice = (np.abs(((u * 4) % 1) - 0.5) + np.abs(((y / n * 4) % 1) - 0.5)) < 0.32
    out[:] = np.where(lattice[..., None], red, deep)
    for lo, hi, col in ((0.03, 0.06, gold), (0.09, 0.105, gold)):
        band = ((u > lo) & (u < hi)) | ((u > 1 - hi) & (u < 1 - lo))
        out[band] = col
    out[u < 0.015] = deep * 0.8
    out[u > 0.985] = deep * 0.8
    out *= (0.94 + 0.05 * noise(n, n, 1.2, 1.2, seed))[..., None]
    out *= (0.97 + 0.03 * noise(n, n, 0.6, 0.6, seed + 1))[..., None]
    return np.clip(out, 0, 1)


def tex_sky(w=256, h=512, seed=23):
    t = np.linspace(0, 1, h)[:, None]
    top = np.array([0.40, 0.64, 0.92])
    hor = np.array([0.86, 0.92, 0.97])
    img = top[None, None, :] * (1 - t[..., None]) + hor[None, None, :] * t[..., None]
    img = np.repeat(img, w, axis=1)
    cl = noise(h, w, 22, 9, seed)
    cl2 = noise(h, w, 9, 4, seed + 1)
    cloud = smooth(0.35, 1.5, cl + 0.5 * cl2) * (0.35 + 0.65 * t)
    return np.clip(img * (1 - 0.8 * cloud[..., None]) + 1.0 * 0.8 * cloud[..., None], 0, 1)


def tex_screen(w=256, h=128, seed=25):
    """Dark-blue display with a header bar and rows of text-like blocks."""
    img = Image.new('RGB', (w, h), (22, 46, 84))
    d = ImageDraw.Draw(img)
    for yy in range(h):
        d.line([(0, yy), (w, yy)], fill=(int(20 + 26 * yy / h), int(44 + 40 * yy / h), int(84 + 52 * yy / h)))
    d.rectangle([8, 8, w - 8, 26], fill=(54, 140, 190))
    r = np.random.default_rng(seed)
    for row in range(5):
        y0 = 38 + row * 16
        x = 14
        while x < w - 30:
            ln = int(14 + r.random() * 46)
            d.rectangle([x, y0, min(x + ln, w - 14), y0 + 6], fill=(168, 212, 236) if row % 2 == 0 else (110, 170, 205))
            x += ln + 8
    d.rectangle([w - 70, h - 22, w - 12, h - 10], fill=(232, 184, 76))
    return np.asarray(img, dtype=float) / 255.0


def tex_wall(w=512, h=1024, seed=27):
    """One full wall-panel face (6 m x WALL_H): baseboard, wainscot, chair rail, plaster, crown moulding."""
    ppm_x, ppm_y = w / WALL_W, h / WALL_H
    img = np.zeros((h, w, 3))
    plaster = tex_plaster(256, seed)
    img[:] = np.tile(plaster, (h // 256 + 1, w // 256 + 1, 1))[:h, :w] * np.array([0.93, 0.87, 0.76])
    wood = np.tile(tex_wood(256, seed + 3), (h // 256 + 1, w // 256 + 1, 1))[:h, :w]

    def band(y0, y1):  # metres from the floor -> pixel rows
        return slice(int(h - y1 * ppm_y), int(h - y0 * ppm_y))

    dark = np.array([0.42, 0.28, 0.18])
    mid = np.array([0.60, 0.42, 0.27])
    light = np.array([0.72, 0.52, 0.32])
    img[band(0.0, 0.22)] = wood[band(0.0, 0.22)] * dark
    img[band(0.22, 1.25)] = wood[band(0.22, 1.25)] * mid
    # raised panels: four per wall, with a lighter bevel on top/left and darker on bottom/right
    for k in range(4):
        x0 = int((k * 1.5 + 0.18) * ppm_x)
        x1 = int((k * 1.5 + 1.32) * ppm_x)
        ys = band(0.38, 1.1)
        img[ys, x0:x1] = wood[ys, x0:x1] * (mid * 0.9)
        b = max(2, int(0.035 * ppm_x))
        img[ys.start:ys.start + b, x0:x1] = wood[ys.start:ys.start + b, x0:x1] * (light * 1.04)
        img[ys.start:ys.stop, x0:x0 + b] = wood[ys.start:ys.stop, x0:x0 + b] * (light * 1.0)
        img[ys.stop - b:ys.stop, x0:x1] = wood[ys.stop - b:ys.stop, x0:x1] * (dark * 0.9)
        img[ys.start:ys.stop, x1 - b:x1] = wood[ys.start:ys.stop, x1 - b:x1] * (dark * 0.95)
    img[band(1.25, 1.42)] = wood[band(1.25, 1.42)] * light
    img[int(h - 1.42 * ppm_y) - 3:int(h - 1.42 * ppm_y)] *= 0.72   # shadow under the rail's top edge
    img[band(1.42, 1.50)] *= 0.86
    # crown moulding: stepped bands
    img[band(WALL_H - 0.46, WALL_H)] = wood[band(WALL_H - 0.46, WALL_H)] * mid
    img[band(WALL_H - 0.30, WALL_H - 0.24)] = wood[band(WALL_H - 0.30, WALL_H - 0.24)] * light
    img[band(WALL_H - 0.50, WALL_H - 0.46)] *= 0.7
    img[band(WALL_H - 0.12, WALL_H)] = wood[band(WALL_H - 0.12, WALL_H)] * dark
    return np.clip(img, 0, 1)


TEXTURES = {
    'wood': tex_wood, 'plaster': tex_plaster, 'marble': tex_marble, 'brass': tex_brass, 'darkmetal': tex_darkmetal,
    'fabric': tex_fabric, 'leather': tex_leather, 'leaf': tex_leaf, 'roof': tex_roof, 'floor': tex_floor,
    'runner': tex_runner, 'sky': tex_sky, 'screen': tex_screen, 'wall': tex_wall,
}
# Metres covered by one image repeat (UV scale) for tiled projection.
TILE_M = {'wood': 1.2, 'plaster': 2.0, 'marble': 1.6, 'brass': 0.7, 'darkmetal': 0.9, 'fabric': 0.6, 'leather': 0.9,
          'leaf': 0.7, 'roof': 2.0, 'floor': 4.0, 'runner': 3.2, 'wall': 2.0}
_tex_cache = {}


def jpeg_of(kind):
    if kind not in _tex_cache:
        arr = (np.clip(TEXTURES[kind](), 0, 1) * 255 + 0.5).astype(np.uint8)
        buf = io.BytesIO()
        Image.fromarray(arr, 'RGB').save(buf, 'JPEG', quality=84, optimize=True, subsampling=0)
        _tex_cache[kind] = buf.getvalue()
    return _tex_cache[kind]


# ---------------------------------------------------------------- geometry
def _rot(rx=0, ry=0, rz=0):
    rx, ry, rz = (math.radians(v) for v in (rx, ry, rz))
    cx, sx, cy, sy, cz, sz = math.cos(rx), math.sin(rx), math.cos(ry), math.sin(ry), math.cos(rz), math.sin(rz)
    mx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
    my = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    mz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
    return my @ mx @ mz


class Prim:
    def __init__(self, mat):
        self.mat = mat
        self.pos, self.nrm, self.uv = [], [], []

    def tri(self, pts, uvs, n):
        for p, t in zip(pts, uvs):
            self.pos.append(p)
            self.uv.append(t)
            self.nrm.append(n)


class Model:
    def __init__(self, name):
        self.name = name
        self.prims = {}

    def prim(self, mat):
        key = json.dumps(mat, sort_keys=True)
        if key not in self.prims:
            self.prims[key] = Prim(mat)
        return self.prims[key]


def mat(tex=None, color=(1, 1, 1), emissive=None, unlit=False, double=True):
    color = list(color)[:3] + [1.0]   # glTF baseColorFactor is RGBA
    m = {'color': [round(float(c), 4) for c in color], 'double': double}
    if tex:
        m['tex'] = tex
    if emissive is not None:
        m['emissive'] = [round(float(c), 4) for c in emissive]
    if unlit:
        m['unlit'] = True
    return m


def unit(v):
    v = np.asarray(v, dtype=float)
    n = np.linalg.norm(v)
    return v / n if n > 1e-12 else v


def proj_uv(p, n, mpt, grain=None):
    """UV for point p on a face with normal n: planar projection in metres / mpt, grain axis along u."""
    p = np.asarray(p, dtype=float)
    if grain is not None:
        g = np.zeros(3)
        g[grain] = 1
        if abs(n[grain]) < 0.7:
            u_ax = g
        else:  # an end face: use a horizontal axis
            u_ax = np.array([1.0, 0, 0]) if grain != 0 else np.array([0, 0, 1.0])
        v_ax = unit(np.cross(n, u_ax))
    elif abs(n[1]) > 0.8:
        u_ax, v_ax = np.array([1.0, 0, 0]), np.array([0, 0, 1.0])
    else:
        u_ax = unit(np.cross([0, 1.0, 0], n))
        v_ax = np.array([0, -1.0, 0])
    return (float(p @ u_ax) / mpt, float(p @ v_ax) / mpt)


FACES = {
    '+z': ((0, 0, 1), [(-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1)]),
    '-z': ((0, 0, -1), [(1, -1, -1), (-1, -1, -1), (-1, 1, -1), (1, 1, -1)]),
    '+x': ((1, 0, 0), [(1, -1, 1), (1, -1, -1), (1, 1, -1), (1, 1, 1)]),
    '-x': ((-1, 0, 0), [(-1, -1, -1), (-1, -1, 1), (-1, 1, 1), (-1, 1, -1)]),
    '+y': ((0, 1, 0), [(-1, 1, 1), (1, 1, 1), (1, 1, -1), (-1, 1, -1)]),
    '-y': ((0, -1, 0), [(-1, -1, -1), (1, -1, -1), (1, -1, 1), (-1, -1, 1)]),
}


def add_box(model, m, c, s, uv='tile', faces=('+x', '-x', '+y', '-y', '+z', '-z'), grain=None, rot=None, tile=None):
    """Axis-aligned box centred on c with full extents s; `rot` (3x3) turns it about its centre.
    uv: 'tile' (metres / TILE_M), 'wall' (the shared wall texture on the +/-z faces, panel-local x/y),
    'span' (the whole image on each face)."""
    prim = model.prim(m)
    c = np.asarray(c, dtype=float)
    h = np.asarray(s, dtype=float) / 2
    R = np.eye(3) if rot is None else rot
    mpt = tile or TILE_M.get(m.get('tex'), 1.0)
    for f in faces:
        n0, corners = FACES[f]
        pts_local = [np.array(k) * h for k in corners]
        pts = [c + R @ p for p in pts_local]
        n = R @ np.array(n0, dtype=float)
        if uv == 'wall' and f in ('+z', '-z'):
            sign = 1 if f == '+z' else -1
            uvs = [((sign * p[0] + 3) / WALL_W, 1 - p[1] / WALL_H) for p in pts]
        elif uv == 'span':
            if f in ('+z', '-z'):
                uvs = [((p_l[0] / (2 * h[0]) + 0.5) * (1 if f == '+z' else -1) + (0 if f == '+z' else 1), 0.5 - p_l[1] / (2 * h[1])) for p_l in pts_local]
            else:
                uvs = [(0.5, 0.5)] * 4
        else:
            uvs = [proj_uv(p, n, mpt, grain) for p in pts]
        prim.tri([pts[0], pts[1], pts[2]], [uvs[0], uvs[1], uvs[2]], n)
        prim.tri([pts[0], pts[2], pts[3]], [uvs[0], uvs[2], uvs[3]], n)


def add_arch(model, m, x0, x1, base_y, z_half, height, segs=9, grow=0.0, caps=True, tile=None):
    """Half-ellipse prism along x: cross-section in (z, y), base at base_y, half-depth z_half, rise `height`."""
    prim = model.prim(m)
    mpt = tile or TILE_M.get(m.get('tex'), 1.0)
    zh, hh = z_half + grow, height + grow
    ang = [math.pi * i / segs for i in range(segs + 1)]
    prof = [(zh * math.cos(a), base_y + hh * math.sin(a)) for a in ang]   # from +z side over the top to -z side
    arc = [0.0]
    for i in range(1, len(prof)):
        arc.append(arc[-1] + math.hypot(prof[i][0] - prof[i - 1][0], prof[i][1] - prof[i - 1][1]))
    for i in range(segs):
        (za, ya), (zb, yb) = prof[i], prof[i + 1]
        p = [np.array([x0, ya, za]), np.array([x1, ya, za]), np.array([x1, yb, zb]), np.array([x0, yb, zb])]
        uvs = [(p[0][0] / mpt, arc[i] / mpt), (p[1][0] / mpt, arc[i] / mpt), (p[2][0] / mpt, arc[i + 1] / mpt), (p[3][0] / mpt, arc[i + 1] / mpt)]
        nrm = unit(np.cross(p[1] - p[0], p[3] - p[0]))
        mid = (p[0] + p[2]) / 2
        if nrm @ np.array([0, mid[1] - base_y, mid[2]]) < 0:   # keep the normal pointing away from the axis
            nrm = -nrm
            p = [p[1], p[0], p[3], p[2]]
            uvs = [uvs[1], uvs[0], uvs[3], uvs[2]]
        prim.tri([p[0], p[1], p[2]], [uvs[0], uvs[1], uvs[2]], nrm)
        prim.tri([p[0], p[2], p[3]], [uvs[0], uvs[2], uvs[3]], nrm)
    if caps:
        for x, sign in ((x0, -1), (x1, 1)):
            n = np.array([sign, 0, 0], dtype=float)
            for i in range(segs):
                (za, ya), (zb, yb) = prof[i], prof[i + 1]
                pts = [np.array([x, base_y, 0]), np.array([x, ya, za]), np.array([x, yb, zb])]
                if np.cross(pts[1] - pts[0], pts[2] - pts[0]) @ n < 0:
                    pts = [pts[0], pts[2], pts[1]]
                prim.tri(pts, [proj_uv(p, n, mpt) for p in pts], n)
        # flat underside
        n = np.array([0, -1, 0], dtype=float)
        pts = [np.array([x0, base_y, -zh]), np.array([x1, base_y, -zh]), np.array([x1, base_y, zh]), np.array([x0, base_y, zh])]
        prim.tri([pts[0], pts[1], pts[2]], [proj_uv(p, n, mpt) for p in pts[:3]], n)
        prim.tri([pts[0], pts[2], pts[3]], [proj_uv(p, n, mpt) for p in (pts[0], pts[2], pts[3])], n)


def add_poly(model, m, tris, flat_uv=0.5):
    """Raw triangles [(p0,p1,p2), ...] with computed flat normals and a single UV (untextured solids)."""
    prim = model.prim(m)
    for a, b, c in tris:
        a, b, c = (np.asarray(v, dtype=float) for v in (a, b, c))
        n = unit(np.cross(b - a, c - a))
        prim.tri([a, b, c], [(flat_uv, flat_uv)] * 3, n)


# ---------------------------------------------------------------- GLB writer
def pad4(b, fill=b'\0'):
    return b + fill * ((4 - len(b) % 4) % 4)


def write_glb(model, path):
    bin_parts, views, accessors, images, textures, materials, meshprims = [], [], [], [], [], [], []
    off = 0

    def add_view(data, target=None):
        nonlocal off
        data = bytes(data)
        v = {'buffer': 0, 'byteOffset': off, 'byteLength': len(data)}
        if target:
            v['target'] = target
        views.append(v)
        bin_parts.append(pad4(data))
        off += len(pad4(data))
        return len(views) - 1

    def add_acc(arr, ctype, atype, target, with_minmax=False):
        a = np.ascontiguousarray(arr)
        view = add_view(a.tobytes(), target)
        acc = {'bufferView': view, 'componentType': ctype, 'count': int(a.shape[0]), 'type': atype}
        if with_minmax:
            acc['min'] = [float(x) for x in a.min(axis=0)]
            acc['max'] = [float(x) for x in a.max(axis=0)]
        accessors.append(acc)
        return len(accessors) - 1

    tex_index = {}
    for prim in model.prims.values():
        if not prim.pos:
            continue
        m = prim.mat
        pos = np.array(prim.pos, dtype='<f4')
        nrm = np.array(prim.nrm, dtype='<f4')
        uv = np.array(prim.uv, dtype='<f4')
        idx = np.arange(len(pos), dtype='<u4')
        attrs = {
            'POSITION': add_acc(pos, 5126, 'VEC3', 34962, True),
            'NORMAL': add_acc(nrm, 5126, 'VEC3', 34962),
        }
        gm = {'pbrMetallicRoughness': {'baseColorFactor': m['color'], 'metallicFactor': 0.0, 'roughnessFactor': 1.0}, 'doubleSided': bool(m.get('double', True))}
        if m.get('tex'):
            attrs['TEXCOORD_0'] = add_acc(uv, 5126, 'VEC2', 34962)
            if m['tex'] not in tex_index:
                images.append({'bufferView': add_view(jpeg_of(m['tex'])), 'mimeType': 'image/jpeg'})
                textures.append({'source': len(images) - 1, 'sampler': 0})
                tex_index[m['tex']] = len(textures) - 1
            gm['pbrMetallicRoughness']['baseColorTexture'] = {'index': tex_index[m['tex']]}
        if m.get('emissive') is not None:
            gm['emissiveFactor'] = m['emissive']
        if m.get('unlit'):
            gm['extensions'] = {'KHR_materials_unlit': {}}
        materials.append(gm)
        meshprims.append({'attributes': attrs, 'indices': add_acc(idx.reshape(-1, 1), 5125, 'SCALAR', 34963), 'mode': 4, 'material': len(materials) - 1})
    doc = {
        'asset': {'version': '2.0', 'generator': 'tools/gen-gallery-assets.py'},
        'scene': 0, 'scenes': [{'nodes': [0]}], 'nodes': [{'name': model.name, 'mesh': 0}],
        'meshes': [{'name': model.name, 'primitives': meshprims}],
        'materials': materials, 'accessors': accessors, 'bufferViews': views,
        'buffers': [{'byteLength': off}],
    }
    if textures:
        doc['images'], doc['textures'] = images, textures
        doc['samplers'] = [{'magFilter': 9729, 'minFilter': 9987, 'wrapS': 10497, 'wrapT': 10497}]
    if any(m.get('unlit') for m in (p.mat for p in model.prims.values())):
        doc['extensionsUsed'] = ['KHR_materials_unlit']
    js = pad4(json.dumps(doc, separators=(',', ':')).encode(), b' ')
    bn = b''.join(bin_parts)
    total = 12 + 8 + len(js) + 8 + len(bn)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(b'glTF' + struct.pack('<II', 2, total))
        f.write(struct.pack('<I', len(js)) + b'JSON' + js)
        f.write(struct.pack('<I', len(bn)) + b'BIN\0' + bn)


# ---------------------------------------------------------------- reading the original box models
def read_glb(path):
    b = open(path, 'rb').read()
    jl = struct.unpack('<I', b[12:16])[0]
    doc = json.loads(b[20:20 + jl])
    off = 20 + jl
    bin_ = b[off + 8:] if off < len(b) else b''
    return doc, bin_


def read_acc(doc, bin_, i):
    acc = doc['accessors'][i]
    view = doc['bufferViews'][acc['bufferView']]
    comp = {5126: '<f4', 5125: '<u4', 5123: '<u2', 5121: 'u1'}[acc['componentType']]
    n = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}[acc['type']]
    a = np.frombuffer(bin_, dtype=comp, count=acc['count'] * n, offset=view.get('byteOffset', 0) + acc.get('byteOffset', 0))
    return a.reshape(-1, n) if n > 1 else a


def node_matrix(node):
    if 'matrix' in node:
        return np.array(node['matrix'], dtype=float).reshape(4, 4).T
    m = np.eye(4)
    if 'rotation' in node:
        x, y, z, w = node['rotation']
        m[:3, :3] = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                              [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                              [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
    if 'scale' in node:
        m[:3, :3] = m[:3, :3] @ np.diag(node['scale'])
    if 'translation' in node:
        m[:3, 3] = node['translation']
    return m


def source_prims(path):
    """[(triangles (n,3,3) in model space, baseColor rgba, mesh extents or None)] for every primitive."""
    doc, bin_ = read_glb(path)
    out = []

    def walk(i, parent):
        node = doc['nodes'][i]
        world = parent @ node_matrix(node)
        if 'mesh' in node:
            for pr in doc['meshes'][node['mesh']]['primitives']:
                if pr.get('mode', 4) != 4:
                    continue
                pos = read_acc(doc, bin_, pr['attributes']['POSITION']).astype(float)
                pos = (np.c_[pos, np.ones(len(pos))] @ world.T)[:, :3]
                idx = read_acc(doc, bin_, pr['indices']).astype(int) if 'indices' in pr else np.arange(len(pos))
                tris = pos[idx.reshape(-1, 3)]
                m = doc['materials'][pr['material']] if 'material' in pr else {}
                color = m.get('pbrMetallicRoughness', {}).get('baseColorFactor', [0.8, 0.8, 0.8, 1.0])
                out.append((tris, color, m))
        for c in node.get('children', []):
            walk(c, world)

    for root in doc['scenes'][doc.get('scene', 0)]['nodes']:
        walk(root, np.eye(4))
    return out


# What a material colour means. The colour stays on the material as the tint; the texture adds detail.
CLASSES = [
    ((0.17, 0.20, 0.25), 'darkmetal'), ((0.13, 0.17, 0.20), 'darkmetal'), ((0.16, 0.12, 0.12), 'darkmetal'),
    ((0.86, 0.65, 0.26), 'brass'), ((0.73, 0.48, 0.22), 'brass'), ((0.74, 0.49, 0.24), 'brass'), ((0.70, 0.46, 0.22), 'brass'),
    ((0.69, 0.55, 0.35), 'brass'), ((0.91, 0.78, 0.52), 'brass'), ((0.84, 0.69, 0.35), 'brass'),
    ((0.46, 0.30, 0.18), 'wood'), ((0.64, 0.45, 0.28), 'wood'), ((0.32, 0.19, 0.12), 'wood'), ((0.28, 0.17, 0.11), 'wood'),
    ((0.26, 0.17, 0.12), 'wood'), ((0.37, 0.23, 0.14), 'wood'), ((0.40, 0.28, 0.19), 'wood'), ((0.56, 0.36, 0.22), 'wood'),
    ((0.29, 0.21, 0.17), 'wood'), ((0.38, 0.27, 0.22), 'wood'),
    ((0.83, 0.78, 0.67), 'marble'), ((0.80, 0.73, 0.60), 'plaster'), ((0.74, 0.67, 0.53), 'plaster'),
    ((0.23, 0.47, 0.32), 'leaf'), ((0.70, 0.54, 0.39), 'roof'), ((0.36, 0.42, 0.45), 'darkmetal'),
]
# Per model: colour -> texture overrides (None keeps the plain colour).
OVERRIDES = {
    'lounge-sofa': {(0.64, 0.45, 0.28): 'leather', (0.46, 0.30, 0.18): 'leather', (0.18, 0.42, 0.69): 'fabric'},
    'info-display': {(0.18, 0.42, 0.69): 'screen'},
    'business-kiosk': {(0.18, 0.42, 0.69): 'screen'},
    'book-display': {(0.70, 0.28, 0.23): 'leather', (0.24, 0.52, 0.63): 'leather'},
    'potted-plant': {(0.46, 0.30, 0.18): 'plaster'},
}


# Per model: colour -> emissive factor, so lamps and indicator strips glow (the renderer has one
# directional light, so fixtures are lit by their own emission).
EMISSIVE = {
    'gallery-wall-sconce': {(0.14, 0.64, 0.63): (0.16, 0.52, 0.50), (0.91, 0.78, 0.52): (0.40, 0.32, 0.16)},
    'gallery-wayfinding-beacon': {(0.40, 0.82, 0.80): (0.20, 0.58, 0.55)},
    'gallery-exhibit-banner': {(0.14, 0.64, 0.63): (0.16, 0.50, 0.48)},
}


def emissive_for(model_name, color):
    c = tuple(color[:3])
    for k, v in EMISSIVE.get(model_name, {}).items():
        if max(abs(a - b) for a, b in zip(c, k)) < 0.035:
            return v
    return None


def classify(model_name, color):
    c = tuple(color[:3])
    for table in (OVERRIDES.get(model_name, {}),):
        for k, v in table.items():
            if max(abs(a - b) for a, b in zip(c, k)) < 0.035:
                return v
    best, kind = 0.05, None
    for k, v in CLASSES:
        d = max(abs(a - b) for a, b in zip(c, k))
        if d < best:
            best, kind = d, v
    return kind


def texturize(name, src_path):
    model = Model(name)
    for tris, color, srcmat in source_prims(src_path):
        kind = classify(name, color)
        ext = tris.reshape(-1, 3).max(axis=0) - tris.reshape(-1, 3).min(axis=0)
        grain = 2 if kind == 'roof' else (int(np.argmax(ext)) if kind in ('wood', 'brass', 'darkmetal') and ext.max() > 1.6 * np.median(ext) else None)
        emissive = emissive_for(name, color) or srcmat.get('emissiveFactor')
        m = mat(kind, list(color[:3]) + [1.0], emissive=emissive, double=srcmat.get('doubleSided', True))
        prim = model.prim(m)
        mpt = TILE_M.get(kind, 1.0)
        for a, b, c in tris:
            n = np.cross(b - a, c - a)
            if np.linalg.norm(n) < 1e-12:
                continue
            n = unit(n)
            if kind == 'screen':
                # the plate's two large faces show the whole image; everything else samples one point
                if abs(n[2]) > 0.8:
                    lo, hi = tris.reshape(-1, 3).min(axis=0), tris.reshape(-1, 3).max(axis=0)
                    sign = 1 if n[2] > 0 else -1
                    uvs = [((sign * (p[0] - (lo[0] + hi[0]) / 2)) / (hi[0] - lo[0]) + 0.5, 0.5 - (p[1] - (lo[1] + hi[1]) / 2) / (hi[1] - lo[1])) for p in (a, b, c)]
                else:
                    uvs = [(0.02, 0.02)] * 3
            elif kind:
                uvs = [proj_uv(p, n, mpt, grain) for p in (a, b, c)]
            else:
                uvs = [(0.5, 0.5)] * 3
            prim.tri([a, b, c], uvs, n)
    return model


# ---------------------------------------------------------------- hand-built models
def wall_box(m, c, s, plain=(0.93, 0.87, 0.76)):
    """A wall block: the shared wall texture on its +/-z faces, plaster on the others."""
    add_box(m, mat('wall'), c, s, uv='wall', faces=('+z', '-z'))
    add_box(m, mat('plaster', plain), c, s, faces=('+x', '-x', '+y', '-y'))


def build_wall_panel():
    m = Model('wall-panel')
    wall_box(m, (0, WALL_H / 2, 0), (WALL_W, WALL_H, WALL_T))
    return m


OPEN_HALF, OPEN_Y0, OPEN_Y1 = 2.6, 1.4, 4.6
FRAME = (0.78, 0.60, 0.40)


def build_window_panel():
    m = Model('gallery-window-panel')
    side = (WALL_W / 2 - OPEN_HALF)
    wall_box(m, (-(OPEN_HALF + side / 2), WALL_H / 2, 0), (side, WALL_H, WALL_T))
    wall_box(m, (OPEN_HALF + side / 2, WALL_H / 2, 0), (side, WALL_H, WALL_T))
    wall_box(m, (0, OPEN_Y0 / 2, 0), (2 * OPEN_HALF, OPEN_Y0, WALL_T))
    wall_box(m, (0, (OPEN_Y1 + WALL_H) / 2, 0), (2 * OPEN_HALF, WALL_H - OPEN_Y1, WALL_T))
    wood = mat('wood', FRAME)
    t, d = 0.14, 0.58
    h = OPEN_Y1 - OPEN_Y0
    add_box(m, wood, (-(OPEN_HALF + t / 2), (OPEN_Y0 + OPEN_Y1) / 2, 0), (t, h + 2 * t, d), grain=1)
    add_box(m, wood, (OPEN_HALF + t / 2, (OPEN_Y0 + OPEN_Y1) / 2, 0), (t, h + 2 * t, d), grain=1)
    add_box(m, wood, (0, OPEN_Y1 + t / 2, 0), (2 * OPEN_HALF + 2 * t, t, d), grain=0)
    add_box(m, wood, (0, OPEN_Y0 - t / 2, 0), (2 * OPEN_HALF + 2 * t, t, d), grain=0)
    add_box(m, mat('wood', (0.88, 0.70, 0.48)), (0, OPEN_Y0 + 0.03, 0), (2 * OPEN_HALF + 0.36, 0.06, WALL_T + 0.2), grain=0)
    add_box(m, wood, (0, (OPEN_Y0 + OPEN_Y1) / 2, 0), (0.10, h, 0.14), grain=1)
    add_box(m, wood, (0, 3.0, 0), (2 * OPEN_HALF, 0.10, 0.14), grain=0)
    add_box(m, mat('sky', unlit=True), (0, (OPEN_Y0 + OPEN_Y1) / 2, 0), (2 * OPEN_HALF, h, 0.02), uv='span', faces=('+z', '-z'))
    return m


def build_floor():
    m = Model('gallery-floor')
    add_box(m, mat('floor'), (0, 0.018, 0), (41.5, 0.036, 35.5), faces=('+y',))
    return m


def build_runner():
    m = Model('gallery-runner')
    add_box(m, mat('runner'), (0, 0.0415, 0), (3.2, 0.011, 29.0), faces=('+y',))
    return m


def add_frustum(model, m, cx, cz, y0, y1, r0, r1, segs=14, side=True, cap_bottom=False, cap_top=False):
    """Vertical cone frustum, radius r0 at y0 and r1 at y1, wound so the side faces outward."""
    ang = [2 * math.pi * i / segs for i in range(segs)]
    lo = [np.array([cx + r0 * math.cos(a), y0, cz + r0 * math.sin(a)]) for a in ang]
    hi = [np.array([cx + r1 * math.cos(a), y1, cz + r1 * math.sin(a)]) for a in ang]
    tris = []
    for i in range(segs):
        j = (i + 1) % segs
        if side:
            tris += [(lo[i], hi[i], hi[j]), (lo[i], hi[j], lo[j])]
        if cap_bottom:
            tris.append((lo[i], lo[j], np.array([cx, y0, cz])))
        if cap_top:
            tris.append((hi[j], hi[i], np.array([cx, y1, cz])))
    add_poly(model, m, tris)


PENDANT_TOP, PENDANT_DROP = 9.0, 3.0


def build_pendant():
    """A hanging lamp: rod from the roof, a brass cone shade and a glowing underside. Placed at y 0."""
    m = Model('gallery-pendant')
    bottom = PENDANT_TOP - PENDANT_DROP
    dark = mat('darkmetal', (0.55, 0.58, 0.62))
    brass = mat('brass', (1.0, 0.90, 0.62))
    add_box(m, dark, (0, (PENDANT_TOP + bottom + 0.45) / 2, 0), (0.05, PENDANT_TOP - bottom - 0.45, 0.05), grain=1)
    add_frustum(m, brass, 0, 0, bottom + 0.34, bottom + 0.44, 0.10, 0.08)
    add_frustum(m, brass, 0, 0, bottom, bottom + 0.34, 0.50, 0.10)
    add_frustum(m, mat(None, (1.0, 0.93, 0.74), emissive=(1.0, 0.80, 0.46)), 0, 0, bottom + 0.012, bottom + 0.012, 0.46, 0.46, side=False, cap_bottom=True)
    add_frustum(m, mat(None, (1.0, 0.95, 0.80), emissive=(1.0, 0.86, 0.55)), 0, 0, bottom - 0.05, bottom + 0.10, 0.11, 0.17, cap_bottom=True)
    add_frustum(m, brass, 0, 0, PENDANT_TOP - 0.12, PENDANT_TOP, 0.16, 0.16)
    return m


CHEST_W, CHEST_D, CHEST_H, LID_RISE = 0.92, 0.62, 0.36, 0.24


def build_chest(name, band_tex, band_tint, glow, wood_tint=(0.80, 0.56, 0.36)):
    m = Model(name)
    W, D, H = CHEST_W, CHEST_D, CHEST_H
    wood = mat('wood', wood_tint)
    band = mat(band_tex, band_tint)
    add_box(m, wood, (0, H / 2, 0), (W, H, D), grain=0)
    add_arch(m, wood, -W / 2, W / 2, H, D / 2, LID_RISE, segs=10)
    for x in (-0.29, 0.29):
        add_box(m, band, (x, H / 2 - 0.005, 0), (0.08, H + 0.01, D + 0.03), grain=1)
        add_arch(m, band, x - 0.04, x + 0.04, H, D / 2, LID_RISE, segs=10, grow=0.018, caps=False)
    add_box(m, band, (0, H, 0), (W + 0.03, 0.05, D + 0.03), grain=0)
    for sx in (-1, 1):
        for sz in (-1, 1):
            add_box(m, band, (sx * W / 2, H / 2, sz * D / 2), (0.07, H + 0.02, 0.07), grain=1)
    add_box(m, mat('brass', (1.0, 0.88, 0.55)), (0, H - 0.01, D / 2 + 0.014), (0.17, 0.21, 0.03))
    add_box(m, mat(None, (0.05, 0.05, 0.06)), (0, H - 0.03, D / 2 + 0.032), (0.07, 0.10, 0.012))
    add_box(m, mat(None, (0.02, 0.02, 0.02), emissive=glow), (0, H - 0.045, D / 2 + 0.040), (0.035, 0.06, 0.008))
    return m


def build_crate():
    m = Model('reward-crate')
    W, D, H = 0.90, 0.70, 0.62
    wood = mat('wood', (0.70, 0.50, 0.32))
    dark = mat('wood', (0.45, 0.30, 0.19))
    add_box(m, wood, (0, H / 2 - 0.03, 0), (W - 0.06, H - 0.06, D - 0.06), grain=0)
    for i in range(4):
        z = -D / 2 + 0.08 + i * (D - 0.16) / 3
        add_box(m, wood, (0, H - 0.02, z), (W, 0.05, (D - 0.16) / 3 - 0.02), grain=0)
    add_box(m, dark, (0, 0.03, 0), (W, 0.06, D), grain=0)
    for sx in (-1, 1):
        for sz in (-1, 1):
            add_box(m, dark, (sx * (W / 2 - 0.04), H / 2, sz * (D / 2 - 0.04)), (0.08, H, 0.08), grain=1)
    for x in (-0.22, 0.22):
        add_box(m, mat('darkmetal', (0.7, 0.74, 0.8)), (x, H / 2, 0), (0.05, H + 0.01, D + 0.012), grain=1)
    add_box(m, mat('brass', (1.0, 0.85, 0.5)), (0, H - 0.1, D / 2 + 0.014), (0.13, 0.15, 0.025))
    add_box(m, mat(None, (0.02, 0.02, 0.02), emissive=(0.16, 0.75, 0.75)), (0, H - 0.1, D / 2 + 0.030), (0.05, 0.06, 0.008))
    return m


def build_ruby():
    m = Model('ruby')
    rx, rz, ry_g, ry_t = 0.15, 0.105, 0.10, 0.17
    n = 10
    ang = [2 * math.pi * i / n for i in range(n)]
    gir = [np.array([rx * math.cos(a), ry_g, rz * math.sin(a)]) for a in ang]
    tab = [np.array([0.62 * rx * math.cos(a), ry_t, 0.62 * rz * math.sin(a)]) for a in ang]
    tip = np.array([0.0, 0.0, 0.0])
    facet = [mat(None, c, emissive=e) for c, e in (((0.66, 0.02, 0.10), (0.30, 0.0, 0.05)), ((0.50, 0.01, 0.08), (0.22, 0.0, 0.04)))]
    table = mat(None, (0.82, 0.16, 0.26), emissive=(0.40, 0.04, 0.10))
    pav = mat(None, (0.36, 0.01, 0.06), emissive=(0.16, 0.0, 0.03))
    for i in range(n):
        j = (i + 1) % n
        add_poly(m, facet[i % 2], [(gir[i], gir[j], tab[j]), (gir[i], tab[j], tab[i])])
        add_poly(m, pav, [(gir[j], gir[i], tip)])
    add_poly(m, table, [(tab[0], tab[k + 1], tab[k]) for k in range(1, n - 1)])
    return m


def build_pickaxe():
    m = Model('pickaxe')
    wood = mat('wood', (0.50, 0.31, 0.17))
    steel = mat('darkmetal', (0.66, 0.72, 0.80))
    brass = mat('brass', (1.0, 0.86, 0.5))
    add_box(m, wood, (0, 0.46, 0), (0.05, 0.92, 0.045), grain=1)
    add_box(m, mat('wood', (0.55, 0.36, 0.22)), (0, 0.02, 0), (0.07, 0.05, 0.06), grain=1)
    add_box(m, brass, (0, 0.90, 0), (0.085, 0.09, 0.075))
    R, span, segs = 0.42, 58.0, 6
    cy = 0.90 + 0.02 - R
    pts = []
    for i in range(segs + 1):
        a = math.radians(-span + 2 * span * i / segs)
        pts.append(np.array([R * math.sin(a), cy + R * math.cos(a), 0.0]))
    for i in range(segs):
        p0, p1 = pts[i], pts[i + 1]
        mid = (p0 + p1) / 2
        d = p1 - p0
        L = float(np.linalg.norm(d))
        ang = math.degrees(math.atan2(d[1], d[0]))
        t = 0.060 - 0.028 * abs((i + 0.5) / segs - 0.5) * 2
        add_box(m, steel, mid, (L + 0.012, t, 0.048), rot=_rot(rz=ang), grain=0)
    for end, sign in ((pts[0], -1), (pts[-1], 1)):
        d = unit(pts[-1] - pts[-2]) if sign > 0 else unit(pts[0] - pts[1])
        apex = end + d * 0.10
        nrm = np.array([-d[1], d[0], 0.0])
        hz = np.array([0, 0, 0.022])
        t = 0.017
        c = [end + nrm * t + hz, end - nrm * t + hz, end - nrm * t - hz, end + nrm * t - hz]
        add_poly(m, steel, [(c[0], c[1], apex), (c[1], c[2], apex), (c[2], c[3], apex), (c[3], c[0], apex)])
    return m


HAND = {
    'wall-panel': (build_wall_panel, OUT),
    'gallery-window-panel': (build_window_panel, OUT),
    'gallery-floor': (build_floor, OUT),
    'gallery-runner': (build_runner, OUT),
    'gallery-pendant': (build_pendant, OUT),
    'reward-crate': (build_crate, OUT),
    'treasure-chest-gem': (lambda: build_chest('treasure-chest-gem', 'brass', (1.0, 0.86, 0.5), (1.0, 0.22, 0.30)), OUT),
    'treasure-chest-tools': (lambda: build_chest('treasure-chest-tools', 'darkmetal', (0.66, 0.72, 0.80), (0.20, 0.95, 0.90)), OUT),
    'ruby': (build_ruby, REWARD_OUT),
    'pickaxe': (build_pickaxe, REWARD_OUT),
}
NOT_TEXTURIZED = set(HAND)


def main():
    only = None
    if '--only' in sys.argv:
        only = set(sys.argv[sys.argv.index('--only') + 1].split(','))
    srcdir = SRC
    if '--from' in sys.argv:
        srcdir = sys.argv[sys.argv.index('--from') + 1]
    for name, (build, outs) in HAND.items():
        if only and name not in only:
            continue
        for out in (outs if isinstance(outs, list) else [outs]):
            write_glb(build(), os.path.join(out, name + '.glb'))
        print('built', name)
    os.makedirs(SRC, exist_ok=True)
    names = sorted(f[:-4] for f in os.listdir(OUT) if f.endswith('.glb'))
    for name in names:
        if name in NOT_TEXTURIZED or (only and name not in only):
            continue
        src = os.path.join(srcdir, name + '.glb')
        keep = os.path.join(SRC, name + '.glb')
        if not os.path.exists(src):
            src = os.path.join(OUT, name + '.glb')
            if b'gen-gallery-assets' in open(src, 'rb').read(400):
                raise SystemExit('no untextured source for ' + name + ' in ' + srcdir)
            if not os.path.exists(keep):
                open(keep, 'wb').write(open(src, 'rb').read())
        write_glb(texturize(name, src), os.path.join(OUT, name + '.glb'))
        print('texturized', name)


if __name__ == '__main__':
    main()
