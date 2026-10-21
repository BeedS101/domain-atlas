# Gen1: the revocation list is never recreated empty

A revocation list that has gone missing used to be replaced by an empty one, on both issuers, the first time anything
asked for it. Every credential spent or revoked up to then became spendable again, and transaction recovery read the
missing list as "nothing was committed" and deleted its own journal entries. This describes the correction.
Context: `docs/gen1-php-deployment-checklist.md`, `docs/gen1-fungible-safety-fixes.md` (section 1.3).

## 1. Where the list is created

Only when the issuer key is generated, and only if nothing shows the deployment was ever used.

| Step | Node (`issuer-server/server.js`) | PHP (`issuer-php/lib/store.php`) |
|---|---|---|
| Key does not exist, so a new issuer is being created | `loadOrCreateKeypair()` | `load_or_create_keypair()` |
| Evidence check | `establishedIssuerEvidence()` | `atlas_established_issuer_evidence()` |
| List created, before the key | `initialiseRevocationsForNewIssuer()` | `atlas_initialise_revocations_for_new_issuer()` |
| No-clobber create | `createFileNoClobber()` | `atlas_create_file_no_clobber()` |
| List missing afterwards | the server starts, logs `REVOCATION LIST MISSING`, and does not create it | `ensure_well_known_files()` answers 503 to the request |

Evidence that the deployment has been used, any one of which withholds the list:

- a published `atlas-*.json` in `.well-known/` (key document, suspensions, reviewer key, or the list itself);
- an `atlas-*.json` state file in the state folder (`ATLAS_STATE_DIR` for Node, `lib/` for PHP), such as a mail,
  subscriber, ledger, recovery or class-patch store. These do not count: files an operator places by hand before
  the first start (`*-config.json`, the admin roster, `atlas-trusted-trade-peers-store.json`,
  `atlas-federation-blocklist.json`) and stores that sign-in and throttling create before anything is issued
  (`atlas-admin-*`, `atlas-login-nonces-store.json`, `atlas-mail-nonces-store.json`,
  `atlas-federation-relay-rate-store.json`, `atlas-calendar-store.json`, `atlas-visits-store.json`);
  A zero-length file is not evidence either (a store creates one when it is first read; it holds nothing);
- the reviewer private key;
- anything in `replay/`, `holdings/` or `txn/` (dotfiles such as `.htaccess` do not count), including the
  `atlas-private-dir.txt` folder and `lib/` for PHP;
- a folder that cannot be read (it cannot be shown to be empty).

A key that has just been generated is therefore not enough. When evidence is found the key is still generated, no
list is created, and the issuer behaves as in section 2 until the list is restored. A list that already exists is
never touched, whatever it holds.

The list is created with a temporary file that is flushed and then linked into place, so a reader sees no file or
the whole file, and a file that is already there is never replaced (a file system without hard links falls back to
an exclusive create). The list is created before the key: a crash in between leaves a valid empty list and no key,
and the next start generates the key. Two processes starting together end with one list and one key; the later one
uses the key the first wrote. The key file is now created mode 0600 on both issuers (Node used the default 0644).

## 2. When the list is not usable

Missing, unreadable, not valid JSON, no `revoked` array, or any entry that is not an object with a non-empty string
`id` (the rule the wallet already applies to the published list):

| Operation | Result |
|---|---|
| every operation that reads the list (all go through one reader per issuer): split, consolidate, convert, redeem, transfer, purchase, trade, drop and file claims, mail check, membership lookups | 503, nothing written. The suite exercises the first five and a re-presented spent credential; the rest share the reader |
| a credential that was spent before the loss | 503, not "valid" and not "already revoked" |
| ledger issuance and receipts | 503 `revocations-unavailable` |
| PHP, any request that loads the keys | 503 |
| Node, routes that do not consult revocations | may still be served |
| transaction recovery (sweep, retried request, `txn-recover`) | cannot settle: the journal entry, the holdings index and the replay records are left exactly as they are, and recovery finishes when the list is back |

The file is never written to by any of this. Nothing guesses what was revoked.

`revokeMany` / `atlas_revoke_many` also refuse to write an entry whose id is not a non-empty string, so the issuer
cannot produce a list it would itself refuse.

## 3. If an established issuer has lost its list

1. Do not start anything that writes. Restore `.well-known/atlas-revocations.json` from the newest backup.
2. Compare it with the current state: `php lib/atlas-cli.php counts`, `node tools/gen1-fungible-audit.js` with
   `--revocations` and `--revocations-backup`. Spends made after that backup are not in it; there is no way to
   recover them automatically, and the code does not try.
