// Manual check for Post Office handle addressing's UI (task #94's last
// remaining piece — "hide the raw public key from users", per direct
// instruction) — the wallet's "Your handle" panel and Compose's
// handle-first recipient field, driving the real extension with two
// separate identities (see manual-postoffice-handle.js for the
// server-side/protocol coverage of the same feature).
//
// Requires domain A's issuer-server on 8001 AND domain B running as a real
// issuer-server instance on 8002 (see README.md's "Serve the two demo
// domains").
//
// Checks:
//   1. B registers the handle "bob" from the "Your handle" panel; the
//      display line confirms it as "bob#localhost:8002".
//   2. A sends to B using JUST the bare handle "bob" (the domain is
//      already picked via the existing "Send mail" dropdown) — no raw
//      public key typed anywhere.
//   3. B's mail card shows the message. Since A has no handle registered
//      yet, the From line still falls back to A's raw public key
//      fragment — confirms the fallback path, not just the happy path.
//   4. A registers "alice", then sends a second message addressed as the
//      FULL "bob#localhost:8002" string in one field — confirms parsing a
//      complete address (not just a bare handle against the existing
//      dropdown selection).
//   5. B's second mail card now shows "From alice#localhost:8002" —
//      confirms the relaying domain auto-stamps a sender's handle with no
//      extra step, and the client renders it in place of the raw key.
//   6. The "paste a raw public key instead" toggle still works: switching
//      to it hides the handle field, shows the raw-key textarea, and a
//      send using B's actual raw public key succeeds exactly as before
//      this feature existed.
//   7. Sending to a handle nobody has registered fails with a clear,
//      non-crashing status message.
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

// Joins Domain B's Post Office via the manifest-advertised Join button
// (task #94, already built) rather than walking to the in-world stall —
// faster, and exercised end to end already by manual-postoffice-
// manifest-join.js, so reusing it here isn't skipping coverage.
async function joinDomainBPostOffice(frame, label) {
  const portals = await projectPortals(frame);
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
  console.log('PASS: ' + label + ' joined Domain B\'s Post Office');
  await frame.locator('#walletBtn').click(); // close the wallet panel before navigating, same as createIdentity leaves it

  // walk back to the Plaza, same as every other Post Office test
  const backPortals = await projectPortals(frame);
  const backToPlaza = backPortals.find((p) => p.kind === 'domain');
  await frame.locator('#scene').click({ position: { x: backToPlaza.sx, y: backToPlaza.sy } });
  await frame.waitForFunction(() => document.getElementById('status').textContent.includes('8001'), { timeout: 10000 });
}

// Idempotent — walletBtn TOGGLES the panel (see viewer.js), so blindly
// clicking it every time this test wants the Mail screen would close an
// already-open panel from an earlier step instead of opening it. Only
// clicks it when the panel isn't already open.
async function openMailScreen(frame) {
  const alreadyOpen = await frame.evaluate(() => document.getElementById('walletPanel').classList.contains('open'));
  if (!alreadyOpen) await frame.locator('#walletBtn').click();
  await frame.locator('#socialTabBtn').click();
  await frame.waitForFunction(() => document.getElementById('mailSubscreen').classList.contains('active'), { timeout: 5000 });
  await frame.waitForFunction(() => document.getElementById('myPublicKeyDisplay').value.length > 0, { timeout: 5000 });
}

// Mail now has its own inner "Mail" / "Mail Settings" sub-tab bar — "Your
// address"/handle/who-can-mail-you/blocked-senders live under Mail
// Settings, everything else (compose, check now) stays under Mail. Both
// idempotent, same pattern as openIdentityMethodCategory in the other
// manual tests: check the target sub-screen's own 'active' class (not the
// button's, since the default-active Mail sub-screen never gets its
// button's 'active-subtab' class until the first click) before clicking.
async function openMailSettingsSubtab(frame) {
  const alreadyOpen = await frame.locator('#mailSettingsSubscreen').evaluate((el) => el.classList.contains('active'));
  if (!alreadyOpen) await frame.locator('#mailSettingsSubtabBtn').click();
}
async function openMailInboxSubtab(frame) {
  const alreadyOpen = await frame.locator('#mailInboxSubscreen').evaluate((el) => el.classList.contains('active'));
  if (!alreadyOpen) await frame.locator('#mailInboxSubtabBtn').click();
}

