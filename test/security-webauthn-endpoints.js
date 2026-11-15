// A passkey assertion reaches the same check through a real endpoint on either issuer. POST /atlas/postoffice/mysettings
// verifies the envelope first and only then looks up the membership, so the two answers tell acceptance from refusal.
//
// Run: STACK=node node test/security-webauthn-endpoints.js   (or STACK=php)
'use strict';
const S = require('./support/issuer-stack');
const W = require('./support/webauthn-assertions');

const STACK = process.env.STACK || 'node';
const BASE_PORT = STACK === 'php' ? 8540 : 8530;
let failures = 0;
function check(name, ok, detail) {
  if (ok) console.log('PASS ' + name); else { failures++; console.log('FAIL ' + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail).slice(0, 240))); }
}
const accepted = (r) => r.status === 400 && /Global Mail membership/.test(r.body.error || '');
const refused = (r) => r.status === 400 && r.body.error === 'signature does not check out';

(async () => {
  // The PHP issuer takes its own domain from the Host header for most purposes, but never for this check.
  const own = (port) => ({ ATLAS_DOMAIN: 'localhost:' + port });
  const dflt = await S.startIssuer(STACK, BASE_PORT, own(BASE_PORT));
  const strict = await S.startIssuer(STACK, BASE_PORT + 1, Object.assign(own(BASE_PORT + 1), { ATLAS_WEBAUTHN_REQUIRE_UV: '1' }));
  const pinned = await S.startIssuer(STACK, BASE_PORT + 2, Object.assign(own(BASE_PORT + 2), { ATLAS_WEBAUTHN_ORIGINS: W.EXT_ORIGIN }));
  try {
    const id = W.makeIdentity();
    const payload = { action: 'mysettings', issuedAt: new Date().toISOString() };
    const send = (issuer, o) => S.post(issuer.base, '/atlas/postoffice/mysettings', { payload, proof: W.assertion(id, payload, o) });
    const ownOrigin = (issuer) => ({ origin: 'http://' + issuer.domain, rpId: 'localhost' });

    console.log('--- what the wallet sends is accepted ---');
    check('extension origin, user present', accepted(await send(dflt, {})));
    check('extension origin, user verified', accepted(await send(dflt, { flags: 0x05 })));
    check("this issuer's own page origin", accepted(await send(dflt, ownOrigin(dflt))));
    const raw = await S.generateIdentity();
    const rawProof = await S.signPayload(raw, payload);
    check("a page claiming a Host it was not configured for is refused", refused(await S.post(dflt.base, '/atlas/postoffice/mysettings', { payload, proof: W.assertion(id, payload, { origin: 'https://spoofed.example', rpId: 'spoofed.example' }) })));
    check('a raw-ECDSA identity is unaffected', accepted(await S.post(dflt.base, '/atlas/postoffice/mysettings', { payload, proof: rawProof })));

    console.log('--- assertions that are not a genuine, present, in-context "get" are refused ---');
    const bad = [
      ['a registration assertion', { type: 'webauthn.create' }],
      ['user presence clear', { flags: 0x00 }],
      ['attested credential data in an assertion', { flags: 0x41, extra: Buffer.alloc(40, 1) }],
      ['authenticator data truncated', { authDataLength: 36 }],
      ['authenticator data empty', { authDataLength: 0 }],
      ['a cross-origin assertion', { clientData: { crossOrigin: true } }],
      ['the wrong relying party', { rpId: 'someone-else' }],
      ['an origin that is not this domain', { origin: 'https://evil.example', rpId: 'evil.example' }],
      ['client data that is not JSON', { rawClientData: Buffer.from('nope') }]
    ];
    for (const [name, o] of bad) check(name + ' is refused', refused(await send(dflt, o)), (await send(dflt, o)));
    const junk = await S.post(dflt.base, '/atlas/postoffice/mysettings', { payload, proof: { signerRole: 'webauthn', publicKey: id.spki, clientDataJSON: 5, authenticatorData: [], signature: {} } });
    check('an envelope with non-string fields is refused, not an error', refused(junk), junk);

    console.log('--- operator configuration ---');
    check('user verification required: a verified assertion passes', accepted(await send(strict, { flags: 0x05 })));
    check('user verification required: presence alone is refused', refused(await send(strict, { flags: 0x01 })));
    check('a pinned extension origin passes', accepted(await send(pinned, {})));
    check('a pinned origin refuses another extension', refused(await send(pinned, { origin: 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba' })));
    check('a raw-ECDSA identity ignores the pins', accepted(await S.post(pinned.base, '/atlas/postoffice/mysettings', { payload, proof: rawProof })));
  } finally {
    await Promise.all([dflt.stop(), strict.stop(), pinned.stop()]);
  }
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
