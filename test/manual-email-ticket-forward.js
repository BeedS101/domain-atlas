// Regression test for SPEC.md §13.3 — the inbound half of the email-
// delivered bearer credential feature: a holder forwards their ticket
// email with the new holder CC'd, the issuer notices on its next IMAP
// poll, and possession passes on exactly the way a wallet-to-wallet
// transfer would, minus any wallet on the receiving end. Node only this
// round, same build order as the outbound slice (manual-email-ticket-
// send.js).
//
// Like that test, this sandbox has no route to a real mail server, so
// both directions talk to fake local servers of this file's own: a tiny
// fake SMTP server (same shape as manual-email-ticket-send.js's own) for
// delivering the forwarded-to credential, and a tiny fake IMAP server
// speaking just enough of the protocol for lib-imap.js's own client to
// complete a real conversation against: greeting, LOGIN, SELECT INBOX,
// SEARCH UNSEEN, FETCH (RFC822) with a real byte-literal, STORE +FLAGS
// (\Seen), LOGOUT. Each check seeds the fake mailbox with one already-
// built forward message (built with lib-smtp.js's own buildMimeMessage,
// the exact counterpart lib-mime-parse.js is meant to read back out) and
// then calls POST /atlas/admin/email-tickets/poll-now — the deterministic
// test hook pollEmailTicketsOnce() is built for — instead of waiting on a
// real timer.
//
// Checks:
//   1. A clean single-CC forward: the new holder's address receives a
//      fresh, validly signed credential over real SMTP, and the
//      forwarded-from credential is revoked (reason 'email-transferred').
//   2. A forward CC'ing more than one address is denied — a redacted
//      reply goes back to the forwarder, and the forwarded-from
//      credential is left untouched.
//   3. A forward of an already-superseded ticket (the exact message from
//      check 1, replayed) is denied as "already moved on" — a redacted
//      reply goes back that never names the real current holder.
//   4. A forward with no CC at all is a silent no-op — nothing sent,
//      nothing revoked.
//   5. Delivery-check-before-revoke on the forward path: the mail server
//      rejecting RCPT TO for the new holder leaves the forwarded-from
//      credential completely untouched.
//   6. Ongoing bounce monitoring (VERP): a correlated bounce against a
//      completed forward revokes the bounced credential (reason
//      'bounced') and reissues an equivalent one back to whoever sent
//      the original forward, over real SMTP, without naming the address
//      delivery actually failed to reach.
//   7. A bounce-shaped message naming no in-flight send at all (an
//      unrecognized or forged Return-Path) is a silent no-op.
//   8. A bounce arriving for a ticket already resolved some other way
//      (forwarded on again successfully in the meantime) is a no-op too
//      — its already-recorded status is left exactly as it was.
//   9. An ordinary credential (never minted as an email ticket) emailed
//      in with a CC is ignored: nothing sent, nothing revoked.
//  10. A ticket reissued after a bounce forwards once; a replay is refused.
//
// Not part of the permanent suite, same reasoning as every other
// manual-*.js script.

const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;
const { buildMimeMessage } = require('../issuer-server/lib-smtp');
const { withAdminAuth } = require('./lib/admin-auth');

const PORT = 8177; // isolated — distinct from every other manual-*.js test's chosen port
const SMTP_PORT = 8976;
const IMAP_PORT = 8977;
const DOMAIN = 'localhost:' + PORT;
const BASE = 'http://' + DOMAIN;
const INTAKE_ADDRESS = 'tickets@test-domain.local';
const IMAP_USER = 'tickets@test-domain.local';
const IMAP_PASS = 'imap-test-pass';
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
  if (res.status !== 200) throw new Error('Failed to issue ' + assetClass + ': ' + JSON.stringify(res.body));
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
async function transferToEmail(base, credential, ownerKp, ownerPublicKey, recipientEmail) {
  const intentPayload = { credentialId: credential.id, recipientEmail, action: 'transfer-to-email' };
  const intentProof = await signWithSelf(ownerKp, ownerPublicKey, intentPayload);
  const res = await postJson(base, '/atlas/asset/transfer-to-email', { credential, recipientEmail, intent: { payload: intentPayload, proof: intentProof } });
  if (res.status !== 200) throw new Error('transfer-to-email failed: ' + JSON.stringify(res.body));
  return res.body;
}
async function pollNow(base, admin) {
  const payload = withAdminAuth({ action: 'poll-now' }, base, '/atlas/admin/email-tickets/poll-now');
  const proof = await signWithSelf(admin.kp, admin.publicKey, payload);
  return postJson(base, '/atlas/admin/email-tickets/poll-now', { payload, proof });
}

