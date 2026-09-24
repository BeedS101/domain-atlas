// Manual check for equippable avatar looks: owning one of the two
// atlas.avatar.outfit.* crates in the lobby (spatial/lobby/scene.json) lets
// a visitor "wear" it as their own rendered character color (shirt/pants),
// via a wallet-card action (extension/viewer.js's toggle-avatar-look) that
// stores which asset is equipped per-identity (wallet.js's
// getAvatarLook()/setAvatarLook()) rather than anywhere scene- or
// domain-specific.
//
// Covers:
//   1. Opening a crate, then equipping it, actually recolors the LOCAL
//      character live (gltf-mini.js's getLocalAvatarColors() debug hook),
//      no scene reload needed — same "no reload needed" treatment
//      characterScale's own live setter already gets.
//   2. Leaving the world and coming back (a real destroy()+re-init() of
//      the 3D renderer, not just a live update) still shows the equipped
//      look — it's read back from the wallet on every world entry, not
//      cached anywhere scene-specific. This is the same mechanism that
//      makes it domain-independent too (getAvatarLook() never takes a
//      domain/world parameter at all — see wallet.js), so this is the
//      closest thing to a same-domain proxy for the actual cross-domain
//      claim without standing up a second, currently 3D-less demo domain
//      just to prove it. (No existing test re-verifies aliases/favorites/
//      loadout — the wallet's other per-identity settings, same storage
//      shape — literally cross-domain either, for the same reason: the
//      storage itself carries no domain key to begin with.)
//   3. A SECOND visitor, in the same lobby, sees the first visitor's
//      equipped look on their remote character (getRemotePlayerRenderState())
//      — it rides the same presence channel position/yaw already use.
//
// Requires presence-server/server.js running on its default port (8004)
// as well as the usual issuer-server on 8001. Not part of the permanent
// suite, same reasoning as the other manual-*.js scripts.

const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const FOREST_CRATE = { x: -1.0, z: -2.0, class: 'atlas.avatar.outfit.forest', name: 'Forest Ranger Outfit', shirtColor: '#2f5d3a', pantsColor: '#3b2a1e' };
const LAUNCH_ARGS = [
  `--disable-extensions-except=${EXT_PATH}`,
  `--load-extension=${EXT_PATH}`,
  '--no-sandbox',
  '--use-gl=swiftshader',
  '--enable-webgl',
  '--ignore-gpu-blocklist'
];

function hexToRgba01(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
}

function colorsMatch(actual, expected) {
  if (!actual || !expected) return actual === expected;
  return actual.every((v, i) => Math.abs(v - expected[i]) < 1e-6);
}

async function teleport(frame, x, z) {
  await frame.evaluate(({ x, z }) => {
    window.__atlasActive3D.camera.pos[0] = x;
    window.__atlasActive3D.camera.pos[2] = z;
  }, { x, z });
}

async function pressE(frame) {
  await frame.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE' })));
  await frame.evaluate(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyE' })));
}

// Creates a fresh identity and walks into the 3D lobby — same setup shape
// as manual-lobby-interactables.js/manual-multiplayer-presence.js.
async function createIdentityAndEnterLobby(context, password, label) {
  const page = await context.newPage();
  page.on('pageerror', (err) => console.log(label + ' PAGEERROR:', String(err)));
  await page.goto('http://localhost:8001', { waitUntil: 'load' });
  await page.locator('#domain-atlas-enter-btn').click();
  const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
  const frame = await frameHandle.contentFrame();
  frame.on('pageerror', (err) => console.log(label + ' FRAMEERROR:', String(err)));
  await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });

  await frame.locator('#walletBtn').click();
  await frame.locator('#chooseNewBtn').click();
  await frame.locator('#newPasswordInput').fill(password);
  await frame.locator('#newPasswordConfirmInput').fill(password);
  await frame.locator('#confirmCreateBtn').click();
  await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
  await frame.locator('#seedConfirmCheck').check();
  await frame.locator('#seedConfirmBtn').click();
  await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
  await frame.locator('#walletBtn').click();
  await frame.waitForFunction(() => !document.getElementById('walletPanel').classList.contains('open'), { timeout: 5000 });

  await enterLobbyFromPlaza(frame);
  console.log('SETUP: ' + label + ' created an identity and entered the lobby');
  return { page, frame };
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

