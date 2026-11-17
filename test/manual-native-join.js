// Signed membership Join from a native app (a request with no Origin header), against real issuers: the Node issuer and
// the PHP issuer, each with the origin check left on, in accept, require and off owner-proof modes.
//
// The request is built the way the Android wallet builds it: a raw P-256 key, the exact issue payload signed with a
// low-S signature, and a body of { ownerPublicKey, assetClass, requestId, intent } sent with no Origin header.
// Every refusal is checked for side effects: no credential, roster row, welcome mail, replay record or journal entry.
//
// Nothing here contacts a live domain: every issuer is a throw-away local instance with its own state.
// Run: node test/manual-native-join.js
'use strict';
const { webcrypto } = require('crypto');
const http = require('http');
const { subtle } = webcrypto;
const proofLib = require('../issuer-server/lib-owner-proof');
const { startNode, startPhp, snapshot, readJson, mailFor, rosterTotal, stopAll } = require('./owner-proof-lib');

const MEMBERSHIP = ['atlas.postoffice.membership', 'atlas.tradingstation.membership', 'atlas.membership'];
const POST_OFFICE = 'atlas.postoffice.membership';
const DAY = 24 * 3600 * 1000;
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const canonicalize = proofLib.canonicalize;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const P256_ORDER = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');

let failures = 0;
function check(name, ok, detail) {
  if (ok) console.log('PASS ' + name);
  else { failures++; console.log('FAIL ' + name + (detail !== undefined ? ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}

async function newKey() {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return { pair, publicKey: b64u(await subtle.exportKey('raw', pair.publicKey)) };
}
// The wallet signs with a low-S compact signature; WebCrypto does not normalise, so do it here.
async function sign(key, payload) {
  const raw = Buffer.from(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.pair.privateKey, new TextEncoder().encode(canonicalize(payload))));
  let s = BigInt('0x' + raw.subarray(32).toString('hex'));
  if (s > P256_ORDER / 2n) s = P256_ORDER - s;
  const low = Buffer.concat([raw.subarray(0, 32), Buffer.from(s.toString(16).padStart(64, '0'), 'hex')]);
  return { signerRole: 'raw-ecdsa', publicKey: key.publicKey, signature: b64u(low) };
}
const rid = () => b64u(webcrypto.getRandomValues(new Uint8Array(18)));

function post(base, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + urlPath);
    const data = JSON.stringify(body);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: Object.assign({ Accept: 'application/json', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, headers || {}) }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => { let json = {}; try { json = JSON.parse(text); } catch (e) { json = { raw: text }; } resolve({ status: res.statusCode, body: json }); });
    });
    req.on('error', reject);
    req.end(data);
  });
}
const issue = (inst, body, headers) => post(inst.base, '/atlas/asset/issue', body, headers);

async function signedBody(inst, signer, owner, assetClass, over, payloadOver) {
  const f = Object.assign({ assetClass, domain: inst.domain, issuedAt: new Date().toISOString(), ownerPublicKey: owner.publicKey, requestId: rid() }, over || {});
  const payload = Object.assign(proofLib.issuePayload(f), payloadOver || {});
  return { body: { ownerPublicKey: f.ownerPublicKey, assetClass, requestId: f.requestId, intent: { payload, proof: await sign(signer, payload) } }, fields: f };
}
const clone = (o) => JSON.parse(JSON.stringify(o));

async function refused(inst, name, body, status, code, headers) {
  const before = snapshot(inst);
  const r = await issue(inst, body, headers);
  const after = snapshot(inst);
  check(inst.name + ': ' + name + ' -> ' + status + ' ' + code, r.status === status && r.body.code === code, { status: r.status, body: r.body });
  check(inst.name + ': ' + name + ' leaves no trace', same(before, after), { before, after });
  return r;
}

