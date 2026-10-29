// Two-domain (and three-domain) HTTP test for the Multi-Domain Transaction Authorization Lab
// (issuer-php/atlas/demo/txlab). Every domain is a separate `php -S` server with its own docroot, its own
// signing key, admin token, configuration and SQLite state; the docroot holds only the lab files
// plus lib/crypto.php, so the test also proves the lab depends on nothing else. All requests are
// real HTTP, all signatures are verified here with Web Crypto against the public keys.
//
//   node test/manual-txlab-php.js
//
// Needs php with pdo_sqlite, openssl and curl. Exits non-zero on the first failed check.

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const net = require('net');

const REPO = path.resolve(__dirname, '..');
const TXLAB_SRC = path.join(REPO, 'issuer-php', 'atlas', 'demo', 'txlab');
const CRYPTO_SRC = path.join(REPO, 'issuer-php', 'lib', 'crypto.php');
const TOOL = path.join(TXLAB_SRC, 'tools', 'txlab-admin.php');
const subtle = crypto.webcrypto.subtle;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'txlab-test-'));

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
// signs with a PEM private key (PHP's EC key file), producing the raw r||s form the lab uses
function signWithPem(pem, obj) {
  const key = crypto.createPrivateKey(pem);
  return b64u(crypto.sign('sha256', Buffer.from(canonicalize(obj)), { key, dsaEncoding: 'ieee-p1363' }));
}

function php(args, opts) { return execFileSync('php', args, { encoding: 'utf8', ...opts }); }

// ---------------------------------------------------------------- identities and instances

const ids = {}; // name -> { dir, pub, token, pem }
function makeIdentity(name, domain) {
  const dir = path.join(ROOT, 'keys', name);
  const out = php([TOOL, 'keygen', '--dir', dir, '--domain', domain]);
  ids[name] = { domain, dir, pub: /public key:\s+(\S+)/.exec(out)[1], token: /admin token:\s+(\S+)/.exec(out)[1], pem: fs.readFileSync(path.join(dir, 'signing-key.pem'), 'utf8') };
}

const procs = {};
const inst = {}; // label -> { base, port, privDir, docroot, token, domain }

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.isDirectory()) copyDir(path.join(src, e.name), path.join(dst, e.name));
    else fs.copyFileSync(path.join(src, e.name), path.join(dst, e.name));
  }
}

// opts: identity, settlement (domain name), roster [{identity, port}], threshold, mandatory [domain], ttl, enabled
function makeInstance(label, port, opts) {
  const id = ids[opts.identity];
  const docroot = path.join(ROOT, label, 'public_html');
  copyDir(TXLAB_SRC, path.join(docroot, 'atlas', 'demo', 'txlab'));
  fs.mkdirSync(path.join(docroot, 'lib'), { recursive: true });
  fs.copyFileSync(CRYPTO_SRC, path.join(docroot, 'lib', 'crypto.php'));
  const privDir = opts.privDir || path.join(ROOT, label, 'private');
  fs.mkdirSync(privDir, { recursive: true, mode: 0o700 });
  for (const f of ['signing-key.pem', 'public-key.txt', 'admin-token.sha256']) fs.copyFileSync(path.join(id.dir, f), path.join(privDir, f));
  fs.chmodSync(path.join(privDir, 'signing-key.pem'), opts.keyMode || 0o600);
  const roster = opts.roster.map((r) => ids[r.identity].domain + '=' + ids[r.identity].pub + '@http://127.0.0.1:' + r.port + '/atlas/demo/txlab/api.php').join(',');
  const args = [TOOL, 'config', '--dir', privDir, '--domain', id.domain, '--settlement', opts.settlement, '--threshold', String(opts.threshold),
    '--mandatory', opts.mandatory.join(','), '--roster', roster, '--allow-insecure-http', '--ttl', String(opts.ttl || 900)];
  if (opts.enabled !== false) args.push('--enable');
  php(args);
  inst[label] = { label, port, base: 'http://127.0.0.1:' + port, privDir, docroot, token: id.token, domain: id.domain };
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
  const p = spawn('php', ['-S', '127.0.0.1:' + i.port, '-t', i.docroot], { env: { ...process.env, TXLAB_PRIVATE_DIR: i.privDir, PHP_CLI_SERVER_WORKERS: '6' }, stdio: ['ignore', 'ignore', 'ignore'] });
  procs[label] = p;
  await waitPort(i.port);
}
async function stop(label) {
  const p = procs[label];
  if (!p) return;
  p.kill('SIGKILL');
  await new Promise((r) => p.once('exit', r));
  delete procs[label];
}

