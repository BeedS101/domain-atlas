// Domain Atlas presence server: private moderation audit log.
//
// One JSON line per moderation request that reached a verified grant, written
// by handleModeration() in server.js, the only code path the moderation
// endpoints share, so no endpoint can act without being recorded. The mirror of
// presence-php/presence/lib/audit.php; the two keep the same fields, bounds and
// visibility rule.
//
// What an entry holds (nothing else is ever stored):
//   seq, t (ISO time), domain, world, operation, moderatorRef (the issuer's
//   pseudonymous reference, not a wallet key), role (admin | moderator, as the
//   issuer's status statement states it), grantId (a reference, not a
//   credential), target (the temporary participant reference), durationSeconds,
//   cause (a fixed code), outcome (success | refused | failed) and code (the
//   result or refusal code).
// Never stored: wallet keys, signatures, tokens, ephemeral keys, request nonces,
// visit ids, network addresses, display names or chat text.
//
// The file is private to this service (never served, mode 0600) and bounded by
// size and age. Each entry carries the hash of the one before it, so edits or
// deletions inside the file are detectable. That is NOT tamper-proofing: whoever
// can rewrite the file can rewrite the whole chain. Only a head hash copied
// somewhere the service's host cannot change (see integrity.head in a read)
// makes truncation or a full rewrite detectable.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function envNumber(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const FILE = process.env.PRESENCE_MODERATION_AUDIT_FILE || path.join(__dirname, 'moderation-audit.jsonl');
const MAX_BYTES = envNumber('MODERATION_AUDIT_MAX_BYTES', 1024 * 1024);
const RETENTION_MS = envNumber('MODERATION_AUDIT_RETENTION_DAYS', 90) * 24 * 60 * 60 * 1000;
// Refusals and audit reads recorded per moderator per window; the rest are
// summarised by one "audit-throttled" entry, so a stolen grant cannot flood the log.
const REFUSALS_PER_WINDOW = envNumber('MODERATION_AUDIT_REFUSALS_PER_MIN', 10);
const REFUSAL_WINDOW_MS = envNumber('MODERATION_AUDIT_REFUSAL_WINDOW_MS', 60 * 1000);
const VIEW_LIMIT = envNumber('MODERATION_AUDIT_VIEW_LIMIT', 200);
const MAX_THROTTLE_MODERATORS = 5000;

const OUTCOMES = ['success', 'refused', 'failed'];
const REF_RE = /^[A-Za-z0-9_-]{43}$/;
const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const CODE_RE = /^[a-z0-9-]{1,48}$/;
const OP_RE = /^[a-z]+\.[a-z]+$/;
const CAUSES = ['spam', 'abuse', 'harassment', 'inappropriate', 'disruption', 'other'];
const ROLES = ['admin', 'moderator'];

function canon(o) {
  return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + JSON.stringify(o[k])).join(',') + '}';
}
function chainHash(prev, entry) {
  return crypto.createHash('sha256').update(prev + '\n' + canon(entry)).digest('base64url');
}

// Keeps only the known fields, each in its expected shape; anything else is
// dropped rather than stored.
function sanitize(e) {
  const out = {
    domain: typeof e.domain === 'string' ? e.domain.slice(0, 255) : '',
    world: typeof e.world === 'string' ? e.world.slice(0, 480) : null,
    operation: typeof e.operation === 'string' && OP_RE.test(e.operation) ? e.operation : null,
    moderatorRef: typeof e.moderatorRef === 'string' && REF_RE.test(e.moderatorRef) ? e.moderatorRef : null,
    role: ROLES.includes(e.role) ? e.role : null,
    grantId: typeof e.grantId === 'string' && ID_RE.test(e.grantId) ? e.grantId : null,
    target: typeof e.target === 'string' && ID_RE.test(e.target) ? e.target : null,
    durationSeconds: Number.isInteger(e.durationSeconds) && e.durationSeconds > 0 ? e.durationSeconds : null,
    cause: CAUSES.includes(e.cause) ? e.cause : null,
    outcome: OUTCOMES.includes(e.outcome) ? e.outcome : 'failed',
    code: typeof e.code === 'string' && CODE_RE.test(e.code) ? e.code : 'unknown'
  };
  return out;
}

// ---------- file access ----------

