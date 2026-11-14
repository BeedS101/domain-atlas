// Exporting and importing one sub-identity (docs/sub-identities.md, step 4). Runs the real extension in
// scratch Chromium profiles and drives AtlasWallet from an extension page. Only throw-away identities are
// created; nothing contacts an issuer, a ledger or a site.
//
// Run with a display, e.g.:  xvfb-run -a node test/manual-sub-identity-export.js

const { chromium } = require('playwright');
const path = require('path');
const os = require('os');
const fs = require('fs');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const PASSWORD = 'sub-identity-export-test-pw-1';
const OTHER_PASSWORD = 'a-different-file-password';
const MAIN_SEED = 'amber anchor apple arrow aspen atlas aurora autumn';

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' :: ' + JSON.stringify(detail)));
  if (!ok) failures++;
}

async function launch() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-sub-export-'));
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

// Builds an export file the way the wallet does, so a forged payload can be sealed under known secrets.
const sealFile = (page, payload, filePassword, code, format) => page.evaluate(async ({ payload, filePassword, code, format }) => {
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const digests = await Promise.all([filePassword, code].map((s) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
  const combined = new Uint8Array(64);
  digests.forEach((d, i) => combined.set(new Uint8Array(d), i * 32));
  const base = await crypto.subtle.importKey('raw', combined, 'PBKDF2', false, ['deriveKey']);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(payload)));
  return { format: format || 'atlas-sub-identity-export/1.0', salt: b64(salt), iv: b64(iv), ciphertext: b64(ct), kdfIterations: 600000, exportedAt: new Date().toISOString() };
}, { payload, filePassword, code, format });

const stored = (W, key, pk) => W(async ({ key, pk }) => {
  const got = (await chrome.storage.local.get(key))[key];
  return got && Object.prototype.hasOwnProperty.call(got, pk);
}, { key, pk });

