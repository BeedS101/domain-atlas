// Manual check for Post Office manifest advertisement (task #94): a
// domain can now say "I offer Global Mail" via an optional `postOffice`
// manifest field — the SAME plain, implementation-only convenience
// pattern the `presence` field already uses (see viewer.js's own comment
// on PRESENCE_DEFAULT_BASE), not part of SPEC.md. The payoff is that a
// visitor can join directly from the wallet's Mail screen the moment the
// manifest says so, without first having to find and click a specific
// in-world stall — the exact same "Subscribe" affordance already exists
// for atlas.membership, just extended to Post Office membership too.
//
// Requires domain A's issuer-server on 8001 AND domain B running as a
// real issuer-server instance on 8002 (see README.md's "Serve the two
// demo domains"). Domain B's manifest (demo-domain-b/.well-known/
// spatial.json) has `"postOffice": true`; Domain A's does not.
//
// Checks:
//   1. At Domain A (no postOffice field), the "Join" section never shows.
//   2. At Domain B (postOffice: true), it shows for an identity that
//      isn't a member yet, offering to join without visiting the stall.
//   3. Clicking Join mints the SAME atlas.postoffice.membership credential
//      the in-world stall issues — verified two ways: the section hides
//      itself afterward (already a member, same "hide entirely" #56
//      convention Subscribe uses), and the "Send mail" dropdown picks up
//      the new domain immediately, with no separate refresh needed.
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

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-postoffice-manifest');
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
    await frame.locator('#newPasswordInput').fill('manifest-join-test-password');
    await frame.locator('#newPasswordConfirmInput').fill('manifest-join-test-password');
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('#walletBtn').click();
    console.log('PASS: identity created');

    console.log('STEP 1: at Domain A (no postOffice field), the Join section never shows');
    await frame.locator('#walletBtn').click();
    await frame.locator('#socialTabBtn').click();
    await frame.waitForFunction(() => document.getElementById('mailSubscreen').classList.contains('active'), { timeout: 5000 });
    const joinHiddenAtA = await frame.evaluate(() => document.getElementById('postOfficeJoinSection').hidden);
    if (!joinHiddenAtA) throw new Error('Expected the Join section to be hidden at Domain A, which does not advertise postOffice');
    console.log('PASS: no Join section at a domain that hasn\'t opted in');
    await frame.locator('#walletBtn').click();

    console.log('STEP 2: walk to Domain B (postOffice: true) — the Join section appears, offering to join without visiting the stall');
    const portals = await projectPortals(frame);
    const toNeighbor = portals.find((p) => p.kind === 'domain');
    await frame.locator('#scene').click({ position: { x: toNeighbor.sx, y: toNeighbor.sy } });
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Neighbor Workshop'), { timeout: 10000 });
    await frame.waitForFunction(() => document.getElementById('status').textContent.includes('8002'), { timeout: 10000 });

    await frame.locator('#walletBtn').click();
    await frame.locator('#socialTabBtn').click();
    await frame.waitForFunction(() => document.getElementById('mailSubscreen').classList.contains('active'), { timeout: 5000 });
    await frame.waitForFunction(() => !document.getElementById('postOfficeJoinSection').hidden, { timeout: 5000 });
    const joinBtnText = await frame.locator('#postOfficeJoinBtn').textContent();
    if (!joinBtnText.includes('localhost:8002')) throw new Error('Expected the Join button to name Domain B, got: ' + joinBtnText);
    console.log('PASS: Join section visible at Domain B ->', joinBtnText);

    console.log('STEP 3: clicking Join mints membership directly, with no in-world stall involved');
    await frame.locator('#postOfficeJoinBtn').click();
    await frame.waitForFunction(() => document.getElementById('postOfficeJoinSection').hidden, { timeout: 10000 });
    console.log('PASS: Join section hides itself immediately after joining — already a member now, same convention Subscribe uses');

    console.log('STEP 4: the new membership shows up in the "Send mail" dropdown right away, no separate action needed');
    await frame.waitForFunction(() => {
      const opts = [...document.getElementById('postOfficeToDomainInput').options].map((o) => o.value).filter(Boolean);
      return opts.includes('localhost:8002');
    }, { timeout: 5000 });
    console.log('PASS: localhost:8002 appears in the send-via dropdown immediately after a manifest-driven join');

    console.log('\nALL POST OFFICE MANIFEST-ADVERTISEMENT CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
