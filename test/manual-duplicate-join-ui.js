// Manual end-to-end check for task #137's ACTUAL UI (#192's modal), closing
// a real gap found while auditing #193/#194: every existing duplicate-join
// test — manual-duplicate-identity-join.js (Node) and
// manual-duplicate-identity-join-php.js (PHP) — talks to the server directly
// over raw WebSocket/fetch, never through a real browser. That's thorough
// coverage of the PROTOCOL, but nobody had ever actually clicked
// #duplicateJoinKeepBtn/#duplicateJoinLeaveBtn in a live extension, or
// watched #presenceJoinWaitingHint/#presenceTransientHint actually appear.
// This script drives the real modal instead, using presence-server (the
// primary WebSocket transport every demo domain actually uses by default —
// see PRESENCE_DEFAULT_BASE in viewer.js). It deliberately does NOT re-run
// this same UI against presence-php: viewer.js's own client code
// (sendDuplicateJoinResponse/handleIncomingSignal/connectPresence's
// fallback) branches on whichever transport is live using the exact same
// functions either way, and the polling PROTOCOL itself is already
// independently verified end-to-end against presence-php by
// manual-duplicate-identity-join-php.js — so this test's job is narrower
// and different: prove the real DOM/UI wiring actually works at all, for
// either transport, not re-prove the protocol a third time.
//
// Two real browser contexts share ONE identity (created in A via
// AtlasWallet.createIdentity() directly, exported, then imported into B via
// AtlasWallet.importIdentity() directly — bypassing the onboarding UI's own
// file-picker mechanics on purpose, since that flow already has its own
// dedicated test (task #10) and isn't what this script is checking).
//
// Requires issuer-server on 8001 (Plaza/Lobby's manifest) — this script
// starts its own throwaway presence-server on 8004 (the real default port
// viewer.js falls back to) with ACTIVITY_IDLE_MS/DUPLICATE_JOIN_COUNTDOWN_MS
// shrunk via env, same convention as every other manual-*.js protocol test.
//
// Checks:
//   1. A joins the Lobby alone under a real identity.
//   2. B joins the SAME Lobby under the SAME identity while A is still
//      fresh/active — A's REAL #duplicateJoinModal opens with a ticking
//      countdown, and B's REAL #presenceJoinWaitingHint shows.
//   3. A clicks "Keep this session active" for real — A's modal closes,
//      A stays completely undisturbed, and B's REAL #presenceTransientHint
//      shows the "chose to stay" denial message; B never gets a presence
//      connection (window.__atlasPresenceOwnId stays unset).
//   4. B retries (leaves and re-enters the Lobby) — a fresh challenge opens
//      A's modal again. This time A clicks "Leave now" for real — B's join
//      completes (finishJoin fires, window.__atlasPresenceOwnId gets set),
//      and A gets evicted with its own REAL #presenceTransientHint showing
//      the "another session connected" message.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { spawn } = require('child_process');
const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const PRESENCE_PORT = 8004; // PRESENCE_DEFAULT_BASE in viewer.js — must match exactly, not an isolated port like the protocol-level tests use
const ACTIVITY_IDLE_MS = 5000; // generous enough that real Playwright round trips never make A look stale by accident
const DUPLICATE_JOIN_COUNTDOWN_MS = 3000;

async function projectPortals(frame) {
  return frame.evaluate(() => new Promise((resolve) => {
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
  }));
}

async function enterPlaza(context, label) {
  const page = await context.newPage();
  await page.goto('http://localhost:8001', { waitUntil: 'load' });
  await page.locator('#domain-atlas-enter-btn').click();
  const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
  const frame = await frameHandle.contentFrame();
  await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
  console.log('SETUP: ' + label + ' entered Plaza');
  return { page, frame };
}

async function walkToLobby(frame, label) {
  const portals = await projectPortals(frame);
  const toLobby = portals.find((p) => p.to === 'lobby');
  await frame.locator('#scene').click({ position: { x: toLobby.sx, y: toLobby.sy } });
  await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Lobby'), { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 300)); // let presence's connect actually settle, same pacing manual-multiplayer-presence.js uses
  console.log('SETUP: ' + label + ' walked into the Lobby');
}

async function waitForCondition(frame, fn, description, timeoutMs = 8000) {
  const start = Date.now();
  for (;;) {
    const result = await frame.evaluate(fn);
    if (result) return result;
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for: ' + description);
    await new Promise((r) => setTimeout(r, 150));
  }
}

