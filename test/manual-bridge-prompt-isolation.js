// Manual check: the wallet-bridge confirmation (signing here; offers, identity choice and purchases open the same window)
// cannot be reached, covered, restyled, answered or kept open by the page that asked for it.
//
// The confirmation is a window of its own that the extension opens, not an element of the requesting page. This test
// serves a deliberately hostile page and asks it to request signatures while it
//   - hides, blurs, shrinks, de-pointers and paints over every iframe, dialog and extension-looking element, puts a
//     full-page max-z-index layer and a top-layer modal dialog over everything, and strips or navigates any iframe that is added
//   - removes nodes the extension adds, and watches for any element carrying an extension id or the old prompt id
//   - posts forged prompt and decision messages ("approved": true) at itself and at every frame, continuously
//   - tries to load the prompt page into an iframe and a popup of its own by its extension URL
//   - fires many signature requests in a row
// and checks that none of it changes what the visitor sees or decides: the prompt opens in its own window with the real
// origin and payload, the page's CSS does not touch it, the request stays pending until the visitor's own click, the
// signature covers the genuine request, closing the window or leaving the page ends the request as declined, and a page
// that keeps being declined is refused new windows for a while.
'use strict';
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const BP = require('./lib/bridge-prompt');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const PORT = 8271;
const DOMAIN = 'localhost:' + PORT;
const DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-bridge-iso-docroot-'));
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-bridge-iso-state-'));
const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-bridge-iso-profile-'));

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? 'PASS' : 'FAIL') + ': ' + name + (!ok && detail !== undefined ? ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400) : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SPATIAL_JSON = {
  spec: 'domain-atlas/1.0',
  domain: DOMAIN,
  owner: { name: 'Bridge Isolation Test Domain', contact: 'demo@localhost' },
  walletBridge: { read: true, sign: ['login'] },
  defaultWorld: 'lobby',
  worlds: [{
    id: 'lobby', name: 'Lobby',
    entry: { scene: '/spatial/lobby/scene.json', renderer: ['procedural-v1'] },
    policy: { guestAccess: 'open', discoverable: true, identityRequired: false, itemDropsAllowed: false, acceptedItemClasses: [], trustedIssuers: 'any' }
  }],
  updated: '2026-10-02T00:00:00Z'
};
const LOBBY_SCENE = { format: 'procedural-v1', floor: { size: [10, 10], color: '#1b2830' }, objects: [], portalMarkers: [], anchors: [] };

// Everything a hostile page can do to a prompt that lives in its own DOM. It runs from page load, before any request.
const HOSTILE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Hostile</title>
<link rel="spatial" href="/.well-known/spatial.json">
<style>
  /* hide, shrink, blur, disable and paint over anything that could be a prompt */
  iframe, dialog, [id^="domain-atlas"], [id*="confirm"], [id*="bridge"] {
    display: none !important; visibility: hidden !important; opacity: 0 !important; pointer-events: none !important;
    width: 0 !important; height: 0 !important; transform: scale(0) !important; clip-path: inset(100%) !important; filter: blur(80px) !important;
  }
  html { filter: contrast(0) brightness(0); }
  body { overflow: hidden; }
  #cover { position: fixed; inset: 0; z-index: 2147483647; background: #fff; color: #000; font: 20px sans-serif; }
  * { cursor: none !important; }
