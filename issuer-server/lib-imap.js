// Minimal hand-rolled IMAP client — zero external dependencies, same
// philosophy as lib-smtp.js. Supports exactly what SPEC.md §13.3's
// inbound polling needs: connect (plain or TLS), LOGIN, SELECT INBOX,
// SEARCH UNSEEN, FETCH (RFC822) for a message's full raw text, STORE to
// mark a message \Seen once handled, and LOGOUT. Nothing here is a
// general-purpose IMAP library — no IDLE, no BODYSTRUCTURE-based partial
// fetch, no folder management beyond INBOX.
//
// IMAP responses are not strictly line-oriented the way SMTP's are: a
// response can embed a "literal" — `{n}` followed by exactly n raw bytes,
// which may themselves contain bare CRLFs — most commonly the full
// message body FETCH returns. readLogicalLine() below is what makes that
// safe: it reads an ordinary line, and if that line ends with `{n}`, reads
// exactly n raw bytes next (never scanning them for line breaks) before
// resuming ordinary line-reading for whatever follows the literal on the
// same logical response line.

const net = require('net');
const tls = require('tls');

// A small buffered byte reader sitting on top of the raw socket. Two read
// modes: a CRLF-terminated line, or an exact N-byte literal — the two
// primitives readLogicalLine() below needs and nothing else.
class ByteReader {
  constructor(socket) {
    this.chunks = [];
    this.length = 0;
    this.waiting = null;
    this.ended = false;
    socket.on('data', (chunk) => {
      this.chunks.push(chunk);
      this.length += chunk.length;
      this._tryFulfill();
    });
    socket.on('error', (err) => this._fail(err));
    socket.on('close', () => this._fail(new Error('IMAP socket closed unexpectedly')));
  }
  _fail(err) {
    this.ended = true;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w.reject(err);
    }
  }
  _coalesced() {
    if (this.chunks.length > 1) this.chunks = [Buffer.concat(this.chunks, this.length)];
    return this.chunks[0] || Buffer.alloc(0);
  }
  _consume(n) {
    const buf = this._coalesced();
    this.chunks = [buf.slice(n)];
    this.length = this.chunks[0].length;
    return buf.slice(0, n);
  }
  _tryFulfill() {
    if (!this.waiting) return;
    const buf = this._coalesced();
    if (this.waiting.mode === 'raw') {
      if (buf.length >= this.waiting.need) {
        const result = this._consume(this.waiting.need);
        const w = this.waiting;
        this.waiting = null;
        w.resolve(result);
      }
      return;
    }
    const idx = buf.indexOf('\r\n');
    if (idx !== -1) {
      const line = this._consume(idx).toString('latin1');
      this._consume(2); // the CRLF itself
      const w = this.waiting;
      this.waiting = null;
      w.resolve(line);
    }
  }
  readLine() {
    if (this.ended) return Promise.reject(new Error('IMAP socket closed unexpectedly'));
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject, mode: 'line' };
      this._tryFulfill();
    });
  }
  readRaw(n) {
    if (this.ended) return Promise.reject(new Error('IMAP socket closed unexpectedly'));
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject, mode: 'raw', need: n };
      this._tryFulfill();
    });
  }
}

// Reads one full logical IMAP response line, inlining any literal's raw
// bytes verbatim into the returned string (latin1 — a lossless 1:1
// byte<->char mapping, safe here because every attachment this feature
// ever reads back out was itself base64/quoted-printable/7bit encoded by
// lib-smtp.js's own buildMimeMessage() before it was ever sent, so nothing
// in the literal is outside the single-byte range to begin with).
async function readLogicalLine(reader) {
  let acc = await reader.readLine();
  let tail = acc.match(/\{(\d+)\}$/);
  while (tail) {
    const literal = (await reader.readRaw(parseInt(tail[1], 10))).toString('latin1');
    const rest = await reader.readLine();
    acc = acc + literal + rest;
    tail = rest.match(/\{(\d+)\}$/);
  }
  return acc;
}

function upgradeToTls(socket, host) {
  return new Promise((resolve, reject) => {
    const secureSocket = tls.connect({ socket, host, rejectUnauthorized: true }, () => resolve(secureSocket));
    secureSocket.once('error', reject);
  });
}

