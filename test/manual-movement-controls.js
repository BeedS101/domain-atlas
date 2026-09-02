// Manual check for the gltf-mini.js input additions (mouse-button combo
// walk-forward, jump, crouch), the Escape pause-menu behavior (toggles the
// wallet), and that the real Fullscreen API integration (#51) is actually
// gone — replaced with a plain "F11 for fullscreen" hint in #scene3dHint,
// after real-browser testing showed requestFullscreen() fighting
// cross-origin-iframe activation wasn't worth it when the browser's own
// shortcut already works everywhere. Primary signal for the movement part
// is "did any of this throw inside the render loop" via console/page error
// capture, since pixel-level movement assertions would be brittle. Not
// part of the permanent suite, same reasoning as the other manual-*.js
// scripts.

const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');

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
            return { sx: originX + (x - z) * COS30 * SCALE, sy: originY + (x + z) * SIN30 * SCALE, to: m.portal && m.portal.to };
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

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-movement-controls');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  });

  try {
    const page = await context.newPage();
    // Only real uncaught JS exceptions count as a failure here — console
    // 'error' messages also catch incidental network noise (e.g. Chrome's
    // own background requests failing in this sandboxed test environment)
    // that has nothing to do with the code being exercised.
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    console.log('SETUP: entering the Lobby (the one gltf-mini-v1 world)');
    await page.goto('http://localhost:8001', { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });

    const portals = await projectPortals(frame);
    const toLobby = portals.find((p) => p.to === 'lobby');
    await frame.locator('#scene').click({ position: { x: toLobby.sx, y: toLobby.sy } });
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Lobby'), { timeout: 10000 });
    await page.waitForTimeout(1500);
    console.log('PASS: in the Lobby, 3D render loop running');

    console.log('STEP 1: WASD + Shift-run still work, no runtime errors');
    const canvasBox = await frame.locator('#scene3d').boundingBox();
    await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
    await page.mouse.down({ button: 'left' });
    await page.keyboard.down('KeyW');
    await page.keyboard.down('ShiftLeft');
    await page.waitForTimeout(400);
    await page.keyboard.up('ShiftLeft');
    await page.keyboard.up('KeyW');
    await page.mouse.up({ button: 'left' });
    console.log('PASS: WASD/run exercised, no errors yet ->', pageErrors.length, 'error(s) so far');

    console.log('STEP 2: holding left+right mouse buttons together (walk-forward chord)');
    await page.mouse.down({ button: 'left' });
    await page.mouse.down({ button: 'right' });
    await page.waitForTimeout(400);
    await page.mouse.up({ button: 'left' });
    await page.mouse.up({ button: 'right' });
    console.log('PASS: mouse-button combo held and released, no errors yet ->', pageErrors.length, 'error(s) so far');

    console.log('STEP 3: Space (jump) and Ctrl (crouch)');
    await page.keyboard.down('Space');
    await page.waitForTimeout(150);
    await page.keyboard.up('Space');
    await page.waitForTimeout(200); // let the jump arc finish landing
    await page.keyboard.down('ControlLeft');
    await page.waitForTimeout(250);
    await page.keyboard.up('ControlLeft');
    console.log('PASS: jump + crouch exercised, no errors yet ->', pageErrors.length, 'error(s) so far');

    if (pageErrors.length) {
      throw new Error('Console/page errors occurred during movement: ' + pageErrors.join(' | '));
    }
    console.log('PASS: no console/page errors across the whole movement sequence');

    console.log('STEP 4: Escape closes the wallet (pause-menu toggle)');
    // Wallet starts closed on entering a world — open it first so Escape
    // has something to close.
    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => document.getElementById('walletPanel').classList.contains('open'), { timeout: 5000 });
    await frame.locator('#scene3d').click({ position: { x: 5, y: 5 } }); // focus back on the scene, not a wallet input
    await page.keyboard.press('Escape');
    await frame.waitForFunction(() => !document.getElementById('walletPanel').classList.contains('open'), { timeout: 5000 });
    console.log('PASS: Escape closed the wallet panel');

    console.log('STEP 5: Escape again brings the wallet back');
    await page.keyboard.press('Escape');
    await frame.waitForFunction(() => document.getElementById('walletPanel').classList.contains('open'), { timeout: 5000 });
    console.log('PASS: Escape reopened the wallet panel');

    console.log('STEP 6: no Fullscreen API integration left (#51) — just a plain "F11" hint in the 3D scene');
    const fullscreenBtnCount = await frame.locator('#fullscreenBtn').count();
    if (fullscreenBtnCount !== 0) throw new Error('Expected #fullscreenBtn to be gone entirely, found ' + fullscreenBtnCount);
    const hintText = await frame.locator('#scene3dHint').textContent();
    if (!hintText.toLowerCase().includes('f11')) throw new Error('Expected the 3D scene hint to mention F11: ' + hintText);
    console.log('PASS: fullscreen button gone, hint mentions F11 ->', hintText);

    if (pageErrors.length) {
      throw new Error('Console/page errors occurred during the Escape sequence: ' + pageErrors.join(' | '));
    }

    console.log('\nALL MOVEMENT CONTROL CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
