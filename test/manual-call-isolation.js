// Calling and local test settings must never interfere with the rest of the wallet.
// Covers: a domain that accepts connections and never answers (a stopped local server behind a
// forwarded port) cannot stall the mail check; a failed or abandoned service setup leaves the
// settings untouched; the private-test-network switch dies with the plain-http service it belongs
// to; broken calling data and a missing calling module do not affect other wallet features; and a
// call service that stays down stops being waited on.
// Needs the local demo domain on 8002 (see manual-call-e2e.js).
// Run: xvfb-run -a node test/manual-call-isolation.js
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const L = require('./call-e2e-lib');
const { check, until, sleep } = L;

const ROOT = path.resolve(__dirname, '..');

async function startLocalIssuer(port) {
  // Its own copy of the demo site and its own state, so its freshly generated key never replaces the
  // published key of the shared demo domains.
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-iso-state-'));
  const docroot = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-iso-site-'));
  fs.cpSync(path.join(ROOT, 'demo-domain-b'), docroot, { recursive: true });
  const child = spawn(process.execPath, [path.join(ROOT, 'issuer-server', 'server.js')], {
    cwd: ROOT, stdio: 'ignore',
    env: Object.assign({}, process.env, { PORT: String(port), ATLAS_DOMAIN: 'localhost:' + port, ATLAS_DOCROOT: docroot, ATLAS_STATE_DIR: state })
  });
  const ok = await until(async () => (await fetch('http://localhost:' + port + '/.well-known/atlas-key.json')).ok, 15000, 200);
  if (!ok) { child.kill(); throw new Error('the local issuer did not start'); }
  return { child, stop: () => { child.kill(); fs.rmSync(state, { recursive: true, force: true }); fs.rmSync(docroot, { recursive: true, force: true }); } };
}

async function hungDomain() {
  const port = await L.freePort();
  const issuer = await startLocalIssuer(port);
  const w = await L.launchWallet('hung');
  try {
    await w.wallet(() => AtlasWallet.createIdentity('hung-test-password'));
    await w.wallet((d) => AtlasWallet.mintAsset('self', d, 'atlas.postoffice.membership'), 'localhost:' + port);
    const live = await w.wallet(() => AtlasWallet.checkAllMail().then(() => 'done'));
    check('with the domain running the mail check completes', live === 'done');
    // The server goes away and something else holds its port: it accepts and never answers.
    issuer.stop();
    await sleep(500);
    const sockets = new Set();
    const hang = net.createServer((s) => { sockets.add(s); s.on('error', () => {}); });
    await new Promise((r) => hang.listen(port, '127.0.0.1', r));
    try {
      const t0 = Date.now();
      const first = await Promise.race([w.wallet(() => AtlasWallet.checkAllMail().then(() => 'done')), sleep(60000).then(() => 'still running')]);
      const took = Date.now() - t0;
      check('a domain that never answers no longer stalls the mail check', first === 'done' && took < 45000, { first, took });
      const t1 = Date.now();
      const second = await Promise.race([w.wallet(() => AtlasWallet.checkAllMail().then(() => 'done')), sleep(10000).then(() => 'still running')]);
      check('the next check skips the origin that just failed instead of waiting again', second === 'done' && Date.now() - t1 < 3000, { second, took: Date.now() - t1 });
      const idOk = await w.wallet(() => AtlasWallet.getIdentity().then((i) => !!i));
      const walletOk = await w.wallet((k) => AtlasWallet.getWallet(k).then((a) => Array.isArray(a)), await w.wallet(() => AtlasWallet.getIdentity().then((i) => i.publicKey)));
      check('identity and assets stay available while the domain is stuck', idOk && walletOk);
    } finally { for (const s of sockets) s.destroy(); hang.close(); }
  } finally { issuer.stop(); await w.close(); }
}

