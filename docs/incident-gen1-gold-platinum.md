# Gen1 Gold / Platinum balance incident: investigation report

Update: the minimal Gen1 repairs proposed in section 5 (items 1, 2, 3, 5, 6 and 7) are implemented; see
`docs/gen1-fungible-safety-fixes.md` for what changed, what is still open and how to deploy. The findings below
describe the code as it was when investigated; the scripts in the table record that earlier behaviour for the
issuer and the wallet model they simulate.

Status of the investigation itself: read-only investigation. No issuer data, wallet, key or revocation record was changed, and nothing
was deployed. Every reproduction ran against throw-away copies of the Node and PHP issuers (own key,
own state, private ports) and, for the wallet, a real Chromium with the extension against such an issuer.

How to re-run:

| Script | What it does |
|---|---|
| `node test/manual-gen1-fungible-incident.js [node\|php\|both] [--quick]` | issuer-level reproductions S1-S10 against isolated Node and PHP issuers |
| `xvfb-run -a node test/manual-gen1-wallet-races.js [trials]` | the real wallet, overlapping mint / convert operations |
| `node test/manual-gen1-audit-tool.js` | tests for the audit tool below |
| `node tools/gen1-fungible-audit.js --help` | offline, read-only classification of exported wallets against revocation-list copies |

The first two record what the code does; they do not assert that it is right.

## 1. Summary

What was seen (one wallet showing a ~500 g Gold stack plus 50 separate 10 g stacks, ~1,000 g displayed;
automatic consolidation silent; Gold and Platinum stacks displayed as invalid; a Gold and a Platinum
revocation record deleted by hand, after which the Gold stack looked valid) is reproduced end to end, and
each step has a mechanism in the code.

Most likely sequence, in order of confidence:

1. **Confirmed by reproduction.** The wallet's mint, convert, split and merge functions read the wallet list,
   wait on the issuer, then write back what they read, without the wallet lock. When two of them overlap,
   a credential the issuer has just signed is dropped from the wallet, and in some interleavings a stack the
   issuer has already spent is written back. Neither is ever repaired by the wallet afterwards.
2. **Confirmed.** One spent credential in a group makes the issuer refuse the whole consolidation, every
   time, and the wallet swallows the error. New 10 g mints keep landing in that group as separate stacks.
   A group of more than 20 stacks is refused for the same reason (the issuer limit is 20, the wallet sends
   the whole group), so once a wallet is past 20 stacks it never consolidates again.
3. **Confirmed.** The 500 g cap only counts valid credentials the wallet presents. A spent stack still
   shown in the wallet counts as zero, so mining carries on to a second 500 g: exactly "one ~500 g stack plus
   50 x 10 g, ~1,000 g displayed", of which the issuer honours 500 g.
4. **Confirmed.** Deleting the revocation record of a stack that was spent into something else makes it
   spendable again while its successor is also valid. The 500 g stack in the reproduction was honoured a
   second time and produced a second 1,215 Platinum. **The balances now displayed for the affected wallets
   are not authoritative, and the deletions may have created value.**
5. **Not established.** That any of this happened live in the sequence above. The reproductions show each
   mechanism is real and that together they produce the reported picture; the live files and logs are needed
   to say which actually occurred (section 7).
6. **Not a cause of these symptoms in any reproduction.** The 1.1 MB revocation list. At 6,127 entries an operation that checks 20 to 50
   credentials costs 0.2 to 0.4 s; plain mints do not read the list at all. It is a scaling concern
   (section 5), not what produced these symptoms.

## 2. Findings

Confirmed means reproduced here on Node and PHP (identical unless stated). Hypothesis means code reading
only, or a mechanism that is possible but not shown to have occurred live.

### 2.1 Minting and holding cap

