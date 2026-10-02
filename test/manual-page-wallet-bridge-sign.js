// Manual check: SPEC.md §3.8.1's wallet-bridge signing —
// window.atlasWallet.requestSignature(payload), gated by a manifest-
// declared policy.walletBridge.sign whitelist of `purpose` strings, with
// every whitelisted request still needing the visitor's own explicit
// approval through confirm-bridge.html — an extension-origin iframe the
// requesting page cannot script into, read, or control the content of.
//
// Three things this test exists to prove, in order: (1) a purpose NOT on
// the whitelist is refused immediately, with no confirmation prompt ever
// shown — the page can't even tell the capability exists; (2) a
// whitelisted purpose DOES show the prompt, and the visitor's own Approve/
// Deny click is what decides the outcome, not the page; (3) the signature
// the visitor approves is a real one — it verifies against the exact
// payload the page sent, under the active identity's own public key.
//
// Isolated throwaway docroot + issuer-server instance, same pattern as
// manual-page-wallet-bridge.js (the read-only sibling of this test).

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const PORT = 8203; // isolated — distinct from every other manual-*.js test's own port
const DOMAIN = 'localhost:' + PORT;
const DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-bridge-sign-docroot-'));
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-bridge-sign-state-'));
const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-bridge-sign-profile-'));

const SPATIAL_JSON = {
  spec: 'domain-atlas/1.0',
  domain: DOMAIN,
  owner: { name: 'Bridge Sign Test Domain', contact: 'demo@localhost' },
  walletBridge: { read: true, sign: [] }, // domain default grants no signing at all — every purpose here comes from the world-level override
  defaultWorld: 'lobby',
  worlds: [
    {
      id: 'lobby',
      name: 'Bridge Sign Test Lobby',
      entry: { scene: '/spatial/lobby/scene.json', renderer: ['procedural-v1'] },
      policy: { guestAccess: 'open', discoverable: true, identityRequired: false, itemDropsAllowed: false, acceptedItemClasses: [], trustedIssuers: 'any' }
    },
    // SPEC.md §3.8.1 — entry-less, policy-only, whitelisting exactly two
    // purposes. "transfer-funds" is deliberately never listed, so a page
    // linked here asking for THAT purpose is the non-whitelisted case.
    { id: 'sign-page', name: 'Sign Page', policy: { walletBridge: { sign: ['login', 'age-attestation'] } } }
  ],
  updated: '2026-10-02T00:00:00Z'
};

const LOBBY_SCENE = { format: 'procedural-v1', floor: { size: [10, 10], color: '#1b2830' }, objects: [], portalMarkers: [], anchors: [] };

function pageHtml(title, linkTag) {
  return '<!doctype html><html><head><meta charset="utf-8"><title>' + title + '</title>' +
    (linkTag ? linkTag + '\n' : '') +
    '</head><body><h1>' + title + '</h1></body></html>';
}

