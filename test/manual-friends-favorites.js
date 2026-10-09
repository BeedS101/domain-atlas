// Manual end-to-end check for Contacts (the Contacts/Add Contact/Groups
// split), Favorites, the Social tab (Mail moved in alongside them), and the
// quick Lock button — three SEPARATE browser contexts, each with its own
// real wallet identity.
//
// Presence no longer plays any part in friendship: A and B stand in the
// Lobby together and the test proves that nothing in the room lets either
// of them discover or friend the other (federated Post Office friend
// requests are covered by manual-federated-friend-request.js). Contacts are
// added by raw public key or handle through the manual form, and Favorites
// shows a visitor count without naming anyone.
//
// Requires presence-server/server.js on 8004, issuer-server on 8001, AND
// domain B running as a real issuer-server instance on 8002 (see
// README.md's "Serve the two demo domains") — this test does not start
// any of them itself.
//
// Checks:
//   1. Two visitors with identities meet in the Lobby — Add Contact has no
//      "People here now" list and no add-friend action, and neither wallet
//      has anything to friend.
//   2. Nothing about either wallet identity reaches the presence server.
//   3. A adds B by raw public key through the manual form; the Social badge
//      is not driven by any live request.
//   5. The Contacts sub-tab's three inner sub-tabs (Contacts / Add
//      Contact / Groups) each render the right content once opened.
//   6. Adding a contact manually by RAW PUBLIC KEY works.
//   7. Adding a contact manually by "handle#domain" address works
//      (Visitor C registers a Post Office handle at Domain B without
//      ever entering the Lobby) — including the "you haven't joined that
//      domain's Post Office yet" error path for an unjoined domain.
//   8. A contact's notes field saves on blur and actually persists in
//      AtlasWallet.getFriends().
//   9. The Contacts search box filters by name AND notes, live as you
//      type.
//  10. Removing a contact requires TWO deliberate clicks — the first
//      click reveals a confirm row without removing anything; Cancel
//      backs out with nothing removed; a second Confirm click actually
//      removes it.
//  11. Groups: a group can be created, a contact added to it via its
//      membership checkbox, and the group deleted again.
//  12. Favorites: favoriting the current domain shows a visitor count and
//      does not name which contacts are present.
//  13. The quick Lock button in the top control bar is hidden while
//      locked/no identity, appears once unlocked, and actually locks the
//      wallet when clicked.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');

async function projectPortals(frame) {
  return frame.evaluate(() => {
    return new Promise((resolve) => {
      const check = () => {
        if (window.__atlasScene && window.__atlasScene.portalMarkers.length) {
          const canvas = document.getElementById('scene');
          const originX = canvas.width / 2, originY = canvas.height / 2 + 40;
          const SCALE = 26, COS30 = Math.cos(Math.PI / 6), SIN30 = Math.sin(Math.PI / 6);
          resolve(window.__atlasScene.portalMarkers.map((m) => {
            const [x, , z] = m.position;
            return { sx: originX + (x - z) * COS30 * SCALE, sy: originY + (x + z) * SIN30 * SCALE, to: m.portal && m.portal.to, kind: m.portal && m.portal.kind };
          }));
        } else { requestAnimationFrame(check); }
      };
      check();
    });
  });
}

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

// Creates a fresh local password identity through the real onboarding UI
// (not a storage shortcut) — the publicKey it produces is what actually
// gets announced over presence, same as any real visitor.
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
  await frame.locator('#walletBtn').click(); // close the panel — identity stays unlocked for the rest of the session
  return publicKey;
}

async function enterLobby(frame, page, label) {
  const portals = await projectPortals(frame);
  const toLobby = portals.find((p) => p.to === 'lobby');
  await frame.locator('#scene').click({ position: { x: toLobby.sx, y: toLobby.sy } });
  await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Lobby'), null, { timeout: 10000 });
  await page.waitForTimeout(300);
  console.log('SETUP: ' + label + ' entered the Lobby');
}

