// Manual end-to-end check for the DYNAMIC per-world chat tab list that
// replaced the old fixed This-World/Domain pair — one tab per declared
// chat scope (a leftmost "Domain" tab when manifest.chat is set, plus one
// tab per world.chat-opted-in world, labeled with that world's own name),
// the "(current)" suffix that tracks the visitor's actual live location,
// and sending being restricted to "Domain" or your own current-location
// tab even though every tab reads from the same domain-scoped stream.
//
// See demo-domain-a/.well-known/spatial.json (now BOTH domain-wide
// "chat": true AND per-world flags on plaza + arena — the "combined"
// case) and demo-domain-b/.well-known/spatial.json ("chat": true
// domain-wide only, its one world has no individual flag — a single
// "Domain" tab) for the demo content this drives against. Overlaps in
// spirit with manual-chat-capability-gate.js (which focuses on the
// opt-in gate itself: widget shown/hidden and which flags produce which
// tabs) — this file focuses on the tab list's own behavior once it's up:
// ordering, the "(current)" suffix, cross-tab message visibility, and the
// send-gate.
//
// Requires the demo issuer-servers and presence-server already running
// (this test does not start them itself):
//   node issuer-server/server.js                                    (8001)
//   PORT=8002 ATLAS_DOMAIN=localhost:8002 ATLAS_DOCROOT=demo-domain-b \
//     ATLAS_STATE_DIR=issuer-server/domain-b-state node issuer-server/server.js
//   node presence-server/server.js                                  (8004)
//
// Checks:
//   1. Domain B (domain-only, its one world has no individual flag) —
//      exactly one tab, "Domain", and it never carries a "(current)"
//      suffix (there's no dedicated world tab for one to attach to).
//   2. Domain A (combined case) — three tabs in order [Domain, Example
//      Plaza, Example Arena]; "Example Plaza" carries "(current)" on
//      arrival; a message sent while standing in Plaza (on Plaza's own,
//      sendable tab) shows up under BOTH "Example Plaza(current)" and
//      "Domain", but NOT under "Example Arena"; walking to Arena moves
//      the "(current)" suffix off Plaza and onto Arena.
//   3. Sending is disabled while viewing "Example Arena" (someone else's
//      world tab) while physically standing in Plaza — input disabled,
//      placeholder explains why — and re-enables immediately on
//      switching back to a sendable tab ("Example Plaza" or "Domain"),
//      with no need to leave and re-enter the world.
//   4. defaultTabPreference sets which tab a FRESH world entry opens on:
//      'domain' selects "Domain" over Plaza's own tab; 'world' selects
//      Plaza's own tab over "Domain" — proving the preference (not just
//      availability) drives the choice in both directions.
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
// See manual-chat-capability-gate.js's own comment on this exact helper
// for why retrying until a MATCHING portal appears (not just a non-empty
// list) is required — window.__atlasScene can still be the previous
// world's stale-but-non-empty portal list for a moment after placeLabel
// itself has already updated.
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

