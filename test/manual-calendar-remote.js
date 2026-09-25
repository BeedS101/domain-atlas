// Manual UI check for the domain calendar system's "Domain" and "Remote"
// sub-sub-tabs (SPEC.md §12) — the wallet-side wiring
// (extension/viewer.js's calendarDomainSubscreen/calendarRemoteSubscreen,
// AtlasWallet.fetchDomainCalendar in wallet.js) driving the REAL extension
// UI end to end against the real issuer-server, no mocking. The protocol
// layer itself (GET/POST /atlas/calendar) is already proven independently
// by test/manual-calendar-protocol(-php).js; this test seeds a couple of
// events straight over HTTP (same shortcut those tests use) and then
// proves the UI actually surfaces them correctly. "My Calendar" (the
// pre-existing local-only sub-sub-tab, unchanged in behavior, just moved
// one level deeper) is already covered end to end by test/manual-calendar.js
// and is not re-tested here.
//
// Covers:
//   1. The "Domain" sub-sub-tab's dropdown lists BOTH the domain-wide
//      calendar and the current world's own — independent entries, per
//      SPEC.md §3's field notes ("neither implies or overrides the
//      other") — and defaults to the world actually being stood in.
//   2. Switching the dropdown re-fetches and re-renders the OTHER
//      calendar, not a stale copy of the first.
//   3. The "Remote" sub-sub-tab's favorites dropdown lists a favorited
//      domain and fetches its calendar(s) on selection.
//   4. Typing an arbitrary domain into the free-text box and pressing
//      Fetch works the same way, for a domain that was never favorited —
//      AND, since that domain (Domain A) has published more than one
//      calendar, the Remote tab discovers its manifest and offers its own
//      source picker too, not just its domain-wide calendar.
//   5. Fetching a domain that published exactly one calendar (Domain B)
//      hides that source picker — nothing to pick between.
//   6. An unreachable domain shows a clean error message rather than
//      throwing or leaving a stale render on screen.
//
// Requires issuer-server on 8001 AND 8002 (this test does not start
// either itself, same convention as every other cross-domain test in
// this suite — see README.md's "Serve the two demo domains locally").
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const RUN_TAG = Date.now(); // keeps this run's seeded events distinguishable from any other run's leftovers

