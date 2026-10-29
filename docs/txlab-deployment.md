# Multi-Domain Transaction Authorization Lab: deployment guide

**TEST DEMO, NO REAL CURRENCY.** A browser-based lab in which a 30.00 DEMO transfer from
Alice to Bob executes only after two independently keyed domains (`evtec.co.za`,
`domain-atlas.co.za`) each sign the same canonical transaction. It needs no wallet, no
Node process and no ledger integration, and it works on ordinary PHP shared hosting.

Public visitors can run the whole flow without any administrator token through the explicitly enabled public mode (section 9).

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
- The two domains are hosted on different servers, each with its own hosting account, credentials and
  private directory, so neither can read the other's key. That independence is a property of the deployment,
  not of this code: confirm it separately (see the independence checklist in `multi-issuer-deployment.md`)
  and never copy one domain's private directory to the other.

## Files

New files only (nothing existing is overwritten):

| Source in the repo | Upload to `evtec.co.za` | Upload to `domain-atlas.co.za` |
| --- | --- | --- |
| `issuer-php/atlas/demo/txlab/api.php` | `atlas/demo/txlab/api.php` | `atlas/demo/txlab/api.php` |
| `issuer-php/atlas/demo/txlab/inc/txlab.php` | `atlas/demo/txlab/inc/txlab.php` | `atlas/demo/txlab/inc/txlab.php` |
| `issuer-php/atlas/demo/txlab/inc/txlab-public.php` (public-demo mode) | `atlas/demo/txlab/inc/txlab-public.php` | `atlas/demo/txlab/inc/txlab-public.php` |
| `issuer-php/atlas/demo/txlab/inc/.htaccess` | `atlas/demo/txlab/inc/.htaccess` | `atlas/demo/txlab/inc/.htaccess` |
| `issuer-php/atlas/demo/txlab/inc/private-dir.php.example` | save as `atlas/demo/txlab/inc/private-dir.php` (edit the path) | same, with that domain's own path |
| `issuer-php/atlas/demo/txlab/tools/*` (optional, only if you can run PHP on the server) | `atlas/demo/txlab/tools/` (with its `.htaccess`) | same |
| `demo-domain-a/txlab.html` | `txlab.html` (site root) | |
| `demo-domain-a/index.html` (adds one callout linking the lab, like the other demos) | `index.html` (site root; replaces the existing index) | |
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
php ~/public_html/atlas/demo/txlab/tools/txlab-admin.php keygen --dir ~/txlab-private-evtec --domain evtec.co.za
php ~/public_html/atlas/demo/txlab/tools/txlab-admin.php keygen --dir ~/txlab-private-atlas --domain domain-atlas.co.za
```

(Run each command on its own domain's server, against that server's own document root.)

**Without a server command line:** on your PC, with Node,

```
node issuer-php/atlas/demo/txlab/tools/txlab-setup.js keygen --dir txlab-private-evtec --domain evtec.co.za
node issuer-php/atlas/demo/txlab/tools/txlab-setup.js keygen --dir txlab-private-atlas --domain domain-atlas.co.za
```

then upload each folder to its domain's private location (outside the web root) and set `signing-key.pem` to
permission 600 and the folder to 700. The key was created on your PC, so delete the local copies afterwards.

Each command prints the **public key** and a one-time **admin token**, and writes `signing-key.pem`,
`public-key.txt` and `admin-token.sha256` (the hash only) to the private directory. Save each token in a password manager. It is
shown once.

## 3. Exchange the public keys

Public keys are not secret, but they must be copied exactly and checked. Copy `evtec.co.za`'s public key into
`domain-atlas.co.za`'s configuration and the other way round. As you own both sites, compare the printed strings
by eye in both places. After enabling, `https://DOMAIN/atlas/demo/txlab/api.php?op=peers` confirms each side sees the other and that the key
it published matches the pinned one.

## 4. Write the configuration (outside the web root)

The same roster on both domains; only `--domain` and `--dir` differ.

