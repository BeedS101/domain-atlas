// Two Call Services on different domains with different issuers, in every Node/PHP pairing
// that includes PHP: the callee's service carries the call, the caller needs no membership
// there, and nothing from one domain's membership, tags or revocations carries over to the
// other. Requires `php` with the openssl and curl extensions on PATH.
// Run: node test/manual-call-php-cross.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('./call-test-lib');
const L = require('./call-php-lib');
const { driveCall, hangup } = require('./call-flow-lib');
const { check, iso, Wallet, post, base, nonce, sign, signalPayload, sendSignal, P } = T;

const TIMERS = { sweepMs: 200, endedRetainMs: 800, listenerFreshMs: 6000 };
const LIMITS = { invitesPerSourcePerMin: 1000, invitesPerCallerPerMin: 1000, invitesPerCalleePerMin: 1000 };

const starters = {
  php: (over, opts) => L.startPhpService(over, opts),
  node: (over, opts) => T.startService(over, opts)
};

// The same wallet identity, as seen by a given service.
const on = (wallet, ctx) => new Wallet(wallet.ident, ctx, wallet.name);

async function pairing(kindA, kindB) {
  const label = kindA + '(A) + ' + kindB + '(B)';
  console.log('\n--- ' + label + ' ---');
  const revDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-cross-'));
  const revFile = path.join(revDir, 'atlas-revocations.json');
  fs.writeFileSync(revFile, JSON.stringify({ revoked: [] }));
  const issuerA = await T.newIssuer('a.example');
  const issuerB = await T.newIssuer('b.example');
  const overA = kindA === 'php' ? { revocationsFile: revFile } : {};
  const ctxA = await starters[kindA](overA, { issuer: issuerA, timers: TIMERS, limits: LIMITS });
  const ctxB = await starters[kindB]({}, { issuer: issuerB, timers: TIMERS, limits: LIMITS });
  const x = await Wallet.create(ctxA, 'x'); // member of A
  const y = await Wallet.create(ctxB, 'y'); // member of B
  const xA = on(x, ctxA), xB = on(x, ctxB), yA = on(y, ctxA), yB = on(y, ctxB);

  const infoA = await fetch(ctxA.base + '/atlas/call/info').then((r) => r.json());
  const infoB = await fetch(ctxB.base + '/atlas/call/info').then((r) => r.json());
  check(label + ': each service reports its own domain and audience', infoA.domain === 'a.example' && infoB.domain === 'b.example' && infoA.audience === ctxA.origin && infoB.audience === ctxB.origin);

  // ---------- X (member of A) calls Y (member of B) through B ----------
  let r = await yB.createTag(x.pub);
  check(label + ': the callee creates a tag at its own service with its own domain\'s membership', r.status === 200, r);
  const tagYB = r.json;
  const callXY = await driveCall(ctxB, xB, yB, tagYB, 'active');
  check(label + ': X calls Y through B and the call becomes active, with no membership for X on B', callXY.stage === 'active' && callXY.confirmB.status === 202, callXY.stage);
  check(label + ': B holds the call as active', (await ctxB.svc.callState(callXY.callId)) === 'ACTIVE');
  check(label + ': A has no record of that call', (await ctxA.svc.callState(callXY.callId)) === null);
  r = await hangup(ctxB, callXY, 'A');
  check(label + ': the caller ends the call at B', r.status === 202 || r.status === 200, r);

  // ---------- Y (member of B) calls X (member of A) through A ----------
  r = await xA.createTag(y.pub);
  check(label + ': the other direction: X creates a tag at A bound to Y', r.status === 200, r);
  const tagXA = r.json;
  const callYX = await driveCall(ctxA, yA, xA, tagXA, 'active');
  check(label + ': Y calls X through A and the call becomes active, with no membership for Y on A', callYX.stage === 'active' && callYX.confirmB.status === 202, callYX.stage);
  check(label + ': A holds that call and B does not', (await ctxA.svc.callState(callYX.callId)) === 'ACTIVE' && (await ctxB.svc.callState(callYX.callId)) === null);
  await hangup(ctxA, callYX, 'A');

  // ---------- domain membership is not weakened ----------
  r = await yA.createTag(x.pub, {}, await issuerB.membership(y.pub));
  check(label + ': a membership from B does not create a tag at A', r.status === 403, r);
  r = await xB.createTag(y.pub, {}, await issuerA.membership(x.pub));
  check(label + ': a membership from A does not create a tag at B', r.status === 403, r);
  r = await yA.createTag(x.pub, {}, null);
  check(label + ': a caller with no membership cannot create a tag on either service', r.status === 403 && r.json.code === 'membership-required', r);
  r = await yB.createTag(x.pub, {}, await issuerB.membership(x.pub));
  check(label + ': a membership owned by another wallet is refused', r.status === 403, r);
  r = await yB.createTag(x.pub, {}, await issuerB.membership(y.pub, { issuer: { domain: 'a.example' } }));
  check(label + ': a B-signed membership that claims domain A is refused at B', r.status === 403, r);
  r = await yA.createTag(x.pub, {}, await issuerB.membership(y.pub, { issuer: { domain: 'a.example' } }));
  check(label + ': a B-signed membership that claims domain A is refused at A', r.status === 403, r);

  // ---------- tags, audiences and replay do not cross services ----------
  const unknownOnB = await xB.invite(await xB.buildInvite(P.randomId(16), y.pub));
  const tagFromAOnB = await yB.invite(await yB.buildInvite(tagXA.tag, x.pub));
  check(label + ': a tag from A is unknown on B, and indistinguishable from any unknown tag', tagFromAOnB.status === 404 && JSON.stringify(tagFromAOnB) === JSON.stringify(unknownOnB), tagFromAOnB);
  const wrongHost = await xB.buildInvite(tagYB.tag, y.pub);
  r = await post(ctxA.base, '/atlas/call/invite', wrongHost.body);
  check(label + ': an invite addressed to B is refused when sent to A', r.status === 401 && r.json.code === 'wrong-audience', r);
  {
    const pay = { type: 'atlas.call.tag', v: 1, audience: ctxB.origin, issuedAt: iso(Date.now()), nonce: nonce(), bind: { kind: 'wallet', publicKey: x.pub }, calleeKey: y.pub, expiresAt: iso(Date.now() + 3600000), maxCalls: 5 };
    r = await post(ctxA.base, '/atlas/call/tag/create', { payload: pay, proof: await sign(pay, y.ident), membership: await issuerB.membership(y.pub) });
    check(label + ': a signed tag request addressed to B is refused when sent to A', r.status === 401 && r.json.code === 'wrong-audience', r);
  }
  {
    const pay = signalPayload(ctxB, callXY.callId, 'end', { reason: 'hangup' }, 99, callXY.th);
    const replayed = await post(ctxA.base, '/atlas/call/signal', { payload: pay, proof: await sign(pay, callXY.ckA) });
    check(label + ': a signal addressed to B is refused when replayed to A', replayed.status === 401 && replayed.json.code === 'wrong-audience', replayed);
  }
  {
    // The same signed request is spent once per service: B refuses a request B has already seen.
    const payload = base('atlas.call.tag-list', ctxB.origin, { nonce: nonce() });
    const s = await yB.session();
    const msg = { payload, proof: await sign(payload, s.sk), session: s.delegation };
    const first = await post(ctxB.base, '/atlas/call/tag/list', msg);
    const second = await post(ctxB.base, '/atlas/call/tag/list', msg);
    check(label + ': a request replayed to the same service is refused', first.status === 200 && second.status === 401 && second.json.code === 'replayed-request', [first.status, second]);
  }

  // ---------- revocation at A leaves B alone (PHP reads the issuer's file) ----------
  if (kindA === 'php') {
    const cred = await issuerA.membership(x.pub);
    r = await xA.createTag(y.pub, {}, cred);
    check(label + ': A accepts a current membership', r.status === 200, r);
    fs.writeFileSync(revFile, JSON.stringify({ revoked: [{ id: cred.id, at: iso(Date.now()) }] }));
    r = await xA.createTag(y.pub, {}, cred);
    check(label + ': A refuses it once its issuer revokes it', r.status === 403, r);
    r = await yB.createTag(x.pub);
    check(label + ': B is unaffected by A\'s revocations', r.status === 200, r);
    const before = await xB.invite(await xB.buildInvite(tagYB.tag, y.pub));
    check(label + ': X can still reach Y through B after A revoked X\'s membership', before.status === 202 || before.status === 409 || before.status === 429, before);
  }

  // ---------- a service is independent of the other being down ----------
  await ctxA.svc.close();
  r = await yB.createTag(x.pub);
  check(label + ': B keeps working with A stopped', r.status === 200, r);
  await ctxB.svc.close();
  fs.rmSync(revDir, { recursive: true, force: true });
}

(async () => {
  for (const [a, b] of [['php', 'php'], ['node', 'php'], ['php', 'node']]) await pairing(a, b);
  process.exit(T.finish('manual-call-php-cross'));
})().catch((e) => { console.error(e); process.exit(2); });
