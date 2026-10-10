// Regression checks for moderator authorization (roles, signed grants, the
// signed status statement), run against
// either issuer, plus a cross-implementation compatibility run:
//
//   node test/manual-moderator-authz.js node
//   node test/manual-moderator-authz.js php
//   node test/manual-moderator-authz.js compat     (starts both issuers)
//
//   1. Roles: entries without a role and role "admin" keep every privilege;
//      "moderator" keys can log in, ask for grants and nothing else.
//   2. Every issuer-admin route refuses a moderator, through a session token
//      and through a directly signed proof, and a refused proof does not
//      spend its nonce.
//   3. Fail-closed roster entries: unknown roles, mixed or duplicate entries,
//      invalid or empty scopes.
//   4. Immediate effect: revocation, demotion, promotion and scope changes
//      apply to sessions that already exist.
//   5. Grant requests: authority, audience, domain, strict payload validation,
//      lifetime, proof-of-possession key checks, replay and binding.
//   6. Grant structure: verified with tools/lib/moderation-grant.js (the
//      reference verifier), including proof of possession and replay of
//      moderation requests.
//   7. Live-grant quota and the unconfigured state.
//   8. Grants need a fresh signature from the moderator's key (a session token
//      alone is refused); the issuer-signed status statement.
//   compat: both issuers yield structurally identical grants that the same
//   verifier accepts, with the same moderator reference.
//
// Starts its own isolated issuers. Not part of the permanent suite, same
// reasoning as the other manual-*.js scripts.

const fs = require('fs');
const path = require('path');
const { webcrypto } = require('crypto');
const H = require('./lib/delivery-harness');
const { withAdminAuth } = require('./lib/admin-auth');
const M = require('../tools/lib/moderation-grant');

const MODE = process.argv[2] === 'php' ? 'php' : process.argv[2] === 'compat' ? 'compat' : 'node';
const PORTS = { main: 9311, quota: 9312, unconfigured: 9313, status: 9314, statusLimit: 9315, compatPhp: 9321, compatNode: 9322 };
const AUDIENCE = 'https://presence.test.example';
const base = (port) => 'http://localhost:' + port;
const START = '/atlas/admin/session/start';
const GRANT = '/atlas/admin/moderation/grant';

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? 'PASS: ' : 'FAIL: ') + name + (ok ? '' : ' => ' + detail));
}
const show = (r) => JSON.stringify({ status: r.status, body: r.body });
const isCode = (r, status, code) => r.status === status && r.body && r.body.code === code;

async function startIssuer(kind, port, env, config) {
  if (kind === 'node') {
    const docroot = H.tmpDir('atlas-moderation-docroot-');
    fs.cpSync(path.join(H.ROOT, 'demo-domain-a'), docroot, { recursive: true });
    const stateDir = H.tmpDir('atlas-moderation-state-');
    const issuer = await H.startNodeIssuer({
      port, stateDir, docrootDir: docroot,
      env: { ATLAS_ADMIN_FAIL_LIMIT: '1000', ATLAS_ADMIN_NONCE_PER_CLIENT_PER_MIN: '1000', ATLAS_ADMIN_NONCE_CAP: '1000', ...(config ? { ATLAS_MODERATION_AUDIENCES: config.audiences.join(','), ...(config.domain ? { ATLAS_DOMAIN: config.domain } : {}) } : {}), ...env }
    });
    issuer.files = (name) => path.join(stateDir, name);
    return issuer;
  }
  const bundleDir = H.preparePhpBundle();
  if (config) fs.writeFileSync(path.join(bundleDir, 'lib', 'atlas-moderation-config.json'), JSON.stringify({ domain: config.domain || 'localhost:' + port, audiences: config.audiences }));
  const issuer = await H.startPhpIssuer({
    port, bundleDir,
    env: { PHP_CLI_SERVER_WORKERS: '4', ATLAS_ADMIN_FAIL_LIMIT: '1000', ATLAS_ADMIN_NONCE_PER_CLIENT_PER_MIN: '1000', ATLAS_ADMIN_NONCE_CAP: '1000', ...env }
  });
  issuer.files = (name) => path.join(bundleDir, 'lib', name);
  return issuer;
}
// entries: [{identity, role?, worlds?, operations?, revoked?, raw?}]. `raw`
// replaces the whole entry (for malformed values).
function setRoster(issuer, entries) {
  const keys = entries.map((e) => {
    const k = { publicKey: e.identity.publicKey, addedAt: new Date().toISOString() };
    if ('role' in e) k.role = e.role;
    if ('worlds' in e) k.worlds = e.worlds;
    if ('operations' in e) k.operations = e.operations;
    if (e.revoked) k.revoked = true;
    return e.raw ? { publicKey: e.identity.publicKey, ...e.raw } : k;
  });
  fs.writeFileSync(issuer.files('atlas-admin-keys-store.json'), JSON.stringify({ keys }));
}

const send = (b, route, body) => H.postJson(b, route, body);
async function build(b, route, who, payload, o) {
  o = o || {};
  const p = JSON.parse(JSON.stringify(withAdminAuth(payload, b, o.action || route, o.auth))); // as it will arrive: no undefined members
  return { payload: p, proof: await H.signWithSelf(who, p) };
}
const call = async (b, route, who, payload, o) => send(b, route, await build(b, route, who, payload, o));
async function login(b, who, domain) {
  const nonce = (await H.getJson(b, '/atlas/admin/session/nonce')).body.nonce;
  const payload = withAdminAuth({ nonce }, b, START, domain ? { domain } : undefined);
  return send(b, START, { payload, proof: await H.signWithSelf(who, payload) });
}
async function session(b, who, domain) {
  const r = await login(b, who, domain);
  if (r.status !== 200) throw new Error('login failed: ' + show(r));
  return r.body;
}
const whoami = (b, token) => send(b, '/atlas/admin/session/whoami', { token });
const withToken = (b, route, token, payload) => send(b, route, { payload: payload || {}, token });

async function issuerKeyOf(b) {
  await send(b, GRANT, {}); // the PHP bundle creates its key on the first request that needs one
  const doc = await (await fetch(b + '/.well-known/atlas-key.json')).json();
  return doc.keys[0].publicKey;
}
function grantPayload(pop, o) {
  return { audience: AUDIENCE, worlds: ['alpha'], operations: ['chat.mute'], popPublicKey: pop, ...(o || {}) };
}
async function freshPop() { return M.generatePopKey(); }