async function openOverlay(context, url, label, placeSubstring) {
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'load' });
  await page.locator('#domain-atlas-enter-btn').click();
  const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
  const frame = await frameHandle.contentFrame();
  await frame.waitForFunction((sub) => document.getElementById('placeLabel').textContent.includes(sub), placeSubstring, { timeout: 10000 });
  console.log('SETUP: ' + label + ' opened the overlay at ' + placeSubstring);
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
function chatTabIds(frame) {
  return frame.evaluate(() => Array.from(document.querySelectorAll('#chatTabBar [data-tab-id]')).map((el) => el.dataset.tabId));
}
// refreshChatAvailability() is async (it awaits AtlasWallet.getChatPanelSettings()
// before picking/rendering the initial tab), so the tab bar can still be
// empty for a moment right after placeLabel itself has already updated on
// a world entry — poll until at least one tab exists before asserting on
// the list's exact contents, same "wait for the real thing, not a fixed
// sleep" reasoning as every other race-prone wait in these manual tests.
async function waitForChatTabs(frame, timeoutMs = 8000) {
  const start = Date.now();
  for (;;) {
    const ids = await chatTabIds(frame);
    if (ids.length) return ids;
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for the chat tab bar to render any tabs');
    await new Promise((r) => setTimeout(r, 150));
  }
}
// Same race as waitForChatTabs() above, but for the ACTIVE tab specifically
// — refreshChatAvailability() re-renders the tab bar and only THEN settles
// on which tab is active, so polling until the expected id is active (or
// timing out) is more robust than a fixed sleep before reading it once.
async function waitForActiveChatTab(frame, expectedId, timeoutMs = 8000) {
  const start = Date.now();
  for (;;) {
    const id = await activeChatTabId(frame);
    if (id === expectedId) return id;
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for active tab to become ' + JSON.stringify(expectedId) + ' — last seen: ' + JSON.stringify(id));
    await new Promise((r) => setTimeout(r, 150));
  }
}
function chatTabLabels(frame) {
  return frame.evaluate(() => Array.from(document.querySelectorAll('#chatTabBar [data-tab-id]')).map((el) => el.textContent));
}
function activeChatTabId(frame) {
  return frame.evaluate(() => {
    const btn = document.querySelector('#chatTabBar [data-tab-id].active-subtab');
    return btn ? btn.dataset.tabId : null;
  });
}
async function clickChatTab(frame, tabId) {
  await frame.locator('#chatTabBar [data-tab-id="' + tabId + '"]').click();
}
function chatInputState(frame) {
  return frame.evaluate(() => ({
    disabled: document.getElementById('chatTextInput').disabled,
    placeholder: document.getElementById('chatTextInput').placeholder
  }));
}
// refreshChatSendability() lags slightly behind the tab becoming active on
// a fresh world entry: chatWorldId (what "your own tab" is compared
// against) is only set once connectChat() actually runs, a moment AFTER
// refreshChatAvailability() has already picked/rendered the active tab —
// see viewer.js's enterWorld() for the exact ordering. Poll for the
// expected disabled state instead of asserting on it immediately.
async function waitForSendable(frame, expectDisabled, timeoutMs = 8000) {
  const start = Date.now();
  for (;;) {
    const state = await chatInputState(frame);
    if (state.disabled === expectDisabled) return state;
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for chat input disabled=' + expectDisabled + ' — last state: ' + JSON.stringify(state));
    await new Promise((r) => setTimeout(r, 150));
  }
}
async function setDefaultTabPreference(frame, value) {
  await frame.locator('#chatSettingsBtn').click();
  await frame.waitForFunction(() => !document.getElementById('chatSettingsPopover').hidden, { timeout: 5000 });
  await frame.locator('#chatDefaultTabInput').selectOption(value);
  await frame.page().waitForTimeout(150);
  await frame.locator('#chatSettingsBtn').click();
  await frame.waitForFunction(() => document.getElementById('chatSettingsPopover').hidden, { timeout: 5000 });
}

