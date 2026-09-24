// Manual check for the equippable avatar SHOES — a third, independent
// equip slot alongside the outfit look (manual-avatar-look.js) and the hat
// (manual-avatar-hat.js): owning one of the two atlas.avatar.shoes.* crates
// in the lobby lets a visitor "wear" it as a new geometry piece on the
// shared character model (gltf-mini.js's buildCharacter()/drawCharacterAt()),
// via its own wallet-card action (toggle-avatar-shoes) and its own
// per-identity storage (wallet.js's getAvatarShoes()/setAvatarShoes()) that
// never touches, and is never touched by, whatever outfit or hat happens to
// be equipped.
//
// Also covers the Settings -> Player character live preview
// (MiniGLTF.previewCharacter(), wired up in viewer.js's openSettings())
// showing exactly what's currently equipped, without any world open.
//
// Covers:
//   1. Opening the boots crate mints a real atlas.avatar.shoes.boots
//      credential.
//   2. Before equipping, the local character has no shoes.
//   3. Equipping the shoes adds them live (no reload), the same "no reload
//      needed" treatment the outfit and hat already get.
//   4. Equipping a hat and an outfit on top does NOT disturb the shoes —
//      all three apply at once, proving the slots are genuinely
//      independent of each other.
//   5. Taking the shoes back off leaves the hat and outfit equipped —
//      independence in the other direction.
//   6. Re-equipping the shoes, then leaving and re-entering the world (a
//      real destroy+re-init), all three survive — same wallet-backed,
//      scene-independent mechanism manual-avatar-hat.js already exercises
//      for the outfit+hat pair.
//   7. A second visitor sees the first visitor's shoes (alongside their hat
//      and outfit) on the remote character, over real presence broadcast.
//   8. Settings -> Player character's live preview canvas reflects the
//      currently-equipped shoes, hat, and outfit, with no world open at all.
//
// Requires presence-server/server.js running on its default port (8004)
// as well as the usual issuer-server on 8001. Not part of the permanent
// suite, same reasoning as the other manual-*.js scripts.

const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const BOOTS_CRATE = { x: 1.3, z: -3.9, class: 'atlas.avatar.shoes.boots', name: 'Trailblazer Boots', shoeColor: '#4a3222' };
const SUNHAT_CRATE = { x: 2.5, z: -1.5, class: 'atlas.avatar.hat.sunhat', name: 'Explorer Sun Hat', hatColor: '#d9a441' };
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