// Every route that must stay admin-only, with a minimal payload.
function adminRoutes(owner) {
  return [
    ['/atlas/asset/mint', { ownerPublicKey: owner.publicKey, assetClass: 'atlas.demo.warranty.certificate' }],
    ['/atlas/asset/reissue', { credential: { id: 'urn:test:none' } }],
    ['/atlas/asset/fulfill', { credential: { id: 'urn:test:none' } }],
    ['/atlas/admin/directory', {}],
    ['/atlas/admin/class-patch', {}],
    ['/atlas/admin/class-patches', {}],
    ['/atlas/admin/asset-classes', {}],
    ['/atlas/admin/visits', {}],
    ['/atlas/admin/trusted-trade-peers/', {}],
    ['/atlas/admin/trusted-trade-peers/add', { domain: 'peer.example' }],
    ['/atlas/admin/trusted-trade-peers/remove', { domain: 'peer.example' }],
    ['/atlas/admin/send-ticket-to-email', {}],
    ['/atlas/admin/email-tickets/poll-now', {}],
    ['/atlas/revoke', { id: 'urn:test:x', reason: 'test' }],
    ['/atlas/suspend', { id: 'urn:test:x', reason: 'test' }],
    ['/atlas/unsuspend', { id: 'urn:test:x' }],
    ['/atlas/clawback', { credential: { id: 'urn:test:none' }, toPublicKey: owner.publicKey }],
    ['/atlas/mail/send', { credentialId: 'urn:test:none', subject: 's', body: 'b' }],
    ['/atlas/calendar', { action: 'remove', id: 'none' }],
    ['/atlas/demo/reserve/consortium/co-sign', { requestingDomain: 'peer.example', id: 'x' }]
  ];
}

