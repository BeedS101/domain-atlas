// A partner domain brings its copy of a coin level with the authority before it answers a public read (chain-labs/spend34.php catchup34).
// Anyone can make those reads, so how often they reach the authority is bounded: at most one catch-up for a coin in a short window.
// Three live PHP servers; the partner reaches the authority through a counting relay.
//   - a burst of anonymous reads makes one request to the authority, not one each
//   - the first read after the window catches up again, and a partner that was behind sees the authority's entries then
//   - a request that approves an entry, and the operator's comparison, are not held back by the window
//   - a read of a coin that does not exist makes no request and leaves no trace
//
//   node test/chain-labs-catchup-http.js
'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');
const S = require('./support/chain-labs-servers');
const { A, B, C, nodes, wallet, start, stop, get, post, op, createCoin, transfer, sleep } = S;

let failures = 0, total = 0;
const line = (ok, text, detail) => { total++; if (!ok) failures++; console.log((ok ? 'PASS ' : 'FAIL ') + text + (!ok && detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 400) : '')); };

// The partner's requests to the authority go through this relay, which counts them by the action they carry.
const seen = { sync: 0, head: 0, other: 0 };
const relay = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (d) => chunks.push(d));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    let action = 'other';
    try { action = JSON.parse(body.toString()).payload.action; } catch (e) {}
    seen[action in seen ? action : 'other']++;
    const up = http.request({ host: '127.0.0.1', port: nodes[A].port, path: req.url, method: 'POST', headers: { ...req.headers, 'content-length': body.length } }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', () => { res.writeHead(502); res.end(); });
    up.end(body);
  });
});
const syncs = () => seen.sync;

(async () => {
  const relayPort = await new Promise((resolve) => relay.listen(0, '127.0.0.1', () => resolve(relay.address().port)));
  for (const n of Object.values(nodes)) await start(n);
  const a = nodes[A], b = nodes[B];
  try {
    const peersFile = path.join(b.priv, 'chainlabs-peers.json');
    const peers = JSON.parse(fs.readFileSync(peersFile, 'utf8'));
    peers.urls[A] = 'http://127.0.0.1:' + relayPort + '/spend34.php?action=peer';
    fs.writeFileSync(peersFile, JSON.stringify(peers));

    const coin = (await createCoin(a, 'CUP', { mode: 'multi', partners: [B, C], threshold: 2 })).json;
    const opened = await op(a, 'open', { coinId: coin.id });
    line(coin.ok && opened.status === 201, 'a coin of three domains is open', [coin.error, opened.json]);
    const alice = wallet(), bob = wallet();
    await op(a, 'grant', { coinId: coin.id, to: alice.key, amount: '5000' });
    const headOf = async (n) => (await get(n, 'action=coin&coin=' + coin.id)).json.head.index;

    console.log('== a burst of anonymous reads');
    // The partner misses two entries, so there is something to catch up.
    await stop(b);
    for (let i = 0; i < 2; i++) {
      const h = (await post(a, 'action=holdings', { key: alice.key })).json.statement.coins.find((x) => x.coinId === coin.id);
      const t = await transfer(alice, a, coin.id, bob.key, '10', { baseSeq: h.seq });
      line((await post(a, 'action=propose', { authorization: t })).status === 201, 'the authority writes entry ' + (i + 2) + ' without the partner');
    }
    await start(b);
    const authorityHead = await headOf(a);
    const before = syncs();
    const first = await get(b, 'action=coin&coin=' + coin.id);
    line(first.status === 200 && first.json.head.index === authorityHead && syncs() === before + 1, 'the first read catches the partner up with one request to the authority', [first.json && first.json.head, syncs() - before]);
    const reads = [];
    for (let i = 0; i < 12; i++) {
      reads.push(get(b, 'action=coin&coin=' + coin.id), get(b, 'action=receipt&coin=' + coin.id + '&index=1'), get(b, 'action=proposal&coin=' + coin.id + '&digest=' + 'a'.repeat(64)));
    }
    const answers = await Promise.all(reads);
    line(answers.filter((r) => r.status === 200 || r.status === 404).length === answers.length, 'thirty-six more reads are all answered', answers.map((r) => r.status));
    line(syncs() - before <= 2, 'and they cost the authority at most one more request in all, not thirty-six', syncs() - before);

    console.log('\n== after the window');
    await stop(b);
    const h2 = (await post(a, 'action=holdings', { key: alice.key })).json.statement.coins.find((x) => x.coinId === coin.id);
    await post(a, 'action=propose', { authorization: await transfer(alice, a, coin.id, bob.key, '10', { baseSeq: h2.seq }) });
    await start(b);
    await sleep(6000);
    const mark = syncs();
    const later = await get(b, 'action=coin&coin=' + coin.id);
    line(later.status === 200 && later.json.head.index === await headOf(a) && syncs() === mark + 1, 'the first read after the window catches up again and shows the newest entry', [later.json && later.json.head, syncs() - mark]);

    console.log('\n== what is not held back');
    const claimed = syncs();
    await get(b, 'action=coin&coin=' + coin.id);
    line(syncs() === claimed, 'a read inside the window makes no request');
    const h3 = (await post(a, 'action=holdings', { key: alice.key })).json.statement.coins.find((x) => x.coinId === coin.id);
    const approve = await post(a, 'action=propose', { authorization: await transfer(alice, a, coin.id, bob.key, '10', { baseSeq: h3.seq }) });
    line(approve.status === 201 && syncs() > claimed, 'a request for the partner to approve an entry still catches up first, inside the window', [approve.status, syncs() - claimed]);
    const headsBefore = seen.head;
    const compared = await op(b, 'compare', { coinId: coin.id });
    line(compared.status === 200 && seen.head > headsBefore, "the operator's comparison still asks the authority, inside the window", [compared.status, seen.head - headsBefore]);

    console.log('\n== reads that name nothing');
    const noise = syncs();
    for (let i = 0; i < 5; i++) await get(b, 'action=coin&coin=' + String(i).repeat(32));
    line(syncs() === noise, 'a coin this domain does not hold makes no request');
    const rows = require('child_process').execFileSync('php', ['-r', '$d=new PDO("sqlite:"."' + path.join(b.priv, 'chain34.sqlite').replace(/\\/g, '/') + '");echo $d->query("SELECT COUNT(*) FROM ledger_catchup")->fetchColumn();']).toString().trim();
    line(rows === '1', 'and the only record kept is the one for the coin it holds', rows);
  } finally {
    relay.close();
    for (const n of Object.values(nodes)) if (n.proc) n.proc.kill('SIGKILL');
    S.cleanup();
  }
  console.log('\n' + (failures === 0 ? 'ALL ' + total + ' CHAIN-LABS CATCH-UP CHECKS PASSED' : failures + ' of ' + total + ' checks FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.log('ERROR ' + e.stack); S.cleanup(); process.exit(1); });
