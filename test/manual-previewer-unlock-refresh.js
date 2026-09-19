// Manual check for a bug Bruno reported: entering a scene showed an
// already-collected oncePerUser item (the plaza's Subscription Card desk)
// as if it were NOT collected, but leaving and re-entering the scene
// correctly hid/blocked it.
//
// Root cause: Example Plaza declares policy.identityRequired: false (see
// demo-domain-a/.well-known/spatial.json), so a visitor can be standing in
// it while their local-password identity is still LOCKED. enterWorld()'s
// own refreshOwnedOncePerUserClassKeys() call (task #227) ran fine, but
// AtlasWallet.getIdentity() returned null at that moment (locked), so the
// ownership snapshot it computed was an empty Set — even though the locked
// wallet already held the credential, just not decryptable yet without the
// password. Unlocking mid-visit (the wallet panel's Unlock button) never
// re-ran that refresh, so the Previewer kept treating the desk as
// uncollected for the rest of the visit — only the NEXT enterWorld() call
// (i.e. leaving and coming back) happened to refresh it correctly.
//
// Fix: unlockBtn's click handler (extension/viewer.js) now calls
// refreshOwnedOncePerUserClassKeys() itself, right after the existing
// refreshInventoryDisplay(), so the ownership cache catches up the moment
// the wallet becomes readable — no need to leave the scene. The same gap
// existed for confirmImportBtn/restoreFullBackupBtn (importing/restoring an
// identity that can already own things), fixed the same way, though this
// test only exercises the unlock path Bruno actually hit.
//
// Covers:
//   1. Create an identity, collect the plaza desk's atlas.membership card.
//   2. Lock the wallet, then reload the page entirely (a genuinely fresh
//      enterWorld(), the same as a brand new visit) — landing back in the
//      Plaza instantly since it doesn't require identity, still locked.
//   3. Confirm the (inherent, unavoidable) starting condition: while
//      locked, the desk previews as available again — the wallet can't be
//      decrypted yet, so this part is expected, not the bug.
//   4. Unlock via the wallet panel WITHOUT leaving the Plaza. Confirm the
//      desk immediately stops previewing/offering the card — the actual
//      fix, and the exact scenario Bruno described.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const DOMAIN = 'localhost:8001';
const PASSWORD = 'previewer-unlock-refresh-pw';

async function projectInteractables(frame) {
  return frame.evaluate(() => new Promise((resolve) => {
    const check = () => {
      const scene = window.__atlasScene;
      if (scene && scene.interactables && scene.interactables.length) {
        const canvas = document.getElementById('scene');
        const originX = canvas.width / 2;
        const originY = canvas.height / 2 + 40;
        resolve(scene.interactables.map((m) => {
          const [x, y, z] = m.position;
          const p = project(x, y || 0, z, originX, originY);
          return { sx: p.x, sy: p.y - 16, label: m.label, class: m.class, action: m.action };
        }));
      } else {
        requestAnimationFrame(check);
      }
    };
    check();
  }));
}

function readPreviewer(frame) {
  return frame.evaluate(() => {
    const widget = document.getElementById('previewerWidget');
    return { hidden: widget.hidden };
  });
}

async function enterPlaza(page) {
  await page.goto('http://localhost:8001', { waitUntil: 'load' });
  await page.locator('#domain-atlas-enter-btn').click();
  const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
  const frame = await frameHandle.contentFrame();
  frame.on('pageerror', (err) => console.log('FRAMEERROR:', String(err)));
  await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
  return frame;
}

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-previewer-unlock-refresh');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  });
  try {
    const page = await context.newPage();
    page.on('pageerror', (err) => console.log('PAGEERROR:', String(err)));
    console.log('SETUP: fresh identity, Example Plaza');
    let frame = await enterPlaza(page);
    await frame.locator('#walletBtn').click();
    await frame.locator('#chooseNewBtn').click();
    await frame.locator('#newPasswordInput').fill(PASSWORD);
    await frame.locator('#newPasswordConfirmInput').fill(PASSWORD);
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('#walletBtn').click(); // close the panel, back to the scene
    console.log('PASS: identity ready');

    console.log('STEP 1: collect the Subscription Card from the plaza desk');
    let interactables = await projectInteractables(frame);
    let desk = interactables.find((m) => m.class === 'atlas.membership');
    if (!desk) throw new Error('Expected the Subscription Card desk interactable in the plaza');
    await frame.page().mouse.move(5, 5);
    await frame.locator('#scene').click({ position: { x: desk.sx, y: desk.sy } });
    await frame.waitForFunction(() => document.getElementById('status').textContent === 'Collected Subscription Card.', { timeout: 10000 });
    console.log('PASS: desk credential minted');

    console.log('STEP 2: lock the wallet, then reload the page entirely — a genuinely fresh visit, still locked');
    await frame.locator('#quickLockWalletBtn').click();
    await frame.waitForFunction(() => document.getElementById('quickLockWalletBtn').style.display === 'none', { timeout: 5000 });
    frame = await enterPlaza(page); // full page.goto() + re-enter — a real fresh enterWorld(), not just a portal hop
    console.log('PASS: back in the Plaza on a fresh page load, wallet still locked (identityRequired: false lets this through with no prompt)');

    console.log('STEP 3: while locked, the desk previews as available again — expected/inherent (the wallet can\'t be decrypted yet), NOT the bug itself, just the precondition for it');
    interactables = await projectInteractables(frame);
    desk = interactables.find((m) => m.class === 'atlas.membership');
    if (!desk) throw new Error('Expected the desk interactable to still be present after reload');
    await frame.page().mouse.move(5, 5);
    await frame.locator('#scene').hover({ position: { x: desk.sx, y: desk.sy } });
    await frame.waitForFunction(() => document.getElementById('previewerWidget').hidden === false, { timeout: 3000 });
    console.log('PASS: confirmed starting condition — previewer offers the desk while locked, as expected');

    console.log('STEP 4 (the actual fix): unlock via the wallet panel WITHOUT leaving the Plaza — the desk should immediately stop previewing, no world re-entry needed');
    await frame.page().mouse.move(5, 5);
    await frame.waitForFunction(() => document.getElementById('previewerWidget').hidden === true, { timeout: 5000 }).catch(() => {});
    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => document.getElementById('unlockScreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('#unlockPasswordInput').fill(PASSWORD);
    await frame.locator('#unlockBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('#walletBtn').click(); // close the panel, back to the scene, still standing in the Plaza the whole time

    await frame.page().mouse.move(5, 5);
    await frame.locator('#scene').hover({ position: { x: desk.sx, y: desk.sy } });
    await frame.page().waitForTimeout(500);
    const preview = await readPreviewer(frame);
    if (!preview.hidden) throw new Error('BUG REPRODUCED: after unlocking mid-visit, the Previewer still offers the already-collected desk — refreshOwnedOncePerUserClassKeys() was not re-run on unlock');
    console.log('PASS: the desk is ignored by the Previewer immediately after unlocking — no need to leave and re-enter the scene');

    console.log('\nALL PREVIEWER-UNLOCK-REFRESH CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close().catch(() => {});
  }
})();
