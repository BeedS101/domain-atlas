<?php
// Read-only reports of which features are switched on, off or misconfigured on this domain.
//
// Shared by the site doctor (tools/site-doctor-build.js splices this file into the single-file doctor) and the
// admin panel's Site status route (atlas/admin/site-status.php). The list of features and their how-to text lives
// in lib/site-features.json; each entry's `type` selects one of the readers below.
//
// Nothing here executes or includes a config file: JSON is parsed, PHP config files are matched with patterns,
// and only allow-listed values (hosts, ports, domains, counts, "login set") ever reach the output. Passwords,
// tokens, keys, mail user names and addresses are never put in the output. PHP 7.2 compatible.
//
// Writers live in lib/site-pause.php, which only the issuer loads: the doctor must stay read-only.

// The configured Studio private folder without running storage-root.php: env var first, then the file's
// `return "...";` line.
function atlas_sf_studio_root($root) {
  $env = getenv('ATLAS_STUDIO_STORAGE_ROOT');
  if (is_string($env) && $env !== '') return ['env', $env];
  $file = $root . '/atlas/studio/inc/storage-root.php';
  if (!is_file($file) || is_link($file)) return [null, null];
  $src = @file_get_contents($file, false, null, 0, 4096);
  if ($src !== false && preg_match('/(?:^|<\?php)\s*return\s+(["\'])(.*?)\1\s*;/m', $src, $m) && $m[2] !== '' && strpos($m[2], 'CPANELUSER') === false) return ['file', $m[2]];
  return ['file-unreadable', null];
}


// ---- feature switches (read-only) ------------------------------------------------------------------------
//
// Each feature in the embedded registry is switched by a setting in a file or by renaming a file. A reader
// per feature type reports on / off / problem / absent, plus a short list of facts. Only the fields a reader
// names are ever put in the output; passwords, tokens, keys and every other value stay unread by the output.
// Nothing is executed: PHP config files are matched with patterns, never included.

function atlas_sf_clip($v, $n = 120) {
  $v = preg_replace('/[\x00-\x1f\x7f]+/', ' ', (string)$v);
  return strlen($v) > $n ? substr($v, 0, $n - 3) . '...' : $v;
}

// Small regular file: its contents, null when absent, false when unreadable or too large. Never follows symlinks.
function atlas_sf_small_file($path, $max) {
  if (is_link($path) || !is_file($path)) return null;
  $c = @file_get_contents($path, false, null, 0, $max + 1);
  return ($c === false || strlen($c) > $max) ? false : $c;
}

function atlas_sf_json_doc($path, $max = 65536) {
  $c = atlas_sf_small_file($path, $max);
  if ($c === null) return ['missing', null];
  if ($c === false) return ['unreadable', null];
  $d = json_decode($c, true);
  return is_array($d) ? ['ok', $d] : ['invalid', null];
}

function atlas_sf_origin_ok($s) {
  return is_string($s) && strlen($s) <= 255 && preg_match('#^https?://(\[[0-9a-f:]+\]|[a-z0-9]([a-z0-9.-]*[a-z0-9])?)(:\d{1,5})?$#', $s) === 1;
}

function atlas_sf_is_list($a) { return is_array($a) && ($a === [] || array_keys($a) === range(0, count($a) - 1)); }

function atlas_sf_inside($path, $root) {
  $p = realpath($path); $r = realpath($root);
  if ($p === false || $r === false) return false;
  $p = rtrim(str_replace('\\', '/', $p), '/') . '/'; $r = rtrim(str_replace('\\', '/', $r), '/') . '/';
  return strpos($p, $r) === 0 || strpos($r, $p) === 0;
}

// The path in a `return "...";` pointer file, without running it.
function atlas_sf_pointer_path($file) {
  $src = atlas_sf_small_file($file, 4096);
  if (!is_string($src) || !preg_match('/(?:^|<\?php)\s*return\s+(["\'])(.*?)\1\s*;/m', $src, $m) || $m[2] === '' || strpos($m[2], 'CPANELUSER') !== false) return null;
  return $m[2];
}

