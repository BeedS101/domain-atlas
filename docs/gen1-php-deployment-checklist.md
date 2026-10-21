# Gen1 PHP issuer: deployment checklist

For an existing PHP domain (`issuer-php/`) that already has an issuer identity, revocation history and issued
credentials. Nothing here resets, migrates or reconciles balances, and nothing needs the issuer key to change.
Read `docs/gen1-fungible-safety-fixes.md` first for what the code does; this file is the order of work.

Do every step on one domain, finish its checks, and only then start the second.

## 0. What the check tools are

| Tool | Where it runs | What it does |
|---|---|---|
| `php lib/atlas-cli.php preflight` | on the host (SSH or the cPanel terminal), as the account that runs PHP | Read-only. Checks the PHP version and extensions, that every file of this release is present, that the issuer key matches the published key, that the revocation list is valid (entry count, size, hash), which directories are writable, where private state lives, and whether the journal has pending entries. `--write-probe` also creates and removes a uniquely named file in each directory the issuer writes to. |
| `php lib/atlas-cli.php counts` | on the host | Revocation entry counts (total, distinct, tagged) and an inventory of the state files, without printing any credential or key. |
| `php lib/atlas-cli.php txn-list` | on the host | Pending journal entries, ids only. |
| `php lib/atlas-cli.php txn-recover [--force]` | on the host | Settles pending entries, which is what the next request would do anyway. |
| `node tools/gen1-php-smoke.js https://your-domain` | any computer with Node 18+ | Over HTTP: public documents are served; every private path answers 403/404 and returns nothing that looks like a key or credential; with `--baseline` it proves no revocation entry was lost or changed. `--mutating` additionally does an issue / split / consolidate of 10 Iron for a throw-away key. |

The CLI refuses to run under a web server. It never creates, replaces or deletes the issuer key, the published key
document or the revocation list.

If the host has no shell, the HTTP checks in section 4 can be done by hand in a browser, and the revocation count by
opening `/.well-known/atlas-revocations.json`.

## 1. Before you upload anything

1. **Back up (download a copy off the host):**
   - `.well-known/atlas-key.json`, `.well-known/atlas-revocations.json`, `.well-known/atlas-suspensions.json`
   - the whole `lib/` folder, including `issuer-private-key.pem`, every `atlas-*-store.json`, `*.lock` files and
     any `replay/`, `holdings/`, `txn/` folders (the old code created none of them)
   - the whole `atlas/` folder (the current endpoint files, for rollback)
   - `lib/atlas-private-dir.txt` and the folder it points to, if you already use one
   - the issuer private key must be kept somewhere that is not the same place as the rest of the backup. It signs
     every credential; losing it means a new identity, and an old copy of the revocation list is not a substitute.
2. **Record the starting point.** Open `/.well-known/atlas-revocations.json` and note the number of entries and the
   file size. If you have a shell on the host, also run the first of these (the CLI is not installed yet on a domain
   that has never had this release, so skip it then):

   ```
   php lib/atlas-cli.php counts
   ```

   From any computer, this saves a baseline of the public list and keys:

   ```
   node tools/gen1-php-smoke.js https://your-domain --save-baseline before-your-domain.json
   ```

   It is read-only. Keep the file; section 6 compares against it.
3. **Check the PHP version.** 7.0 or newer works. 8.1 or newer also syncs the temporary file to disk before the
   rename (`fsync`); on older versions the preflight shows a WARN, the code still works, and only a power cut at
   the wrong moment can lose the last write.
4. **Do not deploy during a busy period.** Wallets retry on a 503, so a short window is safe, but there is no reason
   to overlap with mining or trading.

## 2. What to upload

Upload the contents of `issuer-php/` so that `lib/` sits directly inside the web root, next to `.well-known/` and
`atlas/` (the issuer finds the web root as the parent of `lib/`).

**Upload (source files only):** every `*.php` file under `lib/` and `atlas/` (including the new `lib/atlas-cli.php`,
`lib/replacement.php`, `lib/store.php`, `lib/bootstrap.php`), `lib/.htaccess`, `atlas/.htaccess`,
`.well-known/.htaccess`, and `atlas-admin/index.html`.

**Never upload or overwrite:**

- `lib/issuer-private-key.pem`, `lib/reviewer-private-key.pem`
- any `lib/atlas-*-store.json`, `lib/atlas-recovery-secret.json`, any `lib/*.lock`
- `.well-known/atlas-key.json`, `.well-known/atlas-revocations.json`, `.well-known/atlas-suspensions.json`,
  `.well-known/atlas-reviewer-key.json`
- `lib/atlas-private-dir.txt` and the folder it names; `lib/atlas-ledger-issuance-config.json`,
  `lib/atlas-ledger-receipts-config.json`
- `lib/replay/`, `lib/holdings/`, `lib/txn/` (leave whatever is there)
- `test-router.php` (development only) and `README.txt` (harmless, but not needed on the host)

