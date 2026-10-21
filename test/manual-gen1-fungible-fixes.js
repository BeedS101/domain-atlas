// Regression tests for the Gen1 fungible safety fixes, against throw-away Node and PHP issuers:
// revocation-file integrity, replay of a repeated requestId, bounded consolidation, the holding cap
// and preservation of credentials signed before the change.
//
//   node test/manual-gen1-fungible-fixes.js [node|php|both] [--quick]
//
// --quick uses a 6,127-entry revocation list instead of also running 20,000 entries.
'use strict';
const fs = require('fs');
const crypto = require('crypto');
const { startNode, startPhp, api } = require('./lib/gen1-issuers');
const fixture = require('./revocation-fixture');

const WHICH = process.argv.find((a) => ['node', 'php', 'both'].includes(a)) || 'both';
const QUICK = process.argv.includes('--quick');
const GOLD = 'atlas.element.gold';
const PLAT = 'atlas.element.platinum';
const IRON = 'atlas.element.iron';

let failures = 0, checks = 0;
const notes = [];
function check(be, name, ok, detail) {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} [${be.kind}] ${name}${detail !== undefined ? ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
}
const note = (be, text, value) => { notes.push({ backend: be.kind, text, value }); console.log(`NOTE [${be.kind}] ${text} => ${JSON.stringify(value)}`); };
let n = 0;
const owner = (label) => 'TESTOWNER-' + label + '-' + (++n) + '-' + crypto.randomBytes(4).toString('hex');
const rid = () => crypto.randomBytes(18).toString('base64url');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const revokedSet = (A) => new Set((A.revocations() || []).map((r) => r.id));
const sumQ = (list) => list.reduce((s, c) => s + c.quantity, 0);

async function mintMany(A, own, cls, qty, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const r = await A.post('/atlas/asset/issue', { ownerPublicKey: own, assetClass: cls, quantity: qty });
    if (r.status !== 200) throw new Error('mint failed: ' + r.status + ' ' + JSON.stringify(r.body));
    out.push(r.body);
  }
  return out;
}
const writeRev = (be, doc) => fs.writeFileSync(be.revFile, be.revLayout(doc));

async function revocationIntegrity(be) {
  const A = api(be);
  writeRev(be, { revoked: fixture.entries(50) });
  const own = owner('rev');
  // Concurrent spends all land in the file; the file stays valid JSON; no stray temp files.
  const creds = await mintMany(A, own, IRON, 5, 24);
  const filesBefore = new Set(A.files().map((f) => f.replace(/.*[\\/]/, '')));
  const results = await Promise.all(creds.map((c) => A.post('/atlas/asset/split', { credential: c, sendAmount: 2, toPublicKey: own, requestId: rid() })));
  check(be, 'RV1 24 parallel splits all succeed', results.every((r) => r.status === 200), results.filter((r) => r.status !== 200).map((r) => [r.status, r.body.error]));
  const rev = A.revocations();
  check(be, 'RV2 revocation file is valid JSON and holds the 50 originals plus all 24 new entries', Array.isArray(rev) && rev.length === 74, rev && rev.length);
  const revIds = new Set((rev || []).map((r) => r.id));
  check(be, 'RV3 every spent credential is recorded', creds.every((c) => revIds.has(c.id)));
  check(be, 'RV4 the 50 original entries are unchanged and still first', JSON.stringify(rev.slice(0, 50)) === JSON.stringify(fixture.entries(50)));
  const filesAfter = A.files().map((f) => f.replace(/.*[\\/]/, '')).filter((f) => !filesBefore.has(f));
  const stray = filesAfter.filter((f) => /\.tmp|atlas-revocations\.json\.|\.json\.[A-Za-z0-9]{4,}$/.test(f));
  check(be, 'RV5 no temporary files left behind', stray.length === 0, stray);

  // A malformed file is never replaced: spends are refused with 503 and the bytes stay as they were.
  const spare = await mintMany(A, own, IRON, 5, 7);
  const variants = {
    truncated: '{"revoked":[{"id":"urn:atlas:asset:x","revokedAt":"2026-01-01T00:00:00Z","reaso',
    'not-an-object': '[]',
    'no-revoked-list': '{"something":"else"}',
    'revoked-not-array': '{"revoked":"nope"}',
    empty: '',
    garbage: '\u0000\u0001not json'
  };
  let k = 0;
  for (const [name, text] of Object.entries(variants)) {
    fs.writeFileSync(be.revFile, text);
    const c = spare[k++];
    const before = fs.readFileSync(be.revFile);
    const r1 = await A.post('/atlas/asset/split', { credential: c, sendAmount: 1, toPublicKey: own, requestId: rid() });
    const r2 = await A.post('/atlas/asset/consolidate', { credentials: [spare[6], c], requestId: rid() });
    const same = Buffer.compare(before, fs.readFileSync(be.revFile)) === 0;
    check(be, `RV6 ${name}: split refused with 503`, r1.status === 503, [r1.status, r1.body.error]);
    check(be, `RV6 ${name}: consolidate refused with 503`, r2.status === 503, [r2.status, r2.body.error]);
    check(be, `RV6 ${name}: file bytes untouched`, same);
  }
  // A refused spend revokes nothing and signs nothing that survives: once the file is repaired the
  // same balances are still spendable.
  writeRev(be, { revoked: fixture.entries(3) });
  const after = await A.post('/atlas/asset/split', { credential: spare[0], sendAmount: 1, toPublicKey: own, requestId: rid() });
  check(be, 'RV7 balances refused during the outage are spendable once the file is valid again', after.status === 200, [after.status, after.body.error]);
  // A missing file is lost history, not an empty list: the spend is refused and no list is created
  // (test/manual-gen1-revocation-state.js covers this in full).
  fs.rmSync(be.revFile, { force: true });
  const fresh = await A.post('/atlas/asset/split', { credential: spare[1], sendAmount: 1, toPublicKey: own, requestId: rid() });
  check(be, 'RV8 a missing revocation file refuses the spend with 503', fresh.status === 503, [fresh.status, fresh.body.error]);
  check(be, 'RV8 and does not create an empty list', !fs.existsSync(be.revFile));
}

