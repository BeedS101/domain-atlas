# Gen1: crash-safe recovery for unique mint, purchase and trade claim

Gap 5 of `docs/gen1-wallet-crash-recovery.md`: a non-fungible mint, `/atlas/asset/purchase` and `/atlas/trade/claim`
had no `requestId`, no issuer replay and no wallet journal. If the issuer committed and the answer was lost, the wallet
had nothing and no way to ask again. This document describes what each operation does now, what the issuer keeps,
the compatibility rules, and what stays open.

The three operations are **not** recovered by one shared mechanism. Each section says why.

## 1. Analysis (before the change)

| | unique mint (`/atlas/asset/issue`, non-fungible class) | purchase (`/atlas/asset/purchase`) | trade claim (`/atlas/trade/claim`) |
|---|---|---|---|
| Request | `{ownerPublicKey, assetClass}` (no signature; the issuer signs for whoever is named) | `{credential, purchasedClass, quantity, intent}`; the intent is the buyer's signature over the balance id, class and quantity | `{pendingId, membership, intent, balance}`; the intent is the claimant's signature over offer and want |
| Commit point | the credential is signed and the serial counter has advanced | the paying balance is revoked in the same transaction as the signed purchase and remainder | the claimant's balance is revoked (first leg), then the poster's (second leg); the listing is removed last |
| Spends an existing credential | no | yes, the balance | yes, the claimant's balance and the poster's balance |
| Authoritative state | the issuer | the issuer | the station, plus the issuer of each balance when it is another domain |
| A repeat without an id | issues a second item (a serial is consumed) | refused: the balance is revoked | refused: the listing is gone and the balance is revoked |
| Before this change | not retrievable once the answer is lost | not retrievable | not retrievable |

What differs, and why the recovery differs:

- **Unique mint** has no predecessor. Nothing shows afterwards that it happened, so the stored answer is the only
  evidence. A repeat after that answer has expired would issue a second item (serials are not reused).
- **Purchase** is one issuer operation with a revoked predecessor, the same shape as a fungible split. It reuses the
  fungible machinery unchanged: spend lock, request lease, transaction journal, replay record.
- **Trade claim** is a station coordinating up to two balances. It has no single transaction. The station can be the
  issuer of both balances (all local), of one (the other is relayed to a trusted peer), and a relayed leg commits on
  another domain independently. The claim therefore **cannot be made atomic**, and this change does not try. What the
  station can do is remember the final outcome of a claim it has finished (or failed), so that a lost answer is not
  lost.

## 2. What a repeated request does now

All three use a `requestId` assigned before anything is sent, written to the wallet journal first.

**Unique mint.** Same request id, same owner, same class: the issuer returns the stored credential (the replay record
holds the signed credential, written by the existing transaction journal together with the serial and the holdings
entry). A different class or owner under that id: `409 request-id-conflict`, nothing returned. A membership class
(subscriber, post office, trading station, governance) also writes a roster row and a welcome mail; those writes are
now idempotent by credential id, so a replay after a crash between the commit and the roster write repairs the roster
without adding a second row or mail.

**Purchase.** The buyer's signed intent carries the `requestId`; the issuer rejects an intent whose id differs from
the body id (`400`). The replay record is keyed by the id and bound to `{purchasedClass, quantity, buyer}` and the
presented balance. A repeat returns the stored `{balance, purchased}` after re-checking the presented credential's
signature. The purchase and the remainder are signed first, the balance is revoked in the transaction journal's commit
(`deferHoldings`, as for split), then the replay record is stored.

**Trade claim.** The claimant's intent carries the `requestId`. The station keeps a per-id lease (`claim:`), looks the
id up first and, on a hit, returns the stored `{status, body}` exactly (PHP stores the exact JSON text, because
re-encoding a signed credential could change it). The record is bound to `{pendingId, claimant, balance id, offer,
want}` and to the presented balance; anything different is `409`. The record is written when the claim reaches a
terminal result:

| result | stored? | wallet |
|---|---|---|
| `200 settled` | yes | applies `received` and `remainder` |
| `502 claim-incomplete` (second leg failed after the first committed) | yes, with `refund` when the refund was possible | applies the refund; without a refund, `needs-attention` |
| `502 claim-unresolved` (the first leg failed or its outcome is not known) | no | `needs-attention`; never resent automatically |
| `502 not-settled` (locks refused before anything changed) | no | a definite refusal |
| 4xx refusals | no | as before |

The existing settlement and refund rules are unchanged. A spend on a foreign domain still has no refund path.

## 3. Wallet

