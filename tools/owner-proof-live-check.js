#!/usr/bin/env node
// Checks that an issuer which says it requires a signed membership request really turns an unsigned one away.
//
//   node tools/owner-proof-live-check.js <domain or base URL> [<domain or base URL> ...] [--json] [--read-only]
//
// What it sends, per domain (all of it from throw-away keys that exist only for this run):
//   1. GET /atlas/capabilities, to read the advertised ownerProof record.
//   2. Only when that record says mode "require" and lists the class: ten refused membership requests.
//        - unsigned, with no Origin header (how a native app or a script sends one), for each of the three membership classes
//            -> 403 mint-origin-refused. The public issue route serves pages of its own domain, listed origins and wallet
//               extensions, and an origin-less request only with a signed intent, so this is refused before the owner proof
//               is looked at. An issuer whose origin protection is switched off (a local test issuer) answers
//               owner-authorization-required here instead, which is accepted too.
//        - unsigned, with the issuer's own Origin header (what a page of that domain sends), for each class
//            -> 403 owner-authorization-required, the owner proof's own refusal
//        - an empty signed request                                         -> 403 owner-authorization-required
//        - a request signed by a key other than the recipient              -> 403 not-owner
//        - a request whose signature is damaged                            -> 403 owner-signature-invalid
//        - a request signed for a different domain                         -> 403 owner-authorization-required
//      The four signed requests carry no Origin header, exactly as before.
//
// It never sends a request that could be accepted: a correctly signed request for the recipient is not among them.
// An issuer that does not advertise "require" is not probed at all (an unsigned request there would be served and
// would create a credential), and if an issuer ever answers a probe with success the run stops at once and says so.
//
// Nothing is changed on the issuer: a refusal is decided before a request id is leased, a credential minted, a roster
// row written or a welcome mail sent. The only effect is on the refusal counters, and not every refusal is counted:
// a request without an Origin header is refused (or, with a signed intent, judged as a native Join) before the owner-proof
// statistics, which only count requests from a page or an extension. So on an issuer with the origin protection on, only
// the three unsigned requests with the issuer's own Origin raise the owner-proof "refused" count, by three in all; the tool
// prints the number to expect ("counted"). Signed and unsigned counts do not move. Read the counters (Site Doctor, or
// tools/owner-proof-readiness.js on the server) before and after the run.
//
// Exit code: 0 every probed domain behaved as expected, 1 a probe got another answer or a domain is not enforcing,
// 2 usage error. Plain http is accepted only for a loopback host (local test issuers).
'use strict';
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;
const proofLib = require('../issuer-server/lib-owner-proof');

const CLASSES = proofLib.OWNER_PROOF_CLASSES;
const MESSAGE = proofLib.UPDATE_WALLET_MESSAGE;
const TIMEOUT_MS = 20000;
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const targets = args.filter((a) => !a.startsWith('--'));
if (!targets.length) {
  console.error('usage: node tools/owner-proof-live-check.js <domain or base URL> [<domain or base URL> ...] [--json] [--read-only]');
  process.exit(2);
}

function baseOf(arg) {
  let u;
  try { u = new URL(/^[a-z]+:\/\//i.test(arg) ? arg : 'https://' + arg); } catch (e) { return null; }
  const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) return null;
  if (u.username || u.password) return null;
  return u.origin;
}

async function newKey() {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return { pair, publicKey: b64u(await subtle.exportKey('raw', pair.publicKey)) };
}
async function sign(key, payload) {
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.pair.privateKey, new TextEncoder().encode(proofLib.canonicalize(payload)));
  return { signerRole: 'raw-ecdsa', publicKey: key.publicKey, signature: b64u(sig) };
}
const requestId = () => 'live-check-' + b64u(webcrypto.getRandomValues(new Uint8Array(12)));

