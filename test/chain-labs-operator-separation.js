// The token the older demonstration labs (events21, events22, federation20, compare23) read from federation20-config.php is not the
// credential of the chain labs operator actions: it opens none of them, and the chain labs operator token opens none of the labs. The
// demonstration labs themselves are unchanged and still take their own token.
//
//   node test/chain-labs-operator-separation.js
'use strict';
const fs = require('fs');
const path = require('path');
const S = require('./support/chain-labs-servers');
const { A, nodes, start, call, signedOp, legacyOp, legacyCreateCoin } = S;

let failures = 0, total = 0;
const line = (ok, text, detail) => { total++; if (!ok) failures++; console.log((ok ? 'PASS ' : 'FAIL ') + text + (!ok && detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 400) : '')); };
const DIR = path.join(__dirname, '..', 'chain-labs');
// Failed attempts are counted per client address and every request here has the same one, so the count is cleared between attempts.
const forgetFailures = (n) => require('child_process').execFileSync('php', ['-r', '$d=new PDO("sqlite:".$argv[1]);$d->exec("DELETE FROM operator_failures");', path.join(n.priv, 'chainlabs-operator.sqlite')]);
const text = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');

console.log('== where each token is read');
for (const f of ['spend34.php', 'coin26.php', 'lib/operator.php', 'lib/spend.php', 'lib/ledger.php', 'lib/policy.php', 'lib/purchase.php']) {
  line(!/admin_token_hex/.test(text(f)), f + ' does not read the demonstration token');
}
for (const f of ['events21.php', 'events22.php', 'compare23.php', 'federation20.php']) {
  line(/admin_token_hex/.test(text(f)), f + ' still reads it, unchanged');
}

(async () => {
  await start(nodes[A]);
  const a = nodes[A];
  const coinId = (await S.createCoin(a, 'SEP')).json.id;
  await S.op(a, 'open', { coinId });
  try {
    for (const f of ['events21', 'events22', 'compare23']) fs.copyFileSync(path.join(DIR, f + '.php'), path.join(a.root, f + '.php'));
    const demo = a.demoToken, wrong = '0'.repeat(64);

    console.log('\n== the demonstration token opens no chain labs operator action');
    const asBody = (token, request) => Object.assign({ adminToken: token }, request);
    const attempts = [
      ['spend34', 'action=open', { coinId }], ['spend34', 'action=grant', { coinId, to: S.wallet().key, amount: '5' }], ['spend34', 'action=recover', { coinId }],
      ['spend34', 'action=accept-rollback', { coinId }], ['spend34', 'action=reseal', { coinId }], ['spend34', 'action=restore', { coinId }], ['spend34', 'action=compare', { coinId }],
      ['spend34', 'action=integrity', { coinId }], ['spend34', 'action=evidence', { coinId }], ['spend34', 'action=resume', { coinId }], ['spend34', 'action=purchase-cancel', { coinId }],
      ['spend34', 'action=purchase-recover', { coinId }], ['coin26', 'action=create', S.coinRequest('DEMO')], ['coin26', 'action=preview', S.coinRequest('DEMO')]
    ];
    const results = [];
    for (const [file, query, request] of attempts) {
      forgetFailures(a);
      const r = await call(a, file, 'POST', query, asBody(demo, request));
      results.push([query, r.status, r.json && r.json.code]);
    }
    line(results.every((r) => r[1] === 403 && r[2] === 'bad-token'), 'each is refused as a wrong token', results.filter((r) => r[1] !== 403 || r[2] !== 'bad-token'));
    const units = await S.units(a, S.wallet(), coinId);
    line(units === '0', 'and nothing was granted');
    line((await call(a, 'coin26', 'GET', 'action=list')).json.coins.length === 1, 'and no coin was created');

    console.log('\n== and signing is not needed for the demonstration labs');
    const e21 = await call(a, 'events21', 'POST', 'action=create', { adminToken: demo });
    const e21w = await call(a, 'events21', 'POST', 'action=create', { adminToken: wrong });
    line(e21w.status === 403 && e21.status !== 403, 'events21 takes its own token', [e21.status, e21w.status]);
    const e22 = await call(a, 'events22', 'POST', 'action=offline-create', { adminToken: demo });
    const e22w = await call(a, 'events22', 'POST', 'action=offline-create', { adminToken: wrong });
    line(e22.status === 200 && e22w.status === 403, 'events22 takes its own token', [e22.status, e22w.status]);
    const c23 = await call(a, 'compare23', 'POST', 'action=compare', { adminToken: demo });
    const c23w = await call(a, 'compare23', 'POST', 'action=compare', { adminToken: wrong });
    line(c23w.status === 403 && c23.status !== 403, 'compare23 takes its own token', [c23.status, c23w.status]);
    const f20 = await call(a, 'federation20', 'POST', 'action=send', { adminToken: demo });
    const f20w = await call(a, 'federation20', 'POST', 'action=send', { adminToken: wrong });
    line(f20w.status === 403 && f20.status !== 403, 'federation20 takes its own token', [f20.status, f20w.status]);

    console.log('\n== the chain labs operator token opens none of the demonstration labs');
    if (Date.now() < Date.UTC(2027, 2, 1)) {
      const rs = [];
      for (const [file, query] of [['events21', 'action=create'], ['events22', 'action=offline-create'], ['compare23', 'action=compare'], ['federation20', 'action=send']]) rs.push((await call(a, file, 'POST', query, { adminToken: a.token })).status);
      line(rs.every((s) => s === 403), 'each refuses it', rs);
    }

    forgetFailures(a);
    console.log('\n== the signed path and the token of the compatibility period are not affected');
    line((await signedOp(a, 'integrity', { coinId })).status === 200, 'a signed request is accepted');
    if (Date.now() < Date.UTC(2027, 2, 1)) line((await legacyOp(a, 'integrity', { coinId })).status === 200, 'so is the chain labs operator token, until its date');
  } finally {
    for (const n of Object.values(nodes)) if (n.proc) n.proc.kill('SIGKILL');
    S.cleanup();
  }
  console.log('\n' + (failures === 0 ? 'ALL ' + total + ' CHAIN-LABS TOKEN SEPARATION CHECKS PASSED' : failures + ' of ' + total + ' checks FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.log('ERROR ' + e.stack); S.cleanup(); process.exit(1); });
