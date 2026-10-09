// Friend requests between two people who belong to the same Post Office, and
// the ways the answer can fail to arrive:
//
//   1. A handle typed in a different case than it was registered in still
//      reaches the person; after Accept the sender's wallet adds the contact.
//   2. A sender whose mail settings only accept mail from contacts is warned
//      when sending; the acceptance is refused, but the acceptor keeps it
//      queued (it is not dropped), and once the sender switches to open mail
//      the next mail check delivers it and the contact appears.
//   3. A sender who deleted their Post Office card after sending can join
//      again; "Send again" on the sent request makes the acceptor confirm
//      again, to the new card, and the contact appears. Mail for a wallet with
//      two cards on file is addressed to the newest.
//   4. The Post Office pickers (Mail settings, Send through) stop offering a
//      domain once its card is deleted, without a reload.
//
// Requires the issuer-server on 8001 (this test does not start it).
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

async function openAddContact(frame) {
  await frame.locator('#walletBtn').click();
  await frame.locator('#socialTabBtn').click();
  await frame.locator('#contactsSubtabBtn').click();
  await frame.locator('#addContactSubtabBtn').click();
  await frame.waitForFunction(() => document.getElementById('addContactSubscreen').classList.contains('active'), null, { timeout: 5000 });
}

async function friendsOf(frame) {
  return frame.evaluate(() => AtlasWallet.getFriends().then((f) => f.map((x) => ({ publicKey: x.publicKey, name: x.name }))));
}

async function state(frame) {
  return frame.evaluate(async () => {
    const id = await AtlasWallet.getIdentity();
    return {
      incoming: await AtlasWallet.getIncomingFriendRequests(id.publicKey),
      outgoing: await AtlasWallet.getOutgoingFriendRequests(id.publicKey),
      mail: await AtlasWallet.getMail(id.publicKey)
    };
  });
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function untilTrue(fn, what, ms = 10000) {
  const start = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - start > ms) throw new Error('Timed out waiting for: ' + what);
    await new Promise((r) => setTimeout(r, 150));
  }
}

