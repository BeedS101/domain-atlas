// Manual check: SPEC.md §3.8.2's wallet-bridge asset offers, plus §3.8.3's
// trusted offer domains — window.atlasWallet.offerAsset(credential),
// gated by a manifest-declared policy.walletBridge.offer whitelist of
// asset classes, with every whitelisted offer needing the visitor's own
// explicit approval through confirm-bridge.html's "offer" display mode —
// and, critically, approval itself never adding the credential straight
// to the wallet, only into a pending, sandboxed tray a visitor separately
// Claims or Dismisses — UNLESS the visitor has separately chosen to trust
// that origin, in which case a later whitelisted offer from it skips both
// the prompt and the tray entirely.
//
// Eight things this test exists to prove, in order: (1) a class NOT on
// the whitelist is refused immediately, with no confirmation prompt ever
// shown — same posture §3.8.1's signing test already proved for an
// unlisted purpose; (2) a whitelisted class DOES show the prompt,
// correctly as the locked state before any identity exists; (3) approving
// a whitelisted offer queues it into AtlasWallet.getBridgeOffers()
// WITHOUT adding it to AtlasWallet.getWallet() — the sandbox rule itself;
// (4) a separate, explicit Claim is what actually adds it to the wallet;
// (5) Deny at the prompt and a later Dismiss both discard an offer
// without it ever reaching the wallet, and are told apart from each other
// and from a claimed offer; (6) checking the prompt's trust checkbox
// trusts the origin AND claims that specific offer immediately, with no
// separate Claim step needed; (7) a LATER offer from that now-trusted
// origin, for a class it's already whitelisted for, skips the
// confirmation overlay entirely and still lands in the wallet for real;
// (8) revoking trust makes the very next offer from that origin show the
// prompt again, same as it never having been trusted at all.
//
// Isolated throwaway docroot + issuer-server instance, same pattern as
// manual-page-wallet-bridge-sign.js (the signing sibling of this test) —
// including minting the actual credential a real domain would mint,
// through the SAME ordinary /atlas/asset/issue endpoint every other
// request-an-item flow in this project already uses, called directly from
// the test page via plain same-origin fetch(), exactly as SPEC.md §3.8.2
// describes a page's own domain producing what it then offers.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const PORT = 8204; // isolated — distinct from every other manual-*.js test's own port
const DOMAIN = 'localhost:' + PORT;
const DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-bridge-offer-docroot-'));
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-bridge-offer-state-'));
const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-bridge-offer-profile-'));

const WHITELISTED_CLASS = 'atlas.wearable.ring'; // fungible:false in ASSET_CATALOG — a plain quantity-1 collectible
const NON_WHITELISTED_CLASS = 'atlas.element.iron'; // a real catalog class, just never added to this world's offer list

const SPATIAL_JSON = {
  spec: 'domain-atlas/1.0',
  domain: DOMAIN,
  owner: { name: 'Bridge Offer Test Domain', contact: 'demo@localhost' },
  walletBridge: { read: true, offer: [] }, // domain default grants no offer capability at all — every class here comes from the world-level override
  defaultWorld: 'lobby',
  worlds: [
    {
      id: 'lobby',
      name: 'Bridge Offer Test Lobby',
      entry: { scene: '/spatial/lobby/scene.json', renderer: ['procedural-v1'] },
      policy: { guestAccess: 'open', discoverable: true, identityRequired: false, itemDropsAllowed: false, acceptedItemClasses: [], trustedIssuers: 'any' }
    },
    // SPEC.md §3.8.2 — entry-less, policy-only, whitelisting exactly one
    // asset class. NON_WHITELISTED_CLASS is deliberately never listed, so
    // an offer naming it is the non-whitelisted case.
    { id: 'offer-page', name: 'Offer Page', policy: { walletBridge: { offer: [WHITELISTED_CLASS] } } }
  ],
  updated: '2026-10-02T00:00:00Z'
};

const LOBBY_SCENE = { format: 'procedural-v1', floor: { size: [10, 10], color: '#1b2830' }, objects: [], portalMarkers: [], anchors: [] };

function pageHtml(title, linkTag) {
  return '<!doctype html><html><head><meta charset="utf-8"><title>' + title + '</title>' +
    (linkTag ? linkTag + '\n' : '') +
    '</head><body><h1>' + title + '</h1></body></html>';
}

