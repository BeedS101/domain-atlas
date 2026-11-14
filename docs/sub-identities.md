# Sub-identities

Status: steps 1 to 6 of section 9 are built (storage layer, backups, screens, export and import, moves of items,
balances and everything an identity holds, per-site identity). Passkey accounts are designed in
`unlock-methods.md` and paused.

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
  The backup carries every data family the wallet keeps per identity, including equipped avatar choices,
  pending wallet-bridge offers and the sites trusted to skip the offer prompt (section 12).
  The identity sync backup (browser sync storage) also mirrors the sub-identities vault when it is on, as the
  same ciphertext the vault has in local storage, split into parts that each fit a sync item. Restoring the
  identity from sync brings the sub-identity keys, names and site bindings back, not their data, the same
  scope as the main identity.
- **Export** takes one identity, with its data by default or key only as an option, into a file and then
  removes it from the wallet. It is two steps (section 13): the file and a fresh export code are made first,
  and the identity is removed only after the person confirms they have both. The export screen warns that a
  backup made before an export still contains the identity.
- **Import** takes an exported file and adds it as a sub-identity. The file password and the export code are
  both needed. Duplicates (by public key) are refused, as are malformed or non-P-256 keys. Import adds the
  key to the vault and therefore to future backups, and the screen says so.

## 6. Delete

A sub-identity that still holds any asset or resource is not deleted. Pressing Remove on one that holds items
opens the move-everything panel instead of the confirmation, offering to move everything to another identity
first (section 8); once it is empty the same row asks for the confirming press. Items that cannot move (bound
items, or work still unfinished) are listed and keep the identity from being removed. Deleting removes the key. Local data stored under that public key stays as
encrypted data that nothing can read until the same key is imported again.

## 7. Per-site identity

Each site answers to one identity of the account. The wallet remembers the choice per site and answers that
site's requests (read, sign, offer, buy) with it.

- Key: the exact origin (scheme, host, port), not the registrable domain. Sibling subdomains can belong to
  unrelated parties. Applying a choice to a whole domain is an explicit extra option, not built. A look-alike
  domain therefore never inherits a trusted identity and gets the normal prompt.
- The bindings are `siteBindings` in the encrypted vault, `{ origin: { identity, boundAt } }`, where `identity`
  is `'main'` or a sub-identity's public key (stable across restores and imports, unlike ids). They are included
  in full and automatic backups as `siteIdentities` and merged on restore: a site that already has a binding
  keeps it, and a binding to an identity that is not in the vault is skipped. Writing the vault drops any
  binding whose identity is gone (removed, or exported with its key removed), so the site prompts again.
- The prompt appears only when a site asks for wallet access (`getIdentity`, `requestSignature`, `offerAsset`,
  `requestPurchase`) and has no binding, and only when the account has at least one sub-identity. With none,
  every site simply gets the main identity and nothing is asked or stored. The wallet draws the prompt in the
  confirmation window (`confirm-bridge.html`, kind `identity`); the page cannot. It suggests a new identity
  named after the site, and offers the identity the wallet is showing, or any other. "Remember" is ticked by
  default; unticked, the choice lasts until the wallet locks (session storage). Nothing is answered before a
  choice is made, and declining answers nothing for 30 seconds on that page load rather than asking on every
  call.
- Answering per site never changes the wallet window's own selected identity, so two tabs on two sites can be
  using two identities at once. The confirmation window pins the site's identity for its own page only
  (`useIdentityInThisContext`) and shows "Acting as ..." when the site is bound. The background worker answers
  reads and trusted offers with explicit owner keys; the per-owner stores (wallet, journal, bridge offers,
  trusted domains) are read and written under that owner's own keys.
- Wallet -> Identity -> Site identities lists the remembered sites with the identity each answers as; the
  identity can be changed from the list, and a site can be forgotten (it asks again next time).
- A site learns only the public key of the identity in use. It cannot list, choose or influence identities.
- The in-page world overlay follows the site's identity. The overlay reads its site from the browser (the
  embedding page's origin, not from its address) and pins itself to the bound identity for its lifetime with
  `followSiteIdentity(origin)`, so the world, chat and the wallet inside it act as the identity the site's own
  requests get. The wallet window keeps its selected identity. A page pinned to the main identity stays on it
  while a sub-identity is selected (`useIdentityInThisContext` pins the main identity too). The acting-as badge
  reads "Acting as Shopping for example.com"; on a site with no binding it offers "Use for this site", and
  an identity chosen inside the overlay replaces the pin for that overlay only. A change to the site's binding
  from the site list applies to the overlay at once. Export refuses an identity that is selected or pinned, and
  removing a pinned identity releases the pin.
- Not built: whole-domain bindings, and bindings for passkey accounts.

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
  items), fungible balances (they move as below), anything not in the acting identity's wallet, a target that is
  not in this wallet. The issuer still applies its own rules (class policy, Gold holds, partner approvals), so a
  sub-identity is never a way around them.
- The transfer is recorded by the issuer like any other, so it links the two keys on that ledger. The sandbox
  limits the damage a hostile site can do; it does not make the identities unlinkable.