If your upload tool replaces whole folders, upload files, not folders, or exclude the state files above.

**Order.** Upload all of `lib/` first, then `atlas/`. A half-finished upload is safe in this order: the older
endpoints keep working against the new `lib/` (tested), and a request that cannot work fails with a 500 or 503
before anything is spent. The reverse order (new endpoints before the new `lib/`) fails every spend until `lib/`
arrives, and nothing is spent. Do not leave it half-done: finish the upload, then run the preflight.

## 3. Directories and permissions

These are the minimum. Do not use 777 anywhere.

| Path | Needs | Why |
|---|---|---|
| `.well-known/` | directory writable by the PHP account (typically 755 when you own it on cPanel with suPHP/FastCGI/PHP-FPM) | the revocation list is replaced by writing a temporary file in this directory and renaming it over the list. If it is not writable, spends answer 503 and change nothing. There is no in-place fallback. |
| `.well-known/atlas-revocations.json` | readable by the web server; keep its current mode (644 is normal) | a replacement keeps the mode of the file it replaces. The file itself need not be writable by PHP, because the new list is written as a separate file in `.well-known/` and renamed over it; the directory is what must be writable. |
| `lib/` | writable by the PHP account (755 if the account owns it) | new state files, lock files and the three private directories are created here |
| `lib/replay/`, `lib/holdings/`, `lib/txn/` | created by the issuer on first use as 0700, files 0600; each gets its own deny-all `.htaccess` | the replay records and journal contain signed bearer credentials |
| `lib/issuer-private-key.pem` | 600 (or 640 at most); never changed by the release | |
| `lib/*.lock` | created on demand (0644); a lock file only needs to exist and be lockable by the PHP account | `atlas-spend-lock-N.lock`, `atlas-rid-lock-N.lock`, `atlas-holdings-lock-N.lock`, `atlas-revocations.lock` |
| `atlas/` and everything under it | readable, not writable by PHP | endpoint code is never written at runtime |

`php lib/atlas-cli.php preflight --write-probe` states which of these are writable for the account you are running as.
On a host where the web server runs PHP as a different account than the shell, a PASS there means "writable for
my shell account". If the two differ, rely on the smoke test in section 5, which goes through the web server.

Existing files keep their mode when they are replaced. New files created by this release use 0644 in `.well-known/`
(they are public) and 0600 in the private directories.

## 4. Keep private state private

The replay records and the journal contain signed credentials. Three layers apply, and the first two cost nothing:

1. `lib/.htaccess` denies all web access to `lib/` (Apache 2.4 and 2.2 syntax). If an upload tool leaves dot-files
   out, the first request writes the file back.
2. `replay/`, `holdings/` and `txn/` each get their own deny-all `.htaccess` when the issuer creates them.
3. **Preferred when possible: move the three folders outside the web root.** Create a folder above the web root
   (for example `/home/youraccount/atlas-private`, mode 700, owned by the PHP account) and put its absolute path
   alone on one line in `lib/atlas-private-dir.txt`. Do this before the first mutating request after the upgrade
   and do not change it later; the issuer never falls back to `lib/` when this path is wrong, it answers 503. The
   issuer key and the existing `atlas-*-store.json` files stay in `lib/` (their location does not change), so
   `lib/.htaccess` still matters.

If the host does not honour `.htaccess` (some nginx-only hosts), layers 1 and 2 do nothing. The HTTP check below
tells you; the preflight cannot.

**Verify over HTTP (from any computer), each of these must answer 403 or 404, never 200:**

```
https://your-domain/lib/issuer-private-key.pem
https://your-domain/lib/atlas-mail-store.json
https://your-domain/lib/bootstrap.php
https://your-domain/lib/
https://your-domain/lib/replay/
https://your-domain/lib/holdings/
https://your-domain/lib/txn/
https://your-domain/lib/atlas-cli.php
```

`node tools/gen1-php-smoke.js https://your-domain` does these and more, and also fails if the body of an answer
looks like a key, a signature or PHP source. If any of them answers 200, stop: move the private folders outside the
web root with `atlas-private-dir.txt`, and ask the host to deny `lib/`.

## 5. Deploy and check, step by step

1. Upload `lib/` (section 2), then `atlas/`.
2. `php lib/atlas-cli.php preflight --write-probe`. Resolve every FAIL. A WARN is acceptable only if you understand
   it (for example, the fsync note on PHP older than 8.1). The things it must report:
   - the published key document lists the public key of `lib/issuer-private-key.pem` (same identity);
   - the revocation list is valid and has **at least** the entry count you recorded;
   - every endpoint file is the journal version;
   - `lib/.htaccess` is present;
   - no pending journal entries.
3. Read-only HTTP check against the live domain:

   ```
   node tools/gen1-php-smoke.js https://your-domain --baseline before-your-domain.json
   ```

   It must report no lost entries, the first N entries identical, and every earlier published key still published.
