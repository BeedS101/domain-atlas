# Gen1 wallet: automatic recovery of pending operations after unlock, and the status the wallet shows

Scope: `recoverAfterUnlock`, `recoverPendingOperations`, `retryPendingOperation`, `getPendingOperations`,
`getRecoveredOperations` in `extension/wallet.js`, and the wallet page in `extension/viewer.js` / `viewer.html`.
Follows `docs/gen1-wallet-crash-recovery.md` (the journal), `docs/gen1-replay-expiry.md` (`needs-attention`) and
`docs/gen1-backup-journal.md` (the journal in backups). Test: `test/manual-gen1-auto-recovery.js`. No issuer code, wire
format, signed credential, journal format or revocation file changed. The tests use throw-away Chromium profiles and
Node/PHP issuers with their own keys and state. Nothing live was read or written.

## The problem

A pending journal entry (an issuer-committed replacement whose answer was lost) was only retried when the person did
another operation for the same owner, pressed Re-verify, or the code was called by hand. After a restart and unlock
the wallet therefore listed predecessors the issuer had already revoked, with nothing saying why, until something
else happened to trigger recovery (gap 4 of the crash-recovery audit). Unfinished transactions also had no place in the
wallet where their state was written out.

## When recovery runs

Recovery is driven by wallet lifecycle events, not by a timer or by the background worker starting.

| Event | What happens |
|---|---|
| the wallet is unlocked (`unlockIdentity`, in whichever page or worker it happens) | `recoverAfterUnlock()` is queued (`setTimeout 0`, not awaited, errors swallowed) |
| a wallet page (`viewer.js`) opens and the wallet is already unlocked | the page calls `recoverAfterUnlock()` |
| a wallet page sees the unlock happen in another page (`chrome.storage.session` change) | the page calls `recoverAfterUnlock()` |
| a full or automatic backup restore finishes in the wallet page | the page calls `recoverAfterUnlock()`. The restore itself still sends nothing |
| the background worker starts, a page opens while locked, the browser starts | nothing is sent |
| an ordinary operation or Re-verify (unchanged) | `recoverPendingOperations(owner)` runs first, as before |

`recoverAfterUnlock()` sends nothing unless **all** of these hold, checked in this order:

1. there is an active identity (a locked wallet has none: `reason: 'locked'`);
2. the wallet list and the journal for that identity can both be read strictly: a stored value that exists but cannot be
   decrypted or parsed gives `reason: 'unreadable'` (or `'locked'`), and nothing is read back, written or sent;
3. some journal entry is usable and not `needs-attention` (otherwise `reason: 'nothing-to-recover'`).

Then it runs `recoverPendingOperations(owner, { minGapMs })`.

## What automatic recovery sends, and what it never sends

- It sends the **same request, with the same `requestId`**, that the journal holds: the issuer replays its stored
  answer or refuses. Nothing is created, guessed or inferred from the revocation list.
