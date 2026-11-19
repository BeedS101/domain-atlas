// The owner's signed drop intent is an authorization with a lifetime, not a permanent license. A drop the hosting domain
// accepted stays in the world and stays claimable after that authorization has lapsed; what expires is the right to
// PLACE a credential, and the credential's issuer checks that the hosting domain accepted the drop while the signed
// authorization was still valid (the acceptance time the hosting domain vouches for in its signed attestation).
//
//   host   POST /atlas/world/drop          expiresAt required, canonical, not expired, not too far ahead (server time)
//   issuer POST /atlas/world/drops/relay-claim   authorization lapsed before acceptance, or an unbounded one, is refused
//   compat intents without expiresAt (older wallets) are served only until ATLAS_DROP_LEGACY_UNTIL; a drop accepted
//          before that date stays claimable
//
// Run: STACK=node node test/security-world-drop-expiry.js   (or STACK=php)
// Throw-away issuers and one stand-in domain; nothing leaves this machine.
'use strict';
const S = require('./support/issuer-stack');

const STACK = process.env.STACK || 'node';
const BASE_PORT = STACK === 'php' ? 8520 : 8510;
const MIN = 60 * 1000, DAY = 24 * 60 * MIN;
let failures = 0;
function check(name, ok, detail) {
  if (ok) console.log('PASS ' + name);
  else { failures++; console.log('FAIL ' + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail).slice(0, 260))); }
}
const uuid = () => require('crypto').randomUUID();
const newDropId = () => 'urn:atlas:worlddrop:' + uuid();
const iso = (ms) => new Date(ms).toISOString();

async function issue(issuer, owner, cls) {
  const r = await S.post(issuer.base, '/atlas/asset/issue', { ownerPublicKey: owner.publicKey, assetClass: cls || 'atlas.trophy.chess' });
  if (r.status !== 200) throw new Error('issue failed: ' + JSON.stringify(r.body));
  return r.body;
}
const revoked = async (issuer) => new Set(((await S.get(issuer.base, '/.well-known/atlas-revocations.json')).body.revoked || []).map((e) => e.id));

// What the wallet signs to drop `credential` into `host`'s world. `over` replaces or (undefined) removes fields before signing.
async function ownerIntent(host, owner, credential, world, dropId, over) {
  const now = Date.now();
  const payload = { action: 'drop', credentialId: credential.id, world, domain: host.domain, dropId, droppedAt: iso(now), expiresAt: iso(now + 10 * MIN) };
  Object.keys(over || {}).forEach((k) => { if (over[k] === undefined) delete payload[k]; else payload[k] = over[k]; });
  return { payload, proof: await S.signPayload(owner, payload) };
}
const dropAt = async (host, owner, credential, world, over, tamper) => {
  const dropId = newDropId();
  const intent = await ownerIntent(host, owner, credential, world, dropId, over);
  if (tamper) tamper(intent.payload);
  const res = await S.post(host.base, '/atlas/world/drop', { credential, world, position: [1, 0, 1], intent });
  return { res, dropId, intent };
};
const claimAt = async (host, claimant, dropId) => {
  const payload = { action: 'claim', dropId, domain: host.domain, claimedAt: iso(Date.now()) };
  return S.post(host.base, '/atlas/world/drops/claim', { dropId, intent: { payload, proof: await S.signPayload(claimant, payload) } });
};
// What a hosting domain sends the issuer for one claim; `droppedAt` is the acceptance time it vouches for (omitted by older hosts).
async function relay(issuer, hostDomain, hostKey, { credential, dropId, world, claimant, dropIntent, droppedAt }) {
  const attestation = { relayingDomain: hostDomain, world, dropId, credentialId: credential.id, claimantPublicKey: claimant.publicKey };
  if (droppedAt !== undefined) attestation.droppedAt = droppedAt;
  const claimPayload = { action: 'claim', dropId, domain: hostDomain, claimedAt: iso(Date.now()) };
  return S.post(issuer.base, '/atlas/world/drops/relay-claim', {
    credential, attestation, attestationSignature: await S.signDetached(hostKey, attestation), dropIntent, claimIntent: { payload: claimPayload, proof: await S.signPayload(claimant, claimPayload) }
  });
}
const refused = (r, status, code) => r.status === status && r.body.code === code && !(r.body && r.body.credential);

