// Security regression checks for the administrator authentication layer,
// run against either issuer:
//
//   node test/manual-admin-hardening.js node
//   node test/manual-admin-hardening.js php
//
//   1. Roster revalidation: a session whose key is revoked or removed from
//      the roster loses access on its next request, and stays dead if the
//      key is later restored. Sessions written before the absolute lifetime
//      existed are refused.
//   2. Absolute session lifetime: a session cannot be kept alive past
//      ATLAS_ADMIN_SESSION_MAX_MS by activity.
//   3. Login: bound to /atlas/admin/session/start and this domain; the
//      server-issued nonce is single use, including under concurrency.
//   4. Replay: a signed request is accepted once on mint, revoke, suspend,
//      unsuspend, clawback and the other signed routes.
//   5. Binding and freshness: wrong action, wrong domain, stale and future
//      timestamps, short and long nonces, missing or malformed adminAuth,
//      tampering after signing; a rejected request does not spend its nonce.
//   6. Concurrency: identical signed requests sent in parallel succeed once.
//   7. Malformed input: invalid JSON, non-object bodies, wrong types, and
//      oversized bodies get a 4xx, never a 5xx, and leave the server usable.
//   8. Passkey (WebAuthn) envelopes: accepted for login and signed requests
//      only as "get" assertions with user presence. Uses a software ES256
//      key; no browser or authenticator is involved.
//   9. Throttling: failed authentications are limited per socket address
//      (a forged X-Forwarded-For buys nothing), a valid session keeps
//      working while throttled, the limit lapses, and login nonces are
//      bounded in number outstanding and per client.
//
// Starts its own isolated issuers. Not part of the permanent suite, same
// reasoning as the other manual-*.js scripts.

const fs = require('fs');
const path = require('path');
const { webcrypto } = require('crypto');
const H = require('./lib/delivery-harness');
const { withAdminAuth } = require('./lib/admin-auth');

const KIND = process.argv[2] === 'php' ? 'php' : 'node';
const PORTS = { main: 9301, lifetime: 9302, limits: 9303, rate: 9304 };
const base = (port) => 'http://localhost:' + port;
const START = '/atlas/admin/session/start';

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? 'PASS: ' : 'FAIL: ') + name + (ok ? '' : ' => ' + detail));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const show = (r) => JSON.stringify({ status: r.status, body: r.body });
const isCode = (r, status, code) => r.status === status && r.body && r.body.code === code;

// A software ES256 "passkey": a WebAuthn-shaped assertion, to exercise the
// server's passkey branch without a browser.
function derSignature(raw) {
  const trim = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; b = b.slice(i); return b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b; };
  const r = trim(Buffer.from(raw.slice(0, 32))), s = trim(Buffer.from(raw.slice(32)));
  return Buffer.concat([Buffer.from([0x30, 2 + r.length + 2 + s.length, 0x02, r.length]), r, Buffer.from([0x02, s.length]), s]);
}
async function passkeyIdentity() {
  const kp = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return { kp, publicKey: H.b64url(new Uint8Array(await webcrypto.subtle.exportKey('spki', kp.publicKey))), passkey: true };
}
async function passkeyEnvelope(identity, payload, o) {
  o = o || {};
  const hash = new Uint8Array(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(H.canonicalize(payload))));
  const clientDataJSON = Buffer.from(JSON.stringify({ type: o.type || 'webauthn.get', challenge: o.challenge || H.b64url(hash), origin: 'chrome-extension://test' }));
  const authData = Buffer.concat([Buffer.alloc(32, 7), Buffer.from([o.flags === undefined ? 0x05 : o.flags]), Buffer.from([0, 0, 0, 1])]);
  const clientHash = Buffer.from(await webcrypto.subtle.digest('SHA-256', clientDataJSON));
  const raw = new Uint8Array(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, identity.kp.privateKey, Buffer.concat([authData, clientHash])));
  return {
    signerRole: 'webauthn', publicKey: identity.publicKey,
    clientDataJSON: H.b64url(clientDataJSON), authenticatorData: H.b64url(authData), signature: H.b64url(derSignature(raw))
  };
}
const sign = (identity, payload, o) => (identity.passkey ? passkeyEnvelope(identity, payload, o) : H.signWithSelf(identity, payload));

