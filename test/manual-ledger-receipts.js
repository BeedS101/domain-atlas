// Signed ledger balance receipts, issuer side: POST /atlas/ledger/balance-receipt.
// Run: node test/manual-ledger-receipts.js
//
// What is real here: the PHP issuer (issuer-php) with its own established key; the Labs 29 ledger
// databases (made by Core's own account30.php when the Core checkout is staged, otherwise a schema
// stand-in, said in the output); signatures made and checked with WebCrypto and OpenSSL.
// What is a stand-in: the Node "issuer" is the test mirror (issuer-server/lib-ledger-receipts.js)
// behind a test front; the Node server has no receipt route.
'use strict';
const fs = require('fs');
const path = require('path');
const E = require('./call-e2e-lib');
const R = require('./ledger-receipts-lib');
const { check } = E;
const { DOMAIN, NETWORK } = R;

const BIG = { perClientPerMinute: 1000, perOwnerPerHour: 1000, globalPerHour: 10000 };

async function newFundedOwner(ledger, units, coin) {
  const o = await R.newOwner();
  await ledger.openAccount(o, coin || 'GOPH');
  if (units) await ledger.seedBalance(o.key, coin || 'GOPH', units);
  return o;
}
const codeOf = (r) => (r.json && r.json.code) || null;
const refused = (r, status, code) => r.status === status && codeOf(r) === code && !(r.json && r.json.payload) && !(r.json && r.json.signature);

