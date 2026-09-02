// Manual check for the fullscreen cursor auto-hide feature in viewer.js.
//
// F11's native browser fullscreen can't be scripted or even reliably
// detected via the DOM (see viewer.js's looksFullscreen() comment — no
// fullscreenchange event, no document.fullscreenElement), so this test
// doesn't actually press F11. Instead it does what the real heuristic
// itself does: resize the page's viewport to exactly match
// window.screen's dimensions (what looksFullscreen() checks for) via
// Playwright's setViewportSize, which is the same effect a real F11
// fullscreen has on this 100vw/100vh iframe's own window.innerWidth/Height.
//
// Checks:
//   1. NOT "fullscreen" (viewport smaller than the screen): cursor never
//      hides, even after waiting past the idle timeout.
//   2. "Fullscreen" (viewport == screen size): cursor hides after the idle
//      timeout.
//   3. Any mouse movement instantly un-hides it again.
//   4. Leaving "fullscreen" (resizing away again) leaves the cursor
//      visible, doesn't get stuck hidden.
//   5. The actual bug reported: dragging to look around (the gltf-mini-v1
//      3D renderer's own mousemove-driven camera turn) must NOT keep
//      un-hiding the cursor / resetting its idle timer the way ordinary
//      mouse movement does — otherwise the cursor can never stay hidden
//      while the user is actively playing, only while their hand is off
//      the mouse entirely. Verifies the cursor, once hidden, stays hidden
//      throughout a multi-second look-drag, and that ending the drag and
//      moving the mouse again restores normal (un-hide-then-re-idle)
//      behavior.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-fullscreen-cursor');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  });

  try {
    const page = await context.newPage();

    console.log('SETUP: opening the overlay');
    await page.goto('http://localhost:8001', { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    console.log('PASS: overlay open');

    const screenSize = await frame.evaluate(() => ({ width: window.screen.width, height: window.screen.height }));
    console.log('Detected screen size:', screenSize);

    console.log('STEP 1: NOT fullscreen-sized — cursor stays visible even past the idle timeout');
    await page.setViewportSize({ width: Math.max(200, screenSize.width - 200), height: Math.max(200, screenSize.height - 200) });
    await page.waitForTimeout(2600); // idle timeout is 2000ms
    const cursorNotFullscreen = await frame.evaluate(() => document.body.style.cursor);
    if (cursorNotFullscreen === 'none') throw new Error('Cursor hid while the viewport did NOT match the screen size — looksFullscreen() false-positived');
    console.log('PASS: cursor stayed visible (cursor=' + JSON.stringify(cursorNotFullscreen) + ')');

    console.log('STEP 2: viewport resized to exactly match the screen — cursor hides after the idle timeout');
    await page.setViewportSize({ width: screenSize.width, height: screenSize.height });
    await page.waitForTimeout(2600);
    const cursorFullscreen = await frame.evaluate(() => document.body.style.cursor);
    if (cursorFullscreen !== 'none') throw new Error('Expected cursor to be hidden (cursor:none) after idling in a fullscreen-sized viewport, got: ' + JSON.stringify(cursorFullscreen));
    console.log('PASS: cursor hidden (cursor=' + JSON.stringify(cursorFullscreen) + ')');

    console.log('STEP 3: any mouse movement instantly un-hides it');
    await page.mouse.move(100, 100);
    await page.mouse.move(150, 120);
    const cursorAfterMove = await frame.evaluate(() => document.body.style.cursor);
    if (cursorAfterMove === 'none') throw new Error('Expected mouse movement to instantly un-hide the cursor, but it is still hidden');
    console.log('PASS: cursor reappeared immediately on movement (cursor=' + JSON.stringify(cursorAfterMove) + ')');

    console.log('STEP 4: leaving the fullscreen-sized viewport leaves the cursor visible (never stuck hidden)');
    await page.waitForTimeout(2600); // let it re-hide first, to prove leaving fullscreen is what un-hides it, not lingering state from STEP 3
    const cursorReHidden = await frame.evaluate(() => document.body.style.cursor);
    if (cursorReHidden !== 'none') throw new Error('Expected the cursor to hide again after re-idling in the fullscreen-sized viewport, got: ' + JSON.stringify(cursorReHidden));
    await page.setViewportSize({ width: Math.max(200, screenSize.width - 200), height: Math.max(200, screenSize.height - 200) });
    await page.waitForTimeout(200);
    const cursorAfterLeaving = await frame.evaluate(() => document.body.style.cursor);
    if (cursorAfterLeaving === 'none') throw new Error('Cursor stayed hidden after leaving the fullscreen-sized viewport');
    console.log('PASS: leaving fullscreen-size immediately restored the cursor (cursor=' + JSON.stringify(cursorAfterLeaving) + ')');

    console.log('STEP 5: a look-drag in the 3D world does not defeat the cursor auto-hide');
    console.log('  entering the Lobby (the one gltf-mini-v1 world)');
    const portals = await frame.evaluate(() => {
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
    const toLobby = portals.find((p) => p.to === 'lobby');
    await frame.locator('#scene').click({ position: { x: toLobby.sx, y: toLobby.sy } });
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Lobby'), { timeout: 10000 });
    await page.waitForTimeout(500);
    console.log('  in the Lobby, 3D render loop running');

    await page.setViewportSize({ width: screenSize.width, height: screenSize.height });
    const canvasBox = await frame.locator('#scene3d').boundingBox();
    const cx = canvasBox.x + canvasBox.width / 2, cy = canvasBox.y + canvasBox.height / 2;
    await page.mouse.move(cx, cy);
    await page.waitForTimeout(2600); // let it idle-hide
    const cursorBeforeDrag = await frame.evaluate(() => document.body.style.cursor);
    if (cursorBeforeDrag !== 'none') throw new Error('Expected cursor to be hidden before starting the drag, got: ' + JSON.stringify(cursorBeforeDrag));
    console.log('  cursor hidden before drag, as expected');

    console.log('  starting a look-drag (pointerdown + continued mousemove) spanning past the idle timeout');
    await page.mouse.down();
    for (let i = 0; i < 8; i++) {
      await page.mouse.move(cx + i * 15, cy, { steps: 3 });
      await page.waitForTimeout(350); // 8 * 350ms = 2.8s, longer than the 2000ms idle timeout
      const cursorDuringDrag = await frame.evaluate(() => document.body.style.cursor);
      if (cursorDuringDrag !== 'none') {
        await page.mouse.up();
        throw new Error('Cursor became visible mid-drag (tick ' + i + ') — the look-drag is defeating the auto-hide, cursor=' + JSON.stringify(cursorDuringDrag));
      }
    }
    await page.mouse.up();
    console.log('PASS: cursor stayed hidden throughout the entire look-drag');

    console.log('  after the drag ends, ordinary mouse movement still un-hides it normally');
    await page.mouse.move(cx + 200, cy + 5);
    const cursorAfterDragEnds = await frame.evaluate(() => document.body.style.cursor);
    if (cursorAfterDragEnds === 'none') throw new Error('Expected post-drag mouse movement to un-hide the cursor normally, but it is still hidden');
    console.log('PASS: post-drag movement un-hid the cursor normally (cursor=' + JSON.stringify(cursorAfterDragEnds) + ')');

    console.log('\nALL FULLSCREEN CURSOR CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
