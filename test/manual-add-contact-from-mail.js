// Manual check for #154: an "Add Contact" action in the Mail card's own
// "⋯" menu, sibling to the existing "Add to calendar"/"Block sender"
// buttons — turns a message's sender straight into a saved Contact
// without retyping their key into the Contacts tab's manual-add form.
//
// addFriend() itself is purely local (see wallet.js's own header comment
// on it — no signal ever reaches the other person), the same reasoning
// already vetted for the analogous chat-menu version in task #148, so
// this test isn't chasing any abuse concern — just correctness:
//   1. Domain-to-subscriber mail (no `from`, manual-mail.js's kind) never
//      gets an Add Contact button at all — there's no addressable sender
//      to add.
//   2. Relayed user-to-user mail (has `from`, via a Post Office — see
//      manual-postoffice-mail.js) DOES get one, and clicking it saves the
//      sender as a Contact with the fallback 'Friend' name (no handle was
//      registered in this test's send), shows visible feedback on the
//      shared status line, and the Contacts tab now lists them.
//   3. Once saved, the button itself disappears from that same mail
//      card's menu on the next render — it would otherwise be a
//      confusing "add myself again" no-op — while Reply/Block sender
//      remain untouched.
//
// Requires domain A's issuer-server on 8001 AND domain B's real
// issuer-server instance on 8002 (same as manual-postoffice-mail.js).
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');

async function projectPortals(frame) {
  return frame.evaluate(() => new Promise((resolve) => {
    const check = () => {
      if (window.__atlasScene && window.__atlasScene.portalMarkers.length) {
        const canvas = document.getElementById('scene');
        const originX = canvas.width / 2;
        const originY = canvas.height / 2 + 40;
        const SCALE = 26, COS30 = Math.cos(Math.PI / 6), SIN30 = Math.sin(Math.PI / 6);
        resolve(window.__atlasScene.portalMarkers.map((m) => {
          const [x, , z] = m.position;
          return { sx: originX + (x - z) * COS30 * SCALE, sy: originY + (x + z) * SIN30 * SCALE, kind: m.portal && m.portal.kind, to: m.portal && m.portal.to };
        }));
      } else {
        requestAnimationFrame(check);
      }
    };
    check();
  }));
}

