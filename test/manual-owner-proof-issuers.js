// Proof of key ownership for membership issuance, against real issuers: the Node issuer and the PHP issuer, each in
// accept and require mode (and a strict pair with the origin check left on). Every refusal is checked for side effects:
// no credential, no roster row, no welcome mail, no replay record, no journal entry.
//
// Nothing here contacts a live domain: every issuer is a throw-away local instance with its own state.
// Run: node test/manual-owner-proof-issuers.js        (about a minute: it waits out a real part of the two-minute window)
'use strict';
const { spawn, execFileSync } = require('child_process');
const { webcrypto } = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { subtle } = webcrypto;
const proofLib = require('../issuer-server/lib-owner-proof');

const ROOT = path.resolve(__dirname, '..');
const CLASSES = proofLib.OWNER_PROOF_CLASSES;
const POST_OFFICE = 'atlas.postoffice.membership';
const MESSAGE = 'This domain requires a newer version of Domain Atlas Wallet to join this service. Please update your wallet and try again.';
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const canonicalize = proofLib.canonicalize;

let failures = 0;
function check(name, ok, detail) {
  if (ok) console.log('PASS ' + name);
  else { failures++; console.log('FAIL ' + name + (detail !== undefined ? ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}

async function newKey() {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return { pair, publicKey: b64u(await subtle.exportKey('raw', pair.publicKey)) };
}
async function sign(key, payload) {
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.pair.privateKey, new TextEncoder().encode(canonicalize(payload)));
  return { signerRole: 'raw-ecdsa', publicKey: key.publicKey, signature: b64u(sig) };
}
const rid = () => 'rid-' + b64u(webcrypto.getRandomValues(new Uint8Array(15)));

function post(base, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + urlPath);
    const data = JSON.stringify(body);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, headers || {}) }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => { let json = {}; try { json = JSON.parse(text); } catch (e) { json = { raw: text }; } resolve({ status: res.statusCode, body: json }); });
    });
    req.on('error', reject);
    req.end(data);
  });
}
const getJson = (base, p) => fetch(base + p).then((r) => r.json());

const { startNode, startPhp, snapshot, readJson, mailFor, rosterTotal, stopAll } = require('./owner-proof-lib');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------- requests ----------
function intentFields(inst, owner, assetClass, over) {
  return Object.assign({ assetClass, domain: inst.domain, issuedAt: new Date().toISOString(), ownerPublicKey: owner.publicKey, requestId: rid() }, over || {});
}
async function signedBody(inst, signer, owner, assetClass, over, payloadOver) {
  const f = intentFields(inst, owner, assetClass, over);
  const payload = Object.assign(proofLib.issuePayload(f), payloadOver || {});
  return { body: { ownerPublicKey: f.ownerPublicKey, assetClass, requestId: f.requestId, intent: { payload, proof: await sign(signer, payload) } }, fields: f };
}
const issue = (inst, body, headers) => post(inst.base, '/atlas/asset/issue', body, headers);

// A refused request must leave the issuer exactly as it was.
async function refusedWithoutTrace(inst, name, body, status, code, headers) {
  const before = snapshot(inst);
  const r = await issue(inst, body, headers);
  const after = snapshot(inst);
  check(inst.name + ': ' + name + ' -> ' + status + ' ' + code, r.status === status && r.body.code === code, { status: r.status, body: r.body });
  check(inst.name + ': ' + name + ' leaves no credential, roster row, mail, replay record or journal entry', same(before, after), { before, after });
  return r;
}

