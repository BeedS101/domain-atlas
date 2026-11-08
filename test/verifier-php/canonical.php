<?php
// Canonical JSON of every document in a file (one JSON document per line), as the verifier package and, for comparison,
// as the reference issuer's canonicalize() produce it. Prints one line per document: base64(package) TAB base64(issuer) .
//   php test/verifier-php/canonical.php <verifier-php dir> <issuer-php dir> <documents file>
$verifier = rtrim($argv[1], '/');
$issuerLib = rtrim($argv[2], '/') . '/lib/crypto.php';
$lines = file($argv[3], FILE_IGNORE_NEW_LINES);

// the issuer's functions are global, the verifier's are namespaced: load both
require $verifier . '/lib/atlas-verify-crypto.php';
require $issuerLib;
ini_set('serialize_precision', '-1');

foreach ($lines as $line) {
  $asObject = json_decode($line, false, 512);
  $asArray = json_decode($line, true, 512);
  try { $mine = base64_encode(DomainAtlas\Verify\canonicalize($asObject)); } catch (Throwable $e) { $mine = 'ERR'; }
  try { $theirs = base64_encode(canonicalize($asArray)); } catch (Throwable $e) { $theirs = 'ERR'; }
  echo $mine, "\t", $theirs, "\n";
}
