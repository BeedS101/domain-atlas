// Domain Atlas — wallet (v1.2 of the prototype)
//
// A real implementation of SPEC.md §5 (items), §5.2 (loadouts and
// transfer-on-loss), §5.4 (fungible resources), and §6 (identity) — plus
// the client half of §7 (trading stations), whose settlement lives in
// issuer-server/server.js. Nothing here is simulated; everything that can
// be checked cryptographically, is.
//
// Two identities exist in this wallet on purpose:
//   - "self"        — YOU. Backed by either of two interchangeable
//     mechanisms, the user's choice: a password-protected local ECDSA
//     keypair ("local domain atlas identity"), or a real WebAuthn passkey
//     (Windows Hello / Touch ID / security key). Exactly one is "active" at
//     a time (see atlasIdentityMode below), but both can be set up on the
//     same device in parallel and switched between freely — switching just
//     changes which public key "self" resolves to, so each mechanism keeps
//     its own separate wallet contents under its own key.
//   - "counterparty" — a second, purely local ECDSA keypair standing in
//     for a second visitor. §5.2 and §7 only mean something with two
//     independent signers; this wallet can't spin up a second physical
//     device, so it spins up a second real keypair instead. It's still a
//     genuine, distinct key capable of real signatures — it just isn't
//     gated by a hardware authenticator prompt the way a WebAuthn "self"
//     is. See README for the full reasoning.
//
// Signing abstraction: a WebAuthn "self" signs by turning a payload's hash
// into a WebAuthn challenge and running a real assertion ceremony — the
// only way a WebAuthn-bound key can sign application data at all (passkeys
// don't expose raw signing). A local-password "self", and "counterparty"
// always, sign directly with Web Crypto. All three produce a self-describing
// "envelope" {signerRole, publicKey, ...} that verifySignedPayload() (here)
// and verifyEnvelope() (server) check the same way.

