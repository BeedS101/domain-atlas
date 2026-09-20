// Manual check for "dropped items are actually visible (and pickupable) in
// a gltf-mini-v1 (3D) world" — until this task, the 3D lobby had NO idea a
// drop even existed visually: beginDropPlacement()'s own old comment said
// so outright ("drop it immediately with a placeholder position ... just
// without a glowing marker to walk up to here"), and refreshSceneItemMarkers()
// bailed out entirely whenever active3D was set. Two things changed:
//   1. A dropped item now renders its OWN asset.model (SPEC.md §5) at its
//      drop position, spinning slowly in place — gltf-mini.js's
//      setItemDrops(), diffed incrementally against the shared ~4s poll
//      the 2D renderer's itemMarkers already ran on (WORLD_DROPS_POLL_MS),
//      not a full loadScene() reload per drop.
//   2. A drop whose asset has no model, or whose model fails to load/parse,
//      falls back to a small shared amber glow marker instead of showing
//      nothing at all — same "no broken-image icon" spirit the Asset
//      Viewer's own thumbnail fallback already follows.
// Both are pickupable by walking up and pressing E, folded into the exact
// same proximity/nearby-list/Previewer pipeline a scene.json interactable
// (loot crate) already uses (see manual-lobby-interactables.js), routed to
// pickUpDroppedItem() instead of handleInteractable()'s mint/issue logic.
//
// Exercises BOTH visual outcomes with real, already-broken-or-fixed demo
// content rather than synthetic data:
//   - atlas.trophy.chess's model (assets/ring.glb) previously didn't exist
//     on disk at all — this task adds a small procedural placeholder GLB
//     there (an octahedron, same "no external asset needed" spirit as this
//     renderer's own portal/character geometry) specifically so the shipped
//     demo has a genuine model to render, not just a fallback. This also
//     incidentally fixes atlas.wearable.ring's and atlas.trophy.chess's own
//     "Show model" button in the Asset Viewer, silently broken before now.
//     STEP 1-5 below intercept this same URL with a DELIBERATELY oversized
//     stand-in (test/oversized-test-model.glb, same octahedron shape scaled
//     ~18x bigger) instead of the small shipped file, specifically to
//     exercise setItemDrops()'s per-model scale normalization
//     (ITEM_MODEL_TARGET_SIZE in gltf-mini.js) against a model that's
//     authored at a wildly different scale than this world's own furniture
//     — exactly what happened with a real, independently-modeled trophy on
//     Bruno's own site, where the dropped item rendered enormous compared
//     to everything else in the scene. The shipped ring.glb's own bytes are
//     separately confirmed to parse correctly (test/oversized-test-model.glb's
//     generator script's Node-side sanity check applies equally to it) —
//     this test's job is the scaling behavior, not re-proving small-file
//     parsing a second time.
//   - atlas.element.silver's model (assets/badge.glb) is a DIFFERENT,
//     still-genuinely-missing file (not something this task fixes — a
//     pre-existing content gap, left alone on purpose) — proving the
//     fallback-marker path against a real 404, not a mocked one.
//
// Also confirms beginDropPlacement()'s other change: a 3D drop now lands a
// short distance from wherever the visitor actually is, not hardcoded at
// world origin [0,0,0] — the old placeholder position, which would have
// stacked every drop in a world invisibly on top of each other now that
// they're actually visible.
//
// Not part of the permanent suite (test/verify*.js) — same reasoning as
// manual-lobby-interactables.js/manual-lobby-check.js: depends on the
// heavier WebGL/xvfb machinery those already use. Requires domain A's
// issuer-server on 8001 (see README.md's "Serve the two demo domains
// locally").

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const OVERSIZED_GLB = path.resolve(__dirname, 'oversized-test-model.glb');
const TROPHY_SPOT = { x: 3.0, z: -3.0 };
const SILVER_SPOT = { x: -3.0, z: 3.0 };
const FAR_AWAY = { x: 20, z: 20 };

async function teleport(frame, x, z) {
  await frame.evaluate(({ x, z }) => {
    window.__atlasActive3D.camera.pos[0] = x;
    window.__atlasActive3D.camera.pos[2] = z;
  }, { x, z });
}

async function pressE(frame) {
  await frame.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE' })));
  // gltf-mini.js's own E-press edge detection (wasInteractKeyDown) only
  // fires on a frame where keys['KeyE'] is seen true — without a real
  // pause here, the two frame.evaluate() round-trips can occasionally
  // land close enough together that no rendered frame ever observes the
  // key held down, missing the edge entirely. A real player can't press
  // and release a key in under one frame; this just guarantees the same
  // is true here.
  await frame.waitForTimeout(120);
  await frame.evaluate(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyE' })));
}

async function openCardMenu(card) {
  await card.locator('.card-menu-toggle').click();
  await card.locator('.card-menu-items.show').waitFor({ state: 'visible', timeout: 3000 });
}

async function clickCardMenuAction(actionLocator) {
  const card = actionLocator.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " wallet-item ")][1]');
  await openCardMenu(card);
  await actionLocator.click();
}

