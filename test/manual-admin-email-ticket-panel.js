// Manual check of the "Send a ticket by email" section of the admin panel
// (POST /atlas/admin/send-ticket-to-email), driven through the real panel in
// real Chrome against an isolated issuer-server with outbound email pointed
// at a fake SMTP server of its own.
//
// Checks:
//   1. Logged in as an admin through the wallet, the section is on the page;
//      a bad address or an unparseable properties patch is refused by the
//      page itself, with no request sent and no mail.
//   2. A valid class and address, with a starting fact, sends: the page says
//      so, the fake mail server receives one message to that address, and
//      its attachment is a ticket of that class carrying the fact.
//   3. A fungible class and an address the mail server rejects each show the
//      issuer's error in the page.
//
// Not part of the permanent suite, same reasoning as the other manual-*.js
// scripts.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const REPO = path.resolve(__dirname, '..');
const PORT = 8252;
const SMTP_PORT = 8982;
const DOMAIN = 'localhost:' + PORT;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-admin-email-ticket-'));
const DOCROOT_DIR = path.join(TMP, 'docroot');
const STATE_DIR = path.join(TMP, 'state');
const REJECT_RECIPIENT = 'rejected@example.com';

function assert(cond, message) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + message);
}

// ---------- fake SMTP server ----------
// Just enough protocol for lib-smtp.js's own client, nothing more — see
// this file's own header comment for exactly what's exercised.
function startFakeSmtpServer(port) {
  const sessions = [];
  const server = net.createServer((socket) => {
    const session = { rcptTo: [], mailFrom: null, data: '', rejected: false };
    sessions.push(session);
    let state = 'greeting';
    let dataBuffer = '';
    socket.write('220 fake-smtp ready\r\n');
    socket.on('data', (chunk) => {
      dataBuffer += chunk.toString('utf8');
      let idx;
      while ((idx = dataBuffer.indexOf('\r\n')) !== -1) {
        const line = dataBuffer.slice(0, idx);
        dataBuffer = dataBuffer.slice(idx + 2);
        handleLine(line);
      }
    });
    function handleLine(line) {
      if (state === 'data') {
        if (line === '.') {
          state = 'ready';
          socket.write('250 OK: message accepted\r\n');
          return;
        }
        session.data += (line.startsWith('..') ? line.slice(1) : line) + '\r\n';
        return;
      }
      if (/^EHLO/i.test(line)) {
        socket.write('250-fake-smtp greets you\r\n250 AUTH LOGIN\r\n');
      } else if (/^AUTH LOGIN/i.test(line)) {
        socket.write('334 VXNlcm5hbWU6\r\n');
        state = 'auth-user';
      } else if (state === 'auth-user') {
        socket.write('334 UGFzc3dvcmQ6\r\n');
        state = 'auth-pass';
      } else if (state === 'auth-pass') {
        socket.write('235 Authentication succeeded\r\n');
        state = 'ready';
      } else if (/^MAIL FROM:/i.test(line)) {
        session.mailFrom = line.replace(/^MAIL FROM:/i, '').trim();
        socket.write('250 OK\r\n');
      } else if (/^RCPT TO:/i.test(line)) {
        const addr = line.replace(/^RCPT TO:/i, '').trim();
        session.rcptTo.push(addr);
        if (addr.includes(REJECT_RECIPIENT)) {
          session.rejected = true;
          socket.write('550 No such recipient here\r\n');
        } else {
          socket.write('250 OK\r\n');
        }
      } else if (/^DATA/i.test(line)) {
        if (session.rejected) {
          socket.write('554 No valid recipients\r\n');
        } else {
          socket.write('354 Start mail input\r\n');
          state = 'data';
        }
      } else if (/^QUIT/i.test(line)) {
        socket.write('221 Bye\r\n');
        socket.end();
      } else {
        socket.write('250 OK\r\n');
      }
    }
  });
  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, sessions }));
    server.once('error', reject);
  });
}

function parseMimeAttachment(rawData, filename) {
  // rawData is "header: value\r\n...\r\n\r\n--boundary\r\n...--boundary--\r\n"
  const boundaryMatch = rawData.match(/boundary="([^"]+)"/);
  assert(boundaryMatch, 'expected a multipart boundary in the message headers');
  const boundary = boundaryMatch[1];
  const parts = rawData.split('--' + boundary);
  for (const part of parts) {
    if (part.includes('filename="' + filename + '"') || (filename === null && part.includes('Content-Disposition: attachment'))) {
      const bodyStart = part.indexOf('\r\n\r\n');
      const b64Body = part.slice(bodyStart + 4).replace(/\r?\n/g, '').trim();
      return Buffer.from(b64Body, 'base64').toString('utf8');
    }
  }
  return null;
}


