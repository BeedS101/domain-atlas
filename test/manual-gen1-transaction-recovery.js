// Crash-recovery and fail-closed tests for Gen1 fungible replacements (issue, split, consolidate,
// convert) against throw-away Node and PHP issuers. Nothing live is read or written.
//
//   node test/manual-gen1-transaction-recovery.js [node|php|both] [--quick]
//
// Crashes are simulated by ATLAS_TEST_CRASH_AT=<point>: the issuer process (Node) or the request's
// script (PHP) ends with exit code 86 at that point, so locks and in-memory state are lost exactly
// as when a process is killed. That establishes behaviour across a process stop. It does not
// establish behaviour across power loss or a file system that reorders flushed writes.
//
// --quick runs the retry path only (skips the start-up / next-request recovery variant).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { startNode, startPhp, api } = require('./lib/gen1-issuers');

const WHICH = process.argv.find((a) => ['node', 'php', 'both'].includes(a)) || 'both';
const QUICK = process.argv.includes('--quick');
const GOLD = 'atlas.element.gold';
const IRON = 'atlas.element.iron';

let failures = 0, checks = 0;
function check(be, name, ok, detail) {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} [${be.kind}] ${name}${!ok && detail !== undefined ? ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 600) : ''}`);
}
let n = 0;
const owner = (label) => 'TESTOWNER-' + label + '-' + (++n) + '-' + crypto.randomBytes(4).toString('hex');
const rid = () => crypto.randomBytes(18).toString('base64url');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const POINTS = ['txn:minted', 'txn:journal-written', 'txn:holdings-registered', 'txn:revoke-tmp-written', 'txn:revoked', 'txn:replay-stored', 'txn:journal-removed'];
// Points at which the spend is committed. For a replacement it is the revocation-list replace; an
// issue has nothing to revoke, so it is decided once its journal entry exists.
const COMMITTED = {
  replacement: new Set(['txn:revoked', 'txn:replay-stored', 'txn:journal-removed']),
  issue: new Set(['txn:journal-written', 'txn:holdings-registered', 'txn:revoked', 'txn:replay-stored', 'txn:journal-removed'])
};
const JOURNAL_PRESENT = new Set(['txn:journal-written', 'txn:holdings-registered', 'txn:revoke-tmp-written', 'txn:revoked', 'txn:replay-stored']);

const credsOf = (body) => (body && body.id && body.signature ? [body] : Object.values(body || {}).filter((v) => v && typeof v === 'object' && v.id && v.signature));
const revDoc = (be) => { try { return JSON.parse(fs.readFileSync(be.revFile, 'utf8')); } catch (e) { return null; } };
const revIds = (be) => new Set(((revDoc(be) || {}).revoked || []).map((r) => r.id));
const holdingsPath = (be, own) => path.join(be.holdingsDir, crypto.createHash('sha256').update(own).digest('hex').slice(0, 40) + '.json');
const heldList = (be, own, cls) => { try { return JSON.parse(fs.readFileSync(holdingsPath(be, own), 'utf8')).held[cls] || []; } catch (e) { return []; } };
// What the issuer counts as held: registered and not revoked.
const liveHeld = (be, owners, cls) => {
  const revoked = revIds(be);
  return owners.reduce((s, o) => s + heldList(be, o, cls).filter((h) => !revoked.has(h.id)).reduce((t, h) => t + h.q, 0), 0);
};
const journalFiles = (be) => { try { return fs.readdirSync(be.txnDir).filter((f) => f.endsWith('.json')); } catch (e) { return []; } };
// The PHP journal keeps the response as the exact JSON text it will send; Node keeps the object.
const readJournal = (be) => journalFiles(be).map((f) => {
  const rec = JSON.parse(fs.readFileSync(path.join(be.txnDir, f), 'utf8'));
  if (rec.response === undefined && typeof rec.responseJson === 'string') rec.response = JSON.parse(rec.responseJson);
  return rec;
});
const tmpFiles = (be) => be.dirsToWatch.concat([be.txnDir, be.replayDir, be.holdingsDir]).flatMap((d) => { try { return fs.readdirSync(d).filter((f) => /\.tmp$/.test(f)).map((f) => path.join(d, f)); } catch (e) { return []; } });
const writeRev = (be, doc) => fs.writeFileSync(be.revFile, be.revLayout(doc));

async function mint(A, own, cls, qty) {
  const r = await A.post('/atlas/asset/issue', { ownerPublicKey: own, assetClass: cls, quantity: qty });
  if (r.status !== 200) throw new Error('mint failed: ' + r.status + ' ' + JSON.stringify(r.body));
  return r.body;
}

// Each operation: what to mint first, the request, which credentials it spends, how much gold the
// owners hold afterwards.
const OPS = {
  issue: {
    kind: 'issue',
    prepare: async (A, own) => ({ path: '/atlas/asset/issue', body: { ownerPublicKey: own, assetClass: GOLD, quantity: 10 }, preds: [], gold: 10 })
  },
  split: {
    kind: 'replacement',
    prepare: async (A, own, other) => {
      const c = await mint(A, own, GOLD, 10);
      return { path: '/atlas/asset/split', body: { credential: c, sendAmount: 4, toPublicKey: other }, preds: [c.id], gold: 10 };
    }
  },
  consolidate: {
    kind: 'replacement',
    prepare: async (A, own) => {
      const cs = [await mint(A, own, GOLD, 5), await mint(A, own, GOLD, 5), await mint(A, own, GOLD, 5)];
      return { path: '/atlas/asset/consolidate', body: { credentials: cs }, preds: cs.map((c) => c.id), gold: 15 };
    }
  },
  convert: {
    kind: 'replacement',
    prepare: async (A, own) => {
      const c = await mint(A, own, IRON, 200);
      return { path: '/atlas/convert', body: { credential: c, spendAmount: 200, toClass: GOLD }, preds: [c.id], gold: 10 };
    }
  }
};

function crashed(be, r) {
  return r.status === 0 || (r.status === 200 && r.body && typeof r.body.error === 'string' && r.body.error.startsWith('non-json'));
}

// A successor is only worth having if the issuer will honour it: spend one.
async function spendsCleanly(A, creds, other) {
  const c = creds.find((x) => x.quantity >= 2);
  if (!c) return true;
  const r = await A.post('/atlas/asset/split', { credential: c, sendAmount: 1, toPublicKey: other, requestId: rid() });
  return r.status === 200;
}

async function scenario(be, opName, point, variant) {
  const A = api(be);
  const op = OPS[opName];
  const tag = `${opName} @ ${point} (${variant})`;
  const own = owner('c'), other = owner('o');
  const tmpBefore = new Set(tmpFiles(be));
  const freshTmp = () => tmpFiles(be).filter((f) => !tmpBefore.has(f));
  await be.restart({ ATLAS_TXN_NO_SWEEP: '1' });
  const setup = await op.prepare(A, own, other);
  const requestId = rid();
  const body = { ...setup.body, requestId };
  const goldBefore = liveHeld(be, [own, other], GOLD);

  await be.restart({ ATLAS_TEST_CRASH_AT: point, ATLAS_TXN_NO_SWEEP: '1' });
  const reachable = !(opName === 'issue' && point === 'txn:revoke-tmp-written');
  const first = await A.post(setup.path, body);
  if (!reachable) {
    check(be, `${tag}: a point this operation never reaches does not interrupt it`, first.status === 200, first.body);
    return;
  }
  const died = crashed(be, first);
  check(be, `${tag}: the request was interrupted`, died, [first.status, first.body]);
  if (be.kind === 'node') check(be, `${tag}: the process stopped with the injected exit code`, (await be.waitExit(4000)) === 86);

  const committed = COMMITTED[op.kind].has(point);
  const doc = revDoc(be);
  check(be, `${tag}: the revocation list is intact JSON`, !!doc && Array.isArray(doc.revoked));
  const revokedNow = revIds(be);
  const spentNow = setup.preds.filter((id) => revokedNow.has(id)).length;
  check(be, `${tag}: after the stop the spend is ${committed ? 'recorded' : 'not recorded'} (${spentNow}/${setup.preds.length} predecessors revoked)`,
    setup.preds.length === 0 || spentNow === (committed ? setup.preds.length : 0), spentNow);
  const journals = readJournal(be);
  check(be, `${tag}: journal entry ${JOURNAL_PRESENT.has(point) ? 'present' : 'absent'}`, journals.length === (JOURNAL_PRESENT.has(point) ? 1 : 0), journalFiles(be));
  const jr = journals[0] || null;
  if (point === 'txn:revoke-tmp-written') check(be, `${tag}: the interrupted write left only a temporary file beside an unchanged list`, freshTmp().length === 1 && setup.preds.every((id) => !revokedNow.has(id)), freshTmp());
  if (jr) {
    check(be, `${tag}: the entry holds the decided result (${jr.successors.length} successors, ${jr.predecessors.length} predecessors)`,
      jr.successors.length >= 1 && same(jr.predecessors, [...setup.preds].sort()) && jr.response && credsOf(jr.response).length === jr.successors.length, jr);
    check(be, `${tag}: committed entries carry the revocation tag; none are untagged`, !committed || setup.preds.length === 0 || (revDoc(be).revoked.filter((r) => r.txn === jr.txn).length === setup.preds.length));
  }

  if (variant === 'sweep') {
    await be.restart({ ATLAS_TXN_NO_SWEEP: '' });
    if (be.kind === 'php') await A.post('/atlas/asset/issue', { ownerPublicKey: owner('sweep'), assetClass: IRON, quantity: 1, requestId: rid() });
    for (let i = 0; i < 40 && journalFiles(be).length; i++) await sleep(150);
    check(be, `${tag}: recovery without a retry settles the journal entry`, journalFiles(be).length === 0, journalFiles(be));
    const live = liveHeld(be, [own, other], GOLD);
    if (committed) {
      check(be, `${tag}: recovered as committed — the holdings index counts exactly the successors`, live === setup.gold, [live, setup.gold]);
    } else {
      const stray = jr ? jr.successors.filter((s) => heldList(be, s.owner, GOLD).some((h) => h.id === s.id)) : [];
      check(be, `${tag}: recovered as not committed — no successor of the abandoned attempt is held`, stray.length === 0, stray);
      check(be, `${tag}: ...and the predecessors are still unspent`, setup.preds.every((id) => !revIds(be).has(id)));
    }
  } else {
    await be.restart({ ATLAS_TXN_NO_SWEEP: '1' });
  }

  const second = await A.post(setup.path, body);
  check(be, `${tag}: the same request, repeated, succeeds`, second.status === 200, [second.status, second.body]);
  const third = await A.post(setup.path, body);
  check(be, `${tag}: and a further repeat returns the identical signed result`, third.status === 200 && same(third.body, second.body));
  if (committed && jr) {
    check(be, `${tag}: the result is the one decided before the stop (same signatures)`, same(second.body, jr.response));
  }
  if (!committed && jr) {
    const firstIds = new Set(jr.successors.map((s) => s.id));
    check(be, `${tag}: the abandoned attempt's credentials are not what the retry returns`, credsOf(second.body).every((c) => !firstIds.has(c.id)));
  }
  const after = revIds(be);
  const revoked = revDoc(be).revoked;
  check(be, `${tag}: every predecessor is revoked exactly once`, setup.preds.every((id) => revoked.filter((r) => r.id === id).length === 1), setup.preds.map((id) => revoked.filter((r) => r.id === id).length));
  check(be, `${tag}: the successors are unrevoked`, credsOf(second.body).every((c) => !after.has(c.id)));
  check(be, `${tag}: the owners hold exactly the expected gold — nothing created, nothing lost`, liveHeld(be, [own, other], GOLD) === setup.gold + 0 * goldBefore, [liveHeld(be, [own, other], GOLD), setup.gold]);
  check(be, `${tag}: no journal entry and no temporary files remain`, journalFiles(be).length === 0 && freshTmp().every((f) => point === 'txn:revoke-tmp-written'), [journalFiles(be), freshTmp()]);
  for (const f of freshTmp()) fs.rmSync(f, { force: true });
  check(be, `${tag}: a successor is accepted when spent`, await spendsCleanly(A, credsOf(second.body), other));
}

