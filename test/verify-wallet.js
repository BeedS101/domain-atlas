// Verifies the real wallet built on top of the v1.0 demo: a genuine
// software-keypair identity protected by a password (created through the
// onboarding flow), a real ECDSA-signed item issued by demo-domain-a's
// issuer server, real client-side signature verification, the same
// verification succeeding again after crossing to demo-domain-b (a domain
// that has never talked to the issuer), a real revocation actually being
// respected, and a real wallet export.

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');

function shot(name) {
  return path.resolve(__dirname, name);
}

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

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-wallet');
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

    console.log('STEP 1: visiting http://localhost:8001 (Example Plaza, real issuer on this port)');
    await page.goto('http://localhost:8001', { waitUntil: 'load' });

    const btn = page.locator('#domain-atlas-enter-btn');
    await btn.waitFor({ state: 'visible', timeout: 10000 });
    await btn.click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    console.log('PASS: viewer rendered Plaza world');
    await page.screenshot({ path: shot('wallet-01-plaza.png') });

    console.log('STEP 2: setting up a password-protected identity through onboarding');
    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => document.getElementById('walletPanel').classList.contains('open'), { timeout: 5000 });
    await frame.waitForFunction(() => document.getElementById('onboardingChoiceScreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('#chooseNewBtn').click();
    await frame.waitForFunction(() => document.getElementById('createScreen').classList.contains('active'), { timeout: 5000 });
    const TEST_PASSWORD = 'correct-horse-battery-staple-1';
    await frame.locator('#newPasswordInput').fill(TEST_PASSWORD);
    await frame.locator('#newPasswordConfirmInput').fill(TEST_PASSWORD);
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
    const seedPhrase = (await frame.locator('#seedPhraseText').textContent()).trim();
    if (seedPhrase.split(/\s+/).length !== 16) throw new Error('Expected a 16-word seed phrase, got: ' + seedPhrase);
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    const identityLabel = await frame.locator('#walletIdentity').textContent();
    console.log('PASS: identity created, seed phrase captured, main wallet screen active ->', identityLabel);

    console.log('STEP 3: requesting an item from this world\'s real issuer');
    const requestBtn = frame.locator('#requestItemBtn');
    await frame.waitForFunction(() => !document.getElementById('requestItemBtn').disabled, { timeout: 5000 });
    await requestBtn.click();
    await frame.waitForFunction(
      () => document.querySelectorAll('#selfCollectiblesList .wallet-item').length > 0,
      { timeout: 15000 }
    );
    const walletText = await frame.locator('#selfCollectiblesList').textContent();
    console.log('PASS: item issued and stored in wallet ->', walletText.replace(/\s+/g, ' ').trim());
    if (!walletText.includes('✓')) throw new Error('Expected the freshly issued item to verify as valid');
    if (!walletText.includes('Bronze Compass')) throw new Error('Expected the Bronze Compass item');
    // asset.properties (SPEC.md §5.1) — an open, per-item bag the issuer's
    // catalog attaches at mint time; the Bronze Compass ships with an
    // atlas.* key and a reverse-domain custom key, both should render.
    if (!walletText.includes('atlas.rarity: common')) throw new Error('Expected the atlas.rarity property to render');
    if (!walletText.includes('com.example.era: Victorian')) throw new Error('Expected the com.example.era property to render');
    console.log('PASS: item properties (atlas.rarity, com.example.era) rendered on the card');
    await page.screenshot({ path: shot('wallet-02-item-issued.png') });

    console.log('STEP 4: presenting identity (fresh raw-ECDSA signature, verified client-side)');
    // Task #73 moved Present identity into the Identity accordion, closed
    // by default (it used to sit in Inventory, open by default) — open it
    // first, same as a real user would need to.
    const identityCategoryOpen = await frame.locator('.settings-category[data-category="identity"]').evaluate((el) => el.classList.contains('open'));
    if (!identityCategoryOpen) await frame.locator('.settings-category[data-category="identity"] .settings-category-toggle').click();
    await frame.locator('#presentBtn').click();
    await frame.waitForFunction(
      () => document.getElementById('presentBtn').textContent.includes('verified'),
      { timeout: 15000 }
    );
    console.log('PASS: presentation signature verified client-side, no relying-party server involved');

    console.log('STEP 5: crossing the DOMAIN portal to localhost:8002 (a domain the issuer has never talked to)');
    let portals = await projectPortals(frame);
    const toNeighbor = portals.find((p) => p.kind === 'domain');
    await frame.locator('#scene').click({ position: { x: toNeighbor.sx, y: toNeighbor.sy } });
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Neighbor Workshop'), { timeout: 10000 });
    console.log('PASS: now on localhost:8002 · Neighbor Workshop, wallet state carried over unchanged');

    console.log('STEP 6: re-verifying the wallet from here — same item, issuer never contacted by this domain');
    await frame.locator('#reverifyBtn').click();
    await frame.waitForFunction(() => document.getElementById('reverifyBtn').disabled === true, { timeout: 5000 }).catch(() => {});
    await frame.waitForFunction(() => document.getElementById('reverifyBtn').disabled === false, { timeout: 15000 });
    const walletTextAfterCross = await frame.locator('#selfCollectiblesList').textContent();
    if (!walletTextAfterCross.includes('✓')) throw new Error('Item should still verify as valid from a different domain');
    // properties live inside `asset`, covered by the same signature as
    // name/class/model — if they'd been tampered with or dropped in
    // transit, this cross-domain re-verify (a fresh signature check with
    // no help from the issuer) is exactly what would catch it.
    if (!walletTextAfterCross.includes('atlas.rarity: common')) throw new Error('Properties should survive cross-domain re-verification');
    console.log('PASS: item independently re-verified valid (properties intact) while standing on a domain that never issued it');
    await page.screenshot({ path: shot('wallet-03-reverified-cross-domain.png') });

    console.log('STEP 7: exporting the wallet (atlas-wallet-export/1.0) — lives under Settings now');
    await frame.locator('#settingsTabBtn').click();
    await frame.waitForFunction(() => document.getElementById('settingsScreen').classList.contains('active'), { timeout: 5000 });
    // Settings categories are collapsed by default — open "Wallet backup" before using its export button.
    await frame.locator('.settings-category[data-category="wallet-backup"] .settings-category-toggle').click();
    await frame.waitForFunction(() => document.querySelector('.settings-category[data-category="wallet-backup"]').classList.contains('open'), { timeout: 5000 });
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 10000 }),
      frame.locator('#exportBtn').click()
    ]);
    const exportPath = shot('atlas-wallet-export.json');
    await download.saveAs(exportPath);
    const exported = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
    if (exported.format !== 'atlas-wallet-export/1.0') throw new Error('Wrong export format tag');
    if (!exported.credentials || exported.credentials.length !== 1) throw new Error('Expected exactly one exported credential');
    console.log('PASS: exported wallet has the right shape ->', exported.format, '·', exported.credentials.length, 'credential(s)');
    await frame.locator('#backFromSettingsBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });

    console.log('STEP 8: revoking the item at the issuer, then re-verifying — should now fail');
    const issuedId = exported.credentials[0].id;
    const revokeRes = await page.evaluate(async (id) => {
      const r = await fetch('http://localhost:8001/atlas/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, reason: 'issuer-request' })
      });
      return r.ok;
    }, issuedId);
    if (!revokeRes) throw new Error('Revoke call failed');

    await frame.locator('#reverifyBtn').click();
    await frame.waitForFunction(() => document.getElementById('reverifyBtn').disabled === true, { timeout: 5000 }).catch(() => {});
    await frame.waitForFunction(() => document.getElementById('reverifyBtn').disabled === false, { timeout: 15000 });
    const walletTextAfterRevoke = await frame.locator('#selfCollectiblesList').textContent();
    if (!walletTextAfterRevoke.includes('✗')) throw new Error('Revoked item should now show as invalid');
    if (!walletTextAfterRevoke.toLowerCase().includes('revoked')) throw new Error('Reason should mention revocation');
    console.log('PASS: revoked item now correctly shows as invalid, reason mentions revocation');
    await page.screenshot({ path: shot('wallet-04-revoked.png') });

    console.log('\nALL WALLET CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
