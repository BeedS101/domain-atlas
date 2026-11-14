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

async function scenario(context, url, authenticatorOptions, label, attachmentChoice, testChoice) {
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
  if (testChoice) await page.selectOption('#test', testChoice);
  await page.click('#run');
  await page.waitForFunction(() => window.__probeResult, null, { timeout: 60000 });
  const report = await page.evaluate(() => window.__probeResult);
  await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: added.authenticatorId }).catch(() => {});
  await page.close();
  const summary = report.attempts.map((a) => (a.ok ? 'ok   ' : 'FAIL ') + a.attempt + (a.ok ? '' : ' -> ' + a.error + ' [' + a.failureTiming + ', ' + a.elapsedMs + 'ms]')).join('\n     ');
  console.log('INFO ' + label + ' (' + report.origin + ')\n     ' + summary + '\n     verdict: ' + JSON.stringify(report.verdict) + '\n     conclusion: ' + (report.diagnosis && report.diagnosis.conclusion));
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
    console.log('--- the probe shows its origin and is opened by the extension on install ---');
    let installTab = null;
    for (let i = 0; i < 20 && !installTab; i++) {
      installTab = context.pages().find((pg) => pg.url() === extUrl) || null;
      if (!installTab) await new Promise((r) => setTimeout(r, 250));
    }
    check('the extension opens its own probe tab on install', !!installTab, context.pages().map((pg) => pg.url()));
    {
      const pg = await context.newPage();
      await pg.goto(extUrl);
      const banner = await pg.textContent('#origin');
      const cls = await pg.getAttribute('#origin', 'class');
      check('the extension page shows its chrome-extension:// origin', banner.includes('Origin: ' + extUrl.replace('/probe.html', '')) && /ok/.test(cls), { banner, cls });
      check('the run button is enabled on the extension origin', !(await pg.isDisabled('#run')));
      await pg.close();
    }

    console.log('--- opened as a local file, the probe refuses to attempt WebAuthn ---');
    {
      const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-prf-file-'));
      for (const f of ['probe.html', 'probe.js']) fs.copyFileSync(path.join(PROBE_DIR, f), path.join(copy, f));
      const pg = await context.newPage();
      await pg.addInitScript(() => {
        window.__webauthnCalls = 0;
        if (navigator.credentials) {
          for (const m of ['create', 'get']) {
            const orig = navigator.credentials[m].bind(navigator.credentials);
            navigator.credentials[m] = (...a) => { window.__webauthnCalls++; return orig(...a); };
          }
        }
      });
      await pg.goto('file://' + path.join(copy, 'probe.html'));
      const banner = await pg.textContent('#origin');
      const cls = await pg.getAttribute('#origin', 'class');
      check('a file:// page is marked as refused', /REFUSED/.test(banner) && /bad/.test(cls) && /file:\/\//.test(banner), { banner, cls });
      check('the run button is disabled on file://', await pg.isDisabled('#run'));
      await pg.evaluate(() => document.getElementById('run').click());
      await pg.waitForTimeout(500);
      check('no WebAuthn call is made from file://', (await pg.evaluate(() => window.__webauthnCalls)) === 0);
      check('the output says no passkey test was run', /No passkey test was run/.test(await pg.textContent('#out')));
      await pg.close();
      fs.rmSync(copy, { recursive: true, force: true });
    }

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
    console.log('--- diagnostics: RP ID, ordinary registration, PRF enablement, failure timing ---');
    r = await scenario(context, extUrl, { ...platform, hasPrf: true }, 'diagnostic, internal, hasPrf');
    let d = r.report && r.report.diagnosis;
    check('rp.id is left unspecified in every request', !!(d && d.rpIdOmittedInEveryRequest && r.report.attempts.filter((a) => a.phase === 'create').every((a) => a.rpIdOmitted === true)), d);
    check('the authenticator data confirms the effective RP ID is the extension origin', !!(d && d.effectiveRpIdIsExpectedEverywhereChecked) && r.report.attempts.some((a) => a.effectiveRpIdIsExpected === true), r.report.attempts.map((a) => a.effectiveRpIdIsExpected));
    check('the expected effective RP ID for an extension page is its full origin', d && d.expectedEffectiveRpId === extUrl.replace('/probe.html', ''), d);
    check('ordinary registration is tested first and reported', d && d.ordinaryRegistration === 'works' && r.report.attempts[0].requestedExtensions.length === 0, d);
    check('PRF is tested only after ordinary registration succeeds, and reported as enabled', d && d.prfAtCreate === 'enabled', d);
    check('the diagnostic never reports PRF as working without a stable unlock', r.report.verdict.usableForWalletUnlock === true && /PRF works/.test(d.conclusion), d);

    r = await scenario(context, extUrl, { ...platform, hasPrf: false }, 'diagnostic, internal, no PRF');
    d = r.report && r.report.diagnosis;
    check('without PRF: ordinary registration works but PRF is not enabled', d && d.ordinaryRegistration === 'works' && /did not enable/.test(d.prfAtCreate), d);
    check('without PRF: the conclusion blames missing PRF support, not registration', d && /does not support PRF/.test(d.conclusion), d);
    check('without PRF: an unlock is attempted on the non-PRF passkey to confirm', r.report.attempts.some((a) => a.phase === 'unlock-on-non-prf-passkey'), r.report.attempts.map((a) => a.phase));

    r = await scenario(context, extUrl + '?timeout=4000', { ...roaming, hasPrf: true }, 'diagnostic, only a usb authenticator but platform requested, ordinary test', 'platform', 'plain');
    d = r.report && r.report.diagnosis;
    const failed = r.report && r.report.attempts[0];
    check('a failing ordinary registration records its error and timing', failed && failed.ok === false && /NotAllowedError/.test(failed.error) && ['immediate', 'after-interaction', 'timeout'].includes(failed.failureTiming) && typeof failed.elapsedMs === 'number', failed);
    check('a failing ordinary registration is not blamed on PRF', d && d.ordinaryRegistration === 'fails' && /not a PRF incompatibility/.test(d.conclusion), d);

    r = await scenario(context, extUrl + '?timeout=4000', { ...roaming, hasPrf: true }, 'diagnostic, usb authenticator with a platform request, full run', 'platform');
    d = r.report && r.report.diagnosis;
    check('the full run falls back to relaxed or default options and says which one worked', d && d.ordinaryRegistration === 'works' && /browser defaults/.test(d.ordinaryRegistrationWorkedWith || ''), d);

    r = await scenario(context, extUrl, { ...platform, hasPrf: true }, 'single test, PRF only', null, 'prf-eval');
    d = r.report && r.report.diagnosis;
    check('a PRF-only test says ordinary registration was not tested', d && d.ordinaryRegistration === 'not tested' && r.report.attempts[0].requestedExtensions[0] === 'prf', d);

    {
      const pg = await context.newPage();
      await pg.goto(extUrl);
      const cls = await pg.evaluate(() => [window.__probeFailureTiming(10), window.__probeFailureTiming(20000), window.__probeFailureTiming(59000)]);
      check('failure timing classifies immediate, after-interaction and timeout', cls.join() === 'immediate,after-interaction,timeout', cls);
      await pg.selectOption('#test', 'plain');
      check('the observed-by-user choice is hidden until a run finishes', await pg.isHidden('#observedBox'));
      await pg.close();
    }
  } finally {
    await context.close().catch(() => {});
    server.close();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (err) { /* scratch */ }
  }
  console.log(failures ? '\n' + failures + ' CHECK(S) FAILED' : '\nALL PRF PROBE CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
