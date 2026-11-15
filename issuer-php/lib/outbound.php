<?php
if (PHP_SAPI !== 'cli' && isset($_SERVER['SCRIPT_FILENAME']) && realpath($_SERVER['SCRIPT_FILENAME']) === __FILE__) { http_response_code(404); exit; } // include-only
// The one policy for this server's requests to other domains (relays, key and revocation discovery). Mirrors
// issuer-server/lib-outbound.js rule for rule.
//
//   - A peer is a domain authority (host or host:port), never a URL: no scheme, userinfo, path, query or fragment.
//   - A public domain is reached over https on the default port, by DNS name. Loopback, private, link-local, shared,
//     multicast, reserved and cloud-metadata destinations are refused, judged on every address the name resolves to,
//     and the connection is pinned (CURLOPT_RESOLVE) to an address that passed that check.
//   - Local development is an explicit mode (PHP's built-in development server, or ATLAS_ALLOW_LOCAL_PEERS=1): then, and
//     only then, a loopback peer is reached over plain http. A production host never reaches loopback.
//   - Redirects are not followed; a request has connect and total time limits and a response size limit.
//   - Requests are rate limited per remote domain and overall, counting every attempt, failures included, before any
//     connection is made.
//   - A failure's message is safe to send to a client (it names the peer the client supplied and a short category);
//     the underlying detail is logged and kept in ->detail.

// Every request to another domain identifies itself: a receiving host's bot protection often blocks one with no
// User-Agent, and its admin can see what this is.
const ATLAS_OUTBOUND_USER_AGENT = 'DomainAtlas-Relay/1.0';

class AtlasOutboundException extends Exception {
  public $outboundCode;
  public $detail;
  public function __construct($message, $code, $detail = null) {
    parent::__construct($message);
    $this->outboundCode = $code;
    $this->detail = $detail;
  }
}

// Tests only, never read from the environment: ['resolve' => fn(hostname) => [ip, ...], 'connect' => fn(peer, ip) => ['ip' =>, 'port' =>, 'cainfo' =>]].
$GLOBALS['atlas_outbound_test_hooks'] = [];

function atlas_outbound_ipv6_bytes($ip) {
  $bin = @inet_pton($ip);
  if ($bin === false || strlen($bin) !== 16) return null;
  return array_values(unpack('C*', $bin));
}

// True only for an address a public peer may have.
function atlas_outbound_is_public_address($ip) {
  if (!is_string($ip)) return false;
  if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) {
    list($a, $b, $c) = array_map('intval', explode('.', $ip));
    if ($a === 0 || $a === 10 || $a === 127 || $a >= 224) return false;
    if ($a === 100 && $b >= 64 && $b <= 127) return false;
    if ($a === 169 && $b === 254) return false;
    if ($a === 172 && $b >= 16 && $b <= 31) return false;
    if ($a === 192 && $b === 168) return false;
    if ($a === 192 && $b === 0 && ($c === 0 || $c === 2)) return false;
    if ($a === 192 && $b === 88 && $c === 99) return false;
    if ($a === 198 && ($b === 18 || $b === 19)) return false;
    if ($a === 198 && $b === 51 && $c === 100) return false;
    if ($a === 203 && $b === 0 && $c === 113) return false;
    return true;
  }
  if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV6)) {
    $b = atlas_outbound_ipv6_bytes($ip);
    if ($b === null) return false;
    $zeroPrefix = true;
    for ($i = 0; $i < 10; $i++) if ($b[$i] !== 0) { $zeroPrefix = false; break; }
    if ($zeroPrefix && $b[10] === 0xff && $b[11] === 0xff) return atlas_outbound_is_public_address($b[12] . '.' . $b[13] . '.' . $b[14] . '.' . $b[15]);
    if ($zeroPrefix) return false; // ::, ::1 and the IPv4-compatible forms
    if (($b[0] & 0xfe) === 0xfc) return false; // fc00::/7, which holds fd00:ec2::254
    if ($b[0] === 0xfe) return false; // link-local fe80::/10 and the deprecated site-local range
    if ($b[0] === 0xff) return false; // multicast
    if ($b[0] === 0x20 && $b[1] === 0x01 && (($b[2] === 0x0d && $b[3] === 0xb8) || ($b[2] === 0 && $b[3] === 0))) return false; // documentation, Teredo
    if ($b[0] === 0x20 && $b[1] === 0x02) return false; // 6to4
    if ($b[0] === 0x00 && $b[1] === 0x64 && $b[2] === 0xff && $b[3] === 0x9b) return false; // NAT64
    return true;
  }
  return false;
}

