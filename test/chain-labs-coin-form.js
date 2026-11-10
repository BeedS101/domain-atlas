// Coin creation endpoint of the chain labs (chain-labs/coin26.php) on a throw-away PHP server:
//   - the authority mode, visibility, partners and threshold a coin is created with
//   - every way a bad choice is refused, with nothing stored
//   - the genesis hash covering those choices
//   - a registry created before these columns existed keeps working
//
//   node test/chain-labs-coin-form.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const DIR = path.join(__dirname, '..', 'chain-labs');
let failures = 0, total = 0;
const line = (ok, text, detail) => { total++; if (!ok) failures++; console.log((ok ? 'PASS ' : 'FAIL ') + text + (!ok && detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 300) : '')); };

const TOKEN = crypto.randomBytes(32).toString('hex');
const A = 'a.example', B = 'b.example', C = 'c.example';

function site(config, legacy) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-labs-coin-'));
  const root = path.join(work, 'public');
  const priv = path.join(work, 'chainblock-labs-private');
  fs.mkdirSync(root);
  fs.mkdirSync(priv);
  fs.copyFileSync(path.join(DIR, 'coin26.php'), path.join(root, 'coin26.php'));
  fs.cpSync(path.join(DIR, 'lib'), path.join(root, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(priv, 'federation20-config.php'), "<?php return ['admin_token_hex' => '" + TOKEN + "'];\n");
  fs.writeFileSync(path.join(priv, 'chainlabs-config.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(work, 'prepend.php'), "<?php $_SERVER['HTTPS'] = 'on';\n");
  if (legacy) {
    const code = '$p=new PDO("sqlite:' + priv + '/coin26.sqlite");$p->exec("CREATE TABLE coins(id TEXT PRIMARY KEY,domain TEXT NOT NULL,name TEXT NOT NULL,symbol TEXT NOT NULL,decimals INTEGER NOT NULL,max_units INTEGER NOT NULL,initial_units INTEGER NOT NULL,treasury_units INTEGER NOT NULL,description TEXT NOT NULL,created_at TEXT NOT NULL,genesis_hash TEXT NOT NULL UNIQUE,UNIQUE(domain,symbol),CHECK(initial_units<=max_units),CHECK(treasury_units=initial_units))");$p->exec("INSERT INTO coins VALUES(\'old1\',\'' + A + '\',\'Old Coin\',\'OLD\',2,100000,5000,5000,\'\',\'2026-01-01T00:00:00Z\',\'' + 'f'.repeat(64) + '\')");';
    spawnSync('php', ['-r', code], { stdio: 'inherit' });
  }
  const port = 21000 + Math.floor(Math.random() * 15000);
  const server = spawn('php', ['-S', '127.0.0.1:' + port, '-t', root, '-d', 'auto_prepend_file=' + path.join(work, 'prepend.php')], { stdio: 'ignore' });
  return { port, server, work, ready: new Promise((r) => setTimeout(r, 800)) };
}
function call(s, method, query, body, opts = {}) {
  return new Promise((resolve) => {
    const host = opts.host || A;
    const headers = { host };
    const data = body === undefined ? null : JSON.stringify(body);
    if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); headers.origin = opts.origin ?? 'https://' + host; }
    const req = http.request({ host: '127.0.0.1', port: s.port, path: '/coin26.php?action=' + query, method, headers }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, json, raw: b }); });
    });
    req.on('error', () => resolve({ status: 0, json: null }));
    if (data) req.write(data);
    req.end();
  });
}
const base = (symbol, extra = {}) => ({ name: 'Coin ' + symbol, symbol, decimals: 2, maxSupply: '1000', initialSupply: '100', description: '', adminToken: TOKEN, ...extra });
const create = (s, symbol, extra, opts) => call(s, 'POST', 'create', base(symbol, extra), opts);
const list = async (s) => (await call(s, 'GET', 'list')).json.coins;
const hashOf = (g) => crypto.createHash('sha256').update(JSON.stringify(g)).digest('hex');

