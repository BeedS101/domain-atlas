// Domain Atlas — proves the gltf-mini asset cache (IndexedDB, keyed by URL,
// validated against the server's Last-Modified header) actually behaves the
// way it's supposed to:
//   1. A first visit to a gltf-mini-v1 world (the Lobby) downloads every
//      referenced GLB fresh (200s), and caches each one.
//   2. A second visit, in a fresh page (so the in-memory modelCache from
//      gltf-mini.js — a page-lifetime Map — can't mask the IndexedDB path),
//      re-uses the cache: every unchanged GLB comes back 304, not 200.
//   3. If one of those files actually changes on the server (its
//      Last-Modified moves forward), THAT one file — and only that one —
//      is re-downloaded (200), proving the cache detects real changes
//      instead of just trusting itself forever.
//
// Requires the same setup as test/verify.js: issuer-server running on 8001
// (which now also serves conditional GETs — see issuer-server/server.js's
// serveStatic), and a display (xvfb-run -a node test/verify-asset-cache.js
// if headless on Linux).

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const FURNITURE_DIR = path.resolve(__dirname, '..', 'demo-domain-a', 'assets', 'furniture');
const BUMP_FILE = path.join(FURNITURE_DIR, 'desk.glb'); // referenced by the lobby scene

function shot(name) {
  return path.resolve(__dirname, name);
}

async function projectPortals(frame) {
  return frame.evaluate(() => {
    return new Promise((resolve) => {
      const check = () => {
        if (window.__atlasScene && window.__atlasScene.portalMarkers.length) {
          const canvas = document.getElementById('scene');
          const originX = canvas.width / 2;
          const originY = canvas.height / 2 + 40;
          const SCALE = 26, COS30 = Math.cos(Math.PI / 6), SIN30 = Math.sin(Math.PI / 6);
          const points = window.__atlasScene.portalMarkers.map((m) => {
            const [x, , z] = m.position;
            return {
              sx: originX + (x - z) * COS30 * SCALE,
              sy: originY + (x + z) * SIN30 * SCALE,
              kind: m.portal && m.portal.kind,
              to: m.portal && m.portal.to
            };
          });
          resolve(points);
        } else {
          requestAnimationFrame(check);
        }
      };
      check();
    });
  });
}

async function enterLobbyFromFreshPage(page, context, glbResponses) {
  await page.goto('http://localhost:8001', { waitUntil: 'load' });
  const btn = page.locator('#domain-atlas-enter-btn');
  await btn.waitFor({ state: 'visible', timeout: 10000 });
  await btn.click();
  const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
  const frame = await frameHandle.contentFrame();
  await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });

  const portals = await projectPortals(frame);
  const toLobby = portals.find((p) => p.to === 'lobby');
  if (!toLobby) throw new Error('Plaza has no portal to lobby — check demo-domain-a/spatial/plaza/scene.json');
  await frame.locator('#scene').click({ position: { x: toLobby.sx, y: toLobby.sy } });
  await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Lobby'), { timeout: 10000 });

  // Wait for the GLB requests to settle: poll until the response count stops
  // growing for a short quiet window, rather than assuming a fixed count
  // (robust to the lobby's object list changing later).
  let lastCount = -1;
  let stableTicks = 0;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && stableTicks < 4) {
    await page.waitForTimeout(250);
    if (glbResponses.length === lastCount) stableTicks++;
    else { stableTicks = 0; lastCount = glbResponses.length; }
  }
  return frame;
}