async function suite(kind, ledger) {
  console.log('\n=== ' + kind.toUpperCase() + (kind === 'node' ? ' (test mirror)' : ' (real issuer)') + ' / ' + ledger.label + ' ===');
  const iss = await R.startReceiptIssuer(kind, ledger);
  const owner = await newFundedOwner(ledger, 123456789);
  const send = async (o, edit, coin) => { const req = await R.buildReceiptRequest(o, coin || 'GOPH', edit); return { req, res: await iss.post(req) }; };

  console.log('--- off by default, independent of issuance ---');
  let r = await iss.post(await R.buildReceiptRequest(owner, 'GOPH'));
  check('no configuration: the endpoint answers "disabled"', refused(r, 404, 'disabled'), r.text);
  r = await iss.call('GET', R.ROUTE);
  check('...and so does the status document', r.status === 404 && codeOf(r) === 'disabled', r.text);
  check('...and nothing was written', !fs.existsSync(iss.storePath) && !fs.existsSync(iss.configPath));
  iss.enable({ enabled: false });
  r = await iss.post(await R.buildReceiptRequest(owner, 'GOPH'));
  check('"enabled": false is off', refused(r, 404, 'disabled'));
  iss.enable({ domain: 'example.com' });
  r = await iss.post(await R.buildReceiptRequest(owner, 'GOPH'));
  check('an unlisted configured domain is a misconfiguration, not a guess', refused(r, 503, 'misconfigured'), r.text);
  fs.writeFileSync(iss.configPath, '{not json');
  r = await iss.post(await R.buildReceiptRequest(owner, 'GOPH'));
  check('an unreadable configuration stays off', refused(r, 404, 'disabled'));
  check('the credential-issuance switch does not exist here and is not consulted', !fs.existsSync(iss.issuanceConfigPath || path.join(iss.tmp, 'none')));

  iss.enable(BIG);
  console.log('--- the status document ---');
  r = await iss.call('GET', R.ROUTE);
  check('GET describes the operation', r.status === 200 && r.json.ok === true && r.json.contract === R.CONTRACT && r.json.operation === R.RECEIPT_URL && r.json.network === NETWORK && r.json.requestType === R.REQUEST_TYPE, r.text);
  check('...states there is no ledger state version and no signed discovery', r.json.state === 'no-state-version' && r.json.signedDiscovery === false);
  check('...reports that the ledger databases can be read', r.json.ledgerStorage === 'readable', r.json);
  check('...appoints no key and names no path', !/publicKey|signerKey|\.sqlite|\/tmp|private/i.test(r.text.replace(/chainblock-ledger38|ledgerStorage/g, '')), r.text);

  console.log('--- a valid receipt ---');
  const before = await ledger.balanceOf(owner.key, 'GOPH');
  let { req, res } = await send(owner);
  check('a genuine request gets a receipt', res.status === 200 && res.json.ok === true, res.text);
  const v = await R.verifyReceipt(res.json, req, iss.keyDoc());
  check('an independent check accepts it (shape, binding, account, freshness, published key, signature)', v.ok, v);
  const p = res.json.payload;
  check('the amount is the ledger figure as an integer string, with the coin\'s decimals', p.amount === '123456789' && p.decimals === 6, p);
  check('the account ID is the independently derived one, the owner is the requester', p.account === R.derivedId(NETWORK, 'GOPH', owner.key) && p.owner === owner.key);
  check('the state claim is only "no-state-version"; no sequence, no asOf', JSON.stringify(p.state) === '{"status":"no-state-version"}' && !('sequence' in p) && !('asOf' in p));
  check('observedAt is whole seconds in UTC and close to now', /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(p.observedAt) && Math.abs(Date.parse(p.observedAt) - Date.now()) < 10000, p.observedAt);
  check('the signer is the published issuer key', res.json.signerKey === iss.publishedKey());
  check('the response has exactly the five outer fields', Object.keys(res.json).sort().join() === 'contract,ok,payload,signature,signerKey');
  check('asking for a receipt did not change the ledger', (await ledger.balanceOf(owner.key, 'GOPH')) === before);
  check('the response carries no private key material', !/PRIVATE KEY|"d":/.test(res.text) && !res.text.includes(iss.privateKeyMaterial().replace(/\s+/g, '').slice(40, 80)));

  const zero = await newFundedOwner(ledger, 0);
  ({ req, res } = await send(zero));
  check('an opened account with nothing in it gets a receipt for "0"', res.status === 200 && res.json.payload.amount === '0' && (await R.verifyReceipt(res.json, req, iss.keyDoc())).ok, res.text);
  const large = await newFundedOwner(ledger, 9007199254740991);
  ({ req, res } = await send(large));
  check('a large figure keeps every digit (no floating point)', res.status === 200 && res.json.payload.amount === '9007199254740991', res.text);

  console.log('--- issuance switched off does not matter ---');
  if (iss.issuanceConfigPath) try { fs.unlinkSync(iss.issuanceConfigPath); } catch (e) { /* none */ }
  ({ res } = await send(owner));
  check('with credential issuance absent or off, receipts are still signed', res.status === 200);

  console.log('--- the request is strict ---');
  const bad = async (name, edit, status, code, coin) => { const x = await send(owner, edit, coin); check(name, refused(x.res, status, code), x.res.text); };
  await bad('an extra payload field (a client-supplied amount) is refused', { payload: (p) => { p.amount = '999'; } }, 400, 'malformed-request');
  await bad('...a client-supplied balance, credential, signer or endpoint likewise', { payload: (p) => { p.signerKey = 'x'; p.credential = {}; p.endpoint = 'x'; } }, 400, 'malformed-request');
  await bad('a missing payload field is refused', { payload: (p) => { delete p.coin; } }, 400, 'malformed-request');
  await bad('the Labs 29 request type is not accepted here', { payload: (p) => { p.type = 'atlas.ledger.balance'; } }, 400, 'malformed-request');
  await bad('the Labs 29 audience is not accepted here', { payload: (p) => { p.audience = 'https://' + DOMAIN + '/chain-labs/ledger29.php?action=balance'; } }, 401, 'wrong-audience');
  await bad('another host\'s receipt audience is refused', { payload: (p) => { p.audience = 'https://domain-atlas.co.za/atlas/ledger/balance-receipt'; } }, 401, 'wrong-audience');
  await bad('the account-credential audience is refused', { payload: (p) => { p.audience = 'https://' + DOMAIN + '/atlas/ledger/account-credential'; } }, 401, 'wrong-audience');
  await bad('another network is refused', { payload: (p) => { p.network = 'chainblock-labs29-domain-atlas.co.za'; } }, 400, 'unknown-network');
  await bad('a malformed coin is refused', { payload: (p) => { p.coin = 'goph'; } }, 400, 'malformed-request');
  await bad('a short nonce is refused', { payload: (p) => { p.nonce = 'abc'; } }, 400, 'malformed-request');
  await bad('an upper-case nonce is refused', { payload: (p) => { p.nonce = 'A'.repeat(32); } }, 400, 'malformed-request');
  await bad('version 2 is refused', { payload: (p) => { p.v = 2; } }, 400, 'malformed-request');
  await bad('a non-string field is refused', { payload: (p) => { p.nonce = 12345; } }, 400, 'malformed-request');
  await bad('a request more than two minutes old is stale', { now: Date.now() - 150000 }, 401, 'stale-request');
  await bad('a request more than two minutes ahead is stale', { now: Date.now() + 150000 }, 401, 'stale-request');
  await bad('a malformed timestamp is refused', { payload: (p) => { p.issuedAt = 'yesterday'; } }, 400, 'malformed-request');
  await bad('an unknown coin is its own answer', {}, 404, 'unknown-coin', 'NOPE');
  const odd = await R.newOwner();
  let x = await send(odd);
  check('an owner with no account is told so, and gets no receipt', refused(x.res, 404, 'account-not-found'), x.res.text);

  console.log('--- the owner proof ---');
  const other = await R.newOwner();
  await bad('a signature made by another key is refused', { signer: other }, 401, 'bad-signature');
  await bad('a signature over a changed payload is refused', { proof: (pr) => { pr.signature = pr.signature.slice(0, -2) + (pr.signature.endsWith('AA') ? 'BB' : 'AA'); } }, 401, 'bad-signature');
  await bad('an owner key that is not the one that signed is refused', { proof: (pr) => { pr.publicKey = other.key; } }, 401, 'bad-signature');
  await bad('a proof with a signerRole field (issuance style) is not this contract', { proof: (pr) => { pr.signerRole = 'raw-ecdsa'; } }, 401, 'unsupported-proof');
  await bad('a passkey-style proof is refused', { proof: (pr) => { delete pr.signature; pr.authenticatorData = 'x'; pr.clientDataJSON = 'y'; } }, 401, 'unsupported-proof');
  await bad('a non-canonical owner key is refused', { proof: (pr) => { pr.publicKey = pr.publicKey + '='; } }, 401, 'unsupported-proof');
  await bad('a signature of the wrong length is refused', { proof: (pr) => { pr.signature = pr.signature.slice(0, 80); } }, 401, 'bad-signature');
  const labs29 = await (async () => { const pl = { type: 'atlas.ledger.balance', v: 1, audience: 'https://' + DOMAIN + '/chain-labs/ledger29.php?action=balance', network: NETWORK, coin: 'GOPH', nonce: R.hex(16), issuedAt: R.iso(Date.now()) }; return { payload: pl, proof: { publicKey: owner.key, signature: await owner.sign(pl) } }; })();
  r = await iss.post(labs29);
  check('a genuine Labs 29 balance request is not a receipt request', r.status >= 400 && !(r.json && r.json.payload), r.text);
  r = await iss.post({ payload: (await R.buildReceiptRequest(owner, 'GOPH')).payload });
  check('a request without a proof is refused', r.status === 400 && codeOf(r) === 'malformed-request');
  x = await R.buildReceiptRequest(owner, 'GOPH');
  r = await iss.post(Object.assign({}, x, { extra: 1 }));
  check('an extra top-level field is refused', refused(r, 400, 'malformed-request'), r.text);
  r = await iss.post('not json');
  check('non-JSON is refused', refused(r, 400, 'malformed-request'), r.text);
  r = await iss.post(JSON.stringify(x).slice(0, -1) + ',"pad":"' + 'x'.repeat(5000) + '"}');
  check('a body over 4096 bytes is refused before parsing', r.status === 413 && !(r.json && r.json.payload), r.status + ' ' + r.text.slice(0, 80));
  r = await iss.call('PUT', R.ROUTE, x);
  check('other methods are refused', r.status === 405 && codeOf(r) === 'unknown-operation', r.text);
  r = await iss.post(x, { Host: 'domain-atlas.co.za' });
  check('a request for another hosted domain is refused', refused(r, 400, 'unknown-host'), r.text);
  r = await iss.post(x, { 'X-Forwarded-Proto': 'http' });
  if (kind === 'node') check('plain http is refused', refused(r, 403, 'https-required'), r.text);

  console.log('--- account and identity are never confused ---');
  const alice = await newFundedOwner(ledger, 5000), bob = await newFundedOwner(ledger, 7000);
  const ra = await send(alice), rb = await send(bob);
  check('two owners get their own figures and accounts', ra.res.json.payload.amount === '5000' && rb.res.json.payload.amount === '7000' && ra.res.json.payload.account !== rb.res.json.payload.account && ra.res.json.payload.owner === alice.key && rb.res.json.payload.owner === bob.key);
  check('one owner\'s receipt does not verify against the other\'s request', !(await R.verifyReceipt(ra.res.json, rb.req, iss.keyDoc())).ok && !(await R.verifyReceipt(rb.res.json, ra.req, iss.keyDoc())).ok);
  await ledger.openAccount(alice, 'MWC'); await ledger.seedBalance(alice.key, 'MWC', 42);
  const am = await send(alice, null, 'MWC');
  check('the same owner on another coin gets another account and figure', am.res.status === 200 && am.res.json.payload.amount === '42' && am.res.json.payload.account !== ra.res.json.payload.account && am.res.json.payload.coin === 'MWC');
  check('a coin\'s receipt does not verify as the other coin\'s', !(await R.verifyReceipt(am.res.json, ra.req, iss.keyDoc())).ok);

  console.log('--- tampering with a genuine receipt ---');
  const g = await send(await newFundedOwner(ledger, 777));
  const gkd = iss.keyDoc();
  const tamper = async (name, fn) => {
    const c = JSON.parse(JSON.stringify(g.res.json)); fn(c);
    const out = await R.verifyReceipt(c, g.req, gkd);
    check('tampered ' + name + ' fails', !out.ok, out);
  };
  check('the untouched copy passes', (await R.verifyReceipt(g.res.json, g.req, gkd)).ok);
  await tamper('amount', (c) => { c.payload.amount = '778'; });
  await tamper('amount (to zero)', (c) => { c.payload.amount = '0'; });
  await tamper('amount (as a number)', (c) => { c.payload.amount = 777; });
  await tamper('amount (with a fraction)', (c) => { c.payload.amount = '777.0'; });
  await tamper('decimals', (c) => { c.payload.decimals = 8; });
  await tamper('request hash', (c) => { c.payload.request.hash = '0'.repeat(64); });
  await tamper('request nonce', (c) => { c.payload.request.nonce = 'f'.repeat(32); });
  await tamper('owner', (c) => { c.payload.owner = alice.key; });
  await tamper('coin', (c) => { c.payload.coin = 'MWC'; });
  await tamper('network', (c) => { c.payload.network = 'chainblock-labs29-domain-atlas.co.za'; });
  await tamper('account', (c) => { c.payload.account = ra.res.json.payload.account; });
  await tamper('observedAt', (c) => { c.payload.observedAt = '2026-01-01T00:00:00Z'; });
  await tamper('state', (c) => { c.payload.state = { sequence: '0', asOf: c.payload.observedAt }; });
  await tamper('state status', (c) => { c.payload.state.status = 'committed'; });
  await tamper('type', (c) => { c.payload.type = 'atlas.ledger.balance'; });
  await tamper('version', (c) => { c.payload.v = 2; });
  await tamper('by an extra payload field', (c) => { c.payload.spendable = true; });
  await tamper('by an extra outer field', (c) => { c.verified = true; });
  await tamper('signature', (c) => { c.signature = c.signature.slice(0, -2) + (c.signature.endsWith('AA') ? 'BB' : 'AA'); });
  await tamper('signer (to an unlisted key)', (c) => { c.signerKey = alice.key; });
  const unsigned = JSON.parse(JSON.stringify(g.res.json)); delete unsigned.signature;
  check('a receipt without a signature fails', !(await R.verifyReceipt(unsigned, g.req, gkd)).ok);

  console.log('--- a receipt for another request ---');
  const g2 = await send(g.req.proof.publicKey === owner.key ? owner : owner);
  check('yesterday\'s receipt is not today\'s: it fails against a newer request of the same owner', !(await R.verifyReceipt(g.res.json, g2.req, gkd)).ok);
  check('...and each receipt binds the request it answered', (await R.verifyReceipt(g2.res.json, g2.req, gkd)).ok);
  const newer = await R.buildReceiptRequest(owner, 'GOPH', { now: Date.now() + 119000 });
  check('a receipt observed outside the new request\'s window fails', !(await R.verifyReceipt(g2.res.json, Object.assign({}, newer, { payload: Object.assign({}, newer.payload, { nonce: g2.req.payload.nonce }) }), gkd)).ok);

  console.log('--- replay ---');
  const rp = await R.buildReceiptRequest(await newFundedOwner(ledger, 10), 'GOPH');
  const first = await iss.post(rp), second = await iss.post(rp);
  check('the same signed request twice: the first is answered, the second refused', first.status === 200 && refused(second, 409, 'replayed-request'), second.text);
  check('the spent nonce is stored (as a hash, not the nonce itself)', (iss.store() || {}).nonces && iss.store().nonces.length >= 1 && !JSON.stringify(iss.store()).includes(rp.payload.nonce));
  const rp2 = await R.buildReceiptRequest(await newFundedOwner(ledger, 10), 'GOPH');
  const burst = await Promise.all([iss.post(rp2), iss.post(rp2), iss.post(rp2)]);
  check('three simultaneous copies of one request: exactly one receipt', burst.filter((b) => b.status === 200).length === 1 && burst.filter((b) => b.status === 409).length === 2, burst.map((b) => b.status));
  check('a request whose answer was refused as a replay does not return the first receipt', burst.filter((b) => b.status === 409).every((b) => !b.json.payload));

  console.log('--- the signing key ---');
  const keep = iss.keyDoc();
  const fresh = async (o) => (await send(o || await newFundedOwner(ledger, 1))).res;
  iss.setKeyDoc({ keys: keep.keys.map((k) => Object.assign({}, k, { validUntil: R.iso(Date.now() - 5000) })) });
  check('an expired issuer key signs nothing', refused(await fresh(), 503, 'issuer-key-unavailable'));
  iss.setKeyDoc({ keys: keep.keys.map((k) => Object.assign({}, k, { validFrom: R.iso(Date.now() + 3600000) })) });
  check('a key that is not valid yet signs nothing', refused(await fresh(), 503, 'issuer-key-unavailable'));
  iss.setKeyDoc({ keys: [] });
  check('a key the published document does not list signs nothing', refused(await fresh(), 503, 'issuer-key-unavailable'));
  iss.setKeyDoc({ keys: [Object.assign({}, keep.keys[0], { publicKey: alice.key })] });
  check('a document listing only another key signs nothing', refused(await fresh(), 503, 'issuer-key-unavailable'));
  if (kind === 'php') { fs.writeFileSync(iss.keyDocPath, '{broken'); check('an unreadable key document signs nothing', refused(await fresh(), 503, 'issuer-key-unavailable')); }
  iss.setKeyDoc(keep);
  check('restoring the published key restores receipts', (await fresh()).status === 200);
  const before2 = JSON.stringify(iss.store() && iss.store().log);
  iss.setKeyDoc({ keys: keep.keys.map((k) => Object.assign({}, k, { validUntil: R.iso(Date.now() - 5000) })) });
  await fresh();
  iss.setKeyDoc(keep);
  check('a refused request is not logged as a receipt', JSON.stringify(iss.store() && iss.store().log) === before2);
  const revId = R.derivedId(NETWORK, 'GOPH', odd.key);
  await ledger.openAccount(odd, 'GOPH');
  iss.revoke(R.derivedId(NETWORK, 'GOPH', odd.key));
  x = await send(odd);
  check('a revoked account gets no receipt', refused(x.res, 409, 'account-revoked'), x.res.text);
  check('...while others still do', (await fresh()).status === 200);

  console.log('--- the revocation list is consulted or the request is refused ---');
  {
    const revRaw = fs.readFileSync(iss.revocationsPath);
    const probe = await newFundedOwner(ledger, 5);
    const states = {
      'malformed JSON': () => fs.writeFileSync(iss.revocationsPath, '{broken'),
      'an empty file': () => fs.writeFileSync(iss.revocationsPath, ''),
      'a JSON list instead of a document': () => fs.writeFileSync(iss.revocationsPath, '[]'),
      'a document with no "revoked" list': () => fs.writeFileSync(iss.revocationsPath, '{}'),
      'a "revoked" value that is not a list': () => fs.writeFileSync(iss.revocationsPath, '{"revoked":"none"}'),
      'a path that cannot be read as a file': () => { fs.unlinkSync(iss.revocationsPath); fs.mkdirSync(iss.revocationsPath); }
    };
    for (const [name, make] of Object.entries(states)) {
      make();
      const req = await R.buildReceiptRequest(probe, 'GOPH');
      const logged = JSON.stringify(iss.store() && iss.store().log);
      const bad = await iss.post(req);
      check('revocation list is ' + name + ': refused, nothing signed', refused(bad, 503, 'revocations-unavailable'), bad.text);
      check('...and the refused request is not logged', JSON.stringify(iss.store() && iss.store().log) === logged);
      try { fs.rmSync(iss.revocationsPath, { recursive: true, force: true }); } catch (e) { /* none */ }
      fs.writeFileSync(iss.revocationsPath, revRaw);
      const again = await iss.post(req);
      check('...the same signed request still works once the list is back (its nonce was not spent)', again.status === 200, again.text);
    }
    fs.unlinkSync(iss.revocationsPath);
    const gone = await fresh();
    check('a revocation list that is missing is refused like an unreadable one, never read as empty', refused(gone, 503, 'revocations-unavailable'), gone.text);
    check('...and the issuer does not create it', !fs.existsSync(iss.revocationsPath));
    fs.writeFileSync(iss.revocationsPath, revRaw);
    x = await send(odd);
    check('a restored list still refuses the revoked account', refused(x.res, 409, 'account-revoked'), x.res.text);
    check('...and serves everyone else', (await fresh()).status === 200);
    const big = JSON.parse(revRaw.toString('utf8'));
    for (let i = 0; i < 3000; i++) big.revoked.push({ id: 'filler-' + i, revokedAt: new Date().toISOString(), reason: 'x', txn: 't' + i });
    fs.writeFileSync(iss.revocationsPath, JSON.stringify(big));
    check('a long list with journal-tagged entries is read in full', (await fresh()).status === 200);
    x = await send(odd);
    check('...and still finds the revoked account in it', refused(x.res, 409, 'account-revoked'), x.res.text);
    fs.writeFileSync(iss.revocationsPath, revRaw);
  }

  console.log('--- the ledger ---');
  const dec = await newFundedOwner(ledger, 100);
  check('a first receipt pins the coin\'s decimals', (await send(dec)).res.status === 200);
  ledger.setDecimals('GOPH', 8);
  x = await send(dec);
  check('decimals changed under a live coin: refused, nothing signed', refused(x.res, 502, 'ledger-mismatch'), x.res.text);
  ledger.setDecimals('GOPH', 99);
  x = await send(await newFundedOwner(ledger, 1));
  check('decimals out of range: refused', x.res.status === 502 && !(x.res.json && x.res.json.payload), x.res.text);
  ledger.setDecimals('GOPH', 6);
  check('with the registry back to normal, receipts resume', (await send(dec)).res.status === 200);
  if (kind === 'php') {
    const target = fs.readlinkSync(iss.privateLink);
    fs.unlinkSync(iss.privateLink);
    x = await send(owner);
    check('private folder missing: ledger-unavailable, nothing signed', refused(x.res, 502, 'ledger-unavailable'), x.res.text);
    r = await iss.call('GET', R.ROUTE);
    check('...and the status document says so', r.status === 200 && r.json.ledgerStorage === 'unavailable', r.text);
    fs.mkdirSync(iss.privateLink);
    x = await send(owner);
    check('an empty private folder: ledger-unavailable, and no database is created', refused(x.res, 502, 'ledger-unavailable') && fs.readdirSync(iss.privateLink).length === 0, x.res.text);
    fs.rmdirSync(iss.privateLink);
    fs.symlinkSync(target, iss.privateLink);
    check('with the folder back, receipts resume', (await send(owner)).res.status === 200);
    const inside = path.join(iss.copy, 'chainblock-labs-private');
    fs.rmSync(iss.privateLink); fs.symlinkSync(path.join(iss.copy), iss.privateLink);
    x = await send(owner);
    check('a private folder that is the document root itself is refused', refused(x.res, 502, 'ledger-unavailable'), x.res.text);
    fs.rmSync(iss.privateLink); fs.symlinkSync(target, iss.privateLink);
    void inside;
  } else {
    iss.readOverride = async () => { throw new Error('boom'); };
    x = await send(owner);
    check('a reader that throws: ledger-unavailable, nothing signed', refused(x.res, 502, 'ledger-unavailable'), x.res.text);
    for (const [name, reply] of [['an amount that is a number', { status: 'ok', coinId: 'c', decimals: 6, amount: 5 }], ['a negative amount', { status: 'ok', coinId: 'c', decimals: 6, amount: '-5' }], ['a fractional amount', { status: 'ok', coinId: 'c', decimals: 6, amount: '1.5' }], ['an exponent amount', { status: 'ok', coinId: 'c', decimals: 6, amount: '1e3' }], ['a leading-zero amount', { status: 'ok', coinId: 'c', decimals: 6, amount: '007' }], ['decimals as text', { status: 'ok', coinId: 'c', decimals: '6', amount: '5' }], ['a missing coin ID', { status: 'ok', decimals: 6, amount: '5' }], ['an unknown status', { status: 'maybe' }]]) {
      iss.readOverride = async () => reply;
      x = await send(await newFundedOwner(ledger, 1));
      check('the reader returning ' + name + ' signs nothing', x.res.status === 502 && !(x.res.json && x.res.json.payload), x.res.text);
    }
    iss.readOverride = null;
  }

  console.log('--- limits ---');
  iss.enable(Object.assign({}, BIG, { perOwnerPerHour: 2 }));
  const lim = await newFundedOwner(ledger, 1);
  const s1 = await send(lim), s2 = await send(lim), s3 = await send(lim);
  check('per-owner limit: two receipts, then 429 with no receipt', s1.res.status === 200 && s2.res.status === 200 && refused(s3.res, 429, 'rate-limited') && s3.res.headers['retry-after'], s3.res.text);
  const lim2 = await newFundedOwner(ledger, 1);
  check('...and another owner is not affected', (await send(lim2)).res.status === 200);
  iss.resetStore();
  iss.enable(Object.assign({}, BIG, { globalPerHour: 2 }));
  const gs = [await send(await newFundedOwner(ledger, 1)), await send(await newFundedOwner(ledger, 1)), await send(await newFundedOwner(ledger, 1))];
  check('global limit: two receipts, then 429', gs[0].res.status === 200 && gs[1].res.status === 200 && refused(gs[2].res, 429, 'rate-limited'), gs[2].res.text);
  iss.close();

  const iss2 = await R.startReceiptIssuer(kind, ledger);
  iss2.enable({ perClientPerMinute: 3, perOwnerPerHour: 1000, globalPerHour: 10000 });
  const rs = [];
  for (let i = 0; i < 5; i++) rs.push(await iss2.post(await R.buildReceiptRequest(owner, 'GOPH')));
  check('per-client limit: three requests, then 429 with Retry-After', rs.slice(0, 3).every((q) => q.status === 200) && rs[3].status === 429 && codeOf(rs[3]) === 'rate-limited' && !!rs[3].headers['retry-after'], rs.map((q) => q.status));
  check('...and refused requests cost the same slot, so invalid traffic is limited too', rs[4].status === 429);
  iss2.close();
}