async function testMain(kind) {
  const port = PORTS.main, b = base(port);
  const issuer = await startIssuer(kind, port, { ATLAS_MODERATION_MAX_LIVE_GRANTS: '500' }, { audiences: [AUDIENCE] });
  try {
    const legacy = await H.genIdentity(), admin = await H.genIdentity(), mod = await H.genIdentity();
    const owner = await H.genIdentity(), outsider = await H.genIdentity();
    const issuerKey = await issuerKeyOf(b);
    const domain = 'localhost:' + port;
    setRoster(issuer, [{ identity: legacy }, { identity: admin, role: 'admin' }, { identity: mod, role: 'moderator', worlds: ['alpha', 'gamma'] }]);

    console.log('STEP 1: roles');
    const sLegacy = await session(b, legacy), sAdmin = await session(b, admin), sMod = await session(b, mod);
    check('login reports role: legacy entry is admin', sLegacy.role === 'admin', JSON.stringify(sLegacy));
    check('login reports role: explicit admin', sAdmin.role === 'admin', JSON.stringify(sAdmin));
    check('login reports role: moderator', sMod.role === 'moderator', JSON.stringify(sMod));
    let r = await whoami(b, sMod.token);
    check('whoami accepts a moderator and reports the role', r.status === 200 && r.body.role === 'moderator' && r.body.publicKey === mod.publicKey, show(r));
    r = await whoami(b, sLegacy.token);
    check('whoami for a legacy admin reports admin', r.status === 200 && r.body.role === 'admin', show(r));
    for (const [who, expected] of [[legacy, true], [admin, true], [mod, false], [outsider, false]]) {
      r = await H.getJson(b, '/atlas/admin/is-admin?publicKey=' + encodeURIComponent(who.publicKey));
      check('is-admin is ' + expected + ' for ' + (who === mod ? 'a moderator' : who === outsider ? 'an outsider' : 'an administrator'), r.body.isAdmin === expected, show(r));
    }
    r = await login(b, outsider);
    check('a key not on the roster cannot log in', isCode(r, 401, 'not-admin'), show(r));

    console.log('STEP 2: existing administrators keep their privileges');
    for (const [name, who, tok] of [['legacy', legacy, sLegacy], ['role admin', admin, sAdmin]]) {
      r = await call(b, '/atlas/asset/mint', who, { ownerPublicKey: owner.publicKey, assetClass: 'atlas.demo.warranty.certificate' });
      check(name + ': signed mint works', r.status === 200, show(r));
      r = await withToken(b, '/atlas/admin/directory', tok.token);
      check(name + ': session directory works', r.status === 200, show(r));
      r = await call(b, '/atlas/revoke', who, { id: 'urn:test:' + name.replace(' ', '-'), reason: 'test' });
      check(name + ': signed revoke works', r.status === 200, show(r));
    }

    console.log('STEP 3: a moderator is refused on every issuer-admin route');
    for (const [route, payload] of adminRoutes(owner)) {
      const viaToken = await withToken(b, route, sMod.token, payload);
      check(route + ' via session token: 403 insufficient-role', isCode(viaToken, 403, 'insufficient-role'), show(viaToken));
      const body = await build(b, route, mod, payload);
      const viaProof = await send(b, route, body);
      check(route + ' via signed proof: 403 insufficient-role', isCode(viaProof, 403, 'insufficient-role'), show(viaProof));
    }
    r = await send(b, '/atlas/admin/directory', { token: sMod.token });
    check('moderator session without any payload is still refused on directory', isCode(r, 403, 'insufficient-role'), show(r));
    // A refused moderator proof must not burn its nonce: after a promotion the same bytes work once.
    const heldBody = await build(b, '/atlas/admin/directory', mod, {});
    r = await send(b, '/atlas/admin/directory', heldBody);
    check('held proof is refused while the key is a moderator', isCode(r, 403, 'insufficient-role'), show(r));
    setRoster(issuer, [{ identity: legacy }, { identity: admin, role: 'admin' }, { identity: mod, role: 'admin' }]);
    r = await send(b, '/atlas/admin/directory', heldBody);
    check('the refusal did not spend the nonce: the same proof works after promotion', r.status === 200, show(r));
    r = await send(b, '/atlas/admin/directory', heldBody);
    check('...and now it is spent', isCode(r, 401, 'replayed-request'), show(r));
    r = await withToken(b, '/atlas/admin/directory', sMod.token);
    check('promotion applies to the existing session at once', r.status === 200, show(r));
    r = await whoami(b, sMod.token);
    check('whoami reflects the new role', r.status === 200 && r.body.role === 'admin', show(r));
    setRoster(issuer, [{ identity: legacy }, { identity: admin, role: 'admin' }, { identity: mod, role: 'moderator', worlds: ['alpha', 'gamma'] }]);
    r = await withToken(b, '/atlas/admin/directory', sMod.token);
    check('demotion applies to the existing session at once', isCode(r, 403, 'insufficient-role'), show(r));
    r = await withToken(b, '/atlas/admin/directory', sAdmin.token);
    check('other administrators are unaffected', r.status === 200, show(r));

    console.log('STEP 4: roster entries fail closed');
    const cases = [
      ['unknown role', { role: 'owner' }],
      ['role with different case', { role: 'Moderator' }],
      ['role with trailing space', { role: 'admin ' }],
      ['empty-string role', { role: '' }],
      ['numeric role', { role: 7 }],
      ['array role', { role: ['admin'] }],
      ['boolean role', { role: true }]
    ];
    for (const [name, raw] of cases) {
      setRoster(issuer, [{ identity: mod, raw }]);
      r = await login(b, mod);
      check(name + ': cannot log in', isCode(r, 401, 'not-admin'), show(r));
      r = await call(b, '/atlas/admin/directory', mod, {});
      check(name + ': no admin route', r.status === 401 || r.status === 403, show(r));
      r = await H.getJson(b, '/atlas/admin/is-admin?publicKey=' + encodeURIComponent(mod.publicKey));
      check(name + ': is-admin false', r.body.isAdmin === false, show(r));
    }
    setRoster(issuer, [{ identity: mod, role: null }]);
    r = await login(b, mod);
    check('role: null is the legacy administrator', r.status === 200 && r.body.role === 'admin', show(r));
    setRoster(issuer, [{ identity: mod, raw: { role: 'admin' } }, { identity: mod, raw: { role: 'moderator' } }]);
    r = await login(b, mod);
    check('same key as admin and moderator: no authority', isCode(r, 401, 'not-admin'), show(r));
    setRoster(issuer, [{ identity: mod, raw: { role: 'moderator' } }, { identity: mod, raw: { role: 'moderator', worlds: ['alpha'] } }]);
    r = await login(b, mod);
    check('same key twice as moderator: no authority', isCode(r, 401, 'not-admin'), show(r));
    setRoster(issuer, [{ identity: mod, raw: { role: 'admin', revoked: true } }, { identity: mod, raw: { role: 'moderator' } }]);
    r = await login(b, mod);
    check('a revoked admin entry does not combine with an active moderator entry', r.status === 200 && r.body.role === 'moderator', show(r));
    setRoster(issuer, [{ identity: mod, raw: { role: 'moderator', revoked: true } }]);
    r = await login(b, mod);
    check('revoked moderator entry: cannot log in', isCode(r, 401, 'not-admin'), show(r));

    console.log('STEP 5: effective scope on every grant request');
    const modSession = async (entry) => {
      setRoster(issuer, [{ identity: mod, role: 'moderator', ...entry }]);
      return (await session(b, mod)).token;
    };
    const ask = async (o) => call(b, GRANT, mod, grantPayload((await freshPop()).publicKey, o));
    const tok = await modSession({ worlds: ['alpha'] });
    r = await ask({ worlds: ['alpha'] });
    check('listed world: granted', r.status === 200, show(r));
    r = await ask({ worlds: ['beta'] });
    check('unlisted world: 403 scope-denied', isCode(r, 403, 'scope-denied'), show(r));
    r = await ask({ worlds: ['alpha', 'beta'] });
    check('one unlisted world among listed: 403 scope-denied', isCode(r, 403, 'scope-denied'), show(r));
    r = await ask({ worlds: '*' });
    check('all worlds when scoped to one: 403 scope-denied', isCode(r, 403, 'scope-denied'), show(r));
    r = await ask({ worlds: ['Alpha'] });
    check('world ids are case-sensitive', isCode(r, 403, 'scope-denied'), show(r));
    setRoster(issuer, [{ identity: mod, role: 'moderator', worlds: ['beta'] }]);
    r = await ask({ worlds: ['alpha'] });
    check('changing the worlds applies to the existing session: alpha now denied', isCode(r, 403, 'scope-denied'), show(r));
    r = await ask({ worlds: ['beta'] });
    check('...and beta is now allowed', r.status === 200, show(r));
    setRoster(issuer, [{ identity: mod, role: 'moderator', worlds: [] }]);
    for (const w of [['alpha'], ['beta'], '*']) {
      r = await ask({ worlds: w });
      check('empty worlds list grants nothing (' + JSON.stringify(w) + ')', isCode(r, 403, 'scope-denied'), show(r));
    }
    for (const [name, worlds] of [['null', null], ['string', 'alpha'], ['star string', '*'], ['object', { alpha: true }], ['empty-string entry', ['']], ['non-string entry', [1]]]) {
      setRoster(issuer, [{ identity: mod, role: 'moderator', worlds }]);
      r = await ask({ worlds: ['alpha'] });
      check('invalid roster worlds (' + name + ') grants nothing', isCode(r, 403, 'scope-denied'), show(r));
    }
    setRoster(issuer, [{ identity: mod, role: 'moderator' }]);
    r = await ask({ worlds: ['anything'] });
    check('no worlds key: all worlds', r.status === 200, show(r));
    r = await ask({ worlds: '*' });
    check('no worlds key: "*" allowed', r.status === 200, show(r));
    setRoster(issuer, [{ identity: mod, role: 'moderator', operations: ['chat.mute'] }]);
    r = await ask({ operations: ['chat.mute'] });
    check('listed operation: granted', r.status === 200, show(r));
    r = await ask({ operations: ['session.kick'] });
    check('unlisted operation: 403 scope-denied', isCode(r, 403, 'scope-denied'), show(r));
    r = await ask({ operations: ['chat.mute', 'session.kick'] });
    check('one unlisted operation among listed: 403 scope-denied', isCode(r, 403, 'scope-denied'), show(r));
    setRoster(issuer, [{ identity: mod, role: 'moderator', operations: [] }]);
    r = await ask({ operations: ['chat.mute'] });
    check('empty operations list grants nothing', isCode(r, 403, 'scope-denied'), show(r));
    setRoster(issuer, [{ identity: mod, role: 'moderator', operations: ['ban'] }]);
    r = await ask({ operations: ['chat.mute'] });
    check('roster operations outside the vocabulary grant nothing', isCode(r, 403, 'scope-denied'), show(r));

    console.log('STEP 6: revocation takes effect on existing sessions');
    setRoster(issuer, [{ identity: mod, role: 'moderator' }]);
    r = await ask({});
    check('before revocation: grant issued', r.status === 200, show(r));
    setRoster(issuer, [{ identity: mod, role: 'moderator', revoked: true }]);
    r = await ask({});
    check('revoked moderator: no grant', isCode(r, 401, 'not-admin'), show(r));
    r = await whoami(b, tok);
    check('revoked moderator: whoami refused', r.status === 401, show(r));
    r = await call(b, GRANT, mod, grantPayload((await freshPop()).publicKey));
    check('revoked moderator: signed request refused', isCode(r, 401, 'not-admin'), show(r));
    setRoster(issuer, [{ identity: mod, role: 'moderator' }]);
    r = await whoami(b, tok);
    check('restoring the entry does not resurrect the old session', r.status === 401, show(r));

    console.log('STEP 7: grant request validation');
    setRoster(issuer, [{ identity: legacy }, { identity: mod, role: 'moderator', worlds: ['alpha', 'beta'] }]);
    const pop = await freshPop();
    const bad = async (name, o, status, code) => {
      const x = await ask(o);
      check(name + ': ' + status + ' ' + code, isCode(x, status, code), show(x));
    };
    await bad('wrong audience', { audience: 'https://other-presence.example' }, 403, 'audience-not-trusted');
    await bad('audience with path', { audience: AUDIENCE + '/rooms' }, 400, 'bad-request');
    await bad('audience not a string', { audience: 5 }, 400, 'bad-request');
    await bad('audience missing', { audience: undefined }, 400, 'bad-request');
    await bad('audience in capitals', { audience: 'https://PRESENCE.test.example' }, 400, 'bad-request');
    await bad('no worlds', { worlds: undefined }, 400, 'bad-request');
    await bad('empty worlds array', { worlds: [] }, 400, 'bad-request');
    await bad('duplicate worlds', { worlds: ['alpha', 'alpha'] }, 400, 'bad-request');
    await bad('33 worlds', { worlds: Array.from({ length: 33 }, (_, i) => 'w' + i) }, 400, 'bad-request');
    await bad('world with a control character', { worlds: ['al\u0007pha'] }, 400, 'bad-request');
    await bad('world with a line separator', { worlds: ['al\u2028pha'] }, 400, 'bad-request');
    await bad('world with surrounding space', { worlds: [' alpha'] }, 400, 'bad-request');
    await bad('world too long', { worlds: ['w'.repeat(121)] }, 400, 'bad-request');
    await bad('world not a string', { worlds: [{ a: 1 }] }, 400, 'bad-request');
    await bad('no operations', { operations: undefined }, 400, 'bad-request');
    await bad('empty operations', { operations: [] }, 400, 'bad-request');
    await bad('unknown operation', { operations: ['ban'] }, 400, 'bad-request');
    await bad('duplicate operations', { operations: ['chat.mute', 'chat.mute'] }, 400, 'bad-request');
    await bad('ttl 0', { ttlSeconds: 0 }, 400, 'bad-request');
    await bad('ttl above the maximum', { ttlSeconds: 601 }, 400, 'bad-request');
    await bad('ttl fractional', { ttlSeconds: 1.5 }, 400, 'bad-request');
    await bad('ttl a string', { ttlSeconds: '300' }, 400, 'bad-request');
    await bad('ttl negative', { ttlSeconds: -5 }, 400, 'bad-request');
    await bad('unknown field', { delegate: true }, 400, 'bad-request');
    await bad('proof-of-possession key missing', { popPublicKey: undefined }, 400, 'bad-request');
    await bad('proof-of-possession key too short', { popPublicKey: pop.publicKey.slice(0, 80) }, 400, 'bad-request');
    await bad('proof-of-possession key not a string', { popPublicKey: 12 }, 400, 'bad-request');
    const rawPop = Buffer.from(pop.publicKey, 'base64url');
    const offCurve = Buffer.from(rawPop); offCurve[64] ^= 1;
    await bad('proof-of-possession key not on the curve', { popPublicKey: offCurve.toString('base64url') }, 400, 'bad-request');
    const compressed = Buffer.from(rawPop); compressed[0] = 0x02;
    await bad('proof-of-possession key with a compressed prefix', { popPublicKey: compressed.toString('base64url') }, 400, 'bad-request');
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = alphabet.indexOf(pop.publicKey[86]);
    const sibling = alphabet[last ^ 1];
    check('(precondition) the sibling spelling decodes to the same bytes', Buffer.from(pop.publicKey.slice(0, 86) + sibling, 'base64url').equals(rawPop), 'decoder differs');
    await bad('proof-of-possession key in a non-canonical spelling', { popPublicKey: pop.publicKey.slice(0, 86) + sibling }, 400, 'bad-request');
    await bad('proof-of-possession key equal to the requester key', { popPublicKey: mod.publicKey }, 400, 'bad-request');
    await bad('proof-of-possession key equal to the issuer key', { popPublicKey: issuerKey }, 400, 'bad-request');
    r = await call(b, GRANT, mod, []);
    check('payload an array: 400 bad-request', r.status === 400 || r.status === 401, show(r));
    r = await send(b, GRANT, { proof: {} });
    check('payload missing: 401 auth-required', isCode(r, 401, 'auth-required'), show(r));
    r = await send(b, GRANT, {});
    check('no credentials at all: 401', r.status === 401, show(r));

    console.log('STEP 8: signed requests - freshness, binding, replay');
    const popA = await freshPop();
    const signedBody = await build(b, GRANT, mod, grantPayload(popA.publicKey));
    r = await send(b, GRANT, signedBody);
    check('signed grant request accepted', r.status === 200 && r.body.grant, show(r));
    r = await send(b, GRANT, signedBody);
    check('replay of the same signed request: 401 replayed-request', isCode(r, 401, 'replayed-request'), show(r));
    const forOther = await build(b, '/atlas/revoke', mod, grantPayload((await freshPop()).publicKey));
    r = await send(b, GRANT, forOther);
    check('a proof signed for another route is refused here: 400 bad-request', isCode(r, 400, 'bad-request'), show(r));
    r = await call(b, GRANT, mod, grantPayload((await freshPop()).publicKey), { auth: { domain: 'evil.example' } });
    check('wrong-domain request: 400 wrong-domain', isCode(r, 400, 'wrong-domain'), show(r));
    r = await call(b, GRANT, mod, grantPayload((await freshPop()).publicKey), { auth: { issuedAt: new Date(Date.now() - 3 * 60e3).toISOString() } });
    check('expired request: 401', r.status === 401, show(r));
    r = await call(b, GRANT, mod, grantPayload((await freshPop()).publicKey), { auth: { issuedAt: new Date(Date.now() + 3 * 60e3).toISOString() } });
    check('future-dated request: 401', r.status === 401, show(r));
    r = await call(b, GRANT, mod, grantPayload((await freshPop()).publicKey), { auth: { nonce: 'short' } });
    check('short nonce: 400', r.status === 400 || r.status === 401, show(r));
    const tampered = await build(b, GRANT, mod, grantPayload((await freshPop()).publicKey));
    tampered.payload.worlds = ['beta'];
    r = await send(b, GRANT, tampered);
    check('payload altered after signing: 401', r.status === 401, show(r));
    const stolen = await build(b, GRANT, mod, grantPayload((await freshPop()).publicKey));
    stolen.payload.popPublicKey = (await freshPop()).publicKey;
    r = await send(b, GRANT, stolen);
    check('proof-of-possession key swapped after signing: 401', r.status === 401, show(r));
    r = await call(b, GRANT, outsider, grantPayload((await freshPop()).publicKey));
    check('signed by a key outside the roster: 401 not-admin', isCode(r, 401, 'not-admin'), show(r));

    console.log('STEP 9: grant structure, verified with the reference verifier');
    const popB = await freshPop();
    r = await call(b, GRANT, mod, grantPayload(popB.publicKey, { worlds: ['alpha', 'beta'], operations: ['chat.mute', 'session.kick'], ttlSeconds: 120 }));
    check('grant issued', r.status === 200 && r.body.grant && r.body.expiresAt, show(r));
    const g = r.body.grant;
    const opts = { issuerKeys: [issuerKey], audience: AUDIENCE, domain };
    let v = await M.verifyGrant(g, opts);
    check('verifies against the pinned issuer key', v.ok, JSON.stringify(v));
    check('payload carries exactly the specified fields', Object.keys(g.payload).sort().join() === 'audience,cnf,domain,expiresAt,grantId,issuedAt,moderatorRef,operations,type,version,worlds', Object.keys(g.payload).join());
    check('type, version and domain', g.payload.type === 'atlas.moderation-grant' && g.payload.version === 1 && g.payload.domain === domain, JSON.stringify(g.payload));
    check('audience, worlds, operations are as requested', g.payload.audience === AUDIENCE && g.payload.worlds.join() === 'alpha,beta' && g.payload.operations.join() === 'chat.mute,session.kick', JSON.stringify(g.payload));
    check('lifetime is the requested 120 s', Date.parse(g.payload.expiresAt) - Date.parse(g.payload.issuedAt) === 120000 && g.payload.expiresAt === r.body.expiresAt, JSON.stringify(g.payload));
    check('cnf holds the requester\'s ephemeral key', g.payload.cnf.alg === 'ES256' && g.payload.cnf.publicKey === popB.publicKey && Object.keys(g.payload.cnf).length === 2, JSON.stringify(g.payload.cnf));
    check('moderator reference is the documented hash, not the key', g.payload.moderatorRef === M.moderatorRef(domain, mod.publicKey) && !JSON.stringify(g).includes(mod.publicKey), g.payload.moderatorRef);
    check('proof is raw-ecdsa by the issuer key', g.proof.signerRole === 'raw-ecdsa' && g.proof.publicKey === issuerKey, JSON.stringify(g.proof));
    check('grant id is 22 URL-safe characters', /^[A-Za-z0-9_-]{22}$/.test(g.payload.grantId), g.payload.grantId);
    const plainOk = await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' },
      await webcrypto.subtle.importKey('raw', Buffer.from(issuerKey, 'base64url'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']),
      Buffer.from(g.proof.signature, 'base64url'), Buffer.from(M.canonicalize(g.payload)));
    check('the signature is not a plain canonical-JSON signature (domain separated)', plainOk === false, 'verifies without the context prefix');
    r = await call(b, GRANT, mod, grantPayload((await freshPop()).publicKey));
    check('default lifetime is 300 s', Date.parse(r.body.grant.payload.expiresAt) - Date.parse(r.body.grant.payload.issuedAt) === 300000, JSON.stringify(r.body.grant.payload));
    r = await call(b, GRANT, mod, grantPayload((await freshPop()).publicKey, { ttlSeconds: 600 }));
    check('600 s is accepted', r.status === 200 && Date.parse(r.body.grant.payload.expiresAt) - Date.parse(r.body.grant.payload.issuedAt) === 600000, show(r));
    const ids = new Set();
    for (let i = 0; i < 4; i++) ids.add((await call(b, GRANT, mod, grantPayload((await freshPop()).publicKey))).body.grant.payload.grantId);
    check('grant ids are unique', ids.size === 4, [...ids].join());
    r = await call(b, GRANT, legacy, grantPayload((await freshPop()).publicKey, { worlds: '*', operations: ['roster.view', 'chat.mute', 'session.kick', 'session.timeout'] }));
    check('an administrator can obtain a grant for all worlds and operations', r.status === 200 && r.body.grant.payload.worlds === '*', show(r));
    check('...and it verifies', (await M.verifyGrant(r.body.grant, opts)).ok, 'verify failed');

    v = await M.verifyGrant(g, { ...opts, audience: 'https://other-presence.example' });
    check('verifier: wrong audience rejected', v.code === 'wrong-audience', JSON.stringify(v));
    v = await M.verifyGrant(g, { ...opts, domain: 'other.example' });
    check('verifier: wrong domain rejected', v.code === 'wrong-domain', JSON.stringify(v));
    v = await M.verifyGrant(g, { ...opts, issuerKeys: [(await H.genIdentity()).publicKey] });
    check('verifier: unpinned issuer key rejected', v.code === 'untrusted-issuer', JSON.stringify(v));
    v = await M.verifyGrant(g, { ...opts, now: Date.parse(g.payload.expiresAt) + 1 });
    check('verifier: expired grant rejected', v.code === 'expired', JSON.stringify(v));
    v = await M.verifyGrant(g, { ...opts, now: Date.parse(g.payload.issuedAt) - 5 * 60e3 });
    check('verifier: grant from the future rejected', v.code === 'not-yet-valid', JSON.stringify(v));
    const widened = JSON.parse(JSON.stringify(g)); widened.payload.worlds = '*';
    check('verifier: widened worlds break the signature', (await M.verifyGrant(widened, opts)).code === 'bad-signature', 'accepted');
    const longer = JSON.parse(JSON.stringify(g)); longer.payload.expiresAt = new Date(Date.parse(g.payload.expiresAt) + 3600e3).toISOString();
    check('verifier: extended expiry breaks the signature', (await M.verifyGrant(longer, opts)).code === 'bad-signature', 'accepted');
    const swapped = JSON.parse(JSON.stringify(g)); swapped.payload.cnf.publicKey = (await freshPop()).publicKey;
    check('verifier: swapped proof-of-possession key breaks the signature', (await M.verifyGrant(swapped, opts)).code === 'bad-signature', 'accepted');
    const extra = JSON.parse(JSON.stringify(g)); extra.payload.admin = true;
    check('verifier: unknown payload fields are not accepted', !(await M.verifyGrant(extra, opts)).ok, 'accepted');

    console.log('STEP 10: exercising a grant needs proof of possession');
    const gp = v0(await M.verifyGrant(g, opts)).payload;
    const nowIso = () => new Date().toISOString();
    const req = (o) => ({ type: 'atlas.moderation-request', version: 1, grantId: gp.grantId, audience: AUDIENCE, domain, world: 'alpha', operation: 'chat.mute', target: 'session-1', issuedAt: nowIso(), nonce: Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString('base64url'), ...(o || {}) });
    const ledger = M.createNonceLedger();
    const good = await M.signRequest(popB.privateKey, req());
    v = await M.verifyRequest(gp, good, { world: 'alpha', operation: 'chat.mute', ledger });
    check('request signed with the ephemeral key is accepted', v.ok, JSON.stringify(v));
    v = await M.verifyRequest(gp, good, { world: 'alpha', operation: 'chat.mute', ledger });
    check('replay of the same request is rejected', v.code === 'replay', JSON.stringify(v));
    const thief = await freshPop();
    v = await M.verifyRequest(gp, await M.signRequest(thief.privateKey, req()), { world: 'alpha', operation: 'chat.mute' });
    check('holding the grant without the private key is not enough', v.code === 'bad-pop', JSON.stringify(v));
    v = await M.verifyRequest(gp, await M.signRequest(popB.privateKey, req({ world: 'gamma' })), { world: 'gamma', operation: 'chat.mute' });
    check('a world outside the grant is refused', v.code === 'world-denied', JSON.stringify(v));
    v = await M.verifyRequest(gp, await M.signRequest(popB.privateKey, req({ operation: 'session.timeout' })), { world: 'alpha', operation: 'session.timeout' });
    check('an operation outside the grant is refused', v.code === 'operation-denied', JSON.stringify(v));
    v = await M.verifyRequest(gp, await M.signRequest(popB.privateKey, req({ audience: 'https://other-presence.example' })), { world: 'alpha', operation: 'chat.mute' });
    check('a request bound to another audience is refused', v.code === 'wrong-audience', JSON.stringify(v));
    v = await M.verifyRequest(gp, await M.signRequest(popB.privateKey, req({ domain: 'other.example' })), { world: 'alpha', operation: 'chat.mute' });
    check('a request bound to another domain is refused', v.code === 'wrong-audience', JSON.stringify(v));
    v = await M.verifyRequest(gp, await M.signRequest(popB.privateKey, req({ grantId: 'AAAAAAAAAAAAAAAAAAAAAA' })), { world: 'alpha', operation: 'chat.mute' });
    check('a request naming another grant is refused', v.code === 'wrong-grant', JSON.stringify(v));
    v = await M.verifyRequest(gp, await M.signRequest(popB.privateKey, req({ issuedAt: new Date(Date.now() - 5 * 60e3).toISOString() })), { world: 'alpha', operation: 'chat.mute' });
    check('a stale request is refused', v.code === 'stale-request', JSON.stringify(v));
    v = await M.verifyRequest(gp, good, { world: 'alpha', operation: 'chat.mute', now: Date.parse(gp.expiresAt) + 1 });
    check('requests after the grant expires are refused', v.code === 'expired', JSON.stringify(v));
    const edited = JSON.parse(JSON.stringify(good)); edited.payload.target = 'session-2';
    v = await M.verifyRequest(gp, edited, { world: 'alpha', operation: 'chat.mute' });
    check('altering the request after signing is detected', v.code === 'bad-pop', JSON.stringify(v));
    const pop2 = await M.generatePopKey();
    const forgedGrant = { ...gp, cnf: { alg: 'ES256', publicKey: pop2.publicKey } };
    v = await M.verifyGrant({ payload: forgedGrant, proof: g.proof }, opts);
    check('re-binding a grant to another key invalidates it', v.code === 'bad-signature', JSON.stringify(v));
  } finally {
    await H.stopIssuer(issuer);
  }
}
function v0(v) { if (!v.ok) throw new Error('grant did not verify: ' + JSON.stringify(v)); return v; }

async function testPhpHost() {
  const port = PORTS.main + 50, b = base(port);
  const issuer = await startIssuer('php', port, {}, { audiences: [AUDIENCE], domain: 'localhost:' + port });
  try {
    console.log('STEP 11 (PHP): the grant domain is configured, not taken from the Host header');
    const mod = await H.genIdentity();
    setRoster(issuer, [{ identity: mod, role: 'moderator' }]);
    const popKey = (await freshPop()).publicKey;
    const viaIp = await fetch('http://127.0.0.1:' + port + GRANT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(await build(b, GRANT, mod, grantPayload(popKey))) });
    const body = await viaIp.json();
    check('a request addressed to another host name is refused: 400 wrong-domain', viaIp.status === 400 && body.code === 'wrong-domain', JSON.stringify({ status: viaIp.status, body }));
    const ok = await call(b, GRANT, mod, grantPayload(popKey));
    check('the configured host name works', ok.status === 200, show(ok));
  } finally {
    await H.stopIssuer(issuer);
  }
}

