// Manual end-to-end check of the wallet keeping its Post Office tidy.
//
//   1. Handled friend notices are removed from the domain: an answered
//      request, a declined one, and the acceptance the sender picks up. A
//      request nobody has answered yet stays. A removal that failed is
//      completed by the next mail check.
//   2. Contacts follow the friends-only list at the Post Office without
//      toggling anything: a new contact can write, a removed one is refused.
//   3. Deleting a membership card gives the membership up: the handle is
//      released, the mailbox is emptied and the card no longer works. If the
//      domain cannot be reached the card is kept and the caller can choose
//      to delete it anyway.
//
// Requires the issuer-servers on 8001 and 8002 (this test does not start
// them). Set MAIL_DOMAIN=localhost:<port> to test another issuer, such as a
// PHP bundle, instead of the one on 8001; pages are always opened from 8001.
// Not part of the permanent suite, same as the other manual-*.js scripts.

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const DOMAIN = process.env.MAIL_DOMAIN || 'localhost:8001';
const BASE = 'http://' + DOMAIN;
const FRIEND_MARKER = '\u0000atlas.friend.v1';

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

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

// The mailbox as its owner reads it: the page signs a mail check with the
// wallet's key (SPEC.md §11.8), so a copy of the card is all the test keeps.
const knownCards = new Map();
async function messages(owner, cardId) {
  const credential = knownCards.get(cardId);
  const body = await owner.frame.evaluate((async ({ base, credential }) => {
        const payload = { action: 'mail-check', domain: new URL(base).host, credentialIds: [credential.id], issuedAt: new Date().toISOString(), nonce: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18)))).replace(/[+\/=]/g, 'x') };
        const proof = await AtlasWallet.signWithSelf(payload);
        const res = await fetch(base + '/atlas/mail/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credentials: [credential], payload, proof }) });
        return res.json();
      }), { base: BASE, credential });
  if (!body.messages) throw new Error('mail check refused: ' + JSON.stringify(body));
  return body.messages;
}
const friendNotices = async (owner, cardId) => (await messages(owner, cardId)).filter((m) => m.subject === FRIEND_MARKER).length;

