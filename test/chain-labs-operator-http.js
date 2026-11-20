// Operator actions of the chain labs against live PHP servers running the real endpoints (spend34.php, coin26.php):
//   - signed requests: bound to the action, the arguments, the domain, the method and the time; the nonce is single use
//   - a request whose answer was lost is answered from the record, in parallel too, and an action is not carried out twice
//   - keys with a list of actions, rotation and revocation, the audit table
//   - the token of the compatibility period, its limit on attempts and its end; the older demo labs' token opens nothing here
//   - activating signed requests only, and public ledger routes that never depend on any of it
//
//   node test/chain-labs-operator-http.js
'use strict';
const fs = require('fs');
const path = require('path');
const S = require('./support/chain-labs-servers');
const { A, B, nodes, start, post, get, call, op, createCoin, signedOp, legacyOp, legacyCreateCoin, writeRoster, wallet, OP } = S;

let failures = 0, total = 0;
const line = (ok, text, detail) => { total++; if (!ok) failures++; console.log((ok ? 'PASS ' : 'FAIL ') + text + (!ok && detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 400) : '')); };
const beforeEnd = Date.now() < Date.UTC(2027, 2, 1);
const units = async (n, w, coinId) => S.units(n, w, coinId);
// Attempts that failed are counted per client address, and every request here comes from the same one; the groups of checks start from none.
const forgetFailures = (n) => require('child_process').execFileSync('php', ['-r', '$d=new PDO("sqlite:".$argv[1]);$d->exec("DELETE FROM operator_failures");', path.join(n.priv, 'chainlabs-operator.sqlite')]);

