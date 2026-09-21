// Manual end-to-end check for SPEC.md §3.6 (key-anchored worlds) and
// §3.6.1 (mandatory trust disclosure) — the extension-side feature built
// on top of AtlasWallet.verifyKeyAnchoredManifest (wallet.js) and
// followKeyAnchoredPortal()/showKeyAnchoredDisclosure() (viewer.js).
//
// Demo content: demo-domain-a's Plaza has a 6th portal, `kind: "key"`,
// pointing at demo-domain-a/keyworld/spatial.json — a real, validly-signed
// manifest with no `domain` field at all, just `identityKey` + `signature`
// (generated once via a throwaway keypair; the private key itself was
// never committed, same as a real key-anchored space owner would do).
//
// Checks:
//   1. Hovering the portal shows the amber "no domain — trusted only by
//      its key" line in the tooltip BEFORE any click — the warning isn't
//      gated behind entry.
//   2. Clicking the portal fetches + verifies the manifest and opens the
//      mandatory disclosure (#keyAnchorModal) — Plaza is NOT left yet.
//   3. "Stay here" closes the disclosure with no world change at all.
//   4. "Enter anyway" actually enters — placeLabel shows the identityKey
//      fingerprint (never a domain) plus the persistent amber
//      .keyAnchorBadge, and this survives as long as you're standing
//      there (not just a one-time toast).
//   5. The key-anchored world's own `kind: "domain"` portal leads cleanly
//      back to Plaza — reusing ordinary portal-crossing code, zero new
//      "leave" mechanism — and the badge disappears once back.
//   6. A portal whose declared identityKey doesn't match what its
//      manifest actually contains is refused before the disclosure ever
//      shows (SPEC.md §3.6's "confirms both match" requirement).
//   7. A manifest that fails its own signature check (tampered after
//      signing, real HTTP round trip against a temporary local server —
//      no mocking) is refused the same way.
//
// Requires demo-domain-a's real issuer already running:
//   node issuer-server/server.js                                    (8001)
// This test does not start it itself (same convention as the other
// manual-*.js scripts) and starts its own tiny ephemeral HTTP server for
// the tampered-manifest case only.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { chromium } = require('playwright');
const http = require('http');
const path = require('path');
const fs = require('fs');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const REAL_MANIFEST_URL = 'http://localhost:8001/keyworld/spatial.json';
const REAL_MANIFEST = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'demo-domain-a', 'keyworld', 'spatial.json'), 'utf8'));
const REAL_IDENTITY_KEY = REAL_MANIFEST.identityKey;

// Same projection math as viewer.js's own project()/SCALE/COS30/SIN30 —
// duplicated here (same convention as manual-chat-capability-gate.js's own
// projectPortals) so a synthetic test-only portal marker can be clicked at
// its real projected screen position without adding any test-only hook to
// viewer.js itself.
async function projectPortals(frame) {
  return frame.evaluate(() => {
    return new Promise((resolve) => {
      const check = () => {
        if (window.__atlasScene && window.__atlasScene.portalMarkers.length) {
          const canvas = document.getElementById('scene');
          const originX = canvas.width / 2, originY = canvas.height / 2 + 40;
          const SCALE = 26, COS30 = Math.cos(Math.PI / 6), SIN30 = Math.sin(Math.PI / 6);
          resolve(window.__atlasScene.portalMarkers.map((m) => {
            const [x, , z] = m.position;
            return {
              sx: originX + (x - z) * COS30 * SCALE,
              sy: originY + (x + z) * SIN30 * SCALE,
              to: m.portal && m.portal.to,
              kind: m.portal && m.portal.kind,
              label: m.portal && m.portal.label
            };
          }));
        } else { requestAnimationFrame(check); }
      };
      check();
    });
  });
}

