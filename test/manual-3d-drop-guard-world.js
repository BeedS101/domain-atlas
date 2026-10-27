// The world-drop render guard in the real extension + issuer-server, on an
// isolated copy of demo-domain-a, with drop models served by a separate local
// HTTP server that can misbehave (oversized, chunked with no length, gzip
// bomb, huge texture, corrupt, missing).
//
//   1. A lightweight drop renders its requested model.
//   2. A valid dropPreviewModel is preferred (the full model is never fetched).
//   3. An oversized full model falls back; an oversized preview with a usable
//      full model uses the full model.
//   4. An oversized preview and an oversized full model fall back.
//   5. Corrupt and missing models fall back; a 2048 px texture is refused before
//      any GPU texture is created.
//   6. The byte limit holds with no Content-Length (chunked: the download is
//      cut off early) and with a wrong one (gzip bomb: small length, big body).
//   7. A fallback drop is still a normal pickup marker: same asset, label,
//      position and pickup call as a model drop; a refused pickup behaves the same.
//   8. Many fallback drops share one set of GPU resources; refused models are
//      not kept in the model cache; a refused URL is fetched once.
//   9. HUD DROPS counters match the real state and follow pickups.
//  10. worldDropPolicy: the domain default applies, a world's own value wins
//      outright, and a scene model above the drop limit is unaffected.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildMultiGlb, makePng, quadSpec } = require(path.join(__dirname, '..', 'tools', 'lib', 'glb-builder'));
const { sleep, trackTextures } = require('./portal-test-lib');

const REPO = path.resolve(__dirname, '..');
const EXT_PATH = path.join(REPO, 'extension');
const PORT = 8374;
const MODEL_PORT = 8375;
const DOMAIN = 'localhost:' + PORT;
const MODEL_ORIGIN = 'http://localhost:' + MODEL_PORT;
const DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-3d-dropguard-docroot-'));
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-3d-dropguard-state-'));
const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-3d-dropguard-profile-'));
const SCENE_PATH = path.join(DOCROOT_DIR, 'spatial', 'lobby', 'scene.json');
const MAIN_MANIFEST_PATH = path.join(DOCROOT_DIR, '.well-known', 'spatial.json');

const BIG_BYTES = 3 * 1024 * 1024;
const DEFAULT_MAX_BYTES = 1000000;

function assert(cond, msg) { if (!cond) throw new Error(msg); }

// ---- test models ----

const png = (w, h, fn) => ({ bytes: makePng(w, h, fn), mimeType: 'image/png' });
const quadGlb = (material) => buildMultiGlb({ primitives: [{ ...quadSpec(), material }] });
const SMALL = quadGlb({ texture: png(8, 8, () => [200, 100, 50, 255]) });
const PREVIEW = quadGlb({ baseColorFactor: [0.2, 0.8, 0.4, 1] });

// The same model with `extra` zero bytes appended inside the BIN chunk.
function padGlb(glb, extra) {
  const out = Buffer.concat([glb, Buffer.alloc(extra)]);
  let offset = 12;
  while (offset < glb.length) {
    const len = glb.readUInt32LE(offset), type = glb.readUInt32LE(offset + 4);
    if (type === 0x004e4942) { out.writeUInt32LE(len + extra, offset); break; }
    offset += 8 + len;
  }
  out.writeUInt32LE(out.length, 8);
  return out;
}
const BIG = padGlb(SMALL, BIG_BYTES);
const HUGE_TEXTURE = quadGlb({ texture: png(2048, 2048, () => [10, 20, 30, 255]) });
const CORRUPT = Buffer.from('this is not a glb file at all, just text'.repeat(20));

// ---- model server ----

