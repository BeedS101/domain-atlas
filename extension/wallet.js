// Domain Atlas — wallet (v1.2 of the prototype)
//
// A real implementation of SPEC.md §5 (asset credentials — unique and
// fungible in one shape, as of the task #44 merge), §5.2 (loadouts and
// transfer-on-loss, non-fungible), §5.4 (splitting/consolidating fungible
// balances), and §6 (identity) — plus the client half of §7 (trading
// stations, fungible), whose settlement lives in issuer-server/server.js.
// Nothing here is simulated; everything that can be checked
// cryptographically, is.
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

  // URGENT FIX, same day as #118: that change hardcoded PBKDF2's iteration
  // count to 600,000 with no way to tell what an EXISTING encrypted blob
  // was actually created under — every wallet that already existed before
  // #118 shipped was encrypted at the old 250,000, and unlockIdentity()
  // below started deriving the WRONG key for every one of them, which
  // AES-GCM correctly reports as a decrypt failure — indistinguishable
  // from "wrong password" to both the code and the person typing the
  // right one. That's a real lockout, not a hardening improvement, for
  // anyone who already had a wallet. Fixed the only way that doesn't
  // require anyone to remember which iteration count their wallet was
  // last touched under: every encrypted blob now RECORDS its own
  // `kdfIterations` alongside salt/iv/ciphertext, `deriveAesKey` takes
  // that count explicitly instead of assuming the current constant, and
  // a blob with no such field (anything that predates this fix) is
  // assumed to be exactly what it always was — KDF_ITERATIONS_LEGACY.
  // unlockIdentity() also uses a successful legacy unlock as the trigger
  // to transparently re-encrypt under KDF_ITERATIONS_CURRENT with a fresh
  // salt/iv, so a wallet that unlocks correctly once finishes migrating
  // itself with no separate step and no risk of ever locking out someone
  // who hasn't logged in since.
  const KDF_ITERATIONS_CURRENT = 600000;
  const KDF_ITERATIONS_LEGACY = 250000;

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
  // deliberately slow. 600,000 (task #118) matches current OWASP guidance
  // for PBKDF2-HMAC-SHA256 as of this writing — raised from an earlier
  // 250,000; see the comment above KDF_ITERATIONS_CURRENT for why the
  // count is now an explicit parameter instead of hardcoded here, and why
  // that matters. A further, bigger-lift hardening pass (a memory-hard KDF
  // like Argon2/scrypt, which resists GPU/ASIC-accelerated cracking far
  // better than any PBKDF2 iteration count can) is deliberately NOT done
  // here — Web Crypto has no native Argon2/scrypt, so that would mean
  // bundling a WASM implementation into the extension, a real new
  // dependency this project has otherwise stayed away from. Left as a
  // later task (#171), not bundled into this change.
  //
  // `iterations` defaults to the current constant so every call site that
  // ENCRYPTS a fresh blob (createIdentity, changePassword's new blob,
  // exportIdentity, importIdentity's local re-encrypt) can just omit it —
  // only a call site DECRYPTING an existing blob ever needs to pass a
  // specific count, and it should always be whatever that blob's own
  // `kdfIterations` field says (or KDF_ITERATIONS_LEGACY if the field is
  // absent), never assumed.
  //
  // `extractable` defaults to false (every pre-existing call site omits it
  // and keeps getting a key that can only ever be used, never read back out
  // — the right default for anything protecting the identity blob itself).
  // The one exception, added for automatic backup replication: the
  // password-derived key that encrypts the auto-backup file has to survive
  // being cached across a debounce window in chrome.storage.session (see
  // that feature's own comments further down), and a CryptoKey object
  // itself does not actually round-trip through chrome.storage.session
  // usably (verified directly — it comes back looking like a key but fails
  // every subtle.* call with "parameter is not of type CryptoKey"; that
  // storage layer does not give CryptoKey the structured-clone treatment
  // the Web Crypto spec allows for, at least not in the way this extension
  // needs). Exporting the raw bytes once, right after deriving, and
  // re-importing them at write time is the workaround — see
  // cacheAutoBackupSessionKey() below.
  async function deriveAesKey(secrets, saltBytes, iterations, extractable) {
    const digests = await Promise.all(secrets.map((s) =>
      crypto.subtle.digest('SHA-256', new TextEncoder().encode(s || ''))
    ));
    const combined = new Uint8Array(32 * digests.length);
    digests.forEach((d, i) => combined.set(new Uint8Array(d), i * 32));
    const baseKey = await crypto.subtle.importKey('raw', combined, 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: saltBytes, iterations: iterations || KDF_ITERATIONS_CURRENT, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      !!extractable,
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
    const atlasIdentityBlob = {
      format: 'atlas-identity-local/1.0',
      publicKey,
      salt: b64urlEncode(salt.buffer),
      iv: b64urlEncode(iv.buffer),
      ciphertext: b64urlEncode(ciphertext),
      kdfIterations: KDF_ITERATIONS_CURRENT,
      createdAt: new Date().toISOString()
    };
    await chrome.storage.local.set({ atlasIdentity: atlasIdentityBlob });
    await chrome.storage.session.set({ atlasUnlockedIdentity: { publicKey, privateKeyJwk } });
    await chrome.storage.local.set({ atlasIdentityMode: 'local' });
    // No-op today — automatic backup can't be enabled before an identity
    // exists — but harmless and future-proof to call unconditionally, same
    // as every other place this session sets atlasUnlockedIdentity.
    await cacheAutoBackupSessionKey(password);
    // Same reasoning — identity sync can't be enabled yet either, on a
    // brand-new identity, but harmless/future-proof to call anyway (and
    // correctly handles the case where this identity is replacing an
    // earlier one that still has a stale sync backup enabled).
    await reconcileIdentitySyncBackupOnIdentityChange(atlasIdentityBlob);
    await logActivity('identity', 'Identity created');

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
    // A blob with no kdfIterations field predates that field entirely
    // (see the comment above KDF_ITERATIONS_CURRENT) — it was encrypted
    // under the old hardcoded constant, not whatever KDF_ITERATIONS_CURRENT
    // happens to be today, so it MUST be read back with that same count.
    const iterations = atlasIdentity.kdfIterations || KDF_ITERATIONS_LEGACY;
    const key = await deriveAesKey([password], salt, iterations);
    let plaintext;
    try {
      plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, b64urlDecode(atlasIdentity.ciphertext));
    } catch (err) {
      throw new Error('Incorrect password.');
    }
    const { publicKey, privateKeyJwk } = JSON.parse(new TextDecoder().decode(plaintext));

    // Self-migrating: a correct unlock under anything less than today's
    // current iteration count is the one moment this code already has the
    // plaintext AND a proven-correct password in hand, so it's also the
    // safest possible moment to re-encrypt under KDF_ITERATIONS_CURRENT
    // with a fresh salt/iv and write it back — no separate migration step,
    // no re-prompting, and a wallet that's simply never been unlocked
    // since #118 shipped is never at risk of being treated as "wrong
    // password" for it. A failure here shouldn't block the unlock that
    // already succeeded, so it's best-effort.
    if (iterations < KDF_ITERATIONS_CURRENT) {
      try {
        const newSalt = crypto.getRandomValues(new Uint8Array(16));
        const newIv = crypto.getRandomValues(new Uint8Array(12));
        const newKey = await deriveAesKey([password], newSalt);
        const newCiphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: newIv }, newKey, plaintext);
        const migratedIdentityBlob = {
          ...atlasIdentity,
          salt: b64urlEncode(newSalt.buffer),
          iv: b64urlEncode(newIv.buffer),
          ciphertext: b64urlEncode(newCiphertext),
          kdfIterations: KDF_ITERATIONS_CURRENT
        };
        await chrome.storage.local.set({ atlasIdentity: migratedIdentityBlob });
        // Keeps a synced copy (if enabled) under the same fresh salt/iv,
        // rather than leaving it one KDF migration behind this device.
        await reconcileIdentitySyncBackupOnIdentityChange(migratedIdentityBlob);
      } catch (err) {
        // Best-effort — the unlock itself already succeeded either way.
      }
    }

    await chrome.storage.session.set({ atlasUnlockedIdentity: { publicKey, privateKeyJwk } });
    await chrome.storage.local.set({ atlasIdentityMode: 'local' });
    // Refreshes the automatic-backup session key for this unlock — see
    // that feature's own top comment for why it has to be re-derived here
    // rather than kept from some earlier session. A no-op if auto-backup
    // was never set up on this device.
    await cacheAutoBackupSessionKey(password);
    // Deliberately NOT logged to the wallet activity log (further down
    // this file) — an ordinary unlock happens every browser session and would
    // drown out everything else in the feed. The KDF-migration re-encrypt
    // just above is silent for the same reason: it's a transparent
    // security upgrade to an existing identity, not a new event the person
    // did anything about.
    return { publicKey };
  }

  async function lockIdentity() {
    await endAllAdminSessions();
    await chrome.storage.session.remove('atlasUnlockedIdentity');
    await clearAutoBackupSessionKey();
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
    const key = await deriveAesKey([currentPassword], salt, atlasIdentity.kdfIterations || KDF_ITERATIONS_LEGACY);
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
    const reencryptedIdentityBlob = {
      ...atlasIdentity,
      salt: b64urlEncode(newSalt.buffer),
      iv: b64urlEncode(newIv.buffer),
      ciphertext: b64urlEncode(newCiphertext),
      kdfIterations: KDF_ITERATIONS_CURRENT
    };
    await chrome.storage.local.set({ atlasIdentity: reencryptedIdentityBlob });
    // Same reasoning as the auto-backup re-key just below: a synced
    // identity copy (if enabled) is encrypted under the OLD password too,
    // and needs the same refresh or it silently stops matching what
    // unlocks this device.
    await reconcileIdentitySyncBackupOnIdentityChange(reencryptedIdentityBlob);
    await logActivity('identity', 'Wallet password changed');
    // The session-cached unlocked identity (publicKey/privateKeyJwk) is
    // still correct — same keypair — so no need to re-unlock.

    // If automatic backup replication is set up on this device, the file
    // it's been writing is encrypted under a key derived from the OLD
    // password — left as-is, it would silently become undecryptable with
    // the new one. Re-key it now, the same "this is the safest possible
    // moment, we already have proof of both passwords" reasoning
    // unlockIdentity's own KDF migration above uses. Best-effort: a
    // password change should never fail or roll back because of a backup
    // file write, and the debounced write path will catch it up again on
    // the very next data change even if this fails.
    try {
      const settings = await getAutoBackupSettings();
      if (settings && settings.enabled) {
        const identity = await getIdentity();
        const blob = await buildAutoBackupBlob(identity, newPassword); // mints a fresh salt
        await setAutoBackupSettings({ salt: blob.salt, kdfIterations: blob.kdfIterations });
        await cacheAutoBackupSessionKey(newPassword);
        scheduleAutoBackupWrite();
      }
    } catch (err) {
      // Best-effort — see comment above.
    }
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

  // ---------- admin session (per domain) ----------
  //
  // Client side of the admin session primitive (issuer-server/server.js's
  // GET/POST /atlas/admin/session/*, and the equivalent PHP routes) — logs
  // this identity into whichever domain's admin roster it's on, without
  // needing a fresh signature for every admin action afterward. Sessions
  // are cached per domain in chrome.storage.session under
  // atlasAdminSessions ({ [domain]: { token, expiresAt, publicKey } }) —
  // the same storage area, and the same "cleared when the browser session
  // ends" lifetime, atlasUnlockedIdentity above already uses, plus an
  // explicit teardown on lock (see endAllAdminSessions, wired into
  // lockIdentity below) so an admin session never outlives the identity
  // that opened it.
  async function getAdminSessionsMap() {
    const { atlasAdminSessions } = await chrome.storage.session.get('atlasAdminSessions');
    return atlasAdminSessions || {};
  }

  // A cheap, ungated read (GET /atlas/admin/is-admin) — lets a caller
  // decide whether to show an "Admin" entry point for the identity
  // currently active, without spending a real login round trip (a signed
  // nonce, a session token) just to render a button. Fails closed (false)
  // on any error — an unreachable domain or an older issuer without this
  // route should hide the button, not surface a confusing failure.
  async function isAdminForDomain(domain) {
    const identity = await getIdentity();
    if (!identity) return false;
    try {
      const res = await fetch(baseUrl(domain) + '/atlas/admin/is-admin?publicKey=' + encodeURIComponent(identity.publicKey));
      if (!res.ok) return false;
      const body = await res.json();
      return !!body.isAdmin;
    } catch (err) {
      return false;
    }
  }

  // Returns a still-valid cached session for this domain, scoped to
  // whichever identity is active right now — a session cached under a
  // different public key (an identity switch without an intervening lock)
  // is treated as absent rather than handed back, same as one that's
  // simply expired.
  async function getAdminSessionFor(domain) {
    const identity = await getIdentity();
    if (!identity) return null;
    const session = (await getAdminSessionsMap())[domain];
    if (!session || session.publicKey !== identity.publicKey || session.expiresAt <= Date.now()) return null;
    return { token: session.token, expiresAt: session.expiresAt };
  }

  // The real login: GET a single-use nonce, sign it (works for either
  // identity mode — signWithSelf already covers WebAuthn), POST it to
  // /session/start, cache the resulting token. Reuses an already-valid
  // cached session instead of re-logging in on every call, so clicking
  // "Admin" again mid-session doesn't force a fresh signature.
  async function adminLoginForDomain(domain) {
    const cached = await getAdminSessionFor(domain);
    if (cached) return cached;
    const identity = await getIdentity();
    if (!identity) throw new Error('Unlock your wallet first.');
    const nonceRes = await fetch(baseUrl(domain) + '/atlas/admin/session/nonce');
    if (!nonceRes.ok) throw new Error('Could not reach ' + domain + ' to start an admin session.');
    const { nonce } = await nonceRes.json();
    const proof = await signWithSelf({ nonce });
    const startRes = await fetch(baseUrl(domain) + '/atlas/admin/session/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ payload: { nonce }, proof })
    });
    const body = await startRes.json();
    if (!startRes.ok) throw new Error(body.error || 'Admin login was rejected.');
    const sessions = await getAdminSessionsMap();
    sessions[domain] = { token: body.token, expiresAt: body.expiresAt, publicKey: identity.publicKey };
    await chrome.storage.session.set({ atlasAdminSessions: sessions });
    return { token: body.token, expiresAt: body.expiresAt };
  }

  // Explicit single-domain logout — best-effort against the server (an
  // unreachable domain shouldn't block forgetting the token locally) and
  // idempotent (calling it with nothing cached is a harmless no-op).
  async function adminLogoutForDomain(domain) {
    const sessions = await getAdminSessionsMap();
    const session = sessions[domain];
    if (!session) return;
    delete sessions[domain];
    await chrome.storage.session.set({ atlasAdminSessions: sessions });
    try {
      await fetch(baseUrl(domain) + '/atlas/admin/session/logout', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: session.token })
      });
    } catch (err) {
      // best-effort — the token simply expires on its own otherwise
    }
  }

  // Ends every cached admin session at once — what lockIdentity() below
  // calls, so "lock the wallet" really does act like "log out of admin
  // everywhere" rather than leaving a token quietly valid until it expires
  // on its own. Deliberately does NOT await the network calls: locking has
  // to be instant (the quick-lock button in the toolbar promises exactly
  // that), not stalled behind a round trip to every domain this wallet
  // happens to hold an admin session with — each logout is fired and left
  // to land or not, and ADMIN_SESSION_TTL_MS is the backstop either way.
  async function endAllAdminSessions() {
    const sessions = await getAdminSessionsMap();
    for (const domain of Object.keys(sessions)) {
      fetch(baseUrl(domain) + '/atlas/admin/session/logout', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: sessions[domain].token })
      }).catch((err) => {});
    }
    await chrome.storage.session.remove('atlasAdminSessions');
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
    const localKey = await deriveAesKey([password], localSalt, atlasIdentity.kdfIterations || KDF_ITERATIONS_LEGACY);
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
    await logActivity('identity', 'Identity exported to a backup file');
    return {
      format: 'atlas-identity-export/1.0',
      salt: b64urlEncode(exportSalt.buffer),
      iv: b64urlEncode(exportIv.buffer),
      ciphertext: b64urlEncode(ciphertext),
      kdfIterations: KDF_ITERATIONS_CURRENT,
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
    const key = await deriveAesKey([password, normalizeSeedPhrase(seedPhrase)], salt, fileData.kdfIterations || KDF_ITERATIONS_LEGACY);
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
    const importedIdentityBlob = {
      format: 'atlas-identity-local/1.0',
      publicKey,
      salt: b64urlEncode(localSalt.buffer),
      iv: b64urlEncode(localIv.buffer),
      ciphertext: b64urlEncode(localCiphertext),
      kdfIterations: KDF_ITERATIONS_CURRENT,
      createdAt: new Date().toISOString()
    };
    await chrome.storage.local.set({ atlasIdentity: importedIdentityBlob });
    await chrome.storage.session.set({ atlasUnlockedIdentity: { publicKey, privateKeyJwk } });
    await chrome.storage.local.set({ atlasIdentityMode: 'local' });
    // See unlockIdentity's own comment — same reasoning, this is also a
    // moment where a local identity becomes newly active under a known
    // password.
    await cacheAutoBackupSessionKey(password);
    // An imported identity may well be DIFFERENT from whatever this
    // device previously had synced — reconcile handles that mismatch
    // (turns sync backup off rather than silently overwriting) instead of
    // a blind mirror.
    await reconcileIdentitySyncBackupOnIdentityChange(importedIdentityBlob);
    await logActivity('identity', 'Identity imported from a backup file');
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
    await logActivity('identity', 'Passkey identity created');
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

  // Encrypted at rest (2026-09-14, second round) — this is the single
  // most glaring plaintext gap the whole-storage-encryption pass turned
  // up: unlike the real identity (always password/AES-GCM-protected from
  // day one), this demo "other visitor" keypair's own privateKeyJwk sat
  // in plain chrome.storage.local the entire time. It's global rather
  // than per-owner (there's only ever one counterparty, not one per real
  // identity), so it's encrypted under whichever LOCAL identity happens
  // to be active when it's created/touched.
  async function getCounterparty() {
    const { atlasCounterparty } = await chrome.storage.local.get('atlasCounterparty');
    const identity = await getIdentity();
    return decryptAtRestAndMigrate(identity, 'counterparty', atlasCounterparty, null, (v) => saveCounterparty(v));
  }

  async function saveCounterparty(counterparty) {
    const identity = await getIdentity();
    await chrome.storage.local.set({ atlasCounterparty: await encryptAtRest(identity, 'counterparty', counterparty) });
  }

  async function createCounterparty() {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const rawPublic = await crypto.subtle.exportKey('raw', pair.publicKey);
    const privateKeyJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    const counterparty = { publicKey: b64urlEncode(rawPublic), privateKeyJwk, createdAt: new Date().toISOString() };
    await saveCounterparty(counterparty);
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

  // ---------- asset wallet (§5), keyed by owner public key so both
  // identities' held assets can be shown side by side ----------
  //
  // As of the task #44 merge, there is exactly one wallet, one storage
  // shape, and one function set for every asset credential this build
  // handles — unique (asset.fungible: false, quantity always 1, moved
  // whole via §5.2 loadout/transfer) and fungible (quantity any positive
  // integer, splittable/consolidatable/tradeable via §5.4/§5.4.1/§7)
  // alike. This replaces the former, fully parallel item-wallet/
  // resource-wallet pair (getWallet/getResourceWallet, hideItem/
  // hideResource, deleteItem/deleteResource, mintItem/mintResource, plus
  // resource-only split/consolidate and item-only update-notice handling)
  // with ONE store (atlasWallets) and ONE set of functions that branch
  // internally on asset.fungible only where the arithmetic actually
  // differs (splitting, consolidating, auto-merging, loadout/PvP loss).

  // Task #44 was a clean-cut migration — no dual-schema verifier shim, old
  // local wallet data was meant to just stop being relevant. What that
  // missed: the unified store reuses the exact storage key the former
  // ITEM-only wallet used (`atlasWallets`), so a device that used this
  // extension before the merge still has pre-merge item entries sitting
  // right here, and separately still has an entirely orphaned
  // `atlasResourceWallets` key nothing reads anymore. Neither is a valid
  // domain-atlas-asset/1.0 credential — a pre-merge item was signed over a
  // payload with no quantity/fungible/presentation, and a pre-merge
  // resource never had an `asset` wrapper at all — so neither can be
  // carried forward or reissued into the new shape; they just went stale
  // the moment the schema changed. Left in place, they cause exactly the
  // two symptoms this purge fixes: the unified card renderer can't display
  // something missing fields it assumes exist (so old holdings silently
  // vanish from view), while the "already collected this class" courtesy
  // check (alreadyHasRequestableItem in viewer.js) only ever read
  // credential.asset.class — a field pre-merge ITEMS happened to already
  // have — so it kept blocking a fresh request for the same class even
  // though nothing valid was actually being shown. Filtering here, on the
  // one read path everything else already funnels through, means any
  // wallet that predates the merge self-corrects the moment it's touched,
  // no manual reset needed.
  function isPostMergeAssetCredential(entry) {
    return !!(entry && entry.credential && entry.credential.credential === 'domain-atlas-asset/1.0');
  }

  // Encrypted at rest (2026-09-14, second round) — the actual credentials/
  // currency held here are arguably the single most sensitive thing this
  // wallet stores locally besides the private key itself, so this is a
  // high-priority entry in the broader storage-encryption pass. The
  // migration write below is inlined (not routed through saveWallet())
  // on purpose: saveWallet() also fires notifyWalletChanged() for task
  // #137's activity tracking, and a passive read that happens to trigger
  // a one-time plaintext-to-encrypted upgrade (or the pre-existing
  // post-merge cleanup right below it) shouldn't count as wallet
  // "activity" the same way an actual mint/trade/gift does — same
  // reasoning the pre-existing post-merge cleanup already writes directly
  // rather than through saveWallet().
  async function getWallet(ownerPublicKey) {
    const { atlasWallets, atlasResourceWallets } = await chrome.storage.local.get(['atlasWallets', 'atlasResourceWallets']);
    const wallets = atlasWallets || {};
    const identity = await getIdentity();
    const entries = await decryptAtRestAndMigrate(identity, 'wallet', wallets[ownerPublicKey], [], async (v) => {
      wallets[ownerPublicKey] = await encryptAtRest(identity, 'wallet', v);
      await chrome.storage.local.set({ atlasWallets: wallets });
    });
    const cleaned = entries.filter(isPostMergeAssetCredential);
    if (cleaned.length !== entries.length) {
      wallets[ownerPublicKey] = await encryptAtRest(identity, 'wallet', cleaned);
      await chrome.storage.local.set({ atlasWallets: wallets });
    }
    if (atlasResourceWallets) await chrome.storage.local.remove('atlasResourceWallets'); // fully orphaned since the merge — nothing valid to salvage, nothing else reads it
    return cleaned;
  }

  // Task #137's activity-tracking design needs to know "did THIS wallet's
  // holdings just change" without wallet.js knowing anything at all about
  // presence, worlds, or connections — those are viewer.js's concern
  // entirely. saveWallet() is the one choke point essentially every
  // mutation already runs through (mint, split, consolidate, trade
  // settle/claim, PvP-loss, mail-gift claim — 14 call sites as of this
  // writing), so a listener registered here fires for all of them without
  // wallet.js needing a matching call added at each individual UI action.
  // Deliberately fire-and-forget: a listener throwing is caught and
  // dropped rather than allowed to break the save it's just observing.
  const walletChangeListeners = [];
  function onWalletChanged(callback) { walletChangeListeners.push(callback); }
  function notifyWalletChanged(ownerPublicKey) {
    walletChangeListeners.forEach((cb) => { try { cb(ownerPublicKey); } catch (err) { /* an observer's own bug is not this save's problem */ } });
  }

  // The wallet list is rewritten whole by every change. Changes that wait on
  // something in the middle (a verification, a network call) and then write
  // back what they read earlier would undo anything changed in between: an
  // item just claimed, or a spent original just removed. Those changes run
  // one at a time under this lock and re-read the list inside it. Not
  // re-entrant: a function holding it must not call another that takes it.
  let walletWriteChain = Promise.resolve();
  function withWalletLock(fn) {
    if (typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request) {
      return navigator.locks.request('atlas-wallet-list', fn);
    }
    const run = walletWriteChain.then(fn, fn);
    walletWriteChain = run.catch(() => {});
    return run;
  }

  async function saveWallet(ownerPublicKey, entries) {
    const { atlasWallets } = await chrome.storage.local.get('atlasWallets');
    const wallets = atlasWallets || {};
    const identity = await getIdentity();
    wallets[ownerPublicKey] = await encryptAtRest(identity, 'wallet', entries);
    await chrome.storage.local.set({ atlasWallets: wallets });
    notifyWalletChanged(ownerPublicKey);
  }

  // The one issuance entry point for every asset class this build can
  // mint (SPEC.md §5) — `role` picks which local identity receives it
  // ('self' or 'counterparty', same as every other role-taking function
  // below), `quantity` is omitted (or 1) for a non-fungible class and a
  // caller-chosen positive integer for a fungible one. The issuer itself
  // is the real authority on what's required for a given class (see
  // /atlas/asset/issue's own validation) — this is just the one HTTP call
  // and local bookkeeping, not a second copy of that rule.
  async function mintAsset(role, issuerDomain, assetClass, quantity) {
    const owner = await identityOf(role);
    const wallet = await getWallet(owner.publicKey);
    // Task #203 — attached for EVERY fungible mint (cheap, and the server
    // decides whether it actually needs to look at it), so a class the
    // issuer later gives a `holdingCap` doesn't need this wallet build
    // updated again to start cooperating with it. Scoped to credentials
    // this SAME issuer domain actually signed — anything else would just
    // fail verification server-side and be silently ignored anyway (see
    // /atlas/asset/issue's own currentHeldQuantity), so there's no reason
    // to send it. A non-fungible mint never carries this — holdingCap is
    // only ever meaningful for a quantity-based class.
    const existingBalances = quantity !== undefined
      ? wallet.filter((e) => e.credential.asset.class === assetClass && e.credential.issuer.domain === issuerDomain).map((e) => e.credential)
      : undefined;
    const res = await fetch(baseUrl(issuerDomain) + '/atlas/asset/issue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ownerPublicKey: owner.publicKey, assetClass,
        ...(quantity !== undefined ? { quantity } : {}),
        ...(existingBalances && existingBalances.length ? { existingBalances } : {})
      })
    });
    if (!res.ok) throw new Error('Mint failed: ' + (await res.text()));
    const credential = await res.json();
    const verdict = await verifyCredential(credential);
    wallet.push({ credential, lastVerdict: verdict });
    await saveWallet(owner.publicKey, wallet);
    await autoConsolidateAssetWallet(owner.publicKey);
    await logActivity('asset', 'Minted ' + (quantity !== undefined ? quantity + ' ' : '') + assetClass + ' from ' + issuerDomain + (role === 'counterparty' ? ' for the counterparty test identity' : ''));
    return { credential, verdict };
  }

  // Task #203 (SPEC.md §7's "Currency conversion") — converts part or all
  // of a held fungible balance into a DIFFERENT fungible class at the
  // issuing domain's own declared rate (POST /atlas/convert). Mirrors
  // splitAsset()'s own shape below almost exactly — present the balance,
  // name how much to spend, get a result back — except the class changes
  // instead of the owner, so there's no toPublicKey here. Always
  // self-directed (SPEC.md §7's conversion paragraph: the domain itself is
  // always the other side, so there's no counterparty to name), and
  // settles synchronously — the caller gets `received`/`remainder`
  // directly in the response, same as a claimant's own side of a trade
  // settlement, with no mail round-trip needed for either.
  async function convertAsset(role, credential, spendAmount, toClass) {
    const owner = await identityOf(role);
    const res = await fetch(baseUrl(credential.issuer.domain) + '/atlas/convert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential, spendAmount, toClass })
    });
    if (!res.ok) throw new Error('Convert failed: ' + (await res.text()));
    const result = await res.json();
    let wallet = (await getWallet(owner.publicKey)).filter((e) => e.credential.id !== credential.id);
    if (result.remainder) wallet.push({ credential: result.remainder, lastVerdict: await verifyCredential(result.remainder) });
    wallet.push({ credential: result.received, lastVerdict: await verifyCredential(result.received) });
    await saveWallet(owner.publicKey, wallet);
    await autoConsolidateAssetWallet(owner.publicKey);
    await logActivity('asset', 'Converted ' + spendAmount + ' ' + credential.asset.class + ' into ' + toClass + ' at ' + credential.issuer.domain + (role === 'counterparty' ? ' for the counterparty test identity' : ''));
    return result;
  }

  // Museum ticket stall (SPEC.md §5.8) — the first time this module itself,
  // rather than a standalone demo page like cafeteria-demo.html, builds an
  // owner-signed intent envelope: every other primitive above (mint, split,
  // consolidate, convert) only ever has to present a credential, never
  // prove authorization to spend it beyond the class's own tradeScope.
  // Spends part (or all) of a fungible balance to acquire a different
  // class, atomically. Looks the price up fresh via fetchAssetClassInfo()
  // rather than trusting anything the caller passes in — the same
  // "operator decides the price via the catalog, never the caller"
  // discipline POST /atlas/asset/purchase itself already holds to — so a
  // scene's own "purchase" interactable (extension/viewer.js's
  // handleInteractable()) never has to hardcode a price of its own either.
  async function purchaseAsset(role, issuerDomain, purchasedClass, quantity) {
    const owner = await identityOf(role);
    const info = await fetchAssetClassInfo(issuerDomain, purchasedClass);
    if (!info || !info.purchase) throw new Error('This class is not for sale.');
    const qty = quantity === undefined ? 1 : quantity;
    const totalPrice = info.purchase.priceAmount * qty;
    const wallet = await getWallet(owner.publicKey);
    // Same-issuer, same-class, fungible balances only — picks the largest
    // if more than one somehow exists (auto-consolidation normally keeps
    // this to at most one) so a purchase never fails for want of merging
    // balances together first.
    const balanceCredential = wallet
      .map((e) => e.credential)
      .filter((c) => c.asset.class === info.purchase.priceClass && c.issuer.domain === issuerDomain && c.asset.fungible === true)
      .sort((a, b) => b.quantity - a.quantity)[0];
    if (!balanceCredential || balanceCredential.quantity < totalPrice) {
      throw new Error('Not enough ' + info.purchase.priceClass + ' — need ' + totalPrice + ', have ' + (balanceCredential ? balanceCredential.quantity : 0) + '.');
    }
    const payload = { credentialId: balanceCredential.id, purchasedClass, quantity: qty, action: 'purchase' };
    const proof = await signAs(role, payload);
    const res = await fetch(baseUrl(issuerDomain) + '/atlas/asset/purchase', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: balanceCredential, purchasedClass, quantity: qty, intent: { payload, proof } })
    });
    if (!res.ok) throw new Error('Purchase failed: ' + (await res.text()));
    const result = await res.json();
    const newWallet = wallet.filter((e) => e.credential.id !== balanceCredential.id);
    if (result.balance) newWallet.push({ credential: result.balance, lastVerdict: await verifyCredential(result.balance) });
    newWallet.push({ credential: result.purchased, lastVerdict: await verifyCredential(result.purchased) });
    await saveWallet(owner.publicKey, newWallet);
    await autoConsolidateAssetWallet(owner.publicKey);
    await logActivity('asset', 'Purchased ' + qty + ' ' + purchasedClass + ' from ' + issuerDomain + (role === 'counterparty' ? ' for the counterparty test identity' : ''));
    return result;
  }

  // The signed payload shape (SPEC.md §5): canonicalize({id, asset, owner,
  // quantity, supersedes, issuedAt}) — one shape for unique and fungible
  // assets alike, replacing the former separate itemPayloadOf/
  // resourcePayloadOf pair. Every asset credential this build issues or
  // adopts always carries every one of these keys explicitly (quantity: 1
  // and supersedes: null for a first minting of a unique asset), so
  // referencing them directly here is safe.
  function assetPayloadOf(credential) {
    return {
      id: credential.id, asset: credential.asset, owner: credential.owner,
      quantity: credential.quantity, supersedes: credential.supersedes, issuedAt: credential.issuedAt
    };
  }

  // The four checks from SPEC.md §5, steps 1/2/4 — step 3 (fresh WebAuthn
  // assertion) is presentIdentity() below. One verification path for
  // every asset now, replacing verifyCredential/verifyResourceCredential's
  // former near-identical duplication.
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

      const data = new TextEncoder().encode(canonicalize(assetPayloadOf(credential)));
      const publicKey = await crypto.subtle.importKey('raw', b64urlDecode(activeKey.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
      const sigOk = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, b64urlDecode(credential.signature), data);
      if (!sigOk) return { valid: false, reason: 'signature does not match' };

      const revoked = (revDoc.revoked || []).some((r) => r.id === credential.id);
      if (revoked) return { valid: false, reason: 'revoked by issuer' };
      // SPEC.md §5.1's optional signed asset.expiresAt (the museum ticket
      // stall's own worked example) — a second, orthogonal way a credential
      // stops being valid, checked the same way issuer-server/server.js's
      // own isExpired() is: pure arithmetic against the credential's own
      // signed deadline, no extra fetch needed since it already traveled
      // inside `credential.asset` as part of THIS verification's own
      // signature check just above. Absent entirely for a class that never
      // opted in, so this never fires for the vast majority of credentials.
      const expiresAt = credential.asset && credential.asset.expiresAt;
      if (typeof expiresAt === 'string' && Date.now() > new Date(expiresAt).getTime()) {
        return { valid: false, reason: 'expired at ' + expiresAt };
      }
      return { valid: true, reason: 'signature verified against issuer key; not revoked' };
    } catch (err) {
      return { valid: false, reason: 'verification error: ' + err.message };
    }
  }

  // SPEC.md §3.6 — a key-anchored world's manifest carries `identityKey`
  // instead of `domain`, trusted by its own signature rather than by TLS
  // and DNS. Verification is exactly what §3.6 itself describes:
  // canonicalize the manifest with `signature` removed (the same
  // canonicalize() above, reused unchanged per §6.2) and check `signature`
  // against `identityKey`. Deliberately the SAME algorithm and result
  // shape as directory-server/server.js's own verifyKeyAnchoredManifest()
  // — a directory verifies a submission "the same way a browsing client
  // would" (§3.3's own words), so the two must actually match, not just
  // claim to. Returns a plain boolean (not the {valid, reason} shape
  // verifyCredential above uses) since there's no revocation list or
  // issuer-key-validity-window concept for a manifest at all — a manifest
  // signature either checks out or it doesn't.
  async function verifyKeyAnchoredManifest(manifest) {
    if (typeof manifest.signature !== 'string' || !manifest.signature) return false;
    if (typeof manifest.identityKey !== 'string' || !manifest.identityKey) return false;
    const { signature, ...unsigned } = manifest;
    try {
      const publicKey = await crypto.subtle.importKey('raw', b64urlDecode(manifest.identityKey), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
      const data = new TextEncoder().encode(canonicalize(unsigned));
      return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, b64urlDecode(signature), data);
    } catch {
      return false; // malformed key or signature — same outcome as "doesn't verify"
    }
  }

  // Removes an asset from this wallet's LOCAL view only — there's no way
  // to ask the issuer to un-issue a credential, and nothing here pretends
  // to. This is for decluttering (a duplicate, a revoked asset you're done
  // tracking) — the credential itself, wherever else a copy of it exists,
  // is unaffected. Also drops it from the loadout, in case it was loaded.
  async function deleteAsset(ownerPublicKey, credentialId) {
    const before = await getWallet(ownerPublicKey);
    const deleted = before.find((e) => e.credential.id === credentialId);
    const wallet = before.filter((e) => e.credential.id !== credentialId);
    await saveWallet(ownerPublicKey, wallet);
    await unloadItem(credentialId);
    if (deleted) {
      const identity = await getIdentity();
      const who = (identity && identity.publicKey === ownerPublicKey) ? '' : ' (counterparty test identity)';
      await logActivity('asset', 'Deleted ' + deleted.credential.asset.class + ' from wallet' + who);
    }
  }

  // Hiding is the non-destructive counterpart to deleteAsset above: the
  // credential stays in local storage (still exported in backups, still
  // re-verifiable) and only gets an entry.hidden flag that the UI uses to
  // leave it out of the main Inventory list. Unlike delete, this can't
  // lose an asset that has no other copy anywhere — it's always reachable
  // again from Settings -> Hidden assets. Also unloads it, same reasoning
  // as delete: a hidden asset shouldn't stay "loaded into this world"
  // where it's no longer visible.
  async function hideAsset(ownerPublicKey, credentialId) {
    const wallet = await getWallet(ownerPublicKey);
    const entry = wallet.find((e) => e.credential.id === credentialId);
    if (!entry) return;
    entry.hidden = true;
    await saveWallet(ownerPublicKey, wallet);
    await unloadItem(credentialId);
  }

  async function unhideAsset(ownerPublicKey, credentialId) {
    const wallet = await getWallet(ownerPublicKey);
    const entry = wallet.find((e) => e.credential.id === credentialId);
    if (!entry) return;
    delete entry.hidden;
    await saveWallet(ownerPublicKey, wallet);
  }

  // ---------- splitting and consolidating fungible balances (§5.4) ----------
  // Fungible-only — a non-fungible asset's quantity is definitionally 1
  // (SPEC.md §5), so there's nothing for this arithmetic to do to it; the
  // issuer's /atlas/asset/split and /atlas/asset/consolidate endpoints
  // reject a fungible:false credential outright, and these client-side
  // entry points simply surface whatever error that 400 carries rather
  // than duplicating the check here.

  async function splitAsset(role, credential, sendAmount, toRole) {
    const fromOwner = await identityOf(role);
    const toOwner = await identityOf(toRole);
    const res = await fetch(baseUrl(credential.issuer.domain) + '/atlas/asset/split', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential, sendAmount, toPublicKey: toOwner.publicKey })
    });
    if (!res.ok) throw new Error('Split failed: ' + (await res.text()));
    const { sent, remainder } = await res.json();

    let fromWallet = (await getWallet(fromOwner.publicKey)).filter((e) => e.credential.id !== credential.id);
    if (remainder) fromWallet.push({ credential: remainder, lastVerdict: await verifyCredential(remainder) });
    await saveWallet(fromOwner.publicKey, fromWallet);
    if (remainder) await autoConsolidateAssetWallet(fromOwner.publicKey);

    const toWallet = await getWallet(toOwner.publicKey);
    toWallet.push({ credential: sent, lastVerdict: await verifyCredential(sent) });
    await saveWallet(toOwner.publicKey, toWallet);
    await autoConsolidateAssetWallet(toOwner.publicKey);

    let splitLogText;
    if (role === 'self' && toRole === 'self') {
      splitLogText = 'Split ' + sendAmount + ' ' + credential.asset.class + ' within your own wallet';
    } else if (role === 'self') {
      splitLogText = 'Sent ' + sendAmount + ' ' + credential.asset.class + ' to the counterparty test identity';
    } else if (toRole === 'self') {
      splitLogText = 'Received ' + sendAmount + ' ' + credential.asset.class + ' from the counterparty test identity';
    } else {
      splitLogText = 'Split ' + sendAmount + ' ' + credential.asset.class + ' between counterparty test identities';
    }
    await logActivity('asset', splitLogText);
    return { sent, remainder };
  }

  // Merges several balances of the same class AND issuer into one — the
  // inverse of splitAsset. Unlike deleteAsset above, this genuinely
  // changes what's owned (N credentials become 1 with the summed
  // quantity), so it has to go through the issuer: only the issuer's
  // signature can vouch for the new total, the same reason splitAsset's
  // remainder does. See /atlas/asset/consolidate in issuer-server and
  // issuer-php for the other half. This is the low-level primitive both
  // the manual "Consolidate" button (consolidateAsset) and automatic
  // consolidation (autoConsolidateAssetWallet, below) build on.
  async function mergeAssetGroup(ownerPublicKey, credentials) {
    if (!credentials || credentials.length < 2) return null;
    const issuerDomain = credentials[0].issuer.domain;
    const res = await fetch(baseUrl(issuerDomain) + '/atlas/asset/consolidate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credentials })
    });
    if (!res.ok) throw new Error('Consolidate failed: ' + (await res.text()));
    const merged = await res.json();

    const mergedIds = new Set(credentials.map((c) => c.id));
    let wallet = (await getWallet(ownerPublicKey)).filter((e) => !mergedIds.has(e.credential.id));
    wallet.push({ credential: merged, lastVerdict: await verifyCredential(merged) });
    await saveWallet(ownerPublicKey, wallet);
    return merged;
  }

  // Manual entry point — the "Consolidate" button in the UI. Logged here,
  // not inside mergeAssetGroup() above — that shared primitive is also
  // called silently by autoConsolidateAssetWallet's own housekeeping after
  // nearly every asset-gaining action, and that path deliberately stays
  // out of the activity log (see its own comment: "genuinely just
  // housekeeping"). This is the one call site where consolidating is a
  // deliberate action the person actually took.
  async function consolidateAsset(role, credentials) {
    if (!credentials || credentials.length < 2) {
      throw new Error('Pick at least two balances of the same class and issuer to consolidate.');
    }
    const owner = await identityOf(role);
    const merged = await mergeAssetGroup(owner.publicKey, credentials);
    await logActivity('asset', 'Consolidated ' + credentials.length + ' balances of ' + credentials[0].asset.class + ' into one' + (role === 'counterparty' ? ' (counterparty test identity)' : ''));
    return merged;
  }

  // Automatic entry point — called after anything that can leave a wallet
  // holding two or more balances of the same class from the same issuer
  // (minting, a split's remainder/received side, a trade's received side,
  // importing a wallet file), so balances get folded into one as they
  // arise instead of the user having to notice and merge them by hand.
  // Scans the WHOLE wallet, but only ever groups entries whose
  // asset.fungible is true — a non-fungible asset is one-of-a-kind by
  // definition (SPEC.md §5), so grouping two credentials of the same class
  // would silently destroy the very thing that makes each one unique.
  // Within that fungible subset, class + issuer domain is still what has
  // to match for balances to be mergeable, same as before this merge. A
  // failed merge here is swallowed rather than thrown: it would otherwise
  // turn "the mint/split/trade itself succeeded" into a visible error over
  // what's genuinely just housekeeping on top of it; the balances are left
  // separate and still individually valid, and the manual "Consolidate"
  // button remains available to retry.
  async function autoConsolidateAssetWallet(ownerPublicKey) {
    const wallet = await getWallet(ownerPublicKey);
    const groups = new Map();
    for (const entry of wallet) {
      if (!entry.credential.asset.fungible) continue;
      const key = entry.credential.asset.class + '::' + entry.credential.issuer.domain;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry.credential);
    }
    for (const group of groups.values()) {
      if (group.length > 1) {
        try {
          await mergeAssetGroup(ownerPublicKey, group);
        } catch (err) {
          // Leave this group as separate, individually-valid balances.
        }
      }
    }
  }

  // ---------- loadout (§5.2) ----------

  // Encrypted + per-identity (2026-09-14, second round) — same migration
  // shape as Friends above. setLoadout() silently no-ops with no active
  // identity (nothing to scope it to), same "can't do this without an
  // identity" posture as the rest of this batch.
  async function getLoadout() {
    const identity = await getIdentity();
    const { atlasLoadout } = await chrome.storage.local.get('atlasLoadout');
    if (Array.isArray(atlasLoadout)) {
      if (!identity) return [];
      await setLoadout(atlasLoadout);
      return atlasLoadout;
    }
    if (!identity) return [];
    return decryptAtRestAndMigrate(identity, 'loadout', (atlasLoadout || {})[identity.publicKey], [], (v) => setLoadout(v));
  }

  async function setLoadout(ids) {
    const identity = await getIdentity();
    if (!identity) return;
    const { atlasLoadout } = await chrome.storage.local.get('atlasLoadout');
    const all = (atlasLoadout && !Array.isArray(atlasLoadout)) ? atlasLoadout : {};
    all[identity.publicKey] = await encryptAtRest(identity, 'loadout', ids);
    await chrome.storage.local.set({ atlasLoadout: all });
  }

  async function loadItem(itemId) {
    const loadout = await getLoadout();
    if (!loadout.includes(itemId)) loadout.push(itemId);
    await setLoadout(loadout);
  }

  async function unloadItem(itemId) {
    await setLoadout((await getLoadout()).filter((id) => id !== itemId));
  }

  // ---------- avatar look (equipped appearance) ----------
  //
  // Which owned asset, if any, currently supplies this identity's rendered
  // character colors — a persisted preference, not a signed claim of its
  // own: nothing prevents a client from ignoring it or a hostile client
  // from broadcasting a false one, the same trust level presence's own
  // position/yaw already has (SPEC.md §10 — presence is explicitly outside
  // this protocol's scope). What IS real is that only an asset actually
  // owned in this wallet can ever be equipped in the first place: the
  // getter re-resolves against the CURRENT wallet every time rather than
  // caching resolved colors, so a revoked or deleted credential silently
  // falls back to the default look instead of leaving a stale one behind.
  // Kept per-identity and encrypted at rest, same shape as favoriteDomains/
  // aliases above, since switching identity should switch (or clear)
  // whose look this is — unlike characterScale, this isn't a device-wide
  // display setting.
  async function saveAvatarLook(ownerPublicKey, assetId) {
    const { atlasAvatarLook } = await chrome.storage.local.get('atlasAvatarLook');
    const all = atlasAvatarLook || {};
    const identity = await getIdentity();
    all[ownerPublicKey] = await encryptAtRest(identity, 'avatarLook', assetId);
    await chrome.storage.local.set({ atlasAvatarLook: all });
  }

  async function getAvatarLookAssetId() {
    const identity = await getIdentity();
    if (!identity) return null;
    const { atlasAvatarLook } = await chrome.storage.local.get('atlasAvatarLook');
    return decryptAtRestAndMigrate(identity, 'avatarLook', (atlasAvatarLook || {})[identity.publicKey], null, (v) => saveAvatarLook(identity.publicKey, v));
  }

  async function setAvatarLook(assetId) {
    const identity = await getIdentity();
    if (!identity) throw new Error('Unlock your wallet first.');
    await saveAvatarLook(identity.publicKey, assetId || null);
    return assetId || null;
  }

  // Pure — pulls the two atlas.avatar.* keys straight off an asset's own
  // properties bag (see issuer-server/server.js's ASSET_CATALOG for the
  // avatar-outfit classes that set them). Returns null when neither is
  // present, so a card-menu action can check "does this asset even have a
  // look to equip" without needing this identity's wallet or storage at
  // all. atlas.* rather than com.example.* deliberately — see the catalog
  // comment on why a client actually has to understand these two keys,
  // not just display them.
  function avatarLookPropertiesFromAsset(asset) {
    const props = (asset && asset.properties) || {};
    const shirtColor = props['atlas.avatar.shirtColor'] || null;
    const pantsColor = props['atlas.avatar.pantsColor'] || null;
    return (shirtColor || pantsColor) ? { shirtColor, pantsColor } : null;
  }

  async function getAvatarLook() {
    const identity = await getIdentity();
    if (!identity) return null;
    const assetId = await getAvatarLookAssetId();
    if (!assetId) return null;
    const wallet = await getWallet(identity.publicKey);
    const entry = wallet.find((e) => e.credential.id === assetId);
    return entry ? avatarLookPropertiesFromAsset(entry.credential.asset) : null; // no longer owned — graceful fallback to the default look
  }

  // ---------- avatar hat (equipped appearance, separate slot) ----------
  //
  // Same trust level, storage shape, and revoked-credential fallback as
  // avatar look above — a hat is just a second independent equip slot, not
  // a variant of the first. Kept in its own storage key (atlasAvatarHat
  // rather than atlasAvatarLook) so equipping a hat never touches, and
  // never gets touched by, whatever outfit is equipped: a visitor can wear
  // both, either, or neither at once.
  async function saveAvatarHat(ownerPublicKey, assetId) {
    const { atlasAvatarHat } = await chrome.storage.local.get('atlasAvatarHat');
    const all = atlasAvatarHat || {};
    const identity = await getIdentity();
    all[ownerPublicKey] = await encryptAtRest(identity, 'avatarHat', assetId);
    await chrome.storage.local.set({ atlasAvatarHat: all });
  }

  async function getAvatarHatAssetId() {
    const identity = await getIdentity();
    if (!identity) return null;
    const { atlasAvatarHat } = await chrome.storage.local.get('atlasAvatarHat');
    return decryptAtRestAndMigrate(identity, 'avatarHat', (atlasAvatarHat || {})[identity.publicKey], null, (v) => saveAvatarHat(identity.publicKey, v));
  }

  async function setAvatarHat(assetId) {
    const identity = await getIdentity();
    if (!identity) throw new Error('Unlock your wallet first.');
    await saveAvatarHat(identity.publicKey, assetId || null);
    return assetId || null;
  }

  // Pure — mirrors avatarShoePropertiesFromAsset() below: a hat can now
  // carry more than color (a randomized-per-mint walk/run speed, jump
  // height, and interact/pickup range buff — see the hat catalog entries'
  // own randomizeProperties), so this returns the same kind of object shape
  // rather than a bare hex string. Multipliers default to 1 (no change)
  // when an asset doesn't define them, so an ordinary hat with no buffs
  // still behaves exactly like a plain color-only one.
  function avatarHatPropertiesFromAsset(asset) {
    const props = (asset && asset.properties) || {};
    const hatColor = props['atlas.avatar.hatColor'] || null;
    if (!hatColor) return null;
    return {
      hatColor,
      speedMultiplier: Number(props['atlas.avatar.hatSpeedMultiplier']) || 1,
      jumpMultiplier: Number(props['atlas.avatar.hatJumpMultiplier']) || 1,
      interactRangeMultiplier: Number(props['atlas.avatar.hatInteractRangeMultiplier']) || 1
    };
  }

  async function getAvatarHat() {
    const identity = await getIdentity();
    if (!identity) return null;
    const assetId = await getAvatarHatAssetId();
    if (!assetId) return null;
    const wallet = await getWallet(identity.publicKey);
    const entry = wallet.find((e) => e.credential.id === assetId);
    return entry ? avatarHatPropertiesFromAsset(entry.credential.asset) : null; // no longer owned — graceful fallback to no hat
  }

  // ---------- avatar shoes (equipped appearance, third independent slot) ----------
  //
  // Same trust level, storage shape, and revoked-credential fallback as
  // avatar look/avatar hat above — a third equip slot, kept in its own
  // storage key (atlasAvatarShoes) so it never touches, and is never
  // touched by, whatever outfit or hat is equipped.
  async function saveAvatarShoes(ownerPublicKey, assetId) {
    const { atlasAvatarShoes } = await chrome.storage.local.get('atlasAvatarShoes');
    const all = atlasAvatarShoes || {};
    const identity = await getIdentity();
    all[ownerPublicKey] = await encryptAtRest(identity, 'avatarShoes', assetId);
    await chrome.storage.local.set({ atlasAvatarShoes: all });
  }

  async function getAvatarShoesAssetId() {
    const identity = await getIdentity();
    if (!identity) return null;
    const { atlasAvatarShoes } = await chrome.storage.local.get('atlasAvatarShoes');
    return decryptAtRestAndMigrate(identity, 'avatarShoes', (atlasAvatarShoes || {})[identity.publicKey], null, (v) => saveAvatarShoes(identity.publicKey, v));
  }

  async function setAvatarShoes(assetId) {
    const identity = await getIdentity();
    if (!identity) throw new Error('Unlock your wallet first.');
    await saveAvatarShoes(identity.publicKey, assetId || null);
    return assetId || null;
  }

  // Pure — same object-shape reasoning as avatarHatPropertiesFromAsset()
  // above, one field wider: a shoe also carries a visual height scale
  // alongside its own walk/run speed and jump-height buffs, which a hat
  // doesn't. Multipliers/scale default to 1 (no change) when an asset
  // doesn't define them, so an ordinary shoe with no buffs still behaves
  // exactly like a plain color-only one.
  function avatarShoePropertiesFromAsset(asset) {
    const props = (asset && asset.properties) || {};
    const shoeColor = props['atlas.avatar.shoeColor'] || null;
    if (!shoeColor) return null;
    return {
      shoeColor,
      speedMultiplier: Number(props['atlas.avatar.shoeSpeedMultiplier']) || 1,
      jumpMultiplier: Number(props['atlas.avatar.shoeJumpMultiplier']) || 1,
      visualScale: Number(props['atlas.avatar.shoeVisualScale']) || 1
    };
  }

  async function getAvatarShoes() {
    const identity = await getIdentity();
    if (!identity) return null;
    const assetId = await getAvatarShoesAssetId();
    if (!assetId) return null;
    const wallet = await getWallet(identity.publicKey);
    const entry = wallet.find((e) => e.credential.id === assetId);
    return entry ? avatarShoePropertiesFromAsset(entry.credential.asset) : null; // no longer owned — graceful fallback to no shoes
  }

  // ---------- dropping items into a scene (shared — task #250) ----------
  //
  // Until now this was local-only, self-only: nothing about ownership ever
  // moved, a dropped item just sat flagged in this same wallet, reclaimable
  // only by whoever dropped it. That comment used to live here (see git
  // history) and explained why: "others can see it and pick it up" needs a
  // world to actually host and mutate shared state, and a real answer for
  // what happens when two people reach for it at once. Both now exist —
  // the world's own domain server durably hosts the drop (WORLD_DROPS_FILE,
  // issuer-server/server.js) and settles a claim by REMOVING the listing
  // before minting anything, so whichever concurrent claim wins the removal
  // wins the item — see that file's own comment on POST
  // /atlas/world/drops/claim for the exact mechanism.
  //
  // A dropped item genuinely leaves this wallet's local storage the moment
  // it's dropped (below) — it's not secretly still "mine," it's sitting in
  // the world for anyone, including the original dropper, to claim. Picking
  // it back up (pickUpItem) always mints a fresh replacement credential via
  // the issuer, the exact same way a stranger claiming it would; there's no
  // special "this was always still mine" shortcut.
  //
  // Cross-domain-issued items are fully supported: the world's own domain
  // hosts the listing regardless of who minted the credential, and relays
  // a claim to the actual issuer (POST /atlas/world/drops/relay-claim) when
  // it isn't the one hosting the drop — only the issuer can legitimately
  // re-sign its own credential to a new owner. See SPEC.md §5.5.

  // Carves exactly `amount` off a fungible balance into its own fresh
  // credential, for viewer.js to hand straight to dropItem() below — NOT
  // the same call as the existing splitAsset(), and deliberately so: a
  // drop is always a self-to-self split (the wallet owner keeps the
  // remainder, the SAME owner is also the nominal "recipient" of the
  // carved-off piece, right up until it's dropped a moment later), and
  // splitAsset()'s own autoConsolidateAssetWallet(toOwner) call would see
  // both halves sitting in that one wallet and immediately merge them back
  // into a single credential — quietly undoing the split before dropItem
  // ever got to use it. So this helper only ever saves the REMAINDER back
  // into the wallet; the carved-off piece is returned straight to the
  // caller and never touches local storage at all (dropItem() would just
  // have to strip it back out again anyway, same as it does for a whole,
  // unsplit credential).
  async function splitForDrop(credential, amount) {
    const identity = await getIdentity();
    const res = await fetch(baseUrl(credential.issuer.domain) + '/atlas/asset/split', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential, sendAmount: amount, toPublicKey: identity.publicKey })
    });
    if (!res.ok) throw new Error('Split failed: ' + (await res.text()));
    const { sent, remainder } = await res.json();
    let wallet = (await getWallet(identity.publicKey)).filter((e) => e.credential.id !== credential.id);
    if (remainder) wallet.push({ credential: remainder, lastVerdict: await verifyCredential(remainder) });
    await saveWallet(identity.publicKey, wallet);
    if (remainder) await autoConsolidateAssetWallet(identity.publicKey);
    return sent;
  }

  // `credential` is the FULL signed credential being dropped (server needs
  // the whole thing to verify + store for other visitors to render);
  // `worldDomain` is whichever domain's world this is happening in — NOT
  // necessarily credential.issuer.domain, e.g. a wearable minted by one
  // domain, carried into and dropped in a different domain's plaza.
  // `position` is renderer-native coordinates, same convention as before
  // (a clicked ground point for the 2D renderer, or a placeholder for 3D —
  // see viewer.js's beginDropPlacement).
  async function dropItem(credential, worldDomain, world, position) {
    const payload = { action: 'drop', credentialId: credential.id, world, droppedAt: new Date().toISOString() };
    const proof = await signWithSelf(payload);
    const res = await fetch(baseUrl(worldDomain) + '/atlas/world/drop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential, world, position, intent: { payload, proof } })
    });
    if (!res.ok) throw new Error('Drop failed: ' + (await res.text()));
    const result = await res.json(); // { status, dropId }

    const identity = await getIdentity();
    const wallet = (await getWallet(identity.publicKey)).filter((e) => e.credential.id !== credential.id);
    await saveWallet(identity.publicKey, wallet);
    // Visually it's no longer "carried" once it's sitting in the scene —
    // keep the loadout list honest, same as hiding an item already does.
    await unloadItem(credential.id);
    await logActivity('asset', 'Dropped ' + credential.asset.class + ' in ' + worldDomain + '/' + world);
    return result;
  }

  // Every current drop in `world`, from every visitor who's ever dropped
  // something there and not yet had it claimed — this is genuinely shared,
  // public data (see the endpoint's own "read is open" comment), not
  // filtered to this wallet's own. viewer.js is responsible for labeling
  // which rows are "yours" (droppedBy === this identity's own public key).
  async function getWorldDrops(worldDomain, world) {
    const res = await fetch(baseUrl(worldDomain) + '/atlas/world/drops?world=' + encodeURIComponent(world));
    if (!res.ok) throw new Error('Fetching drops failed: ' + (await res.text()));
    const { drops } = await res.json();
    return drops; // [{dropId, world, position, credential, droppedBy, droppedAt}]
  }

  // Claims (picks up) one drop by id — works identically whether it's a
  // stranger's item or the caller's own earlier drop; the server doesn't
  // (and shouldn't) treat "reclaiming your own" as a special case, see
  // fulfillWorldDropClaim()'s own comment server-side. Always yields a
  // freshly-minted credential, added to this wallet like any other mint.
  async function pickUpItem(worldDomain, dropId) {
    const payload = { action: 'claim', dropId, claimedAt: new Date().toISOString() };
    const proof = await signWithSelf(payload);
    const res = await fetch(baseUrl(worldDomain) + '/atlas/world/drops/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dropId, intent: { payload, proof } })
    });
    if (!res.ok) throw new Error('Pick up failed: ' + (await res.text()));
    const { credential } = await res.json();

    const identity = await getIdentity();
    const wallet = await getWallet(identity.publicKey);
    wallet.push({ credential, lastVerdict: await verifyCredential(credential) });
    await saveWallet(identity.publicKey, wallet);
    await autoConsolidateAssetWallet(identity.publicKey);
    await logActivity('asset', 'Picked up ' + credential.asset.class + ' in ' + worldDomain);
    return credential;
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
    await logActivity('asset', 'Lost ' + itemCredential.asset.class + ' to the counterparty test identity (PvP demo)');
    return transfer;
  }

  // ---------- trading stations (§7 client half) ----------

  // v1.15 (SPEC.md §7) — counterpartyPublicKey is optional: an open listing
  // posted via Sell names none at all, while a claim names the poster. The
  // key must be OMITTED from payload entirely when there's no counterparty,
  // not merely set to undefined: canonicalize() below signs whatever keys
  // Object.keys() finds, undefined-valued or not, but JSON.stringify (used
  // to actually put this payload on the wire) silently drops
  // undefined-valued keys — so a payload literal `{ counterparty: undefined,
  // ... }` would get signed as if the key were present, then arrive at the
  // server without it, and fail verify_envelope's own canonicalize() check
  // the moment it's re-signed server-side against what actually arrived.
  async function proposeIntent(role, offer, want, counterpartyPublicKey, expiresMinutes) {
    const payload = {
      offer, want,
      ...(counterpartyPublicKey !== undefined ? { counterparty: counterpartyPublicKey } : {}),
      expiresAt: new Date(Date.now() + (expiresMinutes || 10) * 60000).toISOString()
    };
    const proof = await signAs(role, payload);
    return { payload, proof };
  }

  // Task #144 Phase 1 / v1.14 open listings (SPEC.md §7) — posts this
  // signer's own half of a trade to the station as an open listing, naming
  // no counterparty at all. Mirrors mintAsset()'s "one HTTP call plus local
  // bookkeeping" role, not a second copy of the station's own logic. Always
  // queues — posting a listing never settles it on the spot (see the
  // endpoint's own comment for why that changed in v1.14); recorded locally
  // (getSubmittedTrades/saveSubmittedTrades below) purely for this wallet's
  // own Listings sub-tab display, with reconcileSubmittedTrades (see
  // checkAllMail below) noticing later once it's claimed.
  async function submitTradeIntent(issuerDomain, membership, offer, want, balance, expiresMinutes) {
    const intent = await proposeIntent('self', offer, want, undefined, expiresMinutes);
    const res = await fetch(baseUrl(issuerDomain) + '/atlas/trade/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ membership, intent, balance })
    });
    if (!res.ok) throw new Error('Trade submit failed: ' + (await res.text()));
    const result = await res.json();
    const owner = await getIdentity();

    const records = await getSubmittedTrades(owner.publicKey);
    records.push({
      pendingId: result.pendingId,
      domain: issuerDomain,
      offer, want,
      balanceId: balance.id,
      submittedAt: new Date().toISOString(),
      expiresAt: result.expiresAt,
      status: 'pending'
    });
    await saveSubmittedTrades(owner.publicKey, records);
    await logActivity('trade', 'Listed a trade at ' + issuerDomain + ': ' + offer.quantity + ' ' + offer.class + ' for ' + want.quantity + ' ' + want.class);
    return result;
  }

  // v1.14 (SPEC.md §7) — browse a station's own open, unexpired listings.
  // Read-only, no membership presented (the endpoint itself is ungated —
  // see its own comment), so this is a plain GET with no local bookkeeping
  // at all: nothing here is "this wallet's own," it's every member's.
  async function fetchTradeListings(issuerDomain) {
    const res = await fetch(baseUrl(issuerDomain) + '/atlas/trade/listings');
    if (!res.ok) throw new Error('Fetching listings failed: ' + (await res.text()));
    const { listings } = await res.json();
    return listings;
  }

  // Task #202 (SPEC.md §7) — catalog discovery: this domain's own tradable
  // fungible classes, for populating the Sell tab's "You want" dropdown
  // live instead of a hardcoded list (see viewer.js's
  // refreshTradingSellOfferOptions comment on why that list was static
  // until now). Read-only, ungated, same shape as fetchTradeListings just
  // above — nothing here is "this wallet's own," it's every visitor's view
  // of what the domain is willing to mint.
  async function fetchTradableClasses(issuerDomain) {
    const res = await fetch(baseUrl(issuerDomain) + '/atlas/trade/catalog');
    if (!res.ok) throw new Error('Fetching tradable classes failed: ' + (await res.text()));
    const { classes } = await res.json();
    return classes;
  }

  // Domain calendar (SPEC.md §12) — a plain, unsigned, ungated read of a
  // domain's or one of its worlds' published calendar, same "nothing here
  // is this wallet's own" shape as fetchTradeListings/fetchTradableClasses
  // just above. Deliberately a DIFFERENT function from getCalendarEvents/
  // addCalendarEvent/updateCalendarEvent/removeCalendarEvent below, which
  // are this wallet's own LOCAL reminders ("My Calendar") and never touch
  // the network at all — this one is what viewer.js's "CurrentDomainName"
  // and "Remote" calendar sub-tabs call instead, for a calendar that lives
  // on someone else's server. `worldId` omitted or null fetches the
  // domain-wide calendar (manifest-level `calendar: true`, §3); naming a
  // world fetches that world's own. Returns `{domain, worldId, events}`
  // straight off the wire — an empty `events` array just means this
  // domain/world hasn't published anything there (§12.1), not an error,
  // so the caller decides how to render that rather than this function
  // guessing.
  async function fetchDomainCalendar(issuerDomain, worldId) {
    const query = worldId ? ('?world=' + encodeURIComponent(worldId)) : '';
    const res = await fetch(baseUrl(issuerDomain) + '/atlas/calendar' + query);
    if (!res.ok) throw new Error('Fetching calendar failed: ' + (await res.text()));
    return res.json();
  }

  // Fetches a domain's own manifest (SPEC.md §3) by bare domain string,
  // rather than an already-known full manifest URL — what the "Remote"
  // calendar tab (viewer.js) uses to discover which of a REMOTE domain's
  // worlds separately opted into a calendar (computeCalendarSources)
  // before fetching any of them, the exact same discovery step actually
  // entering that domain already does with its own manifest fetch. No
  // caching, no signing needed — a manifest has never had either (§3:
  // "cacheable, publicly readable" is a CDN/client-cache hint, not a trust
  // mechanism; the trust boundary is TLS/DNS, same as fetchDomainCalendar
  // just above).
  async function fetchDomainManifest(domain) {
    const res = await fetch(baseUrl(domain) + '/.well-known/spatial.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('Fetching manifest failed: ' + (await res.text()));
    return res.json();
  }

  // Task #213 (SPEC.md §5.1.2 "Class discovery") — look up ANY class this
  // domain defines, whether or not this wallet has ever held one: the
  // server-side lookup a hover preview needs for a scene's still-unopened
  // crate or stall, whose scene.json interactable/itemMarker only ever
  // carries the bare `class` string, never a display name/model/
  // properties. Unlike fetchTradableClasses just above, this covers every
  // class the issuer defines — fungible or not, any tradeScope — because a
  // class doesn't need to be tradable, or fungible, to be worth previewing
  // before it's held (see the endpoint's own SPEC.md comment for why this
  // is a separate read rather than folded into the trading catalog).
  //
  // Memoized per (domain, class) for the lifetime of this page: a class
  // definition is effectively static once minted, and a hover handler
  // firing on every mousemove would otherwise refetch the same class
  // dozens of times a second. Resolves to `null` for a class this domain
  // doesn't define (the endpoint's 404) — also cached, so hovering a
  // broken/typo'd scene.json entry repeatedly doesn't keep hammering the
  // issuer for an answer that will never change. A real fetch failure
  // (network error, 5xx) is deliberately NOT cached — evicted as soon as
  // it happens — so the next hover gets a fresh attempt instead of
  // permanently repeating whatever transient error just occurred. Not
  // persisted to chrome.storage: this is a same-page-session convenience,
  // not wallet state, and losing it on reload/navigation is fine.
  const assetClassInfoCache = new Map(); // 'domain\u0000class' -> Promise<info|null>
  async function fetchAssetClassInfo(issuerDomain, cls) {
    const key = issuerDomain + '\u0000' + cls;
    if (assetClassInfoCache.has(key)) return assetClassInfoCache.get(key);
    const promise = (async () => {
      const res = await fetch(baseUrl(issuerDomain) + '/atlas/asset/class?class=' + encodeURIComponent(cls));
      if (res.status === 404) return null;
      if (!res.ok) throw new Error('Fetching asset class info failed: ' + (await res.text()));
      return res.json();
    })();
    assetClassInfoCache.set(key, promise);
    promise.catch(() => assetClassInfoCache.delete(key));
    return promise;
  }

  // v1.14 (SPEC.md §7) — fulfill one specific open listing. Builds this
  // signer's own mirrored intent (offer = listing.want, want = listing.offer)
  // naming the poster as counterparty for the signed record's own sake, and
  // presents it against the listing's id. The claimant is always live for
  // this call, so their own remainder/received apply directly, right here,
  // the moment the claim succeeds.
  async function claimTradeListing(issuerDomain, membership, listing, balance, expiresMinutes) {
    const intent = await proposeIntent('self', listing.want, listing.offer, listing.posterPublicKey, expiresMinutes);
    const res = await fetch(baseUrl(issuerDomain) + '/atlas/trade/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pendingId: listing.pendingId, membership, intent, balance })
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      // A failed claim can still have spent `balance` server-side (the
      // OTHER leg of the trade settled first, then the poster's own leg
      // failed) — see /atlas/trade/claim's own comment on the refund it
      // attempts in exactly that case. Adopt it the same way a
      // successful claim's own received/remainder would be, so `balance`
      // isn't left behind as a silent ghost the next mail/check cycle
      // discovers already revoked, with nothing in its place.
      if (errBody.refund) {
        const owner = await getIdentity();
        const wallet = (await getWallet(owner.publicKey)).filter((e) => e.credential.id !== balance.id);
        wallet.push({ credential: errBody.refund, lastVerdict: await verifyCredential(errBody.refund) });
        await saveWallet(owner.publicKey, wallet);
        await autoConsolidateAssetWallet(owner.publicKey);
        await logActivity('trade', 'Trade at ' + issuerDomain + ' failed partway through and was refunded: kept ' + listing.want.quantity + ' ' + listing.want.class);
      }
      throw new Error('Claim failed: ' + (errBody.error || ('HTTP ' + res.status)));
    }
    const result = await res.json();
    const owner = await getIdentity();

    let wallet = (await getWallet(owner.publicKey)).filter((e) => e.credential.id !== balance.id);
    if (result.remainder) wallet.push({ credential: result.remainder, lastVerdict: await verifyCredential(result.remainder) });
    wallet.push({ credential: result.received, lastVerdict: await verifyCredential(result.received) });
    await saveWallet(owner.publicKey, wallet);
    await autoConsolidateAssetWallet(owner.publicKey);
    await logActivity('trade', 'Claimed a trade at ' + issuerDomain + ': received ' + listing.offer.quantity + ' ' + listing.offer.class + ' for ' + listing.want.quantity + ' ' + listing.want.class);
    return result;
  }

  // v1.14 (SPEC.md §7) — withdraw one of this signer's own still-open
  // listings. The signed payload is deliberately minimal — just enough to
  // prove "I, holder of this key, want this specific listing gone" — the
  // same "small signed statement, not a full credential" shape a mail
  // gift-claim's own proof already uses elsewhere in this file. Updates the
  // local record to 'canceled' on success so the Listings tab stops
  // showing it as open without needing a fresh mail check to notice.
  async function cancelTradeListing(issuerDomain, pendingId) {
    const payload = { pendingId, action: 'cancel' };
    const proof = await signAs('self', payload);
    const res = await fetch(baseUrl(issuerDomain) + '/atlas/trade/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pendingId, intent: { payload, proof } })
    });
    if (!res.ok) throw new Error('Cancel failed: ' + (await res.text()));
    const result = await res.json();
    const owner = await getIdentity();
    const records = await getSubmittedTrades(owner.publicKey);
    const record = records.find((r) => r.pendingId === pendingId);
    if (record) {
      record.status = 'canceled';
      record.canceledAt = new Date().toISOString();
      await saveSubmittedTrades(owner.publicKey, records);
      await logActivity('trade', 'Cancelled a trade listing at ' + issuerDomain + ': ' + record.offer.quantity + ' ' + record.offer.class + ' for ' + record.want.quantity + ' ' + record.want.class);
    }
    return result;
  }

  // Local-only record of this identity's own submitted remote trade
  // intents (task #144 Phase 1), purely for the wallet's Trade tab display
  // — same "not signed, not sent anywhere, this device's own bookkeeping"
  // shape as the alias store below. `status` starts 'pending' and is only
  // ever flipped locally, either immediately (submitTradeIntent above, when
  // the station settles it on the spot) or later (reconcileSubmittedTrades
  // below, once a mail check notices the balance it staked got superseded
  // or revoked out from under it — the sign a match happened while this
  // wallet wasn't looking). Expiry itself isn't a stored status — the UI
  // compares `expiresAt` to now at render time, same "computed, not
  // persisted" approach as everywhere else a timestamp alone is enough.
  // Encrypted at rest (2026-09-14, second round).
  async function getSubmittedTrades(ownerPublicKey) {
    const { atlasSubmittedTrades } = await chrome.storage.local.get('atlasSubmittedTrades');
    const identity = await getIdentity();
    return decryptAtRestAndMigrate(identity, 'submittedTrades', (atlasSubmittedTrades || {})[ownerPublicKey], [], (v) => saveSubmittedTrades(ownerPublicKey, v));
  }

  async function saveSubmittedTrades(ownerPublicKey, records) {
    const { atlasSubmittedTrades } = await chrome.storage.local.get('atlasSubmittedTrades');
    const all = atlasSubmittedTrades || {};
    const identity = await getIdentity();
    all[ownerPublicKey] = await encryptAtRest(identity, 'submittedTrades', records);
    await chrome.storage.local.set({ atlasSubmittedTrades: all });
  }

  // Removes one submitted-trade record from this wallet's own local
  // bookkeeping (the Listings tab's own Delete button, for a settled or
  // expired card — there's nothing left to withdraw from either, so this
  // is purely local housekeeping, unlike cancelTradeListing above which
  // still has to tell the server to drop a live listing).
  async function deleteSubmittedTrade(ownerPublicKey, pendingId) {
    const records = await getSubmittedTrades(ownerPublicKey);
    await saveSubmittedTrades(ownerPublicKey, records.filter((r) => r.pendingId !== pendingId));
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

  // In-world chat's own profanity check — same blocklist and leetspeak
  // substitutions as the alias filter above, but NOT the same normalizer:
  // normalizeForAliasFilter strips every non-alphanumeric character
  // (spaces included), which is fine for a short single handle but
  // actively dangerous for a multi-word sentence — "...my ass holds..."
  // would concatenate into a false "asshole" hit once the space between
  // the two words disappears. This version normalizes punctuation to
  // SPACES instead of nothing, preserving every original word boundary,
  // so two innocent adjacent words can never concatenate into a blocked
  // one. Matching is still plain substring (not whole-word-only) against
  // that space-preserved text — a whole-word-only match would let common
  // inflections straight through ("fucking", "shitty", "asses" would all
  // dodge a blocklist entry for "fuck"/"shit"/"ass"), and this project's
  // own stated policy for the alias filter above is the same: erring
  // toward over-blocking is the safer trade-off, a false rejection just
  // means rephrasing. This is the CLIENT-SIDE check (immediate feedback
  // before a send even goes out) — presence-server's own copy of this
  // same logic is the authoritative one, since a client could always be
  // modified to skip this and talk raw WebSocket.
  function normalizeForChatFilter(text) {
    return (text || '')
      .toLowerCase()
      .replace(/0/g, 'o').replace(/1/g, 'i').replace(/!/g, 'i')
      .replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's')
      .replace(/@/g, 'a').replace(/\$/g, 's')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function chatMessageContainsBlockedWord(text) {
    const normalized = normalizeForChatFilter(text);
    if (!normalized) return false;
    return ALIAS_BLOCKLIST.some((word) => normalized.includes(word));
  }

  // Encrypted + per-identity (2026-09-14, second round). Aliases' own
  // pre-migration shape is already a flat OBJECT (publicKey -> alias
  // string), same JS type as the new per-owner map, so telling old from
  // new needs its own check rather than Friends/Groups' simple
  // Array.isArray: a legacy map's own values are bare strings; the new
  // shape's per-owner slots are always objects (an encrypted envelope, or
  // — in an edge case this code never actually produces itself — a plain
  // nested alias map), never a string directly.
  function isLegacyFlatAliases(raw) {
    return !!(raw && typeof raw === 'object' && Object.values(raw).some((v) => typeof v === 'string'));
  }

  async function getAliasesForOwner(identity) {
    const { atlasAliases } = await chrome.storage.local.get('atlasAliases');
    if (isLegacyFlatAliases(atlasAliases)) {
      if (!identity) return {};
      await saveAliasesForOwner(identity.publicKey, atlasAliases);
      return atlasAliases;
    }
    if (!identity) return {};
    return decryptAtRestAndMigrate(identity, 'aliases', (atlasAliases || {})[identity.publicKey], {}, (v) => saveAliasesForOwner(identity.publicKey, v));
  }

  async function saveAliasesForOwner(ownerPublicKey, aliasesForOwner) {
    const { atlasAliases } = await chrome.storage.local.get('atlasAliases');
    const all = isLegacyFlatAliases(atlasAliases) ? {} : (atlasAliases || {});
    const identity = await getIdentity();
    all[ownerPublicKey] = await encryptAtRest(identity, 'aliases', aliasesForOwner);
    await chrome.storage.local.set({ atlasAliases: all });
  }

  async function setAlias(publicKey, alias) {
    if (!publicKey) throw new Error('No identity to set an alias for.');
    const trimmed = (alias || '').trim();
    if (!trimmed) throw new Error('Alias cannot be empty — clear it instead if you want to remove it.');
    if (trimmed.length > MAX_ALIAS_LENGTH) throw new Error('Alias must be ' + MAX_ALIAS_LENGTH + ' characters or fewer.');
    if (aliasContainsBlockedWord(trimmed)) throw new Error('That alias isn\'t allowed here — try something else.');
    const identity = await getIdentity();
    if (!identity) throw new Error('Unlock your wallet first.');
    const aliases = await getAliasesForOwner(identity);
    aliases[publicKey] = trimmed;
    await saveAliasesForOwner(identity.publicKey, aliases);
  }

  async function clearAlias(publicKey) {
    if (!publicKey) return;
    const identity = await getIdentity();
    if (!identity) return;
    const aliases = await getAliasesForOwner(identity);
    delete aliases[publicKey];
    await saveAliasesForOwner(identity.publicKey, aliases);
  }

  async function getAlias(publicKey) {
    if (!publicKey) return null;
    const identity = await getIdentity();
    if (!identity) return null;
    const aliases = await getAliasesForOwner(identity);
    return aliases[publicKey] || null;
  }

  // ---------- recent worlds (navigation history) ----------
  //
  // Purely a client convenience — where have I been — with no ownership or
  // security meaning, so it deliberately lives outside any per-identity
  // wallet: it isn't touched by locking, switching identity mode, or
  // wallet import/export, and it's the same list regardless of which
  // identity (local or passkey) is currently active.
  const MAX_RECENT_WORLDS = 10;

  // Encrypted + per-identity (2026-09-14, second round) — same migration
  // shape as Friends above. recordWorldVisit() silently no-ops with no
  // active identity, same posture as everywhere else in this batch.
  async function saveRecentWorlds(ownerPublicKey, list) {
    const { atlasRecentWorlds } = await chrome.storage.local.get('atlasRecentWorlds');
    const all = (atlasRecentWorlds && !Array.isArray(atlasRecentWorlds)) ? atlasRecentWorlds : {};
    const identity = await getIdentity();
    all[ownerPublicKey] = await encryptAtRest(identity, 'recentWorlds', list);
    await chrome.storage.local.set({ atlasRecentWorlds: all });
  }

  async function recordWorldVisit(entry) {
    if (!entry || !entry.domain || !entry.world) return;
    const identity = await getIdentity();
    if (!identity) return;
    let list = (await getRecentWorlds()).filter((e) => !(e.domain === entry.domain && e.world === entry.world));
    list.unshift({
      domain: entry.domain,
      world: entry.world,
      worldName: entry.worldName || entry.world,
      manifestUrl: entry.manifestUrl,
      visitedAt: new Date().toISOString()
    });
    list = list.slice(0, MAX_RECENT_WORLDS);
    await saveRecentWorlds(identity.publicKey, list);
  }

  async function getRecentWorlds() {
    const identity = await getIdentity();
    const { atlasRecentWorlds } = await chrome.storage.local.get('atlasRecentWorlds');
    if (Array.isArray(atlasRecentWorlds)) {
      if (!identity) return [];
      await saveRecentWorlds(identity.publicKey, atlasRecentWorlds);
      return atlasRecentWorlds;
    }
    if (!identity) return [];
    return decryptAtRestAndMigrate(identity, 'recentWorlds', (atlasRecentWorlds || {})[identity.publicKey], [], (v) => saveRecentWorlds(identity.publicKey, v));
  }

  // ---------- friends (#67) ----------
  //
  // A deliberate, user-curated list of other people's Atlas identities —
  // distinct from setAlias/getAlias above (which just labels a key you've
  // already interacted with) and from getCounterparty (a single local demo
  // keypair standing in for "another visitor" in trade tests, not a real
  // contact). Keyed by publicKey, one entry per key (re-adding an existing
  // friend upserts their saved name rather than duplicating).
  //
  // How someone actually gets added (task #67's own open question,
  // resolved this build): extension/viewer.js's live presence "signal"
  // relay — presence-server.js/presence-php's protocol, extended
  // specifically for this (see their own header comments) — lets either
  // side send a friend request while you're both actually standing in the
  // same room right now; the other side accepts or declines on the spot,
  // and both wallets call addFriend() locally at that moment. The presence
  // server only ever relays the request/response between two live
  // connections; it never sees or stores anyone's friends list — that stays
  // entirely client-side, here.
  //
  // Encrypted + made per-identity (2026-09-14, second round): Friends
  // used to be "outside the wallet" entirely — one shared list, usable
  // with no identity at all, untouched by locking. Bruno decided this
  // (and the whole family of similar "outside the wallet" lists below —
  // Groups, Aliases, Recent worlds, Favorites, Calendar, chat Mute/Block)
  // should be treated as personal data instead: encrypted at rest AND
  // scoped to whichever identity is unlocked, the same bar Mail/Wallet/
  // Chat already hold. That necessarily means picking SOME identity's key
  // to encrypt under, so a bare array still sitting under the raw
  // `atlasFriends` key is the PRE-migration shape: the first time it's
  // read back under an unlocked local identity, the whole thing is
  // adopted as-is into THAT identity's own new slot, one time only. If
  // more than one identity already existed before this shipped, only
  // whichever one happens to be active for that first read keeps the old
  // shared list — every other identity starts empty from here on, same
  // as if Friends had always been personal. WebAuthn identities can use
  // all of this exactly as before, just without the encryption (no
  // private key material to derive from — same fallback chat's own
  // encryption already has).
  async function getFriends() {
    const identity = await getIdentity();
    const { atlasFriends } = await chrome.storage.local.get('atlasFriends');
    if (Array.isArray(atlasFriends)) {
      if (!identity) return [];
      await saveFriends(identity.publicKey, atlasFriends);
      return atlasFriends;
    }
    if (!identity) return [];
    return decryptAtRestAndMigrate(identity, 'friends', (atlasFriends || {})[identity.publicKey], [], (v) => saveFriends(identity.publicKey, v));
  }

  async function saveFriends(ownerPublicKey, friends) {
    const { atlasFriends } = await chrome.storage.local.get('atlasFriends');
    const all = (atlasFriends && !Array.isArray(atlasFriends)) ? atlasFriends : {};
    const identity = await getIdentity();
    all[ownerPublicKey] = await encryptAtRest(identity, 'friends', friends);
    await chrome.storage.local.set({ atlasFriends: all });
  }

  async function addFriend(publicKey, name) {
    if (!publicKey) throw new Error('No public key to add as a friend.');
    const trimmedName = (name || '').trim().slice(0, MAX_ALIAS_LENGTH) || 'Friend';
    if (aliasContainsBlockedWord(trimmedName)) throw new Error('That name isn\'t allowed here — try something else.');
    const identity = await getIdentity();
    if (!identity) throw new Error('Unlock your wallet first.');
    if (identity.publicKey === publicKey) throw new Error('That\'s your own identity, not someone else\'s.');
    const friends = await getFriends();
    const existing = friends.find((f) => f.publicKey === publicKey);
    if (existing) {
      // Re-adding (e.g. a later live request from the same person) just
      // refreshes the saved name rather than creating a duplicate entry —
      // any notes already jotted down (see updateFriendNotes below) are
      // left untouched.
      existing.name = trimmedName;
    } else {
      friends.push({ publicKey, name: trimmedName, notes: '', addedAt: new Date().toISOString() });
    }
    await saveFriends(identity.publicKey, friends);
  }

  // Contacts -> Contacts sub-tab's free-text notes field (task #67
  // follow-up): a purely personal annotation ("met at the plaza market",
  // "owes me 10 iron") with no meaning to the protocol at all — never
  // sent anywhere, just stored alongside the entry exactly like `name`
  // already is. Upserts onto an EXISTING friend only (there's no
  // standalone "create a contact with no key" concept here) — throws if
  // the key isn't actually a saved friend, same "no such X" shape as
  // updateCalendarEvent above.
  async function updateFriendNotes(publicKey, notes) {
    if (!publicKey) throw new Error('No public key given.');
    const identity = await getIdentity();
    if (!identity) throw new Error('Unlock your wallet first.');
    const friends = await getFriends();
    const entry = friends.find((f) => f.publicKey === publicKey);
    if (!entry) throw new Error('No such contact.');
    entry.notes = (notes || '').slice(0, MAX_NOTES_LENGTH);
    await saveFriends(identity.publicKey, friends);
  }

  async function removeFriend(publicKey) {
    const identity = await getIdentity();
    if (!identity) throw new Error('Unlock your wallet first.');
    const friends = await getFriends();
    const remaining = friends.filter((f) => f.publicKey !== publicKey);
    await saveFriends(identity.publicKey, remaining);
    // A removed contact can't stay a member of any local group either —
    // see the Groups section below. Cheap either way (groups are a small
    // local list), and keeps memberPublicKeys from silently accumulating
    // dangling keys nobody could ever see rendered as a contact again.
    const groups = await getContactGroups();
    if (groups.length) {
      let changed = false;
      groups.forEach((g) => {
        const before = g.memberPublicKeys.length;
        g.memberPublicKeys = g.memberPublicKeys.filter((k) => k !== publicKey);
        if (g.memberPublicKeys.length !== before) changed = true;
      });
      if (changed) await saveContactGroups(identity.publicKey, groups);
    }
  }

  // ---------- contact groups (Contacts -> Groups sub-tab) ----------
  //
  // Deliberately lightweight, LOCAL-ONLY personal organization over the
  // existing Friends list above — NOT the bigger guilds/clans/events
  // system that's a separate, much bigger future item. A group here is
  // just a name plus a set of member public keys drawn from this wallet's
  // own saved friends; nothing about a group is ever sent to a server or
  // to another wallet. Same encrypted-and-per-identity treatment as
  // Friends right above, including the same one-time flat-array-to-
  // per-owner migration — see that function's own comment for the full
  // reasoning.
  const MAX_GROUP_NAME_LENGTH = 40;
  const MAX_NOTES_LENGTH = 500;

  async function getContactGroups() {
    const identity = await getIdentity();
    const { atlasContactGroups } = await chrome.storage.local.get('atlasContactGroups');
    if (Array.isArray(atlasContactGroups)) {
      if (!identity) return [];
      await saveContactGroups(identity.publicKey, atlasContactGroups);
      return atlasContactGroups;
    }
    if (!identity) return [];
    return decryptAtRestAndMigrate(identity, 'contactGroups', (atlasContactGroups || {})[identity.publicKey], [], (v) => saveContactGroups(identity.publicKey, v));
  }

  async function saveContactGroups(ownerPublicKey, groups) {
    const { atlasContactGroups } = await chrome.storage.local.get('atlasContactGroups');
    const all = (atlasContactGroups && !Array.isArray(atlasContactGroups)) ? atlasContactGroups : {};
    const identity = await getIdentity();
    all[ownerPublicKey] = await encryptAtRest(identity, 'contactGroups', groups);
    await chrome.storage.local.set({ atlasContactGroups: all });
  }

  async function addContactGroup(name) {
    const trimmed = (name || '').trim().slice(0, MAX_GROUP_NAME_LENGTH);
    if (!trimmed) throw new Error('A group needs a name.');
    if (aliasContainsBlockedWord(trimmed)) throw new Error('That name isn\'t allowed here — try something else.');
    const identity = await getIdentity();
    if (!identity) throw new Error('Unlock your wallet first.');
    const groups = await getContactGroups();
    const id = 'grp-' + Date.now().toString(36) + '-' + b64urlEncode(crypto.getRandomValues(new Uint8Array(6)).buffer);
    groups.push({ id, name: trimmed, memberPublicKeys: [] });
    await saveContactGroups(identity.publicKey, groups);
    return id;
  }

  async function renameContactGroup(id, name) {
    const trimmed = (name || '').trim().slice(0, MAX_GROUP_NAME_LENGTH);
    if (!trimmed) throw new Error('A group needs a name.');
    if (aliasContainsBlockedWord(trimmed)) throw new Error('That name isn\'t allowed here — try something else.');
    const identity = await getIdentity();
    if (!identity) throw new Error('Unlock your wallet first.');
    const groups = await getContactGroups();
    const group = groups.find((g) => g.id === id);
    if (!group) throw new Error('No such group.');
    group.name = trimmed;
    await saveContactGroups(identity.publicKey, groups);
  }

  async function removeContactGroup(id) {
    const identity = await getIdentity();
    if (!identity) throw new Error('Unlock your wallet first.');
    const groups = await getContactGroups();
    const remaining = groups.filter((g) => g.id !== id);
    await saveContactGroups(identity.publicKey, remaining);
  }

  async function addContactToGroup(groupId, publicKey) {
    const identity = await getIdentity();
    if (!identity) throw new Error('Unlock your wallet first.');
    const groups = await getContactGroups();
    const group = groups.find((g) => g.id === groupId);
    if (!group) throw new Error('No such group.');
    if (!group.memberPublicKeys.includes(publicKey)) group.memberPublicKeys.push(publicKey);
    await saveContactGroups(identity.publicKey, groups);
  }

  async function removeContactFromGroup(groupId, publicKey) {
    const identity = await getIdentity();
    if (!identity) throw new Error('Unlock your wallet first.');
    const groups = await getContactGroups();
    const group = groups.find((g) => g.id === groupId);
    if (!group) throw new Error('No such group.');
    group.memberPublicKeys = group.memberPublicKeys.filter((k) => k !== publicKey);
    await saveContactGroups(identity.publicKey, groups);
  }

  // ---------- chat moderation: mute / block (#114) ----------
  //
  // Both are purely local, per-viewer preferences with no server
  // involvement at all — same "outside the wallet" scope as Friends right
  // above (flat array keyed by publicKey, untouched by locking, identity-
  // switch, or wallet import/export), and, like chat itself, usable even
  // by an anonymous visitor with no unlocked identity.
  //
  // Mute: silences a sender in THIS viewer's own chat rendering only — no
  // notification to the muted person, nothing sent to any server, purely a
  // client-side filter in viewer.js's renderChatMessages().
  //
  // Block: also silences a sender in chat, the same filter, but is
  // deliberately its OWN separate list from mute (a person can be muted
  // without being blocked, and vice versa) — see below for why this is a
  // NEW list rather than reusing the existing mail "Block sender" feature.
  //
  // Not reusing AtlasWallet.blockPostOfficeSender's list: that feature
  // (task #94, see its own comment above) blocks a sender at one SPECIFIC
  // Post Office domain membership, server-side — it takes a `domain`
  // argument, requires a signed request round-tripped to that domain's own
  // server, and only ever affects mail delivery through that one
  // membership. Chat blocking here needs to be instant, offline-capable,
  // and effective across every chat room a public key might show up in
  // (there's no "Post Office membership" concept for an anonymous or
  // domain-agnostic chat participant in the first place) — a fundamentally
  // different shape, not just a different call site for the same list. So
  // this is its own local list, keyed by publicKey exactly like Friends.

  // Encrypted + per-identity where possible (2026-09-14, second round) —
  // same migration shape as Friends/Groups above, with one difference:
  // this list has to keep working for a genuinely anonymous visitor with
  // no identity at all (see this section's own comment above), which
  // encryption can't do (nothing to derive a key from). CHAT_MODERATION_GUEST_SLOT
  // is the bucket used whenever there's no identity to encrypt under —
  // stored as plain, unencrypted entries under that fixed slot, same as
  // this list has always behaved. The moment a real LOCAL identity is
  // active, mutes/blocks are filed under (and encrypted for) that
  // identity instead. A locked local identity falls back to the guest
  // slot too (nothing to decrypt with right now), so moderation still
  // functions while locked, just against the shared guest list rather
  // than that identity's own — resolved the moment it unlocks again (see
  // viewer.js's refreshChatModerationCache(), now also called from the
  // post-unlock hook).
  const CHAT_MODERATION_GUEST_SLOT = 'guest';

  async function getMutedChatUsers() {
    const identity = await getIdentity();
    const owner = identity ? identity.publicKey : CHAT_MODERATION_GUEST_SLOT;
    const { atlasMutedChatUsers } = await chrome.storage.local.get('atlasMutedChatUsers');
    if (Array.isArray(atlasMutedChatUsers)) {
      await saveMutedChatUsers(owner, atlasMutedChatUsers);
      return atlasMutedChatUsers;
    }
    return decryptAtRestAndMigrate(identity, 'mutedChatUsers', (atlasMutedChatUsers || {})[owner], [], (v) => saveMutedChatUsers(owner, v));
  }

  async function saveMutedChatUsers(ownerPublicKey, muted) {
    const { atlasMutedChatUsers } = await chrome.storage.local.get('atlasMutedChatUsers');
    const all = (atlasMutedChatUsers && !Array.isArray(atlasMutedChatUsers)) ? atlasMutedChatUsers : {};
    const identity = await getIdentity();
    all[ownerPublicKey] = await encryptAtRest(identity, 'mutedChatUsers', muted);
    await chrome.storage.local.set({ atlasMutedChatUsers: all });
  }

  async function muteChatUser(publicKey, name) {
    if (!publicKey) throw new Error('No public key to mute.');
    const identity = await getIdentity();
    const owner = identity ? identity.publicKey : CHAT_MODERATION_GUEST_SLOT;
    const muted = await getMutedChatUsers();
    if (!muted.some((m) => m.publicKey === publicKey)) {
      muted.push({ publicKey, name: name || 'Visitor', mutedAt: new Date().toISOString() });
      await saveMutedChatUsers(owner, muted);
    }
  }

  async function unmuteChatUser(publicKey) {
    const identity = await getIdentity();
    const owner = identity ? identity.publicKey : CHAT_MODERATION_GUEST_SLOT;
    const muted = await getMutedChatUsers();
    const remaining = muted.filter((m) => m.publicKey !== publicKey);
    await saveMutedChatUsers(owner, remaining);
  }

  async function getBlockedChatUsers() {
    const identity = await getIdentity();
    const owner = identity ? identity.publicKey : CHAT_MODERATION_GUEST_SLOT;
    const { atlasBlockedChatUsers } = await chrome.storage.local.get('atlasBlockedChatUsers');
    if (Array.isArray(atlasBlockedChatUsers)) {
      await saveBlockedChatUsers(owner, atlasBlockedChatUsers);
      return atlasBlockedChatUsers;
    }
    return decryptAtRestAndMigrate(identity, 'blockedChatUsers', (atlasBlockedChatUsers || {})[owner], [], (v) => saveBlockedChatUsers(owner, v));
  }

  async function saveBlockedChatUsers(ownerPublicKey, blocked) {
    const { atlasBlockedChatUsers } = await chrome.storage.local.get('atlasBlockedChatUsers');
    const all = (atlasBlockedChatUsers && !Array.isArray(atlasBlockedChatUsers)) ? atlasBlockedChatUsers : {};
    const identity = await getIdentity();
    all[ownerPublicKey] = await encryptAtRest(identity, 'blockedChatUsers', blocked);
    await chrome.storage.local.set({ atlasBlockedChatUsers: all });
  }

  async function blockChatUser(publicKey, name) {
    if (!publicKey) throw new Error('No public key to block.');
    const identity = await getIdentity();
    const owner = identity ? identity.publicKey : CHAT_MODERATION_GUEST_SLOT;
    const blocked = await getBlockedChatUsers();
    if (!blocked.some((b) => b.publicKey === publicKey)) {
      blocked.push({ publicKey, name: name || 'Visitor', blockedAt: new Date().toISOString() });
      await saveBlockedChatUsers(owner, blocked);
    }
  }

  async function unblockChatUser(publicKey) {
    const identity = await getIdentity();
    const owner = identity ? identity.publicKey : CHAT_MODERATION_GUEST_SLOT;
    const blocked = await getBlockedChatUsers();
    const remaining = blocked.filter((b) => b.publicKey !== publicKey);
    await saveBlockedChatUsers(owner, remaining);
  }

  // ---------- favorite domains (#61) ----------
  //
  // Explicit, user-curated, reorderable — distinct from Recent worlds
  // above (recency-ordered, auto-pruned, no curation). Domain-level per
  // the original request: favoriting a domain, not one specific world
  // within it (Recent worlds already covers "the exact world I was just
  // in"; favorites is "places I want to be able to jump back to").
  //
  // The array's own order IS the display/teleport order — moveFavoriteDomain
  // below reorders by swapping adjacent array positions, so no separate
  // numeric "order" field is needed for it to survive add/remove.
  //
  // worldId/worldName/presenceBase are captured at add-time from whatever
  // manifest was current (see viewer.js's addCurrentDomainToFavorites) —
  // worldId lets teleporting land on a real world without needing
  // manifest.defaultWorld to still mean the same thing later, and
  // presenceBase is what lets the live "how many people are here now"
  // status (viewer.js's fetchPresenceStatus) query the right presence
  // server for a domain that isn't the one currently active, without
  // re-fetching that domain's manifest just to ask.
  //
  // Same "outside the wallet" scope as Recent worlds and Friends above.

  // Encrypted + per-identity (2026-09-14, second round) — same migration
  // shape as Friends above. The mutators below silently no-op with no
  // active identity (isFavoriteDomain/getFavoriteDomains just read back
  // empty), same posture as everywhere else in this batch.
  async function saveFavoriteDomains(ownerPublicKey, favorites) {
    const { atlasFavoriteDomains } = await chrome.storage.local.get('atlasFavoriteDomains');
    const all = (atlasFavoriteDomains && !Array.isArray(atlasFavoriteDomains)) ? atlasFavoriteDomains : {};
    const identity = await getIdentity();
    all[ownerPublicKey] = await encryptAtRest(identity, 'favoriteDomains', favorites);
    await chrome.storage.local.set({ atlasFavoriteDomains: all });
  }

  async function getFavoriteDomains() {
    const identity = await getIdentity();
    const { atlasFavoriteDomains } = await chrome.storage.local.get('atlasFavoriteDomains');
    if (Array.isArray(atlasFavoriteDomains)) {
      if (!identity) return [];
      await saveFavoriteDomains(identity.publicKey, atlasFavoriteDomains);
      return atlasFavoriteDomains;
    }
    if (!identity) return [];
    return decryptAtRestAndMigrate(identity, 'favoriteDomains', (atlasFavoriteDomains || {})[identity.publicKey], [], (v) => saveFavoriteDomains(identity.publicKey, v));
  }

  async function isFavoriteDomain(domain) {
    const favorites = await getFavoriteDomains();
    return favorites.some((f) => f.domain === domain);
  }

  async function addFavoriteDomain(entry) {
    if (!entry || !entry.domain || !entry.manifestUrl) throw new Error('Missing domain/manifest to favorite.');
    const identity = await getIdentity();
    if (!identity) throw new Error('Unlock your wallet first.');
    const favorites = await getFavoriteDomains();
    if (favorites.some((f) => f.domain === entry.domain)) return; // already favorited — adding again is a no-op, not a duplicate or an error
    favorites.push({
      domain: entry.domain,
      manifestUrl: entry.manifestUrl,
      worldId: entry.worldId || null,
      worldName: entry.worldName || entry.domain,
      presenceBase: entry.presenceBase || null,
      addedAt: new Date().toISOString()
    });
    await saveFavoriteDomains(identity.publicKey, favorites);
  }

  async function removeFavoriteDomain(domain) {
    const identity = await getIdentity();
    if (!identity) return;
    const favorites = await getFavoriteDomains();
    const remaining = favorites.filter((f) => f.domain !== domain);
    await saveFavoriteDomains(identity.publicKey, remaining);
  }

  // direction is 'up' or 'down' — swaps this entry with its immediate
  // neighbor in that direction. A no-op at either end of the list rather
  // than an error, so a UI button can just always be clickable and this
  // quietly does nothing when there's nowhere to move.
  async function moveFavoriteDomain(domain, direction) {
    const identity = await getIdentity();
    if (!identity) return;
    const favorites = await getFavoriteDomains();
    const index = favorites.findIndex((f) => f.domain === domain);
    if (index === -1) return;
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= favorites.length) return;
    [favorites[index], favorites[targetIndex]] = [favorites[targetIndex], favorites[index]];
    await saveFavoriteDomains(identity.publicKey, favorites);
  }

  // ---------- calendar events (Social -> Calendar) ----------
  //
  // Manually-added local reminders. Originally a single flat array shared
  // by every identity on the device ("nothing identity-specific about
  // 'remember to do X on this date'"); as of the whole-storage at-rest
  // encryption pass (see encryptAtRest/decryptAtRestAndMigrate above) this
  // is now per-identity and AES-GCM encrypted at rest, same as
  // Friends/ContactGroups/RecentWorlds/FavoriteDomains — encrypting a
  // shared list requires picking a single identity's key, so "shared
  // across all identities" could not survive encryption. A legacy flat
  // array (Array.isArray(atlasCalendarEvents)) is migrated one-time into
  // whichever identity happens to be unlocked when it's first read after
  // upgrading; requires an unlocked identity to read or write at all now
  // (getCalendarEvents returns [] with none active; add/update/remove
  // throw "Unlock your wallet first.").
  //
  // getCalendarEvents() always returns the list sorted soonest-first by
  // dateTime — unlike Favorites (whose array order IS a user-curated
  // display order, reordered explicitly via moveFavoriteDomain), a
  // calendar's natural order is chronological and there's no reason to let
  // it drift from that, so every caller gets it pre-sorted rather than
  // re-sorting in the UI layer. Sorted by dateTime (the START time) even
  // for events that carry an endDateTime too — soonest-to-START is still
  // the natural reading order for a flat list.
  async function saveCalendarEvents(ownerPublicKey, events) {
    const { atlasCalendarEvents } = await chrome.storage.local.get('atlasCalendarEvents');
    const all = (atlasCalendarEvents && !Array.isArray(atlasCalendarEvents)) ? atlasCalendarEvents : {};
    const identity = await getIdentity();
    all[ownerPublicKey] = await encryptAtRest(identity, 'calendarEvents', events);
    await chrome.storage.local.set({ atlasCalendarEvents: all });
  }

  async function getCalendarEvents() {
    const identity = await getIdentity();
    const { atlasCalendarEvents } = await chrome.storage.local.get('atlasCalendarEvents');
    let events;
    if (Array.isArray(atlasCalendarEvents)) {
      if (!identity) return [];
      await saveCalendarEvents(identity.publicKey, atlasCalendarEvents);
      events = atlasCalendarEvents;
    } else if (!identity) {
      events = [];
    } else {
      events = await decryptAtRestAndMigrate(identity, 'calendarEvents', (atlasCalendarEvents || {})[identity.publicKey], [], (v) => saveCalendarEvents(identity.publicKey, v));
    }
    return events.slice().sort((a, b) => new Date(a.dateTime) - new Date(b.dateTime));
  }

  // An event's end time is optional — endDateTime is an ISO string when
  // set, or `null` when the event has no end (an instant, no-duration
  // event, which is all any event could be before this field existed).
  // Existing stored events from before this field was added simply lack
  // the key (`undefined`) rather than being migrated to `null` — every
  // reader in this file and in viewer.js treats "falsy" (missing OR null)
  // as "no end time", so the two are always handled identically.
  function validateCalendarEventTimes(dateTime, endDateTime) {
    if (endDateTime && new Date(endDateTime).getTime() <= new Date(dateTime).getTime()) {
      throw new Error("An event's end time must be after its start time.");
    }
  }

  async function addCalendarEvent(entry) {
    if (!entry || !entry.title) throw new Error('An event needs a title.');
    if (!entry.dateTime) throw new Error('An event needs a date/time.');
    validateCalendarEventTimes(entry.dateTime, entry.endDateTime);
    const identity = await getIdentity();
    if (!identity) throw new Error('Unlock your wallet first.');
    const events = await getCalendarEvents();
    const id = 'cal-' + Date.now().toString(36) + '-' + b64urlEncode(crypto.getRandomValues(new Uint8Array(6)).buffer);
    events.push({
      id,
      title: entry.title,
      dateTime: entry.dateTime, // ISO string
      endDateTime: entry.endDateTime || null, // ISO string, or null (see comment above)
      notes: entry.notes || '',
      createdAt: new Date().toISOString()
    });
    await saveCalendarEvents(identity.publicKey, events);
    return id;
  }

  // Merges `patch` (any of title/dateTime/endDateTime/notes) into the
  // existing event — same partial-update shape as setChatPanelSettings's
  // patch object elsewhere in this file, just applied to one array entry
  // instead of a single settings blob. Validated against the MERGED
  // result (not just whatever `patch` happens to include) so an update
  // that only touches, say, the title can't accidentally leave a
  // previously-valid dateTime/endDateTime pair in an invalid state.
  async function updateCalendarEvent(id, patch) {
    const identity = await getIdentity();
    if (!identity) throw new Error('Unlock your wallet first.');
    const events = await getCalendarEvents();
    const index = events.findIndex((e) => e.id === id);
    if (index === -1) throw new Error('No such calendar event.');
    const merged = { ...events[index], ...patch };
    validateCalendarEventTimes(merged.dateTime, merged.endDateTime);
    events[index] = merged;
    await saveCalendarEvents(identity.publicKey, events);
  }

  async function removeCalendarEvent(id) {
    const identity = await getIdentity();
    if (!identity) throw new Error('Unlock your wallet first.');
    const events = await getCalendarEvents();
    const remaining = events.filter((e) => e.id !== id);
    await saveCalendarEvents(identity.publicKey, remaining);
  }

  // ---------- player character size (#33 follow-up) ----------
  //
  // A purely cosmetic size multiplier on the rendered character model (see
  // buildCharacter/charBase in gltf-mini.js) — doesn't touch movement
  // speed, collision radius, or camera-follow distance, just how big the
  // character LOOKS. Same reasoning as Recent worlds above it for living
  // outside any per-identity wallet: a client display preference with no
  // ownership meaning, untouched by locking/identity-switch/import-export.
  const DEFAULT_CHARACTER_SCALE = 1;
  const MIN_CHARACTER_SCALE = 0.5;
  const MAX_CHARACTER_SCALE = 2;

  function clampCharacterScale(n) {
    return Number.isFinite(n) ? Math.max(MIN_CHARACTER_SCALE, Math.min(MAX_CHARACTER_SCALE, n)) : DEFAULT_CHARACTER_SCALE;
  }

  async function getCharacterScale() {
    const { atlasCharacterScale } = await chrome.storage.local.get('atlasCharacterScale');
    return clampCharacterScale(Number(atlasCharacterScale));
  }

  async function setCharacterScale(scale) {
    const clamped = clampCharacterScale(Number(scale));
    await chrome.storage.local.set({ atlasCharacterScale: clamped });
    return clamped;
  }

  // Task #209 — whether the wallet plays a short chime whenever the
  // holder's OWN wallet gains something (a mint, a gift, a claimed trade,
  // a mail-delivered credential — see viewer.js's refreshInventoryDisplay()
  // for exactly what counts). Same category as character scale right
  // above: a client display/notification preference, not anything owned
  // by an identity, so it lives outside any per-identity wallet scope —
  // on by default (most people want the feedback), untouched by locking,
  // identity-switch, or import/export, and readable even by a visitor
  // with no unlocked identity at all (nothing about this needs one).
  async function getWalletSoundEnabled() {
    const { atlasWalletSoundEnabled } = await chrome.storage.local.get('atlasWalletSoundEnabled');
    return atlasWalletSoundEnabled !== false; // unset (fresh install) reads as enabled
  }

  async function setWalletSoundEnabled(enabled) {
    await chrome.storage.local.set({ atlasWalletSoundEnabled: !!enabled });
    return !!enabled;
  }

  // ---------- in-world chat panel settings ----------
  //
  // Same reasoning as character scale right above: a client display
  // preference (box size, opacity, text size, minimized state), not
  // anything owned by an identity, so it lives outside any per-identity
  // wallet scope — untouched by locking, identity-switch, or import/
  // export, and readable/settable even by a visitor with no unlocked
  // identity at all (chat is readable while logged out; its panel
  // settings should be too).
  //
  // lastSize is what minimize restores TO — captured at the moment
  // minimize is pressed (see viewer.js's minimize handler), not a second
  // independent width/height pair to keep in sync by hand.
  const CHAT_MIN_WIDTH = 220;
  const CHAT_MAX_WIDTH = 640;
  const CHAT_MIN_HEIGHT = 120;
  const CHAT_MAX_HEIGHT = 480;
  // defaultTabPreference (#113) — which tab a freshly-entered world's chat
  // opens on. 'auto' preserves the original pre-#113 behavior exactly
  // (whatever tab is already selected stays selected — see viewer.js's
  // refreshChatAvailability(), which is the only place this is read);
  // 'world'/'domain' force that tab whenever it's actually available,
  // falling back to the other one when it isn't. Validated against this
  // fixed list, same "unrecognized value silently falls back to the
  // default" posture every other field in clampChatPanelSettings() uses.
  const CHAT_TAB_PREFERENCES = ['auto', 'domain', 'world'];
  // historyOnJoin — whether a freshly-joined chat room's recent-history
  // backlog (chat-history over WS, or the join response's `messages` over
  // the polling fallback — see joinChatRoom()/chat_join_room() server-side)
  // gets shown at all. Defaults true, preserving the exact original
  // behavior from before this setting existed. This is a purely local/
  // client display preference — turning it off does NOT ask either server
  // to withhold history (neither backend has any notion of this setting);
  // the client just discards the batch it already received and starts the
  // message list empty, same "starts empty, only what arrives live from
  // here on" list either way it renders. See viewer.js's connectChat()/
  // pollChat() for where the discard actually happens.
  const DEFAULT_CHAT_PANEL_SETTINGS = {
    width: 320,
    height: 200,
    opacity: 0.9,
    textSize: 12,
    minimized: false,
    defaultTabPreference: 'auto',
    historyOnJoin: true,
    lastSize: { width: 320, height: 200 }
  };

  function clampChatPanelSettings(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    const lastSizeRaw = s.lastSize && typeof s.lastSize === 'object' ? s.lastSize : {};
    return {
      width: Number.isFinite(Number(s.width)) ? Math.max(CHAT_MIN_WIDTH, Math.min(CHAT_MAX_WIDTH, Number(s.width))) : DEFAULT_CHAT_PANEL_SETTINGS.width,
      height: Number.isFinite(Number(s.height)) ? Math.max(CHAT_MIN_HEIGHT, Math.min(CHAT_MAX_HEIGHT, Number(s.height))) : DEFAULT_CHAT_PANEL_SETTINGS.height,
      opacity: Number.isFinite(Number(s.opacity)) ? Math.max(0.2, Math.min(1, Number(s.opacity))) : DEFAULT_CHAT_PANEL_SETTINGS.opacity,
      textSize: Number.isFinite(Number(s.textSize)) ? Math.max(10, Math.min(20, Number(s.textSize))) : DEFAULT_CHAT_PANEL_SETTINGS.textSize,
      minimized: !!s.minimized,
      defaultTabPreference: CHAT_TAB_PREFERENCES.includes(s.defaultTabPreference) ? s.defaultTabPreference : DEFAULT_CHAT_PANEL_SETTINGS.defaultTabPreference,
      historyOnJoin: s.historyOnJoin === undefined ? DEFAULT_CHAT_PANEL_SETTINGS.historyOnJoin : !!s.historyOnJoin,
      lastSize: {
        width: Number.isFinite(Number(lastSizeRaw.width)) ? Math.max(CHAT_MIN_WIDTH, Math.min(CHAT_MAX_WIDTH, Number(lastSizeRaw.width))) : DEFAULT_CHAT_PANEL_SETTINGS.lastSize.width,
        height: Number.isFinite(Number(lastSizeRaw.height)) ? Math.max(CHAT_MIN_HEIGHT, Math.min(CHAT_MAX_HEIGHT, Number(lastSizeRaw.height))) : DEFAULT_CHAT_PANEL_SETTINGS.lastSize.height
      }
    };
  }

  async function getChatPanelSettings() {
    const { atlasChatPanelSettings } = await chrome.storage.local.get('atlasChatPanelSettings');
    return clampChatPanelSettings(atlasChatPanelSettings);
  }

  // Merges rather than replaces — every caller (the drag handle, the cog
  // popover's opacity/text-size controls, the minimize button) only ever
  // touches one or two fields at a time, same "patch, don't clobber"
  // convention as everything else in this file that stores a settings
  // object (see e.g. setMailSettings elsewhere).
  async function setChatPanelSettings(patch) {
    const current = await getChatPanelSettings();
    const merged = clampChatPanelSettings(Object.assign({}, current, patch, {
      lastSize: Object.assign({}, current.lastSize, patch && patch.lastSize)
    }));
    await chrome.storage.local.set({ atlasChatPanelSettings: merged });
    return merged;
  }

  // ---------- Asset Viewer panel settings (#150) ----------
  //
  // Mirrors getChatPanelSettings/setChatPanelSettings above exactly — same
  // "clamp on every read AND every write, patch rather than replace" shape,
  // same chrome.storage.local/global-scope/no-unlock-required convention
  // (a hover panel's own opacity/size is a display preference, not identity
  // data — same reasoning as chat's settings and atlasCharacterScale).
  // Smaller than chat's settings object on purpose: the Asset Viewer has no
  // minimize state, no tab preference, no history toggle — just the two
  // controls its own settings-gear popover actually offers (viewer.js),
  // plus width/height for its resize handle. No `lastSize` either — nothing
  // here ever minimizes, so there's no "restore to" size to remember.
  const ASSET_VIEWER_MIN_WIDTH = 220;
  const ASSET_VIEWER_MAX_WIDTH = 480;
  const ASSET_VIEWER_MIN_HEIGHT = 180;
  const ASSET_VIEWER_MAX_HEIGHT = 560;
  const DEFAULT_ASSET_VIEWER_SETTINGS = {
    width: 280,
    height: 240,
    opacity: 0.95,
    textSize: 12
  };

  function clampAssetViewerSettings(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    return {
      width: Number.isFinite(Number(s.width)) ? Math.max(ASSET_VIEWER_MIN_WIDTH, Math.min(ASSET_VIEWER_MAX_WIDTH, Number(s.width))) : DEFAULT_ASSET_VIEWER_SETTINGS.width,
      height: Number.isFinite(Number(s.height)) ? Math.max(ASSET_VIEWER_MIN_HEIGHT, Math.min(ASSET_VIEWER_MAX_HEIGHT, Number(s.height))) : DEFAULT_ASSET_VIEWER_SETTINGS.height,
      opacity: Number.isFinite(Number(s.opacity)) ? Math.max(0.2, Math.min(1, Number(s.opacity))) : DEFAULT_ASSET_VIEWER_SETTINGS.opacity,
      textSize: Number.isFinite(Number(s.textSize)) ? Math.max(10, Math.min(20, Number(s.textSize))) : DEFAULT_ASSET_VIEWER_SETTINGS.textSize
    };
  }

  async function getAssetViewerSettings() {
    const { atlasAssetViewerSettings } = await chrome.storage.local.get('atlasAssetViewerSettings');
    return clampAssetViewerSettings(atlasAssetViewerSettings);
  }

  async function setAssetViewerSettings(patch) {
    const current = await getAssetViewerSettings();
    const merged = clampAssetViewerSettings(Object.assign({}, current, patch));
    await chrome.storage.local.set({ atlasAssetViewerSettings: merged });
    return merged;
  }

  // ---------- Previewer panel settings (#227) ----------
  //
  // Bruno's follow-up to the Asset Viewer's scene-hover feature: a
  // SEPARATE floating panel, "Previewer," for anything hoverable directly
  // in a 2D/3D scene (dropped items, stalls/crates) — the Asset Viewer
  // goes back to being wallet-card-hover only (see viewer.js's own
  // comment on why that split exists). Unlike the Asset Viewer (always
  // re-positioned by JS next to whatever's hovered) or #messagingWidget
  // (free-drag, stays exactly where dropped), Bruno asked for this one to
  // DOCK — drag it and let go, and it snaps to whichever screen corner is
  // nearest, staying there from release to release rather than sitting
  // wherever the cursor happened to let go. That's why this stores a
  // `dock` corner NAME rather than raw left/top the way
  // atlasMessagingWindowSettings does: a named corner re-derives its own
  // correct on-screen position after a window resize (`bottom-right` is
  // still the bottom-right corner at any canvas size), where a remembered
  // pixel offset would drift or end up off-screen entirely.
  //
  // No width/height/opacity here (unlike Asset Viewer/messaging) — the
  // Previewer's size is intentionally fixed by its content (a compact
  // list has no resize handle to drag), so there is nothing else for this
  // settings object to carry yet.
  const VALID_PREVIEWER_DOCKS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
  // bottom-left: away from #walletPanel's own right-edge dock and from the
  // top-left area a fresh visitor's eye tends to land on first — an
  // out-of-the-way default corner for a panel that will often be popping
  // open/closed as someone walks around a scene.
  const DEFAULT_PREVIEWER_WINDOW_SETTINGS = { dock: 'bottom-left' };

  function clampPreviewerWindowSettings(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    return {
      dock: VALID_PREVIEWER_DOCKS.includes(s.dock) ? s.dock : DEFAULT_PREVIEWER_WINDOW_SETTINGS.dock
    };
  }

  async function getPreviewerWindowSettings() {
    const { atlasPreviewerWindowSettings } = await chrome.storage.local.get('atlasPreviewerWindowSettings');
    return clampPreviewerWindowSettings(atlasPreviewerWindowSettings);
  }

  async function setPreviewerWindowSettings(patch) {
    const current = await getPreviewerWindowSettings();
    const merged = clampPreviewerWindowSettings(Object.assign({}, current, patch));
    await chrome.storage.local.set({ atlasPreviewerWindowSettings: merged });
    return merged;
  }

  // ---------- Inventory "only show items compatible with this domain"
  // checkbox settings (#151 follow-up) ----------
  //
  // Collectibles and Documents each have their own independent checkbox
  // on the Inventory screen (see viewer.js's collectiblesCompatMatch()/
  // documentsCompatMatch()) — this just remembers whether each is
  // checked. Same device-level display-preference convention as the
  // settings above: not identity data, so it isn't wiped by lock/unlock
  // or switching identities, and the checkbox itself only ever filters
  // the "Yours" list, never Counterparty's.
  const DEFAULT_INVENTORY_FILTER_SETTINGS = { collectiblesCompatOnly: false, documentsCompatOnly: false };

  function clampInventoryFilterSettings(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    return {
      collectiblesCompatOnly: !!s.collectiblesCompatOnly,
      documentsCompatOnly: !!s.documentsCompatOnly
    };
  }

  async function getInventoryFilterSettings() {
    const { atlasInventoryFilterSettings } = await chrome.storage.local.get('atlasInventoryFilterSettings');
    return clampInventoryFilterSettings(atlasInventoryFilterSettings);
  }

  async function setInventoryFilterSettings(patch) {
    const current = await getInventoryFilterSettings();
    const merged = clampInventoryFilterSettings(Object.assign({}, current, patch));
    await chrome.storage.local.set({ atlasInventoryFilterSettings: merged });
    return merged;
  }

  // ---------- auto-lock on inactivity (#71) ----------
  //
  // Only local-password identity (§6 step 5 of SPEC.md) has any "locked"
  // state to auto-lock in the first place — WebAuthn has no session key to
  // discard, every signature is its own fresh hardware ceremony (see
  // isUnlocked() above), so viewer.js only ever runs this timer while
  // getIdentityMode() === 'local'. Same "client display/behavior
  // preference, not identity data" reasoning as character scale just
  // above: this lives outside any per-identity wallet, one value per
  // device, untouched by locking/identity-switch/import-export — auto-lock
  // 10 minutes is a choice about THIS DEVICE's own idle behavior, not
  // something that should reset or need re-choosing every time someone
  // switches which identity is active on it.
  //
  // 0 is a valid, explicit "never auto-lock" — not a missing/unset value —
  // and is the default, so nobody who never opens this setting gets a
  // surprise lock mid-session that wasn't there before this feature
  // shipped.
  const DEFAULT_AUTO_LOCK_MINUTES = 0;

  async function getAutoLockMinutes() {
    const { atlasAutoLockMinutes } = await chrome.storage.local.get('atlasAutoLockMinutes');
    const n = Number(atlasAutoLockMinutes);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_AUTO_LOCK_MINUTES;
  }

  async function setAutoLockMinutes(minutes) {
    const n = Number(minutes);
    if (!Number.isFinite(n) || n < 0) throw new Error('Auto-lock must be 0 (never) or a positive number of minutes.');
    await chrome.storage.local.set({ atlasAutoLockMinutes: Math.round(n) });
    return Math.round(n);
  }

  // ---------- misc ----------

  async function reverifyAll() {
    const identity = await getIdentity();
    const counterparty = await getCounterparty();
    for (const who of [identity, counterparty].filter(Boolean)) {
      const verdicts = new Map();
      for (const entry of await getWallet(who.publicKey)) verdicts.set(entry.credential.id, await verifyCredential(entry.credential));
      await withWalletLock(async () => {
        const wallet = await getWallet(who.publicKey);
        for (const entry of wallet) if (verdicts.has(entry.credential.id)) entry.lastVerdict = verdicts.get(entry.credential.id);
        await saveWallet(who.publicKey, wallet);
      });
    }
  }

  async function exportWallet() {
    const identity = await getIdentity();
    const assets = identity ? await getWallet(identity.publicKey) : [];
    return {
      format: 'atlas-wallet-export/1.0',
      identity: identity ? { publicKey: identity.publicKey } : null,
      credentials: assets.map((w) => w.credential),
      exportedAt: new Date().toISOString()
    };
  }

  // The counterpart to exportWallet() above — re-populates this wallet's
  // LOCAL asset list from a previously exported file. This is not a trust
  // operation the way importIdentity() is: nothing here is secret, and
  // every credential gets independently re-verified against its own
  // issuer (verifyCredential — real signature + revocation checks) before
  // it's trusted, exactly as if it had just been issued. A credential
  // whose `owner` doesn't match the currently active identity is skipped
  // rather than silently relabeled as yours — an export file can be handed
  // around, but importing it can't be used to make someone else's
  // credential show up as your own. Already-present ids (by credential id)
  // are skipped too, so importing the same file twice is harmless.
  async function importWallet(fileData) {
    if (!fileData || fileData.format !== 'atlas-wallet-export/1.0') throw new Error('Not an Atlas wallet export file.');
    const identity = await getIdentity();
    if (!identity) throw new Error('Unlock your wallet first.');

    const credentials = Array.isArray(fileData.credentials) ? fileData.credentials : [];
    const assets = credentials.filter((c) => c && c.credential === 'domain-atlas-asset/1.0');

    let assetsAdded = 0, assetsSkippedDuplicate = 0, assetsSkippedNotOwned = 0;
    const wallet = await getWallet(identity.publicKey);
    for (const credential of assets) {
      if (credential.owner && credential.owner.publicKey !== identity.publicKey) { assetsSkippedNotOwned++; continue; }
      if (wallet.some((e) => e.credential.id === credential.id)) { assetsSkippedDuplicate++; continue; }
      wallet.push({ credential, lastVerdict: await verifyCredential(credential) });
      assetsAdded++;
    }
    if (assetsAdded > 0) {
      await saveWallet(identity.publicKey, wallet);
      await autoConsolidateAssetWallet(identity.publicKey);
    }

    return { assetsAdded, assetsSkippedDuplicate, assetsSkippedNotOwned };
  }

  // ---------- single-asset transfer files (SPEC.md §13.5) ----------
  //
  // A held non-fungible asset can be exported to a file; whoever claims the
  // file first becomes its owner. The issuer does the swap (see
  // /atlas/asset/transfer-to-file and /atlas/asset/claim-from-file), so this
  // wallet never decides on its own who owns what: it signs intents, shows
  // the person what a file contains, and records what it did.
  //
  // The ledger below (atlasAssetFiles, encrypted at rest like the wallet)
  // holds two kinds of record per owner:
  //   exported: {fileId, direction:'exported', state, file?, sourceId, ...}
  //             state 'pending' keeps the file itself, because after an
  //             export the exporter no longer owns the asset and a lost file
  //             would otherwise be a lost asset. Any other state drops it.
  //             An export is recorded as 'requesting' (with a copy of the
  //             original credential, and no fileId yet) BEFORE the request
  //             is sent. If no file comes back it becomes 'interrupted' and
  //             is settled by recoverInterruptedExport(), which asks the
  //             issuer for the export it recorded (SPEC.md §13.5.1).
  //   claimed:  {fileId, direction:'claimed', newId, ...}, so importing the
  //             same file again is recognised instead of retried.
  const ASSET_FILE_MAX_BYTES = 256 * 1024;
  // An issuer that has no record of an export is only believed once the
  // request is this old: a request still travelling could reach the issuer
  // after it said so.
  const EXPORT_RECOVERY_GRACE_MS = 2 * 60 * 1000;
  const ASSET_FILE_LEDGER_MAX = 500;

  async function getAssetFiles(ownerPublicKey) {
    const { atlasAssetFiles } = await chrome.storage.local.get('atlasAssetFiles');
    const identity = await getIdentity();
    return decryptAtRestAndMigrate(identity, 'assetFiles', (atlasAssetFiles || {})[ownerPublicKey], [], (v) => saveAssetFiles(ownerPublicKey, v));
  }

  async function saveAssetFiles(ownerPublicKey, records) {
    const { atlasAssetFiles } = await chrome.storage.local.get('atlasAssetFiles');
    const all = atlasAssetFiles || {};
    const identity = await getIdentity();
    all[ownerPublicKey] = await encryptAtRest(identity, 'assetFiles', records.slice(0, ASSET_FILE_LEDGER_MAX));
    await chrome.storage.local.set({ atlasAssetFiles: all });
  }

  async function getPendingExports(ownerPublicKey) {
    return (await getAssetFiles(ownerPublicKey)).filter((r) => r.direction === 'exported' && r.state === 'pending' && r.file);
  }

  // Exports whose outcome this wallet has not yet seen: the request was
  // recorded and (maybe) sent, but no file came back. 'requesting' is the
  // record written before sending; 'interrupted' means the reply was lost or
  // unreadable; 'lost' means the issuer has no record of the export but the
  // item was revoked, which needs the issuer's help.
  async function getInterruptedExports(ownerPublicKey) {
    return (await getAssetFiles(ownerPublicKey)).filter((r) => r.direction === 'exported' && ['requesting', 'interrupted', 'lost'].includes(r.state) && r.sourceId);
  }

  // An issuer domain taken from an untrusted file is fetched from, so it
  // must be a plain host[:port]: no scheme, path or credentials, and no IP
  // literal other than loopback.
  function validAssetFileDomain(domain) {
    if (typeof domain !== 'string' || domain.length === 0 || domain.length > 253) return false;
    const m = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)(:\d{1,5})?$/i.exec(domain);
    if (!m) return false;
    const host = m[1].toLowerCase();
    if (/^\d+(\.\d+){3}$/.test(host)) return host === '127.0.0.1';
    return host === 'localhost' || host.includes('.');
  }

  // Returns a short reason, or null if the credential has the shape of a
  // unique asset credential this wallet can reason about. Says nothing
  // about whether it is genuine; verifyCredential() does that.
  function assetFileShapeProblem(c) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return 'This file is not an asset credential.';
    if (c.credential !== 'domain-atlas-asset/1.0') return 'This file is not an asset credential.';
    if (typeof c.id !== 'string' || !c.id || c.id.length > 200) return 'This file has no valid credential id.';
    if (typeof c.signature !== 'string' || typeof c.issuedAt !== 'string') return 'This file is not signed.';
    if (!c.asset || typeof c.asset !== 'object' || typeof c.asset.class !== 'string' || typeof c.asset.name !== 'string') return 'This file has no valid asset.';
    if (!c.owner || typeof c.owner.publicKey !== 'string') return 'This file has no owner key.';
    if (!c.issuer || typeof c.issuer.publicKey !== 'string' || !validAssetFileDomain(c.issuer.domain)) return 'This file names an issuer domain this wallet will not contact.';
    return null;
  }

  async function fetchAssetFileStatus(domain, id) {
    const res = await fetch(baseUrl(domain) + '/atlas/asset/file-status?id=' + encodeURIComponent(id), { cache: 'no-store' });
    if (!res.ok) throw new Error('status check failed: ' + res.status);
    return res.json();
  }

  // Whether `domain`'s manifest has opted in to file transfers (the
  // top-level fileTransfer field), and for which classes. Cached briefly so
  // rendering an inventory of many items does not refetch the manifest.
  const fileTransferSupportCache = new Map();
  async function getFileTransferSupport(domain) {
    if (!validAssetFileDomain(domain)) return { enabled: false, classes: null };
    const cached = fileTransferSupportCache.get(domain);
    if (cached && Date.now() - cached.at < 60000) return cached.value;
    let value = { enabled: false, classes: null };
    try {
      const res = await fetch(baseUrl(domain) + '/.well-known/spatial.json', { cache: 'no-store' });
      if (res.ok) {
        const manifest = await res.json();
        const cfg = manifest && manifest.fileTransfer;
        if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) {
          value = { enabled: true, classes: Array.isArray(cfg.classes) ? cfg.classes.filter((c) => typeof c === 'string') : null };
        }
      }
    } catch (err) {
      // unreachable or not JSON: treated as not opted in
    }
    fileTransferSupportCache.set(domain, { at: Date.now(), value });
    return value;
  }

  // Why a held credential cannot be exported to a file, or null if it can
  // (as far as this wallet can tell without asking the issuer).
  async function assetFileExportProblem(credential) {
    if (!credential || !credential.asset) return 'Nothing to export.';
    if (credential.asset.fungible !== false) return 'Only a single unique item can be saved to a file. Split a balance first.';
    if (credential.asset.tradeScope === 'bound') return 'This item is bound to you and cannot be given to anyone else.';
    const support = await getFileTransferSupport(credential.issuer.domain);
    if (!support.enabled) return credential.issuer.domain + ' has not enabled saving items to a file.';
    if (support.classes && !support.classes.includes(credential.asset.class)) return credential.issuer.domain + ' does not allow this kind of item to be saved to a file.';
    return null;
  }

  // Moves one held unique asset into a claimable file. The export is written
  // to the ledger before anything is sent, so a lost reply, a crash or a
  // failed save afterwards leaves a record to settle instead of an item that
  // has vanished: the issuer may already have revoked the original. Nothing
  // else changes locally until a file is in hand; then the file is stored
  // before the asset leaves the wallet list.
  async function exportAssetToFile(credentialId) {
    const identity = await getIdentity();
    if (!identity) throw new Error('Unlock your wallet first.');
    const entry = (await getWallet(identity.publicKey)).find((e) => e.credential.id === credentialId);
    if (!entry) throw new Error('That item is not in this wallet.');
    const credential = entry.credential;
    const problem = await assetFileExportProblem(credential);
    if (problem) throw new Error(problem);
    if ((await getInterruptedExports(identity.publicKey)).some((r) => r.sourceId === credential.id)) {
      throw new Error('An earlier attempt to save this item is still being settled with ' + credential.issuer.domain + '.');
    }

    const payload = { credentialId: credential.id, action: 'transfer-to-file' };
    const proof = await signWithSelf(payload);

    const ledger = await getAssetFiles(identity.publicKey);
    ledger.unshift({
      direction: 'exported', state: 'requesting', sourceId: credential.id, credential,
      name: credential.asset.name, class: credential.asset.class, domain: credential.issuer.domain, at: new Date().toISOString()
    });
    await saveAssetFiles(identity.publicKey, ledger);

    let data = null;
    let status = 0;
    let reached = false;
    try {
      const res = await fetch(baseUrl(credential.issuer.domain) + '/atlas/asset/transfer-to-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential, intent: { payload, proof } })
      });
      status = res.status;
      reached = true;
      data = await res.json().catch(() => null);
    } catch (err) {
      // no usable reply
    }

    if (reached && status === 200 && data && data.file && data.file.id) {
      try {
        await finishExport(identity.publicKey, credential.id, data.file, credential);
        return data.file;
      } catch (err) {
        await markExportInterrupted(identity.publicKey, credential.id, 'The file arrived but could not be saved: ' + err.message);
        return settleOrThrowInterrupted(credential);
      }
    }
    if (reached && data && typeof data.error === 'string' && assetFileRefusalIsDefinite(status, data)) {
      await dropExportRecord(identity.publicKey, credential.id);
      throw new Error(data.error);
    }
    await markExportInterrupted(identity.publicKey, credential.id, reached ? 'Unexpected reply (' + status + ').' : 'No reply from ' + credential.issuer.domain + '.');
    return settleOrThrowInterrupted(credential);
  }

  // A refusal that proves the issuer did nothing: a client error with an
  // error message from the issuer itself. A conflict means another request
  // may be mid-flight, so it is settled like a lost reply instead.
  function assetFileRefusalIsDefinite(status, data) {
    if (status < 400 || status >= 500) return false;
    if ([408, 409, 425, 429].includes(status)) return false;
    return data.code !== 'already-exported';
  }

  // Tries recovery straight away. Returns the file if it works; otherwise
  // throws an error flagged `interrupted` that says the wallet will keep
  // checking.
  async function settleOrThrowInterrupted(credential) {
    let outcome = null;
    try {
      outcome = await recoverInterruptedExport(credential.id);
    } catch (err) {
      // stays interrupted
    }
    if (outcome && outcome.file) return outcome.file;
    if (outcome && outcome.outcome === 'not-exported') {
      throw new Error('The save did not go through. Nothing was lost: the item is still in your wallet.');
    }
    const err = new Error('The reply from ' + credential.issuer.domain + ' was lost, so it is not certain whether the item was saved. Your wallet keeps checking and will list it under "Saved transfer files" once the issuer confirms.');
    err.interrupted = true;
    throw err;
  }

  async function markExportInterrupted(ownerPublicKey, sourceId, reason) {
    const ledger = await getAssetFiles(ownerPublicKey);
    const record = ledger.find((r) => r.direction === 'exported' && r.sourceId === sourceId && ['requesting', 'interrupted'].includes(r.state));
    if (!record) return;
    record.state = 'interrupted';
    record.lastError = reason;
    await saveAssetFiles(ownerPublicKey, ledger);
  }

  async function dropExportRecord(ownerPublicKey, sourceId) {
    const ledger = await getAssetFiles(ownerPublicKey);
    await saveAssetFiles(ownerPublicKey, ledger.filter((r) => !(r.direction === 'exported' && r.sourceId === sourceId && ['requesting', 'interrupted', 'lost'].includes(r.state))));
  }

  async function removeFromWalletList(ownerPublicKey, credentialId) {
    await withWalletLock(async () => {
      await saveWallet(ownerPublicKey, (await getWallet(ownerPublicKey)).filter((e) => e.credential.id !== credentialId));
    });
    await unloadItem(credentialId);
  }

  // Turns the record for `sourceId` into a pending export holding `file`,
  // then takes the original out of the wallet. Safe to run again: if the
  // record is already pending it only finishes the removal.
  async function finishExport(ownerPublicKey, sourceId, file, originalCredential) {
    const ledger = await getAssetFiles(ownerPublicKey);
    let existing = ledger.find((r) => r.direction === 'exported' && r.sourceId === sourceId);
    if (!existing) {
      // The record was settled elsewhere while the reply was on its way; the
      // file in hand is the truth, so record it.
      if (!originalCredential) throw new Error('No record of this export.');
      existing = {
        direction: 'exported', state: 'requesting', sourceId, credential: originalCredential,
        name: originalCredential.asset.name, class: originalCredential.asset.class, domain: originalCredential.issuer.domain, at: new Date().toISOString()
      };
      ledger.unshift(existing);
    }
    const original = existing.credential || originalCredential || null;
    if (existing.state !== 'pending') {
      existing.fileId = file.id;
      existing.state = 'pending';
      existing.file = file;
      delete existing.credential;
      delete existing.lastError;
      existing.at = new Date().toISOString();
      await saveAssetFiles(ownerPublicKey, ledger);
    }
    await removeFromWalletList(ownerPublicKey, sourceId);
    await logActivity('asset', 'Saved ' + (existing.name || (original && original.asset.name) || 'an item') + ' to a transfer file', { fileId: file.id, sourceId });
  }

  // Asks the issuer what became of an export this wallet recorded but never
  // saw the result of (SPEC.md §13.5.1). Authorized by a signature over a
  // fresh single-use challenge from the issuer. Returns
  //   {outcome: 'recovered', file}  the export finished; the file is stored
  //   {outcome: 'not-exported'}     the issuer never did it; nothing lost
  //   {outcome: 'claimed'|'revoked'|'abandoned'}  settled without a file
  //   {outcome: 'lost'}             needs the issuer's help
  //   {outcome: 'waiting', reason}  suspended or mid-claim; try again later
  // and throws if the issuer cannot be reached (the record stays as it is).
  async function recoverInterruptedExport(sourceId) {
    const identity = await getIdentity();
    if (!identity) throw new Error('Unlock your wallet first.');
    const record = (await getInterruptedExports(identity.publicKey)).find((r) => r.sourceId === sourceId && r.state !== 'lost');
    if (!record) throw new Error('No interrupted export with that id.');
    if (!validAssetFileDomain(record.domain)) throw new Error('This export names an issuer domain this wallet will not contact.');
    const base = baseUrl(record.domain);

    const challengeRes = await fetch(base + '/atlas/asset/recover-file-export-challenge', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credentialId: sourceId })
    });
    const challengeData = await challengeRes.json().catch(() => null);
    if (!challengeRes.ok || !challengeData || typeof challengeData.challenge !== 'string') throw new Error('The issuer could not give a recovery challenge (' + challengeRes.status + ').');

    const payload = { credentialId: sourceId, action: 'recover-file-export', challenge: challengeData.challenge };
    const proof = await signWithSelf(payload);
    const res = await fetch(base + '/atlas/asset/recover-file-export', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ intent: { payload, proof } })
    });
    const data = await res.json().catch(() => null);
    if (!data) throw new Error('Unreadable reply from the issuer (' + res.status + ').');

    if (res.status === 200 && data.status === 'pending') {
      const file = data.file;
      const problem = assetFileShapeProblem(file);
      if (problem || file.supersedes !== sourceId || file.issuer.domain !== record.domain) {
        throw new Error('The issuer returned a file that does not match this export.');
      }
      const verdict = await verifyCredential(file);
      if (!verdict.valid) throw new Error('The issuer returned a file that does not verify: ' + verdict.reason + '.');
      await finishExport(identity.publicKey, sourceId, file);
      return { outcome: 'recovered', file };
    }
    if (res.status === 404 && data.code === 'not-found') {
      // The issuer has no export for this item. If the original is still
      // good, the request never took effect and nothing was lost.
      if (Date.now() - Date.parse(record.at) < EXPORT_RECOVERY_GRACE_MS) {
        return { outcome: 'waiting', reason: 'The issuer has no record of this save yet. Checking again shortly.' };
      }
      const original = record.credential;
      const verdict = original ? await verifyCredential(original) : { valid: false, reason: 'no copy of the original' };
      if (verdict.valid) {
        await dropExportRecord(identity.publicKey, sourceId);
        return { outcome: 'not-exported' };
      }
      const ledger = await getAssetFiles(identity.publicKey);
      const r = ledger.find((x) => x.direction === 'exported' && x.sourceId === sourceId && ['requesting', 'interrupted'].includes(x.state));
      if (r) { r.state = 'lost'; r.lastError = 'The issuer has no record of this save, and the item is no longer valid (' + verdict.reason + ').'; await saveAssetFiles(identity.publicKey, ledger); }
      return { outcome: 'lost' };
    }
    if (res.status === 409 && data.code) {
      if (data.code === 'already-claimed' || data.code === 'file-revoked' || data.code === 'export-abandoned') {
        const outcome = data.code === 'already-claimed' ? 'claimed' : data.code === 'file-revoked' ? 'revoked' : 'abandoned';
        const ledger = await getAssetFiles(identity.publicKey);
        const r = ledger.find((x) => x.direction === 'exported' && x.sourceId === sourceId && ['requesting', 'interrupted'].includes(x.state));
        if (r) {
          r.state = outcome === 'claimed' ? 'claimed-by-other' : outcome === 'revoked' ? 'revoked' : 'abandoned';
          r.fileId = data.receipt && data.receipt.fileId;
          delete r.credential;
          delete r.lastError;
          await saveAssetFiles(identity.publicKey, ledger);
        }
        if (outcome !== 'abandoned') await removeFromWalletList(identity.publicKey, sourceId);
        return { outcome };
      }
      if (data.code === 'suspended' || data.code === 'in-progress') return { outcome: 'waiting', reason: data.error || data.code };
    }
    throw new Error(data.error || ('Recovery failed: ' + res.status));
  }

  // Settles every interrupted export. `auto` is for background use: it
  // skips identities whose signature needs a person present (a passkey) and
  // tries each export at most once every 20 seconds. Returns one entry per
  // export tried: {sourceId, outcome | error}.
  const exportRecoveryAttempts = new Map();
  async function recoverInterruptedExports(options) {
    const auto = !(options && options.auto === false);
    const identity = await getIdentity();
    if (!identity) return [];
    if (auto && (await getIdentityMode()) === 'webauthn') return [];
    const results = [];
    for (const record of await getInterruptedExports(identity.publicKey)) {
      if (record.state === 'lost') continue;
      const last = exportRecoveryAttempts.get(record.sourceId) || 0;
      if (auto && Date.now() - last < 20000) continue;
      exportRecoveryAttempts.set(record.sourceId, Date.now());
      try {
        const r = await recoverInterruptedExport(record.sourceId);
        results.push({ sourceId: record.sourceId, ...r });
      } catch (err) {
        results.push({ sourceId: record.sourceId, error: err.message });
      }
    }
    return results;
  }

  // Removes the note about an export the issuer could not account for.
  async function dismissLostExport(sourceId) {
    const identity = await getIdentity();
    if (!identity) throw new Error('Unlock your wallet first.');
    await dropExportRecord(identity.publicKey, sourceId);
  }

  // Looks at a file's text and says what it is and what can be done with
  // it, without changing anything. `relation` is one of: invalid,
  // wallet-export, already-in-wallet, previously-claimed, revoked,
  // already-claimed, suspended, not-a-file, not-eligible, unreachable,
  // backup-copy, own-pending-export, claim-interrupted, claim-receipt-only,
  // claimable.
  async function inspectAssetFile(text) {
    const out = (relation, headline, extra) => ({ relation, headline, details: [], credential: null, verdict: null, canClaim: false, canRestore: false, canFinishClaim: false, ...(extra || {}) });
    if (typeof text !== 'string' || text.length === 0) return out('invalid', 'The file is empty.');
    if (text.length > ASSET_FILE_MAX_BYTES) return out('invalid', 'The file is too large to be an asset file.');
    let credential;
    try {
      credential = JSON.parse(text);
    } catch (err) {
      return out('invalid', 'The file is not valid JSON.');
    }
    if (credential && credential.format === 'atlas-wallet-export/1.0') {
      return out('wallet-export', 'This is a whole-wallet export. Use "Import wallet file" in Settings for those.');
    }
    const shapeProblem = assetFileShapeProblem(credential);
    if (shapeProblem) return out('invalid', shapeProblem);

    const identity = await getIdentity();
    if (!identity) return out('invalid', 'Unlock your wallet first.');
    const base = { credential };

    const wallet = await getWallet(identity.publicKey);
    if (wallet.some((e) => e.credential.id === credential.id)) {
      return out('already-in-wallet', 'This item is already in your wallet.', base);
    }
    const ledger = await getAssetFiles(identity.publicKey);
    const claimedBefore = ledger.find((r) => r.direction === 'claimed' && r.fileId === credential.id);
    if (claimedBefore) {
      const stillHeld = wallet.some((e) => e.credential.id === claimedBefore.newId);
      return out('previously-claimed', 'You already claimed this file on ' + new Date(claimedBefore.at).toLocaleString() + (stillHeld ? '; the item is in your wallet.' : '; the item has since left your wallet.'), base);
    }

    const claiming = ledger.find((r) => r.direction === 'claiming' && r.fileId === credential.id);
    if (claiming) {
      if (claiming.state === 'receipt-only') {
        return out('claim-receipt-only', 'You claimed this file with your key, but the issuer no longer keeps the credential. Contact ' + credential.issuer.domain + ' with claim ' + claiming.receipt.claimId + '.', base);
      }
      return out('claim-interrupted', 'You already started claiming this file and the issuer\'s reply was lost. Finishing it gives you the same item; nothing is claimed twice.', { ...base, canFinishClaim: true });
    }

    const verdict = await verifyCredential(credential);
    const domain = credential.issuer.domain;
    if (!verdict.valid) {
      if (verdict.reason === 'revoked by issuer') {
        let state = 'revoked';
        try { state = (await fetchAssetFileStatus(domain, credential.id)).state; } catch (err) { /* keep 'revoked' */ }
        if (state === 'claimed') return out('already-claimed', 'Someone has already claimed this file.', { ...base, verdict });
        return out('revoked', 'This credential has been revoked by its issuer, so it no longer counts for anything.', { ...base, verdict });
      }
      return out('invalid', 'This file could not be verified: ' + verdict.reason + '.', { ...base, verdict });
    }
    const verified = ['Signed by ' + domain + ' (checked against its published key)', 'Not revoked, not expired'];

    if (credential.owner.publicKey === identity.publicKey) {
      return out('backup-copy', 'This is a copy of an item that belongs to your key. Adding it puts it back in your wallet.', { ...base, verdict, details: verified, canRestore: true });
    }
    if (credential.asset.fungible !== false) return out('not-eligible', 'Only a single unique item can be claimed from a file.', { ...base, verdict, details: verified });
    if (credential.asset.tradeScope === 'bound') return out('not-eligible', 'This item is bound to its owner and cannot be claimed from a file.', { ...base, verdict, details: verified });

    let status;
    try {
      status = await fetchAssetFileStatus(domain, credential.id);
    } catch (err) {
      return out('unreachable', 'Could not reach ' + domain + ' to check whether this file can still be claimed.', { ...base, verdict, details: verified });
    }
    if (status.state === 'claimed') return out('already-claimed', 'Someone has already claimed this file.', { ...base, verdict, details: verified });
    if (status.state === 'suspended') return out('suspended', 'This item is suspended by its issuer right now and cannot be claimed.', { ...base, verdict, details: verified });
    if (status.state === 'revoked') return out('revoked', 'This credential has been revoked by its issuer.', { ...base, verdict, details: verified });
    if (status.state !== 'claimable') {
      return out('not-a-file', 'This is a genuine credential, but it belongs to another wallet and was not issued as a transfer file, so it cannot be claimed.', { ...base, verdict, details: verified });
    }
    const pending = ledger.find((r) => r.direction === 'exported' && r.state === 'pending' && r.fileId === credential.id);
    if (pending) {
      return out('own-pending-export', 'This is a file you saved yourself and nobody has claimed it. Claiming it puts the item back in your wallet.', { ...base, verdict, details: verified.concat(['Claimable right now at ' + domain]), canClaim: true });
    }
    return out('claimable', 'This file can be claimed.', { ...base, verdict, details: verified.concat(['Claimable right now at ' + domain]), canClaim: true });
  }

  // Safe to run twice for the same claim (a retry that finishes after
  // another one already has): the item and the ledger entry are added once.
  async function addClaimedToWallet(identity, minted, fileCredential) {
    const lastVerdict = await verifyCredential(minted);
    await withWalletLock(async () => {
      const wallet = await getWallet(identity.publicKey);
      if (!wallet.some((e) => e.credential.id === minted.id)) {
        wallet.push({ credential: minted, lastVerdict });
        await saveWallet(identity.publicKey, wallet);
      }
    });
    const ledger = await getAssetFiles(identity.publicKey);
    if (!ledger.some((r) => r.direction === 'claimed' && r.fileId === fileCredential.id)) {
      ledger.unshift({
        fileId: fileCredential.id, direction: 'claimed', newId: minted.id,
        name: fileCredential.asset.name, class: fileCredential.asset.class, domain: fileCredential.issuer.domain, at: new Date().toISOString()
      });
      await saveAssetFiles(identity.publicKey, ledger);
    }
  }

  // Claims the file's credential for this wallet's key. The issuer decides:
  // the first claim wins and every other copy of the file stops working.
  // Failures carry the issuer's `code` (already-claimed, not-claimable, ...).
  //
  // A claim is recorded in the ledger BEFORE it is sent, together with the
  // file, as {direction:'claiming', state, fileId, file, ...}. The issuer
  // commits a claim before it answers (SPEC.md §13.5.2), so if the reply is
  // lost the same request, repeated, returns the same credential. Such a
  // record is settled by recoverInterruptedClaim():
  //   claiming     sent, no answer seen yet
  //   interrupted  the reply was lost or unreadable; retried automatically
  //   receipt-only the issuer minted the item for this key but no longer
  //                keeps the credential (its replay window ended); the
  //                receipt is kept for the person to take to the issuer
  async function claimAssetFile(credential) {
    const identity = await getIdentity();
    if (!identity) throw new Error('Unlock your wallet first.');
    const problem = assetFileShapeProblem(credential);
    if (problem) throw new Error(problem);
    if (credential.asset.fungible !== false || credential.asset.tradeScope === 'bound') throw new Error('This item cannot be claimed from a file.');

    await recordClaimAttempt(identity.publicKey, credential);
    let result = await attemptClaim(credential.id);
    if (result.outcome === 'waiting') result = await attemptClaim(credential.id);
    return claimResultOrThrow(result, credential);
  }

  function claimResultOrThrow(result, credential) {
    if (result.outcome === 'claimed') return result.credential;
    let err;
    if (result.outcome === 'claimed-by-other') {
      err = new Error('Someone else has already claimed this file.');
      err.code = 'already-claimed';
    } else if (result.outcome === 'receipt-only') {
      err = new Error('This file was claimed by your key, but the issuer no longer keeps the credential. Contact ' + credential.issuer.domain + ' with claim ' + result.receipt.claimId + '.');
      err.code = 'already-claimed';
      err.receipt = result.receipt;
    } else if (result.outcome === 'refused') {
      err = new Error(result.error);
      err.code = result.code || null;
    } else {
      err = new Error('The reply from ' + credential.issuer.domain + ' was lost, so it is not certain whether the claim went through. Your wallet keeps checking and will add the item as soon as the issuer confirms.');
      err.interrupted = true;
    }
    throw err;
  }

  async function recordClaimAttempt(ownerPublicKey, file) {
    const ledger = await getAssetFiles(ownerPublicKey);
    const existing = ledger.find((r) => r.direction === 'claiming' && r.fileId === file.id);
    if (existing) {
      if (existing.state === 'receipt-only') {
        const err = new Error('This file was claimed by your key earlier; see "Saved transfer files".');
        err.code = 'already-claimed';
        err.receipt = existing.receipt;
        throw err;
      }
      if (!existing.file) existing.file = file;
      await saveAssetFiles(ownerPublicKey, ledger);
      return;
    }
    ledger.unshift({
      direction: 'claiming', state: 'claiming', fileId: file.id, file,
      name: file.asset.name, class: file.asset.class, domain: file.issuer.domain, at: new Date().toISOString()
    });
    await saveAssetFiles(ownerPublicKey, ledger);
  }

  async function dropClaimRecord(ownerPublicKey, fileId) {
    const ledger = await getAssetFiles(ownerPublicKey);
    await saveAssetFiles(ownerPublicKey, ledger.filter((r) => !(r.direction === 'claiming' && r.fileId === fileId)));
  }

  // One request for a recorded claim. Returns
  //   {kind:'claimed', credential}
  //   {kind:'unsure', reason}                  no usable answer
  //   {kind:'other'}                           someone else holds the claim
  //   {kind:'receipt', receipt}                this key claimed it, replay window over
  //   {kind:'refused', code, error}            the issuer refused; nothing was claimed
  async function sendClaim(identity, file) {
    const payload = { credentialId: file.id, newOwnerPublicKey: identity.publicKey, action: 'claim-from-file' };
    const proof = await signWithSelf(payload);
    let res;
    let data = null;
    try {
      res = await fetch(baseUrl(file.issuer.domain) + '/atlas/asset/claim-from-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential: file, intent: { payload, proof } })
      });
      data = await res.json().catch(() => null);
    } catch (err) {
      return { kind: 'unsure', reason: 'No reply from ' + file.issuer.domain + '.' };
    }
    if (res.status === 200 && data && data.status === 'claimed') {
      const minted = data.credential;
      if (!minted || !minted.owner || minted.owner.publicKey !== identity.publicKey || minted.supersedes !== file.id) {
        return { kind: 'unsure', reason: 'The issuer returned a credential that does not belong to this wallet.' };
      }
      return { kind: 'claimed', credential: minted };
    }
    if (!data || res.status >= 500 || [200, 408, 425, 429].includes(res.status)) {
      return { kind: 'unsure', reason: 'Unexpected reply from ' + file.issuer.domain + ' (' + res.status + ').' };
    }
    if (res.status === 409 && !data.code) return { kind: 'unsure', reason: data.error || 'The issuer is busy with this item.' };
    if (res.status === 409 && data.code === 'already-claimed') {
      if (data.receipt && typeof data.receipt.claimId === 'string') return { kind: 'receipt', receipt: data.receipt };
      return { kind: 'other' };
    }
    return { kind: 'refused', code: data.code || null, error: data.error || ('Claim failed: ' + res.status) };
  }

  // Sends the recorded claim for `fileId` once and settles the record.
  // Concurrent calls for one file share a single request. Returns
  //   {outcome:'claimed', credential} | {outcome:'claimed-by-other'}
  //   {outcome:'receipt-only', receipt} | {outcome:'refused', code, error}
  //   {outcome:'waiting', reason}   no answer; the record stays
  const claimsInFlight = new Map();
  function attemptClaim(fileId) {
    const running = claimsInFlight.get(fileId);
    if (running) return running;
    const promise = (async () => {
      const identity = await getIdentity();
      if (!identity) throw new Error('Unlock your wallet first.');
      const record = (await getAssetFiles(identity.publicKey)).find((r) => r.direction === 'claiming' && r.fileId === fileId && r.file);
      if (!record) throw new Error('No interrupted claim with that id.');
      if (!validAssetFileDomain(record.domain) || record.file.issuer.domain !== record.domain) throw new Error('This claim names an issuer domain this wallet will not contact.');
      const sent = await sendClaim(identity, record.file);
      if (sent.kind === 'claimed') {
        await addClaimedToWallet(identity, sent.credential, record.file);
        await dropClaimRecord(identity.publicKey, fileId);
        await updateAssetFileRecord(identity.publicKey, fileId, 'exported', (r) => { if (r.state === 'pending') { r.state = 'reclaimed'; delete r.file; } });
        await logActivity('asset', 'Claimed ' + record.name + ' from a transfer file', { fileId, newId: sent.credential.id });
        return { outcome: 'claimed', credential: sent.credential };
      }
      if (sent.kind === 'unsure') {
        const ledger = await getAssetFiles(identity.publicKey);
        const r = ledger.find((x) => x.direction === 'claiming' && x.fileId === fileId);
        if (r) { r.state = 'interrupted'; r.lastError = sent.reason; await saveAssetFiles(identity.publicKey, ledger); }
        return { outcome: 'waiting', reason: sent.reason };
      }
      if (sent.kind === 'receipt') {
        const ledger = await getAssetFiles(identity.publicKey);
        const r = ledger.find((x) => x.direction === 'claiming' && x.fileId === fileId);
        if (r) { r.state = 'receipt-only'; r.receipt = sent.receipt; delete r.file; delete r.lastError; await saveAssetFiles(identity.publicKey, ledger); }
        return { outcome: 'receipt-only', receipt: sent.receipt };
      }
      await dropClaimRecord(identity.publicKey, fileId);
      if (sent.kind === 'other') {
        await updateAssetFileRecord(identity.publicKey, fileId, 'exported', (r) => { if (r.state === 'pending') { r.state = 'claimed-by-other'; delete r.file; } });
        return { outcome: 'claimed-by-other' };
      }
      return { outcome: 'refused', code: sent.code, error: sent.error };
    })();
    claimsInFlight.set(fileId, promise);
    const clear = () => { if (claimsInFlight.get(fileId) === promise) claimsInFlight.delete(fileId); };
    promise.then(clear, clear);
    return promise;
  }

  // Claims whose outcome this wallet has not yet seen, including those that
  // ended as a receipt only.
  async function getInterruptedClaims(ownerPublicKey) {
    return (await getAssetFiles(ownerPublicKey)).filter((r) => r.direction === 'claiming');
  }

  // Settles one recorded claim (the person pressed "Check again", or the
  // claim dialog was reopened for the same file).
  async function recoverInterruptedClaim(fileId) {
    return attemptClaim(fileId);
  }

  // Settles every recorded claim. `auto` is for background use: it skips
  // identities whose signature needs a person present (a passkey) and tries
  // each claim at most once every 20 seconds.
  const claimRecoveryAttempts = new Map();
  async function recoverInterruptedClaims(options) {
    const auto = !(options && options.auto === false);
    const identity = await getIdentity();
    if (!identity) return [];
    if (auto && (await getIdentityMode()) === 'webauthn') return [];
    const results = [];
    for (const record of await getInterruptedClaims(identity.publicKey)) {
      if (record.state === 'receipt-only' || !record.file) continue;
      const last = claimRecoveryAttempts.get(record.fileId) || 0;
      if (auto && Date.now() - last < 20000) continue;
      claimRecoveryAttempts.set(record.fileId, Date.now());
      try {
        results.push({ fileId: record.fileId, ...(await attemptClaim(record.fileId)) });
      } catch (err) {
        results.push({ fileId: record.fileId, error: err.message });
      }
    }
    return results;
  }

  // Removes the note about a claim that ended as a receipt only.
  async function dismissClaimRecord(fileId) {
    const identity = await getIdentity();
    if (!identity) throw new Error('Unlock your wallet first.');
    await dropClaimRecord(identity.publicKey, fileId);
  }

  // A file whose credential is already owned by this wallet's key (a copy
  // saved earlier): nothing to claim, just put it back after verifying it.
  async function restoreAssetCopy(credential) {
    const identity = await getIdentity();
    if (!identity) throw new Error('Unlock your wallet first.');
    const problem = assetFileShapeProblem(credential);
    if (problem) throw new Error(problem);
    if (credential.owner.publicKey !== identity.publicKey) throw new Error('This copy belongs to a different key.');
    const verdict = await verifyCredential(credential);
    if (!verdict.valid) throw new Error('This copy is no longer valid: ' + verdict.reason + '.');
    const wallet = await getWallet(identity.publicKey);
    if (wallet.some((e) => e.credential.id === credential.id)) throw new Error('This item is already in your wallet.');
    wallet.push({ credential, lastVerdict: verdict });
    await saveWallet(identity.publicKey, wallet);
    await logActivity('asset', 'Restored ' + credential.asset.name + ' from a saved copy', { id: credential.id });
    return credential;
  }

  async function updateAssetFileRecord(ownerPublicKey, fileId, direction, mutate) {
    const ledger = await getAssetFiles(ownerPublicKey);
    const record = ledger.find((r) => r.fileId === fileId && r.direction === direction);
    if (!record) return null;
    mutate(record);
    await saveAssetFiles(ownerPublicKey, ledger);
    return record;
  }

  // Asks the issuer whether a file this wallet saved is still unclaimed.
  // Once someone else has claimed it the file is worthless, so the stored
  // copy is dropped. Returns the issuer's state.
  async function checkPendingExport(fileId) {
    const identity = await getIdentity();
    if (!identity) throw new Error('Unlock your wallet first.');
    const record = (await getPendingExports(identity.publicKey)).find((r) => r.fileId === fileId);
    if (!record) throw new Error('No pending export with that id.');
    const status = await fetchAssetFileStatus(record.domain, fileId);
    if (status.state === 'claimed' || status.state === 'revoked') {
      await updateAssetFileRecord(identity.publicKey, fileId, 'exported', (r) => { r.state = status.state === 'claimed' ? 'claimed-by-other' : 'revoked'; delete r.file; });
    }
    return status.state;
  }

  // Claims back a file this wallet saved earlier, racing anyone else who
  // holds a copy of it.
  async function reclaimPendingExport(fileId) {
    const identity = await getIdentity();
    if (!identity) throw new Error('Unlock your wallet first.');
    const record = (await getPendingExports(identity.publicKey)).find((r) => r.fileId === fileId);
    if (!record) throw new Error('No pending export with that id.');
    let minted;
    try {
      minted = await claimAssetFile(record.file);
    } catch (err) {
      if (err.code === 'already-claimed' && !err.receipt) {
        await updateAssetFileRecord(identity.publicKey, fileId, 'exported', (r) => { r.state = 'claimed-by-other'; delete r.file; });
      }
      throw err;
    }
    await updateAssetFileRecord(identity.publicKey, fileId, 'exported', (r) => { r.state = 'reclaimed'; delete r.file; });
    return minted;
  }

  // Throws away the stored copy of a saved file. Only sensible once the
  // person has confirmed someone claimed it or has decided to let it go.
  async function forgetPendingExport(fileId) {
    const identity = await getIdentity();
    if (!identity) throw new Error('Unlock your wallet first.');
    await updateAssetFileRecord(identity.publicKey, fileId, 'exported', (r) => { r.state = 'forgotten'; delete r.file; });
    await logActivity('asset', 'Discarded the stored copy of a transfer file', { fileId });
  }

  // ---------- full account backup / restore (task #122) ----------
  //
  // exportWallet()/importWallet() above only ever moved PUBLIC asset
  // credentials — nothing secret, no identity, by design (see its own
  // comment). This is the other thing entirely: a real backup of this
  // local identity plus every piece of personal data now encrypted at
  // rest under it (see the whole-storage encryption pass just above —
  // Wallet/Mail/Trades/Contacts/Calendar/Chat/etc.), meant to survive
  // this device dying and be restorable onto a fresh one that has never
  // unlocked this identity before.
  //
  // That last requirement is exactly why this can't just be "re-encrypt
  // the session-cached key under a backup password": a session cache only
  // exists on a device that has already unlocked once. Instead this reuses
  // exportIdentity()/importIdentity()'s own two-secret model verbatim —
  // password + seed phrase combined via deriveAesKey, at the current KDF
  // iteration count, with the same "don't trust the session cache, ask for
  // the password again" rigor — since a full backup is strictly MORE
  // sensitive than the identity alone (it also carries every message,
  // trade, and contact this identity has), not less. WebAuthn identities
  // are out of scope for the same reason they're out of scope for
  // exportIdentity(): the private key never leaves the authenticator, so
  // there is nothing exportable to bundle.
  //
  // Design choice worth calling out: rather than hand-rolling a fresh
  // read/decrypt/re-encrypt/write path for each of the ~15 data families
  // below (each with its own legacy-migration quirks — see e.g.
  // isLegacyFlatAliases above), export calls the SAME getX() getters the
  // UI already uses (which already resolve migration + decryption), and
  // import calls the SAME saveX() setters (which already re-encrypt under
  // whatever identity is active) — the backup file itself carries plain
  // decrypted values, protected by the one outer password+seed-phrase
  // layer instead of by each store's own per-identity key. This is far
  // less code and far less likely to silently mis-handle one of those
  // migration edge cases than reimplementing storage access from scratch.
  // Assembles the exact same {identity, data, settings} shape both
  // exportFullBackup (below) and the automatic backup replication feature
  // (further down this file) protect — factored out so there's only ONE
  // place that knows which ~15 data families a full backup covers. Calls
  // the SAME getX() getters the UI already uses (see this section's
  // original comment above for why), never a raw storage read.
  async function buildBackupPayload(identity) {
    const owner = identity.publicKey;
    const [
      wallet, mail, sentMail, submittedTrades, assetUpdateNotices,
      friends, contactGroups, aliases, recentWorlds, favoriteDomains, calendarEvents,
      mutedChatUsers, blockedChatUsers, loadout, chatMessages, counterparty,
      chatE2eeKeyPair, chatE2eePeerKeys, activityLog, assetFiles, friendRequests
    ] = await Promise.all([
      // Task #250: dropped items no longer have a local-only "still
      // secretly mine" state to back up — a drop now genuinely leaves this
      // wallet (see dropItem()'s own comment) and lives server-side on
      // whichever world hosts it, not in this device's own storage.
      getWallet(owner), getMail(owner), getSentMail(owner), getSubmittedTrades(owner), getAssetUpdateNotices(owner),
      getFriends(), getContactGroups(), getAliasesForOwner(identity), getRecentWorlds(), getFavoriteDomains(), getCalendarEvents(),
      getMutedChatUsers(), getBlockedChatUsers(), getLoadout(), getChatMessages(owner), getCounterparty(),
      // Task #158 — without these, a restore would generate a BRAND NEW
      // e2ee keypair on the new device, permanently losing the ability to
      // decrypt this identity's past end-to-end-encrypted chat threads
      // (the shared secret is tied to this exact keypair) and forgetting
      // every peer key this identity had already verified.
      getChatE2eeKeyPair(identity), getE2eePeerKeysForOwner(identity),
      // The activity log is a data family like any other above: a restore
      // should bring someone's history back with it, not reset it.
      getActivityLog(),
      // Saved transfer files hold the only copy of an exported asset until
      // someone claims it, so a restore must bring them back.
      getAssetFiles(owner),
      // Pending friend requests (both directions) and undelivered
      // acceptances; without them a restore would forget who is waiting.
      getFriendRequestState(owner)
    ]);

    // Low-sensitivity per-owner bookkeeping that was never wrapped in
    // encryptAtRest to begin with (just IDs and domain names — see each
    // key's own comment further down in this file). Included anyway for
    // restore fidelity: without atlasDeletedMailIds/atlasDeletedChatIds a
    // restore would resurrect mail/chat this identity explicitly deleted,
    // and without the "last domain used" pair Compose/Chat would forget a
    // pure convenience default.
    const [deletedMailIdsAll, deletedChatIdsAll, lastChatSendDomainAll, lastPostOfficeSendDomainAll, lastPostOfficeSettingsDomainAll] = await Promise.all([
      chrome.storage.local.get('atlasDeletedMailIds'),
      chrome.storage.local.get('atlasDeletedChatIds'),
      chrome.storage.local.get('atlasLastChatSendDomain'),
      chrome.storage.local.get('atlasLastPostOfficeSendDomain'),
      chrome.storage.local.get('atlasLastPostOfficeSettingsDomain')
    ]);

    // Device-level UI preferences — not identity-scoped at all, but
    // carried along so restoring onto a fresh device feels like picking
    // this one back up rather than starting cold on settings too.
    const settingsRaw = await chrome.storage.local.get([
      'atlasChatPanelSettings', 'atlasMailSettings', 'atlasAssetViewerSettings',
      'atlasMessagingWindowSettings', 'atlasCharacterScale', 'atlasAutoLockMinutes',
      'atlasInventoryFilterSettings'
    ]);

    return {
      identity: { publicKey: identity.publicKey, privateKeyJwk: identity.privateKeyJwk },
      data: {
        wallet, mail, sentMail, submittedTrades, assetUpdateNotices,
        friends, contactGroups, aliases, recentWorlds, favoriteDomains, calendarEvents,
        mutedChatUsers, blockedChatUsers, loadout, chatMessages, counterparty,
        chatE2eeKeyPair, chatE2eePeerKeys, activityLog, assetFiles, friendRequests,
        deletedMailIds: (deletedMailIdsAll.atlasDeletedMailIds || {})[owner] || [],
        deletedChatIds: (deletedChatIdsAll.atlasDeletedChatIds || {})[owner] || [],
        lastChatSendDomain: (lastChatSendDomainAll.atlasLastChatSendDomain || {})[owner] || null,
        lastPostOfficeSendDomain: (lastPostOfficeSendDomainAll.atlasLastPostOfficeSendDomain || {})[owner] || null,
        lastPostOfficeSettingsDomain: (lastPostOfficeSettingsDomainAll.atlasLastPostOfficeSettingsDomain || {})[owner] || null
      },
      settings: settingsRaw
    };
  }

  // The counterpart to buildBackupPayload() above — restores every family
  // it assembled back into local storage via the SAME saveX() setters
  // normal use goes through (see this section's original comment for why),
  // so each one gets freshly encrypted under whichever identity is active
  // on THIS device, never a raw copy of another device's ciphertext.
  // Shared by importFullBackup (below) and the automatic-backup restore
  // path (further down this file) — identical restore semantics either
  // way, only how the outer file got decrypted differs between them.
  async function applyBackupPayload(payload, localUnlockPassword, restoreSourceLabel) {
    if (!payload || !payload.identity || !payload.identity.publicKey || !payload.identity.privateKeyJwk) {
      throw new Error('This backup file is missing its identity — it may be corrupted.');
    }
    const { publicKey, privateKeyJwk } = payload.identity;

    // Restore the identity itself first — everything else below is keyed
    // to it. Same local re-encrypt + session-activate as importIdentity().
    // localUnlockPassword is the password the person will use to unlock
    // THIS device going forward — for importFullBackup that's the same
    // password that unlocked the backup file itself (a single secret
    // doing double duty); the automatic-backup restore path below passes
    // its own equivalent through the same way.
    const localSalt = crypto.getRandomValues(new Uint8Array(16));
    const localIv = crypto.getRandomValues(new Uint8Array(12));
    const localKey = await deriveAesKey([localUnlockPassword], localSalt);
    const localPlaintext = new TextEncoder().encode(JSON.stringify({ publicKey, privateKeyJwk }));
    const localCiphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: localIv }, localKey, localPlaintext);
    const restoredIdentityBlob = {
      format: 'atlas-identity-local/1.0',
      publicKey,
      salt: b64urlEncode(localSalt.buffer),
      iv: b64urlEncode(localIv.buffer),
      ciphertext: b64urlEncode(localCiphertext),
      kdfIterations: KDF_ITERATIONS_CURRENT,
      createdAt: new Date().toISOString()
    };
    await chrome.storage.local.set({ atlasIdentity: restoredIdentityBlob });
    await chrome.storage.local.set({ atlasIdentityMode: 'local' });
    await chrome.storage.session.set({ atlasUnlockedIdentity: { publicKey, privateKeyJwk } });
    const identity = { mode: 'local', publicKey, privateKeyJwk };
    // Same mismatch-safe reconcile as importIdentity() — a full-backup or
    // auto-backup restore can just as easily bring a different identity
    // active on this device than whatever it had synced before.
    await reconcileIdentitySyncBackupOnIdentityChange(restoredIdentityBlob);

    // Automatic backup, if any, is per-device AND per-identity (the file
    // handle in IndexedDB, and the salt/settings pointing at it, are keyed
    // to whichever identity set it up) — atlasAutoBackupSettings is
    // deliberately not one of the keys buildBackupPayload reads, so it's
    // never carried IN the backup payload itself: a FileSystemFileHandle
    // chosen on one device means nothing on another, so each device sets
    // its own automatic backup destination up independently. A restore
    // onto a device that already had auto-backup configured for a
    // DIFFERENT identity would otherwise leave stale settings claiming
    // it's still "on" for an identity that's no longer active, with every
    // future write silently skipped by the identity-mismatch check in
    // writeAutoBackupNow — turning it off explicitly here means the
    // Settings panel tells the truth instead of quietly lying.
    const existingAutoBackup = await getAutoBackupSettings();
    if (existingAutoBackup && existingAutoBackup.ownerPublicKey && existingAutoBackup.ownerPublicKey !== publicKey) {
      await turnOffAutoBackup(true);
    } else {
      // Same identity restored onto the same device it was already set up
      // on (or nothing was ever set up) — safe to just refresh the cached
      // key under whatever password unlocks this device now.
      await cacheAutoBackupSessionKey(localUnlockPassword);
    }

    const owner = publicKey;
    const d = payload.data || {};
    await Promise.all([
      withWalletLock(() => saveWallet(owner, d.wallet || [])),
      withMessageLock(() => saveMail(owner, d.mail || [])),
      saveSentMail(owner, d.sentMail || []),
      saveSubmittedTrades(owner, d.submittedTrades || []),
      // Task #250: no saveDroppedItems() anymore — an OLDER backup file's
      // d.droppedItems (if present) is simply not restored; the underlying
      // credentials themselves still come back fine via d.wallet above,
      // same as always, they just won't remember which position they were
      // last left sitting at in a scene.
      saveAssetUpdateNotices(owner, d.assetUpdateNotices || []),
      saveFriends(owner, d.friends || []),
      saveContactGroups(owner, d.contactGroups || []),
      saveAliasesForOwner(owner, d.aliases || {}),
      saveRecentWorlds(owner, d.recentWorlds || []),
      saveFavoriteDomains(owner, d.favoriteDomains || []),
      saveCalendarEvents(owner, d.calendarEvents || []),
      saveMutedChatUsers(owner, d.mutedChatUsers || []),
      saveBlockedChatUsers(owner, d.blockedChatUsers || []),
      setLoadout(d.loadout || []),
      withMessageLock(() => saveChatMessages(owner, d.chatMessages || [])),
      saveCounterparty(d.counterparty || null),
      // Task #158 — restoring the SAME e2ee keypair (not generating a
      // fresh one) is what keeps this identity able to decrypt its past
      // end-to-end-encrypted chat threads on the new device; restoring
      // the peer-key cache means it doesn't have to re-bootstrap (an
      // unencrypted first message again) with everyone it already
      // verified a key for.
      ...(d.chatE2eeKeyPair ? [saveChatE2eeKeyPair(owner, d.chatE2eeKeyPair)] : []),
      saveE2eePeerKeysForOwner(owner, d.chatE2eePeerKeys || {}),
      // Carries the restored identity's own activity history back in, same
      // as every other data family here, rather than starting blank.
      saveActivityLog(owner, d.activityLog || []),
      saveAssetFiles(owner, d.assetFiles || []),
      withMessageLock(() => saveFriendRequestState(owner, d.friendRequests))
    ]);

    // Low-sensitivity bookkeeping — restored as a raw per-owner slot
    // merge, exactly matching how each of these keys is written elsewhere
    // in this file (see e.g. addDeletedChatIds/setLastChatSendDomain
    // above), since none of them ever went through encryptAtRest.
    async function restoreOwnerKeyedRaw(topLevelKey, value) {
      if (value === undefined) return;
      const got = await chrome.storage.local.get(topLevelKey);
      const all = got[topLevelKey] || {};
      all[owner] = value;
      await chrome.storage.local.set({ [topLevelKey]: all });
    }
    await Promise.all([
      restoreOwnerKeyedRaw('atlasDeletedMailIds', d.deletedMailIds),
      restoreOwnerKeyedRaw('atlasDeletedChatIds', d.deletedChatIds),
      restoreOwnerKeyedRaw('atlasLastChatSendDomain', d.lastChatSendDomain),
      restoreOwnerKeyedRaw('atlasLastPostOfficeSendDomain', d.lastPostOfficeSendDomain),
      restoreOwnerKeyedRaw('atlasLastPostOfficeSettingsDomain', d.lastPostOfficeSettingsDomain)
    ]);

    // Device-level UI settings — only the keys the backup actually
    // carried are written, so restoring an older-format backup (or one
    // made before some setting existed) can't blank out whatever this
    // device already has configured for a setting the backup never knew
    // about.
    const s = payload.settings || {};
    const settingsToSet = {};
    ['atlasChatPanelSettings', 'atlasMailSettings', 'atlasAssetViewerSettings', 'atlasMessagingWindowSettings', 'atlasCharacterScale', 'atlasAutoLockMinutes', 'atlasInventoryFilterSettings']
      .forEach((k) => { if (s[k] !== undefined) settingsToSet[k] = s[k]; });
    if (Object.keys(settingsToSet).length) await chrome.storage.local.set(settingsToSet);

    // Logged AFTER the activity log itself was just overwritten by the
    // restore above (d.activityLog), so this becomes the newest entry on
    // top of the restored history rather than being wiped by it.
    await logActivity('backup', 'Restored full wallet backup from ' + (restoreSourceLabel || 'a backup file'));
    return { publicKey };
  }

  async function exportFullBackup(password, seedPhrase) {
    const identity = await getIdentity();
    if (!identity || identity.mode !== 'local') {
      throw new Error('Unlock a local password identity first — a WebAuthn identity’s private key never leaves the authenticator, so it can’t be included in a backup.');
    }
    if (!seedPhrase || normalizeSeedPhrase(seedPhrase).split(' ').length < 4) {
      throw new Error('Enter the full seed phrase you were shown when you created this identity.');
    }

    // Re-verify the password against the LOCAL encrypted blob rather than
    // trusting that the wallet happens to be unlocked this session — same
    // reasoning as exportIdentity() above, just for a file that carries
    // far more than the identity alone.
    const { atlasIdentity } = await chrome.storage.local.get('atlasIdentity');
    if (!atlasIdentity) throw new Error('No local identity set up on this device yet.');
    const localSalt = new Uint8Array(b64urlDecode(atlasIdentity.salt));
    const localIv = new Uint8Array(b64urlDecode(atlasIdentity.iv));
    const localKey = await deriveAesKey([password], localSalt, atlasIdentity.kdfIterations || KDF_ITERATIONS_LEGACY);
    try {
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: localIv }, localKey, b64urlDecode(atlasIdentity.ciphertext));
    } catch (err) {
      throw new Error('Incorrect password.');
    }

    const payload = await buildBackupPayload(identity);

    const exportSalt = crypto.getRandomValues(new Uint8Array(16));
    const exportIv = crypto.getRandomValues(new Uint8Array(12));
    const exportKey = await deriveAesKey([password, normalizeSeedPhrase(seedPhrase)], exportSalt);
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: exportIv }, exportKey, new TextEncoder().encode(JSON.stringify(payload))
    );
    await logActivity('backup', 'Full wallet backup exported to a file');
    return {
      format: 'atlas-full-backup/1.0',
      salt: b64urlEncode(exportSalt.buffer),
      iv: b64urlEncode(exportIv.buffer),
      ciphertext: b64urlEncode(ciphertext),
      kdfIterations: KDF_ITERATIONS_CURRENT,
      exportedAt: new Date().toISOString()
    };
  }

  // The counterpart to exportFullBackup() above. Decrypting the file IS
  // the authentication check (same one-shot "success or failure on the
  // whole pair at once" posture as importIdentity()) — there's no partial
  // credit for getting the password right and the seed phrase wrong, or
  // vice versa. On success this both restores the identity (re-encrypted
  // locally under the password alone, exactly like importIdentity()) AND
  // repopulates every data family from the backup via the same saveX()
  // setters normal use goes through, so each one gets freshly encrypted
  // under the restored identity's own key on THIS device — never a raw
  // copy of whatever ciphertext the original device happened to have.
  async function importFullBackup(fileData, password, seedPhrase) {
    if (!fileData || fileData.format !== 'atlas-full-backup/1.0') throw new Error('Not an Atlas full backup file.');
    const salt = new Uint8Array(b64urlDecode(fileData.salt));
    const iv = new Uint8Array(b64urlDecode(fileData.iv));
    const key = await deriveAesKey([password, normalizeSeedPhrase(seedPhrase)], salt, fileData.kdfIterations || KDF_ITERATIONS_LEGACY);
    let payload;
    try {
      const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, b64urlDecode(fileData.ciphertext));
      payload = JSON.parse(new TextDecoder().decode(plaintext));
    } catch (err) {
      throw new Error('Incorrect password or seed phrase.');
    }
    return applyBackupPayload(payload, password, 'a backup file');
  }

  // ---------- automatic encrypted local backup replication ----------
  //
  // exportFullBackup/importFullBackup above are deliberate, occasional,
  // hands-on actions — someone has to remember to run one. Uninstalling
  // the extension (or clearing browser data, or losing the device) without
  // ever having done that loses everything: the identity AND every
  // credential it holds, with no server-side "what does this public key
  // currently hold" registry anywhere to recover it from (this protocol is
  // deliberately bearer-style — see SPEC.md §6). This feature closes that
  // gap by keeping a SEPARATE encrypted copy of the same full-backup
  // payload continuously up to date on the person's own filesystem, via
  // the File System Access API: one ordinary permission prompt, granted
  // once, then silent in-place rewrites on every meaningful change after
  // that — no `chrome.downloads`-style repeated download prompts.
  //
  // Three requirements for this, all load-bearing, not nice-to-haves:
  // explain what's about to happen BEFORE the native picker appears,
  // plainly state what's lost if the person declines, and never write
  // anything to that file unencrypted. See extension/backup-setup.html for
  // where the first two are actually shown to the person — this file only
  // has the third, plus the mechanics.
  //
  // ARCHITECTURE NOTE — why this isn't just a button in this panel: the
  // Settings screen this code otherwise lives behind runs inside a
  // cross-origin (chrome-extension://) iframe embedded in the host page
  // (see content.js's openOverlay()). The File System Access API's picker
  // methods (showSaveFilePicker et al.) refuse to run in a cross-origin
  // nested browsing context at all — there's no Permissions-Policy
  // delegation for it the way iframe.allow covers WebAuthn above. So the
  // actual picker has to run from a genuine top-level extension page,
  // exactly the same problem (and the same fix) identity-popup.html
  // already solved for WebAuthn passkey creation — see backup-setup.html/
  // backup-setup.js, opened via chrome.windows.create() from viewer.js.
  // Both pages share this same chrome-extension:// origin, so IndexedDB
  // (below) is exactly how the handle chosen over there reaches the write
  // logic that actually runs here, inside the iframe, on every change.
  //
  // ENCRYPTION KEY DESIGN — why this is password-only, not password+seed
  // like exportFullBackup, and why it isn't just "whatever key the wallet
  // already has in memory": two real constraints collided here.
  //   1. The file has to be decryptable by someone who has ONLY their
  //      password after a total loss — that rules out deriving the key
  //      from the live private key material cached in chrome.storage.
  //      session while unlocked (atlasUnlockedIdentity): that key is
  //      exactly what a restore is trying to get BACK, so encrypting the
  //      recovery file with it would be circular — decrypting the backup
  //      would require already having the thing the backup exists to
  //      recover.
  //   2. Automatic writes have to happen with no further prompts, which
  //      rules out the seed phrase (shown once at creation, never stored
  //      anywhere, and re-asking for it on every silent write is exactly
  //      the repeated-prompt UX this whole feature exists to avoid) and
  //      rules out re-asking for the password every time too. The
  //      resolution: derive a purpose-scoped AES key from the password
  //      ALONE once per unlock (see cacheAutoBackupSessionKey below), and
  //      cache it in chrome.storage.session — same lifetime as
  //      atlasUnlockedIdentity, cleared on lock, re-derived on next
  //      unlock, never persisted to disk in derived form. This is single-
  //      factor, weaker than exportFullBackup's deliberate two-factor
  //      design — an honest tradeoff, not an oversight — but it matches
  //      requirement 3's actual bar ("never less protected than what's
  //      already sitting in chrome.storage.local today"): the local
  //      atlasIdentity blob itself is ALSO only password-protected.
  //   Deriving a CryptoKey with extractable:true (see deriveAesKey's own
  //   comment above) and exporting its raw bytes to a string is what makes
  //   the caching in chrome.storage.session possible at all — a CryptoKey
  //   object was tried directly and confirmed NOT to survive that specific
  //   storage layer intact (see deriveAesKey's comment for the error this
  //   produced).

  const AUTO_BACKUP_FORMAT = 'atlas-auto-backup/1.0';
  const AUTO_BACKUP_DB_NAME = 'atlas-auto-backup';
  const AUTO_BACKUP_DB_STORE = 'handles';
  const AUTO_BACKUP_WRITE_DEBOUNCE_MS = 4000;

  // wallet.js loads into three different top-level-or-iframe contexts
  // (viewer.html's cross-origin iframe, identity-popup.html,
  // backup-setup.html), and every one of them gets this exact same
  // chrome.storage.onChanged-triggered write pipeline for free. That's a
  // problem specifically for the File System Access permission this
  // feature depends on: per spec, a handle's permission is scoped to the
  // environment that requested it, and queryPermission()/requestPermission()
  // both check that the calling context's origin equals its own top-level
  // origin. The permission is granted from backup-setup.html (a real
  // top-level extension page, chrome-extension://<id>) — so only a write
  // attempted from that exact page can ever succeed. A write attempted
  // from viewer.html's iframe is embedded inside whatever arbitrary site
  // the wallet is open on, so its top-level origin is that site's origin,
  // not the extension's — queryPermission() there reliably reports
  // anything but 'granted', no matter how recently permission was
  // actually given. Letting every context's copy of writeAutoBackupNow()
  // race on every change would mean the iframe's doomed attempt and
  // backup-setup.html's real one both write to atlasAutoBackupSettings,
  // and whichever finishes last decides the visible status — a confusing
  // flicker between "working" and "lapsed" for no functional reason. So
  // this flag gates writeAutoBackupNow() to backup-setup.html only; every
  // other context no-ops immediately, before touching any settings at
  // all, and leaves the status exactly as backup-setup.html last set it.
  const IS_AUTO_BACKUP_WRITER_CONTEXT = typeof location !== 'undefined' && /(^|\/)backup-setup\.html$/.test(location.pathname);

  function openAutoBackupDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(AUTO_BACKUP_DB_NAME, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(AUTO_BACKUP_DB_STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // FileSystemFileHandle objects are real, structured-clonable browser
  // objects that Chromium specifically supports persisting in IndexedDB —
  // they can NOT live in chrome.storage (that API is JSON-only, and the
  // handle isn't JSON-serializable at all). This is the one piece of state
  // in this whole feature that has to go through IndexedDB rather than
  // chrome.storage; everything else (settings, the derived session key)
  // stays in chrome.storage for consistency with the rest of this file.
  async function idbSetAutoBackupHandle(ownerPublicKey, handle) {
    const db = await openAutoBackupDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(AUTO_BACKUP_DB_STORE, 'readwrite');
      tx.objectStore(AUTO_BACKUP_DB_STORE).put(handle, ownerPublicKey);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }

  async function idbGetAutoBackupHandle(ownerPublicKey) {
    const db = await openAutoBackupDb();
    const handle = await new Promise((resolve, reject) => {
      const tx = db.transaction(AUTO_BACKUP_DB_STORE, 'readonly');
      const req = tx.objectStore(AUTO_BACKUP_DB_STORE).get(ownerPublicKey);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return handle;
  }

  async function idbDeleteAutoBackupHandle(ownerPublicKey) {
    const db = await openAutoBackupDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(AUTO_BACKUP_DB_STORE, 'readwrite');
      tx.objectStore(AUTO_BACKUP_DB_STORE).delete(ownerPublicKey);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }

  // atlasAutoBackupSettings shape: { ownerPublicKey, enabled, fileName,
  // salt, kdfIterations, lastWrittenAt, lastError, lapsed }. null/absent
  // means "never set up on this device." Never holds the file handle
  // itself (see IndexedDB helpers above) or anything secret — salt is a
  // KDF parameter, not a key, same as every other salt in this file.
  async function getAutoBackupSettings() {
    const { atlasAutoBackupSettings } = await chrome.storage.local.get('atlasAutoBackupSettings');
    return atlasAutoBackupSettings || null;
  }

  async function setAutoBackupSettings(patch) {
    const current = (await getAutoBackupSettings()) || {};
    const merged = { ...current, ...patch };
    await chrome.storage.local.set({ atlasAutoBackupSettings: merged });
    return merged;
  }

  // See this section's own top comment for why this key is password-only
  // and cached rather than re-derived on every write. A no-op whenever
  // auto-backup isn't enabled, so it's safe to call unconditionally from
  // every place the wallet unlocks (below) without an extra "is this even
  // turned on" check at each call site.
  async function cacheAutoBackupSessionKey(password) {
    const settings = await getAutoBackupSettings();
    if (!settings || !settings.enabled || !settings.salt) return;
    const saltBytes = new Uint8Array(b64urlDecode(settings.salt));
    const key = await deriveAesKey([password], saltBytes, settings.kdfIterations || KDF_ITERATIONS_CURRENT, true);
    const raw = await crypto.subtle.exportKey('raw', key);
    await chrome.storage.session.set({ atlasAutoBackupSessionKey: b64urlEncode(raw) });
  }

  async function clearAutoBackupSessionKey() {
    await chrome.storage.session.remove('atlasAutoBackupSessionKey');
  }

  // Pure encryption step, shared between buildAutoBackupBlob (fresh
  // password, used at setup time and by tests) and writeAutoBackupNow
  // (cached raw session key, used for every silent write after that). A
  // fresh random IV every call — this key is reused across many writes
  // over the file's lifetime, so reusing an IV too is the one mistake
  // AES-GCM can't tolerate.
  async function encryptAutoBackupJson(payloadObj, rawKeyBytes, saltB64, kdfIterations, publicKey) {
    const key = await crypto.subtle.importKey('raw', rawKeyBytes, 'AES-GCM', false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(payloadObj))
    );
    return {
      format: AUTO_BACKUP_FORMAT,
      publicKey,
      salt: saltB64,
      iv: b64urlEncode(iv.buffer),
      ciphertext: b64urlEncode(ciphertext),
      kdfIterations,
      writtenAt: new Date().toISOString()
    };
  }

  // Derives straight from the password rather than any cached session
  // key — used by setUpAutoBackup() for the very first write (mints a
  // fresh salt) and by changePassword (re-keys under an existing salt so
  // the file stays readable with the new password). Also the test-
  // friendly entry point: a full encrypt round trip with no File System
  // Access API or IndexedDB involved at all, same "exercise the crypto
  // directly" approach manual-full-backup.js already takes with
  // exportFullBackup/importFullBackup.
  async function buildAutoBackupBlob(identity, password, existingSaltB64) {
    if (!identity || identity.mode !== 'local') {
      throw new Error('Unlock a local password identity first — a WebAuthn identity’s private key never leaves the authenticator, so it can’t be included in a backup.');
    }
    const saltBytes = existingSaltB64 ? new Uint8Array(b64urlDecode(existingSaltB64)) : crypto.getRandomValues(new Uint8Array(16));
    const saltB64 = existingSaltB64 || b64urlEncode(saltBytes.buffer);
    const key = await deriveAesKey([password], saltBytes, KDF_ITERATIONS_CURRENT, true);
    const rawKeyBytes = await crypto.subtle.exportKey('raw', key);
    const payload = await buildBackupPayload(identity);
    return encryptAutoBackupJson(payload, rawKeyBytes, saltB64, KDF_ITERATIONS_CURRENT, identity.publicKey);
  }

  // Called once, from backup-setup.html, right after the person picks a
  // file and this page has verified they actually know the current
  // password (see that page's own comment for why re-verifying here
  // matters — granting a device a standing "silently write my whole
  // wallet here forever" capability is exactly the kind of action worth
  // that friction). Performs the first real write itself so the person
  // gets immediate confirmation it worked, rather than waiting for the
  // debounce timer on whatever change happens to come next.
  async function setUpAutoBackup(fileHandle, password) {
    const identity = await getIdentity();
    if (!identity || identity.mode !== 'local') {
      throw new Error('Unlock a local password identity first — a WebAuthn identity’s private key never leaves the authenticator, so it can’t be included in a backup.');
    }
    const { atlasIdentity } = await chrome.storage.local.get('atlasIdentity');
    if (!atlasIdentity) throw new Error('No local identity set up on this device yet.');
    const localSalt = new Uint8Array(b64urlDecode(atlasIdentity.salt));
    const localIv = new Uint8Array(b64urlDecode(atlasIdentity.iv));
    const localKey = await deriveAesKey([password], localSalt, atlasIdentity.kdfIterations || KDF_ITERATIONS_LEGACY);
    try {
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: localIv }, localKey, b64urlDecode(atlasIdentity.ciphertext));
    } catch (err) {
      throw new Error('Incorrect password.');
    }

    const blob = await buildAutoBackupBlob(identity, password);
    await idbSetAutoBackupHandle(identity.publicKey, fileHandle);
    await setAutoBackupSettings({
      ownerPublicKey: identity.publicKey,
      enabled: true,
      fileName: fileHandle.name || null,
      salt: blob.salt,
      kdfIterations: blob.kdfIterations,
      lastWrittenAt: null,
      lastError: null,
      lapsed: false
    });
    await cacheAutoBackupSessionKey(password);

    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(blob));
    await writable.close();
    await setAutoBackupSettings({ lastWrittenAt: new Date().toISOString() });
    await logActivity('backup', 'Automatic local backup turned on');
    return { ok: true, fileName: fileHandle.name || null };
  }

  // Turns replication off. Deliberately does NOT touch the file itself —
  // it's the person's own file at that point (and may be the only surviving
  // copy of something), so leaving it alone and just stopping future writes
  // is the safer default; they can delete it themselves if they want to.
  async function turnOffAutoBackup(skipLog) {
    const settings = await getAutoBackupSettings();
    const wasOn = !!(settings && settings.enabled);
    if (settings && settings.ownerPublicKey) {
      try { await idbDeleteAutoBackupHandle(settings.ownerPublicKey); } catch (err) { /* best-effort cleanup */ }
    }
    await setAutoBackupSettings({ enabled: false, lapsed: false, lastError: null });
    await clearAutoBackupSessionKey();
    // Only log a real, standalone transition — not applyBackupPayload's own
    // identity-mismatch safety-net call (skipLog: true there), which fires
    // BEFORE that restore's own saveActivityLog() runs and would otherwise
    // just get overwritten by it; that restore's own "Restored full wallet
    // backup" entry already covers this as a side effect. Also not a call
    // against a device where this was never on in the first place.
    if (wasOn && !skipLog) await logActivity('backup', 'Automatic local backup turned off');
  }

  // The actual silent write — called after the debounce timer below
  // settles, and once immediately by reconnectAutoBackupPermission() after
  // permission is re-granted. Never throws: every failure mode here is
  // something that should show up as status text next time the person
  // opens Settings, not an unhandled rejection in a change-triggered
  // background write nobody's watching for it.
  async function writeAutoBackupNow() {
    // See IS_AUTO_BACKUP_WRITER_CONTEXT's own comment above: only
    // backup-setup.html's copy of this function is allowed to actually
    // attempt a write. Every other context (viewer.html's iframe,
    // identity-popup.html) is guaranteed to fail the permission check
    // anyway, so it no-ops here first, before reading or touching
    // anything, rather than racing backup-setup.html's real attempt and
    // fighting over atlasAutoBackupSettings.
    if (!IS_AUTO_BACKUP_WRITER_CONTEXT) return { skipped: true, reason: 'not the auto-backup writer context' };
    try {
      const settings = await getAutoBackupSettings();
      if (!settings || !settings.enabled) return { skipped: true, reason: 'not enabled' };

      const identity = await getIdentity();
      if (!identity || identity.mode !== 'local' || identity.publicKey !== settings.ownerPublicKey) {
        // Locked, or a different identity is active than the one this
        // device's auto-backup was set up for — nothing safe to write.
        return { skipped: true, reason: 'wallet locked or a different identity is active' };
      }

      const { atlasAutoBackupSessionKey } = await chrome.storage.session.get('atlasAutoBackupSessionKey');
      if (!atlasAutoBackupSessionKey) {
        // Enabled, unlocked, but no key cached this session — can happen
        // right after enabling auto-backup mid-session on a build that
        // predates this cache, or after a chrome.storage.session eviction.
        // Re-derive is impossible without the password; this resolves
        // itself on the next real unlock, which always calls
        // cacheAutoBackupSessionKey().
        return { skipped: true, reason: 'backup key not cached this session — resumes after next unlock' };
      }

      const handle = await idbGetAutoBackupHandle(identity.publicKey);
      if (!handle) {
        await setAutoBackupSettings({ lapsed: true, lastError: 'No backup file location saved on this device — set automatic backup up again.' });
        return { skipped: true, reason: 'no handle in IndexedDB' };
      }

      // Requirement: notice a lapsed permission rather than let the person
      // believe backups are still running when they've quietly stopped.
      // Deliberately does NOT call handle.requestPermission() here — that
      // can require a fresh user gesture in some implementations, and this
      // write is very often running with none (triggered by a background
      // mail check, not a click) — see reconnectAutoBackupPermission()
      // below for the version that's always called from a real click.
      const perm = await handle.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted') {
        await setAutoBackupSettings({ lapsed: true, lastError: 'Backup file access was revoked in the browser — reconnect it from Settings.' });
        return { skipped: true, reason: 'permission not granted' };
      }

      const payload = await buildBackupPayload(identity);
      const rawKeyBytes = b64urlDecode(atlasAutoBackupSessionKey);
      const blob = await encryptAutoBackupJson(payload, rawKeyBytes, settings.salt, settings.kdfIterations || KDF_ITERATIONS_CURRENT, identity.publicKey);

      const writable = await handle.createWritable();
      await writable.write(JSON.stringify(blob));
      await writable.close();
      await setAutoBackupSettings({ lastWrittenAt: new Date().toISOString(), lastError: null, lapsed: false });
      return { ok: true };
    } catch (err) {
      try { await setAutoBackupSettings({ lastError: err.message, lapsed: false }); } catch (err2) { /* best-effort */ }
      return { skipped: true, reason: err.message };
    }
  }

  // Must be called from a real click handler — see writeAutoBackupNow's
  // own comment for why it can't just call this itself once it notices a
  // lapse. The "reconnect" button in Settings is that click handler.
  async function reconnectAutoBackupPermission() {
    const identity = await getIdentity();
    if (!identity) throw new Error('Unlock your wallet first.');
    const handle = await idbGetAutoBackupHandle(identity.publicKey);
    if (!handle) throw new Error('No backup file is saved on this device — set automatic backup up again.');
    const perm = await handle.requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') throw new Error('Permission was not granted.');
    await setAutoBackupSettings({ lapsed: false, lastError: null });
    return writeAutoBackupNow();
  }

  // The restore counterpart — password-only, matching how the file was
  // encrypted (see this section's top comment). Reuses applyBackupPayload,
  // the exact same restore logic importFullBackup uses, so a restore from
  // an automatic backup file behaves identically to a restore from a
  // manually-exported one once the outer file is decrypted.
  async function restoreFromAutoBackupFile(fileData, password) {
    if (!fileData || fileData.format !== AUTO_BACKUP_FORMAT) throw new Error('Not an Atlas automatic backup file.');
    const saltBytes = new Uint8Array(b64urlDecode(fileData.salt));
    const iv = new Uint8Array(b64urlDecode(fileData.iv));
    const key = await deriveAesKey([password], saltBytes, fileData.kdfIterations || KDF_ITERATIONS_CURRENT);
    let payload;
    try {
      const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, b64urlDecode(fileData.ciphertext));
      payload = JSON.parse(new TextDecoder().decode(plaintext));
    } catch (err) {
      throw new Error('Incorrect password.');
    }
    return applyBackupPayload(payload, password, 'the automatic backup file');
  }

  // Debounced trigger: a short pause after the last change settles, not a
  // write on every single one (see this feature's design notes on why —
  // a heavily-used wallet could otherwise mean a lot of disk writes for no
  // real benefit). Scheduled from the chrome.storage.onChanged listener
  // below, which fires for literally any local-storage change from
  // anywhere in this extension — simpler and more future-proof than
  // threading a notify call through every individual saveX() function
  // buildBackupPayload happens to read from today.
  let autoBackupDebounceTimer = null;
  function scheduleAutoBackupWrite() {
    if (autoBackupDebounceTimer) clearTimeout(autoBackupDebounceTimer);
    autoBackupDebounceTimer = setTimeout(() => {
      autoBackupDebounceTimer = null;
      writeAutoBackupNow();
    }, AUTO_BACKUP_WRITE_DEBOUNCE_MS);
  }

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;
      // Self-write guard: writeAutoBackupNow's own bookkeeping touches
      // exactly one key (atlasAutoBackupSettings) and nothing else. If
      // that's the ONLY key that just changed, this change notification
      // was almost certainly caused by a backup write completing, not a
      // new change that itself needs backing up — without this guard, a
      // completed write would schedule another write, forever.
      const changedKeys = Object.keys(changes);
      if (changedKeys.length === 1 && changedKeys[0] === 'atlasAutoBackupSettings') return;
      scheduleAutoBackupWrite();
    });
  }

  // backup-setup.html is the only context writeAutoBackupNow() ever
  // actually runs in (see IS_AUTO_BACKUP_WRITER_CONTEXT above) — which
  // means simply closing that window silently stops all future backups
  // without ever tripping the "lapsed" permission check: nothing failed,
  // nothing even tried. That's exactly the kind of silent gap that led to
  // this session's original bug report ("I dropped an item and didn't
  // see an update"), just for a different underlying reason, so it needs
  // its own visible signal rather than becoming a second silent failure
  // mode. This context stamps a heartbeat into settings on a short
  // interval whenever auto-backup is enabled; viewer.js (and
  // backup-setup.html itself, on reopen) treat a heartbeat older than a
  // few missed intervals as "this window isn't open right now" and offer
  // a button to reopen it. Self-write-guarded the same way every other
  // settings-only write here is (see the listener just above) — a
  // heartbeat touching only atlasAutoBackupSettings never re-triggers a
  // real backup write.
  const AUTO_BACKUP_HEARTBEAT_INTERVAL_MS = 15000;
  if (IS_AUTO_BACKUP_WRITER_CONTEXT) {
    const beatAutoBackupHeartbeat = async () => {
      try {
        const settings = await getAutoBackupSettings();
        if (settings && settings.enabled) {
          await setAutoBackupSettings({ writerHeartbeatAt: new Date().toISOString() });
        }
      } catch (err) { /* best-effort — a missed heartbeat just reads as "window closed" a bit early */ }
    };
    beatAutoBackupHeartbeat();
    setInterval(beatAutoBackupHeartbeat, AUTO_BACKUP_HEARTBEAT_INTERVAL_MS);
  }

  // Convenience for UI callers (viewer.js's Settings panel, and
  // backup-setup.html itself on reopen): combines the raw settings with
  // the "is the writer window actually open right now" heuristic in one
  // place, so the staleness threshold lives in exactly one spot rather
  // than being duplicated at every call site that needs to ask.
  const AUTO_BACKUP_HEARTBEAT_STALE_AFTER_MS = AUTO_BACKUP_HEARTBEAT_INTERVAL_MS * 3;
  async function isAutoBackupWriterWindowOpen() {
    const settings = await getAutoBackupSettings();
    if (!settings || !settings.enabled || !settings.writerHeartbeatAt) return false;
    return (Date.now() - new Date(settings.writerHeartbeatAt).getTime()) < AUTO_BACKUP_HEARTBEAT_STALE_AFTER_MS;
  }

  // ---------- identity sync via chrome.storage.sync ----------
  //
  // A second, much smaller automatic-recovery channel alongside the
  // automatic FULL backup above — this one only ever carries the identity
  // itself (the same already-encrypted `atlasIdentity` blob every local
  // password identity is already stored as), mirrored into
  // chrome.storage.sync so it rides along with the person's Chrome
  // account. Deliberately NOT a replacement for the file-based full
  // backup above — it's scoped to just the signing key on purpose:
  //
  //   1. Size: chrome.storage.sync caps a single item at 8KB and the
  //      whole extension at ~100KB total. The atlasIdentity blob (a P-256
  //      JWK plus a small amount of AES-GCM overhead) comfortably fits;
  //      the FULL payload (mail, chat, trades, everything else
  //      buildBackupPayload collects) would not, reliably, for an
  //      actively-used wallet — no attempt is made to squeeze it in.
  //   2. No browser-storage headaches at all: unlike the File System
  //      Access-based backup above, chrome.storage.sync has no top-level-
  //      origin restriction and needs no dedicated window to stay open —
  //      it works identically from this same iframe context. The only
  //      real tradeoff is trust: this data now also passes through
  //      Google's own sync infrastructure, encrypted the same way, but on
  //      infrastructure the person doesn't run themselves — worth being
  //      opt-in for that reason alone, never on by default.
  //   3. Restoring it only ever recovers the identity, not any data —
  //      the exact same scope importIdentity() already has (see its own
  //      comment). A full data restore still means the file-based
  //      backup/restore above, or exportFullBackup/importFullBackup.
  //
  // The blob mirrored here is bit-for-bit whatever's currently in
  // chrome.storage.local's `atlasIdentity` key — no separate encryption
  // scheme to design or maintain, since that blob is already
  // password-protected AES-GCM ciphertext. mirrorIdentityToSyncBackup()
  // is called from every place this file writes a fresh atlasIdentity
  // blob (createIdentity, unlockIdentity's KDF-migration rewrite,
  // changePassword, importIdentity, applyBackupPayload) so the synced
  // copy always reflects whichever identity + password is actually
  // active on this device, whenever the person has opted in.
  async function mirrorIdentityToSyncBackup(atlasIdentityBlob) {
    try {
      const { atlasIdentitySyncBackupEnabled } = await chrome.storage.local.get('atlasIdentitySyncBackupEnabled');
      if (!atlasIdentitySyncBackupEnabled) return;
      await chrome.storage.sync.set({ atlasIdentitySyncBackup: atlasIdentityBlob });
    } catch (err) {
      // Best-effort, same posture as every other auxiliary backup write in
      // this file — quota exhaustion or a sync hiccup shouldn't block
      // whatever main operation (create/unlock/change password/import)
      // triggered this mirror.
    }
  }

  // The safer entry point for the actual call sites: mirrorIdentityToSyncBackup()
  // above assumes the blob it's given is a fresh copy of the SAME identity
  // that's already synced (true for createIdentity/unlockIdentity's KDF
  // migration/changePassword, where the publicKey never changes, only the
  // encryption around it) — but importIdentity() and applyBackupPayload()
  // can bring a GENUINELY DIFFERENT identity active on this device. Blindly
  // mirroring in that case would silently overwrite someone else's (or an
  // earlier identity's) only synced copy with an unrelated one. Same
  // mismatch posture applyBackupPayload already uses for the file-based
  // auto-backup: turn this off rather than silently clobber, so Settings
  // stays honest about what's actually being kept in sync.
  async function reconcileIdentitySyncBackupOnIdentityChange(atlasIdentityBlob) {
    try {
      const { atlasIdentitySyncBackupEnabled } = await chrome.storage.local.get('atlasIdentitySyncBackupEnabled');
      if (!atlasIdentitySyncBackupEnabled) return;
      const { atlasIdentitySyncBackup } = await chrome.storage.sync.get('atlasIdentitySyncBackup');
      if (atlasIdentitySyncBackup && atlasIdentitySyncBackup.publicKey && atlasIdentitySyncBackup.publicKey !== atlasIdentityBlob.publicKey) {
        // skipLog: true — this can fire from inside applyBackupPayload,
        // BEFORE that restore's own saveActivityLog() runs; logging here
        // would just get overwritten by it. That restore's own "Restored
        // full wallet backup" entry already covers this as a side effect.
        await disableIdentitySyncBackup(true);
        return;
      }
      await mirrorIdentityToSyncBackup(atlasIdentityBlob);
    } catch (err) {
      // Best-effort — never blocks the import/restore that triggered this.
    }
  }

  async function getIdentitySyncBackupSettings() {
    const { atlasIdentitySyncBackupEnabled } = await chrome.storage.local.get('atlasIdentitySyncBackupEnabled');
    return { enabled: !!atlasIdentitySyncBackupEnabled };
  }

  // Same "prove you know it, even though the wallet's already unlocked"
  // posture exportIdentity/setUpAutoBackup already use — re-derives from
  // the LOCAL encrypted blob under the given password rather than
  // trusting the session cache, so turning this on always requires the
  // real current password, not just an unlocked session.
  async function enableIdentitySyncBackup(password) {
    if (await getIdentityMode() !== 'local') {
      throw new Error('Only available for password identities — a passkey\'s private key never leaves the authenticator, so there\'s nothing to sync.');
    }
    const { atlasIdentity } = await chrome.storage.local.get('atlasIdentity');
    if (!atlasIdentity) throw new Error('No identity set up on this device yet.');
    const salt = new Uint8Array(b64urlDecode(atlasIdentity.salt));
    const iv = new Uint8Array(b64urlDecode(atlasIdentity.iv));
    const iterations = atlasIdentity.kdfIterations || KDF_ITERATIONS_LEGACY;
    const key = await deriveAesKey([password], salt, iterations);
    try {
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, b64urlDecode(atlasIdentity.ciphertext));
    } catch (err) {
      throw new Error('Incorrect password.');
    }
    await chrome.storage.local.set({ atlasIdentitySyncBackupEnabled: true });
    await chrome.storage.sync.set({ atlasIdentitySyncBackup: atlasIdentity });
    await logActivity('backup', 'Identity sync turned on (Chrome sync)');
    return { ok: true };
  }

  // Deliberately does NOT touch the synced copy's ability to be read back
  // by leaving it in place — it removes it outright, unlike the local
  // file backup's turnOffAutoBackup() (which leaves the file alone since
  // it might be the person's only surviving copy). The difference: a
  // synced blob living on in the person's Chrome account after they
  // explicitly turned this off would be a surprise, not a safety net —
  // there's no "my only copy" case for it the way there can be for a
  // local file, since this is always a mirror of something also encrypted
  // locally right now.
  async function disableIdentitySyncBackup(skipLog) {
    await chrome.storage.local.set({ atlasIdentitySyncBackupEnabled: false });
    try { await chrome.storage.sync.remove('atlasIdentitySyncBackup'); } catch (err) { /* best-effort */ }
    if (!skipLog) await logActivity('backup', 'Identity sync turned off');
  }

  // Checked from the onboarding screen on a device with no local identity
  // yet, to offer "restore synced identity" alongside the existing
  // create/import/passkey choices.
  async function hasSyncedIdentityAvailable() {
    try {
      const { atlasIdentitySyncBackup } = await chrome.storage.sync.get('atlasIdentitySyncBackup');
      return !!(atlasIdentitySyncBackup && atlasIdentitySyncBackup.ciphertext);
    } catch (err) {
      return false;
    }
  }

  // The restore counterpart — same scope as importIdentity() (identity
  // only, no wallet/mail/trades/etc.), same decrypt logic as
  // unlockIdentity(), just reading the blob from chrome.storage.sync
  // instead of an uploaded file and this device's chrome.storage.local
  // instead of an already-unlocked one. Re-uses the synced blob as-is for
  // this device's own local atlasIdentity — it's already correctly
  // encrypted under this exact password, no need to re-encrypt under a
  // fresh local salt/iv the way importIdentity() does for an uploaded
  // export file.
  async function restoreIdentityFromSync(password) {
    const { atlasIdentitySyncBackup } = await chrome.storage.sync.get('atlasIdentitySyncBackup');
    if (!atlasIdentitySyncBackup) throw new Error('No synced identity found for this Chrome account.');
    const salt = new Uint8Array(b64urlDecode(atlasIdentitySyncBackup.salt));
    const iv = new Uint8Array(b64urlDecode(atlasIdentitySyncBackup.iv));
    const iterations = atlasIdentitySyncBackup.kdfIterations || KDF_ITERATIONS_LEGACY;
    const key = await deriveAesKey([password], salt, iterations);
    let plaintext;
    try {
      plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, b64urlDecode(atlasIdentitySyncBackup.ciphertext));
    } catch (err) {
      throw new Error('Incorrect password.');
    }
    const { publicKey, privateKeyJwk } = JSON.parse(new TextDecoder().decode(plaintext));
    await chrome.storage.local.set({
      atlasIdentity: atlasIdentitySyncBackup,
      atlasIdentityMode: 'local',
      atlasIdentitySyncBackupEnabled: true
    });
    await chrome.storage.session.set({ atlasUnlockedIdentity: { publicKey, privateKeyJwk } });
    await cacheAutoBackupSessionKey(password);
    await logActivity('identity', 'Identity restored from Chrome sync');
    return { publicKey };
  }

  // ---------- wallet activity log ----------
  //
  // A single per-identity feed of "things that happened in this wallet" —
  // asset mints/trades/transfers and identity/security events (password
  // changes, imports, backup/sync turned on or off) — so there's one place
  // to look back at instead of piecing it together from Inventory counts
  // and Trade history. Deliberately scoped to that: it does NOT duplicate
  // Mail or Chat (both already have their own list views), the raw
  // submitted-trades ledger (getSubmittedTrades), or purely social
  // bookkeeping like Friends/Contacts — this is a narration layer over
  // wallet/identity/security events specifically, not a second copy of
  // every list this file already keeps. Each call site below decides for
  // itself whether an action is worth a line here.
  //
  // Same encrypted-at-rest, per-identity storage shape as Friends/Recent
  // worlds above (storeName 'activityLog'), and included in
  // buildBackupPayload/applyBackupPayload like any other data family, so a
  // restored wallet keeps its history instead of starting blank. Capped at
  // MAX_ACTIVITY_LOG_ENTRIES (oldest entries fall off the end) so a
  // long-lived wallet's log can't grow without bound.
  //
  // logActivity() itself is best-effort (its own try/catch below swallows
  // everything — it can never reject), so every call site simply
  // `await`s it: that keeps entries in strict chronological order and
  // avoids racing a caller that reads the log again right away (e.g. right
  // after minting, before switching to the Activity log view), without
  // risking a logging hiccup ever surfacing as a thrown error against the
  // real action it's describing.
  const MAX_ACTIVITY_LOG_ENTRIES = 300;

  async function saveActivityLog(ownerPublicKey, list) {
    const { atlasActivityLog } = await chrome.storage.local.get('atlasActivityLog');
    const all = (atlasActivityLog && typeof atlasActivityLog === 'object' && !Array.isArray(atlasActivityLog)) ? atlasActivityLog : {};
    const identity = await getIdentity();
    all[ownerPublicKey] = await encryptAtRest(identity, 'activityLog', list);
    await chrome.storage.local.set({ atlasActivityLog: all });
  }

  // Newest first. No `ownerPublicKey` parameter, same as getFriends()/
  // getRecentWorlds() above — always the CURRENTLY unlocked identity, never
  // a different one, so there's no way to read another identity's log
  // without its password.
  async function getActivityLog() {
    const identity = await getIdentity();
    if (!identity) return [];
    const { atlasActivityLog } = await chrome.storage.local.get('atlasActivityLog');
    const stored = (atlasActivityLog || {})[identity.publicKey];
    return decryptAtRestAndMigrate(identity, 'activityLog', stored, [], (v) => saveActivityLog(identity.publicKey, v));
  }

  // `type` is a coarse tag ('identity', 'backup', 'asset', 'trade') for any
  // future filtering/iconography — not surfaced anywhere yet, just kept
  // alongside `text` so it doesn't have to be re-derived later. `meta` is
  // an optional plain object with whatever structured detail the call site
  // has handy (issuer domain, asset class, amounts) — again not rendered
  // today, but cheap to keep for a future "show details" affordance.
  async function logActivity(type, text, meta) {
    try {
      const identity = await getIdentity();
      if (!identity) return; // nothing to attribute this to — silently skip
      let list = await getActivityLog();
      list.unshift({
        id: 'act-' + Date.now().toString(36) + '-' + b64urlEncode(crypto.getRandomValues(new Uint8Array(6)).buffer),
        type, text,
        at: new Date().toISOString(),
        meta: meta || null
      });
      list = list.slice(0, MAX_ACTIVITY_LOG_ENTRIES);
      await saveActivityLog(identity.publicKey, list);
    } catch (err) {
      // best-effort — see this section's own top comment
    }
  }

  async function clearActivityLog() {
    const identity = await getIdentity();
    if (!identity) return;
    await saveActivityLog(identity.publicKey, []);
  }

  // ---------- mail (correspondence tied to a held credential) ----------
  //
  // A domain can send a message about a specific credential it issued —
  // scoped by credentialId, signed the exact same way any other credential
  // is (see /atlas/mail/send + /atlas/mail/check in issuer-server), and
  // verified here against the exact same .well-known/atlas-key.json
  // mechanism verifyCredential() already uses above. There's no separate
  // "subscribe" step: requesting a class like atlas.membership (see
  // ITEM_CATALOG) and holding the resulting credential IS the
  // subscription, because checkAllMail() below only ever asks about
  // credential ids currently sitting in the wallet — hide or delete that
  // credential and there's nothing left to ask about, which is the
  // unsubscribe.

  const DEFAULT_MAIL_INTERVAL_MINUTES = 30;

  // In-memory only (not persisted, not encrypted-at-rest — there's nothing
  // sensitive in "have I already told this domain about this credential's
  // encryption key this session") de-dup for registerMailEncryptionKey's
  // own checkAllMail call site below, so a mail check every
  // DEFAULT_MAIL_INTERVAL_MINUTES doesn't re-POST the same key for the same
  // credential forever — registration is idempotent either way, this just
  // avoids the redundant network round trip.
  const registeredMailEncryptionKeys = new Set();

  async function getMailSettings() {
    const { atlasMailSettings } = await chrome.storage.local.get('atlasMailSettings');
    return { intervalMinutes: DEFAULT_MAIL_INTERVAL_MINUTES, lastCheckedAt: null, ...(atlasMailSettings || {}) };
  }

  async function setMailCheckInterval(minutes) {
    const n = Number(minutes);
    if (!Number.isFinite(n) || n < 1) throw new Error('Interval must be at least 1 minute.');
    const settings = await getMailSettings();
    settings.intervalMinutes = Math.round(n);
    await chrome.storage.local.set({ atlasMailSettings: settings });
  }

  // Every change to the stored mail or chat lists is read-modify-write over
  // the whole list, and a mail check holds network waits in the middle. All
  // such changes run one at a time under this lock (Web Locks, so it also
  // holds across the extension's pages; a promise chain where unavailable),
  // and each one re-reads the list inside the lock. A caller that read the
  // list earlier and wrote it back later would undo anything changed in
  // between, e.g. a message marked read while a check was running.
  let messageWriteChain = Promise.resolve();
  function withMessageLock(fn) {
    if (typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request) {
      return navigator.locks.request('atlas-messages', fn);
    }
    const run = messageWriteChain.then(fn, fn);
    messageWriteChain = run.catch(() => {});
    return run;
  }

  // Encrypted at rest (2026-09-14, second round) — see decryptAtRestAndMigrate's
  // own comment for the opportunistic-migration behavior on pre-existing
  // plaintext mail.
  async function getMail(ownerPublicKey) {
    const { atlasMail } = await chrome.storage.local.get('atlasMail');
    const identity = await getIdentity();
    return decryptAtRestAndMigrate(identity, 'mail', (atlasMail || {})[ownerPublicKey], [], (v) => saveMail(ownerPublicKey, v));
  }

  async function saveMail(ownerPublicKey, entries) {
    const { atlasMail } = await chrome.storage.local.get('atlasMail');
    const all = atlasMail || {};
    const identity = await getIdentity();
    all[ownerPublicKey] = await encryptAtRest(identity, 'mail', entries);
    await chrome.storage.local.set({ atlasMail: all });
  }

  async function markMailRead(ownerPublicKey, messageId) {
    await withMessageLock(async () => {
      const entries = await getMail(ownerPublicKey);
      const entry = entries.find((e) => e.message.id === messageId);
      if (!entry || entry.read) return;
      entry.read = true;
      await saveMail(ownerPublicKey, entries);
    });
  }

  async function markAllMailRead(ownerPublicKey) {
    await withMessageLock(async () => {
      const entries = await getMail(ownerPublicKey);
      entries.forEach((e) => { e.read = true; });
      await saveMail(ownerPublicKey, entries);
    });
  }

  // Task #59: adds a mail message's attached gift to the wallet — the
  // explicit-Claim counterpart to mintAsset() above, reusing its exact
  // wallet-adding shape (verify, push {credential, lastVerdict}, save,
  // autoConsolidate) but over a credential the message already carries
  // rather than one fetched fresh from the issuer. Deliberately NOT
  // called anywhere in checkAllMail()'s automatic path — a gift only
  // ever enters the wallet from a person clicking Claim (see viewer.js's
  // mail card), never silently on arrival, which is the entire design
  // point the user picked over auto-add.
  //
  // `claimed` is a flag on the mail entry itself (alongside the existing
  // `read` flag), not a separate id list — same reasoning as `read`:
  // it's per-message local state, and there's nothing to "un-claim"
  // later the way deleted mail needs a permanent suppression list.
  async function claimMailGift(ownerPublicKey, messageId) {
    const entries = await getMail(ownerPublicKey);
    const entry = entries.find((e) => e.message.id === messageId);
    if (!entry) throw new Error('mail message not found');
    if (!entry.message.attachedAsset) throw new Error('this message has no attached gift');
    if (entry.claimed) throw new Error('this gift has already been claimed');

    const credential = entry.message.attachedAsset;
    if (!credential.owner || credential.owner.publicKey !== ownerPublicKey) {
      throw new Error('this gift was not addressed to this identity');
    }
    const verdict = await verifyCredential(credential);
    if (!verdict.valid) throw new Error('gift credential does not check out: ' + verdict.reason);

    const wallet = await getWallet(ownerPublicKey);
    wallet.push({ credential, lastVerdict: verdict });
    await saveWallet(ownerPublicKey, wallet);
    await autoConsolidateAssetWallet(ownerPublicKey);

    await withMessageLock(async () => {
      const latest = await getMail(ownerPublicKey);
      const current = latest.find((e) => e.message.id === messageId);
      if (!current) return;
      current.claimed = true;
      current.read = true; // clicking Claim is at least as strong a "seen it" signal as opening the card
      await saveMail(ownerPublicKey, latest);
    });
    return { credential, verdict };
  }

  // Post Office (task #75/#87/#94, SPEC.md §11.3): sends mail to another
  // person's public key through a domain that has issued THIS wallet its
  // own Global Mail membership card. Membership is symmetric — the domain
  // only relays between two people who BOTH hold its card (see
  // /atlas/postoffice/send's own comment, both server ports) — so
  // toDomain has to be somewhere this wallet has already joined, same as
  // the recipient. Holding the card is what makes that domain this
  // wallet's sending relay: the sender doesn't need to be standing in
  // that world to send through it, only to have joined it at some point.
  // getPostOfficeMemberships() below is how a caller finds which domains
  // that is without guessing.
  //
  // Composes the same {to, subject, body} shape the receiving domain's
  // /atlas/postoffice/send expects, signs it with this wallet's own
  // identity (signWithSelf — the exact self-authentication
  // presentIdentity() already uses, same dual-mode webauthn/raw-ecdsa
  // envelope verifyEnvelope checks server-side), and posts it. No local
  // wallet state changes here — the message lives entirely on the
  // recipient's domain until THEIR checkAllMail() picks it up, the same as
  // any other mail this wallet doesn't itself hold the credential for.
  //
  // `toHandle` (optional) is purely a display hint for this wallet's OWN
  // Sent record below — the recipient's registered handle, if the caller
  // already resolved one (Compose's handle-first path does; the raw-key
  // path has none). It plays no role in the actual send: the server call
  // is identical either way, keyed only on toPublicKey.
  //
  // The actual sign-and-POST is factored out into postOfficeSendRaw() below
  // so the new Messaging window's sendChatMessage() (task #111 follow-up)
  // can reuse the exact same wire call without also picking up sendUserMail's
  // OWN local bookkeeping (writing to atlasSentMail, touching the Mail
  // Compose "last domain" convenience) — a chat message has its own,
  // separate local record and its own separate "last domain" memory, so it
  // routes through THIS domain's Post Office without leaving any trace in
  // the Mail tab at all. See sendChatMessage()'s own comment further down.
  // Task #97 (SPEC.md §11.4, domain-to-domain federation): toPublicKey is
  // normally a bare public-key string, meaning "the recipient is a member
  // of toDomain itself" — every call site before this feature, unchanged.
  // Passing { publicKey, domain } instead addresses someone at a DIFFERENT
  // home domain than the one being sent through — toDomain still means
  // "which of MY OWN memberships to submit through" (exactly as before),
  // `domain` means "where the recipient actually lives." This wallet still
  // only ever talks to ITS OWN membership domain (toDomain) — it's THAT
  // domain's own server that does the cross-domain relay hop, never this
  // client directly. See recipientKeyOf() below for the storage-side half
  // of this — every local record still keys off a plain public-key string.
  function normalizeSendTarget(toPublicKey) {
    return typeof toPublicKey === 'string'
      ? { publicKey: toPublicKey, domain: null }
      : { publicKey: toPublicKey.publicKey, domain: toPublicKey.domain || null };
  }

  async function postOfficeSendRaw(toDomain, toPublicKey, subject, body) {
    if (!toDomain) throw new Error('toDomain is required — a Post Office this wallet already holds a Global Mail membership at.');
    if (!toPublicKey) throw new Error('toPublicKey is required.');
    if (!subject || !body) throw new Error('subject and body are required.');

    const target = normalizeSendTarget(toPublicKey);
    const to = { publicKey: target.publicKey };
    if (target.domain && target.domain !== toDomain) to.domain = target.domain;
    const payload = { to, subject, body };
    const proof = await signWithSelf(payload);
    const res = await fetch(baseUrl(toDomain) + '/atlas/postoffice/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload, proof })
    });
    if (!res.ok) {
      const err = new Error('Send failed: ' + (await res.text()));
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  async function sendUserMail(toDomain, toPublicKey, subject, body, toHandle) {
    // Identity resolved BEFORE sending (same reordering sendChatMessage
    // already does) — wrapMailForWire needs it to end-to-end encrypt the
    // wire subject/body; postOfficeSendRaw only ever sees the wrapped
    // envelope from here on, never the plain text.
    const identity = await getIdentity();
    const target = normalizeSendTarget(toPublicKey);
    const wire = await wrapMailForWire(identity, target.publicKey, subject, body);
    const result = await postOfficeSendRaw(toDomain, toPublicKey, wire.subject, wire.body);

    // Record this locally for the wallet's own Sent tab — the relaying
    // domain never hands the message back to the sender afterward (it
    // only ever reaches the recipient's checkAllMail()), so without this
    // the sender would have no record of what they'd sent at all. Uses
    // the server's own id/sentAt from `result` rather than minting new
    // ones, since that IS the canonical envelope the recipient will see.
    if (identity && result && result.id) {
      const entries = await getSentMail(identity.publicKey);
      // Task #97: normalized to a plain public-key string for the "to"
      // record regardless of whether toPublicKey was a bare string or a
      // { publicKey, domain } federated address — recipientDomain (only
      // set when it differs from toDomain, i.e. an actually-federated send)
      // is recorded alongside it purely for the Sent tab's own display,
      // never re-parsed back into anything.
      entries.unshift({
        id: result.id,
        to: { publicKey: target.publicKey, handle: toHandle || null, recipientDomain: (target.domain && target.domain !== toDomain) ? target.domain : null },
        domain: toDomain,
        // Always the ORIGINAL plain subject/body, never result.subject/body
        // — those are now whatever wrapMailForWire put on the wire (a
        // placeholder subject and an encrypted body once a peer key is
        // known), and this wallet's own Sent record should stay readable.
        subject,
        body,
        sentAt: result.sentAt || new Date().toISOString()
      });
      await saveSentMail(identity.publicKey, entries);
      // Last-used "send via" domain (UI convenience only) — recorded here,
      // at the point of an actual confirmed send, rather than on every
      // dropdown change, so it reflects a domain this wallet really sent
      // through rather than just briefly hovered in the picker.
      await setLastPostOfficeSendDomain(identity.publicKey, toDomain);
    }

    return result;
  }

  // ---------- Chats (task #111 first slice) ----------
  //
  // Bruno's explicit spec: "a separate system from mail, although messages
  // can be routed through the mail system for now" — a real-time transport
  // ("persistent connection") is future work, deferred until after this
  // interface exists. For now, every chat message is a completely ordinary
  // Post Office mail (postOfficeSendRaw() above), carrying ONE thing a
  // normal composed message never would: CHAT_SUBJECT_MARKER as its
  // subject. That marker is what checkAllMail() below keys off of to divert
  // an arriving message into atlasChatMessages instead of atlasMail — the
  // ONLY change checkAllMail() makes to its existing behavior. A leading
  // NUL byte makes the marker something no person could type into the
  // subject field of a normal Mail Compose message (there is no subject
  // field here at all — chat messages never go through Compose), so this
  // can never collide with genuine mail, accidentally or otherwise.
  //
  // Deliberately NOT reusing the existing `entry.message.from` presence
  // check (every Post-Office-relayed message already carries `from`,
  // whether sent via Mail Compose or here) — doing that would silently
  // reclassify every already-shipped Mail Compose message as "chat" too,
  // an unrequested and disruptive change to a feature that already works.
  // This marker is scoped to ONLY messages sent through sendChatMessage()
  // below, so the existing Mail tab (list, badge, Sent history) stays
  // completely untouched by any of this.
  const CHAT_SUBJECT_MARKER = ' atlas.chat.v1';

  function isChatTransportMessage(subject) {
    return subject === CHAT_SUBJECT_MARKER;
  }

  // ---------- Chats: encrypted at rest (TODO round 1, item 2 — 2026-09-14) ----------
  //
  // Bruno's explicit ask: chat message content, unlike everything else
  // this wallet stores (mail, sent mail, contacts, the credential wallet
  // itself), should be encrypted on disk — readable only while the wallet
  // is unlocked. The ONLY thing already encrypted at rest anywhere in this
  // file before this was a local-password identity's own private key
  // (createIdentity/unlockIdentity above, AES-GCM with a PBKDF2-derived
  // key) — but that derived key is a local variable inside those
  // functions, thrown away the instant they return; there is no password-
  // derived key sitting around anywhere to reuse for a second purpose.
  //
  // Rather than prompt for the password again, this derives a stable
  // symmetric key straight from the identity's own ECDSA private scalar
  // (the JWK's `d` member) — present in
  // chrome.storage.session.atlasUnlockedIdentity for exactly as long as
  // local mode is unlocked, and nowhere else (see getIdentity() above).
  // Same key every time for the same identity, so a message encrypted
  // today still decrypts fine after a lock/unlock cycle, an export/
  // reimport, or a browser restart — but the key itself is never written
  // to disk anywhere, only ever recomputed in memory while unlocked.
  //
  // WebAuthn identities have no private key material available client-side
  // at all (it never leaves the hardware authenticator — see getIdentity's
  // own comment), so there is nothing to derive a key from; chat bodies
  // for a WebAuthn identity stay plain strings, same as any message would
  // have been before this feature existed. This is a smaller gap than it
  // sounds: isUnlocked() is unconditionally true for WebAuthn mode anyway
  // (no lock state exists there to protect against in the first place).
  // encryptChatBody/decryptChatBody both degrade to plain-string
  // passthrough whenever privateKeyJwk isn't available, rather than
  // throwing — see each function's own early-return.
  async function deriveChatEncryptionKey(privateKeyJwk) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('atlas.chat.v1:' + privateKeyJwk.d));
    return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  // Returns either a plain string (WebAuthn mode, or nothing to encrypt
  // with) or an { __atlasChatEncrypted, iv, ciphertext } envelope (local
  // mode) — every OTHER chat function only ever deals with plaintext
  // bodies; only this pair (and the storage boundary functions that call
  // them: sendChatMessage, checkAllMail's chat branch, getChatThreads,
  // getChatThreadMessages) ever sees the on-disk shape directly.
  async function encryptChatBody(identity, plaintext) {
    if (!identity || identity.mode !== 'local' || !identity.privateKeyJwk) return plaintext;
    const key = await deriveChatEncryptionKey(identity.privateKeyJwk);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
    return { __atlasChatEncrypted: true, iv: b64urlEncode(iv), ciphertext: b64urlEncode(new Uint8Array(ciphertext)) };
  }

  async function decryptChatBody(identity, storedBody) {
    if (typeof storedBody === 'string' || !storedBody) return storedBody; // already plain — WebAuthn mode, or a pre-encryption message
    if (!storedBody.__atlasChatEncrypted) return '[unreadable message]';
    if (!identity || identity.mode !== 'local' || !identity.privateKeyJwk) return '[Encrypted — unlock your wallet to read]';
    try {
      const key = await deriveChatEncryptionKey(identity.privateKeyJwk);
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: b64urlDecode(storedBody.iv) },
        key,
        b64urlDecode(storedBody.ciphertext)
      );
      return new TextDecoder().decode(plaintext);
    } catch (err) {
      return '[Could not decrypt this message]';
    }
  }

  // ---------- generic at-rest encryption for the rest of this wallet's
  // personal data (2026-09-14, second round) ----------
  //
  // Bruno, after shipping chat's own encryption above, asked to extend
  // "encrypted at rest" to the whole local data store, not just chat.
  // This generalizes deriveChatEncryptionKey/encryptChatBody/
  // decryptChatBody's own approach (AES-GCM, key derived from the
  // identity's own ECDSA private scalar, no second password prompt
  // needed) to arbitrary JSON-serializable values — deliberately a
  // SEPARATE derived key per `storeName` (same raw-scalar-plus-SHA-256
  // derivation, just a different label) rather than reusing chat's own
  // key outright: cheap key separation between data categories, and it
  // means chat's already-shipped ciphertext never has to be touched or
  // re-derived under a new label. Every caller below passes a stable,
  // unique storeName ('mail', 'friends', 'wallet', etc.).
  //
  // Same WebAuthn/no-identity/locked graceful-fallback shape as chat's
  // own pair: encryptAtRest passes plaintext through untouched when
  // there's no local-mode private key available to derive from;
  // decryptAtRest returns `fallback` in that case instead of throwing —
  // callers treat that exactly like "nothing saved yet," which is the
  // honest state of the world while locked (see each call site's own
  // "opportunistic migration" comment for how PRE-encryption plaintext
  // data already on disk gets picked up and upgraded).
  async function deriveAtRestKey(privateKeyJwk, storeName) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('atlas.store.v1:' + storeName + ':' + privateKeyJwk.d));
    return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  async function encryptAtRest(identity, storeName, value) {
    if (!identity || identity.mode !== 'local' || !identity.privateKeyJwk) return value;
    const key = await deriveAtRestKey(identity.privateKeyJwk, storeName);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(value)));
    return { __atlasEncrypted: true, iv: b64urlEncode(iv), ciphertext: b64urlEncode(new Uint8Array(ciphertext)) };
  }

  async function decryptAtRest(identity, storeName, stored, fallback) {
    if (stored === undefined || stored === null) return fallback;
    if (!stored || typeof stored !== 'object' || !stored.__atlasEncrypted) return stored; // legacy plaintext (pre-encryption data), or a shape encryptAtRest never produced
    if (!identity || identity.mode !== 'local' || !identity.privateKeyJwk) return fallback; // locked, no identity yet, or WebAuthn — can't decrypt right now
    try {
      const key = await deriveAtRestKey(identity.privateKeyJwk, storeName);
      const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64urlDecode(stored.iv) }, key, b64urlDecode(stored.ciphertext));
      return JSON.parse(new TextDecoder().decode(plaintext));
    } catch (err) {
      return fallback;
    }
  }

  // Wraps decryptAtRest with a one-time, fire-and-forget upgrade: the
  // first time a call site reads back a value that's still in its
  // PRE-encryption plaintext shape (an old array/object saved before this
  // feature existed, not an { __atlasEncrypted } envelope) while a local
  // identity is actually unlocked, it re-saves that same value through
  // `saveFn` so it's encrypted from then on — centralizing this here
  // means every individual getter below doesn't have to repeat the "is
  // this still plaintext, and do we have a key right now" check by hand.
  // Best-effort: a failed migration save just means the next read tries
  // again, same as leaving a message unread and checking later.
  async function decryptAtRestAndMigrate(identity, storeName, stored, fallback, saveFn) {
    const alreadyEncrypted = !!(stored && typeof stored === 'object' && stored.__atlasEncrypted);
    const value = await decryptAtRest(identity, storeName, stored, fallback);
    if (stored !== undefined && stored !== null && !alreadyEncrypted && identity && identity.mode === 'local' && identity.privateKeyJwk) {
      Promise.resolve(saveFn(value)).catch(() => {});
    }
    return value;
  }

  // One flat array per owner identity, both directions mixed together
  // (`direction: 'out'|'in'`) rather than mail's separate atlasMail/
  // atlasSentMail pair — a chat thread is inherently a merge of both sides
  // in one chronological list (see viewer.js's chat view), so storing them
  // together here is what makes building that view a single filter+sort
  // instead of a two-source merge on every render.
  async function getChatMessages(ownerPublicKey) {
    const { atlasChatMessages } = await chrome.storage.local.get('atlasChatMessages');
    return (atlasChatMessages || {})[ownerPublicKey] || [];
  }

  async function saveChatMessages(ownerPublicKey, entries) {
    const { atlasChatMessages } = await chrome.storage.local.get('atlasChatMessages');
    const all = atlasChatMessages || {};
    all[ownerPublicKey] = entries;
    await chrome.storage.local.set({ atlasChatMessages: all });
  }

  // Groups the flat per-owner list into one row per counterparty, newest
  // message first — the Chats tab's (main view) list. counterpartyHandle
  // is taken from whichever message in the thread has one (a handle can
  // only ever be learned from an INCOMING message's `from.handle`, or from
  // whatever `toHandle` a caller supplied when composing an outgoing one —
  // see sendChatMessage()), preferring the most recent message that has
  // one so a since-registered handle eventually wins over an older blank.
  async function getChatThreads(ownerPublicKey) {
    const identity = await getIdentity(); // needed to decrypt lastMessage.body below — see decryptChatBody's own comment
    const entries = await getChatMessages(ownerPublicKey);
    const byCounterparty = new Map();
    // Oldest-first pass so the "last write wins" handle-preference below
    // naturally ends up preferring the NEWEST message that actually has one.
    const sorted = [...entries].sort((a, b) => new Date(a.sentAt) - new Date(b.sentAt));
    for (const entry of sorted) {
      const thread = byCounterparty.get(entry.counterpartyPublicKey) || {
        counterpartyPublicKey: entry.counterpartyPublicKey,
        counterpartyHandle: null,
        domain: entry.domain,
        lastMessage: null,
        unreadCount: 0
      };
      if (entry.counterpartyHandle) thread.counterpartyHandle = entry.counterpartyHandle;
      thread.domain = entry.domain; // most recently used domain for this counterparty
      thread.lastMessage = { body: await decryptChatBody(identity, entry.body), sentAt: entry.sentAt, direction: entry.direction };
      byCounterparty.set(entry.counterpartyPublicKey, thread);
    }
    // Unread count is a separate pass (not foldable into the loop above)
    // since it's a straight count of `read === false` entries for that
    // counterparty, independent of ordering.
    entries.forEach((entry) => {
      if (entry.direction === 'in' && !entry.read) {
        const thread = byCounterparty.get(entry.counterpartyPublicKey);
        if (thread) thread.unreadCount++;
      }
    });
    return [...byCounterparty.values()].sort((a, b) => new Date(b.lastMessage.sentAt) - new Date(a.lastMessage.sentAt));
  }

  // One counterparty's full history, oldest first (newest-at-the-bottom is
  // exactly what Bruno's spec asked the (chat view) to render) — the (chat
  // view)'s own message list.
  async function getChatThreadMessages(ownerPublicKey, counterpartyPublicKey) {
    const identity = await getIdentity();
    const entries = await getChatMessages(ownerPublicKey);
    const thread = entries
      .filter((e) => e.counterpartyPublicKey === counterpartyPublicKey)
      .sort((a, b) => new Date(a.sentAt) - new Date(b.sentAt));
    return Promise.all(thread.map(async (e) => ({ ...e, body: await decryptChatBody(identity, e.body) })));
  }

  async function markChatThreadRead(ownerPublicKey, counterpartyPublicKey) {
    await withMessageLock(async () => {
      const entries = await getChatMessages(ownerPublicKey);
      let changed = false;
      entries.forEach((e) => {
        if (e.counterpartyPublicKey === counterpartyPublicKey && e.direction === 'in' && !e.read) {
          e.read = true;
          changed = true;
        }
      });
      if (changed) await saveChatMessages(ownerPublicKey, entries);
    });
  }

  async function getChatUnreadCount(ownerPublicKey) {
    const entries = await getChatMessages(ownerPublicKey);
    return entries.filter((e) => e.direction === 'in' && !e.read).length;
  }

  // ---------- Chats: end-to-end encryption (task #158, 2026-09-14) ----------
  //
  // Everything above (encryptChatBody/decryptChatBody, and the generic
  // encryptAtRest family) protects a chat message's body sitting in THIS
  // device's own storage after the fact. It does nothing for the trip in
  // between: sendChatMessage posts the plain body straight to the
  // relaying domain's /atlas/postoffice/send, which writes it to its own
  // mail store as plaintext (issuer-server/server.js's appendMail) — any
  // relaying domain can read every word of every chat message it carries.
  // This section closes that gap with real per-pair Diffie-Hellman key
  // agreement (ECDH, P-256) so the relay only ever sees ciphertext.
  //
  // Deliberately a SEPARATE ECDH keypair per identity, not a reuse of the
  // identity's own ECDSA signing key — mixing a key's use between signing
  // and key-agreement is a well-known thing to avoid even when the same
  // curve happens to work for both, and generating a second keypair costs
  // almost nothing extra here. Generated once, lazily, on first use
  // (getChatE2eeKeyPair) and persisted encrypted-at-rest under storeName
  // 'chatE2eeKeypair' — same encryptAtRest/decryptAtRest primitives the
  // rest of this file's whole-storage encryption pass already uses.
  //
  // The hard problem real E2E messaging has to solve is: how does a
  // recipient trust that a shared "here's my key" announcement really
  // came from the person it claims to, rather than from the relay itself
  // quietly substituting its own key and sitting in the middle? This
  // reuses infrastructure this project already has: every key
  // announcement is signed with the SENDER'S OWN existing identity key
  // (signChatE2eeKeyAnnouncement/verifyChatE2eeKeyAnnouncement, the exact
  // same raw-ecdsa envelope shape signWithSelf/verifySignedPayload already
  // use for presentIdentity) — a relay can relay that signed announcement,
  // but it cannot forge one, so it cannot substitute a key of its own
  // without the recipient's verification catching it.
  //
  // Bootstrap / first-contact gap, disclosed rather than hidden: encrypting
  // to someone requires already knowing THEIR e2ee public key, which this
  // wallet can only ever have learned from a message they already sent —
  // there is no separate key-discovery step or server endpoint here (kept
  // deliberately out of scope, along with real forward secrecy /
  // per-message key rotation — a deliberate "simple static key first" v1
  // scope decision). So the very FIRST message in a brand-new
  // conversation, in whichever direction happens to go first, is sent as
  // a signed-but-UNENCRYPTED key
  // announcement (still authentic, just not confidential) — carrying this
  // wallet's own e2ee public key so the other side can encrypt their
  // reply. Every message after that, in EITHER direction, is fully
  // end-to-end encrypted. A leaked long-term identity key would still let
  // someone decrypt that pair's PAST messages (no ratcheting) — a real,
  // accepted limitation of this "simple" round, not an oversight.
  //
  // Wire shape (the actual string carried as `body` over
  // /atlas/postoffice/send — deliberately packed INSIDE body rather than
  // as new top-level payload fields, since body is the one field the
  // relay already treats as fully opaque and never needs code changes on
  // either issuer-server.js or issuer-php to carry):
  //   { v: 1,
  //     key: { announcement: { chatE2eePublicKeyJwk }, envelope: <signed, see above> },
  //     encrypted: true,  iv, ciphertext                 // the normal case
  //     -- or, before the recipient's key is known yet --
  //     encrypted: false, plaintext                      // first-message bootstrap only
  //   }
  // Anything that doesn't parse as this shape (every chat message ever
  // sent before this shipped) is treated as plain pre-existing text —
  // fully backward compatible, no migration needed.

  async function saveChatE2eeKeyPair(ownerPublicKey, pair) {
    const { atlasChatE2eeKeypairs } = await chrome.storage.local.get('atlasChatE2eeKeypairs');
    const all = atlasChatE2eeKeypairs || {};
    const identity = await getIdentity();
    all[ownerPublicKey] = await encryptAtRest(identity, 'chatE2eeKeypair', pair);
    await chrome.storage.local.set({ atlasChatE2eeKeypairs: all });
  }

  // Local-mode only, same posture as encryptAtRest/encryptChatBody — a
  // WebAuthn identity's private key never leaves the hardware
  // authenticator, so there's no way to run ECDH against it client-side.
  // Returns null for WebAuthn/no-identity; callers already treat "no e2ee
  // available" as "fall back to the old plain-body behavior."
  async function getChatE2eeKeyPair(identity) {
    if (!identity || identity.mode !== 'local' || !identity.privateKeyJwk) return null;
    const { atlasChatE2eeKeypairs } = await chrome.storage.local.get('atlasChatE2eeKeypairs');
    const existing = await decryptAtRest(identity, 'chatE2eeKeypair', (atlasChatE2eeKeypairs || {})[identity.publicKey], null);
    if (existing) return existing;
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const pair = {
      publicKeyJwk: await crypto.subtle.exportKey('jwk', kp.publicKey),
      privateKeyJwk: await crypto.subtle.exportKey('jwk', kp.privateKey)
    };
    await saveChatE2eeKeyPair(identity.publicKey, pair);
    return pair;
  }

  // The cache of "e2ee public keys this identity has learned belong to
  // other people" — one map per owner identity (publicKey -> their chat
  // e2ee public key JWK), encrypted at rest like everything else this
  // session's whole-storage pass touched. Only ever populated by a
  // SUCCESSFULLY VERIFIED key announcement (see unwrapChatMessageFromWire)
  // — never from an unauthenticated source.
  async function getE2eePeerKeysForOwner(identity) {
    if (!identity) return {};
    const { atlasChatE2eePeerKeys } = await chrome.storage.local.get('atlasChatE2eePeerKeys');
    return decryptAtRest(identity, 'chatE2eePeerKeys', (atlasChatE2eePeerKeys || {})[identity.publicKey], {});
  }

  async function saveE2eePeerKeysForOwner(ownerPublicKey, peerKeys) {
    const { atlasChatE2eePeerKeys } = await chrome.storage.local.get('atlasChatE2eePeerKeys');
    const all = atlasChatE2eePeerKeys || {};
    const identity = await getIdentity();
    all[ownerPublicKey] = await encryptAtRest(identity, 'chatE2eePeerKeys', peerKeys);
    await chrome.storage.local.set({ atlasChatE2eePeerKeys: all });
  }

  async function getE2eePeerPublicKey(identity, peerPublicKey) {
    const forOwner = await getE2eePeerKeysForOwner(identity);
    return forOwner[peerPublicKey] || null;
  }

  async function rememberE2eePeerPublicKey(identity, peerPublicKey, publicKeyJwk) {
    if (!identity) return;
    const forOwner = await getE2eePeerKeysForOwner(identity);
    forOwner[peerPublicKey] = publicKeyJwk;
    await saveE2eePeerKeysForOwner(identity.publicKey, forOwner);
  }

  // Signs a JWK e2ee public key with this identity's OWN existing ECDSA
  // key — deliberately NOT signWithSelf (which dispatches to a real
  // WebAuthn ceremony for a WebAuthn-mode identity; this function is only
  // ever called after a caller has already confirmed `identity.mode ===
  // 'local'`, so a WebAuthn prompt on every single chat message sent is
  // never a risk here). Byte-identical envelope shape to signWithSelf's
  // own raw-ecdsa branch, so the existing verifySignedPayload verifies it
  // with no changes needed there.
  async function signChatE2eeKeyAnnouncement(identity, publicKeyJwk) {
    const announcement = { chatE2eePublicKeyJwk: publicKeyJwk };
    const privateKey = await crypto.subtle.importKey('jwk', identity.privateKeyJwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    const data = new TextEncoder().encode(canonicalize(announcement));
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, data);
    return { announcement, envelope: { signerRole: 'raw-ecdsa', publicKey: identity.publicKey, signature: b64urlEncode(sig) } };
  }

  // The binding check that closes the "relay substitutes its own key"
  // MITM gap: verifySignedPayload alone only proves SOME identity signed
  // this announcement, not that it was the identity the message actually
  // claims to be from — envelope.publicKey is attacker-influenceable
  // input sitting inside the wire body, so it's checked against the
  // OUTER, relay-vouched sender (message.from.publicKey) explicitly here.
  async function verifyChatE2eeKeyAnnouncement(claimedSenderPublicKey, signed) {
    if (!signed || !signed.announcement || !signed.envelope || !claimedSenderPublicKey) return false;
    if (signed.envelope.publicKey !== claimedSenderPublicKey) return false;
    try {
      return await verifySignedPayload(signed.announcement, signed.envelope);
    } catch (err) {
      return false;
    }
  }

  // Raw ECDH agreement, then a SHA-256 pass (with a domain-separation
  // label, same idea as deriveAtRestKey's own storeName label above)
  // rather than importing the raw shared point straight as an AES key —
  // WebCrypto's own ECDH deriveKey path would technically allow that, but
  // hashing first is the safer, more conventional habit and costs nothing.
  // `label` is what keeps Chat's derived key and Mail's own (below) distinct
  // even when the exact same ECDH keypair produced the raw shared bits.
  async function deriveEcdhSharedKey(ownPrivateKeyJwk, peerPublicKeyJwk, label) {
    const privateKey = await crypto.subtle.importKey('jwk', ownPrivateKeyJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const publicKey = await crypto.subtle.importKey('jwk', peerPublicKeyJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const sharedBits = await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
    const labelBytes = new TextEncoder().encode(label);
    const combined = new Uint8Array(sharedBits.byteLength + labelBytes.length);
    combined.set(new Uint8Array(sharedBits), 0);
    combined.set(labelBytes, sharedBits.byteLength);
    const digest = await crypto.subtle.digest('SHA-256', combined);
    return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }
  function deriveChatE2eeSharedKey(ownPrivateKeyJwk, peerPublicKeyJwk) {
    return deriveEcdhSharedKey(ownPrivateKeyJwk, peerPublicKeyJwk, 'atlas.chat.e2ee.v1');
  }

  // Called from sendChatMessage right before the message ever leaves this
  // device. See the section comment above for the wire shape and the
  // first-message bootstrap gap.
  async function wrapChatMessageForWire(identity, peerPublicKey, plainBody) {
    if (!identity || identity.mode !== 'local' || !identity.privateKeyJwk) return plainBody; // WebAuthn/no-identity: unchanged from before this feature
    const ownKeyPair = await getChatE2eeKeyPair(identity);
    const signedKey = await signChatE2eeKeyAnnouncement(identity, ownKeyPair.publicKeyJwk);
    const peerKeyJwk = await getE2eePeerPublicKey(identity, peerPublicKey);
    if (!peerKeyJwk) {
      return JSON.stringify({ v: 1, key: signedKey, encrypted: false, plaintext: plainBody });
    }
    const sharedKey = await deriveChatE2eeSharedKey(ownKeyPair.privateKeyJwk, peerKeyJwk);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, sharedKey, new TextEncoder().encode(plainBody));
    return JSON.stringify({ v: 1, key: signedKey, encrypted: true, iv: b64urlEncode(iv), ciphertext: b64urlEncode(new Uint8Array(ciphertext)) });
  }

  // Called from checkAllMail's chat branch on every incoming chat
  // message's raw wire body, BEFORE encryptChatBody's own at-rest
  // encryption ever sees it — this function's job is purely to undo
  // whatever wrapChatMessageForWire did in transit; what comes out of it
  // is a plain string that then goes through the exact same local-storage
  // encryption path every chat message always has.
  async function unwrapChatMessageFromWire(identity, senderPublicKey, wireBody) {
    let envelope;
    try {
      envelope = JSON.parse(wireBody);
    } catch (err) {
      return wireBody; // not JSON at all -> a pre-#158 plaintext message, pass through unchanged
    }
    if (!envelope || envelope.v !== 1 || !envelope.key || !envelope.key.announcement) return wireBody; // doesn't match this feature's shape -> treat as plain text too

    const peerPublicKeyJwk = envelope.key.announcement.chatE2eePublicKeyJwk;
    let keyIsGenuine = false;
    if (identity && identity.mode === 'local' && identity.privateKeyJwk && peerPublicKeyJwk) {
      keyIsGenuine = await verifyChatE2eeKeyAnnouncement(senderPublicKey, envelope.key);
      if (keyIsGenuine) await rememberE2eePeerPublicKey(identity, senderPublicKey, peerPublicKeyJwk);
      // A key announcement that fails verification is never cached and
      // never trusted for decryption below — see verifyChatE2eeKeyAnnouncement's
      // own comment on exactly what this is defending against.
    }

    if (!envelope.encrypted) return typeof envelope.plaintext === 'string' ? envelope.plaintext : '[unreadable message]';

    if (!identity || identity.mode !== 'local' || !identity.privateKeyJwk) return '[Encrypted — unlock your wallet to read]';
    if (!keyIsGenuine) return "[Could not verify sender's encryption key — message not shown]";
    try {
      const ownKeyPair = await getChatE2eeKeyPair(identity);
      const sharedKey = await deriveChatE2eeSharedKey(ownKeyPair.privateKeyJwk, peerPublicKeyJwk);
      const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64urlDecode(envelope.iv) }, sharedKey, b64urlDecode(envelope.ciphertext));
      return new TextDecoder().decode(plaintext);
    } catch (err) {
      return '[Could not decrypt this message]';
    }
  }

  // Sends a chat message through the SAME Post Office plumbing Mail Compose
  // uses (postOfficeSendRaw), stamped with CHAT_SUBJECT_MARKER, and records
  // its own local copy in atlasChatMessages — deliberately NOT sendUserMail
  // (that would also write an entry into atlasSentMail, surfacing this
  // marker-subject message in the Mail tab's Sent list, and would overwrite
  // Mail Compose's own remembered "send via" domain out from under it; see
  // sendUserMail's own comment above postOfficeSendRaw). `toHandle`
  // (optional) mirrors sendUserMail's own parameter — a display hint for
  // this wallet's OWN thread list when the caller already knows it (the
  // Contacts tab does, from the saved contact's name).
  async function sendChatMessage(toDomain, toPublicKey, body, toHandle) {
    if (!body) throw new Error('body is required.');
    // Task #158 — identity resolved BEFORE sending now (it used to be
    // fetched after), since wrapChatMessageForWire needs it to end-to-end
    // encrypt the wire body; postOfficeSendRaw only ever sees the wrapped
    // envelope from here on, never the plain text.
    const identity = await getIdentity();
    // Task #97: normalized to a plain public-key string up front — the e2ee
    // peer-key cache (wrapChatMessageForWire) and this wallet's own thread
    // storage both key off a bare string, same as before this feature;
    // toPublicKey's original shape (string, or { publicKey, domain } for a
    // federated recipient) still flows through to postOfficeSendRaw
    // unchanged, since that's the only layer that needs the domain.
    const target = normalizeSendTarget(toPublicKey);
    const wireBody = await wrapChatMessageForWire(identity, target.publicKey, body);
    const result = await postOfficeSendRaw(toDomain, toPublicKey, CHAT_SUBJECT_MARKER, wireBody);

    if (identity && result && result.id) {
      const sentBody = await encryptChatBody(identity, body);
      await withMessageLock(async () => {
      const entries = await getChatMessages(identity.publicKey);
      entries.push({
        id: result.id,
        direction: 'out',
        counterpartyPublicKey: target.publicKey,
        counterpartyHandle: toHandle || null,
        domain: toDomain,
        // Always the ORIGINAL plain text, never result.body — result.body
        // is now whatever wireBody was (the E2EE envelope, or plaintext if
        // this identity can't do E2EE at all), and this wallet's own
        // sent-message record should obviously always be human-readable.
        body: sentBody,
        sentAt: result.sentAt || new Date().toISOString(),
        read: true // this wallet's own outgoing message — nothing to mark unread
      });
      await saveChatMessages(identity.publicKey, entries);
      });
      await setLastChatSendDomain(identity.publicKey, toDomain);
    }
    return result;
  }

  // ---------- Mail: end-to-end encryption for ordinary Post Office user
  // mail ----------
  //
  // Chat's own wrap/unwrap above only ever protects a message stamped with
  // CHAT_SUBJECT_MARKER. An ordinary Mail Compose message — a real subject
  // line, sent through the exact same Post Office transport — got none of
  // that: postOfficeSendRaw hands the relay a plain subject and body,
  // readable by any relaying domain the same way a domain-to-subscriber
  // message's plaintext body always has been (see the separate mechanism
  // further below for that case). This closes the gap for the user-to-user
  // case, reusing the SAME per-identity ECDH keypair Chat already generates
  // — one encryption identity per wallet, not a second one per feature —
  // and the same signed-key-announcement bootstrap, so a relaying domain
  // still can't substitute its own key in place of the real sender's.
  //
  // Subject and body are bundled into ONE encrypted blob rather than
  // leaving subject exposed to route around covering it — a real subject
  // line ("Wire transfer confirmation") can be just as sensitive as the
  // body. The OUTER, server-visible subject becomes a fixed placeholder
  // once a peer key is known; during the one-message bootstrap (peer key
  // not yet known), the real subject still has to travel in the clear —
  // hiding it while the body sits unencrypted right next to it would be
  // cosmetic, not real protection.
  const MAIL_ENCRYPTED_SUBJECT_PLACEHOLDER = 'Encrypted message';

  async function wrapMailForWire(identity, peerPublicKey, subject, body) {
    if (!identity || identity.mode !== 'local' || !identity.privateKeyJwk) return { subject, body }; // unchanged from before this feature
    const ownKeyPair = await getChatE2eeKeyPair(identity);
    const signedKey = await signChatE2eeKeyAnnouncement(identity, ownKeyPair.publicKeyJwk);
    const peerKeyJwk = await getE2eePeerPublicKey(identity, peerPublicKey);
    const plaintext = JSON.stringify({ subject, body });
    if (!peerKeyJwk) {
      return { subject, body: JSON.stringify({ v: 1, key: signedKey, encrypted: false, plaintext }) };
    }
    const sharedKey = await deriveEcdhSharedKey(ownKeyPair.privateKeyJwk, peerKeyJwk, 'atlas.mail.e2ee.v1');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, sharedKey, new TextEncoder().encode(plaintext));
    return {
      subject: MAIL_ENCRYPTED_SUBJECT_PLACEHOLDER,
      body: JSON.stringify({ v: 1, key: signedKey, encrypted: true, iv: b64urlEncode(iv), ciphertext: b64urlEncode(new Uint8Array(ciphertext)) })
    };
  }

  // Mirrors unwrapChatMessageFromWire's own verify-then-decrypt shape, but
  // hands back a resolved {subject, body} pair instead of one string, and
  // falls back to the message's own wire subject/body untouched whenever
  // the body doesn't parse as this feature's envelope — every Mail Compose
  // message ever sent before this shipped, or from an identity that can't
  // do E2EE at all.
  async function unwrapMailFromWire(identity, senderPublicKey, wireSubject, wireBody) {
    let envelope;
    try {
      envelope = JSON.parse(wireBody);
    } catch (err) {
      return { subject: wireSubject, body: wireBody };
    }
    if (!envelope || envelope.v !== 1 || !envelope.key || !envelope.key.announcement) return { subject: wireSubject, body: wireBody };

    const peerPublicKeyJwk = envelope.key.announcement.chatE2eePublicKeyJwk;
    let keyIsGenuine = false;
    if (identity && identity.mode === 'local' && identity.privateKeyJwk && peerPublicKeyJwk) {
      keyIsGenuine = await verifyChatE2eeKeyAnnouncement(senderPublicKey, envelope.key);
      if (keyIsGenuine) await rememberE2eePeerPublicKey(identity, senderPublicKey, peerPublicKeyJwk);
    }

    if (!envelope.encrypted) {
      try {
        const parsed = JSON.parse(envelope.plaintext);
        return { subject: parsed.subject, body: parsed.body };
      } catch (err) {
        return { subject: wireSubject, body: '[unreadable message]' };
      }
    }

    if (!identity || identity.mode !== 'local' || !identity.privateKeyJwk) return { subject: wireSubject, body: '[Encrypted — unlock your wallet to read]' };
    if (!keyIsGenuine) return { subject: wireSubject, body: "[Could not verify sender's encryption key — message not shown]" };
    try {
      const ownKeyPair = await getChatE2eeKeyPair(identity);
      const sharedKey = await deriveEcdhSharedKey(ownKeyPair.privateKeyJwk, peerPublicKeyJwk, 'atlas.mail.e2ee.v1');
      const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64urlDecode(envelope.iv) }, sharedKey, b64urlDecode(envelope.ciphertext));
      const parsed = JSON.parse(new TextDecoder().decode(plaintext));
      return { subject: parsed.subject, body: parsed.body };
    } catch (err) {
      return { subject: wireSubject, body: '[Could not decrypt this message]' };
    }
  }

  // ---------- Mail: encrypting domain-to-subscriber mail ----------
  //
  // §11.1 mail has no bootstrap message to discover a peer key from — the
  // domain is always the one composing and sending first, never replying
  // to something this wallet sent. So instead of Chat/Mail Compose's
  // mutual negotiation, a local-mode identity registers its OWN encryption
  // public key with a domain ahead of time, scoped to one held credential
  // (the same id domain-to-subscriber mail already addresses by), proven
  // by presenting that exact credential plus a fresh signed proof of
  // holding its owner key — the same possession proof §5 step 3 already
  // requires everywhere else a credential is presented. issuer-server only
  // stores it once that checks out, so a stranger who merely learned a
  // credential id (mail's own "you have to already know the id" access
  // model) can't plant a key of their own and read future mail.
  //
  // Reuses the SAME per-identity ECDH keypair Chat's own E2EE already
  // generates — one encryption identity per wallet, not a third one.
  // Nothing here handles the DECRYPT side of a domain's reply, because a
  // domain never gets one: §11.1 mail is one-way, so there's only ever an
  // incoming message to unwrap (see unwrapDomainMailFromWire, called from
  // checkAllMail), never an outgoing encrypted one from this wallet.
  //
  // Best-effort and silent on failure — a domain that doesn't implement
  // this endpoint yet, or is simply unreachable, just keeps sending this
  // wallet plain (signed-only) mail, exactly as before this feature.
  async function registerMailEncryptionKey(domain, credential) {
    const identity = await getIdentity();
    if (!identity || identity.mode !== 'local' || !identity.privateKeyJwk) return; // WebAuthn can't run ECDH client-side — see getChatE2eeKeyPair's own comment
    const ownKeyPair = await getChatE2eeKeyPair(identity);
    const payload = { credentialId: credential.id, mailEncryptionPublicKeyJwk: ownKeyPair.publicKeyJwk };
    const proof = await signWithSelf(payload);
    try {
      await fetch(baseUrl(domain) + '/atlas/mail/register-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential, payload, proof })
      });
    } catch (err) {
      // unreachable domain — nothing to do; the next checkAllMail() retries
    }
  }

  // Called from checkAllMail on a domain-to-subscriber message (no
  // `message.from` — see that loop's own branch) — the ECIES-style
  // counterpart to unwrapMailFromWire above: no signed key announcement to
  // verify here, because there's no third-party relay to keep honest. This
  // domain IS the message's own author, already trusted via the outer
  // message signature verifyMailMessage checks before this ever runs — only
  // the registered recipient key needs trusting, and that was already
  // proven at registration time (see registerMailEncryptionKey above).
  async function unwrapDomainMailFromWire(identity, wireSubject, wireBody) {
    let envelope;
    try {
      envelope = JSON.parse(wireBody);
    } catch (err) {
      return { subject: wireSubject, body: wireBody };
    }
    if (!envelope || envelope.v !== 1 || !envelope.ephemeralPublicKeyJwk || !envelope.iv || !envelope.ciphertext) {
      return { subject: wireSubject, body: wireBody }; // not this feature's shape — pre-existing plain mail
    }
    if (!identity || identity.mode !== 'local' || !identity.privateKeyJwk) return { subject: wireSubject, body: '[Encrypted — unlock your wallet to read]' };
    try {
      const ownKeyPair = await getChatE2eeKeyPair(identity);
      const sharedKey = await deriveEcdhSharedKey(ownKeyPair.privateKeyJwk, envelope.ephemeralPublicKeyJwk, 'atlas.mail.e2ee.v1');
      const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64urlDecode(envelope.iv) }, sharedKey, b64urlDecode(envelope.ciphertext));
      const parsed = JSON.parse(new TextDecoder().decode(plaintext));
      return { subject: parsed.subject, body: parsed.body };
    } catch (err) {
      return { subject: wireSubject, body: '[Could not decrypt this message]' };
    }
  }

  // ---------- Chats: deletion (TODO round 2, item 3 — 2026-09-14) ----------
  //
  // Bruno asked for two things that turn out to be the same underlying
  // operation from two different UI entry points: "clear chat history"
  // from inside an open (chat view), and "delete individual chat" from
  // the (main view) thread list — both mean "forget every message with
  // this one counterparty," just triggered from different screens (a
  // cleared conversation stays open, now empty; a deleted one disappears
  // from the thread list entirely). One function covers both.
  //
  // Mirrors deleteMailMessage/clearAllMail's own two-part shape exactly:
  // removing entries from atlasChatMessages alone is NOT enough, because
  // checkAllMail()'s `knownIds` dedup only ever looks at what's CURRENTLY
  // in atlasChatMessages — delete a message's entry and the very next
  // poll would just re-fetch and re-add it from the relaying domain's
  // still-standing copy (there is no protocol-level way to ask a domain
  // to forget an old message either, same limitation mail's own delete
  // already documents). atlasDeletedChatIds is the permanent "seen but
  // deleted, never resurrect" suppression list that closes that gap —
  // see checkAllMail's own `knownIds` construction for where this gets
  // folded in.
  async function getDeletedChatIds(ownerPublicKey) {
    const { atlasDeletedChatIds } = await chrome.storage.local.get('atlasDeletedChatIds');
    return (atlasDeletedChatIds || {})[ownerPublicKey] || [];
  }

  async function addDeletedChatIds(ownerPublicKey, ids) {
    if (!ids.length) return;
    const { atlasDeletedChatIds } = await chrome.storage.local.get('atlasDeletedChatIds');
    const all = atlasDeletedChatIds || {};
    const existing = new Set(all[ownerPublicKey] || []);
    ids.forEach((id) => existing.add(id));
    all[ownerPublicKey] = Array.from(existing);
    await chrome.storage.local.set({ atlasDeletedChatIds: all });
  }

  // Deletes every stored message with one counterparty — "clear history"
  // (chat view) and "delete chat" (main view) both call this directly;
  // the only difference is what the UI does afterward (stay vs. go back).
  async function deleteChatThread(ownerPublicKey, counterpartyPublicKey) {
    await withMessageLock(async () => {
      const entries = await getChatMessages(ownerPublicKey);
      const toDelete = entries.filter((e) => e.counterpartyPublicKey === counterpartyPublicKey);
      if (toDelete.length === 0) return;
      const remaining = entries.filter((e) => e.counterpartyPublicKey !== counterpartyPublicKey);
      await addDeletedChatIds(ownerPublicKey, toDelete.map((e) => e.id));
      await saveChatMessages(ownerPublicKey, remaining);
    });
  }

  // Chats' own "last domain used" memory — separate storage key from Mail
  // Compose's getLastPostOfficeSendDomain/setLastPostOfficeSendDomain
  // (same reasoning as sendChatMessage not touching atlasSentMail: a chat
  // send should never silently change what Mail Compose defaults to next
  // time, and vice versa, even though both ultimately resolve a domain from
  // the same getPostOfficeMemberships() list).
  async function getLastChatSendDomain(ownerPublicKey) {
    const { atlasLastChatSendDomain } = await chrome.storage.local.get('atlasLastChatSendDomain');
    return (atlasLastChatSendDomain || {})[ownerPublicKey] || null;
  }

  async function setLastChatSendDomain(ownerPublicKey, domain) {
    const { atlasLastChatSendDomain } = await chrome.storage.local.get('atlasLastChatSendDomain');
    const all = atlasLastChatSendDomain || {};
    all[ownerPublicKey] = domain;
    await chrome.storage.local.set({ atlasLastChatSendDomain: all });
  }

  // ---------- Messaging window chrome settings ----------
  //
  // Same "client display preference, not identity data" reasoning as
  // getChatPanelSettings/getAssetViewerSettings above (outside any
  // per-identity wallet scope, untouched by locking/identity-switch). The
  // one thing neither of those two needs that this DOES — left/top — is
  // because Bruno's spec explicitly asked for this window to be freely
  // draggable ("moved around to the users desired location on the
  // canvas"), unlike chat (always bottom-left anchored) or the Asset
  // Viewer (always re-positioned by JS next to whatever card is hovered).
  // `positioned` distinguishes "never been dragged yet, use the CSS
  // default top-right corner" (false) from "has an explicit saved spot"
  // (true) — without it, a fresh install's default left/top of 0 would
  // have to be treated as if the user had actually dragged it there.
  const MESSAGING_MIN_WIDTH = 260;
  const MESSAGING_MAX_WIDTH = 560;
  const MESSAGING_MIN_HEIGHT = 260;
  const MESSAGING_MAX_HEIGHT = 640;
  const DEFAULT_MESSAGING_WINDOW_SETTINGS = {
    // width bumped 320 -> 360 (TODO round 1 item 3): adding the Calls tab
    // made the header's three-tab-bar wide enough, at the old default
    // width, to leave almost no empty header space to grab for
    // drag-to-move (see #messagingHeader's mousedown handler in viewer.js
    // — it only excludes clicks that land ON a button/tab, not clicks
    // squeezed into whatever sliver of #messagingHeaderSpacer is left).
    // 360 restores a comfortable empty strip next to the tab bar again.
    width: 360,
    height: 380,
    opacity: 0.92,
    left: 0,
    top: 0,
    positioned: false,
    activeTab: 'chats' // 'chats' | 'calls' | 'contacts'
  };

  // 'calls' (TODO round 1 item 3) was missed here when the Calls tab was
  // first added — this clamp only accepted 'chats'/'contacts', so leaving
  // the window on Calls and reopening it silently clamped back to Chats.
  // Fixed by checking membership in the same three-value set viewer.js's
  // own MESSAGING_TABS constant uses, rather than special-casing each
  // value one at a time.
  const VALID_MESSAGING_TABS = ['chats', 'calls', 'contacts'];

  function clampMessagingWindowSettings(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    return {
      width: Number.isFinite(Number(s.width)) ? Math.max(MESSAGING_MIN_WIDTH, Math.min(MESSAGING_MAX_WIDTH, Number(s.width))) : DEFAULT_MESSAGING_WINDOW_SETTINGS.width,
      height: Number.isFinite(Number(s.height)) ? Math.max(MESSAGING_MIN_HEIGHT, Math.min(MESSAGING_MAX_HEIGHT, Number(s.height))) : DEFAULT_MESSAGING_WINDOW_SETTINGS.height,
      opacity: Number.isFinite(Number(s.opacity)) ? Math.max(0.2, Math.min(1, Number(s.opacity))) : DEFAULT_MESSAGING_WINDOW_SETTINGS.opacity,
      left: Number.isFinite(Number(s.left)) ? Number(s.left) : DEFAULT_MESSAGING_WINDOW_SETTINGS.left,
      top: Number.isFinite(Number(s.top)) ? Number(s.top) : DEFAULT_MESSAGING_WINDOW_SETTINGS.top,
      positioned: !!s.positioned,
      activeTab: VALID_MESSAGING_TABS.includes(s.activeTab) ? s.activeTab : 'chats'
    };
  }

  async function getMessagingWindowSettings() {
    const { atlasMessagingWindowSettings } = await chrome.storage.local.get('atlasMessagingWindowSettings');
    return clampMessagingWindowSettings(atlasMessagingWindowSettings);
  }

  async function setMessagingWindowSettings(patch) {
    const current = await getMessagingWindowSettings();
    const merged = clampMessagingWindowSettings(Object.assign({}, current, patch));
    await chrome.storage.local.set({ atlasMessagingWindowSettings: merged });
    return merged;
  }

  // ---------- sent mail (this wallet's own outgoing Post Office history) ----------
  //
  // sendUserMail() above never touched local storage before this — the
  // message lived entirely on the recipient's domain. This is purely a
  // local record of what THIS wallet has sent, for its own Sent tab;
  // nothing here is read by the protocol side, and (same as the received
  // side's mail) there's no way to un-send or edit what a domain already
  // relayed — Delete/Clear below only remove the local record of it.
  // Encrypted at rest (2026-09-14, second round) — same treatment as
  // getMail/saveMail above.
  async function getSentMail(ownerPublicKey) {
    const { atlasSentMail } = await chrome.storage.local.get('atlasSentMail');
    const identity = await getIdentity();
    return decryptAtRestAndMigrate(identity, 'sentMail', (atlasSentMail || {})[ownerPublicKey], [], (v) => saveSentMail(ownerPublicKey, v));
  }

  async function saveSentMail(ownerPublicKey, entries) {
    const { atlasSentMail } = await chrome.storage.local.get('atlasSentMail');
    const all = atlasSentMail || {};
    const identity = await getIdentity();
    all[ownerPublicKey] = await encryptAtRest(identity, 'sentMail', entries);
    await chrome.storage.local.set({ atlasSentMail: all });
  }

  async function deleteSentMailMessage(ownerPublicKey, messageId) {
    const entries = await getSentMail(ownerPublicKey);
    const remaining = entries.filter((e) => e.id !== messageId);
    await saveSentMail(ownerPublicKey, remaining);
  }

  async function clearAllSentMail(ownerPublicKey) {
    await saveSentMail(ownerPublicKey, []);
  }

  // ---------- mail-tab dropdown UI convenience: remember the last domain picked ----------
  //
  // Purely a UI nicety, not protocol state: both Post Office domain
  // pickers in the Mail tab (Compose's "send via", and Mail Settings'
  // "which membership to configure") used to always reopen on a blank
  // placeholder, even when this wallet only ever uses one Post Office.
  // Two separate keys, both scoped per identity like the rest of this
  // section, since "send via" and "which membership to configure" are
  // different questions that can reasonably land on different domains —
  // and different identities in the same wallet can belong to different
  // Post Offices entirely.
  async function getLastPostOfficeSendDomain(ownerPublicKey) {
    const { atlasLastPostOfficeSendDomain } = await chrome.storage.local.get('atlasLastPostOfficeSendDomain');
    return (atlasLastPostOfficeSendDomain || {})[ownerPublicKey] || null;
  }

  async function setLastPostOfficeSendDomain(ownerPublicKey, domain) {
    const { atlasLastPostOfficeSendDomain } = await chrome.storage.local.get('atlasLastPostOfficeSendDomain');
    const all = atlasLastPostOfficeSendDomain || {};
    all[ownerPublicKey] = domain || null;
    await chrome.storage.local.set({ atlasLastPostOfficeSendDomain: all });
  }

  async function getLastPostOfficeSettingsDomain(ownerPublicKey) {
    const { atlasLastPostOfficeSettingsDomain } = await chrome.storage.local.get('atlasLastPostOfficeSettingsDomain');
    return (atlasLastPostOfficeSettingsDomain || {})[ownerPublicKey] || null;
  }

  async function setLastPostOfficeSettingsDomain(ownerPublicKey, domain) {
    const { atlasLastPostOfficeSettingsDomain } = await chrome.storage.local.get('atlasLastPostOfficeSettingsDomain');
    const all = atlasLastPostOfficeSettingsDomain || {};
    all[ownerPublicKey] = domain || null;
    await chrome.storage.local.set({ atlasLastPostOfficeSettingsDomain: all });
  }

  // Which domains this identity can currently send through — every
  // atlas.postoffice.membership credential this wallet holds, one entry
  // per domain that's issued one (in practice at most one per domain,
  // since the stall's oncePerUser cap prevents duplicates). Used by the
  // Compose UI to offer a "send via" choice drawn from Post Offices this
  // wallet has actually joined, rather than a free-text domain field —
  // since task #94, sending only works through a domain you're a member
  // of, so guessing a domain name is no longer useful there.
  async function getPostOfficeMemberships(ownerPublicKey) {
    const wallet = await getWallet(ownerPublicKey);
    return wallet
      .filter((e) => e.credential && e.credential.asset && e.credential.asset.class === 'atlas.postoffice.membership')
      .map((e) => ({ domain: e.credential.issuer.domain, credentialId: e.credential.id }));
  }

  // Task #144 Phase 1 — exact analogue of getPostOfficeMemberships above,
  // for the new atlas.tradingstation.membership class instead. Returns the
  // full credential (not just its id) since submitTradeIntent needs to
  // present it whole with every /atlas/trade/submit call — unlike Post
  // Office sends, which only ever need the domain + a credentialId to
  // address by.
  async function getTradingStationMemberships(ownerPublicKey) {
    const wallet = await getWallet(ownerPublicKey);
    return wallet
      .filter((e) => e.credential && e.credential.asset && e.credential.asset.class === 'atlas.tradingstation.membership')
      .map((e) => ({ domain: e.credential.issuer.domain, credentialId: e.credential.id, credential: e.credential }));
  }

  // Task #94 (consent/block model, "both, recipient's choice" per direct
  // instruction): four thin wrappers around the settings endpoints
  // POST /atlas/postoffice/mailmode, /block, /unblock, /mysettings add
  // (see server.js's own comment on those) — same self-signed-envelope
  // shape sendUserMail above already uses (signWithSelf over the payload,
  // proof.publicKey IS the caller server-side), just against a different
  // route each. All four operate on THIS wallet's OWN membership at
  // `domain` — there's no way to name someone else's.

  // Switches this wallet's mail mode at `domain` between "open" (accept
  // from any fellow member, the long-standing default) and "friendsOnly".
  // Turning friendsOnly ON submits the CURRENT contents of this wallet's
  // local Friends list (getFriends() — otherwise entirely client-side, see
  // that function's own comment) to `domain` as an explicit one-time
  // snapshot; it is not kept in sync automatically afterward — call this
  // again later to update it, same as any other "sync" action elsewhere in
  // this file. Turning it back to "open" clears that snapshot server-side.
  async function setPostOfficeMailMode(domain, mode) {
    if (!domain) throw new Error('domain is required.');
    if (mode !== 'open' && mode !== 'friendsOnly') throw new Error('mode must be "open" or "friendsOnly".');
    const friends = mode === 'friendsOnly' ? (await getFriends()).map((f) => f.publicKey) : undefined;
    const payload = mode === 'friendsOnly' ? { mode, friends } : { mode };
    const proof = await signWithSelf(payload);
    const res = await fetch(baseUrl(domain) + '/atlas/postoffice/mailmode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload, proof })
    });
    if (!res.ok) throw new Error('Setting mail mode failed: ' + (await res.text()));
    return await res.json();
  }

  async function blockPostOfficeSender(domain, blockedPublicKey) {
    if (!domain) throw new Error('domain is required.');
    if (!blockedPublicKey) throw new Error('blockedPublicKey is required.');
    const payload = { blockedPublicKey };
    const proof = await signWithSelf(payload);
    const res = await fetch(baseUrl(domain) + '/atlas/postoffice/block', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload, proof })
    });
    if (!res.ok) throw new Error('Block failed: ' + (await res.text()));
    return await res.json();
  }

  async function unblockPostOfficeSender(domain, blockedPublicKey) {
    if (!domain) throw new Error('domain is required.');
    if (!blockedPublicKey) throw new Error('blockedPublicKey is required.');
    const payload = { blockedPublicKey };
    const proof = await signWithSelf(payload);
    const res = await fetch(baseUrl(domain) + '/atlas/postoffice/unblock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload, proof })
    });
    if (!res.ok) throw new Error('Unblock failed: ' + (await res.text()));
    return await res.json();
  }

  // Reads this wallet's OWN current settings back from `domain` — the one
  // Post Office roster lookup that's safe to expose over HTTP despite the
  // no-public-listing reasoning behind #96's send-activity tracking never
  // getting an endpoint: it's gated the same self-signed way as the writes
  // above, so it only ever returns the caller's own entry. Used to
  // populate the Mail settings panel without the wallet having to keep its
  // own separate copy of what it last told each domain.
  async function getPostOfficeSettings(domain) {
    if (!domain) throw new Error('domain is required.');
    // A non-empty payload, deliberately — an empty object round-trips
    // through JSON fine in JS but the PHP issuer's json_decode() turns
    // `{}` into an empty PHP array, which PHP's canonicalize() then
    // serializes as `[]` instead of `{}`, breaking the signature check
    // cross-language. Any real field sidesteps the ambiguity; `purpose`
    // is unused server-side beyond being part of what's signed, same as
    // presentIdentity()'s own challenge object above.
    const payload = { purpose: 'postoffice-mysettings' };
    const proof = await signWithSelf(payload);
    const res = await fetch(baseUrl(domain) + '/atlas/postoffice/mysettings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload, proof })
    });
    if (!res.ok) throw new Error('Loading settings failed: ' + (await res.text()));
    return await res.json();
  }

  // Task #94 (handle addressing, the last remaining Post Office piece —
  // "hide the raw public key from users", per direct instruction): claims,
  // changes, or releases this wallet's OWN handle at `domain`. Same
  // self-signed-envelope shape as setPostOfficeMailMode above. Pass '' or
  // null/undefined to release the current handle instead of claiming one.
  // Deliberately `handle#domain`, not `handle@domain` — the @ shape reads
  // as a real email address and would mislead people about what this
  // actually is (no inbox provider, no password recovery, nothing like
  // SMTP underneath).
  async function setPostOfficeHandle(domain, handle) {
    if (!domain) throw new Error('domain is required.');
    const payload = { handle: handle || null };
    const proof = await signWithSelf(payload);
    const res = await fetch(baseUrl(domain) + '/atlas/postoffice/handle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload, proof })
    });
    if (!res.ok) throw new Error('Setting handle failed: ' + (await res.text()));
    return await res.json();
  }

  // Turns a bare handle into the public key it currently belongs to at
  // `domain` — the lookup step Compose runs before sendUserMail, so
  // sending by handle is otherwise indistinguishable from sending by raw
  // public key once this resolves. No signing needed (see server.js's own
  // comment on /atlas/postoffice/resolve: looking up something you already
  // know the name of doesn't require proving who's asking).
  async function resolvePostOfficeHandle(domain, handle) {
    if (!domain) throw new Error('domain is required.');
    if (!handle) throw new Error('handle is required.');
    const res = await fetch(baseUrl(domain) + '/atlas/postoffice/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle })
    });
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || ('Could not find "' + handle + '" at ' + domain + '.'));
    return await res.json();
  }

  // A message you've deleted needs to STAY gone across future checks —
  // checkAllMail() below dedupes against ids it's already stored, but
  // deleting removes it from that same array, so without tracking deleted
  // ids separately a deleted message would just come right back on the
  // next periodic check. This is the "seen but deleted" list that stops
  // that: small, just ids, kept forever per owner (there's no protocol-
  // level way to ask a domain to stop offering an old message, so this is
  // the only thing that can permanently suppress it client-side).
  async function getDeletedMailIds(ownerPublicKey) {
    const { atlasDeletedMailIds } = await chrome.storage.local.get('atlasDeletedMailIds');
    return (atlasDeletedMailIds || {})[ownerPublicKey] || [];
  }

  async function addDeletedMailIds(ownerPublicKey, ids) {
    if (!ids.length) return;
    const { atlasDeletedMailIds } = await chrome.storage.local.get('atlasDeletedMailIds');
    const all = atlasDeletedMailIds || {};
    const existing = new Set(all[ownerPublicKey] || []);
    ids.forEach((id) => existing.add(id));
    all[ownerPublicKey] = Array.from(existing);
    await chrome.storage.local.set({ atlasDeletedMailIds: all });
  }

  async function deleteMailMessage(ownerPublicKey, messageId) {
    await withMessageLock(async () => {
      const entries = await getMail(ownerPublicKey);
      const remaining = entries.filter((e) => e.message.id !== messageId);
      await addDeletedMailIds(ownerPublicKey, [messageId]);
      await saveMail(ownerPublicKey, remaining);
    });
  }

  async function clearAllMail(ownerPublicKey) {
    await withMessageLock(async () => {
      const entries = await getMail(ownerPublicKey);
      await addDeletedMailIds(ownerPublicKey, entries.map((e) => e.message.id));
      await saveMail(ownerPublicKey, []);
    });
  }

  // SPEC.md §3.8.2 — pending wallet-bridge asset offers. A SEPARATE
  // encrypted-at-rest store from atlasMail (storeName 'bridgeOffers', not
  // 'mail') rather than modeling an offer as a synthetic mail entry: mail
  // is subject to checkAllMail()/clearAllMail()'s own domain-mail-check
  // lifecycle, and a live page's bridge offer has nothing to do with any
  // of that — conflating the two risked exactly the kind of subtle bug
  // this project's negative-control discipline is meant to catch, for the
  // sake of reusing a render function that isn't actually hard to write a
  // second time. getBridgeOffers/saveBridgeOffers otherwise mirror
  // getMail/saveMail exactly, including the same decryptAtRestAndMigrate
  // one-time upgrade path every other store here already pays for.
  async function getBridgeOffers(ownerPublicKey) {
    const { atlasBridgeOffers } = await chrome.storage.local.get('atlasBridgeOffers');
    const identity = await getIdentity();
    return decryptAtRestAndMigrate(identity, 'bridgeOffers', (atlasBridgeOffers || {})[ownerPublicKey], [], (v) => saveBridgeOffers(ownerPublicKey, v));
  }

  async function saveBridgeOffers(ownerPublicKey, entries) {
    const { atlasBridgeOffers } = await chrome.storage.local.get('atlasBridgeOffers');
    const all = atlasBridgeOffers || {};
    const identity = await getIdentity();
    all[ownerPublicKey] = await encryptAtRest(identity, 'bridgeOffers', entries);
    await chrome.storage.local.set({ atlasBridgeOffers: all });
  }

  // Called by confirm-bridge.js itself once a visitor approves a
  // whitelisted offerAsset() request (see that file and content.js's
  // handleBridgeRequest 'offerAsset' branch) — the same "every extension
  // page already has the same unrestricted AtlasWallet access
  // background.js does" reasoning signWithSelf's own export comment gives
  // applies here too, so this queues directly rather than relaying
  // through one more hop.
  //
  // Deliberately shallow: only enough shape-sanity to render a preview
  // card (a credential shape, an asset with a name/class) — the real
  // cryptographic check (verifyCredential, SPEC.md §5 step 1) is deferred
  // to claimBridgeOffer below, exactly the same deferral claimMailGift
  // already relies on for an attached gift. Throws on a credential that
  // isn't even shaped like one, rather than queuing something there'd be
  // nothing coherent to show in the pending list.
  async function queueBridgeOffer(ownerPublicKey, origin, credential) {
    if (!credential || credential.credential !== 'domain-atlas-asset/1.0' || !credential.asset || typeof credential.asset.class !== 'string' || !credential.asset.class) {
      throw new Error('not a valid asset credential');
    }
    const entries = await getBridgeOffers(ownerPublicKey);
    const entry = {
      id: 'bridgeoffer:' + b64urlEncode(crypto.getRandomValues(new Uint8Array(16))),
      origin,
      credential,
      queuedAt: new Date().toISOString(),
      claimed: false
    };
    entries.push(entry);
    await saveBridgeOffers(ownerPublicKey, entries);
    return entry;
  }

  // SPEC.md §3.8.2 — the explicit Claim action, the only path a pending
  // bridge offer ever actually enters the wallet. Mirrors claimMailGift
  // above field-for-field: same ownership check against the credential's
  // own signed owner.publicKey, same verifyCredential() call (this is
  // where the real four-step check, SPEC.md §5 step 1, actually runs —
  // never earlier), same push onto the live wallet plus
  // autoConsolidateAssetWallet. Leaves the claimed entry in the list
  // (flagged, not removed) so a claimed offer still has something to show,
  // distinct from a dismissed or never-claimed one.
  async function claimBridgeOffer(ownerPublicKey, offerId) {
    const entries = await getBridgeOffers(ownerPublicKey);
    const entry = entries.find((e) => e.id === offerId);
    if (!entry) throw new Error('bridge offer not found');
    if (entry.claimed) throw new Error('this offer has already been claimed');

    const credential = entry.credential;
    if (!credential.owner || credential.owner.publicKey !== ownerPublicKey) {
      throw new Error('this offer was not addressed to this identity');
    }
    const verdict = await verifyCredential(credential);
    if (!verdict.valid) throw new Error('offer credential does not check out: ' + verdict.reason);

    const wallet = await getWallet(ownerPublicKey);
    wallet.push({ credential, lastVerdict: verdict });
    await saveWallet(ownerPublicKey, wallet);
    await autoConsolidateAssetWallet(ownerPublicKey);

    entry.claimed = true;
    await saveBridgeOffers(ownerPublicKey, entries);
    return { credential, verdict };
  }

  // The visitor's explicit "no thanks" — distinct from both "not
  // whitelisted" (content.js never even queues one of those) and
  // "claimed" (claimBridgeOffer above). Removes the entry outright rather
  // than flagging it dismissed; unlike an unclaimed mail gift's credential
  // (claimMailGift's own comment on why deleting that message is
  // blocked), nothing here is the only copy of anything — the offering
  // page still has, and presumably still holds, the credential it
  // offered — so there's no "destroying the only copy" risk a disabled
  // button would need to guard against.
  async function dismissBridgeOffer(ownerPublicKey, offerId) {
    const entries = await getBridgeOffers(ownerPublicKey);
    const entry = entries.find((e) => e.id === offerId);
    if (!entry) throw new Error('bridge offer not found');
    if (entry.claimed) throw new Error('this offer has already been claimed');
    const remaining = entries.filter((e) => e.id !== offerId);
    await saveBridgeOffers(ownerPublicKey, remaining);
  }

  // SPEC.md §3.8.3 — per-identity trusted offer domains. A plain list of
  // origins, not classes or purposes — trust here is "I don't need to be
  // asked by THIS domain again," never "this specific asset class is
  // always fine," which stays entirely governed by the manifest's own
  // policy.walletBridge.offer whitelist (checked in content.js exactly as
  // before; nothing here changes what a domain is PERMITTED to offer,
  // only whether a visitor still wants to be asked about it every time).
  // Same encrypted-at-rest treatment as every other per-identity list in
  // this file.
  async function getTrustedBridgeDomains(ownerPublicKey) {
    const { atlasTrustedBridgeDomains } = await chrome.storage.local.get('atlasTrustedBridgeDomains');
    const identity = await getIdentity();
    return decryptAtRestAndMigrate(identity, 'trustedBridgeDomains', (atlasTrustedBridgeDomains || {})[ownerPublicKey], [], (v) => saveTrustedBridgeDomains(ownerPublicKey, v));
  }

  async function saveTrustedBridgeDomains(ownerPublicKey, entries) {
    const { atlasTrustedBridgeDomains } = await chrome.storage.local.get('atlasTrustedBridgeDomains');
    const all = atlasTrustedBridgeDomains || {};
    const identity = await getIdentity();
    all[ownerPublicKey] = await encryptAtRest(identity, 'trustedBridgeDomains', entries);
    await chrome.storage.local.set({ atlasTrustedBridgeDomains: all });
  }

  // Called only from confirm-bridge.js's own offer-approval handler, when
  // the visitor explicitly checked the opt-in box on that prompt — never
  // from anything a page can trigger on its own (see that file's own
  // comment on the checkbox). A no-op, not an error, if this origin is
  // somehow already trusted — the same "adding a favorite twice" posture
  // addFavoriteDomain already takes.
  async function trustBridgeDomain(ownerPublicKey, origin) {
    const trusted = await getTrustedBridgeDomains(ownerPublicKey);
    if (trusted.some((t) => t.origin === origin)) return;
    trusted.push({ origin, trustedAt: new Date().toISOString() });
    await saveTrustedBridgeDomains(ownerPublicKey, trusted);
  }

  async function untrustBridgeDomain(ownerPublicKey, origin) {
    const trusted = await getTrustedBridgeDomains(ownerPublicKey);
    const remaining = trusted.filter((t) => t.origin !== origin);
    await saveTrustedBridgeDomains(ownerPublicKey, remaining);
  }

  // Called from background.js (the only context that both has AtlasWallet
  // AND is where content.js's offerAsset handling actually asks this
  // question — see content.js's own comment on why that round trip exists
  // at all) to decide, BEFORE ever opening the confirmation overlay,
  // whether this specific origin can skip it for the active identity.
  async function isTrustedBridgeDomain(ownerPublicKey, origin) {
    const trusted = await getTrustedBridgeDomains(ownerPublicKey);
    return trusted.some((t) => t.origin === origin);
  }

  // Same shape of check as verifyCredential() above, just over a mail
  // payload instead of a credential payload — an unverified message is
  // never trusted or shown, same as an unverified credential.
  async function verifyMailMessage(domain, message) {
    try {
      const base = baseUrl(domain);
      const keyDoc = await fetch(base + '/.well-known/atlas-key.json', { cache: 'no-store' }).then((r) => r.json());
      const sentAt = new Date(message.sentAt).getTime();
      const activeKey = (keyDoc.keys || []).find((k) => {
        const from = new Date(k.validFrom).getTime();
        const until = k.validUntil ? new Date(k.validUntil).getTime() : Infinity;
        return sentAt >= from && sentAt <= until;
      });
      if (!activeKey) return false;
      // Task #59: attachedAsset (when present) rides inside the signed
      // payload, exactly as issuer-server/server.js's /atlas/mail/send
      // signs it — omitting it here when it's actually present would make
      // every gift message fail verification, and a tampered-with gift
      // (swapped for a different one after signing) would fail it too,
      // which is the whole point.
      //
      // Task #75/#87 (SPEC.md §11.3): `from` (when present) is the same
      // deal — a Post Office-relayed user-to-user message carries who it's
      // actually from, signed by the RECEIVING domain the same as every
      // other field here, so a domain can't relay a message and then quietly
      // relabel who it came from. This is the one addition needed to trust
      // relayed mail through the exact same check as domain-to-subscriber
      // mail — nothing else about verification changes, because the
      // signature being checked is still just this domain's own key, same
      // as always.
      const payload = {
        id: message.id, credentialId: message.credentialId, subject: message.subject, body: message.body,
        ...(message.attachedAsset ? { attachedAsset: message.attachedAsset } : {}),
        ...(message.from ? { from: message.from } : {}),
        sentAt: message.sentAt
      };
      const data = new TextEncoder().encode(canonicalize(payload));
      const publicKey = await crypto.subtle.importKey('raw', b64urlDecode(activeKey.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
      return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, b64urlDecode(message.signature), data);
    } catch (err) {
      return false;
    }
  }

  // ---------- Friend requests over the Post Office ----------
  //
  // A friend request by handle (bruno#example.com) travels as ordinary Post
  // Office mail, so it crosses domains through the same relay as any other
  // message (SPEC.md §11.4) and needs nothing new from an issuer. Like Chat,
  // it is told apart by a reserved subject: no person can type a leading NUL
  // into a subject line, and checkAllMail() diverts a marked message into
  // atlasFriendRequests instead of the Mail inbox. The body is a small JSON
  // object, {v: 1, type: 'request', note?} or {v: 1, type: 'accepted'}.
  //
  // Consent is two-sided. The sender is NOT added to anyone's contacts when
  // the request goes out; it waits in `outgoing` until an 'accepted' notice
  // comes back from that same key, and only then does the sender's wallet
  // add the contact. The recipient adds the contact only on Accept. A decline
  // sends nothing, so a stranger cannot tell "declined" from "not seen yet"
  // (the same rule SPEC.md §11.3 step 3 applies to blocks). If both people
  // send each other a request, the second one to arrive is treated as an
  // acceptance. An 'accepted' notice from a key that was never sent a request
  // is ignored, so nobody can push themselves into a contact list.
  //
  // Per-owner state, encrypted at rest like the other personal stores:
  //   incoming: requests waiting for Accept/Decline
  //   outgoing: requests sent and not yet answered
  //   notices:  'accepted' replies not yet delivered (retried by
  //             flushFriendNotices on every mail check)
  //   seen:     ids of processed marker messages, so a poll never replays one
  const FRIEND_SUBJECT_MARKER = '\u0000atlas.friend.v1';
  const FRIEND_NOTE_MAX = 140;
  const FRIEND_INCOMING_CAP = 200;
  const FRIEND_SEEN_CAP = 2000;
  const FRIEND_NOTICE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

  function isFriendTransportMessage(subject) {
    return subject === FRIEND_SUBJECT_MARKER;
  }

  function normalizeFriendRequestState(state) {
    const s = (state && typeof state === 'object') ? state : {};
    return {
      incoming: Array.isArray(s.incoming) ? s.incoming : [],
      outgoing: Array.isArray(s.outgoing) ? s.outgoing : [],
      notices: Array.isArray(s.notices) ? s.notices : [],
      seen: Array.isArray(s.seen) ? s.seen : []
    };
  }

  async function getFriendRequestState(ownerPublicKey) {
    const { atlasFriendRequests } = await chrome.storage.local.get('atlasFriendRequests');
    const identity = await getIdentity();
    const state = await decryptAtRestAndMigrate(identity, 'friendRequests', (atlasFriendRequests || {})[ownerPublicKey], null, (v) => saveFriendRequestState(ownerPublicKey, normalizeFriendRequestState(v)));
    return normalizeFriendRequestState(state);
  }

  async function saveFriendRequestState(ownerPublicKey, state) {
    const { atlasFriendRequests } = await chrome.storage.local.get('atlasFriendRequests');
    const all = atlasFriendRequests || {};
    const identity = await getIdentity();
    all[ownerPublicKey] = await encryptAtRest(identity, 'friendRequests', normalizeFriendRequestState(state));
    await chrome.storage.local.set({ atlasFriendRequests: all });
  }

  // Read-modify-write of the state under the same lock that guards mail and
  // chat, so a mail check and a click on Accept cannot overwrite each other.
  function updateFriendRequestState(ownerPublicKey, mutate) {
    return withMessageLock(async () => {
      const state = await getFriendRequestState(ownerPublicKey);
      const result = await mutate(state);
      await saveFriendRequestState(ownerPublicKey, state);
      return result;
    });
  }

  async function getIncomingFriendRequests(ownerPublicKey) {
    return (await getFriendRequestState(ownerPublicKey)).incoming;
  }

  async function getOutgoingFriendRequests(ownerPublicKey) {
    return (await getFriendRequestState(ownerPublicKey)).outgoing;
  }

  function cleanFriendNote(note) {
    return String(note || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, FRIEND_NOTE_MAX);
  }

  function parseFriendBody(body) {
    try {
      const parsed = JSON.parse(body);
      if (!parsed || parsed.v !== 1) return null;
      if (parsed.type === 'request') return { type: 'request', note: cleanFriendNote(parsed.note) };
      if (parsed.type === 'accepted') return { type: 'accepted' };
    } catch (err) {
      // not one of ours
    }
    return null;
  }

  // handle#domain as shown to the person; `domain` is the sender's home
  // (from.homeDomain on a relayed message, else the domain it arrived from).
  function friendDisplayName(entry) {
    return entry.handle ? entry.handle + '#' + entry.homeDomain : null;
  }

  // Sends a friend request. Give either {handle, recipientDomain} (looked up
  // at the recipient's own Post Office) or {publicKey, recipientDomain}.
  // `viaDomain` must be a Post Office this wallet is a member of; the
  // recipient does not have to be a member of it.
  async function sendFriendRequest({ viaDomain, handle, publicKey, recipientDomain, name, note }) {
    const identity = await getIdentity();
    if (!identity) throw new Error('Set up or unlock an identity first.');
    if (!viaDomain) throw new Error('Choose a Post Office to send through.');
    const memberships = await getPostOfficeMemberships(identity.publicKey);
    if (!memberships.some((m) => m.domain === viaDomain)) {
      throw new Error('You have not joined ' + viaDomain + '\'s Post Office yet.');
    }
    let key = publicKey;
    const homeDomain = recipientDomain || viaDomain;
    if (!key) {
      if (!handle) throw new Error('Enter their handle.');
      const resolved = await resolvePostOfficeHandle(homeDomain, handle);
      key = resolved.publicKey;
    }
    if (key === identity.publicKey) throw new Error('That is your own address.');
    const friends = await getFriends();
    if (friends.some((f) => f.publicKey === key)) throw new Error('They are already in your contacts.');

    const displayName = (name || '').trim().slice(0, MAX_ALIAS_LENGTH) || handle || 'Friend';

    // They already asked us: answering with our own request is an acceptance.
    const state = await getFriendRequestState(identity.publicKey);
    if (state.incoming.some((r) => r.publicKey === key)) {
      await acceptFriendRequest(key, displayName);
      return { accepted: true, publicKey: key };
    }

    const body = JSON.stringify({ v: 1, type: 'request', note: cleanFriendNote(note) });
    await postOfficeSendRaw(viaDomain, { publicKey: key, domain: homeDomain }, FRIEND_SUBJECT_MARKER, body);
    await updateFriendRequestState(identity.publicKey, (s) => {
      s.outgoing = s.outgoing.filter((r) => r.publicKey !== key);
      s.outgoing.push({ publicKey: key, name: displayName, handle: handle || null, recipientDomain: homeDomain, viaDomain, note: cleanFriendNote(note), sentAt: new Date().toISOString() });
    });
    return { accepted: false, publicKey: key };
  }

  async function cancelOutgoingFriendRequest(publicKey) {
    const identity = await getIdentity();
    if (!identity) return;
    await updateFriendRequestState(identity.publicKey, (s) => { s.outgoing = s.outgoing.filter((r) => r.publicKey !== publicKey); });
  }

  // Accept: add the contact, then tell the sender. The notice is queued
  // before it is sent so a failed send is retried rather than lost.
  async function acceptFriendRequest(publicKey, name) {
    const identity = await getIdentity();
    if (!identity) throw new Error('Set up or unlock an identity first.');
    let request = null;
    await updateFriendRequestState(identity.publicKey, (s) => {
      request = s.incoming.find((r) => r.publicKey === publicKey) || null;
    });
    if (!request) throw new Error('No pending request from that person.');
    const label = (name || '').trim() || friendDisplayName(request) || 'Friend';
    await addFriend(publicKey, label);
    await updateFriendRequestState(identity.publicKey, (s) => {
      s.incoming = s.incoming.filter((r) => r.publicKey !== publicKey);
      queueFriendNotice(s, request.publicKey, request.homeDomain, request.via);
    });
    try { await flushFriendNotices(); } catch (err) { /* stays queued, retried on the next mail check */ }
    return { publicKey };
  }

  // Decline sends nothing at all.
  async function declineFriendRequest(publicKey) {
    const identity = await getIdentity();
    if (!identity) return;
    await updateFriendRequestState(identity.publicKey, (s) => { s.incoming = s.incoming.filter((r) => r.publicKey !== publicKey); });
  }

  function queueFriendNotice(state, publicKey, toDomain, viaDomain) {
    state.notices = state.notices.filter((n) => n.publicKey !== publicKey);
    state.notices.push({ publicKey, toDomain: toDomain || null, via: viaDomain, queuedAt: new Date().toISOString() });
  }

  // Delivers queued 'accepted' notices. A rejection from the other side (4xx
  // other than 429) is final and drops the notice; a network error, 5xx or
  // 429 keeps it for the next attempt, up to FRIEND_NOTICE_MAX_AGE_MS.
  async function flushFriendNotices() {
    const identity = await getIdentity();
    if (!identity) return 0;
    const state = await getFriendRequestState(identity.publicKey);
    if (!state.notices.length) return 0;
    const done = new Set();
    let delivered = 0;
    for (const notice of state.notices) {
      const age = Date.now() - new Date(notice.queuedAt).getTime();
      if (age > FRIEND_NOTICE_MAX_AGE_MS) { done.add(notice.publicKey); continue; }
      try {
        await postOfficeSendRaw(notice.via, { publicKey: notice.publicKey, domain: notice.toDomain }, FRIEND_SUBJECT_MARKER, JSON.stringify({ v: 1, type: 'accepted' }));
        done.add(notice.publicKey);
        delivered++;
      } catch (err) {
        if (err && err.status && err.status >= 400 && err.status < 500 && err.status !== 429) done.add(notice.publicKey);
      }
    }
    if (done.size) {
      await updateFriendRequestState(identity.publicKey, (s) => { s.notices = s.notices.filter((n) => !done.has(n.publicKey)); });
    }
    return delivered;
  }

  // Applies friend-marker messages that checkAllMail() collected. Each item
  // is {id, publicKey, handle, homeDomain, via, sentAt, body}.
  async function processFriendMessages(identity, items) {
    if (!items.length) return;
    const friends = await getFriends();
    const friendKeys = new Set(friends.map((f) => f.publicKey));
    const toAdd = [];
    await updateFriendRequestState(identity.publicKey, (s) => {
      const seen = new Set(s.seen);
      items.sort((a, b) => new Date(a.sentAt) - new Date(b.sentAt));
      for (const item of items) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        if (!item.publicKey || item.publicKey === identity.publicKey) continue;
        const parsed = parseFriendBody(item.body);
        if (!parsed) continue;
        const pending = s.outgoing.find((r) => r.publicKey === item.publicKey);
        if (parsed.type === 'accepted') {
          if (!pending) continue; // never asked: ignore
          s.outgoing = s.outgoing.filter((r) => r.publicKey !== item.publicKey);
          toAdd.push({ publicKey: item.publicKey, name: pending.name });
          friendKeys.add(item.publicKey);
          continue;
        }
        // type === 'request'
        if (friendKeys.has(item.publicKey)) {
          // Already contacts (they may have lost us): confirm so they re-add.
          queueFriendNotice(s, item.publicKey, item.homeDomain, item.via);
          continue;
        }
        if (pending) {
          s.outgoing = s.outgoing.filter((r) => r.publicKey !== item.publicKey);
          toAdd.push({ publicKey: item.publicKey, name: pending.name });
          friendKeys.add(item.publicKey);
          queueFriendNotice(s, item.publicKey, item.homeDomain, item.via);
          continue;
        }
        s.incoming = s.incoming.filter((r) => r.publicKey !== item.publicKey);
        s.incoming.push({ publicKey: item.publicKey, handle: item.handle || null, homeDomain: item.homeDomain, via: item.via, note: parsed.note, receivedAt: new Date().toISOString(), messageId: item.id });
      }
      if (s.incoming.length > FRIEND_INCOMING_CAP) s.incoming = s.incoming.slice(-FRIEND_INCOMING_CAP);
      s.seen = Array.from(seen).slice(-FRIEND_SEEN_CAP);
    });
    for (const entry of toAdd) await addFriend(entry.publicKey, entry.name);
  }

  // ---------- asset update notices (SPEC.md §5.1.1) ----------
  //
  // A durable, per-owner record of assets this wallet has adopted a
  // reissued replacement for — the notification-side counterpart to mail's
  // read/unread tracking above, same shape of problem: something arrived
  // in the background and the UI needs a small, unobtrusive "you should
  // look at this" signal (a badge count) until the owner actually opens
  // the Wallet tab and sees it, at which point it's marked seen the same
  // way opening Mail doesn't mark messages read until clicked — except
  // here "opening the tab" IS the read action, since the wallet screen
  // itself already shows the replacement asset front and center. Reissue
  // itself stays non-fungible-only (a fungible class's properties are
  // fixed per class, not per credential — see issuer-server's own note),
  // but this handling isn't gated on that: `updates` can carry a plain
  // `status: "revoked"` entry for ANY asset, fungible or not, so both
  // branches below apply uniformly rather than assuming non-fungible.
  // Encrypted at rest (2026-09-14, second round).
  async function getAssetUpdateNotices(ownerPublicKey) {
    const { atlasAssetUpdateNotices } = await chrome.storage.local.get('atlasAssetUpdateNotices');
    const identity = await getIdentity();
    return decryptAtRestAndMigrate(identity, 'assetUpdateNotices', (atlasAssetUpdateNotices || {})[ownerPublicKey], [], (v) => saveAssetUpdateNotices(ownerPublicKey, v));
  }

  async function saveAssetUpdateNotices(ownerPublicKey, notices) {
    const { atlasAssetUpdateNotices } = await chrome.storage.local.get('atlasAssetUpdateNotices');
    const all = atlasAssetUpdateNotices || {};
    const identity = await getIdentity();
    all[ownerPublicKey] = await encryptAtRest(identity, 'assetUpdateNotices', notices);
    await chrome.storage.local.set({ atlasAssetUpdateNotices: all });
  }

  async function markAssetUpdateNoticesSeen(ownerPublicKey) {
    const notices = await getAssetUpdateNotices(ownerPublicKey);
    if (notices.every((n) => n.seen)) return; // nothing to write
    notices.forEach((n) => { n.seen = true; });
    await saveAssetUpdateNotices(ownerPublicKey, notices);
  }

  // Handles the `updates` array a domain's /atlas/mail/check response may
  // now carry alongside `messages` (see checkAllMail below) — one entry
  // per requested credential id that isn't simply still active.
  //
  // For `status: "superseded"`, this is the one place a network response
  // gets to change what a wallet holds, so it's held to the same bar as
  // any other credential: verify the new credential's signature against
  // the issuing domain's CURRENT key (verifyCredential — the exact §5
  // check, re-fetched fresh, not trusted from the response), confirm its
  // `owner.publicKey` actually matches this identity (a domain cannot use
  // this channel to hand a visitor's wallet someone else's asset), and
  // confirm `supersedes` actually names the id being replaced (a domain
  // cannot use an unrelated valid credential to silently swap in a
  // different asset). Only once all three hold does the old entry get
  // replaced. A `newCredential` that fails any check is discarded — the
  // old (now-revoked) entry stays exactly as it was, no different from any
  // other verification failure this wallet already handles.
  // Task #144 Phase 1 — the other half of what an `updates` array can mean
  // for this wallet, alongside processAssetUpdates above: not just "here's
  // what your credential turned into", but also, for THIS identity's own
  // locally-recorded submitted trades, "here's the sign one of them just
  // settled while you weren't looking" — a pending trade's staked balance
  // id showing up in `updates` (superseded or plain revoked, either way)
  // means the station matched and settled it. The actual remainder/
  // received credentials are handled by processAssetUpdates and the
  // ordinary mail-gift-claim path respectively (see POST /atlas/trade/
  // submit's own comment) — this function only updates the LOCAL record's
  // display status, never touches wallet contents itself.
  async function reconcileSubmittedTrades(ownerPublicKey, domain, updates) {
    if (!updates || updates.length === 0) return;
    const records = await getSubmittedTrades(ownerPublicKey);
    const updatedIds = new Set(updates.map((u) => u.id));
    let changed = false;
    for (const record of records) {
      if (record.domain !== domain || record.status !== 'pending') continue;
      if (updatedIds.has(record.balanceId)) {
        record.status = 'settled';
        record.settledAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) await saveSubmittedTrades(ownerPublicKey, records);
  }

  function processAssetUpdates(ownerPublicKey, domain, updates) {
    if (!updates || updates.length === 0) return Promise.resolve();
    return withWalletLock(() => processAssetUpdatesLocked(ownerPublicKey, domain, updates));
  }

  async function processAssetUpdatesLocked(ownerPublicKey, domain, updates) {
    const wallet = await getWallet(ownerPublicKey);
    const notices = await getAssetUpdateNotices(ownerPublicKey);
    let walletChanged = false;
    let noticesChanged = false;

    for (const update of updates) {
      const idx = wallet.findIndex((e) => e.credential.id === update.id);
      if (idx === -1) continue; // not something this wallet currently holds — nothing to do

      if (update.status === 'superseded' && update.newCredential) {
        const newCredential = update.newCredential;
        if (
          newCredential.credential !== 'domain-atlas-asset/1.0' ||
          !newCredential.issuer || newCredential.issuer.domain !== domain ||
          !newCredential.owner || newCredential.owner.publicKey !== ownerPublicKey ||
          newCredential.supersedes !== update.id
        ) continue; // never adopt anything that doesn't check out structurally, before even touching crypto

        const verdict = await verifyCredential(newCredential);
        if (!verdict.valid) continue; // never adopt anything that doesn't verify

        const oldEntry = wallet[idx];
        wallet.splice(idx, 1, { credential: newCredential, lastVerdict: verdict, ...(oldEntry.hidden ? { hidden: true } : {}) });
        await unloadItem(update.id); // the old id can no longer be in any world's loadout
        walletChanged = true;
        noticesChanged = true;
        notices.push({
          id: 'urn:atlas:asset-update:' + newCredential.id,
          oldId: update.id,
          newId: newCredential.id,
          name: newCredential.asset.name,
          domain,
          supersededAt: new Date().toISOString(),
          seen: false
        });
      } else if (update.status === 'revoked' && update.reason === 'superseded') {
        // fulfillTradeSideSettlement revokes the spent credential but only
        // appends an assetUpdates (supersession) record when there's a
        // remainder — a unique item's sale or a fully-spent fungible
        // balance always has remainder === null (see that function's own
        // comment), so this id can only ever show up here as a bare
        // 'revoked' update, never as the 'superseded'-with-newCredential
        // case above. Nothing will ever replace it, so leaving it in the
        // wallet forever as an unexplained "✗ revoked by issuer" ghost
        // serves no purpose — remove it and leave a notice recording what
        // happened, the same way a reissue's replacement does above.
        const oldEntry = wallet[idx];
        wallet.splice(idx, 1);
        await unloadItem(update.id); // can't still be equipped in any world's loadout
        walletChanged = true;
        noticesChanged = true;
        notices.push({
          id: 'urn:atlas:asset-update:' + update.id,
          oldId: update.id,
          newId: null,
          name: oldEntry.credential.asset.name,
          domain,
          supersededAt: new Date().toISOString(),
          seen: false
        });
      } else if (update.status === 'revoked') {
        // Any OTHER revocation reason (clawback, issuer-request,
        // demo-self-serve, ...) is something involuntary happening to a
        // still-held item — keep it visible and flagged rather than
        // silently removing it, so the owner can see it. Re-verifying
        // refreshes the displayed verdict immediately rather than waiting
        // for a manual "Re-verify wallet".
        wallet[idx].lastVerdict = await verifyCredential(wallet[idx].credential);
        walletChanged = true;
      }
    }

    if (walletChanged) await saveWallet(ownerPublicKey, wallet);
    if (noticesChanged) await saveAssetUpdateNotices(ownerPublicKey, notices);
  }

  // Anonymous "I just entered this world" ping for the domain's own admin
  // panel (POST /atlas/visit — see issuer-server/server.js), so an operator
  // can see how busy each scene is, 2D and 3D alike. Sends only the world
  // id: no identity, alias or anything else that could tell one visitor
  // from another, and no cookies. Best-effort and silent — a domain that
  // doesn't run the endpoint, or is unreachable, costs the visitor nothing.
  async function recordVisit(domain, worldId) {
    if (!domain || !worldId) return;
    try {
      await fetch(baseUrl(domain) + '/atlas/visit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ world: worldId }), keepalive: true, credentials: 'omit'
      });
    } catch (err) {
      // Best-effort by design — see above.
    }
  }

  // The actual periodic check: gathers every domain the current self
  // identity holds a credential from, asks each domain's
  // /atlas/mail/check for anything tied to those specific credential ids,
  // verifies each message's signature before trusting it, and stores
  // whatever's new. A domain being unreachable just gets skipped, same
  // reasoning as reverifyAll not letting one bad domain block the rest.
  // Returns how many new (verified) messages arrived, across all domains.
  //
  // `opts.onlyDomain` restricts the check to one issuing domain instead of
  // every domain this wallet holds something from — this is what lets
  // entering a world (viewer.js's enterWorld) trigger an immediate,
  // scoped check ("did anything I hold FROM THIS DOMAIN change?") through
  // the exact same code path the periodic background loop already uses,
  // rather than standing up a second, competing check mechanism.
  async function checkAllMail(opts = {}) {
    // `opts.identity` lets a caller check mail for an identity other than
    // "self" (getIdentity()) through this exact same path — e.g. tests
    // exercising task #144 Phase 1's remote-settlement delivery, where the
    // absent counterparty in this single-profile demo is the local
    // "counterparty" role, which nothing else in this automatic loop ever
    // polls on behalf of (see restartMailCheckLoop in viewer.js — it only
    // ever calls this with no args, i.e. self). A real deployment doesn't
    // need this at all: each visitor's own extension always IS "self" from
    // its own point of view.
    const identity = opts.identity || await getIdentity();
    if (!identity) return 0;
    // WebAuthn can't run ECDH client-side (see getChatE2eeKeyPair's own
    // comment) — checked once here rather than inside the registration
    // loop below, so a WebAuthn identity's mail check doesn't pay for a
    // no-op registerMailEncryptionKey() call per credential on every poll.
    const canRegisterMailKey = identity.mode === 'local' && !!identity.privateKeyJwk;

    const assets = await getWallet(identity.publicKey);
    const byDomain = new Map(); // domain -> Set(credentialId)
    assets.forEach((entry) => {
      const domain = entry.credential.issuer && entry.credential.issuer.domain;
      if (!domain) return;
      if (opts.onlyDomain && domain !== opts.onlyDomain) return;
      if (!byDomain.has(domain)) byDomain.set(domain, new Set());
      byDomain.get(domain).add(entry.credential.id);
    });

    const existing = await getMail(identity.publicKey);
    // deletedIds (see deleteMailMessage/clearAllMail) keeps a message you
    // removed from resurfacing here — knownIds alone isn't enough, since
    // deleting a message takes it OUT of `existing`.
    const deletedIds = new Set(await getDeletedMailIds(identity.publicKey));
    // Chats (task #111 first slice): a chat-marked message never lands in
    // `existing` (see the branch below), so its id has to be folded into
    // `knownIds` from its OWN store instead — otherwise every poll would
    // see it as "new" again forever and duplicate it into atlasChatMessages
    // on every single check.
    const existingChat = await getChatMessages(identity.publicKey);
    // deletedChatIds (see deleteChatThread) is chat's own equivalent of
    // deletedIds right above — a message the user deleted (individually,
    // or as part of clearing/deleting a whole thread) must stay gone
    // across future checks too, same reasoning as mail's own list.
    const deletedChatIds = new Set(await getDeletedChatIds(identity.publicKey));
    // Friend-request marker messages never land in `existing` either (they go
    // to atlasFriendRequests), so the ids already processed are folded in
    // from that store.
    const friendState = await getFriendRequestState(identity.publicKey);
    const knownIds = new Set([...existing.map((e) => e.message.id), ...deletedIds, ...existingChat.map((e) => e.id), ...deletedChatIds, ...friendState.seen]);
    // New arrivals are collected here and merged into the stored lists at
    // the end, under the lock, against a fresh read; `existing` and
    // `existingChat` above are only used to recognise what is already known.
    const incomingMail = [];
    const incomingChat = [];
    const incomingFriend = [];

    for (const [domain, idSet] of byDomain) {
      try {
        const base = baseUrl(domain);
        // Best-effort: give this domain this identity's encryption key for
        // every credential it might address mail to (see
        // registerMailEncryptionKey's own comment for why domain-to-
        // subscriber mail needs this ahead-of-time registration rather than
        // Chat/Mail Compose's mutual bootstrap). Piggybacks on this same
        // per-domain loop rather than a separate poll — registeredMailEncryptionKeys
        // keeps a repeat check from re-sending it every cycle.
        if (canRegisterMailKey) {
          for (const credentialId of idSet) {
            if (registeredMailEncryptionKeys.has(credentialId)) continue;
            const entry = assets.find((e) => e.credential.id === credentialId);
            if (entry) {
              await registerMailEncryptionKey(domain, entry.credential);
              registeredMailEncryptionKeys.add(credentialId);
            }
          }
        }
        // `credentials` (alongside the bare ids `credentialIds` already
        // carried): this wallet's own current copy of each one, from
        // `assets` above — nothing new to fetch, it's already in hand.
        // Lets the domain catch a class-wide patch an operator set (POST
        // /atlas/admin/class-patch) that's moved past what THIS specific
        // credential says, without the domain ever having to keep its own
        // record of who holds what — see issuer-server/server.js's
        // applyClassPatchIfStale() for the other half of this. Adopting
        // whatever comes back still goes through processAssetUpdates'
        // own full re-verification below, exactly like any other
        // supersession notice.
        const res = await fetch(base + '/atlas/mail/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            credentialIds: Array.from(idSet),
            credentials: assets.filter((e) => idSet.has(e.credential.id)).map((e) => e.credential)
          })
        });
        const { messages, updates } = await res.json();
        for (const message of (messages || [])) {
          if (knownIds.has(message.id)) continue;
          const ok = await verifyMailMessage(domain, message);
          if (!ok) continue; // never surface anything that doesn't check out
          knownIds.add(message.id);
          // Friend requests and their acceptances (see FRIEND_SUBJECT_MARKER).
          // Like chat, these need `from` (they only travel through a Post
          // Office); a marked message without it is dropped, never shown as mail.
          if (isFriendTransportMessage(message.subject)) {
            if (message.from && message.from.publicKey) {
              incomingFriend.push({
                id: message.id,
                publicKey: message.from.publicKey,
                handle: message.from.handle || null,
                homeDomain: message.from.homeDomain || domain,
                via: domain,
                sentAt: message.sentAt,
                body: message.body
              });
            }
            continue;
          }
          // The ONLY branch point checkAllMail gained for Chats: a message
          // whose subject is the reserved CHAT_SUBJECT_MARKER is diverted
          // into atlasChatMessages instead of atlasMail — everything else
          // about this loop (fetch, per-domain try/catch, signature
          // verification, asset-update/trade reconciliation) is completely
          // unchanged, so ordinary Mail Compose mail is unaffected. Chat
          // transport is Post-Office-only (sendChatMessage always goes
          // through /atlas/postoffice/send), so `message.from` is always
          // present here — see /atlas/postoffice/send's own comment,
          // issuer-server/server.js, for why.
          if (isChatTransportMessage(message.subject) && message.from && message.from.publicKey) {
            // Task #158 — message.body is the raw wire body (possibly one
            // of this feature's E2EE envelopes, possibly a pre-#158 plain
            // string) exactly as the relay delivered it. Unwrap it to
            // plain text FIRST (verifying + caching the sender's e2ee key
            // along the way), then let it go through the exact same
            // at-rest encryption every chat message already got.
            const plainBody = await unwrapChatMessageFromWire(identity, message.from.publicKey, message.body);
            incomingChat.push({
              id: message.id,
              direction: 'in',
              counterpartyPublicKey: message.from.publicKey,
              counterpartyHandle: message.from.handle || null,
              domain,
              body: await encryptChatBody(identity, plainBody),
              sentAt: message.sentAt,
              read: false
            });
          } else {
            // This feature: an ordinary message's wire subject/body may be
            // one of two encrypted shapes — a Post Office user-to-user
            // message (message.from present, unwrapMailForWire's mutual-
            // bootstrap mechanism) or a domain-to-subscriber message (no
            // `from` at all, unwrapDomainMailFromWire's ECIES-to-a-
            // registered-key mechanism) — or, for anything sent before
            // either existed, plain text either function passes through
            // unchanged. Resolved ONCE here, before this ever reaches local
            // storage, same "decrypt at the wire boundary, store plain
            // locally" shape Chat already established above.
            const resolved = (message.from && message.from.publicKey)
              ? await unwrapMailFromWire(identity, message.from.publicKey, message.subject, message.body)
              : await unwrapDomainMailFromWire(identity, message.subject, message.body);
            incomingMail.push({ message: { ...message, subject: resolved.subject, body: resolved.body, domain }, read: false, receivedAt: new Date().toISOString() });
          }
        }
        await processAssetUpdates(identity.publicKey, domain, updates);
        await reconcileSubmittedTrades(identity.publicKey, domain, updates);
      } catch (err) {
        // unreachable domain — move on, don't let it block the others
      }
    }

    let newCount = 0;
    await withMessageLock(async () => {
      if (incomingMail.length) {
        const latest = await getMail(identity.publicKey);
        const have = new Set(latest.map((e) => e.message.id));
        const gone = new Set(await getDeletedMailIds(identity.publicKey));
        for (const entry of incomingMail) {
          if (have.has(entry.message.id) || gone.has(entry.message.id)) continue;
          latest.push(entry);
          have.add(entry.message.id);
          newCount++;
        }
        if (newCount) {
          latest.sort((a, b) => new Date(b.message.sentAt) - new Date(a.message.sentAt));
          await saveMail(identity.publicKey, latest);
        }
      }
      if (incomingChat.length) {
        const latest = await getChatMessages(identity.publicKey);
        const have = new Set(latest.map((e) => e.id));
        const gone = new Set(await getDeletedChatIds(identity.publicKey));
        let added = false;
        for (const entry of incomingChat) {
          if (have.has(entry.id) || gone.has(entry.id)) continue;
          latest.push(entry);
          have.add(entry.id);
          added = true;
        }
        if (added) {
          latest.sort((a, b) => new Date(a.sentAt) - new Date(b.sentAt));
          await saveChatMessages(identity.publicKey, latest);
        }
      }
    });
    // Outside the lock above: processFriendMessages takes it itself, and
    // flushFriendNotices does network I/O.
    await processFriendMessages(identity, incomingFriend);
    try { await flushFriendNotices(); } catch (err) { /* retried on the next check */ }
    const settings = await getMailSettings();
    settings.lastCheckedAt = new Date().toISOString();
    await chrome.storage.local.set({ atlasMailSettings: settings });
    return newCount;
  }

  return {
    hasIdentity, isUnlocked, getIdentity, createIdentity, unlockIdentity, lockIdentity, changePassword,
    exportIdentity, importIdentity, presentIdentity, recordVisit,
    // SPEC.md §3.8.1 — exported so confirm-bridge.js (the wallet-bridge
    // signing confirmation prompt, an extension page like any other) can
    // sign a page-supplied payload directly once a visitor approves it.
    // Every other caller of this already went through a purpose-specific
    // wrapper (presentIdentity's challenge, proposeIntent's offer/want,
    // adminLoginForDomain's nonce) that builds its own payload shape first;
    // the bridge is different — the PAGE constructs the whole payload
    // (required to carry its own `purpose` field, checked against the
    // manifest's whitelist before this ever runs), so there's no wrapper
    // left to add here. Exporting the raw primitive is not a new trust
    // boundary: every extension page already has the same unrestricted
    // signing access this adds one more caller to.
    signWithSelf,
    isAdminForDomain, adminLoginForDomain, adminLogoutForDomain,
    getIdentityMode, setIdentityMode, hasLocalIdentity, hasWebAuthnIdentity,
    getWebAuthnIdentity, createWebAuthnIdentity, presentWebAuthnIdentity,
    getCounterparty, createCounterparty,
    getWallet, mintAsset, verifyCredential, verifyKeyAnchoredManifest, reverifyAll, exportWallet, importWallet, deleteAsset,
    // SPEC.md §13.5 single-asset transfer files.
    getFileTransferSupport, assetFileExportProblem, exportAssetToFile, getAssetFiles, saveAssetFiles, getInterruptedExports, recoverInterruptedExport, recoverInterruptedExports, dismissLostExport, EXPORT_RECOVERY_GRACE_MS, inspectAssetFile, claimAssetFile, getInterruptedClaims, recoverInterruptedClaim, recoverInterruptedClaims, dismissClaimRecord, restoreAssetCopy,
    getPendingExports, checkPendingExport, reclaimPendingExport, forgetPendingExport,
    exportFullBackup, importFullBackup,
    // Friend requests by handle, delivered through the Post Office (federated).
    sendFriendRequest, getIncomingFriendRequests, getOutgoingFriendRequests,
    acceptFriendRequest, declineFriendRequest, cancelOutgoingFriendRequest, flushFriendNotices,
    getAutoBackupSettings, setUpAutoBackup, turnOffAutoBackup, reconnectAutoBackupPermission,
    writeAutoBackupNow, restoreFromAutoBackupFile, buildAutoBackupBlob, isAutoBackupWriterWindowOpen,
    getIdentitySyncBackupSettings, enableIdentitySyncBackup, disableIdentitySyncBackup,
    hasSyncedIdentityAvailable, restoreIdentityFromSync,
    getActivityLog, clearActivityLog,
    hideAsset, unhideAsset,
    splitAsset, consolidateAsset, convertAsset, purchaseAsset,
    getLoadout, loadItem, unloadItem, loseItemToCounterparty,
    getAvatarLook, getAvatarLookAssetId, setAvatarLook, avatarLookPropertiesFromAsset,
    getAvatarHat, getAvatarHatAssetId, setAvatarHat, avatarHatPropertiesFromAsset,
    getAvatarShoes, getAvatarShoesAssetId, setAvatarShoes, avatarShoePropertiesFromAsset,
    dropItem, pickUpItem, getWorldDrops, splitForDrop,
    proposeIntent, verifySignedPayload,
    submitTradeIntent, fetchTradeListings, fetchTradableClasses, fetchAssetClassInfo, claimTradeListing, cancelTradeListing,
    getSubmittedTrades, deleteSubmittedTrade, getTradingStationMemberships,
    recordWorldVisit, getRecentWorlds,
    getCharacterScale, setCharacterScale,
    getWalletSoundEnabled, setWalletSoundEnabled,
    getChatPanelSettings, setChatPanelSettings, chatMessageContainsBlockedWord,
    getAssetViewerSettings, setAssetViewerSettings,
    getPreviewerWindowSettings, setPreviewerWindowSettings,
    getInventoryFilterSettings, setInventoryFilterSettings,
    getAutoLockMinutes, setAutoLockMinutes,
    setAlias, clearAlias, getAlias,
    getMailSettings, setMailCheckInterval, getMail, markMailRead, checkAllMail,
    markAllMailRead, deleteMailMessage, clearAllMail, claimMailGift, sendUserMail, getPostOfficeMemberships,
    // SPEC.md §3.8.2 — pending wallet-bridge asset offers. queueBridgeOffer
    // is called by confirm-bridge.js itself on approval (same unrestricted-
    // AtlasWallet-access reasoning as signWithSelf's own export comment
    // above); getBridgeOffers/claimBridgeOffer/dismissBridgeOffer are
    // called by viewer.js to surface and act on what's pending.
    getBridgeOffers, queueBridgeOffer, claimBridgeOffer, dismissBridgeOffer,
    // SPEC.md §3.8.3 — per-identity trusted offer domains. trustBridgeDomain
    // is called by confirm-bridge.js on an explicit visitor opt-in;
    // isTrustedBridgeDomain is called by background.js to decide whether to
    // skip the prompt at all; getTrustedBridgeDomains/untrustBridgeDomain
    // are called by viewer.js's Settings list.
    getTrustedBridgeDomains, trustBridgeDomain, untrustBridgeDomain, isTrustedBridgeDomain,
    getSentMail, deleteSentMailMessage, clearAllSentMail,
    getLastPostOfficeSendDomain, setLastPostOfficeSendDomain,
    getLastPostOfficeSettingsDomain, setLastPostOfficeSettingsDomain,
    setPostOfficeMailMode, blockPostOfficeSender, unblockPostOfficeSender, getPostOfficeSettings,
    setPostOfficeHandle, resolvePostOfficeHandle,
    getAssetUpdateNotices, markAssetUpdateNoticesSeen,
    getFriends, addFriend, removeFriend, updateFriendNotes,
    getContactGroups, addContactGroup, renameContactGroup, removeContactGroup,
    addContactToGroup, removeContactFromGroup,
    getMutedChatUsers, muteChatUser, unmuteChatUser,
    getBlockedChatUsers, blockChatUser, unblockChatUser,
    getFavoriteDomains, isFavoriteDomain, addFavoriteDomain, removeFavoriteDomain, moveFavoriteDomain,
    getCalendarEvents, addCalendarEvent, updateCalendarEvent, removeCalendarEvent,
    fetchDomainCalendar, fetchDomainManifest,
    getChatThreads, getChatThreadMessages, markChatThreadRead, getChatUnreadCount, sendChatMessage,
    deleteChatThread,
    getChatE2eeKeyPair, getE2eePeerPublicKey,
    // postOfficeSendRaw: the unwrapped send primitive sendUserMail/sendChatMessage
    // both sit on top of. Exposed so a test can construct a raw/forged wire
    // message directly (a legacy pre-encryption body, a tampered key
    // announcement) — sendUserMail itself now always runs mail e2ee wrapping,
    // so it's no longer usable as a "send exactly this" escape hatch.
    postOfficeSendRaw,
    getLastChatSendDomain, setLastChatSendDomain,
    getMessagingWindowSettings, setMessagingWindowSettings,
    onWalletChanged
  };
})();
