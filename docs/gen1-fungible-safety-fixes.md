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
  (`recoverPendingOperations`, `getPendingOperations`). A refusal (other 4xx) removes the entry only when
  nothing can have been committed; otherwise it is kept as `needs-attention` (`docs/gen1-replay-expiry.md`).
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
  (`writeFileAtomic` / `atlas_write_file_atomic`), keeping the file's mode. **There is no fallback.** If the
  temporary file cannot be created, written or renamed (unwritable directory, full disk), the existing file is not
  touched, the temporary file is removed, and the request answers a controlled **503**
  (`could not write atlas-revocations.json (...); the existing file was not changed`). An earlier PHP version
  wrote the live file in place in that case; that path is gone. A temporary file left by a process that stopped
  mid-write is removed once it is older than five minutes (at Node start-up and every minute; in PHP on the next
  replacement or fungible issue).
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
`requestId` behave exactly as before, except that they are journalled too (1.6). Spend locks are now taken in sorted order, so two consolidations of the
same balances in opposite order no longer wait on each other (15 s stall before, about 10 ms now).

### 1.6 Issuer: transaction journal for issue, split, consolidate and convert

Before, an issuer process that stopped after revoking the predecessors but before storing the replay result left
successors that were signed but delivered to nobody. The decided result is now written to a private journal
entry (`state/txn/` in Node, `lib/txn/` in PHP; one file per `requestId`, or per transaction id when there is no
`requestId`) **before** anything is spent:

1. sign the successors (nothing recorded yet);
2. write the journal entry (the signed successors, predecessor ids, the response);
3. record the successors in the holdings index (repeatable, never undercounts);
4. revoke every predecessor in **one** atomic replace of the revocation list, each entry tagged with the
   transaction id (`"txn"`); this replace is the commit point;
5. store the replay result, then remove the journal entry.

Recovery runs at Node start-up and every minute, on any PHP replacement or fungible issue, and when a request
names a `requestId` that has an entry. It decides from the revocation list alone: every predecessor tagged with
the entry's `txn` means the spend committed, so steps 3 and 5 are completed and a retry receives the **same
signed result**; no predecessor tagged means it did not commit, so the entry and the successors' holdings records
are dropped and the predecessors are still spendable. A fungible issue has no predecessors; once its entry exists
the result is decided and recovery completes it. An entry that is damaged, a revocation list that cannot be read
while an entry is pending, or a mix of tagged and untagged predecessors (which one atomic replace cannot produce)
is answered **503** and left exactly as found; nothing is guessed. A live request's entry is never recovered
under it: recovery takes the same per-request lease and skips entries whose lease is held.

Revocation entries written by a journalled replacement carry an extra `"txn"` field. Readers that look only at
`id` (the wallet, the audit tool, the Labs readers) are unaffected.

What this does and does not establish: the crash tests (section 4) stop the issuer at each of seven points of
each of the four operations, on both backends, and show that afterwards either the spend is recorded and a retry
returns the journalled signed result, or it is not recorded, nothing extra is held and the same balances spend
normally. The stops are process stops (exit at the point, locks and memory lost). They do not cover power loss
or a file system that reorders flushed writes and renames. The commit is one file replace, which relies on
`rename` being atomic on the host's file system; it is not a database transaction.

### 1.7 Labs ledger readers fail closed

`atlas_receipt_is_revoked` / `atlas_ledger_is_revoked` (PHP) and `isRevoked` in `lib-ledger-receipts.js` /
`lib-ledger-issuance.js` (Node) no longer read an unreadable or malformed revocation document as an empty list.
They distinguish: **missing** (the only case read as "nothing revoked", the same policy as the spend path: a fresh
issuer), **unreadable** (cannot be read, including a path that is not a file), **malformed** (empty, not JSON,
not an object, no `revoked` array), and **ok**. For the last two the balance-receipt and account-credential
requests answer **503** `revocations-unavailable` before the request nonce is spent, so the same signed request
works once the list is restored.

### 1.8 Compatibility and what is preserved

- Signed credentials, their format, `supersedes` chains, domain keys and wallet identities are unchanged. The
  revocation file format is the same list; new entries from replacements gain an optional `txn` field. The preservation test signs, spends and restarts the issuer against a 6,127-entry list and
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
| 2.3 lost response leaves successors nowhere | Fixed by `requestId` replay plus the wallet journal, within the TTL; the crash window between revoking and storing the result is closed by the issuer's transaction journal (1.6) |
| 2.4 wallet read-modify-write race | Fixed |
| 2.5 multi-wallet divergence | Follows from 2.4; three-wallet test passes |
| 2.6 hand-deleted revocation records resurrect credentials | Not fixed (3.3) |
| 2.7 revocation list growth and cost | Reduced per request (single read-modify-write); growth itself not fixed (3.6) |
| PHP reads an unparseable file as empty | Fixed on the spend path and in the Labs readers (1.7) |
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
   The transaction tag adds about 22% to each entry written by a replacement (measured: 20,000 tagged entries
   are 3.55 MiB in Node's layout and 4.16 MiB in PHP's, against 2.92 and 3.42 MiB untagged). The wallet reads at
   most 4 MiB of the document, so a PHP list made entirely of tagged entries reaches that byte limit at about
   19,200 entries, before the 20,000-entry limit. The live list (about 6,000 entries, mostly untagged) has ample
   room; this is one more reason the list needs the real fix above before it grows much further.
