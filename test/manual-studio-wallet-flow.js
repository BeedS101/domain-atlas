// Real-browser check of the Asset Studio mint flow: the actual Studio page, the actual wallet extension
// and a real PHP issuer (isolated copy, fresh key and state). Run with a display, for example
//   xvfb-run -a node test/manual-studio-wallet-flow.js
//
// Proves, in order: (1) a page that does not declare the studio world cannot request a mint signature;
// (2) the Studio page enables Mint only with a wallet identity and an enabled issuer; (3) the wallet
// prompt shows the issuer's exact request, and Deny mints nothing; (4) Approve produces one issuer-signed
// credential and the page offers it to the wallet; (5) approving the offer queues it unclaimed; (6) the
// wallet's own Claim verifies the issuer signature against the issuer's published key and adds it.
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StudioLab } = require('./studio-lab');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-wallet-profile-'));
const CLASS = 'atlas.demo.studio.collectible';

function assertTrue(cond, msg) { if (!cond) throw new Error(msg); }

(async () => {
  const lab = await StudioLab.start({ mint: true, config: { mintsPerIpPerHour: 100, challengesPerIpPerHour: 100 } });
  const replayCount = () => { try { return fs.readdirSync(path.join(lab.private, 'replay')).filter((n) => /\.json$/.test(n)).length; } catch (e) { return 0; } };
  const spatial = {
    spec: 'domain-atlas/1.0', domain: lab.host, owner: { name: 'Studio Test Domain', contact: 'demo@localhost' },
    defaultWorld: 'lobby',
    worlds: [
      { id: 'lobby', name: 'Lobby', entry: { scene: '/spatial/lobby/scene.json', renderer: ['procedural-v1'] },
        policy: { guestAccess: 'open', discoverable: true, identityRequired: false, itemDropsAllowed: false, acceptedItemClasses: [], trustedIssuers: 'any' } },
      { id: 'studio', name: 'Asset Studio', policy: { walletBridge: { read: true, sign: ['atlas.studio.mint/1'], offer: [CLASS] } } },
    ],
    updated: '2026-10-02T00:00:00Z',
  };
  fs.mkdirSync(path.join(lab.docroot, '.well-known'), { recursive: true });
  fs.writeFileSync(path.join(lab.docroot, '.well-known', 'spatial.json'), JSON.stringify(spatial, null, 2));
  fs.writeFileSync(path.join(lab.docroot, 'nopolicy.html'), '<!doctype html><title>x</title><body>no spatial link</body>');
  console.log('SETUP: PHP issuer with minting enabled on ' + lab.origin);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false, executablePath: '/opt/pw-browsers/chromium',
    args: ['--disable-extensions-except=' + EXT_PATH, '--load-extension=' + EXT_PATH, '--no-sandbox'],
  });
  let ok = false;
  try {
    let background = context.serviceWorkers()[0];
    if (!background) background = await context.waitForEvent('serviceworker');
    const extensionId = new URL(background.url()).host;

    console.log('STEP 1: a page with no studio world cannot request a mint signature');
    const plain = await context.newPage();
    await plain.goto(lab.origin + '/nopolicy.html', { waitUntil: 'load' });
    const refused = await plain.evaluate(() => window.atlasWallet.requestSignature({ purpose: 'atlas.studio.mint/1', nonce: 'x' }));
    assertTrue(refused.allowed === false && refused.result === null, 'expected refusal, got ' + JSON.stringify(refused));
    assertTrue(await plain.locator('#domain-atlas-bridge-confirm').count() === 0, 'no prompt for a refused page');
    await plain.close();
    console.log('PASS: refused without a prompt');

    console.log('STEP 2: the Studio page keeps Mint disabled until a wallet identity exists');
    const studio = await context.newPage();
    await studio.goto(lab.origin + '/atlas/studio/index.html', { waitUntil: 'load' });
    await studio.waitForFunction(() => document.getElementById('walletStatus').textContent.length > 0 && !/Checking/.test(document.getElementById('walletStatus').textContent), null, { timeout: 15000 });
    assertTrue(await studio.locator('#mint').isDisabled(), 'Mint must be disabled with no wallet identity');
    console.log('PASS: Mint disabled; wallet status: "' + (await studio.locator('#walletStatus').innerText()) + '"');

    console.log('STEP 3: creating a real wallet identity');
    const walletPage = await context.newPage();
    await walletPage.goto('chrome-extension://' + extensionId + '/viewer.html', { waitUntil: 'load' });
    await walletPage.waitForFunction(() => document.getElementById('walletPanel').classList.contains('open'), null, { timeout: 10000 });
    await walletPage.locator('#chooseNewBtn').click();
    await walletPage.locator('#newPasswordInput').fill('studio-flow-test-pw');
    await walletPage.locator('#newPasswordConfirmInput').fill('studio-flow-test-pw');
    await walletPage.locator('#confirmCreateBtn').click();
    await walletPage.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), null, { timeout: 5000 });
    await walletPage.locator('#seedConfirmCheck').check();
    await walletPage.locator('#seedConfirmBtn').click();
    await walletPage.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), null, { timeout: 5000 });
    const identity = await walletPage.evaluate(async () => { const i = await AtlasWallet.getIdentity(); return i ? { publicKey: i.publicKey, role: i.role || i.signerRole || null } : null; });
    assertTrue(identity && identity.publicKey, 'identity created');
    console.log('PASS: identity ' + identity.publicKey.slice(0, 12) + '… (' + identity.publicKey.length + ' chars)');

    await studio.bringToFront();
    await studio.evaluate(() => window.dispatchEvent(new Event('focus')));
    await studio.waitForFunction(() => !document.getElementById('mint').disabled, null, { timeout: 15000 }).catch(async (e) => {
      throw new Error('Mint stayed disabled; wallet status: "' + (await studio.locator('#walletStatus').innerText()) + '"; getIdentity: ' + JSON.stringify(await studio.evaluate(() => window.atlasWallet.getIdentity())) + '; status op: ' + JSON.stringify((await lab.status()).json));
    });
    console.log('PASS: Mint enabled once the wallet identity and the issuer are both available');

    console.log('STEP 4: Deny at the wallet prompt mints nothing');
    await studio.locator('#assetName').fill('Walkthrough Trophy');
    await studio.locator('#description').fill('Minted by the browser test.');
    await studio.locator('#mint').click();
    await studio.waitForSelector('#domain-atlas-bridge-confirm', { timeout: 15000 });
    let frame = studio.frameLocator('#domain-atlas-bridge-confirm');
    await frame.locator('#readyState').waitFor({ state: 'visible', timeout: 10000 });
    const originShown = await frame.locator('#origin').innerText();
    assertTrue(originShown === lab.origin, 'prompt shows the page origin, got ' + originShown);
    assertTrue((await frame.locator('#purposeText').innerText()) === 'atlas.studio.mint/1', 'prompt shows the purpose');
    const box = await frame.locator('#payloadBox').innerText();
    assertTrue(box.includes('Mint a free demo trophy (gold) named "Walkthrough Trophy". It has no value and is bound to this wallet: it cannot be transferred or traded.'), 'prompt shows the issuer-computed summary: ' + box);
    assertTrue(box.includes(identity.publicKey), 'prompt shows the recipient key');
    await frame.locator('#denyBtn').click();
    await studio.waitForFunction(() => /declined|timed out/.test(document.getElementById('message').textContent), null, { timeout: 15000 });
    assertTrue(replayCount() === 0, 'a denied signature must mint nothing');
    console.log('PASS: prompt showed the exact request; Deny minted nothing');

    console.log('STEP 5: Approve the signature, then the wallet offer');
    await studio.locator('#mint').click();
    await studio.waitForSelector('#domain-atlas-bridge-confirm', { timeout: 15000 });
    frame = studio.frameLocator('#domain-atlas-bridge-confirm');
    await frame.locator('#readyState').waitFor({ state: 'visible', timeout: 10000 });
    await frame.locator('#approveBtn').click();
    await studio.waitForSelector('#domain-atlas-bridge-confirm', { state: 'detached', timeout: 15000 }).catch(() => {});
    await studio.waitForSelector('#domain-atlas-bridge-confirm', { timeout: 15000 });
    frame = studio.frameLocator('#domain-atlas-bridge-confirm');
    await frame.locator('#offerState').waitFor({ state: 'visible', timeout: 15000 });
    assertTrue((await frame.locator('#offerAssetName').innerText()) === 'Walkthrough Trophy', 'offer names the designed asset');
    assertTrue((await frame.locator('#offerAssetClass').innerText()) === CLASS, 'offer shows the studio class');
    assertTrue(replayCount() === 1, 'exactly one credential issued at this point, got ' + replayCount());
    await frame.locator('#offerApproveBtn').click();
    await studio.waitForFunction(() => /Offered to your wallet|Added to your wallet/.test(document.getElementById('message').textContent), null, { timeout: 15000 });
    console.log('PASS: one credential issued; wallet offer approved: "' + (await studio.locator('#message').innerText()) + '"');

    console.log('STEP 6: the offer is pending and unclaimed; the wallet\'s own Claim verifies the issuer signature');
    const pending = await walletPage.evaluate((o) => AtlasWallet.getBridgeOffers(o), identity.publicKey);
    const entry = pending.find((e) => e.credential && e.credential.asset && e.credential.asset.class === CLASS);
    assertTrue(entry && !entry.claimed, 'queued unclaimed: ' + JSON.stringify(pending).slice(0, 300));
    const cred = entry.credential;
    assertTrue(cred.owner.publicKey === identity.publicKey && cred.asset.name === 'Walkthrough Trophy' && cred.asset.tradeScope === 'bound', 'credential is owner-bound and carries the design');
    assertTrue(cred.asset.model.endsWith('/assets/trophy.glb') && cred.asset.thumbnail.endsWith('/assets/trophy.png'), 'issuer-controlled model references');
    const before = await walletPage.evaluate((o) => AtlasWallet.getWallet(o), identity.publicKey);
    assertTrue(!before.some((e) => e.credential.id === cred.id), 'not in the wallet before Claim');
    const claim = await walletPage.evaluate(({ o, id }) => AtlasWallet.claimBridgeOffer(o, id), { o: identity.publicKey, id: entry.id });
    assertTrue(claim.verdict && claim.verdict.valid === true, 'wallet verification: ' + JSON.stringify(claim.verdict));
    const after = await walletPage.evaluate((o) => AtlasWallet.getWallet(o), identity.publicKey);
    assertTrue(after.some((e) => e.credential.id === cred.id), 'in the wallet after Claim');
    const stored = JSON.parse(fs.readFileSync(path.join(lab.private, 'replay', fs.readdirSync(path.join(lab.private, 'replay'))[0]), 'utf8'));
    assertTrue(JSON.parse(stored.responseJson).credential.id === cred.id, 'the wallet holds exactly the credential the issuer committed');
    console.log('PASS: Claim verified the signature against the issuer\'s published key and added the committed credential');

    console.log('STEP 7: a forged credential offered through the same page is rejected by the wallet at Claim');
    const forged = JSON.parse(JSON.stringify(cred));
    forged.asset.name = 'Forged Trophy';
    forged.id = 'urn:atlas:asset:00000000-0000-4000-8000-000000000000';
    const offer = studio.evaluate((c) => window.atlasWallet.offerAsset(c), forged);
    offer.catch(() => {});
    await studio.waitForSelector('#domain-atlas-bridge-confirm', { timeout: 15000 });
    frame = studio.frameLocator('#domain-atlas-bridge-confirm');
    await frame.locator('#offerState').waitFor({ state: 'visible', timeout: 15000 });
    await frame.locator('#offerApproveBtn').click();
    const res = await offer;
    const queued = res && res.result && res.result.offerId;
    if (queued) {
      const bad = await walletPage.evaluate(({ o, id }) => AtlasWallet.claimBridgeOffer(o, id), { o: identity.publicKey, id: queued }).catch((e) => ({ error: String(e) }));
      assertTrue(!(bad.verdict && bad.verdict.valid === true), 'a forged credential must not verify: ' + JSON.stringify(bad).slice(0, 200));
      const w = await walletPage.evaluate((o) => AtlasWallet.getWallet(o), identity.publicKey);
      assertTrue(!w.some((e) => e.credential.id === forged.id), 'forged credential must not enter the wallet');
    }
    console.log('PASS: forged credential did not enter the wallet');
    ok = true;
  } finally {
    await context.close().catch(() => {});
    await lab.stop();
    lab.cleanup();
    fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  }
  console.log(ok ? '\nAll Studio wallet-flow checks passed' : '\nFAILED');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FAIL: ' + (e && e.stack || e)); process.exit(1); });