(async () => {
  const s = site({ hosts: [A, B, C], peers: { [A]: B, [B]: A } }, true);
  await s.ready;
  try {
    console.log('== options');
    const o = await call(s, 'GET', 'options');
    line(o.status === 200 && o.json.ok && JSON.stringify(o.json.partners) === JSON.stringify([B]), 'a host offers the domain it exchanges messages with as its partner', o.json);
    const oc = await call(s, 'GET', 'options', undefined, { host: C });
    line(oc.status === 200 && JSON.stringify(oc.json.partners) === '[]', 'a host with no peer offers no partner', oc.json);

    console.log('\n== a registry from before these choices');
    const before = await list(s);
    line(before.length === 1 && before[0].symbol === 'OLD' && before[0].mode === 'single' && before[0].visibility === 'public' && before[0].state === 'registered' && JSON.stringify(before[0].roster) === '[]' && before[0].threshold === 1, 'an older coin reads as single and public', before);

    console.log('\n== creating coins');
    const d = await create(s, 'DEF');
    line(d.status === 201 && d.json.mode === 'single' && d.json.visibility === 'public' && d.json.state === 'registered' && JSON.stringify(d.json.roster) === JSON.stringify([A]) && d.json.threshold === 1, 'with no choice made a coin is single and public', d.json);
    line(hashOf(d.json.genesis) === d.json.genesisHash && d.json.genesis.version === 2 && d.json.genesis.authority === A, 'the genesis hash is the SHA-256 of the genesis, which names the authority', d.json.genesis);
    const priv = await create(s, 'PRV', { mode: 'single', visibility: 'private' });
    line(priv.status === 201 && priv.json.visibility === 'private' && priv.json.state === 'registered', 'a single private coin', priv.json);
    const m = await create(s, 'MUL', { mode: 'multi', partners: [B], threshold: 2 });
    line(m.status === 201 && m.json.mode === 'multi' && m.json.state === 'pending' && JSON.stringify(m.json.roster) === JSON.stringify([A, B]) && m.json.threshold === 2, 'a multi coin is pending with its roster and threshold', m.json);
    const mp = await create(s, 'MPR', { mode: 'multi', visibility: 'private', partners: [B] });
    line(mp.status === 201 && mp.json.threshold === 2 && mp.json.visibility === 'private', 'a multi coin defaults to every domain approving', mp.json);
    for (const c of [d, priv, m, mp]) line(hashOf(c.json.genesis) === c.json.genesisHash, c.json.symbol + ': the genesis hash matches', c.json.genesis);
    const g = m.json.genesis;
    line(g.mode === 'multi' && g.visibility === 'public' && JSON.stringify(g.roster) === JSON.stringify([A, B]) && g.threshold === 2, 'the genesis itself carries the mode, visibility, roster and threshold', g);
    const changed = { ...m.json.genesis, mode: 'single' };
    line(hashOf(changed) !== m.json.genesisHash && hashOf({ ...m.json.genesis, visibility: 'private' }) !== m.json.genesisHash && hashOf({ ...m.json.genesis, threshold: 1 }) !== m.json.genesisHash, 'changing the mode, visibility or threshold changes the hash');
    const coins = await list(s);
    const find = (x) => coins.find((c) => c.symbol === x);
    line(coins.length === 5 && find('MUL').state === 'pending' && find('MUL').mode === 'multi' && find('PRV').visibility === 'private' && find('MPR').threshold === 2 && find('DEF').mode === 'single', 'the list carries the choices of every coin', coins.map((c) => [c.symbol, c.mode, c.visibility, c.state]));

    console.log('\n== where each coin stands on the ledger');
    line(coins.every((c) => c.ledger === 'none'), 'with no ledger yet, every registered coin says it is not open', coins.map((c) => c.ledger));
    const ledgerFile = path.join(s.work, 'chainblock-labs-private', 'chain34.sqlite');
    const seed = "$p=new PDO('sqlite:" + ledgerFile + "');$p->exec('CREATE TABLE ledger_coins(coin_id TEXT PRIMARY KEY, state TEXT)');$q=$p->prepare('INSERT INTO ledger_coins VALUES(?,?)');$q->execute([$argv[1],'active']);$q->execute([$argv[2],'pending']);$q->execute([$argv[3],'frozen']);";
    spawnSync('php', ['-r', seed, '--', find('DEF').id, find('MUL').id, find('PRV').id]);
    const states = Object.fromEntries((await list(s)).map((c) => [c.symbol, c.ledger]));
    line(states.DEF === 'active' && states.MUL === 'pending' && states.PRV === 'frozen' && states.MPR === 'none' && states.OLD === 'none', 'a coin the ledger holds shows the ledger\'s state and the others are not open', states);
    fs.writeFileSync(ledgerFile, 'not a database');
    line((await list(s)).every((c) => c.ledger === 'unknown'), 'a ledger that cannot be read is reported as unavailable, not as empty');
    fs.rmSync(ledgerFile);

    console.log('\n== refused choices');
    const bad = {
      'an unknown mode': { mode: 'triple' },
      'an unknown visibility': { visibility: 'hidden' },
      'a mode of the wrong type': { mode: 1 },
      'a multi coin with no partners': { mode: 'multi' },
      'a multi coin with an empty list': { mode: 'multi', partners: [] },
      'a partner this host does not exchange messages with': { mode: 'multi', partners: [C] },
      'this domain as its own partner': { mode: 'multi', partners: [A] },
      'the same partner twice': { mode: 'multi', partners: [B, B] },
      'partners that are not a list': { mode: 'multi', partners: B },
      'a partner that is not text': { mode: 'multi', partners: [5] },
      'a threshold of 1': { mode: 'multi', partners: [B], threshold: 1 },
      'a threshold above the roster': { mode: 'multi', partners: [B], threshold: 3 },
      'a threshold given as text': { mode: 'multi', partners: [B], threshold: '2' },
      'partners on a single coin': { mode: 'single', partners: [B] },
    };
    let n = 0;
    for (const [name, extra] of Object.entries(bad)) {
      const r = await create(s, 'BAD' + String.fromCharCode(65 + n++), extra);
      line(r.status === 400 && r.json && r.json.ok === false, 'refused: ' + name, r.json);
    }
    const wrongToken = await create(s, 'TKN', { adminToken: '0'.repeat(64) });
    const wrongOrigin = await create(s, 'ORG', {}, { origin: 'https://evil.example' });
    line(wrongToken.status === 403 && wrongOrigin.status === 403, 'a wrong operator token or origin is still refused', [wrongToken.status, wrongOrigin.status]);
    const dup = await create(s, 'DEF', { mode: 'multi', partners: [B] });
    line(dup.status === 409, 'a symbol already registered on the domain is refused', dup.json);
    line((await list(s)).length === 5, 'none of the refused requests stored a coin');
    const noPeer = await create(s, 'NOP', { mode: 'multi', partners: [B] }, { host: C });
    line(noPeer.status === 400, 'a host with no peer cannot create a multi coin', noPeer.json);

    console.log('\n== the page');
    const html = fs.readFileSync(path.join(DIR, 'coin26.html'), 'utf8');
    line(/name="mode"/.test(html) && /name="visibility"/.test(html) && /id="partners"/.test(html) && /id="threshold"/.test(html), 'the form has the mode, visibility, partner and threshold fields');
    line(/body\.partners=/.test(html) && /mode:v\.mode,visibility:v\.visibility/.test(html), 'the form sends the choices');
    line(/not independently checked/.test(html) && /pseudonym/.test(html), 'the form says what a single authority and a private ledger do not give');
  } finally {
    s.server.kill();
    fs.rmSync(s.work, { recursive: true, force: true });
  }
  console.log('\n' + (failures === 0 ? 'ALL ' + total + ' CHAIN-LABS COIN FORM CHECKS PASSED' : failures + ' of ' + total + ' checks FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})();
