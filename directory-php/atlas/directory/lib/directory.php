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

// ---------- advertised services ----------
// A domain says what it offers with top-level declarations in its manifest, next to `worlds`: `true`, or
// { "enabled": true, "url": "https://..." } for a service with a public page. A declaration only advertises: it does
// not show the service is running or trustworthy, and the directory never contacts a service URL.
// This list is the whole set the directory knows. To list a new module, add a line here and the same line to SERVICE_TYPES in
// directory-server/server.js (test/verify-directory-services.js compares the two). 'aliases' are other spellings accepted for
// the same service; a declaration under the main name wins.
function dir_service_categories() { return ['communication', 'assets', 'ledger', 'trading', 'directory', 'other']; }

function dir_service_types() {
  return [
    ['key' => 'postOffice', 'label' => 'Post Office', 'category' => 'communication', 'aliases' => []],
    ['key' => 'mailRelay', 'label' => 'Mail Relay', 'category' => 'communication', 'aliases' => []],
    ['key' => 'chat', 'label' => 'Site chat', 'category' => 'communication', 'aliases' => []],
    ['key' => 'inWorldChat', 'label' => 'In-world chat', 'category' => 'communication', 'aliases' => []],
    ['key' => 'voiceCalling', 'label' => 'Voice calling', 'category' => 'communication', 'aliases' => []],
    ['key' => 'assetStudio', 'label' => 'Asset Studio', 'category' => 'assets', 'aliases' => []],
    ['key' => 'chainLabs', 'label' => 'Chain Labs', 'category' => 'ledger', 'aliases' => ['chainlabs']],
    ['key' => 'scanner', 'label' => 'Scanner', 'category' => 'ledger', 'aliases' => []],
    ['key' => 'tradingStation', 'label' => 'Trading station', 'category' => 'trading', 'aliases' => ['trading']],
    ['key' => 'directory', 'label' => 'Directory', 'category' => 'directory', 'aliases' => []],
    ['key' => 'calendar', 'label' => 'Calendar', 'category' => 'other', 'aliases' => []],
  ];
}

// The registry by service key, with each entry's position (the order services are listed in).
function dir_service_by_key() {
  static $byKey = null;
  if ($byKey !== null) return $byKey;
  $byKey = [];
  foreach (dir_service_types() as $i => $t) { $t['order'] = $i; $byKey[$t['key']] = $t; }
  return $byKey;
}

// The one address shape a service may link to: https, a real host name (no address, no login details, no fragment) on the
// manifest's own domain or a subdomain of it, and only URL-safe characters. Anything else is dropped, and the service is
// listed without a link. A key-anchored manifest has no verified host, so its services never get one.
function dir_safe_service_url($value, $anchorType, $anchorKey) {
  if ($anchorType !== 'domain' || !is_string($value) || strlen($value) > 300) return null;
  $re = '#^https://((?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z][a-zA-Z0-9-]{0,61}[a-zA-Z0-9])(?::([0-9]{1,5}))?(/[A-Za-z0-9._~!$&\'()*+,;=:@%/-]*)?(\?[A-Za-z0-9._~!$&\'()*+,;=:@%/?-]*)?$#D';
  if (!preg_match($re, $value, $m)) return null;
  $host = strtolower($m[1]);
  if (strlen($host) > 253) return null;
  $port = isset($m[2]) && $m[2] !== '' ? (int) $m[2] : null;
  if ($port !== null && ($port < 1 || $port > 65535)) return null;
  $domainHost = preg_replace('/:\d+$/', '', (string) $anchorKey);
  $suffix = '.' . $domainHost;
  if ($host !== $domainHost && substr($host, -strlen($suffix)) !== $suffix) return null;
  return 'https://' . $host . ($port !== null ? ':' . $port : '') . (isset($m[3]) && $m[3] !== '' ? $m[3] : '/') . (isset($m[4]) ? $m[4] : '');
}

