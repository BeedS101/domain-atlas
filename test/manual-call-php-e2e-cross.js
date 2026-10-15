// Two real wallets in two Chromium profiles, each listening on a different Call Service for a
// different domain, call each other in both directions. The caller uses the service named on
// the callee's call card. Runs the pairings Node(A)+PHP(B) and PHP(A)+PHP(B).
//
// Needs both local demo domains (they issue the Post Office memberships the services admit):
//   PORT=8001 ATLAS_DOMAIN=localhost:8001 ATLAS_DOCROOT=demo-domain-a \
//     ATLAS_STATE_DIR=issuer-server/domain-a-state node issuer-server/server.js
//   PORT=8002 ATLAS_DOMAIN=localhost:8002 ATLAS_DOCROOT=demo-domain-b \
//     ATLAS_STATE_DIR=issuer-server/domain-b-state node issuer-server/server.js
// Run: xvfb-run -a node test/manual-call-php-e2e-cross.js
//
// Chromium's fake capture device stands in for a microphone. Both wallets belong to the
// domain-B Post Office for mail; the caller's membership on the callee's domain is not
// removed here (the service-level suite manual-call-php-cross.js covers a caller with none).
'use strict';
// Service B is always the PHP service; call-e2e-lib starts it when this is set.
process.env.ATLAS_CALL_BACKEND = 'php';
const L = require('./call-e2e-lib');
const php = require('./call-php-lib');
const T = require('./call-test-lib');
const { createCallService } = require('../call-server/server.js');
const { check, sleep, until } = L;

const DOMAIN_A = 'localhost:8001';
const keyOf = async (domain) => {
  const j = await (await fetch('http://' + domain + '/.well-known/atlas-key.json')).json();
  return j.keys[j.keys.length - 1].publicKey;
};
const LIMITS = { invitesPerCallerPerMin: 100, invitesPerCalleePerMin: 100, invitesPerSourcePerMin: 200 };

async function startA(kind) {
  const over = { domain: DOMAIN_A, issuerKeys: [await keyOf(DOMAIN_A)] };
  if (kind === 'php') {
    const ctx = await php.startPhpService(over, { limits: LIMITS });
    return { svc: ctx.svc, origin: ctx.origin, close: () => ctx.svc.close() };
  }
  const ctx = await T.startService(Object.assign({ revocationsUrl: null }, over), { limits: LIMITS });
  return { svc: ctx.svc, origin: ctx.origin, close: () => ctx.svc.close() };
}

async function oneCall(label, caller, callee, calleeName, pCaller, pCallee) {
  await pCaller.click('#btnDismiss').catch(() => {}); await pCallee.click('#btnDismiss').catch(() => {});
  await caller.dial(calleeName);
  await pCallee.waitForSelector('#btnAnswer:not([hidden])', { timeout: 20000 });
  await pCallee.click('#btnAnswer');
  const live = await until(async () => { const a = await caller.snap(), b = await callee.snap(); return a.call && b.call && a.call.audioOn && b.call.audioOn; }, 40000, 250);
  check(label + ': both sides reach an active call with audio enabled', !!live);
  await sleep(2500);
  const sa = await caller.stats(), sb = await callee.stats();
  check(label + ': audio flows in both directions', sa.inBytes > 0 && sa.outBytes > 0 && sb.inBytes > 0 && sb.outBytes > 0, { sa, sb });
  await pCaller.click('#btnHangup');
  const tA = await until(async () => { const t = await caller.teardown(); return t && t.reason === 'hangup' && t; }, 15000, 200);
  const tB = await until(async () => { const t = await callee.teardown(); return t && t.reason === 'hangup' && t; }, 15000, 200);
  check(label + ': hanging up releases the microphone and the connection on both sides', !!tA && !!tB && tA.liveTracksAfter === 0 && tB.liveTracksAfter === 0 && tA.pcState === 'closed' && tB.pcState === 'closed', { tA, tB });
}

async function pairing(kindA) {
  const label = kindA + '(A) + php(B)';
  console.log('\n--- ' + label + ' ---');
  const a = await startA(kindA);
  const b = await L.startCallService(null, { limits: LIMITS });
  const { alice, bob } = await L.makePair(b);
  try {
    // Each wallet listens on its own domain's service. Alice also joins domain A's Post Office.
    await alice.wallet(([d]) => AtlasWallet.mintAsset('self', d, 'atlas.postoffice.membership'), [DOMAIN_A]);
    await alice.wallet((s) => AtlasWallet.setCallConfig({ service: s, devAllowHttp: true }), a.origin);
    await bob.wallet((s) => AtlasWallet.setCallConfig({ service: s, devAllowHttp: true }), b.origin);
    // New grants name each callee's own service.
    for (const [w, k] of [[alice, bob.pub], [bob, alice.pub]]) { await w.wallet((c) => AtlasWallet.revokeCalling(c), k); await w.wallet((c) => AtlasWallet.grantCalling(c), k); }
    const cards = await until(async () => {
      for (const w of [alice, bob]) await w.wallet(() => AtlasWallet.checkAllMail());
      const ca = await alice.wallet((k) => AtlasWallet.getCallCardFor(k), bob.pub);
      const cb = await bob.wallet((k) => AtlasWallet.getCallCardFor(k), alice.pub);
      return ca && cb && ca.service === b.origin && cb.service === a.origin ? { ca, cb } : false;
    }, 20000, 500);
    check(label + ': each contact\'s call card names that contact\'s own service', !!cards);
    const pa = await alice.openCallWindow(), pb = await bob.openCallWindow();
    await alice.available(); await bob.available();
    check(label + ': both wallets listen, each on a different service', (await alice.snap()).listening && (await bob.snap()).listening);
    await oneCall(label + ' Alice calls Bob through B', alice, bob, 'Bob', pa, pb);
    await oneCall(label + ' Bob calls Alice through A', bob, alice, 'Alice', pb, pa);
    check(label + ': no uncaught page errors on either side', alice.errors.length === 0 && bob.errors.length === 0, { a: alice.errors, b: bob.errors });
  } catch (e) {
    check(label + ': test run completed', false, String(e && e.stack || e));
    for (const w of [alice, bob]) { try { console.log('--- ' + w.label + ' log tail'); console.log((await w.log()).slice(-14).join('\n')); } catch (e2) { /* page gone */ } }
  } finally {
    await alice.close(); await bob.close(); await a.close(); await b.close();
  }
}

(async () => {
  await pairing('node');
  await pairing('php');
  process.exit(L.finish('manual-call-php-e2e-cross'));
})();
