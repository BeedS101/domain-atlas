// Manual check for the admin panel's "Currently suspended" list (inside "Suspend / unsuspend a credential") and
// its "Site status" section, in a real browser against either issuer:
//
//   node test/manual-admin-panel-site.js node
//   node test/manual-admin-panel-site.js php
//
// The list shows what the server reports (newest first), refreshes after a suspend and an unsuspend, lifts a row
// from its own button, shows hostile text as text, and is empty-state friendly. Site status shows each feature
// with its state, offers a pause button only where the server says a feature is pausable and on, needs a second
// click, and shows the new state afterwards. A moderator sees neither section.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');
const H = require('./lib/delivery-harness');
const { withAdminAuth } = require('./lib/admin-auth');

const KIND = process.argv[2] === 'php' ? 'php' : 'node';
const assert = (c, m) => { if (!c) throw new Error('ASSERTION FAILED: ' + m); };

(async () => {
  const port = KIND === 'node' ? 8231 : 8232;
  const BASE = 'http://localhost:' + port;
  let issuer, stateOf, wellKnown;
  if (KIND === 'node') {
    const docroot = H.tmpDir('atlas-panelsite-docroot-');
    fs.cpSync(path.join(H.ROOT, 'demo-domain-a'), docroot, { recursive: true });
    const stateDir = H.tmpDir('atlas-panelsite-state-');
    issuer = await H.startNodeIssuer({ port, stateDir, docrootDir: docroot, env: { ATLAS_ADMIN_FAIL_LIMIT: '1000' } });
    stateOf = (n) => path.join(stateDir, n); wellKnown = (n) => path.join(docroot, '.well-known', n);
  } else {
    const bundleDir = H.preparePhpBundle();
    issuer = await H.startPhpIssuer({ port, bundleDir, env: { ATLAS_ADMIN_FAIL_LIMIT: '1000' } });
    stateOf = (n) => path.join(bundleDir, 'lib', n); wellKnown = (n) => path.join(bundleDir, '.well-known', n);
    fs.writeFileSync(wellKnown('atlas-revocations.json'), JSON.stringify({ revoked: [] }));
  }
  const admin = await H.genIdentity(), moderator = await H.genIdentity();
  fs.writeFileSync(stateOf('atlas-admin-keys-store.json'), JSON.stringify({ keys: [
    { publicKey: admin.publicKey, addedAt: new Date().toISOString() },
    { publicKey: moderator.publicKey, addedAt: new Date().toISOString(), role: 'moderator', worlds: ['plaza'], operations: ['mute'] }
  ] }));
  async function login(id) {
    const nonce = (await H.getJson(BASE, '/atlas/admin/session/nonce')).body.nonce;
    const payload = withAdminAuth({ nonce }, BASE, '/atlas/admin/session/start');
    const r = await H.postJson(BASE, '/atlas/admin/session/start', { payload, proof: await H.signWithSelf(id, payload) });
    assert(r.status === 200, 'login ' + JSON.stringify(r.body));
    return r.body.token;
  }
  const adminToken = await login(admin), modToken = await login(moderator);
  const ledgerCfg = stateOf('atlas-ledger-issuance-config.json');
  const ledgerDomain = KIND === 'php' ? 'localhost:' + port : require('../issuer-server/lib-ledger-issuance').HOSTS[0];
  fs.writeFileSync(ledgerCfg, JSON.stringify({ enabled: true, domain: ledgerDomain, perClientPerMinute: 9 }));
  const issue = async () => (await H.issueAsset(BASE, 'owner-' + crypto.randomBytes(6).toString('hex'), 'atlas.trophy.chess', 1)).id;
  const asAdmin = (p, payload) => H.postJson(BASE, p, { payload: payload || {}, token: adminToken });

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const open = async (token) => {
    const ctx = await browser.newContext();
    await ctx.addInitScript((t) => { try { sessionStorage.setItem('atlasAdminSession', JSON.stringify({ token: t, expiresAt: Date.now() + 3600000 })); } catch (e) {} }, token);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('dialog', (d) => { errors.push('unexpected dialog: ' + d.message()); d.dismiss(); });
    await page.goto(BASE + '/atlas-admin/', { waitUntil: 'load' });
    return { page, errors };
  };
  try {
    console.log('STEP 1: an empty list says so');
    fs.writeFileSync(wellKnown('atlas-suspensions.json'), JSON.stringify({ suspended: [] }));
    const { page, errors } = await open(adminToken);
    await page.waitForFunction(() => /Nothing is suspended/.test(document.getElementById('suspList').textContent), null, { timeout: 10000 });
    assert((await page.textContent('#suspCount')) === '(0)', 'count');

    console.log('STEP 2: suspending from the form adds the row and the count');
    const a = await issue(), b = await issue();
    await page.fill('#suspendId', a);
    await page.fill('#suspendReason', 'fraud-report');
    await page.click('#suspendBtn');
    await page.waitForSelector('#suspList .susp-row', { timeout: 5000 });
    assert((await page.textContent('#suspCount')) === '(1)', 'count 1');
    assert((await page.textContent('#suspList .susp-id')) === a, 'row id');
    assert(/Reason: fraud-report/.test(await page.textContent('#suspList .susp-meta')) && /until lifted/.test(await page.textContent('#suspList .susp-meta')), 'row meta');

    console.log('STEP 3: a timed "revoke when it ends" suspension shows the badge and its end time');
    const later = new Date(Date.now() + 3600e3).toISOString().replace(/\.\d{3}Z$/, 'Z');
    // only the server itself marks an entry "finalize" (the /atlas/suspend route takes no such option), so seed the file
    const doc = JSON.parse(fs.readFileSync(wellKnown('atlas-suspensions.json'), 'utf8'));
    doc.suspended.push({ id: b, suspendedAt: new Date().toISOString(), reason: 'door-scan', expiresAt: later, onExpire: 'finalize' });
    fs.writeFileSync(wellKnown('atlas-suspensions.json'), JSON.stringify(doc));
    await page.click('#suspRefreshBtn');
    await page.waitForFunction(() => document.querySelectorAll('#suspList .susp-row').length === 2, null, { timeout: 5000 });
    const rowB = page.locator('#suspList .susp-row', { hasText: b });
    assert(/revokes when it ends/.test(await rowB.textContent()), 'badge');
    assert((await rowB.textContent()).includes(later.replace('T', ' ')), 'end time shown');

    console.log('STEP 4: "Use this id" fills the form; the row button lifts the suspension and the list updates');
    await rowB.locator('text=Use this id').click();
    assert((await page.inputValue('#suspendId')) === b, 'id copied into the form');
    await page.locator('#suspList .susp-row', { hasText: a }).locator('text=Unsuspend').click();
    await page.waitForFunction(() => document.querySelectorAll('#suspList .susp-row').length === 1, null, { timeout: 5000 });
    assert((await page.textContent('#suspCount')) === '(1)', 'count after lift');
    const left = (await asAdmin('/atlas/admin/suspensions')).body.suspended.map((s) => s.id);
    assert(JSON.stringify(left) === JSON.stringify([b]), 'server agrees: ' + left);

    console.log('STEP 5: hostile text is shown as text and creates no elements');
    fs.writeFileSync(wellKnown('atlas-suspensions.json'), JSON.stringify({ suspended: [{ id: '<img src=x onerror="window.__pwned=1">id', suspendedAt: '2026-01-01T00:00:00Z', reason: '<b id=evil>bold</b>', expiresAt: null }] }));
    await page.click('#suspRefreshBtn');
    await page.waitForFunction(() => /<img src=x/.test(document.getElementById('suspList').textContent), null, { timeout: 5000 });
    assert(await page.evaluate(() => !document.getElementById('evil') && !window.__pwned && !document.querySelector('#suspList img')), 'no injected element');
    fs.writeFileSync(wellKnown('atlas-suspensions.json'), JSON.stringify({ suspended: [] }));

    console.log('STEP 6: Site status lists the features, grouped, with states and the how-to');
    await page.waitForSelector('#siteStatusList .site-feature', { timeout: 5000 });
    const ledger = page.locator('#siteStatusList .site-feature[data-feature="ledger-issuance"]');
    assert(/ON/.test(await ledger.locator('.tag').first().textContent()), 'ledger shows ON');
    assert(/perClientPerMinute: 9/.test(await ledger.textContent()), 'fact shown');
    assert((await page.locator('#siteStatusList .site-group').count()) >= 1, 'groups');
    const email = page.locator('#siteStatusList .site-feature[data-feature="email-tickets"]');
    assert((await email.locator('button').count()) === 0, 'a feature that is not pausable has no button');

    console.log('STEP 7: pause needs a second click, can be cancelled, then switches the feature off');
    await ledger.locator('button').first().click();
    await page.waitForFunction(() => /Yes, switch it off/.test(document.querySelector('[data-feature="ledger-issuance"]').textContent), null, { timeout: 5000 });
    assert(JSON.parse(fs.readFileSync(ledgerCfg, 'utf8')).enabled === true, 'nothing changed after one click');
    await page.locator('[data-feature="ledger-issuance"] >> text=Cancel').click();
    await page.waitForFunction(() => /Pause \(switch off\)/.test(document.querySelector('[data-feature="ledger-issuance"]').textContent), null, { timeout: 5000 });
    await page.locator('[data-feature="ledger-issuance"] button').first().click();
    await page.locator('[data-feature="ledger-issuance"] >> text=Yes, switch it off').click();
    await page.waitForFunction(() => /is now off/.test(document.getElementById('siteStatusResult').textContent), null, { timeout: 5000 });
    const cfg = JSON.parse(fs.readFileSync(ledgerCfg, 'utf8'));
    assert(cfg.enabled === false && cfg.perClientPerMinute === 9 && cfg.domain === ledgerDomain, 'only enabled changed: ' + JSON.stringify(cfg));
    await page.waitForFunction(() => document.querySelectorAll('[data-feature="ledger-issuance"] button').length === 0, null, { timeout: 5000 });

    console.log('STEP 8: a moderator session sees neither section');
    const mod = await open(modToken);
    await mod.page.waitForSelector('#moderationPanel', { state: 'visible', timeout: 10000 });
    assert(!(await mod.page.isVisible('#siteStatusPanel')) && !(await mod.page.isVisible('#suspList')), 'hidden for a moderator');

    assert(errors.length === 0 && mod.errors.length === 0, 'page errors: ' + errors.concat(mod.errors).join('; '));
    console.log('\nALL ADMIN PANEL (SUSPENDED LIST + SITE STATUS) CHECKS PASSED (' + KIND + ')');
  } catch (e) {
    console.error('FAILURE:', e);
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
    await H.stopIssuer(issuer);
    process.exit(process.exitCode || 0);
  }
})();
