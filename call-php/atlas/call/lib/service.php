<?php
// Domain Atlas Call Service (PHP): the same routes, checks and call states as
// call-server/server.js, for hosting that runs one short PHP process per request.
//
// Differences that follow from that, and nothing else:
//   - No request is held open. listen and poll answer at once and say how long to wait before
//     asking again (nextPollMs). A mailbox is "listening" while its last request is recent.
//   - Time-based endings (ring timeout, missing answer, silence, longest call) are applied
//     when a call is next touched and by a sweep that any request runs once the previous
//     sweep is older than sweepMs.
//   - Rate limits are counted per second over the last 60 seconds.
//   - Connection and waiter limits belong to the web server and are not repeated here.
// Wire messages, schemas, authentication order, replay protection, membership rules, call
// state machine, per-call counters and refusal uniformity are those of the Node service.

require_once __DIR__ . '/protocol.php';
require_once __DIR__ . '/store.php';

final class CallService {
  const DEFAULT_TIMERS = [
    'acceptToOfferMs' => 20000, 'offerToAnswerMs' => 20000, 'confirmMs' => 40000, 'endedRetainMs' => 60000,
    'seenCallIdMs' => 600000, 'sweepMs' => 2000, 'silentActiveMs' => 90000, 'maxCallMs' => 14400000,
    'listenerFreshMs' => 20000, 'revocationCacheMs' => 60000, 'fetchTimeoutMs' => 5000, 'lockWaitMs' => 3000,
  ];
  const DEFAULT_LIMITS = [
    'maxLiveCalls' => 200, 'maxTurnCredentialsPerRole' => 3, 'maxListeners' => 5000, 'maxNonces' => 100000,
    'maxTagsTotal' => 20000, 'maxSignalsPerCall' => 300, 'perSourcePerMin' => 600, 'invitesPerSourcePerMin' => 20,
    'invitesPerCallerPerMin' => 6, 'invitesPerCalleePerMin' => 6, 'tagCreatePerOwnerPerMin' => 30, 'maxEventsPerMailbox' => 100,
  ];
  const DEFAULT_POLL = ['listenIdleMs' => 3000, 'ringingMs' => 1200, 'setupMs' => 600, 'activeMs' => 2500];

  public $cfg;
  public $store;
  public $T;
  public $L;
  public $poll;
  private $ready = false;
  private $clock = null;

  function __construct($cfg, $store, $clock = null) {
    $this->cfg = $cfg;
    $this->store = $store;
    $this->T = array_merge(self::DEFAULT_TIMERS, isset($cfg['timers']) ? $cfg['timers'] : []);
    $this->L = array_merge(self::DEFAULT_LIMITS, isset($cfg['limits']) ? $cfg['limits'] : []);
    $this->poll = array_merge(self::DEFAULT_POLL, isset($cfg['poll']) ? $cfg['poll'] : []);
    $this->clock = $clock;
  }
  function now() { return $this->clock ? call_user_func($this->clock) : CallProto::nowMs(); }
  private function iso($ms) { return CallProto::isoTime($ms); }

  // ---------- results ----------

  function fail($status, $code, $message = null, $extra = [], $headers = []) {
    return ['status' => $status, 'body' => array_merge(['error' => $message === null ? $code : $message, 'code' => $code], $extra), 'headers' => $headers];
  }
  function unavailable() { return $this->fail(404, 'unavailable', 'unavailable'); }
  private function ok($status, $body) { return ['status' => $status, 'body' => $body, 'headers' => []]; }
  private function busy() { return $this->fail(503, 'busy', 'busy', [], ['Retry-After: 10']); }

  // Runs $fn holding the state lock. $fn returns a result, or null to say it has none.
  function locked($fn) {
    try {
      if (!$this->ready) {
        if (!$this->store->ensure()) return $this->fail(503, 'state-unavailable', 'state unavailable', [], ['Retry-After: 30']);
        $this->ready = true;
      }
      if (!$this->store->lock($this->T['lockWaitMs'])) return $this->fail(503, 'busy', 'busy', [], ['Retry-After: 2']);
      try {
        return $fn();
      } finally {
        $this->store->unlock();
      }
    } catch (RuntimeException $e) {
      if ($e->getMessage() === 'state-unwritable') return $this->fail(503, 'state-unavailable', 'state unavailable', [], ['Retry-After: 30']);
      throw $e;
    }
  }

  // ---------- rate limits and housekeeping ----------

  function limited($key, $limit) { return $this->store->rateLimited($key, $limit, $this->now()); }

  // The per-source request limit that every route takes before it reads a body. Also the
  // moment a due sweep runs.
  function admit($source) {
    return $this->locked(function () use ($source) {
      if ($this->limited('src:' . $source, $this->L['perSourcePerMin'])) return $this->fail(429, 'rate-limited', 'too many requests');
      $this->sweepIfDue();
      return null;
    });
  }

  private function sweepIfDue() {
    $t = $this->now();
    $meta = $this->store->meta();
    if ($t - $meta['sweepAt'] < $this->T['sweepMs'] && $t >= $meta['sweepAt']) return;
    $meta['sweepAt'] = $t;
    $slow = $t - $meta['slowAt'] >= 30000 || $t < $meta['slowAt'];
    if ($slow) $meta['slowAt'] = $t;
    $this->store->putMeta($meta);
    $this->sweep($slow);
  }

  // Ends calls whose time has run out, forgets old calls, and on the slow pass clears old
  // nonces, rate counters, idle listeners and expired tags. Bounded work per pass.
  function sweep($slow = true) {
    $t = $this->now();
    $index = $this->store->callIndex();
    $changed = false;
    $n = 0;
    foreach ($index as $name => $e) {
      $created = (int)$e[0]; $ended = (int)$e[1];
      if ($ended === 0) {
        if (++$n > 400) continue;
        $call = $this->store->getShardFile('calls', substr($name, 0, 2), $name);
        if ($call === null) { unset($index[$name]); $changed = true; continue; }
        if ($this->expire($call)) {
          $this->store->put('calls', $call['id'], $call);
          $index[$name] = [$created, (int)$call['endedAt']];
          $changed = true;
        }
      } elseif ($t - $ended >= $this->T['endedRetainMs'] && $t - $created >= $this->T['seenCallIdMs']) {
        $this->store->removeShardFile('calls', substr($name, 0, 2), $name);
        unset($index[$name]);
        $changed = true;
      }
    }
    if ($changed) $this->store->putCallIndex($index);
    if (!$slow) return;
    $this->store->purgeNonces($t, CallProto::LIMITS['nonceRetainMs']);
    $this->store->purgeRate($t);
    $meta = $this->store->meta();
    $this->sweepListeners($t, $meta);
    $this->sweepTags($t, $meta);
    $this->store->putMeta($meta);
  }

