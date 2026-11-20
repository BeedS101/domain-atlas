// Opening a single authority coin (chain-labs/spend34.php action=open) takes three steps: the coin is registered as pending, the domain
// signs its genesis, and the coin is activated. A stop between them used to leave the coin pending with every later open refused as
// already open. Against a live PHP server running the real endpoint, a failure is made to happen in each step (a database trigger that
// refuses the write), and then:
//   - opening again finishes the coin with the genesis, reference secret and treasury key it already had
//   - a coin that is open stays open: opening it again is still refused
//   - a pending coin that does not match its registry record is not completed
//   - a coin of several domains is opened as before
//
//   node test/chain-labs-open-resume.js
'use strict';
const path = require('path');
const { execFileSync } = require('child_process');
const S = require('./support/chain-labs-servers');
const { A, nodes, start, stop, get, post, op, createCoin, cleanup } = S;

let failures = 0, total = 0;
const line = (ok, text, detail) => { total++; if (!ok) failures++; console.log((ok ? 'PASS ' : 'FAIL ') + text + (!ok && detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 400) : '')); };
const a = nodes[A];
const ledgerFile = path.join(a.priv, 'chain34.sqlite');
const registryFile = path.join(a.priv, 'coin26.sqlite');
// Runs SQL against one of the node's databases and returns the rows as JSON.
function sql(file, statement, params = []) {
  const code = '$d=new PDO("sqlite:" . $argv[1]);$d->exec("PRAGMA busy_timeout=5000");$q=$d->prepare($argv[2]);$q->execute(array_slice($argv, 3));echo json_encode($q->columnCount() ? $q->fetchAll(PDO::FETCH_ASSOC) : []);';
  return JSON.parse(execFileSync('php', ['-r', code, file, statement, ...params], { encoding: 'utf8' }) || '[]');
}
const exec = (file, statement) => execFileSync('php', ['-r', '$d=new PDO("sqlite:" . $argv[1]);$d->exec($argv[2]);', file, statement]);
const coinRow = (id) => sql(ledgerFile, 'SELECT state,genesis_digest,ref_secret,treasury_key FROM ledger_coins WHERE coin_id=?', [id])[0];
const sigCount = (id) => sql(ledgerFile, 'SELECT COUNT(*) AS n FROM ledger_genesis_sigs WHERE coin_id=?', [id])[0].n;
const entries = (id) => sql(ledgerFile, 'SELECT COUNT(*) AS n FROM ledger_log WHERE coin_id=?', [id])[0].n;
const cli = (...args) => {
  try { return { code: 0, out: execFileSync('php', [path.join(__dirname, '..', 'chain-labs', 'lib', 'integrity-cli.php'), '--private=' + a.priv, ...args], { encoding: 'utf8' }) }; } catch (e) { return { code: e.status, out: String(e.stdout) + String(e.stderr) }; }
};

