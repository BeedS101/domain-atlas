// Manual check that mail marked read, deleted or claimed while a mail check
// is running stays that way. A check reads the stored mailbox, waits on
// every domain, and used to write its older copy back, so a message marked
// read during the wait showed as unread again and a deleted one came back.
//
//   xvfb-run -a node test/manual-mail-read-state.js
//
// The issuer reply is delayed in the wallet page so the overlap is certain.
// Not part of the permanent suite, same reasoning as the other manual-*.js
// scripts.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');
const os = require('os');
const { webcrypto } = require('crypto');
const { withAdminAuth } = require('./lib/admin-auth');
const { subtle } = webcrypto;

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const REPO = path.resolve(__dirname, '..');
const PORT = 8241; // isolated, distinct from every other manual-*.js test
const DOMAIN = 'localhost:' + PORT;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-mail-read-state-'));
const DOCROOT_DIR = path.join(TMP, 'docroot');
const STATE_DIR = path.join(TMP, 'state');

function assert(cond, message) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + message);
}
function b64url(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}
async function genIdentity() {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const raw = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
  return { kp, publicKey: b64url(raw) };
}
async function signWithSelf(identity, payload) {
  const data = new TextEncoder().encode(canonicalize(payload));
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, identity.kp.privateKey, data));
  return { signerRole: 'raw-ecdsa', publicKey: identity.publicKey, signature: b64url(sig) };
}
function postJson(urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: 'localhost', port: PORT, path: urlPath, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let chunks = '';
        res.on('data', (c) => { chunks += c; });
        res.on('end', () => { try { resolve(JSON.parse(chunks)); } catch (err) { reject(err); } });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

let serverProc = null;
function startIssuer() {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', ['issuer-server/server.js'], {
      cwd: REPO, detached: true,
      env: { ...process.env, PORT: String(PORT), ATLAS_DOMAIN: DOMAIN, ATLAS_STATE_DIR: STATE_DIR, ATLAS_DOCROOT: DOCROOT_DIR },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const timer = setTimeout(() => reject(new Error('issuer-server did not start in time')), 10000);
    proc.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); serverProc = proc; resolve(); } });
  });
}
function stopIssuer() {
  if (!serverProc) return;
  try { process.kill(-serverProc.pid, 'SIGKILL'); } catch (err) { serverProc.kill('SIGKILL'); }
}

async function sendMail(admin, credentialId, subject) {
  const payload = withAdminAuth({ credentialId, subject, body: 'Body of ' + subject }, 'http://' + DOMAIN, '/atlas/mail/send');
  return postJson('/atlas/mail/send', { payload, proof: await signWithSelf(admin, payload) });
}
function mailState(frame) {
  return frame.evaluate(() => AtlasWallet.getIdentity().then(async (i) => (await AtlasWallet.getMail(i.publicKey)).map((e) => ({ id: e.message.id, subject: e.message.subject, read: !!e.read }))));
}
// Starts a check whose issuer reply is held back, runs `during` while it is
// waiting, then lets the check finish.
async function checkWhile(frame, during) {
  await frame.evaluate(() => {
    if (!window.__realFetch) {
      window.__realFetch = window.fetch.bind(window);
      window.fetch = async (url, opts) => {
        const r = await window.__realFetch(url, opts);
        if (String(url).includes('/atlas/mail/check') && window.__holdMailCheck) await new Promise((res) => setTimeout(res, window.__holdMailCheck));
        return r;
      };
    }
    window.__holdMailCheck = 2500;
    window.__checkDone = false;
    window.__checkResult = AtlasWallet.checkAllMail().then((n) => { window.__checkDone = true; return n; });
  });
  await new Promise((r) => setTimeout(r, 700));
  await during();
  const added = await frame.evaluate(() => window.__checkResult);
  await frame.evaluate(() => { window.__holdMailCheck = 0; });
  return added;
}

