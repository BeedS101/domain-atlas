// The pure rules of opening a ledger account (extension/ledger-open.js): what may be asked of
// which host, the exact messages that are signed, and how answers are read. No browser, no
// network. Run: node test/manual-ledger-open-core.js
'use strict';
const fs = require('fs');
const path = require('path');
const O = require('../extension/ledger-open.js');
const Core = require('../extension/ledger-core.js');
const Labs29 = require('../extension/ledger-labs29.js');
const E = require('./call-e2e-lib');
const { check } = E;

const OWNER = 'B' + 'A'.repeat(86);
const ID = 'urn:atlas:ledger-account:' + 'ab'.repeat(32);
const T = O.targetFor('evtec.co.za', 'GOPH');
const NONCE = 'a'.repeat(32);
const WHEN = '2026-10-18T10:00:00Z';

console.log('--- what may be asked of whom ---');
check('GOPH on the Evtec test host is the one listed target', O.targets().length === 1 && O.targets()[0].domain === 'evtec.co.za' && O.targets()[0].coin === 'GOPH', O.targets());
check('its network is the Labs 29 network for that host', T.network === 'chainblock-labs29-evtec.co.za');
check('every listed host is one the Labs 29 adapter also serves', O.targets().every((t) => Labs29.HOSTS.includes(t.domain)));
check('another coin on the same host is not a target', O.targetFor('evtec.co.za', 'MWC') === null);
check('another host is not a target', O.targetFor('example.com', 'GOPH') === null && O.targetFor('evtec.co.za.example.com', 'GOPH') === null);
check('a lookalike with different case is not a target', O.targetFor('EVTEC.co.za', 'GOPH') === null && O.targetFor('evtec.co.za', 'goph') === null);
check('the listing cannot be changed from outside', (() => { O.targets()[0].domain = 'x'; return O.targets()[0].domain === 'evtec.co.za'; })());

console.log('--- the addresses ---');
const u = O.urlsFor('evtec.co.za');
check('open is the Labs 30 address', u.open === 'https://evtec.co.za/chain-labs/account30.php?action=open', u);
check('accounts is the Labs 31 address', u.accounts === 'https://evtec.co.za/chain-labs/accounts31.php?action=accounts', u);
check('issue is the issuer address', u.issue === 'https://evtec.co.za/atlas/ledger/account-credential', u);
check('all three are https and on the one host', Object.values(u).every((x) => new URL(x).protocol === 'https:' && new URL(x).host === 'evtec.co.za'));

console.log('--- the messages that are signed ---');
const open = O.openPayload(T, NONCE, WHEN);
check('the open message has exactly the fields Labs 30 requires', JSON.stringify(Object.keys(open).sort()) === JSON.stringify(['audience', 'coin', 'issuedAt', 'network', 'nonce', 'type', 'v']), open);
check('...for the exact open address', open.type === 'atlas.ledger.account.open' && open.v === 1 && open.audience === u.open && open.network === T.network && open.coin === 'GOPH');
const listing = O.listingPayload(T, NONCE, WHEN);
check('the listing message has exactly the fields Labs 31 requires', JSON.stringify(Object.keys(listing).sort()) === JSON.stringify(['audience', 'issuedAt', 'network', 'nonce', 'type', 'v']), listing);
check('...for the exact accounts address', listing.type === 'atlas.ledger.accounts' && listing.audience === u.accounts && listing.network === T.network);
const issue = O.issuePayload(T, 'b'.repeat(32), WHEN, NONCE);
check('the issue message has exactly the fields the issuer requires', JSON.stringify(Object.keys(issue).sort()) === JSON.stringify(['audience', 'coin', 'existenceNonce', 'issuedAt', 'network', 'nonce', 'type', 'v']), issue);
check('...for the exact issuer address, naming the listing it travels with', issue.type === 'atlas.ledger.account.issue' && issue.audience === u.issue && issue.existenceNonce === listing.nonce);
check('no message carries an amount, a balance or a destination account', [open, listing, issue].every((p) => !/amount|balance|quantity|to\b|recipient/i.test(Object.keys(p).join(' '))));
check('every type is an atlas.ledger type, so the generic signer refuses them', Object.values(O.TYPES).every((t) => t.startsWith('atlas.ledger.')));
check('times are written without milliseconds', O.isoSeconds(1790000000123) === '2026-09-21T14:13:20Z', O.isoSeconds(1790000000123));
check('a nonce is 32 to 64 lowercase hex characters', O.isNonce('a'.repeat(32)) && O.isNonce('0'.repeat(64)) && !O.isNonce('A'.repeat(32)) && !O.isNonce('a'.repeat(31)) && !O.isNonce('a'.repeat(65)) && !O.isNonce(12));
check('only a password-style (raw P-256) proof is offered', JSON.stringify(O.PROOF_FORMATS) === '["raw-ecdsa-p256"]');