function atlas_sf_feature_studio_config($root, $f, $host) {
  list($how, $dir) = atlas_sf_studio_root($root);
  if ($dir === null) return ['off', ['Studio storage is not configured, so minting stays off'], []];
  $rr = is_dir($dir) ? realpath($dir) : false;
  if ($rr === false) return ['problem', ['the Studio storage folder does not exist'], []];
  list($st, $c) = atlas_sf_json_doc($rr . '/studio-config.json', 8192);
  if ($st === 'missing') return ['off', ['no studio-config.json in the storage folder'], []];
  if ($st !== 'ok') return ['problem', ['studio-config.json is not valid JSON, so minting stays off'], []];
  if (!isset($c['mintEnabled']) || $c['mintEnabled'] !== true) return ['off', ['"mintEnabled" is not true'], []];
  $facts = []; $problems = [];
  $domain = isset($c['domain']) && is_string($c['domain']) ? $c['domain'] : null;
  if ($domain !== null) $facts[] = 'domain: ' . atlas_sf_clip($domain, 80);
  if ($domain !== $host) $problems[] = 'domain-mismatch: studio-config.json says "' . atlas_sf_clip($domain === null ? '(none)' : $domain, 80) . '" but this host is "' . atlas_sf_clip($host, 80) . '"; minting stays off';
  $origins = isset($c['origins']) && is_array($c['origins']) ? $c['origins'] : ['https://' . (string)$domain];
  $shown = [];
  foreach (array_slice($origins, 0, 4) as $o) if (is_string($o)) $shown[] = atlas_sf_clip($o, 80);
  $facts[] = 'origins: ' . implode(', ', $shown);
  if (!in_array('https://' . $host, $origins, true) && !in_array('http://' . $host, $origins, true)) $problems[] = 'bad-origins: "origins" does not include https://' . atlas_sf_clip($host, 80);
  if (!is_writable($rr)) $problems[] = 'the storage folder is not writable';
  return [$problems ? 'problem' : 'on', $problems, $facts];
}

function atlas_sf_feature_json_enabled($root, $f, $host) {
  list($st, $d) = atlas_sf_json_doc($root . '/' . $f['file']);
  if ($st === 'missing') return ['off', ['no ' . $f['file'] . ' (off by default)'], []];
  if ($st !== 'ok') return ['problem', [$f['file'] . ($st === 'invalid' ? ' is not valid JSON, so the feature stays off' : ' could not be read')], []];
  if (!isset($d['enabled']) || $d['enabled'] !== true) return ['off', ['"enabled" is not true'], []];
  $facts = []; $problems = [];
  foreach ($f['show'] as $k) if (isset($d[$k]) && (is_string($d[$k]) || is_int($d[$k]))) $facts[] = $k . ': ' . atlas_sf_clip($d[$k], 80);
  $hk = isset($f['hostKey']) ? $f['hostKey'] : null;
  if ($hk !== null) {
    if (!isset($d[$hk]) || !is_string($d[$hk])) $problems[] = '"' . $hk . '" is missing';
    elseif ($host !== '' && $d[$hk] !== $host) $problems[] = '"' . $hk . '" is not this host (' . atlas_sf_clip($host, 80) . '), so the route refuses requests';
  }
  return [$problems ? 'problem' : 'on', $problems, $facts];
}

function atlas_sf_feature_email_tickets($root, $f, $host) {
  list($st, $d) = atlas_sf_json_doc($root . '/' . $f['file']);
  $intake = false;
  list($ms, $m) = atlas_sf_json_doc($root . '/.well-known/spatial.json', 1048576);
  if ($ms === 'ok' && isset($m['emailTickets']['intakeAddress']) && $m['emailTickets']['intakeAddress'] !== '') $intake = true;
  if ($st === 'missing') return ['off', ['no ' . $f['file'] . ' (email delivery is off)'], ['manifest intakeAddress: ' . ($intake ? 'set' : 'not set')]];
  if ($st !== 'ok') return ['problem', [$f['file'] . ($st === 'invalid' ? ' is not valid JSON, so email delivery is off' : ' could not be read')], []];
  $has = function ($k) use ($d) { return isset($d[$k]) && is_string($d[$k]) && $d[$k] !== ''; };
  $port = function ($k, $def) use ($d) { return isset($d[$k]) && is_int($d[$k]) ? $d[$k] : $def; };
  $smtp = $has('smtpHost'); $from = $has('fromAddress'); $imap = $has('imapHost');
  $facts = [];
  if ($smtp) $facts[] = 'outgoing server: ' . atlas_sf_clip($d['smtpHost'], 80) . ':' . $port('smtpPort', 587) . ' ' . ($has('smtpSecure') ? atlas_sf_clip($d['smtpSecure'], 12) : 'starttls');
  $facts[] = 'outgoing login: ' . (($has('smtpUser') && $has('smtpPass')) ? 'set' : 'not set');
  $facts[] = 'from address: ' . ($from ? 'set' : 'not set');
  $facts[] = 'incoming (IMAP): ' . ($imap ? atlas_sf_clip($d['imapHost'], 80) . ':' . $port('imapPort', 993) : 'off') . ($imap ? ', login ' . (($has('imapUser') && $has('imapPass')) ? 'set' : 'not set') : '');
  $facts[] = 'manifest intakeAddress: ' . ($intake ? 'set' : 'not set');
  $problems = [];
  if ($smtp !== $from) $problems[] = 'smtpHost and fromAddress must both be set for email to send';
  if ($imap && !$smtp) $problems[] = 'incoming mail is configured without outgoing mail';
  return [($smtp && $from) ? ($problems ? 'problem' : 'on') : ($problems ? 'problem' : 'off'), $problems, $facts];
}

