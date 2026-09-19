// Manual check for task #227 in the 3D (gltf-mini-v1) renderer: the new
// Previewer window now drives ALL of the lobby's proximity previewing,
// including — new in this task — a MULTI-item list when the visitor is in
// E-range of two or more not-yet-collected class-bearing interactables at
// once, clickable-to-collect from that list, and "press E multiple times to
// collect them one at a time."
//
// Reuses spatial/lobby/scene.json's own two loot crates
// (manual-lobby-interactables.js's CRATE_1/CRATE_2) as fixtures. Their
// radius was widened from 1.1 to 1.7 as part of this task specifically so a
// single spot (roughly their midpoint) sits in E-range of BOTH at once —
// otherwise this scenario, which Bruno explicitly asked for ("if the
// character is close to 2 or more items it must show a list"), could never
// actually happen in this demo world. manual-lobby-interactables.js's own
// checks (exact walk-up-to-one-crate-at-a-time behavior) still pass
// unchanged with the wider radius.
//
// Runs as TWO separate fresh-wallet scenarios (two separate browser
// profiles), because this lobby only has two collectible classes total and
// each scenario needs to see BOTH still uncollected:
//   Scenario A: the list appears with both items, click ONE of them (inside
//     the Previewer, with the mouse) to collect it, the list narrows itself
//     down to a single remaining item automatically, and revisiting the
//     midpoint after both are gone previews nothing (both filtered out as
//     owned oncePerUser classes).
//   Scenario B: at the same midpoint, pressing E collects the nearest
//     available item; pressing E again immediately collects the OTHER one
//     — "one at a time" falls out naturally from already-owned markers
//     dropping out of the nearby list, no extra bookkeeping needed.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const CRATE_1 = { x: 0.3, z: -0.8, class: 'atlas.trinket.pin' };
const CRATE_2 = { x: -2.0, z: 1.3, class: 'atlas.trinket.charm' };
const MIDPOINT = { x: -0.85, z: 0.25 }; // in E-range (1.7) of both crates at once — see scene.json's own comment
const FAR_AWAY = { x: 20, z: 20 };
const DOMAIN = 'localhost:8001';

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

async function waitForStatusPrefix(frame, prefix, prevStatus, timeout = 10000) {
  await frame.waitForFunction(({ prefix, prev }) => {
    const t = document.getElementById('status').textContent;
    return t !== prev && t.startsWith(prefix);
  }, { prefix, prev: prevStatus }, { timeout });
  return frame.locator('#status').textContent();
}

function readPreviewer(frame) {
  return frame.evaluate(() => {
    const widget = document.getElementById('previewerWidget');
    const nameEl = document.querySelector('#previewerBody .name');
    const listItemEls = Array.from(document.querySelectorAll('#previewerBody .previewer-list-item'));
    return {
      hidden: widget.hidden,
      name: nameEl ? nameEl.textContent : null,
      hasNote: !!document.querySelector('#previewerBody .previewer-note'),
      hasShowModelButton: !!document.querySelector('#previewerBody button, #previewerPanel button'),
      listItemNames: listItemEls.map((el) => el.querySelector('.previewer-list-item-name').textContent)
    };
  });
}

async function getWalletClasses(frame) {
  return frame.evaluate(async () => {
    const identity = await AtlasWallet.getIdentity();
    const wallet = await AtlasWallet.getWallet(identity.publicKey);
    return wallet.map((e) => e.credential.asset.class);
  });
}

// Real class names/thumbnails come from the same GET /atlas/asset/class
// endpoint the Previewer itself calls (AtlasWallet.fetchAssetClassInfo,
// SPEC.md §5.1.2) — fetched here too rather than hardcoded, so this test
// doesn't silently drift from the catalog if either crate's display name
// ever changes.
async function fetchClassName(frame, domain, cls) {
  const info = await frame.evaluate(({ domain, cls }) => AtlasWallet.fetchAssetClassInfo(domain, cls), { domain, cls });
  if (!info || !info.name) throw new Error('Expected a resolved class name for ' + cls);
  return info.name;
}

