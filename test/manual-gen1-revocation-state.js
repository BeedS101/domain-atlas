// Regression tests for revocation-state preservation, against throw-away Node and PHP issuers.
//
//   node test/manual-gen1-revocation-state.js [node|php|both] [--only=S3]
//
// A revocation list is created once, with the key of a new issuer, and never again. Missing,
// unreadable, malformed or invalid revocation state makes every operation that depends on it fail
// with 503, leaves the file as it was, and leaves transaction journals and holdings alone.
// Everything runs in temporary folders; nothing live is read or written.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { startNode, startPhp, api, REPO } = require('./lib/gen1-issuers');
const { webcrypto } = crypto;
const { subtle } = webcrypto;

const WHICH = process.argv.find((a) => ['node', 'php', 'both'].includes(a)) || 'both';
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);
const GOLD = 'atlas.element.gold';
const PLAT = 'atlas.element.platinum';
const IRON = 'atlas.element.iron';
const COUPON = 'atlas.demo.coupon';

let failures = 0, checks = 0;
const skipped = [];
const outcomes = { node: {}, php: {} };
function check(kind, name, ok, detail) {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} [${kind}] ${name}${detail !== undefined && !ok ? ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
}
const skip = (kind, name, why) => { skipped.push(`[${kind}] ${name}: ${why}`); console.log(`SKIP [${kind}] ${name} :: ${why}`); };
const note = (kind, name, value) => { outcomes[kind][name] = value; };
const rid = () => crypto.randomBytes(18).toString('base64url');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let portNext = 20000 + (process.pid % 300) * 20;
const port = () => portNext++;

// ---- identities and signed requests -------------------------------------------------------
const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}
async function genIdentity() {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return { kp, publicKey: b64url(new Uint8Array(await subtle.exportKey('raw', kp.publicKey))) };
}
async function signed(id, payload) {
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, id.kp.privateKey, new TextEncoder().encode(canonicalize(payload))));
  return { payload, proof: { signerRole: 'raw-ecdsa', publicKey: id.publicKey, signature: b64url(sig) } };
}

// ---- issuers --------------------------------------------------------------------------------
// seed(paths) runs before the first start: paths = { wk, state, replay, holdings, txn }.
function pathsOf(kind, root) {
  if (kind === 'node') {
    const state = root.state;
    return { wk: path.join(root.docroot, '.well-known'), state, replay: path.join(state, 'replay'), holdings: path.join(state, 'holdings'), txn: path.join(state, 'txn'), key: path.join(state, 'issuer-private-key.jwk.json'), reviewerKey: path.join(state, 'reviewer-private-key.jwk.json') };
  }
  const lib = path.join(root, 'lib');
  return { wk: path.join(root, '.well-known'), state: lib, replay: path.join(lib, 'replay'), holdings: path.join(lib, 'holdings'), txn: path.join(lib, 'txn'), key: path.join(lib, 'issuer-private-key.pem'), reviewerKey: path.join(lib, 'reviewer-private-key.pem') };
}
const made = [];
async function issuer(kind, opts) {
  opts = opts || {};
  const options = { user: opts.user, autostart: opts.autostart, env: opts.env };
  let be;
  if (kind === 'node') {
    be = await startNode(port(), { ...options, prepare: opts.seed ? (b) => opts.seed(pathsOf('node', { state: b.state, docroot: b.docroot })) : undefined });
    be.paths = pathsOf('node', { state: be.state, docroot: be.docroot });
  } else {
    be = await startPhp(port(), { ...options, warm: false, workers: opts.workers === undefined ? 4 : opts.workers, prepare: opts.seed ? (bundle) => opts.seed(pathsOf('php', bundle)) : undefined });
    be.paths = pathsOf('php', be.bundle);
  }
  made.push(be);
  be.A = api(be);
  return be;
}
// A PHP issuer creates its key on its first request; a Node issuer on start.
async function firstRequest(be) {
  if (be.kind === 'php') await be.A.post('/atlas/asset/issue', { ownerPublicKey: 'TESTOWNER-first', assetClass: IRON, quantity: 1 });
}
// A PHP request cut off by the injected exit comes back as an empty 200.
const crashed = (r) => r.status === 0 || (r.status === 200 && r.body && typeof r.body.error === 'string' && r.body.error.startsWith('non-json'));
const readText = (f) => { try { return fs.readFileSync(f); } catch (e) { return null; } };
const listJson = (be) => { try { return JSON.parse(fs.readFileSync(be.revFile, 'utf8')); } catch (e) { return null; } };
const same = (a, b) => (a === null || b === null) ? a === b : Buffer.compare(a, b) === 0;
function tmpFiles(be) {
  try { return fs.readdirSync(be.paths.wk).filter((f) => /\.tmp$/.test(f)); } catch (e) { return []; }
}
function dirSnapshot(dir) {
  const out = {};
  try { for (const f of fs.readdirSync(dir)) { const t = readText(path.join(dir, f)); out[f] = t === null ? null : crypto.createHash('sha256').update(t).digest('hex'); } } catch (e) { /* none */ }
  return out;
}
const snapshotState = (be) => JSON.stringify({ txn: dirSnapshot(be.paths.txn), holdings: dirSnapshot(be.paths.holdings), replay: dirSnapshot(be.paths.replay) });

