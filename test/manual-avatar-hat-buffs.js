// Manual check for two related changes:
//
//   1. Every atlas.avatar.* class (outfits, hats, shoes) now mints with
//      tradeScope: 'bound' — an equip-slot item is meant to be worn by
//      whoever looted it, not split off into a giftable/tradeable/droppable
//      balance (see issuer-server/server.js / issuer-php/lib/store.php's
//      ASSET_CATALOG comment on the six atlas.avatar.* entries).
//   2. A hat can now carry its own randomized-per-mint speed/jump/interact-
//      range buff set, alongside the pre-existing hatColor — see
//      wallet.js's avatarHatPropertiesFromAsset() and the hat catalog
//      entries' randomizeProperties (randomHatProperties/random_hat_properties).
//      Speed and jump stack multiplicatively with whatever shoes are ALSO
//      equipped (a hat and shoes are separate slots); interact range widens
//      how far away the wearer can trigger a crate/mining node's "E —
//      <label>" prompt or pick up a dropped item. All three are read
//      directly off whatever hat is equipped by gltf-mini.js — no
//      per-scene wiring needed, same "auto-activated" design as the shoe
//      buffs (manual-avatar-shoe-buffs.js).
//
// Covers:
//   1. Before equipping a hat, all three hat buffs read back as "no bonus".
//   2. Equipping the sun hat applies ITS OWN randomly-rolled values —
//      exactly what wallet.js's getAvatarHat() returns, each within the
//      declared roll range.
//   3. Swapping to the cap applies the cap's own (independently rolled)
//      values — the one hat slot reflects whatever is equipped now.
//   4. Taking the hat off resets all three back to "no bonus".
//   5. A hat, sneakers, and an outfit credential each mint with
//      tradeScope: 'bound'.
//   6. The hat's speed buff actually speeds up real movement, and stacks
//      with the sneakers' own speed buff rather than either one alone.
//   7. The hat's jump buff actually raises the real jump arc.
//   8. The hat's interact-range buff actually widens the real proximity
//      trigger — a crate just out of base range becomes reachable the
//      instant a range-buffed hat goes on, with no movement at all.
//
// Requires the usual issuer-server on 8001. Not part of the permanent
// suite, same reasoning as the other manual-*.js scripts.

const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const SUNHAT_CRATE = { x: 2.5, z: -1.5, class: 'atlas.avatar.hat.sunhat', name: 'Explorer Sun Hat' };
const CAP_CRATE = { x: -3.2, z: -0.9, class: 'atlas.avatar.hat.cap', name: 'Night Watch Cap' };
const SNEAKERS_CRATE = { x: 4.0, z: 3.8, class: 'atlas.avatar.shoes.sneakers', name: 'Court Sneakers', speedMultiplier: 1.2 };
const OUTFIT_CRATE = { x: -1.0, z: -2.0, class: 'atlas.avatar.outfit.forest', name: 'Forest Ranger Outfit' };
const PIN_CRATE = { x: 0.3, z: -0.8, class: 'atlas.trinket.pin', radius: 1.7 };
const HAT_SPEED_RANGE = [1.05, 1.30];
const HAT_JUMP_RANGE = [1.05, 1.30];
const HAT_RANGE_RANGE = [1.10, 1.50];
const LAUNCH_ARGS = [
  `--disable-extensions-except=${EXT_PATH}`,
  `--load-extension=${EXT_PATH}`,
  '--no-sandbox',
  '--use-gl=swiftshader',
  '--enable-webgl',
  '--ignore-gpu-blocklist'
];

function inRange(v, [min, max]) { return v >= min - 0.001 && v <= max + 0.001; }

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

