// End-to-end check for the wallet-side admin entry point: extension/
// viewer.js's 🛡️ Admin button (shown only when the active identity is on
// the current domain's admin roster — AtlasWallet.isAdminForDomain, GET
// /atlas/admin/is-admin), the session it starts (AtlasWallet.
// adminLoginForDomain, the same nonce/sign/start flow manual-admin-
// session.js already proves at the protocol level), the cross-origin
// handoff to the host page (content.js's 'domain-atlas-admin-handoff'
// listener, since the wallet lives in an extension-origin iframe and can't
// touch the domain's own sessionStorage directly), and the one-page admin
// panel itself (issuer-server/admin-panel/index.html, identical to
// issuer-php/atlas-admin/index.html) that the token lands on.
//
// The four admin actions THEMSELVES (revoke/mail-send/reissue/calendar
// accepting a token) are already proven at the protocol level by
// manual-admin-session-actions.js — this test's job is the NEW plumbing
// around them: does clicking the real button in a real browser actually
// get a real admin, on the real admin panel page, able to do one of them.
// Revoke is exercised end to end here as the proof; the other three would
// just be re-testing the same handoff mechanism a second time. The panel's
// "Online now" section is exercised for real too — it's the one part of
// the page that talks to a THIRD server (presence-server), not just the
// issuer backend.
//
// Runs against the shared localhost:8001 demo server (Example Plaza) and
// the shared presence server on its own default port 8004 (manifest.
// presence is unset for the demo domain, so the panel falls back to that
// same default extension/viewer.js itself uses) — same "drive the actual
// extension in a real Chrome instance" style as manual-legacy-wallet-
// migration.js and manual-asset-update-check.js. Needs `npm run demo` (or
// equivalent) already up on 8001; starts its own presence-server instance
// rather than assuming one is already running, and only ever touches this
// wallet's OWN freshly-created identity (never mutates anyone else's
// state). Seeds the shared admin roster file directly with this run's own
// identity, same "plain operator-edited JSON" bootstrap every other
// admin-related manual test already uses — left in place afterward, same
// as those.
//
// Checks:
//   1. Fresh identity, no admin roster entry yet -> the Admin button is
//      hidden.
//   2. Seeding the roster with this identity's own public key (then
//      forcing the same visibility check the extension itself runs on
//      every domain landing/identity change) makes the button appear.
//   3. Clicking it logs into the admin session (a real nonce/sign/start
//      round trip against the live server) and lands the TOP-LEVEL page
//      (not the wallet's iframe) on /atlas-admin/, showing this identity
//      as the logged-in admin.
//   4. "Online now" shows an anonymous visitor really joined via the
//      presence server's own poll endpoint (no admin action involved —
//      this is a real cross-server aggregation, not a mock).
//   5. The panel can actually revoke a credential — a real POST
//      /atlas/revoke carrying {payload, token}, no proof — and the
//      revocation is really recorded server-side.
//   6. Mail: pasting a public key (not a credential id) into the
//      recipient field still gets a 200 from the server (it doesn't
//      validate the id — see server.js's own comment on this endpoint),
//      but the panel now flags it as a mistake instead of showing a plain
//      "Sent."; pasting a real credential id shows a plain "Sent." with no
//      warning. Reported live: an operator mailed themselves using their
//      raw public key as the "recipient", saw "Sent.", and nothing ever
//      arrived — this is the fix.
//   7. Mail's recipient field is a real typeable dropdown (<datalist>-
//      backed <input>, not a plain text box), sourced from live server
//      state: it picks up a freshly-issued subscriber and a freshly-
//      issued Post Office member (POST /atlas/admin/directory, new — see
//      its own comment in server.js). Calendar's World id is instead a
//      plain, non-typeable <select> (task-requested) always listing every
//      option — domain-wide plus only the one demo world that actually
//      opted into a calendar ("plaza") — and picking one populates Event
//      id's own <datalist> with that world's real events (refreshed again
//      immediately after adding a new one) while clearing Event id AND
//      Title/Start/End/Notes, so a value left over from the previous
//      world can't be submitted against the new one by accident. Event id
//      itself starts disabled (Action defaults to "add", which never
//      needs one), becomes enabled on switching to "update", picking a
//      real event id there fills Title/Start/End/Notes with that event's
//      actual current values, and focusing it selects its whole contents
//      for a quick clear; switching back to "add" disables the field
//      again and clears any id left in it.
//   8. Logging out clears the session: reloading /atlas-admin/ afterward
//      shows the logged-out notice again, not a stale login.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const ADMIN_KEYS_FILE = path.resolve(__dirname, '..', 'issuer-server', 'atlas-admin-keys-store.json');
const PRESENCE_PORT = 8004; // the real default both viewer.js and the admin panel fall back to — demo-domain-a's manifest sets no explicit "presence" base, so this has to be the actual default, not an isolated test port

function startPresenceServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.resolve(__dirname, '..', 'presence-server', 'server.js')], {
      env: { ...process.env, PORT: String(PRESENCE_PORT) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const timer = setTimeout(() => reject(new Error('presence-server did not start in time')), 5000);
    proc.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); resolve(proc); } });
    proc.on('exit', (code) => reject(new Error('presence-server exited early with code ' + code)));
  });
}

// Same "plain operator-edited JSON" bootstrap every other admin-related
// manual test already uses.
function seedAdmin(publicKey) {
  fs.writeFileSync(ADMIN_KEYS_FILE, JSON.stringify({ keys: [{ publicKey, addedAt: new Date().toISOString() }] }, null, 2));
}

function postJson(port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: 'localhost', port, path: urlPath, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let chunks = '';
        res.on('data', (c) => { chunks += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(chunks)); } catch (err) { reject(err); }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

(async () => {
  console.log('SETUP: starting presence-server on its real default port', PRESENCE_PORT);
  const presenceProc = await startPresenceServer();
  console.log('PASS: presence-server up');

  const userDataDir = path.resolve(__dirname, '.chrome-profile-admin-panel');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  });

  try {
    const page = await context.newPage();

    console.log('SETUP: fresh identity, not an admin yet');
    await page.goto('http://localhost:8001', { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    await frame.locator('#walletBtn').click();
    await frame.locator('#chooseNewBtn').click();
    await frame.locator('#newPasswordInput').fill('admin-panel-test-password');
    await frame.locator('#newPasswordConfirmInput').fill('admin-panel-test-password');
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    const identity = await frame.evaluate(() => AtlasWallet.getIdentity());
    console.log('PASS: identity ready ->', identity.publicKey.slice(0, 16) + '…');

    console.log('STEP 1: not on the admin roster yet -> the Admin button is hidden');
    const hiddenBefore = await frame.locator('#adminBtn').isHidden();
    if (!hiddenBefore) throw new Error('Expected the Admin button to be hidden before this identity is an admin');
    console.log('PASS: Admin button hidden for a non-admin identity');

    console.log('STEP 2: seeding the roster with this identity, then re-checking visibility, makes the button appear');
    seedAdmin(identity.publicKey);
    await frame.evaluate(() => refreshAdminButtonVisibility());
    await frame.waitForFunction(() => document.getElementById('adminBtn').style.display !== 'none', { timeout: 5000 });
    console.log('PASS: Admin button now visible');

    console.log('STEP 3: clicking Admin logs in and hands off to the top-level admin panel page');
    await frame.locator('#adminBtn').click();
    await page.waitForURL('**/atlas-admin/**', { timeout: 10000 });
    await page.waitForFunction(() => !document.getElementById('loggedOutNotice') || document.getElementById('loggedOutNotice').style.display === 'none', { timeout: 10000 });
    const whoText = await page.locator('#whoDisplay').textContent();
    if (!whoText.includes(identity.publicKey.slice(0, 20))) {
      throw new Error('Expected the admin panel to show this identity as the logged-in admin, got: ' + whoText);
    }
    console.log('PASS: landed on the admin panel, logged in as', whoText.trim());

    console.log('STEP 4: "Online now" reflects a real anonymous visitor who joined via the presence server\'s own poll endpoint');
    const joinRes = await postJson(PRESENCE_PORT, '/presence/poll/join', { domain: 'localhost:8001', world: 'plaza', name: 'Admin Panel Test Visitor' });
    if (!joinRes.id) throw new Error('Setup failed: could not join an anonymous visitor into the presence server, got: ' + JSON.stringify(joinRes));
    await page.evaluate(() => refreshOnlineNow());
    await page.waitForFunction(() => document.getElementById('onlineTotal').textContent === '1', { timeout: 10000 });
    const rosterText = await page.locator('#onlineWorlds').textContent();
    if (!rosterText.includes('Admin Panel Test Visitor')) {
      throw new Error('Expected the anonymous visitor\'s name in the rendered "Online now" roster, got: ' + rosterText);
    }
    console.log('PASS: "Online now" shows the real anonymous visitor from the presence server, no mocking involved');

    console.log('STEP 5: the panel can actually revoke a real credential — POST /atlas/revoke with {payload, token}, no proof');
    const issued = await postJson(8001, '/atlas/asset/issue', { ownerPublicKey: 'admin-panel-test-owner', assetClass: 'atlas.trophy.chess' });
    if (!issued.id) throw new Error('Setup failed: could not issue a credential to revoke, got: ' + JSON.stringify(issued));
    await page.locator('#revokeId').fill(issued.id);
    await page.locator('#revokeReason').fill('admin-panel-test');
    await page.locator('#revokeBtn').click();
    await page.waitForFunction(() => document.getElementById('revokeResult').textContent.includes('Revoked'), { timeout: 10000 });
    const revocationsPath = path.resolve(__dirname, '..', 'demo-domain-a', '.well-known', 'atlas-revocations.json');
    const revocations = JSON.parse(fs.readFileSync(revocationsPath, 'utf8'));
    if (!revocations.revoked.some((r) => r.id === issued.id)) {
      throw new Error('Expected ' + issued.id + ' to actually be recorded revoked server-side, got: ' + JSON.stringify(revocations.revoked));
    }
    console.log('PASS: revoked through the real admin panel UI, recorded server-side');

    console.log('STEP 6: Mail warns when the "recipient" typed in isn\'t a credential id, but not when it is');
    await page.locator('#mailCredentialId').fill(identity.publicKey);
    await page.locator('#mailSubject').fill('admin-panel-test-subject');
    await page.locator('#mailBody').fill('admin-panel-test-body');
    await page.locator('#mailBtn').click();
    await page.waitForFunction(() => document.getElementById('mailResult').textContent.includes("doesn't look like a credential id"), { timeout: 10000 });
    const mailResultClassAfterKey = await page.locator('#mailResult').getAttribute('class');
    if (!mailResultClassAfterKey || !mailResultClassAfterKey.includes('err')) {
      throw new Error('Expected the public-key "recipient" to be flagged as an error, got class: ' + mailResultClassAfterKey);
    }
    console.log('PASS: a raw public key in the recipient field is flagged, not shown as a plain "Sent."');

    const mailTarget = await postJson(8001, '/atlas/asset/issue', { ownerPublicKey: 'admin-panel-test-owner', assetClass: 'atlas.trophy.chess' });
    if (!mailTarget.id) throw new Error('Setup failed: could not issue a credential to mail, got: ' + JSON.stringify(mailTarget));
    await page.locator('#mailCredentialId').fill(mailTarget.id);
    await page.locator('#mailBtn').click();
    await page.waitForFunction(() => document.getElementById('mailResult').textContent === 'Sent.', { timeout: 10000 });
    const mailResultClassAfterRealId = await page.locator('#mailResult').getAttribute('class');
    if (!mailResultClassAfterRealId || !mailResultClassAfterRealId.includes('ok')) {
      throw new Error('Expected a real credential id to send cleanly with no warning, got class: ' + mailResultClassAfterRealId);
    }
    console.log('PASS: a real credential id still just sends cleanly, no false warning');

    console.log('STEP 7: recipient/world/event fields are real, typeable dropdowns backed by live server state');
    const subscriberOwner = 'admin-panel-test-subscriber';
    const subscriberIssued = await postJson(8001, '/atlas/asset/issue', { ownerPublicKey: subscriberOwner, assetClass: 'atlas.membership' });
    if (!subscriberIssued.id) throw new Error('Setup failed: could not issue a subscriber membership, got: ' + JSON.stringify(subscriberIssued));
    const postOfficeOwner = 'admin-panel-test-postoffice-member';
    const postOfficeIssued = await postJson(8001, '/atlas/asset/issue', { ownerPublicKey: postOfficeOwner, assetClass: 'atlas.postoffice.membership' });
    if (!postOfficeIssued.id) throw new Error('Setup failed: could not issue a Post Office membership, got: ' + JSON.stringify(postOfficeIssued));
    await page.evaluate(() => refreshMailDirectory());
    await page.waitForFunction(
      (ids) => {
        const values = Array.from(document.querySelectorAll('#mailRecipientOptions option')).map((o) => o.value);
        return ids.every((id) => values.includes(id));
      },
      [subscriberIssued.id, postOfficeIssued.id],
      { timeout: 10000 }
    );
    console.log('PASS: the recipient datalist picked up both the new subscriber and the new Post Office member');

    const worldOptionValues = await page.evaluate(() => Array.from(document.querySelectorAll('#calendarWorldId option')).map((o) => o.value));
    if (JSON.stringify(worldOptionValues) !== JSON.stringify(['', 'plaza'])) {
      throw new Error('Expected World id to be a plain select listing domain-wide plus only the one calendar-enabled world ("plaza"), got: ' + JSON.stringify(worldOptionValues));
    }
    console.log('PASS: World id is a non-typeable select listing every option (domain-wide + calendar-enabled worlds only)');

    const eventIdDisabledOnAdd = await page.locator('#calendarEventId').isDisabled();
    if (!eventIdDisabledOnAdd) throw new Error('Expected Event id to be disabled while Action is "add"');
    console.log('PASS: Event id starts disabled — Action defaults to "add", which never needs one');

    await page.locator('#calendarWorldId').selectOption('plaza');
    await page.locator('#calendarTitle').fill('Admin panel dropdown test event');
    await page.locator('#calendarDateTime').fill('2026-11-01T18:00:00Z');
    await page.locator('#calendarEndDateTime').fill('2026-11-01T20:00:00Z');
    await page.locator('#calendarNotes').fill('added to prove the Event id dropdown fills the form back in');
    await page.locator('#calendarBtn').click();
    await page.waitForFunction(() => document.getElementById('calendarResult').textContent.includes('Done'), { timeout: 10000 });
    const newEventId = await page.evaluate(() => JSON.parse(document.getElementById('calendarResult').textContent.slice(document.getElementById('calendarResult').textContent.indexOf('{'))).id);
    await page.waitForFunction(
      (id) => Array.from(document.querySelectorAll('#calendarEventOptions option')).some((o) => o.value === id),
      newEventId,
      { timeout: 10000 }
    );
    console.log('PASS: the Event id datalist picked up the event just added under "plaza"');

    await page.locator('#calendarAction').selectOption('update');
    const eventIdDisabledOnUpdate = await page.locator('#calendarEventId').isDisabled();
    if (eventIdDisabledOnUpdate) throw new Error('Expected Event id to be enabled once Action is "update"');
    console.log('PASS: Event id becomes enabled once Action is switched to "update"');

    await page.locator('#calendarTitle').fill('');
    await page.locator('#calendarDateTime').fill('');
    await page.locator('#calendarEndDateTime').fill('');
    await page.locator('#calendarNotes').fill('');
    await page.locator('#calendarEventId').fill(newEventId);
    await page.waitForFunction(() => document.getElementById('calendarTitle').value === 'Admin panel dropdown test event', { timeout: 10000 });
    const refilled = await page.evaluate(() => ({
      title: document.getElementById('calendarTitle').value,
      dateTime: document.getElementById('calendarDateTime').value,
      endDateTime: document.getElementById('calendarEndDateTime').value,
      notes: document.getElementById('calendarNotes').value
    }));
    if (refilled.title !== 'Admin panel dropdown test event' || refilled.dateTime !== '2026-11-01T18:00:00Z' ||
        refilled.endDateTime !== '2026-11-01T20:00:00Z' || refilled.notes !== 'added to prove the Event id dropdown fills the form back in') {
      throw new Error('Expected picking the event id to refill Title/Start/End/Notes from the real event, got: ' + JSON.stringify(refilled));
    }
    console.log('PASS: picking a known Event id fills Title/Start/End/Notes from that event');

    // Moves focus elsewhere first — the field is already focused from the
    // .fill() above, and re-focusing an already-focused element fires no
    // new 'focus' event to select() against.
    await page.locator('#calendarTitle').focus();
    await page.locator('#calendarEventId').focus();
    const eventIdSelection = await page.evaluate(() => {
      const el = document.getElementById('calendarEventId');
      return { start: el.selectionStart, end: el.selectionEnd, length: el.value.length };
    });
    if (eventIdSelection.length === 0 || eventIdSelection.start !== 0 || eventIdSelection.end !== eventIdSelection.length) {
      throw new Error('Expected focusing Event id to select its whole contents, got: ' + JSON.stringify(eventIdSelection));
    }
    console.log('PASS: focusing Event id selects its whole contents, for a quick clear');

    await page.locator('#calendarWorldId').selectOption('');
    const clearedOnWorldChange = await page.evaluate(() => ({
      eventId: document.getElementById('calendarEventId').value,
      title: document.getElementById('calendarTitle').value,
      dateTime: document.getElementById('calendarDateTime').value,
      endDateTime: document.getElementById('calendarEndDateTime').value,
      notes: document.getElementById('calendarNotes').value
    }));
    if (Object.values(clearedOnWorldChange).some((v) => v !== '')) {
      throw new Error('Expected changing World id to clear Event id/Title/Start/End/Notes, got: ' + JSON.stringify(clearedOnWorldChange));
    }
    console.log('PASS: changing World id clears Event id and every field below it');

    // newEventId only actually exists under "plaza", not the domain-wide
    // calendar World id was just switched to, so typing it here won't
    // find a match to auto-populate from (already proven separately,
    // above) — filled anyway, plus Title by hand, purely as a non-empty
    // "before" state so the next check (switching back to "add") has
    // something real to prove it actually cleared.
    await page.locator('#calendarEventId').fill(newEventId);
    await page.locator('#calendarTitle').fill('should be cleared by switching to add');

    await page.locator('#calendarAction').selectOption('add');
    const eventIdStateAfterBackToAdd = await page.evaluate(() => ({ disabled: document.getElementById('calendarEventId').disabled, value: document.getElementById('calendarEventId').value }));
    if (!eventIdStateAfterBackToAdd.disabled || eventIdStateAfterBackToAdd.value !== '') {
      throw new Error('Expected Event id to be disabled AND cleared again after switching back to "add", got: ' + JSON.stringify(eventIdStateAfterBackToAdd));
    }
    console.log('PASS: switching back to "add" disables Event id again and clears any leftover id');

    console.log('STEP 8: logging out clears the session — reloading the panel afterward shows the logged-out notice again');
    await page.locator('#logoutBtn').click();
    await page.waitForURL((url) => !url.pathname.includes('atlas-admin'), { timeout: 10000 });
    await page.goto('http://localhost:8001/atlas-admin/index.html', { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('loggedOutNotice').style.display !== 'none', { timeout: 10000 });
    console.log('PASS: logged-out notice shown again after logout — no stale session left behind');

    console.log('\nALL ADMIN PANEL END-TO-END CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close();
    presenceProc.kill();
  }
})();