  private function sweepListeners($t, &$meta) {
    $names = $this->store->listFlat('listeners');
    $count = count($names);
    $seen = 0;
    foreach ($names as $name) {
      if ($this->store->fileTime('listeners', $name) * 1000 >= $t - 2 * $this->T['listenerFreshMs']) continue;
      if (++$seen > 500) break;
      $mb = $this->store->getFlat('listeners', $name);
      if ($mb === null) continue;
      $mb += ['events' => []];
      $this->prune($mb);
      if (!$mb['events']) { $this->store->removeByName('listeners', $name); $count--; }
      else $this->store->putFlat('listeners', $name, $mb);
    }
    $meta['listeners'] = max(0, $count);
  }

  private function sweepTags($t, &$meta) {
    $shards = $this->store->shards('tags');
    if (!$shards) return;
    $cursor = isset($meta['tagCursor']) ? (int)$meta['tagCursor'] : 0;
    for ($i = 0; $i < 16; $i++) {
      $shard = sprintf('%02x', ($cursor + $i) % 256);
      foreach ($this->store->shardFiles('tags', $shard) as $name) {
        $tag = $this->store->getShardFile('tags', $shard, $name);
        if ($tag === null) { $this->store->removeShardFile('tags', $shard, $name); continue; }
        if (CallProto::parseTime($tag['expiresAt']) <= $t) {
          $this->store->removeShardFile('tags', $shard, $name);
          $meta['tags'] = max(0, $meta['tags'] - 1);
          $this->dropFromOwner($tag['owner'], $tag['hash']);
        }
      }
    }
    $meta['tagCursor'] = ($cursor + 16) % 256;
  }

  // ---------- mailboxes ----------

  private function mailbox() { return ['events' => [], 'next' => 1]; }
  private function push(&$mb, $ev, $expiresAt = null) {
    if (count($mb['events']) >= $this->L['maxEventsPerMailbox']) array_shift($mb['events']);
    $ev['id'] = $mb['next']++;
    if ($expiresAt) $ev['expiresAt'] = $expiresAt;
    $mb['events'][] = $ev;
    return $ev['id'];
  }
  private function prune(&$mb) {
    $t = $this->now();
    $out = [];
    foreach ($mb['events'] as $e) if (!isset($e['expiresAt']) || $e['expiresAt'] > $t) $out[] = $e;
    $mb['events'] = $out;
  }
  private function decodeText($text) { return json_decode($text, false); }
  private function outListenerEvent($e) {
    $o = ['id' => $e['id'], 'type' => $e['type'], 'callId' => $e['callId']];
    if (isset($e['invite'])) $o['invite'] = $this->decodeText($e['invite']);
    if (isset($e['message'])) $o['message'] = $this->decodeText($e['message']);
    if (isset($e['reason'])) $o['reason'] = $e['reason'];
    if (isset($e['expiresAt'])) $o['expiresAt'] = $e['expiresAt'];
    return $o;
  }

  private function loadListener($owner) {
    $mb = $this->store->get('listeners', $owner, false);
    if ($mb === null) return null;
    return $mb + ['events' => [], 'next' => 1, 'lastSeen' => 0, 'owner' => $owner];
  }
  private function saveListener($owner, $mb) { $this->store->put('listeners', $owner, $mb, false); }

  // ---------- calls ----------

  private function callName($callId) { return CallStore::key($callId); }
  private function loadRaw($callId) { return $this->store->get('calls', $callId); }

  // A call that is still remembered, with any time-based ending already applied; null when the
  // call is unknown or has been over for longer than endedRetainMs.
  private function getCall($callId) {
    $call = $this->loadRaw($callId);
    if ($call === null) return null;
    $t = $this->now();
    if ($call['endedAt'] > 0 && $t - $call['endedAt'] >= $this->T['endedRetainMs']) return null;
    if ($this->expire($call)) $this->store->put('calls', $callId, $call);
    return $call;
  }

  private function saveCall($call) { $this->store->put('calls', $call['id'], $call); }

  private function indexEnded($call) {
    $index = $this->store->callIndex();
    $name = $this->callName($call['id']);
    $created = isset($index[$name]) ? (int)$index[$name][0] : (int)$call['createdAt'];
    $index[$name] = [$created, (int)$call['endedAt']];
    $this->store->putCallIndex($index);
  }

  // Applies the call's time limits. True when the call changed (and the caller must save it).
  private function expire(&$call) {
    if ($call['state'] === 'ENDED') return false;
    $t = $this->now();
    if ($call['state'] === 'RINGING' && $t >= $call['inviteExpiresAt']) $this->endCall($call, 'timeout');
    elseif ($call['deadline'] && $t >= $call['deadline']) $this->endCall($call, 'timeout');
    elseif ($call['state'] === 'ACTIVE' && ($t - max($call['lastSeenA'], $call['lastSeenB']) > $this->T['silentActiveMs'])) $this->endCall($call, 'network-lost');
    elseif ($t - $call['createdAt'] > $this->T['maxCallMs']) $this->endCall($call, 'timeout');
    else return false;
    return true;
  }

  private function removeListenerEvents($call) {
    $mb = $this->loadListener($call['owner']);
    if ($mb === null) return;
    $out = [];
    foreach ($mb['events'] as $e) {
      if (!isset($e['callId']) || $e['callId'] !== $call['id'] || $e['type'] === 'cancel' || $e['type'] === 'ended') $out[] = $e;
    }
    if (count($out) !== count($mb['events'])) { $mb['events'] = $out; $this->saveListener($call['owner'], $mb); }
  }

