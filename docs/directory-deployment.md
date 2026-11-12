# Directory service: deployment guide

The directory (SPEC.md §3.3) crawls manifests that sites submit, indexes
their discoverable worlds and answers searches. It has two
implementations that behave the same way:

| | Node (`directory-server/`) | PHP (`directory-php/`) |
|---|---|---|
| Runs as | one long-lived process | request scripts plus a cron job |
| Storage | one JSON snapshot file | its own SQLite database, outside the web root |
| Crawl | in-process timer | `cron.php` |
| Good for | local demos, a VPS | shared cPanel hosting |

The live sites are shared PHP hosting and cannot keep a Node process
running, so **the PHP port is the one to deploy**. Nothing in the
repository deploys it for you.

## What it does and does not hold

The directory is read-only with respect to credentials. It has no
accounts, no passwords, no keys and no admin interface. It stores a list
of submitted manifest addresses and the public fields it indexed from them.
It has not had an independent security review. Treat the first deployment
as a trial, not a finished product.

## Rules the directory enforces

- Only `https` addresses on public host names are fetched. IP literals,
  `localhost` and unusual ports are refused. Every address a name resolves
  to is checked, and the connection is pinned to the address that was checked.
- Redirects are never followed. Responses are capped at 256 KiB.
- A domain-anchored manifest must be served from
  `/.well-known/spatial.json` on the host it names in `domain`. A manifest
  that claims another domain is rejected, so a site cannot list itself under
  someone else's name.
- A key-anchored manifest must carry a valid signature.
- `/submit` is rate limited per client and the number of tracked manifests
  is capped. Request bodies over 4 KiB are refused.
- Everything is stored through prepared statements in transactions.
- A manifest that fails on its first submission leaves nothing behind. A
  listed manifest is marked stale after 3 failed crawls and dropped after 20.

`DIRECTORY_ALLOW_LOCAL=1` lifts the public-host rules so demos and tests can
crawl `localhost`. **Never set it on a live site.**

## Prerequisites (PHP)

- PHP 7.4 or newer with the `curl`, `openssl` and `pdo_sqlite` extensions.
  (The tests run on PHP 7.4, 8.1 and 8.3.) `pdo_sqlite` is the same extension
  the Chain Labs ledger already uses on the live hosting.
- https on the domain.
- Cron access (cPanel, Cron Jobs).
- Apache with `.htaccess` honoured.

## Upload

Upload the contents of `directory-php/atlas/directory/` to
`atlas/directory/` on the chosen domain, so the page is
`https://DOMAIN/atlas/directory/`. That folder contains `index.html`,
`submit.php`, `search.php`, `stats.php`, `cron.php`, `.htaccess` and `lib/`.

Do **not** upload `directory-php/test-router.php` (tests only), any
`atlas-directory.sqlite*` or `atlas-directory-secret` file, or anything else
that was produced by running the service locally.

`lib/.htaccess` denies all web access to `lib/`. Check this after uploading
(see Verification).

## The database

The directory keeps everything in one SQLite file of its own,
`atlas-directory.sqlite`. It is a separate database from the issuers' and from
Chain Labs: it never opens or shares their files. Three tables hold it all:
`manifests` (each submitted address and its crawl state), `worlds` (what was
indexed from them) and `submit_limits` (one row per accepted submission, keyed
by a hash of the client, for the hourly limit). The file is created on first
use and every change is one transaction.

Create a folder for it **outside the web root**, beside `public_html`:

```
/home/ACCOUNT/atlas-directory-private/
```

The directory finds a folder with that name next to the web root by itself.
To use another place, set `dataDir` below. The folder must be writable by the
PHP user (and by the cron job, which runs as the same account). Two files are
created in it: `atlas-directory.sqlite` and `atlas-directory-secret`, the key
used to hash client addresses, readable by the account only.

If the data directory is inside the web server's document root, or cannot be
found, the directory refuses to run and logs why; it never falls back to a
folder that could be downloaded. Back up the folder like any other data; the
index can also simply be rebuilt by resubmitting the manifests.

## Settings

Everything has a default. To change something, create
`lib/atlas-directory-config.json`:

```json
{
  "crawlIntervalSeconds": 21600,
  "maxManifests": 500,
  "submitsPerHour": 20,
  "dataDir": "/home/ACCOUNT/atlas-directory-private",
  "trustProxy": false,
  "blocked": []
}
```

- `dataDir` is where the database lives (see above). Leave it out to use
  `atlas-directory-private` beside the web root.
