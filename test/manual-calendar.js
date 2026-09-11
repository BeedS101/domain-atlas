// Manual check for the Calendar sub-tab under Social (alongside Mail /
// Friends / Favorites): adding an event and seeing the list stay sorted
// soonest-first, editing and deleting an event, the overdue/"due soon"
// badge count (on both the Calendar sub-tab and the outer Social tab)
// updating as events are added/edited/deleted, the "Add to calendar"
// bridge from a mail card's "⋯" menu correctly pre-filling the add-event
// form (title = mail subject, notes = an excerpt of the mail body, date/
// time left BLANK for the user to set — see prefillCalendarEventFromMail's
// own comment in viewer.js on why this never invents a date), the
// persistent month-grid widget above the form/list (STEPS 6-9): today
// marked, prev/next month navigation across month AND year boundaries
// (including December -> January and a short month like February), a day
// with an existing event showing its marker dot and a day without one
// not, and clicking a day setting the add/edit form's date field — and the
// day-viewer widget underneath the month grid (STEPS 10-13, see
// renderCalendarDayViewer in viewer.js): clicking a day with an event shows
// it placed at its right hour, clicking an empty day shows the same
// empty-state wording the main event list uses, clicking a DIFFERENT day
// updates the view live, clicking an event inside the day view opens the
// exact same edit flow the main list's "Edit" button uses (and Cancel/Save
// from there behaves the same as it does from the main list), and the
// widget clears itself both on a fresh sub-tab open and when the add/edit
// form is reset.
//
// STEPS 14-19 cover the optional end time (endDateTime in wallet.js) added
// on top of all of the above: a same-day ranged event shows "start – end"
// on the list card while an end-less event still renders exactly as
// before (backward compatibility — STEP 15), end-before-start is rejected
// inline without ever reaching AtlasWallet (STEP 16), overdue/due-soon now
// key off the END time once one exists rather than the start (STEP 17,
// see calendarEventUrgencyMs in viewer.js), a multi-day event's month-grid
// dot appears on every day it spans rather than just its start day (STEP
// 18), and the day-viewer widget shows the right portion of a multi-day
// event on each of the days it touches — its start day, a full day it
// merely runs through, and its end day (STEP 19, see
// calendarDayRoleForEntry in viewer.js).
//
// Entirely local (AtlasWallet.getCalendarEvents/addCalendarEvent/
// updateCalendarEvent/removeCalendarEvent in wallet.js) — no domain or
// server is ever involved in an event itself. The mail-setup half of this
// test (STEP 5) reuses the exact same real subscribe + /atlas/mail/send
// flow manual-mail.js already uses, rather than inventing a new way to get
// a message into the Inbox.
//
// Requires issuer-server on 8001 (this test does not start it itself, same
// as manual-mail.js/manual-mail-management.js).
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { chromium } = require('playwright');
const path = require('path');
const http = require('http');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');

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

