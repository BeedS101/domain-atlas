<?php
// The directory proper: reading a manifest, indexing its discoverable worlds, the crawl state of each
// submitted manifest, and search. Same behaviour as directory-server/server.js.
//
// A submission is never trusted for what it says about itself: a domain-anchored manifest must be
// served from /.well-known/spatial.json on the host it claims as its `domain`, and a key-anchored
// manifest must verify against its own identityKey.

function dir_anchor_of($w) { return $w['anchorType'] === 'domain' ? $w['domain'] : $w['identityKey']; }

function dir_is_assoc($v) { return is_array($v) && ($v === [] || array_keys($v) !== range(0, count($v) - 1)); }

function dir_validate_shape($m) {
  if (!is_array($m) || (count($m) && !dir_is_assoc($m))) return 'not a JSON object';
  if (!isset($m['spec']) || !is_string($m['spec']) || strpos($m['spec'], 'domain-atlas/') !== 0) return 'missing or unrecognized "spec"';
  if (!isset($m['worlds']) || !is_array($m['worlds']) || ($m['worlds'] && dir_is_assoc($m['worlds']))) return 'missing "worlds" array';
  $hasDomain = isset($m['domain']) && is_string($m['domain']) && $m['domain'] !== '';
  $hasKey = isset($m['identityKey']) && is_string($m['identityKey']) && $m['identityKey'] !== '';
  // SPEC.md §3.7: a domain-anchored manifest MAY also carry a pinned identityKey. Neither is invalid.
  if (!$hasDomain && !$hasKey) return 'manifest must have at least one of "domain" or "identityKey"';
  return null;
}

// SPEC.md §3.4.1: a world's own value wins outright, including an empty array or an explicit false.
function dir_effective_policy_field($manifest, $world, $field) {
  $policy = isset($world['policy']) && is_array($world['policy']) ? $world['policy'] : [];
  if (array_key_exists($field, $policy)) return $policy[$field];
  return array_key_exists($field, $manifest) ? $manifest[$field] : null;
}

function dir_strings($list, $count, $len) {
  if (!is_array($list)) return [];
  $out = [];
  foreach ($list as $v) {
    if (is_string($v)) $out[] = dir_str($v, $len);
    if (count($out) >= $count) break;
  }
  return $out;
}

function dir_index_world($manifest, $world, $anchorType, $anchorKey, $pinnedKey, $url) {
  $cfg = dir_config();
  $policy = isset($world['policy']) && is_array($world['policy']) ? $world['policy'] : [];
  $profile = isset($world['profile']) && is_array($world['profile']) ? $world['profile'] : [];
  $portals = [];
  $rawPortals = isset($world['portals']) && is_array($world['portals']) ? array_slice($world['portals'], 0, $cfg['maxPortalsPerWorld']) : [];
  foreach ($rawPortals as $p) {
    if (!is_array($p)) continue;
    $kind = dir_str(isset($p['kind']) ? $p['kind'] : null, 20);
    $to = null;
    if ($kind === 'domain' && isset($p['to']) && is_string($p['to'])) {
      $norm = dir_normalize_host($p['to']);
      $to = $norm !== '' ? $norm : dir_str($p['to'], 300);
    }
    $portals[] = ['kind' => $kind, 'to' => $to];
  }
  $caps = isset($profile['capabilities']) && is_array($profile['capabilities']) ? $profile['capabilities'] : null;
  $id = dir_str((string) $world['id'], 80);
  $trusted = null;
  if (isset($policy['trustedIssuers'])) {
    if ($policy['trustedIssuers'] === 'any' || $policy['trustedIssuers'] === 'self') $trusted = $policy['trustedIssuers'];
    elseif (is_array($policy['trustedIssuers'])) $trusted = dir_strings($policy['trustedIssuers'], 50, 253);
  }
  $owner = isset($manifest['owner']) && is_array($manifest['owner']) && isset($manifest['owner']['name']) ? dir_str($manifest['owner']['name'], 120) : null;
  $name = dir_str(isset($world['name']) ? $world['name'] : null, 120);
  return [
    'worldKey' => $anchorType . ':' . $anchorKey . ':' . $id,
    'anchorType' => $anchorType,
    'domain' => $anchorType === 'domain' ? $anchorKey : null,
    'identityKey' => $anchorType === 'key' ? $anchorKey : $pinnedKey,
    'worldId' => $id,
    'name' => ($name !== null && $name !== '') ? $name : $id,
    'description' => dir_str(isset($world['description']) ? $world['description'] : null, 300) ?: dir_str(isset($profile['description']) ? $profile['description'] : null, 300),
    'ownerName' => $owner,
    'genre' => dir_str(isset($profile['genre']) ? $profile['genre'] : null, 80),
    'scale' => dir_str(isset($profile['scale']) ? $profile['scale'] : null, 20),
    'capabilities' => $caps === null ? null : [
      'combat' => dir_str(isset($caps['combat']) ? $caps['combat'] : null, 10),
      'building' => dir_str(isset($caps['building']) ? $caps['building'] : null, 20),
      'vehicles' => isset($caps['vehicles']) && $caps['vehicles'] === true,
      'landOwnership' => isset($caps['landOwnership']) && $caps['landOwnership'] === true,
    ],
    'guestAccess' => dir_str(isset($policy['guestAccess']) ? $policy['guestAccess'] : null, 20),
    'identityRequired' => !empty(dir_effective_policy_field($manifest, $world, 'identityRequired')),
    'itemDropsAllowed' => !empty($policy['itemDropsAllowed']),
    'acceptedItemClasses' => dir_strings(dir_effective_policy_field($manifest, $world, 'acceptedItemClasses'), 50, 80),
    'trustedIssuers' => $trusted,
    'portalsRaw' => $portals,
    'manifestUrl' => $url,
    'indexedAt' => gmdate('c'),
  ];
}

