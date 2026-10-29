// Real-browser walk-through of the PUBLIC demo flow: a visitor opens txlab.html, starts a test
// transfer, watches both domains independently validate and sign it, and sees the verified
// receipt - with no administrator token and no wallet. Two PHP domains with their own keys and
// state, a second visitor in a separate browser context, and screenshots to $TXLAB_SHOTS.
//
//   node test/manual-txlab-public-browser.js

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { chromium } = require('playwright');

const REPO = path.resolve(__dirname, '..');
const TXLAB_SRC = path.join(REPO, 'issuer-php', 'atlas', 'demo', 'txlab');
const TOOL = path.join(TXLAB_SRC, 'tools', 'txlab-admin.php');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'txlab-pubbrowser-'));
const SHOTS = process.env.TXLAB_SHOTS || ROOT;
const PA = 9361, PB = 9362;
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
function makeDomain(name, domain, port, page) {
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
const startDomain = async (d) => {
  procs[d.name] = spawn('php', ['-S', '127.0.0.1:' + d.port, '-t', d.docroot], { env: { ...process.env, TXLAB_PRIVATE_DIR: d.priv, PHP_CLI_SERVER_WORKERS: '8' }, stdio: 'ignore' });
  await waitPort(d.port);
};

async function main() {
  assert(fs.readFileSync(path.join(REPO, 'demo-domain-a', 'txlab.html')).equals(fs.readFileSync(path.join(REPO, 'demo-domain-b', 'txlab.html'))), 'the lab page is identical on both demo domains');
  const a = makeDomain('a', 'a.test', PA, path.join(REPO, 'demo-domain-a', 'txlab.html'));
  const b = makeDomain('b', 'b.test', PB, path.join(REPO, 'demo-domain-b', 'txlab.html'));
  const out = {};
  for (const d of [a, b]) out[d.name] = { pub: /public key:\s+(\S+)/.exec(php([TOOL, 'keygen', '--dir', d.priv, '--domain', d.domain]))[1] };
  const roster = 'a.test=' + out.a.pub + '@http://127.0.0.1:' + PA + '/atlas/demo/txlab/api.php,b.test=' + out.b.pub + '@http://127.0.0.1:' + PB + '/atlas/demo/txlab/api.php';
  for (const d of [a, b]) php([TOOL, 'config', '--dir', d.priv, '--domain', d.domain, '--settlement', 'a.test', '--threshold', '2', '--mandatory', 'a.test', '--roster', roster, '--allow-insecure-http', '--enable', '--public-demo', '--public-set', 'callsPerIpPerMinute=2000,approvalsPerIpPerMinute=500']);
  await startDomain(a);
  await startDomain(b);

  const browser = await chromium.launch();
  const errors = [];
  const watch = (p) => { p.on('pageerror', (e) => errors.push(e.message)); const reqs = (p._adminCalls = []); p.on('request', (r) => { if (/op=(admin-check|create|decide)/.test(r.url())) reqs.push(r.url()); }); return p; };

  // ---- visitor 1
  const ctx1 = await browser.newContext({ viewport: { width: 1100, height: 1700 } });
  const p1 = watch(await ctx1.newPage());
  await p1.goto('http://127.0.0.1:' + PA + '/txlab.html');
  await p1.waitForSelector('#app', { state: 'visible' });
  await p1.waitForSelector('#visitorPanel', { state: 'visible' });
  assert((await p1.textContent('.banner')).includes('TEST DEMO — NO REAL CURRENCY'), 'the test-demo banner is shown');
  await p1.waitForFunction(() => /alice\s*100\.00 DEMO/.test(document.querySelector('#balances').textContent.replace(/\s+/g, ' ')) || document.querySelector('#balances').textContent.includes('100.00 DEMO'));
  assert(await p1.isEnabled('#submit') && (await p1.textContent('#submit')) === 'Start test transfer', 'the visitor can start a transfer immediately');
  assert(!(await p1.isVisible('#tok')), 'the administrator token box is collapsed in public mode');
  assert((await p1.textContent('#sessionInfo')).includes('Nobody else can spend these balances'), 'the private session is explained');
  await p1.screenshot({ path: path.join(SHOTS, 'txlab-public-1-start.png'), fullPage: true });
  pass('visitor opens txlab.html: banner, private session with Alice 100.00, no administrator token needed');

  await p1.fill('#amt', '30');
  await p1.click('#submit');
  await p1.waitForFunction(() => /^[0-9a-f-]{36}$/.test(document.querySelector('#evId').textContent));
  const txId = await p1.textContent('#evId');
  assert((await p1.textContent('#quorumText')) === '0/2' && (await p1.textContent('#txStatus')) === 'pending', 'created: pending 0/2');
  assert((await p1.textContent('#balances')).includes('100.00 DEMO'), 'no balance moved yet');
  await p1.waitForFunction(() => document.querySelector('#evDigestOk').textContent.includes('matches'));
  assert((await p1.textContent('#evLedger')).includes('public demo session'), 'the evidence names the public demo session ledger');
  pass('visitor starts a 30.00 test transfer: pending 0/2, digest recomputed in the browser matches');

  // domain A approves
  await p1.click('#domainCards button:has-text("Ask a.test")');
  await p1.waitForFunction(() => document.querySelector('#quorumText').textContent === '1/2');
  assert((await p1.textContent('#txStatus')) === 'pending' && (await p1.textContent('#balances')).includes('100.00 DEMO'), 'one approval: still pending, nothing moved');
  await p1.waitForFunction(() => document.querySelectorAll('#evApprovals tbody td.ok').length === 2);
  await p1.screenshot({ path: path.join(SHOTS, 'txlab-public-2-a-approved.png'), fullPage: true });
  pass('Domain A validates and signs: 1/2, still pending, signature verified by the server and by this browser');

  // domain B approves (server to server)
  await p1.click('#domainCards button:has-text("Ask b.test")');
  await p1.waitForFunction(() => document.querySelector('#txStatus').textContent === 'executed', null, { timeout: 15000 });
  assert((await p1.textContent('#quorumText')) === '2/2', '2/2');
  await p1.waitForFunction(() => document.querySelectorAll('#evApprovals tbody td.ok').length === 4, null, { timeout: 8000 });
  await p1.waitForFunction(() => document.querySelectorAll('#evReceipt .ok').length === 2, null, { timeout: 8000 });
  assert((await p1.textContent('#evReceipt')).includes('Receipt signed by a.test'), 'receipt shown');
  const bal = (await p1.textContent('#balances')).replace(/\s+/g, ' ');
  assert(/alice\s*70\.00 DEMO/.test(bal) && /bob\s*30\.00 DEMO/.test(bal), 'Alice 70.00, Bob 30.00: ' + bal);
  assert((await p1.textContent('#steps')).includes('Balances: alice 70.00, bob 30.00'), 'last step shows the new balances');
  const logText = await p1.textContent('#log');
  assert(/peer-approval-requested/.test(logText) && /approval-accepted \[a\.test\]/.test(logText) && /approval-accepted \[b\.test\]/.test(logText) && /executed/.test(logText), 'the event log shows the request to B, both approvals and the execution');
  assert(!(await p1.isVisible('#domainCards button')), 'no approval buttons remain after execution');
  await p1.screenshot({ path: path.join(SHOTS, 'txlab-public-3-executed.png'), fullPage: true });
  pass('Domain B independently fetches, validates and signs: 2/2 executed, Alice 70.00 / Bob 30.00, signed receipt verified by the server AND by this browser');

  // B's page: read-only, independent verification
  const pB = watch(await ctx1.newPage());
  await pB.goto('http://127.0.0.1:' + PB + '/txlab.html#tx=' + txId);
  await pB.waitForSelector('#approverNotice', { state: 'visible' });
  await pB.waitForFunction(() => document.querySelector('#txStatus').textContent === 'executed', null, { timeout: 10000 });
  await pB.waitForFunction(() => document.querySelectorAll('#evApprovals tbody td.ok').length === 4, null, { timeout: 8000 });
  assert(!(await pB.isVisible('#txPanel')) && !(await pB.isVisible('#domainCards button')), 'the approving domain\'s page is view/verify only');
  assert((await pB.textContent('#evId')) === txId && (await pB.textContent('#evDigest')) === (await p1.textContent('#evDigest')), 'B shows the same transaction and digest');
  await pB.screenshot({ path: path.join(SHOTS, 'txlab-public-4-domain-b.png'), fullPage: true });
  pass('Domain B\'s page shows the same settled transfer, read-only, with its own independent verification');

  // ---- visitor 2 in a separate browser context: independent balances, cannot touch visitor 1
  const ctx2 = await browser.newContext({ viewport: { width: 1100, height: 1200 } });
  const p2 = watch(await ctx2.newPage());
  await p2.goto('http://127.0.0.1:' + PA + '/txlab.html');
  await p2.waitForSelector('#visitorPanel', { state: 'visible' });
  await p2.waitForFunction(() => document.querySelector('#balances').textContent.includes('100.00 DEMO'));
  const bal2 = (await p2.textContent('#balances')).replace(/\s+/g, ' ');
  assert(/alice\s*100\.00 DEMO/.test(bal2) && /bob\s*0\.00 DEMO/.test(bal2), 'visitor 2 has a fresh 100.00 / 0.00: ' + bal2);
  await p2.fill('#txid', txId);
  await p2.click('#load');
  await p2.waitForFunction(() => document.querySelector('#txStatus').textContent === 'executed');
  assert(/alice\s*100\.00 DEMO/.test(await p2.textContent('#balances')), 'looking at visitor 1\'s settled transfer does not change visitor 2\'s balances');
  // a pending transfer of visitor 1 is view-only for visitor 2
  await p1.fill('#amt', '5');
  await p1.click('#submit');
  await p1.waitForFunction((old) => /^[0-9a-f-]{36}$/.test(document.querySelector('#evId').textContent) && document.querySelector('#evId').textContent !== old, txId);
  const tx2 = await p1.textContent('#evId');
  await p2.fill('#txid', tx2);
  await p2.click('#load');
  await p2.waitForFunction((id) => document.querySelector('#evId').textContent === id, tx2);
  await p2.waitForFunction(() => /view only/.test(document.querySelector('#domainCards').textContent));
  assert(!(await p2.isVisible('#domainCards button')) && !(await p2.isVisible('#runAll')), 'visitor 2 gets no approval buttons for visitor 1\'s pending transfer');
  await p2.screenshot({ path: path.join(SHOTS, 'txlab-public-5-second-visitor.png'), fullPage: true });
  pass('a second visitor has independent balances and can only view, never approve, another session\'s transfer');

  // ---- one-click "request both" and an unreachable approver
  await p1.click('#runAll');
  await p1.waitForFunction(() => document.querySelector('#txStatus').textContent === 'executed', null, { timeout: 20000 });
  await p1.waitForFunction(() => /alice\s*65\.00 DEMO/.test(document.querySelector('#balances').textContent), null, { timeout: 8000 }); // the balance grid refreshes with the session poll
  await p1.fill('#amt', '2');
  await p1.click('#submit');
  await p1.waitForFunction((old) => document.querySelector('#evId').textContent !== old && /^[0-9a-f-]{36}$/.test(document.querySelector('#evId').textContent), tx2);
  procs.b.kill('SIGKILL');
  await p1.click('#domainCards button:has-text("Ask a.test")');
  await p1.waitForFunction(() => document.querySelector('#quorumText').textContent === '1/2');
  await p1.click('#domainCards button:has-text("Ask b.test")');
  await p1.waitForFunction(() => /unavailable/.test(document.querySelector('#msg').textContent), null, { timeout: 25000 });
  assert((await p1.textContent('#txStatus')) === 'pending', 'with B unreachable the transfer stays pending');
  await startDomain(b);
  await p1.click('#domainCards button:has-text("Ask b.test")');
  await p1.waitForFunction(() => document.querySelector('#txStatus').textContent === 'executed', null, { timeout: 20000 });
  pass('"Request both approvals" settles a transfer; an unreachable approver leaves it pending with a clear message, and it completes when the approver is back');

  // ---- limits are visible and enforced server-side
  await p1.fill('#amt', '51');
  await p1.click('#submit');
  await p1.waitForFunction(() => document.querySelector('#msg').className === 'err');
  assert(/between 1 and 5000|limit/.test(await p1.textContent('#msg')), 'an over-limit amount is refused by the server: ' + await p1.textContent('#msg'));
  await p1.fill('#amt', '999');
  await p1.click('#submit');
  await p1.waitForFunction(() => /between 1 and 5000/.test(document.querySelector('#msg').textContent));
  pass('over-limit amounts are refused with the server\'s message');

  // ---- the administrator box stays protected
  await p1.click('#adminBox summary');
  await p1.fill('#tok', 'wrong-token');
  await p1.click('#tokBtn');
  await p1.waitForFunction(() => /authorization required/.test(document.querySelector('#tokState').textContent));
  assert(!(await p1.isVisible('#adminSubmit')), 'the administrator submit stays hidden without the right token');
  pass('the protected manual mode is still locked without the administrator token');

  // ---- the visitor flow never called an administrator operation
  assert(p1._adminCalls.every((u) => /admin-check/.test(u)) && p2._adminCalls.length === 0 && pB._adminCalls.length === 0, 'the visitor flow made no create/decide/admin calls: ' + p1._adminCalls.concat(p2._adminCalls).join(','));
  assert(errors.length === 0, 'no page errors: ' + errors.join('; '));
  pass('the whole visitor flow ran without any administrator operation; no page errors');

  await browser.close();
  console.log('\nALL PUBLIC-DEMO BROWSER CHECKS PASSED (screenshots in ' + SHOTS + ')');
}

main().then(() => end(0), (e) => { console.error('\nFAILURE: ' + (e && e.stack || e)); end(1); });
function end(code) {
  Object.values(procs).forEach((p) => { try { p.kill('SIGKILL'); } catch (e) { /* gone */ } });
  if (!process.env.TXLAB_KEEP) fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(code);
}
