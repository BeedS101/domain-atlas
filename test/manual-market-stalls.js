// Manual check for the Trading Post's clickable iron/gold stalls — a
// scene.json-declared "interactables" array lets a world put a mint action
// directly on a scene fixture instead of only behind the Settings-panel
// buttons. Covers: clicking the iron stall mints iron for self (no
// counterparty needed), clicking the gold stall mints gold for the
// counterparty (and fails cleanly with no counterparty yet), and that
// nothing about the existing Settings-panel mint buttons changed. Not part
// of the permanent suite, same reasoning as the other manual-*.js scripts.

const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');

// Same established pattern as manual-drop-pickup.js's projectItemMarkers:
// project() and window.__atlasScene are bare top-level identifiers in
// viewer.js's classic <script>, reachable directly here.
async function projectInteractables(frame) {
  return frame.evaluate(() => {
    return new Promise((resolve) => {
      const check = () => {
        const scene = window.__atlasScene;
        // Wait specifically for the Trading Post's own interactables
        // (atlas.element.* stalls), not just any non-empty array — placeLabel
        // updates before window.__atlasScene is reassigned during a world
        // transition, so a naive "is it non-empty" check can resolve on the
        // previous world's still-present interactables (e.g. the Plaza's
        // Compass/Ring stalls) instead of waiting for the real ones here.
        if (scene && scene.interactables && scene.interactables.some((m) => m.class && m.class.startsWith('atlas.element.'))) {
          const canvas = document.getElementById('scene');
          const originX = canvas.width / 2;
          const originY = canvas.height / 2 + 40;
          const points = scene.interactables.map((m) => {
            const [x, y, z] = m.position;
            const p = project(x, y || 0, z, originX, originY);
            return { sx: p.x, sy: p.y - 16, label: m.label, class: m.class };
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
  const userDataDir = path.resolve(__dirname, '.chrome-profile-market-stalls');
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
    const page = await context.newPage();

    console.log('SETUP: creating an identity and walking to the Trading Post');
    await page.goto('http://localhost:8001', { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    await frame.locator('#walletBtn').click();
    await frame.locator('#chooseNewBtn').click();
    await frame.locator('#newPasswordInput').fill('market-stall-password');
    await frame.locator('#newPasswordConfirmInput').fill('market-stall-password');
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('#walletBtn').click(); // close panel so canvas clicks land on the scene
    await frame.waitForFunction(() => !document.getElementById('walletPanel').classList.contains('open'), { timeout: 5000 });

    const plazaHb = await frame.evaluate(() => new Promise((resolve) => {
      const check = () => {
        if (portalHitboxes.length) {
          const marketHb = portalHitboxes.find((h) => h.marker.portal && h.marker.portal.to === 'market');
          if (marketHb) return resolve({ sx: marketHb.sx, sy: marketHb.sy });
        }
        requestAnimationFrame(check);
      };
      check();
    }));
    await frame.locator('#scene').click({ position: { x: plazaHb.sx, y: plazaHb.sy } });
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Trading Post'), { timeout: 10000 });
    console.log('PASS: reached the Trading Post');

    console.log('STEP 1: clicking the iron stall mints 20 iron for self, no counterparty needed');
    const [ironStall, goldStall] = await projectInteractables(frame);
    if (!ironStall || ironStall.class !== 'atlas.element.iron') throw new Error('Expected the first interactable to be the iron stall, got: ' + JSON.stringify(ironStall));
    await frame.locator('#scene').click({ position: { x: ironStall.sx, y: ironStall.sy } });
    await frame.waitForFunction(() => document.getElementById('status').textContent.startsWith('Collected'), { timeout: 10000 });
    const statusAfterIron = await frame.locator('#status').textContent();
    if (!statusAfterIron.includes('atlas.element.iron')) throw new Error('Expected the status line to mention iron: ' + statusAfterIron);
    // Confirm it actually landed in the wallet, not just a status message.
    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => document.querySelectorAll('#selfResourceList .wallet-item').length > 0, { timeout: 5000 });
    const ironCardText = await frame.locator('#selfResourceList .wallet-item').first().textContent();
    if (!ironCardText.includes('atlas.element.iron')) throw new Error('Expected iron in the self resource list: ' + ironCardText);
    console.log('PASS: clicking the iron stall actually minted iron into the wallet ->', statusAfterIron);

    console.log('STEP 2: clicking the gold stall with no counterparty yet fails cleanly (same as the existing Mine Gold button would)');
    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => !document.getElementById('walletPanel').classList.contains('open'), { timeout: 5000 });
    if (!goldStall || goldStall.class !== 'atlas.element.gold') throw new Error('Expected the second interactable to be the gold stall, got: ' + JSON.stringify(goldStall));
    await frame.locator('#scene').click({ position: { x: goldStall.sx, y: goldStall.sy } });
    await frame.waitForFunction(() => document.getElementById('status').textContent.startsWith('Mint failed'), { timeout: 10000 });
    console.log('PASS: gold stall failed cleanly with no counterparty, exactly like the panel button would');

    console.log('STEP 3: creating a counterparty, then the gold stall mints gold for it');
    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('#createCounterpartyBtn').click();
    await frame.waitForFunction(() => !document.getElementById('counterpartyIdentity').textContent.includes('No counterparty yet'), { timeout: 5000 });
    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => !document.getElementById('walletPanel').classList.contains('open'), { timeout: 5000 });
    await frame.locator('#scene').click({ position: { x: goldStall.sx, y: goldStall.sy } });
    await frame.waitForFunction(() => document.getElementById('status').textContent.startsWith('Collected'), { timeout: 10000 });
    const statusAfterGold = await frame.locator('#status').textContent();
    if (!statusAfterGold.includes('atlas.element.gold')) throw new Error('Expected the status line to mention gold: ' + statusAfterGold);
    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => document.querySelectorAll('#counterpartyResourceList .wallet-item').length > 0, { timeout: 5000 });
    console.log('PASS: with a counterparty in place, the gold stall minted gold for it ->', statusAfterGold);

    console.log('\nALL MARKET STALL CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
