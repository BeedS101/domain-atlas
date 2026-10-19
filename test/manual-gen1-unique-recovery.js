// Crash-safe recovery for a non-fungible mint, a purchase and a trade claim: a lost answer, a browser
// killed at any point, a locked wallet, an unreachable issuer, repeated and concurrent retries, a
// changed request, a backup taken with the operation pending, an expired stored result, answers that
// are not results, and an issuer that does not answer a repeated request id.
//
// Disposable Chromium profiles with the real extension and throw-away Node or PHP issuers (own key,
// state and revocation list; stored-result retention shortened for the expiry scenarios). Negative
// controls run the previous wallet.js and the previous issuer, found in git history. Nothing live is
// read or written.
//
//   xvfb-run -a node test/manual-gen1-unique-recovery.js [node|php|both] [--only=M1]
//
// Every PASS/FAIL line is a property that must hold. "INFO" lines record what is still impossible.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Wallet, PASSWORD, EXT_PATH, sleep } = require('./lib/wallet-profile');
const issuers = require('./lib/gen1-issuers');

const IRON = 'atlas.element.iron', GOLD = 'atlas.element.gold';
const RING = 'atlas.wearable.ring', MEMBER = 'atlas.tradingstation.membership', SUBSCRIPTION = 'atlas.membership';
const SANDWICH = 'atlas.demo.cafeteria.sandwich', CREDIT = 'atlas.credit.balance';
const args = process.argv.slice(2);
const which = args.find((a) => /^(node|php|both)$/.test(a)) || 'node';
const ONLY = (args.find((a) => a.startsWith('--only=')) || '').slice(7);
const TTL_ENV = { ATLAS_REPLAY_TTL_HOURS: '0.0006' }; // 2.16 s
const EXPIRY_WAIT_MS = 4500;
const REPO = path.resolve(__dirname, '..');

let passes = 0, failures = 0;
const check = (name, ok, detail) => {
  if (ok) { passes++; console.log('PASS ' + name); } else { failures++; console.log('FAIL ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 900) : '')); }
};
const info = (text) => console.log('INFO ' + text);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

let nextPort = 18000 + (process.pid % 400) * 20; // below the ephemeral range, which browsers and test clients draw from
async function startIssuer(kind, opts) {
  opts = opts || {};
  const port = nextPort++;
  const be = kind === 'php'
    ? await issuers.startPhp(port, { workers: opts.workers === undefined ? 0 : opts.workers, env: opts.env, source: opts.source, prepare: opts.prepare })
    : await issuers.startNode(port, { env: opts.env, root: opts.root });
  const api = issuers.api(be);
  const stateDir = kind === 'php' ? path.join(be.bundle, 'lib') : be.state;
  const readJson = (file) => { try { return JSON.parse(fs.readFileSync(path.join(stateDir, file), 'utf8')); } catch (e) { return null; } };
  return {
    be, api, kind, domain: kind === 'php' ? '127.0.0.1:' + port : 'localhost:' + port, stateDir, readJson,
    revoked: () => new Set((api.revocations() || []).map((r) => r.id)),
    revCount: () => (api.revocations() || []).length,
    serial: (cls) => { const d = readJson(kind === 'php' ? 'atlas-serial-counters-store.json' : 'atlas-serial-counters.json'); return d && d.counters ? (d.counters[cls] || 0) : 0; },
    roster: (name) => { const d = readJson('atlas-' + name + '-store.json'); return d ? (d.subscribers || d.members || d.messages || []) : []; },
    replays: () => { try { return fs.readdirSync(be.replayDir).filter((f) => /\.json$/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(be.replayDir, f), 'utf8'))); } catch (e) { return []; } },
    stop: () => be.stop()
  };
}

// ---------------------------------------------------------------- the backup file, outside the browser
const exportBackup = (w) => w.W(([pw, seed]) => AtlasWallet.exportFullBackup(pw, seed), [PASSWORD, w.seed]);
const importBackup = (t, file, seed) => t.W(([f, pw, s]) => AtlasWallet.importFullBackup(f, pw, s).then((result) => ({ ok: true, result }), (e) => ({ ok: false, message: e.message, code: e.code })), [file, PASSWORD, seed || t.seed]);

// ---------------------------------------------------------------- wallet-side helpers
const outcome = (e) => ({ message: String(e.message).slice(0, 160), pending: !!e.pending, needsAttention: !!e.needsAttention, refunded: !!e.refunded, code: e.code, status: e.status });
const mint = (w, iss, cls, q) => w.W((a) => AtlasWallet.mintAsset('self', a.d, a.c, a.q).then(() => 'ok', (e) => ({ message: String(e.message).slice(0, 160), pending: !!e.pending, code: e.code })), { d: iss.domain, c: cls, q });
const buy = (w, iss, cls) => w.W((a) => AtlasWallet.purchaseAsset('self', a.d, a.c, 1).then(() => 'ok', (e) => ({ message: String(e.message).slice(0, 160), pending: !!e.pending, needsAttention: !!e.needsAttention, code: e.code })), { d: iss.domain, c: cls });
const shown = (w, cls) => w.W(([k, c]) => AtlasWallet.getWallet(k).then((list) => list.filter((e) => e.credential.asset.class === c).map((e) => ({
  id: e.credential.id, q: e.credential.quantity, status: e.lastVerdict && e.lastVerdict.status, valid: !!(e.lastVerdict && e.lastVerdict.valid),
  held: e.pendingOutcome ? e.pendingOutcome.state : null, serial: e.credential.asset.properties ? e.credential.asset.properties['atlas.serial'] || null : null
}))), [w.pub, cls]);
const live = async (w, cls) => (await shown(w, cls)).filter((r) => r.held === null && r.valid);
const sum = (rows) => rows.reduce((s, r) => s + r.q, 0);
const lockWallet = (w) => w.W(() => AtlasWallet.lockIdentity());
const retry = (w, rid) => w.W((a) => AtlasWallet.retryPendingOperation(a.k, a.r).then((r) => r, (e) => ({ status: 'threw', message: e.message })), { k: w.pub, r: rid });
async function waitFor(fn, ms) { const end = Date.now() + (ms || 15000); while (Date.now() < end) { if (await fn()) return true; await sleep(100); } return false; }
const restartLocked = async (w) => { await w.kill(); await w.launch(); };

