// Manual end-to-end check for extending Chat's existing per-identity ECDH
// E2EE (see manual-chat-e2ee.js) to ordinary Mail — both the kinds SPEC.md
// §11 covers, which need genuinely different mechanisms:
//
//   PART 1 — domain-to-subscriber mail (§11.1, single domain, one visitor).
//   The domain is always the one composing and sending first; there's no
//   bootstrap message to discover a peer key from the way Chat/Mail
//   Compose have. Instead the wallet registers its OWN encryption public
//   key with the domain ahead of time, scoped to one held credential and
//   proven via that credential plus a signed possession proof
//   (/atlas/mail/register-key). The domain then ECIES-encrypts to it: a
//   fresh ephemeral ECDH keypair per message, no persistent identity of
//   its own needed. This test reads the domain's own on-disk mail store
//   directly (issuer-server/atlas-mail-store.json) to prove the server's
//   own copy is unreadable once a key is on file, exactly the same
//   "inspect the relay's own state, not just what the wallet shows"
//   discipline manual-chat-e2ee.js already established.
//
//   PART 2 — Post Office user-to-user mail (§11.3, "Mail Compose"), two
//   visitors relayed through Domain B. This reuses the SAME per-identity
//   ECDH keypair and signed-key-announcement bootstrap Chat already has
//   (deriveEcdhSharedKey with a distinct 'atlas.mail.e2ee.v1' label), just
//   generalized beyond the chat-subject-marker gate, and bundling
//   {subject, body} into one encrypted blob since a real subject line can
//   be just as sensitive as the body. manual-chat-e2ee.js's Alice/Bob
//   bootstrap shape is mirrored here almost exactly — the only material
//   difference is a real subject line and the placeholder-subject
//   behavior once a peer key is known.
//
// Requires domain A's issuer-server on 8001 AND domain B running as a real
// issuer-server instance on 8002 with ATLAS_STATE_DIR=issuer-server/domain-b-state
// (same as manual-postoffice-mail.js / manual-chat-e2ee.js) — this test
// does not start either itself.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const MAIL_STORE_A = path.resolve(__dirname, '..', 'issuer-server', 'atlas-mail-store.json');
const MAIL_KEYS_A = path.resolve(__dirname, '..', 'issuer-server', 'atlas-mail-encryption-keys.json');
const MAIL_STORE_B = path.resolve(__dirname, '..', 'issuer-server', 'domain-b-state', 'atlas-mail-store.json');
const ADMIN_KEYS_FILE_A = path.resolve(__dirname, '..', 'issuer-server', 'atlas-admin-keys-store.json');
const MAIL_ENCRYPTED_SUBJECT_PLACEHOLDER = 'Encrypted message';

function b64url(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Same canonicalize() shape as extension/wallet.js and issuer-server/
// server.js's own crypto helpers — sorted-key JSON, no whitespace.
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

// Mirrors extension/wallet.js's signWithSelf() — a raw-ecdsa self-signed
// envelope, the same one verifyEnvelope() on the server checks.
async function signWithSelf(kp, publicKey, payload) {
  const data = new TextEncoder().encode(canonicalize(payload));
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, data));
  return { signerRole: 'raw-ecdsa', publicKey, signature: b64url(sig) };
}

// /atlas/mail/send now requires a registered domain admin's signature
// (requireAdmin(), issuer-server/server.js) — seeds one directly into the
// admin roster file, the same "plain operator-edited JSON" bootstrap a
// real domain operator would do by hand.
function seedAdmin(publicKey) {
  fs.writeFileSync(ADMIN_KEYS_FILE_A, JSON.stringify({ keys: [{ publicKey, addedAt: new Date().toISOString() }] }, null, 2));
}

async function sendAsAdmin(port, admin, sendPayload) {
  const proof = await signWithSelf(admin.kp, admin.publicKey, sendPayload);
  return postJson(port, '/atlas/mail/send', { payload: sendPayload, proof });
}