// Fetches, validates and (re)indexes one manifest. Returns ['ok' => bool, 'worldsIndexed' => int, 'error' => string].
function dir_crawl_one($url) {
  $cfg = dir_config();
  try {
    $parsed = dir_check_url($url);
    $text = dir_fetch($parsed);
    $object = json_decode($text, false, 128);
    $manifest = json_decode($text, true, 128);
    if (json_last_error() !== JSON_ERROR_NONE) throw new DirectoryException('manifest is not valid JSON');
    $shapeError = dir_validate_shape($manifest);
    if ($shapeError) throw new DirectoryException($shapeError);

    $anchorType = (isset($manifest['domain']) && is_string($manifest['domain']) && $manifest['domain'] !== '') ? 'domain' : 'key';
    $anchorKey = $anchorType === 'domain' ? dir_normalize_host($manifest['domain']) : $manifest['identityKey'];

    if (in_array(strtolower((string) $anchorKey), $cfg['blocked'], true)) {
      dir_store_update(function (&$data) use ($url) { dir_drop_manifest($data, $url); });
      throw new DirectoryException('this directory does not list that site');
    }

    if ($anchorType === 'domain') {
      // The listing is for the host that served the manifest, never for a name the manifest merely claims.
      if (dir_normalize_host($parsed['host']) !== $anchorKey) throw new DirectoryException('the manifest names domain "' . dir_str($manifest['domain'], 100) . '" but was served from ' . $parsed['host']);
      if ($parsed['path'] !== DIRECTORY_WELL_KNOWN_PATH || $parsed['query'] !== '') throw new DirectoryException('a domain-anchored manifest is read from ' . DIRECTORY_WELL_KNOWN_PATH);
    } elseif (!dir_verify_key_anchored($object)) {
      throw new DirectoryException('key-anchored manifest signature does not verify against its own identityKey');
    }

    // SPEC.md §3.7: an optional identityKey pin on a domain-anchored manifest. A pin that does not
    // verify is ignored, never a reason to reject the manifest.
    $pinned = null;
    if ($anchorType === 'domain' && isset($manifest['identityKey']) && is_string($manifest['identityKey']) && $manifest['identityKey'] !== '') {
      try { if (dir_verify_key_anchored($object)) $pinned = $manifest['identityKey']; } catch (Throwable $e) { /* ignored */ }
    }

    $entries = [];
    foreach (array_slice($manifest['worlds'], 0, $cfg['maxWorldsPerManifest']) as $world) {
      if (!is_array($world) || !isset($world['id']) || !is_string($world['id']) || $world['id'] === '') continue;
      if (!isset($world['policy']) || !is_array($world['policy']) || !isset($world['policy']['discoverable']) || $world['policy']['discoverable'] !== true) continue;
      $entry = dir_index_world($manifest, $world, $anchorType, $anchorKey, $pinned, $url);
      $entries[$entry['worldKey']] = $entry;
    }

    $updated = dir_str(isset($manifest['updated']) ? $manifest['updated'] : null, 40);
    dir_store_update(function (&$data) use ($url, $anchorType, $anchorKey, $entries, $updated, $cfg) {
      // A world that was discoverable last crawl and is not now must not linger.
      foreach ($data['worlds'] as $key => $w) {
        if ($w['anchorType'] === $anchorType && dir_anchor_of($w) === $anchorKey) unset($data['worlds'][$key]);
      }
      foreach ($entries as $key => $entry) $data['worlds'][$key] = $entry;
      $record = isset($data['manifests'][$url]) ? $data['manifests'][$url] : ['url' => $url, 'submittedAt' => gmdate('c')];
      $data['manifests'][$url] = array_merge($record, [
        'url' => $url, 'anchorType' => $anchorType, 'anchorKey' => $anchorKey,
        'lastCrawledAt' => gmdate('c'), 'nextCrawlAt' => time() + $cfg['crawlIntervalSeconds'],
        'status' => 'ok', 'lastError' => null, 'consecutiveFailures' => 0, 'manifestUpdatedAt' => $updated,
      ]);
    });
    return ['ok' => true, 'worldsIndexed' => count($entries)];
  } catch (Throwable $e) {
    $message = $e instanceof DirectoryException ? $e->getMessage() : 'the manifest could not be processed';
    dir_record_failure($url, $message);
    return ['ok' => false, 'error' => $message];
  }
}