async function testQuotaAndUnconfigured(kind) {
  const b = base(PORTS.quota);
  let issuer = await startIssuer(kind, PORTS.quota, { ATLAS_MODERATION_MAX_LIVE_GRANTS: '2' }, { audiences: [AUDIENCE] });
  try {
    console.log('STEP 12: live-grant quota');
    const m1 = await H.genIdentity(), m2 = await H.genIdentity();
    setRoster(issuer, [{ identity: m1, role: 'moderator' }, { identity: m2, role: 'moderator' }]);
    const t1 = (await session(b, m1)).token, t2 = (await session(b, m2)).token;
    const rs = [];
    for (let i = 0; i < 3; i++) rs.push(await call(b, GRANT, m1, grantPayload((await freshPop()).publicKey)));
    check('two live grants allowed', rs[0].status === 200 && rs[1].status === 200, rs.map(show).join(' '));
    check('third refused: 429 grant-quota', isCode(rs[2], 429, 'grant-quota'), show(rs[2]));
    const other = await call(b, GRANT, m2, grantPayload((await freshPop()).publicKey));
    check('another moderator has their own quota', other.status === 200, show(other));
    const stateFile = issuer.files('atlas-moderation-grants-store.json');
    const stored = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8') : '';
    check('the grants store holds no keys, signatures or session tokens', stored.length > 0 && !stored.includes(m1.publicKey) && !stored.includes(t1) && !stored.includes(rs[0].body.grant.proof.signature) && !stored.includes(rs[0].body.grant.payload.cnf.publicKey), stored.slice(0, 200));
  } finally {
    await H.stopIssuer(issuer);
  }
  issuer = await startIssuer(kind, PORTS.unconfigured, {}, null);
  try {
    console.log('STEP 13: unconfigured issuer');
    const bb = base(PORTS.unconfigured);
    const m = await H.genIdentity();
    setRoster(issuer, [{ identity: m, role: 'moderator' }]);
    const t = (await session(bb, m)).token;
    const r = await call(bb, GRANT, m, grantPayload((await freshPop()).publicKey));
    check('no configured presence endpoint: 503 moderation-not-configured', isCode(r, 503, 'moderation-not-configured'), show(r));
    const r2 = await withToken(bb, '/atlas/revoke', t, { id: 'urn:test:x' });
    check('...and the moderator is still refused elsewhere', isCode(r2, 403, 'insufficient-role'), show(r2));
  } finally {
    await H.stopIssuer(issuer);
  }
}

