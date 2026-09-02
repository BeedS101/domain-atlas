// Manual end-to-end check for a real regression found live after task #44's
// item/resource -> unified asset merge: a device that used this extension
// BEFORE the merge still has pre-merge data sitting in chrome.storage.local,
// because the new unified wallet.js reuses the exact storage key the former
// ITEM-only wallet used (`atlasWallets`), and separately leaves an entirely
// orphaned `atlasResourceWallets` key nothing reads anymore. Neither a
// pre-merge item nor a pre-merge resource credential can be validly carried
// forward into the new domain-atlas-asset/1.0 shape (different signed
// payload entirely, see wallet.js's own note above getWallet()) — but left
// in place, they caused two real symptoms a live user hit: old holdings
// silently vanished from the Inventory view (the unified card renderer
// assumes fields — asset.fungible, quantity — pre-merge credentials never
// had), while the "already collected this class" courtesy check kept
// blocking a FRESH request for the same class (it only ever read
// credential.asset.class, a field pre-merge ITEMS happened to already
// have, so it still matched on the now-unrenderable stale entry).
//
// Fixed by having getWallet() itself purge anything that isn't a real
// domain-atlas-asset/1.0 credential on read, and drop the orphaned
// atlasResourceWallets key — self-correcting the moment a pre-merge wallet
// is touched, no manual reset needed.
//
// Checks:
//   1. Seed chrome.storage.local directly with pre-merge-shaped item and
//      resource entries under a real identity's own public key — simulating
//      a device that used this extension before task #44, without needing
//      an actual pre-merge build to reproduce against.
//   2. Opening the wallet does NOT show either stale entry (nothing broken
//      rendered) — confirms the purge, not just a lucky silent failure.
//   3. The "Request <class> from this world" button is ENABLED, not stuck
//      on "Already collected" — this was the actual complaint: a real
//      holding that no longer displays should not still block a fresh one.
//   4. The orphaned atlasResourceWallets key is gone after the wallet was
//      touched once.
//   5. Requesting fresh actually works now — a real domain-atlas-asset/1.0
//      Bronze Compass gets issued and held.
//   6. As requested alongside the fix: exercise the reissue/update-check
//      pipeline (SPEC.md §5.1.1, task #37/#44) on this SAME freshly-minted
//      item, end to end — same mechanism manual-asset-update-check.js
//      already covers, run once more here so the "did the self-correct
//      work AND can I still get updates" story is proven in one pass.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { chromium } = require('playwright');
const path = require('path');
const http = require('http');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');