async function startIssuer(port, env) {
  const fullEnv = { ...env };
  if (KIND === 'node') {
    const docroot = H.tmpDir('atlas-hardening-docroot-');
    fs.cpSync(path.join(H.ROOT, 'demo-domain-a'), docroot, { recursive: true });
    const stateDir = H.tmpDir('atlas-hardening-state-');
    const issuer = await H.startNodeIssuer({ port, stateDir, docrootDir: docroot, env: fullEnv });
    issuer.dir = stateDir;
    issuer.files = (name) => path.join(stateDir, name);
    return issuer;
  }
  const bundleDir = H.preparePhpBundle();
  const issuer = await H.startPhpIssuer({ port, bundleDir, env: { PHP_CLI_SERVER_WORKERS: '4', ...fullEnv } });
  issuer.dir = bundleDir;
  issuer.files = (name) => path.join(bundleDir, 'lib', name);
  return issuer;
}
function setRoster(issuer, identities, revoked) {
  const keys = identities.map((i) => ({ publicKey: i.publicKey, addedAt: new Date().toISOString(), ...((revoked || []).includes(i) ? { revoked: true } : {}) }));
  fs.writeFileSync(issuer.files('atlas-admin-keys-store.json'), JSON.stringify({ keys }));
}

// Builds a signed admin request. `o`: auth (overrides for adminAuth), action
// (route the adminAuth names), noAuth (omit adminAuth), mutate (change the
// payload after signing), proofOpts (passkey assertion tweaks).
async function build(b, route, admin, payload, o) {
  o = o || {};
  let p = o.noAuth ? payload : withAdminAuth(payload, b, o.action || route, o.auth);
  const proof = await sign(admin, p, o.proofOpts);
  if (o.mutate) p = o.mutate(p);
  return { payload: p, proof };
}
const send = (b, route, body) => H.postJson(b, route, body);
async function call(b, route, admin, payload, o) { return send(b, route, await build(b, route, admin, payload, o)); }
async function nonceOf(b) { return (await H.getJson(b, '/atlas/admin/session/nonce')).body.nonce; }
async function loginBody(b, admin, o) {
  o = o || {};
  const nonce = o.nonce || await nonceOf(b);
  const payload = o.noAuth ? { nonce } : withAdminAuth({ nonce }, b, o.action || START, o.auth);
  return { payload, proof: await sign(admin, payload, o.proofOpts) };
}
async function login(b, admin, o) { return send(b, START, await loginBody(b, admin, o)); }
async function startSession(b, admin) {
  const r = await login(b, admin);
  if (r.status !== 200) throw new Error('login failed: ' + show(r));
  return r.body;
}
const whoami = (b, token) => send(b, '/atlas/admin/session/whoami', { token });
async function rawPost(b, route, raw, headers) {
  const r = await fetch(b + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(headers || {}) }, body: raw });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch (_) { body = { raw: text }; }
  return { status: r.status, body, headers: r.headers };
}
const iso = (ms) => new Date(ms).toISOString();