function dir_drop_manifest(&$data, $url) {
  unset($data['manifests'][$url]);
  foreach ($data['worlds'] as $key => $w) if ($w['manifestUrl'] === $url) unset($data['worlds'][$key]);
}

function dir_record_failure($url, $message) {
  $cfg = dir_config();
  dir_store_update(function (&$data) use ($url, $message, $cfg) {
    $record = isset($data['manifests'][$url]) ? $data['manifests'][$url] : null;
    $failures = ($record ? (int) ($record['consecutiveFailures'] ?? 0) : 0) + 1;
    $firstTime = !$record || empty($record['lastCrawledAt']) || ($record['status'] ?? '') === 'pending';
    // A submission that never worked leaves nothing behind, so junk URLs do not pile up.
    if ($firstTime || $failures >= $cfg['dropAfterFailures']) { dir_drop_manifest($data, $url); return; }
    $interval = $cfg['crawlIntervalSeconds'];
    $backoff = min($interval * (2 ** $failures), $interval * 10);
    $data['manifests'][$url] = array_merge($record, [
      'lastCrawledAt' => gmdate('c'), 'nextCrawlAt' => time() + $backoff,
      'status' => 'error', 'lastError' => dir_str($message, 200), 'consecutiveFailures' => $failures,
    ]);
  });
}

// Registers a submitted URL (or reports why not) and crawls it right away.
function dir_submit($url) {
  $cfg = dir_config();
  $accepted = dir_store_update(function (&$data) use ($url, $cfg) {
    if (isset($data['manifests'][$url])) return true;
    if (count($data['manifests']) >= $cfg['maxManifests']) return false;
    $data['manifests'][$url] = ['url' => $url, 'submittedAt' => gmdate('c'), 'nextCrawlAt' => time() + $cfg['crawlIntervalSeconds'], 'consecutiveFailures' => 0, 'status' => 'pending'];
    return true;
  });
  if (!$accepted) return ['full' => true];
  return dir_crawl_one($url);
}

// Crawls every manifest that is due. Used by cron.php.
function dir_crawl_due($maxToCrawl) {
  $data = dir_store_read();
  $due = [];
  foreach ($data['manifests'] as $url => $m) if (($m['nextCrawlAt'] ?? 0) <= time()) $due[] = $url;
  $report = ['due' => count($due), 'ok' => 0, 'failed' => 0];
  foreach (array_slice($due, 0, $maxToCrawl) as $url) {
    $r = dir_crawl_one($url);
    if ($r['ok']) $report['ok']++; else $report['failed']++;
  }
  return $report;
}

// ---------- search ----------