3. If there is no backup at all, the old revocation history is gone. Whether to start a new epoch (retire the old
   issuer key and re-issue) is a decision for the operator, not something the issuer does.

## 4. Compatibility

- An existing deployment has its key and its list, so nothing is created or rewritten when it is upgraded.
- A development checkout that deletes only the list (or only `.well-known/`) and keeps `issuer-private-key.*` now
  gets a 503 instead of a clean slate. To start over, delete the key, the published documents and the state folders
  together; `test/manual-museum-ticket-stall.js` and `test/manual-domain-identity-pin.js` do this.
- Node and PHP behave the same for every row in sections 1 and 2; the differences are only where the refusal
  appears (Node: per operation after a logged start; PHP: per request).
- Not changed: the suspensions list (still recreated when missing), key rotation and the published key document,
  mining rewards, holding limits.

## 5. A new issuer, and a wrongly withheld list

- The list is created by the first request that loads the issuer key, so on a new install let that be the first
  request (an ordinary issue, for example; static files and the read-only smoke test do not load it). A request that
  stores data before the key exists (for example a pending treasury approval) leaves state behind, and the next
  request that loads the key then sees a used deployment and withholds the list.
- If the issuer is genuinely new and the list was withheld that way, and you have confirmed that nothing was ever
  issued or spent on it, create `.well-known/atlas-revocations.json` containing exactly `{"revoked":[]}` (mode 644,
  owned by the PHP account) and the issuer starts working. Never do this for a domain that has ever issued
  anything: an empty list makes every spent credential spendable again.

## 6. Upgrading a live PHP issuer

1. Back up before touching anything: `.well-known/` (all of it), `lib/issuer-private-key.pem`,
   `lib/reviewer-private-key.pem` if present, every `lib/atlas-*.json`, `lib/atlas-private-dir.txt` and the folder it
   names, and `lib/replay/`, `lib/holdings/`, `lib/txn/`. Record the entry count and `sha256sum` of
   `.well-known/atlas-revocations.json` (`php lib/atlas-cli.php counts` shows the count).
2. Check the list is present and valid now: `php lib/atlas-cli.php preflight` must not FAIL on it. If it is already
   missing, do not upgrade yet: see section 3, restore it from the newest backup first. The upgrade cannot restore it
   and does not create one for an established domain.
3. Upload `lib/*.php`, then `atlas/` (same order and exclusions as `docs/gen1-php-deployment-checklist.md`
   section 2). The files that change in this fix are `lib/store.php`, `lib/atlas-cli.php`, `lib/ledger-issuance.php`
   and `lib/ledger-receipts.php`. Nothing else is rewritten, and no state file is created, changed or deleted by the
   upgrade.
4. `php lib/atlas-cli.php preflight --write-probe`, then `node tools/gen1-php-smoke.js https://your-domain
   --baseline before-your-domain.json`. The count and `sha256sum` of the list must match step 1 until a real spend
   happens.
5. Rollback: put back the previous `lib/*.php` and `atlas/` files (run `php lib/atlas-cli.php txn-list` first and
   `txn-recover` if it lists entries). State files need no rollback. Never restore an older revocation list over a
   newer one.

## 7. Tests

`node test/manual-gen1-revocation-state.js [node|php|both] [--only=S3]`

| | |
|---|---|
| S1 | a new issuer gets a valid empty list, a 0600 key, no temporary files |
| S2 | an established issuer restarts with its list and key byte-identical; a spent credential is still refused |
| S3 | the list is deleted: every operation 503, nothing recreated, journals and holdings untouched, restart too; restoring the backup revokes the spent credential again |
| S4 | the list cannot be read (mode 000 under an unprivileged account; a directory in its place) |
| S5 S6 | malformed JSON, wrong shapes, and eight kinds of invalid entry: 503, bytes untouched |
| S7 | restart after the whole `.well-known/` was replaced, twice |
| S8 | a pending transaction (uncommitted, and committed with the journal still present) meets a missing list: journal, holdings and replay untouched; with the list restored the same request completes once |
| S9 | nine kinds of evidence withhold the list; configuration files, zero-length stores and an empty protected folder do not |
| S10 | the key was lost with the rest of the deployment: a new key brings no list |
| S11 | a crash while the list is being created; a list that already exists is kept when the key is generated |
| S12 | simultaneous first starts (16 PHP requests; two Node processes) |
| parity | the statuses from S3, S5 and S6 are compared between Node and PHP |