async function waitForPortal(frame, predicate, description, timeoutMs = 8000) {
  const start = Date.now();
  for (;;) {
    const portals = await projectPortals(frame);
    const match = portals.find(predicate);
    if (match) return match;
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for a portal matching: ' + description);
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function waitFor(frame, fn, description, timeoutMs = 8000) {
  const start = Date.now();
  for (;;) {
    if (await frame.evaluate(fn)) return;
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for: ' + description);
    await new Promise((r) => setTimeout(r, 150));
  }
}

function placeLabelText(frame) {
  return frame.evaluate(() => document.getElementById('placeLabel').textContent);
}
function statusText(frame) {
  return frame.evaluate(() => document.getElementById('status').textContent);
}
function keyAnchorModalActive(frame) {
  return frame.evaluate(() => document.getElementById('keyAnchorModal').classList.contains('active'));
}
function keyAnchorBadgePresent(frame) {
  return frame.evaluate(() => !!document.querySelector('#placeLabel .keyAnchorBadge'));
}

// Injects a synthetic portal marker straight into window.__atlasScene —
// picked up automatically on the next render() tick (see viewer.js's
// render(): portalHitboxes is rebuilt fresh from window.__atlasScene.
// portalMarkers every single frame), so clicking it drives the REAL
// production click handler -> followPortal() -> followKeyAnchoredPortal(),
// exactly the same code path a real portal would, with no test-only hook
// added to viewer.js itself.
async function injectPortal(frame, position, portal) {
  await frame.evaluate(({ position, portal }) => {
    window.__atlasScene.portalMarkers.push({ position, portal });
  }, { position, portal });
}

function startTamperedManifestServer(manifest) {
  // Same manifest, same (now-stale) signature, but the world's own name
  // changed AFTER signing — verifyKeyAnchoredManifest canonicalizes
  // whatever it's handed, so this is a real signature-mismatch case, not a
  // parsing error.
  const tampered = JSON.parse(JSON.stringify(manifest));
  tampered.worlds[0].name = 'Tampered Atrium';
  const body = JSON.stringify(tampered);
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-key-anchored');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  });
  let tamperedServer = null;

  try {
    const page = await context.newPage();
    await page.goto('http://localhost:8001', { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });

    console.log('STEP 1: hovering the key-anchored portal shows the amber "no domain" warning before any click');
    const keyPortal = await waitForPortal(frame, (p) => p.kind === 'key', 'the key-anchored portal from Plaza');
    await frame.locator('#scene').hover({ position: { x: keyPortal.sx, y: keyPortal.sy } });
    await waitFor(frame, () => {
      const el = document.getElementById('portalHoverTooltip');
      return getComputedStyle(el).display !== 'none' && el.innerHTML.includes('no domain');
    }, 'portal tooltip to show the "no domain" warning');
    console.log('PASS: hover tooltip discloses the missing domain before entry');

    console.log('STEP 2: clicking the portal fetches+verifies the manifest and opens the mandatory disclosure — Plaza is not left yet');
    await frame.locator('#scene').click({ position: { x: keyPortal.sx, y: keyPortal.sy } });
    await waitFor(frame, () => document.getElementById('keyAnchorModal').classList.contains('active'), 'the key-anchored disclosure modal to open');
    if (!(await placeLabelText(frame)).includes('Example Plaza')) throw new Error('Expected to still be at Plaza while the disclosure is open');
    const fingerprint = await frame.evaluate(() => document.getElementById('keyAnchorFingerprint').textContent);
    if (fingerprint !== REAL_IDENTITY_KEY) throw new Error('Expected the disclosure to show the real identityKey, got: ' + fingerprint);
    console.log('PASS: disclosure opened before entering, showing the real identityKey');

    console.log('STEP 3: "Stay here" closes the disclosure with no world change');
    await frame.locator('#keyAnchorStayBtn').click();
    await waitFor(frame, () => !document.getElementById('keyAnchorModal').classList.contains('active'), 'the disclosure to close after Stay');
    if (!(await placeLabelText(frame)).includes('Example Plaza')) throw new Error('Expected to still be at Plaza after Stay here');
    if (await keyAnchorBadgePresent(frame)) throw new Error('Expected no key-anchor badge while still at Plaza');
    console.log('PASS: Stay here leaves the visitor exactly where they were');

    console.log('STEP 4: "Enter anyway" actually enters — no domain shown, ever-present amber badge');
    await frame.locator('#scene').click({ position: { x: keyPortal.sx, y: keyPortal.sy } });
    await waitFor(frame, () => document.getElementById('keyAnchorModal').classList.contains('active'), 'the disclosure to reopen');
    await frame.locator('#keyAnchorEnterBtn').click();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Unlisted Atrium'), { timeout: 10000 });
    if (await keyAnchorModalActive(frame)) throw new Error('Expected the disclosure to be closed once inside');
    const label = await placeLabelText(frame);
    if (label.includes('localhost')) throw new Error('Expected NO domain string anywhere in the place label, got: ' + label);
    if (!label.includes('key:')) throw new Error('Expected the "key:" fingerprint fallback in the place label, got: ' + label);
    if (!(await keyAnchorBadgePresent(frame))) throw new Error('Expected the persistent amber key-anchor badge while standing in the key-anchored world');
    console.log('PASS: entered the key-anchored world with no domain shown and the persistent badge visible');

    console.log('STEP 5: the key-anchored world\'s own "domain" portal leads cleanly back to Plaza; the badge disappears once back');
    const leavePortal = await waitForPortal(frame, (p) => p.kind === 'domain' && p.to === 'localhost:8001', 'the return portal out of the Unlisted Atrium');
    await frame.locator('#scene').click({ position: { x: leavePortal.sx, y: leavePortal.sy } });
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    if (await keyAnchorBadgePresent(frame)) throw new Error('Expected the key-anchor badge to be gone back at Plaza');
    // placeLabel updates synchronously well before Plaza's own scene.json
    // fetch even starts (see enterWorld() in viewer.js), so window.__atlasScene
    // can still briefly be the world just LEFT (the Atrium's own single
    // portal) even once placeLabel already says "Example Plaza" — same race
    // manual-chat-capability-gate.js's own waitForPortal comment describes.
    // Waiting for Plaza's own native key-anchored portal to reappear
    // confirms the real 6-portal scene has actually loaded before the next
    // steps inject synthetic test portals into it.
    await waitForPortal(frame, (p) => p.kind === 'key', 'Plaza\'s own key-anchored portal reappearing (confirms the real scene reloaded, not a stale one)');
    console.log('PASS: left the key-anchored world through its own declared portal, ordinary portal-crossing code handled it with no special "leave" mechanism');

    console.log('STEP 6: a portal whose declared identityKey does not match what its manifest actually contains is refused before any disclosure shows');
    const wrongKey = REAL_IDENTITY_KEY.slice(0, -4) + (REAL_IDENTITY_KEY.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
    await injectPortal(frame, [-9, 0, -9], { kind: 'key', identityKey: wrongKey, manifest: REAL_MANIFEST_URL, label: 'Mismatched Key Test Portal' });
    const mismatchPortal = await waitForPortal(frame, (p) => p.label === 'Mismatched Key Test Portal', 'the injected mismatched-key test portal');
    await frame.locator('#scene').click({ position: { x: mismatchPortal.sx, y: mismatchPortal.sy } });
    await new Promise((r) => setTimeout(r, 800)); // give a wrongly-opening modal a real chance to appear before asserting it didn't
    if (await keyAnchorModalActive(frame)) throw new Error('Expected the disclosure to NEVER open for a portal/manifest identityKey mismatch');
    if (!(await placeLabelText(frame)).includes('Example Plaza')) throw new Error('Expected to still be at Plaza after a rejected identityKey mismatch');
    if (!(await statusText(frame)).toLowerCase().includes('key it was linked with')) throw new Error('Expected a clear status message naming the identityKey mismatch, got: ' + await statusText(frame));
    console.log('PASS: identityKey mismatch refused before any disclosure, with no world change');

    console.log('STEP 7: a manifest that fails its own signature check (tampered after signing, real HTTP fetch) is refused the same way');
    tamperedServer = await startTamperedManifestServer(REAL_MANIFEST);
    const tamperedUrl = `http://127.0.0.1:${tamperedServer.address().port}/tampered.json`;
    await injectPortal(frame, [-9, 0, 9], { kind: 'key', identityKey: REAL_IDENTITY_KEY, manifest: tamperedUrl, label: 'Tampered Signature Test Portal' });
    const tamperedPortal = await waitForPortal(frame, (p) => p.label === 'Tampered Signature Test Portal', 'the injected tampered-signature test portal');
    await frame.locator('#scene').click({ position: { x: tamperedPortal.sx, y: tamperedPortal.sy } });
    await new Promise((r) => setTimeout(r, 800));
    if (await keyAnchorModalActive(frame)) throw new Error('Expected the disclosure to NEVER open for a manifest that fails its own signature check');
    if (!(await placeLabelText(frame)).includes('Example Plaza')) throw new Error('Expected to still be at Plaza after a rejected bad signature');
    if (!(await statusText(frame)).toLowerCase().includes('signature')) throw new Error('Expected a clear status message naming the signature failure, got: ' + await statusText(frame));
    console.log('PASS: tampered manifest refused on signature verification, with no world change');

    console.log('\nALL KEY-ANCHORED WORLD (SPEC.md §3.6/§3.6.1) CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    if (tamperedServer) await new Promise((r) => tamperedServer.close(r));
    await context.close().catch(() => {});
  }
})();
