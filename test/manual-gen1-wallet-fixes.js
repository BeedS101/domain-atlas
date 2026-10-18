// Real-extension regression tests for the Gen1 fungible wallet fixes: overlapping operations lose no
// value, consolidation runs in bounded batches and copes with a spent predecessor, failures are
// reported, and an operation whose answer was lost is completed from the pending journal.
//
// The wallet talks to an isolated Node issuer through a small proxy that can swallow answers or
// refuse connections. The issuer's domain IS the proxy's address, so every request goes through it.
//
// Run: xvfb-run -a node test/manual-gen1-wallet-fixes.js
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const L = require('./call-e2e-lib');

const REPO = path.resolve(__dirname, '..');
const ISSUER_PORT = 8341, PROXY_PORT = 8342;
const DOMAIN = 'localhost:' + PROXY_PORT;
const GOLD = 'atlas.element.gold', PLAT = 'atlas.element.platinum', IRON = 'atlas.element.iron';
let passes = 0, failures = 0;
const check = (name, ok, detail) => { if (ok) { passes++; console.log('PASS ' + name); } else { failures++; console.log('FAIL ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rid = () => crypto.randomBytes(18).toString('base64url');

async function startIssuer() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gen1-wf-'));
  const docroot = path.join(tmp, 'docroot'), state = path.join(tmp, 'state');
  fs.mkdirSync(path.join(docroot, '.well-known'), { recursive: true }); fs.mkdirSync(state);
  const proc = spawn('node', ['issuer-server/server.js'], { cwd: REPO, env: { ...process.env, PORT: String(ISSUER_PORT), ATLAS_DOMAIN: DOMAIN, ATLAS_DOCROOT: docroot, ATLAS_STATE_DIR: state }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; proc.stdout.on('data', (d) => { log += d; }); proc.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 300 && !log.includes('listening'); i++) await sleep(50);
  if (!log.includes('listening')) throw new Error('issuer did not start: ' + log.slice(-300));
  const revFile = path.join(docroot, '.well-known', 'atlas-revocations.json');
  return {
    revoked: () => new Set(JSON.parse(fs.readFileSync(revFile, 'utf8')).revoked.map((r) => r.id)),
    revokedList: () => JSON.parse(fs.readFileSync(revFile, 'utf8')).revoked,
    stop: () => { proc.kill(); fs.rmSync(tmp, { recursive: true, force: true }); }
  };
}

// Forwards to the issuer. `mode`: 'pass'; 'swallow' (forward, then drop the connection before the
// answer reaches the wallet, for paths matching `match`, `times` times); 'refuse' (never reaches the
// issuer, for paths matching `match`).
function startProxy() {
  const state = { mode: 'pass', match: /^$/, times: 0, swallowed: [] };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const hit = state.match.test(req.url);
      if (state.mode === 'refuse' && hit) { req.socket.destroy(); return; }
      let r;
      try {
        r = await fetch('http://localhost:' + ISSUER_PORT + req.url, { method: req.method, headers: { 'Content-Type': req.headers['content-type'] || 'application/json' }, body: req.method === 'GET' ? undefined : Buffer.concat(chunks) });
      } catch (e) { res.statusCode = 502; res.end('proxy: ' + e.message); return; }
      const body = Buffer.from(await r.arrayBuffer());
      if (state.mode === 'swallow' && hit && state.times > 0) {
        state.times--; state.swallowed.push(req.url);
        req.socket.destroy();
        return;
      }
      res.statusCode = r.status;
      for (const h of ['content-type', 'cache-control']) if (r.headers.get(h)) res.setHeader(h, r.headers.get(h));
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.end(body);
    });
  });
  return new Promise((resolve) => server.listen(PROXY_PORT, '127.0.0.1', () => resolve({ state, stop: () => server.close() })));
}

