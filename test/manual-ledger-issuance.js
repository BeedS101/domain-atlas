// Issuer-signed ledger-account references: the experimental issuance endpoint, run against the
// real issuers (Node and PHP) from this repository, each in a temporary copy with its own key.
//
// Ledger side, two ways:
//   - always: a STAND-IN for Core's Labs 31 listing operation (test/ledger-issuance-lib.js) that
//     can be told to lie, fail or stall. It follows Core's documented behaviour; it is not Core.
//   - when CORE_LABS_DIR names a folder holding Core's account30.php, accounts31.php (and
//     verify34.php): the real files under PHP, with accounts opened by a signed Labs 30 request.
//     Without it those parts are skipped, and the run says so.
//
// Run: node test/manual-ledger-issuance.js           (needs php with openssl, curl, pdo_sqlite)
//      CORE_LABS_DIR=/path/to/labs/chainblock-web node test/manual-ledger-issuance.js
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawn } = require('child_process');
const L = require('./ledger-issuance-lib');

let passes = 0, failures = 0;
const failed = [];
function check(name, ok, detail) {
  if (ok) { passes++; console.log('PASS ' + name); }
  else { failures++; failed.push(name); console.log('FAIL ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 400) : '')); }
}

const CORE_DIR = process.env.CORE_LABS_DIR && fs.existsSync(path.join(process.env.CORE_LABS_DIR, 'accounts31.php')) ? process.env.CORE_LABS_DIR : null;
const ALT = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const flipLast = (s) => s.slice(0, -1) + ALT[ALT.indexOf(s.slice(-1)) ^ 1];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function suite(kind, core) {
  const tag = '[' + kind + '/' + core.kind + '] ';
  const t = (name, ok, detail) => check(tag + name, ok, detail);
  const issuer = await L.startIssuer(kind, core);
  const snapshot = () => fs.readdirSync(issuer.tmp, { recursive: true }).filter((f) => !/\.lock$|ratelimit/.test(String(f))).sort().join('|');
  try {
    const keyBefore = fs.readFileSync(issuer.keyFile, 'utf8');
    const keyDocBefore = fs.readFileSync(issuer.keyDocPath, 'utf8');
    const coreCalls = () => core.callCount();
    const O = { owner: await L.newOwner() };
    const open = async (owner, coin) => core.openAccount(owner, coin);
    const issue = async (owner, coin, edit) => issuer.post(await L.buildRequest(owner, coin, edit));
    const fresh = async (coin, withAccount) => { const o = await L.newOwner(); if (withAccount !== false) await open(o, coin || 'GOPH'); return o; };

    console.log('--- ' + tag + 'off by default ---');
    const first = await fresh('GOPH');
    const snap0 = snapshot();
    let before = coreCalls();
    let r = await issue(first, 'GOPH');
    t('with no configuration the endpoint answers "disabled" and signs nothing', r.status === 404 && r.json && r.json.code === 'disabled' && !('credential' in (r.json || {})), r);
    t('...asks the ledger nothing', coreCalls() === before);
    t('...and writes no file', snapshot() === snap0 && issuer.store() === null);
    fs.writeFileSync(issuer.configPath, JSON.stringify({ enabled: false, domain: L.DOMAIN }));
    r = await issue(first, 'GOPH');
    t('"enabled": false is the same', r.status === 404 && r.json.code === 'disabled', r);
    fs.writeFileSync(issuer.configPath, JSON.stringify({ enabled: 'yes', domain: L.DOMAIN }));
    r = await issue(first, 'GOPH');
    t('only the boolean true turns it on', r.status === 404 && r.json.code === 'disabled', r);
    fs.writeFileSync(issuer.configPath, JSON.stringify({ enabled: true, domain: 'example.com' }));
    r = await issue(first, 'GOPH');
    t('a domain that is not a Labs 29 host is a misconfiguration, not a signing service', r.status === 503 && r.json.code === 'misconfigured', r);
    for (const bad of ['http://evil.example', 'https://127.0.0.1', 'http://127.0.0.1.evil.example', 'http://localhost:80/x']) {
      fs.writeFileSync(issuer.configPath, JSON.stringify({ enabled: true, domain: L.DOMAIN, coreBase: bad }));
      r = await issue(first, 'GOPH');
      t('a ledger address other than loopback http is refused (' + bad + ')', r.status === 503 && r.json.code === 'misconfigured', r);
    }
    t('none of that asked the ledger anything', coreCalls() === before);

    issuer.enable({ perClientPerMinute: 1000, perOwnerPerHour: 100, globalPerHour: 1000 });
    r = await issuer.call('GET', issuer.route);
    t('GET is not an operation', r.status === 405, r);
    r = await issuer.call('POST', issuer.route, await L.buildRequest(first, 'GOPH'), { Host: 'domain-atlas.co.za' });
    t('a request for another host is refused', r.status === 400 && r.json.code === 'unknown-host', r);
    if (kind === 'node') {
      r = await issuer.call('POST', issuer.route, await L.buildRequest(first, 'GOPH'), { 'X-Forwarded-Proto': 'http' });
      t('plain http is refused', r.status === 403 && r.json.code === 'https-required', r);
    }
    t('refusals before the checks asked the ledger nothing', coreCalls() === before);

    console.log('--- ' + tag + 'a valid issuance ---');
    const o1 = await fresh('GOPH');
    const reqBody = await L.buildRequest(o1, 'GOPH');
    before = coreCalls();
    r = await issuer.post(reqBody);
    t('an owner with an account gets a credential', r.status === 200 && r.json && r.json.ok === true && r.json.code === 'credential-issued', r);
    const cred = r.json && r.json.credential;
    const keyDoc = issuer.keyDoc();
    t('it has exactly the fields the wallet expects', cred && JSON.stringify(Object.keys(cred).sort()) === JSON.stringify(['credential', 'id', 'issuedAt', 'issuer', 'ledger', 'owner', 'signature']) && cred.credential === 'domain-atlas-ledger-account/1.0', cred);
    t('...with the nested fields exactly as specified', cred && JSON.stringify(Object.keys(cred.issuer).sort()) === '["domain","publicKey"]' && JSON.stringify(Object.keys(cred.ledger).sort()) === '["coin","network"]' && JSON.stringify(Object.keys(cred.owner)) === '["publicKey"]', cred);
    t('the issuer key is the established, published one', cred && cred.issuer.publicKey === keyDoc.keys[0].publicKey && cred.issuer.domain === L.DOMAIN, cred);
    t('the network, coin and owner are the requested ones', cred && cred.ledger.network === L.NETWORK && cred.ledger.coin === 'GOPH' && cred.owner.publicKey === o1.key, cred);
    t('the account ID is the one derived from network, coin and owner', cred && cred.id === L.derivedId(L.NETWORK, 'GOPH', o1.key), cred);
    t('the issue time is now', cred && Math.abs(Date.parse(cred.issuedAt) - Date.now()) < 10000 && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(cred.issuedAt), cred);
    t('the issuer signature verifies against the published key document', cred && await L.credentialSignatureValid(cred, keyDoc));
    t('it carries no balance or amount', cred && !/amount|balance|supply|quantity|units/i.test(JSON.stringify(cred)), cred);
    t('the signing key was not replaced, and the published key document is untouched', fs.readFileSync(issuer.keyFile, 'utf8') === keyBefore && fs.readFileSync(issuer.keyDocPath, 'utf8') === keyDocBefore);
    t('the ledger was asked exactly once', coreCalls() === before + 1, coreCalls() - before);
    if (core.kind === 'standin') {
      const sent = JSON.parse(core.state.calls[core.state.calls.length - 1].body);
      t('it was sent the owner\'s own listing request, unchanged, to the exact ledger address', L.canonicalize(sent.payload) === L.canonicalize(reqBody.existence.payload) && sent.proof.signature === reqBody.existence.proof.signature && core.state.calls[core.state.calls.length - 1].url === '/chain-labs/accounts31.php?action=accounts' && core.state.calls[core.state.calls.length - 1].host === L.DOMAIN);
    }
    const store = issuer.store();
    t('the issuance is logged with the account ID and coin only', store && store.log.length === 1 && store.log[0].id === cred.id && store.log[0].coin === 'GOPH' && JSON.stringify(Object.keys(store.log[0]).sort()) === '["at","coin","id"]', store);

    await open(o1, 'MWC');
    r = await issue(o1, 'MWC');
    t('a second coin of the same owner has its own account ID', r.status === 200 && r.json.credential.id === L.derivedId(L.NETWORK, 'MWC', o1.key) && r.json.credential.id !== cred.id, r);
    r = await issue(o1, 'GOPH');
    t('asking again with a fresh request re-issues the same account ID', r.status === 200 && r.json.credential.id === cred.id, r);
    t('...and that credential verifies too', r.status === 200 && await L.credentialSignatureValid(r.json.credential, keyDoc));

    if (core.kind === 'real') {
      console.log('--- ' + tag + 'the real Core listing agrees ---');
      const listing = (await L.buildRequest(o1, 'GOPH')).existence;
      const direct = await L.call(core.port, 'POST', '/chain-labs/accounts31.php?action=accounts', listing);
      const entry = direct.json && direct.json.accounts && direct.json.accounts.find((a) => a.coin === 'GOPH');
      t('Core\'s own listing names the same account ID as the credential', entry && entry.accountId === cred.id, direct.text);
      const verify = path.join(CORE_DIR, 'verify34.php');
      if (fs.existsSync(verify)) {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verify34-'));
        fs.writeFileSync(path.join(tmp, 'key.json'), JSON.stringify(keyDoc));
        const runVerify = (c) => { try { return { code: 0, out: execFileSync('php', [verify, path.join(tmp, 'key.json')], { input: JSON.stringify(c), stdio: 'pipe' }).toString() }; } catch (e) { return { code: e.status, out: String(e.stderr) }; } };
        const good = runVerify(cred);
        t('Core\'s own offline verifier (verify34.php) accepts it', good.code === 0 && /^PASS/.test(good.out), good);
        const mut = (f) => { const c = JSON.parse(JSON.stringify(cred)); f(c); return runVerify(c); };
        t('...and rejects a changed coin', mut((c) => { c.ledger.coin = 'MWC'; }).code === 1);
        t('...a changed owner', mut((c) => { c.owner.publicKey = flipLast(c.owner.publicKey); }).code === 1);
        t('...a changed account ID', mut((c) => { c.id = 'urn:atlas:ledger-account:' + '1'.repeat(64); }).code === 1);
        t('...a changed signature', mut((c) => { c.signature = flipLast(c.signature); }).code === 1);
        fs.rmSync(tmp, { recursive: true, force: true });
      } else console.log('SKIP verify34.php not found in CORE_LABS_DIR');
    }

    console.log('--- ' + tag + 'accounts that are not there ---');
    const none = await fresh('GOPH', false);
    before = coreCalls();
    r = await issue(none, 'GOPH');
    t('an owner the ledger has no account for gets no credential', r.status === 404 && r.json.code === 'account-not-found' && !('credential' in r.json), r);
    const gopOnly = await fresh('GOPH');
    r = await issue(gopOnly, 'MWC');
    t('an owner with another coin\'s account gets none for this coin', r.status === 404 && r.json.code === 'account-not-found', r);
    r = await issue(gopOnly, 'ZZZZ');
    t('an unknown coin gets none', r.status === 404 && r.json.code === 'account-not-found', r);
    t('only the owner\'s own account counts: someone else\'s account does not help', (await issue(none, 'GOPH')).status === 404);

    console.log('--- ' + tag + 'bad ownership proofs ---');
    const victim = await fresh('GOPH');
    const other = await L.newOwner();
    before = coreCalls();
    const refused = async (name, edit, status, code) => {
      const res = await issue(edit.who || victim, edit.coin || 'GOPH', edit);
      t(name, res.status === status && res.json && res.json.code === code && !('credential' in res.json), res);
    };
    await refused('a signature with a changed character is not accepted', { proof: (p) => { p.signature = p.signature.slice(0, 10) + ALT[(ALT.indexOf(p.signature[10]) + 1) % 64] + p.signature.slice(11); } }, 401, 'bad-signature');
    await refused('a non-canonical spelling of the same signature is refused', { proof: (p) => { p.signature = flipLast(p.signature); } }, 401, 'unsupported-proof');
    await refused('a signature by another key, claimed for the owner, is not accepted', { signer: other }, 401, 'bad-signature');
    await refused('a request changed after signing is not accepted', { after: (b) => { b.payload.coin = 'MWC'; } }, 401, 'bad-signature');
    await refused('a random 64-byte signature is not accepted', { proof: (p) => { p.signature = L.b64(require('crypto').randomBytes(64)); } }, 401, 'bad-signature');
    await refused('a passkey-style assertion is "proof unsupported"', { proof: (p) => { Object.assign(p, { signerRole: 'webauthn', clientDataJSON: 'e30', authenticatorData: 'AAAA', publicKey: victim.spki }); } }, 401, 'unsupported-proof');
    await refused('a passkey (SPKI) key under the raw label is "proof unsupported"', { proof: (p) => { p.publicKey = victim.spki; } }, 401, 'unsupported-proof');
    await refused('a non-canonical spelling of the owner key is refused', { proof: (p) => { p.publicKey = flipLast(victim.key); } }, 401, 'unsupported-proof');
    await refused('a proof without a signer role is refused', { proof: (p) => { delete p.signerRole; } }, 401, 'unsupported-proof');
    await refused('a listing request signed by another key is not accepted', { listingSigner: other }, 401, 'bad-signature');
    await refused('a listing request from a different key is not the owner\'s', { listingKey: other.key, listingSigner: other }, 401, 'existence-proof-rejected');
    await refused('an issuance naming a different listing request is refused', { intent: (p) => { p.existenceNonce = L.hex(16); } }, 401, 'existence-proof-rejected');
    t('none of these asked the ledger anything', coreCalls() === before);
    await refused('an audience other than the exact issuance address is refused', { intent: (p) => { p.audience = L.ACCOUNTS_URL; } }, 401, 'wrong-audience');
    await refused('...including the right address with a query added', { intent: (p) => { p.audience = L.OPERATION + '?x=1'; } }, 401, 'wrong-audience');
    await refused('...or another host\'s address', { intent: (p) => { p.audience = 'https://domain-atlas.co.za/atlas/ledger/account-credential'; } }, 401, 'wrong-audience');
    await refused('a listing request addressed elsewhere is refused', { listing: (p) => { p.audience = 'https://evtec.co.za/chain-labs/ledger29.php?action=balance'; } }, 401, 'wrong-audience');
    await refused('another domain\'s network is refused', { intent: (p) => { p.network = 'chainblock-labs29-domain-atlas.co.za'; } }, 400, 'unknown-network');
    await refused('a listing request for another network is refused', { listing: (p) => { p.network = 'chainblock-labs29-domain-atlas.co.za'; } }, 400, 'malformed-request');
    await refused('a wrong request type is refused', { intent: (p) => { p.type = 'atlas.ledger.balance'; } }, 400, 'malformed-request');
    await refused('an extra payload field is refused', { intent: (p) => { p.extra = 1; } }, 400, 'malformed-request');
    await refused('an extra top-level field (such as a claimed account list) is refused', { after: (b) => { b.accounts = [{ coin: 'GOPH' }]; } }, 400, 'malformed-request');
    await refused('a missing listing request is refused', { after: (b) => { delete b.existence; } }, 400, 'malformed-request');
    await refused('a short nonce is refused', { intent: (p) => { p.nonce = 'abc'; } }, 400, 'malformed-request');
    await refused('a lower-case-only coin is refused', { coin: 'goph' }, 400, 'malformed-request');
    await refused('a version other than 1 is refused', { intent: (p) => { p.v = 2; } }, 400, 'malformed-request');
    await refused('a numeric coin is refused', { intent: (p) => { p.coin = 7; } }, 400, 'malformed-request');
    t('none of these asked the ledger anything either', coreCalls() === before);
    r = await issuer.post('not json');
    t('a body that is not JSON is refused', r.status === 400 && r.json.code === 'malformed-request', r);
    r = await issuer.post('x'.repeat(20000));
    t('an oversized body is refused', r.status === 413, r);
    t('no credential was logged for any refusal', (issuer.store().log || []).every((e) => e.id !== L.derivedId(L.NETWORK, 'GOPH', victim.key)));

    console.log('--- ' + tag + 'time ---');
    const tm = await fresh('GOPH');
    r = await issue(tm, 'GOPH', { now: Date.now() - 10 * 60000 });
    t('an issuance request ten minutes old is refused, with the server time', r.status === 401 && r.json.code === 'stale-request' && /^\d{4}-/.test(r.json.serverTime || ''), r);
    r = await issue(tm, 'GOPH', { now: Date.now() + 10 * 60000 });
    t('...and one ten minutes ahead', r.status === 401 && r.json.code === 'stale-request', r);
    r = await issue(tm, 'GOPH', { listing: (p) => { p.issuedAt = L.iso(Date.now() - 10 * 60000); } });
    t('a stale listing request is refused', r.status === 401 && r.json.code === 'stale-request', r);
    r = await issue(tm, 'GOPH', { now: Date.now() - 60000 });
    t('a request a minute old is fine', r.status === 200, r);

    console.log('--- ' + tag + 'replay ---');
    const rp = await fresh('GOPH');
    const once = await L.buildRequest(rp, 'GOPH');
    before = coreCalls();
    const a = await issuer.post(once);
    const b = await issuer.post(once);
    t('the first use of a signed request works', a.status === 200, a);
    t('the second use is "replayed"', b.status === 409 && b.json.code === 'replayed-request' && !('credential' in b.json), b);
    t('...and does not ask the ledger again', coreCalls() === before + 1, coreCalls() - before);
    const burst = await L.buildRequest(await fresh('GOPH'), 'GOPH');
    const results = await Promise.all(Array.from({ length: 6 }, () => issuer.post(burst)));
    t('six simultaneous copies of one request produce exactly one credential', results.filter((x) => x.status === 200).length === 1 && results.filter((x) => x.status === 409).length === 5, results.map((x) => x.status));

    console.log('--- ' + tag + 'revocation and the signing key ---');
    const rv = await fresh('GOPH');
    r = await issue(rv, 'GOPH');
    const rvId = r.json.credential.id;
    issuer.revoke(rvId);
    before = coreCalls();
    r = await issue(rv, 'GOPH');
    t('an account ID the issuer has revoked is not issued again', r.status === 409 && r.json.code === 'account-revoked' && !('credential' in r.json), r);
    t('...without asking the ledger', coreCalls() === before);
    const ky = await fresh('GOPH');
    const goodDoc = issuer.keyDoc();
    const goodRaw = fs.readFileSync(issuer.keyDocPath);
    const pub = goodDoc.keys[0].publicKey;
    const withKey = (over) => issuer.setKeyDoc({ keys: [Object.assign({ publicKey: pub, validFrom: '2020-01-01T00:00:00Z', validUntil: null }, over)] });
    before = coreCalls();
    issuer.setKeyDoc({ keys: [] });
    r = await issue(ky, 'GOPH');
    t('a signing key the published document does not list is not used', r.status === 503 && r.json.code === 'issuer-key-unavailable' && !('credential' in r.json), r);
    withKey({ publicKey: flipLast(pub) });
    r = await issue(ky, 'GOPH');
    t('...nor when the document lists a different key', r.status === 503 && r.json.code === 'issuer-key-unavailable', r);
    withKey({ validFrom: L.iso(Date.now() + 3600000) });
    r = await issue(ky, 'GOPH');
    t('a key that is not valid yet is not used', r.status === 503 && r.json.code === 'issuer-key-unavailable', r);
    withKey({ validUntil: L.iso(Date.now() - 3600000) });
    r = await issue(ky, 'GOPH');
    t('a key that has expired is not used', r.status === 503 && r.json.code === 'issuer-key-unavailable', r);
    t('none of those asked the ledger anything', coreCalls() === before);
    fs.writeFileSync(issuer.keyDocPath, goodRaw);
    if (kind === 'php') {
      const saved = fs.readFileSync(issuer.keyFile);
      fs.unlinkSync(issuer.keyFile);
      r = await issue(ky, 'GOPH');
      t('with no private key file the endpoint refuses and does NOT create one', r.status === 503 && r.json.code === 'issuer-key-unavailable' && !fs.existsSync(issuer.keyFile), r);
      fs.writeFileSync(issuer.keyFile, saved);
    }
    r = await issue(ky, 'GOPH');
    t('with the key back, issuance works again', r.status === 200, r);
    t('the key files are exactly as they were', fs.readFileSync(issuer.keyFile, 'utf8') === keyBefore && fs.readFileSync(issuer.keyDocPath, 'utf8') === keyDocBefore);

    if (core.kind === 'standin') {
      console.log('--- ' + tag + 'a ledger that misbehaves ---');
      const lie = async (mode, name, status, code, extra) => {
        const o = await fresh('GOPH');
        core.state.mode = mode;
        const res = await issue(o, 'GOPH');
        core.state.mode = 'ok';
        t(name, res.status === status && res.json && res.json.code === code && !('credential' in res.json) && (!extra || res.json.ledgerCode === extra), res);
      };
      await lie('wrong-owner', 'an answer for a different owner is not believed', 502, 'ledger-mismatch');
      await lie('wrong-network', 'an answer for a different network is not believed', 502, 'ledger-mismatch');
      await lie('wrong-id', 'an account ID that is not the derived one is not believed', 502, 'ledger-mismatch');
      await lie('account-wrong-owner', 'an account entry for a different owner is not believed', 502, 'ledger-mismatch');
      await lie('duplicate', 'one coin listed twice is not believed', 502, 'ledger-mismatch');
      await lie('wrong-code', 'an answer with another code is not believed', 502, 'ledger-mismatch');
      await lie('error500', 'a ledger error is "unavailable"', 502, 'ledger-unavailable');
      await lie('down', 'a ledger that is down is "unavailable"', 502, 'ledger-unavailable');
      await lie('html', 'an answer that is not JSON is "unavailable"', 502, 'ledger-unavailable');
      await lie('huge', 'an oversized answer is "unavailable"', 502, 'ledger-unavailable');
      await lie('redirect', 'a redirect is not followed', 502, 'ledger-unavailable');
      await lie('refuse401', 'a ledger that refuses the proof is reported as such', 401, 'existence-proof-rejected', 'bad-signature');
      await lie('refuse400', 'a ledger that refuses the request is reported as such', 502, 'ledger-refused', 'malformed-request');
      const after = await fresh('GOPH');
      r = await issue(after, 'GOPH');
      t('and with the ledger honest again, issuance works', r.status === 200, r);
      const spent = await L.buildRequest(await fresh('GOPH'), 'GOPH');
      core.state.mode = 'down';
      const failed1 = await issuer.post(spent);
      core.state.mode = 'ok';
      const again = await issuer.post(spent);
      t('a request that failed at the ledger stays spent; the owner signs a new one', failed1.status === 502 && again.status === 409 && again.json.code === 'replayed-request', [failed1.status, again.status]);
    }

    console.log('--- ' + tag + 'the operator smoke tool ---');
    const tool = path.join(L.REPO, 'tools', 'ledger-issuance-smoke.js');
    const smoke = (extra) => new Promise((resolve) => {
      const child = spawn('node', [tool, L.DOMAIN, 'GOPH', '--plain', '--connect', '127.0.0.1:' + issuer.port, '--connect-core', core.base.replace('http://', '')].concat(extra || []), { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (c) => { out += c; });
      child.stderr.on('data', (c) => { out += c; });
      child.on('close', (code) => resolve({ code, out }));
    });
    let sm = await smoke();
    t('without --open it proves the endpoint is on and reaches the ledger, creating nothing', sm.code === 0 && /PASS the endpoint is on/.test(sm.out), sm);
    issuer.disable();
    sm = await smoke();
    t('with the endpoint off it says so and fails', sm.code === 1 && /OFF/.test(sm.out), sm);
    issuer.enable({ perClientPerMinute: 1000, perOwnerPerHour: 100, globalPerHour: 1000 });
    if (core.kind === 'real') {
      sm = await smoke(['--open']);
      t('with --open it opens a throwaway account, gets a credential and checks it', sm.code === 0 && /PASS issued urn:atlas:ledger-account:/.test(sm.out) && /derived ID: ok/.test(sm.out) && /published key: ok/.test(sm.out), sm);
    }

    console.log('--- ' + tag + 'limits ---');
    issuer.enable({ perClientPerMinute: 1000, perOwnerPerHour: 2, globalPerHour: 1000 });
    issuer.resetStore();
    const lim = await fresh('GOPH');
    const rs = [await issue(lim, 'GOPH'), await issue(lim, 'GOPH'), await issue(lim, 'GOPH')];
    t('an owner can be issued only so many credentials an hour', rs[0].status === 200 && rs[1].status === 200 && rs[2].status === 429 && rs[2].json.code === 'rate-limited' && Number(rs[2].headers['retry-after']) > 0, rs.map((x) => x.status));
    r = await issue(await fresh('GOPH'), 'GOPH');
    t('...while another owner is unaffected', r.status === 200, r);
    issuer.enable({ perClientPerMinute: 1000, perOwnerPerHour: 100, globalPerHour: 3 });
    issuer.resetStore();
    const g = [];
    for (let i = 0; i < 4; i++) g.push(await issue(await fresh('GOPH'), 'GOPH'));
    t('there is a limit across all owners too', g.slice(0, 3).every((x) => x.status === 200) && g[3].status === 429, g.map((x) => x.status));
    issuer.enable({ perClientPerMinute: 2, perOwnerPerHour: 100, globalPerHour: 1000 });
    issuer.resetStore();
    await sleep(100);
    const c = [];
    for (let i = 0; i < 4; i++) c.push(await issue(await fresh('GOPH'), 'GOPH'));
    t('and one caller\'s requests per minute are limited', c.some((x) => x.status === 429 && x.json.code === 'rate-limited' && Number(x.headers['retry-after']) > 0), c.map((x) => x.status));

    console.log('--- ' + tag + 'left alone ---');
    issuer.enable({ perClientPerMinute: 1000, perOwnerPerHour: 100, globalPerHour: 1000 });
    issuer.resetStore();
    t('issuance still works after the limits are lifted', (await issue(await fresh('GOPH'), 'GOPH')).status === 200);
    t('the signing key and its published document are exactly as they were', fs.readFileSync(issuer.keyFile, 'utf8') === keyBefore && fs.readFileSync(issuer.keyDocPath, 'utf8') === keyDocBefore);
    const st = issuer.store();
    t('the issuance store holds nothing but nonce hashes, owner hashes and the log', st && JSON.stringify(Object.keys(st).sort()) === '["issued","log","nonces"]' && st.nonces.every((n) => /^[0-9a-f-]{43,64}$/i.test(n[0])), st && Object.keys(st));
    t('the log never holds a private value', JSON.stringify(st.log).indexOf('signature') < 0 && JSON.stringify(st.log).indexOf('"publicKey"') < 0);
  } finally {
    issuer.close();
  }
}

(async () => {
  const cores = [await L.startCoreStandin()];
  if (CORE_DIR) cores.push(await L.startCoreReal(CORE_DIR)); else console.log('NOTE CORE_LABS_DIR is not set: the real Core files and verify34.php are not exercised in this run.');
  try {
    for (const kind of ['node', 'php']) for (const core of cores) await suite(kind, core);
  } finally {
    for (const core of cores) await core.close();
  }
  console.log('\nmanual-ledger-issuance: ' + passes + ' passed, ' + failures + ' failed');
  if (failures) { console.log('Failed: ' + failed.join(' | ')); process.exit(1); }
})().catch((err) => { console.log('FATAL', err && err.stack || err); process.exit(1); });