// The "Mail" heading has its own further Inbox/Sent/Compose split now —
// Compose is where the recipient/subject/body/send fields live (formerly
// "Send mail"), Inbox is check-now + the message list. Both nested INSIDE
// mailInboxSubscreen, so the outer "Mail" tab must already be open (see
// openMailInboxSubtab above) before either of these can click anything —
// their target buttons are display:none otherwise.
async function openMailBoxInboxSubtab(frame) {
  const alreadyOpen = await frame.locator('#mailBoxInboxSubscreen').evaluate((el) => el.classList.contains('active'));
  if (!alreadyOpen) await frame.locator('#mailBoxInboxSubtabBtn').click();
}
async function openMailBoxComposeSubtab(frame) {
  const alreadyOpen = await frame.locator('#mailBoxComposeSubscreen').evaluate((el) => el.classList.contains('active'));
  if (!alreadyOpen) await frame.locator('#mailBoxComposeSubtabBtn').click();
}

(async () => {
  const dirA = path.resolve(__dirname, '.chrome-profile-postoffice-handle-a');
  const dirB = path.resolve(__dirname, '.chrome-profile-postoffice-handle-b');
  const launchOpts = { headless: false, executablePath: '/opt/pw-browsers/chromium', args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox'] };

  const contextA = await chromium.launchPersistentContext(dirA, launchOpts);
  const contextB = await chromium.launchPersistentContext(dirB, launchOpts);

  try {
    const a = await openOverlay(contextA, 'Visitor A');
    const b = await openOverlay(contextB, 'Visitor B');

    console.log('STEP 0: two visitors create identities and both join Domain B\'s Post Office');
    const pkA = await createIdentity(a.frame, 'postoffice-handle-test-password-a');
    const pkB = await createIdentity(b.frame, 'postoffice-handle-test-password-b');
    await joinDomainBPostOffice(a.frame, 'Visitor A');
    await joinDomainBPostOffice(b.frame, 'Visitor B');

    console.log('STEP 1: B registers the handle "bob" from the "Your handle" panel');
    await openMailScreen(b.frame);
    await openMailSettingsSubtab(b.frame);
    await b.frame.locator('#postOfficeSettingsDomainInput').selectOption('localhost:8002');
    await b.frame.waitForFunction(() => document.getElementById('postOfficeYourHandleDisplay').textContent.includes('No handle set'), { timeout: 5000 });
    await b.frame.locator('#postOfficeHandleInput').fill('bob');
    await b.frame.locator('#postOfficeSaveHandleBtn').click();
    await b.frame.waitForFunction(() => document.getElementById('postOfficeHandleStatus').textContent.startsWith('Saved'), { timeout: 5000 });
    const handleDisplay = await b.frame.locator('#postOfficeYourHandleDisplay').textContent();
    if (!handleDisplay.includes('bob#localhost:8002')) throw new Error('Expected the handle display to read "bob#localhost:8002", got: ' + handleDisplay);
    console.log('PASS: B is now', handleDisplay);

    console.log('STEP 2: A sends to B using JUST the bare handle "bob" — no raw public key typed');
    await openMailScreen(a.frame);
    await openMailInboxSubtab(a.frame);
    await openMailBoxComposeSubtab(a.frame);
    await a.frame.waitForFunction(() => {
      const opts = [...document.getElementById('postOfficeToDomainInput').options].map((o) => o.value).filter(Boolean);
      return opts.includes('localhost:8002');
    }, { timeout: 5000 });
    await a.frame.locator('#postOfficeToDomainInput').selectOption('localhost:8002');
    const rawKeyHiddenByDefault = await a.frame.evaluate(() => document.getElementById('postOfficeToPublicKeyInput').hidden);
    if (!rawKeyHiddenByDefault) throw new Error('Expected the raw-key field to be hidden by default (handle-first)');
    await a.frame.locator('#postOfficeToHandleInput').fill('bob');
    await a.frame.locator('#postOfficeSubjectInput').fill('Hello via handle');
    await a.frame.locator('#postOfficeBodyInput').fill('sent using just "bob", no public key typed');
    await a.frame.locator('#postOfficeSendBtn').click();
    await a.frame.waitForFunction(() => document.getElementById('postOfficeSendStatus').textContent === 'Sent.', { timeout: 10000 });
    console.log('PASS: sent by bare handle');

    console.log('STEP 3: B\'s mail card shows it, falling back to A\'s raw key (A has no handle registered yet)');
    await openMailScreen(b.frame);
    await openMailInboxSubtab(b.frame);
    await openMailBoxInboxSubtab(b.frame);
    await b.frame.locator('#checkMailNowBtn').click();
    await b.frame.waitForFunction(() => [...document.querySelectorAll('#mailList .mail-card')].some((el) => el.textContent.includes('Hello via handle')), { timeout: 10000 });
    const card1 = b.frame.locator('#mailList .mail-card', { hasText: 'Hello via handle' });
    const card1Text = await card1.textContent();
    if (!card1Text.includes(pkA.slice(0, 20))) throw new Error('Expected the fallback raw-key fragment for A (no handle yet), got: ' + card1Text);
    if (card1Text.includes('#localhost:8002')) throw new Error('Did not expect a handle-style From line yet — A has not registered one: ' + card1Text);
    console.log('PASS: falls back to raw key correctly when the sender has no handle');

    console.log('STEP 4: A registers "alice", then sends addressed as the FULL "bob#localhost:8002" string');
    await openMailSettingsSubtab(a.frame);
    await a.frame.locator('#postOfficeSettingsDomainInput').selectOption('localhost:8002');
    await a.frame.locator('#postOfficeHandleInput').fill('alice');
    await a.frame.locator('#postOfficeSaveHandleBtn').click();
    await a.frame.waitForFunction(() => document.getElementById('postOfficeHandleStatus').textContent.startsWith('Saved'), { timeout: 5000 });
    await openMailInboxSubtab(a.frame);
    await openMailBoxComposeSubtab(a.frame);
    await a.frame.locator('#postOfficeToDomainInput').selectOption(''); // clear the dropdown to prove the full address alone drives it
    await a.frame.locator('#postOfficeToHandleInput').fill('bob#localhost:8002');
    await a.frame.locator('#postOfficeSubjectInput').fill('Hello via full address');
    await a.frame.locator('#postOfficeBodyInput').fill('sent using "bob#localhost:8002" in one field');
    await a.frame.locator('#postOfficeSendBtn').click();
    await a.frame.waitForFunction(() => document.getElementById('postOfficeSendStatus').textContent === 'Sent.', { timeout: 10000 });
    const dropdownAfterParse = await a.frame.locator('#postOfficeToDomainInput').inputValue();
    if (dropdownAfterParse !== 'localhost:8002') throw new Error('Expected parsing the full address to auto-select the domain dropdown, got: ' + dropdownAfterParse);
    console.log('PASS: a full "handle#domain" address alone resolved the domain and sent successfully');

    console.log('STEP 5: B\'s second mail card shows "From alice#localhost:8002"');
    await b.frame.locator('#checkMailNowBtn').click();
    await b.frame.waitForFunction(() => [...document.querySelectorAll('#mailList .mail-card')].some((el) => el.textContent.includes('Hello via full address')), { timeout: 10000 });
    const card2 = b.frame.locator('#mailList .mail-card', { hasText: 'Hello via full address' });
    const card2Text = await card2.textContent();
    if (!card2Text.includes('alice#localhost:8002')) throw new Error('Expected "From alice#localhost:8002", got: ' + card2Text);
    console.log('PASS: relaying domain auto-stamped the handle, client rendered it in place of the raw key');

    console.log('STEP 6: the "paste a raw public key instead" toggle still works');
    await a.frame.locator('#postOfficeToggleRawKeyBtn').click();
    const handleHiddenAfterToggle = await a.frame.evaluate(() => document.getElementById('postOfficeToHandleInput').hidden);
    const rawKeyShownAfterToggle = await a.frame.evaluate(() => !document.getElementById('postOfficeToPublicKeyInput').hidden);
    if (!handleHiddenAfterToggle || !rawKeyShownAfterToggle) throw new Error('Expected the toggle to hide the handle field and show the raw-key field');
    await a.frame.locator('#postOfficeToDomainInput').selectOption('localhost:8002');
    await a.frame.locator('#postOfficeToPublicKeyInput').fill(pkB);
    await a.frame.locator('#postOfficeSubjectInput').fill('Hello via raw key');
    await a.frame.locator('#postOfficeBodyInput').fill('the fallback path still works');
    await a.frame.locator('#postOfficeSendBtn').click();
    await a.frame.waitForFunction(() => document.getElementById('postOfficeSendStatus').textContent === 'Sent.', { timeout: 10000 });
    console.log('PASS: raw-key fallback path still sends successfully');

    console.log('STEP 7: sending to an unregistered handle fails with a clear status, no crash');
    await a.frame.locator('#postOfficeToggleRawKeyBtn').click(); // back to handle mode
    await a.frame.locator('#postOfficeToHandleInput').fill('nobody-has-this-handle');
    await a.frame.locator('#postOfficeSubjectInput').fill('Should not send');
    await a.frame.locator('#postOfficeBodyInput').fill('this handle does not exist');
    await a.frame.locator('#postOfficeSendBtn').click();
    await a.frame.waitForFunction(() => {
      const t = document.getElementById('postOfficeSendStatus').textContent;
      return t && t !== '' && t !== 'Looking up…';
    }, { timeout: 10000 });
    const failStatus = await a.frame.locator('#postOfficeSendStatus').textContent();
    if (failStatus === 'Sent.') throw new Error('Expected sending to an unregistered handle to fail, but it reported success');
    console.log('PASS: clear failure status ->', failStatus);

    console.log('\nALL POST OFFICE HANDLE-ADDRESSING UI CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await contextA.close();
    await contextB.close();
  }
})();
