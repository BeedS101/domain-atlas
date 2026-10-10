// Web pages cannot start, answer, sign for or even load the calling window.
//
// A throwaway domain whose manifest whitelists the signing purpose "login" stands for a hostile
// website that has been given the ordinary wallet-bridge permission. The test checks that such a
// page still cannot get a signature over any atlas.call.* payload, cannot reach the calling window
// by message, frame, fetch or window.open, and that the calling window refuses runtime messages
// that do not come from an extension page. Ordinary bridge signing keeps working.
//
// Run: xvfb-run -a node test/manual-call-bridge.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || '/home/claude/.npm-global/lib/node_modules/playwright');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const PORT = 8205;
const DOMAIN = 'localhost:' + PORT;
const DOCROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-callbridge-docroot-'));
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-callbridge-state-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-callbridge-profile-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passes = 0, failures = 0;
const check = (name, ok, detail) => { if (ok) { passes++; console.log('PASS ' + name); } else { failures++; console.log('FAIL ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : '')); } };

const SPATIAL = {
  spec: 'domain-atlas/1.0', domain: DOMAIN, owner: { name: 'Call Bridge Test Domain', contact: 'demo@localhost' },
  walletBridge: { read: true, sign: ['login'] },
  defaultWorld: 'lobby',
  worlds: [{ id: 'lobby', name: 'Lobby', entry: { scene: '/spatial/lobby/scene.json', renderer: ['procedural-v1'] }, policy: { guestAccess: 'open', discoverable: true, identityRequired: false, itemDropsAllowed: false, acceptedItemClasses: [], trustedIssuers: 'any' } }],
  updated: '2026-10-02T00:00:00Z'
};

(async () => {
  fs.mkdirSync(path.join(DOCROOT, '.well-known'), { recursive: true });
  fs.mkdirSync(path.join(DOCROOT, 'spatial', 'lobby'), { recursive: true });
  fs.writeFileSync(path.join(DOCROOT, '.well-known', 'spatial.json'), JSON.stringify(SPATIAL));
  fs.writeFileSync(path.join(DOCROOT, 'spatial', 'lobby', 'scene.json'), JSON.stringify({ format: 'procedural-v1', floor: { size: [10, 10], color: '#1b2830' }, objects: [], portalMarkers: [], anchors: [] }));
  fs.writeFileSync(path.join(DOCROOT, 'page.html'), '<!doctype html><html><head><meta charset="utf-8"><title>Hostile page</title><link rel="spatial" href="/.well-known/spatial.json"></head><body>x</body></html>');
  const server = spawn('node', ['issuer-server/server.js'], { cwd: path.resolve(__dirname, '..'), env: Object.assign({}, process.env, { PORT: String(PORT), ATLAS_DOMAIN: DOMAIN, ATLAS_STATE_DIR: STATE, ATLAS_DOCROOT: DOCROOT }), stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error('server did not start')), 10000); server.stdout.on('data', (d) => { if (String(d).includes('listening')) { clearTimeout(t); resolve(); } }); server.on('exit', (c) => reject(new Error('server exited ' + c))); });

  const context = await chromium.launchPersistentContext(PROFILE, { headless: false, executablePath: '/opt/pw-browsers/chromium', args: ['--disable-extensions-except=' + EXT_PATH, '--load-extension=' + EXT_PATH, '--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  try {
    let sw = context.serviceWorkers()[0];
    if (!sw) sw = await context.waitForEvent('serviceworker');
    const extId = new URL(sw.url()).host;
    const me = await sw.evaluate(() => AtlasWallet.createIdentity('call-bridge-test-pw').then((r) => r.publicKey));

    // The calling window is open, available to nobody, so any effect of a page would be visible there.
    const popup = context.waitForEvent('page');
    await sw.evaluate(() => chrome.windows.create({ url: chrome.runtime.getURL('call.html'), type: 'popup' }));
    const callPage = await popup;
    await callPage.waitForFunction(() => window.__atlasCall && window.__atlasCall.snapshot);

    const page = await context.newPage();
    await page.goto('http://' + DOMAIN + '/page.html', { waitUntil: 'load' });
    await page.waitForFunction(() => window.atlasWallet);

    // ---- signing bridge ----
    const sig = (payload) => page.evaluate((p) => window.atlasWallet.requestSignature(p), payload);
    const overlay = () => page.locator('#domain-atlas-bridge-confirm').count();
    const attempts = [
      ['a call invite', { purpose: 'login', type: 'atlas.call.invite', callId: 'x' }],
      ['a call signal nested inside an allowed purpose', { purpose: 'login', data: { nested: [{ type: 'atlas.call.signal', kind: 'accept' }] } }],
      ['a listening-session delegation', { purpose: 'login', type: 'atlas.call.listen-session', sessionKey: 'k' }],
      ['a tag creation', { purpose: 'login', type: 'atlas.call.tag' }],
      ['a call payload with the type as a key', { purpose: 'login', 'atlas.call.tag': 1 }],
      ['a contact card', { purpose: 'login', type: 'atlas.call.card' }]
    ];
    for (const [name, payload] of attempts) {
      const r = await sig(payload);
      check('the signing bridge refuses ' + name + ' without any prompt', r && r.allowed === false && r.result === null && (await overlay()) === 0, r);
    }

    // The ordinary purpose still reaches the confirmation prompt, so the refusal above is specific.
    const ordinary = page.evaluate(() => window.atlasWallet.requestSignature({ purpose: 'login', nonce: 'n1' }));
    ordinary.catch(() => {});
    await page.waitForSelector('#domain-atlas-bridge-confirm', { timeout: 10000 });
    check('an ordinary whitelisted purpose still shows the confirmation prompt', true);
    await page.frameLocator('#domain-atlas-bridge-confirm').locator('#denyBtn').click();
    const ordinaryResult = await ordinary;
    check('and a Deny still ends it with no signature', ordinaryResult.allowed === true && ordinaryResult.result === null, ordinaryResult);

    // The wallet's own signing function refuses the same payloads, independent of the bridge.
    const direct = await sw.evaluate(async () => {
      const out = {};
      for (const [k, p] of Object.entries({ invite: { type: 'atlas.call.invite', x: 1 }, nested: { a: { type: 'atlas.call.signal' } }, plain: { purpose: 'login', n: 1 } })) {
        try { await AtlasWallet.signWithSelf(p); out[k] = 'signed'; } catch (e) { out[k] = 'refused'; }
      }
      return out;
    });
    check('the wallet\'s general signing function refuses call payloads and still signs ordinary ones', direct.invite === 'refused' && direct.nested === 'refused' && direct.plain === 'signed', direct);

    // ---- other ways a page might reach the window ----
    const reach = await page.evaluate(async (id) => {
      const out = {};
      try { out.runtime = typeof chrome === 'undefined' || !chrome.runtime || typeof chrome.runtime.sendMessage !== 'function' ? 'no-api' : await Promise.race([chrome.runtime.sendMessage(id, { type: 'atlas-call-ui', action: 'dial', key: 'x' }).then((r) => 'answered:' + JSON.stringify(r), (e) => 'rejected'), new Promise((r) => setTimeout(() => r('timeout'), 3000))]); } catch (e) { out.runtime = 'threw'; }
      try { const r = await fetch('chrome-extension://' + id + '/call.html'); out.fetch = 'status:' + r.status; } catch (e) { out.fetch = 'blocked'; }
      return out;
    }, extId);
    check('a page cannot send runtime messages to the extension', ['no-api', 'rejected', 'threw', 'timeout'].includes(reach.runtime), reach);
    check('a page cannot fetch the calling window', reach.fetch === 'blocked', reach);

    await page.evaluate((id) => { const f = document.createElement('iframe'); f.src = 'chrome-extension://' + id + '/call.html'; f.id = 'probe'; document.body.appendChild(f); }, extId);
    await sleep(1500);
    const framed = page.frames().filter((f) => f.url().includes('/call.html'));
    let loaded = false;
    for (const f of framed) { try { loaded = loaded || await f.evaluate(() => !!window.__atlasCall); } catch (e) { /* not reachable */ } }
    check('a page cannot load the calling window in a frame', !loaded, framed.map((f) => f.url()));

    const opened = page.waitForEvent('popup', { timeout: 2500 }).catch(() => null);
    await page.evaluate((id) => { window.open('chrome-extension://' + id + '/call.html'); }, extId);
    const pop = await opened;
    let popLoaded = false;
    if (pop) { await sleep(800); try { popLoaded = await pop.evaluate(() => !!window.__atlasCall); } catch (e) { popLoaded = false; } }
    check('a page cannot open the calling window with window.open', !popLoaded);

    // Messages in the bridge's own format: only the three documented actions exist.
    const bridgeReplies = await page.evaluate(() => new Promise((resolve) => {
      const replies = [];
      window.addEventListener('message', (e) => { if (e.data && e.data.__atlasBridge && e.data.direction === 'to-page') replies.push(e.data); });
      for (const [i, action] of ['startCall', 'dial', 'answer', 'atlas-call-ui', 'signCall'].entries()) window.postMessage({ __atlasBridge: true, direction: 'to-content', requestId: 900 + i, action, payload: { key: 'x' } }, location.origin);
      setTimeout(() => resolve(replies), 1500);
    }));
    check('call actions sent in the bridge\'s message format get no useful answer', bridgeReplies.every((r) => !r.result || r.result.allowed === false || r.result.allowed === undefined), bridgeReplies);

    // The page's attempts changed nothing in the calling window.
    const snap = await callPage.evaluate(() => window.__atlasCall.snapshot());
    check('after all that the calling window is untouched: no call, not listening', snap.call === null && !snap.listening && snap.selected === null, snap);
    check('and it has not asked for the microphone', (await callPage.evaluate(() => (window.__atlasCall.history || []).length)) === 0);

    // ---- the window refuses runtime messages that do not come from an extension page ----
    const senders = await callPage.evaluate(() => {
      const t = window.__atlasCall.trustedSender, id = chrome.runtime.id, base = chrome.runtime.getURL('');
      return {
        webPage: t({ id, url: 'http://evil.example/page.html', tab: { id: 1 } }),
        contentScript: t({ id, url: 'http://localhost:8205/page.html', tab: { id: 1 }, frameId: 0 }),
        otherExtension: t({ id: 'abcdefghijklmnopabcdefghijklmnop', url: base + 'viewer.html' }),
        noUrl: t({ id }),
        nothing: t(undefined),
        viewer: t({ id, url: base + 'viewer.html' }),
        background: t({ id, url: base + 'background.js' })
      };
    });
    check('only senders from this extension\'s own pages are trusted', !senders.webPage && !senders.contentScript && !senders.otherExtension && !senders.noUrl && !senders.nothing && senders.viewer && senders.background, senders);
    const real = await sw.evaluate(() => chrome.runtime.sendMessage({ type: 'atlas-call-ui', action: 'ping' }).catch(() => null));
    check('a message from the extension itself is answered', !!real && real.ok === true, real);
  } catch (e) {
    check('test run completed', false, String(e && e.stack || e));
  } finally {
    await context.close().catch(() => {});
    server.kill();
    for (const d of [DOCROOT, STATE, PROFILE]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* gone */ } }
  }
  console.log('\nmanual-call-bridge: ' + passes + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
})();