- The journal entry (kinds `mint` for unique classes, `purchase`, `claim`) is written before sending, with the
  predecessors (`[]` for a mint, the balance for the other two), and survives restart and backup/restore with the
  same `requestId`. `answerIsUsable` checks that every returned credential is a well-formed credential of the entry's
  owner before anything is stored, so an HTML page, a truncated body or another owner's credential is not applied
  and the entry stays pending.
- Pending, recovering and needs-attention are the states of `docs/gen1-replay-expiry.md` and
  `docs/gen1-auto-recovery.md`. A refusal is definite only for a fresh send or when the balance is proven unrevoked;
  otherwise `needs-attention`. The viewer words the new kinds as "purchase" and "trade claim".
- A claim answered `claim-unresolved`, or `claim-incomplete` without a usable refund, is held as `needs-attention`
  with its balance held back. It is only sent again by "Ask the issuer again".

## 4. Compatibility: fail closed

An upgraded wallet must not repeat one of these requests against an issuer that has not been upgraded: the repeat
would issue a second item, or be refused after the first one was committed.

- The issuer advertises `GET /atlas/capabilities`: `{requestIds: {version: 1, operations: [...], retentionHours}}`.
  `issue-unique`, `purchase` and `trade-claim` are listed only by an issuer that implements them. An older issuer has
  no such route.
- **Fresh request, issuer without the capability (or without the operation): the single request the wallet always
  sent**, no `requestId`, no journal. The old behavior and its gap remain for that issuer, and nothing worse.
- **Repeat of a journalled request**: the wallet asks the capability endpoint first. Not reachable: the entry stays
  `pending`, nothing sent. Reachable but the operation is not listed: `needs-attention` with code
  `repeat-unsupported`, nothing sent, the balance stays held.
- PHP lists an operation only when the handler file that serves it contains the new version, so a bundle uploaded in
  part does not advertise more than it does. `lib/atlas-cli.php` (the deployment check) lists the files and markers.
- An old wallet against a new issuer is unaffected: a request without a `requestId` takes the former path.
- **Deploy the issuers first, then the wallet.** Test an upgraded issuer in isolation before it replaces a live one;
  it reads and writes the same state files and replay directory as before.
- The fungible `requestId` operations still assume an issuer that stores replays; they do not use the capability
  check (unchanged by this work).

## 5. Replay limits

- The stored result lives for `ATLAS_REPLAY_TTL_HOURS` (default 168 h) and is returned to a repeat that matches the
  stored parameters. Past that, a purchase or claim repeat is refused (the balance is revoked or the listing is gone)
  and the wallet keeps it as `needs-attention`; the item bought or received can no longer be fetched by that request.
- **Unique mint after expiry is the dangerous case**: there is no revoked predecessor to show the first request
  happened. The wallet therefore does not resend an unfinished unique mint older than 0.9 times the issuer's
  advertised `retentionHours` (`needs-attention`, code `result-may-have-expired`). A person can still ask again by
  hand, accepting that a second item may be issued; the first remains unclaimed at the issuer.
- A stored result is a bearer credential for its owner; it is kept in the same private replay directory as the
  fungible results. Retention was not extended.

## 6. Remaining gaps (not fixed here)

1. **A claim is not atomic across domains.** If the claimant's balance is on another domain and its relay-settle
   fails or is ambiguous, the outcome is unknown (`claim-unresolved`). The wallet holds the balance and shows it; the
   operator has to establish what happened. A foreign first leg has no refund path (unchanged).
2. **Claim crash between legs.** A station process killed after the first leg and before the second leaves the first
   leg committed with no stored outcome. The wallet's repeat is answered by a refusal (the balance is revoked) and the
   entry ends `needs-attention`. A durable claim journal on the station would close it; that is a separate design.
3. **Leftover from the claimant's balance on a failed second leg.** When the claimant offered less than the balance and
   the second leg fails, the first leg also minted a remainder to the claimant. The `claim-incomplete` response
   carries the `refund` but not that remainder, so the wallet never receives it. This is existing behavior; changing
   it is a refund-rule decision and was not done.
4. **No dismiss action** for `needs-attention` entries (unchanged).
5. **Serial gap**: a crash between reserving a serial and writing the transaction journal consumes a serial with no
   credential (unchanged for fungible; now also for unique mint, where it is visible as a gap in serials).
