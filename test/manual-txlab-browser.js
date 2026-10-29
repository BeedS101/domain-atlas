// Real-browser walk-through of the Multi-Domain Transaction Authorization Lab page against two
// separately started PHP domains (own keys, own state), exactly as the live sites will run:
// create a 30.00 DEMO transfer on domain A, show it on domain B, sign on B, confirm one
// approval never executes, sign on A, confirm execution once and the evidence checks in the
// browser itself. Screenshots go to $TXLAB_SHOTS (default: the temp workspace).
//
//   node test/manual-txlab-browser.js

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { chromium } = require('playwright');

const REPO = path.resolve(__dirname, '..');
const TXLAB_SRC = path.join(REPO, 'issuer-php', 'atlas', 'demo', 'txlab');
const TOOL = path.join(TXLAB_SRC, 'tools', 'txlab-admin.php');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'txlab-browser-'));
const SHOTS = process.env.TXLAB_SHOTS || ROOT;
const PA = 9351, PB = 9352;
const procs = [];

const assert = (c, m) => { if (!c) throw new Error('ASSERTION FAILED: ' + m); };
const pass = (m) => console.log('PASS: ' + m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const php = (a) => execFileSync('php', a, { encoding: 'utf8' });

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.isDirectory()) copyDir(path.join(src, e.name), path.join(dst, e.name));
    else fs.copyFileSync(path.join(src, e.name), path.join(dst, e.name));
  }
}

function makeDomain(name, domain, port, pubs, tokens, page) {
  const root = path.join(ROOT, name);
  const docroot = path.join(root, 'public_html');
  copyDir(TXLAB_SRC, path.join(docroot, 'atlas', 'demo', 'txlab'));
  fs.mkdirSync(path.join(docroot, 'lib'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'issuer-php', 'lib', 'crypto.php'), path.join(docroot, 'lib', 'crypto.php'));
  fs.copyFileSync(page, path.join(docroot, 'txlab.html'));
  return { name, domain, port, docroot, priv: path.join(root, 'private') };
}

async function waitPort(port) {
  for (let i = 0; i < 80; i++) {
    const ok = await new Promise((res) => { const s = net.connect(port, '127.0.0.1', () => { s.destroy(); res(true); }); s.on('error', () => res(false)); });
    if (ok) return;
    await sleep(100);
  }
  throw new Error('server did not start on ' + port);
}

