// Domain Atlas secure voice calls: signed message formats and checks.
//
// One file, used unchanged by three parties:
//   - the wallet's call window (loaded as a script, global AtlasCallProtocol),
//   - the Call Service in call-server/ (a byte-identical copy, required as a module),
//   - the tests.
// It defines the wire shapes of docs/voice-calls-endpoints-and-state.md, the strict
// field checks every receiver applies, the hashes that tie messages together, the SDP
// check that binds DTLS certificates to signed fingerprints, and the contact safety
// code. It has no network or storage access and keeps no state, so the same rules can
// be ported to another language (a PHP polling Call Service) and compared by test.
//
// Nothing here encrypts anything: confidentiality of audio is DTLS-SRTP supplied by
// the browser. The only cryptography is SHA-256 hashing and ECDSA P-256 signature
// verification from WebCrypto.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AtlasCallProtocol = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const subtle = globalThis.crypto.subtle;
  const enc = new TextEncoder();

  // ---------- limits (docs/voice-calls-endpoints-and-state.md) ----------

  const LIMITS = {
    inviteTtlMs: 60000,          // expiresAt - issuedAt at most
    walletSkewMs: 30000,         // a wallet's tolerance for issuedAt / expiresAt
    serviceWindowMs: 120000,     // a request to the service must be this fresh
    nonceRetainMs: 150000,       // acceptance window plus the clock allowance
    listenSessionMs: 3600000,
    tagMaxAheadMs: 90 * 24 * 3600 * 1000,
    maxCallsPerTag: 100,
    maxTagsPerWallet: 200,
    sdpMaxBytes: 16384,
    candidatesPerMessage: 8,
    candidatesPerCall: 20,
    ackMax: 50,
    bodyMax: { 'tag/create': 8192, 'tag/revoke': 2048, 'tag/list': 2048, listen: 4096, invite: 12288, poll: 2048, signal: 20480, ice: 2048 }
  };

  const END_REASONS = ['declined', 'busy', 'noanswer', 'cancelled', 'unavailable', 'timeout', 'mic-denied', 'verify-failed', 'connect-failed', 'network-lost', 'hangup', 'policy-blocked', 'locked', 'window-closed', 'error'];
  const SIGNAL_KINDS = ['accept', 'offer', 'answer', 'candidates', 'confirm', 'end', 'cancel', 'decline', 'busy'];
  const CK_KINDS = ['offer', 'answer', 'candidates', 'confirm', 'end', 'cancel']; // signed by a call key, carry seq

  // ---------- encoding, canonical JSON, hashes ----------

  function b64urlEncode(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64urlDecode(str) {
    if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*$/.test(str)) throw new Error('bad base64url');
    const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
    const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // Same canonical form as SPEC.md section 6.2 and the wallet: sorted keys at every level.
  function canonicalize(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
  }
  async function sha256Bytes(bytes) { return new Uint8Array(await subtle.digest('SHA-256', bytes)); }
  async function hashOf(value) { return b64urlEncode(await sha256Bytes(enc.encode(canonicalize(value)))); }
  function randomId(bytes) { return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes || 16))); }

  // inviteHash, offerHash, answerHash: hash of that payload alone.
  const payloadHash = hashOf;
  // th: hash of the two identity-signed payloads together.
  async function transcriptHash(invitePayload, acceptPayload) {
    return hashOf({ invite: invitePayload, accept: acceptPayload });
  }
  // Callers' routing tags are bearer secrets; the service stores only this hash.
  async function tagHash(tag) { return b64urlEncode(await sha256Bytes(enc.encode('atlas.call.tag/v1:' + tag))); }

  // ---------- field checks ----------

  const B64U = /^[A-Za-z0-9_-]+$/;
  const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  const FP_RE = /^sha-256 ([0-9A-F]{2}:){31}[0-9A-F]{2}$/;
  const isStr = (v, min, max) => typeof v === 'string' && v.length >= min && v.length <= max;
  const isB64u = (v, min, max) => isStr(v, min, max) && B64U.test(v);
  const isTime = (v) => typeof v === 'string' && ISO_MS.test(v) && !Number.isNaN(Date.parse(v));
  const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
  const isKey = (v) => isB64u(v, 20, 200);   // identity keys: raw (87 chars) or spki (about 122)
  const isCallKey = (v) => isB64u(v, 87, 87); // call keys are raw P-256 public keys
  const isId128 = (v) => isB64u(v, 22, 22);   // 128 bits
  const isFp = (v) => typeof v === 'string' && FP_RE.test(v);

  // Exactly the listed fields, no others. `spec` maps field -> predicate, optional fields
  // are marked by a trailing '?' in the key.
  function strict(obj, spec) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    const names = new Set();
    for (const rawKey of Object.keys(spec)) {
      const optional = rawKey.endsWith('?');
      const name = optional ? rawKey.slice(0, -1) : rawKey;
      names.add(name);
      if (!(name in obj)) { if (optional) continue; return false; }
      if (!spec[rawKey](obj[name])) return false;
    }
    return Object.keys(obj).every((k) => names.has(k));
  }
  const arrayOf = (pred, max) => (v) => Array.isArray(v) && v.length >= 1 && v.length <= max && v.every(pred);

  const COMMON = (type) => ({
    type: (v) => v === type, v: (v) => v === 1,
    audience: (v) => isStr(v, 8, 200), issuedAt: isTime
  });
  const withNonce = (spec) => Object.assign({ nonce: (v) => isB64u(v, 16, 128) }, spec);
  const FPS = arrayOf(isFp, 2);

  const SCHEMAS = {
    'atlas.call.tag': Object.assign(withNonce(COMMON('atlas.call.tag')), {
      bind: (v) => strict(v, { kind: (x) => x === 'wallet', publicKey: isKey }),
      calleeKey: isKey, expiresAt: isTime, maxCalls: (v) => isInt(v, 1, LIMITS.maxCallsPerTag)
    }),
    'atlas.call.tag-revoke': Object.assign(withNonce(COMMON('atlas.call.tag-revoke')), { 'tag?': (v) => isId128(v), 'all?': (v) => v === true }),
    'atlas.call.tag-list': withNonce(COMMON('atlas.call.tag-list')),
    // `stop: true` ends the listening session at once, so a wallet that goes to Do not disturb or
    // locks is "unavailable" to callers immediately rather than after the listener goes stale.
    'atlas.call.listen': Object.assign(withNonce(COMMON('atlas.call.listen')), { ack: (v) => Array.isArray(v) && v.length <= LIMITS.ackMax && v.every((x) => isInt(x, 1, 2 ** 31)), 'stop?': (v) => v === true }),
    'atlas.call.listen-session': Object.assign(COMMON('atlas.call.listen-session'), { expiresAt: isTime, sessionKey: isCallKey }),
    'atlas.call.poll': Object.assign(withNonce(COMMON('atlas.call.poll')), { callId: isId128, after: (v) => isInt(v, 0, 2 ** 31) }),
    'atlas.call.ice': Object.assign(withNonce(COMMON('atlas.call.ice')), { callId: isId128 }),
    'atlas.call.invite': Object.assign(withNonce(COMMON('atlas.call.invite')), {
      callId: isId128, tag: isId128, expiresAt: isTime,
      caller: (v) => strict(v, { kind: (x) => x === 'wallet', publicKey: isKey }),
      callee: (v) => strict(v, { publicKey: isKey }),
      callKey: isCallKey,
      media: (v) => strict(v, { kind: (x) => x === 'audio', fingerprints: FPS })
    })
  };

  const SIGNAL_BODIES = {
    accept: { inviteHash: isId128Hash, calleeNonce: (v) => isB64u(v, 16, 128), callKey: isCallKey, fingerprints: FPS },
    offer: { sdp: (v) => isStr(v, 20, LIMITS.sdpMaxBytes) },
    answer: { sdp: (v) => isStr(v, 20, LIMITS.sdpMaxBytes), offerHash: isId128Hash },
    candidates: {
      candidates: (v) => Array.isArray(v) && v.length <= LIMITS.candidatesPerMessage && v.every((c) => strict(c, {
        candidate: (x) => isStr(x, 1, 400), 'sdpMid?': (x) => x === null || isStr(x, 0, 40), 'sdpMLineIndex?': (x) => x === null || isInt(x, 0, 8)
      })),
      end: (v) => typeof v === 'boolean'
    },
    confirm: {
      fingerprints: (v) => strict(v, { local: isFp, remote: isFp }),
      nonces: (v) => strict(v, { caller: (x) => isB64u(x, 16, 128), callee: (x) => isB64u(x, 16, 128) }),
      offerHash: isId128Hash, answerHash: isId128Hash
    },
    end: { reason: (v) => END_REASONS.includes(v) },
    cancel: {},
    decline: { reason: (v) => END_REASONS.includes(v) },
    busy: { reason: (v) => END_REASONS.includes(v) }
  };
  function isId128Hash(v) { return isB64u(v, 43, 43); } // SHA-256 as unpadded base64url

  function validateSignalPayload(p) {
    if (!strict(p, { type: (v) => v === 'atlas.call.signal', v: (v) => v === 1, audience: (v) => isStr(v, 8, 200), callId: isId128, kind: (v) => SIGNAL_KINDS.includes(v), 'seq?': (v) => isInt(v, 1, 100000), 'th?': isId128Hash, body: (v) => v && typeof v === 'object' })) return { ok: false, reason: 'bad-schema' };
    const bodySpec = SIGNAL_BODIES[p.kind];
    if (!strict(p.body, bodySpec)) return { ok: false, reason: 'bad-body' };
    if (p.kind === 'accept') {
      if ('seq' in p || 'th' in p) return { ok: false, reason: 'bad-schema' };
    } else if (CK_KINDS.includes(p.kind)) {
      if (!('seq' in p)) return { ok: false, reason: 'bad-schema' };
      // cancel and end may happen before an accept exists, so only they may omit th
      if (!('th' in p) && p.kind !== 'cancel' && p.kind !== 'end') return { ok: false, reason: 'bad-schema' };
    } else if ('seq' in p || 'th' in p) {
      return { ok: false, reason: 'bad-schema' };
    }
    return { ok: true };
  }

  function validateEnvelope(e) {
    if (!e || typeof e !== 'object') return false;
    if (e.signerRole === 'raw-ecdsa') return strict(e, { signerRole: (v) => v === 'raw-ecdsa', publicKey: isKey, signature: (v) => isB64u(v, 80, 100) });
    if (e.signerRole === 'webauthn') return strict(e, { signerRole: (v) => v === 'webauthn', publicKey: isKey, signature: (v) => isB64u(v, 60, 200), clientDataJSON: (v) => isB64u(v, 20, 2048), authenticatorData: (v) => isB64u(v, 50, 1024) });
    return false;
  }

  // Returns {ok, reason}. `type` is the payload's own `type`.
  function validatePayload(p) {
    if (!p || typeof p !== 'object' || typeof p.type !== 'string') return { ok: false, reason: 'bad-schema' };
    if (p.type === 'atlas.call.signal') return validateSignalPayload(p);
    const spec = SCHEMAS[p.type];
    if (!spec || !strict(p, spec)) return { ok: false, reason: 'bad-schema' };
    if (p.type === 'atlas.call.invite') {
      const ttl = Date.parse(p.expiresAt) - Date.parse(p.issuedAt);
      if (!(ttl > 0 && ttl <= LIMITS.inviteTtlMs)) return { ok: false, reason: 'bad-lifetime' };
    }
    if (p.type === 'atlas.call.listen-session') {
      const ttl = Date.parse(p.expiresAt) - Date.parse(p.issuedAt);
      if (!(ttl > 0 && ttl <= LIMITS.listenSessionMs)) return { ok: false, reason: 'bad-lifetime' };
    }
    if (p.type === 'atlas.call.tag-revoke' && (('tag' in p) === ('all' in p))) return { ok: false, reason: 'bad-schema' };
    if (p.type === 'atlas.call.tag') {
      const ahead = Date.parse(p.expiresAt) - Date.parse(p.issuedAt);
      if (!(ahead > 0 && ahead <= LIMITS.tagMaxAheadMs)) return { ok: false, reason: 'bad-lifetime' };
    }
    return { ok: true };
  }

  // ---------- signatures ----------

  function derToRawEcdsaSig(der) {
    const bytes = new Uint8Array(der);
    if (bytes.length < 8 || bytes[0] !== 0x30) throw new Error('malformed signature');
    let offset = 2;
    if (bytes[1] & 0x80) offset = 2 + (bytes[1] & 0x7f);
    function readInt() {
      if (bytes[offset] !== 0x02) throw new Error('malformed signature');
      offset++;
      const len = bytes[offset++];
      let val = bytes.slice(offset, offset + len);
      offset += len;
      while (val.length > 32 && val[0] === 0) val = val.slice(1);
      if (val.length > 32) throw new Error('malformed signature');
      const out = new Uint8Array(32);
      out.set(val, 32 - val.length);
      return out;
    }
    const r = readInt(); const s = readInt();
    const raw = new Uint8Array(64);
    raw.set(r, 0); raw.set(s, 32);
    return raw;
  }

  // Verifies an envelope over a payload (SPEC.md section 6.2) and returns true or false;
  // never throws. A passkey assertion must be a "get" assertion with the user-present
  // flag set; user verification is not required (the wallet creates passkeys with
  // userVerification "preferred"). Challenge = SHA-256 of the canonical payload.
  async function verifyEnvelope(payload, envelope) {
    try {
      if (!validateEnvelope(envelope)) return false;
      const data = enc.encode(canonicalize(payload));
      if (envelope.signerRole === 'raw-ecdsa') {
        const pub = await subtle.importKey('raw', b64urlDecode(envelope.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
        return await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, b64urlDecode(envelope.signature), data);
      }
      const dataHash = await sha256Bytes(data);
      const clientDataBuf = b64urlDecode(envelope.clientDataJSON);
      const clientData = JSON.parse(new TextDecoder().decode(clientDataBuf));
      if (clientData.type !== 'webauthn.get') return false;
      if (clientData.challenge !== b64urlEncode(dataHash)) return false;
      const authData = b64urlDecode(envelope.authenticatorData);
      if (authData.length < 37 || (authData[32] & 0x01) === 0) return false;
      const clientDataHash = await sha256Bytes(clientDataBuf);
      const signedData = new Uint8Array(authData.length + clientDataHash.length);
      signedData.set(authData, 0); signedData.set(clientDataHash, authData.length);
      const pub = await subtle.importKey('spki', b64urlDecode(envelope.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      return await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, derToRawEcdsaSig(b64urlDecode(envelope.signature)), signedData);
    } catch (err) {
      return false;
    }
  }

  // A signed message is {payload, proof}. This validates the shape, checks the signature,
  // and reports who signed. Callers then check that the signer is the right party.
  async function verifySigned(message) {
    if (!message || typeof message !== 'object' || !message.payload || !message.proof) return { ok: false, reason: 'bad-schema' };
    const shape = validatePayload(message.payload);
    if (!shape.ok) return shape;
    if (!(await verifyEnvelope(message.payload, message.proof))) return { ok: false, reason: 'bad-signature' };
    return { ok: true, signer: message.proof.publicKey, payload: message.payload };
  }

  // Freshness for a request to the service: issuedAt within `windowMs` of `now`.
  function freshForService(payload, now) {
    return Math.abs((now || Date.now()) - Date.parse(payload.issuedAt)) <= LIMITS.serviceWindowMs;
  }
  // A wallet judging an invitation: tighter, and bounded lifetime (checked by validatePayload).
  function inviteTimeOk(payload, now) {
    const t = now || Date.now();
    return Date.parse(payload.issuedAt) <= t + LIMITS.walletSkewMs && Date.parse(payload.expiresAt) >= t - LIMITS.walletSkewMs;
  }

  // ---------- SDP binding to signed fingerprints ----------

  const FP_LINE = /^a=fingerprint:(\S+) ([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2})*)\s*$/;
  function sdpLines(sdp) { return String(sdp).split(/\r?\n/).filter((l) => l.length); }

  // "AA:BB..." in any case -> the signed spelling "sha-256 AA:BB..." (upper case).
  // RTCCertificate.getFingerprints() is lower case in Chromium, the SDP is upper case.
  function normalizeFingerprint(algorithm, value) {
    return String(algorithm).toLowerCase() + ' ' + String(value).toUpperCase();
  }

  // Strict check of one SDP: refuses everything the design says must not appear, then
  // requires every fingerprint line to be one of the signed fingerprints (case-insensitive).
  function checkSdpAgainstFingerprints(sdp, signedFingerprints) {
    if (typeof sdp !== 'string' || !sdp.length) return { ok: false, reason: 'empty-sdp' };
    if (sdp.length > LIMITS.sdpMaxBytes) return { ok: false, reason: 'sdp-too-large' };
    const lines = sdpLines(sdp);
    if (lines[0] !== 'v=0') return { ok: false, reason: 'not-sdp' };
    for (const l of lines) {
      if (l.startsWith('a=crypto:')) return { ok: false, reason: 'sdes-present' };
      if (l.startsWith('a=identity:')) return { ok: false, reason: 'identity-attribute-present' };
      if (l.startsWith('a=candidate:')) return { ok: false, reason: 'candidate-in-sdp' };
      if (l.startsWith('a=end-of-candidates')) return { ok: false, reason: 'candidate-in-sdp' };
    }
    const media = lines.filter((l) => l.startsWith('m='));
    if (media.length !== 1 || !/^m=audio \d+ UDP\/TLS\/RTP\/SAVPF /.test(media[0])) return { ok: false, reason: 'unexpected-media-sections' };
    const found = [];
    for (const line of lines) {
      if (!line.startsWith('a=fingerprint:')) continue;
      const m = FP_LINE.exec(line);
      if (!m) return { ok: false, reason: 'malformed-fingerprint' };
      if (m[1].toLowerCase() !== 'sha-256') return { ok: false, reason: 'unsupported-hash' };
      found.push(normalizeFingerprint(m[1], m[2]));
    }
    if (!found.length) return { ok: false, reason: 'no-fingerprint' };
    const allowed = new Set((signedFingerprints || []).map((f) => normalizeFingerprint('sha-256', String(f).replace(/^sha-256 /i, ''))));
    if (!allowed.size) return { ok: false, reason: 'no-signed-fingerprint' };
    for (const f of found) if (!allowed.has(f)) return { ok: false, reason: 'fingerprint-not-signed' };
    return { ok: true, fingerprints: found };
  }

  // Remote DTLS certificate hashes (colon-hex SHA-256) against the signed fingerprints.
  // `sources` is a list of hash lists, one per independent way the browser exposed the
  // certificate (RTCDtlsTransport.getRemoteCertificates, getStats). An empty list means
  // "not known", never "matches": at least one source must be non-empty, every non-empty
  // source must match, and fail closed otherwise.
  function remoteCertMatches(sources, signedFingerprints) {
    const allowed = new Set((signedFingerprints || []).map((f) => String(f).replace(/^sha-256 /i, '').toUpperCase()));
    const known = (sources || []).filter((s) => Array.isArray(s) && s.length);
    if (!known.length) return { ok: false, reason: 'remote-cert-unknown' };
    for (const s of known) for (const h of s) if (!allowed.has(String(h).toUpperCase())) return { ok: false, reason: 'remote-cert-mismatch' };
    return { ok: true, sources: known.length };
  }

  // ---------- ICE candidate addresses ----------

  // Candidate lines come from the other side (and are only batch-signed, not verified), so the
  // browser is never asked to contact a loopback, link-local, multicast or unspecified address,
  // or to resolve an arbitrary name. A browser-generated mDNS host name (uuid.local) is allowed.
  function candidateAddressAllowed(line) {
    if (typeof line !== 'string') return false;
    const parts = line.split(' ');
    const addr = parts[4];
    if (!addr) return false;
    const v4 = (a) => {
      const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
      if (!m) return null;
      const o = m.slice(1).map(Number);
      if (o.some((n) => n > 255)) return false;
      if (o[0] === 0 || o[0] === 127 || (o[0] === 169 && o[1] === 254) || o[0] >= 224) return false;
      return true;
    };
    const direct = v4(addr);
    if (direct !== null) return direct;
    if (addr.includes(':')) {
      const a = addr.toLowerCase();
      const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
      if (mapped) return v4(mapped[1]) === true;
      if (!/^[0-9a-f:]+$/.test(a)) return false;
      if (a === '::' || a === '::1' || /^fe[89ab]/.test(a) || a.startsWith('ff')) return false;
      return true;
    }
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.local$/i.test(addr);
  }

  // ---------- ICE servers a service may hand to a wallet ----------

  // The Call Service names the STUN and TURN servers a browser should use, and a wallet applies
  // these rules before giving any of it to the browser. The same function checks an operator's own
  // settings. A private, loopback or link-local address, or a TURN port outside the usual ones, is
  // refused unless the person has switched on the private test network, so a service cannot point a
  // browser at a machine on its own network or at an arbitrary service port. Names are not resolved
  // here; a name that resolves to a private address cannot be told apart from any other.
  const ICE_TURN_PORTS = [80, 443, 3478, 5349];
  const ICE_LIMITS = { stunUrls: 3, turnUrls: 4, servers: 4, urlsPerServer: 16, minRemainingMs: 15000, maxRemainingMs: 25 * 3600 * 1000 };
  const ICE_URL_RE = /^(stun|stuns|turn|turns):(\[[0-9a-fA-F:.]{2,45}\]|[A-Za-z0-9.-]{1,253})(?::(\d{1,5}))?(?:\?transport=(udp|tcp))?$/;
  const HOST_LABEL_RE = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

  function ipv4Parts(host) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (!m) return null;
    const o = m.slice(1).map(Number);
    return o.every((n) => n <= 255) ? o : false;
  }
  function privateIpv4(o) {
    return o[0] === 0 || o[0] === 10 || o[0] === 127 || o[0] >= 224 || (o[0] === 100 && o[1] >= 64 && o[1] <= 127) ||
      (o[0] === 169 && o[1] === 254) || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168) ||
      (o[0] === 192 && o[1] === 0 && o[2] === 0) || (o[0] === 198 && (o[1] === 18 || o[1] === 19));
  }
  // True for an address or name that only means something on a local network.
  function privateHost(host) {
    const h = String(host).toLowerCase().replace(/^\[|\]$/g, '');
    const v4 = ipv4Parts(h);
    if (v4) return privateIpv4(v4);
    if (h.includes(':')) {
      if (h === '::' || h === '::1' || /^f[cd]/.test(h) || /^fe/.test(h) || h.startsWith('ff')) return true;
      const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
      if (dotted) { const o = ipv4Parts(dotted[1]); return !o || privateIpv4(o); }
      const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
      if (hex) { const a = parseInt(hex[1], 16), b = parseInt(hex[2], 16); return privateIpv4([a >> 8, a & 255, b >> 8, b & 255]); }
      return false;
    }
    return !h.includes('.') || /\.(localhost|local|internal|lan|home\.arpa|corp|intranet)$/.test(h);
  }
  // Splits an ICE server URL into its parts, or returns null when it is not of the accepted shape.
  function parseIceUrl(u) {
    if (typeof u !== 'string' || u.length > 300) return null;
    const m = ICE_URL_RE.exec(u);
    if (!m) return null;
    const scheme = m[1], host = m[2], transport = m[4] || null;
    const port = m[3] === undefined ? (scheme === 'stuns' || scheme === 'turns' ? 5349 : 3478) : Number(m[3]);
    if (!(port >= 1 && port <= 65535)) return null;
    if ((scheme === 'stun' || scheme === 'stuns') && transport) return null;
    if (scheme === 'turns' && transport === 'udp') return null;
    if (host.startsWith('[')) {
      if (!host.includes(':')) return null;
    } else if (/^[0-9.]+$/.test(host)) {
      if (!ipv4Parts(host)) return null;
    } else if (host.length > 253 || !host.split('.').every((l) => HOST_LABEL_RE.test(l))) return null;
    // A name whose last label is a number (0x7f.0.0.1, 1.2.3.0x7f) is an address in a form some
    // resolvers accept, not a hostname.
    else if (/^(0x[0-9a-f]*|\d+)$/i.test(host.split('.').pop())) return null;
    return { scheme, host, port, transport, turn: scheme === 'turn' || scheme === 'turns' };
  }
  // Why a URL cannot be used, or null. kind is 'stun' or 'turn'.
  function iceUrlProblem(u, o) {
    o = o || {};
    const p = parseIceUrl(u);
    if (!p) return 'is not of the form stun:host[:port] or turn:host[:port][?transport=udp|tcp] (turns: for TLS)';
    if (o.kind === 'stun' && p.turn) return 'is a TURN URL where STUN is expected';
    if (o.kind === 'turn' && !p.turn) return 'is a STUN URL where TURN is expected';
    if (!o.allowPrivate) {
      if (privateHost(p.host)) return 'names a private, loopback or local address';
      if (p.turn && !ICE_TURN_PORTS.includes(p.port)) return 'uses a TURN port other than ' + ICE_TURN_PORTS.join(', ');
    }
    return null;
  }
  const ICE_CREDENTIAL_RE = /^[A-Za-z0-9+/_-]{20,128}={0,2}$/;
  const ICE_USERNAME_RE = /^(\d{9,11})(?::[A-Za-z0-9_-]{1,64})?$/;

  // Reduces a service's ice answer to what a browser may be given. STUN URLs are kept (at most
  // three). TURN URLs are kept (at most four) only with a username and credential in the
  // time-limited form coturn's REST scheme uses and only while at least ICE_LIMITS.minRemainingMs
  // of the credential's life is left, measured against the service's own clock. Nothing is stored
  // or logged by this function; `dropped` holds reasons only, never a URL's credential.
  function iceServersFromAnswer(answer, o) {
    o = o || {};
    const out = { iceServers: [], turn: false, dropped: [], remainingMs: null };
    if (!answer || typeof answer !== 'object' || !Array.isArray(answer.iceServers)) return out;
    const stun = [];
    let turn = null;
    for (const s of answer.iceServers.slice(0, ICE_LIMITS.servers)) {
      if (!s || typeof s !== 'object' || !Array.isArray(s.urls)) { out.dropped.push('malformed-server'); continue; }
      for (const u of s.urls.slice(0, ICE_LIMITS.urlsPerServer)) {
        const p = parseIceUrl(u);
        if (!p) { out.dropped.push('malformed-url'); continue; }
        const why = iceUrlProblem(u, { kind: p.turn ? 'turn' : 'stun', allowPrivate: o.allowPrivate });
        if (why) { out.dropped.push(p.turn ? 'turn-refused' : 'stun-refused'); continue; }
        if (!p.turn) { if (!stun.includes(u) && stun.length < ICE_LIMITS.stunUrls) stun.push(u); continue; }
        if (turn && turn.source !== s) { out.dropped.push('second-turn-server'); continue; }
        if (!turn) turn = { source: s, urls: [] };
        if (!turn.urls.includes(u) && turn.urls.length < ICE_LIMITS.turnUrls) turn.urls.push(u);
      }
    }
    if (stun.length) out.iceServers.push({ urls: stun });
    if (!turn) return out;
    const s = turn.source;
    const serverMs = Date.parse(answer.serverTime), expiresMs = Date.parse(answer.credentialExpiresAt);
    const un = typeof s.username === 'string' ? ICE_USERNAME_RE.exec(s.username) : null;
    let why = null;
    if (!un || typeof s.credential !== 'string' || !ICE_CREDENTIAL_RE.test(s.credential)) why = 'turn-credential-malformed';
    else if (!Number.isFinite(serverMs) || !Number.isFinite(expiresMs)) why = 'turn-expiry-missing';
    else if (expiresMs - serverMs < ICE_LIMITS.minRemainingMs || Number(un[1]) * 1000 - serverMs < ICE_LIMITS.minRemainingMs) why = 'turn-credential-expired';
    else if (expiresMs - serverMs > ICE_LIMITS.maxRemainingMs || Number(un[1]) * 1000 - serverMs > ICE_LIMITS.maxRemainingMs) why = 'turn-credential-too-long';
    if (why) { out.dropped.push(why); return out; }
    out.iceServers.push({ urls: turn.urls, username: s.username, credential: s.credential });
    out.turn = true;
    out.remainingMs = Math.min(expiresMs, Number(un[1]) * 1000) - serverMs;
    return out;
  }

  // ---------- contact safety code ----------

  // SHA-256("atlas.call.safety/v1" || sorted identity keys) rendered as six groups of five
  // digits. Two people compare it over another channel; equal codes mean both wallets hold
  // the same two keys. The two keys are sorted so both sides compute the same string.
  async function safetyCode(keyA, keyB) {
    const [lo, hi] = [String(keyA), String(keyB)].sort();
    const h = await sha256Bytes(enc.encode('atlas.call.safety/v1\n' + lo + '\n' + hi));
    const groups = [];
    for (let i = 0; i < 6; i++) {
      const n = ((h[i * 4] << 24) | (h[i * 4 + 1] << 16) | (h[i * 4 + 2] << 8) | h[i * 4 + 3]) >>> 0;
      groups.push(String(n % 100000).padStart(5, '0'));
    }
    return groups.join(' ');
  }

  // ---------- call card (signed handout of a tag between contacts) ----------

  function validateCardPayload(p) {
    return strict(p, {
      type: (v) => v === 'atlas.call.card', v: (v) => v === 1,
      service: (v) => isStr(v, 8, 200), tag: isId128, calleeKey: isKey, expiresAt: isTime, issuedAt: isTime
    });
  }

  return {
    LIMITS, END_REASONS, SIGNAL_KINDS, CK_KINDS,
    b64urlEncode, b64urlDecode, canonicalize, sha256Bytes, hashOf, payloadHash, transcriptHash, tagHash, randomId,
    validatePayload, validateEnvelope, validateCardPayload, verifyEnvelope, verifySigned, derToRawEcdsaSig,
    freshForService, inviteTimeOk,
    normalizeFingerprint, checkSdpAgainstFingerprints, remoteCertMatches, candidateAddressAllowed,
    ICE_TURN_PORTS, ICE_LIMITS, parseIceUrl, iceUrlProblem, privateHost, iceServersFromAnswer,
    safetyCode
  };
});
