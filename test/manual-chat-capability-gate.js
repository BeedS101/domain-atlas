// Manual end-to-end check for the chat capability opt-in gate (#111/#112),
// the DYNAMIC per-world tab list that replaced the old fixed This-World/
// Domain pair, and the default-tab-preference setting (#113, revised for
// that dynamic list).
//
// A domain still has to opt in via the same two implementation-only
// manifest fields (same category as the existing `presence`/`postOffice`
// fields, not part of SPEC.md): `manifest.chat === true` turns chat on for
// every world in the domain, and an individual `world.chat === true` turns
// it on for just that one world. What changed is what the widget shows
// once it's on: instead of a fixed "This World"/"Domain" pair, the tab bar
// now has one button per declared scope — a leftmost "Domain" tab only
// when manifest.chat is set, then one tab per world.chat-opted-in world
// (labeled with that world's own name, in manifest.worlds order), each
// carrying data-tab-id ('domain', or 'world:<id>') so they can be selected
// reliably regardless of how many exist. See demo-domain-a/.well-known/
// spatial.json (now BOTH domain-wide `"chat": true` AND per-world flags on
// plaza + arena — the "combined" case: Domain, Example Plaza, Example
// Arena, with market/museum/lobby reachable only via Domain, no tab of
// their own) and demo-domain-b/.well-known/spatial.json (`"chat": true`
// domain-wide only, its one world "workshop" has no individual flag — a
// single "Domain" tab, nothing else) for the demo content this drives
// against.
//
// NOTE on coverage: demo-domain-a used to have NO domain-wide flag, so
// this file used to be able to demonstrate the chat widget being hidden
// OUTRIGHT (not just short a tab) for an opted-out world (Market, at the
// time). Making Domain A domain-wide (this same round of work) means
// every world in Domain A now has chat enabled one way or another, so
// that "fully hidden" scenario is no longer reachable from EITHER demo
// domain's current content — chatEnabledForWorld() returning false is
// still exactly the same one-line check it always was (see viewer.js),
// just not exercised live by this test file any more. Reviewed by
// inspection instead; not a functional gap this round introduced.
//
// This is a pure client-side gate — a UX/product opt-in layer, not a
// security boundary. Nothing on presence-server or presence-php enforces
// it; a "domain" is still just whatever the client claims when it joins a
// room, same as presence itself.
//
// Requires all three demo backends already running:
//   node issuer-server/server.js                                    (8001)
//   PORT=8002 ATLAS_DOMAIN=localhost:8002 ATLAS_DOCROOT=demo-domain-b \
//     ATLAS_STATE_DIR=issuer-server/domain-b-state node issuer-server/server.js
//   node presence-server/server.js                                  (8004)
// This test does not start any of them itself (same convention as
// manual-multiplayer-presence.js and manual-postoffice-manifest-join.js).
//
// Checks:
//   1. Plaza (world.chat: true, AND domain-wide manifest.chat: true) —
//      widget shows, exactly 3 tabs in order [Domain, Example Plaza,
//      Example Arena], "Example Plaza" carries the "(current)" suffix
//      (default defaultTabPreference is 'auto', which now behaves as
//      'world' — see below), and it's the initially-active tab.
//   2. Market (neither flag set individually, but domain-wide IS set) —
//      widget still shows (the domain-wide flag cascades to every world),
//      and the tab LIST is the exact same domain-manifest-wide set as
//      everywhere else in Domain A (tabs are declared once per manifest,
//      not scoped to which world you happen to be standing in — see
//      computeChatTabs() in viewer.js) — but since Market has no
//      dedicated tab of its own, none of them carries a "(current)"
//      suffix, and the default selection falls back to "Domain" (there's
//      no own-location tab to prefer instead). This is the "reachable
//      only via Domain" case the task's own demo-content description
//      calls out for Market/Museum/Lobby.
//   3. Back to Plaza — all 3 tabs return, "(current)" suffix back on
//      "Example Plaza".
//   4. Walk to Arena — same 3 tabs, but the "(current)" suffix has moved
//      from "Example Plaza" to "Example Arena", proving it tracks the
//      visitor's actual location live, not just at first load.
//   5. Walk to Neighbor Workshop (Domain B: manifest.chat: true, its one
//      world has no individual flag) — exactly ONE tab, "Domain", and
//      that tab carries NO "(current)" suffix at all (workshop has no
//      dedicated tab of its own for the suffix to attach to) — this is
//      the single-tab scenario the task calls out as expected, not a bug.
//   6. defaultTabPreference = 'domain' — back at Plaza (which has both a
//      "Domain" tab and its own "Example Plaza" tab, so the preference
//      actually has a choice to make), re-entering selects "Domain" even
//      though "Example Plaza" is also available.
//   7. defaultTabPreference = 'world' — re-entering Plaza again selects
//      "Example Plaza" (its own tab) even though "Domain" is available
//      too, proving the preference — not just availability — drives the
//      choice in both directions.
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

