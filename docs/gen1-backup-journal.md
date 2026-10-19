# Gen1 wallet: the pending-operations journal in encrypted backups

Scope: `buildBackupPayload`, `applyBackupPayload`, `exportFullBackup` / `importFullBackup` (manual, `atlas-full-backup/1.0`)
and `buildAutoBackupBlob` / `restoreFromAutoBackupFile` / the background writer (automatic, `atlas-auto-backup/1.0`) in
`extension/wallet.js`, together with the journal `atlasPendingOps` that `docs/gen1-wallet-crash-recovery.md` and
`docs/gen1-replay-expiry.md` describe. Test: `test/manual-gen1-backup-journal.js`. No issuer code, wire format, signed
credential or revocation file changed. The tests use throw-away Chromium profiles and Node/PHP issuers with their own
keys and state. Nothing live was read or written.

## The failure

A replacement (mint, split, consolidate, convert) is committed by the issuer in one step and the signed successors
exist only in the issuer's stored answer, which can be fetched again only with the original `requestId`. The wallet keeps
that `requestId`, the request body and the predecessors in its journal. The journal was not part of the backup, so a
wallet restored on another device (or after a lost profile) had the predecessors, which the issuer had already revoked,
and no way to ask for the answer. Reproduced with the previous `wallet.js` (scenario N1): the restored profile has no
pending entry, `recover()` has nothing to do, and the request id is nowhere in its storage, while the issuer still
returns the 40 g credential for that request id.

## What changed

- **Backups carry the journal.** `data.pendingOps = { format: 'atlas-pending-ops/1.0', owner, entries }` sits next to
  `data.wallet` inside the same encrypted payload. `entries` are the journal entries exactly as stored (request id, kind,
  owner, issuer domain, path, predecessors, request body with the presented credentials, `createdAt`, `attempts`,
  `lastError`, `state`, `attention`). Manual and automatic backups both go through `buildBackupPayload`, so both have it.
  The background automatic writer rebuilds the file on every local storage change, which includes every journal write.
- **One consistent capture.** The wallet list and the journal come from a single `chrome.storage.local.get` of both
  keys (`snapshotWalletAndJournal`), read strictly (see below). Every write that changes both (applying an answer,
  removing the entry) is already a single `chrome.storage.local.set`, so a snapshot is wholly "before" (predecessors and
  entry) or wholly "after" (successor, no entry). The wallet part is the stored list, not the display list: the
  display-only `pendingOutcome` marks of `getWallet` are no longer written into backups.
- **Restore is a merge for the journal, written together with the wallet.** `applyBackupPayload` computes the merged
  journal inside the wallet lock and stores wallet, journal and quarantine in one `chrome.storage.local.set`
  (`saveWallet(..., { extraWrites })`). A failed or interrupted restore therefore leaves either the old pair or the new
  pair, never a restored wallet without its journal.
- **Nothing is retried because a backup was restored.** The restore sends no request. A restored `pending` entry is
  recovered by the ordinary paths (the next operation of that owner, Re-verify, an explicit retry) or by the automatic
  recovery that follows the next unlock, or the end of a restore in the wallet page (`docs/gen1-auto-recovery.md`); a restored
  `needs-attention` entry stays `needs-attention` and is only sent again by `retryPendingOperation`.

## Restore rules

Absence and damage are different things and are reported differently (`result.pendingOps.status`):

| Backup contains | Result |
|---|---|
| no `pendingOps` field (every backup made before this change) | `status: 'absent'`. Nothing is read, written or quarantined; an existing local journal is left byte-for-byte as it is (also when it is unreadable, reported as `localJournalUnreadable`). The activity log says nothing about pending operations |
| a field that is not `{format: 'atlas-pending-ops/1.0', owner, entries: [...]}` (string, `null`, array, number, other format version, `entries` not a list) | `status: 'quarantined'`; the whole field is stored in the quarantine as `malformed-field`; the journal is not touched; the wallet is still restored |
| a well-formed field for another owner (`field.owner` is not the restored identity) | the whole field is quarantined as `wrong-owner` |
| a well-formed field for this owner | `status: 'merged'`, entry by entry, below |

