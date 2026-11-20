// The end of the operator token over HTTP. The date is a constant of lib/operator.php that no setting moves, so this test runs servers whose
// copy of the library has the date set to a moment that has passed, and to one that has not.
//
//   node test/chain-labs-operator-sunset.js
'use strict';
const fs = require('fs');
const path = require('path');
const S = require('./support/chain-labs-servers');
const { A, nodes, start, call, signedOp, legacyOp, legacyCreateCoin, get, post } = S;

let failures = 0, total = 0;
const line = (ok, text, detail) => { total++; if (!ok) failures++; console.log((ok ? 'PASS ' : 'FAIL ') + text + (!ok && detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 400) : '')); };
const setUntil = (n, epoch) => {
  const file = path.join(n.root, 'lib', 'operator.php');
  const code = fs.readFileSync(file, 'utf8');
  if (!/const OPERATOR_LEGACY_UNTIL = \d+;/.test(code)) throw new Error('the date constant was not found');
  fs.writeFileSync(file, code.replace(/const OPERATOR_LEGACY_UNTIL = \d+;/, 'const OPERATOR_LEGACY_UNTIL = ' + epoch + ';'));
};
const realDate = /const OPERATOR_LEGACY_UNTIL = 1803859200;/.test(fs.readFileSync(path.join(__dirname, '..', 'chain-labs', 'lib', 'operator.php'), 'utf8'));

(async () => {
  line(realDate, 'the date in the library is 1 March 2027 00:00 UTC (1803859200)');
  line(Date.UTC(2027, 2, 1) / 1000 === 1803859200, 'which is that moment');
  await start(nodes[A]);
  const a = nodes[A];
  try {
    const coin = (await S.createCoin(a, 'SUN')).json;
    await S.op(a, 'open', { coinId: coin.id });
    const alice = S.wallet();

    console.log('== an hour before the date');
    setUntil(a, Math.floor(Date.now() / 1000) + 3600);
    const before = await legacyOp(a, 'grant', { coinId: coin.id, to: alice.key, amount: '1' });
    line(before.status === 201, 'the token still works', before.json);
    const noHeader = await call(a, 'spend34', 'POST', 'action=integrity', { adminToken: a.token, coinId: coin.id });
    line(noHeader.status === 200, 'for reading too');

    console.log('\n== after the date');
    setUntil(a, Math.floor(Date.now() / 1000) - 5);
    const cases = [['grant', { coinId: coin.id, to: alice.key, amount: '1' }], ['open', { coinId: coin.id }], ['integrity', { coinId: coin.id }], ['evidence', { coinId: coin.id }], ['recover', { coinId: coin.id }], ['accept-rollback', { coinId: coin.id }]];
    const refused = [];
    for (const [action, body] of cases) { const r = await legacyOp(a, action, body); if (r.status !== 403 || r.json.code !== 'legacy-ended') refused.push([action, r.status, r.json && r.json.code]); }
    const lc = await legacyCreateCoin(a, 'LATE');
    line(refused.length === 0 && lc.status === 403 && lc.json.code === 'legacy-ended', 'the token is refused for every action, reading included', [refused, lc.json]);
    const withHash = JSON.parse(fs.readFileSync(path.join(a.priv, 'chainlabs-operators.json'), 'utf8'));
    line(typeof withHash.legacyTokenSha256 === 'string', 'although the roster still holds its hash');
    for (const extra of [{ legacyUntil: '2099-01-01' }, { legacyUntil: 4102444800 }, { legacyDisabled: false }, { activated: false }]) {
      S.writeRoster(a, extra);
      S.forgetFailures(a);
      const r = await legacyOp(a, 'integrity', { coinId: coin.id });
      line(r.status === 403 && r.json.code === 'legacy-ended', 'a roster setting ' + JSON.stringify(extra) + ' does not bring it back', r.json);
    }
    S.writeRoster(a);
    fs.writeFileSync(path.join(a.priv, 'chainlabs-config.json'), JSON.stringify({ hosts: [S.A, S.B, S.C, S.D], legacyUntil: 4102444800, partners: { [S.A]: [S.B, S.C, S.D] } }));
    S.forgetFailures(a);
    line((await legacyOp(a, 'integrity', { coinId: coin.id })).status === 403, 'nor does the hosts file');
    line(!/getenv|\$_ENV|ini_get/.test(fs.readFileSync(path.join(a.root, 'lib', 'operator.php'), 'utf8').match(/function operator_legacy_open[\s\S]*?\n}/)[0]), 'the check reads the constant and the clock only');

    console.log('\n== what goes on working');
    const signed = await signedOp(a, 'grant', { coinId: coin.id, to: alice.key, amount: '2' });
    line(signed.status === 201, 'a signed request grants', signed.json);
    line((await signedOp(a, 'integrity', { coinId: coin.id })).status === 200, 'and reads');
    const pub = [(await get(a, 'action=coins')).status, (await post(a, 'action=holdings', { key: alice.key })).status, (await post(a, 'action=challenge', {})).status, (await call(a, 'coin26', 'GET', 'action=list')).status];
    line(pub.every((s) => s === 200), 'the public ledger routes answer as before', pub);
    line((await S.units(a, alice, coin.id)) === '3', 'and the balance is what was granted before and after: 1 + 2');
    const ver = await signedOp(a, 'operator/check', {});
    line(ver.status === 200 && ver.json.legacy.open === false && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(ver.json.legacy.until), 'the check says the token has ended, and the date it ended', ver.json);
  } finally {
    for (const n of Object.values(nodes)) if (n.proc) n.proc.kill('SIGKILL');
    S.cleanup();
  }
  console.log('\n' + (failures === 0 ? 'ALL ' + total + ' CHAIN-LABS TOKEN SUNSET CHECKS PASSED' : failures + ' of ' + total + ' checks FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.log('ERROR ' + e.stack); S.cleanup(); process.exit(1); });