(async () => {
  const A = await launch();
  const B = await launch();
  try {
    const { W, fails, page } = A;

    console.log('--- a source wallet with three sub-identities ---');
    const mainA = await W(async (pw) => (await AtlasWallet.createIdentity(pw)).publicKey, PASSWORD);
    const sandbox = await W(() => AtlasWallet.createSubIdentity('Sandbox'));
    const plain = await W(() => AtlasWallet.createSubIdentity('Plain'));
    const trading = await W(() => AtlasWallet.createSubIdentity('Trading'));
    const seed = async (sub, tag) => {
      await W(async (id) => AtlasWallet.switchIdentity(id), sub.id);
      await W(async (tag) => {
        await AtlasWallet.setAlias('alias-target-' + tag, 'Alias ' + tag);
        await AtlasWallet.addFriend('friend-key-' + tag, 'Pal ' + tag);
        await AtlasWallet.addFavoriteDomain({ domain: 'fav-' + tag + '.example.com', manifestUrl: 'https://fav-' + tag + '.example.com/.well-known/spatial.json' });
      }, tag);
      await W(async () => AtlasWallet.switchIdentity(null));
    };
    await seed(sandbox, 'sandbox');
    await seed(plain, 'plain');
    await seed(trading, 'trading');
    await W(async (pk) => {
      const { atlasWallets } = await chrome.storage.local.get('atlasWallets');
      const all = atlasWallets || {};
      all[pk] = [{ credential: { credential: 'domain-atlas-asset/1.0', n: 7 } }];
      await chrome.storage.local.set({ atlasWallets: all });
    }, sandbox.publicKey);

    console.log('--- preparing an export ---');
    check('a wrong wallet password is refused', /Incorrect password/.test(await fails(async (A, a) => A.prepareSubIdentityExport(a.id, { password: 'nope-nope-nope' }), sandbox)));
    check('a short file password is refused', /at least 8/.test(await fails(async (A, a) => A.prepareSubIdentityExport(a.id, { password: a.pw, filePassword: 'short' }), { id: sandbox.id, pw: PASSWORD })));
    check('an unknown identity is refused', /No such/.test(await fails(async (A, a) => A.prepareSubIdentityExport('nope', { password: a }), PASSWORD)));
    await W(async (id) => AtlasWallet.switchIdentity(id), sandbox.id);
    check('the identity the wallet is acting as cannot be exported', /Switch back/.test(await fails(async (A, a) => A.prepareSubIdentityExport(a.id, { password: a.pw }), { id: sandbox.id, pw: PASSWORD })));
    await W(async () => AtlasWallet.switchIdentity(null));
    check('a key-only export is refused while the identity holds items', /still holds items/.test(await fails(async (A, a) => A.prepareSubIdentityExport(a.id, { password: a.pw, includeData: false }), { id: sandbox.id, pw: PASSWORD })));
    await W(async (pk) => { await chrome.storage.local.set({ atlasPendingOps: { [pk]: [{ op: 'unfinished' }] } }); }, sandbox.publicKey);
    check('an identity with unfinished operations cannot be exported', /unfinished/.test(await fails(async (A, a) => A.prepareSubIdentityExport(a.id, { password: a.pw }), { id: sandbox.id, pw: PASSWORD })));
    await W(async () => { await chrome.storage.local.remove('atlasPendingOps'); });

    const prep = await W(async ({ id, pw }) => AtlasWallet.prepareSubIdentityExport(id, { password: pw }), { id: sandbox.id, pw: PASSWORD });
    check('the file has the export format', prep.file.format === 'atlas-sub-identity-export/1.0' && prep.file.kdfIterations === 600000, prep.file.format);
    check('the code is 16 words', prep.code.split(' ').length === 16, prep.code);
    check('the filename is plain', /^atlas-identity-sandbox-\d{4}-\d{2}-\d{2}\.json$/.test(prep.filename), prep.filename);
    const fileText = JSON.stringify(prep.file);
    check('the file holds no plaintext', !/Sandbox|sandbox|Alias|Pal|fav-/.test(fileText) && !fileText.includes(sandbox.publicKey), fileText.slice(0, 120));
    check('preparing removes nothing', (await W(() => AtlasWallet.listSubIdentities())).some((e) => e.id === sandbox.id) && await stored(W, 'atlasWallets', sandbox.publicKey));
    check('a second export gets a different code and salt', await W(async ({ id, pw, code, salt }) => {
      const again = await AtlasWallet.prepareSubIdentityExport(id, { password: pw });
      return again.code !== code && again.file.salt !== salt;
    }, { id: sandbox.id, pw: PASSWORD, code: prep.code, salt: prep.file.salt }));

    console.log('--- finishing is tied to the data in the file ---');
    await W(async (id) => AtlasWallet.switchIdentity(id), sandbox.id);
    await W(() => AtlasWallet.addFriend('friend-key-late', 'Late Pal'));
    await W(async () => AtlasWallet.switchIdentity(null));
    check('data that changed after the file was made blocks removal', /changed after the file was made/.test(await fails(async (A, c) => A.completeSubIdentityExport(c), prep.check)));
    check('...and leaves the identity in place', (await W(() => AtlasWallet.listSubIdentities())).some((e) => e.id === sandbox.id));
    check('a made-up check object is refused', /Nothing to finish/.test(await fails(async (A) => A.completeSubIdentityExport({}))));

    const prep2 = await W(async ({ id, pw }) => AtlasWallet.prepareSubIdentityExport(id, { password: pw }), { id: sandbox.id, pw: PASSWORD });
    await W(async (id) => AtlasWallet.switchIdentity(id), sandbox.id);
    check('an identity that became active cannot be finished', /Switch back/.test(await fails(async (A, c) => A.completeSubIdentityExport(c), prep2.check)));
    await W(async () => AtlasWallet.switchIdentity(null));
    const done = await W((c) => AtlasWallet.completeSubIdentityExport(c), prep2.check);
    check('finishing removes the identity from the wallet', done.removed && !(await W(() => AtlasWallet.listSubIdentities())).some((e) => e.id === sandbox.id));
    check('its data was removed with it', !(await stored(W, 'atlasWallets', sandbox.publicKey)) && !(await stored(W, 'atlasFriends', sandbox.publicKey)) && !(await stored(W, 'atlasAliases', sandbox.publicKey)) && !(await stored(W, 'atlasFavoriteDomains', sandbox.publicKey)));
    check('other identities keep their data', await stored(W, 'atlasFriends', trading.publicKey) && await stored(W, 'atlasAliases', plain.publicKey));
    check('finishing twice is refused', /No such/.test(await fails(async (A, c) => A.completeSubIdentityExport(c), prep2.check)));

    console.log('--- importing back into the same wallet ---');
    check('a wrong password is refused', /Incorrect password or code/.test(await fails(async (A, a) => A.importSubIdentity(a.file, 'wrong-password-x', a.code), { file: prep2.file, code: prep2.code })));
    const wrongCode = await fails(async (A, a) => A.importSubIdentity(a.file, a.pw, 'amber anchor apple arrow'), { file: prep2.file, pw: PASSWORD });
    check('a wrong code gives the same message', /Incorrect password or code/.test(wrongCode), wrongCode);
    check('a missing code is refused', /export code/.test(await fails(async (A, a) => A.importSubIdentity(a.file, a.pw, '  '), { file: prep2.file, pw: PASSWORD })));
    check('a code typed in capitals with odd spacing still works', await W(async ({ file, pw, code }) => {
      const r = await AtlasWallet.importSubIdentity(file, pw, '  ' + code.toUpperCase().split(' ').join('   ') + ' ');
      return r.label === 'Sandbox' && r.includesData === true;
    }, { file: prep2.file, pw: PASSWORD, code: prep2.code }));
    const back = (await W(() => AtlasWallet.listSubIdentities())).find((e) => e.publicKey === sandbox.publicKey);
    check('the same key came back', !!back, back);
    await W(async (id) => AtlasWallet.switchIdentity(id), back.id);
    const restored = await W(async (pk) => ({
      items: (await AtlasWallet.getWallet(pk)).length,
      friends: (await AtlasWallet.getFriends()).map((f) => f.name).join(),
      alias: JSON.stringify(await AtlasWallet.getAlias('alias-target-sandbox')),
      favs: JSON.stringify(await AtlasWallet.getFavoriteDomains())
    }), sandbox.publicKey);
    check('its items, friends, alias and favourites came back', restored.items === 1 && /Pal sandbox/.test(restored.friends) && /Late Pal/.test(restored.friends) && /Alias sandbox/.test(restored.alias) && /fav-sandbox/.test(restored.favs), restored);
    await W(async () => AtlasWallet.switchIdentity(null));
    check('importing it again is refused as a duplicate', /already in your wallet/.test(await fails(async (A, a) => A.importSubIdentity(a.file, a.pw, a.code), { file: prep2.file, pw: PASSWORD, code: prep2.code })));

    console.log('--- key-only export with a different file password ---');
    await W(async (pk) => { // an identity with no items can be exported key-only
      const { atlasWallets } = await chrome.storage.local.get('atlasWallets');
      delete atlasWallets[pk];
      await chrome.storage.local.set({ atlasWallets });
    }, back.publicKey);
    const keyOnly = await W(async ({ id, pw, other }) => AtlasWallet.prepareSubIdentityExport(id, { password: pw, filePassword: other, includeData: false }), { id: back.id, pw: PASSWORD, other: OTHER_PASSWORD });
    check('it reports the choices', keyOnly.includesData === false && keyOnly.usesWalletPassword === false);
    check('the wallet password does not open it', /Incorrect password or code/.test(await fails(async (A, a) => A.importSubIdentity(a.file, a.pw, a.code), { file: keyOnly.file, pw: PASSWORD, code: keyOnly.code })));
    await W((c) => AtlasWallet.completeSubIdentityExport(c), keyOnly.check);
    check('a key-only export leaves the data as unreadable ciphertext', await stored(W, 'atlasFriends', back.publicKey));
    const keyOnlyBack = await W(async (a) => AtlasWallet.importSubIdentity(a.file, a.pw, a.code), { file: keyOnly.file, pw: OTHER_PASSWORD, code: keyOnly.code });
    check('the file password plus the code opens it', keyOnlyBack.label === 'Sandbox' && keyOnlyBack.includesData === false, keyOnlyBack);
    await W(async (id) => AtlasWallet.switchIdentity(id), keyOnlyBack.id);
    check('the data left behind is readable again with the same key', await W(async () => /Pal sandbox/.test((await AtlasWallet.getFriends()).map((f) => f.name).join())));
    await W(async () => AtlasWallet.switchIdentity(null));

    console.log('--- importing into a different wallet ---');
    const wb = B.W;
    await wb(async (pw) => (await AtlasWallet.createIdentity(pw)).publicKey, 'another-wallet-password-1');
    await wb(() => AtlasWallet.createSubIdentity('Sandbox'));
    const prepFor = await W(async ({ id, pw }) => AtlasWallet.prepareSubIdentityExport(id, { password: pw }), { id: (await W(() => AtlasWallet.listSubIdentities())).find((e) => e.label === 'Trading').id, pw: PASSWORD });
    const importedB = await wb(async (a) => AtlasWallet.importSubIdentity(a.file, a.pw, a.code), { file: prepFor.file, pw: PASSWORD, code: prepFor.code });
    check('the identity arrives with its name and data', importedB.label === 'Trading' && importedB.includesData, importedB);
    const viaOpt = await wb(async (a) => AtlasWallet.importSubIdentity(a.file, a.pw, a.code, { label: 'Sandbox' }), { file: keyOnly.file, pw: OTHER_PASSWORD, code: keyOnly.code });
    check('an explicit name that is taken gets a number', viaOpt.label === 'Sandbox (2)', viaOpt);
    check('the vault holds all three', (await wb(() => AtlasWallet.listSubIdentities())).length === 3);
    await wb(async (id) => AtlasWallet.switchIdentity(id), importedB.id);
    check('the imported identity shows its own data only', await wb(async () => {
      const friends = (await AtlasWallet.getFriends()).map((f) => f.name).join();
      return /Pal trading/.test(friends) && !/sandbox/.test(friends);
    }));
    await wb(async () => AtlasWallet.switchIdentity(null));
    check('the imported key is in the next backup', await wb(async (a) => {
      const file = await AtlasWallet.exportFullBackup(a.pw, a.seed);
      return !!file && file.format === 'atlas-full-backup/1.0';
    }, { pw: 'another-wallet-password-1', seed: MAIN_SEED }));

    console.log('--- the main identity export file ---');
    const legacy = await W(async (a) => AtlasWallet.exportIdentity(a.pw, a.seed), { pw: PASSWORD, seed: MAIN_SEED });
    check('this wallet\'s own main key is refused as a sub-identity', /already in your wallet/.test(await fails(async (A, a) => A.importSubIdentity(a.file, a.pw, a.seed), { file: legacy, pw: PASSWORD, seed: MAIN_SEED })));
    const legacyB = await wb(async (a) => AtlasWallet.importSubIdentity(a.file, a.pw, a.seed, { label: 'From another wallet' }), { file: legacy, pw: PASSWORD, seed: MAIN_SEED });
    check('another wallet can take it as a key-only sub-identity', legacyB.publicKey === mainA && legacyB.label === 'From another wallet' && legacyB.includesData === false, legacyB);
    check('the sub-identity file is not accepted as a main identity', /sub-identity/.test(await fails(async (A, a) => A.importIdentity(a.file, a.pw, a.code), { file: prepFor.file, pw: PASSWORD, code: prepFor.code })));

    console.log('--- damaged and forged files ---');
    const tampered = JSON.parse(JSON.stringify(prepFor.file));
    tampered.ciphertext = (tampered.ciphertext[0] === 'A' ? 'B' : 'A') + tampered.ciphertext.slice(1);
    check('a tampered file fails with the generic message', /Incorrect password or code/.test(await fails(async (A, a) => A.importSubIdentity(a.file, a.pw, a.code), { file: tampered, pw: PASSWORD, code: prepFor.code })));
    check('a file of another kind is refused', /Not an Atlas identity file/.test(await fails(async (A) => A.importSubIdentity({ format: 'something-else' }, 'x', 'y z'))));
    check('nothing at all is refused', /Not an Atlas identity file/.test(await fails(async (A) => A.importSubIdentity(null, 'x', 'y z'))));
    const fresh = await page.evaluate(async () => {
      const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      return { publicKey: b64(await crypto.subtle.exportKey('raw', pair.publicKey)), privateKeyJwk: await crypto.subtle.exportKey('jwk', pair.privateKey) };
    });
    const lengthKey = await page.evaluate(async () => {
      const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      return { publicKey: b64(await crypto.subtle.exportKey('raw', pair.publicKey)), privateKeyJwk: await crypto.subtle.exportKey('jwk', pair.privateKey) };
    });
    const other = await page.evaluate(async () => {
      const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      return { publicKey: b64(await crypto.subtle.exportKey('raw', pair.publicKey)) };
    });
    const forge = async (payload, format) => fails(async (A, a) => A.importSubIdentity(a.file, 'forge-password-1', 'forge code words here'), { file: await sealFile(page, payload, 'forge-password-1', 'forge code words here', format) });
    check('a public key that is not the private key\'s is refused', /usable identity key/.test(await forge({ version: 1, label: 'Forged', publicKey: other.publicKey, privateKeyJwk: fresh.privateKeyJwk })));
    check('a private key of the wrong shape is refused', /usable identity key/.test(await forge({ version: 1, label: 'Forged', publicKey: fresh.publicKey, privateKeyJwk: { kty: 'RSA', n: 'x', e: 'AQAB', d: 'x' } })));
    check('a payload with no key is refused', /usable identity key/.test(await forge({ version: 1, label: 'Forged' })));
    check('an unknown payload version is refused', /not in a format/.test(await forge({ version: 2, label: 'Forged', publicKey: fresh.publicKey, privateKeyJwk: fresh.privateKeyJwk })));
    const valid = await sealFile(page, { version: 1, label: '<img src=x onerror=alert(1)>', publicKey: fresh.publicKey, privateKeyJwk: fresh.privateKeyJwk }, 'forge-password-1', 'forge code words here');
    const odd = await W(async (f) => AtlasWallet.importSubIdentity(f, 'forge-password-1', 'forge code words here'), valid);
    check('a hostile name is kept as text (the screen renders it with textContent)', odd.label === '<img src=x onerror=alert(1)>', odd);
    const overLong = await sealFile(page, { version: 1, label: 'n'.repeat(80), publicKey: other.publicKey, privateKeyJwk: fresh.privateKeyJwk }, 'forge-password-1', 'forge code words here');
    check('a key that does not match is refused whatever the name', /usable identity key/.test(await fails(async (A, f) => A.importSubIdentity(f, 'forge-password-1', 'forge code words here'), overLong)));
    const longName = await sealFile(page, { version: 1, label: 'n'.repeat(80), publicKey: lengthKey.publicKey, privateKeyJwk: lengthKey.privateKeyJwk }, 'forge-password-1', 'forge code words here');
    const longImported = await W(async (f) => AtlasWallet.importSubIdentity(f, 'forge-password-1', 'forge code words here'), longName);
    check('an over-long name is shortened to fit', longImported.label.length <= 40 && longImported.label.startsWith('nnnn') || longImported.label === 'Restored identity', longImported);

    console.log('--- a wallet at the limit ---');
    const subsNow = (await W(() => AtlasWallet.listSubIdentities())).length;
    for (let i = subsNow; i < 20; i++) await W(async (n) => AtlasWallet.createSubIdentity('Filler ' + n), i);
    const pk2 = await page.evaluate(async () => {
      const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      return { publicKey: b64(await crypto.subtle.exportKey('raw', pair.publicKey)), privateKeyJwk: await crypto.subtle.exportKey('jwk', pair.privateKey) };
    });
    const extra = await sealFile(page, { version: 1, label: 'One too many', publicKey: pk2.publicKey, privateKeyJwk: pk2.privateKeyJwk }, 'forge-password-1', 'forge code words here');
    check('the 21st identity is refused', /at most 20/.test(await fails(async (A, f) => A.importSubIdentity(f, 'forge-password-1', 'forge code words here'), extra)));
    check('...and nothing was added', (await W(() => AtlasWallet.listSubIdentities())).length === 20);
  } finally {
    await A.close();
    await B.close();
  }
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL SUB-IDENTITY EXPORT CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error('ERROR', err); process.exit(1); });
