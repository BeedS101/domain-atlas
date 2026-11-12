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

Needs PHP 7.4+ with curl and openssl. Data is stored as JSON files with
flock (default: lib/, which .htaccess denies to the web).
Tests: DIRECTORY_IMPL=php node test/verify-directory.js
       DIRECTORY_IMPL=php node test/verify-directory-security.js
