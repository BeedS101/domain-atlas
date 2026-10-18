<?php
// Test-only router for `php -S`: behaves like test-router.php, and additionally refuses (403) any
// file under a directory whose .htaccess says "Require all denied" / "Deny from all", the way
// Apache does when it honours .htaccess. It emulates the effect of those two lines only; it is not
// Apache, and the real check is made over HTTP against the real host (tools/gen1-php-smoke.js).
$uri = rawurldecode(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH));
$root = __DIR__;
$dir = rtrim(dirname($root . $uri . 'x'), '/');
while (strlen($dir) >= strlen($root)) {
  $ht = $dir . '/.htaccess';
  if (is_file($ht) && preg_match('/Require all denied|Deny from all/i', (string) file_get_contents($ht))) {
    http_response_code(403);
    echo 'Forbidden';
    return true;
  }
  if ($dir === $root) break;
  $dir = dirname($dir);
}
$path = $root . $uri;
if ($uri !== '/' && !is_file($path) && is_file($path . '.php')) {
  require $path . '.php';
  return true;
}
return false;
