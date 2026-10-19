// The simulated counterparty identity is gone: no API, no UI, no role other than "self", and a record left
// in storage by an older build stays untouched. Disposable Chromium profile and throw-away issuer only.
//
//   xvfb-run -a node test/manual-counterparty-retired.js
'use strict';
const fs = require('fs');
const path = require('path');
const { Wallet, PASSWORD } = require('./lib/wallet-profile');
const issuers = require('./lib/gen1-issuers');

let passes = 0, failures = 0;
const check = (name, ok, detail) => { if (ok) { passes++; console.log('PASS ' + name); } else { failures++; console.log('FAIL ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 600) : '')); } };

async function main() {
  const ext = path.resolve(__dirname, '..', 'extension');
  const html = fs.readFileSync(path.join(ext, 'viewer.html'), 'utf8');
  const viewer = fs.readFileSync(path.join(ext, 'viewer.js'), 'utf8');
  const wallet = fs.readFileSync(path.join(ext, 'wallet.js'), 'latin1');

  console.log('\n=== static: no counterparty controls or code remain ===');
  for (const id of ['createCounterpartyBtn', 'counterpartyIdentity', 'counterpartyCollectiblesList', 'counterpartyDocumentsList']) {
    check('viewer.html has no #' + id, !html.includes(id));
  }
  for (const name of ['getCounterparty', 'createCounterparty', 'loseItemToCounterparty', 'Simulate PvP loss', 'data-action="split"']) {
    check('viewer.js has no ' + name, !viewer.includes(name));
  }
  for (const name of ['getCounterparty', 'createCounterparty', 'saveCounterparty', 'signWithCounterparty', 'loseItemToCounterparty']) {
    check('wallet.js has no ' + name, !wallet.includes(name));
  }

  const port = 25000 + (process.pid % 500);
  const be = await issuers.startNode(port, {});
  const domain = 'localhost:' + port;
  const w = await new Wallet('retired').launch();
  try {
    await w.create();
    console.log('\n=== runtime: API surface and role handling ===');
    const api = await w.W(() => ['createCounterparty', 'getCounterparty', 'loseItemToCounterparty', 'auditLegacyCounterparty'].map((n) => typeof AtlasWallet[n]));
    check('the counterparty functions are not exported', api.every((t) => t === 'undefined'), api);

    const snapshot = () => w.W(async () => JSON.stringify(await chrome.storage.local.get(null)));
    const before = await snapshot();
    const refusals = await w.W(async (d) => {
      const out = {};
      out.mint = await AtlasWallet.mintAsset('counterparty', d, 'atlas.element.iron', 10).then(() => 'ok', (e) => e.message);
      out.intent = await AtlasWallet.proposeIntent('counterparty', { class: 'atlas.element.iron', quantity: 1 }, { class: 'atlas.element.gold', quantity: 1 }).then(() => 'ok', (e) => e.message);
      return out;
    }, domain);
    check('any role other than "self" is refused', /Unknown identity role/.test(refusals.mint) && /Unknown identity role/.test(refusals.intent), refusals);
    check('a refused call writes nothing', (await snapshot()) === before);

    console.log('\n=== runtime: normal operations with the main identity ===');
    const ops = await w.W(async (d) => {
      const out = {};
      out.mint = await AtlasWallet.mintAsset('self', d, 'atlas.element.iron', 20).then(() => 'ok', (e) => e.message);
      out.mint2 = await AtlasWallet.mintAsset('self', d, 'atlas.element.iron', 20).then(() => 'ok', (e) => e.message);
      const me = await AtlasWallet.getIdentity();
      out.held = (await AtlasWallet.getWallet(me.publicKey)).map((e) => e.credential.asset.class + ':' + e.credential.quantity);
      return out;
    }, domain);
    check('self mints and consolidates to one 40 g balance', ops.mint === 'ok' && ops.mint2 === 'ok' && ops.held.length === 1 && ops.held[0] === 'atlas.element.iron:40', ops);

    console.log('\n=== runtime: a record left by an older build stays inert ===');
    const legacy = { publicKey: 'legacy-public-key', privateKeyJwk: { kty: 'EC', crv: 'P-256', d: 'legacy-private', x: 'x', y: 'y' }, createdAt: '2026-01-01T00:00:00.000Z' };
    await w.W((v) => chrome.storage.local.set({ atlasCounterparty: v }), legacy);
    const record = () => w.W(() => chrome.storage.local.get('atlasCounterparty').then((r) => JSON.stringify(r.atlasCounterparty)));
    const recordBefore = await record();
    const after = await w.W(async ({ d, pw, seed }) => {
      const out = {};
      await AtlasWallet.mintAsset('self', d, 'atlas.element.gold', 10);
      await AtlasWallet.reverifyAll();
      const me = await AtlasWallet.getIdentity();
      const file = await AtlasWallet.exportFullBackup(pw, seed).then((f) => f, (e) => ({ error: e.message }));
      out.exportError = file && file.error;
      out.exportedText = JSON.stringify(file || '');
      out.held = (await AtlasWallet.getWallet(me.publicKey)).map((e) => e.credential.asset.class + ':' + e.credential.quantity).sort();
      return out;
    }, { d: domain, pw: PASSWORD, seed: w.seed });
    check('mint, re-verify and export leave the old record byte-identical', (await record()) === recordBefore);
    check('the main wallet is intact', after.held.join() === 'atlas.element.gold:10,atlas.element.iron:40', after);
    check('the export does not carry the old key', !after.exportError && !after.exportedText.includes('legacy-private'), after.exportError);
    await w.restart(true);
    check('the old record survives a restart byte-identical', (await record()) === recordBefore);
  } catch (e) {
    failures++;
    console.log('FAIL threw :: ' + (e.stack || e));
  } finally {
    await w.dispose();
    try { await be.stop(); } catch (e) {}
  }
  console.log('\ncounterparty retired: ' + passes + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