// ---------- suites ----------
async function acceptSuite(inst) {
  console.log('--- ' + inst.name + ' (accept) ---');
  const caps = await getJson(inst.base, '/atlas/capabilities');
  check(inst.name + ': capabilities list ownerProof in accept mode', caps.ownerProof && caps.ownerProof.mode === 'accept' && caps.ownerProof.operation === 'issue' && caps.ownerProof.version === 1
    && JSON.stringify(caps.ownerProof.classes) === JSON.stringify(CLASSES), caps.ownerProof);
  const owner = await newKey(), victim = await newKey(), attacker = await newKey();

  // accept still refuses every bad proof
  const good = await signedBody(inst, owner, owner, POST_OFFICE);
  const flipped = JSON.parse(JSON.stringify(good.body));
  flipped.intent.proof.signature = flipped.intent.proof.signature.slice(0, -3) + (flipped.intent.proof.signature.slice(-3) === 'AAA' ? 'BBB' : 'AAA');
  await refusedWithoutTrace(inst, 'accept: a changed signature', flipped, 403, 'owner-signature-invalid');
  const asVictim = await signedBody(inst, attacker, victim, POST_OFFICE);
  await refusedWithoutTrace(inst, 'accept: the attacker signs for the victim', asVictim.body, 403, 'not-owner');
  await refusedWithoutTrace(inst, 'accept: a request for another domain', (await signedBody(inst, owner, owner, POST_OFFICE, {}, { domain: 'elsewhere.example.test' })).body, 403, 'owner-authorization-required');
  await refusedWithoutTrace(inst, 'accept: an intent that is a string', { ownerPublicKey: owner.publicKey, assetClass: POST_OFFICE, requestId: rid(), intent: 'yes' }, 403, 'owner-authorization-required');
  await refusedWithoutTrace(inst, 'accept: a signed request without a requestId', (() => { const b = JSON.parse(JSON.stringify(good.body)); delete b.requestId; return b; })(), 400, 'request-id-required');

  // an unsigned request is still served, counted, and logged as unsigned
  const before = snapshot(inst);
  const legacy = await issue(inst, { ownerPublicKey: owner.publicKey, assetClass: POST_OFFICE });
  check(inst.name + ': accept serves an unsigned request (temporary compatibility)', legacy.status === 200 && legacy.body.owner && legacy.body.owner.publicKey === owner.publicKey, legacy);
  check(inst.name + ': ...and it wrote one roster row and one welcome mail', snapshot(inst).postOffice === before.postOffice + 1 && mailFor(inst, legacy.body.id) === 1);
  const signed = await issue(inst, good.body);
  check(inst.name + ': accept serves a signed request', signed.status === 200 && signed.body.owner.publicKey === owner.publicKey, signed);

  const stats = readJson(inst.statsFile, null);
  const c = stats && stats.classes && stats.classes[POST_OFFICE];
  check(inst.name + ': the outcome counts record signed, unsigned and refused', c && c.signed === 1 && c.unsigned === 1 && c.refused >= 5 && stats.mode === 'accept', stats);

  // readiness: unsigned issuance is recent, so not ready; later it is, and the tool says so
  const tool = (extra) => { try { return { code: 0, out: execFileSync('node', [path.join(ROOT, 'tools', 'owner-proof-readiness.js'), inst.statsFile].concat(extra || []), { encoding: 'utf8' }) }; } catch (e) { return { code: e.status, out: String(e.stdout) }; } };
  let r = tool();
  check(inst.name + ': the readiness tool says NOT READY while unsigned issuance is recent', r.code === 1 && /NOT READY/.test(r.out), r);
  await sleep(1500);
  r = tool(['--days', '0.00001']);
  check(inst.name + ': ...and READY once none is recent and a signed issuance has worked', r.code === 0 && /READY for require/.test(r.out) && /temporary|compatibility/.test(r.out), r);
}