function atlas_outbound_is_loopback_address($ip) {
  if (!is_string($ip)) return false;
  if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) return explode('.', $ip)[0] === '127';
  $b = atlas_outbound_ipv6_bytes($ip);
  if ($b === null) return false;
  $zeros15 = true;
  for ($i = 0; $i < 15; $i++) if ($b[$i] !== 0) { $zeros15 = false; break; }
  if ($zeros15 && $b[15] === 1) return true;
  $zeros10 = true;
  for ($i = 0; $i < 10; $i++) if ($b[$i] !== 0) { $zeros10 = false; break; }
  return $zeros10 && $b[10] === 0xff && $b[11] === 0xff && $b[12] === 127;
}

function atlas_outbound_is_local_host_name($host) {
  return in_array($host, ['localhost', '127.0.0.1', '[::1]'], true) || substr($host, -10) === '.localhost';
}

// Splits a peer authority into its parts, or throws an AtlasOutboundException. $allowLocal admits loopback names over http.
function atlas_outbound_parse_peer($text, $allowLocal) {
  $bad = function ($why) { return new AtlasOutboundException('not an acceptable domain', 'peer-invalid', $why); };
  if (!is_string($text) || $text === '' || strlen($text) > 255) throw $bad('not a string of a sensible length');
  if (!preg_match('/^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?$/D', $text, $m)) throw $bad('not a plain host or host:port');
  $hostname = strtolower($m[1]);
  $port = isset($m[2]) && $m[2] !== '' ? (int) $m[2] : null;
  if ($port !== null && ($port < 1 || $port > 65535)) throw $bad('port out of range');
  if ($allowLocal && atlas_outbound_is_local_host_name($hostname)) {
    return ['authority' => $hostname . ($port !== null ? ':' . $port : ''), 'hostname' => $hostname, 'port' => $port !== null ? $port : 80, 'scheme' => 'http', 'local' => true];
  }
  if ($hostname[0] === '[' || filter_var($hostname, FILTER_VALIDATE_IP)) throw $bad('an address, not a domain name');
  if (strlen($hostname) > 253 || !preg_match('/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/D', $hostname)
    || atlas_outbound_is_local_host_name($hostname)) throw $bad('not a public domain name');
  foreach (['.local', '.localdomain', '.internal', '.intranet', '.lan', '.home.arpa', '.corp'] as $suffix) {
    if (substr($hostname, -strlen($suffix)) === $suffix) throw $bad('not a public domain name');
  }
  $tld = substr($hostname, strrpos($hostname, '.') + 1);
  if (ctype_digit($tld)) throw $bad('a numeric host');
  if ($port !== null && $port !== 443) throw $bad('only the default https port is accepted');
  return ['authority' => $hostname, 'hostname' => $hostname, 'port' => 443, 'scheme' => 'https', 'local' => false];
}

// Loopback peers are for local development only. atlas_domain() cannot decide this here: it is read from the request's
// Host header, which a client controls. What does decide it is how the server was started: PHP's built-in development
// server (never a production SAPI), or ATLAS_ALLOW_LOCAL_PEERS=1; ATLAS_ALLOW_LOCAL_PEERS=0 turns it off even there.
function atlas_outbound_allow_local() {
  $flag = getenv('ATLAS_ALLOW_LOCAL_PEERS');
  if ($flag === '0') return false;
  return $flag === '1' || PHP_SAPI === 'cli-server';
}

function atlas_outbound_env_number($name, $fallback) {
  $v = getenv($name);
  return is_string($v) && is_numeric($v) && (float) $v > 0 ? (float) $v : $fallback;
}

