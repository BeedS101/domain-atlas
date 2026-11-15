// Wallet mint allowance against a real PHP issuer (isolated copy, fresh keys and state) with wallet-style signatures:
// the configured limit (default and custom), counts after real mints, safe retries, the rolling 24-hour window,
// exhaustion and when it ends, separate identities, issuer-wide limits reported apart from the wallet's share,
// minting off, and who may ask. Run:  node test/asset-studio-quota-http.js
'use strict';
const fs = require('fs');
const path = require('path');
const { StudioLab, makeIdentity, signBridge, DESIGN } = require('./studio-lab');

let failures = 0, passes = 0;
const check = (name, ok, detail) => {
  if (ok) { passes++; console.log('PASS ' + name); } else { failures++; console.log('FAIL ' + name + ' :: ' + JSON.stringify(detail).slice(0, 600)); }
};

const BASE = { mintsPerIpPerHour: 1000, challengesPerIpPerHour: 1000, maxMintsPerActorPerDay: 100, maxMintsPerNetworkPerDay: 100, maxMintsPerDay: 1000 };
const design = (name) => Object.assign({}, DESIGN, { name });

async function quotaPayload(lab) {
  const st = (await lab.status()).json;
  return { purpose: st.quota.purpose, summary: st.quota.summary, now: st.now };
}
// What a wallet would send: a signature over the fixed read-only request.
async function signedAsk(lab, identity, over) {
  over = over || {};
  const q = await quotaPayload(lab);
  const payload = Object.assign({ purpose: q.purpose, recipient: identity.publicKeyB64, issuedAt: q.now, summary: q.summary }, over.payload || {});
  return { recipient: over.recipient || identity.publicKeyB64, proof: signBridge(over.signer || identity, over.origin || lab.origin, payload) };
}
const ask = async (lab, identity, over) => lab.api('quota', await signedAsk(lab, identity, over));
const attemptFiles = (lab) => lab.studioFiles('mint-receipts').filter((f) => /^attempt-/.test(f));