// Same "YYYY-MM-DDTHH:mm" shape <input type="datetime-local"> needs, in
// this machine's local time — mirrors toDatetimeLocalValue() in viewer.js
// so the offsets below land exactly where each assertion expects them to.
function toLocalInputValue(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + 'T' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

// Same 'YYYY-MM-DD' local-day key the month-grid widget itself keys its
// cells by (toLocalDateKey in viewer.js) — used here to compute, in this
// SAME node process (same machine, same local timezone as the browser
// under test), which cell in the rendered grid a given date should land
// on, without duplicating any date math the widget doesn't already do.
function toLocalDateKey(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
}

// Reads the month-grid widget's current rendered state back out of the
// page: the header label text, and one entry per day cell (its date key,
// whether it's a dimmed leading/trailing day from an adjacent month,
// whether it carries the .today / .selected markers, and whether it shows
// an event dot) — everything the STEP 6-9 assertions below check.
async function gridInfo(frame) {
  return frame.evaluate(() => ({
    label: document.getElementById('calendarMonthLabel').textContent,
    cells: Array.from(document.querySelectorAll('#calendarMonthGrid .calendar-grid-day')).map((el) => ({
      date: el.dataset.date,
      otherMonth: el.classList.contains('other-month'),
      today: el.classList.contains('today'),
      selected: el.classList.contains('selected'),
      hasDot: !!el.querySelector('.calendar-grid-dot')
    }))
  }));
}

// Reads the day-viewer widget's current rendered state back out of the
// page: whether it's hidden at all, its header text, and — per event chip
// inside it — its id, displayed text, whether it landed in the hour-row
// grid or the "Other times" bucket (and which hour row, if the former).
// Used by STEPS 10-13 below.
async function dayViewerInfo(frame) {
  return frame.evaluate(() => {
    const el = document.getElementById('calendarDayViewer');
    const chips = Array.from(document.querySelectorAll('#calendarDayViewer .calendar-day-event')).map((chip) => {
      const hourRow = chip.closest('.calendar-day-hour-row');
      // A section container (.calendar-day-viewer-other) is used for BOTH
      // the "All day" (through-days of a multi-day event, STEP 19) and
      // "Other times" (an hour outside the 6am-11pm range, STEP 10)
      // buckets — distinguished here by that section's own label text
      // rather than a class, since renderCalendarDayViewer in viewer.js
      // doesn't give the two buckets their own classes either.
      const section = chip.closest('.calendar-day-viewer-other');
      const sectionLabel = section ? section.querySelector('.calendar-day-viewer-other-label').textContent : null;
      return {
        id: chip.dataset.id,
        text: chip.textContent,
        overdue: chip.classList.contains('overdue'),
        hasDuration: chip.classList.contains('has-duration'),
        zone: section ? (sectionLabel === 'All day' ? 'all-day' : 'other') : (hourRow ? 'hour' : 'unknown'),
        hourLabel: hourRow ? hourRow.querySelector('.calendar-day-hour-label').textContent : null
      };
    });
    return {
      hidden: el.hidden,
      header: document.getElementById('calendarDayViewerHeader').textContent,
      bodyText: document.getElementById('calendarDayViewerBody').textContent,
      chips
    };
  });
}

async function waitFor(frame, fn, description, timeoutMs = 8000, arg) {
  const start = Date.now();
  for (;;) {
    const result = await frame.evaluate(fn, arg);
    if (result) return result;
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for: ' + description);
    await new Promise((r) => setTimeout(r, 150));
  }
}

// Caller is responsible for waiting on the actual effect afterward (the
// list's new event count, a badge value, etc.) — chrome.storage.local
// writes are async, so "the click resolved" isn't itself proof the event
// landed.
async function addEvent(frame, title, date, notes) {
  await frame.locator('#calendarEventTitleInput').fill(title);
  await frame.locator('#calendarEventDateTimeInput').fill(toLocalInputValue(date));
  await frame.locator('#calendarEventNotesInput').fill(notes || '');
  await frame.locator('#calendarSaveEventBtn').click();
}

// Same as addEvent above but also fills the optional end-time field —
// used by STEPS 14+ below. Pass `end` as null/undefined for the plain
// no-end-time case (equivalent to addEvent, just routed through the same
// helper so both share one call shape).
async function addEventWithEnd(frame, title, date, end, notes) {
  await frame.locator('#calendarEventTitleInput').fill(title);
  await frame.locator('#calendarEventDateTimeInput').fill(toLocalInputValue(date));
  await frame.locator('#calendarEventEndDateTimeInput').fill(end ? toLocalInputValue(end) : '');
  await frame.locator('#calendarEventNotesInput').fill(notes || '');
  await frame.locator('#calendarSaveEventBtn').click();
}

async function eventTitlesInOrder(frame) {
  return frame.evaluate(() => Array.from(document.querySelectorAll('#calendarEventsList .calendar-event .name')).map((el) => el.textContent));
}

// Reads back the "when" line + overdue state of a specific card, by title
// — used by STEPS 14/15/17 below rather than scraping the whole list.
async function eventCardInfo(frame, title) {
  return frame.evaluate((t) => {
    const cards = Array.from(document.querySelectorAll('#calendarEventsList .calendar-event'));
    const card = cards.find((c) => c.querySelector('.name').textContent === t);
    if (!card) return null;
    return {
      when: card.querySelector('.calendar-event-when').textContent,
      overdue: card.classList.contains('overdue')
    };
  }, title);
}

// The repeated "delete every event, wait for the list to actually go
// empty" clean-slate sequence STEPs 6/etc. already used inline — pulled
// out here so STEPS 14+ can reset between scenarios without copy-pasting
// the dialog-accept dance each time.
async function deleteAllCalendarEvents(page, frame) {
  for (;;) {
    const remaining = await frame.locator('#calendarEventsList button[data-action="delete-calendar-event"]').count();
    if (remaining === 0) break;
    page.once('dialog', (d) => d.accept());
    await frame.locator('#calendarEventsList button[data-action="delete-calendar-event"]').first().click();
    await page.waitForTimeout(200);
  }
  await frame.waitForFunction(() => document.querySelectorAll('#calendarEventsList .calendar-event').length === 0, { timeout: 5000 });
}

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-calendar');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  });

  try {
    const page = await context.newPage();

    console.log('SETUP: identity, open Social -> Calendar');
    await page.goto('http://localhost:8001', { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    await frame.locator('#walletBtn').click();
    await frame.locator('#chooseNewBtn').click();
    await frame.locator('#newPasswordInput').fill('calendar-test-password');
    await frame.locator('#newPasswordConfirmInput').fill('calendar-test-password');
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('#socialTabBtn').click();
    await frame.locator('#calendarSubtabBtn').click();
    await frame.waitForFunction(() => document.getElementById('calendarSubscreen').classList.contains('active'), { timeout: 5000 });
    const emptyText = await frame.locator('#calendarEventsList').textContent();
    if (!emptyText.includes('No events yet')) throw new Error('Expected an empty-state note before any event exists, got: ' + emptyText);
    console.log('PASS: Calendar sub-tab opens with no events yet');

    const now = new Date();

    console.log('STEP 1: add three events OUT OF chronological order — the list should still render soonest-first');
    await addEvent(frame, 'Third (latest)', new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000), 'Added first, happens last');
    await frame.waitForFunction(() => document.querySelectorAll('#calendarEventsList .calendar-event').length === 1, { timeout: 5000 });
    await addEvent(frame, 'First (soonest)', new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000), 'Added second, happens first');
    await frame.waitForFunction(() => document.querySelectorAll('#calendarEventsList .calendar-event').length === 2, { timeout: 5000 });
    await addEvent(frame, 'Second (middle)', new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000), 'Added third, happens second');
    await frame.waitForFunction(() => document.querySelectorAll('#calendarEventsList .calendar-event').length === 3, { timeout: 5000 });
    const titles = await eventTitlesInOrder(frame);
    if (JSON.stringify(titles) !== JSON.stringify(['First (soonest)', 'Second (middle)', 'Third (latest)'])) {
      throw new Error('Expected events sorted soonest-first regardless of add order, got: ' + JSON.stringify(titles));
    }
    console.log('PASS: three events added out of order render sorted soonest-first ->', titles);

    console.log('STEP 2: edit the middle event — push its date out past the third event, confirm it re-sorts to last');
    await frame.locator('#calendarEventsList .calendar-event', { hasText: 'Second (middle)' }).locator('button[data-action="edit-calendar-event"]').click();
    await frame.waitForFunction(() => document.getElementById('calendarSaveEventBtn').textContent === 'Save changes', { timeout: 5000 });
    const titleValueWhileEditing = await frame.locator('#calendarEventTitleInput').inputValue();
    if (titleValueWhileEditing !== 'Second (middle)') throw new Error('Expected the edit form to pre-fill the existing title, got: ' + titleValueWhileEditing);
    await frame.locator('#calendarEventTitleInput').fill('Second, now last');
    await frame.locator('#calendarEventDateTimeInput').fill(toLocalInputValue(new Date(now.getTime() + 4 * 24 * 60 * 60 * 1000)));
    await frame.locator('#calendarSaveEventBtn').click();
    await frame.waitForFunction(() => document.getElementById('calendarSaveEventBtn').textContent === 'Add event', { timeout: 5000 });
    const titlesAfterEdit = await eventTitlesInOrder(frame);
    if (JSON.stringify(titlesAfterEdit) !== JSON.stringify(['First (soonest)', 'Third (latest)', 'Second, now last'])) {
      throw new Error('Expected the edited event to re-sort to the end, got: ' + JSON.stringify(titlesAfterEdit));
    }
    console.log('PASS: edited event kept its identity (not duplicated) and re-sorted by its new date ->', titlesAfterEdit);

    console.log('STEP 3: delete "Third (latest)" — exactly one event disappears, the other two remain');
    page.once('dialog', (d) => d.accept());
    await frame.locator('#calendarEventsList .calendar-event', { hasText: 'Third (latest)' }).locator('button[data-action="delete-calendar-event"]').click();
    await frame.waitForFunction(() => document.querySelectorAll('#calendarEventsList .calendar-event').length === 2, { timeout: 5000 });
    const titlesAfterDelete = await eventTitlesInOrder(frame);
    if (JSON.stringify(titlesAfterDelete) !== JSON.stringify(['First (soonest)', 'Second, now last'])) {
      throw new Error('Expected exactly the two remaining events after delete, got: ' + JSON.stringify(titlesAfterDelete));
    }
    console.log('PASS: delete removed exactly the targeted event ->', titlesAfterDelete);

    console.log('STEP 4: clean slate, then the overdue/due-soon badge — one overdue, one due within 24h, one far in the future; badge should count exactly the first two');
    for (;;) {
      const remaining = await frame.locator('#calendarEventsList button[data-action="delete-calendar-event"]').count();
      if (remaining === 0) break;
      page.once('dialog', (d) => d.accept());
      await frame.locator('#calendarEventsList button[data-action="delete-calendar-event"]').first().click();
      await page.waitForTimeout(200);
    }
    await frame.waitForFunction(() => document.querySelectorAll('#calendarEventsList .calendar-event').length === 0, { timeout: 5000 });

    await addEvent(frame, 'Overdue meeting', new Date(now.getTime() - 60 * 60 * 1000), 'This already happened');
    await frame.waitForFunction(() => document.querySelectorAll('#calendarEventsList .calendar-event').length === 1, { timeout: 5000 });
    const overdueIsMarked = await frame.evaluate(() => document.querySelector('#calendarEventsList .calendar-event').classList.contains('overdue'));
    if (!overdueIsMarked) throw new Error('Expected a past-dated event to carry the .overdue class');
    const overdueCardText = await frame.locator('#calendarEventsList .calendar-event').first().textContent();
    if (!overdueCardText.includes('overdue')) throw new Error('Expected the overdue card to visibly say so: ' + overdueCardText);
    console.log('PASS: a past-dated event renders visually distinct (.overdue) with an explicit "overdue" label');

    await addEvent(frame, 'Due soon (in 2h)', new Date(now.getTime() + 2 * 60 * 60 * 1000), '');
    await frame.waitForFunction(() => document.querySelectorAll('#calendarEventsList .calendar-event').length === 2, { timeout: 5000 });
    await addEvent(frame, 'Far future (in 3 days)', new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000), '');
    await frame.waitForFunction(() => document.querySelectorAll('#calendarEventsList .calendar-event').length === 3, { timeout: 5000 });

    await frame.waitForFunction(() => document.getElementById('calendarBadge').textContent === '2', { timeout: 5000 });
    const calendarBadgeShown = await frame.evaluate(() => document.getElementById('calendarBadge').classList.contains('show'));
    if (!calendarBadgeShown) throw new Error('Expected the Calendar sub-tab badge to be visible with 2 due/overdue events');
    console.log('PASS: Calendar sub-tab badge shows 2 (overdue + due-within-24h), excluding the far-future event');

    const socialBadgeText = await frame.locator('#socialBadge').textContent();
    if (socialBadgeText !== '2') throw new Error('Expected the outer Social tab badge to also show 2 (no mail/friend-requests yet), got: ' + socialBadgeText);
    console.log('PASS: the outer Social tab badge folds the same count in (no mail or friend requests yet to add to it)');

    console.log('STEP 4b: deleting the overdue event drops the badge to 1');
    page.once('dialog', (d) => d.accept());
    await frame.locator('#calendarEventsList .calendar-event', { hasText: 'Overdue meeting' }).locator('button[data-action="delete-calendar-event"]').click();
    await frame.waitForFunction(() => document.getElementById('calendarBadge').textContent === '1', { timeout: 5000 });
    console.log('PASS: badge count drops immediately after deleting the overdue event');

    console.log('STEP 5: "Add to calendar" from a mail card — real subscribe + /atlas/mail/send flow, same as manual-mail.js');
    const membership = await frame.evaluate(async () => AtlasWallet.mintAsset('self', 'localhost:8001', 'atlas.membership'));
    if (membership.verdict && membership.verdict.valid === false) throw new Error('Membership card did not verify: ' + membership.verdict.reason);
    const credentialId = membership.credential.id;
    const longBody = 'Please remember to bring the signed paperwork and arrive fifteen minutes early so we have time to go over the agenda together before everyone else shows up for the walkthrough.';
    const sent = await postJson(8001, '/atlas/mail/send', {
      credentialId,
      subject: 'Reminder: paperwork walkthrough',
      body: longBody
    });
    if (!sent.id) throw new Error('Expected /atlas/mail/send to return a signed message, got: ' + JSON.stringify(sent));
    console.log('PASS: mail message sent and signed ->', sent.subject);

    await frame.locator('#mailSubtabBtn').click();
    await frame.waitForFunction((subj) => {
      const cards = Array.from(document.querySelectorAll('#mailList .mail-card'));
      return cards.some((c) => c.textContent.includes(subj));
    }, sent.subject, { timeout: 10000 });
    console.log('PASS: the mail message arrived in the Inbox');

    const mailCard = frame.locator('#mailList .mail-card', { hasText: sent.subject });
    await mailCard.locator('button[data-action="toggle-mail-menu"]').click();
    await mailCard.locator('button[data-action="add-mail-to-calendar"]').click();

    await frame.waitForFunction(() => document.getElementById('calendarSubscreen').classList.contains('active'), { timeout: 5000 });
    console.log('PASS: "Add to calendar" jumped straight to the Calendar sub-tab');

    // The sub-tab going active happens synchronously (showSocialSubtab),
    // but the pre-fill itself lands after an await chain (resetting the
    // month-grid widget to today, then refreshCalendarDisplay's own
    // storage read) — wait on the actual field content, same
    // "caller waits for the real effect" convention addEvent's own
    // comment above documents, rather than assuming sub-tab-active alone
    // means the fields are already populated.
    await frame.waitForFunction((subj) => document.getElementById('calendarEventTitleInput').value === subj, sent.subject, { timeout: 5000 });
    const prefilledTitle = await frame.locator('#calendarEventTitleInput').inputValue();
    if (prefilledTitle !== sent.subject) throw new Error('Expected the title field pre-filled with the mail subject, got: ' + prefilledTitle);
    const prefilledDate = await frame.locator('#calendarEventDateTimeInput').inputValue();
    if (prefilledDate !== '') throw new Error('Expected the date/time field left BLANK (mail body cannot be reliably parsed for a real date), got: ' + prefilledDate);
    const prefilledNotes = await frame.locator('#calendarEventNotesInput').inputValue();
    if (!prefilledNotes.includes('From mail:')) throw new Error('Expected the notes field to reference the mail message, got: ' + prefilledNotes);
    if (!longBody.startsWith(prefilledNotes.replace('From mail: ', '').replace('…', ''))) {
      throw new Error('Expected the notes excerpt to be a prefix of the actual mail body, got: ' + prefilledNotes);
    }
    console.log('PASS: title = mail subject, notes = an excerpt of the mail body, date/time left blank for the user -> "' + prefilledNotes.slice(0, 60) + '…"');

    console.log('STEP 5b: the user still has to pick a date/time before this becomes a real event — submitting one now completes the bridge');
    const bridgeDate = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000);
    await frame.locator('#calendarEventDateTimeInput').fill(toLocalInputValue(bridgeDate));
    await frame.locator('#calendarSaveEventBtn').click();
    await frame.waitForFunction((subj) => {
      const cards = Array.from(document.querySelectorAll('#calendarEventsList .calendar-event .name'));
      return cards.some((c) => c.textContent === subj);
    }, sent.subject, { timeout: 5000 });
    console.log('PASS: the bridged event was saved once a date/time was actually chosen');

    console.log('STEP 6: clean slate, reopen the Calendar sub-tab (resets the month-grid widget to the real current month), check the grid shape + today marker');
    for (;;) {
      const remaining = await frame.locator('#calendarEventsList button[data-action="delete-calendar-event"]').count();
      if (remaining === 0) break;
      page.once('dialog', (d) => d.accept());
      await frame.locator('#calendarEventsList button[data-action="delete-calendar-event"]').first().click();
      await page.waitForTimeout(200);
    }
    await frame.waitForFunction(() => document.querySelectorAll('#calendarEventsList .calendar-event').length === 0, { timeout: 5000 });
    // Leaving and reopening the sub-tab is the documented way the widget
    // snaps back to today (resetCalendarGridToToday) — matters here because
    // STEP 9 below will have stepped it away to other months.
    await frame.locator('#mailSubtabBtn').click();
    await frame.locator('#calendarSubtabBtn').click();
    await frame.waitForFunction(() => document.getElementById('calendarSubscreen').classList.contains('active'), { timeout: 5000 });

    const realNow = new Date();
    const realTodayKey = toLocalDateKey(realNow);
    const realDaysInMonth = new Date(realNow.getFullYear(), realNow.getMonth() + 1, 0).getDate();
    const expectedLabel = realNow.toLocaleString(undefined, { month: 'long', year: 'numeric' });

    let grid = await gridInfo(frame);
    if (grid.label !== expectedLabel) throw new Error('Expected the widget to open on the real current month "' + expectedLabel + '", got: ' + grid.label);
    if (grid.cells.length % 7 !== 0) throw new Error('Expected a clean rectangle (a multiple of 7 cells), got ' + grid.cells.length);
    const todayCells = grid.cells.filter((c) => c.today);
    if (todayCells.length !== 1 || todayCells[0].date !== realTodayKey) {
      throw new Error('Expected exactly one cell marked .today, matching ' + realTodayKey + ', got: ' + JSON.stringify(todayCells));
    }
    const inMonthCells = grid.cells.filter((c) => !c.otherMonth);
    if (inMonthCells.length !== realDaysInMonth) {
      throw new Error('Expected ' + realDaysInMonth + ' in-month cells for ' + expectedLabel + ', got ' + inMonthCells.length);
    }
    const otherMonthCells = grid.cells.filter((c) => c.otherMonth);
    if (grid.cells.length - realDaysInMonth !== otherMonthCells.length) throw new Error('Cell accounting mismatch: total/in-month/other-month don\'t add up');
    console.log('PASS: widget opened on "' + expectedLabel + '" with a clean ' + (grid.cells.length / 7) + '-row rectangle, today marked exactly once at ' + realTodayKey);

    console.log('STEP 7: event markers — a day with an event gets a dot, a day without one doesn\'t');
    // Picks a day comfortably inside the currently-displayed month (not
    // today, so its dot isn't confused with the today marker) rather than
    // today itself, so the two visual cues stay independently checkable.
    const markerDay = realNow.getDate() <= 15 ? realNow.getDate() + 10 : realNow.getDate() - 10;
    const markerDate = new Date(realNow.getFullYear(), realNow.getMonth(), markerDay, 9, 0);
    const markerKey = toLocalDateKey(markerDate);
    const blankDay = markerDay > 15 ? markerDay - 5 : markerDay + 5; // still inside the month, deliberately bare
    const blankKey = toLocalDateKey(new Date(realNow.getFullYear(), realNow.getMonth(), blankDay));
    await addEvent(frame, 'Marker test event', markerDate, '');
    await frame.waitForFunction(() => document.querySelectorAll('#calendarEventsList .calendar-event').length === 1, { timeout: 5000 });
    grid = await gridInfo(frame);
    const markerCell = grid.cells.find((c) => c.date === markerKey && !c.otherMonth);
    const blankCell = grid.cells.find((c) => c.date === blankKey && !c.otherMonth);
    if (!markerCell || !markerCell.hasDot) throw new Error('Expected ' + markerKey + ' to carry an event dot, got: ' + JSON.stringify(markerCell));
    if (!blankCell || blankCell.hasDot) throw new Error('Expected ' + blankKey + ' (no event) to carry no dot, got: ' + JSON.stringify(blankCell));
    console.log('PASS: ' + markerKey + ' (has an event) shows a dot; ' + blankKey + ' (no event) does not');

    console.log('STEP 8: click-to-select — clicking a day sets the form\'s date field, keeping an existing time or defaulting to 09:00');
    // The form is already in clean "add" mode here (STEP 7's addEvent call
    // both saved and reset it) — just make sure the date field itself
    // starts blank, since that's the "no time typed yet" case being tested.
    await frame.evaluate(() => { document.getElementById('calendarEventDateTimeInput').value = ''; });
    await frame.locator('#calendarMonthGrid .calendar-grid-day[data-date="' + blankKey + '"]').click();
    let dateFieldValue = await frame.locator('#calendarEventDateTimeInput').inputValue();
    if (dateFieldValue !== blankKey + 'T09:00') throw new Error('Expected an empty field to pick up the clicked day with a default 09:00 time, got: ' + dateFieldValue);
    let selectedCells = (await gridInfo(frame)).cells.filter((c) => c.selected);
    if (selectedCells.length !== 1 || selectedCells[0].date !== blankKey) throw new Error('Expected exactly the clicked day marked .selected, got: ' + JSON.stringify(selectedCells));
    console.log('PASS: clicking an empty day field set the date to ' + blankKey + ' with the 09:00 default time, and marked it selected');

    await frame.evaluate(() => { document.getElementById('calendarEventDateTimeInput').value = document.getElementById('calendarEventDateTimeInput').value.split('T')[0] + 'T14:30'; });
    await frame.locator('#calendarMonthGrid .calendar-grid-day[data-date="' + markerKey + '"]').click();
    dateFieldValue = await frame.locator('#calendarEventDateTimeInput').inputValue();
    if (dateFieldValue !== markerKey + 'T14:30') throw new Error('Expected clicking a new day to change only the date portion, keeping the existing 14:30 time, got: ' + dateFieldValue);
    selectedCells = (await gridInfo(frame)).cells.filter((c) => c.selected);
    if (selectedCells.length !== 1 || selectedCells[0].date !== markerKey) throw new Error('Expected selection to move to the newly clicked day only, got: ' + JSON.stringify(selectedCells));
    console.log('PASS: clicking a second day moved the date (kept the 14:30 time already typed) and moved the .selected marker, not duplicated it');

    console.log('STEP 9: month navigation — step back across a December -> January (previous year) boundary and through a February, one month at a time');
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    function parseLabel(label) {
      const parts = label.split(' ');
      const year = Number(parts[parts.length - 1]);
      const monthName = parts.slice(0, -1).join(' ');
      const month = monthNames.indexOf(monthName);
      if (month === -1 || Number.isNaN(year)) throw new Error('Could not parse month label: ' + label);
      return { year, month };
    }
    let prevParsed = parseLabel((await gridInfo(frame)).label); // starts on the real current month (STEP 6/7/8 never navigated away)
    let sawDecToJan = false;
    let sawFeb = false;
    for (let step = 0; step < 14; step++) {
      await frame.locator('#calendarPrevMonthBtn').click();
      const info = await gridInfo(frame);
      const parsed = parseLabel(info.label);
      const stepsBack = (prevParsed.year * 12 + prevParsed.month) - (parsed.year * 12 + parsed.month);
      if (stepsBack !== 1) throw new Error('Expected the ‹ button to step back exactly one month from ' + JSON.stringify(prevParsed) + ', landed on ' + JSON.stringify(parsed));
      if (prevParsed.month === 0 && parsed.month === 11 && parsed.year === prevParsed.year - 1) sawDecToJan = true;
      if (parsed.month === 1) {
        sawFeb = true;
        const isLeap = (parsed.year % 4 === 0 && parsed.year % 100 !== 0) || parsed.year % 400 === 0;
        const febDays = info.cells.filter((c) => !c.otherMonth).length;
        if (febDays !== (isLeap ? 29 : 28)) throw new Error('Expected February ' + parsed.year + ' to show ' + (isLeap ? 29 : 28) + ' in-month days (leap=' + isLeap + '), got ' + febDays);
      }
      if (info.cells.length % 7 !== 0) throw new Error('Expected a clean rectangle while navigating, got ' + info.cells.length + ' cells for ' + info.label);
      prevParsed = parsed;
    }
    if (!sawDecToJan) throw new Error('Expected 14 months of stepping back to cross at least one January -> December(previous year) boundary');
    if (!sawFeb) throw new Error('Expected 14 months of stepping back to pass through a February');
    console.log('PASS: 14 consecutive ‹ clicks each moved exactly one month, crossed a year boundary correctly, and rendered February with the right day count');

    console.log('STEP 9b: stepping forward the same number of times returns to the real current month');
    for (let step = 0; step < 14; step++) {
      await frame.locator('#calendarNextMonthBtn').click();
    }
    const backToLabel = (await gridInfo(frame)).label;
    if (backToLabel !== expectedLabel) throw new Error('Expected 14 › clicks to undo the 14 ‹ clicks and land back on ' + expectedLabel + ', got ' + backToLabel);
    console.log('PASS: › undid ‹ exactly, back on ' + expectedLabel);

    console.log('STEP 10: day viewer — click a day with an existing event; an event outside the 6am-11pm hour range shows in the "Other times" bucket instead of disappearing');
    // markerKey/markerDay/markerDate are still exactly what STEP 7 set them
    // to — STEP 9/9b's month navigation never changes calendarSelectedDate
    // or touches events, and we're back on the real current month.
    const earlyDate = new Date(realNow.getFullYear(), realNow.getMonth(), markerDay, 3, 15); // before CALENDAR_DAY_VIEW_START_HOUR (6am)
    await addEvent(frame, 'Very early call', earlyDate, '');
    await frame.waitForFunction(() => document.querySelectorAll('#calendarEventsList .calendar-event').length === 2, { timeout: 5000 });

    await frame.locator('#calendarMonthGrid .calendar-grid-day[data-date="' + markerKey + '"]').click();
    await frame.waitForFunction(() => document.querySelectorAll('#calendarDayViewer .calendar-day-event').length === 2, { timeout: 5000 });
    let dayInfo = await dayViewerInfo(frame);
    if (dayInfo.hidden) throw new Error('Expected the day viewer to be visible after clicking a day');
    const expectedHeader = markerDate.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    if (dayInfo.header !== expectedHeader) throw new Error('Expected the day-viewer header "' + expectedHeader + '", got: ' + dayInfo.header);
    const nineAmChip = dayInfo.chips.find((c) => c.text.includes('Marker test event'));
    const earlyChip = dayInfo.chips.find((c) => c.text.includes('Very early call'));
    if (!nineAmChip || nineAmChip.zone !== 'hour' || nineAmChip.hourLabel !== '9 AM' || !nineAmChip.text.includes('9:00 AM')) {
      throw new Error('Expected "Marker test event" under the 9 AM hour row with its exact time shown, got: ' + JSON.stringify(nineAmChip));
    }
    if (!earlyChip || earlyChip.zone !== 'other' || !earlyChip.text.includes('3:15 AM')) {
      throw new Error('Expected "Very early call" (3:15am, before the 6am-11pm range) in the "Other times" bucket, got: ' + JSON.stringify(earlyChip));
    }
    console.log('PASS: header reads "' + dayInfo.header + '", the 9am event is placed under the 9 AM hour row, and the 3:15am event (outside the hour range) shows in "Other times" instead of vanishing');

    console.log('STEP 11: day viewer updates LIVE when a different (empty) day is clicked — same empty-state wording/style as the main event list\'s own empty state');
    const expectedBlankHeader = new Date(realNow.getFullYear(), realNow.getMonth(), blankDay).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    await frame.locator('#calendarMonthGrid .calendar-grid-day[data-date="' + blankKey + '"]').click();
    // Waits for the header to actually change to the NEWLY clicked day's
    // text (not just "non-empty", which STEP 10's marker-day header already
    // satisfied) — the real proof this re-rendered live rather than sitting
    // stale on the previous selection.
    await waitFor(frame, (expected) => document.getElementById('calendarDayViewerHeader').textContent === expected, 'day-viewer header to update to the newly clicked day', 8000, expectedBlankHeader);
    dayInfo = await dayViewerInfo(frame);
    if (dayInfo.hidden) throw new Error('Expected the day viewer to stay visible (just showing a different, empty day)');
    if (dayInfo.header !== expectedBlankHeader) throw new Error('Expected the header to update to "' + expectedBlankHeader + '" for the newly clicked day, got: ' + dayInfo.header);
    if (dayInfo.chips.length !== 0) throw new Error('Expected no event chips for the empty day, got: ' + JSON.stringify(dayInfo.chips));
    if (!dayInfo.bodyText.includes('No events')) throw new Error('Expected an empty-state note for a day with no events, got: ' + dayInfo.bodyText);
    console.log('PASS: clicking a different day re-rendered the widget live -> "' + dayInfo.header + '" with empty-state text "' + dayInfo.bodyText.trim() + '"');

    console.log('STEP 12: clicking an event inside the day viewer opens the SAME edit flow as the main list\'s "Edit" button, and Save/Cancel from there behave the same as they do from the main list');
    await frame.locator('#calendarMonthGrid .calendar-grid-day[data-date="' + markerKey + '"]').click();
    await frame.waitForFunction(() => document.querySelectorAll('#calendarDayViewer .calendar-day-event').length === 2, { timeout: 5000 });
    await frame.locator('#calendarDayViewer .calendar-day-event', { hasText: 'Marker test event' }).click();
    await frame.waitForFunction(() => document.getElementById('calendarSaveEventBtn').textContent === 'Save changes', { timeout: 5000 });
    const editTitleValue = await frame.locator('#calendarEventTitleInput').inputValue();
    if (editTitleValue !== 'Marker test event') throw new Error('Expected clicking the day-viewer chip to pre-fill the same title the main list\'s Edit button would, got: ' + editTitleValue);
    console.log('PASS: clicking the day-viewer chip opened the add/edit form in edit mode, pre-filled exactly like the main list\'s Edit button');

    console.log('STEP 12b: Cancel edit (reached via the day-viewer chip) behaves the same as it does from the main list, and clears/hides the day viewer (calendarSelectedDate back to null)');
    await frame.locator('#calendarCancelEditBtn').click();
    await frame.waitForFunction(() => document.getElementById('calendarSaveEventBtn').textContent === 'Add event', { timeout: 5000 });
    dayInfo = await dayViewerInfo(frame);
    if (!dayInfo.hidden) throw new Error('Expected Cancel edit to hide the day viewer (resetCalendarForm clears calendarSelectedDate), stayed visible: ' + JSON.stringify(dayInfo));
    console.log('PASS: Cancel edit reset the form AND hid the day viewer, same as resetCalendarForm already does for the month grid\'s .selected highlight');

    console.log('STEP 12c: re-open via the day-viewer chip, this time actually Save changes — the rename lands in the main list, and the day viewer clears afterward same as a save from the main list already does');
    await frame.locator('#calendarMonthGrid .calendar-grid-day[data-date="' + markerKey + '"]').click();
    await frame.waitForFunction(() => document.querySelectorAll('#calendarDayViewer .calendar-day-event').length === 2, { timeout: 5000 });
    await frame.locator('#calendarDayViewer .calendar-day-event', { hasText: 'Marker test event' }).click();
    await frame.waitForFunction(() => document.getElementById('calendarSaveEventBtn').textContent === 'Save changes', { timeout: 5000 });
    await frame.locator('#calendarEventTitleInput').fill('Marker test event, renamed via day view');
    await frame.locator('#calendarSaveEventBtn').click();
    await frame.waitForFunction(() => document.getElementById('calendarSaveEventBtn').textContent === 'Add event', { timeout: 5000 });
    const renamedTitles = await eventTitlesInOrder(frame);
    if (!renamedTitles.includes('Marker test event, renamed via day view')) throw new Error('Expected the rename made via the day-viewer edit flow to land in the main list, got: ' + JSON.stringify(renamedTitles));
    dayInfo = await dayViewerInfo(frame);
    if (!dayInfo.hidden) throw new Error('Expected the day viewer to be hidden again after Save (resetCalendarForm runs on save too), stayed visible: ' + JSON.stringify(dayInfo));
    console.log('PASS: the edit made via the day-viewer chip saved correctly into the main list, and the widget cleared itself afterward exactly as it does after a save from the main list');

    console.log('STEP 13: the day viewer clears on a fresh sub-tab open, same as the month grid snapping back to today');
    await frame.locator('#calendarMonthGrid .calendar-grid-day[data-date="' + markerKey + '"]').click();
    await frame.waitForFunction(() => !document.getElementById('calendarDayViewer').hidden, { timeout: 5000 });
    await frame.locator('#mailSubtabBtn').click();
    await frame.locator('#calendarSubtabBtn').click();
    await frame.waitForFunction(() => document.getElementById('calendarSubscreen').classList.contains('active'), { timeout: 5000 });
    dayInfo = await dayViewerInfo(frame);
    if (!dayInfo.hidden) throw new Error('Expected a freshly (re)opened Calendar sub-tab to show no day view (nothing selected yet), stayed visible: ' + JSON.stringify(dayInfo));
    const noSelectionCells = (await gridInfo(frame)).cells.filter((c) => c.selected);
    if (noSelectionCells.length !== 0) throw new Error('Expected no cell marked .selected on a fresh sub-tab open, got: ' + JSON.stringify(noSelectionCells));
    console.log('PASS: reopening the Calendar sub-tab cleared both the month grid\'s selection and the day viewer, exactly like resetCalendarGridToToday\'s own "always start on today, nothing selected" rule');

    console.log('STEP 14: an end time on an event shows a "start – end" range on its list card instead of just the start time');
    await deleteAllCalendarEvents(page, frame);
    const rangedStart = new Date(realNow.getFullYear(), realNow.getMonth(), realNow.getDate() + 1, 14, 0);
    const rangedEnd = new Date(realNow.getFullYear(), realNow.getMonth(), realNow.getDate() + 1, 15, 30);
    await addEventWithEnd(frame, 'Ranged meeting', rangedStart, rangedEnd, '');
    await frame.waitForFunction(() => document.querySelectorAll('#calendarEventsList .calendar-event').length === 1, { timeout: 5000 });
    let rangedInfo = await eventCardInfo(frame, 'Ranged meeting');
    if (!rangedInfo) throw new Error('Expected the ranged event to appear in the list');
    if (!rangedInfo.when.includes('–')) throw new Error('Expected a "start – end" range (en dash) on the list card, got: ' + rangedInfo.when);
    if (!rangedInfo.when.includes('2:00 PM') || !rangedInfo.when.includes('3:30 PM')) {
      throw new Error('Expected both the start (2:00 PM) and end (3:30 PM) times in the range, got: ' + rangedInfo.when);
    }
    if (rangedInfo.overdue) throw new Error('Expected a future ranged event to not be marked overdue');
    console.log('PASS: list card shows the range -> "' + rangedInfo.when + '"');

    console.log('STEP 15: an event with only a start time still behaves exactly as before (backward compatibility)');
    const plainStart = new Date(realNow.getFullYear(), realNow.getMonth(), realNow.getDate() + 1, 10, 0);
    await addEventWithEnd(frame, 'Plain instant event', plainStart, null, '');
    await frame.waitForFunction(() => document.querySelectorAll('#calendarEventsList .calendar-event').length === 2, { timeout: 5000 });
    const plainInfo = await eventCardInfo(frame, 'Plain instant event');
    if (!plainInfo) throw new Error('Expected the end-less event to appear in the list');
    if (plainInfo.when.includes('–')) throw new Error('Expected NO range dash for an event with no end time, got: ' + plainInfo.when);
    // Unchanged formatCalendarWhen path for a no-end event is a bare
    // `toLocaleString()` (which includes seconds, e.g. "10:00:00 AM"),
    // deliberately different from the ranged format's seconds-free
    // "10:00 AM" above — see formatCalendarWhen's own comment on why.
    if (!plainInfo.when.includes('10:00:00 AM')) throw new Error('Expected the plain start time shown as before, got: ' + plainInfo.when);
    // The end field itself must also round-trip to blank on edit — an
    // end-less event opened for editing shouldn't suddenly grow one.
    await frame.locator('#calendarEventsList .calendar-event', { hasText: 'Plain instant event' }).locator('button[data-action="edit-calendar-event"]').click();
    await frame.waitForFunction(() => document.getElementById('calendarSaveEventBtn').textContent === 'Save changes', { timeout: 5000 });
    const endFieldOnEdit = await frame.locator('#calendarEventEndDateTimeInput').inputValue();
    if (endFieldOnEdit !== '') throw new Error('Expected the end field to stay blank when editing an event that never had one, got: ' + endFieldOnEdit);
    await frame.locator('#calendarCancelEditBtn').click();
    await frame.waitForFunction(() => document.getElementById('calendarSaveEventBtn').textContent === 'Add event', { timeout: 5000 });
    console.log('PASS: an end-less event renders and edits identically to pre-feature behavior -> "' + plainInfo.when + '"');

    console.log('STEP 15b: editing the ranged event pre-fills BOTH fields, and the end field round-trips through Cancel edit without altering the event');
    await frame.locator('#calendarEventsList .calendar-event', { hasText: 'Ranged meeting' }).locator('button[data-action="edit-calendar-event"]').click();
    await frame.waitForFunction(() => document.getElementById('calendarSaveEventBtn').textContent === 'Save changes', { timeout: 5000 });
    const startFieldOnEdit = await frame.locator('#calendarEventDateTimeInput').inputValue();
    const endFieldOnRangedEdit = await frame.locator('#calendarEventEndDateTimeInput').inputValue();
    if (startFieldOnEdit !== toLocalInputValue(rangedStart)) throw new Error('Expected the start field pre-filled with the existing start, got: ' + startFieldOnEdit);
    if (endFieldOnRangedEdit !== toLocalInputValue(rangedEnd)) throw new Error('Expected the end field pre-filled with the existing end, got: ' + endFieldOnRangedEdit);
    await frame.locator('#calendarCancelEditBtn').click();
    await frame.waitForFunction(() => document.getElementById('calendarSaveEventBtn').textContent === 'Add event', { timeout: 5000 });
    console.log('PASS: both start and end fields pre-fill correctly on edit -> ' + startFieldOnEdit + ' / ' + endFieldOnRangedEdit);

    console.log('STEP 16: end-before-start is rejected inline, with a clear message, and no event is saved');
    const beforeCount = await frame.locator('#calendarEventsList .calendar-event').count();
    const laterStart = new Date(realNow.getFullYear(), realNow.getMonth(), realNow.getDate() + 2, 12, 0);
    const earlierEnd = new Date(realNow.getFullYear(), realNow.getMonth(), realNow.getDate() + 2, 11, 0); // before the start
    await addEventWithEnd(frame, 'Should be rejected', laterStart, earlierEnd, '');
    await page.waitForTimeout(300); // give a real (buggy) save a moment to land before asserting it didn't
    const statusAfterReject = await frame.locator('#calendarEventStatus').textContent();
    if (!/end time must be after the start time/i.test(statusAfterReject)) {
      throw new Error('Expected a clear inline end-before-start error message, got: ' + statusAfterReject);
    }
    const countAfterReject = await frame.locator('#calendarEventsList .calendar-event').count();
    if (countAfterReject !== beforeCount) throw new Error('Expected the rejected event to NOT be saved, count went from ' + beforeCount + ' to ' + countAfterReject);
    console.log('PASS: rejected with "' + statusAfterReject + '", event count unchanged at ' + countAfterReject);

    console.log('STEP 16b: an end time EQUAL to the start is also rejected (a zero-duration "range" isn\'t a range)');
    await addEventWithEnd(frame, 'Should also be rejected', laterStart, laterStart, '');
    await page.waitForTimeout(300);
    const statusAfterEqualReject = await frame.locator('#calendarEventStatus').textContent();
    if (!/end time must be after the start time/i.test(statusAfterEqualReject)) {
      throw new Error('Expected the same inline error for an equal end/start, got: ' + statusAfterEqualReject);
    }
    const countAfterEqualReject = await frame.locator('#calendarEventsList .calendar-event').count();
    if (countAfterEqualReject !== beforeCount) throw new Error('Expected an equal-end-and-start event to NOT be saved either, count went from ' + beforeCount + ' to ' + countAfterEqualReject);
    console.log('PASS: equal start/end also rejected, event count still unchanged at ' + countAfterEqualReject);

    console.log('STEP 17: overdue/due-soon now key off the END time once one exists, not just the start');
    await deleteAllCalendarEvents(page, frame);
    // A: ongoing right now (started 2h ago, ends in 2h) — NOT overdue (it
    //    hasn't finished), but IS due soon (its end is within 24h).
    await addEventWithEnd(frame, 'Ongoing now', new Date(now.getTime() - 2 * 60 * 60 * 1000), new Date(now.getTime() + 2 * 60 * 60 * 1000), '');
    await frame.waitForFunction(() => document.querySelectorAll('#calendarEventsList .calendar-event').length === 1, { timeout: 5000 });
    // B: fully in the past (started 3h ago, ended 1h ago) — overdue.
    await addEventWithEnd(frame, 'Finished 1h ago', new Date(now.getTime() - 3 * 60 * 60 * 1000), new Date(now.getTime() - 60 * 60 * 1000), '');
    await frame.waitForFunction(() => document.querySelectorAll('#calendarEventsList .calendar-event').length === 2, { timeout: 5000 });
    // C: plain instant, starts in 2h, no end — due soon (unchanged
    //    end-less behavior, a regression check).
    await addEventWithEnd(frame, 'Starts soon, no end', new Date(now.getTime() + 2 * 60 * 60 * 1000), null, '');
    await frame.waitForFunction(() => document.querySelectorAll('#calendarEventsList .calendar-event').length === 3, { timeout: 5000 });
    // D: the key differentiator — starts in 2h (which WOULD count as "due
    //    soon" under the old start-only logic) but doesn't end until 30h
    //    from now, past the 24h due-soon window. With overdue/due-soon now
    //    keyed off the end time when one exists, this should NOT count.
    await addEventWithEnd(frame, 'Long event, ends late', new Date(now.getTime() + 2 * 60 * 60 * 1000), new Date(now.getTime() + 30 * 60 * 60 * 1000), '');
    await frame.waitForFunction(() => document.querySelectorAll('#calendarEventsList .calendar-event').length === 4, { timeout: 5000 });

    const ongoingInfo = await eventCardInfo(frame, 'Ongoing now');
    const finishedInfo = await eventCardInfo(frame, 'Finished 1h ago');
    const startsSoonInfo = await eventCardInfo(frame, 'Starts soon, no end');
    const longEventInfo = await eventCardInfo(frame, 'Long event, ends late');
    if (ongoingInfo.overdue) throw new Error('Expected an event still running (end in the future) to NOT be overdue');
    if (!finishedInfo.overdue) throw new Error('Expected an event whose end has passed to BE overdue');
    if (startsSoonInfo.overdue) throw new Error('Expected an end-less future event to NOT be overdue');
    if (longEventInfo.overdue) throw new Error('Expected a not-yet-started long event to NOT be overdue');
    console.log('PASS: overdue correctly reflects the END time when present (ongoing = not overdue, finished = overdue)');

    await frame.waitForFunction(() => document.getElementById('calendarBadge').textContent === '3', { timeout: 5000 });
    console.log('PASS: due-soon badge shows 3 (ongoing + finished + starts-soon-no-end), correctly EXCLUDING the long event whose end is 30h out even though it starts in 2h');

    console.log('STEP 18: a multi-day event\'s month-grid dot appears on EVERY day it spans, not just its start day');
    await deleteAllCalendarEvents(page, frame);
    // Picked comfortably inside the currently-displayed month (STEP 9b
    // left the grid back on the real current month) with room to spare on
    // both sides for the day-before/day-after "no dot" checks below.
    const spanStartDay = 10;
    const spanEndDay = 12; // spans day 10, 11, and 12 — a 3-day event
    const spanStart = new Date(realNow.getFullYear(), realNow.getMonth(), spanStartDay, 9, 0);
    const spanEnd = new Date(realNow.getFullYear(), realNow.getMonth(), spanEndDay, 10, 0);
    await addEventWithEnd(frame, 'Multi-day trip', spanStart, spanEnd, '');
    await frame.waitForFunction(() => document.querySelectorAll('#calendarEventsList .calendar-event').length === 1, { timeout: 5000 });
    grid = await gridInfo(frame);
    const spanKeys = [spanStartDay, spanStartDay + 1, spanEndDay].map((d) => toLocalDateKey(new Date(realNow.getFullYear(), realNow.getMonth(), d)));
    const beforeKey = toLocalDateKey(new Date(realNow.getFullYear(), realNow.getMonth(), spanStartDay - 1));
    const afterKey = toLocalDateKey(new Date(realNow.getFullYear(), realNow.getMonth(), spanEndDay + 1));
    for (const key of spanKeys) {
      const cell = grid.cells.find((c) => c.date === key && !c.otherMonth);
      if (!cell || !cell.hasDot) throw new Error('Expected spanned day ' + key + ' to carry a dot, got: ' + JSON.stringify(cell));
    }
    const beforeCell = grid.cells.find((c) => c.date === beforeKey && !c.otherMonth);
    const afterCell = grid.cells.find((c) => c.date === afterKey && !c.otherMonth);
    if (!beforeCell || beforeCell.hasDot) throw new Error('Expected the day BEFORE the span (' + beforeKey + ') to carry no dot, got: ' + JSON.stringify(beforeCell));
    if (!afterCell || afterCell.hasDot) throw new Error('Expected the day AFTER the span (' + afterKey + ') to carry no dot, got: ' + JSON.stringify(afterCell));
    console.log('PASS: all 3 spanned days (' + spanKeys.join(', ') + ') show a dot; the days immediately before/after do not');

    console.log('STEP 19: the day viewer shows the right portion of a multi-day event on each day it touches — start day, a through day, and the end day');
    const startDayKey = spanKeys[0];
    const throughDayKey = spanKeys[1];
    const endDayKey = spanKeys[2];

    await frame.locator('#calendarMonthGrid .calendar-grid-day[data-date="' + startDayKey + '"]').click();
    await frame.waitForFunction(() => document.querySelectorAll('#calendarDayViewer .calendar-day-event').length === 1, { timeout: 5000 });
    let spanDayInfo = await dayViewerInfo(frame);
    let chip = spanDayInfo.chips[0];
    if (chip.zone !== 'hour' || chip.hourLabel !== '9 AM') throw new Error('Expected the start day to place the trip at its 9 AM start hour, got: ' + JSON.stringify(chip));
    if (!chip.text.includes('9:00 AM') || !/continues/i.test(chip.text)) throw new Error('Expected the start-day chip to show its start time plus a "(continues)" qualifier, got: ' + chip.text);
    if (!chip.hasDuration) throw new Error('Expected the start-day chip to carry the .has-duration accent, not render identically to an instant event');
    console.log('PASS: start day (' + startDayKey + ') shows -> "' + chip.text + '" at the 9 AM row');

    await frame.locator('#calendarMonthGrid .calendar-grid-day[data-date="' + throughDayKey + '"]').click();
    await frame.waitForFunction(() => document.querySelectorAll('#calendarDayViewer .calendar-day-event').length === 1, { timeout: 5000 });
    spanDayInfo = await dayViewerInfo(frame);
    chip = spanDayInfo.chips[0];
    if (chip.zone !== 'all-day') throw new Error('Expected the middle (through) day to place the trip in the "All day" bucket, not an hour row, got: ' + JSON.stringify(chip));
    if (!/continues/i.test(chip.text)) throw new Error('Expected the through-day chip to say it continues, got: ' + chip.text);
    console.log('PASS: the day strictly between start/end (' + throughDayKey + ') shows -> "' + chip.text + '" in the "All day" bucket, not tied to any one hour');

    await frame.locator('#calendarMonthGrid .calendar-grid-day[data-date="' + endDayKey + '"]').click();
    await frame.waitForFunction(() => document.querySelectorAll('#calendarDayViewer .calendar-day-event').length === 1, { timeout: 5000 });
    spanDayInfo = await dayViewerInfo(frame);
    chip = spanDayInfo.chips[0];
    if (chip.zone !== 'hour' || chip.hourLabel !== '10 AM') throw new Error('Expected the end day to place the trip at its 10 AM end hour, got: ' + JSON.stringify(chip));
    if (!chip.text.includes('10:00 AM') || !/from/i.test(chip.text)) throw new Error('Expected the end-day chip to show a "(from <start date>)" qualifier plus its end time, got: ' + chip.text);
    console.log('PASS: end day (' + endDayKey + ') shows -> "' + chip.text + '" at the 10 AM row');

    console.log('\nALL CALENDAR CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close().catch(() => {});
  }
})();
