// Manual check for task #203 (SPEC.md §7's new "Currency conversion"
// paragraph): POST /atlas/convert — swap part or all of a held fungible
// balance for a DIFFERENT fungible class at the issuing domain's own
// declared `exchangeRate`, no counterparty, no listing, no Trading Station
// membership — plus the companion `holdingCap` check added to
// POST /atlas/asset/issue at the same time (a fixed conversion rate alone
// would make a domain a risk-free arbitrage machine once every fungible
// element is also freely mineable, so mining a capped class now refuses
// once an owner already holds `holdingCap` or more of it).
//
// Run at the HTTP layer directly against BOTH backends, same "prove the
// wire shapes match before trusting a browser against them" reasoning
// manual-trade-submit-php.js and manual-trading-catalog.js already use.
// Spins up its own fully isolated instance of each backend (fresh port,
// fresh state) rather than sharing the long-running localhost:8001/:8002
// instances other tests assume — this feature's own state (mint counts
// approaching a 500-unit cap) is exactly the kind of thing that must not
// leak between runs or interfere with anything else using those ports.
//
// Neither /atlas/asset/issue nor /atlas/convert ever asks the CALLER to
// sign anything (unlike /atlas/trade/submit's proposeIntent envelope) —
// presenting a credential back is proof enough, the same "possession is
// the check" discipline /atlas/asset/split already relies on — so this
// test needs no real ECDSA keypairs at all, just a plain string owner id,
// same convention manual-serialized-assets.js already uses for the same
// reason.
//
// Covers, on the Node backend:
//   1. Converting an EXACT multiple (200 iron -> 10 gold at 20:1) leaves
//      no remainder.
//   2. Converting a NON-exact amount (25 iron -> 1 gold, 5 iron
//      remainder) floors the result rather than rejecting it.
//   3. Direct cross-pair conversion NOT involving the base currency
//      (100 iron -> 25 silver) works — the rate always routes through the
//      shared base-currency unit internally, so any two rated classes
//      convert directly.
//   4. Base-currency-to-other conversion (2 gold -> 10 silver) works too.
//   5. Converting a class into itself is rejected.
//   6. Converting INTO a bound, non-fungible class (atlas.membership) is
//      rejected with a clear "must be fungible, non-bound" message.
//   7. A spend too small to produce even 1 unit of the result rounds down
//      to 0 and is rejected outright, not silently minting nothing.
//   8. Spending more than the presented balance holds is rejected (the
//      existing checkPresentedAsset minQuantity check, reused unchanged).
//   9. The `holdingCap` (500) on iron blocks a further mint once an owner
//      already holds that much, verified against a presented balance —
//      and is entirely independent per class (gold mining is unaffected).
//  10. Presenting NO existingBalances is trusted as holding 0 and always
//      allowed through, even for an owner who actually holds far more —
//      a deliberate, documented trust boundary (this cap is a cooperative-
//      client convenience for the reference wallet, not adversarial-abuse
//      protection), not an oversight.
//  11. The cap does NOT block receiving a large amount of a capped class
//      through a legitimate conversion (mintAssetByClass's split/convert
//      call sites never go through the capped /atlas/asset/issue check at
//      all) — only fresh, uncapped-supply minting is limited.
//
// PHP backend: a shorter parity pass over the core mechanics (1, 2, 5, 7,
// 9, 10) on an independent bundle copy, proving the port didn't drift.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NODE_PORT = 8091; // isolated — distinct from every other manual-*.js test's chosen port
const NODE_DOMAIN = 'localhost:' + NODE_PORT;
const PHP_PORT = 8092; // isolated — distinct from manual-trading-catalog.js's 8093/8094, manual-trade-submit-php.js's 8096, manual-chat-php.js's 8097, manual-presence-php.js's 8098

const NODE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-convert-node-'));
const NODE_DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-convert-docroot-'));
const PHP_BUNDLE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-convert-php-'));

