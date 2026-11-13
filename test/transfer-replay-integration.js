// Direct transfer with a request id (issuer-php/atlas/asset/transfer.php): a real PHP issuer (isolated copy,
// fresh key and state) and real ECDSA wallet signatures. Covers the transfer, a repeat after a lost answer,
// the request id being bound to the signed intent, refusals, a transfer without a request id (the older shape),
// and concurrent identical requests.
//   node test/transfer-replay-integration.js [name-filter]
const assert = require('assert').strict;
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { StudioLab, makeIdentity, signPayload, DESIGN } = require('./studio-lab');

const FILTER = process.argv[2] || '';
const results = { pass: 0, fail: 0 };
const labs = [];
const HIGH = { challengesPerIpPerHour: 10000, mintsPerIpPerHour: 10000, maxMintsPerRecipientPerDay: 1000, maxMintsPerActorPerDay: 10000, maxMintsPerDay: 100000 };
const RING = Object.assign({}, DESIGN, { template: 'trophy', name: 'Transfer Trophy', tradeScope: 'local' });

async function test(name, fn) {
  if (FILTER && name.indexOf(FILTER) === -1) return;
  try { await fn(); results.pass++; console.log('ok   ' + name); }
  catch (e) { results.fail++; console.log('FAIL ' + name + '\n     ' + String(e && e.stack || e).split('\n').slice(0, 6).join('\n     ')); }
}
async function newLab() {
  const l = await StudioLab.start({ mint: true, config: HIGH });
  labs.push(l);
  return l;
}
const newRid = () => crypto.randomBytes(16).toString('hex');
const revoked = (l) => JSON.parse(fs.readFileSync(path.join(l.docroot, '.well-known', 'atlas-revocations.json'), 'utf8')).revoked;
async function mintFor(l, owner) {
  const m = await l.mintAs(owner, RING);
  assert.equal(m.mint.status, 200, m.mint.text);
  return m.mint.json.credential;
}
function transferBody(owner, credential, recipient, opts) {
  opts = opts || {};
  const requestId = opts.requestId || newRid();
  const payload = Object.assign({ action: 'transfer', credentialId: credential.id, recipientPublicKey: recipient.publicKeyB64, requestId }, opts.payload || {});
  if (opts.omitRequestId || opts.unnamedInIntent) delete payload.requestId;
  const body = { credential, recipientPublicKey: recipient.publicKeyB64, requestId, intent: { payload, proof: signPayload(opts.signer || owner, payload) } };
  if (opts.omitRequestId) delete body.requestId;
  return body;
}
const send = (l, body) => l.postRaw('/atlas/asset/transfer', body);

