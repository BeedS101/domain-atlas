// The PHP port of the call protocol (call-php/atlas/call/lib/protocol.php) against the
// Node original (call-server/protocol.js).
//
// Both are given the same inputs and must give the same answers: canonical JSON, hashes,
// payload schemas, envelope shapes, signature verification (raw and passkey), time parsing,
// base64url, the lenient DER reader, and the ICE URL rules. The inputs are fixed vectors and
// seeded random mutations, so a failure can be repeated with the same SEED.
//
// Requires `php` with the openssl extension on PATH.
'use strict';
const path = require('path');
const { spawnSync } = require('child_process');
const { P, check, finish, newIdentity, sign, iso, fp } = require('./call-test-lib');

const SEED = Number(process.env.SEED || 20260101);
const ROUNDS = Number(process.env.ROUNDS || 60);
let seed = SEED >>> 0;
function rnd() { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
const ri = (n) => Math.floor(rnd() * n);
const pick = (a) => a[ri(a.length)];
const clone = (v) => JSON.parse(JSON.stringify(v));

// ---------- running both sides ----------

const PHP_CHECK = path.join(__dirname, '..', 'call-php', 'tools', 'protocol-check.php');
function runPhp(cases) {
  const r = spawnSync('php', [PHP_CHECK], { input: JSON.stringify(cases), maxBuffer: 1 << 28, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('php failed: ' + (r.stderr || r.stdout).slice(0, 600));
  return JSON.parse(r.stdout);
}
const norm = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
function parseTimeJs(s) { if (typeof s !== 'string' || !ISO_MS.test(s)) return null; const t = Date.parse(s); return Number.isNaN(t) ? null : t; }
function derJs(str) { try { return P.b64urlEncode(P.derToRawEcdsaSig(P.b64urlDecode(str))); } catch (e) { return null; } }
function b64Js(str) { try { return P.b64urlEncode(P.b64urlDecode(str)); } catch (e) { return null; } }
function sigResult(r) { return { ok: r.ok, reason: r.reason, signer: r.signer }; }

async function runNode(c) {
  const raw = c.raw !== undefined ? JSON.parse(c.raw) : undefined;
  switch (c.op) {
    case 'canonicalize': return P.canonicalize(raw);
    case 'hashOf': return await P.hashOf(raw);
    case 'transcriptHash': return await P.transcriptHash(raw.invite, raw.accept);
    case 'tagHash': return await P.tagHash(c.str);
    case 'validatePayload': return P.validatePayload(raw);
    case 'validateEnvelope': return P.validateEnvelope(raw);
    case 'verifySigned': return sigResult(await P.verifySigned(raw));
    case 'verifyEnvelope': return await P.verifyEnvelope(raw.payload, raw.proof);
    case 'parseTime': return parseTimeJs(c.str);
    case 'jsNumber': return P.canonicalize(raw);
    case 'parseIceUrl': return P.parseIceUrl(c.str);
    case 'iceUrlProblem': return P.iceUrlProblem(c.str, c.opts || {});
    case 'privateHost': return P.privateHost(c.str);
    case 'derToRaw': return derJs(c.str);
    case 'b64urlDecode': return b64Js(c.str);
    default: throw new Error('op ' + c.op);
  }
}

// Node's JSON.parse keeps an unpaired surrogate escape inside a string; PHP's json_decode refuses it.
const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
function hasLoneSurrogate(raw) {
  let found = false;
  const walk = (v) => {
    if (typeof v === 'string') { if (LONE.test(v)) found = true; } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const k of Object.keys(v)) { if (LONE.test(k)) found = true; walk(v[k]); }
  };
  try { walk(JSON.parse(raw)); } catch (e) { /* not JSON */ }
  return found;
}
// PHP refuses a few encodings Node's WebCrypto tolerates (a passkey public key with bytes after
// the SPKI structure, a raw public key that is not a 65-byte uncompressed point). A case marked
// `stricter` must be refused by PHP; Node's answer is not compared.
async function compare(label, cases) {
  for (const c of cases) if (c.raw !== undefined && typeof c.raw !== 'string') { console.log('BAD CASE', JSON.stringify(c).slice(0, 300)); process.exit(2); }
  const php = runPhp(cases);
  let bad = 0, stricter = 0;
  const examples = [];
  for (let i = 0; i < cases.length; i++) {
    let node;
    if (cases[i].raw !== undefined && hasLoneSurrogate(cases[i].raw)) cases[i].stricter = true;
    if (cases[i].stricter) {
      const r = php[i];
      if (r === true || (r && r.ok === true)) { bad++; if (examples.length < 3) examples.push({ case: 'stricter', php: JSON.stringify(r) }); }
      stricter++;
      continue;
    }
    try { node = norm(await runNode(cases[i])); } catch (e) { node = 'node-threw:' + e.message; }
    const a = JSON.stringify(node), b = JSON.stringify(norm(php[i]));
    if (a !== b) { bad++; if (process.env.DUMP) require('fs').appendFileSync(process.env.DUMP, JSON.stringify(cases[i]) + '\n'); if (examples.length < 3) examples.push({ case: JSON.stringify(cases[i]).slice(0, 700), node: a.slice(0, 200), php: b.slice(0, 200) }); }
  }
  check(label + ' (' + cases.length + ' cases' + (stricter ? ', ' + stricter + ' where PHP must be stricter' : '') + ', seed ' + SEED + ')', bad === 0, bad ? { mismatches: bad, examples } : undefined);
  return php;
}

// ---------- payload builders and mutations ----------

const ser = (v) => {
  if (v && typeof v === 'object' && !Array.isArray(v) && '__raw' in v && Object.keys(v).length === 1) return v.__raw;
  if (Array.isArray(v)) return '[' + v.map(ser).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).map((k) => JSON.stringify(k) + ':' + ser(v[k])).join(',') + '}';
  return JSON.stringify(v);
};
const paths = (v, p = [], out = []) => {
  if (v && typeof v === 'object' && !('__raw' in v)) { out.push(p); for (const k of Object.keys(v)) paths(v[k], p.concat([k]), out); } else out.push(p);
  return out;
};
const getAt = (v, p) => p.reduce((a, k) => a[k], v);
const JUNK = [null, true, false, 0, 1, -1, 1.5, 2 ** 31, 2 ** 31 + 1, 2 ** 53, 1e21, '', ' ', 'x', 'AAAA', 'A\n', 'é', '😀', '\u0000', 'a'.repeat(300), 'a'.repeat(5000), [], {}, [1], { a: 1 }, [[]], { __raw: '1.0' }, { __raw: '2.0' }, { __raw: '1e0' }, { __raw: '-0' }, { __raw: '1E2' }, { __raw: '3.5' }];
function mutate(value) {
  const v = clone(value);
  const ps = paths(v);
  const p = pick(ps);
  const op = ri(9);
  if (!p.length) return pick(JUNK);
  const parent = getAt(v, p.slice(0, -1)), key = p[p.length - 1], cur = parent[key];
  switch (op) {
    case 0: if (Array.isArray(parent)) parent.splice(Number(key), 1); else delete parent[key]; break;
    case 1: { const t = cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : parent; const nk = pick(['x', 'extra', '__proto__', 'constructor', 'seq', 'th', 'tag', 'all', 'stop', '']); if (Array.isArray(t)) t.push(pick(JUNK)); else Object.defineProperty(t, nk, { value: pick(JUNK), enumerable: true, writable: true, configurable: true }); break; }
    case 2: parent[key] = pick(JUNK); break;
    case 3: if (typeof cur === 'string') parent[key] = pick([cur + '\n', cur + 'A', cur.slice(0, -1), cur.slice(1), cur.replace(/./, '+'), cur.replace(/.$/, '='), cur.replace(/./, 'а'), cur.toUpperCase(), cur.toLowerCase(), cur + cur, '', cur.slice(0, 1)]); else parent[key] = pick(JUNK); break;
    case 4: if (typeof cur === 'number') parent[key] = pick([cur + 1, cur - 1, 0, -1, cur * 2, 2 ** 31, 2 ** 31 + 1, 100000, 100001, { __raw: String(cur) + '.0' }, { __raw: String(cur) + 'e0' }, { __raw: '0.5' }]); else parent[key] = pick(JUNK); break;
    case 5: if (Array.isArray(cur)) parent[key] = pick([[], cur.concat(cur), cur.concat(cur, cur), cur.slice(1), cur.concat([cur[0]]), [cur]]); else parent[key] = pick(JUNK); break;
    case 6: parent[key] = Array.isArray(cur) ? Object.assign({}, cur) : (cur && typeof cur === 'object' ? Object.values(cur) : [cur]); break;
    case 7: if (typeof cur === 'string' && /^\d{4}-/.test(cur)) parent[key] = pick(TIMES); else parent[key] = pick(JUNK); break;
    default: if (typeof cur === 'string') parent[key] = pick(['é'.repeat(5), '😀'.repeat(4), 'é'.repeat(100), '😀'.repeat(100), '😀'.repeat(101), 'é'.repeat(201), 'abcdefg', 'abcdefgh', 'a'.repeat(200), 'a'.repeat(201), 'x'.repeat(22), 'x'.repeat(21), 'x'.repeat(23), 'x'.repeat(43), 'x'.repeat(87), 'x'.repeat(86), 'x'.repeat(88)]); else parent[key] = pick(JUNK);
  }
  return v;
}
const TIMES = ['2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00.000z', '2026-01-01 00:00:00.000Z', '2026-01-01T00:00:00.000Z\n', '2026-13-01T00:00:00.000Z', '2026-02-31T00:00:00.000Z', '2026-02-32T00:00:00.000Z', '2026-01-01T24:00:00.000Z', '2026-01-01T24:00:00.001Z', '2026-01-01T23:59:60.000Z', '0000-01-01T00:00:00.000Z', '9999-12-31T23:59:59.999Z', '+002026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000+00:00'];

async function webauthnEnvelope(payload, o) {
  o = o || {};
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey));
  const challenge = P.b64urlEncode(await P.sha256Bytes(new TextEncoder().encode(P.canonicalize(payload))));
  const clientData = new TextEncoder().encode(JSON.stringify(Object.assign({ type: 'webauthn.get', challenge, origin: 'https://wallet.example' }, o.cd)));
  const auth = new Uint8Array(o.authLen || 37); if (auth.length > 32) auth[32] = o.flags === undefined ? 0x05 : o.flags;
  const hash = await P.sha256Bytes(clientData);
  const signed = new Uint8Array(auth.length + hash.length); signed.set(auth); signed.set(hash, auth.length);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, signed));
  return { signerRole: 'webauthn', publicKey: P.b64urlEncode(spki), signature: P.b64urlEncode(rawToDer(sig)), clientDataJSON: P.b64urlEncode(clientData), authenticatorData: P.b64urlEncode(auth) };
}
function rawToDer(raw) {
  const enc = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; let t = Array.from(b.slice(i)); if (t[0] & 0x80) t = [0].concat(t); return [2, t.length].concat(t); };
  const body = enc(raw.slice(0, 32)).concat(enc(raw.slice(32)));
  return new Uint8Array([0x30, body.length].concat(body));
}