// Proximity-only (see gltf-mini.js's portalTriggers.forEach) — no E press
// needed, teleporting into the marker's own radius fires onPortalEnter the
// very next frame.
async function leaveLobbyToPlaza(frame) {
  await teleport(frame, 0, 4.2);
  await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
}

async function openCrate(frame, crate) {
  const statusBefore = await frame.locator('#status').textContent();
  await teleport(frame, crate.x, crate.z);
  await frame.waitForFunction(() => window.__atlasActive3D.getInteractPrompt() === 'Open the crate', { timeout: 5000 });
  await pressE(frame);
  await frame.waitForFunction(({ prev }) => {
    const t = document.getElementById('status').textContent;
    return t !== prev && t.startsWith('Collected');
  }, { prev: statusBefore }, { timeout: 10000 });
}

async function equipLookFromWallet(frame, assetName) {
  await frame.locator('#walletBtn').click();
  await frame.waitForFunction(() => document.getElementById('walletPanel').classList.contains('open'), { timeout: 5000 });
  // Opening the wallet panel triggers routeWalletScreen's own
  // refreshInventoryDisplay() (a full innerHTML rebuild of the self
  // collectibles list) — the panel's 'open' class flips before that async
  // rebuild necessarily finishes, so a "⋯" menu opened (via a Playwright
  // click) on the pre-rebuild DOM can have its 'show' class silently wiped
  // the instant the rebuild replaces it. Doing the whole "find the card ->
  // open its menu -> click its action button" sequence inside one
  // retried, synchronous poll sidesteps that: each poll either opens the
  // menu or (once it's actually open) clicks the action in the very same
  // synchronous tick, so a rebuild landing between two polls just gets
  // picked up again on the next one instead of racing Playwright's own
  // cached element handle against a DOM subtree that can be replaced out
  // from under it.
  await frame.waitForFunction((name) => {
    const cards = Array.from(document.querySelectorAll('#selfCollectiblesList .wallet-item'));
    const c = cards.find((x) => x.textContent.includes(name));
    if (!c) return false;
    const toggle = c.querySelector('.card-menu-toggle');
    const menu = c.querySelector('.card-menu-items');
    if (!toggle || !menu) return false;
    if (!menu.classList.contains('show')) { toggle.click(); return false; }
    const actionBtn = c.querySelector('button[data-action="toggle-avatar-look"]');
    if (!actionBtn) return false;
    actionBtn.click();
    return true;
  }, assetName, { timeout: 10000, polling: 100 });
  await frame.waitForFunction((name) => {
    const cards = Array.from(document.querySelectorAll('#selfCollectiblesList .wallet-item'));
    const c = cards.find((x) => x.textContent.includes(name));
    return c && c.textContent.includes('Take off');
  }, assetName, { timeout: 5000 });
  await frame.locator('#walletBtn').click();
  await frame.waitForFunction(() => !document.getElementById('walletPanel').classList.contains('open'), { timeout: 5000 });
}

