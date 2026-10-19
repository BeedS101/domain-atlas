// A trade claim whose second leg fails after the first: the claimant's refund and the change (remainder) the first
// leg minted must both reach the wallet, exactly once, with exact quantities, or the claim must stay visible as
// unresolved. Covers an exact balance and a larger balance, a lost answer, repeats, concurrency, a killed browser,
// a locked wallet, a backup with the claim pending, malformed or wrongly owned or forged credentials, a foreign
// first leg, and older issuers and wallets (negative controls from git history).
//
// Disposable Chromium profiles with the real extension; throw-away Node or PHP issuers (own key, state, revocation
// list). The poster's issuer is rigged so that its relay-settle always fails before changing anything. Nothing live
// is read or written.
//
//   xvfb-run -a node test/manual-gen1-claim-remainder.js [node|php|both] [--only=R3]
'use strict';
const fs = require('fs');
const path = require('path');
const { Wallet, PASSWORD, sleep } = require('./lib/wallet-profile');
const U = require('./manual-gen1-unique-recovery');
const { check, info, scenario, post, mint, shown, live, sum, retry, waitFor, rawIdentity, newRid, postListing, walletClaim, trustPeers, failingSettleOpts, listingCount, exportBackup, importBackup, lockWallet } = U;
const { IRON, GOLD, MEMBER } = U.constants;
const which = U.which;
const CLAIM = '/atlas/trade/claim';

const state = async (w) => ({ iron: sum(await live(w, IRON)), gold: sum(await live(w, GOLD)) });
// What the issuer counts as held by this owner (the cap answer carries the figure).
async function heldAt(iss, pub, cls) {
  const r = await iss.api.post('/atlas/asset/issue', { ownerPublicKey: pub, assetClass: cls, quantity: 501, requestId: newRid() });
  return r.status === 400 && r.body && r.body.code === 'cap' ? r.body.held : null;
}

// Rewrites the next `times` answers to a matching request, after the real issuer produced them.
async function mutateAnswer(w, source, mode, times) {
  await w.W(([src, m, n]) => {
    const re = new RegExp(src);
    const inner = globalThis.__mutInner || (globalThis.__mutInner = globalThis.fetch.bind(globalThis));
    let left = n;
    globalThis.fetch = async (url, opts) => {
      const res = await inner(url, opts);
      if (!(re.test(String(url)) && left > 0)) return res;
      left--;
      const data = await res.json();
      const owner = (c) => (c ? Object.assign({}, c, { owner: { publicKey: 'someone-else' } }) : c);
      const patch = (c, over) => (c ? Object.assign({}, c, over) : c);
      if (m === 'noRemainderKey') delete data.remainder;
      if (m === 'nullRemainder') data.remainder = null;
      if (m === 'remainderOtherOwner') data.remainder = owner(data.remainder);
      if (m === 'refundOtherOwner') data.refund = owner(data.refund);
      if (m === 'remainderMoreQuantity') data.remainder = patch(data.remainder, { quantity: data.remainder.quantity + 1 });
      if (m === 'remainderWrongClass') data.remainder = patch(data.remainder, { asset: Object.assign({}, data.remainder.asset, { class: 'atlas.element.iron' }) });
      if (m === 'remainderForged') data.remainder = patch(data.remainder, { signature: 'A' + String(data.remainder.signature).slice(1) });
      if (m === 'refundForged') data.refund = patch(data.refund, { signature: 'A' + String(data.refund.signature).slice(1) });
      if (m === 'remainderOnExact') data.remainder = data.refund;
      return new Response(JSON.stringify(data), { status: res.status });
    };
  }, [source, mode, times]);
}