function atlas_sf_feature_manifest_field($root, $f, $host) {
  list($st, $m) = atlas_sf_json_doc($root . '/.well-known/spatial.json', 1048576);
  if ($st === 'missing') return ['off', ['.well-known/spatial.json is missing'], []];
  if ($st !== 'ok') return ['problem', ['.well-known/spatial.json is not valid JSON'], []];
  if (!isset($m[$f['field']])) return ['off', ['no "' . $f['field'] . '" field in the manifest'], []];
  $v = $m[$f['field']];
  if (!is_array($v) || ($v !== [] && atlas_sf_is_list($v))) return ['problem', ['"' . $f['field'] . '" is present but is not an object, so it is ignored'], []];
  $facts = [];
  if (isset($v['classes']) && is_array($v['classes'])) {
    $names = [];
    foreach (array_slice($v['classes'], 0, 10) as $c) if (is_string($c)) $names[] = atlas_sf_clip($c, 60);
    $facts[] = 'classes (' . count($v['classes']) . '): ' . implode(', ', $names);
  } else $facts[] = 'classes: every eligible class';
  return ['on', [], $facts];
}

function atlas_sf_feature_moderation_issuer($root, $f, $host) {
  list($st, $d) = atlas_sf_json_doc($root . '/' . $f['file']);
  $env = getenv('ATLAS_MODERATION_AUDIENCES');
  if ($st === 'missing' && $env === false) return ['off', ['no ' . $f['file'] . ' (no moderation grants)'], []];
  if ($st !== 'ok' && $st !== 'missing') return ['problem', [$f['file'] . ($st === 'invalid' ? ' is not valid JSON' : ' could not be read')], []];
  $d = is_array($d) ? $d : [];
  $domain = isset($d['domain']) && is_string($d['domain']) && $d['domain'] !== '' ? $d['domain'] : null;
  $aud = [];
  if ($env !== false) { foreach (explode(',', $env) as $a) { $a = trim($a); if (atlas_sf_origin_ok($a)) $aud[] = $a; } }
  elseif (isset($d['audiences']) && is_array($d['audiences'])) { foreach ($d['audiences'] as $a) if (atlas_sf_origin_ok($a)) $aud[] = $a; }
  $facts = [];
  if ($domain !== null) $facts[] = 'domain: ' . atlas_sf_clip($domain, 80);
  $facts[] = 'presence endpoints (' . count($aud) . '): ' . implode(', ', array_map(function ($a) { return atlas_sf_clip($a, 80); }, array_slice($aud, 0, 4))) . ($env !== false ? ' (from the ATLAS_MODERATION_AUDIENCES environment variable)' : '');
  $problems = [];
  if ($domain !== null && $host !== '' && $domain !== $host) $problems[] = '"domain" is not this host, so the grant route refuses';
  if (($domain === null) !== (count($aud) === 0)) $problems[] = $domain === null ? 'no "domain" is set' : 'no valid presence endpoint is listed in "audiences"';
  if ($domain === null && !$aud) return ['off', ['no domain and no presence endpoints'], []];
  return [$problems ? 'problem' : 'on', $problems, $facts];
}

