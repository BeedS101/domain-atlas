// Wallet > Identity "Copy public key", and Wallet > Activity log: clicking a mint or pick-up entry opens the Inventory on
// that item. Runs the real extension against the demo issuer on localhost:8001.
//
// Start it first: PORT=8001 ATLAS_DOMAIN=localhost:8001 ATLAS_DOCROOT=demo-domain-a ATLAS_STATE_DIR=<dir> ATLAS_MINT_LIMITS=off node issuer-server/server.js
// Run: xvfb-run -a node test/manual-wallet-identity-activity.js
'use strict';
const L = require('./call-e2e-lib');
const { check } = L;

(async () => {
  const w = await L.launchWallet('identity-activity');
  try {
    const created = await w.wallet((pw) => AtlasWallet.createIdentity(pw), 'identity-activity-password');
    const page = await w.context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('chrome-extension://' + w.extId + '/viewer.html');
    await page.waitForFunction(() => typeof routeWalletScreen === 'function' && typeof AtlasWallet !== 'undefined', null, { timeout: 15000 });
    await page.evaluate(() => routeWalletScreen());
    await page.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), null, { timeout: 10000 });

    console.log('--- copy public key ---');
    await page.evaluate(() => { window.__copied = null; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { window.__copied = t; } }, configurable: true }); });
    await page.evaluate(() => { const c = [...document.querySelectorAll('#mainWalletScreen .settings-category')].find((x) => /Identity/.test(x.querySelector('.settings-category-toggle').textContent)); c.classList.add('open'); });
    if (process.env.SHOT_DIR) await page.screenshot({ path: process.env.SHOT_DIR + '/identity.png' });
    await page.click('#copyIdentityKeyBtn');
    await page.waitForFunction(() => window.__copied !== null, null, { timeout: 5000 });
    check('the button copies the full public key', (await page.evaluate(() => window.__copied)) === created.publicKey);
    check('and says so', /copied/i.test(await page.textContent('#copyIdentityKeyStatus')));

    console.log('--- activity log: a mint opens the item ---');
    const minted = await page.evaluate(async () => (await AtlasWallet.mintAsset('self', 'localhost:8001', 'atlas.element.iron', 1)).credential);
    await page.evaluate(() => refreshInventoryDisplay());
    const log = await page.evaluate(() => AtlasWallet.getActivityLog());
    const entry = log.find((e) => /^Minted/.test(e.text));
    check('the mint entry records the item', entry && entry.meta && entry.meta.assetClass === 'atlas.element.iron' && entry.meta.domain === minted.issuer.domain, entry);
    await page.evaluate(() => { const c = [...document.querySelectorAll('#mainWalletScreen .settings-category')].find((x) => /Activity log/.test(x.querySelector('.settings-category-toggle').textContent)); c.classList.add('open'); });
    await page.evaluate(() => showInventorySubtab('documentsSubscreen'));
    await page.click('#activityLogList .activity-link');
    await page.waitForSelector('.wallet-item.jump-flash', { timeout: 5000 });
    const opened = await page.evaluate(() => {
      const sub = document.querySelector('#collectiblesSubscreen.active, #documentsSubscreen.active');
      const card = sub && sub.querySelector('.wallet-item.jump-flash');
      return { sub: sub && sub.id, card: !!card, text: card ? card.textContent : '' };
    });
    if (process.env.SHOT_DIR) await page.screenshot({ path: process.env.SHOT_DIR + '/activity-jump.png' });
    check('the matching inventory card is shown and highlighted', opened.card && /iron/i.test(opened.text), opened);

    console.log('--- other entries and old entries ---');
    const refs = await page.evaluate(() => ({
      identity: activityAssetRef({ type: 'identity', text: 'Identity created' }),
      old: activityAssetRef({ type: 'asset', text: 'Minted 5 atlas.element.iron from localhost:8001' }),
      oldPick: activityAssetRef({ type: 'asset', text: 'Picked up atlas.wearable in localhost:8001' }),
      split: activityAssetRef({ type: 'asset', text: 'Split atlas.element.iron' })
    }));
    check('only mint and pick-up entries are links', refs.identity === null && refs.split === null && refs.old && refs.old.assetClass === 'atlas.element.iron' && refs.oldPick && refs.oldPick.assetClass === 'atlas.wearable', refs);
    const gone = await page.evaluate(async () => {
      const note = document.createElement('div');
      await showAssetInInventory({ id: 'urn:none', assetClass: 'atlas.not.held', domain: null }, note);
      return note.textContent;
    });
    check('an item that is no longer held says so', /No longer in your inventory/.test(gone), gone);
    check('the page raised no errors', errors.length === 0, errors);
  } finally {
    await w.close();
  }
  process.exit(L.finish('manual-wallet-identity-activity'));
})().catch((e) => { console.error('FAILURE:', e); process.exit(1); });