- It never sends an entry in `needs-attention`. Those are only sent by `retryPendingOperation` (the "Ask the issuer
  again" button), exactly as in `docs/gen1-replay-expiry.md`. An expired replay or revoked predecessors are not read as
  completion or failure: the refusal handling of `sendOperation` (definite only for a fresh request or a proven
  unrevoked predecessor, otherwise `needs-attention`) is unchanged.
- It stops sending as soon as the wallet is locked or the active identity is not the journal's owner: each entry
  re-checks `getIdentity()` before its request. An answer that arrives after a lock or an identity change cannot be
  stored (the storage layer cannot read the old identity's records with the new key) and the entry stays pending.
- An attempt's evidence is kept: `attempts`, `lastError` and `lastAttemptAt` are updated by `sendOperation` as before; a
  failure (unreachable issuer, 5xx, `busy`, an answer that is not a usable result) never removes the entry or changes its
  request body.

## Coordination between pages (single flight)

Every extension page and the background worker share one origin, so the wallet uses Web Locks (the same mechanism as the
existing wallet-list lock), with no new infrastructure and a per-context fallback when `navigator.locks` is missing.

- `atlas-recovery:<owner>` is taken with `ifAvailable`: if another page is already recovering that owner, the second
  call returns at once with no outcomes.
- `atlas-op:<requestId>` is held while a request is being sent, both by recovery and by `runIssuerOperation` from the
  moment the new entry is journalled until its first send ends. Recovery skips an entry whose operation lock is held
  (`skipped: 'in-flight'`), so a fresh operation and a recovery in another page never send the same request at the same
  time. A manual retry waits for the lock instead of skipping.
- Applying an answer is still one `chrome.storage.local.set` of wallet and journal that fails when the entry is already
  gone (`commitOperation`), so even if two sends did happen the answer is applied once.

## No tight loops, no background polling

An automatic attempt is recorded per request id in `chrome.storage.session` (`atlasAutoRecovery`). A later automatic
call within `AUTO_RECOVERY_MIN_GAP_MS` (2 minutes) leaves that entry alone (`skipped: 'recent-attempt'`). Because it is
session storage it is shared by all pages and is gone when the browser closes, so the first unlock of a browser session
always tries once. So repeated lock/unlock cycles, several pages opening, or a wallet that is unlocked and relocked
cannot hammer a failing issuer; after the gap the next lifecycle event tries again. There is no timer. Manual
recovery paths (the next operation, Re-verify, "Ask the issuer again") are not subject to the gap.

## What the wallet shows

A section **"Transactions waiting for the issuer"** at the top of the inventory (`role="region"`, labelled by its
heading, hidden when there is nothing to show). Each item starts with its status in words; the symbol repeats it and the
dashed border marks "needs attention", but nothing depends on colour.

| Status | Meaning | Shown when |
|---|---|---|
| **Pending** | the issuer has not confirmed the transaction | journal entry in `pending`, nobody is sending it now |
| **Recovering** | an eligible operation is being asked about right now | some page holds the operation lock of the entry |
| **Needs attention** | recovery cannot safely tell what happened; nothing is sent unless asked | journal entry in `needs-attention` (or an unreadable element, kept as it is) |
| **Completed** | the issuer's answer was applied to this wallet | listed from the activity log for 7 days (at most 5), see below |

Pending and needs-attention items show the kind and issuer, when they started, how often the issuer was asked, the last
answer, and an "Ask the issuer again" button (`retryPendingOperation`). Its result is announced in a polite live region
("Completed", "Still needs attention", "No answer yet", or the refusal). The section refreshes when the journal changes
(`chrome.storage` change), when automatic recovery starts and ends, and with the inventory.

**Completed is not "HTTP 200".** A usable answer is applied only after it has the right credential type, signature
field and owner (`answerIsUsable`), each added credential has been verified (`verifyCredential`: issuer signature and
revocation list), and the wallet and journal were updated in one write. The activity-log note, written only when this
call applied the answer, records whether every added credential verified (`verified`) and the page says either
"signature and revocation status checked" or "could not be fully verified yet". Completed operations are not kept in the
journal: the entry is removed with the apply, and the notice is an ordinary activity-log record (kind and issuer only,
no request id, no credential id), so nothing accumulates in the pending journal and no new store exists.

**Held balances.** `getWallet` still returns the predecessors of an unfinished entry marked `pendingOutcome`, with a
verdict that is never `verified`. The wallet page now shows such a card with a dashed border and the line "On hold —
part of a transaction the issuer has not confirmed yet / that needs attention. It cannot be spent, merged, traded or
dropped until that is settled.", and with no Drop, Load, Wear or Save-to-file action (only Hide). The consolidate header
counts only balances that are not held, and the trade, convert and balance-total pickers skip held balances. The
wallet-side refusals (`unresolved-operation`) stay as the enforcement; the page changes only stop offering the actions.

## Failure handling

| Situation | Result |
|---|---|
| wallet locked, or locked mid-recovery | nothing sent while locked; an in-flight answer cannot be stored; entry stays pending and is asked about again by the next unlock |
| journal or wallet unreadable / corrupted | `reason: 'unreadable'`, nothing sent, nothing rewritten; ordinary operations keep refusing as in `docs/wallet-storage-safety.md` |
| issuer unreachable, timeout (60 s), 5xx, `busy` | attempt counted, entry kept, no further automatic attempt for 2 minutes |
| 200 with HTML, truncated or empty body, wrong credential | never applied, entry kept, attempt counted |
| refusal of a recovered request | `needs-attention` unless a predecessor is shown unrevoked (unchanged); never retried automatically afterwards |
| identity replaced while a request is in flight | later entries are not sent; the stored records of the old identity are untouched |
| several pages at the same moment | one recovers, the others see the slot busy or an empty journal |

## What is not done

- No polling and no timer: an issuer that is down for an unlock is asked again at the next lifecycle event after the
  gap, or on "Ask the issuer again", not on a schedule.
- No automatic handling of `needs-attention` entries, no dismiss action, no change to the backup, journal or credential
  formats, and no recovery without a journal (that needs issuer-side outcome evidence, a separate piece of work).
- The background worker does not recover by itself when it merely starts; a locked wallet never does.
- WebAuthn identities are always "unlocked", so a wallet page opening recovers for them as well; the journal of such an
  identity is stored unencrypted as before.
- `getPendingOperations` cannot read an undecryptable journal and shows nothing for it (sends and spends are refused;
  see `docs/gen1-replay-expiry.md`).
- Marks, "On hold" lines and the status section are display; only the wallet-side checks are enforcement.
- Test hook: the shared test harness keeps the post-unlock recovery inert by default so the suites that test manual
  recovery paths still do (`test/lib/wallet-profile.js`, `autoRecovery`); the extension has no such switch.

## Tests

`xvfb-run -a node test/manual-gen1-auto-recovery.js [node|php|both] [--only=R1]` (`--only` matches by prefix).

| Scenario | Covers |
|---|---|
| R1 | locked start: worker and wallet page send nothing, `recoverAfterUnlock` reports locked; the unlock recovers by itself with one request, one verified 40 g credential, no new revocation, a completion notice without ids |
| R2 | `needs-attention` untouched by restart + unlock (no request), predecessors held, explicit retry still sends |
| R3 | issuer unreachable: attempt recorded, request body unchanged, three lock/unlock cycles and repeated calls send nothing more, a later attempt after the gap completes |
| R4 | four wallet pages opened while locked, unlock in one: exactly one request from five contexts, one credential |
| R5 | an operation in flight is skipped by automatic and manual recovery; shown as recovering; applied once |
| R6 | repeated unlocks and restarts after recovery change nothing; a page opened afterwards sends nothing |
| R7 | unreadable journal, unreadable wallet: nothing sent, stored values untouched; recovery runs once both are readable |
| R8 | a journal restored from an encrypted backup: restore sends nothing, a locked start sends nothing, the unlock recovers by the original request id |
| R9 | identity replaced while a request is in flight: the second entry is not sent, the old identity's records are byte-identical, restoring the identity brings both back and the next unlock recovers both |
| R10 | HTML and truncated answers keep the entry (attempts counted); the next attempt applies the real answer once |
| R11 | lost mint, split and convert answers recovered by the unlock |
| R12, R12b | the wallet page: Recovering, Pending, Completed and Needs attention in words, live region, retry button, held cards without spend/drop actions, no request from the page for `needs-attention` |
| N1 | negative control: the previous `wallet.js` (last revision without `recoverAfterUnlock`) leaves the operation pending six seconds after the unlock with no request sent |

## Results

Run on isolated issuers and disposable Chromium profiles (Playwright, `xvfb-run -a`), Node and PHP backends where the
suite supports both.

| Suite | Result |
|---|---|
| `manual-gen1-auto-recovery.js both` | 238 passed, 0 failed (119 per backend) |
| `manual-gen1-replay-expiry.js both` | 152 passed, 0 failed |
| `manual-gen1-backup-journal.js both` | 356 passed, 0 failed |
| `manual-gen1-wallet-crash-recovery.js both` | 314 passed, 0 failed, 8 gap probes (4 per backend). The two gap probes for "nothing recovers after unlock" became checks; the two-page race check now asserts at most one application plus the end state, because a page that opens on an unlocked wallet recovers by itself |
| `manual-wallet-storage-safety.js node` / `php` | 79 passed, 0 failed each |
| `manual-gen1-wallet-fixes.js` | 52 passed, 0 failed |
| `manual-gen1-wallet-races.js` | no loss, no revoked credential left, 0 of 6 trials short |
| `manual-full-backup.js`, `manual-auto-backup.js`, `manual-identity-sync-backup.js` | all checks passed |
| currency conversion, asset-file wallet, mail gift, wallet import, legacy-wallet migration, sold-unique-item cleanup, wallet-to-server delete, null-manifest race, wallet resilient to a drops failure, world drops, trade unique item, cross-domain trade (Node), failed-second-leg refund (Node), remote trade | all passed |
| `manual-asset-management.js` | passed on two reruns and on the previous code; one earlier run timed out clicking a card menu after "unhide" (UI timing, not reproduced) |

Negative control (N1): with the previous `wallet.js` the operation is still pending six seconds after the unlock and no
request was sent; the current wallet settles the same situation by itself.

Not run: the PHP variants of the trade suites and the issuer transaction-recovery and PHP deployment suites (issuer code
is unchanged).
