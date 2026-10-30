<?php
// Server-owned model mapping. Never accept modelPath or thumbnailPath from a design: the template
// picks the entry and nothing else does. These are visual references only, not proof of ownership
// and not authority to mint. Issuance checks that both files exist on this site (see below).
function atlas_studio_model_for_template($template) {
  $approved = [
    'trophy'=>['modelPath'=>'/assets/trophy.glb','thumbnailPath'=>'/assets/trophy.png'],
    'badge'=>['modelPath'=>'/assets/badge.glb','thumbnailPath'=>'/assets/badge.png'],
    'key'=>['modelPath'=>'/assets/key.glb','thumbnailPath'=>'/assets/key.png'],
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
  $magic = ['modelPath'=>"glTF", 'thumbnailPath'=>"\x89PNG"];
  foreach ($magic as $field=>$head) {
    $path = $model[$field] ?? null;
    if (!is_string($path) || !preg_match('#^/assets/[a-z0-9-]+\.(glb|png)$#D', $path)) return false;
    $real = realpath($root . $path);
    if ($real === false) return false;
    $real = str_replace('\\', '/', $real);
    if (strpos($real, $root . '/assets/') !== 0 || !is_file($real) || filesize($real) < 16) return false;
    $fh = @fopen($real, 'rb');
    if (!$fh) return false;
    $got = fread($fh, strlen($head));
    fclose($fh);
    if ($got !== $head) return false;
  }
  return true;
}