function lastLines(max) {
  let fd;
  try { fd = fs.openSync(FILE, 'r'); } catch (_) { return { size: 0, endsNl: true, lines: [] }; }
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 16384);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    let text = buf.toString('utf8');
    if (len < size) text = text.slice(text.indexOf('\n') + 1); // drop a cut first line
    return { size, endsNl: len === 0 || buf[len - 1] === 10, lines: text.split('\n').filter(Boolean).slice(-max) };
  } finally { fs.closeSync(fd); }
}
function firstLines(max) {
  let fd;
  try { fd = fs.openSync(FILE, 'r'); } catch (_) { return []; }
  try {
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.toString('utf8', 0, n).split('\n').slice(0, max + 1).slice(0, max).filter(Boolean);
  } finally { fs.closeSync(fd); }
}
function parse(line) { try { const o = JSON.parse(line); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch (_) { return null; } }

// {seq, h} to chain the next entry to.
function tail() {
  const { lines } = lastLines(8);
  for (let i = lines.length - 1; i >= 0; i--) {
    const o = parse(lines[i]);
    if (!o) continue;
    if (o.base && typeof o.base.h === 'string' && Number.isInteger(o.base.seq)) return { seq: o.base.seq, h: o.base.h };
    if (Number.isInteger(o.seq) && typeof o.h === 'string') return { seq: o.seq, h: o.h };
  }
  return { seq: 0, h: '' };
}

// Can an entry be appended right now? Commands are refused when it cannot, so
// a state change is never made without being able to record it.
function writable() {
  try {
    const fd = fs.openSync(FILE, 'a', 0o600);
    fs.closeSync(fd);
    fs.accessSync(FILE, fs.constants.W_OK);
    return true;
  } catch (_) { return false; }
}

// Rewrites the file keeping only entries inside the retention period and, when
// over the size bound, only the newest ones that fit in 80% of it. A base line
// carries the position and hash of the last dropped entry, so the chain of the
// rest still verifies.
function compact(now) {
  let text;
  try { text = fs.readFileSync(FILE, 'utf8'); } catch (_) { return; }
  let base = null;
  const entries = [];
  for (const line of text.split('\n').filter(Boolean)) {
    const o = parse(line);
    if (o && o.base) { base = { seq: o.base.seq, h: o.base.h }; continue; }
    entries.push({ line, o });
  }
  let start = 0;
  while (start < entries.length && entries[start].o && Date.parse(entries[start].o.t) < now - RETENTION_MS) start++;
  let bytes = 0;
  for (let i = start; i < entries.length; i++) bytes += Buffer.byteLength(entries[i].line) + 1;
  while (entries.length - start > 1 && bytes > MAX_BYTES * 0.8) { bytes -= Buffer.byteLength(entries[start].line) + 1; start++; }
  if (start > 0) {
    const last = entries[start - 1].o;
    if (last && Number.isInteger(last.seq) && typeof last.h === 'string') base = { seq: last.seq, h: last.h };
  }
  const out = (base ? JSON.stringify({ base }) + '\n' : '') + entries.slice(start).map((r) => r.line + '\n').join('');
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, out, { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

// ---------- refusal throttle ----------

const refusals = new Map(); // moderatorRef -> {start, count, noted}
function refusalAllowed(ref, now) {
  let r = refusals.get(ref);
  if (!r || now - r.start >= REFUSAL_WINDOW_MS) {
    r = { start: now, count: 0, noted: false };
    refusals.delete(ref);
    refusals.set(ref, r);
    while (refusals.size > MAX_THROTTLE_MODERATORS) refusals.delete(refusals.keys().next().value);
  }
  r.count++;
  if (r.count <= REFUSALS_PER_WINDOW) return 'yes';
  if (!r.noted) { r.noted = true; return 'note'; }
  return 'no';
}

// ---------- the API ----------

// Appends one entry. Returns true when it was written (or deliberately
// throttled), false when the file could not be written.
function record(e, nowMs) {
  const now = nowMs || Date.now();
  const entry = sanitize(e);
  if (!entry.domain) return false;
  // Refusals and audit reads (neither is limited by the command rate limit) share
  // one per-moderator allowance, so neither can be used to push older entries out.
  if (entry.outcome === 'refused' || entry.operation === 'audit.view') {
    const verdict = entry.moderatorRef ? refusalAllowed(entry.moderatorRef, now) : 'yes';
    if (verdict === 'no') return true;
    if (verdict === 'note') { entry.outcome = 'refused'; entry.code = 'audit-throttled'; entry.operation = null; entry.target = null; entry.durationSeconds = null; entry.cause = null; }
  }
  try {
    const t = tail();
    const body = Object.assign({ seq: t.seq + 1, t: new Date(now).toISOString() }, entry);
    body.h = chainHash(t.h, Object.assign({}, body));
    const { size, endsNl } = lastLines(1);
    const lead = endsNl ? '' : '\n';
    fs.appendFileSync(FILE, lead + JSON.stringify(body) + '\n', { mode: 0o600 });
    const head = firstLines(2).map(parse).find((o) => o && !o.base);
    if (size > MAX_BYTES || (head && Date.parse(head.t) < now - RETENTION_MS)) compact(now);
    return true;
  } catch (_) { return false; }
}

// The entries a viewer may see: the same domain, and the requested world (an
// entry with no world, such as a refusal before the request was trusted, only
// to a viewer whose scope is every world). Newest first.
function read(opts) {
  const { domain, world, allWorlds } = opts;
  let text = '';
  try { text = fs.readFileSync(FILE, 'utf8'); } catch (_) { /* nothing recorded yet */ }
  const lines = text.split('\n').filter(Boolean);
  let prev = '', lastSeq = null, status = 'ok', total = 0, badSeq = null;
  const visible = [];
  for (const line of lines) {
    const o = parse(line);
    if (!o) { if (status === 'ok') { status = 'broken'; badSeq = lastSeq === null ? null : lastSeq + 1; } continue; }
    if (o.base) {
      if (lastSeq === null && Number.isInteger(o.base.seq) && typeof o.base.h === 'string') { prev = o.base.h; lastSeq = o.base.seq; }
      else if (status === 'ok') { status = 'broken'; }
      continue;
    }
    total++;
    const { h, ...rest } = o;
    const expected = chainHash(prev, rest);
    const nextSeq = lastSeq === null ? 1 : lastSeq + 1;
    if (status === 'ok' && (h !== expected || o.seq !== nextSeq)) { status = 'broken'; badSeq = o.seq; }
    prev = typeof h === 'string' ? h : prev;
    lastSeq = Number.isInteger(o.seq) ? o.seq : lastSeq;
    if (o.domain === domain && (o.world === world || (o.world === null && allWorlds))) visible.push(rest);
  }
  visible.reverse();
  const entries = visible.slice(0, VIEW_LIMIT);
  return {
    entries,
    truncated: visible.length > entries.length,
    integrity: { chain: status, entries: total, lastSeq: lastSeq, head: prev || null, firstBadSeq: badSeq },
    retention: { maxBytes: MAX_BYTES, maxAgeDays: Math.round(RETENTION_MS / 86400000) }
  };
}

module.exports = { record, read, writable, FILE };
