// Checks for extension/ledger-core.js: the ledger-account credential rules, balance handling and
// the capability levels the Ledger tab shows. Pure module, no browser and no network.
// Run: node test/manual-ledger-core.js
'use strict';
const path = require('path');
const { webcrypto } = require('crypto');
const core = require(path.resolve(__dirname, '..', 'extension', 'ledger-core.js'));

let passes = 0, failures = 0;
const failed = [];
function check(name, ok, detail) {
  if (ok) { passes++; console.log('PASS ' + name); }
  else { failures++; failed.push(name); console.log('FAIL ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : '')); }
}

const b64 = (bytes) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const KEY = b64(webcrypto.getRandomValues(new Uint8Array(65)));
const KEY2 = b64(webcrypto.getRandomValues(new Uint8Array(65)));
const SIG = b64(webcrypto.getRandomValues(new Uint8Array(64)));

function good() {
  return {
    credential: 'domain-atlas-ledger-account/1.0',
    id: 'urn:atlas:ledger-account:4f1c2d3e-aaaa-bbbb-cccc-123456789abc',
    issuer: { domain: 'ledger.example.com', publicKey: KEY },
    ledger: { network: 'test-network-1', coin: 'GOPH' },
    owner: { publicKey: KEY2 },
    issuedAt: '2026-10-01T00:00:00Z',
    signature: SIG
  };
}
const rejects = (mutate, reason) => {
  const c = good(); mutate(c);
  const r = core.validateAccountCredential(c);
  return !r.ok && (reason === undefined || r.reason === reason) ? true : r;
};

(async () => {
  console.log('--- the credential shape ---');
  check('a well-formed credential is accepted', core.validateAccountCredential(good()).ok === true);
  check('non-objects are refused', ['x', 1, null, [], undefined].every((v) => core.validateAccountCredential(v).ok === false));
  check('the wrong credential type is refused', rejects((c) => { c.credential = 'domain-atlas-asset/1.0'; }, 'wrong-type') === true);
  for (const k of ['quantity', 'balance', 'amount', 'available', 'total', 'holdings', 'funds', 'value', 'supply', 'decimals']) {
    check('a top-level "' + k + '" field is refused as a balance', rejects((c) => { c[k] = 5; }, 'carries-balance') === true);
  }
  check('a balance hidden inside ledger is refused', rejects((c) => { c.ledger.balance = '10'; }, 'carries-balance') === true);
  check('a balance hidden inside owner is refused', rejects((c) => { c.owner.quantity = 1; }, 'carries-balance') === true);
  check('a balance in a nested object is refused', rejects((c) => { c.ledger.extra = { deep: { Amount: 1 } }; }, 'carries-balance') === true);
  check('a balance-like name is refused whatever its case', rejects((c) => { c.BALANCE = 1; }, 'carries-balance') === true);
  check('an unknown top-level field is refused', rejects((c) => { c.note = 'hi'; }, 'unknown-field') === true);
  check('an unknown issuer field is refused', rejects((c) => { c.issuer.name = 'x'; }, 'bad-issuer') === true);
  check('an unknown ledger field is refused', rejects((c) => { c.ledger.label = 'Gold'; }, 'bad-ledger') === true);
  check('a bad id is refused', rejects((c) => { c.id = 'urn:atlas:asset:123'; }, 'bad-id') === true);
  check('an issuer domain with a scheme is refused', rejects((c) => { c.issuer.domain = 'https://ledger.example.com'; }, 'bad-issuer-domain') === true);
  check('an issuer domain with a path is refused', rejects((c) => { c.issuer.domain = 'ledger.example.com/x'; }, 'bad-issuer-domain') === true);
  check('an upper-case issuer domain is refused', rejects((c) => { c.issuer.domain = 'Ledger.Example.com'; }, 'bad-issuer-domain') === true);
  check('a host with an out-of-range port is refused', rejects((c) => { c.issuer.domain = 'ledger.example.com:99999'; }, 'bad-issuer-domain') === true);
  check('localhost with a port is a valid issuer host', (() => { const c = good(); c.issuer.domain = 'localhost:8002'; return core.validateAccountCredential(c).ok; })());
  check('a bare single-label host other than localhost is refused', rejects((c) => { c.issuer.domain = 'intranet'; }, 'bad-issuer-domain') === true);
  check('a network id with spaces is refused', rejects((c) => { c.ledger.network = 'my network'; }, 'bad-network') === true);
  check('a coin id that is empty is refused', rejects((c) => { c.ledger.coin = ''; }, 'bad-coin') === true);
  check('a coin id that is too long is refused', rejects((c) => { c.ledger.coin = 'A'.repeat(65); }, 'bad-coin') === true);
  check('a short owner key is refused', rejects((c) => { c.owner.publicKey = 'abc'; }, 'bad-owner-key') === true);
  check('a missing issue time is refused', rejects((c) => { delete c.issuedAt; }, 'bad-issued-at') === true);
  check('a non-ISO issue time is refused', rejects((c) => { c.issuedAt = 'yesterday'; }, 'bad-issued-at') === true);
  check('a short signature is refused', rejects((c) => { c.signature = 'abc'; }, 'bad-signature-shape') === true);

  console.log('--- what the issuer signs ---');
  const sp = core.signedPayloadOf(good());
  check('the signed payload names id, ledger, owner and issue time only', JSON.stringify(Object.keys(sp).sort()) === JSON.stringify(['id', 'issuedAt', 'ledger', 'owner']));
  check('the signed payload has no figure in it', !JSON.stringify(sp).match(/balance|quantity|amount/i));
  check('the signature itself is not part of what is signed', !('signature' in sp));

  console.log('--- balances ---');
  check('a valid balance normalises', JSON.stringify(core.normalizeBalance({ amount: '1250', decimals: 2, asOf: '2026-10-01T10:00:00Z' })) === JSON.stringify({ amount: '1250', decimals: 2, asOf: '2026-10-01T10:00:00Z' }));
  check('leading zeros are dropped', core.normalizeBalance({ amount: '0007', decimals: 0, asOf: '2026-10-01T10:00:00Z' }).amount === '7');
  check('zero is kept as zero', core.normalizeBalance({ amount: '000', decimals: 0, asOf: '2026-10-01T10:00:00Z' }).amount === '0');
  for (const [label, raw] of [
    ['a number amount', { amount: 5, decimals: 0, asOf: '2026-10-01T10:00:00Z' }],
    ['a negative amount', { amount: '-5', decimals: 0, asOf: '2026-10-01T10:00:00Z' }],
    ['a fractional amount string', { amount: '1.5', decimals: 0, asOf: '2026-10-01T10:00:00Z' }],
    ['an exponent amount', { amount: '1e9', decimals: 0, asOf: '2026-10-01T10:00:00Z' }],
    ['an overlong amount', { amount: '9'.repeat(41), decimals: 0, asOf: '2026-10-01T10:00:00Z' }],
    ['a missing decimals', { amount: '5', asOf: '2026-10-01T10:00:00Z' }],
    ['too many decimals', { amount: '5', decimals: 19, asOf: '2026-10-01T10:00:00Z' }],
    ['a fractional decimals', { amount: '5', decimals: 1.5, asOf: '2026-10-01T10:00:00Z' }],
    ['no time', { amount: '5', decimals: 0 }],
    ['a bad time', { amount: '5', decimals: 0, asOf: 'soon' }],
    ['null', null], ['a string', 'ten']
  ]) check('a balance with ' + label + ' is refused', core.normalizeBalance(raw) === null);
  check('a 40-digit amount stays exact', core.normalizeBalance({ amount: '1'.repeat(40), decimals: 0, asOf: '2026-10-01T10:00:00Z' }).amount === '1'.repeat(40));
  check('formatAmount places the decimal point', core.formatAmount('12345', 2) === '123.45');
  check('formatAmount pads small amounts', core.formatAmount('5', 3) === '0.005');
  check('formatAmount with no decimals is the digits', core.formatAmount('42', 0) === '42');
  check('formatAmount keeps trailing zeros', core.formatAmount('1000', 2) === '10.00');
  check('formatAmount of zero with decimals', core.formatAmount('0', 2) === '0.00');
  const now = Date.parse('2026-10-01T12:00:00Z');
  check('a balance from a minute ago is current', core.isStale('2026-10-01T11:59:00Z', now) === false);
  check('a balance from an hour ago is out of date', core.isStale('2026-10-01T11:00:00Z', now) === true);
  check('an unreadable time counts as out of date', core.isStale('nonsense', now) === true);
  check('shortKey shortens a long key and leaves a short one', core.shortKey(KEY).length < KEY.length && core.shortKey('abc') === 'abc');

  console.log('--- capability levels ---');
  const base = { ownerIsActive: true, identityLocked: false, adapterSupports: true, consent: false, backgroundSync: false, inFlight: false, canSignSilently: true, endpointChanged: false, domain: 'ledger.example.com' };
  const lv = (over) => core.indicatorsFor(Object.assign({}, base, over));
  check('allowed nowhere yet: lookup is available, background check is unavailable until allowed', lv({}).lookup.level === 'available' && lv({}).background.level === 'unavailable');
  check('after consent: lookup enabled, background check available but off', lv({ consent: true }).lookup.level === 'enabled' && lv({ consent: true }).background.level === 'available');
  check('with the background switch on: background check enabled', lv({ consent: true, backgroundSync: true }).background.level === 'enabled');
  check('a request in flight: lookup connecting', lv({ consent: true, inFlight: true }).lookup.level === 'connecting');
  check('a background request in flight: background check connecting', lv({ consent: true, backgroundSync: true, inFlight: true, inFlightReason: 'background' }).background.level === 'connecting');
  check('a manual request in flight does not claim a background request', lv({ consent: true, backgroundSync: true, inFlight: true, inFlightReason: 'manual' }).background.level === 'enabled');
  check('no adapter: both unavailable, and the reason says so', lv({ adapterSupports: false }).lookup.level === 'unavailable' && lv({ adapterSupports: false }).background.level === 'unavailable' && /no way to reach/.test(lv({ adapterSupports: false }).lookup.detail));
  check('another identity owns it: both unavailable', lv({ ownerIsActive: false }).lookup.level === 'unavailable' && lv({ ownerIsActive: false }).background.level === 'unavailable');
  check('locked: both unavailable', lv({ identityLocked: true }).lookup.level === 'unavailable');
  check('an identity that must confirm each request: background check unavailable even when allowed', lv({ consent: true, canSignSilently: false }).background.level === 'unavailable' && lv({ consent: true, canSignSilently: false }).lookup.level === 'enabled');
  check('a changed ledger address: lookup back to available, background unavailable', lv({ consent: true, endpointChanged: true }).lookup.level === 'available' && lv({ consent: true, endpointChanged: true }).background.level === 'unavailable');
  check('every level has its own glyph and word', (() => {
    const seen = new Set();
    [lv({ adapterSupports: false }).lookup, lv({}).lookup, lv({ consent: true }).lookup, lv({ consent: true, inFlight: true }).lookup].forEach((i) => seen.add(i.glyph + '|' + i.word));
    return seen.size === 4;
  })());
  check('every indicator carries words, not only a glyph', [lv({}).lookup, lv({}).background].every((i) => i.word.length > 3 && i.detail.length > 10));

  console.log('--- problems ---');
  check('every problem code has words', Object.keys(core.PROBLEMS).every((k) => core.problemText(k).length > 5));
  check('an unknown code falls back to a generic line', core.problemText('nope') === core.PROBLEMS.unknown);

  console.log('\n' + passes + ' passed, ' + failures + ' failed');
  if (failures) { console.log('Failed: ' + failed.join(' | ')); process.exit(1); }
})();