6. **A narrow window** between storing the claim outcome and removing the listing: the listing could be offered to
   another claimant once, whose attempt then fails on the claimed balance (a refusal; no second settlement of the
   first claimant's balance).
7. Admin mint (`/atlas/asset/mint`) and demo mints are not journalled and are out of scope; asset-file transfer and
   claim have their own ledger.

## 7. Node and PHP

| | Node | PHP |
|---|---|---|
| Replay store | JSON object per id | same; the claim outcome stored as exact text |
| Claim lease | `holdLease(res, 'claim:'+id)` | `atlas_lease('claim', id)` |
| Capability | all operations listed | each listed only if its handler file has the new marker |
| Roster writes | `recordIssuance` | `atlas_record_issuance` |
| Cross-domain tests | single process; a peer can be called while handling a request | the PHP dev server needs workers (`workers: 4`) or the station and peer deadlock on each other's key fetch (test setup only) |

## 8. Tests

`xvfb-run -a node test/manual-gen1-unique-recovery.js [node|php|both] [--only=M1]`: isolated Node/PHP issuers, disposable
Chromium profiles with the real extension; stored-result retention is shortened for the expiry scenarios.

| Scenario | Mint | Purchase | Claim |
|---|---|---|---|
| answer lost after commit, then restart | M1 | P1 | C1 |
| killed before sending | M2 | P2 | C2 |
| killed after the answer, before storing | M3 | P3 | C3 |
| wallet locked while the answer arrives | M4 | P4 | C4 |
| issuer unavailable, repeated retries, direct repeats | M5 | P5 | C5 |
| same id with changed parameters, other owner, no binding | M6 | P6 | C6 |
| concurrent retries (six direct, three pages and the worker) | M7 | P7 | C7 |
| backup with the operation pending, restored in a fresh profile | M8 | P8 | C8 |
| stored result expired | M9 | P9 | C9 |
| HTML, truncated and wrongly owned answers | M10 | P10 | C10 |
| membership roster written once; refusals before any entry | M11 | P11 | |
| second leg fails after the first, answer lost | | | C11 (cross-domain, patched peer) |
| first leg unknown | | | C12 (cross-domain, patched peer) |
| capability endpoint, unsupported / unreachable / partial issuer, fresh request at an old issuer | K1-K6 | K4 | |
| negative controls (previous wallet and issuer from git history): the original failure, and old/new in both directions | N1 | N2 | N3, N4, N5 |

Results: see section 9.

## 9. Results

Run on isolated issuers and disposable Chromium profiles (Playwright, `xvfb-run -a`).

| Suite | Result |
|---|---|
| `manual-gen1-unique-recovery.js both` | 345 passed, 0 failed (Node 172, PHP 173), 10 INFO lines (the cases that stay open, and the revision the negative controls ran) |
| `manual-gen1-wallet-crash-recovery.js both` | 322 passed, 0 failed, 4 gap probes (the expiry gaps of the fungible operations). The probes for unique mint and purchase became checks. A first full run had four failures in B4 (two pages recovering at once, Node, fungible consolidation, credentials shown `unavailable`); it did not repeat in three isolated runs of B4 or in a second full run, and the cause was not found |
| `manual-gen1-replay-expiry.js both` | 152 passed, 0 failed |
| `manual-gen1-backup-journal.js both` | 356 passed, 0 failed |
| `manual-gen1-auto-recovery.js both` | 238 passed, 0 failed |
| `manual-wallet-storage-safety.js node` / `php` | 79 passed, 0 failed each |
| `manual-gen1-wallet-fixes.js` | 52 passed, 0 failed |
| `manual-gen1-fungible-fixes.js both` | 148 checks, 0 failed |
| `manual-gen1-transaction-recovery.js both` | 1750 passed, 0 failed |
| `manual-gen1-php-deployment.js` | 153 passed, 0 failed |
| `manual-revocation-safety.js` | 129 passed, 0 failed |
| `manual-gen1-wallet-races.js` | no loss; 0 of 6 trials short |
| asset purchase/fulfill, asset mint, spend race, museum ticket stall | all passed |
| remote trade, cross-domain trade (Node, PHP), failed-second-leg refund (Node, PHP), ambiguous settle response (Node, PHP), trade unique item, PHP trade (open listings) | all passed |
| full backup, automatic backup, identity-sync backup | all passed |

The remote-trade and full-backup suites need the demo domains on ports 8001 and 8002 (run from copies, so the
repository's own key and state files stay untouched).

Negative controls (N1-N3): with the previous wallet and issuer, a lost answer leaves the serial consumed, the balance
revoked or the listing settled, and the wallet with nothing and no entry to retry. N4 and N5 show that an old wallet
works against the new issuer and the new wallet against the old issuer, by the single request they always used.

Not covered: a live deployment, a real browser against a real slow network, the PHP deployment on a shared host, and
two station processes sharing one state directory.
