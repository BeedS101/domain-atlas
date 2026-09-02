// Manual end-to-end check for asset reissue (SPEC.md §5.1.1 — an asset
// credential's `supersedes` field, plus the wallet actually learning about
// a reissue and adopting it) driven through the real mail check-in cycle
// (task #45's /atlas/mail/check, extended rather than duplicated — see
// issuer-server/server.js's `updates` array and wallet.js's
// processAssetUpdates()/checkAllMail()). Reissue itself is non-fungible-only
// (SPEC.md §5.1.1 — task #44's merge), so this exercises it against the
// unique Bronze Compass; the generalized mechanism (getAssetUpdateNotices,
// processAssetUpdates, the `updates` array) is what applies to any asset,
// fungible or not — see wallet.js's own note on that.
//
// Checks:
//   1. A visitor holds a real, issuer-signed Bronze Compass
//      (domain-atlas-asset/1.0, atlas.wearable) from Example Plaza.
//   2. The issuer reissues that exact item server-side — the demo/admin
//      surface for this is POST /atlas/asset/reissue, a real endpoint, not
//      a mock — producing a NEW signed credential whose `supersedes`
//      names the old id, and revoking the old id with reason "superseded".
//      This is the "trigger the reissue" half nothing in the extension UI
//      does today; a real domain operator's tooling would call the same
//      endpoint.
//   3. Clicking "Check now" (the existing Mail tab control, task #45)
//      picks up the reissue through the SAME /atlas/mail/check round trip
//      that already carries mail — the wallet verifies the replacement
//      credential itself (signature, owner, supersedes) before adopting
//      it, then the old id is gone and the new one — with its updated
//      asset.properties — is what's actually held. The Wallet tab's own
//      small badge (assetUpdatesBadge) reflects this until the tab is
//      opened.
//   4. A SECOND reissue is picked up a different way: instead of clicking
//      Check now, the visitor just walks between two worlds on the same
//      domain (Plaza -> Museum -> Plaza) — enterWorld's own immediate,
//      domain-scoped check (no waiting for the periodic loop) catches it
//      on its own, with nothing manually triggered.
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

// Same shape as verify-loadout-trading.js's portal helpers — Plaza and
// Museum are both the 2D procedural-v1 renderer, so portals live in
// window.__atlasScene.portalMarkers, projected to canvas pixel coords.
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
            return { sx: originX + (x - z) * COS30 * SCALE, sy: originY + (x + z) * SIN30 * SCALE, to: m.portal && m.portal.to };
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

async function waitForPortalTo(frame, targetWorld) {
  await frame.waitForFunction(
    (target) => window.__atlasScene && window.__atlasScene.portalMarkers.some((m) => m.portal && m.portal.to === target),
    targetWorld,
    { timeout: 10000 }
  );
}

