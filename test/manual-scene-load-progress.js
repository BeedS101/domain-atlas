// Manual check for the scene asset download progress bar (#36) — shown
// while a gltf-mini-v1 world's GLB models are downloading, so a scene with
// many assets (the Lobby has 19 unique models across 20 placements — see
// demo-domain-a/spatial/lobby/scene.json) gives real feedback instead of a
// blank canvas with only the top bar's "Fetching scene…" text to go on.
//
// Artificially delays every .glb response (via Playwright route
// interception) so the load is slow enough to actually observe
// intermediate progress instead of it completing before the first poll —
// on a real deployment (or even this repo's own localhost demo without the
// delay) 19 small models load fast enough that the bar might only ever be
// visible for a moment, which is exactly the case this test needs to slow
// down to check at all.
//
// Checks:
//   1. Before entering a 3D world, the progress overlay is not showing.
//   2. While the Lobby's models are loading (artificially slowed), the
//      overlay becomes visible, reports the correct total (19 — the
//      Lobby's UNIQUE model count, not the 20 placed objects), and the
//      loaded count advances (strictly increases) over several samples
//      rather than jumping straight to done or sitting frozen.
//   3. Once loading finishes (active3D.ready resolves), the overlay hides
//      itself again — no stuck bar left over the now-rendering scene.
//   4. Re-entering the SAME world a second time in the same page session
//      doesn't leave the overlay stuck. Notably, gltf-mini.js's in-memory
//      modelCache (a page-lifetime Map<url, Promise<parsedModel>>, kept
//      OUTSIDE MiniGLTF.init() so it survives destroy()+init() cycles) means
//      a same-session revisit resolves every model instantly from already-
//      parsed results — it never even reaches the network/IndexedDB layer
//      the artificial route delay targets, so there's nothing slow left to
//      sample mid-flight here. That's a genuinely better outcome than a
//      304 round-trip, not a gap in the delay setup — this step exists to
//      confirm a fast repeat visit still ends in the correct (hidden)
//      state rather than to force an intermediate progress reading out of
//      a case where the real product has nothing to be gradual about.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');

async function projectPortals(frame) {
  return frame.evaluate(() => {
    return new Promise((resolve) => {
      const check = () => {
        if (window.__atlasScene && window.__atlasScene.portalMarkers.length) {
          const canvas = document.getElementById('scene');
          const originX = canvas.width / 2, originY = canvas.height / 2 + 40;
          const SCALE = 26, COS30 = Math.cos(Math.PI / 6), SIN30 = Math.sin(Math.PI / 6);
          resolve(window.__atlasScene.portalMarkers.map((m) => {
            const [x, , z] = m.position;
            return { sx: originX + (x - z) * COS30 * SCALE, sy: originY + (x + z) * SIN30 * SCALE, to: m.portal && m.portal.to };
          }));
        } else { requestAnimationFrame(check); }
      };
      check();
    });
  });
}

function readProgress(frame) {
  return frame.evaluate(() => {
    const el = document.getElementById('sceneLoadProgress');
    const countEl = document.getElementById('sceneLoadProgressCount');
    const active = el && el.classList.contains('active');
    const text = countEl ? countEl.textContent : '';
    const [loaded, total] = text.split('/').map((s) => parseInt(s.trim(), 10));
    return { active: !!active, loaded: loaded || 0, total: total || 0 };
  });
}

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-scene-progress');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  });

  try {
    const page = await context.newPage();
    // Delay every model fetch so 19 small local files don't all resolve
    // before the test gets a chance to poll — see the file header comment.
    await page.route('**/*.glb', async (route) => {
      await new Promise((r) => setTimeout(r, 120));
      await route.continue();
    });

    await page.goto('http://localhost:8001', { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });

    console.log('STEP 1: no world loaded yet — the progress overlay is not showing');
    const before = await readProgress(frame);
    if (before.active) throw new Error('Expected the progress overlay to be inactive before entering any 3D world, got: ' + JSON.stringify(before));
    console.log('PASS: overlay inactive at Example Plaza (a 2D world, no GLBs to load anyway)');

    console.log('STEP 2: entering the Lobby — the overlay shows real, advancing progress toward 19 unique models');
    const portals = await projectPortals(frame);
    const toLobby = portals.find((p) => p.to === 'lobby');
    const clickPromise = frame.locator('#scene').click({ position: { x: toLobby.sx, y: toLobby.sy } });

    const samples = [];
    const sampleStart = Date.now();
    while (Date.now() - sampleStart < 4000) {
      const sample = await readProgress(frame);
      if (sample.active) samples.push(sample);
      if (sample.active && sample.loaded >= sample.total && sample.total > 0) break;
      await new Promise((r) => setTimeout(r, 40));
    }
    await clickPromise;
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Lobby'), { timeout: 10000 });

    if (samples.length === 0) throw new Error('Never observed the progress overlay active while the Lobby was loading — expected several samples');
    const totals = new Set(samples.map((s) => s.total));
    if (totals.size !== 1 || !totals.has(19)) throw new Error('Expected every sample to report a total of 19 (the Lobby\'s unique model count), got totals: ' + JSON.stringify(Array.from(totals)));
    console.log('PASS: overlay active with total=19 across ' + samples.length + ' samples');

    let sawIncrease = false;
    for (let i = 1; i < samples.length; i++) {
      if (samples[i].loaded > samples[i - 1].loaded) sawIncrease = true;
      if (samples[i].loaded < samples[i - 1].loaded) throw new Error('Progress went BACKWARDS between samples: ' + JSON.stringify(samples[i - 1]) + ' -> ' + JSON.stringify(samples[i]));
    }
    if (!sawIncrease) throw new Error('Expected the loaded count to advance across samples, but it never increased: ' + JSON.stringify(samples));
    console.log('PASS: loaded count advanced monotonically (0 -> ' + samples[samples.length - 1].loaded + ' of 19), never went backwards');

    console.log('STEP 3: loading finished — the overlay hides itself once active3D.ready resolves');
    await frame.evaluate(() => window.__atlasActive3D.ready);
    const after = await readProgress(frame);
    if (after.active) throw new Error('Expected the progress overlay to hide itself once the world finished loading, got: ' + JSON.stringify(after));
    console.log('PASS: overlay hidden once the Lobby finished loading — no stuck bar left over the rendered scene');

    console.log('STEP 4: re-entering the SAME world in this same session — a near-instant reload must not leave the overlay stuck');
    // A 3D world's own portals are walked into (gltf-mini.js's position-
    // triggered portalTriggers), not clicked — #scene, the 2D isometric
    // canvas projectPortals reads from, is hidden the whole time we're in
    // the Lobby (show3DCanvas(true) sets it display:none). So re-entering
    // here calls the SAME top-level enterWorld() the real portal-walk and
    // the initial 2D-canvas click both ultimately call — a direct, valid
    // way to trigger a second load of the identical world without having
    // to simulate walking a character across a 3D trigger radius.
    await frame.evaluate(() => enterWorld('lobby'));
    await frame.evaluate(() => window.__atlasActive3D.ready);
    const afterSecondVisit = await readProgress(frame);
    if (afterSecondVisit.active) throw new Error('Expected the overlay to be hidden again after the second, instant-from-cache visit finished loading, got: ' + JSON.stringify(afterSecondVisit));
    console.log('PASS: a same-session repeat visit (resolved straight from gltf-mini.js\'s in-memory modelCache, no network involved at all) still ends with the overlay correctly hidden');

    console.log('\nALL SCENE LOAD PROGRESS CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close().catch(() => {});
  }
})();
