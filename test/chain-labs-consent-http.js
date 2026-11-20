// Partner consent before a multi authority coin opens, against three live PHP servers running the real endpoints (a.example the authority,
// b.example and c.example partners). The operators are real signed requests (chain-labs/lib/operator.php):
//   - the authority's open is refused with needs-consent until every partner operator accepted, and names who has not
//   - a partner operator reviews the proposal, accepts or declines, decline then accept, and cannot withdraw after the genesis was signed
//   - acceptance names the coin and the genesis digest; nothing is accepted by a request that names another
//   - accepting and declining take a signed request only, a token is refused from the first day
//   - a request that was answered needs-consent is never carried out again by itself: a new open is a new signed request
//   - a scoped operator key is given the consent actions without being removed and added again
//   - a consent record that cannot be read or written refuses, and nothing is signed
//
//   node test/chain-labs-consent-http.js
'use strict';
const path = require('path');
const { execFileSync } = require('child_process');
const S = require('./support/chain-labs-servers');
const { OP, A, B, C, nodes, start, stop, get, op, signedOp, legacyOp, createCoin, target, cleanup } = S;

let failures = 0, total = 0;
const line = (ok, text, detail) => { total++; if (!ok) failures++; console.log((ok ? 'PASS ' : 'FAIL ') + text + (!ok && detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 500) : '')); };
const a = nodes[A], b = nodes[B], c = nodes[C];
const cli = (n, ...args) => {
  try { return { code: 0, out: execFileSync('php', [path.join(__dirname, '..', 'chain-labs', 'lib', 'operator-cli.php'), ...args, '--private=' + n.priv], { encoding: 'utf8' }) }; } catch (e) { return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') }; }
};
const sqlExec = (n, statement) => execFileSync('php', ['-r', '$d=new PDO("sqlite:" . $argv[1]);$d->exec($argv[2]);', path.join(n.priv, 'chain34.sqlite'), statement]);
const list = (n, over = {}) => signedOp(n, 'spend34/consent-list', {}, { repeat: true, ...over });
const accept = (n, coinId, digest, over = {}) => signedOp(n, 'spend34/consent-accept', { coinId, digest }, { repeat: true, ...over });
const decline = (n, coinId, digest, reason, over = {}) => signedOp(n, 'spend34/consent-decline', reason === undefined ? { coinId, digest } : { coinId, digest, reason }, { repeat: true, ...over });
const open = (n, coinId, opts = {}) => signedOp(n, 'spend34/open', { coinId }, opts);
const digestOf = async (coinId) => (await get(a, 'action=coin&coin=' + coinId)).json.genesisDigest;
const stateOn = async (n, coinId) => { const r = await get(n, 'action=coin&coin=' + coinId); return r.json && r.json.ok ? r.json.state : 'none'; };

(async () => {
  try {
    for (const n of [a, b, c]) await start(n);

    console.log('== the authority cannot open until the partners accept');
    const coin = (await createCoin(a, 'CNS', { mode: 'multi', partners: [B, C], threshold: 2 })).json;
    line(coin.ok === true, 'a coin of three domains is registered on the authority', coin);
    const first = OP.signRequest(a.operator, { domain: A, action: 'spend34/open', request: { coinId: coin.id } });
    const [file, query] = OP.routeOf('spend34/open');
    const o1 = await OP.postOnce(target(a), file, query, first);
    line(o1.status === 409 && o1.json.code === 'needs-consent' && o1.json.ok === false, 'open answers 409 needs-consent', o1);
    const named = (o1.json.partners || []).map((p) => p.domain + ':' + p.state).sort();
    line(named.join(',') === B + ':awaiting,' + C + ':awaiting', 'and names both partners as awaiting', o1.json.partners);
    line((await stateOn(a, coin.id)) === 'pending', 'the coin stays pending on the authority');
    const digest = await digestOf(coin.id);
    line(/^[a-f0-9]{64}$/.test(digest), 'whose public view shows the genesis digest for the partners to compare', digest);

    console.log('== a partner operator reviews the proposal');
    const lb = await list(b);
    const prop = lb.json && lb.json.proposals && lb.json.proposals[0];
    line(lb.status === 200 && lb.json.proposals.length === 1 && prop.coinId === coin.id && prop.status === 'awaiting' && prop.genesisDigest === digest, 'b.example lists one proposal awaiting, with the digest the authority shows', lb.json);
    const terms = (prop && prop.terms) || {};
    line(terms.symbol === 'CNS' && terms.threshold === 2 && terms.authority === A && terms.roster.length === 3 && terms.maxSupply === '100000.00' && terms.initialSupply === '1000.00' && 'purchase' in terms && 'faucet' in terms && /^[A-Za-z0-9+/=_-]+$/.test(terms.treasuryRef), 'with the terms: symbol, threshold, authority, roster, supply, faucet and purchase policy', terms);
    line(!JSON.stringify(lb.json).match(/refSecret"|ref_secret|"secret"/), 'and no reference secret field');
    const pub = await get(b, 'action=coin&coin=' + coin.id);
    line(pub.json.ok === true && !/awaiting|consent/i.test(JSON.stringify(pub.json)), 'the public view of the pending coin on b.example says nothing about consent', pub.json);

    console.log('== accepting and declining take a signed request only');
    for (const [action, body] of [['consent-list', {}], ['consent-accept', { coinId: coin.id, digest }], ['consent-decline', { coinId: coin.id, digest, reason: 'x' }]]) {
      const r = await legacyOp(b, action, body);
      line(r.status === 403 && r.json.code === 'signature-required', 'a token is refused for ' + action, r.json);
    }
    const tokenOk = await legacyOp(b, 'evidence', { coinId: coin.id });
    line(tokenOk.status !== 403 || tokenOk.json.code !== 'signature-required', 'although the same token still works for an older action on this domain', tokenOk.json);
    const aud = await signedOp(b, 'operator/audit', { limit: 50 });
    line(aud.status === 200, 'refusals are recorded in the audit table', aud.status);

    console.log('== acceptance names the exact coin and genesis');
    const wrongDigest = await accept(b, coin.id, 'a'.repeat(64));
    line(wrongDigest.status === 409 && wrongDigest.json.code === 'consent-mismatch', 'another digest is refused', wrongDigest.json);
    const wrongCoin = await accept(b, 'c'.repeat(32), digest);
    line(wrongCoin.status === 404 && wrongCoin.json.code === 'unknown-coin', 'another coin is refused', wrongCoin.json);
    line((await list(b)).json.proposals[0].status === 'awaiting', 'and neither changed anything');
    const noDigest = await signedOp(b, 'spend34/consent-accept', { coinId: coin.id }, { repeat: true });
    line(noDigest.status === 400, 'an acceptance without a digest is refused', noDigest.json);
    const ab = await accept(b, coin.id, digest);
    line(ab.status === 200 && ab.json.proposal.status === 'accepted' && ab.json.proposal.signed === false, 'the exact acceptance is recorded, and no signature is issued by it', ab.json);
    line((await stateOn(b, coin.id)) === 'pending' && (await stateOn(a, coin.id)) === 'pending', 'accepting does not open the coin');

    console.log('== opening needs a new signed request');
    const o2 = await open(a, coin.id);
    line(o2.status === 409 && o2.json.code === 'needs-consent' && o2.json.partners.map((p) => p.domain + ':' + p.state).sort().join(',') === B + ':signed,' + C + ':awaiting', 'a new open names only the partner still waiting', o2.json);
    const dec = await decline(c, coin.id, digest, 'I want a lower threshold');
    line(dec.status === 200 && dec.json.proposal.status === 'declined', 'c.example declines, with a reason', dec.json);
    const o3 = await open(a, coin.id);
    line(o3.status === 409 && o3.json.partners.find((p) => p.domain === C).state === 'declined', 'the authority sees it as declined', o3.json);
    const ac = await accept(c, coin.id, digest);
    line(ac.status === 200 && ac.json.proposal.status === 'accepted', 'decline then accept is allowed while no signature was issued', ac.json);
    const replay = await OP.postOnce(target(a), file, query, first);
    line(replay.headers['x-chainlabs-operator-replay'] === '1' && replay.status === 409 && replay.json.code === 'needs-consent', 'the first request, sent again, is answered from its record and is not carried out', replay);
    line((await stateOn(a, coin.id)) === 'pending', 'so the coin is still pending although every partner has accepted');
    const o4 = await open(a, coin.id);
    line(o4.status === 201 && o4.json.coin.state === 'active', 'only a new signed request opens it', o4.json);
    const view = o4.json.partners || [];
    line(view.length === 2 && view.every((p) => p.state === 'signed' && p.consent && p.consent.status === 'accepted' && /^\d{4}-/.test(p.consent.recordedAt) && typeof p.note === 'string'), 'the answer shows what each partner reported: consent recorded, and when', view);
    line((await stateOn(b, coin.id)) === 'active' && (await stateOn(c, coin.id)) === 'active', 'and the coin is open on all three domains');
    line((await list(b)).json.proposals.length === 0, 'an open coin is no longer a proposal');
    const fresh = await open(a, coin.id, { repeat: true });
    line(fresh.status === 409 && fresh.json.code === 'already-open', 'a coin opens once', fresh.json);

    console.log('== a signature that was issued cannot be withdrawn');
    const c3 = (await createCoin(a, 'CN3', { mode: 'multi', partners: [B, C] })).json;
    await open(a, c3.id);
    const dig3 = await digestOf(c3.id);
    await accept(b, c3.id, dig3);
    await open(a, c3.id);
    const late = await decline(b, c3.id, dig3, 'too late');
    line(late.status === 409 && late.json.code === 'already-signed', 'b.example already signed, so declining is refused', late.json);
    const lst = (await list(b)).json.proposals.find((p) => p.coinId === c3.id);
    line(lst.signed === true && lst.canDecline === false && lst.status === 'accepted', 'and the review no longer offers it', lst);

    console.log('== a scoped key gets the consent actions without being removed');
    const scoped = OP.newIdentity();
    const added = cli(b, 'add-key', '--key=' + scoped.publicKey, '--label=consent-only', '--actions=spend34/integrity', '--domain=' + B);
    line(added.code === 0, 'a key limited to one action is on the roster', added);
    const denied = await list(b, { as: scoped });
    line(denied.status === 403 && denied.json.code === 'action-not-permitted', 'it may not take a consent action', denied.json);
    const scopedFp = (added.out.match(/added ([a-f0-9]{16})/) || [])[1];
    const granted = cli(b, 'grant-actions', '--fingerprint=' + scopedFp, '--actions=spend34/consent-list,spend34/consent-accept,spend34/consent-decline');
    line(granted.code === 0 && /spend34\/consent-list/.test(granted.out), 'grant-actions adds them', granted);
    const sl = await list(b, { as: scoped });
    line(sl.status === 200, 'and the same key takes them without being removed and added again', sl.json);
    const stillLimited = await signedOp(b, 'spend34/evidence', { coinId: coin.id }, { as: scoped });
    line(stillLimited.status === 403, 'while it still may not take actions it was not given', stillLimited.json);

    console.log('== a key scoped to the consent actions from the start takes them, without operator/check');
    const only = OP.newIdentity();
    const addedOnly = cli(b, 'add-key', '--key=' + only.publicKey, '--label=partner-consent', '--actions=spend34/consent-list,spend34/consent-accept,spend34/consent-decline', '--domain=' + B);
    const onlyFp = (addedOnly.out.match(/added ([a-f0-9]{16})/) || [])[1];
    line(addedOnly.code === 0 && new RegExp(onlyFp + '[^\\n]*not yet verified[^\\n]*consent-list').test(cli(b, 'status').out), 'the key is on the roster with only the three consent actions, and has never proved itself with operator/check', cli(b, 'status').out);
    const c5 = (await createCoin(a, 'CN5', { mode: 'multi', partners: [B, C] })).json;
    await open(a, c5.id);
    const dig5 = await digestOf(c5.id);
    const sl5 = await list(b, { as: only });
    const seen5 = sl5.json && sl5.json.proposals ? sl5.json.proposals.find((p) => p.coinId === c5.id) : null;
    line(sl5.status === 200 && seen5 && seen5.genesisDigest === dig5 && seen5.terms.symbol === 'CN5', 'it calls consent-list successfully and sees the full proposal', sl5.json);
    const sa5 = await accept(b, c5.id, dig5, { as: only });
    line(sa5.status === 200 && sa5.json.proposal.status === 'accepted', 'and consent-accept', sa5.json);
    const sd5 = await decline(b, c5.id, dig5, 'changed my mind', { as: only });
    line(sd5.status === 200 && sd5.json.proposal.status === 'declined', 'and consent-decline', sd5.json);
    const outside = [await signedOp(b, 'spend34/evidence', { coinId: coin.id }, { as: only }), await signedOp(b, 'spend34/grant', { coinId: coin.id, to: 'x', amount: '1' }, { as: only, repeat: true }), await signedOp(b, 'spend34/open', { coinId: coin.id }, { as: only, repeat: true })];
    line(outside.every((r) => r.status === 403 && r.json.code === 'action-not-permitted'), 'while it may take nothing else', outside.map((r) => r.json));

    console.log('== a consent record that cannot be used never signs');
    const c4 = (await createCoin(a, 'CN4', { mode: 'multi', partners: [B, C] })).json;
    sqlExec(b, 'DROP TABLE ledger_consents');
    const down = await open(a, c4.id);
    line(down.status === 503 && down.json.code === 'consent-unavailable', 'with b.example\'s consent table gone, the authority\'s open is refused', down.json);
    line((await stateOn(b, c4.id)) === 'none', 'and b.example registered nothing');
    const lbad = await list(b);
    line(lbad.status === 503 && lbad.json.code === 'consent-unavailable', 'its own operator list refuses as well', lbad.json);
    const abad = await accept(b, c4.id, 'a'.repeat(64));
    line(abad.status === 503, 'and so does an acceptance', abad.json);
    line((await get(a, 'action=coins')).json.ok === true && (await get(b, 'action=coin&coin=' + coin.id)).json.state === 'active', 'while the public ledger routes carry on');
  } catch (e) {
    line(false, 'unexpected error: ' + (e.stack || e));
  } finally {
    for (const n of Object.values(nodes)) await stop(n).catch(() => {});
    cleanup();
  }
  console.log('\n' + (failures === 0 ? 'ALL ' + total + ' CHECKS PASSED' : failures + ' of ' + total + ' checks FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})();
