<?php
namespace DomainAtlas\Verify;

if (PHP_SAPI !== 'cli' && isset($_SERVER['SCRIPT_FILENAME']) && realpath($_SERVER['SCRIPT_FILENAME']) === __FILE__) { http_response_code(404); exit; } // include-only

// Reads one published document over HTTP(S). The only network code in the package, and it is read-only:
// GET, no cookies, no redirects, a hard size cap and short timeouts. It is handed a complete URL that the
// caller built from a configured issuer origin; it never derives a host from a credential.
//
// Returns ['status' => int, 'body' => string|null, 'error' => string|null, 'tooLarge' => bool].
// status is 0 when no HTTP answer was received.
const USER_AGENT = 'DomainAtlas-Verify/0.1';
const FETCH_TIMEOUT_SECONDS = 10;
const FETCH_CONNECT_TIMEOUT_SECONDS = 5;

function fetch_document($url, $maxBytes, $allowPlainHttp) {
  $result = ['status' => 0, 'body' => null, 'error' => null, 'tooLarge' => false];
  $scheme = strtolower((string) parse_url($url, PHP_URL_SCHEME));
  if ($scheme !== 'https' && !($scheme === 'http' && $allowPlainHttp)) {
    $result['error'] = 'refusing a non-HTTPS URL';
    return $result;
  }
  if (function_exists('curl_init')) {
    $body = '';
    $tooLarge = false;
    $ch = curl_init($url);
    $options = [
      CURLOPT_HTTPGET => true,
      CURLOPT_HTTPHEADER => ['User-Agent: ' . USER_AGENT, 'Accept: application/json'],
      CURLOPT_RETURNTRANSFER => false,
      CURLOPT_FOLLOWLOCATION => false,
      CURLOPT_CONNECTTIMEOUT => FETCH_CONNECT_TIMEOUT_SECONDS,
      CURLOPT_TIMEOUT => FETCH_TIMEOUT_SECONDS,
      CURLOPT_SSL_VERIFYPEER => true,
      CURLOPT_SSL_VERIFYHOST => 2,
      CURLOPT_WRITEFUNCTION => function ($handle, $chunk) use (&$body, &$tooLarge, $maxBytes) {
        if (strlen($body) + strlen($chunk) > $maxBytes) { $tooLarge = true; return 0; }
        $body .= $chunk;
        return strlen($chunk);
      },
    ];
    if (defined('CURLOPT_PROTOCOLS') && defined('CURLPROTO_HTTPS')) {
      $options[CURLOPT_PROTOCOLS] = $allowPlainHttp ? (CURLPROTO_HTTPS | CURLPROTO_HTTP) : CURLPROTO_HTTPS;
    }
    curl_setopt_array($ch, $options);
    $ok = curl_exec($ch);
    $result['status'] = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $error = curl_error($ch);
    curl_close($ch);
    if ($tooLarge) { $result['tooLarge'] = true; $result['error'] = 'document is larger than the verifier reads'; return $result; }
    if ($ok === false) { $result['error'] = $error !== '' ? $error : 'request failed'; return $result; }
    $result['body'] = $body;
    return $result;
  }
  if (!filter_var(ini_get('allow_url_fopen'), FILTER_VALIDATE_BOOLEAN)) {
    $result['error'] = 'neither the curl extension nor allow_url_fopen is available';
    return $result;
  }
  $context = stream_context_create([
    'http' => ['method' => 'GET', 'header' => "User-Agent: " . USER_AGENT . "\r\nAccept: application/json\r\n", 'ignore_errors' => true, 'follow_location' => 0, 'timeout' => FETCH_TIMEOUT_SECONDS],
    'ssl' => ['verify_peer' => true, 'verify_peer_name' => true],
  ]);
  $raw = @file_get_contents($url, false, $context, 0, $maxBytes + 1);
  $headers = function_exists('http_get_last_response_headers') ? http_get_last_response_headers() : (isset($http_response_header) ? $http_response_header : []);
  if ($raw === false) { $result['error'] = 'request failed'; return $result; }
  foreach ((array) $headers as $header) {
    if (preg_match('#^HTTP/\S+\s+(\d+)#', $header, $m)) $result['status'] = (int) $m[1];
  }
  if (strlen($raw) > $maxBytes) { $result['tooLarge'] = true; $result['error'] = 'document is larger than the verifier reads'; return $result; }
  $result['body'] = $raw;
  return $result;
}