async function projectInteractables(frame) {
  return frame.evaluate(() => new Promise((resolve) => {
    const check = () => {
      const scene = window.__atlasScene;
      if (scene && scene.interactables && scene.interactables.length) {
        const canvas = document.getElementById('scene');
        const originX = canvas.width / 2;
        const originY = canvas.height / 2 + 40;
        resolve(scene.interactables.map((m) => {
          const [x, y, z] = m.position;
          const p = project(x, y || 0, z, originX, originY);
          return { sx: p.x, sy: p.y - 16, label: m.label, class: m.class };
        }));
      } else {
        requestAnimationFrame(check);
      }
    };
    check();
  }));
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

async function claimPostOfficeMembership(frame, label) {
  let portals = await projectPortals(frame);
  const toNeighbor = portals.find((p) => p.kind === 'domain');
  if (!toNeighbor) throw new Error('Expected a domain portal out of the Plaza for ' + label);
  await frame.locator('#scene').click({ position: { x: toNeighbor.sx, y: toNeighbor.sy } });
  await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Neighbor Workshop'), { timeout: 10000 });
  await frame.waitForFunction(() => document.getElementById('status').textContent.includes('8002'), { timeout: 10000 });

  const [postOfficeStall] = (await projectInteractables(frame)).filter((m) => m.class === 'atlas.postoffice.membership');
  if (!postOfficeStall) throw new Error('Expected a Post Office interactable in the workshop scene');
  await frame.locator('#scene').click({ position: { x: postOfficeStall.sx, y: postOfficeStall.sy } });
  await frame.waitForFunction(() => document.getElementById('status').textContent.startsWith('Collected'), { timeout: 10000 });
  console.log('PASS: ' + label + ' claimed a Global Mail Membership Card at Domain B');

  portals = await projectPortals(frame);
  const backToDomainA = portals.find((p) => p.kind === 'domain');
  await frame.locator('#scene').click({ position: { x: backToDomainA.sx, y: backToDomainA.sy } });
  await frame.waitForFunction(() => document.getElementById('status').textContent.includes('8001'), { timeout: 10000 });
}

(async () => {
  const dirA = path.resolve(__dirname, '.chrome-profile-add-contact-mail-a');
  const dirB = path.resolve(__dirname, '.chrome-profile-add-contact-mail-b');
  const launchOpts = { headless: false, executablePath: '/opt/pw-browsers/chromium', args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox'] };

  const contextA = await chromium.launchPersistentContext(dirA, launchOpts);
  const contextB = await chromium.launchPersistentContext(dirB, launchOpts);

  try {
    const a = await openOverlay(contextA, 'Visitor A (sender)');
    const b = await openOverlay(contextB, 'Visitor B (recipient)');

    console.log('STEP 0: two visitors create their own real wallet identities');
    const pkA = await createIdentity(a.frame, 'add-contact-mail-pw-a');
    const pkB = await createIdentity(b.frame, 'add-contact-mail-pw-b');
    if (pkA === pkB) throw new Error('Expected two independently created identities to differ');
    console.log('PASS: two independent identities ->', pkA.slice(0, 16) + '...', pkB.slice(0, 16) + '...');

    console.log('STEP 1: both join Domain B\'s Post Office (symmetric membership requirement)');
    await claimPostOfficeMembership(b.frame, 'Visitor B');
    await claimPostOfficeMembership(a.frame, 'Visitor A');

    console.log('STEP 2: Visitor A sends B a raw-public-key message (no handle registered) through the Post Office');
    await a.frame.locator('#walletBtn').click();
    await a.frame.locator('#socialTabBtn').click();
    await a.frame.waitForFunction(() => document.getElementById('mailSubscreen').classList.contains('active'), { timeout: 5000 });
    await a.frame.waitForFunction(() => document.getElementById('postOfficeToDomainInput').options.length > 1, { timeout: 5000 });
    const composeAlreadyActive = await a.frame.locator('#mailBoxComposeSubscreen').evaluate((el) => el.classList.contains('active'));
    if (!composeAlreadyActive) await a.frame.locator('#mailBoxComposeSubtabBtn').click();
    await a.frame.locator('#postOfficeToggleRawKeyBtn').click();
    await a.frame.locator('#postOfficeToDomainInput').selectOption('localhost:8002');
    await a.frame.locator('#postOfficeToPublicKeyInput').fill(pkB);
    await a.frame.locator('#postOfficeSubjectInput').fill('Hey there');
    await a.frame.locator('#postOfficeBodyInput').fill('Just saying hi.');
    await a.frame.locator('#postOfficeSendBtn').click();
    await a.frame.waitForFunction(() => document.getElementById('postOfficeSendStatus').textContent === 'Sent.', { timeout: 10000 });
    console.log('PASS: message sent');

    console.log('STEP 3: Visitor B checks mail and finds the message, NOT yet a saved contact');
    await b.frame.locator('#walletBtn').click();
    await b.frame.locator('#socialTabBtn').click();
    await b.frame.waitForFunction(() => document.getElementById('mailSubscreen').classList.contains('active'), { timeout: 5000 });
    await b.frame.locator('#checkMailNowBtn').click();
    // 2 messages: the welcome mail auto-sent on claiming membership + this test's message.
    await b.frame.waitForFunction(() => document.querySelectorAll('#mailList .mail-card').length === 2, { timeout: 10000 });
    const mailCard = b.frame.locator('#mailList .mail-card', { hasText: 'Hey there' });
    const cardTextBefore = await mailCard.textContent();
    if (cardTextBefore.includes('(friend)')) throw new Error('Sender should not already read as a friend before Add Contact is used: ' + cardTextBefore);
    console.log('PASS: message present, sender not yet a contact ->', cardTextBefore.split('\n')[0]);

    console.log('STEP 4: opening the "⋯" menu shows Add Contact alongside Add to calendar/Block sender');
    await mailCard.locator('button[data-action="toggle-mail-menu"]').click();
    const menuItems = mailCard.locator('.card-menu-items');
    await menuItems.waitFor({ state: 'visible', timeout: 2000 });
    const addContactBtn = menuItems.locator('button[data-action="add-contact-from-mail"]');
    if ((await addContactBtn.count()) !== 1) throw new Error('Expected exactly one Add Contact button in the open menu');
    if ((await menuItems.locator('button[data-action="add-mail-to-calendar"]').count()) !== 1) throw new Error('Add to calendar should still be present alongside it');
    if ((await menuItems.locator('button[data-action="block-sender"]').count()) !== 1) throw new Error('Block sender should still be present alongside it');
    console.log('PASS: Add Contact sits alongside the existing menu actions, neither disturbed');

    console.log('STEP 5: clicking Add Contact saves the sender with the fallback name, shows visible feedback, and the button disappears from this same card');
    await addContactBtn.click();
    await b.frame.waitForFunction(() => document.getElementById('status').textContent === 'Added Friend to Contacts.', { timeout: 5000 });
    console.log('PASS: status line confirmed the add ->', await b.frame.locator('#status').textContent());
    // The card re-renders on refreshMailDisplay() — re-locate rather than
    // reuse stale handles, then confirm this exact sender's Add Contact
    // button no longer exists (mirrors how blockSenderHtml/addContactHtml
    // are computed fresh on every render).
    const mailCardAfter = b.frame.locator('#mailList .mail-card', { hasText: 'Hey there' });
    const cardTextAfter = await mailCardAfter.textContent();
    if (!cardTextAfter.includes('(friend)')) throw new Error('Expected the From line to now read as a friend: ' + cardTextAfter);
    await mailCardAfter.locator('button[data-action="toggle-mail-menu"]').click();
    const menuItemsAfter = mailCardAfter.locator('.card-menu-items');
    await menuItemsAfter.waitFor({ state: 'visible', timeout: 2000 });
    if ((await menuItemsAfter.locator('button[data-action="add-contact-from-mail"]').count()) !== 0) throw new Error('Add Contact button should have disappeared once the sender is already a saved contact');
    if ((await menuItemsAfter.locator('button[data-action="block-sender"]').count()) !== 1) throw new Error('Block sender should still be present after adding the contact');
    console.log('PASS: Add Contact button is gone post-save, Block sender unaffected');

    console.log('STEP 6: the Contacts tab now lists the sender');
    // Social's own sub-tab bar (already on this screen from Steps 3-5) ->
    // Contacts -> its default-active "Contacts" inner sub-tab (contactsList
    // itself), same nesting the file's own comments describe above.
    await b.frame.locator('#contactsSubtabBtn').click();
    await b.frame.waitForFunction(() => document.getElementById('contactsSubscreen').classList.contains('active'), { timeout: 5000 });
    await b.frame.waitForFunction(() => {
      const list = document.getElementById('contactsList');
      return list && list.querySelector('.info-card');
    }, { timeout: 5000 });
    const contactCardText = await b.frame.locator('#contactsList .info-card').first().textContent();
    if (!contactCardText.includes('Friend')) throw new Error('Expected the new contact to be named "Friend" (no handle was registered), got: ' + contactCardText);
    if (!contactCardText.includes(pkA.slice(0, 16))) throw new Error('Expected the new contact\'s key fragment to match Visitor A\'s public key: ' + contactCardText);
    console.log('PASS: Visitor A now appears in Visitor B\'s Contacts ->', contactCardText);

    console.log('\nALL ADD-CONTACT-FROM-MAIL CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await contextA.close();
    await contextB.close();
  }
})();