// Replaces the next `times` requests whose URL matches `source` by a 200 answer that is not a result.
async function fakeAnswer(w, source, mode, times) {
  await w.W(([src, m, n]) => {
    const re = new RegExp(src);
    const inner = globalThis.__fakeInner || (globalThis.__fakeInner = globalThis.fetch.bind(globalThis));
    let left = n;
    globalThis.fetch = async (url, opts) => {
      if (re.test(String(url)) && left > 0) {
        left--;
        if (m === 'html') return new Response('<html><body>Service Unavailable page</body></html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
        if (m === 'truncated') return new Response('{"credential":"domain-atlas-asset/1.0","id":"urn:atl', { status: 200 });
        if (m === 'otherOwner') {
          const res = await inner(url, opts);
          const data = await res.json();
          const swap = (c) => (c && c.owner ? Object.assign({}, c, { owner: { publicKey: 'someone-else' } }) : c);
          const body = data && data.purchased ? Object.assign({}, data, { purchased: swap(data.purchased), balance: swap(data.balance) })
            : data && data.received ? Object.assign({}, data, { received: swap(data.received), remainder: swap(data.remainder) }) : swap(data);
          return new Response(JSON.stringify(body), { status: 200 });
        }
      }
      return inner(url, opts);
    };
  }, [source, mode, times]);
}

// Posts a request straight to the issuer, outside any wallet.
const post = (iss, p, body) => iss.api.post(p, body);

// ---------------------------------------------------------------- scenario plumbing
async function scenario(kind, label, body, issuerOpts, walletOpts) {
  if (ONLY && !label.startsWith(ONLY)) return;
  console.log(`\n=== [${kind}] ${label} ===`);
  const iss = await startIssuer(kind, issuerOpts);
  const w = await new Wallet(label.replace(/\W+/g, '').slice(0, 10), walletOpts).launch();
  const extras = [];
  const issuersOpened = [];
  const ctx = {
    fresh: async (name, from, opts) => {
      const t = await new Wallet(name, opts).launch();
      if (from) { t.pub = from.pub; t.seed = from.seed; }
      extras.push(t);
      return t;
    },
    extra: (t) => { extras.push(t); return t; },
    issuer: async (k, o) => { const i = await startIssuer(k, o); issuersOpened.push(i); return i; }
  };
  try {
    await w.create();
    await body(w, iss, ctx);
  } catch (e) {
    failures++; console.log('FAIL threw in "' + label + '" :: ' + (e.stack || e));
  } finally {
    for (const t of extras) await t.dispose().catch(() => null);
    await w.dispose(); iss.stop();
    for (const i of issuersOpened) i.stop();
  }
}

// A ring mint (unique, serialized) whose answer is lost after the issuer committed it.
async function lostRing(w, iss) {
  await w.inject('dropAnswer', '/atlas/asset/issue');
  const out = await mint(w, iss, RING);
  const fault = await w.faultInfo();
  await w.clearFault();
  return { out, fault };
}

// Previous revisions, from git history, for the negative controls.
let previous = null;
function previousRevision() {
  if (previous) return previous;
  const marker = 'issuerRepeatSupport';
  const revs = spawnSync('git', ['log', '--format=%H', '--', 'extension/wallet.js'], { cwd: REPO }).stdout.toString().trim().split('\n').filter(Boolean);
  for (const rev of revs) {
    const src = spawnSync('git', ['show', rev + ':extension/wallet.js'], { cwd: REPO, maxBuffer: 1 << 28 });
    if (src.status !== 0 || src.stdout.includes(marker)) continue;
    const extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-prev-ext-'));
    fs.cpSync(EXT_PATH, extDir, { recursive: true });
    fs.writeFileSync(path.join(extDir, 'wallet.js'), src.stdout);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-prev-issuer-'));
    const tar = spawnSync('sh', ['-c', 'git archive ' + rev + ' issuer-server issuer-php | tar -x -C ' + root], { cwd: REPO });
    if (tar.status !== 0) return null;
    previous = { rev, extDir, root, phpSource: path.join(root, 'issuer-php') };
    return previous;
  }
  return null;
}

// The newest revision whose `file` lacks `marker`, with its wallet and issuers unpacked (cached per revision).
const revisionCache = new Map();
function revisionLacking(file, marker) {
  const revs = spawnSync('git', ['log', '--format=%H', '--', file], { cwd: REPO }).stdout.toString().trim().split('\n').filter(Boolean);
  for (const rev of revs) {
    const src = spawnSync('git', ['show', rev + ':' + file], { cwd: REPO, maxBuffer: 1 << 28 });
    if (src.status !== 0 || src.stdout.includes(marker)) continue;
    if (revisionCache.has(rev)) return revisionCache.get(rev);
    const extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-rev-ext-'));
    fs.cpSync(EXT_PATH, extDir, { recursive: true });
    const wallet = spawnSync('git', ['show', rev + ':extension/wallet.js'], { cwd: REPO, maxBuffer: 1 << 28 });
    fs.writeFileSync(path.join(extDir, 'wallet.js'), wallet.stdout);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-rev-issuer-'));
    const tar = spawnSync('sh', ['-c', 'git archive ' + rev + ' issuer-server issuer-php | tar -x -C ' + root], { cwd: REPO });
    if (tar.status !== 0) return null;
    const found = { rev, extDir, root, phpSource: path.join(root, 'issuer-php') };
    revisionCache.set(rev, found);
    return found;
  }
  return null;
}

// ---------------------------------------------------------------- scenarios
async function mintScenarios(kind) {
  await scenario(kind, 'M1 a unique mint whose answer is lost after the issuer committed it', async (w, iss) => {
    const { out, fault } = await lostRing(w, iss);
    check('the wallet reports the mint as saved, not failed', out !== 'ok' && out.pending === true, out);
    check('one request reached the issuer and it committed (serial 1 consumed)', fault.hits === 1 && iss.serial(RING) === 1, { hits: fault.hits, serial: iss.serial(RING) });
    const [entry] = await w.pending();
    check('the journal holds the request: kind mint, a request id, no predecessors, the same id was sent', !!entry && entry.kind === 'mint' && typeof entry.requestId === 'string' && (entry.predecessors || []).length === 0 && JSON.parse(fault.bodies[0]).requestId === entry.requestId, entry);
    check('the wallet has no ring yet', (await shown(w, RING)).length === 0);
    await w.restart(true);
    const r = await w.recover();
    check('recovery after the restart completes it', r.length === 1 && r[0].status === 'completed' && r[0].applied === true, r);
    const rows = await shown(w, RING);
    check('exactly one ring, serial 1, verified', rows.length === 1 && rows[0].serial === '1' && rows[0].status === 'verified' && rows[0].held === null, rows);
    const stored = iss.replays().map((x) => (x.response && x.response.id) || (x.responseJson && JSON.parse(x.responseJson).id));
    check('it is the credential the issuer signed for that request', stored.includes(rows[0].id), { stored, id: rows[0].id });
    check('no second item was issued: serial counter still 1, journal empty', iss.serial(RING) === 1 && (await w.pending()).length === 0, iss.serial(RING));
    const next = await mint(w, iss, RING);
    const rows2 = await shown(w, RING);
    check('the next ring is serial 2: the retry consumed no supply', next === 'ok' && rows2.map((x) => x.serial).sort().join() === '1,2', rows2);
  });

  await scenario(kind, 'M2 browser killed before the request was sent', async (w, iss) => {
    await w.inject('hangFetch', '/atlas/asset/issue');
    const pendingCall = w.W((a) => AtlasWallet.mintAsset('self', a.d, a.c).then(() => 'ok', (e) => e.message), { d: iss.domain, c: RING }).catch(() => null);
    check('the request was about to be sent', await w.waitHits(1, 15000));
    const [entry] = await w.pending();
    check('the journal entry was written before sending', !!entry && entry.kind === 'mint' && entry.attempts === 0, entry);
    await w.kill(); await pendingCall;
    check('the issuer never saw it', iss.serial(RING) === 0 && iss.replays().length === 0);
    await w.launch(); await w.unlock();
    const r = await w.recover();
    const rows = await shown(w, RING);
    check('recovery sends it once and the ring arrives', r.length === 1 && r[0].status === 'completed' && rows.length === 1 && rows[0].serial === '1' && iss.serial(RING) === 1, { r, rows });
  });

  await scenario(kind, 'M3 browser killed after the issuer committed, before the answer was stored', async (w, iss) => {
    await w.inject('hangCommit', '/atlas/asset/issue');
    const call = w.W((a) => AtlasWallet.mintAsset('self', a.d, a.c).then(() => 'ok', (e) => e.message), { d: iss.domain, c: RING }).catch(() => null);
    check('the issuer answered and the wallet was about to store it', await waitFor(async () => (await w.faultInfo()).hits >= 1, 15000));
    await w.kill(); await call;
    check('the issuer committed once', iss.serial(RING) === 1);
    await w.launch(); await w.unlock();
    check('nothing was stored; the journal still has the request', (await shown(w, RING)).length === 0 && (await w.pending()).length === 1);
    const r = await w.recover();
    const rows = await shown(w, RING);
    check('recovery gets the stored answer: one ring, serial 1, no new supply', r[0].status === 'completed' && rows.length === 1 && rows[0].serial === '1' && iss.serial(RING) === 1, { r, rows });
  });

  await scenario(kind, 'M4 the wallet locks while the answer is on its way', async (w, iss) => {
    await w.inject('delayAnswer', '/atlas/asset/issue');
    const call = w.W((a) => AtlasWallet.mintAsset('self', a.d, a.c).then(() => 'ok', (e) => ({ message: e.message, pending: !!e.pending, code: e.code })), { d: iss.domain, c: RING });
    check('the request is in flight', await w.waitHits(1, 15000));
    await lockWallet(w);
    await w.release();
    const out = await call;
    check('the answer is not stored while locked; the call reports the request as saved', out !== 'ok' && (out.pending === true || out.code === 'wallet-locked'), out);
    await w.clearFault();
    await w.unlock();
    check('the journal still holds the request', (await w.pending()).length === 1);
    check('no ring yet', (await shown(w, RING)).length === 0);
    const r = await w.recover();
    const rows = await shown(w, RING);
    check('after the unlock the stored answer is applied once, serial 1', r[0].status === 'completed' && rows.length === 1 && rows[0].serial === '1' && iss.serial(RING) === 1, { r, rows });
  });

  await scenario(kind, 'M5 issuer unavailable, then repeated retries with the same request id', async (w, iss) => {
    await w.inject('failFetch', '/atlas/asset/issue');
    const out = await mint(w, iss, RING);
    check('unreachable: saved, nothing issued', out !== 'ok' && out.pending === true && iss.serial(RING) === 0, out);
    const [first] = await w.pending();
    const r1 = await w.recover(); const r2 = await w.recover();
    const [entry] = await w.pending();
    check('two more attempts fail, evidence kept: same request id, attempts counted', r1[0].status === 'pending' && r2[0].status === 'pending' && entry.requestId === first.requestId && entry.attempts === 3 && !!entry.lastError, { r1, r2, entry });
    await w.clearFault();
    const r3 = await w.recover(); const r4 = await w.recover();
    const rows = await shown(w, RING);
    check('the issuer back: it completes once; a further recovery has nothing to do', r3[0].status === 'completed' && r4.length === 0 && rows.length === 1 && iss.serial(RING) === 1, { r3, r4, rows });
    const direct = [];
    for (let i = 0; i < 3; i++) direct.push(await post(iss, '/atlas/asset/issue', { ownerPublicKey: w.pub, assetClass: RING, requestId: first.requestId }));
    check('the same request id asked three more times returns that same ring each time', direct.every((d) => d.status === 200 && d.body.id === rows[0].id) && iss.serial(RING) === 1, direct.map((d) => d.status));
  });

  await scenario(kind, 'M6 the same request id with changed parameters', async (w, iss) => {
    const rid = 'rid-' + crypto.randomBytes(12).toString('base64url');
    const other = (await new Promise((resolve) => resolve(crypto.randomBytes(32).toString('base64url'))));
    const a = await post(iss, '/atlas/asset/issue', { ownerPublicKey: w.pub, assetClass: RING, requestId: rid });
    check('first request issues a ring', a.status === 200 && a.body.asset.class === RING && iss.serial(RING) === 1, a);
    const sameAgain = await post(iss, '/atlas/asset/issue', { ownerPublicKey: w.pub, assetClass: RING, requestId: rid });
    check('identical repeat returns the same credential and issues nothing', sameAgain.status === 200 && sameAgain.body.id === a.body.id && iss.serial(RING) === 1, sameAgain);
    const otherClass = await post(iss, '/atlas/asset/issue', { ownerPublicKey: w.pub, assetClass: SUBSCRIPTION, requestId: rid });
    check('another class under that id is refused: 409 request-id-conflict', otherClass.status === 409 && otherClass.body.code === 'request-id-conflict', otherClass);
    const otherOwner = await post(iss, '/atlas/asset/issue', { ownerPublicKey: other, assetClass: RING, requestId: rid });
    check('another owner under that id is refused and gets nothing of the first owner', otherOwner.status === 409 && !JSON.stringify(otherOwner.body).includes(a.body.id), otherOwner);
    check('nothing was issued by the refused requests', iss.serial(RING) === 1 && iss.replays().length === 1);
    const bad = await post(iss, '/atlas/asset/issue', { ownerPublicKey: w.pub, assetClass: RING, requestId: 'short' });
    check('a malformed request id is a 400', bad.status === 400, bad);
  });

  await scenario(kind, 'M7 simultaneous retries from several wallet views', async (w, iss, ctx) => {
    const { fault } = await lostRing(w, iss);
    const [entry] = await w.pending();
    const body = JSON.parse(fault.bodies[0]);
    const direct = await Promise.all([1, 2, 3, 4, 5, 6].map(() => post(iss, '/atlas/asset/issue', body)));
    const ids = new Set(direct.map((d) => d.body && d.body.id));
    check('six simultaneous identical requests: every answer is one credential, one serial consumed', direct.every((d) => d.status === 200 || d.status === 503) && ids.size <= 2 && iss.serial(RING) === 1, { statuses: direct.map((d) => d.status), serial: iss.serial(RING) });
    const id = new URL(w.sw.url()).host;
    const pages = [];
    for (let i = 0; i < 3; i++) { const p = await w.context.newPage(); await p.goto('chrome-extension://' + id + '/viewer.html'); await p.waitForFunction(() => typeof AtlasWallet !== 'undefined', null, { timeout: 15000 }); pages.push(p); }
    const results = await Promise.all([w.recover(), ...pages.map((p) => p.evaluate((k) => AtlasWallet.recoverPendingOperations(k), w.pub))]);
    const rows = await shown(w, RING);
    const completed = results.flat().filter((o) => o.status === 'completed' && o.applied === true).length;
    check('three pages and the worker recover at once: applied at most once, one ring, journal empty', completed <= 1 && rows.length === 1 && iss.serial(RING) === 1 && (await w.pending()).length === 0, { results, rows });
    for (const p of pages) await p.close();
    check('the entry is gone and the request id is the one journalled', !!entry.requestId && (await w.pending()).length === 0);
  });

  await scenario(kind, 'M8 a backup taken with the mint pending is restored into a fresh profile', async (w, iss, ctx) => {
    const { fault } = await lostRing(w, iss);
    const [entry] = await w.pending();
    const file = await exportBackup(w);
    const t = await ctx.fresh('m8restore', w);
    await t.create().catch(() => null);
    const imported = await importBackup(t, file, w.seed);
    check('the backup restores', imported.ok === true, imported);
    t.pub = w.pub;
    await t.restart(true).catch(() => null);
    const [carried] = await t.pending();
    check('the pending mint came with the backup under the same request id', !!carried && carried.requestId === entry.requestId && carried.kind === 'mint', carried);
    check('a restore sends nothing', iss.serial(RING) === 1 && fault.hits === 1);
    const r = await t.recover();
    const rows = await shown(t, RING);
    check('recovery in the new profile completes it once, serial 1, no new supply', r[0].status === 'completed' && rows.length === 1 && rows[0].serial === '1' && iss.serial(RING) === 1, { r, rows });
    const again = await w.recover();
    const orig = await shown(w, RING);
    check('the original profile recovers the same credential; the issuer still issued only one', again[0].status === 'completed' && orig.length === 1 && orig[0].id === rows[0].id && iss.serial(RING) === 1, { again, orig, rows });
  });

  await scenario(kind, 'M9 the stored result has expired', async (w, iss) => {
    await lostRing(w, iss);
    await sleep(EXPIRY_WAIT_MS);
    await w.restart(true);
    const hitsBefore = iss.serial(RING);
    const r = await w.recover();
    const [entry] = await w.pending();
    check('automatic recovery does not send it: needs-attention, nothing issued', r.length === 1 && r[0].status === 'needs-attention' && entry.state === 'needs-attention' && iss.serial(RING) === hitsBefore, { r, entry });
    check('the entry says why', !!entry.attention && entry.attention.code === 'result-may-have-expired', entry && entry.attention);
    const again = await w.recover();
    check('a further recovery still sends nothing', again[0].status === 'needs-attention' && iss.serial(RING) === 1, again);
    const manual = await retry(w, entry.requestId);
    const rows = await shown(w, RING);
    check('asking the issuer again by hand is allowed: it issues a new ring (the old one stays at the issuer)', manual.status === 'completed' && rows.length === 1 && iss.serial(RING) === 2, { manual, rows, serial: iss.serial(RING) });
    info('after expiry the first ring can no longer be retrieved; asking again by hand issues a second one (serial 2) and the first stays unclaimed at the issuer');
  }, { env: TTL_ENV });

  await scenario(kind, 'M10 an answer that is not a result is never applied', async (w, iss) => {
    await fakeAnswer(w, '/atlas/asset/issue', 'html', 1);
    const a = await mint(w, iss, RING);
    check('an HTML 200 answer: saved, nothing stored', a !== 'ok' && a.pending === true && (await shown(w, RING)).length === 0 && (await w.pending()).length === 1, a);
    check('the issuer had received nothing yet (the fake answered)', iss.serial(RING) === 0);
    await w.clearFault();
    await fakeAnswer(w, '/atlas/asset/issue', 'truncated', 1);
    const r1 = await w.recover();
    check('a truncated JSON answer is not applied either; attempts counted', r1[0].status === 'pending' && (await shown(w, RING)).length === 0, r1);
    await w.restart(true);
    await fakeAnswer(w, '/atlas/asset/issue', 'otherOwner', 1);
    const r2 = await w.recover();
    check('an answer for another owner is not applied', r2[0].status === 'pending' && (await shown(w, RING)).length === 0 && iss.serial(RING) === 1, r2);
    await w.restart(true);
    const r3 = await w.recover();
    const rows = await shown(w, RING);
    check('the real answer is then applied once; the replays consumed no supply', r3[0].status === 'completed' && rows.length === 1 && iss.serial(RING) === 1, { r3, rows });
  });

  await scenario(kind, 'M11 a membership: the roster row and welcome mail exist once, after a lost answer', async (w, iss) => {
    await w.inject('dropAnswer', '/atlas/asset/issue');
    const out = await mint(w, iss, SUBSCRIPTION);
    await w.clearFault();
    check('lost answer: saved', out !== 'ok' && out.pending === true, out);
    const rid = (await w.pending())[0].requestId;
    await w.restart(true);
    const r = await w.recover();
    const rows = await shown(w, SUBSCRIPTION);
    check('the membership arrives once', r[0].status === 'completed' && rows.length === 1, { r, rows });
    const roster = iss.roster('subscribers');
    check('one subscriber row for the credential, not two', roster.filter((x) => x.credentialId === rows[0].id).length === 1 && roster.length === 1, roster);
    const welcome = iss.roster('mail').filter((m) => m.credentialId === rows[0].id);
    check('one welcome mail for it', welcome.length === 1, welcome.length);
    const direct = await post(iss, '/atlas/asset/issue', { ownerPublicKey: w.pub, assetClass: SUBSCRIPTION, requestId: rid });
    check('asking again under that id returns the same membership and adds no roster row or mail', direct.status === 200 && direct.body.id === rows[0].id && iss.roster('subscribers').length === 1 && iss.roster('mail').filter((m) => m.credentialId === rows[0].id).length === 1, { status: direct.status, subscribers: iss.roster('subscribers').length });
  });
}

// ---------------------------------------------------------------- raw identities, for requests made outside any wallet
const { subtle } = crypto.webcrypto;
const canon = (v) => (v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? '[' + v.map(canon).join(',') + ']' : '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}');
async function rawIdentity() {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return { key: pair.privateKey, pub: Buffer.from(await subtle.exportKey('raw', pair.publicKey)).toString('base64url') };
}
async function rawProof(id, payload) {
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, id.key, new TextEncoder().encode(canon(payload)));
  return { signerRole: 'raw-ecdsa', publicKey: id.pub, signature: Buffer.from(sig).toString('base64url') };
}
const newRid = () => 'rid-' + crypto.randomBytes(14).toString('base64url');
async function rawIssue(iss, owner, cls, quantity) {
  const r = await post(iss, '/atlas/asset/issue', { ownerPublicKey: owner.pub, assetClass: cls, quantity });
  if (r.status !== 200) throw new Error('issue ' + cls + ' failed: ' + JSON.stringify(r.body));
  return r.body;
}
// A purchase request signed by `buyer`. `bind` is the request id the intent carries, `bodyRid` the one in the body.
async function rawPurchase(iss, buyer, balance, cls, bodyRid, bind) {
  const payload = Object.assign({ credentialId: balance.id, purchasedClass: cls, quantity: 1, action: 'purchase' }, bind ? { requestId: bind } : {});
  return post(iss, '/atlas/asset/purchase', Object.assign({ credential: balance, purchasedClass: cls, quantity: 1, intent: { payload, proof: await rawProof(buyer, payload) } }, bodyRid ? { requestId: bodyRid } : {}));
}