(async () => {
  const dirA = path.resolve(__dirname, '.chrome-profile-chat-dyntabs-a');
  const dirB = path.resolve(__dirname, '.chrome-profile-chat-dyntabs-b');
  const launchOpts = { headless: false, executablePath: '/opt/pw-browsers/chromium', args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox'] };

  const contextA = await chromium.launchPersistentContext(dirA, launchOpts);
  const contextB = await chromium.launchPersistentContext(dirB, launchOpts);

  try {
    console.log('STEP 1: Domain B (domain-only, its one world has no individual flag) — exactly one tab, "Domain", never suffixed');
    const domB = await openOverlay(contextB, 'http://localhost:8002', 'Domain B visitor', 'Neighbor Workshop');
    await waitForChatTabs(domB.frame);
    let ids = await chatTabIds(domB.frame);
    if (JSON.stringify(ids) !== JSON.stringify(['domain'])) throw new Error('Expected exactly one tab (domain) at Domain B\'s Workshop, got: ' + JSON.stringify(ids));
    let labels = await chatTabLabels(domB.frame);
    if (labels[0] !== 'Domain') throw new Error('Expected the one tab labeled plain "Domain" with no "(current)" suffix, got: ' + JSON.stringify(labels));
    if ((await activeChatTabId(domB.frame)) !== 'domain') throw new Error('Expected "Domain" to be the (only) active tab at Domain B');
    console.log('PASS: Domain B shows exactly one, un-suffixed "Domain" tab');
    await domB.page.close();

    console.log('STEP 2: Domain A (combined case) — enter at Plaza, identity created so sending can be exercised');
    const a = await openOverlay(contextA, 'http://localhost:8001', 'Domain A visitor', 'Example Plaza');
    await waitForChatTabs(a.frame);
    await createIdentity(a.frame, 'chat-dyntabs-test-password');

    ids = await chatTabIds(a.frame);
    if (JSON.stringify(ids) !== JSON.stringify(['domain', 'world:plaza', 'world:arena'])) {
      throw new Error('Expected tab ids [domain, world:plaza, world:arena] at Plaza, got: ' + JSON.stringify(ids));
    }
    labels = await chatTabLabels(a.frame);
    if (labels[1] !== 'Example Plaza(current)') throw new Error('Expected "Example Plaza(current)" on arrival, got: ' + JSON.stringify(labels));
    if (labels[0] !== 'Domain' || labels[2] !== 'Example Arena') throw new Error('Expected Domain/Example Arena unsuffixed, got: ' + JSON.stringify(labels));
    if ((await activeChatTabId(a.frame)) !== 'world:plaza') throw new Error('Expected Plaza\'s own tab active by default on arrival');
    console.log('PASS: 3 tabs in the right order, Plaza correctly marked "(current)" and active');

    console.log('STEP 2b: send a message while standing in Plaza — appears under Plaza AND Domain, not under Arena');
    await sendChat(a.frame, 'plaza-scoped test message');
    await waitForCondition(a.frame, () => document.querySelectorAll('#chatMessages .chat-line').length === 1, 'Plaza\'s own tab to show the just-sent message');
    let lines = await chatLines(a.frame);
    if (!lines[0].includes('plaza-scoped test message')) throw new Error('Expected the message under "Example Plaza", got: ' + JSON.stringify(lines));

    await clickChatTab(a.frame, 'domain');
    await waitForCondition(a.frame, () => document.querySelectorAll('#chatMessages .chat-line').length === 1, 'Domain tab to also show the Plaza message');
    lines = await chatLines(a.frame);
    if (!lines[0].includes('plaza-scoped test message')) throw new Error('Expected the message under "Domain" too, got: ' + JSON.stringify(lines));

    await clickChatTab(a.frame, 'world:arena');
    await a.page.waitForTimeout(400); // let the tab-switch re-render settle — no message is EXPECTED to arrive here, so there's nothing to waitForCondition on
    lines = await chatLines(a.frame);
    if (lines.length !== 0) throw new Error('Expected "Example Arena" to show NO messages (the Plaza message is tagged world:plaza, not world:arena), got: ' + JSON.stringify(lines));
    console.log('PASS: a Plaza-sent message is visible under Plaza + Domain, correctly absent from Arena');

    console.log('STEP 3: sending is disabled while viewing "Example Arena" (not your location, not Domain) — re-enables on switching back');
    let inputState = await chatInputState(a.frame);
    if (!inputState.disabled) throw new Error('Expected chat input DISABLED while viewing Arena\'s tab from Plaza, got enabled with placeholder: ' + JSON.stringify(inputState.placeholder));
    if (!/switch/i.test(inputState.placeholder)) throw new Error('Expected the placeholder to explain why sending is disabled, got: ' + JSON.stringify(inputState.placeholder));
    console.log('PASS: input disabled with an explanatory placeholder while browsing a non-sendable tab: ' + JSON.stringify(inputState.placeholder));

    await clickChatTab(a.frame, 'world:plaza');
    inputState = await chatInputState(a.frame);
    if (inputState.disabled) throw new Error('Expected chat input RE-ENABLED immediately after switching back to Plaza\'s own tab, got disabled');
    console.log('PASS: switching back to the current-location tab re-enables sending immediately, no world re-entry needed');

    await clickChatTab(a.frame, 'domain');
    inputState = await chatInputState(a.frame);
    if (inputState.disabled) throw new Error('Expected chat input enabled on the Domain tab too (always sendable), got disabled');
    console.log('PASS: Domain tab is sendable too, as expected');

    console.log('STEP 4: walk Plaza -> Arena — "(current)" suffix moves from Plaza to Arena, and Arena\'s own tab becomes sendable in turn');
    const toArena = await waitForPortal(a.frame, (p) => p.to === 'arena', 'the Arena portal from Plaza');
    await a.frame.locator('#scene').click({ position: { x: toArena.sx, y: toArena.sy } });
    await a.frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Arena'), { timeout: 10000 });
    await waitForActiveChatTab(a.frame, 'world:arena');
    labels = await chatTabLabels(a.frame);
    if (labels[1] !== 'Example Plaza') throw new Error('Expected "Example Plaza" to lose its "(current)" suffix at Arena, got: ' + JSON.stringify(labels));
    if (labels[2] !== 'Example Arena(current)') throw new Error('Expected "Example Arena" to gain the "(current)" suffix, got: ' + JSON.stringify(labels));
    if ((await activeChatTabId(a.frame)) !== 'world:arena') throw new Error('Expected Arena\'s own tab to become active on arrival (defaultTabPreference is still "auto"/"world")');
    await waitForSendable(a.frame, false); // sending enabled by default on arrival at Arena (its own, current-location tab)
    await clickChatTab(a.frame, 'world:plaza');
    inputState = await chatInputState(a.frame);
    if (!inputState.disabled) throw new Error('Expected sending now DISABLED on Plaza\'s tab, since the visitor is physically in Arena now');
    console.log('PASS: "(current)" suffix and the send-gate both correctly follow the visitor\'s live location');
    await clickChatTab(a.frame, 'world:arena'); // leave the panel on a sendable tab before the walk below

    console.log('STEP 5: defaultTabPreference — "domain" selects Domain over Plaza\'s own tab on a fresh entry; "world" selects Plaza\'s own tab over Domain');
    const arenaBackToPlaza = await waitForPortal(a.frame, (p) => p.to === 'plaza', 'the Plaza portal from Arena');
    await a.frame.locator('#scene').click({ position: { x: arenaBackToPlaza.sx, y: arenaBackToPlaza.sy } });
    await a.frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });

    await setDefaultTabPreference(a.frame, 'domain');
    const toArena2 = await waitForPortal(a.frame, (p) => p.to === 'arena', 'the Arena portal from Plaza (2nd time)');
    await a.frame.locator('#scene').click({ position: { x: toArena2.sx, y: toArena2.sy } });
    await a.frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Arena'), { timeout: 10000 });
    const arenaBackToPlaza2 = await waitForPortal(a.frame, (p) => p.to === 'plaza', 'the Plaza portal from Arena (2nd time)');
    await a.frame.locator('#scene').click({ position: { x: arenaBackToPlaza2.sx, y: arenaBackToPlaza2.sy } });
    await a.frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    await waitForActiveChatTab(a.frame, 'domain');
    console.log('PASS: "domain" preference selects Domain on fresh entry, even though Plaza has its own tab too');

    await setDefaultTabPreference(a.frame, 'world');
    const toArena3 = await waitForPortal(a.frame, (p) => p.to === 'arena', 'the Arena portal from Plaza (3rd time)');
    await a.frame.locator('#scene').click({ position: { x: toArena3.sx, y: toArena3.sy } });
    await a.frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Arena'), { timeout: 10000 });
    const arenaBackToPlaza3 = await waitForPortal(a.frame, (p) => p.to === 'plaza', 'the Plaza portal from Arena (3rd time)');
    await a.frame.locator('#scene').click({ position: { x: arenaBackToPlaza3.sx, y: arenaBackToPlaza3.sy } });
    await a.frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    await waitForActiveChatTab(a.frame, 'world:plaza');
    console.log('PASS: "world" preference selects the current-world tab on fresh entry, even though Domain is available too');

    console.log('\nALL DYNAMIC CHAT TAB CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await contextA.close().catch(() => {});
    await contextB.close().catch(() => {});
  }
})();
