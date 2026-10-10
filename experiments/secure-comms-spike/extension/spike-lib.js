// Helpers for the secure-comms feasibility spike. Loaded by the test
// extension's call page and by the Node unit tests (UMD, no dependencies).
//
// Everything here uses synthetic test keys and standard WebCrypto. It is a
// feasibility probe for the fingerprint-binding idea, not the Atlas calling
// protocol: message shapes are simplified and unreviewed.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SpikeLib = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const subtle = (globalThis.crypto && globalThis.crypto.subtle);
  const enc = new TextEncoder();

  function b64urlEncode(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64urlDecode(str) {
    const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
    const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // Sorted keys at every level, no whitespace: the same canonical form the
  // wallet uses for signed payloads.
  function canonicalize(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
  }

  async function sha256Bytes(bytes) {
    return new Uint8Array(await subtle.digest('SHA-256', bytes));
  }
  async function sha256B64url(text) {
    return b64urlEncode(await sha256Bytes(enc.encode(text)));
  }
  // "AB:CD:..." in upper case, the spelling SDP and certificate stats use.
  function toColonHex(bytes) {
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join(':').toUpperCase();
  }
  async function certFingerprintSha256(derBytes) {
    return toColonHex(await sha256Bytes(derBytes instanceof Uint8Array ? derBytes : new Uint8Array(derBytes)));
  }

  // ---------- synthetic test keys (ECDSA P-256, raw r||s signatures) ----------

  async function generateTestKeyPair(extractablePrivate) {
    const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, !!extractablePrivate, ['sign', 'verify']);
    const publicKey = b64urlEncode(await subtle.exportKey('raw', pair.publicKey));
    return { privateKey: pair.privateKey, publicKey };
  }
  async function signJson(privateKey, payload) {
    const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, enc.encode(canonicalize(payload)));
    return b64urlEncode(sig);
  }
  async function verifyJson(publicKeyB64, payload, signatureB64) {
    try {
      const key = await subtle.importKey('raw', b64urlDecode(publicKeyB64), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      return await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64urlDecode(signatureB64), enc.encode(canonicalize(payload)));
    } catch (err) {
      return false;
    }
  }

  // ---------- SDP handling (strict, for the binding experiment) ----------

  const FP_LINE = /^a=fingerprint:(\S+) ([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2})*)\s*$/;

  function sdpLines(sdp) {
    return String(sdp).split(/\r?\n/).filter((l) => l.length);
  }
  // Every a=fingerprint line at session or media level, in order.
  function parseSdpFingerprints(sdp) {
    const out = [];
    for (const line of sdpLines(sdp)) {
      if (!line.startsWith('a=fingerprint:')) continue;
      const m = FP_LINE.exec(line);
      out.push(m ? { algorithm: m[1].toLowerCase(), value: m[2].toUpperCase(), line } : { algorithm: null, value: null, line, malformed: true });
    }
    return out;
  }

  // Refuses anything the design says must not appear, then requires the SDP's
  // fingerprints to be exactly the signed set. Returns {ok, reason}.
  function checkSdpAgainstFingerprints(sdp, signedFingerprints, options) {
    const opts = options || {};
    const maxBytes = opts.maxBytes || 16384;
    if (typeof sdp !== 'string' || !sdp.length) return { ok: false, reason: 'empty-sdp' };
    if (sdp.length > maxBytes) return { ok: false, reason: 'sdp-too-large' };
    const lines = sdpLines(sdp);
    if (lines[0] !== 'v=0') return { ok: false, reason: 'not-sdp' };
    for (const l of lines) {
      if (l.startsWith('a=crypto:')) return { ok: false, reason: 'sdes-present' };
      if (l.startsWith('a=identity:')) return { ok: false, reason: 'identity-attribute-present' };
      if (l.startsWith('a=candidate:')) return { ok: false, reason: 'candidate-in-sdp' };
    }
    const media = lines.filter((l) => l.startsWith('m='));
    if (media.length !== 1 || !/^m=audio \d+ UDP\/TLS\/RTP\/SAVPF /.test(media[0])) return { ok: false, reason: 'unexpected-media-sections' };
    const found = parseSdpFingerprints(sdp);
    if (!found.length) return { ok: false, reason: 'no-fingerprint' };
    if (found.some((f) => f.malformed)) return { ok: false, reason: 'malformed-fingerprint' };
    if (found.some((f) => f.algorithm !== 'sha-256')) return { ok: false, reason: 'unsupported-hash' };
    const allowed = new Set((signedFingerprints || []).map((f) => String(f).toUpperCase()));
    if (!allowed.size) return { ok: false, reason: 'no-signed-fingerprint' };
    for (const f of found) if (!allowed.has(f.value)) return { ok: false, reason: 'fingerprint-not-signed' };
    return { ok: true, fingerprints: found.map((f) => f.value) };
  }

  // ---------- simplified binding message (not the Atlas protocol) ----------

  function randomId(bytes) {
    return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes || 16)));
  }

  async function makeSignedBinding(identityPrivateKey, identityPublicKey, fields) {
    const payload = Object.assign({ type: 'spike.binding', v: 1, nonce: randomId(16), issuedAt: Date.now(), expiresAt: Date.now() + 60000 }, fields);
    return { payload, publicKey: identityPublicKey, signature: await signJson(identityPrivateKey, payload) };
  }

  // expectedPublicKey: the key the verifier already holds for that peer.
  async function verifySignedBinding(signed, expectedPublicKey, expected, now) {
    if (!signed || !signed.payload || typeof signed.signature !== 'string') return { ok: false, reason: 'malformed' };
    if (signed.publicKey !== expectedPublicKey) return { ok: false, reason: 'unexpected-signer' };
    if (!(await verifyJson(signed.publicKey, signed.payload, signed.signature))) return { ok: false, reason: 'bad-signature' };
    const p = signed.payload;
    if (p.type !== 'spike.binding' || p.v !== 1) return { ok: false, reason: 'wrong-type' };
    const t = now || Date.now();
    if (!(p.issuedAt <= t + 30000) || !(p.expiresAt + 30000 >= t)) return { ok: false, reason: 'stale' };
    if (expected) {
      for (const k of Object.keys(expected)) if (p[k] !== expected[k]) return { ok: false, reason: 'field-mismatch:' + k };
    }
    if (!Array.isArray(p.fingerprints) || !p.fingerprints.length) return { ok: false, reason: 'no-fingerprints' };
    return { ok: true, payload: p };
  }

  return {
    b64urlEncode, b64urlDecode, canonicalize, sha256Bytes, sha256B64url, toColonHex, certFingerprintSha256,
    generateTestKeyPair, signJson, verifyJson,
    parseSdpFingerprints, checkSdpAgainstFingerprints,
    randomId, makeSignedBinding, verifySignedBinding
  };
});
