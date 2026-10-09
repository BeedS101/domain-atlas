// Manual end-to-end check for chat username hover tooltips and the
// right-click context menu / Chat Admin panel.
//
// Chat senders carry no wallet identity: a message has a display name and a
// random per-join senderId. Mute and block are therefore session-only and
// keyed by that senderId; entries saved by earlier versions (keyed by a
// public key chat no longer carries) are kept untouched and listed as
// legacy entries that no longer match anyone.
//
// Requires the demo issuer-server and presence-server already running:
//   cd /home/claude/domain-atlas && node issuer-server/server.js
//   cd /home/claude/domain-atlas && node presence-server/server.js
//
// Checks:
//   1. B creates an identity, sends a message. Hovering B's own sender name
//      shows a timestamp and says display names are not verified (no
//      "Online now" claim, which would need an identity).
//   2. Right-clicking a name offers exactly Mute (this session) and Block
//      (this session) — no private-message shortcut.
//   3. A (separate identity) mutes B via the menu: B's message disappears
//      for A only. Settings -> Chat Admin lists the session entry; Unmute
//      restores the message. Nothing is written to A's saved mute list.
//   4. Same for Block.
//   5. A mute record saved by an earlier version is preserved and listed
//      with an explanation, and can be removed explicitly.
//   6. After B reconnects (new senderId), a session mute of B's old
//      connection no longer hides B: the new connection's message shows.
//
// The presence-server keeps recent chat history between runs, and these
// checks count messages, so start it fresh for each run.
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
  await frame.page().waitForTimeout(450); // the server rate-limits one sender to a message per CHAT_MIN_INTERVAL_MS
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
    await b.frame.waitForFunction(() => getComputedStyle(document.getElementById('chatUserTooltip')).display !== 'none', null, { timeout: 5000 });
    const tooltipText = await b.frame.evaluate(() => document.getElementById('chatUserTooltip').textContent);
    if (/Online now/.test(tooltipText)) throw new Error('The tooltip must not claim a sender is online, got: ' + JSON.stringify(tooltipText));
    if (!/not verified/.test(tooltipText)) throw new Error('Expected the tooltip to say display names are not verified, got: ' + JSON.stringify(tooltipText));
    if (!/\d/.test(tooltipText)) throw new Error('Expected the tooltip to include a rendered timestamp, got: ' + JSON.stringify(tooltipText));
    console.log('PASS: hover tooltip shows a timestamp and the not-verified note — text: ' + JSON.stringify(tooltipText));

    console.log('STEP 2: right-click offers session Mute / Block only');
    await b.frame.locator('#chatMessages .chat-name').first().click({ button: 'right' });
    await b.frame.waitForFunction(() => document.getElementById('chatUserContextMenu').classList.contains('show'), null, { timeout: 5000 });
    const menuLabels = await b.frame.evaluate(() => Array.from(document.querySelectorAll('#chatUserContextMenu button')).map((el) => el.textContent));
    if (menuLabels.length !== 2 || !menuLabels.includes('Mute (this session)') || !menuLabels.includes('Block (this session)')) {
      throw new Error('Expected exactly the two session moderation items, got: ' + JSON.stringify(menuLabels));
    }
    console.log('PASS: context menu shows Mute (this session) / Block (this session), no Private message');
    // Dismiss by clicking elsewhere before A joins.
    await b.page.mouse.click(10, 10);
    await b.frame.waitForFunction(() => !document.getElementById('chatUserContextMenu').classList.contains('show'), null, { timeout: 5000 });

    console.log('STEP 3: A joins, sees B\'s message, mutes B via the context menu — B\'s message disappears for A only');
    const a = await openOverlay(contextA, 'Visitor A');
    await createIdentity(a.frame, 'chat-actions-test-password-a');
    await waitForCondition(a.frame, () => document.querySelectorAll('#chatMessages .chat-line').length === 1, 'A to see B\'s message');

    await a.frame.locator('#chatMessages .chat-name').first().click({ button: 'right' });
    await a.frame.waitForFunction(() => document.getElementById('chatUserContextMenu').classList.contains('show'), null, { timeout: 5000 });
    await a.frame.locator('#chatUserContextMenu button[data-action="chat-mute"]').click();
    await waitForCondition(a.frame, () => document.getElementById('chatMessages').textContent.includes('No messages'), 'A\'s view to hide B\'s message after muting');
    console.log('PASS: muting B removes B\'s message from A\'s own chat view');

    const bStillSeesOwnMessage = await chatLines(b.frame);
    if (bStillSeesOwnMessage.length !== 1) throw new Error('Expected B to still see its own message unaffected by A\'s local mute, got: ' + JSON.stringify(bStillSeesOwnMessage));
    console.log('PASS: mute is purely local to A — B still sees its own message');

    console.log('STEP 3b: Chat Admin lists the session mute; Unmute restores the message; nothing saved to the wallet');
    await a.frame.locator('#walletBtn').click();
    await a.frame.waitForFunction(() => document.getElementById('walletPanel').classList.contains('open'), null, { timeout: 5000 });
    await a.frame.locator('#settingsTabBtn').click();
    await a.frame.locator('.settings-category[data-category="chat-admin"] .settings-category-toggle').click();
    await a.frame.waitForFunction(() => document.querySelector('.settings-category[data-category="chat-admin"]').classList.contains('open'), null, { timeout: 5000 });
    await waitForListToInclude(a.frame, 'chatMutedUsersList', 'This session only');
    const savedMuted = await a.frame.evaluate(() => AtlasWallet.getMutedChatUsers());
    if (savedMuted.length !== 0) throw new Error('A session mute must not write a saved record, got: ' + JSON.stringify(savedMuted));
    await a.frame.locator('#chatMutedUsersList button[data-action="unmute-chat-session"]').click();
    await a.frame.waitForFunction(() => document.getElementById('chatMutedUsersList').textContent.includes('No muted users'), null, { timeout: 5000 });
    await waitForCondition(a.frame, () => document.querySelectorAll('#chatMessages .chat-line').length === 1, 'A\'s view to show B\'s message again after unmuting');
    console.log('PASS: session mute listed, nothing persisted, Unmute restores the message');

    console.log('STEP 4: A blocks B via the context menu — the separate block list');
    await a.frame.locator('#chatMessages .chat-name').first().click({ button: 'right' });
    await a.frame.waitForFunction(() => document.getElementById('chatUserContextMenu').classList.contains('show'), null, { timeout: 5000 });
    await a.frame.locator('#chatUserContextMenu button[data-action="chat-block"]').click();
    await waitForCondition(a.frame, () => document.getElementById('chatMessages').textContent.includes('No messages'), 'A\'s view to hide B\'s message after blocking');
    await a.frame.locator('#settingsTabBtn').click();
    await waitForListToInclude(a.frame, 'chatBlockedUsersList', 'This session only');
    await a.frame.locator('#chatBlockedUsersList button[data-action="unblock-chat-session"]').click();
    await a.frame.waitForFunction(() => document.getElementById('chatBlockedUsersList').textContent.includes('No blocked users'), null, { timeout: 5000 });
    await waitForCondition(a.frame, () => document.querySelectorAll('#chatMessages .chat-line').length === 1, 'A\'s view to show B\'s message again after unblocking');
    console.log('PASS: session block hides and Unblock restores the message');

    console.log('STEP 5: a mute record saved by an earlier version is preserved, explained and removable');
    await a.frame.evaluate((key) => AtlasWallet.muteChatUser(key, 'Legacy B'), bKey);
    await a.frame.locator('#settingsTabBtn').click();
    const legacyText = await waitForListToInclude(a.frame, 'chatMutedUsersList', 'Legacy B');
    if (!/no longer matches anyone/.test(legacyText)) throw new Error('Expected the legacy entry to be explained, got: ' + legacyText);
    await waitForCondition(a.frame, () => document.querySelectorAll('#chatMessages .chat-line').length === 1, 'the legacy mute must not hide anyone (chat carries no key)');
    await a.frame.locator('#chatMutedUsersList button[data-action="unmute-chat-user"]').click();
    await a.frame.waitForFunction(() => document.getElementById('chatMutedUsersList').textContent.includes('No muted users'), null, { timeout: 5000 });
    console.log('PASS: legacy entry listed with a note, matches nobody, removable only on request');

    console.log('STEP 6: after B reconnects (new senderId), A\'s session mute of the old connection no longer applies');
    await a.frame.locator('#chatMessages .chat-name').first().click({ button: 'right' });
    await a.frame.locator('#chatUserContextMenu button[data-action="chat-mute"]').click();
    await waitForCondition(a.frame, () => document.getElementById('chatMessages').textContent.includes('No messages'), 'A to mute B again');
    await b.frame.evaluate(() => refreshChatIdentity());
    await waitForCondition(b.frame, () => chatIsConnected(), 'B to reconnect chat');
    await b.frame.waitForTimeout(600);
    await sendChat(b.frame, 'hello again from B');
    await waitForCondition(a.frame, () => document.getElementById('chatMessages').textContent.includes('hello again from B'), 'A to see the new connection\'s message');
    console.log('PASS: the mute followed the old connection only; the reconnected sender is visible again');

    console.log('\nALL CHAT USERNAME HOVER/CONTEXT-MENU CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await contextB.close().catch(() => {});
    await contextA.close().catch(() => {});
  }
})();
