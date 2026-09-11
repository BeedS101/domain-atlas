// Manual check for #138: typing a space (or any WASD/arrow/Shift/Ctrl key)
// into a text field used to leak straight through into the 3D character's
// movement, because gltf-mini.js's onKeyDown was a plain `window`
// listener with no check for what actually had focus — pressing Space
// while chatting made the character jump instead of typing a space, and
// holding W would walk right off a chat message.
//
// The fix (gltf-mini.js, near onKeyDown/onFocusIn) is generic — it checks
// document.activeElement's tag/type, not a specific element id — so per
// Bruno's explicit ask ("do it for all textboxes when they have focus")
// this test exercises it against TWO unrelated fields (chat's own text
// input, since that's the originally reported case, AND the Identity
// screen's alias input, to prove it isn't hardcoded to chat) plus the
// "already holding a movement key, THEN click into a field without
// releasing it" edge case onFocusIn specifically covers.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts. Assumes issuer-server is already running on 8001
// and presence-server on 8004 (chat needs it — see README).

const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-movement-focus-guard');
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

    console.log('SETUP: create a wallet identity (needed for chat to be sendable), then walk into the 3D Lobby');
    await frame.locator('#walletBtn').click();
    await frame.locator('#chooseNewBtn').click();
    await frame.locator('#newPasswordInput').fill('movement-focus-guard-pw');
    await frame.locator('#newPasswordConfirmInput').fill('movement-focus-guard-pw');
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('#walletBtn').click(); // close the panel so the scene/canvas is reachable

    const lobbyHb = await frame.evaluate(() => new Promise((resolve) => {
      const check = () => {
        if (typeof portalHitboxes !== 'undefined' && portalHitboxes.length) {
          const hb = portalHitboxes.find((h) => h.marker.portal && h.marker.portal.to === 'lobby');
          if (hb) return resolve({ sx: hb.sx, sy: hb.sy });
        }
        requestAnimationFrame(check);
      };
      check();
    }));
    await frame.locator('#scene').click({ position: { x: lobbyHb.sx, y: lobbyHb.sy } });
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Lobby'), { timeout: 10000 });
    await frame.waitForFunction(() => !!window.__atlasActive3D, { timeout: 10000 });
    console.log('PASS: in the 3D Lobby, window.__atlasActive3D live');

    async function readPos() {
      return frame.evaluate(() => window.__atlasActive3D.camera.pos.slice());
    }
    function moved(a, b) {
      return Math.abs(a[0] - b[0]) > 0.01 || Math.abs(a[1] - b[1]) > 0.01 || Math.abs(a[2] - b[2]) > 0.01;
    }

    console.log('STEP 0 (sanity): holding W on the focused canvas DOES move the camera — confirms movement itself still works before testing the guard');
    await frame.locator('#scene3d').click({ position: { x: 5, y: 5 } });
    const posBeforeSanity = await readPos();
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(200);
    await page.keyboard.up('KeyW');
    const posAfterSanity = await readPos();
    if (!moved(posBeforeSanity, posAfterSanity)) throw new Error('Expected normal W movement to actually move the camera on the focused canvas');
    console.log('PASS: normal movement works');

    console.log('STEP 1: focusing the CHAT text input and typing (including a Space) neither moves the character nor eats the space character');
    await frame.locator('#chatTextInput').click();
    await frame.waitForFunction(() => document.activeElement && document.activeElement.id === 'chatTextInput', { timeout: 2000 });
    const posBeforeChatTyping = await readPos();
    await page.keyboard.type('hi there'); // real keydown/keyup events, including Space and the movement-key letters in "there" (KeyT/KeyH/KeyE/KeyR/KeyE — none are WASD, so type something with a 'w' too)
    await page.keyboard.type(' walk');
    const chatValue = await frame.locator('#chatTextInput').inputValue();
    if (chatValue !== 'hi there walk') throw new Error('Expected the full typed text including spaces to land in the chat input, got: ' + JSON.stringify(chatValue));
    const posAfterChatTyping = await readPos();
    if (moved(posBeforeChatTyping, posAfterChatTyping)) throw new Error('Expected typing in chat (including Space and W) to NOT move the character, but it moved: ' + JSON.stringify({ posBeforeChatTyping, posAfterChatTyping }));
    console.log('PASS: chat input received every character including spaces, and the character never moved');

    console.log('STEP 2: same guard applies to a COMPLETELY DIFFERENT text field (the Identity settings category\'s alias input), proving this isn\'t hardcoded to chat specifically');
    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    const identityCategory = frame.locator('#mainWalletScreen .settings-category[data-category="identity"]');
    if (!(await identityCategory.evaluate((el) => el.classList.contains('open')))) {
      await identityCategory.locator('.settings-category-toggle').click();
      await frame.waitForFunction(() => document.querySelector('#mainWalletScreen .settings-category[data-category="identity"]').classList.contains('open'), { timeout: 5000 });
    }
    await frame.locator('#aliasInput').click();
    await frame.waitForFunction(() => document.activeElement && document.activeElement.id === 'aliasInput', { timeout: 2000 });
    const posBeforeAliasTyping = await readPos();
    await page.keyboard.type('Way Walker'); // deliberately full of W/A/S/D letters and a space
    const aliasValue = await frame.locator('#aliasInput').inputValue();
    if (aliasValue !== 'Way Walker') throw new Error('Expected the alias input to receive the full typed text, got: ' + JSON.stringify(aliasValue));
    const posAfterAliasTyping = await readPos();
    if (moved(posBeforeAliasTyping, posAfterAliasTyping)) throw new Error('Expected typing in the alias input to NOT move the character, but it moved');
    console.log('PASS: the guard is generic — an unrelated text field is protected too, no per-field wiring needed');
    await frame.locator('#aliasInput').fill(''); // leave it clean
    await frame.locator('#walletBtn').click(); // close panel, back to the scene

    console.log('STEP 3: holding a movement key, THEN focusing a text field WITHOUT releasing it first, stops the movement immediately (onFocusIn clearing stale held keys)');
    await frame.locator('#scene3d').click({ position: { x: 5, y: 5 } });
    await page.keyboard.down('KeyW'); // start holding — do NOT release yet
    await page.waitForTimeout(150);
    const posMidHold = await readPos();
    await frame.locator('#chatTextInput').click(); // focus change while W is still physically "held" from Playwright's perspective
    await frame.waitForFunction(() => document.activeElement && document.activeElement.id === 'chatTextInput', { timeout: 2000 });
    const posRightAfterFocus = await readPos();
    await page.waitForTimeout(250); // if the key were still stuck "on", the character would keep sliding during this window
    const posWellAfterFocus = await readPos();
    await page.keyboard.up('KeyW'); // clean up Playwright's own held-key state for anything after this test
    if (moved(posBeforeSanity, posMidHold) === false) throw new Error('Sanity: expected the camera to have actually moved during the initial hold, got no movement at all');
    if (moved(posRightAfterFocus, posWellAfterFocus)) throw new Error('Expected movement to have fully stopped the instant focus moved to the chat input — camera kept moving afterward, meaning KeyW stayed stuck "on": ' + JSON.stringify({ posRightAfterFocus, posWellAfterFocus }));
    console.log('PASS: focusing a text field while a movement key was already held immediately releases it — no stuck-key sliding');

    console.log('\nALL CHECKS PASSED — movement keys (including Space) no longer leak into any text field, and a key already held is released the instant focus moves into one.');
  } catch (err) {
    console.error('FAIL:', err.message);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
