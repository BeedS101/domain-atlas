// The pending-operations journal in encrypted wallet backups: what a backup carries, what a restore
// does with it, and what happens when the journal in a backup (or on the device) is missing, damaged,
// in conflict, or for a different owner.
//
// Disposable Chromium profiles with the real extension and throw-away Node or PHP issuers (own key,
// state and revocation list). A restore always goes into a fresh profile (or the same profile again)
// against the SAME issuer that committed the transaction, so "original identity and issuer state" is
// the real thing, not a stub. Nothing live is read or written.
//
//   xvfb-run -a node test/manual-gen1-backup-journal.js [node|php|both] [--only=B1]
//
// Every line is a property that must hold. "INFO" lines record what is still impossible. The N1
// scenario runs the previous wallet.js (the last commit without the journal in the backup) as a
// negative control and PASSES when that version loses the journal.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Wallet, PASSWORD, EXT_PATH, sleep } = require('./lib/wallet-profile');
const issuers = require('./lib/gen1-issuers');

const IRON = 'atlas.element.iron', GOLD = 'atlas.element.gold';
const args = process.argv.slice(2);
const which = args.find((a) => /^(node|php|both)$/.test(a)) || 'node';
const ONLY = (args.find((a) => a.startsWith('--only=')) || '').slice(7);
const TTL_ENV = { ATLAS_REPLAY_TTL_HOURS: '0.0006' }; // 2.16 s
const EXPIRY_WAIT_MS = 4500;
const FORMAT = 'atlas-pending-ops/1.0';

let passes = 0, failures = 0;
const check = (name, ok, detail) => {
  if (ok) { passes++; console.log('PASS ' + name); } else { failures++; console.log('FAIL ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 900) : '')); }
};
const info = (text) => console.log('INFO ' + text);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

let nextPort = 23000 + (process.pid % 500) * 20;
async function startIssuer(kind, env) {
  const port = nextPort++;
  const be = kind === 'php' ? await issuers.startPhp(port, { workers: 0, env }) : await issuers.startNode(port, { env });
  const api = issuers.api(be);
  return {
    be, api, kind, domain: kind === 'php' ? '127.0.0.1:' + port : 'localhost:' + port,
    revoked: () => new Set((api.revocations() || []).map((r) => r.id)),
    revCount: () => (api.revocations() || []).length,
    stop: () => be.stop()
  };
}

// ---------------------------------------------------------------- the backup file, outside the browser
const normSeed = (s) => String(s || '').trim().toLowerCase().split(/\s+/).join(' ');
const manualSecrets = (w) => [PASSWORD, normSeed(w.seed)];
function fileKey(file, secrets) {
  const digests = Buffer.concat(secrets.map((s) => crypto.createHash('sha256').update(s || '').digest()));
  return crypto.pbkdf2Sync(digests, Buffer.from(file.salt, 'base64url'), file.kdfIterations || 600000, 32, 'sha256');
}
function openFile(file, secrets) {
  const ct = Buffer.from(file.ciphertext, 'base64url');
  const d = crypto.createDecipheriv('aes-256-gcm', fileKey(file, secrets), Buffer.from(file.iv, 'base64url'));
  d.setAuthTag(ct.subarray(ct.length - 16));
  return JSON.parse(Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).toString('utf8'));
}
// Re-encrypts a (modified) payload under the same key, so the wallet's own decrypt accepts it.
function sealFile(file, payload, secrets) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', fileKey(file, secrets), iv);
  const enc = Buffer.concat([c.update(JSON.stringify(payload), 'utf8'), c.final(), c.getAuthTag()]);
  return Object.assign({}, file, { iv: iv.toString('base64url'), ciphertext: enc.toString('base64url') });
}
const craft = (file, secrets, mutate) => { const p = openFile(file, secrets); mutate(p); return sealFile(file, p, secrets); };
const clone = (x) => JSON.parse(JSON.stringify(x));

// ---------------------------------------------------------------- wallet-side helpers
const exportBackup = (w) => w.W(([pw, seed]) => AtlasWallet.exportFullBackup(pw, seed), [PASSWORD, w.seed]);
const exportAuto = (w) => w.W(async (pw) => AtlasWallet.buildAutoBackupBlob(await AtlasWallet.getIdentity(), pw), PASSWORD);
const importBackup = (t, file, seed) => t.W(([f, pw, s]) => AtlasWallet.importFullBackup(f, pw, s).then((result) => ({ ok: true, result }), (e) => ({ ok: false, message: e.message, code: e.code })), [file, PASSWORD, seed || t.seed]);
const importAuto = (t, file) => t.W(([f, pw]) => AtlasWallet.restoreFromAutoBackupFile(f, pw).then((result) => ({ ok: true, result }), (e) => ({ ok: false, message: e.message, code: e.code })), [file, PASSWORD]);
const quarantineOf = (t) => t.W((k) => AtlasWallet.getPendingOpsQuarantine(k), t.pub);
const rawAll = (t) => t.W(() => chrome.storage.local.get(null));
const rawKey = (t, key) => t.W(async ([k, pub]) => { const s = (await chrome.storage.local.get(k))[k]; return s ? (s[pub] === undefined ? null : s[pub]) : null; }, [key, t.pub]);
const mint = (w, iss, cls, q) => w.W((a) => AtlasWallet.mintAsset('self', a.d, a.c, a.q).then(() => 'ok', (e) => ({ message: e.message, pending: !!e.pending, code: e.code })), { d: iss.domain, c: cls, q });
const sum = (rows) => rows.reduce((s, r) => s + r.q, 0);
const shown = (w, cls) => w.W(([k, c]) => AtlasWallet.getWallet(k).then((list) => list.filter((e) => e.credential.asset.class === c).map((e) => ({
  id: e.credential.id, q: e.credential.quantity, status: e.lastVerdict && e.lastVerdict.status, valid: !!(e.lastVerdict && e.lastVerdict.valid),
  held: e.pendingOutcome ? e.pendingOutcome.state : null, spent: !!e.spent
}))), [w.pub, cls]);
const retry = (w, rid) => w.W((a) => AtlasWallet.retryPendingOperation(a.k, a.r).then((r) => r, (e) => ({ status: 'threw', message: e.message })), { k: w.pub, r: rid });

async function countRequests(w, source) {
  await w.W((src) => {
    const re = new RegExp(src);
    const inner = globalThis.fetch.bind(globalThis);
    globalThis.__count = 0;
    globalThis.fetch = (url, opts) => { if (re.test(String(url))) globalThis.__count++; return inner(url, opts); };
  }, source);
}
const requestCount = (w) => w.W(() => globalThis.__count);

