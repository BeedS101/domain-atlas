# Multi-Issuer Portable Asset Lab: deployment guide

**TEST DEMO, NO REAL VALUE.** One portable asset ("Joint Explorer Certificate") is jointly issued by two
independently keyed domains (`evtec.co.za`, `domain-atlas.co.za`), each of which must approve its issuance and every
ownership transfer. Test owners are browser-held Web Crypto keys, not wallets. The lab needs no administrator token,
no Node process and no ledger integration, and it works on ordinary PHP shared hosting.

It builds on the transaction lab (`atlas/demo/txlab/`): it reuses its signing, approval-shape, loopback-guard and clock
helpers **unmodified**, so `atlas/demo/txlab/` must be present on each site, and nothing in it changes. The lab is a new,
isolated module. It adds files only and modifies no existing file except one callout link in `index.html`. It never
reads or writes the issuer keys, stores, reserve bank, trading station, wallet, Chainblock ledgers or `.well-known`
files of the existing services, and none of the security restrictions of the earlier lockdown are touched. The lab is
**disabled** until every check below passes, and it is disabled in the repository by default (no config or keys exist
in the repo).

## 1. What it does, and what it does not claim

- **One asset, two issuers.** The asset embeds its id, class and metadata, the original owner's public key, the
  complete issuer roster (domain, key id, discovery reference), the issuance threshold and mandatory list, the
  transfer policy and an ownership-registry reference. Each issuing domain signs the same definition digest with its own P-256 key. The
  roster (who may approve) is kept separate from the signatures (who did). A domain counts once.
- **Discovery, not hardcoded endpoints.** The asset names only domains. Each domain publishes a signed manifest at
  `/.well-known/atlas-multi-issuer.json` declaring where its `asset.issue.approve`, `asset.transfer.approve` and
  `asset.state` services live. Services can move without reissuing the asset (section 10). Manifests are accepted only
  from pinned keys (or a key endorsed by the pinned key), over https, with no redirects, on the issuer's own domain,
  with sequence-number rollback protection.
- **Independent approval.** Every issuer re-verifies the asset and the transfer itself, under its own pinned policy, and
  fetches current ownership state from the state authority. It never trusts a browser-asserted quorum or a peer's
  signature in place of checking state.
- **Real transfer.** The current owner signs the transfer in the browser. Both issuers must approve; the state authority
  executes it once. State is durable, versioned, replay-protected and conflict-protected, and every step yields a signed
  receipt. Only one transfer can be pending per asset.
- **Portable export.** The JSON carries the definition, issuance signatures and ownership evidence. The page shows
  "Original issuance verified" separately from "Current ownership verified" (which needs a live, signed, nonce-bound
  attestation from the state authority). **A portable JSON alone never proves current ownership.**
- **Not claimed.** This is **not** atomic settlement across independent ledgers and **not** Byzantine fault tolerant.
  One designated state authority (`evtec.co.za`) records ownership and is a mandatory approver. It could withhold
  service or serve a rolled-back history; signed, chained receipts and attestations make this detectable, not impossible.
  Test identities live in the browser session (see section 11).

## 2. Infrastructure independence (check this, do not assume it)

The two domains are hosted on **different servers**. The protocol assumes it and the guide below depends on it, but code
cannot prove it, so confirm each item separately for both sites before enabling the lab:

- [ ] Different hosting accounts and different cPanel logins; neither login can open the other's File Manager.
- [ ] Different servers (check the server IP of each domain; they must not resolve to the same machine or shared PHP user).
- [ ] Each private directory is under its own account's home directory, readable by that account only.
- [ ] Each domain has its **own** freshly generated signing key. The private key of one domain is never copied to,
      stored on or backed up with the other.
- [ ] Each domain's `config.php` lists only the **other** domain's *public* key.
- [ ] The state-authority domain (`evtec.co.za`) is the only one holding ownership state; `domain-atlas.co.za`'s
      database has no asset ownership rows (the test suite checks this).
- [ ] Each site can make outbound HTTPS requests to the other, and each has at least 2 PHP workers (a peer exchange
      occupies a worker on both sides at once; with a single worker the exchange can only time out).

Keep this checklist with your deployment notes. If any item fails, the cryptographic separation still holds but the
real-world independence does not.

## 3. Files

New files only (nothing existing is overwritten, except `index.html`, which gains one link):

