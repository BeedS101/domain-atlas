// Coverage for SPEC.md §3.5 ("per-page discovery and anchors"): a page opts
// in with one <link rel="spatial" href="/.well-known/spatial.json#worldId
// [:anchorId]"> tag in its own head, and a conforming client checks THAT
// tag before falling back to the domain-wide manifest and its defaultWorld.
//
// Exercises both demo pages added for this feature —
// demo-domain-a/compass-listing.html (plaza:compass-stall, the 2D
// procedural-v1 renderer, where an anchor becomes a "you are here" marker
// with no camera concept to override) and demo-domain-a/blog-post.html
// (lobby:reading-nook, the only gltf-mini-v1 demo world, where an anchor
// overrides the scene's declared camera spawn point) — plus two scenarios
// that don't need a page of their own (a world-only fragment with no
// anchor, and a dead/mismatched anchor id), driven directly through
// viewer.js's own loadManifest()/currentManifestUrl globals inside an
// already-open overlay, the same way followPortal()/travelToRecentWorld()
// call it internally.
//
// Spins up its own throwaway issuer-server instance on port 8001 (isolated
// state dir) using the real demo-domain-a docroot, same pattern as
// manual-wallet-resilient-to-drops-failure.js — port 8001 specifically
// because demo-domain-a/.well-known/spatial.json hardcodes "domain":
// "localhost:8001". Only safe to run standalone (not concurrently with
// anything else already bound to 8001).
//
// Checks:
//   1. compass-listing.html: the Enter button shows the 📍 marker before
//      any click, its hover tooltip resolves "Links to: Compass Stall", and
//      clicking it lands in Example Plaza with the anchor label appended to
//      placeLabel and window.__atlasScene.activeAnchor set to compass-stall.
//   2. blog-post.html: same button/tooltip checks for "Reading Nook", and
//      clicking it lands in the Lobby with the 3D camera spawned at the
//      anchor's own declared position (window.__atlasActive3D.camera.pos),
//      not the scene's ordinary camera.start.
//   3. Regression: the plain home page (no <link rel="spatial"> at all)
//      still lands at manifest.defaultWorld (Example Plaza) with no 📍 on
//      the button and no anchor label on placeLabel — exactly today's
//      existing behavior.
//   4. A world-only fragment (a worldId with no anchorId) enters that world
//      normally, no anchor marker, no crash.
//   5. A dead/mismatched anchor id (a real world, a nonexistent anchor)
//      falls back gracefully to that world's ordinary entry point — no
//      anchor marker, no crash, no stuck loading state.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const PORT = 8001; // must match demo-domain-a/.well-known/spatial.json's hardcoded "domain" — see file header
const DOMAIN = 'localhost:' + PORT;
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-per-page-anchor-state-'));
const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-per-page-anchor-profile-'));