Per entry, keyed by `requestId` for the restored identity:

| Entry in the backup | Result |
|---|---|
| not an object, or missing the fields a recovery needs | quarantined `unusable` |
| `owner` or `toOwner` is another key, `body.ownerPublicKey` is another key, or a presented credential belongs to another key | quarantined `wrong-owner`. An entry is never reassigned to another key |
| `kind` / `path` is not one of mint `/atlas/asset/issue`, split `/atlas/asset/split`, consolidate `/atlas/asset/consolidate`, convert `/atlas/convert` | quarantined `unknown-operation` |
| bad domain, unknown `state`, bad `attempts`/`predecessors`/`attention`, `body.requestId` different from `requestId` | quarantined `malformed` |
| `requestId` not in the local journal | added as it is (`added`). If another local entry names one of the same predecessors it is still added and counted in `overlaps`: both stay as evidence, and at most one can ever complete |
| `requestId` already local, same request (kind, owner, toOwner, label, domain, path, predecessors, body, `createdAt` equal) | the local entry stays. Only evidence is added: `needs-attention` (with `attention`, `lastError`, `lastAttemptAt`) is adopted from the backup, never downgraded back to `pending`; the higher `attempts` wins. Otherwise `unchanged` |
| `requestId` already local, different content, or the local copy is unusable | **conflict**: the backup's entry is quarantined as `conflict`; the local entry is untouched |

Local entries are never removed or replaced. A newer unresolved operation on the device that is not in an older backup
stays in the journal.

A stored journal that cannot be read when a restore needs it is not replaced silently: its stored value is first copied
into the quarantine (`unreadable-local-journal`, `source: 'local'`) in the same write. If the backup has no journal the
damaged one is left where it is.

**Quarantine.** `atlasPendingOpsQuarantine[owner]` holds `{ at, reason, source: 'backup' | 'local', value }` records,
encrypted at rest under the identity's key like the journal. The same item is not stored twice, so repeating a restore
does not grow it. It is evidence only: nothing reads it back into the journal and nothing sends it. It is read with
`getPendingOpsQuarantine(owner)`; there is no screen and no dismiss action. If the quarantine itself cannot be read the
restore fails before anything is written.

## Fail-closed behaviour

- A locked wallet cannot make a manual or an automatic backup (`getIdentity` is empty).
- A backup is never made from a wallet or journal that exists but cannot be decrypted or parsed:
  `snapshotWalletAndJournal` throws `wallet-unreadable` (`wallet-locked` when locked), so neither kind of backup is
  produced without the journal. Plain (legacy, unencrypted) arrays are still accepted by the strict reader.
- A restore that cannot read the quarantine, or whose combined write is rejected, writes none of wallet, journal or
  quarantine. A wallet that locks during a restore stops it before the write.
- Error text and the activity log carry counts only: no request id, credential id, key or issuer detail. The restore
  note is `(pending operations: N added, M merged, Q set aside)`. The tests check the extension console, the activity log
  and the whole of `chrome.storage.local` for the request id and credential ids.

## Does the backup authenticate the whole payload?

Yes. Both formats are AES-256-GCM over one JSON document (`identity`, `data` with every family including `wallet` and
`pendingOps`, `settings`). The key is PBKDF2 (600 000 iterations) over SHA-256 digests of the password and, for the
manual format, the normalised seed phrase (the automatic format: password only). The GCM tag covers the complete
ciphertext, so a changed, truncated, spliced or reordered byte anywhere in the payload, including the journal, fails
decryption and the restore stops before anything is written (tested: ciphertext start/middle/tag, truncation, `iv`,
`salt`, `kdfIterations`, wrong password, wrong seed phrase; also that a refused restore leaves no identity, wallet or
journal behind). An attacker without the secrets cannot produce a journal entry either, and the per-entry owner checks
above also stop a holder of the secrets from planting an entry for a different key.

Outside the ciphertext, and not authenticated, are the header fields `format`, `exportedAt` (manual) /
`publicKey`, `writtenAt` (automatic) and the KDF parameters (a changed salt, IV or iteration count only makes
decryption fail). No restore decision uses `exportedAt`. Not covered by any format: **freshness**. An older, perfectly
valid backup always authenticates, and restoring it replaces the wallet list with that older list (existing behaviour,
below); the journal merge is what keeps that recoverable.