7. **Recovery.** A retry recovers a lost answer only while the stored result exists (168 hours) and the issuer is
   the new version. A request **without** a `requestId` is journalled and rolled forward or back consistently
   after a stop, but nobody can ask for its answer again: if it committed, the successors are held in the
   issuer's index and the replay record exists under its transaction id, yet the client has no handle to
   retrieve them. Wallets always send a `requestId`; other clients should. Durability is that of the host file
   system for flushed files and `rename`; power loss on a file system that reorders them is not covered and was
   not tested. A PHP issuer has no timer, so an entry whose client never retries is settled by the next
   replacement or fungible issue on that issuer (an idle issuer settles nothing until then, which is safe: the
   entry only records what was decided).
8. **Other readers of the revocation file.** The wallet, the audit tool (`tools/gen1-fungible-audit.js`) and
   `tools/check-duplicate-handles.js` read the published document themselves and only use `id`, `reason` and
   `revokedAt`; they were not changed. This change touched the issuer's spend path and the two Labs ledger
   readers.
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
| `node test/manual-gen1-transaction-recovery.js both` (add `--quick` to skip the second recovery variant) | Node and PHP: issue, split, consolidate and convert each stopped at `txn:minted`, `txn:journal-written`, `txn:holdings-registered`, `txn:revoke-tmp-written`, `txn:revoked`, `txn:replay-stored`, `txn:journal-removed` (injected `ATLAS_TEST_CRASH_AT`, exit 86); after each, recovery by retry and by start-up / next-request sweep: spend recorded or not as expected, same signed result when committed, holdings exact, no leftovers; no-`requestId` rollback; interrupted revocation write and stale temporary files; recovery that refuses to guess (unreadable list, half-recorded transaction, damaged entry); 42 concurrent operations plus racing duplicates and competing spends; and, with the issuer running as an unprivileged user, unwritable `.well-known/` (with the file itself writable, so an in-place write would succeed), unwritable journal directory, malformed lists |
| `node test/manual-ledger-receipts.js`, `node test/manual-ledger-issuance.js` | extended: missing / malformed / empty / wrong-shape / unreadable revocation list, the same request working after restoration, a 3,000-entry list with tagged entries (Node mirror and PHP) |
| `node test/manual-gen1-php-deployment.js` (sections `permissions`, `private`, `identity`, `processes`, `upgrade`, `mixed`) | PHP deployment readiness: the issuer running as an unprivileged user with restrictive permissions (unwritable `.well-known/`, `lib/`, each private folder, lock files; mode kept on replacement); private folders created 0700 / 0600 with their own deny-all `.htaccess`, relocation outside the web root, a bad path failing closed; the key and published identity never silently replaced; stale temporary files; `lib/atlas-cli.php` and `tools/gen1-php-smoke.js`; many PHP processes at once and a killed server; upgrade of a domain with existing state from the two earlier versions (keys, 6,000+ revocation entries, Gold, Platinum, memberships, Post Office, ledger configuration) and staged uploads |

Results of the final run are in the delivery notes. The existing suites that exercise mint, split, consolidate,
convert, trade, purchase, drops, file transfer, mail gifts, wallet import and the ledger wallets were run
unchanged apart from the updated tests above.

## 5. Deployment (before going live)

Nothing deploys automatically. The step-by-step procedure for the PHP domains (what to back up and upload, the
directories and permissions, how to verify that private folders are not served, how to confirm revocation counts,
smoke tests, rollback and journal recovery) is in `docs/gen1-php-deployment-checklist.md`. In short:

1. **Back up** `.well-known/` (key document, revocation list, suspensions), the whole `lib/` (PHP) or state
   directory (Node), and the issuer key, and record the revocation entry count and hash
   (`php lib/atlas-cli.php counts`, `node tools/gen1-php-smoke.js <url> --save-baseline`).
2. **PHP permissions.** `.well-known/` must be writable by the PHP account: the revocation list is replaced by a
   temporary file in that directory plus a rename. **If it is not writable, spends answer 503 and change nothing;
   there is no in-place fallback.** `lib/` must be writable for the new state and lock files. The replay, holdings and
   journal folders are created 0700 with 0600 files and a deny-all `.htaccess` of their own; they can be moved
   outside the web root with `lib/atlas-private-dir.txt`. They hold bearer credentials: verify over HTTP that none
   is served (`tools/gen1-php-smoke.js`).
3. **Node.** New directories `replay/`, `holdings/` and `txn/` under the state directory are created on first use.
   Optional `ATLAS_REPLAY_TTL_HOURS` (default 168).
4. **Deploy the issuer first** (`issuer-server/server.js`, or `issuer-php/`: all of `lib/`, then `atlas/`; never
   overwrite the key, `atlas-*-store.json`, `.well-known/*.json` or lock files). Run
   `php lib/atlas-cli.php preflight`, then `node tools/gen1-php-smoke.js <url> --baseline <file>`. Existing
   credentials keep working and no revocation entry changes.
5. **Then ship the extension** (`wallet.js`, `viewer.js`). Wallets keep their identities, assets and service
   credentials; the first fungible mint after the update adopts the wallet's existing balances into the
   issuer's index.
6. **Watch** the revocation entry count (it should only grow by spends), the `txn/` directory (empty between
   requests; `php lib/atlas-cli.php txn-list` shows what stays), and 503 responses (a 503 on spend means the
   revocation list is unreadable or `.well-known/` is not writable: restore from backup, do not recreate).
7. **Rollback.** Redeploy the previous issuer files; the new directories and lock files are inert and can stay.
   First make sure `txn/` is empty (or recover it with `txn-recover`), because the previous version does not read
   it. The revocation file format is unchanged, and an old copy of the list must never replace a newer one.

Do not, as part of this deployment: reset or reconcile live Gold or Platinum, delete or rebuild revocation
records, rotate domain keys, or move assets to another chain.