// ---------------------------------------------------------------- purchase
async function lostBuy(w, iss, cls) {
  await w.inject('dropAnswer', '/atlas/asset/purchase');
  const out = await buy(w, iss, cls || SANDWICH);
  const fault = await w.faultInfo();
  await w.clearFault();
  return { out, fault };
}

async function purchaseScenarios(kind) {
  const fund = async (w, iss) => { const r = await mint(w, iss, CREDIT, 10); if (r !== 'ok') throw new Error('funding failed: ' + JSON.stringify(r)); };
  const state = async (w) => ({ credit: sum(await live(w, CREDIT)), sandwiches: (await live(w, SANDWICH)).length });

  await scenario(kind, 'P1 a purchase whose answer is lost after the issuer committed it', async (w, iss) => {
    await fund(w, iss);
    const revBefore = iss.revCount();
    const { out, fault } = await lostBuy(w, iss);
    check('the wallet reports the purchase as saved, not failed', out !== 'ok' && out.pending === true, out);
    const [entry] = await w.pending();
    check('journal: kind purchase, the credit balance as predecessor, the id that was sent', !!entry && entry.kind === 'purchase' && entry.predecessors.length === 1 && JSON.parse(fault.bodies[0]).requestId === entry.requestId && JSON.parse(fault.bodies[0]).intent.payload.requestId === entry.requestId, entry);
    const committed = iss.revCount();
    check('the issuer committed once: the balance is revoked', committed === revBefore + 1 && fault.hits === 1, { revBefore, committed });
    check('the wallet has no sandwich and no spendable credit', (await state(w)).sandwiches === 0 && (await state(w)).credit === 0, await state(w));
    await w.restart(true);
    const r = await w.recover();
    const st = await state(w);
    check('recovery after the restart completes it: one sandwich, 5 credits left', r.length === 1 && r[0].status === 'completed' && st.sandwiches === 1 && st.credit === 5, { r, st });
    check('nothing was spent again: no further revocation, journal empty', iss.revCount() === committed && (await w.pending()).length === 0, iss.revCount());
    const bought = await buy(w, iss, SANDWICH);
    const st2 = await state(w);
    check('a following purchase is a new purchase: 2 sandwiches, 0 credits', bought === 'ok' && st2.sandwiches === 2 && st2.credit === 0, st2);
  });

  await scenario(kind, 'P2 browser killed before the purchase was sent', async (w, iss) => {
    await fund(w, iss);
    await w.inject('hangFetch', '/atlas/asset/purchase');
    const call = w.W((a) => AtlasWallet.purchaseAsset('self', a.d, a.c, 1).then(() => 'ok', (e) => e.message), { d: iss.domain, c: SANDWICH }).catch(() => null);
    check('the request was about to be sent', await w.waitHits(1, 15000));
    const [entry] = await w.pending();
    check('the journal entry exists before sending', !!entry && entry.kind === 'purchase' && entry.attempts === 0, entry);
    await w.kill(); await call;
    const rev = iss.revCount();
    await w.launch(); await w.unlock();
    check('the issuer never saw it', iss.replays().filter((x) => x.op === 'purchase').length === 0 && (await w.pending()).length === 1);
    const r = await w.recover();
    const st = await state(w);
    check('recovery sends it once: one sandwich, 5 credits', r[0].status === 'completed' && st.sandwiches === 1 && st.credit === 5 && iss.revCount() === rev + 1, { r, st });
  });

  await scenario(kind, 'P3 browser killed after the issuer committed, before the answer was stored', async (w, iss) => {
    await fund(w, iss);
    await w.inject('hangCommit', '/atlas/asset/purchase');
    const call = w.W((a) => AtlasWallet.purchaseAsset('self', a.d, a.c, 1).then(() => 'ok', (e) => e.message), { d: iss.domain, c: SANDWICH }).catch(() => null);
    check('the issuer answered and the wallet was about to store it', await waitFor(async () => (await w.faultInfo()).hits >= 1, 15000));
    await w.kill(); await call;
    const rev = iss.revCount();
    await w.launch(); await w.unlock();
    check('nothing stored; the request is still journalled', (await state(w)).sandwiches === 0 && (await w.pending()).length === 1);
    const r = await w.recover();
    const st = await state(w);
    check('recovery gets the stored answer: one sandwich, 5 credits, no second spend', r[0].status === 'completed' && st.sandwiches === 1 && st.credit === 5 && iss.revCount() === rev, { r, st });
  });

  await scenario(kind, 'P4 the wallet locks while the purchase answer is on its way', async (w, iss) => {
    await fund(w, iss);
    await w.inject('delayAnswer', '/atlas/asset/purchase');
    const call = w.W((a) => AtlasWallet.purchaseAsset('self', a.d, a.c, 1).then(() => 'ok', (e) => ({ message: e.message, pending: !!e.pending, code: e.code })), { d: iss.domain, c: SANDWICH });
    check('the request is in flight', await w.waitHits(1, 15000));
    await lockWallet(w); await w.release();
    const out = await call;
    check('the call reports the request as saved', out !== 'ok' && (out.pending === true || out.code === 'wallet-locked'), out);
    await w.clearFault(); await w.unlock();
    check('the journal still holds it', (await w.pending()).length === 1);
    const r = await w.recover();
    const st = await state(w);
    check('after the unlock the stored answer is applied once', r[0].status === 'completed' && st.sandwiches === 1 && st.credit === 5, { r, st });
  });

  await scenario(kind, 'P5 issuer unavailable, then repeated retries with the same request id', async (w, iss) => {
    await fund(w, iss);
    await w.inject('failFetch', '/atlas/asset/purchase');
    const out = await buy(w, iss, SANDWICH);
    const rev = iss.revCount();
    check('unreachable: saved, nothing spent', out !== 'ok' && out.pending === true, out);
    const [first] = await w.pending();
    const fault = await w.faultInfo();
    const r1 = await w.recover(); const r2 = await w.recover();
    const [entry] = await w.pending();
    check('two more attempts fail; same request id, attempts counted, nothing spent', r1[0].status === 'pending' && r2[0].status === 'pending' && entry.requestId === first.requestId && entry.attempts === 3 && iss.revCount() === rev, { r1, r2, entry });
    await w.clearFault();
    const r3 = await w.recover(); const r4 = await w.recover();
    const st = await state(w);
    check('the issuer back: completes once, a further recovery has nothing to do', r3[0].status === 'completed' && r4.length === 0 && st.sandwiches === 1 && st.credit === 5 && iss.revCount() === rev + 1, { r3, r4, st });
    const sent = JSON.parse(fault.bodies[0]);
    const direct = [];
    for (let i = 0; i < 3; i++) direct.push(await post(iss, '/atlas/asset/purchase', sent));
    const [owned] = await live(w, SANDWICH);
    check('the same request asked three more times returns the same sandwich and spends nothing', direct.every((d) => d.status === 200 && d.body.purchased.id === owned.id) && iss.revCount() === rev + 1, direct.map((d) => d.status));
  });

  await scenario(kind, 'P6 the same request id with changed parameters, other buyers, no binding', async (w, iss) => {
    const bob = await rawIdentity(), carol = await rawIdentity();
    const bobCredit = await rawIssue(iss, bob, CREDIT, 10), carolCredit = await rawIssue(iss, carol, CREDIT, 10);
    const rid = newRid();
    const a = await rawPurchase(iss, bob, bobCredit, SANDWICH, rid, rid);
    check('first request buys the sandwich', a.status === 200 && a.body.purchased.asset.class === SANDWICH && a.body.balance.quantity === 5, a);
    const rev = iss.revCount();
    const again = await rawPurchase(iss, bob, bobCredit, SANDWICH, rid, rid);
    check('an identical request (fresh signature) returns the same sandwich and balance', again.status === 200 && again.body.purchased.id === a.body.purchased.id && again.body.balance.id === a.body.balance.id && iss.revCount() === rev, again);
    const juice = await rawPurchase(iss, bob, bobCredit, 'atlas.demo.cafeteria.juice', rid, rid);
    check('another class under that id: 409 request-id-conflict, nothing bought', juice.status === 409 && juice.body.code === 'request-id-conflict' && iss.revCount() === rev, juice);
    const stolen = await rawPurchase(iss, carol, carolCredit, SANDWICH, rid, rid);
    check('another buyer (and balance) under that id: 409 and none of the first buyer\'s credentials', stolen.status === 409 && !JSON.stringify(stolen.body).includes(a.body.purchased.id) && iss.revCount() === rev, stolen);
    const withRemainder = await rawPurchase(iss, bob, a.body.balance, SANDWICH, rid, rid);
    check('the same id with a different presented balance: 409', withRemainder.status === 409 && iss.revCount() === rev, withRemainder);
    const unbound = await rawPurchase(iss, carol, carolCredit, SANDWICH, newRid(), null);
    check('a request id that the signed intent does not carry: 400, nothing spent', unbound.status === 400 && iss.revCount() === rev, unbound);
    const mismatched = await rawPurchase(iss, carol, carolCredit, SANDWICH, newRid(), newRid());
    check('an intent whose id differs from the body id: 400, nothing spent', mismatched.status === 400 && iss.revCount() === rev, mismatched);
    const plain = await rawPurchase(iss, carol, carolCredit, SANDWICH, null, null);
    check('a request with no id at all works exactly as before', plain.status === 200 && plain.body.purchased.asset.class === SANDWICH, plain);
  });

  await scenario(kind, 'P7 simultaneous retries from several wallet views', async (w, iss) => {
    await fund(w, iss);
    const { fault } = await lostBuy(w, iss);
    const rev = iss.revCount();
    const body = JSON.parse(fault.bodies[0]);
    const direct = await Promise.all([1, 2, 3, 4, 5, 6].map(() => post(iss, '/atlas/asset/purchase', body)));
    const ids = new Set(direct.filter((d) => d.status === 200).map((d) => d.body.purchased.id));
    check('six simultaneous identical requests: one sandwich, one spend', direct.every((d) => d.status === 200 || d.status === 503) && ids.size === 1 && iss.revCount() === rev, { statuses: direct.map((d) => d.status), rev: iss.revCount() });
    const id = new URL(w.sw.url()).host;
    const pages = [];
    for (let i = 0; i < 3; i++) { const pg = await w.context.newPage(); await pg.goto('chrome-extension://' + id + '/viewer.html'); await pg.waitForFunction(() => typeof AtlasWallet !== 'undefined', null, { timeout: 15000 }); pages.push(pg); }
    const results = await Promise.all([w.recover(), ...pages.map((pg) => pg.evaluate((k) => AtlasWallet.recoverPendingOperations(k), w.pub))]);
    await waitFor(async () => (await w.pending()).length === 0, 15000);
    const st = await state(w);
    check('three pages and the worker recover at once: one sandwich, 5 credits, journal empty', st.sandwiches === 1 && st.credit === 5 && (await w.pending()).length === 0 && results.flat().filter((o) => o.status === 'completed' && o.applied === true).length <= 1, { results, st });
    for (const pg of pages) await pg.close();
  });

  await scenario(kind, 'P8 a backup taken with the purchase pending is restored into a fresh profile', async (w, iss, ctx) => {
    await fund(w, iss);
    await lostBuy(w, iss);
    const [entry] = await w.pending();
    const file = await exportBackup(w);
    const t = await ctx.fresh('p8restore', w);
    await t.create().catch(() => null);
    const imported = await importBackup(t, file, w.seed);
    check('the backup restores', imported.ok === true, imported);
    t.pub = w.pub;
    await t.restart(true).catch(() => null);
    const [carried] = await t.pending();
    check('the pending purchase came with the backup under the same request id', !!carried && carried.requestId === entry.requestId && carried.kind === 'purchase', carried);
    const rev = iss.revCount();
    const r = await t.recover();
    const st = await state(t);
    check('recovery in the new profile completes it once, nothing spent again', r[0].status === 'completed' && st.sandwiches === 1 && st.credit === 5 && iss.revCount() === rev, { r, st });
    const again = await w.recover();
    check('the original profile recovers the same sandwich; still one spend at the issuer', again[0].status === 'completed' && (await live(w, SANDWICH)).map((x) => x.id).join() === (await live(t, SANDWICH)).map((x) => x.id).join() && iss.revCount() === rev, again);
  });

  await scenario(kind, 'P9 the stored result has expired', async (w, iss) => {
    await fund(w, iss);
    await lostBuy(w, iss);
    await sleep(EXPIRY_WAIT_MS);
    await w.restart(true);
    const rev = iss.revCount();
    const r = await w.recover();
    const [entry] = await w.pending();
    check('the issuer refuses the revoked balance; the wallet keeps the entry as needs-attention', r.length === 1 && r[0].status === 'needs-attention' && entry.state === 'needs-attention', { r, entry });
    check('nothing was bought a second time; the balance stays held back', iss.revCount() === rev && (await state(w)).sandwiches === 0 && (await state(w)).credit === 0, await state(w));
    const again = await w.recover();
    check('automatic recovery does not send it again', again[0].status === 'needs-attention' && iss.revCount() === rev, again);
    info('after expiry the sandwich can no longer be retrieved; the 5 credits it cost stay with the issuer (the wallet shows the entry as needing attention)');
  }, { env: TTL_ENV });

  await scenario(kind, 'P10 an answer that is not a result is never applied', async (w, iss) => {
    await fund(w, iss);
    await fakeAnswer(w, '/atlas/asset/purchase', 'html', 1);
    const a = await buy(w, iss, SANDWICH);
    check('an HTML 200 answer: saved, nothing applied, issuer untouched', a !== 'ok' && a.pending === true && (await state(w)).sandwiches === 0 && iss.replays().filter((x) => x.op === 'purchase').length === 0, a);
    await w.clearFault();
    await fakeAnswer(w, '/atlas/asset/purchase', 'truncated', 1);
    const r1 = await w.recover();
    check('a truncated answer is not applied', r1[0].status === 'pending' && (await state(w)).sandwiches === 0, r1);
    await w.restart(true);
    await fakeAnswer(w, '/atlas/asset/purchase', 'otherOwner', 1);
    const r2 = await w.recover();
    check('an answer naming another owner is not applied', r2[0].status === 'pending' && (await state(w)).sandwiches === 0, r2);
    await w.restart(true);
    const r3 = await w.recover();
    const st = await state(w);
    check('the genuine answer is then applied once', r3[0].status === 'completed' && st.sandwiches === 1 && st.credit === 5, { r3, st });
  });

  await scenario(kind, 'P11 refusals before any journal entry', async (w, iss) => {
    await fund(w, iss);
    check('two sandwiches use up the balance', (await buy(w, iss, SANDWICH)) === 'ok' && (await buy(w, iss, SANDWICH)) === 'ok' && (await state(w)).credit === 0);
    const poor = await buy(w, iss, SANDWICH);
    check('too expensive: refused locally, no entry', poor !== 'ok' && !poor.pending && (await w.pending()).length === 0, poor);
    const nope = await buy(w, iss, IRON);
    check('not for sale: refused locally, no entry', nope !== 'ok' && !nope.pending && (await w.pending()).length === 0, nope);
  });
}

