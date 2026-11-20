// Opening registered coins as ledgers from the Coin Creation Studio (chain-labs/coin26.html), in a real browser against live
// PHP servers: a registered single authority coin and a multi authority coin that needs a second domain, the way an operator
// takes them from "registered" to open, with no coin opened twice and no partner skipped.
//   - the registry lists each coin with where it stands on the ledger, and the scanner has nothing until a coin is opened
//   - opening needs an operator key chosen from a file in the page; a key that is not on the roster opens nothing, and the private key is
//     never sent, stored or left in the page
//   - until 1 March 2027 the legacy token still works
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
    const sent = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { if (r.method() === 'POST') sent.push(r.postData() || ''); });
    const keyFile = (identity) => ({ name: 'operator.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(identity)) });
    const loadKey = async (identity) => { await page.setInputFiles('#keyFile', keyFile(identity)); await page.waitForFunction(() => /^(Key loaded|Could not use)/.test(document.getElementById('keyState').innerText)); return page.locator('#keyState').innerText(); };
    await page.goto('https://a.example/chain-labs/coin26.html');
    const card = (symbol) => page.locator('.coin', { hasText: '(' + symbol + ')' });
    await card('GOPH').waitFor();
    const msg = () => page.locator('#opMessage').innerText();
    const grant = async () => { await page.evaluate(() => { document.getElementById('opMessage').textContent = ''; }); await page.getByRole('button', { name: 'Grant from the treasury' }).click(); };
    const settle = async (re) => { await page.waitForFunction((src) => new RegExp(src).test(document.getElementById('opMessage').innerText), re.source, { timeout: 20000 }); return msg(); };

    console.log('== before anything is opened');
    line(/Ledger: not open yet/.test(await card('GOPH').innerText()) && /Ledger: not open yet/.test(await card('OSC').innerText()) && /pending partner signatures/.test(await card('OSC').innerText()), 'each coin says it is not open on the ledger', await card('GOPH').innerText());
    line((await card('GOPH').getByRole('button', { name: 'Open on the ledger' }).count()) === 1, 'and has a button to open it');

    console.log('\n== the operator key');
    await card('GOPH').getByRole('button', { name: 'Open on the ledger' }).click();
    line(/Load an operator key first/.test(await settle(/Could not open/)), 'opening needs a key');
    const stranger = S.OP.newIdentity();
    line(/^Key loaded: [a-f0-9]{16}/.test(await loadKey(stranger)), 'a key file is read in the page and its fingerprint shown');
    await card('GOPH').getByRole('button', { name: 'Open on the ledger' }).click();
    line(/not an operator key of this domain/.test(await settle(/not an operator key/)), 'a key that is not on the roster is refused');
    line((await get(a, 'action=coins')).json.coins.length === 0 && (await page.locator('#keyFile').inputValue()) === '', 'nothing was opened, and the file chooser is emptied');
    line(!(await page.locator('#keyKeep').isChecked()) && /No key loaded/.test(await page.locator('#keyState').innerText()), 'by default the key is forgotten after every action, a refused one included');
    await page.getByRole('button', { name: 'Forget the key' }).click();
    line(/No key loaded/.test(await page.locator('#keyState').innerText()), 'the key can be forgotten');
    await page.setInputFiles('#keyFile', { name: 'x.json', mimeType: 'application/json', buffer: Buffer.from('{"publicKey":"x"}') });
    await page.waitForFunction(() => /Could not use/.test(document.getElementById('keyState').innerText));
    line(true, 'a file that is not a key is refused');
    const limited = S.OP.newIdentity();
    S.writeRoster(a, { keys: [{ publicKey: a.operator.publicKey, label: 'root' }, { publicKey: limited.publicKey, label: 'studio only', actions: ['spend34/open', 'spend34/grant', 'coin26/create', 'coin26/preview'] }] });
    await page.locator('#keyKeep').check();
    line(/five minutes/.test(await loadKey(a.operator)), 'the five minute choice is the user\'s, and says so');
    await page.getByRole('button', { name: 'Check this key' }).click();
    await page.waitForFunction(() => /has proved itself/.test(document.getElementById('keyState').innerText));
    line(/on the roster as root.*Actions: all.*not activated yet/.test(await page.locator('#keyState').innerText()), 'a key can prove itself, and the page says what it may do and whether signed requests are required');

    console.log('\n== a single authority coin');
    await card('GOPH').getByRole('button', { name: 'Open on the ledger' }).click();
    const opened = await settle(/GOPH is open on the ledger/);
    line(/Head: entry 0, 1 entry/.test(opened) && /Treasury holds 10000000000 base units/.test(opened), 'it opens, and entry 0 credits the treasury', opened);
    await card('GOPH').getByRole('link', { name: 'View in the scanner' }).waitFor();
    line((await card('GOPH').getByRole('button', { name: /Open on the ledger/ }).count()) === 0 && (await card('GOPH').getByRole('link', { name: 'View in the scanner' }).count()) === 1, 'the button is replaced by a link to the scanner');
    const again = await S.signedOp(a, 'open', { coinId: goph.id }, { repeat: true });
    line(again.status === 409 && again.json.code === 'already-open', 'opening it again is refused', again.json);
    const sc = (await scan(a, 'action=coins')).json.coins;
    line(sc.length === 1 && sc[0].symbol === 'GOPH' && sc[0].entries === 1 && sc[0].state === 'active', 'the scanner now lists it once, with its genesis entry', sc);
    const sp = (await get(a, 'action=coins')).json.coins;
    line(sp.length === 1 && sp[0].coinId === goph.id, 'and so does the wallet endpoint');

    console.log('\n== a multi authority coin whose partner is down');
    await stop(b);
    await card('OSC').getByRole('button', { name: 'Open on the ledger' }).click();
    const down = await settle(/Could not open OSC/);
    line(/did not answer/.test(down), 'the authority cannot open it without the partner, and says why', down);
    await card('OSC').getByRole('button', { name: 'Finish opening on the ledger' }).waitFor();
    line((await card('OSC').getByRole('button', { name: 'Finish opening on the ledger' }).count()) === 1, 'the coin is left waiting for the partner, with a button to finish it');
    line((await scan(a, 'action=coins')).json.coins.length === 1, 'and the scanner does not list it');
    await start(b);
    await sleep(500);
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
    const dup = await S.signedOp(a, 'open', { coinId: osc.id }, { repeat: true });
    line(dup.status === 409 && dup.json.code === 'already-open', 'it cannot be opened a second time', dup.json);

    console.log('\n== a balance a wallet can find');
    const w = wallet();
    await page.locator('#grantCoin').selectOption(goph.id);
    await page.locator('#grantTo').fill(w.key);
    await page.locator('#grantAmount').fill('12.5');
    await page.getByRole('button', { name: 'Grant from the treasury' }).click();
    line(/Granted 12\.5 GOPH/.test(await settle(/Granted|Could not grant/)), 'a grant from the treasury is made in the coin\'s own decimals');
    const h = (await post(a, 'action=holdings', { key: w.key })).json;
    const held = h.statement && h.statement.coins.find((c) => c.coinId === goph.id);
    line(held && held.units === '12500000' && held.symbol === 'GOPH', 'the holdings lookup the wallet uses finds it', h);
    const acct = (await scan(a, 'action=account&coin=' + goph.id + '&ref=' + w.key)).json;
    line(acct.ok && acct.units === '12500000', 'and so does the scanner');
    await page.locator('#grantTo').fill(w.key);
    await page.locator('#grantAmount').fill('0.0000001');
    await page.getByRole('button', { name: 'Grant from the treasury' }).click();
    line(/at most 6 decimals/.test(await settle(/at most 6/)), 'an amount with more decimals than the coin has is refused before it is sent');
    await page.locator('#grantAmount').fill('1');
    await page.locator('#grantTo').fill('not a key');
    await page.getByRole('button', { name: 'Grant from the treasury' }).click();
    line(/Could not grant/.test(await settle(/Could not grant: (?!Enter)/)), 'and a recipient that is not a wallet key is refused by the ledger');
    line((await post(a, 'action=holdings', { key: w.key })).json.statement.coins.find((c) => c.coinId === goph.id).units === '12500000', 'with nothing granted by either');
    console.log('\n== what the page did with the key');
    const d = a.operator.privateKeyJwk.d;
    line(sent.length > 5 && sent.every((b) => !b.includes(d) && !b.includes('privateKeyJwk')), 'no request carried the private key', sent.length);
    const stored = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage), document.cookie]));
    line(!stored.includes(d) && stored.length < 40, 'it is in no browser storage and no cookie', stored.slice(0, 80));
    line(!(await page.content()).includes(d), 'and not in the page');
    const sigs = sent.map((b) => { try { return JSON.parse(b); } catch (e) { return null; } }).filter((b) => b && b.payload);
    line(sigs.length > 5 && sigs.every((b) => b.payload.adminAuth.domain === 'a.example' && b.payload.adminAuth.method === 'POST' && [a.operator.publicKey, stranger.publicKey].includes(b.proof.publicKey)), 'every request was signed for this domain and method by a key the page was given', sigs.length);

    console.log('\n== the default: the key is used once');
    await page.locator('#grantTo').fill(w.key);
    await page.locator('#grantAmount').fill('1');
    await page.locator('#keyKeep').uncheck();
    await grant();
    const once = await settle(/Granted|Could not grant/);
    line(/Granted 1 GOPH/.test(once) && /No key loaded/.test(await page.locator('#keyState').innerText()), 'the key is forgotten after the action', [once, await page.locator('#keyState').innerText()]);
    await grant();
    line(/Load an operator key first/.test(await settle(/Could not grant/)), 'and the next action needs it again');
    await loadKey(limited);
    await grant();
    const dupMsg = await settle(/Could not grant/);
    line(/duplicate-request/.test(dupMsg), 'an identical grant a moment later is refused as a duplicate, not made twice', dupMsg);
    await loadKey(limited);
    await page.locator('#opRepeat').check();
    await grant();
    line(/Granted 1 GOPH/.test(await settle(/Granted 1 GOPH/)) && !(await page.locator('#opRepeat').isChecked()), 'it is made when signed to be repeated, and that choice is not kept');
    await loadKey(limited);
    await page.getByRole('button', { name: 'Check this key' }).click();
    await page.waitForFunction(() => /studio only/.test(document.getElementById('keyState').innerText));
    const checked = await page.locator('#keyState').innerText();
    line(/Actions: spend34\/open, spend34\/grant, coin26\/create, coin26\/preview/.test(checked) && /forgotten after use/.test(checked), 'a limited key shows its actions, and is forgotten after the check too');

    console.log('\n== the legacy token, until its date');
    if (Date.now() < Date.UTC(2027, 2, 1)) {
      await page.getByRole('button', { name: 'Forget the key' }).click();
      await page.locator('#legacyBox summary').click();
      await page.locator('#opToken').fill('0'.repeat(64));
      await grant();
      line(/Incorrect operator token/.test(await settle(/Incorrect|Could not grant/)) && (await page.locator('#opToken').inputValue()) === '', 'a wrong token is refused, and the field is emptied');
      await page.locator('#opToken').fill(a.token);
      await page.locator('#opRepeat').check();
      await grant();
      const legacyMsg = await settle(/Granted 1 GOPH|Could not grant/);
      line(/Granted 1 GOPH/.test(legacyMsg), 'the right one still works', legacyMsg);
    }
    line(errors.length === 0, 'the page logged no errors', errors);
  } finally {
    await browser.close();
    S.cleanup();
  }
  console.log('\n' + (failures === 0 ? 'ALL ' + total + ' STUDIO OPENING CHECKS PASSED' : failures + ' of ' + total + ' checks FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.log('ERROR ' + e.stack); S.cleanup(); process.exit(1); });
