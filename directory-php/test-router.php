<?php
// Test-only router for PHP's built-in dev server (`php -S`), which does not read .htaccess. It applies
// the same clean-URL rule as atlas/directory/.htaccess and refuses the lib/ folder the way
// lib/.htaccess does. Not part of the deployable bundle.
$uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$path = realpath(__DIR__ . $uri);
if ($path !== false && strpos($uri, '/lib/') !== false) { http_response_code(403); echo 'Forbidden'; return true; }
if ($uri !== '/' && !is_file(__DIR__ . $uri) && is_file(__DIR__ . $uri . '.php')) {
  require __DIR__ . $uri . '.php';
  return true;
}
return false;