async function setupFreshLobbySession(context, page) {
  page.on('pageerror', (err) => console.log('PAGEERROR:', String(err)));
  await page.goto('http://localhost:8001', { waitUntil: 'load' });
  await page.locator('#domain-atlas-enter-btn').click();
  const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
  const frame = await frameHandle.contentFrame();
  frame.on('pageerror', (err) => console.log('FRAMEERROR:', String(err)));
  await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });

  await frame.locator('#walletBtn').click();
  await frame.locator('#chooseNewBtn').click();
  await frame.locator('#newPasswordInput').fill('previewer-3d-test-pw');
  await frame.locator('#newPasswordConfirmInput').fill('previewer-3d-test-pw');
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
  return frame;
}

async function runScenarioA() {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-previewer-3d-a');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: ['--disable-extensions-except=' + EXT_PATH, '--load-extension=' + EXT_PATH, '--no-sandbox', '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist']
  });
  try {
    const page = await context.newPage();
    console.log('SCENARIO A SETUP: fresh identity, entering the 3D lobby');
    const frame = await setupFreshLobbySession(context, page);
    console.log('PASS: entered the 3D lobby with a fresh wallet — nothing collected yet');

    const pinName = await fetchClassName(frame, DOMAIN, CRATE_1.class);
    const charmName = await fetchClassName(frame, DOMAIN, CRATE_2.class);

    console.log('STEP A1: nothing previews at spawn');
    const atSpawn = await readPreviewer(frame);
    if (!atSpawn.hidden) throw new Error('Expected the Previewer to be closed at spawn, got: ' + JSON.stringify(atSpawn));
    const nearbyAtSpawn = await frame.evaluate(() => window.__atlasActive3D.getNearbyInteractMarkers().length);
    if (nearbyAtSpawn !== 0) throw new Error('Expected zero nearby markers at spawn, got ' + nearbyAtSpawn);
    console.log('PASS: Previewer closed, nothing nearby at spawn');

    console.log('STEP A2: walking up to crate 1 alone shows a single-item Previewer (crate 2 is too far away)');
    await teleport(frame, CRATE_1.x, CRATE_1.z);
    await frame.waitForFunction(() => window.__atlasActive3D.getNearbyInteractMarkers().length === 1, { timeout: 5000 });
    await frame.waitForFunction(() => document.getElementById('previewerWidget').hidden === false, { timeout: 3000 });
    const singlePreview = await readPreviewer(frame);
    if (singlePreview.listItemNames.length !== 0) throw new Error('Expected a single-item detail view (no list rows) with only one crate in range, got: ' + JSON.stringify(singlePreview.listItemNames));
    if (!singlePreview.name.includes(pinName)) throw new Error('Expected "' + pinName + '" in the single-item preview, got: ' + singlePreview.name);
    if (!singlePreview.hasNote) throw new Error('Expected a "Not collected yet" note');
    if (singlePreview.hasShowModelButton) throw new Error('The Previewer must never have a "Show model" button');
    console.log('PASS: single-item Previewer for crate 1 alone ->', singlePreview.name);

    console.log('STEP A3: walking to the midpoint between both crates shows a MULTI-item list — Bruno\'s "close to 2 or more items" case');
    await teleport(frame, MIDPOINT.x, MIDPOINT.z);
    await frame.waitForFunction(() => window.__atlasActive3D.getNearbyInteractMarkers().length === 2, { timeout: 5000 });
    await frame.waitForFunction(() => document.querySelectorAll('#previewerBody .previewer-list-item').length === 2, { timeout: 5000 });
    const listPreview = await readPreviewer(frame);
    const expectedNames = [pinName, charmName].sort();
    const actualNames = listPreview.listItemNames.slice().sort();
    if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
      throw new Error('Expected the list to show both ' + JSON.stringify(expectedNames) + ', got: ' + JSON.stringify(actualNames));
    }
    console.log('PASS: Previewer shows both items in a clickable list ->', listPreview.listItemNames);

    console.log('STEP A4: clicking one of the listed items, with the mouse, inside the Previewer collects it');
    const statusBeforeClick = await frame.locator('#status').textContent();
    await frame.locator('#previewerBody .previewer-list-item', { hasText: pinName }).click();
    const statusAfterClick = await waitForStatusPrefix(frame, 'Collected', statusBeforeClick);
    if (statusAfterClick !== 'Collected Open the crate.') throw new Error('Expected "Collected Open the crate.", got: ' + statusAfterClick);
    const walletAfterClick = await getWalletClasses(frame);
    if (!walletAfterClick.includes(CRATE_1.class)) throw new Error('Expected ' + CRATE_1.class + ' in the wallet after clicking it in the Previewer list, got classes: ' + walletAfterClick.join(', '));
    console.log('PASS: clicking the list row minted a genuine ' + pinName + ' credential ->', statusAfterClick);

    console.log('STEP A5: the list narrows itself down to the single remaining item automatically, still at the same spot');
    await frame.waitForFunction(() => window.__atlasActive3D.getNearbyInteractMarkers().length === 1, { timeout: 5000 });
    await frame.waitForFunction(() => document.querySelectorAll('#previewerBody .previewer-list-item').length === 0, { timeout: 5000 });
    const narrowedPreview = await readPreviewer(frame);
    if (!narrowedPreview.name.includes(charmName)) throw new Error('Expected the remaining single-item preview to be "' + charmName + '", got: ' + narrowedPreview.name);
    console.log('PASS: Previewer automatically narrowed to the one remaining uncollected item ->', narrowedPreview.name);

    console.log('STEP A6: collecting the last one too, then the midpoint previews nothing — both oncePerUser classes now owned and ignored');
    // Both crates share the exact same label ("Open the crate"), so their
    // "Collected ..." status text is byte-identical — waitForStatusPrefix's
    // "the text actually changed" check would spuriously time out here
    // (nothing to distinguish this from step A4's own success text), so
    // this step waits on the wallet's own class list instead.
    await pressE(frame);
    await frame.waitForFunction((cls) => {
      return new Promise((resolve) => {
        AtlasWallet.getIdentity().then((identity) => AtlasWallet.getWallet(identity.publicKey)).then((wallet) => {
          resolve(wallet.some((e) => e.credential.asset.class === cls));
        });
      });
    }, CRATE_2.class, { timeout: 10000 });
    await frame.waitForFunction(() => document.getElementById('status').textContent === 'Collected Open the crate.', { timeout: 5000 });
    await frame.waitForFunction(() => window.__atlasActive3D.getNearbyInteractMarkers().length === 0, { timeout: 5000 });
    await frame.waitForFunction(() => document.getElementById('previewerWidget').hidden === true, { timeout: 5000 });
    const finalWallet = await getWalletClasses(frame);
    if (!finalWallet.includes(CRATE_1.class) || !finalWallet.includes(CRATE_2.class)) throw new Error('Expected BOTH crate classes in the wallet, got: ' + finalWallet.join(', '));
    console.log('PASS: both classes now owned, the Previewer ignores the midpoint entirely — nothing left to preview');

    console.log('\nSCENARIO A (list + click-to-collect + ownership skip) PASSED');
  } finally {
    await context.close().catch(() => {});
  }
}