| Source in the repo | Upload to `evtec.co.za` | Upload to `domain-atlas.co.za` |
| --- | --- | --- |
| `issuer-php/atlas/demo/multi-issuer/api.php` | `atlas/demo/multi-issuer/api.php` | same |
| `issuer-php/atlas/demo/multi-issuer/inc/mi.php` | `atlas/demo/multi-issuer/inc/mi.php` | same |
| `issuer-php/atlas/demo/multi-issuer/inc/mi-verify.php` | `atlas/demo/multi-issuer/inc/mi-verify.php` | same |
| `issuer-php/atlas/demo/multi-issuer/inc/mi-core.php` | `atlas/demo/multi-issuer/inc/mi-core.php` | same |
| `issuer-php/atlas/demo/multi-issuer/inc/mi-public.php` | `atlas/demo/multi-issuer/inc/mi-public.php` | same |
| `issuer-php/atlas/demo/multi-issuer/inc/.htaccess` | `atlas/demo/multi-issuer/inc/.htaccess` | same |
| `issuer-php/atlas/demo/multi-issuer/inc/private-dir.php.example` | save as `atlas/demo/multi-issuer/inc/private-dir.php` (edit the path) | same, with that domain's own path |
| `issuer-php/atlas/demo/multi-issuer/tools/mi-admin.php` and `tools/.htaccess` (only if you can run PHP on the server) | `atlas/demo/multi-issuer/tools/` | same |
| `demo-domain-a/multi-issuer.html` | `multi-issuer.html` (site root) | |
| `demo-domain-b/multi-issuer.html` | | `multi-issuer.html` (site root) |
| `demo-domain-a/index.html` (adds one callout linking the lab) | `index.html` (site root; replaces the existing index) | |
| the signed manifest generated in section 6 | `.well-known/atlas-multi-issuer.json` | `.well-known/atlas-multi-issuer.json` |

The two `multi-issuer.html` files are identical. `tools/mi-setup.js` runs on your PC and is **not** uploaded.

Already required, and **not** changed by this lab:

- `atlas/demo/txlab/` (`api.php`, `inc/`) on both sites. The multi-issuer code loads `inc/txlab.php` from there. If a
  site does not have it yet, upload the whole `issuer-php/atlas/demo/txlab/` folder first (its `.htaccess` included),
  but leave the txlab lab itself disabled unless you also want it.
- `lib/crypto.php` (canonical JSON and ECDSA helpers). Both sites already have it from the issuer; otherwise upload
  `issuer-php/lib/crypto.php` to `lib/crypto.php`.

`.htaccess` files are hidden in cPanel File Manager: use Settings, then "Show Hidden Files (dotfiles)", so they are
included. "Document root" means the folder that holds `.well-known` and `atlas` (for example `public_html`).

## 4. Requirements (both domains)

- PHP 7.2 or newer with `pdo_sqlite`, `openssl` and `curl` (cPanel, "Select PHP Version"). `op=health` names any
  missing extension and keeps the lab disabled.
- A directory **outside the web root** that PHP can write to, for example `/home/CPANELUSER/mi-private`. If it is inside the web
  root, the lab refuses to start. Use a directory of its own, separate from the txlab private directory and from the issuer's.
- Outbound HTTPS from each domain to the other, with no `www.` redirect and no http-to-https redirect on the manifest
  and API paths (redirects are never followed).
- SQLite: the database (`mi.sqlite` plus WAL journal files) is created in the private directory. The directory must
  allow creating files, not only the database file.

## 5. Generate each domain's own demo key (on that domain's side)

Never reuse the issuer's key, the txlab key, or the other domain's key.

**With a PHP command line (cPanel Terminal or SSH), on that server:**

```
php ~/public_html/atlas/demo/multi-issuer/tools/mi-admin.php keygen --dir ~/mi-private --domain evtec.co.za
```
run on the evtec.co.za server, and on the domain-atlas.co.za server:
```
php ~/public_html/atlas/demo/multi-issuer/tools/mi-admin.php keygen --dir ~/mi-private --domain domain-atlas.co.za
```

**Without a server command line:** on your PC, with Node,

```
node issuer-php/atlas/demo/multi-issuer/tools/mi-setup.js keygen --dir mi-private-evtec --domain evtec.co.za
node issuer-php/atlas/demo/multi-issuer/tools/mi-setup.js keygen --dir mi-private-atlas --domain domain-atlas.co.za
```

then upload each folder to **its own** domain's private location (outside the web root) through that domain's own
account, set `signing-key.pem` to permission 600 and the folder to 700. The keys were created on your PC, so **delete the
local copies of both folders (and any backups) afterwards**; this is the one step where both private keys exist in one
place, so prefer the server-side tool when you can.