async function main() {
  // ---- default limit, custom limit, minting off ----
  const def = await StudioLab.start({ mint: true, config: BASE });
  const custom = await StudioLab.start({ mint: true, config: Object.assign({}, BASE, { maxMintsPerRecipientPerDay: 5 }) });
  const off = await StudioLab.start({ mint: false });
  try {
    let st = (await def.status()).json;
    check('status reports the default per-wallet limit, 3 in a 24-hour window, and no wallet history', st.ok && st.quota.perWalletLimit === 3 && st.quota.windowSeconds === 86400 && typeof st.now === 'number' && !/nonce|credential|recipient/i.test(JSON.stringify(st.quota)), st);
    st = (await custom.status()).json;
    check('status reports a custom limit as configured (5)', st.quota.perWalletLimit === 5, st);
    st = (await off.status()).json;
    check('with minting off the status carries no quota and the lookup is refused', st.mintEnabled === false && st.quota === null && (await off.api('quota', { recipient: makeIdentity().publicKeyB64, token: '1.' + 'a'.repeat(64) })).status === 403, st);

    // ---- who may ask ----
    const A = makeIdentity('raw-ecdsa'), B = makeIdentity('raw-ecdsa'), P = makeIdentity('webauthn');
    let r = await def.api('quota', { recipient: A.publicKeyB64 });
    check('no proof and no token: refused, no figures', r.status === 400 && !r.json.wallet, r);
    r = await def.api('quota', { recipient: A.publicKeyB64, token: '123.' + 'a'.repeat(64) });
    check('a made-up token is refused', r.status === 403 && r.json.error === 'invalid-token' && !r.json.wallet, r);
    r = await def.api('quota', { recipient: A.publicKeyB64, proof: { signerRole: 'raw-ecdsa', publicKey: A.publicKeyB64, signature: 'x' } });
    check('a bare key with no signed request is refused', r.status === 403 && !r.json.wallet, r);
    r = await ask(def, A);
    check('a signed request from the wallet is answered: 3 of 3, no wait', r.status === 200 && r.json.wallet.limit === 3 && r.json.wallet.used === 0 && r.json.wallet.remaining === 3 && r.json.wallet.nextSlotAt === null && r.json.otherLimit === null && typeof r.json.token === 'string', r);
    const tokenA = r.json.token;
    r = await ask(def, P);
    check('a passkey-style identity can ask too', r.status === 200 && r.json.wallet.remaining === 3, r);
    r = await def.api('quota', { recipient: A.publicKeyB64, token: tokenA });
    check('the token answers without another signature, and issues no new token', r.status === 200 && r.json.wallet.remaining === 3 && !('token' in r.json), r);
    r = await def.api('quota', { recipient: B.publicKeyB64, token: tokenA });
    check('one wallet\'s token cannot read another wallet', r.status === 403 && !r.json.wallet, r);
    r = await ask(def, A, { recipient: B.publicKeyB64 });
    check('a signature by one wallet cannot ask about another', r.status === 403 && !r.json.wallet, r);
    r = await ask(def, A, { payload: { recipient: B.publicKeyB64 } });
    check('a payload naming another wallet is refused', r.status === 403 && !r.json.wallet, r);
    r = await ask(def, A, { origin: 'https://evil.example' });
    check('a request signed for another origin is refused', r.status === 403 && !r.json.wallet, r);
    r = await ask(def, A, { payload: { purpose: 'atlas.studio.mint/1' } });
    check('a signature for another purpose is refused', r.status === 403 && !r.json.wallet, r);
    r = await ask(def, A, { payload: { issuedAt: Math.floor(Date.now() / 1000) - 3600 } });
    check('a request signed an hour ago is refused as expired', r.status === 410 && !r.json.wallet, r);
    const good = await signedAsk(def, A);
    const forged = JSON.parse(JSON.stringify(good));
    forged.proof.signature = good.proof.signature.slice(0, -4) + (good.proof.signature.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
    r = await def.api('quota', forged);
    check('a forged signature is refused', r.status === 403 && r.json.error === 'invalid-signature' && !r.json.wallet, r);
    const swapped = JSON.parse(JSON.stringify(await signedAsk(def, B)));
    swapped.recipient = A.publicKeyB64;
    r = await def.api('quota', swapped);
    check('a valid proof from another key cannot be presented for this wallet', r.status === 403 && !r.json.wallet, r);
    r = await def.api('quota', Object.assign({}, good, { extra: 1 }));
    check('unknown fields are refused', r.status === 400, r);
    r = await def.api('quota', { recipient: A.publicKeyB64, token: tokenA }, { Origin: 'https://evil.example' });
    check('a browser request from an origin the issuer does not list is refused', r.status === 403 && r.json.error === 'origin-not-allowed', r);
    r = await def.get('/atlas/studio/api.php?op=quota');
    check('GET is not accepted', r.status === 405, r);
    r = await def.api('quota', { recipient: A.publicKeyB64, token: tokenA });
    check('no cross-origin read headers are offered', !r.headers['access-control-allow-origin'], r.headers);

    // ---- real mints change the count; retries do not; the claim and the status agree ----
    const mint = (lab, id, name) => lab.mintAs(id, design(name));
    let m = await mint(def, A, 'One');
    check('a first mint succeeds', m.mint.status === 200 && m.mint.json.ok, m.mint);
    r = await def.api('quota', { recipient: A.publicKeyB64, token: tokenA });
    check('after one mint: 2 of 3 remaining, and the oldest use leaves the window a day after it was made', r.json.wallet.used === 1 && r.json.wallet.remaining === 2 && Math.abs(r.json.wallet.nextSlotAt - (Math.floor(Date.now() / 1000) + 86400)) < 60, r.json);
    const again = await def.api('mint', m.body);
    check('repeating the same mint returns the same credential', again.status === 200 && again.text === m.mint.text, again.status);
    r = await def.api('quota', { recipient: A.publicKeyB64, token: tokenA });
    check('a safe retry did not use another mint', r.json.wallet.used === 1 && r.json.wallet.remaining === 2 && attemptFiles(def).length === 1, { w: r.json.wallet, files: attemptFiles(def) });
    r = await def.api('quota', { recipient: B.publicKeyB64, token: (await def.api('quota', await signedAsk(def, B))).json.token });
    check('another identity still has all 3', r.json.wallet.remaining === 3 && r.json.wallet.used === 0, r.json);

    // a refused challenge or invalid design uses nothing
    const bad = await def.api('challenge', { design: Object.assign({}, DESIGN, { name: '' }), recipient: A.publicKeyB64 });
    r = await def.api('quota', { recipient: A.publicKeyB64, token: tokenA });
    check('a refused design uses nothing', bad.status === 400 && r.json.wallet.used === 1, { bad: bad.status, w: r.json.wallet });
    const declined = await def.api('challenge', { design: design('Never signed'), recipient: A.publicKeyB64 });
    r = await def.api('quota', { recipient: A.publicKeyB64, token: tokenA });
    check('a challenge that was never signed or minted uses nothing', declined.status === 200 && r.json.wallet.used === 1, r.json.wallet);

    // ---- exhaustion ----
    await mint(def, A, 'Two');
    const third = await mint(def, A, 'Three');
    check('three mints in all succeed', third.mint.status === 200, third.mint);
    r = await def.api('quota', { recipient: A.publicKeyB64, token: tokenA });
    check('exhausted: 0 of 3 remaining, with the time it is available again', r.json.wallet.used === 3 && r.json.wallet.remaining === 0 && r.json.wallet.nextSlotAt > Math.floor(Date.now() / 1000) + 86400 - 120, r.json);
    m = await mint(def, A, 'Four');
    check('the issuer refuses a fourth mint, as the status said it would', m.mint.status === 429 && m.mint.json.error === 'quota-recipient', m.mint);
    r = await def.api('quota', { recipient: A.publicKeyB64, token: tokenA });
    check('a refused mint is not counted', r.json.wallet.used === 3 && attemptFiles(def).length === 3, r.json.wallet);
    const retry3 = await def.api('mint', third.body);
    check('a retry of a mint already made still returns it at the limit, and uses nothing more', retry3.status === 200 && retry3.text === third.mint.text && attemptFiles(def).length === 3, { status: retry3.status, files: attemptFiles(def).length });

    // ---- rolling window, using the ledger's own records ----
    const files = attemptFiles(def).map((f) => path.join(def.studio, 'mint-receipts', f));
    const recs = files.map((f) => ({ f, rec: JSON.parse(fs.readFileSync(f, 'utf8')) })).sort((a, b) => a.rec.createdAt - b.rec.createdAt);
    const setAge = (i, secondsAgo) => { recs[i].rec.createdAt = Math.floor(Date.now() / 1000) - secondsAgo; fs.writeFileSync(recs[i].f, JSON.stringify(recs[i].rec)); };
    setAge(0, 86400 - 30);
    r = await def.api('quota', { recipient: A.publicKeyB64, token: tokenA });
    check('an attempt 30 seconds short of a day old still counts', r.json.wallet.used === 3 && r.json.wallet.remaining === 0, r.json.wallet);
    setAge(0, 86400 + 5);
    r = await def.api('quota', { recipient: A.publicKeyB64, token: tokenA });
    check('once it is more than a day old it no longer counts: 1 of 3 remaining', r.json.wallet.used === 2 && r.json.wallet.remaining === 1, r.json.wallet);
    m = await mint(def, A, 'Five');
    check('and the issuer allows exactly one more mint', m.mint.status === 200, m.mint);
    m = await mint(def, A, 'Six');
    check('then refuses again', m.mint.status === 429 && m.mint.json.error === 'quota-recipient', m.mint);
    setAge(1, 86400 + 5);
    setAge(2, 86400 + 5);
    r = await def.api('quota', { recipient: A.publicKeyB64, token: tokenA });
    check('two more age out: 2 of 3 remaining (the newest mint still counts)', r.json.wallet.used === 1 && r.json.wallet.remaining === 2, r.json.wallet);

    // ---- a custom limit is what is enforced and shown ----
    const C = makeIdentity();
    const tokenC = (await ask(custom, C)).json.token;
    for (let i = 1; i <= 4; i++) await mint(custom, C, 'Custom ' + i);
    r = await custom.api('quota', { recipient: C.publicKeyB64, token: tokenC });
    check('custom limit 5 with 4 used: 1 of 5 remaining', r.json.wallet.limit === 5 && r.json.wallet.used === 4 && r.json.wallet.remaining === 1, r.json.wallet);
    await mint(custom, C, 'Custom 5');
    m = await mint(custom, C, 'Custom 6');
    r = await custom.api('quota', { recipient: C.publicKeyB64, token: tokenC });
    check('the fifth succeeds and the sixth is refused: 0 of 5', m.mint.status === 429 && r.json.wallet.remaining === 0 && r.json.wallet.limit === 5, { m: m.mint.status, w: r.json.wallet });

    // ---- the status does not leak history ----
    const raw = JSON.stringify((await def.api('quota', { recipient: A.publicKeyB64, token: tokenA })).json);
    const known = fs.readdirSync(path.join(def.studio, 'mint-receipts')).filter((f) => /^attempt-/.test(f)).map((f) => f.slice(8, 72));
    check('the answer names no nonce, credential, design or other record', !known.some((n) => raw.includes(n)) && !/credential|design|nonce|urn:/i.test(raw), raw);

    // ---- limits shared with other visitors are reported apart from the wallet's share ----
    const tight = await StudioLab.start({ mint: true, config: Object.assign({}, BASE, { maxMintsPerActorPerDay: 1 }) });
    try {
      const T = makeIdentity(), U = makeIdentity();
      const tokenT = (await ask(tight, T)).json.token;
      await mint(tight, T, 'Only one');
      r = await tight.api('quota', { recipient: T.publicKeyB64, token: tokenT });
      check('the wallet has 2 of 3 left but the network limit is reached, and it is reported as that', r.json.wallet.remaining === 2 && r.json.otherLimit === 'quota-actor', r.json);
      m = await mint(tight, U, 'Refused');
      check('which is why another wallet on the same network is refused too', m.mint.status === 429 && m.mint.json.error === 'quota-actor', m.mint);
    } finally { await tight.stop(); tight.cleanup(); }
    const small = await StudioLab.start({ mint: true, config: Object.assign({}, BASE, { maxMintsPerDay: 1, newActorReserve: 0 }) });
    try {
      const T = makeIdentity();
      const tokenT = (await ask(small, T)).json.token;
      await mint(small, T, 'Day total');
      r = await small.api('quota', { recipient: T.publicKeyB64, token: tokenT });
      check('the issuer-wide daily limit is reported as such', r.json.wallet.remaining === 2 && r.json.otherLimit === 'quota-global', r.json);
    } finally { await small.stop(); small.cleanup(); }

    // ---- asking is rate limited ----
    let limited = 0;
    for (let i = 0; i < 40; i++) if ((await def.api('quota', { recipient: A.publicKeyB64, token: tokenA })).status === 429) limited++;
    check('too many lookups from one address are throttled', limited > 0, limited);
    check('the mint quota was never touched by any lookup', attemptFiles(def).length === 4, attemptFiles(def));
  } finally {
    for (const lab of [def, custom, off]) { await lab.stop(); lab.cleanup(); }
  }
  console.log(`\nasset studio quota (http): ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
