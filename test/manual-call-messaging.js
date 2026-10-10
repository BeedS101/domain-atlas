// The Messages window's Calls tab leads to the calling window; nobody needs a developer page.
// Needs the local demo domain on 8002 (see manual-call-e2e.js).
// Run: xvfb-run -a node test/manual-call-messaging.js
'use strict';
const L = require('./call-e2e-lib');
const { check, sleep, until } = L;

(async () => {
  const svc = await L.startCallService();
  const { alice, bob } = await L.makePair(svc);
  try {
    const viewer = await alice.context.newPage();
    viewer.on('pageerror', (e) => alice.errors.push('viewer: ' + e.message));
    await viewer.goto('chrome-extension://' + alice.extId + '/viewer.html', { waitUntil: 'load' });
    await viewer.waitForSelector('#messagingBtn', { state: 'visible', timeout: 15000 });
    await viewer.click('#messagingBtn');
    await viewer.waitForSelector('#messagingWidget:not([hidden])', { timeout: 10000 });
    await viewer.locator('.messaging-tab[data-messaging-tab="calls"]').click();
    await until(async () => /Calling window is closed/.test(await viewer.locator('#messagingCallsBody').innerText()), 8000, 150);
    const closedText = await viewer.locator('#messagingCallsBody').innerText();
    check('the Calls tab says the calling window is closed and that nobody can call until it is open and Available', /Calling window is closed/.test(closedText) && /Available/.test(closedText), closedText);
    check('and offers a button to open it', (await viewer.locator('[data-action="calls-open-window"]').count()) === 1);

    await viewer.locator('.messaging-tab[data-messaging-tab="contacts"]').click();
    await viewer.locator('#messagingContactsList .messaging-list-item', { hasText: 'Bob' }).locator('button', { hasText: 'Call' }).click();
    await viewer.waitForFunction(() => document.querySelector('.messaging-tab[data-messaging-tab="calls"]').classList.contains('active-subtab'), null, { timeout: 5000 });
    await until(async () => /permission to call this contact/.test(await viewer.locator('#messagingCallsBody').innerText()), 8000, 150);
    const bobText = await viewer.locator('#messagingCallsBody').innerText();
    check('Call on a contact opens the Calls tab for that contact with their permission state', /Bob/.test(bobText) && /not verified/.test(bobText) && /You have permission to call this contact/.test(bobText), bobText);

    const popup = alice.context.waitForEvent('page', { timeout: 15000 });
    await viewer.locator('[data-action="calls-dial"]').click();
    const callPage = await popup;
    await callPage.waitForFunction(() => window.__atlasCall && window.__atlasCall.snapshot, null, { timeout: 15000 });
    alice.callPage = callPage;
    callPage.on('pageerror', (e) => alice.errors.push(e.message));
    check('the button opens the calling window', /\/call\.html/.test(callPage.url()));
    await callPage.waitForSelector('#btnStart:not([hidden])', { timeout: 10000 });
    check('the calling window shows Bob ready to call and has asked for no microphone', /Bob/.test(await callPage.locator('#callWho').innerText()) && (await alice.trace()).length === 0);

    // A second request focuses the existing window instead of opening another.
    let extra = false;
    alice.context.on('page', (p) => { if (/call\.html/.test(p.url())) extra = true; });
    await viewer.locator('.messaging-tab[data-messaging-tab="calls"]').click();
    await until(async () => /Show calling window/.test(await viewer.locator('#messagingCallsBody').innerText()), 15000, 300);
    check('once open, the Calls tab shows the window as open', /Calling window is open/.test(await viewer.locator('#messagingCallsBody').innerText()));
    await viewer.locator('[data-action="calls-open-window"]').click();
    await sleep(1500);
    check('asking again shows the existing window and opens no second one', !extra);

    // A call can be placed and answered from here without any other page.
    const pb = await bob.openCallWindow();
    await bob.available();
    await callPage.click('#btnStart');
    await pb.waitForSelector('#btnAnswer:not([hidden])', { timeout: 15000 });
    await pb.click('#btnAnswer');
    check('the call placed from the Messages route connects', !!(await until(async () => (await alice.callState()) === 'active' && (await bob.callState()) === 'active', 30000, 250)));
    await viewer.locator('.messaging-tab[data-messaging-tab="calls"]').click();
    await until(async () => /call in progress/.test(await viewer.locator('#messagingCallsBody').innerText()), 15000, 300);
    check('while a call is connected the Calls tab says a call is in progress', /call in progress/.test(await viewer.locator('#messagingCallsBody').innerText()));

    // The side panel's idle auto-lock must not lock the wallet under a connected call.
    await viewer.evaluate(async () => { await AtlasWallet.setAutoLockMinutes(1); lastActivityTime = 0; });
    await sleep(19000);
    check('the idle auto-lock does not lock the wallet while a call is connected', (await alice.callState()) === 'active' && !!(await alice.wallet(() => AtlasWallet.getIdentity())));
    await callPage.click('#btnHangup');
    await until(async () => !(await alice.wallet(() => AtlasWallet.getIdentity())), 40000, 500);
    check('once the call is over the idle auto-lock locks the wallet as before', !(await alice.wallet(() => AtlasWallet.getIdentity())));
    check('no uncaught page errors', alice.errors.length === 0 && bob.errors.length === 0, { a: alice.errors, b: bob.errors });
  } catch (e) {
    check('test run completed', false, String(e && e.stack || e));
  } finally {
    await alice.close(); await bob.close(); await svc.close();
  }
  process.exit(L.finish('manual-call-messaging'));
})();