// Quotes a string for an IMAP quoted argument (LOGIN's username/password,
// most simply) — backslash-escapes the two characters that would
// otherwise break out of the quotes.
function imapQuote(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

class ImapClient {
  constructor(socket) {
    this.socket = socket;
    this.reader = new ByteReader(socket);
    this.tagCounter = 0;
  }

  async _write(line) {
    await new Promise((resolve, reject) => this.socket.write(line + '\r\n', (err) => (err ? reject(err) : resolve())));
  }

  // Sends one tagged command, collects every untagged ("* ...") response
  // line until the matching tagged completion arrives, and throws unless
  // that completion is OK.
  async command(cmd) {
    const tag = 'A' + ++this.tagCounter;
    await this._write(tag + ' ' + cmd);
    const untagged = [];
    for (;;) {
      const line = await readLogicalLine(this.reader);
      if (line.startsWith(tag + ' ')) {
        if (!/^\S+ OK/i.test(line)) throw new Error('IMAP command "' + cmd + '" failed: ' + line);
        return { untagged, completion: line };
      }
      untagged.push(line);
    }
  }

  async readGreeting() {
    const line = await readLogicalLine(this.reader);
    if (!/^\* OK/i.test(line)) throw new Error('unexpected IMAP greeting: ' + line);
    return line;
  }

  async login(user, pass) {
    await this.command('LOGIN ' + imapQuote(user) + ' ' + imapQuote(pass));
  }

  async selectInbox() {
    await this.command('SELECT INBOX');
  }

  // Returns an array of message sequence numbers currently unseen —
  // `* SEARCH 1 2 3` (or `* SEARCH` alone, for none).
  async searchUnseen() {
    const { untagged } = await this.command('SEARCH UNSEEN');
    const searchLine = untagged.find((l) => /^\* SEARCH/i.test(l));
    if (!searchLine) return [];
    return searchLine.replace(/^\* SEARCH\s*/i, '').trim().split(/\s+/).filter(Boolean).map((n) => parseInt(n, 10));
  }

  // Fetches one message's full raw RFC822 text (headers + body,
  // unparsed) — deliberately the simplest possible FETCH, leaving all
  // MIME structure to lib-mime-parse.js rather than asking the server for
  // BODYSTRUCTURE and fetching parts selectively.
  async fetchRfc822(seq) {
    const { untagged } = await this.command('FETCH ' + seq + ' (RFC822)');
    const fetchLine = untagged.find((l) => new RegExp('^\\* ' + seq + ' FETCH').test(l));
    if (!fetchLine) throw new Error('no FETCH response for message ' + seq);
    const braceIdx = fetchLine.indexOf('{');
    const closeBrace = fetchLine.indexOf('}', braceIdx);
    if (braceIdx === -1 || closeBrace === -1) throw new Error('FETCH response did not carry a literal: ' + fetchLine);
    const n = parseInt(fetchLine.slice(braceIdx + 1, closeBrace), 10);
    return fetchLine.slice(closeBrace + 1, closeBrace + 1 + n);
  }

  async markSeen(seq) {
    await this.command('STORE ' + seq + ' +FLAGS (\\Seen)');
  }

  async logout() {
    try {
      await this.command('LOGOUT');
    } catch (_) {
      // best-effort — the mailbox state above is already durable server-side
      // regardless of how cleanly LOGOUT itself completes
    }
    this.socket.end();
  }
}

// connectImap({host, port, secure, user, pass}) — connects, reads the
// greeting, upgrades to TLS if requested, logs in, and selects INBOX.
// Returns a ready-to-use ImapClient. `secure` follows lib-smtp.js's own
// sendMail() convention: 'tls' | 'starttls' | 'none'.
async function connectImap({ host, port, secure, user, pass }) {
  let socket = await new Promise((resolve, reject) => {
    const s = net.connect({ host, port });
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
  if (secure === 'tls') socket = await upgradeToTls(socket, host);

  let client = new ImapClient(socket);
  await client.readGreeting();

  if (secure === 'starttls') {
    await client.command('STARTTLS');
    socket = await upgradeToTls(socket, host);
    client = new ImapClient(socket);
  }

  await client.login(user, pass);
  await client.selectInbox();
  return client;
}

module.exports = { connectImap, ImapClient, readLogicalLine, ByteReader };
