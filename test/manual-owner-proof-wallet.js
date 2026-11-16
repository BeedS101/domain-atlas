// The wallet's side of the signed membership request, in the real extension against local issuers (Node and PHP, accept and
// require) and one that predates the check: a signed request goes out only where the issuer asks for it, a person can
// still join in one step, a wallet whose clock is wrong corrects itself, an interrupted join is retried with the same
// bytes, an issuer that insists on a signature a wallet cannot give shows the update message, and a passkey identity joins too.
//
// Nothing here contacts a live domain.
// Run: xvfb-run -a node test/manual-owner-proof-wallet.js
'use strict';
const L = require('./call-e2e-lib');
const lib = require('./owner-proof-lib');
const proofLib = require('../issuer-server/lib-owner-proof');
const { check, until } = L;
const CLASSES = proofLib.OWNER_PROOF_CLASSES;
const MESSAGE = 'This domain requires a newer version of Domain Atlas Wallet to join this service. Please update your wallet and try again.';

(async () => {
  let w;
  let exit = 0;
  try {
    const nodeReq = await lib.startNode('node-require', 8251, 'require');
    const nodeAccept = await lib.startNode('node-accept', 8252, 'accept');
    const phpReq = await lib.startPhp('php-require', 8253, 'require');
    const nodeOff = await lib.startNode('node-off', 8254, 'off');
    w = await L.launchWallet('owner-proof');
    const created = await w.wallet((pw) => AtlasWallet.createIdentity(pw), 'owner-proof-password');
    w.pub = created.publicKey;

    // Everything the wallet sends to an issuer's issue endpoint, and switches that change what it gets back.
    await w.sw.evaluate(() => {
      self.__sent = [];
      self.__mode = 'real';
      self.__skew = 0;
      const realNow = Date.now.bind(Date);
      Date.now = () => realNow() + self.__skew;
      const real = self.fetch.bind(self);
      self.fetch = async (u, i) => {
        const url = String(u && u.url ? u.url : u);
        if (/\/atlas\/asset\/issue$/.test(url) && i && i.method === 'POST') {
          let body = JSON.parse(i.body);
          const sent = { url, body: JSON.parse(i.body) };
          self.__sent.push(sent);
          if (self.__mode === 'strip') { delete body.intent; i = Object.assign({}, i, { body: JSON.stringify(body) }); }
          const res = await real(url, i);
          sent.status = res.status;
          if (self.__mode === 'lose-first' && !self.__lost) { self.__lost = true; throw new TypeError('Failed to fetch'); }
          return res;
        }
        return real(u, i);
      };
    });
    const sent = () => w.sw.evaluate(() => self.__sent.slice());
    const reset = (mode, skew) => w.sw.evaluate((a) => { self.__sent = []; self.__mode = a[0]; self.__skew = a[1] || 0; self.__lost = false; }, [mode, skew]);
    const mint = (domain, cls) => w.wallet((a) => AtlasWallet.mintAsset('self', a[0], a[1]).then((r) => ({ ok: true, credential: r.credential })).catch((e) => ({ ok: false, message: e.message, status: e.status, code: e.code, pending: !!e.pending })), [domain, cls]);
    const held = () => w.wallet((p) => AtlasWallet.getWallet(p).then((l) => l.map((e) => e.credential.asset.class + '@' + e.credential.issuer.domain)), w.pub);
    const stats = (inst) => lib.readJson(inst.statsFile, {});

    console.log('--- a signed request goes out where the issuer asks for it ---');
    for (const [inst, label] of [[nodeReq, 'Node require'], [nodeAccept, 'Node accept'], [phpReq, 'PHP require']]) {
      for (const cls of CLASSES) {
        await reset('real');
        const r = await mint(inst.domain, cls);
        const s = await sent();
        check(label + ': joining ' + cls + ' in one call works', r.ok && r.credential.owner.publicKey === w.pub && r.credential.asset.class === cls && r.credential.issuer.domain === inst.domain, r);
        const intent = s[0] && s[0].body.intent;
        check(label + ': ...with one request, carrying a signature from the identity the card is for, naming this domain, class and request id',
          s.length === 1 && s[0].status === 200 && intent && intent.proof.publicKey === w.pub && intent.payload.domain === inst.domain && intent.payload.assetClass === cls
          && intent.payload.requestId === s[0].body.requestId && intent.payload.ownerPublicKey === w.pub && intent.payload.action === 'issue' && intent.payload.quantity === 1, s);
      }
    }
    let st = stats(nodeReq).classes || {};
    check('Node require counted three signed issuances and nothing unsigned', CLASSES.every((c) => st[c] && st[c].signed === 1 && st[c].unsigned === 0), st);
    check('PHP require counted three signed issuances and nothing unsigned', CLASSES.every((c) => (stats(phpReq).classes || {})[c] && stats(phpReq).classes[c].signed === 1 && stats(phpReq).classes[c].unsigned === 0), stats(phpReq));

    console.log('--- an issuer that predates the check ---');
    await reset('real');
    const caps = await fetch('http://' + nodeOff.domain + '/atlas/capabilities').then((r) => r.json());
    check('the off issuer does not list ownerProof (it looks like an older issuer)', caps.ownerProof === undefined && Array.isArray(caps.requestIds.operations), caps);
    const legacy = await mint(nodeOff.domain, 'atlas.postoffice.membership');
    const ls = await sent();
    check('a join there still works, with the request the wallet always sent and no signature and no extra prompt', legacy.ok && ls.length === 1 && ls[0].body.intent === undefined, { legacy, ls });

    console.log('--- a wallet that cannot give the signature ---');
    await reset('strip');
    const before = (await held()).length;
    const stripped = await mint(nodeReq.domain, 'atlas.postoffice.membership');
    check('an issuer that insists on a signature is answered with the update message, word for word', !stripped.ok && stripped.message === MESSAGE && stripped.status === 403 && stripped.code === 'owner-authorization-required', stripped);
    check('...and the wallet holds nothing new and has no half-finished request waiting', (await held()).length === before && (await w.wallet((p) => AtlasWallet.getPendingOperations(p), w.pub)).length === 0);

    console.log('--- a wallet whose clock is wrong ---');
    await reset('real', 5 * 60 * 1000);
    const skewed = await w.wallet((d) => AtlasWallet.mintAsset('self', d, 'atlas.membership').then((r) => ({ ok: true, id: r.credential.id })).catch((e) => ({ ok: false, message: e.message, code: e.code })), phpReq.domain);
    const ss = await sent();
    check('five minutes fast: refused once as too old, then corrected from the issuer\'s own time and issued', skewed.ok && ss.length === 2 && ss[0].status === 401 && ss[1].status === 200, { skewed, ss: ss.map((x) => x.status) });
    await reset('real', 5 * 60 * 1000);
    const afterSkew = await mint(phpReq.domain, 'atlas.tradingstation.membership');
    const as = await sent();
    check('and the next join at that domain already uses the corrected time (one request)', afterSkew.ok && as.length === 1 && as[0].status === 200, { afterSkew, as: as.map((x) => x.status) });
    await reset('real', 0);

    console.log('--- an interrupted join is retried with the same signed bytes ---');
    await reset('lose-first');
    const rosterBefore = lib.snapshot(nodeAccept);
    const heldBefore = (await held()).filter((c) => c === 'atlas.membership@' + nodeAccept.domain).length;
    const lost = await mint(nodeAccept.domain, 'atlas.membership');
    check('the answer is lost: the wallet reports a request waiting, not a failure', !lost.ok && lost.pending, lost);
    const recovered = await w.wallet((p) => AtlasWallet.recoverPendingOperations(p), w.pub);
    const rs = await sent();
    check('recovery sends the identical body and the issuer answers from what it already issued', recovered.some((o) => o.status === 'completed') && rs.length === 2 && JSON.stringify(rs[0].body) === JSON.stringify(rs[1].body) && rs[1].status === 200, { recovered, statuses: rs.map((x) => x.status) });
    const rosterAfter = lib.snapshot(nodeAccept);
    check('one membership, one roster row and one welcome mail, not two', rosterAfter.subscribers === rosterBefore.subscribers + 1 && rosterAfter.mail === rosterBefore.mail + 1 && (await held()).filter((c) => c === 'atlas.membership@' + nodeAccept.domain).length === heldBefore + 1, { rosterBefore, rosterAfter, heldBefore });

    console.log('--- the Services tab: Join stays one click ---');
    await reset('real');
    const sub = await w.wallet(() => AtlasWallet.createSubIdentity('services'));
    await w.wallet((id) => AtlasWallet.switchIdentity(id), sub.id);
    const services = await w.wallet(async (d) => {
      const svc = AtlasWallet.getServices();
      await svc.addDomain(d);
      const joined = await AtlasWallet.joinService(d, 'postOffice');
      const view = await svc.service(d, 'postOffice');
      return { cls: joined.credential.asset.class, enabled: view.enabled, creds: view.credentials.length };
    }, nodeReq.domain);
    check('joining Global Mail from Services issues the card, signed, switches the service on and shows the card', services.cls === 'atlas.postoffice.membership' && services.creds === 1, services);
    const js = await sent();
    check('...with one signed request for the identity the wallet is acting as', js.length === 1 && js[0].body.intent && js[0].body.intent.proof.publicKey !== w.pub, js.length);
    await w.wallet(() => AtlasWallet.switchIdentity(null));

    console.log('--- a passkey identity ---');
    const page = await w.context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('chrome-extension://' + w.extId + '/viewer.html');
    await page.waitForFunction(() => typeof AtlasWallet !== 'undefined', null, { timeout: 15000 });
    const cdp = await w.context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    const passkey = await page.evaluate(async (d) => {
      try {
        const id = await AtlasWallet.createWebAuthnIdentity();
        const r = await AtlasWallet.mintAsset('self', d[0], d[1]);
        return { ok: true, key: id.publicKey || (await AtlasWallet.getIdentity()).publicKey, owner: r.credential.owner.publicKey, role: 'passkey' };
      } catch (e) { return { ok: false, message: e.message }; }
    }, [nodeReq.domain, 'atlas.postoffice.membership']);
    check('a passkey identity joins at a require issuer (one passkey assertion over the same request)', passkey.ok && passkey.key === passkey.owner, passkey);
    const passkeyPhp = await page.evaluate(async (d) => {
      try { const r = await AtlasWallet.mintAsset('self', d[0], d[1]); return { ok: true, owner: r.credential.owner.publicKey, me: (await AtlasWallet.getIdentity()).publicKey }; } catch (e) { return { ok: false, message: e.message }; }
    }, [phpReq.domain, 'atlas.tradingstation.membership']);
    check('a passkey identity joins at the PHP require issuer too', passkeyPhp.ok && passkeyPhp.owner === passkeyPhp.me, passkeyPhp);
    const ps = stats(nodeReq).classes['atlas.postoffice.membership'];
    check('...and the issuer counted it as signed', ps && ps.signed >= 3 && ps.unsigned === 0, ps);
    check('no page errors', errors.length === 0, errors);
  } catch (err) {
    console.log('FAIL unexpected error :: ' + (err && err.stack ? err.stack : err));
    exit = 1;
  } finally {
    if (w) await w.close();
    lib.stopAll();
  }
  exit = exit || L.finish('owner proof, wallet');
  process.exit(exit);
})();