// The poster's iron lives on a rigged issuer (relay-settle always fails); the claimant's gold is issued by the
// station, or by a third issuer when `goldAtForeign`. Returns what the scenario needs.
async function world(kind, w, iss, ctx, gold, opts) {
  opts = opts || {};
  const rigged = await ctx.issuer(kind, Object.assign({ workers: 4 }, failingSettleOpts(kind)));
  const peers = [rigged.domain];
  let goldIss = iss, foreign = null;
  if (opts.goldAtForeign) {
    foreign = await ctx.issuer(kind, { workers: 4 });
    trustPeers(foreign, [iss.domain]);
    peers.push(foreign.domain);
    goldIss = foreign;
  }
  trustPeers(iss, peers); trustPeers(rigged, [iss.domain]);
  const listing = await postListing(iss, rigged);
  const m = await mint(w, iss, MEMBER); if (m !== 'ok') throw new Error('membership failed: ' + JSON.stringify(m));
  const g = await mint(w, goldIss, GOLD, gold); if (g !== 'ok') throw new Error('gold failed: ' + JSON.stringify(g));
  return { rigged, foreign, goldIss, listing };
}
const claim = (w, iss, wd) => walletClaim(w, iss, wd.goldIss.domain);
async function lostClaim(w, iss, wd) {
  await w.inject('dropAnswer', CLAIM);
  const out = await claim(w, iss, wd);
  const fault = await w.faultInfo();
  await w.clearFault();
  return { out, fault };
}
const entryOf = async (w) => (await w.pending())[0];