console.log('--- what the person is told ---');
const eo = O.explainOpen(T), ei = O.explainIssue(T);
check('the opening text names the destination and its status', eo.includes('evtec.co.za') && eo.includes(u.open) && /experimental/i.test(eo), eo);
check('...says what is and is not done', /empty/.test(eo) && /Nothing is minted, deposited or spent/.test(eo) && /no credential is requested yet/.test(eo));
check('the issuance text names both addresses it involves and its status', ei.includes(u.issue) && ei.includes(u.accounts) && /experimental/i.test(ei) && /switched off/.test(ei), ei);
check('...says the signature is checked and that no balance is involved', /publishes and its revocation list/.test(ei) && /holds no balance/.test(ei));

console.log('--- reading the open answer ---');
const expect = { network: T.network, coin: 'GOPH', owner: OWNER };
const good = (over) => Object.assign({ ok: true, code: 'account-opened', accountId: ID, network: T.network, coin: 'GOPH', coinId: 'c-goph', ownerKey: OWNER, created: true, amount: '0', decimals: 6 }, over || {});
let r = O.readOpened(201, good(), expect);
check('a new account is read as created', r.ok && r.created === true && r.accountId === ID, r);
r = O.readOpened(200, good({ code: 'account-exists', created: false, amount: '0' }), expect);
check('an existing account is read as found', r.ok && r.created === false, r);
check('the answer carries no quantity out of the reader', !('amount' in O.readOpened(200, good({ code: 'account-exists', amount: '123456' }), expect)));
check('the wrong status for the code is refused', !O.readOpened(200, good(), expect).ok && !O.readOpened(201, good({ code: 'account-exists' }), expect).ok);
check('a different network, coin or owner is refused', ['network', 'coin', 'ownerKey'].every((f) => { const x = O.readOpened(201, good({ [f]: 'x' }), expect); return !x.ok && x.code === 'bad-response'; }));
check('an account ID that is not 64 hex digits is refused', !O.readOpened(201, good({ accountId: 'urn:atlas:ledger-account:short' }), expect).ok && !O.readOpened(201, good({ accountId: 5 }), expect).ok);
check('ok:false, no body and non-JSON are not successes', !O.readOpened(200, null, expect).ok && !O.readOpened(200, { ok: false }, expect).ok);
const codeOf = (status, code) => O.readOpened(status, { ok: false, code }, expect).code;
check('ledger codes map to the wallet\'s own problems', codeOf(401, 'stale-request') === 'clock' && codeOf(401, 'unsupported-proof') === 'proof-unsupported' && codeOf(401, 'bad-signature') === 'unauthorized' && codeOf(409, 'replayed-request') === 'busy' && codeOf(404, 'unknown-coin') === 'unknown-coin' && codeOf(400, 'unknown-network') === 'not-supported' && codeOf(503, 'unavailable') === 'network');
check('an unknown code is a bad answer, not a guess', codeOf(400, 'surprise') === 'bad-response' && codeOf(418, undefined) === 'bad-response');
check('a rate limit or server error without a code is still understood', O.readOpened(429, null, expect).code === 'rate-limited' && O.readOpened(502, null, expect).code === 'network');