function postJson(port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: 'localhost', port, path: urlPath, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let chunks = '';
        res.on('data', (c) => { chunks += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(chunks)); } catch (err) { reject(err); }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function readMailStore(storePath) {
  return JSON.parse(fs.readFileSync(storePath, 'utf8')).messages;
}

function readMailKeys(keysPath) {
  if (!fs.existsSync(keysPath)) return {};
  return JSON.parse(fs.readFileSync(keysPath, 'utf8')).keys || {};
}

// Same "before/after count" pattern manual-chat-e2ee.js uses to isolate the
// one new message a send just produced, on a store that keeps growing
// across repeated runs and other tests sharing the same domain.
function newestMessage(storePath, beforeCount) {
  const messages = readMailStore(storePath);
  if (messages.length !== beforeCount + 1) {
    throw new Error(`Expected exactly 1 new message on ${storePath}, went from ${beforeCount} to ${messages.length}`);
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

// Same flow manual-postoffice-mail.js / manual-chat-e2ee.js already established.
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

async function mailEntries(frame) {
  return frame.evaluate(async () => {
    const identity = await AtlasWallet.getIdentity();
    return AtlasWallet.getMail(identity.publicKey);
  });
}

(async () => {
  const dirSub = path.resolve(__dirname, '.chrome-profile-mail-enc-subscriber');
  const dirAlice = path.resolve(__dirname, '.chrome-profile-mail-enc-alice');
  const dirBob = path.resolve(__dirname, '.chrome-profile-mail-enc-bob');
  const launchOpts = { headless: false, executablePath: '/opt/pw-browsers/chromium', args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox'] };

  const contextSub = await chromium.launchPersistentContext(dirSub, launchOpts);
  const contextAlice = await chromium.launchPersistentContext(dirAlice, launchOpts);
  const contextBob = await chromium.launchPersistentContext(dirBob, launchOpts);

  try {
    // ---------------- PART 1: domain-to-subscriber (§11.1) ----------------
    const sub = await openOverlay(contextSub, 'Subscriber');

    console.log('PART 1 STEP 0: subscriber creates an identity and requests a Domain Atlas Membership Card (atlas.membership)');
    await createIdentity(sub.frame, 'mail-enc-test-password');
    const membership = await sub.frame.evaluate(async () => AtlasWallet.mintAsset('self', 'localhost:8001', 'atlas.membership'));
    if (membership.verdict && membership.verdict.valid === false) throw new Error('Membership card did not verify: ' + membership.verdict.reason);
    const credentialId = membership.credential.id;
    console.log('PASS: membership card issued ->', credentialId);

    console.log('PART 1 STEP 1: a message sent BEFORE any mail check (so no encryption key is registered yet) is stored in the clear — the disclosed fallback, unchanged from before this feature');
    const adminA = await genIdentity();
    seedAdmin(adminA.publicKey);
    let beforeCountA = readMailStore(MAIL_STORE_A).length;
    const preRegSent = await sendAsAdmin(8001, adminA, {
      credentialId,
      subject: 'Statement ready',
      body: 'Your monthly statement is ready to view.'
    });
    if (!preRegSent.id) throw new Error('Expected /atlas/mail/send to return a signed message, got: ' + JSON.stringify(preRegSent));
    let rawPreReg = newestMessage(MAIL_STORE_A, beforeCountA);
    if (rawPreReg.subject !== 'Statement ready' || rawPreReg.body !== 'Your monthly statement is ready to view.') {
      throw new Error('Expected the pre-registration message to be stored in plain text, got: ' + JSON.stringify(rawPreReg));
    }
    console.log('PASS: no key on file yet, so this message is plainly readable on the relay — exactly as before this feature');

    console.log('PART 1 STEP 2: checking mail registers this identity\'s encryption key for the held credential, and correctly decrypts (trivially, since it was plain) both the pre-registration message and the auto-welcome message');
    const newCount1 = await sub.frame.evaluate(() => AtlasWallet.checkAllMail());
    if (newCount1 < 2) throw new Error('Expected at least 2 new messages (auto-welcome + pre-registration statement), got: ' + newCount1);
    const entriesAfterCheck1 = await mailEntries(sub.frame);
    const statementEntry = entriesAfterCheck1.find((e) => e.message.subject === 'Statement ready');
    if (!statementEntry || statementEntry.message.body !== 'Your monthly statement is ready to view.') {
      throw new Error('Expected the pre-registration message to display correctly: ' + JSON.stringify(entriesAfterCheck1));
    }
    const registeredKeys = readMailKeys(MAIL_KEYS_A);
    const registeredKey = registeredKeys[credentialId];
    if (!registeredKey || registeredKey.kty !== 'EC') throw new Error('Expected the domain to have this credential\'s encryption key on file, got: ' + JSON.stringify(registeredKey));
    const subscriberOwnKey = await ownE2eeKey(sub.frame);
    if (!sameJwk(registeredKey, subscriberOwnKey)) throw new Error('Expected the registered key to be this identity\'s own chat/mail e2ee key (same keypair reused, not a second one)');
    console.log('PASS: encryption key registered on the domain\'s own file and matches the subscriber\'s real key');

    console.log('PART 1 STEP 3: a message sent NOW (key is on file) is ECIES-encrypted — the domain\'s own on-disk copy is opaque');
    beforeCountA = readMailStore(MAIL_STORE_A).length;
    const REAL_SUBJECT = 'Wire transfer confirmation';
    const REAL_BODY = 'Your transfer of $500.00 has been received and posted to your account.';
    const encSent = await sendAsAdmin(8001, adminA, { credentialId, subject: REAL_SUBJECT, body: REAL_BODY });
    if (!encSent.id) throw new Error('Expected /atlas/mail/send to return a signed message, got: ' + JSON.stringify(encSent));
    const rawEnc = newestMessage(MAIL_STORE_A, beforeCountA);
    if (rawEnc.subject !== MAIL_ENCRYPTED_SUBJECT_PLACEHOLDER) throw new Error('Expected the outer wire subject to be the fixed placeholder, got: ' + JSON.stringify(rawEnc.subject));
    let envelope;
    try { envelope = JSON.parse(rawEnc.body); } catch (err) { throw new Error('Expected the wire body to be a JSON ECIES envelope, got: ' + rawEnc.body); }
    if (envelope.v !== 1 || !envelope.ephemeralPublicKeyJwk || !envelope.iv || !envelope.ciphertext) {
      throw new Error('Expected {v:1, ephemeralPublicKeyJwk, iv, ciphertext}, got: ' + JSON.stringify(envelope));
    }
    const rawEncText = JSON.stringify(rawEnc);
    if (rawEncText.includes(REAL_SUBJECT) || rawEncText.includes('500.00') || rawEncText.includes('received and posted')) {
      throw new Error('REGRESSION: the relay\'s own stored copy contains plaintext from a message that should be fully encrypted: ' + rawEncText);
    }
    console.log('PASS: the domain\'s own atlas-mail-store.json shows only a placeholder subject and opaque ciphertext — no plaintext trace anywhere');

    console.log('PART 1 STEP 4: the subscriber\'s own mail check decrypts it correctly');
    const newCount2 = await sub.frame.evaluate(() => AtlasWallet.checkAllMail());
    if (newCount2 < 1) throw new Error('Expected at least 1 new message, got: ' + newCount2);
    const entriesAfterCheck2 = await mailEntries(sub.frame);
    const decrypted = entriesAfterCheck2.find((e) => e.message.subject === REAL_SUBJECT);
    if (!decrypted || decrypted.message.body !== REAL_BODY) {
      throw new Error('Expected the encrypted message to decrypt to its real subject/body: ' + JSON.stringify(entriesAfterCheck2));
    }
    console.log('PASS: domain-to-subscriber mail round-trips correctly — unreadable on the wire/server, correct in the wallet');

    // ---------------- PART 2: Post Office user-to-user mail (§11.3) ----------------
    const alice = await openOverlay(contextAlice, 'Alice');
    const bob = await openOverlay(contextBob, 'Bob');
    const TO_DOMAIN = 'localhost:8002';

    console.log('PART 2 STEP 0: Alice and Bob create identities and both join Domain B\'s Post Office');
    const pkAlice = await createIdentity(alice.frame, 'mail-enc-test-password-alice');
    const pkBob = await createIdentity(bob.frame, 'mail-enc-test-password-bob');
    await claimPostOfficeMembership(alice.frame, 'Alice');
    await claimPostOfficeMembership(bob.frame, 'Bob');
    console.log('PASS: both hold a Global Mail Membership at localhost:8002');

    console.log('PART 2 STEP 1: Alice\'s first-ever Mail Compose message to Bob, with a real subject line, reaches the relay as a signed-but-UNENCRYPTED bundle (disclosed bootstrap gap — same as Chat\'s)');
    let beforeCountB = readMailStore(MAIL_STORE_B).length;
    await alice.frame.evaluate((args) => AtlasWallet.sendUserMail(args.toDomain, args.pkBob, args.subject, args.body, null), {
      toDomain: TO_DOMAIN, pkBob, subject: 'Wire transfer confirmation', body: 'Hey Bob, sending the funds now — confirming here first.'
    });
    let raw = newestMessage(MAIL_STORE_B, beforeCountB);
    if (raw.subject !== 'Wire transfer confirmation') throw new Error('Expected the bootstrap message\'s real subject to travel in the clear (design tradeoff), got: ' + JSON.stringify(raw.subject));
    let parsed = JSON.parse(raw.body);
    if (parsed.v !== 1) throw new Error('Expected wire envelope v:1, got: ' + JSON.stringify(parsed));
    if (parsed.encrypted !== false) throw new Error('Expected the very first Mail Compose message in a brand-new conversation to be unencrypted (bootstrap), got encrypted: ' + parsed.encrypted);
    const bootstrapPlain = JSON.parse(parsed.plaintext);
    if (bootstrapPlain.subject !== 'Wire transfer confirmation' || bootstrapPlain.body !== 'Hey Bob, sending the funds now — confirming here first.') {
      throw new Error('Expected the bootstrap plaintext to carry the real {subject, body}, got: ' + JSON.stringify(bootstrapPlain));
    }
    if (parsed.key.envelope.publicKey !== pkAlice) throw new Error('Expected the key announcement to be bound to Alice\'s own public key');
    console.log('PASS: relay\'s own on-disk copy shows a signed, but plainly readable, first-contact bundle — subject and body both, exactly the disclosed bootstrap gap');

    console.log('PART 2 STEP 2: Bob\'s mail check verifies + caches Alice\'s key, and shows the correct subject/body');
    await bob.frame.evaluate(() => AtlasWallet.checkAllMail());
    const bobCachedAliceKey = await peerE2eeKey(bob.frame, pkAlice);
    const aliceRealKey = parsed.key.announcement.chatE2eePublicKeyJwk;
    if (!sameJwk(bobCachedAliceKey, aliceRealKey)) throw new Error('Expected Bob to cache Alice\'s real e2ee key from her verified announcement');
    const bobEntries1 = await mailEntries(bob.frame);
    const bobSeesFromAlice = bobEntries1.find((e) => e.message.subject === 'Wire transfer confirmation');
    if (!bobSeesFromAlice || !bobSeesFromAlice.message.body.includes('sending the funds now')) {
      throw new Error('Expected Bob to see the correctly resolved subject/body: ' + JSON.stringify(bobEntries1));
    }
    console.log('PASS: Bob verified and cached Alice\'s key, and sees the correct subject/body');

    console.log('PART 2 STEP 3: Bob\'s reply — the first message in HIS direction — is already fully encrypted (subject AND body), since he learned Alice\'s key from her own bootstrap');
    beforeCountB = readMailStore(MAIL_STORE_B).length;
    await bob.frame.evaluate((args) => AtlasWallet.sendUserMail(args.toDomain, args.pkAlice, args.subject, args.body, null), {
      toDomain: TO_DOMAIN, pkAlice, subject: 'Re: Wire transfer confirmation', body: 'Thanks, all set on my end.'
    });
    raw = newestMessage(MAIL_STORE_B, beforeCountB);
    if (raw.subject !== MAIL_ENCRYPTED_SUBJECT_PLACEHOLDER) throw new Error('Expected Bob\'s reply subject to be the fixed placeholder, got: ' + JSON.stringify(raw.subject));
    parsed = JSON.parse(raw.body);
    if (parsed.encrypted !== true) throw new Error('Expected Bob\'s reply to be encrypted (he already knows Alice\'s key), got encrypted: ' + parsed.encrypted);
    if (typeof parsed.iv !== 'string' || typeof parsed.ciphertext !== 'string') throw new Error('Expected iv/ciphertext strings, got: ' + JSON.stringify(parsed));
    const rawJsonText = JSON.stringify(raw);
    if (rawJsonText.includes('Re: Wire') || rawJsonText.includes('all set on my end')) {
      throw new Error('REGRESSION: the relay\'s own stored copy contains plaintext from a message that should be fully encrypted: ' + rawJsonText);
    }
    console.log('PASS: the relay\'s own on-disk copy of Bob\'s reply is opaque — placeholder subject, ciphertext body, no plaintext trace anywhere');

    console.log('PART 2 STEP 4: Alice\'s mail check decrypts Bob\'s reply, caches Bob\'s key in turn, and her SECOND message is then fully encrypted too');
    await alice.frame.evaluate(() => AtlasWallet.checkAllMail());
    const aliceEntries1 = await mailEntries(alice.frame);
    const aliceSeesBobReply = aliceEntries1.find((e) => e.message.subject === 'Re: Wire transfer confirmation');
    if (!aliceSeesBobReply || !aliceSeesBobReply.message.body.includes('all set on my end')) {
      throw new Error('Expected Alice to see Bob\'s decrypted reply: ' + JSON.stringify(aliceEntries1));
    }
    const aliceCachedBobKey = await peerE2eeKey(alice.frame, pkBob);
    const bobRealKey = await ownE2eeKey(bob.frame);
    if (!sameJwk(aliceCachedBobKey, bobRealKey)) throw new Error('Expected Alice to cache Bob\'s real e2ee key');

    beforeCountB = readMailStore(MAIL_STORE_B).length;
    await alice.frame.evaluate((args) => AtlasWallet.sendUserMail(args.toDomain, args.pkBob, args.subject, args.body, null), {
      toDomain: TO_DOMAIN, pkBob, subject: 'Confirmed', body: 'Second message, now truly private — subject included.'
    });
    raw = newestMessage(MAIL_STORE_B, beforeCountB);
    if (raw.subject !== MAIL_ENCRYPTED_SUBJECT_PLACEHOLDER) throw new Error('Expected Alice\'s second message subject to be the fixed placeholder now that she knows Bob\'s key, got: ' + JSON.stringify(raw.subject));
    if (JSON.stringify(raw).includes('truly private') || JSON.stringify(raw).includes('Confirmed')) {
      throw new Error('REGRESSION: plaintext leaked into the relay\'s own stored copy of an encrypted message');
    }
    await bob.frame.evaluate(() => AtlasWallet.checkAllMail());
    const bobEntries2 = await mailEntries(bob.frame);
    const bobSeesSecond = bobEntries2.find((e) => e.message.subject === 'Confirmed');
    if (!bobSeesSecond || !bobSeesSecond.message.body.includes('truly private')) {
      throw new Error('Expected Bob to correctly decrypt Alice\'s second message: ' + JSON.stringify(bobEntries2));
    }
    console.log('PASS: both directions are now fully end-to-end encrypted on the wire (subject and body), and both sides decrypt correctly');

    console.log('\nALL MAIL ENCRYPTION CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await contextSub.close();
    await contextAlice.close();
    await contextBob.close();
  }
})();
