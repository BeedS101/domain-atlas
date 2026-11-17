# Site doctor: check a domain against the repository

A one-off, single-file PHP page. You upload it to a domain, open it, read what is missing or different compared with this repository, and delete it. It is read-only: nothing on the site is created, changed or sent anywhere, except the optional "Delete this file" button, which removes the doctor itself.

It answers the question "is everything that should be on this domain actually there, is it the current version, and are the services it runs set up and healthy?". The missing-file incident that broke the first Studio deployment would have shown up as one line: `atlas/studio/inc/studio-mint.php missing`.

## Build it

From a clean checkout of `main` (so the manifest describes committed files), on your PC:

```
node tools/site-doctor-build.js <out dir>            # valid for 72 hours
node tools/site-doctor-build.js <out dir> --hours 8  # shorter
```

This writes two files:

- `site-doctor.php`: the page, with the file manifest (paths, sizes and SHA-256) and a hash of the access token embedded.
- `ACCESS.txt`: the token and the deadline. Keep it off the server.

A new build gives a new token and a new deadline, and describes the commit you built it from. Rebuild whenever the repository changes.

## Use it

1. Upload `site-doctor.php` into the web root of the domain (the folder that contains `atlas/` and `lib/`).
2. Open `https://YOUR-DOMAIN/site-doctor.php` and paste the token.
3. Tell it which demo site the domain serves (A, B or neither) and tick any optional component that should be here; it works out the rest from the files and from what the domain's manifest advertises. Read the report.
4. Fix what it lists, press **Check again**, repeat.
5. Press **Delete this file** (or delete `site-doctor.php` in your file manager). Do not leave it on the server.

## What the report says

**To do - fix-it checklist** merges everything that needs attention into one numbered list, most urgent first: anything that exposes a secret or answers a stranger, then what stops the issuer working (failed checks, missing and changed code), then warnings, then tidying (pages, unknown files). Fix from the top and press **Check again**. **Save this report as a file** (also at the bottom as **Download report**) writes the same redacted text as **Copy report** to a `.txt` file in your browser; nothing is uploaded.

**Components (what is installed here)** lists each deployable part and whether it is on this domain. Status words are the same throughout the report: PASS, WARNING, FAIL, INFO and NOT INSTALLED. The parts are the core issuer and libraries, the demo site pages, and these optional components: Asset Studio, Global Mail / Post Office, domain mail, Trading Station, ledger credential routes, moderation, world drops, the demo and lab routes, the Call service, the Presence service, the domain services directory, Chain Labs (ledger pages and PHP libraries) and the credential verifier. A component counts as installed when any of its (non-optional) files is on the domain, and then every one of its files is expected. A component with no file here that the domain's manifest does not advertise is NOT INSTALLED, and its files are never reported as missing: a minimal issuer is not told it lacks Chain Labs. A component that the manifest advertises (for example `chainLabs` or `assetStudio`) or that you ticked, but whose files are all absent, is a failure. A service the manifest points at another host is ignored, because it says nothing about this server. The verifier is found wherever it was uploaded (`atlas-verify/` by default, or another folder up to two levels down that holds `verify.php`), and its files are compared there. Node-only servers, the browser extension, development tools, documentation and the per-source `README.txt` and `test-router.php` files are not part of any PHP deployment and are never expected.

**Services and deployment checks** reads the installed parts without changing them. Each line says what was found, why it matters and what to do:

- *Signing key*: the issuer's private key is opened in memory only, to derive its public half and compare it with `.well-known/atlas-key.json`; a mismatch, a key that is not valid now, an unreadable private key, or a published key with no private key is a failure. The revocation and suspension lists must both be published. Nothing secret is printed.
- *Private state*: where it lives (`lib/` or a folder named by `lib/atlas-private-dir.txt` or `ATLAS_PRIVATE_DIR`), whether that is outside the web root and writable, and the replay, holdings, journal (`txn`), mint-allowance and owner-proof folders with file counts, sizes and pending journal entries.
- *Membership owner proof*: the mode (environment variable or `lib/atlas-owner-proof-config.json`; off, accept or require), whether the issue route and `lib/owner-proof.php` carry the check, the per-class signed, unsigned and refused counts from the statistics file, and whether the mode is ready to move to Require. Require is PASS, Accept is a warning (temporary), Off or an old upload is a failure. Roster, Global Mail member and stored-message counts are shown so you can compare before and after a test; their contents are never read into the report.
- *Stores* of each installed component (mail messages and subscribers, Post Office members, Trading Station members and pending trades, moderation grants, world drops, presence rooms): present and valid JSON with an entry count, not created yet (information) or damaged (failure). Only stores of installed components are looked at.
- *Global Mail pairing*: Post Office installed without the mail routes (or the reverse) is flagged, as is a manifest that asks for a membership card other than the one the wallet issues.
- *Chain Labs*: the private folder beside the web root, the `coin26`, `chain34` and `ledger29` databases, the optional `chainlabs-config.json` host list (this host must be in it), folder permissions, and the OpenSSL and SQLite extensions.
- *Directory*, *Call*, *Presence* and *verifier*: the directory's data folder (outside the web root, writable, database age and whether the crawl job looks stale, `pdo_sqlite`), the call service's settings file, the presence store, and the verifier's `config.php`. Contents of settings files are never read; trusted issuer lists are counted, not shown.