  // Service-originated end (timeout, decline, busy, revoked, idle): tells both sides once. The
  // caller saves $call.
  private function endCall(&$call, $reason, $who = null) {
    if ($call['state'] === 'ENDED') return;
    $call['state'] = 'ENDED';
    $call['endedAt'] = $this->now();
    $call['endReason'] = $reason;
    $this->indexEnded($call);
    $this->removeListenerEvents($call);
    if ($who !== 'caller') $this->push($call['boxA'], ['type' => 'ended', 'reason' => $reason]);
    if ($who !== 'callee') {
      if ($call['accepted']) $this->push($call['boxB'], ['type' => 'ended', 'reason' => $reason]);
      else {
        $mb = $this->loadListener($call['owner']);
        if ($mb !== null) {
          $this->push($mb, ['type' => 'ended', 'callId' => $call['id'], 'reason' => $reason], $this->now() + $this->T['endedRetainMs']);
          $this->saveListener($call['owner'], $mb);
        }
      }
    }
  }

  // ---------- tags ----------

  private function loadOwner($owner) { return $this->store->get('owners', $owner, false); }
  private function dropFromOwner($owner, $hash) {
    $o = $this->loadOwner($owner);
    if ($o === null || !isset($o['tags'][$hash])) return;
    unset($o['tags'][$hash]);
    if ($o['tags']) $this->store->put('owners', $owner, $o, false); else $this->store->remove('owners', $owner, false);
  }
  // Unexpired tag hashes the wallet holds, and the owner file with the expired ones removed.
  private function liveTags($owner) {
    $o = $this->loadOwner($owner);
    if ($o === null) return [];
    $t = $this->now();
    $out = [];
    foreach ($o['tags'] as $h => $exp) if ($exp > $t) $out[(string)$h] = $exp;
    return $out;
  }

  // ---------- authentication ----------

  // Checks, in order: shape, route type, audience, freshness, signature(s). The nonce is spent
  // later, inside the lock, by spend(). Returns payload, signer, owner, mode, or error.
  function authenticate($body, $type, $o = []) {
    $o += ['extra' => [], 'session' => false, 'modes' => null];
    $malformed = $this->fail(400, 'bad-request', 'malformed request');
    if (!($body instanceof stdClass)) return ['error' => $malformed];
    $allowed = array_merge(['payload', 'proof'], $o['extra']);
    if ($o['session']) $allowed[] = 'session';
    foreach ($body as $k => $_) if (!in_array((string)$k, $allowed, true)) return ['error' => $this->fail(400, 'bad-request', 'unknown field')];
    $payload = CallProto::get($body, 'payload');
    $proof = CallProto::get($body, 'proof');
    $shape = CallProto::validatePayload($payload);
    if (!$shape['ok'] || $payload->type !== $type || !CallProto::validateEnvelope($proof)) return ['error' => $malformed];
    $origin = $this->cfg['origin'];
    $wrongAudience = $this->fail(401, 'wrong-audience', 'this message is addressed to a different service');
    if ($payload->audience !== $origin) return ['error' => $wrongAudience];
    if (!CallProto::freshForService($payload, $this->now())) return ['error' => $this->fail(401, 'stale-request', 'check this device\'s clock', ['serverTime' => $this->iso($this->now())])];
    $badSig = $this->fail(401, 'bad-signature', 'signature check failed');

    if (CallProto::has($body, 'session')) {
      if (!$o['session']) return ['error' => $this->fail(400, 'bad-request', 'unknown field')];
      $s = $body->session;
      if (!($s instanceof stdClass)) return ['error' => $malformed];
      $sp = CallProto::get($s, 'payload'); $sproof = CallProto::get($s, 'proof');
      $sShape = CallProto::validatePayload($sp);
      if (!$sShape['ok'] || $sp->type !== 'atlas.call.listen-session' || !CallProto::validateEnvelope($sproof)) return ['error' => $malformed];
      if ($sp->audience !== $origin) return ['error' => $wrongAudience];
      $t = $this->now();
      if (CallProto::parseTime($sp->issuedAt) > $t + CallProto::LIMITS['walletSkewMs'] || CallProto::parseTime($sp->expiresAt) < $t) return ['error' => $this->fail(401, 'session-expired', 'the listening session has expired')];
      if ($proof->signerRole !== 'raw-ecdsa' || $proof->publicKey !== $sp->sessionKey) return ['error' => $badSig];
      $okSession = CallProto::verifyEnvelope($sp, $sproof);
      $okReq = $okSession && CallProto::verifyEnvelope($payload, $proof);
      if (!$okReq) return ['error' => $badSig];
      return ['payload' => $payload, 'signer' => $proof->publicKey, 'owner' => $sproof->publicKey, 'mode' => 'C'];
    }
    if ($o['modes'] === 'C') return ['error' => $this->fail(401, 'session-required', 'a listening session is required')];
    if ($o['modes'] === 'B' && $proof->signerRole !== 'raw-ecdsa') return ['error' => $badSig];
    if (!CallProto::verifyEnvelope($payload, $proof)) return ['error' => $badSig];
    return ['payload' => $payload, 'signer' => $proof->publicKey, 'owner' => $proof->publicKey, 'mode' => $o['modes'] === 'B' ? 'B' : 'A'];
  }

  // Inside the lock: records the request's nonce, or says why not. Null when it is new.
  function spend($a) {
    if (!CallProto::has($a['payload'], 'nonce')) return null;
    $t = $this->now();
    if ($this->store->nonceSeen($a['signer'], $a['payload']->nonce, $t, CallProto::LIMITS['nonceRetainMs'])) return $this->fail(401, 'replayed-request', 'this request was already used');
    $perBucket = max(8, intdiv($this->L['maxNonces'], 256 * 4));
    if (!$this->store->nonceAdd($a['signer'], $a['payload']->nonce, $t, $perBucket)) return $this->busy();
    return null;
  }

  // ---------- membership (tag creation only) ----------