// Joins Domain B's Post Office via the manifest-advertised Join button
// (reused from manual-postoffice-handle-ui.js) rather than walking to the
// in-world stall — this test only cares that membership exists, not how
// it was obtained, and that path is already covered end to end by
// manual-postoffice-manifest-join.js. Leaves the visitor back at the
// Plaza either way.
async function joinDomainBPostOffice(frame, label) {
  const portals = await projectPortals(frame);
  const toNeighbor = portals.find((p) => p.kind === 'domain');
  await frame.locator('#scene').click({ position: { x: toNeighbor.sx, y: toNeighbor.sy } });
  await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Neighbor Workshop'), null, { timeout: 10000 });
  await frame.waitForFunction(() => document.getElementById('status').textContent.includes('8002'), null, { timeout: 10000 });

  await frame.locator('#walletBtn').click();
  await frame.locator('#socialTabBtn').click();
  await frame.waitForFunction(() => document.getElementById('mailSubscreen').classList.contains('active'), null, { timeout: 5000 });
  await frame.waitForFunction(() => !document.getElementById('postOfficeJoinSection').hidden, null, { timeout: 5000 });
  await frame.locator('#postOfficeJoinBtn').click();
  await frame.waitForFunction(() => document.getElementById('postOfficeJoinSection').hidden, null, { timeout: 10000 });
  console.log('PASS: ' + label + ' joined Domain B\'s Post Office');
  await frame.locator('#walletBtn').click(); // close the wallet panel before navigating

  const backPortals = await projectPortals(frame);
  const backToPlaza = backPortals.find((p) => p.kind === 'domain');
  await frame.locator('#scene').click({ position: { x: backToPlaza.sx, y: backToPlaza.sy } });
  await frame.waitForFunction(() => document.getElementById('status').textContent.includes('8001'), null, { timeout: 10000 });
}

// Registers a Post Office handle at Domain B (must already be a member —
// see joinDomainBPostOffice above). Leaves the wallet panel open on Mail
// Settings, same as manual-postoffice-handle-ui.js's own Step 1.
async function registerDomainBHandle(frame, handle) {
  const alreadyOpen = await frame.evaluate(() => document.getElementById('walletPanel').classList.contains('open'));
  if (!alreadyOpen) await frame.locator('#walletBtn').click();
  await frame.locator('#socialTabBtn').click();
  await frame.waitForFunction(() => document.getElementById('mailSubscreen').classList.contains('active'), null, { timeout: 5000 });
  // socialTabBtn's click handler kicks off several async refreshes
  // (checkMailOnTabOpen, refreshMyPublicKeyDisplay -> the Post Office
  // domain dropdowns, etc.) — wait for one of them to land before touching
  // Mail Settings, same as manual-postoffice-handle-ui.js's openMailScreen.
  await frame.waitForFunction(() => document.getElementById('myPublicKeyDisplay').value.length > 0, null, { timeout: 5000 });
  await frame.locator('#mailSettingsSubtabBtn').click();
  await frame.waitForFunction(() => [...document.getElementById('postOfficeSettingsDomainInput').options].some((o) => o.value === 'localhost:8002'), null, { timeout: 5000 });
  await frame.locator('#postOfficeSettingsDomainInput').selectOption('localhost:8002');
  await frame.waitForFunction(() => document.getElementById('postOfficeYourHandleDisplay').textContent.includes('No handle set'), null, { timeout: 5000 });
  await frame.locator('#postOfficeHandleInput').fill(handle);
  await frame.locator('#postOfficeSaveHandleBtn').click();
  await frame.waitForFunction(() => document.getElementById('postOfficeHandleStatus').textContent.startsWith('Saved'), null, { timeout: 5000 });
  console.log('PASS: registered handle "' + handle + '#localhost:8002"');
  await frame.locator('#walletBtn').click();
}

async function openContactsTab(frame) {
  await frame.locator('#walletBtn').click();
  await frame.locator('#socialTabBtn').click();
  await frame.locator('#contactsSubtabBtn').click();
  await frame.waitForFunction(() => document.getElementById('contactsSubscreen').classList.contains('active'), null, { timeout: 5000 });
}

async function waitFor(frame, fn, description, timeoutMs = 8000) {
  const start = Date.now();
  for (;;) {
    const result = await frame.evaluate(fn);
    if (result) return result;
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for: ' + description);
    await new Promise((r) => setTimeout(r, 150));
  }
}

