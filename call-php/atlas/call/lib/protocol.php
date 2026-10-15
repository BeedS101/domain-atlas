<?php
// Domain Atlas secure voice calls: signed message formats and checks, PHP port of
// call-server/protocol.js.
//
// The Node file and this one define one wire protocol. Every rule that decides whether a
// message is accepted (field checks, canonical JSON, hashes, signature verification,
// freshness, ICE server URL rules) is ported line for line, and test/manual-call-php-protocol.js
// feeds both the same inputs and compares the answers. A change to either file needs the
// same change in the other.
//
// Values are the result of json_decode($text, false): JSON objects are stdClass, JSON arrays
// are PHP lists. Objects built in PHP for output or hashing must be stdClass as well (an empty
// PHP array is a JSON array), see CallProto::obj().
//
// Written for PHP 7.4 and later; no extension beyond openssl, hash, json and pcre.

final class CallProto {
  const LIMITS = [
    'inviteTtlMs' => 60000,
    'walletSkewMs' => 30000,
    'serviceWindowMs' => 120000,
    // A request is accepted for serviceWindowMs on either side of its issuedAt, so its nonce
    // must be remembered for twice that plus a margin, or a captured request could be replayed
    // after the nonce was forgotten and while its issuedAt was still fresh.
    'nonceRetainMs' => 270000,
    'listenSessionMs' => 3600000,
    'tagMaxAheadMs' => 7776000000,
    'maxCallsPerTag' => 100,
    'maxTagsPerWallet' => 200,
    'sdpMaxBytes' => 16384,
    'candidatesPerMessage' => 8,
    'candidatesPerCall' => 20,
    'ackMax' => 50,
  ];
  const BODY_MAX = ['tag/create' => 8192, 'tag/revoke' => 2048, 'tag/list' => 2048, 'listen' => 4096, 'invite' => 12288, 'poll' => 2048, 'signal' => 20480, 'ice' => 2048];
  const END_REASONS = ['declined', 'busy', 'noanswer', 'cancelled', 'unavailable', 'timeout', 'mic-denied', 'verify-failed', 'connect-failed', 'network-lost', 'hangup', 'policy-blocked', 'locked', 'window-closed', 'error'];
  const SIGNAL_KINDS = ['accept', 'offer', 'answer', 'candidates', 'confirm', 'end', 'cancel', 'decline', 'busy'];
  const CK_KINDS = ['offer', 'answer', 'candidates', 'confirm', 'end', 'cancel'];
  const ICE_TURN_PORTS = [80, 443, 3478, 5349];
  const ICE_LIMITS = ['stunUrls' => 3, 'turnUrls' => 4, 'servers' => 4, 'urlsPerServer' => 16, 'minRemainingMs' => 15000, 'maxRemainingMs' => 90000000];
  const P256_SPKI_PREFIX_HEX = '3059301306072a8648ce3d020106082a8648ce3d030107034200';

  // ---------- objects and JavaScript-shaped helpers ----------

  // An object with the given members; stdClass even when empty.
  static function obj($members = []) {
    $o = new stdClass();
    foreach ($members as $k => $v) $o->{(string)$k} = $v;
    return $o;
  }
  static function isObj($v) { return $v instanceof stdClass; }
  static function has($o, $name) { return $o instanceof stdClass && property_exists($o, $name); }
  static function get($o, $name) { return ($o instanceof stdClass && property_exists($o, $name)) ? $o->$name : null; }

  // JavaScript truthiness of a decoded JSON value.
  static function truthy($v) {
    if ($v === null || $v === false) return false;
    if (is_int($v) || is_float($v)) return $v != 0 && $v === $v;
    if (is_string($v)) return $v !== '';
    return true;
  }
  static function isNum($v) { return is_int($v) || is_float($v); }
  // Number.isInteger
  static function isInteger($v) {
    if (is_int($v)) return true;
    return is_float($v) && is_finite($v) && floor($v) == $v;
  }
  // v === n for a number n
  static function numIs($v, $n) { return self::isNum($v) && $v == $n; }

