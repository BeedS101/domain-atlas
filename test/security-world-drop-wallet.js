// The real wallet's cross-domain drop and pick-up against two throw-away issuers: the wallet signs the drop and claim
// intents the issuer now requires, a world hosted on one domain holds an item issued by the other, and the issuer settles
// the pick-up. Scratch profile, local servers only.
//
// Run: STACK=node xvfb-run -a node test/security-world-drop-wallet.js   (or STACK=php)
'use strict';
const L = require('./call-e2e-lib');
const S = require('./support/issuer-stack');
const { check } = L;

const STACK = process.env.STACK || 'node';
const BASE_PORT = STACK === 'php' ? 8460 : 8450;

(async () => {
  const A = await S.startIssuer(STACK, BASE_PORT);
  const B = await S.startIssuer(STACK, BASE_PORT + 1);
  const w = await L.launchWallet('world-drop-wallet');
  try {
    const me = (await w.wallet((pw) => AtlasWallet.createIdentity(pw), 'world-drop-wallet-password')).publicKey;
    const page = await w.context.newPage();
    await page.goto('chrome-extension://' + w.extId + '/viewer.html');
    await page.waitForFunction(() => typeof AtlasWallet !== 'undefined', null, { timeout: 15000 });

    const minted = await page.evaluate(([dom]) => AtlasWallet.mintAsset('self', dom, 'atlas.trophy.chess'), [A.domain]);
    const held = await page.evaluate(async () => (await AtlasWallet.getWallet((await AtlasWallet.getIdentity()).publicKey)).filter((e) => e.credential.asset.class === 'atlas.trophy.chess').map((e) => e.credential));
    check('the wallet holds a trophy issued by A', held.length === 1 && held[0].issuer.domain === A.domain, held.length);

    const sentDrops = [];
    page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/atlas/world/drop')) sentDrops.push(JSON.parse(r.postData())); });
    const before = Date.now();
    await page.evaluate(([c, dom]) => AtlasWallet.dropItem(c, dom, 'wallet-world', [1, 0, 1]), [held[0], B.domain]);
    const signed = sentDrops.length === 1 && sentDrops[0].intent.payload;
    const expiresMs = signed && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(signed.expiresAt || '') ? Date.parse(signed.expiresAt) : NaN;
    check('the wallet signs a bounded expiresAt with the drop intent (about ten minutes ahead)', expiresMs - before > 8 * 60 * 1000 && expiresMs - Date.now() < 11 * 60 * 1000, signed);
    const listed = await S.get(B.base, '/atlas/world/drops?world=wallet-world');
    check('B\'s world lists the item', listed.body.drops.length === 1 && listed.body.drops[0].credential.id === held[0].id, listed.body);
    check('it left the wallet', (await page.evaluate(async () => (await AtlasWallet.getWallet((await AtlasWallet.getIdentity()).publicKey)).length)) === 0);

    const picked = await page.evaluate(([dom, dropId]) => AtlasWallet.pickUpItem(dom, dropId), [B.domain, listed.body.drops[0].dropId]);
    check('picking it up (relayed to A) returns a fresh credential owned by the wallet', picked && picked.owner.publicKey === me && picked.id !== held[0].id && picked.issuer.domain === A.domain, picked);
    const revoked = (await S.get(A.base, '/.well-known/atlas-revocations.json')).body.revoked.map((e) => e.id);
    check('A revoked the dropped credential', revoked.includes(held[0].id));
    check('B\'s list is empty again', (await S.get(B.base, '/atlas/world/drops?world=wallet-world')).body.drops.length === 0);
  } finally {
    await w.close();
    A.stop(); B.stop();
  }
  process.exit(L.finish('security-world-drop-wallet'));
})().catch((e) => { console.log('FATAL ' + (e && e.stack || e)); process.exit(1); });