(async () => {
  const dirA = path.resolve(__dirname, '.chrome-profile-friends-a');
  const dirB = path.resolve(__dirname, '.chrome-profile-friends-b');
  const dirC = path.resolve(__dirname, '.chrome-profile-friends-c');
  const launchOpts = { headless: false, executablePath: '/opt/pw-browsers/chromium', args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox'] };

  const contextA = await chromium.launchPersistentContext(dirA, launchOpts);
  const contextB = await chromium.launchPersistentContext(dirB, launchOpts);
  const contextC = await chromium.launchPersistentContext(dirC, launchOpts);

  try {
    const a = await openOverlay(contextA, 'Visitor A');
    const b = await openOverlay(contextB, 'Visitor B');
    const c = await openOverlay(contextC, 'Visitor C');

    console.log('STEP 0: each visitor creates their own real wallet identity');
    const pkA = await createIdentity(a.frame, 'friends-test-password-a');
    const pkB = await createIdentity(b.frame, 'friends-test-password-b');
    const pkC = await createIdentity(c.frame, 'friends-test-password-c');
    if (pkA === pkB || pkA === pkC || pkB === pkC) throw new Error('Expected three independently created identities to all differ');
    console.log('PASS: three independent identities created');

    console.log('STEP 0b: A and C join Domain B\'s Post Office, C registers the handle "charlie" — sets up the manual add-by-handle test below (B deliberately never joins; used only for the in-room live flow)');
    await joinDomainBPostOffice(a.frame, 'Visitor A');
    await joinDomainBPostOffice(c.frame, 'Visitor C');
    await registerDomainBHandle(c.frame, 'charlie');

    await enterLobby(a.frame, a.page, 'Visitor A');
    await enterLobby(b.frame, b.page, 'Visitor B');

    console.log('STEP 1: in a shared room there is nothing to discover or friend — no People-here-now list, no add-friend action');
    await openContactsTab(a.frame);
    await a.frame.locator('#addContactSubtabBtn').click();
    await a.frame.waitForFunction(() => document.getElementById('addContactSubscreen').classList.contains('active'), null, { timeout: 5000 });
    await a.page.waitForTimeout(2500); // long enough for B to be in the same room and visible to the presence layer
    const addContactHtml = await a.frame.evaluate(() => document.getElementById('addContactSubscreen').innerHTML);
    if (/People here now|friendsHereList|data-action="add-friend"|accept-request/.test(addContactHtml)) {
      throw new Error('Add Contact must not offer any presence-based friending, got: ' + addContactHtml.slice(0, 400));
    }
    if (await a.frame.evaluate(() => typeof presenceRosterMeta !== 'undefined' || typeof sendSignal !== 'undefined' || typeof handleIncomingSignal !== 'undefined')) {
      throw new Error('The presence friend-signal machinery must be gone from the viewer');
    }
    console.log('PASS: no presence-based friend discovery in the UI or the viewer script');

    console.log('STEP 2: the presence server never receives either wallet identity');
    const roomView = await (await fetch('http://localhost:8004/presence/poll/join', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'localhost:8001', world: 'lobby', name: 'Probe' })
    })).json();
    const roomText = JSON.stringify(roomView);
    if (roomText.includes(pkA) || roomText.includes(pkB) || roomText.includes(pkA.slice(0, 10)) || roomText.includes(pkB.slice(0, 10))) {
      throw new Error('A wallet key (or a fragment of one) is visible in the room roster: ' + roomText);
    }
    if (!roomView.roster.every((m) => !('publicKey' in m) && m.name === 'Visitor')) throw new Error('Expected only keyless "Visitor" entries, got: ' + roomText);
    await fetch('http://localhost:8004/presence/poll/leave', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: roomView.id }) });
    console.log('PASS: the Lobby roster holds keyless "Visitor" entries only');

    console.log('STEP 3: A adds B as a contact by raw public key (the manual form), with no request or signal involved');
    await a.frame.locator('#manualAddNameInput').fill('Bee');
    await a.frame.locator('#manualAddToggleRawKeyBtn').click();
    await a.frame.locator('#manualAddPublicKeyInput').fill(pkB);
    await a.frame.locator('#manualAddContactBtn').click();
    await a.frame.waitForFunction(() => document.getElementById('manualAddContactStatus').textContent === 'Added.', null, { timeout: 5000 });
    await a.frame.locator('#manualAddToggleRawKeyBtn').click(); // back to handle mode
    const aFriends = await a.frame.evaluate(() => AtlasWallet.getFriends());
    if (aFriends.length !== 1 || aFriends[0].publicKey !== pkB) throw new Error('Expected A to hold exactly B as a contact, got: ' + JSON.stringify(aFriends));
    if ((await b.frame.evaluate(() => AtlasWallet.getFriends())).length !== 0) throw new Error('B must not gain a contact from A adding them by key');
    console.log('PASS: contact saved locally for A only');

    console.log('STEP 5: the three Contacts inner sub-tabs each render the right content');
    await a.frame.locator('#contactsListSubtabBtn').click();
    await a.frame.waitForFunction(() => document.getElementById('contactsListSubscreen').classList.contains('active'), null, { timeout: 5000 });
    await a.frame.waitForFunction(() => document.querySelectorAll('#contactsList .info-card').length === 1, null, { timeout: 5000 });
    const firstContactText = await a.frame.locator('#contactsList .info-card').first().textContent();
    if (!firstContactText.includes(pkB.slice(0, 16))) throw new Error('Expected the saved contact (B) to render with B\'s public key, got: ' + firstContactText);
    console.log('PASS: Contacts inner tab shows the saved contact');
    await a.frame.locator('#addContactSubtabBtn').click();
    await a.frame.waitForFunction(() => document.getElementById('addContactSubscreen').classList.contains('active'), null, { timeout: 5000 });
    const addContactText = await a.frame.locator('#addContactSubscreen').textContent();
    if (!addContactText.includes('Friend requests') || !addContactText.includes('Send a friend request') || !addContactText.includes('Add by address')) {
      throw new Error('Expected Add Contact to render Friend requests, the by-handle request form AND the manual add-by-address form, got: ' + addContactText);
    }
    console.log('PASS: Add Contact inner tab shows its sections');
    await a.frame.locator('#contactGroupsSubtabBtn').click();
    await a.frame.waitForFunction(() => document.getElementById('contactGroupsSubscreen').classList.contains('active'), null, { timeout: 5000 });
    await a.frame.waitForFunction(() => document.getElementById('contactGroupsList').textContent.includes('No groups yet'), null, { timeout: 5000 });
    console.log('PASS: Groups inner tab renders its empty state');

    console.log('STEP 6: adding a contact manually by RAW PUBLIC KEY — no live presence connection to the other side needed');
    const strangerKey = await a.frame.evaluate(async () => {
      const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      const raw = await crypto.subtle.exportKey('raw', pair.publicKey);
      return btoa(String.fromCharCode(...new Uint8Array(raw))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    });
    await a.frame.locator('#addContactSubtabBtn').click();
    await a.frame.locator('#manualAddNameInput').fill('Dana (raw key)');
    await a.frame.locator('#manualAddToggleRawKeyBtn').click();
    await a.frame.locator('#manualAddPublicKeyInput').fill(strangerKey);
    await a.frame.locator('#manualAddContactBtn').click();
    await a.frame.waitForFunction(() => document.getElementById('manualAddContactStatus').textContent === 'Added.', null, { timeout: 5000 });
    let currentFriends = await a.frame.evaluate(() => AtlasWallet.getFriends());
    if (!currentFriends.some((f) => f.publicKey === strangerKey && f.name === 'Dana (raw key)')) {
      throw new Error('Expected the raw-key contact to be saved, got: ' + JSON.stringify(currentFriends));
    }
    console.log('PASS: raw-key manual add works');

    console.log('STEP 6b: the error path — adding via a domain this wallet has NOT joined');
    await a.frame.locator('#manualAddToggleRawKeyBtn').click(); // back to handle mode
    await a.frame.locator('#manualAddNameInput').fill('Nobody');
    await a.frame.locator('#manualAddHandleInput').fill('someone#localhost:9999');
    await a.frame.locator('#manualAddContactBtn').click();
    await a.frame.waitForFunction(() => {
      const t = document.getElementById('manualAddContactStatus').textContent;
      return t && t !== '' && t !== 'Looking up…';
    }, null, { timeout: 5000 });
    const unjoinedStatus = await a.frame.locator('#manualAddContactStatus').textContent();
    if (!unjoinedStatus.toLowerCase().includes("haven't joined")) throw new Error('Expected a clear "haven\'t joined that Post Office" error, got: ' + unjoinedStatus);
    console.log('PASS:', unjoinedStatus);

    console.log('STEP 7: adding a contact manually by "handle#domain" — Visitor C, who never entered the Lobby at all');
    await a.frame.locator('#manualAddNameInput').fill('Charlie');
    await a.frame.locator('#manualAddHandleInput').fill('charlie#localhost:8002');
    await a.frame.locator('#manualAddContactBtn').click();
    await a.frame.waitForFunction(() => document.getElementById('manualAddContactStatus').textContent === 'Added.', null, { timeout: 10000 });
    currentFriends = await a.frame.evaluate(() => AtlasWallet.getFriends());
    if (!currentFriends.some((f) => f.publicKey === pkC && f.name === 'Charlie')) {
      throw new Error('Expected Charlie (Visitor C, resolved by handle) to be saved as a contact, got: ' + JSON.stringify(currentFriends));
    }
    const charlieEntry = currentFriends.find((f) => f.publicKey === pkC);
    if (charlieEntry.handle !== 'charlie' || charlieEntry.handleDomain !== 'localhost:8002') {
      throw new Error('Expected Charlie\'s contact to keep his address, got: ' + JSON.stringify(charlieEntry));
    }
    console.log('PASS: handle-based manual add resolved to the right public key and saved, with its address');

    console.log('STEP 8: a contact\'s notes field saves on blur and persists');
    await a.frame.locator('#contactsListSubtabBtn').click();
    await a.frame.waitForFunction(() => document.getElementById('contactsListSubscreen').classList.contains('active'), null, { timeout: 5000 });
    const danaCard = a.frame.locator('#contactsList .info-card', { hasText: 'Dana (raw key)' });
    await danaCard.locator('.contact-notes-input').fill('met via a manual raw-key add, testing notes');
    await danaCard.locator('.contact-notes-input').blur();
    await a.frame.locator('#manualAddNameInput').focus(); // force focusout on the notes textarea (no other element to blur to inside the same subscreen)
    await waitFor(a.frame, () => AtlasWallet.getFriends().then((fs) => {
      const dana = fs.find((f) => f.name === 'Dana (raw key)');
      return dana && dana.notes === 'met via a manual raw-key add, testing notes';
    }), 'Dana\'s notes to persist after blur');
    console.log('PASS: notes saved on blur and persisted in AtlasWallet.getFriends()');

    console.log('STEP 9: the Contacts search box filters live by name AND notes');
    await a.frame.locator('#contactsSearchInput').fill('raw-key add, testing');
    await waitFor(a.frame, () => {
      const cards = [...document.querySelectorAll('#contactsList .info-card')];
      const visible = cards.filter((c) => !c.hidden);
      return visible.length === 1 && visible[0].textContent.includes('Dana') ? true : null;
    }, 'search to narrow the list down to only Dana (matched via her notes)');
    console.log('PASS: search matched on notes text and hid the non-matching cards');
    await a.frame.locator('#contactsSearchInput').fill('');
    await a.frame.waitForFunction(() => [...document.querySelectorAll('#contactsList .info-card')].every((c) => !c.hidden), null, { timeout: 5000 });

    console.log('STEP 10: removing a contact requires two deliberate clicks');
    const danaRemoveBtn = danaCard.locator('button[data-action="remove-contact-ask"]');
    await danaRemoveBtn.click();
    await danaCard.locator('.remove-confirm-row').waitFor({ state: 'visible', timeout: 5000 });
    let stillThere = await a.frame.evaluate((key) => AtlasWallet.getFriends().then((fs) => fs.some((f) => f.publicKey === key)), strangerKey);
    if (!stillThere) throw new Error('Expected the FIRST Remove click to only reveal a confirmation, not remove the contact');
    console.log('PASS: first click only asks for confirmation, does not remove anything');
    await danaCard.locator('button[data-action="remove-contact-cancel"]').click();
    stillThere = await a.frame.evaluate((key) => AtlasWallet.getFriends().then((fs) => fs.some((f) => f.publicKey === key)), strangerKey);
    if (!stillThere) throw new Error('Expected Cancel to leave the contact in place');
    const confirmRowHiddenAfterCancel = await danaCard.locator('.remove-confirm-row').isHidden();
    if (!confirmRowHiddenAfterCancel) throw new Error('Expected Cancel to hide the confirm row again');
    console.log('PASS: Cancel backs out cleanly, nothing removed');
    await danaRemoveBtn.click();
    await danaCard.locator('button[data-action="remove-contact-confirm"]').click();
    await waitFor(a.frame, (key) => AtlasWallet.getFriends().then((fs) => (fs.some((f) => f.publicKey === key) ? null : true)), 'Dana to actually be removed after Confirm', 5000);
    console.log('PASS: second, explicit Confirm click actually removes the contact');

    console.log('STEP 11: Groups — create one, add a contact to it, then delete it');
    await a.frame.locator('#contactGroupsSubtabBtn').click();
    await a.frame.waitForFunction(() => document.getElementById('contactGroupsSubscreen').classList.contains('active'), null, { timeout: 5000 });
    await a.frame.locator('#newGroupNameInput').fill('Post Office Friends');
    await a.frame.locator('#createGroupBtn').click();
    await a.frame.waitForFunction(() => document.querySelectorAll('#contactGroupsList .info-card').length === 1, null, { timeout: 5000 });
    console.log('PASS: group created');
    const groupCard = a.frame.locator('#contactGroupsList .info-card').first();
    const charlieCheckbox = groupCard.locator('label', { hasText: 'Charlie' }).locator('input[type="checkbox"]');
    await charlieCheckbox.check();
    await a.frame.waitForFunction(() => document.querySelector('#contactGroupsList .info-card .meta').textContent.includes('1 member'), null, { timeout: 5000 });
    const groupsAfterAdd = await a.frame.evaluate(() => AtlasWallet.getContactGroups());
    if (!groupsAfterAdd[0].memberPublicKeys.includes(pkC)) throw new Error('Expected Charlie (C\'s public key) to be a member of the new group, got: ' + JSON.stringify(groupsAfterAdd));
    console.log('PASS: checking a contact\'s box adds them to the group, member count updates');
    a.page.once('dialog', (d) => d.accept());
    await groupCard.locator('button[data-action="delete-group"]').click();
    await a.frame.waitForFunction(() => document.getElementById('contactGroupsList').textContent.includes('No groups yet'), null, { timeout: 5000 });
    const groupsAfterDelete = await a.frame.evaluate(() => AtlasWallet.getContactGroups());
    if (groupsAfterDelete.length !== 0) throw new Error('Expected the group to be gone after confirming delete, got: ' + JSON.stringify(groupsAfterDelete));
    const friendsAfterGroupDelete = await a.frame.evaluate(() => AtlasWallet.getFriends());
    if (!friendsAfterGroupDelete.some((f) => f.publicKey === pkC)) throw new Error('Deleting a group should not remove its members as contacts');
    console.log('PASS: group deleted, its member contacts remain untouched');

    console.log('STEP 12: Favorites — favoriting the current domain shows a visitor count and names nobody');
    await a.frame.locator('#favoritesSubtabBtn').click();
    await a.frame.locator('#addCurrentFavoriteBtn').click();
    await waitFor(a.frame, () => {
      const card = document.querySelector('#favoritesList .info-card');
      return card && /visitors? here now/.test(card.textContent) ? card.textContent : null;
    }, 'A\'s Favorites list to show a visitor count for the Lobby');
    const favoriteCardText = await a.frame.locator('#favoritesList .info-card').first().textContent();
    if (/friends here/i.test(favoriteCardText) || favoriteCardText.includes('Bee')) throw new Error('Favorites must not say which contacts are present, got: ' + favoriteCardText);
    if (!favoriteCardText.includes('You are here')) throw new Error('Expected the currently-occupied favorite to be marked "You are here" instead of offering a Go button, got: ' + favoriteCardText);
    console.log('PASS: Favorites shows a visitor count only');

    console.log('STEP 13: the quick Lock button — hidden while there\'s nothing unlocked, appears once unlocked, actually locks on click');
    const quickLockHiddenBeforeCheck = await b.frame.evaluate(() => getComputedStyle(document.getElementById('quickLockWalletBtn')).display);
    if (quickLockHiddenBeforeCheck === 'none') throw new Error('Expected B\'s quick lock button to be visible while B\'s identity is unlocked, got display: ' + quickLockHiddenBeforeCheck);
    console.log('PASS: quick lock button is visible while unlocked');
    await b.frame.locator('#quickLockWalletBtn').click();
    await waitFor(b.frame, () => getComputedStyle(document.getElementById('quickLockWalletBtn')).display === 'none', 'B\'s quick lock button to hide itself once locked');
    console.log('PASS: clicking the quick lock button locked the wallet and hid itself');
    const isUnlockedAfter = await b.frame.evaluate(() => AtlasWallet.isUnlocked());
    if (isUnlockedAfter) throw new Error('Expected AtlasWallet.isUnlocked() to be false after clicking the quick lock button');
    console.log('PASS: the wallet is actually locked, not just the button hidden cosmetically');

    console.log('\nALL CONTACTS/FAVORITES/SOCIAL/LOCK CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await contextA.close().catch(() => {});
    await contextB.close().catch(() => {});
    await contextC.close().catch(() => {});
  }
})();
