// Opening registered coins whose supply reaches the unit limit (10^12 base units, 13 digits), against live PHP servers:
// a single authority coin and a 2-of-2 multi authority coin registered the way the Coin Creation Studio does it (6 decimals,
// maximum supply 1,000,000, initial treasury 10,000), and the edges of the limit.
//   - the registry stores base units, and the open request carries them to the ledger as whole-number strings
//   - the genesis of each coin has maxUnits "1000000000000" and initialUnits "10000000000", the same on both domains
//   - opening leaves the registered row as it was, and a coin cannot be opened twice
//   - a supply equal to the limit opens, and a treasury equal to the limit can be granted whole
//   - one unit above the limit is refused by the Studio, and by the ledger when a registry row is forced past it
//
//   node test/chain-labs-max-supply-http.js
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');
const S = require('./support/chain-labs-servers');
const { A, B, nodes, start, stop, wallet, createCoin, get, post, scan, op, call } = S;

let failures = 0, total = 0;
const line = (ok, text, detail) => { total++; if (!ok) failures++; console.log((ok ? 'PASS ' : 'FAIL ') + text + (!ok && detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 400) : '')); };

// The registry is read and changed directly, the way a restore or a hand edit would.
const registry = (n, sql) => JSON.parse(execFileSync('php', ['-r', '$d=new PDO("sqlite:"."' + path.join(n.priv, 'coin26.sqlite') + '");$q=$d->query($argv[1]);echo json_encode($q?$q->fetchAll(PDO::FETCH_ASSOC):[]);', sql]).toString() || '[]');
const rowOf = (n, id) => registry(n, "SELECT * FROM coins WHERE id='" + id + "'")[0];

