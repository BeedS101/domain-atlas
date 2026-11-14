# Unlock methods

Status: design only. Nothing here is implemented. It replaces the passkey plan that was in section 10 of
`sub-identities.md`.

The goal is that how the wallet opens (a password, or a passkey) is separate from who the person is (the
identity key). A person can change the unlock method without changing their public identity, assets,
memberships, messages or sub-identities, and without the issuer being involved.

## 1. Terms

- **Identity**: a portable P-256 key pair. The public key is the Domain Atlas identity. Unchanged by anything
  in this note.
- **Unlock method**: what decrypts the identity's private key on this device so the wallet can use it. Today
  one method exists, a typed secret (the wallet password). This note adds a second, a passkey.
- **Recovery secrets**: what protects a backup or export file so the identity can be restored on another
  device: a recovery passphrase plus the 16-word seed phrase. They exist independently of the unlock method.
- **Device-bound passkey identity** (`atlasWebAuthnIdentity`, mode `webauthn`): an identity whose key lives in
  the authenticator. It stays exactly as it is and is not part of this work. No existing passkey wallets need
  migrating.

## 2. Why conversion is cheap

Everything in storage that is encrypted at rest is encrypted under keys derived from the identity's private
key (`deriveAtRestKey(privateKeyJwk, storeName)`: wallet, journal, mail, friends, the sub-identities vault and
its site bindings, bridge offers, and so on). None of it is derived from the password. The password protects
exactly one thing: the stored copy of the private key, `atlasIdentity`.

So changing the unlock method only means re-protecting that one record. Every other record is untouched,
byte for byte, and the same public key keeps owning the same credentials. Sub-identities need nothing: their
vault is encrypted under the main private key and their keys sit inside it.

## 3. Architecture

One identity record, one unlock record inside it. No second identity system.

```
atlasIdentity (existing storage key)
  v1  atlas-identity-local/1.0   { publicKey, salt, iv, ciphertext, kdfIterations, createdAt }
      -> method "password": the private key encrypted under PBKDF2(password). Unchanged, never rewritten
         except by the KDF upgrade and password change that exist today.
  v2  atlas-identity-local/2.0   { publicKey, createdAt, unlock: { method: "passkey-prf", ... } }
      -> method "passkey-prf": the private key encrypted under a key derived from the passkey's PRF output.
```

The `unlock` object of a v2 record:

```
{ method: 'passkey-prf', credentialId, rpId, prfSalt, iv, ciphertext }
key        = HKDF-SHA256(prfOutput, info = 'atlas.identity.wrap/1')
plaintext  = { publicKey, privateKeyJwk }
AAD        = format + publicKey + credentialId   (binds the ciphertext to this identity and credential)
prfOutput  = the passkey's PRF result for the fixed random prfSalt (32 bytes), user verification required
```

- The storage key stays `atlasIdentity`, so `hasLocalIdentity()`, `getIdentityMode()` ('local') and every
  reader of the record keep working. The mode stays `local`: a passkey-unlocked identity is a normal local
  identity whose private key is in the session after unlock. `atlasUnlockedIdentity`, `getIdentity()`,
  `getAccountIdentity()`, `signWithSelf()`, at-rest encryption, backups, the sub-identities vault and per-site
  identity all work as they do now, because they only ever see the unlocked key.
- Unlock dispatches on the record: `unlockIdentity(password)` for v1 (unchanged), `unlockWithPasskey()` for v2.
  After unwrapping, the code checks that the key's public half equals `publicKey` before trusting it.
- A v1 record is never rewritten to v2 except by an explicit conversion the person starts (section 5).
- The record holds a single unlock method. A list of methods (so a password and a passkey both open it) would
  be possible later by turning `unlock` into `unlocks[]`, but it is not needed and is left out to keep the
  weakest-method problem out of the design: with two methods the identity is only as strong as the weaker.

### Two protection levels, named plainly

| Level | What decrypts the key | What the interface says |
| --- | --- | --- |
| Password or passphrase (v1) | A secret the person types. Strength is the secret's strength. | "Protected by a password" |
| Passkey (v2) | The passkey's PRF output. Needs the authenticator and its PIN or biometric. | "Protected by a passkey on this device" |