(async () => {
  const dirA = path.resolve(__dirname, '.chrome-profile-avatar-look-a');
  const dirB = path.resolve(__dirname, '.chrome-profile-avatar-look-b');
  const contextA = await chromium.launchPersistentContext(dirA, { headless: false, executablePath: '/opt/pw-browsers/chromium', args: LAUNCH_ARGS });
  let contextB = null;

  try {
    const { page: pageA, frame: frameA } = await createIdentityAndEnterLobby(contextA, 'avatar-look-password-a', 'A');

    console.log('STEP 1: opening the forest-outfit crate mints a real atlas.avatar.outfit.forest credential');
    await openCrate(frameA, FOREST_CRATE);
    const hasOutfit = await frameA.evaluate(async (cls) => {
      const identity = await AtlasWallet.getIdentity();
      const wallet = await AtlasWallet.getWallet(identity.publicKey);
      return wallet.some((e) => e.credential.asset.class === cls);
    }, FOREST_CRATE.class);
    if (!hasOutfit) throw new Error('Expected a real ' + FOREST_CRATE.class + ' credential in the wallet after opening the crate');
    console.log('PASS: crate minted a genuine ' + FOREST_CRATE.name + ' credential');

    console.log('STEP 2: before equipping, the local character still renders its default colors');
    const colorsBeforeEquip = await frameA.evaluate(() => window.__atlasActive3D.getLocalAvatarColors());
    if (colorsBeforeEquip !== null) throw new Error('Expected no avatar look applied yet, got: ' + JSON.stringify(colorsBeforeEquip));
    console.log('PASS: default colors (null override) before equipping anything');

    console.log('STEP 3: equipping the outfit from its wallet card recolors the LOCAL character live, no reload');
    await equipLookFromWallet(frameA, FOREST_CRATE.name);
    const expectedShirt = hexToRgba01(FOREST_CRATE.shirtColor);
    const expectedPants = hexToRgba01(FOREST_CRATE.pantsColor);
    await frameA.waitForFunction(({ shirt, pants }) => {
      const c = window.__atlasActive3D.getLocalAvatarColors();
      if (!c) return false;
      const close = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
      return close(c.shirtColor, shirt) && close(c.pantsColor, pants);
    }, { shirt: expectedShirt, pants: expectedPants }, { timeout: 5000 });
    console.log('PASS: local character now renders the Forest Ranger Outfit\'s own shirt/pants colors');

    console.log('STEP 4: leaving the lobby and coming back (a real destroy+re-init, not a live update) still shows the equipped look');
    await leaveLobbyToPlaza(frameA);
    await enterLobbyFromPlaza(frameA);
    const colorsAfterReentry = await frameA.evaluate(() => window.__atlasActive3D.getLocalAvatarColors());
    if (!colorsMatch(colorsAfterReentry && colorsAfterReentry.shirtColor, expectedShirt) || !colorsMatch(colorsAfterReentry && colorsAfterReentry.pantsColor, expectedPants)) {
      throw new Error('Expected the equipped look to still apply after a fresh world entry, got: ' + JSON.stringify(colorsAfterReentry));
    }
    // This is the same mechanism cross-domain persistence rests on —
    // getAvatarLook() (wallet.js) is read back fresh on every world entry
    // and takes no domain/world parameter at all, so a different domain's
    // world entry re-runs the exact same lookup this reentry just did.
    console.log('PASS: the equipped look survived a real world reentry, read back from the wallet rather than cached in the scene');

    console.log('STEP 5: a second visitor in the same lobby sees the first visitor\'s equipped look on their remote character');
    contextB = await chromium.launchPersistentContext(dirB, { headless: false, executablePath: '/opt/pw-browsers/chromium', args: LAUNCH_ARGS });
    const { frame: frameB } = await createIdentityAndEnterLobby(contextB, 'avatar-look-password-b', 'B');
    await frameB.waitForFunction(() => window.__atlasActive3D.getRemotePlayerCount() >= 1, { timeout: 8000 });
    const idOfA = await frameB.evaluate(() => window.__atlasActive3D.getRemotePlayerIds()[0]);
    await frameB.waitForFunction(({ id, shirt, pants }) => {
      const rp = window.__atlasActive3D.getRemotePlayerRenderState(id);
      if (!rp || !rp.colors) return false;
      const close = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
      return close(rp.colors.shirtColor, shirt) && close(rp.colors.pantsColor, pants);
    }, { id: idOfA, shirt: expectedShirt, pants: expectedPants }, { timeout: 8000 });
    console.log('PASS: visitor B sees visitor A\'s remote character wearing the same equipped look, over real presence broadcast');

    console.log('\nALL AVATAR LOOK CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await contextA.close();
    if (contextB) await contextB.close();
  }
})();