const requests = []; // { url, sent, aborted, finished }
function startModelServer() {
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    const entry = { url, sent: 0, aborted: false, finished: false };
    requests.push(entry);
    res.on('close', () => { if (!res.writableFinished) entry.aborted = true; });
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Length' };
    const sendWhole = (body, extra) => {
      res.writeHead(200, { ...cors, 'Content-Type': 'model/gltf-binary', 'Content-Length': body.length, ...(extra || {}) });
      entry.sent = body.length;
      res.end(body, () => { entry.finished = true; });
    };
    if (url === '/small.glb') return sendWhole(SMALL);
    if (url === '/preview.glb') return sendWhole(PREVIEW);
    if (url === '/hugetex.glb') return sendWhole(HUGE_TEXTURE);
    if (url === '/corrupt.glb') return sendWhole(CORRUPT);
    if (/^\/big[-\w]*\.glb$/.test(url)) return sendWhole(BIG);
    if (url === '/gzipbomb.glb') {
      const gz = zlib.gzipSync(BIG);
      return sendWhole(gz, { 'Content-Encoding': 'gzip' });
    }
    if (url === '/chunked.glb') {
      // No Content-Length: sent in 64 KB pieces until the client goes away.
      res.writeHead(200, { ...cors, 'Content-Type': 'model/gltf-binary' });
      let pos = 0;
      const tick = () => {
        if (entry.aborted || res.destroyed) return;
        if (pos >= BIG.length) { res.end(() => { entry.finished = true; }); return; }
        const piece = BIG.subarray(pos, pos + 65536);
        pos += piece.length; entry.sent = pos;
        res.write(piece);
        setTimeout(tick, 15);
      };
      return tick();
    }
    res.writeHead(404, cors);
    res.end('not found');
  });
  return new Promise((resolve) => server.listen(MODEL_PORT, () => resolve(server)));
}
const requestsFor = (url) => requests.filter((r) => r.url === url);

// ---- GL buffer tracking (textures use portal-test-lib's trackTextures) ----

async function trackBuffers(frame) {
  await frame.evaluate(() => {
    window.__liveBuf = new Set();
    const proto = WebGLRenderingContext.prototype;
    const create = proto.createBuffer, del = proto.deleteBuffer;
    proto.createBuffer = function () { const b = create.apply(this, arguments); if (b) window.__liveBuf.add(b); return b; };
    proto.deleteBuffer = function (b) { window.__liveBuf.delete(b); return del.apply(this, arguments); };
  });
  return {
    live: () => frame.evaluate(() => window.__liveBuf.size),
    reset: () => frame.evaluate(() => window.__liveBuf.clear())
  };
}