(async () => {
  console.log('SETUP: starting a throwaway issuer-server instance on port ' + PORT + ' (real demo-domain-a docroot, isolated state dir)');
  const serverProc = spawn('node', ['issuer-server/server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), ATLAS_DOMAIN: DOMAIN, ATLAS_STATE_DIR: STATE_DIR },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('issuer-server did not start in time')), 10000);
    serverProc.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); resolve(); } });
    serverProc.on('exit', (code) => reject(new Error('issuer-server exited early with code ' + code)));
  });
  console.log('PASS: isolated issuer-server up on port ' + PORT);

  let context;
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      executablePath: '/opt/pw-browsers/chromium',
      args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
    });
    const page = await context.newPage();

    console.log('STEP 1: compass-listing.html (plaza:compass-stall) — button marker, tooltip, and 2D anchor landing');
    await page.goto('http://' + DOMAIN + '/compass-listing.html', { waitUntil: 'load' });
    const btn1 = await page.waitForSelector('#domain-atlas-enter-btn', { timeout: 10000 });
    const btnText1 = await btn1.textContent();
    if (!btnText1.includes('📍')) throw new Error('Expected the Enter button on compass-listing.html to carry the §3.5 📍 marker, got: ' + btnText1);
    console.log('PASS: Enter button shows the 📍 marker for a page with an anchor');

    await page.locator('#domain-atlas-enter-btn').hover();
    await page.waitForFunction(
      () => document.getElementById('domain-atlas-info-tooltip')?.innerHTML.includes('Compass Stall'), null,
      { timeout: 5000 }
    );
    console.log('PASS: hover tooltip resolves "Links to: Compass Stall"');

    await page.locator('#domain-atlas-enter-btn').click();
    let frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    let frame = await frameHandle.contentFrame();
    await frame.waitForFunction(
      () => document.getElementById('placeLabel').innerHTML.includes('Example Plaza') && document.getElementById('placeLabel').innerHTML.includes('Compass Stall'), null,
      { timeout: 10000 }
    );
    const activeAnchor1 = await frame.evaluate(() => window.__atlasScene && window.__atlasScene.activeAnchor);
    if (!activeAnchor1 || activeAnchor1.id !== 'compass-stall') {
      throw new Error('Expected window.__atlasScene.activeAnchor.id to be "compass-stall", got: ' + JSON.stringify(activeAnchor1));
    }
    console.log('PASS: landed in Example Plaza with the Compass Stall anchor active (2D "you are here" marker)');

    console.log('STEP 2: blog-post.html (lobby:reading-nook) — button marker, tooltip, and 3D camera-spawn override');
    await page.goto('http://' + DOMAIN + '/blog-post.html', { waitUntil: 'load' });
    const btn2 = await page.waitForSelector('#domain-atlas-enter-btn', { timeout: 10000 });
    const btnText2 = await btn2.textContent();
    if (!btnText2.includes('📍')) throw new Error('Expected the Enter button on blog-post.html to carry the §3.5 📍 marker, got: ' + btnText2);

    await page.locator('#domain-atlas-enter-btn').hover();
    await page.waitForFunction(
      () => document.getElementById('domain-atlas-info-tooltip')?.innerHTML.includes('Reading Nook'), null,
      { timeout: 5000 }
    );
    console.log('PASS: Enter button marker and hover tooltip both resolve for the Lobby\'s Reading Nook anchor');

    await page.locator('#domain-atlas-enter-btn').click();
    frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    frame = await frameHandle.contentFrame();
    await frame.waitForFunction(
      () => document.getElementById('placeLabel').innerHTML.includes('Reading Nook') && !!window.__atlasActive3D, null,
      { timeout: 15000 }
    );
    const camPos = await frame.evaluate(() => window.__atlasActive3D && window.__atlasActive3D.camera && window.__atlasActive3D.camera.pos);
    const expected = [-3.2, 1.6, -1.3];
    if (!camPos || expected.some((v, i) => Math.abs(camPos[i] - v) > 0.001)) {
      throw new Error('Expected the 3D camera to spawn at the Reading Nook anchor ' + JSON.stringify(expected) + ', got: ' + JSON.stringify(camPos));
    }
    console.log('PASS: 3D camera spawned at the Reading Nook anchor\'s own declared position, not the Lobby\'s ordinary camera.start');

    console.log('STEP 3 (regression): the plain home page has no <link rel="spatial"> — ordinary defaultWorld entry, no anchor marker');
    await page.goto('http://' + DOMAIN + '/', { waitUntil: 'load' });
    const btn3 = await page.waitForSelector('#domain-atlas-enter-btn', { timeout: 10000 });
    const btnText3 = await btn3.textContent();
    if (btnText3.includes('📍')) throw new Error('Expected no §3.5 marker on the plain home page\'s Enter button, got: ' + btnText3);

    await page.locator('#domain-atlas-enter-btn').click();
    frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), null, { timeout: 10000 });
    const placeLabelHtml3 = await frame.evaluate(() => document.getElementById('placeLabel').innerHTML);
    if (placeLabelHtml3.includes('anchorLabel')) throw new Error('Expected no anchor marker on an ordinary, non-anchored entry, got placeLabel: ' + placeLabelHtml3);
    const activeAnchor3 = await frame.evaluate(() => window.__atlasScene && window.__atlasScene.activeAnchor);
    if (activeAnchor3) throw new Error('Expected no activeAnchor on an ordinary entry, got: ' + JSON.stringify(activeAnchor3));
    console.log('PASS: ordinary entry (manifest.defaultWorld, no <link> tag) behaves exactly as before §3.5');

    console.log('STEP 4: a world-only fragment (worldId, no anchorId) enters that world normally, no marker');
    // museum, not market: market's own policy.identityRequired is true (an
    // unrelated gate, task #63), which would otherwise block here waiting on
    // a wallet-creation UI this script never drives — museum needs no
    // identity, same as plaza/lobby above, so it isolates the §3.5 behavior
    // this step actually means to check.
    await frame.evaluate(() => loadManifest(currentManifestUrl, 'museum', null));
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Museum'), null, { timeout: 10000 });
    const placeLabelHtml4 = await frame.evaluate(() => document.getElementById('placeLabel').innerHTML);
    if (placeLabelHtml4.includes('anchorLabel')) throw new Error('Expected no anchor marker for a world-only fragment, got placeLabel: ' + placeLabelHtml4);
    console.log('PASS: world-only fragment enters Example Museum cleanly, no anchor marker');

    console.log('STEP 5: a dead/mismatched anchor id falls back gracefully to ordinary entry, no crash');
    await frame.evaluate(() => loadManifest(currentManifestUrl, 'plaza', 'no-such-anchor'));
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), null, { timeout: 10000 });
    const placeLabelHtml5 = await frame.evaluate(() => document.getElementById('placeLabel').innerHTML);
    if (placeLabelHtml5.includes('anchorLabel')) throw new Error('Expected a dead anchor id to leave no anchor marker, got placeLabel: ' + placeLabelHtml5);
    const activeAnchor5 = await frame.evaluate(() => window.__atlasScene && window.__atlasScene.activeAnchor);
    if (activeAnchor5) throw new Error('Expected activeAnchor to stay null for a dead anchor id, got: ' + JSON.stringify(activeAnchor5));
    const statusText5 = await frame.evaluate(() => document.getElementById('status').textContent);
    if (/could not load/i.test(statusText5)) throw new Error('Expected a dead anchor id to still load the world normally, got status: ' + statusText5);
    console.log('PASS: a dead anchor id degrades to a normal, unmarked entry — no crash, no stuck error state');

    console.log('\nALL PER-PAGE-ANCHOR CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    if (context) await context.close().catch(() => {});
    serverProc.kill();
    try { fs.rmSync(STATE_DIR, { recursive: true, force: true }); } catch (err) {}
    try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch (err) {}
  }
})();
