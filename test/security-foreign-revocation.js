// A domain accepting another domain's credential (here, a world drop of a foreign item) must know what that issuer has
// revoked or suspended. A revocation document that cannot be read, or an issuer that cannot be reached, is "could not
// confirm", never an empty list; a confirmed revocation is reported as such. The same cases run against both issuers.
//
// Run: STACK=node node test/security-foreign-revocation.js   (or STACK=php)
'use strict';
const S = require('./support/issuer-stack');

const STACK = process.env.STACK || 'node';
const BASE_PORT = STACK === 'php' ? 8520 : 8510;
let failures = 0;
function check(name, ok, detail) {
  if (ok) console.log('PASS ' + name);
  else { failures++; console.log('FAIL ' + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail).slice(0, 240))); }
}

(async () => {
  const H = await S.startIssuer(STACK, BASE_PORT, { ATLAS_OUTBOUND_TIMEOUT_MS: '1500', ATLAS_OUTBOUND_MAX_BYTES: String(1024 * 1024), ATLAS_OUTBOUND_RATE: '1000', ATLAS_OUTBOUND_KEY_RATE: '1000', ATLAS_OUTBOUND_RATE_ALL: '5000', ATLAS_OUTBOUND_KEY_RATE_ALL: '5000' });
  const F = await S.startStandInIssuer(BASE_PORT + 1);
  const alice = await S.generateIdentity();
  const world = 'revocation-world';
  async function dropForeign(label, setup) {
    F.state.key = 'ok'; F.state.rev = 'ok'; F.state.sus = 'ok'; F.state.revoked = []; F.state.suspended = [];
    const cred = await F.issue(alice);
    if (setup) setup(cred);
    const dropId = 'urn:atlas:worlddrop:' + require('crypto').randomUUID();
    const payload = { action: 'drop', credentialId: cred.id, world, domain: H.domain, dropId, droppedAt: new Date().toISOString() };
    const res = await S.post(H.base, '/atlas/world/drop', { credential: cred, world, position: [0, 0, 0], intent: { payload, proof: await S.signPayload(alice, payload) } });
    const listed = (await S.get(H.base, '/atlas/world/drops?world=' + world)).body.drops.some((d) => d.dropId === dropId);
    return { status: res.status, error: (res.body && res.body.error) || '', listed };
  }
  const refused = (r) => r.status >= 400 && !r.listed;

  try {
    let r = await dropForeign('healthy');
    check('a foreign credential with readable documents is accepted', r.status === 200 && r.listed, r);

    r = await dropForeign('revoked', (c) => { F.state.revoked = [c.id]; });
    check('a confirmed revocation is refused as revoked', refused(r) && /revoked this credential/.test(r.error) && !/could not confirm/.test(r.error), r);

    r = await dropForeign('suspended', (c) => { F.state.suspended = [c.id]; });
    check('a confirmed suspension is refused as suspended', refused(r) && /suspended this credential/.test(r.error) && !/could not confirm/.test(r.error), r);

    r = await dropForeign('rev 404', () => { F.state.rev = '404'; });
    check('a missing revocation document is not an empty list', refused(r) && /could not confirm/.test(r.error), r);

    r = await dropForeign('rev 500', () => { F.state.rev = '500'; });
    check('a revocation document answering with an HTTP error is not an empty list', refused(r) && /could not confirm/.test(r.error), r);

    r = await dropForeign('rev malformed', () => { F.state.rev = 'malformed'; });
    check('malformed revocation JSON is not an empty list', refused(r) && /could not confirm/.test(r.error), r);

    r = await dropForeign('rev wrong shape', () => { F.state.rev = 'ok'; F.revShape = true; });
    check('a healthy list still works after those', r.status === 200, r);

    const t0 = Date.now();
    r = await dropForeign('rev hangs', () => { F.state.rev = 'hang'; });
    check('a revocation document that never answers times out and is refused', refused(r) && /could not confirm|could not reach/.test(r.error) && Date.now() - t0 < 9000, r);

    r = await dropForeign('rev redirect', () => { F.state.rev = 'redirect'; });
    check('a redirect is not followed and is not an empty list', refused(r) && /could not confirm/.test(r.error), r);

    r = await dropForeign('rev huge', () => { F.state.rev = 'huge'; });
    check('an oversized revocation document is refused', refused(r) && /could not confirm/.test(r.error), r);

    r = await dropForeign('sus 404', () => { F.state.sus = '404'; });
    check('an issuer that publishes no suspension document (404) is still accepted', r.status === 200 && r.listed, r);

    r = await dropForeign('sus 500', () => { F.state.sus = '500'; });
    check('a suspension document answering with an HTTP error is refused', refused(r) && /could not confirm/.test(r.error), r);

    r = await dropForeign('sus malformed', () => { F.state.sus = 'malformed'; });
    check('malformed suspension JSON is refused', refused(r) && /could not confirm/.test(r.error), r);

    r = await dropForeign('key 500', () => { F.state.key = '500'; });
    check('an unreadable key document is refused', refused(r), r);

    const t1 = Date.now();
    r = await dropForeign('key hangs', () => { F.state.key = 'hang'; });
    check('an issuer whose key document never answers is refused in time', refused(r) && Date.now() - t1 < 9000, r);

    F.stop();
    r = await dropForeign('gone').catch((e) => ({ status: 0, error: String(e), listed: false }));
    check('an unreachable issuer is refused', r.status !== 200 && !r.listed, r);

    console.log(failures ? '\n' + failures + ' CHECK(S) FAILED' : '\nALL CHECKS PASSED');
  } finally {
    H.stop(); F.stop();
  }
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log('FATAL ' + (e && e.stack || e)); process.exit(1); });