// ---------- fake SMTP server (same shape as manual-email-ticket-send.js's own) ----------
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

// ---------- fake IMAP server ----------
// Just enough of the protocol for lib-imap.js's own client, nothing more
// — see this file's own header comment for exactly what's exercised.
// `mailbox` is a plain array of {raw, seen} the test pushes into directly
// between poll-now calls; sequence numbers are just 1-based positions in
// this array, same convention IMAP itself uses for an un-expunged mailbox.
function startFakeImapServer(port, { user, pass }) {
  const mailbox = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.write('* OK fake-imap ready\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      let idx;
      while ((idx = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        handleLine(line);
      }
    });
    function reply(tag, text) {
      socket.write(tag + ' ' + text + '\r\n');
    }
    function handleLine(line) {
      const sp = line.indexOf(' ');
      if (sp === -1) return;
      const tag = line.slice(0, sp);
      const rest = line.slice(sp + 1);
      if (/^LOGIN\s/i.test(rest)) {
        const m = rest.match(/^LOGIN\s+"((?:[^"\\]|\\.)*)"\s+"((?:[^"\\]|\\.)*)"/i);
        if (m && m[1] === user && m[2] === pass) reply(tag, 'OK LOGIN completed');
        else reply(tag, 'NO LOGIN failed');
      } else if (/^SELECT INBOX/i.test(rest)) {
        socket.write('* ' + mailbox.length + ' EXISTS\r\n');
        socket.write('* 0 RECENT\r\n');
        reply(tag, 'OK [READ-WRITE] SELECT completed');
      } else if (/^SEARCH UNSEEN/i.test(rest)) {
        const nums = [];
        mailbox.forEach((m, i) => { if (!m.seen) nums.push(i + 1); });
        socket.write('* SEARCH' + (nums.length ? ' ' + nums.join(' ') : '') + '\r\n');
        reply(tag, 'OK SEARCH completed');
      } else if (/^FETCH\s+(\d+)\s+\(RFC822\)/i.test(rest)) {
        const seq = parseInt(rest.match(/^FETCH\s+(\d+)/i)[1], 10);
        const msg = mailbox[seq - 1];
        if (!msg) {
          reply(tag, 'NO no such message');
          return;
        }
        const rawBuf = Buffer.from(msg.raw, 'latin1');
        socket.write('* ' + seq + ' FETCH (RFC822 {' + rawBuf.length + '}\r\n');
        socket.write(rawBuf);
        socket.write(')\r\n');
        reply(tag, 'OK FETCH completed');
      } else if (/^STORE\s+(\d+)\s+\+FLAGS/i.test(rest)) {
        const seq = parseInt(rest.match(/^STORE\s+(\d+)/i)[1], 10);
        if (mailbox[seq - 1]) mailbox[seq - 1].seen = true;
        reply(tag, 'OK STORE completed');
      } else if (/^LOGOUT/i.test(rest)) {
        socket.write('* BYE logging out\r\n');
        reply(tag, 'OK LOGOUT completed');
        socket.end();
      } else {
        reply(tag, 'BAD unknown command');
      }
    }
  });
  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, mailbox }));
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
async function verifyCredentialSignature(credential) {
  const keys = await fetchDomainPublicKeys(BASE);
  const candidateKey = keys.find((k) => !k.validUntil);
  const rawBytes = Buffer.from(candidateKey.publicKey.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const publicKey = await subtle.importKey('raw', rawBytes, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
  const payload = { id: credential.id, asset: credential.asset, owner: credential.owner, quantity: credential.quantity, supersedes: credential.supersedes, issuedAt: credential.issuedAt };
  const data = new TextEncoder().encode(canonicalize(payload));
  const sigBytes = Buffer.from(credential.signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, sigBytes, data);
}

// Builds one raw RFC822 forward message carrying `credential` as a JSON
// attachment, From the current holder, CC'ing `ccAddresses` (an array —
// zero, one, or more).
function buildForwardMessage(fromAddress, ccAddresses, credential) {
  return buildMimeMessage({
    from: fromAddress,
    to: INTAKE_ADDRESS,
    subject: 'Fwd: your ticket',
    textBody: 'Passing this along.',
    attachments: [{ filename: 'ticket-' + credential.id.split(':').pop() + '.json', contentType: 'application/json', content: JSON.stringify(credential) }],
    extraHeaders: ccAddresses.length ? ['Cc: ' + ccAddresses.join(', ')] : []
  });
}

// Mirrors server.js's own verpReturnPathFor() exactly — the address a
// correlated bounce against `ticketId` would be addressed back to.
function verpAddressFor(ticketId) {
  const at = INTAKE_ADDRESS.indexOf('@');
  const localPart = INTAKE_ADDRESS.slice(0, at);
  const domainPart = INTAKE_ADDRESS.slice(at + 1);
  return localPart + '+bounce-' + ticketId.split(':').pop() + '@' + domainPart;
}
// A real bounce (DSN) is a lot more elaborate than this, but
// extractBouncedTicketId() only ever looks at the "To" header, never the
// body — this is the minimum shape that exercises exactly that.
function buildBounceMessage(ticketId) {
  return buildMimeMessage({
    from: 'mailer-daemon@relay.example',
    to: verpAddressFor(ticketId),
    subject: 'Undelivered Mail Returned to Sender',
    textBody: 'Delivery to the following recipient failed permanently.',
    attachments: []
  });
}

function startIssuer({ port, domain, stateDir, docrootDir, extraEnv }) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', ['issuer-server/server.js'], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, PORT: String(port), ATLAS_DOMAIN: domain, ATLAS_STATE_DIR: stateDir, ATLAS_DOCROOT: docrootDir, ...(extraEnv || {}) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const timer = setTimeout(() => reject(new Error('issuer-server did not start in time')), 10000);
    proc.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); resolve(proc); } });
    proc.on('exit', (code) => reject(new Error('issuer-server exited early with code ' + code)));
  });
}

