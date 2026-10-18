// The wallet's Open Ledger Account workflow, in a real Chromium with the extension loaded: the two
// separately approved steps, what is signed and sent, and what is kept.
//
// The browser reaches the services the way it would reach the live site: it asks for
// https://evtec.co.za/..., which Chromium resolves to a local HTTPS front (a throwaway
// certificate, accepted for this run only). The front sends /chain-labs/ to the ledger and
// everything else to the issuer. The issuer is the real one from this repository (Node and PHP).
// The ledger is the STAND-IN unless CORE_LABS_DIR names Core's files, in which case the real
// Labs 30/31/29 files run under PHP. Nothing here touches a live site.
//
// Run: xvfb-run -a node test/manual-ledger-open-wallet.js   (add CORE_LABS_DIR=... for real Core)
'use strict';
const fs = require('fs');
const path = require('path');
const { webcrypto } = require('crypto');
const E = require('./call-e2e-lib');
const T = require('./ledger-test-lib');
const L = require('./ledger-issuance-lib');
const { makeCert, front, chromiumArgs } = require('./ledger-https-front');
const { check } = E;

const CORE_DIR = process.env.CORE_LABS_DIR && fs.existsSync(path.join(process.env.CORE_LABS_DIR, 'accounts31.php')) ? process.env.CORE_LABS_DIR : null;
const TARGET = { domain: L.DOMAIN, coin: 'GOPH' };

