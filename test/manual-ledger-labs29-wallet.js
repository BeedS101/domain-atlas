// The experimental Labs 29 adapter inside the wallet, in a real Chromium with the extension loaded.
//
// The issuer is a local test double. The balance service is a STAND-IN for the Labs 29 prototype
// (test/labs29-standin.js) that follows its documented behaviour and can be told to misbehave;
// test/manual-ledger-labs29-php.js runs the real prototype file. The adapter instance used here is
// pointed at the stand-in's loopback host; the one the wallet registers itself serves only the two
// Labs domains.
//
// Needs no demo domain. Run: xvfb-run -a node test/manual-ledger-labs29-wallet.js
'use strict';
const { webcrypto } = require('crypto');
const L = require('./call-e2e-lib');
const T = require('./ledger-test-lib');
const S = require('./labs29-standin');
const { check } = L;

const HOSTED = 'chainblock-ledger29/experimental';
const TEST_CONTRACT = HOSTED + '-test';
const UNSIGNED = 'Reported — Not Cryptographically Verified';

(async () => {
  const issuer = await T.startIssuer();
  const labs = S.attachLabs29(issuer);
  const st = labs.state;
  const w = await L.launchWallet('labs29');
  const W = w.wallet;
  const NET = st.network;
  try {
    w.pub = (await W((pw) => AtlasWallet.createIdentity(pw), 'labs29-test-password')).publicKey;
    const overview = () => W(() => AtlasWallet.getLedgerOverview());
    const acct = async (id) => (await overview()).accounts.find((a) => a.id === id);
    const codeOf = (fn, arg) => w.sw.evaluate('(async () => { try { return { ok: true, value: await (' + fn.toString() + ')(' + JSON.stringify(arg === undefined ? null : arg) + ') }; } catch (e) { return { ok: false, code: e.code || null, message: e.message }; } })()');
    const refresh = (id, reason) => W(([i, rs]) => AtlasWallet.refreshLedgerAccount(i, { reason: rs || 'manual' }), [id, reason]);
    const installTestInstance = () => W(({ host, contract }) => { const a = AtlasLedgerLabs29.createAdapter({ hosts: [host], loopback: true }); a.contract = contract; AtlasWallet.registerLedgerAdapter(a); return true; }, { host: issuer.domain, contract: TEST_CONTRACT });
    const mk = (coin, owner, over) => issuer.issue(owner || w.pub, { network: NET, coin }, over);
    const add = (c) => codeOf((cred) => AtlasWallet.addLedgerAccount(cred, { allowNetwork: true }), c);
    const allow = (id) => W((i) => AtlasWallet.grantLedgerConsent(i), id);
    const stats = () => ({ disc: st.discoveryRequests, bal: st.balanceRequests, other: st.otherRequests.length });

    console.log('--- off by default ---');
    let exp = await W(() => AtlasWallet.getLedgerExperimental());
    check('the experimental interface is available but off in a fresh wallet', exp.length === 1 && exp[0].name === 'labs29' && exp[0].available === true && exp[0].enabled === false, exp);
    check('no adapter is registered in a fresh wallet', (await overview()).adapters.length === 0);
    check('nothing is stored about it until the person chooses', JSON.stringify(await W(() => chrome.storage.local.get('atlasLedgerExperimental'))) === '{}');
    let ov = await overview();
    check('the overview reports the switch, off', ov.experimental.length === 1 && ov.experimental[0].enabled === false);

    console.log('--- the wallet\'s own switch ---');
    exp = await W(() => AtlasWallet.setLedgerExperimental('labs29', true));
    check('turning it on registers the Labs 29 interface', exp[0].enabled === true && (await overview()).adapters.includes(HOSTED));
    check('the choice is kept in storage', (await W(() => chrome.storage.local.get('atlasLedgerExperimental'))).atlasLedgerExperimental.labs29 === true);
    const offUnknown = await codeOf(() => AtlasWallet.setLedgerExperimental('nonsense', true));
    check('an unknown interface name is refused', !offUnknown.ok);
    const gop0 = await mk('GOPH');
    const added0 = await add(gop0);
    check('an account on a test host is added (the issuer\'s signature is still checked)', added0.ok, added0);
    ov = await overview();
    check('the built-in instance serves only the two Labs domains, so a test host is unavailable to it', ov.accounts[0].indicators.lookup.level === 'unavailable' && /no way to reach/.test(ov.accounts[0].indicators.lookup.detail));
    exp = await W(() => AtlasWallet.setLedgerExperimental('labs29', false));
    check('turning it off unregisters it', exp[0].enabled === false && !(await overview()).adapters.includes(HOSTED));
    check('and the choice is kept', (await W(() => chrome.storage.local.get('atlasLedgerExperimental'))).atlasLedgerExperimental.labs29 === false);
    await W((id) => AtlasWallet.removeLedgerAccount(id), added0.value.id);

    console.log('--- accounts, and nothing contacted without permission ---');
    await installTestInstance();
    const gop = await mk('GOPH'), mwc = await mk('MWC'), zzz = await mk('ZZZ');
    const accounts = {};
    for (const [n, c] of [['GOPH', gop], ['MWC', mwc], ['ZZZ', zzz]]) { const r = await add(c); accounts[n] = r.ok ? r.value.id : null; }
    check('three accounts were added, each owned by this identity\'s canonical key', Object.values(accounts).every(Boolean) && (await overview()).identity.publicKey === w.pub);
    const before = stats();
    let r = await refresh(accounts.GOPH);
    check('a lookup without permission is refused', r.ok === false && r.code === 'no-consent');
    check('and sent nothing', JSON.stringify(stats()) === JSON.stringify(before) && st.bodies.length === 0);
    let a = await acct(accounts.GOPH);
    check('lookup is available but not enabled, and the interface is named', a.indicators.lookup.level === 'available' && a.interface && a.interface.experimental === true && /experimental/i.test(a.interface.label));
    check('background checks are off and unavailable until lookups are allowed', a.backgroundSync === false && a.indicators.background.level === 'unavailable');
    await allow(accounts.GOPH);
    a = await acct(accounts.GOPH);
    check('after permission background checks are available but still off', a.backgroundSync === false && a.indicators.background.level === 'available');
    check('granting permission contacted nothing', JSON.stringify(stats()) === JSON.stringify(before));

    console.log('--- a valid lookup ---');
    r = await refresh(accounts.GOPH);
    check('an account the ledger has not opened is "not found" and shows no balance', r.ok === false && r.code === 'not-found');
    a = await acct(accounts.GOPH);
    check('no balance is invented', a.balance === null && a.problem.code === 'not-found');
    check('discovery was fetched from the issuer\'s exact discovery address and the lookup posted to the exact balance address', st.discoveryRequests === 1 && st.balanceRequests === 1);
    labs.open(w.pub, 'GOPH', 1250);
    r = await refresh(accounts.GOPH);
    check('once the ledger holds a row the lookup succeeds with the exact figure', r.ok && r.balance.amount === '1250' && r.balance.decimals === 2 && r.balance.text === '12.50', r);
    const body = st.bodies[st.bodies.length - 1];
    check('the wallet signed an exact-address, canonical-owner request the stand-in accepted', body.payload.audience === st.balanceUrl && body.proof.publicKey === w.pub && Object.keys(body.proof).sort().join() === 'publicKey,signature');
    check('the payload carries the network and coin from the credential', body.payload.network === NET && body.payload.coin === 'GOPH');
    a = await acct(accounts.GOPH);
    check('the balance is labelled Reported — Not Cryptographically Verified', a.balance && a.balance.verification.label === UNSIGNED && /not a final or spendable balance/.test(a.balance.verification.detail), a.balance);
    check('it is recorded as unsigned and as coming from the experimental interface', a.balance.interface && a.balance.interface.experimental === true);
    check('the pin is the exact balance address', a.pinnedEndpoint === st.balanceUrl);
    check('background checks are still off after a successful lookup', a.backgroundSync === false);

    console.log('--- structured errors from the service ---');
    await allow(accounts.ZZZ);
    r = await refresh(accounts.ZZZ);
    check('a coin the service does not list is "unknown coin", in words', r.ok === false && r.code === 'unknown-coin' && /does not list this coin/.test((await acct(accounts.ZZZ)).problem.text));
    for (const [mode, code] of [['status500', 'network'], ['rate-limited', 'rate-limited'], ['stale', 'clock'], ['garbage', 'bad-response']]) {
      st.mode = mode;
      r = await refresh(accounts.GOPH);
      check('the service answering "' + mode + '" is shown as "' + code + '"', r.ok === false && r.code === code, r);
    }
    a = await acct(accounts.GOPH);
    check('failed lookups leave the last reported balance as it was, with the latest problem noted', a.balance && a.balance.text === '12.50' && a.problem.code === 'bad-response', a);
    st.mode = 'ok';

    console.log('--- an answer that is not this account\'s ---');
    const goodBalance = (await acct(accounts.GOPH)).balance;
    for (const [mode, label] of [['wrong-owner', 'another owner'], ['wrong-coin', 'another coin'], ['wrong-network', 'another network'], ['bad-amount', 'an amount that is not whole digits'], ['future', 'a time an hour ahead']]) {
      st.mode = mode;
      r = await refresh(accounts.GOPH);
      a = await acct(accounts.GOPH);
      check('an answer for ' + label + ' is refused as a bad answer', r.ok === false && r.code === 'bad-response', r);
      check('...and does not replace the balance the wallet holds', a.balance && a.balance.amount === goodBalance.amount && a.balance.asOf === goodBalance.asOf);
    }
    st.mode = 'ok';

    console.log('--- an altered endpoint ---');
    let s0 = stats();
    st.discovery = { operations: { balance: st.balanceUrl + '&extra=1' } };
    r = await refresh(accounts.GOPH);
    check('discovery naming a different balance address is refused', r.ok === false && r.code === 'bad-response', r);
    check('...and no balance request was sent anywhere', stats().bal === s0.bal);
    st.discovery = { operations: { balance: 'http://evil.example/chain-labs/ledger29.php?action=balance' } };
    r = await refresh(accounts.GOPH);
    check('discovery naming another host is refused the same way', r.ok === false && r.code === 'bad-response' && stats().bal === s0.bal, r);
    st.discovery = { network: 'chainblock-labs29-evil.example' };
    r = await refresh(accounts.GOPH);
    check('discovery for another network is refused', r.ok === false && r.code === 'bad-response' && stats().bal === s0.bal, r);
    st.discovery = { issuer: 'evil.example' };
    r = await refresh(accounts.GOPH);
    check('discovery for another issuer is refused', r.ok === false && r.code === 'bad-response' && stats().bal === s0.bal, r);
    st.discovery = {}; st.discoveryStatus = 503;
    r = await refresh(accounts.GOPH);
    check('a discovery service that is down is a network problem', r.ok === false && r.code === 'network', r);
    st.discoveryStatus = 200;

    console.log('--- the pin follows the exact address, path included ---');
    // An adapter whose balance address can move by query alone, on the same origin. It signs and posts
    // to whatever address discovery gave it, so the stand-in answers 401 once the address moves; the
    // point here is where the wallet is willing to send, not the answer.
    await W(({ host }) => {
      const real = AtlasLedgerLabs29.createAdapter({ hosts: [host], loopback: true });
      AtlasWallet.clearLedgerAdapters();
      AtlasWallet.registerLedgerAdapter({
        contract: 'path-pin-test/1', proofFormats: ['raw-ecdsa-p256'], supports: (t) => real.supports(t),
        async discover(t, ctx) { const f = await real.discover(t, ctx); return { operations: { balance: f.operations.balance + (self.__pinSuffix || '') } }; },
        async fetchBalance(t, found, ctx) {
          const payload = { type: 'atlas.ledger.balance', v: 1, audience: found.operations.balance, network: t.network, coin: t.coin, nonce: 'a'.repeat(32), issuedAt: new Date().toISOString() };
          const proof = await ctx.sign(payload);
          await ctx.fetch(found.operations.balance, { method: 'POST', body: JSON.stringify({ payload, proof }) });
          return { amount: '1', decimals: 0, asOf: new Date().toISOString() };
        }
      });
      self.__pinSuffix = '';
      return true;
    }, { host: issuer.domain });
    const pinned = await add(await mk('PINX'));
    const pinId = pinned.value.id;
    await allow(pinId);
    r = await refresh(pinId);
    check('the first lookup through it pins the exact address it used', r.ok === true && (await acct(pinId)).pinnedEndpoint === st.balanceUrl, r);
    s0 = stats();
    await W(() => { self.__pinSuffix = '&moved=1'; return true; });
    r = await refresh(pinId);
    a = await acct(pinId);
    check('the same origin with a different query is a change that needs approval', r.ok === false && r.code === 'endpoint-changed' && a.pendingEndpoint === st.balanceUrl + '&moved=1', r);
    check('...and nothing was sent to the new address', stats().bal === s0.bal);
    check('the card falls back to "available" and keeps showing the old pin', a.indicators.lookup.level === 'available' && a.pinnedEndpoint === st.balanceUrl);
    r = await refresh(pinId);
    check('trying again without approval is still refused', r.ok === false && r.code === 'endpoint-changed' && stats().bal === s0.bal, r);
    const bgRefused = await codeOf((i) => AtlasWallet.setLedgerBackgroundSync(i, true), pinId);
    check('background checks cannot be turned on while a new address waits', !bgRefused.ok && bgRefused.code === 'no-consent', bgRefused);
    await W(() => { self.__pinSuffix = ''; return true; });
    r = await refresh(pinId);
    check('moving back to the old address is also a change until the person decides', r.ok === false && r.code === 'endpoint-changed', r);
    await W(() => { self.__pinSuffix = '&moved=1'; return true; });
    await W((i) => AtlasWallet.approveLedgerEndpoint(i), pinId);
    a = await acct(pinId);
    check('approving makes the new exact address the pin', a.pinnedEndpoint === st.balanceUrl + '&moved=1' && !a.pendingEndpoint);
    s0 = stats();
    r = await refresh(pinId);
    check('after approval the wallet sends to the new address', r.ok === true && st.otherRequests.length === 0 && stats().bal === s0.bal + 1 && st.bodies[st.bodies.length - 1].payload.audience === st.balanceUrl + '&moved=1', r);

    console.log('--- what an adapter may reach and sign ---');
    await W(({ host }) => {
      const real = AtlasLedgerLabs29.createAdapter({ hosts: [host], loopback: true });
      AtlasWallet.clearLedgerAdapters();
      AtlasWallet.registerLedgerAdapter({
        contract: 'scope-test/1', proofFormats: ['raw-ecdsa-p256'], supports: (t) => real.supports(t),
        discover: (t, ctx) => real.discover(t, ctx),
        async fetchBalance(t, found, ctx) {
          const out = { sameOriginOtherPath: null, otherHost: null, signOtherAudience: null, signPlainType: null };
          try { await ctx.fetch(found.operations.balance.replace('action=balance', 'action=transfer')); out.sameOriginOtherPath = 'reached'; } catch (e) { out.sameOriginOtherPath = e.code; }
          try { await ctx.fetch('http://evil.example/x'); out.otherHost = 'reached'; } catch (e) { out.otherHost = e.code; }
          try { await ctx.sign({ type: 'atlas.ledger.balance', v: 1, audience: found.operations.balance.replace('action=balance', 'action=transfer') }); out.signOtherAudience = 'signed'; } catch (e) { out.signOtherAudience = e.code || e.message; }
          try { await ctx.sign({ type: 'something.else', audience: found.operations.balance }); out.signPlainType = 'signed'; } catch (e) { out.signPlainType = e.code || e.message; }
          self.__scope = out;
          return { amount: '1', decimals: 0, asOf: new Date().toISOString() };
        }
      });
      return true;
    }, { host: issuer.domain });
    s0 = stats();
    const scoped = await add(await mk('SCPX'));
    await allow(scoped.value.id);
    await refresh(scoped.value.id);
    const scope = await W(() => self.__scope);
    check('during a balance lookup the adapter cannot fetch another path on the same host', scope.sameOriginOtherPath === 'network', scope);
    check('...or another host', scope.otherHost === 'network', scope);
    check('...and nothing it tried reached the service', stats().other === s0.other);
    check('it cannot have a request for another address signed', scope.signOtherAudience !== 'signed', scope);
    check('it cannot have a message of another kind signed', scope.signPlainType !== 'signed', scope);
    const bridge = await codeOf(() => AtlasWallet.signWithSelf({ type: 'atlas.ledger.balance', v: 1, audience: 'https://x.example/' }));
    check('the page-facing signing function still refuses ledger messages', !bridge.ok && /Ledger messages/.test(bridge.message), bridge);

    // From here on the stock test instance serves the stand-in again.
    await W(() => { AtlasWallet.clearLedgerAdapters(); return true; });
    await installTestInstance();

    console.log('--- a passkey identity ---');
    const kp = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const point = T.b64url(new Uint8Array(await webcrypto.subtle.exportKey('raw', kp.publicKey)));
    const spki = T.b64url(new Uint8Array(await webcrypto.subtle.exportKey('spki', kp.publicKey)));
    check('a passkey identity\'s stored key is longer than the 120 characters the old rule allowed', spki.length === 122);
    // A passkey identity as the wallet stores one. No authenticator is attached: if the wallet
    // tried to use it, the call below would be counted and fail.
    await W(({ spki }) => {
      self.__credCalls = 0;
      Object.defineProperty(navigator, 'credentials', { configurable: true, value: { get: async () => { self.__credCalls++; throw new Error('no authenticator is attached'); } } });
      return chrome.storage.local.set({ atlasWebAuthnIdentity: { credentialId: 'AAAAAAAAAAAAAAAAAAAAAA', publicKey: spki, createdAt: new Date().toISOString() }, atlasIdentityMode: 'webauthn' });
    }, { spki });
    ov = await overview();
    check('the Ledger tab sees a passkey identity under its canonical key', ov.identity.mode === 'webauthn' && ov.identity.publicKey === point && ov.identity.proofFormat === 'webauthn-es256' && ov.identity.canSignSilently === false, ov.identity);
    check('this identity starts with no accounts (the password identity\'s are separate)', ov.accounts.length === 0 && ov.otherIdentities === 1);
    const passCred = await mk('GOPH', point);
    const passAdd = await add(passCred);
    check('a credential owned by the passkey identity can be added (the key-format problem is gone)', passAdd.ok, passAdd);
    const passId = passAdd.value.id;
    const passBeforeConsent = await refresh(passId);
    check('without permission nothing happens', passBeforeConsent.ok === false && passBeforeConsent.code === 'no-consent');
    await allow(passId);
    s0 = stats();
    a = await acct(passId);
    check('lookup is shown as unavailable, saying the ledger cannot check this kind of identity', a.indicators.lookup.level === 'unavailable' && /cannot check this kind of identity/.test(a.indicators.lookup.detail) && a.indicators.background.level === 'unavailable', a.indicators);
    r = await refresh(passId);
    check('a lookup is refused as "proof unsupported" instead of attempting a proof', r.ok === false && r.code === 'proof-unsupported', r);
    check('no request was made to the service', JSON.stringify(stats()) === JSON.stringify(s0));
    check('and the passkey was never asked for a signature', (await W(() => self.__credCalls)) === 0);
    const bg = await codeOf((i) => AtlasWallet.setLedgerBackgroundSync(i, true), passId);
    check('background checks cannot be turned on for it', !bg.ok && (bg.code === 'unknown' || bg.code === 'proof-unsupported'), bg);
    const sync = await W(() => AtlasWallet.runLedgerBackgroundSync({ now: Date.now() + 3600000 }));
    check('the background runner does nothing for a passkey identity', sync.ran === 0 && JSON.stringify(stats()) === JSON.stringify(s0));
    const rd = await codeOf((d) => AtlasWallet.rediscoverLedgerAccounts(d, { allowNetwork: true }), issuer.domain);
    check('finding accounts again is not offered by this interface, and does not ask the passkey either', !rd.ok && rd.code === 'no-adapter' && (await W(() => self.__credCalls)) === 0, rd);
    await W(() => chrome.storage.local.set({ atlasIdentityMode: 'local' }));
    ov = await overview();
    check('switching back to the password identity shows its own accounts, with lookups available', ov.identity.publicKey === w.pub && ov.accounts.length >= 3 && ov.accounts.every((x) => x.indicators.lookup.level !== 'unavailable'));

    console.log('--- background checks stay a separate, opt-in choice ---');
    a = await acct(accounts.GOPH);
    check('permission alone left background checks off', a.backgroundSync === false);
    await W((i) => AtlasWallet.setLedgerBackgroundSync(i, true), accounts.GOPH);
    st.mode = 'ok';
    s0 = stats();
    let ran = await W(() => AtlasWallet.runLedgerBackgroundSync({ now: Date.now() }));
    const tooSoon = stats().bal === s0.bal;
    ran = await W(() => AtlasWallet.runLedgerBackgroundSync({ now: Date.now() + 11 * 60 * 1000 }));
    check('once on, a check runs when due, and not before', tooSoon && ran.ran >= 1 && stats().bal > s0.bal, ran);
    check('the account that was not switched on was not checked in the background', (await acct(accounts.MWC)).backgroundSync === false);
    await W(() => AtlasWallet.clearLedgerAdapters());
    exp = await W(() => AtlasWallet.setLedgerExperimental('labs29', true));
    exp = await W(() => AtlasWallet.setLedgerExperimental('labs29', false));
    a = await acct(accounts.GOPH);
    check('with no interface left to serve it, background checks are turned off and stay off', a.backgroundSync === false);
    await installTestInstance();
    a = await acct(accounts.GOPH);
    check('bringing an interface back does not turn them on again', a.backgroundSync === false);
  } finally {
    await w.close();
    await issuer.close();
  }
  process.exit(L.finish('manual-ledger-labs29-wallet'));
})().catch((e) => { console.log('FATAL ' + (e && e.stack || e)); process.exit(1); });