| # | Finding | Status | Evidence |
|---|---|---|---|
| C1 | The cap is cooperative. `currentHeldQuantity()` / `current_held_quantity()` sum only the valid, unrevoked credentials the wallet puts in `existingBalances`; anything else counts as zero. | Confirmed | S1b: 70 mints of 10 g accepted with nothing presented (700 g). S1c: a mint presenting only a spent 500 g stack is accepted. |
| C2 | The test is `held >= cap`, not `held + quantity > cap`. | Confirmed | S1d: 499 held, mint 400, holds 899. A single mint of 100,000 with nothing held is accepted. |
| C3 | Concurrent mints from one snapshot all pass. | Confirmed | S1e: four parallel 10 g mints from a 490 g snapshot, four accepted (530 g). The per-credential spend lock serialises them but each still sees the same presented list. |
| C4 | `/atlas/asset/issue` takes no owner signature: anyone can mint for any key. | Confirmed (by code and S1b) | A fresh key has no history, so the cap is a courtesy for honest wallets. The source comment already says mining is unscarce. |
| C5 | A well-behaved wallet is held exactly at 500 g. | Confirmed | S1a: 50 clicks, 500 g, one stack, no errors, then the refusal. |
| C6 | `/atlas/convert` does not check `holdingCap` on the target class (by design: conversion is the documented relief valve). | Confirmed | S4: 500 Gold becomes 1,215 Platinum; two mine-and-convert cycles hold 3,645 Platinum, after which Platinum mints are refused. |

Answer to "can repeated minting exceed the cap": yes, by a wallet that presents nothing or a spent stack, by
parallel requests, and by one large quantity at the boundary. A wallet that presents everything it holds
and does one request at a time cannot.

Answer to "only simultaneously valid balances above the cap, or only a wrong display": both are possible.
The reported 1,000 g display was a wrong display (the issuer honoured 500 g, S10a); after the record
deletion it became 1,000 g honoured (S10b).

### 2.2 Automatic consolidation

| # | Finding | Status | Evidence |
|---|---|---|---|
| K1 | The issuer refuses more than 20 balances per consolidation (Node and PHP). The wallet sends the whole group. | Confirmed | S2a/S2b: 25 stacks, five attempts, still 25 stacks, error `max 20 at a time`. Another mint makes it 26. With 20-at-a-time chunking the same wallet ends with 2 stacks (S2c). |
| K2 | The wallet discards every consolidation error. | Confirmed (code, and S2b/S3b) | `autoConsolidateAssetWallet()`: the `catch` is empty. Nothing is shown or logged. |
| K3 | A spent credential in the group makes the issuer refuse the whole request (`asset already revoked`), because the loop rejects on the first bad credential. | Confirmed | S3b: 2 spent + 2 valid, three attempts, 4 stacks every time. S3c: the 2 valid stacks alone consolidate fine. S3d: new mints join the poisoned group. |
| K4 | Consolidation response lost after the issuer has revoked the predecessors: the merged credential exists nowhere. | Confirmed | S3a, S5a-c. The issuer keeps no copy of any minted credential, no history for these classes (`/atlas/asset/history` is empty), and a retry gets `asset already revoked`. |
| K5 | Request size and revocation-document handling. | Not a cause | 50 balances is a 52 KB request. See section 5 for the time cost. |
| K6 | Platinum is the same code path as Gold. | Confirmed | The stack-limit, poison and lost-update results hold for any fungible class. |

### 2.3 Conversion and replacement

All spends are "check, mint the successors, revoke the predecessor", with no transaction around the three
steps and no idempotency key.

| # | Finding | Status | Evidence |
|---|---|---|---|
| V1 | Mint-then-revoke ordering means a failure between the two leaves predecessor and successor both valid (value duplicated). Revoke-then-respond failure leaves successor only in a response that may not arrive. | Hypothesis for the first (no fault injected; Node revokes synchronously straight after the last `await`, PHP in one script, so the window is small); Confirmed for the second | S5a: predecessor revoked, successor only in the lost response. |
| V2 | Retrying an interrupted request cannot recover anything. | Confirmed | S5b: `asset already revoked`. |
| V3 | The same credential cannot be spent twice concurrently. | Confirmed (a good result) | S5d/S5e: exactly one of several parallel consolidations or converts wins; value is conserved. |
| V4 | Opposite lock order on Node makes one request wait the full 15 s and fail `busy`. | Confirmed on Node (S5f, 15.0 s) | The PHP striped locks did not show it in this run; not investigated further. |
| V5 | The wallet applies the response to the list it read before the network call. | Confirmed | Section 2.4. |

### 2.4 The wallet's own read-modify-write (the main wallet-side cause)