async function testSignatureAndStatus(kind) {
  const port = PORTS.status, b = base(port), domain = 'localhost:' + port;
  const issuer = await startIssuer(kind, port, { ATLAS_MODERATION_MAX_LIVE_GRANTS: '500' }, { audiences: [AUDIENCE, 'https://presence-two.test.example'], domain });
  try {
    const legacy = await H.genIdentity(), admin = await H.genIdentity(), mod = await H.genIdentity();
    const revokedMod = await H.genIdentity(), emptyMod = await H.genIdentity(), opsMod = await H.genIdentity();
    setRoster(issuer, [
      { identity: legacy }, { identity: admin, role: 'admin' },
      { identity: mod, role: 'moderator', worlds: ['alpha', 'β δ'] },
      { identity: opsMod, role: 'moderator', operations: ['chat.mute', 'roster.view'] },
      { identity: revokedMod, role: 'moderator', revoked: true },
      { identity: emptyMod, role: 'moderator', worlds: [] }
    ]);
    const issuerKey = await issuerKeyOf(b);
    const popKey = async () => (await freshPop()).publicKey;

    console.log('STEP 15: a grant needs a fresh signature, not a session token');
    const sMod = await session(b, mod), sAdmin = await session(b, legacy);
    let r = await withToken(b, GRANT, sMod.token, grantPayload(await popKey()));
    check('session token alone: 401 signature-required', isCode(r, 401, 'signature-required'), show(r));
    r = await withToken(b, GRANT, sAdmin.token, grantPayload(await popKey()));
    check('administrator session token alone: 401 signature-required', isCode(r, 401, 'signature-required'), show(r));
    r = await send(b, GRANT, { payload: grantPayload(await popKey()), proof: 'x', token: sMod.token });
    check('token plus a non-object proof: 401 signature-required', isCode(r, 401, 'signature-required'), show(r));
    const forged = await build(b, GRANT, mod, grantPayload(await popKey()));
    forged.proof.signature = forged.proof.signature.slice(0, -2) + (forged.proof.signature.endsWith('AA') ? 'BB' : 'AA');
    r = await send(b, GRANT, { ...forged, token: sMod.token });
    check('valid token next to a bad proof is still refused: 401', r.status === 401 && r.body.code !== undefined, show(r));
    const other = await build(b, GRANT, opsMod, grantPayload(await popKey()));
    r = await send(b, GRANT, { ...other, token: sMod.token });
    check('token of one key next to a proof of another uses the proof only', r.status === 200 && r.body.grant.payload.moderatorRef === M.moderatorRef(domain, opsMod.publicKey), show(r));
    r = await call(b, GRANT, mod, grantPayload(await popKey()));
    check('a freshly signed request is granted', r.status === 200, show(r));
    r = await whoami(b, sMod.token);
    check('ordinary session workflows are unchanged (whoami)', r.status === 200 && r.body.role === 'moderator', show(r));
    r = await withToken(b, '/atlas/admin/directory', sAdmin.token);
    check('ordinary session workflows are unchanged (admin directory)', r.status === 200, show(r));

    console.log('STEP 16: the signed status statement');
    const get = (aud, path) => fetch(b + (path || '/atlas/moderation/status') + (aud === undefined ? '' : '?audience=' + encodeURIComponent(aud)));
    let res = await get(AUDIENCE);
    const doc = await res.json();
    check('status: 200 with no-store caching', res.status === 200 && /no-store/.test(res.headers.get('cache-control') || ''), res.status + ' ' + res.headers.get('cache-control'));
    const opts = { issuerKeys: [issuerKey], audience: AUDIENCE, domain };
    let v = await M.verifyStatus(doc, opts);
    check('status verifies against the pinned issuer key', v.ok, JSON.stringify(v));
    check('status payload fields are exactly the documented set', Object.keys(doc.payload).sort().join() === 'audience,domain,expiresAt,issuedAt,moderators,type,version', Object.keys(doc.payload).join());
    check('status lifetime defaults to 60 s', Date.parse(doc.payload.expiresAt) - Date.parse(doc.payload.issuedAt) === 60000, JSON.stringify(doc.payload));
    const byRef = (x) => v.moderators.get(M.moderatorRef(domain, x.publicKey));
    check('administrators (legacy and explicit) are listed for every world and operation', [legacy, admin].every((x) => { const e = byRef(x); return e && e.worlds === '*' && e.operations.slice().sort().join() === M.OPERATIONS.slice().sort().join(); }), JSON.stringify(doc.payload.moderators));
    check('a scoped moderator is listed with exactly its worlds, all operations', (() => { const e = byRef(mod); return e && e.worlds.join() === 'alpha,β δ' && e.operations.length === 4; })(), JSON.stringify(byRef(mod)));
    check('an operation-limited moderator lists only those operations and all worlds', (() => { const e = byRef(opsMod); return e && e.worlds === '*' && e.operations.slice().sort().join() === 'chat.mute,roster.view'; })(), JSON.stringify(byRef(opsMod)));
    check('a revoked entry is absent', !byRef(revokedMod), 'listed');
    check('an entry with an empty scope is absent', !byRef(emptyMod), 'listed');
    check('no raw public key appears in the statement', ![legacy, admin, mod, opsMod, revokedMod, emptyMod].some((x) => JSON.stringify(doc).includes(x.publicKey)), 'key leaked');
    const refs = doc.payload.moderators.map((m) => m.moderatorRef);
    check('entries are sorted by moderator reference', refs.slice().sort().join() === refs.join(), refs.join());
    check('statement signature uses its own domain-separated context', M.STATUS_SIGN_CONTEXT !== M.GRANT_SIGN_CONTEXT && !(await M.verifyGrant(doc, { issuerKeys: [issuerKey], audience: AUDIENCE, domain })).ok, 'status accepted as a grant');
    v = await M.verifyStatus(doc, { ...opts, audience: 'https://presence-two.test.example' });
    check('verifier: status for another audience rejected', v.code === 'wrong-audience', JSON.stringify(v));
    v = await M.verifyStatus(doc, { ...opts, issuerKeys: [(await H.genIdentity()).publicKey] });
    check('verifier: unpinned key rejected', v.code === 'untrusted-issuer', JSON.stringify(v));
    v = await M.verifyStatus(doc, { ...opts, now: Date.parse(doc.payload.expiresAt) + 1 });
    check('verifier: expired status rejected', v.code === 'expired', JSON.stringify(v));
    const widened = JSON.parse(JSON.stringify(doc)); widened.payload.moderators[0].worlds = '*';
    check('verifier: edited status breaks the signature', (await M.verifyStatus(widened, opts)).code === 'bad-signature' || widened.payload.moderators[0].worlds === doc.payload.moderators[0].worlds, 'accepted');
    const longer = JSON.parse(JSON.stringify(doc)); longer.payload.expiresAt = new Date(Date.parse(doc.payload.expiresAt) + 3600e3).toISOString();
    check('verifier: extended expiry breaks the signature', (await M.verifyStatus(longer, opts)).code === 'bad-signature', 'accepted');

    res = await get('https://presence-two.test.example');
    check('the second configured audience gets its own statement', res.status === 200 && (await res.json()).payload.audience === 'https://presence-two.test.example', res.status);
    res = await get('https://evil.example');
    check('an unconfigured audience: 403 audience-not-trusted', res.status === 403 && (await res.json()).code === 'audience-not-trusted', res.status);
    res = await get(undefined);
    check('no audience: 403 audience-not-trusted', res.status === 403, res.status);
    res = await get(AUDIENCE + '/');
    check('audience must match exactly (trailing slash): 403', res.status === 403, res.status);

    setRoster(issuer, [{ identity: legacy }, { identity: mod, role: 'moderator', revoked: true }]);
    const after = await (await get(AUDIENCE)).json();
    v = await M.verifyStatus(after, opts);
    check('revoking at the issuer changes the very next statement', v.ok && !v.moderators.has(M.moderatorRef(domain, mod.publicKey)) && v.moderators.has(M.moderatorRef(domain, legacy.publicKey)), JSON.stringify(after.payload.moderators));
    setRoster(issuer, [{ identity: legacy }, { identity: mod, role: 'moderator', worlds: ['beta'], operations: ['roster.view'] }]);
    const narrowed = await M.verifyStatus(await (await get(AUDIENCE)).json(), opts);
    check('scope changes show up in the next statement', JSON.stringify(narrowed.moderators.get(M.moderatorRef(domain, mod.publicKey))) === JSON.stringify({ worlds: ['beta'], operations: ['roster.view'] }), JSON.stringify([...narrowed.moderators]));
    r = await call(b, GRANT, mod, grantPayload(await popKey(), { worlds: ['beta'], operations: ['roster.view'] }));
    check('(grant still follows the roster)', r.status === 200, show(r));
  } finally {
    await H.stopIssuer(issuer);
  }

  const lim = await startIssuer(kind, PORTS.statusLimit, { ATLAS_MODERATION_STATUS_PER_CLIENT_PER_MIN: '3' }, { audiences: [AUDIENCE] });
  try {
    const lb = base(PORTS.statusLimit);
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await fetch(lb + '/atlas/moderation/status?audience=' + encodeURIComponent(AUDIENCE))).status);
    check('status requests are rate limited per client', codes.slice(0, 3).every((c) => c === 200) && codes[3] === 429 && codes[4] === 429, codes.join());
    const lr = await fetch(lb + '/atlas/moderation/status?audience=' + encodeURIComponent(AUDIENCE));
    check('...with Retry-After', lr.status === 429 && Number(lr.headers.get('retry-after')) >= 1, lr.status + ' ' + lr.headers.get('retry-after'));
  } finally {
    await H.stopIssuer(lim);
  }

  const un = await startIssuer(kind, PORTS.unconfigured + 20, {}, null);
  try {
    const r = await fetch(base(PORTS.unconfigured + 20) + '/atlas/moderation/status?audience=' + encodeURIComponent(AUDIENCE));
    check('unconfigured issuer: status 503 moderation-not-configured', r.status === 503 && (await r.json()).code === 'moderation-not-configured', r.status);
  } finally {
    await H.stopIssuer(un);
  }
}