  // Length in UTF-16 code units, which is what String.length counts.
  static function u16len($s) {
    $n = strlen($s);
    if (!preg_match('/[\x80-\xFF]/', $s)) return $n;
    return $n - preg_match_all('/[\x80-\xBF]/', $s) + preg_match_all('/[\xF0-\xF7]/', $s);
  }
  static function u16units($s) {
    $out = [];
    $n = strlen($s);
    for ($i = 0; $i < $n; ) {
      $c = ord($s[$i]);
      if ($c < 0x80) { $out[] = $c; $i += 1; continue; }
      if ($c < 0xE0) { $cp = (($c & 0x1F) << 6) | (ord($s[$i + 1]) & 0x3F); $i += 2; }
      elseif ($c < 0xF0) { $cp = (($c & 0x0F) << 12) | ((ord($s[$i + 1]) & 0x3F) << 6) | (ord($s[$i + 2]) & 0x3F); $i += 3; }
      else { $cp = (($c & 0x07) << 18) | ((ord($s[$i + 1]) & 0x3F) << 12) | ((ord($s[$i + 2]) & 0x3F) << 6) | (ord($s[$i + 3]) & 0x3F); $i += 4; }
      if ($cp >= 0x10000) { $cp -= 0x10000; $out[] = 0xD800 + ($cp >> 10); $out[] = 0xDC00 + ($cp & 0x3FF); }
      else $out[] = $cp;
    }
    return $out;
  }
  // Array.prototype.sort() order for strings: by UTF-16 code unit, not by byte.
  static function cmpU16($a, $b) {
    if (!preg_match('/[\xF0-\xF7]/', $a . $b)) return strcmp($a, $b);
    $x = self::u16units($a); $y = self::u16units($b);
    $n = min(count($x), count($y));
    for ($i = 0; $i < $n; $i++) if ($x[$i] !== $y[$i]) return $x[$i] < $y[$i] ? -1 : 1;
    return count($x) <=> count($y);
  }

  // ---------- encoding, canonical JSON, hashes ----------

  static function b64urlEncode($bin) { return rtrim(strtr(base64_encode($bin), '+/', '-_'), '='); }
  // Throws on anything JavaScript's atob would refuse after the character check.
  static function b64urlDecode($str) {
    if (!is_string($str) || !preg_match('/^[A-Za-z0-9_-]*\z/', $str)) throw new Exception('bad base64url');
    $m = strlen($str) % 4;
    if ($m === 1) throw new Exception('bad base64url');
    $std = strtr($str, '-_', '+/') . ($m ? str_repeat('=', 4 - $m) : '');
    $out = base64_decode($std, true);
    if ($out === false) throw new Exception('bad base64url');
    return $out;
  }
  static function sha256Raw($data) { return hash('sha256', $data, true); }
  static function randomId($bytes = 16) { return self::b64urlEncode(random_bytes($bytes)); }

  private static $escapes = null;
  static function jsonString($s) {
    if (!preg_match('/["\\\\\x00-\x1f]/', $s)) return '"' . $s . '"';
    if (self::$escapes === null) {
      $t = ['"' => '\\"', '\\' => '\\\\', "\x08" => '\\b', "\x0c" => '\\f', "\n" => '\\n', "\r" => '\\r', "\t" => '\\t'];
      for ($i = 0; $i < 32; $i++) if (!isset($t[chr($i)])) $t[chr($i)] = sprintf('\\u%04x', $i);
      self::$escapes = $t;
    }
    return '"' . strtr($s, self::$escapes) . '"';
  }

