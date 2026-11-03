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
3. Tell it what the domain serves (issuer only, demo site A or demo site B; it guesses from the files). Read the report.
4. Fix what it lists, press **Check again**, repeat.
5. Press **Delete this file** (or delete `site-doctor.php` in your file manager). Do not leave it on the server.

## What the report says

**To do** merges everything that needs attention: missing or changed code, setup problems and anything the web can read that it should not.

**Files compared with the repository** groups each file as code (`.php`, `.htaccess`), pages and configuration, or assets (models and images):

- *Missing code* and *different code* are problems: the issuer or Studio can fail with `internal-error` without them.
- *Different pages* may be edits you made on purpose; the doctor only tells you.
- *Different on purpose*: `.well-known/spatial.json` differs on every live site by design (it carries your own worlds and the Studio policy world).
- Text files are compared with Windows line endings (CRLF) folded to Unix ones, so a file uploaded from a Windows checkout does not show as different.
- Optional files (the `README.txt`, the dev router, `txlab/` and the demo sites' own models) are not reported as missing.

**Server and setup** checks the PHP version and extensions, HTTPS, whether `lib/` and `.well-known/` are writable, that `lib/.htaccess` is present, that a published issuer key has its revocation list, the manifest's `studio` world, and Asset Studio's private storage: outside the web root, writable, the five sub-folders present, and `studio-config.json` naming exactly this host.

**Unexpected files** lists files that are not in the repository. Your own models and pages are normal here; it is for awareness. Private state (keys, holdings, replay records, config, `storage-root.php`) is listed by name, mode and size only and is never opened.

**What the web can read** is checked by your browser: the helper includes and the private-key path must not be served. A file that answers with PHP source or a key is reported as exposed.

**Setup values** prints what to create for Asset Studio, filled in for this host: the private folder path, the `storage-root.php` line, a `studio-config.json` with minting off, and the `studio` world for the manifest. The doctor never creates them; you create them in your file manager and press **Check again**.

**Copy report** puts a plain-text report on the clipboard with the web-root and home folder names replaced, suitable for pasting into a chat or an issue.

## What keeps it safe

- The token is 128 random bits; only its SHA-256 is in the file. A wrong token waits 1.5 seconds and returns nothing.
- After the deadline it refuses every check. It can still delete itself with the token.
- Until the token is entered, the page shows no paths, hashes or other manifest data.
- It never prints file contents. It never opens private state files.
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