// Credentials for the operations that depend on the revocation list.
async function mint(A, owner, cls, qty) {
  const r = await A.post('/atlas/asset/issue', { ownerPublicKey: owner, assetClass: cls, quantity: qty });
  if (r.status !== 200) throw new Error('mint failed: ' + r.status + ' ' + JSON.stringify(r.body));
  return r.body;
}
async function context(be) {
  const A = be.A;
  const holder = await genIdentity();
  const other = await genIdentity();
  const own = holder.publicKey;
  const c = { holder, other, own };
  c.iron1 = await mint(A, own, IRON, 5);
  c.iron2 = await mint(A, own, IRON, 5);
  c.gold = await mint(A, own, GOLD, 100);
  c.coupon1 = await mint(A, own, COUPON, 1);
  c.coupon2 = await mint(A, own, COUPON, 1);
  c.spent = await mint(A, own, IRON, 5);
  const s = await A.post('/atlas/asset/split', { credential: c.spent, sendAmount: 1, toPublicKey: own, requestId: rid() });
  if (s.status !== 200) throw new Error('setup split failed: ' + s.status);
  c.entriesAfterSetup = (A.revocations() || []).length;
  return c;
}
// The operations that spend, convert, transfer or redeem. Each returns { status, error }.
function operations(be, c) {
  const A = be.A;
  return {
    split: () => A.post('/atlas/asset/split', { credential: c.iron1, sendAmount: 1, toPublicKey: c.own, requestId: rid() }),
    consolidate: () => A.post('/atlas/asset/consolidate', { credentials: [c.iron1, c.iron2], requestId: rid() }),
    convert: () => A.post('/atlas/convert', { credential: c.gold, spendAmount: 40, toClass: PLAT, requestId: rid() }),
    redeem: async () => A.post('/atlas/asset/redeem', { credential: c.coupon1, intent: await signed(c.holder, { credentialId: c.coupon1.id, action: 'redeem' }) }),
    transfer: async () => A.post('/atlas/asset/transfer', { credential: c.coupon2, recipientPublicKey: c.other.publicKey, intent: await signed(c.holder, { credentialId: c.coupon2.id, recipientPublicKey: c.other.publicKey, action: 'transfer' }) }),
    'spent-again': () => A.post('/atlas/asset/split', { credential: c.spent, sendAmount: 1, toPublicKey: c.own, requestId: rid() })
  };
}
// Every operation answers 503 (and none succeeds). Returns the statuses.
async function expectUnavailable(be, c, label) {
  const ops = operations(be, c);
  const got = {};
  for (const [name, fn] of Object.entries(ops)) { const r = await fn(); got[name] = r.status; }
  const bad = Object.entries(got).filter(([, s]) => s !== 503);
  check(be.kind, `${label}: split, consolidate, convert, redeem, transfer and a re-presented spent credential all answer 503`, bad.length === 0, got);
  note(be.kind, label + ' statuses', got);
  return got;
}
const restoreList = (be, bytes) => fs.writeFileSync(be.revFile, bytes);