  // Number.prototype.toString for a JSON number.
  static function jsNumber($n) {
    if (is_int($n)) {
      if ($n <= 9007199254740992 && $n >= -9007199254740992) return (string)$n;
      $n = (float)$n;
    }
    if (!is_finite($n)) return 'null';
    if ($n == 0) return '0';
    $neg = $n < 0;
    $a = abs($n);
    $old = ini_set('serialize_precision', '-1');
    $text = json_encode($a);
    if ($old !== false) ini_set('serialize_precision', $old);
    if (!preg_match('/^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?\z/', $text, $m)) return 'null';
    $int = $m[1];
    $frac = isset($m[2]) ? $m[2] : '';
    $exp = isset($m[3]) && $m[3] !== '' ? (int)$m[3] : 0;
    $digits = $int . $frac;
    $point = strlen($int) + $exp;
    $trim = strlen($digits) - strlen(ltrim($digits, '0'));
    $digits = substr($digits, $trim);
    $point -= $trim;
    $digits = rtrim($digits, '0');
    $k = strlen($digits);
    $n10 = $point;
    if ($k <= $n10 && $n10 <= 21) $out = $digits . str_repeat('0', $n10 - $k);
    elseif (0 < $n10 && $n10 <= 21) $out = substr($digits, 0, $n10) . '.' . substr($digits, $n10);
    elseif (-6 < $n10 && $n10 <= 0) $out = '0.' . str_repeat('0', -$n10) . $digits;
    else {
      $e = $n10 - 1;
      $sign = $e < 0 ? '-' : '+';
      $out = ($k === 1 ? $digits : $digits[0] . '.' . substr($digits, 1)) . 'e' . $sign . abs($e);
    }
    return ($neg ? '-' : '') . $out;
  }

  // Same canonical form as SPEC.md section 6.2 and protocol.js: keys sorted at every level.
  static function canonicalize($v) {
    if ($v === null) return 'null';
    if ($v === true) return 'true';
    if ($v === false) return 'false';
    if (is_int($v) || is_float($v)) return self::jsNumber($v);
    if (is_string($v)) return self::jsonString($v);
    if (is_array($v) && (count($v) === 0 || array_keys($v) === range(0, count($v) - 1))) {
      $parts = [];
      foreach ($v as $item) $parts[] = self::canonicalize($item);
      return '[' . implode(',', $parts) . ']';
    }
    $keys = [];
    $vals = [];
    foreach ($v as $k => $item) { $keys[] = (string)$k; $vals[(string)$k] = $item; }
    usort($keys, [__CLASS__, 'cmpU16']);
    $parts = [];
    foreach ($keys as $k) $parts[] = self::jsonString($k) . ':' . self::canonicalize($vals[$k]);
    return '{' . implode(',', $parts) . '}';
  }
  static function hashOf($v) { return self::b64urlEncode(self::sha256Raw(self::canonicalize($v))); }
  static function payloadHash($v) { return self::hashOf($v); }
  static function transcriptHash($invite, $accept) { return self::hashOf(self::obj(['invite' => $invite, 'accept' => $accept])); }
  static function tagHash($tag) { return self::b64urlEncode(self::sha256Raw('atlas.call.tag/v1:' . $tag)); }

  // ---------- time ----------

  // Date.parse for the one accepted spelling, in milliseconds, or null where it gives NaN.
  // Like V8 it takes any day 1..31 for any month and carries the excess into the next month,
  // and takes hour 24 only as exactly 24:00:00.000.
  static function parseTime($s) {
    if (!is_string($s) || !preg_match('/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z\z/', $s, $m)) return null;
    $y = (int)$m[1]; $mo = (int)$m[2]; $d = (int)$m[3];
    $h = (int)$m[4]; $mi = (int)$m[5]; $sec = (int)$m[6]; $ms = (int)$m[7];
    if ($mo < 1 || $mo > 12 || $d < 1 || $d > 31 || $h > 24 || $mi > 59 || $sec > 59) return null;
    if ($h === 24 && ($mi || $sec || $ms)) return null;
    $yy = $mo <= 2 ? $y - 1 : $y;
    $era = intdiv($yy >= 0 ? $yy : $yy - 399, 400);
    $yoe = $yy - $era * 400;
    $doy = intdiv(153 * ($mo + ($mo > 2 ? -3 : 9)) + 2, 5) + $d - 1;
    $doe = $yoe * 365 + intdiv($yoe, 4) - intdiv($yoe, 100) + $doy;
    $days = $era * 146097 + $doe - 719468;
    return (($days * 24 + $h) * 60 + $mi) * 60000 + $sec * 1000 + $ms;
  }
  static function isoTime($ms) { return gmdate('Y-m-d\TH:i:s', intdiv($ms, 1000)) . sprintf('.%03dZ', $ms % 1000); }
  static function nowMs() { return (int)floor(microtime(true) * 1000); }

  // ---------- field checks ----------

