// The experimental Labs 38 adapter and receipt check (extension/ledger-labs38.js) on their own: what
// the adapter sends and reads, and everything checkReceipt() must refuse. No browser and no network:
// the ctx the adapter is handed is a fake, and the receipts are made here with a throwaway issuer
// key. The shapes follow the frozen contract; test/manual-ledger-receipts.js runs the real issuer.
// Run: node test/manual-ledger-labs38-adapter.js
'use strict';
const fs = require('fs');
const path = require('path');
const { webcrypto, createHash } = require('crypto');
const A = require(path.resolve(__dirname, '..', 'extension', 'ledger-labs38.js'));
const E = require('./call-e2e-lib');
const { check } = E;
const { subtle } = webcrypto;

const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const canon = (v) => (v === null || typeof v !== 'object') ? JSON.stringify(v) : Array.isArray(v) ? '[' + v.map(canon).join(',') + ']' : '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
const sha = (t) => createHash('sha256').update(t).digest('hex');
const HOST = 'evtec.co.za';
const NET = 'chainblock-labs29-' + HOST;
const URL_ = 'https://' + HOST + '/atlas/ledger/balance-receipt';
const clone = (x) => JSON.parse(JSON.stringify(x));
const json = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json' } });

async function keypair() {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = b64(new Uint8Array(await subtle.exportKey('raw', kp.publicKey)));
  const sign = async (payload) => b64(new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, new TextEncoder().encode(canon(payload)))));
  return { kp, pub, sign };
}