```
php txlab-admin.php config --dir ~/txlab-private-evtec --domain evtec.co.za --settlement evtec.co.za \
  --threshold 2 --mandatory evtec.co.za \
  --roster "evtec.co.za=<EVTEC_PUBLIC_KEY>@https://evtec.co.za/atlas/demo/txlab/api.php,domain-atlas.co.za=<ATLAS_PUBLIC_KEY>@https://domain-atlas.co.za/atlas/demo/txlab/api.php"

php txlab-admin.php config --dir ~/txlab-private-atlas --domain domain-atlas.co.za --settlement evtec.co.za \
  --threshold 2 --mandatory evtec.co.za \
  --roster "evtec.co.za=<EVTEC_PUBLIC_KEY>@https://evtec.co.za/atlas/demo/txlab/api.php,domain-atlas.co.za=<ATLAS_PUBLIC_KEY>@https://domain-atlas.co.za/atlas/demo/txlab/api.php"
```

(`txlab-setup.js config ...` takes the same options.) The files are written **disabled**. Do not add
`--allow-insecure-http` on a live domain; it exists for the local tests and is only honoured for 127.0.0.1.

To add a third domain later, add it to `--roster` on every domain, raise `--threshold` if wanted, and re-run
`config`. Existing transactions keep the policy they were created with.

Then tell the web code where the private directory is: copy `atlas/demo/txlab/inc/private-dir.php.example` to
`atlas/demo/txlab/inc/private-dir.php` on each domain and set the absolute path, for example
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

1. Compare the file listing before and after: only `atlas/demo/txlab/` and `txlab.html` (plus the index link on `evtec.co.za`) are new, and `lib/` gained nothing.
2. Open your existing pages and confirm they behave as before: the Reserve Bank demo, the trading station, the wallet.
3. The lab never touches `.well-known`, `lib/issuer-private-key.pem`, `lib/atlas-*-store.json` or any issuer state. Its only
   state is `txlab.sqlite` (plus its journal files) in the private directory.
4. Secrets are not served: these should answer 403 or 404, never file contents.
   `https://DOMAIN/atlas/demo/txlab/inc/txlab.php`, `https://DOMAIN/atlas/demo/txlab/inc/private-dir.php`, `https://DOMAIN/atlas/demo/txlab/tools/txlab-admin.php`.
5. No response of `api.php` contains the token, its hash or the private key (the test suite checks this).

## 7. Live two-domain smoke test

Open these (health first):

1. `https://evtec.co.za/atlas/demo/txlab/api.php?op=health` and `https://domain-atlas.co.za/atlas/demo/txlab/api.php?op=health`:
   both `"enabled": true`; evtec.co.za is the `settlement-authority`.
2. `https://evtec.co.za/atlas/demo/txlab/api.php?op=peers` and the same on domain-atlas.co.za: peer reachable, `keyMatches: true`.
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
- Remove: delete `atlas/demo/txlab/`, `txlab.html` and the private directory. Nothing else was changed.

## 9. Public demonstration mode (no administrator token for visitors)

Public mode lets an ordinary visitor run a complete 2-of-2 transfer in the browser: open `txlab.html`, start a test
transfer, watch both domains independently validate and sign it, and see the verified settlement receipt. No wallet, no
administrator token, no real money. It is **off** until `publicDemo` is explicitly enabled in each domain's private
`config.php`, and the administrator flow above keeps working unchanged.

### How it is kept safe

- **Isolated state.** Public mode uses its own SQLite file (`txlab-public.sqlite`) in the private directory. Visitors get a
  private session with their own test balances (Alice 100.00 DEMO, Bob 0.00). Nothing public reads or writes the main
  demo ledger, the issuer keys or any real balance. Public mode never mints: a session's total is fixed at creation and
  checked by a conservation test.
- **A session is the only credential.** `public-start` returns a random 256-bit token once; only its sha256 is stored. Every
  public operation names a session and can touch only that session's balances and transfers. A visitor cannot see, spend or
  approve another session's transfer, and the public session id is not a credential.
- **No general-purpose signing endpoint.** There is no operation that signs caller-supplied data.
  - The settlement domain (A) signs only a stored transfer that it created for that session, after validating it
    (amount, accounts, lifetime, quorum policy, digest).
  - An approving domain (B) signs only when the request carries a signature made by the settlement domain's key (pinned in B's own
    config, fresh within two minutes, addressed to B) **and** B itself fetches the transfer from the settlement domain and validates
    it under B's own limits, own quorum policy and own pinned settlement domain. B signs the digest it validated and delivers it to
    the settlement domain's existing `submit-approval`, which re-verifies the signature with B's pinned public key.
  - Main-ledger (administrator) transfers are never signed automatically; `decide` refuses session transfers.
