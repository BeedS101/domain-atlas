// Per-site identities (docs/sub-identities.md, step 6): a site is answered by the identity bound to its exact
// origin, asks once when it has none, and the wallet window never changes. Runs the real extension in a scratch
// Chromium profile against a throw-away local issuer on its own port; two origins (localhost and 127.0.0.1) are
// two sites. Throw-away identities only; nothing here touches a live site.
//
// Run with a display, e.g.:  xvfb-run -a node test/manual-site-identities.js

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const PORT = 8241;
const DOMAIN = 'localhost:' + PORT;
const SITE_A = 'http://localhost:' + PORT;
const SITE_B = 'http://127.0.0.1:' + PORT;
const PASSWORD = 'site-identities-test-password-1';
const DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-site-id-docroot-'));
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-site-id-state-'));
const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-site-id-profile-'));

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' :: ' + JSON.stringify(detail)));
  if (!ok) failures++;
}

const SPATIAL_JSON = {
  spec: 'domain-atlas/1.0',
  domain: DOMAIN,
  owner: { name: 'Site Identity Test Domain', contact: 'demo@localhost' },
  walletBridge: { read: true, sign: ['login'] },
  defaultWorld: 'lobby',
  worlds: [{
    id: 'lobby',
    name: 'Site Identity Lobby',
    entry: { scene: '/spatial/lobby/scene.json', renderer: ['procedural-v1'] },
    policy: { guestAccess: 'open', discoverable: true, identityRequired: false, itemDropsAllowed: false, acceptedItemClasses: [], trustedIssuers: 'any' }
  }],
  updated: '2026-10-06T00:00:00Z'
};
const SCENE = { format: 'procedural-v1', floor: { size: [10, 10], color: '#1b2830' }, objects: [], portalMarkers: [], anchors: [] };

async function startIssuer() {
  fs.mkdirSync(path.join(DOCROOT_DIR, '.well-known'), { recursive: true });
  fs.mkdirSync(path.join(DOCROOT_DIR, 'spatial', 'lobby'), { recursive: true });
  fs.writeFileSync(path.join(DOCROOT_DIR, '.well-known', 'spatial.json'), JSON.stringify(SPATIAL_JSON, null, 2));
  fs.writeFileSync(path.join(DOCROOT_DIR, 'spatial', 'lobby', 'scene.json'), JSON.stringify(SCENE));
  fs.writeFileSync(path.join(DOCROOT_DIR, 'page.html'),
    '<!doctype html><html><head><meta charset="utf-8"><title>Site</title><link rel="spatial" href="/.well-known/spatial.json"></head><body>site</body></html>');
  const proc = spawn('node', ['issuer-server/server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), ATLAS_DOMAIN: DOMAIN, ATLAS_STATE_DIR: STATE_DIR, ATLAS_DOCROOT: DOCROOT_DIR },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('issuer-server did not start in time')), 10000);
    proc.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); resolve(); } });
    proc.on('exit', (code) => reject(new Error('issuer-server exited early with code ' + code)));
  });
  return proc;
}

