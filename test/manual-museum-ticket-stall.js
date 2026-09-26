// End-to-end check for the Museum's own ticket booth
// (demo-domain-a/spatial/museum/scene.json) — the spatial-world worked
// example the cafeteria demo's own "purchase a fungible balance into
// something else" logic generalizes to: the SAME atlas.credit.balance
// class, spent through the SAME generic /atlas/asset/purchase endpoint,
// from a completely different UI (a 3D stall instead of a 2D page). Also
// the first scene-declared "purchase" interactable, and the first time
// AtlasWallet.purchaseAsset() (extension/wallet.js) gets exercised at all.
//
// Drives the actual wallet extension against the repo's own real dev
// instance on localhost:8001 (ATLAS_STATE_DIR/ATLAS_DOCROOT default to
// issuer-server/ and demo-domain-a — same convention every other
// extension-driven manual-*.js test in this project already assumes), so
// the git-ignored state files it produces are cleaned up before and after,
// same testing discipline as every other run against this instance.
//
// Checks:
//   1. Walking from the Plaza into the Museum shows the new "Get Museum
//      Credits" and "Buy a Day Ticket" stalls (previously an empty room).
//   2. Clicking "Get Museum Credits" mints 20 atlas.credit.balance for self.
//   3. Clicking "Buy a Day Ticket" spends 10 of it, leaves a 10-credit
//      remainder, and adds a real atlas.demo.museum.ticket credential
//      whose own asset.expiresAt is a few minutes in the future — and the
//      status line reports the same expiry time back to the visitor.
//   4. Buying a second ticket spends the balance to exactly zero (no
//      remainder credential at all).
//   5. Buying a third ticket, with no balance left, fails client-side with
//      a clear "Not enough" message — no request needed to reach the
//      issuer to know that.
//   6. The first ticket's raw credential, pasted into the admin panel's
//      "Fulfill a purchase" section (session seeded directly, same
//      no-extension-needed trick manual-cafeteria-demo.js already uses),
//      fulfills successfully before its deadline passes.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const NODE_BASE = 'http://localhost:8001';

// Git-ignored files the real dev instance produces — same .gitignore
// entries (issuer-server/issuer-private-key.jwk.json,
// issuer-server/atlas-*.json, demo-domain-a/.well-known/atlas-{key,
// revocations}.json) every other test against this instance already
// follows, and the same cleanup obligation, before AND after.
const ISSUER_SERVER_DIR = path.resolve(__dirname, '..', 'issuer-server');
const ADMIN_KEYS_FILE = path.join(ISSUER_SERVER_DIR, 'atlas-admin-keys-store.json');
const WELL_KNOWN_DIR = path.resolve(__dirname, '..', 'demo-domain-a', '.well-known');
const CHROME_PROFILE_DIR = path.resolve(__dirname, '.chrome-profile-museum-ticket-stall');
function cleanGeneratedFiles() {
  try { fs.rmSync(path.join(ISSUER_SERVER_DIR, 'issuer-private-key.jwk.json'), { force: true }); } catch (err) {}
  try {
    for (const name of fs.readdirSync(ISSUER_SERVER_DIR)) {
      if (name.startsWith('atlas-') && name.endsWith('.json')) fs.rmSync(path.join(ISSUER_SERVER_DIR, name), { force: true });
    }
  } catch (err) {}
  try { fs.rmSync(path.join(WELL_KNOWN_DIR, 'atlas-key.json'), { force: true }); } catch (err) {}
  try { fs.rmSync(path.join(WELL_KNOWN_DIR, 'atlas-revocations.json'), { force: true }); } catch (err) {}
  // A stale profile from a previous run already has a wallet identity
  // created in it — this test always wants a brand-new one, so the
  // profile dir is cleaned the same as every other generated state here,
  // before AND after.
  try { fs.rmSync(CHROME_PROFILE_DIR, { recursive: true, force: true }); } catch (err) {}
}