async function requireSuite(inst, other) {
  console.log('--- ' + inst.name + ' (require) ---');
  const caps = await getJson(inst.base, '/atlas/capabilities');
  check(inst.name + ': capabilities list ownerProof in require mode', caps.ownerProof && caps.ownerProof.mode === 'require', caps.ownerProof);
  const owner = await newKey(), victim = await newKey(), attacker = await newKey();

  for (const cls of CLASSES) {
    const r = await refusedWithoutTrace(inst, 'an unsigned request for ' + cls, { ownerPublicKey: victim.publicKey, assetClass: cls }, 403, 'owner-authorization-required');
    check(inst.name + ': ...with the update-your-wallet wording, which an older wallet shows as it is', r.body.error === MESSAGE && r.body.updateWallet === true, r.body);
  }
  await refusedWithoutTrace(inst, 'a request with intent null', { ownerPublicKey: victim.publicKey, assetClass: POST_OFFICE, intent: null }, 403, 'owner-authorization-required');
  await refusedWithoutTrace(inst, 'the attacker signs for the victim', (await signedBody(inst, attacker, victim, POST_OFFICE)).body, 403, 'not-owner');
  {
    const g = await signedBody(inst, attacker, attacker, POST_OFFICE);
    const swapped = JSON.parse(JSON.stringify(g.body));
    swapped.ownerPublicKey = victim.publicKey;
    await refusedWithoutTrace(inst, "the attacker's own request aimed at the victim", swapped, 403, 'owner-authorization-required');
    const forged = JSON.parse(JSON.stringify(g.body));
    forged.intent.proof.publicKey = victim.publicKey;
    forged.ownerPublicKey = victim.publicKey;
    forged.intent.payload.ownerPublicKey = victim.publicKey;
    await refusedWithoutTrace(inst, "the attacker's signature under the victim's name", forged, 403, 'owner-signature-invalid');
  }
  await refusedWithoutTrace(inst, 'a quantity of 2 in the signed request', (await signedBody(inst, owner, owner, POST_OFFICE, {}, { quantity: 2 })).body, 403, 'owner-authorization-required');
  await refusedWithoutTrace(inst, 'an extra field in the signed request', (await signedBody(inst, owner, owner, POST_OFFICE, {}, { note: 'x' })).body, 403, 'owner-authorization-required');
  {
    const payload = { action: 'mail-check', domain: inst.domain, credentialIds: [], issuedAt: new Date().toISOString(), nonce: 'nnnnnnnnnnnnnnnnnn' };
    const asIssue = { ownerPublicKey: owner.publicKey, assetClass: POST_OFFICE, requestId: rid(), intent: { payload, proof: await sign(owner, payload) } };
    await refusedWithoutTrace(inst, 'a signed mail check presented as the request', asIssue, 403, 'owner-authorization-required');
  }
  await refusedWithoutTrace(inst, 'a bridge-wrapped signature', await (async () => {
    const f = intentFields(inst, owner, POST_OFFICE);
    const wrapped = { ctx: 'atlas.bridge.sign/1', origin: 'https://page.example.test', payload: proofLib.issuePayload(f) };
    return { ownerPublicKey: f.ownerPublicKey, assetClass: POST_OFFICE, requestId: f.requestId, intent: { payload: wrapped, proof: await sign(owner, wrapped) } };
  })(), 403, 'owner-authorization-required');
  await refusedWithoutTrace(inst, 'a passkey-style proof that does not verify', await (async () => {
    const g = await signedBody(inst, owner, owner, POST_OFFICE);
    g.body.intent.proof = { signerRole: 'webauthn', publicKey: owner.publicKey, clientDataJSON: 'e30', authenticatorData: 'AA', signature: 'AA' };
    return g.body;
  })(), 403, 'owner-signature-invalid');
  for (const [label, intent] of [['an array', []], ['a number', 7], ['an empty object', {}]]) {
    await refusedWithoutTrace(inst, 'an intent that is ' + label, { ownerPublicKey: victim.publicKey, assetClass: POST_OFFICE, requestId: rid(), intent }, 403, 'owner-authorization-required');
  }

  // cross-domain: a request signed for the other issuer is refused here, and the reverse
  const forOther = await signedBody(other, owner, owner, POST_OFFICE);
  await refusedWithoutTrace(inst, "a request signed for another issuer's domain", forOther.body, 403, 'owner-authorization-required');
  const here = await signedBody(inst, owner, owner, POST_OFFICE);
  await refusedWithoutTrace(other, "a request signed for " + inst.name + "'s domain", here.body, 403, 'owner-authorization-required');
  // a class presented for another
  const mem = await signedBody(inst, owner, owner, 'atlas.membership');
  const asTrading = JSON.parse(JSON.stringify(mem.body)); asTrading.assetClass = 'atlas.tradingstation.membership';
  await refusedWithoutTrace(inst, 'a request signed for one class presented for another', asTrading, 403, 'owner-authorization-required');

  // stale: nothing is created, and the same request id works with a fresh signature
  const old = await signedBody(inst, owner, owner, POST_OFFICE, { issuedAt: new Date(Date.now() - 180000).toISOString() });
  const stale = await refusedWithoutTrace(inst, 'a request signed three minutes ago', old.body, 401, 'stale-request');
  check(inst.name + ': ...the refusal carries the issuer\'s time so a wallet can correct itself', Math.abs(Date.parse(stale.body.serverTime) - Date.now()) < 5000, stale.body);
  const future = await signedBody(inst, owner, owner, POST_OFFICE, { issuedAt: new Date(Date.now() + 180000).toISOString() });
  await refusedWithoutTrace(inst, 'a request signed three minutes ahead', future.body, 401, 'stale-request');
  const again = await signedBody(inst, owner, owner, POST_OFFICE, { requestId: old.fields.requestId });
  const first = await issue(inst, again.body);
  check(inst.name + ': the same request id, signed afresh, is then issued', first.status === 200 && first.body.owner.publicKey === owner.publicKey, first);

  // each class, issued once, one roster row and one welcome mail each
  const credentials = {};
  for (const cls of CLASSES) {
    const k = await newKey();
    const before = snapshot(inst);
    const g = await signedBody(inst, k, k, cls);
    const r = await issue(inst, g.body);
    const after = snapshot(inst);
    credentials[cls] = r.body;
    check(inst.name + ': ' + cls + ' is issued to the signing key', r.status === 200 && r.body.owner.publicKey === k.publicKey && r.body.asset.class === cls && r.body.issuer.domain === inst.domain, r);
    check(inst.name + ': ...with exactly one roster row and one welcome mail', rosterTotal(after) === rosterTotal(before) + 1 && after.mail === before.mail + 1 && mailFor(inst, r.body.id) === 1, { before, after });
    const second = await issue(inst, g.body);
    const after2 = snapshot(inst);
    check(inst.name + ': ...and a repeat of it returns the same credential and writes nothing more', second.status === 200 && second.body.id === r.body.id && same(after, after2), { second: second.status, after, after2 });
    const conflict = await signedBody(inst, k, k, cls === POST_OFFICE ? 'atlas.membership' : POST_OFFICE, { requestId: g.fields.requestId });
    const c = await issue(inst, conflict.body);
    check(inst.name + ': ...and the same request id for another class is a conflict', c.status === 409 && c.body.code === 'request-id-conflict', c);
  }

  // many copies at once: one credential
  {
    const k = await newKey();
    const g = await signedBody(inst, k, k, POST_OFFICE);
    const before = snapshot(inst);
    const rs = await Promise.all(Array.from({ length: 20 }, () => issue(inst, g.body)));
    const ok = rs.filter((r) => r.status === 200);
    const ids = new Set(ok.map((r) => r.body.id));
    const after = snapshot(inst);
    check(inst.name + ': twenty copies at once produce one credential, one roster row and one welcome mail', ok.length >= 1 && ids.size === 1 && rs.every((r) => r.status === 200 || r.status === 503) && after.postOffice === before.postOffice + 1 && after.mail === before.mail + 1, { statuses: rs.map((r) => r.status), ids: [...ids], before, after });
  }

  // other gates are not weakened
  const noClass = await issue(inst, { ownerPublicKey: owner.publicKey, assetClass: 'atlas.not.a.class' });
  check(inst.name + ': an unknown class is still refused', noClass.status === 400, noClass);
  const badge = await issue(inst, { ownerPublicKey: owner.publicKey, assetClass: 'atlas.badge' });
  check(inst.name + ': a class outside the three is not gated', badge.status === 200, badge);
  const studio = await issue(inst, { ownerPublicKey: owner.publicKey, assetClass: 'atlas.demo.studio.collectible' });
  check(inst.name + ': a restricted class is still refused', studio.status === 403 && studio.body.code === 'studio-authorization-required', studio);
  const noOwner = await issue(inst, { assetClass: POST_OFFICE });
  check(inst.name + ': a request without a recipient is still refused', noOwner.status === 400, noOwner);
  const q2 = await signedBody(inst, owner, owner, POST_OFFICE);
  q2.body.quantity = 2;
  const q = await issue(inst, q2.body);
  check(inst.name + ': a quantity other than 1 is still refused', q.status === 400, q);

  // a retry of a completed issuance needs no fresh signature; a new request with an old signature does
  {
    const k = await newKey();
    const aged = await signedBody(inst, k, k, POST_OFFICE, { issuedAt: new Date(Date.now() - 100000).toISOString() });
    const a = await issue(inst, aged.body);
    check(inst.name + ': a request signed 100 seconds ago is still fresh', a.status === 200, a);
    inst.aged = { body: aged.body, id: a.body.id, k };
  }
}

