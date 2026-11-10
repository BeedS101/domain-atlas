// Buying a ledger coin with real Gold credentials: three live chain labs PHP servers whose price adapter (chain-labs/lib/gold-issuer.php)
// talks to a throw-away Domain Atlas PHP issuer (issuer-php) with test Gold, test owners and its hold endpoint switched on.
// Nothing live is read or written, and no coin or issuer of a live domain is touched.
//   - a sale holds the credential at the issuer from the owner's signed intent, delivers the units once, and spends the
//     credential once, returning the remainder to the owner
//   - while a sale is in flight nobody (owner, operator, another sale) can spend the same Gold, at the issuer or through another sale
//   - retries and replays give the stored answer; a spent credential cannot buy again
//   - a crash at every step of the ledger side and of the issuer side is recovered without a second delivery or a second spend
//   - a partner that is down or refuses leaves the Gold held, never spent and never released while the sale might still be delivered;
//     cancelling it frees the Gold and closes the waiting proposal
//
//   node test/chain-labs-gold-issuer-http.js
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const S = require('./support/chain-labs-servers');
const { startPhp, api } = require('./lib/gen1-issuers');
const { register } = require('./lib/owner-auth');
const { A, B, nodes, wallet: rawWallet, start, stop, post, get, op, createCoin, NOW, iso, hex, units, sleep } = S;

const GOLD = 'atlas.element.gold';
const canon = S.canon;
const holdIdOf = (credId, rid) => crypto.createHash('sha256').update('atlas-gold-hold|' + credId + '|' + rid).digest('hex').slice(0, 32);
const TOKEN = crypto.randomBytes(24).toString('hex');
const TOKEN_SHA = crypto.createHash('sha256').update(TOKEN).digest('hex');
const wallet = () => { const w = rawWallet(); register({ publicKey: w.key, privateKey: w.privateKey }); return w; };
let failures = 0, total = 0;
const line = (ok, text, detail) => { total++; if (!ok) failures++; console.log((ok ? 'PASS ' : 'FAIL ') + text + (!ok && detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 500) : '')); };

const adapterFile = (n, issuer, o) => "<?php\nrequire_once '" + path.join(n.root, 'lib', 'gold-issuer.php') + "';\n$cfg = json_decode('" + JSON.stringify({
  issuerUrl: issuer.base, issuerDomain: issuer.domain, issuerKey: o.issuerKey, token: o.token || undefined, timeout: 5 }) + "', true);\n$o = __DIR__ . '/issuer-key-override.txt';\nif (is_file($o)) $cfg['issuerKey'] = trim((string) file_get_contents($o));\n$u = __DIR__ . '/issuer-url-override.txt';\nif (is_file($u)) $cfg['issuerUrl'] = trim((string) file_get_contents($u));\n$g = gold_issuer_adapter($cfg);\n$m = is_file(__DIR__ . '/rogue-mode.txt') ? trim((string) file_get_contents(__DIR__ . '/rogue-mode.txt')) : '';\nif ($m === 'nohold') { $g['lock'] = fn() => null; $g['begin'] = fn() => null; $g['release'] = fn() => null; $g['finish'] = fn($r, $c, $p) => ['balance' => null]; }\nif ($m === 'nobegin') { $g['begin'] = fn() => null; }\nif ($m === 'nolockbegin') { $g['lock'] = fn() => null; $g['begin'] = fn() => null; $g['release'] = fn() => null; }\n"
  + "$g['crash'] = function (string $p) { $f = __DIR__ . '/crash-at.txt'; if (is_file($f) && trim((string) file_get_contents($f)) === $p) { @unlink($f); exit(86); } };\nreturn $g;\n";
const crashAt = (n, point) => fs.writeFileSync(path.join(n.priv, 'crash-at.txt'), point);
const crashed = (r) => r.status === 0 || (r.status === 200 && r.json === null);