async function replayAndRetry(be) {
  const A = api(be);
  writeRev(be, { revoked: [] });
  const own = owner('replay');
  // mint
  const idMint = rid();
  const m1 = await A.post('/atlas/asset/issue', { ownerPublicKey: own, assetClass: IRON, quantity: 7, requestId: idMint });
  const m2 = await A.post('/atlas/asset/issue', { ownerPublicKey: own, assetClass: IRON, quantity: 7, requestId: idMint });
  check(be, 'RP1 a repeated mint request returns the same credential', m1.status === 200 && m2.status === 200 && m1.body.id === m2.body.id && m1.body.signature === m2.body.signature, [m1.status, m2.status]);
  const m3 = await A.post('/atlas/asset/issue', { ownerPublicKey: own, assetClass: IRON, quantity: 9, requestId: idMint });
  check(be, 'RP2 the same requestId with different parameters is refused (409)', m3.status === 409, [m3.status, m3.body.code]);
  const bad = await A.post('/atlas/asset/issue', { ownerPublicKey: own, assetClass: IRON, quantity: 1, requestId: 'bad id!' });
  check(be, 'RP3 a malformed requestId is refused (400)', bad.status === 400, [bad.status, bad.body.error]);
  const none = await A.post('/atlas/asset/issue', { ownerPublicKey: own, assetClass: IRON, quantity: 1 });
  check(be, 'RP4 a request without requestId still works as before', none.status === 200);

  // consolidate: the response is lost, the retry gets the same successor and nothing is spent twice
  const parts = await mintMany(A, own, IRON, 3, 4);
  const idCons = rid();
  const c1 = await A.post('/atlas/asset/consolidate', { credentials: parts, requestId: idCons });
  const revAfterFirst = A.revocations().length;
  const c2 = await A.post('/atlas/asset/consolidate', { credentials: parts, requestId: idCons });
  check(be, 'RP5 consolidate retry returns the same successor', c1.status === 200 && c2.status === 200 && c1.body.id === c2.body.id && c1.body.quantity === 12, [c1.status, c2.status, c2.body.error]);
  check(be, 'RP6 the retry revoked nothing further and minted nothing further', A.revocations().length === revAfterFirst);
  const c3 = await A.post('/atlas/asset/consolidate', { credentials: parts.slice(0, 3), requestId: idCons });
  check(be, 'RP7 consolidate with the same requestId and different balances is refused (409)', c3.status === 409, [c3.status, c3.body.code]);
  const noRid = await A.post('/atlas/asset/consolidate', { credentials: parts });
  check(be, 'RP8 without a requestId the already-spent balances are refused', noRid.status === 400 && noRid.body.code === 'revoked', [noRid.status, noRid.body.code]);

  // concurrent identical requests: one result, never two spends
  const more = await mintMany(A, own, IRON, 2, 5);
  const idPar = rid();
  const par = await Promise.all([1, 2, 3, 4].map(() => A.post('/atlas/asset/consolidate', { credentials: more, requestId: idPar })));
  const okIds = new Set(par.filter((r) => r.status === 200).map((r) => r.body.id));
  check(be, 'RP9 four simultaneous identical requests give one successor', okIds.size === 1, par.map((r) => [r.status, r.body.code || r.body.id && 'id']));
  const retry = await A.post('/atlas/asset/consolidate', { credentials: more, requestId: idPar });
  check(be, 'RP10 a later retry returns that successor', retry.status === 200 && okIds.has(retry.body.id));
  const spentOnce = A.revocations().filter((r) => more.some((c) => c.id === r.id));
  check(be, 'RP11 each predecessor is recorded exactly once', spentOnce.length === more.length, spentOnce.length);

  // split
  const one = (await mintMany(A, own, IRON, 10, 1))[0];
  const idSplit = rid();
  const s1 = await A.post('/atlas/asset/split', { credential: one, sendAmount: 4, toPublicKey: own, requestId: idSplit });
  const s2 = await A.post('/atlas/asset/split', { credential: one, sendAmount: 4, toPublicKey: own, requestId: idSplit });
  check(be, 'RP12 split retry returns the same pieces', s1.status === 200 && s2.status === 200 && s1.body.sent.id === s2.body.sent.id && s1.body.remainder.id === s2.body.remainder.id, [s1.status, s2.status]);
  const s3 = await A.post('/atlas/asset/split', { credential: one, sendAmount: 5, toPublicKey: own, requestId: idSplit });
  check(be, 'RP13 split with changed amount under the same requestId is refused (409)', s3.status === 409, s3.status);

  // convert (gold -> platinum)
  const gold = (await mintMany(A, own, GOLD, 100, 1))[0];
  const idConv = rid();
  const v1 = await A.post('/atlas/convert', { credential: gold, spendAmount: 40, toClass: PLAT, requestId: idConv });
  const v2 = await A.post('/atlas/convert', { credential: gold, spendAmount: 40, toClass: PLAT, requestId: idConv });
  check(be, 'RP14 convert retry returns the same received and remainder', v1.status === 200 && v2.status === 200 && v1.body.received.id === v2.body.received.id && (v1.body.remainder || {}).id === (v2.body.remainder || {}).id, [v1.status, v2.status, v2.body.error]);

  // a replayed answer is not handed to someone who cannot present the balances
  const forged = JSON.parse(JSON.stringify(parts));
  forged[0].quantity = 99;
  const f = await A.post('/atlas/asset/consolidate', { credentials: forged, requestId: idCons });
  check(be, 'RP15 a forged balance never gets a stored answer', f.status !== 200, [f.status, f.body.code || f.body.error]);

  // the replay store survives a restart
  if (be.restart) {
    const restId = rid();
    const r1 = await A.post('/atlas/asset/issue', { ownerPublicKey: own, assetClass: IRON, quantity: 3, requestId: restId });
    await be.restart();
    const r2 = await A.post('/atlas/asset/issue', { ownerPublicKey: own, assetClass: IRON, quantity: 3, requestId: restId });
    check(be, 'RP16 a retry after an issuer restart still returns the same credential', r1.status === 200 && r2.status === 200 && r1.body.id === r2.body.id, [r1.status, r2.status]);
  }
}