- **2-of-2 and receipts are unchanged.** The settlement domain is a mandatory approver, one signature never executes, execution
  happens exactly once, and the receipt is signed by the settlement domain. Visitors can verify every signature in the browser.
- **Limits, enforced server-side on every call.** Only `alice` and `bob`; per-transfer amount cap (each domain applies its own);
  short transfer lifetime (each domain applies its own); per-session cap on transfers and pending transfers; session expiry with
  pruning of the expired session's data; per-address and global rate limits; a global cap on active sessions and pending transfers.
  The address used is the connection's `REMOTE_ADDR`, hashed with a random salt; `X-Forwarded-For` and similar headers are ignored.
- **Closed surface.** No public operation resets state, changes configuration, mints, or reaches a key. Unknown operations return 404;
  public operations require a JSON content type (no cross-site form posts) and send no CORS headers.
- **Read-only inspection and protected manual mode.** `state` is a read-only view of the administrator ledger, shown on the page
  in a collapsed panel. The administrator controls (token unlock, manual create/decide on the main ledger) sit in a collapsed
  "Demo administrator" panel at the bottom of the page and still need that domain's token.

### Turn it on (both domains)

Public mode must be enabled on **both** domains: the settlement domain runs the visitor session and an approving domain
refuses to sign unless its own public mode is on. Edit each private `config.php` (cPanel File Manager is enough) and add this
line just before the final closing bracket of the returned array:

```
  'publicDemo' => array('enabled' => true),
```

(Or re-run `txlab-admin.php config ... --public-demo` / `txlab-setup.js config ... --public-demo`; add `--public-set maxAmountMinor=5000,maxSessions=100`
to override limits.) Nothing else in `config.php` changes: keep the existing keys, roster and token hash. `enabled` must be exactly `true`;
anything else leaves public mode off. A bad value in the block keeps the **whole** lab disabled (fail closed) and `op=health` names the setting.

Optional limits (all integers; defaults shown). Amounts are minor units (5000 = 50.00 DEMO):

| Setting | Default | Meaning |
| --- | --- | --- |
| `aliceMinor` | 10000 | Alice's starting balance per session (Bob starts at 0) |
| `maxAmountMinor` | 5000 | largest transfer this domain will sign |
| `txTtlSeconds` | 300 | longest authorization window this domain will sign |
| `sessionTtlSeconds` | 1800 | session lifetime |
| `maxTransfersPerSession` / `maxPendingPerSession` | 5 / 2 | per-session caps |
| `maxSessions` / `maxPendingGlobal` | 200 / 60 | global caps (503 when reached) |
| `sessionsPerIpPerHour` / `transfersPerIpPerHour` | 10 / 30 | per-address caps |
| `approvalsPerIpPerMinute` / `callsPerIpPerMinute` | 30 / 120 | per-address caps |
| `transfersGlobalPerHour` / `peerApprovalsPerHour` | 400 / 600 | global caps (peer = requests an approving domain will answer) |

If the site sits behind a proxy or CDN that hides visitor addresses, every visitor looks like one address and the per-address
limits then act as global limits; relax them accordingly.

### Public smoke test

1. `https://evtec.co.za/atlas/demo/txlab/api.php?op=health` and the domain-atlas.co.za one: `"enabled": true` and `"publicDemo": {"enabled": true, ...}` on both.
2. Open `https://evtec.co.za/txlab.html` in a private window. A test session appears with Alice 100.00 and Bob 0.00.
3. **Start test transfer** (30). Click **Ask evtec.co.za to validate & sign** (1/2, nothing moved), then **Ask domain-atlas.co.za to validate & sign**:
   2/2, executed, Alice 70.00, Bob 30.00, receipt and both approvals verified by the server and by your browser. (Or use **Request both approvals**.)
4. Open `https://domain-atlas.co.za/txlab.html#tx=<id>`: the same transfer, read-only, verified again by that domain with its own pinned keys.
5. Open the page in a second browser: a fresh 100.00 / 0.00 session, independent of the first.

### Updating an existing deployment (exact upload list)

Upload these, replacing the existing copies, to **both** sites unless stated (cPanel File Manager, "Show Hidden Files" on):

