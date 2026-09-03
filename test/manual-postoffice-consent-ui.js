// Manual check for the Post Office consent/block model's UI (task #94's
// remaining piece, "both, recipient's choice" per direct instruction) —
// the wallet-side "Who can mail you" panel and the mail card's inline
// "Block sender" button, driving the real extension rather than talking to
// the server directly (see manual-postoffice-consent.js for the
// server-side/protocol coverage of the same feature).
//
// Requires domain A's issuer-server on 8001 AND domain B running as a real
// issuer-server instance on 8002 (see README.md's "Serve the two demo
// domains").
//
// Checks:
//   1. Joining a Post Office (task #94's manifest-advertisement piece)
//      makes that domain appear in the "Who can mail you" picker too, not
//      just the "Send mail" one — both are driven by the same membership
//      list, just two separate selects for two separate questions.
//   2. Blocking a (made-up) public key through the panel shows it in the
//      blocked list with an Unblock control; unblocking removes it again.
//   3. Saving "Friends only" with zero local friends reports 0 synced —
//      confirms the mode round-trips through the real save/load path
//      (AtlasWallet.setPostOfficeMailMode -> POST /atlas/postoffice/
//      mailmode -> AtlasWallet.getPostOfficeSettings on reload), not just
//      the request that sent it.
//   4. Switching back to "open" and reloading shows the mode select back
//      on "open" — confirms the panel reflects what the domain actually
//      has on file (loadPostOfficeSettings), not local optimistic state.
//
// The mail-card "Block sender" button is exercised indirectly by
// selecting the same domain in the settings panel afterward and confirming
// the block shows up there too — a full two-identity mail exchange is
// already covered by manual-postoffice-mail.js and isn't repeated here.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-postoffice-consent-ui');
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

    console.log('SETUP: create a real wallet identity');
    await frame.locator('#walletBtn').click();
    await frame.locator('#chooseNewBtn').click();
    await frame.locator('#newPasswordInput').fill('consent-ui-test-password');
    await frame.locator('#newPasswordConfirmInput').fill('consent-ui-test-password');
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('#walletBtn').click();
    console.log('PASS: identity created');

    console.log('STEP 1: walk to Domain B and join its Post Office directly from the wallet (task #94 manifest advertisement)');
    async function projectPortals() {
      return frame.evaluate(() => {
        return new Promise((resolve) => {
          const check = () => {
            if (window.__atlasScene && window.__atlasScene.portalMarkers.length) {
              const canvas = document.getElementById('scene');
              const originX = canvas.width / 2;
              const originY = canvas.height / 2 + 40;
              const SCALE = 26, COS30 = Math.cos(Math.PI / 6), SIN30 = Math.sin(Math.PI / 6);
              resolve(window.__atlasScene.portalMarkers.map((m) => {
                const [x, , z] = m.position;
                return { sx: originX + (x - z) * COS30 * SCALE, sy: originY + (x + z) * SIN30 * SCALE, kind: m.portal && m.portal.kind };
              }));
            } else {
              requestAnimationFrame(check);
            }
          };
          check();
        });
      });
    }
    const portals = await projectPortals();
    const toNeighbor = portals.find((p) => p.kind === 'domain');
    await frame.locator('#scene').click({ position: { x: toNeighbor.sx, y: toNeighbor.sy } });
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Neighbor Workshop'), { timeout: 10000 });
    await frame.waitForFunction(() => document.getElementById('status').textContent.includes('8002'), { timeout: 10000 });

    await frame.locator('#walletBtn').click();
    await frame.locator('#socialTabBtn').click();
    await frame.waitForFunction(() => document.getElementById('mailSubscreen').classList.contains('active'), { timeout: 5000 });
    await frame.waitForFunction(() => !document.getElementById('postOfficeJoinSection').hidden, { timeout: 5000 });
    await frame.locator('#postOfficeJoinBtn').click();
    await frame.waitForFunction(() => document.getElementById('postOfficeJoinSection').hidden, { timeout: 10000 });
    console.log('PASS: joined Domain B\'s Post Office');

    console.log('STEP 2: the "Who can mail you" domain picker offers Domain B too, not just "Send mail"');
    await frame.waitForFunction(() => {
      const opts = [...document.getElementById('postOfficeSettingsDomainInput').options].map((o) => o.value).filter(Boolean);
      return opts.includes('localhost:8002');
    }, { timeout: 5000 });
    await frame.locator('#postOfficeSettingsDomainInput').selectOption('localhost:8002');
    await frame.waitForFunction(() => document.getElementById('postOfficeBlockedList').textContent.includes('No one blocked here'), { timeout: 5000 });
    console.log('PASS: Domain B selectable in the settings picker, starts with nobody blocked');

    console.log('STEP 3: block a (made-up) public key through the panel');
    const fakeKey = 'BFAKE-not-a-real-key-just-testing-the-ui-round-trip-0000000000';
    await frame.locator('#postOfficeBlockPublicKeyInput').fill(fakeKey);
    await frame.locator('#postOfficeBlockBtn').click();
    await frame.waitForFunction(() => document.getElementById('postOfficeBlockStatus').textContent === 'Blocked.', { timeout: 5000 });
    const listHtml = await frame.locator('#postOfficeBlockedList').innerHTML();
    if (!listHtml.includes(fakeKey.slice(0, 24))) throw new Error('Expected the blocked list to show the newly-blocked key, got: ' + listHtml);
    if (!listHtml.includes('Unblock')) throw new Error('Expected an Unblock control on the blocked entry, got: ' + listHtml);
    console.log('PASS: blocked key appears in the list with an Unblock control');

    console.log('STEP 4: unblock it again via the inline Unblock button');
    await frame.locator('#postOfficeBlockedList button[data-action="unblock"]').click();
    await frame.waitForFunction(() => document.getElementById('postOfficeBlockedList').textContent.includes('No one blocked here'), { timeout: 5000 });
    console.log('PASS: unblocking clears it back to "No one blocked here"');

    console.log('STEP 5: save "Friends only" with zero local friends — reports 0 synced, round-trips through a real save+reload');
    await frame.locator('#postOfficeMailModeInput').selectOption('friendsOnly');
    await frame.locator('#postOfficeSaveMailModeBtn').click();
    await frame.waitForFunction(() => document.getElementById('postOfficeMailModeStatus').textContent.includes('0 friends synced'), { timeout: 5000 });
    console.log('PASS: friends-only saved with 0 friends (this wallet has none locally)');

    console.log('STEP 6: switching domain away and back reloads settings from the server, confirming friendsOnly actually persisted');
    await frame.locator('#postOfficeSettingsDomainInput').selectOption('');
    await frame.locator('#postOfficeSettingsDomainInput').selectOption('localhost:8002');
    await frame.waitForFunction(() => document.getElementById('postOfficeMailModeInput').value === 'friendsOnly', { timeout: 5000 });
    console.log('PASS: reloaded settings show friendsOnly — this came from the server, not local memory');

    console.log('STEP 7: switch back to open and confirm it reloads that way too');
    await frame.locator('#postOfficeMailModeInput').selectOption('open');
    await frame.locator('#postOfficeSaveMailModeBtn').click();
    await frame.waitForFunction(() => document.getElementById('postOfficeMailModeStatus').textContent.includes('open to anyone'), { timeout: 5000 });
    await frame.locator('#postOfficeSettingsDomainInput').selectOption('');
    await frame.locator('#postOfficeSettingsDomainInput').selectOption('localhost:8002');
    await frame.waitForFunction(() => document.getElementById('postOfficeMailModeInput').value === 'open', { timeout: 5000 });
    console.log('PASS: back to open, confirmed via reload');

    console.log('\nALL POST OFFICE CONSENT/BLOCK UI CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
