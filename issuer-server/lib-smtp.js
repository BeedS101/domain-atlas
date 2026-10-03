// Minimal hand-rolled SMTP client — zero external dependencies, matching
// this reference implementation's own stated philosophy (package.json).
// Supports exactly what SPEC.md §13.2's outbound delivery needs: a plain
// connect or STARTTLS, AUTH LOGIN, and a multipart/mixed message carrying
// a text body plus attachments. Not a general-purpose mail library — no
// AUTH PLAIN/CRAM-MD5, no 8BITMIME, no pipelining, no retry policy. A real
// SMTP conversation, one line at a time, nothing more than SPEC.md §13
// actually needs.

const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

function b64(s) {
  return Buffer.from(s, 'utf8').toString('base64');
}

// SMTP replies are line-oriented, and a multi-line reply (EHLO's own
// capability list is the common case) marks every line but the last with
// a '-' in the 4th column instead of a space — this keeps reading until
// that final line arrives, rather than assuming the first line read is
// the whole reply.
function readReply(socket) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    function onData(chunk) {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\r\n').filter(Boolean);
      const last = lines[lines.length - 1];
      if (last && /^\d{3}[ -]/.test(last) && last[3] === ' ') {
        cleanup();
        resolve({ code: parseInt(last.slice(0, 3), 10), lines, raw: buffer });
      }
    }
    function onError(err) {
      cleanup();
      reject(err);
    }
    function cleanup() {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
    }
    socket.on('data', onData);
    socket.on('error', onError);
  });
}

function writeLine(socket, line) {
  return new Promise((resolve, reject) => {
    socket.write(line + '\r\n', (err) => (err ? reject(err) : resolve()));
  });
}

async function command(socket, line, expectCode) {
  if (line !== null) await writeLine(socket, line);
  const reply = await readReply(socket);
  const expected = Array.isArray(expectCode) ? expectCode : [expectCode];
  if (expectCode && !expected.includes(reply.code)) {
    throw new Error('SMTP command "' + (line === null ? '(connect)' : line) + '" got ' + reply.code + ': ' + reply.raw.trim());
  }
  return reply;
}

function upgradeToTls(socket, host) {
  return new Promise((resolve, reject) => {
    const secureSocket = tls.connect({ socket, host, rejectUnauthorized: true }, () => resolve(secureSocket));
    secureSocket.once('error', reject);
  });
}

// DATA's own escaping rule: a body line that begins with "." must get a
// second "." prepended, or a receiving server reads it as the end-of-data
// marker and silently truncates the message right there. Applied to the
// whole message once, after it's fully built — simpler and less error-
// prone than threading it through every part that gets concatenated into
// the body.
function dotStuff(body) {
  return body.replace(/\r\n\./g, '\r\n..').replace(/^\./, '..');
}

// A plain-text body plus zero or more attachments, multipart/mixed, 7bit
// for the text part and base64 for every attachment — the minimal shape
// SPEC.md §13.2 needs (the credential's own canonical JSON as a named
// attachment, optionally a QR image alongside it later) and nothing a
// mail client needs anything fancier to render correctly.
function buildMimeMessage({ from, to, subject, textBody, attachments, extraHeaders }) {
  const boundary = '----atlas-' + crypto.randomBytes(16).toString('hex');
  const headers = [
    'From: ' + from,
    'To: ' + to,
    'Subject: ' + subject,
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="' + boundary + '"',
    ...(extraHeaders || [])
  ];
  const parts = [];
  parts.push(
    '--' + boundary + '\r\n' +
    'Content-Type: text/plain; charset=utf-8\r\n' +
    'Content-Transfer-Encoding: 7bit\r\n\r\n' +
    textBody.replace(/\r?\n/g, '\r\n') + '\r\n'
  );
  for (const att of attachments || []) {
    parts.push(
      '--' + boundary + '\r\n' +
      'Content-Type: ' + att.contentType + '; name="' + att.filename + '"\r\n' +
      'Content-Disposition: attachment; filename="' + att.filename + '"\r\n' +
      'Content-Transfer-Encoding: base64\r\n\r\n' +
      Buffer.from(att.content, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n') + '\r\n'
    );
  }
  parts.push('--' + boundary + '--\r\n');
  return headers.join('\r\n') + '\r\n\r\n' + parts.join('');
}

// sendMail({host, port, secure, user, pass, from, to, envelopeFrom,
//   subject, textBody, attachments})
//
// secure: 'tls' (connection is encrypted from the first byte, e.g. port
// 465) | 'starttls' (plain connect, then upgrade mid-conversation, e.g.
// port 587) | 'none' (never do this against a real mail server — only
// exists so test/manual-*.js can point this at a local, unencrypted fake
// SMTP server without needing a throwaway TLS certificate).
//
// `envelopeFrom`, when given, becomes the MAIL FROM address instead of
// `from` — distinct from the visible From: header, same distinction every
// real MTA already draws, and the hook SPEC.md §13.3's own VERP bounce
// correlation will set per-send once that's built.
async function sendMail({ host, port, secure, user, pass, from, to, envelopeFrom, subject, textBody, attachments }) {
  let socket = await new Promise((resolve, reject) => {
    const s = net.connect({ host, port });
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });

  const ehloName = process.env.ATLAS_EMAIL_EHLO_NAME || 'localhost';

  if (secure === 'tls') socket = await upgradeToTls(socket, host);

  await command(socket, null, 220); // server greeting
  await command(socket, 'EHLO ' + ehloName, 250);

  if (secure === 'starttls') {
    await command(socket, 'STARTTLS', 220);
    socket = await upgradeToTls(socket, host);
    await command(socket, 'EHLO ' + ehloName, 250);
  }

  if (user) {
    await command(socket, 'AUTH LOGIN', 334);
    await command(socket, b64(user), 334);
    await command(socket, b64(pass), 235);
  }

  await command(socket, 'MAIL FROM:<' + (envelopeFrom || from) + '>', 250);
  await command(socket, 'RCPT TO:<' + to + '>', [250, 251]);
  await command(socket, 'DATA', 354);

  const message = buildMimeMessage({ from, to, subject, textBody, attachments });
  await writeLine(socket, dotStuff(message) + '\r\n.');
  const dataReply = await readReply(socket);
  if (dataReply.code !== 250) throw new Error('message not accepted: ' + dataReply.raw.trim());

  try {
    await command(socket, 'QUIT', 221);
  } catch (_) {
    // best-effort — a send that was already accepted (250 above) is
    // already a success regardless of how cleanly QUIT itself goes
  }
  socket.end();
  return { accepted: true };
}

module.exports = { sendMail, buildMimeMessage, dotStuff, readReply, command };
