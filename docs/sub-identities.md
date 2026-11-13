# Sub-identities

Status: steps 1 to 4 of section 9 (storage layer, backups, screens, export and import) and the single-asset
part of step 5 (moving one item between identities) are built; the rest is planned and not yet implemented.

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
identity, and never the active one: the account password change, setting up automatic backup, the automatic
backup writer and the full backup export.

A save is built for one owner but reads the active identity when it runs. If the wallet switched identity in
between, the data would be encrypted under the other identity's key and become unreadable. Every per-owner
save therefore goes through `encryptAtRestFor()`, which refuses when the identity doing the write is not the
owner. The operation fails and the stored data is left as it was.

## 5. Backup and export are different things

- **Backup** copies everything, sub-identities and their data included, into an encrypted file protected by
  the account's secrets. Nothing leaves the wallet. Restoring reproduces the wallet. The payload gains an
  additive `subIdentities` array (id, name, keys, creation time and the identity's data); the file format
  name is unchanged, so older builds still open new files and ignore the field, and new builds open older
  files. The full backup and the automatic backup both carry it, and both work whichever identity is active.
  Restore merges: a sub-identity made after the backup is kept, one already present keeps its id and name and
  takes the backup's data (as the main identity does), and a name that clashes gets a number. Entries are
  checked before they are used: a malformed key, a public key that is not the private key's, a key that does
  not sign, the account's own key, or anything past the limit is skipped and counted in the restore result.
  The identity sync backup (browser sync storage) carries the main identity key only and does not include
  sub-identities.
- **Export** takes one identity, with its data by default or key only as an option, into a file and then
  removes it from the wallet. It is two steps (section 13): the file and a fresh export code are made first,
  and the identity is removed only after the person confirms they have both. The export screen warns that a
  backup made before an export still contains the identity.
- **Import** takes an exported file and adds it as a sub-identity. The file password and the export code are
  both needed. Duplicates (by public key) are refused, as are malformed or non-P-256 keys. Import adds the
  key to the vault and therefore to future backups, and the screen says so.

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

An asset credential names its owner's public key and carries the issuer's signature, so an asset cannot change
identity by being filed under another one in the wallet: the copy would still name the old key, fail the
ownership check and be refused when spent. Only the issuer can change the owner, so a move goes through the
issuer's direct transfer (SPEC.md §5.6).

**Built (single asset).** `moveAssetToIdentity(credentialId, targetPublicKey)` moves one unique, unbound item
from the identity the wallet is acting as to another identity of the same account. Item menu -> "Move to
another identity...", with a dialog that says the issuer does the move and that its records will link the two
identities.

- The acting identity signs the intent `{action: 'transfer', credentialId, recipientPublicKey, requestId}` and
  the wallet posts it to the issuing domain. The issuer revokes the credential (reason `transferred`) and signs
  a new one for the target key. The wallet verifies the new credential and writes it into the target
  identity's wallet, encrypted under the target's own keys (`localIdentityFor()` finds the key for any
  identity of the account), and removes the old one, in one storage write together with the journal entry.
- It runs as a journalled operation (`kind: 'transfer'`), the same path splits and purchases use. The request
  is written to the pending-operations journal before it is sent. If the answer never arrives the entry stays,
  the original is shown as held back (not verified), and recovery sends the same request id again. The issuer
  answers a repeat with the stored result, so the item is never made twice and never lost.
- Issuers: the Node and PHP issuers accept a `requestId` on `/atlas/asset/transfer` and list `transfer` in
  `/atlas/capabilities`. Without a `requestId` the endpoint behaves as before. A wallet only repeats a transfer
  to an issuer that lists it; otherwise a lost answer is held for attention, never re-sent.
- If the receiving identity is removed or exported while a move to it is unfinished, that is refused (an
  unfinished move into an identity counts as unfinished work for it). If it disappears some other way, the
  issuer's result stays in the journal until it is applied.
- Refused before anything is sent: items bound to an identity (memberships and other `tradeScope: bound`
  items), fungible balances, anything not in the acting identity's wallet, a target that is not in this
  wallet. The issuer still applies its own rules (class policy, Gold holds, partner approvals), so a
  sub-identity is never a way around them.
- The transfer is recorded by the issuer like any other, so it links the two keys on that ledger. The sandbox
  limits the damage a hostile site can do; it does not make the identities unlinkable.

**Not built.** Moving fungible balances (they move by the split-then-hand-off route of SPEC.md §5.4), "move
everything", and the delete flow that offers to move items out first. Bound items can only leave an identity
by exporting it with its data (section 13) or by redeeming them (SPEC.md §5.7).

## 9. Phasing

1. Storage layer, password accounts only: vault, active identity, create, rename, switch, remove (empty
   identities only), account-level operations pinned to the main identity, tests. No screens. Built.
2. Backup: sub-identities in the full and automatic backups, restored by merge. Built. The identity sync
   backup and per-site bindings (which do not exist yet) are not part of it.
3. Switcher and management screens, naming, the active-identity badge. Built: Wallet -> Identity -> Identities
   (switch, rename, add, remove with a second confirming press) and an "acting as" badge under the wallet tabs
   with a "Back to main" button. Names are always rendered as text.
4. Export and import of one identity. Built: Wallet -> Identity -> Identities has an Export panel per
   identity and an "Import an identity" section. The delete flow that offers to move items first belongs
   with transfers (step 5).
5. Transfers between identities. Built for a single unique asset (section 8); balances and move-everything
   are not.
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

## 12. Reading and writing another identity's data

The per-identity getters and setters act for the active identity. Backing up or restoring any other identity
(a sub-identity, or the main identity while a sub-identity is active) uses a separate reader and writer that
take the identity explicitly: `BACKUP_FAMILIES`, `readBackupFamilies()`, `writeBackupFamilies()`. The table
mirrors the data fields of the active-identity backup, and the sub-identity test builds the main identity's
backup both ways and requires every field to be equal, so a family added to one path and not the other fails
the test. A store that exists but cannot be read stops the backup with an error instead of being left out.

Families not in any backup today, for the main identity or a sub-identity: avatar choices, pending wallet-bridge
offers and trusted bridge domains.

## 13. Exporting and importing one identity

Export moves an identity out of the wallet, so it must not be possible to lose it half way.

- **Step one, `prepareSubIdentityExport(id, {password, filePassword?, includeData?})`.** Checks the wallet
  password against the stored identity blob (an unlocked wallet left open is not enough), refuses the
  identity the wallet is acting as, refuses while the identity has unfinished operations, and refuses a
  key-only export while it holds items (they would be left behind). It generates a fresh export code (16
  words, never stored), builds the file, and reads the serialized file back through the import path before
  returning. Nothing is removed. The result carries the file, the code, a file name and a `check` value.
- **Step two, `completeSubIdentityExport(check)`.** Re-checks the same refusals, compares a hash of the
  identity's data with the one the file was made from (so anything that changed in between blocks the
  removal and asks for a new export), then removes the identity from the vault. When the file carried data,
  every per-identity value stored under that public key is removed as well, so the identity exists in one
  place only. A key-only export leaves the data as unreadable ciphertext, the same as deleting; it is
  readable again if the same key is imported again.