async function testMain() {
  const port = PORTS.main, b = base(port);
  const issuer = await startIssuer(port, {
    ATLAS_ADMIN_FAIL_LIMIT: '1000', ATLAS_ADMIN_NONCE_PER_CLIENT_PER_MIN: '1000', ATLAS_ADMIN_NONCE_CAP: '1000', ATLAS_ADMIN_MAX_BODY_BYTES: '4096'
  });
  try {
    const admin = await H.genIdentity(), admin2 = await H.genIdentity(), outsider = await H.genIdentity(), pk = await passkeyIdentity();
    const owner = await H.genIdentity();
    setRoster(issuer, [admin, admin2, pk]);

    console.log('STEP 1: roster revalidation on every request');
    const s1 = await startSession(b, admin);
    check('login returns token, idle expiry and absolute expiry', s1.token && s1.expiresAt && s1.absoluteExpiresAt && s1.expiresAt <= s1.absoluteExpiresAt, JSON.stringify(s1));
    const life = s1.absoluteExpiresAt - Date.now();
    check('default absolute lifetime is about 8 hours', life > 7.9 * 3600e3 && life < 8.1 * 3600e3, String(life));
    let r = await whoami(b, s1.token);
    check('whoami works before revocation', r.status === 200 && r.body.publicKey === admin.publicKey, show(r));
    r = await send(b, '/atlas/admin/directory', { token: s1.token });
    check('a token-authenticated admin route works before revocation', r.status === 200, show(r));
    setRoster(issuer, [admin, admin2, pk], [admin]);
    r = await whoami(b, s1.token);
    check('revoked key: existing session refused on whoami', isCode(r, 401, 'not-admin'), show(r));
    r = await send(b, '/atlas/admin/directory', { token: s1.token });
    check('revoked key: existing session refused on an admin route', r.status === 401, show(r));
    r = await call(b, '/atlas/revoke', admin, { id: 'urn:test:x' });
    check('revoked key: a fresh signed request is refused', isCode(r, 401, 'not-admin'), show(r));
    r = await login(b, admin);
    check('revoked key: cannot log in', isCode(r, 401, 'not-admin'), show(r));
    setRoster(issuer, [admin, admin2, pk]);
    r = await whoami(b, s1.token);
    check('restoring the key does not resurrect the old session', r.status === 401, show(r));
    const s2 = await startSession(b, admin);
    r = await whoami(b, s2.token);
    check('the restored key can log in again', r.status === 200, show(r));
    const s3 = await startSession(b, admin2);
    setRoster(issuer, [admin]);
    r = await whoami(b, s3.token);
    check('key removed from the roster: session refused', isCode(r, 401, 'not-admin'), show(r));
    r = await whoami(b, s2.token);
    check('other admins on the roster are unaffected', r.status === 200, show(r));
    setRoster(issuer, [admin, admin2, pk]);

    console.log('STEP 1b: a session without an absolute expiry (written by an older server) is refused');
    const sessionsFile = issuer.files('atlas-admin-sessions-store.json');
    const doc = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
    doc.sessions.push({ token: 'legacy-token-without-absolute-expiry', publicKey: admin.publicKey, expiresAt: Date.now() + 600000 });
    fs.writeFileSync(sessionsFile, JSON.stringify(doc));
    r = await whoami(b, 'legacy-token-without-absolute-expiry');
    check('legacy session refused', isCode(r, 401, 'session-invalid'), show(r));

    console.log('STEP 2: login is bound to its route and domain, and its nonce is single use');
    r = await login(b, admin, { noAuth: true });
    check('login without adminAuth: 401 auth-required', isCode(r, 401, 'auth-required'), show(r));
    r = await login(b, admin, { action: '/atlas/revoke' });
    check('login signed for another route: refused', r.status === 401 && r.body.code === 'auth-required', show(r));
    r = await login(b, admin, { auth: { domain: 'evil.example' } });
    check('login signed for another domain: 400 wrong-domain', isCode(r, 400, 'wrong-domain'), show(r));
    r = await login(b, outsider);
    check('login by a key not on the roster: 401 not-admin', isCode(r, 401, 'not-admin'), show(r));
    const nonce = await nonceOf(b);
    r = await login(b, outsider, { nonce });
    r = await login(b, admin, { nonce });
    check('a failed attempt does not burn the nonce', r.status === 200, show(r));
    r = await login(b, admin, { nonce });
    check('the same nonce cannot be used twice', isCode(r, 401, 'bad-nonce'), show(r));
    r = await login(b, admin, { nonce: 'never-issued-nonce' });
    check('a nonce the server never issued is refused', isCode(r, 401, 'bad-nonce'), show(r));
    const shared = await nonceOf(b);
    const bodies = await Promise.all(Array.from({ length: 8 }, () => loginBody(b, admin, { nonce: shared })));
    const results = await Promise.all(bodies.map((x) => send(b, START, x)));
    check('8 concurrent logins on one nonce: exactly one succeeds', results.filter((x) => x.status === 200).length === 1 && results.filter((x) => x.body.code === 'bad-nonce').length === 7, results.map((x) => x.status).join(','));

    console.log('STEP 3: replay protection on every signed privileged route');
    const mintPayload = { ownerPublicKey: owner.publicKey, assetClass: 'atlas.demo.warranty.certificate' };
    const routes = [
      ['/atlas/asset/mint', mintPayload],
      ['/atlas/revoke', { id: 'urn:test:replay-revoke', reason: 'test' }],
      ['/atlas/suspend', { id: 'urn:test:replay-suspend', reason: 'test' }],
      ['/atlas/unsuspend', { id: 'urn:test:replay-suspend' }],
      ['/atlas/clawback', { credential: { id: 'urn:test:none' }, toPublicKey: owner.publicKey }],
      ['/atlas/admin/directory', {}],
      ['/atlas/calendar', { action: 'remove', id: 'none' }],
      ['/atlas/asset/reissue', { credential: { id: 'urn:test:none' } }],
      ['/atlas/mail/send', { credentialId: 'urn:test:none', subject: 's', body: 'b' }]
    ];
    for (const [route, payload] of routes) {
      const body = await build(b, route, admin, payload);
      const first = await send(b, route, body);
      const second = await send(b, route, body);
      check(route + ': first use passes authentication (' + first.status + ')', first.status !== 401 && first.status < 500, show(first));
      check(route + ': replay refused', isCode(second, 401, 'replayed-request'), show(second));
    }
    r = await call(b, '/atlas/asset/mint', admin, mintPayload);
    check('mint with fresh adminAuth still mints', r.status === 200, show(r));

    console.log('STEP 4: binding and freshness');
    const suspendBody = await build(b, '/atlas/suspend', admin, { id: 'urn:test:bound', reason: 'x' });
    r = await send(b, '/atlas/revoke', suspendBody);
    check('a request signed for /atlas/suspend is refused at /atlas/revoke', isCode(r, 400, 'bad-request'), show(r));
    r = await send(b, '/atlas/suspend', suspendBody);
    check('...and that refusal did not spend its nonce', r.status === 200, show(r));
    r = await call(b, '/atlas/revoke', admin, { id: 'urn:test:x' }, { auth: { domain: 'evil.example' } });
    check('wrong domain: 400 wrong-domain', isCode(r, 400, 'wrong-domain'), show(r));
    r = await call(b, '/atlas/revoke', admin, { id: 'urn:test:x' }, { auth: { issuedAt: iso(Date.now() - 3 * 60e3) } });
    check('3-minute-old request: 401 stale-request with serverTime', isCode(r, 401, 'stale-request') && typeof r.body.serverTime === 'string', show(r));
    r = await call(b, '/atlas/revoke', admin, { id: 'urn:test:x' }, { auth: { issuedAt: iso(Date.now() + 3 * 60e3) } });
    check('request dated 3 minutes ahead: 401 stale-request', isCode(r, 401, 'stale-request'), show(r));
    r = await call(b, '/atlas/revoke', admin, { id: 'urn:test:x' }, { auth: { issuedAt: iso(Date.now() - 60e3) } });
    check('1-minute-old request is inside the window', r.status === 200, show(r));
    r = await call(b, '/atlas/revoke', admin, { id: 'urn:test:x' }, { auth: { issuedAt: 'not a date' } });
    check('unparseable issuedAt: 400', isCode(r, 400, 'bad-request'), show(r));
    r = await call(b, '/atlas/revoke', admin, { id: 'urn:test:x' }, { auth: { issuedAt: 12345 } });
    check('non-string issuedAt: 400', isCode(r, 400, 'bad-request'), show(r));
    r = await call(b, '/atlas/revoke', admin, { id: 'urn:test:x' }, { auth: { nonce: 'short' } });
    check('short nonce: 400', isCode(r, 400, 'bad-request'), show(r));
    r = await call(b, '/atlas/revoke', admin, { id: 'urn:test:x' }, { auth: { nonce: 'n'.repeat(129) } });
    check('129-character nonce: 400', isCode(r, 400, 'bad-request'), show(r));
    r = await call(b, '/atlas/revoke', admin, { id: 'urn:test:x' }, { auth: { nonce: 12345678901234567890 } });
    check('numeric nonce: 400', isCode(r, 400, 'bad-request'), show(r));
    r = await call(b, '/atlas/revoke', admin, { id: 'urn:test:x' }, { noAuth: true });
    check('no adminAuth (the old request shape): 401 auth-required', isCode(r, 401, 'auth-required'), show(r));
    for (const bad of ['a string', [1, 2], 7]) {
      r = await call(b, '/atlas/revoke', admin, { id: 'urn:test:x', adminAuth: bad }, { noAuth: true });
      check('adminAuth of the wrong type (' + JSON.stringify(bad) + '): 401', isCode(r, 401, 'auth-required'), show(r));
    }
    r = await call(b, '/atlas/revoke', admin, { id: 'urn:test:a' }, { mutate: (p) => ({ ...p, id: 'urn:test:b' }) });
    check('payload altered after signing: 401 bad-signature', isCode(r, 401, 'bad-signature'), show(r));
    {
      const unsigned = { id: 'urn:test:x' };
      const proof = await sign(admin, unsigned);
      r = await send(b, '/atlas/revoke', { payload: withAdminAuth(unsigned, b, '/atlas/revoke'), proof });
      check('adminAuth added after signing: 401 bad-signature', isCode(r, 401, 'bad-signature'), show(r));
    }
    r = await call(b, '/atlas/revoke', outsider, { id: 'urn:test:x' });
    check('signed by a key not on the roster: 401 not-admin', isCode(r, 401, 'not-admin'), show(r));

    console.log('STEP 5: concurrent identical requests');
    for (let round = 0; round < 2; round++) {
      const body = await build(b, '/atlas/revoke', admin, { id: 'urn:test:concurrent-' + round, reason: 'race' });
      const out = await Promise.all(Array.from({ length: 10 }, () => send(b, '/atlas/revoke', body)));
      const ok = out.filter((x) => x.status === 200).length;
      const replayed = out.filter((x) => x.body && x.body.code === 'replayed-request').length;
      check('round ' + (round + 1) + ': 10 parallel copies, exactly one accepted', ok === 1 && replayed === 9, out.map((x) => x.status).join(','));
    }

    console.log('STEP 6: malformed input never reaches a 5xx');
    const rawCases = [
      ['not json', 'not json', 400], ['a JSON list', '[1,2]', 400], ['JSON null', 'null', 400], ['a JSON number', '123', 400], ['a JSON string', '"x"', 400],
      ['truncated JSON', '{"payload":', 400]
    ];
    for (const [label, raw, want] of rawCases) {
      r = await rawPost(b, '/atlas/revoke', raw);
      check(label + ': ' + want, r.status === want, show(r));
    }
    r = await rawPost(b, '/atlas/revoke', '');
    check('empty body: refused with a 4xx', r.status === 400 || r.status === 401, show(r));
    const typeCases = [
      ['payload is a string', { payload: 'x', proof: {} }], ['proof is a number', { payload: {}, proof: 5 }],
      ['proof without a signer', { payload: withAdminAuth({ id: 'a' }, b, '/atlas/revoke'), proof: {} }],
      ['non-string proof key', { payload: withAdminAuth({ id: 'a' }, b, '/atlas/revoke'), proof: { signerRole: 'raw-ecdsa', publicKey: 123, signature: 'x' } }],
      ['webauthn proof with junk fields', { payload: withAdminAuth({ id: 'a' }, b, '/atlas/revoke'), proof: { signerRole: 'webauthn', publicKey: admin.publicKey, clientDataJSON: 5, authenticatorData: [], signature: {} } }],
      ['token is a number', { payload: { id: 'a' }, token: 12345 }], ['token is an object', { payload: { id: 'a' }, token: { a: 1 } }],
      ['empty token string with no proof', { payload: { id: 'a' }, token: '' }]
    ];
    for (const [label, body] of typeCases) {
      r = await send(b, '/atlas/revoke', body);
      check(label + ': refused, not a server error', r.status === 401 || r.status === 400, show(r));
    }
    r = await send(b, '/atlas/admin/session/whoami', { token: { a: 1 } });
    check('whoami with an object token: 401', r.status === 401, show(r));
    r = await send(b, '/atlas/admin/session/logout', { token: 5 });
    check('logout with a numeric token: still 200', r.status === 200, show(r));

    console.log('STEP 7: request size limits');
    r = await rawPost(b, '/atlas/revoke', JSON.stringify({ payload: { id: 'x'.repeat(6000) } }));
    check('6 KB admin body over a 4 KB limit: 413', r.status === 413, show(r));
    r = await rawPost(b, START, JSON.stringify({ payload: { nonce: 'x'.repeat(20000) } }));
    check('20 KB login body: 413', r.status === 413, show(r));
    let big;
    try { big = await rawPost(b, '/atlas/revoke', JSON.stringify({ payload: { id: 'x'.repeat(3 * 1024 * 1024) } })); } catch (err) { big = { status: 'connection closed' }; }
    check('3 MB body is refused (413 or closed connection)', big.status === 413 || big.status === 'connection closed', show(big));
    r = await whoami(b, s2.token);
    check('the server is still serving after oversized bodies', r.status === 200, show(r));

    console.log('STEP 8: passkey (WebAuthn get, user present) envelopes');
    r = await call(b, '/atlas/revoke', pk, { id: 'urn:test:passkey' });
    check('signed request with a valid passkey assertion', r.status === 200, show(r));
    r = await login(b, pk);
    check('login with a valid passkey assertion', r.status === 200 && r.body.token, show(r));
    r = await call(b, '/atlas/revoke', pk, { id: 'urn:test:passkey' }, { proofOpts: { type: 'webauthn.create' } });
    check('webauthn.create assertion refused', isCode(r, 401, 'bad-signature'), show(r));
    r = await call(b, '/atlas/revoke', pk, { id: 'urn:test:passkey' }, { proofOpts: { flags: 0x00 } });
    check('assertion without user presence refused', isCode(r, 401, 'bad-signature'), show(r));
    r = await call(b, '/atlas/revoke', pk, { id: 'urn:test:passkey' }, { proofOpts: { challenge: 'AAAA' } });
    check('assertion over a different challenge refused', isCode(r, 401, 'bad-signature'), show(r));
    r = await login(b, pk, { proofOpts: { type: 'webauthn.create' } });
    check('login with a webauthn.create assertion refused', isCode(r, 401, 'bad-signature'), show(r));
    {
      const body = await build(b, '/atlas/revoke', pk, { id: 'urn:test:passkey-replay' });
      const a = await send(b, '/atlas/revoke', body), c = await send(b, '/atlas/revoke', body);
      check('a passkey-signed request is also single use', a.status === 200 && isCode(c, 401, 'replayed-request'), show(a) + ' / ' + show(c));
    }
  } finally {
    await H.stopIssuer(issuer);
  }
}

