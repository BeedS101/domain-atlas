// Node unit tests for extension/spike-lib.js (SDP checking, signed binding, canonical JSON).
// Run: node test/unit-lib.js
'use strict';
const L = require('../extension/spike-lib.js');
const { check, finish } = require('./harness-lite');

const FP1 = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';
const FP2 = '11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00';
function sdp(extra, fp, media) {
  return ['v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0',
    media || 'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'c=IN IP4 0.0.0.0', 'a=fingerprint:sha-256 ' + (fp || FP1), 'a=setup:actpass'].concat(extra || []).join('\r\n') + '\r\n';
}

(async () => {
  // canonical JSON
  check('canonicalize sorts keys at every level', L.canonicalize({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } }) === '{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}');

  // fingerprints
  check('parseSdpFingerprints upper-cases values', L.parseSdpFingerprints(sdp([], FP1.toLowerCase()))[0].value === FP1);
  check('sdp with the signed fingerprint passes', L.checkSdpAgainstFingerprints(sdp(), [FP1]).ok === true);
  check('comparison is case-insensitive on the signed side', L.checkSdpAgainstFingerprints(sdp(), [FP1.toLowerCase()]).ok === true);
  check('unsigned fingerprint is refused', L.checkSdpAgainstFingerprints(sdp([], FP2), [FP1]).reason === 'fingerprint-not-signed');
  check('a second, unsigned fingerprint line is refused', L.checkSdpAgainstFingerprints(sdp(['a=fingerprint:sha-256 ' + FP2]), [FP1]).reason === 'fingerprint-not-signed');
  check('no fingerprint refused', L.checkSdpAgainstFingerprints(sdp().replace(/a=fingerprint.*\r\n/, ''), [FP1]).reason === 'no-fingerprint');
  check('sha-1 fingerprint refused', L.checkSdpAgainstFingerprints(sdp().replace('sha-256', 'sha-1'), [FP1]).reason === 'unsupported-hash');
  check('malformed fingerprint refused', L.checkSdpAgainstFingerprints(sdp().replace(FP1, 'zz'), [FP1]).reason === 'malformed-fingerprint');
  check('SDES a=crypto refused', L.checkSdpAgainstFingerprints(sdp(['a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:abc']), [FP1]).reason === 'sdes-present');
  check('a=identity refused', L.checkSdpAgainstFingerprints(sdp(['a=identity:abc']), [FP1]).reason === 'identity-attribute-present');
  check('candidates inside the SDP refused', L.checkSdpAgainstFingerprints(sdp(['a=candidate:1 1 udp 1 10.0.0.1 9 typ host']), [FP1]).reason === 'candidate-in-sdp');
  check('video m-section refused', L.checkSdpAgainstFingerprints(sdp(['m=video 9 UDP/TLS/RTP/SAVPF 96']), [FP1]).reason === 'unexpected-media-sections');
  check('non-DTLS media transport refused', L.checkSdpAgainstFingerprints(sdp([], FP1, 'm=audio 9 RTP/AVP 0'), [FP1]).reason === 'unexpected-media-sections');
  check('oversize SDP refused', L.checkSdpAgainstFingerprints(sdp(['a=x:' + 'y'.repeat(20000)]), [FP1]).reason === 'sdp-too-large');
  check('empty signed set refused', L.checkSdpAgainstFingerprints(sdp(), []).reason === 'no-signed-fingerprint');
  check('garbage refused', L.checkSdpAgainstFingerprints('hello', [FP1]).reason === 'not-sdp');

  // signed binding
  const id = await L.generateTestKeyPair(false), other = await L.generateTestKeyPair(false);
  const fields = { role: 'callee', callId: 'c1', from: 'bob', to: 'alice', fingerprints: [FP1], ck: 'k' };
  const sb = await L.makeSignedBinding(id.privateKey, id.publicKey, fields);
  check('binding verifies with the pinned key', (await L.verifySignedBinding(sb, id.publicKey, { callId: 'c1', to: 'alice' })).ok === true);
  check('binding signed by another key is refused (unexpected-signer)', (await L.verifySignedBinding(sb, other.publicKey)).reason === 'unexpected-signer');
  const swapped = JSON.parse(JSON.stringify(sb)); swapped.payload.fingerprints = [FP2];
  check('changing the fingerprint breaks the signature', (await L.verifySignedBinding(swapped, id.publicKey)).reason === 'bad-signature');
  const reSigned = await L.makeSignedBinding(other.privateKey, id.publicKey, fields); // signature by the wrong key under the right claimed key
  check('signature by a different key under the pinned public key is refused', (await L.verifySignedBinding(reSigned, id.publicKey)).reason === 'bad-signature');
  check('replay for another call id is refused', (await L.verifySignedBinding(sb, id.publicKey, { callId: 'c2' })).reason === 'field-mismatch:callId');
  check('replay for another recipient is refused', (await L.verifySignedBinding(sb, id.publicKey, { to: 'mallory' })).reason === 'field-mismatch:to');
  check('stale binding refused', (await L.verifySignedBinding(sb, id.publicKey, null, Date.now() + 5 * 60000)).reason === 'stale');
  check('binding from the future refused', (await L.verifySignedBinding(sb, id.publicKey, null, Date.now() - 5 * 60000)).reason === 'stale');
  const nofp = await L.makeSignedBinding(id.privateKey, id.publicKey, Object.assign({}, fields, { fingerprints: [] }));
  check('binding without fingerprints refused', (await L.verifySignedBinding(nofp, id.publicKey)).reason === 'no-fingerprints');
  check('malformed input refused', (await L.verifySignedBinding({}, id.publicKey)).reason === 'malformed');

  // signatures over canonical JSON are order independent
  const p1 = { a: 1, b: 2 }, p2 = { b: 2, a: 1 };
  const sig = await L.signJson(id.privateKey, p1);
  check('signature is independent of key order', await L.verifyJson(id.publicKey, p2, sig));
  check('signature does not verify another payload', !(await L.verifyJson(id.publicKey, { a: 1, b: 3 }, sig)));
  check('test private key is not extractable', await require('crypto').webcrypto.subtle.exportKey('pkcs8', id.privateKey).then(() => false, () => true));

  process.exit(finish('unit-lib'));
})();