// The game loop's own edge detection (gltf-mini.js's interactKeyDown &&
// !wasInteractKeyDown) only fires an interact if a render frame actually
// samples keys['KeyE'] as true between the down and up events — waiting a
// real animation frame in between (rather than firing both back to back)
// guarantees at least one frame sees it down, instead of relying on
// however much real time two separate round-trips happen to take.
async function pressE(frame) {
  await frame.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE' })));
  await frame.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await frame.evaluate(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyE' })));
}

// Same setup shape as manual-avatar-look.js/manual-avatar-hat.js.
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

async function leaveLobbyToPlaza(frame) {
  await teleport(frame, 0, 4.2);
  await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
}

// Waits for a genuine credential of `crate.class` to land in the wallet,
// rather than comparing the #status line's text — several crates in this
// scene share the exact same interactable label ("Open the crate"), so
// their post-collect status text is identical and a text-diff check can't
// tell them apart. Checking the wallet directly is unambiguous either way.
async function openCrate(frame, crate) {
  await teleport(frame, crate.x, crate.z);
  await frame.waitForFunction(() => window.__atlasActive3D.getInteractPrompt() === 'Open the crate', { timeout: 5000 });
  await pressE(frame);
  // The mint is a real network round trip to the issuer (handleInteractable
  // -> mintAsset -> a POST that only then lands in wallet storage) — give
  // it a moment before polling, rather than hammering AtlasWallet.getWallet()
  // every animation frame from the very first instant.
  await frame.waitForTimeout(1000);
  await frame.waitForFunction(async (cls) => {
    const identity = await AtlasWallet.getIdentity();
    const wallet = await AtlasWallet.getWallet(identity.publicKey);
    return wallet.some((e) => e.credential.asset.class === cls);
  }, crate.class, { timeout: 10000 });
  // The wallet storage write (just confirmed above) and handleInteractable's
  // own refreshInventoryDisplay() re-render of the wallet-item list are two
  // separate steps of the same async chain — storage can resolve a beat
  // before the DOM actually reflects the new card. A short settle here
  // avoids racing the very next wallet-panel interaction against that
  // in-flight re-render.
  await frame.waitForTimeout(300);
}

// action is one of 'toggle-avatar-look' / 'toggle-avatar-hat' /
// 'toggle-avatar-shoes' — the three independent wallet-card equip actions.
async function toggleFromWallet(frame, assetName, action, expectSubstring) {
  await frame.locator('#walletBtn').click();
  await frame.waitForFunction(() => document.getElementById('walletPanel').classList.contains('open'), { timeout: 5000 });
  // Opening the wallet panel triggers routeWalletScreen's own
  // refreshInventoryDisplay() (a full innerHTML rebuild of the self
  // collectibles list) — the panel's 'open' class flips before that async
  // rebuild necessarily finishes, so a "⋯" menu opened (via a Playwright
  // click) on the pre-rebuild DOM can have its 'show' class silently wiped
  // the instant the rebuild replaces it, with three crates now cycling
  // through this same wallet the window is wide enough to hit often. Doing
  // the whole "find the card -> open its menu -> click its action button"
  // sequence inside one retried, synchronous poll sidesteps that: each
  // poll either opens the menu or (once it's actually open) clicks the
  // action in the very same synchronous tick, so a rebuild landing between
  // two polls just gets picked up again on the next one instead of racing
  // Playwright's own cached element handle against a DOM subtree that can
  // be replaced out from under it.
  await frame.waitForFunction(({ name, action }) => {
    const cards = Array.from(document.querySelectorAll('#selfCollectiblesList .wallet-item'));
    const c = cards.find((x) => x.textContent.includes(name));
    if (!c) return false;
    const toggle = c.querySelector('.card-menu-toggle');
    const menu = c.querySelector('.card-menu-items');
    if (!toggle || !menu) return false;
    if (!menu.classList.contains('show')) { toggle.click(); return false; }
    const actionBtn = c.querySelector('button[data-action="' + action + '"]');
    if (!actionBtn) return false;
    actionBtn.click();
    return true;
  }, { name: assetName, action }, { timeout: 10000, polling: 100 });
  await frame.waitForFunction(({ name, substr }) => {
    const cards = Array.from(document.querySelectorAll('#selfCollectiblesList .wallet-item'));
    const c = cards.find((x) => x.textContent.includes(name));
    return c && c.textContent.includes(substr);
  }, { name: assetName, substr: expectSubstring }, { timeout: 5000 });
  await frame.locator('#walletBtn').click();
  await frame.waitForFunction(() => !document.getElementById('walletPanel').classList.contains('open'), { timeout: 5000 });
}

async function openSettingsScreen(frame) {
  await frame.locator('#walletBtn').click();
  await frame.waitForFunction(() => document.getElementById('walletPanel').classList.contains('open'), { timeout: 5000 });
  await frame.locator('#settingsTabBtn').click();
  await frame.waitForFunction(() => document.getElementById('settingsScreen').classList.contains('active'), { timeout: 5000 });
  await frame.waitForFunction(() => !!window.__atlasCharacterPreview, { timeout: 5000 });
}

async function closeSettingsAndWallet(frame) {
  await frame.locator('#backFromSettingsBtn').click();
  await frame.locator('#walletBtn').click();
  await frame.waitForFunction(() => !document.getElementById('walletPanel').classList.contains('open'), { timeout: 5000 });
}

(async () => {
  const dirA = path.resolve(__dirname, '.chrome-profile-avatar-shoes-a');
  const dirB = path.resolve(__dirname, '.chrome-profile-avatar-shoes-b');
  const contextA = await chromium.launchPersistentContext(dirA, { headless: false, executablePath: '/opt/pw-browsers/chromium', args: LAUNCH_ARGS });
  let contextB = null;

  try {
    const { frame: frameA } = await createIdentityAndEnterLobby(contextA, 'avatar-shoes-password-a', 'A');

    console.log('STEP 1: opening the boots crate mints a real atlas.avatar.shoes.boots credential');
    await openCrate(frameA, BOOTS_CRATE);
    const hasShoes = await frameA.evaluate(async (cls) => {
      const identity = await AtlasWallet.getIdentity();
      const wallet = await AtlasWallet.getWallet(identity.publicKey);
      return wallet.some((e) => e.credential.asset.class === cls);
    }, BOOTS_CRATE.class);
    if (!hasShoes) throw new Error('Expected a real ' + BOOTS_CRATE.class + ' credential in the wallet after opening the crate');
    console.log('PASS: crate minted a genuine ' + BOOTS_CRATE.name + ' credential');

    console.log('STEP 2: before equipping, the local character has no shoes');
    const shoesBeforeEquip = await frameA.evaluate(() => window.__atlasActive3D.getLocalAvatarShoeColor());
    if (shoesBeforeEquip !== null) throw new Error('Expected no shoes applied yet, got: ' + JSON.stringify(shoesBeforeEquip));
    console.log('PASS: no shoes (null) before equipping anything');

    console.log('STEP 3: equipping the shoes from its wallet card adds them to the LOCAL character live, no reload');
    await toggleFromWallet(frameA, BOOTS_CRATE.name, 'toggle-avatar-shoes', 'Take off shoes');
    const expectedShoes = hexToRgba01(BOOTS_CRATE.shoeColor);
    await frameA.waitForFunction((shoes) => {
      const c = window.__atlasActive3D.getLocalAvatarShoeColor();
      return c && c.every((v, i) => Math.abs(v - shoes[i]) < 1e-6);
    }, expectedShoes, { timeout: 5000 });
    console.log('PASS: local character now renders the Trailblazer Boots\' own color');

    console.log('STEP 4: equipping a hat and an outfit on top does not disturb the shoes — the three slots are independent');
    await openCrate(frameA, SUNHAT_CRATE);
    await toggleFromWallet(frameA, SUNHAT_CRATE.name, 'toggle-avatar-hat', 'Take off hat');
    const expectedHat = hexToRgba01(SUNHAT_CRATE.hatColor);
    await frameA.waitForFunction((hat) => {
      const c = window.__atlasActive3D.getLocalAvatarHatColor();
      return c && c.every((v, i) => Math.abs(v - hat[i]) < 1e-6);
    }, expectedHat, { timeout: 5000 });
    await openCrate(frameA, FOREST_CRATE);
    await toggleFromWallet(frameA, FOREST_CRATE.name, 'toggle-avatar-look', 'Take off (stop wearing this look)');
    const expectedShirt = hexToRgba01(FOREST_CRATE.shirtColor);
    const expectedPants = hexToRgba01(FOREST_CRATE.pantsColor);
    await frameA.waitForFunction(({ shirt, pants }) => {
      const c = window.__atlasActive3D.getLocalAvatarColors();
      if (!c) return false;
      const close = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
      return close(c.shirtColor, shirt) && close(c.pantsColor, pants);
    }, { shirt: expectedShirt, pants: expectedPants }, { timeout: 5000 });
    const shoesStillOn = await frameA.evaluate(() => window.__atlasActive3D.getLocalAvatarShoeColor());
    if (!colorsMatch(shoesStillOn, expectedShoes)) throw new Error('Expected the shoes to still be equipped after equipping a hat and an outfit, got: ' + JSON.stringify(shoesStillOn));
    console.log('PASS: outfit, hat, and shoes are all applied at once — equipping the others left the shoes untouched');

    console.log('STEP 5: taking the shoes back off leaves the hat and outfit equipped — independence in the other direction');
    await toggleFromWallet(frameA, BOOTS_CRATE.name, 'toggle-avatar-shoes', 'Wear as my shoes');
    await frameA.waitForFunction(() => window.__atlasActive3D.getLocalAvatarShoeColor() === null, { timeout: 5000 });
    const hatStillOnAfterShoesOff = await frameA.evaluate(() => window.__atlasActive3D.getLocalAvatarHatColor());
    const outfitStillOnAfterShoesOff = await frameA.evaluate(() => window.__atlasActive3D.getLocalAvatarColors());
    if (!colorsMatch(hatStillOnAfterShoesOff, expectedHat)) {
      throw new Error('Expected the hat to remain equipped after taking the shoes off, got: ' + JSON.stringify(hatStillOnAfterShoesOff));
    }
    if (!outfitStillOnAfterShoesOff || !colorsMatch(outfitStillOnAfterShoesOff.shirtColor, expectedShirt)) {
      throw new Error('Expected the outfit to remain equipped after taking the shoes off, got: ' + JSON.stringify(outfitStillOnAfterShoesOff));
    }
    console.log('PASS: taking the shoes off left the hat and outfit exactly as they were');

    console.log('STEP 6: re-equipping the shoes, then leaving and re-entering the world, all three survive');
    await toggleFromWallet(frameA, BOOTS_CRATE.name, 'toggle-avatar-shoes', 'Take off shoes');
    await frameA.waitForFunction((shoes) => {
      const c = window.__atlasActive3D.getLocalAvatarShoeColor();
      return c && c.every((v, i) => Math.abs(v - shoes[i]) < 1e-6);
    }, expectedShoes, { timeout: 5000 });
    await leaveLobbyToPlaza(frameA);
    await enterLobbyFromPlaza(frameA);
    const shoesAfterReentry = await frameA.evaluate(() => window.__atlasActive3D.getLocalAvatarShoeColor());
    const hatAfterReentry = await frameA.evaluate(() => window.__atlasActive3D.getLocalAvatarHatColor());
    const colorsAfterReentry = await frameA.evaluate(() => window.__atlasActive3D.getLocalAvatarColors());
    if (!colorsMatch(shoesAfterReentry, expectedShoes)) throw new Error('Expected the equipped shoes to survive a fresh world entry, got: ' + JSON.stringify(shoesAfterReentry));
    if (!colorsMatch(hatAfterReentry, expectedHat)) throw new Error('Expected the equipped hat to also survive a fresh world entry, got: ' + JSON.stringify(hatAfterReentry));
    if (!colorsAfterReentry || !colorsMatch(colorsAfterReentry.shirtColor, expectedShirt) || !colorsMatch(colorsAfterReentry.pantsColor, expectedPants)) {
      throw new Error('Expected the equipped outfit to also survive a fresh world entry, got: ' + JSON.stringify(colorsAfterReentry));
    }
    console.log('PASS: the shoes, hat, and outfit all survived a real world reentry, read back independently from the wallet');

    console.log('STEP 7: a second visitor sees the first visitor\'s shoes, alongside their hat and outfit, on the remote character');
    contextB = await chromium.launchPersistentContext(dirB, { headless: false, executablePath: '/opt/pw-browsers/chromium', args: LAUNCH_ARGS });
    const { frame: frameB } = await createIdentityAndEnterLobby(contextB, 'avatar-shoes-password-b', 'B');
    await frameB.waitForFunction(() => window.__atlasActive3D.getRemotePlayerCount() >= 1, { timeout: 8000 });
    const idOfA = await frameB.evaluate(() => window.__atlasActive3D.getRemotePlayerIds()[0]);
    await frameB.waitForFunction(({ id, shoes, hat, shirt, pants }) => {
      const rp = window.__atlasActive3D.getRemotePlayerRenderState(id);
      if (!rp || !rp.shoeColor || !rp.hatColor || !rp.colors) return false;
      const close = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
      return close(rp.shoeColor, shoes) && close(rp.hatColor, hat) && close(rp.colors.shirtColor, shirt) && close(rp.colors.pantsColor, pants);
    }, { id: idOfA, shoes: expectedShoes, hat: expectedHat, shirt: expectedShirt, pants: expectedPants }, { timeout: 8000 });
    console.log('PASS: visitor B sees visitor A\'s remote character wearing the shoes, hat, and outfit, over real presence broadcast');

    console.log('STEP 8: Settings -> Player character\'s live preview reflects the currently-equipped shoes, hat, and outfit, no world needed');
    await openSettingsScreen(frameA);
    const previewState = await frameA.evaluate(() => ({
      colors: window.__atlasCharacterPreview.getColors(),
      hatColor: window.__atlasCharacterPreview.getHatColor(),
      shoeColor: window.__atlasCharacterPreview.getShoeColor()
    }));
    if (!previewState.colors || !colorsMatch(previewState.colors.shirtColor, expectedShirt) || !colorsMatch(previewState.colors.pantsColor, expectedPants)) {
      throw new Error('Expected the Settings preview to show the equipped outfit, got: ' + JSON.stringify(previewState.colors));
    }
    if (!colorsMatch(previewState.hatColor, expectedHat)) {
      throw new Error('Expected the Settings preview to show the equipped hat, got: ' + JSON.stringify(previewState.hatColor));
    }
    if (!colorsMatch(previewState.shoeColor, expectedShoes)) {
      throw new Error('Expected the Settings preview to show the equipped shoes, got: ' + JSON.stringify(previewState.shoeColor));
    }
    await closeSettingsAndWallet(frameA);
    console.log('PASS: the player-character preview in Settings matches exactly what\'s equipped');

    console.log('\nALL AVATAR SHOES CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await contextA.close();
    if (contextB) await contextB.close();
  }
})();