async function crashMatrix(be) {
  console.log(`\n--- ${be.kind}: stopping each operation at each step ---`);
  for (const opName of Object.keys(OPS)) {
    for (const point of POINTS) {
      await scenario(be, opName, point, 'retry');
      if (!QUICK) await scenario(be, opName, point, 'sweep');
    }
  }
}

async function noRequestId(be) {
  console.log(`\n--- ${be.kind}: operations without a requestId ---`);
  const A = api(be);
  const own = owner('nr'), other = owner('nr2');
  await be.restart({ ATLAS_TXN_NO_SWEEP: '1' });
  const c = await mint(A, own, GOLD, 10);
  await be.restart({ ATLAS_TEST_CRASH_AT: 'txn:journal-written', ATLAS_TXN_NO_SWEEP: '1' });
  const r = await A.post('/atlas/asset/split', { credential: c, sendAmount: 3, toPublicKey: other });
  check(be, 'NR1 a split without requestId stopped after its journal entry', crashed(be, r) && journalFiles(be).length === 1);
  check(be, 'NR2 the predecessor is not yet spent', !revIds(be).has(c.id));
  await be.restart({ ATLAS_TXN_NO_SWEEP: '' });
  if (be.kind === 'php') await A.post('/atlas/asset/issue', { ownerPublicKey: owner('s'), assetClass: IRON, quantity: 1, requestId: rid() });
  for (let i = 0; i < 40 && journalFiles(be).length; i++) await sleep(150);
  check(be, 'NR3 recovery settles the entry on its own', journalFiles(be).length === 0);
  check(be, 'NR4 the uncommitted spend is rolled back: predecessor spendable, nothing extra held', !revIds(be).has(c.id) && liveHeld(be, [own, other], GOLD) === 10, liveHeld(be, [own, other], GOLD));
  const again = await A.post('/atlas/asset/split', { credential: c, sendAmount: 3, toPublicKey: other });
  check(be, 'NR5 the same balance is then split normally', again.status === 200, [again.status, again.body]);
  check(be, 'NR6 holdings are exact afterwards', liveHeld(be, [own, other], GOLD) === 10);
}

