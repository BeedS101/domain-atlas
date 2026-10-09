// Manual end-to-end check: picking a contact in Compose addresses the mail
// by handle.
//
//   1. A contact with a known address fills the recipient with handle#domain,
//      in handle mode (the raw-key field stays hidden), and the mail reaches
//      them. For a contact at a Post Office the sender has not joined, the
//      mail is relayed through the sender's own.
//   2. A contact at a Post Office the sender has joined sets that domain as
//      the one sent through.
//   3. A contact without an address falls back to the raw-key field.
//   4. A typed handle#domain at a Post Office the sender has not joined is
//      relayed rather than refused; with no Post Office chosen it asks for one.
//
// Requires the issuer-servers on 8001 and 8002 (this test does not start them).
// Not part of the permanent suite, same as the other manual-*.js scripts.

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const DOMAIN_A = 'localhost:8001';
const DOMAIN_B = 'localhost:8002';

async function openOverlay(context, label) {
  const page = await context.newPage();
  await page.goto('http://localhost:8001', { waitUntil: 'load' });
  await page.locator('#domain-atlas-enter-btn').click();
  const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
  const frame = await frameHandle.contentFrame();
  await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), null, { timeout: 10000 });
  console.log('SETUP: ' + label + ' opened the overlay at Example Plaza');
  return { page, frame };
}

async function createIdentity(frame, password) {
  await frame.locator('#walletBtn').click();
  await frame.locator('#chooseNewBtn').click();
  await frame.locator('#newPasswordInput').fill(password);
  await frame.locator('#newPasswordConfirmInput').fill(password);
  await frame.locator('#confirmCreateBtn').click();
  await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), null, { timeout: 5000 });
  await frame.locator('#seedConfirmCheck').check();
  await frame.locator('#seedConfirmBtn').click();
  await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), null, { timeout: 5000 });
  const publicKey = await frame.evaluate(() => AtlasWallet.getIdentity().then((i) => i.publicKey));
  await frame.locator('#walletBtn').click();
  return publicKey;
}

async function openCompose(frame) {
  await frame.locator('#walletBtn').click();
  await frame.locator('#socialTabBtn').click();
  await frame.locator('#mailSubtabBtn').click();
  await frame.locator('#mailBoxComposeSubtabBtn').click();
  await frame.waitForFunction(() => document.getElementById('mailBoxComposeSubscreen').classList.contains('active'), null, { timeout: 5000 });
  // The picker is filled when Compose opens; wait for it to list contacts.
  await frame.waitForFunction(() => document.getElementById('composeFriendPickerInput').options.length > 1, null, { timeout: 5000 });
}

async function closeWallet(frame) {
  await frame.locator('#walletBtn').click();
}

async function pick(frame, name) {
  await frame.locator('#composeFriendPickerInput').selectOption({ label: name });
}

async function send(frame, subject) {
  await frame.locator('#postOfficeSubjectInput').fill(subject);
  await frame.locator('#postOfficeBodyInput').fill('body of ' + subject);
  await frame.locator('#postOfficeSendBtn').click();
  await frame.waitForFunction(() => {
    const t = document.getElementById('postOfficeSendStatus').textContent;
    return t === 'Sent.' || /fail|haven|Choose|Add the domain|No one|no one/i.test(t);
  }, null, { timeout: 15000 });
  return frame.locator('#postOfficeSendStatus').textContent();
}

