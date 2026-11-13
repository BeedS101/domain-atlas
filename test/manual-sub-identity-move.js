// Moving one asset between identities of the same wallet (docs/sub-identities.md, step 5), through the
// issuer's direct transfer. Runs the real extension in a scratch Chromium profile against a throw-away local
// issuer on localhost:8001 (see README; use an isolated state directory). Only throw-away identities are used.
//
// Run with a display and the demo issuer up on port 8001, e.g.:  xvfb-run -a node test/manual-sub-identity-move.js

const { chromium } = require('playwright');
const path = require('path');
const os = require('os');
const fs = require('fs');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const PASSWORD = 'sub-identity-move-test-password-1';
const ISSUER = 'localhost:8001';

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' :: ' + JSON.stringify(detail)));
  if (!ok) failures++;
}

async function launch() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-sub-move-'));
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = worker.url().split('/')[2];
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/viewer.html`);
  await page.waitForFunction(() => typeof AtlasWallet === 'object', null, { timeout: 10000 });
  const W = (fn, arg) => page.evaluate(fn, arg);
  const fails = async (fn, arg) => page.evaluate(async ({ src, arg }) => {
    try { await (new Function('A', 'arg', 'return (' + src + ')(A, arg)'))(AtlasWallet, arg); return null; } catch (err) { return String(err.message || err); }
  }, { src: fn.toString(), arg });
  const close = async () => { await context.close().catch(() => {}); fs.rmSync(profile, { recursive: true, force: true }); };
  return { page, W, fails, close };
}

(async () => {
  const S = await launch();
  try {
    const { W, fails, page } = S;
    const main = await W(async (pw) => (await AtlasWallet.createIdentity(pw)).publicKey, PASSWORD);
    const shopping = await W(() => AtlasWallet.createSubIdentity('Shopping'));
    const travel = await W(() => AtlasWallet.createSubIdentity('Travel'));
    const mint = (cls, qty) => W(async ({ cls, qty }) => AtlasWallet.mintAsset('self', 'localhost:8001', cls, qty), { cls, qty });
    const walletOf = (pk) => W(async (pk) => (await AtlasWallet.getWallet(pk)).map((e) => ({ id: e.credential.id, owner: e.credential.owner.publicKey, cls: e.credential.asset.class, valid: e.lastVerdict && e.lastVerdict.valid })), pk);
    const journalOf = (pk) => W(async (pk) => (await AtlasWallet.getPendingOperations(pk)).length, pk);

    console.log('--- what can be moved ---');
    await mint('atlas.demo.coupon');
    const badge = await mint('atlas.badge');
    await mint('atlas.currency.alpha', 5);
    const wallet0 = await walletOf(main);
    check('the main identity holds a coupon, a badge and a balance', wallet0.length === 3, wallet0);
    const targets = await W(() => AtlasWallet.listMoveTargets());
    check('the targets are the other identities, not the acting one', targets.map((t) => t.label).join() === 'Shopping,Travel', targets);
    check('a key that is not in this wallet is refused', /not in this wallet/.test(await fails(async (A, a) => A.moveAssetToIdentity(a.id, 'not-a-key'), { id: 'whatever' })));
    const couponId = wallet0.find((e) => e.cls === 'atlas.demo.coupon').id;
    const badgeId = wallet0.find((e) => e.cls === 'atlas.badge').id;
    const balanceId = wallet0.find((e) => e.cls === 'atlas.currency.alpha').id;
    check('an unknown item is refused', /not in the identity/.test(await fails(async (A, a) => A.moveAssetToIdentity('urn:atlas:asset:nope', a), shopping.publicKey)));
    check('a bound item is refused', /bound/.test(await fails(async (A, a) => A.moveAssetToIdentity(a.id, a.to), { id: badgeId, to: shopping.publicKey })));
    check('a fungible balance is refused', /Balances/.test(await fails(async (A, a) => A.moveAssetToIdentity(a.id, a.to), { id: balanceId, to: shopping.publicKey })));
    check('nothing was moved by the refusals', (await walletOf(main)).length === 3 && (await journalOf(main)) === 0);

    console.log('--- a move ---');
    const moved = await W(async (a) => AtlasWallet.moveAssetToIdentity(a.id, a.to), { id: couponId, to: shopping.publicKey });
    check('the new credential names the other identity', moved.credential.owner.publicKey === shopping.publicKey && moved.credential.supersedes === couponId, moved.credential);
    const mainAfter = await walletOf(main);
    check('the acting identity no longer holds it', !mainAfter.some((e) => e.id === couponId) && mainAfter.length === 2, mainAfter);
    check('the journal is empty again', (await journalOf(main)) === 0 && (await journalOf(shopping.publicKey)) === 0);
    const stored = await W(async (pk) => JSON.stringify((await chrome.storage.local.get('atlasWallets')).atlasWallets[pk]).slice(0, 60), shopping.publicKey);
    check('the other identity\'s wallet is stored encrypted', /__atlasEncrypted/.test(stored), stored);
    await W(async (id) => AtlasWallet.switchIdentity(id), shopping.id);
    const shoppingWallet = await walletOf(shopping.publicKey);
    check('the other identity reads it and it verifies', shoppingWallet.length === 1 && shoppingWallet[0].owner === shopping.publicKey && shoppingWallet[0].valid === true, shoppingWallet);
    check('the old credential is revoked at the issuer', await W(async (id) => {
      const doc = await (await fetch('http://localhost:8001/.well-known/atlas-revocations.json', { cache: 'no-store' })).json();
      return (doc.revoked || []).some((r) => r.id === id && r.reason === 'transferred');
    }, couponId));

    console.log('--- moving it back ---');
    const targetsFromShopping = await W(() => AtlasWallet.listMoveTargets());
    check('the main identity is a target from a sub-identity', targetsFromShopping.map((t) => t.label).join() === 'Main identity,Travel', targetsFromShopping);
    const back = await W(async (a) => AtlasWallet.moveAssetToIdentity(a.id, a.to), { id: shoppingWallet[0].id, to: main });
    check('it comes back to the main identity', back.credential.owner.publicKey === main && back.to.label === 'Main identity', back);
    await W(async () => AtlasWallet.switchIdentity(null));
    check('and verifies there', (await walletOf(main)).filter((e) => e.cls === 'atlas.demo.coupon').every((e) => e.valid === true && e.owner === main));
    check('the sub-identity is empty again', (await walletOf(shopping.publicKey)).length === 0);

    console.log('--- an answer that never arrives ---');
    const couponId2 = (await walletOf(main)).find((e) => e.cls === 'atlas.demo.coupon').id;
    await W(() => {
      window.__realFetch = window.fetch;
      window.__dropped = 0;
      window.fetch = async (url, opts) => {
        const res = await window.__realFetch(url, opts);
        if (typeof url === 'string' && url.endsWith('/atlas/asset/transfer') && window.__dropped === 0) {
          window.__dropped++;
          await res.text();
          throw new TypeError('network error (answer lost)');
        }
        return res;
      };
    });
    const lost = await fails(async (A, a) => A.moveAssetToIdentity(a.id, a.to), { id: couponId2, to: shopping.publicKey });
    check('the move reports that it is saved and will be retried', /saved and will be retried/.test(lost), lost);
    check('the issuer did complete it: the journal still holds the request', (await journalOf(main)) === 1);
    check('the original is held back, not shown as verified', await W(async (a) => {
      const held = (await AtlasWallet.getWallet(a.pk)).find((e) => e.credential.id === a.id);
      return !!held && held.lastVerdict && held.lastVerdict.valid === false && !!held.pendingOutcome;
    }, { pk: main, id: couponId2 }));
    check('removing the receiving identity is refused while the move is unfinished', /move to this identity is unfinished/.test(await fails(async (A, id) => A.removeSubIdentity(id), shopping.id)));
    check('exporting the receiving identity is refused too', /unfinished/.test(await fails(async (A, a) => A.prepareSubIdentityExport(a.id, { password: a.pw }), { id: shopping.id, pw: PASSWORD })));
    const outcomes = await W(async (pk) => AtlasWallet.recoverPendingOperations(pk), main);
    check('recovery asks again and the issuer returns the same result', outcomes.length === 1 && outcomes[0].status === 'completed', outcomes);
    await W(() => { window.fetch = window.__realFetch; });
    check('and gone from the sender', !(await walletOf(main)).some((e) => e.id === couponId2) && (await journalOf(main)) === 0);
    await W(async (id) => AtlasWallet.switchIdentity(id), shopping.id);
    const received = (await walletOf(shopping.publicKey)).filter((e) => e.cls === 'atlas.demo.coupon');
    check('the item is in the other identity exactly once, and verifies', received.length === 1 && received[0].valid === true && received[0].owner === shopping.publicKey, received);
    await W(async () => AtlasWallet.switchIdentity(null));

    console.log('--- removal rules after a move ---');
    check('an identity that now holds the item cannot be removed', /still holds items/.test(await fails(async (A, id) => A.removeSubIdentity(id), shopping.id)));
    check('an empty identity can be removed once nothing is unfinished', await W(async (id) => AtlasWallet.removeSubIdentity(id), travel.id) === true);

    console.log('--- the issuer answers a repeat without making a second item ---');
    const direct = await page.evaluate(async ({ owner, ownerKey }) => {
      const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      const pub = b64(await crypto.subtle.exportKey('raw', pair.publicKey));
      const post = async (path, body) => {
        const res = await fetch('http://localhost:8001' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        return { status: res.status, body: await res.json().catch(() => null) };
      };
      const minted = await post('/atlas/asset/issue', { ownerPublicKey: pub, assetClass: 'atlas.demo.coupon' });
      const canon = (v) => JSON.stringify(v, Object.keys(v).sort());
      // The wallet's canonicalize is the issuer's: sorted keys, no spaces. These payloads are flat.
      const sign = async (payload) => {
        const key = await crypto.subtle.importKey('jwk', await crypto.subtle.exportKey('jwk', pair.privateKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
        const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(canon(payload)));
        return { signerRole: 'raw-ecdsa', publicKey: pub, signature: b64(sig) };
      };
      const credential = minted.body;
      const requestId = b64(crypto.getRandomValues(new Uint8Array(18)).buffer);
      const payload = { action: 'transfer', credentialId: credential.id, recipientPublicKey: ownerKey, requestId };
      const body = { credential, recipientPublicKey: ownerKey, intent: { payload, proof: await sign(payload) }, requestId };
      const first = await post('/atlas/asset/transfer', body);
      const again = await post('/atlas/asset/transfer', body);
      const otherRecipient = { ...body, recipientPublicKey: pub + 'x' };
      const conflictPayload = { action: 'transfer', credentialId: credential.id, recipientPublicKey: pub + 'x', requestId };
      otherRecipient.intent = { payload: conflictPayload, proof: await sign(conflictPayload) };
      const conflict = await post('/atlas/asset/transfer', otherRecipient);
      const noId = { ...body }; delete noId.requestId;
      const wrongIntent = { ...body, requestId: b64(crypto.getRandomValues(new Uint8Array(18)).buffer) };
      const mismatched = await post('/atlas/asset/transfer', wrongIntent);
      const capabilities = await (await fetch('http://localhost:8001/atlas/capabilities')).json();
      return { first, again, conflict, mismatched, capabilities };
    }, { owner: null, ownerKey: main });
    check('the first request transfers', direct.first.status === 200 && direct.first.body.status === 'transferred', direct.first);
    check('a repeat returns the very same credential', direct.again.status === 200 && JSON.stringify(direct.again.body) === JSON.stringify(direct.first.body), direct.again);
    check('the same id for a different recipient is a conflict', direct.conflict.status === 409 && direct.conflict.body.code === 'request-id-conflict', direct.conflict);
    check('a requestId the intent does not name is refused', direct.mismatched.status === 403, direct.mismatched);
    check('the issuer lists transfer as repeatable', direct.capabilities.requestIds.operations.includes('transfer'), direct.capabilities);
  } finally {
    await S.close();
  }
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL SUB-IDENTITY MOVE CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error('ERROR', err); process.exit(1); });
