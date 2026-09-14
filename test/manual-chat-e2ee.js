// Manual end-to-end check for task #158: per-pair chat message encryption
// (ECDH key agreement over each identity's own P-256 keypair, static/
// non-ratcheted, per Bruno's own "simple static key first" scope choice —
// see the design section comment directly above wrapChatMessageForWire in
// wallet.js for the full write-up of the wire shape, the bootstrap gap,
// and the accepted limitations).
//
// manual-messaging-window.js already thoroughly covers the Messaging
// window's UI mechanics (opening, Contacts Chat/Call buttons, thread
// list, deletion, drag/resize/opacity) and the pre-existing AT-REST
// encryption of the LOCAL copy of a chat message. This test does NOT
// repeat any of that. Instead it is scoped entirely to the NEW wire-level
// claim task #158 actually makes: that the relaying domain itself can no
// longer read chat content once a pair has exchanged keys, and that a
// forged/tampered key announcement is never trusted. To prove that, this
// test reads the relaying domain's own on-disk mail store file directly
// (issuer-server/domain-b-state/atlas-mail-store.json) rather than only
// inspecting what each wallet shows itself — the raw server-side copy is
// the only thing that can actually prove the relay can't read it.
//
// Requires domain A's issuer-server on 8001 AND domain B running as a real
// issuer-server instance on 8002 with ATLAS_STATE_DIR=issuer-server/domain-b-state
// (same as manual-messaging-window.js / manual-postoffice-mail.js) — this
// test does not start either itself.
//
// Checks:
//   1. Three visitors (Alice, Bob, and Mallory — an attacker who is a
//      legitimate Post Office member but has no relationship to Alice or
//      Bob yet) each create a real identity and join Domain B's Post
//      Office.
//   2. Alice's very FIRST chat message to Bob — a brand-new conversation,
//      neither side knows the other's e2ee key yet — reaches the relay
//      as a signed-but-UNENCRYPTED key announcement (the disclosed
//      bootstrap gap: this one message's content IS readable by the
//      relay, by design, since encrypting to someone requires already
//      knowing their key).
//   3. Bob's mail check verifies Alice's signed announcement and caches
//      her e2ee key — and critically, Bob's REPLY (the first message in
//      HIS direction) is already fully encrypted on the wire, because he
//      learned Alice's key from her own bootstrap message. The relay's
//      own on-disk copy of Bob's reply is inspected directly and proven
//      to contain no trace of the plaintext.
//   4. A second message from Alice (now that she's learned Bob's key too)
//      is also fully encrypted on the wire, and decrypts correctly on
//      Bob's side.
//   5. Mallory, a real Post Office member with no built-in relationship to
//      Alice, sends Alice two FORGED key announcements — one falsely
//      claiming to carry Alice's own... no, claiming to be signed by a
//      key that isn't the outer sender's (impersonation of a third
//      identity's binding), and one correctly bound to Mallory's own real
//      identity but with a garbage signature (a tampered/invalid
//      announcement) — followed by one GENUINE, validly self-signed
//      announcement. All three are delivered in one mail check. Only the
//      genuine one is ever trusted and cached as "Mallory's real e2ee
//      key" — proving the signed-announcement mechanism actually closes
//      the "relay/attacker substitutes a key" MITM gap this feature was
//      built to close, regardless of delivery order.
//   6. A pre-#158-style message — a plain, non-JSON string body under the
//      same chat subject marker — still comes through as ordinary
//      readable text (full backward compatibility, no migration needed).
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const TO_DOMAIN = 'localhost:8002';
// Deliberately NOT hardcoded: wallet.js's own CHAT_SUBJECT_MARKER constant
// turns out to carry a literal U+0000 leading byte rather than the visually
// identical space it looks like in an editor (harmless in the app itself —
// every comparison is against that same in-module constant — but a hand-typed
// copy of it in this file would silently mismatch). This test instead reads
// the real value straight off Alice's own first real chat message once it's
// on the wire (STEP 1 below) and reuses that captured value for every
// forged/back-compat send later in this file.
let CHAT_SUBJECT_MARKER = null;
const MAIL_STORE_PATH = path.resolve(__dirname, '..', 'issuer-server', 'domain-b-state', 'atlas-mail-store.json');

