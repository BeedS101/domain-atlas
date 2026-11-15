// Audit regression for per-site identities: a hostile page cannot obtain another site's identity or a signature from
// one; a locked wallet answers nothing; a site that must ask never gets an identity before the person chooses; and a
// site whose bound identity no longer exists asks again instead of silently being answered by the main identity.
// Three origins (localhost, 127.0.0.1, 127.0.0.2) are three sites on one throw-away issuer. Nothing here touches a
// live site.
//
// Run with a display, e.g.:  xvfb-run -a node test/manual-site-identity-audit.js

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const BP = require('./lib/bridge-prompt');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const PORT = 8244;
const DOMAIN = 'localhost:' + PORT;
const SITE_A = 'http://localhost:' + PORT;
const SITE_B = 'http://127.0.0.1:' + PORT;
const SITE_C = 'http://127.0.0.2:' + PORT;
const PASSWORD = 'site-audit-test-password-1';
const DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-site-audit-docroot-'));
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-site-audit-state-'));
const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-site-audit-profile-'));

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
    const main = await W(async (pw) => (await AtlasWallet.createIdentity(pw)).publicKey, PASSWORD);
    const work = await W(() => AtlasWallet.createSubIdentity('Work'));
    const shopping = await W(() => AtlasWallet.createSubIdentity('Shopping'));
    await W(async ({ a, b, w, s }) => { await AtlasWallet.setSiteIdentity(a, w); await AtlasWallet.setSiteIdentity(b, s); }, { a: SITE_A, b: SITE_B, w: work.publicKey, s: shopping.publicKey });
    const openSite = async (origin) => { const p = await context.newPage(); await p.goto(origin + '/page.html', { waitUntil: 'load' }); return p; };
    const verifies = (signed) => W(async ({ payload, env }) => AtlasWallet.verifySignedPayload(payload, env), { payload: signed.result.signedPayload, env: (({ signedPayload, ...e }) => e)(signed.result) });

    console.log('--- a hostile page cannot borrow another site\'s identity ---');
    const pageA = await openSite(SITE_A);
    const pageB = await openSite(SITE_B);
    const idA = await pageA.evaluate(() => window.atlasWallet.getIdentity());
    const idB = await pageB.evaluate(() => window.atlasWallet.getIdentity());
    check('each site is answered by its own identity', idA.publicKey === work.publicKey && idB.publicKey === shopping.publicKey, { idA, idB });
    check('the wallet window is on the main identity', (await W(() => AtlasWallet.getActiveIdentityInfo())).kind === 'main');

    // Site B (hostile) claims to be site A in every field it controls.
    const forged = await pageB.evaluate(async ({ a, w }) => {
      const answers = [];
      const waitFor = (id) => new Promise((res) => {
        const h = (e) => { if (e.data && e.data.__atlasBridge && e.data.requestId === id && e.data.direction === 'to-page') { window.removeEventListener('message', h); res(e.data.result); } };
        window.addEventListener('message', h);
        setTimeout(() => res('timeout'), 6000);
      });
      // A raw message in the bridge's own protocol, naming site A and A's identity everywhere it can.
      window.postMessage({ __atlasBridge: true, direction: 'to-content', requestId: 900001, action: 'getIdentity', payload: { origin: a, publicKey: w, identity: w } }, location.origin);
      answers.push(await waitFor(900001));
      return answers;
    }, { a: SITE_A, w: work.publicKey });
    check('a forged bridge message naming site A still gets site B\'s identity', forged[0] && forged[0].publicKey === shopping.publicKey, forged);

    const signPromise = pageB.evaluate(({ a, w }) => window.atlasWallet.requestSignature({ purpose: 'login', nonce: 'n-evil', origin: a, ctx: 'atlas.bridge.sign/1', publicKey: w, identity: w, asIdentity: w }), { a: SITE_A, w: work.publicKey });
    const promptB = await BP.wait(pageB, { timeout: 10000 });
    await promptB.locator('#readyState').waitFor({ state: 'visible', timeout: 10000 });
    check('the prompt shows the real requesting origin and the identity acting', (await promptB.locator('#origin').innerText()) === SITE_B && /Acting as Shopping/.test(await promptB.locator('#actingAs').innerText()));
    await promptB.locator('#approveBtn').click();
    const signed = await signPromise;
    check('the signature is by site B\'s identity, whatever the payload claims', signed.allowed && signed.result.publicKey === shopping.publicKey && signed.result.publicKey !== work.publicKey, signed.result && signed.result.publicKey);
    check('the signed envelope names the real origin; the page\'s claim stays inside its own payload', signed.result.signedPayload.origin === SITE_B && signed.result.signedPayload.ctx === 'atlas.bridge.sign/1' && signed.result.signedPayload.payload.origin === SITE_A, signed.result.signedPayload);
    check('and it verifies', await verifies(signed));

    // A cross-origin frame inside site B has no bridge to ask with.
    const frameHasBridge = await pageB.evaluate(async (src) => {
      const f = document.createElement('iframe');
      f.src = src; document.body.appendChild(f);
      await new Promise((r) => { f.onload = r; setTimeout(r, 5000); });
      try { return String(typeof f.contentWindow.atlasWallet); } catch (err) { return 'cross-origin'; }
    }, SITE_A + '/page.html');
    check('a site-A frame inside site B cannot call the bridge from site B\'s page', frameHasBridge === 'cross-origin');
    const frames = pageB.frames().filter((f) => f.url().startsWith(SITE_A));
    check('and has no wallet bridge of its own (only top frames get one)', frames.length === 1 && await frames[0].evaluate(() => typeof window.atlasWallet) === 'undefined');

    console.log('--- the extension\'s own addresses are not sites ---');
    for (const bad of ['chrome-extension://' + extId, 'null', 'file:///tmp/x', SITE_A + '/path', SITE_A + '?x=1', 'http://user@127.0.0.1:' + PORT]) {
      const err = await wallet.evaluate(async (o) => { try { await AtlasWallet.getSiteIdentity(o); return null; } catch (e) { return String(e.message); } }, bad);
      check('getSiteIdentity refuses ' + JSON.stringify(bad), /site address/.test(err || ''), err);
    }

    console.log('--- a site with no binding must ask, and gets nothing before the person chooses ---');
    const pageC = await openSite(SITE_C);
    const askC = pageC.evaluate(() => window.atlasWallet.getIdentity());
    const promptC = await BP.wait(pageC, { timeout: 10000 });
    await promptC.locator('#identityState').waitFor({ state: 'visible', timeout: 10000 });
    check('the prompt names the exact origin', (await promptC.locator('#identityOrigin').innerText()) === SITE_C);
    const early = await W(async (o) => AtlasWallet.getSiteIdentity(o), SITE_C);
    check('until the person chooses, the site is "ask" and no key is exposed', early.state === 'ask' && !early.publicKey, early);
    await promptC.locator('#identityCancel').click();
    const declined = await askC;
    check('declining gives the site nothing', declined.publicKey === null, declined);
    const signC = await pageC.evaluate(() => window.atlasWallet.requestSignature({ purpose: 'login', nonce: 'n-c' }));
    check('and no signature, and no new prompt, during the decline window', signC.allowed === false && signC.result === null && await BP.count(pageC) === 0, signC);

    console.log('--- a locked wallet answers nothing ---');
    await W(() => AtlasWallet.lockIdentity());
    const lockedId = await pageA.evaluate(() => window.atlasWallet.getIdentity());
    check('a locked wallet gives no identity', lockedId.publicKey === null, lockedId);
    const lockedSign = pageA.evaluate(() => window.atlasWallet.requestSignature({ purpose: 'login', nonce: 'n-locked' }));
    const lockedPrompt = await BP.wait(pageA, { timeout: 10000 });
    await lockedPrompt.locator('#lockedState').waitFor({ state: 'visible', timeout: 10000 });
    check('a signing request while locked shows the locked state with nothing to approve', !(await lockedPrompt.locator('#approveBtn').isVisible()));
    await lockedPrompt.locator('#dismissBtn').click();
    const lockedResult = await lockedSign;
    check('and returns no signature', !lockedResult.result, lockedResult);
    await W(async (pw) => AtlasWallet.unlockIdentity(pw), PASSWORD);
    check('after unlocking, the binding is intact', (await pageA.evaluate(() => window.atlasWallet.getIdentity())).publicKey === work.publicKey);

    console.log('--- switching the wallet window changes nothing for sites ---');
    await W(async (id) => AtlasWallet.switchIdentity(id), shopping.id);
    const afterSwitch = [await pageA.evaluate(() => window.atlasWallet.getIdentity()), await pageB.evaluate(() => window.atlasWallet.getIdentity())];
    check('both sites keep their own identity', afterSwitch[0].publicKey === work.publicKey && afterSwitch[1].publicKey === shopping.publicKey, afterSwitch);
    await W(async () => AtlasWallet.switchIdentity(null));

    console.log('--- a site whose identity is gone asks again instead of being answered by the main identity ---');
    await W(async (id) => AtlasWallet.removeSubIdentity(id), work.id);
    const stale = await W(async (o) => AtlasWallet.getSiteIdentity(o), SITE_A);
    check('site A, bound to a removed identity, is not answered by the main identity', stale.state === 'ask' && !stale.publicKey, stale);
    const siteBStill = await W(async (o) => AtlasWallet.getSiteIdentity(o), SITE_B);
    check('site B, bound to a different identity, is unaffected', siteBStill.state === 'bound' && siteBStill.publicKey === shopping.publicKey, siteBStill);
    const askAgain = pageA.evaluate(() => window.atlasWallet.getIdentity());
    askAgain.catch(() => {});
    const promptA = await BP.wait(pageA, { timeout: 10000 });
    await promptA.locator('#identityState').waitFor({ state: 'visible', timeout: 10000 });
    check('the page is asked, and gets no key before the person chooses', (await promptA.locator('#identityOrigin').innerText()) === SITE_A);
    await promptA.locator('#identityCancel').click();
    const refused = await askAgain;
    check('declining leaves the site without an identity', refused.publicKey === null, refused);
    await pageA.reload({ waitUntil: 'load' });
    const chooseMain = pageA.evaluate(() => window.atlasWallet.getIdentity());
    const promptA2 = await BP.wait(pageA, { timeout: 10000 });
    await promptA2.locator('#identityCurrent').click();
    const chosen = await chooseMain;
    check('choosing the main identity answers with it and remembers the choice', chosen.publicKey === main && (await W(async (o) => AtlasWallet.getSiteIdentity(o), SITE_A)).state === 'bound');

    console.log('--- with no sub-identity left, a site that was bound to one still asks ---');
    await W(async (id) => AtlasWallet.removeSubIdentity(id), shopping.id);
    check('the account has only its main identity', (await W(() => AtlasWallet.listSubIdentities())).length === 0);
    const orphaned = await W(async (o) => AtlasWallet.getSiteIdentity(o), SITE_B);
    check('site B, bound to the removed identity, is not given the main identity', orphaned.state === 'ask' && !orphaned.publicKey, orphaned);
    const fresh = await W(async (o) => AtlasWallet.getSiteIdentity(o), SITE_C);
    check('a site that never had a binding gets the only identity there is, with no prompt', fresh.state === 'default' && fresh.publicKey === main, fresh);

    console.log(failures ? '\n' + failures + ' CHECK(S) FAILED' : '\nALL CHECKS PASSED');
  } finally {
    await context.close().catch(() => {});
    server.kill();
    for (const d of [DOCROOT_DIR, STATE_DIR, PROFILE_DIR]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (err) { /* scratch */ } }
  }
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
