<?php
// Asset Studio design validation. Does not issue assets or touch issuer keys.
function atlas_studio_validate_design($input) {
  if (!is_array($input) || array_keys($input) === range(0, count($input) - 1)) return ['ok'=>false,'error'=>'invalid-design'];
  $fields = ['schema','template','name','description','finish'];
  foreach (array_keys($input) as $key) if (!in_array($key,$fields,true)) return ['ok'=>false,'error'=>'unexpected-field'];
  if (($input['schema'] ?? null) !== 'atlas.asset-studio.design/0.1') return ['ok'=>false,'error'=>'invalid-schema'];
  if (!in_array($input['template'] ?? null,['trophy','badge','key'],true)) return ['ok'=>false,'error'=>'invalid-template'];
  if (!in_array($input['finish'] ?? null,['gold','silver','bronze'],true)) return ['ok'=>false,'error'=>'invalid-finish'];
  foreach (['name'=>64,'description'=>240] as $field=>$max) {
    $value=$input[$field] ?? null;
    if (!is_string($value) || trim($value)==='' || strlen($value)>$max || preg_match('/[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F]/', $value)) return ['ok'=>false,'error'=>'invalid-'.$field];
  }
  return ['ok'=>true,'design'=>[
    'schema'=>'atlas.asset-studio.design/0.1',
    'template'=>$input['template'],
    'name'=>trim($input['name']),
    'description'=>trim($input['description']),
    'finish'=>$input['finish'],
  ]];
}
