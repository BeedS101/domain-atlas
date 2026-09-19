// Manual check for task #209: a short chime plays when the wallet's OWN
// holdings actually gain something (mint, issue, claimed trade, gift, mail
// delivery — see viewer.js's refreshInventoryDisplay() snapshot-diff
// comment for the exact rule), gated by the new Settings -> Sound toggle
// (AtlasWallet.getWalletSoundEnabled()/setWalletSoundEnabled()).
//
// Rather than actually listening for audio output (unreliable under
// xvfb/swiftshader, and not really what this feature needs verified),
// this monkey-patches the exposed playWalletGainChime() — a plain
// top-level function in viewer.js's classic script, reachable the same
// way every other bare identifier already used by test/manual-market-
// stalls.js (portalHitboxes, AtlasWallet, project()) is — with a counter,
// then drives the exact same Trading Post stalls manual-market-stalls.js
// already exercises to confirm: no chime on wallet creation itself (an
// empty wallet establishing its own baseline is not a "gain"), a real
// chime per genuine gain, and the Settings toggle actually gates it.
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');

async function projectInteractables(frame) {
  return frame.evaluate(() => new Promise((resolve) => {
    const check = () => {
      const scene = window.__atlasScene;
      if (scene && scene.interactables && scene.interactables.some((m) => m.class && m.class.startsWith('atlas.element.'))) {
        const canvas = document.getElementById('scene');
        const originX = canvas.width / 2;
        const originY = canvas.height / 2 + 40;
        resolve(scene.interactables.map((m) => {
          const [x, y, z] = m.position;
          const p = project(x, y || 0, z, originX, originY);
          return { sx: p.x, sy: p.y - 16, label: m.label, class: m.class };
        }));
      } else requestAnimationFrame(check);
    };
    check();
  }));
}

