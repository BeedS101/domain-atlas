# Chain labs: rollback protection

A domain's coin ledger is one SQLite file (`chain34.sqlite` in the private folder). Putting an older copy of that file back
(a backup restored by hand, a host that rolled its disk back, a bad migration) brings back balances that were already spent, and
nothing inside the file can tell. This document describes how the domain and the wallet notice that, what stops, how the operator
recovers without ever bringing spent funds back, and what a same-account checkpoint can and cannot promise.

Code: `chain-labs/lib/checkpoint.php` (the domain's guard), the guard calls in `chain-labs/lib/ledger.php`, the operator actions in
`chain-labs/spend34.php`, the multi authority helpers at the end of `chain-labs/lib/peer.php`, and the wallet's kept heads in
`extension/chain-labs-wallet.js`. Tests: `test/chain-labs-rollback.php`, `test/chain-labs-rollback-http.js`,
`test/chain-labs-wallet.js` ("a domain whose database is put back from an older copy").

## 1. The problem

Before this, a single authority coin had no second record of how far it had got. An old copy of the database, put back, held a valid
log that simply ended earlier: the balances of that time, the wallets' sequence numbers of that time, and every spend since then gone.
The next transfer signed against the old state executed, so funds that had been spent once could be spent again. For a multi authority
coin the partner domains held the later entries, so a rolled back authority was found at the next `compare` or approval, but only then.

`test/chain-labs-rollback.php` first shows it with the guard detached (the old copy gives alice her 1000 again and she spends it a
second time), then repeats the same steps with the guard on.

## 2. What the domain keeps

Per coin, two append-only files of JSON lines in `<database path>.checkpoints/` (for the default layout,
`chainblock-labs-private/chain34.sqlite.checkpoints/`):

| File | Holds |
| --- | --- |
| `<coin>.log` | The checkpoint lines: what was about to be written, what was written, and the decisions made after a problem. |
| `<coin>.journal` | Every committed entry in full (public and private forms), so lost entries can be replayed with every check. |

Each line carries the sum of the line before it (`prevSum`) and its own (`sum`, the SHA-256 of its canonical form), so a changed,
removed or reordered line is a break in the chain, and a line cut short by a crash is told apart from damage.

| Line | Meaning |
| --- | --- |
| `adopt` | The head of a coin that had no checkpoint yet: a ledger from before this existed, or a new coin. |
| `intent` | Entry N is about to be committed. Written before the database commit. Never a floor. |
| `commit` | Entry N is in the database. This is the floor: the database must never hold less. |
| `halt` | The database was found behind (`rollback`), on another history (`conflict`), or the log is damaged. |
| `restored` | The lost entries are back and the database holds the floor again. |
| `accept` | The operator accepted the loss. Permanent. |
| `reseal` | The operator began a new file after damage. |

The folder is created with mode 0700 and the files with 0600, every append is flushed to disk (`fsync`) under a lock, and the guard
refuses a folder inside `DOCUMENT_ROOT`. The checkpoint folder is beside the database, never in the web root, and is not served.

### Order of a commit

1. The intent line for entry N is written and flushed.
2. The database transaction commits.
3. The entry is appended to the journal and the commit line is written.

If the intent line cannot be written (full disk, unwritable folder) nothing commits and the request fails with
`checkpoint-unavailable`: the guard fails closed rather than letting entries through that it cannot record.

## 3. Crash or rollback

Every check compares the database head with the floor (the highest `adopt`, `commit` or `restored` line).

| Found | Verdict | What happens |
| --- | --- | --- |
| Database head equals the floor | `ok` | Normal. |
| Database one entry ahead of the floor and it is the last intent's entry, or an intent with nothing behind it | crash | `repaired`: the missing journal and commit lines are written; nothing stops. |
| A last line cut short, or one line of junk after the last good one | crash | The torn line is ignored; the chain before it is intact. |
| Database head lower than the floor | `rollback` | The coin stops: `rollback-detected` (503). |
| Another hash at the floor's index, or a journal of another history | `conflict` | The coin stops: `checkpoint-conflict` (503). |
| A line in the middle that does not match its sum | `checkpoint-corrupt` | The coin stops: `checkpoint-corrupt` (503). |
| No checkpoint yet for an existing coin | `adopted` | The database's own head is recorded (see section 9). |

A stopped coin refuses new transfers, proposals, approvals and mirrored entries that are not replays of the lost history. It is shown
to wallets and scanners as `frozen` (the database row is not changed). Reads, receipts and history stay readable.

## 4. Single authority and multi authority

**Single authority.** The checkpoint is the only second record, so it is what the domain stops on. The recovery is section 6.

**Multi authority.** The partner domains hold full copies of the log, so they are an independent source of the lost entries:

- A rolled back authority is stopped by its own checkpoint, and `restore` also asks the roster domains for the missing entries
  (`peer_restore_from_partners`). Entries arriving that way pass the same checks as any mirrored entry, and the authority's signature on
  each one is checked again.
- A rolled back partner heals through catch-up from the authority; when it again holds its floor entry the guard writes `restored`.
- A partner that has already frozen the coin on evidence of the authority's rollback (`rollback` evidence) runs it again with `resume`
  once the authority is restored: `peer_resume_after_rollback` requires that the coin is frozen only for rollback evidence, the guard is
  not stopped, `ledger_check` is clean, and the domains state the same history. A fork, an authority that signed two entries for one
  index, an invalid history, or an accepted loss never qualify.

Single and multi coins are judged independently on one database: each coin has its own files and its own verdict, and a stopped coin
does not stop the others.

## 5. Backups and crashes

- Use `VACUUM INTO 'file'` (or the SQLite backup API) for a backup of a live ledger. Do not copy `chain34.sqlite` while the domain is
  serving; a file copied mid-write can be a database that was never a state the domain was in. The test takes a `VACUUM INTO` copy and the
  copy passes the checker.
- The database uses SQLite's default rollback journal. A power cut mid-commit is recovered by SQLite itself, and the guard sees
  either the old head (the intent line is dangling, so it is a crash, not a rollback) or the new one (the commit line is repaired).
- A restored backup is, by definition, older than the checkpoints, so it is reported as a rollback. That is intended. Restore it only to
  an offline domain, then follow section 6.
- Back up the checkpoint folder together with the database, but remember that putting both back is exactly what section 8 cannot detect.

## 6. Recovery: what the operator does

Every recovery step is an operator action on `spend34.php` (the existing operator token). None of them brings back spent funds.

1. `integrity` (`coinId`): reads the verdict without changing anything, with both heads (the floor and the database's).
2. `restore` (`coinId`): replays the journal through the normal entry checks, in order, from the database's head up to the floor, and,
   for a multi coin, pulls what is still missing from the roster domains. The head must end exactly at the floor with the same hash;
   when it does, the guard writes `restored` and the coin runs again. Running `restore` on a coin that is not stopped does nothing.
   Putting back a newer copy of the database (one that holds the floor entry) has the same effect without any action.
3. If the entries cannot be replayed (the journal is gone and no partner has them), the loss is real. `accept-rollback`
   (`coinId`, `reason`, `confirm: { floorIndex, floorHash, databaseIndex }`) records that the operator accepted it. The confirmation
   must repeat the figures `integrity` showed. The coin is frozen with `rollback-accepted` evidence listing the lost entries and stays
   stopped for good. Nothing un-freezes it: the lost spends cannot be told apart from balances that were spent once, so putting the
   database's balances back in use would be the resurrection this guard exists to prevent. The way on is a new coin and a migration of
   balances decided by the operator from the evidence.
4. `reseal` (`coinId`, `confirm: { databaseIndex, databaseHash }`): for damaged checkpoint files only. The database must pass the
   checker, the journal must not be beyond the database's head, and the confirmation must match the database's head. The damaged files
   are set aside (`*.damaged-<time>`) and a new log begins with a `reseal` line at the database's head.
5. `resume` (`coinId`): for a partner that froze on rollback evidence, as in section 4.

Wallets that saw the coin before the rollback keep their mark until the domain shows the kept entry again (section 7).

## 7. What the wallet keeps

The signed holdings statement carries, per coin, the index and hash of the newest entry (`headIndex`, `headHash`). The wallet keeps the
highest verified one per domain and coin in the domain's record (`heads`, so it is part of the wallet backup). Each later statement is
compared:

| Statement | Result |
| --- | --- |
| Higher index | The kept head moves up. When the domain can answer `GET head&coin=…&index=<kept index>` the wallet also checks that the same history passes through the kept entry. |
| Same index, same hash | Nothing changes, and a mark from an earlier lower statement is cleared. |
| Lower index | `rollback-suspected`: the coin is marked, the kept head does not move. |
| Same index, another hash (or the domain's own attestation names another hash there) | `history-conflict`. |
| A coin that was listed and no longer is | `coin-missing`. |
| A statement dated before the kept head | Ignored: it is old, not a rollback. |

A marked coin takes no send and no purchase: the wallet refuses before anything is signed, and the tab says what was trusted and what
is seen now. The mark clears when the domain shows the kept entry again on the same history (after a `restore`), or when the person
chooses "Trust what it says now" (`acceptHead`), which replaces the kept head with what the domain now states. A wallet that has never
seen the coin takes the first head it is shown (trust on first use).

## 8. What a same-account checkpoint does not do

The checkpoint is on the same hosting account as the database. It stops an accident, a stale backup restored by mistake and a lazy
restore. It does not stop an operator who can put back both the database and the checkpoint folder: the test "lost checkpoint
folder" shows exactly that, and the coin simply adopts the old head. The same holds for a host that snapshots the whole account.

What would stop that is a witness that the operator cannot rewrite. An independent witness has to:

1. Hold signed heads: `atlas.ledger.head` statements (coin, domain, index, hash, time) signed by the domain's key, collected on its
   own schedule and stored where the operator cannot edit them (another account, another party, or the wallets themselves).
2. Keep the highest index it has seen per coin and domain, append-only, and compare every later head: a lower index, or another
   hash at an index it already holds, is evidence. The signature on the earlier head is the proof; the operator cannot deny it.
3. Be reachable by wallets and partners without the operator's permission: they ask the witness, or each other, before they trust a
   statement.
4. Not accept a new head for a coin from the operator's say-so alone: the head must carry the domain's signature and, for a multi coin,
   the authority's signature on the entry.

Today the wallets already play that part for the coins they hold (section 7), and so do the partner domains of a multi coin. A single
authority coin that nobody holds a wallet record for has no independent witness. Publishing the head to a party that is not the
operator (a roster partner that mirrors a single coin, a public append-only log, or a second hosting account polling `GET head`) is the
step that closes this, and is a design decision for the operator rather than a change to the ledger.

## 9. Compatibility

- No SQLite schema change. Existing coins, balances, wallets and entries are untouched.
- An existing coin adopts its head the first time it is used after this is deployed (trust on first use). From then on it is
  protected; a rollback that happened before that cannot be seen.
- The checkpoint folder is created beside the database on first use, so the private folder must be writable by the web user. When it is
  not, `checkpoint-unavailable` (503) is returned and nothing commits; fix the permission rather than disabling the guard.
- The journal doubles the log's storage (one extra copy of each entry).
- Wallets: the domain records gain a `heads` property. Older wallets ignore it, and older wallets keep working against the new domain; only
  the new wallet refuses on a rollback. The wallet reads the optional `index` of `GET head`; a domain that does not have it returns
  the newest head and the wallet treats the answer as unknown.
- New responses: `rollback-detected`, `checkpoint-conflict`, `checkpoint-corrupt` and `checkpoint-unavailable` (503); `not-halted`,
  `confirm-mismatch`, `not-damaged`, `database-invalid`, `entries-missing`, `not-frozen` and `not-resumable` (409); `reason-needed` (400).
- Not covered: tables that are not part of the entry log (for example `ledger_purchases`) are not journaled, so a restore of an older
  database does not bring them back through `restore`; they travel with the database backup.

## 10. Checks

```
php test/chain-labs-rollback.php          # the guard in the library: rollback, crash, conflict, corruption, recovery, multi authority
node test/chain-labs-rollback-http.js     # the same against the real endpoint and a killed server
node test/chain-labs-wallet.js            # includes the wallet's kept heads
```
