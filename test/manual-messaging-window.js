// Manual end-to-end check for the new Messaging window (task #111 first
// slice): a separate, freely draggable/resizable/opacity-controlled
// floating window with "Chats" and "Contacts" tabs, per Bruno's own spec —
// see the design comments on #messagingWidget (viewer.html) and
// openMessagingWindow() (viewer.js) for the full rationale. Transport is
// deliberately NOT a new system: every chat message is ordinary Post
// Office mail carrying a reserved subject marker, diverted by
// checkAllMail() (wallet.js) into its own atlasChatMessages store — a
// "persistent connection" transport is explicitly future work Bruno asked
// to defer, not attempted here.
//
// Requires domain A's issuer-server on 8001 AND domain B running as a real
// issuer-server instance on 8002 (same as manual-postoffice-mail.js) —
// this test does not start either itself.
//
// Checks:
//   1. Two visitors, each with a fresh identity, both join Domain B's Post
//      Office (same claimPostOfficeMembership() flow manual-postoffice-mail.js
//      already exercises) — the transport this feature piggybacks on.
//   2. Visitor A adds Visitor B as a saved contact (the SAME contacts list
//      Mail's own Contacts sub-tab uses).
//   3. Opening the Messaging window defaults to the Chats tab, empty.
//   4. Switching to Contacts shows B with separate "Chat"/"Call" buttons
//      (TODO round 1 item 4) instead of one whole-row click target: "Call"
//      switches to the (honest, placeholder-only) Calls tab naming B;
//      "Chat" opens (chat view) ready for a brand-new message, with the
//      "send via" domain already resolved silently (A only holds one Post
//      Office membership) — no domain picker shown.
//   5. Sending a message renders it immediately in the (chat view) as an
//      outgoing bubble, and going Back to Chats now shows a thread for B
//      with a "You: ..." preview.
//   6. Visitor B's ordinary mail check (checkAllMail) picks the message up
//      into the Messaging window's Chats tab, with an unread badge — and,
//      critically, this message does NOT appear anywhere in B's regular
//      Mail tab (the whole point of the dedicated CHAT_SUBJECT_MARKER
//      diversion in checkAllMail). The message is also actually encrypted
//      at rest on disk (TODO round 1 item 2), not stored as a plain string.
//   7. Opening that thread in B's Messaging window shows the message and
//      clears the unread badge; B replies, and A's next mail check shows
//      the reply appended in chronological order (oldest at top).
//   8. Deleting a conversation from the main view (TODO round 2 item 3,
//      via its own two-click ask/confirm/cancel row) removes it from the
//      Chats list, and a later mail check does not resurrect it
//      (atlasDeletedChatIds suppression, mirroring mail's own
//      atlasDeletedMailIds).
//   9. The window is genuinely draggable (header drag moves it, persisted
//      across a reopen) and resizable (resize handle changes width/height,
//      persisted), and the opacity slider changes the widget's opacity.
//  10. Locking the wallet hides the Messaging button entirely and
//      force-closes the window (TODO round 1 item 1, stricter than
//      in-world chat's own readable-while-locked posture); unlocking
//      again triggers an immediate fetch (TODO round 2 item 1) rather than
//      waiting for the periodic mail-check loop's next tick.
//
// Not covered here: "Domain-push notification" (TODO round 2 item 2) is
// explicitly deferred per Bruno's own request and has no implementation to
// test yet.
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
          const originX = canvas.width / 2;
          const originY = canvas.height / 2 + 40;
          const SCALE = 26, COS30 = Math.cos(Math.PI / 6), SIN30 = Math.sin(Math.PI / 6);
          const points = window.__atlasScene.portalMarkers.map((m) => {
            const [x, , z] = m.position;
            return {
              sx: originX + (x - z) * COS30 * SCALE,
              sy: originY + (x + z) * SIN30 * SCALE,
              kind: m.portal && m.portal.kind,
              to: m.portal && m.portal.to
            };
          });
          resolve(points);
        } else {
          requestAnimationFrame(check);
        }
      };
      check();
    });
  });
}