  // The ids a domain's issuer has revoked, or null when they cannot be read. Read from the
  // issuer's published file on this server when revocationsFile is set, otherwise fetched from
  // revocationsUrl (cached for revocationCacheMs). Nothing is assumed when neither can be read.
  private function revokedIds() {
    $file = isset($this->cfg['revocationsFile']) ? $this->cfg['revocationsFile'] : null;
    $url = isset($this->cfg['revocationsUrl']) ? $this->cfg['revocationsUrl'] : null;
    if (!$file && !$url) return [];
    if ($file) {
      $text = @file_get_contents($file, false, null, 0, 1048577);
      if ($text === false || strlen($text) > 1048576) return null;
    } else {
      $cached = $this->store->get('cache', 'revocations', false);
      $t = $this->now();
      if (is_array($cached) && isset($cached['at']) && $t >= $cached['at'] && $t - $cached['at'] < $this->T['revocationCacheMs']) return $cached['ids'];
      $text = $this->fetchRevocations($url);
      if ($text === null) return null;
    }
    $doc = json_decode($text, false);
    if (!($doc instanceof stdClass)) return null;
    $ids = [];
    $list = CallProto::get($doc, 'revoked');
    if (is_array($list)) foreach ($list as $x) { $id = CallProto::get($x, 'id'); if (is_string($id)) $ids[] = $id; }
    if (!$file) $this->store->put('cache', 'revocations', ['at' => $this->now(), 'ids' => $ids], false);
    return $ids;
  }

  private function fetchRevocations($url) {
    if (!function_exists('curl_init')) return null;
    $u = parse_url($url);
    if (!$u || empty($u['host']) || empty($u['scheme'])) return null;
    $port = isset($u['port']) ? $u['port'] : ($u['scheme'] === 'https' ? 443 : 80);
    $host = $u['host'];
    $addrs = filter_var($host, FILTER_VALIDATE_IP) ? [$host] : (gethostbynamel($host) ?: []);
    if (!$addrs) return null;
    if (empty($this->cfg['devAllowPrivateFetch'])) foreach ($addrs as $a) if (CallProto::privateHost($a)) return null;
    $ch = curl_init($url);
    curl_setopt_array($ch, [
      CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => false, CURLOPT_TIMEOUT_MS => $this->T['fetchTimeoutMs'],
      CURLOPT_CONNECTTIMEOUT_MS => $this->T['fetchTimeoutMs'], CURLOPT_HTTPHEADER => ['Accept: application/json'],
      CURLOPT_RESOLVE => [$host . ':' . $port . ':' . $addrs[0]], CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
      CURLOPT_MAXFILESIZE => 1048576,
    ]);
    $text = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    if ($text === false || $code !== 200 || strlen($text) > 1048576) return null;
    return $text;
  }

  // A credential's expiry as epoch milliseconds, null when it does not parse.
  private function credentialExpiry($s) {
    $ms = CallProto::parseTime($s);
    if ($ms !== null) return $ms;
    if (!preg_match('/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?\z/', $s)) return null;
    try { $d = new DateTimeImmutable($s, new DateTimeZone('UTC')); } catch (Exception $e) { return null; }
    return $d->getTimestamp() * 1000;
  }

  // Null when the credential is a current Post Office membership of this domain held by $signer.
  private function checkMembership($cred, $signer) {
    $req = 'membership-required';
    if (!($cred instanceof stdClass) || CallProto::get($cred, 'credential') !== 'domain-atlas-asset/1.0') return $req;
    $asset = CallProto::get($cred, 'asset'); $owner = CallProto::get($cred, 'owner'); $issuer = CallProto::get($cred, 'issuer');
    if (!is_string(CallProto::get($cred, 'id')) || !($asset instanceof stdClass) || CallProto::get($asset, 'class') !== 'atlas.postoffice.membership') return $req;
    if (!($owner instanceof stdClass) || CallProto::get($owner, 'publicKey') !== $signer) return $req;
    if (!($issuer instanceof stdClass) || CallProto::get($issuer, 'domain') !== $this->cfg['domain']) return $req;
    if (!is_string(CallProto::get($cred, 'signature'))) return $req;
    $exp = CallProto::get($asset, 'expiresAt');
    if (is_string($exp)) {
      $ms = $this->credentialExpiry($exp);
      if ($ms === null || $this->now() > $ms) return $req;
    }
    foreach (['quantity', 'supersedes', 'issuedAt'] as $f) if (!CallProto::has($cred, $f)) return $req;
    $data = CallProto::canonicalize(CallProto::obj(['id' => $cred->id, 'asset' => $asset, 'owner' => $owner, 'quantity' => $cred->quantity, 'supersedes' => $cred->supersedes, 'issuedAt' => $cred->issuedAt]));
    $good = false;
    foreach ($this->cfg['issuerKeys'] as $k) if (CallProto::verifyRaw($data, $k, $cred->signature)) { $good = true; break; }
    if (!$good) return $req;
    if (!empty($this->cfg['revocationsFile']) || !empty($this->cfg['revocationsUrl'])) {
      $ids = $this->revokedIds();
      if ($ids === null) return 'revocations-unavailable';
      if (in_array($cred->id, $ids, true)) return $req;
    }
    return null;
  }

  // ---------- routes ----------

  function info() {
    $turn = $this->turnEnabled();
    $cfgd = !empty($this->cfg['configured']);
    $out = [
      'service' => 'atlas-call', 'v' => 1, 'configured' => $cfgd, 'serverTime' => $this->iso($this->now()),
      'limits' => ['inviteTtlMs' => CallProto::LIMITS['inviteTtlMs'], 'maxCallsPerTag' => CallProto::LIMITS['maxCallsPerTag'], 'maxTagsPerWallet' => CallProto::LIMITS['maxTagsPerWallet'], 'listenHoldMs' => 0],
      'ice' => ['stun' => $cfgd ? $this->cfg['stunUrls'] : [], 'turn' => $turn],
    ];
    if ($cfgd) {
      $out['audience'] = $this->cfg['origin'];
      $out['domain'] = $this->cfg['domain'];
      $out['polling'] = $this->poll;
      $out['ready'] = $this->store->writable();
      if ($turn) $out['ice']['turnUrls'] = $this->cfg['turnUrls'];
    }
    return $this->ok(200, $out);
  }
  private function turnEnabled() { return !empty($this->cfg['configured']) && !empty($this->cfg['turnUrls']) && !empty($this->cfg['turnSecret']); }