async function testLifetime() {
  const port = PORTS.lifetime, b = base(port);
  const issuer = await startIssuer(port, { ATLAS_ADMIN_SESSION_MAX_MS: '2500', ATLAS_ADMIN_FAIL_LIMIT: '1000', ATLAS_ADMIN_NONCE_PER_CLIENT_PER_MIN: '1000' });
  try {
    const admin = await H.genIdentity();
    setRoster(issuer, [admin]);
    console.log('STEP 9: absolute session lifetime (2.5 s here)');
    const t0 = Date.now();
    const s = await startSession(b, admin);
    check('absoluteExpiresAt is the configured lifetime away', Math.abs(s.absoluteExpiresAt - t0 - 2500) < 1500, String(s.absoluteExpiresAt - t0));
    check('idle expiry never extends past the absolute expiry', s.expiresAt <= s.absoluteExpiresAt, JSON.stringify(s));
    let r = await whoami(b, s.token);
    check('session works at the start', r.status === 200, show(r));
    await sleep(1400);
    r = await whoami(b, s.token);
    check('and with activity part-way through', r.status === 200, show(r));
    await sleep(1400);
    r = await whoami(b, s.token);
    check('activity does not keep it alive past the absolute lifetime', isCode(r, 401, 'session-invalid'), show(r));
    r = await send(b, '/atlas/admin/directory', { token: s.token });
    check('an admin route refuses it too', r.status === 401, show(r));
    const again = await startSession(b, admin);
    r = await whoami(b, again.token);
    check('a new login starts a fresh lifetime', r.status === 200, show(r));
  } finally {
    await H.stopIssuer(issuer);
  }
}