async function failClosedWrites(be) {
  console.log(`\n--- ${be.kind}: unwritable directories, interrupted and malformed lists (issuer running as an unprivileged user) ---`);
  const A = api(be);
  const wk = path.dirname(be.revFile);
  const own = owner('fc'), other = owner('fc2');
  const bytes = () => fs.readFileSync(be.revFile);

  // Make the target file itself writable so an in-place fallback would succeed if one existed.
  writeRev(be, { revoked: [{ id: 'urn:atlas:asset:old-1', revokedAt: '2026-01-01T00:00:00Z', reason: 'superseded' }] });
  fs.chmodSync(be.revFile, 0o666);
  require('child_process').execFileSync('chown', ['-R', '65534:65534', wk]);
  const c = await mint(A, own, GOLD, 10);
  const cs = [await mint(A, own, GOLD, 4), await mint(A, own, GOLD, 4)];
  const iron = await mint(A, own, IRON, 100);
  const before = bytes();
  fs.chmodSync(wk, 0o555);
  const attempts = [
    ['split', '/atlas/asset/split', { credential: c, sendAmount: 3, toPublicKey: other, requestId: rid() }, [c.id]],
    ['consolidate', '/atlas/asset/consolidate', { credentials: cs, requestId: rid() }, cs.map((x) => x.id)],
    ['convert', '/atlas/convert', { credential: iron, spendAmount: 100, toClass: GOLD, requestId: rid() }, [iron.id]]
  ];
  const heldBefore = heldList(be, own, GOLD).length;
  for (const [name, p, b, preds] of attempts) {
    const r = await A.post(p, b);
    check(be, `FC1 ${name} in an unwritable directory: controlled 503, not a crash`, r.status === 503 && typeof r.body.error === 'string' && !/stack|at .*\.js|Fatal|\.php/i.test(r.body.error), [r.status, r.body]);
    check(be, `FC1 ${name}: the existing revocation file is byte-for-byte unchanged (no in-place write)`, Buffer.compare(before, bytes()) === 0);
    check(be, `FC1 ${name}: no temporary file left behind`, tmpFiles(be).length === 0, tmpFiles(be));
    check(be, `FC1 ${name}: no journal entry left behind`, journalFiles(be).length === 0, journalFiles(be));
    check(be, `FC1 ${name}: nothing from the failed attempt stays in the holdings index`, heldList(be, own, GOLD).length === heldBefore && heldList(be, other, GOLD).length === 0, [heldList(be, own, GOLD).length, heldBefore]);
    check(be, `FC1 ${name}: the balances are not spent`, preds.every((id) => !revIds(be).has(id)));
  }
  const issue = await A.post('/atlas/asset/issue', { ownerPublicKey: owner('fc3'), assetClass: GOLD, quantity: 5, requestId: rid() });
  check(be, 'FC2 an issue spends nothing, so an unwritable revocation directory does not stop it', issue.status === 200, [issue.status, issue.body]);
  fs.chmodSync(wk, 0o755);
  for (const [name, p, b, preds] of attempts) {
    const r = await A.post(p, b);
    check(be, `FC3 ${name}: once the directory is writable, the same request succeeds`, r.status === 200, [r.status, r.body]);
    check(be, `FC3 ${name}: and records the spend`, preds.every((id) => revIds(be).has(id)));
  }
  check(be, 'FC3 the pre-existing entry is still first and untouched', (revDoc(be).revoked[0] || {}).id === 'urn:atlas:asset:old-1');
  check(be, 'FC3 the file mode is preserved across the atomic replace', (fs.statSync(be.revFile).mode & 0o777) === 0o666, (fs.statSync(be.revFile).mode & 0o777).toString(8));

  // The journal directory unwritable: refused before anything is spent.
  const c2 = await mint(A, own, GOLD, 8);
  const beforeJ = bytes();
  fs.mkdirSync(be.txnDir, { recursive: true });
  require('child_process').execFileSync('chown', ['-R', '65534:65534', be.txnDir]);
  fs.chmodSync(be.txnDir, 0o555);
  const rj = await A.post('/atlas/asset/split', { credential: c2, sendAmount: 2, toPublicKey: other, requestId: rid() });
  check(be, 'FC4 a journal that cannot be written refuses the spend with 503', rj.status === 503, [rj.status, rj.body]);
  check(be, 'FC4 ...before anything is recorded: list unchanged, balance unspent', Buffer.compare(beforeJ, bytes()) === 0 && !revIds(be).has(c2.id));
  fs.chmodSync(be.txnDir, 0o755);
  const rj2 = await A.post('/atlas/asset/split', { credential: c2, sendAmount: 2, toPublicKey: other, requestId: rid() });
  check(be, 'FC4 ...and works once it can', rj2.status === 200, [rj2.status, rj2.body]);

  // A malformed list: refused, never replaced, never treated as empty.
  const c3 = await mint(A, own, GOLD, 8);
  for (const [name, text] of Object.entries({ truncated: '{"revoked":[{"id":"x","revok', empty: '', 'wrong shape': '{"revoked":"no"}' })) {
    fs.writeFileSync(be.revFile, text);
    const r = await A.post('/atlas/asset/split', { credential: c3, sendAmount: 1, toPublicKey: other, requestId: rid() });
    check(be, `FC5 ${name} list: 503 and the file is left exactly as found`, r.status === 503 && fs.readFileSync(be.revFile, 'utf8') === text, [r.status, r.body]);
    check(be, `FC5 ${name} list: no journal entry or temporary file left`, journalFiles(be).length === 0 && tmpFiles(be).length === 0);
  }
  writeRev(be, { revoked: [] });
  fs.chmodSync(be.revFile, 0o644);
}

