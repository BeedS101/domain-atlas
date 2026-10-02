// Manual check: the wallet opens via the toolbar button's own message
// (background.js -> content.js) on an ordinary page that declares no
// spatial manifest at all, and a second click while it's already open
// is a no-op rather than tearing down what's already showing.
//
// Playwright can't click the real browser toolbar icon (it lives outside
// any page's accessibility tree), so this calls into the extension's own
// background service worker directly and has IT send the exact message
// background.js sends on a real click — exercising the real content.js
// listener and the real openOverlay()/viewer.js standalone-mode path end
// to end, just without needing to hit browser chrome pixels.
//
// STEP 3 covers a second live bug report against this same feature: the
// Asset Viewer hover panel (task #150) opening over everything when a
// wallet asset is hovered in this view. openAssetViewer()'s
// positionAssetViewer() math assumes room beside the hovered card in a
// roughly full-size viewport; the standalone corner frame (380px wide,
// see STEP 1b) has none, so the fix is a guard in openAssetViewer()
// that skips opening the panel at all whenever currentManifest is unset
// — which is only ever true in this standalone mode, since loadManifest()
// (the only place that sets it) is never called here. That needs a real
// asset in the wallet to hover, which needs a live issuer-server, so this
// test spins up its own throwaway instance the same way
// manual-3d-key-anchored-portal.js and its siblings do (isolated docroot
// copy + isolated state dir + isolated Chrome profile, all cleaned up in
// `finally`), rather than depending on one already running on 8001/8002.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const PORT = 8201; // isolated — distinct from every other manual-*.js test's chosen port
const DOMAIN = 'localhost:' + PORT;
const DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-toolbar-wallet-docroot-'));
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-toolbar-wallet-state-'));
const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-toolbar-wallet-profile-'));

(async () => {
  console.log('SETUP: copying demo-domain-a into an isolated docroot for a throwaway issuer-server (only STEP 3 needs it)');
  fs.cpSync(path.resolve(__dirname, '..', 'demo-domain-a'), DOCROOT_DIR, { recursive: true });

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

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><head><title>Plain page</title></head><body>No manifest here.</body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  });

  try {
    const page = await context.newPage();
    console.log('SETUP: plain page with no spatial manifest at all');
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });

    const hasEnterBtn = await page.evaluate(() => !!document.getElementById('domain-atlas-enter-btn'));
    if (hasEnterBtn) throw new Error('Expected no Enter-Space button on a manifest-less page');
    console.log('PASS: no manifest-driven UI on this page, as expected');

    console.log('STEP 1: simulate the toolbar click via the background service worker');
    let background = context.serviceWorkers()[0];
    if (!background) background = await context.waitForEvent('serviceworker');
    await background.evaluate(async () => {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      await chrome.tabs.sendMessage(tabs[0].id, { type: 'domain-atlas-open-wallet' });
    });

    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForSelector('#walletPanel.open', { timeout: 10000 });
    console.log('PASS: wallet overlay opened with the panel already showing, no manifest involved');

    const placeLabelText = await frame.locator('#placeLabel').innerText();
    if (!placeLabelText.includes('Wallet')) throw new Error('Expected placeLabel to say something Wallet-related in standalone mode, got: ' + placeLabelText);
    console.log('PASS: placeLabel reflects standalone wallet-only mode, not stuck on "Loading space…"');

    console.log('STEP 1b: no leftover empty "room" — the overlay is a small corner frame, not a full-viewport takeover, and the blank #scene canvas is hidden rather than showing through next to the panel');
    const overlayBox = await frameHandle.boundingBox();
    if (!overlayBox || overlayBox.width > 500) throw new Error('Expected a small corner frame in standalone mode, got a bounding box: ' + JSON.stringify(overlayBox));
    const sceneDisplay = await frame.locator('#scene').evaluate((el) => getComputedStyle(el).display);
    if (sceneDisplay !== 'none') throw new Error('Expected #scene hidden in standalone mode, got display: ' + sceneDisplay);
    const walletBtnDisplay = await frame.locator('#walletBtn').evaluate((el) => getComputedStyle(el).display);
    if (walletBtnDisplay !== 'none') throw new Error('Expected the wallet-panel toggle button hidden in standalone mode (nothing to toggle back to), got display: ' + walletBtnDisplay);
    const chatWidgetDisplay = await frame.locator('#chatWidget').evaluate((el) => getComputedStyle(el).display);
    if (chatWidgetDisplay !== 'none') throw new Error('Expected #chatWidget hidden in standalone mode (no world\'s chat backs it), got display: ' + chatWidgetDisplay);
    console.log('PASS: small corner frame, no blank canvas, no toggle button or chat widget showing through behind the panel');

    console.log('STEP 2: a second toolbar message while already open must not tear down the overlay');
    await background.evaluate(async () => {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      await chrome.tabs.sendMessage(tabs[0].id, { type: 'domain-atlas-open-wallet' });
    });
    await page.waitForTimeout(300); // give a (wrongly) re-created iframe a moment to appear if it were going to
    const overlayCountAfter = await page.evaluate(() => document.querySelectorAll('#domain-atlas-overlay').length);
    if (overlayCountAfter !== 1) throw new Error('Expected exactly one overlay iframe after a second toolbar message, got: ' + overlayCountAfter);
    console.log('PASS: second toolbar message left the existing overlay alone');

    console.log('STEP 3: a real asset card\'s hover panel stays disabled in this standalone corner frame (task #150 vs. the "empty room" fix\'s 380px frame)');
    await frame.locator('#chooseNewBtn').click();
    await frame.locator('#newPasswordInput').fill('toolbar-wallet-test-pw');
    await frame.locator('#newPasswordConfirmInput').fill('toolbar-wallet-test-pw');
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    await frame.evaluate(async (domain) => {
      await AtlasWallet.mintAsset('self', domain, 'atlas.element.iron', 20);
      await refreshInventoryDisplay();
    }, DOMAIN);
    await frame.waitForSelector('#selfCollectiblesList .wallet-item', { timeout: 15000 });
    console.log('PASS: a real asset card is showing in the standalone wallet');

    await frame.locator('#selfCollectiblesList .wallet-item').first().hover();
    await page.waitForTimeout(300); // give a (wrongly) opening panel a moment to appear if it were going to
    const widgetHidden = await frame.locator('#assetViewerWidget').evaluate((el) => el.hidden);
    if (!widgetHidden) throw new Error('Expected #assetViewerWidget to stay hidden on hover in standalone mode (no room to show it beside a card in a 380px frame)');
    console.log('PASS: hovering the asset card did not open the Asset Viewer panel in standalone mode');

    console.log('\nALL CHECKS PASSED — toolbar-button wallet-open works on a manifest-less page, is idempotent while already open, and the Asset Viewer hover panel stays disabled there.');
  } finally {
    await context.close().catch(() => {});
    server.close();
    serverProc.kill();
    try { fs.rmSync(DOCROOT_DIR, { recursive: true, force: true }); } catch (err) {}
    try { fs.rmSync(STATE_DIR, { recursive: true, force: true }); } catch (err) {}
    try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch (err) {}
  }
})();
