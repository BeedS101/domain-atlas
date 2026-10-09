// Shared harness for the delivery / transfer regression tests: a fake SMTP
// server whose behaviour is scripted per attempt, helpers to run an issuer
// (Node or PHP) in an isolated state directory and to restart it after a
// forced crash, and the small signing / HTTP helpers every test needs.
//
// The fake SMTP server can accept a message, reject a recipient, answer a
// transient failure, or take the message and then drop the connection
// without the final "250" (an uncertain delivery: the message arrived but
// the sender never learns it).

const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { webcrypto } = require('crypto');
const crypto = webcrypto;
const { subtle } = webcrypto;
const { buildMimeMessage } = require('../../issuer-server/lib-smtp');

const ROOT = path.resolve(__dirname, '..', '..');

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
async function postJson(base, urlPath, body) {
  const r = await fetch(base + urlPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const text = await r.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (_) { parsed = { raw: text }; }
  return { status: r.status, body: parsed };
}
async function getJson(base, urlPath) {
  const r = await fetch(base + urlPath);
  const text = await r.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (_) { parsed = { raw: text }; }
  return { status: r.status, body: parsed };
}
async function issueAsset(base, ownerPublicKey, assetClass, quantity) {
  const res = await postJson(base, '/atlas/asset/issue', { ownerPublicKey, assetClass, ...(quantity ? { quantity } : {}) });
  if (res.status !== 200) throw new Error('Failed to issue ' + assetClass + ': ' + JSON.stringify(res.body));
  return res.body;
}
// A signed /atlas/mail/check request (SPEC.md §11.8) made by `owner` for the
// mailboxes of `credentials`. `o` overrides parts of the request so tests can
// build bad ones: domain, issuedAt, nonce, credentialIds, signer (another
// identity signs instead), delegation, payloadExtra, noProof.
async function mailCheck(base, owner, credentials, o) {
  o = o || {};
  const list = Array.isArray(credentials) ? credentials : [credentials];
  const payload = {
    action: 'mail-check',
    domain: o.domain || new URL(base).host,
    credentialIds: o.credentialIds || list.map((c) => c.id),
    issuedAt: o.issuedAt || new Date().toISOString(),
    nonce: o.nonce || b64url(crypto.getRandomValues(new Uint8Array(18))),
    ...(o.payloadExtra || {})
  };
  const body = { credentials: list, payload, ...(o.delegation ? { delegation: o.delegation } : {}) };
  if (!o.noProof) body.proof = await signWithSelf(o.signer || owner, payload);
  return postJson(base, '/atlas/mail/check', body);
}
// Delegation (a throwaway key authorised by `owner` for reads) plus the
// session identity that signs requests under it.
async function mailDelegation(base, owner, o) {
  o = o || {};
  const session = await genIdentity();
  const issued = o.issuedAt ? new Date(o.issuedAt) : new Date();
  const payload = {
    action: 'mail-session',
    purpose: o.purpose || 'mail-read',
    domain: o.domain || new URL(base).host,
    sessionPublicKey: o.sessionPublicKey || session.publicKey,
    issuedAt: issued.toISOString(),
    expiresAt: new Date(issued.getTime() + (o.lifetimeMs || 10 * 60 * 1000)).toISOString()
  };
  return { session, delegation: { payload, proof: await signWithSelf(o.signer || owner, payload) } };
}
// What a stranger may learn about a credential nobody holds a key for (an
// emailed bearer one): the public revocation list, in the shape a mail
// check reports a revocation.
async function publicStatus(base, id) {
  const doc = await (await fetch(base + '/.well-known/atlas-revocations.json')).json();
  const entry = (doc.revoked || []).find((r) => r.id === id);
  return entry ? { id, status: 'revoked', reason: entry.reason } : null;
}
async function mailCheckStatus(base, owner, credential) {
  const res = await mailCheck(base, owner, credential);
  if (res.status !== 200) throw new Error('mail check failed: ' + JSON.stringify(res.body));
  return res.body.updates.find((u) => u.id === credential.id) || null;
}
async function transferToEmail(base, credential, owner, recipientEmail, extra) {
  const intentPayload = { credentialId: credential.id, recipientEmail, action: 'transfer-to-email', ...(extra || {}) };
  const intentProof = await signWithSelf(owner, intentPayload);
  return postJson(base, '/atlas/asset/transfer-to-email', { credential, recipientEmail, intent: { payload: intentPayload, proof: intentProof } });
}
async function walletTransfer(base, credential, owner, recipientPublicKey) {
  const payload = { credentialId: credential.id, recipientPublicKey, action: 'transfer' };
  return postJson(base, '/atlas/asset/transfer', { credential, recipientPublicKey, intent: { payload, proof: await signWithSelf(owner, payload) } });
}
async function claimFromFile(base, credential, newOwner) {
  const payload = { credentialId: credential.id, newOwnerPublicKey: newOwner.publicKey, action: 'claim-from-file' };
  return postJson(base, '/atlas/asset/claim-from-file', { credential, intent: { payload, proof: await signWithSelf(newOwner, payload) } });
}
async function fileStatus(base, id) {
  const r = await getJson(base, '/atlas/asset/file-status?id=' + encodeURIComponent(id));
  return r.body;
}
async function adminSend(base, admin, payload) {
  return postJson(base, '/atlas/admin/send-ticket-to-email', { payload, proof: await signWithSelf(admin, payload) });
}
async function adminPollNow(base, admin) {
  const payload = { action: 'email-tickets-poll-now', at: new Date().toISOString() };
  return postJson(base, '/atlas/admin/email-tickets/poll-now', { payload, proof: await signWithSelf(admin, payload) });
}

// ---------- fake SMTP server ----------
// script(attemptInfo) -> 'accept' | 'reject' | 'tempfail' | 'drop-after-data'
// attemptInfo: { n (1-based attempt number across the server), rcpt }
function startFakeSmtp(port, script) {
  const messages = []; // every message whose DATA the server received (even if the sender never saw a 250)
  const attempts = []; // one entry per SMTP session that reached RCPT TO
  const server = net.createServer((socket) => {
    const session = { rcptTo: [], mailFrom: null, data: '', outcome: null };
    let state = 'greeting';
    let buffer = '';
    socket.write('220 fake-smtp ready\r\n');
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let idx;
      while ((idx = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        handle(line);
      }
    });
    function handle(line) {
      if (state === 'data') {
        if (line === '.') {
          messages.push({ rcptTo: session.rcptTo.slice(), mailFrom: session.mailFrom, data: session.data });
          if (session.outcome === 'drop-after-data') {
            socket.destroy();
            return;
          }
          state = 'ready';
          socket.write('250 OK: message accepted\r\n');
          return;
        }
        session.data += (line.startsWith('..') ? line.slice(1) : line) + '\r\n';
        return;
      }
      if (/^EHLO/i.test(line)) socket.write('250-fake-smtp greets you\r\n250 AUTH LOGIN\r\n');
      else if (/^AUTH LOGIN/i.test(line)) { socket.write('334 VXNlcm5hbWU6\r\n'); state = 'auth-user'; }
      else if (state === 'auth-user') { socket.write('334 UGFzc3dvcmQ6\r\n'); state = 'auth-pass'; }
      else if (state === 'auth-pass') { socket.write('235 Authentication succeeded\r\n'); state = 'ready'; }
      else if (/^MAIL FROM:/i.test(line)) { session.mailFrom = line.replace(/^MAIL FROM:/i, '').trim(); socket.write('250 OK\r\n'); }
      else if (/^RCPT TO:/i.test(line)) {
        const rcpt = line.replace(/^RCPT TO:/i, '').trim();
        session.rcptTo.push(rcpt);
        const info = { n: attempts.length + 1, rcpt };
        const verdict = script ? script(info) : 'accept';
        session.outcome = verdict;
        attempts.push({ ...info, verdict });
        if (verdict === 'reject') socket.write('550 No such recipient here\r\n');
        else if (verdict === 'tempfail') socket.write('451 Try again later\r\n');
        else socket.write('250 OK\r\n');
      } else if (/^DATA/i.test(line)) {
        if (session.outcome === 'reject' || session.outcome === 'tempfail') socket.write('554 No valid recipients\r\n');
        else { socket.write('354 Start mail input\r\n'); state = 'data'; }
      } else if (/^QUIT/i.test(line)) { socket.write('221 Bye\r\n'); socket.end(); }
      else socket.write('250 OK\r\n');
    }
  });
  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, messages, attempts, close: () => new Promise((r) => server.close(r)) }));
    server.once('error', reject);
  });
}

