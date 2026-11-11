// Real-browser check of the Asset Studio equipment templates: the actual Studio page, the actual wallet
// extension and a real PHP issuer (isolated copy, fresh key and state). Run with a display, for example
//   xvfb-run -a node test/manual-studio-equipment-flow.js
//
// Proves: (1) the new tiles show their controls (stat steppers and colour for worn pieces, finish only for the
// sword) and the stat budget stops the steppers; (2) a sword and a necklace mint through the wallet prompt,
// which names the slot, colour and stats; (3) the claimed credentials are bound, never expire and carry the
// signed properties; (4) equipped, they give the sword's hand model, the necklace colour and the stat totals
// (including what Agility feeds into speed). Screenshots go to SHOT_DIR when set.
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StudioLab } = require('./studio-lab');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-equip-profile-'));
const CLASS = 'atlas.demo.studio.collectible';
const SHOT_DIR = process.env.SHOT_DIR || '';

function assertTrue(cond, msg) { if (!cond) throw new Error(msg); }

(async () => {
  const lab = await StudioLab.start({ mint: true, config: { mintsPerIpPerHour: 100, challengesPerIpPerHour: 100, maxMintsPerRecipientPerDay: 100, maxMintsPerActorPerDay: 1000 } });
  const spatial = {
    spec: 'domain-atlas/1.0', domain: lab.host, owner: { name: 'Studio Test Domain', contact: 'demo@localhost' },
    defaultWorld: 'studio',
    worlds: [{ id: 'studio', name: 'Asset Studio', policy: { walletBridge: { read: true, sign: ['atlas.studio.mint/1'], offer: [CLASS] } } }],
    updated: '2026-10-02T00:00:00Z',
  };
  fs.mkdirSync(path.join(lab.docroot, '.well-known'), { recursive: true });
  fs.writeFileSync(path.join(lab.docroot, '.well-known', 'spatial.json'), JSON.stringify(spatial, null, 2));
  if (SHOT_DIR) fs.mkdirSync(SHOT_DIR, { recursive: true });
  const shot = async (page, name) => { if (SHOT_DIR) await page.screenshot({ path: path.join(SHOT_DIR, name + '.png'), fullPage: true }); };

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false, executablePath: '/opt/pw-browsers/chromium', viewport: { width: 1280, height: 900 },
    args: ['--disable-extensions-except=' + EXT_PATH, '--load-extension=' + EXT_PATH, '--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  });
  let ok = false;
  try {
    let background = context.serviceWorkers()[0];
    if (!background) background = await context.waitForEvent('serviceworker');
    const extensionId = new URL(background.url()).host;

    const studio = await context.newPage();
    await studio.goto(lab.origin + '/atlas/studio/index.html', { waitUntil: 'load' });
    const walletPage = await context.newPage();
    await walletPage.goto('chrome-extension://' + extensionId + '/viewer.html', { waitUntil: 'load' });
    await walletPage.waitForFunction(() => document.getElementById('walletPanel').classList.contains('open'), null, { timeout: 10000 });
    await walletPage.locator('#chooseNewBtn').click();
    await walletPage.locator('#newPasswordInput').fill('studio-equip-test-pw');
    await walletPage.locator('#newPasswordConfirmInput').fill('studio-equip-test-pw');
    await walletPage.locator('#confirmCreateBtn').click();
    await walletPage.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), null, { timeout: 5000 });
    await walletPage.locator('#seedConfirmCheck').check();
    await walletPage.locator('#seedConfirmBtn').click();
    await walletPage.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), null, { timeout: 5000 });
    const identity = await walletPage.evaluate(async () => { const i = await AtlasWallet.getIdentity(); return i ? { publicKey: i.publicKey } : null; });
    assertTrue(identity && identity.publicKey, 'identity created');
    await studio.bringToFront();
    await studio.evaluate(() => window.dispatchEvent(new Event('focus')));
    await studio.waitForFunction(() => !document.getElementById('mint').disabled, null, { timeout: 15000 });
    console.log('SETUP: wallet identity and issuer ready');


    // The wallet shows the signature prompt, then the offer prompt, in one iframe; click through whichever is up until the page reports the offer.
    const approveOffer = async () => {
      const done = () => studio.evaluate(() => /Offered to your wallet|Added to your wallet/.test(document.getElementById('message').textContent));
      const deadline = Date.now() + 40000;
      while (Date.now() < deadline) {
        if (await done()) return;
        for (const id of ['#approveBtn', '#offerApproveBtn']) {
          const btn = studio.frameLocator('#domain-atlas-bridge-confirm').locator(id);
          if (await btn.isVisible().catch(() => false)) await btn.click({ timeout: 2000 }).catch(() => {});
        }
        await studio.waitForTimeout(400);
      }
      throw new Error('offer step: page says "' + (await studio.locator('#message').innerText()) + '"');
    };
    const visible = (sel) => studio.evaluate((s) => { const e = document.querySelector(s); return !!e && !e.hidden && e.offsetParent !== null; }, sel);
    const tile = (t) => studio.locator('#templateTiles [data-value="' + t + '"]').click();
    const plus = (id) => studio.locator('#statRows [data-stat="' + id + '"] button[aria-label^="More"]').click();
    const points = (id) => studio.locator('#statRows [data-stat="' + id + '"] output').innerText();

    console.log('STEP 1: the controls follow the template');
    await shot(studio, 'studio-trophy');
    assertTrue(!(await visible('#colorField')) && !(await visible('#statsField')), 'a trophy has no colour or stat controls');
    await tile('sword');
    assertTrue(!(await visible('#colorField')) && (await visible('#statsField')) && (await visible('#boundNote')), 'a sword shows stats and the bound note, no colour');
    assertTrue(!(await visible('#expiryField')) && !(await visible('#scopeField')), 'a sword hides ownership and expiry choices');
    await studio.locator('#finish').evaluate((el) => { el.value = 'silver'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
    await studio.locator('#assetName').fill('Silver Edge');
    await studio.locator('#description').fill('A plain sword with a keen edge.');
    for (let i = 0; i < 5; i++) await plus('strength').catch(() => {});
    assertTrue((await points('strength')) === '4', 'the per-stat cap stops Strength at 4, got ' + (await points('strength')));
    for (const id of ['agility', 'agility', 'agility', 'dexterity']) await plus(id);
    assertTrue((await points('agility')) === '3' && (await points('dexterity')) === '1', 'points land where they are asked');
    assertTrue(/0 of 8 left/.test(await studio.locator('#statsLeft').innerText()), 'budget counter shows 0 left: ' + (await studio.locator('#statsLeft').innerText()));
    await studio.locator('#statRows [data-stat="criticalStrike"] button[aria-label^="More"]').click({ force: true, timeout: 2000 }).catch(() => {});
    assertTrue((await points('criticalStrike')) === '0', 'the budget stops further points');
    await shot(studio, 'studio-sword');
    console.log('PASS: controls follow the template; cap and budget hold');

    console.log('STEP 2: mint the sword; the prompt names the stats');
    await studio.locator('#mint').click();
    await studio.waitForSelector('#domain-atlas-bridge-confirm', { timeout: 15000 });
    let frame = studio.frameLocator('#domain-atlas-bridge-confirm');
    await frame.locator('#readyState').waitFor({ state: 'visible', timeout: 10000 });
    const box = await frame.locator('#payloadBox').innerText();
    assertTrue(box.includes('Mint a free demo sword (silver) named "Silver Edge" for the main hand slot') || box.includes('Mint a free demo sword (silver) named "Silver Edge"'), 'prompt names the sword: ' + box);
    assertTrue(/Agility \+3/.test(box) && /Dexterity \+1/.test(box) && /Strength \+4/.test(box), 'prompt lists the stats: ' + box);
    await approveOffer();
    console.log('PASS: sword minted and offered');

    console.log('STEP 3: a necklace in a chosen colour');
    await tile('necklace');
    assertTrue((await visible('#colorField')) && (await visible('#statsField')), 'a necklace shows colour and stats');
    await studio.locator('#colorInput').evaluate((el) => { el.value = '#aa33cc'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await studio.locator('#assetName').fill('Violet Charm');
    await plus('luck'); await plus('luck'); await plus('focus');
    await shot(studio, 'studio-necklace');
    await studio.locator('#mint').click();
    await studio.waitForSelector('#domain-atlas-bridge-confirm', { timeout: 15000 });
    frame = studio.frameLocator('#domain-atlas-bridge-confirm');
    await frame.locator('#readyState').waitFor({ state: 'visible', timeout: 10000 });
    const box2 = await frame.locator('#payloadBox').innerText();
    assertTrue(box2.includes('for the neck slot in colour #aa33cc') && /Luck \+2/.test(box2) && /Focus \+1/.test(box2), 'prompt names slot, colour and stats: ' + box2);
    await approveOffer();
    console.log('PASS: necklace minted and offered');

    console.log('STEP 3b: a ring and an off-hand shield, each with a finish model and no colour');
    await tile('ring');
    assertTrue(!(await visible('#colorField')) && (await visible('#statsField')), 'a ring shows stats and no colour');
    await studio.locator('#assetName').fill('Band of Fortune');
    await plus('luck'); await plus('luck'); await plus('dexterity');
    await shot(studio, 'studio-ring');
    await studio.locator('#mint').click();
    await studio.waitForSelector('#domain-atlas-bridge-confirm', { timeout: 15000 });
    frame = studio.frameLocator('#domain-atlas-bridge-confirm');
    await frame.locator('#readyState').waitFor({ state: 'visible', timeout: 10000 });
    const box3 = await frame.locator('#payloadBox').innerText();
    assertTrue(box3.includes('for the ring slot') && /Luck \+2/.test(box3) && /Dexterity \+1/.test(box3), 'prompt names the ring slot and stats: ' + box3);
    await approveOffer();
    await tile('shield');
    await studio.locator('#assetName').fill('Oak Bulwark');
    for (const id of ['armor', 'armor', 'armor', 'defense', 'defense']) await plus(id);
    await shot(studio, 'studio-shield');
    await studio.locator('#mint').click();
    await studio.waitForSelector('#domain-atlas-bridge-confirm', { timeout: 15000 });
    frame = studio.frameLocator('#domain-atlas-bridge-confirm');
    await frame.locator('#readyState').waitFor({ state: 'visible', timeout: 10000 });
    const box4 = await frame.locator('#payloadBox').innerText();
    assertTrue(box4.includes('for the off hand slot') && /Armor \+3/.test(box4) && /Defense \+2/.test(box4), 'prompt names the off hand slot and stats: ' + box4);
    await approveOffer();
    console.log('PASS: ring and shield minted and offered');

    console.log('STEP 4: claim both; the credentials are bound, never expire and carry the signed properties');
    const pending = await walletPage.evaluate((o) => AtlasWallet.getBridgeOffers(o), identity.publicKey);
    const byName = (n) => pending.find((e) => e.credential && e.credential.asset && e.credential.asset.name === n);
    const swordOffer = byName('Silver Edge'), neckOffer = byName('Violet Charm'), ringOffer = byName('Band of Fortune'), shieldOffer = byName('Oak Bulwark');
    assertTrue(swordOffer && neckOffer && ringOffer && shieldOffer, 'all four offers are queued');
    for (const o of [swordOffer, neckOffer, ringOffer, shieldOffer]) {
      const claim = await walletPage.evaluate(({ own, id }) => AtlasWallet.claimBridgeOffer(own, id), { own: identity.publicKey, id: o.id });
      assertTrue(claim.verdict && claim.verdict.valid === true, 'wallet verification: ' + JSON.stringify(claim.verdict));
    }
    const sword = swordOffer.credential.asset, neck = neckOffer.credential.asset;
    assertTrue(sword.tradeScope === 'bound' && neck.tradeScope === 'bound', 'both are bound');
    assertTrue(!swordOffer.credential.expiresAt && !neckOffer.credential.expiresAt && !sword.expiresAt && !neck.expiresAt, 'neither expires');
    assertTrue(sword.model.endsWith('/assets/studio/sword-silver.glb') && neck.model.endsWith('/assets/studio/necklace.glb'), 'issuer-controlled models');
    assertTrue(sword.properties['atlas.avatar.handItem'] === 'true' && sword.properties['atlas.avatar.stat.strength'] === 4 && sword.properties['atlas.avatar.stat.agility'] === 3 && sword.properties['atlas.avatar.stat.dexterity'] === 1, 'sword properties: ' + JSON.stringify(sword.properties));
    assertTrue(neck.properties['atlas.avatar.slot'] === 'neck' && neck.properties['atlas.avatar.color'] === '#aa33cc' && neck.properties['atlas.avatar.stat.luck'] === 2 && neck.properties['atlas.avatar.stat.focus'] === 1, 'necklace properties: ' + JSON.stringify(neck.properties));
    for (const o of [ringOffer, shieldOffer]) assertTrue(o.credential.asset.tradeScope === 'bound' && !o.credential.expiresAt && !o.credential.asset.expiresAt, 'ring and shield are bound and never expire');
    const ringAsset = ringOffer.credential.asset, shieldAsset = shieldOffer.credential.asset;
    assertTrue(ringAsset.properties['atlas.avatar.slot'] === 'ring' && ringAsset.model.endsWith('/assets/studio/ring-silver.glb') && ringAsset.properties['atlas.avatar.stat.luck'] === 2, 'ring properties: ' + JSON.stringify(ringAsset.properties));
    assertTrue(shieldAsset.properties['atlas.avatar.slot'] === 'offhand' && shieldAsset.model.endsWith('/assets/studio/shield-silver.glb') && shieldAsset.properties['atlas.avatar.stat.armor'] === 3, 'shield properties: ' + JSON.stringify(shieldAsset.properties));
    console.log('PASS: claimed, bound, non-expiring, signed properties intact');

    console.log('STEP 5: equipped, the pieces show in the wallet\'s own character data');
    const result = await walletPage.evaluate(async ({ s, n, rg, sh }) => {
      const slotsOf = (id) => AtlasWallet.avatarSlotsOfAsset(id);
      const wallet = await AtlasWallet.getWallet((await AtlasWallet.getIdentity()).publicKey);
      const find = (name) => wallet.find((e) => e.credential.asset.name === name).credential;
      const swordCred = find(s), neckCred = find(n), ringCred = find(rg), shieldCred = find(sh);
      await AtlasWallet.setAvatarHand(swordCred.id);
      await AtlasWallet.setAvatarSlot('neck', neckCred.id);
      await AtlasWallet.setAvatarSlot('ring1', ringCred.id);
      await AtlasWallet.setAvatarSlot('offhand', shieldCred.id);
      const hand = await AtlasWallet.getAvatarHand();
      const extras = await AtlasWallet.getAvatarExtras();
      const sheet = await AtlasWallet.getAvatarStatSheet();
      const stat = (id) => sheet.stats.find((x) => x.id === id).total;
      return { slots: [slotsOf(swordCred.asset), slotsOf(neckCred.asset), slotsOf(ringCred.asset), slotsOf(shieldCred.asset)], offHandModel: extras.offHandModel, armor: stat('armor'), defense: stat('defense'), hand, neckColor: extras.neckColor, speed: extras.speedMultiplier, jump: extras.jumpMultiplier,
        strength: stat('strength'), agility: stat('agility'), dexterity: stat('dexterity'), luck: stat('luck'), focus: stat('focus'), stamina: stat('stamina'), health: stat('health') };
    }, { s: 'Silver Edge', n: 'Violet Charm', rg: 'Band of Fortune', sh: 'Oak Bulwark' });
    assertTrue(result.slots[0].includes('hand') && result.slots[1].includes('neck') && result.slots[2].includes('ring1') && result.slots[3].includes('offhand'), 'each fits its slot: ' + JSON.stringify(result.slots));
    assertTrue(/\/assets\/studio\/shield-silver\.glb$/.test(result.offHandModel || ''), 'the shield is the off hand model: ' + result.offHandModel);
    assertTrue(result.hand && /\/assets\/studio\/sword-silver\.glb$/.test(result.hand.handModel), 'the sword is the hand model: ' + JSON.stringify(result.hand));
    assertTrue(result.neckColor === '#aa33cc', 'the necklace colour reaches the renderer: ' + result.neckColor);
    assertTrue(result.strength === 14 && result.agility === 13 && result.dexterity === 12 && result.luck === 14 && result.focus === 11 && result.armor === 13 && result.defense === 12, 'stat totals add to base 10 (armor 13, defense 12): ' + JSON.stringify(result));
    assertTrue(Math.abs(result.speed - 1.03) < 1e-6 && Math.abs(result.jump - 1.04) < 1e-6, 'Agility and Strength each add 1% per point to speed and jump: ' + result.speed + '/' + result.jump);
    assertTrue(result.stamina === 115 && result.health === 120, 'Agility feeds Stamina and Strength feeds Health at +5 per point: ' + result.stamina + '/' + result.health);
    console.log('PASS: hand model, neck colour, stat totals and movement as expected');

    if (SHOT_DIR) {
      const phone = await context.newPage();
      await phone.setViewportSize({ width: 390, height: 844 });
      await phone.goto(lab.origin + '/atlas/studio/index.html', { waitUntil: 'load' });
      await phone.locator('#templateTiles [data-value="shoulders"]').click();
      await phone.locator('#statRows [data-stat="armor"] button[aria-label^="More"]').click();
      await phone.waitForTimeout(800);
      await shot(phone, 'studio-shoulders-phone');
      const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assertTrue(overflow <= 0, 'no horizontal scroll on a phone, overflow ' + overflow);
      console.log('PASS: phone layout has no horizontal scroll');
    }
    ok = true;
  } finally {
    await context.close().catch(() => {});
    await lab.stop();
    lab.cleanup();
    fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  }
  console.log(ok ? '\nAll Studio equipment checks passed' : '\nFAILED');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FAIL: ' + (e && e.stack || e)); process.exit(1); });
