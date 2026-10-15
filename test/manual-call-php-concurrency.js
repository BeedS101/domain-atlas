// The PHP Call Service under concurrent requests. Each request is its own PHP process, so
// requests that arrive together must still behave as if they had been handled one at a time:
// a signed request is spent once, a tag rings for one call, a sequence number is used once,
// and rate limits count exactly. PHP's built-in server runs 8 workers here.
// Requires `php` with the openssl and curl extensions on PATH.
// Run: node test/manual-call-php-concurrency.js
'use strict';
const fs = require('fs');
const path = require('path');
const T = require('./call-test-lib');
const L = require('./call-php-lib');
const { driveCall } = require('./call-flow-lib');
const { check, Wallet, post, base, nonce, sign, signalPayload, sendSignal, fp, P } = T;

const count = (list, fn) => list.filter(fn).length;

(async () => {
  const ctx = await L.startPhpService(null, {
    workers: 8,
    timers: { sweepMs: 200, listenerFreshMs: 6000, endedRetainMs: 800 },
    limits: { invitesPerSourcePerMin: 5000, perSourcePerMin: 5000, invitesPerCallerPerMin: 6, invitesPerCalleePerMin: 1000 }
  });

  // ---------- one signed request, many copies ----------
  {
    const bob = await Wallet.create(ctx, 'bob');
    const s = await bob.session();
    const payload = base('atlas.call.listen', ctx.origin, { nonce: nonce(), ack: [] });
    const msg = { payload, proof: await sign(payload, s.sk), session: s.delegation };
    const res = await Promise.all(Array.from({ length: 24 }, () => post(ctx.base, '/atlas/call/listen', msg)));
    check('24 copies of one signed request sent at once: exactly one is accepted', count(res, (r) => r.status === 200) === 1, res.map((r) => r.status));
    check('the other 23 are refused as replays', count(res, (r) => r.status === 401 && r.json.code === 'replayed-request') === 23, res.map((r) => r.status + ':' + (r.json && r.json.code)));
  }

  // ---------- one tag, many invites ----------
  {
    const alice = await Wallet.create(ctx, 'alice'), bob = await Wallet.create(ctx, 'bob');
    const tag = (await bob.createTag(alice.pub)).json;
    await bob.listen([]);
    const built = await Promise.all(Array.from({ length: 6 }, () => alice.buildInvite(tag.tag, bob.pub)));
    const res = await Promise.all(built.map((b) => alice.invite(b)));
    check('6 different invites on one tag at once: exactly one rings', count(res, (r) => r.status === 202) === 1, res.map((r) => r.status));
    check('the others are refused as unavailable, with the same reply as an unknown tag', count(res, (r) => r.status === 404 && r.json.code === 'unavailable') === 5, res.map((r) => r.status));
    const ringing = built.filter((b, i) => res[i].status === 202);
    const stats = await ctx.svc.stats();
    check('only the winner exists in the service', ringing.length === 1 && stats.liveCalls >= 1 && !!ctx.svc.call(ringing[0].callId));
    const losers = built.filter((b, i) => res[i].status !== 202);
    check('no call was created for any of the losing invites', losers.every((b) => ctx.svc.call(b.callId) === null));
    const mail = await bob.listen([]);
    check('the callee is told about the one call only', count(mail.json.events, (e) => e.type === 'invite') === 1, mail.json.events.map((e) => e.type));
  }

  // ---------- one sequence number, many messages ----------
  {
    const alice = await Wallet.create(ctx, 'alice'), bob = await Wallet.create(ctx, 'bob');
    const tag = (await bob.createTag(alice.pub)).json;
    const call = await driveCall(ctx, alice, bob, tag, 'accepted');
    const offers = await Promise.all(Array.from({ length: 10 }, (_, i) => sendSignal(ctx, signalPayload(ctx, call.callId, 'offer', { sdp: 'v=0\r\ns=copy' + i + '\r\na=fingerprint:' + fp('A') + '\r\n' }, 1, call.th), call.ckA)));
    check('10 different offers with the same sequence number at once: exactly one is accepted', count(offers, (r) => r.status === 202) === 1, offers.map((r) => r.status));
    const stored = ctx.svc.call(call.callId);
    check('the call holds one offer and stays consistent', stored && stored.state === 'NEGOTIATING' && count(stored.events || [], (e) => /offer/.test(JSON.stringify(e))) <= 1, stored && stored.state);
    const hops = await Promise.all(Array.from({ length: 6 }, () => sendSignal(ctx, signalPayload(ctx, call.callId, 'end', { reason: 'hangup' }, 2, call.th), call.ckA)));
    check('six hang-ups at once: exactly one is accepted', count(hops, (r) => r.status === 202) === 1, hops.map((r) => r.status));
    check('the call ends once', (await ctx.svc.callState(call.callId)) === 'ENDED');
  }

  // ---------- many different calls at once ----------
  {
    const pairs = await Promise.all(Array.from({ length: 12 }, async () => ({ a: await Wallet.create(ctx, 'a'), b: await Wallet.create(ctx, 'b') })));
    const tags = await Promise.all(pairs.map((p) => p.b.createTag(p.a.pub)));
    check('12 callees create their tags at once: all succeed', tags.every((t) => t.status === 200), tags.map((t) => t.status));
    check('every tag is different', new Set(tags.map((t) => t.json.tag)).size === 12);
    await Promise.all(pairs.map(async (p) => { p.b.sess = await p.b.session(1800000); await p.b.listen([]); }));
    const before = await ctx.svc.stats();
    const built = await Promise.all(pairs.map((p, i) => p.a.buildInvite(tags[i].json.tag, p.b.pub)));
    const res = await Promise.all(pairs.map((p, i) => p.a.invite(built[i])));
    check('12 callers invite at once: all 12 ring', res.every((r) => r.status === 202), res.map((r) => r.status));
    const after = await ctx.svc.stats();
    check('the service counts exactly 12 more live calls', after.liveCalls - before.liveCalls === 12, [before.liveCalls, after.liveCalls]);
    const mail = await Promise.all(pairs.map((p) => p.b.listen([])));
    check('each callee receives exactly its own invite', mail.every((m, i) => m.json.events.length === 1 && m.json.events[0].invite.payload.callId === built[i].callId), mail.map((m) => m.json.events.length));
    check('the service log shows no PHP errors', !/Fatal|Warning|Notice|Deprecated|Uncaught/i.test(ctx.svc.log()), ctx.svc.log().slice(-300));
  }

  // ---------- limits count exactly ----------
  {
    const carol = await Wallet.create(ctx, 'carol');
    const callees = await Promise.all(Array.from({ length: 16 }, () => Wallet.create(ctx, 'callee')));
    const tags = await Promise.all(callees.map((c) => c.createTag(carol.pub)));
    await Promise.all(callees.map(async (c) => { c.sess = await c.session(1800000); await c.listen([]); }));
    const built = await Promise.all(callees.map((c, i) => carol.buildInvite(tags[i].json.tag, c.pub)));
    const res = await Promise.all(built.map((b) => carol.invite(b)));
    check('16 invites from one caller at once against a limit of 6 a minute: exactly 6 are let through', count(res, (r) => r.status === 202) === 6, res.map((r) => r.status));
    check('the other 10 are rate limited', count(res, (r) => r.status === 429 && r.json.code === 'rate-limited') === 10, res.map((r) => r.status));
    const dave = await Wallet.create(ctx, 'dave');
    const tc = await Promise.all(Array.from({ length: 45 }, () => dave.createTag(carol.pub)));
    check('45 tag creations by one wallet at once against a limit of 30 a minute: exactly 30 succeed', count(tc, (r) => r.status === 200) === 30, tc.map((r) => r.status));
    check('the other 15 are rate limited', count(tc, (r) => r.status === 429) === 15);
    const listed = await dave.listTags();
    check('the wallet lists exactly the 30 tags it was given', listed.status === 200 && listed.json.tags.length === 30, listed.json && listed.json.tags && listed.json.tags.length);
    check('the tag count the service keeps matches the tags on disk', (() => {
      const meta = JSON.parse(fs.readFileSync(path.join(ctx.svc.stateDir, 'meta.json'), 'utf8'));
      let n = 0;
      const root = path.join(ctx.svc.stateDir, 'tags');
      for (const d of fs.readdirSync(root)) { const p = path.join(root, d); if (fs.statSync(p).isDirectory()) n += fs.readdirSync(p).filter((f) => f.endsWith('.json')).length; }
      return meta.tags === n;
    })());
  }

  // ---------- nothing stuck ----------
  {
    const probe = await Promise.all(Array.from({ length: 30 }, () => fetch(ctx.base + '/atlas/call/info').then((r) => r.status)));
    check('after the load the service answers every request', probe.every((s) => s === 200), probe);
    check('no request in the whole run was refused for waiting too long on the lock', !/lock-wait|busy/i.test(ctx.svc.log()));
    check('no temporary files are left in the state folder', (() => {
      const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((f) => (f.isDirectory() ? walk(path.join(d, f.name)) : [path.join(d, f.name)]));
      return walk(ctx.svc.stateDir).filter((f) => /\.tmp|\.part|~$/.test(f)).length === 0;
    })());
  }

  await ctx.svc.close();
  process.exit(T.finish('manual-call-php-concurrency'));
})().catch((e) => { console.error(e); process.exit(2); });
