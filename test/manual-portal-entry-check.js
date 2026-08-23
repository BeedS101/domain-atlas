// Throwaway manual check: confirm the lobby portal DOES fire when the
// player deliberately walks INTO it (as opposed to the earlier bug where
// it fired immediately at spawn). Walks backward (KeyS, away from the desk,
// toward the portal ring near the entrance) and expects a transition back
// to the plaza world.
const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-portal-check');
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
    await page.goto('http://localhost:8001', { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();

    // Get into the lobby the same way manual-lobby-check.js does.
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
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
    await frame.locator('#scene').click({ position: { x: lobbyPortal.sx, y: lobbyPortal.sy } });
    await frame.waitForFunction(() => document.getElementById('scene3d').classList.contains('active'), { timeout: 10000 });
    console.log('PASS: entered lobby, 3D canvas active');

    // Confirm it did NOT immediately bounce back (the old bug).
    await page.waitForTimeout(800);
    const stillLobby = await frame.evaluate(() => document.getElementById('status').textContent);
    console.log('status after settling:', stillLobby);
    if (!stillLobby.includes('lobby')) throw new Error('Regression: portal fired at spawn again');

    // Now deliberately walk backward (KeyS) toward the entrance portal.
    await frame.locator('#scene3d').click({ position: { x: 400, y: 300 } });
    for (let i = 0; i < 90; i++) {
      await frame.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyS' })));
      await page.waitForTimeout(16);
      const status = await frame.evaluate(() => document.getElementById('status').textContent);
      if (status.includes('plaza')) {
        console.log('PASS: walked into the portal and returned to plaza after', i, 'ticks');
        await context.close();
        return;
      }
    }
    throw new Error('Never reached the plaza after walking backward for 90 ticks');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
