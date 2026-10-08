// Manual check for demo-domain-a/login-demo.html itself — the standalone,
// extension-free page's own DOM/JS wiring (test/manual-login-demo.js
// already covers the new /atlas/login/nonce and /atlas/login/verify
// endpoints' own protocol behavior at the HTTP layer; this test is what
// the PAGE does with them). Drives the real page with a headless browser,
// same "own isolated instance" reasoning every other manual-*.js test in
// this project already follows.
//
// Checks:
//   1. "Set up my demo account" issues a real atlas.demo.login.badge and
//      reveals its raw JSON plus the sign-in step.
//   2. The wrong password is rejected inline, without touching the second
//      factor at all.
//   3. The right password proceeds automatically to a successful second
//      factor, showing the exact credential name the server reported.
//   4. The "see revocation take effect live" callout appears with a
//      "Revoke my credential" button.
//   5. Clicking that button revokes the credential right on this page (no
//      admin panel involved), and clicking "Try signing in again" then
//      fails the second factor with the server's own reason, while the
//      password step is never re-asked.
//   6. "Start over" resets back to the pre-enrollment view, and a second
//      full run-through (fresh identity, fresh credential) succeeds.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NODE_PORT = 8139; // isolated — distinct from every other manual-*.js test's chosen port
const NODE_DOMAIN = 'localhost:' + NODE_PORT;
const NODE_BASE = 'http://localhost:' + NODE_PORT;

const NODE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-login-page-node-'));
const NODE_DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-login-page-docroot-'));

function assert(cond, message) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + message);
}