async function consolidationBatches(be) {
  const A = api(be);
  writeRev(be, { revoked: [] });
  const own = owner('batch');
  const creds = await mintMany(A, own, IRON, 1, 21);
  const tooMany = await A.post('/atlas/asset/consolidate', { credentials: creds, requestId: rid() });
  check(be, 'CB1 21 balances in one request: refused with a stable code', tooMany.status === 400 && tooMany.body.code === 'too-many' && tooMany.body.max === 20, [tooMany.status, tooMany.body.code, tooMany.body.max]);
  check(be, 'CB2 and nothing was spent', revokedSet(A).size === 0);
  const ok20 = await A.post('/atlas/asset/consolidate', { credentials: creds.slice(0, 20), requestId: rid() });
  check(be, 'CB3 20 balances merge', ok20.status === 200 && ok20.body.quantity === 20, [ok20.status, ok20.body.error]);
  const last = await A.post('/atlas/asset/consolidate', { credentials: [ok20.body, creds[20]], requestId: rid() });
  check(be, 'CB4 the 21st joins the merged balance', last.status === 200 && last.body.quantity === 21, [last.status, last.body.error]);

  // one spent predecessor is named in the refusal and poisons nothing else
  const group = await mintMany(A, own, IRON, 2, 6);
  await A.post('/atlas/asset/split', { credential: group[2], sendAmount: 1, toPublicKey: own, requestId: rid() });
  const before = revokedSet(A).size;
  const poisoned = await A.post('/atlas/asset/consolidate', { credentials: group, requestId: rid() });
  check(be, 'CB5 a spent balance is refused with code "revoked" and its id', poisoned.status === 400 && poisoned.body.code === 'revoked' && poisoned.body.credentialId === group[2].id, [poisoned.status, poisoned.body.code, poisoned.body.credentialId]);
  check(be, 'CB6 the refusal spends nothing', revokedSet(A).size === before);
  const without = group.filter((c, i) => i !== 2);
  const retry = await A.post('/atlas/asset/consolidate', { credentials: without, requestId: rid() });
  check(be, 'CB7 the same group without the spent balance merges', retry.status === 200 && retry.body.quantity === 10, [retry.status, retry.body.error]);
  // the same balance twice in one request is not counted twice
  const dup = (await mintMany(A, own, IRON, 5, 1))[0];
  const twice = await A.post('/atlas/asset/consolidate', { credentials: [dup, dup], requestId: rid() });
  check(be, 'CB8 a balance listed twice is refused', twice.status === 400, [twice.status, twice.body.error]);
}