function dir_tokenize($s) {
  return array_values(array_filter(preg_split('/[^a-z0-9]+/', strtolower((string) $s))));
}

function dir_world_tokens($w) {
  return array_unique(array_merge(dir_tokenize($w['name']), dir_tokenize($w['genre'] ?? ''), dir_tokenize($w['domain'] ?? ''), dir_tokenize($w['worldId'])));
}

// Counted per distinct linking site; a site linking to itself adds nothing, so one operator cannot
// raise a rank by adding portals to its own worlds.
function dir_inbound_counts($worlds) {
  $sources = [];
  foreach ($worlds as $w) {
    $from = dir_anchor_of($w);
    foreach ($w['portalsRaw'] ?? [] as $p) {
      if (($p['kind'] ?? null) === 'domain' && !empty($p['to']) && $p['to'] !== $from) $sources[$p['to']][$from] = true;
    }
  }
  return array_map('count', $sources);
}

function dir_search($params) {
  $cfg = dir_config();
  $data = dir_store_read();
  $inbound = dir_inbound_counts($data['worlds']);
  $inboundFor = function ($w) use ($inbound) { return $inbound[dir_anchor_of($w)] ?? 0; };
  $q = isset($params['q']) ? trim((string) $params['q']) : '';
  $qTokens = $q !== '' ? dir_tokenize($q) : [];

  $scored = [];
  foreach ($data['worlds'] as $w) {
    if (!empty($params['genre']) && stripos((string) ($w['genre'] ?? ''), $params['genre']) === false) continue;
    if (!empty($params['scale']) && ($w['scale'] ?? null) !== $params['scale']) continue;
    if (!empty($params['combat']) && (!is_array($w['capabilities']) || ($w['capabilities']['combat'] ?? null) !== $params['combat'])) continue;
    if (!empty($params['domain']) && ($w['domain'] ?? null) !== dir_normalize_host($params['domain'])) continue;
    if (!empty($params['anchorType']) && $w['anchorType'] !== $params['anchorType']) continue;
    if (($params['identityRequired'] ?? null) === 'true' && empty($w['identityRequired'])) continue;
    if (($params['identityRequired'] ?? null) === 'false' && !empty($w['identityRequired'])) continue;
    $matched = null;
    if ($q !== '') {
      $tokens = array_flip(dir_world_tokens($w));
      $matched = 0;
      foreach ($qTokens as $t) if (isset($tokens[$t])) $matched++;
      if ($matched === 0) continue;
    }
    $scored[] = ['w' => $w, 'matched' => $matched];
  }
  usort($scored, function ($a, $b) use ($inboundFor) {
    if ($a['matched'] !== null && $a['matched'] !== $b['matched']) return $b['matched'] - $a['matched'];
    $ia = $inboundFor($a['w']); $ib = $inboundFor($b['w']);
    if ($ia !== $ib) return $ib - $ia;
    return strcasecmp($a['w']['name'], $b['w']['name']);
  });

  $limit = min(max((int) ($params['limit'] ?? 0) ?: $cfg['defaultLimit'], 1), $cfg['maxLimit']);
  $offset = max((int) ($params['offset'] ?? 0), 0);
  $results = [];
  foreach (array_slice($scored, $offset, $limit) as $row) {
    $w = $row['w'];
    $m = $data['manifests'][$w['manifestUrl']] ?? null;
    $results[] = [
      'anchorType' => $w['anchorType'], 'domain' => $w['domain'], 'identityKey' => $w['identityKey'],
      'worldId' => $w['worldId'], 'name' => $w['name'], 'description' => $w['description'] ?? null,
      'ownerName' => $w['ownerName'], 'genre' => $w['genre'], 'scale' => $w['scale'], 'capabilities' => $w['capabilities'],
      'guestAccess' => $w['guestAccess'], 'identityRequired' => $w['identityRequired'],
      'acceptedItemClasses' => $w['acceptedItemClasses'], 'manifestUrl' => $w['manifestUrl'],
      'inboundPortalCount' => $inboundFor($w),
      'stale' => $m !== null && (int) ($m['consecutiveFailures'] ?? 0) >= $cfg['staleAfterFailures'],
    ];
  }
  return ['count' => count($scored), 'limit' => $limit, 'offset' => $offset, 'results' => $results];
}