async function settingsStayPut() {
  const svc = await L.startCallService(null, {});
  const w = await L.launchWallet('cfg');
  try {
    await w.create();
    const cfgOf = () => w.wallet(() => AtlasWallet.getCallConfig());
    await w.wallet((s) => AtlasWallet.setCallConfig({ service: s, devAllowHttp: true }), svc.origin);
    let cfg = await cfgOf();
    check('a local plain-http service is stored with the test-network switch on', cfg.service === svc.origin && cfg.devAllowHttp === true, cfg);

    const before = JSON.stringify(cfg);
    const fail = await w.wallet(() => AtlasWallet.setCallConfig({ service: 'http://127.0.0.1:1', devAllowHttp: true }).then(() => 'saved', (e) => e.message));
    check('an address that does not answer is refused', fail !== 'saved', fail);
    check('and the stored settings are exactly as before', JSON.stringify(await cfgOf()) === before, await cfgOf());

    // An https service, mocked at the network layer of the wallet's background context.
    await w.wallet(() => {
      const real = globalThis.fetch.bind(globalThis);
      globalThis.__realFetch = real;
      globalThis.fetch = async (url, init) => {
        if (String(url) === 'https://calls.test.example/atlas/call/info') {
          return new Response(JSON.stringify({ service: 'atlas-call', configured: true, audience: 'https://calls.test.example', domain: 'example.com' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return real(url, init);
      };
    });
    const saved = await w.wallet(() => AtlasWallet.setCallConfig({ service: 'https://calls.test.example', devAllowHttp: true }));
    check('saving an https service turns the test-network switch off even when it was ticked', saved.devAllowHttp === false && (await cfgOf()).devAllowHttp === false, saved);
    const httpsBefore = JSON.stringify(await cfgOf());
    const failed = await w.wallet(() => AtlasWallet.setCallConfig({ service: 'http://127.0.0.1:1', devAllowHttp: true }).then(() => 'saved', (e) => e.message));
    check('a failed attempt to add a local service does not switch plain http on for the online service', failed !== 'saved' && JSON.stringify(await cfgOf()) === httpsBefore, { failed, cfg: await cfgOf() });
    const refused = await w.wallet((o) => AtlasWallet.callPost(o, '/atlas/call/info').then(() => 'reached', (e) => e.code), svc.origin);
    check('with an online service saved, the wallet will not talk to a local plain-http address', refused === 'bad-service', refused);
    await w.wallet(() => { globalThis.fetch = globalThis.__realFetch; });

    // Reset removes calling settings and nothing else.
    await w.wallet((s) => AtlasWallet.setCallConfig({ service: s, devAllowHttp: true }), svc.origin);
    const idBefore = await w.wallet(() => AtlasWallet.getIdentity().then((i) => i.publicKey));
    const r = await w.wallet(() => AtlasWallet.resetCallSettings());
    check('resetting calling settings clears the service and the switch', r.service === null && r.devAllowHttp === false && (await cfgOf()).service === null);
    const idAfter = await w.wallet(() => AtlasWallet.getIdentity().then((i) => i.publicKey));
    check('and leaves the identity and its assets alone', idBefore === idAfter && (await w.wallet((k) => AtlasWallet.getWallet(k).then((a) => a.length), idAfter)) >= 1);
  } finally { await w.close(); await svc.close(); }
}

async function leftoverCards() {
  const svc = await L.startCallService(null, { limits: { invitesPerCallerPerMin: 100, invitesPerCalleePerMin: 100, invitesPerSourcePerMin: 200 } });
  const { alice, bob } = await L.makePair(svc, {});
  try {
    const c0 = await alice.wallet(() => AtlasWallet.getCallContacts());
    check('with the local service in place the contact is callable and allowed', c0[0].canCall === true && c0[0].allowed === true, c0);
    await alice.wallet(() => AtlasWallet.resetCallSettings());
    const c1 = await alice.wallet(() => AtlasWallet.getCallContacts());
    check('after the local test is reset no local card or permission is left over', c1.length === 1 && c1[0].canCall === false && c1[0].allowed === false && c1[0].name === 'Bob', c1);
  } finally { await alice.close(); await bob.close(); await svc.close(); }
}

async function brokenCallingData() {
  const w = await L.launchWallet('broken');
  try {
    await w.create();
    const pub = w.pub;
    await w.wallet((k) => chrome.storage.local.set({ atlasCallState: { [k]: { __atlasEncrypted: true, iv: 'AAAA', ciphertext: 'not-valid' } } }), pub);
    const mail = await w.wallet(() => AtlasWallet.checkAllMail().then(() => 'done', (e) => 'ERR ' + e.message));
    check('unreadable calling data does not stop the mail check', mail === 'done', mail);
    const cfg = await w.wallet(() => AtlasWallet.getCallConfig().then((c) => c, (e) => 'ERR ' + e.message));
    check('and calling simply shows as not set up', cfg && cfg.service === null, cfg);
    await w.wallet((k) => chrome.storage.local.set({ atlasCallState: { [k]: 'garbage' } }), pub);
    const mail2 = await w.wallet(() => AtlasWallet.checkAllMail().then(() => 'done', (e) => 'ERR ' + e.message));
    check('calling data of the wrong shape does not stop it either', mail2 === 'done', mail2);
    check('the rest of the wallet is untouched', await w.wallet(() => AtlasWallet.getIdentity().then((i) => !!i)));
  } finally { await w.close(); }
}

async function missingCallingModule() {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-iso-ext-'));
  fs.cpSync(L.EXT_PATH, copy, { recursive: true });
  fs.rmSync(path.join(copy, 'call-protocol.js'));
  const w = await L.launchWallet('nomod', { extPath: copy });
  try {
    const r = await w.wallet(() => AtlasWallet.createIdentity('nomod-test-password').then((i) => !!i.publicKey, (e) => 'ERR ' + e.message));
    check('without the calling module the wallet worker still starts and creates an identity', r === true, r);
    const mail = await w.wallet(() => AtlasWallet.checkAllMail().then(() => 'done', (e) => 'ERR ' + e.message));
    check('and checks mail', mail === 'done', mail);
    const call = await w.wallet(() => AtlasWallet.grantCalling('x').then(() => 'worked', (e) => e.message));
    check('calling functions report that calling is unavailable', /calling module/i.test(call), call);
  } finally { await w.close(); fs.rmSync(copy, { recursive: true, force: true }); }
}

async function deadServiceGivesUp() {
  const svc = await L.startCallService(null, {});
  const w = await L.launchWallet('dead');
  try {
    await w.create();
    await w.wallet((s) => AtlasWallet.setCallConfig({ service: s, devAllowHttp: true }), svc.origin);
    await w.openCallWindow();
    await w.setTimers({ retryMs: 200, giveUpMs: 2500 });
    await w.available();
    await svc.close();
    const gone = await until(async () => !(await w.snap()).listening, 40000, 300);
    check('a call service that stays down is given up on and availability turns off', !!gone);
    check('the window says so', /no longer shown as available/i.test(await w.text()));
    check('the wallet is still unlocked and usable', await w.wallet(() => AtlasWallet.getIdentity().then((i) => !!i)));
  } finally { await w.close(); }
}

(async () => {
  try {
    await hungDomain();
    await settingsStayPut();
    await leftoverCards();
    await brokenCallingData();
    await missingCallingModule();
    await deadServiceGivesUp();
  } catch (e) { check('test run completed', false, String(e && e.stack || e)); }
  process.exit(L.finish('manual-call-isolation'));
})();