4. Confirm the revocation count. `php lib/atlas-cli.php counts` and the public file should agree, and the number should
   be the one you recorded plus only spends made since.
5. **Safe smoke test (optional, adds data).** `node tools/gen1-php-smoke.js https://your-domain --mutating`
   issues 10 Iron to a throw-away key, splits, consolidates, repeats each request to prove it returns the identical
   signed answer, and checks that exactly three revocation entries were added with transaction tags. It leaves three
   revocation entries and some holdings records for the throw-away key. It does not touch Gold, Platinum, Post Office
   credentials or ledger data. Run it once per domain, not as a monitor.
6. Ordinary wallet check: open the wallet, view existing Gold/Platinum and a Post Office service, make one small
   split or conversion with a test amount, and confirm the balances shown by the wallet are unchanged apart from
   that action.

## 6. Existing state is preserved

The release does not touch these; the tests start from a domain that has them and compare after an upgrade from the
earlier versions:

- the issuer key, the reviewer key and the published key documents (byte-identical);
- every revocation entry, in order (a past entry is never removed or rewritten; new spends add tagged entries);
- credentials signed before the upgrade (Gold, Platinum, memberships, Post Office), which still verify and still
  spend;
- the Post Office roster and mail stores, ledger receipts and issuance configuration, admin and class-patch stores;
- a request answered by the previous version is answered identically after the upgrade.

Do **not**, as part of this deployment: reset or reconcile balances, delete or rebuild revocation records, rotate
domain keys, or move anything to another system. The holdings index is built from what the issuer has signed for each
owner and from credentials wallets present; it is not a balance migration.

If the preflight says a key file or the revocation list is missing on an existing domain, do not run anything else:
restore it from your backup. The code refuses to create a new identity for a domain that already has a published
one (it answers 503). It creates a revocation list only together with the key of a new issuer, and only when
nothing shows the domain was ever used; a list that is missing, unreadable or invalid is never replaced, and every
request answers 503 until it is restored (`docs/gen1-revocation-state.md`).

## 7. Watching after deployment

- The revocation count should only grow, by spends.
- `lib/txn/` (or the configured private folder) should be empty between requests. A file that stays means a
  decided transaction waiting for a retry or an inspection. `php lib/atlas-cli.php txn-list` shows it and
  `txn-recover` settles it.
- 503 on a spend: the revocation list is missing, unreadable or invalid, `.well-known/` is not writable, or the
  private folder is wrong. The server's PHP error log names the cause. Restore the list from backup if it is
  damaged or gone. Do not recreate it by hand as an empty list: that makes every spent credential spendable.
- 400 with `code: "busy"`: two requests for the same credential collided or a lock could not be taken. The wallet
  retries; nothing was spent.

## 8. Recovery precautions and rollback

- **Interrupted request.** A crash between the steps of a spend leaves a journal entry. The same request (same
  `requestId`) when retried, or the next replacement or issue on that domain, or `txn-recover`, finishes it and
  returns the same signed result. Before the revocation list is replaced, nothing is spent; after, the result is
  complete. Stale temporary files (`atlas-revocations.json.<12 hex>.tmp`) from a killed process are removed
  automatically; only files with that exact name pattern.
- **Unreadable or inconsistent journal entry.** Recovery does not guess. It reports the entry and leaves it. Look
  at `txn-list`; if the entry is damaged and the revocation list does not record it, restoring the entry from
  backup is safe; deleting it by hand is not, because it may be the only record of a result already committed.
- **Failed write of the revocation list.** The original file is untouched (the temporary file is a separate file and
  is removed); the request answers 503.
- **Rollback.** Put back the `atlas/` and `lib/*.php` files from your backup. The new `replay/`, `holdings/` and
  `txn/` folders and lock files are inert and can stay. **First** make sure `txn/` is empty: run
  `php lib/atlas-cli.php txn-list` and, if it lists entries, `txn-recover` before rolling back, because older code
  does not read the journal. Never restore an old revocation list over a newer one: spends made since the backup
  would become spendable again.
- If you used `atlas-private-dir.txt`, keep the file and the folder when rolling back; the older code ignores them.

## 9. Known limits

- The `.htaccess` effect is checked by emulation in the test suite and over HTTP on the live host (section 4); it was
  not tested against a real Apache here.
- `flock` on a network file system (some NFS set-ups) may not exclude other servers. Single-server shared hosting is
  fine.
- Power loss between the rename and the disk flush is not tested; `fsync` is used only on PHP 8.1+.
- Every spend adds an entry (about 22 percent larger with the transaction tag). The wallet reads at most 4 MiB or
  20,000 entries of the list. The preflight shows the current percentage and warns at 80 percent. Plan how to handle
  growth before it gets there; do not truncate the list.
- Under mod_php where several accounts share one PHP user, the private folders are only as private as the host's
  account separation. Moving them outside the web root helps against HTTP exposure, not against other accounts.
