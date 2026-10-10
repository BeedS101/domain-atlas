// PHP port of manual-email-ticket-send.js — SPEC.md §13's "entering the
// system" (POST /atlas/asset/transfer-to-email), exercised against an
// independent issuer-php bundle instead of issuer-server/server.js, per
// the chosen build order (Node first, proven out end to end, then ported
// once the design is settled — see SPEC.md §13 itself and the Node test's
// own header comment).
//
// Same isolated-bundle-copy pattern every other *-php.js test in this
// project already uses: issuer-php is copied into its own temp dir per
// run, so test state never touches the real tracked bundle. Unlike
// issuer-server/server.js (reads SMTP config fresh from environment
// variables at every call site, since the Node process is long-lived),
// this bundle has no persistent process to read those from — see
// lib/store.php's own atlas_email_tickets_config() comment — so the fake
// SMTP server's host/port/credentials are written into the copied
// bundle's lib/atlas-email-tickets-config.json instead, before php -S
// starts.
//
// This sandbox has no route to a real mail server (only outbound HTTPS
// through a policy-enforced proxy), so this talks to the same kind of
// tiny fake SMTP server the Node test already uses, with `secure: 'none'`
// — the one knob lib/smtp.php's own atlas_smtp_send_mail() comment says
// exists only for exactly this kind of test.
//
// Checks (identical in substance to the Node test's own five):
//   1. A non-fungible, non-bound credential sends cleanly: 200 response,
//      the original credential revoked (reason 'email-transferred'), and
//      the fake SMTP server received a real envelope and a DATA body
//      whose JSON attachment, decoded and checked against this PHP
//      bundle's own published key, is a genuinely valid fresh
//      domain-atlas-asset/1.0 credential for the same asset class.
//   2. A fungible credential (gold) is rejected outright — ineligible.
//   3. A malformed recipient address is rejected before anything is sent.
//   4. A second, independent bundle copy with no SMTP configured at all
//      rejects the same request with a clear "not configured" error.
//   6-8. Admin-only: see manual-email-ticket-send.js (same checks).
//   5. Delivery-check-before-revoke: the mail server rejecting RCPT TO
//      leaves the sender's original credential completely untouched.
//
// Not part of the permanent suite, same reasoning as every other
// manual-*.js script.

const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { webcrypto } = require('crypto');
const { withAdminAuth } = require('./lib/admin-auth');
const { subtle } = webcrypto;

