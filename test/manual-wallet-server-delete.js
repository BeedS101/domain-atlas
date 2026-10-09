// Manual end-to-end check: a message deleted from the wallet is deleted from
// the domain that held it.
//
//   1. Deleting one mail removes that message from the server and leaves the
//      rest.
//   2. A delete the server could not be told about (the request fails) leaves
//      the message on the server; the next mail check removes it.
//   3. Clearing the inbox removes all remaining mail from the server.
//   4. Deleting a chat thread removes its incoming messages from the server.
//   5. The other person's mailbox is untouched throughout.
//
// Requires the issuer-server on 8001 (this test does not start it). Set
// MAIL_DOMAIN=localhost:<port> to test the mail of another issuer, such as a
// PHP bundle, instead.
// Not part of the permanent suite, same as the other manual-*.js scripts.

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
// The pages are always opened from the issuer-server on 8001; MAIL_DOMAIN
// names the domain whose mail is under test (set it to a PHP bundle on
// another port to check that one).
const DOMAIN = process.env.MAIL_DOMAIN || 'localhost:8001';
const BASE = 'http://' + DOMAIN;

async function openOverlay(context, label) {
  const page = await context.newPage();
  await page.goto('http://localhost:8001', { waitUntil: 'load' });
  await page.locator('#domain-atlas-enter-btn').click();
  const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
  const frame = await frameHandle.contentFrame();
  await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), null, { timeout: 10000 });
  console.log('SETUP: ' + label + ' opened the overlay at Example Plaza');
  return { page, frame };
}

async function createIdentity(frame, password) {
  await frame.locator('#walletBtn').click();
  await frame.locator('#chooseNewBtn').click();
  await frame.locator('#newPasswordInput').fill(password);
  await frame.locator('#newPasswordConfirmInput').fill(password);
  await frame.locator('#confirmCreateBtn').click();
  await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), null, { timeout: 5000 });
  await frame.locator('#seedConfirmCheck').check();
  await frame.locator('#seedConfirmBtn').click();
  await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), null, { timeout: 5000 });
  const publicKey = await frame.evaluate(() => AtlasWallet.getIdentity().then((i) => i.publicKey));
  await frame.locator('#walletBtn').click();
  return publicKey;
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

// The mailbox as its owner reads it: the page signs a mail check with the
// wallet's key (SPEC.md §11.8).
const knownCards = new Map();
async function serverIds(owner, cardId) {
  const credential = knownCards.get(cardId);
  const body = await owner.frame.evaluate((async ({ base, credential }) => {
        const payload = { action: 'mail-check', domain: new URL(base).host, credentialIds: [credential.id], issuedAt: new Date().toISOString(), nonce: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18)))).replace(/[+\/=]/g, 'x') };
        const proof = await AtlasWallet.signWithSelf(payload);
        const res = await fetch(base + '/atlas/mail/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credentials: [credential], payload, proof }) });
        return res.json();
      }), { base: BASE, credential });
  if (!body.messages) throw new Error('mail check refused: ' + JSON.stringify(body));
  return body.messages.map((m) => m.id);
}

async function waitUntil(fn, description, timeoutMs = 10000) {
  const start = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for ' + description);
    await new Promise((r) => setTimeout(r, 200));
  }
}