function atlas_outbound_rate_file() {
  return __DIR__ . '/atlas-outbound-rate-store.json';
}

// Counts every attempt against a per-domain and an overall budget over a sliding window, in a file shared by all
// requests (each PHP request is its own process). Returns false when the budget is spent.
function atlas_outbound_rate_take($authority, $kind) {
  $window = (int) atlas_outbound_env_number('ATLAS_OUTBOUND_RATE_WINDOW_MS', 60000);
  if ($kind === 'key') {
    $perAuthority = (int) atlas_outbound_env_number('ATLAS_OUTBOUND_KEY_RATE', 20);
    $overall = (int) atlas_outbound_env_number('ATLAS_OUTBOUND_KEY_RATE_ALL', 120);
  } else {
    $kind = 'other';
    $perAuthority = (int) atlas_outbound_env_number('ATLAS_OUTBOUND_RATE', 120);
    $overall = (int) atlas_outbound_env_number('ATLAS_OUTBOUND_RATE_ALL', 600);
  }
  $now = (int) round(microtime(true) * 1000);
  $fh = @fopen(atlas_outbound_rate_file(), 'c+');
  if ($fh === false) return false; // cannot record attempts, so cannot bound them: refuse
  flock($fh, LOCK_EX);
  $doc = json_decode(stream_get_contents($fh), true);
  if (!is_array($doc)) $doc = [];
  $bucket = isset($doc[$kind]) && is_array($doc[$kind]) ? $doc[$kind] : ['all' => [], 'by' => []];
  $keep = function ($list) use ($now, $window) {
    return array_values(array_filter(is_array($list) ? $list : [], function ($t) use ($now, $window) { return is_int($t) && $now - $t < $window; }));
  };
  $all = $keep($bucket['all'] ?? []);
  $by = [];
  foreach (($bucket['by'] ?? []) as $name => $list) {
    $kept = $keep($list);
    if ($kept) $by[$name] = $kept;
  }
  $mine = $by[$authority] ?? [];
  $ok = count($mine) < $perAuthority && count($all) < $overall;
  if ($ok) {
    $mine[] = $now;
    $all[] = $now;
    $by[$authority] = $mine;
  }
  $doc[$kind] = ['all' => $all, 'by' => $by];
  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($doc));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  return $ok;
}

// A peer's published key is remembered briefly, in a file shared by all requests, so a burst of messages or claims from
// one domain costs one lookup instead of one per message (the lookups are rate limited). Failures are never remembered.
// A key a peer rotates out is trusted for at most this long; ATLAS_OUTBOUND_KEY_CACHE_MS=0 turns the memory off.
// Revocation documents are not cached.
function atlas_outbound_key_cache_file() {
  return __DIR__ . '/atlas-outbound-key-cache.json';
}

function atlas_outbound_key_cache_ms() {
  $v = getenv('ATLAS_OUTBOUND_KEY_CACHE_MS');
  return is_string($v) && is_numeric($v) && (float) $v >= 0 ? (int) $v : 60000;
}

function atlas_outbound_key_cache_get($domain) {
  if (atlas_outbound_key_cache_ms() <= 0 || !is_string($domain)) return null;
  $raw = @file_get_contents(atlas_outbound_key_cache_file());
  $doc = $raw === false ? null : json_decode($raw, true);
  $hit = is_array($doc) ? ($doc[strtolower($domain)] ?? null) : null;
  $now = (int) round(microtime(true) * 1000);
  return is_array($hit) && is_string($hit['key'] ?? null) && is_int($hit['until'] ?? null) && $hit['until'] > $now ? $hit['key'] : null;
}

function atlas_outbound_key_cache_put($domain, $key) {
  $ttl = atlas_outbound_key_cache_ms();
  if ($ttl <= 0 || !is_string($domain) || !is_string($key)) return;
  $now = (int) round(microtime(true) * 1000);
  $fh = @fopen(atlas_outbound_key_cache_file(), 'c+');
  if ($fh === false) return;
  flock($fh, LOCK_EX);
  $doc = json_decode(stream_get_contents($fh), true);
  $live = [];
  foreach (is_array($doc) ? $doc : [] as $name => $e) if (is_array($e) && is_int($e['until'] ?? null) && $e['until'] > $now) $live[$name] = $e;
  $live[strtolower($domain)] = ['key' => $key, 'until' => $now + $ttl];
  while (count($live) > 256) { reset($live); unset($live[key($live)]); }
  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($live));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
}