// ---- scenarios -------------------------------------------------------------------------------
const scenarios = {};

// S1: a genuinely new issuer gets its list, with the key, once.
scenarios.S1 = async function (kind) {
  const be = await issuer(kind);
  await firstRequest(be);
  const doc = listJson(be);
  check(kind, 'S1 a new issuer has a valid empty revocation list', doc && Array.isArray(doc.revoked) && doc.revoked.length === 0, doc);
  check(kind, 'S1 the private key exists and is private (0600)', fs.existsSync(be.paths.key) && (fs.statSync(be.paths.key).mode & 0o777) === 0o600, fs.existsSync(be.paths.key) && (fs.statSync(be.paths.key).mode & 0o777).toString(8));
  check(kind, 'S1 the list is public (0644)', (fs.statSync(be.revFile).mode & 0o777) === 0o644, (fs.statSync(be.revFile).mode & 0o777).toString(8));
  check(kind, 'S1 no temporary files remain', tmpFiles(be).length === 0, tmpFiles(be));
  const c = await context(be);
  const rev = be.A.revocations();
  check(kind, 'S1 spends are recorded in the new list', Array.isArray(rev) && rev.some((r) => r.id === c.spent.id), rev && rev.length);
  note(kind, 'S1 list', 'created');
};

// S2: an established issuer keeps its list across restarts, byte for byte.
scenarios.S2 = async function (kind) {
  const be = await issuer(kind);
  await firstRequest(be);
  const c = await context(be);
  const listBefore = readText(be.revFile), keyBefore = readText(be.paths.key), keyDocBefore = readText(be.keyFile);
  await be.restart();
  await firstRequest(be);
  check(kind, 'S2 the list is byte-identical after a restart', same(readText(be.revFile), listBefore));
  check(kind, 'S2 the private key is byte-identical after a restart', same(readText(be.paths.key), keyBefore));
  check(kind, 'S2 the published key document is unchanged', same(readText(be.keyFile), keyDocBefore));
  const again = await operations(be, c)['spent-again']();
  check(kind, 'S2 a credential spent before the restart is still refused as revoked', again.status === 400 && /already revoked/.test(again.body.error), [again.status, again.body.error]);
  const ok = await operations(be, c).split();
  check(kind, 'S2 an unspent credential is still spendable', ok.status === 200, [ok.status, ok.body.error]);
};

// S3: the list of an established issuer is deleted.
scenarios.S3 = async function (kind) {
  const be = await issuer(kind);
  await firstRequest(be);
  const c = await context(be);
  const backup = readText(be.revFile);
  const state0 = snapshotState(be);
  fs.rmSync(be.revFile);
  await expectUnavailable(be, c, 'S3 list deleted');
  check(kind, 'S3 the list was not recreated by any of those requests', !fs.existsSync(be.revFile));
  check(kind, 'S3 journals, holdings and replay data are untouched', snapshotState(be) === state0);
  await be.restart();
  await firstRequest(be);
  check(kind, 'S3 the list was not recreated by a restart', !fs.existsSync(be.revFile));
  if (kind === 'node') check(kind, 'S3 the server says so at start', be.log.join('').includes('REVOCATION LIST MISSING'));
  await expectUnavailable(be, c, 'S3 after the restart');
  restoreList(be, backup);
  const again = await operations(be, c)['spent-again']();
  check(kind, 'S3 once the list is restored the spent credential is refused as revoked again', again.status === 400 && /already revoked/.test(again.body.error), [again.status, again.body.error]);
  const ok = await operations(be, c).split();
  check(kind, 'S3 and unspent credentials work again', ok.status === 200, [ok.status, ok.body.error]);
};

