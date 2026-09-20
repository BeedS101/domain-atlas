// Manual check for task #227 in the 2D (isometric canvas) renderer: the new
// standalone "Previewer" window now owns ALL scene-hover previewing —
// dropped items AND uncollected stalls — that task #213 used to route
// through the Asset Viewer. Per Bruno's explicit instructions this session:
//   - the Asset Viewer must go back to being wallet-card-hover ONLY (see
//     manual-asset-viewer.js, which must keep passing unchanged);
//   - the Previewer has no "Show model" button, ever;
//   - a oncePerUser class this visitor already holds must be ignored by the
//     Previewer entirely — not shown as "already owned", just skipped, same
//     as if it weren't hoverable at all;
//   - a previewed item can be collected by clicking it IN THE PREVIEWER
//     (not just by clicking the stall itself on the canvas, which already
//     worked before this task and is untouched).
//
// Reuses the plaza's own Bronze Compass stall (atlas.wearable, oncePerUser)
// and "Play Chess" stall (no `class` at all) as fixtures — same fixtures
// manual-asset-viewer-scene-hover.js (task #213, now replaced by this file)
// used.
//
// Covers:
//   1. Nothing previews at spawn.
//   2. Hovering the Bronze Compass stall (not yet collected) opens the
//      Previewer with the "Not collected yet" note and a collect hint.
//   3. Moving away closes it (past the sticky-bridge grace window).
//   4. Hovering "Play Chess" (no asset class) never opens anything.
//   5. Clicking the previewed item INSIDE THE PREVIEWER (not the stall on
//      canvas) actually collects it — a real issue() mint, not a mock.
//   6. Hovering the SAME stall again, now that this visitor already holds
//      the (oncePerUser) class, opens nothing at all — the Previewer
//      ignores it, per Bruno's own words.
//   7. Dropping the collected item and hovering its own dropped-item marker
//      shows the real owned credential (kind: 'dropped') with no preview
//      note — dropped items are the visitor's own physical item sitting in
//      the world, never filtered by the oncePerUser check.
//   8. Clicking that dropped-item preview in the Previewer picks it back up.
//   9. The Asset Viewer (#assetViewerWidget) never opened once during any
//      of this — proof "don't touch the Asset Viewer" was honored.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');

// Task #211's card-menu popover, same helper manual-drop-pickup.js and
// several other test files already use — "Drop here" lives behind a
// wallet-item card's own "⋯" menu now, not a directly-clickable button.
async function clickCardMenuAction(actionLocator) {
  const card = actionLocator.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " wallet-item ")][1]');
  await card.locator('.card-menu-toggle').click();
  await card.locator('.card-menu-items.show').waitFor({ state: 'visible', timeout: 3000 });
  await actionLocator.click();
}

// Same "project the real in-page positions the same way viewer.js's own
// render() would draw them, using the real page-global project()" approach
// as manual-asset-viewer-scene-hover.js's own projectMarkers.
async function projectMarkers(frame) {
  return frame.evaluate(() => {
    return new Promise((resolve) => {
      const check = () => {
        const scene = window.__atlasScene;
        if (scene && scene.interactables && scene.interactables.length) {
          const canvas = document.getElementById('scene');
          const originX = canvas.width / 2;
          const originY = canvas.height / 2 + 40;
          const interactables = scene.interactables.map((m) => {
            const [x, y, z] = m.position;
            const p = project(x, y || 0, z, originX, originY);
            return { sx: p.x, sy: p.y - 16, label: m.label, class: m.class, action: m.action };
          });
          const itemMarkers = (scene.itemMarkers || []).map((m) => {
            const [x, , z] = m.position;
            const p = project(x, 0, z, originX, originY);
            return { sx: p.x, sy: p.y - 14, credentialId: m.credentialId, name: m.name };
          });
          resolve({ interactables, itemMarkers });
        } else {
          requestAnimationFrame(check);
        }
      };
      check();
    });
  });
}

function readPreviewer(frame) {
  return frame.evaluate(() => {
    const widget = document.getElementById('previewerWidget');
    const nameEl = document.querySelector('#previewerBody .name');
    const metaEl = document.querySelector('#previewerBody .meta');
    return {
      hidden: widget.hidden,
      name: nameEl ? nameEl.textContent : null,
      meta: metaEl ? metaEl.textContent : null,
      hasNote: !!document.querySelector('#previewerBody .previewer-note'),
      hasCollectHint: !!document.querySelector('#previewerBody .previewer-collect-hint'),
      hasShowModelButton: !!document.querySelector('#previewerBody button, #previewerPanel button')
    };
  });
}

