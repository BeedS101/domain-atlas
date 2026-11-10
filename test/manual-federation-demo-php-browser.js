// Browser click-through of the federation demo (demo-domain-a/federation-demo.html, the same page as demo-domain-b's) against two real,
// independent issuer-php instances, each its own php -S with its own key and state, laid out like the deployed domains. It is the PHP
// counterpart of test/manual-federation-demo-browser.js: Alice joins one domain, Bob joins the other (a cross-origin mint the two domains
// accept from each other for a Post Office membership only), Alice sends across, Bob checks and verifies, blocks and unblocks.
//
//   xvfb-run -a node test/manual-federation-demo-php-browser.js
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { startPhp } = require('./lib/gen1-issuers');

const REPO = path.resolve(__dirname, '..');
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
function assert(cond, message) { if (!cond) throw new Error('ASSERTION FAILED: ' + message); }
// php -S ignores .htaccess, so this router does what .well-known/.htaccess does on the deployed hosts: public files there are served with a
// cross-origin header, which is how the page fetches the other domain's published key. Everything else goes through the usual test router.
const ROUTER = "<?php\n$u = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH); $f = __DIR__ . $u;\n" +
  "if (strpos($u, '/.well-known/') === 0 && is_file($f)) { header('Access-Control-Allow-Origin: *'); header('Content-Type: application/json'); readfile($f); return true; }\n" +
  "return require __DIR__ . '/test-router.php';\n";
const serve = (port, site, env) => startPhp(port, { env, router: 'federation-router.php', prepare: (bundle) => { fs.cpSync(path.join(REPO, site), bundle, { recursive: true, filter: (src) => !/[\\/]\.well-known([\\/]|$)/.test(src) }); fs.writeFileSync(path.join(bundle, 'federation-router.php'), ROUTER); } });

(async () => {
  const PORT_A = await freePort(), PORT_B = await freePort();
  const DOMAIN_A = '127.0.0.1:' + PORT_A, DOMAIN_B = '127.0.0.1:' + PORT_B;
  const BASE_A = 'http://' + DOMAIN_A;
  const env = { ATLAS_FEDERATION_MINT_ORIGINS: 'http://' + DOMAIN_A + ',http://' + DOMAIN_B };
  let a, b, browser;
  try {
    a = await serve(PORT_A, 'demo-domain-a', env);
    b = await serve(PORT_B, 'demo-domain-b', env);
    console.log('PASS: two independent issuer-php instances up, serving demo-domain-a and demo-domain-b');
    browser = await chromium.launch();
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

    console.log('\nALL FEDERATION-DEMO PHP BROWSER CHECKS PASSED against two real, independent issuer-php instances.');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    for (const be of [a, b]) try { be.stop(); } catch (err) { /* already gone */ }
  }
})();
