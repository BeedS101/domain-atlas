# Multi-Domain Transaction Authorization Lab: deployment guide

**TEST DEMO, NO REAL CURRENCY.** A browser-based lab in which a 30.00 DEMO transfer from
Alice to Bob executes only after two independently keyed domains (`evtec.co.za`,
`domain-atlas.co.za`) each sign the same canonical transaction. It needs no wallet, no
Node process and no ledger integration, and it works on ordinary PHP shared hosting.

The lab is a new, isolated module. It adds files only; it modifies no existing file. It
has its own signing key, admin token, configuration and SQLite database in a private
directory, and it never reads or writes the issuer keys, stores, balances, reserve
bank, trading station or `.well-known` files. It stays **disabled** until every check
below passes.

## What it does, and what it does not claim

- Each roster domain signs `{txId, payloadDigest, approver, decision, approvedAtMs}` with its own
  P-256 key. The digest is sha-256 over the canonical payload (transaction id, origin domain, sender,
  recipient, currency `DEMO`, integer minor units, creation and expiry, quorum policy and roster,
  protocol version).
- Verifiers use public keys pinned in their own `config.php`. A key in a request is never trusted, so
  one domain cannot sign as another.
- One domain, the **settlement authority** (`evtec.co.za`), holds the demo accounts and executes
  once the policy is met. The policy is a threshold plus a list of **mandatory** domains: the
  settlement authority must always approve, so unrelated approvers can never override the domain that owns the
  ledger state. Roster, threshold and mandatory list come from configuration (2-of-2 now; 2-of-3,
  3-of-3 or 3-of-4 need only config changes on every domain).
- This is **not** atomic settlement across two independent ledgers. There is one ledger, owned by one
  domain, authorized by several. A cross-ledger design would need a separate prepare/commit/recovery protocol.
- Both domains run on one hosting account, which weakens real-world independence: PHP running as
  that account can read both private directories. The cryptography keeps the keys separate; the hosting does
  not. For genuinely independent domains, use separate hosting accounts.

## Files

New files only (nothing existing is overwritten):

| Source in the repo | Upload to `evtec.co.za` | Upload to `domain-atlas.co.za` |
| --- | --- | --- |
| `issuer-php/txlab/api.php` | `txlab/api.php` | `txlab/api.php` |
| `issuer-php/txlab/inc/txlab.php` | `txlab/inc/txlab.php` | `txlab/inc/txlab.php` |
| `issuer-php/txlab/inc/.htaccess` | `txlab/inc/.htaccess` | `txlab/inc/.htaccess` |
| `issuer-php/txlab/inc/private-dir.php.example` | save as `txlab/inc/private-dir.php` (edit the path) | same, with that domain's own path |
| `issuer-php/txlab/tools/*` (optional, only if you can run PHP on the server) | `txlab/tools/` (with its `.htaccess`) | same |
| `demo-domain-a/txlab.html` | `txlab.html` (site root) | |
| `demo-domain-b/txlab.html` | | `txlab.html` (site root) |

The two `txlab.html` files are identical. The lab also needs the existing, unchanged `lib/crypto.php`
(the canonical-JSON and ECDSA helpers); both sites already have it from the issuer. If a site does not, upload
`issuer-php/lib/crypto.php` to `lib/crypto.php`. `.htaccess` files are hidden in cPanel File Manager: use
Settings, then "Show Hidden Files (dotfiles)", so they are included.

Document root here means the folder that holds `.well-known` and `atlas` (for example `public_html`).

## 1. Requirements (both domains)

- PHP 7.2 or newer with `pdo_sqlite`, `openssl` and `curl`. Check them in cPanel under "Select PHP Version" /
  "MultiPHP INI Editor". Each domain's `health` endpoint (below) names any missing extension and stays disabled.
- A directory **outside the web root** that PHP can write to (for example `/home/CPANELUSER/txlab-private-evtec`). If it
  is inside the web root, the lab refuses to start.
- Outbound HTTPS from each domain to the other. Use the final URL of each domain (no `www.` redirect and no
  http to https redirect), because redirects are not followed.