Each command prints the **public key** and writes `signing-key.pem` and `public-key.txt` (public) to the private directory.
Only the public key is ever shared.

## 6. Exchange public keys, write configuration, sign the discovery manifest

Copy `evtec.co.za`'s public key into `domain-atlas.co.za`'s configuration and the other way round. Public keys are not
secret, but copy them exactly and compare the printed strings by eye in both places. The roster carries **public keys only**;
endpoints are never configured here (they come from discovery).

Configuration (the same roster and policy on both domains; only `--domain` and `--dir` differ). On the evtec.co.za server:

```
php mi-admin.php config --dir ~/mi-private --domain evtec.co.za --state evtec.co.za \
  --roster "evtec.co.za=<EVTEC_PUBLIC_KEY>,domain-atlas.co.za=<ATLAS_PUBLIC_KEY>" \
  --issuance-threshold 2 --issuance-mandatory evtec.co.za,domain-atlas.co.za \
  --transfer-threshold 2 --transfer-mandatory evtec.co.za,domain-atlas.co.za \
  --public-demo
```

On the domain-atlas.co.za server run the same with `--domain domain-atlas.co.za` (still `--state evtec.co.za`).
(`mi-setup.js config ...` takes the same options.) The file is written **disabled**. Never add `--allow-insecure-http` or
`--open-discovery` on a live domain (the first exists for local tests and is only honoured for 127.0.0.1; the second makes the site
fetch manifests of issuers outside its roster).

The state authority must be mandatory in both policies, or the lab refuses to start. Policies are K-of-N with an optional mandatory
list; with two live domains use 2-of-2 with both mandatory. More issuers need only a longer roster and policy on every domain.

Then sign each domain's discovery manifest, run on that domain's own server (or with `mi-setup.js manifest` on a PC):

```
php mi-admin.php manifest --dir ~/mi-private \
  --service "asset.issue.approve=https://evtec.co.za/atlas/demo/multi-issuer/api.php,asset.transfer.approve=https://evtec.co.za/atlas/demo/multi-issuer/api.php,asset.state=https://evtec.co.za/atlas/demo/multi-issuer/api.php"
```

and for domain-atlas.co.za the same with its own domain, listing `asset.issue.approve` and `asset.transfer.approve` (it is not the state authority, so it
needs no `asset.state`). Service URLs must be https, on the domain itself or a subdomain, end in `/api.php`, and carry no
credentials, query or port. The command writes `manifest.json` into the private directory; **copy it to
`.well-known/atlas-multi-issuer.json` in that site's document root**. Each regeneration increments the sequence number.
Peers reject a lower sequence number than they have already seen.

Tell the web code where the private directory is: copy `atlas/demo/multi-issuer/inc/private-dir.php.example` to
`atlas/demo/multi-issuer/inc/private-dir.php` on each domain and set the absolute path, for example
`return "/home/CPANELUSER/mi-private";`.

Permissions: private directory 700 and writable by the PHP account, `signing-key.pem` 600, `config.php` 600. A key that
other accounts can read keeps the lab disabled.

## 7. Activation flags and the kill switch

| Switch | Where | Effect |
| --- | --- | --- |
| `'enabled' => true` | `config.php` (or `config ... --enable`) | Without it every operation answers 503. Default: false. |
| `'publicDemo' => array('enabled' => true)` | `config.php` (or `config ... --public-demo`) | Allows visitors to run sessions. Without it every `public-*` operation answers 403; peer approvals between issuers still work. Default: off. |
| `DISABLED` file | private directory (`php mi-admin.php disable --dir ...`) | Kill switch: everything answers 503 immediately. Delete the file to re-enable. |

Public limits (all integers, in `publicDemo`, or `--public-set name=value,...`). Defaults: `sessionTtlSeconds` 7200,
`issuanceWindowSeconds` 600, `transferTtlSeconds` 300, `maxAssetsPerSession` 3, `maxTransfersPerSession` 8, `maxSessions` 100,
`maxPendingTransfersGlobal` 40, `sessionsPerIpPerHour` 10, `assetsPerIpPerHour` 15, `transfersPerIpPerHour` 40,
`approvalsPerIpPerMinute` 30, `callsPerIpPerMinute` 120, `peerRequestsPerHour` 1500, `maxInflightPeer` 4. Out-of-range values
or unknown names keep the whole lab disabled (fail closed). The address used for limits is the connection's `REMOTE_ADDR`; forwarding
headers are ignored, so behind a proxy or CDN every visitor looks like one address and the per-address limits act as global limits.