function post(base, urlPath, body) {
  return fetch(base + urlPath, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

function b64url(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Same canonicalize() shape as extension/wallet.js and issuer-server/
// server.js's own crypto helpers — sorted-key JSON, no whitespace.
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

async function genIdentity() {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const raw = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
  return { kp, publicKey: b64url(raw) };
}

// Mirrors extension/wallet.js's signWithSelf() — a raw-ecdsa self-signed
// envelope, the same one verifyEnvelope() on the server checks.
async function signWithSelf(kp, publicKey, payload) {
  const data = new TextEncoder().encode(canonicalize(payload));
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, data));
  return { signerRole: 'raw-ecdsa', publicKey, signature: b64url(sig) };
}

// POST /atlas/calendar now requires a registered domain admin's signature
// (requireAdmin(), issuer-server/server.js) — this test seeds events on
// BOTH demo domains, so the same identity is registered on both instances'
// admin rosters, the same "plain operator-edited JSON" bootstrap a real
// domain operator would do by hand.
function seedAdmin(stateDir, publicKey) {
  fs.writeFileSync(path.join(stateDir, 'atlas-admin-keys-store.json'), JSON.stringify({ keys: [{ publicKey, addedAt: new Date().toISOString() }] }, null, 2));
}

async function postAsAdmin(base, urlPath, admin, payload) {
  const proof = await signWithSelf(admin.kp, admin.publicKey, payload);
  return post(base, urlPath, { payload, proof });
}

async function seedEvent(base, admin, worldId, title, dateTime) {
  const res = await postAsAdmin(base, '/atlas/calendar', admin, { action: 'add', worldId, event: { title, dateTime } });
  if (res.status !== 200) throw new Error('Failed to seed "' + title + '" at ' + base + ': ' + JSON.stringify(res.body));
  return res.body.id;
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
  await frame.locator('#walletBtn').click(); // close the panel — later steps re-open it via the same toggle
}

async function openCalendarModeSubtab(frame, subtabBtnId, subscreenId) {
  const panelOpen = await frame.evaluate(() => document.getElementById('walletPanel').classList.contains('open'));
  if (!panelOpen) await frame.locator('#walletBtn').click();
  await frame.locator('#socialTabBtn').click();
  await frame.waitForFunction(() => document.getElementById('socialScreen').classList.contains('active'), { timeout: 5000 });
  await frame.locator('#calendarSubtabBtn').click();
  await frame.waitForFunction(() => document.getElementById('calendarSubscreen').classList.contains('active'), { timeout: 5000 });
  await frame.locator('#' + subtabBtnId).click();
  await frame.waitForFunction((id) => document.getElementById(id).classList.contains('active'), subscreenId, { timeout: 5000 });
}

(async () => {
  const dir = path.resolve(__dirname, '.chrome-profile-calendar-remote');
  const launchOpts = { headless: false, executablePath: '/opt/pw-browsers/chromium', args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox'] };
  const context = await chromium.launchPersistentContext(dir, launchOpts);
  const seededIds = [];
  let admin;

  try {
    admin = await genIdentity();
    seedAdmin(path.resolve(__dirname, '..', 'issuer-server'), admin.publicKey);
    seedAdmin(path.resolve(__dirname, '..', 'issuer-server', 'domain-b-state'), admin.publicKey);

    console.log('SETUP: seed a domain-wide and a plaza-world event on Domain A, and a domain-wide event on Domain B');
    seededIds.push({ base: 'http://localhost:8001', id: await seedEvent('http://localhost:8001', admin, null, 'All-Domain Festival ' + RUN_TAG, '2028-06-01T18:00:00.000Z') });
    seededIds.push({ base: 'http://localhost:8001', id: await seedEvent('http://localhost:8001', admin, 'plaza', 'Plaza Meetup ' + RUN_TAG, '2028-05-01T12:00:00.000Z') });
    seededIds.push({ base: 'http://localhost:8002', id: await seedEvent('http://localhost:8002', admin, null, 'Workshop Open House ' + RUN_TAG, '2028-07-01T09:00:00.000Z') });
    console.log('PASS: seeded 3 events across the two demo domains');

    const { frame } = await openOverlay(context, 'Visitor');
    await createIdentity(frame, 'calendar-remote-test-password');
    console.log('PASS: identity created');

    console.log('STEP 1: open Calendar -> Domain — dropdown lists both the domain-wide calendar and the current world\'s own, defaulting to the current world');
    await openCalendarModeSubtab(frame, 'calendarDomainSubtabBtn', 'calendarDomainSubscreen');
    const domainLabel = await frame.locator('#calendarDomainSubtabBtn').textContent();
    if (domainLabel !== 'localhost:8001') throw new Error('Expected the Domain tab\'s label to be the actual domain, got: ' + domainLabel);
    const optionTexts = await frame.locator('#calendarDomainSourceSelect option').allTextContents();
    if (!optionTexts.includes('Domain-wide') || !optionTexts.includes('Example Plaza')) {
      throw new Error('Expected both "Domain-wide" and "Example Plaza" options, got: ' + JSON.stringify(optionTexts));
    }
    const defaultValue = await frame.locator('#calendarDomainSourceSelect').inputValue();
    if (defaultValue !== 'plaza') throw new Error('Expected the dropdown to default to the current world ("plaza"), got: ' + defaultValue);
    await frame.waitForFunction((tag) => document.getElementById('calendarDomainEventsList').textContent.includes('Plaza Meetup ' + tag), RUN_TAG, { timeout: 10000 });
    console.log('PASS: defaulted to the plaza world\'s own calendar and rendered its event');

    console.log('STEP 2: switching to "Domain-wide" re-fetches and shows the OTHER calendar, not a stale copy');
    await frame.locator('#calendarDomainSourceSelect').selectOption('');
    await frame.waitForFunction((tag) => document.getElementById('calendarDomainEventsList').textContent.includes('All-Domain Festival ' + tag), RUN_TAG, { timeout: 10000 });
    const domainWideText = await frame.locator('#calendarDomainEventsList').textContent();
    if (domainWideText.includes('Plaza Meetup ' + RUN_TAG)) throw new Error('Expected the domain-wide view to NOT still show the plaza-world event');
    console.log('PASS: switching sources re-fetched cleanly, no stale event left over from the previous selection');

    console.log('STEP 3: favorite Domain B (published only ONE calendar), select it from the dropdown — the source picker stays hidden');
    await frame.evaluate(() => AtlasWallet.addFavoriteDomain({
      domain: 'localhost:8002', manifestUrl: 'http://localhost:8002/.well-known/spatial.json', worldId: 'workshop', worldName: 'Neighbor Workshop'
    }));
    await openCalendarModeSubtab(frame, 'calendarRemoteSubtabBtn', 'calendarRemoteSubscreen');
    await frame.waitForFunction(() => Array.from(document.getElementById('calendarRemoteFavoriteSelect').options).some((o) => o.value === 'localhost:8002'), { timeout: 5000 });
    await frame.locator('#calendarRemoteFavoriteSelect').selectOption('localhost:8002');
    await frame.waitForFunction((tag) => document.getElementById('calendarRemoteEventsList').textContent.includes('Workshop Open House ' + tag), RUN_TAG, { timeout: 10000 });
    const remoteDomainInputValue = await frame.locator('#calendarRemoteDomainInput').inputValue();
    if (remoteDomainInputValue !== 'localhost:8002') throw new Error('Expected picking a favorite to also fill in the domain text box, got: ' + remoteDomainInputValue);
    const sourcePickerHiddenForB = await frame.locator('#calendarRemoteSourceSelect').isHidden();
    if (!sourcePickerHiddenForB) throw new Error('Expected the source picker to stay hidden for a domain that only published one calendar');
    console.log('PASS: selecting a favorite fetched and rendered its remote calendar, with no picker to choose between (only one exists)');

    console.log('STEP 4: typing Domain A (published TWO calendars) and pressing Fetch discovers its manifest and offers a source picker, defaulting to domain-wide');
    await frame.locator('#calendarRemoteDomainInput').fill('localhost:8001');
    await frame.locator('#calendarRemoteFetchBtn').click();
    await frame.waitForFunction((tag) => document.getElementById('calendarRemoteEventsList').textContent.includes('All-Domain Festival ' + tag), RUN_TAG, { timeout: 10000 });
    const remoteSourceVisible = await frame.locator('#calendarRemoteSourceSelect').isVisible();
    if (!remoteSourceVisible) throw new Error('Expected the source picker to be visible for a domain with more than one published calendar');
    const remoteOptionTexts = await frame.locator('#calendarRemoteSourceSelect option').allTextContents();
    if (!remoteOptionTexts.includes('Domain-wide') || !remoteOptionTexts.includes('Example Plaza')) {
      throw new Error('Expected both "Domain-wide" and "Example Plaza" options for Domain A, got: ' + JSON.stringify(remoteOptionTexts));
    }
    const remoteDefaultValue = await frame.locator('#calendarRemoteSourceSelect').inputValue();
    if (remoteDefaultValue !== '') throw new Error('Expected the remote source picker to default to the domain-wide entry, got: ' + remoteDefaultValue);
    console.log('PASS: fetching a typed-in domain remotely discovered and defaulted to its domain-wide calendar');

    console.log('STEP 5: switching the remote source picker to "Example Plaza" re-fetches that world\'s own calendar instead');
    await frame.locator('#calendarRemoteSourceSelect').selectOption('plaza');
    await frame.waitForFunction((tag) => document.getElementById('calendarRemoteEventsList').textContent.includes('Plaza Meetup ' + tag), RUN_TAG, { timeout: 10000 });
    const remoteEventsAfterSwitch = await frame.locator('#calendarRemoteEventsList').textContent();
    if (remoteEventsAfterSwitch.includes('All-Domain Festival')) throw new Error('Expected switching the remote source to clear the previous selection\'s event');
    console.log('PASS: switching the remote picker fetched the plaza world\'s own calendar remotely, not a stale copy of the domain-wide one');

    console.log('STEP 6: an unreachable domain shows a clean error instead of a stale render or a thrown exception');
    await frame.locator('#calendarRemoteDomainInput').fill('localhost:9999');
    await frame.locator('#calendarRemoteFetchBtn').click();
    await frame.waitForFunction(() => document.getElementById('calendarRemoteStatus').textContent.includes('Could not reach'), { timeout: 10000 });
    const remoteListAfterError = await frame.locator('#calendarRemoteEventsList').textContent();
    if (remoteListAfterError.includes('Plaza Meetup') || remoteListAfterError.includes('All-Domain Festival')) throw new Error('Expected the stale render to be cleared on a failed fetch');
    const sourcePickerHiddenAfterError = await frame.locator('#calendarRemoteSourceSelect').isHidden();
    if (!sourcePickerHiddenAfterError) throw new Error('Expected the source picker to be cleared/hidden after a failed fetch, not left showing the previous domain\'s options');
    console.log('PASS: an unreachable domain fails cleanly with a status message, no stale event list or source picker left behind');

    console.log('\nALL CALENDAR REMOTE/DOMAIN UI CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    for (const { base, id } of seededIds) {
      try { await postAsAdmin(base, '/atlas/calendar', admin, { action: 'remove', id }); } catch (err) {}
    }
    await context.close();
  }
})();