| Repo file | Action | evtec.co.za | domain-atlas.co.za |
| --- | --- | --- | --- |
| `issuer-php/atlas/demo/txlab/api.php` | replace | `atlas/demo/txlab/api.php` | same |
| `issuer-php/atlas/demo/txlab/inc/txlab.php` | replace | `atlas/demo/txlab/inc/txlab.php` | same |
| `issuer-php/atlas/demo/txlab/inc/txlab-public.php` | **new** | `atlas/demo/txlab/inc/txlab-public.php` | same |
| `issuer-php/atlas/demo/txlab/tools/txlab-admin.php` | replace (optional, only if the tools folder is on the server) | `atlas/demo/txlab/tools/txlab-admin.php` | same |
| `demo-domain-a/txlab.html` | replace | `txlab.html` | |
| `demo-domain-b/txlab.html` | replace | | `txlab.html` |

Then edit the two private `config.php` files as above. `txlab-setup.js` runs on your PC and is not uploaded.
Nothing else changes: not `index.html`, not any `.htaccess`, not `inc/private-dir.php`, keys, tokens or `lib/crypto.php`, and the
existing `txlab.sqlite` and its balances are untouched. Uploading the files without the `publicDemo` line changes nothing visible
except that the page is the new version; public mode stays off.

Roll back: delete the `publicDemo` line (or set `'enabled' => false`) and every public operation answers 403 at once; the
administrator lab is unaffected. The full kill switch (`DISABLED` file) still stops everything. `reset --yes` (command line only) also
removes `txlab-public.sqlite`.

## What each domain can and cannot do

| Operation | Who | Notes |
| --- | --- | --- |
| `op=health`, `roster`, `state`, `tx`, `peers` | anyone (read only) | `state` and `tx` on the approving domain are fetched from the settlement authority and re-verified with that domain's own pinned keys |
| `op=create` | settlement authority's admin token | `requestId` makes a repeat submit return the same transaction |
| `op=decide` | that domain's admin token | fetches the transaction, checks it against this domain's own policy, signs once with its own key, delivers it to the settlement authority |
| `op=submit-approval` | anyone, but only a decision signed by a roster key is accepted | every rejection is logged against the transaction |
| `op=public-start`, `public-session`, `public-transfer`, `public-approve` | a visitor holding a session token (public mode only, settlement domain) | each bound to one session; never signs caller-supplied data |
| `op=peer-approve` | only a request signed by the settlement domain (public mode only, approving domains) | B fetches and validates the transfer itself before signing |

The admin token is checked with a constant-time hash comparison; eight failures in five minutes lock admin actions for a
while. Amounts are integer minor units (3000 = 30.00). A transaction expires after 15 minutes (`ttlSeconds`).

## Tests

```
node test/manual-txlab-php.js       # two PHP servers (plus a three-domain set), real HTTP and signatures
node test/manual-txlab-browser.js   # real browser, both domain pages (administrator flow)
node test/manual-txlab-public-php.js      # public mode: sessions, isolation, limits, abuse controls, B's own validation
node test/manual-txlab-public-browser.js  # real browser: the visitor flow, a second visitor, an unreachable approver
```

`manual-txlab-php.js` starts separately keyed PHP servers with separate state and covers: success, one approval stays
pending, forged B signature (including a "b.test" approval signed with A's key), unauthorized domain, replayed and duplicate approval,
wrong transaction id, modified amount and recipient, duplicate execution, eight parallel approvals executing once, competing
transfers that cannot overdraw, insufficient balance, expiry, an unavailable peer, restart while pending, a tampered payload shown to the
approver, a policy mismatch, a rejection, 2-of-3 with a mandatory settlement domain, database-level immutability, fail-closed
configuration, and isolation (no issuer files created, no secret in any response).

`manual-txlab-public-php.js` covers public mode over real HTTP between separately keyed servers: the full visitor flow with
signature checks; session isolation (other sessions, wrong or absent tokens, the session id used as a token, malformed ids); per-session
balances with no overspending; amount, account and request-id validation; idempotent creation; per-session transfer and pending caps;
parallel approvals executing once; `peer-approve` refusing forged, stale, altered, misaddressed, replayed and main-ledger requests; a scripted
settlement authority proving B refuses a tampered digest, an amount or lifetime over its own limits, a weaker policy, a foreign
origin, a non-pending or expired transfer and a transfer without a session; a stricter limit on B stopping execution; an unreachable or
not-enabled approver leaving the transfer pending; restart persistence; no reset, mint, sign or key endpoints, and administrator
operations still needing their token; per-address, global, session-count and expiry limits with pruning (forwarding headers ignored);
public mode off by default and failing closed on a bad setting; and no secret in any response or on disk.
