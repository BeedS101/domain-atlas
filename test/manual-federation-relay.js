// Manual end-to-end check for task #97 (SPEC.md §11.4): real domain-to-
// domain Post Office federation — a `handle#domain` address (§11.3) that
// names a domain OTHER than any the sender is a member of now actually
// reaches its recipient, relayed server-to-server, rather than silently
// requiring the sender to also join the recipient's own domain first.
//
// This is the first test in this suite to prove a SERVER makes an outbound
// request to another domain — everything else cross-domain up to now has
// been a CLIENT talking to whichever one domain it needed. Alice's home
// domain is localhost:8001 (Example Plaza) and Bob's home domain is
// localhost:8002 (Neighbor Workshop) — two already-independent, already-
// running issuer-server processes, exactly what a real federation test
// needs. Post Office membership is minted directly via AtlasWallet.mintAsset
// (same generic "issue" mechanism the Post Office stall interactable itself
// calls) rather than walking either visitor through the in-world stall —
// this test's own subject is the server-to-server relay, not the
// membership-claiming UI already covered by manual-postoffice-mail.js and
// manual-messaging-window.js.
//
// Requires domain A's issuer-server on 8001 AND domain B's on 8002 (same as
// every other cross-domain test in this suite) — this test does not start
// either itself.
//
// Checks:
//   1. Alice (home: localhost:8001) and Bob (home: localhost:8002) each
//      hold a Post Office membership ONLY at their own home domain — never
//      at the other's — and each registers a handle there.
//   2. Alice resolves bob#localhost:8002 (§11.3, already cross-domain-
//      capable lookup) and sends mail through HER OWN home domain
//      (localhost:8001) addressed to Bob's home domain. Domain A relays it
//      to Domain B server-to-server; the relay succeeds.
//   3. Domain B's OWN on-disk mail store (not just what a client sees) is
//      read directly to prove `from.homeDomain` really is Alice's home
//      domain (localhost:8001), not Domain B mislabeling its own delivery
//      domain as the sender's address.
//   4. Bob's ordinary mail check picks it up, decrypts/reads correctly, and
//      the Mail tab's own display renders "alice#localhost:8001" — not
//      "alice#localhost:8002" — proving the viewer.js homeDomain display
//      fix actually works, not just that the field exists on disk.
//   5. Sending to a real public key that is NOT actually a member of the
//      named home domain is rejected with a clear error (the home domain's
//      own §11.3 step-3 membership check still runs on a relayed send).
//   6. Domain B's own operator federation-blocklist (task #97's explicit
//      "block spamming/misbehaving domains" safety valve) actually rejects
//      a relay attempt from a domain it names, with a clear error — and a
//      DIFFERENT, unblocked domain relaying to Domain B in the meantime is
//      unaffected (the block is scoped to the named domain, not global).
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts. Node-to-Node only — see the companion PHP smoke
// script (scratchpad) for a lighter, protocol-level check that
// issuer-php's own relay.php/send.php port behaves the same way; a full
// PHP-backed Playwright equivalent of this file is a reasonable follow-up,
// not done this round (see the private notes for why).

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const DOMAIN_A = 'localhost:8001';
const DOMAIN_B = 'localhost:8002';
const MAIL_STORE_B_PATH = path.resolve(__dirname, '..', 'issuer-server', 'domain-b-state', 'atlas-mail-store.json');
const BLOCKLIST_B_PATH = path.resolve(__dirname, '..', 'issuer-server', 'domain-b-state', 'atlas-federation-blocklist.json');

function readServerMailStoreB() {
  return JSON.parse(fs.readFileSync(MAIL_STORE_B_PATH, 'utf8')).messages;
}