(async () => {
  console.log('SETUP: isolated copy of demo-domain-a, drop-model server on ' + MODEL_ORIGIN);
  fs.cpSync(path.join(REPO, 'demo-domain-a'), DOCROOT_DIR, { recursive: true });
  const baseManifest = JSON.parse(fs.readFileSync(MAIN_MANIFEST_PATH, 'utf8'));
  baseManifest.domain = DOMAIN;
  const writeManifest = (mutate) => {
    const m = JSON.parse(JSON.stringify(baseManifest));
    if (mutate) mutate(m);
    fs.writeFileSync(MAIN_MANIFEST_PATH, JSON.stringify(m, null, 2));
  };
  writeManifest();
  const lobbyScene = JSON.parse(fs.readFileSync(SCENE_PATH, 'utf8'));
  const writeScene = (objects) => fs.writeFileSync(SCENE_PATH, JSON.stringify({
    ...lobbyScene, objects, interactables: [], portalMarkers: [], anchors: [], camera: { start: [0, 1.6, 0], startYaw: 0 }
  }, null, 2));
  fs.mkdirSync(path.join(DOCROOT_DIR, 'assets', 'dropguard'), { recursive: true });
  fs.writeFileSync(path.join(DOCROOT_DIR, 'assets', 'dropguard', 'big.glb'), BIG);
  writeScene([]);

  const modelServer = await startModelServer();
  const serverProc = spawn('node', ['issuer-server/server.js'], {
    cwd: REPO,
    env: { ...process.env, PORT: String(PORT), ATLAS_DOMAIN: DOMAIN, ATLAS_STATE_DIR: STATE_DIR, ATLAS_DOCROOT: DOCROOT_DIR },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('issuer-server did not start in time')), 10000);
    serverProc.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); resolve(); } });
    serverProc.on('exit', (code) => reject(new Error('issuer-server exited early with code ' + code)));
  });

  let context;
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
      viewport: { width: 1280, height: 720 },
      args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox', '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist']
    });
    const page = await context.newPage();
    const pageErrors = [];
    const warnings = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'warn') warnings.push(m.text()); });
    await page.goto('http://' + DOMAIN, { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frame = await (await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 })).contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), null, { timeout: 10000 });
    const tex = await trackTextures(frame);
    const buf = await trackBuffers(frame);
    await frame.evaluate(() => {
      const s = document.createElement('style'); s.textContent = '#chatWidget, #previewerWidget { display: none !important; }'; document.head.appendChild(s);
      // Drops come from the test, not the server; picking one up is recorded, and a refusal can be staged.
      window.__testDrops = [];
      window.__picked = [];
      window.__refuse = new Set();
      window.getWorldDropsSafely = async () => window.__testDrops.slice();
      AtlasWallet.getIdentity = async () => ({ publicKey: 'test-visitor' });
      AtlasWallet.pickUpItem = async (domain, dropId) => {
        if (window.__refuse.has(dropId)) throw new Error('not yours to pick up');
        window.__picked.push([domain, dropId]);
        window.__testDrops = window.__testDrops.filter((d) => d.dropId !== dropId);
      };
    });

    const enter = async () => {
      await tex.reset(); await buf.reset();
      await frame.evaluate(() => loadManifest(currentManifestUrl, 'lobby', null));
      await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Lobby') && !!window.__atlasActive3D, null, { timeout: 30000 });
      await frame.evaluate(() => window.__atlasActive3D.ready);
      await sleep(1200);
    };
    const resources = async () => (await frame.evaluate(() => window.__atlasActive3D.getDebugInfo())).resources;
    const gpu = async () => ({ buffers: await buf.live(), textures: await tex.live(), cached: (await resources()).cachedModels });

    let nextId = 1;
    const mk = (spec, x, z) => {
      const id = 'drop-' + (nextId++);
      return {
        dropId: id,
        position: [x, 0, z],
        droppedBy: 'someone-else',
        credential: { id: 'cred-' + id, issuer: { domain: DOMAIN }, asset: { id: spec.assetId || 'test.item', class: 'test.item', name: spec.name || 'Test Item', model: spec.model || null, ...(spec.preview ? { dropPreviewModel: spec.preview } : {}) }, quantity: 1 }
      };
    };
    const m = (p) => MODEL_ORIGIN + p;
    const setDrops = (list) => frame.evaluate(async (l) => { window.__testDrops = l; await refreshSceneItemMarkers(); }, list);
    const waitSettled = async (ids, timeout) => {
      await frame.waitForFunction((ids) => ids.every((id) => { const s = window.__atlasActive3D.getItemDropSource(id); return s && s !== 'pending'; }), ids, { timeout: timeout || 60000 });
    };
    const source = (id) => frame.evaluate((id) => window.__atlasActive3D.getItemDropSource(id), id);
    const reason = (id) => frame.evaluate((id) => window.__atlasActive3D.getItemDropFallbackReason(id), id);
    // Puts the player (not the third-person camera behind it) at x, z.
    const teleport = async (x, z) => {
      const set = (cx, cz) => frame.evaluate(([cx, cz]) => { const c = window.__atlasActive3D.camera; c.pos[0] = cx; c.pos[2] = cz; }, [cx, cz]);
      await set(x, z);
      await sleep(400);
      const pp = await frame.evaluate(() => window.__atlasActive3D.getDebugInfo().playerPos);
      await set(2 * x - pp[0], 2 * z - pp[2]);
      await sleep(400);
    };
    const pressE = async () => {
      await frame.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE' })));
      await sleep(500);
      await frame.evaluate(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyE' })));
      await sleep(400);
    };
    // Waits (frames are slow in software GL) until the drop is in E-range.
    const nearbyMarkers = async (dropId) => {
      await frame.waitForFunction((id) => window.__atlasActive3D.getNearbyInteractMarkers().some((mk) => mk.dropId === id), dropId, { timeout: 20000 }).catch(() => {});
      return frame.evaluate(() => window.__atlasActive3D.getNearbyInteractMarkers().map((mk) => ({ kind: mk.kind, dropId: mk.dropId, domain: mk.domain, label: mk.label, assetId: mk.entry.credential.asset.id, credId: mk.entry.credential.id })));
    };
    const warnedAbout = (url, why) => warnings.some((w) => w.includes(url) && w.includes('over the world-drop policy: ' + why));

    // ---------------------------------------------------------------- 0
    console.log('STEP 0: world entry, default policy');
    await enter();
    const policy = await frame.evaluate(() => window.__atlasActive3D.getDropPolicy());
    assert(policy.maxModelBytes === DEFAULT_MAX_BYTES && policy.maxTriangles === 50000 && policy.maxTextureSize === 1024 && policy.maxTextures === 4 && policy.maxPrimitives === 32, 'built-in defaults without any manifest policy: ' + JSON.stringify(policy));
    const base = await gpu();
    console.log('PASS: defaults ' + JSON.stringify(policy) + '; baseline GPU ' + JSON.stringify(base));

    // ---------------------------------------------------------------- 1, 2
    console.log('STEP 1: a lightweight drop renders its model; a valid preview is preferred');
    const dA = mk({ model: m('/small.glb') }, -6, -3);
    const dB = mk({ preview: m('/preview.glb'), model: m('/big.glb') }, -3, -3);
    await setDrops([dA, dB]);
    await waitSettled([dA.dropId, dB.dropId]);
    assert(await source(dA.dropId) === 'model', 'lightweight drop renders its model, got ' + await source(dA.dropId));
    assert(await source(dB.dropId) === 'preview', 'drop with a valid preview renders the preview, got ' + await source(dB.dropId));
    assert(requestsFor('/big.glb').length === 0, 'the preview satisfied the drop: the full model was never fetched');
    assert(await reason(dA.dropId) === null && await reason(dB.dropId) === null, 'no fallback reason on rendered drops');
    const afterModels = await gpu();
    assert(afterModels.cached === base.cached + 2, 'the two loaded models are cached once each: ' + base.cached + ' -> ' + afterModels.cached);
    console.log('PASS: small.glb rendered as the model; preview.glb chosen over the 3 MB full model, which was never requested');

    // ---------------------------------------------------------------- 3
    console.log('STEP 2: oversized full model falls back; oversized preview with a usable full model uses the full model');
    const dC = mk({ model: m('/big.glb') }, 0, -3);
    const dC2 = mk({ preview: m('/big-preview.glb'), model: m('/small.glb') }, 3, -3);
    const beforeFirstFallback = await gpu();
    await setDrops([dA, dB, dC, dC2]);
    await waitSettled([dC.dropId, dC2.dropId]);
    assert(await source(dC.dropId) === 'fallback' && await reason(dC.dropId) === 'policy', 'oversized full model -> fallback (policy): ' + await source(dC.dropId) + '/' + await reason(dC.dropId));
    assert(await source(dC2.dropId) === 'model', 'oversized preview, usable full model -> the full model: ' + await source(dC2.dropId));
    assert(warnedAbout(m('/big.glb'), 'bytes'), 'a console warning names the refused model and the byte limit');
    const afterFirstFallback = await gpu();
    const fallbackCost = { buffers: afterFirstFallback.buffers - beforeFirstFallback.buffers, textures: afterFirstFallback.textures - beforeFirstFallback.textures, cached: afterFirstFallback.cached - beforeFirstFallback.cached };
    assert(fallbackCost.cached === 1, 'the cache gained the fallback model only (small.glb was cached already): ' + JSON.stringify(fallbackCost));
    assert(fallbackCost.textures === 0, 'the fallback has no texture: ' + JSON.stringify(fallbackCost));
    assert(fallbackCost.buffers > 0 && fallbackCost.buffers <= 8, 'the fallback is one small set of GPU buffers: ' + JSON.stringify(fallbackCost));
    console.log('PASS: oversized -> fallback (policy), oversized preview -> full model; first fallback cost ' + JSON.stringify(fallbackCost));

    // ---------------------------------------------------------------- 4
    console.log('STEP 3: oversized preview and oversized full model both fall back');
    const dD = mk({ preview: m('/big-preview.glb'), model: m('/big.glb') }, 6, -3);
    await setDrops([dA, dB, dC, dC2, dD]);
    await waitSettled([dD.dropId]);
    assert(await source(dD.dropId) === 'fallback' && await reason(dD.dropId) === 'policy', 'both oversized -> fallback: ' + await source(dD.dropId));
    assert(requestsFor('/big-preview.glb').length === 1, 'the refused preview URL was fetched once for two drops: ' + requestsFor('/big-preview.glb').length);
    console.log('PASS: both oversized -> shared fallback; the refused preview was fetched once');

    // ---------------------------------------------------------------- 5
    console.log('STEP 4: corrupt, missing and huge-texture models');
    const beforeTex = await gpu();
    const dE = mk({ model: m('/corrupt.glb') }, -6, 0);
    const dF = mk({ model: m('/missing.glb') }, -3, 0);
    const dG = mk({ model: m('/hugetex.glb') }, 0, 0);
    const dH = mk({ name: 'No model', model: null }, 3, 0);
    await setDrops([dA, dB, dC, dC2, dD, dE, dF, dG, dH]);
    await waitSettled([dE.dropId, dF.dropId, dG.dropId, dH.dropId]);
    assert(await source(dE.dropId) === 'fallback' && await reason(dE.dropId) === 'failed', 'corrupt model -> fallback (failed)');
    assert(await source(dF.dropId) === 'fallback' && await reason(dF.dropId) === 'failed', 'missing model -> fallback (failed)');
    assert(await source(dG.dropId) === 'fallback' && await reason(dG.dropId) === 'policy', 'huge texture -> fallback (policy): ' + await source(dG.dropId) + '/' + await reason(dG.dropId));
    assert(warnedAbout(m('/hugetex.glb'), 'textureSize'), 'the warning names the texture size limit');
    assert(await source(dH.dropId) === 'marker', 'a drop with no model keeps the amber marker, not the fallback');
    const afterTex = await gpu();
    assert(afterTex.textures === beforeTex.textures, 'the 2048 px texture never reached the GPU: ' + beforeTex.textures + ' -> ' + afterTex.textures);
    assert(afterTex.buffers === beforeTex.buffers && afterTex.cached === beforeTex.cached, 'broken and refused models add no GPU buffers and no cache entries: ' + JSON.stringify(beforeTex) + ' -> ' + JSON.stringify(afterTex));
    console.log('PASS: failed loads fall back (failed), the huge texture falls back (policy) with 0 new GPU textures/buffers/cache entries; no-model drop stays a marker');

    // ---------------------------------------------------------------- 6
    console.log('STEP 5: the byte limit holds with no Content-Length and with a wrong one');
    const dI = mk({ model: m('/chunked.glb') }, 6, 0);
    const dJ = mk({ model: m('/gzipbomb.glb') }, -6, 3);
    await setDrops([dA, dB, dC, dC2, dD, dE, dF, dG, dH, dI, dJ]);
    await waitSettled([dI.dropId, dJ.dropId]);
    assert(await source(dI.dropId) === 'fallback' && await reason(dI.dropId) === 'policy', 'chunked, no length -> fallback (policy): ' + await source(dI.dropId) + '/' + await reason(dI.dropId));
    assert(await source(dJ.dropId) === 'fallback' && await reason(dJ.dropId) === 'policy', 'gzip bomb -> fallback (policy): ' + await source(dJ.dropId) + '/' + await reason(dJ.dropId));
    assert(warnedAbout(m('/chunked.glb'), 'bytes') && warnedAbout(m('/gzipbomb.glb'), 'bytes'), 'both refused on bytes');
    await sleep(400);
    const chunked = requestsFor('/chunked.glb')[0];
    assert(chunked.aborted && !chunked.finished && chunked.sent < BIG_BYTES, 'the chunked download was cut off early: sent ' + chunked.sent + ' of ' + BIG_BYTES + ', aborted=' + chunked.aborted);
    const gz = requestsFor('/gzipbomb.glb')[0];
    assert(gz.sent < 50000, 'the gzip body is small on the wire (' + gz.sent + ' bytes) and still refused by decoded size');
    const afterBytes = await gpu();
    assert(afterBytes.buffers === afterTex.buffers && afterBytes.cached === afterTex.cached, 'neither is cached or uploaded: ' + JSON.stringify(afterTex) + ' -> ' + JSON.stringify(afterBytes));
    console.log('PASS: chunked stream cut off after ' + chunked.sent + ' bytes (of ' + BIG_BYTES + '); gzip bomb (' + gz.sent + ' bytes on the wire) refused; nothing cached or uploaded');

    // ---------------------------------------------------------------- 9
    console.log('STEP 6: HUD DROPS counters');
    const all = [dA, dB, dC, dC2, dD, dE, dF, dG, dH, dI, dJ];
    // rendered: A model, B preview, C2 model = 3 (1 preview); fallback: C, D, E, F, G, I, J = 7 (policy: C, D, G, I, J = 5); marker: H = 1
    const expected = { rendered: 3, preview: 1, fallback: 7, rejected: 5, failed: 2, pending: 0, markers: 1 };
    const drops = (await resources()).drops;
    assert(JSON.stringify(drops) === JSON.stringify(expected), 'getDebugInfo drops ' + JSON.stringify(drops) + ' vs expected ' + JSON.stringify(expected));
    await frame.locator('#scene3d').click({ position: { x: 640, y: 400 } });
    await page.keyboard.press('F3');
    await sleep(600);
    const hud = await frame.evaluate(() => { const e = document.getElementById('miniGltfHud'); return e ? e.textContent : null; });
    const hudNum = (label) => { const mm = new RegExp('^' + label + '\\s+(\\d+)', 'm').exec(hud || ''); return mm ? parseInt(mm[1], 10) : null; };
    assert(hud && /^DROPS$/m.test(hud), 'the HUD has a DROPS section:\n' + hud);
    assert(hudNum('Rendered') === 3 && /Rendered\s+3\s+\(1 preview\)/.test(hud), 'HUD Rendered 3 (1 preview):\n' + hud);
    assert(hudNum('Fallback') === 7 && hudNum('Rejected GLB') === 5 && hudNum('Marker only') === 1, 'HUD Fallback 7 / Rejected GLB 5 / Marker only 1:\n' + hud);
    assert(hudNum('Item drops') === all.length, 'HUD Item drops ' + all.length);
    console.log('PASS: HUD Rendered 3 (1 preview), Fallback 7, Rejected GLB 5, Marker only 1; matches getDebugInfo');

    // ---------------------------------------------------------------- 7, 8
    console.log('STEP 7: a fallback drop is a normal pickup marker');
    await teleport(0, -3.3);
    const near = await nearbyMarkers(dC.dropId);
    const nearC = near.find((n) => n.dropId === dC.dropId);
    assert(nearC, 'the fallback drop is in E-range at its own position: ' + JSON.stringify(near) + ' pageErrors ' + JSON.stringify(pageErrors) + ' warnings ' + JSON.stringify(warnings.slice(-3)) + ' camera ' + JSON.stringify(await frame.evaluate(() => ({ frames: window.__atlasActive3D.getDebugInfo().frames, pos: window.__atlasActive3D.camera.pos.slice(), info: window.__atlasActive3D.getDebugInfo().playerPos }))));
    assert(nearC.kind === 'item-drop' && nearC.label === 'Test Item' && nearC.assetId === 'test.item' && nearC.credId === 'cred-' + dC.dropId && nearC.domain === DOMAIN, 'same marker data as any drop: ' + JSON.stringify(nearC));
    // the same marker shape as a model drop
    await teleport(-6, -3.3);
    const nearA = (await nearbyMarkers(dA.dropId)).find((n) => n.dropId === dA.dropId);
    assert(nearA && JSON.stringify(Object.keys(nearA)) === JSON.stringify(Object.keys(nearC)) && nearA.kind === nearC.kind && nearA.domain === nearC.domain, 'a model drop and a fallback drop produce the same marker fields');
    const hint = async () => frame.evaluate(() => document.getElementById('scene3dInteractHint').textContent);
    console.log('PASS: fallback drop is an item-drop marker at its own position with the original asset id, credential and label; same fields as a model drop');

    console.log('STEP 8: pickup of a fallback drop goes through the same call; a refusal behaves the same as for a model drop');
    await frame.evaluate((ids) => ids.forEach((id) => window.__refuse.add(id)), [dC.dropId, dA.dropId]);
    for (const [d, x] of [[dC, 0], [dA, -6]]) {
      await teleport(x, -3.3);
      await nearbyMarkers(d.dropId);
      const before = await frame.evaluate(() => window.__picked.length);
      await pressE();
      const status = await frame.evaluate(() => document.getElementById('status').textContent);
      assert(status === 'Pick up failed: not yours to pick up', 'refused pickup of ' + d.dropId + ' reports the refusal: ' + status);
      assert(await frame.evaluate(() => window.__picked.length) === before, 'nothing was picked up');
      assert(await source(d.dropId) !== null, 'the drop is still there after a refused pickup');
    }
    await frame.evaluate(() => window.__refuse.clear());
    await teleport(0, -3.3);
    await nearbyMarkers(dC.dropId);
    const hintText = await hint();
    assert(/E — Test Item/.test(hintText), 'the prompt reads the asset label, got ' + JSON.stringify(hintText));
    await pressE();
    const picked = await frame.evaluate(() => window.__picked.slice());
    assert(picked.length === 1 && picked[0][0] === DOMAIN && picked[0][1] === dC.dropId, 'pickup called with the drop id and the world domain: ' + JSON.stringify(picked));
    await frame.waitForFunction((id) => window.__atlasActive3D.getItemDropSource(id) === null, dC.dropId, { timeout: 10000 });
    assert(await source(dC.dropId) === null, 'the picked-up fallback drop is gone');
    const afterPick = (await resources()).drops;
    assert(afterPick.fallback === 6 && afterPick.rejected === 4 && afterPick.rendered === 3, 'HUD counters follow the pickup: ' + JSON.stringify(afterPick));
    await sleep(500);
    const hud2 = await frame.evaluate(() => document.getElementById('miniGltfHud').textContent);
    assert(/Fallback\s+6/.test(hud2) && /Rejected GLB\s+4/.test(hud2), 'the visible HUD follows:\n' + hud2);
    console.log('PASS: refused pickups report the same error and keep the drop; the real pickup sends [domain, dropId]; counters drop 7 -> 6 fallback, 5 -> 4 rejected');

    // ---------------------------------------------------------------- 8
    console.log('STEP 9: 60 more refused drops share the fallback and add no resources');
    await page.keyboard.press('F3'); // HUD off
    const sameUrl = [], distinct = [];
    for (let i = 0; i < 30; i++) sameUrl.push(mk({ model: m('/big-shared.glb') }, -30 + (i % 10) * 2, -20 - Math.floor(i / 10) * 2));
    for (let i = 0; i < 30; i++) distinct.push(mk({ model: m('/big-' + i + '.glb') }, -30 + (i % 10) * 2, -30 - Math.floor(i / 10) * 2));
    const before60 = await gpu();
    const remaining = all.filter((d) => d !== dC);
    await setDrops([...remaining, ...sameUrl, ...distinct]);
    await waitSettled([...sameUrl, ...distinct].map((d) => d.dropId), 90000);
    for (const d of [...sameUrl, ...distinct]) assert(await source(d.dropId) === 'fallback' && await reason(d.dropId) === 'policy', d.dropId + ' falls back');
    const after60 = await gpu();
    assert(JSON.stringify(after60) === JSON.stringify(before60), '60 fallback drops add no GPU buffers, textures or cache entries: ' + JSON.stringify(before60) + ' -> ' + JSON.stringify(after60));
    assert(requestsFor('/big-shared.glb').length === 1, '30 drops of one refused URL fetched it once: ' + requestsFor('/big-shared.glb').length);
    assert((await resources()).drops.fallback === 66, 'HUD data: 66 fallback drops, got ' + (await resources()).drops.fallback);
    console.log('PASS: 60 fallback drops: GPU buffers/textures/cache unchanged (' + JSON.stringify(after60) + '); the shared URL was requested once');

    // ---------------------------------------------------------------- 10
    console.log('STEP 10: worldDropPolicy: domain default, world override wins outright, scene models unaffected');
    await setDrops([]);
    writeScene([{ model: '/assets/dropguard/big.glb', position: [0, 0, -8], rotationY: 0, scale: 0.01, solid: false }]);
    writeManifest((mf) => { mf.worldDropPolicy = { maxModelBytes: 10000000, maxTriangles: 7 }; });
    await enter();
    let p = await frame.evaluate(() => window.__atlasActive3D.getDropPolicy());
    assert(p.maxModelBytes === 10000000 && p.maxTriangles === 7 && p.maxTextureSize === 1024 && p.maxTextures === 4, 'domain-wide worldDropPolicy applies, missing keys use defaults: ' + JSON.stringify(p));
    assert((await resources()).sceneModels === 1, 'the 3 MB scene model loads: scene models are not held to the drop policy');
    const dBigOk = mk({ model: m('/big-raised.glb') }, 0, -3);
    await setDrops([dBigOk]);
    await waitSettled([dBigOk.dropId]);
    assert(await source(dBigOk.dropId) === 'model', 'with the limit raised the 3 MB model renders as itself (the refusal elsewhere left nothing behind): ' + await source(dBigOk.dropId));
    const dSceneBig = mk({ model: m('/assets/dropguard/big.glb').replace(MODEL_ORIGIN, 'http://' + DOMAIN) }, 3, -3);
    await setDrops([dBigOk, dSceneBig]);
    await sleep(2500);
    assert(await source(dSceneBig.dropId) === 'model', 'raised limit also admits the 3 MB model from the domain');
    console.log('PASS: top-level worldDropPolicy applied (' + JSON.stringify(p) + '); 3 MB models render when allowed; the scene model rendered');

    writeScene([]);
    writeManifest((mf) => {
      mf.worldDropPolicy = { maxModelBytes: 10000000, maxTriangles: 7 };
      const w = mf.worlds.find((x) => x.id === 'lobby');
      w.policy = { ...(w.policy || {}), worldDropPolicy: { maxModelBytes: 500 } };
    });
    await enter();
    p = await frame.evaluate(() => window.__atlasActive3D.getDropPolicy());
    assert(p.maxModelBytes === 500 && p.maxTriangles === 50000, "the world's own worldDropPolicy wins outright, the domain default is not merged in: " + JSON.stringify(p));
    const dTiny = mk({ model: m('/small.glb') }, 0, -3);
    await setDrops([dTiny]);
    await waitSettled([dTiny.dropId]);
    assert(await source(dTiny.dropId) === 'fallback' && await reason(dTiny.dropId) === 'policy', 'a 500-byte limit refuses even the small model');
    console.log('PASS: the world value wins outright (' + JSON.stringify(p) + ')');

    writeManifest((mf) => { mf.worldDropPolicy = { maxModelBytes: 'huge', maxTriangles: -3, bogus: 1 }; });
    writeScene([]);
    await enter();
    p = await frame.evaluate(() => window.__atlasActive3D.getDropPolicy());
    assert(JSON.stringify(p) === JSON.stringify(policy), 'invalid values fall back to the defaults: ' + JSON.stringify(p));
    console.log('PASS: invalid policy values are ignored (defaults)');

    assert(pageErrors.length === 0, 'no page errors: ' + pageErrors.join(' | '));
    console.log('\nALL DROP GUARD WORLD CHECKS PASSED');
  } finally {
    if (context) await context.close();
    serverProc.kill();
    modelServer.close();
    for (const d of [DOCROOT_DIR, STATE_DIR, PROFILE_DIR]) fs.rmSync(d, { recursive: true, force: true });
  }
})().catch((e) => { console.error('FAILURE:', e); process.exit(1); });
