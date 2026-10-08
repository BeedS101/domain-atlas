// Manual check: the actual demo-domain-b live pages — index.html's new
// "Walking into these spaces needs the wallet extension" callout, its
// centered logo, and the link to the new wallet-bridge-demo.html page;
// and wallet-bridge-demo.html itself, which exercises SPEC.md §3.8/§3.8.1/
// §3.8.2 for real against demo-domain-b's own manifest (policy.
// walletBridge: { read: true, sign: ["demo-login"], offer:
// ["atlas.wearable.ring"] }), declared as a domain-wide default since
// neither page carries a <link rel="spatial"> tag.
//
// Unlike every other manual-page-wallet-bridge-*.js test, this one does
// NOT hand-author its own throwaway manifest — it copies the REAL
// demo-domain-b directory (fs.cpSync) into an isolated tmp docroot, so a
// green run here actually proves the committed files work, not a
// stand-in. The copy's spatial.json "domain" field is rewritten to match
// this test's own isolated port — every other test in this family does
// the same for its own port, and the live deployment's actual domain
// field is never touched since this never runs against the real
// demo-domain-b folder on disk.
//
// Four things this test exists to prove, in order: (1) index.html's logo
// is centered and both new callouts are present, with the second one
// linking to wallet-bridge-demo.html; (2) wallet-bridge-demo.html's
// "Check my wallet" button correctly reports no active identity before
// one exists, and a real one once it does; (3) "Ask for a signature"
// shows the real non-spoofable prompt and reports a real signed envelope
// once approved; (4) "Offer me a collectible" mints a real credential,
// shows the real offer prompt, and queues it into the visitor's pending
// bridge offers without adding it to the wallet — checked directly via
// AtlasWallet.getBridgeOffers(), not just the page's own status text.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const PORT = 8205; // isolated — distinct from every other manual-*.js test's own port
const DOMAIN = 'localhost:' + PORT;
const REAL_DOCROOT = path.resolve(__dirname, '..', 'demo-domain-b');
const DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-demo-b-docroot-'));
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-demo-b-state-'));
const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-demo-b-profile-'));

