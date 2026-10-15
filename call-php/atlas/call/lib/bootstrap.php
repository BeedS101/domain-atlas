<?php
// Domain Atlas Call Service (PHP): settings and the HTTP layer.
//
// Every route file in atlas/call/ is a two-line stub that calls CallHttp::serve(). With no
// settings file the service answers 503 calls-not-configured on every route except
// GET /atlas/call/info and creates nothing on disk. See the deployment guide,
// docs/voice-calls-deploy-php.md, for what each setting means.

require_once __DIR__ . '/service.php';

final class CallConfig {
  const TUNABLE_LIMITS = [
    'maxLiveCalls' => [1, 100000], 'maxTurnCredentialsPerRole' => [1, 20], 'maxListeners' => [1, 1000000], 'maxNonces' => [1000, 10000000],
    'maxTagsTotal' => [1, 1000000], 'maxSignalsPerCall' => [10, 10000], 'perSourcePerMin' => [10, 100000], 'invitesPerSourcePerMin' => [1, 10000],
    'invitesPerCallerPerMin' => [1, 10000], 'invitesPerCalleePerMin' => [1, 10000], 'tagCreatePerOwnerPerMin' => [1, 10000], 'maxEventsPerMailbox' => [10, 1000],
  ];
  const TUNABLE_TIMERS = [
    'acceptToOfferMs', 'offerToAnswerMs', 'confirmMs', 'endedRetainMs', 'seenCallIdMs', 'sweepMs', 'silentActiveMs', 'maxCallMs',
    'listenerFreshMs', 'revocationCacheMs', 'fetchTimeoutMs', 'lockWaitMs',
  ];
  const THIRD_PARTY_ICE_SUFFIXES = [
    'l.google.com', 'stun.services.mozilla.com', 'twilio.com', 'cloudflare.com', 'stunprotocol.org',
    'metered.ca', 'ekiga.net', 'sipgate.net', 'voipbuster.com', 'voiparound.com', 'stunserver.org',
    'xten.com', 'schlund.de', 'ideasip.com', 'freeswitch.org', 'nextcloud.com', 'jitsi.org', 'jit.si',
    'xirsys.com', 'viagenie.ca', 'bistri.com', 'backups.cz', 'vonage.com', 'telnyx.com', 'agora.io', 'daily.co', 'livekit.io',
  ];

  // Returns null when $u is an acceptable operator ICE server URL, otherwise a short reason.
  static function iceUrlProblem($u, $kind, $allowPrivate) {
    if (!is_string($u)) return 'is not a string';
    $why = CallProto::iceUrlProblem($u, ['kind' => $kind, 'allowPrivate' => $allowPrivate]);
    if ($why) return $why;
    $p = CallProto::parseIceUrl($u);
    $host = strtolower($p['host']);
    foreach (self::THIRD_PARTY_ICE_SUFFIXES as $x) {
      if ($host === $x || (strlen($host) > strlen($x) && substr($host, -strlen($x) - 1) === '.' . $x)) return 'is a public third-party service; use a server you operate';
    }
    return null;
  }

  private static function strList($v) {
    if ($v === null) return [];
    if (!is_array($v)) return null;
    foreach ($v as $x) if (!is_string($x)) return null;
    return array_values($v);
  }
  private static function originProblem($o, $allowHttp) {
    if (!is_string($o) || !preg_match('/^(https?):\/\/([a-z0-9.-]{1,253}|\[[0-9a-f:]{2,45}\])(?::(\d{1,5}))?\z/', $o, $m)) return 'must be a bare origin such as https://calls.example.com';
    if (isset($m[3]) && $m[3] !== '' && ((int)$m[3] < 1 || (int)$m[3] > 65535 || ($m[1] === 'https' && (int)$m[3] === 443) || ($m[1] === 'http' && (int)$m[3] === 80))) return 'must be a bare origin such as https://calls.example.com (no default port)';
    if ($m[1] !== 'https' && !$allowHttp) return 'must be https (plain http only with devAllowHttp, for a private test network)';
    return null;
  }

