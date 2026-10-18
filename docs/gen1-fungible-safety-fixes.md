# Gen1 fungible safety fixes

Follow-up to `docs/incident-gen1-gold-platinum.md`. This change set repairs the confirmed Gen1 failure modes
for portable fungible credentials (Gold, Platinum and the other mined elements) without resetting or
reconciling any live balance and without introducing a ledger. Nothing here touches live data, domain keys or
Core / Mobile; nothing deploys itself.

Read section 3 (what is not fixed) before relying on the holding cap, and section 5 before deploying.

## 1. What changed

### 1.1 Wallet: no lost updates (`extension/wallet.js`)

- **Fresh state, no long lock.** A mint, split, consolidate or convert no longer reads the wallet, waits for the
  issuer and writes back what it read. The network call runs with no lock held. When the answer arrives it is
  applied to the CURRENT wallet list inside the wallet lock (`commitOperation`, one storage write), so another
  operation that finished in the meantime is never undone.
- **Pending journal.** Before a request is sent it is written to an encrypted per-owner journal
  (`atlasPendingOps`: request id, endpoint, body, predecessors). The answer and the journal removal are committed
  together; a second page applying the same answer applies it once (the journal entry must still exist). If no
  answer arrives (network error, 60 s timeout, 5xx, "busy") the entry stays and the same request, with the same
  request id, is sent again: before the next operation for that owner, on "Re-verify wallet", and on demand
  (`recoverPendingOperations`, `getPendingOperations`). A definite refusal (other 4xx) removes the entry.
- **Every other read-then-write site** (delete, hide, import, drop, pick up, trade claim and refund, mail gift,
  bridge offer, file-transfer claim, restore) now goes through `mutateWallet` or `commitOperation`.
- **Spent balances stay visible but are never presented again.** An entry the issuer reports spent (or that a
  check found revoked) is kept as the record of what the balance was, flagged, and left out of merges, mints'
  `existingBalances` and the cap view.

### 1.2 Wallet: consolidation in bounded batches, failures reported

