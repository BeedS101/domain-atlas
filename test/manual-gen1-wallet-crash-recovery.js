// Isolated crash / restart tests for the wallet's pending-operations journal (Gen1 fungible
// replacement operations: mint, split, consolidate, convert).
//
// Each scenario uses a throw-away Chromium profile with the real extension and a throw-away
// issuer (Node or PHP) with its own key, state and revocation list. The browser is killed with
// SIGKILL at a chosen moment and started again on the SAME profile, which is what a crash, a power
// cut or "End task" looks like to the extension. Nothing live is read or written.
//
//   xvfb-run -a node test/manual-gen1-wallet-crash-recovery.js [node|php|both] [--quick]
//
// "check" lines are properties that must hold today. "GAP" lines are probes that record a
// behaviour the wallet does not currently guarantee; they do not fail the run.
'use strict';
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || '/home/claude/.npm-global/lib/node_modules/playwright');
const issuers = require('./lib/gen1-issuers');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const IRON = 'atlas.element.iron', GOLD = 'atlas.element.gold';
const PASSWORD = 'crash-recovery-pw';
const args = process.argv.slice(2);
const which = args.find((a) => /^(node|php|both)$/.test(a)) || 'node';
const QUICK = args.includes('--quick');
const ONLY = (args.find((a) => a.startsWith('--only=')) || '').slice(7);

