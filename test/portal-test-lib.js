// Shared helpers for the portal gate world tests (manual-3d-town-portal-world.js,
// manual-3d-gallery-portal.js): screenshot colour counting and diffing inside the
// extension overlay frame, camera placement and GL texture tracking.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Screenshot of the whole overlay, base64 PNG.
const grab = async (page) => (await page.locator('#domain-atlas-overlay').screenshot()).toString('base64');

// Counts, in a region of a screenshot (fractions [x0, y0, x1, y1]), the pixels
// of the colour classes the gates are made of: the orange portal surface, warm
// stone, gold plaque lettering (as lit close up) and the dark plaque plate. (The extension frame forbids
// eval, so the classes are fixed here.)
const countColours = (frame, b64, region) => frame.evaluate(async ([b64, reg]) => {
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + b64; });
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const x0 = Math.floor(img.width * reg[0]), y0 = Math.floor(img.height * reg[1]), w = Math.floor(img.width * (reg[2] - reg[0])), h = Math.floor(img.height * (reg[3] - reg[1]));
  const d = g.getImageData(x0, y0, w, h).data;
  const out = { portal: 0, stone: 0, gold: 0, letters: 0, plate: 0 };
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], gr = d[i + 1], b = d[i + 2];
    if (r > 120 && r - b > 85 && r - gr > 35) out.portal++;
    else if (r > 110 && r > gr + 8 && gr > b + 8) out.stone++;
    if (r > 105 && gr > 95 && b < 115 && r - b > 30 && r - b < 75 && Math.abs(r - gr) < 22) out.letters++;
    if (r < 80 && b >= gr - 8 && b > 30) out.plate++;
    if (r > 150 && gr > 120 && b < 130 && r > b + 45 && r - b < 100) out.gold++;
  }
  return out;
}, [b64, region]);

// Number of pixels that differ between two screenshots within a region.
const diffImages = (frame, a, b, region) => frame.evaluate(async ([a, b, reg]) => {
  const load = async (s) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + s; });
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    return g.getImageData(Math.floor(img.width * reg[0]), Math.floor(img.height * reg[1]), Math.floor(img.width * (reg[2] - reg[0])), Math.floor(img.height * (reg[3] - reg[1]))).data;
  };
  const da = await load(a), db = await load(b);
  let n = 0;
  for (let i = 0; i < da.length; i += 4) if (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]) > 24) n++;
  return n;
}, [a, b, region]);

const setCamera = (frame, x, y, z, yaw, pitch) => frame.evaluate(([x, y, z, yaw, pitch]) => {
  const c = window.__atlasActive3D.camera; c.pos[0] = x; c.pos[1] = y; c.pos[2] = z; c.yaw = yaw; c.pitch = pitch;
}, [x, y, z, yaw, pitch]);

// Tracks the GL textures alive in the overlay frame from now on; returns a
// function giving how many are alive, and a function that forgets the current set.
async function trackTextures(frame) {
  await frame.evaluate(() => {
    window.__live = new Set();
    const proto = WebGLRenderingContext.prototype;
    const create = proto.createTexture, del = proto.deleteTexture;
    proto.createTexture = function () { const t = create.apply(this, arguments); if (t) window.__live.add(t); return t; };
    proto.deleteTexture = function (t) { window.__live.delete(t); return del.apply(this, arguments); };
  });
  return {
    live: () => frame.evaluate(() => window.__live.size),
    reset: () => frame.evaluate(() => window.__live.clear())
  };
}

// Holds a movement key down, sampling the player's x/z until `done()` says so or the time runs out.
async function walk(frame, code, isDone, timeoutMs) {
  await frame.evaluate((c) => window.dispatchEvent(new KeyboardEvent('keydown', { code: c })), code);
  const trail = [];
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs && !(await isDone())) {
    trail.push(await frame.evaluate(() => { const p = window.__atlasActive3D && window.__atlasActive3D.camera.pos; return p ? [p[0], p[2]] : null; }).catch(() => null));
    await sleep(150);
  }
  await frame.evaluate((c) => window.dispatchEvent(new KeyboardEvent('keyup', { code: c })), code).catch(() => {});
  return trail.filter(Boolean);
}

module.exports = { sleep, grab, countColours, diffImages, setCamera, trackTextures, walk };