(async () => {
  await test('a transfer revokes the original and signs a credential for the recipient', async () => {
    const l = await newLab();
    const a = makeIdentity('raw-ecdsa'), b = makeIdentity('raw-ecdsa');
    const cred = await mintFor(l, a);
    assert.equal(cred.asset.tradeScope, 'local', 'the studio item is giftable: ' + cred.asset.tradeScope);
    const r = await send(l, transferBody(a, cred, b));
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.status, 'transferred');
    assert.equal(r.json.credential.owner.publicKey, b.publicKeyB64);
    assert.equal(r.json.credential.supersedes, cred.id);
    assert.ok(revoked(l).some((e) => e.id === cred.id && e.reason === 'transferred'), 'original revoked as transferred');
    assert.ok(!revoked(l).some((e) => e.id === r.json.credential.id), 'new credential is live');
    const caps = await l.get('/atlas/capabilities');
    assert.ok(caps.json.requestIds.operations.includes('transfer'), 'transfer is listed as repeatable');
  });

  await test('a repeat returns the same credential and makes no second one', async () => {
    const l = await newLab();
    const a = makeIdentity('raw-ecdsa'), b = makeIdentity('raw-ecdsa');
    const cred = await mintFor(l, a);
    const body = transferBody(a, cred, b);
    const first = await send(l, body);
    const again = await send(l, body);
    assert.equal(first.status, 200, first.text);
    assert.equal(again.status, 200, again.text);
    assert.equal(again.text, first.text, 'identical answer');
    assert.equal(revoked(l).filter((e) => e.id === cred.id).length, 1, 'revoked once');
  });

  await test('the same request id for a different recipient is a conflict', async () => {
    const l = await newLab();
    const a = makeIdentity('raw-ecdsa'), b = makeIdentity('raw-ecdsa'), c = makeIdentity('raw-ecdsa');
    const cred = await mintFor(l, a);
    const rid = newRid();
    assert.equal((await send(l, transferBody(a, cred, b, { requestId: rid }))).status, 200);
    const other = await send(l, transferBody(a, cred, c, { requestId: rid }));
    assert.equal(other.status, 409, other.text);
    assert.equal(other.json.code, 'request-id-conflict');
  });

  await test('the intent must name the request id and be signed by the owner', async () => {
    const l = await newLab();
    const a = makeIdentity('raw-ecdsa'), b = makeIdentity('raw-ecdsa'), thief = makeIdentity('raw-ecdsa');
    const cred = await mintFor(l, a);
    const unnamed = await send(l, transferBody(a, cred, b, { unnamedInIntent: true }));
    assert.equal(unnamed.status, 403, unnamed.text);
    const other = await send(l, Object.assign(transferBody(a, cred, b), { requestId: newRid() }));
    assert.equal(other.status, 403, other.text);
    const stolen = await send(l, transferBody(a, cred, b, { signer: thief }));
    assert.ok(stolen.status === 403 || stolen.status === 400, stolen.text);
    const sameSigner = makeIdentity('raw-ecdsa');
    const notOwner = await send(l, transferBody(sameSigner, cred, b));
    assert.equal(notOwner.status, 403, notOwner.text);
    assert.equal(notOwner.json.code, 'not-owner');
    assert.ok(!revoked(l).some((e) => e.id === cred.id), 'nothing was spent by a refused request');
  });

  await test('a replay needs a valid signed intent: another signer gets no stored answer', async () => {
    const l = await newLab();
    const a = makeIdentity('raw-ecdsa'), b = makeIdentity('raw-ecdsa'), thief = makeIdentity('raw-ecdsa');
    const cred = await mintFor(l, a);
    const rid = newRid();
    assert.equal((await send(l, transferBody(a, cred, b, { requestId: rid }))).status, 200);
    const replay = await send(l, transferBody(a, cred, b, { requestId: rid, signer: thief }));
    assert.notEqual(replay.status, 200, 'a stranger must not be handed the stored credential');
  });

  await test('a transfer without a request id still works the older way', async () => {
    const l = await newLab();
    const a = makeIdentity('raw-ecdsa'), b = makeIdentity('raw-ecdsa');
    const cred = await mintFor(l, a);
    const r = await send(l, transferBody(a, cred, b, { omitRequestId: true }));
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.credential.owner.publicKey, b.publicKeyB64);
    const again = await send(l, transferBody(a, cred, b, { omitRequestId: true }));
    assert.equal(again.status, 400, 'a second send of the spent original is refused');
    assert.equal(again.json.code, 'revoked');
  });

  await test('a transfer to oneself is refused and spends nothing', async () => {
    const l = await newLab();
    const a = makeIdentity('raw-ecdsa');
    const cred = await mintFor(l, a);
    const r = await send(l, transferBody(a, cred, a));
    assert.equal(r.status, 400, r.text);
    assert.ok(!revoked(l).some((e) => e.id === cred.id));
  });

  await test('identical requests sent together make one credential', async () => {
    const l = await newLab();
    const a = makeIdentity('raw-ecdsa'), b = makeIdentity('raw-ecdsa');
    const cred = await mintFor(l, a);
    const body = transferBody(a, cred, b);
    const rs = await Promise.all([send(l, body), send(l, body), send(l, body)]);
    const ok = rs.filter((r) => r.status === 200);
    assert.ok(ok.length >= 1, rs.map((r) => r.status).join());
    assert.ok(ok.every((r) => r.text === ok[0].text), 'every success is the same credential');
    assert.ok(rs.every((r) => r.status === 200 || r.json.code === 'busy'), rs.map((r) => r.status + ' ' + r.text).join(' | '));
    assert.equal(revoked(l).filter((e) => e.id === cred.id).length, 1);
  });

  for (const l of labs) { await l.stop(); l.cleanup(); }
  console.log(results.fail ? `\n${results.fail} FAILED, ${results.pass} passed` : `\nall ${results.pass} passed`);
  process.exit(results.fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
