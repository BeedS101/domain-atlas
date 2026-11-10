// The scanner of the chain labs (chain-labs/scan35.php and the verifier inside chain-labs/scan35.html) against three live PHP
// servers, one per domain, with public and private coins, single and multi authority, a sale, and a coin that froze:
//   - the routes: coins, coin, entries, entry, account and domains, what each returns and what each refuses
//   - paging: a page is never more than the cap, the next page starts where the last stopped, and bad numbers are refused
//   - private coins: no route and no page carries an account key or the private form of an entry, and a key finds no account
//   - read-only: the routes accept GET only and leave the database untouched
//   - the domains of a coin: level, behind, not answering, frozen and why; cached for a few seconds
//   - the verifier of the page: a good chain verifies, and each kind of damage is found at the entry it is in
//
//   node test/chain-labs-scan-http.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { webcrypto } = crypto;
const S = require('./support/chain-labs-servers');
const { A, B, C, nodes, issuerKey, POLICY, b64u, canon, sleep, wallet, start, stop, get, post, scan, op, createCoin, NOW, iso, transfer, hex, credential } = S;

let failures = 0, total = 0;
const line = (ok, text, detail) => { total++; if (!ok) failures++; console.log((ok ? 'PASS ' : 'FAIL ') + text + (!ok && detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 400) : '')); };
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const clone = (v) => JSON.parse(JSON.stringify(v));

const HTML = fs.readFileSync(path.join(__dirname, '..', 'chain-labs', 'scan35.html'), 'utf8');
const ctx = vm.createContext({ crypto: webcrypto, TextEncoder, atob, console });
vm.runInContext(/<script id="scan-verify">([\s\S]*?)<\/script>/.exec(HTML)[1], ctx);
const V = ctx.ScanVerify;

// Wallet keys are 65-byte points; any such token in a body is an account key.
const keysIn = (text) => (text.match(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{87}(?![A-Za-z0-9_-])/g) || []).filter((x) => { const b = Buffer.from(x, 'base64url'); return b.length === 65 && b[0] === 4; });

const q = (o) => Object.entries(o).map(([k, v]) => k + '=' + v).join('&');
async function entriesOf(n, coinId) {
  const out = [];
  let after = -1;
  for (;;) {
    const r = (await scan(n, q({ action: 'entries', coin: coinId, after, limit: 100 }))).json;
    out.push(...r.entries);
    if (!r.more) return out;
    after = r.next;
  }
}
// Everything the scanner shows about a coin, as raw response bodies: the lists, each entry, each account and the domains.
async function crawl(n, coinId) {
  const bodies = [];
  const take = async (query) => { const r = await scan(n, query); bodies.push(r.raw); return r.json; };
  await take('action=coins');
  await take('action=coin&coin=' + coinId);
  const items = [];
  let after = -1;
  for (;;) {
    const r = await take(q({ action: 'entries', coin: coinId, after, limit: 100 }));
    items.push(...r.entries);
    if (!r.more) break;
    after = r.next;
  }
  const refs = new Set();
  for (const it of items) {
    await take('action=entry&coin=' + coinId + '&index=' + it.entry.index);
    for (const r of [it.entry.from, it.entry.to]) if (r) refs.add(r);
  }
  for (const ref of refs) await take(q({ action: 'account', coin: coinId, ref }));
  await take('action=domains&coin=' + coinId);
  return { bodies, items, refs: [...refs] };
}
const dbBytes = (n) => ['', '-wal', '-shm'].map((e) => { try { return sha(fs.readFileSync(path.join(n.priv, 'chain34.sqlite') + e).toString('latin1')); } catch (err) { return '-'; } }).join(':');
const sql = (n, text, params = []) => execFileSync('php', ['-r', "$d=new PDO('sqlite:" + path.join(n.priv, 'chain34.sqlite') + "');$s=$d->prepare($argv[1]);$s->execute(array_slice($argv,2));echo json_encode($s->columnCount()?$s->fetchAll(PDO::FETCH_ASSOC):[]);", '--', text, ...params], { encoding: 'utf8' });

function intent(w, coinId, cred, price, requestId) {
  const payload = { type: 'atlas.ledger.purchase.intent', v: 1, coinId, credentialId: cred.id, price, recipient: w.key, requestId, expiresAt: iso(NOW() + 300) };
  return { payload, signature: w.sign(payload) };
}
async function buy(n, w, coinId, quantity, price) {
  const cred = credential(quantity, w);
  return post(n, 'action=purchase', { coinId, intent: intent(w, coinId, cred, price, hex(16)), credential: cred });
}
const clearCache = (n, coinId) => fs.rmSync(path.join(n.priv, 'scan35-heads-' + coinId + '.json'), { force: true });

