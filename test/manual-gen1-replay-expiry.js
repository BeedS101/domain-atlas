// What the wallet does when the issuer's stored answer for an interrupted replacement (consolidate,
// split, convert, fungible mint) is no longer available: the retry is refused, the predecessors are
// already revoked, and the successors exist only in the answer that was lost.
//
// Disposable Chromium profiles with the real extension and throw-away Node or PHP issuers (own key,
// state and revocation list, replay retention shortened to about two seconds). Nothing live is read
// or written.
//
//   xvfb-run -a node test/manual-gen1-replay-expiry.js [node|php|both] [--only=E1]
//
// Every line is a property that must hold. "INFO" lines record what is still impossible.
'use strict';
const crypto = require('crypto');
const { Wallet, PASSWORD, sleep } = require('./lib/wallet-profile');
const issuers = require('./lib/gen1-issuers');

const IRON = 'atlas.element.iron', GOLD = 'atlas.element.gold';
const args = process.argv.slice(2);
const which = args.find((a) => /^(node|php|both)$/.test(a)) || 'node';
const ONLY = (args.find((a) => a.startsWith('--only=')) || '').slice(7);
const TTL_ENV = { ATLAS_REPLAY_TTL_HOURS: '0.0006' }; // 2.16 s
const EXPIRY_WAIT_MS = 4500;

let passes = 0, failures = 0;
const check = (name, ok, detail) => {
  if (ok) { passes++; console.log('PASS ' + name); } else { failures++; console.log('FAIL ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 700) : '')); }
};
const info = (text) => console.log('INFO ' + text);

let nextPort = 21000 + (process.pid % 500) * 20;
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

const mint = (w, iss, cls, q) => w.W((a) => AtlasWallet.mintAsset('self', a.d, a.c, a.q).then(() => 'ok', (e) => ({ message: e.message, pending: !!e.pending, code: e.code })), { d: iss.domain, c: cls, q });
const sum = (rows) => rows.reduce((s, r) => s + r.q, 0);

// What the wallet shows: getWallet() entries, with the verdict and the unresolved mark.
const shown = (w, cls) => w.W(([k, c]) => AtlasWallet.getWallet(k).then((list) => list.filter((e) => e.credential.asset.class === c).map((e) => ({
  id: e.credential.id, q: e.credential.quantity, status: e.lastVerdict && e.lastVerdict.status, valid: !!(e.lastVerdict && e.lastVerdict.valid),
  held: e.pendingOutcome ? e.pendingOutcome.state : null, spent: !!e.spent
}))), [w.pub, cls]);
const credentialsOf = (w, cls) => w.W(([k, c]) => AtlasWallet.getWallet(k).then((list) => list.filter((e) => e.credential.asset.class === c).map((e) => e.credential)), [w.pub, cls]);

// Counts requests whose URL matches `source` without changing them (stays until the page restarts).
async function countRequests(w, source) {
  await w.W((src) => {
    const re = new RegExp(src);
    const inner = globalThis.fetch.bind(globalThis);
    globalThis.__count = 0;
    globalThis.fetch = (url, opts) => { if (re.test(String(url))) globalThis.__count++; return inner(url, opts); };
  }, source);
}
const requestCount = (w) => w.W(() => globalThis.__count);

// Replaces the next `times` requests whose URL matches `source`:
//   html / truncated / empty / array   a 200 answer that is not a usable result
//   wrongowner                         the real answer, with another owner on the credential
//   status403                          a 403 HTML page
//   cap                                a 400 JSON refusal
//   revocations                        the revocation list cannot be read
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
        if (m === 'empty') return new Response('', { status: 200 });
        if (m === 'array') return new Response('[]', { status: 200 });
        if (m === 'status403') return new Response('<html><body>Forbidden</body></html>', { status: 403, headers: { 'Content-Type': 'text/html' } });
        if (m === 'cap') return new Response(JSON.stringify({ error: 'holding cap', code: 'cap', held: 500, cap: 500 }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        if (m === 'revocations') throw new TypeError('Failed to fetch (revocation list unreachable in test)');
        if (m === 'wrongowner') {
          const res = await inner(url, opts);
          const body = await res.json();
          body.owner = Object.assign({}, body.owner, { publicKey: 'AAAA-not-the-owner' });
          return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
      }
      return inner(url, opts);
    };
  }, [source, mode, times]);
}
const unfake = (w) => w.W(() => { if (globalThis.__fakeInner) { globalThis.fetch = globalThis.__fakeInner; globalThis.__fakeInner = null; } });

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

