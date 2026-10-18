// Revocation safety in the wallet, in a real Chromium with the extension loaded.
//
// The wallet decides whether a credential is revoked from two documents its issuing domain
// publishes. Not being able to read the revocation list is not the same as the credential not being
// on it. This checks, for asset credentials (verifyCredential) and for ledger-account references
// (verifyLedgerCredential):
//   - the three outcomes are told apart: revoked, not revoked, and revocation status unavailable;
//   - an unavailable check is never a success: not valid, not "verified", and nothing that depends on
//     the verdict goes ahead or is thrown away on it;
//   - every way the list can fail to be read is "unavailable": a missing file (for assets), an HTTP
//     error, an unreachable host, a redirect, a body past the size limit (with and without a
//     Content-Length), invalid UTF-8, text that is not JSON, a cut-off list, a document that is not an
//     object, a missing or non-list "revoked", a list past the entry limit, an entry that is not an
//     object with a string id;
//   - a realistic list of 6,127 entries (about 1.07 MiB) is read in full: an id on it is refused
//     wherever it sits, an id that is not on it is accepted;
//   - the key document keeps its own, smaller limit;
//   - a definite finding (bad signature, key not valid at issuedAt, expired) is still reported as
//     such when the revocation list cannot be read.
//
// Everything is local: issuers on loopback, a real Chromium, no live site. The ledger issuer is
// test/ledger-test-lib.js's; the asset issuer is defined below and signs with its own throwaway key.
//
// Run: xvfb-run -a node test/manual-revocation-safety.js
'use strict';
const http = require('http');
const { webcrypto, randomUUID } = require('crypto');
const { subtle } = webcrypto;
const L = require('./call-e2e-lib');
const T = require('./ledger-test-lib');
const F = require('./revocation-fixture');
const { check } = L;

const NET = 'test-network-1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Answers a request as a test describes: { json } / { text } / { bytes } with an optional status and
// { withLength }, { redirect }, { destroy } (drop the connection), { hang } (never answer).
function answer(spec) {
  return (req, res) => {
    res.on('error', () => {});
    if (spec.destroy) return req.socket.destroy();
    if (spec.hang) return undefined;
    if (spec.stall) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write(spec.text || '{"revoked":['); return undefined; } // headers and the start of a body, then silence
    if (spec.redirect) { res.writeHead(302, { Location: spec.redirect }); return res.end(); }
    const body = spec.bytes !== undefined ? spec.bytes : spec.json !== undefined ? JSON.stringify(spec.json) : (spec.text || '');
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const headers = { 'Content-Type': 'application/json' };
    if (spec.withLength) headers['Content-Length'] = String(buf.length);
    res.writeHead(spec.status || 200, headers);
    for (let i = 0; i < buf.length; i += 65536) res.write(buf.subarray(i, i + 65536));
    return res.end();
  };
}