`mintAsset()`, `mergeAssetGroup()`, `convertAsset()` and `splitAsset()` call `getWallet()`, await the issuer,
then `saveWallet()` the earlier list. `withWalletLock()` exists and is used by re-verify, claim, remove and
import, not by these. Reproduced with the real extension (isolated issuer, three rounds of four parallel 10 g
mints, or one convert in parallel with two mints, in a single wallet):

| Trials | Result |
|---|---|
| 4 of 4 | Issuer-signed Gold missing from the wallet afterwards: 60, 70, 40 and 20 g respectively. The credentials are valid at the issuer and held nowhere. |
| 1 of 4 | A spent (revoked) Gold stack left in the wallet, displayed as one of 8 stacks after five further sequential mints; the issuer honours 70 of the 100 g displayed. |
| 4 of 4 | No recovery: five further sequential mints did not bring the wallet back to what had been minted. |

This reproduces three of the reported symptoms together: a stack that shows as invalid, consolidation
that never works again (K3), and new 10 g credentials accumulating as separate stacks.

Where overlap comes from is not established. Candidates in the code: more than one extension page open at
once (the busy flag in `handleInteractable` is per stall, so a second stall or a second tab is not
blocked), a convert from the Wallet tab while mining, the chess reward, and any other path that calls
`autoConsolidateAssetWallet()` (mail pick-up, drop pick-up, import, trade claim).

### 2.5 Multi-wallet behaviour

Three independent wallet identities run concurrently against one issuer, each doing mine-to-cap,
convert, mine again (S9), behaved identically and correctly on Node and PHP: the issuer holds no per-wallet
state that couples them, and its per-credential locks and PHP's flock on the revocation file kept
revocation writes intact. **Issuer-side concurrency does not explain why two wallets failed and one did
not.** The leading explanation is wallet-side: overlap happened in two wallets and not the third, or one
wallet never passed 20 stacks. That needs the activity logs and a description of how the wallets were
used (section 7).

### 2.6 Deleted revocation records

| # | Finding | Status | Evidence |
|---|---|---|---|
| D1 | Deleting a record re-enables the predecessor while its successor stays valid. | Confirmed | S6: five 10 g stacks consolidated to 50 g, two records deleted, valid Gold 70 g. Converting one gave 24 Platinum; splitting the other to a different key succeeded. S10b/c: the 500 g stack honoured again and converted a second time into another 1,215 Platinum. |
| D2 | Any copy of a spent credential is spendable by whoever holds it once its record is gone. Spends need no owner signature, only the credential. | Confirmed | S6e. This includes wallet exports and automatic backups made before the merge. |
| D3 | What a record says: id, time, and reason (`consolidated`, `superseded`, `redeemed`, ...). It does not say what replaced the credential or by how much. | Confirmed (code) | The successor is found from its signed `supersedes` field, which is in any wallet or backup that holds the successor. |
| D4 | A missing record does not prove the credential was never spent. | By construction | The audit tool therefore reports `SUPERSEDED_NOT_REVOKED` for a credential that a held successor names, and never infers "unspent" from absence. |
| D5 | PHP: a revocation file that does not parse is read as "nothing revoked", and the next revoke overwrites the file with the new entry alone. | Confirmed | S7 (PHP): spend of an already-spent credential accepted (200); one later revoke turned a 1,618-entry file into 2 entries. Node fails closed: every spend returns 500 until the file is fixed (S7, Node). |

D5 matters directly for hand edits of the live file: a stray comma or a half-saved file, followed by a
single spend, loses the whole history without any error. **Check the live entry count first (section 7).**

### 2.7 Scalability

| Entries | File (PHP layout) | Node: consolidate 20 / mint with 49 balances | PHP: same |
|---|---|---|---|
| 0 | 0 | 17 / 25 ms | 21 / 34 ms |
| 6,127 | 1.05 MiB | 216 / 238 ms | 324 / 366 ms |
| 20,000 | 3.42 MiB | 748 / 578 ms | 946 / 941 ms |

(local machine; shared hosting will be several times slower.) Cost grows with entries x credentials
presented, because every check re-reads and re-parses the whole file, and every revoke rewrites it (Node
pretty-prints at 153 bytes per entry, PHP at 179).

