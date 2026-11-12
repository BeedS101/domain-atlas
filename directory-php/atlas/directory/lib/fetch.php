<?php
// Safe fetching of a submitted manifest URL. The same rules as directory-server/server.js:
//   - https only (plain http only for localhost, and only when allowLocal is on);
//   - a public host name: no address literals, no localhost, no credentials, no odd ports;
//   - every address the name resolves to must be public, and the connection is pinned to the
//     address that was checked (CURLOPT_RESOLVE), so the name cannot change its answer in between;
//   - redirects are not followed, there is a time limit, and the body is cut off at the size limit.

function dir_is_public_address($ip) {
  if (!is_string($ip)) return false;
  if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) {
    $n = ip2long($ip);
    if ($n === false) return false;
    $ranges = [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
      ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
      ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
    ];
    foreach ($ranges as $r) {
      $base = ip2long($r[0]);
      $mask = $r[1] === 0 ? 0 : (~((1 << (32 - $r[1])) - 1)) & 0xFFFFFFFF;
      if ((($n & $mask) & 0xFFFFFFFF) === (($base & $mask) & 0xFFFFFFFF)) return false;
    }
    return true;
  }
  if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV6)) {
    $bin = inet_pton($ip);
    if ($bin === false || strlen($bin) !== 16) return false;
    $b = array_values(unpack('C*', $bin));
    $allZeroPrefix = true;
    for ($i = 0; $i < 10; $i++) if ($b[$i] !== 0) { $allZeroPrefix = false; break; }
    if ($allZeroPrefix && $b[10] === 0xff && $b[11] === 0xff) return dir_is_public_address($b[12] . '.' . $b[13] . '.' . $b[14] . '.' . $b[15]);
    if ($allZeroPrefix) return false; // ::, ::1 and IPv4-compatible forms
    if (($b[0] & 0xfe) === 0xfc) return false; // fc00::/7
    if ($b[0] === 0xfe && ($b[1] & 0xc0) === 0x80) return false; // fe80::/10
    if ($b[0] === 0xfe && ($b[1] & 0xc0) === 0xc0) return false; // fec0::/10
    if ($b[0] === 0xff) return false; // multicast
    if ($b[0] === 0x20 && $b[1] === 0x01 && $b[2] === 0x0d && $b[3] === 0xb8) return false; // documentation
    if ($b[0] === 0x20 && $b[1] === 0x01 && $b[2] === 0x00 && $b[3] === 0x00) return false; // Teredo
    if ($b[0] === 0x20 && $b[1] === 0x02) return false; // 6to4
    if ($b[0] === 0x00 && $b[1] === 0x64 && $b[2] === 0xff && $b[3] === 0x9b) return false; // NAT64
    return true;
  }
  return false;
}

function dir_is_local_host($host) {
  return $host === 'localhost' || $host === '127.0.0.1' || $host === '[::1]' || $host === '::1' || substr($host, -10) === '.localhost';
}

