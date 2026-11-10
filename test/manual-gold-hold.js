// Durable holds on Gold for a ledger purchase (issuer-php/lib/gold-hold.php), against throw-away PHP issuers with test Gold
// and test owners. Nothing live is read or written.
//
//   node test/manual-gold-hold.js
//
// Covers: the endpoint is off by default and needs the operator token; a hold is made only from an intent the owner signed
// and binds the credential, price, recipient, ledger coin and request id; while held, every spend path and the operator's own
// revoke are refused; reserve / begin / finalize / cancel and the lapse of a hold that was never begun; a hold that is
// delivering never lapses; races between reservations and spends; retries and replay; a crash at every step; partial
// spending; a hold list that cannot be read.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { startPhp, api } = require('./lib/gen1-issuers');
const { newOwner, proofFor } = require('./lib/owner-auth');

const GOLD = 'atlas.element.gold';
const IRON = 'atlas.element.iron';
const TOKEN = crypto.randomBytes(24).toString('hex');
const TOKEN_SHA = crypto.createHash('sha256').update(TOKEN).digest('hex');
const COIN = 'c'.repeat(32);
const iso = (t) => new Date(t * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
const now = () => Math.floor(Date.now() / 1000);
const hex = (n) => crypto.randomBytes(n).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const holdId = (credId, rid) => crypto.createHash('sha256').update('atlas-gold-hold|' + credId + '|' + rid).digest('hex').slice(0, 32);

let failures = 0, total = 0;
const line = (ok, text, detail) => { total++; if (!ok) failures++; console.log((ok ? 'PASS ' : 'FAIL ') + text + (!ok && detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 500) : '')); };

async function raw(be, body, token) {
  let res;
  try {
    res = await fetch(be.base + '/atlas/ledger/gold-hold', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token === null ? {} : { Authorization: 'Bearer ' + (token || TOKEN) }) }, body: JSON.stringify(body) });
  } catch (e) { return { status: 0, body: { error: 'network ' + e.message } }; }
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (e) { json = { error: 'non-json ' + text.slice(0, 120) }; }
  return { status: res.status, body: json };
}
const config = (be, obj) => fs.writeFileSync(path.join(be.bundle, 'lib', 'atlas-gold-hold-config.json'), JSON.stringify(obj));
const holdsFile = (be) => path.join(be.bundle, 'lib', 'holds', 'holds.json');
const readHolds = (be) => JSON.parse(fs.readFileSync(holdsFile(be), 'utf8')).holds;
const editHolds = (be, fn) => { const d = JSON.parse(fs.readFileSync(holdsFile(be), 'utf8')); fn(d.holds); fs.writeFileSync(holdsFile(be), JSON.stringify(d)); };
const revoked = (be) => new Set((api(be).revocations() || []).map((r) => r.id));
const mint = async (A, owner, cls, qty) => { const r = await A.post('/atlas/asset/issue', { ownerPublicKey: owner, assetClass: cls, quantity: qty }); if (r.status !== 200) throw new Error('mint ' + r.status + JSON.stringify(r.body)); return r.body; };

// A signed purchase intent as the ledger wallet makes it, with the issuer's proof label.
function intentFor(owner, cred, o) {
  o = o || {};
  const payload = { type: 'atlas.ledger.purchase.intent', v: 1, coinId: o.coinId || COIN, credentialId: cred.id, price: o.price === undefined ? 30 : o.price,
    recipient: o.recipient || newOwner(), requestId: o.requestId || hex(16), expiresAt: o.expiresAt || iso(now() + 300) };
  return { payload, proof: proofFor(o.signer || cred.owner.publicKey, payload) };
}
const reserveBody = (cred, intent) => ({ action: 'reserve', credential: cred, intent, requestId: intent.payload.requestId });
const ref = (cred, intent, h) => ({ credentialId: cred.id, requestId: intent.payload.requestId, holdId: h });
const act = (be, action, cred, intent, extra) => raw(be, { action, ...ref(cred, intent, holdId(cred.id, intent.payload.requestId)), ...(extra || {}) });

