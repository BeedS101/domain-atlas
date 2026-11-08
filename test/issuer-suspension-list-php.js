// The PHP issuer's suspension list: created whole for a new issuer, and never guessed at for an existing one.
//
//   node test/issuer-suspension-list-php.js
//
// Fresh issuer: the first request publishes a valid empty list, atomically, once, however many requests arrive together.
// Existing issuer: a list that is missing is "nothing suspended yet"; a list that is zero-length, truncated or not a list
// is state the issuer cannot read, so it refuses (503) and leaves the file exactly as found. A zero-length file looks the
// same whether it is old debris or a truncated write, so the issuer never decides which; the operator does.
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { startIssuer } = require('./lib/php-issuer');
const { newOwner, signSpend } = require('./lib/owner-auth');

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('ok   ' + name); } catch (err) { failed++; console.log('FAIL ' + name + '\n     ' + (err && err.message)); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wk = (issuer, name) => path.join(issuer.dir, '.well-known', name);
const listOf = (issuer) => wk(issuer, 'atlas-suspensions.json');
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const EMPTY = { suspended: [] };
const owner = newOwner();

const coin = (issuer) => issuer.issue(owner, 'atlas.element.iron', 5);
const present = (issuer, credential) => issuer.post('/atlas/asset/split', signSpend('/atlas/asset/split', { credential, sendAmount: 1, toPublicKey: newOwner() }));
const adminSuspend = (issuer, id, extra) => issuer.admin('/atlas/suspend', Object.assign({ id, reason: 'hold' }, extra || {}));
const adminUnsuspend = (issuer, id) => issuer.admin('/atlas/unsuspend', { id });
const adminList = (issuer) => issuer.admin('/atlas/admin/suspensions', {});
const stamp = (file) => { const s = fs.statSync(file); return { size: s.size, mtimeMs: s.mtimeMs, ino: s.ino, sha: sha(file) }; };
const siblings = (issuer) => fs.readdirSync(path.join(issuer.dir, '.well-known')).filter((n) => n.startsWith('atlas-suspensions.json') && n !== 'atlas-suspensions.json');

// Polls a published file until stop() is called and reports every response that was neither "not there yet" nor the whole
// expected document: a zero-length or partial list must never be visible.
function watch(issuer, name, isWhole) {
  const bad = [];
  let running = true;
  const done = (async () => {
    while (running) {
      const r = await issuer.published(name);
      if (r.status !== 404 && !(r.status === 200 && isWhole(r.text))) bad.push({ status: r.status, text: r.text.slice(0, 60) });
    }
  })();
  return { bad, stop: async () => { running = false; await done; } };
}
// Same, reading the file on disk. Used where the list is replaced while being watched: PHP's built-in test server takes
// Content-Length from a stat of the path and then opens the path again, so an atomic replace between the two can hand a
// reader a body cut to the old length. Apache and nginx open the file first. The file itself is what must never be partial.
function watchDisk(file, isWhole) {
  const bad = [];
  let running = true;
  const done = (async () => {
    while (running) {
      let text = null;
      try { text = fs.readFileSync(file, 'utf8'); } catch (e) { text = null; }
      if (text !== null && !isWhole(text)) bad.push({ length: text.length, text: text.slice(0, 60) });
      await new Promise((r) => setImmediate(r));
    }
  })();
  return { bad, stop: async () => { running = false; await done; } };
}
const wholeEmpty = (text) => { try { return JSON.stringify(JSON.parse(text)) === JSON.stringify(EMPTY); } catch (e) { return false; } };
const wholeList = (text) => { try { return Array.isArray(JSON.parse(text).suspended); } catch (e) { return false; } };
const wholeRevocations = (text) => { try { return JSON.stringify(JSON.parse(text)) === JSON.stringify({ revoked: [] }); } catch (e) { return false; } };

(async () => {
  // ---------------------------------------------------------------------------------------------- fresh issuer
  console.log('\n== a brand-new issuer');
  const issuer = await startIssuer();
  try {
    await check('before any request nothing is published', async () => {
      assert.strictEqual((await issuer.published('atlas-suspensions.json')).status, 404);
      assert.strictEqual((await issuer.published('atlas-revocations.json')).status, 404);
    });
    const first = await issuer.issue(owner, 'atlas.element.iron', 10);
    await check('the first request creates the key document, an empty revocation list and an empty suspension list', async () => {
      assert.strictEqual((await issuer.published('atlas-key.json')).status, 200);
      assert.deepStrictEqual(JSON.parse((await issuer.published('atlas-revocations.json')).text), { revoked: [] });
      const sus = await issuer.published('atlas-suspensions.json');
      assert.strictEqual(sus.status, 200);
      assert.deepStrictEqual(JSON.parse(sus.text), EMPTY);
      assert.deepStrictEqual(siblings(issuer), [], 'no temporary file is left behind');
    });
    await check('the suspension list is not rewritten by later requests', async () => {
      const before = stamp(listOf(issuer));
      await sleep(1100);
      await issuer.issue(owner, 'atlas.badge');
      const sent = await issuer.split(first, 3, newOwner());
      assert.ok(sent.sent && sent.remainder);
      assert.deepStrictEqual(stamp(listOf(issuer)), before);
    });
    await check('the list has the same mode as the revocation list', async () => {
      const mode = (f) => fs.statSync(wk(issuer, f)).mode & 0o777;
      assert.strictEqual(mode('atlas-suspensions.json'), mode('atlas-revocations.json'));
    });
    await check('suspend and unsuspend work on the published list, and a suspended credential cannot be spent', async () => {
      const badge = await coin(issuer);
      assert.strictEqual((await adminSuspend(issuer, badge.id)).status, 200);
      assert.deepStrictEqual(JSON.parse((await issuer.published('atlas-suspensions.json')).text).suspended.map((s) => s.id), [badge.id]);
      assert.notStrictEqual((await present(issuer, badge)).status, 200);
      assert.strictEqual((await adminUnsuspend(issuer, badge.id)).status, 200);
      assert.deepStrictEqual(JSON.parse((await issuer.published('atlas-suspensions.json')).text), EMPTY);
      assert.strictEqual((await present(issuer, badge)).status, 200);
    });
  } finally {
    await issuer.stop();
  }

  await check('requests that arrive together create one valid list and one key; a watcher never sees a zero-length or partial file', async () => {
    for (let round = 0; round < 4; round++) {
      const fresh = await startIssuer({ workers: 8 });
      try {
        const susWatch = watch(fresh, 'atlas-suspensions.json', wholeEmpty);
        const revWatch = watch(fresh, 'atlas-revocations.json', wholeRevocations);
        const results = await Promise.all(Array.from({ length: 16 }, () => fresh.post('/atlas/asset/issue', { ownerPublicKey: owner, assetClass: 'atlas.badge' })));
        await susWatch.stop(); await revWatch.stop();
        assert.deepStrictEqual(results.map((r) => r.status), results.map(() => 200), 'round ' + round + ': ' + results.map((r) => r.status).join(','));
        assert.deepStrictEqual(susWatch.bad, [], 'round ' + round + ': suspension list observed in a bad state');
        assert.deepStrictEqual(revWatch.bad, [], 'round ' + round + ': revocation list observed in a bad state');
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(listOf(fresh), 'utf8')), EMPTY);
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(wk(fresh, 'atlas-revocations.json'), 'utf8')), { revoked: [] });
        assert.strictEqual(JSON.parse((await fresh.published('atlas-key.json')).text).keys.length, 1, 'one issuer key');
        assert.deepStrictEqual(siblings(fresh), []);
        const ids = new Set(results.map((r) => r.body.issuer && r.body.issuer.publicKey));
        assert.strictEqual(ids.size, 1, 'every credential names the same key');
      } finally { await fresh.stop(); }
    }
  });

  await check('the first suspension on an issuer with no list creates it whole: parallel suspensions all land, and no zero-length file is ever visible', async () => {
    const legacy = await startIssuer({ workers: 8 });
    try {
      const coins = [];
      for (let i = 0; i < 12; i++) coins.push(await coin(legacy));
      fs.rmSync(listOf(legacy));
      const watcher = watchDisk(listOf(legacy), wholeList);
      const res = await Promise.all(coins.map((c) => adminSuspend(legacy, c.id)));
      await watcher.stop();
      assert.deepStrictEqual(res.map((r) => r.status), res.map(() => 200));
      const ids = JSON.parse(fs.readFileSync(listOf(legacy), 'utf8')).suspended.map((s) => s.id).sort();
      assert.deepStrictEqual(ids, coins.map((c) => c.id).sort(), 'no suspension was lost');
      assert.deepStrictEqual(siblings(legacy), []);
      assert.deepStrictEqual(watcher.bad, [], 'a zero-length or partial list was published: ' + JSON.stringify(watcher.bad.slice(0, 3)));
    } finally { await legacy.stop(); }
  });

  await check('a crash while the suspension list is being created leaves no zero-length or partial file, and the issuer still starts', async () => {
    const crashing = await startIssuer({ env: { ATLAS_TEST_CRASH_AT: 'suspensions:init-tmp-written' } });
    try {
      const died = await crashing.post('/atlas/asset/issue', { ownerPublicKey: owner, assetClass: 'atlas.badge' });
      assert.strictEqual(died.text, '', 'the request stopped at the fault point without an answer');
      assert.strictEqual(fs.existsSync(listOf(crashing)), false, 'the list must not exist half-written');
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(wk(crashing, 'atlas-revocations.json'), 'utf8')), { revoked: [] });
      const next = await crashing.post('/atlas/asset/issue', { ownerPublicKey: owner, assetClass: 'atlas.badge' });
      assert.strictEqual(next.status, 200, next.text.slice(0, 200));
      assert.ok(next.body && next.body.id, 'the next request completes the start-up');
      assert.strictEqual(fs.existsSync(listOf(crashing)), false, 'without a list the issuer behaves as before this change: 404 until the first suspension');
      assert.strictEqual((await crashing.published('atlas-suspensions.json')).status, 404);
    } finally { await crashing.stop(); }
  });

  await check('an admin read before the issuer has a key creates nothing and does not block the first issue', async () => {
    const adminFirst = await startIssuer();
    try {
      const read = await adminList(adminFirst);
      assert.strictEqual(read.status, 200, read.text.slice(0, 200));
      assert.deepStrictEqual(read.body.suspended, []);
      assert.strictEqual(fs.existsSync(listOf(adminFirst)), false, 'a read must not create the list');
      const res = await adminFirst.post('/atlas/asset/issue', { ownerPublicKey: owner, assetClass: 'atlas.badge' });
      assert.strictEqual(res.status, 200, res.text.slice(0, 200));
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(listOf(adminFirst), 'utf8')), EMPTY, 'the first issue then creates the list whole');
    } finally { await adminFirst.stop(); }
  });

  // ---------------------------------------------------------------------------------- copies that already hold state
  console.log('\n== state that already exists is never replaced');
  const established = await startIssuer({
    prepare: (bundle) => fs.writeFileSync(path.join(bundle, 'lib', 'atlas-subscribers-store.json'), JSON.stringify({ subscribers: [{ credentialId: 'urn:atlas:asset:existing' }] }))
  });
  try {
    await check('with existing issuer state and no key, nothing is created and requests are refused', async () => {
      const res = await established.post('/atlas/asset/issue', { ownerPublicKey: owner, assetClass: 'atlas.badge' });
      assert.strictEqual(res.status, 503, res.text.slice(0, 200));
      assert.strictEqual(fs.existsSync(wk(established, 'atlas-revocations.json')), false);
      assert.strictEqual(fs.existsSync(listOf(established)), false);
    });
  } finally { await established.stop(); }

  for (const [label, text] of [
    ['an empty suspension list that is already published', '{"suspended": []}'],
    ['a suspension list with entries', JSON.stringify({ suspended: [{ id: 'urn:atlas:asset:kept', reason: 'kept', expiresAt: null }] })]
  ]) {
    const leftover = await startIssuer({
      prepare: (bundle) => { fs.mkdirSync(path.join(bundle, '.well-known'), { recursive: true }); fs.writeFileSync(path.join(bundle, '.well-known', 'atlas-suspensions.json'), text); }
    });
    try {
      await check(label + ' marks a copy that lost its key as established: no new identity, file untouched', async () => {
        const res = await leftover.post('/atlas/asset/issue', { ownerPublicKey: owner, assetClass: 'atlas.badge' });
        assert.strictEqual(res.status, 503, res.text.slice(0, 200));
        assert.strictEqual(fs.existsSync(wk(leftover, 'atlas-revocations.json')), false);
        assert.strictEqual(fs.readFileSync(listOf(leftover), 'utf8'), text);
      });
    } finally { await leftover.stop(); }
  }

  await check('a zero-length list that is already in place when a new issuer starts is not replaced: the issuer refuses to enforce, the file is untouched', async () => {
    const stale = await startIssuer({ prepare: (bundle) => { fs.mkdirSync(path.join(bundle, '.well-known'), { recursive: true }); fs.writeFileSync(path.join(bundle, '.well-known', 'atlas-suspensions.json'), ''); } });
    try {
      const before = stamp(listOf(stale));
      const minted = await stale.post('/atlas/asset/issue', { ownerPublicKey: owner, assetClass: 'atlas.element.iron', quantity: 5 });
      assert.strictEqual(minted.status, 200, minted.text.slice(0, 200));
      assert.deepStrictEqual(stamp(listOf(stale)), before);
      const spend = await present(stale, minted.body);
      assert.strictEqual(spend.status, 503, spend.text.slice(0, 200));
      assert.deepStrictEqual(stamp(listOf(stale)), before);
    } finally { await stale.stop(); }
  });

  // ------------------------------------------------------------------------------- existing issuer, list not usable
  console.log('\n== an existing issuer whose list is missing or unreadable');
  const older = await startIssuer({ workers: 8 });
  try {
    await older.issue(owner, 'atlas.badge');
    const list = listOf(older);

    await check('a missing list means nothing has been suspended: spending works and reading creates no file', async () => {
      fs.rmSync(list);
      assert.strictEqual((await present(older, await coin(older))).status, 200);
      assert.strictEqual((await adminList(older)).body.total, 0);
      assert.strictEqual((await adminUnsuspend(older, 'urn:atlas:asset:none')).status, 200);
      assert.strictEqual(fs.existsSync(list), false, 'neither a spend nor an admin read nor an unsuspend may create the list');
      assert.strictEqual((await older.published('atlas-suspensions.json')).status, 404);
    });
    await check('the first suspension on an issuer without a list creates a valid one', async () => {
      const c = await coin(older);
      assert.strictEqual((await adminSuspend(older, c.id)).status, 200);
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(list, 'utf8')).suspended.map((s) => s.id), [c.id]);
      assert.strictEqual((await adminUnsuspend(older, c.id)).status, 200);
    });

    const unreadable = [
      ['zero-length (old debris or a truncated write: indistinguishable)', ''],
      ['truncated in the middle of an entry', '{"suspended": [{"id": "urn:atlas:asset:a", "reaso'],
      ['not JSON at all', 'not json'],
      ['whitespace only', ' \n'],
      ['valid JSON that is not a suspension list', '{}'],
      ['a list under the wrong key', '{"revoked": []}'],
      ['"suspended" is not a list', '{"suspended": "none"}'],
      ['a bare array', '[]']
    ];
    for (const [label, text] of unreadable) {
      await check('list is ' + label + ': every operation that depends on it is refused (503) and the file is left exactly as found', async () => {
        fs.writeFileSync(list, text);
        const before = stamp(list);
        await sleep(1100);
        const target = await coin(older);
        const outcomes = {
          spend: await present(older, target),
          suspend: await adminSuspend(older, target.id),
          unsuspend: await adminUnsuspend(older, target.id),
          adminList: await adminList(older)
        };
        for (const [op, r] of Object.entries(outcomes)) assert.strictEqual(r.status, 503, op + ' answered ' + r.status + ' ' + r.text.slice(0, 200));
        assert.ok(/suspension list/.test(outcomes.spend.text), 'the refusal names the list: ' + outcomes.spend.text.slice(0, 200));
        assert.deepStrictEqual(stamp(list), before, 'the file must be byte-for-byte and mtime unchanged');
        assert.deepStrictEqual(siblings(older), [], 'no copy, temporary or backup file is written next to it');
        const published = await older.published('atlas-suspensions.json');
        assert.strictEqual(published.text, text, 'what is published is exactly what is on disk, so a verifier sees an unreadable document and fails closed');
      });
    }

    await check('requests arriving together against a zero-length list are all refused and none changes it', async () => {
      fs.writeFileSync(list, '');
      const target = await coin(older);
      const before = stamp(list);
      const calls = [];
      for (let i = 0; i < 6; i++) calls.push(present(older, target), adminSuspend(older, target.id), adminUnsuspend(older, target.id), adminList(older));
      const results = await Promise.all(calls);
      assert.deepStrictEqual(results.map((r) => r.status), results.map(() => 503));
      assert.deepStrictEqual(stamp(list), before);
    });

    await check('issuing a new credential still works while the list is unreadable (the list is only consulted when one is presented)', async () => {
      fs.writeFileSync(list, '');
      const res = await older.post('/atlas/asset/issue', { ownerPublicKey: owner, assetClass: 'atlas.badge' });
      assert.strictEqual(res.status, 200, res.text.slice(0, 200));
      assert.strictEqual(fs.statSync(list).size, 0);
    });

    await check('the operator authorises initialisation by replacing the file: service resumes at once', async () => {
      fs.writeFileSync(list, '');
      assert.strictEqual((await present(older, await coin(older))).status, 503);
      fs.writeFileSync(list, '{"suspended": []}');
      assert.strictEqual((await present(older, await coin(older))).status, 200);
      assert.strictEqual((await adminList(older)).status, 200);
    });
    await check('restoring a backup that holds suspensions enforces them again', async () => {
      const held = await coin(older);
      fs.writeFileSync(list, '');
      fs.writeFileSync(list, JSON.stringify({ suspended: [{ id: held.id, suspendedAt: '2026-01-01T00:00:00Z', reason: 'restored', expiresAt: null, onExpire: 'lift' }] }));
      const refused = await present(older, held);
      assert.notStrictEqual(refused.status, 200);
      assert.notStrictEqual(refused.status, 503, 'a readable list is enforced, not refused as unreadable');
      assert.strictEqual((await adminList(older)).body.total, 1);
      fs.writeFileSync(list, '{"suspended": []}');
    });
  } finally { await older.stop(); }

  // -------------------------------------------------------------------------------------- a readable list is still managed
  console.log('\n== a readable list behaves as before');
  const live = await startIssuer({ workers: 8 });
  try {
    await live.issue(owner, 'atlas.badge');
    const list = listOf(live);
    await check('a list that holds entries is not rewritten by a presentation check', async () => {
      const text = JSON.stringify({ suspended: [{ id: 'urn:atlas:asset:other', reason: 'hold', expiresAt: null }] }, null, 2);
      fs.writeFileSync(list, text);
      const before = stamp(list);
      await sleep(1100);
      assert.strictEqual((await present(live, await coin(live))).status, 200);
      assert.deepStrictEqual(stamp(list), before);
    });
    await check('odd entries (no id, wrong type) are tolerated and kept, as the admin screen already expects', async () => {
      const text = JSON.stringify({ suspended: [{ id: 12345 }, 'nope', { reason: 'no id' }] });
      fs.writeFileSync(list, text);
      assert.strictEqual((await present(live, await coin(live))).status, 200);
      assert.strictEqual(fs.readFileSync(list, 'utf8'), text);
    });
    await check('an expired lift entry is pruned and an expired finalize entry still revokes', async () => {
      const keep = await coin(live); const redeem = await coin(live); const lift = await coin(live);
      const past = new Date(Date.now() - 60000).toISOString();
      fs.writeFileSync(list, JSON.stringify({ suspended: [
        { id: lift.id, reason: 'x', expiresAt: past, onExpire: 'lift' },
        { id: redeem.id, reason: 'x', expiresAt: past, onExpire: 'finalize' }
      ] }));
      assert.strictEqual((await present(live, keep)).status, 200);
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(list, 'utf8')), EMPTY);
      const revoked = JSON.parse((await live.published('atlas-revocations.json')).text).revoked;
      assert.ok(revoked.some((r) => r.id === redeem.id), 'finalize must revoke');
      assert.ok(!revoked.some((r) => r.id === lift.id), 'lift must not revoke');
    });
    await check('parallel suspensions and unsuspensions on a readable list lose nothing', async () => {
      fs.writeFileSync(list, '{"suspended": []}');
      const coins = [];
      for (let i = 0; i < 12; i++) coins.push(await coin(live));
      const watcher = watchDisk(list, wholeList);
      const first = await Promise.all(coins.map((c) => adminSuspend(live, c.id)));
      assert.deepStrictEqual(first.map((r) => r.status), first.map(() => 200));
      assert.strictEqual(JSON.parse(fs.readFileSync(list, 'utf8')).suspended.length, 12);
      const lifted = await Promise.all(coins.slice(0, 6).map((c) => adminUnsuspend(live, c.id)));
      assert.deepStrictEqual(lifted.map((r) => r.status), lifted.map(() => 200));
      await watcher.stop();
      assert.deepStrictEqual(watcher.bad, [], 'while suspensions were written the list on disk was never zero-length or partial');
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(list, 'utf8')).suspended.map((s) => s.id).sort(), coins.slice(6).map((c) => c.id).sort());
      assert.deepStrictEqual(siblings(live), [], 'no temporary file is left behind');
    });
  } finally { await live.stop(); }

  await check('a crash while a suspension is being written leaves the previous list exactly as it was', async () => {
    const dying = await startIssuer({ env: { ATLAS_TEST_CRASH_AT: 'suspensions:write-tmp-written' } });
    try {
      const held = await coin(dying);
      const text = JSON.stringify({ suspended: [{ id: 'urn:atlas:asset:earlier', suspendedAt: '2026-01-01T00:00:00Z', reason: 'earlier', expiresAt: null, onExpire: 'lift' }] }, null, 2);
      fs.writeFileSync(listOf(dying), text);
      const before = stamp(listOf(dying));
      await sleep(1100);
      const died = await adminSuspend(dying, held.id);
      assert.strictEqual(died.text, '', 'the request stopped at the fault point without an answer');
      assert.deepStrictEqual(stamp(listOf(dying)), before, 'the list is the old one, whole');
      assert.strictEqual((await dying.published('atlas-suspensions.json')).text, text);
      assert.strictEqual((await adminList(dying)).body.total, 1, 'and it is still readable');
    } finally { await dying.stop(); }
  });

  console.log(failed === 0 ? '\nAll issuer suspension list checks passed (PHP).' : '\n' + failed + ' check(s) FAILED');
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });
