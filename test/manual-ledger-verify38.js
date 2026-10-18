// The Core Labs 38 verifier (verify38.php, CLI only) against receipts from this repository's
// issuers: genuine ones must pass, and deliberately corrupted ones must each fail with the reason
// the verifier is meant to give. Every fixture is also run through the tests' own independent
// verifier, and the two must agree.
// Run: node test/manual-ledger-verify38.js    (needs the Core checkout: CORE_LABS_DIR)
//
// What is real: verify38.php from Core under PHP CLI; receipts from the real PHP issuer and from the
// Node test mirror; the Labs 29 databases (Core's own files when staged, else a schema stand-in).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const E = require('./call-e2e-lib');
const R = require('./ledger-receipts-lib');
const { check } = E;
const clone = (x) => JSON.parse(JSON.stringify(x));

(async () => {
  const verifier = path.join(R.CORE_DIR, 'verify38.php');
  if (!fs.existsSync(verifier)) {
    check('verify38.php is available (stage the Core checkout or set CORE_LABS_DIR)', false, verifier);
    process.exit(E.finish('manual-ledger-verify38'));
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'v38-'));
  const ledger = await R.makeLedger();
  console.log('ledger databases: ' + ledger.label);
  const owner = await R.newOwner();
  await ledger.openAccount(owner, 'GOPH');
  await ledger.seedBalance(owner.key, 'GOPH', 123456789);

  const run = (keyDoc, request, receipt) => R.runVerify38(work, keyDoc, request, receipt);
  // `coreOnly`: the corruption is in the owner's own signature or proof layout, which only the Core
  // verifier re-checks (the tests' verifier checks the receipt, and the issuer checks the proof).
  const both = async (name, keyDoc, request, receipt, wantMessage, coreOnly) => {
    const c = run(keyDoc, request, receipt);
    const mine = await R.verifyReceipt(receipt, request, keyDoc);
    const ok = c.code === 1 && wantMessage.test(c.err) && (coreOnly ? true : !mine.ok);
    check(name + ' fails (' + (c.err.trim().replace(/^FAIL: /, '') || 'no message') + ')', ok, { code: c.code, err: c.err, mine });
  };

  for (const kind of ['php', 'node']) {
    console.log('\n=== receipts from the ' + (kind === 'php' ? 'real PHP issuer' : 'Node test mirror') + ' ===');
    const iss = await R.startReceiptIssuer(kind, ledger);
    iss.enable({ perClientPerMinute: 1000, perOwnerPerHour: 1000, globalPerHour: 10000 });
    const request = await R.buildReceiptRequest(owner, 'GOPH');
    const res = await iss.post(request);
    check('the issuer answers the request', res.status === 200, res.text);
    const receipt = res.json;
    const keyDoc = iss.keyDoc();

    console.log('--- genuine ---');
    const good = run(keyDoc, request, receipt);
    check('verify38.php passes a genuine receipt', good.code === 0 && /^PASS: /.test(good.out), good);
    check('...and says what it does not prove', /LIMITATIONS/.test(good.out) && /revocation/.test(good.out) && /spendability/.test(good.out));
    check('the independent verifier agrees', (await R.verifyReceipt(receipt, request, keyDoc)).ok);
    const zeroOwner = await R.newOwner();
    await ledger.openAccount(zeroOwner, 'GOPH');
    const zreq = await R.buildReceiptRequest(zeroOwner, 'GOPH');
    const zres = await iss.post(zreq);
    check('a zero balance passes', run(keyDoc, zreq, zres.json).code === 0 && zres.json.payload.amount === '0');
    const wide = { keys: [{ publicKey: 'B' + 'A'.repeat(86), validFrom: '2020-01-01T00:00:00Z', validUntil: null }].concat(keyDoc.keys) };
    check('a key document listing several keys passes', run(wide, request, receipt).code === 0);

    console.log('--- corrupted receipt payload ---');
    const mut = async (name, fn, re) => { const c = clone(receipt); fn(c); await both('tampered ' + name, keyDoc, request, c, re); };
    await mut('amount', (c) => { c.payload.amount = '123456790'; }, /Receipt signature invalid/);
    await mut('amount (zeroed)', (c) => { c.payload.amount = '0'; }, /Receipt signature invalid/);
    await mut('amount (number)', (c) => { c.payload.amount = 123456789; }, /Invalid minor units/);
    await mut('amount (fraction)', (c) => { c.payload.amount = '123456789.5'; }, /Invalid minor units/);
    await mut('amount (leading zero)', (c) => { c.payload.amount = '0123456789'; }, /Invalid minor units/);
    await mut('decimals', (c) => { c.payload.decimals = 8; }, /Receipt signature invalid/);
    await mut('decimals (text)', (c) => { c.payload.decimals = '6'; }, /Invalid minor units/);
    await mut('request hash', (c) => { c.payload.request.hash = '0'.repeat(64); }, /Not bound/);
    await mut('request nonce', (c) => { c.payload.request.nonce = 'f'.repeat(32); }, /Not bound/);
    await mut('owner', (c) => { c.payload.owner = 'B' + 'A'.repeat(86); }, /Wrong ledger account owner/);
    await mut('coin', (c) => { c.payload.coin = 'MWC'; }, /Wrong ledger account owner or coin/);
    await mut('network', (c) => { c.payload.network = 'chainblock-labs29-domain-atlas.co.za'; }, /Wrong ledger account owner or coin/);
    await mut('account ID', (c) => { c.payload.account = 'urn:atlas:ledger-account:' + 'ab'.repeat(32); }, /Wrong derived account ID/);
    await mut('observedAt (outside the request window)', (c) => { c.payload.observedAt = '2026-01-01T00:00:00Z'; }, /freshness window/);
    await mut('observedAt (inside the window)', (c) => { c.payload.observedAt = R.iso(Date.parse(c.payload.observedAt) + 20000); }, /Receipt signature invalid|Signer not authorized/);
    await mut('state status', (c) => { c.payload.state.status = 'committed'; }, /Invalid receipt type or state claim/);
    await mut('state (sequence and asOf instead)', (c) => { c.payload.state = { sequence: '0', asOf: c.payload.observedAt }; }, /Unexpected signed payload shape/);
    await mut('state (extra field)', (c) => { c.payload.state.sequence = '0'; }, /Unexpected signed payload shape/);
    await mut('type', (c) => { c.payload.type = 'atlas.ledger.balance'; }, /Invalid receipt type/);
    await mut('version', (c) => { c.payload.v = 2; }, /Invalid receipt type/);
    await mut('payload (extra field)', (c) => { c.payload.spendable = true; }, /Unexpected signed payload shape/);
    await mut('payload (missing field)', (c) => { delete c.payload.observedAt; }, /Unexpected signed payload shape/);
    await mut('request object (extra field)', (c) => { c.payload.request.extra = 1; }, /Unexpected signed payload shape/);
    await mut('envelope (extra field)', (c) => { c.verified = true; }, /Unexpected receipt envelope/);
    await mut('envelope (ok flag)', (c) => { c.ok = 'true'; }, /Unexpected receipt envelope/);
    await mut('contract name', (c) => { c.contract = 'chainblock-ledger29/experimental'; }, /Unexpected receipt envelope/);
    await mut('signature', (c) => { c.signature = c.signature.slice(0, -2) + (c.signature.endsWith('AA') ? 'BB' : 'AA'); }, /Receipt signature invalid/);
    await mut('signature (truncated)', (c) => { c.signature = c.signature.slice(0, 60); }, /Malformed signer or receipt signature/);
    await mut('signer key (unlisted)', (c) => { c.signerKey = owner.key; }, /Signer not authorized/);
    const second = await R.newOwner();
    const withSecond = { keys: keyDoc.keys.concat([{ publicKey: second.key, validFrom: '2020-01-01T00:00:00Z', validUntil: null }]) };
    const swapped = clone(receipt); swapped.signerKey = second.key;
    await both('a listed key that did not sign', withSecond, request, swapped, /Receipt signature invalid/);

    console.log('--- the signer\'s authority ---');
    await both('an empty key document', { keys: [] }, request, receipt, /Signer not authorized/);
    await both('a key document with no keys field', {}, request, receipt, /Signer not authorized/);
    await both('a key that expired before the observation', { keys: keyDoc.keys.map((k) => Object.assign({}, k, { validUntil: R.iso(Date.parse(receipt.payload.observedAt) - 5000) })) }, request, receipt, /Signer not authorized/);
    await both('a key that starts after the observation', { keys: keyDoc.keys.map((k) => Object.assign({}, k, { validFrom: R.iso(Date.parse(receipt.payload.observedAt) + 5000) })) }, request, receipt, /Signer not authorized/);
    await both('a key whose validity ends exactly at the observation', { keys: keyDoc.keys.map((k) => Object.assign({}, k, { validUntil: receipt.payload.observedAt })) }, request, receipt, /Signer not authorized/);
    const later = { keys: keyDoc.keys.map((k) => Object.assign({}, k, { validUntil: R.iso(Date.parse(receipt.payload.observedAt) + 3600000) })) };
    check('a key still valid at the observation but ended since is accepted (it was valid when it signed)', run(later, request, receipt).code === 0);

    console.log('--- the request ---');
    const otherReq = await R.buildReceiptRequest(owner, 'GOPH');
    await both('a receipt answering a different request of the same owner', keyDoc, otherReq, receipt, /Not bound/);
    const stranger = await R.newOwner();
    await both('a receipt shown with another owner\'s request', keyDoc, await R.buildReceiptRequest(stranger, 'GOPH'), receipt, /Not bound|Wrong ledger account owner/);
    const reqMut = async (name, fn, re, coreOnly) => { const q = clone(request); fn(q); await both(name, keyDoc, q, receipt, re, coreOnly); };
    await reqMut('a request whose payload was edited after signing', (q) => { q.payload.coin = 'MWC'; }, /Request owner signature invalid/, true);
    await reqMut('a request signed by another key', (q) => { q.proof.publicKey = stranger.key; }, /Request owner signature invalid/, true);
    await reqMut('a request with a corrupted owner signature', (q) => { q.proof.signature = q.proof.signature.slice(0, -2) + (q.proof.signature.endsWith('AA') ? 'BB' : 'AA'); }, /Request owner signature invalid/, true);
    await reqMut('a request with an extra field', (q) => { q.payload.amount = '1'; }, /Malformed trusted keys or request/, true);
    await reqMut('a request with a signerRole proof', (q) => { q.proof.signerRole = 'raw-ecdsa'; }, /Malformed trusted keys or request/, true);
    await reqMut('a request for the wrong purpose', (q) => { q.payload.type = 'atlas.ledger.balance'; }, /Unexpected request purpose or audience/);
    await reqMut('a request for the Labs 29 address', (q) => { q.payload.audience = 'https://evtec.co.za/chain-labs/ledger29.php?action=balance'; }, /Unexpected request purpose or audience/);
    await reqMut('a request for an unlisted host', (q) => { q.payload.audience = 'https://example.com/atlas/ledger/balance-receipt'; }, /Unexpected request purpose or audience/);
    await reqMut('a request whose network does not match its host', (q) => { q.payload.network = 'chainblock-labs29-domain-atlas.co.za'; }, /Malformed request target, nonce or time/);
    await reqMut('a request with a bad nonce', (q) => { q.payload.nonce = 'XYZ'; }, /Malformed request target, nonce or time/);

    console.log('--- not a receipt at all ---');
    const bad = (name, k, q, rcpt, code, re) => { const f = path.join(work, 'raw.json'); fs.writeFileSync(path.join(work, 'keys.json'), k); fs.writeFileSync(path.join(work, 'request.json'), q); const c = spawnSync('php', [verifier, path.join(work, 'keys.json'), path.join(work, 'request.json')], { input: rcpt, encoding: 'utf8' }); void f; check(name + ' fails', c.status === code && re.test(c.stderr), { s: c.status, e: c.stderr }); };
    bad('a receipt that is not JSON', JSON.stringify(keyDoc), JSON.stringify(request), 'not json', 1, /Could not parse JSON input/);
    bad('an empty receipt', JSON.stringify(keyDoc), JSON.stringify(request), '', 1, /Could not parse JSON input/);
    bad('a request file that is not JSON', JSON.stringify(keyDoc), '{', JSON.stringify(receipt), 1, /Could not parse JSON input/);
    bad('an unrelated receipt-shaped document', JSON.stringify(keyDoc), JSON.stringify(request), '{"ok":true}', 1, /Unexpected receipt envelope/);
    const noargs = spawnSync('php', [verifier], { input: '', encoding: 'utf8' });
    check('missing arguments are a usage error', noargs.status === 2 && /Usage/.test(noargs.stderr));
    iss.close();
  }

  console.log('\n--- the verifier is not a web page ---');
  const web = path.join(work, 'web'); fs.mkdirSync(web); fs.copyFileSync(verifier, path.join(web, 'verify38.php'));
  const port = await R.freePort();
  const srv = spawn('php', ['-S', '127.0.0.1:' + port, '-t', web], { stdio: 'ignore' });
  await R.waitFor(port, '/');
  const w = await R.call(port, 'GET', '/verify38.php');
  check('served over HTTP it answers 404 with nothing', w.status === 404 && w.text === '', w.status + ' ' + w.text.slice(0, 60));
  const wp = await R.call(port, 'POST', '/verify38.php', '{}');
  check('...for POST too', wp.status === 404 && wp.text === '');
  srv.kill();
  ledger.close();
  fs.rmSync(work, { recursive: true, force: true });
  process.exit(E.finish('manual-ledger-verify38'));
})().catch((e) => { console.error(e); process.exit(1); });
