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

async function launch() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-sub-identities-'));
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

// Decrypts a full backup file the way importFullBackup does, for inspection.
const decryptBackup = (page, file) => page.evaluate(async ({ file, pw, seed }) => {
  const b = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const digests = await Promise.all([pw, seed].map((s) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
  const combined = new Uint8Array(64);
  digests.forEach((d, i) => combined.set(new Uint8Array(d), i * 32));
  const base = await crypto.subtle.importKey('raw', combined, 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: b(file.salt), iterations: file.kdfIterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b(file.iv) }, key, b(file.ciphertext));
  return JSON.parse(new TextDecoder().decode(plain));
}, { file, pw: PASSWORD, seed: SEED });

(async () => {
  let session = await launch();
  try {
    const { page, W, fails } = session;

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

    console.log('--- backup carries every identity ---');
    // Give each identity data in several families, including a wallet entry.
    const seedSub = async (sub, tag) => {
      await W(async (id) => AtlasWallet.switchIdentity(id), sub.id);
      await W(async (tag) => {
        await AtlasWallet.setAlias('alias-target-' + tag, 'Alias ' + tag);
        await AtlasWallet.addCalendarEvent({ title: 'Event ' + tag, dateTime: '2030-01-01T10:00:00Z', endDateTime: '2030-01-01T11:00:00Z' });
        await AtlasWallet.addFavoriteDomain({ domain: 'fav-' + tag + '.example.com', manifestUrl: 'https://fav-' + tag + '.example.com/.well-known/spatial.json' });
      }, tag);
    };
    await seedSub(sandbox, 'sandbox');
    await W(async (pk) => {
      const { atlasWallets } = await chrome.storage.local.get('atlasWallets');
      const all = atlasWallets || {};
      all[pk] = [{ credential: { credential: 'domain-atlas-asset/1.0', n: 7 } }];
      await chrome.storage.local.set({ atlasWallets: all });
    }, sandbox.publicKey);
    await seedSub(trading, 'trading');
    await W(async () => AtlasWallet.switchIdentity(null));
    await W(async () => { await AtlasWallet.addFavoriteDomain({ domain: 'fav-main.example.com', manifestUrl: 'https://fav-main.example.com/.well-known/spatial.json' }); });

    const backupFromMain = await W(async ({ pw, seed }) => AtlasWallet.exportFullBackup(pw, seed), { pw: PASSWORD, seed: SEED });
    const fromMain = await decryptBackup(page, backupFromMain);
    check('the backup lists both sub-identities', Array.isArray(fromMain.subIdentities) && fromMain.subIdentities.map((e) => e.label).join() === 'Sandbox One,TRADING DESK', fromMain.subIdentities && fromMain.subIdentities.map((e) => e.label));
    check('...with their keys, so a restore can sign as them', fromMain.subIdentities.every((e) => e.privateKeyJwk && e.privateKeyJwk.d && e.publicKey));
    const subA = fromMain.subIdentities[0];
    check('a sub-identity\'s data is its own (aliases, favourites, wallet)', JSON.stringify(subA.data.aliases).includes('Alias sandbox') && !JSON.stringify(subA.data.aliases).includes('Alias trading') && JSON.stringify(subA.data.favoriteDomains).includes('fav-sandbox') && !JSON.stringify(subA.data.favoriteDomains).includes('fav-main') && subA.data.wallet.length === 1, { aliases: subA.data.aliases, fav: subA.data.favoriteDomains, wallet: subA.data.wallet });
    check('the main identity\'s data does not hold theirs', !JSON.stringify(fromMain.data.favoriteDomains).includes('fav-sandbox') && JSON.stringify(fromMain.data.favoriteDomains).includes('fav-main') && fromMain.data.wallet.length === 0);
    check('the backup file shows no name or key in the clear', !JSON.stringify(backupFromMain).match(/Sandbox|TRADING|"d"|privateKeyJwk/));

    // The same backup made while a sub-identity is active must be the same backup.
    await W(async (id) => AtlasWallet.switchIdentity(id), trading.id);
    const backupFromSub = await W(async ({ pw, seed }) => AtlasWallet.exportFullBackup(pw, seed), { pw: PASSWORD, seed: SEED });
    const fromSub = await decryptBackup(page, backupFromSub);
    check('a backup made while a sub-identity is active is of the main identity', fromSub.identity.publicKey === main);
    const stripLog = (d) => { const { activityLog, ...rest } = d; return JSON.stringify(rest); };
    const differing = Object.keys(fromMain.data).filter((k) => k !== 'activityLog' && JSON.stringify(fromMain.data[k]) !== JSON.stringify(fromSub.data[k]));
    check('...with exactly the data the active-main path produced', differing.length === 0, differing.map((k) => ({ k, active: JSON.stringify(fromMain.data[k]).slice(0, 160), explicit: JSON.stringify(fromSub.data[k]).slice(0, 160) })));
    check('...and the same sub-identities and data', fromSub.subIdentities.map((e) => e.publicKey + stripLog(e.data)).join('|') === fromMain.subIdentities.map((e) => e.publicKey + stripLog(e.data)).join('|'));
    check('the explicit path covers every family the active path does', Object.keys(fromSub.data).sort().join() === Object.keys(fromMain.data).sort().join(), { sub: Object.keys(fromSub.data).sort(), main: Object.keys(fromMain.data).sort() });
    check('the active identity is unchanged by making a backup', (await W(async () => (await AtlasWallet.getIdentity()).publicKey)) === trading.publicKey);
    await W(async (a) => AtlasWallet.changePassword(a.from, a.to), { from: PASSWORD, to: PASSWORD + '-changed' });
    check('the password can be changed while a sub-identity is active', (await W(async () => (await AtlasWallet.getIdentity()).publicKey)) === trading.publicKey);
    await W(async (a) => AtlasWallet.changePassword(a.from, a.to), { from: PASSWORD + '-changed', to: PASSWORD });
    await W(async () => AtlasWallet.switchIdentity(null));

    console.log('--- restoring onto a fresh device ---');
    const fresh = await launch();
    try {
      const restored = await fresh.W(async ({ file, pw, seed }) => AtlasWallet.importFullBackup(file, pw, seed), { file: backupFromSub, pw: PASSWORD, seed: SEED });
      check('the restore reports the sub-identities', restored.publicKey === main && restored.subIdentities && restored.subIdentities.restored === 2 && restored.subIdentities.skipped === 0, restored);
      const list = await fresh.W(() => AtlasWallet.listSubIdentities());
      check('both come back, with their names and public keys', list.map((e) => e.label + ':' + e.publicKey).join() === fromMain.subIdentities.map((e) => e.label + ':' + e.publicKey).join(), list);
      check('the restored wallet starts on the main identity', (await fresh.W(() => AtlasWallet.getActiveIdentityInfo())).kind === 'main');
      await fresh.W(async (id) => AtlasWallet.switchIdentity(id), list[0].id);
      const signed = await fresh.W(async () => {
        const payload = { purpose: 'test', n: 2 };
        const env = await AtlasWallet.signWithSelf(payload);
        return { pk: env.publicKey, ok: await AtlasWallet.verifySignedPayload(payload, env) };
      });
      check('the restored key signs as the same sub-identity', signed.pk === sandbox.publicKey && signed.ok, signed);
      check('its aliases and favourites came back', (await fresh.W(async () => JSON.stringify([await AtlasWallet.getFavoriteDomains(), await AtlasWallet.getAlias('alias-target-sandbox')]))).includes('fav-sandbox'));
      check('...and its wallet', (await fresh.W(async (pk) => (await AtlasWallet.getWallet(pk)).length, sandbox.publicKey)) === 1);
      check('...and not the other identities\' data', !(await fresh.W(async () => JSON.stringify(await AtlasWallet.getFavoriteDomains()))).includes('fav-trading'));
      await fresh.W(async () => AtlasWallet.switchIdentity(null));
      check('the main identity\'s data came back too', (await fresh.W(async () => JSON.stringify(await AtlasWallet.getFavoriteDomains()))).includes('fav-main'));

      console.log('--- restoring over a wallet that already has sub-identities ---');
      const extra = await fresh.W(() => AtlasWallet.createSubIdentity('Made after the backup'));
      await fresh.W(async (id) => AtlasWallet.removeSubIdentity(id), list[1].id);
      const again = await fresh.W(async ({ file, pw, seed }) => AtlasWallet.importFullBackup(file, pw, seed), { file: backupFromSub, pw: PASSWORD, seed: SEED });
      check('a second restore adds back the removed one and keeps the new one', again.subIdentities.restored === 1 && again.subIdentities.kept === 1, again.subIdentities);
      const merged = await fresh.W(() => AtlasWallet.listSubIdentities());
      check('all three are there, none duplicated', merged.length === 3 && new Set(merged.map((e) => e.publicKey)).size === 3 && merged.some((e) => e.id === extra.id), merged);
    } finally {
      await fresh.close();
    }

    console.log('--- a damaged backup entry is skipped, not trusted ---');
    const tampered = JSON.parse(JSON.stringify(fromMain));
    tampered.subIdentities[0].publicKey = tampered.subIdentities[1].publicKey;
    tampered.subIdentities.push({ id: 'junk', label: 'Junk', publicKey: 'x', privateKeyJwk: { kty: 'EC' }, data: {} });
    tampered.subIdentities.push({ id: 'self', label: 'Self', publicKey: main, privateKeyJwk: tampered.identity.privateKeyJwk, data: {} });
    const fresh2 = await launch();
    try {
      const encrypted = await page.evaluate(async ({ payload, pw, seed }) => {
        const toB = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const digests = await Promise.all([pw, seed].map((x) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(x))));
        const combined = new Uint8Array(64);
        digests.forEach((d, i) => combined.set(new Uint8Array(d), i * 32));
        const base = await crypto.subtle.importKey('raw', combined, 'PBKDF2', false, ['deriveKey']);
        const iterations = 600000;
        const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
        const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(payload)));
        return { format: 'atlas-full-backup/1.0', salt: toB(salt), iv: toB(iv), ciphertext: toB(ct), kdfIterations: iterations };
      }, { payload: tampered, pw: PASSWORD, seed: SEED });
      const result = await fresh2.W(async ({ file, pw, seed }) => AtlasWallet.importFullBackup(file, pw, seed), { file: encrypted, pw: PASSWORD, seed: SEED });
      check('a key that does not match its public key, a malformed key and the account\'s own key are all skipped', result.subIdentities.restored === 1 && result.subIdentities.skipped === 3, result.subIdentities);
      check('only the one good identity was added', (await fresh2.W(() => AtlasWallet.listSubIdentities())).length === 1);
    } finally {
      await fresh2.close();
    }

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
    await session.close();
  }
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL SUB-IDENTITY CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error('ERROR', err); process.exit(1); });