async function waitUntil(fn, description, timeoutMs = 10000) {
  const start = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for ' + description);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const blockDeletes = (frame) => frame.evaluate(() => { window.__realFetch = window.fetch; window.fetch = (u, o) => (String(u).includes('/atlas/mail/delete') ? Promise.reject(new Error('offline')) : window.__realFetch(u, o)); });
const unblock = (frame) => frame.evaluate(() => { window.fetch = window.__realFetch; });

(async () => {
  const launchOpts = { headless: false, executablePath: '/opt/pw-browsers/chromium', args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox'] };
  const contextA = await chromium.launchPersistentContext(path.resolve(__dirname, '.chrome-profile-housekeeping-a'), launchOpts);
  const contextB = await chromium.launchPersistentContext(path.resolve(__dirname, '.chrome-profile-housekeeping-b'), launchOpts);

  try {
    const alice = await openOverlay(contextA, 'Alice');
    const bob = await openOverlay(contextB, 'Bob');
    const pkAlice = await createIdentity(alice.frame, 'housekeeping-password-alice');
    const pkBob = await createIdentity(bob.frame, 'housekeeping-password-bob');
    await alice.frame.evaluate((d) => AtlasWallet.mintAsset('self', d, 'atlas.postoffice.membership'), DOMAIN);
    await bob.frame.evaluate((d) => AtlasWallet.mintAsset('self', d, 'atlas.postoffice.membership'), DOMAIN);
    const suffix = Date.now().toString(36).slice(-5);
    const handleAlice = 'hkA' + suffix;
    const handleBob = 'hkB' + suffix;
    await alice.frame.evaluate((a) => AtlasWallet.setPostOfficeHandle(a.d, a.h), { d: DOMAIN, h: handleAlice });
    await bob.frame.evaluate((a) => AtlasWallet.setPostOfficeHandle(a.d, a.h), { d: DOMAIN, h: handleBob });
    const cardOf = async (frame, pk) => {
      const id = await frame.evaluate((k) => AtlasWallet.getPostOfficeMemberships(k).then((m) => m[m.length - 1].credentialId), pk);
      knownCards.set(id, await frame.evaluate((a) => AtlasWallet.getWallet(a.k).then((all) => all.find((e) => e.credential.id === a.id).credential), { k: pk, id }));
      return id;
    };
    let aliceCard = await cardOf(alice.frame, pkAlice);
    const bobCard = await cardOf(bob.frame, pkBob);
    const request = () => alice.frame.evaluate((a) => AtlasWallet.sendFriendRequest({ viaDomain: a.d, handle: a.h, recipientDomain: a.d, name: 'Bobby' }), { d: DOMAIN, h: handleBob });
    const clearContacts = async () => {
      await alice.frame.evaluate((k) => AtlasWallet.removeFriend(k), pkBob);
      await bob.frame.evaluate((k) => AtlasWallet.removeFriend(k), pkAlice);
    };

    console.log('STEP 1: handled friend notices leave the domain');
    await request();
    assert((await friendNotices(bob, bobCard)) === 1, 'The request should be on the domain');
    await bob.frame.evaluate(() => AtlasWallet.checkAllMail());
    assert((await friendNotices(bob, bobCard)) === 1, 'A request nobody has answered yet must stay');
    await bob.frame.evaluate((k) => AtlasWallet.acceptFriendRequest(k), pkAlice);
    await waitUntil(async () => (await friendNotices(bob, bobCard)) === 0, 'the answered request to leave the domain');
    assert((await friendNotices(alice, aliceCard)) === 1, 'The acceptance should be waiting for Alice');
    await alice.frame.evaluate(() => AtlasWallet.checkAllMail());
    await waitUntil(async () => (await friendNotices(alice, aliceCard)) === 0, 'the picked-up acceptance to leave the domain');
    console.log('PASS: the unanswered request stayed, then both notices left the domain once handled');

    await clearContacts();
    await request();
    await bob.frame.evaluate(() => AtlasWallet.checkAllMail());
    await bob.frame.evaluate((k) => AtlasWallet.declineFriendRequest(k), pkAlice);
    await waitUntil(async () => (await friendNotices(bob, bobCard)) === 0, 'the declined request to leave the domain');
    console.log('PASS: a declined request left the domain');

    await alice.frame.evaluate((k) => AtlasWallet.cancelOutgoingFriendRequest(k), pkBob);
    await request();
    await bob.frame.evaluate(() => AtlasWallet.checkAllMail());
    await blockDeletes(bob.frame);
    await bob.frame.evaluate((k) => AtlasWallet.acceptFriendRequest(k), pkAlice);
    await new Promise((r) => setTimeout(r, 800));
    assert((await friendNotices(bob, bobCard)) === 1, 'With removal failing the request stays on the domain');
    await unblock(bob.frame);
    await bob.frame.evaluate(() => AtlasWallet.checkAllMail());
    await waitUntil(async () => (await friendNotices(bob, bobCard)) === 0, 'the next check to remove it');
    console.log('PASS: a removal that failed was completed by the next mail check');
    await alice.frame.evaluate(() => AtlasWallet.checkAllMail());
    await clearContacts();

    console.log('STEP 2: contacts follow the friends-only list without toggling');
    await alice.frame.evaluate((d) => AtlasWallet.setPostOfficeMailMode(d, 'friendsOnly'), DOMAIN);
    const trySend = (subject) => bob.frame.evaluate((a) => AtlasWallet.sendUserMail(a.d, a.k, a.s, 'body').then(() => 'sent', (e) => e.message), { d: DOMAIN, k: pkAlice, s: subject });
    assert(/not accepting mail/.test(await trySend('before')), 'A stranger must be refused while Alice only takes mail from contacts');
    await alice.frame.evaluate((k) => AtlasWallet.addFriend(k, 'Bobby'), pkBob);
    await waitUntil(async () => (await trySend('after add')) === 'sent', 'the new contact to be let through');
    console.log('PASS: a new contact could write without any toggling');
    await alice.frame.evaluate((k) => AtlasWallet.removeFriend(k), pkBob);
    await waitUntil(async () => /not accepting mail/.test(await trySend('after remove')), 'the removed contact to be refused again');
    console.log('PASS: a removed contact was refused again');
    await alice.frame.evaluate((d) => AtlasWallet.setPostOfficeMailMode(d, 'open'), DOMAIN);

    console.log('STEP 3: deleting a membership card gives the membership up');
    await bob.frame.evaluate((a) => AtlasWallet.sendUserMail(a.d, a.k, 'left behind', 'body'), { d: DOMAIN, k: pkAlice });
    assert((await messages(alice, aliceCard)).length > 0, 'There should be mail waiting for Alice');
    const resolves = async (h) => (await fetch(BASE + '/atlas/postoffice/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle: h }) })).ok;
    assert(await resolves(handleAlice), 'Alice\'s handle should resolve before she leaves');
    await alice.frame.evaluate((a) => AtlasWallet.deleteAsset(a.pk, a.id), { pk: pkAlice, id: aliceCard });
    assert((await messages(alice, aliceCard)).length === 0, 'Her mailbox should be empty');
    assert(!(await resolves(handleAlice)), 'Her handle should no longer resolve');
    const toGone = await bob.frame.evaluate((a) => AtlasWallet.sendUserMail(a.d, a.k, 'nobody home', 'body').then(() => 'sent', (e) => e.message), { d: DOMAIN, k: pkAlice });
    assert(toGone !== 'sent', 'Mail to a card that was given up must be refused');
    await bob.frame.evaluate((a) => AtlasWallet.setPostOfficeHandle(a.d, a.h), { d: DOMAIN, h: handleAlice });
    assert(await resolves(handleAlice), 'Someone else should be able to take the released handle');
    await bob.frame.evaluate((a) => AtlasWallet.setPostOfficeHandle(a.d, a.h), { d: DOMAIN, h: handleBob });
    console.log('PASS: mailbox emptied, handle released and reusable, mail to the card refused');

    console.log('STEP 3b: an unreachable domain keeps the card unless told otherwise');
    await alice.frame.evaluate((d) => AtlasWallet.mintAsset('self', d, 'atlas.postoffice.membership'), DOMAIN);
    aliceCard = await cardOf(alice.frame, pkAlice);
    await alice.frame.evaluate((a) => AtlasWallet.setPostOfficeHandle(a.d, a.h), { d: DOMAIN, h: handleAlice });
    await alice.frame.evaluate(() => { window.__realFetch = window.fetch; window.fetch = (u, o) => (String(u).includes('/atlas/postoffice/leave') ? Promise.reject(new Error('offline')) : window.__realFetch(u, o)); });
    const code = await alice.frame.evaluate((a) => AtlasWallet.deleteAsset(a.pk, a.id).then(() => 'deleted', (e) => e.code || e.message), { pk: pkAlice, id: aliceCard });
    assert(code === 'leave-unreachable', 'Expected leave-unreachable, got: ' + code);
    const stillHeld = await alice.frame.evaluate((pk) => AtlasWallet.getPostOfficeMemberships(pk).then((m) => m.length), pkAlice);
    assert(stillHeld === 1, 'The card should still be in the wallet');
    await alice.frame.evaluate((a) => AtlasWallet.deleteAsset(a.pk, a.id, { keepOnServer: true }), { pk: pkAlice, id: aliceCard });
    assert((await alice.frame.evaluate((pk) => AtlasWallet.getPostOfficeMemberships(pk).then((m) => m.length), pkAlice)) === 0, 'Deleting anyway should remove the card');
    assert(await resolves(handleAlice), 'Deleting anyway leaves the handle reserved');
    await alice.frame.evaluate(() => { window.fetch = window.__realFetch; });
    console.log('PASS: unreachable domain kept the card; deleting anyway removed only the local copy');

    console.log('\nAll housekeeping checks passed.');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await contextA.close();
    await contextB.close();
    for (const d of ['a', 'b']) {
      try { fs.rmSync(path.resolve(__dirname, '.chrome-profile-housekeeping-' + d), { recursive: true, force: true }); } catch (err) { /* ignore */ }
    }
  }
})();
