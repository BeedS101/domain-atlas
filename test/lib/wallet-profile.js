// Disposable Chromium profile with the real extension loaded, shared by the wallet crash and storage
// tests. A profile can be killed with SIGKILL and started again on the same directory, and test-only
// faults can be injected inside the extension's background worker. Nothing here touches a live wallet.
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || '/home/claude/.npm-global/lib/node_modules/playwright');

const EXT_PATH = path.resolve(__dirname, '..', '..', 'extension');
const PASSWORD = 'crash-recovery-pw';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- browser
class Wallet {
  constructor(label, opts) { this.label = label; this.extPath = (opts && opts.extPath) || EXT_PATH; this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-crash-' + label + '-')); this.context = null; this.sw = null; this.pub = null; }
  async launch() {
    for (const f of fs.readdirSync(this.dir)) if (/^Singleton/.test(f)) fs.rmSync(path.join(this.dir, f), { force: true });
    const a = ['--disable-extensions-except=' + this.extPath, '--load-extension=' + this.extPath, '--no-sandbox'];
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
  //   stallAfterCommit  the commit write happens, then the code stalls
  //   lockOnWalletRead  the wallet locks right after the n-th read of the stored wallet (source = n) (crash right after it)
  async inject(kind, source) {
    await this.W(([k, src]) => {
      const realFetch = globalThis.__realFetch || (globalThis.__realFetch = globalThis.fetch.bind(globalThis));
      const realSet = globalThis.__realSet || (globalThis.__realSet = chrome.storage.local.set.bind(chrome.storage.local));
      const re = new RegExp(src);
      globalThis.__fault = { kind: k, hits: 0, bodies: [], committed: false, gate: null, release: null, releases: [], armed: false, reads: 0, fired: false };
      const never = () => new Promise(() => {});
      globalThis.fetch = async (url, opts) => {
        const f = globalThis.__fault;
        if (f && ['dropAnswer', 'failFetch', 'hangFetch', 'delayAnswer'].includes(f.kind) && re.test(String(url))) {
          f.hits++; if (opts && opts.body) f.bodies.push(String(opts.body));
          if (f.kind === 'hangFetch') return never();
          if (f.kind === 'failFetch') throw new TypeError('Failed to fetch (issuer unreachable in test)');
          const res = await realFetch(url, opts);
          if (f.kind === 'dropAnswer') { await res.text(); throw new TypeError('Failed to fetch (answer lost in test)'); }
          await new Promise((r) => { f.releases.push(r); });
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
      // lockOnWalletRead: the wallet locks right after the n-th read of the stored wallet (n = source).
      const realGet = globalThis.__realGet || (globalThis.__realGet = chrome.storage.local.get.bind(chrome.storage.local));
      chrome.storage.local.get = (keys, cb) => realGet(keys).then(async (v) => {
        const f = globalThis.__fault;
        const wants = typeof keys === 'string' ? keys === 'atlasWallets' : Array.isArray(keys) && keys.includes('atlasWallets');
        if (f && f.kind === 'lockOnWalletRead' && wants && !f.fired && ++f.reads >= Number(src)) {
          f.fired = true; f.hits++;
          await chrome.storage.session.remove('atlasUnlockedIdentity');
        }
        return cb ? cb(v) : v;
      });
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
  async clearFault() { await this.W(() => { const f = globalThis.__fault; if (f) f.releases.forEach((r) => r()); globalThis.__fault = null; }); }
  async faultInfo() { return this.W(() => { const f = globalThis.__fault; return f ? { hits: f.hits, committed: f.committed, bodies: f.bodies } : { hits: 0, committed: false, bodies: [] }; }); }
  async release() { await this.W(() => { const f = globalThis.__fault; if (f) f.releases.forEach((r) => r()); }); }
  async waitHits(n, ms) { const end = Date.now() + (ms || 15000); while (Date.now() < end) { if ((await this.faultInfo()).hits >= n) return true; await sleep(100); } return false; }
  async waitCommitted(ms) { const end = Date.now() + (ms || 15000); while (Date.now() < end) { if ((await this.faultInfo()).committed) return true; await sleep(100); } return false; }
}

module.exports = { Wallet, PASSWORD, EXT_PATH, sleep };
