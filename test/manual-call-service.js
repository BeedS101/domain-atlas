// Call Service tests: tags, membership, invites, signalling, replay, tampering, limits, cleanup.
// Runs the service in this process on loopback with short timers. No browser needed.
// Run: node test/manual-call-service.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('./call-test-lib');
const { P, check, sleep, newIdentity, sign, iso, post, base, nonce, Wallet, fp, signalPayload, sendSignal } = T;

async function handshake(ctx, caller, callee, tagInfo, listenAck) {
  await callee.listen(listenAck || []);
  const built = await caller.buildInvite(tagInfo.tag, callee.pub);
  const inv = await caller.invite(built);
  const listened = await callee.listen(listenAck || []);
  const ev = listened.json && listened.json.events && listened.json.events.find((e) => e.type === 'invite');
  return { built, inv, listened, ev };
}
async function acceptCall(ctx, callee, built) {
  const ckB = await newIdentity();
  const acceptPayload = signalPayload(ctx, built.callId, 'accept', {
    inviteHash: await P.payloadHash(built.payload), calleeNonce: P.randomId(16), callKey: ckB.pub, fingerprints: [fp('B')]
  });
  const res = await sendSignal(ctx, acceptPayload, callee.ident);
  const th = await P.transcriptHash(built.payload, acceptPayload);
  return { res, ckB, acceptPayload, th };
}

