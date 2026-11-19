// Activity Log retention (wallet.js: getActivityLogRetention, setActivityLogRetention, and the limit applied by
// logActivity): the four choices, the default, oldest-first recycling, keeping the newest when the limit is lowered, one
// setting and one log per identity, encryption at rest, an existing history surviving the upgrade untouched until a
// limit is chosen, and nothing outside the log changing.
//
// Loads extension/wallet.js in a vm with in-memory extension storage; no browser, no network. logActivity is internal to
// the wallet, so the test exposes it on the loaded copy only (the shipped API is unchanged).
//
//   node test/wallet-activity-log-retention.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passes = 0, failures = 0;
const check = (name, ok, detail) => {
  if (ok) { passes++; console.log('PASS ' + name); } else { failures++; console.log('FAIL ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 300) : '')); }
};

const EXPOSE = 'getActivityLog, clearActivityLog,';
let SRC = fs.readFileSync(path.resolve(__dirname, '..', 'extension', 'wallet.js'), 'utf8');
if (!SRC.includes(EXPOSE)) throw new Error('the wallet export list changed; update this test');
SRC = SRC.replace(EXPOSE, 'logActivity, ' + EXPOSE);

function area(store) {
  const pick = (k) => {
    if (k === null || k === undefined) return { ...store };
    const keys = Array.isArray(k) ? k : typeof k === 'string' ? [k] : Object.keys(k);
    const out = {};
    for (const key of keys) if (key in store) out[key] = store[key];
    return out;
  };
  return {
    get: async (k) => pick(k),
    set: async (o) => { Object.assign(store, o); },
    remove: async (k) => { for (const key of (Array.isArray(k) ? k : [k])) delete store[key]; }
  };
}

function load(local, session) {
  const ctx = {
    console, URL, URLSearchParams, TextEncoder, TextDecoder, AbortController, setTimeout, clearTimeout, btoa, atob,
    crypto: require('crypto').webcrypto,
    chrome: { storage: { local: area(local), session: area(session), onChanged: { addListener() {} } }, runtime: {} },
    navigator: {},
    fetch: async () => { throw new Error('network is not available in this test'); }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC + '\n;globalThis.__W = AtlasWallet;', ctx);
  return ctx.__W;
}

const add = async (W, from, to) => { for (let i = from; i <= to; i++) await W.logActivity('asset', 'event ' + i); };
const texts = (list) => list.map((e) => e.text);
const rawOf = (local, key) => JSON.stringify(local[key] || {});

(async () => {
  const local = {}, session = {};
  let W = load(local, session);
  const me = (await W.createIdentity('retention-password')).publicKey;

  console.log('--- the choices ---');
  check('the four choices are 50 Small, 100 Standard, 250 Extended and 500 Maximum', W.ACTIVITY_LOG_RETENTION_OPTIONS.map((o) => o.limit + ' ' + o.label).join() === '50 Small,100 Standard,250 Extended,500 Maximum', W.ACTIVITY_LOG_RETENTION_OPTIONS);
  let r = await W.getActivityLogRetention();
  check('a new identity has chosen nothing and is on the Standard limit', r.chosen === null && r.limit === 100, r);
  check('it starts with just its creation entry', r.count === 1 && texts(await W.getActivityLog())[0] === 'Identity created');

  console.log('--- the default limit and oldest-first recycling ---');
  await add(W, 1, 150);
  let log = await W.getActivityLog();
  check('an identity that never chose keeps 100 entries', log.length === 100, log.length);
  check('the newest are kept and the oldest recycled', log[0].text === 'event 150' && log[99].text === 'event 51', [log[0].text, log[99].text]);
  check('the count reported is the number stored', (await W.getActivityLogRetention()).count === 100);

  console.log('--- choosing a limit ---');
  let out = await W.setActivityLogRetention(50);
  log = await W.getActivityLog();
  check('lowering the limit keeps the newest entries', out.limit === 50 && out.removed === 50 && out.count === 50 && log.length === 50 && log[0].text === 'event 150' && log[49].text === 'event 101', out);
  r = await W.getActivityLogRetention();
  check('the choice is reported and in force', r.chosen === 50 && r.limit === 50 && r.count === 50, r);
  await add(W, 151, 160);
  log = await W.getActivityLog();
  check('at the limit each new entry recycles the oldest', log.length === 50 && log[0].text === 'event 160' && log[49].text === 'event 111', [log.length, log[0].text, log[49].text]);
  out = await W.setActivityLogRetention('250');
  check('raising the limit removes nothing and room opens for new entries', out.removed === 0 && (await W.getActivityLog()).length === 50);
  await add(W, 161, 400);
  log = await W.getActivityLog();
  check('the log then grows to the new limit and stops there', log.length === 250 && log[0].text === 'event 400' && log[249].text === 'event 151', [log.length, log[0].text, log[249].text]);
  out = await W.setActivityLogRetention(500);
  await add(W, 401, 800);
  log = await W.getActivityLog();
  check('Maximum keeps 500', out.removed === 0 && log.length === 500 && log[0].text === 'event 800' && log[499].text === 'event 301', [log.length, log[0].text, log[499].text]);
  out = await W.setActivityLogRetention(100);
  log = await W.getActivityLog();
  check('dropping from Maximum to Standard keeps the newest 100', out.removed === 400 && log.length === 100 && log[0].text === 'event 800' && log[99].text === 'event 701', [out, log.length]);
  check('lowering to the limit already in force changes nothing', (await W.setActivityLogRetention(100)).removed === 0 && (await W.getActivityLog()).length === 100);
  let bad = 0;
  for (const v of [0, 49, 75, 300, 1000, -50, 'many', null, undefined, NaN]) { try { await W.setActivityLogRetention(v); } catch (e) { bad++; } }
  check('anything other than the four choices is refused', bad === 10, bad);
  check('and a refused value changes neither the setting nor the log', (await W.getActivityLogRetention()).chosen === 100 && (await W.getActivityLog()).length === 100);

  console.log('--- survives a reload ---');
  W = load(local, session);
  r = await W.getActivityLogRetention();
  check('the choice and the log are the same after the wallet is loaded again', r.chosen === 100 && r.count === 100 && (await W.getActivityLog())[0].text === 'event 800', r);

  console.log('--- encryption and storage ---');
  check('the log is stored encrypted, not as readable text', /__atlasEncrypted/.test(rawOf(local, 'atlasActivityLog')) && !/event 7/.test(rawOf(local, 'atlasActivityLog')));
  check('the choice is stored encrypted too, under this identity only', /__atlasEncrypted/.test(rawOf(local, 'atlasActivityLogRetention')) && !/"limit"/.test(rawOf(local, 'atlasActivityLogRetention')) && Object.keys(local.atlasActivityLogRetention).join() === me, Object.keys(local.atlasActivityLogRetention));

  console.log('--- one setting and one log per identity ---');
  const local2 = {}, session2 = {};
  const W2 = load(local2, session2);
  const other = (await W2.createIdentity('other-retention-password')).publicKey;
  local2.atlasActivityLog = { ...local.atlasActivityLog, ...local2.atlasActivityLog };
  local2.atlasActivityLogRetention = { ...local.atlasActivityLogRetention };
  r = await W2.getActivityLogRetention();
  check('the other identity sees none of the first identity\'s entries or choice', other !== me && r.chosen === null && r.count === 1 && (await W2.getActivityLog()).every((e) => !/^event /.test(e.text)), r);
  await W2.setActivityLogRetention(250);
  await add(W2, 1, 300);
  check('it keeps its own 250', (await W2.getActivityLog()).length === 250 && (await W2.getActivityLogRetention()).chosen === 250);
  check('the first identity is untouched by that', (await W.getActivityLog()).length === 100 && (await W.getActivityLogRetention()).chosen === 100 && (await W.getActivityLog())[0].text === 'event 800');
  check('both choices live side by side, one record per identity', Object.keys(local2.atlasActivityLogRetention).sort().join() === [me, other].sort().join() && Object.keys(local2.atlasActivityLog).length === 2);
  check('the first identity\'s stored record was not rewritten by the other one', JSON.stringify(local2.atlasActivityLog[me]) === JSON.stringify(local.atlasActivityLog[me]) && JSON.stringify(local2.atlasActivityLogRetention[me]) === JSON.stringify(local.atlasActivityLogRetention[me]));

  console.log('--- an existing history is kept on upgrade ---');
  const localU = {}, sessionU = {};
  let U = load(localU, sessionU);
  const mine = (await U.createIdentity('upgrade-password')).publicKey;
  await U.setActivityLogRetention(500);
  await add(U, 1, 126); // plus the creation entry: 127 stored
  delete localU.atlasActivityLogRetention; // the state before this setting existed: a history and no choice
  U = load(localU, sessionU);
  r = await U.getActivityLogRetention();
  check('with a history of 127 and no choice, nothing is truncated on read', r.chosen === null && r.count === 127 && r.limit === 127 && (await U.getActivityLog()).length === 127, r);
  await add(U, 127, 131);
  log = await U.getActivityLog();
  check('new entries recycle the oldest one for one, so the history is never cut below what it was', log.length === 127 && log[0].text === 'event 131' && log[126].text === 'event 5', [log.length, log[0].text, log[126].text]);
  check('no choice has been stored by logging', localU.atlasActivityLogRetention === undefined);
  out = await U.setActivityLogRetention(100);
  check('choosing a limit is what shortens it, and it keeps the newest', out.removed === 27 && (await U.getActivityLog()).length === 100 && (await U.getActivityLog())[0].text === 'event 131');

  const localV = {}, sessionV = {};
  let V = load(localV, sessionV);
  await V.createIdentity('upgrade-300-password');
  await V.setActivityLogRetention(500);
  await add(V, 1, 299); // plus the creation entry: 300 stored
  delete localV.atlasActivityLogRetention;
  V = load(localV, sessionV);
  check('a history at the old cap of 300 is kept whole', (await V.getActivityLog()).length === 300 && (await V.getActivityLogRetention()).limit === 300);
  await add(V, 300, 302);
  check('and holds at 300 until a choice is made', (await V.getActivityLog()).length === 300 && (await V.getActivityLog())[0].text === 'event 302');

  const localW = {}, sessionW = {};
  const Wsmall = load(localW, sessionW);
  await Wsmall.createIdentity('small-history-password');
  await add(Wsmall, 1, 40);
  check('a short history is not affected: it grows to the Standard limit', (await Wsmall.getActivityLog()).length === 41 && (await Wsmall.getActivityLogRetention()).limit === 100);

  const localP = {}, sessionP = {};
  const P = load(localP, sessionP);
  const plainOwner = (await P.createIdentity('legacy-plaintext-password')).publicKey;
  localP.atlasActivityLog = { [plainOwner]: Array.from({ length: 140 }, (_, i) => ({ id: 'old-' + i, type: 'asset', text: 'old entry ' + (140 - i), at: '2026-01-01T00:00:00.000Z', meta: null })) };
  check('an old unencrypted history is read whole', (await P.getActivityLog()).length === 140 && (await P.getActivityLogRetention()).limit === 140);
  await add(P, 1, 3);
  log = await P.getActivityLog();
  check('and stays at its size once new entries arrive, encrypted from then on', log.length === 140 && log[0].text === 'event 3' && /__atlasEncrypted/.test(rawOf(localP, 'atlasActivityLog')));

  console.log('--- an unreadable stored choice is treated as no choice ---');
  const localB = {}, sessionB = {};
  const B = load(localB, sessionB);
  const bOwner = (await B.createIdentity('bad-choice-password')).publicKey;
  localB.atlasActivityLogRetention = { [bOwner]: { __atlasEncrypted: true, iv: 'AAAA', ciphertext: 'AAAA' } };
  check('garbage reads as no choice', (await B.getActivityLogRetention()).chosen === null);
  localB.atlasActivityLogRetention = { [bOwner]: { limit: 77 } };
  check('a value that is not one of the choices reads as no choice', (await B.getActivityLogRetention()).chosen === null);
  localB.atlasActivityLogRetention = { [bOwner]: { limit: 250 } };
  check('an old plain value of a valid choice is honoured', (await B.getActivityLogRetention()).chosen === 250);

  console.log('--- nothing but the log changes ---');
  const localC = {}, sessionC = {};
  const C = load(localC, sessionC);
  await C.createIdentity('isolation-password');
  await C.recordStatusMessage('a status message');
  await C.setActivityLogRetention(500);
  await add(C, 1, 120);
  const snap = () => JSON.stringify(Object.fromEntries(Object.entries(localC).filter(([k]) => k !== 'atlasActivityLog' && k !== 'atlasActivityLogRetention')));
  const before = snap();
  await C.setActivityLogRetention(50);
  await C.setActivityLogRetention(250);
  await C.setActivityLogRetention(100);
  check('lowering and raising the limit leaves every other stored record exactly as it was (wallet, holdings, ledger, status history)', snap() === before);
  check('the status history is not shortened or lengthened by it', (await C.getStatusHistory()).length === 1);
  for (let i = 1; i <= 30; i++) await C.recordStatusMessage('status ' + i);
  check('and it keeps its own limit of 20 whatever the Activity Log keeps', (await C.getStatusHistory()).length === 20 && C.STATUS_HISTORY_LIMIT === 20);

  console.log('--- locked ---');
  const locked = load(localC, {});
  r = await locked.getActivityLogRetention();
  check('with no unlocked identity there is nothing to read', r.count === 0 && r.chosen === null);
  let refused = false;
  try { await locked.setActivityLogRetention(50); } catch (e) { refused = true; }
  check('and no choice can be saved', refused && (await load(localC, sessionC).getActivityLogRetention()).chosen === 100);

  console.log('\nwallet-activity-log-retention: ' + passes + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log('FATAL ' + (e && e.stack || e)); process.exit(1); });
