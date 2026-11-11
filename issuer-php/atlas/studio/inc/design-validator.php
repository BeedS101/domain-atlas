<?php
if (PHP_SAPI !== 'cli' && isset($_SERVER['SCRIPT_FILENAME']) && realpath($_SERVER['SCRIPT_FILENAME']) === __FILE__) { http_response_code(404); exit; } // include-only
// Asset Studio design validation. Does not issue assets or touch issuer keys.
// Reuses the PHP issuer's handle profanity list and normalizer for every visitor-supplied
// string that ends up in a signed credential (name and description).
require_once __DIR__.'/../../../lib/store.php';
require_once __DIR__.'/equipment.php';

// Single-line display text: valid UTF-8, no control, format (bidi overrides, zero-width), separator
// or unassigned characters, not blank, at most $maxChars characters and $maxBytes bytes.
function atlas_studio_text_ok($value, $maxChars, $maxBytes) {
  if (!is_string($value) || strlen($value) > $maxBytes) return false;
  if (preg_match('//u', $value) !== 1) return false;
  if (preg_match('/[\p{C}\p{Zl}\p{Zp}]/u', $value) === 1) return false;
  $trimmed = trim($value);
  if ($trimmed === '') return false;
  $chars = preg_match_all('/./us', $trimmed);
  return $chars !== false && $chars <= $maxChars;
}

const ATLAS_STUDIO_MAX_PROPERTIES = 6;

// Optional creator-supplied fields. Each is left out of the validated design when it carries no information
// (scope 'bound', no expiry, no properties), so a design without them keeps the digest it always had.
// Pure: nothing here depends on the clock; the issuer's expiry window is applied by the issuance plan.
function atlas_studio_validate_options($input, &$design) {
  if (array_key_exists('tradeScope', $input)) {
    if (!in_array($input['tradeScope'], ['bound','local'], true)) return 'invalid-trade-scope';
    if ($input['tradeScope'] === 'local') $design['tradeScope'] = 'local';
  }
  if (array_key_exists('expiresAt', $input)) {
    $v = $input['expiresAt'];
    if (!is_string($v) || !preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/D', $v)) return 'invalid-expiry';
    $t = DateTimeImmutable::createFromFormat('!Y-m-d\TH:i:s\Z', $v, new DateTimeZone('UTC'));
    if ($t === false || $t->format('Y-m-d\TH:i:s\Z') !== $v) return 'invalid-expiry';
    $design['expiresAt'] = $v;
  }
  if (array_key_exists('properties', $input)) {
    $props = $input['properties'];
    if (!is_array($props)) return 'invalid-properties';
    if ($props !== []) {
      if (array_keys($props) === range(0, count($props) - 1) || count($props) > ATLAS_STUDIO_MAX_PROPERTIES) return 'invalid-properties';
      $clean = [];
      foreach ($props as $k => $val) {
        if (!is_string($k) || !preg_match('/^[a-z][a-z0-9_]{0,23}$/D', $k)) return 'invalid-property-key';
        if (!atlas_studio_text_ok($val, 64, 256)) return 'invalid-property-value';
        if (atlas_handle_contains_blocked_word($val) || atlas_handle_contains_blocked_word(str_replace('_', ' ', $k))) return 'inappropriate-property';
        $clean[$k] = trim($val);
      }
      ksort($clean, SORT_STRING);
      $design['properties'] = $clean;
    }
  }
  return null;
}

function atlas_studio_validate_design($input) {
  if (!is_array($input) || ($input !== [] && array_keys($input) === range(0, count($input) - 1))) return ['ok'=>false,'error'=>'invalid-design'];
  $fields = ['schema','template','name','description','finish','tradeScope','expiresAt','properties','color','stats'];
  foreach (array_keys($input) as $key) if (!in_array($key,$fields,true)) return ['ok'=>false,'error'=>'unexpected-field'];
  if (($input['schema'] ?? null) !== 'atlas.asset-studio.design/0.1') return ['ok'=>false,'error'=>'invalid-schema'];
  if (!in_array($input['template'] ?? null,['trophy','badge','key','necklace','gloves','shoulders','trinket','sword','ring','shield'],true)) return ['ok'=>false,'error'=>'invalid-template'];
  if (!in_array($input['finish'] ?? null,['gold','silver','bronze'],true)) return ['ok'=>false,'error'=>'invalid-finish'];
  foreach (['name'=>[64,256],'description'=>[240,960]] as $field=>$limits) {
    if (!atlas_studio_text_ok($input[$field] ?? null, $limits[0], $limits[1])) return ['ok'=>false,'error'=>'invalid-'.$field];
  }
  if (atlas_handle_contains_blocked_word($input['name'])) return ['ok'=>false,'error'=>'inappropriate-name'];
  if (atlas_handle_contains_blocked_word($input['description'])) return ['ok'=>false,'error'=>'inappropriate-description'];
  $design = [
    'schema'=>'atlas.asset-studio.design/0.1',
    'template'=>$input['template'],
    'name'=>trim($input['name']),
    'description'=>trim($input['description']),
    'finish'=>$input['finish'],
  ];
  $bad = atlas_studio_validate_options($input, $design);
  if ($bad !== null) return ['ok'=>false,'error'=>$bad];
  if (atlas_studio_is_equipment($design['template'])) {
    $bad = atlas_studio_validate_equipment($input, $design);
    if ($bad !== null) return ['ok'=>false,'error'=>$bad];
  } elseif (array_key_exists('color', $input) || array_key_exists('stats', $input)) {
    return ['ok'=>false,'error'=>'option-not-allowed'];
  }
  return ['ok'=>true,'design'=>$design];
}
