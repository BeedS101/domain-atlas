// Backup coverage for sub-identities (docs/sub-identities.md, backup section). Checks that equipped avatar
// choices, pending bridge offers and trusted bridge domains travel in every backup path, for the main identity
// and for sub-identities, and that the Chrome sync identity backup brings the sub-identity keys back. Scratch
// Chromium profiles and throw-away identities only; nothing contacts an issuer, a ledger or a site.
//
// Run with a display, e.g.:  xvfb-run -a node test/manual-sub-identity-backup-coverage.js

const { chromium } = require('playwright');
const path = require('path');
const os = require('os');
const fs = require('fs');

const EXT_PATH = process.env.ATLAS_EXT_PATH || path.resolve(__dirname, '..', 'extension');
const PASSWORD = 'sub-identity-backup-test-pw-1';
const SEED = 'amber anchor apple arrow aspen atlas aurora autumn';

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' :: ' + JSON.stringify(detail)));
  if (!ok) failures++;
}

async function launch() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-sub-backup-'));
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = worker.url().split('/')[2];
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/viewer.html`);
  await page.waitForFunction(() => typeof AtlasWallet === 'object', null, { timeout: 10000 });
  const W = (fn, arg) => page.evaluate(fn, arg);
  const close = async () => { await context.close().catch(() => {}); fs.rmSync(profile, { recursive: true, force: true }); };
  return { page, W, close };
}

const credential = (n) => ({ credential: 'domain-atlas-asset/1.0', asset: { class: 'test.class.' + n }, n });

// Sets one distinctive value in every newly covered family for whichever identity is active.
const seedActive = (W, tag) => W(async (tag) => {
  const me = await AtlasWallet.getIdentity();
  await AtlasWallet.setAvatarLook('look-' + tag);
  await AtlasWallet.setAvatarHat('hat-' + tag);
  await AtlasWallet.setAvatarShoes('shoes-' + tag);
  await AtlasWallet.setAvatarHand('hand-' + tag);
  await AtlasWallet.setAvatarSlot('ring1', 'ring-' + tag);
  await AtlasWallet.queueBridgeOffer(me.publicKey, 'https://offers-' + tag + '.example.com', {
    credential: 'domain-atlas-asset/1.0', asset: { class: 'test.class.' + tag }
  });
  await AtlasWallet.trustBridgeDomain(me.publicKey, 'https://trusted-' + tag + '.example.com');
}, tag);

const readActive = (W) => W(async () => {
  const me = await AtlasWallet.getIdentity();
  return {
    look: await AtlasWallet.getAvatarLookAssetId(),
    hat: await AtlasWallet.getAvatarHatAssetId(),
    shoes: await AtlasWallet.getAvatarShoesAssetId(),
    hand: await AtlasWallet.getAvatarHandAssetId(),
    slots: await AtlasWallet.getAvatarSlotIds(),
    offers: (await AtlasWallet.getBridgeOffers(me.publicKey)).map((o) => o.origin + ' ' + o.credential.asset.class),
    trusted: (await AtlasWallet.getTrustedBridgeDomains(me.publicKey)).map((t) => t.origin)
  };
});

const expected = (tag) => ({
  look: 'look-' + tag, hat: 'hat-' + tag, shoes: 'shoes-' + tag, hand: 'hand-' + tag,
  slots: { ring1: 'ring-' + tag },
  offers: ['https://offers-' + tag + '.example.com test.class.' + tag],
  trusted: ['https://trusted-' + tag + '.example.com']
});
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  const A = await launch();
  const made = [];
  try {
    const { W } = A;
    console.log('--- a wallet with choices, offers and trusted sites on main and on a sub-identity ---');
    const main = await W(async (pw) => (await AtlasWallet.createIdentity(pw)).publicKey, PASSWORD);
    const sandbox = await W(() => AtlasWallet.createSubIdentity('Sandbox'));
    await seedActive(W, 'main');
    await W((id) => AtlasWallet.switchIdentity(id), sandbox.id);
    await seedActive(W, 'sandbox');
    check('the sub-identity keeps its own choices apart from the main identity', same(await readActive(W), expected('sandbox')));
    await W(() => AtlasWallet.switchIdentity(null));
    check('the main identity still has its own', same(await readActive(W), expected('main')));

    console.log('--- a full backup made while the main identity is active ---');
    const fromMain = await W(async ({ pw, seed }) => AtlasWallet.exportFullBackup(pw, seed), { pw: PASSWORD, seed: SEED });
    await W((id) => AtlasWallet.switchIdentity(id), sandbox.id);
    console.log('--- and one made while the sub-identity is active ---');
    const fromSub = await W(async ({ pw, seed }) => AtlasWallet.exportFullBackup(pw, seed), { pw: PASSWORD, seed: SEED });
    await W(() => AtlasWallet.switchIdentity(null));

    for (const [name, file] of [['main active', fromMain], ['sub-identity active', fromSub]]) {
      const B = await launch();
      made.push(B);
      const restored = await B.W(async ({ file, pw, seed }) => AtlasWallet.importFullBackup(file, pw, seed), { file, pw: PASSWORD, seed: SEED });
      check('restore (' + name + ') brings the main identity back', restored.publicKey === main, restored);
      check('restore (' + name + ') brings the main identity’s choices, offers and trusted sites', same(await readActive(B.W), expected('main')), await readActive(B.W));
      const subs = await B.W(() => AtlasWallet.listSubIdentities());
      await B.W((id) => AtlasWallet.switchIdentity(id), subs[0].id);
      check('restore (' + name + ') brings the sub-identity’s too', same(await readActive(B.W), expected('sandbox')), await readActive(B.W));
    }

    console.log('--- the automatic backup file ---');
    const blob = await W(async (pw) => AtlasWallet.buildAutoBackupBlob(await AtlasWallet.getAccountIdentity(), pw), PASSWORD);
    const C = await launch();
    made.push(C);
    const autoRestored = await C.W(async ({ blob, pw }) => AtlasWallet.restoreFromAutoBackupFile(blob, pw), { blob, pw: PASSWORD });
    check('an automatic backup restores the main identity', autoRestored && autoRestored.publicKey === main, autoRestored);
    check('...with its choices, offers and trusted sites', same(await readActive(C.W), expected('main')), await readActive(C.W));
    const autoSubs = await C.W(() => AtlasWallet.listSubIdentities());
    await C.W((id) => AtlasWallet.switchIdentity(id), autoSubs[0].id);
    check('...and the sub-identity’s', same(await readActive(C.W), expected('sandbox')), await readActive(C.W));

    console.log('--- exporting one sub-identity to a file ---');
    const exp = await W(async ({ pw, id }) => AtlasWallet.prepareSubIdentityExport(id, { password: pw }), { pw: PASSWORD, id: sandbox.id });
    const D = await launch();
    made.push(D);
    await D.W(async (pw) => AtlasWallet.createIdentity(pw), PASSWORD);
    const imported = await D.W(async ({ file, pw, code }) => AtlasWallet.importSubIdentity(file, pw, code), { file: exp.file, pw: PASSWORD, code: exp.code });
    await D.W((id) => AtlasWallet.switchIdentity(id), imported.id);
    check('an imported sub-identity brings its choices, offers and trusted sites', same(await readActive(D.W), expected('sandbox')), await readActive(D.W));

    console.log('--- identity sync carries the sub-identity keys ---');
    const subs = [sandbox];
    for (const label of ['Plain', 'Trading']) subs.push(await W((l) => AtlasWallet.createSubIdentity(l), label));
    await W((pw) => AtlasWallet.enableIdentitySyncBackup(pw), PASSWORD);
    const syncState = () => W(async () => {
      const all = await chrome.storage.sync.get(null);
      const keys = Object.keys(all).filter((k) => k.indexOf('atlasIdentitySyncSubKeys') === 0);
      return { keys, all: JSON.stringify(all), partLengths: keys.filter((k) => k.indexOf('.') !== -1).map((k) => all[k].length) };
    });
    let s = await syncState();
    check('turning sync on mirrors the sub-identities vault', s.keys.includes('atlasIdentitySyncSubKeys') && s.partLengths.length >= 1, s.keys);
    check('the synced copy holds no private key or label in the clear', !s.all.includes('"d"') && !s.all.includes('Sandbox') && !s.all.includes(sandbox.publicKey), null);
    await W((id) => AtlasWallet.renameSubIdentity(id, 'Plain two'), subs[1].id);
    s = await syncState();
    check('a vault change is mirrored', s.keys.includes('atlasIdentitySyncSubKeys'), s.keys);

    // Many sub-identities need several parts, each within the per-item sync limit.
    const manyLabels = [];
    for (let i = 0; i < 17; i++) { manyLabels.push('Extra ' + i); await W((l) => AtlasWallet.createSubIdentity(l), 'Extra ' + i); }
    s = await syncState();
    check('twenty sub-identities are split into parts that each fit a sync item', s.partLengths.length >= 2 && s.partLengths.every((n) => n <= 6000), s.partLengths);

    // A fresh device: local and session storage gone, sync left alone.
    await W(async () => { await chrome.storage.local.clear(); await chrome.storage.session.clear(); });
    const result = await W((pw) => AtlasWallet.restoreIdentityFromSync(pw), PASSWORD);
    check('restoring from sync recovers the main identity', result.publicKey === main, result);
    check('...and reports the recovered sub-identities', result.subIdentities && result.subIdentities.restored === 20, result.subIdentities);
    const list = await W(() => AtlasWallet.listSubIdentities());
    check('all twenty names and keys are back', list.length === 20 && list.some((e) => e.label === 'Sandbox' && e.publicKey === sandbox.publicKey) && list.some((e) => e.label === 'Plain two'), list.length);
    await W((id) => AtlasWallet.switchIdentity(id), list.find((e) => e.label === 'Sandbox').id);
    const acting = await W(async () => (await AtlasWallet.getIdentity()).publicKey);
    check('a recovered sub-identity can be used', acting === sandbox.publicKey, acting);
    check('no data came back with the keys', (await readActive(W)).look === null, await readActive(W));
    await W(() => AtlasWallet.switchIdentity(null));

    // Shrinking the vault drops the parts it no longer needs; an empty vault removes the mirror.
    for (const e of list.filter((x) => /^Extra/.test(x.label))) await W((id) => AtlasWallet.removeSubIdentity(id), e.id).catch(() => {});
    s = await syncState();
    check('the mirror shrinks with the vault', s.partLengths.length <= 1, s.partLengths);
    for (const e of await W(() => AtlasWallet.listSubIdentities())) await W((id) => AtlasWallet.removeSubIdentity(id), e.id).catch(() => {});
    s = await syncState();
    check('an empty vault leaves nothing in sync', s.keys.length === 0, s.keys);

    await W(() => AtlasWallet.createSubIdentity('Again'));
    s = await syncState();
    check('creating one again mirrors it again', s.keys.includes('atlasIdentitySyncSubKeys'), s.keys);
    await W(() => AtlasWallet.disableIdentitySyncBackup());
    s = await syncState();
    check('turning sync off removes the mirror too', s.keys.length === 0 && !s.all.includes('atlasIdentitySyncBackup'), s.keys);
  } finally {
    await A.close();
    for (const b of made) await b.close();
  }
  console.log(failures ? '\n' + failures + ' CHECK(S) FAILED' : '\nALL BACKUP COVERAGE CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
