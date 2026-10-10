// Contact permissions, safety-code verification and how verified and unverified contacts are
// shown, through the calling window's own buttons.
// Needs the local demo domain on 8002 (see manual-call-e2e.js).
// Run: xvfb-run -a node test/manual-call-contacts.js
'use strict';
const L = require('./call-e2e-lib');
const { check, sleep, until } = L;

(async () => {
  const svc = await L.startCallService(null, { limits: { invitesPerCallerPerMin: 100, invitesPerCalleePerMin: 100, invitesPerSourcePerMin: 200 } });
  const { alice, bob } = await L.makePair(svc, { grant: false });
  try {
    const pa = await alice.openCallWindow();
    const pb = await bob.openCallWindow();
    const row = (p, name) => p.locator('#contacts .contact', { hasText: name });
    const sync = async (w) => { await w.wallet(() => AtlasWallet.checkAllMail()); await w.callPage.evaluate(() => window.__atlasCall.refresh()); };

    check('before any permission neither contact shows as callable', /No call permission from them/.test(await row(pa, 'Bob').innerText()) && await row(pa, 'Bob').locator('button', { hasText: 'Call' }).first().isDisabled());
    check('both contacts start as not verified', /Not verified/.test(await row(pa, 'Bob').innerText()) && /Not verified/.test(await row(pb, 'Alice').innerText()));

    await row(pb, 'Alice').locator('button', { hasText: 'Allow calls' }).click();
    await until(async () => /They can call you/.test(await row(pb, 'Alice').innerText()), 15000, 200);
    check('Allow calls shows that the contact can now call', /They can call you/.test(await row(pb, 'Alice').innerText()) && !!(await row(pb, 'Alice').locator('button', { hasText: 'Stop allowing' }).count()));
    await until(async () => { await sync(alice); return /You can call/.test(await row(pa, 'Bob').innerText()); }, 20000, 500);
    check('the card arrives and Alice can call Bob', /You can call/.test(await row(pa, 'Bob').innerText()) && !(await row(pa, 'Bob').locator('button', { hasText: 'Call' }).first().isDisabled()));
    check('Alice did not get permission to be called by Bob from that', /They cannot call you/.test(await row(pa, 'Bob').innerText()));

    // ---- safety codes ----
    await row(pa, 'Bob').locator('button', { hasText: 'Verify' }).click();
    await row(pb, 'Alice').locator('button', { hasText: 'Verify' }).click();
    const codeA = (await pa.locator('#safetyCode').innerText()).trim(), codeB = (await pb.locator('#safetyCode').innerText()).trim();
    check('both contacts see the same six-group safety code', /^\d{5}( \d{5}){5}$/.test(codeA) && codeA === codeB, { codeA, codeB });
    const expected = await alice.wallet(([a, b]) => AtlasCallProtocol.safetyCode(a, b), [alice.pub, bob.pub]);
    check('the code is derived from the two identity keys', codeA === expected);
    await pa.click('#btnSafetyMatch');
    await until(async () => /Verified contact/.test(await row(pa, 'Bob').innerText()), 8000, 150);
    check('after "The codes match" Alice shows Bob as a verified contact', /Verified contact/.test(await row(pa, 'Bob').innerText()));
    check('Bob\'s view of Alice is still not verified', /Not verified/.test(await row(pb, 'Alice').innerText()));
    await pb.click('#btnSafetyClose');
    check('closing the panel without a match verifies nothing', /Not verified/.test(await row(pb, 'Alice').innerText()));

    // ---- how the call screens name the contact ----
    await bob.available();
    await row(pa, 'Bob').locator('button', { hasText: 'Call' }).first().click();
    await pa.waitForSelector('#btnStart:not([hidden])');
    const ready = await pa.locator('#screenCall').innerText();
    check('before the call starts the screen says the call goes to the saved key and is verified', /Verified contact/.test(ready) && /The call will go to the key saved for Bob/.test(ready) && !/proved/.test(ready), ready);
    await pa.click('#btnStart');
    await pb.waitForSelector('#btnAnswer:not([hidden])', { timeout: 15000 });
    const incoming = await pb.locator('#screenCall').innerText();
    check('the incoming screen shows the unverified contact as not verified and does not claim proof', /Not verified/.test(incoming) && !/Verified contact/.test(incoming) && /signed by the key saved for Alice/.test(incoming) && /does not prove who holds that key/.test(incoming), incoming);
    await pb.click('#btnAnswer');
    await until(async () => (await alice.callState()) === 'active' && (await bob.callState()) === 'active', 30000, 250);
    const activeA = await pa.locator('#screenCall').innerText(), activeB = await pb.locator('#screenCall').innerText();
    check('an active call to a verified contact says so, and states what was proven', /Verified contact/.test(activeA) && /you compared safety codes/i.test(activeA) && /matched the identity-signed fingerprint/.test(activeA), activeA);
    check('an active call to an unverified contact says the name alone proves nothing', /Not verified/.test(activeB) && /does not prove who holds that key/.test(activeB), activeB);
    await pa.click('#btnHangup');
    await until(async () => (await bob.callState()) === 'ended', 10000, 150);
    await pa.click('#btnDismiss').catch(() => {}); await pb.click('#btnDismiss').catch(() => {});

    // ---- revoking ----
    await row(pb, 'Alice').locator('button', { hasText: 'Stop allowing' }).click();
    await until(async () => /They cannot call you/.test(await row(pb, 'Alice').innerText()), 15000, 200);
    check('Stop allowing shows the contact can no longer call', /They cannot call you/.test(await row(pb, 'Alice').innerText()) && !!(await row(pb, 'Alice').locator('button', { hasText: 'Allow calls' }).count()));
    await pa.locator('#contacts .contact', { hasText: 'Bob' }).locator('button', { hasText: 'Call' }).first().click().catch(() => {});
    await pa.click('#btnStart').catch(() => {});
    const refused = await until(async () => { const t = await alice.teardown(); return t && t.reason === 'unavailable' && t; }, 15000, 200);
    check('a call after the permission was withdrawn is refused as not available', !!refused, refused);
    check('and Bob\'s window did not ring', (await bob.callState()) === 'none');

    // ---- availability ----
    await pa.click('#btnDismiss').catch(() => {});
    check('Do Not Disturb is the default and Available is shown when chosen', /Do not disturb/.test(await pa.locator('#availPill').innerText()) && /Available/.test(await pb.locator('#availPill').innerText()));
    await bob.dnd();
    await until(async () => /Do not disturb/.test(await pb.locator('#availPill').innerText()), 5000, 100);
    check('choosing Do not disturb stops listening and updates the pill', /Do not disturb/.test(await pb.locator('#availPill').innerText()) && !(await bob.snap()).listening);
    check('no uncaught page errors', alice.errors.length === 0 && bob.errors.length === 0, { a: alice.errors, b: bob.errors });
  } catch (e) {
    check('test run completed', false, String(e && e.stack || e));
  } finally {
    await alice.close(); await bob.close(); await svc.close();
  }
  process.exit(L.finish('manual-call-contacts'));
})();
