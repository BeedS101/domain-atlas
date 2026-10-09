// Browser check that presence and chat connect for a world whose manifest id
// is free-form, and that a refused join is reported with its real reason
// instead of a bare "Not connected":
//
//   xvfb-run -a node test/manual-chat-join-failure.js
//
// Serves a copy of demo-domain-a plus the PHP presence bundle from one
// origin (the plain-hosting deployment) and enters it twice: once with a
// world id containing a space, once with an id the server refuses.

const { chromium } = require('/opt/node-tools/node_modules/playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8275;
const DOMAIN = 'localhost:' + PORT;
const BASE = 'http://' + DOMAIN;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log('PASS: ' + msg);
}

async function scenario(worldId) {
  const docroot = fs.mkdtempSync(path.join(os.tmpdir(), 'chatjoin-'));
  fs.cpSync(path.join(ROOT, 'demo-domain-a'), docroot, { recursive: true });
  fs.cpSync(path.join(ROOT, 'presence-php', 'presence'), path.join(docroot, 'presence'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'presence-php', 'test-router.php'), path.join(docroot, 'test-router.php'));
  for (const f of ['atlas-presence-store.json', 'atlas-chat-store.json']) { try { fs.unlinkSync(path.join(docroot, 'presence', 'lib', f)); } catch (err) {} }
  const mp = path.join(docroot, '.well-known', 'spatial.json');
  const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
  const w = m.worlds.find((x) => x.id === m.defaultWorld) || m.worlds[0];
  w.id = worldId; m.defaultWorld = worldId;
  m.domain = DOMAIN; m.presence = BASE;
  fs.writeFileSync(mp, JSON.stringify(m, null, 2));

  const php = spawn('php', ['-S', 'localhost:' + PORT, 'test-router.php'], { cwd: docroot, stdio: ['ignore', 'pipe', 'pipe'] });
  await sleep(1000);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'chatjoin-prof-'));
  const ctx = await chromium.launchPersistentContext(profile, { headless: false, executablePath: '/opt/pw-browsers/chromium', args: [`--disable-extensions-except=${ROOT}/extension`, `--load-extension=${ROOT}/extension`, '--no-sandbox'] });
  try {
    const page = await ctx.newPage();
    await page.goto(BASE + '/', { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const fh = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await fh.contentFrame();
    await frame.waitForFunction(() => !document.getElementById('placeLabel').textContent.includes('Loading'), null, { timeout: 15000 });
    const pw = 'chatjoin-password-1';
    await frame.locator('#walletBtn').click(); await frame.locator('#chooseNewBtn').click();
    await frame.locator('#newPasswordInput').fill(pw); await frame.locator('#newPasswordConfirmInput').fill(pw);
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'));
    await frame.locator('#seedConfirmCheck').check(); await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'));
    await frame.locator('#walletBtn').click();
    await sleep(4000); // past the WebSocket timeout, onto the polling fallback

    const st = await frame.evaluate(() => ({ chat: chatIsConnected(), pres: presenceIsConnected() }));
    const countRes = await fetch(BASE + '/presence/status?domain=' + encodeURIComponent(DOMAIN) + '&world=' + encodeURIComponent(worldId));
    const count = countRes.ok ? (await countRes.json()).count : null;
    await frame.locator('#chatTextInput').fill('hello');
    await frame.locator('#chatTextInput').press('Enter');
    await sleep(900);
    const sendStatus = await frame.evaluate(() => document.getElementById('chatSendStatus').textContent);
    const lines = await frame.evaluate(() => document.getElementById('chatMessages').textContent);
    return { st, count, sendStatus, lines };
  } finally {
    await ctx.close();
    php.kill();
  }
}

(async () => {
  const ok = await scenario('Main Hall');
  check(ok.st.chat && ok.st.pres, 'a world id with a space connects presence and chat');
  check(ok.count === 1, 'status counts the visitor in the spaced world (admin "Online now" source)');
  check(ok.sendStatus === '' && /Visitor: hello|: hello/.test(ok.lines), 'a chat message sends and appears');

  const refused = await scenario('x'.repeat(121));
  check(!refused.st.chat && !refused.st.pres, 'an id the server refuses leaves chat and presence disconnected');
  check(refused.sendStatus === 'The chat server refused this world.', 'the refusal reason is shown on send: "' + refused.sendStatus + '"');
  check(!/Not connected/.test(refused.sendStatus), 'the refusal is not reported as a generic "Not connected"');
  console.log('All checks passed.');
  process.exit(0);
})().catch((err) => { console.error('FAIL: ' + err.message); process.exit(1); });
