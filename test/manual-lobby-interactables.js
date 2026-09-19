// Manual check for task #208: proximity-interact ("walk up, press E") support
// in the gltf-mini-v1 (3D) renderer, exercised via the two new loot crates
// in demo-domain-a's lobby world (spatial/lobby/scene.json's new
// `interactables` entries). Confirms the whole chain end to end: the
// on-screen "E — <label>" prompt appears only while in range and disappears
// once you walk away, an actual E press dispatches through the SAME
// handleInteractable() the 2D renderer's market stalls already use (real
// mint/issue call, not a mock), the resulting item lands in the wallet, a
// second press on an already-opened (oncePerUser) crate is correctly
// rejected client-side, and the OTHER crate (a different item class) still
// works independently. Not part of the permanent suite (test/verify*.js) —
// same reasoning as manual-lobby-check.js/manual-player-character.js: it
// depends on the heavier WebGL/xvfb machinery those already use.
//
// Positions below are hardcoded from spatial/lobby/scene.json's own
// interactables/objects entries on purpose — this test is specifically
// about THAT scene's content, not a generic scene reader, so there's
// nothing to gain by re-deriving them (unlike the 2D renderer, gltf-mini.js
// deliberately never populates window.__atlasScene.interactables — see
// viewer.js's own comment where it's hardcoded to [] for the 3D path — so
// there isn't even a live source to read them back from short of adding a
// test-only hook that would exist for no other reason).

const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const CRATE_1 = { x: 0.3, z: -0.8, class: 'atlas.trinket.pin', name: 'Lobby Enamel Pin' };
const CRATE_2 = { x: -2.0, z: 1.3, class: 'atlas.trinket.charm', name: 'Lucky Charm Keychain' };
const FAR_AWAY = { x: 20, z: 20 };

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