  function routeTagCreate($body, $ctx) {
    $a = $this->authenticate($body, 'atlas.call.tag', ['modes' => 'A', 'extra' => ['membership']]);
    if (isset($a['error'])) return $a['error'];
    $p = $a['payload'];
    $first = $this->locked(function () use ($a) {
      if ($r = $this->spend($a)) return $r;
      return null;
    });
    if ($first) return $first;
    if ($p->calleeKey !== $a['signer']) return $this->fail(400, 'bad-request', 'calleeKey must be the signer');
    if (CallProto::parseTime($p->expiresAt) <= $this->now()) return $this->fail(400, 'bad-request', 'tag already expired');
    $limited = $this->locked(function () use ($a) {
      if ($this->limited('tagc:' . $a['owner'], $this->L['tagCreatePerOwnerPerMin'])) return $this->fail(429, 'rate-limited', 'too many requests');
      return null;
    });
    if ($limited) return $limited;
    $m = $this->checkMembership(CallProto::get($body, 'membership'), $a['signer']);
    if ($m === 'revocations-unavailable') return $this->fail(503, 'revocations-unavailable', 'cannot confirm membership right now');
    if ($m) return $this->fail(403, 'membership-required', 'a Post Office membership from this domain is required');
    return $this->locked(function () use ($a, $p) {
      $mine = count($this->liveTags($a['owner']));
      $meta = $this->store->meta();
      if ($mine >= CallProto::LIMITS['maxTagsPerWallet'] || $meta['tags'] >= $this->L['maxTagsTotal']) return $this->fail(429, 'tag-quota', 'too many tags');
      $tag = CallProto::randomId(16);
      $h = CallProto::tagHash($tag);
      $exp = CallProto::parseTime($p->expiresAt);
      $this->store->put('tags', $h, [
        'hash' => $h, 'owner' => $a['owner'], 'bind' => ['kind' => 'wallet', 'publicKey' => $p->bind->publicKey], 'calleeKey' => $p->calleeKey,
        'createdAt' => $this->iso($this->now()), 'expiresAt' => $p->expiresAt, 'maxCalls' => $p->maxCalls, 'used' => 0, 'ringing' => null,
      ]);
      $o = $this->loadOwner($a['owner']);
      if ($o === null) $o = ['owner' => $a['owner'], 'tags' => []];
      $o['tags'][$h] = $exp;
      $this->store->put('owners', $a['owner'], $o, false);
      $meta['tags']++;
      $this->store->putMeta($meta);
      return $this->ok(200, ['tag' => $tag, 'expiresAt' => $p->expiresAt]);
    });
  }

  function routeTagList($body, $ctx) {
    $a = $this->authenticate($body, 'atlas.call.tag-list', ['session' => true]);
    if (isset($a['error'])) return $a['error'];
    return $this->locked(function () use ($a) {
      if ($r = $this->spend($a)) return $r;
      $out = [];
      foreach ($this->liveTags($a['owner']) as $h => $_) {
        $t = $this->store->get('tags', (string)$h);
        if ($t === null) continue;
        $out[] = ['id' => substr((string)$h, 0, 12), 'bind' => ['publicKey' => $t['bind']['publicKey']], 'createdAt' => $t['createdAt'], 'expiresAt' => $t['expiresAt'], 'maxCalls' => $t['maxCalls'], 'used' => $t['used']];
      }
      return $this->ok(200, ['tags' => $out, 'serverTime' => $this->iso($this->now())]);
    });
  }

  function routeTagRevoke($body, $ctx) {
    $a = $this->authenticate($body, 'atlas.call.tag-revoke', ['session' => true]);
    if (isset($a['error'])) return $a['error'];
    $p = $a['payload'];
    return $this->locked(function () use ($a, $p) {
      if ($r = $this->spend($a)) return $r;
      if ($a['mode'] === 'C' && !CallProto::has($p, 'tag')) return $this->fail(400, 'bad-request', 'a listening session may revoke one tag only');
      $doomed = [];
      if (CallProto::has($p, 'tag')) {
        $h = CallProto::tagHash($p->tag);
        $o = $this->loadOwner($a['owner']);
        if ($o !== null && isset($o['tags'][$h])) $doomed[] = (string)$h;
        // A tag in the owner's list may have expired; it is removed all the same.
      } else {
        $o = $this->loadOwner($a['owner']);
        if ($o !== null) foreach ($o['tags'] as $h => $_) $doomed[] = (string)$h;
      }
      $live = 0;
      $t = $this->now();
      foreach ($doomed as $h) {
        $tag = $this->store->get('tags', $h);
        if ($tag !== null && $tag['owner'] === $a['owner']) {
          if (CallProto::parseTime($tag['expiresAt']) > $t) $live++;
          $this->store->remove('tags', $h);
          if (!empty($tag['ringing'])) {
            $call = $this->getCall($tag['ringing']);
            if ($call !== null && $call['state'] === 'RINGING') { $this->endCall($call, 'unavailable'); $this->saveCall($call); }
          }
        }
        $this->dropFromOwner($a['owner'], $h);
      }
      if ($doomed) { $meta = $this->store->meta(); $meta['tags'] = max(0, $meta['tags'] - count($doomed)); $this->store->putMeta($meta); }
      return $this->ok(200, ['ok' => true, 'revoked' => $live]);
    });
  }

  function routeListen($body, $ctx) {
    $a = $this->authenticate($body, 'atlas.call.listen', ['modes' => 'C', 'session' => true]);
    if (isset($a['error'])) return $a['error'];
    $p = $a['payload'];
    return $this->locked(function () use ($a, $p) {
      if ($r = $this->spend($a)) return $r;
      $t = $this->now();
      $meta = $this->store->meta();
      if (CallProto::has($p, 'stop') && $p->stop === true) {
        if ($this->store->exists('listeners', $a['owner'], false)) {
          $this->store->remove('listeners', $a['owner'], false);
          $meta['listeners'] = max(0, $meta['listeners'] - 1);
          $this->store->putMeta($meta);
        }
        return $this->ok(200, ['events' => [], 'serverTime' => $this->iso($t), 'nextPollMs' => $this->poll['listenIdleMs']]);
      }
      $stranger = !$this->liveTags($a['owner']);
      $mb = $this->loadListener($a['owner']);
      if ($mb === null) {
        if ($stranger && $meta['listeners'] >= $this->L['maxListeners']) return $this->busy();
        $mb = $this->mailbox() + ['owner' => $a['owner'], 'lastSeen' => 0];
        $meta['listeners']++;
        $this->store->putMeta($meta);
      }
      $mb['lastSeen'] = $t;
      $ack = array_flip(array_map('intval', $p->ack));
      $kept = [];
      foreach ($mb['events'] as $e) if (!isset($ack[$e['id']])) $kept[] = $e;
      $mb['events'] = $kept;
      $this->prune($mb);
      $this->saveListener($a['owner'], $mb);
      $events = array_map([$this, 'outListenerEvent'], array_slice($mb['events'], 0, 10));
      return $this->ok(200, ['events' => $events, 'serverTime' => $this->iso($t), 'nextPollMs' => $events ? min(1000, $this->poll['listenIdleMs']) : $this->poll['listenIdleMs']]);
    });
  }

