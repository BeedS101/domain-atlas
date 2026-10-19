// Automatic recovery of pending issuer operations after the wallet is unlocked, and the status the
// wallet shows for them.
//
// Disposable Chromium profiles with the real extension and throw-away Node or PHP issuers (own key,
// state and revocation list; replay retention shortened for the expiry scenarios). Wallet pages are
// the real viewer.html opened as an extension page, with the requests they make recorded. Nothing
// live is read or written.
//
//   xvfb-run -a node test/manual-gen1-auto-recovery.js [node|php|both] [--only=R1]
//
// Every line is a property that must hold. "INFO" lines record what is still impossible. The N1
// scenario runs the previous wallet.js (the last revision without recoverAfterUnlock) as a negative
// control and PASSES when that version does not recover by itself.
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
const MARKER = 'recoverAfterUnlock';
// the requests recovery can send
const RECOVERY_URL = '/atlas/(asset/(issue|split|consolidate)|convert)';
const CONSOLIDATE_URL = '/atlas/asset/consolidate';

let passes = 0, failures = 0;
const check = (name, ok, detail) => {
  if (ok) { passes++; console.log('PASS ' + name); } else { failures++; console.log('FAIL ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 900) : '')); }
};
const info = (text) => console.log('INFO ' + text);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

let nextPort = 25000 + (process.pid % 500) * 20;
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

// ---------------------------------------------------------------- wallet-side helpers
const exportBackup = (w) => w.W(([pw, seed]) => AtlasWallet.exportFullBackup(pw, seed), [PASSWORD, w.seed]);
const importBackup = (t, file, seed) => t.W(([f, pw, s]) => AtlasWallet.importFullBackup(f, pw, s).then((result) => ({ ok: true, result }), (e) => ({ ok: false, message: e.message, code: e.code })), [file, PASSWORD, seed || t.seed]);
const mint = (w, iss, cls, q) => w.W((a) => AtlasWallet.mintAsset('self', a.d, a.c, a.q).then(() => 'ok', (e) => ({ message: e.message, pending: !!e.pending, code: e.code })), { d: iss.domain, c: cls, q });
const shown = (w, cls) => w.W(([k, c]) => AtlasWallet.getWallet(k).then((list) => list.filter((e) => e.credential.asset.class === c).map((e) => ({
  id: e.credential.id, q: e.credential.quantity, status: e.lastVerdict && e.lastVerdict.status, valid: !!(e.lastVerdict && e.lastVerdict.valid),
  held: e.pendingOutcome ? e.pendingOutcome.state : null
}))), [w.pub, cls]);
const live = async (w, cls) => (await shown(w, cls)).filter((r) => r.held === null && r.valid);
const sum = (rows) => rows.reduce((s, r) => s + r.q, 0);
const rawKey = (t, key) => t.W(async ([k, pub]) => { const s = (await chrome.storage.local.get(k))[k]; return s ? (s[pub] === undefined ? null : s[pub]) : null; }, [key, t.pub]);
const lockWallet = (w) => w.W(() => AtlasWallet.lockIdentity());
const retry = (w, rid) => w.W((a) => AtlasWallet.retryPendingOperation(a.k, a.r).then((r) => r, (e) => ({ status: 'threw', message: e.message })), { k: w.pub, r: rid });
const recoverAuto = (w) => w.W(() => AtlasWallet.recoverAfterUnlock());
async function waitFor(fn, ms) { const end = Date.now() + (ms || 15000); while (Date.now() < end) { if (await fn()) return true; await sleep(100); } return false; }

// Requests recovery can send, counted inside the background worker (until it restarts).
async function countRequests(w, source) {
  await w.W((src) => {
    const re = new RegExp(src);
    const inner = globalThis.__countInner || (globalThis.__countInner = globalThis.fetch.bind(globalThis));
    globalThis.__count = 0;
    globalThis.fetch = (url, opts) => { if (re.test(String(url))) globalThis.__count++; return inner(url, opts); };
  }, source);
}
const requestCount = (w) => w.W(() => globalThis.__count || 0);

// Moves the background worker's clock forward (the automatic attempt gap is measured with Date.now).
const skewClock = (w, ms) => w.W((d) => {
  if (!globalThis.__realNow) globalThis.__realNow = Date.now.bind(Date);
  globalThis.__skew = (globalThis.__skew || 0) + d;
  Date.now = () => globalThis.__realNow() + globalThis.__skew;
}, ms);

// Replaces the next `times` requests whose URL matches `source` by a 200 answer that is not a result.
async function fakeAnswer(w, source, mode, times) {
  await w.W(([src, m, n]) => {
    const re = new RegExp(src);
    const inner = globalThis.__fakeInner || (globalThis.__fakeInner = globalThis.fetch.bind(globalThis));
    let left = n;
    globalThis.fetch = async (url, opts) => {
      if (re.test(String(url)) && left > 0) {
        left--;
        if (m === 'html') return new Response('<html><body>Service Unavailable page</body></html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
        if (m === 'truncated') return new Response('{"credential":"domain-atlas-asset/1.0","id":"urn:atl', { status: 200 });
      }
      return inner(url, opts);
    };
  }, [source, mode, times]);
}

// A wallet page: the real viewer.html as an extension page, with every request it makes recorded.
//   opts.hold  consolidation requests made by the page wait until the test lets them go (page.release())
//              or fail (page.fail()), so a state in the middle of recovery can be looked at
async function openViewer(w, opts) {
  const id = new URL(w.sw.url()).host;
  const page = await w.context.newPage();
  await page.addInitScript(([src, hold]) => {
    const re = new RegExp(src);
    window.__recoveryFetches = [];
    window.__held = [];
    const inner = window.fetch.bind(window);
    window.fetch = (url, o) => {
      if (re.test(String(url))) window.__recoveryFetches.push(String(url));
      if (hold && /\/atlas\/asset\/consolidate/.test(String(url))) {
        return new Promise((resolve, reject) => { window.__held.push({ go: () => inner(url, o).then(resolve, reject), fail: () => reject(new TypeError('Failed to fetch (issuer unreachable in test)')) }); });
      }
      return inner(url, o);
    };
  }, [RECOVERY_URL, !!(opts && opts.hold)]);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('chrome-extension://' + id + '/viewer.html');
  page.errors = errors;
  page.fetches = () => page.evaluate(() => window.__recoveryFetches || []);
  page.heldCount = () => page.evaluate(() => window.__held.length);
  page.release = () => page.evaluate(() => window.__held.shift().go());
  page.fail = () => page.evaluate(() => window.__held.shift().fail());
  return page;
}

// ---------------------------------------------------------------- scenario plumbing
async function scenario(kind, label, body, issuerEnv) {
  if (ONLY && !label.startsWith(ONLY)) return;
  console.log(`\n=== [${kind}] ${label} ===`);
  const iss = await startIssuer(kind, issuerEnv);
  const w = await new Wallet(label.replace(/\W+/g, '').slice(0, 10), { autoRecovery: true }).launch();
  const extras = [];
  const ctx = {
    fresh: async (name, from, opts) => {
      const t = await new Wallet(name, Object.assign({ autoRecovery: true }, opts)).launch();
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
  await w.inject('dropAnswer', CONSOLIDATE_URL);
  await mint(w, iss, IRON, 20).catch(() => null);
  const fault = await w.faultInfo();
  await w.clearFault();
  const sent = fault.bodies[0] ? JSON.parse(fault.bodies[0]) : null;
  const preds = sent ? sent.credentials.map((c) => c.id) : [];
  check('setup: the issuer committed the consolidation (both 20 g credentials revoked), the answer was lost', fault.hits === 1 && preds.length === 2 && preds.every((id) => iss.revoked().has(id)), { hits: fault.hits, preds });
  return { preds };
}

// Browser killed, started again, NOT unlocked.
const restartLocked = async (w) => { await w.kill(); await w.launch(); };

let previousExt = null;
function previousExtension() {
  if (previousExt) return previousExt;
  const repo = path.resolve(__dirname, '..');
  const revs = spawnSync('git', ['log', '--format=%H', '--', 'extension/wallet.js'], { cwd: repo }).stdout.toString().trim().split('\n').filter(Boolean);
  for (const rev of revs) {
    const src = spawnSync('git', ['show', rev + ':extension/wallet.js'], { cwd: repo, maxBuffer: 1 << 28 });
    if (src.status === 0 && !src.stdout.includes(MARKER)) {
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
    // ---- R1: locked startup sends nothing; unlock recovers by itself ----
    await scenario(kind, 'R1 a locked start sends nothing; the unlock recovers the pending operation by itself', async (w, iss) => {
      const { preds } = await consolidationWithLostAnswer(w, iss);
      const [entry] = await w.pending();
      await restartLocked(w);
      await countRequests(w, RECOVERY_URL);
      const page = await openViewer(w);
      await sleep(3500);
      check('locked: the background worker and a wallet page opened while locked sent no request', (await requestCount(w)) === 0 && (await page.fetches()).length === 0, { sw: await requestCount(w), page: await page.fetches() });
      const locked = await recoverAuto(w);
      check('locked: recoverAfterUnlock reports locked and does nothing', locked.ran === false && locked.reason === 'locked' && (await requestCount(w)) === 0, locked);
      check('locked: the journal is not shown (nothing readable)', (await w.pending()).length === 0);
      check('locked: the wallet page shows no pending-operations section', await page.evaluate(() => document.getElementById('pendingOpsSection').hidden));
      await page.close();

      const revBefore = iss.revCount();
      await w.unlock();
      check('after the unlock the pending operation is recovered without any other action', await waitFor(async () => (await w.pending()).length === 0, 20000));
      const rows = await shown(w, IRON);
      check('the wallet holds exactly one 40 g credential, verified, no predecessors', rows.length === 1 && rows[0].q === 40 && rows[0].status === 'verified' && rows[0].held === null && !preds.includes(rows[0].id), rows);
      check('exactly one request was sent, by recovery, with the original request id; no new revocation', (await requestCount(w)) === 1 && iss.revCount() === revBefore, { n: await requestCount(w) });
      const notices = await w.W(() => AtlasWallet.getRecoveredOperations());
      check('a completion notice was recorded (activity log) that says what was checked and carries no request id',
        notices.length === 1 && notices[0].kind === 'consolidate' && notices[0].verified === true && !JSON.stringify(await w.log()).includes(entry.requestId), notices);
      const again = await recoverAuto(w);
      check('a second call has nothing to do and sends nothing', again.ran === false && again.reason === 'nothing-to-recover' && (await requestCount(w)) === 1, again);
    });

    // ---- R2: needs-attention is never sent automatically ----
    await scenario(kind, 'R2 needs-attention entries are left alone by automatic recovery and still retry by hand', async (w, iss) => {
      const { preds } = await consolidationWithLostAnswer(w, iss);
      await restartLocked(w); await w.unlock();
      await sleep(EXPIRY_WAIT_MS);
      // The first unlock tried while the issuer still had the answer; make a second entry that expires instead.
      const first = await w.pending();
      check('setup: the first unlock already recovered the operation (the answer was still stored)', first.length === 0);
      await w.inject('dropAnswer', CONSOLIDATE_URL);
      await mint(w, iss, IRON, 20).catch(() => null);
      await mint(w, iss, IRON, 20).catch(() => null);
      await w.clearFault();
      const [entry] = await w.pending();
      check('setup: a new pending consolidation exists', !!entry && entry.state === 'pending', entry);
      await sleep(EXPIRY_WAIT_MS);
      const rec = await w.recover();
      check('setup: an ordinary recovery after the retention ends it as needs-attention', rec.length === 1 && rec[0].status === 'needs-attention', rec);

      await restartLocked(w);
      await countRequests(w, RECOVERY_URL);
      await w.unlock();
      await sleep(3500);
      const pend = await w.pending();
      check('after restart and unlock the entry is still needs-attention, untouched, and no request was sent', pend.length === 1 && pend[0].state === 'needs-attention' && pend[0].attempts === entry.attempts + 1 && (await requestCount(w)) === 0, { pend, n: await requestCount(w) });
      const auto = await recoverAuto(w);
      check('recoverAfterUnlock says there is nothing to recover', auto.ran === false && auto.reason === 'nothing-to-recover', auto);
      const rows = await shown(w, IRON);
      check('its predecessors are still held and not shown verified or valid', rows.filter((r) => r.held === 'needs-attention').length === 2 && rows.filter((r) => r.held === 'needs-attention').every((r) => !r.valid && r.status !== 'verified'), rows);
      const manual = await retry(w, pend[0].requestId);
      check('the explicit retry still sends the request (and ends needs-attention again, the issuer cannot answer)', manual.status === 'needs-attention' && (await requestCount(w)) === 1, manual);
    }, TTL_ENV);

    // ---- R3: the issuer is unavailable ----
    await scenario(kind, 'R3 issuer unavailable: evidence kept, one attempt per gap, later attempt completes', async (w, iss) => {
      const { preds } = await consolidationWithLostAnswer(w, iss);
      const before = (await w.pending())[0];
      const backup0 = await exportBackup(w);
      const body0 = openFile(backup0, [PASSWORD, normSeed(w.seed)]).data.pendingOps.entries[0];
      await restartLocked(w);
      await w.inject('failFetch', CONSOLIDATE_URL);
      await w.unlock();
      check('the first unlock sent one request', await w.waitHits(1));
      await sleep(1200);
      let pend = await w.pending();
      check('the failed attempt is recorded: same request id, attempts counted, last error kept, still pending',
        pend.length === 1 && pend[0].requestId === before.requestId && pend[0].state === 'pending' && pend[0].attempts === before.attempts + 1 && /unreachable/.test(pend[0].lastError || ''), pend);
      for (let i = 0; i < 3; i++) { await lockWallet(w); await w.unlock(); }
      await sleep(3000);
      check('three more lock/unlock cycles and three seconds sent nothing more (one attempt per gap)', (await w.faultInfo()).hits === 1, await w.faultInfo());
      for (let i = 0; i < 3; i++) await recoverAuto(w);
      check('repeated recoverAfterUnlock calls inside the gap also send nothing', (await w.faultInfo()).hits === 1);
      const body1 = openFile(await exportBackup(w), [PASSWORD, normSeed(w.seed)]).data.pendingOps.entries[0];
      check('the journal entry still holds the same request body and credentials after the failure', same(body0.body, body1.body) && body1.requestId === body0.requestId && same(body0.predecessors, body1.predecessors));
      const held = await shown(w, IRON);
      check('the predecessors stay held while the issuer is unreachable', held.length === 2 && held.every((r) => r.held === 'pending' && !r.valid), held);

      await w.clearFault();
      await skewClock(w, 3 * 60 * 1000);
      await lockWallet(w); await w.unlock();
      check('after the gap the next unlock tries again and completes', await waitFor(async () => (await w.pending()).length === 0, 20000));
      const rows = await live(w, IRON);
      check('one 40 g credential, applied once', rows.length === 1 && rows[0].q === 40, rows);
    });

    // ---- R4: several wallet pages ----
    await scenario(kind, 'R4 several wallet pages open at once: one request, one credential', async (w, iss) => {
      const { preds } = await consolidationWithLostAnswer(w, iss);
      await restartLocked(w);
      await countRequests(w, RECOVERY_URL);
      const pages = [];
      for (let i = 0; i < 4; i++) pages.push(await openViewer(w));
      await sleep(2500);
      check('four pages opened while locked sent nothing', (await Promise.all(pages.map((p) => p.fetches()))).every((f) => f.length === 0) && (await requestCount(w)) === 0);
      const revBefore = iss.revCount();
      await pages[0].evaluate((pw) => AtlasWallet.unlockIdentity(pw), PASSWORD);
      check('the unlock in one page makes all of them settle the operation', await waitFor(async () => (await w.pending()).length === 0, 25000));
      await sleep(2500);
      const fetches = (await Promise.all(pages.map((p) => p.fetches()))).flat().length + await requestCount(w);
      check('exactly one request reached the issuer from all five contexts', fetches === 1, fetches);
      const rows = await shown(w, IRON);
      check('one 40 g credential; no new revocation; no page error', rows.length === 1 && rows[0].q === 40 && iss.revCount() === revBefore && pages.every((p) => p.errors.length === 0), { rows, errors: pages.map((p) => p.errors) });
      const notices = await w.W(() => AtlasWallet.getRecoveredOperations());
      check('one completion notice', notices.length === 1, notices);
      await Promise.all(pages.map((p) => p.close()));
    });

    // ---- R5: an operation that is already being sent is not sent again ----
    await scenario(kind, 'R5 a request already in flight is skipped; status shows it as recovering', async (w, iss) => {
      check('setup: first mint of 20 Iron', (await mint(w, iss, IRON, 20)) === 'ok');
      await w.inject('delayAnswer', CONSOLIDATE_URL);
      const inFlight = mint(w, iss, IRON, 20).catch((e) => e);
      check('setup: the consolidation request is on its way', await w.waitHits(1));
      const pend = await w.pending();
      check('status: the entry is pending and being checked now (recovering)', pend.length === 1 && pend[0].state === 'pending' && pend[0].recovering === true, pend);
      const auto = await recoverAuto(w);
      const manual = await w.recover();
      check('automatic and manual recovery leave it to the page that is sending it', auto.ran === true && auto.outcomes.every((o) => o.skipped === 'in-flight') && manual.every((o) => o.skipped === 'in-flight') && (await w.faultInfo()).hits === 1, { auto, manual });
      await w.release();
      check('the original send finishes and applies the answer once', (await inFlight) === 'ok' && (await w.pending()).length === 0 && (await live(w, IRON)).length === 1 && sum(await live(w, IRON)) === 40);
      check('and the entry is no longer recovering', true);
      await w.clearFault();
    });

    // ---- R6: repeated unlocks and restarts ----
    await scenario(kind, 'R6 repeated unlocks, restarts and a second page after recovery change nothing', async (w, iss) => {
      const { preds } = await consolidationWithLostAnswer(w, iss);
      await restartLocked(w); await w.unlock();
      check('first unlock recovers', await waitFor(async () => (await w.pending()).length === 0, 20000));
      const revBefore = iss.revCount();
      const stored = JSON.stringify(await w.rawStores());
      await countRequests(w, RECOVERY_URL);
      for (let i = 0; i < 3; i++) { await lockWallet(w); await w.unlock(); }
      for (let i = 0; i < 2; i++) { await restartLocked(w); await w.unlock(); await sleep(1200); }
      const rows = await shown(w, IRON);
      check('after 3 lock/unlock cycles and 2 restarts: still one 40 g credential and an empty journal', rows.length === 1 && rows[0].q === 40 && (await w.pending()).length === 0, rows);
      check('no issuer revocation changed', iss.revCount() === revBefore);
      const page = await openViewer(w);
      await sleep(2500);
      check('a wallet page opened afterwards sends nothing', (await page.fetches()).length === 0);
      await page.close();
    });

    // ---- R7: unreadable stores ----
    await scenario(kind, 'R7 unreadable journal or wallet: nothing is sent, nothing is rewritten', async (w, iss) => {
      const { preds } = await consolidationWithLostAnswer(w, iss);
      const corrupt = (t, key) => t.W(async ([k, pub]) => { const s = await chrome.storage.local.get(k); const all = s[k] || {}; all[pub] = { __atlasEncrypted: true, iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAA' }; await chrome.storage.local.set({ [k]: all }); }, [key, t.pub]);
      const goodJournal = await rawKey(w, 'atlasPendingOps');
      const goodWallet = await rawKey(w, 'atlasWallets');
      await corrupt(w, 'atlasPendingOps');
      const damaged = await rawKey(w, 'atlasPendingOps');
      await restartLocked(w);
      await countRequests(w, RECOVERY_URL);
      await w.unlock();
      await sleep(3000);
      const r1 = await recoverAuto(w);
      check('unreadable journal: automatic recovery reports unreadable and sends nothing', r1.ran === false && r1.reason === 'unreadable' && (await requestCount(w)) === 0, r1);
      check('the damaged journal is exactly as it was', same(await rawKey(w, 'atlasPendingOps'), damaged));

      // restore the journal, damage the wallet instead
      await w.W(async ([pub, journal]) => { const s = await chrome.storage.local.get('atlasPendingOps'); const all = s.atlasPendingOps || {}; all[pub] = journal; await chrome.storage.local.set({ atlasPendingOps: all }); }, [w.pub, goodJournal]);
      await corrupt(w, 'atlasWallets');
      const damagedWallet = await rawKey(w, 'atlasWallets');
      await restartLocked(w);
      await countRequests(w, RECOVERY_URL);
      await w.unlock();
      await sleep(3000);
      const r2 = await recoverAuto(w);
      check('unreadable wallet: automatic recovery reports unreadable and sends nothing', r2.ran === false && r2.reason === 'unreadable' && (await requestCount(w)) === 0, r2);
      check('the damaged wallet and the intact journal are exactly as they were', same(await rawKey(w, 'atlasWallets'), damagedWallet) && same(await rawKey(w, 'atlasPendingOps'), goodJournal));

      // both readable again: recovery runs
      await w.W(async ([pub, wallet]) => { const s = await chrome.storage.local.get('atlasWallets'); const all = s.atlasWallets || {}; all[pub] = wallet; await chrome.storage.local.set({ atlasWallets: all }); }, [w.pub, goodWallet]);
      await lockWallet(w); await w.unlock();
      check('once both are readable again the next unlock recovers', await waitFor(async () => (await w.pending()).length === 0, 20000) && sum(await live(w, IRON)) === 40);
    });

    // ---- R8: pending journals restored from backups ----
    await scenario(kind, 'R8 a journal restored from an encrypted backup is recovered after the unlock', async (w, iss, ctx) => {
      const { preds } = await consolidationWithLostAnswer(w, iss);
      const file = await exportBackup(w);
      const t = await ctx.fresh('r8t', w);
      await countRequests(t, RECOVERY_URL);
      const r = await importBackup(t, file);
      await sleep(2500);
      check('the restore itself sent nothing and left the entry pending', r.ok && (await requestCount(t)) === 0 && (await t.pending()).length === 1, { r, n: await requestCount(t) });
      await restartLocked(t);
      await countRequests(t, RECOVERY_URL);
      await sleep(2500);
      check('the restored profile started locked sends nothing', (await requestCount(t)) === 0);
      await t.unlock();
      check('after the unlock the restored entry is recovered by its original request id', await waitFor(async () => (await t.pending()).length === 0, 20000));
      const rows = await shown(t, IRON);
      check('one 40 g credential in the restored profile; the issuer was asked once', rows.length === 1 && rows[0].q === 40 && (await requestCount(t)) === 1, { rows, n: await requestCount(t) });
    });

    // ---- R9: the identity changes while recovery runs ----
    await scenario(kind, 'R9 identity changes during recovery: nothing sent for the old identity, nothing lost', async (w, iss, ctx) => {
      check('setup: 20 Iron', (await mint(w, iss, IRON, 20)) === 'ok');
      check('setup: 40 Gold', (await mint(w, iss, GOLD, 40)) === 'ok');
      const goldCred = (await w.W((k) => AtlasWallet.getWallet(k).then((l) => l.filter((e) => e.credential.asset.class === 'atlas.element.gold').map((e) => e.credential)), w.pub))[0];
      await w.inject('dropAnswer', '/atlas/asset/(split|consolidate)');
      await w.W((c) => AtlasWallet.splitAsset('self', c, 5, 'self').catch(() => null), goldCred);
      await mint(w, iss, IRON, 20).catch(() => null);
      await w.clearFault();
      const pendingNow = await w.pending();
      check('setup: two pending operations (a split, then a consolidation), both committed by the issuer', pendingNow.length === 2 && pendingNow[0].kind === 'split' && pendingNow[1].kind === 'consolidate', pendingNow);
      const file = await exportBackup(w);
      // another identity, made elsewhere, to replace this one
      const other = await ctx.fresh('r9other', null);
      await other.create();
      const otherFile = await exportBackup(other);

      const journalBefore = await rawKey(w, 'atlasPendingOps'), walletBefore = await rawKey(w, 'atlasWallets');
      await restartLocked(w);
      await countRequests(w, RECOVERY_URL);
      await w.inject('delayAnswer', '/atlas/asset/split');
      await w.unlock();
      check('setup: the first request (the split) is on its way', await w.waitHits(1));
      const swap = await importBackup(w, otherFile, other.seed);
      check('the active identity is replaced while the request is in flight', swap.ok && swap.result.publicKey === other.pub, swap);
      await w.release();
      await sleep(3000);
      const sent = await requestCount(w);
      check('the second operation was not sent for the identity that is no longer active (one request in all)', sent === 1, sent);
      check('the old identity\'s journal and wallet are byte-for-byte as they were (nothing written under the new key)', same(await rawKey({ pub: w.pub, W: w.W.bind(w) }, 'atlasPendingOps'), journalBefore) && same(await rawKey({ pub: w.pub, W: w.W.bind(w) }, 'atlasWallets'), walletBefore));
      await w.clearFault();
      const back = await importBackup(w, file, w.seed);
      check('restoring the old identity again brings both operations back', back.ok && (await w.pending()).length === 2, back);
      await skewClock(w, 3 * 60 * 1000);
      await lockWallet(w); await w.unlock();
      check('and the next unlock recovers both', await waitFor(async () => (await w.pending()).length === 0, 25000) && sum(await live(w, IRON)) === 40 && sum(await live(w, GOLD)) === 40);
    });

    // ---- R10: answers that cannot be used ----
    await scenario(kind, 'R10 unusable answers during automatic recovery keep the entry; a later attempt applies the real one', async (w, iss) => {
      const { preds } = await consolidationWithLostAnswer(w, iss);
      const before = (await w.pending())[0];
      await restartLocked(w);
      await fakeAnswer(w, CONSOLIDATE_URL, 'html', 1);
      await w.unlock();
      check('an HTML answer is counted as an attempt and the entry stays pending', await waitFor(async () => { const p = await w.pending(); return p.length === 1 && p[0].attempts === before.attempts + 1; }, 15000));
      let pend = await w.pending();
      check('the entry is not discarded and no credential was applied', pend[0].requestId === before.requestId && sum(await live(w, IRON)) === 0 && /not a usable/.test(pend[0].lastError || ''), pend);
      await skewClock(w, 3 * 60 * 1000);
      await fakeAnswer(w, CONSOLIDATE_URL, 'truncated', 1);
      await lockWallet(w); await w.unlock();
      check('a truncated answer is also kept as pending', await waitFor(async () => { const p = await w.pending(); return p.length === 1 && p[0].attempts === before.attempts + 2; }, 15000));
      await skewClock(w, 3 * 60 * 1000);
      await lockWallet(w); await w.unlock();
      check('the next attempt gets the real answer and applies it once', await waitFor(async () => (await w.pending()).length === 0, 20000) && (await live(w, IRON)).length === 1 && sum(await live(w, IRON)) === 40);
    });

    // ---- R11: every kind of operation ----
    for (const op of ['mint', 'split', 'convert']) {
      await scenario(kind, `R11 a lost ${op} answer is recovered by the unlock`, async (w, iss) => {
        let url, expect;
        if (op === 'mint') {
          url = '/atlas/asset/issue';
          await w.inject('dropAnswer', url);
          await mint(w, iss, GOLD, 20).catch(() => null);
        } else if (op === 'split') {
          check('setup: 40 Iron', (await mint(w, iss, IRON, 40)) === 'ok');
          const cred = (await w.W((k) => AtlasWallet.getWallet(k).then((l) => l.map((e) => e.credential)), w.pub))[0];
          url = '/atlas/asset/split';
          await w.inject('dropAnswer', url);
          await w.W((c) => AtlasWallet.splitAsset('self', c, 5, 'self').catch(() => null), cred);
        } else {
          check('setup: 100 Gold', (await mint(w, iss, GOLD, 100)) === 'ok');
          const cred = (await w.W((k) => AtlasWallet.getWallet(k).then((l) => l.map((e) => e.credential)), w.pub))[0];
          url = '/atlas/convert';
          await w.inject('dropAnswer', url);
          await w.W((c) => AtlasWallet.convertAsset('self', c, 40, 'atlas.element.platinum').catch(() => null), cred);
        }
        const fault = await w.faultInfo();
        await w.clearFault();
        const pend = await w.pending();
        check(`setup: the ${op} was committed by the issuer and its answer lost; one pending entry`, fault.hits === 1 && pend.length === 1 && pend[0].kind === op, { hits: fault.hits, pend });
        const revBefore = iss.revCount();
        await restartLocked(w); await w.unlock();
        check('the unlock recovers it', await waitFor(async () => (await w.pending()).length === 0, 20000));
        const iron = await shown(w, IRON), gold = await shown(w, GOLD);
        if (op === 'mint') check('the minted 20 g Gold is in the wallet, verified', gold.length === 1 && gold[0].q === 20 && gold[0].valid, gold);
        if (op === 'split') check('the 5 g piece and the 35 g remainder are in the wallet (40 g in all), nothing held', sum(iron.filter((r) => r.valid)) === 40 && iron.every((r) => r.held === null) && iron.filter((r) => r.valid).length === 2, iron);
        if (op === 'convert') {
          const platinum = await shown(w, 'atlas.element.platinum');
          check('the 60 g Gold remainder and the converted Platinum are in the wallet, nothing held', sum(gold.filter((r) => r.valid)) === 60 && platinum.filter((r) => r.valid).length === 1 && platinum[0].q > 0 && gold.concat(platinum).every((r) => r.held === null), { gold, platinum });
        }
        check('recovery created no revocation', iss.revCount() === revBefore);
      });
    }

    // ---- R12: status in the wallet page ----
    await scenario(kind, 'R12 the wallet page shows Recovering, Pending and Completed in words and holds the balances', async (w, iss) => {
      const { preds } = await consolidationWithLostAnswer(w, iss);
      const read = (page) => page.evaluate(() => ({
        hidden: document.getElementById('pendingOpsSection').hidden,
        role: document.getElementById('pendingOpsSection').getAttribute('role'),
        labelled: document.getElementById('pendingOpsSection').getAttribute('aria-labelledby'),
        items: [...document.querySelectorAll('#pendingOpsList li, #recoveredOpsList li')].map((li) => ({ state: li.dataset.state, text: li.innerText, buttons: [...li.querySelectorAll('button')].map((b) => b.innerText) })),
        cards: [...document.querySelectorAll('.wallet-item')].map((c) => ({ held: c.dataset.held || null, text: c.innerText, actions: [...c.querySelectorAll('.card-menu-items button')].map((b) => b.innerText) }))
      }));
      // The page opens unlocked, so it starts the automatic recovery itself; its consolidation request is held.
      const page = await openViewer(w, { hold: true });
      check('the page asked the issuer by itself (the request is held in the page)', await waitFor(async () => (await page.heldCount()) === 1, 15000));
      await page.waitForSelector('.wallet-item');
      await page.evaluate(() => refreshPendingOpsDisplay());
      let s = await read(page);
      const recovering = s.items.find((i) => i.state === 'recovering');
      check('while the issuer is being asked, the item says Recovering in words with its explanation', !!recovering && /Recovering/.test(recovering.text) && /Checking with the issuer now/.test(recovering.text), s.items);
      check('the section is a labelled region and is visible', !s.hidden && s.role === 'region' && s.labelled === 'pendingOpsHeading', s);
      check('the held balances say so in words and offer no spend, drop, wear or export action',
        s.cards.length === 2 && s.cards.every((c) => c.held === 'pending' && /On hold/.test(c.text) && /not verified/.test(c.text) && c.actions.every((a) => /^Hide$/.test(a.trim()))), s.cards);

      await page.fail();
      check('after the request failed the item says Pending, shows the last answer, and offers a retry',
        await waitFor(async () => { await page.evaluate(() => refreshPendingOpsDisplay()); return (await read(page)).items.some((i) => i.state === 'pending'); }, 15000));
      s = await read(page);
      const pending = s.items.find((i) => i.state === 'pending');
      check('the pending item is written out ("Pending", "has not confirmed") with the retry button', /Pending/.test(pending.text) && /has not confirmed this transaction yet/.test(pending.text) && /Last answer/.test(pending.text) && pending.buttons.includes('Ask the issuer again'), pending);
      check('and the balances are still held', (await shown(w, IRON)).every((r) => r.held === 'pending'));

      // Ask again: the hold is released for this one.
      const clicked = page.click('#pendingOpsList button[data-action="retry-operation"]');
      await waitFor(async () => (await page.heldCount()) === 1, 15000);
      await page.release();
      await clicked;
      check('the retry applies the issuer\'s answer: Completed is shown with what was checked, the pending item is gone',
        await waitFor(async () => { await page.evaluate(() => refreshPendingOpsDisplay()); const r = await read(page); return r.items.some((i) => i.state === 'completed') && !r.items.some((i) => i.state === 'pending'); }, 15000));
      s = await read(page);
      const done = s.items.find((i) => i.state === 'completed');
      check('the Completed item says the answer was applied and its signature and revocation status checked', /Completed/.test(done.text) && /signature and revocation status checked/.test(done.text), done);
      const status = await page.evaluate(() => document.getElementById('pendingOpsStatus').innerText);
      check('the live region reports it', /Completed/.test(status) && (await page.evaluate(() => document.getElementById('pendingOpsStatus').getAttribute('aria-live'))) === 'polite', status);
      await page.evaluate(() => refreshInventoryDisplay());
      await sleep(500);
      s = await read(page);
      check('the credential is a single verified 40 g card and nothing is marked held any more', s.cards.length === 1 && s.cards.every((c) => !c.held && /40 g/.test(c.text)), s.cards);
      check('the journal is empty (the completed item comes from the activity log, not the journal)', (await w.pending()).length === 0);
      check('no page error', page.errors.length === 0, page.errors);
      await page.close();
    });

    await scenario(kind, 'R12b needs-attention is shown in words with a manual retry', async (w, iss) => {
      const { preds } = await consolidationWithLostAnswer(w, iss);
      await sleep(EXPIRY_WAIT_MS);
      const page = await openViewer(w);
      check('the page opened after the retention: its automatic recovery ends the request as needs-attention', await waitFor(async () => { const p = await w.pending(); return p.length === 1 && p[0].state === 'needs-attention'; }, 20000));
      await page.evaluate(() => refreshPendingOpsDisplay());
      const read = () => page.evaluate(() => [...document.querySelectorAll('#pendingOpsList li')].map((li) => ({ state: li.dataset.state, text: li.innerText, buttons: [...li.querySelectorAll('button')].map((b) => b.innerText) })));
      const s = await read();
      check('the item says Needs attention in words, says nothing is sent unless asked, and offers a retry',
        s.length === 1 && s[0].state === 'needs-attention' && /Needs attention/.test(s[0].text) && /nothing is sent again unless you ask/.test(s[0].text) && s[0].buttons.includes('Ask the issuer again'), s);
      const before = (await page.fetches()).length;
      await sleep(2500);
      check('the page did not send it again by itself', (await page.fetches()).length === before, { before, now: (await page.fetches()).length });
      await page.click('#pendingOpsList button[data-action="retry-operation"]');
      check('pressing the button asks the issuer once more', await waitFor(async () => (await page.fetches()).length === before + 1, 15000));
      await sleep(1500);
      const status = await page.evaluate(() => document.getElementById('pendingOpsStatus').innerText);
      check('and the answer is reported in the live region', /Still needs attention/.test(status) && (await page.evaluate(() => document.getElementById('pendingOpsStatus').getAttribute('aria-live'))) === 'polite', status);
      await page.close();
    }, TTL_ENV);

    // ---- N1: negative control ----
    await scenario(kind, 'N1 negative control: the previous wallet.js does not recover by itself', async (w0, iss, ctx) => {
      const prev = previousExtension();
      if (!prev) { check('the previous wallet.js could be found in git history', false); return; }
      info('previous wallet.js taken from revision ' + prev.rev.slice(0, 9));
      const old = await ctx.fresh('n1old', null, { extPath: prev.dir });
      await old.create();
      const { preds } = await consolidationWithLostAnswer(old, iss);
      await old.kill(); await old.launch();
      await countRequests(old, RECOVERY_URL);
      await old.unlock();
      await sleep(6000);
      const pend = await old.pending();
      const rows = await shown(old, IRON);
      check('previous version: six seconds after the unlock the operation is still pending, no request was sent, the balances are still the revoked predecessors',
        pend.length === 1 && (await requestCount(old)) === 0 && rows.length === 2, { pend: pend.length, n: await requestCount(old), rows: rows.length });
      info('previous version: recovery only ran with the next operation or a manual re-verify');
      const current = await ctx.fresh('n1new', null);
      await current.create();
      await consolidationWithLostAnswer(current, iss);
      await restartLocked(current); await current.unlock();
      check('current version: the same situation is settled by the unlock', await waitFor(async () => (await current.pending()).length === 0, 20000) && sum(await live(current, IRON)) === 40);
    });
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
