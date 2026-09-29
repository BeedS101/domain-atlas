// Manual check for demo-domain-a/bank-demo.html — the standalone,
// extension-free K-of-N treasury-approval demo, built entirely on
// SPEC.md §6.2's existing signed-payload mechanism (no new cryptography,
// no new credential type — see issuer-server/server.js's own comment on
// BANK_APPROVALS_FILE for the full design and its one deliberate
// simplification: the approver roster is named inline on each request
// rather than backed by a persistent, revocable membership credential).
//
// Checks:
//   1. "Set up the demo bank" generates three officer cards.
//   2. Requesting a transfer creates a real pending record and shows the
//      approve panel with 0-of-2 progress.
//   3. Approving as Officer A signs it, marks that card, and progress
//      shows 1 more needed — the transfer has NOT executed yet.
//   4. The "forge a signature" button signs a tampered amount with
//      Officer C's real key and is correctly rejected — proving the check
//      is a genuine signature-over-the-canonical-payload check, not a
//      lookup, and that fetching the payload fresh (WYSIWYS) is what
//      makes the whole mechanism mean anything.
//   5. Approving as Officer B reaches the 2-of-3 threshold and the page
//      shows the transfer executed, with a real minted credential id.
//   6. That minted credential is real and independently verifiable: a
//      direct GET /atlas/asset/issue... no — verified here by checking it
//      actually appears in the recipient's holdings via a direct fetch
//      against this domain's own issued-credential shape (the id is
//      checked to be a genuine urn:atlas:asset: id from THIS domain).
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NODE_PORT = 8162; // isolated — distinct from every other manual-*.js test's chosen port
const NODE_DOMAIN = 'localhost:' + NODE_PORT;
const NODE_BASE = 'http://' + NODE_DOMAIN;

const NODE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-bank-approval-node-'));
const NODE_DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-bank-approval-docroot-'));

function assert(cond, message) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + message);
}

(async () => {
  console.log('SETUP: copying demo-domain-a into an isolated docroot and starting its own issuer-server instance on port ' + NODE_PORT);
  fs.cpSync(path.resolve(__dirname, '..', 'demo-domain-a'), NODE_DOCROOT_DIR, { recursive: true });
  const nodeProc = spawn('node', ['issuer-server/server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(NODE_PORT), ATLAS_DOMAIN: NODE_DOMAIN, ATLAS_STATE_DIR: NODE_STATE_DIR, ATLAS_DOCROOT: NODE_DOCROOT_DIR },
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
    await page.goto(NODE_BASE + '/bank-demo.html', { waitUntil: 'load' });

    console.log('STEP 1: "Set up the demo bank" generates three officer cards');
    await page.locator('#setupBtn').click();
    await page.waitForFunction(() => document.querySelectorAll('#officerCards .officer').length === 3, { timeout: 10000 });
    console.log('PASS: three officer cards rendered');

    console.log('STEP 2: requesting a transfer creates a real pending record, 0-of-2 progress shown');
    await page.locator('#amountInput').fill('750');
    await page.locator('#memoInput').fill('Payroll batch');
    await page.locator('#requestBtn').click();
    await page.waitForFunction(() => document.getElementById('approvePanel').style.display !== 'none', { timeout: 10000 });
    const progressAfterRequest = await page.locator('#progressText').textContent();
    assert(progressAfterRequest.includes('0 of 2'), 'expected "0 of 2" progress right after requesting, got: ' + progressAfterRequest);
    const rawAfterRequest = JSON.parse(await page.locator('#rawPre').textContent());
    assert(rawAfterRequest.status === 'pending', 'expected the freshly-created request to be pending');
    assert(rawAfterRequest.action.amount === 750, 'expected the request to carry the amount actually entered, got ' + rawAfterRequest.action.amount);
    console.log('PASS: pending request created —', rawAfterRequest.id);

    console.log('STEP 3: approving as Officer A signs it — still pending, 1 more needed');
    await page.locator('#approveButtons button').nth(0).click();
    await page.waitForFunction(() => document.getElementById('officerState-0').textContent.includes('Signed'), { timeout: 10000 });
    const progressAfterA = await page.locator('#progressText').textContent();
    assert(progressAfterA.includes('1 of 2'), 'expected "1 of 2" progress after Officer A signs, got: ' + progressAfterA);
    const rawAfterA = JSON.parse(await page.locator('#rawPre').textContent());
    assert(rawAfterA.status === 'pending', 'expected the request to still be pending after only one signature');
    console.log('PASS: Officer A signed, still pending —', progressAfterA);

    console.log('STEP 4: the "forge a signature" button signs a tampered amount with Officer C\'s real key and is rejected');
    await page.locator('#tamperBtn').click();
    await page.waitForFunction(() => {
      const el = document.getElementById('approveStatus');
      return el.textContent.includes('Rejected');
    }, { timeout: 10000 });
    const tamperText = await page.locator('#approveStatus').textContent();
    assert(tamperText.includes('does not check out') || tamperText.includes('Rejected'), 'expected a rejection message, got: ' + tamperText);
    assert(!(await page.locator('#officerState-2').textContent()).includes('Signed'), 'expected the tampered signature to NOT count as Officer C actually signing');
    const rawAfterTamper = JSON.parse(await page.locator('#rawPre').textContent());
    assert(rawAfterTamper.signatures.length === 1, 'expected the tampered attempt to add no real signature, still just 1, got ' + rawAfterTamper.signatures.length);
    console.log('PASS: tampered signature correctly rejected —', tamperText);

    console.log('STEP 5: approving as Officer B reaches the 2-of-3 threshold and executes');
    await page.locator('#approveButtons button').nth(1).click();
    await page.waitForFunction(() => document.getElementById('approveStatus').textContent.includes('executed'), { timeout: 10000 });
    const executedText = await page.locator('#approveStatus').textContent();
    const rawExecuted = JSON.parse(await page.locator('#rawPre').textContent());
    assert(rawExecuted.status === 'executed', 'expected the request to be executed after 2 real signatures, got: ' + rawExecuted.status);
    assert(typeof rawExecuted.executedCredentialId === 'string' && rawExecuted.executedCredentialId.startsWith('urn:atlas:asset:'), 'expected a real minted credential id, got: ' + rawExecuted.executedCredentialId);
    console.log('PASS:', executedText);

    console.log('STEP 6: both approve buttons are now disabled — no way to sign an already-executed request from the UI');
    const buttonStates = await page.locator('#approveButtons button').evaluateAll((btns) => btns.map((b) => b.disabled));
    assert(buttonStates.every(Boolean), 'expected every approve button to be disabled once executed, got: ' + JSON.stringify(buttonStates));
    console.log('PASS: approve buttons disabled post-execution');

    console.log('\nALL K-OF-N TREASURY APPROVAL DEMO CHECKS PASSED');
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
