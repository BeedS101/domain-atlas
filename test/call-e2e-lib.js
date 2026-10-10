// Helpers for the browser-level call tests: real Chromium profiles with the extension loaded,
// a Call Service running in this process on loopback, and two wallets that are contacts of each
// other with calling permission exchanged through the real Post Office on a local domain.
// Needs the local demo domain on 8002 (see test/manual-call-e2e.js for how to start it).
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || '/home/claude/.npm-global/lib/node_modules/playwright');
const { createCallService } = require(path.join(__dirname, '..', 'call-server', 'server.js'));

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const MAIL_DOMAIN = 'localhost:8002';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passes = 0, failures = 0;
const failed = [];
function check(name, ok, detail) {
  if (ok) { passes++; console.log('PASS ' + name); }
  else { failures++; failed.push(name); console.log('FAIL ' + name + (detail !== undefined ? ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}
function finish(label) {
  console.log('\n' + label + ': ' + passes + ' passed, ' + failures + ' failed');
  if (failures) console.log('Failed: ' + failed.join(' | '));
  return failures ? 1 : 0;
}
async function until(fn, timeoutMs, stepMs) {
  const end = Date.now() + (timeoutMs || 15000);
  for (;;) {
    let v; try { v = await fn(); } catch (e) { v = false; }
    if (v) return v;
    if (Date.now() > end) return false;
    await sleep(stepMs || 100);
  }
}
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

async function domainKey() {
  const r = await fetch('http://' + MAIL_DOMAIN + '/.well-known/atlas-key.json');
  const j = await r.json();
  return j.keys[j.keys.length - 1].publicKey;
}

async function startCallService(over, opts) {
  const port = await freePort();
  const cfg = Object.assign({
    configured: true, origin: 'http://127.0.0.1:' + port, domain: MAIL_DOMAIN, issuerKeys: [await domainKey()], revocationsUrl: null,
    stateFile: null, stunUrls: [], bind: '127.0.0.1', port, trustProxy: false, devAllowHttp: true, devAllowPrivateFetch: true
  }, over || {});
  const svc = createCallService(cfg, Object.assign({ quiet: true }, opts || {}));
  await svc.listen();
  return { svc, cfg, origin: cfg.origin, close: () => svc.close() };
}

async function launchWallet(label, opts) {
  opts = opts || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-call-' + label + '-'));
  const args = ['--disable-extensions-except=' + EXT_PATH, '--load-extension=' + EXT_PATH, '--no-sandbox', '--use-fake-device-for-media-stream']
    .concat(opts.denyMic ? ['--deny-permission-prompts'] : (opts.prompt ? [] : ['--use-fake-ui-for-media-stream']))
    .concat(opts.args || []);
  const context = await chromium.launchPersistentContext(dir, { headless: false, executablePath: '/opt/pw-browsers/chromium', args, viewport: null });
  if (typeof opts.init === 'function') await context.addInitScript(opts.init);
  // Records, for every microphone request and every attach/detach of a track to the connection,
  // how far the call had got at that moment.
  await context.addInitScript(() => {
    if (!/\/call\.html/.test(location.pathname)) return;
    window.__trace = [];
    const snap = () => {
      const h = window.__atlasCall, c = h && h.getCall && h.getCall();
      return c ? { state: c.state, role: c.role, ownConfirmed: !!c.ownConfirmed, peerConfirmed: !!c.peerConfirmed, certOk: !!c.remoteCertVerified, audioOn: !!c.audioOn } : { state: null };
    };
    const rt = RTCRtpSender.prototype.replaceTrack;
    RTCRtpSender.prototype.replaceTrack = function (t) { window.__trace.push(Object.assign({ ev: 'replaceTrack', track: t ? t.kind : null, t: Date.now() }, snap())); return rt.call(this, t); };
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (c) => { window.__trace.push(Object.assign({ ev: 'getUserMedia', t: Date.now() }, snap())); return gum(c); };
  });
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  const w = { label, context, sw, extId, dir, pub: null, callPage: null, errors: [] };
  w.close = async () => { try { await context.close(); } catch (e) { /* closed */ } fs.rmSync(dir, { recursive: true, force: true }); };
  // Runs code with AtlasWallet in the extension's background context.
  w.wallet = (fn, arg) => sw.evaluate(fn, arg);
  w.create = async (password) => {
    const r = await sw.evaluate((pw) => AtlasWallet.createIdentity(pw), password || (label + '-test-password'));
    w.pub = r.publicKey;
    await sw.evaluate((d) => AtlasWallet.mintAsset('self', d, 'atlas.postoffice.membership'), MAIL_DOMAIN);
    return w.pub;
  };
  w.openCallWindow = async (hash) => {
    const pagePromise = context.waitForEvent('page', { timeout: 15000 });
    await sw.evaluate((u) => chrome.windows.create({ url: chrome.runtime.getURL('call.html') + (u || ''), type: 'popup', width: 440, height: 700 }), hash || '');
    const page = await pagePromise;
    page.on('pageerror', (e) => { w.errors.push(e.message); console.log('  [pageerror ' + label + '] ' + e.message); });
    await page.waitForFunction(() => window.__atlasCall && window.__atlasCall.snapshot, null, { timeout: 15000 });
    w.callPage = page;
    return page;
  };
  w.snap = () => w.callPage.evaluate(() => window.__atlasCall.snapshot());
  w.screen = () => w.callPage.evaluate(() => [...document.querySelectorAll('[id^=screen]')].filter((e) => !e.hidden).map((e) => e.id).join(','));
  w.trace = () => w.callPage.evaluate(() => window.__trace);
  w.log = () => w.callPage.evaluate(() => window.__atlasCall.log.map((l) => l.name + (l.data !== null && l.data !== undefined ? ':' + (typeof l.data === 'string' ? l.data : JSON.stringify(l.data)) : '')));
  w.teardown = () => w.callPage.evaluate(() => window.__atlasCall.lastTeardown);
  w.setTimers = (t) => w.callPage.evaluate((x) => Object.assign(window.__atlasCall.timers, x), t);
  w.available = async () => { await w.callPage.click('#btnAvailable'); return until(async () => (await w.snap()).listening, 10000); };
  w.dnd = async () => { await w.callPage.click('#btnDnd'); return until(async () => !(await w.snap()).listening, 10000); };
  w.stats = () => w.callPage.evaluate(async () => { const c = window.__atlasCall.getCall(); const out = { inBytes: 0, outBytes: 0 }; if (!c || !c.pc) return out; (await c.pc.getStats()).forEach((x) => { if (x.type === 'inbound-rtp' && x.kind === 'audio') out.inBytes = x.bytesReceived; if (x.type === 'outbound-rtp' && x.kind === 'audio') out.outBytes = x.bytesSent; }); return out; });
  w.callState = async () => { const s = await w.snap(); return s.call ? s.call.state : 'none'; };
  w.dial = async (name) => {
    await w.callPage.locator('#contacts .contact', { hasText: name }).locator('button', { hasText: 'Call' }).first().click();
    await w.callPage.waitForSelector('#btnStart:not([hidden])', { timeout: 5000 });
    await w.callPage.click('#btnStart');
  };
  w.text = () => w.callPage.evaluate(() => document.body.innerText);
  return w;
}

// Two wallets, contacts of each other, one service, permission both ways.
async function makePair(service, opts) {
  const alice = await launchWallet('alice', opts && opts.alice);
  const bob = await launchWallet('bob', opts && opts.bob);
  await alice.create(); await bob.create();
  const addr = (h) => ({ handle: h, domain: MAIL_DOMAIN });
  await alice.wallet(([k, a]) => AtlasWallet.addFriend(k, 'Bob', a), [bob.pub, addr('bob')]);
  await bob.wallet(([k, a]) => AtlasWallet.addFriend(k, 'Alice', a), [alice.pub, addr('alice')]);
  for (const w of [alice, bob]) await w.wallet((s) => AtlasWallet.setCallConfig({ service: s, devAllowHttp: true }), service.origin);
  if (!opts || opts.grant !== false) {
    await alice.wallet((k) => AtlasWallet.grantCalling(k), bob.pub);
    await bob.wallet((k) => AtlasWallet.grantCalling(k), alice.pub);
    for (const w of [alice, bob]) {
      await until(async () => { await w.wallet(() => AtlasWallet.checkAllMail()); const c = await w.wallet(() => AtlasWallet.getCallContacts()); return c.length && c[0].canCall; }, 15000, 500);
    }
  }
  return { alice, bob };
}

module.exports = { check, finish, sleep, until, freePort, startCallService, launchWallet, makePair, MAIL_DOMAIN, EXT_PATH, domainKey };
