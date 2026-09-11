// Manual check for issuer-php's port of task #144 Phase 1 (remote trade
// settlement, reshaped to open listings in v1.14 — SPEC.md §7.1) and the
// task #160 bound-tradeScope enforcement it leans on — tracked as task
// #172 ("port #144 Phase 1 + #160 bound tradeScope to issuer-php") and
// task #176 (porting the v1.14 listings/claim/cancel reshape itself).
//
// Run at the HTTP layer directly against issuer-php (same style as
// manual-chat-php.js for presence-php) rather than through a full
// Playwright/extension journey — this proves the actual PHP request/
// response shapes and cryptographic signing/verification are correct
// before trusting anything in the browser against them, and is far
// faster than driving a whole wallet UI for what's fundamentally a
// backend port. Builds real ECDSA P-256 keypairs and signs real
// canonicalize()+SHA-256 "raw-ecdsa" envelopes with Node's own
// crypto.webcrypto (a spec-compliant Web Crypto implementation, so the
// raw EC point / raw signature formats interop byte-for-byte with what
// extension/wallet.js's signAs() produces in a real browser) — exactly
// mirroring issuer-server/server.js's own manual-remote-trade.js coverage,
// just against the PHP backend and at the HTTP layer instead of through
// the UI.
//
// Covers:
//   1. POST /atlas/asset/issue's "Unknown assetClass" error now lists
//      atlas.tradingstation.membership (it didn't before this port).
//   2. Issuing atlas.tradingstation.membership succeeds, is tradeScope:
//      "bound", logs to the roster file, and queues a welcome mail
//      message (mirroring atlas.postoffice.membership's existing
//      PHP handling).
//   3. Task #160 sanity check: attempting to split a bound credential
//      (atlas.tradingstation.membership itself) is rejected with the
//      dedicated "asset is bound to its owner..." message, not the
//      generic "not fungible" one — proving check_presented_asset()'s
//      new bound check actually runs, in the shared function every
//      split/consolidate/trade endpoint calls.
//   4. Poster posts an open listing (10 iron for 5 gold) naming no
//      counterparty at all — POST /atlas/trade/submit always queues, it
//      never auto-matches.
//   5. GET /atlas/trade/listings is ungated (no membership presented) and
//      shows the open listing to anyone browsing.
//   6. Claimant (a second Trading Station member) claims it by pendingId
//      via POST /atlas/trade/claim — settles immediately since the
//      claimant is "live" for this call; the response carries its own
//      remainder + received credentials directly.
//   7. Poster (not live at the time of the claim) receives the rest via
//      the ordinary /atlas/mail/check path: the iron remainder arrives via
//      the asset-update/supersession channel, and the received gold
//      arrives as a mail message with attachedAsset — reusing task #59's
//      existing claim mechanism, exactly as issuer-server/server.js's own
//      version does.
//   8. Regression: an ordinary (non-bound, tradeScope: local) fungible
//      split still works.
//   9. POST /atlas/trade/cancel withdraws a still-open listing (it drops
//      out of GET /atlas/trade/listings) and is rejected with 403 when
//      attempted by anyone other than the original poster.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { spawn } = require('child_process');
const { webcrypto } = require('crypto');
const fs = require('fs');
const path = require('path');

const { subtle } = webcrypto;
const PORT = 8096; // isolated port, distinct from manual-chat-php.js's 8097 and manual-presence-php.js's 8098
const BASE = 'http://localhost:' + PORT;
const BUNDLE_DIR = path.resolve(__dirname, '..', 'issuer-php');

// Every file this run can generate — cleaned up before AND after, same
// reasoning as manual-chat-php.js's PRESENCE_STORE_FILE/CHAT_STORE_FILE
// cleanup: these are runtime state for a real deployment, not fixtures to
// commit, and a stale one from an earlier run (e.g. a leftover issuer key)
// would otherwise make signatures from a fresh test run fail to verify.
const GENERATED_FILES = [
  path.resolve(BUNDLE_DIR, 'lib', 'issuer-private-key.pem'),
  path.resolve(BUNDLE_DIR, '.well-known', 'atlas-key.json'),
  path.resolve(BUNDLE_DIR, '.well-known', 'atlas-revocations.json'),
  path.resolve(BUNDLE_DIR, 'lib', 'atlas-mail-store.json'),
  path.resolve(BUNDLE_DIR, 'lib', 'atlas-asset-updates-store.json'),
  path.resolve(BUNDLE_DIR, 'lib', 'atlas-subscribers-store.json'),
  path.resolve(BUNDLE_DIR, 'lib', 'atlas-postoffice-members-store.json'),
  path.resolve(BUNDLE_DIR, 'lib', 'atlas-tradingstation-members-store.json'),
  path.resolve(BUNDLE_DIR, 'lib', 'atlas-pending-trades-store.json'),
  path.resolve(BUNDLE_DIR, 'lib', 'atlas-serial-counters-store.json'),
];
function cleanGeneratedFiles() {
  for (const f of GENERATED_FILES) { try { fs.unlinkSync(f); } catch (err) {} }
  try { fs.rmdirSync(path.resolve(BUNDLE_DIR, '.well-known')); } catch (err) {}
}