(async () => {
  console.log('SETUP: starting the fake SMTP server on port ' + SMTP_PORT);
  const { sessions } = await startFakeSmtpServer(SMTP_PORT);
  console.log('PASS: fake SMTP server up on port ' + SMTP_PORT);

  console.log('SETUP: starting the fake IMAP server on port ' + IMAP_PORT);
  const { mailbox } = await startFakeImapServer(IMAP_PORT, { user: IMAP_USER, pass: IMAP_PASS });
  console.log('PASS: fake IMAP server up on port ' + IMAP_PORT);

  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-email-ticket-fwd-state-'));
  const docrootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-email-ticket-fwd-docroot-'));

  const admin = await genIdentity();
  fs.writeFileSync(path.join(stateDir, 'atlas-admin-keys-store.json'), JSON.stringify({ keys: [{ publicKey: admin.publicKey, addedAt: new Date().toISOString() }] }, null, 2));

  const extraEnv = {
    ATLAS_EMAIL_SMTP_HOST: '127.0.0.1',
    ATLAS_EMAIL_SMTP_PORT: String(SMTP_PORT),
    ATLAS_EMAIL_SMTP_SECURE: 'none',
    ATLAS_EMAIL_SMTP_USER: 'test-user',
    ATLAS_EMAIL_SMTP_PASS: 'test-pass',
    ATLAS_EMAIL_FROM_ADDRESS: INTAKE_ADDRESS,
    ATLAS_EMAIL_IMAP_HOST: '127.0.0.1',
    ATLAS_EMAIL_IMAP_PORT: String(IMAP_PORT),
    ATLAS_EMAIL_IMAP_SECURE: 'none',
    ATLAS_EMAIL_IMAP_USER: IMAP_USER,
    ATLAS_EMAIL_IMAP_PASS: IMAP_PASS,
    // Long enough that the background timer never fires during this test
    // — every poll below goes through the deterministic poll-now endpoint.
    ATLAS_EMAIL_IMAP_POLL_MS: String(10 * 60 * 1000)
  };

  console.log('SETUP: starting an isolated issuer-server instance (SMTP + IMAP configured) on port ' + PORT);
  const proc = await startIssuer({ port: PORT, domain: DOMAIN, stateDir, docrootDir, extraEnv });
  console.log('PASS: issuer-server up on port ' + PORT);

  try {
    const owner = admin; // only an admin may send a ticket to an email address;

    console.log('STEP 1: a clean single-CC forward transfers the ticket over real SMTP, forwarded-from credential revoked');
    const ticket1 = await issueAsset(BASE, owner.publicKey, 'atlas.demo.attestation.filing');
    const sent1 = await transferToEmail(BASE, ticket1, owner.kp, owner.publicKey, 'holder1@example.com');
    const credential1Json = parseMimeAttachment(sessions[0].data, null);
    const credential1 = JSON.parse(credential1Json);
    assert(credential1.id !== ticket1.id, 'expected the emailed credential to be a fresh mint');

    mailbox.push({ raw: buildForwardMessage('holder1@example.com', ['holder2@example.com'], credential1), seen: false });
    const poll1 = await pollNow(BASE, admin);
    assert(poll1.status === 200, 'expected poll-now to succeed, got ' + poll1.status + ': ' + JSON.stringify(poll1.body));
    assert(poll1.body.summary.transferred === 1, 'expected exactly one transfer, got: ' + JSON.stringify(poll1.body.summary));

    const credential1Status = await publicStatus(BASE, credential1.id);
    assert(credential1Status && credential1Status.status === 'revoked' && credential1Status.reason === 'email-transferred', 'expected the forwarded-from credential revoked with reason "email-transferred", got: ' + JSON.stringify(credential1Status));

    assert(sessions.length === 2, 'expected a second SMTP session for the forward delivery, got ' + sessions.length);
    const forwardSession = sessions[1];
    assert(forwardSession.rcptTo[0] === '<holder2@example.com>', 'expected the forward to deliver to the CC\'d address, got: ' + forwardSession.rcptTo[0]);
    const credential2Json = parseMimeAttachment(forwardSession.data, null);
    const credential2 = JSON.parse(credential2Json);
    assert(credential2.id !== credential1.id, 'expected a fresh mint for the new holder, not the forwarded credential itself');
    const sig2Ok = await verifyCredentialSignature(credential2);
    assert(sig2Ok, 'expected the newly minted credential\'s signature to verify against this domain\'s own published key');
    console.log('PASS: clean forward transferred the ticket ->', credential2.id, 'to', forwardSession.rcptTo[0]);

    console.log('STEP 2: a forward CC\'ing more than one address is denied, forwarded-from credential untouched');
    const ticket3 = await issueAsset(BASE, owner.publicKey, 'atlas.demo.attestation.filing');
    await transferToEmail(BASE, ticket3, owner.kp, owner.publicKey, 'holder3@example.com');
    const credential3 = JSON.parse(parseMimeAttachment(sessions[2].data, null));

    mailbox.push({ raw: buildForwardMessage('holder3@example.com', ['holder4@example.com', 'holder5@example.com'], credential3), seen: false });
    const poll2 = await pollNow(BASE, admin);
    assert(poll2.body.summary.denied === 1, 'expected exactly one denial for a multi-CC forward, got: ' + JSON.stringify(poll2.body.summary));
    const credential3Status = await publicStatus(BASE, credential3.id);
    assert(credential3Status === null, 'expected the multi-CC forward to leave the credential untouched, got: ' + JSON.stringify(credential3Status));
    assert(sessions.length === 4, 'expected one more SMTP session for the denial reply, got ' + sessions.length);
    const denialSession1 = sessions[3];
    assert(denialSession1.rcptTo[0] === '<holder3@example.com>', 'expected the denial reply to go back to the forwarder, got: ' + denialSession1.rcptTo[0]);
    assert(!parseMimeAttachment(denialSession1.data, null), 'expected the denial reply to carry no attachment');
    console.log('PASS: multi-CC forward denied, credential untouched, redacted reply sent to the forwarder');

    console.log('STEP 3: forwarding an already-superseded ticket is denied as "already moved on", without naming the real destination');
    mailbox.push({ raw: buildForwardMessage('holder1@example.com', ['holder6@example.com'], credential1), seen: false });
    const poll3 = await pollNow(BASE, admin);
    assert(poll3.body.summary.denied === 1, 'expected exactly one denial for the stale forward, got: ' + JSON.stringify(poll3.body.summary));
    assert(sessions.length === 5, 'expected one more SMTP session for the stale-forward denial reply, got ' + sessions.length);
    const denialSession2 = sessions[4];
    assert(denialSession2.rcptTo[0] === '<holder1@example.com>', 'expected the denial reply to go back to the forwarder, got: ' + denialSession2.rcptTo[0]);
    assert(!denialSession2.data.includes('holder2@example.com'), 'expected the denial reply to never name the real current holder');
    const credential1StatusAfterReplay = await publicStatus(BASE, credential1.id);
    assert(credential1StatusAfterReplay && credential1StatusAfterReplay.reason === 'email-transferred', 'expected the already-transferred credential\'s status to stay exactly as it was, got: ' + JSON.stringify(credential1StatusAfterReplay));
    console.log('PASS: stale forward denied without revealing the real current holder');

    console.log('STEP 4: a forward with no CC at all is a silent no-op');
    const ticket4 = await issueAsset(BASE, owner.publicKey, 'atlas.demo.attestation.filing');
    await transferToEmail(BASE, ticket4, owner.kp, owner.publicKey, 'holder7@example.com');
    const credential4 = JSON.parse(parseMimeAttachment(sessions[5].data, null));

    mailbox.push({ raw: buildForwardMessage('holder7@example.com', [], credential4), seen: false });
    const sessionsBeforePoll4 = sessions.length;
    const poll4 = await pollNow(BASE, admin);
    assert(poll4.body.summary.ignored === 1, 'expected exactly one ignored message for a no-CC forward, got: ' + JSON.stringify(poll4.body.summary));
    assert(sessions.length === sessionsBeforePoll4, 'expected a no-CC forward to send nothing at all, got ' + (sessions.length - sessionsBeforePoll4) + ' new SMTP session(s)');
    const credential4Status = await publicStatus(BASE, credential4.id);
    assert(credential4Status === null, 'expected a no-CC forward to leave the credential untouched, got: ' + JSON.stringify(credential4Status));
    console.log('PASS: no-CC forward was a true no-op — nothing sent, nothing revoked');

    console.log('STEP 5: delivery-check-before-revoke — a mail server rejecting RCPT TO for the new holder leaves the forwarded-from credential untouched');
    const ticket5 = await issueAsset(BASE, owner.publicKey, 'atlas.demo.attestation.filing');
    await transferToEmail(BASE, ticket5, owner.kp, owner.publicKey, 'holder8@example.com');
    const credential5 = JSON.parse(parseMimeAttachment(sessions[6].data, null));

    mailbox.push({ raw: buildForwardMessage('holder8@example.com', [REJECT_RECIPIENT], credential5), seen: false });
    const poll5 = await pollNow(BASE, admin);
    assert(poll5.body.summary.failed === 1, 'expected exactly one failure for a forward the mail server rejects, got: ' + JSON.stringify(poll5.body.summary));
    const credential5Status = await publicStatus(BASE, credential5.id);
    assert(credential5Status === null, 'expected the forwarded-from credential to be completely untouched after a rejected delivery, got: ' + JSON.stringify(credential5Status));
    console.log('PASS: rejected forward delivery left the forwarded-from credential untouched');

    console.log('STEP 6: a correlated bounce (VERP) reverses a completed forward — bounced credential revoked, an equivalent one reissued to the original forwarder');
    const ticket6 = await issueAsset(BASE, owner.publicKey, 'atlas.demo.attestation.filing');
    await transferToEmail(BASE, ticket6, owner.kp, owner.publicKey, 'holder9@example.com');
    const credential6 = JSON.parse(parseMimeAttachment(sessions[sessions.length - 1].data, null));

    mailbox.push({ raw: buildForwardMessage('holder9@example.com', ['holder10@example.com'], credential6), seen: false });
    const poll6a = await pollNow(BASE, admin);
    assert(poll6a.body.summary.transferred === 1, 'expected the forward itself to transfer cleanly, got: ' + JSON.stringify(poll6a.body.summary));
    const forwardSession6 = sessions[sessions.length - 1];
    assert(forwardSession6.rcptTo[0] === '<holder10@example.com>', 'expected the forward to deliver to holder10, got: ' + forwardSession6.rcptTo[0]);
    const minted6 = JSON.parse(parseMimeAttachment(forwardSession6.data, null));

    const sessionsBeforeBounce6 = sessions.length;
    mailbox.push({ raw: buildBounceMessage(minted6.id), seen: false });
    const poll6b = await pollNow(BASE, admin);
    assert(poll6b.body.summary.bounced === 1, 'expected exactly one bounce reversal, got: ' + JSON.stringify(poll6b.body.summary));

    const minted6Status = await publicStatus(BASE, minted6.id);
    assert(minted6Status && minted6Status.status === 'revoked' && minted6Status.reason === 'bounced', 'expected the bounced credential revoked with reason "bounced", got: ' + JSON.stringify(minted6Status));

    assert(sessions.length === sessionsBeforeBounce6 + 1, 'expected exactly one new SMTP session for the bounce reissue, got ' + (sessions.length - sessionsBeforeBounce6));
    const reissueSession = sessions[sessions.length - 1];
    assert(reissueSession.rcptTo[0] === '<holder9@example.com>', 'expected the reissue to go back to the original forwarder, got: ' + reissueSession.rcptTo[0]);
    assert(!reissueSession.data.includes('holder10@example.com'), 'expected the reissue notice to never name the address delivery actually failed to reach');
    const reissuedCredential = JSON.parse(parseMimeAttachment(reissueSession.data, null));
    assert(reissuedCredential.id !== minted6.id && reissuedCredential.id !== credential6.id, 'expected the reissue to be yet another fresh mint');
    assert(reissuedCredential.asset.class === credential6.asset.class, 'expected the reissued credential to carry the same asset class, got: ' + reissuedCredential.asset.class);
    const reissueSigOk = await verifyCredentialSignature(reissuedCredential);
    assert(reissueSigOk, 'expected the reissued credential\'s signature to verify against this domain\'s own published key');
    console.log('PASS: bounce reversed — bounced credential revoked, equivalent ticket reissued to', reissueSession.rcptTo[0]);

    console.log('STEP 7: a bounce-shaped message naming no in-flight send at all is a silent no-op');
    const sessionsBeforePoll7 = sessions.length;
    mailbox.push({ raw: buildBounceMessage('urn:atlas:asset:' + webcrypto.randomUUID()), seen: false });
    const poll7 = await pollNow(BASE, admin);
    assert(poll7.body.summary.ignored === 1, 'expected the unrecognized bounce to be ignored, got: ' + JSON.stringify(poll7.body.summary));
    assert(sessions.length === sessionsBeforePoll7, 'expected an unrecognized bounce to send nothing at all, got ' + (sessions.length - sessionsBeforePoll7) + ' new SMTP session(s)');
    console.log('PASS: bounce naming no in-flight send was a true no-op');

    console.log('STEP 8: a bounce for a ticket already resolved some other way leaves its recorded status exactly as it was');
    const ticket8 = await issueAsset(BASE, owner.publicKey, 'atlas.demo.attestation.filing');
    await transferToEmail(BASE, ticket8, owner.kp, owner.publicKey, 'holder11@example.com');
    const credential8 = JSON.parse(parseMimeAttachment(sessions[sessions.length - 1].data, null));

    mailbox.push({ raw: buildForwardMessage('holder11@example.com', ['holder12@example.com'], credential8), seen: false });
    const poll8a = await pollNow(BASE, admin);
    assert(poll8a.body.summary.transferred === 1, 'expected the setup forward to transfer cleanly, got: ' + JSON.stringify(poll8a.body.summary));
    const minted8 = JSON.parse(parseMimeAttachment(sessions[sessions.length - 1].data, null));

    // minted8 moves on again, successfully, before any bounce for it ever
    // arrives — exactly the "already resolved some other way" case.
    mailbox.push({ raw: buildForwardMessage('holder12@example.com', ['holder13@example.com'], minted8), seen: false });
    const poll8b = await pollNow(BASE, admin);
    assert(poll8b.body.summary.transferred === 1, 'expected the second forward to also transfer cleanly, got: ' + JSON.stringify(poll8b.body.summary));
    const minted8StatusBeforeBounce = await publicStatus(BASE, minted8.id);
    assert(minted8StatusBeforeBounce && minted8StatusBeforeBounce.reason === 'email-transferred', 'expected minted8 revoked as "email-transferred" by the second forward, got: ' + JSON.stringify(minted8StatusBeforeBounce));

    const sessionsBeforePoll8c = sessions.length;
    mailbox.push({ raw: buildBounceMessage(minted8.id), seen: false });
    const poll8c = await pollNow(BASE, admin);
    assert(poll8c.body.summary.ignored === 1, 'expected a bounce for an already-resolved ticket to be ignored, got: ' + JSON.stringify(poll8c.body.summary));
    assert(sessions.length === sessionsBeforePoll8c, 'expected a moot bounce to send nothing at all, got ' + (sessions.length - sessionsBeforePoll8c) + ' new SMTP session(s)');
    const minted8StatusAfterBounce = await publicStatus(BASE, minted8.id);
    assert(minted8StatusAfterBounce && minted8StatusAfterBounce.reason === 'email-transferred', 'expected the already-resolved ticket\'s status to stay exactly as it was, got: ' + JSON.stringify(minted8StatusAfterBounce));
    console.log('PASS: bounce for an already-resolved ticket left its recorded status untouched');

    console.log('STEP 9: an ordinary credential (not minted as an email ticket) cannot be moved by emailing it in');
    const ordinary = await issueAsset(BASE, owner.publicKey, 'atlas.demo.attestation.filing');
    const sessionsBeforePoll9 = sessions.length;
    mailbox.push({ raw: buildForwardMessage('thief@example.com', ['accomplice@example.com'], ordinary), seen: false });
    const poll9 = await pollNow(BASE, admin);
    assert(poll9.body.summary.ignored === 1 && !poll9.body.summary.transferred, 'expected the ordinary credential to be ignored, got: ' + JSON.stringify(poll9.body.summary));
    assert(sessions.length === sessionsBeforePoll9, 'expected nothing to be sent for an ordinary credential, got ' + (sessions.length - sessionsBeforePoll9) + ' new SMTP session(s)');
    const ordinaryStatus = await mailCheckStatus(BASE, owner, ordinary);
    assert(ordinaryStatus === null, 'expected the ordinary credential to be untouched, got: ' + JSON.stringify(ordinaryStatus));
    console.log('PASS: ordinary credential ignored, nothing sent, nothing revoked');

    console.log('STEP 10: a ticket reissued after a bounce can itself be forwarded, and only once');
    const ticket10 = await issueAsset(BASE, owner.publicKey, 'atlas.demo.attestation.filing');
    await transferToEmail(BASE, ticket10, owner.kp, owner.publicKey, 'holder14@example.com');
    const credential10 = JSON.parse(parseMimeAttachment(sessions[sessions.length - 1].data, null));
    mailbox.push({ raw: buildForwardMessage('holder14@example.com', ['holder15@example.com'], credential10), seen: false });
    await pollNow(BASE, admin);
    const minted10 = JSON.parse(parseMimeAttachment(sessions[sessions.length - 1].data, null));
    mailbox.push({ raw: buildBounceMessage(minted10.id), seen: false });
    const poll10b = await pollNow(BASE, admin);
    assert(poll10b.body.summary.bounced === 1, 'expected the bounce to be reversed, got: ' + JSON.stringify(poll10b.body.summary));
    const reissued10 = JSON.parse(parseMimeAttachment(sessions[sessions.length - 1].data, null));
    mailbox.push({ raw: buildForwardMessage('holder14@example.com', ['holder16@example.com'], reissued10), seen: false });
    const poll10c = await pollNow(BASE, admin);
    assert(poll10c.body.summary.transferred === 1, 'expected the reissued ticket to forward, got: ' + JSON.stringify(poll10c.body.summary));
    assert(sessions[sessions.length - 1].rcptTo[0] === '<holder16@example.com>', 'expected delivery to holder16, got: ' + sessions[sessions.length - 1].rcptTo[0]);
    const sessionsBeforePoll10d = sessions.length;
    mailbox.push({ raw: buildForwardMessage('holder14@example.com', ['holder17@example.com'], reissued10), seen: false });
    const poll10d = await pollNow(BASE, admin);
    assert(!poll10d.body.summary.transferred, 'expected a second forward of the same ticket not to transfer, got: ' + JSON.stringify(poll10d.body.summary));
    assert(!sessions.slice(sessionsBeforePoll10d).some((x) => x.rcptTo.includes('<holder17@example.com>')), 'expected nothing delivered to holder17');
    console.log('PASS: reissued ticket forwarded once; a replay was refused');

    console.log('\nALL EMAIL-TICKET FORWARD CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    proc.kill();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(docrootDir, { recursive: true, force: true });
    process.exit(process.exitCode || 0);
  }
})();