async function agedRetry(inst) {
  const before = snapshot(inst);
  const r = await issue(inst, inst.aged.body);
  check(inst.name + ': after the window has passed, a retry of the completed request is answered with the same credential', r.status === 200 && r.body.id === inst.aged.id, r);
  check(inst.name + ': ...and writes nothing', same(before, snapshot(inst)));
  const k = inst.aged.k;
  const fresh = await signedBody(inst, k, k, 'atlas.membership', { issuedAt: new Date(Date.now() - 130000).toISOString() });
  await refusedWithoutTrace(inst, 'a different request signed over two minutes ago', fresh.body, 401, 'stale-request');
}

async function strictSuite(inst) {
  console.log('--- ' + inst.name + ' (strict: origin check on, default mode) ---');
  const caps = await getJson(inst.base, '/atlas/capabilities');
  check(inst.name + ': the default mode is accept', caps.ownerProof && caps.ownerProof.mode === 'accept', caps.ownerProof);
  const owner = await newKey();
  const foreign = { Origin: 'https://page.example.test' };
  const own = { Origin: inst.base };
  await refusedWithoutTrace(inst, 'a valid signed request from another site\'s page', (await signedBody(inst, owner, owner, POST_OFFICE)).body, 403, 'mint-origin-refused', foreign);
  await refusedWithoutTrace(inst, 'a valid signed request with no origin', (await signedBody(inst, owner, owner, POST_OFFICE)).body, 403, 'mint-origin-refused');
  const ok = await issue(inst, (await signedBody(inst, owner, owner, POST_OFFICE)).body, own);
  check(inst.name + ': the same request from the domain\'s own page is issued', ok.status === 200, ok);
  const ext = await issue(inst, (await signedBody(inst, owner, owner, 'atlas.membership')).body, { Origin: 'chrome-extension://abcdefghijklmnop' });
  check(inst.name + ': ...and from a wallet extension', ext.status === 200, ext);
}