(async () => {
  const origin = 'https://calls.example.com';
  const id = await newIdentity(), id2 = await newIdentity();
  const T = iso(Date.now());
  const n = () => P.randomId(16);
  const C = (type, extra) => Object.assign({ type, v: 1, audience: origin, issuedAt: T }, extra);
  const callId = P.randomId(16), tag = P.randomId(16), th = P.randomId(32), h1 = P.randomId(32), h2 = P.randomId(32);
  const sdp = 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n';
  const sig = (kind, body, extra) => ({ type: 'atlas.call.signal', v: 1, audience: origin, callId, kind, body, ...extra });
  const bases = {
    tag: C('atlas.call.tag', { nonce: n(), bind: { kind: 'wallet', publicKey: id.pub }, calleeKey: id.pub, expiresAt: iso(Date.now() + 86400000), maxCalls: 5 }),
    revokeTag: C('atlas.call.tag-revoke', { nonce: n(), tag }),
    revokeAll: C('atlas.call.tag-revoke', { nonce: n(), all: true }),
    list: C('atlas.call.tag-list', { nonce: n() }),
    listen: C('atlas.call.listen', { nonce: n(), ack: [1, 2, 3] }),
    listenStop: C('atlas.call.listen', { nonce: n(), ack: [], stop: true }),
    session: C('atlas.call.listen-session', { expiresAt: iso(Date.now() + 3600000), sessionKey: id2.pub }),
    poll: C('atlas.call.poll', { nonce: n(), callId, after: 4 }),
    ice: C('atlas.call.ice', { nonce: n(), callId }),
    invite: C('atlas.call.invite', { nonce: n(), callId, tag, expiresAt: iso(Date.now() + 30000), caller: { kind: 'wallet', publicKey: id.pub }, callee: { publicKey: id2.pub }, callKey: id2.pub, media: { kind: 'audio', fingerprints: [fp('A'), fp('B')] } }),
    accept: sig('accept', { inviteHash: h1, calleeNonce: n(), callKey: id2.pub, fingerprints: [fp('C')] }),
    offer: sig('offer', { sdp }, { seq: 1, th }),
    answer: sig('answer', { sdp, offerHash: h1 }, { seq: 1, th }),
    candidates: sig('candidates', { candidates: [{ candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host', sdpMid: '0', sdpMLineIndex: 0 }, { candidate: 'x' }], end: false }, { seq: 2, th }),
    confirm: sig('confirm', { fingerprints: { local: fp('A'), remote: fp('C') }, nonces: { caller: n(), callee: n() }, offerHash: h1, answerHash: h2 }, { seq: 3, th }),
    end: sig('end', { reason: 'hangup' }, { seq: 4 }),
    cancel: sig('cancel', {}, { seq: 1 }),
    decline: sig('decline', { reason: 'declined' }),
    busy: sig('busy', { reason: 'busy' })
  };
  const names = Object.keys(bases);

  // ---- canonical JSON and hashes ----
  const canon = [];
  const vectors = ['{"b":1,"a":2}', '[]', '{}', '[[],{}]', 'null', 'true', '"\\u0000\\u001f\\u007f\\u2028\\u2029\\/\\"\\\\\\b\\f\\n\\r\\t"', '"é😀ﬁ"', '{"😀":1,"ﬁ":2,"\\uffff":3,"a":4,"":5}', '{"10":1,"9":2,"a":3,"B":4}',
    '1', '1.0', '-0', '0.0', '1e0', '1E2', '1e21', '1e-7', '1e-6', '123456789012345678901234567890', '0.1', '0.30000000000000004', '5e-324', '1.7976931348623157e308', '1e999', '9007199254740993', '-9007199254740993', '4294967296', '100000000000000000000', '1e20', '123e-20',
    '{"a":{"b":{"c":[1,2,{"d":null}]}}}', '[1.5,2.50,100,1e2]'];
  for (const v of vectors) { canon.push({ op: 'canonicalize', raw: v }); canon.push({ op: 'hashOf', raw: v }); if (/^-?[\d.eE+-]+$/.test(v)) canon.push({ op: 'jsNumber', raw: v }); }
  const rv = (d) => {
    const t = ri(d > 3 ? 6 : 9);
    if (t === 0) return null;
    if (t === 1) return rnd() < 0.5;
    if (t === 2) return pick([0, 1, -1, 7, 255, 2 ** 31, 2 ** 53, -(2 ** 53), 1e21, 1e-7, 0.5, 123.456, 1e300, 5e-324, 4.35, 0.000001, 1e22, 123456789.123456789, ri(100000) / 100, (rnd() - 0.5) * 10 ** ri(30)]);
    if (t === 3) { let s = ''; const len = ri(8); for (let i = 0; i < len; i++) s += pick(['a', 'Z', '0', '"', '\\', '/', '\n', '\t', '\u0000', '\u001f', '\u007f', 'é', 'ﬁ', '￿', '😀', ' ', ' ']); return s; }
    if (t === 4) return pick(['', 'abc', 'x'.repeat(40)]);
    if (t === 5) return ri(1000);
    if (t === 6) return Array.from({ length: ri(4) }, () => rv(d + 1));
    const o = {}; const len = ri(5); for (let i = 0; i < len; i++) o[pick(['a', 'b', 'B', '1', '10', '9', 'é', '😀', 'ﬁ', '￿', '', 'ab', 'a b', 'aa'])] = rv(d + 1);
    return o;
  };
  for (let i = 0; i < 1500; i++) canon.push({ op: 'canonicalize', raw: JSON.stringify(rv(0)) });
  for (const k of ['a', 'b']) canon.push({ op: 'transcriptHash', raw: JSON.stringify({ invite: bases.invite, accept: bases.accept }) });
  for (const t of ['abc', 'AAAAAAAAAAAAAAAAAAAAAA', '', 'é', P.randomId(16)]) canon.push({ op: 'tagHash', str: t });
  await compare('canonical JSON, number formatting, key order, hashes', canon);

  // ---- time ----
  const times = [...TIMES, '2021-01-32T00:00:00.000Z', '2021-00-10T00:00:00.000Z', '2021-01-00T00:00:00.000Z', '2021-04-31T00:00:00.000Z', '2020-02-30T00:00:00.000Z', '2021-01-01T25:00:00.000Z', '2021-01-01T23:60:00.000Z', '2021-01-01T00:00:00.00Z', '2021-01-01T00:00:00.0000Z', '', 'x', '1970-01-01T00:00:00.000Z', '1969-12-31T23:59:59.999Z', '0000-02-29T00:00:00.000Z', '0001-01-01T00:00:00.000Z'];
  const pad = (x, w) => String(x).padStart(w, '0');
  for (let i = 0; i < 4000; i++) times.push(pad(pick([0, 1, 1969, 1970, 1999, 2000, 2024, 2026, 2100, 9999, ri(10000)]), 4) + '-' + pad(ri(15), 2) + '-' + pad(ri(35), 2) + 'T' + pad(ri(27), 2) + ':' + pad(ri(63), 2) + ':' + pad(ri(63), 2) + '.' + pad(ri(1000), 3) + 'Z');
  await compare('ISO time parsing agrees with Date.parse on every spelling', times.map((s) => ({ op: 'parseTime', str: s })));

  // ---- base64url and the lenient DER reader ----
  const b64 = ['', 'A', 'AB', 'ABC', 'ABCD', 'ABCDE', 'AB=', 'A-_B', 'A+/B', 'AB\n', ' AB', 'é', 'AAAA\n', P.randomId(64)];
  for (let i = 0; i < 300; i++) b64.push(P.randomId(ri(70)).slice(0, ri(70)));
  await compare('base64url decoding accepts and refuses the same strings', b64.map((s) => ({ op: 'b64urlDecode', str: s })));
  const ders = [];
  const r32 = () => Array.from({ length: 32 }, () => ri(256));
  for (let i = 0; i < 1200; i++) {
    let d = Array.from(rawToDer(Uint8Array.from(r32().concat(r32()))));
    const m = ri(8);
    if (m === 1) d[0] = ri(256);
    else if (m === 2) d[1] = ri(256);
    else if (m === 3) d = d.slice(0, ri(d.length));
    else if (m === 4) d = d.concat(Array.from({ length: ri(6) }, () => ri(256)));
    else if (m === 5) d[ri(d.length)] = ri(256);
    else if (m === 6) { const pos = d.indexOf(2, 2); d.splice(pos + 2, 0, 0, 0); d[pos + 1] += 2; }
    else if (m === 7) { d.splice(1, 1, 0x81, d[1]); }
    ders.push({ op: 'derToRaw', str: P.b64urlEncode(Uint8Array.from(d)) });
  }
  await compare('the lenient DER signature reader agrees on valid and damaged input', ders);

  // ---- payload schemas ----
  const pcases = [];
  for (const k of names) {
    pcases.push({ op: 'validatePayload', raw: ser(bases[k]) });
    for (let i = 0; i < ROUNDS; i++) { let m = bases[k]; const steps = 1 + (rnd() < 0.2 ? 1 : 0); for (let s = 0; s < steps; s++) m = mutate(m); pcases.push({ op: 'validatePayload', raw: ser(m) }); }
  }
  for (const v of ['null', '1', '"x"', '[]', '{}', '{"type":1}', '{"type":"nope"}', '{"type":"atlas.call.signal"}', '[{"type":"atlas.call.tag-list"}]']) pcases.push({ op: 'validatePayload', raw: v });
  const php1 = await compare('payload schema validation (every message type, seeded mutations)', pcases);
  const accepted = php1.filter((r) => r && r.ok).length;
  check('the mutation run covers both accepted and refused payloads', accepted > names.length && accepted < pcases.length - 100, { accepted, total: pcases.length });
  const reasons = new Set(php1.filter((r) => r && !r.ok).map((r) => r.reason));
  check('the run produced every refusal reason', ['bad-schema', 'bad-body', 'bad-lifetime'].every((r) => reasons.has(r)), [...reasons]);

  // ---- signatures ----
  const scases = [], ecases = [];
  const keyBytes = (p) => { try { return P.b64urlDecode(p.publicKey); } catch (e) { return null; } };
  const isStricter = (proof) => {
    if (!proof || typeof proof !== 'object' || typeof proof.publicKey !== 'string') return false;
    const kb = keyBytes(proof);
    if (!kb) return false;
    if (proof.signerRole === 'webauthn') return kb.length !== 91;
    if (proof.signerRole === 'raw-ecdsa') return kb.length !== 65 || kb[0] !== 4;
    return false;
  };
  const pushSigned = async (payload, proof) => scases.push({ op: 'verifySigned', raw: '{"payload":' + ser(payload) + ',"proof":' + ser(proof) + '}', stricter: isStricter(proof) || undefined });
  for (const k of names) {
    const proof = await sign(bases[k], id);
    await pushSigned(bases[k], proof);
    await pushSigned(bases[k], await webauthnEnvelope(bases[k]));
    await pushSigned(bases[k], await sign(bases[k], id2));
    await pushSigned(bases.list, proof);
    for (let i = 0; i < ROUNDS; i++) {
      const m = mutate(bases[k]);
      await pushSigned(m, proof);
      const parsed = JSON.parse(ser(m));
      if (parsed && typeof parsed === 'object') {
        const signed = await sign(parsed, id);
        await pushSigned(parsed, signed);
        if (i % 6 === 0) await pushSigned(parsed, await webauthnEnvelope(parsed));
      }
    }
    for (let i = 0; i < 40; i++) {
      const proof2 = mutate(i % 2 ? proof : await webauthnEnvelope(bases[k]));
      await pushSigned(bases[k], proof2);
      ecases.push({ op: 'validateEnvelope', raw: ser(proof2) });
    }
  }
  for (const o of [{ flags: 0 }, { flags: 1 }, { flags: 4 }, { flags: 0x45 }, { flags: 0x80 }, { flags: 0xFE }, { authLen: 36 }, { authLen: 37 }, { authLen: 80 }, { cd: { type: 'webauthn.create' } }, { cd: { type: 'webauthn.get' } }, { cd: { challenge: 'x' } }, { cd: { type: 5 } }]) {
    await pushSigned(bases.list, await webauthnEnvelope(bases.list, o));
    await pushSigned(bases.poll, await webauthnEnvelope(bases.poll, o));
  }
  const wa = await webauthnEnvelope(bases.list);
  for (const over of [{ type: 'webauthn.create' }, { challenge: 'x' }]) {
    const cd = JSON.parse(Buffer.from(wa.clientDataJSON, 'base64url').toString());
    await pushSigned(bases.list, Object.assign({}, wa, { clientDataJSON: Buffer.from(JSON.stringify(Object.assign(cd, over))).toString('base64url') }));
  }
  for (const m of [null, 1, 'x', [], {}, { payload: null }, { payload: {}, proof: null }, { payload: bases.list }, { payload: bases.list, proof: 'x' }, { payload: bases.list, proof: 0 }, { payload: bases.list, proof: {} }, { payload: 'x', proof: {} }]) scases.push({ op: 'verifySigned', raw: JSON.stringify(m) });
  const php2 = await compare('signed-message verification: raw and passkey envelopes, bad signatures, mutated payloads and proofs', scases);
  check('the signature run covers accepted messages', php2.filter((r) => r && r.ok).length >= names.length * 2, php2.filter((r) => r && r.ok).length);
  check('the signature run produced every refusal reason', ['bad-schema', 'bad-body', 'bad-lifetime', 'bad-signature'].every((r) => new Set(php2.filter((x) => x && !x.ok).map((x) => x.reason)).has(r)));
  await compare('envelope shape validation', ecases);

  // ---- ICE URLs ----
  const hosts = ['example.org', 'turn.example.org', 'a.b.c.d', '1.2.3.4', '8.8.8.8', '10.0.0.1', '127.0.0.1', '0.0.0.0', '100.64.0.1', '100.128.0.1', '169.254.1.1', '172.16.0.1', '172.32.0.1', '192.168.1.1', '192.0.0.1', '192.0.2.1', '198.18.0.1', '198.20.0.1', '224.0.0.1', '255.255.255.255', '256.1.1.1', '1.2.3', '01.02.03.04', '0x7f.0.0.1', '1.2.3.0x7f', '2130706433', 'localhost', 'host.local', 'a.internal', 'x.lan', 'x.home.arpa', 'x.corp', 'x.intranet', 'host', '-bad.example', 'bad-.example', 'a..b', '.a', 'a.', 'a_b.example', 'x'.repeat(64) + '.example', 'x'.repeat(63) + '.example', '[::1]', '[::]', '[fe80::1]', '[fc00::1]', '[fd12::1]', '[ff02::1]', '[2001:db8::1]', '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[::ffff:808:808]', '[::ffff:a00:1]', '[1.2.3.4]', '[abc]', '[]', '[::ffff:999.1.1.1]', 'EXAMPLE.ORG', 'Turn.Example.Org', 'a.0x1', 'a.12', 'a.1a'];
  const ports = ['', ':80', ':443', ':3478', ':5349', ':0', ':1', ':65535', ':65536', ':99999', ':00080', ':8080', ':x', ':'];
  const tails = ['', '?transport=udp', '?transport=tcp', '?transport=x', '?transport=UDP', '?x=1', '\n', ' ', '/'];
  const urls = [];
  for (const s of ['stun', 'stuns', 'turn', 'turns', 'TURN', 'http', '']) for (let i = 0; i < 220; i++) urls.push(s + ':' + pick(hosts) + pick(ports) + pick(tails));
  urls.push('', 'x', 'turn:', 'turn:' + 'a'.repeat(260), 'turn:example.org:3478' + '?transport=tcp'.repeat(2), 'stun:' + 'a.'.repeat(130));
  const icases = [];
  for (const u of urls) {
    icases.push({ op: 'parseIceUrl', str: u });
    for (const kind of ['stun', 'turn', undefined]) for (const allowPrivate of [false, true]) icases.push({ op: 'iceUrlProblem', str: u, opts: { kind, allowPrivate } });
  }
  for (const h of hosts.concat(['[::FFFF:7F00:1]', '[FE80::1]', '[Fd00::1]'])) icases.push({ op: 'privateHost', str: h });
  await compare('ICE URL parsing, private-address and port rules', icases);

  // ---- the shared constants ----
  const consts = spawnSync('php', ['-r', 'require "' + path.join(__dirname, '..', 'call-php', 'atlas', 'call', 'lib', 'protocol.php') + '"; echo json_encode(["L"=>CallProto::LIMITS,"B"=>CallProto::BODY_MAX,"E"=>CallProto::END_REASONS,"S"=>CallProto::SIGNAL_KINDS,"C"=>CallProto::CK_KINDS,"I"=>CallProto::ICE_LIMITS,"T"=>CallProto::ICE_TURN_PORTS]);'], { encoding: 'utf8' });
  const pc = JSON.parse(consts.stdout);
  check('PHP and Node limits are the same numbers', JSON.stringify(Object.entries(P.LIMITS).filter(([k]) => k !== 'bodyMax').sort()) === JSON.stringify(Object.entries(pc.L).sort()), { node: P.LIMITS, php: pc.L });
  check('PHP and Node request body limits are the same', P.canonicalize(P.LIMITS.bodyMax) === P.canonicalize(pc.B));
  check('PHP and Node end reasons, signal kinds, call-key kinds and ICE limits are the same', JSON.stringify([P.END_REASONS, P.SIGNAL_KINDS, P.CK_KINDS, P.ICE_LIMITS, P.ICE_TURN_PORTS]) === JSON.stringify([pc.E, pc.S, pc.C, pc.I, pc.T]));

  process.exit(finish('call-php-protocol'));
})().catch((e) => { console.error(e); process.exit(1); });
