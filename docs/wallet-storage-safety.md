# Wallet storage: never overwrite what cannot be read

Scope: the wallet credential list (`atlasWallets`), the pending-operations journal (`atlasPendingOps`) and the
exported-files ledger (`atlasAssetFiles`) in `extension/wallet.js`. Test:
`test/manual-wallet-storage-safety.js` (shared browser harness in `test/lib/wallet-profile.js`).

## Root cause

Reads of encrypted stores go through `decryptAtRest(identity, store, value, fallback)`. When the wallet is
locked, the stored value fails to decrypt, or the stored value has an unexpected shape, it returns `fallback`
(`[]`). That is right for displaying a locked wallet. But `mutateWallet`, `saveWallet`, `commitOperation`,
`journalAdd` and `journalPatch` also started from that read, changed the list and wrote it back, so an unreadable
wallet looked like an empty one and the next write replaced the real contents (with a plaintext list, because
`encryptAtRest` passes values through when no key is available).

Reproduced on the unmodified code before any change (all with a throw-away profile and issuer):

- a lock firing while a non-fungible mint was in flight replaced the encrypted wallet with a plaintext list holding
  only the new item (40 g Iron gone);
- `deleteAsset`, `hideAsset`, `unhideAsset` and `reverifyAll`, which take only an owner key, called while locked,
  wrote an empty plaintext list over the encrypted wallet;
- a lock firing during `reverifyAll` or `importWallet` did the same;
- a tampered ciphertext, a garbage string, a non-list object or a half-formed envelope in the wallet slot was
  overwritten by the next write (a garbage string crashed reads with `entries.filter is not a function`);
- a corrupted journal was overwritten by the next fungible mint, after the request had already been sent;
- a lock in the middle of a burst of parallel mints left 3 of 7 stored wearables.

## What changed

All in `extension/wallet.js`.

- `readStoredListForWrite(store, stored)` is the one read that a write may rely on. It separates an empty store
  (nothing ever written: `[]`) from a store that exists but cannot be read, and throws instead of returning `[]`:
  `code: 'wallet-locked'` when a local identity exists and is not unlocked, `code: 'wallet-unreadable'` when the
  value is not a list or an encrypted envelope, fails to decrypt, is not a JSON list after decrypting, or needs a
  key the active identity does not have. Nothing is written when it throws.
- `getWalletStrict(owner)` and `assertWalletWritable(owner)` are the strict counterparts of `getWallet`.
- `saveWallet`, `mutateWallet`, `commitOperation`, `journalAdd`, `journalPatch` and `saveAssetFiles` use it, so
  every change to those three stores re-reads the current stored value and refuses if it cannot be read.
  `reverifyAll` reads strictly inside its lock.
- `getWallet` (the display read) still returns `[]` for a locked or unreadable wallet but no longer crashes on a
  non-list value and never writes in that case.
- Operations that send something to an issuer and must store the answer check beforehand that the wallet and the
  journal are writable (`runIssuerOperation`, `mintAsset`, `purchaseAsset`, `claimTradeListing`, `dropItem`), so a
  locked or corrupted wallet fails before anything is minted or spent.
- A fungible operation whose answer arrives while the wallet is locked or unreadable leaves its journal entry in
  place and reports `pending: true` with `code: 'wallet-locked'`; the issuer has completed it and recovery applies it
  after unlock. Bookkeeping writes to the journal (attempt counts) are best effort and no longer mask the real
  result.
- A non-fungible mint whose answer arrives while the wallet cannot be written throws `wallet-locked` /
  `wallet-unreadable` with the signed credential on `err.issuedCredential`; stored data is untouched.
- Restoring a backup (`applyBackupPayload`) may replace an unreadable wallet, but first copies the unreadable value
  to `atlasWalletQuarantine` (last three kept) so it is not destroyed.

Encryption, identity isolation, the wallet lock and normal unlocked behaviour are unchanged.

## Tests

`xvfb-run -a node test/manual-wallet-storage-safety.js [node|php]` (disposable Chromium profiles, a throw-away
issuer). Result: 79 pass, 0 fail on the Node issuer and 79 pass, 0 fail on the PHP issuer. On the unmodified
code the same file fails in S1, S2, S3, S4, S6, S7 and S10.

| Section | Covers |
|---|---|
| S1 | lock during a non-fungible mint: refused as locked, stored wallet byte-identical, Iron still there |
| S2 | `deleteAsset`, `hideAsset`, `unhideAsset`, `reverifyAll`, `autoConsolidateAssetWallet` on a locked wallet |
| S3 | lock during `reverifyAll` and during `importWallet` |
| S4 | tampered ciphertext, garbage string, non-list object, half-formed envelope: every mutation refused, nothing sent to the issuer, blob byte-identical, restoring the blob restores the wallet |
| S5 | a genuinely absent or empty wallet is still writable |
| S6 | corrupted journal: a mint is refused before it is sent; locked recovery writes nothing |
| S7 | parallel hides and mints lose nothing; a lock in the middle of a burst of mints wipes nothing |
| S8 | normal unlocked mint, consolidate, split, convert, hide, delete stay encrypted and survive a restart |
| S9 | restore over an unreadable wallet keeps a quarantine copy |
| S10 | lock fires after the n-th read of the wallet (n = 1, 2, 3) |

Trading, purchase, drops, file transfer, backups and the ledger wallets are covered by their existing suites
(see the delivery report for counts).

## Residual limitations

- A request that is not journalled (non-fungible mint, purchase, trade claim) whose answer arrives when the wallet
  can no longer be written is not lost silently but cannot be completed: the issuer has acted and the wallet has no
  retry record. The preflight makes this require a lock or corruption that happens while the request is in flight.
  Journalling these is a separate item.
- Other encrypted stores still use the lenient read and write: mail, sent mail, friends, friend requests, contact
  groups, aliases, loadout, activity log, calendar, recent worlds, favourite domains, muted and blocked chat users,
  submitted trades, asset update notices, bridge settings, call state, avatar slots and the ledger account
  references. A write to one of these while locked or unreadable can replace it with an empty list. They hold no
  spendable credentials, but the ledger references should be moved to the same rule next.
- `getAssetFiles` followed by `saveAssetFiles` is read leniently and guarded only at the write; a lock and unlock
  inside that one step could still write a list built from an empty read.
- `getWallet`'s one-time plaintext-to-encrypted migration still writes when it reads a legacy plaintext list while
  unlocked; it never writes when the value cannot be read.
- The wallet map (`atlasWallets`) is read and written whole, so two writers for different owners that bypass the
  wallet lock could still overwrite each other; every wallet write in this file takes the lock.