## 2. Generate each domain's own demo key (on that domain's side)

Never reuse the issuer's key. Generate a fresh one for each domain.

**With a PHP command line (cPanel Terminal or SSH), on the server:**

```
php ~/public_html/txlab/tools/txlab-admin.php keygen --dir ~/txlab-private-evtec --domain evtec.co.za
php ~/public_html/txlab/tools/txlab-admin.php keygen --dir ~/txlab-private-atlas --domain domain-atlas.co.za
```

(If both sites share one account, run each command with that site's own docroot path.)

**Without a server command line:** on your PC, with Node,

```
node issuer-php/txlab/tools/txlab-setup.js keygen --dir txlab-private-evtec --domain evtec.co.za
node issuer-php/txlab/tools/txlab-setup.js keygen --dir txlab-private-atlas --domain domain-atlas.co.za
```

then upload each folder to its domain's private location (outside the web root) and set `signing-key.pem` to
permission 600 and the folder to 700. The key was created on your PC, so delete the local copies afterwards.

Each command prints the **public key** and a one-time **admin token**, and writes `signing-key.pem`,
`public-key.txt` and `admin-token.sha256` (the hash only) to the private directory. Save each token in a password manager. It is
shown once.

## 3. Exchange the public keys

Public keys are not secret, but they must be copied exactly and checked. Copy `evtec.co.za`'s public key into
`domain-atlas.co.za`'s configuration and the other way round. As you own both sites, compare the printed strings
by eye in both places. After enabling, `https://DOMAIN/txlab/api.php?op=peers` confirms each side sees the other and that the key
it published matches the pinned one.

## 4. Write the configuration (outside the web root)

The same roster on both domains; only `--domain` and `--dir` differ.

```
php txlab-admin.php config --dir ~/txlab-private-evtec --domain evtec.co.za --settlement evtec.co.za \
  --threshold 2 --mandatory evtec.co.za \
  --roster "evtec.co.za=<EVTEC_PUBLIC_KEY>@https://evtec.co.za/txlab/api.php,domain-atlas.co.za=<ATLAS_PUBLIC_KEY>@https://domain-atlas.co.za/txlab/api.php"

php txlab-admin.php config --dir ~/txlab-private-atlas --domain domain-atlas.co.za --settlement evtec.co.za \
  --threshold 2 --mandatory evtec.co.za \
  --roster "evtec.co.za=<EVTEC_PUBLIC_KEY>@https://evtec.co.za/txlab/api.php,domain-atlas.co.za=<ATLAS_PUBLIC_KEY>@https://domain-atlas.co.za/txlab/api.php"
```

(`txlab-setup.js config ...` takes the same options.) The files are written **disabled**. Do not add
`--allow-insecure-http` on a live domain; it exists for the local tests and is only honoured for 127.0.0.1.

To add a third domain later, add it to `--roster` on every domain, raise `--threshold` if wanted, and re-run
`config`. Existing transactions keep the policy they were created with.

Then tell the web code where the private directory is: copy `txlab/inc/private-dir.php.example` to
`txlab/inc/private-dir.php` on each domain and set the absolute path, for example
`return "/home/CPANELUSER/txlab-private-evtec";`.

Permissions: private directory 700 and writable by the PHP account (the SQLite database and its journal files are
created there), `signing-key.pem` 600, `config.php` 600. A key that other accounts can read keeps the lab disabled.

## 5. Enable

In each private directory's `config.php`, set `'enabled' => true`, or re-run `config` with `--enable`. Then:

```
php txlab-admin.php check --dir ~/txlab-private-evtec
```

should print `OK: domain evtec.co.za, settlement evtec.co.za, 2-of-2 ...`. Without a command line, open the health URL.
Every problem (missing extension, private directory inside the web root, key readable by others, key not matching the
pinned public key, policy that does not require the settlement domain, `DISABLED` file, `enabled` not true) is listed there and
the lab refuses all other operations.

## 6. Verify isolation from the existing functionality

1. Compare the file listing before and after: only `txlab/` and `txlab.html` are new, and `lib/` gained nothing.
2. Open your existing pages and confirm they behave as before: the Reserve Bank demo, the trading station, the wallet.
3. The lab never touches `.well-known`, `lib/issuer-private-key.pem`, `lib/atlas-*-store.json` or any issuer state. Its only
   state is `txlab.sqlite` (plus its journal files) in the private directory.
4. Secrets are not served: these should answer 403 or 404, never file contents.
   `https://DOMAIN/txlab/inc/txlab.php`, `https://DOMAIN/txlab/inc/private-dir.php`, `https://DOMAIN/txlab/tools/txlab-admin.php`.
5. No response of `api.php` contains the token, its hash or the private key (the test suite checks this).

## 7. Live two-domain smoke test

Open these (health first):

1. `https://evtec.co.za/txlab/api.php?op=health` and `https://domain-atlas.co.za/txlab/api.php?op=health`:
   both `"enabled": true`; evtec.co.za is the `settlement-authority`.
2. `https://evtec.co.za/txlab/api.php?op=peers` and the same on domain-atlas.co.za: peer reachable, `keyMatches: true`.
3. `https://evtec.co.za/txlab.html`: unlock with evtec.co.za's token, choose alice to bob, 30, **Submit transaction**. Status
   pending, quorum 0/2.
4. `https://domain-atlas.co.za/txlab.html#tx=<the transaction id>`: the same transaction and digest appear. Unlock with
   domain-atlas.co.za's token and click **Verify & sign approval**. Quorum 1/2; evtec.co.za still shows pending and the balances are unchanged.
5. Back on `https://evtec.co.za/txlab.html`: click **Verify & sign approval**. Quorum 2/2, status executed, Alice 70.00, Bob
   30.00, a signed receipt, and every signature marked verified by the server and by the browser.
6. Run it again with bob to alice (30) to put the balances back. There is no public reset.

If step 2 reports the peer unreachable although both sites are up, the host may not allow a site to call itself or its
neighbour over HTTPS; the lab then stays pending or reports an explicit peer-unavailable error and never fakes success.

## 8. Disable and remove

- Kill switch: create an empty file named `DISABLED` in the private directory (or run `txlab-admin.php disable --dir ...`). All
  operations return 503 at once; delete the file to re-enable.
- Reset the balances and history (needs a command line, by design not exposed on the web):
  `php txlab-admin.php reset --dir ~/txlab-private-evtec --yes` on the settlement domain.
- Remove: delete `txlab/`, `txlab.html` and the private directory. Nothing else was changed.

## What each domain can and cannot do

| Operation | Who | Notes |
| --- | --- | --- |
| `op=health`, `roster`, `state`, `tx`, `peers` | anyone (read only) | `state` and `tx` on the approving domain are fetched from the settlement authority and re-verified with that domain's own pinned keys |
| `op=create` | settlement authority's admin token | `requestId` makes a repeat submit return the same transaction |
| `op=decide` | that domain's admin token | fetches the transaction, checks it against this domain's own policy, signs once with its own key, delivers it to the settlement authority |
| `op=submit-approval` | anyone, but only a decision signed by a roster key is accepted | every rejection is logged against the transaction |

The admin token is checked with a constant-time hash comparison; eight failures in five minutes lock admin actions for a
while. Amounts are integer minor units (3000 = 30.00). A transaction expires after 15 minutes (`ttlSeconds`).

## Tests

```
node test/manual-txlab-php.js       # two PHP servers (plus a three-domain set), real HTTP and signatures
node test/manual-txlab-browser.js   # real browser, both domain pages
```

`manual-txlab-php.js` starts separately keyed PHP servers with separate state and covers: success, one approval stays
pending, forged B signature (including a "b.test" approval signed with A's key), unauthorized domain, replayed and duplicate approval,
wrong transaction id, modified amount and recipient, duplicate execution, eight parallel approvals executing once, competing
transfers that cannot overdraw, insufficient balance, expiry, an unavailable peer, restart while pending, a tampered payload shown to the
approver, a policy mismatch, a rejection, 2-of-3 with a mandatory settlement domain, database-level immutability, fail-closed
configuration, and isolation (no issuer files created, no secret in any response).
