// Manual check for dropping a wallet item into the (2D) scene and picking
// it back up — local-only, self-only: nothing is ever transferred, "Drop
// here" just records a position and unloads it from the loadout, "Pick
// up" clears that record. Covers both ways of picking it back up (the
// wallet-panel "Pick up" button, and clicking the marker directly in the
// scene), plus Escape cancelling a placement in progress. Not part of the
// permanent suite, same reasoning as the other manual-*.js scripts.

const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');

// Mirrors verify-wallet.js's projectPortals helper: waits for the scene's
// item markers to exist, then projects each one's 3D position to the same
// 2D canvas pixel coordinates viewer.js's own project() would draw it at
// (project() is a bare top-level function in viewer.js's classic <script>,
// so — like AtlasWallet — it's reachable as a plain identifier here, not
// window.project). The marker bobs by a few px and has a generous ~21px
// hit radius, so ignoring the bob offset here is safe for a click test.
async function projectItemMarkers(frame) {
  return frame.evaluate(() => {
    return new Promise((resolve) => {
      const check = () => {
        const scene = window.__atlasScene;
        if (scene && scene.itemMarkers && scene.itemMarkers.length) {
          const canvas = document.getElementById('scene');
          const originX = canvas.width / 2;
          const originY = canvas.height / 2 + 40;
          const points = scene.itemMarkers.map((m) => {
            const [x, , z] = m.position;
            const p = project(x, 0, z, originX, originY);
            return { sx: p.x, sy: p.y - 14, credentialId: m.credentialId, name: m.name };
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
  const userDataDir = path.resolve(__dirname, '.chrome-profile-drop-pickup');
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

    console.log('SETUP: creating an identity and requesting an item in Example Plaza (2D renderer)');
    await page.goto('http://localhost:8001', { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    await frame.locator('#walletBtn').click();
    await frame.locator('#chooseNewBtn').click();
    await frame.locator('#newPasswordInput').fill('drop-test-password');
    await frame.locator('#newPasswordConfirmInput').fill('drop-test-password');
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('#requestItemBtn').click();
    await frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item').length > 0, { timeout: 15000 });
    console.log('PASS: identity + one item (Bronze Compass) ready');

    console.log('STEP 1: pressing Escape right after "Drop here" cancels the placement — the item never leaves the wallet');
    await frame.locator('#selfCollectiblesList .wallet-item button[data-action="drop"]').click();
    await frame.waitForFunction(() => document.getElementById('status').textContent.includes('Click where you want to drop it'), { timeout: 5000 });
    await frame.locator('body').press('Escape');
    await frame.waitForFunction(() => document.getElementById('status').textContent === 'Drop cancelled.', { timeout: 5000 });
    const stillThereAfterCancel = await frame.locator('#selfCollectiblesList .wallet-item').count();
    if (stillThereAfterCancel !== 1) throw new Error('Escape should have left the item exactly where it was, still carried');
    const droppedSectionHiddenAfterCancel = await frame.locator('#droppedItemsSection').isHidden();
    if (!droppedSectionHiddenAfterCancel) throw new Error('Nothing should be dropped after cancelling with Escape');
    console.log('PASS: Escape backed out of placement, nothing dropped');

    console.log('STEP 2: "Drop here" then clicking the scene places the item there — it leaves the normal list and appears under "Dropped in this world"');
    await frame.locator('#selfCollectiblesList .wallet-item button[data-action="drop"]').click();
    await frame.waitForFunction(() => document.getElementById('status').textContent.includes('Click where you want to drop it'), { timeout: 5000 });
    // A drop-in-progress claims the very next canvas click no matter where
    // it lands, so any on-canvas point works here.
    await frame.locator('#scene').click({ position: { x: 90, y: 90 } });
    await frame.waitForFunction(() => document.getElementById('status').textContent.startsWith('Dropped.'), { timeout: 5000 });
    await frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item').length === 0, { timeout: 5000 });
    const droppedVisible = await frame.locator('#droppedItemsSection').isVisible();
    if (!droppedVisible) throw new Error('Expected the "Dropped in this world" section to show after dropping');
    const droppedRowText = await frame.locator('#droppedItemsList .info-card').textContent();
    if (!droppedRowText.includes('Bronze Compass')) throw new Error('Expected the dropped row to name the item: ' + droppedRowText);
    const markerCount = await frame.evaluate(() => (window.__atlasScene.itemMarkers || []).length);
    if (markerCount !== 1) throw new Error('Expected exactly one item marker in the scene, got ' + markerCount);
    console.log('PASS: item left the carried list, shows under "Dropped in this world", and has a live scene marker');

    console.log('STEP 3: clicking the marker directly in the scene picks it back up');
    const [marker] = await projectItemMarkers(frame);
    await frame.locator('#scene').click({ position: { x: marker.sx, y: marker.sy } });
    await frame.waitForFunction(() => document.getElementById('status').textContent === 'Picked it back up.', { timeout: 5000 });
    await frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item').length === 1, { timeout: 5000 });
    const droppedHiddenAfterMarkerPickup = await frame.locator('#droppedItemsSection').isHidden();
    if (!droppedHiddenAfterMarkerPickup) throw new Error('Expected "Dropped in this world" to disappear once nothing is dropped');
    const markerCountAfter = await frame.evaluate(() => (window.__atlasScene.itemMarkers || []).length);
    if (markerCountAfter !== 0) throw new Error('Expected the scene marker to be gone after pick-up');
    console.log('PASS: clicking the in-scene marker picked the item back up, marker and "Dropped" section both gone');

    console.log('STEP 4: drop again, this time pick it up via the wallet-panel "Pick up" button instead of the scene');
    await frame.locator('#selfCollectiblesList .wallet-item button[data-action="drop"]').click();
    await frame.waitForFunction(() => document.getElementById('status').textContent.includes('Click where you want to drop it'), { timeout: 5000 });
    await frame.locator('#scene').click({ position: { x: 260, y: 180 } });
    await frame.waitForFunction(() => document.getElementById('status').textContent.startsWith('Dropped.'), { timeout: 5000 });
    await frame.locator('#droppedItemsList button[data-action="pick-up"]').click();
    await frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item').length === 1, { timeout: 5000 });
    const droppedHiddenAfterListPickup = await frame.locator('#droppedItemsSection').isHidden();
    if (!droppedHiddenAfterListPickup) throw new Error('Expected "Dropped in this world" to disappear after using its own Pick up button');
    console.log('PASS: the wallet-panel "Pick up" button works too, independent of finding the marker in the scene');

    console.log('\nALL DROP / PICK-UP CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