// The services a manifest advertises, in registry order: [['service' => key, 'url' => string|null], ...].
function dir_read_services($manifest, $anchorType, $anchorKey) {
  $found = [];
  foreach (dir_service_types() as $type) {
    $name = null;
    foreach (array_merge([$type['key']], $type['aliases']) as $candidate) {
      if (array_key_exists($candidate, $manifest)) { $name = $candidate; break; }
    }
    if ($name === null) continue;
    $declared = $manifest[$name];
    if ($declared === true) $found[] = ['service' => $type['key'], 'url' => null];
    elseif (is_array($declared) && dir_is_assoc($declared) && isset($declared['enabled']) && $declared['enabled'] === true) {
      $found[] = ['service' => $type['key'], 'url' => dir_safe_service_url(isset($declared['url']) ? $declared['url'] : null, $anchorType, $anchorKey)];
    }
  }
  return $found;
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
      dir_drop_manifest($url);
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
    $services = dir_read_services($manifest, $anchorType, $anchorKey);
    $serviceOwner = isset($manifest['owner']) && is_array($manifest['owner']) && isset($manifest['owner']['name']) ? dir_str($manifest['owner']['name'], 120) : null;
    dir_tx(function ($db) use ($url, $anchorType, $anchorKey, $entries, $updated, $cfg, $services, $serviceOwner, $pinned) {
      $now = time();
      // Update, or insert when the row is not there (an UPDATE then INSERT keeps this working on older SQLite versions).
      $update = $db->prepare('UPDATE manifests SET anchor_type = ?, anchor_key = ?, status = \'ok\', last_crawled_at = ?, last_success_at = ?, next_crawl_at = ?, consecutive_failures = 0, last_error = NULL, manifest_updated = ? WHERE url = ?');
      $update->execute([$anchorType, $anchorKey, $now, $now, $now + $cfg['crawlIntervalSeconds'], $updated, $url]);
      if ($update->rowCount() === 0) {
        $db->prepare('INSERT INTO manifests(url, anchor_type, anchor_key, status, submitted_at, last_crawled_at, last_success_at, next_crawl_at, consecutive_failures, last_error, manifest_updated) VALUES(?, ?, ?, \'ok\', ?, ?, ?, ?, 0, NULL, ?)')
          ->execute([$url, $anchorType, $anchorKey, $now, $now, $now, $now + $cfg['crawlIntervalSeconds'], $updated]);
      }
      // A world that was discoverable last crawl and is not now must not linger.
      $db->prepare('DELETE FROM worlds WHERE anchor_type = ? AND anchor_key = ?')->execute([$anchorType, $anchorKey]);
      $insert = $db->prepare('INSERT OR REPLACE INTO worlds(world_key, manifest_url, anchor_type, anchor_key, domain, identity_key, world_id, name, description, owner_name, genre, scale,
          guest_access, identity_required, item_drops_allowed, capabilities, accepted_item_classes, trusted_issuers, portals, indexed_at)
          VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      foreach ($entries as $e) {
        $insert->execute([
          $e['worldKey'], $url, $e['anchorType'], $anchorKey, $e['domain'], $e['identityKey'], $e['worldId'], $e['name'], $e['description'], $e['ownerName'], $e['genre'], $e['scale'],
          $e['guestAccess'], $e['identityRequired'] ? 1 : 0, $e['itemDropsAllowed'] ? 1 : 0, dir_json($e['capabilities']), dir_json($e['acceptedItemClasses']), dir_json($e['trustedIssuers']), dir_json($e['portalsRaw']), $now,
        ]);
      }
      // The same for services: what the manifest no longer advertises goes, and what it advertises now is indexed.
      $db->prepare('DELETE FROM services WHERE anchor_type = ? AND anchor_key = ?')->execute([$anchorType, $anchorKey]);
      $addService = $db->prepare('INSERT OR REPLACE INTO services(service_key, manifest_url, anchor_type, anchor_key, domain, identity_key, owner_name, service, url, indexed_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      foreach ($services as $sv) {
        $addService->execute([$anchorType . ':' . $anchorKey . ':' . $sv['service'], $url, $anchorType, $anchorKey, $anchorType === 'domain' ? $anchorKey : null,
          $anchorType === 'key' ? $anchorKey : $pinned, $serviceOwner, $sv['service'], $sv['url'], $now]);
      }
    });
    return ['ok' => true, 'worldsIndexed' => count($entries), 'servicesIndexed' => count($services)];
  } catch (Throwable $e) {
    $message = $e instanceof DirectoryException ? $e->getMessage() : 'the manifest could not be processed';
    dir_record_failure($url, $message);
    return ['ok' => false, 'error' => $message];
  }
}