(async () => {
  for (const n of Object.values(nodes)) await start(n);
  const a = nodes[A], b = nodes[B];
  try {
    const def = { decimals: 6, maxSupply: '1000000', initialSupply: '10000' };
    const goph = (await createCoin(a, 'GOPH', def)).json;
    const osc = (await createCoin(a, 'OSC', { ...def, mode: 'multi', partners: [B], threshold: 2 })).json;
    line(goph.ok && goph.state === 'registered' && osc.ok && osc.state === 'pending', 'the Studio registers GOPH (single) and OSC (2-of-2) with 6 decimals', [goph, osc]);

    console.log('\n== what the registry holds');
    const gRow = rowOf(a, goph.id), oRow = rowOf(a, osc.id);
    line(String(gRow.max_units) === '1000000000000' && String(gRow.initial_units) === '10000000000' && Number(gRow.decimals) === 6, 'GOPH is stored as 1000000000000 and 10000000000 base units', gRow);
    line(String(oRow.max_units) === '1000000000000' && String(oRow.initial_units) === '10000000000', 'and so is OSC', oRow);
    const listed = (await call(a, 'coin26', 'GET', 'action=list')).json.coins.find((c) => c.id === goph.id);
    line(/^1000000(\.0+)?$/.test(listed.maxSupply) && /^10000(\.0+)?$/.test(listed.initialSupply) && listed.ledger === 'none', 'the Studio shows 1,000,000 and 10,000 coins, not open yet', listed);

    console.log('\n== opening GOPH, a single authority coin');
    const opened = await op(a, 'open', { coinId: goph.id });
    line(opened.status === 201 && opened.json.ok, 'it opens', opened.json);
    const g = opened.json.coin.genesis;
    line(g.maxUnits === '1000000000000' && g.initialUnits === '10000000000' && g.decimals === 6, 'the genesis carries maxUnits 1000000000000 and initialUnits 10000000000 as strings', g);
    line(opened.json.coin.supply === '10000000000' && opened.json.coin.entries === 1, 'entry 0 credits the treasury with 10,000 coins', opened.json.coin);
    line(JSON.stringify(rowOf(a, goph.id)) === JSON.stringify(gRow), 'the registered row is exactly as it was');
    const again = await op(a, 'open', { coinId: goph.id });
    line(again.status === 409 && again.json.code === 'already-open', 'a second open is refused', again.json);
    const listed2 = (await call(a, 'coin26', 'GET', 'action=list')).json.coins.find((c) => c.id === goph.id);
    line(listed2.ledger === 'active', 'and the Studio lists it as open', listed2);
    const sc = (await scan(a, 'action=coin&coin=' + goph.id)).json;
    line(sc.ok && sc.genesis.maxUnits === '1000000000000' && sc.supply === '10000000000', 'the scanner reads the same genesis', sc);

    console.log('\n== opening OSC with both domains');
    const o = await op(a, 'open', { coinId: osc.id });
    line(o.status === 201 && o.json.ok && o.json.coin.genesis.maxUnits === '1000000000000' && o.json.coin.genesis.initialUnits === '10000000000', 'it opens once the partner has signed, with the same amounts', o.json);
    const sa = (await scan(a, 'action=coin&coin=' + osc.id)).json, sb = (await scan(b, 'action=coin&coin=' + osc.id)).json;
    line(sa.ok && sb.ok && sa.genesisDigest === sb.genesisDigest && sb.genesis.maxUnits === '1000000000000' && sb.genesis.threshold === 2 && sa.head.hash === sb.head.hash, 'the partner domain holds the identical genesis and head', [sa.genesisDigest, sb.genesisDigest]);
    line(JSON.stringify(rowOf(a, osc.id)) === JSON.stringify(oRow), 'the registered row of OSC is as it was');
    const dup = await op(a, 'open', { coinId: osc.id });
    line(dup.status === 409 && dup.json.code === 'already-open', 'OSC cannot be opened twice', dup.json);

    console.log('\n== the edge of the limit');
    const full = (await createCoin(a, 'FULL', def && { decimals: 6, maxSupply: '1000000', initialSupply: '1000000' })).json;
    line(full.ok, 'the Studio takes an initial supply equal to the maximum supply', full);
    const fo = await op(a, 'open', { coinId: full.id });
    line(fo.status === 201 && fo.json.coin.genesis.initialUnits === '1000000000000' && fo.json.coin.supply === '1000000000000', 'a treasury of exactly 10^12 units opens', fo.json);
    const w = wallet();
    const gr = await op(a, 'grant', { coinId: full.id, to: w.key, amount: '1000000000000' });
    line(gr.status === 201 && gr.json.ok, 'and it can be granted whole', gr.json);
    const h = (await post(a, 'action=holdings', { key: w.key })).json;
    line(h.statement && h.statement.coins.find((c) => c.coinId === full.id).units === '1000000000000', 'the wallet finds 1000000000000 units', h);
    const more = await op(a, 'grant', { coinId: full.id, to: w.key, amount: '1' });
    line(more.status >= 400 && more.json && more.json.ok === false, 'with nothing left in the treasury a further grant is refused', more.json);
    const whole = (await createCoin(a, 'WHOLE', { decimals: 0, maxSupply: '1000000000000', initialSupply: '1' })).json;
    const wo = await op(a, 'open', { coinId: whole.id });
    line(whole.ok && wo.status === 201 && wo.json.coin.genesis.maxUnits === '1000000000000', 'a coin with no decimals and a maximum of 10^12 coins opens', [whole, wo.json]);

    console.log('\n== above the limit');
    for (const [name, def2] of [['1,000,000.000001 at 6 decimals', { decimals: 6, maxSupply: '1000000.000001' }], ['1,000,001 at 6 decimals', { decimals: 6, maxSupply: '1000001' }],
      ['10^12 + 1 at 0 decimals', { decimals: 0, maxSupply: '1000000000001', initialSupply: '1' }], ['a seventh decimal', { decimals: 6, maxSupply: '1000000.0000001' }], ['13 whole digits', { decimals: 0, maxSupply: '1000000000000000', initialSupply: '1' }]]) {
      const r = await createCoin(a, 'BIG', { initialSupply: '1', ...def2 });
      line(r.status === 400 && r.json && r.json.ok === false, 'the Studio refuses a maximum of ' + name, r.json);
    }
    const registered = registry(a, "SELECT symbol FROM coins WHERE symbol='BIG'");
    line(registered.length === 0, 'and registers nothing for them');
    // A row forced past the limit (a bad restore, a hand edit) is still stopped by the ledger.
    const forced = (await createCoin(a, 'FORCED', def)).json;
    registry(a, "UPDATE coins SET max_units=1000000000001 WHERE id='" + forced.id + "'");
    const fr = await op(a, 'open', { coinId: forced.id });
    line(fr.status === 400 && fr.json.code === 'bad-amount', 'a registry row above the limit is refused by the ledger', fr.json);
    line((await scan(a, 'action=coins')).json.coins.every((c) => c.coinId !== forced.id && c.id !== forced.id), 'and no ledger was created for it');
  } finally {
    for (const n of Object.values(nodes)) await stop(n);
    S.cleanup();
  }
  console.log('\n' + (failures === 0 ? 'ALL ' + total + ' MAX SUPPLY CHECKS PASSED' : failures + ' of ' + total + ' checks FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.log('ERROR ' + e.stack); S.cleanup(); process.exit(1); });