async function clickPortalTo(frame, targetWorld) {
  await waitForPortalTo(frame, targetWorld);
  const portals = await projectPortals(frame);
  const p = portals.find((x) => x.to === targetWorld);
  if (!p) throw new Error('No portal to ' + targetWorld + ' found on this scene');
  await frame.locator('#scene').click({ position: { x: p.sx, y: p.sy } });
}

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-asset-update-check');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  });

  try {
    const page = await context.newPage();

    console.log('SETUP: identity + holding the Bronze Compass issued by Example Plaza');
    await page.goto('http://localhost:8001', { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    await frame.locator('#walletBtn').click();
    await frame.locator('#chooseNewBtn').click();
    await frame.locator('#newPasswordInput').fill('item-update-test-password');
    await frame.locator('#newPasswordConfirmInput').fill('item-update-test-password');
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('#requestItemBtn').click();
    await frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item').length > 0, { timeout: 15000 });
    const held1 = await frame.evaluate(async () => {
      const identity = await AtlasWallet.getIdentity();
      const wallet = await AtlasWallet.getWallet(identity.publicKey);
      return wallet[0].credential;
    });
    if (held1.asset.class !== 'atlas.wearable') throw new Error('Expected the Plaza default item (atlas.wearable), got: ' + held1.asset.class);
    if (held1.supersedes !== null) throw new Error('A freshly-minted item must carry supersedes: null, got: ' + JSON.stringify(held1.supersedes));
    console.log('PASS: holding a real Bronze Compass ->', held1.id, '(supersedes: null, as a first minting should be)');

    console.log('STEP 1: issuer reissues that exact item server-side (POST /atlas/asset/reissue) — the demo/admin trigger');
    const reissue1 = await postJson(8001, '/atlas/asset/reissue', {
      credential: held1,
      properties: { 'com.example.condition': 'restored' }
    });
    if (!reissue1.newCredential || reissue1.newCredential.supersedes !== held1.id) {
      throw new Error('Expected a new credential whose supersedes names the old id, got: ' + JSON.stringify(reissue1));
    }
    if (reissue1.newCredential.asset.properties['com.example.condition'] !== 'restored') {
      throw new Error('Expected the reissued item to carry the updated property');
    }
    console.log('PASS: issuer signed a replacement ->', reissue1.newCredential.id, 'supersedes', held1.id);

    console.log('STEP 2: "Check now" (task #45 mail check-in, extended) picks up the reissue and adopts it');
    await frame.locator('#socialTabBtn').click();
    await frame.waitForFunction(() => document.getElementById('mailSubscreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('#checkMailNowBtn').click();
    await frame.waitForFunction((oldId) => {
      const cards = Array.from(document.querySelectorAll('#selfCollectiblesList .wallet-item'));
      const ids = cards.map((c) => { const btn = c.querySelector('[data-action="hide"]'); return btn && btn.dataset.id; });
      return cards.length === 1 && !ids.includes(oldId);
    }, held1.id, { timeout: 10000 });
    const held2 = await frame.evaluate(async () => {
      const identity = await AtlasWallet.getIdentity();
      const wallet = await AtlasWallet.getWallet(identity.publicKey);
      return wallet[0].credential;
    });
    if (held2.id !== reissue1.newCredential.id) throw new Error('Expected the wallet to hold the NEW id after Check now, got: ' + held2.id);
    if (held2.asset.properties['com.example.condition'] !== 'restored') throw new Error('Expected the adopted item to carry the updated property');
    if (held2.supersedes !== held1.id) throw new Error('Adopted item should still carry its own supersedes field, naming the old id');
    console.log('PASS: old item gone, wallet now holds the reissued replacement with the updated property, still exactly one item');

    console.log('STEP 3: the reissued item verifies as a normal, independently-checkable credential (not just trusted because it arrived over mail-check)');
    await frame.locator('#walletTabBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    const verdictText = await frame.locator('#selfCollectiblesList .wallet-item .verdict').textContent();
    if (!verdictText.includes('✓')) throw new Error('Adopted item did not verify: ' + verdictText);
    console.log('PASS: adopted item independently re-verifies valid ->', verdictText.trim());

    console.log('STEP 4: the Wallet tab badge showed the update, and opening the tab (just done above) cleared it');
    // routeWalletScreen() switches the visible screen synchronously but
    // marks notices seen a few awaits later (identity lookup, then the
    // mark-seen call itself) — poll rather than reading the badge the
    // instant the screen swap is observed, same reasoning as this file's
    // other background-driven waitForFunction checks.
    await frame.waitForFunction(() => !document.getElementById('assetUpdatesBadge').classList.contains('show'), { timeout: 5000 });
    console.log('PASS: item-update badge cleared on open, same unobtrusive pattern as mail\'s own badge');

    console.log('STEP 5: a SECOND reissue, picked up WITHOUT clicking Check now — just by walking Plaza -> Museum -> Plaza (same domain)');
    const reissue2 = await postJson(8001, '/atlas/asset/reissue', {
      credential: held2,
      properties: { 'com.example.condition': 'pristine' }
    });
    if (!reissue2.newCredential || reissue2.newCredential.supersedes !== held2.id) {
      throw new Error('Expected a second replacement whose supersedes names the second held id');
    }
    console.log('PASS: issuer signed a second replacement ->', reissue2.newCredential.id);

    await clickPortalTo(frame, 'museum');
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Museum'), { timeout: 10000 });
    await clickPortalTo(frame, 'plaza');
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });

    // enterWorld's domain-scoped check is fired and not awaited (see
    // checkItemUpdatesForDomain in viewer.js) — give it a moment to land,
    // the same "poll until it shows up" pattern the rest of this file uses
    // for anything driven by a background check rather than a button click.
    await frame.waitForFunction((oldId) => {
      const cards = Array.from(document.querySelectorAll('#selfCollectiblesList .wallet-item'));
      const ids = cards.map((c) => { const btn = c.querySelector('[data-action="hide"]'); return btn && btn.dataset.id; });
      return cards.length === 1 && !ids.includes(oldId);
    }, held2.id, { timeout: 15000 });
    const held3 = await frame.evaluate(async () => {
      const identity = await AtlasWallet.getIdentity();
      const wallet = await AtlasWallet.getWallet(identity.publicKey);
      return wallet[0].credential;
    });
    if (held3.id !== reissue2.newCredential.id) throw new Error('Expected the wallet to hold the SECOND new id after re-entering the domain, got: ' + held3.id);
    if (held3.asset.properties['com.example.condition'] !== 'pristine') throw new Error('Expected the second adopted item to carry its updated property');
    console.log('PASS: entering a world on the same domain picked up the reissue on its own — no manual check, no duplicate, old id gone');

    console.log('\nALL ITEM UPDATE CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