let serverProc = null;
function startIssuer() {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', ['issuer-server/server.js'], {
      cwd: REPO, detached: true,
      env: {
        ...process.env, PORT: String(PORT), ATLAS_DOMAIN: DOMAIN, ATLAS_STATE_DIR: STATE_DIR, ATLAS_DOCROOT: DOCROOT_DIR,
        ATLAS_EMAIL_SMTP_HOST: '127.0.0.1', ATLAS_EMAIL_SMTP_PORT: String(SMTP_PORT), ATLAS_EMAIL_SMTP_SECURE: 'none',
        ATLAS_EMAIL_SMTP_USER: 'u', ATLAS_EMAIL_SMTP_PASS: 'p', ATLAS_EMAIL_FROM_ADDRESS: 'tickets@test-domain.local'
      },
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

(async () => {
  const { sessions } = await startFakeSmtpServer(SMTP_PORT);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.cpSync(path.join(REPO, 'demo-domain-a'), DOCROOT_DIR, { recursive: true });
  const manifestPath = path.join(DOCROOT_DIR, '.well-known', 'spatial.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.domain = DOMAIN;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  await startIssuer();
  console.log('SETUP: isolated issuer-server on port ' + PORT + ' with outbound email pointed at a fake SMTP server');

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
    await frame.locator('#newPasswordInput').fill('admin-email-ticket-password');
    await frame.locator('#newPasswordConfirmInput').fill('admin-email-ticket-password');
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), null, { timeout: 5000 });
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), null, { timeout: 5000 });
    const identity = await frame.evaluate(() => AtlasWallet.getIdentity());
    fs.writeFileSync(path.join(STATE_DIR, 'atlas-admin-keys-store.json'), JSON.stringify({ keys: [{ publicKey: identity.publicKey, addedAt: new Date().toISOString() }] }));
    await frame.evaluate(() => refreshAdminButtonVisibility());
    await frame.waitForFunction(() => document.getElementById('adminBtn').style.display !== 'none', null, { timeout: 5000 });
    await frame.locator('#adminBtn').click();
    await page.waitForURL('**/atlas-admin/**', { timeout: 10000 });
    await page.waitForFunction(() => !document.getElementById('loggedOutNotice') || document.getElementById('loggedOutNotice').style.display === 'none', null, { timeout: 10000 });
    console.log('SETUP: logged in to the admin panel');

    const requests = [];
    page.on('request', (r) => { if (r.url().includes('/atlas/admin/send-ticket-to-email')) requests.push(r.url()); });
    const result = () => page.locator('#emailTicketResult');
    async function send(cls, to, props) {
      await page.locator('#emailTicketClass').fill(cls);
      await page.locator('#emailTicketTo').fill(to);
      await page.locator('#emailTicketProperties').fill(props || '');
      await page.locator('#emailTicketBtn').click();
    }

    console.log('STEP 1: the page refuses a bad address or a bad properties patch itself');
    await send('atlas.demo.attestation.filing', 'not-an-address');
    await page.waitForFunction(() => /valid email address/.test(document.getElementById('emailTicketResult').textContent), null, { timeout: 5000 });
    await send('atlas.demo.attestation.filing', 'guest@example.com', '{nope');
    await page.waitForFunction(() => /does not parse/.test(document.getElementById('emailTicketResult').textContent), null, { timeout: 5000 });
    assert(requests.length === 0 && sessions.length === 0, 'neither mistake may reach the server or send mail');
    console.log('PASS: refused in the page, nothing sent');

    console.log('STEP 2: a valid send reaches the mail server with a ticket carrying the starting fact');
    await send('atlas.demo.attestation.filing', 'guest@example.com', '{"com.example.seat": "A-12"}');
    await page.waitForFunction(() => /^Sent /.test(document.getElementById('emailTicketResult').textContent), null, { timeout: 15000 });
    assert(/ok/.test((await result().getAttribute('class')) || ''), 'the result should be styled as a success');
    assert(sessions.length === 1 && sessions[0].rcptTo[0] === '<guest@example.com>', 'expected one message to guest@example.com, got ' + JSON.stringify(sessions.map((s) => s.rcptTo)));
    const ticket = JSON.parse(parseMimeAttachment(sessions[0].data, null));
    assert(ticket.asset.class === 'atlas.demo.attestation.filing' && ticket.asset.properties['com.example.seat'] === 'A-12', 'the attachment should be the requested ticket with its fact, got ' + JSON.stringify(ticket.asset));
    console.log('PASS: ticket emailed ->', ticket.id);

    console.log('STEP 3: the issuer\'s refusals are shown in the page');
    await send('atlas.element.gold', 'guest@example.com');
    await page.waitForFunction(() => /unique/.test(document.getElementById('emailTicketResult').textContent), null, { timeout: 10000 });
    await send('atlas.demo.attestation.filing', REJECT_RECIPIENT);
    await page.waitForFunction(() => /could not deliver/.test(document.getElementById('emailTicketResult').textContent), null, { timeout: 15000 });
    assert(/err/.test((await result().getAttribute('class')) || ''), 'the failure should be styled as an error');
    console.log('PASS: fungible class and rejected delivery both reported');

    console.log('\nALL ADMIN EMAIL TICKET PANEL CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close().catch(() => {});
    stopIssuer();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (err) { /* ignore */ }
    process.exit(process.exitCode || 0);
  }
})();
