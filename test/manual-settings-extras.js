// Manual check for three small UX additions: pressing Enter in a password
// field submits the form it belongs to (onboarding create, unlock, change
// password) instead of requiring a mouse click; a genuine password change
// for the local identity (re-verifies the OLD password, re-encrypts under
// the new one, leaves the keypair itself untouched); and a "Recent worlds"
// list on the main wallet screen (last 10 visited, most-recent-first,
// deduplicated, each entry travels back there on click). Not part of the
// permanent suite, same reasoning as the other manual-*.js scripts.

const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');

async function projectPortals(frame) {
  return frame.evaluate(() => {
    return new Promise((resolve) => {
      const check = () => {
        if (window.__atlasScene && window.__atlasScene.portalMarkers.length) {
          const canvas = document.getElementById('scene');
          const originX = canvas.width / 2;
          const originY = canvas.height / 2 + 40;
          const SCALE = 26, COS30 = Math.cos(Math.PI / 6), SIN30 = Math.sin(Math.PI / 6);
          const points = window.__atlasScene.portalMarkers.map((m) => {
            const [x, , z] = m.position;
            return {
              sx: originX + (x - z) * COS30 * SCALE,
              sy: originY + (x + z) * SIN30 * SCALE,
              kind: m.portal && m.portal.kind,
              to: m.portal && m.portal.to
            };
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

// Both switchIdentityModeBtn's category (used by the lock button here) and
// changePasswordBtn live under Settings -> "Identity method", a category
// collapsed by default.
async function openIdentityMethodCategory(frame) {
  await frame.locator('#settingsTabBtn').click();
  await frame.waitForFunction(() => document.getElementById('settingsScreen').classList.contains('active'), { timeout: 5000 });
  const category = frame.locator('.settings-category[data-category="identity-method"]');
  if (!(await category.evaluate((el) => el.classList.contains('open')))) {
    await category.locator('.settings-category-toggle').click();
    await frame.waitForFunction(() => document.querySelector('.settings-category[data-category="identity-method"]').classList.contains('open'), { timeout: 5000 });
  }
}

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-settings-extras');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-sandbox'
    ]
  });

  try {
    const page = await context.newPage();

    console.log('SETUP: opening the wallet panel on a fresh device');
    await page.goto('http://localhost:8001', { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    await frame.locator('#walletBtn').click();
    await frame.locator('#chooseNewBtn').click();
    await frame.waitForFunction(() => document.getElementById('createScreen').classList.contains('active'), { timeout: 5000 });

    console.log('STEP 1: Enter in the confirm-password field submits identity creation — no click on Create identity');
    const ORIGINAL_PASSWORD = 'enter-key-test-password-1';
    await frame.locator('#newPasswordInput').fill(ORIGINAL_PASSWORD);
    await frame.locator('#newPasswordConfirmInput').fill(ORIGINAL_PASSWORD);
    await frame.locator('#newPasswordConfirmInput').press('Enter');
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
    console.log('PASS: Enter submitted the create-identity form, seed phrase revealed');
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });

    console.log('STEP 2: locking, then Enter in the unlock password field logs back in — no click on Unlock');
    await openIdentityMethodCategory(frame);
    await frame.locator('#lockWalletBtn').click();
    await frame.waitForFunction(() => !document.getElementById('walletPanel').classList.contains('open'), { timeout: 5000 });
    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => document.getElementById('unlockScreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('#unlockPasswordInput').fill(ORIGINAL_PASSWORD);
    await frame.locator('#unlockPasswordInput').press('Enter');
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 10000 });
    console.log('PASS: Enter logged in from the unlock screen, no button click needed');

    console.log('STEP 3: changing password — wrong current password is rejected, nothing changes');
    await openIdentityMethodCategory(frame);
    const NEW_PASSWORD = 'enter-key-test-password-2-different';
    await frame.locator('#changePasswordCurrentInput').fill('definitely-the-wrong-password');
    await frame.locator('#changePasswordNewInput').fill(NEW_PASSWORD);
    await frame.locator('#changePasswordConfirmInput').fill(NEW_PASSWORD);
    await frame.locator('#changePasswordBtn').click();
    await frame.waitForFunction(() => document.getElementById('changePasswordStatus').textContent === 'Change failed: Incorrect current password.', { timeout: 5000 });
    console.log('PASS: wrong current password rejected with a distinct message');

    console.log('STEP 4: changing password for real — Enter in the confirm field submits it, same as the other forms');
    await frame.locator('#changePasswordCurrentInput').fill(ORIGINAL_PASSWORD);
    await frame.locator('#changePasswordNewInput').fill(NEW_PASSWORD);
    await frame.locator('#changePasswordConfirmInput').fill(NEW_PASSWORD);
    await frame.locator('#changePasswordConfirmInput').press('Enter');
    await frame.waitForFunction(() => document.getElementById('changePasswordStatus').textContent === 'Password changed.', { timeout: 5000 });
    console.log('PASS: password changed');

    console.log('STEP 5: the OLD password no longer unlocks; the NEW one does');
    await frame.locator('#lockWalletBtn').click();
    await frame.waitForFunction(() => !document.getElementById('walletPanel').classList.contains('open'), { timeout: 5000 });
    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => document.getElementById('unlockScreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('#unlockPasswordInput').fill(ORIGINAL_PASSWORD);
    await frame.locator('#unlockBtn').click();
    await frame.waitForFunction(() => document.getElementById('unlockScreenStatus').textContent === 'Incorrect password.', { timeout: 10000 });
    console.log('PASS: old password rejected after the change');
    const identityBeforeUnlock = await frame.locator('#unlockScreen').getAttribute('class');
    if (!identityBeforeUnlock.includes('active')) throw new Error('Should still be on the unlock screen after the old password fails');
    await frame.locator('#unlockPasswordInput').fill(NEW_PASSWORD);
    await frame.locator('#unlockBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 10000 });
    const identityLabel = await frame.locator('#walletIdentity').textContent();
    if (!identityLabel.startsWith('Identity:')) throw new Error('Expected the SAME identity back, got: ' + identityLabel);
    console.log('PASS: new password unlocks the SAME identity (same keypair, only its at-rest encryption changed) ->', identityLabel);

    console.log('STEP 6: recent worlds — capped at 10, most-recent-first, deduplicated (checked directly, since only 6 real demo worlds exist)');
    const capResult = await frame.evaluate(async () => {
      for (let i = 1; i <= 12; i++) {
        await AtlasWallet.recordWorldVisit({
          domain: 'synthetic.test', world: 'world-' + i, worldName: 'World ' + i, manifestUrl: 'http://synthetic.test/manifest.json'
        });
      }
      // Revisit an early one — should move to the front, not duplicate.
      await AtlasWallet.recordWorldVisit({
        domain: 'synthetic.test', world: 'world-5', worldName: 'World 5', manifestUrl: 'http://synthetic.test/manifest.json'
      });
      return AtlasWallet.getRecentWorlds();
    });
    if (capResult.length !== 10) throw new Error('Expected the list capped at 10, got ' + capResult.length);
    if (capResult[0].world !== 'world-5') throw new Error('Expected the revisited world-5 at the front, got: ' + capResult[0].world);
    if (capResult.filter((e) => e.world === 'world-5').length !== 1) throw new Error('world-5 appears more than once — dedup failed');
    if (capResult.some((e) => e.world === 'world-1' || e.world === 'world-2')) throw new Error('Oldest entries should have been evicted by the 10-item cap');
    console.log('PASS: capped at 10, dedup-on-revisit moves an entry to the front instead of duplicating it, oldest entries evicted');

    console.log('STEP 7: clearing the synthetic history, then crossing a real cross-domain portal and checking it shows up on the main wallet screen');
    await frame.evaluate(async () => { await chrome.storage.local.remove('atlasRecentWorlds'); });
    // Re-record the real Plaza visit using the actual manifest URL the page
    // fetched it from (currentManifestUrl, a viewer.js module-scoped var) —
    // NOT window.location.href, which is the extension's own viewer.html
    // page URL and would make a later "Go" click fetch HTML instead of JSON.
    await frame.evaluate(async () => {
      await AtlasWallet.recordWorldVisit({ domain: 'localhost:8001', world: 'plaza', worldName: 'Example Plaza', manifestUrl: currentManifestUrl });
    });
    const portals = await projectPortals(frame);
    const toNeighbor = portals.find((p) => p.kind === 'domain');
    await frame.locator('#scene').click({ position: { x: toNeighbor.sx, y: toNeighbor.sy } });
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Neighbor Workshop'), { timeout: 10000 });
    console.log('PASS: crossed to Neighbor Workshop on localhost:8002');

    // Recent worlds lives directly on the main wallet screen now (moved out
    // of Settings), as its own collapsible category, closed by default.
    if (!(await frame.locator('#walletPanel').evaluate((el) => el.classList.contains('open')))) {
      await frame.locator('#walletBtn').click();
    }
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('.settings-category[data-category="recent-worlds"] .settings-category-toggle').click();
    await frame.waitForFunction(() => document.querySelector('.settings-category[data-category="recent-worlds"]').classList.contains('open'), { timeout: 5000 });
    await frame.waitForFunction(() => document.querySelectorAll('#recentWorldsList .info-card').length >= 2, { timeout: 5000 });
    const recentText = await frame.locator('#recentWorldsList').textContent();
    if (!recentText.includes('Neighbor Workshop') || !recentText.includes('Example Plaza')) {
      throw new Error('Expected both visited worlds listed, got: ' + recentText.replace(/\s+/g, ' ').trim());
    }
    if (!recentText.includes('You are here')) throw new Error('Expected the current world marked "You are here": ' + recentText);
    console.log('PASS: Recent worlds (on the main wallet screen) lists both visited places, current one marked "You are here"');

    console.log('STEP 8: clicking "Go" on Example Plaza travels back there and closes the wallet panel');
    await frame.locator('#recentWorldsList button[data-action="travel"]').first().click();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    await frame.waitForFunction(() => !document.getElementById('walletPanel').classList.contains('open'), { timeout: 5000 });
    console.log('PASS: traveled back to Example Plaza, wallet panel closed automatically');

    console.log('\nALL SETTINGS-EXTRAS CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