  function routeInvite($body, $ctx) {
    $isId = function ($v) { return is_string($v) && preg_match('/^[A-Za-z0-9_-]{22}\z/', $v) === 1; };
    if (!($body instanceof stdClass)) return $this->fail(400, 'bad-request', 'malformed request');
    foreach ($body as $k => $_) if ((string)$k !== 'tag' && (string)$k !== 'invite') return $this->fail(400, 'bad-request', 'malformed request');
    if (!$isId(CallProto::get($body, 'tag')) || !(CallProto::get($body, 'invite') instanceof stdClass)) return $this->fail(400, 'bad-request', 'malformed request');
    $a = $this->authenticate($body->invite, 'atlas.call.invite', ['modes' => 'A']);
    if (isset($a['error'])) return $a['error'];
    $p = $a['payload'];
    $source = $ctx['source'];
    return $this->locked(function () use ($a, $p, $body, $source) {
      if ($r = $this->spend($a)) return $r;
      if ($this->limited('inv-src:' . $source, $this->L['invitesPerSourcePerMin']) || $this->limited('inv-key:' . $a['signer'], $this->L['invitesPerCallerPerMin'])) return $this->fail(429, 'rate-limited', 'too many requests');

      // Everything below that depends on stored state ends in the same refusal.
      $h = CallProto::tagHash($body->tag);
      $tag = $this->store->get('tags', $h);
      $t = $this->now();
      $mb = $tag ? $this->loadListener($tag['owner']) : null;
      $callName = $this->callName($p->callId);
      $ringing = false;
      if ($tag && !empty($tag['ringing'])) {
        $rc = $this->getCall($tag['ringing']);
        $ringing = $rc !== null && $rc['state'] === 'RINGING';
      }
      $index = $this->store->callIndex();
      $live = 0;
      foreach ($index as $e) if ((int)$e[1] === 0 || $t - (int)$e[1] < $this->T['endedRetainMs']) $live++;
      $failed = [];
      if (!$tag) {
        $failed[] = 'no-such-tag';
      } else {
        $checks = [
          'outer-tag-differs-from-signed-tag' => $p->tag === $body->tag,
          'tag-not-bound-to-this-caller' => $tag['bind']['publicKey'] === $a['signer'] && $p->caller->publicKey === $a['signer'],
          'callee-key-differs-from-tag' => $p->callee->publicKey === $tag['calleeKey'],
          'tag-expired' => CallProto::parseTime($tag['expiresAt']) > $t,
          'tag-used-up' => $tag['used'] < $tag['maxCalls'],
          'invite-already-expired' => CallProto::parseTime($p->expiresAt) > $t,
          'invite-issued-in-the-future' => CallProto::parseTime($p->issuedAt) <= $t + CallProto::LIMITS['walletSkewMs'],
          'call-id-already-seen' => !isset($index[$callName]),
          'another-call-is-ringing-on-this-tag' => !$ringing,
          'callee-not-listening' => $mb !== null && ($t - $mb['lastSeen'] <= $this->T['listenerFreshMs']),
          'service-at-live-call-limit' => $live < $this->L['maxLiveCalls'],
        ];
        foreach ($checks as $why => $ok) if (!$ok) $failed[] = $why;
        // The callee's own rate is counted only for an invitation that passed everything else.
        if (!$failed && $this->limited('inv-callee:' . $tag['owner'], $this->L['invitesPerCalleePerMin'])) $failed[] = 'callee-rate-limited';
      }
      if ($failed) {
        // The reply is the same for every reason. With logRefusals on, the operator's error log
        // gets the reason, never the caller, the tag or any key.
        if (!empty($this->cfg['logRefusals'])) {
          $age = ($tag && $mb !== null) ? (int)($t - $mb['lastSeen']) : null;
          error_log('[atlas-call] invite refused: ' . implode(',', $failed) . ($age !== null ? ' (listener last seen ' . $age . ' ms ago, allowed ' . $this->T['listenerFreshMs'] . ')' : ''));
        }
        return $this->unavailable();
      }

      $invite = json_encode(['payload' => $p, 'proof' => $body->invite->proof], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION);
      $call = [
        'id' => $p->callId, 'tagHash' => $h, 'owner' => $tag['owner'], 'callerKey' => $a['signer'], 'calleeKey' => $tag['calleeKey'],
        'keyA' => $p->callKey, 'keyB' => null, 'invite' => $invite, 'accept' => null, 'th' => null,
        'state' => 'RINGING', 'accepted' => false, 'createdAt' => $t, 'inviteExpiresAt' => CallProto::parseTime($p->expiresAt), 'deadline' => 0,
        'boxA' => $this->mailbox(), 'boxB' => $this->mailbox(), 'seqA' => 0, 'seqB' => 0, 'sentSdpA' => false, 'sentSdpB' => false,
        'candA' => 0, 'candB' => 0, 'confirmA' => false, 'confirmB' => false, 'iceIssued' => ['A' => 0, 'B' => 0], 'messages' => 0,
        'lastSeenA' => $t, 'lastSeenB' => $t, 'endedAt' => 0, 'endReason' => null,
      ];
      $this->saveCall($call);
      $index[$callName] = [$t, 0];
      $this->store->putCallIndex($index);
      $tag['used']++;
      $tag['ringing'] = $call['id'];
      $this->store->put('tags', $h, $tag);
      $this->push($mb, ['type' => 'invite', 'callId' => $call['id'], 'invite' => $invite], $call['inviteExpiresAt']);
      $this->saveListener($tag['owner'], $mb);
      return $this->ok(202, ['ok' => true]);
    });
  }