// Checks a signature the way the services do: SHA-256 over the canonical text, raw P-256 point key.
async function signatureOk(payload, proof) {
  const pub = await webcrypto.subtle.importKey('raw', Buffer.from(proof.publicKey, 'base64url'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  return webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, Buffer.from(proof.signature, 'base64url'), new TextEncoder().encode(L.canonicalize(payload)));
}

async function run(kind, core, tls) {
  const tag = '[' + kind + '/' + core.kind + '] ';
  const t = (name, ok, detail) => check(tag + name, ok, detail);
  const issuer = await L.startIssuer(kind, core); // left DISABLED: enabling it is the operator's act, done below
  const hits = [];
  const tamper = { issue: null };
  const fr = await front(issuer.port, core, tls, hits, tamper);
  const w = await E.launchWallet('open-' + kind, { args: chromiumArgs(fr.port) });
  const W = w.wallet;
  const only = (re) => hits.filter((h) => re.test(h.url));
  const openHits = () => only(/account30\.php/);
  const issueHits = () => only(/account-credential/);
  const balanceHits = () => only(/ledger29\.php/);
  // `approved` is true unless a test says otherwise; 'omit' leaves the options out altogether.
  const open = (target, approved) => W(([x, a]) => AtlasWallet.openLedgerAccount(x, a === 'omit' ? undefined : { approved: a }), [target || TARGET, approved === undefined ? true : approved]);
  const request = (id, approved) => W(([i, a]) => AtlasWallet.requestLedgerCredential(i, a === 'omit' ? undefined : { approved: a }), [id, approved === undefined ? true : approved]);
  const opening = () => W(() => AtlasWallet.getLedgerOpening());
  const overview = () => W(() => AtlasWallet.getLedgerOverview());
  try {
    const created = await W((pw) => AtlasWallet.createIdentity(pw), 'open-test-password');
    const mine = created.publicKey;
    const id = L.derivedId(L.NETWORK, 'GOPH', mine);

    console.log('--- ' + tag + 'nothing happens until the experimental interface is on and the person approves ---');
    let o = await opening();
    t('the panel is unavailable while the experimental interface is off, and says why', o.available === false && o.reason === 'experimental-off' && /off by default/.test(o.reasonText), o);
    t('it lists the identity and the one supported coin, with the text to read first', o.identities.length === 1 && o.identities[0].mode === 'local' && o.identities[0].active && o.targets.length === 1 && o.targets[0].coin === 'GOPH' && /experimental/i.test(o.targets[0].explainOpen) && o.targets[0].urls.open.includes('account30.php'), o);
    let r = await open();
    t('opening is refused while it is off', r.ok === false && r.code === 'experimental-off', r);
    t('...and nothing was sent', hits.length === 0, hits);
    await W(() => AtlasWallet.setLedgerExperimental('labs29', true));
    o = await opening();
    t('with the interface on, opening is available', o.available === true && o.reason === null, o);
    r = await open(TARGET, false);
    t('without approval nothing is opened', r.ok === false && r.code === 'no-consent', r);
    r = await open(TARGET, 'omit');
    t('...and a call that omits the approval is refused too', r.ok === false && r.code === 'no-consent', r);
    r = await open({ domain: L.DOMAIN, coin: 'MWC' });
    t('a coin that is not listed is refused', r.ok === false && r.code === 'unsupported-target', r);
    r = await open({ domain: 'example.com', coin: 'GOPH' });
    t('a domain that is not listed is refused', r.ok === false && r.code === 'unsupported-target', r);
    r = await request(id);
    t('a reference cannot be requested for an account the wallet has not opened', r.ok === false && r.code === 'unknown', r);
    t('...and none of that sent anything', hits.length === 0, hits);

    console.log('--- ' + tag + 'the website bridge cannot sign these messages ---');
    const refusals = await W(async () => {
      const out = {};
      for (const type of ['atlas.ledger.account.open', 'atlas.ledger.accounts', 'atlas.ledger.account.issue']) {
        try { await AtlasWallet.signWithSelf({ type, v: 1, audience: 'https://evtec.co.za/', nonce: 'a'.repeat(32) }); out[type] = 'signed'; } catch (e) { out[type] = e.message; }
      }
      try { await AtlasWallet.signWithSelf({ purpose: 'x', nested: { type: 'atlas.ledger.account.open' } }); out.nested = 'signed'; } catch (e) { out.nested = e.message; }
      return { out, exposed: ['signLedgerPayload', 'signWithSelfUnchecked', 'ledgerScopedFetch'].filter((n) => typeof AtlasWallet[n] === 'function') };
    });
    t('the generic signer refuses all three message types, even nested', Object.values(refusals.out).every((m) => /Ledger messages are signed only/.test(m)), refusals);
    t('the internal signing functions are not exported', refusals.exposed.length === 0, refusals.exposed);

    console.log('--- ' + tag + 'step 1: opening the account ---');
    r = await open();
    t('after approval the account is opened empty', r.ok === true && r.created === true && r.id === id, r);
    t('the ledger holds it', core.holds(mine, 'GOPH') === true);
    t('exactly one request went out, to the exact open address', hits.length === 1 && hits[0].method === 'POST' && hits[0].url === '/chain-labs/account30.php?action=open', hits.map((h) => h.url));
    const sent = JSON.parse(hits[0].body);
    t('it was the Labs 30 message for this network, coin and nonce shape', sent.payload.type === 'atlas.ledger.account.open' && sent.payload.audience === L.OPEN_URL && sent.payload.network === L.NETWORK && sent.payload.coin === 'GOPH' && /^[a-f0-9]{32}$/.test(sent.payload.nonce) && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(sent.payload.issuedAt), sent.payload);
    t('...signed by the selected identity, with exactly a key and a signature', JSON.stringify(Object.keys(sent.proof).sort()) === '["publicKey","signature"]' && sent.proof.publicKey === mine && await signatureOk(sent.payload, sent.proof));
    t('no issuer request, no balance lookup and no listing request was made', issueHits().length === 0 && balanceHits().length === 0 && only(/accounts31/).length === 0);
    o = await opening();
    t('the account is noted as open, waiting for its reference', o.pending.length === 1 && o.pending[0].id === id && o.pending[0].coin === 'GOPH' && o.pending[0].problem === null && o.pending[0].existedBefore === false, o.pending);
    let ov = await overview();
    t('nothing is in the account list: no reference, so no balance', ov.accounts.length === 0, ov.accounts);
    const raw = await W(() => chrome.storage.local.get('atlasLedgerOpenings'));
    t('the note is stored encrypted, not as readable text', JSON.stringify(raw).includes('__atlasEncrypted') && !JSON.stringify(raw).includes('GOPH') && !JSON.stringify(raw).includes(id), JSON.stringify(raw).slice(0, 200));

    console.log('--- ' + tag + 'opening again never resets a balance ---');
    await core.seedBalance(mine, 'GOPH', 4200000);
    r = await open();
    t('opening again finds the account instead of creating it', r.ok === true && r.created === false, r);
    t('the ledger still holds exactly what it held', (await core.balanceOf(mine, 'GOPH')) === 4200000, await core.balanceOf(mine, 'GOPH'));
    o = await opening();
    t('there is still one note, not two', o.pending.length === 1 && o.pending[0].problem === null, o.pending);

    console.log('--- ' + tag + 'step 2 with the issuer switched off: the account stays open ---');
    r = await request(id, false);
    t('a reference is not requested without approval', r.ok === false && r.code === 'no-consent' && issueHits().length === 0, r);
    r = await request(id);
    t('with the issuer off the request fails with a clear reason', r.ok === false && r.code === 'issuance-off', r);
    t('exactly one request went to the exact issuer address', issueHits().length === 1 && issueHits()[0].method === 'POST' && issueHits()[0].url === '/atlas/ledger/account-credential', issueHits().map((h) => h.url));
    o = await opening();
    t('the account is still noted, now with the problem shown', o.pending.length === 1 && o.pending[0].problem && o.pending[0].problem.code === 'issuance-off' && /stays open/.test(o.pending[0].problem.text), o.pending);
    ov = await overview();
    t('nothing was collected', ov.accounts.length === 0);
    t('the ledger account and its balance are untouched', core.holds(mine, 'GOPH') && (await core.balanceOf(mine, 'GOPH')) === 4200000);
    const openCountBefore = openHits().length;

    console.log('--- ' + tag + 'the operator enables the issuer; the wallet retries without re-opening ---');
    issuer.enable({ perClientPerMinute: 1000, perOwnerPerHour: 100, globalPerHour: 1000 });
    const firstIssue = issueHits().length;
    r = await request(id);
    t('asking again collects the reference', r.ok === true && r.id === id, r);
    t('the retry did not open the account again', openHits().length === openCountBefore, openHits().length);
    const body = JSON.parse(issueHits()[issueHits().length - 1].body);
    t('the issuance request is the one the issuer expects', JSON.stringify(Object.keys(body).sort()) === '["existence","payload","proof"]' && body.payload.type === 'atlas.ledger.account.issue' && body.payload.audience === L.OPERATION && body.payload.network === L.NETWORK && body.payload.coin === 'GOPH' && body.payload.existenceNonce === body.existence.payload.nonce, body.payload);
    t('the owner proof has exactly signerRole, key and signature and verifies', JSON.stringify(Object.keys(body.proof).sort()) === '["publicKey","signature","signerRole"]' && body.proof.signerRole === 'raw-ecdsa' && body.proof.publicKey === mine && await signatureOk(body.payload, body.proof));
    t('the carried listing request is for the exact Labs 31 address and verifies', body.existence.payload.type === 'atlas.ledger.accounts' && body.existence.payload.audience === L.ACCOUNTS_URL && JSON.stringify(Object.keys(body.existence.proof).sort()) === '["publicKey","signature"]' && body.existence.proof.publicKey === mine && await signatureOk(body.existence.payload, body.existence.proof));
    t('both messages are fresh: new nonces, different from the open request', ![body.payload.nonce, body.existence.payload.nonce].includes(sent.payload.nonce) && body.payload.nonce !== body.existence.payload.nonce);
    const replay = await issuer.post(body);
    t('the issuer refuses a copy of that request', replay.status === 409 || replay.status === 401, { status: replay.status, code: replay.json && replay.json.code });
    t('the wallet itself never called the ledger\'s listing address (the issuer relays it)', only(/accounts31/).length === 0, only(/accounts31/).length);

    console.log('--- ' + tag + 'what was kept ---');
    ov = await overview();
    const acct = ov.accounts[0];
    t('one reference is in the account list', ov.accounts.length === 1 && acct.id === id && acct.coin === 'GOPH' && acct.issuerDomain === L.DOMAIN && acct.network === L.NETWORK, ov.accounts.map((a) => a.id));
    t('it has no balance, no permission to look one up and no background checks', acct.balance === null && acct.consent === null && acct.backgroundSync === false, acct);
    t('the note is gone, since the reference is collected', (await opening()).pending.length === 0);
    const cred = acct.credential;
    t('the credential is the exact issuer format, with a derived ID and this identity as owner', cred.credential === 'domain-atlas-ledger-account/1.0' && cred.id === L.derivedId(L.NETWORK, 'GOPH', mine) && cred.owner.publicKey === mine && cred.issuer.domain === L.DOMAIN && !('amount' in cred) && !('balance' in cred), cred);
    t('its issuer signature checks against the published key, independently of the wallet', await L.credentialSignatureValid(cred, issuer.keyDoc()));
    t('the wallet\'s own check agrees', (await W((c) => AtlasWallet.verifyLedgerCredential(c), cred)).valid === true);
    t('no balance lookup has been made', balanceHits().length === 0);
    t('the ledger balance is still what it was', (await core.balanceOf(mine, 'GOPH')) === 4200000);
    r = await open();
    t('opening again is refused locally once the reference is held', r.ok === false && r.code === 'already-held', r);
    const refreshNoConsent = await W((i) => AtlasWallet.refreshLedgerAccount(i, { reason: 'manual' }), id);
    t('a balance lookup needs its own permission', refreshNoConsent.ok === false && refreshNoConsent.code === 'no-consent' && balanceHits().length === 0, refreshNoConsent);
    const bg = await W((i) => AtlasWallet.setLedgerBackgroundSync(i, true).then(() => 'on', (e) => e.code), id);
    t('background synchronisation cannot be turned on before that permission', bg === 'no-consent', bg);

    if (core.kind === 'real') {
      console.log('--- ' + tag + 'a balance, only after a separate permission (real Core) ---');
      await W((i) => AtlasWallet.grantLedgerConsent(i), id);
      t('allowing lookups alone sends nothing', balanceHits().length === 0);
      const got = await W((i) => AtlasWallet.refreshLedgerAccount(i, { reason: 'manual' }), id);
      ov = await overview();
      t('the lookup then reports the ledger\'s figure as not cryptographically verified', got.ok === true && ov.accounts[0].balance && ov.accounts[0].balance.text === '4.200000' && ov.accounts[0].balance.verification.label === 'Reported \u2014 Not Cryptographically Verified', { got, balance: ov.accounts[0].balance, problem: ov.accounts[0].problem });
      t('background checks are still off', ov.accounts[0].backgroundSync === false);
      await W((i) => AtlasWallet.revokeLedgerConsent(i), id);
    }

    console.log('--- ' + tag + 'partial failures keep the account and never store a bad reference ---');
    await W((i) => AtlasWallet.removeLedgerAccount(i), id);
    const other = await L.newOwner();
    r = await open();
    t('after removing the reference, opening finds the same account untouched', r.ok === true && r.created === false && (await core.balanceOf(mine, 'GOPH')) === 4200000, r);
    const flip = (c) => { c.signature = c.signature.slice(0, 10) + (c.signature[10] === 'A' ? 'B' : 'A') + c.signature.slice(11); };
    tamper.issue = flip;
    r = await request(id);
    t('a credential whose issuer signature does not check is not collected', r.ok === false && r.code === 'credential-invalid', r);
    ov = await overview();
    o = await opening();
    t('...nothing was stored, and the note keeps the problem', ov.accounts.length === 0 && o.pending.length === 1 && o.pending[0].problem.code === 'credential-invalid', o.pending);
    tamper.issue = (c) => { c.owner.publicKey = other.key; };
    r = await request(id);
    t('a credential for somebody else\'s key is not collected', r.ok === false && r.code === 'credential-invalid' && (await overview()).accounts.length === 0, r);
    tamper.issue = (c) => { c.balance = '5'; };
    r = await request(id);
    t('a credential that carries a balance is not collected', r.ok === false && r.code === 'credential-invalid' && (await overview()).accounts.length === 0, r);
    tamper.issue = null;
    r = await request(id);
    t('once the answer is right, the retry collects it', r.ok === true && (await overview()).accounts.length === 1, r);
    await W((i) => AtlasWallet.removeLedgerAccount(i), id);
    await open();
    issuer.revoke(id);
    r = await request(id);
    t('a revoked account is refused by the issuer and nothing is stored', r.ok === false && r.code === 'account-revoked' && (await overview()).accounts.length === 0, r);
    const hitsBeforeForget = hits.length;
    await W((i) => AtlasWallet.forgetLedgerOpening(i), id);
    t('forgetting the note sends nothing and leaves the ledger account alone', hits.length === hitsBeforeForget && (await opening()).pending.length === 0 && core.holds(mine, 'GOPH') && (await core.balanceOf(mine, 'GOPH')) === 4200000);

    if (core.kind === 'standin') {
      console.log('--- ' + tag + 'a ledger that answers wrongly or not at all (stand-in) ---');
      for (const [mode, code] of [['wrong-owner', 'bad-response'], ['wrong-id', 'bad-response'], ['wrong-network', 'bad-response'], ['wrong-coin', 'bad-response'], ['down', 'network']]) {
        core.state.openMode = mode;
        r = await open();
        o = await opening();
        t('an open answer of "' + mode + '" is refused as ' + code + ' and nothing is noted', r.ok === false && r.code === code && o.pending.length === 0, { r, pending: o.pending.length });
      }
      core.state.openMode = 'ok';
    }

    console.log('--- ' + tag + 'a passkey identity makes no incompatible proof ---');
    const kp = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const spki = T.b64url(new Uint8Array(await webcrypto.subtle.exportKey('spki', kp.publicKey)));
    const point = T.b64url(new Uint8Array(await webcrypto.subtle.exportKey('raw', kp.publicKey)));
    await W(({ spki }) => {
      self.__credCalls = 0;
      Object.defineProperty(navigator, 'credentials', { configurable: true, value: { get: async () => { self.__credCalls++; throw new Error('no authenticator is attached'); } } });
      return chrome.storage.local.set({ atlasWebAuthnIdentity: { credentialId: 'AAAAAAAAAAAAAAAAAAAAAA', publicKey: spki, createdAt: new Date().toISOString() }, atlasIdentityMode: 'webauthn' });
    }, { spki });
    const before = hits.length;
    o = await opening();
    t('the panel offers both identities and marks the passkey one as not usable here', o.identities.length === 2 && o.identities.find((x) => x.mode === 'webauthn').active && o.identities.find((x) => x.mode === 'webauthn').supported === false && o.identities.find((x) => x.mode === 'local').supported === true, o.identities);
    t('...and the panel says no request will be made', o.available === false && o.reason === 'proof-unsupported', o);
    r = await open();
    t('opening is refused for it', r.ok === false && r.code === 'proof-unsupported', r);
    r = await request(L.derivedId(L.NETWORK, 'GOPH', point));
    t('so is a reference request', r.ok === false && (r.code === 'unknown' || r.code === 'proof-unsupported'), r);
    t('no request went out and no authenticator was asked', hits.length === before && (await W(() => self.__credCalls)) === 0, { sent: hits.length - before });
    await W(() => chrome.storage.local.set({ atlasIdentityMode: 'local' }));
    o = await opening();
    t('switching back to the password identity makes it available again', o.available === true, o);
  } finally {
    await w.close();
    await fr.close();
    issuer.close();
  }
}

(async () => {
  const tls = makeCert();
  const cores = [await L.startCoreStandin()];
  if (CORE_DIR) cores.push(await L.startCoreReal(CORE_DIR)); else console.log('NOTE CORE_LABS_DIR is not set: the ledger here is the stand-in only.');
  try {
    for (const kind of ['node', 'php']) for (const core of cores) await run(kind, core, tls);
  } finally {
    for (const core of cores) await core.close();
    fs.rmSync(tls.dir, { recursive: true, force: true });
  }
  process.exit(E.finish('manual-ledger-open-wallet'));
})().catch((err) => { console.log('FATAL', err && err.stack || err); process.exit(1); });
