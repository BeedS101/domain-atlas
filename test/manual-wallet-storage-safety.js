// The wallet must never replace stored wallet or journal contents it cannot read. A wallet that is
// locked, whose stored data fails to decrypt, or whose stored data is corrupted looks "empty" to a
// lenient read; a write built on that read erases what was really there. These tests run the real
// extension in disposable Chromium profiles against a throw-away issuer and check, byte for byte, that
// refused operations leave the stored wallet and journal untouched.
//
//   xvfb-run -a node test/manual-wallet-storage-safety.js [node|php]
'use strict';
const crypto = require('crypto');
const { Wallet, PASSWORD, sleep } = require('./lib/wallet-profile');
const issuers = require('./lib/gen1-issuers');

const IRON = 'atlas.element.iron', GOLD = 'atlas.element.gold', WEAR = 'atlas.wearable';
const which = process.argv.slice(2).find((a) => /^(node|php)$/.test(a)) || 'node';
const ONLY = (process.argv.slice(2).find((a) => a.startsWith('--only=')) || '').slice(7);

let passes = 0, failures = 0;
const check = (name, ok, detail) => { if (ok) { passes++; console.log('PASS ' + name); } else { failures++; console.log('FAIL ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 500) : '')); } };
const rid = () => crypto.randomBytes(18).toString('base64url');
let nextPort = 21000 + (process.pid % 500) * 20;

async function startIssuer() {
  const port = nextPort++;
  const be = which === 'php' ? await issuers.startPhp(port, { workers: 0 }) : await issuers.startNode(port, {});
  return { be, domain: which === 'php' ? '127.0.0.1:' + port : 'localhost:' + port, api: issuers.api(be), stop: () => be.stop() };
}
async function scenario(label, body) {
  if (ONLY && !label.startsWith(ONLY)) return;
  console.log('\n=== ' + label + ' ===');
  const iss = await startIssuer();
  const w = await new Wallet(label.replace(/\W+/g, '').slice(0, 12)).launch();
  try { await w.create(); await body(w, iss); } catch (e) { failures++; console.log('FAIL threw in "' + label + '" :: ' + (e.stack || e)); } finally { await w.dispose(); iss.stop(); }
}

const mintFungible = (w, iss, cls, q) => w.W((a) => AtlasWallet.mintAsset('self', a.d, a.c, a.q).then(() => 'ok', (e) => ({ message: e.message, code: e.code, pending: !!e.pending })), { d: iss.domain, c: cls, q });
const mintUnique = (w, iss) => w.W((a) => AtlasWallet.mintAsset('self', a.d, a.c).then((r) => ({ ok: true, id: r.credential.id }), (e) => ({ ok: false, message: e.message, code: e.code, hasCredential: !!e.issuedCredential })), { d: iss.domain, c: WEAR });
const sum = (rows) => rows.reduce((s, r) => s + r.q, 0);
const rawWallet = async (w) => JSON.stringify((await w.rawStores()).atlasWallets || null);
const rawJournal = async (w) => JSON.stringify((await w.rawStores()).atlasPendingOps || null);
const lockNow = (w) => w.W(() => chrome.storage.session.remove('atlasUnlockedIdentity'));
const isEnvelope = async (w) => { const s = (await w.rawStores()).atlasWallets; return !!(s && s[w.pub] && s[w.pub].__atlasEncrypted); };
// Overwrites the stored wallet blob for this identity with `value` (a test-only corruption).
const setWalletBlob = (w, value) => w.W(([k, v]) => chrome.storage.local.get('atlasWallets').then((r) => { const all = r.atlasWallets || {}; if (v === undefined) delete all[k]; else all[k] = v; return chrome.storage.local.set({ atlasWallets: all }); }), [w.pub, value]);
const setJournalBlob = (w, value) => w.W(([k, v]) => chrome.storage.local.get('atlasPendingOps').then((r) => { const all = r.atlasPendingOps || {}; all[k] = v; return chrome.storage.local.set({ atlasPendingOps: all }); }), [w.pub, value]);
// Errors thrown inside the extension reach this process as plain messages; map them back to their codes.
const codeOf = (e) => (/could not be read or decrypted/.test(e.message) ? 'wallet-unreadable' : /wallet is locked/.test(e.message) ? 'wallet-locked' : 'threw:' + String(e.message).slice(0, 60));
const tamper = (env) => Object.assign({}, env, { ciphertext: env.ciphertext.slice(0, -6) + (env.ciphertext.slice(-6) === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA') });

async function main() {
  // ---- 1. the confirmed failure: a lock during a non-fungible mint ----
  await scenario('S1 lock fires while a non-fungible mint is in flight', async (w, iss) => {
    check('setup: 40 Iron held', (await mintFungible(w, iss, IRON, 40)) === 'ok');
    const before = await rawWallet(w);
    await w.inject('delayAnswer', '/atlas/asset/issue');
    const call = mintUnique(w, iss);
    check('the issue request reached the issuer', await w.waitHits(1));
    await lockNow(w);
    await w.clearFault();
    const out = await call;
    check('the mint reports that the wallet is locked instead of pretending to succeed', out.ok === false && out.code === 'wallet-locked', out);
    check('stored wallet is byte-identical (still encrypted, nothing overwritten)', (await rawWallet(w)) === before);
    await w.unlock();
    const iron = await w.live(IRON);
    check('after unlocking the 40 g Iron balance is still there', sum(iron) === 40, iron);
  });

  // ---- 2. operations that take only an owner key, called while locked ----
  await scenario('S2 mutation helpers called while the wallet is locked', async (w, iss) => {
    check('setup: 40 Iron held', (await mintFungible(w, iss, IRON, 40)) === 'ok');
    const u = await mintUnique(w, iss);
    check('setup: one wearable held', u.ok === true, u);
    const id = (await w.rows(IRON))[0].id;
    await w.restart(false);
    const before = await rawWallet(w);
    const out = {};
    const attempt = async (name, fn, arg) => { out[name] = await w.W(fn, arg).then(() => 'ok', (e) => codeOf(e)); };
    await attempt('deleteAsset', ([k, i]) => AtlasWallet.deleteAsset(k, i), [w.pub, id]);
    await attempt('hideAsset', ([k, i]) => AtlasWallet.hideAsset(k, i), [w.pub, id]);
    await attempt('unhideAsset', ([k, i]) => AtlasWallet.unhideAsset(k, i), [w.pub, id]);
    await attempt('reverifyAll', () => AtlasWallet.reverifyAll());
    await attempt('autoConsolidateAssetWallet', (k) => AtlasWallet.autoConsolidateAssetWallet(k), w.pub);
    check('none of them changed the stored wallet by a single byte', (await rawWallet(w)) === before, out);
    check('the stored wallet is still an encrypted envelope', await isEnvelope(w));
    await w.unlock();
    check('after unlocking, both assets are still there', sum(await w.live(IRON)) === 40 && (await w.rows(WEAR)).length === 1);
  });

  // ---- 3. the lock fires inside a read-modify-write that already read an empty list ----
  await scenario('S3 lock fires during re-verify and during import', async (w, iss) => {
    check('setup: 40 Iron held', (await mintFungible(w, iss, IRON, 40)) === 'ok');
    const exportFile = await w.W(() => AtlasWallet.exportWallet());
    const before = await rawWallet(w);
    await w.inject('delayAnswer', 'atlas-revocations');
    const call = w.W(() => AtlasWallet.reverifyAll().then(() => 'ok', (e) => e.code || 'threw'));
    check('re-verify reached the revocation list', await w.waitHits(1));
    await lockNow(w);
    await w.clearFault();
    const out = await call;
    check('re-verify while the lock fires leaves the stored wallet byte-identical', (await rawWallet(w)) === before, out);
    await w.unlock();
    check('the Iron balance is still held', sum(await w.live(IRON)) === 40);
    const before2 = await rawWallet(w);
    await w.inject('delayAnswer', 'atlas-revocations');
    const call2 = w.W((f) => AtlasWallet.importWallet(f).then(() => 'ok', (e) => e.code || 'threw'), exportFile);
    await w.waitHits(1, 3000);
    await lockNow(w);
    await w.clearFault();
    await call2;
    check('an import while the lock fires leaves the stored wallet byte-identical', (await rawWallet(w)) === before2);
    await w.unlock();
    check('and nothing was lost', sum(await w.live(IRON)) === 40);
  });

  // ---- 4. stored wallet that cannot be decrypted or parsed (wallet unlocked) ----
  await scenario('S4 corrupted or undecryptable stored wallet is never replaced', async (w, iss) => {
    check('setup: 40 Iron held', (await mintFungible(w, iss, IRON, 40)) === 'ok');
    check('setup: one wearable held', (await mintUnique(w, iss)).ok === true);
    const good = (await w.rawStores()).atlasWallets[w.pub];
    const id = (await w.rows(IRON))[0].id;
    const variants = {
      'ciphertext altered': tamper(good),
      'plain garbage string': 'not a wallet',
      'object that is not a list': { hello: 'world' },
      'encrypted envelope missing its parts': { __atlasEncrypted: true }
    };
    for (const [name, blob] of Object.entries(variants)) {
      await setWalletBlob(w, blob);
      const before = await rawWallet(w);
      await w.inject('failFetch', '/atlas/asset/issue');
      const results = {};
      const attempt = async (n, fn, arg) => { results[n] = await w.W(fn, arg).then((v) => (v && v.ok === false ? v.code : 'ok'), (e) => codeOf(e)); };
      await attempt('hideAsset', ([k, i]) => AtlasWallet.hideAsset(k, i), [w.pub, id]);
      await attempt('deleteAsset', ([k, i]) => AtlasWallet.deleteAsset(k, i), [w.pub, id]);
      await attempt('reverifyAll', () => AtlasWallet.reverifyAll());
      await attempt('importWallet', (f) => AtlasWallet.importWallet(f), { format: 'atlas-wallet-export/1.0', credentials: [] });
      await attempt('mintAsset (non-fungible)', (a) => AtlasWallet.mintAsset('self', a.d, a.c), { d: iss.domain, c: WEAR });
      await attempt('mintAsset (fungible)', (a) => AtlasWallet.mintAsset('self', a.d, a.c, a.q), { d: iss.domain, c: IRON, q: 20 });
      await attempt('getWallet (read only)', (k) => AtlasWallet.getWallet(k), w.pub);
      const hits = (await w.faultInfo()).hits;
      await w.clearFault();
      check(`[${name}] the stored blob is byte-identical after every attempt`, (await rawWallet(w)) === before, results);
      check(`[${name}] mutations are refused as unreadable`, ['hideAsset', 'deleteAsset', 'reverifyAll', 'importWallet', 'mintAsset (non-fungible)', 'mintAsset (fungible)'].every((n) => results[n] === 'wallet-unreadable'), results);
      check(`[${name}] no issue request left the wallet (refused before anything was minted)`, hits === 0, hits);
      await setWalletBlob(w, good);
      check(`[${name}] putting the stored blob back restores the wallet with nothing lost`, sum(await w.live(IRON)) === 40 && (await w.rows(WEAR)).length === 1);
    }
  });

  // ---- 5. a legitimately empty wallet is still writable ----
  await scenario('S5 a genuinely empty or absent wallet is not treated as unreadable', async (w, iss) => {
    check('no stored wallet at all: a mint works', (await mintUnique(w, iss)).ok === true);
    check('the result is stored encrypted', await isEnvelope(w));
    await setWalletBlob(w, undefined);
    check('after the blob is removed, a mint works again and starts from empty', (await mintUnique(w, iss)).ok === true && (await w.rows(WEAR)).length === 1);
    const enc = await w.W((k) => AtlasWallet.exportWallet().then(() => 'ok'), w.pub);
    check('an encrypted empty list is readable and writable', enc === 'ok');
  });

  // ---- 6. the journal ----
  await scenario('S6 corrupted or locked journal is never replaced', async (w, iss) => {
    check('setup: 20 Iron held', (await mintFungible(w, iss, IRON, 20)) === 'ok');
    const goodWallet = await rawWallet(w);
    const goodJournal = (await w.rawStores()).atlasPendingOps;
    for (const [name, blob] of Object.entries({
      'journal ciphertext altered': (() => { const j = (goodJournal || {})[w.pub]; return j && j.__atlasEncrypted ? tamper(j) : { __atlasEncrypted: true, iv: 'AAAA', ciphertext: 'AAAA' }; })(),
      'journal is a string': 'garbage'
    })) {
      await setJournalBlob(w, blob);
      const before = await rawJournal(w);
      await w.inject('failFetch', '/atlas/asset/(issue|split|consolidate)');
      const r = await mintFungible(w, iss, IRON, 20);
      const hits = (await w.faultInfo()).hits;
      await w.clearFault();
      check(`[${name}] a fungible mint is refused before it is sent`, r !== 'ok' && r.code === 'wallet-unreadable' && hits === 0, { r, hits });
      check(`[${name}] journal and wallet blobs are byte-identical`, (await rawJournal(w)) === before && (await rawWallet(w)) === goodWallet);
    }
    await setJournalBlob(w, (goodJournal || {})[w.pub]);
    await lockNow(w);
    const jb = await rawJournal(w);
    const r = await w.W((a) => AtlasWallet.recoverPendingOperations(a), w.pub).then(() => 'ok', (e) => e.code);
    check('recovery while locked reads nothing and writes nothing', (await rawJournal(w)) === jb && (await rawWallet(w)) === goodWallet, r);
  });

  // ---- 7. concurrent writers, with and without a lock in the middle ----
  await scenario('S7 concurrent writes lose nothing, and a lock in the middle never wipes', async (w, iss) => {
    for (let i = 0; i < 4; i++) check(`setup: wearable ${i + 1}`, (await mintUnique(w, iss)).ok === true);
    check('setup: 40 Iron held', (await mintFungible(w, iss, IRON, 40)) === 'ok');
    const ids = (await w.rows(WEAR)).map((r) => r.id);
    const parallel = await Promise.all([
      ...ids.map((i) => w.W(([k, x]) => AtlasWallet.hideAsset(k, x).then(() => 'ok', (e) => e.code), [w.pub, i])),
      mintUnique(w, iss), mintUnique(w, iss), mintUnique(w, iss),
      mintFungible(w, iss, GOLD, 10), mintFungible(w, iss, GOLD, 10)
    ]);
    const wear = await w.rows(WEAR);
    check('parallel hides and mints: nothing lost (4 hidden + 3 new)', wear.length === 7 && sum(await w.live(IRON)) === 40, { parallel: parallel.map((p) => (typeof p === 'string' ? p : p.ok === undefined ? p : p.ok)), wear: wear.length });
    check('the hides all landed', (await w.W((k) => AtlasWallet.getWallet(k).then((l) => l.filter((e) => e.hidden).length), w.pub)) === 4);
    check('Gold from the two parallel mints is held in full (20)', sum(await w.live(GOLD)) === 20, await w.live(GOLD));
    // now a lock and unlock while writers are waiting on the issuer
    const countBefore = (await w.rows(WEAR)).length;
    await w.inject('delayAnswer', '/atlas/asset/issue');
    const calls = [mintUnique(w, iss), mintUnique(w, iss), mintUnique(w, iss)];
    await w.waitHits(1);
    await lockNow(w);
    const during = await rawWallet(w);
    await w.clearFault();
    const results = await Promise.all(calls);
    check('while locked, the answers that arrive write nothing (stored wallet byte-identical)', (await rawWallet(w)) === during);
    check('the stored wallet after the locked burst is still an encrypted envelope', await isEnvelope(w));
    await w.unlock();
    const after = await w.rows(WEAR);
    check('everything stored before the lock is still there (nothing wiped)', after.length >= countBefore && sum(await w.live(IRON)) === 40 && sum(await w.live(GOLD)) === 20, { after: after.length, countBefore });
    check('mints that could not be stored say so', results.every((r) => r.ok === true || r.code === 'wallet-locked'), results);
  });

  // ---- 10. the lock fires between the read and the write of one change ----
  await scenario('S10 lock fires between reading and writing the wallet', async (w, iss) => {
    check('setup: one wearable held', (await mintUnique(w, iss)).ok === true);
    check('setup: 40 Iron held', (await mintFungible(w, iss, IRON, 40)) === 'ok');
    const id = (await w.rows(WEAR))[0].id;
    for (const n of [1, 2, 3]) {
      const before = await rawWallet(w);
      await w.inject('lockOnWalletRead', String(n));
      const r = await w.W(([k, i]) => AtlasWallet.hideAsset(k, i).then(() => 'ok', (e) => e.message), [w.pub, id]);
      const fired = (await w.faultInfo()).hits;
      await w.clearFault();
      const stored = await rawWallet(w);
      check(`lock after wallet read #${n}: the stored wallet is either untouched or correctly updated, never replaced by a plaintext or empty list`, stored === before || (await isEnvelope(w)), { r, fired });
      await w.unlock();
      check(`lock after wallet read #${n}: both assets are still held after unlocking`, sum(await w.live(IRON)) === 40 && (await w.rows(WEAR)).length === 1);
      if (r === 'ok') await w.W(([k, i]) => AtlasWallet.unhideAsset(k, i), [w.pub, id]);
    }
  });

  // ---- 8. normal use ----
  await scenario('S8 normal unlocked operations still work and stay encrypted', async (w, iss) => {
    check('mint 20 Iron', (await mintFungible(w, iss, IRON, 20)) === 'ok');
    check('mint 20 Iron again (consolidates to 40)', (await mintFungible(w, iss, IRON, 20)) === 'ok');
    const live = await w.live(IRON);
    check('one 40 g credential', live.length === 1 && live[0].q === 40, live);
    const cred = (await w.W((k) => AtlasWallet.getWallet(k), w.pub))[0].credential;
    const sp = await w.W((c) => AtlasWallet.splitAsset('self', c, 10, 'self').then(() => 'ok', (e) => e.message), cred);
    check('split 10 off and merge back', sp === 'ok' && sum(await w.live(IRON)) === 40, sp);
    check('mint Gold, convert to Platinum', (await mintFungible(w, iss, GOLD, 100)) === 'ok');
    const gold = (await w.W((k) => AtlasWallet.getWallet(k), w.pub)).map((e) => e.credential).find((c) => c.asset.class === GOLD);
    const cv = await w.W((a) => AtlasWallet.convertAsset('self', a.c, 40, 'atlas.element.platinum').then(() => 'ok', (e) => e.message), { c: gold });
    check('convert works', cv === 'ok' && sum(await w.live(GOLD)) === 60 && sum(await w.live('atlas.element.platinum')) > 0, cv);
    check('hide and unhide a wearable', (await mintUnique(w, iss)).ok === true);
    const wid = (await w.rows(WEAR))[0].id;
    await w.W(([k, i]) => AtlasWallet.hideAsset(k, i), [w.pub, wid]);
    await w.W(([k, i]) => AtlasWallet.unhideAsset(k, i), [w.pub, wid]);
    await w.W(([k, i]) => AtlasWallet.deleteAsset(k, i), [w.pub, wid]);
    check('delete removes only that asset', (await w.rows(WEAR)).length === 0 && sum(await w.live(IRON)) === 40);
    check('wallet and journal stay encrypted at rest', await isEnvelope(w) && (await w.rawStores()).atlasWallets[w.pub].ciphertext.length > 20);
    check('journal empty', (await w.pending()).length === 0);
    await w.restart(true);
    check('everything survives a restart', sum(await w.live(IRON)) === 40 && sum(await w.live(GOLD)) === 60);
  });

  // ---- 9. restoring a backup over an unreadable wallet ----
  await scenario('S9 restoring a backup over unreadable data keeps a copy of it', async (w, iss) => {
    check('setup: 40 Iron held', (await mintFungible(w, iss, IRON, 40)) === 'ok');
    const file = await w.W(([pw, seed]) => AtlasWallet.exportFullBackup(pw, seed), [PASSWORD, w.seed]);
    const good = (await w.rawStores()).atlasWallets[w.pub];
    const bad = tamper(good);
    await setWalletBlob(w, bad);
    const res = await w.W(([f, pw, seed]) => AtlasWallet.importFullBackup(f, pw, seed).then(() => 'ok', (e) => 'err ' + e.message), [file, PASSWORD, w.seed]);
    check('the restore succeeds', res === 'ok', res);
    check('the wallet is back from the backup', sum(await w.live(IRON)) === 40);
    const q = await w.W(() => chrome.storage.local.get('atlasWalletQuarantine'));
    check('the unreadable blob was kept in a quarantine entry, not discarded', JSON.stringify(q.atlasWalletQuarantine || {}).includes(bad.ciphertext.slice(0, 30)), q);
  });
}

main().then(() => {
  console.log('\nwallet storage safety: ' + passes + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
}).catch((e) => { console.log('FAIL harness :: ' + (e.stack || e)); process.exit(1); });
