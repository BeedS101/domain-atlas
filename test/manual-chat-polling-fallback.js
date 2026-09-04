// Manual end-to-end check for chat's HTTP polling fallback (task #110,
// the chat counterpart of task #68's presence polling fallback). Proves
// the EXTENSION itself actually falls back from WebSocket to polling for
// CHAT and still gets a working live chat — not just that
// presence-server's /presence/poll/chat-* routes work in isolation (see
// manual-chat-php.js and the raw-HTTP smoke check in this session for
// that), but that connectChat() in extension/viewer.js genuinely detects
// a WS-incapable server and switches transports on its own, end to end,
// through two real browser contexts.
//
// Uses presence-server's PRESENCE_DISABLE_WS=1 test hook — the same one
// manual-presence-polling-fallback.js uses — since chat rides the exact
// same WebSocket upgrade endpoint (/presence) presence does; disabling it
// disables both at once, which is exactly the real-world case this
// proves against (a plain PHP/Apache host, see presence-php/README.txt,
// can run neither).
//
// Deliberately tests chat in the PLAZA (2D, procedural-v1), not the
// Lobby — unlike presence (3D-only, gated on active3D throughout
// server.js's client counterpart), chat is meant to work in every world,
// and this is the one manual test that actually proves the polling
// fallback specifically works in a 2D world, not just that chat itself
// does (manual-chat-feature-style scratch coverage already proved 2D
// chat works over WebSocket).
//
// IMPORTANT: same as manual-presence-polling-fallback.js — viewer.js's
// PRESENCE_DEFAULT_BASE/CHAT_DEFAULT_BASE are hardcoded to localhost:8004,
// so this test's throwaway server must run on the REAL port 8004, not an
// isolated one. Stop any already-running presence-server on 8004 before
// running this.
//
// Checks:
//   1. Visitor A (anonymous) enters the Plaza against a WS-disabled
//      presence-server — reads chat (empty) with no error, same
//      graceful-degradation guarantee presence's own fallback test checks.
//   2. Visitor B enters the same Plaza, creates + unlocks a wallet
//      identity, sends a message — within a couple of polling cycles, A
//      (still anonymous) sees it. Proves the fallback actually engaged
//      for chat specifically (not just presence, which this domain also
//      happens to be polling for) and that anonymous read still works
//      over polling.
//   3. B sends a profanity-laden message — rejected client-side, never
//      reaches A, same as the WebSocket path's own check.
//   4. This World vs Domain tabs still work over polling: B walks
//      Plaza -> Arena and sends there; B's This World tab shows only the
//      Arena message, Domain tab shows both — proves the client-side
//      world-tag filtering (renderChatMessages()) is transport-agnostic,
//      exactly as designed.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const PRESENCE_PORT = 8004; // must match viewer.js's hardcoded PRESENCE_DEFAULT_BASE/CHAT_DEFAULT_BASE

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

async function chatWorldLines(frame) {
  return frame.evaluate(() => Array.from(document.querySelectorAll('#chatMessagesWorld .chat-line')).map((el) => el.textContent));
}
async function chatDomainLines(frame) {
  return frame.evaluate(() => Array.from(document.querySelectorAll('#chatMessagesDomain .chat-line')).map((el) => el.textContent));
}
async function sendChat(frame, text) {
  await frame.locator('#chatTextInput').fill(text);
  await frame.locator('#chatTextInput').press('Enter');
}