async function holdingCap(be) {
  const A = api(be);
  writeRev(be, { revoked: [] });
  // An honest wallet that presents and merges its balances reaches exactly 500.
  const own = owner('cap');
  let held = [];
  let accepted = 0, refusal = null;
  for (let i = 0; i < 70; i++) {
    const r = await A.post('/atlas/asset/issue', { ownerPublicKey: own, assetClass: GOLD, quantity: 10, requestId: rid(), ...(held.length ? { existingBalances: held } : {}) });
    if (r.status !== 200) { refusal = r; break; }
    accepted++;
    const group = held.concat([r.body]);
    if (group.length > 1) {
      const m = await A.post('/atlas/asset/consolidate', { credentials: group, requestId: rid() });
      if (m.status !== 200) throw new Error('merge failed ' + JSON.stringify(m.body));
      held = [m.body];
    } else held = group;
  }
  check(be, 'CP1 honest wallet stops at exactly 500', accepted === 50 && sumQ(held) === 500, [accepted, sumQ(held)]);
  check(be, 'CP2 the refusal carries a code, held and cap', refusal && refusal.status === 400 && refusal.body.code === 'cap' && refusal.body.held === 500 && refusal.body.cap === 500, refusal && refusal.body);

  // held + requested > cap is refused even when held < cap
  const own2 = owner('cap2');
  const big = await A.post('/atlas/asset/issue', { ownerPublicKey: own2, assetClass: GOLD, quantity: 490, requestId: rid() });
  const over = await A.post('/atlas/asset/issue', { ownerPublicKey: own2, assetClass: GOLD, quantity: 20, requestId: rid() });
  check(be, 'CP3 490 held, 20 requested: refused (held + requested > cap)', big.status === 200 && over.status === 400 && over.body.code === 'cap', [over.status, over.body.error]);
  const exact = await A.post('/atlas/asset/issue', { ownerPublicKey: own2, assetClass: GOLD, quantity: 10, requestId: rid() });
  check(be, 'CP4 490 held, 10 requested: accepted (lands on 500)', exact.status === 200, [exact.status, exact.body.error]);
  const one = await A.post('/atlas/asset/issue', { ownerPublicKey: own2, assetClass: GOLD, quantity: 1, requestId: rid() });
  check(be, 'CP5 500 held, 1 requested: refused', one.status === 400 && one.body.code === 'cap');
  const huge = await A.post('/atlas/asset/issue', { ownerPublicKey: owner('huge'), assetClass: GOLD, quantity: 100000, requestId: rid() });
  check(be, 'CP6 a single request above the cap is refused', huge.status === 400 && huge.body.code === 'cap', [huge.status, huge.body.error]);

  // The wallet's own list is not the authority: presenting nothing does not reset the count.
  const hidden = await A.post('/atlas/asset/issue', { ownerPublicKey: own2, assetClass: GOLD, quantity: 10, requestId: rid() });
  check(be, 'CP7 presenting no balances does not lift the cap', hidden.status === 400 && hidden.body.code === 'cap', [hidden.status, hidden.body.error]);

  // Spent Gold stops counting: spending down makes room.
  const spend = await A.post('/atlas/convert', { credential: exact.body, spendAmount: 10, toClass: PLAT, requestId: rid() });
  const room = await A.post('/atlas/asset/issue', { ownerPublicKey: own2, assetClass: GOLD, quantity: 10, requestId: rid() });
  check(be, 'CP8 gold converted away stops counting', spend.status === 200 && room.status === 200, [spend.status, spend.body.error, room.status, room.body.error]);

  // Parallel mints cannot pass the check together.
  const own3 = owner('cap3');
  const seed = await A.post('/atlas/asset/issue', { ownerPublicKey: own3, assetClass: GOLD, quantity: 490, requestId: rid() });
  const par = await Promise.all([1, 2, 3, 4, 5, 6].map(() => A.post('/atlas/asset/issue', { ownerPublicKey: own3, assetClass: GOLD, quantity: 10, requestId: rid() })));
  const won = par.filter((r) => r.status === 200).length;
  check(be, 'CP9 six parallel 10 g mints from 490 g: exactly one accepted', seed.status === 200 && won === 1, par.map((r) => [r.status, r.body.code]));

  // Credentials signed before the index existed are counted once presented.
  const own4 = owner('legacy');
  const old = await A.post('/atlas/asset/issue', { ownerPublicKey: own4, assetClass: GOLD, quantity: 480, requestId: rid() });
  fs.rmSync(be.holdingsDir, { recursive: true, force: true });
  const unseen = await A.post('/atlas/asset/issue', { ownerPublicKey: own4, assetClass: GOLD, quantity: 100, requestId: rid() });
  note(be, 'LIMIT with the holdings index missing and nothing presented, the cap cannot see credentials signed earlier (accepted 100 on top of 480)', unseen.status);
  const own5 = owner('legacy2');
  const old5 = await A.post('/atlas/asset/issue', { ownerPublicKey: own5, assetClass: GOLD, quantity: 480, requestId: rid() });
  fs.rmSync(be.holdingsDir, { recursive: true, force: true });
  const presented = await A.post('/atlas/asset/issue', { ownerPublicKey: own5, assetClass: GOLD, quantity: 100, requestId: rid(), existingBalances: [old5.body] });
  check(be, 'CP10 a pre-index balance that the wallet presents is counted and adopted', old.status === 200 && presented.status === 400 && presented.body.code === 'cap' && presented.body.held === 480, [presented.status, presented.body.held]);
  const again = await A.post('/atlas/asset/issue', { ownerPublicKey: own5, assetClass: GOLD, quantity: 100, requestId: rid() });
  check(be, 'CP11 once adopted it keeps counting without being presented again', again.status === 400 && again.body.code === 'cap', [again.status, again.body.held]);
  // a forged balance is never adopted
  const own6 = owner('forge');
  const forged = JSON.parse(JSON.stringify(old5.body)); forged.owner = { publicKey: own6 }; forged.id = 'urn:atlas:asset:' + crypto.randomUUID(); forged.quantity = 490;
  const f = await A.post('/atlas/asset/issue', { ownerPublicKey: own6, assetClass: GOLD, quantity: 10, requestId: rid(), existingBalances: [forged] });
  check(be, 'CP12 a forged presented balance is ignored (not counted, not adopted)', f.status === 200, [f.status, f.body.error]);
}