// ---------- crypto helpers — mirror extension/wallet.js's canonicalize()/
// signAs()/proposeIntent() exactly, using Node's built-in Web Crypto
// instead of a browser's, so signatures interop byte-for-byte with what
// issuer-php/lib/bootstrap.php's verify_envelope() expects. ----------

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

// v1.14 — mirrors wallet.js's proposeIntent(role, offer, want,
// counterpartyPublicKey, expiresMinutes) exactly, including omitting the
// `counterparty` field entirely (not just setting it null/undefined —
// JSON.stringify drops an undefined-valued key) when posting an open
// listing with no counterparty named at all.
async function proposeIntent(identity, offer, want, counterpartyPublicKey, expiresMinutes) {
  const payload = {
    offer, want,
    ...(counterpartyPublicKey !== undefined ? { counterparty: counterpartyPublicKey } : {}),
    expiresAt: new Date(Date.now() + (expiresMinutes || 10) * 60000).toISOString()
  };
  const proof = await signPayload(identity, payload);
  return { payload, proof };
}

function post(urlPath, body) {
  return fetch(BASE + urlPath, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

function get(urlPath) {
  return fetch(BASE + urlPath).then(async (r) => ({ status: r.status, body: await r.json() }));
}

async function issueAsset(ownerPublicKey, assetClass, quantity) {
  const res = await post('/atlas/asset/issue', { ownerPublicKey, assetClass, quantity });
  if (res.status !== 200) throw new Error('Failed to issue ' + assetClass + ': ' + JSON.stringify(res.body));
  return res.body;
}

(async () => {
  console.log('SETUP: starting PHP\'s built-in dev server against issuer-php/test-router.php');
  cleanGeneratedFiles();
  const serverProc = spawn('php', ['-S', 'localhost:' + PORT, 'test-router.php'], { cwd: BUNDLE_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('php -S did not start in time')), 5000);
    serverProc.stderr.on('data', (d) => { if (d.toString().includes('started')) { clearTimeout(timer); resolve(); } });
    serverProc.on('exit', (code) => reject(new Error('php -S exited early with code ' + code)));
  });
  console.log('PASS: PHP dev server up on port ' + PORT);

  try {
    const poster = await generateIdentity();
    const claimant = await generateIdentity();

    console.log('STEP 1: POST /atlas/asset/issue with an unknown class now lists atlas.tradingstation.membership in its error');
    const unknown = await post('/atlas/asset/issue', { ownerPublicKey: poster.publicKey, assetClass: 'atlas.nonexistent' });
    if (unknown.status !== 400 || !unknown.body.error.includes('atlas.tradingstation.membership')) {
      throw new Error('Expected the Unknown assetClass error to list atlas.tradingstation.membership, got: ' + JSON.stringify(unknown.body));
    }
    console.log('PASS: error now lists it ->', unknown.body.error);

    console.log('STEP 2: issuing atlas.tradingstation.membership to poster succeeds, is tradeScope: bound, logs to the roster, and queues a welcome mail');
    const posterMembership = await issueAsset(poster.publicKey, 'atlas.tradingstation.membership');
    if (posterMembership.asset.tradeScope !== 'bound') throw new Error('Expected tradeScope: bound, got: ' + JSON.stringify(posterMembership.asset));
    if (posterMembership.asset.fungible !== false || posterMembership.asset.presentation !== 'document') {
      throw new Error('Expected a non-fungible document-presentation credential, got: ' + JSON.stringify(posterMembership.asset));
    }
    const roster = JSON.parse(fs.readFileSync(path.resolve(BUNDLE_DIR, 'lib', 'atlas-tradingstation-members-store.json'), 'utf8'));
    if (!roster.members.some((m) => m.credentialId === posterMembership.id && m.ownerPublicKey === poster.publicKey)) {
      throw new Error('Expected poster to be logged to the Trading Station roster, got: ' + JSON.stringify(roster));
    }
    const mailCheck = await post('/atlas/mail/check', { credentialIds: [posterMembership.id] });
    if (!mailCheck.body.messages.some((m) => m.subject === 'Trading Station membership active')) {
      throw new Error('Expected a welcome mail message, got: ' + JSON.stringify(mailCheck.body.messages));
    }
    console.log('PASS: membership issued, bound, rostered, and welcomed ->', posterMembership.id);

    console.log('STEP 3: task #160 sanity check — a bound credential cannot be split (dedicated message, not the generic "not fungible" one)');
    const rejectedSplit = await post('/atlas/asset/split', { credential: posterMembership, sendAmount: 1, toPublicKey: poster.publicKey });
    if (rejectedSplit.status !== 400 || !rejectedSplit.body.error.includes('bound')) {
      throw new Error('Expected a bound credential to be rejected with a "bound" reason, got: ' + JSON.stringify(rejectedSplit.body));
    }
    console.log('PASS: bound credential rejected ->', rejectedSplit.body.error);

    console.log('STEP 4: minting 20 iron for poster, 10 gold for claimant, and joining claimant to the Trading Station too');
    const posterIron = await issueAsset(poster.publicKey, 'atlas.element.iron', 20);
    const claimantGold = await issueAsset(claimant.publicKey, 'atlas.element.gold', 10);
    const claimantMembership = await issueAsset(claimant.publicKey, 'atlas.tradingstation.membership');
    console.log('PASS: both balances minted and claimant joined the Trading Station');

    console.log('STEP 5: poster posts an open listing (10 iron for 5 gold) naming no counterparty at all — always queues, never auto-matches');
    const posterIntent = await proposeIntent(poster, { class: 'atlas.element.iron', quantity: 10 }, { class: 'atlas.element.gold', quantity: 5 }, undefined);
    if ('counterparty' in posterIntent.payload) throw new Error('Expected an open listing\'s payload to omit counterparty entirely, got: ' + JSON.stringify(posterIntent.payload));
    const posterSubmit = await post('/atlas/trade/submit', { membership: posterMembership, intent: posterIntent, balance: posterIron });
    if (posterSubmit.status !== 200 || posterSubmit.body.status !== 'pending' || !posterSubmit.body.pendingId) {
      throw new Error('Expected the listing to queue as pending, got: ' + JSON.stringify(posterSubmit.body));
    }
    const pendingId = posterSubmit.body.pendingId;
    console.log('PASS: listing posted, pending ->', pendingId);

    console.log('STEP 6: GET /atlas/trade/listings is ungated and shows the open listing to anyone browsing');
    const browse = await get('/atlas/trade/listings');
    const listed = browse.body.listings.find((l) => l.pendingId === pendingId);
    if (browse.status !== 200 || !listed || listed.posterPublicKey !== poster.publicKey || listed.offer.quantity !== 10 || listed.want.quantity !== 5) {
      throw new Error('Expected the open listing to be browsable with no membership presented, got: ' + JSON.stringify(browse.body));
    }
    console.log('PASS: listing is publicly browsable ->', JSON.stringify(listed));

    console.log('STEP 7: claimant claims it by pendingId — settles immediately since claimant is live right now');
    const claimantIntent = await proposeIntent(claimant, { class: 'atlas.element.gold', quantity: 5 }, { class: 'atlas.element.iron', quantity: 10 }, poster.publicKey);
    const claim = await post('/atlas/trade/claim', { pendingId, membership: claimantMembership, intent: claimantIntent, balance: claimantGold });
    if (claim.status !== 200 || claim.body.status !== 'settled') {
      throw new Error('Expected the claim to settle immediately, got: ' + JSON.stringify(claim.body));
    }
    if (!claim.body.remainder || claim.body.remainder.asset.class !== 'atlas.element.gold' || claim.body.remainder.quantity !== 5) {
      throw new Error('Expected claimant to keep a 5-gold remainder (offered 5 of its 10), got: ' + JSON.stringify(claim.body.remainder));
    }
    if (!claim.body.received || claim.body.received.asset.class !== 'atlas.element.iron' || claim.body.received.quantity !== 10) {
      throw new Error('Expected claimant to receive exactly 10 iron, got: ' + JSON.stringify(claim.body.received));
    }
    console.log('PASS: claimed and settled immediately — claimant received 10 iron and kept a 5-gold remainder');

    const browseAfterClaim = await get('/atlas/trade/listings');
    if (browseAfterClaim.body.listings.some((l) => l.pendingId === pendingId)) throw new Error('Expected the claimed listing to be gone from the browse list');
    console.log('PASS: the claimed listing no longer appears in GET /atlas/trade/listings');

    console.log('STEP 8: poster (not live for the claiming call) gets the rest via the ordinary mail-check path — iron remainder via asset-update, gold via a claimable mail gift');
    const posterMailCheck = await post('/atlas/mail/check', { credentialIds: [posterIron.id] });
    const ironUpdate = posterMailCheck.body.updates.find((u) => u.id === posterIron.id);
    if (!ironUpdate || ironUpdate.status !== 'superseded' || ironUpdate.newCredential.asset.class !== 'atlas.element.iron' || ironUpdate.newCredential.quantity !== 10) {
      throw new Error('Expected poster\'s old iron balance to show a superseded update to a 10-iron remainder, got: ' + JSON.stringify(posterMailCheck.body.updates));
    }
    const settlementMail = posterMailCheck.body.messages.find((m) => m.subject.startsWith('Listing claimed at'));
    if (!settlementMail || !settlementMail.attachedAsset || settlementMail.attachedAsset.asset.class !== 'atlas.element.gold' || settlementMail.attachedAsset.quantity !== 5) {
      throw new Error('Expected a "Listing claimed at" mail with a 5-gold attached gift, got: ' + JSON.stringify(posterMailCheck.body.messages));
    }
    console.log('PASS: poster\'s remainder (10 iron) and gift (5 gold) both arrived via /atlas/mail/check, exactly as the Node version delivers them ->', settlementMail.subject);

    console.log('STEP 9: regression check — an ordinary (non-bound, tradeScope: local) fungible split still works, now that check_presented_asset() and atlas_asset_catalog_entry() both changed to add the tradeScope field');
    if (settlementMail.attachedAsset.asset.tradeScope !== 'local') throw new Error('Expected the gold credential to carry tradeScope: local, got: ' + JSON.stringify(settlementMail.attachedAsset.asset));
    const ordinarySplit = await post('/atlas/asset/split', { credential: settlementMail.attachedAsset, sendAmount: 2, toPublicKey: claimant.publicKey });
    if (ordinarySplit.status !== 200 || !ordinarySplit.body.sent || ordinarySplit.body.sent.quantity !== 2 || !ordinarySplit.body.remainder || ordinarySplit.body.remainder.quantity !== 3) {
      throw new Error('Expected an ordinary 2/3 split of the 5-gold credential to still work, got: ' + JSON.stringify(ordinarySplit.body));
    }
    console.log('PASS: ordinary fungible split still works correctly (2 sent, 3 kept) — the bound check didn\'t break the normal path');

    console.log('STEP 10: POST /atlas/trade/cancel withdraws a still-open listing, and is rejected with 403 for anyone other than the poster');
    const secondIntent = await proposeIntent(poster, { class: 'atlas.element.iron', quantity: 3 }, { class: 'atlas.element.gold', quantity: 1 }, undefined);
    const secondSubmit = await post('/atlas/trade/submit', { membership: posterMembership, intent: secondIntent, balance: ironUpdate.newCredential });
    if (secondSubmit.status !== 200 || secondSubmit.body.status !== 'pending') throw new Error('Expected a second listing to queue as pending too, got: ' + JSON.stringify(secondSubmit.body));
    const secondPendingId = secondSubmit.body.pendingId;

    const wrongCancelPayload = { pendingId: secondPendingId, action: 'cancel' };
    const wrongCancelProof = await signPayload(claimant, wrongCancelPayload); // claimant, not poster
    const wrongCancel = await post('/atlas/trade/cancel', { pendingId: secondPendingId, intent: { payload: wrongCancelPayload, proof: wrongCancelProof } });
    if (wrongCancel.status !== 403) throw new Error('Expected a non-poster cancel attempt to be rejected with 403, got: ' + JSON.stringify(wrongCancel));
    console.log('PASS: a non-poster cancel attempt is rejected ->', wrongCancel.body.error);

    const rightCancelPayload = { pendingId: secondPendingId, action: 'cancel' };
    const rightCancelProof = await signPayload(poster, rightCancelPayload);
    const rightCancel = await post('/atlas/trade/cancel', { pendingId: secondPendingId, intent: { payload: rightCancelPayload, proof: rightCancelProof } });
    if (rightCancel.status !== 200 || rightCancel.body.status !== 'canceled') throw new Error('Expected the poster\'s own cancel to succeed, got: ' + JSON.stringify(rightCancel.body));
    const browseAfterCancel = await get('/atlas/trade/listings');
    if (browseAfterCancel.body.listings.some((l) => l.pendingId === secondPendingId)) throw new Error('Expected the canceled listing to be gone from the browse list');
    console.log('PASS: the poster\'s own cancel succeeds and the listing disappears from GET /atlas/trade/listings');

    console.log('\nALL PHP TRADE (OPEN LISTINGS) CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    serverProc.kill();
    cleanGeneratedFiles();
  }
})();
