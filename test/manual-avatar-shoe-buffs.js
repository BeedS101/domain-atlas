// Manual check for the shoe gameplay buffs and visual height scale layered
// on top of the plain equippable shoes (manual-avatar-shoes.js): a shoe
// asset can now carry atlas.avatar.shoeSpeedMultiplier,
// atlas.avatar.shoeJumpMultiplier, and atlas.avatar.shoeVisualScale
// alongside its existing atlas.avatar.shoeColor (see wallet.js's
// avatarShoePropertiesFromAsset() and the two catalog entries in
// issuer-server/server.js / issuer-php/lib/store.php). A 3D scene reads
// whichever shoe is currently equipped and applies these directly — no
// per-scene wiring needed.
//
// Covers:
//   1. Before equipping anything, all three read back as "no bonus" (speed
//      and jump multiplier 1, visual scale 1).
//   2. Equipping the sneakers (1.2/1.2/0.5) applies exactly those three
//      values to the LOCAL character live.
//   3. Swapping to the boots (1.1/1.1/0.5) while the sneakers were equipped
//      applies the boots' own values — the one shoe slot picks up whatever
//      is equipped now, not a blend of both.
//   4. Taking the shoes off resets all three back to "no bonus".
//   5. The speed multiplier actually speeds up real movement: holding W
//      for the same duration covers measurably more ground with the
//      sneakers equipped than with nothing equipped.
//   6. The jump multiplier actually raises the real jump arc: the peak
//      height reached after pressing Space is measurably higher with the
//      sneakers equipped than with nothing equipped.
//   7. A second visitor sees the first visitor's shoe visual scale (not
//      just color) on the remote character, over real presence broadcast —
//      proving two different shoe heights would render correctly for
//      everyone, not just locally.
//
// Requires presence-server/server.js running on its default port (8004)
// as well as the usual issuer-server on 8001. Not part of the permanent
// suite, same reasoning as the other manual-*.js scripts.

const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const BOOTS_CRATE = { x: 1.3, z: -3.9, class: 'atlas.avatar.shoes.boots', name: 'Trailblazer Boots', speedMultiplier: 1.1, jumpMultiplier: 1.1, visualScale: 0.5 };
const SNEAKERS_CRATE = { x: 4.0, z: 3.8, class: 'atlas.avatar.shoes.sneakers', name: 'Court Sneakers', speedMultiplier: 1.2, jumpMultiplier: 1.2, visualScale: 0.5 };
const LAUNCH_ARGS = [
  `--disable-extensions-except=${EXT_PATH}`,
  `--load-extension=${EXT_PATH}`,
  '--no-sandbox',
  '--use-gl=swiftshader',
  '--enable-webgl',
  '--ignore-gpu-blocklist'
];

function approxEquals(actual, expected, tolerance = 0.01) {
  return Math.abs(actual - expected) <= tolerance;
}

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

