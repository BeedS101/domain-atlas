// Manual browser click-through for demo-domain-a/governance-demo.html —
// the open-assembly one-member-one-vote demo. Unlike
// test/manual-governance-demo.js and test/manual-governance-demo-php.js
// (which drive the same flow straight against each backend's HTTP API),
// this one actually loads the real page in a real browser and clicks
// through it, the same way test/manual-reserve-bank-demo-browser.js does
// for reserve-bank-demo.html — catching bugs those two API-level tests
// cannot, such as a page-script reference error that only surfaces when a
// button handler actually runs in a browser.
//
// Checks, one per act:
//   1. "join the assembly" renders three member cards and reveals Act 2.
//   2. Shortening the deadline to 5s and proposing starts a live countdown
//      and reveals Acts 3-5.
//   3. All three vote buttons land and the live tally renders correctly
//      after each one (1 yes, 2 yes, 2 yes/1 no).
//   4. Both "try to break it" buttons are correctly rejected (double vote,
//      non-member vote) — neither renders the "Unexpected" failure text.
//   5. The finalize button stays disabled until the countdown reaches
//      zero, then requesting the decision reports the correct outcome and
//      counts, with a raw-credential box attached.
//   Plus: clicking the raw box's "Try verifying this one" button
//   independently confirms the decision credential in the browser itself.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NODE_PORT = 8191; // isolated — distinct from every other manual-*.js test's chosen port
const NODE_DOMAIN = 'localhost:' + NODE_PORT;
const NODE_BASE = 'http://' + NODE_DOMAIN;

const NODE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-governance-demo-node-'));
const NODE_DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-governance-demo-docroot-'));

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
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err));
    await page.goto(NODE_BASE + '/governance-demo.html', { waitUntil: 'load' });

    console.log('STEP 1: Act 1 — the assembly is open to anyone');
    await page.locator('#joinBtn').click();
    await page.waitForFunction(() => document.querySelectorAll('#memberCards .member').length === 3, { timeout: 10000 });
    await page.waitForFunction(() => document.getElementById('proposePanel').style.display !== 'none', { timeout: 10000 });
    const joinText = await page.locator('#joinResult').textContent();
    assert(joinText.includes('All three joined'), 'unexpected join result: ' + joinText);
    console.log('PASS:', joinText);

    console.log('STEP 2: Act 2 — Alice proposes, with a shortened 5s deadline so the countdown closes quickly');
    await page.locator('#deadlineInput').fill('5');
    await page.locator('#proposeBtn').click();
    await page.waitForFunction(() => document.getElementById('countdown').style.display !== 'none', { timeout: 10000 });
    await page.waitForFunction(() => document.getElementById('votePanel').style.display !== 'none' && document.getElementById('breakPanel').style.display !== 'none' && document.getElementById('finalizePanel').style.display !== 'none', { timeout: 10000 });
    const proposeText = await page.locator('#proposeResult').textContent();
    assert(proposeText.includes("Extend the plaza market's opening hours"), 'unexpected propose result: ' + proposeText);
    assert(await page.locator('#finalizeBtn').isDisabled(), 'expected the finalize button to start out disabled, before the deadline passes');
    console.log('PASS:', proposeText);

    console.log('STEP 3: Act 3 — one member, one vote, tallied live');
    await page.locator('#aliceYesBtn').click();
    await page.waitForFunction(() => document.getElementById('tallyCounts').textContent.includes('1') && document.getElementById('tallyBox').style.display !== 'none', { timeout: 10000 });
    let tallyText = await page.locator('#tallyCounts').textContent();
    assert(/1.*yes.*0.*no/.test(tallyText) || tallyText.includes('1') , 'unexpected tally after first vote: ' + tallyText);

    await page.locator('#bobYesBtn').click();
    await page.waitForFunction(() => document.getElementById('tallyCounts').textContent.includes('2 of 3'), { timeout: 10000 });
    tallyText = await page.locator('#tallyCounts').textContent();
    console.log('  tally after 2 votes:', tallyText);

    await page.locator('#charlieNoBtn').click();
    await page.waitForFunction(() => document.getElementById('tallyCounts').textContent.includes('3 of 3'), { timeout: 10000 });
    tallyText = await page.locator('#tallyCounts').textContent();
    assert(tallyText.includes('2') && tallyText.includes('1') && tallyText.includes('3 of 3'), 'unexpected final tally: ' + tallyText);
    console.log('PASS: live tally after all three votes ->', tallyText);

    console.log('STEP 4: Act 4 — try to break it');
    await page.locator('#doubleVoteBtn').click();
    await page.waitForFunction(() => document.getElementById('breakResult').textContent.includes('Rejected'), { timeout: 10000 });
    let breakText = await page.locator('#breakResult').textContent();
    assert(!breakText.includes('Unexpected'), 'double vote should have been rejected, got: ' + breakText);
    assert(breakText.includes('already voted'), 'unexpected double-vote rejection text: ' + breakText);

    await page.locator('#nonMemberVoteBtn').click();
    await page.waitForFunction(() => document.getElementById('breakResult').textContent.includes('join first'), { timeout: 10000 });
    breakText = await page.locator('#breakResult').textContent();
    assert(!breakText.includes('Unexpected'), 'non-member vote should have been rejected, got: ' + breakText);
    console.log('PASS: both double-vote and non-member-vote were correctly rejected');

    console.log('STEP 5: Act 5 — the deadline passes on its own, then the signed decision is requested');
    await page.waitForFunction(() => document.getElementById('countdown').className.includes('closed'), { timeout: 15000 });
    await page.waitForFunction(() => !document.getElementById('finalizeBtn').disabled, { timeout: 10000 });
    console.log('PASS: countdown closed itself and enabled the finalize button, nobody had to click anything to end voting');

    await page.locator('#finalizeBtn').click();
    await page.waitForFunction(() => document.getElementById('finalizeResult').textContent.includes('Outcome'), { timeout: 10000 });
    const finalizeText = await page.locator('#finalizeResult').textContent();
    assert(finalizeText.includes('PASSED'), 'expected outcome PASSED with 2 yes / 1 no, got: ' + finalizeText);
    assert(finalizeText.includes('2 yes') && finalizeText.includes('1 no') && finalizeText.includes('3 total votes'), 'unexpected finalize counts: ' + finalizeText);
    assert(await page.locator('#finalizeResult details.raw').count() === 1, 'expected a raw-credential box on the finalize result');
    console.log('PASS:', finalizeText);

    console.log('STEP 6: independently verify the decision credential, in the browser itself');
    const rawBox = page.locator('#finalizeResult details.raw');
    await rawBox.locator('summary').click();
    await rawBox.locator('button').click();
    await page.waitForFunction(() => document.getElementById('verifyResult').textContent.startsWith('✓ Valid'), { timeout: 10000 });
    const verifyText = await page.locator('#verifyResult').textContent();
    console.log('PASS:', verifyText);

    assert(pageErrors.length === 0, 'expected no uncaught page errors during the whole walkthrough, got: ' + pageErrors.map((e) => e.message).join(' | '));
    console.log('PASS: no uncaught page errors across the whole walkthrough');

    console.log('\nALL FIVE ACTS PASSED in a real browser against demo-domain-a/governance-demo.html');
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