async function newestServerMessageB(beforeCount) {
  const messages = readServerMailStoreB();
  if (messages.length !== beforeCount + 1) {
    throw new Error(`Expected exactly 1 new message on Domain B's own store, went from ${beforeCount} to ${messages.length}`);
  }
  return messages[messages.length - 1];
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

(async () => {
  const dirA = path.resolve(__dirname, '.chrome-profile-federation-a');
  const dirB = path.resolve(__dirname, '.chrome-profile-federation-b');
  const launchOpts = { headless: false, executablePath: '/opt/pw-browsers/chromium', args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox'] };

  const contextA = await chromium.launchPersistentContext(dirA, launchOpts);
  const contextB = await chromium.launchPersistentContext(dirB, launchOpts);

  // Clean slate for the blocklist file this test writes to, in case a
  // previous interrupted run left one behind.
  if (fs.existsSync(BLOCKLIST_B_PATH)) fs.unlinkSync(BLOCKLIST_B_PATH);

  try {
    const alice = await openOverlay(contextA, 'Alice');
    const bob = await openOverlay(contextB, 'Bob');

    console.log('STEP 0: Alice and Bob each create a real identity and hold Post Office membership ONLY at their own home domain');
    const pkAlice = await createIdentity(alice.frame, 'federation-test-password-alice');
    const pkBob = await createIdentity(bob.frame, 'federation-test-password-bob');
    await alice.frame.evaluate((domain) => AtlasWallet.mintAsset('self', domain, 'atlas.postoffice.membership'), DOMAIN_A);
    await bob.frame.evaluate((domain) => AtlasWallet.mintAsset('self', domain, 'atlas.postoffice.membership'), DOMAIN_B);
    await alice.frame.evaluate((domain) => AtlasWallet.setPostOfficeHandle(domain, 'alice'), DOMAIN_A);
    await bob.frame.evaluate((domain) => AtlasWallet.setPostOfficeHandle(domain, 'bob'), DOMAIN_B);
    console.log('PASS: Alice is a member only at ' + DOMAIN_A + ' (handle alice), Bob only at ' + DOMAIN_B + ' (handle bob)');

    console.log('STEP 1: Alice resolves bob#localhost:8002 and sends through HER OWN home domain, addressed to Bob\'s home domain');
    const resolved = await alice.frame.evaluate((domain) => AtlasWallet.resolvePostOfficeHandle(domain, 'bob'), DOMAIN_B);
    if (resolved.publicKey !== pkBob) throw new Error('Resolved the wrong public key for bob#' + DOMAIN_B);
    let beforeCount = readServerMailStoreB().length;
    const sendResult = await alice.frame.evaluate(
      (args) => AtlasWallet.sendUserMail(args.viaDomain, { publicKey: args.pk, domain: args.homeDomain }, args.subject, args.body, null),
      { viaDomain: DOMAIN_A, pk: pkBob, homeDomain: DOMAIN_B, subject: 'Cross-domain hello', body: 'This message was relayed from localhost:8001 to localhost:8002.' }
    );
    if (!sendResult || !sendResult.id) throw new Error('Expected a successful relayed send, got: ' + JSON.stringify(sendResult));
    console.log('PASS: relay succeeded — Domain A accepted the send and relayed it to Domain B without Alice ever joining Domain B');

    console.log('STEP 2: Domain B\'s OWN on-disk mail store shows from.homeDomain as Alice\'s REAL home domain, not Domain B mislabeling its own delivery');
    const raw = await newestServerMessageB(beforeCount);
    if (raw.from.publicKey !== pkAlice) throw new Error('Expected from.publicKey to be Alice\'s real key, got: ' + raw.from.publicKey);
    if (raw.from.handle !== 'alice') throw new Error('Expected from.handle "alice" (registered at her home domain), got: ' + raw.from.handle);
    if (raw.from.homeDomain !== DOMAIN_A) throw new Error('Expected from.homeDomain to be ' + DOMAIN_A + ' (Alice\'s real home), got: ' + raw.from.homeDomain);
    if (raw.body !== 'This message was relayed from localhost:8001 to localhost:8002.') throw new Error('Body did not survive the relay unchanged: ' + raw.body);
    console.log('PASS: Domain B\'s own stored copy correctly attributes the message to alice#' + DOMAIN_A);

    console.log('STEP 3: Bob\'s ordinary mail check picks it up, and the Mail tab actually RENDERS "alice#localhost:8001" (the homeDomain display fix)');
    await bob.frame.evaluate(() => AtlasWallet.checkAllMail());
    await bob.frame.locator('#walletBtn').click();
    await bob.frame.locator('#socialTabBtn').click();
    await bob.frame.waitForFunction(() => document.getElementById('mailSubscreen').classList.contains('active'), { timeout: 5000 });
    await bob.frame.waitForFunction(() => document.getElementById('mailList').textContent.includes('Cross-domain hello'), { timeout: 10000 });
    const mailListText = await bob.frame.locator('#mailList').textContent();
    if (!mailListText.includes('alice#' + DOMAIN_A)) {
      throw new Error('REGRESSION: expected the Mail tab to show "alice#' + DOMAIN_A + '", got: ' + mailListText);
    }
    if (mailListText.includes('alice#' + DOMAIN_B)) {
      throw new Error('REGRESSION: Mail tab misattributed the relayed sender to Domain B (its own delivery domain) instead of Alice\'s real home');
    }
    console.log('PASS: Bob sees the message, correctly attributed to alice#' + DOMAIN_A + ', not misattributed to ' + DOMAIN_B);

    console.log('STEP 4: sending to a real public key that is NOT actually a member of the named home domain is rejected clearly');
    let rejectedForNonMember = false;
    try {
      await alice.frame.evaluate(
        (args) => AtlasWallet.sendUserMail(args.viaDomain, { publicKey: args.pk, domain: args.homeDomain }, 'Should fail', 'nobody home', null),
        { viaDomain: DOMAIN_A, pk: pkAlice, homeDomain: DOMAIN_B } // Alice's own key, but she's not a member of Domain B
      );
    } catch (err) {
      rejectedForNonMember = /does not hold a valid Global Mail membership/.test(err.message);
      if (!rejectedForNonMember) throw new Error('Expected a "recipient does not hold a valid membership" rejection, got: ' + err.message);
    }
    if (!rejectedForNonMember) throw new Error('Expected sending to a non-member at the named home domain to fail, but it succeeded');
    console.log('PASS: relaying to someone who isn\'t actually a member at the named home domain is rejected, not silently delivered');

    console.log('STEP 5: Domain B\'s own operator federation-blocklist rejects a relay attempt from a domain it names');
    fs.writeFileSync(BLOCKLIST_B_PATH, JSON.stringify({ blocked: [DOMAIN_A] }, null, 2));
    let rejectedByBlocklist = false;
    try {
      await alice.frame.evaluate(
        (args) => AtlasWallet.sendUserMail(args.viaDomain, { publicKey: args.pk, domain: args.homeDomain }, 'Should be blocked', 'blocked domain test', null),
        { viaDomain: DOMAIN_A, pk: pkBob, homeDomain: DOMAIN_B }
      );
    } catch (err) {
      rejectedByBlocklist = /not accepting relayed mail from/.test(err.message);
      if (!rejectedByBlocklist) throw new Error('Expected a blocklist rejection, got: ' + err.message);
    }
    if (!rejectedByBlocklist) throw new Error('Expected Domain B\'s federation blocklist to reject a relay from ' + DOMAIN_A + ', but it went through');
    console.log('PASS: Domain B\'s operator blocklist rejected the relay attempt from ' + DOMAIN_A + ' with a clear error');

    fs.unlinkSync(BLOCKLIST_B_PATH);
    console.log('STEP 6: removing the block restores normal relaying (the block is a live check, not a one-time cache)');
    const afterUnblockCount = readServerMailStoreB().length;
    const afterUnblockResult = await alice.frame.evaluate(
      (args) => AtlasWallet.sendUserMail(args.viaDomain, { publicKey: args.pk, domain: args.homeDomain }, 'Unblocked now', 'should go through again', null),
      { viaDomain: DOMAIN_A, pk: pkBob, homeDomain: DOMAIN_B }
    );
    if (!afterUnblockResult || !afterUnblockResult.id) throw new Error('Expected relaying to succeed again after removing the block');
    const afterUnblockRaw = await newestServerMessageB(afterUnblockCount);
    if (afterUnblockRaw.subject !== 'Unblocked now') throw new Error('Expected the post-unblock message to actually land: ' + JSON.stringify(afterUnblockRaw));
    console.log('PASS: relaying works again immediately after the operator removes the block — no restart or cache to clear');

    console.log('\nALL FEDERATION RELAY CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    if (fs.existsSync(BLOCKLIST_B_PATH)) fs.unlinkSync(BLOCKLIST_B_PATH);
    await contextA.close();
    await contextB.close();
  }
})();