// ---------------------------------------------------------------- trade claim
async function rawIntent(id, offer, want, counterparty, extra) {
  const payload = Object.assign({ offer, want, expiresAt: new Date(Date.now() + 10 * 60000).toISOString() }, counterparty ? { counterparty } : {}, extra || {});
  return { payload, proof: await rawProof(id, payload) };
}
// One open listing, IRON 10 for GOLD 5, posted by a throw-away poster whose iron is issued by `ironIss` (default: the station).
async function postListing(station, ironIss) {
  const alice = await rawIdentity();
  const membership = await rawIssue(station, alice, MEMBER);
  const iron = await rawIssue(ironIss || station, alice, IRON, 10);
  const intent = await rawIntent(alice, { class: IRON, quantity: 10 }, { class: GOLD, quantity: 5 });
  const sub = await post(station, '/atlas/trade/submit', { membership, intent, balance: iron });
  if (sub.status !== 200) throw new Error('listing failed: ' + JSON.stringify(sub.body));
  return { alice, iron, membership, pendingId: sub.body.pendingId };
}
const listingCount = async (station) => { const r = await station.api.get('/atlas/trade/listings'); return r.body && r.body.listings ? r.body.listings.length : -1; };
const claimMails = (station) => station.roster('mail').filter((m) => /Listing claimed/.test(m.subject || '')).length;
async function rawClaim(station, claimant, membership, gold, listing, rid, bind) {
  const intent = await rawIntent(claimant, { class: GOLD, quantity: 5 }, { class: IRON, quantity: 10 }, listing.alice.pub, bind ? { requestId: bind } : {});
  return post(station, '/atlas/trade/claim', Object.assign({ pendingId: listing.pendingId, membership, intent, balance: gold }, rid ? { requestId: rid } : {}));
}
// The wallet claims the station's only listing with its gold balance issued by `goldDomain`.
const walletClaim = (w, station, goldDomain) => w.W(async (a) => {
  const held = (await AtlasWallet.getWallet(a.k)).map((e) => e.credential);
  const membership = held.find((c) => c.asset.class === a.m && c.issuer.domain === a.d);
  const gold = held.find((c) => c.asset.class === a.g && c.issuer.domain === a.gd && c.asset.fungible === true);
  const listings = await AtlasWallet.fetchTradeListings(a.d);
  try { await AtlasWallet.claimTradeListing(a.d, membership, listings[0], gold); return 'ok'; }
  catch (e) { return { message: String(e.message).slice(0, 200), pending: !!e.pending, needsAttention: !!e.needsAttention, code: e.code }; }
}, { k: w.pub, m: MEMBER, g: GOLD, d: station.domain, gd: goldDomain || station.domain });