  static function isStr($v, $min, $max) { if (!is_string($v)) return false; $n = self::u16len($v); return $n >= $min && $n <= $max; }
  static function isB64u($v, $min, $max) { return self::isStr($v, $min, $max) && preg_match('/^[A-Za-z0-9_-]+\z/', $v) === 1; }
  static function isTime($v) { return self::parseTime($v) !== null; }
  static function isInt($v, $min, $max) { return self::isInteger($v) && $v >= $min && $v <= $max; }
  static function isKey($v) { return self::isB64u($v, 20, 200); }
  static function isCallKey($v) { return self::isB64u($v, 87, 87); }
  static function isId128($v) { return self::isB64u($v, 22, 22); }
  static function isHash($v) { return self::isB64u($v, 43, 43); }
  static function isFp($v) { return is_string($v) && preg_match('/^sha-256 ([0-9A-F]{2}:){31}[0-9A-F]{2}\z/', $v) === 1; }

  // Exactly the listed fields, no others. A trailing '?' on a key marks it optional.
  static function strict($obj, $spec) {
    if (!($obj instanceof stdClass)) return false;
    $names = [];
    foreach ($spec as $rawKey => $pred) {
      $rawKey = (string)$rawKey;
      $optional = substr($rawKey, -1) === '?';
      $name = $optional ? substr($rawKey, 0, -1) : $rawKey;
      $names[$name] = true;
      if (!property_exists($obj, $name)) { if ($optional) continue; return false; }
      if (!$pred($obj->$name)) return false;
    }
    foreach ($obj as $k => $_) if (!isset($names[(string)$k])) return false;
    return true;
  }
  static function arrayOf($pred, $max) {
    return function ($v) use ($pred, $max) {
      if (!is_array($v) || count($v) < 1 || count($v) > $max) return false;
      foreach ($v as $x) if (!$pred($x)) return false;
      return true;
    };
  }
  static function pEq($want) { return function ($v) use ($want) { return is_string($want) || is_bool($want) ? $v === $want : self::numIs($v, $want); }; }
  static function pStr($min, $max) { return function ($v) use ($min, $max) { return self::isStr($v, $min, $max); }; }
  static function pB64u($min, $max) { return function ($v) use ($min, $max) { return self::isB64u($v, $min, $max); }; }
  static function pInt($min, $max) { return function ($v) use ($min, $max) { return self::isInt($v, $min, $max); }; }
  static function pFn($name) { return function ($v) use ($name) { return self::$name($v); }; }

  private static $schemas = null;
  private static function common($type) {
    return ['type' => self::pEq($type), 'v' => self::pEq(1), 'audience' => self::pStr(8, 200), 'issuedAt' => self::pFn('isTime')];
  }
  private static function withNonce($spec) { return ['nonce' => self::pB64u(16, 128)] + $spec; }
  private static function schemas() {
    if (self::$schemas !== null) return self::$schemas;
    $wallet = function ($v) { return self::strict($v, ['kind' => self::pEq('wallet'), 'publicKey' => self::pFn('isKey')]); };
    $fps = self::arrayOf(self::pFn('isFp'), 2);
    $s = [];
    $s['atlas.call.tag'] = self::withNonce(self::common('atlas.call.tag')) + [
      'bind' => $wallet, 'calleeKey' => self::pFn('isKey'), 'expiresAt' => self::pFn('isTime'), 'maxCalls' => self::pInt(1, self::LIMITS['maxCallsPerTag']),
    ];
    $s['atlas.call.tag-revoke'] = self::withNonce(self::common('atlas.call.tag-revoke')) + ['tag?' => self::pFn('isId128'), 'all?' => self::pEq(true)];
    $s['atlas.call.tag-list'] = self::withNonce(self::common('atlas.call.tag-list'));
    $s['atlas.call.listen'] = self::withNonce(self::common('atlas.call.listen')) + [
      'ack' => function ($v) {
        if (!is_array($v) || count($v) > self::LIMITS['ackMax']) return false;
        foreach ($v as $x) if (!self::isInt($x, 1, 2147483648)) return false;
        return true;
      },
      'stop?' => self::pEq(true),
    ];
    $s['atlas.call.listen-session'] = self::common('atlas.call.listen-session') + ['expiresAt' => self::pFn('isTime'), 'sessionKey' => self::pFn('isCallKey')];
    $s['atlas.call.poll'] = self::withNonce(self::common('atlas.call.poll')) + ['callId' => self::pFn('isId128'), 'after' => self::pInt(0, 2147483648)];
    $s['atlas.call.ice'] = self::withNonce(self::common('atlas.call.ice')) + ['callId' => self::pFn('isId128')];
    $s['atlas.call.invite'] = self::withNonce(self::common('atlas.call.invite')) + [
      'callId' => self::pFn('isId128'), 'tag' => self::pFn('isId128'), 'expiresAt' => self::pFn('isTime'),
      'caller' => $wallet,
      'callee' => function ($v) { return self::strict($v, ['publicKey' => self::pFn('isKey')]); },
      'callKey' => self::pFn('isCallKey'),
      'media' => function ($v) use ($fps) { return self::strict($v, ['kind' => self::pEq('audio'), 'fingerprints' => $fps]); },
    ];
    return self::$schemas = $s;
  }

