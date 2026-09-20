// Manual check for World Drops (task #250, SPEC.md §5.5) — dropping a
// wallet item into a scene so ANYONE standing in that world can see it and
// pick it up, replacing the old local-only, self-only version of this
// feature this file used to test (nothing ever left the wallet; "Drop
// here" just recorded a position only the dropper could later reclaim —
// see git history for that version). Now a drop genuinely leaves the
// dropper's wallet (revoked) the moment it lands, and picking it up —
// whether it's a stranger's item or the dropper's own earlier drop — always
// mints a fresh replacement credential via the issuer, same as any other
// real transfer in this protocol.
//
// Requires domain A's issuer-server on 8001 (2D renderer, Example Plaza) —
// this test does not start it itself. Two independent browser profiles
// (two genuinely separate wallet identities, same "launch two persistent
// contexts" pattern manual-messaging-window.js already uses) since a drop
// being visible/claimable by SOMEONE ELSE is the entire point of this
// feature — one identity dropping and picking its own item back up would
// never exercise the shared part at all.
//
// Checks:
//   1. Escape right after opening "Click where you want to drop it"
//      cancels the placement — the item never leaves the wallet.
//   2. Visitor A drops a Chess Champion Trophy (non-fungible; minted
//      directly via AtlasWallet.mintAsset rather than through the Bronze
//      Compass stall/#requestItemBtn — the Compass itself became
//      tradeScope: 'bound' in the task #250 second follow-up, closing the
//      same oncePerUser drop-then-re-request loophole atlas.badge/
//      atlas.trinket.pin/atlas.trinket.charm already closed, so it can no
//      longer be dropped at all; the Trophy is still an ordinary
//      non-fungible, non-bound, uncapped collectible, so it exercises
//      exactly the same whole-item drop/pickup path the Compass used to);
//      it leaves A's normal list and A's own "Dropped in this world" row
//      labels it "you left this here". Visitor B — a completely different
//      identity, standing in the same world — sees a live scene marker for
//      it (world-drops poll loop, not a leave/re-enter), and picking it up
//      by clicking that marker mints B a fresh Trophy; the marker and A's
//      own "Dropped" row both disappear once claimed.
//   3. A fungible balance's card offers a quantity input next to its own
//      "Drop…" button (not a bare "Drop here"); an out-of-range quantity
//      is rejected with a clear status message rather than silently
//      dropping the whole stack or nothing. Dropping a PARTIAL amount
//      splits it off first (AtlasWallet.splitForDrop) — A's own remaining
//      balance shrinks by exactly that much, and the dropped marker/list
//      row shows exactly the split-off quantity, not the original stack.
//   4. Visitor B picks up that partial drop via the wallet panel's own
//      "Pick up" button (not the scene marker this time) and receives
//      exactly the dropped quantity, not A's original full balance.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
// This test asserts exact counts against Example Plaza's own shared
// world-drops list (the whole point of the feature is that it's shared —
// see the file header), so a stray leftover drop from an earlier, since-
// failed run of this same script (or of manual-world-drops-protocol.js,
// which also drops into this same live domain A) would make a fresh run's
// "exactly N drops right now" assertions flaky. Reset just that one store
// file before starting, the same "local dev state, safe to clear" posture
// clearing stale .chrome-profile-* directories already has elsewhere in
// this suite.
const WORLD_DROPS_STORE = path.resolve(__dirname, '..', 'issuer-server', 'atlas-world-drops-store.json');
// The live world-drops poll (extension/viewer.js's WORLD_DROPS_POLL_MS) is
// 4000ms — generous margin above that for a waitForFunction timeout so a
// slow CI-ish run doesn't flake on timing alone.
const POLL_MARGIN_MS = 9000;

async function openOverlay(context, label) {
  const page = await context.newPage();
  await page.goto('http://localhost:8001', { waitUntil: 'load' });
  await page.locator('#domain-atlas-enter-btn').click();
  const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
  const frame = await frameHandle.contentFrame();
  await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
  console.log('SETUP: ' + label + ' opened the overlay at Example Plaza');
  return { page, frame };
}

