// Manual browser click-through for demo-domain-a/federation-demo.html —
// the real cross-domain Post Office federation demo (SPEC.md §11.3/
// §11.4). Unlike test/manual-federation-demo.js (which drives the same
// flow at the raw HTTP layer), this one actually loads the real page in
// a real browser and clicks through it, the same reasoning
// test/manual-reserve-bank-demo-browser.js already applies to its own
// sibling page — catching a page-script bug (a typo'd element id, an
// undeclared variable, a payload shape mismatch) that an API-level test
// structurally cannot see, since it never executes the page's own
// JavaScript.
//
// Requires two genuinely separate, already-running issuer-server
// instances — Domain A (serving the page itself) on 8185, Domain B on
// 8186 — started by this script itself, each with its own docroot,
// state folder, and generated keypair.
//
// Checks, one per act:
//   1. "Set up Alice" mints a real Post Office membership at Domain A and
//      registers a handle.
//   2. "Set up Bob" does the identical thing at Domain B — a completely
//      different origin, exercised via a genuine cross-origin fetch from
//      the page (CORS is wide open on both backends for exactly this).
//   3. Alice sends across domains through her own home domain; the page
//      shows Domain B's own signed response.
//   4. Bob checks his mail directly at Domain B and the page's own
//      client-side verify confirms the message against Domain B's own
//      freshly-fetched key, correctly attributing from.homeDomain to
//      Domain A.
//   5. Bob blocks Alice, a retry is rejected, Bob unblocks, and the next
//      send succeeds again immediately.
//   Plus: the standalone "Verify any message" panel independently
//   confirms a raw message pasted from above.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT_A = 8185; // isolated — distinct from every other manual-*.js test's chosen port
const PORT_B = 8186;
const DOMAIN_A = 'localhost:' + PORT_A;
const DOMAIN_B = 'localhost:' + PORT_B;
const BASE_A = 'http://' + DOMAIN_A;

function startNodeServer(port, domain, docroot, stateDir) {
  const proc = spawn('node', ['issuer-server/server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(port), ATLAS_DOMAIN: domain, ATLAS_STATE_DIR: stateDir, ATLAS_DOCROOT: docroot },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('issuer-server on port ' + port + ' did not start in time')), 10000);
    proc.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); resolve(proc); } });
    proc.on('exit', (code) => reject(new Error('issuer-server on port ' + port + ' exited early with code ' + code)));
  });
}

function assert(cond, message) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + message);
}