// projectPortals() reads window.__atlasScene fresh each call, but
// window.__atlasScene itself is only overwritten once the NEW world's
// scene.json fetch resolves — placeLabel updates synchronously well
// before that fetch even starts (see enterWorld() in viewer.js). So a
// projectPortals() call right after a placeLabel wait can still see the
// PREVIOUS world's stale (but non-empty, so its own "wait for non-empty"
// doesn't help) portal list. Retrying until a portal matching `predicate`
// actually shows up sidesteps that race without hardcoding per-world
// portal counts or fixed sleeps. IMPORTANT: `predicate` has to be specific
// enough to reject the previous world's stale data outright — e.g. both
// Plaza and Workshop each have exactly one `kind === 'domain'` portal, so
// a predicate that only checks `kind` can "match" stale data from
// whichever of the two was current a moment ago; matching on `to` as well
// (the actual target domain) is what makes a match trustworthy.
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

function chatWidgetVisible(frame) {
  return frame.evaluate(() => getComputedStyle(document.getElementById('chatWidget')).display !== 'none');
}
// Reads the dynamic tab bar's current [data-tab-id] buttons — ids (in DOM
// order, which is the order refreshChatAvailability() built them in — see
// computeChatTabs() in viewer.js) and their visible labels (including any
// "(current)" suffix) separately, since different checks below care about
// one or the other.
function chatTabIds(frame) {
  return frame.evaluate(() => Array.from(document.querySelectorAll('#chatTabBar [data-tab-id]')).map((el) => el.dataset.tabId));
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
// refreshChatAvailability() is async (it awaits AtlasWallet.getChatPanelSettings()
// before picking/rendering the initial tab), so a fixed sleep after a world
// transition is a race — poll until the ACTIVE tab actually becomes the
// expected one (or time out) instead.
async function waitForActiveChatTab(frame, expectedId, timeoutMs = 8000) {
  const start = Date.now();
  for (;;) {
    const id = await activeChatTabId(frame);
    if (id === expectedId) return id;
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for active tab to become ' + JSON.stringify(expectedId) + ' — last seen: ' + JSON.stringify(id));
    await new Promise((r) => setTimeout(r, 150));
  }
}
async function setDefaultTabPreference(frame, value) {
  // Exercises the real settings-popover UI, same as a visitor would use it
  // — not a direct AtlasWallet call — since #113 asks for this control to
  // be wired the same way the existing opacity/text-size inputs are.
  await frame.locator('#chatSettingsBtn').click();
  await frame.waitForFunction(() => !document.getElementById('chatSettingsPopover').hidden, { timeout: 5000 });
  await frame.locator('#chatDefaultTabInput').selectOption(value);
  await frame.page().waitForTimeout(150); // let the change handler's setChatPanelSettings()/applyChatPanelSize() round-trip settle
  // Close the popover again — left open, it sits (z-index 8) directly over
  // part of the canvas near the chat widget's corner, which can silently
  // eat a later portal click aimed at a marker that happens to project
  // into that same screen region instead of ever reaching the canvas.
  await frame.locator('#chatSettingsBtn').click();
  await frame.waitForFunction(() => document.getElementById('chatSettingsPopover').hidden, { timeout: 5000 });
}

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-chat-gate');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  });

  try {
    const page = await context.newPage();
    await page.goto('http://localhost:8001', { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    await waitForActiveChatTab(frame, 'world:plaza'); // initial page load — same async-settle race as every later world entry

    console.log('STEP 1: Plaza (own flag + domain-wide flag) — widget shows, 3 tabs [Domain, Example Plaza, Example Arena], "Example Plaza" is current+active');
    if (!(await chatWidgetVisible(frame))) throw new Error('Expected chat widget visible at Plaza');
    let ids = await chatTabIds(frame);
    if (JSON.stringify(ids) !== JSON.stringify(['domain', 'world:plaza', 'world:arena'])) {
      throw new Error('Expected tab ids [domain, world:plaza, world:arena] at Plaza, got: ' + JSON.stringify(ids));
    }
    let labels = await chatTabLabels(frame);
    if (labels[1] !== 'Example Plaza(current)') throw new Error('Expected "Example Plaza(current)" as the 2nd tab label, got: ' + JSON.stringify(labels));
    if (labels[0] !== 'Domain' || labels[2] !== 'Example Arena') throw new Error('Expected the other two tabs unsuffixed, got: ' + JSON.stringify(labels));
    if ((await activeChatTabId(frame)) !== 'world:plaza') throw new Error('Expected "Example Plaza" (world:plaza) to be the initially-active tab at Plaza');
    console.log('PASS: Plaza shows all 3 declared tabs, correctly ordered, suffixed, and defaulted');

    console.log('STEP 2: Market (neither flag set individually, domain-wide IS set) — widget shows; tab LIST is the same domain-manifest-wide set (tabs are declared per-manifest, not scoped to which world you happen to be standing in), but Market has no dedicated tab of its own to be "(current)", so nothing is suffixed and the default falls back to Domain');
    const toMarket = await waitForPortal(frame, (p) => p.to === 'market', 'the Market portal from Plaza');
    await frame.locator('#scene').click({ position: { x: toMarket.sx, y: toMarket.sy } });
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Trading Post'), { timeout: 10000 });
    await waitForActiveChatTab(frame, 'domain'); // let refreshChatAvailability() settle (it's async — see that helper's own comment)
    if (!(await chatWidgetVisible(frame))) throw new Error('Expected chat widget VISIBLE at Market — domain-wide manifest.chat cascades even though Market has no individual flag');
    ids = await chatTabIds(frame);
    if (JSON.stringify(ids) !== JSON.stringify(['domain', 'world:plaza', 'world:arena'])) {
      throw new Error('Expected the SAME 3 domain-manifest-wide tabs at Market as anywhere else in Domain A (tabs come from manifest.worlds, not from where you\'re standing), got: ' + JSON.stringify(ids));
    }
    labels = await chatTabLabels(frame);
    if (labels.some((l) => l.includes('(current)'))) throw new Error('Expected NO tab suffixed "(current)" at Market — it has no dedicated tab of its own, got: ' + JSON.stringify(labels));
    if ((await activeChatTabId(frame)) !== 'domain') throw new Error('Expected "Domain" to be selected by default at Market — it has no own-world tab to prefer instead');
    console.log('PASS: Market sees the full domain-wide tab list (reachable only via Domain, per the task\'s own framing — no tab of its own), correctly un-suffixed, defaulting to Domain');

    console.log('STEP 3: back to Plaza — all 3 tabs return, "Example Plaza" current+active again');
    const backToPlaza = await waitForPortal(frame, (p) => p.to === 'plaza', 'the Plaza portal from Market');
    await frame.locator('#scene').click({ position: { x: backToPlaza.sx, y: backToPlaza.sy } });
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    await waitForActiveChatTab(frame, 'world:plaza');
    ids = await chatTabIds(frame);
    if (JSON.stringify(ids) !== JSON.stringify(['domain', 'world:plaza', 'world:arena'])) throw new Error('Expected all 3 tabs back at Plaza, got: ' + JSON.stringify(ids));
    labels = await chatTabLabels(frame);
    if (labels[1] !== 'Example Plaza(current)') throw new Error('Expected "Example Plaza(current)" again back at Plaza, got: ' + JSON.stringify(labels));
    console.log('PASS: tab list and "(current)" suffix both reappear correctly at a world that opts back in');

    console.log('STEP 4: walk Plaza -> Arena — same 3 tabs, but "(current)" MOVES from Example Plaza to Example Arena');
    const toArena = await waitForPortal(frame, (p) => p.to === 'arena', 'the Arena portal from Plaza');
    await frame.locator('#scene').click({ position: { x: toArena.sx, y: toArena.sy } });
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Arena'), { timeout: 10000 });
    await waitForActiveChatTab(frame, 'world:arena');
    labels = await chatTabLabels(frame);
    if (labels[1] !== 'Example Plaza') throw new Error('Expected "Example Plaza" to LOSE its "(current)" suffix at Arena, got: ' + JSON.stringify(labels));
    if (labels[2] !== 'Example Arena(current)') throw new Error('Expected "Example Arena" to GAIN the "(current)" suffix, got: ' + JSON.stringify(labels));
    if ((await activeChatTabId(frame)) !== 'world:arena') throw new Error('Expected "Example Arena" (world:arena) to become the active tab on arrival (defaultTabPreference is still "auto"/"world")');
    console.log('PASS: "(current)" suffix correctly tracks live location, moving off the world just left');

    console.log('STEP 5: walk to Neighbor Workshop (Domain B: domain-wide only, no individual flag on its one world) — exactly ONE tab, Domain, with NO "(current)" suffix anywhere');
    // Arena's only portal goes back to Plaza — walk there first, then take
    // Plaza's own domain portal to Workshop.
    const arenaBackToPlaza = await waitForPortal(frame, (p) => p.to === 'plaza', 'the Plaza portal from Arena');
    await frame.locator('#scene').click({ position: { x: arenaBackToPlaza.sx, y: arenaBackToPlaza.sy } });
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    const toWorkshopFromPlaza = await waitForPortal(frame, (p) => p.kind === 'domain' && p.to === 'localhost:8002', 'the domain portal to Neighbor Workshop from Plaza');
    await frame.locator('#scene').click({ position: { x: toWorkshopFromPlaza.sx, y: toWorkshopFromPlaza.sy } });
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Neighbor Workshop'), { timeout: 10000 });
    await waitForActiveChatTab(frame, 'domain');
    if (!(await chatWidgetVisible(frame))) throw new Error('Expected chat widget visible at Workshop (manifest.chat: true)');
    ids = await chatTabIds(frame);
    if (JSON.stringify(ids) !== JSON.stringify(['domain'])) throw new Error('Expected exactly one tab (domain) at Workshop, got: ' + JSON.stringify(ids));
    labels = await chatTabLabels(frame);
    if (labels[0] !== 'Domain') throw new Error('Expected the one tab labeled plain "Domain" — Workshop has no dedicated tab of its own for a "(current)" suffix to attach to, got: ' + JSON.stringify(labels));
    if ((await activeChatTabId(frame)) !== 'domain') throw new Error('Expected "Domain" to be the (only, so trivially active) tab at Workshop');
    console.log('PASS: single-tab domain-wide-only scenario — one Domain tab, correctly un-suffixed, this is expected, not a bug');

    console.log('STEP 6: defaultTabPreference = "domain" — back at Plaza (which has both tabs to choose from), re-entering selects Domain over its own world tab');
    const backToDomainA = await waitForPortal(frame, (p) => p.kind === 'domain' && p.to === 'localhost:8001', 'the domain portal back to Domain A from Workshop');
    await frame.locator('#scene').click({ position: { x: backToDomainA.sx, y: backToDomainA.sy } });
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    await setDefaultTabPreference(frame, 'domain');
    // Re-trigger a fresh world entry (walk away and back) so
    // refreshChatAvailability() actually re-picks the initial tab under
    // the new preference — the preference is only consulted on ENTRY, not
    // retroactively applied to whatever's already showing.
    const toArena2 = await waitForPortal(frame, (p) => p.to === 'arena', 'the Arena portal from Plaza (2nd time)');
    await frame.locator('#scene').click({ position: { x: toArena2.sx, y: toArena2.sy } });
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Arena'), { timeout: 10000 });
    const arenaBackToPlaza2 = await waitForPortal(frame, (p) => p.to === 'plaza', 'the Plaza portal from Arena (2nd time)');
    await frame.locator('#scene').click({ position: { x: arenaBackToPlaza2.sx, y: arenaBackToPlaza2.sy } });
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    await waitForActiveChatTab(frame, 'domain');
    console.log('PASS: "domain" preference wins over the current world\'s own tab when both are available');

    console.log('STEP 7: defaultTabPreference = "world" — re-entering Plaza selects its own tab even though Domain is available too');
    await setDefaultTabPreference(frame, 'world');
    const toArena3 = await waitForPortal(frame, (p) => p.to === 'arena', 'the Arena portal from Plaza (3rd time)');
    await frame.locator('#scene').click({ position: { x: toArena3.sx, y: toArena3.sy } });
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Arena'), { timeout: 10000 });
    const arenaBackToPlaza3 = await waitForPortal(frame, (p) => p.to === 'plaza', 'the Plaza portal from Arena (3rd time)');
    await frame.locator('#scene').click({ position: { x: arenaBackToPlaza3.sx, y: arenaBackToPlaza3.sy } });
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    await waitForActiveChatTab(frame, 'world:plaza');
    console.log('PASS: "world" preference wins over Domain when both are available');

    console.log('\nALL CHAT CAPABILITY GATE / DYNAMIC TAB CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close().catch(() => {});
  }
})();
