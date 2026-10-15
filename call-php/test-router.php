<?php
// Router for PHP's built-in development server (`php -S`), which does not read .htaccess. It
// reproduces the two rules of atlas/call/.htaccess and atlas/call/lib/.htaccess closely
// enough to exercise the same clean URLs: /atlas/call/listen is served by listen.php, and
// nothing under lib/ is served. It is test scaffolding and is not uploaded to a web host.
$uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if (preg_match('#/lib(/|$)#', $uri)) {
  http_response_code(403);
  header('Content-Type: text/plain');
  echo 'Forbidden';
  return true;
}
$path = __DIR__ . $uri;
if ($uri !== '/' && !is_file($path) && !is_dir($path) && is_file($path . '.php')) {
  require $path . '.php';
  return true;
}
return false;