`autoConsolidateAssetWallet` merges each class/issuer group 20 balances at a time (the issuer's limit),
largest first, feeding each result into the next batch. If the issuer refuses a balance as already revoked
(`code: "revoked"` with its `credentialId`), that balance is flagged spent and the batch is retried without it,
so one revoked balance no longer blocks the rest. Anything else is returned as
`{ merged, failed: [{ class, domain, stacks, error, code, pending }], spent }`, kept for
`getConsolidationStatus`, written once to the activity log, and shown on the mining status line
(`mintAsset` returns it as `consolidation`). The balances stay separate and valid and the next change retries.
Only one consolidation per owner runs at a time across all extension pages.

### 1.3 Issuer (Node and PHP): revocation file integrity

- A revocation file that is missing is an empty list (fresh issuer). One that exists but is unreadable, is not
  valid JSON, or has no `revoked` array is an error: spends, splits, consolidations and conversions answer
  **503** and nothing is written. PHP no longer reads such a file as empty and truncates it on the next revoke.
- Writes go to a temporary file in the same directory, are flushed, and replace the file with a rename
  (`writeFileAtomic` / `atlas_write_file_atomic`), keeping the file's mode.
- One read-modify-write per request for all predecessors (`revokeMany` / `atlas_revoke_many`), serialised by a
  lock (Node: in-process; PHP: `lib/atlas-revocations.lock`).

### 1.4 Issuer: authoritative holdings and a correct cap

- `held + requested > cap` is now what is refused (it was `held >= cap`). A single mint above the cap, or 499 held
  plus 400, is refused; 490 held plus 10 lands on exactly 500.
- `held` comes from the issuer's own index of what it signed for the owner key, for classes with a `holdingCap`
  (`holdings/<hash of owner>.json`, entries `{id, q}`), minus what the revocation list says is spent. It no longer
  depends on which balances the wallet presents; presenting nothing does not lift the cap, and presenting only a
  spent stack does not either.
- The check and the mint run under a per-owner lease, so four parallel mints from one snapshot cannot all pass.
- Credentials signed before this change are not in the index. The wallet attaches its unspent balances to every
  fungible mint; the issuer verifies their signature and ownership and adopts them into the index (also when the
  mint is then refused). Forged or foreign balances are ignored.
- Refusals carry `code: "cap"`, `held` and `cap`.

### 1.5 Issuer: safe retry of a replacement

Split, consolidate, convert and fungible issue accept an optional `requestId` (16 to 80 characters of
`A-Z a-z 0-9 - _`; the wallet sends 24 random characters). The finished result is stored privately and keyed by
a hash of the id for 168 hours (`ATLAS_REPLAY_TTL_HOURS`). Repeating the same request returns the SAME signed
credentials and spends nothing again, including after an issuer restart and when several identical requests
arrive at once. The same id with different parameters is refused with 409 `request-id-conflict`. A replay
re-verifies that the presented balances are genuinely this issuer's. If minting the successors fails part-way,
the successors' holdings records are removed and any predecessors are left spendable. Requests without a
`requestId` behave exactly as before. Spend locks are now taken in sorted order, so two consolidations of the
same balances in opposite order no longer wait on each other (15 s stall before, about 10 ms now).

### 1.6 Compatibility and what is preserved

- Signed credentials, their format, `supersedes` chains, the revocation file format, domain keys and wallet
  identities are unchanged. The preservation test signs, spends and restarts the issuer against a 6,127-entry list and
  checks every existing record is kept, unchanged and in order, with only new spends appended.
- Non-fungible assets (memberships, trophies, tickets) mint and move exactly as before.
- Old wallet with new issuer: works; no `requestId`, so no replay, and the cap is now enforced from the issuer's
  index. New wallet with old issuer: works; the unknown `requestId` is ignored, so an interrupted request cannot be
  completed by retry (the wallet then reports it as failed). Deploy the issuer first.

## 2. Findings from the incident report and how each is addressed

| Report item | Status |
|---|---|
| 2.1 cap checks `held >= cap`, counts only presented balances | Fixed for what the issuer signed; see 3.1 and 3.2 |
| 2.2 consolidation: 20 limit hit silently, one revoked balance poisons a group | Fixed (batches, spent handling, reporting) |
| 2.3 lost response leaves successors nowhere | Fixed by `requestId` replay plus the wallet journal, within the TTL |
| 2.4 wallet read-modify-write race | Fixed |
| 2.5 multi-wallet divergence | Follows from 2.4; three-wallet test passes |
| 2.6 hand-deleted revocation records resurrect credentials | Not fixed (3.3) |
| 2.7 revocation list growth and cost | Reduced per request (single read-modify-write); growth itself not fixed (3.6) |
| PHP reads an unparseable file as empty | Fixed on the spend path |
| section 5 item 4 (append-only revocation log) | Not implemented |

## 3. What is not fixed

1. **The cap is per owner key, not per person.** `POST /atlas/asset/issue` is unauthenticated, so anyone can
   create new keys and mine 500 g into each. The cap stops one key from exceeding 500 through wallet races,
   stale or missing presented balances and parallel requests. It is not a defence against a person who makes more
   keys. Do not describe it as one.
2. **Pre-deploy credentials are counted once presented.** A key whose Gold was signed before the change, and whose
   wallet never mines again, is invisible to the index until a mint request presents it (the current wallet does
   this automatically on every fungible mint). Until then that key can mine up to the cap on top. The index is a
   record of what the issuer signed, not a ledger: the signed credentials and the revocation list remain the
   source of truth.
3. **Deleting revocation records still resurrects credentials.** A 503 on a corrupt file protects against
   corruption, not against someone removing entries from a valid file or deleting the file (a missing file is a
   fresh, empty list). The report's section 5 item 4 (an append-only private log that the public file is rebuilt
   from) would address it and is not in this change. Take backups and compare entry counts (section 5).
4. **Conversion into a capped class is not capped.** Converting 450 Gold gives 9,000 Iron; the cap gates mining
   only. Converted-in holdings do count toward the cap afterwards (a further Iron mint is refused). Repeated
   mine-then-convert cycles remain the Gold-to-Platinum economy question that is postponed.
5. **Spends are bearer.** Possession of the credential JSON is the only authorisation; there is no owner
   signature on split, consolidate or convert. The replay store keeps bearer credentials (private, hashed file
   names, 168 hours).
6. **Revocation growth and cost.** Every merge and spend still adds entries (about 98 per 500 g mined in 10 g
   clicks). 20,000 entries is the readers' limit. At 20,000 entries consolidate-20 takes about 0.4 s. The real fix
   is an indexed store or the ledger-authoritative design in the report's section 6.