(async () => {
  const ledger = await R.makeLedger();
  console.log('ledger databases: ' + ledger.label);
  try {
    await suite('php', ledger);
    await suite('node', ledger);
  } finally {
    ledger.close();
  }

  console.log('\n--- the signing surface ---');
  const phpDir = path.join(R.REPO, 'issuer-php'), nodeDir = path.join(R.REPO, 'issuer-server');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? (['node_modules', '.well-known'].includes(e.name) ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]);
  const holders = (dir, re) => walk(dir).filter((f) => /\.(php|js)$/.test(f) && re.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(R.REPO, f));
  const typeFiles = [...holders(phpDir, /atlas\.ledger\.balance-receipt/), ...holders(nodeDir, /atlas\.ledger\.balance-receipt/)];
  check('the receipt type literal lives only in the two receipt libraries', typeFiles.sort().join() === 'issuer-php/lib/ledger-receipts.php,issuer-server/lib-ledger-receipts.js', typeFiles);
  const signers = holders(phpDir, /atlas_sign\(/).filter((f) => /ledger-receipts/.test(f));
  check('the PHP receipt library calls the signer exactly once, on the one fixed payload', fs.readFileSync(path.join(phpDir, 'lib', 'ledger-receipts.php'), 'utf8').match(/atlas_sign\(/g).length === 1 && signers.length === 1);
  check('the receipt route file contains no signing code', !/atlas_sign|openssl_sign|private/.test(fs.readFileSync(path.join(phpDir, 'atlas', 'ledger', 'balance-receipt.php'), 'utf8').replace(/\/\/.*$/gm, '')));
  check('the Node server does not serve the receipt route', !/balance-receipt|lib-ledger-receipts/.test(fs.readFileSync(path.join(nodeDir, 'server.js'), 'utf8')));
  const rcpt = fs.readFileSync(path.join(phpDir, 'lib', 'ledger-receipts.php'), 'utf8').replace(/\/\/.*$/gm, '');
  check('the PHP library only reads the databases: no write statements, no create, no Core calls', !/\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|REPLACE)\b/.test(rcpt.replace(/'[^']*'/g, (m) => /SELECT/.test(m) ? m : '')) && !/curl_|file_get_contents\('http/.test(rcpt));
  check('it opens both databases read-only', (rcpt.match(/mode=ro/g) || []).length === 1 && /PRAGMA query_only=ON/.test(rcpt) && !/require.*ledger-issuance/.test(rcpt));
  process.exit(E.finish('manual-ledger-receipts'));
})().catch((e) => { console.error(e); process.exit(1); });