async function received(frame, subject) {
  for (let i = 0; i < 20; i++) {
    const found = await frame.evaluate(async (s) => {
      await AtlasWallet.checkAllMail();
      const id = await AtlasWallet.getIdentity();
      const mail = await AtlasWallet.getMail(id.publicKey);
      return mail.some((m) => m.message.subject === s || (m.message.subject || '').includes(s));
    }, subject);
    if (found) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

(async () => {
  const launchOpts = { headless: false, executablePath: '/opt/pw-browsers/chromium', args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox'] };
  const contextA = await chromium.launchPersistentContext(path.resolve(__dirname, '.chrome-profile-composehandle-a'), launchOpts);
  const contextB = await chromium.launchPersistentContext(path.resolve(__dirname, '.chrome-profile-composehandle-b'), launchOpts);
  const contextC = await chromium.launchPersistentContext(path.resolve(__dirname, '.chrome-profile-composehandle-c'), launchOpts);

  try {
    const alice = await openOverlay(contextA, 'Alice');
    const bob = await openOverlay(contextB, 'Bob');
    const carol = await openOverlay(contextC, 'Carol');
    const pkAlice = await createIdentity(alice.frame, 'compose-handle-password-alice');
    const pkBob = await createIdentity(bob.frame, 'compose-handle-password-bob');
    const pkCarol = await createIdentity(carol.frame, 'compose-handle-password-carol');
    const suffix = Date.now().toString(36).slice(-5);
    const handleBob = 'Bob' + suffix;
    const handleCarol = 'carol' + suffix;
    await alice.frame.evaluate((d) => AtlasWallet.mintAsset('self', d, 'atlas.postoffice.membership'), DOMAIN_A);
    await bob.frame.evaluate((d) => AtlasWallet.mintAsset('self', d, 'atlas.postoffice.membership'), DOMAIN_B);
    await carol.frame.evaluate((d) => AtlasWallet.mintAsset('self', d, 'atlas.postoffice.membership'), DOMAIN_A);
    await bob.frame.evaluate((a) => AtlasWallet.setPostOfficeHandle(a.d, a.h), { d: DOMAIN_B, h: handleBob });
    await carol.frame.evaluate((a) => AtlasWallet.setPostOfficeHandle(a.d, a.h), { d: DOMAIN_A, h: handleCarol });
    console.log('SETUP: Alice belongs only to ' + DOMAIN_A + '; Bob (' + handleBob + ') only to ' + DOMAIN_B + '; Carol (' + handleCarol + ') to ' + DOMAIN_A);

    // Dave is a contact with no known address.
    const dave = await alice.frame.evaluate(async () => {
      const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
      return btoa(String.fromCharCode(...raw)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    });
    await alice.frame.evaluate((a) => AtlasWallet.addFriend(a.k, 'Bobby', { handle: a.h, domain: a.d }), { k: pkBob, h: handleBob, d: DOMAIN_B });
    await alice.frame.evaluate((a) => AtlasWallet.addFriend(a.k, 'Caz', { handle: a.h, domain: a.d }), { k: pkCarol, h: handleCarol, d: DOMAIN_A });
    await alice.frame.evaluate((k) => AtlasWallet.addFriend(k, 'Dave'), dave);

    console.log('STEP 1: picking Bobby (address at a Post Office Alice has not joined) fills handle#domain and the mail is relayed');
    await openCompose(alice.frame);
    await pick(alice.frame, 'Bobby');
    assert(await alice.frame.locator('#postOfficeToPublicKeyInput').isHidden(), 'The raw-key field should stay hidden');
    assert(await alice.frame.locator('#postOfficeToHandleInput').isVisible(), 'The handle field should be showing');
    assert((await alice.frame.locator('#postOfficeToHandleInput').inputValue()) === handleBob + '#' + DOMAIN_B, 'Expected the contact\'s address in the handle field');
    assert((await alice.frame.locator('#postOfficeToDomainInput').inputValue()) === DOMAIN_A, 'Alice has only her own Post Office to send through');
    assert((await send(alice.frame, 'To Bobby ' + suffix)) === 'Sent.', 'Expected the relayed send to succeed');
    assert(await received(bob.frame, 'To Bobby ' + suffix), 'Bob should receive the relayed mail');
    const sent = await alice.frame.evaluate(() => AtlasWallet.getIdentity().then((i) => AtlasWallet.getSentMail(i.publicKey)));
    assert(sent[0].to.recipientDomain === DOMAIN_B && sent[0].to.handle === handleBob, 'Sent record should show the relay, got: ' + JSON.stringify(sent[0].to));
    console.log('PASS: handle#domain filled in handle mode; relayed to ' + DOMAIN_B + ' and received');

    console.log('STEP 2: picking Caz (address at Alice\'s own Post Office) sends through it');
    await pick(alice.frame, 'Caz');
    assert((await alice.frame.locator('#postOfficeToHandleInput').inputValue()) === handleCarol + '#' + DOMAIN_A, 'Expected Caz\'s address');
    assert((await alice.frame.locator('#postOfficeToDomainInput').inputValue()) === DOMAIN_A, 'The Post Office should be set to the contact\'s');
    assert((await send(alice.frame, 'To Caz ' + suffix)) === 'Sent.', 'Expected the send to succeed');
    assert(await received(carol.frame, 'To Caz ' + suffix), 'Carol should receive the mail');
    console.log('PASS: address filled, sent through the shared Post Office, received');

    console.log('STEP 3: picking Dave (no address) falls back to the raw-key field');
    await pick(alice.frame, 'Dave');
    assert(await alice.frame.locator('#postOfficeToPublicKeyInput').isVisible(), 'The raw-key field should show');
    assert(await alice.frame.locator('#postOfficeToHandleInput').isHidden(), 'The handle field should be hidden');
    assert((await alice.frame.locator('#postOfficeToPublicKeyInput').inputValue()) === dave, 'Expected Dave\'s key');
    console.log('PASS: contact without an address uses the raw key');

    console.log('STEP 4: switching back to a contact with an address returns to handle mode');
    await pick(alice.frame, 'Bobby');
    assert(await alice.frame.locator('#postOfficeToPublicKeyInput').isHidden() && (await alice.frame.locator('#postOfficeToPublicKeyInput').inputValue()) === '', 'The raw-key field should be hidden and empty');
    assert((await alice.frame.locator('#postOfficeToHandleInput').inputValue()) === handleBob + '#' + DOMAIN_B, 'Expected Bobby\'s address again');
    console.log('PASS: back in handle mode');

    console.log('STEP 5: a typed address at an unjoined Post Office is relayed; with no Post Office chosen it asks for one');
    await alice.frame.locator('#composeFriendPickerInput').selectOption('');
    await alice.frame.locator('#postOfficeToHandleInput').fill(handleBob.toLowerCase() + '#' + DOMAIN_B);
    assert((await send(alice.frame, 'Typed ' + suffix)) === 'Sent.', 'Expected the typed address to be relayed');
    assert(await received(bob.frame, 'Typed ' + suffix), 'Bob should receive the typed-address mail');
    await alice.frame.locator('#postOfficeToDomainInput').selectOption('');
    await alice.frame.locator('#postOfficeToHandleInput').fill(handleBob + '#' + DOMAIN_B);
    const noRelay = await send(alice.frame, 'Nowhere ' + suffix);
    assert(/Choose a Post Office/.test(noRelay), 'Expected a request to choose a Post Office, got: ' + noRelay);
    console.log('PASS: typed address relayed; missing Post Office reported');

    console.log('\nAll compose-contact checks passed.');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await contextA.close();
    await contextB.close();
    await contextC.close();
    for (const d of ['a', 'b', 'c']) {
      try { fs.rmSync(path.resolve(__dirname, '.chrome-profile-composehandle-' + d), { recursive: true, force: true }); } catch (err) { /* ignore */ }
    }
  }
})();
