// The market figures of the chain labs (the `market` route of chain-labs/scan35.php and lib/market.php) against live PHP
// servers, one per domain, with coins registered the way the Coin Creation Studio does it (6 decimals, up to 1,000,000 coins):
//   - a coin with no purchase policy has supply and treasury figures and nothing else: no price, market cap or volume
//   - a coin with a policy and a Gold adapter has the offer price, a market cap of circulating supply times that price, and a
//     24 hour volume that counts completed purchases only, never grants or transfers, and not twice for a retried request
//   - a coin whose offer cannot be used (no adapter on the domain, a treasury below the smallest purchase) has no price
//   - an entry older than 24 hours is not in the volume
//   - a multi authority coin is stated by its authority only, so it is listed once
//   - the route is read-only, bounded, and carries no account key
//
//   node test/chain-labs-market-http.js
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const S = require('./support/chain-labs-servers');
const { A, B, nodes, issuerKey, wallet, start, call, post, scan, op, createCoin, NOW, iso, hex, credential, transfer } = S;

let failures = 0, total = 0;
const line = (ok, text, detail) => { total++; if (!ok) failures++; console.log((ok ? 'PASS ' : 'FAIL ') + text + (!ok && detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 500) : '')); };

// 1 Au buys one whole coin; the smallest purchase is 1 Au; 5,000 coins per key and 8,000 per day.
const POLICY6 = { priceClass: 'atlas.element.gold', issuerKey, unitsPerPrice: 1000000, minPrice: 1, perKeyUnits: '5000000000', perDayUnits: '8000000000' };
const def = { decimals: 6, maxSupply: '1000000', initialSupply: '10000' };
const market = async (n) => (await scan(n, 'action=market')).json;
const find = (m, id) => m.coins.find((c) => c.coinId === id);
function intent(w, coinId, cred, price, requestId) {
  const payload = { type: 'atlas.ledger.purchase.intent', v: 1, coinId, credentialId: cred.id, price, recipient: w.key, requestId, expiresAt: iso(NOW() + 300) };
  return { payload, signature: w.sign(payload) };
}
async function buy(n, w, coinId, quantity, price, requestId) {
  const cred = credential(quantity, w);
  const rid = requestId || hex(16);
  return { cred, rid, res: await post(n, 'action=purchase', { coinId, intent: intent(w, coinId, cred, price, rid), credential: cred }) };
}
const registry = (n, sql) => execFileSync('php', ['-r', '$d=new PDO("sqlite:' + path.join(n.priv, 'chain34.sqlite') + '");$d->exec($argv[1]);', sql]);