function postJson(port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: 'localhost', port, path: urlPath, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let chunks = '';
        res.on('data', (c) => { chunks += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(chunks)); } catch (err) { reject(err); }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-legacy-wallet-migration');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  });

  try {
    const page = await context.newPage();

    console.log('SETUP: fresh identity, no assets requested yet');
    await page.goto('http://localhost:8001', { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    await frame.locator('#walletBtn').click();
    await frame.locator('#chooseNewBtn').click();
    await frame.locator('#newPasswordInput').fill('legacy-migration-test-password');
    await frame.locator('#newPasswordConfirmInput').fill('legacy-migration-test-password');
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    const identity = await frame.evaluate(() => AtlasWallet.getIdentity());
    console.log('PASS: identity ready ->', identity.publicKey.slice(0, 16) + '…');

    console.log('STEP 1: seeding chrome.storage.local with pre-merge-shaped item + resource entries — simulating a device that used this extension before task #44');
    await frame.evaluate((ownerPublicKey) => {
      const legacyItem = {
        credential: {
          credential: 'domain-atlas-item/1.0', // pre-merge type string — no quantity/fungible/presentation
          id: 'urn:atlas:item:legacy-pre-merge-0001',
          issuer: { domain: 'localhost:8001', publicKey: 'legacy-issuer-key' },
          asset: { name: 'Old Bronze Compass', class: 'atlas.wearable', model: 'https://localhost:8001/assets/compass.glb', properties: { 'atlas.rarity': 'common' } },
          owner: { publicKey: ownerPublicKey },
          issuedAt: '2026-01-01T00:00:00Z',
          signature: 'not-a-real-signature-pre-merge-format'
        },
        lastVerdict: { valid: true, reason: 'signature verified against issuer key; not revoked' }
      };
      const legacyResource = {
        credential: {
          credential: 'domain-atlas-resource/1.0', // pre-merge type — flat shape, no asset wrapper at all
          id: 'urn:atlas:resource:legacy-pre-merge-0002',
          issuer: { domain: 'localhost:8001', publicKey: 'legacy-issuer-key' },
          class: 'atlas.element.iron',
          quantity: 47,
          owner: { publicKey: ownerPublicKey },
          supersedes: null,
          issuedAt: '2026-01-01T00:00:00Z',
          signature: 'not-a-real-signature-pre-merge-format'
        },
        lastVerdict: { valid: true, reason: 'signature verified against issuer key; not revoked' }
      };
      return chrome.storage.local.set({
        atlasWallets: { [ownerPublicKey]: [legacyItem] },
        atlasResourceWallets: { [ownerPublicKey]: [legacyResource] }
      });
    }, identity.publicKey);
    console.log('PASS: seeded one legacy item (under the reused atlasWallets key) and one legacy resource (under the orphaned atlasResourceWallets key)');

    console.log('STEP 2: opening the wallet does not render either stale entry');
    await frame.locator('#settingsTabBtn').click();
    await frame.waitForFunction(() => document.getElementById('settingsScreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('#walletTabBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    const cardCount = await frame.evaluate(() => document.querySelectorAll('#selfCollectiblesList .wallet-item').length);
    if (cardCount !== 0) throw new Error('Expected 0 cards rendered (both seeded entries are pre-merge and unrenderable), got: ' + cardCount);
    console.log('PASS: neither stale entry rendered — no broken cards, nothing silently half-shown');

    console.log('STEP 3: "Request item" is enabled, not stuck on "Already collected" because of the now-invisible legacy item');
    await frame.waitForFunction(() => !document.getElementById('requestItemBtn').disabled, { timeout: 5000 });
    const btnText = await frame.locator('#requestItemBtn').textContent();
    if (!btnText.includes('Request')) throw new Error('Expected the button to read "Request …", got: ' + btnText);
    console.log('PASS: request button reads "' + btnText.trim() + '" — the stale legacy item is no longer blocking a fresh request');

    console.log('STEP 4: the orphaned atlasResourceWallets key is gone after the wallet was touched');
    const stillHasOrphanKey = await frame.evaluate(async () => {
      const { atlasResourceWallets } = await chrome.storage.local.get('atlasResourceWallets');
      return atlasResourceWallets !== undefined;
    });
    if (stillHasOrphanKey) throw new Error('Expected atlasResourceWallets to have been removed by getWallet()\'s cleanup');
    console.log('PASS: atlasResourceWallets cleaned up, nothing orphaned left behind');

    console.log('STEP 5: requesting fresh now actually works — a real domain-atlas-asset/1.0 credential gets issued and held');
    await frame.locator('#requestItemBtn').click();
    await frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item').length === 1, { timeout: 15000 });
    const held1 = await frame.evaluate(async () => {
      const wallet = await AtlasWallet.getWallet((await AtlasWallet.getIdentity()).publicKey);
      return wallet[0].credential;
    });
    if (held1.credential !== 'domain-atlas-asset/1.0') throw new Error('Expected a real domain-atlas-asset/1.0 credential, got: ' + held1.credential);
    if (held1.asset.class !== 'atlas.wearable') throw new Error('Expected the Plaza default item (atlas.wearable), got: ' + held1.asset.class);
    console.log('PASS: freshly issued and held ->', held1.id, '(', held1.credential, ')');

    console.log('STEP 6: exercising the update/reissue pipeline on this same freshly-minted item, end to end (as requested alongside the self-correct fix)');
    const reissue = await postJson(8001, '/atlas/asset/reissue', {
      credential: held1,
      properties: { 'com.example.condition': 'freshly re-collected' }
    });
    if (!reissue.newCredential || reissue.newCredential.supersedes !== held1.id) {
      throw new Error('Expected a new credential whose supersedes names the old id, got: ' + JSON.stringify(reissue));
    }
    console.log('  issuer signed a replacement ->', reissue.newCredential.id, 'supersedes', held1.id);
    await frame.locator('#socialTabBtn').click();
    await frame.waitForFunction(() => document.getElementById('mailSubscreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('#checkMailNowBtn').click();
    await frame.waitForFunction((oldId) => {
      const cards = Array.from(document.querySelectorAll('#selfCollectiblesList .wallet-item'));
      const ids = cards.map((c) => { const btn = c.querySelector('[data-action="hide"]'); return btn && btn.dataset.id; });
      return cards.length === 1 && !ids.includes(oldId);
    }, held1.id, { timeout: 10000 });
    const held2 = await frame.evaluate(async () => {
      const wallet = await AtlasWallet.getWallet((await AtlasWallet.getIdentity()).publicKey);
      return wallet[0].credential;
    });
    if (held2.id !== reissue.newCredential.id) throw new Error('Expected the wallet to hold the reissued id after Check now, got: ' + held2.id);
    if (held2.asset.properties['com.example.condition'] !== 'freshly re-collected') throw new Error('Expected the adopted item to carry the updated property');
    console.log('PASS: "Check now" adopted the update — wallet now holds the reissued replacement with the new property, still exactly one asset');

    console.log('\nALL LEGACY-WALLET SELF-CORRECT + UPDATE CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
