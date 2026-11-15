// Passkey assertions accepted by the Node issuer's envelope check (issuer-server/lib-webauthn.js): the shared cases in
// test/support/webauthn-assertions.js, each run under the operator configuration it names.
//
// Run: node test/security-webauthn-envelope.js
'use strict';
const A = require('./support/webauthn-assertions');
const { verifyWebauthnEnvelope, policyFromEnv } = require('../issuer-server/lib-webauthn');

let failures = 0, passes = 0;
function check(name, ok, detail) {
  if (ok) { passes++; console.log('PASS ' + name); } else { failures++; console.log('FAIL ' + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail).slice(0, 240))); }
}

(async () => {
  const cases = await A.buildCases();
  for (const c of cases) {
    if (c.envelope.signerRole === 'raw-ecdsa') continue; // not this module's; covered by the endpoint test
    let got;
    try { got = await verifyWebauthnEnvelope(A.canonicalize(c.payload), c.envelope, policyFromEnv(c.env, [A.OWN_ORIGIN])); } catch (e) { got = 'threw ' + e.message; }
    check((c.expect ? 'accepts: ' : 'refuses: ') + c.name, got === c.expect, got);
  }
  check('a missing envelope is refused without throwing', (await verifyWebauthnEnvelope({}, null, policyFromEnv({}, [A.OWN_ORIGIN]))) === false);
  check('a missing policy is refused rather than assumed', (await verifyWebauthnEnvelope({}, cases[0].envelope, null)) === false);
  console.log(passes + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
})();
