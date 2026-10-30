<?php
// Asset Studio design validation. Does not issue assets or touch issuer keys.
// Reuses the PHP issuer's handle profanity list and normalizer for every visitor-supplied
// string that ends up in a signed credential (name and description).
require_once __DIR__.'/../../../lib/store.php';

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

function atlas_studio_validate_design($input) {
  if (!is_array($input) || ($input !== [] && array_keys($input) === range(0, count($input) - 1))) return ['ok'=>false,'error'=>'invalid-design'];
  $fields = ['schema','template','name','description','finish'];
  foreach (array_keys($input) as $key) if (!in_array($key,$fields,true)) return ['ok'=>false,'error'=>'unexpected-field'];
  if (($input['schema'] ?? null) !== 'atlas.asset-studio.design/0.1') return ['ok'=>false,'error'=>'invalid-schema'];
  if (!in_array($input['template'] ?? null,['trophy','badge','key'],true)) return ['ok'=>false,'error'=>'invalid-template'];
  if (!in_array($input['finish'] ?? null,['gold','silver','bronze'],true)) return ['ok'=>false,'error'=>'invalid-finish'];
  foreach (['name'=>[64,256],'description'=>[240,960]] as $field=>$limits) {
    if (!atlas_studio_text_ok($input[$field] ?? null, $limits[0], $limits[1])) return ['ok'=>false,'error'=>'invalid-'.$field];
  }
  if (atlas_handle_contains_blocked_word($input['name'])) return ['ok'=>false,'error'=>'inappropriate-name'];
  if (atlas_handle_contains_blocked_word($input['description'])) return ['ok'=>false,'error'=>'inappropriate-description'];
  return ['ok'=>true,'design'=>[
    'schema'=>'atlas.asset-studio.design/0.1',
    'template'=>$input['template'],
    'name'=>trim($input['name']),
    'description'=>trim($input['description']),
    'finish'=>$input['finish'],
  ]];
}