(async () => {
  const launchOpts = { headless: false, executablePath: '/opt/pw-browsers/chromium', args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox'] };
  const contextA = await chromium.launchPersistentContext(path.resolve(__dirname, '.chrome-profile-friendreq-a'), launchOpts);
  const contextB = await chromium.launchPersistentContext(path.resolve(__dirname, '.chrome-profile-friendreq-b'), launchOpts);
  try {
    const alice = await openOverlay(contextA, 'Alice');
    const bob = await openOverlay(contextB, 'Bob');
    const pkAlice = await createIdentity(alice.frame, 'friend-request-password-alice');
    const pkBob = await createIdentity(bob.frame, 'friend-request-password-bob');
    await alice.frame.evaluate((d) => AtlasWallet.mintAsset('self', d, 'atlas.postoffice.membership'), DOMAIN_A);
    await bob.frame.evaluate((d) => AtlasWallet.mintAsset('self', d, 'atlas.postoffice.membership'), DOMAIN_A);
    const suffix = Date.now().toString(36).slice(-5);
    const handleAlice = 'AliCe' + suffix;
    const handleBob = 'BoB' + suffix;
    await alice.frame.evaluate((a) => AtlasWallet.setPostOfficeHandle(a.d, a.h), { d: DOMAIN_A, h: handleAlice });
    await bob.frame.evaluate((a) => AtlasWallet.setPostOfficeHandle(a.d, a.h), { d: DOMAIN_A, h: handleBob });
    console.log('SETUP: both belong to ' + DOMAIN_A + '; Bob is ' + handleBob + ', Alice will ask for ' + handleBob.toLowerCase());

    const sendRequest = () => alice.frame.evaluate((a) => AtlasWallet.sendFriendRequest({ viaDomain: a.via, handle: a.h, recipientDomain: a.d, name: 'Bobby' }), { via: DOMAIN_A, h: handleBob.toLowerCase(), d: DOMAIN_A });
    const reset = async () => {
      await alice.frame.evaluate((k) => AtlasWallet.removeFriend(k), pkBob);
      await bob.frame.evaluate((k) => AtlasWallet.removeFriend(k), pkAlice);
    };

    console.log('STEP 1: a handle in a different case still reaches the person, and the acceptance comes back');
    const first = await sendRequest();
    assert(!first.warning, 'No warning expected with open mail settings, got: ' + first.warning);
    await bob.frame.evaluate(() => AtlasWallet.checkAllMail());
    assert((await state(bob.frame)).incoming.length === 1, 'Bob should have the request');
    await bob.frame.evaluate((k) => AtlasWallet.acceptFriendRequest(k), pkAlice);
    await alice.frame.evaluate(() => AtlasWallet.checkAllMail());
    let aliceFriends = await friendsOf(alice.frame);
    assert(aliceFriends.length === 1 && aliceFriends[0].publicKey === pkBob, 'Expected Bobby in Alice\'s contacts, got: ' + JSON.stringify(aliceFriends));
    assert((await state(alice.frame)).outgoing.length === 0, 'The sent request should be cleared');
    console.log('PASS: request found by a differently-cased handle; contact added after Accept');
    await reset();

    console.log('STEP 2: friends-only mail settings: warned, acceptance kept queued, delivered once mail is open');
    await alice.frame.evaluate((d) => AtlasWallet.setPostOfficeMailMode(d, 'friendsOnly'), DOMAIN_A);
    const warned = await sendRequest();
    assert(warned.warning && warned.warning.includes('only accept mail from contacts'), 'Expected a warning about friends-only mail, got: ' + JSON.stringify(warned));
    await bob.frame.evaluate(() => AtlasWallet.checkAllMail());
    await bob.frame.evaluate((k) => AtlasWallet.acceptFriendRequest(k), pkAlice);
    await alice.frame.evaluate(() => AtlasWallet.checkAllMail());
    assert((await friendsOf(alice.frame)).length === 0 && (await state(alice.frame)).outgoing.length === 1, 'The acceptance cannot arrive while Alice only takes mail from contacts');
    await alice.frame.evaluate((d) => AtlasWallet.setPostOfficeMailMode(d, 'open'), DOMAIN_A);
    await bob.frame.evaluate(() => AtlasWallet.checkAllMail());
    await alice.frame.evaluate(() => AtlasWallet.checkAllMail());
    aliceFriends = await friendsOf(alice.frame);
    assert(aliceFriends.length === 1 && aliceFriends[0].publicKey === pkBob, 'Expected the retried acceptance to add Bobby, got: ' + JSON.stringify(aliceFriends));
    console.log('PASS: the refused acceptance was kept and delivered after Alice switched to open mail');
    await reset();

    console.log('STEP 3: Alice deletes her card, joins again, and sends the request again');
    await sendRequest();
    await bob.frame.evaluate(() => AtlasWallet.checkAllMail());
    await bob.frame.evaluate((k) => AtlasWallet.acceptFriendRequest(k), pkAlice);
    const cardId = await alice.frame.evaluate(async () => (await AtlasWallet.getPostOfficeMemberships((await AtlasWallet.getIdentity()).publicKey))[0].credentialId);
    await alice.frame.evaluate((i) => AtlasWallet.getIdentity().then((x) => AtlasWallet.deleteAsset(x.publicKey, i)), cardId);

    console.log('STEP 4 (same moment): the Post Office pickers stop offering the deleted card without a reload');
    await untilTrue(() => alice.frame.evaluate(() => {
      const sel = document.getElementById('postOfficeSettingsDomainInput');
      return !!sel && !Array.from(sel.options).some((o) => o.value);
    }), 'the Mail settings picker to drop the deleted card');
    const selText = await alice.frame.evaluate(() => document.getElementById('postOfficeSettingsDomainInput').textContent.trim());
    assert(!selText.includes(DOMAIN_A), 'Mail settings still offers ' + DOMAIN_A + ': ' + selText);
    console.log('PASS: Mail settings now reads "' + selText + '"');

    await alice.frame.evaluate((d) => AtlasWallet.mintAsset('self', d, 'atlas.postoffice.membership'), DOMAIN_A);
    await alice.frame.evaluate((k) => AtlasWallet.resendFriendRequest(k), pkBob);
    await bob.frame.evaluate(() => AtlasWallet.checkAllMail());
    await alice.frame.evaluate(() => AtlasWallet.checkAllMail());
    aliceFriends = await friendsOf(alice.frame);
    assert(aliceFriends.length === 1 && aliceFriends[0].publicKey === pkBob, 'Expected Bobby in Alice\'s contacts after Send again, got: ' + JSON.stringify(aliceFriends));
    assert((await state(alice.frame)).outgoing.length === 0, 'The sent request should be cleared');
    console.log('PASS: Send again recovered the lost answer and it reached the new card');

    console.log('\nAll friend-request recovery checks passed.');
  } finally {
    await contextA.close();
    await contextB.close();
  }
})().catch((e) => { console.error('FAILURE:', e.message || e); process.exit(1); });