async function chimeCount(frame) {
  return frame.evaluate(() => window.__chimeCount || 0);
}

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-wallet-gain-chime');
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

    console.log('SETUP: creating an identity, patching playWalletGainChime with a counter, walking to the Trading Post');
    await page.goto('http://localhost:8001', { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });

    await frame.locator('#walletBtn').click();
    await frame.locator('#chooseNewBtn').click();
    await frame.locator('#newPasswordInput').fill('wallet-chime-password');
    await frame.locator('#newPasswordConfirmInput').fill('wallet-chime-password');
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });

    // Patched AFTER identity creation's own refreshInventoryDisplay()
    // calls have already run and established the (silent) baseline for
    // this identity — the point of STEP 1 below is to confirm that
    // baseline-setting never chimes, and patching only from here on
    // keeps this test from depending on exactly how many times identity
    // creation happens to call it.
    await frame.evaluate(() => { window.__chimeCount = 0; window.playWalletGainChime = () => { window.__chimeCount++; }; });

    console.log('STEP 1: confirm Settings -> Sound defaults ON');
    await frame.locator('#settingsTabBtn').click();
    await frame.waitForFunction(() => document.getElementById('settingsScreen').classList.contains('active'), { timeout: 5000 });
    const soundDefault = await frame.locator('#walletSoundEnabledInput').isChecked();
    if (!soundDefault) throw new Error('Expected the wallet-sound checkbox to default to checked (enabled)');
    console.log('PASS: sound defaults on');
    await frame.locator('#backFromSettingsBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });

    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => !document.getElementById('walletPanel').classList.contains('open'), { timeout: 5000 });

    const plazaHb = await frame.evaluate(() => new Promise((resolve) => {
      const check = () => {
        if (portalHitboxes.length) {
          const hb = portalHitboxes.find((h) => h.marker.portal && h.marker.portal.to === 'market');
          if (hb) return resolve({ sx: hb.sx, sy: hb.sy });
        }
        requestAnimationFrame(check);
      };
      check();
    }));
    await frame.locator('#scene').click({ position: { x: plazaHb.sx, y: plazaHb.sy } });
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Trading Post'), { timeout: 10000 });
    console.log('PASS: reached the Trading Post, no chime fired yet ->', await chimeCount(frame));
    if ((await chimeCount(frame)) !== 0) throw new Error('Expected 0 chimes before minting anything');

    console.log('STEP 2: mining iron (a genuine first-time gain) fires exactly one chime');
    const [ironStall, goldStall, silverStall] = await projectInteractables(frame);
    const statusBeforeIron = await frame.locator('#status').textContent();
    await frame.locator('#scene').click({ position: { x: ironStall.sx, y: ironStall.sy } });
    await frame.waitForFunction((prev) => {
      const t = document.getElementById('status').textContent;
      return t !== prev && t.startsWith('Collected');
    }, statusBeforeIron, { timeout: 10000 });
    const countAfterIron = await chimeCount(frame);
    if (countAfterIron !== 1) throw new Error('Expected exactly 1 chime after mining iron, got: ' + countAfterIron);
    console.log('PASS: mining iron fired exactly 1 chime');

    console.log('STEP 3: mining gold (a second, independent gain) fires a second chime');
    const statusBeforeGold = await frame.locator('#status').textContent();
    await frame.locator('#scene').click({ position: { x: goldStall.sx, y: goldStall.sy } });
    await frame.waitForFunction((prev) => {
      const t = document.getElementById('status').textContent;
      return t !== prev && t.startsWith('Collected');
    }, statusBeforeGold, { timeout: 10000 });
    const countAfterGold = await chimeCount(frame);
    if (countAfterGold !== 2) throw new Error('Expected exactly 2 chimes after also mining gold, got: ' + countAfterGold);
    console.log('PASS: mining gold fired a second chime (total 2)');

    console.log('STEP 4: turning the Settings -> Sound toggle OFF suppresses further chimes, even on a real gain');
    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => document.getElementById('walletPanel').classList.contains('open'), { timeout: 5000 });
    await frame.locator('#settingsTabBtn').click();
    await frame.waitForFunction(() => document.getElementById('settingsScreen').classList.contains('active'), { timeout: 5000 });
    // Sound is inside a collapsed settings-category — open it before
    // interacting with the checkbox inside, same as the checkbox itself
    // requiring its category to be open to even be visible/checkable.
    const soundCategory = frame.locator('.settings-category[data-category="sound"]');
    if (!(await soundCategory.evaluate((el) => el.classList.contains('open')))) {
      await soundCategory.locator('.settings-category-toggle').click();
    }
    await frame.locator('#walletSoundEnabledInput').uncheck();
    await frame.locator('#backFromSettingsBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => !document.getElementById('walletPanel').classList.contains('open'), { timeout: 5000 });

    const statusBeforeSilver = await frame.locator('#status').textContent();
    await frame.locator('#scene').click({ position: { x: silverStall.sx, y: silverStall.sy } });
    await frame.waitForFunction((prev) => {
      const t = document.getElementById('status').textContent;
      return t !== prev && t.startsWith('Collected');
    }, statusBeforeSilver, { timeout: 10000 });
    const countAfterSilverMuted = await chimeCount(frame);
    if (countAfterSilverMuted !== 2) throw new Error('Expected the chime count to stay at 2 with sound OFF (a real gain still happened, mining silver), got: ' + countAfterSilverMuted);
    // Confirm this was genuinely a real gain that just didn't chime, not a
    // no-op silver stall — otherwise this step would trivially "pass" for
    // the wrong reason.
    const hasSilver = await frame.evaluate(async () => {
      const identity = await AtlasWallet.getIdentity();
      const wallet = await AtlasWallet.getWallet(identity.publicKey);
      return wallet.some((e) => e.credential.asset.class === 'atlas.element.silver');
    });
    if (!hasSilver) throw new Error('Expected silver to have actually been minted (the setting should silence the chime, not the mint itself)');
    console.log('PASS: sound OFF suppressed the chime for a real gain (silver did mint, count correctly stayed at 2)');

    console.log('STEP 5: turning it back ON, a further gain chimes again');
    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => document.getElementById('walletPanel').classList.contains('open'), { timeout: 5000 });
    await frame.locator('#settingsTabBtn').click();
    await frame.waitForFunction(() => document.getElementById('settingsScreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('#walletSoundEnabledInput').check();
    await frame.locator('#backFromSettingsBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => !document.getElementById('walletPanel').classList.contains('open'), { timeout: 5000 });

    const [, , , membershipDesk] = await projectInteractables(frame);
    const statusBeforeMembership = await frame.locator('#status').textContent();
    await frame.locator('#scene').click({ position: { x: membershipDesk.sx, y: membershipDesk.sy } });
    await frame.waitForFunction((prev) => {
      const t = document.getElementById('status').textContent;
      return t !== prev && t.startsWith('Collected');
    }, statusBeforeMembership, { timeout: 10000 });
    const countAfterMembership = await chimeCount(frame);
    if (countAfterMembership !== 3) throw new Error('Expected the chime count to reach 3 after re-enabling sound and joining the Trading Station, got: ' + countAfterMembership);
    console.log('PASS: re-enabling sound let the next real gain chime again (total 3)');

    console.log('\nALL WALLET GAIN CHIME CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