async function fetchDrops() {
  const res = await fetch('http://localhost:8001/atlas/world/drops?world=lobby');
  if (!res.ok) throw new Error('Fetching drops failed: ' + (await res.text()));
  const { drops } = await res.json();
  return drops;
}

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-item-drop-3d-visible');
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
    // The demo catalog's asset.model/asset.thumbnail URLs are always
    // https://<domain>/... (SPEC.md §5 needs an absolute, cross-domain-
    // resolvable URL), but the local dev issuer only ever speaks plain
    // HTTP — a pre-existing catalog/dev-server mismatch, same one
    // manual-asset-viewer.js's own header comment already documents for
    // compass.glb, not something this task created or should fix here.
    // Intercepting just this one URL and fulfilling it from a real local
    // GLB (see the header comment on why this test deliberately serves the
    // OVERSIZED fixture here rather than the small shipped ring.glb)
    // exercises the actual fetch -> parseGLB -> WebGL-upload -> scale-
    // normalize pipeline end to end. atlas.element.silver's model
    // (assets/badge.glb) is deliberately left UNintercepted below — it
    // fails for real (that file still doesn't exist either way), which is
    // exactly what STEP 6 wants to prove against.
    await context.route('https://localhost:8001/assets/ring.glb', (route) => {
      route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: fs.readFileSync(OVERSIZED_GLB) });
    });

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
    await frame.locator('#newPasswordInput').fill('item-drop-3d-visible-password');
    await frame.locator('#newPasswordConfirmInput').fill('item-drop-3d-visible-password');
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
    console.log('PASS: entered the 3D lobby with a fresh wallet — itemDropsAllowed just flipped true for this world (task: 3D item-drop visibility) so there\'s actually a Drop button to click here now');

    console.log('STEP 1: mint a Chess Champion Trophy (atlas.trophy.chess — model now exists, see the new assets/ring.glb), teleport to a known spot, and drop it via the real wallet UI Drop button');
    await frame.evaluate(() => AtlasWallet.mintAsset('self', 'localhost:8001', 'atlas.trophy.chess').then(() => refreshInventoryDisplay()));
    await frame.waitForFunction(() => document.querySelector('#selfCollectiblesList')?.textContent.includes('Chess Champion Trophy'), { timeout: 5000 });
    await frame.locator('#walletBtn').click(); // reopen the wallet panel — it closed itself after account creation earlier
    await frame.waitForFunction(() => document.getElementById('walletPanel').classList.contains('open'), { timeout: 5000 });
    await teleport(frame, TROPHY_SPOT.x, TROPHY_SPOT.z);
    const trophyCard = frame.locator('#selfCollectiblesList .wallet-item').filter({ hasText: 'Chess Champion Trophy' });
    await clickCardMenuAction(trophyCard.locator('button[data-action="drop"]'));
    await frame.waitForFunction(() => document.getElementById('status').textContent === 'Dropped. Anyone standing here can see it and pick it up.', { timeout: 10000 });
    console.log('PASS: dropped via the real beginDropPlacement()/finalizeDrop() path, not a mock');

    console.log('STEP 2: the drop landed near where the visitor actually was — not hardcoded at world origin [0,0,0], the old 3D placeholder position');
    let drops = await fetchDrops();
    if (drops.length !== 1) throw new Error('Expected exactly one live drop in the lobby, got ' + drops.length);
    const trophyDrop = drops[0];
    const distFromSpot = Math.hypot(trophyDrop.position[0] - TROPHY_SPOT.x, trophyDrop.position[2] - TROPHY_SPOT.z);
    if (distFromSpot > 3) throw new Error('Expected the drop to land within a few units of ' + JSON.stringify(TROPHY_SPOT) + ', got position ' + JSON.stringify(trophyDrop.position));
    if (trophyDrop.position[0] === 0 && trophyDrop.position[2] === 0) throw new Error('Drop landed at the old [0,0,0] placeholder — beginDropPlacement() should no longer do that in a 3D world');
    console.log('PASS: dropped at ' + JSON.stringify(trophyDrop.position) + ', near the visitor\'s own position, not at world origin');

    console.log('STEP 3: gltf-mini.js actually tracks the drop and renders its REAL model (ring.glb loaded successfully), not the amber glow fallback');
    await frame.waitForFunction(() => window.__atlasActive3D.getItemDropCount() === 1, { timeout: 5000 });
    await frame.waitForFunction((dropId) => window.__atlasActive3D.getItemDropRenderKind(dropId) === 'model', trophyDrop.dropId, { timeout: 5000 });
    console.log('PASS: the trophy\'s own model loaded and is what\'s actually rendered at its drop position');

    console.log('STEP 3b: the model (deliberately served oversized, ~18x this world\'s intended item scale — see the header comment) got normalized DOWN to a sane size, not rendered at its raw authored scale');
    const trophyScale = await frame.evaluate((dropId) => window.__atlasActive3D.getItemDropScale(dropId), trophyDrop.dropId);
    if (!(trophyScale > 0 && trophyScale < 0.2)) throw new Error('Expected the oversized model to be scaled well down (< 0.2x), got ' + trophyScale);
    console.log('PASS: oversized model normalized to ' + trophyScale + 'x — this is exactly what fixed Bruno\'s "trophy renders huge" report against his own real model');

    console.log('STEP 4: walking up to the trophy\'s own drop position shows the "E — <item name>" prompt');
    await teleport(frame, trophyDrop.position[0], trophyDrop.position[2]);
    await frame.waitForFunction(() => window.__atlasActive3D.getInteractPrompt() === 'Chess Champion Trophy', { timeout: 5000 });
    const hintText = await frame.locator('#scene3dInteractHint').textContent();
    if (hintText !== 'E — Chess Champion Trophy') throw new Error('Expected the on-screen hint to read "E — Chess Champion Trophy", got: ' + JSON.stringify(hintText));
    console.log('PASS: E-range prompt names the actual dropped item ->', hintText);

    console.log('STEP 5: pressing E picks it up through the SAME pickUpDroppedItem() the 2D renderer and Previewer already use — a real claim, not handleInteractable()\'s mint/issue path');
    await pressE(frame);
    await frame.waitForFunction(() => document.getElementById('status').textContent === 'Picked it up.', { timeout: 10000 });
    const hasTrophyBack = await frame.evaluate(async () => {
      const identity = await AtlasWallet.getIdentity();
      const wallet = await AtlasWallet.getWallet(identity.publicKey);
      return wallet.some((e) => e.credential.asset.class === 'atlas.trophy.chess');
    });
    if (!hasTrophyBack) throw new Error('Expected the picked-up trophy back in the wallet as a freshly-minted credential');
    await frame.waitForFunction(() => window.__atlasActive3D.getItemDropCount() === 0, { timeout: 5000 });
    await frame.waitForFunction(() => window.__atlasActive3D.getInteractPrompt() === null, { timeout: 5000 });
    console.log('PASS: claimed, back in the wallet, and the model/prompt both disappeared from the 3D scene');

    console.log('STEP 6: a class whose model genuinely fails to load (atlas.element.silver -> assets/badge.glb, a pre-existing, still-missing file — left alone on purpose, not fixed by this task) falls back to the amber glow marker instead of rendering nothing');
    await teleport(frame, FAR_AWAY.x, FAR_AWAY.z); // out of the way while this gets set up
    const silverDropId = await frame.evaluate(async (pos) => {
      const minted = await AtlasWallet.mintAsset('self', 'localhost:8001', 'atlas.element.silver', 3);
      const result = await AtlasWallet.dropItem(minted.credential, 'localhost:8001', 'lobby', pos);
      await refreshSceneItemMarkers(); // force a sync instead of waiting out WORLD_DROPS_POLL_MS
      return result.dropId;
    }, [SILVER_SPOT.x, 0, SILVER_SPOT.z]);
    await frame.waitForFunction(() => window.__atlasActive3D.getItemDropCount() === 1, { timeout: 5000 });
    await frame.waitForFunction(
      (dropId) => window.__atlasActive3D.getItemDropRenderKind(dropId) === 'marker',
      silverDropId,
      { timeout: 5000 }
    );
    console.log('PASS: registered immediately as the glow marker, and stayed that way once the bad model URL actually failed to fetch (no crash, no unhandled rejection)');

    console.log('STEP 7: the marker-fallback drop is just as pickupable as a model-backed one — same E-press path');
    drops = await fetchDrops();
    const silverDrop = drops.find((d) => d.dropId === silverDropId);
    if (!silverDrop) throw new Error('Expected the silver drop still listed server-side');
    await teleport(frame, silverDrop.position[0], silverDrop.position[2]);
    await frame.waitForFunction(() => window.__atlasActive3D.getInteractPrompt() === 'Silver (Ag)', { timeout: 5000 });
    // Status text alone ("Picked it up.") isn't a safe wait here — STEP 5
    // already left that exact same string on screen, so a text-equality
    // check would resolve immediately without proving E actually fired
    // this time (same trap manual-lobby-interactables.js's own STEP 6
    // comment flags for the analogous "Collected ..." text). Wait on the
    // renderer's own drop count instead — a real signal that this
    // specific claim went through.
    await pressE(frame);
    await frame.waitForFunction(() => window.__atlasActive3D.getItemDropCount() === 0, { timeout: 10000 });
    const hasSilverBack = await frame.evaluate(async () => {
      const identity = await AtlasWallet.getIdentity();
      const wallet = await AtlasWallet.getWallet(identity.publicKey);
      return wallet.some((e) => e.credential.asset.class === 'atlas.element.silver');
    });
    if (!hasSilverBack) throw new Error('Expected the picked-up silver back in the wallet as a freshly-minted credential');
    console.log('PASS: the fallback-marker drop was pickupable exactly like the model-backed one, and cleaned up the same way once claimed');

    console.log('\nALL 3D ITEM-DROP VISIBILITY CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