async function preservation(be) {
  const A = api(be);
  const seeded = fixture.entries(fixture.REAL_COUNT);
  writeRev(be, { revoked: seeded });
  const keyBefore = fs.existsSync(be.keyFile) ? fs.readFileSync(be.keyFile, 'utf8') : null;
  const own = owner('keep');
  const gold = await mintMany(A, own, GOLD, 100, 3);
  const plat = await mintMany(A, own, PLAT, 100, 1);
  const iron = await mintMany(A, own, IRON, 100, 1);
  const unique = await A.post('/atlas/asset/issue', { ownerPublicKey: own, assetClass: 'atlas.membership' });
  check(be, 'PV1 the non-fungible asset still mints', unique.status === 200, [unique.status, unique.body.error]);
  const m = await A.post('/atlas/asset/consolidate', { credentials: gold, requestId: rid() });
  check(be, 'PV2 existing Gold merges', m.status === 200 && m.body.quantity === 300);
  const keyDuring = fs.existsSync(be.keyFile) ? fs.readFileSync(be.keyFile, 'utf8') : null;
  check(be, 'PV3 the domain key document is unchanged', keyBefore === null || keyBefore === keyDuring);
  const rev = A.revocations();
  check(be, 'PV4 all 6,127 existing revocation records are kept, in order, and exactly the 3 spent Gold balances were added',
    rev.length === seeded.length + 3 && JSON.stringify(rev.slice(0, seeded.length)) === JSON.stringify(seeded), rev.length);
  if (be.restart) {
    await be.restart();
    const platAfter = await A.post('/atlas/asset/split', { credential: plat[0], sendAmount: 10, toPublicKey: own, requestId: rid() });
    const ironAfter = await A.post('/atlas/convert', { credential: iron[0], spendAmount: 10, toClass: GOLD, requestId: rid() });
    check(be, 'PV5 credentials signed before an issuer restart are accepted afterwards', platAfter.status === 200, [platAfter.status, platAfter.body.error]);
    note(be, 'iron to gold conversion', [ironAfter.status, (ironAfter.body.error || '').slice(0, 80)]);
    const keyAfter = fs.existsSync(be.keyFile) ? fs.readFileSync(be.keyFile, 'utf8') : null;
    check(be, 'PV6 the key document survives the restart', keyBefore === null || keyAfter === keyBefore);
  }
}

