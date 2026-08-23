// Throwaway manual visual check for the new gltf-mini-v1 lobby world — not
// part of the permanent regression suite, just for iterating on the layout.
const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
function shot(name) { return path.resolve(__dirname, name); }

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-lobby-check');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-sandbox',
      '--use-gl=swiftshader',
      '--enable-webgl',
      '--ignore-gpu-blocklist'
    ]
  });
  try {
    const page = await context.newPage();
    page.on('console', (msg) => console.log('PAGE:', msg.type(), msg.text()));
    page.on('pageerror', (err) => console.log('PAGEERROR:', String(err)));

    await page.goto('http://localhost:8001', { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    frame.on('console', (msg) => console.log('FRAME:', msg.type(), msg.text()));
    frame.on('pageerror', (err) => console.log('FRAMEERROR:', String(err)));
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    console.log('PASS: plaza loaded');

    // Check WebGL is actually available in this browser context.
    const glCheck = await frame.evaluate(() => {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
      return gl ? gl.getParameter(gl.VERSION) : 'NO_WEBGL';
    });
    console.log('WebGL check:', glCheck);

    // Walk into the lobby portal (marker at plaza position [0,0,7]).
    const portals = await frame.evaluate(() => new Promise((resolve) => {
      const check = () => {
        if (window.__atlasScene && window.__atlasScene.portalMarkers.length) {
          const canvasEl = document.getElementById('scene');
          const originX = canvasEl.width / 2, originY = canvasEl.height / 2 + 40;
          const SCALE = 26, COS30 = Math.cos(Math.PI / 6), SIN30 = Math.sin(Math.PI / 6);
          resolve(window.__atlasScene.portalMarkers.map((m) => {
            const [x, , z] = m.position;
            return { sx: originX + (x - z) * COS30 * SCALE, sy: originY + (x + z) * SIN30 * SCALE, to: m.portal && m.portal.to };
          }));
        } else requestAnimationFrame(check);
      };
      check();
    }));
    const lobbyPortal = portals.find((p) => p.to === 'lobby');
    if (!lobbyPortal) throw new Error('No lobby portal found on plaza scene: ' + JSON.stringify(portals));
    await frame.locator('#scene').click({ position: { x: lobbyPortal.sx, y: lobbyPortal.sy } });

    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Lobby'), { timeout: 10000 });
    console.log('PASS: entered lobby world');
    await frame.waitForFunction(() => document.getElementById('scene3d').classList.contains('active'), { timeout: 5000 });
    console.log('PASS: 3D canvas is active');

    // Poll classList + any status text over the loading window to see
    // exactly what happens (and when) instead of guessing.
    for (let i = 0; i < 10; i++) {
      const poll = await frame.evaluate(() => ({
        cls: document.getElementById('scene3d').className,
        status: document.getElementById('status').textContent
      }));
      console.log('poll', i, poll);
      await page.waitForTimeout(200);
    }
    const dims = await frame.evaluate(() => {
      const c = document.getElementById('scene3d');
      const cs = getComputedStyle(c);
      return { clientWidth: c.clientWidth, clientHeight: c.clientHeight, canvasWidth: c.width, canvasHeight: c.height, display: cs.display, position: cs.position, top: cs.top, width: cs.width, height: cs.height };
    });
    console.log('scene3d dims:', dims);
    await page.screenshot({ path: shot('lobby-01-initial.png') });

    // Walk forward a bit (W key) to move away from spawn and look around.
    await frame.locator('#scene3d').click({ position: { x: 400, y: 300 } }); // focus canvas for key events
    for (let i = 0; i < 30; i++) {
      await frame.evaluate(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
      });
      await page.waitForTimeout(16);
    }
    await frame.evaluate(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' })));
    await page.waitForTimeout(300);
    await page.screenshot({ path: shot('lobby-02-walked-forward.png') });

    const camState = await frame.evaluate(() => ({ pos: window.__atlasActive3DCameraDebug || null }));
    console.log('camera debug (if exposed):', camState);

    console.log('\nMANUAL LOBBY CHECK DONE — inspect the screenshots');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