function atlas_sf_feature_presence_moderation($root, $f, $host) {
  $env = getenv('PRESENCE_MODERATION_CONFIG');
  $path = ($env !== false && $env !== '') ? $env : $root . '/' . $f['file'];
  list($st, $d) = atlas_sf_json_doc($path);
  if ($st === 'missing') return ['off', ['no moderation config file'], []];
  if ($st !== 'ok') return ['problem', ['the moderation config cannot be parsed, so moderation is disabled'], []];
  if (array_key_exists('enabled', $d) && !is_bool($d['enabled'])) return ['problem', ['"enabled" must be true or false, so moderation is disabled'], []];
  if (array_key_exists('enabled', $d) && $d['enabled'] === false) return ['off', ['"enabled" is false'], []];
  $problems = [];
  $aud = isset($d['audience']) ? $d['audience'] : null;
  if (!atlas_sf_origin_ok($aud)) $problems[] = '"audience" is missing or not a presence origin';
  $domains = isset($d['domains']) && is_array($d['domains']) && ($d['domains'] === [] || !atlas_sf_is_list($d['domains'])) ? $d['domains'] : null;
  if ($domains === null) $problems[] = '"domains" is missing or not an object';
  $facts = [];
  if (atlas_sf_origin_ok($aud)) $facts[] = 'audience: ' . atlas_sf_clip($aud, 80);
  if ($domains !== null) $facts[] = 'trusted domains (' . count($domains) . '): ' . implode(', ', array_map(function ($k) { return atlas_sf_clip($k, 60); }, array_slice(array_keys($domains), 0, 6)));
  foreach (['revokedModerators' => 'revoked moderators', 'revokedGrants' => 'revoked grants'] as $k => $label) if (isset($d[$k]) && is_array($d[$k])) $facts[] = $label . ': ' . count($d[$k]);
  return [$problems ? 'problem' : 'on', $problems, $facts];
}

function atlas_sf_feature_private_config_php($root, $f, $host) {
  $env = getenv($f['env']);
  $dir = ($env !== false && $env !== '') ? rtrim($env, '/\\') : atlas_sf_pointer_path($root . '/' . $f['pointer']);
  if ($dir === null || $dir === '') return ['off', ['no private folder configured (' . $f['pointer'] . ' is missing or still the example)'], []];
  $dir = rtrim($dir, '/\\');
  $facts = ['private folder: ' . atlas_sf_clip($dir, 160)];
  $problems = [];
  if (!is_dir($dir)) $problems[] = 'the private folder does not exist';
  elseif (!is_writable($dir)) $problems[] = 'the private folder is not writable';
  elseif (atlas_sf_inside($dir, $root)) $problems[] = 'the private folder is inside the web root';
  if ($problems) return ['problem', $problems, $facts];
  if (is_file($dir . '/DISABLED')) return ['off', ['switched off by the DISABLED file in the private folder'], $facts];
  $c = atlas_sf_small_file($dir . '/config.php', 16384);
  if ($c === null) return ['off', ['config.php is missing in the private folder'], $facts];
  if ($c === false) return ['problem', ['config.php could not be read'], $facts];
  // The files are written by the lab's admin tool with var_export, so the top-level keys have a fixed shape.
  if (!preg_match("/^  'enabled' => (true|false),/m", $c, $m)) return ['problem', ['cannot read the "enabled" setting: config.php was edited by hand or is in an unknown format'], $facts];
  if ($m[1] !== 'true') return ['off', ['"enabled" is false in config.php'], $facts];
  if (preg_match("/^  'domain' => '([^']*)'/m", $c, $dm)) {
    $facts[] = 'domain: ' . atlas_sf_clip($dm[1], 80);
    if ($host !== '' && $dm[1] !== $host) $problems[] = '"domain" in config.php is not this host';
  }
  $public = preg_match("/'publicDemo' => \s*array \(\s*'enabled' => true/", $c) ? 'on' : 'off';
  $facts[] = 'public demo for visitors: ' . $public;
  if (preg_match("/'allowInsecureHttp' => true/", $c)) $problems[] = 'allowInsecureHttp is on (for tests only; never on a live domain)';
  return [$problems ? 'problem' : 'on', $problems, $facts];
}

