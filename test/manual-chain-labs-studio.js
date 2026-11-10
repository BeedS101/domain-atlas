// Opening registered coins as ledgers from the Coin Creation Studio (chain-labs/coin26.html), in a real browser against live
// PHP servers: a registered single authority coin and a multi authority coin that needs a second domain, the way an operator
// takes them from "registered" to open, with no coin opened twice and no partner skipped.
//   - the registry lists each coin with where it stands on the ledger, and the scanner has nothing until a coin is opened
//   - opening needs the operator token; a wrong one opens nothing
//   - a single coin opens, once; a second open is refused and no second ledger appears
//   - a multi coin whose partner is down stays pending, and the same button finishes it when the partner is back
//   - a grant gives a wallet key a balance that the holdings lookup and the scanner then show
//
//   xvfb-run -a node test/manual-chain-labs-studio.js
'use strict';
const S = require('./support/chain-labs-servers');
const { A, B, nodes, start, stop, wallet, createCoin, post, scan, get, sleep } = S;
let playwright;
try { playwright = require('playwright'); } catch (e) { playwright = require('/home/claude/.npm-global/lib/node_modules/playwright'); }

let failures = 0, total = 0;
const line = (ok, text, detail) => { total++; if (!ok) failures++; console.log((ok ? 'PASS ' : 'FAIL ') + text + (!ok && detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 400) : '')); };