function post(base, urlPath, body) {
  return fetch(base + urlPath, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

async function issue(base, ownerPublicKey, assetClass, quantity, existingBalances) {
  const res = await post(base, '/atlas/asset/issue', {
    ownerPublicKey, assetClass, ...(quantity !== undefined ? { quantity } : {}), ...(existingBalances ? { existingBalances } : {})
  });
  if (res.status !== 200) throw new Error('Failed to issue ' + assetClass + ': ' + JSON.stringify(res.body));
  return res.body;
}

(async () => {
  console.log('SETUP: starting an isolated issuer-server instance on port ' + NODE_PORT);
  const nodeProc = spawn('node', ['issuer-server/server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(NODE_PORT), ATLAS_DOMAIN: NODE_DOMAIN, ATLAS_STATE_DIR: NODE_STATE_DIR, ATLAS_DOCROOT: NODE_DOCROOT_DIR },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('issuer-server did not start in time')), 10000);
    nodeProc.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); resolve(); } });
    nodeProc.on('exit', (code) => reject(new Error('issuer-server exited early with code ' + code)));
  });
  console.log('PASS: isolated issuer-server up on port ' + NODE_PORT);

  console.log('SETUP: copying issuer-php into an isolated bundle dir and starting its own dev server on port ' + PHP_PORT);
  fs.cpSync(path.resolve(__dirname, '..', 'issuer-php'), PHP_BUNDLE_DIR, { recursive: true });
  const phpProc = spawn('php', ['-S', 'localhost:' + PHP_PORT, 'test-router.php'], { cwd: PHP_BUNDLE_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('php -S did not start in time')), 5000);
    phpProc.stderr.on('data', (d) => { if (d.toString().includes('started')) { clearTimeout(timer); resolve(); } });
    phpProc.on('exit', (code) => reject(new Error('php -S exited early with code ' + code)));
  });
  console.log('PASS: isolated issuer-php dev server up on port ' + PHP_PORT);

  const NODE_BASE = 'http://localhost:' + NODE_PORT;
  const PHP_BASE = 'http://localhost:' + PHP_PORT;

  try {
    // ---------- Node ----------
    const OWNER = 'test-owner-currency-conversion-demo';

    console.log('STEP 1 (Node): converting an exact multiple leaves no remainder — 200 iron -> 10 gold at 20:1');
    const iron200 = await issue(NODE_BASE, OWNER, 'atlas.element.iron', 200);
    const exact = await post(NODE_BASE, '/atlas/convert', { credential: iron200, spendAmount: 200, toClass: 'atlas.element.gold' });
    if (exact.status !== 200 || exact.body.remainder !== null || exact.body.received.quantity !== 10 || exact.body.received.asset.class !== 'atlas.element.gold') {
      throw new Error('Expected 10 gold with no remainder, got: ' + JSON.stringify(exact.body));
    }
    console.log('PASS: received exactly 10 gold, remainder null ->', exact.body.received.id);

    console.log('STEP 2 (Node): a non-exact amount floors the result and keeps a remainder — 25 iron -> 1 gold, 5 iron left over');
    const iron30 = await issue(NODE_BASE, OWNER, 'atlas.element.iron', 30);
    const floored = await post(NODE_BASE, '/atlas/convert', { credential: iron30, spendAmount: 25, toClass: 'atlas.element.gold' });
    if (floored.status !== 200 || !floored.body.remainder || floored.body.remainder.quantity !== 5 || floored.body.received.quantity !== 1) {
      throw new Error('Expected 1 gold received + 5 iron remainder, got: ' + JSON.stringify(floored.body));
    }
    console.log('PASS: received 1 gold, kept a 5-iron remainder ->', JSON.stringify({ received: floored.body.received.quantity, remainder: floored.body.remainder.quantity }));

    console.log('STEP 3 (Node): direct cross-pair conversion not involving the base currency — 100 iron -> 25 silver (routes through gold internally: 100/20=5 gold-equivalent, 5*5=25 silver)');
    const iron100 = await issue(NODE_BASE, OWNER, 'atlas.element.iron', 100);
    const crossPair = await post(NODE_BASE, '/atlas/convert', { credential: iron100, spendAmount: 100, toClass: 'atlas.element.silver' });
    if (crossPair.status !== 200 || crossPair.body.received.quantity !== 25 || crossPair.body.received.asset.class !== 'atlas.element.silver') {
      throw new Error('Expected 25 silver, got: ' + JSON.stringify(crossPair.body));
    }
    console.log('PASS: 100 iron -> 25 silver directly, no explicit gold step needed ->', crossPair.body.received.id);

    console.log('STEP 4 (Node): base-currency-to-other conversion — 2 gold -> 10 silver');
    const gold2 = await issue(NODE_BASE, OWNER, 'atlas.element.gold', 2);
    const fromBase = await post(NODE_BASE, '/atlas/convert', { credential: gold2, spendAmount: 2, toClass: 'atlas.element.silver' });
    if (fromBase.status !== 200 || fromBase.body.received.quantity !== 10) throw new Error('Expected 10 silver, got: ' + JSON.stringify(fromBase.body));
    console.log('PASS: 2 gold -> 10 silver');

    console.log('STEP 5 (Node): converting a class into itself is rejected');
    const iron10 = await issue(NODE_BASE, OWNER, 'atlas.element.iron', 10);
    const selfConvert = await post(NODE_BASE, '/atlas/convert', { credential: iron10, spendAmount: 10, toClass: 'atlas.element.iron' });
    if (selfConvert.status !== 400 || !selfConvert.body.error.includes('itself')) throw new Error('Expected a clear self-conversion rejection, got: ' + JSON.stringify(selfConvert.body));
    console.log('PASS: rejected ->', selfConvert.body.error);

    console.log('STEP 6 (Node): converting INTO a bound, non-fungible class (atlas.membership) is rejected');
    const boundTarget = await post(NODE_BASE, '/atlas/convert', { credential: iron10, spendAmount: 10, toClass: 'atlas.membership' });
    if (boundTarget.status !== 400 || !boundTarget.body.error.includes('fungible')) throw new Error('Expected a clear "must be fungible, non-bound" rejection, got: ' + JSON.stringify(boundTarget.body));
    console.log('PASS: rejected ->', boundTarget.body.error);

    console.log('STEP 7 (Node): a spend too small to produce even 1 unit of the result rounds to 0 and is rejected outright');
    const iron5 = await issue(NODE_BASE, OWNER, 'atlas.element.iron', 5);
    const tooSmall = await post(NODE_BASE, '/atlas/convert', { credential: iron5, spendAmount: 5, toClass: 'atlas.element.gold' });
    if (tooSmall.status !== 400 || !tooSmall.body.error.includes('rounds down to 0')) throw new Error('Expected a "rounds down to 0" rejection, got: ' + JSON.stringify(tooSmall.body));
    console.log('PASS: rejected rather than silently minting nothing ->', tooSmall.body.error);

    console.log('STEP 8 (Node): spending more than the presented balance holds is rejected');
    const overspend = await post(NODE_BASE, '/atlas/convert', { credential: iron5, spendAmount: 999, toClass: 'atlas.element.gold' });
    if (overspend.status !== 400 || !overspend.body.error.includes('insufficient quantity')) throw new Error('Expected an insufficient-quantity rejection, got: ' + JSON.stringify(overspend.body));
    console.log('PASS: rejected ->', overspend.body.error);

    console.log('STEP 9 (Node): the 500 holdingCap on iron blocks a further mint once an owner holds that much, and is independent per class');
    const capOwner = 'test-owner-holding-cap-demo';
    const iron500 = await issue(NODE_BASE, capOwner, 'atlas.element.iron', 500);
    const overCap = await post(NODE_BASE, '/atlas/asset/issue', { ownerPublicKey: capOwner, assetClass: 'atlas.element.iron', quantity: 1, existingBalances: [iron500] });
    if (overCap.status !== 400 || !overCap.body.error.includes('cap: 500')) throw new Error('Expected the cap to block a further mint, got: ' + JSON.stringify(overCap.body));
    console.log('PASS: further iron mint blocked ->', overCap.body.error);
    const goldStillWorks = await post(NODE_BASE, '/atlas/asset/issue', { ownerPublicKey: capOwner, assetClass: 'atlas.element.gold', quantity: 50 });
    if (goldStillWorks.status !== 200) throw new Error('Expected gold minting to be completely unaffected by the iron cap, got: ' + JSON.stringify(goldStillWorks.body));
    console.log('PASS: gold minting for the same owner is unaffected — the cap is scoped per class, not per owner globally');

    console.log('STEP 10 (Node): presenting NO existingBalances is trusted as 0 held and always allowed, even though this owner actually holds 500 iron already — a deliberate trust boundary, not an oversight');
    const bypassesWithoutProof = await post(NODE_BASE, '/atlas/asset/issue', { ownerPublicKey: capOwner, assetClass: 'atlas.element.iron', quantity: 1 });
    if (bypassesWithoutProof.status !== 200) throw new Error('Expected minting without presented proof to succeed regardless of actual holdings, got: ' + JSON.stringify(bypassesWithoutProof.body));
    console.log('PASS: minted without presenting existingBalances — documents that this cap is a cooperative-client convenience, not an adversarial-abuse defense');

    console.log('STEP 11 (Node): the cap does not block RECEIVING a large amount of a capped class through a legitimate conversion');
    const gold600 = await issue(NODE_BASE, capOwner, 'atlas.element.gold', 600); // 600 gold -> 12000 iron at 20:1, far past the 500 cap
    const bigConvert = await post(NODE_BASE, '/atlas/convert', { credential: gold600, spendAmount: 600, toClass: 'atlas.element.iron' });
    if (bigConvert.status !== 200 || bigConvert.body.received.quantity !== 12000) throw new Error('Expected conversion to freely exceed the mining cap, got: ' + JSON.stringify(bigConvert.body));
    console.log('PASS: converted into 12000 iron — the holdingCap only ever gates fresh /atlas/asset/issue mints, never split/convert/trade re-mints');

    // ---------- PHP parity ----------
    const PHP_OWNER = 'test-owner-currency-conversion-php-demo';

    console.log('STEP 12 (PHP): same exact-multiple conversion — 200 iron -> 10 gold');
    const phpIron200 = await issue(PHP_BASE, PHP_OWNER, 'atlas.element.iron', 200);
    const phpExact = await post(PHP_BASE, '/atlas/convert', { credential: phpIron200, spendAmount: 200, toClass: 'atlas.element.gold' });
    if (phpExact.status !== 200 || phpExact.body.remainder !== null || phpExact.body.received.quantity !== 10) {
      throw new Error('Expected 10 gold with no remainder, got: ' + JSON.stringify(phpExact.body));
    }
    console.log('PASS: received exactly 10 gold, remainder null');

    console.log('STEP 13 (PHP): a non-exact amount floors the result — 25 iron -> 1 gold, 5 iron remainder');
    const phpIron30 = await issue(PHP_BASE, PHP_OWNER, 'atlas.element.iron', 30);
    const phpFloored = await post(PHP_BASE, '/atlas/convert', { credential: phpIron30, spendAmount: 25, toClass: 'atlas.element.gold' });
    if (phpFloored.status !== 200 || !phpFloored.body.remainder || phpFloored.body.remainder.quantity !== 5 || phpFloored.body.received.quantity !== 1) {
      throw new Error('Expected 1 gold received + 5 iron remainder, got: ' + JSON.stringify(phpFloored.body));
    }
    console.log('PASS: received 1 gold, kept a 5-iron remainder');

    console.log('STEP 14 (PHP): converting a class into itself is rejected');
    const phpIron10 = await issue(PHP_BASE, PHP_OWNER, 'atlas.element.iron', 10);
    const phpSelfConvert = await post(PHP_BASE, '/atlas/convert', { credential: phpIron10, spendAmount: 10, toClass: 'atlas.element.iron' });
    if (phpSelfConvert.status !== 400 || !phpSelfConvert.body.error.includes('itself')) throw new Error('Expected a clear self-conversion rejection, got: ' + JSON.stringify(phpSelfConvert.body));
    console.log('PASS: rejected ->', phpSelfConvert.body.error);

    console.log('STEP 15 (PHP): a spend too small to produce even 1 unit of the result rounds to 0 and is rejected');
    const phpIron5 = await issue(PHP_BASE, PHP_OWNER, 'atlas.element.iron', 5);
    const phpTooSmall = await post(PHP_BASE, '/atlas/convert', { credential: phpIron5, spendAmount: 5, toClass: 'atlas.element.gold' });
    if (phpTooSmall.status !== 400 || !phpTooSmall.body.error.includes('rounds down to 0')) throw new Error('Expected a "rounds down to 0" rejection, got: ' + JSON.stringify(phpTooSmall.body));
    console.log('PASS: rejected ->', phpTooSmall.body.error);

    console.log('STEP 16 (PHP): the 500 holdingCap on iron blocks a further mint, and presenting no proof is trusted as 0 held');
    const phpCapOwner = 'test-owner-holding-cap-php-demo';
    const phpIron500 = await issue(PHP_BASE, phpCapOwner, 'atlas.element.iron', 500);
    const phpOverCap = await post(PHP_BASE, '/atlas/asset/issue', { ownerPublicKey: phpCapOwner, assetClass: 'atlas.element.iron', quantity: 1, existingBalances: [phpIron500] });
    if (phpOverCap.status !== 400 || !phpOverCap.body.error.includes('cap: 500')) throw new Error('Expected the cap to block a further mint, got: ' + JSON.stringify(phpOverCap.body));
    console.log('PASS: further iron mint blocked ->', phpOverCap.body.error);
    const phpBypassesWithoutProof = await post(PHP_BASE, '/atlas/asset/issue', { ownerPublicKey: phpCapOwner, assetClass: 'atlas.element.iron', quantity: 1 });
    if (phpBypassesWithoutProof.status !== 200) throw new Error('Expected minting without presented proof to succeed, got: ' + JSON.stringify(phpBypassesWithoutProof.body));
    console.log('PASS: minted without presenting existingBalances, same trust boundary as the Node backend');

    console.log('\nALL CURRENCY CONVERSION + MINING CAP (TASK #203) CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    nodeProc.kill();
    phpProc.kill();
    try { fs.rmSync(NODE_STATE_DIR, { recursive: true, force: true }); } catch (err) {}
    try { fs.rmSync(NODE_DOCROOT_DIR, { recursive: true, force: true }); } catch (err) {}
    try { fs.rmSync(PHP_BUNDLE_DIR, { recursive: true, force: true }); } catch (err) {}
  }
})();