## Re-encryption and normalisation

The journal is stored per owner, AES-GCM, with a key derived from the identity's private key and the store name
(`deriveAtRestKey(privateKeyJwk, 'pendingOps')`). The backup carries the decrypted entries inside its own encryption;
no stored ciphertext is copied. A restore re-encrypts the merged list with a fresh IV under the restored identity's key
on the target profile (the same identity gives the same key, a different one a different key), the same way
`saveWallet` re-encrypts the wallet. The tests confirm the restored journal is stored as an encrypted record and that the
plaintext request id is not in storage. Entries are validated, not rewritten: apart from adopting `needs-attention`
evidence and the higher attempt count for a request that already exists locally, an entry is stored exactly as it was
backed up.

## Exact identity restore versus another identity's assets

`applyBackupPayload` restores an identity: it writes the identity from the backup, makes it the active one and loads
its data. The journal always goes to that identity's slot and only entries owned by it are accepted. A backup is not a
way to bring another identity's pending operations into the current one: entries naming another owner, a credential of
another owner, or a field for another owner are quarantined, never reassigned (scenario B9). Importing another identity's
**assets** is the separate wallet-file import (`importWallet`, `manual-wallet-import.js`, which skips credentials owned by a
different identity) and the asset-file claim flow, which this change does not touch and which have no journal.

A full-backup restore on a device that has a different identity replaces the device's active identity blob (existing
behaviour). The other identity's wallet, journal and quarantine records stay in storage, encrypted under their own key
and unchanged byte for byte (tested), but cannot be opened on that profile until that identity is imported again.

## Remaining limitations

- **Neither the wallet nor the issuer holds the signed successor.** After the issuer's stored answer has expired
  (`ATLAS_REPLAY_TTL_HOURS`, default 168) a restored entry ends as `needs-attention`: predecessors held back, nothing
  recreated, the issuer's refusal recorded (scenario B2). The signed successor exists nowhere the wallet can read.
  Recovering it needs issuer-side outcome evidence (longer retention or an owner-signed endpoint); not part of this change.
- **A backup older than the request has nothing to preserve.** The journal entry is written before the request is
  sent, so any backup made after that has the request id. A backup made before it, followed by a lost device, loses the
  request; the automatic writer adds a 4 s debounce between the journal write and the file.
- **A mint cannot be told apart after expiry**, and a request that is only slow can still commit after the wallet
  concluded otherwise (see `docs/gen1-replay-expiry.md`). Restoring does not change either.
- **Restore replaces the wallet list.** The wallet in a backup replaces the local one (existing behaviour; no wallet
  merge). Restoring an older backup over a newer wallet rolls the wallet back. With the journal the rollback is
  recoverable while the issuer still has the answer: the entry returns with the predecessors and completes once (B11). A
  newer unresolved local entry is kept, but the assets that belong to it are not in the older wallet list.
- **Revoked predecessors are not proof of who revoked them**; an all-revoked refusal stays `needs-attention`.
- **The quarantine and `needs-attention` entries have no screen and no dismiss action.** They are kept indefinitely.
- **A previous-version backup cannot be upgraded.** It has no entry (only, as the previous `wallet.js` also wrote the
  display marks into the wallet part, the request id and state of a held predecessor, without the request body).
  The restore strips those marks and takes the file as "no journal carried".
- Backups of WebAuthn identities are not possible (the private key never leaves the authenticator); unchanged.
- The automatic backup's file-picker and permission flow is not driven by these tests; the payload and the restore are.
- Multiple wallet instances sharing one profile are not addressed.
- Unique mint, purchase and trade claim entries are carried like any other entry (kind `mint`, `purchase`, `claim`);
  see `docs/gen1-unique-recovery.md`. Admin mints and the asset-file flows are not journalled.

## Tests

`xvfb-run -a node test/manual-gen1-backup-journal.js [node|php|both] [--only=B1]` (`--only` matches by prefix).
Restores go into fresh Chromium profiles against the same running issuer that committed the transaction.