async function createIdentityAndEnterLobby(context, password) {
  const page = await context.newPage();
  page.on('pageerror', (err) => console.log('PAGEERROR:', String(err)));
  await page.goto('http://localhost:8001', { waitUntil: 'load' });
  await page.locator('#domain-atlas-enter-btn').click();
  const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
  const frame = await frameHandle.contentFrame();
  frame.on('pageerror', (err) => console.log('FRAMEERROR:', String(err)));
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
  console.log('SETUP: created an identity and entered the lobby');
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

// This test opens FOUR avatar crates in one run (every other manual-*.js
// script opens at most two) and that surfaced a real timing hazard: every
// crate here shares the exact same "Open the crate" label/status text (same
// reasoning manual-lobby-interactables.js's own step 6 comment gives for
// why it checks the wallet's class list instead of the status text), so a
// status-text-based wait can't distinguish "this crate just finished" from
// "a PREVIOUS crate's own leftover text, unchanged" — checking the wallet's
// own class list is the one reliable signal. What it isn't reliable about
// is TIMING: the class can appear in the wallet, then vanish again as a
// later concurrent mint's own storage write clobbers it (a read-modify-write
// race in the wallet's own storage code, not anything this feature
// touches), so this re-confirms presence after a real settle delay and
// fails loudly if it didn't stick, rather than silently pressing on into a
// later step that would fail for a confusing, unrelated-looking reason.
async function openCrate(frame, crate) {
  await teleport(frame, crate.x, crate.z);
  await frame.waitForFunction(() => window.__atlasActive3D.getInteractPrompt() === 'Open the crate', { timeout: 5000 });
  await pressE(frame);
  const hasClass = (cls) => frame.evaluate((cls) => AtlasWallet.getIdentity()
    .then((identity) => AtlasWallet.getWallet(identity.publicKey))
    .then((w) => w.some((e) => e.credential.asset.class === cls)), cls);
  await frame.waitForFunction((cls) => new Promise((resolve) => {
    AtlasWallet.getIdentity().then((identity) => AtlasWallet.getWallet(identity.publicKey)).then((w) => {
      resolve(w.some((e) => e.credential.asset.class === cls));
    });
  }), crate.class, { timeout: 10000 });
  await frame.waitForTimeout(800);
  if (!(await hasClass(crate.class))) {
    throw new Error('The ' + crate.class + ' credential appeared in the wallet right after collecting it, but was gone again ' +
      '800ms later — a concurrent mint\'s own storage write likely clobbered it (see this function\'s own comment above).');
  }
}

// Same retried-synchronous-poll design as manual-avatar-shoes.js's own
// toggleFromWallet() — opening the wallet panel triggers an async
// refreshInventoryDisplay() rebuild of the list that can silently wipe a
// "⋯" menu opened on the pre-rebuild DOM, so the whole
// "find the card -> open its menu -> click its action button" sequence
// runs inside one retried poll instead of a plain Playwright click chain.
async function toggleFromWallet(frame, assetName, action, expectSubstring) {
  await frame.locator('#walletBtn').click();
  await frame.waitForFunction(() => document.getElementById('walletPanel').classList.contains('open'), { timeout: 5000 });
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

async function getHatDebugValues(frame) {
  return frame.evaluate(() => ({
    speed: window.__atlasActive3D.getLocalAvatarHatSpeedMultiplier(),
    jump: window.__atlasActive3D.getLocalAvatarHatJumpMultiplier(),
    range: window.__atlasActive3D.getLocalAvatarHatInteractRangeMultiplier()
  }));
}

async function getWalletCredentialTradeScope(frame, cls) {
  return frame.evaluate(async (cls) => {
    const identity = await AtlasWallet.getIdentity();
    const wallet = await AtlasWallet.getWallet(identity.publicKey);
    const entry = wallet.find((e) => e.credential.asset.class === cls);
    return entry ? entry.credential.asset.tradeScope : undefined;
  }, cls);
}

// Holds W for durationMs and returns the flat XZ distance covered — used
// to compare real movement speed with and without a buff equipped.
async function measureWalkDistance(page, frame, durationMs) {
  const start = await frame.evaluate(() => ({ x: window.__atlasActive3D.camera.pos[0], z: window.__atlasActive3D.camera.pos[2] }));
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(durationMs);
  await page.keyboard.up('KeyW');
  const end = await frame.evaluate(() => ({ x: window.__atlasActive3D.camera.pos[0], z: window.__atlasActive3D.camera.pos[2] }));
  return Math.hypot(end.x - start.x, end.z - start.z);
}

// Presses Space once and samples getCharacterFloorY() repeatedly until it
// settles back to the ground, returning the highest value seen — the
// jump's actual peak height. Holds the key down for a short real span
// rather than a bare press() — see manual-avatar-shoe-buffs.js's own
// measureJumpPeak() for why a bare press() can miss the game loop's
// keydown edge-detection entirely.
async function measureJumpPeak(page, frame) {
  await page.keyboard.down('Space');
  await page.waitForTimeout(50);
  await page.keyboard.up('Space');
  let peak = 0;
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const y = await frame.evaluate(() => window.__atlasActive3D.getCharacterFloorY());
    if (y > peak) peak = y;
    if (y <= 0 && peak > 0) break; // back on the ground after having left it
    await page.waitForTimeout(30);
  }
  return peak;
}

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-avatar-hat-buffs');
  const context = await chromium.launchPersistentContext(userDataDir, { headless: false, executablePath: '/opt/pw-browsers/chromium', args: LAUNCH_ARGS });

  try {
    const { page, frame } = await createIdentityAndEnterLobby(context, 'avatar-hat-buffs-password');

    console.log('STEP 1: opening both hat crates, the sneakers crate, and an outfit crate mints all four credentials');
    await openCrate(frame, SUNHAT_CRATE);
    await openCrate(frame, CAP_CRATE);
    await openCrate(frame, SNEAKERS_CRATE);
    await openCrate(frame, OUTFIT_CRATE);
    console.log('PASS: all four credentials are in the wallet');

    console.log('STEP 2: before equipping a hat, all three hat buffs read back as "no bonus"');
    const beforeAny = await getHatDebugValues(frame);
    if (beforeAny.speed !== 1 || beforeAny.jump !== 1 || beforeAny.range !== 1) {
      throw new Error('Expected speed=1, jump=1, range=1 before equipping a hat, got: ' + JSON.stringify(beforeAny));
    }
    console.log('PASS: no bonuses applied with nothing equipped');

    console.log('STEP 3: equipping the sun hat applies its own randomly-rolled buffs, each within its declared range');
    await toggleFromWallet(frame, SUNHAT_CRATE.name, 'toggle-avatar-hat', 'Take off hat');
    const sunhatWalletProps = await frame.evaluate(() => AtlasWallet.getAvatarHat());
    const withSunhat = await getHatDebugValues(frame);
    if (withSunhat.speed !== sunhatWalletProps.speedMultiplier || withSunhat.jump !== sunhatWalletProps.jumpMultiplier || withSunhat.range !== sunhatWalletProps.interactRangeMultiplier) {
      throw new Error('Expected the live 3D scene to read exactly the sun hat\'s own wallet properties, got scene=' + JSON.stringify(withSunhat) + ' wallet=' + JSON.stringify(sunhatWalletProps));
    }
    if (!inRange(withSunhat.speed, HAT_SPEED_RANGE) || !inRange(withSunhat.jump, HAT_JUMP_RANGE) || !inRange(withSunhat.range, HAT_RANGE_RANGE)) {
      throw new Error('Expected the sun hat\'s rolled buffs within their declared ranges, got: ' + JSON.stringify(withSunhat));
    }
    console.log('PASS: sun hat applied speed=' + withSunhat.speed + ' jump=' + withSunhat.jump + ' range=' + withSunhat.range + ' (its own random roll)');

    console.log('STEP 4: swapping to the cap applies the cap\'s own, independently-rolled buffs');
    await toggleFromWallet(frame, CAP_CRATE.name, 'toggle-avatar-hat', 'Take off hat');
    const capWalletProps = await frame.evaluate(() => AtlasWallet.getAvatarHat());
    const withCap = await getHatDebugValues(frame);
    if (withCap.speed !== capWalletProps.speedMultiplier || withCap.jump !== capWalletProps.jumpMultiplier || withCap.range !== capWalletProps.interactRangeMultiplier) {
      throw new Error('Expected the live 3D scene to read exactly the cap\'s own wallet properties, got scene=' + JSON.stringify(withCap) + ' wallet=' + JSON.stringify(capWalletProps));
    }
    if (!inRange(withCap.speed, HAT_SPEED_RANGE) || !inRange(withCap.jump, HAT_JUMP_RANGE) || !inRange(withCap.range, HAT_RANGE_RANGE)) {
      throw new Error('Expected the cap\'s rolled buffs within their declared ranges, got: ' + JSON.stringify(withCap));
    }
    console.log('PASS: cap applied speed=' + withCap.speed + ' jump=' + withCap.jump + ' range=' + withCap.range + ' — swapped cleanly from the sun hat');

    console.log('STEP 5: taking the hat off resets all three back to "no bonus"');
    await toggleFromWallet(frame, CAP_CRATE.name, 'toggle-avatar-hat', 'Wear as my hat');
    const afterUnequip = await getHatDebugValues(frame);
    if (afterUnequip.speed !== 1 || afterUnequip.jump !== 1 || afterUnequip.range !== 1) {
      throw new Error('Expected speed=1, jump=1, range=1 after taking the hat off, got: ' + JSON.stringify(afterUnequip));
    }
    console.log('PASS: unequipping reset every hat buff back to no bonus');

    console.log('STEP 6: a hat, sneakers, and an outfit credential each mint bound to their owner');
    const hatScope = await getWalletCredentialTradeScope(frame, CAP_CRATE.class);
    const shoesScope = await getWalletCredentialTradeScope(frame, SNEAKERS_CRATE.class);
    const outfitScope = await getWalletCredentialTradeScope(frame, OUTFIT_CRATE.class);
    if (hatScope !== 'bound' || shoesScope !== 'bound' || outfitScope !== 'bound') {
      throw new Error('Expected tradeScope "bound" on the hat, shoes, and outfit credentials, got: ' + JSON.stringify({ hatScope, shoesScope, outfitScope }));
    }
    console.log('PASS: hat/shoes/outfit credentials are all tradeScope "bound"');

    console.log('STEP 7: the hat\'s speed buff actually speeds up real movement, and stacks with the sneakers\' own buff');
    // Teleported well outside the room entirely (same idea
    // manual-lobby-interactables.js's FAR_AWAY uses) so the walk is never
    // interrupted by colliding with a piece of furniture or a crate.
    await teleport(frame, 20, 20);
    const baselineWalk = await measureWalkDistance(page, frame, 500);
    await toggleFromWallet(frame, CAP_CRATE.name, 'toggle-avatar-hat', 'Take off hat');
    await teleport(frame, 20, 20);
    const hatOnlyWalk = await measureWalkDistance(page, frame, 500);
    if (hatOnlyWalk <= baselineWalk * 1.03) {
      throw new Error('Expected the cap\'s speed buff to cover measurably more ground — baseline ' + baselineWalk.toFixed(3) + ', with cap ' + hatOnlyWalk.toFixed(3));
    }
    await toggleFromWallet(frame, SNEAKERS_CRATE.name, 'toggle-avatar-shoes', 'Take off shoes');
    await teleport(frame, 20, 20);
    const hatAndShoesWalk = await measureWalkDistance(page, frame, 500);
    if (hatAndShoesWalk <= hatOnlyWalk * 1.03) {
      throw new Error('Expected wearing the sneakers ON TOP of the cap to cover even more ground (stacking) — hat alone ' + hatOnlyWalk.toFixed(3) + ', hat+shoes ' + hatAndShoesWalk.toFixed(3));
    }
    console.log('PASS: baseline ' + baselineWalk.toFixed(3) + ', hat alone ' + hatOnlyWalk.toFixed(3) + ', hat+shoes ' + hatAndShoesWalk.toFixed(3) + ' — the two buffs stack');

    console.log('STEP 8: the hat\'s jump buff actually raises the real jump arc');
    // Both slots are worn at this point (STEP 7 equipped the cap, then the
    // sneakers, to prove they stack) — take the shoes off AND the cap off
    // for a clean no-buff baseline before isolating the hat's own buff.
    await toggleFromWallet(frame, SNEAKERS_CRATE.name, 'toggle-avatar-shoes', 'Wear as my shoes'); // shoes off
    await toggleFromWallet(frame, CAP_CRATE.name, 'toggle-avatar-hat', 'Wear as my hat'); // cap off too
    const baselineJumpNoHat = await measureJumpPeak(page, frame);
    await toggleFromWallet(frame, CAP_CRATE.name, 'toggle-avatar-hat', 'Take off hat'); // re-equip the cap
    const hatJump = await measureJumpPeak(page, frame);
    if (hatJump <= baselineJumpNoHat * 1.03) {
      throw new Error('Expected the cap\'s jump buff to reach measurably higher — baseline peak ' + baselineJumpNoHat.toFixed(3) + ', with cap ' + hatJump.toFixed(3));
    }
    console.log('PASS: baseline jump peak ' + baselineJumpNoHat.toFixed(3) + ', with cap ' + hatJump.toFixed(3) + ' units higher');

    console.log('STEP 9: the hat\'s interact-range buff widens the real proximity trigger, with no movement needed');
    // The cap is equipped again after STEP 8 — take it off first for the
    // base (un-buffed) reading.
    await toggleFromWallet(frame, CAP_CRATE.name, 'toggle-avatar-hat', 'Wear as my hat'); // hat off — isolate the base range
    // PIN_CRATE.radius (1.7) < this distance < the WORST-case guaranteed
    // buffed radius (1.7 * 1.10 = 1.87) — unreachable at baseline, reachable
    // no matter which end of the hat's own random roll actually landed.
    await teleport(frame, PIN_CRATE.x + 1.8, PIN_CRATE.z);
    await frame.waitForTimeout(200);
    const promptBeforeHat = await frame.evaluate(() => window.__atlasActive3D.getInteractPrompt());
    if (promptBeforeHat !== null) throw new Error('Expected the pin crate to be OUT of base range at 1.8 units, got a prompt: ' + promptBeforeHat);
    await toggleFromWallet(frame, CAP_CRATE.name, 'toggle-avatar-hat', 'Wear as my hat');
    await frame.waitForFunction(() => window.__atlasActive3D.getInteractPrompt() === 'Open the crate', { timeout: 5000 });
    console.log('PASS: the same spot is out of range with nothing equipped and in range the instant the range-buffed cap goes on');

    console.log('\nALL AVATAR HAT BUFF + BOUND-ITEM CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