7. **Recovery window.** A retry recovers a lost answer only while the stored result exists (168 hours) and the
   issuer is the new version. If the issuer process is killed between recording the revocations and storing the
   result (a window of a few milliseconds), the successors are not recoverable by retry. Journal entries are
   retried on the next operation or re-verify, not on a timer.
8. **Labs ledger readers.** `lib/ledger-receipts.php` and `lib/ledger-issuance.php` still read the revocation
   file and treat an unreadable one as empty. They were left alone (ledger scope); they only decide whether a
   ledger account reference is revoked.
9. **Existing damage is untouched.** Balances that are already displayed wrongly, stacks flagged invalid, and the
   hand-deleted records are neither repaired nor reconciled. Use `tools/gen1-fungible-audit.js` (section 4 of the
   report). The generation-based experimental economy reset is separate.

## 4. Tests

| Command | Covers |
|---|---|
| `node test/manual-gen1-fungible-fixes.js both` (add `--quick` to skip the 20,000-entry run) | Node and PHP: revocation integrity (24 parallel splits, six malformed-file variants, missing file), replay (mint, split, consolidate, convert, conflict, malformed id, concurrent identical requests, restart), batches and revoked predecessor, cap (`held + requested`, presenting nothing, parallel mints, adoption, forgery), preservation of existing records and keys, large lists |
| `xvfb-run -a node test/manual-gen1-wallet-fixes.js` | real extension: three wallets with overlapping mints and conversions, 45 balances in batches, a spent predecessor, an unreachable issuer, lost answers for mint / consolidate / convert / split (answer swallowed by a proxy) and recovery without duplication, encrypted journal, definite refusal not retried |
| `xvfb-run -a node test/manual-gen1-wallet-races.js` | the earlier race reproduction, now showing no loss |
| `node test/manual-gen1-fungible-incident.js both` | the earlier issuer reproductions (still records, does not assert). Its wallet model is the pre-fix wallet, so its wallet-side lines (S2b, S3, S10a) are unchanged by design |
| `node test/manual-currency-conversion.js` | updated: the cap holds without presented balances |

Results of the final run are in the delivery notes. The existing suites that exercise mint, split, consolidate,
convert, trade, purchase, drops, file transfer, mail gifts, wallet import and the ledger wallets were run
unchanged apart from the one updated test.

## 5. Deployment (before going live)

Nothing deploys automatically. In this order:

1. **Back up** `.well-known/atlas-revocations.json`, `.well-known/atlas-key.json` and the private key file, the
   state directory (Node) or `lib/` (PHP), and note the revocation entry count. Do not edit the live revocation
   file by hand afterwards.
2. **Permissions (PHP).** The web user must be able to create files in `.well-known/` (the temporary file for the
   atomic write) and in `lib/` (new `lib/replay/`, `lib/holdings/`, `lib/atlas-rid-lock-*.lock`,
   `lib/atlas-holdings-lock-*.lock`, `lib/atlas-revocations.lock`). If `.well-known/` is not writable the write falls back to
   writing the file in place and logs a line to the PHP error log; fix the permission rather than rely on it.
   `lib/` is already denied by `lib/.htaccess`; keep it that way, the replay store holds bearer credentials.
3. **Node.** New directories `replay/` and `holdings/` under the state directory are created on first use.
   Optional `ATLAS_REPLAY_TTL_HOURS` (default 168).
4. **Deploy the issuer first** (`issuer-server/server.js`, or `issuer-php/` including the new
   `lib/replacement.php`). Existing credentials keep working. Then check:
   - `GET /.well-known/atlas-revocations.json` still has the same entry count;
   - one split and one consolidate on a test key succeed and add only the expected entries;
   - a mint above the cap is refused with `code: "cap"`.
5. **Then ship the extension** (`wallet.js`, `viewer.js`). Wallets keep their identities, assets and service
   credentials; the first fungible mint after the update adopts the wallet's existing balances into the
   issuer's index.
6. **Watch** the revocation entry count (it should only grow by spends), the PHP error log for the in-place
   fallback message, and 503 responses (a 503 on spend means the revocation file is unreadable: restore it from the
   backup, do not recreate it).
7. **Rollback.** Redeploy the previous issuer files; the new directories and lock files are inert and can stay.
   The revocation file format is unchanged. Wallets with pending journal entries simply stop retrying against an
   old issuer.

Do not, as part of this deployment: reset or reconcile live Gold or Platinum, delete or rebuild revocation
records, rotate domain keys, or move assets to another chain.