function atlas_outbound_resolve($hostname) {
  $hooks = $GLOBALS['atlas_outbound_test_hooks'];
  if (!empty($hooks['resolve'])) return array_values($hooks['resolve']($hostname));
  $bare = trim($hostname, '[]');
  if (filter_var($bare, FILTER_VALIDATE_IP)) return [$bare];
  $ips = [];
  if (function_exists('dns_get_record')) {
    $records = @dns_get_record($bare, DNS_A | DNS_AAAA);
    if (is_array($records)) foreach ($records as $r) {
      if (!empty($r['ip'])) $ips[] = $r['ip'];
      elseif (!empty($r['ipv6'])) $ips[] = $r['ipv6'];
    }
  }
  if (!$ips) {
    $v4 = @gethostbynamel($bare);
    if (is_array($v4)) $ips = $v4;
  }
  return array_values(array_unique($ips));
}

// The address a connection may use: every address the name resolved to has to pass, so a name that answers with a mix
// of public and internal addresses is refused outright.
function atlas_outbound_checked_address($peer) {
  $ips = atlas_outbound_resolve($peer['hostname']);
  if (!$ips) throw new AtlasOutboundException('could not reach ' . $peer['authority'], 'unreachable', 'host name did not resolve');
  foreach ($ips as $ip) {
    $ok = $peer['local'] ? atlas_outbound_is_loopback_address($ip) : atlas_outbound_is_public_address($ip);
    if (!$ok) throw new AtlasOutboundException('not an acceptable domain', 'peer-invalid', 'resolves to a non-public address');
  }
  usort($ips, function ($a, $b) { return (strpos($a, ':') === false ? 0 : 1) - (strpos($b, ':') === false ? 0 : 1); });
  return $ips[0];
}

