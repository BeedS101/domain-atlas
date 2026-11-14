// The identity rows in Wallet -> Identity: switching stays a visible button, the other actions sit behind each row's "more
// actions" menu (the same one the item cards use), Remove still asks for a second click, and "Import an identity" is below
// "Site identities". Throw-away identities in a scratch profile; nothing contacts a domain.
//
// Run: xvfb-run -a node test/manual-identity-row-menu-ui.js
// SHOTS=<dir> saves a screenshot of the open menu.
'use strict';
const L = require('./call-e2e-lib');
const { check } = L;

(async () => {
  const w = await L.launchWallet('identity-row-menu');
  try {
    await w.wallet((pw) => AtlasWallet.createIdentity(pw), 'identity-row-menu-password');
    const shopping = await w.wallet(() => AtlasWallet.createSubIdentity('Shopping'));
    await w.wallet(() => AtlasWallet.createSubIdentity('Travel'));

    const page = await w.context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('chrome-extension://' + w.extId + '/viewer.html');
    await page.waitForFunction(() => typeof routeWalletScreen === 'function' && typeof AtlasWallet !== 'undefined', null, { timeout: 15000 });
    await page.evaluate(() => routeWalletScreen());
    await page.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), null, { timeout: 10000 });
    await page.locator('#mainWalletScreen [data-category="identity"] .settings-category-toggle').click();
    await page.waitForSelector('#identityList .identity-row', { state: 'visible', timeout: 5000 });
    const row = (name) => page.locator('#identityList .identity-row', { hasText: name });
    const visible = (r, action) => r.locator('button[data-action="' + action + '"]').isVisible();
    const itemsOf = (r) => r.locator('.card-menu-items button').evaluateAll((bs) => bs.map((b) => b.dataset.action));
    const menuOpen = (r) => r.locator('.card-menu-items').evaluate((el) => el.classList.contains('show'));
    const names = () => page.$$eval('#identityList .identity-row-name', (els) => els.map((e) => e.textContent));
    const settle = () => page.waitForTimeout(500);

    console.log('--- what is visible and what is in the menu ---');
    check('the three identities are listed', (await names()).join() === 'Main identity,Shopping,Travel', await names());
    check('Main is active and its menu holds only Move everything', (await itemsOf(row('Main identity'))).join() === 'move-all', await itemsOf(row('Main identity')));
    check('Switch is a visible button on a row that is not active', (await visible(row('Shopping'), 'switch')) && (await visible(row('Travel'), 'switch')));
    check('the active row has no Switch button', (await row('Main identity').locator('button[data-action="switch"]').count()) === 0);
    check('Rename, Export and Remove are in the menu of an extra identity, not on the row', (await itemsOf(row('Shopping'))).join() === 'rename,export,remove' && !(await visible(row('Shopping'), 'rename')) && !(await visible(row('Shopping'), 'remove')));
    check('the menu is closed to begin with', !(await menuOpen(row('Shopping'))));
    check('the toggle is the same kind of button the item cards use', (await row('Shopping').locator('button.link-btn.card-menu-toggle').count()) === 1 && (await row('Shopping').locator('.card-menu-toggle').getAttribute('aria-label')) === 'More actions for Shopping');

    console.log('--- opening and closing the menu ---');
    await row('Shopping').locator('.card-menu-toggle').click();
    check('the toggle opens the menu and shows its actions', (await menuOpen(row('Shopping'))) && (await visible(row('Shopping'), 'rename')) && (await visible(row('Shopping'), 'export')) && (await visible(row('Shopping'), 'remove')));
    if (process.env.SHOTS) await page.screenshot({ path: require('path').join(process.env.SHOTS, 'identity-row-menu.png') });
    // An open menu covers the row below it, so another menu is opened from the row above.
    await row('Main identity').locator('.card-menu-toggle').click();
    check('opening another row\'s menu closes the first', !(await menuOpen(row('Shopping'))) && (await menuOpen(row('Main identity'))));
    await page.locator('#subIdentitiesIntro').click();
    check('a click elsewhere closes it', !(await menuOpen(row('Main identity'))));
    await row('Main identity').locator('.card-menu-toggle').click();
    await row('Main identity').locator('.card-menu-toggle').click();
    check('the toggle closes its own menu', !(await menuOpen(row('Main identity'))));

    console.log('--- switching ---');
    await row('Shopping').locator('button[data-action="switch"]').click();
    await settle();
    check('Switch still makes that identity active', (await page.$eval('#identityList .identity-row.active .identity-row-name', (e) => e.textContent)) === 'Shopping');
    check('the previously active row now offers Switch', await visible(row('Main identity'), 'switch'));
    check('the active extra identity keeps its menu, with Move everything added', (await itemsOf(row('Shopping'))).join() === 'move-all,rename,export,remove', await itemsOf(row('Shopping')));

    console.log('--- Remove still asks twice ---');
    await row('Travel').locator('.card-menu-toggle').click();
    await row('Travel').locator('button[data-action="remove"]').click();
    await settle();
    check('choosing Remove removes nothing yet', (await names()).includes('Travel'));
    check('Confirm remove and Cancel are shown on the row, outside the menu', (await row('Travel').locator('button[data-action="remove"]').textContent()) === 'Confirm remove' && (await visible(row('Travel'), 'remove-cancel')) && (await row('Travel').locator('.card-menu-items button[data-action="remove"]').count()) === 0);
    check('the message says what removing does', /Removing deletes this identity/.test(await page.locator('#subIdentityStatus').textContent()), await page.locator('#subIdentityStatus').textContent());
    await row('Travel').locator('button[data-action="remove-cancel"]').click();
    await settle();
    check('Cancel keeps the identity and puts Remove back in the menu', (await names()).includes('Travel') && (await itemsOf(row('Travel'))).join() === 'rename,export,remove' && (await row('Travel').locator('button[data-action="remove-cancel"]').count()) === 0);
    await row('Travel').locator('.card-menu-toggle').click();
    await row('Travel').locator('button[data-action="remove"]').click();
    await settle();
    await row('Travel').locator('.identity-row-actions button[data-action="remove"]').click();
    await settle();
    check('Confirm remove removes it', !(await names()).includes('Travel') && (await names()).length === 2, await names());

    console.log('--- rename still works from the menu ---');
    await row('Shopping').locator('.card-menu-toggle').click();
    await row('Shopping').locator('button[data-action="rename"]').click();
    await page.fill('#identityList input[data-role="rename-input"]', 'Weekend shopping');
    await page.locator('#identityList button[data-action="rename-save"]').click();
    await settle();
    check('renaming from the menu saves the new name', (await names()).includes('Weekend shopping'), await names());

    console.log('--- the order of the sections ---');
    const order = await page.evaluate(() => {
      const pos = (id) => { const el = document.getElementById(id); return el ? el.compareDocumentPosition(document.getElementById('siteIdentitiesPanel')) : 0; };
      const site = document.getElementById('siteIdentitiesPanel'), imp = document.getElementById('importSubIdentityPanel'), list = document.getElementById('identityList');
      return { listBeforeSite: !!(list.compareDocumentPosition(site) & Node.DOCUMENT_POSITION_FOLLOWING), siteBeforeImport: !!(site.compareDocumentPosition(imp) & Node.DOCUMENT_POSITION_FOLLOWING), sameParent: site.parentElement === imp.parentElement };
    });
    check('Import an identity comes after Site identities', order.siteBeforeImport && order.listBeforeSite && order.sameParent, order);
    check('and its controls are all still there', await page.evaluate(() => ['subImportFileInput', 'subImportPasswordInput', 'subImportCodeInput', 'subImportNameInput', 'subImportBtn', 'subImportStatus'].every((id) => !!document.getElementById(id))));
    check('no page errors in the wallet page', errors.length === 0, errors);
  } finally {
    await w.close();
  }
  process.exit(L.finish('manual-identity-row-menu-ui'));
})().catch((e) => { console.log('FATAL ' + (e && e.stack || e)); process.exit(1); });
