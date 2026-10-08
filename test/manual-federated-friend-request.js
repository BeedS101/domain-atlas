// Manual end-to-end check: a friend request sent by handle crosses Post
// Offices. Alice belongs only to the Post Office at localhost:8001, Bob only
// to the one at localhost:8002, and neither has joined the other's. The request
// travels as Post Office mail (SPEC.md §11.3-11.4), so it needs no server
// support beyond the existing relay.
//
// Requires the issuer-servers on 8001 and 8002 (this test does not start them).
//
// Checks:
//   1. From the Add Contact tab Alice sends a request to bob#localhost:8002
//      through her own Post Office. Bob is NOT added to her contacts yet; the
//      request shows under "Requests you've sent".
//   2. Bob's mail check delivers it as a friend request (named
//      alice#localhost:8001, with her note shown as plain text), counted in
//      the Contacts badge. It does NOT appear in his Mail inbox.
//   3. Bob accepts: Alice is in his contacts. Alice's next mail check adds Bob
//      under the name she chose and clears her sent-requests list.
//   4. Decline sends nothing: Alice's request stays pending and Bob is not
//      added, however many times she checks.
//   5. Mutual requests: with Alice's request still pending, Bob sends her one;
//      both end up with each other as contacts, with no one clicking Accept.
//   6. An 'accepted' notice nobody asked for is ignored: Alice sends a request,
//      cancels it, Bob accepts anyway, and Bob is not added to Alice's contacts.
//   7. A recipient who blocks the sender refuses the request with the usual
//      "not accepting mail" error, and no pending request is recorded.
//   8. Requesting someone who is already a contact is refused.
//
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

