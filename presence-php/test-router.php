<?php
// Test-only router for PHP's built-in dev server (`php -S`), which doesn't
// read .htaccess/mod_rewrite. Mimics presence/.htaccess's one rule closely
// enough to exercise the exact same clean URLs (/presence/poll/join etc.)
// the real Apache deployment and the extension both use — this file is
// NOT part of the deployable bundle, it's scaffolding for manual-
// presence-php.js only.
$uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$path = __DIR__ . $uri;
if ($uri !== '/' && !is_file($path) && is_file($path . '.php')) {
  require $path . '.php';
  return true;
}
return false;
