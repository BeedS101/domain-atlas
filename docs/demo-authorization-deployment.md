# Demo-route authorization: PHP deployment

Deploys the owner-consent / demo-authority checks on the self-serve `/atlas/demo/*` routes
(cafeteria, login, clawback, warranty) to an existing PHP domain. Code only: no key, revocation
list, suspension list or store file is replaced, and split, consolidate and convert stay disabled.

Do one domain completely (sections 1–5), then the second.

## 1. The release: 15 files, uploaded together

Paths are relative to the web root (where `lib/`, `atlas/` and `.well-known/` sit). The pages go on
the same domain as the PHP files they call: every page calls its own origin.

| File | Status | SHA-256 before (first 16) | SHA-256 after (first 16) | Bytes after |
|---|---|---|---|---|
| `lib/demo-authority.php` | new | — | `0a7c8523a0420a8f` | 4220 |
| `lib/store.php` | changed | `7679bc2c15128a34` | `34a70a4d03ecdaac` | 241605 |
| `atlas/demo/clawback/mint.php` | new | — | `6f282b315e0d39b6` | 1993 |
| `atlas/demo/clawback/suspend.php` | changed | `6396ae33d350107c` | `d1831732082708f3` | 2074 |
| `atlas/demo/clawback/unsuspend.php` | changed | `e27662a11f1cf047` | `f5a4440d91a6e4bb` | 2073 |
| `atlas/demo/clawback/clawback.php` | changed | `b8e86f93466a6271` | `3b27930af9b9f344` | 2772 |
| `atlas/demo/cafeteria/fulfill.php` | changed | `d1c456d6f246f94c` | `46d0f9d4df1ca097` | 1507 |
| `atlas/demo/login/revoke.php` | changed | `b2d619cd7a5f9e39` | `3b4648bf30403339` | 1746 |
| `atlas/demo/warranty/mint.php` | changed | `0715ebe50d67c7d5` | `d05f71078bebd3d2` | 2015 |
| `atlas/demo/warranty/stamp-sale.php` | changed | `d84b5ce6f93cabca` | `badfb6682bec2619` | 3264 |
| `cafeteria-demo.html` | changed | `d620d0377bd46b42` | `f7f4136339c9ad66` | 16571 |
| `clawback-demo.html` | changed | `f8b0a20057963896` | `5823f2960c08799d` | 27898 |
| `login-demo.html` | changed | `9324103da1bae778` | `5bcbaedd28e6bd3b` | 16644 |
| `reserve-bank-demo.html` | changed | `a9991d32c3af109e` | `b1da5cad78e494d2` | 54669 |
| `warranty-demo.html` | changed | `a4e798096f599c03` | `9de50539cd5eaad7` | 26405 |

"Before" is the release that disabled split, consolidate and convert. If a live file's hash is not
the "before" value, stop: the host is on a different version, and uploading this `store.php` would
also bring every change in between. All files are LF; upload in binary mode so the hashes match.

On Windows: `certutil -hashfile <file> SHA256` (compare the first 16 hex characters).

Nothing else changes: no other `lib/` file, no `.htaccess`, no admin panel, no wallet extension (it
never calls these routes). `issuer-server/` and `test/` are not uploaded to a PHP host.

## 2. Directories and permissions

None new. `atlas/demo/clawback/` already exists and only gains `mint.php`. New files get the same
mode as their neighbours (644). The demo routes write `.well-known/atlas-suspensions.json` in place
under `flock`, exactly as the existing admin suspend does, so the existing permissions are enough.
`lib/demo-authority.php` is covered by the existing deny-all `lib/.htaccess`; confirm
`https://<domain>/lib/demo-authority.php` answers 403 or 404.

## 3. Back up, then upload

Back up (download, per domain, into a folder named for the domain and the date):

- the 13 existing files in the table, at their current paths;
- `.well-known/atlas-suspensions.json` and `.well-known/atlas-revocations.json`, for reference only.

Record: the revocation entry count and the suspension list (`--audit` below prints both).

Upload in this order, files not folders:

1. `lib/demo-authority.php`, then `lib/store.php`. The old endpoints keep working against the new
   `store.php` (the old demo suspend can then no longer touch Alpha or Beta Dollars).
2. The eight `atlas/demo/...` files. From here until step 3 the old pages' demo actions are refused
   (403 or 400); nothing is changed by a refused request.
3. The five pages.

