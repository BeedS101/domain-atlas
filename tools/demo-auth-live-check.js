#!/usr/bin/env node
// Checks the self-serve /atlas/demo/* authorization on a deployed issuer over HTTP.
//
//   node tools/demo-auth-live-check.js https://example.com                 probe only, changes nothing
//   node tools/demo-auth-live-check.js https://example.com --mutating      also mint and act on demo credentials
//   node tools/demo-auth-live-check.js https://example.com --hold-for-admin state.json
//   node tools/demo-auth-live-check.js https://example.com --check-admin-lock state.json
//   node tools/demo-auth-live-check.js https://example.com --audit         read-only, before deploying
//
// --audit: lists what the old, unauthenticated demo routes may have left behind, from the public
// suspension and revocation lists only: every 'demo-fraud-report' suspension (the old demo suspend;
// on the old code it could hold any credential of a demo-suspendable class, including Alpha and Beta
// Dollars) and every revocation with reason 'clawback', 'demo-self-serve' or 'fulfilled'. Review
// these before and after deploying; the new demo routes cannot lift an old demo suspension on a
// real currency, only the admin panel can.
//
// Probe (default): every request is one the new code refuses before reading or writing any state,
// so nothing is created, suspended or revoked. Detects whether the new routes are deployed and that
// real currencies and unsigned requests are refused.
//
// --mutating: mints throw-away demo credentials (a recovery token, a funds block, a self-serve
// warranty certificate, a login badge, a cafeteria sandwich) for throw-away keys and checks who may
// act on them: unsigned, holder- and owner-signed requests are refused where the demo authority is
// required, and only the owner redeems or revokes. Adds a few revocation entries for those
// credentials. Snapshots /.well-known/atlas-suspensions.json first and checks afterwards that no
// suspension that existed before was removed or changed (apart from ones that expired on their own).
//
// --hold-for-admin / --check-admin-lock: an operator-suspension check in two steps. The first mints
// a demo funds block and saves it with its demo authority key to state.json (keep it private; delete
// it afterwards). Suspend that id in the admin panel, then run --check-admin-lock: demo suspend,
// unsuspend and clawback must all answer 409 and the operator suspension must be unchanged. Lift it in
// the admin panel when done. A trade lock takes the same refusal path in the code.
//
// Exit code 0 when every check passes, 1 otherwise.
'use strict';
const fs = require('fs');
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;

const args = process.argv.slice(2);
const base = (args.find((a) => /^https?:\/\//.test(a)) || '').replace(/\/+$/, '');
const valueOf = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
if (!base) {
  console.error('usage: node tools/demo-auth-live-check.js <base url> [--mutating | --hold-for-admin file | --check-admin-lock file]');
  process.exit(2);
}

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || !detail ? '' : '\n     ' + detail));
};
const show = (r) => JSON.stringify({ status: r.status, body: r.body }).slice(0, 300);