// Removes a manifest; its worlds go with it (ON DELETE CASCADE).
function dir_drop_manifest($url) {
  dir_tx(function ($db) use ($url) { $db->prepare('DELETE FROM manifests WHERE url = ?')->execute([$url]); });
}

function dir_json($value) {
  return $value === null ? null : json_encode($value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
}

function dir_record_failure($url, $message) {
  $cfg = dir_config();
  dir_tx(function ($db) use ($url, $message, $cfg) {
    $get = $db->prepare('SELECT consecutive_failures, last_crawled_at, status FROM manifests WHERE url = ?');
    $get->execute([$url]);
    $row = $get->fetch();
    $failures = ($row ? (int) $row['consecutive_failures'] : 0) + 1;
    $firstTime = !$row || $row['last_crawled_at'] === null || $row['status'] === 'pending';
    // A submission that never worked leaves nothing behind, so junk URLs do not pile up.
    if ($firstTime || $failures >= $cfg['dropAfterFailures']) {
      $db->prepare('DELETE FROM manifests WHERE url = ?')->execute([$url]);
      return;
    }
    $interval = $cfg['crawlIntervalSeconds'];
    $backoff = min($interval * (2 ** $failures), $interval * 10);
    $now = time();
    $db->prepare('UPDATE manifests SET last_crawled_at = ?, next_crawl_at = ?, status = \'error\', last_error = ?, consecutive_failures = ? WHERE url = ?')
      ->execute([$now, $now + $backoff, dir_str($message, 200), $failures, $url]);
  });
}

// Adds a submitted URL to the tracked manifests, unless it is there already (true) or the directory is full (false).
// The count and the insert happen in one transaction, so many requests at once cannot overshoot the limit.
function dir_register_manifest($url) {
  $cfg = dir_config();
  return dir_tx(function ($db) use ($url, $cfg) {
    $have = $db->prepare('SELECT 1 FROM manifests WHERE url = ?');
    $have->execute([$url]);
    if ($have->fetchColumn()) return true;
    if ((int) $db->query('SELECT COUNT(*) FROM manifests')->fetchColumn() >= $cfg['maxManifests']) return false;
    $now = time();
    $db->prepare('INSERT INTO manifests(url, status, submitted_at, next_crawl_at, consecutive_failures) VALUES(?, \'pending\', ?, ?, 0)')
      ->execute([$url, $now, $now + $cfg['crawlIntervalSeconds']]);
    return true;
  });
}

// Registers a submitted URL (or reports why not) and crawls it right away.
function dir_submit($url) {
  if (!dir_register_manifest($url)) return ['full' => true];
  return dir_crawl_one($url);
}

// Crawls every manifest that is due. Used by cron.php.
function dir_crawl_due($maxToCrawl) {
  $db = dir_db();
  $now = time();
  $count = $db->prepare('SELECT COUNT(*) FROM manifests WHERE next_crawl_at <= ?');
  $count->execute([$now]);
  $list = $db->prepare('SELECT url FROM manifests WHERE next_crawl_at <= ? ORDER BY next_crawl_at, url LIMIT ?');
  $list->bindValue(1, $now, PDO::PARAM_INT);
  $list->bindValue(2, (int) $maxToCrawl, PDO::PARAM_INT);
  $list->execute();
  $report = ['due' => (int) $count->fetchColumn(), 'ok' => 0, 'failed' => 0];
  foreach ($list->fetchAll(PDO::FETCH_COLUMN) as $url) {
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

// A stored world as the rest of the code sees it.
function dir_world_from_row($r) {
  $json = function ($v) { return $v === null ? null : json_decode($v, true); };
  return [
    'worldKey' => $r['world_key'], 'anchorType' => $r['anchor_type'], 'domain' => $r['domain'], 'identityKey' => $r['identity_key'],
    'worldId' => $r['world_id'], 'name' => $r['name'], 'description' => $r['description'], 'ownerName' => $r['owner_name'],
    'genre' => $r['genre'], 'scale' => $r['scale'], 'capabilities' => $json($r['capabilities']), 'guestAccess' => $r['guest_access'],
    'identityRequired' => (int) $r['identity_required'] === 1, 'itemDropsAllowed' => (int) $r['item_drops_allowed'] === 1,
    'acceptedItemClasses' => $json($r['accepted_item_classes']) ?: [], 'trustedIssuers' => $json($r['trusted_issuers']),
    'portalsRaw' => $json($r['portals']) ?: [], 'manifestUrl' => $r['manifest_url'],
  ];
}

function dir_search($params) {
  $cfg = dir_config();
  $db = dir_db();
  // Ranking counts every indexed site's links, so it reads the portals of all worlds, but nothing else of them.
  $links = [];
  foreach ($db->query("SELECT anchor_type, domain, identity_key, portals FROM worlds WHERE portals <> '[]'") as $r) {
    $links[] = ['anchorType' => $r['anchor_type'], 'domain' => $r['domain'], 'identityKey' => $r['identity_key'], 'portalsRaw' => json_decode($r['portals'], true) ?: []];
  }
  $inbound = dir_inbound_counts($links);
  $inboundFor = function ($w) use ($inbound) { return $inbound[dir_anchor_of($w)] ?? 0; };
  $q = isset($params['q']) ? trim((string) $params['q']) : '';
  $qTokens = $q !== '' ? dir_tokenize($q) : [];

  // The exact-match filters are done by the database; the rest (substring and word matching) below.
  $where = [];
  $bind = [];
  if (!empty($params['scale'])) { $where[] = 'scale = ?'; $bind[] = $params['scale']; }
  if (!empty($params['domain'])) { $where[] = 'domain = ?'; $bind[] = dir_normalize_host($params['domain']); }
  if (!empty($params['anchorType'])) { $where[] = 'anchor_type = ?'; $bind[] = $params['anchorType']; }
  if (($params['identityRequired'] ?? null) === 'true') $where[] = 'identity_required = 1';
  if (($params['identityRequired'] ?? null) === 'false') $where[] = 'identity_required = 0';
  // groupBy=site&category=<a kind of service> lists sites by what they advertise, so no world is considered at all.
  $bySite = ($params['groupBy'] ?? null) === 'site';
  $category = $bySite && isset($params['category']) && in_array($params['category'], array_merge(['all', 'worlds'], dir_service_categories()), true) ? $params['category'] : 'all';
  $select = $db->prepare('SELECT * FROM worlds' . ($where ? ' WHERE ' . implode(' AND ', $where) : ''));
  $select->execute($bind);

  $scored = [];
  foreach (($bySite && $category !== 'all' && $category !== 'worlds') ? [] : $select->fetchAll() as $row) {
    $w = dir_world_from_row($row);
    if (!empty($params['genre']) && stripos((string) ($w['genre'] ?? ''), $params['genre']) === false) continue;
    if (!empty($params['combat']) && (!is_array($w['capabilities']) || ($w['capabilities']['combat'] ?? null) !== $params['combat'])) continue;
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
    $byName = strcasecmp($a['w']['name'], $b['w']['name']);
    // A last tie-break keeps the order total: PHP before 8.0 does not keep equal items in their order.
    return $byName !== 0 ? $byName : strcmp($a['w']['worldKey'], $b['w']['worldKey']);
  });

  $limit = min(max((int) ($params['limit'] ?? 0) ?: $cfg['defaultLimit'], 1), $cfg['maxLimit']);
  $offset = max((int) ($params['offset'] ?? 0), 0);
  if ($bySite) return dir_search_by_site($db, $params, $category, $scored, $inboundFor, $limit, $offset);
  $page = array_slice($scored, $offset, $limit);
  $failures = dir_manifest_failures($db, $page);
  $results = [];
  foreach ($page as $row) $results[] = dir_world_result($row['w'], $inboundFor, $failures);
  return ['count' => count($scored), 'limit' => $limit, 'offset' => $offset, 'results' => $results];
}

// The consecutive-failure count of every manifest the given worlds came from, to mark stale listings.
function dir_manifest_failures($db, $rows) {
  $failures = [];
  if (!$rows) return $failures;
  $urls = array_values(array_unique(array_map(function ($row) { return $row['w']['manifestUrl']; }, $rows)));
  $get = $db->prepare('SELECT url, consecutive_failures FROM manifests WHERE url IN (' . implode(',', array_fill(0, count($urls), '?')) . ')');
  $get->execute($urls);
  foreach ($get->fetchAll() as $m) $failures[$m['url']] = (int) $m['consecutive_failures'];
  return $failures;
}

function dir_world_result($w, $inboundFor, $failures) {
  return [
    'anchorType' => $w['anchorType'], 'domain' => $w['domain'], 'identityKey' => $w['identityKey'],
    'worldId' => $w['worldId'], 'name' => $w['name'], 'description' => $w['description'] ?? null,
    'ownerName' => $w['ownerName'], 'genre' => $w['genre'], 'scale' => $w['scale'], 'capabilities' => $w['capabilities'],
    'guestAccess' => $w['guestAccess'], 'identityRequired' => $w['identityRequired'],
    'acceptedItemClasses' => $w['acceptedItemClasses'], 'portals' => $w['portalsRaw'], 'manifestUrl' => $w['manifestUrl'],
    'inboundPortalCount' => $inboundFor($w),
    'stale' => ($failures[$w['manifestUrl']] ?? 0) >= dir_config()['staleAfterFailures'],
  ];
}

// The advertised services that match a groupBy=site search. category=worlds has none. A world-only filter (genre, scale,
// combat, identityRequired) says nothing about services, so with category=all it leaves them out, and with a service
// category it is ignored. domain, anchorType and q apply to services as they do to worlds (q: the site's domain, the
// service's name or its category).
function dir_matching_services($db, $params, $category) {
  if ($category === 'worlds') return [];
  $worldOnly = !empty($params['genre']) || !empty($params['scale']) || !empty($params['combat']) || in_array($params['identityRequired'] ?? null, ['true', 'false'], true);
  if ($category === 'all' && $worldOnly) return [];
  $q = isset($params['q']) ? trim((string) $params['q']) : '';
  $qTokens = $q !== '' ? dir_tokenize($q) : null;
  $types = dir_service_by_key();
  $where = [];
  $bind = [];
  if (!empty($params['domain'])) { $where[] = 'domain = ?'; $bind[] = dir_normalize_host($params['domain']); }
  if (!empty($params['anchorType'])) { $where[] = 'anchor_type = ?'; $bind[] = $params['anchorType']; }
  $select = $db->prepare('SELECT * FROM services' . ($where ? ' WHERE ' . implode(' AND ', $where) : ''));
  $select->execute($bind);
  $out = [];
  foreach ($select->fetchAll() as $r) {
    if (!isset($types[$r['service']])) continue;
    $type = $types[$r['service']];
    if ($category !== 'all' && $type['category'] !== $category) continue;
    $matched = 0;
    if ($qTokens !== null) {
      $have = array_flip(array_merge(dir_tokenize($r['domain'] ?? ''), dir_tokenize($type['label']), dir_tokenize($type['key']), dir_tokenize($type['category'])));
      foreach ($qTokens as $t) if (isset($have[$t])) $matched++;
      if ($matched === 0) continue;
    }
    $out[] = [
      'sv' => ['anchorType' => $r['anchor_type'], 'domain' => $r['domain'], 'identityKey' => $r['identity_key'], 'ownerName' => $r['owner_name'], 'manifestUrl' => $r['manifest_url'], 'service' => $r['service'], 'url' => $r['url']],
      'type' => $type, 'matched' => $matched,
    ];
  }
  return $out;
}

// The newest last-success time and the consecutive-failure counts of the manifests a group's worlds and services came from.
function dir_manifest_state($db, $urls) {
  $state = [];
  $urls = array_values(array_unique($urls));
  if (!$urls) return $state;
  $get = $db->prepare('SELECT url, consecutive_failures, last_success_at FROM manifests WHERE url IN (' . implode(',', array_fill(0, count($urls), '?')) . ')');
  $get->execute($urls);
  foreach ($get->fetchAll() as $m) $state[$m['url']] = ['failures' => (int) $m['consecutive_failures'], 'seen' => $m['last_success_at'] === null ? null : (int) $m['last_success_at']];
  return $state;
}

// groupBy=site: the same matches, grouped under the site that published them (its domain, or for a key-anchored manifest its
// verified identity key). A site appears when it has a matching world or a matching advertised service. Groups are paged, not
// worlds, and worldCount and serviceCount are the numbers of matches in all groups, so the counts stay right however many pages
// there are.
function dir_search_by_site($db, $params, $category, $scored, $inboundFor, $limit, $offset) {
  $groups = [];
  $touch = function ($item, $matched) use (&$groups) {
    $anchor = dir_anchor_of($item);
    if (!isset($groups[$anchor])) {
      $groups[$anchor] = ['anchorType' => $item['anchorType'], 'domain' => $item['domain'], 'identityKey' => $item['identityKey'], 'ownerName' => $item['ownerName'], 'anchor' => $anchor, 'ref' => $item, 'matched' => 0, 'worlds' => [], 'services' => []];
    }
    if (empty($groups[$anchor]['identityKey']) && !empty($item['identityKey'])) $groups[$anchor]['identityKey'] = $item['identityKey'];
    if (empty($groups[$anchor]['ownerName']) && !empty($item['ownerName'])) $groups[$anchor]['ownerName'] = $item['ownerName'];
    $groups[$anchor]['matched'] = max($groups[$anchor]['matched'], (int) $matched);
    return $anchor;
  };
  foreach ($scored as $row) { $a = $touch($row['w'], $row['matched']); $groups[$a]['worlds'][] = $row; }
  $serviceMatches = dir_matching_services($db, $params, $category);
  foreach ($serviceMatches as $row) { $a = $touch($row['sv'], $row['matched']); $groups[$a]['services'][] = $row; }
  $ordered = array_values($groups);
  usort($ordered, function ($a, $b) use ($inboundFor) {
    if ($a['matched'] !== $b['matched']) return $b['matched'] - $a['matched'];
    $ia = $inboundFor($a['ref']); $ib = $inboundFor($b['ref']);
    if ($ia !== $ib) return $ib - $ia;
    $byName = strcasecmp($a['anchor'], $b['anchor']);
    return $byName !== 0 ? $byName : strcmp($a['anchor'], $b['anchor']);
  });
  $page = array_slice($ordered, $offset, $limit);
  $rows = [];
  $urls = [];
  foreach ($page as $g) {
    foreach ($g['worlds'] as $row) { $rows[] = $row; $urls[] = $row['w']['manifestUrl']; }
    foreach ($g['services'] as $row) $urls[] = $row['sv']['manifestUrl'];
  }
  $failures = dir_manifest_failures($db, $rows);
  $state = dir_manifest_state($db, $urls);
  $out = [];
  foreach ($page as $g) {
    $results = [];
    $genres = [];
    $scales = [];
    foreach ($g['worlds'] as $row) {
      $results[] = dir_world_result($row['w'], $inboundFor, $failures);
      if (!empty($row['w']['genre'])) $genres[$row['w']['genre']] = true;
      if (!empty($row['w']['scale'])) $scales[$row['w']['scale']] = true;
    }
    usort($g['services'], function ($a, $b) { return $a['type']['order'] - $b['type']['order']; });
    $listed = [];
    foreach ($g['services'] as $row) $listed[] = ['key' => $row['type']['key'], 'label' => $row['type']['label'], 'category' => $row['type']['category'], 'url' => $row['sv']['url']];
    // The newest successful check among the manifests this site's worlds and services came from (UTC, to the second).
    $stale = false;
    foreach ($results as $r) if ($r['stale']) $stale = true;
    $seen = 0;
    $manifestUrls = [];
    foreach ($g['worlds'] as $row) $manifestUrls[] = $row['w']['manifestUrl'];
    foreach ($g['services'] as $row) $manifestUrls[] = $row['sv']['manifestUrl'];
    foreach (array_unique($manifestUrls) as $u) {
      if (!isset($state[$u])) continue;
      if ($state[$u]['seen'] !== null && $state[$u]['seen'] > $seen) $seen = $state[$u]['seen'];
      if ($state[$u]['failures'] >= dir_config()['staleAfterFailures']) $stale = true;
    }
    $out[] = [
      'anchorType' => $g['anchorType'], 'domain' => $g['domain'], 'identityKey' => $g['identityKey'], 'ownerName' => $g['ownerName'],
      'worldCount' => count($g['worlds']), 'serviceCount' => count($g['services']),
      'genres' => array_slice(array_map('strval', array_keys($genres)), 0, 5), 'scales' => array_map('strval', array_keys($scales)),
      'inboundPortalCount' => $inboundFor($g['ref']), 'stale' => $stale,
      'lastSeenAt' => $seen ? gmdate('Y-m-d\TH:i:s\Z', $seen) : null, 'worlds' => $results, 'services' => $listed,
    ];
  }
  return ['count' => count($ordered), 'worldCount' => count($scored), 'serviceCount' => count($serviceMatches), 'limit' => $limit, 'offset' => $offset, 'groups' => $out];
}