(async () => {
  console.log('SETUP: copying demo-domain-a into an isolated docroot and starting its own issuer-server instance on port ' + NODE_PORT);
  fs.cpSync(path.resolve(__dirname, '..', 'demo-domain-a'), NODE_DOCROOT_DIR, { recursive: true });
  const nodeProc = spawn('node', ['issuer-server/server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(NODE_PORT),
      ATLAS_DOMAIN: NODE_DOMAIN,
      ATLAS_STATE_DIR: NODE_STATE_DIR,
      ATLAS_DOCROOT: NODE_DOCROOT_DIR
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('issuer-server did not start in time')), 10000);
    nodeProc.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); resolve(); } });
    nodeProc.on('exit', (code) => reject(new Error('issuer-server exited early with code ' + code)));
  });
  console.log('PASS: isolated issuer-server up on port ' + NODE_PORT + ', serving the isolated demo-domain-a copy');

  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: '/opt/pw-browsers/chromium' });
    const page = await browser.newPage();
    await page.goto(NODE_BASE + '/login-demo.html', { waitUntil: 'load' });

    console.log('STEP 1: "Set up my demo account" issues a real login credential and reveals it');
    await page.locator('#enrollBtn').click();
    await page.waitForFunction(() => document.getElementById('credentialDetails').style.display !== 'none', null, { timeout: 10000 });
    const rawCredential = JSON.parse(await page.locator('#credentialRaw').textContent());
    assert(rawCredential.asset.class === 'atlas.demo.login.badge', 'expected the raw panel to show a genuine login badge, got: ' + JSON.stringify(rawCredential));
    assert(typeof rawCredential.id === 'string' && rawCredential.id.length > 0, 'expected a real credential id, got: ' + JSON.stringify(rawCredential));
    assert(await page.locator('#passwordPanel').isVisible(), 'expected the sign-in step to appear after enrolling');
    console.log('PASS: enrolled with a genuine, freshly issued login credential —', rawCredential.id);

    console.log('STEP 2: the wrong password is rejected inline, without touching the second factor');
    await page.locator('#usernameInput').fill('demo-user');
    await page.locator('#passwordInput').fill('not-the-password');
    await page.locator('#passwordForm button[type="submit"]').click();
    assert((await page.locator('#passwordStatus').textContent()).includes('Wrong password'), 'expected an inline wrong-password message');
    assert(!(await page.locator('#factorPanel').isVisible()), 'expected the second-factor step to stay hidden after a wrong password');
    console.log('PASS: a wrong password never reaches the second factor');

    console.log('STEP 3: the right password proceeds automatically to a successful second factor');
    await page.locator('#passwordInput').fill('atlas123');
    await page.locator('#passwordForm button[type="submit"]').click();
    await page.waitForFunction(() => (document.getElementById('factorResult').textContent || '').startsWith('✓ Welcome'), null, { timeout: 10000 });
    const successText = await page.locator('#factorResult').textContent();
    assert(successText.includes('Demo Login Credential'), 'expected the success message to name the real credential, got: ' + successText);
    assert((await page.locator('#factorResult').getAttribute('class')).includes('ok'), 'expected the ok result styling on a genuine second-factor success');
    console.log('PASS: second factor succeeds and reports the real credential name —', successText);

    console.log('STEP 4: the revocation callout shows a "Revoke my credential" button');
    assert(await page.locator('#revokeCallout').isVisible(), 'expected the "see revocation take effect live" callout to appear on success');
    assert(await page.locator('#revokeBtn').isVisible(), 'expected a self-serve revoke button, not an admin-panel link');
    console.log('PASS: revocation callout is visible, offering a self-serve revoke for id', rawCredential.id);

    console.log('STEP 5: clicking "Revoke my credential" (no admin panel involved) fails the very next second-factor attempt, with no password re-ask');
    await page.locator('#revokeBtn').click();
    await page.waitForFunction(() => (document.getElementById('revokeStatus').textContent || '').startsWith('Revoked'), null, { timeout: 10000 });
    assert(!(await page.locator('#usernameInput').isVisible()) || (await page.locator('#usernameInput').isDisabled()), 'expected the password fields to stay as they were, not reappear for re-entry');
    await page.locator('#retryFactorBtn').click();
    await page.waitForFunction(() => (document.getElementById('factorResult').textContent || '').startsWith('✗ Second factor failed'), null, { timeout: 10000 });
    const failText = await page.locator('#factorResult').textContent();
    assert(failText.includes('revoked'), 'expected the real server rejection reason to mention revocation, got: ' + failText);
    assert((await page.locator('#factorResult').getAttribute('class')).includes('err'), 'expected the err result styling once revoked');
    console.log('PASS: revoking the credential fails the next sign-in immediately —', failText);

    console.log('STEP 6: "Start over" resets the page, and a second full run-through succeeds');
    await page.locator('#resetBtn').click();
    await page.waitForFunction(() => document.getElementById('passwordPanel').style.display === 'none', null, { timeout: 5000 });
    assert(!(await page.locator('#enrollBtn').isDisabled()), 'expected "Set up my demo account" to be clickable again after Start over');
    await page.locator('#enrollBtn').click();
    await page.waitForFunction(() => document.getElementById('credentialDetails').style.display !== 'none', null, { timeout: 10000 });
    const secondCredential = JSON.parse(await page.locator('#credentialRaw').textContent());
    assert(secondCredential.id !== rawCredential.id, 'expected Start over to enroll a genuinely fresh credential, not reuse the revoked one');
    await page.locator('#usernameInput').fill('demo-user-2');
    await page.locator('#passwordInput').fill('atlas123');
    await page.locator('#passwordForm button[type="submit"]').click();
    await page.waitForFunction(() => (document.getElementById('factorResult').textContent || '').startsWith('✓ Welcome'), null, { timeout: 10000 });
    console.log('PASS: a second run-through after Start over succeeds end to end with a fresh credential —', secondCredential.id);

    console.log('\nALL LOGIN DEMO PAGE CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    nodeProc.kill();
    try { fs.rmSync(NODE_STATE_DIR, { recursive: true, force: true }); } catch (err) {}
    try { fs.rmSync(NODE_DOCROOT_DIR, { recursive: true, force: true }); } catch (err) {}
  }
})();