async function call(label, op, o) {
  o = o || {};
  const url = inst[label].base + '/atlas/demo/txlab/api.php?op=' + op + (o.id ? '&id=' + encodeURIComponent(o.id) : '');
  const init = o.body !== undefined ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o.body) } : {};
  const r = await fetch(url, init);
  let body = null;
  try { body = await r.json(); } catch (e) { /* non-JSON */ }
  return { status: r.status, body };
}
const admin = (label, extra) => Object.assign({ adminToken: inst[label].token }, extra || {});
const reqId = () => 'req-' + crypto.randomBytes(8).toString('hex');
async function create(label, from, to, amountMinor, requestId) {
  return call(label, 'create', { body: admin(label, { requestId: requestId || reqId(), from, to, amountMinor }) });
}
const decide = (label, id, decision) => call(label, 'decide', { body: admin(label, { id, decision: decision || 'approve' }) });
const tx = async (label, id) => (await call(label, 'tx', { id })).body;
const state = async (label) => (await call(label, 'state')).body;
const eventKinds = (view) => view.events.map((e) => e.kind);

// ---------------------------------------------------------------- the run

async function main() {
  const phpVersion = php(['-r', 'echo PHP_VERSION;']);
  console.log('php ' + phpVersion + ', workspace ' + ROOT);
  const mods = php(['-m']);
  assert(/pdo_sqlite/.test(mods) && /openssl/.test(mods) && /curl/.test(mods), 'php needs pdo_sqlite, openssl and curl');

  makeIdentity('a', 'a.test');
  makeIdentity('b', 'b.test');
  makeIdentity('c', 'c.test');
  const PA = 9311, PB = 9312;
  const two = [{ identity: 'a', port: PA }, { identity: 'b', port: PB }];
  makeInstance('A', PA, { identity: 'a', settlement: 'a.test', roster: two, threshold: 2, mandatory: ['a.test'] });
  makeInstance('B', PB, { identity: 'b', settlement: 'a.test', roster: two, threshold: 2, mandatory: ['a.test'] });
  const docrootBefore = { A: fs.readdirSync(inst.A.docroot).sort().join(), B: fs.readdirSync(inst.B.docroot).sort().join() };
  await start('A');
  await start('B');
  const keysDistinct = ids.a.pub !== ids.b.pub && ids.a.pem !== ids.b.pem;
  assert(keysDistinct, 'each domain has its own key');

  // ---- 1. health, roster, pinned keys, peers
  {
    const ha = (await call('A', 'health')).body, hb = (await call('B', 'health')).body;
    assert(ha.enabled && hb.enabled && ha.role === 'settlement-authority' && hb.role === 'approver', 'both labs enabled, A settles, B approves');
    const ra = (await call('A', 'roster')).body;
    assert(ra.publicKeys['a.test'] === ids.a.pub && ra.publicKeys['b.test'] === ids.b.pub && ra.ownPublicKey === ids.a.pub, 'A pins both public keys');
    assert(JSON.stringify(Object.keys(ra)).indexOf('private') < 0 && !JSON.stringify(ra).includes(ids.a.token), 'roster exposes no secrets');
    const pa = (await call('A', 'peers')).body.peers.find((p) => p.domain === 'b.test');
    const pb = (await call('B', 'peers')).body.peers.find((p) => p.domain === 'a.test');
    assert(pa.reachable && pa.keyMatches && pb.reachable && pb.keyMatches, 'each domain sees the other and its key matches the pinned one');
    pass('two independently keyed domains are up; each pins the other\'s public key and verifies the peer\'s published key');
  }

  // ---- 2. authorization on sensitive actions
  {
    const noTok = await call('A', 'create', { body: { requestId: reqId(), from: 'alice', to: 'bob', amountMinor: 3000 } });
    const wrongTok = await call('A', 'create', { body: { adminToken: 'x'.repeat(40), requestId: reqId(), from: 'alice', to: 'bob', amountMinor: 3000 } });
    const wrongDecide = await call('B', 'decide', { body: { adminToken: ids.a.token, id: '00000000-0000-4000-8000-000000000000', decision: 'approve' } });
    assert(noTok.status === 401 && wrongTok.status === 401, 'create without or with a wrong admin token is refused');
    assert(wrongDecide.status === 401, 'B refuses A\'s admin token (tokens are per domain)');
    const getCreate = await fetch(inst.A.base + '/atlas/demo/txlab/api.php?op=create');
    assert(getCreate.status === 405, 'create is POST only');
    const st = await state('A');
    assert(st.transactions.length === 0 && st.balances.alice === 10000 && st.balances.bob === 0, 'nothing was created');
    pass('create/decide need the demo-administrator token (401 otherwise); tokens are per domain');
  }

  // ---- 3. the main flow with one approval only
  let tx1;
  {
    const reqA = reqId();
    const c = await create('A', 'alice', 'bob', 3000, reqA);
    assert(c.status === 200 && c.body.status === 'pending' && c.body.quorum.approved === 0 && c.body.quorum.required === 2, 'transaction created, pending, 0/2');
    const v = c.body;
    tx1 = v.txId;
    const p = v.payload;
    assert(p.amountMinor === 3000 && p.from === 'alice' && p.to === 'bob' && p.currency === 'DEMO' && p.origin === 'a.test' && p.v === 'domain-atlas-txlab/1', 'canonical payload fields');
    assert(p.policy.threshold === 2 && JSON.stringify(p.policy.roster) === '["a.test","b.test"]' && JSON.stringify(p.policy.mandatory) === '["a.test"]', 'policy and roster are part of the payload');
    assert(Number.isInteger(p.createdAtMs) && p.expiresAtMs > p.createdAtMs, 'creation and expiry are part of the payload');
    assert(v.digest === sha256hex(canonicalize(p)), 'the digest is sha256 over the canonical payload (recomputed here)');
    // the same request id never creates a second transaction
    const dup = await create('A', 'alice', 'bob', 3000, reqA);
    assert(dup.status === 200 && dup.body.txId === tx1, 'the same requestId returns the same transaction');
    assert((await state('A')).transactions.length === 1, 'still exactly one transaction');
    // B can view the same transaction and re-verifies it locally
    const vb = await tx('B', tx1);
    assert(vb.viewedFrom === 'b.test' && vb.digest === v.digest && vb.verifiedLocally.digestMatches, 'B shows the same transaction and recomputes its digest');
    pass('30.00 DEMO transfer created; canonical payload and digest verified independently; duplicate requestId creates nothing; B shows the same transaction');

    // B approves first
    const bApprove = await decide('B', tx1);
    assert(bApprove.status === 200, 'B approval accepted: ' + JSON.stringify(bApprove.body));
    const signed = bApprove.body;
    assert(signed.signedBy === 'b.test' && signed.approval.payloadDigest === v.digest && signed.approval.txId === tx1, 'B signed this exact digest');
    assert(await verifySig(ids.b.pub, signed.signature, signed.approval), 'B\'s signature verifies against B\'s public key (checked in the test)');
    assert(!(await verifySig(ids.a.pub, signed.signature, signed.approval)), 'and not against A\'s key');
    const afterB = await tx('A', tx1);
    assert(afterB.status === 'pending' && afterB.quorum.approved === 1, 'one valid approval: still pending, 1/2');
    assert(afterB.domains.find((d) => d.domain === 'b.test').status === 'approved' && afterB.domains.find((d) => d.domain === 'a.test').status === 'pending', 'A pending, B approved');
    const bal = (await state('A')).balances;
    assert(bal.alice === 10000 && bal.bob === 0, 'balances untouched with one approval');
    assert(afterB.approvals[0].verified === true, 'the server verifies the stored approval against the pinned key');
    pass('ONE valid approval (B) never executes: pending 1/2, balances unchanged');

    // ---- 4. attacks while pending
    const submit = (id, approval, signature) => call('A', 'submit-approval', { body: { id, approval, signature } });
    const base = { v: 'domain-atlas-txlab-approval/1', txId: tx1, payloadDigest: v.digest, decision: 'approve', approvedAtMs: Date.now() };
    // replay of B's real approval
    const replay = await submit(tx1, signed.approval, signed.signature);
    assert(replay.status === 409 && /duplicate approval/.test(replay.body.error), 'a replayed approval is refused as a duplicate: ' + JSON.stringify(replay.body));
    // forged "B" approval signed with the wrong key (A's own key) - A cannot impersonate B
    const forgedByA = { ...base, approver: 'b.test', approvedAtMs: Date.now() + 1 };
    const f1 = await submit(tx1, forgedByA, signWithPem(ids.a.pem, forgedByA));
    assert(f1.status === 400 && /does not verify/.test(f1.body.error), 'a "b.test" approval signed with A\'s key is rejected: ' + JSON.stringify(f1.body));
    // forged signature (random bytes)
    const f2 = await submit(tx1, forgedByA, b64u(crypto.randomBytes(64)));
    assert(f2.status === 400, 'random signature bytes are rejected');
    // an unauthorized domain, validly signed with its own key
    const c3 = { ...base, approver: 'c.test' };
    const f3 = await submit(tx1, c3, signWithPem(ids.c.pem, c3));
    assert(f3.status === 403 && /not in this transaction/.test(f3.body.error), 'a domain outside the roster is refused: ' + JSON.stringify(f3.body));
    // wrong transaction id
    const other = (await create('A', 'alice', 'bob', 1000, reqId())).body;
    const wrongId = await submit(other.txId, signed.approval, signed.signature);
    assert(wrongId.status === 400 && /different transaction/.test(wrongId.body.error), 'B\'s approval of tx1 cannot be used for another transaction: ' + JSON.stringify(wrongId.body));
    const wrongIdInBody = { ...base, approver: 'b.test', txId: other.txId };
    const w2 = await submit(tx1, wrongIdInBody, signWithPem(ids.b.pem, wrongIdInBody));
    assert(w2.status === 400, 'an approval naming another transaction is refused');
    // modified amount / recipient: B really signs, but over a modified payload digest
    const evil = { ...v.payload, amountMinor: 9000 };
    const modAmount = { ...base, approver: 'b.test', payloadDigest: sha256hex(canonicalize(evil)) };
    const m1 = await submit(tx1, modAmount, signWithPem(ids.b.pem, modAmount));
    assert(m1.status === 400 && /different payload/.test(m1.body.error), 'a correctly signed approval over a modified amount is refused: ' + JSON.stringify(m1.body));
    const evil2 = { ...v.payload, to: 'alice', from: 'bob' };
    const modTo = { ...base, approver: 'b.test', payloadDigest: sha256hex(canonicalize(evil2)) };
    assert((await submit(tx1, modTo, signWithPem(ids.b.pem, modTo))).status === 400, 'a modified recipient is refused');
    // malformed
    assert((await submit(tx1, { ...base, approver: 'b.test', extra: 1 }, 'AAAA')).status === 400, 'extra fields are refused (exact shape)');
    assert((await submit(tx1, null, null)).status === 400, 'missing approval is refused');
    const after = await tx('A', tx1);
    assert(after.status === 'pending' && after.quorum.approved === 1, 'after every attack: still pending 1/2');
    assert((await state('A')).balances.alice === 10000, 'and balances unchanged');
    const kinds = eventKinds(after);
    assert(kinds.filter((k) => k === 'approval-rejected').length >= 6, 'each rejected attempt is in the event log');
    pass('replay, forged B (signed by A), random signature, unauthorized domain, wrong tx id, modified amount, modified recipient, malformed: all rejected, transaction unchanged, each logged');
  }

  // ---- 5. the second domain completes the quorum: execution exactly once
  {
    const before = await tx('A', tx1);
    const a = await decide('A', tx1);
    assert(a.status === 200, 'A approval: ' + JSON.stringify(a.body));
    assert(await verifySig(ids.a.pub, a.body.signature, a.body.approval), 'A\'s signature verifies against A\'s key');
    const v = await tx('A', tx1);
    assert(v.status === 'executed' && v.quorum.approved === 2, 'quorum reached, executed');
    const st = await state('A');
    assert(st.balances.alice === 7000 && st.balances.bob === 3000, 'Alice 70.00, Bob 30.00');
    assert(st.conservation.ok && st.conservation.sumMinor === 10000, 'conservation holds');
    const r = v.receipt;
    assert(r && r.verified && await verifySig(ids.a.pub, r.signature, r.receipt), 'receipt signed by the settlement authority (verified here)');
    assert(r.receipt.payloadDigest === v.digest && r.receipt.balancesBefore.alice === 10000 && r.receipt.balancesAfter.alice === 7000 && r.receipt.balancesAfter.bob === 3000, 'receipt matches');
    assert(r.receipt.approvals.length === 2, 'receipt lists both approvals');
    for (const ap of v.approvals) assert(await verifySig(ids[ap.approver === 'a.test' ? 'a' : 'b'].pub, ap.signature, ap.approval) && ap.verified, 'approval by ' + ap.approver + ' verifies');
    const kinds = eventKinds(v);
    assert(kinds.indexOf('quorum-reached') > kinds.lastIndexOf('approval-accepted') - 1 && kinds.filter((k) => k === 'executed').length === 1, 'one quorum event and one execution event');
    // B's view of the executed transaction re-verifies everything with B's own pinned keys
    const vb = await tx('B', tx1);
    assert(vb.status === 'executed' && vb.verifiedLocally.digestMatches && vb.verifiedLocally.receiptVerified === true && vb.verifiedLocally.approvals.every((x) => x.verified), 'B re-verifies digest, both approvals and the receipt independently');
    const stB = await state('B');
    assert(stB.balances.alice === 7000 && stB.viewedFrom === 'b.test', 'B displays the same balances');
    pass('second domain approval reaches 2/2 and executes: Alice 70, Bob 30, conserved; receipt + approvals verified in the test and on B');

    // duplicate execution attempts
    const again = await decide('A', tx1);
    assert(again.status === 409, 'a second approval on an executed transaction is refused');
    const bAgain = await decide('B', tx1);
    assert(bAgain.status === 409, 'B cannot approve an executed transaction either');
    const st2 = await state('A');
    assert(st2.balances.alice === 7000 && st2.balances.bob === 3000, 'repeated approvals never debit twice');
    pass('duplicate execution attempts change nothing');
  }

  // ---- 6. concurrency: many parallel approvals execute once; competing transfers cannot overdraw
  {
    const t = (await create('A', 'alice', 'bob', 1000, reqId())).body.txId;
    await decide('B', t);
    const results = await Promise.all(Array.from({ length: 8 }, () => decide('A', t)));
    const okCount = results.filter((r) => r.status === 200).length;
    assert(okCount === 1, 'exactly one of 8 parallel approvals wins: ' + results.map((r) => r.status).join());
    const v = await tx('A', t);
    assert(v.status === 'executed', 'executed');
    const bal = (await state('A')).balances;
    assert(bal.alice === 6000 && bal.bob === 4000, 'debited and credited exactly once (Alice 60, Bob 40)');
    // two transfers that each fit alone but not together
    const x1 = (await create('A', 'alice', 'bob', 4000, reqId())).body.txId;
    const x2 = (await create('A', 'alice', 'bob', 4000, reqId())).body.txId;
    await Promise.all([decide('B', x1), decide('B', x2)]);
    await Promise.all([decide('A', x1), decide('A', x2)]);
    const s = [(await tx('A', x1)).status, (await tx('A', x2)).status].sort();
    assert(s.join() === 'executed,failed', 'one executes, the other is refused at execution: ' + s.join());
    const failed = (await tx('A', (await tx('A', x1)).status === 'failed' ? x1 : x2));
    assert(/insufficient/.test(failed.failReason) && eventKinds(failed).includes('execution-refused'), 'failure reason recorded');
    const fin = await state('A');
    assert(fin.balances.alice === 2000 && fin.balances.bob === 8000 && fin.conservation.ok, 'Alice 20, Bob 80; nothing overdrawn; conserved');
    // creation-time insufficient balance
    const big = await create('A', 'alice', 'bob', 5000, reqId());
    assert(big.status === 409 && /insufficient/.test(big.body.error), 'insufficient balance rejected at creation');
    const bad = [await create('A', 'alice', 'bob', 30.5), await create('A', 'alice', 'bob', '3000'), await create('A', 'alice', 'bob', -5), await create('A', 'alice', 'alice', 100), await create('A', 'alice', 'mallory', 100), await create('A', 'alice', 'bob', 0)];
    assert(bad.every((r) => r.status === 400), 'floats, strings, negatives, self-transfers, unknown accounts and zero are refused: ' + bad.map((r) => r.status).join());
    pass('8 parallel approvals execute once; competing transfers cannot overdraw (one fails at execution); insufficient and malformed amounts are refused; integer minor units only');
  }

  // ---- 7. restart while pending, unavailable peers
  {
    const t = (await create('A', 'bob', 'alice', 2000, reqId())).body.txId;
    assert((await decide('B', t)).status === 200, 'B approves');
    const before = await tx('A', t);
    await stop('A');
    // A is down: B gets an explicit error and the transaction is untouched
    const down = await decide('B', t);
    assert(down.status === 502 && down.body.state === 'peer-unavailable', 'with A down, B reports an explicit peer-unavailable error: ' + JSON.stringify(down.body));
    const viewDown = await call('B', 'tx', { id: t });
    assert(viewDown.status === 502, 'and B\'s view says the settlement authority is unreachable');
    await start('A');
    const afterRestart = await tx('A', t);
    assert(afterRestart.status === 'pending' && afterRestart.quorum.approved === 1 && afterRestart.digest === before.digest, 'the pending transaction and its approval survived the restart');
    assert((await decide('A', t)).status === 200, 'after the restart, A completes it');
    const v = await tx('A', t);
    assert(v.status === 'executed', 'executed after restart');
    const st = await state('A');
    assert(st.balances.alice === 4000 && st.balances.bob === 6000 && st.conservation.ok, 'balances correct and conserved after restart (Alice 40, Bob 60)');
    // B down: A's transaction stays pending
    const t2 = (await create('A', 'bob', 'alice', 500, reqId())).body.txId;
    await stop('B');
    assert((await decide('A', t2)).status === 200, 'A approves while B is down');
    const pend = await tx('A', t2);
    assert(pend.status === 'pending' && pend.quorum.approved === 1, 'with B unavailable the transaction stays pending (1/2)');
    const peers = (await call('A', 'peers')).body.peers.find((p) => p.domain === 'b.test');
    assert(peers.reachable === false, 'A reports B as unreachable');
    await start('B');
    assert((await decide('B', t2)).status === 200, 'B comes back and approves');
    assert((await tx('A', t2)).status === 'executed', 'executed once B is back');
    const dbCount = php(['-r', '$d=new PDO("sqlite:' + path.join(inst.A.privDir, 'txlab.sqlite') + '"); echo $d->query("SELECT COUNT(*) FROM ledger")->fetchColumn();']);
    const executed = php(['-r', '$d=new PDO("sqlite:' + path.join(inst.A.privDir, 'txlab.sqlite') + '"); echo $d->query("SELECT COUNT(*) FROM tx WHERE status=\'executed\'")->fetchColumn();']);
    assert(dbCount === executed, 'one ledger entry per executed transaction (' + dbCount + ')');
    pass('A restarted while pending: transaction and approval survive; unavailable peers give explicit errors / remain pending; recovery completes exactly once');
  }

  // ---- 8. database immutability
  {
    const dbPath = path.join(inst.A.privDir, 'txlab.sqlite');
    const attempt = (sql) => { try { php(['-r', '$d=new PDO("sqlite:' + dbPath + '"); $d->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION); $d->exec("' + sql + '"); echo "CHANGED";'], { stdio: ['ignore', 'pipe', 'pipe'] }); return 'changed'; } catch (e) { return 'blocked'; } };
    assert(attempt("UPDATE tx SET payload_json=\\'{}\\'") === 'blocked', 'the stored payload cannot be edited');
    assert(attempt("UPDATE tx SET status=\\'pending\\' WHERE status=\\'executed\\'") === 'blocked', 'an executed transaction cannot return to pending');
    assert(attempt('DELETE FROM approvals') === 'blocked' && attempt('UPDATE ledger SET amount_minor=1') === 'blocked' && attempt('DELETE FROM tx') === 'blocked', 'approvals and ledger entries cannot be edited or deleted');
    assert(attempt('UPDATE accounts SET balance_minor=-1') === 'blocked', 'negative balances are impossible');
    pass('the database itself refuses payload edits, state reversals, deletions and negative balances');
  }

  // ---- 9. expiry
  {
    makeInstance('Ashort', 9313, { identity: 'a', settlement: 'a.test', roster: [{ identity: 'a', port: 9313 }, { identity: 'b', port: 9314 }], threshold: 2, mandatory: ['a.test'], ttl: 2 });
    makeInstance('Bshort', 9314, { identity: 'b', settlement: 'a.test', roster: [{ identity: 'a', port: 9313 }, { identity: 'b', port: 9314 }], threshold: 2, mandatory: ['a.test'], ttl: 2 });
    await start('Ashort'); await start('Bshort');
    const t = (await create('Ashort', 'alice', 'bob', 3000, reqId())).body.txId;
    assert((await decide('Bshort', t)).status === 200, 'B approves inside the window');
    await sleep(3200);
    const lateA = await decide('Ashort', t);
    assert(lateA.status === 409, 'a late approval is refused: ' + JSON.stringify(lateA.body));
    const v = await tx('Ashort', t);
    assert(v.status === 'expired' && (await state('Ashort')).balances.alice === 10000, 'the transaction expired and nothing moved');
    // a validly signed but late approval submitted directly is refused too
    const t2 = (await create('Ashort', 'alice', 'bob', 3000, reqId())).body;
    await sleep(3200);
    const late = { v: 'domain-atlas-txlab-approval/1', txId: t2.txId, payloadDigest: t2.digest, approver: 'b.test', decision: 'approve', approvedAtMs: Date.now() };
    const direct = await call('Ashort', 'submit-approval', { body: { id: t2.txId, approval: late, signature: signWithPem(ids.b.pem, late) } });
    assert(direct.status === 409 && /expired/.test(direct.body.error), 'a validly signed approval after expiry is refused: ' + JSON.stringify(direct.body));
    await stop('Ashort'); await stop('Bshort');
    pass('expired authorization: late approvals (via the lab and signed directly) are refused, the transaction expires, balances unchanged');
  }

  // ---- 10. a rejecting domain, and policy independence (2-of-3 with a mandatory settlement domain)
  {
    const t = (await create('A', 'alice', 'bob', 100, reqId())).body.txId;
    const rej = await decide('B', t, 'reject');
    assert(rej.status === 200, 'B signs a rejection');
    const v = await tx('A', t);
    assert(v.domains.find((d) => d.domain === 'b.test').status === 'rejected' && v.status === 'rejected', 'a rejection that makes the 2-of-2 policy impossible ends the transaction');
    assert((await decide('A', t)).status === 409, 'and it cannot be revived by the other domain');

    const rosterThree = [{ identity: 'a', port: 9321 }, { identity: 'b', port: 9322 }, { identity: 'c', port: 9323 }];
    makeInstance('A3', 9321, { identity: 'a', settlement: 'a.test', roster: rosterThree, threshold: 2, mandatory: ['a.test'] });
    makeInstance('B3', 9322, { identity: 'b', settlement: 'a.test', roster: rosterThree, threshold: 2, mandatory: ['a.test'] });
    await start('A3'); await start('B3');
    const t3 = (await create('A3', 'alice', 'bob', 2500, reqId())).body;
    assert(t3.payload.policy.roster.length === 3 && t3.payload.policy.threshold === 2, '2-of-3 policy from configuration only');
    assert((await decide('B3', t3.txId)).status === 200, 'B approves');
    // domain C signs with its own key and submits
    const cAp = { v: 'domain-atlas-txlab-approval/1', txId: t3.txId, payloadDigest: t3.digest, approver: 'c.test', decision: 'approve', approvedAtMs: Date.now() };
    const cSub = await call('A3', 'submit-approval', { body: { id: t3.txId, approval: cAp, signature: signWithPem(ids.c.pem, cAp) } });
    assert(cSub.status === 200, 'C approval accepted: ' + JSON.stringify(cSub.body));
    const mid = await tx('A3', t3.txId);
    assert(mid.quorum.approved === 2 && mid.status === 'pending' && mid.quorum.missingMandatory.join() === 'a.test', 'two of three approved, but the ledger-owning domain has not: NOT executed');
    assert(eventKinds(mid).includes('execution-blocked'), 'the block is logged');
    assert((await state('A3')).balances.alice === 10000, 'balances untouched');
    assert((await decide('A3', t3.txId)).status === 200, 'the settlement domain approves');
    const done = await tx('A3', t3.txId);
    assert(done.status === 'executed' && done.quorum.approved === 3, 'executes once the mandatory domain has approved too');
    pass('2-of-3 from configuration: two unrelated approvals cannot override the ledger-owning domain\'s required consent; executes only after it approves');

    // B refuses to sign a transaction whose policy is not its own
    makeInstance('Bmis', 9324, { identity: 'b', settlement: 'a.test', roster: [{ identity: 'a', port: 9321 }, { identity: 'b', port: 9324 }], threshold: 2, mandatory: ['a.test'] });
    await start('Bmis');
    const t4 = (await create('A3', 'alice', 'bob', 100, reqId())).body.txId;
    const mis = await decide('Bmis', t4);
    assert(mis.status === 400 && /differs from this domain/.test(mis.body.error), 'a domain refuses a transaction whose quorum policy differs from its own: ' + JSON.stringify(mis.body));
    assert((await tx('A3', t4)).quorum.approved === 0, 'and signed nothing');
    await stop('Bmis');
    pass('a domain signs only under its own configured policy');
    await stop('A3'); await stop('B3');
  }

  // ---- 11. a dishonest settlement authority cannot get B to sign a tampered payload
  {
    const t = (await create('A', 'alice', 'bob', 100, reqId())).body;
    const tampered = { ...t, payload: { ...t.payload, amountMinor: 9900 } }; // digest still the original
    let posts = 0;
    const http = require('http');
    const fake = http.createServer((req, res) => {
      if (req.method === 'POST') posts++;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(tampered));
    });
    await new Promise((r) => fake.listen(9330, '127.0.0.1', r));
    makeInstance('Bfake', 9331, { identity: 'b', settlement: 'a.test', roster: [{ identity: 'a', port: 9330 }, { identity: 'b', port: 9331 }], threshold: 2, mandatory: ['a.test'] });
    await start('Bfake');
    const r = await decide('Bfake', t.txId);
    assert(r.status === 400 && /does not match its digest/.test(r.body.error) && posts === 0, 'B refuses a payload that does not match its digest and sends nothing: ' + JSON.stringify(r.body));
    // an internally consistent but altered transaction (digest recomputed) is also refused when its terms break B's policy
    const evil = { ...t.payload, amountMinor: 999999999 };
    tampered.payload = evil; tampered.digest = sha256hex(canonicalize(evil));
    const r2 = await decide('Bfake', t.txId);
    assert(r2.status === 400 && /amount is outside/.test(r2.body.error) && posts === 0, 'B refuses terms outside its own limits: ' + JSON.stringify(r2.body));
    await stop('Bfake');
    fake.close();
    pass('B independently validates what it is shown: tampered payload and out-of-policy terms are refused before anything is signed');
  }

  // ---- 12. fail-closed configuration and isolation
  {
    const mk = async (label, port, mutate) => {
      makeInstance(label, port, { identity: 'a', settlement: 'a.test', roster: [{ identity: 'a', port }, { identity: 'b', port: 9399 }], threshold: 2, mandatory: ['a.test'] });
      if (mutate) mutate(inst[label]);
      await start(label);
    };
    await mk('Doff', 9341, (i) => fs.writeFileSync(path.join(i.privDir, 'DISABLED'), 'x'));
    const off = await call('Doff', 'health');
    assert(off.body.enabled === false && /DISABLED/.test(off.body.reasons.join()), 'the DISABLED file is a kill switch');
    assert((await create('Doff', 'alice', 'bob', 100)).status === 503, 'a disabled lab refuses every operation');
    await mk('Dperm', 9342, (i) => fs.chmodSync(path.join(i.privDir, 'signing-key.pem'), 0o644));
    assert((await call('Dperm', 'health')).body.enabled === false, 'a world-readable key keeps the lab disabled');
    await mk('Dkey', 9343, (i) => { const other = ids.b.pem; fs.writeFileSync(path.join(i.privDir, 'signing-key.pem'), other, { mode: 0o600 }); });
    assert(/does not match/.test((await call('Dkey', 'health')).body.reasons.join()), 'a signing key that does not match the pinned public key keeps the lab disabled');
    makeInstance('Dweb', 9344, { identity: 'a', settlement: 'a.test', roster: [{ identity: 'a', port: 9344 }, { identity: 'b', port: 9399 }], threshold: 2, mandatory: ['a.test'], privDir: path.join(ROOT, 'Dweb', 'public_html', 'private-inside') });
    await start('Dweb');
    assert(/inside the web root/.test((await call('Dweb', 'health')).body.reasons.join()), 'a private directory inside the web root keeps the lab disabled');
    const noSettle = (() => { try { makeInstance('Dbad', 9345, { identity: 'a', settlement: 'a.test', roster: [{ identity: 'a', port: 9345 }, { identity: 'b', port: 9399 }], threshold: 2, mandatory: [] }); return 'ok'; } catch (e) { return 'err'; } })();
    await start('Dbad');
    assert(/mandatory approver/.test((await call('Dbad', 'health')).body.reasons.join()), 'a policy that does not require the ledger-owning domain is refused');
    for (const l of ['Doff', 'Dperm', 'Dkey', 'Dweb', 'Dbad']) await stop(l);
    pass('fail closed: DISABLED switch, world-readable key, wrong key, private dir in the web root, policy without the settlement domain - all keep the lab disabled');

    // isolation: only lab files exist in the docroots, no issuer state appeared, secrets are not served
    for (const l of ['A', 'B']) {
      assert(fs.readdirSync(inst[l].docroot).sort().join() === docrootBefore[l], l + ' docroot gained no files');
      const listing = fs.readdirSync(path.join(inst[l].docroot, 'lib'));
      assert(listing.join() === 'crypto.php', l + ' wrote nothing into lib/ (no issuer keys or stores)');
      assert(!fs.existsSync(path.join(inst[l].docroot, '.well-known')), l + ' created no .well-known files');
    }
    assert(fs.readdirSync(inst.A.privDir).includes('txlab.sqlite'), 'state lives only in the private directory');
    const leak = await fetch(inst.A.base + '/atlas/demo/txlab/inc/txlab.php');
    const body = await leak.text();
    assert(!/signing-key|BEGIN EC PRIVATE KEY|adminTokenHash/.test(body), 'no secret appears in anything served');
    const allText = JSON.stringify([(await call('A', 'state')).body, (await call('A', 'roster')).body, await tx('A', tx1)]);
    assert(!allText.includes(ids.a.token) && !allText.includes('PRIVATE KEY') && !allText.includes(sha256hex(ids.a.token)), 'responses contain no token, token hash or private key');
    pass('isolation: no issuer files created, secrets only in the private directory, nothing secret in any response');
  }

  console.log('\nALL ' + checks + ' TRANSACTION LAB CHECKS PASSED');
}

main().then(() => cleanup(0), (e) => { console.error('\nFAILURE: ' + (e && e.stack || e)); cleanup(1); });

function cleanup(code) {
  for (const p of Object.values(procs)) { try { p.kill('SIGKILL'); } catch (e) { /* gone */ } }
  if (!process.env.TXLAB_KEEP) fs.rmSync(ROOT, { recursive: true, force: true });
  else console.log('kept ' + ROOT);
  process.exit(code);
}