// Same wallet-storage-poll design as manual-avatar-shoes.js's own
// openCrate() — several crates in this scene share the exact same
// interactable label ("Open the crate"), so checking the wallet directly
// for the newly-minted class is unambiguous where a #status text diff
// wouldn't be.
async function openCrate(frame, crate) {
  await teleport(frame, crate.x, crate.z);
  await frame.waitForFunction(() => window.__atlasActive3D.getInteractPrompt() === 'Open the crate', { timeout: 5000 });
  await pressE(frame);
  await frame.waitForTimeout(1000);
  await frame.waitForFunction(async (cls) => {
    const identity = await AtlasWallet.getIdentity();
    const wallet = await AtlasWallet.getWallet(identity.publicKey);
    return wallet.some((e) => e.credential.asset.class === cls);
  }, crate.class, { timeout: 10000 });
  // Same settle reasoning as manual-avatar-shoes.js's own openCrate() — the
  // wallet storage write and the wallet-item list's own re-render are two
  // separate steps of the same async chain.
  await frame.waitForTimeout(300);
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

// Holds W for durationMs and returns the flat XZ distance covered — used
// to compare real movement speed with and without a shoe's speed buff.
async function measureWalkDistance(page, frame, durationMs) {
  const start = await frame.evaluate(() => ({ x: window.__atlasActive3D.camera.pos[0], z: window.__atlasActive3D.camera.pos[2] }));
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(durationMs);
  await page.keyboard.up('KeyW');
  const end = await frame.evaluate(() => ({ x: window.__atlasActive3D.camera.pos[0], z: window.__atlasActive3D.camera.pos[2] }));
  return Math.hypot(end.x - start.x, end.z - start.z);
}

// Presses Space once and samples getCharacterFloorY() (the same jumpOffset
// a real jump arc rises through, see gltf-mini.js's own comment on that
// getter) repeatedly until it settles back to the ground, returning the
// highest value seen — the jump's actual peak height. Holds the key down
// for a short real span rather than a bare press(): the game loop's own
// `keys['Space'] && !airborne` check (see gltf-mini.js) only samples keys
// on an actual animation frame, so a keydown+keyup fired back to back with
// no time in between can land entirely between two frames and never
// register at all — the same edge-detection gap manual-avatar-hat.js's
// own pressE() works around for the E key.
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
  const dirA = path.resolve(__dirname, '.chrome-profile-avatar-shoe-buffs-a');
  const dirB = path.resolve(__dirname, '.chrome-profile-avatar-shoe-buffs-b');
  const contextA = await chromium.launchPersistentContext(dirA, { headless: false, executablePath: '/opt/pw-browsers/chromium', args: LAUNCH_ARGS });
  let contextB = null;

  try {
    const { page: pageA, frame: frameA } = await createIdentityAndEnterLobby(contextA, 'avatar-shoe-buffs-password-a', 'A');

    console.log('STEP 1: opening the boots and sneakers crates mints both credentials');
    await openCrate(frameA, BOOTS_CRATE);
    await openCrate(frameA, SNEAKERS_CRATE);
    console.log('PASS: both shoe credentials are in the wallet');

    console.log('STEP 2: before equipping anything, all three buffs read back as "no bonus"');
    const beforeAny = await frameA.evaluate(() => ({
      speed: window.__atlasActive3D.getLocalAvatarShoeSpeedMultiplier(),
      jump: window.__atlasActive3D.getLocalAvatarShoeJumpMultiplier(),
      scale: window.__atlasActive3D.getLocalAvatarShoeVisualScale()
    }));
    if (!approxEquals(beforeAny.speed, 1) || !approxEquals(beforeAny.jump, 1) || !approxEquals(beforeAny.scale, 1)) {
      throw new Error('Expected speed=1, jump=1, scale=1 before equipping anything, got: ' + JSON.stringify(beforeAny));
    }
    console.log('PASS: no bonuses applied with nothing equipped');

    console.log('STEP 3: equipping the sneakers applies exactly their own 1.2/1.2/0.5 buffs');
    await toggleFromWallet(frameA, SNEAKERS_CRATE.name, 'toggle-avatar-shoes', 'Take off shoes');
    const withSneakers = await frameA.evaluate(() => ({
      speed: window.__atlasActive3D.getLocalAvatarShoeSpeedMultiplier(),
      jump: window.__atlasActive3D.getLocalAvatarShoeJumpMultiplier(),
      scale: window.__atlasActive3D.getLocalAvatarShoeVisualScale()
    }));
    if (!approxEquals(withSneakers.speed, SNEAKERS_CRATE.speedMultiplier) || !approxEquals(withSneakers.jump, SNEAKERS_CRATE.jumpMultiplier) || !approxEquals(withSneakers.scale, SNEAKERS_CRATE.visualScale)) {
      throw new Error('Expected the sneakers\' own 1.2/1.2/0.5, got: ' + JSON.stringify(withSneakers));
    }
    console.log('PASS: sneakers applied speed=' + withSneakers.speed + ' jump=' + withSneakers.jump + ' scale=' + withSneakers.scale);

    console.log('STEP 4: swapping to the boots applies the boots\' own 1.1/1.1/0.5 — the one slot reflects whatever is equipped now');
    await toggleFromWallet(frameA, BOOTS_CRATE.name, 'toggle-avatar-shoes', 'Take off shoes');
    const withBoots = await frameA.evaluate(() => ({
      speed: window.__atlasActive3D.getLocalAvatarShoeSpeedMultiplier(),
      jump: window.__atlasActive3D.getLocalAvatarShoeJumpMultiplier(),
      scale: window.__atlasActive3D.getLocalAvatarShoeVisualScale()
    }));
    if (!approxEquals(withBoots.speed, BOOTS_CRATE.speedMultiplier) || !approxEquals(withBoots.jump, BOOTS_CRATE.jumpMultiplier) || !approxEquals(withBoots.scale, BOOTS_CRATE.visualScale)) {
      throw new Error('Expected the boots\' own 1.1/1.1/0.5 after swapping from the sneakers, got: ' + JSON.stringify(withBoots));
    }
    console.log('PASS: boots applied speed=' + withBoots.speed + ' jump=' + withBoots.jump + ' scale=' + withBoots.scale + ' — swapped cleanly from the sneakers');

    console.log('STEP 5: taking the shoes off resets all three back to "no bonus"');
    await toggleFromWallet(frameA, BOOTS_CRATE.name, 'toggle-avatar-shoes', 'Wear as my shoes');
    const afterUnequip = await frameA.evaluate(() => ({
      speed: window.__atlasActive3D.getLocalAvatarShoeSpeedMultiplier(),
      jump: window.__atlasActive3D.getLocalAvatarShoeJumpMultiplier(),
      scale: window.__atlasActive3D.getLocalAvatarShoeVisualScale()
    }));
    if (!approxEquals(afterUnequip.speed, 1) || !approxEquals(afterUnequip.jump, 1) || !approxEquals(afterUnequip.scale, 1)) {
      throw new Error('Expected speed=1, jump=1, scale=1 after taking the shoes off, got: ' + JSON.stringify(afterUnequip));
    }
    console.log('PASS: unequipping reset every buff back to no bonus');

    console.log('STEP 6: the speed multiplier actually speeds up real movement');
    // Teleported well outside the room entirely (same FAR_AWAY idea
    // manual-lobby-interactables.js uses) so the walk is never interrupted
    // by colliding with a piece of furniture or a crate — this test only
    // cares about the speed multiplier's effect on distance covered, not
    // about staying inside the lobby.
    await teleport(frameA, 20, 20);
    const baselineWalk = await measureWalkDistance(pageA, frameA, 500);
    await toggleFromWallet(frameA, SNEAKERS_CRATE.name, 'toggle-avatar-shoes', 'Take off shoes');
    await teleport(frameA, 20, 20);
    const sneakersWalk = await measureWalkDistance(pageA, frameA, 500);
    if (sneakersWalk <= baselineWalk * 1.05) {
      throw new Error('Expected the sneakers\' speed buff to cover measurably more ground — baseline ' + baselineWalk.toFixed(3) + ', with sneakers ' + sneakersWalk.toFixed(3));
    }
    console.log('PASS: baseline walk ' + baselineWalk.toFixed(3) + ' units, with sneakers ' + sneakersWalk.toFixed(3) + ' units (' + ((sneakersWalk / baselineWalk - 1) * 100).toFixed(0) + '% more)');

    console.log('STEP 7: the jump multiplier actually raises the real jump arc');
    await toggleFromWallet(frameA, SNEAKERS_CRATE.name, 'toggle-avatar-shoes', 'Wear as my shoes'); // back to barefoot for the baseline jump
    const baselineJump = await measureJumpPeak(pageA, frameA);
    await toggleFromWallet(frameA, SNEAKERS_CRATE.name, 'toggle-avatar-shoes', 'Take off shoes');
    const sneakersJump = await measureJumpPeak(pageA, frameA);
    if (sneakersJump <= baselineJump * 1.05) {
      throw new Error('Expected the sneakers\' jump buff to reach measurably higher — baseline peak ' + baselineJump.toFixed(3) + ', with sneakers peak ' + sneakersJump.toFixed(3));
    }
    console.log('PASS: baseline jump peak ' + baselineJump.toFixed(3) + ' units, with sneakers ' + sneakersJump.toFixed(3) + ' units (' + ((sneakersJump / baselineJump - 1) * 100).toFixed(0) + '% higher)');

    console.log('STEP 8: a second visitor sees the first visitor\'s shoe visual scale, not just color, on the remote character');
    contextB = await chromium.launchPersistentContext(dirB, { headless: false, executablePath: '/opt/pw-browsers/chromium', args: LAUNCH_ARGS });
    const { frame: frameB } = await createIdentityAndEnterLobby(contextB, 'avatar-shoe-buffs-password-b', 'B');
    await frameB.waitForFunction(() => window.__atlasActive3D.getRemotePlayerCount() >= 1, { timeout: 8000 });
    const idOfA = await frameB.evaluate(() => window.__atlasActive3D.getRemotePlayerIds()[0]);
    await frameB.waitForFunction(({ id, scale }) => {
      const rp = window.__atlasActive3D.getRemotePlayerRenderState(id);
      return rp && rp.shoeColor && Math.abs((rp.shoeScale || 0) - scale) < 0.01;
    }, { id: idOfA, scale: SNEAKERS_CRATE.visualScale }, { timeout: 8000 });
    console.log('PASS: visitor B sees visitor A\'s shoe visual scale (' + SNEAKERS_CRATE.visualScale + ') over real presence broadcast');

    console.log('\nALL AVATAR SHOE BUFF CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await contextA.close();
    if (contextB) await contextB.close();
  }
})();
