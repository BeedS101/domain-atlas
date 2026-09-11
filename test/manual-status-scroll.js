// Manual check for a small CSS-only fix: #status — the small text next to
// the Wallet button that shows things like "In sync with <domain> ·
// <world>", trade-settlement results, and error messages (see viewer.js's
// many `statusEl.textContent = ...` assignments) — had a max-width but no
// height cap or overflow handling. Long text (a long domain name, a
// multi-clause trade-settlement message, a verbose error) just wrapped and
// grew #status taller than #bar's fixed 56px, since #bar itself has no
// overflow: hidden — spilling visually into the canvas underneath instead
// of staying contained in the bar.
//
// NOTE: an earlier pass fixed the SAME kind of problem on a different
// element, #placeLabel (the world-name/domain label at the far LEFT of the
// bar) — see manual-placelabel-scroll.js. That was a real but different
// element from this one; #status sits immediately to the left of the
// Wallet button itself, inside #controls, on the right side of the bar,
// which is what actually needed the scrollbar here.
//
// This can't be exercised through a normal user journey (no real domain in
// this demo is long enough to overflow), so this test drives it directly:
// injects an artificially long string into #status, then confirms the box
// clips to its max-height and becomes genuinely scrollable rather than
// growing to fit or spilling out silently.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-status-scroll');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  });

  try {
    const page = await context.newPage();

    console.log('SETUP: loading the extension and reaching the Plaza');
    await page.goto('http://localhost:8001', { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    // placeLabel updates before statusEl gets its "In sync with ..." text
    // (see viewer.js's enterWorld — the 3D/2D branches set it near the end,
    // after scene setup finishes) — wait for that specifically too.
    await frame.waitForFunction(() => document.getElementById('status').textContent.startsWith('In sync with'), { timeout: 10000 });

    console.log('STEP 1: sanity check — the real "In sync with ..." status today has nothing to scroll');
    const shortState = await frame.evaluate(() => {
      const el = document.getElementById('status');
      return { text: el.textContent, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, overflowY: getComputedStyle(el).overflowY };
    });
    if (!shortState.text.startsWith('In sync with')) throw new Error('Expected the real status text to be the "In sync with ..." message, got: ' + shortState.text);
    if (shortState.overflowY !== 'auto') throw new Error('Expected #status to have overflow-y: auto at all times, got: ' + shortState.overflowY);
    if (shortState.scrollHeight > shortState.clientHeight) throw new Error('Did not expect the real short status to already be overflowing: ' + JSON.stringify(shortState));
    console.log('PASS: overflow-y is auto, and the real "In sync with ..." status does not overflow ->', shortState);

    console.log('STEP 2: injecting an artificially long status (same shape a long domain\'s "In sync with ..." message, or a verbose trade/error message, would take) and confirming it wraps + becomes scrollable instead of growing or spilling out');
    const longState = await frame.evaluate(() => {
      const el = document.getElementById('status');
      el.textContent = 'In sync with an-unreasonably-long-example-domain-name-for-testing.example.com · a-very-long-example-world-id-for-testing';
      const barHeight = document.getElementById('bar').getBoundingClientRect().height;
      return {
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
        barHeight,
        clientWidth: el.clientWidth
      };
    });
    if (longState.clientWidth > 260) throw new Error('Expected #status to respect its 260px max-width cap, got clientWidth: ' + longState.clientWidth);
    if (longState.clientHeight > 40) throw new Error('Expected #status to respect its 40px max-height cap (not grow to fit), got clientHeight: ' + longState.clientHeight);
    if (!(longState.scrollHeight > longState.clientHeight)) throw new Error('Expected the long status\'s content to actually overflow its box (scrollHeight > clientHeight), got: ' + JSON.stringify(longState));
    if (longState.clientHeight >= longState.barHeight) throw new Error('Expected the capped status to stay well within #bar\'s own height, got status ' + longState.clientHeight + ' vs bar ' + longState.barHeight);
    console.log('PASS: long status wrapped and clipped to its max-height, with real overflow to scroll through ->', longState);

    console.log('STEP 3: scrolling the status actually moves its content (it is not just clipped with a dead scrollbar)');
    const scrolledTop = await frame.evaluate(() => {
      const el = document.getElementById('status');
      el.scrollTop = el.scrollHeight;
      return el.scrollTop;
    });
    if (scrolledTop <= 0) throw new Error('Expected setting scrollTop to actually move the status\'s scroll position, got: ' + scrolledTop);
    console.log('PASS: status content is genuinely scrollable ->', 'scrollTop is now', scrolledTop);

    console.log('\nALL STATUS SCROLL CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
