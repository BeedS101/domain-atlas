// The rollback guard against a live PHP server running the real endpoint (chain-labs/spend34.php): a ledger database put back from an
// older copy while the domain is down, what the endpoint then answers, and the operator's ways back.
//   - normal operation leaves private checkpoint files beside the database, never in the web root, and a killed server is no rollback
//   - after the old copy is put back: a signed transfer is refused with 503, the coin is shown as frozen, holdings say so
//   - restore (journal replay) brings the lost entries back with the same hashes and the coin runs again
//   - accept-rollback keeps the coin frozen for good; a damaged checkpoint file stops it with its own code and a reseal repairs it
//
//   node test/chain-labs-rollback-http.js
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const S = require('./support/chain-labs-servers');
const { A, nodes, wallet, start, stop, get, post, op, createCoin, transfer, units, cleanup } = S;

let failures = 0, total = 0;
const line = (ok, text, detail) => { total++; if (!ok) failures++; console.log((ok ? 'PASS ' : 'FAIL ') + text + (!ok && detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 500) : '')); };

const a = nodes[A];
const db = () => path.join(a.priv, 'chain34.sqlite');
const cpDir = () => db() + '.checkpoints';
// A copy of the database file taken while the domain is down: the safe way to copy a file that is not being written.
const copyDb = (to) => fs.copyFileSync(db(), to);
const putBack = (from) => { for (const s of ['', '-wal', '-shm']) fs.rmSync(db() + s, { force: true }); fs.copyFileSync(from, db()); };
const rawGet = (urlPath) => new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port: a.port, path: urlPath, method: 'GET', headers: { host: A } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
  req.on('error', () => resolve(0));
  req.end();
});
const holdingsState = async (w, coinId) => { const r = await post(a, 'action=holdings', { key: w.key }); const c = r.json.statement.coins.find((x) => x.coinId === coinId); return c ? c.state : null; };
const send = async (w, coinId, to, amount) => post(a, 'action=propose', { authorization: await transfer(w, a, coinId, to, amount) });