</style></head><body>
<h1 id="cover">Click anywhere to win a prize</h1>
<dialog id="topLayer"><p>Totally harmless</p></dialog>
<script>
  window.__seen = { added: [], removed: 0, messages: 0 };
  const extId = location.hash.slice(1);
  // Cover everything, including the top layer, as soon as possible and again whenever anything is added.
  try { document.getElementById('topLayer').showModal(); } catch (e) {}
  const hardenAll = () => {
    for (const el of document.querySelectorAll('iframe')) { el.style.cssText += ';opacity:0!important;pointer-events:none!important;display:none!important'; try { el.src = 'about:blank'; } catch (e) {} }
  };
  new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) {
      if (n.nodeType !== 1) continue;
      window.__seen.added.push((n.tagName || '') + '#' + (n.id || ''));
      if (n.tagName === 'IFRAME' || /domain-atlas|confirm|bridge/i.test(n.id || '')) { try { n.remove(); window.__seen.removed++; } catch (e) {} }
    }
    hardenAll();
  }).observe(document.documentElement, { childList: true, subtree: true });
  // Forged prompt and decision messages, at this window and at every frame, over and over.
  window.addEventListener('message', () => { window.__seen.messages++; });
  setInterval(() => {
    const forged = [
      { type: 'domain-atlas-bridge-confirm-decision', approved: true, result: { signedPayload: { forged: true }, publicKey: 'ATTACKER' } },
      { type: 'domain-atlas-bridge-confirm-result', approved: true, result: { forged: true } },
      { type: 'domain-atlas-bridge-confirm-init', origin: 'https://bank.example', kind: 'sign', detail: 'login', payload: { action: 'transfer', to: 'ATTACKER' } }
    ];
    for (const target of [window, ...Array.from(window.frames)]) for (const m of forged) { try { target.postMessage(m, '*'); } catch (e) {} }
  }, 25);
  // Try to put the prompt page into this page by its extension URL, and into a popup of the page's own.
  window.tryLoadPrompt = () => {
    const f = document.createElement('iframe');
    f.src = 'chrome-extension://' + extId + '/confirm-bridge.html#' + 'ab'.repeat(24);
    document.body.appendChild(f);
    try { window.open('chrome-extension://' + extId + '/confirm-bridge.html#' + 'cd'.repeat(24), '_blank', 'width=400,height=400'); } catch (e) {}
    return fetch('chrome-extension://' + extId + '/confirm-bridge.js').then((r) => 'fetched ' + r.status, (e) => 'blocked: ' + e.message);
  };
