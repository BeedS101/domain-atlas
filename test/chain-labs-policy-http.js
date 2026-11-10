// Gold purchase policy in the Coin Creation Studio (chain-labs/coin26.php, lib/policy.php) and in opening (chain-labs/spend34.php),
// against live PHP servers:
//   - preview checks everything and shows the whole policy; nothing is stored by it
//   - a coin with a policy is created only with the digest of the policy that was shown
//   - the registry keeps the policy; the coin list shows it
//   - the issuer list of the operator limits the keys and classes that can be chosen
//   - opening writes the registered policy into the signed genesis, the same on every domain, and nothing else can replace it
//   - coins registered without a policy are unchanged
//
//   node test/chain-labs-policy-http.js
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const S = require('./support/chain-labs-servers');
const { A, B, nodes, start, stop, issuerKey, post, scan, op, call, createCoin } = S;

let failures = 0, total = 0;
const line = (ok, text, detail) => { total++; if (!ok) failures++; console.log((ok ? 'PASS ' : 'FAIL ') + text + (!ok && detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 400) : '')); };

const sql = (n, q, args = []) => JSON.parse(execFileSync('php', ['-r', '$d=new PDO("sqlite:"."' + path.join(n.priv, 'coin26.sqlite') + '");$s=$d->prepare($argv[1]);$s->execute(array_slice($argv,2));echo json_encode($s->columnCount()?$s->fetchAll(PDO::FETCH_ASSOC):[]);', q, ...args]).toString());
const GOOD = { coinsPerAu: '100', minPrice: 1, perKey: '1000', perDay: '10000', priceClass: 'atlas.element.gold', issuerKey };
const coinBody = (n, symbol, extra = {}) => ({ name: 'Coin ' + symbol, symbol, decimals: 2, maxSupply: '100000', initialSupply: '1000', description: '', adminToken: n.token, ...extra });
const preview = (n, symbol, purchase, extra) => call(n, 'coin26', 'POST', 'action=preview', coinBody(n, symbol, { purchase, ...extra }));
const create = (n, symbol, purchase, digest, extra) => call(n, 'coin26', 'POST', 'action=create', coinBody(n, symbol, { purchase, ...(digest ? { purchaseDigest: digest } : {}), ...extra }));
const listed = async (n) => (await call(n, 'coin26', 'GET', 'action=list')).json.coins;
const count = (n) => sql(n, 'SELECT COUNT(*) AS c FROM coins')[0].c;