  // The settings, checked. `configured` is true only when every setting is acceptable;
  // otherwise `problem` says which one is not (it is shown to the operator in the log, never
  // to a client).
  static function load($file = null) {
    $cfg = ['configured' => false, 'problem' => 'no configuration present'];
    if ($file === null) {
      $file = getenv('ATLAS_CALL_CONFIG');
      if (!$file && isset($_SERVER['ATLAS_CALL_CONFIG'])) $file = $_SERVER['ATLAS_CALL_CONFIG'];
      if (!$file && isset($_SERVER['REDIRECT_ATLAS_CALL_CONFIG'])) $file = $_SERVER['REDIRECT_ATLAS_CALL_CONFIG'];
      if (!$file) $file = __DIR__ . '/config.php';
    }
    if (!is_file($file)) return $cfg;
    try {
      $raw = (function ($f) { return include $f; })($file);
    } catch (Throwable $e) {
      return ['configured' => false, 'problem' => 'settings file unreadable'];
    }
    if (!is_array($raw)) return ['configured' => false, 'problem' => 'settings file must return an array'];
    return self::check($raw);
  }

  static function check($raw) {
    $bad = function ($why) { return ['configured' => false, 'problem' => $why]; };
    $known = ['origin', 'domain', 'issuerKeys', 'revocationsFile', 'revocationsUrl', 'stateDir', 'stunUrls', 'turnUrls', 'turnSecret', 'turnSecretFile', 'turnTtlSeconds',
      'trustProxy', 'proxyAddrs', 'inviteCorsOrigins', 'httpsCheck', 'limits', 'timers', 'poll', 'devAllowHttp', 'devAllowPrivateFetch', 'logRefusals'];
    foreach ($raw as $k => $_) if (!in_array($k, $known, true)) return $bad($k . ' is not a setting');
    $g = function ($k, $d = null) use ($raw) { return array_key_exists($k, $raw) ? $raw[$k] : $d; };
    $cfg = [
      'configured' => false,
      'origin' => $g('origin'), 'domain' => $g('domain'), 'issuerKeys' => self::strList($g('issuerKeys')),
      'revocationsFile' => $g('revocationsFile') ?: null, 'revocationsUrl' => $g('revocationsUrl') ?: null,
      'stateDir' => $g('stateDir') ?: null,
      'stunUrls' => self::strList($g('stunUrls')), 'turnUrls' => self::strList($g('turnUrls')),
      'turnSecret' => $g('turnSecret') ?: null, 'turnSecretFile' => $g('turnSecretFile') ?: null,
      'turnTtlSeconds' => $g('turnTtlSeconds', 3600),
      'trustProxy' => $g('trustProxy') === true, 'proxyAddrs' => self::strList($g('proxyAddrs')),
      'corsOrigins' => self::strList($g('inviteCorsOrigins')), 'httpsCheck' => $g('httpsCheck', true) !== false,
      'devAllowHttp' => $g('devAllowHttp') === true, 'devAllowPrivateFetch' => $g('devAllowPrivateFetch') === true,
      'logRefusals' => $g('logRefusals') === true,
      'limits' => [], 'timers' => [], 'poll' => [],
    ];
    if (!$cfg['origin'] && !$cfg['domain'] && !$cfg['issuerKeys']) return $bad('no configuration present');
    foreach (['issuerKeys', 'stunUrls', 'turnUrls', 'proxyAddrs', 'corsOrigins'] as $l) if ($cfg[$l] === null) return $bad($l . ' must be a list of strings');
    if (!$cfg['proxyAddrs']) $cfg['proxyAddrs'] = ['127.0.0.1', '::1'];
    foreach (['limits' => self::TUNABLE_LIMITS] as $name => $ranges) {
      $v = $g($name, []);
      if (!is_array($v)) return $bad($name . ' must be a list of settings');
      foreach ($v as $k => $n) {
        if (!isset($ranges[$k])) return $bad($name . '.' . $k . ' is not a setting');
        if (!is_int($n) || $n < $ranges[$k][0] || $n > $ranges[$k][1]) return $bad('limit ' . $k . ' must be a whole number from ' . $ranges[$k][0] . ' to ' . $ranges[$k][1]);
        $cfg[$name][$k] = $n;
      }
    }
    $timers = $g('timers', []);
    if (!is_array($timers)) return $bad('timers must be a list of settings');
    foreach ($timers as $k => $n) {
      if (!in_array($k, self::TUNABLE_TIMERS, true)) return $bad('timers.' . $k . ' is not a setting');
      $min = $k === 'revocationCacheMs' ? 0 : 200;
      if (!is_int($n) || $n < $min || $n > 86400000) return $bad('timer ' . $k . ' must be a whole number of milliseconds from ' . $min . ' to 86400000');
      $cfg['timers'][$k] = $n;
    }
    $poll = $g('poll', []);
    if (!is_array($poll)) return $bad('poll must be a list of settings');
    foreach ($poll as $k => $n) {
      if (!isset(CallService::DEFAULT_POLL[$k])) return $bad('poll.' . $k . ' is not a setting');
      if (!is_int($n) || $n < 200 || $n > 30000) return $bad('poll.' . $k . ' must be a whole number of milliseconds from 200 to 30000');
      $cfg['poll'][$k] = $n;
    }
    $fresh = isset($cfg['timers']['listenerFreshMs']) ? $cfg['timers']['listenerFreshMs'] : CallService::DEFAULT_TIMERS['listenerFreshMs'];
    $idle = isset($cfg['poll']['listenIdleMs']) ? $cfg['poll']['listenIdleMs'] : CallService::DEFAULT_POLL['listenIdleMs'];
    if ($fresh < 2 * $idle) return $bad('timers.listenerFreshMs must be at least twice poll.listenIdleMs, or a wallet that is listening looks offline');

    if ($why = self::originProblem($cfg['origin'], $cfg['devAllowHttp'])) return $bad('origin ' . $why);
    if (!is_string($cfg['domain']) || !preg_match('/^[a-z0-9.-]{1,253}(:\d{1,5})?\z/', $cfg['domain'])) return $bad('domain is missing or malformed');
    if (!$cfg['issuerKeys'] || count($cfg['issuerKeys']) > 8) return $bad('issuerKeys must list 1 to 8 raw P-256 public keys');
    foreach ($cfg['issuerKeys'] as $k) if (!preg_match('/^[A-Za-z0-9_-]{87}\z/', $k)) return $bad('issuerKeys must list 1 to 8 raw P-256 public keys');
    if ($cfg['revocationsFile'] && $cfg['revocationsUrl']) return $bad('revocationsFile and revocationsUrl are both set; use one');
    if ($cfg['revocationsFile'] && !is_string($cfg['revocationsFile'])) return $bad('revocationsFile must be a path');
    if ($cfg['revocationsUrl']) {
      $u = is_string($cfg['revocationsUrl']) ? parse_url($cfg['revocationsUrl']) : false;
      if (!$u || empty($u['host']) || !isset($u['scheme'])) return $bad('revocationsUrl is not a URL');
      if ($u['scheme'] !== 'https' && !($u['scheme'] === 'http' && $cfg['devAllowHttp'])) return $bad('revocationsUrl must be https');
    }
    if (count($cfg['stunUrls']) > CallProto::ICE_LIMITS['stunUrls']) return $bad('stunUrls may list at most ' . CallProto::ICE_LIMITS['stunUrls'] . ' servers');
    foreach ($cfg['stunUrls'] as $u) if ($why = self::iceUrlProblem($u, 'stun', $cfg['devAllowHttp'])) return $bad('stunUrls: ' . substr($u, 0, 80) . ' ' . $why);
    if ($cfg['turnSecretFile']) {
      if ($cfg['turnSecret']) return $bad('turnSecret and turnSecretFile are both set; use one');
      $f = $cfg['turnSecretFile'];
      if (!is_string($f) || !is_file($f) || !is_readable($f)) return $bad('turnSecretFile cannot be read');
      if (DIRECTORY_SEPARATOR === '/' && (fileperms($f) & 0077)) return $bad('turnSecretFile must not be readable by group or others (chmod 600)');
      $cfg['turnSecret'] = trim((string)file_get_contents($f));
    }
    if ($cfg['turnUrls'] || $cfg['turnSecret']) {
      if (!$cfg['turnUrls'] || !$cfg['turnSecret']) return $bad('TURN needs both turnUrls and a secret (turnSecret or turnSecretFile)');
      if (count($cfg['turnUrls']) > CallProto::ICE_LIMITS['turnUrls']) return $bad('turnUrls may list at most ' . CallProto::ICE_LIMITS['turnUrls'] . ' URLs');
      foreach ($cfg['turnUrls'] as $u) if ($why = self::iceUrlProblem($u, 'turn', $cfg['devAllowHttp'])) return $bad('turnUrls: ' . substr($u, 0, 80) . ' ' . $why);
      $s = $cfg['turnSecret'];
      if (!is_string($s) || strlen($s) < 32 || strlen($s) > 256 || !preg_match('/^[\x21-\x7e]+\z/', $s) || count(array_unique(str_split($s))) < 10) {
        return $bad('the TURN secret must be 32 to 256 printable characters and not repetitive (for example the output of: openssl rand -hex 32)');
      }
      if (!is_int($cfg['turnTtlSeconds']) || $cfg['turnTtlSeconds'] < 60 || $cfg['turnTtlSeconds'] > 86400) return $bad('turnTtlSeconds must be a whole number from 60 to 86400');
    }
    foreach ($cfg['proxyAddrs'] as $a) if (!filter_var($a, FILTER_VALIDATE_IP)) return $bad('proxyAddrs must list IP addresses');
    foreach ($cfg['corsOrigins'] as $o) if (self::originProblem($o, $cfg['devAllowHttp'])) return $bad('inviteCorsOrigins must list exact https origins, no wildcard, no path');
    if (!$cfg['stateDir']) $cfg['stateDir'] = __DIR__ . '/state';
    $env = getenv('ATLAS_CALL_STATE_DIR');
    if ($env) $cfg['stateDir'] = $env;
    if (!is_string($cfg['stateDir'])) return $bad('stateDir must be a path');
    $cfg['configured'] = true;
    return $cfg;
  }
}

