# Gen1 wallet: replacement requests after the issuer's stored answer has expired

Scope: the wallet's pending-operations journal (`atlasPendingOps`, `sendOperation`, `recoverPendingOperations`,
`retryPendingOperation` in `extension/wallet.js`) for fungible mint, split, consolidate and convert, against the Node
and PHP issuers. Follows gap 1 of `docs/gen1-wallet-crash-recovery.md`. Test: `test/manual-gen1-replay-expiry.js`.
No issuer code changed; the wire protocol, signed credentials and the revocation file are untouched. The tests use
throw-away Chromium profiles and issuers (their own keys, state and revocation lists; replay retention shortened to
about two seconds). Nothing live was read or written.

## The failure

A replacement is committed by the issuer in one step: the predecessors are revoked and the signed successors exist
only in the issuer's answer, which it keeps for `ATLAS_REPLAY_TTL_HOURS` (default 168). If the answer is lost and the
wallet asks again after that window, the issuer no longer has the answer. It sees predecessors that are already
revoked and refuses with `revoked`.

Before this change the wallet read that refusal as "nothing happened": it deleted the journal entry and, after the
next re-verify, flagged the predecessors as spent. Reproduced on both issuers: the wallet ended with 0 g, the issuer
still counted the 40 g successor toward the holding cap, the only trace was an activity-log line, and until a re-verify
the revoked predecessors were listed as verified.

## How the wallet now treats each response

A request is **fresh** while it is the first send of an entry that was written in the same call. Anything else (an
entry recovered after a restart, an entry with an earlier attempt) may already have reached the issuer.

| Response to a send | Result |
|---|---|
| 2xx with a usable result (right credential type, signed, owned by the right key) | applied to the current wallet and the entry removed in one storage write, once |
| 2xx that is not usable (HTML page, truncated or empty body, `[]`, a credential owned by someone else) | never applied; entry stays `pending`, attempt counted, sent again later. Before this change such an answer deleted the entry |
| network error, timeout, 5xx, `busy` | entry stays `pending`, attempt counted |
| 4xx on a fresh request | definite refusal: entry removed, error returned (unchanged) |
| 4xx on any other send, and at least one predecessor is shown **not revoked** on the issuer's revocation list | definite: nothing was committed (a replacement revokes all its predecessors in one atomic step). Entry removed |
| 4xx on any other send, and every predecessor is revoked, or the list cannot be read, or the request has no predecessors (a mint) | **`needs-attention`**: the entry is kept, nothing is guessed |
| the wallet storage cannot be written while applying | entry stays; applied by a later recovery (unchanged) |

## The `needs-attention` state

Stored on the journal entry: `state: 'needs-attention'` and `attention: { at, status, code, message,
revokedPredecessors }`. An entry without `state` is `pending`. The two states are reported separately by
`getPendingOperations` (`state`, `predecessors`, `attention`) and by `recoverPendingOperations` (`status`
`'needs-attention'`), so it cannot be mistaken for `completed` or `failed`.

While an entry is `pending` or `needs-attention`:

- its predecessors stay in the wallet, but `getWallet` returns them marked (`pendingOutcome`) with a verdict that is
  never `verified` ("part of a transaction the issuer has not confirmed yet" / "...that needs attention"). The marks
  are display-only and are removed again when a listed wallet is stored (`saveWallet`);
- they are left out of automatic consolidation, out of the balances a mint presents to the issuer, and out of
  purchases;
- consolidate, split, convert, drop, trade submit, trade claim, purchase and delete of one of them are refused with
  `code: 'unresolved-operation'` before anything is sent or written. The check reads the journal strictly, so an
  unreadable journal refuses as well (`wallet-unreadable`);
- recovery, including the automatic recovery after unlock (`docs/gen1-auto-recovery.md`), does not send a
  `needs-attention` entry again. `retryPendingOperation(owner, requestId)` does, when the
  person asks. It can still apply a late answer (once), and it ends the entry if the refusal can now be shown to be
  pre-commit.

The entry is never removed by the wallet on its own and is never turned into a credential. Nothing is recreated from
the revocation list, and no ownership is inferred from it.

## What this guarantees

- An interrupted replacement is never silently forgotten: the journal entry, its predecessors and the issuer's
  refusal stay until an answer for the same `requestId` is applied or the refusal is proven pre-commit.
- Predecessors of an unresolved request are never presented as spendable or verified, and cannot be spent,
  consolidated, traded, dropped or deleted through the wallet.
- A usable answer is applied at most once; repeated or concurrent recovery (two pages, repeated manual retries)
  cannot create a second credential, and the retry path sends nothing for an entry that needs attention.
- A malformed or wrong 200 answer cannot end the entry or be stored.
- Damaged journal data is not rewritten away: an undecryptable journal refuses every send and spend and is not
  overwritten; unusable elements next to valid entries are kept and reported as `unreadable`.
