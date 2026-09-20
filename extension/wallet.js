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
  async function deriveAesKey(secrets, saltBytes, iterations) {
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
        kdfIterations: KDF_ITERATIONS_CURRENT,
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
        await chrome.storage.local.set({
          atlasIdentity: {
            ...atlasIdentity,
            salt: b64urlEncode(newSalt.buffer),
            iv: b64urlEncode(newIv.buffer),
            ciphertext: b64urlEncode(newCiphertext),
            kdfIterations: KDF_ITERATIONS_CURRENT
          }
        });
      } catch (err) {
        // Best-effort — the unlock itself already succeeded either way.
      }
    }

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
    await chrome.storage.local.set({
      atlasIdentity: {
        ...atlasIdentity,
        salt: b64urlEncode(newSalt.buffer),
        iv: b64urlEncode(newIv.buffer),
        ciphertext: b64urlEncode(newCiphertext),
        kdfIterations: KDF_ITERATIONS_CURRENT
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
    await chrome.storage.local.set({
      atlasIdentity: {
        format: 'atlas-identity-local/1.0',
        publicKey,
        salt: b64urlEncode(localSalt.buffer),
        iv: b64urlEncode(localIv.buffer),
        ciphertext: b64urlEncode(localCiphertext),
        kdfIterations: KDF_ITERATIONS_CURRENT,
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
      return { valid: true, reason: 'signature verified against issuer key; not revoked' };
    } catch (err) {
      return { valid: false, reason: 'verification error: ' + err.message };
    }
  }

  // Removes an asset from this wallet's LOCAL view only — there's no way
  // to ask the issuer to un-issue a credential, and nothing here pretends
  // to. This is for decluttering (a duplicate, a revoked asset you're done
  // tracking) — the credential itself, wherever else a copy of it exists,
  // is unaffected. Also drops it from the loadout, in case it was loaded.
  async function deleteAsset(ownerPublicKey, credentialId) {
    const wallet = (await getWallet(ownerPublicKey)).filter((e) => e.credential.id !== credentialId);
    await saveWallet(ownerPublicKey, wallet);
    await unloadItem(credentialId);
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

  // Manual entry point — the "Consolidate" button in the UI.
  async function consolidateAsset(role, credentials) {
    if (!credentials || credentials.length < 2) {
      throw new Error('Pick at least two balances of the same class and issuer to consolidate.');
    }
    const owner = await identityOf(role);
    return mergeAssetGroup(owner.publicKey, credentials);
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
    if (!res.ok) throw new Error('Claim failed: ' + (await res.text()));
    const result = await res.json();
    const owner = await getIdentity();

    let wallet = (await getWallet(owner.publicKey)).filter((e) => e.credential.id !== balance.id);
    if (result.remainder) wallet.push({ credential: result.remainder, lastVerdict: await verifyCredential(result.remainder) });
    wallet.push({ credential: result.received, lastVerdict: await verifyCredential(result.received) });
    await saveWallet(owner.publicKey, wallet);
    await autoConsolidateAssetWallet(owner.publicKey);
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
      const wallet = await getWallet(who.publicKey);
      for (const entry of wallet) entry.lastVerdict = await verifyCredential(entry.credential);
      await saveWallet(who.publicKey, wallet);
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

    const owner = identity.publicKey;
    const [
      wallet, mail, sentMail, submittedTrades, assetUpdateNotices,
      friends, contactGroups, aliases, recentWorlds, favoriteDomains, calendarEvents,
      mutedChatUsers, blockedChatUsers, loadout, chatMessages, counterparty,
      chatE2eeKeyPair, chatE2eePeerKeys
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
      getChatE2eeKeyPair(identity), getE2eePeerKeysForOwner(identity)
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
      'atlasMessagingWindowSettings', 'atlasCharacterScale', 'atlasAutoLockMinutes'
    ]);

    const payload = {
      identity: { publicKey: identity.publicKey, privateKeyJwk: identity.privateKeyJwk },
      data: {
        wallet, mail, sentMail, submittedTrades, assetUpdateNotices,
        friends, contactGroups, aliases, recentWorlds, favoriteDomains, calendarEvents,
        mutedChatUsers, blockedChatUsers, loadout, chatMessages, counterparty,
        chatE2eeKeyPair, chatE2eePeerKeys,
        deletedMailIds: (deletedMailIdsAll.atlasDeletedMailIds || {})[owner] || [],
        deletedChatIds: (deletedChatIdsAll.atlasDeletedChatIds || {})[owner] || [],
        lastChatSendDomain: (lastChatSendDomainAll.atlasLastChatSendDomain || {})[owner] || null,
        lastPostOfficeSendDomain: (lastPostOfficeSendDomainAll.atlasLastPostOfficeSendDomain || {})[owner] || null,
        lastPostOfficeSettingsDomain: (lastPostOfficeSettingsDomainAll.atlasLastPostOfficeSettingsDomain || {})[owner] || null
      },
      settings: settingsRaw
    };

    const exportSalt = crypto.getRandomValues(new Uint8Array(16));
    const exportIv = crypto.getRandomValues(new Uint8Array(12));
    const exportKey = await deriveAesKey([password, normalizeSeedPhrase(seedPhrase)], exportSalt);
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: exportIv }, exportKey, new TextEncoder().encode(JSON.stringify(payload))
    );
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
    if (!payload || !payload.identity || !payload.identity.publicKey || !payload.identity.privateKeyJwk) {
      throw new Error('This backup file is missing its identity — it may be corrupted.');
    }

    const { publicKey, privateKeyJwk } = payload.identity;

    // Restore the identity itself first — everything else below is keyed
    // to it. Same local re-encrypt + session-activate as importIdentity().
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
        kdfIterations: KDF_ITERATIONS_CURRENT,
        createdAt: new Date().toISOString()
      }
    });
    await chrome.storage.local.set({ atlasIdentityMode: 'local' });
    await chrome.storage.session.set({ atlasUnlockedIdentity: { publicKey, privateKeyJwk } });
    const identity = { mode: 'local', publicKey, privateKeyJwk };

    const owner = publicKey;
    const d = payload.data || {};
    await Promise.all([
      saveWallet(owner, d.wallet || []),
      saveMail(owner, d.mail || []),
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
      saveChatMessages(owner, d.chatMessages || []),
      saveCounterparty(d.counterparty || null),
      // Task #158 — restoring the SAME e2ee keypair (not generating a
      // fresh one) is what keeps this identity able to decrypt its past
      // end-to-end-encrypted chat threads on the new device; restoring
      // the peer-key cache means it doesn't have to re-bootstrap (an
      // unencrypted first message again) with everyone it already
      // verified a key for.
      ...(d.chatE2eeKeyPair ? [saveChatE2eeKeyPair(owner, d.chatE2eeKeyPair)] : []),
      saveE2eePeerKeysForOwner(owner, d.chatE2eePeerKeys || {})
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
    ['atlasChatPanelSettings', 'atlasMailSettings', 'atlasAssetViewerSettings', 'atlasMessagingWindowSettings', 'atlasCharacterScale', 'atlasAutoLockMinutes']
      .forEach((k) => { if (s[k] !== undefined) settingsToSet[k] = s[k]; });
    if (Object.keys(settingsToSet).length) await chrome.storage.local.set(settingsToSet);

    return { publicKey };
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
    const entries = await getMail(ownerPublicKey);
    const entry = entries.find((e) => e.message.id === messageId);
    if (!entry) return;
    entry.read = true;
    await saveMail(ownerPublicKey, entries);
  }

  async function markAllMailRead(ownerPublicKey) {
    const entries = await getMail(ownerPublicKey);
    entries.forEach((e) => { e.read = true; });
    await saveMail(ownerPublicKey, entries);
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

    entry.claimed = true;
    entry.read = true; // clicking Claim is at least as strong a "seen it" signal as opening the card
    await saveMail(ownerPublicKey, entries);
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
    if (!res.ok) throw new Error('Send failed: ' + (await res.text()));
    return res.json();
  }

  async function sendUserMail(toDomain, toPublicKey, subject, body, toHandle) {
    const result = await postOfficeSendRaw(toDomain, toPublicKey, subject, body);

    // Record this locally for the wallet's own Sent tab — the relaying
    // domain never hands the message back to the sender afterward (it
    // only ever reaches the recipient's checkAllMail()), so without this
    // the sender would have no record of what they'd sent at all. Uses
    // the server's own id/sentAt from `result` rather than minting new
    // ones, since that IS the canonical envelope the recipient will see.
    const identity = await getIdentity();
    if (identity && result && result.id) {
      const entries = await getSentMail(identity.publicKey);
      // Task #97: normalized to a plain public-key string for the "to"
      // record regardless of whether toPublicKey was a bare string or a
      // { publicKey, domain } federated address — recipientDomain (only
      // set when it differs from toDomain, i.e. an actually-federated send)
      // is recorded alongside it purely for the Sent tab's own display,
      // never re-parsed back into anything.
      const target = normalizeSendTarget(toPublicKey);
      entries.unshift({
        id: result.id,
        to: { publicKey: target.publicKey, handle: toHandle || null, recipientDomain: (target.domain && target.domain !== toDomain) ? target.domain : null },
        domain: toDomain,
        subject: result.subject || subject,
        body: result.body || body,
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
    const entries = await getChatMessages(ownerPublicKey);
    let changed = false;
    entries.forEach((e) => {
      if (e.counterpartyPublicKey === counterpartyPublicKey && e.direction === 'in' && !e.read) {
        e.read = true;
        changed = true;
      }
    });
    if (changed) await saveChatMessages(ownerPublicKey, entries);
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
  // per-message key rotation — see the chat history comment on this in
  // conversation with Bruno, 2026-09-14: "simple static key first"). So
  // the very FIRST message in a brand-new conversation, in whichever
  // direction happens to go first, is sent as a signed-but-UNENCRYPTED key
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
  async function deriveChatE2eeSharedKey(ownPrivateKeyJwk, peerPublicKeyJwk) {
    const privateKey = await crypto.subtle.importKey('jwk', ownPrivateKeyJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const publicKey = await crypto.subtle.importKey('jwk', peerPublicKeyJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const sharedBits = await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
    const label = new TextEncoder().encode('atlas.chat.e2ee.v1');
    const combined = new Uint8Array(sharedBits.byteLength + label.length);
    combined.set(new Uint8Array(sharedBits), 0);
    combined.set(label, sharedBits.byteLength);
    const digest = await crypto.subtle.digest('SHA-256', combined);
    return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
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
        body: await encryptChatBody(identity, body),
        sentAt: result.sentAt || new Date().toISOString(),
        read: true // this wallet's own outgoing message — nothing to mark unread
      });
      await saveChatMessages(identity.publicKey, entries);
      await setLastChatSendDomain(identity.publicKey, toDomain);
    }
    return result;
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
    const entries = await getChatMessages(ownerPublicKey);
    const toDelete = entries.filter((e) => e.counterpartyPublicKey === counterpartyPublicKey);
    if (toDelete.length === 0) return;
    const remaining = entries.filter((e) => e.counterpartyPublicKey !== counterpartyPublicKey);
    await saveChatMessages(ownerPublicKey, remaining);
    await addDeletedChatIds(ownerPublicKey, toDelete.map((e) => e.id));
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
    const entries = await getMail(ownerPublicKey);
    const remaining = entries.filter((e) => e.message.id !== messageId);
    await saveMail(ownerPublicKey, remaining);
    await addDeletedMailIds(ownerPublicKey, [messageId]);
  }

  async function clearAllMail(ownerPublicKey) {
    const entries = await getMail(ownerPublicKey);
    await addDeletedMailIds(ownerPublicKey, entries.map((e) => e.message.id));
    await saveMail(ownerPublicKey, []);
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

  async function processAssetUpdates(ownerPublicKey, domain, updates) {
    if (!updates || updates.length === 0) return;
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
      } else if (update.status === 'revoked') {
        // Not a reissue — just a plain revocation this wallet hadn't
        // noticed yet. Re-verifying refreshes the displayed verdict
        // immediately rather than waiting for a manual "Re-verify wallet".
        wallet[idx].lastVerdict = await verifyCredential(wallet[idx].credential);
        walletChanged = true;
      }
    }

    if (walletChanged) await saveWallet(ownerPublicKey, wallet);
    if (noticesChanged) await saveAssetUpdateNotices(ownerPublicKey, notices);
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
    const knownIds = new Set([...existing.map((e) => e.message.id), ...deletedIds, ...existingChat.map((e) => e.id), ...deletedChatIds]);
    let newCount = 0;
    let chatChanged = false;

    for (const [domain, idSet] of byDomain) {
      try {
        const base = baseUrl(domain);
        const res = await fetch(base + '/atlas/mail/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ credentialIds: Array.from(idSet) })
        });
        const { messages, updates } = await res.json();
        for (const message of (messages || [])) {
          if (knownIds.has(message.id)) continue;
          const ok = await verifyMailMessage(domain, message);
          if (!ok) continue; // never surface anything that doesn't check out
          knownIds.add(message.id);
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
            existingChat.push({
              id: message.id,
              direction: 'in',
              counterpartyPublicKey: message.from.publicKey,
              counterpartyHandle: message.from.handle || null,
              domain,
              body: await encryptChatBody(identity, plainBody),
              sentAt: message.sentAt,
              read: false
            });
            chatChanged = true;
          } else {
            existing.push({ message: { ...message, domain }, read: false, receivedAt: new Date().toISOString() });
            newCount++;
          }
        }
        await processAssetUpdates(identity.publicKey, domain, updates);
        await reconcileSubmittedTrades(identity.publicKey, domain, updates);
      } catch (err) {
        // unreachable domain — move on, don't let it block the others
      }
    }

    existing.sort((a, b) => new Date(b.message.sentAt) - new Date(a.message.sentAt));
    await saveMail(identity.publicKey, existing);
    if (chatChanged) {
      existingChat.sort((a, b) => new Date(a.sentAt) - new Date(b.sentAt));
      await saveChatMessages(identity.publicKey, existingChat);
    }
    const settings = await getMailSettings();
    settings.lastCheckedAt = new Date().toISOString();
    await chrome.storage.local.set({ atlasMailSettings: settings });
    return newCount;
  }

  return {
    hasIdentity, isUnlocked, getIdentity, createIdentity, unlockIdentity, lockIdentity, changePassword,
    exportIdentity, importIdentity, presentIdentity,
    getIdentityMode, setIdentityMode, hasLocalIdentity, hasWebAuthnIdentity,
    getWebAuthnIdentity, createWebAuthnIdentity, presentWebAuthnIdentity,
    getCounterparty, createCounterparty,
    getWallet, mintAsset, verifyCredential, reverifyAll, exportWallet, importWallet, deleteAsset,
    exportFullBackup, importFullBackup,
    hideAsset, unhideAsset,
    splitAsset, consolidateAsset, convertAsset,
    getLoadout, loadItem, unloadItem, loseItemToCounterparty,
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
    getAutoLockMinutes, setAutoLockMinutes,
    setAlias, clearAlias, getAlias,
    getMailSettings, setMailCheckInterval, getMail, markMailRead, checkAllMail,
    markAllMailRead, deleteMailMessage, clearAllMail, claimMailGift, sendUserMail, getPostOfficeMemberships,
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
    getLastChatSendDomain, setLastChatSendDomain,
    getMessagingWindowSettings, setMessagingWindowSettings,
    onWalletChanged
  };
})();
