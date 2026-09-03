// Manual end-to-end check for the Post Office (task #75/#87/#94, SPEC.md
// §11.3): user-to-user mail routed through Domain B, distinct from the
// existing domain-to-subscriber mail (manual-mail.js) and mail-gift
// (manual-mail-gift.js) — both of those are a DOMAIN mailing someone who
// already holds one of its own credentials. This is two arbitrary
// visitors mailing EACH OTHER, addressed by public key, with Domain B
// only involved as the relay both of them trust.
//
// Membership is symmetric (task #94): a Post Office only relays mail
// between two people who BOTH hold ITS OWN Global Mail Membership Card.
// Holding the card is what makes that domain a sending relay for you, not
// just an inbox — you don't need to be standing in that world to send
// through it, only to have joined it at some point. That's a real change
// from the first cut of this feature, where only the recipient needed
// membership and the sender needed nothing from the target domain at
// all — this test's shape changed to match: visitor A now has to join
// Domain B too before A can send anywhere through it.
//
// Requires domain A's issuer-server on 8001 AND domain B running as a
// REAL issuer-server instance on 8002 (see README.md's "Serve the two
// demo domains" — this is no longer the old plain static server). This
// test does not start either itself.
//
// Checks:
//   1. Two visitors, each with their own freshly created identity, never
//      need to meet each other — but both DO need to join the same Post
//      Office before they can mail each other through it.
//   2. Visitor B travels to Domain B's Neighbor Workshop and clicks the
//      "Post Office" stall to claim a Global Mail Membership Card — the
//      same one-click "collect" interactable pattern the market/plaza
//      stalls already use (action: issue, oncePerUser).
//   3. Visitor A does the same at Domain B, independently — the stall's
//      oncePerUser cap is per-owner, so both visitors can each claim
//      their own card without treading on each other.
//   4. The wallet's "Send mail" form only offers Post Offices this wallet
//      has actually joined (the select is empty/disabled before joining,
//      and lists exactly localhost:8002 after) — sending is no longer a
//      free-text domain field.
//   5. Visitor A sends mail to B's public key via that dropdown. Visitor
//      B's ordinary mail check picks the message up automatically (same
//      checkAllMail() loop, no special-cased polling), showing "From <A's
//      key>… via localhost:8002" rather than a bare domain name, and the
//      right subject/body.
//   6. A subject/body containing HTML is displayed as literal text, not
//      executed — the escaping task #75 added given mail body text can
//      come from an arbitrary stranger, not just a trusted domain
//      operator.
//   7. Sending to a public key that never claimed membership at the
//      target domain is rejected with a clear error, not silently
//      swallowed.
//   8. NEW (task #94): a visitor who has an identity but never joined
//      Domain B cannot send through it either, even calling the wallet
//      API directly — the sender-membership gate is enforced server-side,
//      not just hidden behind the UI's dropdown.
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
          const points = window.__atlasScene.portalMarkers.map((m) => {
            const [x, , z] = m.position;
            return {
              sx: originX + (x - z) * COS30 * SCALE,
              sy: originY + (x + z) * SIN30 * SCALE,
              kind: m.portal && m.portal.kind,
              to: m.portal && m.portal.to
            };
          });
          resolve(points);
        } else {
          requestAnimationFrame(check);
        }
      };
      check();
    });
  });
}

