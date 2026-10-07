// Manual check for SPEC.md §3.8.5: atlasWallet.previewAsset() /
// hidePreview() — a page asks the wallet to show a credential it holds in
// the wallet's own docked preview panel (extension/preview-bridge.html,
// injected by content.js), and the domain B demo page uses that to preview
// the ring it mints when the visitor hovers its card.
//
// Uses a copy of the real demo-domain-b directory (manifest domain
// rewritten to this test's own port), same as
// manual-demo-domain-b-wallet-bridge.js, so a green run proves the
// committed page works. Its manifest whitelists only atlas.wearable.ring
// for walletBridge.offer.
//
// Checks:
//   1. A whitelisted class is shown: the frame appears, says it's a
//      preview from this page's origin and not in the wallet, lists the
//      properties, and never intercepts the pointer.
//   2. Markup in the credential's strings is displayed as text, not
//      interpreted.
//   3. A class that is not on the offer whitelist, and a malformed
//      credential, are refused and show nothing.
//   4. hidePreview() removes the panel.
//   5. The panel docks in the corner the visitor chose for the world
//      Previewer.
//   6. A preview ends on its own after the inactivity limit unless the page
//      re-requests it.
//   7. On the demo page the ring is minted and its card shown as soon as
//      the identity is known: hovering the card previews it BEFORE any offer,
//      previewing queues nothing, and the offer then queues that same ring.
//
// Not part of the permanent suite, same reasoning as the other manual-*.js
// scripts.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const PORT = 8215; // isolated — distinct from every other manual-*.js test's chosen port
const DOMAIN = 'localhost:' + PORT;
const ORIGIN = 'http://' + DOMAIN;
const DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-preview-docroot-'));
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-preview-state-'));
const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-preview-profile-'));

function assert(cond, message) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + message);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function credentialOf(assetClass, extra) {
  return {
    credential: 'domain-atlas-asset/1.0',
    id: 'urn:atlas:asset:preview-test-' + Math.random().toString(16).slice(2),
    issuer: { domain: DOMAIN },
    asset: Object.assign({
      class: assetClass,
      name: 'Preview Test Ring',
      thumbnail: ORIGIN + '/assets/ring.png',
      properties: { color: 'gold', stones: 3 }
    }, extra || {})
  };
}