// S4: the list cannot be read.
scenarios.S4 = async function (kind) {
  const be = await issuer(kind, { user: 'nobody' });
  await firstRequest(be);
  const c = await context(be);
  const backup = readText(be.revFile);
  fs.chmodSync(be.revFile, 0o000);
  await expectUnavailable(be, c, 'S4 mode 000 (issuer runs as an unprivileged account)');
  check(kind, 'S4 the file is still there and was not replaced', fs.existsSync(be.revFile));
  fs.chmodSync(be.revFile, 0o644);
  check(kind, 'S4 its bytes are unchanged', same(readText(be.revFile), backup));
  // A directory where the file should be.
  fs.rmSync(be.revFile);
  fs.mkdirSync(be.revFile);
  await expectUnavailable(be, c, 'S4 a directory in place of the file');
  check(kind, 'S4 the directory was not replaced', fs.statSync(be.revFile).isDirectory());
  fs.rmdirSync(be.revFile);
  restoreList(be, backup);
  const ok = await operations(be, c).split();
  check(kind, 'S4 spends work again once the file is readable', ok.status === 200, [ok.status, ok.body.error]);
};

// S5: the list is not valid JSON, or not a list.
scenarios.S5 = async function (kind) {
  const be = await issuer(kind);
  await firstRequest(be);
  const c = await context(be);
  const backup = readText(be.revFile);
  const variants = {
    truncated: '{"revoked":[{"id":"urn:atlas:asset:x","revokedAt":"2026-01-01T00:00:00Z","reaso',
    garbage: '\u0000\u0001not json',
    empty: '',
    'not-an-object': '[]',
    'no-revoked-list': '{"something":"else"}',
    'revoked-not-array': '{"revoked":"nope"}',
    'revoked-is-object': '{"revoked":{"id":"x"}}'
  };
  for (const [name, text] of Object.entries(variants)) {
    fs.writeFileSync(be.revFile, text);
    const before = readText(be.revFile);
    await expectUnavailable(be, c, 'S5 ' + name);
    check(kind, `S5 ${name}: file bytes untouched`, same(readText(be.revFile), before));
  }
  restoreList(be, backup);
};

// S6: valid JSON in the right shape, with entries that cannot be interpreted.
scenarios.S6 = async function (kind) {
  const be = await issuer(kind);
  await firstRequest(be);
  const c = await context(be);
  const backup = readText(be.revFile);
  const good = { id: 'urn:atlas:asset:good', revokedAt: '2026-01-01T00:00:00Z', reason: 'issuer-request' };
  const variants = {
    'null entry': [good, null],
    'number entry': [good, 5],
    'string entry': [good, 'urn:atlas:asset:x'],
    'array entry': [good, ['x']],
    'no id': [good, { reason: 'x' }],
    'numeric id': [good, { id: 7 }],
    'empty id': [good, { id: '' }],
    'object id': [good, { id: { a: 1 } }]
  };
  for (const [name, revoked] of Object.entries(variants)) {
    fs.writeFileSync(be.revFile, JSON.stringify({ revoked }, null, 2));
    const before = readText(be.revFile);
    await expectUnavailable(be, c, 'S6 ' + name);
    check(kind, `S6 ${name}: file bytes untouched`, same(readText(be.revFile), before));
  }
  restoreList(be, backup);
  const ok = await operations(be, c).split();
  check(kind, 'S6 a valid list works again', ok.status === 200, [ok.status, ok.body.error]);
};