(async () => {
  for (const n of Object.values(nodes)) await start(n);
  const a = nodes[A], b = nodes[B];
  const browser = await playwright.chromium.launch();
  try {
    // Registered the way the live domain has them: 6 decimals, a maximum of 1,000,000 (10^12 base units) and 10,000 to start.
    const def = { decimals: 6, maxSupply: '1000000', initialSupply: '10000' };
    const goph = (await createCoin(a, 'GOPH', def)).json;
    const osc = (await createCoin(a, 'OSC', { ...def, mode: 'multi', partners: [B], threshold: 2 })).json;
    line(goph.state === 'registered' && osc.state === 'pending', 'setup: the studio registered a single and a multi coin', [goph.state, osc.state]);
    line((await scan(a, 'action=coins')).json.coins.length === 0 && (await get(a, 'action=coins')).json.coins.length === 0, 'registered coins are not on the ledger, so the scanner and the wallet list nothing');

    const context = await browser.newContext();
    await context.route(/^https:\/\/[abc]\.example\/chain-labs\//, async (route) => {
      const u = new URL(route.request().url());
      const n = nodes[u.hostname];
      try {
        const res = await route.fetch({ url: 'http://127.0.0.1:' + n.port + u.pathname.replace(/^\/chain-labs/, '') + u.search, headers: { ...route.request().headers(), host: u.hostname } });
        await route.fulfill({ response: res });
      } catch (e) { await route.abort('connectionrefused'); }
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('https://a.example/chain-labs/coin26.html');
    const card = (symbol) => page.locator('.coin', { hasText: '(' + symbol + ')' });
    await card('GOPH').waitFor();
    const msg = () => page.locator('#opMessage').innerText();
    const settle = async (re) => { await page.waitForFunction((src) => new RegExp(src).test(document.getElementById('opMessage').innerText), re.source, { timeout: 20000 }); return msg(); };

    console.log('== before anything is opened');
    line(/Ledger: not open yet/.test(await card('GOPH').innerText()) && /Ledger: not open yet/.test(await card('OSC').innerText()) && /pending partner signatures/.test(await card('OSC').innerText()), 'each coin says it is not open on the ledger', await card('GOPH').innerText());
    line((await card('GOPH').getByRole('button', { name: 'Open on the ledger' }).count()) === 1, 'and has a button to open it');

    console.log('\n== the operator token');
    await card('GOPH').getByRole('button', { name: 'Open on the ledger' }).click();
    line(/Enter the operator token/.test(await settle(/Could not open/)), 'opening needs the token');
    await page.locator('#opToken').fill('0'.repeat(64));
    await card('GOPH').getByRole('button', { name: 'Open on the ledger' }).click();
    line(/Incorrect operator token/.test(await settle(/Incorrect/)), 'a wrong token is refused');
    line((await get(a, 'action=coins')).json.coins.length === 0 && (await page.locator('#opToken').inputValue()) === '', 'and nothing was opened, and the token field is emptied');

    console.log('\n== a single authority coin');
    await page.locator('#opToken').fill(a.token);
    await card('GOPH').getByRole('button', { name: 'Open on the ledger' }).click();
    const opened = await settle(/GOPH is open on the ledger/);
    line(/Head: entry 0, 1 entry/.test(opened) && /Treasury holds 10000000000 base units/.test(opened), 'it opens, and entry 0 credits the treasury', opened);
    await card('GOPH').getByRole('link', { name: 'View in the scanner' }).waitFor();
    line((await card('GOPH').getByRole('button', { name: /Open on the ledger/ }).count()) === 0 && (await card('GOPH').getByRole('link', { name: 'View in the scanner' }).count()) === 1, 'the button is replaced by a link to the scanner');
    const again = await post(a, 'action=open', { adminToken: a.token, coinId: goph.id });
    line(again.status === 409 && again.json.code === 'already-open', 'opening it again is refused', again.json);
    const sc = (await scan(a, 'action=coins')).json.coins;
    line(sc.length === 1 && sc[0].symbol === 'GOPH' && sc[0].entries === 1 && sc[0].state === 'active', 'the scanner now lists it once, with its genesis entry', sc);
    const sp = (await get(a, 'action=coins')).json.coins;
    line(sp.length === 1 && sp[0].coinId === goph.id, 'and so does the wallet endpoint');

    console.log('\n== a multi authority coin whose partner is down');
    await stop(b);
    await page.locator('#opToken').fill(a.token);
    await card('OSC').getByRole('button', { name: 'Open on the ledger' }).click();
    const down = await settle(/Could not open OSC/);
    line(/did not answer/.test(down), 'the authority cannot open it without the partner, and says why', down);
    await card('OSC').getByRole('button', { name: 'Finish opening on the ledger' }).waitFor();
    line((await card('OSC').getByRole('button', { name: 'Finish opening on the ledger' }).count()) === 1, 'the coin is left waiting for the partner, with a button to finish it');
    line((await scan(a, 'action=coins')).json.coins.length === 1, 'and the scanner does not list it');
    await start(b);
    await sleep(500);
    await page.locator('#opToken').fill(a.token);
    await card('OSC').getByRole('button', { name: 'Finish opening on the ledger' }).click();
    const done = await settle(/OSC is open on the ledger/);
    line(/Every partner domain signed the genesis/.test(done), 'when the partner is back the same button opens it', done);
    for (const n of [a, b]) {
      const r = (await scan(n, 'action=coins')).json.coins.find((x) => x.symbol === 'OSC');
      line(r && r.state === 'active' && r.mode === 'multi' && r.entries === 1, 'OSC is open on ' + n.domain + ' with the same genesis entry', r || (await scan(n, 'action=coins')).raw);
    }
    const ga = (await scan(a, 'action=coin&coin=' + osc.id)).json, gb = (await scan(b, 'action=coin&coin=' + osc.id)).json;
    line(ga.genesisDigest === gb.genesisDigest && ga.head.hash === gb.head.hash && ga.genesis.roster.length === 2 && ga.genesis.threshold === 2, 'both domains hold the same genesis, signed by both');
    const dom = (await scan(a, 'action=domains&coin=' + osc.id)).json;
    line(dom.summary === 'agree', 'and the domains agree', dom.summary);
    const dup = await post(a, 'action=open', { adminToken: a.token, coinId: osc.id });
    line(dup.status === 409 && dup.json.code === 'already-open', 'it cannot be opened a second time', dup.json);

    console.log('\n== a balance a wallet can find');
    const w = wallet();
    await page.locator('#grantCoin').selectOption(goph.id);
    await page.locator('#grantTo').fill(w.key);
    await page.locator('#grantAmount').fill('12.5');
    await page.locator('#opToken').fill(a.token);
    await page.getByRole('button', { name: 'Grant from the treasury' }).click();
    line(/Granted 12\.5 GOPH/.test(await settle(/Granted|Could not grant/)), 'a grant from the treasury is made in the coin\'s own decimals');
    const h = (await post(a, 'action=holdings', { key: w.key })).json;
    const held = h.statement && h.statement.coins.find((c) => c.coinId === goph.id);
    line(held && held.units === '12500000' && held.symbol === 'GOPH', 'the holdings lookup the wallet uses finds it', h);
    const acct = (await scan(a, 'action=account&coin=' + goph.id + '&ref=' + w.key)).json;
    line(acct.ok && acct.units === '12500000', 'and so does the scanner');
    await page.locator('#grantTo').fill(w.key);
    await page.locator('#grantAmount').fill('0.0000001');
    await page.locator('#opToken').fill(a.token);
    await page.getByRole('button', { name: 'Grant from the treasury' }).click();
    line(/at most 6 decimals/.test(await settle(/at most 6/)), 'an amount with more decimals than the coin has is refused before it is sent');
    await page.locator('#grantAmount').fill('1');
    await page.locator('#grantTo').fill('not a key');
    await page.locator('#opToken').fill(a.token);
    await page.getByRole('button', { name: 'Grant from the treasury' }).click();
    line(/Could not grant/.test(await settle(/Could not grant: (?!Enter)/)), 'and a recipient that is not a wallet key is refused by the ledger');
    line((await post(a, 'action=holdings', { key: w.key })).json.statement.coins.find((c) => c.coinId === goph.id).units === '12500000', 'with nothing granted by either');
    line(errors.length === 0, 'the page logged no errors', errors);
  } finally {
    await browser.close();
    S.cleanup();
  }
  console.log('\n' + (failures === 0 ? 'ALL ' + total + ' STUDIO OPENING CHECKS PASSED' : failures + ' of ' + total + ' checks FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.log('ERROR ' + e.stack); S.cleanup(); process.exit(1); });