- **File.** `atlas-sub-identity-export/1.0`: salt, iv, ciphertext, kdfIterations, exportedAt. The payload
  (version, name, creation time, public key, private key, optionally the data in the backup `data` shape) is
  AES-GCM encrypted under a key derived from the file password and the export code together. The file
  password is the wallet password by default, or a different one chosen for this file (8 or more
  characters). Changing the wallet password later does not change a file made earlier.
- **Import, `importSubIdentity(file, filePassword, code, {label?})`.** Opens this format and the main
  identity's `atlas-identity-export/1.0` (key only, password plus seed phrase), so one screen handles both.
  A wrong password, a wrong code and a damaged file give the same message. The key is validated (P-256,
  public key matches the private key, it signs) and refused if it is this wallet's own key or already in the
  vault, or if the vault is full. A name already in use gets a number. The key is written before the data;
  if the data cannot be restored the key is taken out again and nothing is added.
- **Main identity onboarding** refuses a sub-identity file with a message pointing at the Identities screen.
- **Wording.** The second secret is an "export code" on these screens, not a seed phrase: it is not a key
  seed and nothing is derived from it.
- **Not covered.** The export code and file password are two secrets the person has to keep; if either is
  lost the file cannot be opened. Passkey accounts have no sub-identities yet (section 10).
