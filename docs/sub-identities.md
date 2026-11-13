# Sub-identities

Status: design. The storage layer (section 9, step 1) is the first part built; everything else below is
planned and not yet implemented.

A wallet today has one identity per login mechanism: a local password identity (`atlasIdentity`) and,
independently, a passkey identity (`atlasWebAuthnIdentity`), with `atlasIdentityMode` choosing which one
answers to "self". This note describes how one login can hold several identities (keys) that the person
names, switches between, backs up together, moves in and out of the wallet, and lets the wallet pick per
site.

## 1. Terms

- **Account**: the thing you log in to. A password (local mode) or a passkey (WebAuthn mode). Sites never
  see the account itself, only identities.
- **Main identity**: today's identity. For a password account it is the key the password protects.
- **Sub-identity**: an additional P-256 key held in the account's vault, with a local friendly name.
- **Active identity**: the one the wallet is currently acting as. `getIdentity()` returns it; everything
  that is already keyed by public key (items, mail, friends, loadout, trusted bridge domains, ...) follows
  it with no change.

## 2. What already exists and is reused

- Per-identity data. Nearly every store is a map keyed by the identity's public key and encrypted at rest
  with a key derived from that identity's private key (`encryptAtRest`, `deriveAtRestKey`). Two identities
  in one wallet do not collide, and the wallet shows only the active identity's data.
- A mode pointer and an unlocked-identity session key. `atlasUnlockedIdentity` (session storage) holds the
  unlocked main key and is cleared on lock.
- Identity export and import (`exportIdentity`, `importIdentity`), full backup (`exportFullBackup`,
  `importFullBackup`, automatic backup, sync backup). Their secret model is the password plus the seed
  phrase. The seed phrase is a second secret that protects the file; it is not a key seed. Identity keys
  are random P-256 keys and nothing is derived from a phrase.

## 3. Storage model

- The vault: `atlasSubIdentities`, a map from the main public key to an at-rest-encrypted envelope
  `{ version, identities: [{ id, label, publicKey, privateKeyJwk, createdAt }] }`. Keying by the main
  public key follows the convention of every other store and means replacing the main identity (an import)
  can never overwrite a vault it cannot decrypt.
- The vault key is derived from the main private key under its own store name, so a password change (which
  re-wraps the same key) does not touch it.
- The active identity: `atlasActiveSubIdentity` in session storage, holding the active sub-identity's id,
  public key, private key and the main public key it belongs to. Absent means the main identity is active.
  Session scope means every lock, and every new browser session, returns to the main identity.
  `getIdentity()` ignores a cached sub-identity whose main public key is not the unlocked main identity, so
  any code path that replaces the main identity falls back safely.
- Sub-identity ids are random and have no meaning. Names are local, 1 to 40 characters, unique within the
  wallet ignoring case, and are never sent to a site, issuer or Post Office.
- At most 20 sub-identities per account, to bound backup size.

## 4. Switching

Switching writes or removes `atlasActiveSubIdentity`. Because it is a session key, every listener that
already reacts to `atlasUnlockedIdentity` changes (viewer, call window, toolbar icon) also reacts to this
one, and the wallet re-renders for the new identity. A switch also ends every admin session (they are
logged in as one key) and notifies wallet-change observers. Mail sessions are already keyed by domain and
public key.

Operations that act on the account rather than on one identity use `getAccountIdentity()`, the main
identity, and never the active one: the account password change, setting up automatic backup, and the full
backup export. Without that rule a backup written while a sub-identity is active would contain the wrong
identity's data under the main identity's password.

## 5. Backup and export are different things

- **Backup** copies everything, sub-identities and their data included, into an encrypted file protected by
  the account's secrets. Nothing leaves the wallet. Restoring reproduces the wallet. This is planned as the
  second step; until then a backup covers the main identity only and the settings screen must say so once
  sub-identities exist.
