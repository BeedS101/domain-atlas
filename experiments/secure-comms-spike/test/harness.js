// Shared helpers for the secure-comms spike experiments (Chromium via Playwright).
// Run under a virtual display:  xvfb-run -a node test/<script>.js
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || '/home/claude/.npm-global/lib/node_modules/playwright');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const SERVER_JS = path.resolve(__dirname, '..', 'server', 'signaling-server.js');

const lite = require('./harness-lite');
const { check, observe, counts, observations } = lite;
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function until(fn, timeoutMs, stepMs) {
  const end = Date.now() + (timeoutMs || 15000);
  for (;;) {
    let v; try { v = await fn(); } catch (e) { v = false; }
    if (v) return v;
    if (Date.now() > end) return false;
    await sleep(stepMs || 100);
  }
}

const spawned = [];
process.on('exit', () => { for (const c of spawned) { try { c.kill('SIGKILL'); } catch (e) { /* gone */ } } });
function startServer(port) {
  const child = spawn(process.execPath, [SERVER_JS, String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
  spawned.push(child);
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { if (String(d).includes('on http')) resolve(child); });
    child.on('exit', (c) => reject(new Error('server exited ' + c)));
    setTimeout(() => reject(new Error('server start timeout')), 5000);
  });
}
async function relay(base, pathName, body) {
  const res = await fetch(base + pathName, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return res.json();
}

// One browser context (own profile = an independent "wallet user") with the spike extension loaded.
async function launch(label, extraArgs, opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-' + label + '-'));
  const args = [
    '--disable-extensions-except=' + EXT_PATH, '--load-extension=' + EXT_PATH, '--no-sandbox',
    '--use-fake-device-for-media-stream'
  ].concat((opts && opts.noFakeUi) ? [] : ['--use-fake-ui-for-media-stream']).concat(extraArgs || []);
  const context = await chromium.launchPersistentContext(dir, { headless: false, executablePath: '/opt/pw-browsers/chromium', args, viewport: null });
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  return { context, sw, extId, dir, label, close: async () => { try { await context.close(); } catch (e) { /* closed */ } fs.rmSync(dir, { recursive: true, force: true }); } };
}

// Open a call window through the extension's own openCallWindow() and return its Page.
async function openCall(b, params) {
  const known = new Set(b.context.pages());
  const pagePromise = b.context.waitForEvent('page', { timeout: 15000 });
  const info = await b.sw.evaluate((p) => globalThis.openCallWindow(p), params);
  const page = await pagePromise;
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => window.__spike && window.__spike.idPub, null, { timeout: 15000 });
  page.on('pageerror', (e) => console.log('  [pageerror ' + b.label + '] ' + e.message));
  return { page, info };
}

async function pairKeys(a, b) {
  const ka = await a.page.evaluate(() => window.__spike.idPub);
  const kb = await b.page.evaluate(() => window.__spike.idPub);
  await a.page.evaluate((k) => window.__spike.setPeerKey(k), kb);
  await b.page.evaluate((k) => window.__spike.setPeerKey(k), ka);
}
const spikeState = (p) => p.evaluate(() => window.__spike.state);
const spikeGet = (p, expr) => p.evaluate(new Function('return (' + expr + ')'));
const eventsOf = (p) => p.evaluate(() => window.__spike.events.map((e) => e.name + (e.data && typeof e.data === 'string' ? ':' + e.data : '')));

const finish = (name) => lite.finish(name, 'Chromium (Playwright bundled, headed under Xvfb)');

// Chromium started directly (no Playwright, no debugger attached). A debugger keeps extension service
// workers alive, so lifetime experiments must run without one; observations come back through the relay.
function extensionIdForPath(p) {
  const hex = require('crypto').createHash('sha256').update(fs.realpathSync(p)).digest('hex').slice(0, 32);
  return hex.split('').map((c) => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16))).join('');
}
function prepareExtensionCopy(startup) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-ext-'));
  fs.cpSync(EXT_PATH, dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'startup.json'), JSON.stringify(startup));
  return dir;
}
function launchRaw(urls, extraArgs, extDir) {
  const ext = extDir || EXT_PATH;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-raw-'));
  const args = ['--user-data-dir=' + dir, '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--disable-extensions-except=' + ext, '--load-extension=' + ext, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--disable-features=DisableLoadExtensionCommandLineSwitch', '--enable-logging=stderr'].concat(extraArgs || []).concat(urls);
  const child = spawn('/opt/pw-browsers/chromium', args, { stdio: ['ignore', 'ignore', process.env.RAW_LOG ? 'inherit' : 'ignore'] });
  return { child, dir, close: async () => { try { child.kill('SIGKILL'); } catch (e) { /* gone */ } await sleep(500); fs.rmSync(dir, { recursive: true, force: true }); } };
}
async function readObs(base, room, me) { return (await relay(base, '/__test/obs-get', { room, me })).list; }
async function pollMailbox(base, room, me, after) { return (await relay(base, '/poll', { room, me, after: after || 0, waitMs: 1000 })).events; }

module.exports = { prepareExtensionCopy, extensionIdForPath, launchRaw, readObs, pollMailbox, chromium, EXT_PATH, check, observe, sleep, until, startServer, relay, launch, openCall, pairKeys, spikeState, spikeGet, eventsOf, finish, counts, observations };