// Returns ['url', 'scheme', 'host' (as written, with any port), 'hostname', 'port', 'path', 'query'] or throws.
function dir_check_url($text) {
  $cfg = dir_config();
  if (!is_string($text) || $text === '' || strlen($text) > 2000 || preg_match('/[\x00-\x20\x7f\\\\]/', $text)) throw new DirectoryException('not a valid URL');
  if (!preg_match('~^(https?)://([^/?#@]*@)?(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?(/[^?#]*)?(\?[^#]*)?(#.*)?$~', $text, $m)) throw new DirectoryException('not a valid URL');
  if (!empty($m[2])) throw new DirectoryException('a manifest URL cannot carry credentials');
  if (!empty($m[7])) throw new DirectoryException('a manifest URL cannot carry a fragment');
  $scheme = $m[1];
  $hostname = strtolower($m[3]);
  $port = isset($m[4]) && $m[4] !== '' ? (int) $m[4] : null;
  $path = isset($m[5]) && $m[5] !== '' ? $m[5] : '/';
  $query = isset($m[6]) ? $m[6] : '';
  if ($port !== null && ($port < 1 || $port > 65535)) throw new DirectoryException('not a valid URL');
  if ($cfg['allowLocal']) {
    if ($scheme !== 'https' && !($scheme === 'http' && dir_is_local_host($hostname))) throw new DirectoryException('only https is accepted (SPEC.md §3.6.1)');
  } else {
    if ($scheme !== 'https') throw new DirectoryException('only https is accepted (SPEC.md §3.6.1)');
    if ($port !== null && $port !== 443) throw new DirectoryException('only the default https port is accepted');
    $bare = trim($hostname, '[]');
    if (filter_var($bare, FILTER_VALIDATE_IP)) throw new DirectoryException('a manifest must be served from a host name, not an address');
    if (strpos($bare, '.') === false || dir_is_local_host($bare)) throw new DirectoryException('not a public host name');
    if (!preg_match('/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/', $bare)) throw new DirectoryException('not a valid host name');
  }
  $effectivePort = $port !== null ? $port : ($scheme === 'https' ? 443 : 80);
  $defaultPort = $scheme === 'https' ? 443 : 80;
  return [
    'url' => $text, 'scheme' => $scheme, 'hostname' => $hostname, 'port' => $effectivePort,
    'host' => $port !== null && $port !== $defaultPort ? $hostname . ':' . $port : $hostname,
    'path' => $path, 'query' => $query,
  ];
}

function dir_resolve($hostname) {
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

// Returns the response body (a string) or throws a DirectoryException with a plain reason.
function dir_fetch($parsed) {
  $cfg = dir_config();
  if (!function_exists('curl_init')) throw new DirectoryException('this host has no curl extension, so manifests cannot be fetched');
  $ips = dir_resolve($parsed['hostname']);
  if (!$ips) throw new DirectoryException('host name did not resolve');
  if (!$cfg['allowLocal']) foreach ($ips as $ip) if (!dir_is_public_address($ip)) throw new DirectoryException('host resolves to a non-public address');
  usort($ips, function ($a, $b) { return (strpos($a, ':') === false ? 0 : 1) - (strpos($b, ':') === false ? 0 : 1); });
  $pin = strpos($ips[0], ':') !== false ? '[' . $ips[0] . ']' : $ips[0];

  $max = $cfg['maxManifestBytes'];
  $body = '';
  $tooBig = false;
  $status = 0;
  $ch = curl_init($parsed['url']);
  curl_setopt_array($ch, [
    CURLOPT_RESOLVE => [trim($parsed['hostname'], '[]') . ':' . $parsed['port'] . ':' . $pin],
    CURLOPT_FOLLOWLOCATION => false,
    CURLOPT_PROTOCOLS => $parsed['scheme'] === 'https' ? CURLPROTO_HTTPS : CURLPROTO_HTTP,
    CURLOPT_REDIR_PROTOCOLS => 0,
    CURLOPT_CONNECTTIMEOUT => $cfg['fetchTimeoutSeconds'],
    CURLOPT_TIMEOUT => $cfg['fetchTimeoutSeconds'],
    CURLOPT_SSL_VERIFYPEER => true,
    CURLOPT_SSL_VERIFYHOST => 2,
    CURLOPT_USERAGENT => 'domain-atlas-directory/2',
    CURLOPT_HTTPHEADER => ['Accept: application/json'],
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
  ]);
  $ok = curl_exec($ch);
  $error = curl_error($ch);
  curl_close($ch);
  if ($tooBig) throw new DirectoryException('manifest is larger than ' . $max . ' bytes');
  if ($status >= 300 && $status < 400) throw new DirectoryException('redirects are not followed');
  if ($ok === false && $status === 0) throw new DirectoryException($error !== '' ? 'could not reach the host (' . $error . ')' : 'could not reach the host');
  if ($status !== 200) throw new DirectoryException('HTTP ' . $status);
  return $body;
}