  private static function signalBodies() {
    $fps = self::arrayOf(self::pFn('isFp'), 2);
    $reason = function ($v) { return is_string($v) && in_array($v, self::END_REASONS, true); };
    $nonce = self::pB64u(16, 128);
    $candidate = function ($c) {
      return self::strict($c, [
        'candidate' => self::pStr(1, 400),
        'sdpMid?' => function ($x) { return $x === null || self::isStr($x, 0, 40); },
        'sdpMLineIndex?' => function ($x) { return $x === null || self::isInt($x, 0, 8); },
      ]);
    };
    return [
      'accept' => ['inviteHash' => self::pFn('isHash'), 'calleeNonce' => $nonce, 'callKey' => self::pFn('isCallKey'), 'fingerprints' => $fps],
      'offer' => ['sdp' => self::pStr(20, self::LIMITS['sdpMaxBytes'])],
      'answer' => ['sdp' => self::pStr(20, self::LIMITS['sdpMaxBytes']), 'offerHash' => self::pFn('isHash')],
      'candidates' => [
        'candidates' => function ($v) use ($candidate) {
          if (!is_array($v) || count($v) > self::LIMITS['candidatesPerMessage']) return false;
          foreach ($v as $c) if (!$candidate($c)) return false;
          return true;
        },
        'end' => function ($v) { return is_bool($v); },
      ],
      'confirm' => [
        'fingerprints' => function ($v) { return self::strict($v, ['local' => self::pFn('isFp'), 'remote' => self::pFn('isFp')]); },
        'nonces' => function ($v) use ($nonce) { return self::strict($v, ['caller' => $nonce, 'callee' => $nonce]); },
        'offerHash' => self::pFn('isHash'), 'answerHash' => self::pFn('isHash'),
      ],
      'end' => ['reason' => $reason],
      'cancel' => [],
      'decline' => ['reason' => $reason],
      'busy' => ['reason' => $reason],
    ];
  }

  static function validateSignalPayload($p) {
    $bad = ['ok' => false, 'reason' => 'bad-schema'];
    $ok = self::strict($p, [
      'type' => self::pEq('atlas.call.signal'), 'v' => self::pEq(1), 'audience' => self::pStr(8, 200), 'callId' => self::pFn('isId128'),
      'kind' => function ($v) { return is_string($v) && in_array($v, self::SIGNAL_KINDS, true); },
      'seq?' => self::pInt(1, 100000), 'th?' => self::pFn('isHash'),
      'body' => function ($v) { return $v instanceof stdClass || is_array($v); },
    ]);
    if (!$ok) return $bad;
    $bodies = self::signalBodies();
    if (!self::strict($p->body, $bodies[$p->kind])) return ['ok' => false, 'reason' => 'bad-body'];
    $hasSeq = property_exists($p, 'seq'); $hasTh = property_exists($p, 'th');
    if ($p->kind === 'accept') {
      if ($hasSeq || $hasTh) return $bad;
    } elseif (in_array($p->kind, self::CK_KINDS, true)) {
      if (!$hasSeq) return $bad;
      if (!$hasTh && $p->kind !== 'cancel' && $p->kind !== 'end') return $bad;
    } elseif ($hasSeq || $hasTh) {
      return $bad;
    }
    return ['ok' => true];
  }