(async () => {
  console.log('SETUP: starting a WS-disabled presence-server on the real port ' + PRESENCE_PORT + ' (simulating a polling-only host)');
  const serverProc = spawn(process.execPath, [path.resolve(__dirname, '..', 'presence-server', 'server.js')], {
    env: { ...process.env, PORT: String(PRESENCE_PORT), PRESENCE_DISABLE_WS: '1', POLL_TIMEOUT_MS: '2500', POLL_SWEEP_INTERVAL_MS: '500' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('presence-server did not start in time')), 5000);
    serverProc.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); resolve(); } });
    serverProc.on('exit', (code) => reject(new Error('presence-server exited early with code ' + code + ' — is port ' + PRESENCE_PORT + ' already in use by another instance?')));
  });
  console.log('PASS: WS-disabled server up on port ' + PRESENCE_PORT);

  const dirA = path.resolve(__dirname, '.chrome-profile-chat-poll-a');
  const dirB = path.resolve(__dirname, '.chrome-profile-chat-poll-b');
  const launchOpts = { headless: false, executablePath: '/opt/pw-browsers/chromium', args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox'] };

  const contextA = await chromium.launchPersistentContext(dirA, launchOpts);
  const contextB = await chromium.launchPersistentContext(dirB, launchOpts);

  try {
    console.log('STEP 1: A (anonymous) enters the Plaza against a WS-disabled server — reads empty chat with no error');
    const a = await openOverlay(contextA, 'Visitor A (anonymous)');
    await waitForCondition(a.frame, () => document.getElementById('chatMessagesWorld').textContent.includes('No messages'), 'A\'s This World tab to show the empty-state note via polling', 8000);
    console.log('PASS: A reads empty chat via the polling fallback, no error');

    console.log('STEP 2: B enters, creates + unlocks an identity, sends a message — within a couple of polling cycles A sees it');
    const b = await openOverlay(contextB, 'Visitor B');
    await createIdentity(b.frame, 'chat-poll-test-password-b');
    await sendChat(b.frame, 'hello via polling');
    await waitForCondition(a.frame, () => document.querySelectorAll('#chatMessagesWorld .chat-line').length === 1, 'A to see B\'s message via polling', 8000);
    const aLines = await chatWorldLines(a.frame);
    if (!aLines[0].includes('hello via polling')) throw new Error('Expected A to see "hello via polling", got: ' + JSON.stringify(aLines));
    console.log('PASS: A (anonymous) received B\'s message over the polling fallback — got: ' + aLines[0]);

    console.log('STEP 3: a profanity-laden message from B is rejected client-side, never reaches A');
    await b.frame.locator('#chatTextInput').fill('you fucking idiot');
    await b.frame.locator('#chatTextInput').press('Enter');
    await b.page.waitForTimeout(500);
    const bStatus = await b.frame.evaluate(() => document.getElementById('chatSendStatus').textContent);
    if (!/blocked/i.test(bStatus)) throw new Error('Expected a "blocked" status on B\'s side, got: ' + JSON.stringify(bStatus));
    const stillOne = await chatWorldLines(a.frame);
    if (stillOne.length !== 1) throw new Error('Expected the blocked message to never reach A, A has: ' + JSON.stringify(stillOne));
    console.log('PASS: profanity rejected client-side over the polling path too, status="' + bStatus + '"');

    console.log('STEP 4: This World vs Domain tabs still work over polling — B walks Plaza -> Arena and sends there');
    const portals = await projectPortals(b.frame);
    const toArena = portals.find((p) => p.to === 'arena');
    await b.frame.locator('#scene').click({ position: { x: toArena.sx, y: toArena.sy } });
    await b.frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Arena'), { timeout: 10000 });
    await b.page.waitForTimeout(500);
    await sendChat(b.frame, 'arena via polling');
    await waitForCondition(b.frame, () => document.querySelectorAll('#chatMessagesDomain .chat-line').length === 2, 'B\'s Domain tab to show both messages via polling', 8000);

    const bWorldAtArena = await chatWorldLines(b.frame);
    if (bWorldAtArena.length !== 1 || !bWorldAtArena[0].includes('arena via polling')) {
      throw new Error('Expected B\'s This World tab at Arena to show only the Arena message, got: ' + JSON.stringify(bWorldAtArena));
    }
    console.log('PASS: This World tab at Arena correctly filters to just the Arena message, over polling');

    await b.frame.locator('#chatTabDomainBtn').click();
    const bDomain = await chatDomainLines(b.frame);
    if (bDomain.length !== 2) throw new Error('Expected Domain tab to show both messages, got: ' + JSON.stringify(bDomain));
    console.log('PASS: Domain tab shows both messages over polling: ' + JSON.stringify(bDomain));

    console.log('\nALL CHAT POLLING FALLBACK CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await contextA.close().catch(() => {});
    await contextB.close().catch(() => {});
    serverProc.kill();
  }
})();