const b64url = (buf) => Buffer.from(buf).toString('base64url');
function canonicalize(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonicalize(v[k])).join(',') + '}';
}
async function genIdentity() {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return { kp, publicKey: b64url(await subtle.exportKey('raw', kp.publicKey)) };
}
async function exportIdentity(id) { return { publicKey: id.publicKey, jwk: await subtle.exportKey('jwk', id.kp.privateKey) }; }
async function importIdentity(saved) {
  const privateKey = await subtle.importKey('jwk', saved.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  return { kp: { privateKey }, publicKey: saved.publicKey };
}
async function sign(id, payload) {
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, id.kp.privateKey, new TextEncoder().encode(canonicalize(payload)));
  return { signerRole: 'raw-ecdsa', publicKey: id.publicKey, signature: b64url(sig) };
}
async function post(route, body) {
  const r = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const text = await r.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (e) { parsed = { raw: text.slice(0, 200) }; }
  return { status: r.status, body: parsed };
}
async function getJson(route) {
  const r = await fetch(base + route + (route.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' });
  if (r.status === 404) return null;
  return r.json();
}
const suspensions = async () => ((await getJson('/.well-known/atlas-suspensions.json')) || { suspended: [] }).suspended || [];
const revokedIds = async () => new Set((((await getJson('/.well-known/atlas-revocations.json')) || {}).revoked || []).map((e) => e.id));
const refused = (r) => r.status === 403 && r.body && r.body.code === 'demo-authorization-required';

// A demo request, bound to the domain the credential names.
async function demoRequest(signer, action, credential, fields, overrides) {
  const payload = Object.assign({ purpose: 'atlas.demo.request/1', action, credentialId: credential.id,
    domain: credential.issuer.domain, issuedAt: new Date().toISOString() }, fields || {}, overrides || {});
  return { payload, proof: await sign(signer, payload) };
}
const mintDemo = (owner, authority, assetClass, amount) => post('/atlas/demo/clawback/mint', {
  ownerPublicKey: owner.publicKey, authorityPublicKey: authority.publicKey, assetClass, ...(amount ? { amount } : {}) });

async function probe() {
  console.log('PROBE (changes nothing)');
  const a = await genIdentity();
  let r = await mintDemo(a, a, 'atlas.demo.clawback.token');
  check('the demo mint route is deployed and refuses an authority that is the owner', r.status === 400 && /different key/.test(r.body.error || ''), show(r));
  // A non-object properties value is refused by both the old and the new route, so nothing is minted either way.
  r = await post('/atlas/demo/warranty/mint', { ownerPublicKey: a.publicKey, properties: 'probe' });
  check('the warranty mint requires a demo authority (new version)', r.status === 400 && /authorityPublicKey/.test(r.body.error || ''), show(r));
  const fake = (cls) => ({ credential: 'domain-atlas-asset/1.0', id: 'urn:atlas:asset:00000000-0000-4000-8000-000000000000',
    asset: { class: cls, properties: {} }, issuer: { domain: 'not-this-domain.invalid' }, owner: { publicKey: a.publicKey }, quantity: 1 });
  for (const route of ['/atlas/demo/clawback/suspend', '/atlas/demo/clawback/unsuspend', '/atlas/demo/clawback/clawback']) {
    for (const cls of ['atlas.currency.alpha', 'atlas.currency.beta', 'atlas.currency.reserve']) {
      r = await post(route, { credential: fake(cls), toPublicKey: a.publicKey });
      check(route + ' refuses ' + cls, r.status === 400 && /only acts on/.test(r.body.error || ''), show(r));
    }
  }
  r = await post('/atlas/demo/warranty/stamp-sale', { credential: fake('atlas.demo.warranty.certificate'), properties: {} });
  check('stamp-sale refuses the factory warranty class', r.status === 400 && /selfserve/.test(r.body.error || ''), show(r));
  for (const route of ['/atlas/asset/split', '/atlas/asset/consolidate', '/atlas/convert']) {
    r = await post(route, {});
    check(route + ' is still disabled', r.status === 403 && r.body.code === 'owner-authorization-required', show(r));
  }
}

async function mutating() {
  console.log('MUTATING (throw-away demo credentials only)');
  const before = await suspensions();
  const alice = await genIdentity(), mallory = await genIdentity(), authority = await genIdentity();

  let r = await mintDemo(alice, authority, 'atlas.demo.clawback.token');
  check('mint a demo token with a demo authority', r.status === 200 && r.body.asset.properties['atlas.demo.authority'] === authority.publicKey, show(r));
  if (r.status !== 200) return;
  const token = r.body;
  for (const [label, signer] of [['no signature', null], ['the holder', mallory], ['the owner', alice]]) {
    const body = { credential: token };
    if (signer) body.intent = await demoRequest(signer, 'demo-suspend', token);
    r = await post('/atlas/demo/clawback/suspend', body);
    check('suspend refuses ' + label, refused(r), show(r));
  }
  r = await post('/atlas/demo/clawback/suspend', { credential: token, intent: await demoRequest(authority, 'demo-suspend', token, null, { issuedAt: new Date(Date.now() - 600000).toISOString() }) });
  check('suspend refuses an old request', refused(r), show(r));
  r = await post('/atlas/demo/clawback/suspend', { credential: token, intent: await demoRequest(authority, 'demo-suspend', token) });
  check('the demo authority suspends', r.status === 200, show(r));
  r = await post('/atlas/demo/clawback/suspend', { credential: token, intent: await demoRequest(authority, 'demo-suspend', token) });
  check('a second suspend is refused', r.status === 409, show(r));
  r = await post('/atlas/demo/clawback/unsuspend', { credential: token, intent: await demoRequest(alice, 'demo-unsuspend', token) });
  check('the owner cannot lift it', refused(r), show(r));
  r = await post('/atlas/demo/clawback/unsuspend', { credential: token, intent: await demoRequest(authority, 'demo-unsuspend', token) });
  check('the demo authority lifts its own suspension', r.status === 200 && r.body.wasSuspended === true, show(r));
  r = await post('/atlas/demo/clawback/clawback', { credential: token, toPublicKey: mallory.publicKey, intent: await demoRequest(mallory, 'demo-clawback', token, { toPublicKey: mallory.publicKey }) });
  check('the holder cannot claw back', refused(r), show(r));
  r = await post('/atlas/demo/clawback/clawback', { credential: token, toPublicKey: mallory.publicKey,
    intent: await demoRequest(authority, 'demo-clawback', token, { toPublicKey: mallory.publicKey }) });
  check('the demo authority claws back', r.status === 200 && (await revokedIds()).has(token.id), show(r));

  r = await mintDemo(alice, authority, 'atlas.demo.clawback.funds', 15000);
  check('mint a demo funds block', r.status === 200 && r.body.asset.properties['com.example.amount'] === 15000, show(r));
  if (r.status === 200) {
    const p = { credentialId: r.body.id, recipientPublicKey: mallory.publicKey, action: 'transfer' };
    const t = await post('/atlas/asset/transfer', { credential: r.body, recipientPublicKey: mallory.publicKey, intent: { payload: p, proof: await sign(alice, p) } });
    check('the owner moves it by an ordinary signed transfer', t.status === 200, show(t));
    if (t.status === 200) {
      const stolen = t.body.credential;
      await post('/atlas/demo/clawback/suspend', { credential: stolen, intent: await demoRequest(authority, 'demo-suspend', stolen) });
      r = await post('/atlas/demo/clawback/clawback', { credential: stolen, toPublicKey: alice.publicKey, intent: await demoRequest(authority, 'demo-clawback', stolen, { toPublicKey: alice.publicKey }) });
      check('the demo authority recovers it to the bank', r.status === 200 && r.body.newCredential.owner.publicKey === alice.publicKey, show(r));
    }
  }

  r = await post('/atlas/demo/warranty/mint', { ownerPublicKey: alice.publicKey, authorityPublicKey: authority.publicKey, properties: { 'com.example.serialNumber': 'LIVE-CHECK' } });
  check('mint a self-serve warranty certificate', r.status === 200 && r.body.asset.class === 'atlas.demo.warranty.selfserve', show(r));
  if (r.status === 200) {
    const cert = r.body;
    const sale = { 'com.example.saleDate': new Date().toISOString().slice(0, 10), 'com.example.warrantyMonths': 12, 'com.example.retailer': 'Live Check' };
    r = await post('/atlas/demo/warranty/stamp-sale', { credential: cert, properties: sale, intent: await demoRequest(alice, 'demo-stamp-sale', cert, { properties: sale }) });
    check('the owner cannot stamp the sale', refused(r), show(r));
    r = await post('/atlas/demo/warranty/stamp-sale', { credential: cert, properties: sale, intent: await demoRequest(authority, 'demo-stamp-sale', cert, { properties: sale }) });
    check('the demo authority stamps the sale', r.status === 200, show(r));
  }

  for (const [cls, route, action] of [['atlas.demo.login.badge', '/atlas/demo/login/revoke', 'demo-login-revoke'],
    ['atlas.demo.cafeteria.sandwich', '/atlas/demo/cafeteria/fulfill', 'demo-fulfill']]) {
    const issued = await post('/atlas/asset/issue', { ownerPublicKey: alice.publicKey, assetClass: cls });
    if (issued.status !== 200) { check('issue a ' + cls + ' for the check', false, show(issued)); continue; }
    const item = issued.body;
    r = await post(route, { credential: item });
    check(route + ' refuses no signature', refused(r), show(r));
    r = await post(route, { credential: item, intent: await demoRequest(mallory, action, item) });
    check(route + ' refuses someone else', refused(r), show(r));
    r = await post(route, { credential: item, intent: await demoRequest(alice, action, item) });
    check(route + ' accepts the owner', r.status === 200, show(r));
  }

  const after = await suspensions();
  const now = Date.now();
  const lost = before.filter((s) => (!s.expiresAt || Date.parse(s.expiresAt) > now)
    && !after.some((x) => x.id === s.id && x.reason === s.reason && x.expiresAt === s.expiresAt && x.suspendedAt === s.suspendedAt));
  check('every suspension that existed before is still there, unchanged (' + before.length + ' before)', lost.length === 0, JSON.stringify(lost).slice(0, 300));
}

async function audit() {
  console.log('AUDIT (read-only)');
  const susp = await suspensions();
  const demo = susp.filter((s) => s.reason === 'demo-fraud-report');
  console.log(susp.length + ' suspension(s) in effect; by reason:');
  const byReason = {};
  for (const s of susp) { const k = /^trade-lock:/.test(s.reason || '') ? 'trade-lock:*' : (s.reason || '(none)'); byReason[k] = (byReason[k] || 0) + 1; }
  for (const [k, n] of Object.entries(byReason)) console.log('  ' + k + ': ' + n);
  for (const s of demo) console.log('  demo-fraud-report  ' + s.id + '  since ' + s.suspendedAt);
  const rev = ((await getJson('/.well-known/atlas-revocations.json')) || {}).revoked || [];
  console.log(rev.length + ' revocation entries; those the old demo routes could write:');
  for (const reason of ['clawback', 'demo-self-serve', 'fulfilled']) {
    const hits = rev.filter((e) => e.reason === reason);
    console.log('  ' + reason + ': ' + hits.length);
    for (const e of hits.slice(-20)) console.log('    ' + e.id + (e.revokedAt ? '  ' + e.revokedAt : ''));
  }
  console.log('Revocation entries do not name the class; look an id up in the admin panel or the issuer logs.');
}

async function holdForAdmin(file) {
  const owner = await genIdentity(), authority = await genIdentity();
  const r = await mintDemo(owner, authority, 'atlas.demo.clawback.funds', 100);
  check('mint a demo funds block to hold under an operator suspension', r.status === 200, show(r));
  if (r.status !== 200) return;
  fs.writeFileSync(file, JSON.stringify({ base, credential: r.body, authority: await exportIdentity(authority) }, null, 2), { mode: 0o600 });
  console.log('\nNow suspend this id in the admin panel, then run --check-admin-lock ' + file + ':\n  ' + r.body.id);
}

async function checkAdminLock(file) {
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  const credential = state.credential, authority = await importIdentity(state.authority);
  const lockBefore = (await suspensions()).find((s) => s.id === credential.id);
  check('the operator suspension is in place', !!lockBefore && lockBefore.reason !== 'demo-fraud-report', JSON.stringify(lockBefore || null));
  if (!lockBefore) return;
  const target = (await genIdentity()).publicKey;
  for (const [route, action, fields] of [['/atlas/demo/clawback/suspend', 'demo-suspend', null], ['/atlas/demo/clawback/unsuspend', 'demo-unsuspend', null],
    ['/atlas/demo/clawback/clawback', 'demo-clawback', { toPublicKey: target }]]) {
    const r = await post(route, { credential, ...(fields || {}), intent: await demoRequest(authority, action, credential, fields) });
    check(route + ' leaves the operator suspension alone (409)', r.status === 409, show(r));
  }
  const lockAfter = (await suspensions()).find((s) => s.id === credential.id);
  check('the operator suspension is unchanged', canonicalize(lockAfter || null) === canonicalize(lockBefore), JSON.stringify(lockAfter || null));
  check('the funds block was not revoked', !(await revokedIds()).has(credential.id));
  console.log('\nLift the suspension in the admin panel and delete ' + file + '.');
}

(async () => {
  console.log('Target: ' + base);
  if (args.includes('--audit')) await audit();
  else if (valueOf('--hold-for-admin')) await holdForAdmin(valueOf('--hold-for-admin'));
  else if (valueOf('--check-admin-lock')) await checkAdminLock(valueOf('--check-admin-lock'));
  else {
    await probe();
    if (args.includes('--mutating')) await mutating();
  }
  console.log(failures ? '\n' + failures + ' CHECK(S) FAILED' : '\nALL CHECKS PASSED');
  process.exitCode = failures ? 1 : 0;
})().catch((err) => { console.error('ERROR:', err.message); process.exitCode = 1; });