  static function validateEnvelope($e) {
    if (!($e instanceof stdClass)) return false;
    $role = self::get($e, 'signerRole');
    if ($role === 'raw-ecdsa') return self::strict($e, ['signerRole' => self::pEq('raw-ecdsa'), 'publicKey' => self::pFn('isKey'), 'signature' => self::pB64u(80, 100)]);
    if ($role === 'webauthn') return self::strict($e, [
      'signerRole' => self::pEq('webauthn'), 'publicKey' => self::pFn('isKey'), 'signature' => self::pB64u(60, 200),
      'clientDataJSON' => self::pB64u(20, 2048), 'authenticatorData' => self::pB64u(50, 1024),
    ]);
    return false;
  }

  static function validatePayload($p) {
    $bad = ['ok' => false, 'reason' => 'bad-schema'];
    if (!($p instanceof stdClass) || !property_exists($p, 'type') || !is_string($p->type)) return $bad;
    if ($p->type === 'atlas.call.signal') return self::validateSignalPayload($p);
    $schemas = self::schemas();
    if (!isset($schemas[$p->type]) || !self::strict($p, $schemas[$p->type])) return $bad;
    $lifetime = ['ok' => false, 'reason' => 'bad-lifetime'];
    if ($p->type === 'atlas.call.invite') {
      $ttl = self::parseTime($p->expiresAt) - self::parseTime($p->issuedAt);
      if (!($ttl > 0 && $ttl <= self::LIMITS['inviteTtlMs'])) return $lifetime;
    }
    if ($p->type === 'atlas.call.listen-session') {
      $ttl = self::parseTime($p->expiresAt) - self::parseTime($p->issuedAt);
      if (!($ttl > 0 && $ttl <= self::LIMITS['listenSessionMs'])) return $lifetime;
    }
    if ($p->type === 'atlas.call.tag-revoke' && (property_exists($p, 'tag') === property_exists($p, 'all'))) return $bad;
    if ($p->type === 'atlas.call.tag') {
      $ahead = self::parseTime($p->expiresAt) - self::parseTime($p->issuedAt);
      if (!($ahead > 0 && $ahead <= self::LIMITS['tagMaxAheadMs'])) return $lifetime;
    }
    return ['ok' => true];
  }

  // ---------- signatures ----------

  // Mirrors derToRawEcdsaSig in protocol.js, including its leniency about the outer length
  // and trailing bytes, so both sides accept exactly the same WebAuthn signatures.
  static function derToRaw($der) {
    $n = strlen($der);
    if ($n < 8 || ord($der[0]) !== 0x30) throw new Exception('malformed signature');
    $offset = 2;
    if (ord($der[1]) & 0x80) $offset = 2 + (ord($der[1]) & 0x7f);
    $read = function () use ($der, $n, &$offset) {
      if ($offset >= $n || ord($der[$offset]) !== 0x02) throw new Exception('malformed signature');
      $offset++;
      if ($offset >= $n) {
        $offset = $n + 1;
        return str_repeat("\0", 32);
      }
      $len = ord($der[$offset++]);
      $val = (string)substr($der, $offset, $len);
      $offset += $len;
      while (strlen($val) > 32 && $val[0] === "\0") $val = substr($val, 1);
      if (strlen($val) > 32) throw new Exception('malformed signature');
      return str_pad($val, 32, "\0", STR_PAD_LEFT);
    };
    $r = $read();
    $s = $read();
    return $r . $s;
  }
  private static function derInt($b32) {
    $t = ltrim($b32, "\0");
    if ($t === '') $t = "\0";
    if (ord($t[0]) & 0x80) $t = "\0" . $t;
    return "\x02" . chr(strlen($t)) . $t;
  }
  static function rawToDer($raw) {
    $body = self::derInt(substr($raw, 0, 32)) . self::derInt(substr($raw, 32, 32));
    return "\x30" . chr(strlen($body)) . $body;
  }
  static function spkiPem($der) {
    return "-----BEGIN PUBLIC KEY-----\n" . chunk_split(base64_encode($der), 64, "\n") . "-----END PUBLIC KEY-----\n";
  }
  // 1 valid, 0 not valid. $derSig is a DER ECDSA signature, $spki the 91-byte P-256 key.
  private static function opensslVerify($data, $derSig, $spki) {
    $key = @openssl_pkey_get_public(self::spkiPem($spki));
    if ($key === false) { while (openssl_error_string() !== false); return false; }
    $r = @openssl_verify($data, $derSig, $key, OPENSSL_ALGO_SHA256);
    while (openssl_error_string() !== false);
    return $r === 1;
  }

