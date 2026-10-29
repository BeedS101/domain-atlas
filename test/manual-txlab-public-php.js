// Public-demo mode security and workflow tests for the Multi-Domain Transaction Authorization Lab
// (issuer-php/atlas/demo/txlab). Every domain is a separate `php -S` server with its own docroot, key,
// admin token, configuration and SQLite files. Visitors act only through the public-* operations
// with a per-session secret; the two domains talk to each other server to server.
//
//   node test/manual-txlab-public-php.js
//
// Needs php with pdo_sqlite, openssl and curl. Exits non-zero on the first failed check.

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const net = require('net');

const REPO = path.resolve(__dirname, '..');
const TXLAB_SRC = path.join(REPO, 'issuer-php', 'atlas', 'demo', 'txlab');
const CRYPTO_SRC = path.join(REPO, 'issuer-php', 'lib', 'crypto.php');
const TOOL = path.join(TXLAB_SRC, 'tools', 'txlab-admin.php');
const subtle = crypto.webcrypto.subtle;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'txlab-public-'));

let checks = 0;
const assert = (cond, msg) => { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); };
const pass = (msg) => { checks++; console.log('PASS: ' + msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function canonicalize(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonicalize(v[k])).join(',') + '}';
}
const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
async function verifySig(pubB64u, signatureB64u, obj) {
  const key = await subtle.importKey('raw', unb64u(pubB64u), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  return subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, unb64u(signatureB64u), Buffer.from(canonicalize(obj)));
}
function signWithPem(pem, obj) {
  const key = crypto.createPrivateKey(pem);
  return b64u(crypto.sign('sha256', Buffer.from(canonicalize(obj)), { key, dsaEncoding: 'ieee-p1363' }));
}
function php(args, opts) { return execFileSync('php', args, { encoding: 'utf8', ...opts }); }

// ---------------------------------------------------------------- identities and instances

const ids = {};
function makeIdentity(name, domain) {
  const dir = path.join(ROOT, 'keys', name);
  const out = php([TOOL, 'keygen', '--dir', dir, '--domain', domain]);
  ids[name] = { domain, dir, pub: /public key:\s+(\S+)/.exec(out)[1], token: /admin token:\s+(\S+)/.exec(out)[1], pem: fs.readFileSync(path.join(dir, 'signing-key.pem'), 'utf8') };
}

const procs = {};
const inst = {};
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.isDirectory()) copyDir(path.join(src, e.name), path.join(dst, e.name));
    else fs.copyFileSync(path.join(src, e.name), path.join(dst, e.name));
  }
}

// opts: identity, settlement, roster [{identity, port}], pub (null = public mode off | string for --public-set), ttl
function makeInstance(label, port, opts) {
  const id = ids[opts.identity];
  const docroot = path.join(ROOT, label, 'public_html');
  copyDir(TXLAB_SRC, path.join(docroot, 'atlas', 'demo', 'txlab'));
  fs.mkdirSync(path.join(docroot, 'lib'), { recursive: true });
  fs.copyFileSync(CRYPTO_SRC, path.join(docroot, 'lib', 'crypto.php'));
  const privDir = path.join(ROOT, label, 'private');
  fs.mkdirSync(privDir, { recursive: true, mode: 0o700 });
  for (const f of ['signing-key.pem', 'public-key.txt', 'admin-token.sha256']) fs.copyFileSync(path.join(id.dir, f), path.join(privDir, f));
  fs.chmodSync(path.join(privDir, 'signing-key.pem'), 0o600);
  const roster = opts.roster.map((r) => ids[r.identity].domain + '=' + ids[r.identity].pub + '@http://127.0.0.1:' + r.port + '/atlas/demo/txlab/api.php').join(',');
  const args = [TOOL, 'config', '--dir', privDir, '--domain', id.domain, '--settlement', opts.settlement, '--threshold', String(opts.roster.length),
    '--mandatory', opts.settlement, '--roster', roster, '--allow-insecure-http', '--enable'];
  if (opts.pub !== null) { args.push('--public-demo'); if (opts.pub) args.push('--public-set', opts.pub); }
  php(args);
  inst[label] = { label, port, base: 'http://127.0.0.1:' + port, privDir, docroot, token: id.token, domain: id.domain, identity: opts.identity };
  return inst[label];
}

async function waitPort(port) {
  for (let i = 0; i < 80; i++) {
    const ok = await new Promise((res) => { const s = net.connect(port, '127.0.0.1', () => { s.destroy(); res(true); }); s.on('error', () => res(false)); });
    if (ok) return;
    await sleep(100);
  }
  throw new Error('server on ' + port + ' did not start');
}
async function start(label) {
  const i = inst[label];
  procs[label] = spawn('php', ['-S', '127.0.0.1:' + i.port, '-t', i.docroot], { env: { ...process.env, TXLAB_PRIVATE_DIR: i.privDir, PHP_CLI_SERVER_WORKERS: '8' }, stdio: ['ignore', 'ignore', 'ignore'] });
  await waitPort(i.port);
}
async function stop(label) {
  const p = procs[label];
  if (!p) return;
  p.kill('SIGKILL');
  await new Promise((r) => p.once('exit', r));
  delete procs[label];
}

const seen = []; // every response body, scanned for leaked secrets at the end
async function raw(label, op, o) {
  o = o || {};
  const url = inst[label].base + '/atlas/demo/txlab/api.php?op=' + op + (o.id ? '&id=' + encodeURIComponent(o.id) : '');
  const headers = Object.assign(o.body !== undefined && !o.noType ? { 'Content-Type': o.type || 'application/json' } : {}, o.headers || {});
  const init = o.body !== undefined || o.method ? { method: o.method || 'POST', headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined } : { headers };
  const r = await fetch(url, init);
  const text = await r.text();
  seen.push(text);
  let body = null;
  try { body = JSON.parse(text); } catch (e) { /* non-JSON */ }
  return { status: r.status, body };
}
const call = raw;
const reqId = () => 'req-' + crypto.randomBytes(8).toString('hex');
const admin = (label, extra) => Object.assign({ adminToken: inst[label].token }, extra || {});