(async () => {
  console.log('SETUP: isolated copy of demo-domain-b on port ' + PORT);
  fs.cpSync(path.resolve(__dirname, '..', 'demo-domain-b'), DOCROOT_DIR, { recursive: true });
  const spatialPath = path.join(DOCROOT_DIR, '.well-known', 'spatial.json');
  const spatial = JSON.parse(fs.readFileSync(spatialPath, 'utf8'));
  spatial.domain = DOMAIN;
  spatial.chat = false;
  spatial.postOffice = false;
  spatial.calendar = false;
  fs.writeFileSync(spatialPath, JSON.stringify(spatial, null, 2));

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

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  });

  try {
    let background = context.serviceWorkers()[0];
    if (!background) background = await context.waitForEvent('serviceworker');
    const extensionId = new URL(background.url()).host;

    const page = await context.newPage();
    await page.goto(ORIGIN + '/wallet-bridge-demo.html', { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.atlasWallet, undefined, { timeout: 10000 });
    const previewFrameCount = () => page.evaluate(() => document.querySelectorAll('#domain-atlas-bridge-preview').length);
    const previewFrame = () => page.frameLocator('#domain-atlas-bridge-preview');
    const waitForFrameGone = (ms) => page.waitForFunction(() => !document.getElementById('domain-atlas-bridge-preview'), undefined, { timeout: ms });

    console.log('STEP 1: a whitelisted class is shown, labelled as a preview, and never takes the pointer');
    const ok = await page.evaluate((c) => window.atlasWallet.previewAsset(c), credentialOf('atlas.wearable.ring'));
    assert(ok.allowed === true && ok.shown === true, 'expected {allowed:true, shown:true}, got ' + JSON.stringify(ok));
    await page.waitForSelector('#domain-atlas-bridge-preview', { timeout: 5000 });
    await previewFrame().locator('.name').waitFor({ timeout: 5000 });
    assert((await previewFrame().locator('.name').innerText()) === 'Preview Test Ring', 'unexpected name');
    const note = await previewFrame().locator('.note').innerText();
    assert(note.includes(ORIGIN) && note.includes('not in your wallet'), 'expected the requesting origin and "not in your wallet", got: ' + note);
    const props = await previewFrame().locator('.props').innerText();
    assert(props.includes('color: gold') && props.includes('stones: 3'), 'expected the properties listed, got: ' + props);
    const pointerEvents = await page.evaluate(() => getComputedStyle(document.getElementById('domain-atlas-bridge-preview')).pointerEvents);
    assert(pointerEvents === 'none', 'the preview frame must not intercept the pointer, got ' + pointerEvents);
    console.log('PASS: shown, labelled, pointer-events none');

    console.log('STEP 1b: the frame fits its panel exactly — no scrollbar — including a tall one');
    const fits = async () => {
      // Give an image that finished loading a moment to be reported.
      await sleep(600);
      return previewFrame().locator('#panel').evaluate((panel) => ({
        panel: Math.ceil(panel.getBoundingClientRect().height),
        view: document.documentElement.clientHeight,
        scroll: document.documentElement.scrollHeight
      }));
    };
    let fit = await fits();
    assert(fit.scroll <= fit.view && fit.view >= fit.panel, 'expected no overflow for the short panel, got ' + JSON.stringify(fit));
    const tallProps = {};
    for (let i = 0; i < 12; i++) tallProps['property' + i] = 'a fairly long value that wraps onto a second line ' + i;
    await page.evaluate((c) => window.atlasWallet.previewAsset(c), credentialOf('atlas.wearable.ring', { name: 'A Ring With A Very Long Descriptive Name That Wraps', properties: tallProps }));
    await previewFrame().locator('.props div').nth(11).waitFor({ timeout: 5000 });
    fit = await fits();
    assert(fit.panel > 300, 'the tall panel should exceed the old 120px starting height by a lot, got ' + JSON.stringify(fit));
    assert(fit.scroll <= fit.view && fit.view >= fit.panel, 'expected no overflow for the tall panel, got ' + JSON.stringify(fit));
    console.log('PASS: no overflow, frame ' + fit.view + 'px for a ' + fit.panel + 'px panel');

    console.log('STEP 2: markup in the credential\'s strings is shown as text');
    const hostile = '<img src=x onerror="document.title=\'pwned\'"><b>bold</b>';
    await page.evaluate((c) => window.atlasWallet.previewAsset(c), credentialOf('atlas.wearable.ring', { name: hostile, properties: { '<i>key</i>': '<script>1</script>' } }));
    await previewFrame().locator('.name').filter({ hasText: 'onerror' }).waitFor({ timeout: 5000 });
    assert((await previewFrame().locator('.name').innerText()) === hostile, 'expected the markup shown literally');
    assert((await previewFrame().locator('#body b').count()) === 0, 'a <b> in the name must not become an element');
    assert((await previewFrame().locator('#body img[src="x"]').count()) === 0, 'an <img> in the name must not become an element');
    assert((await page.title()) !== 'pwned', 'the onerror handler must not have run');
    console.log('PASS: displayed literally, nothing injected');

    console.log('STEP 3: a non-whitelisted class and a malformed credential are refused and show nothing');
    await page.evaluate(() => window.atlasWallet.hidePreview());
    await waitForFrameGone(5000);
    const refused = await page.evaluate((c) => window.atlasWallet.previewAsset(c), credentialOf('atlas.badge'));
    assert(refused.allowed === false && refused.shown === false, 'expected a refusal for a class not on the offer whitelist, got ' + JSON.stringify(refused));
    const malformed = await page.evaluate(() => window.atlasWallet.previewAsset({ credential: 'nope' }));
    assert(malformed.allowed === false && malformed.shown === false, 'expected a refusal for a malformed credential, got ' + JSON.stringify(malformed));
    await sleep(500);
    assert((await previewFrameCount()) === 0, 'a refused preview must not create a frame');
    console.log('PASS: both refused, no frame');

    console.log('STEP 4: hidePreview() removes the panel');
    await page.evaluate((c) => window.atlasWallet.previewAsset(c), credentialOf('atlas.wearable.ring'));
    await page.waitForSelector('#domain-atlas-bridge-preview', { timeout: 5000 });
    await page.evaluate(() => window.atlasWallet.hidePreview());
    await waitForFrameGone(5000);
    console.log('PASS: frame removed');

    console.log('STEP 5: the panel docks in the corner chosen for the world Previewer');
    const walletPage = await context.newPage();
    await walletPage.goto('chrome-extension://' + extensionId + '/viewer.html', { waitUntil: 'load' });
    await walletPage.evaluate(() => AtlasWallet.setPreviewerWindowSettings({ dock: 'top-right' }));
    await page.bringToFront();
    await page.evaluate((c) => window.atlasWallet.previewAsset(c), credentialOf('atlas.wearable.ring'));
    await page.waitForSelector('#domain-atlas-bridge-preview', { timeout: 5000 });
    await previewFrame().locator('.name').waitFor({ timeout: 5000 });
    const box = await page.evaluate(() => {
      const r = document.getElementById('domain-atlas-bridge-preview').getBoundingClientRect();
      return { top: r.top, right: document.documentElement.clientWidth - r.right, bottom: window.innerHeight - r.bottom, left: r.left };
    });
    assert(Math.abs(box.top - 16) < 2 && Math.abs(box.right - 16) < 2, 'expected the frame 16px from the top-right corner, got ' + JSON.stringify(box));
    await page.evaluate(() => window.atlasWallet.hidePreview());
    await waitForFrameGone(5000);
    await walletPage.evaluate(() => AtlasWallet.setPreviewerWindowSettings({ dock: 'bottom-left' }));
    console.log('PASS: docked top-right at 16px');

    console.log('STEP 6: a preview ends on its own after the inactivity limit unless the page re-requests it');
    await page.bringToFront();
    await page.evaluate((c) => window.atlasWallet.previewAsset(c), credentialOf('atlas.wearable.ring'));
    await page.waitForSelector('#domain-atlas-bridge-preview', { timeout: 5000 });
    await sleep(12000);
    await page.evaluate((c) => window.atlasWallet.previewAsset(c), credentialOf('atlas.wearable.ring')); // re-request resets the clock
    await sleep(12000); // 24s since the first request, 12s since the re-request
    assert((await previewFrameCount()) === 1, 'a re-requested preview must still be up 24s after the first request');
    await waitForFrameGone(15000); // 20s after the re-request
    console.log('PASS: kept up by a re-request, gone ~20s after the last one');

    console.log('STEP 7: on the demo page the ring can be previewed before it is offered, and the offer queues that same ring');
    await walletPage.bringToFront();
    await walletPage.waitForFunction(() => document.getElementById('walletPanel').classList.contains('open'), undefined, { timeout: 10000 });
    await walletPage.locator('#chooseNewBtn').click();
    await walletPage.locator('#newPasswordInput').fill('preview-bridge-test-pw');
    await walletPage.locator('#newPasswordConfirmInput').fill('preview-bridge-test-pw');
    await walletPage.locator('#confirmCreateBtn').click();
    await walletPage.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), undefined, { timeout: 5000 });
    await walletPage.locator('#seedConfirmCheck').check();
    await walletPage.locator('#seedConfirmBtn').click();
    await walletPage.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), undefined, { timeout: 5000 });
    await page.bringToFront();
    await page.locator('#checkBtn').click();
    // The ring is minted and its card shown as soon as the identity is
    // known, before the offer button is touched.
    await page.waitForSelector('#itemCard', { timeout: 10000 });
    await page.waitForFunction(() => !document.getElementById('offerBtn').disabled, undefined, { timeout: 10000 });
    assert((await previewFrameCount()) === 0, 'no preview should be showing before the card is hovered');
    const cardCredentialId = await page.locator('#itemCard').getAttribute('data-credential-id');
    assert(cardCredentialId && cardCredentialId.startsWith('urn:atlas:asset:'), 'expected the card to carry the minted credential id, got ' + cardCredentialId);
    await page.hover('#itemCard');
    await page.waitForSelector('#domain-atlas-bridge-preview', { timeout: 5000 });
    await previewFrame().locator('.name').waitFor({ timeout: 5000 });
    const cardName = await page.locator('#itemCard .item-name').innerText();
    assert((await previewFrame().locator('.name').innerText()).startsWith(cardName), 'expected the preview to show the same item as the card');
    await page.mouse.move(2, 2);
    await waitForFrameGone(5000);
    // Nothing was offered yet: the wallet has no pending offers.
    const walletKey = await walletPage.evaluate(async () => (await AtlasWallet.getIdentity()).publicKey);
    const pendingBefore = await walletPage.evaluate((k) => AtlasWallet.getBridgeOffers(k), walletKey);
    assert(pendingBefore.length === 0, 'previewing must not have queued anything, found ' + pendingBefore.length);
    // Now offer the very ring that was just previewed.
    await page.locator('#offerBtn').click();
    await page.waitForSelector('#domain-atlas-bridge-confirm', { timeout: 10000 });
    const offerFrame = page.frameLocator('#domain-atlas-bridge-confirm');
    await offerFrame.locator('#offerState').waitFor({ state: 'visible', timeout: 10000 });
    await offerFrame.locator('#offerApproveBtn').click();
    await page.waitForFunction(() => document.getElementById('offerStatus').textContent.includes('Queued.'), undefined, { timeout: 10000 });
    const pendingAfter = await walletPage.evaluate((k) => AtlasWallet.getBridgeOffers(k), walletKey);
    assert(pendingAfter.length === 1 && pendingAfter[0].credential.id === cardCredentialId, 'expected the queued offer to be the previewed ring ' + cardCredentialId + ', got ' + JSON.stringify(pendingAfter.map((e) => e.credential.id)));
    console.log('PASS: previewed before offering, nothing queued by previewing, and the offer queued that same ring');

    console.log('\nALL PAGE WALLET-BRIDGE PREVIEW CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close().catch(() => {});
    serverProc.kill();
    try { fs.rmSync(DOCROOT_DIR, { recursive: true, force: true }); } catch (err) {}
    try { fs.rmSync(STATE_DIR, { recursive: true, force: true }); } catch (err) {}
    try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch (err) {}
    process.exit(process.exitCode || 0);
  }
})();