  // A raw ECDSA P-256 signature (64 bytes, base64url) by a raw public key (65-byte point,
  // base64url) over $data. Used for envelopes and for issuer-signed credentials.
  static function verifyRaw($data, $keyB64, $sigB64) {
    try {
      $point = self::b64urlDecode($keyB64);
      if (strlen($point) !== 65 || $point[0] !== "\x04") return false;
      $sig = self::b64urlDecode($sigB64);
      if (strlen($sig) !== 64) return false;
      return self::opensslVerify($data, self::rawToDer($sig), hex2bin(self::P256_SPKI_PREFIX_HEX) . $point);
    } catch (Throwable $e) {
      return false;
    }
  }

  // Verifies an envelope over a payload (SPEC.md section 6.2); true or false, never throws.
  static function verifyEnvelope($payload, $envelope) {
    try {
      if (!self::validateEnvelope($envelope)) return false;
      $data = self::canonicalize($payload);
      $prefix = hex2bin(self::P256_SPKI_PREFIX_HEX);
      if ($envelope->signerRole === 'raw-ecdsa') return self::verifyRaw($data, $envelope->publicKey, $envelope->signature);
      $dataHash = self::sha256Raw($data);
      $clientDataBuf = self::b64urlDecode($envelope->clientDataJSON);
      $clientData = json_decode($clientDataBuf, false);
      if (!($clientData instanceof stdClass)) return false;
      if (self::get($clientData, 'type') !== 'webauthn.get') return false;
      if (self::get($clientData, 'challenge') !== self::b64urlEncode($dataHash)) return false;
      $authData = self::b64urlDecode($envelope->authenticatorData);
      if (strlen($authData) < 37 || (ord($authData[32]) & 1) === 0) return false;
      $signed = $authData . self::sha256Raw($clientDataBuf);
      $spki = self::b64urlDecode($envelope->publicKey);
      if (strlen($spki) !== 91 || substr($spki, 0, 26) !== $prefix || $spki[26] !== "\x04") return false;
      $raw = self::derToRaw(self::b64urlDecode($envelope->signature));
      return self::opensslVerify($signed, self::rawToDer($raw), $spki);
    } catch (Throwable $e) {
      return false;
    }
  }

  // {payload, proof}: validates the shape, checks the signature, reports who signed.
  static function verifySigned($message) {
    if (!($message instanceof stdClass) || !self::truthy(self::get($message, 'payload')) || !self::truthy(self::get($message, 'proof'))) return ['ok' => false, 'reason' => 'bad-schema'];
    $shape = self::validatePayload($message->payload);
    if (!$shape['ok']) return $shape;
    if (!self::verifyEnvelope($message->payload, $message->proof)) return ['ok' => false, 'reason' => 'bad-signature'];
    return ['ok' => true, 'signer' => $message->proof->publicKey, 'payload' => $message->payload];
  }

  static function freshForService($payload, $now = null) {
    $t = $now === null ? self::nowMs() : $now;
    return abs($t - self::parseTime($payload->issuedAt)) <= self::LIMITS['serviceWindowMs'];
  }

  // ---------- ICE servers ----------

