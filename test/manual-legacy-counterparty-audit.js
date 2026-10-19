// AtlasWallet.auditLegacyCounterparty() must only read, return no key material, and tell an emptied
// counterparty apart from one that still holds something or cannot be read. Disposable Chromium profiles
// and a throw-away issuer only.
//
//   xvfb-run -a node test/manual-legacy-counterparty-audit.js
'use strict';
const { Wallet } = require('./lib/wallet-profile');
const issuers = require('./lib/gen1-issuers');

const GOLD = 'atlas.element.gold';
const ONLY = (process.argv.slice(2).find((a) => a.startsWith('--only=')) || '').slice(7);
let passes = 0, failures = 0;
const check = (name, ok, detail) => { if (ok) { passes++; console.log('PASS ' + name); } else { failures++; console.log('FAIL ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 700) : '')); } };
let nextPort = 24000 + (process.pid % 500) * 10;

async function scenario(label, body) {
  if (ONLY && !label.startsWith(ONLY)) return;
  console.log('\n=== ' + label + ' ===');
  const port = nextPort++;
  const be = await issuers.startNode(port, {});
  const iss = { domain: 'localhost:' + port };
  const w = await new Wallet(label.replace(/\W+/g, '').slice(0, 12)).launch();
  try { await w.create(); await body(w, iss); } catch (e) { failures++; console.log('FAIL threw in "' + label + '" :: ' + (e.stack || e)); } finally { await w.dispose(); try { await be.stop(); } catch (e) {} }
}

const snapshot = (w) => w.W(async () => JSON.stringify(await chrome.storage.local.get(null)));
const audit = (w) => w.W(() => AtlasWallet.auditLegacyCounterparty());
const createCp = (w) => w.W(async () => (await AtlasWallet.createCounterparty()).publicKey);
const mint = (w, iss, role, q) => w.W((a) => AtlasWallet.mintAsset(a.r, a.d, a.c, a.q).then(() => 'ok', (e) => e.message), { r: role, d: iss.domain, c: GOLD, q });
// Runs the audit and checks that it wrote nothing and leaked no key material.
async function readOnlyAudit(w, label) {
  const secrets = await w.W(async () => {
    const out = [];
    const id = await AtlasWallet.getIdentity();
    if (id && id.privateKeyJwk) out.push(id.privateKeyJwk.d);
    const cp = await AtlasWallet.getCounterparty();
    if (cp && cp.privateKeyJwk) out.push(cp.privateKeyJwk.d);
    return out;
  });
  const before = await snapshot(w);
  const r = await audit(w);
  const after = await snapshot(w);
  check(label + ': storage is byte-identical after the audit', before === after);
  const text = JSON.stringify(r);
  check(label + ': the report contains no private key material', !/privateKeyJwk|"d":/.test(text) && secrets.every((d) => !text.includes(d)), { secrets: secrets.length });
  return r;
}

async function main() {
  await scenario('A1 no counterparty ever created', async (w) => {
    const r = await readOnlyAudit(w, 'A1');
    check('verdict is empty-confirmed', r.verdict === 'empty-confirmed', r);
    check('no counterparty record, no other owners', r.counterparty.stored === false && r.owners.length === 0, r);
    check('reports the wallet as unlocked', r.walletUnlocked === true);
  });

  await scenario('A2 counterparty created and never used', async (w) => {
    const pub = await createCp(w);
    const r = await readOnlyAudit(w, 'A2');
    check('verdict is empty-confirmed', r.verdict === 'empty-confirmed', r);
    check('the counterparty is reported by public key only', r.counterparty.publicKey === pub && r.counterparty.holdsPrivateKey === true, r.counterparty);
    check('no blockers and nothing unreadable', r.blockers.length === 0 && r.unknown.length === 0, r);
  });

  await scenario('A3 counterparty still holds a balance', async (w, iss) => {
    await createCp(w);
    check('setup: 10 g Gold minted to the counterparty', (await mint(w, iss, 'counterparty', 10)) === 'ok');
    const r = await readOnlyAudit(w, 'A3');
    check('verdict is not-empty', r.verdict === 'not-empty', r);
    const cp = r.owners.find((o) => o.role === 'counterparty');
    check('the Gold balance is reported with its class and quantity', cp && cp.stores.wallet && cp.stores.wallet.byClass[GOLD] === 10, cp);
    check('a blocker names it', r.blockers.length >= 1, r.blockers);
  });

  await scenario('A4 counterparty emptied by moving everything to the main identity', async (w, iss) => {
    await createCp(w);
    check('setup: 10 g Gold minted to the counterparty', (await mint(w, iss, 'counterparty', 10)) === 'ok');
    const moved = await w.W((d) => AtlasWallet.getCounterparty().then(async (cp) => {
      const entry = (await AtlasWallet.getWallet(cp.publicKey))[0];
      await AtlasWallet.splitAsset('counterparty', entry.credential, 10, 'self');
      return (await AtlasWallet.getWallet(cp.publicKey)).length;
    }).then((n) => ({ left: n }), (e) => ({ error: e.message })), iss.domain);
    check('setup: the counterparty wallet is empty after the move', moved.left === 0, moved);
    const r = await readOnlyAudit(w, 'A4');
    check('verdict is empty-confirmed', r.verdict === 'empty-confirmed', r);
  });

  await scenario('A5 an old counterparty key was replaced and its balance is orphaned', async (w, iss) => {
    await createCp(w);
    check('setup: 10 g Gold minted to the first counterparty', (await mint(w, iss, 'counterparty', 10)) === 'ok');
    const second = await createCp(w);
    const r = await readOnlyAudit(w, 'A5');
    check('verdict is not-empty', r.verdict === 'not-empty', r);
    const orphan = r.owners.find((o) => o.role === 'unrecognised');
    check('the orphaned owner is listed as unrecognised with its Gold', orphan && orphan.stores.wallet.byClass[GOLD] === 10, r.owners);
    check('the current counterparty is listed separately and empty', r.counterparty.publicKey === second && r.owners.some((o) => o.role === 'counterparty'), r.owners);
  });

  await scenario('A6 a pending operation belongs to the counterparty', async (w, iss) => {
    await createCp(w);
    await w.inject('dropAnswer', '/atlas/asset/issue');
    await mint(w, iss, 'counterparty', 10);
    await w.clearFault();
    const r = await readOnlyAudit(w, 'A6');
    const cp = r.owners.find((o) => o.role === 'counterparty');
    check('the journal entry is reported', cp && cp.stores.pendingOps && cp.stores.pendingOps.entries === 1, cp);
    check('verdict is not-empty', r.verdict === 'not-empty', r);
  });

  await scenario('A7 locked wallet cannot confirm', async (w, iss) => {
    await createCp(w);
    check('setup: 10 g Gold minted to the counterparty', (await mint(w, iss, 'counterparty', 10)) === 'ok');
    await w.restart(false);
    const r = await readOnlyAudit(w, 'A7');
    check('verdict is cannot-confirm, never empty-confirmed', r.verdict === 'cannot-confirm' && r.walletUnlocked === false, r);
    check('it says what could not be read', r.unknown.length >= 1, r.unknown);
  });

  await scenario('A8 corrupted counterparty record cannot confirm', async (w) => {
    await createCp(w);
    await w.W(() => chrome.storage.local.get('atlasCounterparty').then((r) => {
      const e = r.atlasCounterparty;
      return chrome.storage.local.set({ atlasCounterparty: Object.assign({}, e, { ciphertext: e.ciphertext.slice(0, -6) + (e.ciphertext.slice(-6) === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA') }) });
    }));
    const r = await readOnlyAudit(w, 'A8');
    check('verdict is cannot-confirm', r.verdict === 'cannot-confirm' && r.counterparty.state === 'unreadable', r);
  });

  await scenario('A9 unclaimed gift in the counterparty inbox', async (w) => {
    const pub = await createCp(w);
    await w.W((k) => chrome.storage.local.set({ atlasMail: { [k]: [{ id: 'm1', message: { attachedAsset: { credential: 'domain-atlas-asset/1.0' } } }] } }), pub);
    const r = await readOnlyAudit(w, 'A9');
    check('verdict is not-empty because of the attached asset', r.verdict === 'not-empty' && r.blockers.some((b) => /attached asset/.test(b)), r);
  });

  await scenario('A10 the main identity and its data are not reported as legacy', async (w, iss) => {
    check('setup: 10 g Gold minted to the main identity', (await mint(w, iss, 'self', 10)) === 'ok');
    const r = await readOnlyAudit(w, 'A10');
    check('verdict is empty-confirmed and the main wallet is not listed', r.verdict === 'empty-confirmed' && r.owners.length === 0, r);
  });

  console.log('\nlegacy counterparty audit: ' + passes + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