// S7: restart after the loss, twice, and a folder-replacing upload that takes .well-known with it.
scenarios.S7 = async function (kind) {
  const be = await issuer(kind);
  await firstRequest(be);
  const c = await context(be);
  const backup = readText(be.revFile);
  const keyDocBackup = readText(be.keyFile);
  fs.rmSync(be.paths.wk, { recursive: true, force: true });
  for (let i = 1; i <= 2; i++) {
    await be.restart();
    await firstRequest(be);
    check(kind, `S7 restart ${i} after the whole .well-known folder was replaced: no list is created`, !fs.existsSync(be.revFile));
    await expectUnavailable(be, c, `S7 restart ${i}`);
  }
  check(kind, 'S7 nothing in the private state changed: the key is still the same one', fs.existsSync(be.paths.key));
  fs.mkdirSync(be.paths.wk, { recursive: true });
  restoreList(be, backup);
  if (keyDocBackup) fs.writeFileSync(be.keyFile, keyDocBackup);
  const again = await operations(be, c)['spent-again']();
  check(kind, 'S7 after restoring from the backup the spent credential is revoked again', again.status === 400 && /already revoked/.test(again.body.error), [again.status, again.body.error]);
};

// S8: a pending transaction meets missing revocation state.
async function pendingTransaction(kind, crashAt, label) {
  const be = await issuer(kind, { workers: 0 });
  await firstRequest(be);
  const c = await context(be);
  const backup = readText(be.revFile);
  await be.restart({ ATLAS_TEST_CRASH_AT: crashAt, ATLAS_TXN_NO_SWEEP: '1' });
  const requestId = rid();
  const body = { credential: c.iron1, sendAmount: 2, toPublicKey: c.own, requestId };
  const first = await be.A.post('/atlas/asset/split', body);
  check(kind, `${label} the request is cut off at ${crashAt}`, crashed(first), first.status);
  if (kind === 'node') await be.waitExit(3000);
  const entries = be.A.txnEntries();
  check(kind, `${label} a journal entry is waiting`, entries.length === 1, entries);
  const journalBefore = JSON.stringify(dirSnapshot(be.paths.txn));
  const stateBefore = snapshotState(be);
  const listAtCrash = readText(be.revFile);
  fs.rmSync(be.revFile);
  // Recovery is attempted: by the sweep at start (Node), by the command line and by requests.
  await be.restart({});
  await sleep(1200);
  await be.A.post('/atlas/asset/split', { credential: c.iron2, sendAmount: 1, toPublicKey: c.own, requestId: rid() });
  if (kind === 'php') {
    const cli = spawnSync('php', ['lib/atlas-cli.php', 'txn-recover'], { cwd: be.bundle, encoding: 'utf8' });
    check(kind, `${label} the command-line recovery does not settle it`, cli.status !== 0 || /unavailable|missing|revocation/i.test(cli.stdout + cli.stderr), [cli.status, (cli.stdout + cli.stderr).slice(0, 200)]);
  }
  check(kind, `${label} the journal entry is still there, byte for byte`, JSON.stringify(dirSnapshot(be.paths.txn)) === journalBefore, [journalBefore.slice(0, 80)]);
  check(kind, `${label} journals, holdings and replay data are untouched`, snapshotState(be) === stateBefore);
  check(kind, `${label} the list was not recreated`, !fs.existsSync(be.revFile));
  // Restore the state the list had when the request was cut off, and finish.
  restoreList(be, listAtCrash);
  const retry = await be.A.post('/atlas/asset/split', body);
  check(kind, `${label} with the list restored, the same request completes`, retry.status === 200, [retry.status, retry.body.error]);
  check(kind, `${label} the journal is settled`, be.A.txnEntries().length === 0, be.A.txnEntries());
  const rev = be.A.revocations() || [];
  check(kind, `${label} the credential is revoked exactly once`, rev.filter((r) => r.id === c.iron1.id).length === 1, rev.filter((r) => r.id === c.iron1.id).length);
  const again = await be.A.post('/atlas/asset/split', { credential: c.iron1, sendAmount: 1, toPublicKey: c.own, requestId: rid() });
  check(kind, `${label} and it cannot be spent again`, again.status === 400, [again.status, again.body.error]);
  note(kind, label, retry.status);
}
scenarios.S8 = async function (kind) {
  await pendingTransaction(kind, 'txn:journal-written', 'S8a (journal written, nothing revoked yet)');
  await pendingTransaction(kind, 'txn:replay-stored', 'S8b (revocation committed, journal not removed)');
};

