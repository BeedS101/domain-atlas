<?php
if (PHP_SAPI !== 'cli' && isset($_SERVER['SCRIPT_FILENAME']) && realpath($_SERVER['SCRIPT_FILENAME']) === __FILE__) { http_response_code(404); exit; } // include-only
// Domain Atlas — PHP issuer: the domain this issuer is.
//
// The domain is baked into every credential's issuer.domain, checked against the domain named by owners' and
// administrators' signed requests, and used as the relaying identity toward other domains. It must therefore come from
// configuration, never from the request: a Host header is chosen by whoever sends the request, so an issuer that trusted it
// would sign in any name it was addressed by and accept a signed request meant for another domain.
//
// Where it is configured (first one set wins):
//   ATLAS_DOMAIN in the environment (getenv, or a web server setting such as SetEnv, which PHP exposes in $_SERVER);
//   "domain" in lib/atlas-domain-config.json, for hosts where setting an environment variable is awkward. The file is in
//   lib/, which the web server does not serve, and is not state: no deployment is treated as established because of it.
// A value that is set but is not a host name (with an optional port) is a misconfiguration: the issuer stops answering
// rather than fall back to the request. With neither set the issuer keeps its older behaviour, the Host header of the
// request, but refuses a Host that is not a host name, and logs a notice now and then so the operator pins it.

// The lower-cased value when it is a host name (letters, digits, hyphens, dots; an optional :port), else null.
function atlas_normalize_domain($value) {
  if (!is_string($value)) return null;
  $value = strtolower(trim($value));
  $label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
  $port = '(?::[1-9][0-9]{0,4})?';
  if (!preg_match('/^(?:' . $label . '(?:\.' . $label . ')*|\[[0-9a-f:]+\])' . $port . '$/D', $value)) return null;
  if (preg_match('/:([0-9]+)$/', $value, $m) && (int) $m[1] > 65535) return null;
  return $value;
}

function atlas_domain_config_file() {
  return __DIR__ . '/atlas-domain-config.json';
}

// The configured domain: a string when set and valid, null when not configured, false when configured but not a host name.
function atlas_configured_domain() {
  $raw = getenv('ATLAS_DOMAIN');
  if (!is_string($raw) || trim($raw) === '') $raw = $_SERVER['ATLAS_DOMAIN'] ?? ($_SERVER['REDIRECT_ATLAS_DOMAIN'] ?? '');
  if (!is_string($raw) || trim($raw) === '') {
    $file = atlas_domain_config_file();
    $raw = '';
    if (is_file($file)) {
      $doc = json_decode((string) @file_get_contents($file), true);
      if (is_array($doc) && isset($doc['domain'])) $raw = is_string($doc['domain']) ? $doc['domain'] : false;
    }
    if ($raw === '') return null;
  }
  $normalized = atlas_normalize_domain($raw);
  return $normalized === null ? false : $normalized;
}

function atlas_domain_fail($status, $code, $message) {
  if (PHP_SAPI === 'cli') throw new RuntimeException($message);
  http_response_code($status);
  header('Content-Type: application/json');
  echo json_encode(['error' => $message, 'code' => $code]);
  exit;
}

// Logs, at most every six hours, that this issuer has no configured domain.
function atlas_domain_unpinned_notice() {
  $stamp = sys_get_temp_dir() . '/atlas-domain-notice-' . substr(hash('sha256', __DIR__), 0, 16);
  if (is_file($stamp) && time() - (int) @filemtime($stamp) < 21600) return;
  @touch($stamp);
  error_log('atlas: ATLAS_DOMAIN is not set, so this issuer takes its identity from the Host header of each request. Set ATLAS_DOMAIN or lib/atlas-domain-config.json to this domain.');
}

// ATLAS_DOMAIN — baked into every issued credential's issuer.domain field. Get this wrong and re-verification tries to
// fetch the issuer's key from the WRONG domain later.
function atlas_domain() {
  $configured = atlas_configured_domain();
  if ($configured === false) atlas_domain_fail(500, 'misconfigured-domain', 'ATLAS_DOMAIN is set but is not a host name (with an optional port); this issuer will not sign until it is fixed');
  if ($configured !== null) return $configured;
  if (!isset($_SERVER['HTTP_HOST'])) return 'localhost';
  $host = atlas_normalize_domain($_SERVER['HTTP_HOST']);
  if ($host === null) atlas_domain_fail(400, 'unknown-host', 'The Host of this request is not a host name');
  if (PHP_SAPI !== 'cli') atlas_domain_unpinned_notice();
  return $host;
}