function atlas_sf_feature_rename($root, $f, $host) {
  $on = $root . '/' . $f['on']; $off = $root . '/' . $f['off'];
  $hasOn = is_file($on); $hasOff = is_file($off);
  if (!$hasOn) return ['off', [$hasOff ? 'switched off: ' . basename($f['off']) . ' exists and ' . basename($f['on']) . ' does not' : 'not configured: ' . basename($f['on']) . ' does not exist'], []];
  $facts = []; $problems = [];
  if ($hasOff) $facts[] = basename($f['off']) . ' is also present; ' . basename($f['on']) . ' is the one in use';
  $c = atlas_sf_small_file($on, 16384);
  if (!is_string($c)) return ['problem', [basename($f['on']) . ' could not be read'], $facts];
  $domain = preg_match("/^\s*'domain'\s*=>\s*'([^']*)'/m", $c, $m) ? $m[1] : null;
  $origin = preg_match("/^\s*'origin'\s*=>\s*'([^']*)'/m", $c, $m) ? $m[1] : null;
  if ($domain !== null) $facts[] = 'domain: ' . atlas_sf_clip($domain, 80);
  if ($origin !== null) $facts[] = 'origin: ' . atlas_sf_clip($origin, 80);
  if ($domain === 'example.com' || $origin === 'https://example.com') $problems[] = 'still has the example.com placeholder values';
  elseif ($domain !== null && $host !== '' && $domain !== $host) $problems[] = '"domain" is not this host';
  $facts[] = 'issuer key: ' . (preg_match("/^\s*'issuerKeys'\s*=>\s*\[\s*'/m", $c) ? 'set' : 'not set');
  if (!preg_match("/^\s*'issuerKeys'\s*=>\s*\[\s*'/m", $c)) $problems[] = 'no issuer key is set, so membership checks cannot pass';
  $facts[] = 'TURN relay: ' . (preg_match("/^\s*'turnUrls'\s*=>\s*\[\s*'/m", $c) ? 'configured' : 'none');
  if (preg_match("/^\s*'stateDir'\s*=>\s*'([^']+)'/m", $c, $m)) $facts[] = 'state folder: ' . atlas_sf_clip($m[1], 120) . (is_dir($m[1]) && atlas_sf_inside($m[1], $root) ? ' (inside the web root)' : '');
  else $facts[] = 'state folder: default, inside the web folder (blocked by .htaccess)';
  return [$problems ? 'problem' : 'on', $problems, $facts];
}

function atlas_sf_feature_private_dir_txt($root, $f, $host) {
  $env = getenv($f['env']);
  $how = 'environment variable ' . $f['env'];
  $dir = ($env !== false && $env !== '') ? $env : null;
  if ($dir === null) {
    $c = atlas_sf_small_file($root . '/' . $f['file'], 1024);
    $dir = is_string($c) ? trim($c) : '';
    $how = $f['file'];
    if ($dir === '') return ['off', ['not set: replay records, holdings and journals live in lib/ (protected by lib/.htaccess)'], []];
  }
  $dir = rtrim($dir, '/\\');
  $facts = ['folder: ' . atlas_sf_clip($dir, 160), 'set in: ' . $how];
  $problems = [];
  if (!preg_match('#^(/|[A-Za-z]:[\\\\/])#', $dir)) $problems[] = 'the path must be absolute';
  elseif (!is_dir($dir)) $problems[] = 'the folder does not exist, so the issuer answers 503';
  elseif (!is_writable($dir)) $problems[] = 'the folder is not writable, so the issuer answers 503';
  elseif (atlas_sf_inside($dir, $root)) $problems[] = 'the folder is inside the web root';
  return [$problems ? 'problem' : 'on', $problems, $facts];
}

function atlas_sf_features($root, $features, $host) {
  $out = [];
  foreach ($features as $f) {
    $installed = true;
    foreach ($f['needs'] as $n) if (!is_file($root . '/' . $n)) $installed = false;
    $res = ['id' => $f['id'], 'label' => $f['label'], 'group' => isset($f['group']) ? $f['group'] : '', 'about' => isset($f['about']) ? $f['about'] : '', 'enable' => $f['enable'], 'disable' => $f['disable'], 'pausable' => atlas_sf_pausable($f)];
    $reader = 'atlas_sf_feature_' . str_replace('-', '_', $f['type']);
    if (!$installed) { $res['state'] = 'absent'; $res['reasons'] = ['its files are not on this domain']; $res['facts'] = []; }
    elseif (!function_exists($reader)) { $res['state'] = 'problem'; $res['reasons'] = ['no reader for type ' . $f['type']]; $res['facts'] = []; }
    else { $r = $reader($root, $f, $host); $res['state'] = $r[0]; $res['reasons'] = $r[1]; $res['facts'] = $r[2]; }
    $out[] = $res;
  }
  return $out;
}

// Features are pausable from the admin panel only when the registry says so and the type has a safe writer.
function atlas_sf_pausable($f) {
  return !empty($f['pause']) && in_array(isset($f['type']) ? $f['type'] : '', ['studio-config', 'json-enabled', 'private-config-php'], true);
}

// The registry shipped with the issuer: lib/site-features.json. Returns a list of feature definitions, or [] when
// the file is missing or unreadable.
function atlas_sf_registry($root) {
  list($st, $d) = atlas_sf_json_doc($root . '/lib/site-features.json', 262144);
  return ($st === 'ok' && isset($d['features']) && is_array($d['features']) && atlas_sf_is_list($d['features'])) ? $d['features'] : [];
}
