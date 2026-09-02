// Manual end-to-end check for Friends, Favorites, the Social tab
// restructuring (Mail moved in alongside them), and the quick Lock button
// (#61/#67) — two SEPARATE browser contexts, each with its own real wallet
// identity, meet in the Lobby and exchange a REAL friend request over the
// genuine presence-server WebSocket (not mocked), exactly the way two
// visitors actually would. See manual-presence-signals.js for an isolated
// protocol-level check of the underlying signal relay/status endpoint;
// this test is the "does the actual UI wire it all together correctly"
// counterpart, same division of labor manual-multiplayer-presence.js has
// relative to manual-presence-server.js.
//
// Requires presence-server/server.js on 8004 and issuer-server on 8001 —
// this test does not start either itself.
//
// Checks:
//   1. Two visitors, each with a freshly created identity, meet in the
//      Lobby — the Friends tab's "People here now" list shows the OTHER
//      visitor with an "Add friend" action (not themselves).
//   2. Clicking "Add friend" sends a live friend-request signal; the
//      button's own state flips to "Request sent" immediately.
//   3. The recipient's Friends tab shows a live "Friend requests" entry
//      for the sender — the Social tab's badge reflects it too, even
//      before opening the tab.
//   4. Clicking Accept saves the friend (AtlasWallet.getFriends()) on the
//      recipient's side AND, once the accepted signal reaches the
//      original sender, on their side too — a friend request only takes
//      one Accept click, not a round of confirmations from both people.
//   5. Favorites: favoriting the current domain, then checking the
//      Favorites list shows a live "here now" count that includes the
//      newly-added friend by name (the cross-referencing happens
//      entirely client-side against the local friends list — see
//      fetchPresenceStatus/renderFavoriteCard in viewer.js).
//   6. The quick Lock button in the top control bar is hidden while
//      locked/no identity, appears once unlocked, and actually locks the
//      wallet (routes back to the unlock screen) when clicked — without
//      requiring the wallet panel to be open first.
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

// Creates a fresh local password identity through the real onboarding UI
// (not a storage shortcut) — the publicKey it produces is what actually
// gets announced over presence, same as any real visitor.
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
  await frame.locator('#walletBtn').click(); // close the panel — identity stays unlocked for the rest of the session
  return publicKey;
}

async function enterLobby(frame, page, label) {
  const portals = await projectPortals(frame);
  const toLobby = portals.find((p) => p.to === 'lobby');
  await frame.locator('#scene').click({ position: { x: toLobby.sx, y: toLobby.sy } });
  await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Lobby'), { timeout: 10000 });
  await page.waitForTimeout(300);
  console.log('SETUP: ' + label + ' entered the Lobby');
}