// An asset issuer on loopback that publishes a key document and a revocation list, signs asset
// credentials, and answers the two recovery routes the export-recovery check needs.
async function startAssetIssuer() {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicKey = T.b64url(new Uint8Array(await subtle.exportKey('raw', kp.publicKey)));
  const state = { revoked: [], overrides: new Map(), keyValidFrom: '2026-01-01T00:00:00Z', hits: [] };
  const open = new Set();
  const server = http.createServer((req, res) => {
    state.hits.push(req.method + ' ' + req.url);
    const send = (obj, code) => { res.writeHead(code || 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const ov = state.overrides.get(req.url);
    if (ov) return ov(req, res);
    if (req.url === '/.well-known/atlas-key.json') return send({ keys: [{ publicKey, validFrom: state.keyValidFrom, validUntil: null }] });
    if (req.url === '/.well-known/atlas-revocations.json') return send({ revoked: state.revoked.map((id) => ({ id, revokedAt: '2026-10-01T00:00:00Z', reason: 'issuer-request' })) });
    if (req.url === '/atlas/asset/recover-file-export-challenge') return send({ challenge: 'test-challenge' });
    if (req.url === '/atlas/asset/recover-file-export') return send({ ok: false, code: 'not-found' }, 404);
    return send({ error: 'not found' }, 404);
  });
  server.on('connection', (s) => { open.add(s); s.on('close', () => open.delete(s)); });
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  const domain = 'localhost:' + port;
  return {
    domain, publicKey, state,
    serve(path, spec) { state.overrides.set(path, answer(spec)); },
    reset() { state.overrides.clear(); state.revoked = []; state.keyValidFrom = '2026-01-01T00:00:00Z'; },
    async issue(owner, over) {
      over = over || {};
      const credential = {
        credential: 'domain-atlas-asset/1.0',
        id: over.id || 'urn:atlas:asset:' + randomUUID(),
        asset: Object.assign({ class: 'gold-coin', name: 'Gold coin', fungible: false, presentation: 'collectible' }, over.asset || {}),
        owner: { publicKey: owner }, quantity: 1, supersedes: null,
        issuedAt: over.issuedAt || '2026-10-01T00:00:00Z',
        issuer: { domain, publicKey }
      };
      const payload = { id: credential.id, asset: credential.asset, owner: credential.owner, quantity: credential.quantity, supersedes: credential.supersedes, issuedAt: credential.issuedAt };
      credential.signature = T.b64url(new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, new TextEncoder().encode(T.canonicalize(payload)))));
      return credential;
    },
    close() { for (const s of open) s.destroy(); return new Promise((r) => server.close(() => r())); }
  };
}

const isVerified = (v) => !!v && v.valid === true && v.status === 'verified' && v.revocation === 'not-revoked';
const isRevoked = (v) => !!v && v.valid === false && v.status === 'revoked' && v.revocation === 'revoked' && v.reason === 'revoked by issuer';
const isUnavailable = (v) => !!v && v.valid === false && v.status === 'unavailable' && v.revocation === 'unavailable' && /^not verified: /.test(v.reason);
const REV = '/.well-known/atlas-revocations.json';
const KEYS = '/.well-known/atlas-key.json';