// Decodes the JSON attachment of a received message back into a credential.
function attachmentOf(message) {
  const boundaryMatch = message.data.match(/boundary="([^"]+)"/);
  assert(boundaryMatch, 'expected a multipart boundary in the message headers');
  const parts = message.data.split('--' + boundaryMatch[1]);
  for (const part of parts) {
    if (part.includes('Content-Disposition: attachment') && part.includes('.json')) {
      const bodyStart = part.indexOf('\r\n\r\n');
      return JSON.parse(Buffer.from(part.slice(bodyStart + 4).replace(/\r?\n/g, '').trim(), 'base64').toString('utf8'));
    }
  }
  return null;
}

// ---------- fake IMAP server ----------
// Just enough of the protocol for the issuers' own IMAP clients: LOGIN,
// SELECT INBOX, SEARCH UNSEEN, FETCH (RFC822), STORE +FLAGS (\Seen), LOGOUT.
// `mailbox` is a plain array of {raw, seen} the test pushes into directly;
// sequence numbers are 1-based positions in it.
function startFakeImap(port, { user, pass }) {
  const mailbox = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.write('* OK fake-imap ready\r\n');
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      let idx;
      while ((idx = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        handle(line);
      }
    });
    const reply = (tag, text) => socket.write(tag + ' ' + text + '\r\n');
    function handle(line) {
      const sp = line.indexOf(' ');
      if (sp === -1) return;
      const tag = line.slice(0, sp);
      const rest = line.slice(sp + 1);
      if (/^LOGIN\s/i.test(rest)) {
        const m = rest.match(/^LOGIN\s+"((?:[^"\\]|\\.)*)"\s+"((?:[^"\\]|\\.)*)"/i);
        if (m && m[1] === user && m[2] === pass) reply(tag, 'OK LOGIN completed');
        else reply(tag, 'NO LOGIN failed');
      } else if (/^SELECT INBOX/i.test(rest)) {
        socket.write('* ' + mailbox.length + ' EXISTS\r\n* 0 RECENT\r\n');
        reply(tag, 'OK [READ-WRITE] SELECT completed');
      } else if (/^SEARCH UNSEEN/i.test(rest)) {
        const nums = [];
        mailbox.forEach((m, i) => { if (!m.seen) nums.push(i + 1); });
        socket.write('* SEARCH' + (nums.length ? ' ' + nums.join(' ') : '') + '\r\n');
        reply(tag, 'OK SEARCH completed');
      } else if (/^FETCH\s+(\d+)\s+\(RFC822\)/i.test(rest)) {
        const seq = parseInt(rest.match(/^FETCH\s+(\d+)/i)[1], 10);
        const msg = mailbox[seq - 1];
        if (!msg) { reply(tag, 'NO no such message'); return; }
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
      } else reply(tag, 'BAD unknown command');
    }
  });
  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, mailbox, close: () => new Promise((r) => server.close(r)) }));
    server.once('error', reject);
  });
}

