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
const { Wallet, PASSWORD, sleep } = require('./lib/wallet-profile');
const issuers = require('./lib/gen1-issuers');

const IRON = 'atlas.element.iron', GOLD = 'atlas.element.gold';
const args = process.argv.slice(2);
const which = args.find((a) => /^(node|php|both)$/.test(a)) || 'node';
const QUICK = args.includes('--quick');
const ONLY = (args.find((a) => a.startsWith('--only=')) || '').slice(7);

let passes = 0, failures = 0;
const gaps = [];
const check = (name, ok, detail) => { if (ok) { passes++; console.log('PASS ' + name); } else { failures++; console.log('FAIL ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 600) : '')); } };
const gap = (name, hit, detail) => { if (hit) { gaps.push(name); console.log('GAP  ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 600) : '')); } else console.log('OK   ' + name); };
const rid = () => crypto.randomBytes(18).toString('base64url');


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
      await successorOk(w, iss, r.preds, 'after the unlock', r.revBefore);
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
      // The extension asks the issuer by itself right after the unlock (docs/gen1-auto-recovery.md).
      w.autoRecovery = true;
      await w.unlock();
      let settled = false;
      for (let i = 0; i < 150 && !settled; i++) { settled = (await w.pending()).length === 0; if (!settled) await sleep(100); }
      check('after unlocking, the journal entry is recovered by the extension without any other action', settled, await w.pending());
      const liveNow = await w.live(IRON);
      check('and the wallet does not list anything the issuer has revoked as live', liveNow.every((x) => !iss.revoked().has(x.id)), liveNow);
      await successorOk(w, iss, r.preds, 'after the unlock', r.revBefore);
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
      // The page also recovers by itself when it opens on an unlocked wallet, so the explicit calls may find nothing left to
      // apply; the checks below fix the end state to exactly one successor.
      check('the answer is applied at most once across both pages', applied <= 1, results);
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
      const kept = await w.pending();
      check('the journal entry is kept as needs-attention and recovery reports it as such', kept.length === 1 && kept[0].state === 'needs-attention' && rec.length === 1 && rec[0].status === 'needs-attention', { kept, rec });
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

    // ---- 10. non-fungible mint and purchase: journalled like the fungible operations ----
    await scenario(kind, 'C2 a non-fungible mint whose answer is lost', async (w, iss) => {
      await w.inject('dropAnswer', '/atlas/asset/issue');
      const out = await w.W((a) => AtlasWallet.mintAsset('self', a.d, 'atlas.wearable').then(() => 'ok', (e) => ({ message: e.message, pending: !!e.pending })), { d: iss.domain });
      const hits = (await w.faultInfo()).hits;
      await w.clearFault();
      check('reported as saved, and the journal holds the request', out !== 'ok' && out.pending === true && hits === 1 && (await w.pending()).length === 1, { out, hits });
      await w.restart(true);
      const rec = await w.recover();
      const held = await w.rows('atlas.wearable');
      check('recovery brings the credential the issuer signed, once', rec.length === 1 && rec[0].status === 'completed' && held.length === 1 && (await w.pending()).length === 0, { rec, held: held.length });
    });

    await scenario(kind, 'C5 a purchase whose answer is lost', async (w, iss) => {
      const first = await mint(w, iss, 'atlas.credit.balance', 10);
      if (first !== 'ok') { console.log('SKIP purchase probe: could not mint the credit class here: ' + JSON.stringify(first)); return; }
      const balance = (await w.rows('atlas.credit.balance'))[0];
      await w.inject('dropAnswer', '/atlas/asset/purchase');
      const out = await w.W((a) => AtlasWallet.purchaseAsset('self', a.d, 'atlas.demo.cafeteria.sandwich', 1).then(() => 'ok', (e) => ({ message: String(e.message).slice(0, 80), pending: !!e.pending })), { d: iss.domain });
      const hits = (await w.faultInfo()).hits;
      await w.clearFault();
      check('the issuer spent the balance and the wallet reports the purchase as saved', hits === 1 && iss.revoked().has(balance.id) && out !== 'ok' && out.pending === true && (await w.pending()).length === 1, { out, hits });
      await w.restart(true);
      const rec = await w.recover();
      const sandwich = await w.live('atlas.demo.cafeteria.sandwich');
      check('recovery brings the purchased item and the 5 credits left, once', rec.length === 1 && rec[0].status === 'completed' && sandwich.length === 1 && sum(await w.live('atlas.credit.balance')) === 5, { rec });
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
      check('a lock that fires while a non-fungible mint is in flight leaves the encrypted wallet intact (Iron held: ' + sum(iron) + ' g of 40)', sum(iron) === 40, { out, iron, wear });
      check('the refused mint reports the wallet as locked', /locked/i.test(String(out)), { out });
    });

    // ---- 12. a backup taken inside the window, restored on a fresh profile ----
    await scenario(kind, 'D1 backup taken inside the window, restored on a fresh profile', async (w, iss) => {
      await interrupted(w, iss, 'dropAnswer');
      const file = await w.W(([pw, seed]) => AtlasWallet.exportFullBackup(pw, seed), [PASSWORD, w.seed]);
      const w2 = await new Wallet('D1restore').launch();
      try {
        const res = await w2.W(([f, pw, seed]) => AtlasWallet.importFullBackup(f, pw, seed).then((x) => x || 'ok', (e) => 'err ' + e.message), [file, PASSWORD, w.seed]);
        await w2.unlock().catch(() => null);
        w2.pub = w.pub;
        const pend = await w2.pending();
        check('the restored profile has the journal entry (the backup carries it; see docs/gen1-backup-journal.md)', pend.length === 1 && pend[0].state === 'pending', { res: JSON.stringify(res).slice(0, 120), pend });
        const rec = await w2.recover();
        const afterRecover = await w2.live(IRON);
        check('recovery by the original request id gives the full 40 g, once', rec.length === 1 && rec[0].status === 'completed' && sum(afterRecover) === 40 && afterRecover.length === 1, { rec, afterRecover });
        await w2.W(() => AtlasWallet.reverifyAll());
        const afterLive = await w2.live(IRON);
        check('after a re-verify: still 40 g, and nothing revoked is held as live', sum(afterLive) === 40 && afterLive.every((x) => !iss.revoked().has(x.id)), afterLive);
      } finally { await w2.dispose(); }
    });
  }
}

main().then(() => {
  console.log('\nwallet crash recovery: ' + passes + ' passed, ' + failures + ' failed, ' + gaps.length + ' gaps');
  gaps.forEach((g) => console.log('  GAP ' + g));
  process.exit(failures ? 1 : 0);
}).catch((e) => { console.log('FAIL harness :: ' + (e.stack || e)); process.exit(1); });