// One request to another domain. Returns ['status' => int, 'raw' => string] for any completed response (a caller needs
// to see why the other domain refused something) and throws AtlasOutboundException otherwise. $kind 'key' is published-
// key discovery, the cheapest thing a stranger can make this server do; everything else is 'other'.
function atlas_peer_request($method, $domain, $pathAndQuery, $jsonBody = null, $kind = 'other', $maxBytes = null) {
  $peer = atlas_outbound_parse_peer($domain, atlas_outbound_allow_local());
  if (!is_string($pathAndQuery) || $pathAndQuery === '' || $pathAndQuery[0] !== '/' || preg_match('/[\x00-\x20\x7f\\\\]/', $pathAndQuery)) {
    throw new AtlasOutboundException('not an acceptable request', 'path-invalid');
  }
  if (!atlas_outbound_rate_take($peer['authority'], $kind)) {
    throw new AtlasOutboundException('too many requests to other domains just now; try again shortly', 'rate-limited');
  }
  $fail = function ($e) use ($peer) {
    if ($e->detail) error_log('atlas outbound to ' . $peer['authority'] . ' refused: ' . $e->detail);
    return $e;
  };
  try {
    $ip = atlas_outbound_checked_address($peer);
  } catch (AtlasOutboundException $e) {
    throw $fail($e);
  }
  if (!function_exists('curl_init')) {
    throw new AtlasOutboundException('could not reach ' . $peer['authority'], 'unreachable', 'the curl extension is needed for pinned outbound requests');
  }
  $hooks = $GLOBALS['atlas_outbound_test_hooks'];
  $connect = !empty($hooks['connect']) ? $hooks['connect']($peer, $ip) : ['ip' => $ip, 'port' => $peer['port']];
  $max = $maxBytes !== null ? (int) $maxBytes : (int) atlas_outbound_env_number('ATLAS_OUTBOUND_MAX_BYTES', 4 * 1024 * 1024);
  $timeout = (int) ceil(atlas_outbound_env_number('ATLAS_OUTBOUND_TIMEOUT_MS', 10000) / 1000);
  $defaultPort = $peer['scheme'] === 'https' ? 443 : 80;
  $url = $peer['scheme'] . '://' . $peer['hostname'] . ($peer['port'] !== $defaultPort ? ':' . $peer['port'] : '') . $pathAndQuery;
  $pin = strpos($connect['ip'], ':') !== false ? '[' . $connect['ip'] . ']' : $connect['ip'];
  $headers = ['User-Agent: ' . ATLAS_OUTBOUND_USER_AGENT, 'Accept: application/json', 'Host: ' . $peer['hostname'] . ($peer['port'] !== $defaultPort ? ':' . $peer['port'] : '')];
  if ($jsonBody !== null) $headers[] = 'Content-Type: application/json';
  $body = '';
  $tooBig = false;
  $status = 0;
  $ch = curl_init($url);
  $opts = [
    CURLOPT_CUSTOMREQUEST => $method,
    CURLOPT_HTTPHEADER => $headers,
    CURLOPT_RESOLVE => [trim($peer['hostname'], '[]') . ':' . $connect['port'] . ':' . $pin],
    CURLOPT_PORT => $connect['port'],
    CURLOPT_FOLLOWLOCATION => false,
    CURLOPT_PROXY => '', // a proxy named in the environment would bypass the address that was checked
    CURLOPT_NOPROXY => '*',
    CURLOPT_PROTOCOLS => $peer['scheme'] === 'https' ? CURLPROTO_HTTPS : CURLPROTO_HTTP,
    CURLOPT_REDIR_PROTOCOLS => 0,
    CURLOPT_CONNECTTIMEOUT => min(5, $timeout),
    CURLOPT_TIMEOUT => $timeout,
    CURLOPT_SSL_VERIFYPEER => true,
    CURLOPT_SSL_VERIFYHOST => 2,
    CURLOPT_HEADERFUNCTION => function ($ch, $line) use (&$status, &$tooBig, $max) {
      if (preg_match('~^HTTP/\S+\s+(\d{3})~', $line, $m)) $status = (int) $m[1];
      if (preg_match('~^content-length:\s*(\d+)~i', $line, $m) && (int) $m[1] > $max) $tooBig = true;
      return strlen($line);
    },
    CURLOPT_WRITEFUNCTION => function ($ch, $chunk) use (&$body, &$tooBig, $max) {
      if ($tooBig) return -1;
      $body .= $chunk;
      if (strlen($body) > $max) { $tooBig = true; return -1; }
      return strlen($chunk);
    },
  ];
  if (!empty($connect['cainfo'])) $opts[CURLOPT_CAINFO] = $connect['cainfo'];
  if ($jsonBody !== null) $opts[CURLOPT_POSTFIELDS] = json_encode($jsonBody);
  curl_setopt_array($ch, $opts);
  $ok = curl_exec($ch);
  $errno = curl_errno($ch);
  $err = curl_error($ch);
  curl_close($ch);
  if ($tooBig) throw $fail(new AtlasOutboundException('the response from ' . $peer['authority'] . ' was too large', 'too-large', 'more than ' . $max . ' bytes'));
  if ($ok === false) {
    $code = $errno === 28 ? 'timeout' : 'unreachable';
    throw $fail(new AtlasOutboundException('could not reach ' . $peer['authority'], $code, 'curl ' . $errno . ': ' . $err));
  }
  if ($status >= 300 && $status < 400) throw $fail(new AtlasOutboundException('could not reach ' . $peer['authority'], 'redirect-refused', 'redirects are not followed'));
  return ['status' => $status, 'raw' => $body];
}

// POSTs JSON to another domain and returns its status and decoded body, whatever that status was.
function atlas_peer_post_json($domain, $pathAndQuery, $body) {
  $res = atlas_peer_request('POST', $domain, $pathAndQuery, $body);
  $decoded = json_decode($res['raw'], true);
  return ['status' => $res['status'], 'body' => is_array($decoded) ? $decoded : []];
}