(async () => {
  try {
    await start(a);
    const alice = wallet(), bob = wallet(), carol = wallet();
    const coin = (await createCoin(a, 'RBK')).json;
    const opened = await op(a, 'open', { coinId: coin.id });
    line(opened.status === 201, 'a coin is opened', opened.json);
    await op(a, 'grant', { coinId: coin.id, to: alice.key, amount: '100000' });
    await stop(a);
    const backup = path.join(S.work || require('os').tmpdir(), 'chain34-backup-' + process.pid + '.sqlite');
    copyDb(backup);
    await start(a);

    console.log('\n== normal operation leaves checkpoints in the private folder');
    const s1 = await send(alice, coin.id, bob.key, '30000');
    const s2 = await send(alice, coin.id, carol.key, '70000');
    line(s1.status === 201 && s2.status === 201 && (await units(a, alice, coin.id)) === '0', 'alice spends everything she holds in two transfers', [s1.json, s2.json]);
    const files = fs.existsSync(cpDir()) ? fs.readdirSync(cpDir()) : [];
    line(files.includes(coin.id + '.log') && files.includes(coin.id + '.journal') && !fs.existsSync(path.join(a.root, 'chain34.sqlite.checkpoints')), 'the checkpoint log and journal are beside the database in the private folder, not in the web root', files);
    line((await rawGet('/chain34.sqlite.checkpoints/' + coin.id + '.log')) === 404 && (await rawGet('/../chainblock-labs-private/chain34.sqlite.checkpoints/' + coin.id + '.log')) !== 200, 'and they are not served');
    const head = (await get(a, 'action=coin&coin=' + coin.id)).json.head;
    await stop(a);
    await start(a);
    const integrity = await op(a, 'integrity', { coinId: coin.id });
    line(integrity.status === 200 && integrity.json.verdict.status === 'ok' && integrity.json.head.hash === head.hash, 'a server that was killed and started again is no rollback', integrity.json);

    console.log('\n== the old copy is put back');
    await stop(a);
    putBack(backup);
    await start(a);
    line((await units(a, alice, coin.id)) === '100000', 'the database says alice holds 100000 again');
    const refused = await send(alice, coin.id, bob.key, '100000');
    line(refused.status === 503 && refused.json.code === 'rollback-detected', 'her next transfer is refused with 503 rollback-detected', refused.json);
    line((await units(a, bob, coin.id)) === '0', 'and nothing was written');
    const shown = (await get(a, 'action=coin&coin=' + coin.id)).json;
    line(shown.state === 'frozen' && (await holdingsState(alice, coin.id)) === 'frozen', 'the coin is shown to wallets and scanners as frozen', shown.state);
    const status = await op(a, 'integrity', { coinId: coin.id });
    line(status.json.verdict.status === 'halted' && status.json.verdict.reason === 'rollback' && status.json.verdict.detail.floorIndex === head.index && status.json.verdict.detail.databaseIndex === 1, 'the operator\'s integrity report names the rollback with both heads', status.json.verdict);
    line((await post(a, 'action=restore', { coinId: coin.id })).status === 401 || (await post(a, 'action=restore', { coinId: coin.id })).status === 403, 'restoring needs the operator token');

    console.log('\n== replaying what was lost');
    const restored = await op(a, 'restore', { coinId: coin.id });
    line(restored.status === 200 && restored.json.journal.applied === 2 && restored.json.verdict.status === 'ok', 'restore replays the two lost entries from the journal', restored.json);
    const after = (await get(a, 'action=coin&coin=' + coin.id)).json;
    line(after.head.index === head.index && after.head.hash === head.hash && after.state === 'active', 'the head is exactly the one before the rollback and the coin is active', after.head);
    line((await units(a, alice, coin.id)) === '0' && (await units(a, bob, coin.id)) === '30000' && (await units(a, carol, coin.id)) === '70000', 'balances are as they were: alice\'s 100000 did not come back');
    const again = await send(bob, coin.id, carol.key, '1000');
    line(again.status === 201, 'the coin takes transfers again', again.json);

    console.log('\n== accepting the loss');
    const backup2 = path.join(path.dirname(backup), 'chain34-backup2-' + process.pid + '.sqlite');
    await stop(a);
    copyDb(backup2);
    await start(a);
    const s3 = await send(carol, coin.id, alice.key, '5000');
    line(s3.status === 201, 'one more transfer after the second backup');
    await stop(a);
    putBack(backup2);
    await start(a);
    const rb = await op(a, 'integrity', { coinId: coin.id });
    const d = rb.json.verdict.detail;
    const wrong = await op(a, 'accept-rollback', { coinId: coin.id, reason: 'the host lost a day', confirm: { floorIndex: d.floorIndex, floorHash: 'f'.repeat(64), databaseIndex: d.databaseIndex } });
    line(wrong.status === 409 && wrong.json.code === 'confirm-mismatch', 'accepting a loss needs the heads repeated exactly', wrong.json);
    const accepted = await op(a, 'accept-rollback', { coinId: coin.id, reason: 'the host lost a day', confirm: { floorIndex: d.floorIndex, floorHash: d.floorHash, databaseIndex: d.databaseIndex } });
    line(accepted.status === 200 && accepted.json.accepted.lostCount === 1, 'with them repeated the loss is accepted and listed', accepted.json);
    const ev = await op(a, 'evidence', { coinId: coin.id });
    line(ev.json.state === 'frozen' && ev.json.evidence.some((e) => e.kind === 'rollback-accepted'), 'the coin is frozen with the lost entries kept as evidence', ev.json);
    const afterAccept = await send(carol, coin.id, alice.key, '1');
    line(afterAccept.status >= 400 && (await units(a, alice, coin.id)) === '0', 'nothing can be spent on it', afterAccept.json);
    line((await op(a, 'restore', { coinId: coin.id })).json.journal.applied === 0, 'and restore no longer replays anything');

    console.log('\n== a damaged checkpoint file');
    const coin2 = (await createCoin(a, 'DMG')).json;
    await op(a, 'open', { coinId: coin2.id });
    await op(a, 'grant', { coinId: coin2.id, to: alice.key, amount: '1000' });
    await send(alice, coin2.id, bob.key, '10');
    const logFile = path.join(cpDir(), coin2.id + '.log');
    const lines = fs.readFileSync(logFile, 'utf8').trimEnd().split('\n');
    lines[1] = lines[1].replace('"kind":"intent"', '"kind":"intenx"');
    fs.writeFileSync(logFile, lines.join('\n') + '\n');
    const dmg = await send(alice, coin2.id, bob.key, '10');
    line(dmg.status === 503 && dmg.json.code === 'checkpoint-corrupt', 'a changed line stops the coin with its own code, not a rollback', dmg.json);
    const dmgHead = (await get(a, 'action=coin&coin=' + coin2.id)).json.head;
    const seal = await op(a, 'reseal', { coinId: coin2.id, confirm: { databaseIndex: dmgHead.index, databaseHash: dmgHead.hash } });
    line(seal.status === 200 && fs.readdirSync(cpDir()).some((f) => f.includes('.damaged-')), 'a reseal sets the damaged file aside and begins a new one', seal.json);
    line((await send(alice, coin2.id, bob.key, '10')).status === 201, 'and the coin goes on');
    const other = await send(alice, coin2.id, bob.key, '10');
    line(other.status === 201, 'with the next transfer too');
  } catch (e) {
    failures++;
    console.log('FATAL ' + (e && e.stack || e));
  } finally {
    cleanup();
  }
  console.log('\n' + (failures === 0 ? 'ALL ' + total + ' CHAIN-LABS ROLLBACK ENDPOINT CHECKS PASSED' : failures + ' of ' + total + ' FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})();