  static function ipv4Parts($host) {
    if (!preg_match('/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\z/', $host, $m)) return null;
    $o = [(int)$m[1], (int)$m[2], (int)$m[3], (int)$m[4]];
    foreach ($o as $n) if ($n > 255) return false;
    return $o;
  }
  static function privateIpv4($o) {
    return $o[0] === 0 || $o[0] === 10 || $o[0] === 127 || $o[0] >= 224 || ($o[0] === 100 && $o[1] >= 64 && $o[1] <= 127) ||
      ($o[0] === 169 && $o[1] === 254) || ($o[0] === 172 && $o[1] >= 16 && $o[1] <= 31) || ($o[0] === 192 && $o[1] === 168) ||
      ($o[0] === 192 && $o[1] === 0 && $o[2] === 0) || ($o[0] === 198 && ($o[1] === 18 || $o[1] === 19));
  }
  // True for an address or name that only means something on a local network.
  static function privateHost($host) {
    $h = preg_replace('/^\[|\]\z/', '', strtolower((string)$host));
    $v4 = self::ipv4Parts($h);
    if ($v4) return self::privateIpv4($v4);
    if (strpos($h, ':') !== false) {
      if ($h === '::' || $h === '::1' || preg_match('/^f[cd]/', $h) || preg_match('/^fe/', $h) || strncmp($h, 'ff', 2) === 0) return true;
      if (preg_match('/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})\z/', $h, $m)) { $o = self::ipv4Parts($m[1]); return !$o || self::privateIpv4($o); }
      if (preg_match('/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\z/', $h, $m)) {
        $a = hexdec($m[1]); $b = hexdec($m[2]);
        return self::privateIpv4([$a >> 8, $a & 255, $b >> 8, $b & 255]);
      }
      return false;
    }
    return strpos($h, '.') === false || preg_match('/\.(localhost|local|internal|lan|home\.arpa|corp|intranet)\z/', $h) === 1;
  }
  // Splits an ICE server URL into its parts, or null.
  static function parseIceUrl($u) {
    if (!is_string($u) || strlen($u) > 300) return null;
    if (!preg_match('/^(stun|stuns|turn|turns):(\[[0-9a-fA-F:.]{2,45}\]|[A-Za-z0-9.-]{1,253})(?::(\d{1,5}))?(?:\?transport=(udp|tcp))?\z/', $u, $m)) return null;
    $scheme = $m[1]; $host = $m[2];
    $transport = (isset($m[4]) && $m[4] !== '') ? $m[4] : null;
    $port = (isset($m[3]) && $m[3] !== '') ? (int)$m[3] : (($scheme === 'stuns' || $scheme === 'turns') ? 5349 : 3478);
    if (!($port >= 1 && $port <= 65535)) return null;
    if (($scheme === 'stun' || $scheme === 'stuns') && $transport) return null;
    if ($scheme === 'turns' && $transport === 'udp') return null;
    if ($host[0] === '[') {
      if (strpos($host, ':') === false) return null;
    } elseif (preg_match('/^[0-9.]+\z/', $host)) {
      if (!self::ipv4Parts($host)) return null;
    } else {
      if (strlen($host) > 253) return null;
      $labels = explode('.', $host);
      foreach ($labels as $l) if (!preg_match('/^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\z/', $l)) return null;
      if (preg_match('/^(0x[0-9a-f]*|\d+)\z/i', end($labels))) return null;
    }
    return ['scheme' => $scheme, 'host' => $host, 'port' => $port, 'transport' => $transport, 'turn' => $scheme === 'turn' || $scheme === 'turns'];
  }
  // Why a URL cannot be used, or null. kind is 'stun' or 'turn'.
  static function iceUrlProblem($u, $o = []) {
    $p = self::parseIceUrl($u);
    if (!$p) return 'is not of the form stun:host[:port] or turn:host[:port][?transport=udp|tcp] (turns: for TLS)';
    $kind = isset($o['kind']) ? $o['kind'] : null;
    if ($kind === 'stun' && $p['turn']) return 'is a TURN URL where STUN is expected';
    if ($kind === 'turn' && !$p['turn']) return 'is a STUN URL where TURN is expected';
    if (empty($o['allowPrivate'])) {
      if (self::privateHost($p['host'])) return 'names a private, loopback or local address';
      if ($p['turn'] && !in_array($p['port'], self::ICE_TURN_PORTS, true)) return 'uses a TURN port other than ' . implode(', ', self::ICE_TURN_PORTS);
    }
    return null;
  }
}