// Everything the extension writes to the console while a test runs.
const watchConsole = (w) => w.W(() => {
  globalThis.__con = [];
  for (const m of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[m].bind(console);
    console[m] = (...a) => { try { globalThis.__con.push(a.map((x) => (x && x.message) || (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ')); } catch (e) { /* ignore */ } original(...a); };
  }
});
const consoleText = (w) => w.W(() => (globalThis.__con || []).join('\n'));

// A storage fault for the single write that stores a restored wallet.
//   reject  the write fails      hang   the write never happens      stall  the write happens, then the code stalls
const injectWalletWriteFault = (t, mode) => t.W((m) => {
  const real = globalThis.__realSet2 || (globalThis.__realSet2 = chrome.storage.local.set.bind(chrome.storage.local));
  globalThis.__sf = { mode: m, hits: 0, wrote: false };
  chrome.storage.local.set = (items, cb) => {
    const f = globalThis.__sf;
    if (f && items && typeof items === 'object' && 'atlasWallets' in items) {
      f.hits++;
      if (f.mode === 'reject') return Promise.reject(new Error('QUOTA_BYTES quota exceeded (test)'));
      if (f.mode === 'hang') return new Promise(() => {});
      if (f.mode === 'stall') return real(items).then(() => { f.wrote = true; return new Promise(() => {}); });
    }
    return real(items, cb);
  };
}, mode);
const clearWalletWriteFault = (t) => t.W(() => { if (globalThis.__realSet2) chrome.storage.local.set = globalThis.__realSet2; globalThis.__sf = null; });
async function waitFor(fn, ms) { const end = Date.now() + (ms || 15000); while (Date.now() < end) { if (await fn()) return true; await sleep(100); } return false; }

// ---------------------------------------------------------------- scenario plumbing
async function scenario(kind, label, body, issuerEnv) {
  if (ONLY && !label.startsWith(ONLY)) return;
  console.log(`\n=== [${kind}] ${label} ===`);
  const iss = await startIssuer(kind, issuerEnv);
  const w = await new Wallet(label.replace(/\W+/g, '').slice(0, 10)).launch();
  const extras = [];
  const ctx = {
    // A fresh browser profile (no identity yet). `from` supplies the public key and seed the restore is checked against.
    fresh: async (name, from, opts) => {
      const t = await new Wallet(name, opts).launch();
      if (from) { t.pub = from.pub; t.seed = from.seed; }
      extras.push(t);
      return t;
    }
  };
  try {
    await w.create();
    await body(w, iss, ctx);
  } catch (e) {
    failures++; console.log('FAIL threw in "' + label + '" :: ' + (e.stack || e));
  } finally {
    for (const t of extras) await t.dispose().catch(() => null);
    await w.dispose(); iss.stop();
  }
}

// 20 g, then a second 20 g whose consolidation answer is lost after the issuer committed it.
async function consolidationWithLostAnswer(w, iss) {
  check('setup: first mint of 20 Iron', (await mint(w, iss, IRON, 20)) === 'ok');
  await w.inject('dropAnswer', '/atlas/asset/consolidate');
  await mint(w, iss, IRON, 20).catch(() => null);
  const fault = await w.faultInfo();
  await w.clearFault();
  const sent = fault.bodies[0] ? JSON.parse(fault.bodies[0]) : null;
  const preds = sent ? sent.credentials.map((c) => c.id) : [];
  check('setup: the issuer committed the consolidation (both 20 g credentials revoked), the answer was lost', fault.hits === 1 && preds.length === 2 && preds.every((id) => iss.revoked().has(id)), { hits: fault.hits, preds });
  return { preds, body: sent };
}

// What a wallet holds of one asset class, split into the original predecessors and anything else.
async function holding(w, cls, preds) {
  const rows = await shown(w, cls);
  return { predecessors: rows.filter((r) => preds.includes(r.id)), others: rows.filter((r) => !preds.includes(r.id)) };
}

// A wallet/journal pair is consistent when it is either wholly "before" (entry kept, predecessors present,
// no successor) or wholly "after" (entry gone, predecessors gone, one successor of the full amount).
function classify(pending, h, total) {
  if (pending.length === 1 && h.predecessors.length === 2 && h.others.length === 0) return 'before';
  if (pending.length === 0 && h.predecessors.length === 0 && h.others.length === 1 && h.others[0].q === total) return 'after';
  return 'inconsistent';
}

// The previous wallet.js: the most recent revision that does not know the journal field.
let previousExt = null;
function previousExtension() {
  if (previousExt) return previousExt;
  const repo = path.resolve(__dirname, '..');
  const revs = spawnSync('git', ['log', '--format=%H', '--', 'extension/wallet.js'], { cwd: repo }).stdout.toString().trim().split('\n').filter(Boolean);
  for (const rev of revs) {
    const src = spawnSync('git', ['show', rev + ':extension/wallet.js'], { cwd: repo, maxBuffer: 1 << 28 });
    if (src.status === 0 && !src.stdout.includes(FORMAT)) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-prev-ext-'));
      fs.cpSync(EXT_PATH, dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'wallet.js'), src.stdout);
      previousExt = { dir, rev };
      return previousExt;
    }
  }
  return null;
}

async function main() {
  const kinds = which === 'both' ? ['node', 'php'] : [which];
  for (const kind of kinds) {
    // ---- B1: the journal is in the backup; a fresh profile recovers by the original request id ----
    await scenario(kind, 'B1 manual backup carries the journal; a fresh profile recovers by the original request id (replay retained)', async (w, iss, ctx) => {
      const { preds } = await consolidationWithLostAnswer(w, iss);
      const [entry] = await w.pending();
      const rid = entry.requestId;
      const file = await exportBackup(w);
      const fileText = JSON.stringify(file);
      check('the backup file shows no request id, credential id, issuer domain or journal field name in the clear',
        !fileText.includes(rid) && !preds.some((id) => fileText.includes(id)) && !fileText.includes(iss.domain) && !fileText.includes('pendingOps'));
      const payload = openFile(file, manualSecrets(w));
      const field = payload.data.pendingOps;
      check('the payload carries data.pendingOps: format, the owner, and the one entry with its request id',
        field && field.format === FORMAT && field.owner === w.pub && Array.isArray(field.entries) && field.entries.length === 1 && field.entries[0].requestId === rid, field && { format: field.format, n: field.entries && field.entries.length });
      const e = field.entries[0];
      check('the entry keeps what recovery needs: kind, owner, issuer, path, predecessors, request body with the same request id, credentials, createdAt and attempts',
        e.kind === 'consolidate' && e.owner === w.pub && e.domain === iss.domain && e.path === '/atlas/asset/consolidate' && same(e.predecessors.slice().sort(), preds.slice().sort())
        && e.body.requestId === rid && e.body.credentials.length === 2 && typeof e.createdAt === 'string' && e.attempts === 1, e);
      check('the wallet part of the same payload holds both predecessors, unmarked', payload.data.wallet.filter((c) => preds.includes(c.credential.id)).length === 2 && !payload.data.wallet.some((c) => c.pendingOutcome));

      const t = await ctx.fresh('b1t', w);
      await watchConsole(t);
      await countRequests(t, '/atlas/');
      const r = await importBackup(t, file);
      check('the restore into a fresh profile succeeds and reports the journal: 1 added, nothing set aside', r.ok && r.result.pendingOps.status === 'merged' && r.result.pendingOps.added === 1 && r.result.pendingOps.quarantined === 0, r);
      check('the restore sent no request to any issuer', (await requestCount(t)) === 0, await requestCount(t));
      const pend = await t.pending();
      check('the restored profile has the entry under the original request id, still pending, with its predecessors, kind, issuer and attempts',
        pend.length === 1 && pend[0].requestId === rid && pend[0].state === 'pending' && pend[0].kind === 'consolidate' && pend[0].domain === iss.domain && pend[0].attempts === 1
        && same(pend[0].predecessors.slice().sort(), preds.slice().sort()) && pend[0].createdAt === entry.createdAt, pend);
      let h = await holding(t, IRON, preds);
      check('both predecessors are restored and are shown as held by an unconfirmed transaction (not verified, not valid)',
        h.predecessors.length === 2 && h.predecessors.every((x) => x.held === 'pending' && x.status !== 'verified' && !x.valid) && h.others.length === 0, h);
      check('the quarantine is empty', (await quarantineOf(t)).length === 0);

      const dump = JSON.stringify(await rawAll(t));
      check('nothing in the restored profile\'s storage holds the request id or a predecessor id in plaintext', !dump.includes(rid) && !preds.some((id) => dump.includes(id)));
      const raw = await rawKey(t, 'atlasPendingOps');
      check('the restored journal is stored encrypted under this profile\'s own key', raw && raw.__atlasEncrypted === true && !Array.isArray(raw), raw && Object.keys(raw));
      const logText = JSON.stringify(await t.log());
      check('the activity log records the restore with counts only (no request id, no credential id)', logText.includes('pending operations: 1 added') && !logText.includes(rid) && !preds.some((id) => logText.includes(id)), logText.slice(0, 300));

      const revBefore = iss.revCount();
      const rec = await t.recover();
      check('recovery by the original request id completes from the issuer\'s retained answer', rec.length === 1 && rec[0].status === 'completed' && rec[0].applied === true && rec[0].requestId === rid, rec);
      h = await holding(t, IRON, preds);
      check('the wallet now holds exactly one 40 g successor, the predecessors are gone, the journal is empty',
        h.predecessors.length === 0 && h.others.length === 1 && h.others[0].q === 40 && h.others[0].status === 'verified' && (await t.pending()).length === 0, h);
      check('no new revocation and no new credential was created at the issuer by the replay', iss.revCount() === revBefore, { before: revBefore, now: iss.revCount() });
      check('a second recovery finds nothing and changes nothing', (await t.recover()).length === 0 && (await holding(t, IRON, preds)).others.length === 1);
      await t.restart(true);
      h = await holding(t, IRON, preds);
      check('after a browser restart: still one 40 g credential, no journal', h.others.length === 1 && h.others[0].q === 40 && (await t.pending()).length === 0, h);
      const consoleOut = await consoleText(t);
      check('the extension console shows neither the request id nor a credential id', !consoleOut.includes(rid) && !preds.some((id) => consoleOut.includes(id)), consoleOut.slice(0, 300));

      const recOriginal = await w.recover();
      const original = await holding(w, IRON, preds);
      const restored = await holding(t, IRON, preds);
      check('the original profile recovers the same successor (same credential id) from the same stored answer',
        recOriginal.length === 1 && recOriginal[0].status === 'completed' && original.others.length === 1 && original.others[0].id === restored.others[0].id && iss.revCount() === revBefore, { recOriginal, original, restored });
    });

    // ---- B2: the issuer's answer has expired ----
    await scenario(kind, 'B2 expired replay: the restored entry is needs-attention, never completed, predecessors stay held', async (w, iss, ctx) => {
      const { preds } = await consolidationWithLostAnswer(w, iss);
      const [entry] = await w.pending();
      const file = await exportBackup(w);
      await sleep(EXPIRY_WAIT_MS);
      const t = await ctx.fresh('b2t', w);
      await countRequests(t, '/atlas/');
      const r = await importBackup(t, file);
      check('restore succeeds and sends nothing, although the issuer can no longer answer', r.ok && (await requestCount(t)) === 0, r);
      const revBefore = iss.revCount();
      const rec = await t.recover();
      check('recovery reports needs-attention, not completed and not failed', rec.length === 1 && rec[0].status === 'needs-attention' && rec[0].requestId === entry.requestId, rec);
      const [after] = await t.pending();
      check('the entry is kept with the issuer\'s refusal recorded (revoked) and both predecessors named',
        after && after.state === 'needs-attention' && after.attention && after.attention.code === 'revoked' && preds.every((id) => after.attention.revokedPredecessors.includes(id)), after);
      const h = await holding(t, IRON, preds);
      check('both predecessors are still in the wallet, none verified or valid, each marked as needing attention; nothing recreated',
        h.predecessors.length === 2 && h.predecessors.every((x) => x.held === 'needs-attention' && x.status !== 'verified' && !x.valid) && h.others.length === 0 && iss.revCount() === revBefore, h);
      await t.W(() => AtlasWallet.reverifyAll());
      const h2 = await holding(t, IRON, preds);
      check('re-verify does not release them', h2.predecessors.length === 2 && h2.predecessors.every((x) => x.held === 'needs-attention' && !x.valid), h2);
      const creds = await t.W((k) => AtlasWallet.getWallet(k).then((l) => l.map((e) => e.credential)), t.pub);
      const requestsBefore = await requestCount(t);
      const refusals = await t.W(async ([c, pub]) => {
        const out = {};
        for (const [name, fn] of Object.entries({
          consolidate: () => AtlasWallet.consolidateAsset('self', c), split: () => AtlasWallet.splitAsset('self', c[0], 5, 'self'),
          convert: () => AtlasWallet.convertAsset('self', c[0], 5, 'atlas.element.gold'), remove: () => AtlasWallet.deleteAsset(pub, c[0].id)
        })) { try { await fn(); out[name] = 'allowed'; } catch (e) { out[name] = e.code; } }
        return out;
      }, [creds, t.pub]);
      check('spending, splitting, converting and deleting a restored predecessor are refused as unresolved', Object.values(refusals).every((c) => c === 'unresolved-operation'), refusals);
      check('and those refusals sent nothing', (await requestCount(t)) === requestsBefore, { before: requestsBefore, now: await requestCount(t) });

      // A backup made from the needs-attention state keeps the state and the evidence.
      const file2 = await exportBackup(t);
      const field2 = openFile(file2, manualSecrets(t)).data.pendingOps;
      check('a backup made after the refusal carries the entry as needs-attention with its attention record', field2.entries.length === 1 && field2.entries[0].state === 'needs-attention' && field2.entries[0].attention.code === 'revoked', field2.entries[0]);
      const t2 = await ctx.fresh('b2t2', w);
      await countRequests(t2, '/atlas/');
      const r2 = await importBackup(t2, file2);
      const [e2] = await t2.pending();
      check('restoring that backup keeps needs-attention (not reset to pending) and the refusal evidence', r2.ok && e2 && e2.state === 'needs-attention' && e2.attention && e2.attention.code === 'revoked', e2);
      const rec2 = await t2.recover();
      check('recovery on the second restore sends nothing for a needs-attention entry', rec2.length === 1 && rec2[0].status === 'needs-attention' && (await requestCount(t2)) === 0, { rec2, n: await requestCount(t2) });
      info('after the retention the signed 40 g successor exists only in the issuer\'s expired answer: restoring the journal preserves the evidence, it cannot recreate the credential');
    }, TTL_ENV);

    // ---- B3: backups made before the field existed ----
    await scenario(kind, 'B3 a backup with no journal field is handled explicitly: nothing carried, nothing changed', async (w, iss, ctx) => {
      const { preds } = await consolidationWithLostAnswer(w, iss);
      const file = await exportBackup(w);
      const old = craft(file, manualSecrets(w), (p) => { delete p.data.pendingOps; });
      check('setup: the crafted file has no pendingOps field at all', !('pendingOps' in openFile(old, manualSecrets(w)).data));
      const t = await ctx.fresh('b3t', w);
      const r = await importBackup(t, old);
      check('restore into a fresh profile succeeds and reports the journal as absent (not malformed, not empty-merged)', r.ok && r.result.pendingOps.status === 'absent' && r.result.pendingOps.quarantined === 0, r);
      check('no journal appears and nothing is set aside', (await t.pending()).length === 0 && (await quarantineOf(t)).length === 0);
      const h = await holding(t, IRON, preds);
      check('the wallet itself is restored', h.predecessors.length === 2, h);
      check('the activity log does not claim anything about pending operations', !JSON.stringify(await t.log()).includes('pending operations'));

      // Onto the original profile, which still has its entry: an absent field never clears or alters it.
      const before = await rawKey(w, 'atlasPendingOps');
      const r2 = await importBackup(w, old);
      const after = await rawKey(w, 'atlasPendingOps');
      check('restoring an old backup onto a profile that has an unresolved entry leaves the stored journal byte-for-byte untouched',
        r2.ok && r2.result.pendingOps.status === 'absent' && same(before, after) && (await w.pending()).length === 1, { r2, same: same(before, after) });
    });

    // ---- B4: a journal field that is present but not usable ----
    await scenario(kind, 'B4 a malformed journal field is set aside whole, never turned into an empty journal', async (w, iss, ctx) => {
      const { preds } = await consolidationWithLostAnswer(w, iss);
      const file = await exportBackup(w);
      const good = openFile(file, manualSecrets(w)).data.pendingOps;
      const variants = {
        'a string': 'garbage',
        'null': null,
        'an array': [good.entries[0]],
        'a number': 7,
        'an unknown format version': Object.assign({}, good, { format: 'atlas-pending-ops/9.9' }),
        'entries that are not a list': Object.assign({}, good, { entries: 'x' }),
        'entries that are null': Object.assign({}, good, { entries: null }),
        'a missing format': { owner: good.owner, entries: good.entries }
      };
      const t = await ctx.fresh('b4t', w);
      let expectedQuarantine = 0;
      for (const [name, value] of Object.entries(variants)) {
        const bad = craft(file, manualSecrets(w), (p) => { p.data.pendingOps = value; });
        const r = await importBackup(t, bad);
        expectedQuarantine++;
        const q = await quarantineOf(t);
        check(`field is ${name}: restore succeeds, status quarantined, no journal entry invented`, r.ok && r.result.pendingOps.status === 'quarantined' && (await t.pending()).length === 0, r);
        check(`field is ${name}: the whole field is in the quarantine as 'malformed-field'`, q.length === expectedQuarantine && q.some((x) => x.reason === 'malformed-field' && x.source === 'backup' && same(x.value, value)), q.map((x) => x.reason));
      }
      const h = await holding(t, IRON, preds);
      check('the wallet part was restored every time', h.predecessors.length === 2);
      const again = await importBackup(t, craft(file, manualSecrets(w), (p) => { p.data.pendingOps = 'garbage'; }));
      check('the same bad field restored again is not stored twice', again.ok && (await quarantineOf(t)).length === expectedQuarantine);
      const raw = await rawKey(t, 'atlasPendingOpsQuarantine');
      check('the quarantine is stored encrypted', raw && raw.__atlasEncrypted === true);
    });

    // ---- B5: single entries that cannot be restored ----
    await scenario(kind, 'B5 entries that are for another owner, malformed or unknown are set aside one by one', async (w, iss, ctx) => {
      const { preds } = await consolidationWithLostAnswer(w, iss);
      const file = await exportBackup(w);
      const goodEntry = openFile(file, manualSecrets(w)).data.pendingOps.entries[0];
      const other = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE-not-this-owner';
      let n = 0;
      const variant = (reason, fn) => { const e = clone(goodEntry); n++; e.requestId = 'rid-test-' + n; if (e.body) e.body.requestId = e.requestId; fn(e); return { reason, entry: e }; };
      const cases = [
        variant('wrong-owner', (e) => { e.owner = other; }),
        variant('wrong-owner', (e) => { e.toOwner = other; }),
        variant('wrong-owner', (e) => { e.body.ownerPublicKey = other; }),
        variant('wrong-owner', (e) => { e.body.credentials[0].owner.publicKey = other; }),
        variant('malformed', (e) => { e.body.requestId = 'a-different-request-id'; }),
        variant('unknown-operation', (e) => { e.kind = 'transfer'; }),
        variant('unknown-operation', (e) => { e.path = '/atlas/elsewhere'; }),
        variant('malformed', (e) => { e.domain = 'evil host/../x'; }),
        variant('malformed', (e) => { e.state = 'done'; }),
        variant('malformed', (e) => { e.attempts = -1; }),
        variant('malformed', (e) => { e.predecessors = [1, 2]; }),
        variant('malformed', (e) => { e.attention = 'x'; }),
        { reason: 'unusable', entry: 42 },
        { reason: 'unusable', entry: null },
        { reason: 'unusable', entry: 'text' },
        variant('unusable', (e) => { delete e.body; })
      ];
      const bad = craft(file, manualSecrets(w), (p) => { p.data.pendingOps.entries = [cases[0].entry, goodEntry].concat(cases.slice(1).map((c) => c.entry)); });
      const t = await ctx.fresh('b5t', w);
      const r = await importBackup(t, bad);
      check('restore succeeds; the good entry is added, every bad one is set aside', r.ok && r.result.pendingOps.added === 1 && r.result.pendingOps.quarantined === cases.length, r);
      const pend = await t.pending();
      check('the journal holds exactly the good entry, still owned by the restored key', pend.length === 1 && pend[0].requestId === goodEntry.requestId, pend);
      const q = await quarantineOf(t);
      check('the quarantine holds every bad entry, each with its reason, none altered',
        q.length === cases.length && cases.every((c) => q.some((x) => x.reason === c.reason && x.source === 'backup' && same(x.value, c.entry))),
        { have: q.map((x) => x.reason), want: cases.map((c) => c.reason) });
      check('no restored entry was reassigned to another owner key', !JSON.stringify(pend).includes(other));
      const rec = await t.recover();
      check('the good entry still recovers normally', rec.length === 1 && rec[0].status === 'completed', rec);
    });

    // ---- B6: merging into a journal that already has entries ----
    await scenario(kind, 'B6 merge by request id: repeated restores, newer local progress, adopted evidence, conflicts', async (w, iss, ctx) => {
      const { preds } = await consolidationWithLostAnswer(w, iss);
      const [e1] = await w.pending();
      const rid = e1.requestId;
      const F1 = await exportBackup(w);
      await countRequests(w, '/atlas/');

      for (let i = 1; i <= 3; i++) {
        if (i === 3) { await w.restart(true); await countRequests(w, '/atlas/'); }
        const r = await importBackup(w, F1);
        check(`restore #${i} of the same backup onto the same profile: nothing added, entry unchanged`, r.ok && r.result.pendingOps.added === 0 && r.result.pendingOps.unchanged === 1 && r.result.pendingOps.quarantined === 0, r);
      }
      let pend = await w.pending();
      let h = await holding(w, IRON, preds);
      check('after three restores (one after a restart): one entry, two predecessors, no duplicate credential, no request sent',
        pend.length === 1 && pend[0].requestId === rid && h.predecessors.length === 2 && h.others.length === 0 && (await requestCount(w)) === 0, { pend, h });

      // newer local progress is not overwritten by an older copy of the same entry
      await w.inject('failFetch', '/atlas/asset/consolidate');
      const rec = await w.recover();
      await w.clearFault();
      pend = await w.pending();
      check('setup: a failed attempt raised the local attempt count above the backup\'s', rec[0].status === 'pending' && pend[0].attempts >= 2 && !!pend[0].lastError, pend);
      const attemptsLocal = pend[0].attempts;
      const r2 = await importBackup(w, F1);
      pend = await w.pending();
      check('restoring the older backup keeps the newer attempt count and last error', r2.ok && pend.length === 1 && pend[0].attempts === attemptsLocal && !!pend[0].lastError, pend);

      // evidence in the backup is adopted, never downgraded
      const attention = { at: new Date().toISOString(), status: 400, code: 'revoked', message: 'test evidence', revokedPredecessors: preds };
      const F2 = craft(F1, manualSecrets(w), (p) => { const e = p.data.pendingOps.entries[0]; e.state = 'needs-attention'; e.attention = attention; e.attempts = 9; });
      const r3 = await importBackup(w, F2);
      pend = await w.pending();
      check('a backup whose copy of the entry is needs-attention turns the local pending entry into needs-attention and keeps the higher attempt count',
        r3.ok && r3.result.pendingOps.merged === 1 && pend.length === 1 && pend[0].state === 'needs-attention' && pend[0].attempts === 9 && pend[0].attention && pend[0].attention.code === 'revoked', { r3, pend });
      const r4 = await importBackup(w, F1);
      pend = await w.pending();
      check('restoring the older pending copy afterwards does not downgrade it', r4.ok && pend[0].state === 'needs-attention' && pend[0].attempts === 9 && r4.result.pendingOps.unchanged === 1, { r4, pend });

      // same request id, different content: conflict
      const variants = {
        'different predecessors': (e) => { e.predecessors = ['urn:other-credential']; },
        'a different request body': (e) => { e.body.credentials = e.body.credentials.slice(0, 1); },
        'a different issuer': (e) => { e.domain = 'elsewhere.example'; },
        'a different creation time': (e) => { e.createdAt = '2001-01-01T00:00:00.000Z'; }
      };
      let conflicts = 0;
      const localBefore = JSON.stringify(await w.pending());
      for (const [name, fn] of Object.entries(variants)) {
        const bad = craft(F1, manualSecrets(w), (p) => { fn(p.data.pendingOps.entries[0]); });
        const r = await importBackup(w, bad);
        conflicts++;
        const q = await quarantineOf(w);
        check(`conflict (${name}): reported, the backup\'s entry is set aside whole, the local entry is untouched`,
          r.ok && r.result.pendingOps.conflicts === 1 && q.filter((x) => x.reason === 'conflict').length === conflicts && JSON.stringify(await w.pending()) === localBefore, { r, reasons: q.map((x) => x.reason) });
      }
      const dup = await importBackup(w, craft(F1, manualSecrets(w), (p) => { variants['different predecessors'](p.data.pendingOps.entries[0]); }));
      check('the same conflicting backup restored again is not queued a second time', dup.ok && (await quarantineOf(w)).filter((x) => x.reason === 'conflict').length === conflicts);

      // a newer, unrelated unresolved operation on the device is not dropped by an older backup
      check('setup: a Gold pair whose consolidation answer is lost', (await mint(w, iss, GOLD, 20)) === 'ok');
      await w.inject('dropAnswer', '/atlas/asset/consolidate');
      await mint(w, iss, GOLD, 20).catch(() => null);
      const goldFault = await w.faultInfo();
      await w.clearFault();
      pend = await w.pending();
      const e2 = pend.find((e) => e.requestId !== rid);
      check('setup: a second, different entry exists next to the first', pend.length === 2 && !!e2 && goldFault.hits === 1, pend);
      const r5 = await importBackup(w, F1);
      pend = await w.pending();
      check('restoring the older backup keeps both entries (the newer one is not in the backup and is not removed)', r5.ok && pend.length === 2 && pend.some((e) => e.requestId === e2.requestId) && pend.some((e) => e.requestId === rid), pend);
      const retried = await retry(w, rid);
      const recAll = await w.recover();
      check('the needs-attention entry is completed by an explicit retry (late answer applied once); the other by ordinary recovery',
        retried.status === 'completed' && retried.applied === true && recAll.length === 1 && recAll[0].requestId === e2.requestId && recAll[0].status === 'completed', { retried, recAll });
      const ironH = await holding(w, IRON, preds), goldRows = await shown(w, GOLD);
      check('end state: one 40 g Iron and one 40 g Gold successor, no journal left', ironH.others.length === 1 && ironH.others[0].q === 40 && ironH.predecessors.length === 0 && goldRows.filter((r) => !r.spent).length >= 1 && (await w.pending()).length === 0, { ironH, goldRows });
    });

    // ---- B6b: two entries that claim the same predecessors ----
    await scenario(kind, 'B6b entries with different request ids but the same predecessors are both kept; only one can complete', async (w, iss, ctx) => {
      const { preds } = await consolidationWithLostAnswer(w, iss);
      const file = await exportBackup(w);
      const rival = craft(file, manualSecrets(w), (p) => {
        const e = clone(p.data.pendingOps.entries[0]);
        e.requestId = 'rival-request-id-0001'; e.body.requestId = e.requestId;
        p.data.pendingOps.entries.push(e);
      });
      const t = await ctx.fresh('b6bt', w);
      const r = await importBackup(t, rival);
      check('both are added, and the overlap is reported', r.ok && r.result.pendingOps.added === 2 && r.result.pendingOps.overlaps === 1 && (await t.pending()).length === 2, r);
      const revBefore = iss.revCount();
      const rec = await t.recover();
      const done = rec.filter((x) => x.status === 'completed'), attention = rec.filter((x) => x.status === 'needs-attention');
      check('recovery completes the real request from the retained answer and leaves the rival as needs-attention', done.length === 1 && done[0].requestId !== 'rival-request-id-0001' && attention.length === 1 && attention[0].requestId === 'rival-request-id-0001', rec);
      const h = await holding(t, IRON, preds);
      check('exactly one 40 g successor, no extra revocation', h.others.length === 1 && h.others[0].q === 40 && iss.revCount() === revBefore, { h, revBefore, now: iss.revCount() });
      check('the rival entry remains as evidence', (await t.pending()).length === 1 && (await t.pending())[0].state === 'needs-attention');
    });

    // ---- B7: interrupted restores and an interrupted backup ----
    await scenario(kind, 'B7 interruption: a restore stores the wallet and the journal together or not at all', async (w, iss, ctx) => {
      const { preds } = await consolidationWithLostAnswer(w, iss);
      const file = await exportBackup(w);
      const ownerKeys = async (t) => { const raw = await t.W(async (pub) => { const s = await chrome.storage.local.get(['atlasWallets', 'atlasPendingOps']); return { wallet: !!(s.atlasWallets && s.atlasWallets[pub]), journal: !!(s.atlasPendingOps && s.atlasPendingOps[pub]) }; }, w.pub); return raw; };

      // 1. the write is rejected
      const t = await ctx.fresh('b7t', w);
      await injectWalletWriteFault(t, 'reject');
      const r = await importBackup(t, file);
      check('the combined write fails: the restore reports an error', !r.ok, r);
      check('and neither a wallet nor a journal was stored', same(await ownerKeys(t), { wallet: false, journal: false }), await ownerKeys(t));
      await clearWalletWriteFault(t);
      const r2 = await importBackup(t, file);
      check('restoring the same backup again succeeds and brings both', r2.ok && same(await ownerKeys(t), { wallet: true, journal: true }) && (await t.pending()).length === 1, r2);

      // 2. the browser is killed before the write happens
      const t2 = await ctx.fresh('b7t2', w);
      await injectWalletWriteFault(t2, 'hang');
      const p2 = importBackup(t2, file).catch(() => null);
      check('setup: the restore reached the wallet write', await waitFor(() => t2.W(() => globalThis.__sf && globalThis.__sf.hits > 0)));
      await t2.kill(); await p2;
      await t2.launch(); await t2.unlock();
      check('killed before the write: no wallet and no journal for the restored identity', same(await ownerKeys(t2), { wallet: false, journal: false }), await ownerKeys(t2));
      const r3 = await importBackup(t2, file);
      check('the interrupted restore can simply be run again', r3.ok && (await t2.pending()).length === 1 && (await holding(t2, IRON, preds)).predecessors.length === 2, r3);

      // 3. the browser is killed right after the write
      const t3 = await ctx.fresh('b7t3', w);
      await injectWalletWriteFault(t3, 'stall');
      const p3 = importBackup(t3, file).catch(() => null);
      check('setup: the wallet write happened', await waitFor(() => t3.W(() => globalThis.__sf && globalThis.__sf.wrote)));
      await t3.kill(); await p3;
      await t3.launch(); await t3.unlock();
      check('killed right after the write: wallet and journal are both there, together', same(await ownerKeys(t3), { wallet: true, journal: true }) && (await t3.pending()).length === 1 && (await holding(t3, IRON, preds)).predecessors.length === 2, await ownerKeys(t3));
      const r4 = await importBackup(t3, file);
      check('running that restore again changes nothing: still one entry, two predecessors', r4.ok && r4.result.pendingOps.unchanged === 1 && (await t3.pending()).length === 1 && (await holding(t3, IRON, preds)).predecessors.length === 2, r4);

      // 4. the browser is killed while a backup is being made
      const before = JSON.stringify(await w.rawStores());
      const pe = exportBackup(w).catch(() => null);
      await sleep(150);
      await w.kill(); await pe;
      await w.launch(); await w.unlock();
      const after = JSON.stringify(await w.rawStores());
      check('killed during an export: the wallet and journal are exactly as they were (a backup only reads them)', before === after && (await w.pending()).length === 1);
      const again = await exportBackup(w);
      check('and a new export afterwards still carries the entry', openFile(again, manualSecrets(w)).data.pendingOps.entries.length === 1);
    });

    // ---- B8: the wallet and journal in one backup describe the same moment ----
    await scenario(kind, 'B8 consistent capture: backups made while an answer is being applied never mix the two states', async (w, iss, ctx) => {
      check('setup: first mint', (await mint(w, iss, IRON, 20)) === 'ok');
      let total = 20;
      const tally = { before: 0, after: 0, inconsistent: 0 };
      for (let round = 1; round <= 5; round++) {
        await w.inject('dropAnswer', '/atlas/asset/consolidate');
        await mint(w, iss, IRON, 20).catch(() => null);
        const fault = await w.faultInfo();
        await w.clearFault();
        total += 20;
        const sentPreds = JSON.parse(fault.bodies[0]).credentials.map((c) => c.id);
        const delays = [0, 20, 45, 80, 120, 170];
        const exports = delays.map((d) => sleep(d).then(() => exportBackup(w).catch((e) => ({ error: e.message }))));
        const recovery = sleep(60).then(() => w.recover());
        const files = await Promise.all(exports); await recovery;
        for (const f of files) {
          if (f.error) { tally.inconsistent++; console.log('export error ' + f.error); continue; }
          const p = openFile(f, manualSecrets(w));
          const wallet = p.data.wallet.filter((c) => c.credential.asset.class === IRON).map((c) => c.credential);
          const entries = p.data.pendingOps.entries;
          const hasPreds = sentPreds.every((id) => wallet.some((c) => c.id === id));
          const anyPred = sentPreds.some((id) => wallet.some((c) => c.id === id));
          const successors = wallet.filter((c) => !sentPreds.includes(c.id));
          let state = 'inconsistent';
          if (entries.length === 1 && hasPreds && successors.length === 0) state = 'before';
          else if (entries.length === 0 && !anyPred && successors.length === 1 && successors[0].quantity === total) state = 'after';
          tally[state]++;
        }
        const now = await holding(w, IRON, sentPreds);
        if (classify(await w.pending(), now, total) !== 'after') { tally.inconsistent++; console.log('wallet not settled after round ' + round); }
      }
      check('30 backups taken while 5 answers were being applied: every one is wholly before or wholly after', tally.inconsistent === 0, tally);
      info(`captured states: ${tally.before} before the answer was applied, ${tally.after} after`);
    });

    // ---- B9: another identity ----
    await scenario(kind, 'B9 cross-identity: a pending entry is never reassigned to another owner key', async (w, iss, ctx) => {
      const { preds } = await consolidationWithLostAnswer(w, iss);
      const [entryY] = await w.pending();
      const file = await exportBackup(w);

      // a device with its own identity X and its own unresolved operation
      const t = await ctx.fresh('b9t', null);
      await t.create();
      const X = t.pub;
      check('setup: identity X on the target is different from the backup\'s identity', X !== w.pub);
      check('setup: X has 20 g', (await mint(t, iss, IRON, 20)) === 'ok');
      await t.inject('dropAnswer', '/atlas/asset/consolidate');
      await mint(t, iss, IRON, 20).catch(() => null);
      await t.clearFault();
      const [entryX] = await t.pending();
      check('setup: X has a pending entry of its own', !!entryX && entryX.requestId !== entryY.requestId);
      const xJournal = await rawKey(t, 'atlasPendingOps'), xWallet = await rawKey(t, 'atlasWallets');
      const xSeed = t.seed || null;

      t.pub = w.pub; t.seed = w.seed;
      const r = await importBackup(t, file);
      check('restoring the other identity\'s backup succeeds', r.ok && r.result.publicKey === w.pub, r);
      const journalAll = await t.W(() => chrome.storage.local.get('atlasPendingOps').then((s) => s.atlasPendingOps));
      check('the restored identity has its own entry under its own key', (await t.pending()).length === 1 && (await t.pending())[0].requestId === entryY.requestId);
      check('identity X\'s stored journal and wallet were not touched, rewritten or merged into the other identity\'s',
        same(journalAll[X], xJournal) && same((await t.W(() => chrome.storage.local.get('atlasWallets').then((s) => s.atlasWallets)))[X], xWallet));
      check('X\'s request id is not in the restored identity\'s journal', !JSON.stringify(await t.pending()).includes(entryX.requestId));
      info('a full-backup restore replaces the device\'s active identity (existing behaviour); X\'s records stay in storage encrypted under X\'s key and are unreachable until X is unlocked again');

      // a backup whose entries are for X
      const forX = craft(file, manualSecrets(w), (p) => {
        p.data.pendingOps.entries.forEach((e) => { e.owner = X; });
      });
      const t2 = await ctx.fresh('b9t2', w);
      const r2 = await importBackup(t2, forX);
      check('entries labelled with another owner are set aside, none is restored under the backup\'s identity',
        r2.ok && r2.result.pendingOps.added === 0 && r2.result.pendingOps.quarantined === 1 && (await t2.pending()).length === 0 && (await quarantineOf(t2))[0].reason === 'wrong-owner', r2);
      const fieldForX = craft(file, manualSecrets(w), (p) => { p.data.pendingOps.owner = X; });
      const t3 = await ctx.fresh('b9t3', w);
      const r3 = await importBackup(t3, fieldForX);
      check('a journal field that names another owner is set aside whole', r3.ok && r3.result.pendingOps.status === 'quarantined' && (await t3.pending()).length === 0 && (await quarantineOf(t3))[0].reason === 'wrong-owner', r3);
      check('and the wallet of the exact identity is still restored', (await holding(t3, IRON, preds)).predecessors.length === 2);
    });

    // ---- B10: locked and unreadable stores ----
    await scenario(kind, 'B10 fail closed: no backup from a store that cannot be read; no restore that cannot be stored safely', async (w, iss, ctx) => {
      const { preds } = await consolidationWithLostAnswer(w, iss);
      const [entry] = await w.pending();
      const file = await exportBackup(w);
      const fails = (promise) => promise.then(() => ({ ok: true }), (e) => ({ ok: false, code: e.code, message: e.message }));
      const tryExport = (t) => t.W(([pw, seed]) => AtlasWallet.exportFullBackup(pw, seed).then(() => ({ ok: true }), (e) => ({ ok: false, code: e.code, message: e.message })), [PASSWORD, w.seed]);
      const tryAuto = (t) => t.W((pw) => (async () => AtlasWallet.buildAutoBackupBlob(await AtlasWallet.getIdentity(), pw))().then(() => ({ ok: true }), (e) => ({ ok: false, code: e.code, message: e.message })), PASSWORD);

      // locked
      await w.W(() => AtlasWallet.lockIdentity());
      const e1 = await tryExport(w), a1 = await tryAuto(w);
      check('a locked wallet makes neither a manual nor an automatic backup', !e1.ok && !a1.ok, { e1, a1 });
      await w.unlock();
      const good = await tryExport(w);
      check('and unlocking makes them work again', good.ok);

      // unreadable journal
      const corrupt = (t, key) => t.W(async ([k, pub]) => { const s = await chrome.storage.local.get(k); const all = s[k] || {}; all[pub] = { __atlasEncrypted: true, iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAA' }; await chrome.storage.local.set({ [k]: all }); }, [key, t.pub]);
      const original = await rawKey(w, 'atlasPendingOps');
      await corrupt(w, 'atlasPendingOps');
      const damaged = await rawKey(w, 'atlasPendingOps');
      const e2 = await tryExport(w), a2 = await tryAuto(w);
      check('an unreadable journal stops both kinds of backup (wallet-unreadable), instead of producing a backup without it', !e2.ok && !a2.ok && e2.code === 'wallet-unreadable' && a2.code === 'wallet-unreadable', { e2, a2 });
      check('the error text does not contain the request id', !JSON.stringify([e2, a2]).includes(entry.requestId));

      // restore with an unreadable local journal and a backup that has one
      const r = await importBackup(w, file);
      const q = await quarantineOf(w);
      check('restoring over an unreadable local journal keeps the unreadable data in the quarantine before replacing it',
        r.ok && r.result.pendingOps.localJournalUnreadable === true && q.some((x) => x.reason === 'unreadable-local-journal' && x.source === 'local' && same(x.value, damaged)), { r, reasons: q.map((x) => x.reason) });
      check('and the journal is the backup\'s entry', (await w.pending()).length === 1 && (await w.pending())[0].requestId === entry.requestId);

      // restore with an unreadable local journal and an old backup that has none
      const old = craft(file, manualSecrets(w), (p) => { delete p.data.pendingOps; });
      await corrupt(w, 'atlasPendingOps');
      const damaged2 = await rawKey(w, 'atlasPendingOps');
      const r2 = await importBackup(w, old);
      check('an old backup (no journal) over an unreadable local journal leaves the damaged journal exactly as it is and says so',
        r2.ok && r2.result.pendingOps.status === 'absent' && r2.result.pendingOps.localJournalUnreadable === true && same(await rawKey(w, 'atlasPendingOps'), damaged2), r2);
      const refusedMint = await mint(w, iss, GOLD, 5);
      check('and the wallet keeps refusing to send anything while that journal is unreadable', refusedMint && refusedMint.code === 'wallet-unreadable' && same(await rawKey(w, 'atlasPendingOps'), damaged2), refusedMint);

      // unreadable quarantine
      const t = await ctx.fresh('b10t', w);
      check('setup: a restore that sets something aside', (await importBackup(t, craft(file, manualSecrets(w), (p) => { p.data.pendingOps = 'garbage'; }))).ok);
      await corrupt(t, 'atlasPendingOpsQuarantine');
      const beforeWallet = await rawKey(t, 'atlasWallets'), beforeJournal = await rawKey(t, 'atlasPendingOps');
      const r3 = await importBackup(t, craft(file, manualSecrets(w), (p) => { p.data.pendingOps = 'garbage2'; }));
      check('a restore that has to add to an unreadable quarantine fails and writes neither the wallet nor the journal',
        !r3.ok && same(await rawKey(t, 'atlasWallets'), beforeWallet) && same(await rawKey(t, 'atlasPendingOps'), beforeJournal), r3);
      check('its error text does not contain the request id', !JSON.stringify(r3).includes(entry.requestId));

      // locked while the restore runs
      const t2 = await ctx.fresh('b10t2', w);
      await t2.inject('lockOnWalletRead', '1');
      const r4 = await importBackup(t2, file);
      const stored = await t2.W(async (pub) => { const s = await chrome.storage.local.get(['atlasWallets', 'atlasPendingOps']); return { wallet: !!(s.atlasWallets && s.atlasWallets[pub]), journal: !!(s.atlasPendingOps && s.atlasPendingOps[pub]) }; }, w.pub);
      check('the wallet locking during a restore stops it: no wallet and no journal stored, an error is reported', !r4.ok && same(stored, { wallet: false, journal: false }), { r4, stored });
    });

    // ---- B11: concurrency ----
    await scenario(kind, 'B11 concurrent restores, concurrent recoveries, and a restore racing a recovery', async (w, iss, ctx) => {
      const { preds } = await consolidationWithLostAnswer(w, iss);
      const [entry] = await w.pending();
      const rid = entry.requestId;
      const file = await exportBackup(w);

      const t = await ctx.fresh('b11t', w);
      const both = await Promise.all([importBackup(t, file), importBackup(t, file)]);
      check('two restores of the same backup at the same time both succeed and add the entry exactly once',
        both.every((x) => x.ok) && both.reduce((n, x) => n + x.result.pendingOps.added, 0) === 1 && (await t.pending()).length === 1 && (await holding(t, IRON, preds)).predecessors.length === 2, both);
      const revBefore = iss.revCount();
      const results = await Promise.all([t.recover(), t.recover(), retry(t, rid), retry(t, rid)]);
      const applied = results.flat().filter((x) => x && x.applied === true).length;
      const h = await holding(t, IRON, preds);
      check('two recoveries and two manual retries at once apply the answer exactly once', applied === 1 && h.others.length === 1 && h.others[0].q === 40 && h.predecessors.length === 0 && (await t.pending()).length === 0 && iss.revCount() === revBefore, { results, h });
      await t.restart(true);
      check('after a restart the wallet is unchanged (one 40 g credential)', (await holding(t, IRON, preds)).others.length === 1);

      // A restore running while the same request's answer is arriving on the original profile
      await w.inject('delayAnswer', '/atlas/asset/consolidate');
      const racing = w.recover();
      check('setup: the answer is in flight', await w.waitHits(1));
      const r = await importBackup(w, file);
      await w.release();
      const rec = await racing;
      await w.clearFault();
      let pend = await w.pending();
      let hh = await holding(w, IRON, preds);
      check('a restore of the same backup during an in-flight recovery ends consistent (wholly applied)', r.ok && classify(pend, hh, 40) === 'after', { r, pend, hh, rec });

      // The older backup restored after the answer was applied: the wallet rolls back with its journal
      const r2 = await importBackup(w, file);
      pend = await w.pending(); hh = await holding(w, IRON, preds);
      check('restoring the older backup after the answer was applied returns the pair to its earlier consistent state (entry and predecessors)', r2.ok && classify(pend, hh, 40) === 'before', { pend, hh });
      const rec2 = await w.recover();
      hh = await holding(w, IRON, preds);
      check('and recovery by the same request id completes it again, with one credential and no new revocation',
        rec2.length === 1 && rec2[0].status === 'completed' && classify(await w.pending(), hh, 40) === 'after' && iss.revCount() === revBefore, { rec2, hh });
      info('restoring a backup replaces the wallet list with the backup\'s (existing behaviour); the journal entry restored with it is what makes that rollback recoverable');
    });

    // ---- B12: the backup file is authenticated as a whole ----
    await scenario(kind, 'B12 the backup file is authenticated as a whole; the journal cannot be altered without the keys', async (w, iss, ctx) => {
      await consolidationWithLostAnswer(w, iss);
      const file = await exportBackup(w);
      const t = await ctx.fresh('b12t', w);
      const flip = (b64, at) => { const b = Buffer.from(b64, 'base64url'); b[at < 0 ? b.length + at : at] ^= 1; return b.toString('base64url'); };
      const tampered = {
        'a changed ciphertext byte (middle)': Object.assign({}, file, { ciphertext: flip(file.ciphertext, Math.floor(Buffer.from(file.ciphertext, 'base64url').length / 2)) }),
        'a changed ciphertext byte (first)': Object.assign({}, file, { ciphertext: flip(file.ciphertext, 0) }),
        'a changed authentication tag': Object.assign({}, file, { ciphertext: flip(file.ciphertext, -1) }),
        'a truncated ciphertext': Object.assign({}, file, { ciphertext: Buffer.from(file.ciphertext, 'base64url').subarray(0, -17).toString('base64url') }),
        'a changed iv': Object.assign({}, file, { iv: flip(file.iv, 0) }),
        'a changed salt': Object.assign({}, file, { salt: flip(file.salt, 0) }),
        'a changed iteration count': Object.assign({}, file, { kdfIterations: file.kdfIterations - 1 })
      };
      for (const [name, bad] of Object.entries(tampered)) {
        const r = await importBackup(t, bad);
        check(`${name}: the restore is refused with the generic message`, !r.ok && /Incorrect password or seed phrase/.test(r.message), r);
      }
      const store = await t.W(() => chrome.storage.local.get(['atlasIdentity', 'atlasWallets', 'atlasPendingOps']));
      check('refused restores wrote nothing (no identity, wallet or journal)', !store.atlasIdentity && !store.atlasWallets && !store.atlasPendingOps, Object.keys(store));
      const wrongSeed = await importBackup(t, file, 'wrong seed phrase words here');
      check('a wrong seed phrase is refused the same way', !wrongSeed.ok && /Incorrect password or seed phrase/.test(wrongSeed.message));
      const metadata = await importBackup(t, Object.assign({}, file, { exportedAt: '1999-01-01T00:00:00.000Z' }));
      check('the one unauthenticated header field (exportedAt) is not used for any decision: changing it changes nothing', metadata.ok && metadata.result.pendingOps.added === 1);
      const notBackup = await importBackup(t, Object.assign({}, file, { format: 'something-else' }));
      check('a file that is not a full backup is refused', !notBackup.ok && /Not an Atlas full backup file/.test(notBackup.message));
      info('the file is AES-GCM over the whole JSON payload (wallet, journal, identity, every other family): any change is detected. exportedAt/format are outside the ciphertext. A valid older backup always authenticates: there is no freshness or rollback check');
    });

    // ---- B13: automatic backups ----
    await scenario(kind, 'B13 the automatic backup uses the same payload: the journal is in it and restores the same way', async (w, iss, ctx) => {
      const { preds } = await consolidationWithLostAnswer(w, iss);
      const [entry] = await w.pending();
      const blob = await exportAuto(w);
      check('the automatic backup blob is the automatic format and shows nothing in the clear',
        blob.format === 'atlas-auto-backup/1.0' && !JSON.stringify(blob).includes(entry.requestId) && !preds.some((id) => JSON.stringify(blob).includes(id)));
      const payload = openFile(blob, [PASSWORD]);
      check('its payload carries the journal field with the entry', payload.data.pendingOps && payload.data.pendingOps.format === FORMAT && payload.data.pendingOps.entries.length === 1 && payload.data.pendingOps.entries[0].requestId === entry.requestId);
      const t = await ctx.fresh('b13t', w);
      await countRequests(t, '/atlas/');
      const wrong = await t.W(([f]) => AtlasWallet.restoreFromAutoBackupFile(f, 'not-the-password').then(() => 'ok', (e) => e.message), [blob]);
      check('a wrong password is refused', wrong === 'Incorrect password.');
      const bad = Object.assign({}, blob, { ciphertext: Buffer.from(blob.ciphertext, 'base64url').map((b, i) => (i === 40 ? b ^ 1 : b)).toString('base64url') });
      const rb = await importAuto(t, bad);
      check('a tampered automatic backup is refused and writes nothing', !rb.ok && !(await t.W(() => chrome.storage.local.get('atlasPendingOps').then((s) => !!s.atlasPendingOps))));
      const r = await importAuto(t, blob);
      check('restoring it into a fresh profile brings the entry back, nothing sent', r.ok && r.result.pendingOps.added === 1 && (await t.pending()).length === 1 && (await t.pending())[0].requestId === entry.requestId && (await requestCount(t)) === 0, r);
      const rec = await t.recover();
      check('and recovery by the original request id completes', rec.length === 1 && rec[0].status === 'completed' && (await holding(t, IRON, preds)).others.length === 1, rec);
      const oldAuto = sealFile(blob, (() => { const p = openFile(blob, [PASSWORD]); delete p.data.pendingOps; return p; })(), [PASSWORD]);
      const t2 = await ctx.fresh('b13t2', w);
      const r2 = await importAuto(t2, oldAuto);
      check('an automatic backup made before the field existed restores as "absent"', r2.ok && r2.result.pendingOps.status === 'absent' && (await t2.pending()).length === 0, r2);
      info('the automatic writer (backup-setup.html) rebuilds the file on every local storage change, which includes every journal write; writing to the chosen file needs the browser\'s file picker and is not driven here');
    });

    // ---- N1: negative control ----
    await scenario(kind, 'N1 negative control: the previous wallet.js loses the journal in its backups', async (w0, iss, ctx) => {
      const prev = previousExtension();
      if (!prev) { check('the previous wallet.js could be found in git history', false); return; }
      info('previous wallet.js taken from revision ' + prev.rev.slice(0, 9));
      const src = await ctx.fresh('n1src', null, { extPath: prev.dir });
      await src.create();
      const { preds, body } = await consolidationWithLostAnswer(src, iss);
      const [entry] = await src.pending();
      const file = await exportBackup(src);
      const payload = openFile(file, manualSecrets(src));
      check('the previous version\'s backup has no journal field: no entries, no request body, no operation path', !('pendingOps' in payload.data) && !JSON.stringify(payload).includes('/atlas/asset/consolidate'), Object.keys(payload.data));
      const marks = payload.data.wallet.filter((e) => e.pendingOutcome).map((e) => Object.keys(e.pendingOutcome).sort().join(','));
      info('the previous version also wrote the wallet\'s display marks into the backup (' + marks.length + ' marked entries: ' + (marks[0] || 'none') + '); they name the request but hold none of its body, and the restore strips them');
      const lost = await ctx.fresh('n1lost', src, { extPath: prev.dir });
      const r = await importBackup(lost, file);
      check('restoring it with the previous version succeeds', r.ok, r);
      check('the restored profile has no pending operation, and cannot recover (the loss this change fixes)', (await lost.pending()).length === 0 && (await lost.recover()).length === 0);
      const dump = JSON.stringify(await rawAll(lost));
      check('the request id exists nowhere in the restored profile', !dump.includes(entry.requestId));
      const replay = await fetch('http://' + iss.domain + '/atlas/asset/consolidate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const answer = await replay.json().catch(() => null);
      check('the issuer still holds the answer (the same request id returns the 40 g credential), so the loss is only on the wallet side', replay.status === 200 && answer && answer.quantity === 40 && answer.owner && answer.owner.publicKey === src.pub, { status: replay.status });

      // the current wallet restoring that previous-format backup, and doing the same flow with its own backup
      const now = await ctx.fresh('n1now', src);
      const r2 = await importBackup(now, file);
      check('the current wallet restores the previous version\'s backup as "no journal carried"', r2.ok && r2.result.pendingOps.status === 'absent' && (await now.pending()).length === 0, r2);
      const cur = await ctx.fresh('n1cur', null);
      await cur.create();
      const c = await consolidationWithLostAnswer(cur, iss);
      const [e2] = await cur.pending();
      const f2 = await exportBackup(cur);
      const t = await ctx.fresh('n1restored', cur);
      await importBackup(t, f2);
      const rec = await t.recover();
      check('the same situation with the current wallet: the journal comes through and recovery completes',
        !!e2 && rec.some((x) => x.requestId === e2.requestId && x.status === 'completed') && (await holding(t, IRON, c.preds)).others.length === 1, rec);
    });
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