function readServerMailStore() {
  return JSON.parse(fs.readFileSync(MAIL_STORE_PATH, 'utf8')).messages;
}

// Every send in this test goes through Domain B, one at a time, so the
// single new entry appended between a "before" and "after" read of the
// relay's own store is unambiguous — no need to match by recipient (the
// relay's stored message doesn't even carry a `to` field, only the
// recipient's credentialId, which this test never needs to resolve).
async function newestServerMessage(beforeCount) {
  const messages = readServerMailStore();
  if (messages.length !== beforeCount + 1) {
    throw new Error(`Expected exactly 1 new message on the relay's own store, went from ${beforeCount} to ${messages.length}`);
  }
  return messages[messages.length - 1];
}

function sameJwk(a, b) {
  return !!a && !!b && a.kty === b.kty && a.crv === b.crv && a.x === b.x && a.y === b.y;
}

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

// Same flow manual-postoffice-mail.js/manual-messaging-window.js already established.
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
  console.log('PASS: ' + label + ' claimed a Global Mail Membership Card at Domain B');

  portals = await projectPortals(frame);
  const backToDomainA = portals.find((p) => p.kind === 'domain');
  await frame.locator('#scene').click({ position: { x: backToDomainA.sx, y: backToDomainA.sy } });
  await frame.waitForFunction(() => document.getElementById('status').textContent.includes('8001'), { timeout: 10000 });
}

async function ownE2eeKey(frame) {
  return frame.evaluate(async () => {
    const identity = await AtlasWallet.getIdentity();
    const pair = await AtlasWallet.getChatE2eeKeyPair(identity);
    return pair.publicKeyJwk;
  });
}

async function peerE2eeKey(frame, peerPublicKey) {
  return frame.evaluate(async (peerPk) => {
    const identity = await AtlasWallet.getIdentity();
    return AtlasWallet.getE2eePeerPublicKey(identity, peerPk);
  }, peerPublicKey);
}

async function threadMessages(frame, peerPublicKey) {
  return frame.evaluate(async (peerPk) => {
    const identity = await AtlasWallet.getIdentity();
    return AtlasWallet.getChatThreadMessages(identity.publicKey, peerPk);
  }, peerPublicKey);
}

