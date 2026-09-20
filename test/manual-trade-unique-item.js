// Manual check for the task #250 fourth follow-up: the Trading Station's
// open-listing mechanism (SPEC.md §7) was fungible-only by design until
// now — offer/want could only ever name a class and a quantity, and
// checkPresentedAsset's fungible!==true rejection was the one thing
// standing between that and a genuinely unique item like the Signet Ring
// (atlas.wearable.ring). See issuer-server/server.js's own comment above
// POST /atlas/trade/submit for the full design reasoning (why no new
// intent field was needed, why checkPresentedUniqueAsset/
// transferUniqueAsset exist as parallel functions rather than changes to
// the fungible-only ones).
//
// Also exercises transferUniqueAsset() itself, which this follow-up
// introduced to fix a real, independently-discovered bug: a non-fungible
// re-mint (World Drops claim, and now Trading Station settlement) used to
// go through mintAssetByClass(), which rebuilds `asset` fresh from the
// static catalog — correct for a fungible re-mint (every balance of a
// fungible class is identical by definition) but silently wrong for a
// unique item, discarding whatever made that specific instance unique (a
// Signet Ring's serial number and randomly-rolled enchantments/stats) and
// replacing them with the class's static fallback. The Signet Ring was
// already nominally droppable in the plaza's own acceptedItemClasses
// before this follow-up, so this was a live gap, not just theoretical.
//
// Run at the HTTP layer directly against BOTH backends, own isolated
// instances (same reasoning manual-trading-catalog.js/
// manual-reissue-tradescope.js already use for this same reason).
//
// Checks:
//   1. Node — GET /atlas/trade/catalog now lists atlas.wearable.ring
//      (fungible: false, tradeScope: local) alongside the fungible classes.
//   2. Node — a poster offers a specific, already-minted Signet Ring
//      (unique) wanting gold; a claimant claims it with gold. The claimant
//      receives the *exact* ring instance (same enchantments/stats/serial
//      the poster's original mint rolled — not a fresh, re-rolled one),
//      proving transferUniqueAsset preserves per-instance identity across
//      a trade. The poster receives the gold.
//   3. Node — the reverse shape: a poster offers gold wanting a ring; a
//      claimant matches by presenting their own ring balance. Same
//      instance-preservation proof, other direction.
//   4. Node — an intent naming a non-fungible class with quantity !== 1 is
//      rejected by validateTradeSideShape before anything else runs.
//   5. Node — a bound asset (atlas.wearable, task #250 second follow-up)
//      cannot be offered at the Trading Station at all — same
//      "tradeScope: 'bound'" rejection checkPresentedUniqueAsset shares
//      with checkPresentedAsset.
//   6. Node — a World Drops claim of a Signet Ring also preserves its
//      enchantments/stats/serial (the same transferUniqueAsset fix,
//      exercised through the OTHER call site that needed it).
//   7. PHP — the same core unique-item trade flow (steps 1 and 2) on an
//      independent issuer-php bundle, off its own ATLAS_ASSET_CATALOG.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { spawn } = require('child_process');
const { webcrypto } = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { subtle } = webcrypto;
const NODE_PORT = 8107; // isolated — distinct from every other manual-*.js test's chosen port
const NODE_DOMAIN = 'localhost:' + NODE_PORT;
const NODE_BASE = 'http://' + NODE_DOMAIN;
const PHP_PORT = 8108;
const PHP_BASE = 'http://localhost:' + PHP_PORT;