(async () => {
  const issuer = await startPhp(8961 + Math.floor(Math.random() * 100), { workers: 0 });
  const IA = api(issuer);
  const issuerKey = JSON.parse(fs.readFileSync(issuer.keyFile, 'utf8')).keys[0].publicKey;
  fs.writeFileSync(path.join(issuer.bundle, 'lib', 'atlas-gold-hold-config.json'), JSON.stringify({ enabled: true, tokenSha256: TOKEN_SHA, ledgerAuthorities: { [A]: nodes[A].pair.publicKey.export({ type: 'spki', format: 'pem' }) } }));
  const holdsPath = path.join(issuer.bundle, 'lib', 'holds', 'holds.json');
  const holds = () => { try { return JSON.parse(fs.readFileSync(holdsPath, 'utf8')).holds; } catch (e) { return {}; } };
  const holdOf = (cred) => holds()[cred.id];
  const revoked = () => new Set((IA.revocations() || []).map((r) => r.id));
  const revokeCount = (id) => (IA.revocations() || []).filter((r) => r.id === id).length;
  const mint = async (w, qty) => { const r = await IA.post('/atlas/asset/issue', { ownerPublicKey: w.key, assetClass: GOLD, quantity: qty }); if (r.status !== 200) throw new Error('mint ' + r.status + JSON.stringify(r.body)); return r.body; };
  const holdCall = async (body, token) => {
    const res = await fetch(issuer.base + '/atlas/ledger/gold-hold', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (token || TOKEN) }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const trySplit = (cred, w) => IA.post('/atlas/asset/split', { credential: cred, sendAmount: 1, toPublicKey: w.key, requestId: hex(16) });

  // Authority A can reserve and spend; partners only check.
  for (const n of Object.values(nodes)) fs.writeFileSync(n.adapter, adapterFile(n, issuer, { issuerKey, token: n.domain === A ? TOKEN : null }));
  for (const n of Object.values(nodes)) await start(n);
  const a = nodes[A], b = nodes[B];
  const POLICY = { priceClass: GOLD, issuerKey, unitsPerPrice: 10, minPrice: 5, perKeyUnits: '50000', perDayUnits: '80000' };
  const intent = (w, coinId, cred, price, requestId, recipient, over) => {
    const payload = { type: 'atlas.ledger.purchase.intent', v: 1, coinId, credentialId: cred.id, price, recipient: recipient || w.key, requestId, expiresAt: iso(NOW() + 300), ...(over || {}) };
    return { payload, signature: w.sign(payload) };
  };
  const buy = async (n, w, coinId, cred, price, o) => {
    o = o || {};
    const requestId = o.requestId || hex(16);
    const i = o.intent || intent(w, coinId, cred, price, requestId, o.recipient);
    return { requestId, intent: i, cred, res: await post(n, 'action=purchase', { coinId, intent: i, credential: cred }) };
  };
  const recover = (n, coinId) => op(n, 'purchase-recover', { coinId });
  const entries = async (n, coinId) => (await get(n, 'action=coin&coin=' + coinId)).json.head.index;

  try {
    const def = { decimals: 2, maxSupply: '100000', initialSupply: '1000' };
    const sell = (await createCoin(a, 'SELL', def)).json;
    const osc = (await createCoin(a, 'OSC', { ...def, mode: 'multi', partners: [B], threshold: 2 })).json;
    const so = await op(a, 'open', { coinId: sell.id, purchase: POLICY });
    const oo = await op(a, 'open', { coinId: osc.id, purchase: POLICY });
    line(so.status === 201 && oo.status === 201, 'setup: two coins with a purchase policy naming the issuer\'s real key (SELL single, OSC 2-of-2)', [so.json, oo.json]);

    console.log('\n== a sale');
    const w1 = wallet();
    const g1 = await mint(w1, 100);
    const p1 = await buy(a, w1, sell.id, g1, 30);
    line(p1.res.status === 201 && p1.res.json.receipt.entry.amount === '300', 'a purchase of 30 Au delivers 300 units', p1.res);
    const packed = p1.res.json.balance.balance;
    const bal = packed && JSON.parse(packed.gold);
    line(bal && bal.quantity === 70 && bal.owner.publicKey === w1.key && bal.supersedes === g1.id, 'and the remainder of 70 comes back to the owner, signed by the issuer', bal);
    line(revoked().has(g1.id) && revokeCount(g1.id) === 1, 'the credential is revoked at the issuer, once');
    line(holdOf(g1).state === 'finalized' && holdOf(g1).price === 30 && holdOf(g1).recipient === w1.key && holdOf(g1).coinId === sell.id, 'the hold records what was signed and ends finalized', holdOf(g1));
    line(await units(a, w1, sell.id) === '300', 'the buyer holds 300 units');
    const sp = await trySplit(bal, w1);
    line(sp.status === 200, 'the remainder is ordinary Gold at the issuer', sp);

    console.log('\n== retries, replay and a spent credential');
    const idx = await entries(a, sell.id);
    const again = await post(a, 'action=purchase', { coinId: sell.id, intent: p1.intent, credential: g1 });
    line(again.status < 300 && again.json.receipt.entry.index === p1.res.json.receipt.entry.index && await entries(a, sell.id) === idx && revokeCount(g1.id) === 1 && await units(a, w1, sell.id) === '300', 'the same request again gives the stored result and delivers and spends nothing more', [again.status, again.json]);
    const w2 = wallet();
    const re = await buy(a, w1, sell.id, g1, 30);
    line(re.res.status >= 400 && await units(a, w1, sell.id) === '300', 'the spent credential cannot buy again under a new request', re.res);
    const holdsBefore = Object.keys(holds()).length;
    const poor = await buy(a, w2, sell.id, await mint(w2, 20), 25);
    line(poor.res.status >= 400 && Object.keys(holds()).length === holdsBefore && await units(a, w2, sell.id) === '0', 'a price above the credential is refused and holds nothing', [poor.res.status, poor.res.json]);
    const other = wallet();
    const gOther = await mint(w2, 50);
    const stolen = await buy(a, other, sell.id, gOther, 10);
    line(stolen.res.status >= 400 && !holdOf(gOther), 'someone who is not the owner cannot buy with the credential', stolen.res);

    console.log('\n== many at once');
    {
      const w = wallet();
      const g = await mint(w, 100);
      const results = await Promise.all(Array.from({ length: 6 }, (_, k) => buy(a, w, sell.id, g, 10 + k)));
      const won = results.filter((x) => x.res.status === 201);
      line(won.length === 1 && revokeCount(g.id) === 1 && await units(a, w, sell.id) === String(won[0].intent.payload.price * 10), 'six sales of one credential at once: one delivery, one spend', results.map((x) => x.res.status));
    }
    {
      const w = wallet();
      const g = await mint(w, 100);
      const [sale, split] = await Promise.all([buy(a, w, sell.id, g, 20), trySplit(g, w)]);
      const sold = sale.res.status === 201, split200 = split.status === 200;
      line(sold !== split200 && revokeCount(g.id) === 1 && (sold ? await units(a, w, sell.id) === '200' : await units(a, w, sell.id) === '0'), 'a sale and a split of one credential at once: exactly one of them gets the Gold', [sale.res.status, split.status]);
    }

    console.log('\n== while a sale is in flight the Gold is held');
    {
      const w = wallet();
      const g = await mint(w, 100);
      crashAt(a, 'journaled');
      const first = await buy(a, w, sell.id, g, 20);
      line(crashed(first.res), 'the authority dies after journaling a sale (before delivery)', first.res.status);
      const h = holdOf(g);
      line(h && h.state === 'held', 'the credential is held');
      const s = await trySplit(g, w);
      const other2 = await buy(a, w, sell.id, g, 15);
      line(s.status !== 200 && other2.res.status >= 400 && !revoked().has(g.id), 'the owner cannot split it and a second sale cannot take it', [s.status, other2.res.status]);
      const rec = await recover(a, sell.id);
      line(rec.status === 200 && Object.values(rec.json.results).some((x) => /^done/.test(x)), 'recovery finishes the sale', rec.json);
      line(revokeCount(g.id) === 1 && await units(a, w, sell.id) === '200' && holdOf(g).state === 'finalized', 'the Gold is spent once and the units delivered once');
    }

    console.log('\n== a crash at every step of the ledger side');
    for (const point of ['locked', 'journaled', 'begun', 'submitted', 'credited', 'finished']) {
      const w = wallet();
      const g = await mint(w, 100);
      crashAt(a, point);
      const first = await buy(a, w, sell.id, g, 20);
      const died = crashed(first.res);
      const mid = holdOf(g);
      const noSplit = (await trySplit(g, w)).status !== 200;
      // Buyer retries the very same request; where nothing was journaled the retry starts the sale, elsewhere it finishes it.
      const retry = await post(a, 'action=purchase', { coinId: sell.id, intent: first.intent, credential: g });
      const rec = await recover(a, sell.id);
      const got = await units(a, w, sell.id);
      line(died && mid && ['held', 'delivering', 'finalized'].includes(mid.state) && noSplit, 'crash after "' + point + '": the request dies and the Gold stays held (' + (mid && mid.state) + ')', [first.res.status, mid && mid.state, noSplit]);
      line(retry.status < 300 && got === '200' && revokeCount(g.id) === 1 && holdOf(g).state === 'finalized' && rec.status === 200,
        'crash after "' + point + '": the retry completes the sale once - 200 units, one spend', [retry.status, got, revokeCount(g.id), holdOf(g).state]);
      const idx2 = await entries(a, sell.id);
      await post(a, 'action=purchase', { coinId: sell.id, intent: first.intent, credential: g });
      line(await entries(a, sell.id) === idx2 && await units(a, w, sell.id) === '200', 'and asking again delivers nothing more');
    }

    console.log('\n== a crash on the issuer side');
    for (const point of ['hold:reserved', 'hold:begun', 'txn:journal-written', 'txn:revoked', 'hold:spent']) {
      const w = wallet();
      const g = await mint(w, 100);
      await issuer.restart({ ATLAS_TEST_CRASH_AT: point });
      const first = await buy(a, w, sell.id, g, 20);
      const midUnits = await units(a, w, sell.id);
      await issuer.restart({});
      const retry = await post(a, 'action=purchase', { coinId: sell.id, intent: first.intent, credential: g });
      const rec = await recover(a, sell.id);
      const got = await units(a, w, sell.id);
      const sold = got === '200';
      line(first.res.status !== 201 || midUnits === '200', 'issuer dies at ' + point + ': the buyer is never told of a success that did not happen (' + first.res.status + ', ' + midUnits + ' units so far)');
      line(sold && revokeCount(g.id) === 1 && holdOf(g).state === 'finalized' && (retry.status < 300 || (rec.json && Object.values(rec.json.results).some((x) => /^done/.test(x)))), 'issuer dies at ' + point + ': the sale ends once - delivered once and spent once', [retry.status, got, revokeCount(g.id), holdOf(g) && holdOf(g).state, rec.json]);
    }

    console.log('\n== a multi authority coin');
    {
      const w = wallet();
      const g = await mint(w, 100);
      const sale = await buy(a, w, osc.id, g, 20);
      line(sale.res.status === 201 && await units(a, w, osc.id) === '200' && revokeCount(g.id) === 1, 'a sale approved by the partner delivers once and spends once', sale.res);
      line(await S.level(osc.id, [A, B]) !== undefined && S.levelOk(await S.level(osc.id, [A, B])), 'and both domains hold the same ledger');
    }
    {
      const w = wallet();
      const g = await mint(w, 100);
      await stop(b);
      const down = await buy(a, w, osc.id, g, 20);
      const h = holdOf(g);
      line(down.res.status !== 201 && h && h.state === 'delivering' && await units(a, w, osc.id) === '0', 'with the partner down nothing is delivered and the Gold stays held, delivering', [down.res.status, h && h.state]);
      line((await trySplit(g, w)).status !== 200 && !revoked().has(g.id), 'nothing else can spend it meanwhile');
      await start(b);
      const rec = await recover(a, osc.id);
      line(await units(a, w, osc.id) === '200' && revokeCount(g.id) === 1 && holdOf(g).state === 'finalized', 'when the partner is back recovery delivers once and spends once', [rec.json, await units(a, w, osc.id)]);
    }
    {
      // The partner refuses to approve (its adapter names another issuer): the sale cannot be delivered.
      const w = wallet();
      const g = await mint(w, 100);
      fs.writeFileSync(path.join(b.priv, 'issuer-key-override.txt'), issuerKey.slice(0, -2) + 'AA');
      const refused = await buy(a, w, osc.id, g, 20);
      const h = holdOf(g);
      line(refused.res.status !== 201 && await units(a, w, osc.id) === '0' && h && h.state === 'delivering', 'a partner that will not approve: nothing is delivered and the Gold stays held', [refused.res.status, refused.res.json, h && h.state]);
      line((await trySplit(g, w)).status !== 200, 'the Gold is not spent or released on a timer or by the failure alone');
      const cancelled = await op(a, 'purchase-cancel', { coinId: osc.id, requestId: refused.requestId });
      line(cancelled.status === 200 && holdOf(g).state === 'cancelled', 'the authority\'s operator cancels the sale and the Gold is freed', cancelled);
      fs.rmSync(path.join(b.priv, 'issuer-key-override.txt'));
      const late = await recover(a, osc.id);
      line(await units(a, w, osc.id) === '0' && (await trySplit(g, w)).status === 200, 'the cancelled sale cannot be delivered later, and the owner can spend the Gold', [late.json, await units(a, w, osc.id)]);
    }

    console.log('\n== a partner checks the hold with the issuer, not with the authority');
    {
      // The authority's adapter is replaced by one that does not hold the credential, or holds it without beginning delivery, or lets the
      // issuer cancel: whatever the authority's own code says, the partner asks the issuer and approves only a sale it holds for delivery.
      const rogue = (mode) => fs.writeFileSync(path.join(a.priv, 'rogue-mode.txt'), mode);
      const buyRogue = async (w, qty, price) => { const g = await mint(w, qty); return { g, ...(await buy(a, w, osc.id, g, price)) }; };
      {
        const w = wallet();
        rogue('nohold');
        const sale = await buyRogue(w, 100, 20);
        line(sale.res.status !== 201 && await units(a, w, osc.id) === '0' && !holdOf(sale.g) && !revoked().has(sale.g.id), 'an authority that does not hold the Gold delivers nothing: the partner finds no hold at the issuer', [sale.res.status, sale.res.json]);
        line(await S.level(osc.id, [A, B]) !== undefined && (await entries(a, osc.id)) === (await entries(b, osc.id)), 'and neither domain wrote an entry');
        const again = await recover(a, osc.id);
        line(await units(a, w, osc.id) === '0', 'recovery does not get it through either', again.json);
        await op(a, 'purchase-cancel', { coinId: osc.id, requestId: sale.requestId });
      }
      {
        const w = wallet();
        rogue('nobegin');
        const sale = await buyRogue(w, 100, 20);
        const h = holdOf(sale.g);
        line(sale.res.status !== 201 && await units(a, w, osc.id) === '0' && h && h.state === 'held', 'an authority that holds the Gold but never begins delivery: the partner sees a hold that is only held and refuses', [sale.res.status, h && h.state]);
        await op(a, 'purchase-cancel', { coinId: osc.id, requestId: sale.requestId });
        line(holdOf(sale.g).state === 'cancelled', 'the sale is cancelled and the Gold freed');
      }
      {
        // Another sale of the same credential holds it: a different recipient and request, so the intent digest differs.
        const w = wallet(), other = wallet();
        const g = await mint(w, 100);
        fs.rmSync(path.join(a.priv, 'rogue-mode.txt'), { force: true });
        const real = await buy(a, w, osc.id, g, 20, { recipient: other.key });
        line(real.res.status === 201 && await units(a, other, osc.id) === '200', 'a sale with its own hold goes through (the partner finds the hold for exactly that sale)', real.res);
        const g2 = await mint(w, 100);
        const i2 = intent(w, osc.id, g2, 20, hex(16), w.key);
        const decoy = intent(w, osc.id, g2, 20, i2.payload.requestId, other.key);
        await holdCall({ action: 'reserve', requestId: decoy.payload.requestId, credential: g2, intent: { payload: decoy.payload, proof: { signerRole: 'raw-ecdsa', publicKey: w.key, signature: decoy.signature } } });
        await holdCall({ action: 'begin', credentialId: g2.id, requestId: decoy.payload.requestId, holdId: holdIdOf(g2.id, decoy.payload.requestId) });
        rogue('nolockbegin');
        const sale = await buy(a, w, osc.id, g2, 20, { requestId: i2.payload.requestId, intent: i2 });
        line(sale.res.status !== 201 && await units(a, w, osc.id) === '0', 'the hold is for another recipient than the one being delivered to: the partner refuses', [sale.res.status, sale.res.json]);
        await op(a, 'purchase-cancel', { coinId: osc.id, requestId: sale.requestId });
      }
      fs.rmSync(path.join(a.priv, 'rogue-mode.txt'));
      {
        const w = wallet();
        const g = await mint(w, 100);
        const issuerDown = await buy(a, w, osc.id, g, 20);
        line(issuerDown.res.status === 201, 'with the real adapter again the same kind of sale goes through', issuerDown.res);
      }
      {
        // The issuer cannot be asked by the partner: the partner does not approve, and the sale waits rather than failing for good.
        const w = wallet();
        const g = await mint(w, 100);
        fs.writeFileSync(path.join(b.priv, 'issuer-url-override.txt'), 'http://127.0.0.1:9');
        const waiting = await buy(a, w, osc.id, g, 20);
        line(waiting.res.status !== 201 && await units(a, w, osc.id) === '0' && holdOf(g) && holdOf(g).state === 'delivering', 'a partner that cannot reach the issuer does not approve, and the sale stays pending with the Gold held', [waiting.res.status, waiting.res.json]);
        fs.rmSync(path.join(b.priv, 'issuer-url-override.txt'));
        const rec = await recover(a, osc.id);
        line(await units(a, w, osc.id) === '200' && revokeCount(g.id) === 1, 'when the partner can reach the issuer again recovery delivers once and spends once', [rec.json, await units(a, w, osc.id)]);
      }
    }

    console.log('\n== cancelling a sale that was begun');
    {
      const w = wallet();
      const g = await mint(w, 100);
      fs.writeFileSync(path.join(b.priv, 'issuer-key-override.txt'), issuerKey.slice(0, -2) + 'AA');
      const stuck = await buy(a, w, osc.id, g, 20);
      line(stuck.res.status !== 201 && holdOf(g).state === 'delivering', 'a begun sale that cannot be delivered', stuck.res.status);
      // The token alone, as an operator or an intruder holding it would do.
      const bare = await holdCall({ action: 'cancel', credentialId: g.id, requestId: stuck.requestId, holdId: holdIdOf(g.id, stuck.requestId), deliveryRuledOut: true });
      line(bare.status === 409 && bare.body.code === 'closure-required' && holdOf(g).state === 'delivering' && (await trySplit(g, w)).status !== 200, 'the token alone cannot free the Gold', bare);
      const cancelled = await op(a, 'purchase-cancel', { coinId: osc.id, requestId: stuck.requestId });
      const h = holdOf(g);
      line(cancelled.status === 200 && h.state === 'cancelled' && h.closure && h.closure.payload.domain === A && h.closure.payload.requestId === stuck.requestId, 'the ledger\'s own cancel frees it with the closure the ledger signed, which the hold keeps', [cancelled, h && h.closure]);
      fs.rmSync(path.join(b.priv, 'issuer-key-override.txt'));
      line((await trySplit(g, w)).status === 200 && await units(a, w, osc.id) === '0', 'the Gold is spendable by its owner and nothing was delivered');
      // A closure is not made for a sale that was delivered.
      const w2 = wallet();
      const g2 = await mint(w2, 100);
      const done = await buy(a, w2, osc.id, g2, 20);
      const late = await op(a, 'purchase-cancel', { coinId: osc.id, requestId: done.requestId });
      line(done.res.status === 201 && late.status !== 200 && holdOf(g2).state === 'finalized' && revokeCount(g2.id) === 1, 'a delivered sale cannot be cancelled and gets no closure', late);
      // Forging a closure needs the ledger domain's key: one signed with another key is refused by the issuer.
      const w3 = wallet();
      const g3 = await mint(w3, 100);
      fs.writeFileSync(path.join(b.priv, 'issuer-key-override.txt'), issuerKey.slice(0, -2) + 'AA');
      const stuck3 = await buy(a, w3, osc.id, g3, 20);
      const forged = { type: 'atlas.ledger.purchase.closure', v: 1, domain: A, coinId: osc.id, requestId: stuck3.requestId, credentialId: g3.id, price: 20, headIndex: 0, headHash: '0'.repeat(64), closedAt: iso(NOW()) };
      const fake = await holdCall({ action: 'cancel', credentialId: g3.id, requestId: stuck3.requestId, holdId: holdIdOf(g3.id, stuck3.requestId),
        closure: { payload: forged, signature: crypto.sign('sha256', Buffer.from(canon(forged)), nodes[B].pair.privateKey).toString('base64url') } });
      line(fake.status === 409 && holdOf(g3).state === 'delivering', 'a closure signed with another domain\'s key is refused', fake);
      fs.rmSync(path.join(b.priv, 'issuer-key-override.txt'));
      await op(a, 'purchase-cancel', { coinId: osc.id, requestId: stuck3.requestId });
    }

    console.log('\n== the operator\'s token is not the owner');
    {
      const w = wallet(), mallory = wallet();
      const g = await mint(w, 100);
      const forged = intent(mallory, sell.id, g, 20, hex(16), mallory.key);
      const r = await holdCall({ action: 'reserve', requestId: forged.payload.requestId, credential: g, intent: { payload: forged.payload, proof: { signerRole: 'raw-ecdsa', publicKey: mallory.key, signature: forged.signature } } });
      line(r.status === 403 && !holdOf(g), 'the token cannot reserve a credential from an intent the owner did not sign', r);
      const noHold = await holdCall({ action: 'finalize', credentialId: g.id, requestId: hex(16), holdId: hex(16) });
      line(noHold.status === 404 && !revoked().has(g.id), 'and cannot spend one that was never reserved', noHold);
      const okIntent = intent(w, sell.id, g, 20, hex(16));
      const rr = await holdCall({ action: 'reserve', requestId: okIntent.payload.requestId, credential: g, intent: { payload: okIntent.payload, proof: { signerRole: 'raw-ecdsa', publicKey: w.key, signature: okIntent.signature } } });
      const hid = rr.body.hold.holdId;
      await holdCall({ action: 'begin', credentialId: g.id, requestId: okIntent.payload.requestId, holdId: hid });
      const fin = await holdCall({ action: 'finalize', credentialId: g.id, requestId: okIntent.payload.requestId, holdId: hid, price: 99, recipient: mallory.key });
      line(fin.status === 200 && fin.body.result.price === 20 && fin.body.result.balance.quantity === 80 && fin.body.result.balance.credential.owner.publicKey === w.key, 'finalize takes the price and the owner from the signed intent, not from the caller', fin);
      const wrongToken = await holdCall({ action: 'status', credentialId: g.id, requestId: okIntent.payload.requestId, holdId: hid }, 'z'.repeat(48));
      line(wrongToken.status === 401, 'a wrong token reads nothing', wrongToken);
    }
  } catch (e) {
    console.log('ERROR ' + e.stack);
    failures++;
  } finally {
    issuer.stop();
    S.cleanup();
  }
  console.log('\n' + (failures === 0 ? 'ALL ' + total + ' GOLD ISSUER CHECKS PASSED' : failures + ' of ' + total + ' checks FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.log('ERROR ' + e.stack); S.cleanup(); process.exit(1); });