const IMAP_USER = 'tickets@test-domain.local';
const IMAP_PASS = 'imap-test-pass';
const INTAKE_ADDRESS = 'tickets@test-domain.local';

function imapEnvFor(port) {
  return {
    ATLAS_EMAIL_IMAP_HOST: '127.0.0.1',
    ATLAS_EMAIL_IMAP_PORT: String(port),
    ATLAS_EMAIL_IMAP_SECURE: 'none',
    ATLAS_EMAIL_IMAP_USER: IMAP_USER,
    ATLAS_EMAIL_IMAP_PASS: IMAP_PASS,
    // The background timer never fires during a test; polls go through poll-now.
    ATLAS_EMAIL_IMAP_POLL_MS: String(10 * 60 * 1000)
  };
}

// One raw RFC822 forward of `credential` from `fromAddress` to the intake
// mailbox, CC'ing `ccAddresses`.
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

// ---------- issuers ----------
function smtpEnvFor(port) {
  return {
    ATLAS_EMAIL_SMTP_HOST: '127.0.0.1',
    ATLAS_EMAIL_SMTP_PORT: String(port),
    ATLAS_EMAIL_SMTP_SECURE: 'none',
    ATLAS_EMAIL_SMTP_USER: 'test-user',
    ATLAS_EMAIL_SMTP_PASS: 'test-pass',
    ATLAS_EMAIL_FROM_ADDRESS: 'tickets@test-domain.local'
  };
}