(async () => {
  const launchOpts = { headless: false, executablePath: '/opt/pw-browsers/chromium', args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox'] };
  const contextA = await chromium.launchPersistentContext(path.resolve(__dirname, '.chrome-profile-friendreq-a'), launchOpts);
  const contextB = await chromium.launchPersistentContext(path.resolve(__dirname, '.chrome-profile-friendreq-b'), launchOpts);

  try {
    const alice = await openOverlay(contextA, 'Alice');
    const bob = await openOverlay(contextB, 'Bob');

    console.log('SETUP: Alice is a member only at ' + DOMAIN_A + ' (handle alice-fr), Bob only at ' + DOMAIN_B + ' (handle bob-fr)');
    const pkAlice = await createIdentity(alice.frame, 'friend-request-password-alice');
    const pkBob = await createIdentity(bob.frame, 'friend-request-password-bob');
    await alice.frame.evaluate((d) => AtlasWallet.mintAsset('self', d, 'atlas.postoffice.membership'), DOMAIN_A);
    await bob.frame.evaluate((d) => AtlasWallet.mintAsset('self', d, 'atlas.postoffice.membership'), DOMAIN_B);
    // Handles are unique per domain and survive between runs, so use a suffix
    // that is free of earlier runs' handles.
    const suffix = Date.now().toString(36).slice(-5);
    const handleAlice = 'alice' + suffix;
    const handleBob = 'bob' + suffix;
    await alice.frame.evaluate((a) => AtlasWallet.setPostOfficeHandle(a.d, a.h), { d: DOMAIN_A, h: handleAlice });
    await bob.frame.evaluate((a) => AtlasWallet.setPostOfficeHandle(a.d, a.h), { d: DOMAIN_B, h: handleBob });

    console.log('STEP 1: Alice sends bob#' + DOMAIN_B + ' a friend request from the Add Contact tab');
    await openAddContact(alice.frame);
    const viaOptions = await alice.frame.locator('#friendReqViaSelect option').allTextContents();
    assert(viaOptions.length === 1 && viaOptions[0] === DOMAIN_A, 'Expected "Send through" to list only Alice\'s own Post Office, got: ' + JSON.stringify(viaOptions));
    await alice.frame.locator('#friendReqNameInput').fill('Bobby');
    await alice.frame.locator('#friendReqHandleInput').fill(handleBob + '#' + DOMAIN_B);
    await alice.frame.locator('#friendReqNoteInput').fill('<b>hi</b> it is Alice');
    await alice.frame.locator('#friendReqSendBtn').click();
    await alice.frame.waitForFunction(() => document.getElementById('friendReqStatus').textContent.startsWith('Request sent'), null, { timeout: 10000 });
    assert((await friendsOf(alice.frame)).length === 0, 'Bob must not be in Alice\'s contacts before he accepts');
    await alice.frame.waitForFunction(() => document.getElementById('sentFriendRequestsList').textContent.includes('Bobby'), null, { timeout: 5000 });
    console.log('PASS: request sent across Post Offices; Alice has no contact yet and sees it under Requests you\'ve sent');

    console.log('STEP 2: Bob receives it as a friend request (not mail), with the note shown as text');
    await bob.frame.evaluate(() => AtlasWallet.checkAllMail());
    await openAddContact(bob.frame);
    await bob.frame.waitForFunction(() => document.getElementById('federatedFriendRequestsList').children.length === 1, null, { timeout: 10000 });
    const cardText = await bob.frame.locator('#federatedFriendRequestsList').textContent();
    assert(cardText.includes(handleAlice + '#' + DOMAIN_A), 'Expected the request to name ' + handleAlice + '#' + DOMAIN_A + ', got: ' + cardText);
    assert(cardText.includes('<b>hi</b> it is Alice'), 'Expected the note to be shown as plain text, got: ' + cardText);
    assert((await bob.frame.locator('#federatedFriendRequestsList b').count()) === 0, 'The note was rendered as HTML');
    const badge = await bob.frame.locator('#addContactBadge').textContent();
    assert(badge === '1', 'Expected the Add Contact badge to read 1, got: ' + badge);
    const bobState = await state(bob.frame);
    assert(bobState.mail.every((e) => !String(e.message.subject).includes('atlas.friend')), 'The friend request must not appear in the Mail inbox, found: ' + JSON.stringify(bobState.mail.map((e) => e.message.subject)));
    console.log('INFO: Bob\'s inbox holds: ' + JSON.stringify(bobState.mail.map((e) => e.message.subject)));
    assert((await friendsOf(bob.frame)).length === 0, 'Alice must not be in Bob\'s contacts before he accepts');
    console.log('PASS: Bob sees ' + handleAlice + '#' + DOMAIN_A + ' with the note as text, badge 1, nothing in his inbox');

    console.log('STEP 3: Bob accepts; Alice\'s next check adds Bob under the name she chose');
    await bob.frame.locator('[data-action="accept-federated-request"]').click();
    await bob.frame.waitForFunction(() => document.getElementById('federatedFriendRequestsList').children.length === 0, null, { timeout: 10000 });
    const bobFriends = await friendsOf(bob.frame);
    assert(bobFriends.length === 1 && bobFriends[0].publicKey === pkAlice, 'Expected Alice in Bob\'s contacts, got: ' + JSON.stringify(bobFriends));
    await alice.frame.evaluate(() => AtlasWallet.checkAllMail());
    const aliceFriends = await friendsOf(alice.frame);
    assert(aliceFriends.length === 1 && aliceFriends[0].publicKey === pkBob && aliceFriends[0].name === 'Bobby', 'Expected Bobby in Alice\'s contacts, got: ' + JSON.stringify(aliceFriends));
    assert((await state(alice.frame)).outgoing.length === 0, 'Alice\'s sent request should be cleared once accepted');
    console.log('PASS: both have each other as contacts; Alice\'s pending list is empty');

    // Back to a clean slate for the next scenarios.
    await alice.frame.evaluate((k) => AtlasWallet.removeFriend(k), pkBob);
    await bob.frame.evaluate((k) => AtlasWallet.removeFriend(k), pkAlice);

    console.log('STEP 4: a declined request is silent — Alice\'s stays pending and Bob is never added');
    await alice.frame.evaluate((a) => AtlasWallet.sendFriendRequest({ viaDomain: a.via, handle: a.h, recipientDomain: a.d, name: 'Bobby' }), { via: DOMAIN_A, h: handleBob, d: DOMAIN_B });
    await bob.frame.evaluate(() => AtlasWallet.checkAllMail());
    await bob.frame.evaluate((k) => AtlasWallet.declineFriendRequest(k), pkAlice);
    await alice.frame.evaluate(() => AtlasWallet.checkAllMail());
    await alice.frame.evaluate(() => AtlasWallet.checkAllMail());
    assert((await friendsOf(alice.frame)).length === 0, 'Alice must not gain a contact from a decline');
    assert((await state(alice.frame)).outgoing.length === 1, 'Alice\'s request should still be pending after a decline');
    assert((await state(bob.frame)).incoming.length === 0, 'The declined request should be gone from Bob\'s list');
    // Re-checking must not resurrect a processed request.
    await bob.frame.evaluate(() => AtlasWallet.checkAllMail());
    assert((await state(bob.frame)).incoming.length === 0, 'A declined request came back on the next mail check');
    console.log('PASS: decline sent nothing back, and the request did not reappear');

    console.log('STEP 5: crossing requests — Bob asks Alice while hers is pending; both become contacts with no Accept click');
    await bob.frame.evaluate((a) => AtlasWallet.sendFriendRequest({ viaDomain: a.via, handle: a.h, recipientDomain: a.d, name: 'Ally' }), { via: DOMAIN_B, h: handleAlice, d: DOMAIN_A });
    await alice.frame.evaluate(() => AtlasWallet.checkAllMail());
    await bob.frame.evaluate(() => AtlasWallet.checkAllMail());
    const aliceF5 = await friendsOf(alice.frame);
    const bobF5 = await friendsOf(bob.frame);
    assert(aliceF5.length === 1 && aliceF5[0].publicKey === pkBob && aliceF5[0].name === 'Bobby', 'Alice should have Bobby, got: ' + JSON.stringify(aliceF5));
    assert(bobF5.length === 1 && bobF5[0].publicKey === pkAlice && bobF5[0].name === 'Ally', 'Bob should have Ally, got: ' + JSON.stringify(bobF5));
    assert((await state(alice.frame)).outgoing.length === 0 && (await state(bob.frame)).outgoing.length === 0, 'No request should be left pending');
    console.log('PASS: crossing requests made them contacts automatically');
    await alice.frame.evaluate((k) => AtlasWallet.removeFriend(k), pkBob);
    await bob.frame.evaluate((k) => AtlasWallet.removeFriend(k), pkAlice);

    console.log('STEP 6: an acceptance nobody asked for is ignored');
    await alice.frame.evaluate((a) => AtlasWallet.sendFriendRequest({ viaDomain: a.via, handle: a.h, recipientDomain: a.d, name: 'Bobby' }), { via: DOMAIN_A, h: handleBob, d: DOMAIN_B });
    await alice.frame.evaluate((k) => AtlasWallet.cancelOutgoingFriendRequest(k), pkBob);
    await bob.frame.evaluate(() => AtlasWallet.checkAllMail());
    await bob.frame.evaluate((k) => AtlasWallet.acceptFriendRequest(k), pkAlice);
    await alice.frame.evaluate(() => AtlasWallet.checkAllMail());
    assert((await friendsOf(alice.frame)).length === 0, 'Alice cancelled the request, so Bob\'s acceptance must not add him');
    assert((await friendsOf(bob.frame)).length === 1, 'Bob accepted, so he does have Alice');
    console.log('PASS: Alice cancelled; Bob\'s late acceptance did not put him in her contacts');
    await bob.frame.evaluate((k) => AtlasWallet.removeFriend(k), pkAlice);

    console.log('STEP 7: a recipient who blocks the sender refuses the request');
    await bob.frame.evaluate((a) => AtlasWallet.blockPostOfficeSender(a.d, a.k), { d: DOMAIN_B, k: pkAlice });
    let blockedMessage = '';
    try {
      await alice.frame.evaluate((a) => AtlasWallet.sendFriendRequest({ viaDomain: a.via, handle: a.h, recipientDomain: a.d, name: 'Bobby' }), { via: DOMAIN_A, h: handleBob, d: DOMAIN_B });
    } catch (err) {
      blockedMessage = err.message;
    }
    assert(/not accepting mail from you/.test(blockedMessage), 'Expected the usual "not accepting mail" refusal, got: ' + blockedMessage);
    assert((await state(alice.frame)).outgoing.length === 0, 'A refused request must not be recorded as pending');
    await bob.frame.evaluate((a) => AtlasWallet.unblockPostOfficeSender(a.d, a.k), { d: DOMAIN_B, k: pkAlice });
    console.log('PASS: refused with the same wording as blocked mail, nothing left pending');

    console.log('STEP 8: asking someone who is already a contact is refused');
    await alice.frame.evaluate((k) => AtlasWallet.addFriend(k, 'Bobby'), pkBob);
    let dupMessage = '';
    try {
      await alice.frame.evaluate((a) => AtlasWallet.sendFriendRequest({ viaDomain: a.via, handle: a.h, recipientDomain: a.d, name: 'Bobby' }), { via: DOMAIN_A, h: handleBob, d: DOMAIN_B });
    } catch (err) {
      dupMessage = err.message;
    }
    assert(/already in your contacts/.test(dupMessage), 'Expected an "already in your contacts" error, got: ' + dupMessage);
    console.log('PASS: duplicate request refused');

    console.log('\nAll friend-request checks passed.');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await contextA.close();
    await contextB.close();
    for (const d of ['.chrome-profile-friendreq-a', '.chrome-profile-friendreq-b']) {
      try { fs.rmSync(path.resolve(__dirname, d), { recursive: true, force: true }); } catch (err) { /* ignore */ }
    }
  }
})();