(async () => {
  const issuer = await keypair(), other = await keypair(), owner = await keypair(), stranger = await keypair();
  const now = Date.now();
  const accountOf = (network, coin, ownerKey) => 'urn:atlas:ledger-account:' + sha(canon({ coin, network, owner: ownerKey, purpose: 'atlas.ledger.account-id', v: 1 }));
  const target = { issuerDomain: HOST, network: NET, coin: 'GOPH', ownerPublicKey: owner.pub, accountId: accountOf(NET, 'GOPH', owner.pub) };
  const keyDoc = { keys: [{ publicKey: issuer.pub, validFrom: iso(now - 3600000), validUntil: null }] };
  const noRevocations = { revoked: [] };

  const request = async (over) => {
    const payload = Object.assign({ type: 'atlas.ledger.balance-receipt.request', v: 1, audience: URL_, network: NET, coin: 'GOPH', nonce: 'ab'.repeat(16), issuedAt: iso(now) }, over || {});
    return { payload, proof: { publicKey: owner.pub, signature: await owner.sign(payload) } };
  };
  // A genuine receipt for `req`, signed by `signer`; `edit` changes the payload BEFORE signing, `after` the envelope.
  const receipt = async (req, edit, after, signer) => {
    const payload = {
      type: 'atlas.ledger.balance-receipt', v: 1, request: { nonce: req.payload.nonce, hash: sha(canon(req.payload)) },
      network: NET, coin: 'GOPH', account: target.accountId, owner: owner.pub, amount: '4200000', decimals: 6,
      observedAt: iso(now), state: { status: 'no-state-version' }
    };
    if (edit) edit(payload);
    const s = signer || issuer;
    const answer = { ok: true, contract: A.CONTRACT, payload, signerKey: s.pub, signature: await s.sign(payload) };
    if (after) after(answer);
    return answer;
  };
  const verify = (over) => A.checkReceipt(Object.assign({ target, keyDoc, revocations: noRevocations, now }, over));
  const refused = (r, code) => r.ok === false && (!code || r.code === code);

  console.log('--- a genuine receipt ---');
  const req = await request();
  const good = await receipt(req);
  let r = await verify({ answer: good, request: req });
  check('it is accepted, with the signed figures', r.ok === true && r.amount === '4200000' && r.decimals === 6 && r.observedAt === good.payload.observedAt && r.signerKey === issuer.pub, r);
  check('the account in the wallet\'s credential matches the one derived independently', target.accountId === await A.accountIdOf(NET, 'GOPH', owner.pub));
  r = await verify({ answer: await receipt(req, (p) => { p.amount = '0'; }), request: req });
  check('a zero balance is accepted', r.ok === true && r.amount === '0');
  r = await verify({ answer: await receipt(req, (p) => { p.amount = '123456789012345678901234567890'; }), request: req });
  check('a large figure is accepted and kept as text', r.ok === true && r.amount === '123456789012345678901234567890');
  check('the check reads nothing but its input (a missing key document is a refusal, not a guess)', refused(await verify({ answer: good, request: req, keyDoc: undefined }), 'signer-unknown'));

  console.log('--- tampering with a genuine receipt: nothing signed can change ---');
  const base = clone(good);
  const mut = async (name, fn, code) => { const a = clone(base); fn(a); r = await verify({ answer: a, request: req }); check('tampered ' + name + ' is refused' + (code ? ' as ' + code : ''), refused(r, code), r); };
  await mut('amount', (a) => { a.payload.amount = '4200001'; }, 'receipt-invalid');
  await mut('amount (to a number)', (a) => { a.payload.amount = 4200000; }, 'receipt-invalid');
  await mut('amount (with a decimal point)', (a) => { a.payload.amount = '4.2'; }, 'receipt-invalid');
  await mut('amount (with a leading zero)', (a) => { a.payload.amount = '04200000'; }, 'receipt-invalid');
  await mut('amount (negative)', (a) => { a.payload.amount = '-1'; }, 'receipt-invalid');
  await mut('amount (exponent)', (a) => { a.payload.amount = '42e5'; }, 'receipt-invalid');
  await mut('decimals', (a) => { a.payload.decimals = 2; }, 'receipt-invalid');
  await mut('decimals (text)', (a) => { a.payload.decimals = '6'; }, 'receipt-invalid');
  await mut('decimals (too many)', (a) => { a.payload.decimals = 19; }, 'receipt-invalid');
  await mut('request hash', (a) => { a.payload.request.hash = '0'.repeat(64); }, 'receipt-invalid');
  await mut('request nonce', (a) => { a.payload.request.nonce = 'cd'.repeat(16); }, 'receipt-invalid');
  await mut('owner', (a) => { a.payload.owner = stranger.pub; }, 'receipt-invalid');
  await mut('coin', (a) => { a.payload.coin = 'MWC'; }, 'receipt-invalid');
  await mut('network', (a) => { a.payload.network = 'chainblock-labs29-domain-atlas.co.za'; }, 'receipt-invalid');
  await mut('account', (a) => { a.payload.account = accountOf(NET, 'GOPH', stranger.pub); }, 'receipt-invalid');
  await mut('statement time', (a) => { a.payload.observedAt = iso(now - 30000); }, 'receipt-invalid');
  await mut('state', (a) => { a.payload.state = { sequence: '0', asOf: a.payload.observedAt }; }, 'receipt-invalid');
  await mut('state status', (a) => { a.payload.state.status = 'committed'; }, 'receipt-invalid');
  await mut('type', (a) => { a.payload.type = 'atlas.ledger.balance'; }, 'receipt-invalid');
  await mut('version', (a) => { a.payload.v = 2; }, 'receipt-invalid');
  await mut('signature', (a) => { a.signature = a.signature.slice(0, -2) + (a.signature.endsWith('AA') ? 'BB' : 'AA'); }, 'receipt-invalid');
  await mut('signature (cut short)', (a) => { a.signature = a.signature.slice(0, 80); }, 'receipt-invalid');
  await mut('signature (non-canonical spelling)', (a) => { a.signature = a.signature + '='; }, 'receipt-invalid');
  await mut('contract name', (a) => { a.contract = 'chainblock-ledger29/experimental'; }, 'receipt-invalid');
  await mut('ok flag', (a) => { a.ok = 'true'; }, 'receipt-invalid');
  await mut('by an unknown payload field', (a) => { a.payload.spendable = true; }, 'receipt-invalid');
  await mut('by an unknown outer field', (a) => { a.verified = true; }, 'receipt-invalid');
  await mut('by an unknown field in request', (a) => { a.payload.request.extra = 1; }, 'receipt-invalid');
  await mut('by a missing field', (a) => { delete a.payload.observedAt; }, 'receipt-invalid');
  await mut('by a legacy-style verification claim', (a) => { a.payload.verifiedRequest = true; a.payload.balanceProof = 'TLS-only'; }, 'receipt-invalid');
  check('...and the untouched copy still passes', (await verify({ answer: base, request: req })).ok === true);

  console.log('--- a validly signed receipt that is not for this request, owner or account ---');
  const req2 = await request({ nonce: 'ef'.repeat(16) });
  r = await verify({ answer: good, request: req2 });
  check('a genuine receipt for an earlier request is not accepted for a later one', refused(r, 'receipt-invalid'), r);
  const reqOther = await request({ issuedAt: iso(now + 1000) });
  r = await verify({ answer: good, request: reqOther });
  check('...even when only the time in the request differs (the hash covers it)', refused(r, 'receipt-invalid'), r);
  const strangerReq = { payload: req.payload, proof: { publicKey: stranger.pub, signature: await stranger.sign(req.payload) } };
  r = await verify({ answer: good, request: strangerReq });
  check('a receipt shown with another identity\'s proof is not accepted', refused(r, 'receipt-invalid'), r);
  const strangerTarget = Object.assign({}, target, { ownerPublicKey: stranger.pub, accountId: accountOf(NET, 'GOPH', stranger.pub) });
  r = await verify({ answer: good, request: req, target: strangerTarget });
  check('a receipt for one identity is not accepted for another account in the wallet', refused(r, 'receipt-invalid'), r);
  const strangerReceipt = await receipt(req, (p) => { p.owner = stranger.pub; p.account = accountOf(NET, 'GOPH', stranger.pub); });
  r = await verify({ answer: strangerReceipt, request: req });
  check('a genuine receipt for somebody else\'s account (validly signed) is not accepted', refused(r, 'receipt-invalid'), r);
  const mwcTarget = Object.assign({}, target, { coin: 'MWC', accountId: accountOf(NET, 'MWC', owner.pub) });
  r = await verify({ answer: good, request: req, target: mwcTarget });
  check('the same owner\'s GOPH receipt is not accepted for the MWC account', refused(r, 'receipt-invalid'), r);
  const otherDomainTarget = Object.assign({}, target, { issuerDomain: 'domain-atlas.co.za', network: 'chainblock-labs29-domain-atlas.co.za', accountId: accountOf('chainblock-labs29-domain-atlas.co.za', 'GOPH', owner.pub) });
  r = await verify({ answer: good, request: req, target: otherDomainTarget });
  check('a receipt from one host is not accepted for the same owner and coin on the other', refused(r, 'receipt-invalid'), r);
  r = await verify({ answer: good, request: await request({ audience: 'https://' + HOST + '/chain-labs/ledger29.php?action=balance', type: 'atlas.ledger.balance' }) });
  check('a Labs 29 request is not a request a receipt can answer', refused(r, 'receipt-invalid'), r);
  r = await verify({ answer: good, request: Object.assign({}, req, { payload: Object.assign({}, req.payload, { audience: 'https://domain-atlas.co.za/atlas/ledger/balance-receipt' }) }) });
  check('a request for another operation address is not answered by this receipt', refused(r, 'receipt-invalid'), r);
  r = await verify({ answer: good, request: req, target: Object.assign({}, target, { accountId: accountOf(NET, 'GOPH', stranger.pub) }) });
  check('a credential whose id is not the derived one is refused', refused(r, 'receipt-invalid'), r);

  console.log('--- time ---');
  const at = async (ms, nowMs) => verify({ answer: await receipt(req, (p) => { p.observedAt = iso(ms); }), request: req, now: nowMs });
  check('a statement 119 seconds from the request time is accepted', (await at(now + 119000, now + 119000)).ok === true);
  check('a statement 121 seconds before the request is refused', refused(await at(now - 121000, now), 'receipt-invalid'));
  check('a statement 121 seconds after the request is refused', refused(await at(now + 121000, now + 121000), 'receipt-invalid'));
  check('a statement from the future of this device\'s clock is refused', refused(await at(now + 110000, now - 20000), 'receipt-invalid'));
  check('a statement more than five minutes old is refused (a held-back or cached answer)', refused(await verify({ answer: good, request: req, now: now + 301000 }), 'receipt-invalid'));
  const withMs = await receipt(req, (p) => { p.observedAt = new Date(now).toISOString(); });
  check('a statement time with milliseconds is refused (one spelling only)', refused(await verify({ answer: withMs, request: req }), 'receipt-invalid'));
  check('an unreadable statement time is refused', refused(await verify({ answer: await receipt(req, (p) => { p.observedAt = 'today'; }), request: req }), 'receipt-invalid'));

  console.log('--- who may sign ---');
  const otherSigned = await receipt(req, null, null, other);
  r = await verify({ answer: otherSigned, request: req });
  check('a receipt signed by a key the issuer does not publish is refused, however well it is signed', refused(r, 'signer-unknown'), r);
  r = await verify({ answer: await receipt(req, null, (a) => { a.signerKey = other.pub; }), request: req, keyDoc: { keys: keyDoc.keys.concat([{ publicKey: other.pub, validFrom: iso(now - 3600000), validUntil: null }]) } });
  check('naming a published key that did not sign it is refused (signature check uses the published key)', refused(r, 'receipt-invalid'), r);
  check('the response\'s own signer field is not a trust root: the same receipt passes only when the document lists it', (await verify({ answer: otherSigned, request: req, keyDoc: { keys: [{ publicKey: other.pub, validFrom: iso(now - 3600000), validUntil: null }] } })).ok === true);
  r = await verify({ answer: good, request: req, keyDoc: { keys: [] } });
  check('an empty key document refuses', refused(r, 'signer-unknown'), r);
  r = await verify({ answer: good, request: req, keyDoc: { keys: 'x' } });
  check('a key document without a list of keys refuses', refused(r, 'signer-unknown'), r);
  r = await verify({ answer: good, request: req, keyDoc: { keys: [{ publicKey: issuer.pub, validFrom: iso(now - 3600000), validUntil: iso(now - 1000) }] } });
  check('a key that has expired refuses', refused(r, 'signer-unknown'), r);
  r = await verify({ answer: good, request: req, keyDoc: { keys: [{ publicKey: issuer.pub, validFrom: iso(now + 60000), validUntil: null }] } });
  check('a key that is not valid yet refuses', refused(r, 'signer-unknown'), r);
  r = await verify({ answer: good, request: req, keyDoc: { keys: [{ publicKey: issuer.pub, validFrom: iso(now - 3600000), validUntil: iso(now + 1000) }] } });
  check('a key that is valid now and was valid at the statement time is accepted', r.ok === true, r);
  r = await verify({ answer: good, request: req, keyDoc: { keys: [{ publicKey: issuer.pub, validFrom: iso(now + 1000), validUntil: null }] } });
  check('a key that only became valid after the statement refuses', refused(r, 'signer-unknown'), r);
  r = await verify({ answer: good, request: req, keyDoc: { keys: [{ publicKey: issuer.pub, validFrom: iso(now - 3600000), validUntil: iso(now) }] } });
  check('a key whose validity ends at the statement time refuses', refused(r, 'signer-unknown'), r);
  r = await verify({ answer: good, request: req, keyDoc: { keys: [{ publicKey: issuer.pub, validFrom: 'whenever', validUntil: null }] } });
  check('a key entry with an unreadable start refuses', refused(r, 'signer-unknown'), r);
  r = await verify({ answer: good, request: req, revocations: { revoked: [{ id: issuer.pub }] } });
  check('a key the issuer lists as revoked refuses', refused(r, 'signer-unknown'), r);
  r = await verify({ answer: good, request: req, revocations: { revoked: [{ id: target.accountId }] } });
  check('an account the issuer lists as revoked refuses', refused(r, 'account-revoked'), r);
  r = await verify({ answer: good, request: req, revocations: { revoked: [{ id: 'urn:atlas:ledger-account:' + 'ab'.repeat(32) }, null, 5] } });
  check('revocations for other accounts, and junk entries, do not matter', r.ok === true, r);
  check('a malformed signer key is refused', refused(await verify({ answer: await receipt(req, null, (a) => { a.signerKey = 'short'; }), request: req }), 'receipt-invalid'));

  console.log('--- the adapter ---');
  const adapter = A.createAdapter();
  check('it names the experimental signed contract and is marked signed', adapter.contract === 'chainblock-ledger38/signed-receipt-experimental' && adapter.experimental === true && adapter.signed === true && /experimental/.test(adapter.label), adapter.label);
  check('it asks only for raw P-256 proofs and for its one request type', JSON.stringify(adapter.proofFormats) === '["raw-ecdsa-p256"]' && JSON.stringify(adapter.requestTypes) === '["atlas.ledger.balance-receipt.request"]');
  check('it serves an exact account on the Labs hosts', adapter.supports(target) && adapter.supports({ issuerDomain: 'domain-atlas.co.za', network: 'chainblock-labs29-domain-atlas.co.za', coin: 'GOPH' }));
  check('it does not serve another domain, another host\'s network or a bad coin', !adapter.supports({ issuerDomain: 'example.com', network: 'chainblock-labs29-example.com', coin: 'GOPH' }) && !adapter.supports(Object.assign({}, target, { network: 'chainblock-labs29-domain-atlas.co.za' })) && !adapter.supports(Object.assign({}, target, { coin: 'goph' })));
  check('it does not take part in searching for accounts in general', !adapter.supports({ issuerDomain: HOST, network: null, coin: null }) && typeof adapter.listAccounts === 'undefined');
  check('it owns only the receipt address', adapter.ownsOperation(URL_) && !adapter.ownsOperation('https://' + HOST + '/chain-labs/ledger29.php?action=balance') && !adapter.ownsOperation('https://example.com/atlas/ledger/balance-receipt') && !adapter.ownsOperation(null));

  const status = (over) => Object.assign({ ok: true, contract: A.CONTRACT, operation: URL_, network: NET, requestType: 'atlas.ledger.balance-receipt.request', receiptType: 'atlas.ledger.balance-receipt', state: 'no-state-version', signedDiscovery: false, ledgerStorage: 'readable' }, over || {});
  const ctxFor = (fetchImpl, signAs) => {
    const log = { fetches: [], signed: [] };
    return { log, fetch: async (url, init) => { log.fetches.push({ url, init: init || {} }); return fetchImpl(url, init || {}); }, sign: async (p) => { log.signed.push(p); const k = signAs || owner; return { publicKey: k.pub, signature: await k.sign(p) }; }, signal: new AbortController().signal };
  };
  let ctx = ctxFor(async () => json(status()));
  let found = await adapter.discover(target, ctx);
  check('discovery reads one GET at the one derived address', ctx.log.fetches.length === 1 && ctx.log.fetches[0].url === URL_ && ctx.log.fetches[0].init.method === 'GET');
  check('...and returns only that operation, unsigned, appointing no key', JSON.stringify(found) === JSON.stringify({ operations: { balance: URL_ }, discoverySigned: false }), found);
  ctx = ctxFor(async () => json(status({ signerKey: other.pub, publicKey: other.pub, keys: [{ publicKey: other.pub }] })));
  found = await adapter.discover(target, ctx);
  check('a status document that offers a key is ignored for authority: nothing of it is returned', !JSON.stringify(found).includes(other.pub));
  const dfail = async (name, doc, code, status) => { const c = ctxFor(async () => json(doc, status)); const out = await adapter.discover(target, c).then(() => ({ threw: false }), (e) => ({ threw: true, code: e.code })); check(name, out.threw && out.code === code, out); };
  await dfail('a service that is switched off is its own problem', { ok: false, code: 'disabled' }, 'receipts-off', 404);
  await dfail('another contract is refused', status({ contract: 'chainblock-ledger29/experimental' }), 'bad-response');
  await dfail('another network is refused', status({ network: 'chainblock-labs29-domain-atlas.co.za' }), 'bad-response');
  await dfail('another operation address is refused', status({ operation: 'https://evil.example/atlas/ledger/balance-receipt' }), 'bad-response');
  await dfail('the Labs 29 address is refused', status({ operation: 'https://' + HOST + '/chain-labs/ledger29.php?action=balance' }), 'bad-response');
  await dfail('another request type is refused', status({ requestType: 'atlas.ledger.balance' }), 'bad-response');
  await dfail('a claim of a committed state is refused', status({ state: 'committed' }), 'bad-response');
  await dfail('an ok:false answer is refused', { ok: false }, 'bad-response', 400);
  await dfail('a server error is a network problem', { ok: false }, 'network', 503);

  const answerBody = await receipt(req);
  let seen = null;
  ctx = ctxFor(async (url, init) => { seen = JSON.parse(init.body); const rq = seen; return json(await receipt({ payload: rq.payload, proof: rq.proof })); });
  const got = await adapter.fetchBalance(target, { operations: { balance: URL_ } }, ctx);
  check('the request goes to the one address, once, as a POST', ctx.log.fetches.length === 1 && ctx.log.fetches[0].url === URL_ && ctx.log.fetches[0].init.method === 'POST');
  check('the body is exactly a payload and a proof', JSON.stringify(Object.keys(seen).sort()) === '["payload","proof"]' && JSON.stringify(Object.keys(seen.proof).sort()) === '["publicKey","signature"]');
  check('the signed message has exactly the seven fields and no quantity of any kind', JSON.stringify(Object.keys(seen.payload).sort()) === '["audience","coin","issuedAt","network","nonce","type","v"]' && seen.payload.type === 'atlas.ledger.balance-receipt.request' && seen.payload.audience === URL_ && seen.payload.network === NET && seen.payload.coin === 'GOPH' && /^[a-f0-9]{32}$/.test(seen.payload.nonce));
  check('it is signed by the account\'s owner through the wallet\'s signer', ctx.log.signed.length === 1 && seen.proof.publicKey === owner.pub);
  check('the answer comes back as evidence, with the request it answers, not as a verified result', got.receipt && got.receipt.request.payload.nonce === seen.payload.nonce && got.receipt.answer.contract === A.CONTRACT && !('verification' in got) && !('signed' in got));
  check('...and the provisional figures are the answer\'s own', got.amount === '4200000' && got.decimals === 6 && got.asOf === got.receipt.answer.payload.observedAt);
  check('the check accepts what the adapter returned', (await A.checkReceipt({ answer: got.receipt.answer, request: got.receipt.request, target, keyDoc, revocations: noRevocations, now: Date.now() })).ok === true);
  let t1 = null, t2 = null;
  ctx = ctxFor(async () => json({ ok: true }));
  t1 = await adapter.fetchBalance(target, { operations: { balance: URL_ } }, ctx).then(() => ({ threw: false }), (e) => ({ threw: true, code: e.code }));
  check('an ok answer without a receipt is refused as an invalid receipt', t1.threw && t1.code === 'receipt-invalid', t1);
  for (const [name, found2] of [['a different address', { operations: { balance: 'https://evil.example/atlas/ledger/balance-receipt' } }], ['the Labs 29 address', { operations: { balance: 'https://' + HOST + '/chain-labs/ledger29.php?action=balance' } }], ['no address', {}]]) {
    ctx = ctxFor(async () => json({}));
    t2 = await adapter.fetchBalance(target, found2, ctx).then(() => ({ threw: false }), (e) => ({ threw: true, code: e.code }));
    check('it refuses to send to ' + name + ' and sends nothing', t2.threw && ctx.log.fetches.length === 0 && ctx.log.signed.length === 0, t2);
  }
  ctx = ctxFor(async () => json({}), stranger);
  t2 = await adapter.fetchBalance(target, { operations: { balance: URL_ } }, ctx).then(() => ({ threw: false }), (e) => ({ threw: true, code: e.code }));
  check('a signer that is not the account\'s owner is refused before anything is sent', t2.threw && t2.code === 'wrong-identity' && ctx.log.fetches.length === 0, t2);
  const codes = { 'disabled': ['receipts-off', 404], 'issuer-key-unavailable': ['receipt-unavailable', 503], 'ledger-unavailable': ['receipt-unavailable', 502], 'ledger-mismatch': ['receipt-unavailable', 502], 'account-not-found': ['not-found', 404], 'account-revoked': ['account-revoked', 409], 'unknown-coin': ['unknown-coin', 404], 'replayed-request': ['busy', 409], 'stale-request': ['clock', 401], 'bad-signature': ['unauthorized', 401], 'unsupported-proof': ['proof-unsupported', 401], 'rate-limited': ['rate-limited', 429], 'unknown-network': ['not-supported', 400] };
  for (const [code, [want, st]] of Object.entries(codes)) {
    ctx = ctxFor(async () => json({ ok: false, code }, st));
    const out = await adapter.fetchBalance(target, { operations: { balance: URL_ } }, ctx).then(() => ({ threw: false }), (e) => ({ threw: true, code: e.code }));
    check('the issuer\'s "' + code + '" becomes the wallet\'s "' + want + '"', out.threw && out.code === want, out);
  }
  ctx = ctxFor(async () => json({ ok: false, code: 'surprise' }, 400));
  t1 = await adapter.fetchBalance(target, { operations: { balance: URL_ } }, ctx).then(() => ({ threw: false }), (e) => ({ threw: true, code: e.code }));
  check('an unknown code is a bad answer, not a guess', t1.threw && t1.code === 'bad-response', t1);
  ctx = ctxFor(async () => new Response('x'.repeat(20000), { status: 200 }));
  t1 = await adapter.fetchBalance(target, { operations: { balance: URL_ } }, ctx).then(() => ({ threw: false }), (e) => ({ threw: true, code: e.code }));
  check('an oversized answer is refused', t1.threw && t1.code === 'bad-response', t1);

  console.log('--- the module cannot do anything by itself ---');
  const src = fs.readFileSync(path.join(__dirname, '..', 'extension', 'ledger-labs38.js'), 'utf8').replace(/\/\/.*$/gm, '');
  check('it has no network, storage or signing-key access of its own', !/\bfetch\(|XMLHttpRequest|chrome\.|localStorage|sessionStorage|indexedDB|importKey\('(pkcs8|jwk)'|\.sign\(/.test(src.replace(/ctx\.fetch\(|ctx\.sign\(/g, '')), 'found');
  check('it never reads the legacy Labs 29 proof or verification fields as evidence', !/verifiedRequest|balanceProof/.test(src));
  process.exit(E.finish('manual-ledger-labs38-adapter'));
})().catch((e) => { console.error(e); process.exit(1); });
