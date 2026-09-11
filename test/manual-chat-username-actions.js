// Manual end-to-end check for chat username hover tooltips (#115) and the
// right-click context menu / Chat Admin panel (#116).
//
// Timestamp note: viewer.js's chat message shape already carried a
// `sentAt` field identically on both presence-server (server.js's
// sendChatMessage()) and presence-php (store.php's chat_send_message()) —
// added together with `seq` in an earlier build. No backend change was
// needed for the tooltip's timestamp; this test just confirms it's read
// and displayed correctly.
//
// "Online" in the tooltip is checked against presenceRosterMeta, the SAME
// live roster the Friends screen already uses for "people here now" — this
// is presence's own roster (3D-world-only) so a 2D world like the Plaza
// used here never populates it for OTHER visitors; the one case this test
// can exercise live is a sender hovering their OWN name, which
// isChatSenderOnline() special-cases as always online. The "another
// visitor's public key is in the roster" branch is code-reviewed, not
// exercised live here (see the session's own final report for why: it
// needs a 3D (gltf-mini-v1) world with chat enabled, which no current demo
// world has).
//
// Block/mute here is its own local list, deliberately NOT the same one as
// mail's "Block sender" (that one's server-side, per-Post-Office-
// membership — see AtlasWallet.blockChatUser's own comment for the full
// reasoning) — so blocking B in chat here has no effect on B's mail
// standing, and vice versa; this test only exercises the chat-local lists.
//
// Requires the demo issuer-server and presence-server already running:
//   cd /home/claude/domain-atlas && node issuer-server/server.js
//   cd /home/claude/domain-atlas && node presence-server/server.js
//
// Checks:
//   1. B creates an identity, sends a message. B hovers their OWN sender
//      name — tooltip shows a human-readable timestamp and "Online now".
//   2. B right-clicks their own name — the 3-item context menu (Private
//      message / Mute user / Block user) appears (reusing the same visual
//      language as mail's block-sender "⋯" menu).
//   3. A (separate identity) joins, sees B's message. A right-clicks B's
//      name and clicks "Mute user" — B's message disappears from A's chat
//      view immediately (purely local to A; B's message is still visible
//      to B). Settings -> Chat Admin -> Muted users lists B; Unmute
//      restores the message.
//   4. A right-clicks B's name again and clicks "Block user" — same
//      disappearing effect via the separate block list. Chat Admin ->
//      Blocked users lists B; Unblock restores the message.
//   5. A right-clicks B's name and clicks "Private message" — wallet panel
//      opens straight to Mail -> Compose with the recipient field
//      pre-filled with B's raw public key (chat has no handles), reusing
//      openComposeReply()/Quick Reply's exact pre-fill logic.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');

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