// Starts issuer-server; `exited` resolves with the exit code when it stops
// (a forced crash is exit code 86).
function startNodeIssuer({ port, stateDir, docrootDir, env }) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', ['issuer-server/server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), ATLAS_DOMAIN: 'localhost:' + port, ATLAS_STATE_DIR: stateDir, ATLAS_DOCROOT: docrootDir, ...(env || {}) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let started = false;
    const exited = new Promise((r) => proc.on('exit', (code) => { if (!started) reject(new Error('issuer-server exited early with code ' + code)); r(code); }));
    const timer = setTimeout(() => reject(new Error('issuer-server did not start in time')), 10000);
    proc.stdout.on('data', (d) => { if (!started && d.toString().includes('listening')) { started = true; clearTimeout(timer); resolve({ proc, exited, kind: 'node', port, stateDir }); } });
  });
}

// Starts the PHP bundle in bundleDir. A request that hits a crash point
// ends that request only (the built-in server keeps running); tests that
// need "the process died" restart the server to model it.
function startPhpIssuer({ port, bundleDir, env }) {
  return new Promise((resolve, reject) => {
    const proc = spawn('php', ['-S', 'localhost:' + port, 'test-router.php'], { cwd: bundleDir, env: { ...process.env, ...(env || {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => reject(new Error('php -S did not start in time')), 5000);
    let started = false;
    const exited = new Promise((r) => proc.on('exit', (code) => { if (!started) reject(new Error('php -S exited early with code ' + code)); r(code); }));
    proc.stderr.on('data', (d) => { if (!started && d.toString().includes('started')) { started = true; clearTimeout(timer); resolve({ proc, exited, kind: 'php', port, bundleDir }); } });
  });
}

async function stopIssuer(issuer) {
  if (!issuer || !issuer.proc || issuer.proc.exitCode !== null) return;
  issuer.proc.kill();
  await Promise.race([issuer.exited, new Promise((r) => setTimeout(r, 2000))]);
}

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Writes the admin roster where the given kind of issuer reads it.
function writeAdminRoster(kind, location, identities) {
  const roster = JSON.stringify({ keys: identities.map((i) => ({ publicKey: i.publicKey, addedAt: new Date().toISOString() })) });
  if (kind === 'node') fs.writeFileSync(path.join(location, 'atlas-admin-keys-store.json'), roster);
  else fs.writeFileSync(path.join(location, 'lib', 'atlas-admin-keys-store.json'), roster);
}

// Prepares an isolated PHP bundle copy with SMTP configured.
function preparePhpBundle(smtpPort, imapPort) {
  const bundleDir = tmpDir('atlas-delivery-php-');
  fs.cpSync(path.join(ROOT, 'issuer-php'), bundleDir, { recursive: true });
  if (smtpPort) {
    fs.writeFileSync(path.join(bundleDir, 'lib', 'atlas-email-tickets-config.json'), JSON.stringify({
      smtpHost: '127.0.0.1', smtpPort, smtpSecure: 'none', smtpUser: 'test-user', smtpPass: 'test-pass', fromAddress: 'tickets@test-domain.local',
      ...(imapPort ? { imapHost: '127.0.0.1', imapPort, imapSecure: 'none', imapUser: IMAP_USER, imapPass: IMAP_PASS } : {})
    }, null, 2));
  }
  return bundleDir;
}

// Reads a state file of either kind of issuer (node: stateDir/<name>, php: bundle/lib/<name>).
function readState(kind, location, name) {
  const file = kind === 'node' ? path.join(location, name) : path.join(location, 'lib', name);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function waitFor(fn, description, timeoutMs = 8000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for ' + description);
    await new Promise((r) => setTimeout(r, 100));
  }
}

module.exports = {
  assert, b64url, canonicalize, genIdentity, signWithSelf, postJson, getJson, issueAsset, mailCheck, mailDelegation, mailCheckStatus, publicStatus,
  transferToEmail, walletTransfer, claimFromFile, fileStatus, adminSend, adminPollNow, startFakeSmtp, startFakeImap, buildForwardMessage, imapEnvFor, attachmentOf, smtpEnvFor, startNodeIssuer,
  startPhpIssuer, stopIssuer, tmpDir, writeAdminRoster, preparePhpBundle, readState, waitFor, ROOT
};