## 8. Enable and check

In each private `config.php` set `'enabled' => true` (or re-run `config` with `--enable`). On a server with a shell:

```
php mi-admin.php check --dir ~/mi-private
```

should print `OK: domain evtec.co.za, state authority evtec.co.za, issuance 2-of-2 ...`. Without a shell, open the health
URL below: every problem (missing extension, private directory inside the web root, key readable by others, key not matching the pinned public
key, policy that does not require the state authority, `DISABLED` file, `enabled` not true) is listed there and the lab refuses all other operations.

## 9. Verify isolation from the existing functionality

1. Compare the file listing before and after: only `atlas/demo/multi-issuer/`, `multi-issuer.html`, `.well-known/atlas-multi-issuer.json`
   (plus the index link on `evtec.co.za`) are new; `lib/` gained nothing.
2. Open your existing pages and confirm they behave as before: the Reserve Bank demo, trading station, wallet and the transaction lab.
3. The lab never touches `lib/issuer-private-key.pem`, `lib/atlas-*-store.json`, ledgers or any issuer state. Its only state is
   `mi.sqlite` (plus its journal files) in the private directory.
4. Secrets are not served: these must answer 403 or 404, never file contents:
   `https://DOMAIN/atlas/demo/multi-issuer/inc/mi.php`, `.../inc/private-dir.php`, `.../tools/mi-admin.php`.
5. No response of `api.php` contains the private key or its path (the test suite checks this).

## 10. Live two-domain smoke test

1. Health, both sites: `https://evtec.co.za/atlas/demo/multi-issuer/api.php?op=health` and
   `https://domain-atlas.co.za/atlas/demo/multi-issuer/api.php?op=health`. Both must show `"enabled": true`,
   `"manifestPresent": true`, and `"role"` `state-authority` on evtec.co.za and `approver` on domain-atlas.co.za.
2. Manifests, both sites: `https://evtec.co.za/.well-known/atlas-multi-issuer.json` and the domain-atlas.co.za one return the signed JSON
   (not a redirect or HTML page).
3. Open `https://evtec.co.za/multi-issuer.html` in a private window. A test session starts (Alice, Bob and Carol are created in
   your browser). On `https://domain-atlas.co.za/multi-issuer.html` the page says it is an approving domain: assets are created
   on the state authority and only approved, viewed and verified there.
4. Click **Create test asset**. The asset opens with issuance quorum 0/2 and the service-discovery table shows both
   issuers resolved from their own domains (key id, manifest sequence, services found). Click **Ask evtec.co.za to approve**
   (1/2, still not issued), then **Ask domain-atlas.co.za to approve**. The second click makes evtec.co.za contact
   domain-atlas.co.za, which fetches the definition itself and signs; the quorum becomes 2/2 and "Original issuance"
   turns verified. The history panel lists each request one domain made to the other.
5. Under "2. Transfer ownership" pick a new owner and click **Sign and propose transfer** (your browser signs as the current
   owner). Click **Ask evtec.co.za to approve**, then **Ask domain-atlas.co.za to approve**. After the second approval the owner
   changes, the version advances to 1 and a signed receipt appears, with each signature marked verified by the server and by your
   browser. "Current ownership" shows verified only while the live signed attestation from the state authority checks out.
6. Click **Download this asset as JSON**, open `https://domain-atlas.co.za/multi-issuer.html`, paste or choose the file and click
   **Verify imported asset**. Original issuance is verified immediately. Current ownership is verified only after the live state
   check against evtec.co.za; an export taken before the transfer reports "stale", never "current".
7. Relocate a service (below), then repeat step 5 on a new asset and re-import the earlier export: the exported JSON is
   unchanged and still resolves the moved service.

If step 4 shows a peer unreachable although both sites are up, the host may block a site from calling its
neighbour over HTTPS, or has too few PHP workers; the lab stays pending or reports an explicit unavailable status and never fakes success.

### Service relocation

To move a service (say `asset.transfer.approve` to a subdomain `https://svc.domain-atlas.co.za/atlas/demo/multi-issuer/api.php`):

1. Put the lab code on the new location (it must read the same private directory).
2. On the domain-atlas.co.za server run `php mi-admin.php manifest --dir ~/mi-private --service ...` with the new URL
   (sequence increments), then copy the new `manifest.json` to `.well-known/atlas-multi-issuer.json`.
3. Peers pick up the new manifest on their next discovery (cached manifests are re-validated; a lower sequence is
   rejected). Re-export the asset: **the JSON is byte-for-byte unchanged**, because it never contained an endpoint.