async function runScenarioB() {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-previewer-3d-b');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: ['--disable-extensions-except=' + EXT_PATH, '--load-extension=' + EXT_PATH, '--no-sandbox', '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist']
  });
  try {
    const page = await context.newPage();
    console.log('SCENARIO B SETUP: a SECOND fresh identity, entering the 3D lobby');
    const frame = await setupFreshLobbySession(context, page);
    console.log('PASS: entered the 3D lobby with a second, independent fresh wallet');

    console.log('STEP B1: walking to the midpoint between both crates shows both in range');
    await teleport(frame, MIDPOINT.x, MIDPOINT.z);
    await frame.waitForFunction(() => window.__atlasActive3D.getNearbyInteractMarkers().length === 2, { timeout: 5000 });
    console.log('PASS: both crates in E-range at once, exactly as scenario A found');

    console.log('STEP B2: pressing E collects the nearest available item — "press e multiple times to collect them one at a time"');
    const statusBeforeFirst = await frame.locator('#status').textContent();
    await pressE(frame);
    const statusAfterFirst = await waitForStatusPrefix(frame, 'Collected', statusBeforeFirst);
    if (statusAfterFirst !== 'Collected Open the crate.') throw new Error('Expected "Collected Open the crate.", got: ' + statusAfterFirst);
    const walletAfterFirst = await getWalletClasses(frame);
    if (walletAfterFirst.length !== 1) throw new Error('Expected exactly one class collected by the first E press, got: ' + walletAfterFirst.join(', '));
    const firstClass = walletAfterFirst[0];
    console.log('PASS: first E press collected ' + firstClass + ' -> ' + statusAfterFirst);

    console.log('STEP B3: the just-collected one drops out of range immediately — only the OTHER item is left nearby');
    await frame.waitForFunction(() => window.__atlasActive3D.getNearbyInteractMarkers().length === 1, { timeout: 5000 });
    const remainingMarker = await frame.evaluate(() => window.__atlasActive3D.getNearbyInteractMarkers()[0].class);
    const expectedRemaining = firstClass === CRATE_1.class ? CRATE_2.class : CRATE_1.class;
    if (remainingMarker !== expectedRemaining) throw new Error('Expected the remaining nearby marker to be ' + expectedRemaining + ', got: ' + remainingMarker);
    console.log('PASS: only ' + expectedRemaining + ' remains in range, ready for the very next E press — no extra bookkeeping needed');

    console.log('STEP B4: pressing E again immediately collects the OTHER item, not a rejected re-collect of the first');
    // Both crates share the exact same label ("Open the crate"), so their
    // "Collected ..." status text is byte-identical to step B2's own — a
    // text-changed check would spuriously time out here, so this waits on
    // the wallet's own class list instead (same reasoning as scenario A's
    // step A6).
    await pressE(frame);
    await frame.waitForFunction((cls) => {
      return new Promise((resolve) => {
        AtlasWallet.getIdentity().then((identity) => AtlasWallet.getWallet(identity.publicKey)).then((wallet) => {
          resolve(wallet.some((e) => e.credential.asset.class === cls));
        });
      });
    }, expectedRemaining, { timeout: 10000 });
    await frame.waitForFunction(() => document.getElementById('status').textContent === 'Collected Open the crate.', { timeout: 5000 });
    const walletAfterSecond = await getWalletClasses(frame);
    if (!walletAfterSecond.includes(CRATE_1.class) || !walletAfterSecond.includes(CRATE_2.class)) {
      throw new Error('Expected BOTH crate classes in the wallet after two E presses, got: ' + walletAfterSecond.join(', '));
    }
    if (walletAfterSecond.length !== 2) throw new Error('Expected EXACTLY two credentials (one per class, no duplicates), got ' + walletAfterSecond.length + ': ' + walletAfterSecond.join(', '));
    console.log('PASS: second E press collected the other item; both classes owned, no duplicates ->', walletAfterSecond.join(', '));

    console.log('STEP B5: nothing left to preview at the midpoint now');
    await frame.waitForFunction(() => window.__atlasActive3D.getNearbyInteractMarkers().length === 0, { timeout: 5000 });
    await frame.waitForFunction(() => document.getElementById('previewerWidget').hidden === true, { timeout: 5000 });
    console.log('PASS: Previewer closed, both oncePerUser classes now owned and ignored');

    console.log('\nSCENARIO B (press E multiple times, one at a time) PASSED');
  } finally {
    await context.close().catch(() => {});
  }
}

(async () => {
  try {
    await runScenarioA();
    await runScenarioB();
    console.log('\nALL 3D PREVIEWER (TASK #227) CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  }
})();
