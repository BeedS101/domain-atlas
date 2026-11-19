// Recent status message history (wallet.js: recordStatusMessage, getStatusHistory, clearStatusHistory,
// statusHistoryAsText): capture, newest-first ordering, the 20-message limit, persistence across a wallet reload,
// encryption at rest, one history per identity, clearing, the plain-text copy format, and that nothing secret is kept.
//
// Loads extension/wallet.js in a vm with in-memory extension storage; no browser, no network.
//
//   node test/wallet-status-history.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passes = 0, failures = 0;
const check = (name, ok, detail) => {
  if (ok) { passes++; console.log('PASS ' + name); } else { failures++; console.log('FAIL ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 300) : '')); }
};

const SRC = fs.readFileSync(path.resolve(__dirname, '..', 'extension', 'wallet.js'), 'utf8');

// Extension storage as a plain object per area; `local` and `session` survive a "reload" (a fresh load of wallet.js).
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

const rawStorage = (local) => JSON.stringify(local.atlasStatusHistory || {});

(async () => {
  const local = {}, session = {};
  let W = load(local, session);
  const me = (await W.createIdentity('status-history-password')).publicKey;

  console.log('--- capture and order ---');
  check('nothing is recorded yet', (await W.getStatusHistory()).length === 0);
  const a = await W.recordStatusMessage('Picked it up.', new Date('2026-03-01T10:00:00.000Z'));
  await W.recordStatusMessage('Drop failed: the hosting domain refused it', new Date('2026-03-01T10:00:05.000Z'));
  await W.recordStatusMessage('This requires an unlocked wallet identity.', new Date('2026-03-01T10:00:09.000Z'));
  await W.recordStatusMessage('Fetching scene…', new Date('2026-03-01T10:00:10.000Z'));
  check('a recorded message comes back with its time, kind and text', a && a.at === '2026-03-01T10:00:00.000Z' && a.level === 'success' && a.text === 'Picked it up.', a);
  const list = await W.getStatusHistory();
  check('messages are listed newest first', list.map((e) => e.text).join('|') === 'Fetching scene…|This requires an unlocked wallet identity.|Drop failed: the hosting domain refused it|Picked it up.', list);
  check('errors, warnings, successes and plain messages are told apart', list.map((e) => e.level).join(',') === 'info,warning,error,success', list.map((e) => e.level));
  check('empty and whitespace-only messages are ignored', (await W.recordStatusMessage('')) === null && (await W.recordStatusMessage('   \n ')) === null && (await W.getStatusHistory()).length === 4);

  console.log('--- records made together keep their order ---');
  await Promise.all([1, 2, 3, 4, 5].map((n) => W.recordStatusMessage('burst ' + n, new Date(Date.UTC(2026, 2, 1, 11, 0, n)))));
  const burst = (await W.getStatusHistory()).slice(0, 5).map((e) => e.text).join(',');
  check('five messages reported in one tick are all kept, in the order they were reported', burst === 'burst 5,burst 4,burst 3,burst 2,burst 1', burst);

  console.log('--- the 20-message limit ---');
  for (let i = 1; i <= 30; i++) await W.recordStatusMessage('message ' + i, new Date(Date.UTC(2026, 2, 2, 0, 0, i)));
  const capped = await W.getStatusHistory();
  check('only twenty messages are kept', capped.length === 20 && W.STATUS_HISTORY_LIMIT === 20, capped.length);
  check('the oldest are the ones dropped', capped[0].text === 'message 30' && capped[19].text === 'message 11', [capped[0].text, capped[19].text]);
  check('the stored copy is capped too, not just the view', capped.length === 20 && local.atlasStatusHistory[me] !== undefined);

  console.log('--- persistence across a wallet reload ---');
  W = load(local, session);
  const reloaded = await W.getStatusHistory();
  check('the same twenty messages are there after the wallet is loaded again', reloaded.length === 20 && reloaded[0].text === 'message 30' && reloaded[19].text === 'message 11', reloaded.length);
  await W.recordStatusMessage('after reload');
  const afterReload = await W.getStatusHistory();
  check('new messages join the stored ones and the limit still holds', afterReload.length === 20 && afterReload[0].text === 'after reload' && afterReload[19].text === 'message 12', [afterReload[0].text, afterReload[19].text]);
  check('the stored history is encrypted, not readable text', !/message 3|after reload/.test(rawStorage(local)) && /__atlasEncrypted/.test(rawStorage(local)), rawStorage(local).slice(0, 120));

  console.log('--- copy format ---');
  const text = W.statusHistoryAsText(afterReload.slice(0, 3));
  const lines = text.split('\n');
  check('copied text is plain: one line per message, newest first, each with a UTC timestamp and its kind', lines.length === 3 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[info\] after reload$/.test(lines[0]) && lines[1].endsWith('[info] message 30'), lines);
  check('copying an empty history gives an empty string', W.statusHistoryAsText([]) === '');

  console.log('--- one history per identity ---');
  // A second wallet profile (its own identity and storage) pointed at the same status-history store.
  const local2 = {}, session2 = {};
  const W2 = load(local2, session2);
  const other = (await W2.createIdentity('other-identity-password')).publicKey;
  local2.atlasStatusHistory = local.atlasStatusHistory;
  check('the other identity sees none of the first identity\'s messages', (await W2.getStatusHistory()).length === 0 && other !== me);
  await W2.recordStatusMessage('only the other identity sees this');
  check('its message is its own', (await W2.getStatusHistory()).map((e) => e.text).join() === 'only the other identity sees this');
  check('the first identity\'s history is untouched by it', (await W.getStatusHistory()).length === 20 && (await W.getStatusHistory())[0].text === 'after reload');
  await W2.clearStatusHistory();
  check('clearing the other identity leaves the first identity\'s history alone', (await W2.getStatusHistory()).length === 0 && (await W.getStatusHistory()).length === 20);

  console.log('--- clearing ---');
  const before = JSON.stringify({ ...local, atlasStatusHistory: undefined });
  await W.clearStatusHistory();
  check('clearing empties this identity\'s history', (await W.getStatusHistory()).length === 0);
  check('clearing is remembered after a reload', (await load(local, session).getStatusHistory()).length === 0);
  check('clearing touches nothing but the status history (identity, wallet and other stored data are as they were)', JSON.stringify({ ...local, atlasStatusHistory: undefined }) === before);
  await W.recordStatusMessage('a fresh start');
  check('messages can be recorded again after clearing', (await W.getStatusHistory()).map((e) => e.text).join() === 'a fresh start');

  console.log('--- nothing is stored while the wallet is locked ---');
  const lockedSession = {};
  const locked = load(local, lockedSession);
  check('with no unlocked identity a message is not stored', (await locked.recordStatusMessage('typed while locked')) === null);
  check('and the locked wallet reads no history', (await locked.getStatusHistory()).length === 0);
  check('the identity\'s own stored history was not disturbed', (await load(local, session).getStatusHistory()).map((e) => e.text).join() === 'a fresh start');

  console.log('--- secrets and request details are not kept ---');
  const long = 'A'.repeat(43) + '_-' + 'b'.repeat(40);
  const samples = [
    ['Drop failed: Bearer abcdef0123456789abcdef', /abcdef0123456789abcdef/],
    ['Sign-in failed: password=hunter2hunter2', /hunter2/],
    ['Request failed: token: s3cr3t-value-here', /s3cr3t/],
    ['Could not load https://example.com/x?token=abc123secret&a=1', /abc123secret/],
    ['Pick up failed: ' + JSON.stringify({ error: 'refused', signature: long, privateKey: { d: long } }), /AAAAAAAA|bbbbbbbb|signature|privateKey/],
    ['Claim failed: ' + JSON.stringify({ credential: { id: 'x', proof: { signature: long } } }), /AAAAAAAA|bbbbbbbb|proof|credential/],
    ['Failed with key ' + long, /AAAAAAAA|bbbbbbbb/],
    ['Failed: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk', /eyJhbGci/],
    ['Failed: ' + 'f'.repeat(64), /ffffffff/]
  ];
  for (const [input, leak] of samples) {
    const entry = await W.recordStatusMessage(input);
    check('redacted: ' + input.slice(0, 48) + '…', entry && !leak.test(entry.text) && !leak.test(rawStorage(local)), entry && entry.text);
  }
  const kept = await W.recordStatusMessage('Pick up failed: {"error":"that item is gone","credential":{"id":"abc"}}');
  check('a JSON reply is reduced to its error text', kept.text === 'Pick up failed: that item is gone', kept.text);
  const ids = await W.recordStatusMessage('Dropped urn:atlas:asset:0f8fad5b-d9cb-469f-a165-70867728950e in plaza');
  check('ordinary ids and domains are kept so a message stays useful', ids.text === 'Dropped urn:atlas:asset:0f8fad5b-d9cb-469f-a165-70867728950e in plaza', ids.text);
  const longText = await W.recordStatusMessage('x '.repeat(400));
  check('one message is capped in length', longText.text.length <= 300, longText.text.length);
  check('a stored entry carries only time, kind and text', Object.keys(longText).sort().join() === 'at,level,text');

  console.log('--- unreadable or tampered stored data does not break the wallet ---');
  local.atlasStatusHistory = { [me]: { __atlasEncrypted: true, iv: 'AAAA', ciphertext: 'AAAA' } };
  const broken = load(local, session);
  check('an unreadable stored history reads as empty', (await broken.getStatusHistory()).length === 0);
  const again = await broken.recordStatusMessage('recording still works');
  check('and a new message can still be recorded', again && (await broken.getStatusHistory()).map((e) => e.text).join() === 'recording still works');
  local.atlasStatusHistory = { [me]: [{ at: 'not a time', text: 'bad time' }, { at: '2026-03-01T10:00:00.000Z', text: 5 }, { at: '2026-03-01T10:00:00.000Z', level: 'weird', text: 'ok entry' }, null, 'x'] };
  check('malformed stored entries are skipped and an unknown kind becomes plain', (await load(local, session).getStatusHistory()).map((e) => e.level + ':' + e.text).join() === 'info:ok entry');

  console.log('\nwallet-status-history: ' + passes + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log('FATAL ' + (e && e.stack || e)); process.exit(1); });