Visitors with an old page open must reload it.

## 4. Rollback

Code only. Upload the backed-up 13 files over the new ones, then delete `lib/demo-authority.php` and
`atlas/demo/clawback/mint.php` (neither works with the old `store.php`). Never restore
`atlas-suspensions.json` or `atlas-revocations.json` from the backup: that would undo real spends and
suspensions made since.

Rolling back reopens the unauthenticated demo routes. Demo credentials minted under the new code
(`atlas.demo.clawback.funds`, `atlas.demo.warranty.selfserve`) stay valid signed credentials; the old
code does not know their classes, so they are inert.

## 5. Verification

`tools/demo-auth-live-check.js` (Node 18+, any computer):

| Mode | Changes | Purpose |
|---|---|---|
| `--audit` | nothing | suspensions by reason, every `demo-fraud-report` suspension, revocations the old demo routes could write |
| (no flag) probe | nothing | new routes deployed; real currencies, the factory warranty class and unsigned requests refused; split, consolidate and convert still disabled |
| `--mutating` | throw-away demo credentials, a few revocation entries | who may act, end to end; no pre-existing suspension changed |
| `--hold-for-admin f` then `--check-admin-lock f` | one demo funds block | demo routes leave an operator suspension alone |

Before uploading:

- [ ] Hashes of the 13 live files match "before".
- [ ] `node tools/demo-auth-live-check.js https://<domain> --audit` saved to a file.
- [ ] Probe run once: it should FAIL (old code). This confirms the tool sees the live routes.

After uploading:

- [ ] Hashes of the 15 live files match "after".
- [ ] `https://<domain>/lib/demo-authority.php` and `https://<domain>/lib/store.php` answer 403/404.
- [ ] `node tools/gen1-php-smoke.js https://<domain> --baseline before-<domain>.json` (read-only).
      Do not use its `--mutating` option: it splits and consolidates, which are disabled.
- [ ] Probe: ALL CHECKS PASSED (includes split, consolidate and convert still answering 403).
- [ ] `--mutating`: ALL CHECKS PASSED, including "every suspension that existed before is still
      there, unchanged" — this covers any trade locks and delivery holds in effect at the time.
- [ ] Operator lock: `--hold-for-admin hold.json`, suspend the printed id in the admin panel,
      `--check-admin-lock hold.json`, lift it in the admin panel, delete `hold.json`.
- [ ] `--audit` again: the same operator, trade-lock and delivery entries as before (plus any from
      ordinary activity), and the revocation count grew only by the checks.
- [ ] Pages, in a fresh browser tab:
  - clawback: mint, steal, report stolen, attempted sale blocked; then both endings (false alarm
    completes the sale; claw back revokes the stolen copy);
  - reserve bank: Act 7 (fraudulent transfer, then suspend and claw back). Acts 2 and 4 still fail
    because they use the disabled split; that is expected;
  - warranty: mint, stamp a recent sale (Active), restamp a lapsed one (Expired), transfer,
    full history;
  - cafeteria: top up, buy, collect;
  - login: sign in, revoke, sign-in fails at the second factor.
- [ ] The PHP error log has no new entries.
- [ ] One ordinary wallet action unrelated to the demos (view balances, one transfer) behaves as before.

Then repeat sections 3–5 on the second domain.

## 6. Previously minted demo credentials

- **Warranty certificates from the old demo route** are `atlas.demo.warranty.certificate`, the same
  class the admin mint uses, and the old route let any visitor set any property on them (serial,
  sale date, retailer). They still verify, transfer and show their history, but they cannot be
  stamped through the demo any more, and their contents were never vouched for. If no certificate
  was ever minted through the admin panel, every live one of this class came from the old demo route.
- **Demo recovery tokens minted before** carry no demo authority, so the demo routes refuse them;
  they stay ordinary valid credentials. The pages keep keys only in memory, so no visitor can resume
  an old session anyway.
- **Old demo suspensions** (`demo-fraud-report`) on Alpha or Beta Dollars can no longer be lifted by
  a demo route; review the `--audit` list and lift any unjustified one in the admin panel.
- **Old demo clawbacks** of Alpha or Beta Dollars: the old route reissued a credential to any key the
  caller named. Review `clawback` revocations in the audit against the admin's own clawbacks.
- **Cafeteria items and login badges** issued before still work; redeeming or revoking now needs the
  owner's signature, which the pages provide.