async function suite(inst, other) {
  console.log('--- ' + inst.name + ' (origin check on, owner proof ' + inst.mode + ') ---');
  const owner = await newKey(), victim = await newKey(), attacker = await newKey();

  // a native Join for each of the three classes
  for (const cls of MEMBERSHIP) {
    const k = await newKey();
    const g = await signedBody(inst, k, k, cls);
    const before = snapshot(inst);
    const r = await issue(inst, g.body);
    const after = snapshot(inst);
    check(inst.name + ': native Join for ' + cls + ' is issued to the signing key', r.status === 200 && r.body.owner.publicKey === k.publicKey && r.body.asset.class === cls && r.body.issuer.domain === inst.domain, r);
    check(inst.name + ': ...with one roster row and one welcome mail', rosterTotal(after) === rosterTotal(before) + 1 && after.mail === before.mail + 1 && mailFor(inst, r.body.id) === 1, { before, after });
    const again = await issue(inst, g.body);
    check(inst.name + ': ...and the same saved request sent again returns the same credential and writes nothing more', again.status === 200 && again.body.id === r.body.id && same(after, snapshot(inst)), again);
    const other = await signedBody(inst, k, k, cls === POST_OFFICE ? 'atlas.membership' : POST_OFFICE, { requestId: g.fields.requestId });
    const conflict = await issue(inst, other.body);
    check(inst.name + ': ...and the same request id for another class is a conflict', conflict.status === 409 && conflict.body.code === 'request-id-conflict', conflict);
  }

  // an unsigned request or a merely present intent never passes
  for (const cls of MEMBERSHIP) {
    await refused(inst, 'an unsigned origin-less request for ' + cls, { ownerPublicKey: victim.publicKey, assetClass: cls }, 403, 'mint-origin-refused');
    await refused(inst, 'an origin-less request with intent null for ' + cls, { ownerPublicKey: victim.publicKey, assetClass: cls, requestId: rid(), intent: null }, 403, 'mint-origin-refused');
  }
  for (const [label, intent] of [['a string', 'yes'], ['an array', []], ['a number', 7], ['an empty object', {}], ['true', true]]) {
    await refused(inst, 'an origin-less intent that is ' + label, { ownerPublicKey: victim.publicKey, assetClass: POST_OFFICE, requestId: rid(), intent }, 403, 'owner-authorization-required');
  }
  await refused(inst, 'an intent with a payload and no proof', { ownerPublicKey: victim.publicKey, assetClass: POST_OFFICE, requestId: rid(), intent: { payload: {} } }, 403, 'owner-authorization-required');

  // malformed or wrong proofs
  const good = await signedBody(inst, owner, owner, POST_OFFICE);
  const flipped = clone(good.body);
  const sig = flipped.intent.proof.signature;
  flipped.intent.proof.signature = sig.slice(0, -3) + (sig.slice(-3) === 'AAA' ? 'BBB' : 'AAA');
  await refused(inst, 'a changed signature', flipped, 403, 'owner-signature-invalid');
  await refused(inst, 'the attacker signs for the victim', (await signedBody(inst, attacker, victim, POST_OFFICE)).body, 403, 'not-owner');
  {
    const g = await signedBody(inst, attacker, attacker, POST_OFFICE);
    const swapped = clone(g.body); swapped.ownerPublicKey = victim.publicKey;
    await refused(inst, "the attacker's own request aimed at the victim", swapped, 403, 'owner-authorization-required');
    const forged = clone(g.body);
    forged.intent.proof.publicKey = victim.publicKey; forged.ownerPublicKey = victim.publicKey; forged.intent.payload.ownerPublicKey = victim.publicKey;
    await refused(inst, "the attacker's signature under the victim's name", forged, 403, 'owner-signature-invalid');
  }
  await refused(inst, 'a request signed for another domain', (await signedBody(inst, owner, owner, POST_OFFICE, {}, { domain: 'elsewhere.example.test' })).body, 403, 'owner-authorization-required');
  await refused(inst, "a request signed for the other issuer's domain", (await signedBody(other, owner, owner, POST_OFFICE)).body, 403, 'owner-authorization-required');
  {
    const mem = await signedBody(inst, owner, owner, 'atlas.membership');
    const asTrading = clone(mem.body); asTrading.assetClass = 'atlas.tradingstation.membership';
    await refused(inst, 'a request signed for one class presented for another', asTrading, 403, 'owner-authorization-required');
    const otherId = clone(mem.body); otherId.requestId = rid();
    await refused(inst, 'a signed request presented under another request id', otherId, 403, 'owner-authorization-required');
  }
  await refused(inst, 'a signed request without a requestId', (() => { const b = clone(good.body); delete b.requestId; return b; })(), 400, 'request-id-required');
  await refused(inst, 'a quantity of 2 in the signed request', (await signedBody(inst, owner, owner, POST_OFFICE, {}, { quantity: 2 })).body, 403, 'owner-authorization-required');
  await refused(inst, 'an extra field in the signed request', (await signedBody(inst, owner, owner, POST_OFFICE, {}, { note: 'x' })).body, 403, 'owner-authorization-required');
  await refused(inst, 'a passkey-style proof that does not verify', (() => { const g = clone(good.body); g.intent.proof = { signerRole: 'webauthn', publicKey: owner.publicKey, clientDataJSON: 'e30', authenticatorData: 'AA', signature: 'AA' }; return g; })(), 403, 'owner-signature-invalid');

  // timestamps: a saved request may be old, never ahead of the clock, and never older than the native window
  await refused(inst, 'a request signed three minutes ahead', (await signedBody(inst, owner, owner, POST_OFFICE, { issuedAt: new Date(Date.now() + 180000).toISOString() })).body, 401, 'stale-request');
  await refused(inst, 'a request signed 31 days ago', (await signedBody(inst, owner, owner, POST_OFFICE, { issuedAt: new Date(Date.now() - 31 * DAY).toISOString() })).body, 401, 'stale-request');
  await refused(inst, 'a request with an impossible issue time', (await signedBody(inst, owner, owner, POST_OFFICE, { issuedAt: '2026-02-31T00:00:00.000Z' })).body, 403, 'owner-authorization-required');
  for (const [label, ms] of [['ten minutes', 600000], ['two days', 2 * DAY], ['29 days', 29 * DAY]]) {
    const k = await newKey();
    const g = await signedBody(inst, k, k, POST_OFFICE, { issuedAt: new Date(Date.now() - ms).toISOString() });
    const r = await issue(inst, g.body);
    check(inst.name + ': a saved request signed ' + label + ' ago is issued', r.status === 200 && r.body.owner.publicKey === k.publicKey, r);
    const again = await issue(inst, g.body);
    check(inst.name + ': ...and sent again returns the same credential', again.status === 200 && again.body.id === r.body.id, again);
  }

  // other classes are not opened to origin-less requests, signed or not
  for (const cls of ['atlas.badge', 'atlas.demo.governance.membership', 'atlas.element.iron']) {
    const g = await signedBody(inst, owner, owner, cls);
    await refused(inst, 'a signed origin-less request for ' + cls, g.body, 403, 'mint-origin-refused');
    await refused(inst, 'an unsigned origin-less request for ' + cls, { ownerPublicKey: owner.publicKey, assetClass: cls, quantity: 1 }, 403, 'mint-origin-refused');
  }
  const studio = await issue(inst, { ownerPublicKey: owner.publicKey, assetClass: 'atlas.demo.studio.collectible' });
  check(inst.name + ': a restricted class is still refused', studio.status === 403 && studio.body.code === 'studio-authorization-required', studio);

  // an Origin header keeps the browser rules: another site's page, or an opaque origin, is refused even with a good proof
  const own = { Origin: inst.base };
  for (const [label, origin] of [['another site', 'https://page.example.test'], ['an opaque origin', 'null'], ['an empty origin', ''], ['a custom scheme', 'app://localhost']]) {
    await refused(inst, 'a valid signed request with Origin from ' + label, (await signedBody(inst, owner, owner, POST_OFFICE)).body, 403, 'mint-origin-refused', { Origin: origin });
  }
  {
    const k = await newKey();
    const ok = await issue(inst, (await signedBody(inst, k, k, POST_OFFICE)).body, own);
    check(inst.name + ': a signed request from the domain\'s own page is issued', ok.status === 200, ok);
    const ext = await issue(inst, (await signedBody(inst, k, k, 'atlas.membership')).body, { Origin: 'chrome-extension://abcdefghijklmnop' });
    check(inst.name + ': ...and from a wallet extension', ext.status === 200, ext);
    // browser pages keep the two-minute window (an issuer in 'off' mode does not look at the proof for a page at all)
    if (inst.mode !== 'off') {
      await refused(inst, 'a page request signed three minutes ago', (await signedBody(inst, k, k, POST_OFFICE, { issuedAt: new Date(Date.now() - 180000).toISOString() })).body, 401, 'stale-request', own);
      const old = await signedBody(inst, k, k, 'atlas.tradingstation.membership', { issuedAt: new Date(Date.now() - 2 * DAY).toISOString() });
      await refused(inst, 'a page request signed two days ago', old.body, 401, 'stale-request', own);
    }
    check(inst.name + ': a fresh request from the page is issued', (await issue(inst, (await signedBody(inst, k, k, 'atlas.tradingstation.membership')).body, own)).status === 200);
  }
  if (inst.mode === 'accept') {
    const k = await newKey();
    const r = await issue(inst, { ownerPublicKey: k.publicKey, assetClass: POST_OFFICE }, own);
    check(inst.name + ': accept still serves an unsigned request from the domain\'s own page', r.status === 200, r);
  }
  if (inst.mode === 'require') {
    await refused(inst, 'require still refuses an unsigned request from the domain\'s own page', { ownerPublicKey: victim.publicKey, assetClass: POST_OFFICE }, 403, 'owner-authorization-required', own);
  }

  // the readiness counts describe wallets that reach an issuer through a page; hostile origin-less requests are not in them
  if (inst.mode === 'accept') {
    const stats = readJson(inst.statsFile, null);
    const c = stats && stats.classes && stats.classes[POST_OFFICE];
    check(inst.name + ': native refusals are not counted as refused wallet requests', c && c.unsigned === 1 && same(stats.refusedByCode, { 'stale-request': 2 }), stats);
  }

  // many copies of one saved request at once: one credential
  {
    const k = await newKey();
    const g = await signedBody(inst, k, k, POST_OFFICE);
    const before = snapshot(inst);
    const rs = await Promise.all(Array.from({ length: 20 }, () => issue(inst, g.body)));
    const ok = rs.filter((r) => r.status === 200);
    const ids = new Set(ok.map((r) => r.body.id));
    const after = snapshot(inst);
    check(inst.name + ': twenty copies of one saved request produce one credential, one roster row and one welcome mail', ok.length >= 1 && ids.size === 1 && rs.every((r) => r.status === 200 || r.status === 503) && after.postOffice === before.postOffice + 1 && after.mail === before.mail + 1, { statuses: rs.map((r) => r.status), before, after });
  }
}

