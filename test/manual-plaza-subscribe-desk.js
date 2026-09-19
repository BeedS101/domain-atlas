// Manual check for the new "Subscription Card" desk in Example Plaza's 2D
// scene (demo-domain-a/spatial/plaza/scene.json), added alongside the
// Previewer work (task #227) at Bruno's request: a visitor should be able
// to walk up and click to collect the domain's atlas.membership credential
// right there in the plaza, not just through the wallet panel's existing
// "Subscribe" button (Mail tab) — and whichever path they use, the OTHER
// one should recognize it immediately, without needing to leave and
// re-enter the world first.
//
// Also covers the newly domain-templated card name (issuer-server/
// server.js and issuer-php/lib/store.php both changed from the static
// "Domain Atlas Membership Card" to "{domain} Subscription Card") — this
// is the actual answer to "does it need a new design?": no new art, it
// reuses the same badge.png/badge.glb every membership-style card already
// shares, just a name that now bakes in whichever domain issued it.
//
// Covers:
//   1. Before subscribing: the desk previews as "<domain> Subscription
//      Card" with a "Not collected yet" note, AND the wallet panel's own
//      Subscribe section is visible — both paths agree nothing's been
//      collected yet.
//   2. Clicking the desk mints a real atlas.membership credential (a real
//      issue() mint, not a mock), named after the actual serving domain.
//   3. Without leaving the world, the wallet panel's Subscribe section
//      hides itself immediately — the desk's own collection refreshes the
//      button's state, not just the desk's own.
//   4. Clicking the desk again is a client-side no-op (oncePerUser dedupe),
//      same as every other "issue" interactable.
//   5. A SECOND, independent identity: subscribing via the WALLET button
//      instead makes the plaza desk stop previewing entirely (the
//      Previewer ignores an already-owned oncePerUser class) — the reverse
//      direction of check #3, confirming both collection paths refresh
//      each other's state, not just their own.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const DOMAIN = 'localhost:8001';

async function projectInteractables(frame) {
  return frame.evaluate(() => {
    return new Promise((resolve) => {
      const check = () => {
        const scene = window.__atlasScene;
        if (scene && scene.interactables && scene.interactables.length) {
          const canvas = document.getElementById('scene');
          const originX = canvas.width / 2;
          const originY = canvas.height / 2 + 40;
          resolve(scene.interactables.map((m) => {
            const [x, y, z] = m.position;
            const p = project(x, y || 0, z, originX, originY);
            return { sx: p.x, sy: p.y - 16, label: m.label, class: m.class, action: m.action };
          }));
        } else {
          requestAnimationFrame(check);
        }
      };
      check();
    });
  });
}

function readPreviewer(frame) {
  return frame.evaluate(() => {
    const widget = document.getElementById('previewerWidget');
    const nameEl = document.querySelector('#previewerBody .name');
    return {
      hidden: widget.hidden,
      name: nameEl ? nameEl.textContent : null,
      hasNote: !!document.querySelector('#previewerBody .previewer-note')
    };
  });
}

async function subscribeSectionHidden(frame) {
  await frame.locator('#socialTabBtn').click();
  await frame.waitForFunction(() => document.getElementById('mailSubscreen').classList.contains('active'), { timeout: 5000 });
  return frame.locator('#subscribeSection').isHidden();
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
}

async function enterPlaza(page) {
  await page.goto('http://localhost:8001', { waitUntil: 'load' });
  await page.locator('#domain-atlas-enter-btn').click();
  const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
  const frame = await frameHandle.contentFrame();
  frame.on('pageerror', (err) => console.log('FRAMEERROR:', String(err)));
  await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
  return frame;
}