async function projectInteractables(frame) {
  return frame.evaluate(() => {
    return new Promise((resolve) => {
      const check = () => {
        const scene = window.__atlasScene;
        if (scene && scene.interactables && scene.interactables.length) {
          const canvas = document.getElementById('scene');
          const originX = canvas.width / 2;
          const originY = canvas.height / 2 + 40;
          const points = scene.interactables.map((m) => {
            const [x, y, z] = m.position;
            const p = project(x, y || 0, z, originX, originY);
            return { sx: p.x, sy: p.y - 16, label: m.label, class: m.class };
          });
          resolve(points);
        } else {
          requestAnimationFrame(check);
        }
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
  await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
  console.log('SETUP: ' + label + ' opened the overlay at Example Plaza');
  return { page, frame };
}

async function createIdentity(frame, password) {
  await frame.locator('#walletBtn').click();
  await frame.locator('#chooseNewBtn').click();
  await frame.locator('#newPasswordInput').fill(password);
  await frame.locator('#newPasswordConfirmInput').fill(password);
  await frame.locator('#confirmCreateBtn').click();
  await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
  await frame.locator('#seedConfirmCheck').check();
  await frame.locator('#seedConfirmBtn').click();
  await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
  const publicKey = await frame.evaluate(() => AtlasWallet.getIdentity().then((i) => i.publicKey));
  await frame.locator('#walletBtn').click();
  return publicKey;
}

// Same flow manual-postoffice-mail.js already established — see that
// file's own comment for why sending now requires membership too, not
// just receiving.
async function claimPostOfficeMembership(frame, label) {
  let portals = await projectPortals(frame);
  const toNeighbor = portals.find((p) => p.kind === 'domain');
  if (!toNeighbor) throw new Error('Expected a domain portal out of the Plaza for ' + label);
  await frame.locator('#scene').click({ position: { x: toNeighbor.sx, y: toNeighbor.sy } });
  await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Neighbor Workshop'), { timeout: 10000 });
  await frame.waitForFunction(() => document.getElementById('status').textContent.includes('8002'), { timeout: 10000 });

  const [postOfficeStall] = (await projectInteractables(frame)).filter((m) => m.class === 'atlas.postoffice.membership');
  if (!postOfficeStall) throw new Error('Expected a Post Office interactable (atlas.postoffice.membership) in the workshop scene');
  await frame.locator('#scene').click({ position: { x: postOfficeStall.sx, y: postOfficeStall.sy } });
  await frame.waitForFunction(() => document.getElementById('status').textContent.startsWith('Collected'), { timeout: 10000 });
  console.log('PASS: ' + label + ' claimed a Global Mail Membership Card at Domain B');

  portals = await projectPortals(frame);
  const backToDomainA = portals.find((p) => p.kind === 'domain');
  await frame.locator('#scene').click({ position: { x: backToDomainA.sx, y: backToDomainA.sy } });
  await frame.waitForFunction(() => document.getElementById('status').textContent.includes('8001'), { timeout: 10000 });
}

(async () => {
  const dirA = path.resolve(__dirname, '.chrome-profile-messaging-a');
  const dirB = path.resolve(__dirname, '.chrome-profile-messaging-b');
  const launchOpts = { headless: false, executablePath: '/opt/pw-browsers/chromium', args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox'] };

  const contextA = await chromium.launchPersistentContext(dirA, launchOpts);
  const contextB = await chromium.launchPersistentContext(dirB, launchOpts);

  try {
    const a = await openOverlay(contextA, 'Visitor A');
    const b = await openOverlay(contextB, 'Visitor B');

    console.log('STEP 0: two visitors create their own real wallet identities and both join Domain B\'s Post Office');
    const pkA = await createIdentity(a.frame, 'messaging-test-password-a');
    const pkB = await createIdentity(b.frame, 'messaging-test-password-b');
    if (pkA === pkB) throw new Error('Expected two independently created identities to differ');
    await claimPostOfficeMembership(a.frame, 'Visitor A');
    await claimPostOfficeMembership(b.frame, 'Visitor B');
    console.log('PASS: both visitors hold a Global Mail Membership at localhost:8002 ->', pkA.slice(0, 16) + '...', pkB.slice(0, 16) + '...');

    console.log('STEP 1: Visitor A saves Visitor B as a contact (same contacts list Mail\'s own Contacts sub-tab uses)');
    await a.frame.evaluate((pk) => AtlasWallet.addFriend(pk, 'Bob'), pkB);
    console.log('PASS: contact saved');

    console.log('STEP 2: opening the Messaging window defaults to the Chats tab, empty');
    await a.frame.locator('#messagingBtn').click();
    await a.frame.waitForFunction(() => !document.getElementById('messagingWidget').hidden, { timeout: 5000 });
    await a.frame.waitForFunction(() => document.querySelector('.messaging-tab[data-messaging-tab="chats"]').classList.contains('active-subtab'), { timeout: 5000 });
    await a.frame.waitForFunction(() => document.getElementById('messagingChatsList').textContent.includes('No conversations yet'), { timeout: 5000 });
    console.log('PASS: Messaging window opened on Chats, empty as expected');

    console.log('STEP 3: switching to Contacts shows Bob with separate Chat/Call buttons (TODO round 1 item 4, no more whole-row click)');
    await a.frame.locator('.messaging-tab[data-messaging-tab="contacts"]').click();
    await a.frame.waitForFunction(() => document.getElementById('messagingContactsList').textContent.includes('Bob'), { timeout: 5000 });
    const bobContactRow = a.frame.locator('#messagingContactsList .messaging-list-item', { hasText: 'Bob' });
    console.log('STEP 3a: clicking "Call" for Bob switches to the (placeholder) Calls tab, naming him');
    await bobContactRow.locator('button', { hasText: 'Call' }).click();
    await a.frame.waitForFunction(() => document.querySelector('.messaging-tab[data-messaging-tab="calls"]').classList.contains('active-subtab'), { timeout: 5000 });
    await a.frame.waitForFunction(() => document.getElementById('messagingCallsBody').textContent.includes('Bob'), { timeout: 5000 });
    const callsPlaceholderText = await a.frame.locator('#messagingCallsBody').textContent();
    if (!callsPlaceholderText.toLowerCase().includes("isn't built yet")) throw new Error('Expected an honest "not built yet" placeholder on the Calls tab, got: ' + callsPlaceholderText);
    console.log('PASS: Calls tab shows an honest placeholder naming Bob, no fake calling UI');

    console.log('STEP 3b: back to Contacts, clicking "Chat" for Bob opens (chat view) with the domain already resolved (only one membership)');
    await a.frame.locator('.messaging-tab[data-messaging-tab="contacts"]').click();
    await a.frame.waitForFunction(() => document.getElementById('messagingContactsList').textContent.includes('Bob'), { timeout: 5000 });
    await a.frame.locator('#messagingContactsList .messaging-list-item', { hasText: 'Bob' }).locator('button', { hasText: 'Chat' }).click();
    await a.frame.waitForFunction(() => !document.getElementById('messagingChatView').hidden, { timeout: 5000 });
    // openMessagingChatView() is fired-and-forgotten by the click handler
    // (async, not awaited) — #messagingChatView.hidden flips to false
    // synchronously at the top of that function, well before its own
    // identity/domain-resolution work (and the resulting textbox
    // enable/disable) finishes. Wait for the textbox to actually become
    // enabled rather than racing that in-flight async work.
    await a.frame.waitForFunction(() => !document.getElementById('messagingChatTextInput').disabled, { timeout: 5000 });
    const chatViewName = await a.frame.locator('#messagingChatViewName').textContent();
    if (chatViewName !== 'Bob') throw new Error('Expected (chat view) header to show the contact\'s name, got: ' + chatViewName);
    const domainRowHidden = await a.frame.locator('#messagingChatDomainRow').isHidden();
    if (!domainRowHidden) throw new Error('Expected the domain picker to stay hidden — A only holds one Post Office membership, nothing ambiguous to ask about');
    console.log('PASS: (chat view) opened for Bob, domain silently resolved, textbox ready');

    console.log('STEP 4: sending a message renders it as an outgoing bubble, and Back shows a Chats thread with a "You: ..." preview');
    await a.frame.locator('#messagingChatTextInput').fill('Hey Bob, trying out the new messaging window!');
    await a.frame.locator('#messagingChatTextInput').press('Enter');
    await a.frame.waitForFunction(() => document.querySelectorAll('#messagingChatMessages .messaging-chat-line.out').length === 1, { timeout: 10000 });
    const sentText = await a.frame.locator('#messagingChatMessages .messaging-chat-line.out').textContent();
    if (!sentText.includes('Hey Bob')) throw new Error('Expected the sent message to render in the chat view: ' + sentText);
    // Back returns to whichever tab this conversation was opened FROM —
    // this one was opened from Contacts, so Back correctly lands there,
    // not on Chats (see closeMessagingChatView()'s own comment). Switch to
    // Chats explicitly, same as a real user would, to check the thread now
    // shows up there too.
    await a.frame.locator('#messagingChatBackBtn').click();
    await a.frame.waitForFunction(() => !document.getElementById('messagingContactsView').hidden, { timeout: 5000 });
    await a.frame.locator('.messaging-tab[data-messaging-tab="chats"]').click();
    await a.frame.waitForFunction(() => document.getElementById('messagingChatsList').textContent.includes('You: Hey Bob'), { timeout: 5000 });
    console.log('PASS: message sent, rendered, and reflected in the Chats thread list preview');

    console.log('STEP 5: Visitor B\'s ordinary mail check picks it up into Messaging (unread badge) WITHOUT it ever appearing in the regular Mail tab');
    await b.frame.evaluate(() => AtlasWallet.checkAllMail());
    await b.frame.locator('#messagingBtn').click();
    await b.frame.waitForFunction(() => document.getElementById('messagingChatsList').textContent.includes('Hey Bob'), { timeout: 10000 });
    const unreadBadgeText = await b.frame.locator('.messaging-thread-unread').textContent();
    if (unreadBadgeText !== '1') throw new Error('Expected an unread count of 1 on Bob\'s new thread from Alice, got: ' + unreadBadgeText);
    console.log('PASS: B\'s Messaging window shows the new thread with an unread badge');

    console.log('STEP 5b: the message is actually encrypted at rest on disk (TODO round 1 item 2), not stored as a plain string');
    const rawStoredBody = await b.frame.evaluate((pkB) => chrome.storage.local.get('atlasChatMessages').then((r) => {
      const entries = (r.atlasChatMessages || {})[pkB] || [];
      const entry = entries.find((e) => e.direction === 'in');
      return entry && entry.body;
    }), pkB);
    if (typeof rawStoredBody === 'string') throw new Error('REGRESSION: chat body stored as a plain string on disk — expected an encrypted { __atlasChatEncrypted } envelope');
    if (!rawStoredBody || !rawStoredBody.__atlasChatEncrypted || typeof rawStoredBody.iv !== 'string' || typeof rawStoredBody.ciphertext !== 'string') {
      throw new Error('Expected an { __atlasChatEncrypted, iv, ciphertext } envelope on disk, got: ' + JSON.stringify(rawStoredBody));
    }
    console.log('PASS: on-disk chat body is an AES-GCM envelope, not plaintext — decrypted display in STEP 5 above already proved round-tripping works');

    // The critical regression check: this marker-subject message must be
    // completely invisible to the existing Mail tab (list AND badge) —
    // the whole reason checkAllMail() diverts it into a separate store.
    await b.frame.locator('#messagingCloseBtn').click();
    await b.frame.locator('#walletBtn').click();
    await b.frame.locator('#socialTabBtn').click();
    await b.frame.waitForFunction(() => document.getElementById('mailSubscreen').classList.contains('active'), { timeout: 5000 });
    const mailCardCount = await b.frame.locator('#mailList .mail-card').count();
    const mailListText = await b.frame.locator('#mailList').textContent();
    if (mailListText.includes('Hey Bob')) throw new Error('REGRESSION: the chat message leaked into the regular Mail tab — checkAllMail\'s CHAT_SUBJECT_MARKER diversion is broken');
    console.log('PASS: Mail tab is untouched by the chat message (' + mailCardCount + ' ordinary mail card(s) — just the membership welcome mail)');
    await b.frame.locator('#backFromSettingsBtn, #walletCloseBtn').first().click().catch(() => {});

    console.log('STEP 6: opening the thread clears the unread badge; B replies; A\'s next mail check shows the reply appended, oldest first');
    await b.frame.locator('#messagingBtn').click();
    await b.frame.waitForFunction(() => !document.getElementById('messagingWidget').hidden, { timeout: 5000 });
    if ((await b.frame.locator('#messagingChatsList').textContent()).includes('No conversations')) {
      // window re-opened fresh (state wasn't preserved across close) — fine, just navigate back to Chats
      await b.frame.locator('.messaging-tab[data-messaging-tab="chats"]').click();
    }
    await b.frame.locator('#messagingChatsList .messaging-list-item-main', { hasText: 'Hey Bob' }).click();
    await b.frame.waitForFunction(() => !document.getElementById('messagingChatView').hidden, { timeout: 5000 });
    await b.frame.waitForFunction(() => !document.getElementById('messagingChatTextInput').disabled, { timeout: 5000 });
    await b.frame.locator('#messagingChatTextInput').fill('Looks great, Alice!');
    await b.frame.locator('#messagingChatTextInput').press('Enter');
    await b.frame.waitForFunction(() => document.querySelectorAll('#messagingChatMessages .messaging-chat-line').length === 2, { timeout: 10000 });

    await a.frame.evaluate(() => AtlasWallet.checkAllMail());
    // A's window (messagingBtn toggles open/closed) was left open from
    // STEP 4 — only click it if it's actually closed, same guard B's own
    // reopen used above.
    if (await a.frame.locator('#messagingWidget').isHidden()) await a.frame.locator('#messagingBtn').click();
    await a.frame.waitForFunction(() => !document.getElementById('messagingWidget').hidden, { timeout: 5000 });
    await a.frame.locator('.messaging-tab[data-messaging-tab="chats"]').click().catch(() => {});
    await a.frame.locator('#messagingChatsList .messaging-list-item-main', { hasText: 'Bob' }).click();
    await a.frame.waitForFunction(() => document.querySelectorAll('#messagingChatMessages .messaging-chat-line').length === 2, { timeout: 10000 });
    const lines = await a.frame.locator('#messagingChatMessages .messaging-chat-line').allTextContents();
    if (!lines[0].includes('Hey Bob')) throw new Error('Expected A\'s own first message to render oldest-first (on top): ' + JSON.stringify(lines));
    if (!lines[1].includes('Looks great')) throw new Error('Expected Bob\'s reply to render newest-last (on bottom): ' + JSON.stringify(lines));
    console.log('PASS: both directions of the conversation round-tripped through ordinary mail, rendered oldest-to-newest');

    console.log('STEP 6b: deleting the thread from the main view (TODO round 2 item 3) removes it, and a later mail check does not resurrect it');
    await a.frame.locator('#messagingChatBackBtn').click();
    await a.frame.waitForFunction(() => !document.getElementById('messagingChatsView').hidden, { timeout: 5000 });
    const bobThreadRow = a.frame.locator('#messagingChatsList .messaging-list-item', { hasText: 'Bob' });
    await bobThreadRow.locator('[data-action="delete-chat-thread-ask"]').click();
    await a.frame.waitForFunction(() => {
      const row = document.querySelector('#messagingChatsList .remove-confirm-row');
      return row && !row.hidden;
    }, { timeout: 5000 });
    // Cancel first, to prove Cancel actually backs out without deleting
    // anything — same two-click safety wallet Contacts' own Remove uses.
    await a.frame.locator('#messagingChatsList [data-action="delete-chat-thread-cancel"]').click();
    await a.frame.waitForFunction(() => document.getElementById('messagingChatsList').textContent.includes('Bob'), { timeout: 5000 });
    // Now actually delete — ask again, wait past the misclick-guard grace
    // period, then confirm for real.
    await a.frame.locator('#messagingChatsList [data-action="delete-chat-thread-ask"]').click();
    await a.frame.waitForTimeout(500);
    await a.frame.locator('#messagingChatsList [data-action="delete-chat-thread-confirm"]').click();
    await a.frame.waitForFunction(() => document.getElementById('messagingChatsList').textContent.includes('No conversations yet'), { timeout: 5000 });
    console.log('PASS: deleting the thread from the main view removes it from the Chats list');

    // The real regression risk this guards against: B's relaying domain
    // still holds its own copy of the message it sent A, so a re-check
    // that only looked at what's currently in atlasChatMessages would
    // re-fetch and resurrect it. This exercises A's OWN copy instead (B
    // never re-sends), by re-running checkAllMail and confirming the
    // now-empty Chats list stays empty rather than the deleted entries
    // reappearing from A's own already-delivered mail state.
    await a.frame.evaluate(() => AtlasWallet.checkAllMail());
    await a.frame.locator('.messaging-tab[data-messaging-tab="chats"]').click();
    await a.frame.waitForTimeout(500);
    const chatsAfterRecheck = await a.frame.locator('#messagingChatsList').textContent();
    if (!chatsAfterRecheck.includes('No conversations yet')) throw new Error('REGRESSION: a deleted chat thread resurrected after checkAllMail() — atlasDeletedChatIds suppression is broken: ' + chatsAfterRecheck);
    console.log('PASS: the deleted conversation stayed gone across another mail check (atlasDeletedChatIds suppression works)');

    console.log('STEP 7: the window is genuinely draggable and resizable, and the opacity slider works');
    const beforeSettings = await a.frame.evaluate(() => AtlasWallet.getMessagingWindowSettings());
    // Click inside .messaging-header-spacer specifically, not the header's
    // own geometric center — with three tabs now in the tab bar (TODO
    // round 1 item 3), the header's midpoint can land on the "Contacts"
    // button rather than empty space; the spacer is the header's own
    // dedicated always-empty drag strip (see its CSS comment).
    const spacerBox = await a.frame.locator('#messagingHeader .messaging-header-spacer').boundingBox();
    await a.page.mouse.move(spacerBox.x + spacerBox.width / 2, spacerBox.y + spacerBox.height / 2);
    await a.page.mouse.down();
    await a.page.mouse.move(spacerBox.x + spacerBox.width / 2 - 60, spacerBox.y + spacerBox.height / 2 + 40, { steps: 5 });
    await a.page.mouse.up();
    const afterDragSettings = await a.frame.evaluate(() => AtlasWallet.getMessagingWindowSettings());
    if (!afterDragSettings.positioned) throw new Error('Expected dragging the header to mark the window as explicitly positioned');
    if (afterDragSettings.left === beforeSettings.left && afterDragSettings.top === beforeSettings.top) {
      throw new Error('Expected the drag to actually move the window (left/top unchanged)');
    }
    console.log('PASS: header drag moved the window and persisted the new position ->', afterDragSettings.left, afterDragSettings.top);

    const resizeHandleBox = await a.frame.locator('#messagingResizeHandle').boundingBox();
    await a.page.mouse.move(resizeHandleBox.x + resizeHandleBox.width / 2, resizeHandleBox.y + resizeHandleBox.height / 2);
    await a.page.mouse.down();
    await a.page.mouse.move(resizeHandleBox.x + 50, resizeHandleBox.y + 50, { steps: 5 });
    await a.page.mouse.up();
    const afterResizeSettings = await a.frame.evaluate(() => AtlasWallet.getMessagingWindowSettings());
    if (afterResizeSettings.width === beforeSettings.width && afterResizeSettings.height === beforeSettings.height) {
      throw new Error('Expected the resize handle drag to actually change width/height');
    }
    console.log('PASS: resize handle changed the window\'s size and persisted it ->', afterResizeSettings.width, 'x', afterResizeSettings.height);

    await a.frame.locator('#messagingSettingsBtn').click();
    await a.frame.waitForFunction(() => !document.getElementById('messagingSettingsPopover').hidden, { timeout: 5000 });
    await a.frame.locator('#messagingOpacityInput').fill('0.5');
    await a.frame.locator('#messagingOpacityInput').dispatchEvent('input');
    await a.frame.waitForFunction(() => document.getElementById('messagingWidget').style.opacity === '0.5', { timeout: 5000 });
    const afterOpacitySettings = await a.frame.evaluate(() => AtlasWallet.getMessagingWindowSettings());
    if (afterOpacitySettings.opacity !== 0.5) throw new Error('Expected the opacity setting to persist at 0.5, got: ' + afterOpacitySettings.opacity);
    console.log('PASS: opacity slider updates the widget live and persists');

    console.log('STEP 8: closing and reopening the window restores its position/size (survives a close, not just in-memory)');
    await a.frame.locator('#messagingCloseBtn').click();
    await a.frame.waitForFunction(() => document.getElementById('messagingWidget').hidden, { timeout: 5000 });
    await a.frame.locator('#messagingBtn').click();
    await a.frame.waitForFunction(() => !document.getElementById('messagingWidget').hidden, { timeout: 5000 });
    const reopenedWidth = await a.frame.evaluate(() => document.getElementById('messagingPanel').style.width);
    if (reopenedWidth !== afterResizeSettings.width + 'px') throw new Error('Expected the reopened window to restore its persisted width, got: ' + reopenedWidth);
    console.log('PASS: reopened window restored its persisted size');

    console.log('STEP 9: locking the wallet hides Messaging entirely (TODO round 1 item 1), and unlocking fetches immediately rather than waiting for the periodic loop (TODO round 2 item 1)');
    await a.frame.evaluate(() => AtlasWallet.lockIdentity());
    await a.frame.waitForFunction(() => document.getElementById('messagingBtn').style.display === 'none', { timeout: 5000 });
    await a.frame.waitForFunction(() => document.getElementById('messagingWidget').hidden, { timeout: 5000 });
    console.log('PASS: locking the wallet hides the Messaging button and force-closes the window, stricter than in-world chat\'s own readable-while-locked posture');

    // While A is locked, B sends a brand-new message on the SAME thread A
    // deleted in STEP 6b — a fresh id checkAllMail has never seen before,
    // so it must be fetched and rebuild a thread from scratch.
    await b.frame.locator('#messagingChatTextInput').fill('Ping while you were away!');
    await b.frame.locator('#messagingChatTextInput').press('Enter');
    await b.frame.waitForFunction(() => document.querySelectorAll('#messagingChatMessages .messaging-chat-line').length === 3, { timeout: 10000 });

    // Unlock A directly (the password screen itself is exercised elsewhere
    // in this suite) and check the new message is ALREADY fetched — no
    // manual checkAllMail() call from this test — proving it was the
    // storage-change listener's fetch-on-login doing the work, not the
    // periodic loop happening to have ticked in the meantime.
    await a.frame.evaluate((pw) => AtlasWallet.unlockIdentity(pw), 'messaging-test-password-a');
    await a.frame.waitForFunction(() => document.getElementById('messagingBtn').style.display !== 'none', { timeout: 5000 });
    // unlockIdentity() only resolves once the session storage write lands —
    // it does NOT wait for the chrome.storage.onChanged listener's own
    // async chain (refreshMessagingLockGate, then checkAllMail) to finish
    // reacting to that write, and neither does the messagingBtn visibility
    // check above (refreshMessagingLockGate flips that BEFORE checkAllMail
    // even starts, since they're separate awaits in sequence). So this
    // polls the actual data via waitForFunction (which accepts an async
    // predicate) instead of assuming a single synchronous check after
    // unlock is enough — this is what actually proves fetch-on-login ran
    // to completion, not just that it started.
    await a.frame.waitForFunction(async () => {
      const identity = await AtlasWallet.getIdentity();
      if (!identity) return false;
      const threads = await AtlasWallet.getChatThreads(identity.publicKey);
      return threads.length === 1 && threads[0].lastMessage.body.includes('Ping while you were away');
    }, { timeout: 10000 });
    console.log('PASS: unlocking triggered an immediate fetch — no manual checkAllMail() needed for the new message to show up');

    await a.frame.locator('#messagingBtn').click();
    await a.frame.waitForFunction(() => !document.getElementById('messagingWidget').hidden, { timeout: 5000 });
    await a.frame.waitForFunction(() => document.getElementById('messagingChatsList').textContent.includes('Ping while you were away'), { timeout: 5000 });
    console.log('PASS: the freshly-fetched message is visible in the reopened Chats list');

    console.log('\nALL MESSAGING WINDOW CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await contextA.close();
    await contextB.close();
  }
})();