(async () => {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.cpSync(path.join(REPO, 'demo-domain-a'), DOCROOT_DIR, { recursive: true });
  const manifestPath = path.join(DOCROOT_DIR, '.well-known', 'spatial.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.domain = DOMAIN;
  manifest.chat = false;
  manifest.calendar = false;
  manifest.tradingStation = false;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const admin = await genIdentity();
  fs.writeFileSync(path.join(STATE_DIR, 'atlas-admin-keys-store.json'), JSON.stringify({ keys: [{ publicKey: admin.publicKey, addedAt: new Date().toISOString() }] }, null, 2));
  await startIssuer();

  const context = await chromium.launchPersistentContext(path.join(TMP, 'profile'), {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  });
  try {
    const page = await context.newPage();
    await page.goto('http://' + DOMAIN, { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), null, { timeout: 10000 });
    await frame.locator('#walletBtn').click();
    await frame.locator('#chooseNewBtn').click();
    await frame.locator('#newPasswordInput').fill('mail-read-state-password');
    await frame.locator('#newPasswordConfirmInput').fill('mail-read-state-password');
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), null, { timeout: 5000 });
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), null, { timeout: 5000 });

    const membership = await frame.evaluate((d) => AtlasWallet.mintAsset('self', d, 'atlas.membership'), DOMAIN);
    const credentialId = membership.credential.id;
    await sendMail(admin, credentialId, 'First');
    await sendMail(admin, credentialId, 'Second');
    await frame.evaluate(() => AtlasWallet.checkAllMail());
    const base = await mailState(frame);
    assert(base.length >= 2 && base.every((m) => !m.read), 'expected unread mail to start with: ' + JSON.stringify(base));
    const baseCount = base.length;

    console.log('STEP 1: everything marked read while a check is running stays read');
    await sendMail(admin, credentialId, 'Third');
    let added = await checkWhile(frame, async () => {
      await frame.evaluate(() => AtlasWallet.getIdentity().then((i) => AtlasWallet.markAllMailRead(i.publicKey)));
    });
    let state = await mailState(frame);
    assert(added === 1, 'the check should report one new message, got ' + added);
    assert(state.length === baseCount + 1, 'expected ' + (baseCount + 1) + ' messages, got ' + state.length);
    const third = state.find((m) => m.subject === 'Third');
    assert(third && !third.read, 'the new message should arrive unread');
    assert(state.filter((m) => m.subject !== 'Third').every((m) => m.read), 'messages read during the check turned unread again: ' + JSON.stringify(state));
    console.log('PASS: earlier mail stayed read, the new message arrived unread');

    console.log('STEP 2: one message marked read during a check stays read, the rest are untouched');
    await sendMail(admin, credentialId, 'Fourth');
    const target = state.find((m) => m.subject === 'First');
    // Make First unread again by hand so the click has something to change.
    await frame.evaluate(() => AtlasWallet.getIdentity().then((i) => AtlasWallet.markAllMailRead(i.publicKey)));
    added = await checkWhile(frame, async () => {
      await frame.evaluate((id) => AtlasWallet.getIdentity().then((i) => AtlasWallet.markMailRead(i.publicKey, id)), target.id);
    });
    state = await mailState(frame);
    assert(added === 1 && state.find((m) => m.subject === 'Fourth' && !m.read), 'Fourth should arrive unread');
    assert(state.find((m) => m.id === target.id).read, 'the message marked read during the check turned unread again');
    console.log('PASS: single mark-read survived the check');

    console.log('STEP 3: a message deleted during a check does not come back');
    const doomed = state.find((m) => m.subject === 'Second');
    added = await checkWhile(frame, async () => {
      await frame.evaluate((id) => AtlasWallet.getIdentity().then((i) => AtlasWallet.deleteMailMessage(i.publicKey, id)), doomed.id);
    });
    state = await mailState(frame);
    assert(!state.some((m) => m.id === doomed.id), 'the deleted message was written back by the check');
    await frame.evaluate(() => AtlasWallet.checkAllMail());
    assert(!(await mailState(frame)).some((m) => m.id === doomed.id), 'the deleted message came back on the next check');
    console.log('PASS: deleted message stayed deleted');

    console.log('STEP 4: two checks at once add each message exactly once');
    await sendMail(admin, credentialId, 'Fifth');
    await frame.evaluate(() => { window.__holdMailCheck = 800; });
    const counts = await frame.evaluate(() => Promise.all([AtlasWallet.checkAllMail(), AtlasWallet.checkAllMail(), AtlasWallet.checkAllMail()]));
    await frame.evaluate(() => { window.__holdMailCheck = 0; });
    state = await mailState(frame);
    assert(state.filter((m) => m.subject === 'Fifth').length === 1, 'Fifth should be stored once: ' + JSON.stringify(state.map((m) => m.subject)));
    assert(counts.reduce((a, b) => a + b, 0) === 1, 'exactly one of the checks should report the new message, got ' + JSON.stringify(counts));
    console.log('PASS: no duplicates, counted once');

    console.log('STEP 5: the badge in the Social tab matches the stored unread count after all that');
    await frame.locator('#socialTabBtn').click();
    await frame.waitForFunction(() => document.getElementById('mailSubscreen').classList.contains('active'), null, { timeout: 5000 });
    await frame.locator('#checkMailNowBtn').click();
    await frame.waitForTimeout(800);
    const unread = (await mailState(frame)).filter((m) => !m.read).length;
    const badge = await frame.locator('#mailBadge').textContent();
    assert(String(unread) === badge, 'badge ' + badge + ' vs stored unread ' + unread);
    console.log('PASS: badge agrees with the stored state (' + unread + ' unread)');

    console.log('\nALL MAIL READ-STATE CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close();
    stopIssuer();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (err) { /* ignore */ }
    process.exit(process.exitCode || 0);
  }
})();