(async () => {
  const server = await startIssuer();
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
    const extId = worker.url().split('/')[2];
    const wallet = await context.newPage();
    await wallet.goto(`chrome-extension://${extId}/viewer.html`);
    await wallet.waitForFunction(() => typeof AtlasWallet === 'object', null, { timeout: 10000 });
    const W = (fn, arg) => wallet.evaluate(fn, arg);
    const fails = async (fn, arg) => wallet.evaluate(async ({ src, arg }) => {
      try { await (new Function('A', 'arg', 'return (' + src + ')(A, arg)'))(AtlasWallet, arg); return null; } catch (err) { return String(err.message || err); }
    }, { src: fn.toString(), arg });

    const main = await W(async (pw) => (await AtlasWallet.createIdentity(pw)).publicKey, PASSWORD);

    // A site page: opens it and asks the wallet for an identity (or a signature).
    const openSite = async (origin) => {
      const p = await context.newPage();
      await p.goto(origin + '/page.html', { waitUntil: 'load' });
      return p;
    };
    const frameOf = (p) => p.frameLocator('#domain-atlas-bridge-confirm');

    console.log('--- an account with nothing to choose between ---');
    let pageA = await openSite(SITE_A);
    const first = await pageA.evaluate(() => window.atlasWallet.getIdentity());
    check('a site gets the main identity with no prompt', first.allowed === true && first.publicKey === main && await pageA.locator('#domain-atlas-bridge-confirm').count() === 0, first);
    check('the storage layer agrees', (await W(async (o) => AtlasWallet.getSiteIdentity(o), SITE_A)).state === 'default');
    check('an address that is not a site origin is refused', /site address/.test(await fails(async (A) => A.setSiteIdentity('localhost:8241/page.html', 'x'))));

    console.log('--- first contact asks ---');
    const shopping = await W(() => AtlasWallet.createSubIdentity('Shopping'));
    check('with a second identity a site that has no binding must ask', (await W(async (o) => AtlasWallet.getSiteIdentity(o), SITE_A)).state === 'ask');
    const askA = pageA.evaluate(() => window.atlasWallet.getIdentity());
    await pageA.waitForSelector('#domain-atlas-bridge-confirm', { timeout: 10000 });
    let f = frameOf(pageA);
    await f.locator('#identityState').waitFor({ state: 'visible', timeout: 10000 });
    check('the prompt names the exact origin', (await f.locator('#identityOrigin').innerText()) === SITE_A);
    check('it offers a new identity, the current one, and another one', await f.locator('#identityCreate').count() === 1 && /Use Main identity/.test(await f.locator('#identityCurrent').innerText()) && await f.locator('#identityOther').count() === 1);
    check('remembering is ticked by default', await f.locator('#identityRemember').isChecked());
    await f.locator('#identityCreate').click();
    const gotA = await askA;
    const listAfterCreate = await W(() => AtlasWallet.listSubIdentities());
    const siteIdentityA = listAfterCreate.find((e) => e.label === DOMAIN);
    check('a new identity named for the site was made', !!siteIdentityA && siteIdentityA.active === false, listAfterCreate);
    check('the site is answered by that identity', gotA.allowed && gotA.publicKey === siteIdentityA.publicKey, gotA);
    check('the wallet window is still on the main identity', (await W(() => AtlasWallet.getActiveIdentityInfo())).kind === 'main' && (await W(async () => (await AtlasWallet.getIdentity()).publicKey)) === main);
    const again = await pageA.evaluate(() => window.atlasWallet.getIdentity());
    check('the next request is answered with no prompt', again.publicKey === siteIdentityA.publicKey && await pageA.locator('#domain-atlas-bridge-confirm').count() === 0, again);
    check('the binding is remembered and listed', JSON.stringify((await W(() => AtlasWallet.listSiteIdentities())).map((s) => [s.origin, s.label])) === JSON.stringify([[SITE_A, DOMAIN]]));

    console.log('--- a second site chooses another identity, at the same time ---');
    const pageB = await openSite(SITE_B);
    const askB = pageB.evaluate(() => window.atlasWallet.getIdentity());
    await pageB.waitForSelector('#domain-atlas-bridge-confirm', { timeout: 10000 });
    f = frameOf(pageB);
    await f.locator('#identityState').waitFor({ state: 'visible', timeout: 10000 });
    check('a look-alike address asks separately', (await f.locator('#identityOrigin').innerText()) === SITE_B);
    await f.locator('#identityOther').click();
    await f.locator('#identityPick').selectOption({ label: 'Shopping' });
    await f.locator('#identityUsePick').click();
    const gotB = await askB;
    check('site B is answered by the identity it chose', gotB.publicKey === shopping.publicKey, gotB);
    const bothNow = [await pageA.evaluate(() => window.atlasWallet.getIdentity()), await pageB.evaluate(() => window.atlasWallet.getIdentity())];
    check('two tabs are answered by two identities at once', bothNow[0].publicKey === siteIdentityA.publicKey && bothNow[1].publicKey === shopping.publicKey && bothNow[0].publicKey !== bothNow[1].publicKey, bothNow);

    console.log('--- signing is done by the site\'s identity ---');
    const signPromise = pageB.evaluate(() => window.atlasWallet.requestSignature({ purpose: 'login', nonce: 'n-1' }));
    await pageB.waitForSelector('#domain-atlas-bridge-confirm', { timeout: 10000 });
    f = frameOf(pageB);
    await f.locator('#readyState').waitFor({ state: 'visible', timeout: 10000 });
    await f.locator('#actingAs').waitFor({ state: 'visible', timeout: 10000 });
    const actingText = await f.locator('#actingAs').innerText();
    check('the prompt says who is acting', /Acting as Shopping/.test(actingText), actingText);
    await f.locator('#approveBtn').click();
    const signed = await signPromise;
    check('the signature is by the site\'s identity, not the selected one', signed.allowed && signed.result && signed.result.publicKey === shopping.publicKey, signed.result && signed.result.publicKey);
    check('and it verifies', await W(async ({ payload, env }) => AtlasWallet.verifySignedPayload(payload, env), { payload: signed.result.signedPayload, env: (({ signedPayload, ...e }) => e)(signed.result) }));
    check('the wallet window is still on the main identity', (await W(() => AtlasWallet.getActiveIdentityInfo())).kind === 'main');

    console.log('--- changing and forgetting ---');
    await W(async ({ o, pk }) => AtlasWallet.setSiteIdentity(o, pk), { o: SITE_A, pk: main });
    check('changing a binding takes effect at once', (await pageA.evaluate(() => window.atlasWallet.getIdentity())).publicKey === main);
    await W(async (o) => AtlasWallet.forgetSiteIdentity(o), SITE_A);
    check('a forgotten site asks again', (await W(async (o) => AtlasWallet.getSiteIdentity(o), SITE_A)).state === 'ask');

    console.log('--- not now ---');
    const askDecline = pageA.evaluate(() => window.atlasWallet.getIdentity());
    await pageA.waitForSelector('#domain-atlas-bridge-confirm', { timeout: 10000 });
    await frameOf(pageA).locator('#identityCancel').click();
    const declined = await askDecline;
    check('declining answers nothing', declined.allowed === true && declined.publicKey === null, declined);
    const quick = await pageA.evaluate(() => window.atlasWallet.getIdentity());
    check('and does not ask again straight away', quick.publicKey === null && await pageA.locator('#domain-atlas-bridge-confirm').count() === 0, quick);
    await pageA.reload({ waitUntil: 'load' });

    console.log('--- a choice that is not remembered ---');
    const askOnce = pageA.evaluate(() => window.atlasWallet.getIdentity());
    askOnce.catch(() => {});
    await pageA.waitForSelector('#domain-atlas-bridge-confirm', { timeout: 10000 });
    f = frameOf(pageA);
    await f.locator('#identityState').waitFor({ state: 'visible', timeout: 10000 });
    await f.locator('#identityRemember').uncheck();
    await f.locator('#identityCurrent').click();
    const onceKey = (await askOnce).publicKey;
    check('the site is answered by the chosen identity', onceKey === main, onceKey);
    check('without being listed as remembered', (await W(() => AtlasWallet.listSiteIdentities())).every((s) => s.origin !== SITE_A));
    check('and without asking again while the wallet stays unlocked', (await pageA.evaluate(() => window.atlasWallet.getIdentity())).publicKey === main && await pageA.locator('#domain-atlas-bridge-confirm').count() === 0);

    console.log('--- identities that go away take their bindings ---');
    const doomed = await W(async (o) => (await AtlasWallet.createSiteIdentity(o, { remember: true })).publicKey, SITE_A);
    const doomedEntry = (await W(() => AtlasWallet.listSubIdentities())).find((e) => e.publicKey === doomed);
    check('a site can be bound to a freshly made identity', (await W(() => AtlasWallet.listSiteIdentities())).some((s) => s.origin === SITE_A && s.publicKey === doomed));
    await W(async (id) => AtlasWallet.removeSubIdentity(id), doomedEntry.id);
    check('removing the identity drops the binding', (await W(() => AtlasWallet.listSiteIdentities())).every((s) => s.origin !== SITE_A));
    check('so the site asks again', (await W(async (o) => AtlasWallet.getSiteIdentity(o), SITE_A)).state === 'ask');

    console.log('--- per-identity bridge stores work for an identity that is not selected ---');
    await W(async ({ pk, o }) => AtlasWallet.trustBridgeDomain(pk, o), { pk: shopping.publicKey, o: SITE_B });
    check('trusting a site for another identity is stored under that identity', await W(async ({ pk, o }) => AtlasWallet.isTrustedBridgeDomain(pk, o), { pk: shopping.publicKey, o: SITE_B }));
    check('and is not trusted for the main identity', !(await W(async ({ pk, o }) => AtlasWallet.isTrustedBridgeDomain(pk, o), { pk: main, o: SITE_B })));
    check('its offers can be read without selecting it', Array.isArray(await W(async (pk) => AtlasWallet.getBridgeOffers(pk), shopping.publicKey)));
    check('the wallet window is still on the main identity', (await W(() => AtlasWallet.getActiveIdentityInfo())).kind === 'main');

    console.log('--- at rest and in backups ---');
    await W(async ({ o, pk }) => AtlasWallet.setSiteIdentity(o, pk), { o: SITE_A, pk: shopping.publicKey });
    const stored = JSON.stringify(await W(async (m) => (await chrome.storage.local.get('atlasSubIdentities')).atlasSubIdentities[m], main));
    check('bindings sit inside the encrypted vault', !stored.includes('127.0.0.1') && !stored.includes('localhost') && !stored.includes('siteBindings'), stored.slice(0, 100));
    const backup = await W(async (pw) => AtlasWallet.exportFullBackup(pw, 'amber anchor apple arrow aspen atlas aurora autumn'), PASSWORD);
    const fresh = await context.newPage();
    await fresh.goto(`chrome-extension://${extId}/viewer.html`);
    const payload = await fresh.evaluate(async ({ file, pw, seed }) => {
      const b = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
      const digests = await Promise.all([pw, seed].map((s) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
      const combined = new Uint8Array(64);
      digests.forEach((d, i) => combined.set(new Uint8Array(d), i * 32));
      const base = await crypto.subtle.importKey('raw', combined, 'PBKDF2', false, ['deriveKey']);
      const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: b(file.salt), iterations: file.kdfIterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
      return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b(file.iv) }, key, b(file.ciphertext))));
    }, { file: backup, pw: PASSWORD, seed: 'amber anchor apple arrow aspen atlas aurora autumn' });
    check('the backup lists the remembered sites by identity key', Array.isArray(payload.siteIdentities) && payload.siteIdentities.length === 2
      && payload.siteIdentities.some((s) => s.origin === SITE_A && s.identity === shopping.publicKey)
      && payload.siteIdentities.some((s) => s.origin === SITE_B && s.identity === shopping.publicKey), payload.siteIdentities);
    await fresh.close();

    console.log(failures ? '\n' + failures + ' CHECK(S) FAILED' : '\nALL CHECKS PASSED');
  } finally {
    await context.close().catch(() => {});
    server.kill();
    for (const d of [DOCROOT_DIR, STATE_DIR, PROFILE_DIR]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (err) { /* scratch */ } }
  }
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