(async () => {
  const launchOpts = { headless: false, executablePath: '/opt/pw-browsers/chromium', args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox'] };
  const contextA = await chromium.launchPersistentContext(path.resolve(__dirname, '.chrome-profile-walletdelete-a'), launchOpts);
  const contextB = await chromium.launchPersistentContext(path.resolve(__dirname, '.chrome-profile-walletdelete-b'), launchOpts);

  try {
    const alice = await openOverlay(contextA, 'Alice');
    const bob = await openOverlay(contextB, 'Bob');
    const pkAlice = await createIdentity(alice.frame, 'wallet-delete-password-alice');
    const pkBob = await createIdentity(bob.frame, 'wallet-delete-password-bob');
    await alice.frame.evaluate((d) => AtlasWallet.mintAsset('self', d, 'atlas.postoffice.membership'), DOMAIN);
    await bob.frame.evaluate((d) => AtlasWallet.mintAsset('self', d, 'atlas.postoffice.membership'), DOMAIN);
    const cardOf = async (p, pk) => {
      const id = await p.frame.evaluate((k) => AtlasWallet.getPostOfficeMemberships(k).then((m) => m[0].credentialId), pk);
      knownCards.set(id, await p.frame.evaluate((a) => AtlasWallet.getWallet(a.k).then((all) => all.find((e) => e.credential.id === a.id).credential), { k: pk, id }));
      return id;
    };
    const aliceCard = await cardOf(alice, pkAlice);
    const bobCard = await cardOf(bob, pkBob);

    const stamp = Date.now().toString(36);
    for (const n of [1, 2, 3]) await bob.frame.evaluate((a) => AtlasWallet.sendUserMail(a.d, a.k, 'mail ' + a.n + ' ' + a.s, 'body ' + a.n), { d: DOMAIN, k: pkAlice, n, s: stamp });
    for (const n of [1, 2]) await bob.frame.evaluate((a) => AtlasWallet.sendChatMessage(a.d, a.k, 'chat ' + a.n), { d: DOMAIN, k: pkAlice, n });
    await alice.frame.evaluate(() => AtlasWallet.checkAllMail());
    const mail = await alice.frame.evaluate((pk) => AtlasWallet.getMail(pk).then((m) => m.map((e) => ({ id: e.message.id, subject: e.message.subject }))), pkAlice);
    const chat = await alice.frame.evaluate((a) => AtlasWallet.getChatThreadMessages(a.pk, a.cp).then((m) => m.filter((e) => e.direction === 'in').map((e) => e.id)), { pk: pkAlice, cp: pkBob });
    const bobMail = mail.filter((m) => m.subject.includes(stamp));
    assert(bobMail.length === 3 && chat.length === 2, 'Alice should hold 3 mails and 2 chat messages, got ' + bobMail.length + '/' + chat.length);
    let onServer = await serverIds(alice, aliceCard);
    assert([...mail.map((m) => m.id), ...chat].every((id) => onServer.includes(id)), 'Everything delivered should still be on the server before any delete');
    const bobBefore = (await serverIds(bob, bobCard)).length;
    console.log('SETUP: Alice holds ' + mail.length + ' mails (3 from Bob) and ' + chat.length + ' chat messages; the server holds them all');

    console.log('STEP 1: deleting one mail removes it from the server');
    await alice.frame.evaluate((a) => AtlasWallet.deleteMailMessage(a.pk, a.id), { pk: pkAlice, id: bobMail[0].id });
    await waitUntil(async () => !(await serverIds(alice, aliceCard)).includes(bobMail[0].id), 'the deleted mail to leave the server');
    onServer = await serverIds(alice, aliceCard);
    assert(onServer.includes(bobMail[1].id) && onServer.includes(bobMail[2].id) && chat.every((id) => onServer.includes(id)), 'Only the deleted mail should have gone');
    console.log('PASS: the deleted mail is gone from the server, the rest remain');

    console.log('STEP 2: a delete the server was not told about is retried by the next mail check');
    await alice.frame.evaluate(() => { window.__realFetch = window.fetch; window.fetch = (u, o) => (String(u).includes('/atlas/mail/delete') ? Promise.reject(new Error('offline')) : window.__realFetch(u, o)); });
    await alice.frame.evaluate((a) => AtlasWallet.deleteMailMessage(a.pk, a.id), { pk: pkAlice, id: bobMail[1].id });
    await new Promise((r) => setTimeout(r, 1000));
    assert((await serverIds(alice, aliceCard)).includes(bobMail[1].id), 'With the request failing, the server still holds the message');
    await alice.frame.evaluate(() => { window.fetch = window.__realFetch; });
    await alice.frame.evaluate(() => AtlasWallet.checkAllMail());
    await waitUntil(async () => !(await serverIds(alice, aliceCard)).includes(bobMail[1].id), 'the next check to remove it');
    const localAfter = await alice.frame.evaluate((pk) => AtlasWallet.getMail(pk).then((m) => m.map((e) => e.message.id)), pkAlice);
    assert(!localAfter.includes(bobMail[1].id), 'The deleted message must not come back into the wallet');
    console.log('PASS: the failed delete was completed by the next check, and nothing came back');

    console.log('STEP 3: clearing the inbox removes the remaining mail from the server');
    await alice.frame.evaluate((pk) => AtlasWallet.clearAllMail(pk), pkAlice);
    await waitUntil(async () => { const ids = await serverIds(alice, aliceCard); return mail.every((m) => !ids.includes(m.id)); }, 'all mail to leave the server');
    onServer = await serverIds(alice, aliceCard);
    assert(chat.every((id) => onServer.includes(id)), 'Chat messages should still be on the server');
    console.log('PASS: all mail gone from the server; chat untouched');

    console.log('STEP 4: deleting the chat thread removes its messages from the server');
    await alice.frame.evaluate((a) => AtlasWallet.deleteChatThread(a.pk, a.cp), { pk: pkAlice, cp: pkBob });
    await waitUntil(async () => { const ids = await serverIds(alice, aliceCard); return chat.every((id) => !ids.includes(id)); }, 'the chat messages to leave the server');
    console.log('PASS: chat messages gone from the server');

    console.log('STEP 5: Bob\'s mailbox was untouched');
    assert((await serverIds(bob, bobCard)).length === bobBefore, 'Bob\'s mailbox should be unchanged');
    console.log('PASS: other mailbox unchanged');

    console.log('\nAll wallet-to-server delete checks passed.');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await contextA.close();
    await contextB.close();
    for (const d of ['a', 'b']) {
      try { fs.rmSync(path.resolve(__dirname, '.chrome-profile-walletdelete-' + d), { recursive: true, force: true }); } catch (err) { /* ignore */ }
    }
  }
})();
