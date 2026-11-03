# Site doctor: check a domain against the repository

A one-off, single-file PHP page. You upload it to a domain, open it, read what is missing or different compared with this repository, and delete it. It is read-only: nothing on the site is created, changed or sent anywhere, except the optional "Delete this file" button, which removes the doctor itself.

It answers the question "is everything that should be on this domain actually there, and is it the current version?". The missing-file incident that broke the first Studio deployment would have shown up as one line: `atlas/studio/inc/studio-mint.php missing`.

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
3. Tell it what the domain serves (issuer only, demo site A or demo site B) and whether the Call and Presence services are installed; it guesses from the files. Read the report.
4. Fix what it lists, press **Check again**, repeat.
5. Press **Delete this file** (or delete `site-doctor.php` in your file manager). Do not leave it on the server.

## What the report says

**To do - fix-it checklist** merges everything that needs attention into one numbered list, most urgent first: anything that exposes a secret or answers a stranger, then what stops the issuer working (failed checks, missing and changed code), then warnings, then tidying (pages, unknown files). Fix from the top and press **Check again**. **Save this report as a file** (also at the bottom as **Download report**) writes the same redacted text as **Copy report** to a `.txt` file in your browser; nothing is uploaded.

**Files compared with the repository** groups each file as code (`.php`, `.htaccess`), pages and configuration, or assets (models and images):

- *Missing code* and *different code* are problems: the issuer or Studio can fail with `internal-error` without them.
- *Different pages* may be edits you made on purpose; the doctor only tells you.
- *Different on purpose*: `.well-known/spatial.json` differs on every live site by design (it carries your own worlds and the Studio policy world).
- Text files are compared with Windows line endings (CRLF) folded to Unix ones, so a file uploaded from a Windows checkout does not show as different.
- Optional files (`.example` templates, `README.txt`, the dev router, `tools/`, `txlab/` and the demo sites' own models) are not reported as missing.
- The Call service (`call-php`) and Presence service (`presence-php`) are compared only when ticked.

**Server and setup** checks the PHP version and extensions, HTTPS, whether `lib/` and `.well-known/` are writable, that `lib/.htaccess` is present, that a published issuer key has its revocation list, the manifest's `studio` world, and Asset Studio's private storage: outside the web root, writable, the five sub-folders present, and `studio-config.json` naming exactly this host.

**Unexpected files** lists files that are not in the repository. Your own models and pages are normal here. Unknown PHP files get their own list and a to-do item, because an old copy of a route that was later removed from the repository has none of the newer security checks. Each one shows its size and date, and when a repository file has the same name it says whether the content is identical (a copy uploaded to the wrong folder) or different (an old or changed copy). The content is only hashed, never shown. Differing files show their size on the server next to the repository's. Folders with many unknown files are shown as one line (`folder/ [N files]`). Private state (keys, holdings, replay records, service `state/` folders, config files, `storage-root.php`) is listed by name, mode and size only, one line per state folder, and is never opened.

Lock files (`atlas-*-lock-N.lock`, `*.lock`) are shown as one line per folder (`lib/*.lock [129 lock files, all empty]`). The issuer creates up to 64 per kind on demand and they are meant to stay empty.

**What the web can read** is checked by your browser: the helper includes and the private-key path must not be served. A file that answers with PHP source or a key is reported as exposed.

**Housekeeping and health** opens the few files whose state affects every request and reports only counts and sizes, never a credential id: the revocation list (valid JSON, entry count, entries without an id, repeated entries, and a warning from 1 MB because it is read in full on every credential check and wallet download; entries are never pruned for you, and one may only be dropped once that credential has expired anyway), the suspension list (valid JSON, and suspensions that have run out but are still in the file; the issuer resolves them the next time a credential is checked), the holdings records (counted and checked for valid JSON, in the private folder if one is configured) and any single state file over 5 MB.

**File permissions and PHP limits** (not shown on Windows hosts, where modes mean nothing) fails when a key, settings file or private folder can be changed by any account, and warns when a key or settings file is readable by other accounts (set it to 0600). It judges `memory_limit`, `upload_max_filesize`, `post_max_size` (smaller than the upload limit is flagged), `max_execution_time`, `open_basedir` (a failure when it excludes a configured private folder), PHP's temporary folder and its session folder (the issuer keeps its own administrator sessions, so the session folder is only information). The doctor changes no mode.

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

`test/site-doctor.js` checks these properties, including that a planted fake key never appears in any response; `test/manual-site-doctor-browser.js` runs the whole page in a browser.

## Limits

- It compares with the commit it was built from, not with whatever is on GitHub now.
- A file that is present but cut short by an interrupted upload is reported as different; the report cannot say which part is wrong.
- The unexpected-file scan stops after 40,000 files or ten seconds and says so. Large web roots (several sites in one folder) may be partial.
- It cannot prove `.htaccess` rules are honoured on every URL; the browser probes cover the important helper files. `tools/studio-live-check.js` and `tools/demo-auth-live-check.js` remain the checks you run from your PC.
- It needs JavaScript in the browser and PHP 7.2 or newer on the server.
- Setting up a domain from scratch is guided, not automatic: the checklist and the copy-and-paste values tell you what to create; nothing is written for you.