// 20 g, then a second 20 g whose consolidation answer is lost after the issuer committed it.
async function consolidationWithLostAnswer(w, iss) {
  check('setup: first mint of 20 Iron', (await mint(w, iss, IRON, 20)) === 'ok');
  await w.inject('dropAnswer', '/atlas/asset/consolidate');
  await mint(w, iss, IRON, 20).catch(() => null);
  const info = await w.faultInfo();
  const sent = info.bodies[0] ? JSON.parse(info.bodies[0]) : null;
  const preds = sent ? sent.credentials.map((c) => c.id) : [];
  check('the issuer committed the consolidation (both 20 g credentials revoked), the answer was lost', info.hits === 1 && preds.length === 2 && preds.every((id) => iss.revoked().has(id)), { hits: info.hits, preds });
  return { preds };
}

const CONVERT_BOGUS = (w, cred) => w.W((c) => AtlasWallet.convertAsset('self', c, 5, 'atlas.element.does-not-exist').then(() => 'ok', (e) => ({ message: e.message, pending: !!e.pending, code: e.code })), cred);

async function main() {
  const kinds = which === 'both' ? ['node', 'php'] : [which];
  for (const kind of kinds) {
    // ---- E1: the stored answer has expired ----
    await scenario(kind, 'E1 stored answer expired: the retry is refused as revoked', async (w, iss) => {
      const { preds } = await consolidationWithLostAnswer(w, iss);
      await w.restart(true);
      await sleep(EXPIRY_WAIT_MS);
      const revBefore = iss.revCount();
      const rec = await w.recover();
      check('recovery reports needs-attention, not failed or completed', rec.length === 1 && rec[0].status === 'needs-attention', rec);
      const pend = await w.pending();
      check('the journal entry is still there, in state needs-attention, with both predecessors and the refusal recorded',
        pend.length === 1 && pend[0].state === 'needs-attention' && pend[0].predecessors.length === 2 && pend[0].predecessors.every((id) => preds.includes(id))
        && pend[0].attention && pend[0].attention.code === 'revoked' && pend[0].attention.status === 400, pend);
      check('the issuer shows both predecessors revoked and the wallet recorded them as revoked evidence', pend[0].attention && preds.every((id) => pend[0].attention.revokedPredecessors.includes(id)), pend[0].attention);
      const rows = await shown(w, IRON);
      check('both predecessors are still in the wallet, none shown as verified or valid, each marked as held by a transaction that needs attention',
        rows.length === 2 && rows.every((r) => r.status !== 'verified' && !r.valid && r.held === 'needs-attention'), rows);
      check('nothing was recreated: no new credential, no extra revocation', iss.revCount() === revBefore && sum(rows) === 40, { rows, revBefore, now: iss.revCount() });
      check('the activity log records that the operation needs attention', JSON.stringify(await w.log()).includes('needs attention'));

      await countRequests(w, '/atlas/');
      const rawBefore = JSON.stringify(await w.rawStores());
      const rec2 = await w.recover();
      check('a second recovery does not send the request again', rec2.length === 1 && rec2[0].status === 'needs-attention' && (await requestCount(w)) === 0, { rec2, requests: await requestCount(w) });
      check('and writes nothing', JSON.stringify(await w.rawStores()) === rawBefore);

      const creds = await credentialsOf(w, IRON);
      const refusal = (fn) => w.W(async ([name, c, pub, domain]) => {
        try {
          if (name === 'consolidate') await AtlasWallet.consolidateAsset('self', c);
          else if (name === 'split') await AtlasWallet.splitAsset('self', c[0], 5, 'self');
          else if (name === 'convert') await AtlasWallet.convertAsset('self', c[0], 5, 'atlas.element.gold');
          else if (name === 'drop') await AtlasWallet.dropItem(c[0], domain, 'lobby', [0, 0, 0]);
          else if (name === 'delete') await AtlasWallet.deleteAsset(pub, c[0].id);
          return 'allowed';
        } catch (e) { return { code: e.code, unresolved: !!e.unresolved, message: e.message }; }
      }, [fn, creds, w.pub, iss.domain]);
      const refused = {};
      for (const name of ['consolidate', 'split', 'convert', 'drop', 'delete']) refused[name] = await refusal(name);
      check('consolidate, split, convert, drop and delete of a predecessor are all refused as unresolved',
        Object.values(refused).every((r) => r && r.code === 'unresolved-operation' && r.unresolved), refused);
      check('the refusals sent nothing and wrote nothing', (await requestCount(w)) === 0 && JSON.stringify(await w.rawStores()) === rawBefore, { requests: await requestCount(w) });

      const auto = await w.W((k) => AtlasWallet.autoConsolidateAssetWallet(k), w.pub);
      check('automatic consolidation leaves the held-back balances alone and sends nothing', auto.merged === 0 && auto.failed.length === 0 && (await requestCount(w)) === 0, auto);

      check('an unrelated mint (Gold) still works', (await mint(w, iss, GOLD, 10)) === 'ok');
      check('a new Iron mint still works and is held separately from the predecessors', (await mint(w, iss, IRON, 20)) === 'ok');
      const after = await shown(w, IRON);
      check('the wallet shows the new 20 g as an ordinary credential next to the two held-back ones',
        after.length === 3 && after.filter((r) => r.held === null).length === 1 && after.filter((r) => r.held === 'needs-attention').length === 2, after);
      check('the entry is untouched by the new work', (await w.pending()).length === 1 && (await w.pending())[0].state === 'needs-attention');

      const [a, b] = await Promise.all([
        w.W((a) => AtlasWallet.retryPendingOperation(a.k, a.r), { k: w.pub, r: pend[0].requestId }),
        w.W((a) => AtlasWallet.retryPendingOperation(a.k, a.r), { k: w.pub, r: pend[0].requestId })
      ]);
      check('two simultaneous manual retries both end needs-attention and leave exactly one entry', a.status === 'needs-attention' && b.status === 'needs-attention' && (await w.pending()).length === 1, { a, b });

      await w.restart(true);
      const survived = await w.pending();
      check('the entry survives another browser restart in the same state', survived.length === 1 && survived[0].state === 'needs-attention' && survived[0].requestId === pend[0].requestId, survived);
      await w.W(() => AtlasWallet.reverifyAll());
      const reverified = (await shown(w, IRON)).filter((r) => preds.includes(r.id));
      check('re-verify does not release them: still not valid, still marked', reverified.length === 2 && reverified.every((r) => !r.valid && r.held === 'needs-attention'), reverified);
      check('the journal is still there after re-verify', (await w.pending()).length === 1);
      info('the 40 g successor still exists only in the issuer\'s expired answer; nothing in the wallet or the revocation list can recreate it');
    }, TTL_ENV);

    // ---- E2: offline for longer than the retention ----
    await scenario(kind, 'E2 issuer unreachable at first, reachable only after the retention has passed', async (w, iss) => {
      const { preds } = await consolidationWithLostAnswer(w, iss);
      await w.restart(true);
      await w.inject('failFetch', '/atlas/asset/consolidate');
      const first = await w.recover();
      check('while offline the entry stays pending and is counted', first.length === 1 && first[0].status === 'pending' && (await w.pending())[0].attempts >= 1 && (await w.pending())[0].state === 'pending', first);
      const rowsPending = await shown(w, IRON);
      check('while pending, the predecessors are already held back and not shown as verified', rowsPending.every((r) => r.held === 'pending' && r.status !== 'verified'), rowsPending);
      await w.clearFault();
      await w.restart(true);
      await sleep(EXPIRY_WAIT_MS);
      const second = await w.recover();
      check('after the retention passed, the recovery ends in needs-attention with the entry kept', second.length === 1 && second[0].status === 'needs-attention' && (await w.pending()).length === 1, second);
      check('the predecessors stay in the wallet and held back', (await shown(w, IRON)).length === 2 && (await shown(w, IRON)).every((r) => r.held === 'needs-attention'));
      check('nothing was spent twice', preds.every((id) => iss.revoked().has(id)) && iss.revCount() === 2, iss.revCount());
    }, TTL_ENV);

    // ---- E3: a definite refusal still ends the entry ----
    await scenario(kind, 'E3 a refusal is still definite when the predecessors are provably unrevoked', async (w, iss) => {
      check('setup: 40 Iron', (await mint(w, iss, IRON, 40)) === 'ok');
      const [cred] = await credentialsOf(w, IRON);
      const fresh = await CONVERT_BOGUS(w, cred);
      check('a fresh request refused by the issuer ends at once: nothing pending', fresh && fresh.pending === false && (await w.pending()).length === 0, fresh);
      check('and the balance stays an ordinary credential', (await shown(w, IRON)).every((r) => r.held === null && r.valid));

      await w.inject('failFetch', '/atlas/convert');
      const interrupted = await CONVERT_BOGUS(w, cred);
      await w.clearFault();
      check('an interrupted request stays pending', interrupted && interrupted.pending === true && (await w.pending()).length === 1, interrupted);
      const rec = await w.recover();
      check('when the retry is refused and the predecessor is shown unrevoked, the entry ends as failed and the journal is empty',
        rec.length === 1 && rec[0].status === 'failed' && (await w.pending()).length === 0, rec);
      check('the predecessor is an ordinary valid credential again', (await shown(w, IRON)).every((r) => r.held === null && r.valid));

      await w.inject('failFetch', '/atlas/convert');
      await CONVERT_BOGUS(w, cred);
      await w.clearFault();
      await fakeAnswer(w, '/atlas/convert', 'status403', 1);
      const rec2 = await w.recover();
      await unfake(w);
      check('a retry answered by a non-issuer HTML page with the predecessor unrevoked also ends the entry', rec2.length === 1 && rec2[0].status === 'failed' && (await w.pending()).length === 0, rec2);
      check('the 40 g balance was never revoked', !iss.revoked().has(cred.id));
    }, TTL_ENV);

    // ---- E4: the revocation list cannot be read ----
    await scenario(kind, 'E4 refusal on retry while the revocation list cannot be read', async (w, iss) => {
      check('setup: 40 Iron', (await mint(w, iss, IRON, 40)) === 'ok');
      const [cred] = await credentialsOf(w, IRON);
      await w.inject('failFetch', '/atlas/convert');
      await CONVERT_BOGUS(w, cred);
      await w.clearFault();
      await fakeAnswer(w, 'atlas-revocations', 'revocations', 1000);
      const rec = await w.recover();
      check('without evidence that nothing was committed, the refusal keeps the entry as needs-attention', rec.length === 1 && rec[0].status === 'needs-attention' && (await w.pending())[0].state === 'needs-attention', rec);
      await unfake(w);
      const retried = await w.W((a) => AtlasWallet.retryPendingOperation(a.k, a.r), { k: w.pub, r: (await w.pending())[0].requestId });
      check('a manual retry once the list can be read shows the predecessor unrevoked and ends the entry', retried.status === 'failed' && (await w.pending()).length === 0, retried);
      check('the predecessor is an ordinary valid credential again', (await shown(w, IRON)).every((r) => r.held === null && r.valid));
    }, TTL_ENV);

    // ---- E4b: one predecessor spent elsewhere ----
    await scenario(kind, 'E4b a refusal is definite when one predecessor was spent by another request', async (w, iss) => {
      check('setup: first mint of 20 Iron', (await mint(w, iss, IRON, 20)) === 'ok');
      await w.inject('failFetch', '/atlas/asset/consolidate');
      const second = await mint(w, iss, IRON, 20);
      await w.clearFault();
      check('the consolidation is pending', (await w.pending()).length === 1 && (await w.pending())[0].state === 'pending', second);
      const [a, b] = await credentialsOf(w, IRON);
      const spent = await iss.api.post('/atlas/asset/split', { credential: a, sendAmount: 1, toPublicKey: w.pub, requestId: crypto.randomBytes(18).toString('base64url') });
      check('another request spends one predecessor at the issuer', spent.status === 200, spent.status);
      const rec = await w.recover();
      check('the retry is refused as revoked, but the other predecessor is not revoked, so nothing was committed: the entry ends as failed',
        rec.length === 1 && rec[0].status === 'failed' && (await w.pending()).length === 0, rec);
      check('the unrevoked predecessor is an ordinary valid credential, not held back', (await shown(w, IRON)).filter((r) => r.id === b.id).every((r) => r.held === null && r.valid));
      const auto = await w.W((k) => AtlasWallet.autoConsolidateAssetWallet(k), w.pub);
      check('the spent predecessor is then flagged by the next consolidation, as before', auto.spent >= 1, auto);
    }, TTL_ENV);

    // ---- E5: answers that cannot be used ----
    await scenario(kind, 'E5 malformed or wrong 200 answers never end the entry and are never applied', async (w, iss) => {
      let expected = 20;
      check('setup: first mint of 20 Iron', (await mint(w, iss, IRON, 20)) === 'ok');
      for (const mode of ['html', 'truncated', 'empty', 'array', 'wrongowner']) {
        await fakeAnswer(w, '/atlas/asset/consolidate', mode, 1);
        const before = iss.revCount();
        await mint(w, iss, IRON, 20);
        await unfake(w);
        expected += 20;
        const pend = await w.pending();
        const rows = await shown(w, IRON);
        check(`${mode}: the entry is kept pending with the attempt counted, nothing applied (rows ${rows.length})`,
          pend.length === 1 && pend[0].state === 'pending' && pend[0].attempts === 1 && /not a usable|could not be used/.test(pend[0].lastError || '') && rows.length === 2 && rows.every((r) => r.held === 'pending'), { pend, rows });
        const rec = await w.recover();
        const live = await shown(w, IRON);
        check(`${mode}: the next recovery completes it exactly once (one ${expected} g credential, journal empty)`,
          rec.length === 1 && rec[0].status === 'completed' && rec[0].applied === true && live.length === 1 && live[0].q === expected && live[0].held === null && (await w.pending()).length === 0, { rec, live });
        check(`${mode}: only the two predecessors were revoked in this round`, iss.revCount() === before + 2, { before, now: iss.revCount() });
      }
    });

    // ---- E6: a mint that may already have been signed ----
    await scenario(kind, 'E6 a fungible mint refused on retry is kept for attention', async (w, iss) => {
      await w.inject('failFetch', '/atlas/asset/issue');
      const first = await mint(w, iss, IRON, 20);
      await w.clearFault();
      check('the interrupted mint stays pending', first && first.pending === true && (await w.pending()).length === 1, first);
      await fakeAnswer(w, '/atlas/asset/issue', 'cap', 1);
      const rec = await w.recover();
      await unfake(w);
      check('a refusal of a mint that may have reached the issuer before cannot be shown to be pre-commit, so it needs attention',
        rec.length === 1 && rec[0].status === 'needs-attention' && (await w.pending())[0].state === 'needs-attention' && (await w.pending())[0].attention.code === 'cap', rec);
      check('nothing was added to the wallet', (await shown(w, IRON)).length === 0);
      check('the next mint is not blocked by the entry', (await mint(w, iss, IRON, 20)) === 'ok' && sum(await shown(w, IRON)) === 20);
    });

    // ---- E7: corrupted journal ----
    await scenario(kind, 'E7 damaged journal state', async (w, iss) => {
      await w.W(([k]) => chrome.storage.local.set({ atlasPendingOps: { [k]: [null, 7, { requestId: 'junk-without-fields' }] } }), [w.pub]);
      const { preds } = await consolidationWithLostAnswer(w, iss);
      const listed = await w.pending();
      check('unusable entries are kept next to the real one and reported as unreadable', listed.filter((e) => e.state === 'unreadable').length >= 1 && listed.filter((e) => e.kind === 'consolidate').length === 1, listed);
      await w.restart(true);
      const rec = await w.recover();
      const done = rec.filter((r) => r.kind === 'consolidate');
      check('recovery completes the real entry despite the damaged ones', done.length === 1 && done[0].status === 'completed' && done[0].applied === true, rec);
      check('the damaged entries are reported as needing attention, never sent and never dropped', rec.filter((r) => r.status === 'needs-attention').length >= 1 && (await w.pending()).filter((e) => e.state === 'unreadable').length >= 1, rec);
      const live = await shown(w, IRON);
      check('one 40 g credential, the predecessors are gone', live.length === 1 && live[0].q === 40 && preds.every((id) => !live.some((r) => r.id === id)), live);

      // an undecryptable journal blocks everything that would send or spend, and is never overwritten
      await w.inject('failFetch', '/atlas/asset/consolidate');
      await mint(w, iss, IRON, 20).catch(() => null);
      await w.clearFault();
      const pendingBlob = (await w.rawStores()).atlasPendingOps;
      const tampered = JSON.parse(JSON.stringify(pendingBlob));
      const slot = tampered[w.pub];
      check('setup: the journal is stored encrypted', slot && slot.__atlasEncrypted === true, typeof slot);
      slot.ciphertext = slot.ciphertext.slice(0, -6) + (slot.ciphertext.endsWith('AAAAAA') ? 'BBBBBB' : 'AAAAAA');
      await w.W((v) => chrome.storage.local.set({ atlasPendingOps: v }), tampered);
      await countRequests(w, '/atlas/');
      const before = JSON.stringify(await w.rawStores());
      const creds = await credentialsOf(w, IRON);
      const attempts = await w.W(async ([c, d, pub]) => ({
        mint: await AtlasWallet.mintAsset('self', d, 'atlas.element.iron', 20).then(() => 'ok', (e) => e.code || e.message),
        drop: await AtlasWallet.dropItem(c[0], d, 'lobby', [0, 0, 0]).then(() => 'ok', (e) => e.code || e.message),
        remove: await AtlasWallet.deleteAsset(pub, c[0].id).then(() => 'ok', (e) => e.code || e.message)
      }), [creds, iss.domain, w.pub]);
      check('mint, drop and delete are refused with the journal unreadable', Object.values(attempts).every((v) => v === 'wallet-unreadable'), attempts);
      check('nothing was sent to the issuer (beyond reads) and nothing was written', JSON.stringify(await w.rawStores()) === before, { requests: await requestCount(w) });
      await w.W((v) => chrome.storage.local.set({ atlasPendingOps: v }), pendingBlob);
      const rec2 = await w.recover();
      check('putting the stored journal back lets the pending mint-triggered consolidation finish', rec2.every((r) => r.status === 'completed' || r.status === 'needs-attention') && (await w.pending()).filter((e) => e.state === 'pending').length === 0, rec2);
    });
  }
}

main().then(() => {
  console.log('\nreplay expiry: ' + passes + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(2); });