(async () => {
  const assets = await startAssetIssuer();
  const ledgerIssuer = await T.startIssuer();
  // The ledger issuer lets a test answer any of its paths itself.
  const lOverrides = new Map();
  ledgerIssuer.state.handler = async (req, res) => { const f = lOverrides.get(req.url); if (!f) return false; f(req, res); return true; };
  const lserve = (path, spec) => lOverrides.set(path, answer(spec));
  const w = await L.launchWallet('revocation');
  const W = w.wallet;
  const attempt = (fn, arg) => w.sw.evaluate('(async () => { try { return { ok: true, value: await (' + fn.toString() + ')(' + JSON.stringify(arg === undefined ? null : arg) + ') }; } catch (e) { return { ok: false, code: e && e.code, message: String((e && e.message) || e) }; } })()');
  try {
    w.pub = (await W((pw) => AtlasWallet.createIdentity(pw), 'revocation-test-password')).publicKey;
    const V = (c) => W((x) => AtlasWallet.verifyCredential(x), c);
    const VL = (c) => W((x) => AtlasWallet.verifyLedgerCredential(x), c);
    const held = () => W((k) => AtlasWallet.getWallet(k), w.pub);

    // ---------------------------------------------------------------- the fixture
    const REAL = F.pretty(F.entries(F.REAL_COUNT));
    console.log('--- the fixture: ' + F.REAL_COUNT + ' entries, ' + Math.round(REAL.length / 1024) + ' KiB ---');
    check('(set-up) the realistic list has 6,127 entries and is about the size of the live one', REAL.length > 1000000 && REAL.length < 1250000 && JSON.parse(REAL).revoked.length === 6127, REAL.length);
    check('(set-up) it is over the key document\'s limit and well under the revocation limit', REAL.length > F.KEY_BYTE_LIMIT && REAL.length < F.REVOCATION_BYTE_LIMIT);
    check('(set-up) the wallet\'s entry limit is the one the adapter module publishes', await W(() => AtlasLedgerLabs38.MAX_REVOCATION_ENTRIES) === F.REVOCATION_ENTRY_LIMIT);

    const gop0 = await ledgerIssuer.issue(w.pub, { network: NET, coin: 'GOP0' });
    // ---------------------------------------------------------------- asset credentials
    console.log('--- asset credentials: the three outcomes ---');
    const cred = await assets.issue(w.pub);
    let v = await V(cred);
    check('a genuine credential the issuer has not revoked is verified, and says so', isVerified(v), v);
    assets.state.revoked.push(cred.id);
    v = await V(cred);
    check('a credential on the issuer\'s list is revoked, and says so (not "invalid", not "unavailable")', isRevoked(v), v);
    assets.reset();

    console.log('--- asset credentials: the 6,127-entry list ---');
    const slow = [];
    const timed = async (fn) => { const t0 = Date.now(); const out = await fn(); slow.push(Date.now() - t0); return out; };
    assets.serve(REV, { text: REAL });
    v = await timed(() => V(cred));
    check('the realistic list that does not name the credential: verified', isVerified(v), v);
    assets.serve(REV, { text: REAL, withLength: true });
    v = await timed(() => V(cred));
    check('...also with an honest Content-Length', isVerified(v), v);
    for (const [where, build] of [
      ['first', (e) => { const l = F.entries(F.REAL_COUNT); l.unshift(e); return l; }],
      ['middle', (e) => { const l = F.entries(F.REAL_COUNT); l.splice(3063, 0, e); return l; }],
      ['last', (e) => F.entries(F.REAL_COUNT, [e])]
    ]) {
      assets.serve(REV, { text: F.pretty(build({ id: cred.id, revokedAt: '2026-10-05T00:00:00Z', reason: 'clawback' })) });
      v = await timed(() => V(cred));
      check('the credential named ' + where + ' in the long list is revoked', isRevoked(v), v);
    }
    assets.serve(REV, { text: F.pretty(F.entries(F.REAL_COUNT, [{ id: cred.id + 'x' }, { id: cred.id.toUpperCase() }, { id: cred.id.slice(0, -1) }])) });
    v = await timed(() => V(cred));
    check('ids that only look like it do not revoke it', isVerified(v), v);
    assets.reset();

    console.log('--- asset credentials: a revocation list that cannot be read is "unavailable", never "not revoked" ---');
    const MAX = F.REVOCATION_BYTE_LIMIT;
    const small = F.pretty(F.entries(10));
    const tiny = (count) => JSON.stringify({ revoked: Array.from({ length: count }, (_, n) => ({ id: 'u' + n })) });
    const accented = JSON.stringify({ revoked: [{ id: 'x', reason: 'éé' }] });
    const unavailableCases = [
      ['no list published at all (404)', { status: 404, text: '{}' }],
      ['an empty 404 body', { status: 404, text: '' }],
      ['HTTP 500', { status: 500, text: 'oops' }],
      ['HTTP 503 carrying a perfectly good list', { status: 503, text: REAL }],
      ['HTTP 403', { status: 403, text: '{"revoked":[]}' }],
      ['a dropped connection', { destroy: true }],
      ['a redirect to a perfectly good list', { redirect: KEYS }],
      ['text that is not JSON', { text: 'nope' }],
      ['an HTML error page served as 200', { text: '<html><body>Welcome</body></html>' }],
      ['a list cut off part-way', { text: REAL.slice(0, Math.floor(REAL.length / 2)) }],
      ['an empty body', { text: '' }],
      ['a body that is not valid UTF-8', { bytes: Buffer.concat([Buffer.from('{"revoked":[{"id":"'), Buffer.from([0xff, 0xfe, 0xc3]), Buffer.from('"}]}')]) }],
      ['a document with no "revoked" list', { text: '{}' }],
      ['"revoked" that is not a list', { text: '{"revoked":"none"}' }],
      ['"revoked": null', { text: '{"revoked":null}' }],
      ['a whole document that is a list', { text: '[]' }],
      ['a document that is a number', { text: '5' }],
      ['an entry that is null', { text: F.pretty(F.entries(100, [null])) }],
      ['an entry that is a number', { text: F.pretty(F.entries(100, [5])) }],
      ['an entry that is a list', { text: F.pretty(F.entries(100, [['id']])) }],
      ['an entry with no id', { text: F.pretty(F.entries(100, [{ revokedAt: '2026-10-01T00:00:00Z' }])) }],
      ['an entry whose id is not a string', { text: F.pretty(F.entries(100, [{ id: 42 }])) }],
      ['a malformed entry at the end of the long list', { text: F.pretty(F.entries(F.REAL_COUNT, [{ id: null }])) }],
      ['one byte over the size limit', { text: F.padTo(small, MAX + 1) }],
      ['one byte over the size limit, with an honest Content-Length', { text: F.padTo(small, MAX + 1), withLength: true }],
      ['8 MiB', { text: F.padTo(small, 2 * MAX) }],
      ['multi-byte text that is under the limit in characters but over it in bytes', { text: accented + ' '.repeat(MAX - 1 - accented.length) }],
      ['one entry over the entry limit', { text: tiny(F.REVOCATION_ENTRY_LIMIT + 1) }]
    ];
    for (const [name, spec] of unavailableCases) {
      assets.serve(REV, spec);
      v = await V(cred);
      check(name + ': unavailable (not valid, not verified, not "not revoked")', isUnavailable(v), v);
    }
    assets.reset();

    console.log('--- asset credentials: a domain that goes quiet (about 20 s each, run side by side) ---');
    assets.serve(REV, { hang: true });
    lserve(REV, { stall: true });
    const t0 = Date.now();
    const [hung, stalled] = await Promise.all([V(cred), VL(gop0)]);
    const waited = Date.now() - t0;
    check('a revocation list that is never answered: unavailable', isUnavailable(hung) && /did not answer in time/.test(hung.reason), hung);
    check('a revocation list that starts arriving and then stops: unavailable', isUnavailable(stalled) && /did not finish arriving in time/.test(stalled.reason), stalled);
    check('...each given up on after about 20 seconds, not left to hang', waited >= 19000 && waited < 40000, waited);
    assets.reset();
    lOverrides.clear();

    console.log('--- asset credentials: lists at the edge of the limits are read ---');
    for (const [name, spec] of [
      ['exactly the size limit', { text: F.padTo(small, MAX) }],
      ['exactly the size limit, in bytes, with multi-byte text', { text: accented + ' '.repeat(MAX - 2 - accented.length) }],
      ['exactly the entry limit (20,000 entries)', { text: tiny(F.REVOCATION_ENTRY_LIMIT) }],
      ['an empty list', { text: '{"revoked":[]}' }],
      ['an empty list with extra fields', { text: '{"revoked":[],"note":"ok","generatedAt":"2026-10-01T00:00:00Z"}' }]
    ]) {
      assets.serve(REV, spec);
      v = await timed(() => V(cred));
      check(name + ': read, and the credential is verified', isVerified(v), v);
    }
    assets.reset();

    console.log('--- asset credentials: the key document ---');
    const KB = F.KEY_BYTE_LIMIT;
    const keyJson = JSON.stringify({ keys: [{ publicKey: assets.publicKey, validFrom: '2026-01-01T00:00:00Z', validUntil: null }] });
    for (const [name, spec] of [
      ['a missing key document (404)', { status: 404, text: '{}' }],
      ['an HTTP 500', { status: 500, text: 'oops' }],
      ['a redirect', { redirect: REV }],
      ['text that is not JSON', { text: '<html>' }],
      ['a dropped connection', { destroy: true }],
      ['"keys" that is not a list', { text: '{"keys":"abc"}' }],
      ['a document with no "keys"', { text: '{}' }],
      ['one byte over its own limit (256 KiB)', { text: F.padTo(keyJson, KB + 1) }],
      ['one byte over its own limit, with an honest Content-Length', { text: F.padTo(keyJson, KB + 1), withLength: true }],
      ['the size of the long revocation list (its limit was not raised)', { text: F.padTo(keyJson, REAL.length) }],
      ['a body that is not valid UTF-8', { bytes: Buffer.concat([Buffer.from('{"keys":[],"x":"'), Buffer.from([0xff, 0xc3]), Buffer.from('"}')]) }]
    ]) {
      assets.serve(KEYS, spec);
      v = await V(cred);
      check('key document: ' + name + ' gives "unavailable"', !!v && v.valid === false && v.status === 'unavailable' && /^not verified: /.test(v.reason), v);
    }
    assets.serve(KEYS, { text: F.padTo(keyJson, KB) });
    v = await V(cred);
    check('key document: exactly its limit is read', isVerified(v), v);
    assets.serve(KEYS, { text: '{"keys":[]}' });
    v = await V(cred);
    check('key document: a readable document that lists no key is a definite "invalid", not "unavailable"', v.valid === false && v.status === 'invalid' && /key was not valid/.test(v.reason), v);
    assets.reset();

    console.log('--- asset credentials: what is still checked first, whatever the revocation list does ---');
    assets.serve(REV, { status: 500, text: 'oops' });
    const forged = Object.assign({}, cred, { quantity: 99 });
    v = await V(forged);
    check('a credential with changed contents is "invalid" (signature), not "unavailable"', v.valid === false && v.status === 'invalid' && v.reason === 'signature does not match', v);
    const wrongKey = JSON.parse(JSON.stringify(cred)); wrongKey.issuer.publicKey = 'B' + 'A'.repeat(86);
    v = await V(wrongKey);
    check('a credential naming a key the issuer does not publish is "invalid"', v.valid === false && v.status === 'invalid' && /key was not valid/.test(v.reason), v);
    const early = await assets.issue(w.pub, { issuedAt: '2025-06-01T00:00:00Z' });
    v = await V(early);
    check('a credential issued before its key was valid is "invalid"', v.valid === false && v.status === 'invalid', v);
    const expired = await assets.issue(w.pub, { asset: { expiresAt: '2026-01-02T00:00:00Z' } });
    v = await V(expired);
    check('an expired credential is "expired", even though the revocation list cannot be read', v.valid === false && v.status === 'expired' && /^expired at /.test(v.reason), v);
    assets.reset();
    assets.state.revoked.push(expired.id);
    v = await V(expired);
    check('an expired credential that is also revoked is reported as revoked, as before', isRevoked(v), v);
    assets.reset();
    v = await V(cred);
    check('with the issuer back to normal the original credential is verified again', isVerified(v), v);
    assets.state.keyValidFrom = '2026-10-02T00:00:00Z';
    v = await V(cred);
    check('a key that only became valid after issuedAt is still refused', v.valid === false && v.status === 'invalid', v);
    assets.reset();

    console.log('--- asset credentials: no redirect is followed and nothing else is contacted ---');
    assets.state.hits.length = 0;
    assets.serve(REV, { redirect: '/elsewhere' });
    v = await V(cred);
    check('a redirect is refused without being followed', isUnavailable(v) && !assets.state.hits.some((h) => /elsewhere/.test(h)), assets.state.hits);
    assets.reset();

    // ------------------------------------------------------------ callers of the verdict
    console.log('--- callers: an unavailable check never authorises, and never throws anything away ---');
    const mine = await assets.issue(w.pub, { asset: { name: 'Medal' } });
    const exportFile = (list) => ({ format: 'atlas-wallet-export/1.0', credentials: list });
    assets.serve(REV, { status: 500, text: 'oops' });
    const imported = await attempt((f) => AtlasWallet.importWallet(f), exportFile([mine]));
    let items = await held();
    const entry = items.find((e) => e.credential.id === mine.id);
    check('importing a credential while revocation cannot be read keeps it, tagged "unavailable" (never "verified")', imported.ok && entry && isUnavailable(entry.lastVerdict), entry && entry.lastVerdict);
    assets.reset();
    await W(() => AtlasWallet.reverifyAll());
    items = await held();
    check('re-verifying once the issuer answers turns the tag into "verified"', isVerified(items.find((e) => e.credential.id === mine.id).lastVerdict), items.map((e) => e.lastVerdict));
    assets.serve(REV, { status: 503, text: 'busy' });
    await W(() => AtlasWallet.reverifyAll());
    items = await held();
    let kept = items.find((e) => e.credential.id === mine.id);
    check('re-verifying while it cannot be read keeps the credential and downgrades the tag to "unavailable"', !!kept && isUnavailable(kept.lastVerdict), kept && kept.lastVerdict);
    assets.reset();
    assets.state.revoked.push(mine.id);
    await W(() => AtlasWallet.reverifyAll());
    kept = (await held()).find((e) => e.credential.id === mine.id);
    check('a revocation on the list shows as revoked (the credential is still kept and flagged, as before)', !!kept && isRevoked(kept.lastVerdict), kept && kept.lastVerdict);
    assets.reset();
    await W(() => AtlasWallet.reverifyAll());

    // A saved copy: restoring refuses on an unavailable check and says why; a good one is added.
    const copy = await assets.issue(w.pub, { asset: { name: 'Saved medal' } });
    assets.serve(REV, { status: 500, text: 'oops' });
    const before = (await held()).length;
    let r = await attempt((c) => AtlasWallet.restoreAssetCopy(c), copy);
    check('restoring a saved copy while revocation cannot be read is refused, in words about the check', !r.ok && /could not be read/.test(r.message) && /could not be checked/.test(r.message) && !/no longer valid/.test(r.message), r);
    check('...and nothing was added', (await held()).length === before);
    assets.reset();
    assets.state.revoked.push(copy.id);
    r = await attempt((c) => AtlasWallet.restoreAssetCopy(c), copy);
    check('restoring a revoked copy is refused as no longer valid', !r.ok && /no longer valid/.test(r.message) && /revoked/.test(r.message), r);
    assets.reset();
    r = await attempt((c) => AtlasWallet.restoreAssetCopy(c), copy);
    check('restoring a good copy works', r.ok && (await held()).some((e) => e.credential.id === copy.id && isVerified(e.lastVerdict)), r);

    // A transfer file: the claim screen.
    const filed = await assets.issue(w.pub, { asset: { name: 'Filed medal' } });
    assets.serve(REV, { status: 500, text: 'oops' });
    let insp = await W((t) => AtlasWallet.inspectAssetFile(t), JSON.stringify(filed));
    check('opening a file while revocation cannot be read says it cannot be checked, and offers neither claim nor restore', insp.relation === 'unreachable' && /revocation list/.test(insp.headline) && !insp.canClaim && !insp.canRestore && !insp.canFinishClaim, insp);
    assets.reset();
    assets.state.revoked.push(filed.id);
    insp = await W((t) => AtlasWallet.inspectAssetFile(t), JSON.stringify(filed));
    check('opening a revoked file says revoked', insp.relation === 'revoked' && !insp.canClaim && !insp.canRestore, insp);
    assets.reset();

    // Recovering an interrupted export: "lost" is a finding about the original and needs an answer.
    console.log('--- callers: recovering an interrupted export never calls an item lost on an unavailable check ---');
    const original = await assets.issue(w.pub, { asset: { name: 'Exported medal' } });
    const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const seed = () => W(([k, rec]) => AtlasWallet.saveAssetFiles(k, [rec]), [w.pub, { direction: 'exported', state: 'requesting', sourceId: original.id, credential: original, name: 'Exported medal', class: 'gold-coin', domain: assets.domain, at: old }]);
    const recState = async () => ((await W((k) => AtlasWallet.getAssetFiles(k), w.pub)).find((x) => x.sourceId === original.id) || {}).state;
    await seed();
    assets.serve(REV, { status: 500, text: 'oops' });
    r = await attempt((id) => AtlasWallet.recoverInterruptedExport(id), original.id);
    check('the issuer has no record and the original cannot be checked: the answer is "waiting", not "lost"', r.ok && r.value.outcome === 'waiting' && /could not be checked/.test(r.value.reason), r);
    check('...and the record is untouched', (await recState()) === 'requesting');
    assets.reset();
    r = await attempt((id) => AtlasWallet.recoverInterruptedExport(id), original.id);
    check('once the original can be checked and is still good, nothing was lost', r.ok && r.value.outcome === 'not-exported', r);
    await seed();
    assets.state.revoked.push(original.id);
    r = await attempt((id) => AtlasWallet.recoverInterruptedExport(id), original.id);
    check('when the original really is revoked, it is lost', r.ok && r.value.outcome === 'lost' && (await recState()) === 'lost', r);
    assets.reset();

    // The Wallet tab: three outcomes, three looks.
    console.log('--- the Wallet tab shows the three outcomes differently ---');
    const itemA = await assets.issue(w.pub, { asset: { name: 'Tab medal A' } });
    const itemB = await assets.issue(w.pub, { asset: { name: 'Tab medal B' } });
    await attempt((f) => AtlasWallet.importWallet(f), exportFile([itemA, itemB]));
    const page = await w.context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    const openWallet = async () => {
      await page.goto('chrome-extension://' + w.extId + '/viewer.html');
      await page.waitForFunction(() => typeof routeWalletScreen === 'function' && typeof AtlasWallet !== 'undefined', null, { timeout: 15000 });
      await page.evaluate(() => routeWalletScreen());
      await page.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), null, { timeout: 10000 });
      await page.evaluate(() => refreshInventoryDisplay());
    };
    const verdictOf = async (name) => {
      const card = page.locator('#selfCollectiblesList .wallet-item', { hasText: name }).first();
      await card.waitFor({ timeout: 10000 });
      const el = card.locator('.verdict').first();
      return { cls: await el.getAttribute('class'), status: await el.getAttribute('data-status'), text: (await el.innerText()).trim() };
    };
    assets.state.revoked.push(itemB.id);
    await W(() => AtlasWallet.reverifyAll());
    await openWallet();
    let a = await verdictOf('Tab medal A'), b = await verdictOf('Tab medal B');
    check('a verified item shows the tick on the "valid" style', /\bvalid\b/.test(a.cls) && a.status === 'verified' && /^✓ /.test(a.text), a);
    check('a revoked item shows the cross on the "invalid" style', /\binvalid\b/.test(b.cls) && b.status === 'revoked' && /^✗ .*revoked by issuer/.test(b.text), b);
    assets.reset();
    assets.serve(REV, { status: 500, text: 'oops' });
    await W(() => AtlasWallet.reverifyAll());
    await openWallet();
    a = await verdictOf('Tab medal A'); b = await verdictOf('Tab medal B');
    check('when the list cannot be read, the item shows a warning mark on its own "unavailable" style, not the tick', /\bunavailable\b/.test(a.cls) && !/\bvalid\b/.test(a.cls) && a.status === 'unavailable' && /^⚠ not verified: /.test(a.text), a);
    check('...and so does the one that is really revoked (nothing can be said about it)', /\bunavailable\b/.test(b.cls) && b.status === 'unavailable', b);
    check('...and the item itself is still in the wallet', (await held()).some((e) => e.credential.id === itemA.id) && (await held()).some((e) => e.credential.id === itemB.id));
    check('the page raised no errors', pageErrors.length === 0, pageErrors);
    await page.close();
    assets.reset();
    await W(() => AtlasWallet.reverifyAll());

    // ------------------------------------------------------------ ledger-account references
    console.log('--- ledger-account references: the same outcomes ---');
    const gop = await ledgerIssuer.issue(w.pub, { network: NET, coin: 'GOPH' });
    let lv = await VL(gop);
    check('a genuine reference the issuer has not revoked is verified and says so', isVerified(lv), lv);
    ledgerIssuer.state.revoked.push(gop.id);
    lv = await VL(gop);
    check('a reference on the issuer\'s list is revoked and says so', isRevoked(lv), lv);
    ledgerIssuer.state.revoked.length = 0;
    lserve(REV, { text: REAL });
    lv = await timed(() => VL(gop));
    check('the realistic 6,127-entry list that does not name it: verified', isVerified(lv), lv);
    lserve(REV, { text: F.pretty(F.entries(F.REAL_COUNT, [{ id: gop.id, revokedAt: '2026-10-05T00:00:00Z', reason: 'issuer-request' }])) });
    lv = await timed(() => VL(gop));
    check('...and the reference named last in it is revoked', isRevoked(lv), lv);
    lOverrides.clear();

    console.log('--- ledger-account references: what cannot be read is "unavailable" ---');
    for (const [name, spec] of unavailableCases.filter(([n]) => !/no list published|empty 404/.test(n))) {
      lserve(REV, spec);
      lv = await VL(gop);
      check(name + ': unavailable', isUnavailable(lv) && lv.code === 'revocation-unavailable', lv);
    }
    lOverrides.clear();

    console.log('--- ledger-account references: the one documented exception to the 404 rule ---');
    lserve(REV, { status: 404, text: '{}' });
    lv = await VL(gop);
    check('a domain that publishes no revocation list (404): verified, and the verdict says that is why', lv.valid === true && lv.status === 'verified' && lv.revocation === 'not-revoked' && /publishes no revocation list/.test(lv.reason), lv);
    lserve(REV, { status: 404, text: '{}' });
    r = await attempt((c) => AtlasWallet.addLedgerAccount(c, { allowNetwork: true }), gop);
    check('...so the reference can still be added (the rule the Labs 38 documentation states)', r.ok, r);
    await W((id) => AtlasWallet.removeLedgerAccount(id), gop.id);
    lOverrides.clear();
    lserve(KEYS, { status: 404, text: '{}' });
    lv = await VL(gop);
    check('the exception is only for the revocation list: a missing key document is unavailable', isUnavailable(lv), lv);
    lOverrides.clear();
    lserve(KEYS, { text: F.padTo(JSON.stringify({ keys: [{ publicKey: ledgerIssuer.publicKey, validFrom: '2026-01-01T00:00:00Z', validUntil: null }] }), KB + 1) });
    lv = await VL(gop);
    check('a key document over its own limit is unavailable for ledger references too', isUnavailable(lv), lv);
    lOverrides.clear();

    console.log('--- ledger-account references: adding one ---');
    const count0 = (await W(() => AtlasWallet.getLedgerOverview())).accounts.length;
    lserve(REV, { status: 500, text: 'oops' });
    r = await attempt((c) => AtlasWallet.addLedgerAccount(c, { allowNetwork: true }), gop);
    check('adding while revocation cannot be read fails with its own code and message, not "credential invalid"', !r.ok && r.code === 'revocation-unavailable' && /could not be read/.test(r.message) && /nothing was added/.test(r.message), r);
    check('...and stored nothing', (await W(() => AtlasWallet.getLedgerOverview())).accounts.length === count0);
    check('the new problem has plain-language text in the wallet\'s own table', await W(() => /try again later/.test(AtlasLedgerCore.problemText('revocation-unavailable'))));
    lserve(REV, { text: F.pretty(F.entries(F.REAL_COUNT, [{ id: gop.id }])) });
    r = await attempt((c) => AtlasWallet.addLedgerAccount(c, { allowNetwork: true }), gop);
    check('adding a reference that is on the long list is refused as revoked (credential-invalid)', !r.ok && r.code === 'credential-invalid' && /revoked/.test(r.message), r);
    check('...and stored nothing', (await W(() => AtlasWallet.getLedgerOverview())).accounts.length === count0);
    lserve(REV, { text: REAL });
    r = await attempt((c) => AtlasWallet.addLedgerAccount(c, { allowNetwork: true }), gop);
    check('adding while the realistic long list is published and does not name it works', r.ok && (await W(() => AtlasWallet.getLedgerOverview())).accounts.length === count0 + 1, r);
    lOverrides.clear();

    const worst = Math.max.apply(null, slow);
    console.log('     (slowest verification against a document of up to 4 MiB: ' + worst + ' ms)');
    check('every verification against a large list finished well inside a lookup\'s time budget', worst < 20000, worst);
  } finally {
    await w.close();
    await assets.close();
    await ledgerIssuer.close();
  }
  process.exit(L.finish('manual-revocation-safety'));
})().catch((err) => { console.log('FATAL', err && err.stack || err); process.exit(1); });