Growth: with automatic consolidation, one 10 g mining click adds **2** records (the old stack and the new 10 g),
so mining to the cap adds 98 records per 500 g, and a mine/convert cycle about 100 to 110. 6,127 records
is roughly 60 such cycles. The wallet reads at most 20,000 entries (Labs 39), about 140 more cycles
away; past that every credential from that issuer would show as "not verified". Node and PHP behave the same
for large lists apart from D5 and the layout size.

## 3. Potential impact

- **Financial.** Gen1 Gold and Platinum are portable credentials with no ledger behind them and no link to
  GOPH, MWC or any Chainblock coin. Nothing here touches Core. The exposure is the Gen1 balances themselves,
  and whatever the operator has decided they are worth.
- **Inflation.** Bounded above by the sum of the quantities of the stacks whose records were deleted, plus
  whatever those stacks were converted into (a stack that was converted counts twice, once as itself and once
  as its successor). For the reported wallet this is at most the 500 g stack and the Platinum it became;
  the true figure needs the files in section 7.
- **Loss.** Value dropped by the wallet race (valid at the issuer, held nowhere) and value in the lost
  response of an interrupted request. The signed predecessors remain in any export or backup, so the
  quantity at risk is recoverable as a number even where the credential is not.
- **Bearer exposure.** Old exports and automatic backups taken before a merge or conversion contain
  credentials that become spendable if their records are removed. Treat those files as value.
- **Cap.** It does not protect the economy; it is a hint to the wallet.

## 4. Reconstruction and reconciliation plan

Nothing below is run against live data until you approve it. Steps 1 to 4 are read-only.

1. **Freeze.** No mining, converting, consolidating, importing, re-verifying or editing of the revocation
   file on the live domains for the three wallets. Do not delete anything else.
2. **Copy.** The current `atlas-revocations.json` exactly as served, and every older copy that exists (hosting
   backups, a copy taken before the edit, the file as it was when the list was 1.1 MB). A wallet export from each
   of the three wallets, taken without re-verifying first, plus any older exports and automatic backups.
3. **Audit offline** with `tools/gen1-fungible-audit.js` on those copies (nothing is sent anywhere):
   `--wallet` for each export and older backup, `--revocations` for the current file, `--revocations-backup` for
   each older copy, `--key` for the live key document. It classifies every Gold and Platinum credential:

   | State | Meaning | Counts as holdings |
   |---|---|---|
   | CURRENT | valid signature, not revoked, nothing supplied names it as a predecessor | yes |
   | SPENT | revoked, display copy only | no |
   | SPENT_NO_SUCCESSOR | revoked as consolidated/superseded and no successor in any file supplied | no, but quantity at risk |
   | RESURRECTED | a backup has its record, the current file does not | no |
   | SUPERSEDED_NOT_REVOKED | a held successor names it and there is no record (deleted, or interrupted) | no |
   | UNVERIFIED | signature does not verify | no |

   It also lists the records present in a backup and missing now, and consolidations whose totals do not add up.
4. **Decide per owner** from the report: the authoritative balance is the CURRENT set. For each
   RESURRECTED or SUPERSEDED_NOT_REVOKED credential, the record is restored only where a successor is shown to
   exist; for SPENT_NO_SUCCESSOR the operator decides whether to reissue to the owner. These are operator
   decisions, taken with the report in hand.
5. **Repair (separate approval).** Back up the live directory; stop writes; restore records with a script that
   validates the JSON, takes the same lock as the issuer and writes atomically; never by hand. Re-run the audit
   on the result and diff.
6. **Prevent recurrence** before reopening the domains (section 5).

The audit tool does not contact an issuer, change a wallet, or write to any file but the optional `--json`
report. Its limits are stated in its output: a missing record proves nothing, and a credential that exists only
in a lost response cannot be found.

## 5. Minimal Gen1 patches (proposed; items 1, 2, 3, 5, 6 and 7 since applied)

In order of value. None is a migration; all keep portable assets and Node/PHP parity.

1. **Wallet: serialise balance-changing operations.** Apply the issuer's result inside `withWalletLock()`
   to a freshly read list (the pattern already used by `addClaimedToWallet`), in `mintAsset`, `mergeAssetGroup`,
   `convertAsset` and `splitAsset`; write the issuer response to a small pending record first so a crash between
   response and save cannot lose it.