  // The poll and ice routes: authenticated by whichever call key the signer holds. Runs $then
  // with the call and the signer's role while the lock is held.
  private function callRoute($body, $type, $then) {
    $a = $this->authenticate($body, $type, ['modes' => 'B']);
    if (isset($a['error'])) return $a['error'];
    return $this->locked(function () use ($a, $then) {
      if ($r = $this->spend($a)) return $r;
      $call = $this->getCall($a['payload']->callId);
      if ($call === null) return $this->unavailable();
      $role = null;
      if ($a['signer'] === $call['keyA']) $role = 'A';
      elseif ($call['keyB'] && $a['signer'] === $call['keyB']) $role = 'B';
      if (!$role) return $this->unavailable();
      return $then($a, $call, $role);
    });
  }

  private function pollHint($call, $role) {
    if ($call['state'] === 'ENDED') return 0;
    if ($call['state'] === 'RINGING') return $this->poll['ringingMs'];
    if ($call['state'] === 'ACTIVE') return $this->poll['activeMs'];
    return $this->poll['setupMs'];
  }

  function routePoll($body, $ctx) {
    return $this->callRoute($body, 'atlas.call.poll', function ($a, $call, $role) {
      $box = 'box' . $role;
      $t = $this->now();
      $call['lastSeen' . $role] = $t;
      $after = (int)$a['payload']->after;
      $kept = [];
      foreach ($call[$box]['events'] as $e) if ($e['id'] > $after) $kept[] = $e;
      $call[$box]['events'] = $kept;
      $this->saveCall($call);
      $events = [];
      foreach (array_slice($kept, 0, 20) as $e) {
        $events[] = $e['type'] === 'signal' ? ['n' => $e['id'], 'type' => 'signal', 'message' => $this->decodeText($e['message'])] : ['n' => $e['id'], 'type' => $e['type'], 'reason' => isset($e['reason']) ? $e['reason'] : null];
      }
      $hint = $this->pollHint($call, $role);
      if ($events && $call['state'] !== 'ENDED') $hint = min($hint, 300);
      return $this->ok(200, ['events' => $events, 'serverTime' => $this->iso($t), 'nextPollMs' => $hint]);
    });
  }

  // TURN credentials follow coturn's REST scheme: the username carries the expiry time, the
  // credential is the base64 HMAC-SHA1 of the username under the secret shared with the TURN
  // server. The username holds no identity, call id or key. The lifetime never outlasts the
  // call's own maximum.
  private function mintTurnCredential($call) {
    $t = $this->now();
    $ttl = min(isset($this->cfg['turnTtlSeconds']) ? (int)$this->cfg['turnTtlSeconds'] : 3600, intdiv($call['createdAt'] + $this->T['maxCallMs'] - $t, 1000));
    if (!($ttl >= 30)) return null;
    $expires = intdiv($t, 1000) + $ttl;
    $username = $expires . ':' . CallProto::randomId(8);
    $credential = base64_encode(hash_hmac('sha1', $username, $this->cfg['turnSecret'], true));
    return ['username' => $username, 'credential' => $credential, 'ttl' => $ttl, 'expiresAt' => $this->iso($expires * 1000)];
  }

  function routeIce($body, $ctx) {
    return $this->callRoute($body, 'atlas.call.ice', function ($a, $call, $role) {
      if ($call['state'] === 'RINGING' || $call['state'] === 'ENDED') return $this->unavailable();
      $servers = [];
      if ($this->cfg['stunUrls']) $servers[] = ['urls' => $this->cfg['stunUrls']];
      $ttl = 600;
      $extra = [];
      if ($this->turnEnabled()) {
        if ($call['iceIssued'][$role] >= $this->L['maxTurnCredentialsPerRole']) return $this->fail(429, 'rate-limited', 'too many requests');
        $c = $this->mintTurnCredential($call);
        if ($c) {
          $call['iceIssued'][$role]++;
          $this->saveCall($call);
          $servers[] = ['urls' => $this->cfg['turnUrls'], 'username' => $c['username'], 'credential' => $c['credential']];
          $ttl = $c['ttl'];
          $extra['credentialExpiresAt'] = $c['expiresAt'];
        }
      }
      return $this->ok(200, array_merge(['iceServers' => $servers, 'ttl' => $ttl, 'serverTime' => $this->iso($this->now())], $extra));
    });
  }

  function routeSignal($body, $ctx) {
    $malformed = $this->fail(400, 'bad-request', 'malformed request');
    if (!($body instanceof stdClass)) return $malformed;
    foreach ($body as $k => $_) if (!in_array((string)$k, ['payload', 'proof', 'session'], true)) return $malformed;
    $proof = CallProto::get($body, 'proof');
    if (!CallProto::validateEnvelope($proof)) return $malformed;
    $p = CallProto::get($body, 'payload');
    $shape = CallProto::validatePayload($p);
    if (!$shape['ok'] || $p->type !== 'atlas.call.signal') return $malformed;
    if ($p->audience !== $this->cfg['origin']) return $this->fail(401, 'wrong-audience', 'this message is addressed to a different service');
    $source = $ctx['source'];
    $limited = $this->locked(function () use ($source) {
      if ($this->limited('sig-src:' . $source, $this->L['perSourcePerMin'])) return $this->fail(429, 'rate-limited', 'too many requests');
      return null;
    });
    if ($limited) return $limited;

    // Verify whatever signature the kind calls for, whether or not the call exists, so a
    // missing call and a forged message cost the same.
    $sigOk = false; $sessionOwner = null;
    if ($p->kind === 'decline' || $p->kind === 'busy') {
      $s = CallProto::get($body, 'session');
      $sp = $s instanceof stdClass ? CallProto::get($s, 'payload') : null;
      $sShape = $s instanceof stdClass ? CallProto::validatePayload($sp) : null;
      $t = $this->now();
      if ($sShape && $sShape['ok'] && $sp->type === 'atlas.call.listen-session' && CallProto::validateEnvelope(CallProto::get($s, 'proof')) && $proof->signerRole === 'raw-ecdsa' &&
          $proof->publicKey === $sp->sessionKey && $sp->audience === $this->cfg['origin'] &&
          CallProto::parseTime($sp->issuedAt) <= $t + CallProto::LIMITS['walletSkewMs'] && CallProto::parseTime($sp->expiresAt) >= $t) {
        $sigOk = CallProto::verifyEnvelope($sp, $s->proof) && CallProto::verifyEnvelope($p, $proof);
        if ($sigOk) $sessionOwner = $s->proof->publicKey;
      }
    } elseif (!CallProto::has($body, 'session')) {
      if ($p->kind === 'accept') $sigOk = CallProto::verifyEnvelope($p, $proof);
      else $sigOk = $proof->signerRole === 'raw-ecdsa' && CallProto::verifyEnvelope($p, $proof);
    }
    if (!$sigOk) return $this->unavailable();

    return $this->locked(function () use ($body, $p, $proof, $sessionOwner) {
      $call = $this->getCall($p->callId);
      if ($call === null || $call['state'] === 'ENDED') return $this->unavailable();
      $result = $this->applySignal($call, $body, $p, $proof, $sessionOwner);
      $this->saveCall($call);
      return $result;
    });
  }