async function http(method, url, body, extraHeaders) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method, redirect: 'manual', signal: ctl.signal, headers: Object.assign(body ? { 'Content-Type': 'application/json' } : {}, extraHeaders || {}), body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
    return { status: res.status, json, size: text.length };
  } catch (e) {
    return { status: 0, json: null, error: e && e.name === 'AbortError' ? 'timed out' : String(e && e.message || e) };
  } finally { clearTimeout(timer); }
}

async function probeDomain(arg) {
  const base = baseOf(arg);
  const out = { target: arg, base, capabilities: null, mode: null, probed: false, rows: [], notes: [], ok: false, refusedExpected: 0, countedExpected: 0, issuedByMistake: false };
  if (!base) { out.notes.push('not a valid https address (plain http is only accepted for localhost)'); return out; }
  const domain = new URL(base).host;
  const ownOrigin = new URL(base).origin;

  const caps = await http('GET', base + '/atlas/capabilities');
  if (caps.status !== 200 || !caps.json) { out.notes.push('GET /atlas/capabilities answered ' + (caps.status || caps.error) + '; cannot tell what this issuer enforces'); return out; }
  const rec = caps.json.ownerProof || null;
  out.capabilities = { requestIds: !!caps.json.requestIds, ownerProof: rec };
  out.mode = rec && typeof rec.mode === 'string' ? rec.mode : 'not advertised';
  if (!rec) { out.notes.push('this issuer does not advertise ownerProof (an older version, or the check is switched off)'); return out; }
  if (rec.mode !== 'require') { out.notes.push('mode is "' + rec.mode + '", not "require": nothing was sent, because an unsigned request would be served here and create a credential'); return out; }
  const classes = CLASSES.filter((c) => Array.isArray(rec.classes) && rec.classes.includes(c));
  if (classes.length !== CLASSES.length) out.notes.push('only these membership classes are listed: ' + (classes.join(', ') || 'none'));
  if (flag('--read-only')) { out.notes.push('--read-only: capabilities read, no request sent'); out.ok = classes.length === CLASSES.length; return out; }

  const owner = await newKey();
  const other = await newKey();
  const payloadFor = (assetClass, over) => proofLib.issuePayload(Object.assign({ assetClass, domain, issuedAt: new Date().toISOString(), ownerPublicKey: owner.publicKey, requestId: requestId() }, over || {}));
  const cases = [];
  const unsignedBody = (c) => async () => ({ ownerPublicKey: owner.publicKey, assetClass: c, requestId: requestId() });
  for (const c of classes) cases.push({ name: 'unsigned request, no Origin header, ' + c, group: 'originless', assetClass: c, expect: ['mint-origin-refused', 'owner-authorization-required'], updateWallet: true, build: unsignedBody(c) });
  for (const c of classes) cases.push({ name: 'unsigned request, issuer\'s own Origin, ' + c, group: 'own-origin', assetClass: c, expect: ['owner-authorization-required'], updateWallet: true, headers: { Origin: ownOrigin }, build: unsignedBody(c) });
  const c0 = classes[0] || CLASSES[0];
  cases.push({ name: 'empty signed request', group: 'signed', assetClass: c0, expect: ['owner-authorization-required'], build: async () => ({ ownerPublicKey: owner.publicKey, assetClass: c0, requestId: requestId(), intent: {} }) });
  cases.push({ name: 'signed by a key other than the recipient', group: 'signed', assetClass: c0, expect: ['not-owner'], build: async () => { const p = payloadFor(c0); return { ownerPublicKey: owner.publicKey, assetClass: c0, requestId: p.requestId, intent: { payload: p, proof: await sign(other, p) } }; } });
  cases.push({ name: 'damaged signature', group: 'signed', assetClass: c0, expect: ['owner-signature-invalid'], build: async () => {
    const p = payloadFor(c0); const proof = await sign(owner, p);
    const raw = Buffer.from(proof.signature, 'base64url'); raw[0] ^= 0xff; proof.signature = b64u(raw);
    return { ownerPublicKey: owner.publicKey, assetClass: c0, requestId: p.requestId, intent: { payload: p, proof } };
  } });
  cases.push({ name: 'signed for a different domain', group: 'signed', assetClass: c0, expect: ['owner-authorization-required'], build: async () => { const p = payloadFor(c0, { domain: 'other-domain.invalid' }); return { ownerPublicKey: owner.publicKey, assetClass: c0, requestId: p.requestId, intent: { payload: p, proof: await sign(owner, p) } }; } });

  out.probed = true;
  for (const c of cases) {
    const r = await http('POST', base + '/atlas/asset/issue', await c.build(), c.headers);
    const code = r.json && typeof r.json.code === 'string' ? r.json.code : null;
    const refused = r.status === 403 && c.expect.includes(code);
    // The wallet-update wording belongs to the owner proof's own refusal of an unsigned request.
    const wording = !c.updateWallet || code !== 'owner-authorization-required' || (r.json && r.json.updateWallet === true && r.json.error === MESSAGE);
    const row = { name: c.name, group: c.group, status: r.status, code, expected: '403 ' + c.expect.join(' or '), pass: refused && wording };
    if (r.error) row.error = r.error;
    if (r.status >= 200 && r.status < 300) { out.issuedByMistake = true; row.pass = false; row.note = 'the issuer answered success: a credential may have been issued to a throw-away key'; out.rows.push(row); break; }
    if (refused) out.refusedExpected++;
    out.rows.push(row);
  }

  // Which refusals the owner-proof statistics count. A request without an Origin header never reaches them when the
  // issuer's origin protection is on (it is refused as mint-origin-refused, or judged as a native Join, which is not
  // counted); with the protection off, as on a local test issuer, every refusal is counted.
  const originless = out.rows.filter((r) => r.group === 'originless');
  const protectionOn = originless.length > 0 && originless.every((r) => r.code === 'mint-origin-refused');
  const mixed = originless.length > 0 && !protectionOn && originless.some((r) => r.code === 'mint-origin-refused');
  if (mixed) out.notes.push('the three requests without an Origin header were not all answered alike: this issuer is only partly protected, or the three classes are handled differently');
  out.originProtection = originless.length === 0 ? 'unknown' : protectionOn ? 'on' : mixed ? 'mixed' : 'off';
  for (const r of out.rows) {
    r.counted = !!r.pass && (r.group === 'own-origin' || (!protectionOn && r.code !== 'mint-origin-refused'));
    if (r.counted) out.countedExpected++;
  }
  out.ok = !out.issuedByMistake && !mixed && out.rows.length === cases.length && out.rows.every((r) => r.pass) && classes.length === CLASSES.length;
  return out;
}