// Mints a real credential through the same ordinary, ungated issuance
// endpoint every other "request an item" flow in this project already
// uses — run from the TEST PAGE's own context (same-origin fetch), never
// from the extension, matching SPEC.md §3.8.2's "minted by the page's own
// domain through whatever ordinary same-origin issuance mechanism that
// domain already runs."
async function mintCredential(page, assetClass, ownerPublicKey, quantity) {
  return page.evaluate(async ({ assetClass, ownerPublicKey, quantity }) => {
    const res = await fetch('/atlas/asset/issue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ownerPublicKey, assetClass, quantity })
    });
    if (!res.ok) throw new Error('mint failed: ' + res.status + ' ' + (await res.text()));
    return res.json();
  }, { assetClass, ownerPublicKey, quantity });
}

(async () => {
  console.log('SETUP: hand-authoring an isolated docroot — domain default grants no offer capability, the "offer-page" world whitelists exactly "' + WHITELISTED_CLASS + '"');
  fs.mkdirSync(path.join(DOCROOT_DIR, '.well-known'), { recursive: true });
  fs.mkdirSync(path.join(DOCROOT_DIR, 'spatial', 'lobby'), { recursive: true });
  fs.writeFileSync(path.join(DOCROOT_DIR, '.well-known', 'spatial.json'), JSON.stringify(SPATIAL_JSON, null, 2));
  fs.writeFileSync(path.join(DOCROOT_DIR, 'spatial', 'lobby', 'scene.json'), JSON.stringify(LOBBY_SCENE, null, 2));
  fs.writeFileSync(path.join(DOCROOT_DIR, 'page-offer.html'),
    pageHtml('Offer Page', '<link rel="spatial" href="/.well-known/spatial.json#offer-page">'));
  console.log('PASS: docroot ready');

  console.log('SETUP: starting a throwaway issuer-server instance on port ' + PORT + ' (isolated docroot, isolated state dir)');
  const serverProc = spawn('node', ['issuer-server/server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), ATLAS_DOMAIN: DOMAIN, ATLAS_STATE_DIR: STATE_DIR, ATLAS_DOCROOT: DOCROOT_DIR },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('issuer-server did not start in time')), 10000);
    serverProc.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); resolve(); } });
    serverProc.on('exit', (code) => reject(new Error('issuer-server exited early with code ' + code)));
  });
  console.log('PASS: isolated issuer-server up on port ' + PORT);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  });

  try {
    let background = context.serviceWorkers()[0];
    if (!background) background = await context.waitForEvent('serviceworker');
    const extensionId = new URL(background.url()).host;

    console.log('STEP 1: a class NOT on the whitelist ("' + NON_WHITELISTED_CLASS + '") is refused immediately — allowed:false, result:null, and no confirmation overlay ever appears');
    const refusedPage = await context.newPage();
    await refusedPage.goto('http://' + DOMAIN + '/page-offer.html', { waitUntil: 'load' });
    const refusedCredential = await mintCredential(refusedPage, NON_WHITELISTED_CLASS, 'placeholder-public-key-never-verified', 1);
    const refusedResult = await refusedPage.evaluate((credential) => window.atlasWallet.offerAsset(credential), refusedCredential);
    if (refusedResult.allowed !== false || refusedResult.result !== null) throw new Error('Expected {allowed:false, result:null} for a non-whitelisted class, got: ' + JSON.stringify(refusedResult));
    const overlayCountAfterRefused = await refusedPage.locator('#domain-atlas-bridge-confirm').count();
    if (overlayCountAfterRefused !== 0) throw new Error('Expected no confirmation overlay to ever appear for a non-whitelisted class, found ' + overlayCountAfterRefused);
    await refusedPage.close();
    console.log('PASS: non-whitelisted class refused with no prompt shown at all');

    console.log('STEP 2: a whitelisted class ("' + WHITELISTED_CLASS + '") DOES show the prompt — with no identity active yet, it shows the locked state; Dismiss resolves allowed:true, result:null');
    const lockedPage = await context.newPage();
    await lockedPage.goto('http://' + DOMAIN + '/page-offer.html', { waitUntil: 'load' });
    const lockedCredential = await mintCredential(lockedPage, WHITELISTED_CLASS, 'placeholder-public-key-never-verified');
    const lockedResultPromise = lockedPage.evaluate((credential) => window.atlasWallet.offerAsset(credential), lockedCredential);
    lockedResultPromise.catch(() => {}); // avoid noisy unhandled-rejection output if an earlier assertion throws first
    await lockedPage.waitForSelector('#domain-atlas-bridge-confirm', { timeout: 10000 });
    const lockedFrame = lockedPage.frameLocator('#domain-atlas-bridge-confirm');
    await lockedFrame.locator('#lockedState').waitFor({ state: 'visible', timeout: 10000 });
    const lockedDetailText = await lockedFrame.locator('#lockedDetailLine').innerText();
    if (!lockedDetailText.includes(WHITELISTED_CLASS)) throw new Error('Expected the locked-state prompt to name the real asset class, got: ' + lockedDetailText);
    await lockedFrame.locator('#dismissBtn').click();
    const lockedResult = await lockedResultPromise;
    if (lockedResult.allowed !== true || lockedResult.result !== null) throw new Error('Expected {allowed:true, result:null} dismissing the locked state, got: ' + JSON.stringify(lockedResult));
    await lockedPage.waitForSelector('#domain-atlas-bridge-confirm', { state: 'detached', timeout: 10000 });
    await lockedPage.close();
    console.log('PASS: whitelisted class shows the real prompt; with no identity active, it correctly shows "locked" rather than a fake Accept option, and Dismiss resolves to nothing queued');

    console.log('STEP 3: creating a real wallet identity (side panel, standalone mode)');
    const walletPage = await context.newPage();
    await walletPage.goto('chrome-extension://' + extensionId + '/viewer.html', { waitUntil: 'load' });
    await walletPage.waitForFunction(() => document.getElementById('walletPanel').classList.contains('open'), { timeout: 10000 });
    await walletPage.locator('#chooseNewBtn').click();
    await walletPage.locator('#newPasswordInput').fill('bridge-offer-test-pw');
    await walletPage.locator('#newPasswordConfirmInput').fill('bridge-offer-test-pw');
    await walletPage.locator('#confirmCreateBtn').click();
    await walletPage.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
    await walletPage.locator('#seedConfirmCheck').check();
    await walletPage.locator('#seedConfirmBtn').click();
    await walletPage.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    const realPublicKey = await walletPage.evaluate(async () => {
      const identity = await AtlasWallet.getIdentity();
      return identity ? identity.publicKey : null;
    });
    if (!realPublicKey) throw new Error('Expected a real public key right after creating the identity');
    console.log('PASS: a real identity now exists');

    console.log('STEP 4: the same whitelisted class now shows the real Deny/Accept prompt, naming the real asset; Accept queues it into pending WITHOUT adding it to the wallet');
    const acceptPage = await context.newPage();
    await acceptPage.goto('http://' + DOMAIN + '/page-offer.html', { waitUntil: 'load' });
    const acceptCredential = await mintCredential(acceptPage, WHITELISTED_CLASS, realPublicKey);
    const acceptResultPromise = acceptPage.evaluate((credential) => window.atlasWallet.offerAsset(credential), acceptCredential);
    acceptResultPromise.catch(() => {});
    await acceptPage.waitForSelector('#domain-atlas-bridge-confirm', { timeout: 10000 });
    const acceptFrame = acceptPage.frameLocator('#domain-atlas-bridge-confirm');
    await acceptFrame.locator('#offerState').waitFor({ state: 'visible', timeout: 10000 });
    const offerOriginShown = await acceptFrame.locator('#offerOrigin').innerText();
    if (offerOriginShown !== 'http://' + DOMAIN) throw new Error('Expected the prompt to show the real requesting origin, got: ' + offerOriginShown);
    const offerNameShown = await acceptFrame.locator('#offerAssetName').innerText();
    if (offerNameShown !== acceptCredential.asset.name) throw new Error('Expected the prompt to name the real asset, got: ' + offerNameShown);
    const offerClassShown = await acceptFrame.locator('#offerAssetClass').innerText();
    if (offerClassShown !== WHITELISTED_CLASS) throw new Error('Expected the prompt to show the real asset class, got: ' + offerClassShown);
    await acceptFrame.locator('#offerApproveBtn').click();
    const acceptResult = await acceptResultPromise;
    if (acceptResult.allowed !== true || !acceptResult.result || !acceptResult.result.queued || !acceptResult.result.offerId) {
      throw new Error('Expected {allowed:true, result:{queued:true, offerId}} on approval, got: ' + JSON.stringify(acceptResult));
    }
    const offerId = acceptResult.result.offerId;

    // SPEC.md §3.8.2's central rule, checked directly rather than just
    // trusted from the result shape above: approval must NOT have added
    // the credential to the live wallet.
    const walletAfterAccept = await walletPage.evaluate((owner) => AtlasWallet.getWallet(owner), realPublicKey);
    if (walletAfterAccept.some((e) => e.credential.id === acceptCredential.id)) {
      throw new Error('Approving an offer must not add the credential to the wallet directly — found it in getWallet() before any Claim');
    }
    const pendingAfterAccept = await walletPage.evaluate((owner) => AtlasWallet.getBridgeOffers(owner), realPublicKey);
    const queuedEntry = pendingAfterAccept.find((e) => e.id === offerId);
    if (!queuedEntry || queuedEntry.claimed) throw new Error('Expected the approved offer to sit in getBridgeOffers() as unclaimed, got: ' + JSON.stringify(pendingAfterAccept));
    if (queuedEntry.credential.id !== acceptCredential.id) throw new Error('Expected the queued entry to carry the exact credential offered');
    await acceptPage.close();
    console.log('PASS: approval correctly queued the offer into pending bridge offers, naming the real asset and real origin, and left the live wallet untouched');

    console.log('STEP 5: a separate, explicit Claim is the only path that actually adds the credential to the wallet — and verifies it for real');
    const claimOutcome = await walletPage.evaluate(
      ({ owner, offerId }) => AtlasWallet.claimBridgeOffer(owner, offerId),
      { owner: realPublicKey, offerId }
    );
    if (!claimOutcome.verdict.valid) throw new Error('Expected the claimed offer to verify as valid, got: ' + JSON.stringify(claimOutcome.verdict));
    const walletAfterClaim = await walletPage.evaluate((owner) => AtlasWallet.getWallet(owner), realPublicKey);
    if (!walletAfterClaim.some((e) => e.credential.id === acceptCredential.id)) {
      throw new Error('Expected the claimed credential to now be in the wallet');
    }
    const pendingAfterClaim = await walletPage.evaluate((owner) => AtlasWallet.getBridgeOffers(owner), realPublicKey);
    const claimedEntry = pendingAfterClaim.find((e) => e.id === offerId);
    if (!claimedEntry || !claimedEntry.claimed) throw new Error('Expected the pending entry to now read claimed:true');
    console.log('PASS: Claim ran real verification and is the sole path that moved the credential into the wallet');

    console.log('STEP 6: Deny at the prompt resolves allowed:true, result:null, and queues nothing at all');
    const denyPage = await context.newPage();
    await denyPage.goto('http://' + DOMAIN + '/page-offer.html', { waitUntil: 'load' });
    const denyCredential = await mintCredential(denyPage, WHITELISTED_CLASS, realPublicKey);
    const denyResultPromise = denyPage.evaluate((credential) => window.atlasWallet.offerAsset(credential), denyCredential);
    denyResultPromise.catch(() => {});
    await denyPage.waitForSelector('#domain-atlas-bridge-confirm', { timeout: 10000 });
    const denyFrame = denyPage.frameLocator('#domain-atlas-bridge-confirm');
    await denyFrame.locator('#offerState').waitFor({ state: 'visible', timeout: 10000 });
    await denyFrame.locator('#offerDenyBtn').click();
    const denyResult = await denyResultPromise;
    if (denyResult.allowed !== true || denyResult.result !== null) throw new Error('Expected {allowed:true, result:null} on denial, got: ' + JSON.stringify(denyResult));
    const pendingAfterDeny = await walletPage.evaluate((owner) => AtlasWallet.getBridgeOffers(owner), realPublicKey);
    if (pendingAfterDeny.some((e) => e.credential.id === denyCredential.id)) throw new Error('A denied offer must never be queued at all');
    await denyPage.close();
    console.log('PASS: denying at the prompt queues nothing');

    console.log('STEP 7: a Dismiss on an already-queued, unclaimed offer removes it from pending without it ever reaching the wallet');
    const dismissPage = await context.newPage();
    await dismissPage.goto('http://' + DOMAIN + '/page-offer.html', { waitUntil: 'load' });
    const dismissCredential = await mintCredential(dismissPage, WHITELISTED_CLASS, realPublicKey);
    const dismissResultPromise = dismissPage.evaluate((credential) => window.atlasWallet.offerAsset(credential), dismissCredential);
    dismissResultPromise.catch(() => {});
    await dismissPage.waitForSelector('#domain-atlas-bridge-confirm', { timeout: 10000 });
    const dismissFrame = dismissPage.frameLocator('#domain-atlas-bridge-confirm');
    await dismissFrame.locator('#offerState').waitFor({ state: 'visible', timeout: 10000 });
    await dismissFrame.locator('#offerApproveBtn').click();
    const dismissAcceptResult = await dismissResultPromise;
    const dismissOfferId = dismissAcceptResult.result.offerId;
    await dismissPage.close();
    await walletPage.evaluate(
      ({ owner, offerId }) => AtlasWallet.dismissBridgeOffer(owner, offerId),
      { owner: realPublicKey, offerId: dismissOfferId }
    );
    const pendingAfterDismiss = await walletPage.evaluate((owner) => AtlasWallet.getBridgeOffers(owner), realPublicKey);
    if (pendingAfterDismiss.some((e) => e.id === dismissOfferId)) throw new Error('Expected the dismissed offer to be removed from getBridgeOffers() entirely');
    const walletAfterDismiss = await walletPage.evaluate((owner) => AtlasWallet.getWallet(owner), realPublicKey);
    if (walletAfterDismiss.some((e) => e.credential.id === dismissCredential.id)) throw new Error('A dismissed offer must never reach the wallet');
    console.log('PASS: Dismiss removes a pending offer outright, and it never touched the wallet');

    console.log('STEP 8: checking the prompt\'s trust checkbox and Accepting trusts the origin AND claims that specific offer immediately — no separate Claim step needed');
    const trustPage = await context.newPage();
    await trustPage.goto('http://' + DOMAIN + '/page-offer.html', { waitUntil: 'load' });
    const trustCredential = await mintCredential(trustPage, WHITELISTED_CLASS, realPublicKey);
    const trustResultPromise = trustPage.evaluate((credential) => window.atlasWallet.offerAsset(credential), trustCredential);
    trustResultPromise.catch(() => {});
    await trustPage.waitForSelector('#domain-atlas-bridge-confirm', { timeout: 10000 });
    const trustFrame = trustPage.frameLocator('#domain-atlas-bridge-confirm');
    await trustFrame.locator('#offerState').waitFor({ state: 'visible', timeout: 10000 });
    await trustFrame.locator('#offerTrustCheckbox').check();
    await trustFrame.locator('#offerApproveBtn').click();
    const trustResult = await trustResultPromise;
    if (trustResult.allowed !== true || !trustResult.result || !trustResult.result.claimed || !trustResult.result.offerId) {
      throw new Error('Expected {allowed:true, result:{claimed:true, offerId}} when trust-and-accept is used, got: ' + JSON.stringify(trustResult));
    }
    const walletAfterTrust = await walletPage.evaluate((owner) => AtlasWallet.getWallet(owner), realPublicKey);
    if (!walletAfterTrust.some((e) => e.credential.id === trustCredential.id)) throw new Error('Expected the trust-and-accept credential to be in the wallet immediately, with no separate Claim');
    await trustPage.close();
    console.log('PASS: trust-and-accept claimed the offered credential immediately, in the same click');

    console.log('STEP 9: a LATER offer from that now-trusted origin, for a class it\'s already whitelisted for, skips the confirmation overlay entirely and still lands in the real wallet');
    const autoClaimPage = await context.newPage();
    await autoClaimPage.goto('http://' + DOMAIN + '/page-offer.html', { waitUntil: 'load' });
    const autoClaimCredential = await mintCredential(autoClaimPage, WHITELISTED_CLASS, realPublicKey);
    const autoClaimResult = await autoClaimPage.evaluate((credential) => window.atlasWallet.offerAsset(credential), autoClaimCredential);
    const overlayCountAfterAutoClaim = await autoClaimPage.locator('#domain-atlas-bridge-confirm').count();
    if (overlayCountAfterAutoClaim !== 0) throw new Error('Expected no confirmation overlay at all for a trusted origin, found ' + overlayCountAfterAutoClaim);
    if (autoClaimResult.allowed !== true || !autoClaimResult.result || !autoClaimResult.result.claimed) {
      throw new Error('Expected {allowed:true, result:{claimed:true, ...}} with no prompt for a trusted origin, got: ' + JSON.stringify(autoClaimResult));
    }
    const walletAfterAutoClaim = await walletPage.evaluate((owner) => AtlasWallet.getWallet(owner), realPublicKey);
    if (!walletAfterAutoClaim.some((e) => e.credential.id === autoClaimCredential.id)) throw new Error('Expected the auto-claimed credential to actually be in the wallet, not just reported as claimed');
    await autoClaimPage.close();
    console.log('PASS: a trusted origin\'s later whitelisted offer auto-claimed with no prompt shown at all, and the credential genuinely verified and landed in the wallet');

    console.log('STEP 10: revoking trust makes the very next offer from that origin show the prompt again');
    const trustedOrigin = 'http://' + DOMAIN;
    const trustedBeforeRevoke = await walletPage.evaluate((owner) => AtlasWallet.getTrustedBridgeDomains(owner), realPublicKey);
    if (!trustedBeforeRevoke.some((t) => t.origin === trustedOrigin)) throw new Error('Expected the origin to actually be on the trusted list before testing revocation');
    await walletPage.evaluate(({ owner, origin }) => AtlasWallet.untrustBridgeDomain(owner, origin), { owner: realPublicKey, origin: trustedOrigin });
    const trustedAfterRevoke = await walletPage.evaluate((owner) => AtlasWallet.getTrustedBridgeDomains(owner), realPublicKey);
    if (trustedAfterRevoke.some((t) => t.origin === trustedOrigin)) throw new Error('Expected untrustBridgeDomain to actually remove the origin from the trusted list');
    const revokePage = await context.newPage();
    await revokePage.goto('http://' + DOMAIN + '/page-offer.html', { waitUntil: 'load' });
    const revokeCredential = await mintCredential(revokePage, WHITELISTED_CLASS, realPublicKey);
    const revokeResultPromise = revokePage.evaluate((credential) => window.atlasWallet.offerAsset(credential), revokeCredential);
    revokeResultPromise.catch(() => {});
    await revokePage.waitForSelector('#domain-atlas-bridge-confirm', { timeout: 10000 });
    const revokeFrame = revokePage.frameLocator('#domain-atlas-bridge-confirm');
    await revokeFrame.locator('#offerState').waitFor({ state: 'visible', timeout: 10000 });
    await revokeFrame.locator('#offerDenyBtn').click();
    const revokeResult = await revokeResultPromise;
    if (revokeResult.allowed !== true || revokeResult.result !== null) throw new Error('Expected the ordinary deny shape once trust is revoked, got: ' + JSON.stringify(revokeResult));
    await revokePage.close();
    console.log('PASS: revoking trust made the next offer from that origin show the real prompt again, same as an untrusted origin always has');

    console.log('\nALL CHECKS PASSED — SPEC.md §3.8.2\'s wallet-bridge asset offers refuse a non-whitelisted class with no prompt at all, show a real non-spoofable confirmation naming the real asset and origin for a whitelisted one, correctly reflect whether an identity is actually unlocked, and never add an approved offer straight to the wallet by default — only a later, separate, explicit Claim does that, with Deny and Dismiss both discarding an offer without it ever arriving. SPEC.md §3.8.3\'s trusted offer domains correctly let a visitor-granted origin skip the prompt and the sandbox entirely for an already-whitelisted class, with revocation taking effect immediately on the next offer.');
  } finally {
    await context.close().catch(() => {});
    serverProc.kill();
    try { fs.rmSync(DOCROOT_DIR, { recursive: true, force: true }); } catch (err) {}
    try { fs.rmSync(STATE_DIR, { recursive: true, force: true }); } catch (err) {}
    try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch (err) {}
  }
})();