(async () => {
  for (const n of Object.values(nodes)) await start(n);
  const a = nodes[A], b = nodes[B];
  try {
    console.log('== what the Studio offers');
    const opts = (await call(a, 'coin26', 'GET', 'action=options')).json;
    line(opts.ok && opts.purchase && opts.purchase.defaultClass === 'atlas.element.gold' && opts.purchase.listed === false, 'with no issuer list it offers the demo Gold class and says the key is not checked', opts.purchase);

    console.log('\n== preview shows the whole policy and stores nothing');
    const p = await preview(a, 'PRV', GOOD);
    line(p.status === 200 && p.json.ok && p.json.lines.length >= 6 && /^[0-9a-f]{64}$/.test(p.json.digest), 'a good policy is accepted with its lines and a fingerprint', p.json);
    line(p.json.purchase.unitsPerPrice === 10000 && p.json.purchase.perKeyUnits === '100000' && p.json.purchase.perDayUnits === '1000000' && p.json.purchase.minPrice === 1, 'the policy is in ledger units: 100 coins at 2 decimals = 10000 per Au', p.json.purchase);
    line(p.json.lines.some((t) => /1 PRV costs 0\.01 Au/.test(t)) && p.json.lines.some((t) => t.includes(issuerKey)), 'the lines state the price per coin and the issuer key', p.json.lines);
    line(count(a) === 0, 'nothing was registered by previewing');
    const p2 = await preview(a, 'PRV', GOOD);
    line(p2.json.digest === p.json.digest, 'the same input gives the same fingerprint');
    for (const [name, change] of [['rate', { coinsPerAu: '101' }], ['minimum', { minPrice: 2 }], ['per key', { perKey: '999' }], ['per day', { perDay: '9999' }], ['issuer', { issuerKey: issuerKey.slice(0, -2) + 'AA' }]]) {
      const q = await preview(a, 'PRV', { ...GOOD, ...change });
      line(q.json.ok && q.json.digest !== p.json.digest, 'a different ' + name + ' gives a different fingerprint', q.json);
    }
    const q = await preview(a, 'PRX', GOOD);
    line(q.json.digest !== p.json.digest, 'so does a different symbol');
    const small = await preview(a, 'PRV', { ...GOOD, minPrice: 1, coinsPerAu: '1000' }, { initialSupply: '500' });
    line(small.json.ok && small.json.warnings.length === 1 && /treasury/.test(small.json.warnings[0]), 'a treasury below the smallest purchase is a warning', small.json);
    const noPolicy = await call(a, 'coin26', 'POST', 'action=preview', coinBody(a, 'PRV'));
    line(noPolicy.status === 400, 'preview without a policy is refused', noPolicy.json);
    const noToken = await call(a, 'coin26', 'POST', 'action=preview', { ...coinBody(a, 'PRV', { purchase: GOOD }), adminToken: 'x'.repeat(64) });
    line(noToken.status === 401 || noToken.status === 403, 'and so is preview without the operator token', noToken.status);

    console.log('\n== everything wrong is refused, and nothing is stored');
    const bad = [
      ['not an object', 'text'], ['a list', [1]], ['missing field', (({ perDay, ...r }) => r)(GOOD)], ['extra field', { ...GOOD, extra: 1 }],
      ['rate zero', { ...GOOD, coinsPerAu: '0' }], ['rate negative', { ...GOOD, coinsPerAu: '-1' }], ['rate a number', { ...GOOD, coinsPerAu: 100 }], ['rate with letters', { ...GOOD, coinsPerAu: '1e2' }],
      ['rate with 3 decimals on a 2 decimal coin', { ...GOOD, coinsPerAu: '1.005' }], ['rate above the maximum supply', { ...GOOD, coinsPerAu: '100001' }],
      ['minimum zero', { ...GOOD, minPrice: 0 }], ['minimum fraction', { ...GOOD, minPrice: 1.5 }], ['minimum text', { ...GOOD, minPrice: '1' }], ['minimum too large', { ...GOOD, minPrice: 1000001 }],
      ['smallest purchase above the maximum supply', { ...GOOD, coinsPerAu: '60000', minPrice: 2 }],
      ['per key below the smallest purchase', { ...GOOD, perKey: '99' }], ['per day below the smallest purchase', { ...GOOD, perKey: '100', perDay: '99' }],
      ['per key above per day', { ...GOOD, perKey: '5000', perDay: '4000' }], ['per key zero', { ...GOOD, perKey: '0' }], ['per day above the maximum supply', { ...GOOD, perDay: '100001' }],
      ['class with capitals', { ...GOOD, priceClass: 'Atlas.Gold' }], ['class empty', { ...GOOD, priceClass: '' }], ['key too short', { ...GOOD, issuerKey: 'abc' }], ['key with a space', { ...GOOD, issuerKey: issuerKey.slice(0, 20) + ' ' + issuerKey.slice(21) }],
      ['a class that is not the demo Gold class (no issuer list)', { ...GOOD, priceClass: 'atlas.element.silver' }],
    ];
    for (const [name, policy] of bad) {
      const r = await preview(a, 'BAD', policy);
      const c = await create(a, 'BAD', policy, 'a'.repeat(64));
      line(r.status === 400 && !r.json.ok && c.status === 400, 'refused: ' + name, [r.status, r.json, c.status]);
    }
    line(count(a) === 0, 'none of them stored a coin');

    console.log('\n== creating needs the fingerprint of the policy that was shown');
    const noDigest = await create(a, 'GLD', GOOD);
    line(noDigest.status === 409 && noDigest.json.code === 'policy-not-confirmed', 'without it: refused', noDigest.json);
    const wrongDigest = await create(a, 'GLD', GOOD, '0'.repeat(64));
    line(wrongDigest.status === 409 && wrongDigest.json.code === 'policy-not-confirmed', 'with another one: refused', wrongDigest.json);
    const shown = (await preview(a, 'GLD', GOOD)).json.digest;
    const changed = await create(a, 'GLD', { ...GOOD, perDay: '20000' }, shown);
    line(changed.status === 409, 'with the fingerprint of a different policy: refused', changed.json);
    const otherSymbol = await create(a, 'GLX', GOOD, shown);
    line(otherSymbol.status === 409, 'with the fingerprint of the same policy on another coin: refused', otherSymbol.json);
    line(count(a) === 0, 'nothing stored by those');
    const ok = await create(a, 'GLD', GOOD, shown);
    line(ok.status === 201 && ok.json.ok && ok.json.state === 'registered' && ok.json.purchase.unitsPerPrice === 10000, 'with the right one the coin is registered', ok.json);
    const row = sql(a, "SELECT * FROM coins WHERE id=?", [ok.json.id])[0];
    line(JSON.parse(row.purchase).perDayUnits === '1000000' && JSON.parse(row.purchase).issuerKey === issuerKey, 'the registry keeps the ledger policy', row.purchase);
    line((await listed(a)).find((c) => c.id === ok.json.id).purchase.minPrice === 1, 'and the coin list shows it');
    const dupe = await create(a, 'GLD', GOOD, shown);
    line(dupe.status !== 201 && count(a) === 1, 'the same symbol again is refused', dupe.json);
    const noPol = await createCoin(a, 'PLN');
    line(noPol.status === 201 && (await listed(a)).find((c) => c.id === noPol.json.id).purchase === null, 'a coin created without a policy has none and the list says null', noPol.json);
    const stray = await create(a, 'STR', undefined, shown);
    line(stray.status === 201 && stray.json.purchase === null, 'a digest sent without a policy is ignored', stray.json);

    console.log('\n== the issuer list of the operator');
    const other = 'B'.repeat(88);
    fs.writeFileSync(path.join(a.priv, 'chainlabs-gold-issuers.json'), JSON.stringify({ issuers: [{ name: 'Test issuer', domain: 'issuer.example', key: issuerKey, classes: ['atlas.element.gold', 'atlas.element.silver'] }] }));
    const o2 = (await call(a, 'coin26', 'GET', 'action=options')).json.purchase;
    line(o2.listed === true && o2.issuers.length === 1 && o2.issuers[0].key === issuerKey, 'the Studio offers the listed issuers', o2);
    line((await preview(a, 'LST', GOOD)).json.lines.some((t) => /Test issuer/.test(t)), 'and names the issuer in the lines');
    line((await preview(a, 'LST', { ...GOOD, priceClass: 'atlas.element.silver' })).json.ok === true, 'a second class of that issuer is accepted');
    const unknown = await preview(a, 'LST', { ...GOOD, issuerKey: other });
    line(unknown.status === 400 && /not authorised/.test(unknown.json.error), 'a key that is not listed is refused', unknown.json);
    const wrongClass = await preview(a, 'LST', { ...GOOD, priceClass: 'atlas.element.bronze' });
    line(wrongClass.status === 400, 'a class the issuer is not listed for is refused', wrongClass.json);
    fs.writeFileSync(path.join(a.priv, 'chainlabs-gold-issuers.json'), '{ not json');
    line((await preview(a, 'LST', GOOD)).status === 400, 'a list that cannot be read authorises nobody');
    fs.writeFileSync(path.join(a.priv, 'chainlabs-gold-issuers.json'), JSON.stringify({ issuers: [] }));
    line((await preview(a, 'LST', GOOD)).status === 400, 'an empty list authorises nobody');
    fs.unlinkSync(path.join(a.priv, 'chainlabs-gold-issuers.json'));
    line((await preview(a, 'LST', GOOD)).json.ok === true, 'without a list the demo class is accepted again');

    console.log('\n== opening writes the registered policy into the signed genesis');
    const opened = await op(a, 'open', { coinId: ok.json.id });
    const g = opened.json.coin && opened.json.coin.genesis;
    line(opened.status === 201 && g && g.purchase && g.purchase.unitsPerPrice === 10000 && g.purchase.issuerKey === issuerKey && g.purchase.perKeyUnits === '100000', 'the genesis carries the policy', opened.json);
    const sc = (await scan(a, 'action=coin&coin=' + ok.json.id)).json;
    line(sc.ok && JSON.stringify(sc.genesis.purchase) === JSON.stringify(g.purchase), 'the scanner reads the same policy', sc.genesis);
    const mkt = (await scan(a, 'action=market')).json;
    const mc = (mkt.coins || []).find((c) => c.id === ok.json.id || c.coinId === ok.json.id);
    line(mkt.ok && mc && JSON.stringify(mc).includes('0.01'), 'the market data shows the price of 0.01 Au per coin', mc || mkt);

    const noOpen = await createCoin(a, 'NOP');
    const mismatch = await post(a, 'action=open', { adminToken: a.token, coinId: noOpen.json.id, purchase: { ...S.POLICY } });
    line(mismatch.status === 400 && mismatch.json.code === 'policy-mismatch', 'a policy sent at open time to a coin registered without one is refused', mismatch.json);
    const mismatch2 = await post(a, 'action=open', { adminToken: a.token, coinId: (await create(a, 'MM2', GOOD, (await preview(a, 'MM2', GOOD)).json.digest)).json.id, purchase: { ...S.POLICY } });
    line(mismatch2.status === 400 && mismatch2.json.code === 'policy-mismatch', 'and one that differs from the registered policy', mismatch2.json);
    const still = await post(a, 'action=open', { adminToken: a.token, coinId: noOpen.json.id });
    line(still.status === 201 && still.json.coin.genesis.purchase === undefined, 'a coin registered without a policy opens without one, genesis unchanged', still.json.coin && still.json.coin.genesis);

    console.log('\n== a registry row that was changed by hand');
    const tam = (await create(a, 'TAM', GOOD, (await preview(a, 'TAM', GOOD)).json.digest)).json;
    sql(a, "UPDATE coins SET purchase=? WHERE id=?", [JSON.stringify({ ...JSON.parse(sql(a, 'SELECT purchase FROM coins WHERE id=?', [tam.id])[0].purchase), perDayUnits: '999999999999999' }), tam.id]);
    const t1 = await post(a, 'action=open', { adminToken: a.token, coinId: tam.id });
    line(t1.status === 400 && (await listed(a)).find((c) => c.id === tam.id).ledger === 'none', 'a stored policy that the ledger would refuse stops the open', t1.json);
    sql(a, "UPDATE coins SET purchase=? WHERE id=?", ['not json', tam.id]);
    line((await post(a, 'action=open', { adminToken: a.token, coinId: tam.id })).status === 400, 'so does one that cannot be read');
    const tam2 = (await create(a, 'TM2', GOOD, (await preview(a, 'TM2', GOOD)).json.digest)).json;
    fs.writeFileSync(path.join(a.priv, 'chainlabs-gold-issuers.json'), JSON.stringify({ issuers: [{ key: other, classes: ['atlas.element.gold'] }] }));
    const t3 = await post(a, 'action=open', { adminToken: a.token, coinId: tam2.id });
    line(t3.status === 400 && /not authorised/.test(JSON.stringify(t3.json)), 'an issuer removed from the list after registering stops the open', t3.json);
    fs.unlinkSync(path.join(a.priv, 'chainlabs-gold-issuers.json'));

    console.log('\n== a coin of two domains');
    const mp = await call(a, 'coin26', 'POST', 'action=create', coinBody(a, 'MUL', { purchase: GOOD, purchaseDigest: (await preview(a, 'MUL', GOOD, { mode: 'multi', partners: [B], threshold: 2 })).json.digest, mode: 'multi', partners: [B], threshold: 2 }));
    line(mp.status === 201 && mp.json.state === 'pending', 'a multi authority coin with a policy is registered', mp.json);
    const mo = await op(a, 'open', { coinId: mp.json.id });
    line(mo.status === 201 && mo.json.ok, 'it opens with the partner', mo.json);
    const sa = (await scan(a, 'action=coin&coin=' + mp.json.id)).json, sb = (await scan(b, 'action=coin&coin=' + mp.json.id)).json;
    line(sa.ok && sb.ok && sa.genesisDigest === sb.genesisDigest && JSON.stringify(sa.genesis.purchase) === JSON.stringify(sb.genesis.purchase) && sa.genesis.purchase.unitsPerPrice === 10000, 'both domains hold the same genesis with the same policy', [sa.genesis, sb.genesis]);
    const hash1 = sa.genesisDigest;
    const mpNo = await createCoin(a, 'MNO', { mode: 'multi', partners: [B], threshold: 2 });
    const moNo = await op(a, 'open', { coinId: mpNo.json.id });
    line(moNo.status === 201 && (await scan(b, 'action=coin&coin=' + mpNo.json.id)).json.genesis.purchase === undefined && hash1 !== undefined, 'a multi authority coin without a policy opens as before');
  } finally {
    for (const n of Object.values(nodes)) await stop(n);
    S.cleanup();
  }
  console.log('\n' + (total - failures) + '/' + total + ' passed');
  process.exit(failures ? 1 : 0);
})();
