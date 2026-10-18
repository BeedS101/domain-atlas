// Wallet-level checks for ledger accounts, in a real Chromium with the extension loaded.
//
// The issuer and the ledger are local test doubles (test/ledger-test-lib.js). The ledger is
// SIMULATED: it implements an invented request shape so the wallet's own behaviour can be
// checked. Nothing here says anything about a real ledger's interface or balances.
//
// Needs no demo domain. Run: xvfb-run -a node test/manual-ledger-wallet.js
'use strict';
const L = require('./call-e2e-lib');
const T = require('./ledger-test-lib');
const { check, until, sleep } = L;

(async () => {
  const issuer = await T.startIssuer();
  const ledger = await T.startLedger();
  const other = await T.startLedger(); // a second ledger, to see where the wallet will and will not go
  issuer.state.endpoint = ledger.origin;
  const w = await L.launchWallet('ledger');
  const W = w.wallet;
  const NET = 'test-network-1';
  try {
    w.pub = (await W((pw) => AtlasWallet.createIdentity(pw), 'ledger-test-password')).publicKey;
    const fakeBytes = require('crypto').webcrypto.getRandomValues(new Uint8Array(65)); fakeBytes[0] = 4;
    const fakeOwner = T.b64url(fakeBytes);
    const assetsBefore = await W((k) => AtlasWallet.getWallet(k), w.pub);
    const mk = (coin, over) => issuer.issue(w.pub, { network: NET, coin }, over);
    const overview = () => W(() => AtlasWallet.getLedgerOverview());
    const acct = async (id) => (await overview()).accounts.find((a) => a.id === id);
    // Errors cross the evaluate boundary as messages only; this returns { ok, value } or { ok: false, code, message }.
    const codeOf = (fn, arg) => w.sw.evaluate('(async () => { try { return { ok: true, value: await (' + fn.toString() + ')(' + JSON.stringify(arg === undefined ? null : arg) + ') }; } catch (e) { return { ok: false, code: e.code || null, message: e.message }; } })()');
    const ledgerCalls = () => ledger.state.requests.length + other.state.requests.length;

    console.log('--- a fresh wallet ---');
    let ov = await overview();
    check('the Ledger overview starts empty for the identity in use', ov.identity && ov.identity.publicKey === w.pub && ov.accounts.length === 0 && ov.otherIdentities === 0);
    check('no ledger adapter is registered in a fresh wallet', ov.adapters.length === 0);

    console.log('--- adding a reference ---');
    const gop = await mk('GOPH');
    let r = await codeOf((c) => AtlasWallet.addLedgerAccount(c, {}), gop);
    check('adding without permission to contact the issuer is refused', !r.ok && r.code === 'no-consent');
    check('the refusal made no request to the issuer', issuer.state.requests.length === 0);
    const withBalance = Object.assign({}, gop, { balance: '1000' });
    r = await codeOf((c) => AtlasWallet.addLedgerAccount(c, { allowNetwork: true }), withBalance);
    check('a credential that carries a balance is refused before any request', !r.ok && r.code === 'credential-invalid' && /balance/i.test(r.message) && issuer.state.requests.length === 0, r);
    const tampered = Object.assign({}, gop, { ledger: { network: NET, coin: 'MWC' } });
    r = await codeOf((c) => AtlasWallet.addLedgerAccount(c, { allowNetwork: true }), tampered);
    check('a credential whose contents were changed fails the issuer signature', !r.ok && r.code === 'credential-invalid' && /signature/.test(r.message), r);
    const stranger = await issuer.issue(fakeOwner, { network: NET, coin: 'GOPH' });
    r = await codeOf((c) => AtlasWallet.addLedgerAccount(c, { allowNetwork: true }), stranger);
    check('an account that belongs to a different identity is not added', !r.ok && r.code === 'wrong-identity', r);
    const foreignIssuer = await issuer.issue(w.pub, { network: NET, coin: 'GOPH' }, { issuerDomain: 'localhost:1' });
    r = await codeOf((c) => AtlasWallet.addLedgerAccount(c, { allowNetwork: true }), foreignIssuer);
    check('a credential naming an issuer that cannot confirm it is not added', !r.ok && r.code === 'credential-invalid', r);
    const revoked = await mk('REVD');
    issuer.state.revoked.push(revoked.id);
    r = await codeOf((c) => AtlasWallet.addLedgerAccount(c, { allowNetwork: true }), revoked);
    check('a credential the issuer has revoked is not added', !r.ok && r.code === 'credential-invalid' && /revoked/.test(r.message), r);
    check('none of the refusals stored anything', (await overview()).accounts.length === 0);
    check('none of the refusals reached a ledger', ledgerCalls() === 0);

    r = await codeOf((c) => AtlasWallet.addLedgerAccount(c, { allowNetwork: true }), gop);
    check('a valid credential is added after the issuer is asked', r.ok && issuer.state.requests.some((q) => /atlas-key\.json/.test(q)));
    check('adding contacted only the issuing domain, never a ledger', ledgerCalls() === 0 && issuer.state.requests.every((q) => /well-known\/atlas-(key|revocations)\.json/.test(q)), issuer.state.requests);
    const mwc = await mk('MWC');
    await W((c) => AtlasWallet.addLedgerAccount(c, { allowNetwork: true }), mwc);
    r = await codeOf((c) => AtlasWallet.addLedgerAccount(c, { allowNetwork: true }), gop);
    check('adding the same account twice is refused', !r.ok);
    ov = await overview();
    check('both references are listed for this identity', ov.accounts.length === 2 && ov.accounts.map((a) => a.coin).sort().join() === 'GOPH,MWC');
    const g = ov.accounts.find((a) => a.coin === 'GOPH');
    check('a new reference has no balance, no permission and background checks off', g.balance === null && g.consent === null && g.backgroundSync === false);
    check('the stored credential is exactly the one the issuer signed', JSON.stringify(g.credential) === JSON.stringify(gop));
    check('the asset wallet is untouched by ledger references', JSON.stringify(await W((k) => AtlasWallet.getWallet(k), w.pub)) === JSON.stringify(assetsBefore));
    const raw = await W(() => chrome.storage.local.get('atlasLedgerAccounts'));
    const stored = raw.atlasLedgerAccounts[w.pub];
    check('references are encrypted at rest', stored && stored.__atlasEncrypted === true && !JSON.stringify(raw).includes('GOPH'));

    console.log('--- with no way to reach a ledger ---');
    check('lookup is unavailable and says there is no way to reach the ledger', g.indicators.lookup.level === 'unavailable' && /no way to reach/.test(g.indicators.lookup.detail), g.indicators);
    check('background check is unavailable too', g.indicators.background.level === 'unavailable');
    await W((id) => AtlasWallet.grantLedgerConsent(id), g.id);
    const noAd = await codeOf((id) => AtlasWallet.refreshLedgerAccount(id, { reason: 'manual' }), g.id);
    check('a lookup with permission but no adapter does nothing and says why', noAd.ok && noAd.value.ok === false && noAd.value.code === 'no-adapter');
    check('still no request to any ledger', ledgerCalls() === 0 && !issuer.state.requests.some((q) => /atlas-ledger/.test(q)));
    await W((id) => AtlasWallet.revokeLedgerConsent(id), g.id);

    console.log('--- the generic signer and ledger messages ---');
    const sign1 = await codeOf(() => AtlasWallet.signWithSelf({ type: 'atlas.ledger.balance', audience: 'http://x' }), null);
    check('the generic signer refuses a ledger message', !sign1.ok && /Ledger messages/.test(sign1.message), sign1);
    const sign2 = await codeOf(() => AtlasWallet.signWithSelf({ type: 'note', nested: { type: 'atlas.ledger.read' } }), null);
    check('the generic signer refuses a ledger message nested inside another', !sign2.ok);
    const sign3 = await codeOf(() => AtlasWallet.signWithSelf({ purpose: 'ordinary', nonce: 'abc' }), null);
    check('the generic signer still signs an ordinary payload', sign3.ok && sign3.value && sign3.value.signature);

    console.log('--- installing a simulated ledger adapter ---');
    await W(T.installSimulatedAdapter, {});
    ov = await overview();
    const g2 = ov.accounts.find((a) => a.coin === 'GOPH');
    check('with an adapter, lookup becomes available but not allowed', g2.indicators.lookup.level === 'available' && g2.consent === null);
    const before = ledgerCalls();
    r = await codeOf((id) => AtlasWallet.refreshLedgerAccount(id, { reason: 'manual' }), g2.id);
    check('a lookup without permission is refused', r.ok && r.value.ok === false && r.value.code === 'no-consent');
    r = await codeOf((id) => AtlasWallet.refreshLedgerAccountsOnOpen(), null);
    check('opening the tab does not look up an account that was not allowed', r.ok && r.value.length === 0);
    check('no request reached a ledger or the discovery document', ledgerCalls() === before && !issuer.state.requests.some((q) => /atlas-ledger/.test(q)));
    r = await codeOf((id) => AtlasWallet.setLedgerBackgroundSync(id, true), g2.id);
    check('background checks cannot be turned on before lookups are allowed', !r.ok && r.code === 'no-consent');

    console.log('--- allowing lookups ---');
    await W((id) => AtlasWallet.grantLedgerConsent(id), g2.id);
    let a = await acct(g2.id);
    check('after permission lookup is enabled and background checks are available but off', a.indicators.lookup.level === 'enabled' && a.indicators.background.level === 'available' && a.backgroundSync === false, a.indicators);
    check('granting permission itself contacted nothing', ledgerCalls() === 0 && !issuer.state.requests.some((q) => /atlas-ledger/.test(q)));
    r = await codeOf((id) => AtlasWallet.refreshLedgerAccount(id, { reason: 'manual' }), g2.id);
    check('a lookup for an account the ledger has not opened reports that, and shows no balance', r.ok && r.value.ok === false && r.value.code === 'not-found', r);
    a = await acct(g2.id);
    check('the problem is remembered and no balance is invented', a.balance === null && a.problem && a.problem.code === 'not-found');
    check('the ledger was asked with a request signed by this identity and addressed to it', ledger.state.seenPayloads.length === 1 && ledger.state.seenPayloads[0].audience === ledger.origin + '/balance' && ledger.state.seenPayloads[0].type === 'atlas.ledger.balance');

    ledger.open(w.pub, NET, 'GOPH', '1250', 2);
    r = await codeOf((id) => AtlasWallet.refreshLedgerAccount(id, { reason: 'manual' }), g2.id);
    check('once the ledger holds the account, the lookup returns its balance', r.ok && r.value.ok === true && r.value.balance.text === '12.50', r);
    a = await acct(g2.id);
    check('the balance is kept with the time the ledger gave and where it came from', a.balance && a.balance.text === '12.50' && a.balance.asOf && a.balance.endpointOrigin === ledger.origin && a.problem === null);
    check('the credential still carries no balance after a lookup', JSON.stringify(a.credential) === JSON.stringify(gop));
    check('the stored credential has no figure in it', !/12\.50|1250/.test(JSON.stringify(a.credential)));
    check('a lookup for the other coin does nothing without its own permission', (await codeOf((id) => AtlasWallet.refreshLedgerAccount(id, {}), (await overview()).accounts.find((x) => x.coin === 'MWC').id)).value.code === 'no-consent');
    check('the wallet asked the issuing domain, then the ledger it named', issuer.state.requests.some((q) => /atlas-ledger\.json/.test(q)) && ledger.state.requests.some((q) => /POST \/balance/.test(q)));

    console.log('--- the ledger address changes ---');
    issuer.state.endpoint = other.origin;
    other.open(w.pub, NET, 'GOPH', '99', 0);
    const otherBefore = other.state.requests.length;
    r = await codeOf((id) => AtlasWallet.refreshLedgerAccount(id, { reason: 'manual' }), g2.id);
    check('a different ledger address is not contacted without approval', r.ok && r.value.code === 'endpoint-changed' && other.state.requests.length === otherBefore);
    a = await acct(g2.id);
    check('the card shows the new address waiting for approval and lookup falls back to available', a.pendingEndpointOrigin === other.origin && a.indicators.lookup.level === 'available' && a.indicators.background.level === 'unavailable');
    r = await codeOf((id) => AtlasWallet.setLedgerBackgroundSync(id, true), g2.id);
    check('background checks cannot be turned on while an address change is waiting', !r.ok);
    await W((id) => AtlasWallet.approveLedgerEndpoint(id), g2.id);
    r = await codeOf((id) => AtlasWallet.refreshLedgerAccount(id, { reason: 'manual' }), g2.id);
    check('after approval the new address is used', r.ok && r.value.ok === true && r.value.balance.text === '99' && other.state.requests.length === otherBefore + 1);
    issuer.state.endpoint = ledger.origin;
    await W((id) => AtlasWallet.approveLedgerEndpoint(id).catch(() => null), g2.id);
    r = await codeOf((id) => AtlasWallet.refreshLedgerAccount(id, { reason: 'manual' }), g2.id);
    check('a move back is a change too and needs approval', r.ok && r.value.code === 'endpoint-changed');
    await W((id) => AtlasWallet.approveLedgerEndpoint(id), g2.id);

    console.log('--- what an adapter may reach ---');
    await W(() => { AtlasWallet.clearLedgerAdapters(); });
    await W(T.installSimulatedAdapter, { leakTo: other.origin });
    const otherNow = other.state.requests.length;
    await codeOf((id) => AtlasWallet.refreshLedgerAccount(id, { reason: 'manual' }), g2.id);
    check('an adapter cannot use the wallet fetch for an address nobody allowed', (await W(() => globalThis.__leak)) === 'blocked:network' && other.state.requests.length === otherNow);
    await W(() => { AtlasWallet.clearLedgerAdapters(); });
    await W(T.installSimulatedAdapter, {});

    console.log('--- bad answers ---');
    ledger.state.mode = 'garbage';
    const keep = (await acct(g2.id)).balance;
    r = await codeOf((id) => AtlasWallet.refreshLedgerAccount(id, { reason: 'manual' }), g2.id);
    check('an answer the wallet cannot read is reported and changes no balance', r.ok && r.value.code === 'bad-response' && JSON.stringify((await acct(g2.id)).balance) === JSON.stringify(keep));
    ledger.state.mode = 'ok';

    console.log('--- background checks ---');
    a = await acct(g2.id);
    check('background checks are off by default for every account', (await overview()).accounts.every((x) => x.backgroundSync === false));
    await W((id) => AtlasWallet.setLedgerBackgroundSync(id, true), g2.id);
    a = await acct(g2.id);
    check('turning them on shows the background level as enabled', a.backgroundSync === true && a.indicators.background.level === 'enabled');
    check('only the chosen account was turned on', (await overview()).accounts.filter((x) => x.backgroundSync).length === 1);
    const preSync = ledger.state.requests.length;
    ledger.state.mode = 'ok';
    r = await codeOf(() => AtlasWallet.runLedgerBackgroundSync(), null);
    check('a timer pass straight after a manual lookup leaves it alone (the figure is fresh)', r.ok && r.value.ran === 0 && ledger.state.requests.length === preSync);
    r = await codeOf((t) => AtlasWallet.runLedgerBackgroundSync({ now: t }), Date.now() + 11 * 60 * 1000);
    check('a timer pass ten minutes later checks the account whose switch is on', r.ok && r.value.ran === 1 && ledger.state.requests.length === preSync + 1, r);
    r = await codeOf(() => AtlasWallet.runLedgerBackgroundSync(), null);
    check('a second pass straight away does not check it again', r.ok && r.value.ran === 0);
    await W((id) => AtlasWallet.setLedgerBackgroundSync(id, false), g2.id);
    check('turning the switch off leaves permission for manual lookups', (await acct(g2.id)).consent && (await acct(g2.id)).backgroundSync === false);

    console.log('--- taking permission back stops everything for the account ---');
    await W((id) => AtlasWallet.setLedgerBackgroundSync(id, true), g2.id);
    ledger.state.delayMs = 1500;
    const slow = W((id) => AtlasWallet.refreshLedgerAccount(id, { reason: 'manual' }), g2.id);
    await until(async () => (await acct(g2.id)).connecting === true, 5000, 50);
    a = await acct(g2.id);
    check('while a request is out the lookup level is connecting', a.indicators.lookup.level === 'connecting' && a.indicators.background.level === 'enabled');
    await W((id) => AtlasWallet.revokeLedgerConsent(id), g2.id);
    const slowResult = await slow;
    check('taking permission back cancels the request in flight', slowResult.ok === false && slowResult.code === 'cancelled', slowResult);
    ledger.state.delayMs = 0;
    a = await acct(g2.id);
    check('permission and the background switch are both gone, and the last balance is kept as a last report', a.consent === null && a.backgroundSync === false && a.balance && a.balance.text === '12.50');
    check('lookup is available again and background checks unavailable', a.indicators.lookup.level === 'available' && a.indicators.background.level === 'unavailable');
    const afterRevoke = ledgerCalls();
    r = await codeOf(() => AtlasWallet.runLedgerBackgroundSync(), null);
    check('a timer pass after that contacts nothing', r.ok && r.value.ran === 0 && ledgerCalls() === afterRevoke);

    console.log('--- removing a reference ---');
    ledger.open(w.pub, NET, 'GOPH', '1250', 2);
    issuer.state.endpoint = ledger.origin;
    await W((id) => AtlasWallet.grantLedgerConsent(id), g2.id);
    await W((id) => AtlasWallet.approveLedgerEndpoint(id).catch(() => null), g2.id);
    await W((id) => AtlasWallet.refreshLedgerAccount(id, {}), g2.id);
    await W((id) => AtlasWallet.setLedgerBackgroundSync(id, true), g2.id);
    ledger.state.delayMs = 1500;
    const callsBeforeSlow = ledgerCalls();
    const slow2 = W((id) => AtlasWallet.refreshLedgerAccount(id, { reason: 'manual' }), g2.id);
    await until(async () => (await acct(g2.id)).connecting === true, 5000, 50);
    // The request is only "in flight" once the ledger has received it and is holding the answer.
    await until(async () => ledgerCalls() > callsBeforeSlow, 5000, 20);
    const callsAtRemove = ledgerCalls(), issuerAtRemove = issuer.state.requests.length;
    const gone = await codeOf((id) => AtlasWallet.removeLedgerAccount(id), g2.id);
    check('removal reports that the ledger was not touched', gone.ok && gone.value.removed === true && gone.value.ledgerTouched === false);
    const slow2Result = await slow2;
    ledger.state.delayMs = 0;
    check('removing the reference cancels its request in flight', slow2Result.ok === false && slow2Result.code === 'cancelled', slow2Result);
    check('the reference is gone from the wallet', !(await acct(g2.id)) && (await overview()).accounts.length === 1);
    check('removal made no request to the ledger or the issuer', ledgerCalls() === callsAtRemove && issuer.state.requests.length === issuerAtRemove);
    check('the ledger account and its balance are exactly as they were', ledger.has(w.pub, NET, 'GOPH') && ledger.balanceOf(w.pub, NET, 'GOPH') === '1250');
    r = await codeOf(() => AtlasWallet.runLedgerBackgroundSync(), null);
    check('no background activity continues for a removed account', r.ok && r.value.ran === 0);
    await sleep(300);
    check('and nothing has been sent since', ledgerCalls() === callsAtRemove);
    r = await codeOf((id) => AtlasWallet.removeLedgerAccount(id), g2.id);
    check('removing it again is harmless', r.ok && r.value.removed === false);

    console.log('--- finding accounts again ---');
    ledger.state.listing = (owner) => (owner === w.pub ? [gop] : []);
    const before2 = ledgerCalls();
    r = await codeOf((d) => AtlasWallet.rediscoverLedgerAccounts(d, {}), issuer.domain);
    check('looking for accounts without permission is refused and sends nothing', !r.ok && r.code === 'no-consent' && ledgerCalls() === before2);
    r = await codeOf((d) => AtlasWallet.rediscoverLedgerAccounts(d, { allowNetwork: true }), issuer.domain);
    check('with permission the removed account is found again by this identity', r.ok && r.value.added.length === 1 && r.value.added[0] === gop.id, r);
    const proof = ledger.state.seenPayloads.filter((p) => p.type === 'atlas.ledger.accounts').pop();
    check('the request proved ownership by a signature, addressed to the ledger', proof && proof.audience === ledger.origin + '/accounts');
    a = await acct(gop.id);
    check('the rediscovered reference starts with no permission and background checks off', a && a.consent === null && a.backgroundSync === false && a.balance === null);
    const foreignOne = await issuer.issue(fakeOwner, { network: NET, coin: 'GOPH' });
    const otherIssuerOne = await mk('XYZ', { issuerDomain: 'localhost:2' });
    ledger.state.listing = () => [foreignOne, otherIssuerOne, { junk: true }, mwc, gop];
    await W((id) => AtlasWallet.removeLedgerAccount(id), gop.id);
    r = await codeOf((d) => AtlasWallet.rediscoverLedgerAccounts(d, { allowNetwork: true }), issuer.domain);
    const codes = r.value ? r.value.skipped.map((s) => s.code).sort().join() : '';
    check('only accounts that belong to this identity and this issuer are added', r.ok && r.value.added.length === 1 && r.value.added[0] === gop.id, r);
    check('the others are skipped with a reason (wrong owner, wrong issuer, malformed, already held)', r.ok && r.value.skipped.length === 4 && codes.includes('wrong-identity') && codes.includes('credential-invalid'), codes);
    r = await codeOf((d) => AtlasWallet.rediscoverLedgerAccounts(d, { allowNetwork: true }), 'https://not-a-host');
    check('a domain written as a web address is refused', !r.ok && r.code === 'credential-invalid');

    console.log('--- other identities and locking ---');
    await W(async (k) => {
      const o = await chrome.storage.local.get('atlasLedgerAccounts');
      const all = o.atlasLedgerAccounts || {};
      all['SOMEONE-ELSE-KEY'] = { saved: true };
      await chrome.storage.local.set({ atlasLedgerAccounts: all });
    }, null);
    ov = await overview();
    check('accounts saved for another identity are counted but not shown', ov.otherIdentities === 1 && ov.accounts.every((x) => x.ownerPublicKey === w.pub));
    await W(() => AtlasWallet.lockIdentity());
    const locked = await overview();
    check('with the wallet locked no account is listed', locked.identity === null && locked.accounts.length === 0);
    const lockedCalls = ledgerCalls();
    r = await codeOf((id) => AtlasWallet.refreshLedgerAccount(id, {}), gop.id);
    check('a lookup while locked does nothing', r.ok && r.value.code === 'locked' && ledgerCalls() === lockedCalls);
    r = await codeOf(() => AtlasWallet.runLedgerBackgroundSync(), null);
    check('background checks do not run while locked', r.ok && r.value.ran === 0 && ledgerCalls() === lockedCalls);
    r = await codeOf((id) => AtlasWallet.grantLedgerConsent(id), gop.id);
    check('permission cannot be changed while locked', !r.ok && r.code === 'locked');
    r = await codeOf((id) => AtlasWallet.removeLedgerAccount(id), gop.id);
    check('a reference cannot be removed while locked', !r.ok && r.code === 'locked');
    await W((pw) => AtlasWallet.unlockIdentity(pw), 'ledger-test-password');
    ov = await overview();
    check('after unlocking the same accounts are back', ov.accounts.length === 2 && ov.accounts.some((x) => x.coin === 'GOPH'));
    const sameStore = await W(() => chrome.storage.local.get('atlasLedgerAccounts'));
    check('the other identity\'s saved list was left alone', sameStore.atlasLedgerAccounts['SOMEONE-ELSE-KEY'] && sameStore.atlasLedgerAccounts['SOMEONE-ELSE-KEY'].saved === true);

    console.log('--- the activity log ---');
    const log = await W(() => AtlasWallet.getActivityLog());
    const ledgerLines = log.filter((e) => e.type === 'ledger').map((e) => e.text);
    check('ledger actions are logged', ledgerLines.length >= 5 && ledgerLines.some((t) => /Removed the wallet's reference/.test(t) && /unchanged/.test(t)));
    check('the log never records a balance', !ledgerLines.some((t) => /\b1250\b|12\.50/.test(t)));

    check('the asset wallet is still exactly as before', JSON.stringify(await W((k) => AtlasWallet.getWallet(k), w.pub)) === JSON.stringify(assetsBefore));
  } finally {
    await w.close();
    await issuer.close(); await ledger.close(); await other.close();
  }
  process.exit(L.finish('manual-ledger-wallet'));
})().catch((e) => { console.log('FATAL ' + (e && e.stack || e)); process.exit(1); });