async function testCompat() {
  const domain = 'localhost:' + PORTS.compatPhp;
  const nodeIssuer = await startIssuer('node', PORTS.compatNode, {}, { audiences: [AUDIENCE], domain });
  const phpIssuer = await startIssuer('php', PORTS.compatPhp, {}, { audiences: [AUDIENCE], domain });
  try {
    console.log('STEP 14: Node and PHP issue structurally identical grants');
    const mod = await H.genIdentity();
    for (const i of [nodeIssuer, phpIssuer]) setRoster(i, [{ identity: mod, role: 'moderator', worlds: ['alpha', 'beta'] }]);
    const out = {};
    for (const [name, issuer, port] of [['node', nodeIssuer, PORTS.compatNode], ['php', phpIssuer, PORTS.compatPhp]]) {
      const b = base(port);
      const tok = (await session(b, mod, domain)).token;
      const popKey = await freshPop();
      const r = await call(b, GRANT, mod, grantPayload(popKey.publicKey, { worlds: ['alpha', 'beta'], operations: ['chat.mute', 'roster.view'], ttlSeconds: 90 }), { auth: { domain } });
      check(name + ': grant issued', r.status === 200, show(r));
      const key = await issuerKeyOf(b);
      const v = await M.verifyGrant(r.body.grant, { issuerKeys: [key], audience: AUDIENCE, domain });
      check(name + ': verified by the shared reference verifier', v.ok, JSON.stringify(v));
      out[name] = r.body;
    }
    const shape = (x) => Array.isArray(x) ? x.map(shape) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, shape(x[k])])) : typeof x;
    check('response and grant have identical field names and value types', JSON.stringify(shape(out.node)) === JSON.stringify(shape(out.php)), JSON.stringify(shape(out.node)) + ' vs ' + JSON.stringify(shape(out.php)));
    const strip = (g) => { const p = { ...g.payload }; delete p.grantId; delete p.issuedAt; delete p.expiresAt; delete p.cnf; return p; };
    check('same domain, audience, scope and moderator reference', JSON.stringify(strip(out.node.grant)) === JSON.stringify(strip(out.php.grant)), JSON.stringify(strip(out.node.grant)) + ' vs ' + JSON.stringify(strip(out.php.grant)));
    check('same lifetime', (Date.parse(out.node.grant.payload.expiresAt) - Date.parse(out.node.grant.payload.issuedAt)) === (Date.parse(out.php.grant.payload.expiresAt) - Date.parse(out.php.grant.payload.issuedAt)), 'lifetimes differ');
    check('timestamps use the same format', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(out.php.grant.payload.issuedAt) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(out.node.grant.payload.issuedAt), 'format differs');
  } finally {
    await H.stopIssuer(nodeIssuer);
    await H.stopIssuer(phpIssuer);
  }
}

(async () => {
  console.log('Moderator authorization (' + MODE + ')');
  try {
    if (MODE === 'compat') {
      await testCompat();
    } else {
      await testMain(MODE);
      if (MODE === 'php') await testPhpHost();
      await testQuotaAndUnconfigured(MODE);
      await testSignatureAndStatus(MODE);
    }
  } catch (err) {
    console.error('FAILURE:', err);
    failures++;
  }
  console.log(failures ? '\n' + failures + ' CHECK(S) FAILED' : '\nALL MODERATOR AUTHORIZATION CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})();
