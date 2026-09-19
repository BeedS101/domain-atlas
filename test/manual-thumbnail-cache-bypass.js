// Manual check for task #210: Bruno reported that after replacing a
// thumbnail .png on his live PHP site, "old image still shows" for
// visitors. Root cause and fix are in extension/viewer.js's
// loadAssetViewerThumbnail() (see its own header comment) — the Asset
// Viewer's thumbnail used to be a plain <img src="..."> relying entirely
// on the browser's own HTTP cache; it's now a fetch(url, {cache:'no-store'})
// + Blob + blob: URL, matching the pattern every other dynamic fetch in
// this file already used (manifest, scene.json, .glb models).
//
// This test doesn't re-check the "thumbnail shows up at all" / "no
// thumbnail -> no image area" ground covered by manual-asset-viewer.js's
// STEP 2 and STEP 7 — it specifically targets the caching bug and the new
// token/blob-URL bookkeeping loadAssetViewerThumbnail() and
// disposeAssetViewerModelPreview() added to make the fetch-per-display
// approach safe:
//   1. Every time the viewer is (re-)opened for a card, the thumbnail is
//      actually re-fetched over the network — not silently served from a
//      stale HTTP cache entry.
//   2. Directly reproduces Bruno's exact bug scenario: the server swaps
//      the bytes behind the SAME thumbnail URL (no filename or query-string
//      change, exactly what replacing a file on a live site looks like) —
//      the very next time the card is hovered, the NEW image shows, with
//      no extension reload needed.
//   3. A slow in-flight thumbnail fetch that's still pending when the
//      panel closes never inserts its (by-then-stale) <img> into a panel
//      that's already moved on, and throws no error.
//   4. No blob: URLs are leaked across repeated open/close cycles — every
//      createObjectURL() this feature makes is eventually revoked.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts (drives a real, slow browser + extension).

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const COMPASS_PNG = path.resolve(__dirname, '..', 'demo-domain-a', 'assets', 'compass.png');
const COMPASS_GLB = path.resolve(__dirname, '..', 'demo-domain-a', 'assets', 'compass.glb');
const SWAP_PNG = path.resolve(__dirname, 'fixtures', 'thumbnail-swap.png'); // 40x40 red square, generated for this test — deliberately a different size than compass.png's 128x128 so a naturalWidth check alone proves which bytes actually loaded

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-thumbnail-cache-bypass');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  });

  // Tracks every blob: URL this feature creates/revokes, across every
  // frame/document the context ever opens (including the extension's own
  // overlay iframe, which is a fresh document each time it's created).
  await context.addInitScript(() => {
    window.__blobUrls = new Set();
    const origCreate = URL.createObjectURL.bind(URL);
    const origRevoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => { const u = origCreate(blob); window.__blobUrls.add(u); return u; };
    URL.revokeObjectURL = (u) => { window.__blobUrls.delete(u); origRevoke(u); };
  });

  const pageErrors = [];

  try {
    const page = await context.newPage();
    page.on('pageerror', (err) => pageErrors.push(err));

    let requestCount = 0;
    let delayMs = 0;
    let currentThumbnailBody = fs.readFileSync(COMPASS_PNG);
    await context.route('https://localhost:8001/assets/compass.png', async (route) => {
      requestCount++;
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      route.fulfill({ status: 200, contentType: 'image/png', body: currentThumbnailBody });
    });
    await context.route('https://localhost:8001/assets/compass.glb', (route) => {
      route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: fs.readFileSync(COMPASS_GLB) });
    });

    console.log('SETUP: fresh identity + one Bronze Compass (has a thumbnail)');
    await page.goto('http://localhost:8001', { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    await frame.locator('#walletBtn').click();
    await frame.locator('#chooseNewBtn').click();
    await frame.locator('#newPasswordInput').fill('thumbnail-cache-test-pw');
    await frame.locator('#newPasswordConfirmInput').fill('thumbnail-cache-test-pw');
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('#requestItemBtn').click();
    await frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item').length > 0, { timeout: 15000 });
    console.log('PASS: identity + Bronze Compass ready');

    const card = frame.locator('#selfCollectiblesList .wallet-item').first();

    async function openAndWaitForThumbnail(expectedWidth) {
      await card.hover();
      await frame.waitForFunction(() => document.getElementById('assetViewerWidget').hidden === false, { timeout: 3000 });
      await frame.waitForFunction((w) => {
        const img = document.querySelector('#assetViewerBody .asset-viewer-thumbnail');
        return !!img && img.complete && img.naturalWidth === w;
      }, expectedWidth, { timeout: 5000 });
    }
    async function closeViewer() {
      await frame.page().mouse.move(5, 5); // nowhere near the card or the panel
      await frame.page().waitForTimeout(400); // past ASSET_VIEWER_CLOSE_GRACE_MS (200ms)
    }

    console.log('STEP 1: first hover fetches the thumbnail fresh and shows it (128x128)');
    await openAndWaitForThumbnail(128);
    if (requestCount !== 1) throw new Error('Expected exactly 1 network request for the thumbnail after the first hover, got ' + requestCount);
    console.log('PASS: thumbnail loaded, 1 network request so far');

    console.log('STEP 2: closing and re-hovering the SAME card re-fetches the thumbnail rather than reusing a cached copy');
    await closeViewer();
    await openAndWaitForThumbnail(128);
    if (requestCount !== 2) throw new Error('Expected a SECOND network request on re-hover (cache:no-store bypassing any HTTP cache), got ' + requestCount + ' total requests');
    console.log('PASS: re-hovering did a real second fetch, not a cached one');

    console.log('STEP 3: reproducing Bruno\'s exact bug — the server swaps the bytes behind the SAME URL (no filename/query change), and the very next display shows the new image with no reload');
    await closeViewer();
    currentThumbnailBody = fs.readFileSync(SWAP_PNG); // simulates replacing the file on the live site
    await openAndWaitForThumbnail(40);
    if (requestCount !== 3) throw new Error('Expected a THIRD network request after the swap, got ' + requestCount);
    console.log('PASS: the swapped image shows immediately — old bytes did not stick around from any cache');

    console.log('STEP 4: a slow in-flight thumbnail fetch that resolves after the panel already closed must not throw or insert a stale image');
    await closeViewer();
    delayMs = 500;
    await card.hover();
    await frame.waitForFunction(() => document.getElementById('assetViewerWidget').hidden === false, { timeout: 3000 });
    // Close well before the delayed fetch can resolve.
    await frame.page().mouse.move(5, 5);
    await frame.page().waitForTimeout(300); // past the 200ms close-grace window, but still well within the 500ms fetch delay
    const closedWhileFetchInFlight = await frame.evaluate(() => document.getElementById('assetViewerWidget').hidden === true);
    if (!closedWhileFetchInFlight) throw new Error('Expected the panel to have closed already, before the slow fetch resolves');
    await frame.page().waitForTimeout(400); // let the delayed fetch actually resolve now that the panel is closed
    delayMs = 0;
    const bodyAfterLateResolve = await frame.evaluate(() => document.getElementById('assetViewerBody').innerHTML);
    if (bodyAfterLateResolve.trim() !== '') throw new Error('Expected the late-resolving fetch to insert nothing into the now-closed panel, got: ' + bodyAfterLateResolve);
    if (pageErrors.length > 0) throw new Error('Expected no page errors from the late-resolving fetch, got: ' + pageErrors.map((e) => e.message).join('; '));
    console.log('PASS: the stale fetch resolved harmlessly — no error, nothing inserted into the closed panel');

    console.log('STEP 5: no blob: URLs are left outstanding after all these open/close cycles');
    // __blobUrls lives on the extension overlay iframe's own window (where
    // viewer.js's URL.createObjectURL() calls actually happen), not the
    // top page's — addInitScript() runs in every frame's fresh document,
    // but each frame keeps its own separate window object.
    const outstandingBlobUrls = await frame.evaluate(() => window.__blobUrls.size);
    if (outstandingBlobUrls !== 0) throw new Error('Expected every created blob: URL to have been revoked by now, got ' + outstandingBlobUrls + ' still outstanding');
    console.log('PASS: no leaked blob: URLs');

    console.log('\nALL THUMBNAIL CACHE-BYPASS CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close().catch(() => {});
  }
})();