Your browser also asks each installed component's public endpoints with plain GET reads and, for two routes that must refuse an empty request (`/atlas/asset/issue` and `/atlas/mail/check`), a POST of `{}`. The expected answers are fixed (for example a 4xx refusal, never success) and an unexpected one is reported with the HTTP status. The probes never carry a credential, key or signature, so nothing can be issued, stored or sent.

**Files compared with the repository** groups each file as code (`.php`, `.htaccess`), pages and configuration, or assets (models and images):

- *Missing code* and *different code* are problems: the issuer or Studio can fail with `internal-error` without them.
- *Different pages* may be edits you made on purpose; the doctor only tells you.
- *Different on purpose*: `.well-known/spatial.json` differs on every live site by design (it carries your own worlds and the Studio policy world).
- Text files are compared with Windows line endings (CRLF) folded to Unix ones, so a file uploaded from a Windows checkout does not show as different.
- Optional files (`.example` templates, `README.txt`, the dev router, `tools/`, `txlab/` and the demo sites' own models) are not reported as missing.
- Each optional component is compared only when it is installed or expected (see Components above). Chain Labs files are compared under `chain-labs/` (its `README.md` and `SOURCE.sha256` are optional), and an unknown PHP file in that folder appears under Unexpected files.

**Server and setup** checks the PHP version and extensions, HTTPS, whether `lib/` and `.well-known/` are writable, that `lib/.htaccess` is present, that a published issuer key has its revocation list, the manifest's `studio` world, and Asset Studio's private storage: outside the web root, writable, the five sub-folders present, and `studio-config.json` naming exactly this host.

**Unexpected files** lists files that are not in the repository. Your own models and pages are normal here. Unknown PHP files get their own list and a to-do item, because an old copy of a route that was later removed from the repository has none of the newer security checks. Each one shows its size and date, and when a repository file has the same name it says whether the content is identical (a copy uploaded to the wrong folder) or different (an old or changed copy). The content is only hashed, never shown. Differing files show their size on the server next to the repository's. Folders with many unknown files are shown as one line (`folder/ [N files]`). Private state (keys, holdings, replay records, service `state/` folders, config files, `storage-root.php`) is listed by name, mode and size only, one line per state folder, and is never opened.

Lock files (`atlas-*-lock-N.lock`, `*.lock`) are shown as one line per folder (`lib/*.lock [129 lock files, all empty]`). The issuer creates up to 64 per kind on demand and they are meant to stay empty.

**What the web can read** is checked by your browser: the helper includes and the private-key path must not be served. A file that answers with PHP source or a key is reported as exposed.

**Housekeeping and health** opens the few files whose state affects every request and reports only counts and sizes, never a credential id: the revocation list (valid JSON, entry count, entries without an id, repeated entries, and a warning from 1 MB because it is read in full on every credential check and wallet download; entries are never pruned for you, and one may only be dropped once that credential has expired anyway), the suspension list (valid JSON, and suspensions that have run out but are still in the file; the issuer resolves them the next time a credential is checked), the holdings records (counted and checked for valid JSON, in the private folder if one is configured) and any single state file over 5 MB.

**File permissions and PHP limits** (not checked on Windows hosts, where modes mean nothing). It reads modes only, never opens a file, skips symlinks and changes nothing. Ordinary hosting modes (files 0644 or 0640, folders 0755 or 0750, group-readable) are never reported. It names the affected paths with their modes and a suggested mode:

- *PHP code, `.htaccess` and settings* anywhere below the web root (`.php`, `.phtml`, `.htaccess`, `.user.ini`, `php.ini`, key files, `*-config.json`, the `config.php` settings files in `lib/` folders): a file that any account can write is a failure, because whoever can write a PHP file can make your site run their code. Suggested: 0644 for code and `.htaccess`, 0600 for files that hold secrets. A folder that any account can write is a failure too (suggested 0755); a sticky shared folder like `/tmp` is not.
- *Private state*: every file in `lib/holdings`, `lib/replay` and `lib/txn`, and in the same three folders of an external private folder when `atlas-private-dir.txt` (or `ATLAS_PRIVATE_DIR`) names one. World-writable is a failure; world-readable is a warning (the issuer itself writes these as 0600, so 0644 means someone changed or copied them). This scan has its own allowance (6000 files, 3 seconds) so a large web root cannot starve it.
- *`.well-known`*: only write access matters. The issuer key, manifest and revocation and suspension lists are public by design, so a readable file is never flagged; a file any account can write is a failure (changing the revocation list would un-revoke credentials). Suggested: 0644.
- *Group write*: a sensitive item (code, settings, private state, `.well-known` files, `lib/` and the folders that hold code) that is group-writable is a warning **only when the group is not trusted**. Trusted groups are this account's own group (the group of `site-doctor.php`), the PHP process's group, and any named when building: `node tools/site-doctor-build.js <out> --trusted-groups name,name` (names or numeric ids, at most 16). Group read, and group write in a group you trust, are never reported. If the server offers no group lookup, name the group by its numeric id.

The web-root walk stops at 40,000 entries or 5 seconds; when any scan stops early the report says so (`perm-limit`) rather than implying the rest was fine. Findings are listed as paths with modes only; no file content, key or token is read or shown. Keys, settings and private files readable by other accounts are still warned about (set them to 0600, or 0640 if your host needs the group). It judges `memory_limit`, `upload_max_filesize`, `post_max_size` (smaller than the upload limit is flagged), `max_execution_time`, `open_basedir` (a failure when it excludes a configured private folder), PHP's temporary folder and its session folder (the issuer keeps its own administrator sessions, so the session folder is only information). The doctor changes no mode.

**Administrator side** counts the keys in the administrator list (administrators, moderators, switched off, unusable; a typo in `role` gives a key no rights at all, and the list says so) without showing any key; checks that the administrator session, nonce and rate-limit files can be written; and reports the date of the last administrator activity from the session file's modification time. The session file holds bearer tokens and is never opened. Your browser also asks four read-only administrator routes (`suspensions`, `site-status`, `visits`, `session/whoami`) with no credentials at all and expects a refusal; a route that answers 2xx is reported as open and heads the checklist (an old copy of the file has none of the newer access checks), and a server error is a warning. Nothing that revokes, suspends or pauses is ever asked, and a request with no credentials is refused before the route does any work and is not counted as a failed sign-in.

**Worlds and manifest** reads this domain's own `.well-known/spatial.json` and lists the domain-level settings (anchor type, owner, default world, opt-in sections) and every world: whether it can be entered, its scene file with size, object and anchor counts, its effective policy (guest access, discoverable, identity required, item drops, accepted item classes, trusted issuers, wallet bridge, chat, calendar) with "(domain default)" shown where the manifest's top level filled a value in (SPEC 3.4.1; a world's own value, even an empty list, wins), its profile, and its portals. It reports only mistakes that are certain: a manifest that is missing, too large (over 2 MB), or not valid JSON; no `domain` or `identityKey`, or a `domain` that is not this host; a key-anchored manifest without a `signature` (the signature itself is not verified here); duplicate or unusable world ids; a `defaultWorld` that does not exist or cannot be entered; portals to worlds that do not exist, or that lack the fields their kind needs; scene files that are not on the domain or are not valid JSON; policy values outside the allowed set; and manifest settings that nothing here backs up (an email intake address with no mail configuration, `fileTransfer` without the route, `"self"` trusted issuers with no published issuer key). Everything else is shown as information. Problems also appear under **To do**. It never fetches anything from the network, so portals to other domains are checked for shape only, not for whether the other site is up.

**Features (what is switched on)** reports each feature that is turned on or off by a setting in a file or by renaming a file: Asset Studio minting, ledger credentials and receipts, email-delivered tickets, transfer to file, moderation (issuer and presence side), the Transaction Lab and Multi-issuer lab, the Call service and the issuer's private state folder. Each shows a pill (ON, off, `!` for misconfigured, n/a when its files are not on this domain), the reasons, a few facts, and a "How to switch" note with exactly what to change to turn it on or off. A misconfigured feature (wrong host in a config, a private folder inside the web root, a config that cannot be parsed, a placeholder still in place) also appears under **To do**. The report is read-only: the doctor never flips a switch.

What it shows is limited to an allow-list per feature: hosts, ports, domains, counts, and whether a login is "set". Passwords, tokens, key material, admin token hashes, mail user names and the from address are never read into the output. PHP config files are matched with patterns, never included or run. The list of features and their how-to text live in `issuer-php/lib/site-features.json`, and the readers in `issuer-php/lib/site-features.php`, which the builder copies into the single-file doctor and the issuer's admin panel also uses (its **Site status** section), so the two cannot disagree. The builder validates the list, so a new switch is one entry there (using one of the existing reader types) plus a test. An entry marked `pause: true` (only the JSON-switch and studio-config types and the private config files) also gets an emergency off-switch in the admin panel; the doctor itself never writes.

**Setup values** prints what to create for Asset Studio, filled in for this host: the private folder path, the `storage-root.php` line, a `studio-config.json` with minting off, and the `studio` world for the manifest. The doctor never creates them; you create them in your file manager and press **Check again**.

**Copy report** puts a plain-text report on the clipboard with the web-root and home folder names replaced, suitable for pasting into a chat or an issue.

## What keeps it safe

- The token is 128 random bits; only its SHA-256 is in the file. A wrong token waits 1.5 seconds and returns nothing.
- After the deadline it refuses every check. It can still delete itself with the token.
- Until the token is entered, the page shows no paths, hashes or other manifest data.
- It never prints file contents. It never opens private state files, with the exceptions named above (lists and records opened only to be counted or checked for valid JSON, and the administrator key list, whose keys are not shown). Feature switches are read through per-feature allow-lists, and the test suite plants fake passwords, tokens and keys in every config type and checks that none of them appears in any response.
- It does not follow symlinks.
- The page sets a strict content security policy, `no-store`, `noindex` and no-frame headers. File names are only ever inserted as text.
- Without a built manifest (the unbuilt template) it refuses to run.

`test/site-doctor.js` checks these properties, including that a planted fake key never appears in any response, and `test/site-doctor-components.js` covers the component matrix (installed, partly installed, advertised but absent, not installed), Chain Labs, the moved verifier, the key, owner-proof, private-storage and store checks, and that the new actions refuse a wrong token, an expired doctor, and write nothing. `test/manual-site-doctor-browser.js` runs the whole page in a browser. Neither contacts a live domain.

To confirm that a domain that requires owner proof really turns unsigned membership requests away, run `tools/owner-proof-live-check.js <domain>` from your PC (see the header of that file). It sends only requests that must be refused, from throw-away keys, and creates nothing on the issuer.

## Reading the statuses

- **PASS**: checked and fine.
- **WARNING**: works, but something deserves attention (Accept mode, state kept inside the web root, a stale crawl job).
- **FAIL**: something is wrong or missing that the feature needs. The line says what to restore or change.
- **NOT INSTALLED**: an optional component that is not on this domain and not advertised. Nothing to do.
- **INFO**: facts, or something not created yet that the issuer creates on first use.

The downloaded and copied reports carry paths, modes, sizes, counts and statuses only. They never contain private keys, credentials, tokens, mailbox or roster contents; the test suite plants fake secrets in the stores and settings and checks that none of them appears in any response.

## Limits

- It compares with the commit it was built from, not with whatever is on GitHub now.
- A file that is present but cut short by an interrupted upload is reported as different; the report cannot say which part is wrong.
- The unexpected-file scan stops after 40,000 files or ten seconds and says so. Large web roots (several sites in one folder) may be partial.
- It cannot prove `.htaccess` rules are honoured on every URL; the browser probes cover the important helper files. `tools/studio-live-check.js` and `tools/demo-auth-live-check.js` remain the checks you run from your PC.
- It needs JavaScript in the browser and PHP 7.2 or newer on the server.
- Setting up a domain from scratch is guided, not automatic: the checklist and the copy-and-paste values tell you what to create; nothing is written for you.