final class CallHttp {
  const ROUTES = [
    'tag/create' => ['method' => 'routeTagCreate', 'max' => 8192], 'tag/revoke' => ['method' => 'routeTagRevoke', 'max' => 2048],
    'tag/list' => ['method' => 'routeTagList', 'max' => 2048], 'listen' => ['method' => 'routeListen', 'max' => 4096],
    'invite' => ['method' => 'routeInvite', 'max' => 12288, 'cors' => true], 'poll' => ['method' => 'routePoll', 'max' => 2048],
    'signal' => ['method' => 'routeSignal', 'max' => 20480], 'ice' => ['method' => 'routeIce', 'max' => 2048],
  ];

  static function normalizeIp($addr) {
    $a = strtolower(trim((string)$addr));
    $z = strpos($a, '%');
    if ($z !== false) $a = substr($a, 0, $z);
    $bin = @inet_pton($a);
    if ($bin !== false && strlen($bin) === 16 && substr($bin, 0, 12) === str_repeat("\0", 10) . "\xff\xff") return inet_ntop(substr($bin, 12));
    return $a;
  }
  // IPv4 as is; IPv6 by its /64, so a client cannot dodge a limit by changing the low bits.
  static function sourceKey($addr) {
    $bin = @inet_pton($addr);
    if ($bin === false) return '';
    if (strlen($bin) === 4) return inet_ntop($bin);
    return 'v6:' . implode(':', str_split(substr(bin2hex($bin), 0, 16), 4));
  }