async function interruptedWrite(be) {
  console.log(`\n--- ${be.kind}: interrupted revocation write and stale temporary files ---`);
  const A = api(be);
  const own = owner('iw'), other = owner('iw2');
  for (const f of tmpFiles(be)) fs.rmSync(f, { force: true });
  await be.restart({ ATLAS_TXN_NO_SWEEP: '1' });
  writeRev(be, { revoked: [{ id: 'urn:atlas:asset:keep', revokedAt: '2026-01-01T00:00:00Z', reason: 'superseded' }] });
  const c = await mint(A, own, GOLD, 10);
  const before = fs.readFileSync(be.revFile);
  await be.restart({ ATLAS_TEST_CRASH_AT: 'txn:revoke-tmp-written', ATLAS_TXN_NO_SWEEP: '1' });
  const rid1 = rid();
  const r = await A.post('/atlas/asset/split', { credential: c, sendAmount: 5, toPublicKey: other, requestId: rid1 });
  check(be, 'IW1 the write was interrupted after the temporary file was complete', crashed(be, r));
  const leftovers = tmpFiles(be);
  check(be, 'IW2 the live revocation list is byte-for-byte what it was', Buffer.compare(before, fs.readFileSync(be.revFile)) === 0);
  check(be, 'IW3 the interrupted write left a temporary file, not a partial list', leftovers.length === 1 && (() => { try { JSON.parse(fs.readFileSync(leftovers[0], 'utf8')); return true; } catch (e) { return false; } })(), leftovers);
  check(be, 'IW4 a fresh temporary file is not removed prematurely', (await (async () => { await be.restart({ ATLAS_TXN_NO_SWEEP: '' }); if (be.kind === 'php') await A.post('/atlas/asset/issue', { ownerPublicKey: owner('s'), assetClass: IRON, quantity: 1, requestId: rid() }); await sleep(600); return tmpFiles(be).includes(leftovers[0]); })()));
  const old = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(leftovers[0], old, old);
  await be.restart({ ATLAS_TXN_NO_SWEEP: '' });
  if (be.kind === 'php') await A.post('/atlas/asset/issue', { ownerPublicKey: owner('s'), assetClass: IRON, quantity: 1, requestId: rid() });
  for (let i = 0; i < 30 && tmpFiles(be).length; i++) await sleep(150);
  check(be, 'IW5 a temporary file older than five minutes is cleaned up', tmpFiles(be).length === 0, tmpFiles(be));
  check(be, 'IW6 the abandoned attempt was rolled back; the balance is unspent', !revIds(be).has(c.id) && journalFiles(be).length === 0);
  const again = await A.post('/atlas/asset/split', { credential: c, sendAmount: 5, toPublicKey: other, requestId: rid1 });
  check(be, 'IW7 the same request then completes', again.status === 200, [again.status, again.body]);
  check(be, 'IW8 the older entry survives and the list is valid', (revDoc(be).revoked[0] || {}).id === 'urn:atlas:asset:keep' && revIds(be).has(c.id));
}

