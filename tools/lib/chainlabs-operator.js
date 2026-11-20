// Signing and sending operator requests to a chain labs domain (chain-labs/lib/operator.php). Used by tools/chainlabs-operator.js and by the tests.
//
// A request is { payload, proof }. The payload is
//   { type: 'atlas.chainlabs.operator', v: 1, adminAuth: { action, domain, method: 'POST', issuedAt, expiresAt, nonce [, repeat] }, request: { ...arguments } }
// and the proof is the key's raw P-256 signature over the canonical text of the payload. The domain acts on the arguments in `request` only.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');

const b64u = (buf) => Buffer.from(buf).toString('base64url');

// The text that is signed: keys sorted, no whitespace, no floating point, the same as the wallet and the PHP ledger write it. A request with
// no arguments is the empty object; an empty object deeper inside a request has no unambiguous form on the PHP side and is refused here.
function canonical(v, top) {
  if (Array.isArray(v)) return '[' + v.map((x) => canonical(x)).join(',') + ']';
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
    if (keys.length === 0 && !top) throw new Error('an empty object cannot be part of a signed request');
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(v[k], top && k === 'request')).join(',') + '}';
  }
  if (typeof v === 'number' && !Number.isInteger(v)) throw new Error('floating point values are not allowed');
  return JSON.stringify(v);
}

// The actions that change something live 60 seconds at most; the others 120.
const CHANGING = new Set(['spend34/open', 'spend34/grant', 'spend34/recover', 'spend34/compare', 'spend34/purchase-recover', 'spend34/purchase-cancel', 'spend34/restore', 'spend34/accept-rollback', 'spend34/reseal', 'spend34/resume', 'coin26/create', 'operator/activate']);
const READING = new Set(['spend34/integrity', 'spend34/evidence', 'coin26/preview', 'operator/check', 'operator/audit']);
const ACTIONS = new Set([...CHANGING, ...READING]);
const lifetimeFor = (action) => (CHANGING.has(action) ? 60 : 120);

function newIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  return {
    publicKey: b64u(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')])),
    privateKeyJwk: privateKey.export({ format: 'jwk' })
  };
}

function loadIdentity(file) {
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!saved || typeof saved.publicKey !== 'string' || !saved.privateKeyJwk) throw new Error('that is not an identity file');
  return { publicKey: saved.publicKey, privateKeyJwk: saved.privateKeyJwk };
}

function saveIdentity(file, identity) {
  fs.writeFileSync(file, JSON.stringify(identity, null, 2), { mode: 0o600 });
}

const iso = (ms) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

// A signed request for `action` on `domain`. `at` is the time it is issued, in milliseconds.
function signRequest(identity, { domain, action, request = {}, at = Date.now(), lifetime, repeat = false, nonce }) {
  if (!ACTIONS.has(action)) throw new Error('unknown action ' + action);
  const seconds = lifetime || lifetimeFor(action);
  const adminAuth = { action, domain, method: 'POST', issuedAt: iso(at), expiresAt: iso(at + seconds * 1000), nonce: nonce || crypto.randomBytes(18).toString('base64url') };
  if (repeat) adminAuth.repeat = true;
  const payload = { type: 'atlas.chainlabs.operator', v: 1, adminAuth, request };
  const key = crypto.createPrivateKey({ key: identity.privateKeyJwk, format: 'jwk' });
  const signature = b64u(crypto.sign('sha256', Buffer.from(canonical(payload, true)), { key, dsaEncoding: 'ieee-p1363' }));
  return { payload, proof: { signerRole: 'raw-ecdsa', publicKey: identity.publicKey, signature } };
}

// The route a signed action goes to: [file, query].
function routeOf(action) {
  const [group, name] = action.split('/');
  if (group === 'coin26') return ['coin26.php', 'action=' + name];
  return ['spend34.php', 'action=' + (group === 'operator' ? 'operator-' + name : name)];
}

// One POST. `target` is { base: 'https://domain' or 'http://127.0.0.1:port', host: 'domain' }: the Host and Origin headers name the domain.
function postOnce(target, file, query, body, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const url = new URL(target.base + '/' + (target.dir ? target.dir.replace(/^\/|\/$/g, '') + '/' : '') + file + '?' + query);
    const data = JSON.stringify(body);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, {
      method: 'POST', timeout: timeoutMs,
      headers: { host: target.host, origin: 'https://' + target.host, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }
    }, (res) => {
      let text = '';
      res.on('data', (d) => (text += d));
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch (e) { /* not JSON */ } resolve({ status: res.statusCode, json, raw: text, headers: res.headers }); });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ status: 0, json: null, raw: '', headers: {} }));
    req.end(data);
  });
}

// Signs once and sends. When no answer arrives, the same signed request is sent again for as long as it lives: the domain answers a request
// it already carried out from its record, so sending it again cannot repeat the action. Once it has expired, no more is sent, and the
// result says that the outcome is not known.
async function callOperator(target, identity, action, request, opts = {}) {
  const signed = signRequest(identity, { domain: target.host, action, request, at: opts.at, repeat: opts.repeat, lifetime: opts.lifetime });
  const [file, query] = routeOf(action);
  const expires = Date.parse(signed.payload.adminAuth.expiresAt);
  let attempts = 0;
  for (;;) {
    attempts++;
    const res = await postOnce(target, file, query, signed, opts.timeoutMs);
    if (res.status !== 0) return Object.assign(res, { attempts, signed });
    if (Date.now() >= expires - 1000 || attempts >= (opts.maxAttempts || 5)) return { status: 0, json: null, raw: '', headers: {}, attempts, signed, outcomeUnknown: true };
    await new Promise((r) => setTimeout(r, opts.retryMs || 1500));
  }
}

// A request body that carries the old token instead of a signature: accepted until 1 March 2027, never for the actions that change something
// once signed requests have been activated.
function legacyBody(token, request) {
  return Object.assign({ adminToken: token }, request);
}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

module.exports = { canonical, newIdentity, loadIdentity, saveIdentity, signRequest, routeOf, postOnce, callOperator, legacyBody, sha256, lifetimeFor, ACTIONS, CHANGING, READING, b64u, iso };
