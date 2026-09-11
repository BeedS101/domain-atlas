// Manual check for a small CSS-only fix: #placeLabel (the world-name/
// domain/world-id label next to the Wallet button in the top bar) had no
// width cap or overflow handling, so a long domain/world-id string would
// just keep pushing #controls further right instead of wrapping, and any
// wrapped content taller than #bar's fixed 56px would spill visually into
// the canvas underneath instead of being contained. Now it has a
// max-width (forcing wrap) and a max-height + overflow-y: auto (turning
// "wraps into more lines than fits" into an actual scrollbar).
//
// This can't be exercised through a normal user journey (no real domain
// name here is long enough to overflow), so this test drives it directly:
// injects an artificially long string into placeLabel the same way
// viewer.js's own assignment does, then confirms the box actually clips
// to its max-height and its content becomes scrollable (scrollHeight >
// clientHeight) rather than growing to fit or spilling out silently.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-placelabel-scroll');
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

    console.log('STEP 1: sanity check — the real, short placeLabel content today has nothing to scroll');
    const shortState = await frame.evaluate(() => {
      const el = document.getElementById('placeLabel');
      return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, overflowY: getComputedStyle(el).overflowY };
    });
    if (shortState.overflowY !== 'auto') throw new Error('Expected #placeLabel to have overflow-y: auto at all times, got: ' + shortState.overflowY);
    if (shortState.scrollHeight > shortState.clientHeight) throw new Error('Did not expect the real short label to already be overflowing: ' + JSON.stringify(shortState));
    console.log('PASS: overflow-y is auto, and the real short label does not overflow ->', shortState);

    console.log('STEP 2: injecting an artificially long label (same innerHTML shape viewer.js itself uses) and confirming it wraps + becomes scrollable instead of growing or spilling out');
    const longState = await frame.evaluate(() => {
      const el = document.getElementById('placeLabel');
      const longWorldName = 'A Very Long Example World Name That Goes On And On And On';
      const longDomain = 'an-unreasonably-long-example-domain-name-for-testing.example.com';
      el.innerHTML = longWorldName + ' <span class="domain">' + longDomain + ' · example-world-id</span>';
      const barHeight = document.getElementById('bar').getBoundingClientRect().height;
      return {
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
        barHeight,
        clientWidth: el.clientWidth
      };
    });
    if (longState.clientWidth > 260) throw new Error('Expected #placeLabel to respect its 260px max-width cap, got clientWidth: ' + longState.clientWidth);
    if (longState.clientHeight > 40) throw new Error('Expected #placeLabel to respect its 40px max-height cap (not grow to fit), got clientHeight: ' + longState.clientHeight);
    if (!(longState.scrollHeight > longState.clientHeight)) throw new Error('Expected the long label\'s content to actually overflow its box (scrollHeight > clientHeight), got: ' + JSON.stringify(longState));
    if (longState.clientHeight >= longState.barHeight) throw new Error('Expected the capped label to stay well within #bar\'s own height, got label ' + longState.clientHeight + ' vs bar ' + longState.barHeight);
    console.log('PASS: long label wrapped and clipped to its max-height, with real overflow to scroll through ->', longState);

    console.log('STEP 3: scrolling the label actually moves its content (it is not just clipped with a dead scrollbar)');
    const scrolledTop = await frame.evaluate(() => {
      const el = document.getElementById('placeLabel');
      el.scrollTop = el.scrollHeight;
      return el.scrollTop;
    });
    if (scrolledTop <= 0) throw new Error('Expected setting scrollTop to actually move the label\'s scroll position, got: ' + scrolledTop);
    console.log('PASS: label content is genuinely scrollable ->', 'scrollTop is now', scrolledTop);

    console.log('\nALL PLACELABEL SCROLL CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