| Scenario | Covers |
|---|---|
| B1 | journal in a manual backup (shape, nothing in plaintext), restore into a fresh profile, no request sent, predecessors held, recovery by the original request id from the retained answer, exactly one credential, same credential as the original profile gets, restart, console/log/storage hygiene |
| B2 | answer expired: restored as needs-attention, never completed, predecessors held and unspendable, re-verify does not release them; a backup made from that state keeps the state and the evidence and is not retried |
| B3 | backup without the field: `absent`, nothing quarantined, existing local journal untouched |
| B4 | eight kinds of malformed field: quarantined whole, no empty journal invented, wallet still restored, no duplicate quarantine |
| B5 | 16 kinds of bad entries (other owner, other `toOwner`/`ownerPublicKey`/credential owner, request id mismatch, unknown kind/path, bad domain/state/attempts/predecessors/attention, non-objects, missing body) next to a good one |
| B6 | repeated restores (also after a restart), newer local attempts kept, needs-attention adopted and never downgraded, four kinds of conflict quarantined once, newer local entry kept, late answer applied by retry |
| B6b | two request ids claiming the same predecessors: both kept, one completes, one stays needs-attention, one successor |
| B7 | combined write rejected, browser killed before the write, killed after it, killed during an export |
| B8 | 30 backups taken concurrently with 5 answers being applied: each wholly before or wholly after |
| B9 | another identity on the device untouched; entries or a field for another owner quarantined, never reassigned |
| B10 | locked wallet, unreadable journal (backup refused; restore quarantines the damaged copy; old backup leaves it as it is; sends keep being refused), unreadable quarantine, wallet locking during a restore |
| B11 | two simultaneous restores, two recoveries plus two retries, a restore during an in-flight recovery, an older backup restored after the answer was applied |
| B12 | seven kinds of tampering, wrong password and seed, refused restores write nothing, header `exportedAt` unused |
| B13 | automatic backup: journal present, wrong password and tampering refused, restore and recovery, old automatic backup `absent` |
| N1 | negative control: the previous `wallet.js` (last revision without the field, found in git history) produces a backup without the journal and the restored profile cannot recover while the issuer still holds the answer; the current wallet restores that old backup as `absent` and handles the same situation correctly |

Deliberately breaking the owner check or the conflict check in `wallet.js` makes B5 and B6 fail.

## Results

Isolated issuers and disposable Chromium profiles, Node and PHP where the suite supports both.

| Suite | Result |
|---|---|
| `manual-gen1-backup-journal.js both` | 356 passed, 0 failed (178 per backend) |
| `manual-gen1-wallet-crash-recovery.js both` | 314 passed, 0 failed, 12 gap probes (6 per backend); the backup probes became checks |
| `manual-gen1-replay-expiry.js both` | 152 passed, 0 failed |
| `manual-wallet-storage-safety.js node` / `php` | 79 passed, 0 failed each |
| `manual-gen1-wallet-fixes.js` | 52 passed, 0 failed |
| `manual-gen1-wallet-races.js` | 0 of 6 trials short (two clean runs; a third run stopped once with `AtlasWallet is not defined` in the test harness after the browser restarted the extension worker, not reproduced) |
| `manual-full-backup.js`, `manual-auto-backup.js`, `manual-identity-sync-backup.js` | all checks passed |
| currency conversion, asset-file wallet, mail gift, wallet import, legacy-wallet migration, sold-unique-item cleanup, asset management, wallet-to-server delete, null-manifest race, wallet resilient to a drops failure, world drops, trade unique item, cross-domain trade (Node), failed-second-leg refund (Node), remote trade | all passed |

`manual-remote-trade.js` failed once on a stale fixed profile directory (the same failure with the previous
`wallet.js`) and passed with a fresh directory on both versions. Not run: the PHP variants of the trade suites and the
issuer-side suites (issuer code is unchanged).

Negative control (N1): with the previous `wallet.js` the restored profile has no pending entry and cannot recover while
the issuer still returns the 40 g credential for the original request. Deliberately disabling the owner check or the
conflict check in `wallet.js` fails B5 and B6.