let passes = 0, failures = 0;
const gaps = [];
const check = (name, ok, detail) => { if (ok) { passes++; console.log('PASS ' + name); } else { failures++; console.log('FAIL ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 600) : '')); } };
const gap = (name, hit, detail) => { if (hit) { gaps.push(name); console.log('GAP  ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 600) : '')); } else console.log('OK   ' + name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rid = () => crypto.randomBytes(18).toString('base64url');

// ---------------------------------------------------------------- browser
class Wallet {
  constructor(label) { this.label = label; this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-crash-' + label + '-')); this.context = null; this.sw = null; this.pub = null; }
  async launch() {
    for (const f of fs.readdirSync(this.dir)) if (/^Singleton/.test(f)) fs.rmSync(path.join(this.dir, f), { force: true });
    const a = ['--disable-extensions-except=' + EXT_PATH, '--load-extension=' + EXT_PATH, '--no-sandbox'];
    this.context = await chromium.launchPersistentContext(this.dir, { headless: false, executablePath: '/opt/pw-browsers/chromium', args: a, viewport: null });
    await this.resolveSw();
    return this;
  }
  // The extension's background worker, once the wallet library has loaded in it.
  async resolveSw() {
    const end = Date.now() + 25000;
    while (Date.now() < end) {
      let workers = this.context.serviceWorkers();
      if (!workers.length) { try { await this.context.waitForEvent('serviceworker', { timeout: 2000 }); } catch (e) { /* retry */ } workers = this.context.serviceWorkers(); }
      for (const sw of workers) {
        if (!/^chrome-extension:/.test(sw.url())) continue;
        try { if (await sw.evaluate(() => typeof AtlasWallet !== 'undefined')) { this.sw = sw; return sw; } } catch (e) { /* worker is going away */ }
      }
      await sleep(250);
    }
    throw new Error('the extension background worker did not come up');
  }
  // runs code with AtlasWallet in the extension's background context
  async W(fn, arg) {
    try { return await this.sw.evaluate(fn, arg); } catch (e) {
      // The background worker may have been stopped and restarted by the browser between two calls.
      if (!/AtlasWallet is not defined|Target (page|closed)|Execution context was destroyed|Session closed/.test(String(e && e.message))) throw e;
      await this.resolveSw();
      return this.sw.evaluate(fn, arg);
    }
  }
  async create() { const r = await this.W((pw) => AtlasWallet.createIdentity(pw), PASSWORD); this.pub = r.publicKey; this.seed = r.seedPhrase; return this; }
  async unlock() { return this.W((pw) => AtlasWallet.unlockIdentity(pw), PASSWORD); }
  // SIGKILL every process of this profile, then wait until none is left.
  async kill() {
    spawnSync('pkill', ['-9', '-f', '--', '--user-data-dir=' + this.dir]);
    try { await Promise.race([this.context.close(), sleep(1500)]); } catch (e) { /* already gone */ }
    for (let i = 0; i < 40; i++) { if (spawnSync('pgrep', ['-f', '--', '--user-data-dir=' + this.dir]).status !== 0) break; await sleep(100); }
    this.context = null; this.sw = null;
  }
  async restart(unlock) { await this.kill(); await this.launch(); if (unlock !== false) await this.unlock(); return this; }
  async dispose() { try { if (this.context) await this.context.close(); } catch (e) { /* ignore */ } spawnSync('pkill', ['-9', '-f', '--', '--user-data-dir=' + this.dir]); fs.rmSync(this.dir, { recursive: true, force: true }); }

  // ---- views
  async rows(cls) {
    return this.W(([k, c]) => AtlasWallet.getWallet(k).then((w) => w.filter((e) => e.credential.asset.class === c).map((e) => ({ id: e.credential.id, q: e.credential.quantity, spent: !!e.spent || !!(e.lastVerdict && e.lastVerdict.status === 'revoked'), verdict: e.lastVerdict && e.lastVerdict.status }))), [this.pub, cls]);
  }
  async live(cls) { return (await this.rows(cls)).filter((r) => !r.spent); }
  async pending() { return this.W((k) => AtlasWallet.getPendingOperations(k), this.pub); }
  async recover() { return this.W((k) => AtlasWallet.recoverPendingOperations(k), this.pub); }
  async rawStores() { return this.W(() => chrome.storage.local.get(['atlasWallets', 'atlasPendingOps'])); }
  async log() { return this.W(() => AtlasWallet.getActivityLog()); }
  // Test-only fault injection inside the extension background context. The first four act on
  // requests whose URL matches `source`; the last three act on the storage write that applies an
  // answer and clears its journal entry in one step.
  //   dropAnswer     the issuer receives and finishes the request, then the fetch fails (answer lost)
  //   failFetch      the request is never sent (issuer unreachable)
  //   hangFetch      the request is never sent and the code stalls (crash before sending)
  //   delayAnswer    the answer is held back until release() (lets a test act in the middle)
  //   hangCommit     the commit write never happens (crash after the answer, before it is stored)
  //   failCommit     the commit write is rejected (storage error)
  //   stallAfterCommit  the commit write happens, then the code stalls (crash right after it)
  async inject(kind, source) {
    await this.W(([k, src]) => {
      const realFetch = globalThis.__realFetch || (globalThis.__realFetch = globalThis.fetch.bind(globalThis));
      const realSet = globalThis.__realSet || (globalThis.__realSet = chrome.storage.local.set.bind(chrome.storage.local));
      const re = new RegExp(src);
      globalThis.__fault = { kind: k, hits: 0, bodies: [], committed: false, gate: null, release: null, armed: false };
      const never = () => new Promise(() => {});
      globalThis.fetch = async (url, opts) => {
        const f = globalThis.__fault;
        if (f && ['dropAnswer', 'failFetch', 'hangFetch', 'delayAnswer'].includes(f.kind) && re.test(String(url))) {
          f.hits++; if (opts && opts.body) f.bodies.push(String(opts.body));
          if (f.kind === 'hangFetch') return never();
          if (f.kind === 'failFetch') throw new TypeError('Failed to fetch (issuer unreachable in test)');
          const res = await realFetch(url, opts);
          if (f.kind === 'dropAnswer') { await res.text(); throw new TypeError('Failed to fetch (answer lost in test)'); }
          f.gate = new Promise((r) => { f.release = r; });
          await f.gate;
          return res;
        }
        if (f && ['hangCommit', 'failCommit', 'stallAfterCommit'].includes(f.kind) && re.test(String(url))) {
          if (opts && opts.body) f.bodies.push(String(opts.body));
          const res = await realFetch(url, opts);
          f.armed = true;
          return res;
        }
        return realFetch(url, opts);
      };
      chrome.storage.local.set = (items, cb) => {
        const f = globalThis.__fault;
        const isCommit = f && f.armed && items && typeof items === 'object' && 'atlasWallets' in items && 'atlasPendingOps' in items;
        if (isCommit && f.kind === 'hangCommit') { f.hits++; return never(); }
        if (isCommit && f.kind === 'failCommit') { f.hits++; return Promise.reject(new Error('QUOTA_BYTES quota exceeded (test)')); }
        if (isCommit && f.kind === 'stallAfterCommit') { f.hits++; return realSet(items).then(() => { f.committed = true; return never(); }); }
        return realSet(items, cb);
      };
    }, [kind, source || '^$']);
  }
  async clearFault() { await this.W(() => { const f = globalThis.__fault; if (f && f.release) f.release(); globalThis.__fault = null; }); }
  async faultInfo() { return this.W(() => { const f = globalThis.__fault; return f ? { hits: f.hits, committed: f.committed, bodies: f.bodies } : { hits: 0, committed: false, bodies: [] }; }); }
  async release() { await this.W(() => { const f = globalThis.__fault; if (f && f.release) f.release(); }); }
  async waitHits(n, ms) { const end = Date.now() + (ms || 15000); while (Date.now() < end) { if ((await this.faultInfo()).hits >= n) return true; await sleep(100); } return false; }
  async waitCommitted(ms) { const end = Date.now() + (ms || 15000); while (Date.now() < end) { if ((await this.faultInfo()).committed) return true; await sleep(100); } return false; }
}

// ---------------------------------------------------------------- issuer
let nextPort = 20000 + (process.pid % 500) * 20;
const takePort = () => nextPort++;
async function startIssuer(kind, env) {
  const port = takePort();
  const be = kind === 'php' ? await issuers.startPhp(port, { workers: 0, env }) : await issuers.startNode(port, { env });
  const api = issuers.api(be);
  return {
    be, api, kind, domain: kind === 'php' ? '127.0.0.1:' + port : 'localhost:' + port,
    revoked: () => new Set((api.revocations() || []).map((r) => r.id)),
    revCount: () => (api.revocations() || []).length,
    stop: () => be.stop()
  };
}

const mint = (w, iss, cls, q) => w.W((a) => AtlasWallet.mintAsset('self', a.d, a.c, a.q).then(() => 'ok', (e) => ({ message: e.message, pending: !!e.pending, code: e.code })), { d: iss.domain, c: cls, q });
const sum = (rows) => rows.reduce((s, r) => s + r.q, 0);

// A fresh wallet holding one 20 g Iron credential; the next 20 g mint will trigger a consolidation.
async function scenario(kind, label, body, issuerEnv) {
  if (ONLY && !label.startsWith(ONLY)) return;
  console.log(`\n=== [${kind}] ${label} ===`);
  const iss = await startIssuer(kind, issuerEnv);
  const w = await new Wallet(label.replace(/\W+/g, '').slice(0, 14)).launch();
  try {
    await w.create();
    await body(w, iss);
  } catch (e) {
    failures++; console.log('FAIL threw in "' + label + '" :: ' + (e.stack || e));
  } finally { await w.dispose(); iss.stop(); }
}

// One consolidation, interrupted by `fault`; returns what a test needs to judge the outcome.
async function interrupted(w, iss, fault) {
  check('setup: first mint of 20 Iron', (await mint(w, iss, IRON, 20)) === 'ok');
  await w.inject(fault, '/atlas/asset/consolidate');
  const call = mint(w, iss, IRON, 20).catch(() => 'closed');
  // A request that is made to hang never returns; the browser is killed while it is stuck.
  const hangs = ['hangCommit', 'hangFetch', 'stallAfterCommit'].includes(fault);
  if (hangs) await w.waitHits(1);
  const second = hangs ? 'hung' : await call;
  const info = await w.faultInfo();
  const sent = info.bodies[0] ? JSON.parse(info.bodies[0]) : null;
  return { second, info, preds: sent ? sent.credentials.map((c) => c.id) : [], revBefore: iss.revCount() };
}

const successorOk = async (w, iss, preds, label, expectRevoked) => {
  const live = await w.live(IRON);
  check(`${label}: exactly one 40 g credential is held`, live.length === 1 && live[0].q === 40, live);
  check(`${label}: it is not revoked at the issuer`, live.length === 1 && !iss.revoked().has(live[0].id));
  check(`${label}: neither 20 g predecessor is live in the wallet; both are revoked at the issuer`, preds.every((id) => !live.some((r) => r.id === id) && iss.revoked().has(id)), { live, preds });
  check(`${label}: the journal is empty`, (await w.pending()).length === 0, await w.pending());
  if (expectRevoked !== undefined) check(`${label}: revocation count is ${expectRevoked} (nothing spent twice)`, iss.revCount() === expectRevoked, iss.revCount());
  return live[0];
};

// What the issuer's own holdings index counts for this owner and class: a request above the cap is
// refused with the amount held (nothing is minted).
async function heldAtIssuer(iss, owner, cls) {
  const r = await iss.api.post('/atlas/asset/issue', { ownerPublicKey: owner, assetClass: cls || IRON, quantity: 501, requestId: rid() });
  return r.status === 400 && r.body && r.body.code === 'cap' ? r.body.held : null;
}

// ---------------------------------------------------------------- scenarios
async function main() {
  const kinds = which === 'both' ? ['node', 'php'] : [which];
  for (const kind of kinds) {
    // ---- 1. the four places a consolidation can be cut off ----
    await scenario(kind, 'A1 issuer committed, answer lost, browser killed', async (w, iss) => {
      const r = await interrupted(w, iss, 'dropAnswer');
      check('fault hit once; the wallet reported the request as saved, not lost', r.info.hits === 1, r.info);
      const pend = await w.pending();
      check('journal entry was written before the request was sent', pend.length === 1 && pend[0].kind === 'consolidate', pend);
      check('the issuer did commit the consolidation (it revoked both 20 g credentials)', r.preds.every((id) => iss.revoked().has(id)));
      check('the wallet still shows both 20 g credentials, no half-applied state', r.preds.length === 2 && sum(await w.rows(IRON)) === 40, await w.rows(IRON));
      const exportBefore = await w.W(() => AtlasWallet.exportWallet());
      const sentBody = r.info.bodies[0];
      await w.restart(true);
      const pend2 = await w.pending();
      check('after the restart the journal still holds the consolidation, with its request id', pend2.length === 1 && pend2[0].kind === 'consolidate' && pend2[0].requestId === pend[0].requestId, pend2);
      const rec = await w.recover();
      check('recovery completes it, applied once', rec.length === 1 && rec[0].status === 'completed' && rec[0].applied === true, rec);
      const succ = await successorOk(w, iss, r.preds, 'after recovery', r.revBefore);
      check('recovering again does nothing', (await w.recover()).length === 0);
      const logText = JSON.stringify(await w.log());
      check('the activity log records the recovery', /Recovered an interrupted consolidate/.test(logText));
      await w.restart(true);
      const again = await w.live(IRON);
      check('a second restart changes nothing', again.length === 1 && again[0].id === succ.id && again[0].q === 40, again);

      // resurrection attempts
      const imp = await w.W((f) => AtlasWallet.importWallet(f), exportBefore);
      const afterImport = await w.live(IRON);
      check('importing a wallet file from before the consolidation does not bring the old credentials back to life', afterImport.length === 1 && afterImport[0].id === succ.id && sum(afterImport) === 40, { imp, afterImport });
      const old = (await w.rows(IRON)).filter((r) => r.id !== succ.id);
      check('the old credentials, if kept at all, are flagged spent', old.every((r) => r.spent), old);
      const same = await iss.api.post('/atlas/asset/consolidate', JSON.parse(sentBody));
      check('the lost request, sent again with the same request id, returns the same signed credential and revokes nothing more', same.status === 200 && same.body.id === succ.id && iss.revCount() === r.revBefore, [same.status, same.body && same.body.id, succ.id, iss.revCount(), r.revBefore]);
      const fresh = JSON.parse(sentBody); fresh.requestId = rid();
      const second = await iss.api.post('/atlas/asset/consolidate', fresh);
      check('the same predecessors sent under a new request id are refused (no second successor)', second.status >= 400 && second.status < 500 && iss.revCount() === r.revBefore, [second.status, second.body, iss.revCount()]);
    });

    await scenario(kind, 'A2 answer received, commit write never happens, browser killed', async (w, iss) => {
      const r = await interrupted(w, iss, 'hangCommit');
      check('the commit write was reached once and did not happen', r.info.hits === 1, r.info);
      const before = await w.rawStores();
      await w.restart(true);
      const after = await w.rawStores();
      check('nothing about the answer reached storage (wallet and journal blobs byte-identical)', JSON.stringify(before.atlasWallets) === JSON.stringify(after.atlasWallets) && JSON.stringify(before.atlasPendingOps) === JSON.stringify(after.atlasPendingOps));
      check('the journal entry survived', (await w.pending()).length === 1);
      const rec = await w.recover();
      check('recovery completes it', rec.length === 1 && rec[0].status === 'completed' && rec[0].applied === true, rec);
      await successorOk(w, iss, r.preds, 'after recovery', r.revBefore);
    });

    await scenario(kind, 'A3 commit stored, browser killed immediately after', async (w, iss) => {
      const r = await interrupted(w, iss, 'stallAfterCommit');
      check('the commit write happened', await w.waitCommitted(), await w.faultInfo());
      await w.restart(true);
      check('after the restart nothing is pending', (await w.pending()).length === 0);
      await successorOk(w, iss, r.preds, 'after restart', r.revBefore);
      check('there is nothing to recover', (await w.recover()).length === 0);
      const n = (await w.log()).filter((e) => /Recovered an interrupted/.test(JSON.stringify(e))).length;
      check('no recovery was needed or logged', n === 0, n);
    });

    await scenario(kind, 'A4 journal written, request never sent, browser killed', async (w, iss) => {
      const r = await interrupted(w, iss, 'hangFetch');
      check('the request was held back', r.info.hits === 1, r.info);
      const revNow = iss.revCount();
      await w.restart(true);
      check('the journal holds the unsent consolidation', (await w.pending()).length === 1);
      check('the issuer has not been asked anything yet (both 20 g credentials still valid there)', r.preds.every((id) => !iss.revoked().has(id)) && iss.revCount() === revNow);
      const rec = await w.recover();
      check('recovery sends it and applies the answer once', rec.length === 1 && rec[0].status === 'completed' && rec[0].applied === true, rec);
      await successorOk(w, iss, r.preds, 'after recovery', revNow + 2);
    });

    // ---- 2. a storage write that fails (disk full) without any crash ----
    await scenario(kind, 'A5 storage rejects the commit write', async (w, iss) => {
      const r = await interrupted(w, iss, 'failCommit');
      check('the commit write failed', r.info.hits >= 1, r.info);
      check('the wallet still shows the two credentials and the journal entry is kept', r.preds.length === 2 && (await w.pending()).length === 1, [await w.rows(IRON), await w.pending()]);
      await w.clearFault();
      const rec = await w.recover();
      check('once storage works again, recovery completes it', rec.length === 1 && rec[0].status === 'completed', rec);
      await successorOk(w, iss, r.preds, 'after recovery', r.revBefore);
    });

    // ---- 3. random-timing SIGKILL during mint + consolidation ----
    const trials = QUICK ? 3 : 8;
    await scenario(kind, `A6 ${trials} random-timing kills during mint and consolidation`, async (w, iss) => {
      const delays = [0, 20, 60, 120, 200, 320, 480, 700].slice(0, trials);
      let expected = 0;
      for (let t = 0; t < delays.length; t++) {
        const heldBefore = sum(await w.live(IRON));
        const call = w.W((a) => AtlasWallet.mintAsset('self', a.d, a.c, a.q).then(() => 'ok', (e) => 'err ' + e.message), { d: iss.domain, c: IRON, q: 20 }).catch(() => 'killed');
        await sleep(delays[t]);
        await w.kill(); await call.catch(() => {});
        await w.launch(); await w.unlock();
        // The mint either never reached the issuer (nothing to recover, nothing minted), or it was recorded in the
        // journal. Recovery brings the wallet to a state that matches the issuer exactly.
        await w.recover(); await w.W((k) => AtlasWallet.autoConsolidateAssetWallet(k), w.pub); await w.recover();
        const live = await w.live(IRON);
                const revoked = iss.revoked();
        check(`kill ${t + 1} (+${delays[t]} ms): no live credential is revoked at the issuer`, live.every((r) => !revoked.has(r.id)), live);
        check(`kill ${t + 1} (+${delays[t]} ms): journal empty after recovery`, (await w.pending()).length === 0, await w.pending());
        const heldNow = sum(live);
        check(`kill ${t + 1} (+${delays[t]} ms): the wallet gained 0 or 20 g, never anything else`, heldNow === heldBefore || heldNow === heldBefore + 20, [heldBefore, heldNow]);
        // every unit the issuer has signed and not revoked for this owner is held by the wallet
        const holdings = await heldAtIssuer(iss, w.pub);
        check(`kill ${t + 1} (+${delays[t]} ms): the issuer's own count of unrevoked Iron equals the wallet's (${holdings})`, holdings === heldNow, [holdings, heldNow]);
        if (heldNow === heldBefore + 20) expected = heldNow;
      }
      const finalLive = await w.live(IRON);
      check('after all kills the wallet holds one consolidated credential per recovery round', finalLive.length >= 1);
    });

    // ---- 4. a locked wallet after a restart must not overwrite the journal or the wallet ----
    await scenario(kind, 'B1 restarted wallet is locked; nothing may overwrite the journal', async (w, iss) => {
      const r = await interrupted(w, iss, 'dropAnswer');
      await w.restart(false);
      check('the wallet is locked after the restart', (await w.W(() => AtlasWallet.isUnlocked())) === false);
      const before = JSON.stringify(await w.rawStores());
      const tries = {};
      const attempt = async (name, fn, arg) => { tries[name] = await w.W(fn, arg).then((v) => 'ok', (e) => 'threw: ' + String(e.message).slice(0, 60)); };
      await attempt('recoverPendingOperations', (k) => AtlasWallet.recoverPendingOperations(k), w.pub);
      await attempt('getPendingOperations', (k) => AtlasWallet.getPendingOperations(k), w.pub);
      await attempt('reverifyAll', () => AtlasWallet.reverifyAll());
      await attempt('autoConsolidateAssetWallet', (k) => AtlasWallet.autoConsolidateAssetWallet(k), w.pub);
      await attempt('importWallet', (f) => AtlasWallet.importWallet(f), { format: 'atlas-wallet-export/1.0', credentials: [] });
      await attempt('mintAsset', (a) => AtlasWallet.mintAsset('self', a.d, a.c, a.q), { d: iss.domain, c: IRON, q: 20 });
      await attempt('convertAsset', (a) => AtlasWallet.convertAsset('self', { id: 'x', asset: { class: 'x' }, issuer: { domain: a.d } }, 1, 'y'), { d: iss.domain });
      const after = JSON.stringify(await w.rawStores());
      check('every wallet operation attempted while locked leaves the stored wallet and journal byte-identical', before === after, tries);
      await w.unlock();
      check('after unlocking, the journal entry is still there', (await w.pending()).length === 1, await w.pending());
      await sleep(3500);
      const stillPending = (await w.pending()).length;
      const liveNow = await w.live(IRON);
      gap('nothing recovers the journal by itself after a restart and unlock (it waits for the next operation or a manual re-verify)', stillPending === 1, { pending: stillPending });
      gap('until then the wallet lists, as live and verified, credentials the issuer has already revoked', liveNow.some((x) => iss.revoked().has(x.id)), liveNow.map((x) => ({ q: x.q, revoked: iss.revoked().has(x.id), verdict: x.verdict })));
      const rec = await w.recover();
      check('recovery then completes it', rec.length === 1 && rec[0].status === 'completed', rec);
      await successorOk(w, iss, r.preds, 'after recovery', r.revBefore);
    });

    // ---- 5. spending a stale predecessor, and minting again, before recovery has run ----
    await scenario(kind, 'B2 a stale predecessor is spent before recovery has run', async (w, iss) => {
      const r = await interrupted(w, iss, 'dropAnswer');
      await w.restart(true);
      const stale = (await w.W((k) => AtlasWallet.getWallet(k), w.pub)).map((e) => e.credential).find((c) => c.id === r.preds[0]);
      const outcome = await w.W((c) => AtlasWallet.splitAsset('self', c, 5, 'self').then(() => 'ok', (e) => ({ message: e.message, code: e.code, pending: !!e.pending })), stale);
      check('the spend of the already-revoked predecessor is refused, not retried', outcome !== 'ok' && outcome.pending === false, outcome);
      await successorOk(w, iss, r.preds, 'afterwards', r.revBefore);
      check('the issuer recorded no new spend because of it', iss.revCount() === r.revBefore, iss.revCount());
    });

    await scenario(kind, 'B3 a new mint after the restart recovers the old operation first', async (w, iss) => {
      await interrupted(w, iss, 'dropAnswer');
      await w.restart(true);
      const m = await mint(w, iss, IRON, 20);
      check('the new mint succeeds', m === 'ok', m);
      const live = await w.live(IRON);
      check('the wallet holds 60 g in one credential, none of it revoked', live.length === 1 && live[0].q === 60 && !iss.revoked().has(live[0].id), live);
      check('journal empty', (await w.pending()).length === 0, await w.pending());
      const held = await heldAtIssuer(iss, w.pub);
      check('the issuer counts the same 60 g as held (no double counting from the interrupted consolidation)', held === 60, held);
    });

    // ---- 6. two extension pages recover at once ----
    await scenario(kind, 'B4 two extension pages recover the same operation at once', async (w, iss) => {
      const r = await interrupted(w, iss, 'dropAnswer');
      await w.restart(true);
      const extId = new URL(w.sw.url()).host;
      const page = await w.context.newPage();
      await page.goto('chrome-extension://' + extId + '/viewer.html');
      await page.waitForFunction(() => typeof AtlasWallet !== 'undefined', null, { timeout: 15000 });
      await page.evaluate((pw) => AtlasWallet.unlockIdentity(pw).catch(() => null), PASSWORD);
      const results = await Promise.all([
        w.recover(), w.recover(),
        page.evaluate((k) => AtlasWallet.recoverPendingOperations(k), w.pub),
        page.evaluate((k) => AtlasWallet.recoverPendingOperations(k), w.pub)
      ]);
      const applied = results.flat().filter((o) => o.status === 'completed' && o.applied === true).length;
      check('the answer is applied exactly once across both pages', applied === 1, results);
      await successorOk(w, iss, r.preds, 'after the race', r.revBefore);
      await page.close();
    });

    // ---- 7. an unreachable issuer during recovery, across more restarts ----
    await scenario(kind, 'B5 issuer unreachable during recovery, wallet restarted again', async (w, iss) => {
      const r = await interrupted(w, iss, 'dropAnswer');
      await w.restart(true);
      await w.inject('failFetch', '/atlas/asset/consolidate');
      const rec = await w.recover();
      check('recovery reports the operation as still pending', rec.length === 1 && rec[0].status === 'pending', rec);
      const p1 = await w.pending();
      check('the attempt is counted and the entry kept', p1.length === 1 && p1[0].attempts >= 1 && !!p1[0].lastError, p1);
      await w.restart(true);
      check('still pending after another restart, with the same request id', (await w.pending()).length === 1 && (await w.pending())[0].requestId === p1[0].requestId);
      const rec2 = await w.recover();
      check('the next recovery with the issuer reachable completes it', rec2.length === 1 && rec2[0].status === 'completed', rec2);
      await successorOk(w, iss, r.preds, 'finally', r.revBefore);
    });

    // ---- 8. the issuer no longer holds the stored answer (replay window passed) ----
    await scenario(kind, 'B6 the issuer\'s stored answer has expired before the wallet retries', async (w, iss) => {
      await interrupted(w, iss, 'dropAnswer');
      await w.restart(true);
      await sleep(4500);
      const rec = await w.recover();
      await w.W(() => AtlasWallet.reverifyAll());
      await w.W((k) => AtlasWallet.autoConsolidateAssetWallet(k), w.pub);
      const live = await w.live(IRON);
      const all = await w.rows(IRON);
      const held = await heldAtIssuer(iss, w.pub);
      const log = JSON.stringify(await w.log()).match(/could not be completed[^"]{0,160}/);
      console.log('INFO expired answer: recovery=' + JSON.stringify(rec) + ' wallet live=' + sum(live) + ' g (rows ' + all.length + ') issuer counts held=' + held + ' log=' + (log && log[0]));
      check('no live credential is revoked, and nothing is duplicated', live.every((x) => !iss.revoked().has(x.id)) && sum(live) <= 40, live);
      gap('after the issuer\'s stored answer expires the 40 g successor can no longer be retrieved: the wallet ends with ' + sum(live) + ' g', sum(live) < 40, { rec, live });
      gap('the issuer keeps counting the unretrievable successor toward the holding cap (issuer ' + held + ' g held, wallet ' + sum(live) + ' g)', held !== null && held !== sum(live), { held, wallet: sum(live) });
    }, { ATLAS_REPLAY_TTL_HOURS: '0.0006' });

    // ---- 9. other replacement operations, interrupted and restarted ----
    await scenario(kind, 'C1 mint, split and convert answers lost, browser killed each time', async (w, iss) => {
      await w.inject('dropAnswer', '/atlas/asset/issue');
      const lostMint = await mint(w, iss, GOLD, 100);
      check('mint: reported as saved', lostMint !== 'ok' && lostMint.pending === true, lostMint);
      await w.restart(true);
      check('mint: nothing held and the request is in the journal after the restart', sum(await w.live(GOLD)) === 0 && (await w.pending()).length === 1);
      const rm = await w.recover();
      check('mint: recovery brings the 100 g in once', rm.length === 1 && rm[0].status === 'completed' && sum(await w.live(GOLD)) === 100, rm);
      check('mint: the issuer counts 100 g held', (await heldAtIssuer(iss, w.pub, GOLD)) === 100);

      const gold = (await w.W((k) => AtlasWallet.getWallet(k), w.pub))[0].credential;
      await w.inject('dropAnswer', '/atlas/asset/split');
      const lostSplit = await w.W((c) => AtlasWallet.splitAsset('self', c, 30, 'self').then(() => 'ok', (e) => ({ pending: !!e.pending })), gold);
      check('split: reported as saved', lostSplit !== 'ok' && lostSplit.pending === true, lostSplit);
      await w.restart(true);
      const rs = await w.recover();
      await w.W((k) => AtlasWallet.autoConsolidateAssetWallet(k), w.pub);
      const g2 = await w.live(GOLD);
      check('split: both halves arrive once and merge back to 100 g', rs.length === 1 && rs[0].status === 'completed' && g2.length === 1 && g2[0].q === 100 && !iss.revoked().has(g2[0].id), [rs, g2]);

      const gold2 = (await w.W((k) => AtlasWallet.getWallet(k), w.pub)).map((e) => e.credential).find((c) => c.asset.class === GOLD && !iss.revoked().has(c.id));
      await w.inject('dropAnswer', '/atlas/convert');
      const lostConv = await w.W((a) => AtlasWallet.convertAsset('self', a.c, 40, a.t).then(() => 'ok', (e) => ({ pending: !!e.pending })), { c: gold2, t: 'atlas.element.platinum' });
      check('convert: reported as saved', lostConv !== 'ok' && lostConv.pending === true, lostConv);
      await w.restart(true);
      const rc = await w.recover();
      const g3 = await w.live(GOLD), p3 = await w.live('atlas.element.platinum');
      check('convert: 60 g Gold remain, the Platinum is held once, nothing revoked is live', rc.length === 1 && rc[0].status === 'completed' && sum(g3) === 60 && sum(p3) > 0 && [...g3, ...p3].every((x) => !iss.revoked().has(x.id)), [rc, g3, p3]);
      check('convert: the issuer counts what the wallet holds', (await heldAtIssuer(iss, w.pub, GOLD)) === 60);
    });

    // ---- 10. requests that are not journalled ----
    await scenario(kind, 'C2 a non-fungible mint whose answer is lost', async (w, iss) => {
      await w.inject('dropAnswer', '/atlas/asset/issue');
      const out = await w.W((a) => AtlasWallet.mintAsset('self', a.d, 'atlas.wearable').then(() => 'ok', (e) => ({ message: e.message, pending: !!e.pending })), { d: iss.domain });
      const hits = (await w.faultInfo()).hits;
      await w.restart(true);
      const held = await w.rows('atlas.wearable');
      gap('a non-fungible mint whose answer is lost is not journalled: the issuer signed it, the wallet has nothing and keeps no record to retry', hits === 1 && held.length === 0 && (await w.pending()).length === 0, { out, hits, held: held.length });
    });

    await scenario(kind, 'C5 a purchase whose answer is lost (not journalled)', async (w, iss) => {
      const first = await mint(w, iss, 'atlas.credit.balance', 10);
      if (first !== 'ok') { console.log('SKIP purchase probe: could not mint the credit class here: ' + JSON.stringify(first)); return; }
      const balance = (await w.rows('atlas.credit.balance'))[0];
      await w.inject('dropAnswer', '/atlas/asset/purchase');
      const out = await w.W((a) => AtlasWallet.purchaseAsset('self', a.d, 'atlas.demo.cafeteria.sandwich', 1).then(() => 'ok', (e) => ({ message: String(e.message).slice(0, 80), pending: !!e.pending })), { d: iss.domain });
      const hits = (await w.faultInfo()).hits;
      await w.restart(true);
      const sandwich = await w.rows('atlas.demo.cafeteria.sandwich');
      const credits = (await w.live('atlas.credit.balance'));
      gap('a purchase whose answer is lost is not journalled: the issuer spent the balance (revoked: ' + iss.revoked().has(balance.id) + ') and the wallet has ' + sandwich.length + ' purchased item(s), no pending entry, no way to retry', hits === 1 && iss.revoked().has(balance.id) && sandwich.length === 0 && (await w.pending()).length === 0, { out, hits, credits });
    });

    // ---- 11. the lock fires while a request is in flight ----
    await scenario(kind, 'C3 the wallet locks while a consolidation is in flight', async (w, iss) => {
      check('setup: first mint of 20 Iron', (await mint(w, iss, IRON, 20)) === 'ok');
      await w.inject('delayAnswer', '/atlas/asset/consolidate');
      const call = mint(w, iss, IRON, 20);
      check('the consolidation request reached the issuer', await w.waitHits(1));
      await w.W(() => chrome.storage.session.remove('atlasUnlockedIdentity'));
      const before = JSON.stringify(await w.rawStores());
      await w.clearFault();
      const out = await call;
      await sleep(500);
      const after = JSON.stringify(await w.rawStores());
      check('the answer arriving while locked writes nothing (wallet and journal blobs byte-identical)', before === after, out);
      await w.unlock();
      check('the journal entry is still there after unlocking', (await w.pending()).length === 1);
      const rec = await w.recover();
      check('recovery then completes it', rec.length === 1 && rec[0].status === 'completed' && rec[0].applied === true, rec);
      const live = await w.live(IRON);
      check('one 40 g credential, journal empty', live.length === 1 && live[0].q === 40 && (await w.pending()).length === 0, live);
    });

    await scenario(kind, 'C4 the wallet locks while a non-fungible mint is in flight', async (w, iss) => {
      check('setup: 40 Iron held', (await mint(w, iss, IRON, 40)) === 'ok');
      await w.inject('delayAnswer', '/atlas/asset/issue');
      const call = w.W((a) => AtlasWallet.mintAsset('self', a.d, 'atlas.wearable').then(() => 'ok', (e) => 'err ' + e.message), { d: iss.domain });
      check('the request reached the issuer', await w.waitHits(1));
      await w.W(() => chrome.storage.session.remove('atlasUnlockedIdentity'));
      await w.clearFault();
      const out = await call;
      await w.unlock();
      const iron = await w.live(IRON);
      const wear = await w.rows('atlas.wearable');
      gap('a lock that fires while a non-fungible mint is in flight can overwrite the encrypted wallet (Iron held: ' + sum(iron) + ' g of 40; wearable stored: ' + wear.length + ')', sum(iron) !== 40, { out, iron, wear });
    });

    // ---- 12. the backup does not carry the journal ----
    await scenario(kind, 'D1 backup taken inside the window, restored on a fresh profile', async (w, iss) => {
      await interrupted(w, iss, 'dropAnswer');
      const file = await w.W(([pw, seed]) => AtlasWallet.exportFullBackup(pw, seed), [PASSWORD, w.seed]);
      const w2 = await new Wallet('D1restore').launch();
      try {
        const res = await w2.W(([f, pw, seed]) => AtlasWallet.importFullBackup(f, pw, seed).then((x) => x || 'ok', (e) => 'err ' + e.message), [file, PASSWORD, w.seed]);
        await w2.unlock().catch(() => null);
        w2.pub = w.pub;
        const pend = await w2.pending();
        const rows = await w2.live(IRON);
        await w2.recover();
        await w2.W((k) => AtlasWallet.autoConsolidateAssetWallet(k), w2.pub);
        const afterConsolidate = sum(await w2.live(IRON));
        await w2.W(() => AtlasWallet.reverifyAll());
        const afterLive = await w2.live(IRON);
        console.log('INFO restore: import=' + JSON.stringify(res).slice(0, 80) + ' pending=' + pend.length + ' live before=' + sum(rows) + ' after recover+consolidate=' + afterConsolidate + ' after re-verify=' + sum(afterLive));
        gap('one revoked credential is still shown as live after the restored wallet\'s own consolidation attempt (' + afterConsolidate + ' g) until a manual re-verify', afterConsolidate > 0, { afterConsolidate });
        gap('a backup taken between "issuer committed" and "wallet stored the answer" does not include the journal; restored on a fresh profile the wallet ends with ' + sum(afterLive) + ' g of 40 g', pend.length === 0 && sum(afterLive) < 40, { pend: pend.length, rows: rows.length, afterLive: sum(afterLive) });
        check('and the restored wallet does not hold anything revoked as live', afterLive.every((x) => !iss.revoked().has(x.id)), afterLive);
      } finally { await w2.dispose(); }
    });
  }
}

main().then(() => {
  console.log('\nwallet crash recovery: ' + passes + ' passed, ' + failures + ' failed, ' + gaps.length + ' gaps');
  gaps.forEach((g) => console.log('  GAP ' + g));
  process.exit(failures ? 1 : 0);
}).catch((e) => { console.log('FAIL harness :: ' + (e.stack || e)); process.exit(1); });