async function scenarios(kind) {
  const hold = kind === 'php' ? { workers: 4 } : undefined;

  await scenario(kind, 'R1 exact balance: the refund is the whole outcome, nothing is owed as change', async (w, iss, ctx) => {
    const wd = await world(kind, w, iss, ctx, 5);
    const out = await claim(w, iss, wd);
    const st = await state(w);
    check('the claim ends as refunded; 5 gold back, no iron', out !== 'ok' && out.pending !== true && !out.needsAttention && st.gold === 5 && st.iron === 0, { out, st });
    check('the issuer counts the same 5 gold; the journal is empty', (await heldAt(iss, w.pub, GOLD)) === 5 && (await w.pending()).length === 0, { held: await heldAt(iss, w.pub, GOLD) });
    const rows = await live(w, GOLD);
    check('the refund verifies', rows.length === 1 && rows[0].status === 'verified', rows);
  }, hold);

  await scenario(kind, 'R2 larger balance: refund and change both arrive', async (w, iss, ctx) => {
    const wd = await world(kind, w, iss, ctx, 10);
    const out = await claim(w, iss, wd);
    const rows = await live(w, GOLD);
    check('10 gold held: the 5 refunded and the 5 of change, both verified', sum(rows) === 10 && rows.length === 2 && rows.every((r) => r.status === 'verified'), { out, rows });
    check('the issuer counts the same 10 gold (the original 5 g vs 10 g gap is gone)', (await heldAt(iss, w.pub, GOLD)) === 10, { held: await heldAt(iss, w.pub, GOLD) });
    check('no iron arrived, the entry is closed, the poster\'s iron is untouched', (await state(w)).iron === 0 && (await w.pending()).length === 0 && !wd.rigged.revoked().has(wd.listing.iron.id));
    check('reported as a refunded trade', out !== 'ok' && out.pending !== true && !out.needsAttention, out);
  }, hold);

  await scenario(kind, 'R3 the incomplete answer is lost: recovery returns the same refund and change', async (w, iss, ctx) => {
    const wd = await world(kind, w, iss, ctx, 10);
    const { out, fault } = await lostClaim(w, iss, wd);
    check('saved, not failed', out !== 'ok' && out.pending === true, out);
    const revs = iss.revCount();
    const heldBefore = await heldAt(iss, w.pub, GOLD);
    await w.restart(true);
    const r = await w.recover();
    const rows = await live(w, GOLD);
    check('recovery applies both credentials once: 10 gold', r.length === 1 && sum(rows) === 10 && rows.length === 2 && (await w.pending()).length === 0, { r, rows });
    check('no credential was created by the recovery: same revocations and the same holdings', iss.revCount() === revs && (await heldAt(iss, w.pub, GOLD)) === heldBefore && heldBefore === 10, { heldBefore });
    const again = await w.recover();
    check('a further recovery has nothing to do', again.length === 0 && sum(await live(w, GOLD)) === 10);
    const direct = [];
    for (let i = 0; i < 3; i++) direct.push(await post(iss, CLAIM, JSON.parse(fault.bodies[0])));
    const ids = new Set(direct.map((d) => d.body.refund.id + '/' + d.body.remainder.id));
    check('the same request asked directly three more times returns the same two credentials', direct.every((d) => d.status === 502 && d.body.code === 'claim-incomplete') && ids.size === 1 && [...ids][0].split('/').every((id) => rows.some((x) => x.id === id)) && (await heldAt(iss, w.pub, GOLD)) === 10, direct.map((d) => d.status));
  }, hold);

  await scenario(kind, 'R4 simultaneous retries from several views', async (w, iss, ctx) => {
    const wd = await world(kind, w, iss, ctx, 10);
    const { fault } = await lostClaim(w, iss, wd);
    const body = JSON.parse(fault.bodies[0]);
    const direct = await Promise.all([1, 2, 3, 4, 5, 6].map(() => post(iss, CLAIM, body)));
    const ids = new Set(direct.filter((d) => d.status === 502).map((d) => d.body.refund.id + '/' + d.body.remainder.id));
    check('six simultaneous identical requests: one pair of credentials', direct.every((d) => d.status === 502 || d.status === 503) && ids.size === 1 && (await heldAt(iss, w.pub, GOLD)) === 10, direct.map((d) => d.status));
    const id = new URL(w.sw.url()).host;
    const pages = [];
    for (let i = 0; i < 3; i++) { const pg = await w.context.newPage(); await pg.goto('chrome-extension://' + id + '/viewer.html'); await pg.waitForFunction(() => typeof AtlasWallet !== 'undefined', null, { timeout: 15000 }); pages.push(pg); }
    await Promise.all([w.recover(), ...pages.map((pg) => pg.evaluate((k) => AtlasWallet.recoverPendingOperations(k), w.pub))]);
    await waitFor(async () => (await w.pending()).length === 0, 15000);
    const rows = await live(w, GOLD);
    check('three pages and the worker recover at once: exactly 10 gold in two credentials, journal empty', sum(rows) === 10 && rows.length === 2 && (await w.pending()).length === 0, rows);
    for (const pg of pages) await pg.close();
  }, hold);

  await scenario(kind, 'R5 browser killed after the answer arrived, before it was stored', async (w, iss, ctx) => {
    const wd = await world(kind, w, iss, ctx, 10);
    await w.inject('hangCommit', CLAIM);
    const call = claim(w, iss, wd).catch(() => null);
    check('the station answered and the wallet was about to store it', await waitFor(async () => (await w.faultInfo()).hits >= 1, 15000));
    await w.kill(); await call;
    await w.launch(); await w.unlock();
    check('nothing stored; the request is journalled; the held balance is not spendable', (await state(w)).gold === 0 && (await w.pending()).length === 1);
    const r = await w.recover();
    check('recovery applies refund and change once: 10 gold', r.length === 1 && sum(await live(w, GOLD)) === 10 && (await heldAt(iss, w.pub, GOLD)) === 10, r);
  }, hold);

  await scenario(kind, 'R6 the wallet locks while the incomplete answer arrives', async (w, iss, ctx) => {
    const wd = await world(kind, w, iss, ctx, 10);
    await w.inject('delayAnswer', CLAIM);
    const call = claim(w, iss, wd);
    check('the answer has arrived and is held back', await waitFor(async () => (await w.W(() => (globalThis.__fault ? globalThis.__fault.releases.length : 0))) > 0, 30000));
    await lockWallet(w); await w.release();
    const out = await call;
    check('saved; nothing applied while locked', out !== 'ok' && (out.pending === true || out.code === 'wallet-locked'), out);
    await w.clearFault(); await w.unlock();
    const r = await w.recover();
    check('after the unlock: 10 gold, once', r.length === 1 && sum(await live(w, GOLD)) === 10 && (await w.pending()).length === 0, r);
  }, hold);

  await scenario(kind, 'R7 backup taken with the claim pending, restored into a fresh profile', async (w, iss, ctx) => {
    const wd = await world(kind, w, iss, ctx, 10);
    await lostClaim(w, iss, wd);
    const [entry] = await w.pending();
    const file = await exportBackup(w);
    const t = await ctx.fresh('r7restore', w);
    await t.create().catch(() => null);
    const imported = await importBackup(t, file, w.seed);
    t.pub = w.pub;
    await t.restart(true).catch(() => null);
    const [carried] = await t.pending();
    check('restores with the same request id', imported.ok === true && !!carried && carried.requestId === entry.requestId && carried.kind === 'claim', { imported, carried });
    const heldBefore = await heldAt(iss, w.pub, GOLD);
    const r = await t.recover();
    check('the new profile ends with 10 gold in two credentials; nothing new at the issuer', r.length === 1 && sum(await live(t, GOLD)) === 10 && (await live(t, GOLD)).length === 2 && (await heldAt(iss, w.pub, GOLD)) === heldBefore && heldBefore === 10, { r });
    const again = await w.recover();
    check('the original profile recovers the same credentials', again.length === 1 && (await live(w, GOLD)).map((x) => x.id).sort().join() === (await live(t, GOLD)).map((x) => x.id).sort().join(), again);
  }, hold);

  await scenario(kind, 'R8 answers that are not what the station minted are never applied', async (w, iss, ctx) => {
    const wd = await world(kind, w, iss, ctx, 10);
    const modes = [
      ['remainderOtherOwner', 'a change credential owned by someone else'],
      ['remainderMoreQuantity', 'a change credential of the wrong quantity'],
      ['remainderWrongClass', 'a change credential of another class'],
      ['remainderForged', 'a change credential with a forged signature'],
      ['refundOtherOwner', 'a refund owned by someone else'],
      ['refundForged', 'a refund with a forged signature'],
      ['nullRemainder', 'no change although the balance was larger than the payment']
    ];
    // The first attempt sends the real request; the answer is rewritten on the way back. The station has
    // settled it, so each rewrite is followed by the genuine stored outcome.
    await mutateAnswer(w, CLAIM, modes[0][0], 1);
    const first = await claim(w, iss, wd);
    check(modes[0][1] + ': held for attention, nothing applied', first !== 'ok' && first.needsAttention === true && (await state(w)).gold === 0 && (await entryOf(w)).state === 'needs-attention', first);
    const entry = await entryOf(w);
    for (let i = 1; i < modes.length; i++) {
      await w.restart(true);
      await mutateAnswer(w, CLAIM, modes[i][0], 1);
      const out = await retry(w, entry.requestId);
      const now = await entryOf(w);
      check(modes[i][1] + ': still held for attention, nothing applied', now && now.state === 'needs-attention' && (await state(w)).gold === 0 && (await live(w, GOLD)).length === 0, { out, state: now && now.state });
    }
    check('the issuer made nothing new while the answers were rewritten', (await heldAt(iss, w.pub, GOLD)) === 10);
    await w.restart(true);
    const real = await retry(w, entry.requestId);
    const rows = await live(w, GOLD);
    check('asking again by hand with the genuine stored outcome applies refund and change once: 10 gold', sum(rows) === 10 && rows.length === 2 && (await w.pending()).length === 0, { real, rows });
  }, hold);

  await scenario(kind, 'R9 an issuer that returns no change field (the previous version) is not trusted to be complete', async (w, iss, ctx) => {
    const wd = await world(kind, w, iss, ctx, 10);
    await mutateAnswer(w, CLAIM, 'noRemainderKey', 1);
    const out = await claim(w, iss, wd);
    const [entry] = await w.pending();
    const st = await state(w);
    check('the refund is applied (5 gold) and the missing change is kept visible as needs-attention', out !== 'ok' && out.needsAttention === true && st.gold === 5 && !!entry && entry.state === 'needs-attention' && entry.attention.code === 'remainder-not-returned' && entry.attention.applied === true, { out, st, attention: entry && entry.attention });
    check('the spent balance is gone from the wallet and nothing is held back', (await shown(w, GOLD)).every((x) => x.held === null && x.id !== entry.predecessors[0]));
    await w.restart(true);
    const r = await w.recover();
    check('recovery does not send it again and the 5 gold stay as they are', r[0].status === 'needs-attention' && sum(await live(w, GOLD)) === 5, r);
    info('the previous issuer version never returned the change: the station counts ' + (await heldAt(iss, w.pub, GOLD)) + ' gold for this owner, the wallet holds 5; the entry says so');
  }, hold);

  await scenario(kind, 'R10 exact balance and a rewritten change field', async (w, iss, ctx) => {
    const wd = await world(kind, w, iss, ctx, 5);
    await mutateAnswer(w, CLAIM, 'remainderOnExact', 1);
    const out = await claim(w, iss, wd);
    check('a change credential for a payment that left none: held for attention, nothing applied', out !== 'ok' && out.needsAttention === true && (await state(w)).gold === 0, out);
    await w.restart(true);
    const real = await retry(w, (await entryOf(w)).requestId);
    check('the genuine outcome then applies the 5-gold refund', (await state(w)).gold === 5 && (await w.pending()).length === 0, real);
  }, hold);

  // ---- cross-domain: the claimant's gold is issued by a third issuer
  await scenario(kind, 'R11 foreign first leg, larger balance: the change comes back, the payment is not refunded', async (w, iss, ctx) => {
    const wd = await world(kind, w, iss, ctx, 10, { goldAtForeign: true });
    const out = await claim(w, iss, wd);
    const [entry] = await w.pending();
    const st = await state(w);
    check('the change (5 gold, issued by the foreign domain) is applied; no refund, no iron', st.gold === 5 && st.iron === 0, { out, st });
    check('the claim stays visible as needs-attention (the payment was spent abroad and cannot be refunded from here)', out !== 'ok' && out.needsAttention === true && !!entry && entry.state === 'needs-attention' && entry.attention.code === 'claim-incomplete' && entry.attention.applied === true, { out, attention: entry && entry.attention });
    const rows = await live(w, GOLD);
    check('the change is the foreign domain\'s own credential and verifies', rows.length === 1 && rows[0].status === 'verified', rows);
    check('the foreign domain counts the same 5 gold for the owner (change only); the payment sits with the undelivered poster credit', (await heldAt(wd.foreign, w.pub, GOLD)) === 5);
    await w.restart(true);
    const r = await w.recover();
    check('recovery does not resend it; the wallet is unchanged', r[0].status === 'needs-attention' && sum(await live(w, GOLD)) === 5, r);
  }, hold);

  await scenario(kind, 'R12 foreign first leg, exact balance: nothing to return, the balance stays held', async (w, iss, ctx) => {
    const wd = await world(kind, w, iss, ctx, 5, { goldAtForeign: true });
    const out = await claim(w, iss, wd);
    const [entry] = await w.pending();
    check('held for attention as before: balance held back, nothing applied', out !== 'ok' && out.needsAttention === true && !!entry && entry.state === 'needs-attention' && (await state(w)).gold === 0 && (await shown(w, GOLD)).every((x) => x.held !== null), { out, rows: await shown(w, GOLD) });
  }, hold);

  await scenario(kind, 'R13 foreign first leg, answer lost, then recovered', async (w, iss, ctx) => {
    const wd = await world(kind, w, iss, ctx, 10, { goldAtForeign: true });
    const { out } = await lostClaim(w, iss, wd);
    check('saved', out !== 'ok' && out.pending === true, out);
    await w.restart(true);
    const r = await w.recover();
    const [entry] = await w.pending();
    check('the stored outcome gives the change once; the entry stays as needs-attention', r.length === 1 && sum(await live(w, GOLD)) === 5 && !!entry && entry.attention.applied === true, { r });
    const heldAfter = await heldAt(wd.foreign, w.pub, GOLD);
    await w.recover();
    await w.restart(true);
    const manual = await retry(w, entry.requestId);
    check('asking again by hand does not apply the change a second time', sum(await live(w, GOLD)) === 5 && (await heldAt(wd.foreign, w.pub, GOLD)) === heldAfter, manual);
  }, hold);

  await scenario(kind, 'R14 backup of a claim that was applied and stays as needs-attention, restored into a fresh profile', async (w, iss, ctx) => {
    const wd = await world(kind, w, iss, ctx, 10, { goldAtForeign: true });
    await claim(w, iss, wd);
    const [entry] = await w.pending();
    const file = await exportBackup(w);
    const t = await ctx.fresh('r14restore', w);
    await t.create().catch(() => null);
    const imported = await importBackup(t, file, w.seed);
    t.pub = w.pub;
    await t.restart(true).catch(() => null);
    const [carried] = await t.pending();
    check('the entry is carried with its state and the applied mark', imported.ok === true && !!carried && carried.requestId === entry.requestId && carried.state === 'needs-attention' && carried.attention.applied === true, { imported, carried });
    check('the restored wallet holds the 5 gold of change once', sum(await live(t, GOLD)) === 5 && (await live(t, GOLD)).length === 1, await shown(t, GOLD));
    const r = await t.recover();
    check('recovery in the new profile sends nothing and changes nothing', r.length === 1 && r[0].status === 'needs-attention' && sum(await live(t, GOLD)) === 5, r);
  }, hold);
}

