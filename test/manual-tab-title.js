// Manual end-to-end check for the browser tab title feature (#117):
// "domain: world name" as the actual visible HOST PAGE tab title, not just
// viewer.js's own (invisible-to-the-user) document.title inside the
// cross-origin iframe.
//
// Mirrors the existing 'domain-atlas-close' postMessage pattern: viewer.js
// posts {type:'domain-atlas-title', title} to window.parent on every world
// entry, and content.js's message listener (extended, not replaced) sets
// the HOST page's real document.title, remembering the original title so
// it can be restored when the overlay closes.
//
// Requires the demo issuer-server already running on 8001 (this test does
// not start it itself — same convention as the other manual-*.js scripts):
//   cd /home/claude/domain-atlas && node issuer-server/server.js
//
// Checks:
//   1. Before opening the overlay, the host page's title is its own
//      ("Example Plaza", from demo-domain-a/index.html's <title>).
//   2. Opening the overlay and landing at Plaza sets the REAL host-page tab
//      title to "localhost:8001: Example Plaza".
//   3. Walking Plaza -> Arena updates the title to
//      "localhost:8001: Example Arena" — proves every world-entry landing
//      re-sends the message, not just the very first one.
//   4. Closing the overlay restores the host page's title to exactly what
//      it was before the overlay was ever opened ("Example Plaza" — same
//      string as the page's own <title>, not coincidentally identical to
//      the world name above).
//   5. Re-opening the overlay captures a FRESH original and sets the title
//      again correctly (proves the remembered-original variable resets to
//      null on close rather than going stale).
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
async function waitForPortal(frame, predicate, description, timeoutMs = 8000) {
  const start = Date.now();
  for (;;) {
    const portals = await projectPortals(frame);
    const match = portals.find(predicate);
    if (match) return match;
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for a portal matching: ' + description);
    await new Promise((r) => setTimeout(r, 150));
  }
}

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-tab-title');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  });

  try {
    const page = await context.newPage();
    await page.goto('http://localhost:8001', { waitUntil: 'load' });

    console.log('STEP 1: before opening the overlay, the host page has its own title');
    const originalTitle = await page.title();
    if (originalTitle !== 'Example Plaza') throw new Error('Expected host page\'s own title "Example Plaza" before any overlay, got: ' + JSON.stringify(originalTitle));
    console.log('PASS: host page title is its own, "' + originalTitle + '"');

    console.log('STEP 2: opening the overlay at Plaza sets the REAL tab title via postMessage');
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    await page.waitForFunction((expected) => document.title === expected, 'localhost:8001: Example Plaza', { timeout: 5000 });
    console.log('PASS: host page tab title is now "' + (await page.title()) + '"');

    console.log('STEP 3: walking Plaza -> Arena updates the title again');
    const toArena = await waitForPortal(frame, (p) => p.to === 'arena', 'the Arena portal from Plaza');
    await frame.locator('#scene').click({ position: { x: toArena.sx, y: toArena.sy } });
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Arena'), { timeout: 10000 });
    await page.waitForFunction((expected) => document.title === expected, 'localhost:8001: Example Arena', { timeout: 5000 });
    console.log('PASS: host page tab title updated to "' + (await page.title()) + '" on a same-domain world switch');

    console.log('STEP 4: closing the overlay restores the host page\'s ORIGINAL title exactly');
    await frame.locator('#closeBtn').click();
    await page.waitForFunction(() => !document.getElementById('domain-atlas-overlay'), { timeout: 5000 });
    await page.waitForFunction((expected) => document.title === expected, originalTitle, { timeout: 5000 });
    console.log('PASS: host page title restored to "' + (await page.title()) + '"');

    console.log('STEP 5: re-opening the overlay captures a FRESH original and sets the title again');
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle2 = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame2 = await frameHandle2.contentFrame();
    await frame2.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    await page.waitForFunction((expected) => document.title === expected, 'localhost:8001: Example Plaza', { timeout: 5000 });
    await frame2.locator('#closeBtn').click();
    await page.waitForFunction(() => !document.getElementById('domain-atlas-overlay'), { timeout: 5000 });
    await page.waitForFunction((expected) => document.title === expected, originalTitle, { timeout: 5000 });
    console.log('PASS: a second open/close cycle captures and restores a fresh original correctly, "' + (await page.title()) + '"');

    console.log('\nALL TAB TITLE CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close().catch(() => {});
  }
})();