(async () => {
  try {
    // PHP and Node, each: accept, require, a second require (for cross-domain), and a strict pair
    const [nodeAccept, nodeReq, nodeReq2, nodeStrict] = await Promise.all([
      startNode('node-accept', 8231, 'accept'), startNode('node-require', 8232, 'require'), startNode('node-require-2', 8233, 'require'), startNode('node-strict', 8234, null, true)]);
    const [phpAccept, phpReq, phpReq2, phpStrict, phpBare] = await Promise.all([
      startPhp('php-accept', 8241, 'accept'), startPhp('php-require', 8242, 'require'), startPhp('php-require-2', 8243, 'require'), startPhp('php-strict', 8244, null, true),
      startPhp('php-without-library', 8245, 'require', false, { withoutProofLibrary: true })]);

    const bare = await getJson(phpBare.base, '/atlas/capabilities');
    check('php: a bundle without lib/owner-proof.php does not advertise the check', bare.ownerProof === undefined && Array.isArray(bare.requestIds.operations), bare);

    await Promise.all([acceptSuite(nodeAccept), acceptSuite(phpAccept)]);
    await requireSuite(nodeReq, nodeReq2);
    await requireSuite(phpReq, phpReq2);
    // cross-implementation: a request for the PHP issuer's domain is refused by the Node issuer and the reverse
    {
      const k = await newKey();
      const forPhp = await signedBody(phpReq, k, k, POST_OFFICE);
      const forNode = await signedBody(nodeReq, k, k, POST_OFFICE);
      await refusedWithoutTrace(nodeReq, "a request signed for the PHP issuer's domain", forPhp.body, 403, 'owner-authorization-required');
      await refusedWithoutTrace(phpReq, "a request signed for the Node issuer's domain", forNode.body, 403, 'owner-authorization-required');
    }
    await Promise.all([strictSuite(nodeStrict), strictSuite(phpStrict)]);

    console.log('--- waiting for part of the two-minute window to pass ---');
    await sleep(23000);
    await agedRetry(nodeReq);
    await agedRetry(phpReq);
  } catch (err) {
    failures++;
    console.log('FAIL unexpected error :: ' + (err && err.stack ? err.stack : err));
  } finally {
    stopAll();
  }
  console.log(failures ? '\nFAILED: ' + failures : '\nALL OWNER-PROOF ISSUER CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})();