// ---------------------------------------------------------------- compatibility and negative controls
async function controls(kind) {
  const prev = U.revisionLacking('issuer-server/server.js', 'trade-claim-remainder');
  const prevWallet = U.revisionLacking('extension/wallet.js', 'claimPaymentOf');
  if (!prev || !prevWallet) { info('controls skipped: no earlier revision found in git history'); return; }
  info('controls run revision ' + prev.rev.slice(0, 10) + ' (issuer) and ' + prevWallet.rev.slice(0, 10) + ' (wallet)');
  const oldStation = kind === 'php' ? { source: prev.phpSource, workers: 4 } : { root: prev.root };
  const oldWallet = { extPath: prevWallet.extDir };
  const hold = kind === 'php' ? { workers: 4 } : undefined;

  await scenario(kind, 'N1 negative control: previous wallet and issuer, larger balance (the original bug)', async (w, iss, ctx) => {
    const wd = await world(kind, w, iss, ctx, 10);
    const out = await claim(w, iss, wd);
    const st = await state(w);
    const held = await heldAt(iss, w.pub, GOLD);
    check('the wallet gets the 5 gold refund; the issuer counts 10; nothing says the change is missing', st.gold === 5 && held === 10 && (await w.pending()).length === 0, { out, st, held });
  }, oldStation, oldWallet);

  await scenario(kind, 'N2 current wallet, previous issuer: the missing change is flagged, the refund is kept', async (w, iss, ctx) => {
    const wd = await world(kind, w, iss, ctx, 10);
    const out = await claim(w, iss, wd);
    const [entry] = await w.pending();
    check('refund applied, entry needs-attention remainder-not-returned, the issuer still counts 10', (await state(w)).gold === 5 && !!entry && entry.attention.code === 'remainder-not-returned' && (await heldAt(iss, w.pub, GOLD)) === 10, { out, attention: entry && entry.attention });
  }, oldStation);

  await scenario(kind, 'N3 current wallet, previous issuer, exact balance: unchanged outcome', async (w, iss, ctx) => {
    const wd = await world(kind, w, iss, ctx, 5);
    const out = await claim(w, iss, wd);
    check('refunded, entry closed (the previous answer is complete when nothing was owed as change)', (await state(w)).gold === 5 && (await w.pending()).length === 0 && out.needsAttention !== true, out);
  }, oldStation);

  await scenario(kind, 'N4 previous wallet, current issuer: the extra field is ignored, the refund is applied', async (w, iss, ctx) => {
    const wd = await world(kind, w, iss, ctx, 10);
    const out = await claim(w, iss, wd);
    check('5 gold refund applied; the answer still carries the change for a wallet that reads it', (await state(w)).gold === 5 && (await heldAt(iss, w.pub, GOLD)) === 10, out);
    info('a wallet from before this change cannot read the change field: it keeps the old behavior (5 gold here, 10 at the issuer)');
  }, hold, oldWallet);

  await scenario(kind, 'N5 successful claims are unchanged (current wallet, current issuer, no failure)', async (w, iss) => {
    const listing = await postListing(iss);
    for (const [cls, q] of [[MEMBER, undefined], [GOLD, 10]]) { const r = await mint(w, iss, cls, q); if (r !== 'ok') throw new Error('setup failed'); }
    const out = await walletClaim(w, iss);
    check('10 iron and 5 gold change, nothing journalled', out === 'ok' && (await state(w)).iron === 10 && (await state(w)).gold === 5 && (await w.pending()).length === 0 && (await listingCount(iss)) === 0, out);
  }, hold);
}

async function main() {
  const kinds = which === 'both' ? ['node', 'php'] : [which];
  for (const kind of kinds) {
    await scenarios(kind);
    await controls(kind);
  }
  const { passes, failures } = U.counts();
  console.log(`\nclaim remainder: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
