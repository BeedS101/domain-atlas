// Manual end-to-end check for the chat "history on join" toggle (#114).
//
// historyOnJoin is a purely local/client display preference in
// AtlasWallet's chat panel settings (default true, preserving the exact
// original behavior) — turning it off does NOT ask presence-server or
// presence-php to withhold anything; the client simply discards the
// history batch it already received on join and starts the message list
// empty, only growing from whatever arrives LIVE from that point forward.
//
// Requires the demo issuer-server and presence-server already running
// (this test does not start them itself — same convention as the other
// manual-*.js scripts):
//   cd /home/claude/domain-atlas && node issuer-server/server.js
//   cd /home/claude/domain-atlas && node presence-server/server.js
//
// Checks:
//   1. Visitor B creates an identity and sends two messages in the Plaza.
//   2. Visitor C (fresh, historyOnJoin defaults to true) joins the Plaza
//      afterward and sees BOTH of B's messages via the join history batch
//      — proves the default preserves the original "history on join"
//      behavior.
//   3. C turns "Show history on join" OFF via the real settings-popover
//      checkbox, then leaves (walks to Arena) and comes back to the Plaza,
//      forcing a fresh disconnectChat()+connectChat() rejoin. Right after
//      rejoining, C's message list is EMPTY, despite B's two messages
//      still sitting in the server's history buffer — proves the batch is
//      discarded, not that the server was ever asked to withhold it.
//   4. B then sends a third, live message. C sees it immediately — proves
//      the toggle only ever affects the JOIN batch, never live traffic.
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
            return { sx: originX + (x - z) * COS30 * SCALE, sy: originY + (x + z) * SIN30 * SCALE, to: m.portal && m.portal.to };
          }));
        } else { requestAnimationFrame(check); }
      };
      check();
    });
  });
}
async function waitForPortal(frame, predicate, description, timeoutMs = 8000) {
  const start = Date.now();
  for (;;) {
    const portals = await projectPortals(frame);
    const match = portals.find(predicate);
    if (match) return match;
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for a portal matching: ' + description);
    await new Promise((r) => setTimeout(r, 150));
  }
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
  await frame.locator('#walletBtn').click();
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

async function setHistoryOnJoin(frame, on) {
  await frame.locator('#chatSettingsBtn').click();
  await frame.waitForFunction(() => !document.getElementById('chatSettingsPopover').hidden, { timeout: 5000 });
  const checkbox = frame.locator('#chatHistoryOnJoinInput');
  const isChecked = await checkbox.isChecked();
  if (isChecked !== on) await checkbox.click();
  await frame.page().waitForTimeout(150); // let setChatPanelSettings()/applyChatPanelSize() round-trip settle
  await frame.locator('#chatSettingsBtn').click();
  await frame.waitForFunction(() => document.getElementById('chatSettingsPopover').hidden, { timeout: 5000 });
}

(async () => {
  const dirB = path.resolve(__dirname, '.chrome-profile-chat-history-b');
  const dirC = path.resolve(__dirname, '.chrome-profile-chat-history-c');
  const launchOpts = { headless: false, executablePath: '/opt/pw-browsers/chromium', args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox'] };

  const contextB = await chromium.launchPersistentContext(dirB, launchOpts);
  const contextC = await chromium.launchPersistentContext(dirC, launchOpts);

  try {
    console.log('STEP 1: B creates an identity and sends two messages in the Plaza');
    const b = await openOverlay(contextB, 'Visitor B');
    await createIdentity(b.frame, 'chat-history-test-password-b');
    await sendChat(b.frame, 'first history message');
    await waitForCondition(b.frame, () => document.querySelectorAll('#chatMessages .chat-line').length === 1, 'B to see its own first message');
    await sendChat(b.frame, 'second history message');
    await waitForCondition(b.frame, () => document.querySelectorAll('#chatMessages .chat-line').length === 2, 'B to see its own second message');
    console.log('PASS: B sent two messages');

    console.log('STEP 2: C (fresh, historyOnJoin defaults to true) joins the Plaza and sees BOTH messages via history');
    const c = await openOverlay(contextC, 'Visitor C');
    await waitForCondition(c.frame, () => document.querySelectorAll('#chatMessages .chat-line').length === 2, 'C to receive both of B\'s messages via join history', 8000);
    const cLinesAfterJoin = await chatLines(c.frame);
    if (!cLinesAfterJoin[0].includes('first history message') || !cLinesAfterJoin[1].includes('second history message')) {
      throw new Error('Expected C to see both prior messages via history-on-join by default, got: ' + JSON.stringify(cLinesAfterJoin));
    }
    console.log('PASS: default historyOnJoin=true shows the full backlog on join');

    console.log('STEP 3: C turns "Show history on join" OFF, then rejoins the Plaza (via Arena and back) — list starts EMPTY');
    await setHistoryOnJoin(c.frame, false);
    const toArena = await waitForPortal(c.frame, (p) => p.to === 'arena', 'the Arena portal from Plaza (C)');
    await c.frame.locator('#scene').click({ position: { x: toArena.sx, y: toArena.sy } });
    await c.frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Arena'), { timeout: 10000 });
    const backToPlaza = await waitForPortal(c.frame, (p) => p.to === 'plaza', 'the Plaza portal from Arena (C)');
    await c.frame.locator('#scene').click({ position: { x: backToPlaza.sx, y: backToPlaza.sy } });
    await c.frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    // Give connectChat() a moment to actually join and (if it were going to)
    // receive/render the history batch, then assert it's still empty.
    await c.page.waitForTimeout(1500);
    const emptyNoteShown = await c.frame.evaluate(() => document.getElementById('chatMessages').textContent.includes('No messages'));
    if (!emptyNoteShown) throw new Error('Expected C\'s message list to be EMPTY right after rejoining with historyOnJoin off, got: ' + JSON.stringify(await chatLines(c.frame)));
    console.log('PASS: historyOnJoin=false discards the join history batch — list starts empty despite prior history existing server-side');

    console.log('STEP 4: B sends a new LIVE message — C sees it immediately, proving the toggle only affects the join batch');
    await sendChat(b.frame, 'live message after rejoin');
    await waitForCondition(c.frame, () => document.querySelectorAll('#chatMessages .chat-line').length === 1, 'C to receive the live message despite historyOnJoin being off', 8000);
    const cLinesLive = await chatLines(c.frame);
    if (!cLinesLive[0].includes('live message after rejoin')) throw new Error('Expected C to see the live message, got: ' + JSON.stringify(cLinesLive));
    console.log('PASS: live messages still arrive normally with historyOnJoin off');

    console.log('\nALL CHAT HISTORY-ON-JOIN TOGGLE CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await contextB.close().catch(() => {});
    await contextC.close().catch(() => {});
  }
})();