(async () => {
  const results = [];
  for (const t of targets) results.push(await probeDomain(t));
  if (flag('--json')) console.log(JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 1));
  else {
    for (const r of results) {
      console.log('\n' + r.target + (r.base ? '' : '  (skipped)'));
      console.log('  advertised mode: ' + (r.mode || 'unknown'));
      for (const n of r.notes) console.log('  note: ' + n);
      for (const row of r.rows) console.log('  ' + (row.pass ? 'PASS' : 'FAIL') + '  ' + row.name + ' -> ' + (row.status || row.error) + (row.code ? ' ' + row.code : '') + (row.pass ? (row.counted ? '   (counted)' : '   (not counted)') : '   (expected ' + row.expected + ')') + (row.note ? '   ' + row.note : ''));
      if (r.probed) {
        console.log('  origin protection: ' + r.originProtection + '   refused as expected: ' + r.refusedExpected + ' of ' + r.rows.length);
        console.log('  refusals that should now be counted in the owner-proof statistics: ' + r.countedExpected + (r.ok ? '   result: PASS' : '   result: FAIL'));
      }
      else console.log('  result: ' + (r.ok ? 'PASS (read only)' : 'NOT VERIFIED'));
    }
    console.log('\nNow read the owner-proof counters again: "refused" should have risen by the "counted" number above for each domain, and signed and unsigned should be unchanged. Requests without an Origin header are refused before the statistics, so they are not part of that number.');
  }
  process.exit(results.every((r) => r.ok) ? 0 : 1);
})();
