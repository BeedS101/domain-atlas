// Documents, with a running example, what the signed payload of a domain-atlas-asset/1.0 credential does not cover.
//
//   node test/verifier-protocol-limits.js
//
// The signature covers {id, asset, owner, quantity, supersedes, issuedAt}. The credential type string, issuer.domain and
// issuer.publicKey sit outside it. The verifier therefore binds the issuer to its own configuration (domain match, key
// published by that domain, optional pin) instead of to the signature. These checks pin down the consequences so that a
// later change to the credential format has to update them on purpose; see docs/verifier-protocol-limitations.md.
// Nothing here changes a credential format.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startIssuer, freePort, rawPublicKey } = require('./lib/php-issuer');
const { newOwner } = require('./lib/owner-auth');
const { buildPackage, extractPackage, writeConfig, servePhp, postJson } = require('./lib/package-install');

let failures = 0;
let total = 0;
function line(ok, text, detail) {
  total++;
  if (!ok) failures++;
  console.log((ok ? 'PASS ' : 'FAIL ') + text + (!ok && detail !== undefined ? ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300) : ''));
}
const cleanup = [];
const clone = (v) => JSON.parse(JSON.stringify(v));

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-verify-limits-'));
  cleanup.push(() => fs.rmSync(work, { recursive: true, force: true }));
  const zip = buildPackage(path.join(work, 'build'));

  // Issuer A, and issuer B that was cloned from A together with its key (a staging copy, a restored backup, a mirror).
  const a = await startIssuer();
  cleanup.push(() => a.stop());
  const owner = newOwner();
  const original = await a.issue(owner, 'atlas.badge');
  const keyPem = fs.readFileSync(path.join(a.dir, 'lib', 'issuer-private-key.pem'));
  const b = await startIssuer({
    prepare: (bundle) => {
      fs.writeFileSync(path.join(bundle, 'lib', 'issuer-private-key.pem'), keyPem, { mode: 0o600 });
      fs.mkdirSync(path.join(bundle, '.well-known'), { recursive: true });
      fs.writeFileSync(path.join(bundle, '.well-known', 'atlas-revocations.json'), JSON.stringify({ revoked: [] }));
    }
  });
  cleanup.push(() => b.stop());
  await b.issue(owner, 'atlas.badge'); // makes B publish its key document (the same key as A)
  const keyOf = async (issuer) => JSON.parse((await issuer.published('atlas-key.json')).text).keys.map((k) => k.publicKey);
  line(JSON.stringify(await keyOf(a)) === JSON.stringify(await keyOf(b)), 'setup: the clone publishes the same issuer key as the original');

  async function verifierFor(name, config) {
    const dir = extractPackage(zip, path.join(work, name));
    writeConfig(dir, Object.assign({ allowInsecureLoopback: true }, config));
    const server = await servePhp(dir, await freePort());
    cleanup.push(server.stop);
    return (credential) => postJson(server.base + '/verify.php', { credential });
  }
  const verifyAtA = await verifierFor('at-a', { trustedIssuers: { [a.origin]: { suspensions: 'optional' } } });
  const verifyAtB = await verifierFor('at-b', { trustedIssuers: { [b.origin]: { suspensions: 'optional' } } });

  console.log('\n== issuer identity is not part of the signed payload');
  line((await verifyAtA(original)).json.status === 'verified', 'the credential verifies at the issuer that issued it');
  const relabelled = clone(original); relabelled.issuer.domain = b.domain;
  const atB = await verifyAtB(relabelled);
  line(atB.json.status === 'verified', 'KNOWN LIMITATION: the same credential relabelled with another domain verifies there when that domain publishes the same key', atB.json);
  await a.revoke(original.id, 'revoked at A');
  line((await verifyAtA(original)).json.status === 'revoked', 'revoking at the original issuer revokes it there');
  line((await verifyAtB(relabelled)).json.status === 'verified', 'KNOWN LIMITATION: the relabelled copy is not affected, because each domain has its own revocation list', (await verifyAtB(relabelled)).json);
  const sameKeyPinnedElsewhere = await verifierFor('pinned', { trustedIssuers: { [b.origin]: { suspensions: 'optional', pinnedKeys: [rawPublicKey(require('crypto').generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey)] } } });
  line((await sameKeyPinnedElsewhere(relabelled)).json.code === 'key-not-pinned', 'mitigation: pinning a different key for that domain refuses it');
  const wrongKeyLabel = clone(original); wrongKeyLabel.issuer.publicKey = (await keyOf(b))[0].replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
  line((await verifyAtA(wrongKeyLabel)).json.valid === false, 'the issuer.publicKey field cannot be altered: it must be a published key and verify the signature');
  line((await verifyAtA(relabelled)).json.status === 'untrusted-issuer', 'mitigation: a verifier that does not list the relabelled domain refuses it');

  console.log('\n== the credential type string is not part of the signed payload');
  const retyped = clone(original); retyped.credential = 'domain-atlas-asset/1.1';
  line((await verifyAtB(retyped)).json.status === 'unsupported', 'a different type or version label is never verified as 1.0 (unsupported)');
  const attestationLabel = clone(original); attestationLabel.credential = 'domain-atlas-attestation/1.0';
  line((await verifyAtB(attestationLabel)).json.status === 'unsupported', 'an attestation label is refused too: attestations are not verified by this package');
  console.log('NOTE  the label is unsigned: a future format that reuses these six fields under a new label would carry a signature valid under both labels, so the label alone must not be relied on (docs/verifier-protocol-limitations.md)');

  console.log('\n' + (failures === 0 ? 'ALL ' + total + ' PROTOCOL LIMIT CHECKS PASSED' : failures + ' of ' + total + ' checks FAILED'));
})().catch((err) => { failures++; console.error('FAILURE:', err); }).finally(async () => {
  for (const fn of cleanup.reverse()) { try { await fn(); } catch (e) { /* already stopped */ } }
  process.exit(failures === 0 ? 0 : 1);
});