const AtlasWallet = (() => {
  function b64urlEncode(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64urlDecode(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    const bin = atob(str);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  // Same algorithm as issuer-server/server.js — both sides must produce
  // byte-identical text for a signature to check out.
  function canonicalize(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
  }

  // WebAuthn assertion signatures arrive DER-encoded (SEQUENCE of two
  // INTEGERs); Web Crypto's verify() wants raw 64-byte r||s for P-256.
  function derToRawEcdsaSig(der) {
    const bytes = new Uint8Array(der);
    let offset = 2;
    function readInt() {
      if (bytes[offset] !== 0x02) throw new Error('malformed signature: expected INTEGER');
      offset++;
      let len = bytes[offset++];
      let val = bytes.slice(offset, offset + len);
      offset += len;
      while (val.length > 32 && val[0] === 0) val = val.slice(1);
      const out = new Uint8Array(32);
      out.set(val, 32 - val.length);
      return out;
    }
    const r = readInt();
    const s = readInt();
    const raw = new Uint8Array(64);
    raw.set(r, 0);
    raw.set(s, 32);
    return raw.buffer;
  }

  // Manifest/credential "domain" fields are bare hostnames (no scheme) per
  // the spec — something has to guess a protocol to actually fetch from
  // them. Guessing http:// unconditionally broke real HTTPS deployments:
  // a page loaded over https fetching an http:// issuer endpoint is mixed
  // content, and Chrome silently blocks it (fetch() rejects with a bare
  // "Failed to fetch", no server round-trip at all). Real domains are
  // https by default; localhost/127.0.0.1 (our own test/demo servers, and
  // most local dev setups) stay on http since they typically don't run TLS.
  function baseUrl(domain) {
    if (domain.startsWith('http')) return domain.replace(/\/$/, '');
    const isLocalHost = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(domain);
    return ((isLocalHost ? 'http://' : 'https://') + domain).replace(/\/$/, '');
  }

  // ---------- identity (self) — local password-protected key ----------
  //
  // Originally this wallet had two separate "self" identities: a WebAuthn
  // passkey (hardware-bound, never exportable) and a separate "portable"
  // identity for backup/recovery. Landing on ONE identity type at a time
  // was simpler for a while — a software ECDSA keypair, unlocked by a
  // single password, is what this section implements. The WebAuthn
  // implementation was kept working and untouched further down under
  // WebAuthn-specific names, and is now wired back in as a genuine
  // alternative "self" mechanism — see atlasIdentityMode a little further
  // down, and getIdentityMode()/setIdentityMode() — rather than a
  // replacement for this one. Nothing below in this section changes
  // meaning; it's just no longer the only way to be "self."
  //
  // Two different protections layered on the same key, for two different
  // situations:
  //   - Everyday local use: the private key is encrypted at rest in
  //     chrome.storage.local under a key derived from the password ALONE,
  //     and the decrypted copy is cached in chrome.storage.session — an
  //     in-memory-only area that's cleared the moment the browser fully
  //     closes — so unlocking is required once per browser session, not
  //     once per click.
  //   - Moving to another device: exporting requires the password AND the
  //     seed phrase combined (see deriveAesKey below) — the stronger,
  //     higher-friction protection appropriate for a file that can leave
  //     this device entirely. Exporting always re-asks for the password
  //     even if the wallet is already unlocked this session, specifically
  //     so being at an already-unlocked wallet isn't enough on its own to
  //     walk away with a portable copy of the identity.
  //
  // Note on scope: real HD/seed-phrase wallets (BIP-32/39) deterministically
  // regenerate the SAME keypair from the seed phrase alone, using elliptic-
  // curve point derivation. The Web Crypto API this extension relies on
  // doesn't expose the raw scalar/point math needed to do that safely
  // without pulling in a separate elliptic-curve library, which this
  // zero-dependency codebase deliberately avoids. So here the seed phrase
  // is NOT the source of the key — the keypair is generated independently,
  // and the seed phrase instead serves as the second of two secrets that
  // protect the *exported* copy of that key. It is deliberately not shown
  // to the user more than once and is never itself written to storage.

  const SEED_WORDLIST = [
    "abacus", "acid", "acorn", "acre", "actor", "adept", "adopt", "adult",
    "after", "agile", "album", "alert", "algae", "alike", "alloy", "alone",
    "amber", "amuse", "anchor", "angle", "ankle", "antler", "apex", "apple",
    "apron", "arch", "arena", "argue", "armor", "arrow", "ashen", "aspect",
    "atlas", "atom", "attic", "aunt", "autumn", "avenue", "awake", "axis",
    "badge", "baker", "balsa", "banjo", "barge", "basil", "basin", "beacon",
    "beak", "beam", "bean", "bear", "beaver", "belt", "bench", "berry",
    "bind", "birch", "bison", "blade", "blanket", "bloom", "blue", "boat",
    "bolt", "bonus", "boost", "border", "bottle", "boulder", "branch", "brave",
    "brick", "bridge", "bright", "bronze", "brook", "brush", "bubble", "bucket",
    "buddy", "budget", "buffalo", "bugle", "bumper", "bundle", "burrow", "cabin",
    "cable", "cactus", "camel", "camp", "canal", "candle", "canoe", "canvas",
    "canyon", "cape", "carbon", "cargo", "carve", "castle", "cave", "cedar",
    "cellar", "chalk", "chant", "charm", "chase", "cherry", "chess", "chief",
    "chimney", "choice", "cider", "cinder", "circle", "citrus", "clamp", "clap",
    "clay", "clerk", "cliff", "clock", "cloud", "clover", "coach", "cobalt",
    "coil", "comet", "compass", "copper", "coral", "cotton", "cove", "crane",
    "crater", "cream", "crest", "cricket", "crown", "crumb", "cube", "curve",
    "dagger", "dawn", "delta", "desert", "dial", "diamond", "dice", "ditch",
    "dolphin", "domain", "donkey", "dragon", "drift", "drizzle", "drum", "dusk",
    "dust", "eagle", "earth", "ebony", "echo", "eddy", "elbow", "elder",
    "ember", "emerald", "ensign", "envoy", "equal", "era", "ermine", "estate",
    "ether", "ewe", "fable", "falcon", "fauna", "feast", "fern", "ferry",
    "field", "finch", "fjord", "flame", "flare", "flask", "fleet", "flint",
    "flora", "flute", "foam", "forest", "forge", "forum", "fossil", "fox",
    "frame", "friar", "frost", "fuel", "gable", "galaxy", "gale", "garden",
    "garnet", "gate", "gecko", "gem", "geode", "giant", "ginger", "glacier",
    "globe", "gloss", "gorge", "grain", "grape", "grasp", "gravel", "grove",
    "guard", "gulf", "harbor", "harp", "hatch", "haven", "hazel", "heron",
    "hex", "hollow", "honey", "hoof", "horizon", "husk", "ibis", "igloo",
    "indigo", "inlet", "ivory", "jade", "jasper", "jetty", "jewel", "jigsaw",
    "jungle", "junior", "kettle", "kiln", "kite", "knoll", "lagoon", "lake"
  ];

  // 16 words from a 256-word list = 128 bits of raw entropy — the same
  // ballpark as a real 12-word BIP-39 phrase (~128 bits). Never persisted;
  // returned once to the caller to show the user and then forgotten.
  function generateSeedPhrase() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes).map((b) => SEED_WORDLIST[b]).join(' ');
  }

  // Derives one AES-GCM key from one or more secrets combined. Each secret
  // is hashed to a fixed-length digest first, then the digests are
  // concatenated — so the boundary between secrets is never ambiguous (a
  // password that happens to contain characters also present in a seed
  // phrase, or vice versa, can't shift where one input ends and the next
  // begins). One secret (the local unlock password) and two secrets
  // (password + seed phrase, for a portable export) go through the exact
  // same function: if two secrets were checked separately instead of
  // combined like this, an attacker could crack each one on its own and
  // add the two costs together; combined, a guess is only ever checked as
  // a whole set at once, multiplying the search space instead of adding
  // it. The high iteration count is the separate, real defense against
  // offline brute force either way — someone with the file can try keys
  // forever with no one to rate-limit them, so each guess needs to be
  // deliberately slow.
  async function deriveAesKey(secrets, saltBytes) {
    const digests = await Promise.all(secrets.map((s) =>
      crypto.subtle.digest('SHA-256', new TextEncoder().encode(s || ''))
    ));
    const combined = new Uint8Array(32 * digests.length);
    digests.forEach((d, i) => combined.set(new Uint8Array(d), i * 32));
    const baseKey = await crypto.subtle.importKey('raw', combined, 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: saltBytes, iterations: 250000, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  function normalizeSeedPhrase(seedPhrase) {
    return (seedPhrase || '').trim().toLowerCase().split(/\s+/).join(' ');
  }

  // ---------- identity mode — which "self" mechanism is active ----------
  //
  // Both a local password identity and a WebAuthn passkey identity can
  // exist in storage on this device at the same time (they live under
  // separate keys, atlasIdentity and atlasWebAuthnIdentity, and never
  // overwrite each other). atlasIdentityMode is just a pointer saying
  // which one currently answers to "self" — switching is instant and
  // non-destructive: it flips the pointer, nothing is deleted, and
  // switching back later restores exactly where that identity's own
  // wallet was left. If no mode has ever been explicitly recorded (e.g. an
  // identity created before this pointer existed), it's inferred from
  // whichever identity actually exists, defaulting to local.

  async function hasLocalIdentity() {
    const { atlasIdentity } = await chrome.storage.local.get('atlasIdentity');
    return !!atlasIdentity;
  }

  async function hasWebAuthnIdentity() {
    return !!(await getWebAuthnIdentity());
  }

  async function getIdentityMode() {
    const { atlasIdentityMode } = await chrome.storage.local.get('atlasIdentityMode');
    if (atlasIdentityMode === 'local' && await hasLocalIdentity()) return 'local';
    if (atlasIdentityMode === 'webauthn' && await hasWebAuthnIdentity()) return 'webauthn';
    // No (usable) recorded mode — infer from whichever identity exists.
    if (await hasLocalIdentity()) return 'local';
    if (await hasWebAuthnIdentity()) return 'webauthn';
    return null;
  }

  // Switches which mechanism answers to "self." Refuses to switch to a
  // mechanism that hasn't been set up yet — create it first (createIdentity
  // or createWebAuthnIdentity), which each activate themselves automatically.
  async function setIdentityMode(mode) {
    if (mode !== 'local' && mode !== 'webauthn') throw new Error('Unknown identity mode: ' + mode);
    const exists = mode === 'local' ? await hasLocalIdentity() : await hasWebAuthnIdentity();
    if (!exists) throw new Error('Set up that identity before switching to it.');
    await chrome.storage.local.set({ atlasIdentityMode: mode });
  }

  async function hasIdentity() {
    return (await getIdentityMode()) !== null;
  }

  // WebAuthn has no "locked" state to unlock — the private key never
  // leaves the authenticator, so there's no local decrypted secret to
  // gate; every signature is its own fresh hardware ceremony instead. Only
  // the local-password mode has a real per-session unlock.
  async function isUnlocked() {
    const mode = await getIdentityMode();
    if (mode === 'webauthn') return true;
    if (mode === 'local') {
      const { atlasUnlockedIdentity } = await chrome.storage.session.get('atlasUnlockedIdentity');
      return !!atlasUnlockedIdentity;
    }
    return false;
  }

  // The identity actually used for signing, day to day. Shape depends on
  // mode: local includes the session-cached privateKeyJwk (needed by
  // signWithSelf below); webauthn never exposes a private key at all, only
  // publicKey + mode — signing instead goes through a WebAuthn ceremony.
  // Returns null if there's nothing active yet (no identity, or a local
  // identity that hasn't been unlocked this session), so callers can check
  // state before acting on it.
  async function getIdentity() {
    const mode = await getIdentityMode();
    if (mode === 'webauthn') {
      const identity = await getWebAuthnIdentity();
      return identity ? { publicKey: identity.publicKey, mode: 'webauthn' } : null;
    }
    if (mode === 'local') {
      const { atlasUnlockedIdentity } = await chrome.storage.session.get('atlasUnlockedIdentity');
      return atlasUnlockedIdentity ? { ...atlasUnlockedIdentity, mode: 'local' } : null;
    }
    return null;
  }

  async function createIdentity(password) {
    if (!password || password.length < 8) throw new Error('Choose a password of at least 8 characters.');
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const rawPublic = await crypto.subtle.exportKey('raw', pair.publicKey);
    const privateKeyJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    const publicKey = b64urlEncode(rawPublic);

    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveAesKey([password], salt);
    const plaintext = new TextEncoder().encode(JSON.stringify({ publicKey, privateKeyJwk }));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
    await chrome.storage.local.set({
      atlasIdentity: {
        format: 'atlas-identity-local/1.0',
        publicKey,
        salt: b64urlEncode(salt.buffer),
        iv: b64urlEncode(iv.buffer),
        ciphertext: b64urlEncode(ciphertext),
        createdAt: new Date().toISOString()
      }
    });
    await chrome.storage.session.set({ atlasUnlockedIdentity: { publicKey, privateKeyJwk } });
    await chrome.storage.local.set({ atlasIdentityMode: 'local' });

    const seedPhrase = generateSeedPhrase();
    return { publicKey, seedPhrase };
  }

  // Password alone unlocks local, everyday use — the seed phrase is
  // reserved for the export/import flow below, not asked for here.
  async function unlockIdentity(password) {
    const { atlasIdentity } = await chrome.storage.local.get('atlasIdentity');
    if (!atlasIdentity) throw new Error('No identity set up on this device yet.');
    const salt = new Uint8Array(b64urlDecode(atlasIdentity.salt));
    const iv = new Uint8Array(b64urlDecode(atlasIdentity.iv));
    const key = await deriveAesKey([password], salt);
    let plaintext;
    try {
      plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, b64urlDecode(atlasIdentity.ciphertext));
    } catch (err) {
      throw new Error('Incorrect password.');
    }
    const { publicKey, privateKeyJwk } = JSON.parse(new TextDecoder().decode(plaintext));
    await chrome.storage.session.set({ atlasUnlockedIdentity: { publicKey, privateKeyJwk } });
    await chrome.storage.local.set({ atlasIdentityMode: 'local' });
    return { publicKey };
  }

  async function lockIdentity() {
    await chrome.storage.session.remove('atlasUnlockedIdentity');
  }

  // Same trust rule as exportIdentity below: re-derives from the LOCAL
  // encrypted blob using the CURRENT password rather than trusting the
  // session cache, so changing the password still requires proving you
  // know the old one. The keypair itself (publicKey/privateKeyJwk) is
  // untouched — only the at-rest salt/iv/ciphertext protecting it changes,
  // so this never affects any credential's owner key. Does NOT touch any
  // already-exported identity backup file — that file stays encrypted
  // under whatever password (and seed phrase) was current when it was
  // made, not this new one; see exportIdentity for why.
  async function changePassword(currentPassword, newPassword) {
    if (!newPassword || newPassword.length < 8) throw new Error('Choose a new password of at least 8 characters.');
    const { atlasIdentity } = await chrome.storage.local.get('atlasIdentity');
    if (!atlasIdentity) throw new Error('No identity set up on this device yet.');
    const salt = new Uint8Array(b64urlDecode(atlasIdentity.salt));
    const iv = new Uint8Array(b64urlDecode(atlasIdentity.iv));
    const key = await deriveAesKey([currentPassword], salt);
    let plaintext;
    try {
      plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, b64urlDecode(atlasIdentity.ciphertext));
    } catch (err) {
      throw new Error('Incorrect current password.');
    }
    if (newPassword === currentPassword) throw new Error('New password must be different from the current one.');

    const newSalt = crypto.getRandomValues(new Uint8Array(16));
    const newIv = crypto.getRandomValues(new Uint8Array(12));
    const newKey = await deriveAesKey([newPassword], newSalt);
    const newCiphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: newIv }, newKey, plaintext);
    await chrome.storage.local.set({
      atlasIdentity: {
        ...atlasIdentity,
        salt: b64urlEncode(newSalt.buffer),
        iv: b64urlEncode(newIv.buffer),
        ciphertext: b64urlEncode(newCiphertext)
      }
    });
    // The session-cached unlocked identity (publicKey/privateKeyJwk) is
    // still correct — same keypair — so no need to re-unlock.
  }

  async function signWithSelf(payload) {
    const mode = await getIdentityMode();
    if (mode === 'webauthn') return signWithWebAuthnIdentity(payload);
    const identity = await getIdentity();
    if (!identity) throw new Error('Unlock your wallet first.');
    const privateKey = await crypto.subtle.importKey('jwk', identity.privateKeyJwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    const data = new TextEncoder().encode(canonicalize(payload));
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, data);
    return { signerRole: 'raw-ecdsa', publicKey: identity.publicKey, signature: b64urlEncode(sig) };
  }

  // Bare-possession proof: sign a fresh random nonce and verify it against
  // our own public key, entirely client-side.
  async function presentIdentity() {
    const identity = await getIdentity();
    if (!identity) throw new Error('Unlock your wallet first.');
    const challenge = { nonce: b64urlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer), purpose: 'present-identity' };
    const envelope = await signWithSelf(challenge);
    return verifySignedPayload(challenge, envelope);
  }

  // Exporting re-derives from the LOCAL encrypted blob and requires the
  // password again — it deliberately does not trust the session cache, so
  // someone at an already-unlocked wallet still can't walk away with a
  // portable copy of the identity without knowing the password. The file
  // itself is then protected by password + seed phrase combined.
  async function exportIdentity(password, seedPhrase) {
    const { atlasIdentity } = await chrome.storage.local.get('atlasIdentity');
    if (!atlasIdentity) throw new Error('No identity set up on this device yet.');
    if (!seedPhrase || normalizeSeedPhrase(seedPhrase).split(' ').length < 4) {
      throw new Error('Enter the full seed phrase you were shown when you created this identity.');
    }
    const localSalt = new Uint8Array(b64urlDecode(atlasIdentity.salt));
    const localIv = new Uint8Array(b64urlDecode(atlasIdentity.iv));
    const localKey = await deriveAesKey([password], localSalt);
    let plaintext;
    try {
      plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: localIv }, localKey, b64urlDecode(atlasIdentity.ciphertext));
    } catch (err) {
      throw new Error('Incorrect password.');
    }
    const { publicKey, privateKeyJwk } = JSON.parse(new TextDecoder().decode(plaintext));

    const exportSalt = crypto.getRandomValues(new Uint8Array(16));
    const exportIv = crypto.getRandomValues(new Uint8Array(12));
    const exportKey = await deriveAesKey([password, normalizeSeedPhrase(seedPhrase)], exportSalt);
    const exportPlaintext = new TextEncoder().encode(JSON.stringify({ publicKey, privateKeyJwk }));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: exportIv }, exportKey, exportPlaintext);
    return {
      format: 'atlas-identity-export/1.0',
      salt: b64urlEncode(exportSalt.buffer),
      iv: b64urlEncode(exportIv.buffer),
      ciphertext: b64urlEncode(ciphertext),
      exportedAt: new Date().toISOString()
    };
  }

  // Attempts exactly one decrypt with the combined (password, seed phrase)
  // key — success or failure is the only signal produced, on the whole
  // pair at once, never on either secret alone. On success, re-encrypts
  // locally under the password alone (the everyday unlock scheme) and
  // unlocks it for this session.
  async function importIdentity(fileData, password, seedPhrase) {
    if (!fileData || fileData.format !== 'atlas-identity-export/1.0') throw new Error('Not an Atlas identity file.');
    const salt = new Uint8Array(b64urlDecode(fileData.salt));
    const iv = new Uint8Array(b64urlDecode(fileData.iv));
    const key = await deriveAesKey([password, normalizeSeedPhrase(seedPhrase)], salt);
    let plaintext;
    try {
      plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, b64urlDecode(fileData.ciphertext));
    } catch (err) {
      throw new Error('Incorrect password or seed phrase.');
    }
    const { publicKey, privateKeyJwk } = JSON.parse(new TextDecoder().decode(plaintext));

    const localSalt = crypto.getRandomValues(new Uint8Array(16));
    const localIv = crypto.getRandomValues(new Uint8Array(12));
    const localKey = await deriveAesKey([password], localSalt);
    const localPlaintext = new TextEncoder().encode(JSON.stringify({ publicKey, privateKeyJwk }));
    const localCiphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: localIv }, localKey, localPlaintext);
    await chrome.storage.local.set({
      atlasIdentity: {
        format: 'atlas-identity-local/1.0',
        publicKey,
        salt: b64urlEncode(localSalt.buffer),
        iv: b64urlEncode(localIv.buffer),
        ciphertext: b64urlEncode(localCiphertext),
        createdAt: new Date().toISOString()
      }
    });
    await chrome.storage.session.set({ atlasUnlockedIdentity: { publicKey, privateKeyJwk } });
    await chrome.storage.local.set({ atlasIdentityMode: 'local' });
    return { publicKey };
  }

  // ---------- WebAuthn identity — hardware-backed "self" alternative ----------
  // The original hardware-backed "self" identity: real Windows Hello /
  // Touch ID / security-key backed keys, never exportable by design (the
  // private key never leaves the authenticator). Now wired back in as a
  // genuine alternative to the local password identity above — the user
  // picks one at onboarding and can set up + switch to the other later.
  // createWebAuthnIdentity() activates itself as the active mode, same as
  // createIdentity() does for the local one.

  async function getWebAuthnIdentity() {
    const { atlasWebAuthnIdentity } = await chrome.storage.local.get('atlasWebAuthnIdentity');
    return atlasWebAuthnIdentity || null;
  }

  async function createWebAuthnIdentity() {
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const userId = crypto.getRandomValues(new Uint8Array(16));
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge,
        rp: { name: 'Domain Atlas' },
        user: { id: userId, name: 'atlas-guest', displayName: 'Atlas Guest' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }], // ES256 / P-256
        authenticatorSelection: { userVerification: 'preferred' },
        timeout: 60000
      }
    });
    const spki = cred.response.getPublicKey();
    const identity = {
      credentialId: b64urlEncode(cred.rawId),
      publicKey: b64urlEncode(spki),
      createdAt: new Date().toISOString()
    };
    await chrome.storage.local.set({ atlasWebAuthnIdentity: identity });
    await chrome.storage.local.set({ atlasIdentityMode: 'webauthn' });
    return identity;
  }

  async function signWithWebAuthnIdentity(payload) {
    const identity = await getWebAuthnIdentity();
    if (!identity) throw new Error('Create a WebAuthn identity first.');
    const dataHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalize(payload)));
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: dataHash,
        allowCredentials: [{ id: b64urlDecode(identity.credentialId), type: 'public-key' }],
        userVerification: 'preferred',
        timeout: 60000
      }
    });
    return {
      signerRole: 'webauthn',
      publicKey: identity.publicKey,
      clientDataJSON: b64urlEncode(assertion.response.clientDataJSON),
      authenticatorData: b64urlEncode(assertion.response.authenticatorData),
      signature: b64urlEncode(assertion.response.signature)
    };
  }

  async function presentWebAuthnIdentity() {
    const identity = await getWebAuthnIdentity();
    if (!identity) throw new Error('No WebAuthn identity to present.');
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge,
        allowCredentials: [{ id: b64urlDecode(identity.credentialId), type: 'public-key' }],
        userVerification: 'preferred',
        timeout: 60000
      }
    });
    const authData = new Uint8Array(assertion.response.authenticatorData);
    const clientDataHash = new Uint8Array(await crypto.subtle.digest('SHA-256', assertion.response.clientDataJSON));
    const signedData = new Uint8Array(authData.length + clientDataHash.length);
    signedData.set(authData, 0);
    signedData.set(clientDataHash, authData.length);
    const rawSig = derToRawEcdsaSig(assertion.response.signature);
    const publicKey = await crypto.subtle.importKey('spki', b64urlDecode(identity.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
    return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, rawSig, signedData.buffer);
  }

  // ---------- counterparty ("the other visitor") ----------

  async function getCounterparty() {
    const { atlasCounterparty } = await chrome.storage.local.get('atlasCounterparty');
    return atlasCounterparty || null;
  }

  async function createCounterparty() {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const rawPublic = await crypto.subtle.exportKey('raw', pair.publicKey);
    const privateKeyJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    const counterparty = { publicKey: b64urlEncode(rawPublic), privateKeyJwk, createdAt: new Date().toISOString() };
    await chrome.storage.local.set({ atlasCounterparty: counterparty });
    return counterparty;
  }

  async function identityOf(role) {
    const who = role === 'self' ? await getIdentity() : await getCounterparty();
    if (!who) throw new Error('Create the ' + role + ' identity first.');
    return who;
  }

  // ---------- signing envelopes ----------
  // signWithSelf() lives above, in the identity section — it's the same
  // "self" role, just backed by the merged password-protected identity now.

  async function signWithCounterparty(payload) {
    const counterparty = await getCounterparty();
    if (!counterparty) throw new Error('Create a counterparty identity first.');
    const privateKey = await crypto.subtle.importKey('jwk', counterparty.privateKeyJwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    const data = new TextEncoder().encode(canonicalize(payload));
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, data);
    return { signerRole: 'raw-ecdsa', publicKey: counterparty.publicKey, signature: b64urlEncode(sig) };
  }

  async function signAs(role, payload) {
    return role === 'self' ? signWithSelf(payload) : signWithCounterparty(payload);
  }

  async function verifySignedPayload(payload, envelope) {
    const dataHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalize(payload))));

    if (envelope.signerRole === 'webauthn') {
      const clientDataBuf = b64urlDecode(envelope.clientDataJSON);
      const clientData = JSON.parse(new TextDecoder().decode(clientDataBuf));
      if (clientData.challenge !== b64urlEncode(dataHash.buffer)) return false;
      const authData = new Uint8Array(b64urlDecode(envelope.authenticatorData));
      const clientDataHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataBuf));
      const signedData = new Uint8Array(authData.length + clientDataHash.length);
      signedData.set(authData, 0);
      signedData.set(clientDataHash, authData.length);
      const rawSig = derToRawEcdsaSig(b64urlDecode(envelope.signature));
      const pub = await crypto.subtle.importKey('spki', b64urlDecode(envelope.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
      return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, rawSig, signedData);
    }

    if (envelope.signerRole === 'raw-ecdsa') {
      const pub = await crypto.subtle.importKey('raw', b64urlDecode(envelope.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
      const data = new TextEncoder().encode(canonicalize(payload));
      return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, b64urlDecode(envelope.signature), data);
    }

    return false;
  }

  // ---------- item wallet (§5), keyed by owner public key so both
  // identities' held items can be shown side by side ----------

  async function getWallet(ownerPublicKey) {
    const { atlasWallets } = await chrome.storage.local.get('atlasWallets');
    return (atlasWallets || {})[ownerPublicKey] || [];
  }

  async function saveWallet(ownerPublicKey, entries) {
    const { atlasWallets } = await chrome.storage.local.get('atlasWallets');
    const wallets = atlasWallets || {};
    wallets[ownerPublicKey] = entries;
    await chrome.storage.local.set({ atlasWallets: wallets });
  }

  async function requestItem(issuerDomain, assetClass) {
    const identity = await getIdentity();
    if (!identity) throw new Error('Create an identity first.');
    const res = await fetch(baseUrl(issuerDomain) + '/atlas/issue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ownerPublicKey: identity.publicKey, assetClass })
    });
    if (!res.ok) throw new Error('Issuer refused: ' + (await res.text()));
    const credential = await res.json();
    const verdict = await verifyCredential(credential);
    const wallet = await getWallet(identity.publicKey);
    wallet.push({ credential, lastVerdict: verdict });
    await saveWallet(identity.publicKey, wallet);
    return { credential, verdict };
  }

  // The four checks from SPEC.md §5, steps 1/2/4 — step 3 (fresh WebAuthn
  // assertion) is presentIdentity() below.
  async function verifyCredential(credential) {
    try {
      const base = baseUrl(credential.issuer.domain);
      const [keyDoc, revDoc] = await Promise.all([
        fetch(base + '/.well-known/atlas-key.json', { cache: 'no-store' }).then((r) => r.json()),
        fetch(base + '/.well-known/atlas-revocations.json', { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ revoked: [] }))
      ]);
      const issuedAt = new Date(credential.issuedAt).getTime();
      const activeKey = (keyDoc.keys || []).find((k) => {
        const from = new Date(k.validFrom).getTime();
        const until = k.validUntil ? new Date(k.validUntil).getTime() : Infinity;
        return k.publicKey === credential.issuer.publicKey && issuedAt >= from && issuedAt <= until;
      });
      if (!activeKey) return { valid: false, reason: 'issuer key was not valid at issuedAt' };

      const payload = { id: credential.id, asset: credential.asset, owner: credential.owner, issuedAt: credential.issuedAt };
      const data = new TextEncoder().encode(canonicalize(payload));
      const publicKey = await crypto.subtle.importKey('raw', b64urlDecode(activeKey.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
      const sigOk = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, b64urlDecode(credential.signature), data);
      if (!sigOk) return { valid: false, reason: 'signature does not match' };

      const revoked = (revDoc.revoked || []).some((r) => r.id === credential.id);
      if (revoked) return { valid: false, reason: 'revoked by issuer' };
      return { valid: true, reason: 'signature verified against issuer key; not revoked' };
    } catch (err) {
      return { valid: false, reason: 'verification error: ' + err.message };
    }
  }

  // Removes an item from this wallet's LOCAL view only — there's no way to
  // ask the issuer to un-issue a credential, and nothing here pretends to.
  // This is for decluttering (a duplicate, a revoked item you're done
  // tracking) — the credential itself, wherever else a copy of it exists,
  // is unaffected. Also drops it from the loadout, in case it was loaded.
  async function deleteItem(ownerPublicKey, credentialId) {
    const wallet = (await getWallet(ownerPublicKey)).filter((e) => e.credential.id !== credentialId);
    await saveWallet(ownerPublicKey, wallet);
    await unloadItem(credentialId);
  }

  // Hiding is the non-destructive counterpart to deleteItem above: the
  // credential stays in local storage (still exported in backups, still
  // re-verifiable) and only gets an entry.hidden flag that the UI uses to
  // leave it out of the main item list. Unlike delete, this can't lose an
  // item that has no other copy anywhere — it's always reachable again from
  // Settings. Also unloads it, same reasoning as delete: a hidden item
  // shouldn't stay "loaded into this world" where it's no longer visible.
  async function hideItem(ownerPublicKey, credentialId) {
    const wallet = await getWallet(ownerPublicKey);
    const entry = wallet.find((e) => e.credential.id === credentialId);
    if (!entry) return;
    entry.hidden = true;
    await saveWallet(ownerPublicKey, wallet);
    await unloadItem(credentialId);
  }

  async function unhideItem(ownerPublicKey, credentialId) {
    const wallet = await getWallet(ownerPublicKey);
    const entry = wallet.find((e) => e.credential.id === credentialId);
    if (!entry) return;
    delete entry.hidden;
    await saveWallet(ownerPublicKey, wallet);
  }

  // ---------- resource wallet (§5.4), same keyed-by-owner shape ----------

  async function getResourceWallet(ownerPublicKey) {
    const { atlasResourceWallets } = await chrome.storage.local.get('atlasResourceWallets');
    return (atlasResourceWallets || {})[ownerPublicKey] || [];
  }

  async function saveResourceWallet(ownerPublicKey, entries) {
    const { atlasResourceWallets } = await chrome.storage.local.get('atlasResourceWallets');
    const wallets = atlasResourceWallets || {};
    wallets[ownerPublicKey] = entries;
    await chrome.storage.local.set({ atlasResourceWallets: wallets });
  }

  function resourcePayloadOf(credential) {
    return {
      id: credential.id, class: credential.class, quantity: credential.quantity,
      owner: credential.owner, supersedes: credential.supersedes,
      // properties (SPEC.md §5.4) is optional and, when present, was part
      // of what the issuer actually signed — it has to be reconstructed
      // here too, or a properties-bearing balance would look tampered
      // with purely from this client omitting a field the issuer included.
      ...(credential.properties ? { properties: credential.properties } : {}),
      issuedAt: credential.issuedAt
    };
  }

  async function verifyResourceCredential(credential) {
    try {
      const base = baseUrl(credential.issuer.domain);
      const [keyDoc, revDoc] = await Promise.all([
        fetch(base + '/.well-known/atlas-key.json', { cache: 'no-store' }).then((r) => r.json()),
        fetch(base + '/.well-known/atlas-revocations.json', { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ revoked: [] }))
      ]);
      const issuedAt = new Date(credential.issuedAt).getTime();
      const activeKey = (keyDoc.keys || []).find((k) => {
        const from = new Date(k.validFrom).getTime();
        const until = k.validUntil ? new Date(k.validUntil).getTime() : Infinity;
        return k.publicKey === credential.issuer.publicKey && issuedAt >= from && issuedAt <= until;
      });
      if (!activeKey) return { valid: false, reason: 'issuer key was not valid at issuedAt' };

      const data = new TextEncoder().encode(canonicalize(resourcePayloadOf(credential)));
      const publicKey = await crypto.subtle.importKey('raw', b64urlDecode(activeKey.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
      const sigOk = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, b64urlDecode(credential.signature), data);
      if (!sigOk) return { valid: false, reason: 'signature does not match' };

      const revoked = (revDoc.revoked || []).some((r) => r.id === credential.id);
      if (revoked) return { valid: false, reason: 'revoked by issuer' };
      return { valid: true, reason: 'signature verified against issuer key; not revoked' };
    } catch (err) {
      return { valid: false, reason: 'verification error: ' + err.message };
    }
  }

  async function mintResource(role, issuerDomain, cls, quantity) {
    const owner = await identityOf(role);
    const res = await fetch(baseUrl(issuerDomain) + '/atlas/resource/issue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ownerPublicKey: owner.publicKey, class: cls, quantity })
    });
    if (!res.ok) throw new Error('Mint failed: ' + (await res.text()));
    const credential = await res.json();
    const verdict = await verifyResourceCredential(credential);
    const wallet = await getResourceWallet(owner.publicKey);
    wallet.push({ credential, lastVerdict: verdict });
    await saveResourceWallet(owner.publicKey, wallet);
    await autoConsolidateResourceWallet(owner.publicKey);
    return { credential, verdict };
  }

  async function splitResource(role, credential, sendAmount, toRole) {
    const fromOwner = await identityOf(role);
    const toOwner = await identityOf(toRole);
    const res = await fetch(baseUrl(credential.issuer.domain) + '/atlas/resource/split', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential, sendAmount, toPublicKey: toOwner.publicKey })
    });
    if (!res.ok) throw new Error('Split failed: ' + (await res.text()));
    const { sent, remainder } = await res.json();

    let fromWallet = (await getResourceWallet(fromOwner.publicKey)).filter((e) => e.credential.id !== credential.id);
    if (remainder) fromWallet.push({ credential: remainder, lastVerdict: await verifyResourceCredential(remainder) });
    await saveResourceWallet(fromOwner.publicKey, fromWallet);
    if (remainder) await autoConsolidateResourceWallet(fromOwner.publicKey);

    const toWallet = await getResourceWallet(toOwner.publicKey);
    toWallet.push({ credential: sent, lastVerdict: await verifyResourceCredential(sent) });
    await saveResourceWallet(toOwner.publicKey, toWallet);
    await autoConsolidateResourceWallet(toOwner.publicKey);

    return { sent, remainder };
  }

  // Merges several balances of the same class AND issuer into one — the
  // inverse of splitResource. Unlike deleteItem/deleteResource below, this
  // genuinely changes what's owned (N credentials become 1 with the summed
  // quantity), so it has to go through the issuer: only the issuer's
  // signature can vouch for the new total, the same reason splitResource's
  // remainder does. See /atlas/resource/consolidate in issuer-server and
  // issuer-php for the other half. This is the low-level primitive both
  // the manual "Consolidate" button (consolidateResources) and automatic
  // consolidation (autoConsolidateResourceWallet, below) build on.
  async function mergeResourceGroup(ownerPublicKey, credentials) {
    if (!credentials || credentials.length < 2) return null;
    const issuerDomain = credentials[0].issuer.domain;
    const res = await fetch(baseUrl(issuerDomain) + '/atlas/resource/consolidate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credentials })
    });
    if (!res.ok) throw new Error('Consolidate failed: ' + (await res.text()));
    const merged = await res.json();

    const mergedIds = new Set(credentials.map((c) => c.id));
    let wallet = (await getResourceWallet(ownerPublicKey)).filter((e) => !mergedIds.has(e.credential.id));
    wallet.push({ credential: merged, lastVerdict: await verifyResourceCredential(merged) });
    await saveResourceWallet(ownerPublicKey, wallet);
    return merged;
  }

  // Manual entry point — the "Consolidate" button in the UI.
  async function consolidateResources(role, credentials) {
    if (!credentials || credentials.length < 2) {
      throw new Error('Pick at least two balances of the same class and issuer to consolidate.');
    }
    const owner = await identityOf(role);
    return mergeResourceGroup(owner.publicKey, credentials);
  }

  // Automatic entry point — called after anything that can leave a wallet
  // holding two or more balances of the same class from the same issuer
  // (minting, a split's remainder/received side, a trade's received side,
  // importing a wallet file), so balances get folded into one as they
  // arise instead of the user having to notice and merge them by hand.
  // Scans the WHOLE resource wallet, not just the class that just changed,
  // so it also cleans up anything an earlier merge attempt failed to (a
  // network hiccup, say) — the manual button stays as a fallback either
  // way. A failed merge here is swallowed rather than thrown: it would
  // otherwise turn "the mint/split/trade itself succeeded" into a visible
  // error over what's genuinely just housekeeping on top of it; the
  // balances are left separate and still individually valid, and the
  // manual "Consolidate" button remains available to retry.
  async function autoConsolidateResourceWallet(ownerPublicKey) {
    const wallet = await getResourceWallet(ownerPublicKey);
    const groups = new Map();
    for (const entry of wallet) {
      const key = entry.credential.class + '::' + entry.credential.issuer.domain;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry.credential);
    }
    for (const group of groups.values()) {
      if (group.length > 1) {
        try {
          await mergeResourceGroup(ownerPublicKey, group);
        } catch (err) {
          // Leave this group as separate, individually-valid balances.
        }
      }
    }
  }

  // Local-only removal, same idea as deleteItem above — no server involved,
  // just decluttering this wallet's own view of a balance it's done with
  // (e.g. a zero-quantity leftover, or one already folded into a merge).
  // Still destructive though: a balance with real quantity left on it is
  // exactly as unrecoverable as a deleted item if this was the only local
  // copy, so hideResource below (not this) is what the resource card's
  // primary action uses now — delete stays available as a secondary,
  // confirm-guarded action for a stub that's genuinely done.
  async function deleteResource(ownerPublicKey, credentialId) {
    const wallet = (await getResourceWallet(ownerPublicKey)).filter((e) => e.credential.id !== credentialId);
    await saveResourceWallet(ownerPublicKey, wallet);
  }

  // Non-destructive counterpart to deleteResource, same shape as
  // hideItem/unhideItem above and for the same reason: a resource balance
  // can represent real spendable value, so losing it to a stray click is
  // just as bad as losing an item. The balance stays in local storage
  // (still exported in backups, still re-verifiable, still spendable if
  // unhidden) and only gets an entry.hidden flag the UI uses to leave it
  // out of the main resource list.
  async function hideResource(ownerPublicKey, credentialId) {
    const wallet = await getResourceWallet(ownerPublicKey);
    const entry = wallet.find((e) => e.credential.id === credentialId);
    if (!entry) return;
    entry.hidden = true;
    await saveResourceWallet(ownerPublicKey, wallet);
  }

  async function unhideResource(ownerPublicKey, credentialId) {
    const wallet = await getResourceWallet(ownerPublicKey);
    const entry = wallet.find((e) => e.credential.id === credentialId);
    if (!entry) return;
    delete entry.hidden;
    await saveResourceWallet(ownerPublicKey, wallet);
  }

  // ---------- loadout (§5.2) ----------

  async function getLoadout() {
    const { atlasLoadout } = await chrome.storage.local.get('atlasLoadout');
    return atlasLoadout || [];
  }

  async function setLoadout(ids) {
    await chrome.storage.local.set({ atlasLoadout: ids });
  }

  async function loadItem(itemId) {
    const loadout = await getLoadout();
    if (!loadout.includes(itemId)) loadout.push(itemId);
    await setLoadout(loadout);
  }

  async function unloadItem(itemId) {
    await setLoadout((await getLoadout()).filter((id) => id !== itemId));
  }

  // ---------- dropping items into a scene (local, self-only) ----------
  //
  // This is deliberately the SMALL, safe half of "drop and pick up an
  // item": nothing about ownership ever moves. A dropped item is still
  // this identity's credential, still sitting in this identity's own
  // wallet the whole time — "dropped" is just a local flag plus a
  // position, recorded per public key exactly like the alias/loadout
  // above. No signature, no issuer round-trip, because nothing is being
  // transferred to anyone.
  //
  // The bigger half — an item visible and takeable by OTHER visitors —
  // would need a world to actually host and mutate shared state (nothing
  // in this demo does; every world here is a static file, fetched fresh
  // per visit, per viewer.js's enterWorld) and a real answer for what
  // happens when two people reach for it at once. Deliberately not this.
  // A dropped item here is only ever visible to, and only ever
  // reclaimable by, whoever dropped it — visually "left on the ground in
  // that world," not actually offered to it.
  async function getDroppedItems(ownerPublicKey) {
    if (!ownerPublicKey) return [];
    const { atlasDroppedItems } = await chrome.storage.local.get('atlasDroppedItems');
    return (atlasDroppedItems || {})[ownerPublicKey] || [];
  }

  async function saveDroppedItems(ownerPublicKey, list) {
    const { atlasDroppedItems } = await chrome.storage.local.get('atlasDroppedItems');
    const all = atlasDroppedItems || {};
    all[ownerPublicKey] = list;
    await chrome.storage.local.set({ atlasDroppedItems: all });
  }

  // domain/world identify WHERE, in whichever manifest this owner was
  // standing in when they dropped it; position is renderer-native
  // coordinates (viewer.js supplies a clicked ground point for the 2D
  // renderer, or the live camera position for gltf-mini's 3D one).
  async function dropItem(ownerPublicKey, credentialId, domain, world, position) {
    if (!ownerPublicKey) throw new Error('No identity to drop an item from.');
    const list = (await getDroppedItems(ownerPublicKey)).filter((d) => d.credentialId !== credentialId);
    list.push({ credentialId, domain, world, position, droppedAt: new Date().toISOString() });
    await saveDroppedItems(ownerPublicKey, list);
    // Visually it's no longer "carried" once it's sitting in the scene —
    // keep the loadout list honest, same as hiding an item already does.
    await unloadItem(credentialId);
  }

  async function pickUpItem(ownerPublicKey, credentialId) {
    if (!ownerPublicKey) return;
    const list = (await getDroppedItems(ownerPublicKey)).filter((d) => d.credentialId !== credentialId);
    await saveDroppedItems(ownerPublicKey, list);
  }

  async function getDroppedItemsInWorld(ownerPublicKey, domain, world) {
    return (await getDroppedItems(ownerPublicKey)).filter((d) => d.domain === domain && d.world === world);
  }

  // Only self can lose something here, deliberately: the whole point of
  // §5.2 is that the loser's OWN key has to co-sign the transfer — no
  // world, including this one, can move an item it doesn't hold the key
  // to. The "world" only referees; this function plays that referee role
  // client-side (checking the loadout) but the authorization is entirely
  // the signature below.
  async function loseItemToCounterparty(itemCredential, worldContext) {
    const identity = await getIdentity();
    const counterparty = await getCounterparty();
    if (!identity || !counterparty) throw new Error('Both identities are required to demo a loss.');

    const payload = {
      itemId: itemCredential.id,
      from: { publicKey: identity.publicKey },
      to: { publicKey: counterparty.publicKey },
      worldContext,
      transferredAt: new Date().toISOString()
    };
    const proof = await signWithSelf(payload);
    const transfer = { credential: 'domain-atlas-transfer/1.0', ...payload, proof };

    // Verify our own output the way any relying party would before
    // applying it — proving the mechanism, not just trusting that signing
    // succeeded.
    const ok = await verifySignedPayload(payload, proof);
    if (!ok) throw new Error('Transfer signature failed its own check — not applying it.');

    let selfWallet = await getWallet(identity.publicKey);
    const entry = selfWallet.find((e) => e.credential.id === itemCredential.id);
    if (!entry) throw new Error('Item not found in self wallet.');
    selfWallet = selfWallet.filter((e) => e.credential.id !== itemCredential.id);
    await saveWallet(identity.publicKey, selfWallet);

    const cpWallet = await getWallet(counterparty.publicKey);
    cpWallet.push({ credential: entry.credential, lastVerdict: entry.lastVerdict, receivedVia: transfer });
    await saveWallet(counterparty.publicKey, cpWallet);

    await unloadItem(itemCredential.id);
    return transfer;
  }

  // ---------- trading stations (§7 client half) ----------

  async function proposeIntent(role, offer, want, counterpartyPublicKey, expiresMinutes) {
    const payload = {
      offer, want,
      counterparty: counterpartyPublicKey,
      expiresAt: new Date(Date.now() + (expiresMinutes || 10) * 60000).toISOString()
    };
    const proof = await signAs(role, payload);
    return { payload, proof };
  }

  async function settleTrade(issuerDomain, intentSelf, intentCounterparty, balanceSelf, balanceCounterparty) {
    const res = await fetch(baseUrl(issuerDomain) + '/atlas/resource/trade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intentA: intentSelf, intentB: intentCounterparty, balanceA: balanceSelf, balanceB: balanceCounterparty })
    });
    if (!res.ok) throw new Error('Trade failed: ' + (await res.text()));
    const { aRemainder, aReceived, bRemainder, bReceived } = await res.json();

    const identity = await getIdentity();
    const counterparty = await getCounterparty();

    let selfWallet = (await getResourceWallet(identity.publicKey)).filter((e) => e.credential.id !== balanceSelf.id);
    if (aRemainder) selfWallet.push({ credential: aRemainder, lastVerdict: await verifyResourceCredential(aRemainder) });
    selfWallet.push({ credential: aReceived, lastVerdict: await verifyResourceCredential(aReceived) });
    await saveResourceWallet(identity.publicKey, selfWallet);
    await autoConsolidateResourceWallet(identity.publicKey);

    let cpWallet = (await getResourceWallet(counterparty.publicKey)).filter((e) => e.credential.id !== balanceCounterparty.id);
    if (bRemainder) cpWallet.push({ credential: bRemainder, lastVerdict: await verifyResourceCredential(bRemainder) });
    cpWallet.push({ credential: bReceived, lastVerdict: await verifyResourceCredential(bReceived) });
    await saveResourceWallet(counterparty.publicKey, cpWallet);
    await autoConsolidateResourceWallet(counterparty.publicKey);

    return { aRemainder, aReceived, bRemainder, bReceived };
  }

  // ---------- identity alias (local, cosmetic nickname) ----------
  //
  // Purely a local label that replaces the raw public key in THIS wallet's
  // own display — never signed, never sent anywhere, never seen by a
  // counterparty or a world. Keyed by public key rather than by identity
  // mode, so it survives switching between the local and passkey identities
  // and stays attached to whichever key it was actually set for. No
  // encryption needed: an alias isn't a secret the way a private key is.
  //
  // A future "presented" alias — one a counterparty or world could see —
  // would be a different, harder feature: self-asserted and signed rather
  // than issuer-granted (this protocol has no central registry to grant
  // one), and it would need this SAME filtering applied twice: once here
  // at set-time, and again independently by whoever displays someone
  // else's alias, since the setter's own check is trivially skippable by
  // anyone willing to edit their own client. This is deliberately not
  // that yet — just the local nickname.

  const MAX_ALIAS_LENGTH = 24;

  // A short, deliberately partial blocklist — a casual deterrent, not a
  // guarantee, which is honest given there's no central authority in this
  // protocol to appeal to or enforce anything harder. Common leetspeak
  // substitutions are normalized away before matching, and the check is a
  // SUBSTRING match against the normalized, alphanumeric-only alias — that
  // catches obvious punctuation-based dodges, at the cost of the classic
  // "Scunthorpe problem" (a few innocent words can contain a blocked
  // substring and get rejected too). Erring toward over-blocking is the
  // safer trade-off here: a false rejection just means picking a
  // different alias, with no one to appeal to either way.
  const ALIAS_BLOCKLIST = [
    'fuck', 'shit', 'bitch', 'cunt', 'asshole', 'bastard', 'dick', 'piss',
    'slut', 'whore', 'fag', 'nigger', 'nigga', 'retard', 'rape'
  ];

  function normalizeForAliasFilter(text) {
    return (text || '')
      .toLowerCase()
      .replace(/0/g, 'o').replace(/1/g, 'i').replace(/!/g, 'i')
      .replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's')
      .replace(/@/g, 'a').replace(/\$/g, 's')
      .replace(/[^a-z0-9]/g, '');
  }

  function aliasContainsBlockedWord(alias) {
    const normalized = normalizeForAliasFilter(alias);
    return ALIAS_BLOCKLIST.some((word) => normalized.includes(word));
  }

  async function setAlias(publicKey, alias) {
    if (!publicKey) throw new Error('No identity to set an alias for.');
    const trimmed = (alias || '').trim();
    if (!trimmed) throw new Error('Alias cannot be empty — clear it instead if you want to remove it.');
    if (trimmed.length > MAX_ALIAS_LENGTH) throw new Error('Alias must be ' + MAX_ALIAS_LENGTH + ' characters or fewer.');
    if (aliasContainsBlockedWord(trimmed)) throw new Error('That alias isn\'t allowed here — try something else.');
    const { atlasAliases } = await chrome.storage.local.get('atlasAliases');
    const aliases = atlasAliases || {};
    aliases[publicKey] = trimmed;
    await chrome.storage.local.set({ atlasAliases: aliases });
  }

  async function clearAlias(publicKey) {
    if (!publicKey) return;
    const { atlasAliases } = await chrome.storage.local.get('atlasAliases');
    const aliases = atlasAliases || {};
    delete aliases[publicKey];
    await chrome.storage.local.set({ atlasAliases: aliases });
  }

  async function getAlias(publicKey) {
    if (!publicKey) return null;
    const { atlasAliases } = await chrome.storage.local.get('atlasAliases');
    return (atlasAliases || {})[publicKey] || null;
  }

  // ---------- recent worlds (navigation history) ----------
  //
  // Purely a client convenience — where have I been — with no ownership or
  // security meaning, so it deliberately lives outside any per-identity
  // wallet: it isn't touched by locking, switching identity mode, or
  // wallet import/export, and it's the same list regardless of which
  // identity (local or passkey) is currently active.
  const MAX_RECENT_WORLDS = 10;

  async function recordWorldVisit(entry) {
    if (!entry || !entry.domain || !entry.world) return;
    const { atlasRecentWorlds } = await chrome.storage.local.get('atlasRecentWorlds');
    let list = (atlasRecentWorlds || []).filter((e) => !(e.domain === entry.domain && e.world === entry.world));
    list.unshift({
      domain: entry.domain,
      world: entry.world,
      worldName: entry.worldName || entry.world,
      manifestUrl: entry.manifestUrl,
      visitedAt: new Date().toISOString()
    });
    list = list.slice(0, MAX_RECENT_WORLDS);
    await chrome.storage.local.set({ atlasRecentWorlds: list });
  }

  async function getRecentWorlds() {
    const { atlasRecentWorlds } = await chrome.storage.local.get('atlasRecentWorlds');
    return atlasRecentWorlds || [];
  }

  // ---------- misc ----------

  async function reverifyAll() {
    const identity = await getIdentity();
    const counterparty = await getCounterparty();
    for (const who of [identity, counterparty].filter(Boolean)) {
      const wallet = await getWallet(who.publicKey);
      for (const entry of wallet) entry.lastVerdict = await verifyCredential(entry.credential);
      await saveWallet(who.publicKey, wallet);

      const resWallet = await getResourceWallet(who.publicKey);
      for (const entry of resWallet) entry.lastVerdict = await verifyResourceCredential(entry.credential);
      await saveResourceWallet(who.publicKey, resWallet);
    }
  }

  async function exportWallet() {
    const identity = await getIdentity();
    const items = identity ? await getWallet(identity.publicKey) : [];
    const resources = identity ? await getResourceWallet(identity.publicKey) : [];
    return {
      format: 'atlas-wallet-export/1.0',
      identity: identity ? { publicKey: identity.publicKey } : null,
      credentials: [...items.map((w) => w.credential), ...resources.map((w) => w.credential)],
      exportedAt: new Date().toISOString()
    };
  }

  // The counterpart to exportWallet() above — re-populates this wallet's
  // LOCAL item/resource lists from a previously exported file. This is not
  // a trust operation the way importIdentity() is: nothing here is secret,
  // and every credential gets independently re-verified against its own
  // issuer (verifyCredential/verifyResourceCredential — real signature +
  // revocation checks) before it's trusted, exactly as if it had just been
  // issued. A credential whose `owner` doesn't match the currently active
  // identity is skipped rather than silently relabeled as yours — an
  // export file can be handed around, but importing it can't be used to
  // make someone else's credential show up as your own. Already-present
  // ids (by credential id) are skipped too, so importing the same file
  // twice is harmless.
  async function importWallet(fileData) {
    if (!fileData || fileData.format !== 'atlas-wallet-export/1.0') throw new Error('Not an Atlas wallet export file.');
    const identity = await getIdentity();
    if (!identity) throw new Error('Unlock your wallet first.');

    const credentials = Array.isArray(fileData.credentials) ? fileData.credentials : [];
    const items = credentials.filter((c) => c && c.credential === 'domain-atlas-item/1.0');
    const resources = credentials.filter((c) => c && c.credential === 'domain-atlas-resource/1.0');

    let itemsAdded = 0, itemsSkippedDuplicate = 0, itemsSkippedNotOwned = 0;
    const wallet = await getWallet(identity.publicKey);
    for (const credential of items) {
      if (credential.owner && credential.owner.publicKey !== identity.publicKey) { itemsSkippedNotOwned++; continue; }
      if (wallet.some((e) => e.credential.id === credential.id)) { itemsSkippedDuplicate++; continue; }
      wallet.push({ credential, lastVerdict: await verifyCredential(credential) });
      itemsAdded++;
    }
    if (itemsAdded > 0) await saveWallet(identity.publicKey, wallet);

    let resourcesAdded = 0, resourcesSkippedDuplicate = 0, resourcesSkippedNotOwned = 0;
    const resWallet = await getResourceWallet(identity.publicKey);
    for (const credential of resources) {
      if (credential.owner && credential.owner.publicKey !== identity.publicKey) { resourcesSkippedNotOwned++; continue; }
      if (resWallet.some((e) => e.credential.id === credential.id)) { resourcesSkippedDuplicate++; continue; }
      resWallet.push({ credential, lastVerdict: await verifyResourceCredential(credential) });
      resourcesAdded++;
    }
    if (resourcesAdded > 0) {
      await saveResourceWallet(identity.publicKey, resWallet);
      await autoConsolidateResourceWallet(identity.publicKey);
    }

    return {
      itemsAdded, itemsSkippedDuplicate, itemsSkippedNotOwned,
      resourcesAdded, resourcesSkippedDuplicate, resourcesSkippedNotOwned
    };
  }

  return {
    hasIdentity, isUnlocked, getIdentity, createIdentity, unlockIdentity, lockIdentity, changePassword,
    exportIdentity, importIdentity, presentIdentity,
    getIdentityMode, setIdentityMode, hasLocalIdentity, hasWebAuthnIdentity,
    getWebAuthnIdentity, createWebAuthnIdentity, presentWebAuthnIdentity,
    getCounterparty, createCounterparty,
    getWallet, requestItem, verifyCredential, reverifyAll, exportWallet, importWallet, deleteItem,
    hideItem, unhideItem,
    getResourceWallet, mintResource, verifyResourceCredential, splitResource,
    consolidateResources, deleteResource, hideResource, unhideResource,
    getLoadout, loadItem, unloadItem, loseItemToCounterparty,
    dropItem, pickUpItem, getDroppedItems, getDroppedItemsInWorld,
    proposeIntent, settleTrade, verifySignedPayload,
    recordWorldVisit, getRecentWorlds,
    setAlias, clearAlias, getAlias
  };
})();