A passkey used only as a presence check on top of a typed secret is not offered. It would add a prompt
without changing what protects the key, and calling it "passkey protection" would mislead. Where the PRF
extension is not available, the passkey option is shown as unavailable on this browser or authenticator, with
the reason, and the password (a passphrase of the person's choosing) remains the way to protect the identity.

## 4. Recovery and backups do not depend on the unlock method

A passkey is tied to one authenticator and to one extension origin, so recovery must never need it.

- Full backups, identity exports and sub-identity exports keep their current format and protection: encrypted
  under a secret the person supplies plus the seed phrase. For a passkey-protected identity the "password" in
  that pair is the **recovery passphrase**, chosen when the unlock method is set up and not stored on the
  device. These files restore on any device with no passkey.
- Restoring on a new device creates a v1 (password) record there, as `importFullBackup` and `importIdentity` do
  today, and the person can then convert that device's wallet to a passkey. A restored wallet is never
  silently set to a passkey.
- Authorising an export (today: re-entering the wallet password, `verifyWalletPassword`) becomes "prove you
  control this wallet": the password for v1, a fresh passkey assertion with user verification for v2. The
  recovery passphrase is then asked for as the file's secret, as the password is today.
- **Automatic backup** derives its file key from the password at unlock (`cacheAutoBackupSessionKey`). A passkey
  unlock has no password to give it. When the person turns automatic backup on for a passkey wallet they enter
  the recovery passphrase once; the wallet derives the file key from it as now and stores that key wrapped
  under the passkey-derived key, unwrapping it into the session at each passkey unlock. Files stay restorable
  with the recovery passphrase and seed phrase alone.
- **Identity sync backup** (`chrome.storage.sync`) mirrors the `atlasIdentity` blob, which for v2 is useless on
  another device. It is not offered for passkey wallets in the first version.

## 5. Changing the method

Both directions are one function, `changeUnlockMethod(target, authorization)`, run only when the person asks
for it. It never runs automatically, never resets an identity, and never writes anything until the new method
has been shown to work.

Password to passkey:

1. Require the current password (re-checked against the stored blob) so a session left unlocked is not enough.
2. Probe PRF: create a new passkey credential asking for the `prf` extension, then evaluate it. If PRF is not
   reported or returns nothing, stop here. Nothing was changed.
3. Ask for the recovery passphrase (twice) and the seed phrase the person holds or a new one. The recovery
   passphrase may equal the old password, but is entered again and is a separate secret from now on.
4. Require a backup. Offer to download a full backup now (recovery passphrase + seed phrase) and, before
   continuing, read it back in memory (decrypt it and compare the public key) so the person has proof the file
   works. The step is required, not skippable.
5. Wrap the private key under the passkey-derived key, then unwrap it again with a second passkey assertion and
   compare to the key in the session.
6. Write the v2 record. The v1 record is kept as `atlasIdentityPreviousUnlock` until the next successful
   passkey unlock, then deleted, so a failure right after the swap can be undone.
7. Rewrap the cached automatic-backup key if automatic backup is on.

Passkey to password: unlocked by the passkey; ask for the new password; derive and wrap exactly as
`createIdentity` does; check by decrypting; write the v1 record; keep the v2 record until the next successful
password unlock. The old passkey credential is forgotten by the wallet (it cannot be deleted from the
authenticator from here, and the interface says so).

A new passkey wallet is created by making a normal identity (`createIdentity` with the recovery passphrase) and
then running the password-to-passkey conversion, so there is one code path to test, and the seed phrase flow
stays exactly as it is.

## 6. What changes in existing code

Only code that takes the wallet password as proof or as a key needs attention. All of it goes through one
helper pair rather than being rewritten call by call:

- `proveWalletOwner(proof)`: `{ password }` for v1 or `{ passkey: true }` for v2. Replaces the direct
  comparisons in `verifyWalletPassword`, `exportIdentity`, `exportFullBackup`, `prepareSubIdentityExport`
  and `changePassword`'s current-password check.
- `unlockWithPasskey()` and `convert...` live next to `unlockIdentity` and `changePassword`.
- `cacheAutoBackupSessionKey`, `setUpAutoBackup`, `buildAutoBackupBlob`, `enableIdentitySyncBackup`: handled as
  in section 4.
- The unlock screen shows the method: a password box, or a "Unlock with passkey" button. Settings -> Identity
  gets an "Unlock method" row showing the current method in the words of section 3, with "Change...".

Nothing else reads `atlasIdentity`'s protected fields, and nothing in the sub-identities, site identity, move
or bridge code changes.

## 7. Export and import between wallets stays separate

Section 13 of `sub-identities.md` (one identity out to a file, into another wallet) is unaffected. It protects
a file with a file password and an export code and never involves the unlock method. A passkey wallet's main
identity can be exported the same way, authorised by a passkey assertion.

## 8. Security notes

- Passkey creation and every unlock request `userVerification: 'required'`, so a stolen authenticator without
  its PIN or biometric opens nothing.
- The PRF salt is random per record. The wrapping key is derived with HKDF and a fixed purpose string, so the
  PRF output is never used as a key directly and is not reused for another purpose.
- The authenticated data binds the ciphertext to the public key and credential id, and the unwrapped key must
  match the stored public key.
- A passkey credential belongs to the extension's origin (`chrome-extension://<id>`). A different extension id
  (an unpacked copy loaded from another path, a store build) cannot use it. That is a reason the backup path
  never depends on the passkey, and it must be stated in the interface when the passkey is set up.
- Losing the authenticator, or the extension id changing, locks the device but not the identity: the backup file
  with the recovery passphrase and seed phrase restores it. The set-up step that rehearses the backup exists
  for this.
- The unlocked key sits in `chrome.storage.session` exactly as for a password wallet; locking and browser
  restart clear it as today.
- An attacker who can write extension storage can replace the record either way, as today. They cannot read the
  key without the secret or the authenticator.
- Nothing is sent to an issuer. The public key does not change, so no issuer-side record changes.

## 9. Test plan (disposable wallets only)

All tests use scratch Chromium profiles and throw-away identities. No live site, issuer or coin is touched.

- **Passkey provider**: tests replace `navigator.credentials.create/get` in the extension page with a
  deterministic emulator (a per-credential secret, PRF as HMAC of the salt, user verification flags honoured),
  so the wallet's real code runs unmodified. No test hook goes into production code. A smoke test also tries
  Chrome's virtual WebAuthn authenticator with PRF; whether that works for an extension origin is unverified
  and is the first thing to find out.
- **Conversion, password to passkey**: public key unchanged; every other storage key byte-identical before and
  after (only `atlasIdentity` and its rollback copy differ); wallet items, sub-identities, site bindings,
  mail and contacts still read and still sign; lock then passkey unlock; the unlocked key equals the original.
- **Conversion, passkey to password and back**: same checks in both directions, repeated twice.
- **Refusals and no-write guarantees**: wrong password, PRF unavailable, cancelled or failed passkey step,
  failed read-back, backup not made: each leaves `atlasIdentity` unchanged.
- **Recovery**: full backup from a passkey wallet restores on a fresh profile with the recovery passphrase and
  seed phrase, no passkey; every sub-identity and its data comes back; restored wallet is a password wallet.
  Wrong passphrase or seed phrase fails. Same for identity and sub-identity export files.
- **Lost authenticator**: delete the emulated credential; the wallet reports it plainly; the backup restores.
- **Compatibility**: every existing sub-identity, backup, export, move and bridge test still passes against a
  v1 wallet, and a v1 record written by the current code is read unchanged.
- **Automatic backup**: turned on for a passkey wallet, a file restores with the recovery passphrase and seed
  phrase.

## 10. Phasing

1. Probe: does PRF work from an extension page, with the virtual authenticator and with real hardware.
   Result decides whether step 3 is offered at all.
2. The v2 record, `unlockWithPasskey`, `proveWalletOwner`, the unlock-screen and settings rows, with the
   emulator tests.
3. `changeUnlockMethod` both ways with the backup rehearsal, and the conversion tests.
4. Automatic backup for passkey wallets.
5. Later, if wanted: several methods at once (`unlocks[]`), a passkey used with a passphrase where PRF is
   missing, identity sync backup for passkey wallets.

## 11. Open decisions

- Whether PRF-less devices get nothing (the passphrase password, as proposed) or an explicitly labelled
  "passkey check plus passphrase" mode.
- Whether the backup rehearsal during conversion is required (proposed) or only strongly encouraged.
- Whether the old record is kept until the next successful unlock (proposed) or for a fixed time.

## 12. Phase 1 results

The probe is `tools/prf-probe` (a separate throw-away extension that stores nothing and reads no wallet) and
`test/manual-prf-probe.js` runs it in the sandbox.

Chromium 141 with Chrome's virtual authenticator (PRF enabled), from an extension page:

- A passkey created with the `prf` extension reports `enabled: true`. Evaluating PRF at unlock returns 32 bytes.
  The same salt gives the same output twice and a different salt gives a different output. With user
  verification required the verified flag is set in the authenticator data.
- The result is the same for a platform-style (internal) authenticator, a roaming (usb) authenticator, and a
  plain localhost web page, so the extension origin makes no difference in this browser.
- An authenticator without PRF is detectable: `prf.enabled` is false and no output is returned, so the wallet
  can decide to offer only the password. `PublicKeyCredential.getClientCapabilities()` reports
  `extension:prf: true` for the browser even then, so it is not a sufficient check; the per-credential probe
  at set-up is.
- A user verification that is required and not given fails with `NotAllowedError` and nothing is derived.

Real hardware: see the next section when it has been run.

