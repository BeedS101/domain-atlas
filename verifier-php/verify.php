<?php
// Domain Atlas credential verifier: HTTP entry point.
//
//   GET  verify.php   package name, version and whether it is configured
//   POST verify.php   body {"credential": {...}} (or the credential itself); answers the verdict as JSON
//
// The verdict is in the JSON body ("valid", "status", "code", "reason"). HTTP 200 means the check ran, not that the
// credential is good. Nothing is written, stored or cached. The issuers to trust come from config.php, never from a request.
require __DIR__ . '/lib/atlas-verify.php';

use function DomainAtlas\Verify\load_trust_config;
use function DomainAtlas\Verify\verify_decoded_credential;
use function DomainAtlas\Verify\verdict;
use function DomainAtlas\Verify\blank_checks;
use function DomainAtlas\Verify\parse_origin;
use const DomainAtlas\Verify\VERSION;

function atlas_verify_send($status, $body, $cors = null) {
  http_response_code($status);
  header('Content-Type: application/json; charset=utf-8');
  header('Cache-Control: no-store');
  header('X-Content-Type-Options: nosniff');
  header('Referrer-Policy: no-referrer');
  if ($cors !== null) {
    header('Access-Control-Allow-Origin: ' . $cors);
    header('Vary: Origin');
    header('Access-Control-Allow-Methods: POST, GET, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, Authorization');
  }
  echo json_encode($body, JSON_UNESCAPED_SLASHES);
  exit;
}

function atlas_verify_failure($status, $code, $reason, $verdictStatus) {
  $context = ['now' => microtime(true)];
  atlas_verify_send($status, verdict($verdictStatus, $code, $reason, $context, blank_checks()));
}

$config = null;
$configFile = __DIR__ . '/config.php';
if (is_file($configFile)) {
  $loaded = include $configFile;
  if (is_array($loaded)) $config = $loaded;
}
$trusted = $config !== null ? load_trust_config($config) : ['issuers' => [], 'errors' => ['config.php is missing']];
$configured = count($trusted['errors']) === 0 && count($trusted['issuers']) > 0;

$cors = null;
$requestOrigin = isset($_SERVER['HTTP_ORIGIN']) ? $_SERVER['HTTP_ORIGIN'] : '';
if ($requestOrigin !== '' && $config !== null && isset($config['allowedOrigins']) && is_array($config['allowedOrigins']) && in_array($requestOrigin, $config['allowedOrigins'], true)) {
  $cors = $requestOrigin;
}

$method = isset($_SERVER['REQUEST_METHOD']) ? $_SERVER['REQUEST_METHOD'] : 'GET';
if ($method === 'OPTIONS') atlas_verify_send(204, null, $cors);

if ($method === 'GET') {
  atlas_verify_send(200, [
    'package' => 'atlas-verify',
    'version' => VERSION,
    'configured' => $configured,
    'trustedIssuers' => $configured ? array_values(array_map(function ($i) { return $i['origin']; }, $trusted['issuers'])) : [],
  ], $cors);
}
if ($method !== 'POST') atlas_verify_failure(405, 'method-not-allowed', 'use POST', 'invalid');

if (!$configured) atlas_verify_failure(503, 'not-configured', 'the verifier has no valid trusted-issuer configuration, so it refuses every credential', 'unavailable');

$tokenHash = isset($config['accessTokenSha256']) ? $config['accessTokenSha256'] : null;
if ($tokenHash !== null) {
  $header = isset($_SERVER['HTTP_AUTHORIZATION']) ? $_SERVER['HTTP_AUTHORIZATION'] : '';
  $given = preg_match('/^Bearer (\S{1,512})$/', $header, $m) ? $m[1] : '';
  if (!is_string($tokenHash) || !preg_match('/^[0-9a-f]{64}$/', $tokenHash) || !hash_equals($tokenHash, hash('sha256', $given))) {
    header('WWW-Authenticate: Bearer');
    atlas_verify_failure(401, 'unauthorized', 'a valid access token is required', 'invalid');
  }
}

$limit = isset($config['maxBodyBytes']) && is_int($config['maxBodyBytes']) ? min($config['maxBodyBytes'], 1048576) : 262144;
$declared = isset($_SERVER['CONTENT_LENGTH']) ? (int) $_SERVER['CONTENT_LENGTH'] : 0;
if ($declared > $limit) atlas_verify_failure(413, 'too-large', 'the request body is too large', 'invalid');
$raw = file_get_contents('php://input', false, null, 0, $limit + 1);
if (!is_string($raw) || $raw === '' || strlen($raw) > $limit) atlas_verify_failure(strlen((string) $raw) > $limit ? 413 : 400, 'bad-request', 'send the credential as a JSON body of reasonable size', 'invalid');

$body = json_decode($raw, false, 64);
if (!($body instanceof stdClass)) atlas_verify_failure(400, 'bad-request', 'the body is not a JSON object', 'invalid');
$credential = (isset($body->credential) && $body->credential instanceof stdClass) ? $body->credential : $body;

$domain = (isset($credential->issuer) && $credential->issuer instanceof stdClass && isset($credential->issuer->domain) && is_string($credential->issuer->domain)) ? strtolower($credential->issuer->domain) : '';
$trust = isset($trusted['issuers'][$domain]) ? $trusted['issuers'][$domain] : null;

if ($trust !== null && isset($body->expectIssuer)) {
  $expected = parse_origin($body->expectIssuer);
  if ($expected === null || $expected['origin'] !== $trust['origin']) $trust = null;
}

atlas_verify_send(200, verify_decoded_credential($credential, $trust), $cors);