2. **Wallet: consolidate safely.** Chunks of at most 20; leave out credentials the issuer reports revoked
   (re-verify, then prune the display copy); show or log failures instead of swallowing them.
3. **Issuer (PHP and Node): revocation file safety.** An unparseable file is an error (503), never "empty";
   `atlas_revoke()` / `revoke()` refuse to overwrite a file they cannot parse; write to a temporary file in the
   same directory and rename it.
4. **Issuer: keep revocations that survive a hand edit.** Append every revocation to a private append-only log
   (not under `.well-known`) and publish the served file from it, so a deletion in the public file is visible
   and reversible, and the history for audits is complete.
5. **Issuer: cap on the issuer's own count.** Refuse when `held + quantity > cap`. Counting against issuer-side
   state (outstanding mined quantity per owner key) is the only way to make it more than a courtesy; that is a
   small step toward the ledger below.
6. **Issuer: idempotency for replacement.** Accept a client request id and keep the signed successors for the
   predecessor id for a limited time, so an interrupted request can be repeated and returns the same credentials.
7. **Consolidate behaviour.** Make the issuer skip nothing silently: either accept up to 20 or have the wallet
   chunk (item 2). Keep one limit in one place.

Revocation scale (Labs 40 candidates): index by id (a sorted file or SQLite) so a check does not parse the whole
list; publish a compact checkpoint (count, head hash, last id) next to the full list; retain history privately
and publish only what verifiers need; give the wallet a conditional request (ETag) so it does not download
1 MB per verification.

## 6. Longer term: ledger-authoritative fungible assets

Labs 37/38 already show the shape: the wallet holds a signed account reference, the balance lives on a ledger
that applies each change once. For Gold and Platinum that gives an owner-wide cap that cannot be sidestepped,
atomic conversion (debit and credit in one transaction), idempotent requests, no per-spend revocation growth,
and no way for deleting a file to create value. Portable signed credentials stay for collectibles, tickets,
trophies and memberships.

A migration path, evaluated only, with nothing in this branch to do it:

1. Complete the reconciliation in section 4 first; a migration from unreconciled balances would copy the
   errors into the ledger.
2. Opening balances come from the CURRENT set only, per owner key, approved by the operator.
3. Entry is by redemption: an owner presents a credential, the issuer revokes it and credits the account in
   one transaction keyed by the credential id (a unique constraint makes double redemption impossible). No bulk
   conversion, no automatic conversion, and no conversion into GOPH, MWC or any Chainblock coin without separate
   explicit authorisation.
4. Supply reconciliation: ledger total plus outstanding unredeemed credentials never exceeds the reconciled
   supply; report it before and after.
5. Credentials listed as RESURRECTED or SUPERSEDED_NOT_REVOKED are refused at redemption.

## 7. What is needed from you

1. The live `atlas-revocations.json` as it is now (a copy), and every older copy (hosting backups, pre-edit
   versions). How many entries before and after your deletions? Please do not edit the live file again.
2. The ids (or at least the reasons and times) of the Gold and Platinum records you deleted, if you still have
   them, and whether the file was ever saved in a state that did not parse.
3. A wallet export from each of the three wallets, taken before re-verifying or consolidating anything, and any
   older exports or automatic backups. These are spendable copies: send them privately, or run the audit tool
   yourself and send only its report.
4. Which two wallets failed, which did not, how each was used (one tab or several, which mining stalls, whether
   the Wallet tab was open while mining, whether the chess reward was used), and roughly when.
5. The Activity log of each wallet, and the exact text shown on the invalid stacks (`revoked by issuer` or
   `not verified: ...`).
6. The PHP access log and error log for `/atlas/asset/issue`, `/consolidate`, `/convert` and `/split` around the
   incident (status codes, response times, timeouts), and the PHP `max_execution_time` and memory limits.
7. The amounts and times of the Gold-to-Platinum conversions.

## 8. What was not examined

No live data was read, so nothing above says what happened on the live domains. Fault injection between the
mint and revoke steps of a single request was not done (V1 first half). The PHP striped spend locks under
opposite-order requests were seen once, not stress-tested. The elements catalogue rates were used as they
are; whether the Gold to Platinum rate is intended was not reviewed.
