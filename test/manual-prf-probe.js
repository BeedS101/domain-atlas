// WebAuthn PRF probe (docs/unlock-methods.md, phase 1), sandbox half. Runs tools/prf-probe in a scratch Chromium
// profile against Chrome's virtual authenticator, from an extension page and, for comparison, from a localhost
// page; with and without a PRF-capable authenticator. No wallet, issuer or live site is involved.
//
// Run with a display, e.g.:  xvfb-run -a node test/manual-prf-probe.js

const { chromium } = require('playwright');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');

const PROBE_DIR = path.resolve(__dirname, '..', 'tools', 'prf-probe');
let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' :: ' + JSON.stringify(detail)));
  if (!ok) failures++;
}

async function scenario(context, url, authenticatorOptions, label, attachmentChoice) {
  const page = await context.newPage();
  await page.goto(url);
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  let added = null;
  let addError = null;
  try {
    added = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: authenticatorOptions });
  } catch (err) {
    addError = String(err.message || err);
  }
  if (addError) {
    console.log('INFO ' + label + ': the virtual authenticator rejected these options: ' + addError);
    await page.close();
    return { addError };
  }
  if (attachmentChoice) await page.selectOption('#attachment', attachmentChoice);
  await page.click('#run');
  await page.waitForFunction(() => window.__probeResult, null, { timeout: 60000 });
  const report = await page.evaluate(() => window.__probeResult);
  await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: added.authenticatorId }).catch(() => {});
  await page.close();
  const summary = report.steps.map((s) => (s.ok ? 'ok   ' : 'FAIL ') + s.step + (s.ok ? '' : ' -> ' + s.error)).join('\n     ');
  const env = report.steps[0] && report.steps[0].detail;
  console.log('INFO ' + label + ' environment: ' + JSON.stringify(env));
  console.log('INFO ' + label + ' (' + report.origin + ')\n     ' + summary + '\n     verdict: ' + JSON.stringify(report.verdict));
  return { report };
}

(async () => {
  const server = http.createServer((req, res) => {
    const name = req.url === '/' ? 'probe.html' : req.url.slice(1);
    const file = path.join(PROBE_DIR, path.basename(name));
    if (!fs.existsSync(file) || !/\.(html|js)$/.test(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html' : 'text/javascript' });
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(8251, r));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-prf-probe-'));
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [`--disable-extensions-except=${PROBE_DIR}`, `--load-extension=${PROBE_DIR}`, '--no-sandbox']
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
    const extUrl = 'chrome-extension://' + worker.url().split('/')[2] + '/probe.html';
    const base = { protocol: 'ctap2', ctap2Version: 'ctap2_1', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true };
    const platform = { ...base, transport: 'internal' };
    const roaming = { ...base, transport: 'usb' };

    console.log('--- extension page, platform-style authenticator with PRF ---');
    let r = await scenario(context, extUrl, { ...platform, hasPrf: true }, 'extension page, internal, hasPrf');
    check('the virtual authenticator accepts hasPrf', !r.addError, r.addError);
    check('PRF is usable for wallet unlock from an extension page', !!(r.report && r.report.verdict && r.report.verdict.usableForWalletUnlock), r.report && r.report.verdict);

    console.log('--- the same from a localhost web page, for comparison ---');
    r = await scenario(context, 'http://localhost:8251/', { ...platform, hasPrf: true }, 'web page, internal, hasPrf');
    check('PRF is usable from a web page too', !!(r.report && r.report.verdict && r.report.verdict.usableForWalletUnlock), r.report && r.report.verdict);

    console.log('--- a security-key-style authenticator ---');
    r = await scenario(context, extUrl, { ...roaming, hasPrf: true }, 'extension page, usb, hasPrf', 'cross-platform');
    check('PRF is usable with a roaming authenticator', !!(r.report && r.report.verdict && r.report.verdict.usableForWalletUnlock), r.report && r.report.verdict);

    console.log('--- an authenticator without PRF must be detected, not assumed ---');
    r = await scenario(context, extUrl, { ...platform, hasPrf: false }, 'extension page, internal, no PRF');
    check('without PRF the probe reports it is unusable', !!(r.report && r.report.verdict && r.report.verdict.usableForWalletUnlock === false), r.report && r.report.verdict);

    console.log('--- user verification that cannot be satisfied must fail cleanly ---');
    r = await scenario(context, extUrl, { ...platform, hasPrf: true, isUserVerified: false }, 'extension page, internal, hasPrf, user not verified');
    check('with user verification required and not given, nothing is usable', !!(r.report && r.report.verdict && r.report.verdict.usableForWalletUnlock === false), r.report && r.report.verdict);
  } finally {
    await context.close().catch(() => {});
    server.close();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (err) { /* scratch */ }
  }
  console.log(failures ? '\n' + failures + ' CHECK(S) FAILED' : '\nALL PRF PROBE CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
