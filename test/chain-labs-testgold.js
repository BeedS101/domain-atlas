// The TEST-GOLD faucet and transfer labs (chain-labs/faucet.php, chain-labs/transfer.php) against a live PHP server:
//   - a claim credits 50 units once per key, and a transfer moves units and records them
//   - a transfer for more than the sender holds is refused as a conflict (HTTP 409), never a server error, and leaves both
//     balances as they were, with no transaction left open for the next request
//   - a claim that fails after it started writing is undone completely
//   - the faucet has no supply cap: every new key gets 50 units (documented in chain-labs/README.md)
//
//   node test/chain-labs-testgold.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const DIR = path.join(__dirname, '..', 'chain-labs');
let failures = 0, total = 0;
const line = (ok, text, detail) => { total++; if (!ok) failures++; console.log((ok ? 'PASS ' : 'FAIL ') + text + (!ok && detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 400) : '')); };
const b64u = (b) => Buffer.from(b).toString('base64url');
const canon = (v) => Array.isArray(v) ? '[' + v.map(canon).join(',') + ']' : (v && typeof v === 'object') ? '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}' : JSON.stringify(v);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function wallet() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const key = b64u(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]));
  return { key, sign: (payload, origin) => b64u(crypto.sign('sha256', Buffer.from(canon({ ctx: 'atlas.bridge.sign/1', origin, payload })), { key: privateKey, dsaEncoding: 'ieee-p1363' })) };
}

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-labs-testgold-'));
  const root = path.join(work, 'public');
  const priv = path.join(work, 'chainblock-labs-private');
  fs.mkdirSync(root, { recursive: true });
  for (const f of ['faucet.php', 'transfer.php']) fs.copyFileSync(path.join(DIR, f), path.join(root, f));
  fs.writeFileSync(path.join(work, 'prepend.php'), "<?php $_SERVER['HTTPS'] = 'on';\n");
  fs.mkdirSync(path.join(work, 'sessions'));
  const port = 38000 + Math.floor(Math.random() * 2000);
  const host = '127.0.0.1:' + port;
  const origin = 'https://' + host;
  const logs = [];
  const proc = spawn('php', ['-S', '127.0.0.1:' + port, '-t', root, '-d', 'auto_prepend_file=' + path.join(work, 'prepend.php'), '-d', 'session.save_path=' + path.join(work, 'sessions')], { stdio: ['ignore', 'ignore', 'pipe'] });
  proc.stderr.on('data', (d) => logs.push(d.toString()));
  await sleep(700);

  // One request with its own cookie jar, so the session that holds a challenge stays with the caller.
  const call = (jar, method, urlPath, body) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers: Object.assign({ Host: host, Origin: origin }, jar.cookie ? { Cookie: jar.cookie } : {}, data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => {
        const set = res.headers['set-cookie'];
        if (set) jar.cookie = set.map((c) => c.split(';')[0]).join('; ');
        let json = null;
        try { json = JSON.parse(text); } catch (e) {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
  const claim = async (w) => {
    const jar = {};
    const ch = await call(jar, 'GET', '/faucet.php?action=challenge');
    const sig = w.sign(ch.json.challenge, origin);
    return call(jar, 'POST', '/faucet.php?action=claim', { envelope: { signerRole: 'raw-ecdsa', publicKey: w.key, signature: sig } });
  };
  const send = async (w, to, amount) => {
    const jar = {};
    const ch = await call(jar, 'GET', '/transfer.php?action=challenge&to=' + encodeURIComponent(to) + '&amount=' + amount);
    const sig = w.sign(ch.json.challenge, origin);
    return call(jar, 'POST', '/transfer.php?action=submit', { envelope: { signerRole: 'raw-ecdsa', publicKey: w.key, signature: sig } });
  };
  const balance = async (w) => (await call({}, 'GET', '/faucet.php?action=balance&publicKey=' + w.key)).json.balance;

  try {
    console.log('== claims and transfers');
    const a = wallet(), b = wallet(), c = wallet();
    const first = await claim(a);
    line(first.status === 200 && first.json.claimed === 50 && await balance(a) === 50, 'a claim credits 50 units', [first.status, first.text]);
    const again = await claim(a);
    line(again.status === 200 && again.json.alreadyClaimed === true && await balance(a) === 50, 'a second claim by the same key credits nothing', [again.status, again.text]);
    const ok = await send(a, b.key, 20);
    line(ok.status === 200 && ok.json.amount === 20 && await balance(a) === 30 && await balance(b) === 20, 'a transfer within the balance moves the units', [ok.status, ok.text]);

    console.log('\n== a transfer for more than the sender holds');
    const over = await send(a, b.key, 31);
    line(over.status === 409 && over.json && over.json.error === 'Insufficient TEST-GOLD balance', 'is refused as a conflict with its own message, not as a server error', [over.status, over.text]);
    line(await balance(a) === 30 && await balance(b) === 20, 'and neither balance moves', [await balance(a), await balance(b)]);
    const empty = await send(c, a.key, 1);
    line(empty.status === 409 && await balance(a) === 30, 'a key that holds nothing is refused the same way', [empty.status, empty.text]);
    const next = await send(a, b.key, 10);
    line(next.status === 200 && await balance(a) === 20 && await balance(b) === 30, 'the next transfer after a refusal works: no transaction was left open', [next.status, next.text]);
    const both = await Promise.all([send(b, c.key, 1), send(a, c.key, 1)]);
    line(both.every((r) => r.status === 200) && await balance(c) === 2, 'two transfers at once are not blocked by an earlier refusal', both.map((r) => r.status));

    console.log('\n== a claim that fails after it started writing');
    const failing = wallet();
    const dbFile = path.join(priv, 'chainlabs17.sqlite');
    const sql = (statement) => execFileSync('php', ['-r', '$d=new PDO("sqlite:' + dbFile + '");$d->exec(' + JSON.stringify(statement) + ');']);
    sql("CREATE TRIGGER block_claim BEFORE INSERT ON claims BEGIN SELECT RAISE(ABORT,'blocked'); END;");
    const failed = await claim(failing);
    line(failed.status === 500 && failed.json && failed.json.error === 'Faucet failed; no confirmed credit' && await balance(failing) === 0, 'the claim is refused and nothing is credited', [failed.status, failed.text]);
    sql('DROP TRIGGER block_claim;');
    const retried = await claim(failing);
    line(retried.status === 200 && retried.json.claimed === 50 && await balance(failing) === 50, 'the same key claims normally afterwards: the failed attempt left no lock or half write', [retried.status, retried.text]);

    console.log('\n== the faucet has no supply cap');
    const keys = Array.from({ length: 12 }, () => wallet());
    const results = [];
    for (const w of keys) results.push(await claim(w));
    line(results.every((r) => r.status === 200 && r.json.claimed === 50), 'every new key gets 50 units, however many have claimed (unlimited by design; test units have no value)', results.map((r) => r.status));
    const status = await call({}, 'GET', '/faucet.php?action=status');
    line(status.json && status.json.faucetAmount === 50 && /no monetary value/.test(status.json.warning), 'the status answer says the units have no monetary value', status.json);
    const raised = logs.join('').split('\n').filter((l) => /PHP (Warning|Notice|Deprecated|Fatal error)/.test(l));
    line(raised.length === 0, 'no request raised a PHP warning or notice', raised.slice(0, 3));
  } catch (e) {
    console.log('ERROR ' + e.stack);
    failures++;
  } finally {
    proc.kill();
    fs.rmSync(work, { recursive: true, force: true });
  }
  console.log('\n' + (failures === 0 ? 'ALL ' + total + ' TEST-GOLD CHECKS PASSED' : failures + ' of ' + total + ' checks FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.log('ERROR ' + e.stack); process.exit(1); });