// Trusted trade peers of a throw-away issuer.
const trustPeers = (iss, domains) => fs.writeFileSync(path.join(iss.stateDir, 'atlas-trusted-trade-peers-store.json'), JSON.stringify({ peers: domains }));

// An issuer whose relay-settle always fails right after its checks, before it changes anything (a timeout).
function failingSettleOpts(kind) {
  if (kind === 'php') {
    return { prepare: (bundle) => {
      const f = path.join(bundle, 'atlas', 'trade', 'relay-settle.php');
      const src = fs.readFileSync(f, 'utf8');
      const mk = '$settled = fulfill_trade_side_settlement($kp, $credential, $spendQuantity, $newOwnerPublicKey, $mailNotice);';
      if (!src.includes(mk)) throw new Error('relay-settle.php changed shape');
      fs.writeFileSync(f, src.replace(mk, "send_json(500, ['error' => 'INJECTED: simulated relay-settle failure']);\n" + mk));
    } };
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-failing-settle-'));
  fs.cpSync(path.join(REPO, 'issuer-server'), path.join(root, 'issuer-server'), { recursive: true });
  const f = path.join(root, 'issuer-server', 'server.js');
  const src = fs.readFileSync(f, 'utf8');
  const mk = 'const settled = await fulfillTradeSideSettlement(credential, spendQuantity, newOwnerPublicKey, mailNotice);';
  if (!src.includes(mk)) throw new Error('server.js changed shape');
  fs.writeFileSync(f, src.replace(mk, "return sendJson(res, 500, { error: 'INJECTED: simulated relay-settle failure' });\n        " + mk));
  return { root };
}

async function claimScenarios(kind) {
  const prepare = async (w, iss) => {
    const listing = await postListing(iss);
    for (const [cls, q] of [[MEMBER, undefined], [GOLD, 10]]) { const r = await mint(w, iss, cls, q); if (r !== 'ok') throw new Error('setup mint failed: ' + JSON.stringify(r)); }
    return listing;
  };
  const state = async (w) => ({ iron: sum(await live(w, IRON)), gold: sum(await live(w, GOLD)) });
  const lostClaim = async (w, iss) => {
    await w.inject('dropAnswer', '/atlas/trade/claim');
    const out = await walletClaim(w, iss);
    const fault = await w.faultInfo();
    await w.clearFault();
    return { out, fault };
  };

  await scenario(kind, 'C1 a claim whose answer is lost after the station settled it', async (w, iss) => {
    await prepare(w, iss);
    const { out, fault } = await lostClaim(w, iss);
    check('the wallet reports the claim as saved, not failed', out !== 'ok' && out.pending === true, out);
    const [entry] = await w.pending();
    check('journal: kind claim, the gold balance as predecessor, the id that was sent and signed', !!entry && entry.kind === 'claim' && entry.predecessors.length === 1 && JSON.parse(fault.bodies[0]).requestId === entry.requestId && JSON.parse(fault.bodies[0]).intent.payload.requestId === entry.requestId, entry);
    const settled = iss.revCount();
    check('the station settled it once: the listing is gone, the poster was told once', fault.hits === 1 && (await listingCount(iss)) === 0 && claimMails(iss) === 1, { hits: fault.hits, listings: await listingCount(iss), mails: claimMails(iss) });
    check('the wallet shows neither the iron nor a spendable gold', (await state(w)).iron === 0 && (await state(w)).gold === 0, await state(w));
    await w.restart(true);
    const r = await w.recover();
    const st = await state(w);
    check('recovery after the restart completes it: 10 iron, 5 gold left', r.length === 1 && r[0].status === 'completed' && st.iron === 10 && st.gold === 5, { r, st });
    check('nothing was settled again: no further revocation, one poster mail, journal empty', iss.revCount() === settled && claimMails(iss) === 1 && (await w.pending()).length === 0, { rev: iss.revCount(), settled });
  });

  await scenario(kind, 'C2 browser killed before the claim was sent', async (w, iss) => {
    await prepare(w, iss);
    await w.inject('hangFetch', '/atlas/trade/claim');
    const call = w.W((a) => AtlasWallet.fetchTradeListings(a.d).then(async (ls) => {
      const held = (await AtlasWallet.getWallet(a.k)).map((e) => e.credential);
      return AtlasWallet.claimTradeListing(a.d, held.find((c) => c.asset.class === a.m), ls[0], held.find((c) => c.asset.class === a.g && c.asset.fungible)).then(() => 'ok', (e) => e.message);
    }), { k: w.pub, m: MEMBER, g: GOLD, d: iss.domain }).catch(() => null);
    check('the request was about to be sent', await w.waitHits(1, 15000));
    const [entry] = await w.pending();
    check('the journal entry exists before sending', !!entry && entry.kind === 'claim' && entry.attempts === 0, entry);
    await w.kill(); await call;
    await w.launch(); await w.unlock();
    check('the station never saw it: the listing is still open', (await listingCount(iss)) === 1 && claimMails(iss) === 0);
    const r = await w.recover();
    const st = await state(w);
    check('recovery sends it once: 10 iron, 5 gold', r[0].status === 'completed' && st.iron === 10 && st.gold === 5 && (await listingCount(iss)) === 0, { r, st });
  });

  await scenario(kind, 'C3 browser killed after the station settled, before the answer was stored', async (w, iss) => {
    await prepare(w, iss);
    await w.inject('hangCommit', '/atlas/trade/claim');
    const call = w.W((a) => AtlasWallet.fetchTradeListings(a.d).then(async (ls) => {
      const held = (await AtlasWallet.getWallet(a.k)).map((e) => e.credential);
      return AtlasWallet.claimTradeListing(a.d, held.find((c) => c.asset.class === a.m), ls[0], held.find((c) => c.asset.class === a.g && c.asset.fungible)).then(() => 'ok', (e) => e.message);
    }), { k: w.pub, m: MEMBER, g: GOLD, d: iss.domain }).catch(() => null);
    check('the station answered and the wallet was about to store it', await waitFor(async () => (await w.faultInfo()).hits >= 1, 15000));
    await w.kill(); await call;
    const settled = iss.revCount();
    await w.launch(); await w.unlock();
    check('nothing stored; the request is still journalled', (await state(w)).iron === 0 && (await w.pending()).length === 1);
    const r = await w.recover();
    const st = await state(w);
    check('recovery gets the stored outcome: 10 iron, 5 gold, no second settlement', r[0].status === 'completed' && st.iron === 10 && st.gold === 5 && iss.revCount() === settled && claimMails(iss) === 1, { r, st });
  });

  await scenario(kind, 'C4 the wallet locks while the claim answer is on its way', async (w, iss) => {
    await prepare(w, iss);
    await w.inject('delayAnswer', '/atlas/trade/claim');
    const call = walletClaim(w, iss);
    check('the request is in flight', await w.waitHits(1, 15000));
    await lockWallet(w); await w.release();
    const out = await call;
    check('the call reports the request as saved', out !== 'ok' && (out.pending === true || out.code === 'wallet-locked'), out);
    await w.clearFault(); await w.unlock();
    check('the journal still holds it', (await w.pending()).length === 1);
    const r = await w.recover();
    const st = await state(w);
    check('after the unlock the stored outcome is applied once', r[0].status === 'completed' && st.iron === 10 && st.gold === 5, { r, st });
  });

  await scenario(kind, 'C5 station unavailable, then repeated retries with the same request id', async (w, iss) => {
    await prepare(w, iss);
    await w.inject('failFetch', '/atlas/trade/claim');
    const out = await walletClaim(w, iss);
    check('unreachable: saved, nothing settled', out !== 'ok' && out.pending === true && (await listingCount(iss)) === 1, out);
    const [first] = await w.pending();
    const fault = await w.faultInfo();
    const r1 = await w.recover(); const r2 = await w.recover();
    const [entry] = await w.pending();
    check('two more attempts fail; same request id, attempts counted', r1[0].status === 'pending' && r2[0].status === 'pending' && entry.requestId === first.requestId && entry.attempts === 3, { r1, r2, entry });
    await w.clearFault();
    const r3 = await w.recover(); const r4 = await w.recover();
    const st = await state(w);
    const settled = iss.revCount();
    check('the station back: completes once, a further recovery has nothing to do', r3[0].status === 'completed' && r4.length === 0 && st.iron === 10 && st.gold === 5, { r3, r4, st });
    const sent = JSON.parse(fault.bodies[0]);
    const direct = [];
    for (let i = 0; i < 3; i++) direct.push(await post(iss, '/atlas/trade/claim', sent));
    const [owned] = await live(w, IRON);
    check('the same request asked three more times returns the same iron and settles nothing', direct.every((d) => d.status === 200 && d.body.received.id === owned.id) && iss.revCount() === settled && claimMails(iss) === 1, direct.map((d) => d.status));
  });

  await scenario(kind, 'C6 the same request id with changed parameters, other claimants, no binding', async (w, iss) => {
    const l1 = await postListing(iss), l2 = await postListing(iss);
    const bob = await rawIdentity(), carol = await rawIdentity();
    const bobMember = await rawIssue(iss, bob, MEMBER), carolMember = await rawIssue(iss, carol, MEMBER);
    const bobGold = await rawIssue(iss, bob, GOLD, 10), carolGold = await rawIssue(iss, carol, GOLD, 10);
    const rid = newRid();
    const a = await rawClaim(iss, bob, bobMember, bobGold, l1, rid, rid);
    check('first request settles the first listing', a.status === 200 && a.body.status === 'settled' && a.body.received.asset.class === IRON && (await listingCount(iss)) === 1, a);
    const rev = iss.revCount();
    const again = await rawClaim(iss, bob, bobMember, bobGold, l1, rid, rid);
    check('an identical request (fresh signature) returns the same iron, settles nothing', again.status === 200 && again.body.received.id === a.body.received.id && iss.revCount() === rev && claimMails(iss) === 1, again);
    const other = await rawClaim(iss, bob, bobMember, bobGold, l2, rid, rid);
    check('the same id for the other listing: 409 request-id-conflict, that listing stays open', other.status === 409 && other.body.code === 'request-id-conflict' && (await listingCount(iss)) === 1 && iss.revCount() === rev, other);
    const stolen = await rawClaim(iss, carol, carolMember, carolGold, l2, rid, rid);
    check('another claimant under that id: 409 and nothing of the first claimant\'s credentials', stolen.status === 409 && !JSON.stringify(stolen.body).includes(a.body.received.id) && (await listingCount(iss)) === 1 && iss.revCount() === rev, stolen);
    const unbound = await rawClaim(iss, carol, carolMember, carolGold, l2, newRid(), null);
    check('an id the signed intent does not carry: 400, nothing settled', unbound.status === 400 && (await listingCount(iss)) === 1 && iss.revCount() === rev, unbound);
    const mismatched = await rawClaim(iss, carol, carolMember, carolGold, l2, newRid(), newRid());
    check('an intent whose id differs from the body id: 400, nothing settled', mismatched.status === 400 && (await listingCount(iss)) === 1 && iss.revCount() === rev, mismatched);
    const plain = await rawClaim(iss, carol, carolMember, carolGold, l2, null, null);
    check('a request with no id at all works exactly as before', plain.status === 200 && plain.body.status === 'settled' && (await listingCount(iss)) === 0, plain);
  });

  await scenario(kind, 'C7 simultaneous retries from several wallet views', async (w, iss) => {
    await prepare(w, iss);
    const { fault } = await lostClaim(w, iss);
    const settled = iss.revCount();
    const body = JSON.parse(fault.bodies[0]);
    const direct = await Promise.all([1, 2, 3, 4, 5, 6].map(() => post(iss, '/atlas/trade/claim', body)));
    const ids = new Set(direct.filter((d) => d.status === 200).map((d) => d.body.received.id));
    check('six simultaneous identical requests: one iron, one settlement', direct.every((d) => d.status === 200 || d.status === 503) && ids.size === 1 && iss.revCount() === settled, { statuses: direct.map((d) => d.status) });
    const id = new URL(w.sw.url()).host;
    const pages = [];
    for (let i = 0; i < 3; i++) { const pg = await w.context.newPage(); await pg.goto('chrome-extension://' + id + '/viewer.html'); await pg.waitForFunction(() => typeof AtlasWallet !== 'undefined', null, { timeout: 15000 }); pages.push(pg); }
    const results = await Promise.all([w.recover(), ...pages.map((pg) => pg.evaluate((k) => AtlasWallet.recoverPendingOperations(k), w.pub))]);
    await waitFor(async () => (await w.pending()).length === 0, 15000);
    await waitFor(async () => (await w.pending()).length === 0, 15000);
    const st = await state(w);
    check('three pages and the worker recover at once: 10 iron, 5 gold, journal empty', st.iron === 10 && st.gold === 5 && (await w.pending()).length === 0 && results.flat().filter((o) => o.status === 'completed' && o.applied === true).length <= 1, { results, st });
    for (const pg of pages) await pg.close();
  });

  await scenario(kind, 'C8 a backup taken with the claim pending is restored into a fresh profile', async (w, iss, ctx) => {
    await prepare(w, iss);
    await lostClaim(w, iss);
    const [entry] = await w.pending();
    const file = await exportBackup(w);
    const t = await ctx.fresh('c8restore', w);
    await t.create().catch(() => null);
    const imported = await importBackup(t, file, w.seed);
    check('the backup restores', imported.ok === true, imported);
    t.pub = w.pub;
    await t.restart(true).catch(() => null);
    const [carried] = await t.pending();
    check('the pending claim came with the backup under the same request id', !!carried && carried.requestId === entry.requestId && carried.kind === 'claim', carried);
    const settled = iss.revCount();
    const r = await t.recover();
    const st = await state(t);
    check('recovery in the new profile completes it once, nothing settled again', r[0].status === 'completed' && st.iron === 10 && st.gold === 5 && iss.revCount() === settled, { r, st });
    const again = await w.recover();
    check('the original profile recovers the same iron; still one settlement', again[0].status === 'completed' && (await live(w, IRON)).map((x) => x.id).join() === (await live(t, IRON)).map((x) => x.id).join() && iss.revCount() === settled, again);
  });

  await scenario(kind, 'C9 the stored outcome has expired', async (w, iss) => {
    await prepare(w, iss);
    await lostClaim(w, iss);
    await sleep(EXPIRY_WAIT_MS);
    await w.restart(true);
    const settled = iss.revCount();
    const r = await w.recover();
    const [entry] = await w.pending();
    check('the station no longer has the listing or the balance: needs-attention, not resent as a new claim', r.length === 1 && r[0].status === 'needs-attention' && entry.state === 'needs-attention', { r, entry });
    check('nothing settled again; the gold stays held back', iss.revCount() === settled && (await state(w)).iron === 0 && (await state(w)).gold === 0, await state(w));
    const again = await w.recover();
    check('automatic recovery does not send it again', again[0].status === 'needs-attention' && iss.revCount() === settled, again);
    info('after expiry the iron can no longer be retrieved by this request; the entry stays visible for the operator or the poster\'s mail');
  }, { env: TTL_ENV });

  await scenario(kind, 'C10 an answer that is not a result is never applied', async (w, iss) => {
    await prepare(w, iss);
    await fakeAnswer(w, '/atlas/trade/claim', 'html', 1);
    const a = await walletClaim(w, iss);
    check('an HTML 200 answer: saved, nothing applied, listing still open', a !== 'ok' && a.pending === true && (await state(w)).iron === 0 && (await listingCount(iss)) === 1, a);
    await w.clearFault();
    await fakeAnswer(w, '/atlas/trade/claim', 'truncated', 1);
    const r1 = await w.recover();
    check('a truncated answer is not applied', r1[0].status === 'pending' && (await state(w)).iron === 0, r1);
    await w.restart(true);
    await fakeAnswer(w, '/atlas/trade/claim', 'otherOwner', 1);
    const r2 = await w.recover();
    check('an answer naming another owner is not applied', r2[0].status === 'pending' && (await state(w)).iron === 0, r2);
    await w.restart(true);
    const r3 = await w.recover();
    const st = await state(w);
    check('the genuine outcome is then applied once', r3[0].status === 'completed' && st.iron === 10 && st.gold === 5, { r3, st });
  });

  await scenario(kind, 'C11 second leg fails after the first: the refund survives a lost answer', async (w, iss, ctx) => {
    const foreign = await ctx.issuer(kind, Object.assign({ workers: 4 }, failingSettleOpts(kind)));
    trustPeers(iss, [foreign.domain]); trustPeers(foreign, [iss.domain]);
    const listing = await postListing(iss, foreign);
    for (const [cls, q] of [[MEMBER, undefined], [GOLD, 5]]) { const r = await mint(w, iss, cls, q); if (r !== 'ok') throw new Error('setup mint failed: ' + JSON.stringify(r)); }
    const { out, fault } = await lostClaim(w, iss);
    check('the 502 answer was lost: the claim is saved', out !== 'ok' && out.pending === true, out);
    const revAfter = iss.revCount();
    check('the first leg ran: the claimant\'s gold is revoked, the poster\'s iron is not', iss.revoked().has((await w.pending())[0].predecessors[0]) && !foreign.revoked().has(listing.iron.id), { revoked: [...iss.revoked()].length });
    await w.restart(true);
    const r = await w.recover();
    const st = await state(w);
    check('recovery obtains the stored outcome and adopts the refund: 5 gold back, no iron', r.length === 1 && st.gold === 5 && st.iron === 0, { r, st });
    check('the entry is closed and nothing was refunded twice', (await w.pending()).length === 0 && iss.revCount() === revAfter, { pending: (await w.pending()).length, rev: iss.revCount(), revAfter });
    const r2 = await w.recover();
    check('a further recovery changes nothing', r2.length === 0 && (await state(w)).gold === 5, r2);
    check('the listing is still open for the poster (its iron untouched)', !foreign.revoked().has(listing.iron.id));
  }, { workers: 4 });

  await scenario(kind, 'C13 second leg fails when the claimant paid from a larger balance: the change arrives with the refund', async (w, iss, ctx) => {
    const foreign = await ctx.issuer(kind, Object.assign({ workers: 4 }, failingSettleOpts(kind)));
    trustPeers(iss, [foreign.domain]); trustPeers(foreign, [iss.domain]);
    await postListing(iss, foreign);
    for (const [cls, q] of [[MEMBER, undefined], [GOLD, 10]]) { const r = await mint(w, iss, cls, q); if (r !== 'ok') throw new Error('setup mint failed: ' + JSON.stringify(r)); }
    const out = await walletClaim(w, iss);
    const st = await state(w);
    const probe = await iss.api.post('/atlas/asset/issue', { ownerPublicKey: w.pub, assetClass: GOLD, quantity: 501, requestId: newRid() });
    const heldAtStation = probe.status === 400 && probe.body && probe.body.code === 'cap' ? probe.body.held : null;
    check('the 5 gold refund and the 5 gold change are both held; the station counts the same 10; no iron; the entry is closed', st.gold === 10 && st.iron === 0 && heldAtStation === 10 && (await w.pending()).length === 0, { out, st, heldAtStation });
  }, { workers: 4 });

  await scenario(kind, 'C12 first leg fails with an unknown outcome: the claim stays visible and is not resent', async (w, iss, ctx) => {
    const foreign = await ctx.issuer(kind, Object.assign({ workers: 4 }, failingSettleOpts(kind)));
    trustPeers(iss, [foreign.domain]); trustPeers(foreign, [iss.domain]);
    await postListing(iss);
    const r0 = await mint(w, iss, MEMBER); if (r0 !== 'ok') throw new Error('membership failed');
    const r1 = await mint(w, foreign, GOLD, 5); if (r1 !== 'ok') throw new Error('foreign gold failed: ' + JSON.stringify(r1));
    const out = await walletClaim(w, iss, foreign.domain);
    check('the claim is held, not failed and not lost', out !== 'ok' && (out.needsAttention === true || out.pending === true), out);
    const [entry] = await w.pending();
    check('the entry exists and is marked needs-attention (the first leg\'s outcome is not known)', !!entry && entry.kind === 'claim' && entry.state === 'needs-attention', entry);
    check('the listing is still open and nothing of the poster\'s was spent', (await listingCount(iss)) === 1);
    const attempts = entry.attempts;
    const r = await w.recover();
    const [after] = await w.pending();
    check('automatic recovery does not resend it', r[0].status === 'needs-attention' && after.attempts === attempts, { r, attempts, after: after && after.attempts });
    check('the gold stays held back so it cannot be spent twice', (await state(w)).gold === 0 && (await shown(w, GOLD)).every((x) => x.held !== null), await shown(w, GOLD));
  }, { workers: 4 });
}


// ---------------------------------------------------------------- compatibility: an issuer that may not repeat a request
// Replaces the capability answer for this page and records every issuer operation the page sends from now on.
async function fakeCapabilities(w, mode) {
  await w.W(([m]) => {
    const inner = globalThis.__capInner || (globalThis.__capInner = globalThis.fetch.bind(globalThis));
    globalThis.__sentOps = [];
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (/\/atlas\/(asset|trade)\//.test(u) && opts && opts.method === 'POST') globalThis.__sentOps.push(u);
      if (/\/atlas\/capabilities/.test(u)) {
        if (m === 'missing') return new Response('{"error":"not found"}', { status: 404 });
        if (m === 'unreachable') throw new TypeError('Failed to fetch (capabilities unreachable in test)');
        if (m === 'fungible-only') return new Response(JSON.stringify({ requestIds: { version: 1, operations: ['issue', 'split', 'consolidate', 'convert'], retentionHours: 168 } }), { status: 200 });
      }
      return inner(url, opts);
    };
  }, [mode]);
}
const sentOps = (w) => w.W(() => globalThis.__sentOps || []);

async function compatScenarios(kind) {
  await scenario(kind, 'K1 what the issuer advertises', async (w, iss) => {
    const r = await iss.api.get('/atlas/capabilities');
    const ops = r.body && r.body.requestIds && r.body.requestIds.operations;
    check('GET /atlas/capabilities lists unique mint, purchase, trade claim and its change field', r.status === 200 && ['issue', 'issue-unique', 'purchase', 'trade-claim', 'trade-claim-remainder'].every((o) => (ops || []).includes(o)), r);
    check('and says how long a stored result is kept', typeof r.body.requestIds.retentionHours === 'number' && Math.abs(r.body.requestIds.retentionHours - 0.0006) < 1e-9, r.body);
  }, { env: TTL_ENV });

  await scenario(kind, 'K2 a journalled mint meets an issuer that does not list it', async (w, iss) => {
    await lostRing(w, iss);
    const [entry] = await w.pending();
    await w.restart(true);
    await fakeCapabilities(w, 'missing');
    const serial = iss.serial(RING);
    const r = await w.recover();
    const [after] = await w.pending();
    check('the entry becomes needs-attention (repeat-unsupported) and nothing is sent', r.length === 1 && r[0].status === 'needs-attention' && after.state === 'needs-attention' && after.attention && after.attention.code === 'repeat-unsupported' && (await sentOps(w)).length === 0 && iss.serial(RING) === serial, { r, attention: after && after.attention, sent: await sentOps(w) });
    check('same request id kept; a further recovery still sends nothing', after.requestId === entry.requestId && (await w.recover())[0].status === 'needs-attention' && (await sentOps(w)).length === 0);
  });

  await scenario(kind, 'K3 the capability answer is unavailable: the entry waits, nothing is sent', async (w, iss) => {
    await lostRing(w, iss);
    await w.restart(true);
    await fakeCapabilities(w, 'unreachable');
    const r = await w.recover();
    const [after] = await w.pending();
    check('pending (not failed, not attention), nothing sent', r[0].status === 'pending' && after.state !== 'needs-attention' && (await sentOps(w)).length === 0, { r, after });
    await w.restart(true);
    const r2 = await w.recover();
    check('when the capability answer is back the same request completes it, one ring', r2[0].status === 'completed' && (await shown(w, RING)).length === 1 && iss.serial(RING) === 1, r2);
  });

  await scenario(kind, 'K4 an issuer that lists only the fungible operations holds a purchase', async (w, iss) => {
    const r0 = await mint(w, iss, CREDIT, 10); if (r0 !== 'ok') throw new Error('funding failed');
    await lostBuy(w, iss);
    await w.restart(true);
    await fakeCapabilities(w, 'fungible-only');
    const rev = iss.revCount();
    const r = await w.recover();
    const [after] = await w.pending();
    check('needs-attention (repeat-unsupported), nothing sent, balance stays held back', r[0].status === 'needs-attention' && after.attention.code === 'repeat-unsupported' && (await sentOps(w)).length === 0 && iss.revCount() === rev && sum(await live(w, CREDIT)) === 0, { r, after });
  });

  await scenario(kind, 'K5 a fresh unique mint at an issuer without the capability keeps the single request it always had', async (w, iss) => {
    await fakeCapabilities(w, 'missing');
    const out = await mint(w, iss, RING);
    const sent = await sentOps(w);
    check('the ring arrives', out === 'ok' && (await shown(w, RING)).length === 1, out);
    check('one request, no journal entry left', sent.length === 1 && (await w.pending()).length === 0, sent);
  });

  if (kind === 'php') {
    await scenario(kind, 'K7 a claim handler that stores outcomes but does not return the change is not advertised as doing so', async (w, iss) => {
      const ops = (await iss.api.get('/atlas/capabilities')).body.requestIds.operations;
      check('trade-claim is listed, trade-claim-remainder is not', ops.includes('trade-claim') && !ops.includes('trade-claim-remainder'), ops);
    }, { prepare: (bundle) => {
      const f = path.join(bundle, 'atlas', 'trade', 'claim.php');
      fs.writeFileSync(f, fs.readFileSync(f, 'utf8').split("'remainder' => $bRemainder, 'code' => 'claim-incomplete'").join("'code' => 'claim-incomplete'"));
    } });
  }

  if (kind === 'php') {
    await scenario(kind, 'K6 a bundle uploaded in part does not advertise the handler that is still old', async (w, iss) => {
      const r = await iss.api.get('/atlas/capabilities');
      const ops = r.body.requestIds.operations;
      check('trade-claim is missing, purchase and unique mint are listed', !ops.includes('trade-claim') && ops.includes('purchase') && ops.includes('issue-unique'), ops);
    }, { prepare: (bundle) => {
      const f = path.join(bundle, 'atlas', 'trade', 'claim.php');
      fs.writeFileSync(f, fs.readFileSync(f, 'utf8').split('atlas_store_claim_outcome').join('atlas_old_claim'));
    } });
  }
}

// ---------------------------------------------------------------- negative controls: the previous wallet and issuer
async function controlScenarios(kind) {
  const prev = previousRevision();
  if (!prev) { info('negative controls skipped: no earlier revision found in git history'); return; }
  const issuerOpts = kind === 'php' ? { source: prev.phpSource } : { root: prev.root };
  const walletOpts = { extPath: prev.extDir };
  info('negative controls run revision ' + prev.rev.slice(0, 10) + ' (wallet and issuer)');

  await scenario(kind, 'N1 previous wallet and issuer: a unique mint with a lost answer', async (w, iss) => {
    await w.inject('dropAnswer', '/atlas/asset/issue');
    const out = await mint(w, iss, RING);
    await w.clearFault();
    await w.restart(true);
    const r = await w.recover().catch(() => []);
    check('the issuer consumed serial 1 and the wallet has no ring and nothing to recover (the original failure)', iss.serial(RING) === 1 && (await shown(w, RING)).length === 0 && (await w.pending()).length === 0 && !(out && out.pending), { out, r, serial: iss.serial(RING) });
  }, issuerOpts, walletOpts);

  await scenario(kind, 'N2 previous wallet and issuer: a purchase with a lost answer', async (w, iss) => {
    const r0 = await mint(w, iss, CREDIT, 10); if (r0 !== 'ok') throw new Error('funding failed');
    const rev = iss.revCount();
    await w.inject('dropAnswer', '/atlas/asset/purchase');
    const out = await buy(w, iss, SANDWICH);
    await w.clearFault();
    await w.restart(true);
    const credit = sum(await live(w, CREDIT)), sandwiches = (await live(w, SANDWICH)).length;
    check('the issuer revoked the balance; the wallet has no sandwich and no recovery entry (the original failure)', iss.revCount() === rev + 1 && sandwiches === 0 && (await w.pending()).length === 0 && !(out && out.pending), { out, credit, sandwiches });
  }, issuerOpts, walletOpts);

  await scenario(kind, 'N3 previous wallet and issuer: a trade claim with a lost answer', async (w, iss) => {
    await postListing(iss);
    for (const [cls, q] of [[MEMBER, undefined], [GOLD, 10]]) { const r = await mint(w, iss, cls, q); if (r !== 'ok') throw new Error('setup mint failed'); }
    await w.inject('dropAnswer', '/atlas/trade/claim');
    const out = await walletClaim(w, iss);
    await w.clearFault();
    await w.restart(true);
    const iron = sum(await live(w, IRON));
    check('the station settled it; the wallet has no iron and nothing to recover (the original failure)', (await listingCount(iss)) === 0 && iron === 0 && (await w.pending()).length === 0 && !(out && out.pending), { out, iron });
  }, issuerOpts, walletOpts);

  await scenario(kind, 'N4 previous wallet, current issuer: unique mint, purchase and claim still work with a single request', async (w, iss) => {
    check('ring mint', (await mint(w, iss, RING)) === 'ok' && (await shown(w, RING)).length === 1);
    const r0 = await mint(w, iss, CREDIT, 10); if (r0 !== 'ok') throw new Error('funding failed');
    check('purchase', (await buy(w, iss, SANDWICH)) === 'ok' && (await live(w, SANDWICH)).length === 1 && sum(await live(w, CREDIT)) === 5);
    await postListing(iss);
    for (const [cls, q] of [[MEMBER, undefined], [GOLD, 10]]) { const r = await mint(w, iss, cls, q); if (r !== 'ok') throw new Error('setup mint failed'); }
    check('claim', (await walletClaim(w, iss)) === 'ok' && sum(await live(w, IRON)) === 10);
  }, undefined, walletOpts);

  await scenario(kind, 'N5 current wallet, previous issuer: unique mint, purchase and claim work, single request, nothing journalled', async (w, iss) => {
    check('ring mint', (await mint(w, iss, RING)) === 'ok' && (await shown(w, RING)).length === 1);
    const r0 = await mint(w, iss, CREDIT, 10); if (r0 !== 'ok') throw new Error('funding failed');
    check('purchase', (await buy(w, iss, SANDWICH)) === 'ok' && (await live(w, SANDWICH)).length === 1);
    await postListing(iss);
    for (const [cls, q] of [[MEMBER, undefined], [GOLD, 5]]) { const r = await mint(w, iss, cls, q); if (r !== 'ok') throw new Error('setup mint failed'); }
    check('claim', (await walletClaim(w, iss)) === 'ok' && sum(await live(w, IRON)) === 10);
    check('no entry left behind', (await w.pending()).length === 0);
  }, issuerOpts);
}

async function main() {
  const kinds = which === 'both' ? ['node', 'php'] : [which];
  for (const kind of kinds) {
    await mintScenarios(kind);
    await purchaseScenarios(kind);
    await claimScenarios(kind);
    await compatScenarios(kind);
    await controlScenarios(kind);
  }
  console.log(`\nunique recovery: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
if (require.main === module) main().catch((e) => { console.error(e); process.exit(2); });

// Shared with test/manual-gen1-claim-remainder.js.
module.exports = {
  check, info, scenario, startIssuer, counts: () => ({ passes, failures }), which, ONLY, TTL_ENV, REPO, mint, buy, shown, live, sum, retry, waitFor, sleep,
  exportBackup, importBackup, lockWallet, post, rawIdentity, rawIssue, newRid, postListing, walletClaim, trustPeers, failingSettleOpts, listingCount,
  claimMails, previousRevision, revisionLacking, constants: { IRON, GOLD, MEMBER }
};