const startSession = async (label, expect) => {
  const r = await call(label, 'public-start', { body: {} });
  if (expect !== false) assert(r.status === 200, 'session start: ' + r.status + ' ' + JSON.stringify(r.body));
  return r.status === 200 ? { sid: r.body.sid, token: r.body.token, raw: r.body } : { status: r.status, body: r.body };
};
const transfer = (label, s, from, to, amountMinor, requestId) => call(label, 'public-transfer', { body: { sid: s.sid, token: s.token, requestId: requestId || reqId(), from, to, amountMinor } });
const approve = (label, s, id, domain) => call(label, 'public-approve', { body: { sid: s.sid, token: s.token, id, domain } });
const sessionState = async (label, s) => (await call(label, 'public-session', { body: { sid: s.sid, token: s.token } }));
const txView = async (label, id) => (await call(label, 'tx', { id })).body;

function sql(label, scope, query) {
  const file = path.join(inst[label].privDir, scope === 'public' ? 'txlab-public.sqlite' : 'txlab.sqlite');
  const code = '$d=new PDO("sqlite:".$argv[1]);$d->exec("PRAGMA busy_timeout=5000");$q=$d->query($argv[2]);echo json_encode($q?$q->fetchAll(PDO::FETCH_ASSOC):[]);';
  return JSON.parse(php(['-r', code, file, query]));
}
function sqlExec(label, query) {
  const file = path.join(inst[label].privDir, 'txlab-public.sqlite');
  php(['-r', '$d=new PDO("sqlite:".$argv[1]);$d->exec("PRAGMA busy_timeout=5000");$d->exec($argv[2]);', file, query]);
}

// the complete visitor flow against an A/B pair
async function fullFlow(a, b, s, from, to, amountMinor) {
  const t = await transfer(a, s, from, to, amountMinor);
  assert(t.status === 200, 'transfer: ' + t.status + ' ' + JSON.stringify(t.body));
  const id = t.body.txId;
  const r1 = await approve(a, s, id, inst[a].domain);
  assert(r1.status === 200, 'approve at A: ' + r1.status + ' ' + JSON.stringify(r1.body));
  const r2 = await approve(a, s, id, inst[b].domain);
  assert(r2.status === 200, 'approve at B: ' + r2.status + ' ' + JSON.stringify(r2.body));
  return { id, view: r2.body.view };
}

// ---------------------------------------------------------------- fake settlement server (for B's own validation)

function startFake(port) {
  const state = { response: null, submitted: [], status: 200 };
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      res.setHeader('Content-Type', 'application/json');
      if (u.searchParams.get('op') === 'tx') { res.statusCode = state.status; res.end(JSON.stringify(state.response)); return; }
      if (u.searchParams.get('op') === 'submit-approval') { state.submitted.push(JSON.parse(data)); res.end(JSON.stringify({ ok: true })); return; }
      res.statusCode = 404; res.end('{}');
    });
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r({ server, state })));
}

const uuid = () => crypto.randomUUID();
function basePayload(extra) {
  const now = Date.now();
  return Object.assign({
    v: 'domain-atlas-txlab/1', type: 'transfer', txId: uuid(), origin: 'a.test', session: '0123456789abcdef', from: 'alice', to: 'bob', currency: 'DEMO',
    amountMinor: 3000, createdAtMs: now, expiresAtMs: now + 300000,
    policy: { mandatory: ['a.test'], roster: ['a.test', 'b.test'], threshold: 2 },
  }, extra || {});
}

// ---------------------------------------------------------------- the run

