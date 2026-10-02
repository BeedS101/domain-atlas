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
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts. No issuer-server dependency — this page is
// deliberately plain, with nothing Domain Atlas related on it at all.

const { chromium } = require('playwright');
const path = require('path');
const http = require('http');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');

(async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><head><title>Plain page</title></head><body>No manifest here.</body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const userDataDir = path.resolve(__dirname, '.chrome-profile-toolbar-wallet');
  const context = await chromium.launchPersistentContext(userDataDir, {
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

    console.log('STEP 2: a second toolbar message while already open must not tear down the overlay');
    await background.evaluate(async () => {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      await chrome.tabs.sendMessage(tabs[0].id, { type: 'domain-atlas-open-wallet' });
    });
    await page.waitForTimeout(300); // give a (wrongly) re-created iframe a moment to appear if it were going to
    const overlayCountAfter = await page.evaluate(() => document.querySelectorAll('#domain-atlas-overlay').length);
    if (overlayCountAfter !== 1) throw new Error('Expected exactly one overlay iframe after a second toolbar message, got: ' + overlayCountAfter);
    console.log('PASS: second toolbar message left the existing overlay alone');

    console.log('\nALL CHECKS PASSED — toolbar-button wallet-open works on a manifest-less page, and is idempotent while already open.');
  } finally {
    await context.close();
    server.close();
  }
})();
