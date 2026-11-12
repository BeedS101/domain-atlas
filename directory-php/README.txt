Domain Atlas directory, PHP port (SPEC.md section 3.3)
=======================================================

For shared cPanel hosting, where a long-lived Node process cannot run.
Same endpoints and rules as directory-server/server.js:

  POST submit.php   {"manifest": "https://host/.well-known/spatial.json"}
  GET  search.php   ?q= &scale= &combat= &genre= &anchorType= &identityRequired= &limit= &offset=
  GET  stats.php
  CLI  cron.php     the scheduled crawl (404 over the web)

Upload only the contents of atlas/directory/ (not test-router.php).
Full instructions, settings, the cron line and verification steps:
docs/directory-deployment.md

Needs PHP 7.4+ with curl, openssl and pdo_sqlite. Data is kept in a SQLite
database of its own (atlas-directory.sqlite) in a folder OUTSIDE the web root:
create atlas-directory-private beside public_html, or set dataDir. The
directory refuses to run if that folder is inside the web root.
Tests: DIRECTORY_IMPL=php node test/verify-directory.js
       DIRECTORY_IMPL=php node test/verify-directory-security.js
       php test/verify-directory-rebinding.php
       php test/verify-directory-storage.php