async function largeRevocation(be) {
  const A = api(be);
  for (const size of QUICK ? [fixture.REAL_COUNT] : [fixture.REAL_COUNT, 20000]) {
    writeRev(be, { revoked: fixture.entries(size) });
    const own = owner('large' + size);
    const creds = await mintMany(A, own, IRON, 1, 20);
    const t0 = process.hrtime.bigint();
    const r = await A.post('/atlas/asset/consolidate', { credentials: creds, requestId: rid() });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const rev = A.revocations();
    check(be, `LR1 consolidate-20 against ${size} revocation records succeeds`, r.status === 200, [r.status, r.body.error]);
    check(be, `LR2 ${size} records kept and 20 added`, rev && rev.length === size + 20, rev && rev.length);
    note(be, `consolidate-20 at ${size} entries (ms)`, Math.round(ms));
    const par = await Promise.all(Array.from({ length: 6 }, async () => {
      const c = await mintMany(A, own, IRON, 1, 2);
      return A.post('/atlas/asset/consolidate', { credentials: c, requestId: rid() });
    }));
    const rev2 = A.revocations();
    check(be, `LR3 six parallel consolidations at ${size} entries all succeed and are all recorded`, par.every((x) => x.status === 200) && rev2.length === size + 20 + 12, [par.map((x) => x.status), rev2 && rev2.length]);
  }
}

(async () => {
  const backends = [];
  try {
    if (WHICH !== 'php') backends.push(await startNode(8371));
    if (WHICH !== 'node') backends.push(await startPhp(8372));
    for (const be of backends) {
      console.log(`\n=== ${be.kind} ===`);
      for (const [name, fn] of [['revocation integrity', revocationIntegrity], ['replay and retry', replayAndRetry], ['consolidation batches', consolidationBatches], ['holding cap', holdingCap], ['preservation', preservation], ['large revocation lists', largeRevocation]]) {
        console.log(`--- ${name}`);
        try { await fn(be); } catch (e) { failures++; console.log(`FAIL [${be.kind}] ${name} threw: ${e.stack || e}`); }
      }
    }
  } finally {
    for (const be of backends) be.stop();
  }
  console.log(`\n${checks} checks, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