async function recoveryNeverGuesses(be) {
  console.log(`\n--- ${be.kind}: recovery with an unreadable list, a half-recorded transaction, a damaged entry ---`);
  const A = api(be);
  const own = owner('ng'), other = owner('ng2');
  await be.restart({ ATLAS_TXN_NO_SWEEP: '1' });
  writeRev(be, { revoked: [] });
  const cs = [await mint(A, own, GOLD, 3), await mint(A, own, GOLD, 3), await mint(A, own, GOLD, 3)];
  await be.restart({ ATLAS_TEST_CRASH_AT: 'txn:journal-written', ATLAS_TXN_NO_SWEEP: '1' });
  const requestId = rid();
  const body = { credentials: cs, requestId };
  await A.post('/atlas/asset/consolidate', body);
  await be.restart({ ATLAS_TXN_NO_SWEEP: '1' });
  const jrFile = path.join(be.txnDir, journalFiles(be)[0]);
  const jrText = fs.readFileSync(jrFile, 'utf8');
  const jr = JSON.parse(jrText);

  // (a) unreadable list: the entry cannot be judged, so it stays.
  const good = fs.readFileSync(be.revFile);
  fs.writeFileSync(be.revFile, '{broken');
  const a = await A.post('/atlas/asset/consolidate', body);
  check(be, 'NG1 with the revocation list unreadable the retry is refused (503)', a.status === 503, [a.status, a.body]);
  check(be, 'NG2 ...the list and the journal entry are left exactly as found', fs.readFileSync(be.revFile, 'utf8') === '{broken' && fs.readFileSync(jrFile, 'utf8') === jrText);
  fs.writeFileSync(be.revFile, good);

  // (b) half-recorded: one of three predecessors tagged. A single atomic replace cannot produce this.
  const half = { revoked: [{ id: cs[0].id, revokedAt: '2026-01-01T00:00:00Z', reason: 'consolidated', txn: jr.txn }] };
  writeRev(be, half);
  const halfBytes = fs.readFileSync(be.revFile);
  const b = await A.post('/atlas/asset/consolidate', body);
  check(be, 'NG3 a half-recorded transaction is refused (503), not guessed at', b.status === 503, [b.status, b.body]);
  check(be, 'NG4 ...nothing is changed: list and entry as found', Buffer.compare(halfBytes, fs.readFileSync(be.revFile)) === 0 && fs.readFileSync(jrFile, 'utf8') === jrText);
  writeRev(be, { revoked: [] });

  // (c) a damaged journal entry.
  fs.writeFileSync(jrFile, '{"txn":');
  const c = await A.post('/atlas/asset/consolidate', body);
  check(be, 'NG5 a damaged journal entry is refused (503), not ignored', c.status === 503, [c.status, c.body]);
  check(be, 'NG6 ...nothing is spent meanwhile', cs.every((x) => !revIds(be).has(x.id)));
  fs.writeFileSync(jrFile, jrText);
  const d = await A.post('/atlas/asset/consolidate', body);
  check(be, 'NG7 with the entry restored the retry completes', d.status === 200 && d.body.quantity === 9, [d.status, d.body]);
}