(async () => {
  const M = await S.startStandInDomain(BASE_PORT + 9);
  const STRICT = { ATLAS_DROP_LEGACY_UNTIL: '2020-01-01T00:00:00.000Z' };
  const CUTOVER = Date.now() + 14000;
  const MID = { ATLAS_DROP_LEGACY_UNTIL: iso(CUTOVER) };
  const [A1, B1, A2, B2, A3, B3] = await Promise.all([
    S.startIssuer(STACK, BASE_PORT), S.startIssuer(STACK, BASE_PORT + 1),
    S.startIssuer(STACK, BASE_PORT + 2, STRICT), S.startIssuer(STACK, BASE_PORT + 3, STRICT),
    S.startIssuer(STACK, BASE_PORT + 4, MID), S.startIssuer(STACK, BASE_PORT + 5, MID)]);
  const WORLD = 'world-' + Date.now();
  try {
    const alice = await S.generateIdentity(), bob = await S.generateIdentity(), mallory = await S.generateIdentity();

    console.log('--- hosting domain: a new drop needs a bounded, signed expiry ---');
    let item = await issue(B2, alice);
    let d = await dropAt(B2, alice, item, WORLD);
    check('a valid unexpired intent is accepted and listed', d.res.status === 200 && (await S.get(B2.base, '/atlas/world/drops?world=' + WORLD)).body.drops.some((x) => x.dropId === d.dropId), d.res);

    item = await issue(B2, alice);
    d = await dropAt(B2, alice, item, WORLD, { expiresAt: undefined });
    check('an intent with no expiresAt is refused once the compatibility period is over', refused(d.res, 403, 'drop-intent-expiry-required'), d.res);
    check('...and nothing was listed', !(await S.get(B2.base, '/atlas/world/drops?world=' + WORLD)).body.drops.some((x) => x.dropId === d.dropId));

    for (const [label, value] of [['a word', 'soon'], ['a number', 1893456000000], ['null', null], ['an empty string', ''], ['a date without a time', '2030-01-01'], ['no milliseconds', '2030-01-01T00:00:00Z'], ['an impossible date', '2030-02-31T00:00:00.000Z'], ['an array', []], ['an object', {}]]) {
      d = await dropAt(B2, alice, item, WORLD, { expiresAt: value });
      // PHP reads an empty JSON object as an empty array, so the signature check may refuse these two before the expiry check does.
      const empty = Array.isArray(value) || (value && typeof value === 'object');
      check('expiresAt as ' + label + ' is refused', empty ? (d.res.status === 400 && !d.res.body.dropId) : refused(d.res, 400, 'drop-intent-expiry-invalid'), d.res);
    }

    d = await dropAt(B2, alice, item, WORLD, { expiresAt: iso(Date.now() - 10 * MIN) });
    check('an intent that expired ten minutes ago is refused, with the server time so a wallet can correct its clock', d.res.status === 401 && d.res.body.code === 'stale-request' && Math.abs(Date.parse(d.res.body.serverTime) - Date.now()) < 5000, d.res);
    d = await dropAt(B2, alice, item, WORLD, { expiresAt: iso(Date.now() - 60 * 1000) });
    check('one that expired a minute ago is within the clock-skew tolerance', d.res.status === 200, d.res);
    item = await issue(B2, alice);
    d = await dropAt(B2, alice, item, WORLD, { expiresAt: iso(Date.now() + DAY) });
    check('an intent that expires in a day is refused as too far ahead', d.res.status === 401 && d.res.body.code === 'stale-request', d.res);
    d = await dropAt(B2, alice, item, WORLD, { expiresAt: iso(Date.now() + 40 * 365 * DAY) });
    check('so is one that expires in forty years', d.res.status === 401 && d.res.body.code === 'stale-request', d.res);
    d = await dropAt(B2, alice, item, WORLD, { expiresAt: iso(Date.now() + 14 * MIN) });
    check('a fourteen-minute lifetime is within the bound', d.res.status === 200, d.res);

    console.log('--- the expiry is part of what was signed ---');
    item = await issue(B2, alice);
    d = await dropAt(B2, alice, item, WORLD, {}, (p) => { p.expiresAt = iso(Date.now() + 14 * MIN); });
    check('changing expiresAt after signing breaks the signature', d.res.status === 400 && /signature/.test(d.res.body.error || ''), d.res);
    d = await dropAt(B2, alice, item, WORLD, {}, (p) => { delete p.expiresAt; });
    check('removing expiresAt after signing breaks the signature', d.res.status === 400 && /signature/.test(d.res.body.error || ''), d.res);
    d = await dropAt(B2, alice, item, WORLD, { expiresAt: iso(Date.now() - 30 * DAY) }, (p) => { p.expiresAt = iso(Date.now() + 5 * MIN); });
    check('moving an old expiry forward after signing breaks the signature', d.res.status === 400 && /signature/.test(d.res.body.error || ''), d.res);

    console.log('--- compatibility: older wallets are served until the cut-off, and an expired intent is never served ---');
    item = await issue(B1, alice);
    d = await dropAt(B1, alice, item, WORLD, { expiresAt: undefined });
    check('before the cut-off, an intent with no expiresAt is still accepted', d.res.status === 200, d.res);
    item = await issue(B1, alice);
    d = await dropAt(B1, alice, item, WORLD, { expiresAt: iso(Date.now() - 10 * MIN) });
    check('but an intent that carries an expiry which has passed is refused even then', d.res.status === 401, d.res);
    item = await issue(B1, alice);
    const oldIntent = { payload: { action: 'drop', credentialId: item.id, world: WORLD }, proof: null };
    oldIntent.proof = await S.signPayload(alice, oldIntent.payload);
    let r = await S.post(B1.base, '/atlas/world/drop', { credential: item, world: WORLD, position: [1, 0, 1], intent: oldIntent });
    check('an oldest-style intent (no domain, drop id or times) for the host\'s own item is still accepted before the cut-off', r.status === 200, r);
    item = await issue(B2, alice);
    const oldIntent2 = { payload: { action: 'drop', credentialId: item.id, world: WORLD }, proof: null };
    oldIntent2.proof = await S.signPayload(alice, oldIntent2.payload);
    r = await S.post(B2.base, '/atlas/world/drop', { credential: item, world: WORLD, position: [1, 0, 1], intent: oldIntent2 });
    check('...and refused after it', refused(r, 403, 'drop-intent-expiry-required'), r);

    console.log('--- issuer: the authorization had to be valid when the drop was accepted, not when it is claimed ---');
    const longAgo = Date.now() - 5 * DAY;
    const claimed = async (issuer, over, accepted, claimant) => {
      const cred = await issue(issuer, alice);
      const dropId = newDropId();
      const intent = await ownerIntent(M, alice, cred, WORLD, dropId, over);
      const body = { credential: cred, dropId, world: WORLD, claimant: claimant || bob, dropIntent: intent, droppedAt: accepted };
      return { cred, dropId, intent, body, r: await relay(issuer, M.domain, M.identity, body) };
    };
    let c = await claimed(A2, { droppedAt: iso(longAgo), expiresAt: iso(longAgo + 10 * MIN) }, iso(longAgo + 2 * MIN));
    check('a drop accepted five days ago inside its ten-minute authorization is still claimable', c.r.status === 200 && c.r.body.credential && c.r.body.credential.owner.publicKey === bob.publicKey && (await revoked(A2)).has(c.cred.id), c.r);
    const again = await relay(A2, M.domain, M.identity, c.body);
    check('...and the same claim sent again returns the same credential', again.status === 200 && again.body.credential && again.body.credential.id === c.r.body.credential.id, again);
    c = await claimed(A2, { droppedAt: iso(longAgo), expiresAt: iso(longAgo + 10 * MIN) }, iso(longAgo + 2 * MIN), mallory);
    const other = await relay(A2, M.domain, M.identity, Object.assign({}, c.body, { dropId: newDropId(), claimant: bob }));
    check('the same authorization under a new drop id is refused', other.status >= 400 && other.status < 500 && !(other.body && other.body.credential), other);
    c = await claimed(A2, { droppedAt: iso(longAgo), expiresAt: iso(longAgo + 10 * MIN) }, iso(longAgo + 30 * MIN));
    check('a drop accepted after its authorization lapsed is refused', refused(c.r, 403, 'drop-intent-expired') && !(await revoked(A2)).has(c.cred.id), c.r);
    c = await claimed(A2, { droppedAt: iso(longAgo), expiresAt: iso(longAgo + DAY) }, iso(longAgo + MIN));
    check('an authorization written to last a day is refused as unbounded', refused(c.r, 403, 'drop-intent-expired'), c.r);
    c = await claimed(A2, { droppedAt: iso(longAgo), expiresAt: iso(Date.now() + 40 * 365 * DAY) }, iso(longAgo + MIN));
    check('and so is one written to last forty years', refused(c.r, 403, 'drop-intent-expired'), c.r);
    c = await claimed(A2, { expiresAt: 'soon' }, iso(Date.now() - MIN));
    check('a malformed expiry in the signed intent is refused', refused(c.r, 403, 'drop-intent-expiry-invalid'), c.r);
    c = await claimed(A2, { expiresAt: undefined }, iso(Date.now() - DAY));
    check('an intent with no expiry is refused by a strict issuer', refused(c.r, 403, 'drop-intent-expiry-required'), c.r);
    c = await claimed(A2, { expiresAt: iso(Date.now() + 5 * MIN) }, iso(Date.now() + 30 * MIN));
    check('a host claiming an acceptance time in the future is refused', c.r.status === 403 && !(c.r.body && c.r.body.credential), c.r);
    {
      const cred = await issue(A2, alice), dropId = newDropId();
      const intent = await ownerIntent(M, alice, cred, WORLD, dropId, { droppedAt: iso(longAgo), expiresAt: iso(longAgo + 10 * MIN) });
      const forged = JSON.parse(JSON.stringify(intent));
      forged.payload.expiresAt = iso(Date.now() + 5 * MIN);
      const rr = await relay(A2, M.domain, M.identity, { credential: cred, dropId, world: WORLD, claimant: bob, dropIntent: forged, droppedAt: iso(Date.now() - MIN) });
      check('moving the expiry forward after signing is refused at the issuer', refused(rr, 403, 'owner-signature-invalid'), rr);
    }
    c = await claimed(A2, { expiresAt: iso(Date.now() + 5 * MIN) }, undefined);
    check('an older host that sends no acceptance time is served while the intent is still valid', c.r.status === 200, c.r);
    c = await claimed(A2, { droppedAt: iso(longAgo), expiresAt: iso(longAgo + 10 * MIN) }, undefined);
    check('...but not once the cut-off has passed and the intent has lapsed (the acceptance time cannot be established)', refused(c.r, 403, 'drop-intent-expired'), c.r);
    c = await claimed(A1, { expiresAt: undefined }, iso(Date.now() - DAY));
    check('an issuer still inside the compatibility period serves a legacy intent', c.r.status === 200, c.r);
    c = await claimed(A1, { droppedAt: iso(longAgo), expiresAt: iso(longAgo + 10 * MIN) }, undefined);
    check('...and an older host\'s long-lapsed intent, which cannot be dated', c.r.status === 200, c.r);

    console.log('--- the whole path: a drop that outlives its authorization stays in the world ---');
    const e2eItem = await issue(A2, alice);
    d = await dropAt(B2, alice, e2eItem, WORLD, { expiresAt: iso(Date.now() - 90 * 1000) });
    check('a drop is accepted with its authorization nearly lapsed (within the skew)', d.res.status === 200, d.res);
    const listing = (await S.get(B2.base, '/atlas/world/drops?world=' + WORLD)).body.drops.find((x) => x.dropId === d.dropId);
    check('it is listed, and the listing shows when it was accepted but not the signed intent', listing && listing.droppedAt && listing.dropIntent === undefined, listing);
    await S.sleep(2500);
    const picked = await claimAt(B2, bob, d.dropId);
    check('it can be picked up after the authorization has lapsed', picked.status === 200 && picked.body.credential && picked.body.credential.owner.publicKey === bob.publicKey, picked);

    console.log('--- across two real issuers: the host vouches for when it accepted the drop ---');
    {
      const foreign = await issue(A2, alice);
      const placed = await dropAt(B2, alice, foreign, WORLD, { expiresAt: iso(Date.now() - 100 * 1000) });
      check('a drop of an item issued by another domain is accepted while its authorization is within the skew', placed.res.status === 200, placed.res);
      await S.sleep(2500);
      const picked2 = await claimAt(B2, bob, placed.dropId);
      check('the strict issuer settles it after the authorization lapsed, on the host\'s word about when it was accepted', picked2.status === 200 && picked2.body.credential && picked2.body.credential.owner.publicKey === bob.publicKey && (await revoked(A2)).has(foreign.id), picked2);
      const again2 = await claimAt(B2, bob, placed.dropId);
      check('the same claimant asking again is handed the recorded result, not a second mint', again2.status === 200 && again2.body.credential && again2.body.credential.id === picked2.body.credential.id, again2);
      const late2 = await claimAt(B2, mallory, placed.dropId);
      check('and anyone else is told it is gone', late2.status === 404, late2);
    }

    console.log('--- one claim wins when several arrive together ---');
    const raceItem = await issue(A2, alice);
    const raced = await dropAt(A2, alice, raceItem, WORLD);
    const results = await Promise.all([bob, mallory, await S.generateIdentity(), await S.generateIdentity(), await S.generateIdentity(), await S.generateIdentity()].map((who) => claimAt(A2, who, raced.dropId)));
    const winners = results.filter((x) => x.status === 200);
    check('exactly one of six simultaneous claims wins and the others are refused', winners.length === 1 && results.every((x) => x.status === 200 || x.status === 404 || x.status === 409), results.map((x) => x.status));

    console.log('--- a drop accepted before the cut-off stays claimable after it ---');
    const legacyItem = await issue(B3, alice);
    const legacy = await dropAt(B3, alice, legacyItem, WORLD, { expiresAt: undefined });
    check('a legacy intent is accepted before the cut-off', legacy.res.status === 200, legacy.res);
    const crossItem = await issue(A3, alice);
    const cross = await dropAt(B3, alice, crossItem, WORLD, { expiresAt: undefined });
    check('...including for an item issued by another domain', cross.res.status === 200, cross.res);
    const wait = CUTOVER - Date.now() + 1500;
    if (wait > 0) await S.sleep(wait);
    const late = await dropAt(B3, alice, await issue(B3, alice), WORLD, { expiresAt: undefined });
    check('after the cut-off a new legacy intent is refused', refused(late.res, 403, 'drop-intent-expiry-required'), late.res);
    const stillThere = await claimAt(B3, bob, legacy.dropId);
    check('the legacy drop accepted before the cut-off is still claimable', stillThere.status === 200 && stillThere.body.credential && stillThere.body.credential.owner.publicKey === bob.publicKey, stillThere);
    c = await claimed(A3, { expiresAt: undefined }, iso(CUTOVER - 60 * 1000));
    check('an issuer settles a legacy drop its host accepted before the cut-off', c.r.status === 200, c.r);
    c = await claimed(A3, { expiresAt: undefined }, iso(CUTOVER + 60 * 1000));
    check('...and refuses one its host says was accepted after it', refused(c.r, 403, 'drop-intent-expiry-required'), c.r);
  } finally {
    [A1, B1, A2, B2, A3, B3, M].forEach((x) => x.stop());
  }
  console.log(failures ? '\n' + failures + ' CHECK(S) FAILED' : '\nALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log('FATAL ' + (e && e.stack || e)); process.exit(1); });