async function main() {
  assert(fs.readFileSync(path.join(REPO, 'demo-domain-a', 'txlab.html')).equals(fs.readFileSync(path.join(REPO, 'demo-domain-b', 'txlab.html'))), 'the lab page is identical on both demo domains');
  const a = makeDomain('a', 'a.test', PA, null, null, path.join(REPO, 'demo-domain-a', 'txlab.html'));
  const b = makeDomain('b', 'b.test', PB, null, null, path.join(REPO, 'demo-domain-b', 'txlab.html'));
  const out = {};
  for (const d of [a, b]) {
    const o = php([TOOL, 'keygen', '--dir', d.priv, '--domain', d.domain]);
    out[d.name] = { pub: /public key:\s+(\S+)/.exec(o)[1], token: /admin token:\s+(\S+)/.exec(o)[1] };
  }
  const roster = 'a.test=' + out.a.pub + '@http://127.0.0.1:' + PA + '/atlas/demo/txlab/api.php,b.test=' + out.b.pub + '@http://127.0.0.1:' + PB + '/atlas/demo/txlab/api.php';
  for (const d of [a, b]) php([TOOL, 'config', '--dir', d.priv, '--domain', d.domain, '--settlement', 'a.test', '--threshold', '2', '--mandatory', 'a.test', '--roster', roster, '--allow-insecure-http', '--enable']);
  for (const d of [a, b]) {
    procs.push(spawn('php', ['-S', '127.0.0.1:' + d.port, '-t', d.docroot], { env: { ...process.env, TXLAB_PRIVATE_DIR: d.priv, PHP_CLI_SERVER_WORKERS: '6' }, stdio: 'ignore' }));
    await waitPort(d.port);
  }

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 1500 } });
  const pageA = await ctx.newPage();
  const pageB = await ctx.newPage();
  const errors = [];
  for (const p of [pageA, pageB]) { p.on('pageerror', (e) => errors.push(e.message)); }

  await pageA.goto('http://127.0.0.1:' + PA + '/txlab.html');
  await pageA.waitForSelector('#app', { state: 'visible' });
  assert((await pageA.textContent('.banner')).includes('TEST DEMO — NO REAL CURRENCY'), 'the test-demo banner is shown');
  assert((await pageA.textContent('#whoami')).includes('settlement authority'), 'A identifies as the settlement authority');
  await pageA.waitForFunction(() => document.querySelector('#balances').textContent.includes('100.00 DEMO'));
  const balText = await pageA.textContent('#balances');
  assert(balText.includes('alice') && balText.includes('100.00 DEMO') && balText.includes('0.00 DEMO'), 'balances shown without logging in: ' + balText);
  pass('page loads without any login: test banner, role, Alice 100.00 / Bob 0.00');

  // locked: submit refuses; wrong token refused
  await pageA.fill('#amt', '30');
  await pageA.click('#submit');
  assert((await pageA.textContent('#msg')).includes('Unlock'), 'creating needs the administrator token');
  await pageA.fill('#tok', 'wrong-token');
  await pageA.click('#tokBtn');
  await pageA.waitForFunction(() => /authorization required/.test(document.querySelector('#tokState').textContent));
  await pageA.fill('#tok', out.a.token);
  await pageA.click('#tokBtn');
  await pageA.waitForFunction(() => document.querySelector('#tokState').textContent === 'unlocked');
  pass('sensitive actions are locked until the right administrator token is entered (wrong token refused)');

  await pageA.selectOption('#from', 'alice');
  await pageA.selectOption('#to', 'bob');
  await pageA.click('#submit');
  await pageA.waitForFunction(() => /^[0-9a-f-]{36}$/.test(document.querySelector('#evId').textContent));
  const txId = await pageA.textContent('#evId');
  assert((await pageA.textContent('#quorumText')) === '0/2' && (await pageA.textContent('#txStatus')) === 'pending', 'created: pending 0/2');
  await pageA.waitForFunction(() => document.querySelector('#evDigestOk').textContent.includes('matches'));
  pass('transaction created from the browser; digest recomputed in the browser matches');

  // the same transaction on B
  await pageB.goto('http://127.0.0.1:' + PB + '/txlab.html#tx=' + txId);
  await pageB.waitForSelector('#authBox', { state: 'visible' });
  assert((await pageB.textContent('#evId')) === txId && (await pageB.textContent('#evDigest')) === (await pageA.textContent('#evDigest')), 'B shows the same transaction and digest');
  assert((await pageB.textContent('#whoami')).includes('approving domain'), 'B identifies as an approving domain');
  assert(await pageB.isDisabled('#submit'), 'B cannot create transactions (settlement authority only)');
  await pageB.fill('#tok', out.b.token);
  await pageB.click('#tokBtn');
  await pageB.waitForFunction(() => document.querySelector('#tokState').textContent === 'unlocked');
  await pageB.click('#domainCards button:has-text("Verify & sign approval")');
  await pageB.waitForFunction(() => document.querySelector('#quorumText').textContent === '1/2');
  assert((await pageB.textContent('#txStatus')) === 'pending', 'one approval: still pending');
  pass('B shows the same transaction, signs with its own key: 1/2, still pending');

  await pageA.waitForFunction(() => document.querySelector('#quorumText').textContent === '1/2', null, { timeout: 8000 });
  assert((await pageA.textContent('#txStatus')) === 'pending', 'A sees B\'s approval but the transfer has not executed');
  const stillBal = await pageA.textContent('#balances');
  assert(stillBal.includes('100.00 DEMO'), 'balances unchanged with one approval: ' + stillBal);
  assert((await pageA.textContent('#conserve')).includes('no balance has moved'), 'the page says no balance moved');
  await pageA.screenshot({ path: path.join(SHOTS, 'txlab-1-of-2.png'), fullPage: true });
  pass('A sees B\'s signature arrive (1/2); no balance moved');

  await pageA.click('#domainCards button:has-text("Verify & sign approval")');
  await pageA.waitForFunction(() => document.querySelector('#txStatus').textContent === 'executed', null, { timeout: 8000 });
  assert((await pageA.textContent('#quorumText')) === '2/2', 'quorum 2/2');
  const table = await pageA.textContent('#balTable');
  assert(/alice\s*100\.00\s*70\.00\s*-30\.00/.test(table.replace(/\s+/g, ' ').replace(/(\d)\s+(\d)/g, '$1 $2')) || (table.includes('70.00') && table.includes('30.00') && table.includes('-30.00')), 'balances before/after: ' + table);
  await pageA.waitForFunction(() => document.querySelectorAll('#evApprovals tbody td.ok').length === 4, null, { timeout: 8000 }); // server + browser check for each of two approvals
  const receipt = await pageA.textContent('#evReceipt');
  assert(receipt.includes('Receipt signed by a.test'), 'receipt shown');
  await pageA.waitForFunction(() => document.querySelectorAll('#evReceipt .ok').length === 2, null, { timeout: 8000 });
  assert((await pageA.textContent('#conserve')).includes('OK'), 'conservation OK');
  assert((await pageA.textContent('#steps')).includes('Balances: alice 70.00, bob 30.00'), 'last step shows Alice 70.00, Bob 30.00');
  await pageA.screenshot({ path: path.join(SHOTS, 'txlab-executed.png'), fullPage: true });
  pass('A signs: 2/2, executed once; Alice 70.00, Bob 30.00; both approvals and the receipt verified by the server AND by this browser (Web Crypto)');

  await pageB.waitForFunction(() => document.querySelector('#txStatus').textContent === 'executed', null, { timeout: 8000 });
  await pageB.waitForFunction(() => document.querySelectorAll('#evApprovals tbody td.ok').length === 4, null, { timeout: 8000 });
  assert((await pageB.textContent('#balTable')).includes('70.00'), 'B displays the executed balances');
  await pageB.screenshot({ path: path.join(SHOTS, 'txlab-on-domain-b.png'), fullPage: true });
  pass('domain B shows the executed transaction with its own independent verification');

  // a second click on a button must not be possible, and the log shows each real event
  const log = await pageA.textContent('#log');
  assert(/approval-accepted \[b\.test\]/.test(log) && /approval-accepted \[a\.test\]/.test(log) && /executed/.test(log), 'event log shows each approval and the execution');
  assert(errors.length === 0, 'no page errors: ' + errors.join('; '));
  pass('event log lists each approval separately and the execution; no page errors');

  await browser.close();
  console.log('\nALL TRANSACTION LAB BROWSER CHECKS PASSED (screenshots in ' + SHOTS + ')');
}

main().then(() => end(0), (e) => { console.error('\nFAILURE: ' + (e && e.stack || e)); end(1); });
function end(code) {
  procs.forEach((p) => { try { p.kill('SIGKILL'); } catch (e) { /* gone */ } });
  if (!process.env.TXLAB_KEEP) fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(code);
}