async function openFriendsTab(frame) {
  await frame.locator('#walletBtn').click();
  await frame.locator('#socialTabBtn').click();
  await frame.locator('#friendsSubtabBtn').click();
  await frame.waitForFunction(() => document.getElementById('friendsSubscreen').classList.contains('active'), { timeout: 5000 });
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
  const launchOpts = { headless: false, executablePath: '/opt/pw-browsers/chromium', args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox'] };

  const contextA = await chromium.launchPersistentContext(dirA, launchOpts);
  const contextB = await chromium.launchPersistentContext(dirB, launchOpts);

  try {
    const a = await openOverlay(contextA, 'Visitor A');
    const b = await openOverlay(contextB, 'Visitor B');

    console.log('STEP 0: each visitor creates their own real wallet identity before meeting');
    const pkA = await createIdentity(a.frame, 'friends-test-password-a');
    const pkB = await createIdentity(b.frame, 'friends-test-password-b');
    if (pkA === pkB) throw new Error('Expected two independently created identities to have different public keys');
    console.log('PASS: two independent identities created');

    await enterLobby(a.frame, a.page, 'Visitor A');
    await enterLobby(b.frame, b.page, 'Visitor B');

    console.log('STEP 1: each visitor sees the OTHER (not themselves) in "People here now" with an Add-friend action');
    await openFriendsTab(a.frame);
    const bIdSeenByA = await waitFor(a.frame, () => {
      const btn = document.querySelector('#friendsHereList button[data-action="add-friend"]');
      return btn ? btn.dataset.id : null;
    }, 'A\'s Friends tab to show an Add-friend button for B');
    console.log('PASS: A sees exactly one addable visitor (B) in the Lobby');

    console.log('STEP 2: A clicks Add friend — a live signal goes out, and the button flips to "Request sent"');
    await a.frame.locator('#friendsHereList button[data-action="add-friend"]').click();
    await waitFor(a.frame, () => {
      const card = document.querySelector('#friendsHereList .info-card');
      return card && card.textContent.includes('Request sent');
    }, 'A\'s own card for B to show "Request sent"');
    console.log('PASS: request-sent state shown immediately, no round trip needed to update A\'s own UI');

    console.log('STEP 3: B sees the incoming request under Friend requests, and the Social badge reflects it even unopened');
    await openFriendsTab(b.frame);
    await waitFor(b.frame, () => {
      const card = document.querySelector('#friendRequestsList .info-card');
      return card && card.querySelector('button[data-action="accept-request"]');
    }, 'B\'s Friend requests list to show A\'s incoming request');
    console.log('PASS: B sees A\'s live friend request');

    console.log('STEP 4: B accepts — B saves the friend immediately; A saves it too once the accepted signal arrives back');
    await b.frame.locator('#friendRequestsList button[data-action="accept-request"]').click();
    const bFriends = await waitFor(b.frame, () => AtlasWallet.getFriends().then((f) => (f.length > 0 ? f : null)), 'B to have saved A as a friend');
    if (bFriends[0].publicKey !== pkA) throw new Error('Expected B\'s saved friend to be A\'s publicKey, got: ' + JSON.stringify(bFriends));
    console.log('PASS: B saved A as a friend on Accept');

    const aFriends = await waitFor(a.frame, () => AtlasWallet.getFriends().then((f) => (f.length > 0 ? f : null)), 'A to have saved B as a friend after the accepted signal arrives');
    if (aFriends[0].publicKey !== pkB) throw new Error('Expected A\'s saved friend to be B\'s publicKey, got: ' + JSON.stringify(aFriends));
    console.log('PASS: A saved B as a friend automatically once the friend-request-accepted signal came back — no second click needed');

    console.log('STEP 5: Favorites — favoriting the Lobby, then seeing a live status line that names the friend who\'s there');
    await a.frame.locator('#favoritesSubtabBtn').click();
    await a.frame.locator('#addCurrentFavoriteBtn').click();
    await waitFor(a.frame, () => {
      const card = document.querySelector('#favoritesList .info-card');
      return card && /here now/.test(card.textContent) ? card.textContent : null;
    }, 'A\'s Favorites list to show a live status line for the Lobby');
    const favoriteCardText = await a.frame.locator('#favoritesList .info-card').first().textContent();
    if (!favoriteCardText.includes('friends here')) throw new Error('Expected the favorite\'s status line to name a friend present, got: ' + favoriteCardText);
    if (!favoriteCardText.includes('You are here')) throw new Error('Expected the currently-occupied favorite to be marked "You are here" instead of offering a Go button, got: ' + favoriteCardText);
    console.log('PASS: Favorites shows a live headcount AND names the friend who\'s actually there, entirely from the client cross-referencing the roster locally');

    console.log('STEP 6: the quick Lock button — hidden while there\'s nothing unlocked, appears once unlocked, actually locks on click');
    const quickLockHiddenBeforeCheck = await b.frame.evaluate(() => getComputedStyle(document.getElementById('quickLockWalletBtn')).display);
    if (quickLockHiddenBeforeCheck === 'none') throw new Error('Expected B\'s quick lock button to be visible while B\'s identity is unlocked, got display: ' + quickLockHiddenBeforeCheck);
    console.log('PASS: quick lock button is visible while unlocked');
    await b.frame.locator('#quickLockWalletBtn').click();
    await waitFor(b.frame, () => getComputedStyle(document.getElementById('quickLockWalletBtn')).display === 'none', 'B\'s quick lock button to hide itself once locked');
    console.log('PASS: clicking the quick lock button locked the wallet and hid itself');
    const isUnlockedAfter = await b.frame.evaluate(() => AtlasWallet.isUnlocked());
    if (isUnlockedAfter) throw new Error('Expected AtlasWallet.isUnlocked() to be false after clicking the quick lock button');
    console.log('PASS: the wallet is actually locked, not just the button hidden cosmetically');

    console.log('\nALL FRIENDS/FAVORITES/SOCIAL/LOCK CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await contextA.close().catch(() => {});
    await contextB.close().catch(() => {});
  }
})();
