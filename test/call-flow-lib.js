// Drives one call through a Call Service at the protocol level, as two wallets would: the
// callee listens, the caller invites, the callee accepts, then offer, answer, candidates and
// confirmations. Used by the PHP tests that need a call in a given state.
'use strict';
const T = require('./call-test-lib');
const { P, newIdentity, sign, Wallet, fp, signalPayload, sendSignal, post, base, nonce } = T;

const sdp = (who) => 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=fingerprint:sha-256 ' + fp(who).slice(8) + '\r\n';

// stage: 'ringing' | 'accepted' | 'negotiating' | 'establishing' | 'active'
async function driveCall(ctx, caller, callee, tagInfo, stage, over) {
  stage = stage || 'active';
  if (!callee.sess) callee.sess = await callee.session(1800000);
  await callee.listen([]);
  const built = await caller.buildInvite(tagInfo.tag, callee.pub, over);
  const inv = await caller.invite(built);
  const call = { built, inv, callId: built.callId, ckA: built.ck, stage: 'ringing' };
  if (inv.status !== 202 || stage === 'ringing') return call;
  const ckB = await newIdentity();
  const acceptPayload = signalPayload(ctx, built.callId, 'accept', { inviteHash: await P.payloadHash(built.payload), calleeNonce: P.randomId(16), callKey: ckB.pub, fingerprints: [fp('B')] });
  call.accept = await sendSignal(ctx, acceptPayload, callee.ident);
  call.ckB = ckB;
  call.th = await P.transcriptHash(built.payload, acceptPayload);
  call.stage = 'accepted';
  call.seqA = 0; call.seqB = 0;
  if (call.accept.status !== 202 || stage === 'accepted') return call;
  const offerP = signalPayload(ctx, built.callId, 'offer', { sdp: sdp('A') }, ++call.seqA, call.th);
  call.offer = await sendSignal(ctx, offerP, call.ckA);
  call.offerHash = await P.payloadHash(offerP);
  call.stage = 'negotiating';
  if (call.offer.status !== 202 || stage === 'negotiating') return call;
  const answerP = signalPayload(ctx, built.callId, 'answer', { sdp: sdp('B'), offerHash: call.offerHash }, ++call.seqB, call.th);
  call.answer = await sendSignal(ctx, answerP, call.ckB);
  call.answerHash = await P.payloadHash(answerP);
  call.stage = 'establishing';
  if (call.answer.status !== 202 || stage === 'establishing') return call;
  const confirm = (who, seq) => signalPayload(ctx, built.callId, 'confirm', {
    fingerprints: { local: fp(who), remote: fp(who === 'A' ? 'B' : 'A') }, nonces: { caller: built.payload.nonce, callee: P.randomId(16) },
    offerHash: call.offerHash, answerHash: call.answerHash
  }, seq, call.th);
  call.confirmA = await sendSignal(ctx, confirm('A', ++call.seqA), call.ckA);
  call.confirmB = await sendSignal(ctx, confirm('B', ++call.seqB), call.ckB);
  call.stage = 'active';
  return call;
}

async function hangup(ctx, call, role) {
  const key = role === 'B' ? call.ckB : call.ckA;
  const seq = role === 'B' ? ++call.seqB : ++call.seqA;
  return sendSignal(ctx, signalPayload(ctx, call.callId, 'end', { reason: 'hangup' }, seq, call.th), key);
}

module.exports = { driveCall, hangup, sdp };
