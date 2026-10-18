# Gen1 wallet: interruption and recovery audit

Scope: the wallet's pending-operations journal (`atlasPendingOps`, `runIssuerOperation`, `sendOperation`,
`commitOperation`, `recoverPendingOperations` in `extension/wallet.js`) for mint, split, consolidate and convert,
against the Node and PHP issuers. Test: `test/manual-gen1-wallet-crash-recovery.js`. No production code was
changed for this audit. The tests use throw-away Chromium profiles, issuers, keys and revocation lists.

## How a replacement operation works

1. The request gets a fresh `requestId` and is written, encrypted, to the journal **before** it is sent.
2. It is sent with no lock held. The issuer commits it (revokes the predecessors, signs the successors) and stores
   the answer under the `requestId`.
3. The answer is applied to the wallet and the journal entry is removed in **one** `chrome.storage.local.set` of
   both keys, under the wallet lock, only if the entry is still in the journal.
4. With no answer (network, timeout, 5xx, busy) the entry stays and is sent again with the same `requestId`; the
   issuer returns the stored answer. A definite refusal (other 4xx) removes the entry.

The wallet is therefore in one of two states at every instant: the predecessors with the journal entry, or the
successors without it. There is no half-applied state.

## Results

Run: `xvfb-run -a node test/manual-gen1-wallet-crash-recovery.js both` (add `--quick` for fewer random kills).
Current result: 304 checks pass, 0 fail; 18 gap probes (9 per issuer).

| Interruption (SIGKILL of the browser, restart on the same profile, unlock) | Result |
|---|---|
| issuer committed the consolidation, answer lost | journal kept; recovery gives one 40 g credential, applied once, revocation count unchanged |
| answer received, commit write never reached storage | stored wallet and journal byte-identical to before; recovery completes it |
| commit stored, killed immediately after | nothing pending, one 40 g credential, nothing to recover |
| journal written, request never sent | issuer untouched until recovery; then exactly one commit |
| storage rejects the commit write (disk full) | wallet and journal unchanged; recovery after storage works completes it |
| random-timing kills during mint + consolidation | never a revoked credential held, never anything but +0 or +20 g, the issuer's own held count equals the wallet's |
| two extension pages recover the same operation at once | applied exactly once |
| issuer unreachable during recovery, wallet restarted again | entry kept with the same `requestId`, attempts counted, completes later |
| mint, split and convert answers lost, browser killed | each completes once; amounts and the issuer's held count match |
| wallet locked after the restart | recover, re-verify, consolidate, import, mint, convert while locked change nothing in storage |
| lock fires while a consolidation is in flight | the arriving answer writes nothing; journal kept; completes after unlock |
| old 20 g credentials re-imported from a file made before the consolidation | flagged spent, not counted |
| the lost request re-sent with the same `requestId` | same signed credential, no extra revocation |
| the same predecessors re-sent under a new `requestId` | refused, no second successor |
| stale predecessor spent before recovery ran | refused; recovery runs first; nothing spent twice |

So for the question asked: after the issuer commits a consolidation and the extension dies before storing the
successor, restarting the wallet cannot duplicate or resurrect assets, and loses nothing **as long as the journal
survives and the issuer still holds the stored answer**.

## Gaps (reported, not changed)

Ordered by consequence.

1. **Expired answer loses the successor.** The issuer keeps the stored answer for `ATLAS_REPLAY_TTL_HOURS`
   (default 168, 7 days). If the wallet retries later, the issuer sees the predecessors already revoked and answers
   `revoked`; the wallet treats that as a definite refusal, deletes the journal entry and (after re-verify) flags the
   predecessors spent. Result in the test: wallet 0 g, issuer still counts 40 g held, so the owner's cap is consumed
   by credentials nobody can retrieve. The only trace is an activity-log line.
2. **The journal is not in the backup** (`buildBackupPayload`; manual and automatic backups). A backup taken in the
   window, restored on a fresh profile, has the revoked predecessors and no journal: the wallet ends with 0 g of
   40 g (and, until a manual re-verify, one revoked 20 g credential still shown as live).
3. **A lock during a non-fungible mint can erase the wallet.** `runPlainOperation` then `mutateWallet` reads the
   wallet while locked (decrypt fails and returns `[]`) and writes back a plaintext list holding only the new item.
   In the test the 40 g Iron balance disappeared from the wallet store (still valid at the issuer; recoverable only
   from a backup). Fungible operations are safe because their commit refuses when the journal entry cannot be read.
   The general hazard is any `mutateWallet` / `saveWallet` that runs while the wallet is locked.
4. **Nothing recovers the journal automatically after a restart and unlock.** It runs before the next operation
   for that owner, and in `reverifyAll` (the Re-verify button). Until then the wallet lists revoked predecessors as
   live and verified, and a spend of one of them is refused.
5. **Operations that are not journalled at all** (no `requestId`, no replay on the issuer): non-fungible mint,
   `/atlas/asset/purchase` (museum stall) and `/atlas/trade/claim`. A lost answer after the issuer commits means the
   balance is spent and nothing arrives. Confirmed for non-fungible mint and purchase; trade claim by code reading.
   (Transfer-to-file and claim-from-file have their own ledger and are out of scope here.)

## Possible fixes, smallest first

- Immediately and without code: set `ATLAS_REPLAY_TTL_HOURS` (for example 720) on both issuers. The stored answers
  are live bearer credentials, so longer retention is a security trade-off; they stay private (0600, outside or
  behind the guarded folder).
- Wallet: never delete a journal entry on a `revoked` refusal; keep it as "needs attention", show it, and keep it in
  the backup. Include `atlasPendingOps` in the backup payload and restore it.
- Wallet: refuse `saveWallet`, `mutateWallet` and `journalAdd` when a stored blob is encrypted and no key is
  available (the same rule the fungible commit already follows). Make the non-fungible mint refuse in that state.
- Wallet: run `recoverPendingOperations` once after unlock and on a timer, and mark predecessors of a pending
  consolidation as "being replaced" in the display.
- Issuer, for recovery without a journal or after expiry: an owner-signed endpoint that returns the unrevoked
  credentials the issuer has signed for that owner (the holdings index today keeps only ids and quantities, so it
  would also have to keep the signed credentials). This is the one change that makes a lost journal recoverable.
- Add `requestId` and issuer-side replay to non-fungible mint, purchase and trade claim, then journal them.

None of these touch mining reward amounts, existing balances or the live economy.