async function concurrency(be) {
  console.log(`\n--- ${be.kind}: concurrent updates ---`);
  const A = api(be);
  await be.restart({ ATLAS_TXN_NO_SWEEP: '1' });
  const base = [];
  for (let i = 0; i < 20; i++) base.push({ own: owner('cc'), c: null });
  for (const b of base) b.c = await mint(A, b.own, GOLD, 6);
  const trios = [];
  for (let i = 0; i < 6; i++) { const o = owner('ct'); trios.push({ own: o, cs: [await mint(A, o, GOLD, 2), await mint(A, o, GOLD, 2), await mint(A, o, GOLD, 2)] }); }
  const irons = [];
  for (let i = 0; i < 6; i++) { const o = owner('ci'); irons.push({ own: o, c: await mint(A, o, IRON, 100) }); }
  writeRev(be, { revoked: [{ id: 'urn:atlas:asset:before', revokedAt: '2026-01-01T00:00:00Z', reason: 'superseded' }] });
  const preds = [...base.map((b) => b.c.id), ...trios.flatMap((t) => t.cs.map((x) => x.id)), ...irons.map((x) => x.c.id)];
  const reqs = [
    ...base.map((b) => A.post('/atlas/asset/split', { credential: b.c, sendAmount: 2, toPublicKey: owner('r'), requestId: rid() })),
    ...trios.map((t) => A.post('/atlas/asset/consolidate', { credentials: t.cs, requestId: rid() })),
    ...irons.map((x) => A.post('/atlas/convert', { credential: x.c, spendAmount: 100, toClass: GOLD, requestId: rid() })),
    ...Array.from({ length: 10 }, () => A.post('/atlas/asset/issue', { ownerPublicKey: owner('ci2'), assetClass: GOLD, quantity: 1, requestId: rid() }))
  ];
  const results = await Promise.all(reqs);
  check(be, 'CC1 every one of 42 simultaneous operations succeeds', results.every((r) => r.status === 200), results.filter((r) => r.status !== 200).map((r) => [r.status, r.body.error]));
  const doc = revDoc(be);
  check(be, 'CC2 the revocation list is valid JSON and keeps the earlier entry first', !!doc && doc.revoked[0].id === 'urn:atlas:asset:before');
  const counts = new Map();
  for (const r of doc.revoked) counts.set(r.id, (counts.get(r.id) || 0) + 1);
  check(be, 'CC3 every spent balance appears exactly once', preds.every((id) => counts.get(id) === 1), preds.filter((id) => counts.get(id) !== 1).length);
  check(be, 'CC4 every new entry is tagged with its transaction', doc.revoked.slice(1).every((r) => typeof r.txn === 'string' && r.txn.length > 0));
  check(be, 'CC5 consolidated balances share one tag per consolidation; nothing is split across tags', trios.every((t) => new Set(t.cs.map((x) => doc.revoked.find((r) => r.id === x.id).txn)).size === 1));
  check(be, 'CC6 no journal entries and no temporary files remain', journalFiles(be).length === 0 && tmpFiles(be).length === 0, [journalFiles(be), tmpFiles(be)]);
  // Same requestId from many callers while a competing spend of the same balance arrives.
  const c = await mint(A, owner('cd'), GOLD, 9);
  const id1 = rid(), id2 = rid();
  const racers = await Promise.all([
    A.post('/atlas/asset/split', { credential: c, sendAmount: 3, toPublicKey: owner('r'), requestId: id1 }),
    A.post('/atlas/asset/split', { credential: c, sendAmount: 3, toPublicKey: owner('r'), requestId: id1 }),
    A.post('/atlas/asset/split', { credential: c, sendAmount: 4, toPublicKey: owner('r'), requestId: id2 }),
    A.post('/atlas/asset/split', { credential: c, sendAmount: 4, toPublicKey: owner('r'), requestId: id2 })
  ]);
  const wins = racers.filter((r) => r.status === 200);
  const winners = new Set(wins.map((r) => JSON.stringify(r.body)));
  check(be, 'CC7 two competing spends of one balance: only one request id wins, its callers all get that one result', winners.size === 1, racers.map((r) => [r.status, r.body.code || r.body.error]));
  check(be, 'CC8 the balance is revoked exactly once', revDoc(be).revoked.filter((r) => r.id === c.id).length === 1);
}

(async () => {
  const backends = [];
  try {
    if (WHICH !== 'php') backends.push(await startNode(18701));
    if (WHICH !== 'node') backends.push(await startPhp(18702, { workers: 0 }));
    for (const be of backends) {
      await crashMatrix(be);
      await noRequestId(be);
      await interruptedWrite(be);
      await recoveryNeverGuesses(be);
      await concurrency(be);
    }
    const unpriv = [];
    try {
      if (WHICH !== 'php') unpriv.push(await startNode(18703, { user: 'nobody' }));
      if (WHICH !== 'node') unpriv.push(await startPhp(18704, { user: 'nobody', workers: 0 }));
      for (const be of unpriv) { writeRev(be, { revoked: [] }); fs.chmodSync(path.dirname(be.revFile), 0o755); await failClosedWrites(be); }
    } finally { unpriv.forEach((b) => b.stop()); }
  } catch (e) {
    failures++;
    console.log('FAIL harness :: ' + (e && e.stack || e));
  } finally {
    backends.forEach((b) => b.stop());
  }
  console.log(`\nmanual-gen1-transaction-recovery: ${checks - failures} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