(async () => {
  const stateDirA = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-federation-browser-a-'));
  const stateDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-federation-browser-b-'));
  const docrootA = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-federation-browser-docroot-a-'));
  const docrootB = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-federation-browser-docroot-b-'));
  fs.cpSync(path.resolve(__dirname, '..', 'demo-domain-a'), docrootA, { recursive: true });
  fs.cpSync(path.resolve(__dirname, '..', 'demo-domain-b'), docrootB, { recursive: true });

  let procA, procB, browser;
  try {
    console.log('SETUP: starting two genuinely independent issuer-server instances — Domain A on ' + PORT_A + ', Domain B on ' + PORT_B);
    [procA, procB] = await Promise.all([
      startNodeServer(PORT_A, DOMAIN_A, docrootA, stateDirA),
      startNodeServer(PORT_B, DOMAIN_B, docrootB, stateDirB)
    ]);
    console.log('PASS: both instances up, serving isolated copies of demo-domain-a/demo-domain-b');

    browser = await chromium.launch({ headless: true, executablePath: '/opt/pw-browsers/chromium' });
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err));
    await page.goto(BASE_A + '/federation-demo.html', { waitUntil: 'load' });

    console.log('STEP 1: point the page at Domain B, then Act 1 — Alice joins Domain A\'s Post Office');
    await page.locator('#domainBInput').fill(DOMAIN_B);
    await page.locator('#setupAliceBtn').click();
    await page.waitForFunction(() => document.getElementById('bobPanel').style.display !== 'none', null, { timeout: 10000 });
    const aliceText = await page.locator('#aliceResult').textContent();
    assert(aliceText.includes(DOMAIN_A) && aliceText.includes('Post Office'), 'unexpected Alice setup result: ' + aliceText);
    assert(await page.locator('#aliceCard .identity').count() === 1, 'expected an Alice identity card to render');
    console.log('PASS:', aliceText);

    console.log('STEP 2: Act 2 — Bob joins Domain B\'s Post Office (a genuine cross-origin call)');
    await page.locator('#setupBobBtn').click();
    await page.waitForFunction(() => document.getElementById('sendPanel').style.display !== 'none', null, { timeout: 10000 });
    const bobText = await page.locator('#bobResult').textContent();
    assert(bobText.includes(DOMAIN_B) && bobText.includes('separate server'), 'unexpected Bob setup result: ' + bobText);
    assert(await page.locator('#bobCard .identity').count() === 1, 'expected a Bob identity card to render');
    console.log('PASS:', bobText);

    console.log('STEP 3: Act 3 — Alice sends across domains through her own home domain');
    await page.locator('#sendBtn').click();
    await page.waitForFunction(() => document.getElementById('checkPanel').style.display !== 'none', null, { timeout: 10000 });
    const sendText = await page.locator('#sendResult').textContent();
    assert(sendText.includes('Sent') && sendText.includes(DOMAIN_B), 'unexpected send result: ' + sendText);
    assert(await page.locator('#sendResult details.raw').count() === 1, 'expected a raw relay-response box');
    console.log('PASS:', sendText.match(/Sent[^.]*\./)[0]);

    console.log('STEP 4: Act 4 — Bob checks his own mail directly at Domain B, with independent verification');
    await page.locator('#checkBobMailBtn').click();
    await page.waitForFunction(() => document.getElementById('privacyPanel').style.display !== 'none', null, { timeout: 10000 });
    const checkText = await page.locator('#checkResult').textContent();
    assert(checkText.includes('alice') && checkText.includes(DOMAIN_A), 'expected the message to be attributed to alice#' + DOMAIN_A + ', got: ' + checkText);
    assert(checkText.includes('✓') && checkText.includes('signature verified'), 'expected a successful independent verification, got: ' + checkText);
    assert(checkText.includes('Confirmed'), 'expected the explicit homeDomain/handle confirmation line, got: ' + checkText);
    console.log('PASS: Bob\'s own direct check at Domain B correctly attributes and verifies the message');

    console.log('STEP 5: Act 5 — Bob blocks Alice, a retry is rejected, Bob unblocks, the next send succeeds');
    await page.locator('#blockBtn').click();
    await page.waitForFunction(() => !document.getElementById('retrySendBtn').disabled, null, { timeout: 10000 });
    await page.locator('#retrySendBtn').click();
    await page.waitForFunction(() => !document.getElementById('unblockBtn').disabled, null, { timeout: 10000 });
    const afterBlockText = await page.locator('#privacyResult').textContent();
    assert(afterBlockText.includes('Rejected') && afterBlockText.includes('not accepting mail from you'), 'expected a rejection worded like a plain non-member case, got: ' + afterBlockText);
    await page.locator('#unblockBtn').click();
    await page.waitForFunction(() => !document.getElementById('resendBtn').disabled, null, { timeout: 10000 });
    await page.locator('#resendBtn').click();
    await page.waitForFunction(() => document.getElementById('privacyResult').textContent.includes('working again'), null, { timeout: 10000 });
    const finalText = await page.locator('#privacyResult').textContent();
    assert(finalText.includes('Delivered again, immediately'), 'expected the final resend to succeed, got: ' + finalText);
    console.log('PASS: block correctly rejects, unblock correctly restores delivery immediately');

    console.log('STEP 6: independently verify a raw message pasted from Act 4\'s own raw box');
    const rawBoxDetails = page.locator('#checkResult details.raw').last();
    await rawBoxDetails.locator('summary').click();
    await rawBoxDetails.locator('button').click();
    await page.waitForFunction(() => document.getElementById('verifyResult').textContent.startsWith('✓ Valid'), null, { timeout: 10000 });
    const verifyText = await page.locator('#verifyResult').textContent();
    assert((await page.locator('#verifyDomainInput').inputValue()) === DOMAIN_B, 'expected the verify panel to auto-fill Domain B as the delivering domain');
    console.log('PASS:', verifyText);

    assert(pageErrors.length === 0, 'expected no uncaught page errors during the whole walkthrough, got: ' + pageErrors.map((e) => e.message).join(' | '));
    console.log('PASS: no uncaught page errors across the whole walkthrough');

    console.log('\nALL FEDERATION-DEMO BROWSER CHECKS PASSED against two real, independent issuer-server instances.');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    if (procA) procA.kill();
    if (procB) procB.kill();
    try { fs.rmSync(stateDirA, { recursive: true, force: true }); } catch (err) {}
    try { fs.rmSync(stateDirB, { recursive: true, force: true }); } catch (err) {}
    try { fs.rmSync(docrootA, { recursive: true, force: true }); } catch (err) {}
    try { fs.rmSync(docrootB, { recursive: true, force: true }); } catch (err) {}
  }
})();
