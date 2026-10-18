// The experimental Labs 29 adapter (extension/ledger-labs29.js) on its own: what it accepts from a
// discovery answer, what it sends, and what it refuses in a balance answer. No browser and no
// network: the ctx it is given is a fake whose fetch returns canned answers.
//
// The answers are written to match the Labs 29 prototype's documented shapes. They show that the
// adapter checks what it should; they are not the prototype itself (see manual-ledger-labs29-php.js
// for that).
// Run: node test/manual-ledger-labs29-adapter.js
'use strict';
const path = require('path');
const { webcrypto } = require('crypto');
const A = require(path.resolve(__dirname, '..', 'extension', 'ledger-labs29.js'));

let passes = 0, failures = 0;
const failed = [];
function check(name, ok, detail) {
  if (ok) { passes++; console.log('PASS ' + name); }
  else { failures++; failed.push(name); console.log('FAIL ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : '')); }
}

const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const point = webcrypto.getRandomValues(new Uint8Array(65)); point[0] = 4;
const OWNER = b64(point);
const otherPoint = webcrypto.getRandomValues(new Uint8Array(65)); otherPoint[0] = 4;
const OTHER = b64(otherPoint);
const HOST = 'evtec.co.za';
const NET = 'chainblock-labs29-' + HOST;
const DISC = 'https://' + HOST + '/chain-labs/ledger29.php?action=discovery';
const BAL = 'https://' + HOST + '/chain-labs/ledger29.php?action=balance';
const target = { issuerDomain: HOST, network: NET, coin: 'GOPH', ownerPublicKey: OWNER };

const json = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
const discoveryDoc = (over) => Object.assign({ ok: true, contract: A.CONTRACT, endpoint: 'https://' + HOST + '/chain-labs/ledger29.php', operations: { balance: BAL }, network: NET, issuer: HOST, signedDiscovery: false, warning: 'Experimental' }, over || {});
const balanceDoc = (over) => Object.assign({ ok: true, amount: '1250', decimals: 2, asOf: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), network: NET, coin: 'GOPH', ownerKey: OWNER, verifiedRequest: true, balanceProof: 'TLS-only; signed ledger-state receipts not yet implemented', warning: 'Labs 29 prototype; no finality' }, over || {});

// A fake ctx. `fetchImpl(url, init)` answers; every call is recorded. `signAs` is the key the fake
// identity claims to sign with.
function makeCtx(fetchImpl, signAs) {
  const log = { fetches: [], signed: [] };
  return {
    log,
    fetch: async (url, init) => { log.fetches.push({ url, init: init || {} }); return fetchImpl(url, init || {}); },
    sign: async (payload) => { log.signed.push(payload); return { signerRole: 'raw-ecdsa', publicKey: signAs || OWNER, signature: b64(webcrypto.getRandomValues(new Uint8Array(64))) }; },
    signal: new AbortController().signal
  };
}

async function fails(promise, code) {
  try { await promise; return { threw: false }; } catch (err) { return { threw: true, code: err && err.code, ok: !code || (err && err.code === code) }; }
}

(async () => {
  const adapter = A.createAdapter();

  console.log('--- what it serves ---');
  check('it names the experimental contract, a label and proof formats', adapter.contract === 'chainblock-ledger29/experimental' && adapter.experimental === true && /experimental/.test(adapter.label) && JSON.stringify(adapter.proofFormats) === '["raw-ecdsa-p256"]');
  check('it serves the two Labs domains on their own networks', adapter.supports(target) && adapter.supports({ issuerDomain: 'domain-atlas.co.za', network: 'chainblock-labs29-domain-atlas.co.za', coin: 'MWC' }));
  check('it does not serve another domain', !adapter.supports({ issuerDomain: 'example.com', network: 'chainblock-labs29-example.com', coin: 'GOPH' }));
  check('it does not serve a domain with the other domain\'s network', !adapter.supports({ issuerDomain: HOST, network: 'chainblock-labs29-domain-atlas.co.za', coin: 'GOPH' }));
  check('it does not serve a coin id the service could not list', !adapter.supports(Object.assign({}, target, { coin: 'goph' })) && !adapter.supports(Object.assign({}, target, { coin: 'G' })));
  check('it can be asked about a domain in general (network and coin unknown)', adapter.supports({ issuerDomain: HOST, network: null, coin: null }));
  check('it offers no account listing, because the service has no recovery', typeof adapter.listAccounts === 'undefined');

  console.log('--- discovery ---');
  let ctx = makeCtx(async () => json(discoveryDoc()));
  let found = await adapter.discover(target, ctx);
  check('a matching discovery answer yields the one balance address', found.operations.balance === BAL && Object.keys(found.operations).join() === 'balance');
  check('discovery is fetched with GET from the issuing host only', ctx.log.fetches.length === 1 && ctx.log.fetches[0].url === DISC && ctx.log.fetches[0].init.method === 'GET');
  check('the answer is recorded as not signed', found.discoverySigned === false);
  check('discovery signs nothing', ctx.log.signed.length === 0);

  const discoveryCases = [
    ['another operation path', discoveryDoc({ operations: { balance: 'https://' + HOST + '/chain-labs/other.php?action=balance' } })],
    ['a different query', discoveryDoc({ operations: { balance: 'https://' + HOST + '/chain-labs/ledger29.php?action=transfer' } })],
    ['another host', discoveryDoc({ operations: { balance: 'https://evil.example/chain-labs/ledger29.php?action=balance' } })],
    ['a plain http address', discoveryDoc({ operations: { balance: 'http://' + HOST + '/chain-labs/ledger29.php?action=balance' } })],
    ['the other Labs domain', discoveryDoc({ operations: { balance: 'https://domain-atlas.co.za/chain-labs/ledger29.php?action=balance' } })],
    ['an address with credentials', discoveryDoc({ operations: { balance: 'https://u:p@' + HOST + '/chain-labs/ledger29.php?action=balance' } })],
    ['an address with a fragment', discoveryDoc({ operations: { balance: BAL + '#x' } })],
    ['a spelling of the address that differs in case', discoveryDoc({ operations: { balance: BAL.replace('ledger29', 'LEDGER29') } })],
    ['no operations', discoveryDoc({ operations: undefined })],
    ['operations that are not an object', discoveryDoc({ operations: BAL })],
    ['a balance address that is not text', discoveryDoc({ operations: { balance: { url: BAL } } })],
    ['a different issuer', discoveryDoc({ issuer: 'domain-atlas.co.za' })],
    ['a different network', discoveryDoc({ network: 'chainblock-labs29-domain-atlas.co.za' })],
    ['a different contract', discoveryDoc({ contract: 'something-else/1' })],
    ['ok: false', discoveryDoc({ ok: false })]
  ];
  for (const [label, doc] of discoveryCases) {
    const r = await fails(adapter.discover(target, makeCtx(async () => json(doc))), 'bad-response');
    check('discovery naming ' + label + ' is refused as a bad answer', r.threw && r.ok, r);
  }
  check('discovery that is not JSON is refused', (await fails(adapter.discover(target, makeCtx(async () => new Response('<html>', { status: 200 }))), 'bad-response')).ok);
  check('an oversized discovery answer is refused', (await fails(adapter.discover(target, makeCtx(async () => new Response(JSON.stringify(discoveryDoc({ pad: 'x'.repeat(9000) })), { status: 200 }))), 'bad-response')).ok);
  check('a server error on discovery is a network problem', (await fails(adapter.discover(target, makeCtx(async () => json({ ok: false }, 503))), 'network')).ok);

  console.log('--- the request it sends ---');
  let seen = null;
  ctx = makeCtx(async (url, init) => { seen = { url, init, body: JSON.parse(init.body) }; return json(balanceDoc()); });
  const r1 = await adapter.fetchBalance(target, { operations: { balance: BAL } }, ctx);
  check('the balance is posted to the exact operation address', seen.url === BAL && seen.init.method === 'POST');
  check('the payload has exactly the agreed fields', JSON.stringify(Object.keys(seen.body.payload).sort()) === JSON.stringify(['audience', 'coin', 'issuedAt', 'network', 'nonce', 'type', 'v']));
  check('the audience is the exact operation address', seen.body.payload.audience === BAL);
  check('the type, version, network and coin are right', seen.body.payload.type === 'atlas.ledger.balance' && seen.body.payload.v === 1 && seen.body.payload.network === NET && seen.body.payload.coin === 'GOPH');
  check('the nonce is 32 lowercase hex characters, and a new one each time', /^[a-f0-9]{32}$/.test(seen.body.payload.nonce) && await (async () => { const first = seen.body.payload.nonce; await adapter.fetchBalance(target, { operations: { balance: BAL } }, makeCtx(async (u, i) => { seen = { body: JSON.parse(i.body) }; return json(balanceDoc()); })); return first !== seen.body.payload.nonce; })());
  check('the time is an ISO time near now', Math.abs(Date.now() - Date.parse(seen.body.payload.issuedAt)) < 5000);
  ctx = makeCtx(async (url, init) => { seen = { url, init, body: JSON.parse(init.body) }; return json(balanceDoc()); });
  await adapter.fetchBalance(target, { operations: { balance: BAL } }, ctx);
  check('only the public key and signature go in the proof', JSON.stringify(Object.keys(seen.body.proof).sort()) === '["publicKey","signature"]' && seen.body.proof.publicKey === OWNER);
  check('the owner key is sent in its canonical spelling', Buffer.from(seen.body.proof.publicKey, 'base64url').length === 65 && b64(Buffer.from(seen.body.proof.publicKey, 'base64url')) === seen.body.proof.publicKey);
  check('the payload was handed to the wallet to sign, and is the one sent', ctx.log.signed.length === 1 && JSON.stringify(ctx.log.signed[0]) === JSON.stringify(seen.body.payload));
  check('a good answer yields the amount, decimals and time only', JSON.stringify(Object.keys(r1).sort()) === '["amount","asOf","decimals"]' && r1.amount === '1250' && r1.decimals === 2);
  check('the service\'s own verifiedRequest and balanceProof fields are not passed on as proof', !('verifiedRequest' in r1) && !('balanceProof' in r1));

  console.log('--- the wrong identity ---');
  let sent = 0;
  let r = await fails(adapter.fetchBalance(target, { operations: { balance: BAL } }, makeCtx(async () => { sent++; return json(balanceDoc()); }, OTHER)), 'wrong-identity');
  check('a proof from a different key than the account\'s owner is not sent', r.threw && r.ok && sent === 0, r);
  r = await fails(adapter.fetchBalance(Object.assign({}, target, { ownerPublicKey: null }), { operations: { balance: BAL } }, makeCtx(async () => { sent++; return json(balanceDoc()); })), 'wrong-identity');
  check('a target without an owner key sends nothing', r.threw && r.ok && sent === 0, r);
  r = await fails(adapter.fetchBalance(target, { operations: { balance: 'https://' + HOST + '/chain-labs/ledger29.php?action=discovery' } }, makeCtx(async () => { sent++; return json(balanceDoc()); })), 'bad-response');
  check('an altered balance address is refused before anything is signed or sent', r.threw && r.ok && sent === 0, r);
  const noSignCtx = makeCtx(async () => json(balanceDoc()));
  await fails(adapter.fetchBalance(target, { operations: { balance: 'https://evil.example/x' } }, noSignCtx));
  check('...and nothing was signed for it', noSignCtx.log.signed.length === 0);

  console.log('--- answers that are not this account\'s balance ---');
  const answerCases = [
    ['another owner key', balanceDoc({ ownerKey: OTHER })],
    ['no owner key', balanceDoc({ ownerKey: undefined })],
    ['a non-canonical spelling of the owner key', balanceDoc({ ownerKey: OWNER.slice(0, -1) + (() => { const alph = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'; return alph[alph.indexOf(OWNER.slice(-1)) ^ 1]; })() })],
    ['another coin', balanceDoc({ coin: 'MWC' })],
    ['another network', balanceDoc({ network: 'chainblock-labs29-domain-atlas.co.za' })],
    ['a number for the amount', balanceDoc({ amount: 1250 })],
    ['a negative amount', balanceDoc({ amount: '-5' })],
    ['a fractional amount', balanceDoc({ amount: '12.5' })],
    ['an amount with an exponent', balanceDoc({ amount: '1e9' })],
    ['an overlong amount', balanceDoc({ amount: '9'.repeat(41) })],
    ['an empty amount', balanceDoc({ amount: '' })],
    ['decimals as text', balanceDoc({ decimals: '2' })],
    ['negative decimals', balanceDoc({ decimals: -1 })],
    ['too many decimals', balanceDoc({ decimals: 19 })],
    ['no time', balanceDoc({ asOf: undefined })],
    ['a time that is not a time', balanceDoc({ asOf: 'soon' })],
    ['a time an hour ahead', balanceDoc({ asOf: new Date(Date.now() + 3600000).toISOString() })],
    ['ok: false with a 200', balanceDoc({ ok: false })],
    ['no ok at all', (() => { const d = balanceDoc(); delete d.ok; return d; })()]
  ];
  for (const [label, doc] of answerCases) {
    const x = await fails(adapter.fetchBalance(target, { operations: { balance: BAL } }, makeCtx(async () => json(doc))), 'bad-response');
    check('an answer with ' + label + ' is refused as a bad answer', x.threw && x.ok, x);
  }
  r = await fails(adapter.fetchBalance(target, { operations: { balance: BAL } }, makeCtx(async () => new Response('<html>oops</html>', { status: 200 }))), 'bad-response');
  check('an answer that is not JSON is refused', r.threw && r.ok, r);
  r = await fails(adapter.fetchBalance(target, { operations: { balance: BAL } }, makeCtx(async () => new Response(JSON.stringify(balanceDoc({ pad: 'x'.repeat(9000) })), { status: 200 }))), 'bad-response');
  check('an oversized answer is refused', r.threw && r.ok, r);
  const big = await adapter.fetchBalance(target, { operations: { balance: BAL } }, makeCtx(async () => json(balanceDoc({ amount: '9'.repeat(40) }))));
  check('a 40-digit amount stays exact', big.amount === '9'.repeat(40));
  const zero = await adapter.fetchBalance(target, { operations: { balance: BAL } }, makeCtx(async () => json(balanceDoc({ amount: '0', decimals: 0 }))));
  check('a zero balance is a real zero', zero.amount === '0');
  const soon = await adapter.fetchBalance(target, { operations: { balance: BAL } }, makeCtx(async () => json(balanceDoc({ asOf: new Date(Date.now() + 60000).toISOString() }))));
  check('a time a minute ahead is allowed for clock differences', typeof soon.asOf === 'string');

  console.log('--- structured errors ---');
  const expectMap = {
    'malformed-request': 'bad-response', 'unsupported-proof': 'proof-unsupported', 'bad-signature': 'unauthorized', 'stale-request': 'clock',
    'replayed-request': 'busy', 'wrong-audience': 'bad-response', 'unknown-network': 'not-supported', 'unknown-coin': 'unknown-coin',
    'no-account': 'not-found', 'rate-limited': 'rate-limited', 'unavailable': 'network'
  };
  for (const [code, want] of Object.entries(expectMap)) {
    const x = await fails(adapter.fetchBalance(target, { operations: { balance: BAL } }, makeCtx(async () => json({ ok: false, code, error: 'whatever words' }, 401))), want);
    check('the service code "' + code + '" becomes the wallet problem "' + want + '"', x.threw && x.ok, x);
  }
  r = await fails(adapter.fetchBalance(target, { operations: { balance: BAL } }, makeCtx(async () => json({ ok: false, error: 'Invalid balance challenge' }, 401))), 'bad-response');
  check('a failure with no code is a bad answer, not a guess from its words', r.threw && r.ok, r);
  r = await fails(adapter.fetchBalance(target, { operations: { balance: BAL } }, makeCtx(async () => json({ ok: false, code: 'something-new' }, 404))), 'bad-response');
  check('a code the wallet does not know is a bad answer', r.threw && r.ok, r);
  r = await fails(adapter.fetchBalance(target, { operations: { balance: BAL } }, makeCtx(async () => json({ ok: false, code: 'no-account' }, 200))), 'not-found');
  check('a failure code wins over a friendly status', r.threw && r.ok, r);
  r = await fails(adapter.fetchBalance(target, { operations: { balance: BAL } }, makeCtx(async () => json({ ok: false }, 429))), 'rate-limited');
  check('a 429 with no code means slow down', r.threw && r.ok, r);
  r = await fails(adapter.fetchBalance(target, { operations: { balance: BAL } }, makeCtx(async () => json({ ok: false }, 503))), 'network');
  check('a server error with no code is a network problem', r.threw && r.ok, r);
  r = await fails(adapter.fetchBalance(target, { operations: { balance: BAL } }, makeCtx(async () => new Response('', { status: 404 }))), 'bad-response');
  check('an empty 404 is a bad answer, not "no account"', r.threw && r.ok, r);
  r = await fails(adapter.fetchBalance(target, { operations: { balance: BAL } }, makeCtx(async () => { throw Object.assign(new Error('offline'), { code: 'network' }); })), 'network');
  check('a failure to connect passes through as it is', r.threw && r.ok, r);

  console.log('--- a stand-in on loopback for tests ---');
  const local = A.createAdapter({ hosts: ['localhost:9'], loopback: true });
  check('the test instance serves only the host it was given', local.supports({ issuerDomain: 'localhost:9', network: 'chainblock-labs29-localhost:9', coin: 'GOPH' }) && !local.supports(target));
  check('the default instance cannot be pointed at loopback', !adapter.supports({ issuerDomain: 'localhost:9', network: 'chainblock-labs29-localhost:9', coin: 'GOPH' }));
  check('the list of built-in hosts is the two Labs domains and nothing else', JSON.stringify(A.HOSTS) === '["evtec.co.za","domain-atlas.co.za"]');

  console.log('\n' + passes + ' passed, ' + failures + ' failed');
  if (failures) { console.log('Failed: ' + failed.join(' | ')); process.exit(1); }
})();