const PHP_PORT = 8178; // isolated — distinct from every other manual-*.js test's chosen port
const PHP_PORT_UNCONFIGURED = 8179;
const SMTP_PORT = 8978;
const PHP_BASE = 'http://localhost:' + PHP_PORT;
const PHP_BASE_UNCONFIGURED = 'http://localhost:' + PHP_PORT_UNCONFIGURED;
const REJECT_RECIPIENT = 'rejected@example.com';

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
async function signWithSelf(kp, publicKey, payload) {
  const data = new TextEncoder().encode(canonicalize(payload));
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, data));
  return { signerRole: 'raw-ecdsa', publicKey, signature: b64url(sig) };
}
function postJson(base, urlPath, body) {
  return fetch(base + urlPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
    .then(async (r) => ({ status: r.status, body: await r.json() }));
}
async function issueAsset(base, ownerPublicKey, assetClass, quantity) {
  const res = await postJson(base, '/atlas/asset/issue', { ownerPublicKey, assetClass, ...(quantity ? { quantity } : {}) });
  if (res.status !== 200) throw new Error('Failed to issue ' + assetClass + ' at ' + base + ': ' + JSON.stringify(res.body));
  return res.body;
}
async function mailCheckStatus(base, who, credential) {
  const payload = { action: 'mail-check', domain: new URL(base).host, credentialIds: [credential.id], issuedAt: new Date().toISOString(), nonce: b64url(webcrypto.getRandomValues(new Uint8Array(18))) };
  const proof = await signWithSelf(who.kp, who.publicKey, payload);
  const res = await postJson(base, '/atlas/mail/check', { credentials: [credential], payload, proof });
  if (res.status !== 200) throw new Error('mail check failed: ' + JSON.stringify(res.body));
  return res.body.updates.find((u) => u.id === credential.id) || null;
}
// A credential nobody holds a key for (an emailed bearer one) is read from
// the public revocation list, which is all a stranger may learn.
async function publicStatus(base, id) {
  const doc = await (await fetch(base + '/.well-known/atlas-revocations.json')).json();
  const entry = (doc.revoked || []).find((r) => r.id === id);
  return entry ? { id, status: 'revoked', reason: entry.reason } : null;
}
async function adminSend(base, admin, payload) {
  payload = withAdminAuth(payload, base, '/atlas/admin/send-ticket-to-email');
  return postJson(base, '/atlas/admin/send-ticket-to-email', { payload, proof: await signWithSelf(admin.kp, admin.publicKey, payload) });
}
async function transferToEmail(base, credential, ownerKp, ownerPublicKey, recipientEmail) {
  const intentPayload = { credentialId: credential.id, recipientEmail, action: 'transfer-to-email' };
  const intentProof = await signWithSelf(ownerKp, ownerPublicKey, intentPayload);
  return postJson(base, '/atlas/asset/transfer-to-email', { credential, recipientEmail, intent: { payload: intentPayload, proof: intentProof } });
}

// ---------- fake SMTP server (same shape as the Node test's own) ----------
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

async function fetchDomainPublicKeys(base) {
  const res = await fetch(base + '/.well-known/atlas-key.json');
  const doc = await res.json();
  return doc.keys;
}
async function verifyCredentialSignature(base, credential) {
  const keys = await fetchDomainPublicKeys(base);
  const candidateKey = keys.find((k) => !k.validUntil);
  const rawBytes = Buffer.from(candidateKey.publicKey.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const publicKey = await subtle.importKey('raw', rawBytes, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
  const payload = { id: credential.id, asset: credential.asset, owner: credential.owner, quantity: credential.quantity, supersedes: credential.supersedes, issuedAt: credential.issuedAt };
  const data = new TextEncoder().encode(canonicalize(payload));
  const sigBytes = Buffer.from(credential.signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, sigBytes, data);
}

function startPhp(port, bundleDir) {
  return new Promise((resolve, reject) => {
    const proc = spawn('php', ['-S', 'localhost:' + port, 'test-router.php'], { cwd: bundleDir, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => reject(new Error('php -S did not start in time')), 5000);
    proc.stderr.on('data', (d) => { if (d.toString().includes('started')) { clearTimeout(timer); resolve(proc); } });
    proc.on('exit', (code) => reject(new Error('php -S exited early with code ' + code)));
  });
}

(async () => {
  console.log('SETUP: starting the fake SMTP server on port ' + SMTP_PORT);
  const { sessions } = await startFakeSmtpServer(SMTP_PORT);
  console.log('PASS: fake SMTP server up on port ' + SMTP_PORT);

  const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-email-ticket-php-'));
  const bundleDirUnconfigured = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-email-ticket-php-unconf-'));
  fs.cpSync(path.resolve(__dirname, '..', 'issuer-php'), bundleDir, { recursive: true });
  fs.cpSync(path.resolve(__dirname, '..', 'issuer-php'), bundleDirUnconfigured, { recursive: true });

  const smtpConfig = {
    smtpHost: '127.0.0.1',
    smtpPort: SMTP_PORT,
    smtpSecure: 'none',
    smtpUser: 'test-user',
    smtpPass: 'test-pass',
    fromAddress: 'tickets@test-domain.local'
  };
  fs.writeFileSync(path.join(bundleDir, 'lib', 'atlas-email-tickets-config.json'), JSON.stringify(smtpConfig, null, 2));
  // bundleDirUnconfigured deliberately gets no atlas-email-tickets-config.json
  // at all — the missing-file-means-disabled case atlas_email_tickets_config()
  // falls back to.

  console.log('SETUP: starting an isolated issuer-php bundle (SMTP configured) on port ' + PHP_PORT);
  const proc = await startPhp(PHP_PORT, bundleDir);
  console.log('PASS: issuer-php bundle up on port ' + PHP_PORT);

  console.log('SETUP: starting a second isolated issuer-php bundle (SMTP NOT configured) on port ' + PHP_PORT_UNCONFIGURED);
  const procUnconfigured = await startPhp(PHP_PORT_UNCONFIGURED, bundleDirUnconfigured);
  console.log('PASS: unconfigured issuer-php bundle up on port ' + PHP_PORT_UNCONFIGURED);

  try {
    const owner = await genIdentity();
    const admin = await genIdentity();
    const roster = JSON.stringify({ keys: [owner, admin].map((i) => ({ publicKey: i.publicKey, addedAt: new Date().toISOString() })) });
    fs.writeFileSync(path.join(bundleDir, 'lib', 'atlas-admin-keys-store.json'), roster);
    fs.writeFileSync(path.join(bundleDirUnconfigured, 'lib', 'atlas-admin-keys-store.json'), roster);

    console.log('STEP 1: an eligible credential sends cleanly — 200, original revoked, real SMTP envelope + valid attachment received');
    const ticket = await issueAsset(PHP_BASE, owner.publicKey, 'atlas.demo.attestation.filing');
    const sendRes = await transferToEmail(PHP_BASE, ticket, owner.kp, owner.publicKey, 'friend@example.com');
    assert(sendRes.status === 200, 'expected the send to succeed, got ' + sendRes.status + ': ' + JSON.stringify(sendRes.body));
    assert(sendRes.body.status === 'email-transferred', 'expected status "email-transferred", got: ' + JSON.stringify(sendRes.body));

    const originalStatus = await mailCheckStatus(PHP_BASE, owner, ticket);
    assert(originalStatus && originalStatus.status === 'revoked' && originalStatus.reason === 'email-transferred', 'expected the original credential revoked with reason "email-transferred", got: ' + JSON.stringify(originalStatus));
    console.log('PASS: original wallet credential revoked ->', JSON.stringify(originalStatus));

    assert(sessions.length === 1, 'expected exactly one SMTP session, got ' + sessions.length);
    const session = sessions[0];
    assert(session.mailFrom === '<tickets@test-domain.local>', 'expected MAIL FROM to carry the configured from-address, got: ' + session.mailFrom);
    assert(session.rcptTo[0] === '<friend@example.com>', 'expected RCPT TO to carry the recipient address, got: ' + session.rcptTo[0]);
    console.log('PASS: SMTP envelope correct -> MAIL FROM', session.mailFrom, 'RCPT TO', session.rcptTo[0]);

    const attachmentJson = parseMimeAttachment(session.data, null);
    assert(attachmentJson, 'expected to find an attachment in the DATA body');
    const mintedCredential = JSON.parse(attachmentJson);
    assert(mintedCredential.credential === 'domain-atlas-asset/1.0', 'expected the attachment to be a domain-atlas-asset/1.0 credential');
    assert(mintedCredential.asset.class === 'atlas.demo.attestation.filing', 'expected the attached credential to be the same class, got: ' + mintedCredential.asset.class);
    assert(mintedCredential.id !== ticket.id, 'expected the attached credential to be a fresh mint, not the original id');
    const sigOk = await verifyCredentialSignature(PHP_BASE, mintedCredential);
    assert(sigOk, 'expected the attached credential\'s signature to verify against this bundle\'s own published key');
    console.log('PASS: attached credential is a genuinely valid fresh mint ->', mintedCredential.id);

    console.log('STEP 2: a fungible credential (gold) is rejected outright, ineligible');
    const gold = await issueAsset(PHP_BASE, owner.publicKey, 'atlas.element.gold', 10);
    const goldRes = await transferToEmail(PHP_BASE, gold, owner.kp, owner.publicKey, 'friend@example.com');
    assert(goldRes.status === 400, 'expected a fungible credential to be rejected, got ' + goldRes.status);
    assert(/fungible/.test(goldRes.body.error || ''), 'expected a fungible-related rejection, got: ' + JSON.stringify(goldRes.body));
    console.log('PASS: fungible credential rejected ->', goldRes.body.error);

    console.log('STEP 3: a malformed recipient address is rejected before anything is sent');
    const anotherTicket = await issueAsset(PHP_BASE, owner.publicKey, 'atlas.demo.attestation.filing');
    const badEmailRes = await transferToEmail(PHP_BASE, anotherTicket, owner.kp, owner.publicKey, 'not-an-email-address');
    assert(badEmailRes.status === 400, 'expected a malformed address to be rejected, got ' + badEmailRes.status);
    const statusAfterBadEmail = await mailCheckStatus(PHP_BASE, owner, anotherTicket);
    assert(statusAfterBadEmail === null, 'expected the credential to be untouched after a rejected malformed address, got: ' + JSON.stringify(statusAfterBadEmail));
    console.log('PASS: malformed address rejected, nothing sent, credential untouched ->', badEmailRes.body.error);

    console.log('STEP 4: a bundle with no SMTP configured at all refuses the same request with a clear error');
    const ticketOnUnconfigured = await issueAsset(PHP_BASE_UNCONFIGURED, owner.publicKey, 'atlas.demo.attestation.filing');
    const unconfiguredRes = await transferToEmail(PHP_BASE_UNCONFIGURED, ticketOnUnconfigured, owner.kp, owner.publicKey, 'friend@example.com');
    assert(unconfiguredRes.status === 400, 'expected a 400 from the unconfigured bundle, got ' + unconfiguredRes.status);
    assert(/not configured/.test(unconfiguredRes.body.error || ''), 'expected a "not configured" error, got: ' + JSON.stringify(unconfiguredRes.body));
    console.log('PASS: unconfigured bundle refuses cleanly ->', unconfiguredRes.body.error);

    console.log('STEP 5: delivery-check-before-revoke — a mail server rejecting RCPT TO leaves the sender\'s original credential completely untouched');
    const ticketForRejectedSend = await issueAsset(PHP_BASE, owner.publicKey, 'atlas.demo.attestation.filing');
    const rejectedSendRes = await transferToEmail(PHP_BASE, ticketForRejectedSend, owner.kp, owner.publicKey, REJECT_RECIPIENT);
    assert(rejectedSendRes.status === 502, 'expected a 502 when the mail server rejects delivery, got ' + rejectedSendRes.status + ': ' + JSON.stringify(rejectedSendRes.body));
    const statusAfterRejectedSend = await mailCheckStatus(PHP_BASE, owner, ticketForRejectedSend);
    assert(statusAfterRejectedSend === null, 'expected the original credential to be completely untouched after a rejected delivery, got: ' + JSON.stringify(statusAfterRejectedSend));
    console.log('PASS: rejected delivery left the sender\'s credential untouched ->', rejectedSendRes.body.error);

    console.log('STEP 6: a holder who is not a domain admin cannot use transfer-to-email');
    const stranger = await genIdentity();
    const strangerTicket = await issueAsset(PHP_BASE, stranger.publicKey, 'atlas.demo.attestation.filing');
    const sessionsBefore6 = sessions.length;
    const strangerRes = await transferToEmail(PHP_BASE, strangerTicket, stranger.kp, stranger.publicKey, 'victim@example.com');
    assert(strangerRes.status === 403, 'expected a non-admin to be refused with 403, got ' + strangerRes.status + ': ' + JSON.stringify(strangerRes.body));
    assert(sessions.length === sessionsBefore6, 'no mail may be sent for a non-admin');
    assert((await mailCheckStatus(PHP_BASE, stranger, strangerTicket)) === null, 'the non-admin\'s credential must be untouched');
    console.log('PASS: refused, nothing sent, credential untouched ->', strangerRes.body.error);

    console.log('STEP 7: the admin send route mints a ticket straight to an address');
    const sessionsBefore7 = sessions.length;
    const sent = await adminSend(PHP_BASE, admin, { assetClass: 'atlas.demo.attestation.filing', recipientEmail: 'guest@example.com', properties: { 'com.example.seat': 'A-12' } });
    assert(sent.status === 200 && sent.body.status === 'email-sent' && sent.body.ticketId, 'expected the admin send to succeed, got ' + sent.status + ': ' + JSON.stringify(sent.body));
    assert(sessions.length === sessionsBefore7 + 1, 'expected one SMTP session');
    const sess7 = sessions[sessions.length - 1];
    assert(sess7.rcptTo[0] === '<guest@example.com>', 'expected RCPT TO guest@example.com, got ' + sess7.rcptTo[0]);
    const ticket7 = JSON.parse(parseMimeAttachment(sess7.data, null));
    assert(ticket7.id === sent.body.ticketId && ticket7.asset.class === 'atlas.demo.attestation.filing', 'the attachment should be the ticket the route reported');
    assert(ticket7.asset.properties && ticket7.asset.properties['com.example.seat'] === 'A-12', 'the starting fact should be on the ticket, got ' + JSON.stringify(ticket7.asset.properties));
    assert(ticket7.owner.publicKey !== admin.publicKey && ticket7.owner.publicKey !== owner.publicKey, 'the ticket must not be owned by the admin\'s key');
    assert(await verifyCredentialSignature(PHP_BASE, ticket7), 'the ticket should verify against the domain key');
    assert((await publicStatus(PHP_BASE, ticket7.id)) === null, 'the ticket should be live');
    console.log('PASS: ticket delivered with its starting fact, owned by a discarded key ->', ticket7.id);

    console.log('STEP 8: the admin send route refuses what it should');
    const ok = { assetClass: 'atlas.demo.attestation.filing', recipientEmail: 'guest@example.com' };
    const sessionsBefore8 = sessions.length;
    const notAdmin = await adminSend(PHP_BASE, stranger, ok);
    assert(notAdmin.status === 401, 'a non-admin signer should get 401, got ' + notAdmin.status);
    const fungible = await adminSend(PHP_BASE, admin, { ...ok, assetClass: 'atlas.element.gold' });
    assert(fungible.status === 400 && /unique|fungible/.test(fungible.body.error), 'a fungible class should be refused, got ' + JSON.stringify(fungible.body));
    const bound = await adminSend(PHP_BASE, admin, { ...ok, assetClass: 'atlas.demo.museum.ticket' });
    assert(bound.status === 400 && /bound/.test(bound.body.error), 'a bound class should be refused, got ' + JSON.stringify(bound.body));
    const badAddress = await adminSend(PHP_BASE, admin, { ...ok, recipientEmail: 'nope' });
    assert(badAddress.status === 400, 'a bad address should be refused, got ' + badAddress.status);
    const unknownClass = await adminSend(PHP_BASE, admin, { ...ok, assetClass: 'atlas.no.such.class' });
    assert(unknownClass.status === 400, 'an unknown class should be refused, got ' + unknownClass.status);
    const unconfigured = await adminSend(PHP_BASE_UNCONFIGURED, admin, ok);
    assert(unconfigured.status === 400 && /not configured/.test(unconfigured.body.error), 'an unconfigured domain should refuse, got ' + JSON.stringify(unconfigured.body));
    assert(sessions.length === sessionsBefore8, 'none of those may send mail');
    const revokedBefore = (JSON.parse(fs.readFileSync(path.join(bundleDir, '.well-known', 'atlas-revocations.json'), 'utf8')).revoked || []).length;
    const rejected = await adminSend(PHP_BASE, admin, { ...ok, recipientEmail: REJECT_RECIPIENT });
    assert(rejected.status === 502, 'a rejected delivery should be a 502, got ' + rejected.status + ': ' + JSON.stringify(rejected.body));
    const revokedAfter = JSON.parse(fs.readFileSync(path.join(bundleDir, '.well-known', 'atlas-revocations.json'), 'utf8')).revoked || [];
    assert(revokedAfter.length === revokedBefore + 1 && revokedAfter[revokedAfter.length - 1].reason === 'issuer-request', 'the undelivered mint should be revoked as issuer-request');
    console.log('PASS: non-admin, fungible, bad address, unknown class and unconfigured domain refused; a rejected delivery undid the mint');

    console.log('\nALL EMAIL-TICKET SEND (PHP) CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    proc.kill();
    procUnconfigured.kill();
    fs.rmSync(bundleDir, { recursive: true, force: true });
    fs.rmSync(bundleDirUnconfigured, { recursive: true, force: true });
    process.exit(process.exitCode || 0);
  }
})();