(async () => {
  await start(nodes[A]);
  await start(nodes[B]);
  const a = nodes[A], b = nodes[B];
  try {
    const alice = wallet(), bob = wallet();
    const coin = (await createCoin(a, 'OPR')).json;
    line(coin && coin.ok === true && typeof coin.id === 'string', 'a coin is created by a signed request', coin);
    const opened = await op(a, 'open', { coinId: coin.id });
    line(opened.status === 200 || opened.status === 201, 'and opened by one', opened.json);

    console.log('\n== a signed treasury grant, and what it is bound to');
    const grant = await signedOp(a, 'grant', { coinId: coin.id, to: alice.key, amount: '1000' });
    line(grant.status === 201 && grant.json.ok === true, 'a grant is made', grant.json);
    line((await units(a, alice, coin.id)) === '1000', 'once');
    const signed = OP.signRequest(a.operator, { domain: A, action: 'spend34/grant', request: { coinId: coin.id, to: alice.key, amount: '10' } });
    const tampered = JSON.parse(JSON.stringify(signed));
    tampered.payload.request.amount = '10000';
    const t1 = await post(a, 'action=grant', tampered);
    line(t1.status === 401 && t1.json.code === 'bad-signature', 'an amount changed after signing is refused', t1.json);
    const beside = OP.signRequest(a.operator, { domain: A, action: 'spend34/grant', request: { coinId: coin.id, to: alice.key, amount: '10' } });
    const sideRes = await post(a, 'action=grant', Object.assign({}, beside, { amount: '5000', to: bob.key, coinId: coin.id }));
    const sideEntry = sideRes.json && sideRes.json.receipt && sideRes.json.receipt.entry;
    line(sideRes.status === 201 && sideEntry && sideEntry.amount === '10' && sideEntry.to === alice.key, 'an argument beside the signed request is not used', sideRes.json);
    const wrongRoute = await post(a, 'action=accept-rollback', signed);
    line(wrongRoute.status === 400 && wrongRoute.json.code === 'wrong-action', 'a grant signature does not work on another action', wrongRoute.json);
    const forB = OP.signRequest(a.operator, { domain: B, action: 'spend34/grant', request: { coinId: coin.id, to: alice.key, amount: '10' } });
    const t2 = await post(a, 'action=grant', forB);
    line(t2.status === 400 && t2.json.code === 'wrong-domain', 'a request signed for the other domain is refused', t2.json);
    const viaOtherHost = await new Promise((resolve) => {
      const http = require('http');
      const body = JSON.stringify(OP.signRequest(a.operator, { domain: B, action: 'spend34/grant', request: { coinId: coin.id, to: alice.key, amount: '10' } }));
      const r = http.request({ host: '127.0.0.1', port: a.port, path: '/spend34.php?action=grant', method: 'POST', headers: { host: B, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => { let t = ''; res.on('data', (d) => (t += d)); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(t) })); });
      r.end(body);
    });
    line(viaOtherHost.status === 400 && viaOtherHost.json.code === 'wrong-domain', 'a Host header naming the other domain does not make it the domain: the roster decides', viaOtherHost.json);
    const getVersion = await get(a, 'action=grant&coinId=' + coin.id);
    line(getVersion.status === 404, 'a GET is not an operator request', getVersion.status);
    const old = OP.signRequest(a.operator, { domain: A, action: 'spend34/grant', request: { coinId: coin.id, to: alice.key, amount: '10' }, at: Date.now() - 90000 });
    const t3 = await post(a, 'action=grant', old);
    line(t3.status === 401 && t3.json.code === 'expired-request', 'a request that has expired is refused', t3.json);
    line((await units(a, alice, coin.id)) === '1010', 'and none of the others moved anything');

    console.log('\n== a lost answer, and the same request again');
    const lost = OP.signRequest(a.operator, { domain: A, action: 'spend34/grant', request: { coinId: coin.id, to: alice.key, amount: '25' } });
    const r1 = await post(a, 'action=grant', lost);
    const r2 = await post(a, 'action=grant', lost);
    line(r1.status === 201 && r2.status === 201 && JSON.stringify(r1.json) === JSON.stringify(r2.json), 'the same signed request sent again gets the same answer', [r1.status, r2.status]);
    line((await units(a, alice, coin.id)) === '1035', 'and the grant was made once');
    const rawPost = (n, body) => new Promise((resolve) => {
      const http = require('http');
      const data = JSON.stringify(body);
      const q = http.request({ host: '127.0.0.1', port: n.port, path: '/spend34.php?action=grant', method: 'POST', headers: { host: n.domain, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => { let t = ''; res.on('data', (d) => (t += d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(t) })); });
      q.end(data);
    });
    const r3 = await rawPost(a, lost);
    line(r3.headers['x-chainlabs-operator-replay'] === '1', 'an answer from the record says so');
    const par = OP.signRequest(a.operator, { domain: A, action: 'spend34/grant', request: { coinId: coin.id, to: alice.key, amount: '3' } });
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => rawPost(a, par)));
    line((await units(a, alice, coin.id)) === '1038', 'eight copies at once make the grant once', outcomes.map((o) => o.status));
    line(outcomes.every((o) => [201, 409].includes(o.status)) && outcomes.some((o) => o.status === 201), 'each is answered with the grant or told it is in progress', outcomes.map((o) => o.status + ':' + (o.json.code || '')));
    const again = OP.signRequest(a.operator, { domain: A, action: 'spend34/grant', request: { coinId: coin.id, to: alice.key, amount: '25' } });
    const dup = await post(a, 'action=grant', again);
    line(dup.status === 409 && dup.json.code === 'duplicate-request', 'the same grant signed afresh a moment later is not made again', dup.json);
    line((await units(a, alice, coin.id)) === '1038', 'nothing was moved');
    const repeated = await signedOp(a, 'grant', { coinId: coin.id, to: alice.key, amount: '25' }, { repeat: true });
    line(repeated.status === 201 && (await units(a, alice, coin.id)) === '1063', 'unless it is signed to be repeated');
    const failedFirst = await signedOp(a, 'grant', { coinId: coin.id, to: alice.key, amount: 'x' });
    const failedAgain = await signedOp(a, 'grant', { coinId: coin.id, to: alice.key, amount: 'x' });
    line(failedFirst.status >= 400 && failedAgain.status >= 400 && failedAgain.json.code !== 'duplicate-request', 'a request that failed does not stand in the way of signing it again', [failedFirst.json, failedAgain.json]);

    console.log('\n== keys with a list of actions, rotation and revocation');
    const studio = OP.newIdentity(), treasury = OP.newIdentity(), spare = OP.newIdentity();
    writeRoster(a, { keys: [
      { publicKey: a.operator.publicKey, label: 'root' },
      { publicKey: studio.publicKey, label: 'studio', actions: ['coin26/create', 'coin26/preview', 'spend34/open', 'spend34/integrity'] },
      { publicKey: treasury.publicKey, label: 'treasury', actions: ['spend34/grant'] }
    ] });
    const s1 = await signedOp(a, 'coin26/create', S.coinRequest('STU'), { as: studio });
    line(s1.status === 200 || s1.status === 201, 'the studio key creates a coin', s1.json);
    const s2 = await signedOp(a, 'open', { coinId: s1.json.id }, { as: studio });
    line(s2.status === 200 || s2.status === 201, 'and opens it', s2.json);
    const s3 = await signedOp(a, 'grant', { coinId: s1.json.id, to: alice.key, amount: '1' }, { as: studio });
    line(s3.status === 403 && s3.json.code === 'action-not-permitted', 'but cannot grant', s3.json);
    const g1 = await signedOp(a, 'grant', { coinId: coin.id, to: bob.key, amount: '5' }, { as: treasury });
    line(g1.status === 201, 'the treasury key grants', g1.json);
    const blocked = [];
    for (const action of ['spend34/open', 'spend34/recover', 'spend34/compare', 'spend34/purchase-recover', 'spend34/purchase-cancel', 'spend34/restore', 'spend34/accept-rollback', 'spend34/reseal', 'spend34/resume', 'spend34/integrity', 'spend34/evidence', 'coin26/create', 'coin26/preview', 'operator/audit', 'operator/activate']) {
      const r = await signedOp(a, action, action === 'coin26/create' || action === 'coin26/preview' ? S.coinRequest('NOPE') : { coinId: coin.id }, { as: treasury });
      if (r.status !== 403 || r.json.code !== 'action-not-permitted') blocked.push([action, r.status, r.json && r.json.code]);
    }
    line(blocked.length === 0, 'it can take no action that is not in its list', blocked);
    const check = await signedOp(a, 'operator/check', {}, { as: treasury });
    line(check.status === 200 && check.json.verified === true, 'but every key can prove itself', check.json);
    line((await signedOp(a, 'grant', { coinId: coin.id, to: bob.key, amount: '1' }, { as: spare })).json.code === 'not-operator', 'a key that is not on the roster is refused');
    writeRoster(a, { keys: [{ publicKey: a.operator.publicKey, label: 'root' }, { publicKey: spare.publicKey, label: 'new root' }] });
    line((await signedOp(a, 'integrity', { coinId: coin.id }, { as: spare })).status === 200, 'a key added to the file works on the next request');
    line((await signedOp(a, 'grant', { coinId: coin.id, to: bob.key, amount: '1' }, { as: treasury })).json.code === 'not-operator', 'and one taken out is refused on it');
    writeRoster(a, { keys: [{ publicKey: a.operator.publicKey, label: 'root', revoked: true }, { publicKey: spare.publicKey, label: 'new root' }] });
    line((await signedOp(a, 'integrity', { coinId: coin.id })).json.code === 'not-operator', 'a key marked revoked is refused');
    writeRoster(a, { keys: [{ publicKey: a.operator.publicKey, label: 'root' }, { publicKey: spare.publicKey, label: 'new root' }] });

    console.log('\n== the audit table');
    const audit = await signedOp(a, 'operator/audit', { limit: 100 });
    const rows = audit.json && audit.json.lines || [];
    line(audit.status === 200 && audit.json.chain.ok === true && rows.length > 10, 'it is read with a signed request and is an intact chain', audit.json && audit.json.chain);
    const grantRows = rows.filter((r) => r.action === 'spend34/grant' && r.event === 'accepted');
    line(grantRows.some((r) => /"amount":"1000"/.test(r.detail || '') && r.detail.includes(alice.key)), 'a grant is there with its recipient and amount');
    const text = JSON.stringify(rows);
    line(!text.includes(a.token) && !text.includes(a.operator.publicKey) && !text.includes('signerRole') && !text.includes('"signature"'), 'and nothing that could be used again');
    line(rows.some((r) => r.event === 'refused' && r.code === 'bad-signature') && rows.some((r) => r.event === 'replay'), 'refused and repeated requests are there too');
    const sqlite = path.join(a.priv, 'chainlabs-operator.sqlite');
    const mode = fs.statSync(sqlite).mode & 0o777;
    line((mode & 0o077) === 0, 'the operator state is a file only its owner reads', mode.toString(8));
    line(!a.root.includes(a.priv) && !fs.existsSync(path.join(a.root, 'chainlabs-operators.json')), 'and it is outside the web root');

    if (beforeEnd) {
      console.log('\n== the token of the compatibility period');
      const l1 = await legacyCreateCoin(a, 'LEG');
      line(l1.status === 200 || l1.status === 201, 'a coin is still created with the token', l1.json);
      const l2 = await legacyOp(a, 'integrity', { coinId: coin.id });
      line(l2.status === 200, 'and an action still takes it', l2.json);
      const l3 = await call(a, 'spend34', 'POST', 'action=integrity', Object.assign(S.OP.legacyBody(a.token, { coinId: coin.id })));
      line(!!l3.raw && l3.status === 200, 'with a note in the answer headers');
      const demo = await post(a, 'action=grant', { adminToken: a.demoToken, coinId: coin.id, to: alice.key, amount: '1' });
      const demoCreate = await call(a, 'coin26', 'POST', 'action=create', Object.assign(S.coinRequest('DEMO'), { adminToken: a.demoToken }));
      const demoOpen = await post(a, 'action=open', { adminToken: a.demoToken, coinId: coin.id });
      line(demo.status === 403 && demoCreate.status === 403 && demoOpen.status === 403, 'the token the older demo labs use grants nothing, creates no coin and opens none', [demo.status, demoCreate.status, demoOpen.status]);
      const demoLab = await call(a, 'federation20', 'POST', 'action=send', { adminToken: a.demoToken });
      const demoLabWrong = await call(a, 'federation20', 'POST', 'action=send', { adminToken: '0'.repeat(64) });
      line(demoLabWrong.status === 403 && demoLab.status !== 403, 'and that lab still takes it', [demoLab.raw, demoLabWrong.raw]);
      const noHash = await signedOp(a, 'integrity', { coinId: coin.id });
      line(noHash.status === 200, 'the signed path is unaffected by any of it');
      writeRoster(a, { legacyTokenSha256: undefined, keys: [{ publicKey: a.operator.publicKey, label: 'root' }, { publicKey: spare.publicKey }] });
      const noToken = await legacyOp(a, 'integrity', { coinId: coin.id });
      line(noToken.status === 403 && noToken.json.code === 'legacy-disabled', 'a roster without the token hash accepts no token', noToken.json);
      writeRoster(a, { keys: [{ publicKey: a.operator.publicKey, label: 'root' }, { publicKey: spare.publicKey }] });
    }

    forgetFailures(a);
    console.log('\n== activating signed requests only');
    const verifyOnly = await signedOp(a, 'operator/activate', { confirm: 'activate-signed-operator' });
    line(verifyOnly.status === 409 && verifyOnly.json.code === 'activation-not-ready', 'a key that was never verified cannot activate', verifyOnly.json);
    const c0 = await signedOp(a, 'operator/check', {});
    line(c0.status === 200 && c0.json.verified === true && c0.json.ratchet === false, 'the key proves itself', c0.json);
    const noConfirm = await signedOp(a, 'operator/activate', { confirm: 'yes' });
    line(noConfirm.status === 400, 'activation needs its confirmation text', noConfirm.json);
    if (beforeEnd) {
      const lg = await legacyOp(a, 'grant', { coinId: coin.id, to: bob.key, amount: '1' });
      line(lg.status === 201, 'until then the token still grants', lg.json);
    }
    const on = await signedOp(a, 'operator/activate', { confirm: 'activate-signed-operator' });
    line(on.status === 200 && on.json.activated === true, 'a verified key activates', on.json);
    const again2 = await signedOp(a, 'operator/activate', { confirm: 'activate-signed-operator' }, { repeat: true });
    line(again2.status === 200 && again2.json.already === true, 'and doing it again changes nothing');
    line(fs.existsSync(path.join(a.priv, 'chainlabs-operator-ratchet.json')), 'it is a file in the private folder');
    if (beforeEnd) {
      const lg2 = await legacyOp(a, 'grant', { coinId: coin.id, to: bob.key, amount: '1' });
      const lg3 = await legacyCreateCoin(a, 'LATE');
      const lg4 = await legacyOp(a, 'open', { coinId: coin.id });
      line([lg2, lg3, lg4].every((r) => r.status === 403 && r.json.code === 'signature-required'), 'after it the token grants nothing, creates nothing and opens nothing', [lg2.json, lg3.json, lg4.json]);
      const lg5 = await legacyOp(a, 'integrity', { coinId: coin.id });
      line(lg5.status === 200, 'it can still look');
      writeRoster(a, { legacyTokenSha256: S.OP.sha256(a.token), keys: [{ publicKey: a.operator.publicKey }], activated: false, legacyUntil: '2099-01-01' });
      const lg6 = await legacyOp(a, 'grant', { coinId: coin.id, to: bob.key, amount: '1' });
      line(lg6.status === 403 && lg6.json.code === 'signature-required', 'and no setting brings it back', lg6.json);
    }
    const sg = await signedOp(a, 'grant', { coinId: coin.id, to: bob.key, amount: '2' });
    line(sg.status === 201, 'signed requests keep working');

    if (beforeEnd) {
      console.log('\n== failed attempts');
      let last = null;
      for (let i = 0; i < 12; i++) last = await legacyOp(a, 'integrity', { coinId: coin.id, adminToken: '1'.repeat(64) }).catch((e) => e);
      const limited = await post(a, 'action=integrity', { adminToken: '2'.repeat(64), coinId: coin.id });
      line(limited.status === 429 || limited.status === 403, 'repeated wrong tokens are turned away');
      const lim2 = await post(a, 'action=integrity', { adminToken: a.token, coinId: coin.id });
      line(lim2.status === 429, 'with the right one too, for a while', lim2.status);
      const keyed = await signedOp(a, 'integrity', { coinId: coin.id });
      line(keyed.status === 200, 'while a signed request still gets through', keyed.json);
    }

    forgetFailures(a);
    console.log('\n== an action that was cut short is not carried out again by accident');
    const toCut = { coinId: coin.id, to: bob.key, amount: '9' };
    const cutSigned = OP.signRequest(a.operator, { domain: A, action: 'spend34/grant', request: toCut });
    const cutFirst = await post(a, 'action=grant', cutSigned);
    const before = await units(a, bob, coin.id);
    require('child_process').execFileSync('php', ['-r', '$d=new PDO("sqlite:".$argv[1]);$q=$d->prepare("UPDATE operator_nonces SET status=\'started\', http_status=NULL, response=NULL WHERE nonce=?");$q->execute([$argv[2]]);', path.join(a.priv, 'chainlabs-operator.sqlite'), cutSigned.payload.adminAuth.nonce]);
    const cutAgain = await post(a, 'action=grant', cutSigned);
    line(cutFirst.status === 201 && cutAgain.status === 409 && cutAgain.json.code === 'in-progress' && cutAgain.json.outcomeUnknown === true && (await units(a, bob, coin.id)) === before, 'the same request sent again is told its outcome is not known, and nothing is granted', cutAgain.json);
    const cutNew = await signedOp(a, 'grant', toCut);
    line(cutNew.status === 409 && cutNew.json.code === 'duplicate-request' && (await units(a, bob, coin.id)) === before, 'signing it afresh is refused as well, even long after', cutNew.json);
    const cutDecided = await signedOp(a, 'grant', toCut, { repeat: true });
    line(cutDecided.status === 201 && (await units(a, bob, coin.id)) === String(BigInt(before) + 9n), 'and it is made once the operator has decided to repeat it');

    console.log('\n== records that cannot be read refuse operator actions and leave the public ledger alone');
    const dbFile = path.join(a.priv, 'chainlabs-operator.sqlite');
    const dbSaved = fs.readFileSync(dbFile);
    fs.writeFileSync(dbFile, Buffer.from('not a database '.repeat(300)));
    const dmg = [await signedOp(a, 'grant', { coinId: coin.id, to: bob.key, amount: '4' }), await signedOp(a, 'integrity', { coinId: coin.id }), await signedOp(a, 'operator/check', {}), await signedOp(a, 'operator/audit', {})];
    line(dmg.every((r) => r.status === 503 && r.json.code === 'operator-state-unavailable'), 'a damaged operator database refuses every operator action', dmg.map((r) => [r.status, r.json && r.json.code]));
    if (beforeEnd) {
      const dmgToken = await legacyOp(a, 'grant', { coinId: coin.id, to: bob.key, amount: '4' });
      line(dmgToken.status === 503, 'and a token', dmgToken.status);
    }
    line((await get(a, 'action=coins')).status === 200 && (await post(a, 'action=holdings', { key: bob.key })).status === 200 && (await units(a, bob, coin.id)) === String(BigInt(before) + 9n), 'while the public routes answer and nothing was granted');
    fs.rmSync(dbFile);
    fs.mkdirSync(dbFile);
    line((await signedOp(a, 'grant', { coinId: coin.id, to: bob.key, amount: '4' })).status === 503, 'a database that cannot be opened refuses too');
    fs.rmdirSync(dbFile);
    fs.writeFileSync(dbFile, dbSaved);
    line((await signedOp(a, 'integrity', { coinId: coin.id })).status === 200, 'putting the records back is all it takes');
    const ratchetFile = path.join(a.priv, 'chainlabs-operator-ratchet.json');
    fs.rmSync(ratchetFile);
    if (beforeEnd) line((await legacyOp(a, 'grant', { coinId: coin.id, to: bob.key, amount: '1' })).json.code === 'signature-required', 'a deleted activation marker does not bring the token back for changing actions');
    fs.writeFileSync(ratchetFile, '{}', { mode: 0o600 });
    fs.rmSync(dbFile);
    if (beforeEnd) line((await legacyOp(a, 'grant', { coinId: coin.id, to: bob.key, amount: '1' })).json.code === 'signature-required', 'nor does a deleted database, while the marker is there');
    line((await signedOp(a, 'integrity', { coinId: coin.id })).status === 200, 'and a signed request starts a new one');
    forgetFailures(a);

    console.log('\n== rotating keys and recovering a lost key leave the ledger as it was');
    const trust = async () => {
      const files = [];
      const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else files.push([path.relative(a.priv, f), require('crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex')]); } };
      for (const n of fs.readdirSync(a.priv)) if (/checkpoints$/.test(n)) walk(path.join(a.priv, n));
      const head = (await get(a, 'action=coin&coin=' + coin.id)).json.head;
      return JSON.stringify({ head, files: files.sort() });
    };
    const trustBefore = await trust();
    line(JSON.parse(trustBefore).files.length > 0, 'the ledger keeps a checkpoint log and journal for the coin');
    const cli = (...args) => require('child_process').spawnSync('php', [path.join(__dirname, '..', 'chain-labs', 'lib', 'operator-cli.php'), ...args, '--private=' + a.priv, '--domain=' + A], { encoding: 'utf8' });
    const next = OP.newIdentity();
    line(cli('add-key', '--key=' + next.publicKey, '--label=replacement').status === 0, 'a replacement key is added from the command line, which needs no signature and touches no ledger file');
    const proved = await signedOp(a, 'operator/check', {}, { as: next });
    line(proved.status === 200 && proved.json.verified === true && proved.json.ratchet === true, 'the new key proves itself while signed requests are still required', proved.json);
    line(cli('revoke', '--key=' + a.operator.publicKey).status === 0 && (await signedOp(a, 'integrity', { coinId: coin.id })).json.code === 'not-operator', 'the old key is revoked and is refused at once');
    const viaNew = await signedOp(a, 'grant', { coinId: coin.id, to: alice.key, amount: '1' }, { as: next });
    line(viaNew.status === 201, 'the new key signs a grant', viaNew.json);
    if (beforeEnd) line((await legacyOp(a, 'grant', { coinId: coin.id, to: alice.key, amount: '1' })).json.code === 'signature-required', 'and nobody can fall back to the token');
    const trustAfterOps = await trust();
    const headBefore = JSON.parse(trustBefore).head, headAfter = JSON.parse(trustAfterOps).head;
    line(headAfter.index === headBefore.index + 1 && JSON.parse(trustAfterOps).files.length >= JSON.parse(trustBefore).files.length, 'the only change to the ledger is the one grant that was signed: its head moved by one entry, and its history was kept', [headBefore, headAfter]);
    const integrity = await signedOp(a, 'integrity', { coinId: coin.id }, { as: next });
    line(integrity.status === 200 && JSON.stringify(integrity.json).includes('"ok":true'), 'and the integrity check of the coin passes', integrity.json);
    const trustQuiet = await trust();
    await signedOp(a, 'operator/check', {}, { as: next });
    await signedOp(a, 'operator/audit', { limit: 5 }, { as: next });
    line((await trust()) === trustQuiet, 'checking a key and reading the audit change nothing in the ledger or its checkpoints');
    const aud = await signedOp(a, 'operator/audit', { limit: 200 }, { as: next });
    line(aud.json.chain.ok === true, 'the audit trail is intact across the change of keys');
    writeRoster(a);

    console.log('\n== public ledger routes never depend on the operator layer');
    fs.unlinkSync(path.join(a.priv, 'chainlabs-operators.json'));
    const cfg = path.join(a.priv, 'federation20-config.php');
    const saved = fs.readFileSync(cfg, 'utf8');
    fs.writeFileSync(cfg, saved.replace(/, 'admin_token_hex' => '[a-f0-9]+'/, ''));
    const coins = await get(a, 'action=coins');
    const holdings = await post(a, 'action=holdings', { key: alice.key });
    const chal = await post(a, 'action=challenge', {});
    const list = await call(a, 'coin26', 'GET', 'action=list');
    line(coins.status === 200 && holdings.status === 200 && chal.status === 200 && list.status === 200, 'with no roster and no token in the configuration they all answer', [coins.status, holdings.status, chal.status, list.status]);
    const none = await signedOp(a, 'integrity', { coinId: coin.id });
    line(none.status === 503 && none.json.code === 'operator-not-configured', 'and an operator action says there is no roster', none.json);
    const noneCreate = await createCoin(a, 'NOROSTER');
    line(noneCreate.status === 503, 'so does the Studio');
    fs.writeFileSync(cfg, saved);
    writeRoster(a);
    line((await signedOp(a, 'integrity', { coinId: coin.id })).status === 200, 'putting the file back is all it takes');
  } finally {
    for (const n of Object.values(nodes)) if (n.proc) n.proc.kill('SIGKILL');
    S.cleanup();
  }
  console.log('\n' + (failures === 0 ? 'ALL ' + total + ' CHAIN-LABS OPERATOR ENDPOINT CHECKS PASSED' : failures + ' of ' + total + ' checks FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.log('ERROR ' + e.stack); S.cleanup(); process.exit(1); });