- Compatible with the live PHP issuer and existing credentials: no request, response or file format changed. An old
  issuer without replay (an unknown `requestId` is ignored) now ends a retried-after-commit request as
  `needs-attention` instead of losing the entry.

## What remains impossible without longer-lived issuer-side outcome evidence

- **The expired successor is not recoverable by the wallet.** After the stored answer is gone, the signed successor
  exists nowhere the wallet can read. Recovery needs an issuer that can return, to the owner, the unrevoked
  credentials it signed for that key. Its holdings index keeps only `{id, quantity}`, so this means storing signed
  credentials longer or adding an owner-signed endpoint. That is an issuer design change; retention was deliberately
  not extended here. The issuer keeps counting the unretrievable successor toward the holding cap.
- **A mint cannot be distinguished after expiry.** A fungible mint has no predecessors. If its answer is lost and the
  retry is accepted after the window, the issuer simply mints a second credential: the wallet gets one, the issuer's
  index counts two. Only a refusal (for example the cap) is caught, as `needs-attention`.
- **A request still being processed.** The wallet aborts a send after 60 seconds. A request that is only slow can
  still commit afterwards, after the wallet has concluded from a refusal that nothing happened. The window is the
  issuer's processing time, and the issuer's own transaction journal (section 1.6 of `docs/gen1-fungible-safety-fixes.md`)
  settles it on the issuer side; the wallet cannot see that.
- **Revoked is not proof of who revoked.** The public list does not say which request revoked an id (the `txn` tag is
  random, not the `requestId`). All-revoked predecessors therefore stay `needs-attention` even if another request,
  not this one, spent them.
- **No way to dismiss an entry.** It is kept as evidence, indefinitely. A person-facing screen, a dismiss action and
  the display in `viewer.js` are not part of this change.
- **A journal that cannot be decrypted cannot mark the display**: sends and spends are refused, but the predecessors
  are listed unmarked. (The journal is now carried in manual and automatic backups, see `docs/gen1-backup-journal.md`;
  a restored entry keeps its state, so an expired request restores as `needs-attention`.)
- **Unique mint, purchase and trade claim** are journalled and replayable now (`docs/gen1-unique-recovery.md`); the limits
  above apply to them too, with the unique-mint retention guard described there.

## Tests

`xvfb-run -a node test/manual-gen1-replay-expiry.js [node|php|both] [--only=E1]`:

| Scenario | Covers |
|---|---|
| E1 | answer lost, browser killed, retention passed: `needs-attention`, entry and predecessors kept, none shown verified, repeated recovery sends and writes nothing, five spends refused without a request, automatic consolidation inert, unrelated mints still work, two simultaneous manual retries, restart, re-verify |
| E2 | issuer unreachable first, then only reachable after the retention has passed |
| E3 | refusals that are still definite: fresh request, retry with an unrevoked predecessor, a non-issuer 403 page |
| E4, E4b | revocation list unreadable stays `needs-attention`, and a manual retry ends it once readable; one predecessor spent elsewhere is a definite refusal |
| E5 | 200 answers that are HTML, truncated, empty, `[]` or owned by another key, five rounds on one wallet, each applied exactly once on recovery |
| E6 | a fungible mint refused on retry |
| E7 | damaged journal entries next to a real one; an undecryptable journal refuses mint, drop and delete and is not overwritten |

Negative control: the same E1 against the previous `wallet.js` fails at its first expiry check (the entry is
removed and recovery reports `failed`).

## Results

Run on isolated issuers and disposable Chromium profiles, Node and PHP backends where the suite supports both.

| Suite | Result |
|---|---|
| `manual-gen1-replay-expiry.js both` | 152 passed, 0 failed (76 per backend) |
| `manual-gen1-wallet-crash-recovery.js both` | 310 passed, 0 failed, 16 gap probes (the expired-successor and backup probes remained gaps by design when this was written; the backup probes are closed, see `docs/gen1-backup-journal.md`) |
| `manual-gen1-wallet-fixes.js` | 52 passed, 0 failed |
| `manual-gen1-wallet-races.js` | no loss, no revoked credential left in the wallet, 0 of 6 trials short |
| `manual-wallet-storage-safety.js node` and `php` | 79 passed, 0 failed each |
| `manual-currency-conversion.js` | all checks passed |
| `manual-gen1-fungible-fixes.js both --quick` | 142 checks, 0 failed (issuer side, unchanged code) |
| trade, remote trade, cross-domain trade (Node), failed-second-leg refund (Node), asset-file wallet, mail gift, wallet import, legacy-wallet migration, sold-unique-item cleanup, asset management, wallet-to-server delete, world drops, null-manifest race, wallet resilient to a drops failure | all passed |

Not run for this change: the issuer transaction-recovery and PHP deployment suites (issuer code is unchanged), and the
PHP variants of the trade suites.