**Built (balances, all or part).** `moveBalanceToIdentity(credentialId, targetPublicKey, amount)` moves a whole
number of units of a fungible balance from the acting identity to another identity of the account. Balance
card menu -> "Move balance...", with a dialog that has the target, an amount box (starting at the whole
balance, with an "All" button) and the same notes about the issuer and the link between identities.

- It is the issuer's split (SPEC.md §5.4) with the other identity's key as the recipient: the receiving identity
  gets a credential for the amount, the acting identity gets a credential for the rest, and the old balance is
  revoked. Moving the whole balance is a split with no remainder. No issuer change was needed: the split
  endpoint already takes any whole amount and a recipient key, and already answers a repeated request id with
  its stored result.
- The balances drawn on are the acting identity's stacks of that class from that issuer that are not bound and
  not held back by unfinished work. Normally that is one stack. When a request needs more, whole stacks are
  taken first, largest first, and only the last is split. Each step is its own journalled operation
  (`kind: 'split'` with a `toOwner`), so a step that fails leaves what was already moved moved, and the error
  says how much that was.
- The journal rules treat a split to another identity like a transfer: the entry may name a receiving
  identity, recovery keeps the issuer's result until that identity is in the wallet, an unfinished split into an
  identity blocks removing or exporting it, and a journal entry that names another receiving identity is accepted
  when a backup's journal is restored.
- The receiving identity does not merge what it receives (merging is signed by the acting identity). Its new
  balance sits next to any it already had until that identity is the acting one and its wallet is next checked.
- The issuer's own rules still apply (class policy, Gold holds, partner approvals).
- Chain labs coins (their ledger balances) are not asset credentials moved by this route and are not covered.

**Built (everything an identity holds).** `moveEverythingToIdentity(targetPublicKey, onProgress)` moves what the
acting identity holds to another identity of the account, one step at a time: each unique item on its own, and
each balance (one class from one issuer) as a single move of everything that can be moved now.
`getMoveEverythingPlan()` and `getSubIdentityHoldings(id)` describe what it would move.

- Wallet -> Identity -> Identities: the identity the wallet is acting as has "Move everything...", which opens a
  panel with the target, what it holds and what will be left behind. Remove on an identity that holds items opens
  the same panel with "Move everything, then remove": the wallet switches to that identity (a move is signed by
  the identity that holds the item), moves everything, and the row then asks for the confirming Remove press.
- It does not stop at the first problem. Each item that could not move is reported with its reason. A domain
  that did not answer (a saved, retried request) is not asked again for the other items of that domain; those are
  reported as not tried. What already moved stays moved, and a later run picks up the rest.
- Bound items and anything held back by unfinished work are never moved and are listed as left behind. An
  identity that still holds them cannot be removed.

**Not built.** "Move everything", and the delete flow that offers to move items out first. Bound items can only leave an identity
by exporting it with its data (section 13) or by redeeming them (SPEC.md §5.7).

## 9. Phasing

1. Storage layer, password accounts only: vault, active identity, create, rename, switch, remove (empty
   identities only), account-level operations pinned to the main identity, tests. No screens. Built.
2. Backup: sub-identities in the full and automatic backups, restored by merge. Built. The identity sync
   backup mirrors the vault when it is on. Per-site bindings (step 6) are carried in the same backups.
3. Switcher and management screens, naming, the active-identity badge. Built: Wallet -> Identity -> Identities
   (switch, rename, add, remove with a second confirming press) and an "acting as" badge under the wallet tabs
   with a "Back to main" button. Names are always rendered as text.
4. Export and import of one identity. Built: Wallet -> Identity -> Identities has an Export panel per
   identity and an "Import an identity" section. Remove offers to move items out first (section 6).
5. Transfers between identities. Built for a single unique asset, for a fungible balance, all or part, and for
   everything an identity holds in one go (section 8).
6. Per-site binding and the untrusted-site prompt. Built (section 7).
7. Passkey accounts: designed in `unlock-methods.md`, not built.

## 10. Passkey accounts

Passkey support is designed in `unlock-methods.md`: the identity key stays a normal portable key, and the
wallet can be unlocked by a password or by a passkey (through the WebAuthn PRF extension), changing from one
to the other without changing the identity. Everything in this note, including sub-identities, site identities,
backups, export and import and moves, then works for a passkey-unlocked wallet unchanged, because it only
needs the unlocked key.

The device-bound passkey identity that exists today (`atlasWebAuthnIdentity`, mode `webauthn`, key inside the
authenticator) is unchanged. It does not encrypt stored data at rest, does not take part in backups, and
sub-identities stay unavailable while it is the active mode. No migration of such wallets is planned.

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

The families the active-identity payload does not assemble from its own getters (avatar choices, pending
wallet-bridge offers, trusted bridge domains) are read and written through the explicit-identity path for every
identity, the main one included (`BACKUP_EXPLICIT_FIELDS`). Device-level caches and settings that are not
identity data (friend-sync digests, consolidation status, pinned remote keys, presence approvals) are not backed
up.

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
