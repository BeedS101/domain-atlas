// Sub-identities, storage layer (docs/sub-identities.md, step 1). Runs the real extension in a scratch Chromium
// profile and drives AtlasWallet from an extension page. Only throw-away identities are created; nothing
// contacts an issuer, a ledger or a site.
//
// Run with a display, e.g.:  xvfb-run -a node test/manual-sub-identities.js

const { chromium } = require('playwright');
const path = require('path');
const os = require('os');
const fs = require('fs');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const PASSWORD = 'sub-identities-test-password-1';
const SEED = 'amber anchor apple arrow aspen atlas aurora autumn';

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' :: ' + JSON.stringify(detail)));
  if (!ok) failures++;
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-sub-identities-'));
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
    const extId = worker.url().split('/')[2];
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extId}/viewer.html`);
    await page.waitForFunction(() => typeof AtlasWallet === 'object', null, { timeout: 10000 });
    const W = (fn, arg) => page.evaluate(fn, arg);
    const fails = async (fn, arg) => page.evaluate(async ({ src, arg }) => {
      try { await (new Function('A', 'arg', 'return (' + src + ')(A, arg)'))(AtlasWallet, arg); return null; } catch (err) { return String(err.message || err); }
    }, { src: fn.toString(), arg });

    console.log('--- a fresh account has none ---');
    check('nothing to list before there is an identity', /Unlock/.test(await fails(async (A) => A.listSubIdentities())));
    const main = await W(async (pw) => (await AtlasWallet.createIdentity(pw)).publicKey, PASSWORD);
    check('a new account has no sub-identities', (await W(() => AtlasWallet.listSubIdentities())).length === 0);
    check('the main identity is active', (await W(() => AtlasWallet.getActiveIdentityInfo())).kind === 'main');
    check('getIdentity is the main identity', (await W(async () => (await AtlasWallet.getIdentity()).publicKey)) === main);

    console.log('--- creating and naming ---');
    const sandbox = await W(() => AtlasWallet.createSubIdentity('  Sandbox   One '));
    check('a name is trimmed and collapsed', sandbox.label === 'Sandbox One', sandbox);
    check('a new sub-identity is not active', sandbox.active === false && sandbox.publicKey && sandbox.publicKey !== main, sandbox);
    check('the list never carries a private key', !JSON.stringify(await W(() => AtlasWallet.listSubIdentities())).includes('"d"'));
    check('an empty name is refused', /name/i.test(await fails(async (A) => A.createSubIdentity('   '))));
    check('a name over 40 characters is refused', /40/.test(await fails(async (A) => A.createSubIdentity('x'.repeat(41)))));
    check('names are unique ignoring case', /already/.test(await fails(async (A) => A.createSubIdentity('SANDBOX one'))));
    const trading = await W(() => AtlasWallet.createSubIdentity('Trading'));
    const renamed = await W(async (id) => AtlasWallet.renameSubIdentity(id, 'Trading desk'), trading.id);
    check('rename works', renamed.label === 'Trading desk', renamed);
    check('rename cannot collide with another name', /already/.test(await fails(async (A, id) => A.renameSubIdentity(id, 'sandbox one'), trading.id)));
    check('the same name is fine for the identity being renamed', (await W(async (id) => AtlasWallet.renameSubIdentity(id, 'TRADING DESK'), trading.id)).label === 'TRADING DESK');

    console.log('--- the vault at rest ---');
    const stored = await W(async (m) => (await chrome.storage.local.get('atlasSubIdentities')).atlasSubIdentities[m], main);
    const storedText = JSON.stringify(stored);
    check('the vault is encrypted at rest', stored && stored.__atlasEncrypted === true, stored);
    check('no name or key appears in the stored vault', !/Sandbox|TRADING|"d"|privateKeyJwk/.test(storedText) && !storedText.includes(sandbox.publicKey), storedText.slice(0, 120));

    console.log('--- switching ---');
    const sw = await W(async (id) => AtlasWallet.switchIdentity(id), sandbox.id);
    check('switching reports the new identity', sw.kind === 'sub' && sw.id === sandbox.id && sw.publicKey === sandbox.publicKey, sw);
    check('getIdentity is now the sub-identity', (await W(async () => (await AtlasWallet.getIdentity()).publicKey)) === sandbox.publicKey);
    check('the account identity is still the main one', (await W(async () => (await AtlasWallet.getAccountIdentity()).publicKey)) === main);
    check('the list marks only the active one', JSON.stringify((await W(() => AtlasWallet.listSubIdentities())).map((e) => e.active)) === '[true,false]');
    const signedAsSub = await W(async () => {
      const payload = { purpose: 'test', n: 1 };
      const env = await AtlasWallet.signWithSelf(payload);
      return { pk: env.publicKey, ok: await AtlasWallet.verifySignedPayload(payload, env) };
    });
    check('signing is done as the sub-identity', signedAsSub.pk === sandbox.publicKey && signedAsSub.ok === true, signedAsSub);

    console.log('--- data follows the active identity ---');
    await W(() => AtlasWallet.addFriend('friend-key-for-sandbox', 'Sandbox Pal'));
    check('the sub-identity sees its own friend', (await W(async () => (await AtlasWallet.getFriends()).map((f) => f.name))).join() === 'Sandbox Pal');
    await W(async () => AtlasWallet.switchIdentity(null));
    check('back on main, the sub-identity\'s friend is not shown', (await W(async () => (await AtlasWallet.getFriends()).length)) === 0);
    const afterMain = await W(async () => ({ pk: (await AtlasWallet.getIdentity()).publicKey, info: await AtlasWallet.getActiveIdentityInfo() }));
    check('switching to null returns to the main identity', afterMain.pk === main && afterMain.info.kind === 'main', afterMain);
    await W(() => AtlasWallet.addFriend('friend-key-for-main', 'Main Pal'));
    await W(async (id) => AtlasWallet.switchIdentity(id), sandbox.id);
    check('the sub-identity does not see main\'s friend', (await W(async () => (await AtlasWallet.getFriends()).map((f) => f.name))).join() === 'Sandbox Pal');
    const friendsStored = await W(async () => JSON.stringify((await chrome.storage.local.get('atlasFriends')).atlasFriends));
    check('each identity\'s friends are stored under its own key, encrypted', !/Pal/.test(friendsStored), friendsStored.slice(0, 120));

    console.log('--- account-level actions stay on the main identity ---');
    const decryptBackup = (file) => page.evaluate(async ({ file, pw, seed }) => {
      const b = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
      const digests = await Promise.all([pw, seed].map((s) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
      const combined = new Uint8Array(64);
      digests.forEach((d, i) => combined.set(new Uint8Array(d), i * 32));
      const base = await crypto.subtle.importKey('raw', combined, 'PBKDF2', false, ['deriveKey']);
      const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: b(file.salt), iterations: file.kdfIterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b(file.iv) }, key, b(file.ciphertext));
      const p = JSON.parse(new TextDecoder().decode(plain));
      return { identity: p.identity && p.identity.publicKey, friends: JSON.stringify(p.data && p.data.friends || null) };
    }, { file, pw: PASSWORD, seed: SEED });
    check('a full backup is refused while a sub-identity is active', /Switch to your main identity/.test(await fails(async (A, a) => A.exportFullBackup(a.pw, a.seed), { pw: PASSWORD, seed: SEED })));
    check('the active identity is unchanged by the refusal', (await W(async () => (await AtlasWallet.getIdentity()).publicKey)) === sandbox.publicKey);
    await W(async () => AtlasWallet.switchIdentity(null));
    const backup = await W(async ({ pw, seed }) => AtlasWallet.exportFullBackup(pw, seed), { pw: PASSWORD, seed: SEED });
    const payload = await decryptBackup(backup);
    check('on main, a full backup is of the main identity', payload.identity === main, payload);
    check('...with the main identity\'s data only', /Main Pal/.test(payload.friends) && !/Sandbox Pal/.test(payload.friends), payload.friends);
    await W(async (id) => AtlasWallet.switchIdentity(id), sandbox.id);
    await W(async (a) => AtlasWallet.changePassword(a.from, a.to), { from: PASSWORD, to: PASSWORD + '-changed' });
    check('the password can be changed while a sub-identity is active (no automatic backup)', true);
    check('...and the active identity is unchanged', (await W(async () => (await AtlasWallet.getIdentity()).publicKey)) === sandbox.publicKey);
    await W(async (a) => AtlasWallet.changePassword(a.from, a.to), { from: PASSWORD + '-changed', to: PASSWORD });

    console.log('--- lock, unlock, passkey mode ---');
    await W(() => AtlasWallet.lockIdentity());
    check('locking clears the active sub-identity', (await W(async () => (await chrome.storage.session.get('atlasActiveSubIdentity')).atlasActiveSubIdentity)) === undefined);
    check('nothing is listed while locked', /Unlock/.test(await fails(async (A) => A.listSubIdentities())));
    await W(async (pw) => AtlasWallet.unlockIdentity(pw), PASSWORD);
    check('a new session starts on the main identity', (await W(() => AtlasWallet.getActiveIdentityInfo())).kind === 'main');
    check('the sub-identities survive a lock', (await W(() => AtlasWallet.listSubIdentities())).map((e) => e.label).join() === 'Sandbox One,TRADING DESK');
    check('a stale cached sub-identity from another account is ignored', await W(async (m) => {
      await chrome.storage.session.set({ atlasActiveSubIdentity: { id: 'x', label: 'x', publicKey: 'x', privateKeyJwk: { d: 'x' }, accountPublicKey: 'some-other-main-key' } });
      const pk = (await AtlasWallet.getIdentity()).publicKey;
      await chrome.storage.session.remove('atlasActiveSubIdentity');
      return pk === m;
    }, main));
    check('an unknown id cannot be switched to', /No such/.test(await fails(async (A) => A.switchIdentity('nope'))));

    console.log('--- removing ---');
    const pending = await W(async (pk) => {
      const { atlasWallets } = await chrome.storage.local.get('atlasWallets');
      atlasWallets[pk] = [{ held: 'something' }];
      await chrome.storage.local.set({ atlasWallets });
      return true;
    }, sandbox.publicKey).catch(() => false);
    if (!pending) {
      await W(async (pk) => { await chrome.storage.local.set({ atlasWallets: { [pk]: [{ held: 'something' }] } }); }, sandbox.publicKey);
    }
    check('an identity that holds something is not removed', /still holds/.test(await fails(async (A, id) => A.removeSubIdentity(id), sandbox.id)));
    check('...and is still there', (await W(() => AtlasWallet.listSubIdentities())).length === 2);
    await W(async (pk) => { const { atlasWallets } = await chrome.storage.local.get('atlasWallets'); atlasWallets[pk] = []; await chrome.storage.local.set({ atlasWallets }); }, sandbox.publicKey);
    await W(async (pk) => { await chrome.storage.local.set({ atlasPendingOps: { [pk]: [{ op: 'unfinished' }] } }); }, sandbox.publicKey);
    check('an identity with unfinished operations is not removed', /unfinished/.test(await fails(async (A, id) => A.removeSubIdentity(id), sandbox.id)));
    await W(async () => { await chrome.storage.local.remove('atlasPendingOps'); });
    await W(async (id) => AtlasWallet.switchIdentity(id), sandbox.id);
    check('an empty, active identity can be removed', await W(async (id) => AtlasWallet.removeSubIdentity(id), sandbox.id) === true);
    const afterRemove = await W(async () => ({ info: await AtlasWallet.getActiveIdentityInfo(), list: (await AtlasWallet.listSubIdentities()).map((e) => e.label) }));
    check('removing the active identity returns to main', afterRemove.info.kind === 'main' && afterRemove.list.join() === 'TRADING DESK', afterRemove);

    console.log('--- the limit ---');
    for (let i = 0; i < 19; i++) await W(async (n) => AtlasWallet.createSubIdentity('Extra ' + n), i);
    check('20 sub-identities are allowed', (await W(() => AtlasWallet.listSubIdentities())).length === 20);
    check('the 21st is refused', /at most 20/.test(await fails(async (A) => A.createSubIdentity('One too many'))));

    console.log('--- a vault that cannot be read is never overwritten ---');
    await W(async (m) => {
      const { atlasSubIdentities } = await chrome.storage.local.get('atlasSubIdentities');
      atlasSubIdentities[m] = { __atlasEncrypted: true, iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' };
      await chrome.storage.local.set({ atlasSubIdentities });
    }, main);
    check('listing a damaged vault is an error, not an empty list', /could not be read/.test(await fails(async (A) => A.listSubIdentities())));
    check('creating into a damaged vault is refused', /could not be read/.test(await fails(async (A) => A.createSubIdentity('Fresh'))));
    const damaged = await W(async (m) => JSON.stringify((await chrome.storage.local.get('atlasSubIdentities')).atlasSubIdentities[m]), main);
    check('the damaged vault was left exactly as it was', damaged.includes('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), damaged);

    console.log('--- passkey mode ---');
    await W(async () => {
      await chrome.storage.local.set({ atlasWebAuthnIdentity: { credentialId: 'AAAA', publicKey: 'passkey-public-key', createdAt: new Date().toISOString() } });
      await AtlasWallet.setIdentityMode('webauthn');
    });
    check('sub-identities are unavailable while the passkey identity is active', /password identity/.test(await fails(async (A) => A.listSubIdentities())));
    check('getIdentity is the passkey identity', (await W(async () => (await AtlasWallet.getIdentity()).publicKey)) === 'passkey-public-key');
    await W(async () => { await AtlasWallet.setIdentityMode('local'); await chrome.storage.local.remove('atlasWebAuthnIdentity'); });
    check('switching the mechanism back starts on the main identity', (await W(() => AtlasWallet.getActiveIdentityInfo())).kind === 'main');
  } finally {
    await context.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL SUB-IDENTITY CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error('ERROR', err); process.exit(1); });