(async () => {
  console.log('SETUP: copying the REAL demo-domain-b directory into an isolated tmp docroot, rewriting spatial.json\'s "domain" field to match this test\'s own port (' + DOMAIN + ')');
  fs.cpSync(REAL_DOCROOT, DOCROOT_DIR, { recursive: true });
  const spatialPath = path.join(DOCROOT_DIR, '.well-known', 'spatial.json');
  const spatial = JSON.parse(fs.readFileSync(spatialPath, 'utf8'));
  if (spatial.domain !== 'localhost:8002') throw new Error('Expected the real manifest\'s domain field to still read "localhost:8002" — did it change upstream?');
  spatial.domain = DOMAIN;
  // Turned off in THIS COPY ONLY — the real demo-domain-b/.well-known/
  // spatial.json on disk is untouched. Every other manual-page-wallet-
  // bridge-*.js test's own hand-authored manifest already leaves chat/
  // postOffice/calendar out entirely, specifically so a bridge test
  // measures only the bridge; this test is the one exception that starts
  // from the REAL manifest (to prove the real file works), and the real
  // one happens to turn all three on. Matching that convention here too,
  // so a chat/mail/calendar regression elsewhere never shows up as a
  // failure in a test that isn't about those features at all.
  spatial.chat = false;
  spatial.postOffice = false;
  spatial.calendar = false;
  fs.writeFileSync(spatialPath, JSON.stringify(spatial, null, 2));
  console.log('PASS: isolated copy ready, real content untouched on disk');

  console.log('SETUP: starting a throwaway issuer-server instance on port ' + PORT + ' against the copied docroot');
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

    console.log('STEP 1: index.html — logo is centered, both new callouts present, second one links to wallet-bridge-demo.html');
    const indexPage = await context.newPage();
    await indexPage.goto('http://' + DOMAIN + '/index.html', { waitUntil: 'load' });
    const logoMarginLeftPx = await indexPage.locator('.logo').evaluate((img) => parseFloat(getComputedStyle(img).marginLeft));
    const logoMarginRightPx = await indexPage.locator('.logo').evaluate((img) => parseFloat(getComputedStyle(img).marginRight));
    // Sub-pixel rounding (220px max-width inside a non-evenly-divisible
    // body width) means these land a fraction of a pixel apart, not
    // exactly equal — a 1px tolerance is "centered" for any real viewport.
    if (Math.abs(logoMarginLeftPx - logoMarginRightPx) > 1) throw new Error('Expected the logo\'s left/right margins to match (centered), got left=' + logoMarginLeftPx + 'px right=' + logoMarginRightPx + 'px');
    if (logoMarginLeftPx === 0) throw new Error('Expected the logo to actually have non-zero auto margins once centered, got 0px both sides — probably not centered at all');
    const bodyText = await indexPage.locator('body').innerText();
    if (!bodyText.includes('Walking into these spaces needs the wallet extension')) throw new Error('Expected the wallet-extension callout text on index.html');
    if (!bodyText.includes('talk to that wallet directly')) throw new Error('Expected the new wallet-bridge-demo callout text on index.html');
    const bridgeDemoLinkHref = await indexPage.locator('a[href="/wallet-bridge-demo.html"]').getAttribute('href');
    if (bridgeDemoLinkHref !== '/wallet-bridge-demo.html') throw new Error('Expected a link to /wallet-bridge-demo.html on index.html');
    await indexPage.close();
    console.log('PASS: index.html centers the logo and carries both new callouts, one linking to the new demo page');

    console.log('STEP 2: wallet-bridge-demo.html — "Check my wallet" correctly reports no active identity before one exists');
    const demoPage = await context.newPage();
    await demoPage.goto('http://' + DOMAIN + '/wallet-bridge-demo.html', { waitUntil: 'load' });
    await demoPage.waitForFunction(() => !document.getElementById('checkBtn').disabled, null, { timeout: 10000 }); // extension-detection poll finishing
    await demoPage.locator('#checkBtn').click();
    await demoPage.waitForFunction(() => {
      const el = document.getElementById('checkStatus');
      return el && el.textContent.includes('No wallet identity is active');
    }, null, { timeout: 10000 });
    const signBtnDisabledBefore = await demoPage.locator('#signBtn').isDisabled();
    const offerBtnDisabledBefore = await demoPage.locator('#offerBtn').isDisabled();
    if (!signBtnDisabledBefore || !offerBtnDisabledBefore) throw new Error('Expected Step 2/3 buttons to stay disabled with no active identity');
    console.log('PASS: with no identity active, the page correctly says so and leaves Step 2/3 disabled');

    console.log('STEP 3: creating a real wallet identity (side panel, standalone mode)');
    const walletPage = await context.newPage();
    await walletPage.goto('chrome-extension://' + extensionId + '/viewer.html', { waitUntil: 'load' });
    await walletPage.waitForFunction(() => document.getElementById('walletPanel').classList.contains('open'), null, { timeout: 10000 });
    await walletPage.locator('#chooseNewBtn').click();
    await walletPage.locator('#newPasswordInput').fill('demo-b-bridge-test-pw');
    await walletPage.locator('#newPasswordConfirmInput').fill('demo-b-bridge-test-pw');
    await walletPage.locator('#confirmCreateBtn').click();
    await walletPage.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), null, { timeout: 5000 });
    await walletPage.locator('#seedConfirmCheck').check();
    await walletPage.locator('#seedConfirmBtn').click();
    await walletPage.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), null, { timeout: 5000 });
    const realPublicKey = await walletPage.evaluate(async () => {
      const identity = await AtlasWallet.getIdentity();
      return identity ? identity.publicKey : null;
    });
    if (!realPublicKey) throw new Error('Expected a real public key right after creating the identity');
    console.log('PASS: a real identity now exists');

    console.log('STEP 4: "Check my wallet" now reports the real identity, and enables Step 2/3');
    // walletPage was the last tab interacted with (STEP 3) and Playwright
    // doesn't auto-focus a page on every action — left backgrounded,
    // Chromium's own tab-timer throttling escalates the longer a tab
    // stays unfocused, which is exactly what made STEP 5/6 below
    // intermittently crawl past a 30s wait despite the underlying
    // round-trip normally settling in under a second (confirmed via a
    // one-off debug script that polled with real-time waits instead of
    // waitForFunction's rAF-based default and never saw the stall).
    // Bringing demoPage back to front here, once, before any of the
    // timer/rAF-sensitive waits below, keeps it a normal foreground tab
    // for the rest of this test.
    await demoPage.bringToFront();
    await demoPage.locator('#checkBtn').click();
    await demoPage.waitForFunction(() => {
      const el = document.getElementById('checkStatus');
      return el && el.textContent.includes('Active identity');
    }, null, { timeout: 10000 });
    await demoPage.waitForFunction(() => !document.getElementById('signBtn').disabled && !document.getElementById('offerBtn').disabled, null, { timeout: 5000 });
    console.log('PASS: the page picked up the real identity and enabled Step 2/3');

    console.log('STEP 5: "Ask for a signature" shows the real prompt naming "demo-login", and reports a real signed envelope once approved');
    await demoPage.locator('#signBtn').click();
    await demoPage.waitForSelector('#domain-atlas-bridge-confirm', { timeout: 10000 });
    const signFrame = demoPage.frameLocator('#domain-atlas-bridge-confirm');
    await signFrame.locator('#readyState').waitFor({ state: 'visible', timeout: 10000 });
    const signPayloadBoxText = await signFrame.locator('#payloadBox').innerText();
    if (!signPayloadBoxText.includes('demo-login')) throw new Error('Expected the prompt to show the real purpose "demo-login", got: ' + signPayloadBoxText);
    await signFrame.locator('#approveBtn').click();
    // The explicit `undefined` matters here: Playwright's
    // waitForFunction(fn, arg, options) treats a bare second object as
    // `arg`, not `options` — passing {timeout} alone (the shorthand used
    // elsewhere in this suite, harmless there because those conditions
    // resolve almost immediately) would silently fall back to
    // Playwright's own 30s default instead of whatever's written here.
    await demoPage.waitForFunction(() => {
      const el = document.getElementById('signStatus');
      return el && el.textContent.includes('Signed.');
    }, undefined, { timeout: 10000 });
    // .textContent(), not .innerText() — the envelope JSON sits inside a
    // closed <details>, and innerText only returns rendered (visible)
    // text, which a closed <details>'s body isn't.
    const signEnvelopeText = await demoPage.locator('#signStatus pre').textContent();
    const signEnvelope = JSON.parse(signEnvelopeText);
    if (signEnvelope.signerRole !== 'raw-ecdsa' && signEnvelope.signerRole !== 'webauthn') throw new Error('Expected a real proof envelope with a signerRole, got: ' + signEnvelopeText);
    if (signEnvelope.publicKey !== realPublicKey) throw new Error('Expected the envelope\'s public key to match the real active identity');
    console.log('PASS: the signing prompt named the real purpose, and approval produced a real signed envelope under the active identity\'s own key');

    console.log('STEP 6: "Offer me a collectible" mints a real credential, shows the real offer prompt, and queues it WITHOUT adding it to the wallet');
    await demoPage.locator('#offerBtn').click();
    await demoPage.waitForSelector('#domain-atlas-bridge-confirm', { timeout: 10000 });
    const offerFrame = demoPage.frameLocator('#domain-atlas-bridge-confirm');
    await offerFrame.locator('#offerState').waitFor({ state: 'visible', timeout: 10000 });
    const offerClassShown = await offerFrame.locator('#offerAssetClass').innerText();
    if (offerClassShown !== 'atlas.wearable.ring') throw new Error('Expected the prompt to show the real asset class "atlas.wearable.ring", got: ' + offerClassShown);
    await offerFrame.locator('#offerApproveBtn').click();
    // Same explicit-arg note as STEP 5's wait above.
    await demoPage.waitForFunction(() => {
      const el = document.getElementById('offerStatus');
      return el && el.textContent.includes('Queued.');
    }, undefined, { timeout: 10000 });
    const pendingOffers = await walletPage.evaluate((owner) => AtlasWallet.getBridgeOffers(owner), realPublicKey);
    const queuedEntry = pendingOffers.find((e) => e.credential.asset.class === 'atlas.wearable.ring' && !e.claimed);
    if (!queuedEntry) throw new Error('Expected the offered ring to actually be sitting in getBridgeOffers(), unclaimed');
    const walletAfterOffer = await walletPage.evaluate((owner) => AtlasWallet.getWallet(owner), realPublicKey);
    if (walletAfterOffer.some((e) => e.credential.id === queuedEntry.credential.id)) throw new Error('Approving the offer must not have added it to the wallet directly');
    await demoPage.close();
    console.log('PASS: the offer prompt named the real asset class, and approval queued the real minted credential into pending bridge offers without touching the live wallet');

    console.log('\nALL CHECKS PASSED — demo-domain-b\'s index.html centers its logo and carries both new callouts, and wallet-bridge-demo.html genuinely exercises SPEC.md §3.8/§3.8.1/§3.8.2 end to end against this domain\'s own manifest: Check my wallet, Ask for a signature, and Offer me a collectible all do exactly what their on-page copy claims.');
  } finally {
    await context.close().catch(() => {});
    serverProc.kill();
    try { fs.rmSync(DOCROOT_DIR, { recursive: true, force: true }); } catch (err) {}
    try { fs.rmSync(STATE_DIR, { recursive: true, force: true }); } catch (err) {}
    try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch (err) {}
  }
})();