(async () => {
  const dirA = path.resolve(__dirname, '.chrome-profile-e2ee-a');
  const dirB = path.resolve(__dirname, '.chrome-profile-e2ee-b');
  const dirM = path.resolve(__dirname, '.chrome-profile-e2ee-mallory');
  const launchOpts = { headless: false, executablePath: '/opt/pw-browsers/chromium', args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox'] };

  const contextA = await chromium.launchPersistentContext(dirA, launchOpts);
  const contextB = await chromium.launchPersistentContext(dirB, launchOpts);
  const contextM = await chromium.launchPersistentContext(dirM, launchOpts);

  try {
    const a = await openOverlay(contextA, 'Alice');
    const b = await openOverlay(contextB, 'Bob');
    const m = await openOverlay(contextM, 'Mallory');

    console.log('STEP 0: three visitors create real identities and all join Domain B\'s Post Office');
    const pkA = await createIdentity(a.frame, 'e2ee-test-password-alice');
    const pkB = await createIdentity(b.frame, 'e2ee-test-password-bob');
    const pkM = await createIdentity(m.frame, 'e2ee-test-password-mallory');
    await claimPostOfficeMembership(a.frame, 'Alice');
    await claimPostOfficeMembership(b.frame, 'Bob');
    await claimPostOfficeMembership(m.frame, 'Mallory');
    console.log('PASS: all three hold a Global Mail Membership at localhost:8002 ->', pkA.slice(0, 16) + '...', pkB.slice(0, 16) + '...', pkM.slice(0, 16) + '...');

    console.log('STEP 1: Alice\'s first-ever message to Bob reaches the relay as a signed-but-UNENCRYPTED key announcement (disclosed bootstrap gap)');
    let beforeCount = readServerMailStore().length;
    await a.frame.evaluate((args) => AtlasWallet.sendChatMessage(args.toDomain, args.pkB, args.body), { toDomain: TO_DOMAIN, pkB, body: 'Hey Bob, first message ever!' });
    let raw = await newestServerMessage(beforeCount);
    if (!raw.subject) throw new Error('Expected a chat subject marker, got: ' + JSON.stringify(raw.subject));
    CHAT_SUBJECT_MARKER = raw.subject; // captured from the wire — see the top-of-file comment on why this isn't hardcoded
    let parsed = JSON.parse(raw.body); // must parse as JSON — a plain string here would mean wrapChatMessageForWire never ran
    if (parsed.v !== 1) throw new Error('Expected wire envelope v:1, got: ' + JSON.stringify(parsed));
    if (parsed.encrypted !== false) throw new Error('Expected the very first message in a brand-new conversation to be unencrypted (bootstrap), got encrypted: ' + parsed.encrypted);
    if (parsed.plaintext !== 'Hey Bob, first message ever!') throw new Error('Expected the bootstrap plaintext to be readable on the relay (disclosed limitation), got: ' + JSON.stringify(parsed.plaintext));
    if (parsed.key.envelope.publicKey !== pkA) throw new Error('Expected the key announcement to be bound to Alice\'s own public key');
    if (!parsed.key.announcement.chatE2eePublicKeyJwk || parsed.key.announcement.chatE2eePublicKeyJwk.kty !== 'EC') throw new Error('Expected a real EC JWK in the key announcement, got: ' + JSON.stringify(parsed.key.announcement));
    console.log('PASS: relay\'s own on-disk copy shows a signed, but plainly readable, first-contact announcement — exactly the disclosed bootstrap gap, nothing more');

    console.log('STEP 2: Bob\'s mail check verifies + caches Alice\'s key, and decrypts the (unencrypted) bootstrap message correctly');
    await b.frame.evaluate(() => AtlasWallet.checkAllMail());
    const bobCachedAliceKey = await peerE2eeKey(b.frame, pkA);
    const aliceRealKey = parsed.key.announcement.chatE2eePublicKeyJwk;
    if (!sameJwk(bobCachedAliceKey, aliceRealKey)) throw new Error('Expected Bob to cache Alice\'s real e2ee key from her verified announcement, got: ' + JSON.stringify(bobCachedAliceKey));
    const bobThreadWithAlice = await threadMessages(b.frame, pkA);
    if (!bobThreadWithAlice.length || !bobThreadWithAlice[0].body.includes('Hey Bob')) throw new Error('Expected Bob\'s thread to show the decrypted (here: plain) bootstrap message: ' + JSON.stringify(bobThreadWithAlice));
    console.log('PASS: Bob verified and cached Alice\'s key, and sees the correct message text');

    console.log('STEP 3: Bob\'s reply — the first message in HIS direction — is already fully encrypted on the wire, since he learned Alice\'s key from her own bootstrap');
    beforeCount = readServerMailStore().length;
    await b.frame.evaluate((args) => AtlasWallet.sendChatMessage(args.toDomain, args.pkA, args.body), { toDomain: TO_DOMAIN, pkA, body: 'Hi Alice, nice to e2ee you!' });
    raw = await newestServerMessage(beforeCount);
    parsed = JSON.parse(raw.body);
    if (parsed.encrypted !== true) throw new Error('Expected Bob\'s reply to be encrypted (he already knows Alice\'s key), got encrypted: ' + parsed.encrypted);
    if (typeof parsed.iv !== 'string' || typeof parsed.ciphertext !== 'string') throw new Error('Expected iv/ciphertext strings, got: ' + JSON.stringify(parsed));
    const rawJsonText = JSON.stringify(raw);
    if (rawJsonText.includes('Alice') || rawJsonText.includes('nice to e2ee you')) throw new Error('REGRESSION: the relay\'s own stored copy contains plaintext from a message that should be fully encrypted: ' + rawJsonText);
    console.log('PASS: the relay\'s own on-disk copy of Bob\'s reply is opaque ciphertext — no plaintext trace anywhere in it');

    console.log('STEP 4: Alice\'s mail check decrypts Bob\'s reply correctly, and caches Bob\'s key in turn; her SECOND message is then encrypted too');
    await a.frame.evaluate(() => AtlasWallet.checkAllMail());
    const aliceThreadWithBob = await threadMessages(a.frame, pkB);
    const bobReply = aliceThreadWithBob.find((e) => e.direction === 'in');
    if (!bobReply || !bobReply.body.includes('nice to e2ee you')) throw new Error('Expected Alice to see Bob\'s decrypted reply, got: ' + JSON.stringify(aliceThreadWithBob));
    const aliceCachedBobKey = await peerE2eeKey(a.frame, pkB);
    const bobRealKey = await ownE2eeKey(b.frame);
    if (!sameJwk(aliceCachedBobKey, bobRealKey)) throw new Error('Expected Alice to cache Bob\'s real e2ee key');

    beforeCount = readServerMailStore().length;
    await a.frame.evaluate((args) => AtlasWallet.sendChatMessage(args.toDomain, args.pkB, args.body), { toDomain: TO_DOMAIN, pkB, body: 'Second message, now truly private.' });
    raw = await newestServerMessage(beforeCount);
    parsed = JSON.parse(raw.body);
    if (parsed.encrypted !== true) throw new Error('Expected Alice\'s second message to be encrypted now that she knows Bob\'s key, got encrypted: ' + parsed.encrypted);
    if (JSON.stringify(raw).includes('truly private')) throw new Error('REGRESSION: plaintext leaked into the relay\'s own stored copy of an encrypted message');
    await b.frame.evaluate(() => AtlasWallet.checkAllMail());
    const bobThreadWithAlice2 = await threadMessages(b.frame, pkA);
    if (!bobThreadWithAlice2.some((e) => e.body.includes('truly private'))) throw new Error('Expected Bob to correctly decrypt Alice\'s second message');
    console.log('PASS: both directions are now fully end-to-end encrypted on the wire, and both sides decrypt correctly');

    console.log('STEP 5: Mallory (a real Post Office member, no relationship to Alice yet) tries two FORGED key announcements, then one genuine one — only the genuine one is ever trusted');
    const fakeJwk = { kty: 'EC', crv: 'P-256', x: 'ZmFrZS14LXZhbHVl', y: 'ZmFrZS15LXZhbHVl', ext: true };
    // Forgery #1 — impersonation: claims the announcement was signed by
    // ALICE's own key (envelope.publicKey = pkA) even though this message
    // is really coming from Mallory. verifyChatE2eeKeyAnnouncement's
    // outer-binding check (envelope.publicKey must equal the RELAY-vouched
    // message.from.publicKey, which the server sets from Mallory's own
    // real, unforgeable membership credential) catches this before even
    // looking at the (also garbage) signature.
    const forgedImpersonation = JSON.stringify({
      v: 1,
      key: { announcement: { chatE2eePublicKeyJwk: fakeJwk }, envelope: { signerRole: 'raw-ecdsa', publicKey: pkA, signature: 'not-a-real-signature' } },
      encrypted: false,
      plaintext: "Trust this key, it's really Alice's (it is not)"
    });
    // Forgery #2 — correctly bound to Mallory's own real identity
    // (envelope.publicKey = pkM, matching who actually sent it) but with
    // an invalid/garbage signature — simulates a relay or attacker
    // tampering with an otherwise-legitimate announcement in transit.
    const forgedTampered = JSON.stringify({
      v: 1,
      key: { announcement: { chatE2eePublicKeyJwk: fakeJwk }, envelope: { signerRole: 'raw-ecdsa', publicKey: pkM, signature: 'also-not-a-real-signature' } },
      encrypted: false,
      plaintext: 'A tampered announcement, correctly bound but not really signed'
    });
    await m.frame.evaluate((args) => AtlasWallet.sendUserMail(args.toDomain, args.pkA, args.subject, args.body, null), { toDomain: TO_DOMAIN, pkA, subject: CHAT_SUBJECT_MARKER, body: forgedImpersonation });
    await m.frame.evaluate((args) => AtlasWallet.sendUserMail(args.toDomain, args.pkA, args.subject, args.body, null), { toDomain: TO_DOMAIN, pkA, subject: CHAT_SUBJECT_MARKER, body: forgedTampered });
    // The genuine one, sent normally — a real, validly self-signed
    // announcement of Mallory's OWN real e2ee key.
    await m.frame.evaluate((args) => AtlasWallet.sendChatMessage(args.toDomain, args.pkA, args.body), { toDomain: TO_DOMAIN, pkA, body: 'Hi Alice, genuinely from Mallory.' });

    await a.frame.evaluate(() => AtlasWallet.checkAllMail());
    const aliceCachedMalloryKey = await peerE2eeKey(a.frame, pkM);
    const malloryRealKey = await ownE2eeKey(m.frame);
    if (!aliceCachedMalloryKey) throw new Error('Expected Alice to have cached SOME key for Mallory (the genuine announcement) — got none at all');
    if (!sameJwk(aliceCachedMalloryKey, malloryRealKey)) throw new Error('REGRESSION: Alice cached a key for Mallory that is not Mallory\'s real key — a forged/tampered announcement was trusted');
    if (sameJwk(aliceCachedMalloryKey, fakeJwk)) throw new Error('REGRESSION: Alice cached the FAKE placeholder key from a forged announcement');
    const aliceThreadWithMallory = await threadMessages(a.frame, pkM);
    const genuineFromMallory = aliceThreadWithMallory.find((e) => e.body.includes('genuinely from Mallory'));
    if (!genuineFromMallory) throw new Error('Expected the genuine message from Mallory to show up correctly: ' + JSON.stringify(aliceThreadWithMallory));
    console.log('PASS: both forged announcements were rejected and never cached (regardless of delivery order) — only Mallory\'s real, validly self-signed key was ever trusted');
    console.log('       (the two forged messages\' own PLAINTEXT still displays, same as any bootstrap message — confidentiality of a first-contact message was never this feature\'s claim; trustworthiness of the KEY it carries is, and that held)');

    console.log('STEP 6: a pre-#158-style plain-string chat body (no JSON envelope at all) still comes through as ordinary readable text — full backward compatibility');
    await b.frame.evaluate((args) => AtlasWallet.sendUserMail(args.toDomain, args.pkA, args.subject, args.body, null), { toDomain: TO_DOMAIN, pkA, subject: CHAT_SUBJECT_MARKER, body: 'Old-style plain chat message from before this feature shipped.' });
    await a.frame.evaluate(() => AtlasWallet.checkAllMail());
    const aliceThreadWithBobFinal = await threadMessages(a.frame, pkB);
    if (!aliceThreadWithBobFinal.some((e) => e.body === 'Old-style plain chat message from before this feature shipped.')) {
      throw new Error('Expected a pre-#158 plain-string body to pass through unchanged: ' + JSON.stringify(aliceThreadWithBobFinal));
    }
    console.log('PASS: a plain-string body (unwrapChatMessageFromWire\'s JSON.parse-catch fallback) still works, no migration needed');

    console.log('\nALL CHAT E2EE CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await contextA.close();
    await contextB.close();
    await contextM.close();
  }
})();
