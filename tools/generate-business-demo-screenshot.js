#!/usr/bin/env node
// Regenerates docs/business-demo-screenshot.png — the image README.md
// embeds right under its own live-demo link, for anyone skimming the repo
// on GitHub without clicking through. Not a manual-*.js check: nothing
// here asserts anything, it drives demo-domain-a/business-demo.html
// through a representative walk (issue, send the coupon, verify the
// friend's fresh copy) purely to end on a screen worth showing, against
// an isolated, throwaway issuer-server instance the same way every
// manual-*.js test already does.
//
// Re-run this by hand whenever business-demo.html's look or flow changes
// enough that the embedded screenshot would otherwise go stale:
//
//   node tools/generate-business-demo-screenshot.js

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 8129; // isolated — distinct from every manual-*.js test's own chosen port
// The server answers over plain http://localhost — but ATLAS_DOMAIN is
// what it signs credentials as and prints in the page's own JSON (issuer,
// model/thumbnail URLs), so setting it to the real live hostname here
// makes the screenshot show what evtec.co.za's own demo actually looks
// like, not an isolated test port a reader would have to mentally
// translate. Purely cosmetic — this instance is never reachable at that
// hostname, and nothing here claims otherwise.
const DOMAIN = 'evtec.co.za';
const BASE = 'http://localhost:' + PORT;
const OUT_PATH = path.resolve(__dirname, '..', 'docs', 'business-demo-screenshot.png');

const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-demo-shot-node-'));
const DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-demo-shot-docroot-'));

(async () => {
  console.log('SETUP: copying demo-domain-a into an isolated docroot and starting its own issuer-server instance on port ' + PORT);
  fs.cpSync(path.resolve(__dirname, '..', 'demo-domain-a'), DOCROOT_DIR, { recursive: true });
  const nodeProc = spawn('node', ['issuer-server/server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), ATLAS_DOMAIN: DOMAIN, ATLAS_STATE_DIR: STATE_DIR, ATLAS_DOCROOT: DOCROOT_DIR },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('issuer-server did not start in time')), 10000);
    nodeProc.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); resolve(); } });
    nodeProc.on('exit', (code) => reject(new Error('issuer-server exited early with code ' + code)));
  });
  console.log('PASS: isolated issuer-server up on port ' + PORT);

  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: '/opt/pw-browsers/chromium' });
    const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
    await page.goto(BASE + '/business-demo.html', { waitUntil: 'load' });

    console.log('STEP: issuing the two demo credentials');
    await page.locator('#issueBtn').click();
    await page.waitForFunction(() => document.querySelectorAll('#youCards .card').length === 2, { timeout: 10000 });

    console.log('STEP: sending the coupon to a friend');
    const couponCard = page.locator('#youCards .card', { hasText: '10% Off Coupon' });
    await couponCard.locator('.sendBtn').click();
    await page.waitForFunction(() => document.querySelectorAll('#friendCards .card').length === 1, { timeout: 10000 });

    console.log('STEP: independently verifying the friend\'s fresh copy');
    const friendCard = page.locator('#friendCards .card', { hasText: '10% Off Coupon' });
    await friendCard.locator('details.raw summary').click();
    await friendCard.locator('.fillVerifyBtn').click();
    await page.waitForFunction(() => document.getElementById('verifyResult').textContent.startsWith('✓ Valid'), { timeout: 10000 });

    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    await page.screenshot({ path: OUT_PATH, fullPage: true });
    console.log('PASS: wrote', OUT_PATH);
  } finally {
    if (browser) await browser.close();
    nodeProc.kill();
    try { fs.rmSync(STATE_DIR, { recursive: true, force: true }); } catch (err) {}
    try { fs.rmSync(DOCROOT_DIR, { recursive: true, force: true }); } catch (err) {}
  }
})();