async function waitForStatusPrefix(frame, prefix, prevStatus, timeout = 10000) {
  await frame.waitForFunction(({ prefix, prev }) => {
    const t = document.getElementById('status').textContent;
    return t !== prev && t.startsWith(prefix);
  }, { prefix, prev: prevStatus }, { timeout });
  return frame.locator('#status').textContent();
}

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-previewer-2d');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  });

  try {
    const page = await context.newPage();
    page.on('pageerror', (err) => console.log('PAGEERROR:', String(err)));

    console.log('SETUP: fresh identity, no items collected yet, Example Plaza (2D renderer)');
    await page.goto('http://localhost:8001', { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    frame.on('pageerror', (err) => console.log('FRAMEERROR:', String(err)));
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    await frame.locator('#walletBtn').click();
    await frame.locator('#chooseNewBtn').click();
    await frame.locator('#newPasswordInput').fill('previewer-2d-test-pw');
    await frame.locator('#newPasswordConfirmInput').fill('previewer-2d-test-pw');
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    console.log('PASS: identity ready, wallet still empty');

    const { interactables } = await projectMarkers(frame);
    const compass = interactables.find((m) => m.class === 'atlas.wearable');
    const chess = interactables.find((m) => m.action === 'open-chess');
    if (!compass) throw new Error('Expected to find the Bronze Compass stall (atlas.wearable) among the plaza\'s interactables');
    if (!chess) throw new Error('Expected to find the "Play Chess" stall among the plaza\'s interactables');

    console.log('STEP 1: nothing previews at spawn');
    const atSpawn = await readPreviewer(frame);
    if (!atSpawn.hidden) throw new Error('Expected the Previewer to be closed at spawn, got: ' + JSON.stringify(atSpawn));
    console.log('PASS: Previewer closed at spawn');

    console.log('STEP 2: hovering the Bronze Compass stall BEFORE collecting one opens the Previewer');
    await frame.locator('#scene').hover({ position: { x: compass.sx, y: compass.sy } });
    await frame.waitForFunction(() => document.getElementById('previewerWidget').hidden === false, { timeout: 3000 });
    const preview = await readPreviewer(frame);
    if (!preview.name.includes('Bronze Compass')) throw new Error('Expected "Bronze Compass" in the preview, got: ' + preview.name);
    if (!preview.meta.includes('atlas.wearable') || !preview.meta.includes('localhost:8001')) throw new Error('Expected class + issuer domain in the preview meta, got: ' + preview.meta);
    if (!preview.hasNote) throw new Error('Expected a "Not collected yet" preview note — this visitor has never collected this class');
    if (!preview.hasCollectHint) throw new Error('Expected a "Click, or press E, to collect" hint');
    if (preview.hasShowModelButton) throw new Error('The Previewer must never have a "Show model" button (Bruno explicitly asked for it to be removed)');
    console.log('PASS: Previewer opened for an uncollected stall, name/class/issuer correct, note + collect hint shown, no "Show model" button');

    console.log('STEP 3: moving away from the stall (past the grace window) closes the Previewer');
    await frame.page().mouse.move(5, 5);
    await frame.page().waitForTimeout(500); // past PREVIEWER_CLOSE_GRACE_MS (200ms)
    const afterLeave = await readPreviewer(frame);
    if (!afterLeave.hidden) throw new Error('Expected the Previewer to close after moving away from the stall');
    console.log('PASS: Previewer closed after leaving the stall');

    console.log('STEP 4: hovering "Play Chess" (no asset class at all) never opens the Previewer');
    await frame.locator('#scene').hover({ position: { x: chess.sx, y: chess.sy } });
    await frame.page().waitForTimeout(400);
    const afterChessHover = await readPreviewer(frame);
    if (!afterChessHover.hidden) throw new Error('Expected no Previewer for a class-less interactable (chess), got: ' + JSON.stringify(afterChessHover));
    console.log('PASS: chess stall never triggers the Previewer — nothing there to preview');

    console.log('STEP 5: clicking the previewed item INSIDE THE PREVIEWER (not the stall itself) collects it — a real issue() mint');
    await frame.page().mouse.move(5, 5);
    await frame.locator('#scene').hover({ position: { x: compass.sx, y: compass.sy } });
    await frame.waitForFunction(() => document.getElementById('previewerWidget').hidden === false, { timeout: 3000 });
    const statusBeforeCollect = await frame.locator('#status').textContent();
    await frame.locator('#previewerBody').click();
    const statusAfterCollect = await waitForStatusPrefix(frame, 'Collected', statusBeforeCollect);
    if (statusAfterCollect !== 'Collected Bronze Compass.') throw new Error('Expected "Collected Bronze Compass.", got: ' + statusAfterCollect);
    const hasCompass = await frame.evaluate(async () => {
      const identity = await AtlasWallet.getIdentity();
      const wallet = await AtlasWallet.getWallet(identity.publicKey);
      return wallet.some((e) => e.credential.asset.class === 'atlas.wearable');
    });
    if (!hasCompass) throw new Error('Expected a real atlas.wearable credential in the wallet after clicking it in the Previewer');
    console.log('PASS: clicking the item inside the Previewer collected a genuine Bronze Compass credential ->', statusAfterCollect);

    console.log('STEP 6: hovering the SAME stall again — now oncePerUser-owned — the Previewer ignores it entirely');
    await frame.page().mouse.move(5, 5);
    await frame.page().waitForTimeout(500);
    await frame.locator('#scene').hover({ position: { x: compass.sx, y: compass.sy } });
    await frame.page().waitForTimeout(400);
    const afterOwnedHover = await readPreviewer(frame);
    if (!afterOwnedHover.hidden) throw new Error('Expected the Previewer to stay closed for an already-owned oncePerUser stall, got: ' + JSON.stringify(afterOwnedHover));
    console.log('PASS: Previewer ignored the already-owned stall, as Bruno asked');

    console.log('STEP 6b: none of steps 1-6 (pure scene hovering) ever opened the Asset Viewer — only the Previewer should react to scene hovers');
    const assetViewerHiddenAfterSceneSteps = await frame.evaluate(() => document.getElementById('assetViewerWidget').hidden);
    if (!assetViewerHiddenAfterSceneSteps) throw new Error('The Asset Viewer must never open from scene hovering — only the Previewer should (task #227)');
    console.log('PASS: Asset Viewer stayed closed through every scene-hover step');

    console.log('STEP 7: dropping the compass, then hovering its OWN dropped marker shows the real owned credential — no preview note this time');
    await frame.page().mouse.move(5, 5);
    await frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item').length > 0, { timeout: 10000 });
    await clickCardMenuAction(frame.locator('#selfCollectiblesList .wallet-item button[data-action="drop"]'));
    await frame.waitForFunction(() => document.getElementById('status').textContent.includes('Click where you want to drop it'), { timeout: 5000 });
    await frame.locator('#scene').click({ position: { x: 90, y: 90 } });
    await frame.waitForFunction(() => document.getElementById('status').textContent.startsWith('Dropped.'), { timeout: 5000 });

    const { itemMarkers } = await projectMarkers(frame);
    if (itemMarkers.length !== 1) throw new Error('Expected exactly one dropped-item marker, got ' + itemMarkers.length);
    await frame.locator('#scene').hover({ position: { x: itemMarkers[0].sx, y: itemMarkers[0].sy } });
    await frame.waitForFunction(() => document.getElementById('previewerWidget').hidden === false, { timeout: 3000 });
    const droppedPreview = await readPreviewer(frame);
    if (!droppedPreview.name.includes('Bronze Compass')) throw new Error('Expected "Bronze Compass" for the dropped item\'s own marker, got: ' + droppedPreview.name);
    if (droppedPreview.hasNote) throw new Error('Expected NO preview note for an owned, dropped item — this is a real credential, not a class-level preview');
    if (droppedPreview.hasShowModelButton) throw new Error('The Previewer must never have a "Show model" button');
    console.log('PASS: hovering the dropped item shows the real owned credential, no preview note, no "Show model" button');

    console.log('STEP 8: clicking that dropped-item preview inside the Previewer picks it back up');
    const statusBeforePickup = await frame.locator('#status').textContent();
    await frame.locator('#previewerBody').click();
    await frame.waitForFunction((prev) => document.getElementById('status').textContent !== prev, statusBeforePickup, { timeout: 5000 });
    const statusAfterPickup = await frame.locator('#status').textContent();
    // Task #250 — "Picked it up." (not "...back up") since a pickup is no
    // longer necessarily reclaiming your OWN earlier drop; the wording had
    // to stop assuming that once drops became shared.
    if (statusAfterPickup !== 'Picked it up.') throw new Error('Expected "Picked it up.", got: ' + statusAfterPickup);
    const { itemMarkers: afterPickupMarkers } = await projectMarkers(frame);
    if (afterPickupMarkers.length !== 0) throw new Error('Expected zero dropped-item markers after picking it back up, got ' + afterPickupMarkers.length);
    console.log('PASS: clicking the Previewer picked the item back up, no marker left in the scene');

    console.log('STEP 9: hovering an actual WALLET CARD still opens the Asset Viewer, exactly as before this task — "don\'t touch the Asset Viewer" means it still works normally, not that it\'s disabled');
    await frame.page().mouse.move(5, 5);
    await frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item').length > 0, { timeout: 10000 });
    const cardBox = await frame.locator('#selfCollectiblesList .wallet-item').first().boundingBox();
    await frame.page().mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
    await frame.waitForFunction(() => document.getElementById('assetViewerWidget').hidden === false, { timeout: 3000 });
    const cardHoverContent = await frame.evaluate(() => ({
      name: document.querySelector('#assetViewerBody .name') ? document.querySelector('#assetViewerBody .name').textContent : null
    }));
    if (!cardHoverContent.name || !cardHoverContent.name.includes('Bronze Compass')) throw new Error('Expected the Asset Viewer to open for the wallet card hover, got: ' + JSON.stringify(cardHoverContent));
    console.log('PASS: Asset Viewer still opens normally for a wallet-card hover ->', cardHoverContent.name);

    console.log('\nALL 2D PREVIEWER (TASK #227) CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close().catch(() => {});
  }
})();