async function waitForCondition(frame, fn, description, timeoutMs = 12000) {
  const start = Date.now();
  for (;;) {
    const result = await frame.evaluate(fn);
    if (result) return result;
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for: ' + description);
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function sendChat(frame, text) {
  await frame.locator('#chatTextInput').fill(text);
  await frame.locator('#chatTextInput').press('Enter');
}

async function chatLines(frame) {
  return frame.evaluate(() => Array.from(document.querySelectorAll('#chatMessages .chat-line')).map((el) => el.textContent));
}

// Polls an element's text for a specific substring rather than "any
// non-empty text" — the Chat Admin lists' own EMPTY-state note ("No
// blocked users.") is itself non-empty text, so a naive length>0 wait
// would resolve immediately, before openSettings()'s async
// refreshChatAdminDisplay() has actually re-rendered with the real entry.
async function waitForListToInclude(frame, elementId, substring, timeoutMs = 8000) {
  const start = Date.now();
  for (;;) {
    const text = await frame.evaluate((id) => document.getElementById(id).textContent, elementId);
    if (text.includes(substring)) return text;
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for #' + elementId + ' to include ' + JSON.stringify(substring) + ' — last text: ' + JSON.stringify(text));
    await new Promise((r) => setTimeout(r, 150));
  }
}

(async () => {
  const dirB = path.resolve(__dirname, '.chrome-profile-chat-actions-b');
  const dirA = path.resolve(__dirname, '.chrome-profile-chat-actions-a');
  const launchOpts = { headless: false, executablePath: '/opt/pw-browsers/chromium', args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox'] };

  const contextB = await chromium.launchPersistentContext(dirB, launchOpts);
  const contextA = await chromium.launchPersistentContext(dirA, launchOpts);

  try {
    console.log('STEP 1: B creates an identity, sends a message, hovers own name — tooltip shows timestamp + Online');
    const b = await openOverlay(contextB, 'Visitor B');
    const bKey = await createIdentity(b.frame, 'chat-actions-test-password-b');
    await sendChat(b.frame, 'hello from B');
    await waitForCondition(b.frame, () => document.querySelectorAll('#chatMessages .chat-line').length === 1, 'B to see its own message');

    await b.frame.locator('#chatMessages .chat-name').first().hover();
    await b.frame.waitForFunction(() => getComputedStyle(document.getElementById('chatUserTooltip')).display !== 'none', { timeout: 5000 });
    const tooltipText = await b.frame.evaluate(() => document.getElementById('chatUserTooltip').textContent);
    if (!/Online now/.test(tooltipText)) throw new Error('Expected B\'s own tooltip to show "Online now", got: ' + JSON.stringify(tooltipText));
    if (!/\d/.test(tooltipText)) throw new Error('Expected the tooltip to include a rendered timestamp, got: ' + JSON.stringify(tooltipText));
    console.log('PASS: hover tooltip on own name shows a timestamp and "Online now" — text: ' + JSON.stringify(tooltipText));

    console.log('STEP 2: B right-clicks own name — the 3-item context menu appears');
    await b.frame.locator('#chatMessages .chat-name').first().click({ button: 'right' });
    await b.frame.waitForFunction(() => document.getElementById('chatUserContextMenu').classList.contains('show'), { timeout: 5000 });
    const menuLabels = await b.frame.evaluate(() => Array.from(document.querySelectorAll('#chatUserContextMenu button')).map((el) => el.textContent));
    if (!menuLabels.includes('Private message') || !menuLabels.includes('Mute user') || !menuLabels.includes('Block user')) {
      throw new Error('Expected all 3 menu items, got: ' + JSON.stringify(menuLabels));
    }
    console.log('PASS: right-click context menu shows Private message / Mute user / Block user');
    // Dismiss by clicking elsewhere before A joins.
    await b.page.mouse.click(10, 10);
    await b.frame.waitForFunction(() => !document.getElementById('chatUserContextMenu').classList.contains('show'), { timeout: 5000 });

    console.log('STEP 3: A joins, sees B\'s message, mutes B via the context menu — B\'s message disappears for A only');
    const a = await openOverlay(contextA, 'Visitor A');
    await createIdentity(a.frame, 'chat-actions-test-password-a');
    await waitForCondition(a.frame, () => document.querySelectorAll('#chatMessages .chat-line').length === 1, 'A to see B\'s message');

    await a.frame.locator('#chatMessages .chat-name').first().click({ button: 'right' });
    await a.frame.waitForFunction(() => document.getElementById('chatUserContextMenu').classList.contains('show'), { timeout: 5000 });
    await a.frame.locator('#chatUserContextMenu button[data-action="chat-mute"]').click();
    await waitForCondition(a.frame, () => document.getElementById('chatMessages').textContent.includes('No messages'), 'A\'s view to hide B\'s message after muting');
    console.log('PASS: muting B removes B\'s message from A\'s own chat view');

    const bStillSeesOwnMessage = await chatLines(b.frame);
    if (bStillSeesOwnMessage.length !== 1) throw new Error('Expected B to still see its own message unaffected by A\'s local mute, got: ' + JSON.stringify(bStillSeesOwnMessage));
    console.log('PASS: mute is purely local to A — B still sees its own message');

    console.log('STEP 3b: Chat Admin -> Muted users lists B; Unmute restores the message for A');
    await a.frame.locator('#walletBtn').click();
    await a.frame.waitForFunction(() => document.getElementById('walletPanel').classList.contains('open'), { timeout: 5000 });
    await a.frame.locator('#settingsTabBtn').click();
    await a.frame.locator('.settings-category[data-category="chat-admin"] .settings-category-toggle').click();
    await a.frame.waitForFunction(() => document.querySelector('.settings-category[data-category="chat-admin"]').classList.contains('open'), { timeout: 5000 });
    await waitForListToInclude(a.frame, 'chatMutedUsersList', bKey.slice(0, 24));
    await a.frame.locator('#chatMutedUsersList button[data-action="unmute-chat-user"]').click();
    await a.frame.waitForFunction(() => document.getElementById('chatMutedUsersList').textContent.includes('No muted users'), { timeout: 5000 });
    console.log('PASS: Chat Admin lists the muted user and Unmute clears it');
    await waitForCondition(a.frame, () => document.querySelectorAll('#chatMessages .chat-line').length === 1, 'A\'s view to show B\'s message again after unmuting');
    console.log('PASS: unmuting restores the message in A\'s chat view');

    console.log('STEP 4: A blocks B via the context menu — same disappearing effect via the SEPARATE block list');
    await a.frame.locator('#chatMessages .chat-name').first().click({ button: 'right' });
    await a.frame.waitForFunction(() => document.getElementById('chatUserContextMenu').classList.contains('show'), { timeout: 5000 });
    await a.frame.locator('#chatUserContextMenu button[data-action="chat-block"]').click();
    await waitForCondition(a.frame, () => document.getElementById('chatMessages').textContent.includes('No messages'), 'A\'s view to hide B\'s message after blocking');
    console.log('PASS: blocking B removes B\'s message from A\'s own chat view');

    // The context menu's Block action only re-renders chat messages, not
    // the (currently off-screen, since chat happened via the canvas, not
    // this settings list) Chat Admin display — re-clicking Settings
    // re-triggers openSettings()'s refreshChatAdminDisplay() the same way
    // navigating to the tab normally would. The chat-admin accordion is
    // still .open from step 3b (a static DOM element, untouched by any of
    // this), so no need to re-toggle it.
    await a.frame.locator('#settingsTabBtn').click();
    await waitForListToInclude(a.frame, 'chatBlockedUsersList', bKey.slice(0, 24));
    await a.frame.locator('#chatBlockedUsersList button[data-action="unblock-chat-user"]').click();
    await a.frame.waitForFunction(() => document.getElementById('chatBlockedUsersList').textContent.includes('No blocked users'), { timeout: 5000 });
    console.log('PASS: Chat Admin lists the blocked user (a separate list from mail\'s own Blocked senders) and Unblock clears it');
    await waitForCondition(a.frame, () => document.querySelectorAll('#chatMessages .chat-line').length === 1, 'A\'s view to show B\'s message again after unblocking');
    console.log('PASS: unblocking restores the message in A\'s chat view');

    console.log('STEP 5: A right-clicks B\'s name -> Private message — Compose opens pre-filled with B\'s public key');
    await a.frame.locator('#chatMessages .chat-name').first().click({ button: 'right' });
    await a.frame.waitForFunction(() => document.getElementById('chatUserContextMenu').classList.contains('show'), { timeout: 5000 });
    await a.frame.locator('#chatUserContextMenu button[data-action="chat-pm"]').click();
    await a.frame.waitForFunction(() => document.getElementById('mailBoxComposeSubscreen').classList.contains('active'), { timeout: 5000 });
    const composeKey = await a.frame.evaluate(() => document.getElementById('postOfficeToPublicKeyInput').value);
    const rawKeyModeVisible = await a.frame.evaluate(() => !document.getElementById('postOfficeToPublicKeyInput').hidden);
    if (composeKey !== bKey) throw new Error('Expected Compose recipient pre-filled with B\'s public key ' + bKey + ', got: ' + JSON.stringify(composeKey));
    if (!rawKeyModeVisible) throw new Error('Expected Compose to be in raw-public-key mode (chat has no handles) after Private message');
    console.log('PASS: Private message opens wallet -> Mail -> Compose pre-addressed to B\'s public key');

    console.log('\nALL CHAT USERNAME HOVER/CONTEXT-MENU CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await contextB.close().catch(() => {});
    await contextA.close().catch(() => {});
  }
})();
