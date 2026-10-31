<?php
if (PHP_SAPI !== 'cli' && isset($_SERVER['SCRIPT_FILENAME']) && realpath($_SERVER['SCRIPT_FILENAME']) === __FILE__) { http_response_code(404); exit; } // include-only
// Server-owned model mapping. Studio's models are their own collection under /assets/studio/, apart from the
// site's other item models in /assets/, which Studio never reads, writes or references. Never accept modelPath
// or thumbnailPath from a design: the template picks the entry and nothing else does. These are visual
// references only, not proof of ownership and not authority to mint. Issuance checks that both files exist on
// this site (see below).
function atlas_studio_model_for_template($template) {
  $approved = [
    'trophy'=>['modelPath'=>'/assets/studio/trophy.glb','thumbnailPath'=>'/assets/studio/trophy.png'],
    'badge'=>['modelPath'=>'/assets/studio/badge.glb','thumbnailPath'=>'/assets/studio/badge.png'],
    'key'=>['modelPath'=>'/assets/studio/key.glb','thumbnailPath'=>'/assets/studio/key.png'],
  ];
  return is_string($template) ? ($approved[$template] ?? null) : null;
}

// True when both referenced files exist under $docroot and look like what they claim to be (a binary
// glTF container and a PNG), resolve inside $docroot, and are not symlinks leaving it. A reference
// to a missing or substituted file must not be signed into a credential.
function atlas_studio_model_available($docroot, $model) {
  if (!is_array($model) || !is_string($docroot) || $docroot === '') return false;
  $root = realpath($docroot);
  if ($root === false) return false;
  $root = rtrim(str_replace('\\', '/', $root), '/');
  $magic = ['modelPath'=>["glTF", 'glb'], 'thumbnailPath'=>["\x89PNG", 'png']];
  foreach ($magic as $field=>$spec) {
    list($head, $ext) = $spec;
    $path = $model[$field] ?? null;
    if (!is_string($path) || !preg_match('#^/assets/studio/(trophy|badge|key)\.' . $ext . '$#D', $path)) return false;
    $real = realpath($root . $path);
    if ($real === false) return false;
    $real = str_replace('\\', '/', $real);
    if (strpos($real, $root . '/assets/studio/') !== 0 || !is_file($real) || filesize($real) < 16) return false;
    $fh = @fopen($real, 'rb');
    if (!$fh) return false;
    $got = fread($fh, strlen($head));
    fclose($fh);
    if ($got !== $head) return false;
  }
  return true;
}