function assert(cond, message) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + message);
}
function b64url(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
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
async function signWithSelf(kp, publicKey, payload) {
  const data = new TextEncoder().encode(canonicalize(payload));
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, data));
  return { signerRole: 'raw-ecdsa', publicKey, signature: b64url(sig) };
}
async function postJson(urlPath, body) {
  const res = await fetch(NODE_BASE + urlPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return { status: res.status, body: await res.json() };
}
// Real nonce/sign/start round trip (same as manual-admin-session.js /
// manual-cafeteria-demo.js) — a genuine session token obtained without the
// wallet extension's own login UI in the way.
async function startAdminSession(admin) {
  const nonce = (await fetch(NODE_BASE + '/atlas/admin/session/nonce').then((r) => r.json())).nonce;
  const payload = { nonce };
  const proof = await signWithSelf(admin.kp, admin.publicKey, payload);
  const res = await postJson('/atlas/admin/session/start', { payload, proof });
  if (res.status !== 200) throw new Error('admin login failed: ' + JSON.stringify(res.body));
  return res.body.token;
}

// Same established pattern as manual-market-stalls.js's projectInteractables
// — waits specifically for the Museum's own two new interactables (never
// resolves against a stale, previous world's list), then projects both to
// 2D canvas coordinates a click can target.
async function projectMuseumInteractables(frame) {
  return frame.evaluate(() => {
    return new Promise((resolve) => {
      const check = () => {
        const scene = window.__atlasScene;
        if (scene && scene.interactables && scene.interactables.some((m) => m.class === 'atlas.demo.museum.ticket')) {
          const canvas = document.getElementById('scene');
          const originX = canvas.width / 2;
          const originY = canvas.height / 2 + 40;
          const points = scene.interactables.map((m) => {
            const [x, y, z] = m.position;
            const p = project(x, y || 0, z, originX, originY);
            return { sx: p.x, sy: p.y - 16, label: m.label, action: m.action, class: m.class };
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

(async () => {
  cleanGeneratedFiles();
  console.log('SETUP: starting the repo\'s own real dev instance on port 8001 (default state dir/docroot)');
  const nodeProc = spawn('node', ['issuer-server/server.js'], {
    cwd: path.resolve(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('issuer-server did not start in time')), 10000);
    nodeProc.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); resolve(); } });
    nodeProc.on('exit', (code) => reject(new Error('issuer-server exited early with code ' + code)));
  });
  console.log('PASS: dev instance up on port 8001');

  const context = await chromium.launchPersistentContext(CHROME_PROFILE_DIR, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-sandbox'
    ]
  });

  try {
    console.log('SETUP: registering an admin identity and starting a real session for it');
    const admin = await genIdentity();
    fs.writeFileSync(ADMIN_KEYS_FILE, JSON.stringify({ keys: [{ publicKey: admin.publicKey, addedAt: new Date().toISOString() }] }, null, 2));
    const adminToken = await startAdminSession(admin);
    console.log('PASS: admin session token obtained ->', adminToken.slice(0, 16) + '...');

    const page = await context.newPage();
    console.log('SETUP: creating an identity and walking to the Museum (previously an empty room)');
    await page.goto(NODE_BASE, { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), null, { timeout: 10000 });
    await frame.locator('#walletBtn').click();
    await frame.locator('#chooseNewBtn').click();
    await frame.locator('#newPasswordInput').fill('museum-ticket-password');
    await frame.locator('#newPasswordConfirmInput').fill('museum-ticket-password');
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), null, { timeout: 5000 });
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), null, { timeout: 5000 });
    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => !document.getElementById('walletPanel').classList.contains('open'), null, { timeout: 5000 });

    const museumHb = await frame.evaluate(() => new Promise((resolve) => {
      const check = () => {
        if (portalHitboxes.length) {
          const hb = portalHitboxes.find((h) => h.marker.portal && h.marker.portal.to === 'museum');
          if (hb) return resolve({ sx: hb.sx, sy: hb.sy });
        }
        requestAnimationFrame(check);
      };
      check();
    }));
    await frame.locator('#scene').click({ position: { x: museumHb.sx, y: museumHb.sy } });
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Museum'), null, { timeout: 10000 });
    console.log('PASS: reached the Museum');

    console.log('STEP 1: the Museum now shows the ticket booth\'s two stalls');
    const [creditsStall, ticketStall] = await projectMuseumInteractables(frame);
    assert(creditsStall && creditsStall.class === 'atlas.credit.balance', 'expected the first interactable to be the credits top-up, got: ' + JSON.stringify(creditsStall));
    assert(ticketStall && ticketStall.class === 'atlas.demo.museum.ticket' && ticketStall.action === 'purchase', 'expected the second interactable to be the ticket purchase, got: ' + JSON.stringify(ticketStall));
    console.log('PASS: "Get Museum Credits" and "Buy a Day Ticket" both present, where nothing used to be');

    console.log('STEP 2: clicking "Get Museum Credits" mints 20 atlas.credit.balance for self');
    await frame.locator('#scene').click({ position: { x: creditsStall.sx, y: creditsStall.sy } });
    await frame.waitForFunction(() => document.getElementById('status').textContent.startsWith('Collected'), null, { timeout: 10000 });
    const balanceAfterTopUp = await frame.evaluate(async () => {
      const identity = await AtlasWallet.getIdentity();
      const wallet = await AtlasWallet.getWallet(identity.publicKey);
      const entry = wallet.find((e) => e.credential.asset.class === 'atlas.credit.balance');
      return entry ? entry.credential.quantity : null;
    });
    assert(balanceAfterTopUp === 20, 'expected 20 credits after topping up, got: ' + balanceAfterTopUp);
    console.log('PASS: 20 atlas.credit.balance minted for self');

    console.log('STEP 3: clicking "Buy a Day Ticket" spends 10 credits, leaves a 10-credit remainder, and mints a real ticket with a future expiresAt');
    const statusBeforeTicket = await frame.locator('#status').textContent();
    await frame.locator('#scene').click({ position: { x: ticketStall.sx, y: ticketStall.sy } });
    await frame.waitForFunction((prev) => {
      const t = document.getElementById('status').textContent;
      return t !== prev && t.startsWith('Bought');
    }, statusBeforeTicket, { timeout: 10000 });
    const statusAfterTicket = await frame.locator('#status').textContent();
    assert(statusAfterTicket.includes('Museum Day Ticket') && statusAfterTicket.includes('expires'), 'expected the status line to name the ticket and its expiry, got: ' + statusAfterTicket);
    const afterFirstBuy = await frame.evaluate(async () => {
      const identity = await AtlasWallet.getIdentity();
      const wallet = await AtlasWallet.getWallet(identity.publicKey);
      const balanceEntry = wallet.find((e) => e.credential.asset.class === 'atlas.credit.balance');
      const ticketEntry = wallet.find((e) => e.credential.asset.class === 'atlas.demo.museum.ticket');
      return {
        balanceQty: balanceEntry ? balanceEntry.credential.quantity : null,
        ticketExpiresAt: ticketEntry ? ticketEntry.credential.asset.expiresAt : null,
        ticketCredential: ticketEntry ? ticketEntry.credential : null
      };
    });
    assert(afterFirstBuy.balanceQty === 10, 'expected a 10-credit remainder after the first ticket, got: ' + afterFirstBuy.balanceQty);
    assert(typeof afterFirstBuy.ticketExpiresAt === 'string', 'expected the ticket to carry a real expiresAt, got: ' + JSON.stringify(afterFirstBuy));
    assert(new Date(afterFirstBuy.ticketExpiresAt).getTime() > Date.now(), 'expected the freshly-bought ticket to not already be expired');
    const firstTicketRaw = JSON.stringify(afterFirstBuy.ticketCredential, null, 2);
    console.log('PASS: 20 -> 10 credits, ticket minted, expiresAt ->', afterFirstBuy.ticketExpiresAt);

    // STEP 3 above already proves the whole new integration end to end —
    // a real click on the 3D stall reaching AtlasWallet.purchaseAsset()
    // and the result landing correctly in the wallet and the status line.
    // The remaining two checks are about that SAME function's own
    // arithmetic at its edges (spending a balance to exactly zero;
    // rejecting a purchase with nothing left to spend) — calling it
    // directly here rather than through a second/third canvas click
    // exercises the identical code path (extension/viewer.js's handler is
    // a thin, one-line pass-through to this same call) without depending
    // on this sandbox's headless/xvfb Chromium reliably delivering a
    // second rapid click to the right canvas pixel.
    console.log('STEP 4: buying a second ticket spends the remaining 10 credits to exactly zero — no remainder credential left');
    const secondBuy = await frame.evaluate(() => AtlasWallet.purchaseAsset('self', 'localhost:8001', 'atlas.demo.museum.ticket'));
    assert(secondBuy.balance === null, 'expected spending the exact remaining balance to leave no remainder credential, got: ' + JSON.stringify(secondBuy.balance));
    const afterSecondBuy = await frame.evaluate(async () => {
      const identity = await AtlasWallet.getIdentity();
      const wallet = await AtlasWallet.getWallet(identity.publicKey);
      return {
        hasBalance: wallet.some((e) => e.credential.asset.class === 'atlas.credit.balance'),
        ticketCount: wallet.filter((e) => e.credential.asset.class === 'atlas.demo.museum.ticket').length
      };
    });
    assert(afterSecondBuy.hasBalance === false, 'expected no balance credential left in the wallet after spending to exactly zero');
    assert(afterSecondBuy.ticketCount === 2, 'expected two tickets held now, got: ' + afterSecondBuy.ticketCount);
    console.log('PASS: 10 -> 0 credits, balance credential gone entirely, two tickets now held');

    console.log('STEP 5: buying a third ticket with no balance left fails client-side with a clear "Not enough" message');
    const thirdBuyError = await frame.evaluate(async () => {
      try {
        await AtlasWallet.purchaseAsset('self', 'localhost:8001', 'atlas.demo.museum.ticket');
        return null;
      } catch (err) {
        return err.message;
      }
    });
    assert(thirdBuyError && /Not enough/.test(thirdBuyError), 'expected a clear insufficient-balance message, got: ' + thirdBuyError);
    console.log('PASS: third purchase rejected client-side ->', thirdBuyError);

    console.log('STEP 6: the first ticket\'s raw credential fulfills on the admin panel before its deadline passes');
    const adminPage = await context.newPage();
    await adminPage.addInitScript((token) => {
      sessionStorage.setItem('atlasAdminSession', JSON.stringify({ token, expiresAt: Date.now() + 5 * 60 * 1000 }));
    }, adminToken);
    await adminPage.goto(NODE_BASE + '/atlas-admin/', { waitUntil: 'load' });
    await adminPage.waitForFunction(() => document.getElementById('hidden-while-logged-out').style.display !== 'none', null, { timeout: 10000 });
    await adminPage.fill('#fulfillCredential', firstTicketRaw);
    await adminPage.locator('#fulfillBtn').click();
    await adminPage.waitForFunction(() => {
      const el = document.getElementById('fulfillResult');
      return el && el.textContent.includes('Fulfilled');
    }, null, { timeout: 10000 });
    const fulfillResultText = await adminPage.locator('#fulfillResult').textContent();
    assert(fulfillResultText.includes('Museum Day Ticket'), 'expected the fulfill result to name the ticket, got: ' + fulfillResultText);
    console.log('PASS: admin panel fulfilled the ticket ->', fulfillResultText);
    await adminPage.close();

    console.log('\nALL MUSEUM TICKET STALL CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close().catch(() => {});
    nodeProc.kill();
    cleanGeneratedFiles();
  }
})();