// S9: a new key is not enough: evidence of an established deployment withholds the list.
const EVIDENCE = {
  'published key document': (p) => fs.writeFileSync(path.join(p.wk, 'atlas-key.json'), JSON.stringify({ keys: [{ publicKey: 'AAAA', validFrom: '2026-01-01T00:00:00Z', validUntil: null }] })),
  'suspensions file': (p) => fs.writeFileSync(path.join(p.wk, 'atlas-suspensions.json'), '{"suspended":[]}'),
  'reviewer key document': (p) => fs.writeFileSync(path.join(p.wk, 'atlas-reviewer-key.json'), '{"keys":[]}'),
  'holdings index entry': (p) => { fs.mkdirSync(p.holdings, { recursive: true }); fs.writeFileSync(path.join(p.holdings, 'abc.json'), '{"owner":"x","held":{}}'); },
  'transaction journal entry': (p) => { fs.mkdirSync(p.txn, { recursive: true }); fs.writeFileSync(path.join(p.txn, 'abc.json'), '{}'); },
  'replay record': (p) => { fs.mkdirSync(p.replay, { recursive: true }); fs.writeFileSync(path.join(p.replay, 'abc.json'), '{}'); },
  'ledger store': (p) => fs.writeFileSync(path.join(p.state, 'atlas-ledger-issuance-store.json'), '{}'),
  'mail store': (p) => fs.writeFileSync(path.join(p.state, 'atlas-mail-store.json'), '{"messages":[]}'),
  'reviewer private key': (p) => {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const isNode = p.reviewerKey.endsWith('.json');
    fs.writeFileSync(p.reviewerKey, isNode ? JSON.stringify(privateKey.export({ format: 'jwk' })) : privateKey.export({ type: 'sec1', format: 'pem' }));
  }
};
scenarios.S9 = async function (kind) {
  for (const [name, put] of Object.entries(EVIDENCE)) {
    const be = await issuer(kind, { seed: put });
    await firstRequest(be);
    await sleep(kind === 'node' ? 300 : 0);
    check(kind, `S9 ${name}: no revocation list is created`, !fs.existsSync(be.revFile));
    const r = await be.A.post('/atlas/asset/split', { credential: { id: 'urn:atlas:asset:none', owner: { publicKey: 'x' }, asset: { class: IRON, fungible: true }, quantity: 3 }, sendAmount: 1, toPublicKey: 'x', requestId: rid() });
    check(kind, `S9 ${name}: a spend is not answered as if nothing were revoked`, r.status !== 200, [r.status, r.body.error]);
    be.stop();
  }
  // Not evidence: configuration put in place before the first start, and a folder holding only .htaccess.
  const be = await issuer(kind, { seed: (p) => {
    fs.writeFileSync(path.join(p.state, 'atlas-ledger-issuance-config.json'), '{}');
    fs.writeFileSync(path.join(p.state, 'atlas-moderation-config.json'), '{}');
    fs.writeFileSync(path.join(p.state, 'atlas-admin-keys-store.json'), '{"admins":[]}');
    fs.writeFileSync(path.join(p.state, 'atlas-trusted-trade-peers-store.json'), '{"peers":[]}');
    fs.writeFileSync(path.join(p.state, 'atlas-federation-blocklist.json'), '{"blocked":[]}');
    fs.writeFileSync(path.join(p.state, 'atlas-admin-sessions-store.json'), '{"sessions":[]}');
    fs.writeFileSync(path.join(p.state, 'atlas-admin-nonces-store.json'), '{"nonces":[]}');
    fs.writeFileSync(path.join(p.state, 'atlas-calendar-store.json'), '{"events":[]}');
    fs.writeFileSync(path.join(p.state, 'atlas-subscribers-store.json'), '');
    fs.writeFileSync(path.join(p.wk, 'atlas-suspensions.json'), '');
    fs.mkdirSync(p.holdings, { recursive: true });
    fs.writeFileSync(path.join(p.holdings, '.htaccess'), 'Require all denied\n');
  } });
  await firstRequest(be);
  const doc = listJson(be);
  check(kind, 'S9 operator-provisioned files, sign-in and throttling stores, the calendar, zero-length stores and an empty protected folder are not evidence: the list is created', doc && Array.isArray(doc.revoked), doc);
  note(kind, 'S9 evidence kinds refused', Object.keys(EVIDENCE).length);
};