const NODE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-trade-unique-node-'));
const NODE_DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-trade-unique-docroot-'));
const PHP_BUNDLE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-trade-unique-php-'));

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}
async function generateIdentity() {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const rawPublic = await subtle.exportKey('raw', pair.publicKey);
  return { privateKey: pair.privateKey, publicKey: b64url(rawPublic) };
}
async function signPayload(identity, payload) {
  const data = new TextEncoder().encode(canonicalize(payload));
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, identity.privateKey, data);
  return { signerRole: 'raw-ecdsa', publicKey: identity.publicKey, signature: b64url(sig) };
}
async function proposeIntent(identity, offer, want, counterpartyPublicKey, expiresMinutes) {
  const payload = {
    offer, want,
    ...(counterpartyPublicKey !== undefined ? { counterparty: counterpartyPublicKey } : {}),
    expiresAt: new Date(Date.now() + (expiresMinutes || 10) * 60000).toISOString()
  };
  const proof = await signPayload(identity, payload);
  return { payload, proof };
}
function post(base, urlPath, body) {
  return fetch(base + urlPath, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}
function get(base, urlPath) {
  return fetch(base + urlPath).then(async (r) => ({ status: r.status, body: await r.json() }));
}
async function issueAsset(base, ownerPublicKey, assetClass, quantity) {
  const res = await post(base, '/atlas/asset/issue', { ownerPublicKey, assetClass, quantity });
  if (res.status !== 200) throw new Error('Failed to issue ' + assetClass + ' at ' + base + ': ' + JSON.stringify(res.body));
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

  try {
    const poster = await generateIdentity();
    const claimant = await generateIdentity();

    console.log('STEP 1: Node — GET /atlas/trade/catalog now lists atlas.wearable.ring alongside the fungible classes, correctly flagged fungible: false');
    const catalog = await get(NODE_BASE, '/atlas/trade/catalog');
    const ringEntry = catalog.body.classes.find((c) => c.class === 'atlas.wearable.ring');
    if (!ringEntry) throw new Error('Expected atlas.wearable.ring to appear in the trade catalog now, got classes: ' + JSON.stringify(catalog.body.classes.map((c) => c.class)));
    if (ringEntry.fungible !== false || ringEntry.tradeScope !== 'local') throw new Error('Expected the ring entry to read fungible:false, tradeScope:local, got: ' + JSON.stringify(ringEntry));
    console.log('PASS: ring is discoverable, correctly flagged ->', JSON.stringify(ringEntry));

    console.log('STEP 2: Node — poster offers a specific Signet Ring for gold; claimant claims it, receiving the SAME instance (enchantments/stats/serial preserved, not re-rolled)');
    const posterMembership = await issueAsset(NODE_BASE, poster.publicKey, 'atlas.tradingstation.membership');
    const claimantMembership = await issueAsset(NODE_BASE, claimant.publicKey, 'atlas.tradingstation.membership');
    const posterRing = await issueAsset(NODE_BASE, poster.publicKey, 'atlas.wearable.ring', 1);
    if (posterRing.asset.fungible !== false || !posterRing.asset.properties['atlas.serial']) throw new Error('Expected a real serialized ring, got: ' + JSON.stringify(posterRing.asset));
    const originalEnchantments = posterRing.asset.properties['com.example.enchantments'];
    const originalStats = posterRing.asset.properties['com.example.stats'];
    const originalRarity = posterRing.asset.properties['atlas.rarity'];
    const originalSerial = posterRing.asset.properties['atlas.serial'];
    const claimantGold = await issueAsset(NODE_BASE, claimant.publicKey, 'atlas.element.gold', 5);

    const posterIntent = await proposeIntent(poster, { class: 'atlas.wearable.ring', quantity: 1 }, { class: 'atlas.element.gold', quantity: 3 }, undefined);
    const submit = await post(NODE_BASE, '/atlas/trade/submit', { membership: posterMembership, intent: posterIntent, balance: posterRing });
    if (submit.status !== 200 || !submit.body.pendingId) throw new Error('Expected the ring listing to queue as pending, got: ' + JSON.stringify(submit.body));

    const claimantIntent = await proposeIntent(claimant, { class: 'atlas.element.gold', quantity: 3 }, { class: 'atlas.wearable.ring', quantity: 1 }, poster.publicKey);
    const claim = await post(NODE_BASE, '/atlas/trade/claim', { pendingId: submit.body.pendingId, membership: claimantMembership, intent: claimantIntent, balance: claimantGold });
    if (claim.status !== 200 || claim.body.status !== 'settled') throw new Error('Expected the ring-for-gold claim to settle, got: ' + JSON.stringify(claim.body));
    const receivedRing = claim.body.received;
    if (receivedRing.asset.class !== 'atlas.wearable.ring' || receivedRing.quantity !== 1) throw new Error('Expected the claimant to receive exactly one ring, got: ' + JSON.stringify(receivedRing));
    if (JSON.stringify(receivedRing.asset.properties['com.example.enchantments']) !== JSON.stringify(originalEnchantments)) {
      throw new Error('Expected the SAME enchantments to survive the trade (transferUniqueAsset), got original=' + JSON.stringify(originalEnchantments) + ' received=' + JSON.stringify(receivedRing.asset.properties['com.example.enchantments']));
    }
    if (JSON.stringify(receivedRing.asset.properties['com.example.stats']) !== JSON.stringify(originalStats)) {
      throw new Error('Expected the SAME stats to survive the trade, got original=' + JSON.stringify(originalStats) + ' received=' + JSON.stringify(receivedRing.asset.properties['com.example.stats']));
    }
    if (receivedRing.asset.properties['atlas.rarity'] !== originalRarity || receivedRing.asset.properties['atlas.serial'] !== originalSerial) {
      throw new Error('Expected the same rarity/serial to survive the trade, got: ' + JSON.stringify(receivedRing.asset.properties));
    }
    console.log('PASS: claimant received the exact same ring instance (rarity=' + originalRarity + ', serial=' + originalSerial + ', enchantments=' + JSON.stringify(originalEnchantments) + ') — nothing re-rolled');

    const posterMailCheck = await post(NODE_BASE, '/atlas/mail/check', { credentialIds: [posterRing.id] });
    const goldGiftMail = posterMailCheck.body.messages.find((m) => m.subject.startsWith('Listing claimed at'));
    if (!goldGiftMail || goldGiftMail.attachedAsset.asset.class !== 'atlas.element.gold' || goldGiftMail.attachedAsset.quantity !== 3) {
      throw new Error('Expected poster to receive 3 gold via the usual mail-gift path, got: ' + JSON.stringify(posterMailCheck.body.messages));
    }
    console.log('PASS: poster received the 3 gold via the ordinary mail-check path');

    console.log('STEP 3: Node — the reverse shape: poster offers gold wanting a ring, claimant matches with their own ring balance');
    const posterGold2 = await issueAsset(NODE_BASE, poster.publicKey, 'atlas.element.gold', 4);
    const claimantRing = await issueAsset(NODE_BASE, claimant.publicKey, 'atlas.wearable.ring', 1);
    const claimantOriginalEnchantments = claimantRing.asset.properties['com.example.enchantments'];

    const posterIntent2 = await proposeIntent(poster, { class: 'atlas.element.gold', quantity: 4 }, { class: 'atlas.wearable.ring', quantity: 1 }, undefined);
    const submit2 = await post(NODE_BASE, '/atlas/trade/submit', { membership: posterMembership, intent: posterIntent2, balance: posterGold2 });
    if (submit2.status !== 200 || !submit2.body.pendingId) throw new Error('Expected the gold-for-ring listing to queue, got: ' + JSON.stringify(submit2.body));

    const claimantIntent2 = await proposeIntent(claimant, { class: 'atlas.wearable.ring', quantity: 1 }, { class: 'atlas.element.gold', quantity: 4 }, poster.publicKey);
    const claim2 = await post(NODE_BASE, '/atlas/trade/claim', { pendingId: submit2.body.pendingId, membership: claimantMembership, intent: claimantIntent2, balance: claimantRing });
    if (claim2.status !== 200 || claim2.body.status !== 'settled') throw new Error('Expected the gold-for-ring claim to settle, got: ' + JSON.stringify(claim2.body));
    if (claim2.body.received.asset.class !== 'atlas.element.gold' || claim2.body.received.quantity !== 4) throw new Error('Expected claimant to receive exactly 4 gold, got: ' + JSON.stringify(claim2.body.received));

    const posterMailCheck2 = await post(NODE_BASE, '/atlas/mail/check', { credentialIds: [posterGold2.id] });
    const ringGiftMail = posterMailCheck2.body.messages.find((m) => m.subject.startsWith('Listing claimed at'));
    if (!ringGiftMail || ringGiftMail.attachedAsset.asset.class !== 'atlas.wearable.ring') throw new Error('Expected poster to receive the ring via mail gift, got: ' + JSON.stringify(posterMailCheck2.body.messages));
    if (JSON.stringify(ringGiftMail.attachedAsset.asset.properties['com.example.enchantments']) !== JSON.stringify(claimantOriginalEnchantments)) {
      throw new Error('Expected the poster to receive the claimant\'s ACTUAL ring instance, enchantments unchanged');
    }
    console.log('PASS: reverse direction settles correctly too — poster received the claimant\'s exact ring instance');

    console.log('STEP 4: Node — a non-fungible class offered/wanted with quantity !== 1 is rejected before anything else runs');
    const badQtyIntent = await proposeIntent(poster, { class: 'atlas.wearable.ring', quantity: 2 }, { class: 'atlas.element.gold', quantity: 1 }, undefined);
    const anotherRing = await issueAsset(NODE_BASE, poster.publicKey, 'atlas.wearable.ring', 1);
    const badQtySubmit = await post(NODE_BASE, '/atlas/trade/submit', { membership: posterMembership, intent: badQtyIntent, balance: anotherRing });
    if (badQtySubmit.status !== 400 || !/quantity must be 1/.test(badQtySubmit.body.error || '')) {
      throw new Error('Expected a clear quantity-must-be-1 rejection, got: ' + JSON.stringify(badQtySubmit));
    }
    console.log('PASS: quantity !== 1 for a non-fungible class rejected ->', badQtySubmit.body.error);

    console.log('STEP 5: Node — a bound asset (atlas.wearable, task #250 second follow-up) cannot be offered at the Trading Station at all');
    const boundCompass = await issueAsset(NODE_BASE, poster.publicKey, 'atlas.wearable', 1);
    const boundIntent = await proposeIntent(poster, { class: 'atlas.wearable', quantity: 1 }, { class: 'atlas.element.gold', quantity: 1 }, undefined);
    const boundSubmit = await post(NODE_BASE, '/atlas/trade/submit', { membership: posterMembership, intent: boundIntent, balance: boundCompass });
    if (boundSubmit.status !== 400 || !/bound/.test(boundSubmit.body.error || '')) {
      throw new Error('Expected a bound-asset rejection, got: ' + JSON.stringify(boundSubmit));
    }
    console.log('PASS: bound asset rejected at the Trading Station ->', boundSubmit.body.error);

    console.log('STEP 6: Node — a World Drops claim of a Signet Ring also preserves its enchantments/stats/serial (transferUniqueAsset, the other call site this fixes)');
    const dropRing = await issueAsset(NODE_BASE, poster.publicKey, 'atlas.wearable.ring', 1);
    const dropOriginalEnchantments = dropRing.asset.properties['com.example.enchantments'];
    const dropOriginalSerial = dropRing.asset.properties['atlas.serial'];
    const dropPayload = { action: 'drop', credentialId: dropRing.id, world: 'trade-unique-item-test-world', droppedAt: new Date().toISOString() };
    const dropProof = await signPayload(poster, dropPayload);
    const dropRes = await post(NODE_BASE, '/atlas/world/drop', { credential: dropRing, world: 'trade-unique-item-test-world', position: [0, 0, 0], intent: { payload: dropPayload, proof: dropProof } });
    if (dropRes.status !== 200 || !dropRes.body.dropId) throw new Error('Expected the ring drop to succeed, got: ' + JSON.stringify(dropRes));
    const claimPayload = { action: 'claim', dropId: dropRes.body.dropId, claimedAt: new Date().toISOString() };
    const claimProof = await signPayload(claimant, claimPayload);
    const dropClaim = await post(NODE_BASE, '/atlas/world/drops/claim', { dropId: dropRes.body.dropId, intent: { payload: claimPayload, proof: claimProof } });
    if (dropClaim.status !== 200 || dropClaim.body.status !== 'claimed') throw new Error('Expected the ring pickup to succeed, got: ' + JSON.stringify(dropClaim));
    if (JSON.stringify(dropClaim.body.credential.asset.properties['com.example.enchantments']) !== JSON.stringify(dropOriginalEnchantments)) {
      throw new Error('Expected the picked-up ring to keep its original enchantments, got original=' + JSON.stringify(dropOriginalEnchantments) + ' picked-up=' + JSON.stringify(dropClaim.body.credential.asset.properties['com.example.enchantments']));
    }
    if (dropClaim.body.credential.asset.properties['atlas.serial'] !== dropOriginalSerial) {
      throw new Error('Expected the picked-up ring to keep its original serial, got original=' + dropOriginalSerial + ' picked-up=' + dropClaim.body.credential.asset.properties['atlas.serial']);
    }
    console.log('PASS: World Drops claim also preserves the ring\'s exact enchantments/serial (serial=' + dropOriginalSerial + ') — the same latent bug this follow-up fixed');

    console.log('STEP 7: PHP — the same core unique-item trade flow on an independent issuer-php bundle');
    const phpPoster = await generateIdentity();
    const phpClaimant = await generateIdentity();
    const phpPosterMembership = await issueAsset(PHP_BASE, phpPoster.publicKey, 'atlas.tradingstation.membership');
    const phpClaimantMembership = await issueAsset(PHP_BASE, phpClaimant.publicKey, 'atlas.tradingstation.membership');
    const phpRing = await issueAsset(PHP_BASE, phpPoster.publicKey, 'atlas.wearable.ring', 1);
    const phpOriginalEnchantments = phpRing.asset.properties['com.example.enchantments'];
    const phpGold = await issueAsset(PHP_BASE, phpClaimant.publicKey, 'atlas.element.gold', 5);

    const phpCatalog = await get(PHP_BASE, '/atlas/trade/catalog');
    const phpRingEntry = phpCatalog.body.classes.find((c) => c.class === 'atlas.wearable.ring');
    if (!phpRingEntry || phpRingEntry.fungible !== false) throw new Error('Expected PHP trade catalog to also list the ring as fungible:false, got: ' + JSON.stringify(phpRingEntry));

    const phpPosterIntent = await proposeIntent(phpPoster, { class: 'atlas.wearable.ring', quantity: 1 }, { class: 'atlas.element.gold', quantity: 3 }, undefined);
    const phpSubmit = await post(PHP_BASE, '/atlas/trade/submit', { membership: phpPosterMembership, intent: phpPosterIntent, balance: phpRing });
    if (phpSubmit.status !== 200 || !phpSubmit.body.pendingId) throw new Error('Expected PHP ring listing to queue, got: ' + JSON.stringify(phpSubmit.body));
    const phpClaimantIntent = await proposeIntent(phpClaimant, { class: 'atlas.element.gold', quantity: 3 }, { class: 'atlas.wearable.ring', quantity: 1 }, phpPoster.publicKey);
    const phpClaim = await post(PHP_BASE, '/atlas/trade/claim', { pendingId: phpSubmit.body.pendingId, membership: phpClaimantMembership, intent: phpClaimantIntent, balance: phpGold });
    if (phpClaim.status !== 200 || phpClaim.body.status !== 'settled') throw new Error('Expected PHP ring-for-gold claim to settle, got: ' + JSON.stringify(phpClaim.body));
    if (JSON.stringify(phpClaim.body.received.asset.properties['com.example.enchantments']) !== JSON.stringify(phpOriginalEnchantments)) {
      throw new Error('Expected PHP to also preserve the exact ring instance across settlement');
    }
    console.log('PASS: PHP matches Node — unique-item trade settles correctly, exact instance preserved');

    console.log('\nALL TRADE UNIQUE-ITEM (TASK #250 FOURTH FOLLOW-UP) CHECKS PASSED');
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