async function issue(owner, cls, qty) {
  const r = await fetch('http://localhost:' + ISSUER_PORT + '/atlas/asset/issue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ownerPublicKey: owner, assetClass: cls, quantity: qty, requestId: rid() }) });
  if (!r.ok) throw new Error('issue ' + r.status + ' ' + await r.text());
  return r.json();
}
async function post(p, body) {
  const r = await fetch('http://localhost:' + ISSUER_PORT + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

const view = (W, pub, cls) => W(([k, c]) => AtlasWallet.getWallet(k).then((w) => w.filter((e) => e.credential.asset.class === c).map((e) => ({ id: e.credential.id, q: e.credential.quantity, spent: !!e.spent || (e.lastVerdict && e.lastVerdict.status === 'revoked') }))), [pub, cls]);
const audit = async (iss, W, pub, cls) => {
  const rev = iss.revoked();
  const list = await view(W, pub, cls);
  const live = list.filter((e) => !e.spent);
  return { stacks: live.length, held: live.reduce((s, e) => s + e.q, 0), revokedHeld: live.filter((e) => rev.has(e.id)).length, spentKept: list.length - live.length };
};
const newWallet = async (label) => {
  const w = await L.launchWallet(label);
  const pub = (await w.wallet((pw) => AtlasWallet.createIdentity(pw), 'gen1-wallet-fixes-pw')).publicKey;
  return { w, W: w.wallet, pub, close: () => w.close() };
};
const exportFile = (creds) => ({ format: 'atlas-wallet-export/1.0', credentials: creds });

(async () => {
  const iss = await startIssuer();
  const proxy = await startProxy();
  const opened = [];
  try {
    // ---- three wallets mining and converting at once, each with overlapping operations ----
    const trio = [];
    for (const l of ['A', 'B', 'C']) { const x = await newWallet('wf' + l); opened.push(x); trio.push(x); }
    const plan = async (x) => {
      const mint = (q, c) => x.W((a) => AtlasWallet.mintAsset('self', a.d, a.c, a.q).then(() => 'ok', (e) => 'ERR ' + e.message), { d: DOMAIN, c: c || GOLD, q });
      let mints = 0, converted = 0;
      for (let round = 0; round < 4; round++) {
        const rs = await Promise.all([mint(10), mint(10), mint(10), mint(10, IRON)]);
        mints += rs.slice(0, 3).filter((r) => r === 'ok').length;
        if (round === 1) {
          const stack = (await x.W((k) => AtlasWallet.getWallet(k), x.pub)).map((e) => e.credential).filter((c) => c.asset.class === GOLD).sort((a, b) => b.quantity - a.quantity)[0];
          const rs2 = await Promise.all([mint(10), x.W((a) => AtlasWallet.convertAsset('self', a.c, 20, a.t).then(() => 'ok', (e) => 'ERR ' + e.message), { c: stack, t: PLAT }), mint(10)]);
          mints += rs2.filter((r, i) => i !== 1 && r === 'ok').length;
          if (rs2[1] === 'ok') converted = 20;
          check(`mixed round ok in ${x.pub.slice(0, 6)}`, rs2.every((r) => r === 'ok'), rs2);
        }
      }
      return { mints, converted };
    };
    const outcomes = await Promise.all(trio.map(plan));
    for (let i = 0; i < trio.length; i++) {
      const x = trio[i], o = outcomes[i];
      const a = await audit(iss, x.W, x.pub, GOLD);
      const p = await audit(iss, x.W, x.pub, PLAT);
      check(`3W wallet ${'ABC'[i]}: no Gold lost (${o.mints * 10 - o.converted} expected)`, a.held === o.mints * 10 - o.converted, a);
      check(`3W wallet ${'ABC'[i]}: no revoked stack held, one Gold stack`, a.revokedHeld === 0 && a.stacks === 1, a);
      check(`3W wallet ${'ABC'[i]}: Platinum from conversion is held (${o.converted * 1})`, p.held > 0 && p.revokedHeld === 0, p);
      const pending = await x.W((k) => AtlasWallet.getPendingOperations(k), x.pub);
      check(`3W wallet ${'ABC'[i]}: nothing left pending`, pending.length === 0, pending);
    }

    // ---- bounded batches: 45 separate balances become one ----
    const bw = await newWallet('wfbatch'); opened.push(bw);
    const stacks = [];
    for (let i = 0; i < 45; i++) stacks.push(await issue(bw.pub, IRON, 2));
    const revBefore = iss.revoked().size;
    const imp = await bw.W((f) => AtlasWallet.importWallet(f), exportFile(stacks));
    const bwIron = await audit(iss, bw.W, bw.pub, IRON);
    check('batch: 45 imported balances', imp.assetsAdded === 45, imp);
    check('batch: merged into one balance of 90', bwIron.stacks === 1 && bwIron.held === 90 && bwIron.revokedHeld === 0, bwIron);
    check('batch: 45 predecessors revoked, plus the two intermediate balances', iss.revoked().size - revBefore >= 45, iss.revoked().size - revBefore);
    const bwStatus = await bw.W((k) => AtlasWallet.getConsolidationStatus(k), bw.pub);
    check('batch: no failures reported', bwStatus.failed.length === 0, bwStatus);

    // ---- a predecessor already spent at the issuer ----
    const sw = await newWallet('wfspent'); opened.push(sw);
    const group = [];
    for (let i = 0; i < 25; i++) group.push(await issue(sw.pub, IRON, 3));
    const gone = await post('/atlas/asset/split', { credential: group[7], sendAmount: 1, toPublicKey: sw.pub, requestId: rid() });
    check('spent: setup spent one balance at the issuer', gone.status === 200);
    await sw.W((f) => AtlasWallet.importWallet(f), exportFile(group));
    const swIron = await sw.W(([k, c]) => AtlasWallet.getWallet(k).then((w) => w.filter((e) => e.credential.asset.class === c).map((e) => ({ id: e.credential.id, q: e.credential.quantity, spent: !!e.spent || (e.lastVerdict && e.lastVerdict.status === 'revoked') }))), [sw.pub, IRON]);
    const live = swIron.filter((e) => !e.spent);
    check('spent: the 24 good balances merged into one of 72', live.length === 1 && live[0].q === 72, live);
    check('spent: the spent balance is kept, flagged, and not merged', swIron.some((e) => e.id === group[7].id && e.spent), swIron.length);
    const swStatus = await sw.W((k) => AtlasWallet.getConsolidationStatus(k), sw.pub);
    check('spent: no failure reported for it', swStatus.failed.length === 0, swStatus);
    const again = await sw.W((k) => AtlasWallet.autoConsolidateAssetWallet(k), sw.pub);
    check('spent: running consolidation again presents nothing spent and changes nothing', again.merged === 0 && again.failed.length === 0 && again.spent === 0, again);
    const spentRows = await view(sw.W, sw.pub, IRON);
    check('spent: the kept entry is not in the live balance', spentRows.filter((e) => !e.spent).reduce((s, e) => s + e.q, 0) === 72);

    // spent after the wallet last checked: the issuer refuses it, the wallet flags it and carries on
    const s2 = await newWallet('wfspent2'); opened.push(s2);
    const g2 = [];
    for (let i = 0; i < 25; i++) g2.push(await issue(s2.pub, IRON, 3));
    proxy.state.mode = 'refuse'; proxy.state.match = /consolidate/;
    await s2.W((f) => AtlasWallet.importWallet(f), exportFile(g2));
    const gone2 = await post('/atlas/asset/split', { credential: g2[3], sendAmount: 1, toPublicKey: s2.pub, requestId: rid() });
    proxy.state.mode = 'pass';
    await s2.W((k) => AtlasWallet.recoverPendingOperations(k), s2.pub);
    const rep2 = await s2.W((k) => AtlasWallet.autoConsolidateAssetWallet(k), s2.pub);
    const rows2 = await s2.W(([k, c]) => AtlasWallet.getWallet(k).then((w) => w.filter((e) => e.credential.asset.class === c).map((e) => ({ id: e.credential.id, q: e.credential.quantity, flagged: !!e.spent }))), [s2.pub, IRON]);
    check('spent-late: the issuer refused the spent balance and the wallet flagged it', gone2.status === 200 && rep2.spent >= 1 && rows2.some((e) => e.id === g2[3].id && e.flagged), [rep2, rows2.length]);
    const live2 = rows2.filter((e) => !e.flagged);
    check('spent-late: the other 24 merged into one balance of 72', live2.length === 1 && live2[0].q === 72, live2);
    check('spent-late: no failure reported', rep2.failed.length === 0, rep2);

    // ---- a failing issuer is reported, balances stay valid, and the next attempt succeeds ----
    const fw = await newWallet('wffail'); opened.push(fw);
    proxy.state.mode = 'refuse'; proxy.state.match = /consolidate/;
    const trio3 = [await issue(fw.pub, IRON, 5), await issue(fw.pub, IRON, 5), await issue(fw.pub, IRON, 5)];
    const failImport = await fw.W((f) => AtlasWallet.importWallet(f), exportFile(trio3));
    const failStatus = await fw.W((k) => AtlasWallet.getConsolidationStatus(k), fw.pub);
    check('failure: the import itself succeeds', failImport.assetsAdded === 3, failImport);
    check('failure: the failed merge is recorded, not swallowed', failStatus.failed.length === 1 && failStatus.failed[0].stacks === 3 && failStatus.failed[0].pending === true, failStatus);
    const failLog = await fw.W(() => AtlasWallet.getActivityLog());
    check('failure: the activity log says so', failLog.some((e) => /Could not merge 3 atlas\.element\.iron/.test(e.text || e.message || JSON.stringify(e))), failLog.slice(0, 3));
    const failAudit = await audit(iss, fw.W, fw.pub, IRON);
    check('failure: all three balances still held and valid', failAudit.stacks === 3 && failAudit.held === 15 && failAudit.revokedHeld === 0, failAudit);
    const pend = await fw.W((k) => AtlasWallet.getPendingOperations(k), fw.pub);
    check('failure: the request that did not reach the issuer is waiting in the journal', pend.length >= 1 && pend[0].kind === 'consolidate', pend);
    proxy.state.mode = 'pass';
    await fw.W((k) => AtlasWallet.recoverPendingOperations(k), fw.pub);
    await fw.W((k) => AtlasWallet.autoConsolidateAssetWallet(k), fw.pub);
    const healed = await audit(iss, fw.W, fw.pub, IRON);
    const healedStatus = await fw.W((k) => AtlasWallet.getConsolidationStatus(k), fw.pub);
    check('failure: once the issuer is reachable the balances merge and the report clears', healed.stacks === 1 && healed.held === 15 && healedStatus.failed.length === 0, [healed, healedStatus]);

    // ---- an answer that never arrives ----
    const lw = await newWallet('wflost'); opened.push(lw);
    // mint
    proxy.state.mode = 'swallow'; proxy.state.match = /\/atlas\/asset\/issue/; proxy.state.times = 2;
    const lostMint = await lw.W((a) => AtlasWallet.mintAsset('self', a.d, a.c, a.q).then(() => 'ok', (e) => ({ message: e.message, pending: !!e.pending })), { d: DOMAIN, c: GOLD, q: 10 });
    check('lost mint: the wallet reports the request as saved, not lost', lostMint !== 'ok' && lostMint.pending === true, lostMint);
    const lostPending = await lw.W((k) => AtlasWallet.getPendingOperations(k), lw.pub);
    check('lost mint: it waits in the pending journal', lostPending.length === 1 && lostPending[0].kind === 'mint', lostPending);
    const raw = await lw.W(() => chrome.storage.local.get('atlasPendingOps'));
    const rawText = JSON.stringify(raw);
    check('lost mint: the stored journal is encrypted (no request id or credential text)', !rawText.includes(lostPending[0].requestId) && !rawText.includes('existingBalances') && !rawText.includes('ownerPublicKey'), rawText.slice(0, 120));
    check('lost mint: the issuer did sign it', (await audit(iss, lw.W, lw.pub, GOLD)).held === 0);
    proxy.state.mode = 'pass'; proxy.state.times = 0;
    const rec = await lw.W((k) => AtlasWallet.recoverPendingOperations(k), lw.pub);
    const lostAfter = await audit(iss, lw.W, lw.pub, GOLD);
    check('lost mint: recovery brings the same 10 g into the wallet, once', rec.length === 1 && rec[0].status === 'completed' && lostAfter.held === 10, [rec, lostAfter]);
    const recAgain = await lw.W((k) => AtlasWallet.recoverPendingOperations(k), lw.pub);
    check('lost mint: nothing left to recover', recAgain.length === 0);
    proxy.state.mode = 'pass';
    const capProbe = await post('/atlas/asset/issue', { ownerPublicKey: lw.pub, assetClass: GOLD, quantity: 491, requestId: rid() });
    const capOk = await post('/atlas/asset/issue', { ownerPublicKey: lw.pub, assetClass: GOLD, quantity: 490, requestId: rid() });
    check('lost mint: the issuer counts 10 g held, not 20', capProbe.status === 400 && capOk.status === 200, [capProbe.status, capOk.status]);

    // consolidate
    const cw = await newWallet('wflostc'); opened.push(cw);
    const parts = [await issue(cw.pub, IRON, 4), await issue(cw.pub, IRON, 5), await issue(cw.pub, IRON, 6)];
    proxy.state.mode = 'refuse'; proxy.state.match = /consolidate/;
    await cw.W((f) => AtlasWallet.importWallet(f), exportFile(parts));
    proxy.state.mode = 'swallow'; proxy.state.match = /consolidate/; proxy.state.times = 2;
    await cw.W((k) => AtlasWallet.recoverPendingOperations(k), cw.pub);
    const midAudit = await audit(iss, cw.W, cw.pub, IRON);
    check('lost consolidate: after the lost answer the wallet still shows its balances', midAudit.held === 15, midAudit);
    proxy.state.mode = 'pass';
    const revBeforeRetry = iss.revoked().size;
    await cw.W((k) => AtlasWallet.recoverPendingOperations(k), cw.pub);
    await cw.W((k) => AtlasWallet.autoConsolidateAssetWallet(k), cw.pub);
    const cwAfter = await audit(iss, cw.W, cw.pub, IRON);
    check('lost consolidate: the retry yields the one successor of 15 g and the old balances are gone', cwAfter.stacks === 1 && cwAfter.held === 15 && cwAfter.revokedHeld === 0, cwAfter);
    check('lost consolidate: nothing was spent twice', iss.revoked().size - revBeforeRetry === 0, iss.revoked().size - revBeforeRetry);
    check('lost consolidate: nothing pending', (await cw.W((k) => AtlasWallet.getPendingOperations(k), cw.pub)).length === 0);

    // split and convert
    const xw = await newWallet('wflosts'); opened.push(xw);
    await xw.W((a) => AtlasWallet.mintAsset('self', a.d, a.c, a.q), { d: DOMAIN, c: GOLD, q: 100 });
    const gold = (await xw.W((k) => AtlasWallet.getWallet(k), xw.pub))[0].credential;
    proxy.state.mode = 'swallow'; proxy.state.match = /\/atlas\/convert/; proxy.state.times = 2;
    const lostConv = await xw.W((a) => AtlasWallet.convertAsset('self', a.c, 40, a.t).then(() => 'ok', (e) => ({ pending: !!e.pending })), { c: gold, t: PLAT });
    check('lost convert: reported as saved', lostConv !== 'ok' && lostConv.pending === true, lostConv);
    proxy.state.mode = 'pass';
    const convRec = await xw.W((k) => AtlasWallet.recoverPendingOperations(k), xw.pub);
    const xg = await audit(iss, xw.W, xw.pub, GOLD), xp = await audit(iss, xw.W, xw.pub, PLAT);
    check('lost convert: recovery leaves 60 Gold and the Platinum, none duplicated', convRec[0] && convRec[0].status === 'completed' && xg.held === 60 && xp.held > 0 && xg.revokedHeld === 0, [xg, xp]);
    const xgold = (await xw.W((k) => AtlasWallet.getWallet(k), xw.pub)).map((e) => e.credential).filter((c) => c.asset.class === GOLD)[0];
    proxy.state.mode = 'swallow'; proxy.state.match = /\/atlas\/asset\/split/; proxy.state.times = 2;
    const lostSplit = await xw.W((a) => AtlasWallet.splitAsset('self', a.c, 10, 'self').then(() => 'ok', (e) => ({ pending: !!e.pending })), { c: xgold });
    check('lost split: reported as saved', lostSplit !== 'ok' && lostSplit.pending === true, lostSplit);
    proxy.state.mode = 'pass';
    await xw.W((k) => AtlasWallet.recoverPendingOperations(k), xw.pub);
    await xw.W((k) => AtlasWallet.autoConsolidateAssetWallet(k), xw.pub);
    const xg2 = await audit(iss, xw.W, xw.pub, GOLD);
    check('lost split: both halves are back and merge to 60 Gold', xg2.held === 60 && xg2.revokedHeld === 0 && xg2.stacks === 1, xg2);

    // a definite refusal is not retried forever
    const rw = await newWallet('wfrefuse'); opened.push(rw);
    const big = await rw.W((a) => AtlasWallet.mintAsset('self', a.d, a.c, a.q).then(() => 'ok', (e) => ({ message: e.message, pending: !!e.pending, code: e.code })), { d: DOMAIN, c: GOLD, q: 100000 });
    check('refusal: an over-cap mint is refused and not left pending', big !== 'ok' && big.pending === false && big.code === 'cap', big);
    check('refusal: nothing pending', (await rw.W((k) => AtlasWallet.getPendingOperations(k), rw.pub)).length === 0);

    // wallet identity and other assets are untouched by all of this
    const idCheck = await trio[0].W(() => AtlasWallet.getIdentity().then((i) => i && i.publicKey));
    check('identity preserved', idCheck === trio[0].pub);
  } catch (e) {
    failures++; console.log('FAIL threw :: ' + (e.stack || e));
  } finally {
    for (const x of opened) { try { await x.close(); } catch (e) { /* ignore */ } }
    proxy.stop(); iss.stop();
  }
  console.log('\nwallet fixes: ' + passes + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
})();