  // The state machine for one verified signal. $call is changed in place and saved by the caller.
  private function applySignal(&$call, $body, $p, $proof, $sessionOwner) {
    if (++$call['messages'] > $this->L['maxSignalsPerCall']) { $this->endCall($call, 'error'); return $this->unavailable(); }
    $signer = $proof->publicKey;
    $t = $this->now();
    $messageText = json_encode(['payload' => $p, 'proof' => $proof], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION);
    $accepted = $this->ok(202, ['ok' => true]);

    // ----- identity-signed accept (callee) -----
    if ($p->kind === 'accept') {
      if ($call['state'] !== 'RINGING' || $t >= $call['inviteExpiresAt'] || $signer !== $call['calleeKey']) return $this->unavailable();
      $invite = $this->decodeText($call['invite']);
      if ($p->body->inviteHash !== CallProto::payloadHash($invite->payload)) return $this->unavailable();
      if ($p->body->callKey === $call['keyA']) return $this->unavailable();
      $call['keyB'] = $p->body->callKey;
      $call['accept'] = $messageText;
      $call['th'] = CallProto::transcriptHash($invite->payload, $p);
      $call['accepted'] = true;
      $call['state'] = 'ACCEPTED';
      $call['deadline'] = $t + $this->T['acceptToOfferMs'];
      $this->removeListenerEvents($call);
      $this->push($call['boxA'], ['type' => 'signal', 'message' => $messageText]);
      return $accepted;
    }

    // ----- session-signed decline / busy (callee, before accept) -----
    if ($p->kind === 'decline' || $p->kind === 'busy') {
      if ($call['state'] !== 'RINGING' || $sessionOwner !== $call['owner']) return $this->unavailable();
      $this->endCall($call, $p->kind === 'busy' ? 'busy' : 'declined', 'callee');
      return $accepted;
    }

    // ----- call-key-signed messages -----
    $role = $signer === $call['keyA'] ? 'A' : ($call['keyB'] && $signer === $call['keyB'] ? 'B' : null);
    if (!$role) return $this->unavailable();
    $seqName = 'seq' . $role;
    if (!CallProto::numIs($p->seq, $call[$seqName] + 1)) return $this->unavailable();
    $hasTh = CallProto::has($p, 'th');
    if ($hasTh && $call['th'] && $p->th !== $call['th']) return $this->unavailable();
    if ($hasTh && !$call['th']) return $this->unavailable();
    $otherBox = $role === 'A' ? 'boxB' : 'boxA';
    $st = $call['state'];
    $next = null;

    if ($p->kind === 'cancel' || ($p->kind === 'end' && $st === 'RINGING')) {
      if ($role !== 'A' || $st !== 'RINGING') return $this->unavailable();
      $call[$seqName]++;
      $call['state'] = 'ENDED'; $call['endedAt'] = $t; $call['endReason'] = 'cancelled';
      $this->indexEnded($call);
      $this->removeListenerEvents($call);
      $mb = $this->loadListener($call['owner']);
      if ($mb !== null) {
        $this->push($mb, ['type' => 'cancel', 'callId' => $call['id'], 'message' => $messageText], $t + $this->T['endedRetainMs']);
        $this->saveListener($call['owner'], $mb);
      }
      return $accepted;
    }
    if ($p->kind === 'end') {
      $call[$seqName]++;
      $call['state'] = 'ENDED'; $call['endedAt'] = $t; $call['endReason'] = 'hangup';
      $this->indexEnded($call);
      $this->push($call[$otherBox], ['type' => 'signal', 'message' => $messageText]);
      return $accepted;
    }
    if ($p->kind === 'offer') {
      if ($role !== 'A' || $st !== 'ACCEPTED') return $this->unavailable();
      $call['sentSdpA'] = true; $next = 'NEGOTIATING'; $call['deadline'] = $t + $this->T['offerToAnswerMs'];
    } elseif ($p->kind === 'answer') {
      if ($role !== 'B' || $st !== 'NEGOTIATING') return $this->unavailable();
      $call['sentSdpB'] = true; $next = 'ESTABLISHING'; $call['deadline'] = $t + $this->T['confirmMs'];
    } elseif ($p->kind === 'candidates') {
      if (!($st === 'NEGOTIATING' || $st === 'ESTABLISHING' || $st === 'ACTIVE')) return $this->unavailable();
      if (!($role === 'A' ? $call['sentSdpA'] : $call['sentSdpB'])) return $this->unavailable();
      $n = count($p->body->candidates) + ($role === 'A' ? $call['candA'] : $call['candB']);
      if ($n > CallProto::LIMITS['candidatesPerCall']) return $this->unavailable();
      if ($role === 'A') $call['candA'] = $n; else $call['candB'] = $n;
    } elseif ($p->kind === 'confirm') {
      if ($st !== 'ESTABLISHING') return $this->unavailable();
      if ($role === 'A') { if ($call['confirmA']) return $this->unavailable(); $call['confirmA'] = true; }
      else { if ($call['confirmB']) return $this->unavailable(); $call['confirmB'] = true; }
      if ($call['confirmA'] && $call['confirmB']) { $next = 'ACTIVE'; $call['deadline'] = 0; }
    } else {
      return $this->unavailable();
    }
    $call[$seqName]++;
    if ($next) $call['state'] = $next;
    $this->push($call[$otherBox], ['type' => 'signal', 'message' => $messageText]);
    return $accepted;
  }
}