(async () => {
  console.log('SETUP: hand-authoring an isolated docroot — domain default grants no signing, the "sign-page" world whitelists exactly "login" and "age-attestation"');
  fs.mkdirSync(path.join(DOCROOT_DIR, '.well-known'), { recursive: true });
  fs.mkdirSync(path.join(DOCROOT_DIR, 'spatial', 'lobby'), { recursive: true });
  fs.writeFileSync(path.join(DOCROOT_DIR, '.well-known', 'spatial.json'), JSON.stringify(SPATIAL_JSON, null, 2));
  fs.writeFileSync(path.join(DOCROOT_DIR, 'spatial', 'lobby', 'scene.json'), JSON.stringify(LOBBY_SCENE, null, 2));
  fs.writeFileSync(path.join(DOCROOT_DIR, 'page-sign.html'),
    pageHtml('Sign Page', '<link rel="spatial" href="/.well-known/spatial.json#sign-page">'));
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

    console.log('STEP 1: a purpose NOT on the whitelist ("transfer-funds") is refused immediately — allowed:false, result:null, and no confirmation overlay ever appears');
    const nonWhitelistedPage = await context.newPage();
    await nonWhitelistedPage.goto('http://' + DOMAIN + '/page-sign.html', { waitUntil: 'load' });
    const deniedResult = await nonWhitelistedPage.evaluate(() =>
      window.atlasWallet.requestSignature({ purpose: 'transfer-funds', amount: 1000 })
    );
    if (deniedResult.allowed !== false || deniedResult.result !== null) throw new Error('Expected {allowed:false, result:null} for a non-whitelisted purpose, got: ' + JSON.stringify(deniedResult));
    const overlayCountAfterDenied = await nonWhitelistedPage.locator('#domain-atlas-bridge-confirm').count();
    if (overlayCountAfterDenied !== 0) throw new Error('Expected no confirmation overlay to ever appear for a non-whitelisted purpose, found ' + overlayCountAfterDenied);
    await nonWhitelistedPage.close();
    console.log('PASS: non-whitelisted purpose refused with no prompt shown at all');

    console.log('STEP 2: a whitelisted purpose ("login") DOES show the prompt — with no identity active yet, it shows the locked state; Dismiss resolves allowed:true, result:null');
    const lockedPage = await context.newPage();
    await lockedPage.goto('http://' + DOMAIN + '/page-sign.html', { waitUntil: 'load' });
    const lockedResultPromise = lockedPage.evaluate(() =>
      window.atlasWallet.requestSignature({ purpose: 'login', nonce: 'nonce-before-identity' })
    );
    lockedResultPromise.catch(() => {}); // avoid noisy unhandled-rejection output if an earlier assertion throws first
    await lockedPage.waitForSelector('#domain-atlas-bridge-confirm', { timeout: 10000 });
    const lockedFrame = lockedPage.frameLocator('#domain-atlas-bridge-confirm');
    await lockedFrame.locator('#lockedState').waitFor({ state: 'visible', timeout: 10000 });
    const lockedDetailText = await lockedFrame.locator('#lockedDetailLine').innerText();
    if (!lockedDetailText.includes('login')) throw new Error('Expected the locked-state prompt to name the real purpose, got: ' + lockedDetailText);
    await lockedFrame.locator('#dismissBtn').click();
    const lockedResult = await lockedResultPromise;
    if (lockedResult.allowed !== true || lockedResult.result !== null) throw new Error('Expected {allowed:true, result:null} dismissing the locked state, got: ' + JSON.stringify(lockedResult));
    await lockedPage.waitForSelector('#domain-atlas-bridge-confirm', { state: 'detached', timeout: 10000 });
    await lockedPage.close();
    console.log('PASS: whitelisted purpose shows the real prompt; with no identity active, it correctly shows "locked" rather than a fake Approve option, and Dismiss resolves to no signature');

    console.log('STEP 3: creating a real wallet identity (side panel, standalone mode)');
    const walletPage = await context.newPage();
    await walletPage.goto('chrome-extension://' + extensionId + '/viewer.html', { waitUntil: 'load' });
    await walletPage.waitForFunction(() => document.getElementById('walletPanel').classList.contains('open'), { timeout: 10000 });
    await walletPage.locator('#chooseNewBtn').click();
    await walletPage.locator('#newPasswordInput').fill('bridge-sign-test-pw');
    await walletPage.locator('#newPasswordConfirmInput').fill('bridge-sign-test-pw');
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

    console.log('STEP 4: the same whitelisted purpose now shows the real Approve/Deny prompt; Approve produces a genuine signature over the exact payload, under the real identity\'s own public key');
    const approvePage = await context.newPage();
    await approvePage.goto('http://' + DOMAIN + '/page-sign.html', { waitUntil: 'load' });
    const signPayload = { purpose: 'login', nonce: 'nonce-for-real-signature', site: DOMAIN };
    const approveResultPromise = approvePage.evaluate((payload) => window.atlasWallet.requestSignature(payload), signPayload);
    approveResultPromise.catch(() => {});
    await approvePage.waitForSelector('#domain-atlas-bridge-confirm', { timeout: 10000 });
    const approveFrame = approvePage.frameLocator('#domain-atlas-bridge-confirm');
    await approveFrame.locator('#readyState').waitFor({ state: 'visible', timeout: 10000 });
    const originShown = await approveFrame.locator('#origin').innerText();
    if (originShown !== 'http://' + DOMAIN) throw new Error('Expected the prompt to show the real requesting origin, got: ' + originShown);
    const payloadBoxText = await approveFrame.locator('#payloadBox').innerText();
    if (!payloadBoxText.includes('nonce-for-real-signature')) throw new Error('Expected the prompt to actually display the payload being signed, got: ' + payloadBoxText);
    await approveFrame.locator('#approveBtn').click();
    const approveResult = await approveResultPromise;
    if (approveResult.allowed !== true || !approveResult.result) throw new Error('Expected a real signature envelope on approval, got: ' + JSON.stringify(approveResult));
    if (approveResult.result.publicKey !== realPublicKey) throw new Error('Expected the envelope\'s publicKey to match the active identity, got: ' + approveResult.result.publicKey);
    const verified = await walletPage.evaluate(
      ({ payload, envelope }) => AtlasWallet.verifySignedPayload(payload, envelope),
      { payload: signPayload, envelope: approveResult.result }
    );
    if (!verified) throw new Error('Expected the approved signature to actually verify against the exact payload the page sent');
    await approvePage.close();
    console.log('PASS: approval produced a real, verifiable signature over the exact payload, correctly attributed to the active identity, with the real requesting origin and payload shown in the prompt');

    console.log('STEP 5: the SAME whitelisted purpose, this time Denied, resolves allowed:true, result:null — a visitor\'s own "no" is final, not a fallback the page can route around');
    const denyPage = await context.newPage();
    await denyPage.goto('http://' + DOMAIN + '/page-sign.html', { waitUntil: 'load' });
    const denyResultPromise = denyPage.evaluate(() => window.atlasWallet.requestSignature({ purpose: 'age-attestation', minAge: 18 }));
    denyResultPromise.catch(() => {});
    await denyPage.waitForSelector('#domain-atlas-bridge-confirm', { timeout: 10000 });
    const denyFrame = denyPage.frameLocator('#domain-atlas-bridge-confirm');
    await denyFrame.locator('#readyState').waitFor({ state: 'visible', timeout: 10000 });
    await denyFrame.locator('#denyBtn').click();
    const denyResult = await denyResultPromise;
    if (denyResult.allowed !== true || denyResult.result !== null) throw new Error('Expected {allowed:true, result:null} on denial, got: ' + JSON.stringify(denyResult));
    await denyPage.close();
    console.log('PASS: a second whitelisted purpose ("age-attestation") also prompts correctly, and an explicit Deny yields no signature');

    console.log('\nALL CHECKS PASSED — SPEC.md §3.8.1\'s wallet-bridge signing refuses a non-whitelisted purpose with no prompt at all, shows a real non-spoofable confirmation (correct origin, correct payload) for a whitelisted one, correctly reflects whether an identity is actually unlocked, and only ever produces a genuine, verifiable signature when the visitor explicitly approves it.');
  } finally {
    await context.close().catch(() => {});
    serverProc.kill();
    try { fs.rmSync(DOCROOT_DIR, { recursive: true, force: true }); } catch (err) {}
    try { fs.rmSync(STATE_DIR, { recursive: true, force: true }); } catch (err) {}
    try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch (err) {}
  }
})();