</script></body></html>`;

(async () => {
  fs.mkdirSync(path.join(DOCROOT_DIR, '.well-known'), { recursive: true });
  fs.mkdirSync(path.join(DOCROOT_DIR, 'spatial', 'lobby'), { recursive: true });
  fs.writeFileSync(path.join(DOCROOT_DIR, '.well-known', 'spatial.json'), JSON.stringify(SPATIAL_JSON, null, 2));
  fs.writeFileSync(path.join(DOCROOT_DIR, 'spatial', 'lobby', 'scene.json'), JSON.stringify(LOBBY_SCENE, null, 2));
  fs.writeFileSync(path.join(DOCROOT_DIR, 'hostile.html'), HOSTILE_HTML);
  fs.writeFileSync(path.join(DOCROOT_DIR, 'plain.html'), '<!doctype html><html><head><meta charset="utf-8"><title>Plain</title><link rel="spatial" href="/.well-known/spatial.json"></head><body>plain</body></html>');

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

    // A real identity, so a prompt can be approved.
    const walletPage = await context.newPage();
    await walletPage.goto('chrome-extension://' + extensionId + '/viewer.html', { waitUntil: 'load' });
    await walletPage.waitForFunction(() => document.getElementById('walletPanel').classList.contains('open'), null, { timeout: 10000 });
    await walletPage.locator('#chooseNewBtn').click();
    await walletPage.locator('#newPasswordInput').fill('bridge-iso-test-pw');
    await walletPage.locator('#newPasswordConfirmInput').fill('bridge-iso-test-pw');
    await walletPage.locator('#confirmCreateBtn').click();
    await walletPage.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), null, { timeout: 5000 });
    await walletPage.locator('#seedConfirmCheck').check();
    await walletPage.locator('#seedConfirmBtn').click();
    await walletPage.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), null, { timeout: 5000 });
    const publicKey = await walletPage.evaluate(async () => (await AtlasWallet.getIdentity()).publicKey);
    await walletPage.close();

    const hostile = async () => {
      const page = await context.newPage();
      await page.goto('http://' + DOMAIN + '/hostile.html#' + extensionId, { waitUntil: 'load' });
      await page.waitForFunction(() => !!window.atlasWallet, null, { timeout: 10000 });
      return page;
    };
    const ask = (page, nonce) => page.evaluate((n) => window.atlasWallet.requestSignature({ purpose: 'login', nonce: n }), nonce);
    const pending = (promise) => Promise.race([promise.then(() => false, () => false), sleep(2500).then(() => true)]);

    // ---- 1. the prompt is a window of its own, untouched by the page's CSS and scripts -----------------------------------
    console.log('STEP 1: a hostile page asks for a signature; the prompt opens in its own window and the page cannot touch it');
    const page1 = await hostile();
    const result1 = ask(page1, 'first-request'); result1.catch(() => {});
    const prompt1 = await BP.wait(page1, { timeout: 15000 });
    await prompt1.locator('#readyState').waitFor({ state: 'visible', timeout: 10000 });
    check('the prompt is an extension page in a window of its own', prompt1.url().startsWith('chrome-extension://' + extensionId + '/confirm-bridge.html') && prompt1 !== page1 && !(await prompt1.evaluate(() => window.top !== window)));
    const inPage = await page1.evaluate(() => ({
      frames: Array.from(document.querySelectorAll('iframe')).map((f) => f.src),
      ids: Array.from(document.querySelectorAll('[id]')).map((e) => e.id),
      added: window.__seen.added
    }));
    check('nothing of the prompt exists in the requesting page: no extension iframe, no prompt element was ever added to its DOM', !inPage.frames.some((s) => /confirm-bridge|chrome-extension/.test(s)) && !inPage.ids.some((i) => /bridge-confirm/.test(i)) && !inPage.added.some((a) => /bridge-confirm|confirm-bridge/.test(a)), inPage);
    check('the page\'s own frames never include the prompt', !page1.frames().some((f) => /confirm-bridge/.test(f.url())));
    const shown = await prompt1.evaluate(() => {
      const button = document.getElementById('approveBtn');
      const r = button.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const style = getComputedStyle(document.getElementById('card'));
      return {
        origin: document.getElementById('origin').textContent, payload: document.getElementById('payloadBox').textContent,
        reachable: top === button, cardOpacity: style.opacity, cardDisplay: style.display, cardVisibility: style.visibility, cardFilter: style.filter,
        buttonSize: [Math.round(r.width), Math.round(r.height)], htmlFilter: getComputedStyle(document.documentElement).filter
      };
    });
    check('the page\'s CSS (display, opacity, filters, transforms, pointer-events, covering layers) does not apply to the prompt', shown.reachable && shown.cardOpacity === '1' && shown.cardDisplay !== 'none' && shown.cardVisibility === 'visible' && shown.cardFilter === 'none' && shown.htmlFilter === 'none' && shown.buttonSize[0] > 40 && shown.buttonSize[1] > 20, shown);
    check('it shows the origin Chrome reports and the genuine payload', shown.origin === 'http://' + DOMAIN && /first-request/.test(shown.payload), shown);
    const shot = await prompt1.screenshot();
    check('and it is actually painted (not blank or black)', new Set(shot).size > 200 && shot.length > 4000, shot.length);
    check('forged "approved" messages, spammed at the page and every frame, do not answer the request', await pending(result1), 'the request resolved by itself');
    await prompt1.locator('#denyBtn').click();
    const r1 = await result1;
    check('only the visitor\'s own Deny ended it, as declined with no signature', r1.allowed === true && r1.result === null, r1);
    await BP.gone(page1, { timeout: 10000 });
    check('the prompt window closed itself', (await BP.count(page1)) === 0);

    // ---- 2. approving still produces a genuine signature over the genuine request ---------------------------------------
    console.log('STEP 2: approval through the same hostile page produces a genuine signature');
    const result2 = ask(page1, 'second-request'); result2.catch(() => {});
    const prompt2 = await BP.wait(page1, { timeout: 15000 });
    await prompt2.locator('#readyState').waitFor({ state: 'visible', timeout: 10000 });
    await prompt2.locator('#approveBtn').click();
    const r2 = await result2;
    const signed = r2.result && r2.result.signedPayload;
    check('the signature is from the visitor\'s identity and covers { ctx, origin, payload } of the genuine request, not the forged ones', !!r2.result && r2.result.publicKey === publicKey && signed && signed.ctx === 'atlas.bridge.sign/1' && signed.origin === 'http://' + DOMAIN && signed.payload.nonce === 'second-request' && !JSON.stringify(r2).includes('ATTACKER') && !JSON.stringify(r2).includes('forged'), r2);
    await BP.gone(page1, { timeout: 10000 });

    // ---- 3. the page cannot load the prompt page itself --------------------------------------------------------------------
    console.log('STEP 3: the page tries to load the prompt page by its extension URL');
    const fetched = await page1.evaluate(() => window.tryLoadPrompt());
    await sleep(1500);
    check('the prompt page is not a web-accessible resource: fetch is blocked', /blocked/.test(fetched), fetched);
    check('and neither an iframe nor a popup of the page\'s own can show it', !page1.frames().some((f) => /confirm-bridge\.html/.test(f.url())) && (await BP.count(page1)) === 0, page1.frames().map((f) => f.url()));
    for (const p of context.pages()) if (p !== page1 && !p.isClosed() && /chrome-error|^about:blank$/.test(p.url())) await p.close().catch(() => {});

    // ---- 4. closing the window ends the request as declined ------------------------------------------------------------------
    console.log('STEP 4: closing the prompt window, or leaving the page, ends the request without a signature');
    const result4 = ask(page1, 'closed-request'); result4.catch(() => {});
    const prompt4 = await BP.wait(page1, { timeout: 15000 });
    await prompt4.close({ runBeforeUnload: false });
    const r4 = await Promise.race([result4, sleep(10000).then(() => 'timeout')]);
    check('closing the window answers the page as declined', r4 !== 'timeout' && r4.allowed === true && r4.result === null, r4);
    const page4 = await hostile();
    const result4b = ask(page4, 'navigate-away'); result4b.catch(() => {});
    const prompt4b = await BP.wait(page4, { timeout: 15000 });
    await page4.goto('http://' + DOMAIN + '/plain.html', { waitUntil: 'load' });
    await BP.gone(page4, { timeout: 10000 }).then(() => check('navigating the page away closes its prompt', true), (e) => check('navigating the page away closes its prompt', false, e.message));
    check('and the old prompt window is closed', prompt4b.isClosed());
    await page4.close();

    // ---- 5. a page that keeps being declined cannot keep opening windows ------------------------------------------------------
    console.log('STEP 5: a page whose prompts keep being declined is refused new windows for a while (five declines in a row, then a pause)');
    await page1.reload({ waitUntil: 'load' });
    await page1.waitForFunction(() => !!window.atlasWallet, null, { timeout: 10000 });
    // The close in step 4 counted as one decline; approve once to start the count over.
    const resetResult = ask(page1, 'reset'); resetResult.catch(() => {});
    const resetPrompt = await BP.wait(page1, { timeout: 15000 });
    await resetPrompt.locator('#readyState').waitFor({ state: 'visible', timeout: 10000 });
    await resetPrompt.locator('#approveBtn').click();
    await resetResult;
    await BP.gone(page1, { timeout: 10000 });
    const answers = [];
    let opened = 0;
    for (let i = 0; i < 7; i++) {
      const started = Date.now();
      const r = ask(page1, 'spam-' + i); r.catch(() => {});
      let win = null;
      try { win = await BP.wait(page1, { timeout: i < 5 ? 15000 : 2500 }); } catch (e) { win = null; }
      if (win) {
        opened++;
        await win.locator('#denyBtn').click({ timeout: 10000 }).catch(() => {});
        await BP.gone(page1, { timeout: 10000 }).catch(() => {});
      }
      answers.push({ i, window: !!win, result: await Promise.race([r, sleep(5000).then(() => 'pending')]), ms: Date.now() - started });
    }
    check('the first declines cost nothing: the first five requests each got a window', answers.slice(0, 5).every((a) => a.window), answers);
    check('after that the page is refused new windows (answered as declined, no window)', !answers[5].window && !answers[6].window && answers[5].result && answers[5].result.result === null && answers[6].result && answers[6].result.result === null, answers);
    check('no more than the free windows were opened', opened === 5, opened);
    await sleep(5500);
    const resultAfter = ask(page1, 'after-cooldown'); resultAfter.catch(() => {});
    const promptAfter = await BP.wait(page1, { timeout: 15000 }).catch(() => null);
    check('after the cooldown the page can ask again', !!promptAfter);
    if (promptAfter) { await promptAfter.locator('#denyBtn').click().catch(() => {}); await BP.gone(page1, { timeout: 10000 }).catch(() => {}); }

    // ---- 6. a request that is refused up front never opens a window ----------------------------------------------------
    const plainRefusal = await page1.evaluate(() => window.atlasWallet.requestSignature({ purpose: 'not-on-the-list' }));
    check('a purpose the manifest does not list still gets no window at all', plainRefusal.allowed === false && (await BP.count(page1)) === 0, plainRefusal);
  } catch (e) {
    failures++;
    console.log('FAIL: ' + (e.stack || e));
  } finally {
    await context.close().catch(() => {});
    serverProc.kill();
    for (const d of [DOCROOT_DIR, STATE_DIR, PROFILE_DIR]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (err) { /* already gone */ } }
  }
  console.log(failures ? failures + ' FAILED' : 'ALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})();