### Key rotation

`php mi-admin.php manifest ... --signer-dir NEWKEYDIR` (generated with `keygen`) signs the manifest with a new key that
the **pinned** key endorses. Peers keep trusting the pinned key; the new key is accepted only through the endorsement and only within its validity
window, and a manifest signed by an unendorsed key is rejected. **Limitation:** approvals themselves are still signed by the pinned roster key, so rotating
the approval key means every peer updates its roster (a new key pinned by hand on each side); this lab never silently replaces trusted authority.

## 11. Limits that visitors should be told

- **Test identities.** The owner keys (alice, bob, carol) are P-256 keys generated by the browser's Web Crypto API and kept in that tab's session storage (so any script running on the page could read them; that is acceptable only for test identities). Closing the tab or
  clearing site data loses them unless the visitor exported them with **Export identities**; there is no recovery. They are not wallets and hold no value.
- **Public mode is sandboxed.** Sessions are isolated, only test-only asset classes can be created, quotas and expiry apply, there is no unrestricted signing
  operation and no public reset. Visitors cannot reach existing issuer keys, wallets or assets.
- **Settlement.** One state authority, single ledger, no atomic cross-ledger settlement, no BFT (section 1).
- **Freshness.** "Current ownership" is only as fresh as the last signed, nonce-bound attestation from the state authority.

## 12. Disable, roll back, remove

- Kill switch: `php mi-admin.php disable --dir ~/mi-private`, or create an empty `DISABLED` file there (cPanel File Manager is enough).
- Turn off only public sessions: remove the `publicDemo` line or set `'enabled' => false`.
- Reset assets, ownership state and sessions (command line only, by design not exposed on the web):
  `php mi-admin.php reset --dir ~/mi-private --yes`. Keys and config are untouched.
- Roll back the upload: restore the previous `index.html`, delete `multi-issuer.html`, `atlas/demo/multi-issuer/`
  and `.well-known/atlas-multi-issuer.json`, and remove the private directory. Nothing else was changed.

## 13. What each operation does

| `op` | Method | Who | Notes |
| --- | --- | --- | --- |
| `health`, `discovery` | GET | anyone (read only) | `discovery` returns this domain's signed manifest |
| `asset`, `tx` | GET | anyone | on an approver these relay from the state authority and are re-verified locally; `asset` can include a nonce-bound signed attestation |
| `peer-fetch`, `peer-issue-approve`, `peer-transfer-approve` | POST | only a request signed by a pinned roster key, fresh, addressed to this domain and not seen before | an approver fetches the evidence itself and validates it under its own policy before signing, and returns its approval in the response (no callbacks) |
| `submit-approval` | POST | anyone, but only a decision signed by a pinned roster key for that asset or transfer is accepted | every rejection is logged |
| `public-start`, `public-session`, `public-asset-create`, `public-issue-approve`, `public-transfer-propose`, `public-transfer-approve` | POST/GET | a visitor holding a session token (public mode only) | each bound to one session; none signs caller-supplied data; the owner signature on a transfer is checked against the owner key recorded in the asset |
| `verify` | POST | anyone | verifies a pasted portable JSON; optionally checks live state |

There is no administrator operation and no token. JSON content type is required on POST, bodies are size-capped (16 KB, 64 KB for `verify`) and no CORS headers are sent.

## 14. Tests

```
node test/manual-multi-issuer-php.js       # independently started PHP servers (2, 3 and 4 domains), real HTTP and signatures
node test/manual-multi-issuer-browser.js   # real browser against two domain pages
node test/manual-multi-issuer-setup.js     # the Node setup tool's output is accepted by the PHP side
```

The PHP suite starts separately keyed servers with separate state and covers, among others: fail-closed configuration; one signer staying
pending; joint issuance; forged, duplicate, unauthorized and altered issuance approvals; tampered metadata, roster, threshold or transfer policy;
rogue self-made rosters; duplicate signers counting once; transfer success, replay, stale state, old versus current exports; the owner's signature
being required; competing transfers and races; peer outage, bounded waits and restart recovery; discovery forgery, arbitrary URLs, redirects,
manifest rollback, key rotation and service relocation (asset JSON unchanged); K-of-N with 2-of-3, 3-of-3, mandatory issuers and 3-of-4; public-mode
isolation, limits, rate limiting, expiry and no reset; and absence of secrets in any response. The regression suites of the transaction lab, public lab,
Reserve Bank demo and consortium mint are unaffected and pass unchanged.