- `trustProxy` only if the host puts a proxy in front of PHP and passes the
  client address in `X-Forwarded-For`. Leave it off otherwise, or the rate
  limit can be sidestepped.
- `blocked` is a list of domains (or identity keys) the directory will not
  list. A blocked site is refused on submission and dropped on its next crawl.
  Use it for takedowns.
- Do not put `allowLocal` in this file on a live site.

The same names can be given as environment variables (`DIRECTORY_*`), which
win over the file.

## Cron job

In cPanel, Cron Jobs, add (adjust the path and PHP binary):

```
*/15 * * * * php /home/ACCOUNT/public_html/atlas/directory/cron.php
```

Running every 15 minutes is fine: the script only fetches manifests that
are due according to `crawlIntervalSeconds` (6 hours by default) and does
nothing otherwise. It prints one summary line per run, and it answers 404 if
requested over the web.

## Verification

After uploading:

1. `https://DOMAIN/atlas/directory/stats.php` returns JSON with zero
   manifests. (An error here usually means the data folder is missing or not
   writable; the reason is in the PHP error log.) `atlas-directory.sqlite`
   now exists in the private folder.
2. `https://DOMAIN/atlas/directory/lib/bootstrap.php` returns 403 (or 404).
   If it returns anything else, stop and fix the `.htaccess` first.
3. `https://DOMAIN/atlas/directory/cron.php` returns 404.
4. Submit the site's own manifest from the page (or with
   `curl -X POST https://DOMAIN/atlas/directory/submit -H "Content-Type: application/json" -d '{"manifest":"https://DOMAIN/.well-known/spatial.json"}'`).
   The reply reports how many worlds were indexed.
5. Search for one of its worlds on the page.
6. Run the cron command once by hand and check the summary line.

## The directory page

`index.html` lists **sites**, not single worlds: one compact row per domain
(or, for a key-anchored manifest, per verified identity key, never an invented
domain) with its world count, genres, scales and how many sites link to it. The
button on the right of a row (or the row itself) opens the site's worlds, with
their descriptions, genres, access rules and portals. The page asks
`search?groupBy=site`, which pages by site and reports `count` (sites) and
`worldCount` (matching worlds in all pages), so the totals are right however
many sites there are. Without `groupBy` the endpoint still returns the flat,
paged list of worlds, now with each world's `portals` as well.

The page and the PHP files go together: upload `index.html`, `search.php` and
`lib/` in the same step when updating. The new page tells you if it is talking
to an older directory. No data changes and no cron changes are involved.

## Which worlds will appear

Only worlds whose manifest marks them `discoverable` are indexed. Live
manifests are served from the live domains' own `/.well-known/spatial.json`.
To list them, submit each domain's manifest address once. Domains whose
worlds are all non-discoverable will submit successfully and show nothing,
which is the intended behaviour.

## Tests (run locally, never against live sites)

```bash
node test/verify-directory.js                       # Node, self-contained
DIRECTORY_IMPL=php node test/verify-directory.js    # PHP
node test/verify-directory-security.js              # Node, about 70 checks
DIRECTORY_IMPL=php node test/verify-directory-security.js
node test/verify-directory-rebinding.js             # Node: DNS rebinding
php test/verify-directory-rebinding.php             # PHP: DNS rebinding
php test/verify-directory-storage.php               # PHP: the SQLite storage
node test/manual-directory-groups.js                # the page, in headless Chromium (needs playwright; DIRECTORY_IMPL=php for PHP)
```

Each run starts its own throw-away directory and manifest servers on local
ports. The workflow `.github/workflows/directory.yml` runs the PHP versions
of all of these on PHP 7.4, 8.1 and 8.3 (and the Node ones once), only when
the directory or its tests change. A PHP run is refused unless the server
process itself reports the expected PHP version (`DIRECTORY_EXPECT_PHP`), so
a job cannot pass while testing a different PHP.

The storage test checks the schema, that a failed change leaves nothing
behind, that hostile text is stored and searched as plain text, that the
database is refused inside the web root, and that the rate limit and the
manifest limit hold when many PHP processes hit the same file at once.

The rebinding tests check that a public-looking name resolving to a private,
loopback, link-local or mixed set of addresses is refused before any
connection, and that the connection goes to the address that was checked
(a changed second answer is never used). They use made-up lookup answers and
make no request to any real domain. What they cannot show is the behaviour
of a real resolver on a real host, so the first run on the test subdomain
should include the checks in the Verification section above.

## Later ideas

- A "Discover worlds" search in the wallet that queries a chosen directory.
- Pointing several directories at the same public manifests; anyone may run
  a competing one.