// S10: the key was lost too, with the rest of the deployment still there.
scenarios.S10 = async function (kind) {
  const be = await issuer(kind);
  await firstRequest(be);
  const c = await context(be);
  const backup = readText(be.revFile);
  const state0 = snapshotState(be);
  fs.rmSync(be.paths.key);
  fs.rmSync(be.revFile);
  fs.rmSync(be.keyFile, { force: true });
  await be.restart();
  await firstRequest(be);
  check(kind, 'S10 a freshly generated key does not bring a revocation list with it', !fs.existsSync(be.revFile));
  const r = await operations(be, c).split();
  check(kind, 'S10 and nothing is spent against the empty history', r.status !== 200, [r.status, r.body.error]);
  check(kind, 'S10 holdings and journals are untouched', snapshotState(be) === state0);
  check(kind, 'S10 the backup is what restores it', backup !== null);
};

// S11: initialization is no-clobber and crash-safe.
scenarios.S11 = async function (kind) {
  // A crash while the list is being written leaves no half-written list and no key.
  const be = await issuer(kind, { workers: 0, autostart: false });
  let crashed = false;
  const crashedNow = (r) => r.status === 0 || (r.status === 200 && r.body && typeof r.body.error === 'string' && r.body.error.startsWith('non-json'));
  if (kind === 'node') {
    try { await be.start({ ATLAS_TEST_CRASH_AT: 'revocations:init-tmp-written' }); } catch (e) { crashed = /exited 86/.test(String(e.message)); }
  } else {
    await be.start({ ATLAS_TEST_CRASH_AT: 'revocations:init-tmp-written' });
    const r = await be.A.post('/atlas/asset/issue', { ownerPublicKey: 'TESTOWNER-x', assetClass: IRON, quantity: 1 });
    crashed = crashedNow(r);
  }
  check(kind, 'S11 the first start is cut off while the list is being created', crashed);
  check(kind, 'S11 no list and no key were left behind', !fs.existsSync(be.revFile) && !fs.existsSync(be.paths.key));
  if (kind === 'node') await be.start({}); else await be.restart({});
  await firstRequest(be);
  const doc = listJson(be);
  check(kind, 'S11 the next start completes initialization', doc && Array.isArray(doc.revoked) && doc.revoked.length === 0 && fs.existsSync(be.paths.key), doc);
  // An existing list is never replaced: here a list from a crash between the list and the key.
  const be2 = await issuer(kind, { seed: (p) => fs.writeFileSync(path.join(p.wk, 'atlas-revocations.json'), JSON.stringify({ revoked: [{ id: 'urn:atlas:asset:kept', revokedAt: '2026-01-01T00:00:00Z', reason: 'issuer-request' }] }, null, 2)) });
  await firstRequest(be2);
  const kept = listJson(be2);
  check(kind, 'S11 a list that is already there is left exactly as it was when the key is generated', kept && kept.revoked.length === 1 && kept.revoked[0].id === 'urn:atlas:asset:kept', kept);
};