async function testLimits() {
  const port = PORTS.limits, b = base(port);
  const issuer = await startIssuer(port, {
    ATLAS_ADMIN_FAIL_LIMIT: '3', ATLAS_ADMIN_FAIL_WINDOW_MS: '3000', ATLAS_ADMIN_NONCE_CAP: '3', ATLAS_ADMIN_NONCE_PER_CLIENT_PER_MIN: '100'
  });
  try {
    const admin = await H.genIdentity(), outsider = await H.genIdentity();
    setRoster(issuer, [admin]);

    console.log('STEP 10: outstanding login nonces are bounded');
    const nonces = [];
    for (let i = 0; i < 3; i++) { const r = await H.getJson(b, '/atlas/admin/session/nonce'); nonces.push(r); }
    check('first three nonces issued', nonces.every((x) => x.status === 200 && x.body.nonce), nonces.map(show).join(' '));
    let r = await H.getJson(b, '/atlas/admin/session/nonce');
    check('fourth is refused with 503 busy', isCode(r, 503, 'busy'), show(r));
    const sessionRes = await login(b, admin, { nonce: nonces[0].body.nonce }); // spends one outstanding nonce, freeing a slot
    if (sessionRes.status !== 200) throw new Error('login failed: ' + show(sessionRes));
    const session = sessionRes.body;
    check('logging in frees a slot', (await H.getJson(b, '/atlas/admin/session/nonce')).status === 200, '');

    console.log('STEP 11: failed-authentication throttle, keyed on the socket address');
    for (let i = 0; i < 5; i++) {
      r = await send(b, '/atlas/admin/session/whoami', {});
      if (r.status !== 401) check('whoami without a token: 401', false, show(r));
    }
    check('whoami without a token is refused and does not count as a failure', r.status === 401, show(r));
    const spoof = (i) => ({ 'X-Forwarded-For': '203.0.113.' + i, 'X-Real-IP': '198.51.100.' + i });
    for (let i = 1; i <= 3; i++) {
      const body = await build(b, '/atlas/revoke', outsider, { id: 'urn:test:x' });
      r = await rawPost(b, '/atlas/revoke', JSON.stringify(body), spoof(i));
      check('failure ' + i + ' from a forged-address request: 401 not-admin', isCode(r, 401, 'not-admin'), show(r));
    }
    {
      const body = await build(b, '/atlas/revoke', admin, { id: 'urn:test:throttled' });
      r = await rawPost(b, '/atlas/revoke', JSON.stringify(body), spoof(99));
      const retry = Number(r.headers.get ? r.headers.get('retry-after') : 0);
      check('next request: 429 rate-limited with Retry-After (a new forged address does not help)', isCode(r, 429, 'rate-limited') && retry >= 1 && retry <= 4, show(r) + ' retry-after=' + retry);
      r = await send(b, START, await loginBody(b, admin, { nonce: (await nonceOf(b)) }));
      check('login is throttled as well', isCode(r, 429, 'rate-limited'), show(r));
    }
    r = await whoami(b, session.token);
    check('a valid session keeps working while throttled', r.status === 200, show(r));
    r = await send(b, '/atlas/admin/directory', { token: session.token });
    check('...including on admin routes', r.status === 200, show(r));
    r = await whoami(b, 'a-wrong-token');
    check('a wrong token while throttled: 429', isCode(r, 429, 'rate-limited'), show(r));
    await sleep(3300);
    r = await call(b, '/atlas/revoke', admin, { id: 'urn:test:after-window' });
    check('the throttle lapses after its window', r.status === 200, show(r));
  } finally {
    await H.stopIssuer(issuer);
  }
}