async function projectInteractables(frame) {
  return frame.evaluate(() => {
    return new Promise((resolve) => {
      const check = () => {
        const scene = window.__atlasScene;
        if (scene && scene.interactables && scene.interactables.length) {
          const canvas = document.getElementById('scene');
          const originX = canvas.width / 2;
          const originY = canvas.height / 2 + 40;
          const points = scene.interactables.map((m) => {
            const [x, y, z] = m.position;
            const p = project(x, y || 0, z, originX, originY);
            return { sx: p.x, sy: p.y - 16, label: m.label, class: m.class };
          });
          resolve(points);
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

// Walks a visitor from the Plaza (where openOverlay/createIdentity leave
// them) across the domain portal to Domain B's Neighbor Workshop and
// clicks the Post Office stall, asserting the membership card was
// collected. Used for BOTH visitors now that sending requires membership
// too, not just receiving.
async function claimPostOfficeMembership(frame, label) {
  let portals = await projectPortals(frame);
  const toNeighbor = portals.find((p) => p.kind === 'domain');
  if (!toNeighbor) throw new Error('Expected a domain portal out of the Plaza for ' + label);
  await frame.locator('#scene').click({ position: { x: toNeighbor.sx, y: toNeighbor.sy } });
  await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Neighbor Workshop'), { timeout: 10000 });
  await frame.waitForFunction(() => document.getElementById('status').textContent.includes('8002'), { timeout: 10000 });

  const [postOfficeStall] = (await projectInteractables(frame)).filter((m) => m.class === 'atlas.postoffice.membership');
  if (!postOfficeStall) throw new Error('Expected a Post Office interactable (atlas.postoffice.membership) in the workshop scene');
  await frame.locator('#scene').click({ position: { x: postOfficeStall.sx, y: postOfficeStall.sy } });
  await frame.waitForFunction(() => document.getElementById('status').textContent.startsWith('Collected'), { timeout: 10000 });
  const membershipStatus = await frame.locator('#status').textContent();
  if (!membershipStatus.includes('Claim Global Mail Membership')) throw new Error('Expected ' + label + ' to collect the Global Mail Membership: ' + membershipStatus);
  console.log('PASS: ' + label + ' claimed a Global Mail Membership Card at Domain B ->', membershipStatus);

  // walk back to the Plaza so callers are left in a consistent spot, same
  // as the rest of this suite assumes after any domain-portal excursion
  portals = await projectPortals(frame);
  const backToDomainA = portals.find((p) => p.kind === 'domain');
  await frame.locator('#scene').click({ position: { x: backToDomainA.sx, y: backToDomainA.sy } });
  await frame.waitForFunction(() => document.getElementById('status').textContent.includes('8001'), { timeout: 10000 });
  return postOfficeStall;
}

(async () => {
  const dirA = path.resolve(__dirname, '.chrome-profile-postoffice-a');
  const dirB = path.resolve(__dirname, '.chrome-profile-postoffice-b');
  const dirC = path.resolve(__dirname, '.chrome-profile-postoffice-c');
  const launchOpts = { headless: false, executablePath: '/opt/pw-browsers/chromium', args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox'] };

  const contextA = await chromium.launchPersistentContext(dirA, launchOpts);
  const contextB = await chromium.launchPersistentContext(dirB, launchOpts);
  const contextC = await chromium.launchPersistentContext(dirC, launchOpts);

  try {
    const a = await openOverlay(contextA, 'Visitor A');
    const b = await openOverlay(contextB, 'Visitor B');
    const c = await openOverlay(contextC, 'Visitor C');

    console.log('STEP 0: three visitors create their own real wallet identities');
    const pkA = await createIdentity(a.frame, 'postoffice-test-password-a');
    const pkB = await createIdentity(b.frame, 'postoffice-test-password-b');
    const pkC = await createIdentity(c.frame, 'postoffice-test-password-c');
    if (pkA === pkB || pkA === pkC || pkB === pkC) throw new Error('Expected three independently created identities to all differ');
    console.log('PASS: three independent identities ->', pkA.slice(0, 16) + '...', pkB.slice(0, 16) + '...', pkC.slice(0, 16) + '...');

    console.log('STEP 1: Visitor B travels to Domain B and claims a Global Mail Membership Card');
    const bStall = await claimPostOfficeMembership(b.frame, 'Visitor B');

    console.log('STEP 1b: clicking the stall again does not double-issue (oncePerUser)');
    let portals = await projectPortals(b.frame);
    const toNeighborAgain = portals.find((p) => p.kind === 'domain');
    await b.frame.locator('#scene').click({ position: { x: toNeighborAgain.sx, y: toNeighborAgain.sy } });
    await b.frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Neighbor Workshop'), { timeout: 10000 });
    // Reuse the same projected coordinates claimPostOfficeMembership already
    // computed rather than re-querying scene.interactables here — that
    // avoids a race where this world's interactables haven't finished
    // loading yet right after the portal transition.
    await b.frame.locator('#scene').click({ position: { x: bStall.sx, y: bStall.sy } });
    await b.frame.waitForFunction(() => document.getElementById('status').textContent.startsWith('Already collected'), { timeout: 10000 });
    console.log('PASS: no duplicate membership issued on a second click');
    portals = await projectPortals(b.frame);
    const backToPlazaFromB = portals.find((p) => p.kind === 'domain');
    await b.frame.locator('#scene').click({ position: { x: backToPlazaFromB.sx, y: backToPlazaFromB.sy } });
    await b.frame.waitForFunction(() => document.getElementById('status').textContent.includes('8001'), { timeout: 10000 });

    console.log('STEP 2 (task #94): Visitor A ALSO has to join Domain B before A can send through it — symmetric membership');
    await claimPostOfficeMembership(a.frame, 'Visitor A');

    console.log('STEP 3: the "Send mail" dropdown only offers Post Offices this wallet has actually joined');
    await a.frame.locator('#walletBtn').click();
    await a.frame.locator('#socialTabBtn').click();
    await a.frame.waitForFunction(() => document.getElementById('mailSubscreen').classList.contains('active'), { timeout: 5000 });
    // showSocialSubtab() flips the active class synchronously, before the
    // click handler's own async refreshes (mail display, subscribe button,
    // public key display + send-via options) have resolved — wait for the
    // actual values rather than racing the screen-active class.
    await a.frame.waitForFunction(() => document.getElementById('myPublicKeyDisplay').value.length > 0, { timeout: 5000 });
    await a.frame.waitForFunction(() => document.getElementById('postOfficeToDomainInput').options.length > 1, { timeout: 5000 });

    const myAddressValue = await a.frame.locator('#myPublicKeyDisplay').inputValue();
    if (myAddressValue !== pkA) throw new Error('Expected "Your address" to show A\'s own public key, got: ' + myAddressValue);
    console.log('PASS: "Your address" correctly shows this identity\'s own public key');

    const sendViaOptions = await a.frame.evaluate(() => [...document.getElementById('postOfficeToDomainInput').options].map((o) => o.value).filter(Boolean));
    if (sendViaOptions.length !== 1 || sendViaOptions[0] !== 'localhost:8002') {
      throw new Error('Expected the send-via dropdown to offer exactly localhost:8002 (the one Post Office A joined), got: ' + JSON.stringify(sendViaOptions));
    }
    console.log('PASS: send-via dropdown offers exactly the Post Office A actually joined ->', sendViaOptions);

    console.log('STEP 4: Visitor A sends mail to B\'s public key via that dropdown');
    // Task #94 (handle addressing): Compose is handle-first by default now
    // (see manual-postoffice-handle-ui.js for that path) — this test is
    // specifically exercising the raw-public-key path (arbitrary/stranger
    // keys, XSS payloads, membership rejection), so it switches to the
    // raw-key fallback field via the same toggle a real user would use.
    await a.frame.locator('#postOfficeToggleRawKeyBtn').click();
    const XSS_SUBJECT = 'Hi <b>Bob</b>';
    const XSS_BODY = 'Careful: <img src=x onerror="window.__pwned = true">';
    await a.frame.locator('#postOfficeToDomainInput').selectOption('localhost:8002');
    await a.frame.locator('#postOfficeToPublicKeyInput').fill(pkB);
    await a.frame.locator('#postOfficeSubjectInput').fill(XSS_SUBJECT);
    await a.frame.locator('#postOfficeBodyInput').fill(XSS_BODY);
    await a.frame.locator('#postOfficeSendBtn').click();
    await a.frame.waitForFunction(() => document.getElementById('postOfficeSendStatus').textContent === 'Sent.', { timeout: 10000 });
    console.log('PASS: send reported success');

    console.log('STEP 5: Visitor B\'s ordinary mail check picks the message up automatically');
    await b.frame.locator('#walletBtn').click();
    await b.frame.locator('#socialTabBtn').click();
    await b.frame.waitForFunction(() => document.getElementById('mailSubscreen').classList.contains('active'), { timeout: 5000 });
    await b.frame.locator('#checkMailNowBtn').click();
    // 2 messages: the welcome mail auto-sent on claiming membership + this test's message.
    await b.frame.waitForFunction(() => document.querySelectorAll('#mailList .mail-card').length === 2, { timeout: 10000 });
    const mailCard = b.frame.locator('#mailList .mail-card', { hasText: 'Hi ' });
    const cardText = await mailCard.textContent();
    if (!cardText.includes('Hi <b>Bob</b>')) throw new Error('Expected the literal, un-rendered subject text in the card: ' + cardText);
    if (!cardText.includes(pkA.slice(0, 20))) throw new Error('Expected the card to show who it\'s actually from: ' + cardText);
    if (!cardText.includes('via localhost:8002')) throw new Error('Expected the card to name the relaying domain: ' + cardText);
    console.log('PASS: message arrived, correctly attributed to Visitor A via localhost:8002 ->', cardText.split('\n')[0]);

    console.log('STEP 5b: the injected HTML did NOT execute — no actual <b>/<img> elements, no onerror firing');
    const boldCount = await mailCard.locator('b').count();
    const imgCount = await mailCard.locator('img').count();
    const pwned = await b.frame.evaluate(() => window.__pwned === true);
    if (boldCount !== 0 || imgCount !== 0) throw new Error('Expected HTML to render as literal text, found real <b>/<img> elements');
    if (pwned) throw new Error('onerror handler fired — mail body was NOT safely escaped');
    console.log('PASS: mail content escaped correctly, no script execution');

    console.log('STEP 6: sending to a public key with no membership at the target domain is rejected (recipient-side gate)');
    const strangerKey = await a.frame.evaluate(async () => {
      const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      const raw = await crypto.subtle.exportKey('raw', pair.publicKey);
      return btoa(String.fromCharCode(...new Uint8Array(raw))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    });
    await a.frame.locator('#postOfficeToPublicKeyInput').fill(strangerKey);
    await a.frame.locator('#postOfficeSubjectInput').fill('Should not deliver');
    await a.frame.locator('#postOfficeBodyInput').fill('Nobody registered this key at Domain B.');
    await a.frame.locator('#postOfficeSendBtn').click();
    await a.frame.waitForFunction(
      () => document.getElementById('postOfficeSendStatus').textContent.startsWith('Send failed'),
      { timeout: 10000 }
    );
    const failStatus = await a.frame.locator('#postOfficeSendStatus').textContent();
    if (!failStatus.toLowerCase().includes('membership')) throw new Error('Expected a membership-related rejection, got: ' + failStatus);
    console.log('PASS:', failStatus);

    console.log('STEP 7 (task #94): Visitor C, who has an identity but never joined Domain B, cannot send through it either — even calling the wallet API directly, bypassing the UI\'s dropdown entirely');
    const senderRejection = await c.frame.evaluate(async (targetPk) => {
      try {
        await AtlasWallet.sendUserMail('localhost:8002', targetPk, 'Should not deliver', 'C never joined Domain B.');
        return { threw: false };
      } catch (err) {
        return { threw: true, message: err.message };
      }
    }, pkB);
    if (!senderRejection.threw) throw new Error('Expected AtlasWallet.sendUserMail to reject a sender with no membership at the target domain, but it resolved');
    if (!senderRejection.message.toLowerCase().includes('membership')) throw new Error('Expected a membership-related rejection for the sender, got: ' + senderRejection.message);
    console.log('PASS: server rejected the send —', senderRejection.message);

    console.log('\nALL POST OFFICE CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await contextA.close();
    await contextB.close();
    await contextC.close();
  }
})();