  static function send($status, $body, $headers = []) {
    if (!headers_sent()) {
      http_response_code($status);
      header('Content-Type: application/json; charset=utf-8');
      header('Cache-Control: no-store');
      header('X-Content-Type-Options: nosniff');
      header("Content-Security-Policy: default-src 'none'; frame-ancestors 'none'");
      header('Referrer-Policy: no-referrer');
      foreach ($headers as $h) header($h);
    }
    echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION);
    exit;
  }
  private static function fail($status, $code, $message, $headers = []) { self::send($status, ['error' => $message, 'code' => $code], $headers); }

  static function serve($route) {
    @ini_set('display_errors', '0');
    @set_time_limit(20);
    @ignore_user_abort(true);
    set_exception_handler(function ($e) {
      error_log('[atlas-call] ' . get_class($e) . ': ' . $e->getMessage());
      self::fail(500, 'internal', 'internal error');
    });
    register_shutdown_function(function () {
      $err = error_get_last();
      if ($err && in_array($err['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true) && !headers_sent()) {
        error_log('[atlas-call] fatal: ' . $err['message']);
        http_response_code(500);
        header('Content-Type: application/json; charset=utf-8');
        echo '{"error":"internal error","code":"internal"}';
      }
    });

    $cfg = CallConfig::load();
    if (!$cfg['configured'] && !empty($cfg['problem']) && $cfg['problem'] !== 'no configuration present') error_log('[atlas-call] not configured: ' . $cfg['problem']);
    $method = isset($_SERVER['REQUEST_METHOD']) ? $_SERVER['REQUEST_METHOD'] : 'GET';

    if ($route === 'info') {
      if ($method !== 'GET') self::fail(404, 'not-found', 'not found');
      $svc = new CallService($cfg, new CallStore(self::stateDir($cfg)));
      $out = $svc->info();
      self::send($out['status'], $out['body']);
    }
    $def = isset(self::ROUTES[$route]) ? self::ROUTES[$route] : null;
    if (!$def) self::fail(404, 'not-found', 'not found');

    $origin = isset($_SERVER['HTTP_ORIGIN']) ? $_SERVER['HTTP_ORIGIN'] : null;
    $corsAllowed = !empty($def['cors']) && $origin !== null && $cfg['configured'] && in_array($origin, $cfg['corsOrigins'], true);
    $hdr = $corsAllowed ? ['Access-Control-Allow-Origin: ' . $origin, 'Access-Control-Allow-Methods: POST, OPTIONS', 'Access-Control-Allow-Headers: Content-Type', 'Access-Control-Max-Age: 600', 'Vary: Origin'] : [];
    if (!empty($def['cors']) && $method === 'OPTIONS' && $corsAllowed) {
      http_response_code(204);
      header('Cache-Control: no-store');
      foreach ($hdr as $h) header($h);
      exit;
    }
    if ($method !== 'POST') self::fail(405, 'method-not-allowed', 'method not allowed', $hdr);
    if (!$cfg['configured']) self::fail(503, 'calls-not-configured', 'calls are not configured on this service', $hdr);

    $peer = self::normalizeIp(isset($_SERVER['REMOTE_ADDR']) ? $_SERVER['REMOTE_ADDR'] : '');
    $trusted = $cfg['trustProxy'] && in_array($peer, array_map([__CLASS__, 'normalizeIp'], $cfg['proxyAddrs']), true);
    $source = self::sourceKey($peer) ?: 'unknown';
    if ($trusted) {
      $parts = explode(',', isset($_SERVER['HTTP_X_FORWARDED_FOR']) ? $_SERVER['HTTP_X_FORWARDED_FOR'] : '');
      $last = self::normalizeIp(trim(end($parts)));
      if ($last !== '' && filter_var($last, FILTER_VALIDATE_IP)) $source = self::sourceKey($last);
    }
    if (strpos($cfg['origin'], 'https:') === 0) {
      if ($cfg['trustProxy']) {
        $parts = explode(',', isset($_SERVER['HTTP_X_FORWARDED_PROTO']) ? $_SERVER['HTTP_X_FORWARDED_PROTO'] : '');
        if (!$trusted || strtolower(trim(end($parts))) !== 'https') self::fail(400, 'https-required', 'https is required');
      } elseif ($cfg['httpsCheck']) {
        $https = !empty($_SERVER['HTTPS']) && strtolower($_SERVER['HTTPS']) !== 'off';
        if (!$https && (!isset($_SERVER['SERVER_PORT']) || (int)$_SERVER['SERVER_PORT'] !== 443)) self::fail(400, 'https-required', 'https is required');
      }
    }
    // A web page's origin is not an input to authentication; a request from one that the
    // operator did not name is refused. The wallet's own requests carry no web origin.
    if ($origin !== null && !$corsAllowed && preg_match('/^(https?:|null\z)/i', $origin)) self::fail(403, 'origin-not-allowed', 'origin not allowed');
    $ctype = isset($_SERVER['CONTENT_TYPE']) ? $_SERVER['CONTENT_TYPE'] : '';
    if (!preg_match('/^application\/json\s*(;.*)?\z/i', $ctype)) self::fail(415, 'unsupported-media-type', 'content type must be application/json', $hdr);

    $svc = new CallService($cfg, new CallStore(self::stateDir($cfg)));
    $admit = $svc->admit($source);
    if ($admit) self::send($admit['status'], $admit['body'], array_merge($hdr, $admit['headers']));

    $len = isset($_SERVER['CONTENT_LENGTH']) ? (int)$_SERVER['CONTENT_LENGTH'] : 0;
    if ($len > $def['max']) self::fail(413, 'too-large', 'request too large', $hdr);
    $in = fopen('php://input', 'rb');
    $text = $in ? stream_get_contents($in, $def['max'] + 1) : '';
    if ($in) fclose($in);
    if ($text === false) self::fail(400, 'bad-request', 'bad request', $hdr);
    if (strlen($text) > $def['max']) self::fail(413, 'too-large', 'request too large', $hdr);
    $body = json_decode($text, false, 64);
    if ($body === null && json_last_error() !== JSON_ERROR_NONE) self::fail(400, 'bad-request', 'malformed request', $hdr);
    $out = $svc->{$def['method']}($body, ['source' => $source]);
    self::send($out['status'], $out['body'], array_merge($hdr, isset($out['headers']) ? $out['headers'] : []));
  }

  private static function stateDir($cfg) {
    if (!empty($cfg['stateDir'])) return $cfg['stateDir'];
    return __DIR__ . '/state';
  }
}