(async () => {
  const ctx = await T.startService(null, { timers: { sweepMs: 100, listenHoldMs: 600, acceptToOfferMs: 1500, offerToAnswerMs: 1500, confirmMs: 1500, endedRetainMs: 600, listenerFreshMs: 3000, silentActiveMs: 1500 }, limits: { invitesPerSourcePerMin: 1000, invitesPerCallerPerMin: 1000, invitesPerCalleePerMin: 1000 } });
  const alice = await Wallet.create(ctx, 'alice'); // caller
  const bob = await Wallet.create(ctx, 'bob');     // callee
  const mallory = await Wallet.create(ctx, 'mallory');

  // ---------- info ----------
  const info = await fetch(ctx.base + '/atlas/call/info').then((r) => r.json());
  check('info reports configured and the service origin', info.configured === true && info.audience === ctx.origin && info.domain === 'example.com');
  check('info states the invite lifetime limit', info.limits.inviteTtlMs === 60000);

  // ---------- tag creation and membership ----------
  let r = await bob.createTag(alice.pub);
  check('tag/create with a valid membership credential succeeds', r.status === 200 && /^[A-Za-z0-9_-]{22}$/.test(r.json.tag), r);
  const tagInfo = r.json;
  r = await bob.createTag(alice.pub, {}, null);
  check('tag/create without a membership credential is refused', r.status === 403 && r.json.code === 'membership-required', r);
  const other = await T.newIssuer('example.com');
  r = await bob.createTag(alice.pub, {}, await other.membership(bob.pub));
  check('tag/create with a credential signed by an unpinned key is refused', r.status === 403, r);
  r = await bob.createTag(alice.pub, {}, await ctx.issuer.membership(mallory.pub));
  check('tag/create with a credential owned by someone else is refused', r.status === 403, r);
  r = await bob.createTag(alice.pub, {}, await ctx.issuer.membership(bob.pub, { asset: { class: 'atlas.membership' } }));
  check('tag/create with a credential of the wrong class is refused', r.status === 403, r);
  r = await bob.createTag(alice.pub, {}, await ctx.issuer.membership(bob.pub, { issuer: { domain: 'other.example' } }));
  check('tag/create with a credential from another domain is refused', r.status === 403, r);
  r = await bob.createTag(alice.pub, {}, await ctx.issuer.membership(bob.pub, { asset: { class: 'atlas.postoffice.membership', expiresAt: iso(Date.now() - 1000) } }));
  check('tag/create with an expired credential is refused', r.status === 403, r);
  {
    const cred = await ctx.issuer.membership(bob.pub);
    cred.quantity = 2; // tampered after signing
    r = await bob.createTag(alice.pub, {}, cred);
    check('tag/create with a tampered credential is refused', r.status === 403, r);
  }
  r = await bob.createTag(alice.pub, { audience: 'http://127.0.0.1:1' });
  check('tag/create addressed to another service is refused', r.status === 401 && r.json.code === 'wrong-audience', r);
  r = await bob.createTag(alice.pub, { issuedAt: iso(Date.now() - 600000) });
  check('tag/create with a stale timestamp is refused and returns server time', r.status === 401 && r.json.code === 'stale-request' && !!r.json.serverTime, r);
  r = await bob.createTag(alice.pub, { extra: 1 });
  check('tag/create with an unknown payload field is refused', r.status === 400, r);
  r = await bob.createTag(alice.pub, { calleeKey: alice.pub });
  check('tag/create where calleeKey is not the signer is refused', r.status === 400, r);
  {
    const payload = base('atlas.call.tag', ctx.origin, { nonce: nonce(), bind: { kind: 'wallet', publicKey: alice.pub }, calleeKey: bob.pub, expiresAt: iso(Date.now() + 3600000), maxCalls: 10 });
    const proof = await sign(payload, bob.ident);
    const body = { payload, proof, membership: await ctx.issuer.membership(bob.pub) };
    const first = await post(ctx.base, '/atlas/call/tag/create', body);
    const second = await post(ctx.base, '/atlas/call/tag/create', body);
    check('a replayed tag/create request is refused', first.status === 200 && second.status === 401 && second.json.code === 'replayed-request', { first, second });
    const forged = JSON.parse(JSON.stringify(body)); forged.payload.maxCalls = 99; forged.payload.nonce = nonce();
    const f = await post(ctx.base, '/atlas/call/tag/create', forged);
    check('a tag/create payload edited after signing is refused', f.status === 401 && f.json.code === 'bad-signature', f);
  }
  r = await bob.createTag(alice.pub, { expiresAt: iso(Date.now() + 200 * 86400000) });
  check('tag/create beyond the 90 day limit is refused', r.status === 400, r);

  // ---------- tag list / session limits ----------
  r = await bob.listTags();
  check('tag/list through a listening session returns only the owner\'s tags', r.status === 200 && r.json.tags.length >= 2 && r.json.tags.every((t) => t.bind.publicKey === alice.pub), r);
  r = await alice.listTags();
  check('another wallet\'s session lists none of bob\'s tags', r.status === 200 && r.json.tags.length === 0, r);
  {
    const s = await bob.session(600000);
    const payload = base('atlas.call.tag', ctx.origin, { nonce: nonce(), bind: { kind: 'wallet', publicKey: alice.pub }, calleeKey: bob.pub, expiresAt: iso(Date.now() + 3600000), maxCalls: 10 });
    const x = await post(ctx.base, '/atlas/call/tag/create', { payload, proof: await sign(payload, s.sk), membership: await ctx.issuer.membership(bob.pub) });
    check('a listening session key cannot create tags', x.status >= 400 && x.status < 500, x);
    const lp = base('atlas.call.tag-revoke', ctx.origin, { nonce: nonce(), all: true });
    const y = await post(ctx.base, '/atlas/call/tag/revoke', { payload: lp, proof: await sign(lp, s.sk), session: s.delegation });
    check('a listening session cannot revoke all tags', y.status === 400, y);
    const expired = await bob.session(1000);
    const exPayload = base('atlas.call.listen-session', ctx.origin, { expiresAt: iso(Date.now() - 1000), sessionKey: expired.sk.pub });
    exPayload.issuedAt = iso(Date.now() - 5000);
    const exDeleg = { payload: exPayload, proof: await sign(exPayload, bob.ident) };
    const z = await bob.listen([], { sk: expired.sk, delegation: exDeleg });
    check('an expired listening session is refused', z.status === 401, z);
    const longPayload = base('atlas.call.listen-session', ctx.origin, { expiresAt: iso(Date.now() + 7200000), sessionKey: s.sk.pub });
    const w = await bob.listen([], { sk: s.sk, delegation: { payload: longPayload, proof: await sign(longPayload, bob.ident) } });
    check('a listening session longer than 60 minutes is refused', w.status === 400, w);
    const forgedDeleg = { payload: s.delegation.payload, proof: await sign(s.delegation.payload, mallory.ident) };
    const ok = await bob.listen([], { sk: s.sk, delegation: forgedDeleg });
    check('a session delegation signed by a different key is accepted only as that key\'s own session (no access to bob\'s mailbox)', ok.status === 200 && ok.json.events.length === 0, ok);
  }

  // ---------- invite refusals are uniform ----------
  // Bob is not listening yet (do-not-disturb looks the same as an unknown tag).
  const builtNoListener = await alice.buildInvite(tagInfo.tag, bob.pub);
  const noListener = await alice.invite(builtNoListener);
  const unknownTagBuilt = await alice.buildInvite(P.randomId(16), bob.pub);
  const unknownTag = await alice.invite(unknownTagBuilt);
  check('an invite while the callee is not listening is refused as unavailable', noListener.status === 404 && noListener.json.code === 'unavailable', noListener);
  check('an unknown tag and an unlistened valid tag give an identical refusal', JSON.stringify(unknownTag) === JSON.stringify(noListener), { unknownTag, noListener });

  // Now bob starts listening.
  bob.sess = await bob.session(1800000);
  r = await bob.listen([]);
  // listenHoldMs is short in this test; the call returns empty.
  check('listen returns an empty event list when nothing is waiting', r.status === 200 && r.json.events.length === 0, r);

  const forged = await mallory.buildInvite(tagInfo.tag, bob.pub);
  const forgedRes = await mallory.invite(forged);
  check('an invite from a key the tag is not bound to is refused as unavailable', forgedRes.status === 404 && JSON.stringify(forgedRes) === JSON.stringify(unknownTag), forgedRes);
  {
    const b = await alice.buildInvite(tagInfo.tag, bob.pub);
    b.body.invite.payload.callee.publicKey = mallory.pub;
    const x = await alice.invite(b);
    check('an invite edited after signing is refused', x.status === 401 && x.json.code === 'bad-signature', x);
    const b2 = await alice.buildInvite(tagInfo.tag, mallory.pub);
    const x2 = await alice.invite(b2);
    check('an invite naming a callee key that is not the tag\'s callee is refused as unavailable', x2.status === 404 && x2.json.code === 'unavailable', x2);
    const b3 = await alice.buildInvite(tagInfo.tag, bob.pub, { audience: 'http://127.0.0.1:1' });
    check('an invite for another service is refused', (await alice.invite(b3)).json.code === 'wrong-audience');
    const b4 = await alice.buildInvite(tagInfo.tag, bob.pub, { expiresAt: iso(Date.now() + 120000) });
    check('an invite valid for longer than 60 seconds is refused', (await alice.invite(b4)).status === 400);
    const b5 = await alice.buildInvite(tagInfo.tag, bob.pub, { issuedAt: iso(Date.now() - 300000), expiresAt: iso(Date.now() - 250000) });
    check('a stale invite is refused', (await alice.invite(b5)).json.code === 'stale-request');
    const b6 = await alice.buildInvite(tagInfo.tag, bob.pub);
    b6.body.tag = P.randomId(16);
    const x6 = await alice.invite(b6);
    check('an invite whose outer tag differs from the signed tag is refused as unavailable', x6.status === 404, x6);
    const huge = await post(ctx.base, '/atlas/call/invite', null, JSON.stringify({ tag: tagInfo.tag, pad: 'x'.repeat(20000) }));
    check('an oversize invite body is refused with 413', huge.status === 413, huge);
    const junk = await post(ctx.base, '/atlas/call/invite', null, '{not json');
    check('malformed JSON is refused with 400', junk.status === 400, junk);
    const unk = await post(ctx.base, '/atlas/call/invite', { tag: tagInfo.tag, invite: b6.body.invite, chain: {} });
    check('an unknown top-level invite field is refused', unk.status === 400, unk);
  }

  // ---------- full call ----------
  const hs = await handshake(ctx, alice, bob, tagInfo);
  check('a valid invite is accepted for delivery', hs.inv.status === 202, hs.inv);
  check('the callee\'s listener receives the signed invite unchanged', !!hs.ev && JSON.stringify(hs.ev.invite) === JSON.stringify(hs.built.body.invite), hs.listened);
  const second = await alice.invite(await alice.buildInvite(tagInfo.tag, bob.pub));
  check('a second invite on a tag that is already ringing is refused as unavailable', second.status === 404, second);
  const replayInvite = await alice.invite(hs.built);
  check('replaying the same invite is refused', replayInvite.status === 401 && replayInvite.json.code === 'replayed-request', replayInvite);

  // caller polls before accept: only its own call key is accepted
  r = await alice.poll(hs.built.callId, hs.built.ck, 0);
  check('the caller can poll with its call key', r.status === 200, r);
  r = await alice.poll(hs.built.callId, (await newIdentity()));
  check('polling with a key that is not part of the call is refused as unavailable', r.status === 404 && r.json.code === 'unavailable', r);
  r = await alice.ice(hs.built.callId, hs.built.ck);
  check('ICE servers are not handed out while the call is only ringing', r.status === 404, r);

  // a signal from a non-owner session cannot decline
  {
    const evil = await mallory.session();
    const decl = signalPayload(ctx, hs.built.callId, 'decline', { reason: 'declined' });
    const x = await sendSignal(ctx, decl, evil.sk, evil.delegation);
    check('a listening session of a different wallet cannot decline the call', x.status === 404, x);
    const st = ctx.svc.callState(hs.built.callId);
    check('the call is still ringing after the refused decline', st === 'RINGING', st);
  }
  // accept tampered / wrong signer
  {
    const bad = signalPayload(ctx, hs.built.callId, 'accept', { inviteHash: await P.payloadHash(hs.built.payload), calleeNonce: P.randomId(16), callKey: (await newIdentity()).pub, fingerprints: [fp('M')] });
    const x = await sendSignal(ctx, bad, mallory.ident);
    check('accept signed by a key other than the tag\'s callee key is refused', x.status === 404, x);
    const wrongHash = signalPayload(ctx, hs.built.callId, 'accept', { inviteHash: P.randomId(32), calleeNonce: P.randomId(16), callKey: (await newIdentity()).pub, fingerprints: [fp('B')] });
    const y = await sendSignal(ctx, wrongHash, bob.ident);
    check('accept naming a different invite hash is refused', y.status === 404, y);
    const same = signalPayload(ctx, hs.built.callId, 'accept', { inviteHash: await P.payloadHash(hs.built.payload), calleeNonce: P.randomId(16), callKey: hs.built.ck.pub, fingerprints: [fp('B')] });
    const z = await sendSignal(ctx, same, bob.ident);
    check('accept reusing the caller\'s call key is refused', z.status === 404, z);
  }
  const acc = await acceptCall(ctx, bob, hs.built);
  check('the callee\'s signed accept is taken', acc.res.status === 202, acc.res);
  const replayAccept = await sendSignal(ctx, acc.acceptPayload, bob.ident);
  check('a replayed accept is refused', replayAccept.status === 404, replayAccept);

  r = await alice.poll(hs.built.callId, hs.built.ck, 0);
  const accEv = r.json.events.find((e) => e.type === 'signal');
  check('the caller receives the signed accept unchanged', !!accEv && JSON.stringify(accEv.message.payload) === JSON.stringify(acc.acceptPayload), r);
  r = await bob.poll(hs.built.callId, acc.ckB, 0);
  check('the callee can now poll with its call key', r.status === 200, r);
  r = await alice.ice(hs.built.callId, hs.built.ck);
  check('ICE servers are available once accepted', r.status === 200 && Array.isArray(r.json.iceServers), r);

  // offer ordering and tampering
  const ckA = hs.built.ck, ckB = acc.ckB, th = acc.th;
  const sdp = (who) => 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=fingerprint:sha-256 ' + fp(who).slice(8) + '\r\n';
  {
    const early = signalPayload(ctx, hs.built.callId, 'answer', { sdp: sdp('B'), offerHash: P.randomId(32) }, 1, th);
    check('an answer before the offer is refused', (await sendSignal(ctx, early, ckB)).status === 404);
    const wrongSeq = signalPayload(ctx, hs.built.callId, 'offer', { sdp: sdp('A') }, 2, th);
    check('an offer with a skipped sequence number is refused', (await sendSignal(ctx, wrongSeq, ckA)).status === 404);
    const wrongTh = signalPayload(ctx, hs.built.callId, 'offer', { sdp: sdp('A') }, 1, P.randomId(32));
    check('an offer with the wrong transcript hash is refused', (await sendSignal(ctx, wrongTh, ckA)).status === 404);
    const noTh = signalPayload(ctx, hs.built.callId, 'offer', { sdp: sdp('A') }, 1);
    check('an offer without a transcript hash is refused as malformed', (await sendSignal(ctx, noTh, ckA)).status === 400);
    const fromCallee = signalPayload(ctx, hs.built.callId, 'offer', { sdp: sdp('A') }, 1, th);
    check('an offer signed by the callee\'s call key is refused', (await sendSignal(ctx, fromCallee, ckB)).status === 404);
    const bytes = signalPayload(ctx, hs.built.callId, 'offer', { sdp: sdp('A'), extra: 1 }, 1, th);
    check('an offer with an unknown body field is refused as malformed', (await sendSignal(ctx, bytes, ckA)).status === 400);
    const bigSdp = signalPayload(ctx, hs.built.callId, 'offer', { sdp: 'v=0\r\n' + 'a'.repeat(17000) }, 1, th);
    check('an oversize SDP is refused', (await sendSignal(ctx, bigSdp, ckA)).status >= 400);
  }
  const offerP = signalPayload(ctx, hs.built.callId, 'offer', { sdp: sdp('A') }, 1, th);
  {
    const msg = { payload: offerP, proof: await sign(offerP, ckA) };
    const tampered = JSON.parse(JSON.stringify(msg)); tampered.payload.body.sdp = sdp('M');
    const t = await post(ctx.base, '/atlas/call/signal', tampered);
    check('an offer whose SDP was edited after signing is refused', t.status === 404, t);
    const ok = await post(ctx.base, '/atlas/call/signal', msg);
    check('a correct offer is relayed', ok.status === 202, ok);
    const again = await post(ctx.base, '/atlas/call/signal', msg);
    check('a replayed offer is refused', again.status === 404, again);
  }
  r = await bob.poll(hs.built.callId, ckB, 0);
  const offEv = r.json.events.find((e) => e.type === 'signal' && e.message.payload.kind === 'offer');
  check('the callee receives the signed offer unchanged', !!offEv && JSON.stringify(offEv.message.payload) === JSON.stringify(offerP), r);
  const offerHash = await P.payloadHash(offerP);

  const answerP = signalPayload(ctx, hs.built.callId, 'answer', { sdp: sdp('B'), offerHash }, 1, th);
  check('the answer is relayed', (await sendSignal(ctx, answerP, ckB)).status === 202);
  // candidates
  const cand = (n, seq) => signalPayload(ctx, hs.built.callId, 'candidates', { candidates: Array.from({ length: n }, (_, i) => ({ candidate: 'candidate:' + i + ' 1 udp 1 10.0.0.1 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 })), end: false }, seq, th);
  check('candidates from the caller are relayed after its offer', (await sendSignal(ctx, cand(2, 2), ckA)).status === 202);
  check('more than 8 candidates in one message are refused', (await sendSignal(ctx, cand(9, 3), ckA)).status === 400);
  check('candidates up to the per-call cap are relayed', (await sendSignal(ctx, cand(8, 3), ckA)).status === 202 && (await sendSignal(ctx, cand(8, 4), ckA)).status === 202);
  check('candidates beyond the per-call cap are refused', (await sendSignal(ctx, cand(3, 5), ckA)).status === 404);

  const confirmFor = (who, seq) => signalPayload(ctx, hs.built.callId, 'confirm', { fingerprints: { local: fp(who), remote: fp(who === 'A' ? 'B' : 'A') }, nonces: { caller: hs.built.payload.nonce, callee: P.randomId(16) }, offerHash, answerHash: P.randomId(32) }, seq, th);
  check('the caller\'s confirm is relayed', (await sendSignal(ctx, confirmFor('A', 5), ckA)).status === 202);
  check('the state stays ESTABLISHING until both confirm', ctx.svc.callState(hs.built.callId) === 'ESTABLISHING');
  check('a repeated confirm from the same side is refused', (await sendSignal(ctx, confirmFor('A', 6), ckA)).status === 404);
  check('the callee\'s confirm is relayed', (await sendSignal(ctx, confirmFor('B', 2), ckB)).status === 202);
  check('the call is ACTIVE when both confirmations passed through', ctx.svc.callState(hs.built.callId) === 'ACTIVE');

  r = await alice.poll(hs.built.callId, ckA, 1);
  const kinds = r.json.events.filter((e) => e.type === 'signal').map((e) => e.message.payload.kind);
  check('the caller received answer and confirm in order', kinds[0] === 'answer' && kinds.includes('confirm'), kinds);

  // end
  const endP = signalPayload(ctx, hs.built.callId, 'end', { reason: 'hangup' }, 6, th);
  const endRes = await sendSignal(ctx, endP, ckA);
  check('hang-up is relayed', endRes.status === 202, endRes);
  r = await bob.poll(hs.built.callId, ckB, 0);
  check('the callee receives the signed end', r.json.events.some((e) => e.type === 'signal' && e.message.payload.kind === 'end'), r);
  check('the call state is ENDED', ctx.svc.callState(hs.built.callId) === 'ENDED');
  check('messages after the end are refused', (await sendSignal(ctx, signalPayload(ctx, hs.built.callId, 'end', { reason: 'hangup' }, 7, th), ckA)).status === 404);
  await sleep(1000);
  check('the ended call is deleted after the retention period', ctx.svc.callState(hs.built.callId) === null);
  r = await alice.poll(hs.built.callId, ckA, 0);
  check('polling a deleted call is refused as unavailable', r.status === 404, r);

  // ---------- decline, busy, cancel ----------
  {
    const tag2 = (await bob.createTag(alice.pub)).json;
    const h = await handshake(ctx, alice, bob, tag2);
    const d = signalPayload(ctx, h.built.callId, 'decline', { reason: 'declined' });
    const x = await sendSignal(ctx, d, bob.sess.sk, bob.sess.delegation);
    check('the callee\'s listening session can decline', x.status === 202, x);
    r = await alice.poll(h.built.callId, h.built.ck, 0);
    check('the caller learns the call was declined', r.json.events.some((e) => e.type === 'ended' && e.reason === 'declined'), r);
    await sleep(800);
    const h2 = await handshake(ctx, alice, bob, tag2, [h.ev && h.ev.id]);
    const busy = signalPayload(ctx, h2.built.callId, 'busy', { reason: 'busy' });
    await sendSignal(ctx, busy, bob.sess.sk, bob.sess.delegation);
    r = await alice.poll(h2.built.callId, h2.built.ck, 0);
    check('the caller learns the callee was busy', r.json.events.some((e) => e.type === 'ended' && e.reason === 'busy'), r);
    await sleep(800);
    const h3 = await handshake(ctx, alice, bob, tag2, []);
    const cancel = signalPayload(ctx, h3.built.callId, 'cancel', {}, 1);
    const cx = await sendSignal(ctx, cancel, h3.built.ck);
    check('the caller can cancel while ringing', cx.status === 202, cx);
    const l = await bob.listen([]);
    const cev = l.json.events.find((e) => e.type === 'cancel');
    check('the callee receives the signed cancel to verify itself', !!cev && cev.message.payload.kind === 'cancel' && !l.json.events.some((e) => e.type === 'invite' && e.callId === h3.built.callId), l);
    await sleep(800);
    // revoking a tag
    const rv = await bob.revokeTag(tag2.tag);
    check('a listening session can revoke one tag', rv.status === 200 && rv.json.revoked === 1, rv);
    const afterRevoke = await alice.invite(await alice.buildInvite(tag2.tag, bob.pub));
    check('a revoked tag behaves exactly like an unknown tag', afterRevoke.status === 404 && JSON.stringify(afterRevoke) === JSON.stringify(unknownTag), afterRevoke);
    const rvOther = await alice.revokeTag(tagInfo.tag, await alice.session());
    check('revoking someone else\'s tag changes nothing', rvOther.json.revoked === 0, rvOther);
  }

  // ---------- timers ----------
  {
    const tag3 = (await bob.createTag(alice.pub, { expiresAt: iso(Date.now() + 3600000) })).json;
    const built = await alice.buildInvite(tag3.tag, bob.pub, { expiresAt: iso(Date.now() + 1500) });
    await alice.invite(built);
    check('a ringing call exists', ctx.svc.callState(built.callId) === 'RINGING');
    await sleep(1900);
    check('a call that nobody answers times out', ctx.svc.callState(built.callId) === 'ENDED');
    r = await alice.poll(built.callId, built.ck, 0);
    check('the caller is told about the timeout', r.json.events.some((e) => e.type === 'ended' && e.reason === 'timeout'), r);
    await sleep(800);

    const hs2 = await handshake(ctx, alice, bob, tag3, []);
    const a2 = await acceptCall(ctx, bob, hs2.built);
    await sleep(1800);
    check('an accepted call whose offer never arrives times out', ctx.svc.callState(hs2.built.callId) === 'ENDED');
    r = await bob.poll(hs2.built.callId, a2.ckB, 0);
    check('the callee is told about the timeout', r.json.events.some((e) => e.type === 'ended' && e.reason === 'timeout'), r);
  }

  // ---------- quota and cleanup ----------
  await sleep(900);
  {
    const st = ctx.svc.stats();
    check('no live calls remain after the scenarios', st.liveCalls === 0, st);
    await sleep(1000);
    const st2 = ctx.svc.stats();
    check('ended calls and rate-limit buckets are released after the retention period', st2.calls === 0, st2);
  }

  // ---------- rate limits ----------
  {
    const rl = await T.startService(null, { quiet: true });
    const ra = await Wallet.create(rl), rb = await Wallet.create(rl);
    const tag4 = (await rb.createTag(ra.pub)).json;
    let limited = 0;
    for (let i = 0; i < 12; i++) {
      const x = await ra.invite(await ra.buildInvite(tag4.tag, rb.pub));
      if (x.status === 429) limited++;
    }
    await rl.svc.close();
    check('repeated invites from one caller are rate limited', limited > 0, limited);
  }

  // ---------- persistence ----------
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-call-'));
  const stateFile = path.join(dir, 'atlas-call-tags.json');
  const p1 = await T.startService({ stateFile }, { quiet: true });
  const carol = await Wallet.create(p1, 'carol');
  const dave = await Wallet.create(p1, 'dave');
  const t1 = (await carol.createTag(dave.pub)).json;
  const fileText = fs.readFileSync(stateFile, 'utf8');
  check('the tag store holds only the hash of a tag, never the tag', !fileText.includes(t1.tag));
  check('the tag store is created with owner-only permissions', process.platform === 'win32' || (fs.statSync(stateFile).mode & 0o077) === 0, (fs.statSync(stateFile).mode & 0o777).toString(8));
  await p1.svc.close();
  const p2cfg = await T.startService({ stateFile }, { quiet: true, issuer: p1.issuer });
  const carol2 = new Wallet(carol.ident, p2cfg, 'carol');
  const listed = await (async () => { carol2.sess = await carol2.session(); return carol2.listTags(); })();
  check('tags survive a restart of the service', listed.status === 200 && listed.json.tags.length === 1, listed);
  await p2cfg.svc.close();
  fs.rmSync(dir, { recursive: true, force: true });

  // ---------- stopping the listening session (do not disturb) ----------
  {
    const dan = await Wallet.create(ctx, 'dan'), erin = await Wallet.create(ctx, 'erin');
    const t1 = (await dan.createTag(erin.pub)).json, t2 = (await dan.createTag(erin.pub)).json;
    await dan.listen([]);
    const first = await erin.invite(await erin.buildInvite(t1.tag, dan.pub));
    check('while the callee is listening an invite is accepted', first.status === 202, first);
    const stopped = await dan.sessionRequest('/atlas/call/listen', 'atlas.call.listen', { ack: [], stop: true });
    check('a listen request with stop:true is accepted', stopped.status === 200, stopped);
    const second = await erin.invite(await erin.buildInvite(t2.tag, dan.pub));
    check('right after stop an invite is refused as unavailable, without waiting for the listener to go stale', second.status === 404 && second.json.code === 'unavailable', second);
    const bad = await dan.sessionRequest('/atlas/call/listen', 'atlas.call.listen', { ack: [], stop: 'yes' });
    check('stop must be exactly true', bad.status === 400, bad);
    await dan.listen([]);
    const again = await erin.invite(await erin.buildInvite(t2.tag, dan.pub));
    check('listening again makes the callee reachable again', again.status === 202, again);
  }

  // ---------- revocation list ----------
  {
    const http = require('http');
    const issuer = await T.newIssuer('example.com');
    const revoked = new Set();
    const revSrv = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ revoked: [...revoked].map((id) => ({ id })) })); });
    await new Promise((r) => revSrv.listen(0, '127.0.0.1', r));
    const rctx = await T.startService({ revocationsUrl: 'http://127.0.0.1:' + revSrv.address().port + '/rev.json' }, { quiet: true, issuer, timers: { revocationCacheMs: 0 } });
    const e1 = await Wallet.create(rctx), e2 = await Wallet.create(rctx);
    const cred = await issuer.membership(e1.pub);
    const ok = await e1.createTag(e2.pub, {}, cred);
    revoked.add(cred.id);
    const no = await e1.createTag(e2.pub, {}, cred);
    check('a membership credential on the revocation list is refused', ok.status === 200 && no.status === 403, { ok: ok.status, no: no.status });
    revSrv.close();
    const down = await e1.createTag(e2.pub, {}, await issuer.membership(e1.pub));
    check('when the revocation list cannot be read, tag creation fails closed', down.status === 503, down);
    await rctx.svc.close();
  }

  await ctx.svc.close();
  process.exit(T.finish('manual-call-service'));
})().catch((e) => { console.error(e); process.exit(2); });