async function readCacheEntries(frame) {
  return frame.evaluate(() => {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('domain-atlas-asset-cache', 1);
      req.onerror = () => reject(req.error || new Error('open failed'));
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('assets', 'readonly');
        const getAll = tx.objectStore('assets').getAll();
        getAll.onsuccess = () => {
          resolve(getAll.result.map((r) => ({ url: r.url, lastModified: r.lastModified, bytes: r.buffer.byteLength })));
        };
        getAll.onerror = () => reject(getAll.error);
      };
    });
  });
}

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-asset-cache');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-sandbox'
    ]
  });

  try {
    if (!fs.existsSync(BUMP_FILE)) throw new Error('Expected fixture file missing: ' + BUMP_FILE);

    console.log('STEP 1: first visit to the Lobby — every referenced GLB should download fresh (200)');
    let page = await context.newPage();
    let glbResponses = [];
    page.on('response', (res) => {
      const u = res.url();
      if (u.includes('/assets/furniture/') && u.endsWith('.glb')) glbResponses.push({ url: u, status: res.status() });
    });
    let frame = await enterLobbyFromFreshPage(page, context, glbResponses);
    await page.screenshot({ path: shot('cache-01-lobby-first-visit.png') });

    if (glbResponses.length === 0) throw new Error('No GLB requests observed — lobby did not load any models');
    const notOk = glbResponses.filter((r) => r.status !== 200);
    if (notOk.length) throw new Error('Expected every first-visit GLB fetch to be 200, got: ' + JSON.stringify(notOk));
    console.log(`PASS: ${glbResponses.length} GLB requests, all fresh 200s`);

    const cacheEntries = await readCacheEntries(frame);
    if (cacheEntries.length < glbResponses.length) {
      throw new Error(`Expected at least ${glbResponses.length} cached entries, found ${cacheEntries.length}`);
    }
    const withoutLastModified = cacheEntries.filter((e) => !e.lastModified);
    if (withoutLastModified.length) {
      throw new Error('Some cached entries have no Last-Modified validator: ' + JSON.stringify(withoutLastModified));
    }
    console.log(`PASS: IndexedDB cache holds ${cacheEntries.length} entries, each with a real Last-Modified validator`);
    await page.close();

    console.log('STEP 2: bumping one file\'s mtime forward on the server (simulates a real content update)');
    const future = new Date(Date.now() + 60 * 60 * 1000); // +1h, comfortably past any HTTP-date truncation
    fs.utimesSync(BUMP_FILE, future, future);
    console.log('PASS: touched', path.basename(BUMP_FILE), '-> new mtime', future.toUTCString());

    console.log('STEP 3: second visit, fresh page (in-memory modelCache can\'t interfere) — cache should be honored via conditional GET');
    page = await context.newPage();
    glbResponses = [];
    page.on('response', (res) => {
      const u = res.url();
      if (u.includes('/assets/furniture/') && u.endsWith('.glb')) glbResponses.push({ url: u, status: res.status() });
    });
    frame = await enterLobbyFromFreshPage(page, context, glbResponses);
    await page.screenshot({ path: shot('cache-02-lobby-second-visit.png') });

    if (glbResponses.length === 0) throw new Error('No GLB requests observed on second visit');
    const bumpedName = path.basename(BUMP_FILE);
    const changed = glbResponses.filter((r) => r.url.endsWith('/' + bumpedName));
    const unchanged = glbResponses.filter((r) => !r.url.endsWith('/' + bumpedName));

    if (!changed.length) throw new Error(`Expected a request for ${bumpedName} on the second visit and saw none`);
    if (changed.some((r) => r.status !== 200)) {
      throw new Error(`Expected the touched file (${bumpedName}) to be re-downloaded (200), got: ${JSON.stringify(changed)}`);
    }
    console.log(`PASS: the touched file (${bumpedName}) was re-downloaded fresh (200) — change correctly detected`);

    const staleOnes = unchanged.filter((r) => r.status !== 304);
    if (staleOnes.length) {
      throw new Error('Expected every unchanged GLB to come back 304 on the second visit, got: ' + JSON.stringify(staleOnes));
    }
    console.log(`PASS: all ${unchanged.length} unchanged GLBs came back 304 — cache correctly reused, no re-download`);

    console.log('\nALL ASSET CACHE CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