async function testNonceRate() {
  const port = PORTS.rate, b = base(port);
  const issuer = await startIssuer(port, { ATLAS_ADMIN_NONCE_PER_CLIENT_PER_MIN: '2', ATLAS_ADMIN_NONCE_CAP: '100' });
  try {
    console.log('STEP 12: login nonce requests are limited per client');
    const out = [];
    for (let i = 0; i < 4; i++) out.push(await rawPostGet(b, '/atlas/admin/session/nonce', { 'X-Forwarded-For': '203.0.113.' + i }));
    check('two nonces issued', out[0].status === 200 && out[1].status === 200, out.map(show).join(' '));
    check('third is 429 with Retry-After, whatever X-Forwarded-For says', isCode(out[2], 429, 'rate-limited') && Number(out[2].headers.get('retry-after')) >= 1, show(out[2]));
    check('fourth also refused', out[3].status === 429, show(out[3]));
  } finally {
    await H.stopIssuer(issuer);
  }
}
async function rawPostGet(b, route, headers) {
  const r = await fetch(b + route, { headers: headers || {} });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch (_) { body = { raw: text }; }
  return { status: r.status, body, headers: r.headers };
}

(async () => {
  console.log('Admin authentication hardening (' + KIND + ' issuer)');
  try {
    await testMain();
    await testLifetime();
    await testLimits();
    await testNonceRate();
  } catch (err) {
    console.error('FAILURE:', err);
    failures++;
  }
  console.log(failures ? '\n' + failures + ' CHECK(S) FAILED' : '\nALL ADMIN HARDENING CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})();