async function createIdentity(frame, password) {
  await frame.locator('#walletBtn').click();
  await frame.locator('#chooseNewBtn').click();
  await frame.locator('#newPasswordInput').fill(password);
  await frame.locator('#newPasswordConfirmInput').fill(password);
  await frame.locator('#confirmCreateBtn').click();
  await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
  await frame.locator('#seedConfirmCheck').check();
  await frame.locator('#seedConfirmBtn').click();
  await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
  const publicKey = await frame.evaluate(() => AtlasWallet.getIdentity().then((i) => i.publicKey));
  await frame.locator('#walletBtn').click(); // close the panel, back to the scene
  return publicKey;
}

// Opens a .wallet-item card's own collapsed "⋯" menu (task #211) and waits
// for it to actually show — same two-step a person would do by hand.
async function openCardMenu(card) {
  await card.locator('.card-menu-toggle').click();
  await card.locator('.card-menu-items.show').waitFor({ state: 'visible', timeout: 3000 });
}

async function clickCardMenuAction(actionLocator) {
  const card = actionLocator.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " wallet-item ")][1]');
  await openCardMenu(card);
  await actionLocator.click();
}

// Mirrors verify-wallet.js's projectPortals helper: waits for the scene's
// item markers to exist, then projects each one's 3D position to the same
// 2D canvas pixel coordinates viewer.js's own project() would draw it at.
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
            return { sx: p.x, sy: p.y - 14, dropId: m.dropId, name: m.name, isMine: m.isMine };
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
  try { fs.writeFileSync(WORLD_DROPS_STORE, JSON.stringify({ drops: [] }, null, 2)); } catch (err) { /* fine if the file doesn't exist yet — the server creates it lazily */ }

  const dirA = path.resolve(__dirname, '.chrome-profile-drop-pickup-a');
  const dirB = path.resolve(__dirname, '.chrome-profile-drop-pickup-b');
  const launchOpts = { headless: false, executablePath: '/opt/pw-browsers/chromium', args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox'] };
  const contextA = await chromium.launchPersistentContext(dirA, launchOpts);
  const contextB = await chromium.launchPersistentContext(dirB, launchOpts);

  try {
    const a = await openOverlay(contextA, 'Visitor A');
    const b = await openOverlay(contextB, 'Visitor B');

    console.log('SETUP: two independent identities, both standing in Example Plaza; A mints a Chess Champion Trophy directly (see file header — the Bronze Compass #requestItemBtn used to hand out is bound now, so it can never be dropped)');
    const pkA = await createIdentity(a.frame, 'drop-test-password-a');
    const pkB = await createIdentity(b.frame, 'drop-test-password-b');
    if (pkA === pkB) throw new Error('Expected two independently created identities to differ');
    await a.frame.locator('#walletBtn').click(); // createIdentity() closes the panel on its way out — reopen it, the wallet-item cards STEP 1 needs live inside it
    await a.frame.evaluate(() => AtlasWallet.mintAsset('self', 'localhost:8001', 'atlas.trophy.chess').then(() => refreshInventoryDisplay()));
    await a.frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item').length > 0, { timeout: 15000 });
    console.log('PASS: A holds one item (Chess Champion Trophy), B holds nothing yet');

    console.log('STEP 1: pressing Escape right after "Drop here" cancels the placement — the item never leaves A\'s wallet');
    await clickCardMenuAction(a.frame.locator('#selfCollectiblesList .wallet-item button[data-action="drop"]'));
    await a.frame.waitForFunction(() => document.getElementById('status').textContent.includes('Click where you want to drop it'), { timeout: 5000 });
    await a.frame.locator('body').press('Escape');
    await a.frame.waitForFunction(() => document.getElementById('status').textContent === 'Drop cancelled.', { timeout: 5000 });
    const stillThereAfterCancel = await a.frame.locator('#selfCollectiblesList .wallet-item').count();
    if (stillThereAfterCancel !== 1) throw new Error('Escape should have left the item exactly where it was, still carried');
    console.log('PASS: Escape backed out of placement, nothing dropped');

    console.log('STEP 2: A drops the trophy; it leaves A\'s carried list and shows under "Dropped in this world" as A\'s own; B sees a live marker (shared poll, no re-entry needed) and picks it up by clicking it');
    await clickCardMenuAction(a.frame.locator('#selfCollectiblesList .wallet-item button[data-action="drop"]'));
    await a.frame.waitForFunction(() => document.getElementById('status').textContent.includes('Click where you want to drop it'), { timeout: 5000 });
    await a.frame.locator('#scene').click({ position: { x: 90, y: 90 } });
    await a.frame.waitForFunction(() => document.getElementById('status').textContent.startsWith('Dropped.'), { timeout: 5000 });
    await a.frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item').length === 0, { timeout: 5000 });
    const aDroppedRowText = await a.frame.locator('#droppedItemsList .info-card').filter({ hasText: 'Chess Champion Trophy' }).textContent();
    if (!aDroppedRowText.includes('Chess Champion Trophy') || !aDroppedRowText.includes('you left this here')) {
      throw new Error('Expected A\'s own "Dropped" row to name the item and say A left it there: ' + aDroppedRowText);
    }
    console.log('PASS: A\'s trophy left the carried list and shows under "Dropped in this world" as A\'s own');

    // B never left/re-entered the world — this is the live poll
    // (WORLD_DROPS_POLL_MS) picking up A's drop, the entire point of this
    // feature over the old self-only version.
    await b.frame.waitForFunction(() => (window.__atlasScene.itemMarkers || []).length === 1, { timeout: POLL_MARGIN_MS });
    const [markerAtB] = await projectItemMarkers(b.frame);
    if (markerAtB.isMine) throw new Error('Expected B\'s marker to be flagged as NOT B\'s own drop');
    const bDroppedRowText = await b.frame.locator('#droppedItemsList .info-card').filter({ hasText: 'Chess Champion Trophy' }).textContent();
    if (!bDroppedRowText.includes('dropped by another visitor')) throw new Error('Expected B\'s own "Dropped" list to label this as someone else\'s drop: ' + bDroppedRowText);
    await b.frame.locator('#scene').click({ position: { x: markerAtB.sx, y: markerAtB.sy } });
    await b.frame.waitForFunction(() => document.getElementById('status').textContent === 'Picked it up.', { timeout: 5000 });
    await b.frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item').length === 1, { timeout: 5000 });
    const bTrophyOwner = await b.frame.evaluate(() => AtlasWallet.getIdentity().then(async (id) => (await AtlasWallet.getWallet(id.publicKey))[0].credential.owner.publicKey));
    if (bTrophyOwner !== pkB) throw new Error('Expected the picked-up trophy to be freshly minted to B\'s own public key');
    console.log('PASS: B picked up A\'s drop by clicking its scene marker and now owns a freshly-minted Chess Champion Trophy');

    // A's own view of the world catches up on its next poll tick too, with
    // no action from A at all.
    await a.frame.waitForFunction(() => document.getElementById('droppedItemsSection').hidden === true, { timeout: POLL_MARGIN_MS });
    console.log('PASS: A\'s own "Dropped in this world" section clears once B claims it, with no action from A');

    console.log('STEP 3: A mints 20 iron (fungible) and drops only PART of the stack — the quantity prompt + split-then-drop path');
    // mintAsset() alone only touches wallet storage — bypassing the actual
    // Mine Iron stall UI (not this test's subject) means nothing else
    // triggers a re-render, so refreshInventoryDisplay() is called
    // explicitly here, the same refresh every real minting path in
    // viewer.js already runs after its own mint call.
    await a.frame.evaluate(() => AtlasWallet.mintAsset('self', 'localhost:8001', 'atlas.element.iron', 20).then(() => refreshInventoryDisplay()));
    await a.frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item').length === 1, { timeout: 5000 });
    const ironCard = a.frame.locator('#selfCollectiblesList .wallet-item').filter({ hasText: 'Iron' });
    await openCardMenu(ironCard);
    const qtyInput = ironCard.locator('.drop-quantity-input');
    const dropBtn = ironCard.locator('button[data-action="drop"][data-fungible="1"]');
    const startingValue = await qtyInput.inputValue();
    // Defaults to 1 (not the full balance) as of the fix Bruno asked for
    // after using this in the wild — see renderAssetCard()'s own comment
    // in viewer.js for why "the least you could mean" beats "assume you
    // want to give it all away" as a default for a genuinely shared,
    // irreversible-by-mistake drop.
    if (startingValue !== '1') throw new Error('Expected the quantity input to default to 1, got ' + startingValue);
    const maxAttr = await qtyInput.getAttribute('max');
    if (maxAttr !== '20') throw new Error('Expected the quantity input\'s max to still be the full balance (20), got ' + maxAttr);

    console.log('STEP 3a: an out-of-range quantity (0) is rejected with a clear message, nothing dropped');
    await qtyInput.fill('0');
    await dropBtn.click();
    await a.frame.waitForFunction(() => document.getElementById('status').textContent.includes('Enter a quantity between 1 and 20'), { timeout: 5000 });
    console.log('PASS: an invalid quantity is rejected before any placement even starts ->', await a.frame.locator('#status').textContent());

    await openCardMenu(ironCard); // the invalid attempt above never opened a placement, but may have left the menu state as-is — reopen defensively
    await qtyInput.fill('5');
    await dropBtn.click();
    await a.frame.waitForFunction(() => document.getElementById('status').textContent.includes('Click where you want to drop it'), { timeout: 5000 });
    await a.frame.locator('#scene').click({ position: { x: 150, y: 60 } });
    await a.frame.waitForFunction(() => document.getElementById('status').textContent.startsWith('Dropped.'), { timeout: 5000 });
    const aRemainingIron = await a.frame.evaluate(() => AtlasWallet.getIdentity().then(async (id) => {
      const entry = (await AtlasWallet.getWallet(id.publicKey)).find((e) => e.credential.asset.class === 'atlas.element.iron');
      return entry ? entry.credential.quantity : 0;
    }));
    if (aRemainingIron !== 15) throw new Error('Expected splitForDrop to leave exactly 15 iron behind in A\'s wallet, got ' + aRemainingIron);
    console.log('PASS: dropping 5 of 20 split off exactly that much — A\'s own wallet now holds 15');

    console.log('STEP 4: B picks up the partial iron drop via the wallet panel\'s own "Pick up" button (not the scene marker this time), receiving exactly 5, not A\'s original 20');
    await b.frame.waitForFunction(() => document.querySelectorAll('#droppedItemsList .info-card').length === 1, { timeout: POLL_MARGIN_MS });
    await b.frame.locator('#walletBtn').click(); // B's panel closed itself after STEP 2's scene-marker pickup — reopen it to reach the list's own "Pick up" button
    await b.frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    const ironRow = b.frame.locator('#droppedItemsList .info-card').filter({ hasText: 'Iron' });
    const bIronRowText = await ironRow.textContent();
    if (!bIronRowText.includes('5') || !bIronRowText.toLowerCase().includes('iron')) throw new Error('Expected B\'s "Dropped" list to show exactly 5 iron: ' + bIronRowText);
    await ironRow.locator('button[data-action="pick-up"]').click();
    await b.frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item').length === 2, { timeout: 5000 });
    const bIronQuantity = await b.frame.evaluate(() => AtlasWallet.getIdentity().then(async (id) => {
      const entry = (await AtlasWallet.getWallet(id.publicKey)).find((e) => e.credential.asset.class === 'atlas.element.iron');
      return entry ? entry.credential.quantity : 0;
    }));
    if (bIronQuantity !== 5) throw new Error('Expected B to receive exactly the 5 that were dropped, got ' + bIronQuantity);
    console.log('PASS: B used the wallet panel\'s own "Pick up" button and received exactly the split-off amount (5), not A\'s original stack');

    console.log('STEP 5: a tradeScope:"bound" asset (Plaza Visitor Badge) never shows a Drop control at all, since the server would reject it anyway');
    await a.frame.evaluate(() => AtlasWallet.mintAsset('self', 'localhost:8001', 'atlas.badge', 1).then(() => refreshInventoryDisplay()));
    await a.frame.waitForFunction(() => document.querySelector('#selfCollectiblesList')?.textContent.includes('Plaza Visitor Badge'), { timeout: 5000 });
    const badgeCard = a.frame.locator('#selfCollectiblesList .wallet-item').filter({ hasText: 'Plaza Visitor Badge' });
    await openCardMenu(badgeCard);
    const badgeDropControls = await badgeCard.locator('[data-action="drop"], .drop-quantity-row').count();
    if (badgeDropControls !== 0) throw new Error('Expected no Drop control on a bound asset\'s card, found ' + badgeDropControls);
    console.log('PASS: the bound badge\'s card menu has no Drop button or quantity row');

    console.log('\nALL WORLD-DROPS UI CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await contextA.close().catch(() => {});
    await contextB.close().catch(() => {});
  }
})();