// Operator revoke and a bare spend lock, as code inside the issuer would call them.
function inIssuer(be, code, arg) {
  const script = '$_SERVER["HTTP_HOST"]=$argv[1];$_SERVER["REQUEST_METHOD"]="CLI";require "lib/bootstrap.php";try{' + code + '}catch(Exception $e){echo "ERR ".$e->getCode().": ".$e->getMessage();}';
  return execFileSync('php', ['-r', script, be.domain, arg], { cwd: be.bundle }).toString();
}
const operatorRevoke = (be, id) => inIssuer(be, 'atlas_revoke($argv[2],"operator");echo "ok";', id);

async function setup(be) {
  const A = api(be);
  const o = { A };
  o.owner = newOwner();
  o.other = newOwner();
  return o;
}

(async () => {
  const be = await startPhp(8761 + Math.floor(Math.random() * 100), { workers: 4 });
  const crash = await startPhp(8861 + Math.floor(Math.random() * 100), { workers: 0 });
  try {
    const { A, owner, other } = await setup(be);

    console.log('\n== off by default, and the token');
    const g0 = await mint(A, owner, GOLD, 100);
    const i0 = intentFor(owner, g0);
    let r = await raw(be, reserveBody(g0, i0));
    line(r.status === 404 && r.body.code === 'disabled', 'with no config the endpoint is off', r);
    config(be, { enabled: true });
    r = await raw(be, reserveBody(g0, i0));
    line(r.status === 404, 'a config without a token hash is still off', r);
    config(be, { enabled: true, tokenSha256: TOKEN_SHA });
    r = await raw(be, reserveBody(g0, i0), null);
    line(r.status === 401, 'no token is refused', r);
    r = await raw(be, reserveBody(g0, i0), 'x'.repeat(48));
    line(r.status === 401, 'a wrong token is refused', r);
    const res = await fetch(be.base + '/atlas/ledger/gold-hold', { method: 'GET' });
    line(res.status === 405, 'only POST is accepted', res.status);
    line(!fs.existsSync(holdsFile(be)), 'refused requests held nothing');

    console.log('\n== a hold needs the owner\'s signed intent');
    const bad = async (name, cred, intent, status, code) => {
      const x = await raw(be, reserveBody(cred, intent));
      line(x.status === status && (code === undefined || x.body.code === code), name, x);
    };
    await bad('an intent signed by someone else is refused (the token does not stand in for the owner)', g0, intentFor(owner, g0, { signer: other }), 403, 'not-owner');
    {
      const t = intentFor(owner, g0); t.payload.price = 99;
      await bad('an intent whose price was changed after signing is refused', g0, t, 403, 'owner-signature-invalid');
    }
    {
      const t = intentFor(owner, g0); t.payload.recipient = other;
      await bad('an intent whose recipient was changed after signing is refused', g0, t, 403, 'owner-signature-invalid');
    }
    {
      const t = intentFor(owner, g0); t.proof.signerRole = 'webauthn';
      await bad('only a raw ECDSA owner signature is accepted', g0, t, 403, 'owner-authorization-required');
    }
    await bad('an intent for another credential is refused', g0, intentFor(owner, { ...g0, id: 'urn:other' }), 400, 'bad-intent');
    await bad('a price above the quantity is refused', g0, intentFor(owner, g0, { price: 101 }), 409, 'invalid-credential');
    await bad('a price of zero is refused', g0, intentFor(owner, g0, { price: 0 }), 400, 'bad-intent');
    await bad('an expired intent is refused', g0, intentFor(owner, g0, { expiresAt: iso(now() - 5) }), 400, 'bad-intent');
    await bad('an intent valid for hours is refused', g0, intentFor(owner, g0, { expiresAt: iso(now() + 86400) }), 400, 'bad-intent');
    await bad('a recipient that is not a ledger key is refused', g0, intentFor(owner, g0, { recipient: 'nope' }), 400, 'bad-intent');
    await bad('a coin id that is not a ledger coin is refused', g0, intentFor(owner, g0, { coinId: 'zz' }), 400, 'bad-intent');
    {
      const t = intentFor(owner, g0);
      const x = await raw(be, { ...reserveBody(g0, t), requestId: hex(16) });
      line(x.status === 400 && x.body.code === 'bad-intent', 'the request id must be the one the owner signed', x);
    }
    {
      const forged = { ...g0, quantity: 100000 };
      const x = await raw(be, reserveBody(forged, intentFor(owner, forged)));
      line(x.status === 409 && x.body.code === 'invalid-credential', 'a credential whose quantity was edited fails the issuer\'s own signature check', x);
    }
    {
      const iron = await mint(A, owner, IRON, 10);
      const x = await raw(be, reserveBody(iron, intentFor(owner, iron, { price: 1 })));
      line(x.status === 409, 'only Gold can be held', x);
    }
    line(!fs.existsSync(holdsFile(be)), 'none of the refused requests left a hold');

    console.log('\n== reserving');
    const i1 = intentFor(owner, g0, { price: 30 });
    r = await raw(be, reserveBody(g0, i1));
    line(r.status === 200 && r.body.hold.state === 'held' && r.body.hold.price === 30 && r.body.hold.coinId === COIN && r.body.hold.recipient === i1.payload.recipient && r.body.hold.holdId === holdId(g0.id, i1.payload.requestId), 'a valid intent holds the credential for exactly what it says', r);
    const first = r.body.hold;
    r = await raw(be, reserveBody(g0, i1));
    line(r.status === 200 && r.body.hold.holdId === first.holdId && Object.keys(readHolds(be)).length === 1, 'the same request again returns the same hold', r);
    r = await raw(be, reserveBody(g0, intentFor(owner, g0, { price: 10 })));
    line(r.status === 409 && r.body.code === 'held', 'another purchase of the same credential is refused', r);
    {
      const g1 = await mint(A, owner, GOLD, 50);
      const x = await raw(be, reserveBody(g1, intentFor(owner, g1, { price: 5, requestId: i1.payload.requestId })));
      line(x.status === 409 && x.body.code === 'request-reused', 'one request id cannot hold two credentials', x);
    }
    const hfile = fs.readFileSync(holdsFile(be), 'utf8');
    line(!hfile.includes(TOKEN) && fs.statSync(holdsFile(be)).mode % 512 === 0o600, 'the hold list is private and does not contain the token');

    console.log('\n== while held, nothing else can spend it');
    const rev0 = revoked(be).size;
    const split = await A.post('/atlas/asset/split', { credential: g0, sendAmount: 10, toPublicKey: other, requestId: hex(16) });
    line(split.status !== 200 && /held/.test(split.body.error || '') && split.body.code === 'held', 'split is refused', split);
    const g2 = await mint(A, owner, GOLD, 40);
    const cons = await A.post('/atlas/asset/consolidate', { credentials: [g0, g2], requestId: hex(16) });
    line(cons.status !== 200 && cons.body.code === 'held', 'consolidate is refused', cons);
    const conv = await A.post('/atlas/convert', { credential: g0, spendAmount: 10, toClass: 'atlas.element.platinum', requestId: hex(16) });
    line(conv.status !== 200 && conv.body.code === 'held', 'convert is refused', conv);
    let o = operatorRevoke(be, g0.id);
    line(/^ERR 409/.test(o) && /held for a ledger purchase/.test(o), 'the operator\'s own revoke is refused', o);
    o = inIssuer(be, 'echo json_encode(atlas_spend_lock($argv[2]));', g0.id);
    line(/held for a purchase/.test(o), 'the spend lock every other endpoint takes refuses it', o);
    line(revoked(be).size === rev0 && !revoked(be).has(g0.id), 'nothing was revoked by any of them');
    const split2 = await A.post('/atlas/asset/split', { credential: g2, sendAmount: 10, toPublicKey: other, requestId: hex(16) });
    line(split2.status === 200, 'other credentials of the same owner are not affected', split2);
    // The request id of a hold is not a place a caller can poison.
    const poison = await A.post('/atlas/asset/split', { credential: await mint(A, newOwner(), GOLD, 20), sendAmount: 5, toPublicKey: other, requestId: first.holdId });
    line(poison.status === 200, 'a split using the hold\'s own name as its request id is an ordinary split', poison);

    console.log('\n== begin, finalize, and the order of them');
    r = await act(be, 'finalize', g0, i1);
    line(r.status === 409 && r.body.code === 'not-delivering', 'finalize before delivery was begun is refused', r);
    r = await raw(be, { action: 'begin', credentialId: g0.id, requestId: i1.payload.requestId, holdId: 'f'.repeat(32) });
    line(r.status === 404, 'a wrong hold id is not found', r);
    r = await raw(be, { action: 'begin', credentialId: g0.id, requestId: hex(16), holdId: first.holdId });
    line(r.status === 404, 'a wrong request id is not found', r);
    r = await act(be, 'begin', g0, i1);
    line(r.status === 200 && r.body.hold.state === 'delivering', 'begin moves it to delivering', r);
    r = await act(be, 'begin', g0, i1);
    line(r.status === 200 && r.body.hold.state === 'delivering', 'begin is repeatable', r);
    const rev1 = revoked(be).size;
    r = await act(be, 'finalize', g0, i1);
    const fin = r.body.result;
    line(r.status === 200 && fin && fin.price === 30 && fin.revoked === g0.id && fin.balance.quantity === 70 && fin.balance.credential.owner.publicKey === owner && fin.balance.credential.quantity === 70, 'finalize burns the price and returns the rest to the owner, not the recipient', r);
    line(revoked(be).has(g0.id) && revoked(be).size === rev1 + 1, 'the credential is revoked once');
    const again = await act(be, 'finalize', g0, i1);
    line(again.status === 200 && JSON.stringify(again.body.result) === JSON.stringify(fin) && revoked(be).size === rev1 + 1, 'finalize again returns the same result and spends nothing more', again);
    const st = await act(be, 'status', g0, i1);
    line(st.body.hold.state === 'finalized', 'status says finalized', st);
    r = await act(be, 'cancel', g0, i1);
    line(r.status === 409 && r.body.code === 'finalized', 'a spent hold cannot be cancelled', r);
    r = await raw(be, reserveBody(g0, i1));
    line(r.status === 409, 'the spent credential cannot be held again with the same intent', r);
    const rem = fin.balance.credential;
    const rs = await A.post('/atlas/asset/split', { credential: rem, sendAmount: 20, toPublicKey: other, requestId: hex(16) });
    line(rs.status === 200, 'the remainder is ordinary Gold the owner can spend', rs);

    console.log('\n== exact price: nothing left over');
    {
      const gx = await mint(A, newOwner(), GOLD, 25);
      const ix = intentFor(owner, gx, { price: 25 });
      await raw(be, reserveBody(gx, ix));
      await act(be, 'begin', gx, ix);
      const f = await act(be, 'finalize', gx, ix);
      line(f.status === 200 && f.body.result.balance.quantity === 0 && f.body.result.balance.credential === null, 'paying the whole credential leaves no remainder', f);
    }

    console.log('\n== cancel, lapse and replay');
    const g3 = await mint(A, newOwner(), GOLD, 60);
    const i3 = intentFor(owner, g3, { price: 20 });
    await raw(be, reserveBody(g3, i3));
    r = await act(be, 'cancel', g3, i3);
    line(r.status === 200 && r.body.hold.state === 'cancelled', 'a hold that was never begun can be cancelled', r);
    r = await act(be, 'cancel', g3, i3);
    line(r.status === 200 && r.body.hold.state === 'cancelled', 'cancel is repeatable', r);
    r = await A.post('/atlas/asset/split', { credential: g3, sendAmount: 5, toPublicKey: other, requestId: hex(16) });
    line(r.status === 200, 'after a cancel the Gold can be spent again', r);
    const g4 = await mint(A, newOwner(), GOLD, 60);
    const i4 = intentFor(owner, g4, { price: 20 });
    await raw(be, reserveBody(g4, i4));
    await act(be, 'cancel', g4, i4);
    r = await raw(be, reserveBody(g4, i4));
    line(r.status === 409 && r.body.code === 'intent-used', 'a cancelled hold cannot be revived by replaying the same signed intent', r);
    r = await raw(be, reserveBody(g4, intentFor(owner, g4, { price: 20 })));
    line(r.status === 200, 'but the owner can sign a new one', r);

    const g5 = await mint(A, newOwner(), GOLD, 60);
    const i5 = intentFor(owner, g5, { price: 20 });
    await raw(be, reserveBody(g5, i5));
    editHolds(be, (h) => { h[g5.id].expiresAt = now() - 1; });
    r = await act(be, 'begin', g5, i5);
    line(r.status === 410 && r.body.code === 'hold-expired', 'a hold that lapsed before delivery was begun cannot begin it', r);
    r = await A.post('/atlas/asset/split', { credential: g5, sendAmount: 5, toPublicKey: other, requestId: hex(16) });
    line(r.status === 200, 'and a lapsed hold frees the Gold', r);

    const g6 = await mint(A, newOwner(), GOLD, 60);
    const i6 = intentFor(owner, g6, { price: 20 });
    await raw(be, reserveBody(g6, i6));
    await act(be, 'begin', g6, i6);
    editHolds(be, (h) => { h[g6.id].expiresAt = now() - 99999; h[g6.id].createdAt = now() - 99999; h[g6.id].deliveringAt = now() - 99999; });
    r = await A.post('/atlas/asset/split', { credential: g6, sendAmount: 5, toPublicKey: other, requestId: hex(16) });
    line(r.status !== 200 && r.body.code === 'held', 'a delivering hold does not lapse, however long it has been', r);
    line(/^ERR 409/.test(operatorRevoke(be, g6.id)), 'and the operator cannot revoke it either');
    r = await act(be, 'cancel', g6, i6);
    line(r.status === 409 && r.body.code === 'delivery-may-have-committed', 'it is cancelled only when the ledger has ruled delivery out', r);
    r = await act(be, 'cancel', g6, i6, { deliveryRuledOut: true });
    line(r.status === 200 && r.body.hold.state === 'cancelled', 'and then it is', r);
    r = await A.post('/atlas/asset/split', { credential: g6, sendAmount: 5, toPublicKey: other, requestId: hex(16) });
    line(r.status === 200, 'after which the Gold is free', r);

    console.log('\n== revocation, suspension and the operator');
    {
      const gr = await mint(A, newOwner(), GOLD, 50);
      const ir = intentFor(owner, gr, { price: 10 });
      await raw(be, reserveBody(gr, ir));
      // A revocation written into the list by hand (a restore, an out-of-band action) is seen at begin.
      const d = JSON.parse(fs.readFileSync(be.revFile, 'utf8'));
      d.revoked.push({ id: gr.id, revokedAt: iso(now()), reason: 'test' });
      fs.writeFileSync(be.revFile, JSON.stringify(d));
      r = await act(be, 'begin', gr, ir);
      line(r.status === 409 && r.body.code === 'revoked', 'a credential revoked behind the hold\'s back cannot begin delivery', r);
      r = await raw(be, reserveBody(gr, intentFor(owner, gr, { price: 10 })));
      line(r.status === 409 && r.body.code === 'revoked', 'and a revoked credential cannot be held', r);
      const gs = await mint(A, newOwner(), GOLD, 50);
      const is = intentFor(owner, gs, { price: 10 });
      await raw(be, reserveBody(gs, is));
      await act(be, 'cancel', gs, is);
      line(operatorRevoke(be, gs.id) === 'ok', 'once cancelled the operator can revoke it again', operatorRevoke(be, gs.id));
    }

    console.log('\n== per-owner limit');
    {
      const o2 = newOwner();
      const out = [];
      for (let k = 0; k < 7; k++) {
        const c = await mint(A, o2, GOLD, 10);
        out.push((await raw(be, reserveBody(c, intentFor(o2, c, { price: 1 })))).status);
      }
      line(out.slice(0, 5).every((s) => s === 200) && out.slice(5).every((s) => s === 429), 'one owner can hold five credentials at a time', out);
    }

    console.log('\n== races');
    {
      const ow = newOwner();
      const gc = await mint(A, ow, GOLD, 100);
      const attempts = [];
      for (let k = 0; k < 12; k++) attempts.push(raw(be, reserveBody(gc, intentFor(ow, gc, { price: 5 + k }))));
      const results = await Promise.all(attempts);
      const won = results.filter((x) => x.status === 200);
      line(won.length === 1 && results.filter((x) => x.status === 409).length === 11, 'twelve simultaneous reservations of one credential: exactly one holds it', results.map((x) => x.status));
      line(Object.values(readHolds(be)).filter((h) => h.credentialId === gc.id).length === 1, 'and the list has one record for it');
    }
    for (let round = 0; round < 6; round++) {
      const ow = newOwner();
      const gd = await mint(A, ow, GOLD, 100);
      const id = intentFor(ow, gd, { price: 10 });
      const spend = A.post('/atlas/asset/split', { credential: gd, sendAmount: 10, toPublicKey: other, requestId: hex(16) });
      const hold = raw(be, reserveBody(gd, id));
      const [s, h] = await Promise.all([spend, hold]);
      const spent = s.status === 200, held = h.status === 200;
      let ok = spent !== held;
      if (held) {
        const later = await A.post('/atlas/asset/split', { credential: gd, sendAmount: 10, toPublicKey: other, requestId: hex(16) });
        ok = ok && later.status !== 200 && !revoked(be).has(gd.id);
        await act(be, 'cancel', gd, id);
      } else {
        ok = ok && revoked(be).has(gd.id) && h.status === 409;
      }
      line(ok, 'round ' + (round + 1) + ': a split and a reservation at once - exactly one wins (' + (held ? 'hold' : 'spend') + ')', [s.status, h.status, h.body]);
    }
    {
      const ow = newOwner();
      const ge = await mint(A, ow, GOLD, 100);
      const ie = intentFor(ow, ge, { price: 40 });
      await raw(be, reserveBody(ge, ie));
      await act(be, 'begin', ge, ie);
      const calls = [];
      for (let k = 0; k < 8; k++) calls.push(act(be, 'finalize', ge, ie));
      for (let k = 0; k < 6; k++) calls.push(A.post('/atlas/asset/split', { credential: ge, sendAmount: 10, toPublicKey: other, requestId: hex(16) }));
      calls.push(Promise.resolve(operatorRevoke(be, ge.id)));
      const rs2 = await Promise.all(calls);
      const fins = rs2.slice(0, 8).filter((x) => x.status === 200);
      const same = new Set(fins.map((x) => JSON.stringify(x.body.result)));
      const rems = (api(be).revocations() || []).filter((x) => x.id === ge.id);
      line(fins.length >= 1 && same.size === 1 && rs2.slice(8, 14).every((x) => x.status !== 200) && rems.length === 1, 'eight finalizes with splits and a revoke alongside: one spend, one result, nothing else gets through', [fins.length, same.size, rems.length]);
      line(fins.length === 0 || fins[0].body.result.balance.quantity === 60, 'and the remainder is 60');
    }

    console.log('\n== a hold list that cannot be read');
    {
      const ow = newOwner();
      const gf = await mint(A, ow, GOLD, 100);
      const gg = await mint(A, ow, GOLD, 100);
      const text = fs.readFileSync(holdsFile(be), 'utf8');
      for (const [name, bad] of [['truncated', text.slice(0, 40)], ['empty', ''], ['not an object', '[]'], ['no holds', '{"x":1}']]) {
        fs.writeFileSync(holdsFile(be), bad);
        const s = await A.post('/atlas/asset/split', { credential: gf, sendAmount: 10, toPublicKey: other, requestId: hex(16) });
        const h = await raw(be, reserveBody(gg, intentFor(ow, gg, { price: 5 })));
        const same = fs.readFileSync(holdsFile(be), 'utf8') === bad;
        line(s.status === 400 && /cannot be read/.test(s.body.error || '') && h.status === 503 && same && !revoked(be).has(gf.id), name + ': nothing is spent or held, and the file is left as it was', [s.status, s.body, h.status]);
      }
      fs.writeFileSync(holdsFile(be), text);
      const s = await A.post('/atlas/asset/split', { credential: gf, sendAmount: 10, toPublicKey: other, requestId: hex(16) });
      line(s.status === 200, 'with the list back, spending works', s);
      fs.writeFileSync(path.join(be.bundle, 'lib', 'holds', 'holds.lock'), 'stale');
      const x = await raw(be, reserveBody(gg, intentFor(ow, gg, { price: 5 })));
      line(x.status === 200, 'a lock file left behind by a dead request blocks nothing', x);
    }

    console.log('\n== a crash at every step (one request at a time)');
    {
      const C = api(crash);
      config(crash, { enabled: true, tokenSha256: TOKEN_SHA });
      let co = newOwner();
      const attempt = async (point, setup, step, verify, name) => {
        co = newOwner();
        const gc = await mint(C, co, GOLD, 100);
        const ic = intentFor(co, gc, { price: 35 });
        await setup(gc, ic);
        await crash.restart({ ATLAS_TEST_CRASH_AT: point });
        const hit = await step(gc, ic);
        await crash.restart({});
        const retry = await step(gc, ic);
        line(hit.status === 0 || (hit.status === 200 && /^non-json/.test(hit.body.error || '')), 'crash at ' + point + ' ' + name + ': the request died without an answer (' + hit.status + ')');
        await verify(gc, ic, retry);
      };
      const reserve = (gc, ic) => raw(crash, reserveBody(gc, ic));
      const begin = (gc, ic) => act(crash, 'begin', gc, ic);
      const finalize = (gc, ic) => act(crash, 'finalize', gc, ic);
      const cancel = (gc, ic) => act(crash, 'cancel', gc, ic);
      const none = async () => {};
      const toHeld = async (gc, ic) => { await reserve(gc, ic); };
      const toDelivering = async (gc, ic) => { await reserve(gc, ic); await begin(gc, ic); };

      await attempt('hold:reserved', none, reserve, async (gc, ic, retry) => {
        const holds = readHolds(crash);
        line(retry.status === 200 && Object.values(holds).filter((h) => h.credentialId === gc.id).length === 1, 'the repeat of a reserve that lost its answer finds the one hold', retry);
      }, 'after reserving');
      await attempt('hold:begun', toHeld, begin, async (gc, ic, retry) => {
        line(retry.status === 200 && retry.body.hold.state === 'delivering', 'the repeat of a begin finds delivering', retry);
      }, 'after begin');
      await attempt('hold:cancelled', toHeld, cancel, async (gc, ic, retry) => {
        line(retry.status === 200 && retry.body.hold.state === 'cancelled', 'the repeat of a cancel finds cancelled', retry);
      }, 'after cancel');
      for (const point of ['txn:minted', 'txn:journal-written', 'txn:holdings-registered', 'txn:revoked', 'txn:replay-stored', 'txn:journal-removed', 'hold:spent']) {
        await attempt(point, toDelivering, finalize, async (gc, ic, retry) => {
          const revs = (C.revocations() || []).filter((x) => x.id === gc.id);
          const res = retry.body.result;
          line(retry.status === 200 && res && res.price === 35 && res.balance.quantity === 65 && revs.length === 1, 'the repeat of a finalize spends the credential exactly once and returns the remainder', [retry.status, revs.length, res && res.balance && res.balance.quantity]);
          const st = await act(crash, 'status', gc, ic);
          line(st.body.hold.state === 'finalized', 'the hold ends finalized', st);
          const again = await finalize(gc, ic);
          line(again.status === 200 && JSON.stringify(again.body.result) === JSON.stringify(res), 'and a further repeat gives the same answer', again);
          // The remainder is registered once with the holder: spending it works and the original stays spent.
          const rem = res.balance.credential;
          const sp = await C.post('/atlas/asset/split', { credential: rem, sendAmount: 5, toPublicKey: co, requestId: hex(16) });
          line(sp.status === 200, 'the remainder is spendable', sp);
        }, 'inside finalize');
      }
      // Before the journal the credential is untouched and still held.
      {
        co = newOwner();
        const gc = await mint(C, co, GOLD, 100);
        const ic = intentFor(co, gc, { price: 35 });
        await toDelivering(gc, ic);
        await crash.restart({ ATLAS_TEST_CRASH_AT: 'txn:holdings-registered' });
        await finalize(gc, ic);
        await crash.restart({});
        const sp = await C.post('/atlas/asset/split', { credential: gc, sendAmount: 5, toPublicKey: co, requestId: hex(16) });
        line(sp.status !== 200 && !revoked(crash).has(gc.id), 'between the journal and the revoke the credential is still held, and nothing else can spend it', sp);
      }
    }

    console.log('\n== partial spending: the price is a part of the credential');
    {
      const gp = await mint(A, newOwner(), GOLD, 400);
      const ip = intentFor(gp.owner.publicKey, gp, { price: 1 });
      await raw(be, reserveBody(gp, ip));
      await act(be, 'begin', gp, ip);
      const f = await act(be, 'finalize', gp, ip);
      line(f.body.result.balance.quantity === 399 && f.body.result.price === 1, 'a price of 1 from 400 returns 399', f);
      const credAfter = f.body.result.balance.credential;
      line(credAfter.supersedes === gp.id && credAfter.asset.class === GOLD, 'the remainder names the credential it replaces');
    }
  } catch (e) {
    console.log('ERROR ' + e.stack);
    failures++;
  } finally {
    be.stop();
    crash.stop();
  }
  console.log('\n' + (failures === 0 ? 'ALL ' + total + ' GOLD HOLD CHECKS PASSED' : failures + ' of ' + total + ' checks FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})();