console.log('--- reading the issuance answer ---');
const cred = { credential: 'domain-atlas-ledger-account/1.0', id: ID, issuer: { domain: 'evtec.co.za', publicKey: 'k'.repeat(87) }, ledger: { network: T.network, coin: 'GOPH' }, owner: { publicKey: OWNER }, issuedAt: WHEN, signature: 's'.repeat(86) };
r = O.readIssued(200, { ok: true, code: 'credential-issued', credential: cred });
check('an issued credential is passed on unchecked for the wallet to verify', r.ok && r.credential === cred);
check('a credential in any other answer is not accepted', !O.readIssued(201, { ok: true, code: 'credential-issued', credential: cred }).ok && !O.readIssued(200, { ok: true, code: 'other', credential: cred }).ok && !O.readIssued(200, { ok: true, code: 'credential-issued' }).ok && !O.readIssued(200, { ok: true, code: 'credential-issued', credential: [cred] }).ok);
const ic = (status, code) => O.readIssued(status, { ok: false, code }).code;
check('the switched-off issuer is its own problem', ic(404, 'disabled') === 'issuance-off');
check('a missing ledger account is its own problem', ic(404, 'account-not-found') === 'account-missing');
check('a revoked account is its own problem', ic(409, 'account-revoked') === 'account-revoked');
check('issuer and ledger trouble reads as the issuer being unavailable', ['misconfigured', 'issuer-key-unavailable', 'ledger-unavailable', 'ledger-mismatch', 'ledger-refused'].every((c) => ic(502, c) === 'issuer-unavailable'));
check('a refused ownership or existence proof is "not accepted for this identity"', ic(401, 'existence-proof-rejected') === 'unauthorized' && ic(401, 'bad-signature') === 'unauthorized');
check('the other issuer codes map as for the open step', ic(401, 'stale-request') === 'clock' && ic(409, 'replayed-request') === 'busy' && ic(429, 'rate-limited') === 'rate-limited' && ic(401, 'unsupported-proof') === 'proof-unsupported');

console.log('--- is the credential the one asked for ---');
const ask = { id: ID, domain: 'evtec.co.za', network: T.network, coin: 'GOPH', owner: OWNER };
check('the matching credential is accepted', O.credentialMatches(cred, ask));
const swap = (f) => { const c = JSON.parse(JSON.stringify(cred)); f(c); return c; };
check('another id, domain, network, coin or owner is not', !O.credentialMatches(swap((c) => { c.id = 'urn:atlas:ledger-account:' + 'cd'.repeat(32); }), ask) && !O.credentialMatches(swap((c) => { c.issuer.domain = 'domain-atlas.co.za'; }), ask) && !O.credentialMatches(swap((c) => { c.ledger.network = 'x'; }), ask) && !O.credentialMatches(swap((c) => { c.ledger.coin = 'MWC'; }), ask) && !O.credentialMatches(swap((c) => { c.owner.publicKey = 'C' + 'A'.repeat(86); }), ask) && !O.credentialMatches(null, ask));

console.log('--- the problem texts ---');
const wanted = ['experimental-off', 'unsupported-target', 'already-held', 'issuance-off', 'issuer-unavailable', 'account-missing', 'account-revoked', 'proof-unsupported', 'clock', 'unauthorized', 'busy', 'bad-response', 'network', 'timeout', 'not-supported', 'unknown-coin', 'rate-limited', 'credential-invalid', 'no-consent', 'locked', 'wrong-identity', 'cancelled'];
check('every problem the workflow can report has its own text', wanted.every((c) => Core.PROBLEMS[c] && Core.problemText(c) === Core.PROBLEMS[c]), wanted.filter((c) => !Core.PROBLEMS[c]));
check('"switched off" and "unavailable" both say the account stays open', /stays open/.test(Core.problemText('issuance-off')) && /stays open/.test(Core.problemText('issuer-unavailable')));
check('the experimental-off text says it is off by default', /off by default/.test(Core.problemText('experimental-off')));

console.log('--- the module cannot do anything by itself ---');
const src = fs.readFileSync(path.join(__dirname, '..', 'extension', 'ledger-open.js'), 'utf8');
check('it has no network, storage or signing calls', !/\bfetch\(|XMLHttpRequest|chrome\.|localStorage|crypto\.subtle|\.sign\(/.test(src.replace(/\/\/.*$/gm, '')));
process.exit(E.finish('manual-ledger-open-core'));
