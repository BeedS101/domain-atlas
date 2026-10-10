// Unit tests for the shared call protocol module: schemas, envelopes (raw and passkey),
// SDP binding, remote-certificate matching, safety codes, and parity of the two copies.
// Run: node test/manual-call-protocol.js
'use strict';
const fs = require('fs');
const path = require('path');
const T = require('./call-test-lib');
const { P, check, newIdentity, sign, iso, fp } = T;

function rawToDer(raw) {
  const enc = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; b = b.slice(i); if (b[0] & 0x80) b = Uint8Array.from([0, ...b]); return b; };
  const r = enc(raw.slice(0, 32)), s = enc(raw.slice(32));
  return Uint8Array.from([0x30, 4 + r.length + s.length, 2, r.length, ...r, 2, s.length, ...s]);
}

(async () => {
  // ---- parity ----
  const a = fs.readFileSync(path.join(__dirname, '..', 'extension', 'call-protocol.js'));
  const b = fs.readFileSync(path.join(__dirname, '..', 'call-server', 'protocol.js'));
  check('the wallet and Call Service copies of the protocol module are byte-identical', a.equals(b));

  // ---- canonicalization agrees with the issuer server ----
  const issuerSrc = fs.readFileSync(path.join(__dirname, '..', 'issuer-server', 'server.js'), 'utf8');
  const m = /function canonicalize\(value\) \{[\s\S]*?\n\}/.exec(issuerSrc);
  const issuerCanon = new Function(m[0] + '; return canonicalize;')();
  const sample = { z: [3, { b: 1, a: 'é"\\' }], a: null, m: { y: true, x: 1.5 } };
  check('canonical JSON equals the issuer server\'s canonicalize', P.canonicalize(sample) === issuerCanon(sample));

  // ---- raw envelope ----
  const id = await newIdentity();
  const base = { type: 'atlas.call.tag-list', v: 1, audience: 'https://calls.example.com', issuedAt: iso(Date.now()), nonce: P.randomId(16) };
  let proof = await sign(base, id);
  check('a raw-ecdsa envelope verifies', (await P.verifyEnvelope(base, proof)) === true);
  check('an edited payload fails verification', (await P.verifyEnvelope(Object.assign({}, base, { nonce: P.randomId(16) }), proof)) === false);
  check('an envelope with extra fields is refused', (await P.verifyEnvelope(base, Object.assign({}, proof, { extra: 1 }))) === false);
  check('garbage never throws', (await P.verifyEnvelope(base, { signerRole: 'raw-ecdsa', publicKey: 'x', signature: '!' })) === false);

  // ---- passkey envelope ----
  {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey));
    const challenge = P.b64urlEncode(await P.sha256Bytes(new TextEncoder().encode(P.canonicalize(base))));
    const make = async (over) => {
      const clientData = new TextEncoder().encode(JSON.stringify(Object.assign({ type: 'webauthn.get', challenge, origin: 'chrome-extension://x' }, over && over.cd)));
      const auth = new Uint8Array(37); auth[32] = (over && over.flags !== undefined) ? over.flags : 0x01;
      const hash = await P.sha256Bytes(clientData);
      const signed = new Uint8Array(auth.length + hash.length); signed.set(auth); signed.set(hash, auth.length);
      const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, signed));
      return { signerRole: 'webauthn', publicKey: P.b64urlEncode(spki), signature: P.b64urlEncode(rawToDer(sig)), clientDataJSON: P.b64urlEncode(clientData), authenticatorData: P.b64urlEncode(auth) };
    };
    check('a passkey assertion with user-present verifies', (await P.verifyEnvelope(base, await make())) === true);
    check('a passkey assertion without the user-present flag is refused', (await P.verifyEnvelope(base, await make({ flags: 0 }))) === false);
    check('a passkey registration (webauthn.create) is not accepted as a signature', (await P.verifyEnvelope(base, await make({ cd: { type: 'webauthn.create' } }))) === false);
    check('a passkey assertion over a different payload is refused', (await P.verifyEnvelope(Object.assign({}, base, { nonce: P.randomId(16) }), await make())) === false);
  }

  // ---- payload schemas ----
  const origin = 'https://calls.example.com';
  const inv = { type: 'atlas.call.invite', v: 1, audience: origin, issuedAt: iso(Date.now()), expiresAt: iso(Date.now() + 30000), nonce: P.randomId(16), callId: P.randomId(16), tag: P.randomId(16), caller: { kind: 'wallet', publicKey: id.pub }, callee: { publicKey: id.pub }, callKey: id.pub, media: { kind: 'audio', fingerprints: [fp('A')] } };
  check('a well-formed invite passes the schema', P.validatePayload(inv).ok === true, P.validatePayload(inv));
  const bad = (name, mut) => { const c = JSON.parse(JSON.stringify(inv)); mut(c); check('invite schema rejects ' + name, P.validatePayload(c).ok === false); };
  bad('an unknown field', (c) => { c.x = 1; });
  bad('a purpose field', (c) => { c.purpose = 'x'; });
  bad('a missing audience', (c) => { delete c.audience; });
  bad('a lifetime over 60 seconds', (c) => { c.expiresAt = iso(Date.now() + 90000); });
  bad('an expiry before issue', (c) => { c.expiresAt = iso(Date.now() - 5000); });
  bad('a fingerprint in the wrong form', (c) => { c.media.fingerprints = ['sha-256 ab:cd']; });
  bad('a non-audio media kind', (c) => { c.media.kind = 'video'; });
  bad('a caller kind other than wallet', (c) => { c.caller.kind = 'domain'; });
  bad('a short nonce', (c) => { c.nonce = 'abc'; });
  bad('a time without milliseconds', (c) => { c.issuedAt = '2026-10-10T10:00:00Z'; });
  check('an unknown payload type is refused', P.validatePayload({ type: 'atlas.call.other' }).ok === false);
  check('a payload that is not an object is refused', P.validatePayload(null).ok === false && P.validatePayload('x').ok === false);

  const sig = (kind, body, extra) => Object.assign({ type: 'atlas.call.signal', v: 1, audience: origin, callId: P.randomId(16), kind, body }, extra);
  check('offer needs seq and th', P.validatePayload(sig('offer', { sdp: 'v=0\r\n' + 'x'.repeat(30) }, { seq: 1, th: P.randomId(32) })).ok && !P.validatePayload(sig('offer', { sdp: 'v=0\r\n' + 'x'.repeat(30) }, { seq: 1 })).ok);
  check('accept must not carry seq or th', P.validatePayload(sig('accept', { inviteHash: P.randomId(32), calleeNonce: P.randomId(16), callKey: id.pub, fingerprints: [fp('B')] })).ok && !P.validatePayload(sig('accept', { inviteHash: P.randomId(32), calleeNonce: P.randomId(16), callKey: id.pub, fingerprints: [fp('B')] }, { seq: 1 })).ok);
  check('decline must not carry seq', !P.validatePayload(sig('decline', { reason: 'declined' }, { seq: 1 })).ok && P.validatePayload(sig('decline', { reason: 'declined' })).ok);
  check('an unknown end reason is refused', !P.validatePayload(sig('end', { reason: 'because' }, { seq: 2, th: P.randomId(32) })).ok);
  check('cancel may omit th', P.validatePayload(sig('cancel', {}, { seq: 1 })).ok);
  check('tag-revoke needs exactly one of tag or all', !P.validatePayload({ type: 'atlas.call.tag-revoke', v: 1, audience: origin, issuedAt: iso(Date.now()), nonce: P.randomId(16) }).ok && !P.validatePayload({ type: 'atlas.call.tag-revoke', v: 1, audience: origin, issuedAt: iso(Date.now()), nonce: P.randomId(16), tag: P.randomId(16), all: true }).ok);

  // ---- hashes ----
  const h1 = await P.payloadHash(inv);
  check('payload hash is unpadded base64url SHA-256', /^[A-Za-z0-9_-]{43}$/.test(h1));
  check('the transcript hash depends on both payloads', (await P.transcriptHash(inv, { a: 1 })) !== (await P.transcriptHash(inv, { a: 2 })) && (await P.transcriptHash(inv, { a: 1 })) !== (await P.transcriptHash({ b: 1 }, { a: 1 })));
  check('the tag hash is domain separated from a plain hash', (await P.tagHash('abc')) !== P.b64urlEncode(await P.sha256Bytes(new TextEncoder().encode('abc'))));

  // ---- SDP binding ----
  const F = fp('A');
  const sdpFor = (extra, fpLine) => ['v=0', 'o=- 1 1 IN IP4 0.0.0.0', 's=-', 't=0 0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=' + (fpLine || 'fingerprint:sha-256 ' + F.slice(8))].concat(extra || []).join('\r\n') + '\r\n';
  check('an SDP carrying only the signed fingerprint passes', P.checkSdpAgainstFingerprints(sdpFor(), [F]).ok === true);
  check('the comparison ignores case', P.checkSdpAgainstFingerprints(sdpFor([], 'fingerprint:sha-256 ' + F.slice(8).toLowerCase()), [F]).ok === true);
  check('a substituted fingerprint is refused', P.checkSdpAgainstFingerprints(sdpFor(), [fp('Z')]).reason === 'fingerprint-not-signed');
  check('an extra unsigned fingerprint line is refused', P.checkSdpAgainstFingerprints(sdpFor(['a=fingerprint:sha-256 ' + fp('Q').slice(8)]), [F]).reason === 'fingerprint-not-signed');
  check('SDES key material is refused', P.checkSdpAgainstFingerprints(sdpFor(['a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:xxxx']), [F]).reason === 'sdes-present');
  check('an identity attribute is refused', P.checkSdpAgainstFingerprints(sdpFor(['a=identity:abc']), [F]).reason === 'identity-attribute-present');
  check('candidates inside the SDP are refused', P.checkSdpAgainstFingerprints(sdpFor(['a=candidate:1 1 udp 1 10.0.0.1 5000 typ host']), [F]).reason === 'candidate-in-sdp');
  check('a second media section is refused', P.checkSdpAgainstFingerprints(sdpFor(['m=video 9 UDP/TLS/RTP/SAVPF 96']), [F]).reason === 'unexpected-media-sections');
  check('a non-DTLS media transport is refused', P.checkSdpAgainstFingerprints(sdpFor().replace('UDP/TLS/RTP/SAVPF', 'RTP/AVP'), [F]).reason === 'unexpected-media-sections');
  check('a missing fingerprint is refused', P.checkSdpAgainstFingerprints('v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n', [F]).reason === 'no-fingerprint');
  check('a sha-1 fingerprint is refused', P.checkSdpAgainstFingerprints(sdpFor([], 'fingerprint:sha-1 AA:BB'), [F]).reason === 'unsupported-hash');
  check('an SDP with no signed fingerprints to compare to is refused', P.checkSdpAgainstFingerprints(sdpFor(), []).reason === 'no-signed-fingerprint');
  check('text that is not SDP is refused', P.checkSdpAgainstFingerprints('hello', [F]).reason === 'not-sdp');

  // ---- remote certificate ----
  const hex = F.slice(8);
  check('a remote certificate equal to the signed fingerprint passes (any case)', P.remoteCertMatches([[hex.toLowerCase()]], [F]).ok === true);
  check('a different remote certificate fails', P.remoteCertMatches([[fp('Z').slice(8)]], [F]).reason === 'remote-cert-mismatch');
  check('an unknown remote certificate (no data) fails closed', P.remoteCertMatches([[]], [F]).reason === 'remote-cert-unknown' && P.remoteCertMatches([], [F]).ok === false);
  check('two sources must agree', P.remoteCertMatches([[hex], [fp('Z').slice(8)]], [F]).reason === 'remote-cert-mismatch');
  check('an empty source does not block a matching one', P.remoteCertMatches([[], [hex]], [F]).ok === true);

  // ---- candidate addresses ----
  const cand = (addr) => 'candidate:1 1 udp 2122260223 ' + addr + ' 54321 typ host';
  const allowed = ['192.168.1.20', '10.0.0.5', '172.16.4.9', '203.0.113.7', '2001:db8::1', 'fd00::5', '8f3a6c1e-2b7d-4c55-9a0e-1d2c3b4a5f60.local'];
  const refused = ['127.0.0.1', '127.5.5.5', '0.0.0.0', '169.254.169.254', '224.0.0.251', '239.1.1.1', '255.255.255.255', '::1', '::', 'fe80::1', 'febf::1', 'ff02::fb', '::ffff:127.0.0.1', '::ffff:169.254.1.1', 'localhost', 'example.com', 'internal.local', '999.1.1.1', ''];
  check('ordinary private, public and mDNS candidate addresses are allowed', allowed.every((a) => P.candidateAddressAllowed(cand(a))), allowed.filter((a) => !P.candidateAddressAllowed(cand(a))));
  check('loopback, link-local, multicast, unspecified addresses and arbitrary names are refused', refused.every((a) => !P.candidateAddressAllowed(cand(a))), refused.filter((a) => P.candidateAddressAllowed(cand(a))));
  check('a non-string or truncated candidate line is refused', !P.candidateAddressAllowed(null) && !P.candidateAddressAllowed('candidate:1 1 udp'));

  // ---- safety code ----
  const k1 = (await newIdentity()).pub, k2 = (await newIdentity()).pub, k3 = (await newIdentity()).pub;
  const sc = await P.safetyCode(k1, k2);
  check('the safety code is six groups of five digits', /^\d{5}( \d{5}){5}$/.test(sc), sc);
  check('both contacts compute the same code', sc === (await P.safetyCode(k2, k1)));
  check('a different key gives a different code', sc !== (await P.safetyCode(k1, k3)));

  // ---- call card ----
  const card = { type: 'atlas.call.card', v: 1, service: origin, tag: P.randomId(16), calleeKey: id.pub, expiresAt: iso(Date.now() + 1e6), issuedAt: iso(Date.now()) };
  check('a well-formed call card validates', P.validateCardPayload(card) === true);
  check('a card with an extra field is refused', P.validateCardPayload(Object.assign({}, card, { x: 1 })) === false);
  check('freshness and invite time rules', P.freshForService({ issuedAt: iso(Date.now() - 100000) }) && !P.freshForService({ issuedAt: iso(Date.now() - 200000) }) && P.inviteTimeOk({ issuedAt: iso(Date.now()), expiresAt: iso(Date.now() + 30000) }) && !P.inviteTimeOk({ issuedAt: iso(Date.now() + 60000), expiresAt: iso(Date.now() + 90000) }) && !P.inviteTimeOk({ issuedAt: iso(Date.now() - 120000), expiresAt: iso(Date.now() - 60000) }));

  process.exit(T.finish('manual-call-protocol'));
})().catch((e) => { console.error(e); process.exit(2); });