// The widened age applies to the past only; a request ahead of the clock keeps the standard window.
function windowUnits() {
  const { execFileSync } = require('child_process');
  const now = 1800000000000, W = 30 * DAY;
  const node = (issued, past) => proofLib.staleProblem(issued, now, past) === null;
  check('node: the standard window is unchanged', node(now - 120000) && !node(now - 120001) && node(now + 120000) && !node(now + 120001));
  check('node: the native window widens the past only', node(now - W, W) && !node(now - W - 1, W) && !node(now + 120001, W) && node(now - 5000, W));
  const php = execFileSync('php', ['-r', 'require "' + __dirname + '/../issuer-php/lib/owner-proof.php"; $n=' + now + ';$W=' + W + ';' +
    'echo json_encode([atlas_owner_proof_stale($n-120000,$n)===null,atlas_owner_proof_stale($n-120001,$n)===null,atlas_owner_proof_stale($n+120001,$n)===null,' +
    'atlas_owner_proof_stale($n-$W,$n,$W)===null,atlas_owner_proof_stale($n-$W-1,$n,$W)===null,atlas_owner_proof_stale($n+120001,$n,$W)===null]);'], { encoding: 'utf8' });
  check('php: the same windows', php === '[true,false,false,true,false,false]', php);
}

(async () => {
  try {
    windowUnits();
    const nodes = await Promise.all([startNode('node-accept', 8251, 'accept', true), startNode('node-require', 8252, 'require', true), startNode('node-off', 8253, 'off', true), startNode('node-other', 8254, 'require', true)]);
    const phps = await Promise.all([startPhp('php-accept', 8261, 'accept', true), startPhp('php-require', 8262, 'require', true), startPhp('php-off', 8263, 'off', true), startPhp('php-other', 8264, 'require', true)]);
    nodes.slice(0, 3).forEach((n, i) => { n.mode = ['accept', 'require', 'off'][i]; });
    phps.slice(0, 3).forEach((n, i) => { n.mode = ['accept', 'require', 'off'][i]; });
    for (let i = 0; i < 3; i++) {
      await suite(nodes[i], phps[3]);
      await suite(phps[i], nodes[3]);
    }
  } catch (err) {
    failures++;
    console.log('FAIL unexpected error :: ' + (err && err.stack ? err.stack : err));
  } finally {
    stopAll();
  }
  console.log(failures ? '\nFAILED: ' + failures : '\nALL NATIVE JOIN CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})();