(async () => {
  // ---------- Scenario A: collect via the desk, wallet button reacts ----------
  {
    const userDataDir = path.resolve(__dirname, '.chrome-profile-plaza-subscribe-a');
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      executablePath: '/opt/pw-browsers/chromium',
      args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
    });
    try {
      const page = await context.newPage();
      page.on('pageerror', (err) => console.log('PAGEERROR:', String(err)));
      console.log('SCENARIO A SETUP: fresh identity, Example Plaza');
      const frame = await enterPlaza(page);
      await createIdentity(frame, 'plaza-subscribe-desk-pw-a');
      console.log('PASS: identity ready, not subscribed yet');

      const interactables = await projectInteractables(frame);
      const desk = interactables.find((m) => m.class === 'atlas.membership');
      if (!desk) throw new Error('Expected a "Subscription Card" interactable (class atlas.membership) in the plaza');

      console.log('STEP A1: before subscribing, hovering the desk previews the domain-templated card name, and the wallet\'s own Subscribe section is visible');
      await frame.locator('#scene').hover({ position: { x: desk.sx, y: desk.sy } });
      await frame.waitForFunction(() => document.getElementById('previewerWidget').hidden === false, { timeout: 3000 });
      const preview = await readPreviewer(frame);
      if (preview.name !== DOMAIN + ' Subscription Card') throw new Error('Expected "' + DOMAIN + ' Subscription Card", got: ' + preview.name);
      if (!preview.hasNote) throw new Error('Expected a "Not collected yet" note before subscribing');
      const hiddenBefore = await subscribeSectionHidden(frame);
      if (hiddenBefore) throw new Error('Expected the wallet\'s Subscribe section to be visible before collecting anything');
      console.log('PASS: desk previews as "' + preview.name + '", wallet Subscribe section still visible');

      console.log('STEP A2: clicking the desk mints a real atlas.membership credential');
      await frame.page().mouse.move(5, 5);
      await frame.locator('#scene').click({ position: { x: desk.sx, y: desk.sy } });
      await frame.waitForFunction(() => document.getElementById('status').textContent === 'Collected Subscription Card.', { timeout: 10000 });
      const statusAfter = await frame.locator('#status').textContent();
      const membership = await frame.evaluate(async (domain) => {
        const identity = await AtlasWallet.getIdentity();
        const wallet = await AtlasWallet.getWallet(identity.publicKey);
        return wallet.find((e) => e.credential.asset.class === 'atlas.membership' && e.credential.issuer.domain === domain);
      }, DOMAIN);
      if (!membership) throw new Error('Expected a real atlas.membership credential in the wallet after clicking the desk');
      if (membership.credential.asset.name !== DOMAIN + ' Subscription Card') throw new Error('Expected the minted credential\'s own name to match, got: ' + membership.credential.asset.name);
      console.log('PASS: desk minted a genuine "' + membership.credential.asset.name + '" credential ->', statusAfter);

      console.log('STEP A3: without leaving the world, the wallet\'s Subscribe section hides itself right away');
      const hiddenAfter = await subscribeSectionHidden(frame);
      if (!hiddenAfter) throw new Error('Expected the wallet\'s Subscribe section to hide immediately after collecting via the desk, with no world re-entry needed');
      console.log('PASS: Subscribe section hid itself immediately — the desk\'s own collection refreshed the wallet button\'s state too');

      console.log('STEP A4: clicking the desk again is a client-side no-op (oncePerUser dedupe)');
      const statusBeforeRepeat = await frame.locator('#status').textContent();
      await frame.locator('#scene').click({ position: { x: desk.sx, y: desk.sy } });
      await frame.waitForFunction((prev) => document.getElementById('status').textContent !== prev, statusBeforeRepeat, { timeout: 5000 });
      const statusAfterRepeat = await frame.locator('#status').textContent();
      if (statusAfterRepeat !== 'Already collected Subscription Card — check your wallet.') {
        throw new Error('Expected the oncePerUser rejection message, got: ' + statusAfterRepeat);
      }
      const membershipCountAfter = await frame.evaluate(async () => {
        const identity = await AtlasWallet.getIdentity();
        const wallet = await AtlasWallet.getWallet(identity.publicKey);
        return wallet.filter((e) => e.credential.asset.class === 'atlas.membership').length;
      });
      if (membershipCountAfter !== 1) throw new Error('Expected exactly one membership credential (no duplicate from the repeat click), got ' + membershipCountAfter);
      console.log('PASS: re-clicking the desk was rejected client-side, no duplicate minted ->', statusAfterRepeat);

      console.log('\nSCENARIO A (collect via the desk, wallet button reacts) PASSED');
    } finally {
      await context.close().catch(() => {});
    }
  }

  // ---------- Scenario B: collect via the wallet button, desk reacts ----------
  {
    const userDataDir = path.resolve(__dirname, '.chrome-profile-plaza-subscribe-b');
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      executablePath: '/opt/pw-browsers/chromium',
      args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
    });
    try {
      const page = await context.newPage();
      page.on('pageerror', (err) => console.log('PAGEERROR:', String(err)));
      console.log('SCENARIO B SETUP: a SECOND, independent fresh identity, Example Plaza');
      const frame = await enterPlaza(page);
      await createIdentity(frame, 'plaza-subscribe-desk-pw-b');
      console.log('PASS: identity ready, not subscribed yet');

      console.log('STEP B1: subscribing via the WALLET panel\'s own Subscribe button (Mail tab), not the desk');
      await frame.locator('#socialTabBtn').click();
      await frame.waitForFunction(() => document.getElementById('mailSubscreen').classList.contains('active'), { timeout: 5000 });
      await frame.waitForFunction(() => {
        const section = document.getElementById('subscribeSection');
        return section && !section.hidden;
      }, { timeout: 5000 });
      await frame.locator('#subscribeBtn').click();
      await frame.waitForFunction(() => {
        const section = document.getElementById('subscribeSection');
        return section && section.hidden;
      }, { timeout: 10000 });
      console.log('PASS: subscribed via the wallet button, its own section hid itself as usual');

      console.log('STEP B2: back in the plaza, hovering the desk now previews NOTHING — the Previewer ignores this already-owned oncePerUser class, with no world re-entry needed');
      await frame.locator('#walletTabBtn').click();
      await frame.waitForFunction(() => !document.getElementById('walletPanel').classList.contains('open'), { timeout: 5000 }).catch(() => {});
      const interactables = await projectInteractables(frame);
      const desk = interactables.find((m) => m.class === 'atlas.membership');
      if (!desk) throw new Error('Expected the desk interactable to still be present in the scene');
      await frame.locator('#scene').hover({ position: { x: desk.sx, y: desk.sy } });
      await frame.page().waitForTimeout(500);
      const preview = await readPreviewer(frame);
      if (!preview.hidden) throw new Error('Expected the Previewer to stay closed for the desk once its class is already owned (via the wallet button), got: ' + JSON.stringify(preview));
      console.log('PASS: the desk is ignored by the Previewer immediately — the wallet button\'s own collection refreshed the desk\'s ownership cache too');

      console.log('\nSCENARIO B (collect via the wallet button, desk reacts) PASSED');
    } finally {
      await context.close().catch(() => {});
    }
  }

  console.log('\nALL PLAZA SUBSCRIPTION DESK CHECKS PASSED');
})().catch((err) => {
  console.error('FAILURE:', err);
  process.exitCode = 1;
});