(async () => {
  for (const n of Object.values(nodes)) await start(n);
  const a = nodes[A], b = nodes[B];
  try {
    const goph = (await createCoin(a, 'GOPH', def)).json;
    const sell = (await createCoin(a, 'SELL', def)).json;
    const osc = (await createCoin(a, 'OSC', { ...def, mode: 'multi', partners: [B], threshold: 2 })).json;
    const poor = (await createCoin(a, 'POOR', { ...def, initialSupply: '0.5' })).json;
    line([goph, sell, osc, poor].every((c) => c.ok), 'setup: four coins are registered');
    const m0 = await market(a);
    line(m0.ok && m0.coins.length === 0 && m0.unit === 'Au', 'coins that are only registered have no market figures', m0);

    console.log('\n== a coin with no purchase policy');
    await op(a, 'open', { coinId: goph.id });
    await op(a, 'open', { coinId: sell.id, purchase: POLICY6 });
    const oscOpen = await op(a, 'open', { coinId: osc.id, purchase: POLICY6 });
    await op(a, 'open', { coinId: poor.id, purchase: POLICY6 });
    line(oscOpen.status === 201, 'setup: the others are opened, OSC with its partner', oscOpen.json);
    let m = await market(a);
    const g = find(m, goph.id);
    line(g && g.issuedUnits === '10000000000' && g.treasuryUnits === '10000000000' && g.circulatingUnits === '0' && g.decimals === 6, 'GOPH: issued supply and treasury are read from the ledger', g);
    line(g.offer === null && g.price === null && g.marketCap === null && g.volume24h === null, 'and it has no offer, price, market cap or volume, so the page shows dashes', g);
    const w = wallet(), w2 = wallet();
    await op(a, 'grant', { coinId: goph.id, to: w.key, amount: '12500000' });
    m = await market(a);
    const g2 = find(m, goph.id);
    line(g2.circulatingUnits === '12500000' && g2.treasuryUnits === '9987500000' && g2.price === null && g2.marketCap === null && g2.volume24h === null, 'a grant moves units out of the treasury and invents no price, market cap or volume', g2);

    console.log('\n== a coin with an offer');
    const s0 = find(await market(a), sell.id);
    line(s0.offer && s0.offer.available === true && s0.offer.unitsPerPrice === 1000000 && s0.offer.smallestUnits === '1000000', 'SELL: the offer comes from its genesis policy and is available', s0.offer);
    line(s0.price.gold === '1' && s0.marketCap.gold === '0' && s0.volume24h.gold === '0' && s0.volume24h.purchases === 0 && s0.volume24h.complete === true, 'one coin costs 1 Au; nothing circulates yet; nothing has been bought', s0);
    await op(a, 'grant', { coinId: sell.id, to: w.key, amount: '3000000' });
    const t = await transfer(w, a, sell.id, w2.key, '1000000');
    const tr = await post(a, 'action=propose', { authorization: t });
    line(tr.status === 201 && tr.json.receipt.entry.amount === '1000000', 'setup: a grant of 3 coins and a transfer of 1 between wallets', tr.json);
    const s1 = find(await market(a), sell.id);
    line(s1.circulatingUnits === '3000000' && s1.marketCap.gold === '3' && s1.volume24h.gold === '0' && s1.volume24h.purchases === 0, 'grants and transfers are not volume; market cap is 3 coins × 1 Au', s1);
    const p1 = await buy(a, w2, sell.id, 100, 20);
    line(p1.res.status === 201 && p1.res.json.receipt.entry.amount === '20000000', 'a purchase of 20 Au delivers 20 coins', p1.res.json);
    const s2 = find(await market(a), sell.id);
    line(s2.volume24h.gold === '20' && s2.volume24h.units === '20000000' && s2.volume24h.purchases === 1, '24h volume is the 20 Au just paid', s2.volume24h);
    line(s2.circulatingUnits === '23000000' && s2.marketCap.gold === '23', 'and market cap follows circulating supply: 23 coins × 1 Au', s2);
    const again = await post(a, 'action=purchase', { coinId: sell.id, intent: intent(w2, sell.id, p1.cred, 20, p1.rid), credential: p1.cred });
    const s3 = find(await market(a), sell.id);
    line(again.status < 300 && s3.volume24h.gold === '20' && s3.volume24h.purchases === 1 && s3.circulatingUnits === '23000000', 'a retried request is not counted twice and delivers nothing twice', [again.status, s3.volume24h]);
    const p2 = await buy(a, w2, sell.id, 100, 5);
    const s4 = find(await market(a), sell.id);
    line(p2.res.status === 201 && s4.volume24h.gold === '25' && s4.volume24h.purchases === 2, 'a second buyer request adds its own price', s4.volume24h);
    const refused = await buy(a, w2, sell.id, 100, 0);
    const s5 = find(await market(a), sell.id);
    line(refused.res.status >= 400 && s5.volume24h.gold === '25', 'a refused purchase adds nothing', [refused.res.status, s5.volume24h]);

    console.log('\n== an offer that cannot be used');
    const p = find(await market(a), poor.id);
    line(p.offer && p.offer.available === false && /treasury/.test(p.offer.unavailableBecause) && p.price === null && p.marketCap === null, 'POOR: a treasury below the smallest purchase has no price or market cap', p);
    line(p.volume24h && p.volume24h.purchases === 0, 'but it has a policy, so its volume is a real 0', p.volume24h);
    const adapter = path.join(a.priv, 'gold-adapter.php');
    fs.renameSync(adapter, adapter + '.off');
    const off = find(await market(a), sell.id);
    fs.renameSync(adapter + '.off', adapter);
    line(off.offer.available === false && /adapter/.test(off.offer.unavailableBecause) && off.price === null && off.marketCap === null && off.volume24h.gold === '25', 'a domain with no Gold adapter has no price or market cap, and its past volume stays', off);

    console.log('\n== a multi authority coin is counted once');
    const inA = find(await market(a), osc.id), inB = find(await market(b), osc.id);
    line(inA && inA.mode === 'multi' && inA.authority === A && inB === undefined, 'OSC is stated by its authority only; its partner leaves it out', [inA && inA.authority, inB]);
    const onB = (await scan(b, 'action=coins')).json.coins.find((c) => c.coinId === osc.id);
    line(onB, 'although the partner does hold its log');
    const sold = await buy(a, w, osc.id, 100, 7);
    const o2 = find(await market(a), osc.id);
    line(sold.res.status === 201 && o2.volume24h.gold === '7' && o2.price.gold === '1', 'a purchase of OSC through its partner is one sale in the volume', [sold.res.status, o2.volume24h]);
    const all = [...(await market(a)).coins, ...(await market(b)).coins].filter((c) => c.symbol === 'OSC');
    line(all.length === 1, 'across both domains OSC appears once', all.length);

    console.log('\n== the window');
    registry(a, "UPDATE ledger_log SET public_json=json_set(public_json,'$.executedAt','" + iso(NOW() - 25 * 3600) + "') WHERE coin_id='" + sell.id + "' AND json_extract(public_json,'$.purchase') IS NOT NULL");
    const old = find(await market(a), sell.id);
    line(old.volume24h.gold === '0' && old.volume24h.purchases === 0 && old.volume24h.complete === true, 'purchases dated more than 24 hours ago are not in the volume', old.volume24h);

    console.log('\n== read-only, bounded, no keys');
    const file = path.join(a.priv, 'chain34.sqlite');
    const before = fs.statSync(file).mtimeMs + ':' + fs.statSync(file).size;
    const raw = (await scan(a, 'action=market')).raw;
    line(before === fs.statSync(file).mtimeMs + ':' + fs.statSync(file).size, 'reading the figures leaves the database untouched');
    line(!raw.includes(w.key) && !raw.includes(w2.key) && !/BEGIN PUBLIC KEY/.test(raw), 'and the answer carries no account or domain key');
    line(raw.length < 60000, 'the answer is small: ' + raw.length + ' bytes for ' + JSON.parse(raw).coins.length + ' coins');
    const post1 = await call(a, 'scan35', 'POST', 'action=market', {});
    line(post1.status === 405, 'the route accepts GET only', post1.status);
  } finally {
    for (const n of Object.values(nodes)) if (n.proc) n.proc.kill('SIGKILL');
    S.cleanup();
  }
  console.log('\n' + (failures === 0 ? 'ALL ' + total + ' MARKET CHECKS PASSED' : failures + ' of ' + total + ' checks FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.log('ERROR ' + e.stack); S.cleanup(); process.exit(1); });