// Waits for the FINAL status text, not just any change — handleInteractable
// sets an intermediate "Collecting <label>…" synchronously before the mint
// request round-trips, so a bare "did it change" check races that and can
// resolve on the intermediate text instead of the real outcome.
async function waitForStatusPrefix(frame, prefix, prevStatus, timeout = 10000) {
  await frame.waitForFunction(({ prefix, prev }) => {
    const t = document.getElementById('status').textContent;
    return t !== prev && t.startsWith(prefix);
  }, { prefix, prev: prevStatus }, { timeout });
  return frame.locator('#status').textContent();
}

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-lobby-interactables');
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
    await frame.locator('#newPasswordInput').fill('lobby-interactables-password');
    await frame.locator('#newPasswordConfirmInput').fill('lobby-interactables-password');
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => !document.getElementById('walletPanel').classList.contains('open'), { timeout: 5000 });

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
    console.log('PASS: entered the 3D lobby with a fresh wallet');

    console.log('STEP 1: nothing prompts at spawn, before walking near either crate');
    const promptAtSpawn = await frame.evaluate(() => window.__atlasActive3D.getInteractPrompt());
    if (promptAtSpawn !== null) throw new Error('Expected no interact prompt at spawn, got: ' + JSON.stringify(promptAtSpawn));
    const hintHiddenAtSpawn = await frame.evaluate(() => !document.getElementById('scene3dInteractHint').classList.contains('active'));
    if (!hintHiddenAtSpawn) throw new Error('Expected #scene3dInteractHint to be hidden at spawn');
    console.log('PASS: no prompt/hint until something is actually in range');

    console.log('STEP 2: walking (teleporting, for a deterministic test) up to crate 1 shows the prompt');
    await teleport(frame, CRATE_1.x, CRATE_1.z);
    await frame.waitForFunction(() => window.__atlasActive3D.getInteractPrompt() === 'Open the crate', { timeout: 5000 });
    const hintText = await frame.locator('#scene3dInteractHint').textContent();
    if (hintText !== 'E — Open the crate') throw new Error('Expected the on-screen hint to read "E — Open the crate", got: ' + JSON.stringify(hintText));
    const hintActive = await frame.evaluate(() => document.getElementById('scene3dInteractHint').classList.contains('active'));
    if (!hintActive) throw new Error('Expected #scene3dInteractHint to have the active class while in range');
    console.log('PASS: prompt + on-screen hint both appear once in range of crate 1 ->', hintText);

    console.log('STEP 3: pressing E actually opens the crate — a real issue() mint, not a mock');
    const statusBeforeOpen1 = await frame.locator('#status').textContent();
    await pressE(frame);
    const statusAfterOpen1 = await waitForStatusPrefix(frame, 'Collected', statusBeforeOpen1);
    if (statusAfterOpen1 !== 'Collected Open the crate.') throw new Error('Expected "Collected Open the crate.", got: ' + statusAfterOpen1);
    const hasPin = await frame.evaluate(async (cls) => {
      const identity = await AtlasWallet.getIdentity();
      const wallet = await AtlasWallet.getWallet(identity.publicKey);
      return wallet.some((e) => e.credential.asset.class === cls);
    }, CRATE_1.class);
    if (!hasPin) throw new Error('Expected a real ' + CRATE_1.class + ' credential in the wallet after opening crate 1');
    console.log('PASS: crate 1 minted a genuine ' + CRATE_1.name + ' credential into the wallet');

    console.log('STEP 4: the crate is now fully out of reach — task #227 filters already-owned oncePerUser markers out of gltf-mini.js\'s own proximity check entirely (both the E-target and the Previewer\'s nearby list — see isMarkerAlreadyOwned in viewer.js/enterWorld() and getNearbyInteractMarkers() in gltf-mini.js), a deliberate change from the old "press E again, get an \'Already collected\' rejection message" behavior: it\'s what makes "press E multiple times to collect a multi-item list one at a time" (see manual-previewer-3d.js) work at all — an owned item has to drop out of E-targeting so the NEXT nearest one becomes the target, with no extra bookkeeping. The practical result: no on-screen "E — Open the crate" hint at all for an already-opened crate, and pressing E while standing right on top of it is a complete no-op (still standing at crate 1\'s own position from step 2/3 above, no need to move).');
    await frame.waitForFunction(() => window.__atlasActive3D.getInteractPrompt() === null, { timeout: 5000 });
    await frame.waitForFunction(() => !document.getElementById('scene3dInteractHint').classList.contains('active'), { timeout: 5000 });
    const statusBeforeReopen = await frame.locator('#status').textContent();
    await pressE(frame);
    await page.waitForTimeout(500); // give a wrongly-still-reachable crate time to produce a (now unwanted) status change
    const statusAfterReopenAttempt = await frame.locator('#status').textContent();
    if (statusAfterReopenAttempt !== statusBeforeReopen) {
      throw new Error('Expected pressing E on an already-owned crate to be a complete no-op (no prompt, nothing left to target), got a status change: ' + statusAfterReopenAttempt);
    }
    console.log('PASS: crate 1 has no prompt and is untargetable now that it\'s owned — pressing E did nothing, as intended');

    console.log('STEP 5: walking away from crate 1 hides the prompt again');
    await teleport(frame, FAR_AWAY.x, FAR_AWAY.z);
    await frame.waitForFunction(() => window.__atlasActive3D.getInteractPrompt() === null, { timeout: 5000 });
    await frame.waitForFunction(() => !document.getElementById('scene3dInteractHint').classList.contains('active'), { timeout: 5000 });
    console.log('PASS: prompt/hint both clear once out of range');

    console.log('STEP 6: crate 2 is a fully independent interactable — different class, own oncePerUser state');
    await teleport(frame, CRATE_2.x, CRATE_2.z);
    await frame.waitForFunction(() => window.__atlasActive3D.getInteractPrompt() === 'Open the crate', { timeout: 5000 });
    // Both crates share the exact same label ("Open the crate"), so their
    // "Collected ..." status text is byte-identical — and since task #227's
    // step 4 above no longer produces its own distinct "Already collected"
    // status change, the status here is STILL crate 1's own leftover
    // "Collected Open the crate." text from step 3, making a text-changed
    // check spuriously time out. Wait on the wallet's own class list
    // instead (same reasoning manual-previewer-3d.js's own scenarios use).
    await pressE(frame);
    await frame.waitForFunction((cls) => {
      return new Promise((resolve) => {
        AtlasWallet.getIdentity().then((identity) => AtlasWallet.getWallet(identity.publicKey)).then((w) => {
          resolve(w.some((e) => e.credential.asset.class === cls));
        });
      });
    }, CRATE_2.class, { timeout: 10000 });
    await frame.waitForFunction(() => document.getElementById('status').textContent === 'Collected Open the crate.', { timeout: 5000 });
    const wallet = await frame.evaluate(async () => {
      const identity = await AtlasWallet.getIdentity();
      return AtlasWallet.getWallet(identity.publicKey);
    });
    const hasCharm = wallet.some((e) => e.credential.asset.class === CRATE_2.class);
    const hasBothTrinkets = wallet.some((e) => e.credential.asset.class === CRATE_1.class) && hasCharm;
    if (!hasCharm) throw new Error('Expected a real ' + CRATE_2.class + ' credential in the wallet after opening crate 2');
    if (!hasBothTrinkets) throw new Error('Expected BOTH crate classes in the wallet at this point, got classes: ' + wallet.map((e) => e.credential.asset.class).join(', '));
    console.log('PASS: crate 2 minted a genuine ' + CRATE_2.name + ' credential, independent of crate 1\'s own state');

    console.log('\nALL LOBBY INTERACTABLE CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