async function main() {
  console.log('php ' + php(['-r', 'echo PHP_VERSION;']) + ', workspace ' + ROOT);
  assert(/pdo_sqlite/.test(php(['-m'])), 'php needs pdo_sqlite');
  makeIdentity('a', 'a.test');
  makeIdentity('b', 'b.test');
  makeIdentity('x', 'attacker.test');

  const relaxed = 'sessionsPerIpPerHour=500,transfersPerIpPerHour=500,approvalsPerIpPerMinute=500,maxSessions=40,callsPerIpPerMinute=10000,transfersGlobalPerHour=5000,peerApprovalsPerHour=5000';
  const pair = (an, bn, pa, pb, aPub, bPub) => {
    const roster = [{ identity: 'a', port: pa }, { identity: 'b', port: pb }];
    makeInstance(an, pa, { identity: 'a', settlement: 'a.test', roster, pub: aPub });
    makeInstance(bn, pb, { identity: 'b', settlement: 'a.test', roster, pub: bPub });
  };
  pair('A', 'B', 9411, 9412, relaxed, relaxed);                                      // main pair
  pair('SA', 'SB', 9413, 9414, relaxed, relaxed + ',maxAmountMinor=2000');            // B has a stricter amount limit
  pair('LA', 'LB', 9415, 9416, 'sessionsPerIpPerHour=3,transfersPerIpPerHour=2,approvalsPerIpPerMinute=2', relaxed); // per-IP limits
  pair('CA', 'CB', 9417, 9418, relaxed + ',maxSessions=2,txTtlSeconds=5', relaxed + ',txTtlSeconds=5'); // capacity + short tx lifetime
  pair('OA', 'OB', 9419, 9420, null, null);                                          // public mode off
  pair('HA', 'HB', 9421, 9422, relaxed, null);                                       // settlement on, approver off
  pair('PA', 'PB', 9423, 9424, relaxed, relaxed + ',maxTransfersPerSession=5');      // spare
  // B' whose settlement authority is a scripted fake, to prove B validates by itself
  const fakePort = 9431;
  makeInstance('FB', 9432, { identity: 'b', settlement: 'a.test', roster: [{ identity: 'a', port: fakePort }, { identity: 'b', port: 9432 }], pub: relaxed });
  const fake = await startFake(fakePort);
  for (const l of Object.keys(inst)) await start(l);

  // ---- health, secrets stay private
  const hA = (await call('A', 'health', { method: 'GET' })).body;
  const hB = (await call('B', 'health', { method: 'GET' })).body;
  assert(hA.enabled && hA.publicDemo.enabled && hA.publicDemo.limits.maxAmountMinor === 5000 && hA.role === 'settlement-authority', 'A health reports public mode and limits');
  assert(hB.enabled && hB.publicDemo.enabled && hB.role === 'approver', 'B health reports public mode');
  pass('health shows public mode and only non-secret limits on both domains');

  // ---- the headline flow
  const s1 = await startSession('A');
  assert(/^[0-9a-f]{16}$/.test(s1.sid) && /^[A-Za-z0-9_-]{43}$/.test(s1.token), 'session id and token have the expected shape');
  assert(s1.raw.balances.alice === 10000 && s1.raw.balances.bob === 0 && s1.raw.testDemo === true, 'the new session starts with Alice 100.00 and Bob 0.00 test DEMO');
  const stored = sql('A', 'public', 'SELECT token_hash FROM sessions')[0].token_hash;
  assert(stored === sha256hex(s1.token) && stored !== s1.token, 'only the hash of the session token is stored');
  pass('visitor starts a session without any administrator token (balances 100.00 / 0.00, token stored hashed)');

  const t1 = await transfer('A', s1, 'alice', 'bob', 3000);
  assert(t1.status === 200 && t1.body.status === 'pending' && t1.body.quorum.approved === 0 && t1.body.payload.session === s1.sid && t1.body.ledger === 'public-demo', 'transfer is pending 0/2 and tagged with the session');
  assert(t1.body.balances.alice === 10000 && t1.body.balances.bob === 0, 'no balance moved yet');
  const id1 = t1.body.txId;
  pass('visitor creates a 30.00 test transfer: pending 0/2, session-tagged canonical payload');

  const a1 = await approve('A', s1, id1, 'a.test');
  assert(a1.status === 200 && a1.body.view.status === 'pending' && a1.body.view.quorum.approved === 1, 'A signs automatically: 1/2, still pending');
  assert(a1.body.view.balances.alice === 10000, 'one approval moved nothing');
  const apA = a1.body.view.approvals.find((x) => x.approver === 'a.test');
  assert(apA && apA.verified && await verifySig(ids.a.pub, apA.signature, apA.approval), 'A\'s approval verifies against A\'s public key (checked here with Web Crypto)');
  pass('Domain A validates and signs with its own key: 1/2, nothing executed, signature verifies independently');

  const b1 = await approve('A', s1, id1, 'b.test');
  assert(b1.status === 200 && b1.body.view.status === 'executed' && b1.body.view.quorum.approved === 2, 'B signs independently: 2/2 executed');
  const v1 = b1.body.view;
  assert(v1.balances.alice === 7000 && v1.balances.bob === 3000, 'Alice 70.00, Bob 30.00');
  const apB = v1.approvals.find((x) => x.approver === 'b.test');
  assert(apB && apB.verified && await verifySig(ids.b.pub, apB.signature, apB.approval), 'B\'s approval verifies against B\'s public key');
  assert(apB.approval.payloadDigest === v1.digest && apA.approval.payloadDigest === v1.digest, 'both domains signed the same payload digest');
  assert(sha256hex(canonicalize(v1.payload)) === v1.digest, 'the digest recomputes from the canonical payload');
  assert(v1.receipt && v1.receipt.verified && await verifySig(ids.a.pub, v1.receipt.signature, v1.receipt.receipt), 'the settlement receipt verifies against A\'s public key');
  assert(v1.receipt.receipt.approvals.length === 2 && v1.receipt.receipt.balancesAfter.alice === 7000, 'the receipt lists both approvals and the new balances');
  const kinds = v1.events.map((e) => e.kind);
  assert(kinds.includes('peer-approval-requested') && kinds.filter((k) => k === 'approval-accepted').length === 2 && kinds.includes('executed'), 'event log shows the request to B, both approvals and the execution: ' + kinds.join(','));
  const bLog = sql('B', 'public', 'SELECT kind, domain FROM events');
  assert(bLog.some((e) => e.kind === 'peer-approval-signed' && e.domain === 'b.test'), 'B recorded its own signing in its own database');
  pass('Domain B independently fetches, validates and signs: executed once, Alice 70.00 / Bob 30.00, approvals and receipt verify');

  const viaB = (await call('B', 'tx', { method: 'GET', id: id1 })).body;
  assert(viaB.status === 'executed' && viaB.verifiedLocally.digestMatches && viaB.verifiedLocally.approvals.length === 2 && viaB.verifiedLocally.approvals.every((x) => x.verified) && viaB.verifiedLocally.receiptVerified === true, 'B\'s own view re-verifies both approvals and the receipt with its pinned keys');
  pass('Domain B\'s view of the settled transfer re-verifies everything with its own pinned keys');

  const again = await approve('A', s1, id1, 'b.test');
  assert(again.status === 409, 'approving a finished transfer is refused: ' + again.status);
  assert(sql('A', 'public', 'SELECT COUNT(*) AS n FROM ledger')[0].n === 1, 'exactly one ledger entry');
  const mainState = (await call('A', 'state', { method: 'GET' })).body;
  assert(mainState.balances.alice === 10000 && mainState.balances.bob === 0, 'the main ledger is untouched by public-demo activity');
  pass('re-approving a finished transfer is refused; one ledger entry; the main ledger is untouched');

  // ---- session isolation
  const s2 = await startSession('A');
  const st2 = await sessionState('A', s2);
  assert(st2.body.balances.alice === 10000 && st2.body.balances.bob === 0 && st2.body.transactions.length === 0, 'a second visitor has an independent fresh balance and sees none of the first one\'s transfers');
  assert((await approve('A', s2, id1, 'a.test')).status === 404, 'session 2 cannot drive session 1\'s transfer');
  const t2 = await transfer('A', s2, 'alice', 'bob', 1000);
  assert(t2.status === 200, 'session 2 can create its own transfer');
  assert((await approve('A', s1, t2.body.txId, 'a.test')).status === 404, 'session 1 cannot drive session 2\'s transfer');
  for (const [name, body] of [
    ['no token', { sid: s1.sid }], ['sid used as token', { sid: s1.sid, token: s1.sid }], ['other session\'s token', { sid: s1.sid, token: s2.token }],
    ['wrong token', { sid: s1.sid, token: 'A'.repeat(43) }], ['no credentials', {}], ['malformed sid', { sid: "x' OR 1=1 --", token: s1.token }],
  ]) {
    const r = await call('A', 'public-session', { body });
    assert(r.status === 401 && !JSON.stringify(r.body).includes(s1.token), name + ' is refused (401)');
    const r2 = await call('A', 'public-transfer', { body: { ...body, requestId: reqId(), from: 'alice', to: 'bob', amountMinor: 100 } });
    assert(r2.status === 401, name + ' cannot create a transfer');
    const r3 = await call('A', 'public-approve', { body: { ...body, id: id1, domain: 'a.test' } });
    assert(r3.status === 401, name + ' cannot approve');
  }
  assert((await sessionState('A', s1)).body.balances.alice === 7000, 'session 1 balances are unaffected by session 2 activity');
  pass('visitor isolation: other sessions, wrong tokens, the public session id as a token and malformed ids are all refused');

  // visitors never spend each other's balance and cannot overspend their own
  const fA = await fullFlow('A', 'B', s2, 'alice', 'bob', 4000); // session 2: 100.00 -> 60.00 / 40.00
  assert(fA.view.balances.alice === 6000, 'session 2 spent only its own balance');
  assert((await transfer('A', s2, 'alice', 'bob', 5000)).status === 200, 'a transfer within the balance is accepted');
  const bobTooMuch = await transfer('A', s1, 'bob', 'alice', 4000);
  assert(bobTooMuch.status === 409 && /insufficient/.test(bobTooMuch.body.error), 'Bob cannot send more than he holds in this session (30.00 held, 40.00 asked)');
  const f2 = await fullFlow('A', 'B', s1, 'alice', 'bob', 5000);
  assert(f2.view.balances.alice === 2000 && f2.view.balances.bob === 8000, 'session 1 second transfer settles: 20.00 / 80.00');
  const over = await transfer('A', s1, 'alice', 'bob', 2100);
  assert(over.status === 409, 'overspending Alice\'s remaining 20.00 is refused: ' + over.status);
  pass('balances are per session: no overspending, nobody spends another visitor\'s balance');

  // ---- input validation
  for (const [what, amt] of [['zero', 0], ['negative', -5], ['string', '30'], ['float', 30.5], ['over the limit (50.00)', 5001], ['null', null]]) {
    const r = await call('A', 'public-transfer', { body: { sid: s2.sid, token: s2.token, requestId: reqId(), from: 'alice', to: 'bob', amountMinor: amt } });
    assert(r.status === 400, 'amount ' + what + ' is refused: ' + r.status);
  }
  for (const [from, to] of [['alice', 'carol'], ['reserve', 'bob'], ['alice', 'alice'], ['', 'bob'], [7, 'bob']]) {
    const r = await call('A', 'public-transfer', { body: { sid: s2.sid, token: s2.token, requestId: reqId(), from, to, amountMinor: 100 } });
    assert(r.status === 400, 'accounts ' + from + '->' + to + ' are refused');
  }
  assert((await call('A', 'public-transfer', { body: { sid: s2.sid, token: s2.token, requestId: 'x', from: 'alice', to: 'bob', amountMinor: 100 } })).status === 400, 'a malformed requestId is refused');
  pass('amount, account and request-id validation is enforced server-side');

  // ---- idempotency and namespacing
  const s3 = await startSession('A');
  const rid = reqId();
  const d1 = await transfer('A', s3, 'alice', 'bob', 500, rid);
  const d2 = await transfer('A', s3, 'alice', 'bob', 500, rid);
  assert(d1.body.txId === d2.body.txId, 'the same requestId returns the same transfer');
  const s3b = await startSession('A');
  const other = await transfer('A', s3b, 'alice', 'bob', 500, rid);
  assert(other.status === 200 && other.body.txId !== d1.body.txId, 'another session using the same requestId gets its own transfer');
  pass('creating a transfer is idempotent per session; request ids cannot collide across sessions');

  // ---- per-session caps
  const s4 = await startSession('A');
  assert((await transfer('A', s4, 'alice', 'bob', 100)).status === 200 && (await transfer('A', s4, 'alice', 'bob', 100)).status === 200, 'two pending transfers are allowed');
  const third = await transfer('A', s4, 'alice', 'bob', 100);
  assert(third.status === 429, 'a third pending transfer is refused (max 2): ' + third.status);
  const s5 = await startSession('A');
  for (let i = 0; i < 5; i++) await fullFlow('A', 'B', s5, 'alice', 'bob', 100);
  const sixth = await transfer('A', s5, 'alice', 'bob', 100);
  assert(sixth.status === 429 && /5 test transfers/.test(sixth.body.error), 'the session transfer cap (5) is enforced: ' + sixth.status);
  assert((await sessionState('A', s5)).body.balances.bob === 500, 'five 1.00 transfers settled');
  pass('per-session caps: at most 2 pending and 5 transfers per session');

  // ---- parallel approvals execute once
  const s6 = await startSession('A');
  const tp = await transfer('A', s6, 'alice', 'bob', 2500);
  const burst = await Promise.all([
    approve('A', s6, tp.body.txId, 'a.test'), approve('A', s6, tp.body.txId, 'b.test'), approve('A', s6, tp.body.txId, 'a.test'),
    approve('A', s6, tp.body.txId, 'b.test'), approve('A', s6, tp.body.txId, 'a.test'), approve('A', s6, tp.body.txId, 'b.test'),
  ]);
  const fin = await txView('A', tp.body.txId);
  assert(fin.status === 'executed' && fin.balances.alice === 7500 && fin.balances.bob === 2500, 'six parallel approval requests execute the transfer exactly once');
  assert(sql('A', 'public', "SELECT COUNT(*) AS n FROM ledger WHERE tx_id = '" + tp.body.txId + "'")[0].n === 1, 'one ledger entry');
  assert(burst.every((r) => [200, 409].includes(r.status)), 'racing duplicates answer 200 or 409, never 5xx: ' + burst.map((r) => r.status));
  pass('parallel approval requests execute the transfer exactly once');

  // ---- the settlement domain signs only what it stored; B only on an A-signed request after its own validation
  const rq = (over) => Object.assign({ v: 'domain-atlas-txlab-peer-request/1', op: 'approve', txId: fin.txId, requester: 'a.test', target: 'b.test', requestedAtMs: Date.now() }, over);
  const goodSig = (r) => signWithPem(ids.a.pem, r);
  const tNew = await transfer('A', await startSession('A'), 'alice', 'bob', 1000);
  const pa = (body) => call('B', 'peer-approve', { body });
  assert((await pa({})).status === 400, 'peer-approve with nothing is refused');
  assert((await pa({ request: rq({ txId: tNew.body.txId }), signature: signWithPem(ids.x.pem, rq({ txId: tNew.body.txId })) })).status === 401, 'a request signed by an unknown key is refused');
  const bOwn = rq({ txId: tNew.body.txId });
  assert((await pa({ request: bOwn, signature: signWithPem(ids.b.pem, bOwn) })).status === 401, 'a request signed by B\'s own key (not the settlement authority) is refused');
  const tampered = rq({ txId: tNew.body.txId });
  const tSig = goodSig(tampered);
  assert((await pa({ request: { ...tampered, txId: uuid() }, signature: tSig })).status === 401, 'altering a signed request invalidates it');
  const stale = rq({ txId: tNew.body.txId, requestedAtMs: Date.now() - 600000 });
  assert((await pa({ request: stale, signature: goodSig(stale) })).status === 400, 'a stale request is refused');
  const wrongTarget = rq({ txId: tNew.body.txId, target: 'a.test' });
  assert((await pa({ request: wrongTarget, signature: goodSig(wrongTarget) })).status === 403, 'a request addressed to another domain is refused');
  const notA = rq({ txId: tNew.body.txId, requester: 'b.test' });
  assert((await pa({ request: notA, signature: signWithPem(ids.b.pem, notA) })).status === 403, 'only the settlement authority can request approvals');
  const unknownTx = rq({ txId: uuid() });
  assert((await pa({ request: unknownTx, signature: goodSig(unknownTx) })).status === 404, 'an unknown transfer is not signed');
  const extra = { ...rq({ txId: tNew.body.txId }), amountMinor: 1 };
  assert((await pa({ request: extra, signature: goodSig(extra) })).status === 400, 'a request carrying extra fields is refused');
  assert((await call('A', 'peer-approve', { body: { request: bOwn, signature: 'x' } })).status === 400, 'the settlement authority refuses peer-approve');
  // an admin (main-ledger) transfer is never auto-signed, even on a validly signed request
  const adm = await call('A', 'create', { body: admin('A', { requestId: reqId(), from: 'alice', to: 'bob', amountMinor: 3000 }) });
  assert(adm.status === 200 && !adm.body.payload.session, 'an administrator transfer is created on the main ledger');
  const admReq = rq({ txId: adm.body.txId });
  const admRes = await pa({ request: admReq, signature: goodSig(admReq) });
  assert(admRes.status === 400 && /public-demo/.test(admRes.body.error), 'B refuses to auto-sign a main-ledger transfer: ' + JSON.stringify(admRes.body));
  const sAny = await startSession('A');
  assert((await approve('A', sAny, adm.body.txId, 'a.test')).status === 404, 'a visitor cannot trigger approval of a main-ledger transfer at A');
  assert((await approve('A', sAny, adm.body.txId, 'b.test')).status === 404, 'nor at B');
  // replay of a good request after the transfer is final
  const replay = rq({ txId: id1 });
  const rr = await pa({ request: replay, signature: goodSig(replay) });
  assert(rr.status === 409, 'a replayed request for a finished transfer signs nothing: ' + rr.status);
  assert(sql('A', 'public', 'SELECT COUNT(*) AS n FROM approvals WHERE tx_id = \'' + id1 + '\'')[0].n === 2, 'still exactly two approvals');
  pass('B signs only on a fresh request signed by the settlement authority; forged, stale, altered, misaddressed, replayed and main-ledger requests are refused');

  // ---- B validates the transfer itself (scripted settlement authority)
  const fb = (body) => call('FB', 'peer-approve', { body });
  async function fakeCase(name, payloadExtra, o) {
    o = o || {};
    const p = basePayload(payloadExtra);
    const digest = sha256hex(canonicalize(o.digestAmount ? Object.assign({}, p, { amountMinor: o.digestAmount }) : p));
    fake.state.response = { payload: o.omit ? undefined : p, digest, status: o.status || 'pending', domains: o.domains };
    fake.state.submitted.length = 0;
    const req = { v: 'domain-atlas-txlab-peer-request/1', op: 'approve', txId: o.reqTx || p.txId, requester: 'a.test', target: 'b.test', requestedAtMs: Date.now() };
    const r = await fb({ request: req, signature: signWithPem(ids.a.pem, req) });
    return { r, sent: fake.state.submitted.slice(), p, digest };
  }
  const ok = await fakeCase('valid', {});
  assert(ok.r.status === 200 && ok.sent.length === 1, 'baseline: a valid transfer is signed: ' + JSON.stringify(ok.r.body));
  const sentApproval = ok.sent[0].approval;
  assert(sentApproval.approver === 'b.test' && sentApproval.payloadDigest === ok.digest && await verifySig(ids.b.pub, ok.sent[0].signature, sentApproval), 'B signed exactly the digest it validated, with its own key');
  const cases = [
    ['an amount changed after the digest was computed', { amountMinor: 3001 }, { digestAmount: 3000 }, 400],
    ['an amount over B\'s limit', { amountMinor: 5001 }, {}, 400],
    ['an unknown account', { to: 'carol' }, {}, 400],
    ['sender equal to recipient', { to: 'alice' }, {}, 400],
    ['a different settlement authority', { origin: 'evil.test' }, {}, 400],
    ['a weaker quorum policy', { policy: { mandatory: ['a.test'], roster: ['a.test', 'b.test'], threshold: 1 } }, {}, 400],
    ['a policy without the settlement domain as mandatory', { policy: { mandatory: [], roster: ['a.test', 'b.test'], threshold: 2 } }, {}, 400],
    ['an authorization window longer than B allows', { expiresAtMs: Date.now() + 900000 }, {}, 400],
    ['an already expired transfer', { createdAtMs: Date.now() - 400000, expiresAtMs: Date.now() - 100000 }, {}, 409],
    ['a transfer that is not pending', {}, { status: 'executed' }, 409],
    ['a transfer for a different id than requested', {}, { reqTx: uuid() }, 400],
  ];
  for (const [name, extra2, o, code] of cases) {
    const c = await fakeCase(name, extra2, o);
    assert(c.r.status === code && c.sent.length === 0, name + ' is refused (' + code + ') and nothing is signed: got ' + c.r.status + ' ' + JSON.stringify(c.r.body));
  }
  // a payload without a session key (not a public-demo transfer)
  const pNo = basePayload({}); delete pNo.session;
  fake.state.response = { payload: pNo, digest: sha256hex(canonicalize(pNo)), status: 'pending' };
  fake.state.submitted.length = 0;
  const reqNo = { v: 'domain-atlas-txlab-peer-request/1', op: 'approve', txId: pNo.txId, requester: 'a.test', target: 'b.test', requestedAtMs: Date.now() };
  const noSess = await fb({ request: reqNo, signature: signWithPem(ids.a.pem, reqNo) });
  assert(noSess.status === 400 && fake.state.submitted.length === 0, 'a transfer without a session tag is refused and not signed');
  // an unreachable / erroring settlement authority
  fake.state.status = 500; fake.state.response = { error: 'boom' };
  const reqU = { v: 'domain-atlas-txlab-peer-request/1', op: 'approve', txId: uuid(), requester: 'a.test', target: 'b.test', requestedAtMs: Date.now() };
  assert((await fb({ request: reqU, signature: signWithPem(ids.a.pem, reqU) })).status === 502, 'an erroring settlement authority makes B refuse (502), not sign');
  fake.state.status = 200;
  pass('B validates by itself: digest mismatch, its own amount/account/policy/expiry limits, status and id checks all stop it signing');

  // ---- stricter limit on B
  const sS = await startSession('SA');
  const tS = await transfer('SA', sS, 'alice', 'bob', 3000);
  assert((await approve('SA', sS, tS.body.txId, 'a.test')).status === 200, 'A (limit 50.00) signs a 30.00 transfer');
  const bS = await approve('SA', sS, tS.body.txId, 'b.test');
  assert(bS.status === 400 && /limit/.test(bS.body.error), 'B (limit 20.00) refuses it: ' + JSON.stringify(bS.body));
  const vS = await txView('SA', tS.body.txId);
  assert(vS.status === 'pending' && vS.quorum.approved === 1 && vS.balances.alice === 10000 && vS.events.some((e) => e.kind === 'peer-approval-failed'), 'the transfer stays pending 1/2, nothing moved, the refusal is logged');
  const fine = await fullFlow('SA', 'SB', sS, 'alice', 'bob', 2000);
  assert(fine.view.status === 'executed', 'a transfer within both limits still settles');
  pass('each domain enforces its own limit: B refuses an amount over its limit and the transfer cannot execute');

  // ---- approver offline / approver with public mode off
  const sH = await startSession('HA');
  const tH = await transfer('HA', sH, 'alice', 'bob', 1000);
  assert((await approve('HA', sH, tH.body.txId, 'a.test')).status === 200, 'A signs');
  const offB = await approve('HA', sH, tH.body.txId, 'b.test');
  assert(offB.status === 502 && (await txView('HA', tH.body.txId)).status === 'pending', 'an approver with public mode off does not sign (502); stays pending');
  const sP = await startSession('PA');
  const tP = await transfer('PA', sP, 'alice', 'bob', 1000);
  await approve('PA', sP, tP.body.txId, 'a.test');
  await stop('PB');
  const down = await approve('PA', sP, tP.body.txId, 'b.test');
  assert(down.status === 502 && down.body.state === 'peer-unavailable', 'B unreachable: explicit 502 peer-unavailable');
  const vd = await txView('PA', tP.body.txId);
  assert(vd.status === 'pending' && vd.quorum.approved === 1 && vd.events.some((e) => e.kind === 'peer-approval-failed'), 'the transfer stays pending 1/2 and the failure is logged');
  await start('PB');
  const up = await approve('PA', sP, tP.body.txId, 'b.test');
  assert(up.status === 200 && up.body.view.status === 'executed', 'once B is back the same transfer completes');
  pass('B unreachable or not enabled: explicit error, transfer stays pending, completes when B returns');

  // ---- restart persistence
  await stop('A');
  await start('A');
  const afterRestart = await sessionState('A', s1);
  assert(afterRestart.status === 200 && afterRestart.body.balances.alice === 2000 && afterRestart.body.balances.bob === 8000, 'session and balances survive a restart');
  assert((await txView('A', id1)).status === 'executed', 'the executed transfer is still there');
  pass('sessions, balances and receipts persist across a server restart');

  // ---- closed privileged surface
  const flat = (r) => r.status;
  for (const op of ['reset', 'sign', 'mint', 'config', 'keys', 'admin-reset', 'public-reset', 'public-mint', 'public-sign', 'issue', 'delete', '..%2Fconfig']) {
    for (const label of ['A', 'B']) {
      const r = await call(label, op, { method: 'POST', body: admin(label, { sid: s1.sid, token: s1.token, data: 'x' }) });
      assert(flat(r) === 404, label + ' op ' + op + ' does not exist: ' + r.status);
    }
  }
  assert((await call('A', 'create', { body: { requestId: reqId(), from: 'alice', to: 'bob', amountMinor: 100 } })).status === 401, 'administrator create still needs the token');
  assert((await call('A', 'create', { body: { adminToken: 'wrong', requestId: reqId(), from: 'alice', to: 'bob', amountMinor: 100 } })).status === 401, 'administrator create refuses a wrong token');
  assert((await call('A', 'create', { body: { sid: s1.sid, token: s1.token, requestId: reqId(), from: 'alice', to: 'bob', amountMinor: 100 } })).status === 401, 'a session token is not an administrator token');
  assert((await call('B', 'decide', { body: { id: id1, decision: 'approve' } })).status === 401, 'administrator decide still needs the token');
  assert((await call('B', 'decide', { body: { sid: s1.sid, token: s1.token, id: id1, decision: 'approve' } })).status === 401, 'a session token cannot use decide');
  const decPub = await call('B', 'decide', { body: admin('B', { id: tNew.body.txId, decision: 'approve' }) });
  assert(decPub.status === 400 && /public flow/.test(decPub.body.error), 'even the administrator cannot sign a session transfer through decide: ' + JSON.stringify(decPub.body));
  assert((await call('A', 'public-start', { method: 'GET' })).status === 405, 'public-start is POST only');
  assert((await call('A', 'public-start', { body: {}, type: 'text/plain' })).status === 415, 'public operations need an application/json body');
  assert((await call('A', 'public-start', { body: [1] })).status === 400, 'a JSON array body is refused');
  const bigBody = await call('A', 'public-transfer', { body: { sid: s1.sid, token: s1.token, pad: 'x'.repeat(20000) } });
  assert(bigBody.status === 413, 'oversized bodies are refused');
  assert((await call('B', 'public-start', { body: {} })).status === 400 && (await call('B', 'public-transfer', { body: { sid: s1.sid, token: s1.token } })).status === 400, 'an approving domain cannot start sessions or transfers');
  pass('no public endpoint can reset, mint, sign, configure or reach keys; administrator operations still need their token');

  // ---- per-IP limits (forwarding headers are ignored)
  const spoof = { 'X-Forwarded-For': '203.0.113.7', 'X-Real-IP': '203.0.113.8' };
  const l1 = await startSession('LA'), l2 = await startSession('LA'), l3 = await startSession('LA');
  const l4 = await call('LA', 'public-start', { body: {}, headers: { 'X-Forwarded-For': '198.51.100.9' } });
  assert(l4.status === 429 && l4.body.retryAfterSeconds > 0, 'the 4th session start from one address in an hour is refused (429): ' + l4.status);
  assert((await call('LA', 'public-start', { body: {}, headers: spoof })).status === 429, 'a spoofed X-Forwarded-For does not reset the limit');
  assert((await transfer('LA', l1, 'alice', 'bob', 100)).status === 200 && (await transfer('LA', l2, 'alice', 'bob', 100)).status === 200, 'two transfers within the per-address limit');
  const lt = await transfer('LA', l3, 'alice', 'bob', 100);
  assert(lt.status === 429, 'a 3rd transfer from one address is refused even from another session: ' + lt.status);
  const tl = (await sessionState('LA', l1)).body.transactions[0].txId;
  assert((await approve('LA', l1, tl, 'a.test')).status === 200 && (await approve('LA', l1, tl, 'b.test')).status === 200, 'two approval calls within the per-minute limit');
  assert((await approve('LA', l1, tl, 'b.test')).status === 429, 'the per-minute approval limit is enforced');
  pass('per-address limits (sessions/hour, transfers/hour, approvals/minute) are enforced; forwarding headers cannot bypass them');

  // ---- capacity and expiry
  const c1 = await startSession('CA'), c2 = await startSession('CA');
  const c3 = await call('CA', 'public-start', { body: {} });
  assert(c3.status === 503, 'the global session cap (2) is enforced: ' + c3.status);
  const tc = await transfer('CA', c1, 'alice', 'bob', 100);
  await sleep(6500);
  const late = await approve('CA', c1, tc.body.txId, 'a.test');
  assert(late.status === 409, 'a transfer past its 5 second window can no longer be approved: ' + late.status);
  assert((await txView('CA', tc.body.txId)).status === 'expired', 'it is marked expired');
  // session expiry + pruning (the clock is moved by editing the stored expiry; the server enforces it)
  sqlExec('CA', 'UPDATE sessions SET expires_ms = ' + (Date.now() - 1000) + " WHERE sid = '" + c1.sid + "'");
  assert((await sessionState('CA', c1)).status === 401, 'an expired session is refused');
  assert((await transfer('CA', c1, 'alice', 'bob', 100)).status === 401, 'an expired session cannot transfer');
  sqlExec('CA', 'UPDATE sessions SET expires_ms = ' + (Date.now() - 120000) + " WHERE sid = '" + c1.sid + "'");
  const c4 = await startSession('CA'); // starting a session prunes the long-expired one and frees its slot
  assert(c4.sid, 'a slot is free again after pruning');
  assert(sql('CA', 'public', "SELECT COUNT(*) AS n FROM sessions WHERE sid = '" + c1.sid + "'")[0].n === 0 && sql('CA', 'public', 'SELECT COUNT(*) AS n FROM tx')[0].n === 0 && sql('CA', 'public', 'SELECT COUNT(*) AS n FROM session_accounts')[0].n === 4, 'the expired session, its transfers and balances were removed');
  assert((await call('CA', 'tx', { method: 'GET', id: tc.body.txId })).status === 404, 'pruned transfers are gone');
  pass('global session cap, transfer expiry, session expiry and pruning all work');

  // ---- public mode off / misconfigured
  for (const op of ['public-start', 'public-session', 'public-transfer', 'public-approve']) {
    const r = await call('OA', op, { body: { sid: s1.sid, token: s1.token, requestId: reqId(), from: 'alice', to: 'bob', amountMinor: 100, id: id1, domain: 'a.test' } });
    assert(r.status === 403, op + ' is closed when public mode is off: ' + r.status);
  }
  assert((await call('OB', 'peer-approve', { body: {} })).status === 403, 'peer-approve is closed when public mode is off');
  assert(!fs.existsSync(path.join(inst.OA.privDir, 'txlab-public.sqlite')), 'no public database is even created while the mode is off');
  assert((await call('OA', 'health', { method: 'GET' })).body.publicDemo.enabled === false, 'health says public mode is off');
  const adminOff = await call('OA', 'create', { body: admin('OA', { requestId: reqId(), from: 'alice', to: 'bob', amountMinor: 100 }) });
  assert(adminOff.status === 200, 'the administrator flow still works with public mode off');
  makeInstance('BAD', 9425, { identity: 'a', settlement: 'a.test', roster: [{ identity: 'a', port: 9425 }, { identity: 'b', port: 9426 }], pub: 'maxAmountMinor=999999999' });
  await start('BAD');
  const hb = (await call('BAD', 'health', { method: 'GET' })).body;
  assert(hb.enabled === false && hb.reasons.some((x) => /publicDemo\.maxAmountMinor/.test(x)), 'an invalid public setting disables the whole lab (fail closed)');
  assert((await call('BAD', 'public-start', { body: {} })).status === 503, 'and no operation works');
  pass('public mode is off by default, closed when off, and a bad setting fails closed');

  // ---- no secrets in any response
  const blob = seen.join('\n');
  const secrets = [ids.a.token, ids.b.token, sha256hex(ids.a.token), sha256hex(ids.b.token), 'PRIVATE KEY', 'adminTokenHash', inst.A.privDir, ROOT, fs.readFileSync(path.join(ids.a.dir, 'signing-key.pem'), 'utf8').split('\n')[1]];
  for (const sec of secrets) assert(!blob.includes(sec), 'a response leaked a secret: ' + sec.slice(0, 12));
  for (const tokenHash of sql('A', 'public', 'SELECT token_hash FROM sessions').map((r) => r.token_hash)) assert(!blob.includes(tokenHash), 'a session token hash was exposed');
  const dbBytes = fs.readFileSync(path.join(inst.A.privDir, 'txlab-public.sqlite')).toString('latin1') + (fs.existsSync(path.join(inst.A.privDir, 'txlab-public.sqlite-wal')) ? fs.readFileSync(path.join(inst.A.privDir, 'txlab-public.sqlite-wal')).toString('latin1') : '');
  assert(!dbBytes.includes(s1.token) && !dbBytes.includes(s2.token), 'raw session tokens are never written to disk');
  pass('no response contains a private key, an administrator token or hash, a path, or a session token hash; raw tokens never reach the disk');

  console.log('\nALL ' + checks + ' PUBLIC-DEMO CHECKS PASSED');
}

main().then(() => end(0), (e) => { console.error('\nFAILURE: ' + (e && e.stack || e)); end(1); });
function end(code) {
  Object.values(procs).forEach((p) => { try { p.kill('SIGKILL'); } catch (e) { /* gone */ } });
  if (!process.env.TXLAB_KEEP) fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(code);
}