(async () => {
  console.log('== the page');
  const scripts = HTML.match(/<script\b/g).length === HTML.match(/<\/script>/g).length;
  const appCode = /<script id="scan-app">([\s\S]*?)<\/script>/.exec(HTML)[1];
  line(scripts && !/\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function)/.test(HTML), 'the page never parses server text as HTML and runs no dynamic code');
  line(!/\bsrc=|<link\b|@import|url\(/.test(HTML.replace(/<!--[\s\S]*?-->/g, '')), 'and loads nothing from anywhere');
  line((appCode.match(/fetch\(/g) || []).length === 1 && /fetch\('\.\/scan35\.php\?action='/.test(appCode), 'it reads only from its own scanner route');
  const ids = [...HTML.matchAll(/'#\/coin\//g)].length;
  line(ids > 5 && /v\.startsWith\('#\/'\)/.test(appCode), 'a link is only ever a hash link', ids);

  for (const n of Object.values(nodes)) await start(n);
  const a = nodes[A], b = nodes[B], c = nodes[C];
  try {
    const alice = wallet(), bob = wallet(), carol = wallet();
    const pub = (await createCoin(a, 'PUB')).json, prv = (await createCoin(a, 'PRV', { visibility: 'private' })).json;
    const mpub = (await createCoin(a, 'MPUB', { mode: 'multi', partners: [B, C], threshold: 2 })).json;
    const mprv = (await createCoin(a, 'MPRV', { mode: 'multi', partners: [B, C], visibility: 'private' })).json;
    const evd = (await createCoin(a, 'EVD')).json;
    const none = (await createCoin(a, 'NON')).json;
    for (const [coin, purchase] of [[pub, POLICY], [prv, POLICY], [mpub], [mprv], [evd]]) {
      const r = await op(a, 'open', purchase ? { coinId: coin.id, purchase } : { coinId: coin.id });
      if (r.status !== 201) line(false, 'setup: a coin opens', r.json);
    }
    line((await scan(a, 'action=coin&coin=' + none.id)).status === 404, 'a registered coin that was never opened has no page');

    // 105 grants to a public coin take its log past one page of 100; the others get a few transfers.
    for (let i = 0; i < 105; i++) {
      const r = await op(a, 'grant', { coinId: pub.id, to: i % 2 ? alice.key : bob.key, amount: '1' });
      if (r.status !== 201) { line(false, 'setup: a grant is recorded', r.json); break; }
    }
    for (const coin of [prv, mpub, mprv]) {
      await op(a, 'grant', { coinId: coin.id, to: alice.key, amount: '500' });
      await op(a, 'grant', { coinId: coin.id, to: bob.key, amount: '300' });
      const t1 = await post(a, 'action=propose', { authorization: await transfer(alice, a, coin.id, carol.key, '40') });
      const t2 = await post(a, 'action=propose', { authorization: await transfer(bob, a, coin.id, alice.key, '15') });
      if (t1.status !== 201 || t2.status !== 201) line(false, 'setup: a transfer is recorded', [t1.json, t2.json]);
    }
    const sale = await buy(a, carol, pub.id, 100, 20);
    const saleP = await buy(a, carol, prv.id, 100, 10);
    line(sale.status === 201 && saleP.status === 201, 'setup: a sale on a public and on a private coin', [sale.json, saleP.json]);
    for (const n of [b, c]) for (const coin of [mpub, mprv]) await get(n, 'action=coin&coin=' + coin.id);

    console.log('\n== the coins');
    const list = (await scan(a, 'action=coins')).json;
    const by = Object.fromEntries(list.coins.map((x) => [x.symbol, x]));
    line(list.ok && list.domain === A && list.coins.length === 5 && !by.NON, 'the list holds the open coins of this domain', list);
    line(by.PUB.visibility === 'public' && by.PRV.visibility === 'private' && by.MPUB.mode === 'multi' && by.PUB.mode === 'single' && by.PUB.state === 'active' && by.PUB.entries === 107 && by.PUB.authority === A, 'each with its visibility, authority mode, state and number of entries', by.PUB);
    line(JSON.stringify(Object.keys(list)) === JSON.stringify(['ok', 'domain', 'coins']) && !/domainKey|admin|private_pem/.test(JSON.stringify(list)), 'and nothing else about the domain');
    const pc = (await scan(a, 'action=coin&coin=' + pub.id)).json;
    line(pc.ok && pc.state === 'active' && pc.head.index === 106 && pc.entries === 107 && pc.supply === pc.genesis.initialUnits && pc.pageMax === 100 && pc.evidence.length === 0, 'a coin shows its genesis, state, supply, head and entry count', pc);
    line(sha(canon(pc.genesis)) === pc.genesisDigest, 'the genesis digest is the digest of the genesis shown');
    line(pc.treasury && pc.treasury.ref === pc.genesis.treasuryRef && pc.treasury.units === '99695', 'the treasury shows its balance', pc.treasury);
    line(pc.genesis.purchase && pc.genesis.purchase.unitsPerPrice === 10, 'and the terms it is sold on');
    const mc = (await scan(a, 'action=coin&coin=' + mpub.id)).json;
    line(mc.genesis.mode === 'multi' && mc.genesis.threshold === 2 && mc.genesis.roster.length === 3 && mc.genesis.authority === A, 'a multi authority coin shows its roster, threshold and authority');
    const mcb = (await scan(b, 'action=coin&coin=' + mpub.id)).json;
    line(mcb.ok && mcb.head.hash === mc.head.hash && mcb.genesisDigest === mc.genesisDigest, 'a partner shows the same coin');
    for (const bad of ['action=coin&coin=xyz', 'action=coin', 'action=coin&coin=' + '0'.repeat(32), 'action=nothing', '']) {
      const r = await scan(a, bad);
      line((r.status === 400 || r.status === 404) && r.json && r.json.ok === false, 'refused: ' + (bad || 'no action'), [r.status, r.json]);
    }
    line((await scan(a, 'action=coin&coin=' + '0'.repeat(32))).json.code === 'unknown-coin', 'an unknown coin is named as one');

    console.log('\n== entries and paging');
    const p1 = (await scan(a, q({ action: 'entries', coin: pub.id, after: -1, limit: 3 }))).json;
    line(p1.entries.length === 3 && p1.entries[0].entry.index === 0 && p1.entries[0].entry.type === 'genesis' && p1.next === 2 && p1.more === true && p1.head.index === 106, 'the first page starts at the genesis and says there is more', p1);
    const p2 = (await scan(a, q({ action: 'entries', coin: pub.id, after: p1.next, limit: 3 }))).json;
    line(p2.entries.map((x) => x.entry.index).join() === '3,4,5' && p2.entries[0].entry.prevHash === p1.entries[2].hash, 'the next page starts where the last stopped and extends it');
    const tail = (await scan(a, q({ action: 'entries', coin: pub.id, after: 105, limit: 25 }))).json;
    line(tail.entries.length === 1 && tail.more === false && tail.next === 106, 'the last page says there is no more', tail);
    const big = (await scan(a, q({ action: 'entries', coin: pub.id, after: -1, limit: 999 }))).json;
    line(big.entries.length === 100 && big.more === true && big.next === 99, 'a page is never more than 100 entries, however many are asked for', big.entries.length);
    const one = (await scan(a, q({ action: 'entries', coin: pub.id, after: -1, limit: 0 }))).json;
    line(one.entries.length === 1, 'and a page of none is a page of one');
    line((await entriesOf(a, pub.id)).length === 107, 'following the pages reaches every entry once');
    const def = (await scan(a, 'action=entries&coin=' + pub.id)).json;
    line(def.entries.length === 25 && def.entries[0].entry.index === 0, 'without numbers a page is the first 25');
    const past = (await scan(a, q({ action: 'entries', coin: pub.id, after: 500, limit: 25 }))).json;
    line(past.ok && past.entries.length === 0 && past.more === false && past.next === null, 'a page past the end is empty');
    for (const bad of [{ after: 'x' }, { after: '1.5' }, { limit: '-1' }, { limit: '1000' }, { after: '9999999999' }, { limit: 'a' }]) {
      const r = await scan(a, q({ action: 'entries', coin: pub.id, ...bad }));
      line(r.status === 400, 'refused: a page with ' + JSON.stringify(bad), r.json);
    }
    line((await scan(a, q({ action: 'entries', coin: pub.id, after: -5, limit: 2 }))).json.entries[0].entry.index === 0, 'an after before the start begins at the start');
    const e0 = p1.entries[0];
    line(e0.hash === sha(canon(e0.entry)) && e0.authoritySignature && Array.isArray(e0.approvals), 'an entry carries its hash, the authority signature and the approvals');
    const one5 = (await scan(a, 'action=entry&coin=' + pub.id + '&index=5')).json;
    line(one5.ok && one5.entry.index === 5 && one5.hash === p2.entries[2].hash && one5.head.index === 106, 'one entry by its number', one5);
    const gone = await scan(a, 'action=entry&coin=' + pub.id + '&index=107');
    line(gone.status === 404 && gone.json.code === 'unknown-entry', 'an entry past the end is a 404', gone.json);
    for (const bad of ['index=-1', 'index=abc', 'index=', 'index=99999999999']) line((await scan(a, 'action=entry&coin=' + pub.id + '&' + bad)).status === 400, 'refused: ' + bad);
    const saleEntry = (await entriesOf(a, pub.id)).find((x) => x.entry.purchase);
    line(saleEntry && saleEntry.entry.purchase.price === 20 && saleEntry.entry.amount === '200' && /^[a-f0-9]{32,64}$/.test(saleEntry.entry.purchase.requestId), 'a sale shows what was paid and the request, in the public form', saleEntry);

    console.log('\n== accounts');
    const al = (await scan(a, q({ action: 'account', coin: pub.id, ref: alice.key, limit: 100 }))).json;
    line(al.ok && al.visibility === 'public' && al.units === '52' && al.entries.length === 52 && al.more === false && al.symbol === 'PUB', 'a public coin\'s account is found by its key', { units: al.units, n: al.entries && al.entries.length });
    line(al.entries.every((x, i) => x.pos === i && x.entry && x.entry.to === alice.key && x.hash === sha(canon(x.entry))), 'its history is in order, each with the entry and its hash');
    const ap = (await scan(a, q({ action: 'account', coin: pub.id, ref: alice.key, after: 9, limit: 10 }))).json;
    line(ap.entries.length === 10 && ap.entries[0].pos === 10 && ap.more === true, 'an account\'s history is paged too', ap.entries.map((x) => x.pos));
    const apLast = (await scan(a, q({ action: 'account', coin: pub.id, ref: alice.key, after: 41, limit: 10 }))).json;
    line(apLast.entries.length === 10 && apLast.more === false, 'and says when it ends');
    const tr = (await scan(a, 'action=account&coin=' + pub.id + '&ref=' + pc.genesis.treasuryRef)).json;
    line(tr.ok && tr.treasury === true && tr.units === pc.treasury.units && al.treasury === false, 'the treasury is marked as such');
    line((await scan(a, 'action=account&coin=' + pub.id + '&ref=' + carol.key)).json.units === '200', 'a buyer holds what was sold');
    const miss = await scan(a, 'action=account&coin=' + pub.id + '&ref=' + wallet().key);
    line(miss.status === 404 && miss.json.code === 'unknown-account', 'an account that does not exist is a 404', miss.json);
    for (const bad of ['ref=short', 'ref=' + 'a'.repeat(300), 'ref=a%20b%20c%20d%20e%20f%20g%20h%20i', 'ref=']) line((await scan(a, 'action=account&coin=' + pub.id + '&' + bad)).status === 400, 'refused: an account named ' + bad.slice(0, 30));

    console.log('\n== private coins show no key');
    for (const [name, coin, node] of [['single', prv, a], ['multi', mprv, a], ['multi on a partner', mprv, b]]) {
      const crawled = await crawl(node, coin.id);
      const all = crawled.bodies.join('\n');
      line(crawled.items.length >= 5 && crawled.refs.length >= 4, 'a private ' + name + ' coin was crawled: every list, entry and account', [crawled.items.length, crawled.refs.length]);
      line(keysIn(all).length === 0, 'no account key in any of ' + crawled.bodies.length + ' answers', keysIn(all));
      const known = [alice.key, bob.key, carol.key];
      line(known.every((k) => !all.includes(k)), 'and none of the keys that are known to hold units');
      const treasuryKey = JSON.parse(sql(a, 'SELECT treasury_key FROM ledger_coins WHERE coin_id=?', [coin.id]))[0].treasury_key;
      line(!all.includes(treasuryKey), 'nor the treasury\'s key');
      const leaks = (all.replace(/"refSecretHash"/g, '').match(/"authorization"|"nonce"|"baseSeq"|"baseHead"|"credential\w*"|"intent"|"refSecret"|ref_secret|"private":/g) || []);
      line(leaks.length === 0, 'nor the private form of an entry, an authorization, a credential or the reference secret', leaks);
      line(crawled.refs.every((r) => /^[A-Za-z0-9_-]{43}$/.test(r)), 'every account is a 43 character reference', crawled.refs.filter((r) => r.length !== 43));
    }
    for (const k of [alice.key, bob.key]) {
      const r = await scan(a, 'action=account&coin=' + prv.id + '&ref=' + k);
      line(r.status === 404, 'a key finds no account in a private coin');
    }
    const ref = (await entriesOf(a, prv.id)).find((x) => x.entry.type === 'transfer').entry.to;
    const pa = (await scan(a, 'action=account&coin=' + prv.id + '&ref=' + ref)).json;
    line(pa.ok && pa.visibility === 'private' && pa.ref === ref && /^\d+$/.test(pa.units) && pa.entries.length >= 1, 'an account is reached by its reference', pa);
    const pcoin = (await scan(a, 'action=coin&coin=' + prv.id)).json;
    line(pcoin.genesis.visibility === 'private' && pcoin.genesis.treasuryRef.length === 43 && pcoin.treasury.ref === pcoin.genesis.treasuryRef, 'the treasury of a private coin is a reference too');
    const pubCrawl = await crawl(a, pub.id);
    const found = new Set(keysIn(pubCrawl.bodies.join('\n')));
    line(found.has(alice.key) && found.has(bob.key) && found.has(carol.key), 'and the same check sees the keys of a public coin', [...found].length);

    console.log('\n== read only');
    const before = dbBytes(a);
    for (const coin of [pub, prv, mpub, mprv]) await crawl(a, coin.id);
    clearCache(a, mpub.id);
    line(dbBytes(a) === before, 'reading everything leaves the database as it was');
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const r = await S.call(a, 'scan35', method, 'action=coins', method === 'POST' ? {} : undefined);
      line(r.status === 405 && r.json.ok === false, method + ' is refused', [r.status, r.raw.slice(0, 80)]);
    }
    const noHttps = await new Promise((resolve) => {
      require('http').get({ host: '127.0.0.1', port: a.port, path: '/scan35.php?action=coins', headers: { host: 'other.example' } }, (res) => { let t = ''; res.on('data', (d) => (t += d)); res.on('end', () => resolve([res.statusCode, t])); });
    });
    line(noHttps[0] === 400, 'a host that is not a lab domain is refused', noHttps);
    const src = fs.readFileSync(path.join(__dirname, '..', 'chain-labs', 'scan35.php'), 'utf8');
    line(/mode=ro/.test(src) && !/ledger_open\(|ledger_commit\(|ledger_freeze\(|ledger_register\(|exec\('(INSERT|UPDATE|DELETE)/i.test(src), 'the ledger is opened read-only and no write function is called');

    console.log('\n== the domains of a coin');
    clearCache(a, mpub.id);
    const d1 = (await scan(a, 'action=domains&coin=' + mpub.id)).json;
    line(d1.ok && d1.summary === 'agree' && d1.domains.length === 3 && d1.cached === false && d1.domains.map((x) => x.status).sort().join() === 'equal,equal,self', 'three domains at the same head agree', d1);
    line(d1.domains[0].domain === A && d1.domains[0].authority === true && d1.domains.every((x) => x.head && x.head.payload.hash === d1.head.hash && x.head.payload.index === d1.head.index), 'each states the same head, and the authority is marked');
    const checked = [];
    for (const row of d1.domains) checked.push(await V.verifyHead(mc.genesis, row.head));
    line(checked.every((x) => x.ok), 'and every statement verifies against the roster keys in the genesis', checked);
    const d2 = (await scan(a, 'action=domains&coin=' + mpub.id)).json;
    line(d2.cached === true && d2.checkedAt === d1.checkedAt, 'the answer is kept for a few seconds, so the page cannot be used to hammer the other domains');
    await post(a, 'action=propose', { authorization: await transfer(alice, a, mpub.id, bob.key, '1') });
    const d3 = (await scan(a, 'action=domains&coin=' + mpub.id)).json;
    line(d3.cached === false && d3.head.index === d1.head.index + 1, 'a new entry ends the wait');
    const sp = (await scan(a, 'action=domains&coin=' + pub.id)).json;
    line(sp.summary === 'single' && sp.domains.length === 1 && sp.domains[0].status === 'self', 'a coin with one domain has nothing to compare', sp);
    const fromB = (await scan(b, 'action=domains&coin=' + mpub.id)).json;
    line(fromB.ok && fromB.domains.find((x) => x.self).domain === B && fromB.domains.every((x) => x.head), 'a partner shows the same view from its side', fromB.domains.map((x) => x.status));
    const bad = await scan(a, 'action=domains&coin=' + '0'.repeat(32));
    line(bad.status === 404, 'domains of an unknown coin is a 404');

    // C is down while an entry is made with A and B, then B is behind after it was down.
    await stop(c);
    clearCache(a, mpub.id);
    const dDown = (await scan(a, 'action=domains&coin=' + mpub.id)).json;
    const stC = dDown.domains.find((x) => x.domain === C);
    line(dDown.summary === 'incomplete' && stC.status === 'unreachable' && stC.head === null, 'a domain that does not answer is shown as such, and the summary says it could not compare', dDown);
    await post(a, 'action=propose', { authorization: await transfer(alice, a, mpub.id, bob.key, '2') });
    await start(c);
    clearCache(a, mpub.id);
    const dBehind = (await scan(a, 'action=domains&coin=' + mpub.id)).json;
    const stC2 = dBehind.domains.find((x) => x.domain === C);
    line(stC2.status === 'behind' && dBehind.summary === 'lagging' && stC2.head.payload.index < dBehind.head.index, 'a domain that has not caught up is behind, on this chain', dBehind.domains.map((x) => x.status + ':' + (x.head && x.head.payload.index)));
    const vb = await V.verifyHead(mc.genesis, stC2.head);
    line(vb.ok, 'and its older statement still verifies');
    const forgedHead = clone(stC2.head);
    forgedHead.payload.hash = '0'.repeat(64);
    line(!(await V.verifyHead(mc.genesis, forgedHead)).ok, 'a statement changed after it was signed does not');

    console.log('\n== a coin that is not open yet');
    const pnd = (await createCoin(a, 'PND')).json;
    await op(a, 'open', { coinId: pnd.id });
    sql(a, "UPDATE ledger_coins SET state='pending' WHERE coin_id=?", [pnd.id]);
    const pndRef = JSON.parse(sql(a, 'SELECT ref FROM ledger_accounts WHERE coin_id=?', [pnd.id]))[0].ref;
    const pending = [];
    for (const query of ['action=coin&coin=', 'action=entries&coin=', 'action=entry&index=0&coin=', 'action=domains&coin=', 'action=account&ref=' + pndRef + '&coin=']) pending.push((await scan(a, query + pnd.id)).status);
    line(pending.every((x) => x === 404), 'a coin that waits for signatures has no page', pending);
    line(!(await scan(a, 'action=coins')).json.coins.some((x) => x.symbol === 'PND'), 'and is not in the list');

    console.log('\n== domains that disagree');
    const frk = (await createCoin(a, 'FRK', { mode: 'multi', partners: [B, C], threshold: 2 })).json;
    await op(a, 'open', { coinId: frk.id });
    await op(a, 'grant', { coinId: frk.id, to: alice.key, amount: '100' });
    for (const n of [b, c]) await get(n, 'action=coin&coin=' + frk.id);
    sql(b, 'UPDATE ledger_log SET hash=? WHERE coin_id=? AND idx=1', ['f'.repeat(64), frk.id]);
    clearCache(a, frk.id);
    const fk = (await scan(a, 'action=domains&coin=' + frk.id)).json;
    const rowB = fk.domains.find((x) => x.domain === B), rowC = fk.domains.find((x) => x.domain === C);
    line(fk.summary === 'fork' && rowB.status === 'fork' && rowC.status === 'equal', 'a domain that holds another entry at the same place is a fork, and the summary says so', fk.domains.map((x) => x.status));
    const fkGenesis = (await scan(a, 'action=coin&coin=' + frk.id)).json.genesis;
    const fkCheck = await V.verifyHead(fkGenesis, rowB.head);
    line(!fkCheck.ok && fkCheck.reason === 'the entry does not have that hash' && (await V.verifyHead(fkGenesis, rowC.head)).ok, 'and the page can see that the statement does not match its own entry');
    sql(b, 'UPDATE ledger_log SET hash=prev_hash WHERE coin_id=? AND idx=1', [frk.id]);

    console.log('\n== a frozen coin says so and why');
    const mir = (await createCoin(a, 'MIR', { mode: 'multi', partners: [B, C], threshold: 2 })).json;
    await op(a, 'open', { coinId: mir.id });
    await op(a, 'grant', { coinId: mir.id, to: alice.key, amount: '1000' });
    await post(a, 'action=propose', { authorization: await transfer(alice, a, mir.id, bob.key, '10') });
    for (const n of [b, c]) await get(n, 'action=coin&coin=' + mir.id);
    const work = path.dirname(a.dir);
    const copyDb = (from, to) => { for (const ext of ['', '-wal', '-shm']) { try { fs.rmSync(to + ext, { force: true }); fs.copyFileSync(from + ext, to + ext); } catch (e) {} } };
    const dbFile = path.join(a.priv, 'chain34.sqlite'), backup = path.join(work, 'backup-a.sqlite');
    await stop(a);
    copyDb(dbFile, backup);
    await start(a);
    await post(a, 'action=propose', { authorization: await transfer(alice, a, mir.id, bob.key, '11') });
    await post(a, 'action=propose', { authorization: await transfer(alice, a, mir.id, bob.key, '12') });
    for (const n of [b, c]) await get(n, 'action=coin&coin=' + mir.id);
    await stop(a);
    copyDb(backup, dbFile);
    await start(a);
    await sleep(1500);
    const found2 = await op(b, 'compare', { coinId: mir.id });
    line(found2.json.state === 'frozen', 'setup: a partner froze the coin on a rolled-back authority', found2.json);
    for (const n of [a, b, c]) {
      const fz = (await scan(n, 'action=coin&coin=' + mir.id)).json;
      const ev = fz.evidence && fz.evidence[0];
      line(fz.state === 'frozen' && ev && ev.detail.kind === 'rollback' && ev.detail.items.length === 2, 'on ' + n.domain + ' the coin is frozen and the evidence is shown', fz.evidence);
    }
    const fzB = (await scan(b, 'action=coin&coin=' + mir.id)).json;
    const evOk = [];
    for (const item of fzB.evidence[0].detail.items) evOk.push(await V.verifyHead(fzB.genesis, item));
    line(evOk.every((x) => x.ok), 'and the two statements that prove it verify against the roster keys', evOk);
    line((await scan(b, 'action=coins')).json.coins.find((x) => x.symbol === 'MIR').state === 'frozen' && (await scan(b, q({ action: 'entries', coin: mir.id, after: -1, limit: 25 }))).json.entries.length === 5, 'its history stays readable');
    clearCache(a, mir.id);
    const fromA = (await scan(a, 'action=domains&coin=' + mir.id)).json;
    line(fromA.domains.filter((x) => !x.self).every((x) => x.status === 'ahead') && fromA.summary === 'lagging', 'the authority, restored from a backup, sees the others holding more than it does', fromA.domains.map((x) => x.status));
    clearCache(b, mir.id);
    const dz = (await scan(b, 'action=domains&coin=' + mir.id)).json;
    line(dz.ok && dz.state === 'frozen' && dz.domains.every((x) => x.state === 'frozen' || x.status === 'unreachable'), 'the domains page reports the freeze', dz.domains.map((x) => x.status + ':' + x.state));

    // The answer for a coin is kept a few seconds, but not past its time and not past a change of state.
    clearCache(a, evd.id);
    const c1 = (await scan(a, 'action=domains&coin=' + evd.id)).json, c2 = (await scan(a, 'action=domains&coin=' + evd.id)).json;
    const cacheFile = path.join(a.priv, 'scan35-heads-' + evd.id + '.json');
    const doc = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    line(c1.cached === false && c2.cached === true && doc.at > 0, 'the answer for a coin is kept after it is made');
    doc.at -= 100;
    fs.writeFileSync(cacheFile, JSON.stringify(doc));
    line((await scan(a, 'action=domains&coin=' + evd.id)).json.cached === false, 'and made again when it is older than a few seconds');
    doc.at = Math.floor(Date.now() / 1000) + 1000;
    fs.writeFileSync(cacheFile, JSON.stringify(doc));
    line((await scan(a, 'action=domains&coin=' + evd.id)).json.cached === false, 'or dated in the future');
    await scan(a, 'action=domains&coin=' + evd.id);
    sql(a, "UPDATE ledger_coins SET state='frozen' WHERE coin_id=?", [evd.id]);
    const c3 = (await scan(a, 'action=domains&coin=' + evd.id)).json;
    line(c3.cached === false && c3.state === 'frozen', 'and made again when the coin changes state', c3);
    sql(a, "UPDATE ledger_coins SET state='active' WHERE coin_id=?", [evd.id]);

    // Evidence of an invalid history holds an entry's private form: only the index and the reason may be shown.
    sql(a, "UPDATE ledger_coins SET state='frozen' WHERE coin_id=?", [evd.id]);
    sql(a, 'INSERT INTO ledger_evidence(coin_id,kind,detail_json,created_at) VALUES(?,?,?,?)', [evd.id, 'invalid-history', JSON.stringify({ index: 7, reason: 'bad-approval', message: 'an approval does not verify', record: { private: { from: 'SECRETKEYONE', to: 'SECRETKEYTWO', authorization: { signature: 'SECRETSIG' } } } }), '1']);
    sql(a, 'INSERT INTO ledger_evidence(coin_id,kind,detail_json,created_at) VALUES(?,?,?,?)', [evd.id, 'operator', JSON.stringify({ note: 'SECRETNOTE' }), '2']);
    const att = (i) => ({ payload: { type: 'atlas.ledger.head', v: 1, coinId: evd.id, domain: A, index: i, hash: 'a'.repeat(64), issuedAt: '2026-01-01T00:00:00Z' }, signature: 'x', authoritySignature: 'y', public: { index: i }, hash: 'a'.repeat(64), SECRETEXTRA: 'one', record: 'SECRETREC' });
    sql(a, 'INSERT INTO ledger_evidence(coin_id,kind,detail_json,created_at) VALUES(?,?,?,?)', [evd.id, 'fork', JSON.stringify({ items: [att(1), att(1), att(1), att(1)], SECRETDETAIL: 'two' }), '3']);
    const ev = await scan(a, 'action=coin&coin=' + evd.id);
    const forkEv = ev.json.evidence.find((x) => x.detail.kind === 'fork');
    line(forkEv && forkEv.detail.items.length === 2 && Object.keys(forkEv.detail.items[0]).sort().join() === 'authoritySignature,hash,payload,public,signature' && !/SECRET/.test(ev.raw), 'evidence of a disagreement shows two signed statements and nothing else', forkEv);
    line(ev.json.evidence.length === 3 && ev.json.evidence[0].detail.kind === 'invalid-history' && ev.json.evidence[0].detail.index === 7 && ev.json.evidence[0].detail.reason === 'bad-approval', 'a record of invalid history shows the entry and the reason', ev.json.evidence);
    line(!/SECRET/.test(ev.raw), 'and nothing of the private form, or of an operator\'s note');

    console.log('\n== the verifier of the page');
    const fullChain = async (n, coin) => {
      const info = (await scan(n, 'action=coin&coin=' + coin.id)).json;
      return { info, items: await entriesOf(n, coin.id) };
    };
    const run = (info, items, upTo, tweak) => V.verifyChain({
      genesis: info.genesis, genesisDigest: info.genesisDigest, upTo: upTo === undefined ? items.length - 1 : upTo,
      fetchPage: async (after) => { const rest = items.filter((x) => x.entry.index > after).slice(0, 100); return { entries: rest, next: rest.length ? rest[rest.length - 1].entry.index : null }; }, ...(tweak || {})
    });
    for (const [name, coin] of [['public single', pub], ['private single', prv], ['public multi', mpub], ['private multi', mprv]]) {
      const { info, items } = await fullChain(a, coin);
      const res = await run(info, items);
      line(res.ok && res.checked === items.length && res.lastHash === info.head.hash, 'the whole log of a ' + name + ' coin verifies (' + items.length + ' entries)', res);
    }
    const live = await fullChain(a, pub);
    const half = await run(live.info, live.items, 9);
    line(half.ok && half.checked === 10, 'verifying to an entry checks that entry and everything before it only', half);
    let progress = 0;
    await run(live.info, live.items, undefined, { onProgress: () => { progress++; } });
    line(progress === 2, 'a long log is read a page at a time and reports its progress', progress);
    const stopped = await run(live.info, live.items, undefined, { isCancelled: () => true });
    line(stopped.cancelled === true && stopped.ok === false, 'and can be cancelled');

    const mutate = async (name, base, change, index, check, upTo) => {
      const items = clone(base.items), info = clone(base.info);
      change(items, info);
      const res = await run(info, items, upTo);
      line(!res.ok && res.problem && res.problem.index === index && res.problem.check === check, 'damage found: ' + name + ' (entry ' + index + ', ' + check + ')', res);
    };
    const resign = (item) => { item.hash = sha(canon(item.entry)); };
    await mutate('an amount changed', live, (it) => { it[7].entry.amount = '9'; }, 7, 'hash');
    await mutate('an amount changed and the hash made to match', live, (it) => { it[7].entry.amount = '9'; resign(it[7]); }, 7, 'authority-signature');
    await mutate('an amount changed and every hash after it made to match', live, (it) => { for (let i = 7; i < it.length; i++) { if (i === 7) it[i].entry.amount = '9'; if (i > 7) it[i].entry.prevHash = it[i - 1].hash; resign(it[i]); if (i < it.length - 1) it[i + 1].entry.prevHash = it[i].hash; } }, 7, 'authority-signature');
    await mutate('a recipient changed', live, (it) => { it[3].entry.to = carol.key; }, 3, 'hash');
    await mutate('an entry removed', live, (it) => { it.splice(4, 1); }, 4, 'index');
    await mutate('two entries swapped', live, (it) => { [it[4], it[5]] = [it[5], it[4]]; }, 4, 'index');
    await mutate('an entry repeated', live, (it) => { it.splice(5, 0, clone(it[4])); }, 5, 'index');
    await mutate('another entry\'s signature', live, (it) => { it[6].authoritySignature = it[5].authoritySignature; }, 6, 'authority-signature');
    await mutate('no signature', live, (it) => { it[6].authoritySignature = ''; }, 6, 'authority-signature');
    await mutate('a signature from a stranger', live, (it) => {
      const k = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      it[6].authoritySignature = b64u(crypto.sign('sha256', Buffer.from(it[6].hash), k.privateKey));
    }, 6, 'authority-signature');
    await mutate('an entry of another coin', live, (it) => { it[2].entry.coinId = mpub.id; resign(it[2]); }, 2, 'coin');
    await mutate('the genesis changed', live, (it, info) => { info.genesis.name = 'Forged'; }, null, 'genesis-digest');
    await mutate('the genesis entry credits someone else', live, (it) => { it[0].entry.to = alice.key; resign(it[0]); }, 0, 'authority-signature');
    await mutate('a genesis signature removed', live, (it) => { it[0].approvals = []; }, 0, 'genesis-signature');
    await mutate('a transfer called a genesis', live, (it) => { it[1].entry.type = 'genesis'; resign(it[1]); }, 1, 'authority-signature');
    await mutate('the log cut short', live, (it) => { it.length = 20; }, 20, 'missing', 25);
    const multi = await fullChain(a, mpub);
    const dm = multi.items.findIndex((x) => x.entry.type === 'transfer');
    await mutate('an approval removed from a multi authority entry', multi, (it) => { it[dm].approvals = []; }, dm, 'threshold');
    await mutate('an approval from a stranger', multi, (it) => { it[dm].approvals = [{ domain: 'd.example', signature: it[dm].approvals[0].signature }]; }, dm, 'approval');
    await mutate('the same approval twice', multi, (it) => { it[dm].approvals = [it[dm].approvals[0], it[dm].approvals[0]]; }, dm, 'approval');
    await mutate('an approval of another entry', multi, (it) => { it[dm + 1].approvals = it[dm].approvals; }, dm + 1, 'approval');
    await mutate('the authority counted as its own approver', multi, (it) => { it[dm].approvals = [{ domain: A, signature: it[dm].authoritySignature }]; }, dm, 'approval');
    await mutate('a missing approvals list', multi, (it) => { delete it[dm].approvals; }, dm, 'approvals');
    // A chain built here with keys the test holds, so entries can be damaged and still carry real signatures.
    const dom = (name) => { const k = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }); return { name, key: k.publicKey.export({ type: 'spki', format: 'pem' }), sign: (text) => b64u(crypto.sign('sha256', Buffer.from(text), k.privateKey)) }; };
    const synth = (count, threshold) => {
      const ds = ['x.example', 'y.example', 'z.example'].slice(0, count).map(dom);
      const genesis = { type: 'atlas.ledger.genesis', v: 1, coinId: 'ab'.repeat(16), symbol: 'SYN', name: 'Synthetic', decimals: 0, maxUnits: '1000', initialUnits: '100', mode: count > 1 ? 'multi' : 'single', visibility: 'public',
        authority: ds[0].name, threshold, roster: ds.map((d) => ({ domain: d.name, key: d.key })), faucet: null, createdAt: '2026-01-01T00:00:00Z', treasuryRef: 'T'.repeat(87) };
      const digest = sha(canon(genesis));
      const sign = (d, text) => d.sign(text);
      const entry0 = { type: 'genesis', coinId: genesis.coinId, index: 0, prevHash: digest, executedAt: genesis.createdAt, amount: '100', from: null, to: genesis.treasuryRef };
      const items = [{ entry: entry0, hash: sha(canon(entry0)), approvals: ds.map((d) => ({ domain: d.name, signature: sign(d, digest) })) }];
      items[0].authoritySignature = sign(ds[0], items[0].hash);
      const add = (over, signers) => {
        const prev = items[items.length - 1];
        const entry = { type: 'transfer', coinId: genesis.coinId, index: items.length, prevHash: prev.hash, executedAt: '2026-01-01T00:00:0' + items.length + 'Z', amount: '5', from: genesis.treasuryRef, to: 'U'.repeat(87), ...over };
        const hash = sha(canon(entry));
        const ap = canon({ type: 'atlas.ledger.entry.approval', v: 1, coinId: genesis.coinId, index: entry.index, hash });
        items.push({ entry, hash, authoritySignature: sign(ds[0], hash), approvals: (signers || ds.slice(1)).map((d) => ({ domain: d.name, signature: sign(d, ap) })) });
        return items[items.length - 1];
      };
      return { ds, genesis, digest, items, add, info: { genesis, genesisDigest: digest } };
    };
    const sy = synth(3, 2);
    sy.add({}); sy.add({}, [sy.ds[1]]); sy.add({}, [sy.ds[2]]);
    const syRes = await run(sy.info, sy.items);
    line(syRes.ok && syRes.checked === 4, 'a chain built with known keys verifies, with every entry approved by two or three of three', syRes);
    const synthBad = async (name, change, check, index) => {
      const t = synth(3, 2);
      t.add({}); t.add({});
      change(t);
      const res = await run(t.info, t.items);
      line(!res.ok && res.problem.check === check && res.problem.index === index, 'damage found, though the signatures are real: ' + name + ' (entry ' + index + ', ' + check + ')', res);
    };
    const resignWith = (t, i, over) => {
      const it = t.items[i];
      Object.assign(it.entry, over);
      it.hash = sha(canon(it.entry));
      it.authoritySignature = t.ds[0].sign(it.hash);
      const ap = canon({ type: 'atlas.ledger.entry.approval', v: 1, coinId: t.genesis.coinId, index: i, hash: it.hash });
      it.approvals = t.ds.slice(1).map((d) => ({ domain: d.name, signature: d.sign(ap) }));
    };
    await synthBad('the genesis entry credits more', (t) => resignWith(t, 0, { amount: '101' }), 'genesis-entry', 0);
    await synthBad('the genesis entry credits someone else', (t) => resignWith(t, 0, { to: 'V'.repeat(87) }), 'genesis-entry', 0);
    await synthBad('the genesis entry is dated otherwise', (t) => resignWith(t, 0, { executedAt: '2026-02-02T00:00:00Z' }), 'genesis-entry', 0);
    await synthBad('the genesis entry has a sender', (t) => resignWith(t, 0, { from: 'W'.repeat(87) }), 'genesis-entry', 0);
    await synthBad('the genesis entry is a transfer', (t) => resignWith(t, 0, { type: 'transfer' }), 'genesis-entry', 0);
    await synthBad('a genesis signature is missing for one domain', (t) => { t.items[0].approvals.pop(); }, 'genesis-signature', 0);
    await synthBad('a domain signs the genesis twice', (t) => { t.items[0].approvals[2] = t.items[0].approvals[1]; }, 'genesis-signature', 0);
    await synthBad('a domain signs the genesis a second time besides the rest', (t) => { t.items[0].approvals.push(t.items[0].approvals[2]); }, 'genesis-signature', 0);
    await synthBad('a domain outside the roster signs the genesis', (t) => { t.items[0].approvals[2].domain = 'q.example'; }, 'genesis-signature', 0);
    await synthBad('a genesis signature over something else', (t) => { t.items[0].approvals[2].signature = t.ds[2].sign('x'); }, 'genesis-signature', 0);
    await synthBad('a later entry called a genesis', (t) => resignWith(t, 1, { type: 'genesis' }), 'type', 1);
    await synthBad('an entry whose number is wrong', (t) => resignWith(t, 1, { index: 5 }), 'index', 1);
    await synthBad('an entry that does not extend the one before', (t) => resignWith(t, 2, { prevHash: 'f'.repeat(64) }), 'prev-hash', 2);
    await synthBad('too few approvals for the threshold', (t) => { t.items[1].approvals = []; }, 'threshold', 1);
    await synthBad('an approval by the authority itself', (t) => { t.items[1].approvals = [{ domain: t.ds[0].name, signature: t.items[1].authoritySignature }]; }, 'approval', 1);
    await synthBad('an approval signed by another domain\'s key', (t) => { t.items[1].approvals[0].signature = t.items[1].approvals[1].signature; }, 'approval', 1);
    await synthBad('an approval that does not name the coin', (t) => { t.items[1].approvals[0].signature = t.ds[1].sign(canon({ type: 'atlas.ledger.entry.approval', v: 1, coinId: 'cd'.repeat(16), index: 1, hash: t.items[1].hash })); }, 'approval', 1);
    await synthBad('an approval with the wrong version', (t) => { t.items[1].approvals[0].signature = t.ds[1].sign(canon({ type: 'atlas.ledger.entry.approval', v: 2, coinId: t.genesis.coinId, index: 1, hash: t.items[1].hash })); }, 'approval', 1);
    await synthBad('an approval that is not an object', (t) => { t.items[1].approvals = ['x']; }, 'approval', 1);
    const solo = synth(1, 1);
    solo.add({}, []);
    line((await run(solo.info, solo.items)).ok, 'a single authority entry needs no approvals besides the authority\'s');
    const two = synth(2, 2);
    two.add({}, []);
    const twoRes = await run(two.info, two.items);
    line(!twoRes.ok && twoRes.problem.check === 'threshold', 'but a two of two coin does', twoRes.problem);
    const wrongAuthority = synth(2, 2);
    wrongAuthority.add({});
    wrongAuthority.info.genesis.authority = 'y.example';
    line(!(await V.verifyChain({ genesis: wrongAuthority.info.genesis, genesisDigest: wrongAuthority.digest, upTo: 1, fetchPage: async () => ({ entries: wrongAuthority.items }) })).ok, 'a genesis that names another authority does not match its digest, or its signatures');
    const headSy = (d, over) => { const payload = { type: 'atlas.ledger.head', v: 1, coinId: sy.genesis.coinId, domain: d.name, index: 3, hash: sy.items[3].hash, issuedAt: '2026-01-01T00:00:09Z', ...over }; return { payload, signature: d.sign(canon(payload)), authoritySignature: sy.items[3].authoritySignature, public: sy.items[3].entry }; };
    line((await V.verifyHead(sy.genesis, headSy(sy.ds[1]))).ok, 'a head statement from a roster domain verifies, with the entry it names');
    const headBad = [
      ['a domain outside the roster', { ...headSy(sy.ds[1]), payload: { ...headSy(sy.ds[1]).payload, domain: 'q.example' } }],
      ['another coin', headSy(sy.ds[1], { coinId: 'cd'.repeat(16) })],
      ['a negative index', headSy(sy.ds[1], { index: -1 })],
      ['a hash that is not a hash', headSy(sy.ds[1], { hash: 'zz' })],
      ['another version', headSy(sy.ds[1], { v: 2 })],
      ['an extra field', headSy(sy.ds[1], { extra: 1 })],
      ['another domain\'s signature', { ...headSy(sy.ds[1]), signature: headSy(sy.ds[2]).signature }],
      ['an entry that does not have the hash', { ...headSy(sy.ds[1]), public: sy.items[2].entry }],
      ['an authority signature on another entry', { ...headSy(sy.ds[1]), authoritySignature: sy.items[2].authoritySignature }],
      ['no payload', { signature: 'x' }]
    ];
    const bare = (over, d) => { const h = headSy(d || sy.ds[1], over); delete h.public; delete h.authoritySignature; return h; };
    line((await V.verifyHead(sy.genesis, bare())).ok, 'a head statement without the entry is checked by its signature alone');
    line(!(await V.verifyHead(sy.genesis, bare({ hash: 'zz' }))).ok && !(await V.verifyHead(sy.genesis, bare({ hash: 'A'.repeat(64) }))).ok && !(await V.verifyHead(sy.genesis, bare({ index: 1.5 }))).ok, 'and a hash that is not a hash is refused');
    line(!(await V.verifyHead(sy.genesis, bare({ domain: 'q.example' }))).ok, 'and so is a domain outside the roster');
    const lie = headSy(sy.ds[1], { index: 2, hash: sy.items[3].hash });
    line(!(await V.verifyHead(sy.genesis, lie)).ok, 'an entry with another number than the statement says is refused');
    const wrongSig = { public: sy.items[3].entry, hash: sy.items[3].hash, authoritySignature: sy.items[2].authoritySignature };
    line(!(await V.verifySignedEntry(sy.genesis, wrongSig)).ok && !(await V.verifySignedEntry(sy.genesis, { ...wrongSig, authoritySignature: undefined })).ok && !(await V.verifySignedEntry(sy.genesis, null)).ok, 'an entry carrying another entry\'s signature, or none, is not one the authority signed');
    const goodDer = crypto.sign('sha256', Buffer.from('x'), crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey);
    line(V.derToRaw(new Uint8Array(goodDer)) !== null && V.derToRaw(new Uint8Array([...goodDer, 0])) === null && V.derToRaw(new Uint8Array([...goodDer.subarray(0, goodDer.length - 1), 0, 0])) === null, 'a signature with bytes after it, or with a changed length, is refused');
    const goodPem = sy.ds[0].key;
    const spkiBytes = Buffer.from(goodPem.replace(/-----[A-Z ]+-----|\s/g, ''), 'base64');
    spkiBytes[8] ^= 1;
    const oddPem = '-----BEGIN PUBLIC KEY-----\n' + spkiBytes.toString('base64') + '\n-----END PUBLIC KEY-----\n';
    line(V.spkiOfPem(goodPem) && V.spkiOfPem(goodPem).length === 91 && V.spkiOfPem(oddPem) === null && V.spkiOfPem('x') === null && V.spkiOfPem(goodPem.replace('BEGIN', 'BEGAN')) === null, 'a key that is not a P-256 public key is refused');
    for (const [name, head] of headBad) line(!(await V.verifyHead(sy.genesis, head)).ok, 'a head statement does not verify: ' + name);

    line(!(await V.verifyHead(live.info.genesis, { payload: { ...pc.head, type: 'x' }, signature: 'x' })).ok, 'a head statement of the wrong shape does not verify');
    const flat = await V.verifySignedEntry(live.info.genesis, { public: live.items[3].entry, hash: live.items[3].hash, authoritySignature: live.items[3].authoritySignature });
    line(flat.ok && !(await V.verifySignedEntry(live.info.genesis, { public: { ...live.items[3].entry, amount: '8' }, hash: live.items[3].hash, authoritySignature: live.items[3].authoritySignature })).ok, 'an entry the authority signed verifies, and the same entry changed does not');
    line((await V.fingerprint(live.info.genesis.roster[0].key)).length === 16 && V.derToRaw(new Uint8Array([1, 2, 3])) === null, 'a key has a short fingerprint and a damaged signature is refused');
  } finally {
    S.cleanup();
  }
  console.log('\n' + (failures === 0 ? 'ALL ' + total + ' CHAIN-LABS SCANNER CHECKS PASSED' : failures + ' of ' + total + ' checks FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.log('ERROR ' + e.stack); S.cleanup(); process.exit(1); });
