// Manual check for removing a loot crate's own visible model (and its
// collision box) from the gltf-mini-v1 (3D) renderer once it's already been
// looted. Before this, an opened crate stayed exactly as solid and visible
// as an unopened one — E just stopped doing anything at it (see
// manual-lobby-interactables.js's step 4) — which reads as a bug once you
// can actually walk right up and look at it. The crate's own model is an
// ordinary scene.json object placed at the same position as its
// interactable marker (see spatial/lobby/scene.json); gltf-mini.js's
// lootMarkerAt() recovers that link by position and reuses the exact same
// opts.isMarkerAlreadyOwned predicate the E-interact loop and Previewer
// already filter on, so all three agree the instant a crate is claimed.
//
// Covers:
//   1. Before looting, the crate's model draws (getLootCrateVisible) and
//      its bounding box actually blocks movement (isPositionBlocked), both
//      read directly off gltf-mini.js's own internal state.
//   2. After looting via a real E press, both flip: the model stops
//      drawing and the same spot is walkable.
//   3. A second, still-unopened crate elsewhere in the room is completely
//      unaffected by the first one's removal — this isn't a global toggle.
//
// Requires the usual issuer-server on 8001. Not part of the permanent
// suite, same reasoning as the other manual-*.js scripts.

const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const CRATE_1 = { x: 0.3, z: -0.8, class: 'atlas.trinket.pin' };
const CRATE_2 = { x: -2.0, z: 1.3, class: 'atlas.trinket.charm' };
const LAUNCH_ARGS = [
  `--disable-extensions-except=${EXT_PATH}`,
  `--load-extension=${EXT_PATH}`,
  '--no-sandbox',
  '--use-gl=swiftshader',
  '--enable-webgl',
  '--ignore-gpu-blocklist'
];

async function teleport(frame, x, z) {
  await frame.evaluate(({ x, z }) => {
    window.__atlasActive3D.camera.pos[0] = x;
    window.__atlasActive3D.camera.pos[2] = z;
  }, { x, z });
}

// Same double-rAF settle as manual-avatar-hat.js's own pressE() — the game
// loop's E-key edge detection needs a real animation frame to elapse
// between the down and up events to register at all.
async function pressE(frame) {
  await frame.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE' })));
  await frame.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await frame.evaluate(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyE' })));
}

async function enterLobbyFromPlaza(frame) {
  const lobbyHb = await frame.evaluate(() => new Promise((resolve) => {
    const check = () => {
      if (portalHitboxes.length) {
        const hb = portalHitboxes.find((h) => h.marker.portal && h.marker.portal.to === 'lobby');
        if (hb) return resolve({ sx: hb.sx, sy: hb.sy });
      }
      requestAnimationFrame(check);
    };
    check();
  }));
  await frame.locator('#scene').click({ position: { x: lobbyHb.sx, y: lobbyHb.sy } });
  await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Lobby'), { timeout: 10000 });
  await frame.waitForFunction(() => !!window.__atlasActive3D, { timeout: 10000 });
  await frame.evaluate(() => window.__atlasActive3D.ready);
}

async function openCrate(frame, crate) {
  await teleport(frame, crate.x, crate.z);
  await frame.waitForFunction(() => window.__atlasActive3D.getInteractPrompt() === 'Open the crate', { timeout: 5000 });
  await pressE(frame);
  await frame.waitForFunction((cls) => new Promise((resolve) => {
    AtlasWallet.getIdentity().then((identity) => AtlasWallet.getWallet(identity.publicKey)).then((w) => {
      resolve(w.some((e) => e.credential.asset.class === cls));
    });
  }), crate.class, { timeout: 10000 });
}

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-lobby-crate-removal');
  const context = await chromium.launchPersistentContext(userDataDir, { headless: false, executablePath: '/opt/pw-browsers/chromium', args: LAUNCH_ARGS });

  try {
    const page = await context.newPage();
    page.on('pageerror', (err) => console.log('PAGEERROR:', String(err)));

    console.log('SETUP: creating an identity and walking into the lobby');
    await page.goto('http://localhost:8001', { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    frame.on('pageerror', (err) => console.log('FRAMEERROR:', String(err)));
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });

    await frame.locator('#walletBtn').click();
    await frame.locator('#chooseNewBtn').click();
    await frame.locator('#newPasswordInput').fill('lobby-crate-removal-password');
    await frame.locator('#newPasswordConfirmInput').fill('lobby-crate-removal-password');
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => !document.getElementById('walletPanel').classList.contains('open'), { timeout: 5000 });

    await enterLobbyFromPlaza(frame);
    console.log('PASS: entered the 3D lobby with a fresh wallet');

    console.log('STEP 1: before looting, crate 1\'s model draws and its box actually blocks movement');
    const before1 = await frame.evaluate((cls) => window.__atlasActive3D.getLootCrateVisible(cls), CRATE_1.class);
    if (before1 !== true) throw new Error('Expected crate 1 to be visible before looting, got: ' + before1);
    const blockedBefore1 = await frame.evaluate(({ x, z }) => window.__atlasActive3D.isPositionBlocked(x, z), { x: CRATE_1.x, z: CRATE_1.z });
    if (blockedBefore1 !== true) throw new Error('Expected crate 1\'s position to be blocked before looting, got: ' + blockedBefore1);
    console.log('PASS: unopened crate 1 is both visible and solid');

    console.log('STEP 2: opening crate 1 (a real E press + mint, not a mock)');
    await openCrate(frame, CRATE_1);
    console.log('PASS: crate 1 opened, credential minted into the wallet');

    console.log('STEP 3: after looting, crate 1\'s model no longer draws and its spot is now walkable');
    await frame.waitForFunction((cls) => window.__atlasActive3D.getLootCrateVisible(cls) === false, CRATE_1.class, { timeout: 5000 });
    const blockedAfter1 = await frame.evaluate(({ x, z }) => window.__atlasActive3D.isPositionBlocked(x, z), { x: CRATE_1.x, z: CRATE_1.z });
    if (blockedAfter1 !== false) throw new Error('Expected crate 1\'s position to be walkable after looting, got: ' + blockedAfter1);
    console.log('PASS: looted crate 1 is gone from both the draw loop and collision');

    console.log('STEP 4: crate 2, still unopened, is completely unaffected by crate 1\'s removal');
    const visible2 = await frame.evaluate((cls) => window.__atlasActive3D.getLootCrateVisible(cls), CRATE_2.class);
    if (visible2 !== true) throw new Error('Expected crate 2 to still be visible, got: ' + visible2);
    const blocked2 = await frame.evaluate(({ x, z }) => window.__atlasActive3D.isPositionBlocked(x, z), { x: CRATE_2.x, z: CRATE_2.z });
    if (blocked2 !== true) throw new Error('Expected crate 2\'s position to still be blocked, got: ' + blocked2);
    console.log('PASS: crate 2 is untouched — the removal is scoped to the one crate actually looted');

    console.log('\nALL LOBBY CRATE REMOVAL CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