- **Export** takes one identity, with its data by default or key only as an option, into a file protected by
  a passphrase chosen at export time, and then removes it from the wallet. The wallet checks the file reads
  back before removing anything, clears that identity's per-site bindings, and says the identity now exists
  only in the file. Restoring a backup made before an export brings the identity back, so both the export
  dialog and the restore screen warn about it.
- **Import** takes an exported file, or a key, and adds it as a sub-identity. A key alone gives signing
  ability but not the local credentials; a full export carries the data. Duplicates (by public key) are
  refused, as are malformed or non-P-256 keys. Import adds the key to the vault and therefore to future
  backups, and the dialog says so.

## 6. Delete

A sub-identity that still holds any asset or resource is not deleted. The wallet offers to move everything
to another identity first. Deleting removes the key. Local data stored under that public key stays as
encrypted data that nothing can read until the same key is imported again.

## 7. Per-site identity

The wallet remembers which identity was chosen for a site and switches to it on the next visit.

- Key: the exact origin (scheme, host, port), not the registrable domain. Sibling subdomains can belong to
  unrelated parties. Applying a choice to a whole domain is an explicit extra option. A look-alike domain
  therefore never inherits a trusted identity and gets the normal prompt.
- The bindings live in the encrypted vault and are included in the backup.
- The prompt appears only when a site asks for wallet access or to present an identity, never on a plain
  visit. For an origin with no binding the wallet offers its identities, a new one, or a shared sandbox.
  The wallet draws the prompt; the page cannot.
- The switch is shown ("Using Sandbox 2 on this site") and applies per tab and origin. The wallet window
  keeps its own default selection and is not changed by a site.
- A binding to an identity that was deleted or exported is dropped and the site prompts again.
- A site learns only the public key of the identity in use. It cannot list, choose or influence identities.

## 8. Transfers between identities

Moving an asset between two identities in the same wallet goes through the same issuer-authorized transfer
path as any other transfer, so non-transferable items, Gold holds and partner approvals still apply and a
sub-identity is never a way around them. Some items therefore cannot be moved, and the transfer dialog says
so. A transfer between two identities is recorded by the issuer like any other transfer, so it links the two
keys on that ledger. The sandbox limits the damage a hostile site can do; it does not make the identities
unlinkable.

## 9. Phasing

1. Storage layer, password accounts only: vault, active identity, create, rename, switch, remove (empty
   identities only), account-level operations pinned to the main identity, tests. No screens.
2. Backup: sub-identities and bindings in the full, automatic and sync backups, with a format version bump
   and tests that old backups still restore.
3. Switcher and management screens, naming, the active-identity badge.
4. Export, import, and the delete flow.
5. Transfers between identities.
6. Per-site binding and the untrusted-site prompt.
7. Passkey accounts (section 10).

## 10. Passkey accounts

A passkey private key never leaves the authenticator, so there is nothing to derive a vault key from, and
passkey mode does not currently encrypt stored data at rest or take part in the automatic backup. Until a
vault key exists, sub-identities are unavailable while the passkey identity is the active mode.

The plan is for a new passkey account to create a portable default identity at setup, so the passkey is only
the lock on the account and the identity people live in can be backed up, exported and moved to a password
account. That trades the hardware-bound guarantee for recovery and portability, so it is offered as the
default with a device-bound-only option, and an existing passkey identity stays as it is. The vault key
comes from the WebAuthn PRF extension where the authenticator supports it, otherwise from a vault
passphrase chosen at setup that also protects the backup.

## 11. Security notes

- Every operation that reads or writes per-identity data uses the identity it was handed, never a cached
  one, so a switch in the middle of a long operation finishes for the identity it started with.
- A switch must leave nothing authenticated as the old identity: admin sessions are ended, and the sub key
  lives only in session storage.
- Sub-identity private keys are not readable by sites and are not logged. Exported files are always
  passphrase-protected.
- All testing uses throw-away identities in a scratch browser profile; nothing here touches an issuer,
  ledger or live site.