(async () => {
  try {
    await start(a);

    console.log('== a stop after the coin was registered');
    const pub = (await createCoin(a, 'RSM', { visibility: 'public' })).json;
    // The ledger tables exist once the server has answered a request. A trigger refuses the genesis signature.
    await get(a, 'action=coins');
    exec(ledgerFile, "CREATE TRIGGER stop_sign BEFORE INSERT ON ledger_genesis_sigs BEGIN SELECT RAISE(ABORT,'injected stop'); END;");
    const first = await op(a, 'open', { coinId: pub.id });
    const afterFirst = coinRow(pub.id);
    line(first.status !== 201 && afterFirst && afterFirst.state === 'pending' && sigCount(pub.id) === 0 && entries(pub.id) === 0, 'the open stops after the coin was registered: it is pending, unsigned, with no entry', [first.status, first.raw, afterFirst]);
    const found = cli();
    line(found.code === 0 && /warning opening-unfinished/.test(found.out), 'the integrity checker reports the unfinished opening as a warning', found.out);
    exec(ledgerFile, 'DROP TRIGGER stop_sign;');
    const second = await op(a, 'open', { coinId: pub.id });
    const done = coinRow(pub.id);
    line(second.status === 201 && second.json.ok === true && done.state === 'active' && sigCount(pub.id) === 1 && entries(pub.id) === 1, 'opening again finishes the coin: active, signed, with its first entry', [second.status, second.raw]);
    line(done.genesis_digest === afterFirst.genesis_digest && done.treasury_key === afterFirst.treasury_key && (await get(a, 'action=coin&coin=' + pub.id)).json.genesisDigest === afterFirst.genesis_digest, 'it keeps the genesis and treasury key the stopped attempt wrote', [done, afterFirst]);
    const again = await op(a, 'open', { coinId: pub.id });
    line(again.status === 409 && again.json.code === 'already-open', 'a coin that is open is still refused as already open', [again.status, again.raw]);
    const grant = await op(a, 'grant', { coinId: pub.id, to: S.wallet().key, amount: '5' });
    line(grant.status === 201, 'the finished coin takes a treasury grant', [grant.status, grant.raw]);

    console.log('\n== a stop after the genesis was signed, a private coin');
    const priv = (await createCoin(a, 'PRV', { visibility: 'private' })).json;
    exec(ledgerFile, "CREATE TRIGGER stop_entry BEFORE INSERT ON ledger_log BEGIN SELECT RAISE(ABORT,'injected stop'); END;");
    const stopped = await op(a, 'open', { coinId: priv.id });
    const held = coinRow(priv.id);
    line(stopped.status !== 201 && held.state === 'pending' && sigCount(priv.id) === 1 && entries(priv.id) === 0 && /^[a-f0-9]{64}$/.test(held.ref_secret), 'the open stops after the genesis was signed: pending, signed, no entry, with its reference secret', [stopped.status, held]);
    const refusedByKey = await post(a, 'action=open', { adminToken: 'f'.repeat(64), coinId: priv.id });
    line(refusedByKey.status === 403 && coinRow(priv.id).state === 'pending', 'a wrong operator token does not finish it', refusedByKey.status);
    exec(ledgerFile, 'DROP TRIGGER stop_entry;');
    const resumed = await op(a, 'open', { coinId: priv.id });
    const final = coinRow(priv.id);
    line(resumed.status === 201 && final.state === 'active' && entries(priv.id) === 1 && sigCount(priv.id) === 1, 'opening again finishes it without a second signature', [resumed.status, resumed.raw]);
    line(final.ref_secret === held.ref_secret && final.genesis_digest === held.genesis_digest && final.treasury_key === held.treasury_key, 'the private reference secret, genesis and treasury key are the ones it already had', { same: final.ref_secret === held.ref_secret });
    line(!resumed.raw.includes(held.ref_secret), 'the answer does not show the reference secret', resumed.raw.slice(0, 200));
    const clean = cli();
    line(clean.code === 0 && /2 coins, 2 ok, 0 warnings, 0 failed/.test(clean.out), 'the integrity checker finds both coins ok afterwards', clean.out);

    console.log('\n== a pending coin that no longer matches its registry record');
    const odd = (await createCoin(a, 'ODD', { visibility: 'public' })).json;
    exec(ledgerFile, "CREATE TRIGGER stop_sign BEFORE INSERT ON ledger_genesis_sigs BEGIN SELECT RAISE(ABORT,'injected stop'); END;");
    await op(a, 'open', { coinId: odd.id });
    exec(ledgerFile, 'DROP TRIGGER stop_sign;');
    const before = coinRow(odd.id);
    sql(registryFile, 'UPDATE coins SET name=? WHERE id=?', ['Another name', odd.id]);
    const mismatch = await op(a, 'open', { coinId: odd.id });
    line(mismatch.status === 409 && mismatch.json.code === 'pending-mismatch' && coinRow(odd.id).state === 'pending' && sigCount(odd.id) === 0, 'it is not completed: refused as not matching, still pending, nothing signed', [mismatch.status, mismatch.raw]);
    sql(registryFile, 'UPDATE coins SET name=? WHERE id=?', ['Coin ODD', odd.id]);
    const fixed = await op(a, 'open', { coinId: odd.id });
    line(fixed.status === 201 && coinRow(odd.id).genesis_digest === before.genesis_digest, 'once the record matches again it is finished with the same genesis', [fixed.status, fixed.raw]);
    const faucetStop = (await createCoin(a, 'FCT', { visibility: 'public' })).json;
    exec(ledgerFile, "CREATE TRIGGER stop_sign BEFORE INSERT ON ledger_genesis_sigs BEGIN SELECT RAISE(ABORT,'injected stop'); END;");
    await op(a, 'open', { coinId: faucetStop.id, faucet: { maxAmount: '10', perKeyLimit: '20', cooldownSeconds: 60 } });
    exec(ledgerFile, 'DROP TRIGGER stop_sign;');
    const wrongFaucet = await op(a, 'open', { coinId: faucetStop.id, faucet: { maxAmount: '99', perKeyLimit: '20', cooldownSeconds: 60 } });
    line(wrongFaucet.status === 409 && wrongFaucet.json.code === 'pending-mismatch' && coinRow(faucetStop.id).state === 'pending', 'a faucet policy that differs from the one the stopped attempt wrote is refused', [wrongFaucet.status, wrongFaucet.raw]);
    const sameFaucet = await op(a, 'open', { coinId: faucetStop.id, faucet: { maxAmount: '10', perKeyLimit: '20', cooldownSeconds: 60 } });
    line(sameFaucet.status === 201, 'the same faucet policy finishes it', [sameFaucet.status, sameFaucet.raw]);

    console.log('\n== a coin that was never registered');
    const fresh = (await createCoin(a, 'NEW', { visibility: 'public' })).json;
    const plain = await op(a, 'open', { coinId: fresh.id });
    line(plain.status === 201 && coinRow(fresh.id).state === 'active' && entries(fresh.id) === 1, 'an ordinary open is unchanged: one call, active, one entry', [plain.status, plain.raw]);
  } catch (e) {
    console.log('ERROR ' + e.stack);
    failures++;
  } finally {
    await stop(a);
    cleanup();
  }
  console.log('\n' + (failures === 0 ? 'ALL ' + total + ' OPEN RESUME CHECKS PASSED' : failures + ' of ' + total + ' checks FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.log('ERROR ' + e.stack); cleanup(); process.exit(1); });