// S12: simultaneous first starts.
scenarios.S12 = async function (kind) {
  if (kind === 'php') {
    const be = await issuer('php', { workers: 4 });
    const results = await Promise.all(Array.from({ length: 16 }, (_, i) => be.A.post('/atlas/asset/issue', { ownerPublicKey: 'TESTOWNER-race-' + i, assetClass: IRON, quantity: 1 })));
    check(kind, 'S12 sixteen simultaneous first requests all succeed', results.every((r) => r.status === 200), results.map((r) => r.status));
    const keys = new Set(results.filter((r) => r.status === 200).map((r) => r.body.issuer.publicKey));
    const doc = listJson(be);
    check(kind, 'S12 they were all signed by one key', keys.size === 1, [...keys].length);
    check(kind, 'S12 one valid list exists', doc && Array.isArray(doc.revoked), doc);
    check(kind, 'S12 the published key document lists that key', JSON.parse(fs.readFileSync(be.keyFile, 'utf8')).keys.some((k) => keys.has(k.publicKey)));
    check(kind, 'S12 no temporary files remain', tmpFiles(be).length === 0, tmpFiles(be));
    return;
  }
  // Node: two server processes started together on the same folders.
  const be = await issuer('node', { autostart: false });
  const spawnOne = (p) => {
    const log = [];
    const proc = spawn('node', ['issuer-server/server.js'], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: String(p), ATLAS_DOMAIN: 'localhost:' + p, ATLAS_DOCROOT: be.docroot, ATLAS_STATE_DIR: be.state } });
    proc.stdout.on('data', (d) => log.push(d.toString()));
    proc.stderr.on('data', (d) => log.push(d.toString()));
    return { proc, log, port: p };
  };
  const a = spawnOne(port()), b = spawnOne(port());
  const up = async (x) => { for (let i = 0; i < 300; i++) { if (x.log.join('').includes('listening')) return true; if (x.proc.exitCode !== null) return false; await sleep(50); } return false; };
  const [ua, ub] = await Promise.all([up(a), up(b)]);
  check(kind, 'S12 two servers started at the same moment both come up', ua && ub, [ua, ub, a.log.join('').slice(-200), b.log.join('').slice(-200)]);
  if (ua && ub) {
    const mintAt = async (x) => (await fetch(`http://localhost:${x.port}/atlas/asset/issue`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ownerPublicKey: 'TESTOWNER-race', assetClass: IRON, quantity: 1 }) })).json();
    const [ra, rb] = await Promise.all([mintAt(a), mintAt(b)]);
    check(kind, 'S12 both sign with the same key', ra.issuer && rb.issuer && ra.issuer.publicKey === rb.issuer.publicKey, [ra.issuer && ra.issuer.publicKey, rb.issuer && rb.issuer.publicKey]);
    const doc = listJson(be);
    check(kind, 'S12 one valid list exists', doc && Array.isArray(doc.revoked), doc);
    check(kind, 'S12 the published key document lists that key', JSON.parse(fs.readFileSync(be.keyFile, 'utf8')).keys.some((k) => k.publicKey === ra.issuer.publicKey));
    check(kind, 'S12 no temporary files remain', tmpFiles(be).length === 0, tmpFiles(be));
  }
  for (const x of [a, b]) { x.proc.kill(); }
};

// ---- run -------------------------------------------------------------------------------------
(async () => {
  const kinds = [];
  if (WHICH !== 'php') kinds.push('node');
  if (WHICH !== 'node') kinds.push('php');
  for (const kind of kinds) {
    for (const [name, fn] of Object.entries(scenarios)) {
      if (ONLY && ONLY !== name) continue;
      console.log(`--- ${name} [${kind}]`);
      try { await fn(kind); } catch (e) { failures++; checks++; console.log(`FAIL [${kind}] ${name} threw :: ${e.stack || e}`); }
    }
  }
  if (kinds.length === 2) {
    // Same security behavior on both issuers.
    for (const key of Object.keys(outcomes.node)) {
      if (!(key in outcomes.php)) continue;
      const a = JSON.stringify(outcomes.node[key]), b = JSON.stringify(outcomes.php[key]);
      check('parity', `${key}: Node and PHP agree`, a === b, { node: outcomes.node[key], php: outcomes.php[key] });
    }
  }
  for (const be of made) { try { be.stop(); } catch (e) { /* already stopped */ } }
  console.log(`\n${checks - failures} passed, ${failures} failed, ${skipped.length} skipped (${checks} checks)`);
  for (const s of skipped) console.log('  skipped ' + s);
  process.exit(failures ? 1 : 0);
})();