(async () => {
  console.log('SETUP: starting a throwaway presence-server on the REAL default port 8004, timers shrunk');
  const presenceProc = spawn('node', ['presence-server/server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(PRESENCE_PORT), ACTIVITY_IDLE_MS: String(ACTIVITY_IDLE_MS), DUPLICATE_JOIN_COUNTDOWN_MS: String(DUPLICATE_JOIN_COUNTDOWN_MS) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('presence-server did not start in time')), 5000);
    presenceProc.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); resolve(); } });
    presenceProc.on('exit', (code) => reject(new Error('presence-server exited early with code ' + code)));
  });
  console.log('PASS: presence-server up on port ' + PRESENCE_PORT + ' (requires issuer-server already running on 8001)');

  const dirA = path.resolve(__dirname, '.chrome-profile-dupjoin-ui-a');
  const dirB = path.resolve(__dirname, '.chrome-profile-dupjoin-ui-b');
  const launchOpts = { headless: false, executablePath: '/opt/pw-browsers/chromium', args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox'] };
  const contextA = await chromium.launchPersistentContext(dirA, launchOpts);
  const contextB = await chromium.launchPersistentContext(dirB, launchOpts);

  try {
    const a = await enterPlaza(contextA, 'A');
    const b = await enterPlaza(contextB, 'B');

    console.log('STEP 0: give A and B the SAME real identity — created in A, exported, imported into B, bypassing the onboarding file-picker UI on purpose (not what this script tests)');
    const PASSWORD = 'dupjoin-ui-test-password';
    const created = await a.frame.evaluate(async (password) => {
      const { publicKey, seedPhrase } = await AtlasWallet.createIdentity(password);
      return { publicKey, seedPhrase };
    }, PASSWORD);
    const exported = await a.frame.evaluate(async ({ password, seedPhrase }) => AtlasWallet.exportIdentity(password, seedPhrase), { password: PASSWORD, seedPhrase: created.seedPhrase });
    await b.frame.evaluate(async ({ exported, password, seedPhrase }) => AtlasWallet.importIdentity(exported, password, seedPhrase), { exported, password: PASSWORD, seedPhrase: created.seedPhrase });
    const bIdentity = await b.frame.evaluate(() => AtlasWallet.getIdentity());
    if (!bIdentity || bIdentity.publicKey !== created.publicKey) throw new Error('Expected B to now hold the SAME identity as A, got: ' + JSON.stringify(bIdentity));
    console.log('PASS: A and B share one real identity ->', created.publicKey.slice(0, 16) + '…');

    console.log('STEP 1: A walks into the Lobby alone under this identity');
    await walkToLobby(a.frame, 'A');
    await waitForCondition(a.frame, () => typeof window.__atlasPresenceOwnId === 'string', 'A to have a real presence connection id');
    console.log('PASS: A connected to presence in the Lobby ->', await a.frame.evaluate(() => window.__atlasPresenceOwnId));

    console.log('STEP 2: B walks into the SAME Lobby under the SAME identity — A\'s REAL modal should open, B\'s REAL waiting hint should show');
    await walkToLobby(b.frame, 'B');
    await waitForCondition(a.frame, () => document.getElementById('duplicateJoinModal').classList.contains('active'), "A's #duplicateJoinModal to open");
    const countdownText = await a.frame.locator('#duplicateJoinCountdown').textContent();
    if (!countdownText || Number(countdownText) <= 0) throw new Error('Expected a positive ticking countdown on A\'s modal, got: "' + countdownText + '"');
    await waitForCondition(b.frame, () => document.getElementById('presenceJoinWaitingHint').classList.contains('active'), "B's #presenceJoinWaitingHint to show");
    console.log('PASS: A\'s real modal opened (countdown="' + countdownText + '"), B\'s real waiting hint is showing');

    console.log('STEP 3: A clicks "Keep this session active" for real — B gets denied, A is undisturbed');
    const aIdBeforeKeep = await a.frame.evaluate(() => window.__atlasPresenceOwnId);
    await a.frame.locator('#duplicateJoinKeepBtn').click();
    await waitForCondition(a.frame, () => !document.getElementById('duplicateJoinModal').classList.contains('active'), "A's modal to close after Keep");
    await waitForCondition(b.frame, () => document.getElementById('presenceTransientHint').classList.contains('active'), "B's #presenceTransientHint to show the denial");
    const bHintText = await b.frame.locator('#presenceTransientHint').textContent();
    if (!bHintText.includes('chose to stay')) throw new Error('Expected B\'s hint to explain the denial, got: "' + bHintText + '"');
    const bOwnIdAfterDeny = await b.frame.evaluate(() => window.__atlasPresenceOwnId);
    if (bOwnIdAfterDeny) throw new Error('Expected B to still have NO presence connection after being denied, got id: ' + bOwnIdAfterDeny);
    const aIdAfterKeep = await a.frame.evaluate(() => window.__atlasPresenceOwnId);
    if (aIdAfterKeep !== aIdBeforeKeep) throw new Error('Expected "Keep" to leave A\'s own connection completely untouched, id changed from ' + aIdBeforeKeep + ' to ' + aIdAfterKeep);
    console.log('PASS: "Keep" really denied B ("' + bHintText + '") and left A\'s own connection exactly as it was');

    console.log('STEP 4: B retries (fresh challenge) — this time A clicks "Leave now" for real, B\'s join completes, A gets evicted');
    await b.page.goto('http://localhost:8001', { waitUntil: 'load' }); // simplest way to get a genuinely fresh join attempt from B
    await b.page.locator('#domain-atlas-enter-btn').click();
    const bFrameHandle2 = await b.page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const bFrame2 = await bFrameHandle2.contentFrame();
    await bFrame2.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    await walkToLobby(bFrame2, 'B (retry)');
    await waitForCondition(a.frame, () => document.getElementById('duplicateJoinModal').classList.contains('active'), "A's #duplicateJoinModal to open a SECOND time for B's retry");
    console.log('PASS: B\'s retry opened a fresh challenge on A');

    await a.frame.locator('#duplicateJoinLeaveBtn').click();
    await waitForCondition(bFrame2, () => typeof window.__atlasPresenceOwnId === 'string', "B's retry to actually finish joining after A yields");
    await waitForCondition(a.frame, () => document.getElementById('presenceTransientHint').classList.contains('active'), "A's #presenceTransientHint to show the eviction notice");
    const aEvictedHintText = await a.frame.locator('#presenceTransientHint').textContent();
    if (!aEvictedHintText.includes('another session')) throw new Error('Expected A\'s eviction hint to mention another session connecting, got: "' + aEvictedHintText + '"');
    console.log('PASS: "Leave now" really completed B\'s join (id=' + (await bFrame2.evaluate(() => window.__atlasPresenceOwnId)) + ') and evicted A ("' + aEvictedHintText + '")');

    console.log('\nALL DUPLICATE-JOIN UI CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await contextA.close();
    await contextB.close();
    presenceProc.kill();
  }
})();
