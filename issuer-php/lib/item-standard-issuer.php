<?php
if (PHP_SAPI !== 'cli' && isset($_SERVER['SCRIPT_FILENAME']) && realpath($_SERVER['SCRIPT_FILENAME']) === __FILE__) { http_response_code(404); exit; } // include-only
// Issuer-side use of the Item Standard (docs/item-standard-v0.1.md). Everything here applies only to a class
// whose catalog entry has an 'itemSpec', and to assets whose signed properties carry 'atlas.item.standard';
// every other class and asset goes through unchanged. issuer-server/item-standard-issuer.js does the same.
//
// The issuer owns the standard's properties: category, slot, capability list, use count and spec digest are
// derived from the class's itemSpec and signed, and a caller cannot supply or change them. Values the
// instance chooses (stat rolls, capability parameters, colours) must lie inside the spec's ranges.
//
// A signed asset is always checked against the spec its own digest names, never against whatever the class
// declares today, so editing a class's spec later cannot widen assets issued earlier. Every spec that has
// been signed is kept by digest in the spec history for that reason.
//
// Plain PHP 7.0 syntax on purpose: the issuer runs on shared hosting.
require_once __DIR__ . '/item-standard.php';

const ATLAS_ITEM_ISSUER_DIGEST_RE = '/^[0-9a-f]{64}$/D';

// An exception the generic handler (bootstrap.php) turns into {error, code, errors} with the exception's
// HTTP status.
class AtlasItemStandardException extends Exception {
  public $itemCode;
  public $itemErrors;
  public function __construct($message, $status, $itemCode, $itemErrors) {
    parent::__construct($message, $status);
    $this->itemCode = $itemCode;
    $this->itemErrors = $itemErrors;
  }
}

function atlas_item_issuer_failure($status, $code, $errors, $message = null) {
  return ['ok' => false, 'status' => $status, 'code' => $code, 'errors' => $errors, 'message' => $message !== null ? $message : $code];
}
function atlas_item_issuer_exception($result) {
  return new AtlasItemStandardException($result['message'], $result['status'], $result['code'], $result['errors']);
}
function atlas_item_issuer_send_failure($result) {
  send_json($result['status'], ['error' => $result['message'], 'code' => $result['code'], 'errors' => $result['errors']]);
}

function atlas_item_issuer_spec_of($entry) {
  return (is_array($entry) && isset($entry['itemSpec']) && is_array($entry['itemSpec'])) ? $entry['itemSpec'] : null;
}
function atlas_item_issuer_has_marker($properties) {
  return is_array($properties) && array_key_exists('atlas.item.standard', $properties);
}
// Keys the issuer derives from the spec (the rest of the standard's keys are instance values).
function atlas_item_issuer_is_derived_key($key) {
  $key = (string) $key;
  return atlas_item_starts_with($key, 'atlas.item.') || $key === 'atlas.avatar.slot';
}

// Keys a properties patch may not set. On a standard class: anything the issuer derives. On any other class:
// the standard's namespaces ('atlas.item.*', 'atlas.cap.*'), so an unrelated class cannot be made to look
// standard-conforming. A null (a deletion) is only refused for the derived keys.
function atlas_item_issuer_patch_problems($spec, $patch) {
  $errors = [];
  if (!is_array($patch)) return $errors;
  $keys = atlas_item_sorted_keys($patch);
  foreach ($keys as $key) {
    $value = $patch[$key];
    if ($spec !== null) {
      if (atlas_item_issuer_is_derived_key($key)) $errors[] = ['code' => 'item-patch-reserved-key', 'key' => $key];
    } elseif ((atlas_item_starts_with($key, 'atlas.item.') || atlas_item_starts_with($key, 'atlas.cap.')) && $value !== null) {
      $errors[] = ['code' => 'item-patch-reserved-key', 'key' => $key];
    }
  }
  return $errors;
}

// Builds the property bag an issuer signs for a class with an itemSpec: the caller's properties minus any
// derived key, plus the derived properties, then validated as a whole. Classes without a spec are returned
// untouched. $opts: model (the asset's model URL), issuerDomain.
function atlas_item_issuer_seal($cls, $entry, $properties, $opts) {
  $spec = atlas_item_issuer_spec_of($entry);
  if ($spec === null) return ['ok' => true, 'standard' => false, 'properties' => $properties];
  $ctx = ['classId' => $cls];
  if (isset($entry['fungible']) && is_bool($entry['fungible'])) $ctx['fungible'] = $entry['fungible'];
  if (isset($entry['presentation'])) $ctx['presentation'] = $entry['presentation'];
  if (isset($opts['issuerDomain'])) $ctx['issuerDomain'] = $opts['issuerDomain'];
  $specResult = atlas_item_validate_spec($spec, $ctx);
  if (!$specResult['ok']) return atlas_item_issuer_failure(500, 'item-spec-invalid', $specResult['errors'], 'this class declares an invalid itemSpec: ' . $cls);
  $sealed = [];
  foreach ((is_array($properties) ? $properties : []) as $key => $value) {
    if (!atlas_item_issuer_is_derived_key($key)) $sealed[$key] = $value;
  }
  foreach (atlas_item_derive_properties($spec) as $key => $value) $sealed[$key] = $value;
  $result = atlas_item_validate_properties($spec, $sealed, ['model' => isset($opts['model']) ? $opts['model'] : null]);
  if (!$result['ok']) return atlas_item_issuer_failure(400, 'item-properties-invalid', $result['errors'], 'item properties do not satisfy the class itemSpec: ' . $cls);
  return ['ok' => true, 'standard' => true, 'properties' => $sealed, 'spec' => $spec, 'digest' => $sealed['atlas.item.specDigest']];
}

// The spec a signed asset is to be checked against: the class's current spec when its digest matches the
// signed one, otherwise the recorded spec with that digest. 'spec' is null when the digest cannot be resolved.
function atlas_item_issuer_spec_for_asset($cls, $entry, $properties) {
  if (!atlas_item_issuer_has_marker($properties)) return ['standard' => false];
  $digest = isset($properties['atlas.item.specDigest']) ? $properties['atlas.item.specDigest'] : null;
  if (!is_string($digest) || !preg_match(ATLAS_ITEM_ISSUER_DIGEST_RE, $digest)) return ['standard' => true, 'spec' => null, 'digest' => null];
  $current = atlas_item_issuer_spec_of($entry);
  if ($current !== null && atlas_item_spec_digest($current) === $digest) return ['standard' => true, 'spec' => $current, 'digest' => $digest, 'current' => true];
  return ['standard' => true, 'spec' => atlas_item_issuer_spec_lookup($cls, $digest), 'digest' => $digest, 'current' => false];
}

// Checks a properties patch against an already-issued asset, for reissue and class-patch application. A
// standard asset is validated against its own signed spec; the result must still satisfy it. Other assets only
// have the standard's namespaces protected.
function atlas_item_issuer_check_patched_asset($asset, $entry, $patch) {
  $properties = (isset($asset['properties']) && is_array($asset['properties'])) ? $asset['properties'] : [];
  $info = atlas_item_issuer_spec_for_asset($asset['class'], $entry, $properties);
  if (!$info['standard']) {
    $problems = atlas_item_issuer_patch_problems(null, $patch);
    if (count($problems)) return atlas_item_issuer_failure(400, 'item-patch-reserved-key', $problems, 'properties in the Item Standard namespaces cannot be set on this asset');
    return ['ok' => true, 'standard' => false];
  }
  if ($info['spec'] === null) {
    return atlas_item_issuer_failure(409, 'item-spec-unavailable', [['code' => 'item-spec-unavailable', 'key' => 'atlas.item.specDigest']],
      'the item spec this asset was issued under is not available, so it cannot be changed');
  }
  $problems = atlas_item_issuer_patch_problems($info['spec'], $patch);
  if (count($problems)) return atlas_item_issuer_failure(400, 'item-patch-reserved-key', $problems, 'these properties are derived from the item spec and cannot be set');
  $merged = merge_properties($properties, $patch);
  $result = atlas_item_validate_properties($info['spec'], $merged, ['model' => isset($asset['model']) ? $asset['model'] : null]);
  if (!$result['ok']) return atlas_item_issuer_failure(400, 'item-properties-invalid', $result['errors'], 'the patched properties do not satisfy the asset item spec');
  return ['ok' => true, 'standard' => true, 'properties' => $merged, 'digest' => $info['digest']];
}

// Checks a class-wide properties patch (the stored patch with the new keys applied) against the class's
// current spec, as it would apply to a fresh item. Each holder's own signed spec is checked again when the
// patch reaches their credential.
function atlas_item_issuer_check_class_patch($cls, $entry, $storedProperties, $newProperties, $opts) {
  $spec = atlas_item_issuer_spec_of($entry);
  $problems = atlas_item_issuer_patch_problems($spec, $newProperties);
  if (count($problems)) return atlas_item_issuer_failure(400, 'item-patch-reserved-key', $problems, 'properties in the Item Standard namespaces cannot be set by a class patch');
  if ($spec === null) return ['ok' => true, 'standard' => false];
  $base = atlas_item_issuer_seal($cls, $entry, isset($entry['properties']) ? $entry['properties'] : [], $opts);
  if (!$base['ok']) return $base;
  $combined = array_merge(is_array($storedProperties) ? $storedProperties : [], is_array($newProperties) ? $newProperties : []);
  $result = atlas_item_validate_properties($spec, merge_properties($base['properties'], $combined), ['model' => isset($opts['model']) ? $opts['model'] : null]);
  if (!$result['ok']) return atlas_item_issuer_failure(400, 'item-properties-invalid', $result['errors'], 'the patch does not satisfy the class itemSpec');
  return ['ok' => true, 'standard' => true];
}

// A presented balance of this issuer's standard class that was issued under a spec the class no longer
// declares: re-minting it (split, consolidate, convert) would sign today's spec onto older value. Returns the
// refusal text, or null.
function atlas_item_issuer_superseded_spec_problem($entry, $properties) {
  $current = atlas_item_issuer_spec_of($entry);
  if ($current === null || !atlas_item_issuer_has_marker($properties)) return null;
  if (isset($properties['atlas.item.specDigest']) && $properties['atlas.item.specDigest'] === atlas_item_spec_digest($current)) return null;
  return 'this balance was issued under an earlier item spec for its class; it cannot be re-minted until the issuer reissues it';
}

// What GET /atlas/asset/class adds for a standard class.
function atlas_item_issuer_describe_spec($entry) {
  $spec = atlas_item_issuer_spec_of($entry);
  if ($spec === null) return null;
  return ['itemStandard' => ATLAS_ITEM_STANDARD_VERSION, 'itemSpec' => $spec, 'itemSpecDigest' => atlas_item_spec_digest($spec)];
}

// ---------- spec history: a JSON file holding every spec this issuer has signed, per class and digest.
// Entries are only ever added. ----------

function atlas_item_issuer_specs_file() {
  return __DIR__ . '/atlas-item-specs-store.json';
}

// Reads the history from an open, locked handle. An unreadable history is never replaced with an empty one.
function atlas_item_issuer_read_history($fh) {
  $text = stream_get_contents($fh);
  if (trim((string) $text) === '') return ['specs' => []];
  $doc = json_decode($text, true);
  if (!is_array($doc) || !isset($doc['specs']) || !is_array($doc['specs'])) {
    throw new Exception('the item spec history is unreadable; refusing to issue standard items until it is restored', 503);
  }
  return $doc;
}

function atlas_item_issuer_spec_record($cls, $spec) {
  $digest = atlas_item_spec_digest($spec);
  $fh = fopen(atlas_item_issuer_specs_file(), 'c+');
  if ($fh === false) throw new Exception('the item spec history could not be opened', 503);
  flock($fh, LOCK_EX);
  try {
    $doc = atlas_item_issuer_read_history($fh);
    if (isset($doc['specs'][$cls][$digest])) return $digest;
    $doc['specs'][$cls][$digest] = ['itemSpec' => $spec, 'recordedAt' => gmdate('Y-m-d\TH:i:s\Z')];
    ftruncate($fh, 0);
    rewind($fh);
    fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
    fflush($fh);
    return $digest;
  } finally {
    flock($fh, LOCK_UN);
    fclose($fh);
  }
}

function atlas_item_issuer_spec_lookup($cls, $digest) {
  if (!is_string($digest) || !preg_match(ATLAS_ITEM_ISSUER_DIGEST_RE, $digest)) return null;
  if (!file_exists(atlas_item_issuer_specs_file())) return null;
  $fh = fopen(atlas_item_issuer_specs_file(), 'c+');
  if ($fh === false) throw new Exception('the item spec history could not be opened', 503);
  flock($fh, LOCK_SH);
  try {
    $doc = atlas_item_issuer_read_history($fh);
  } finally {
    flock($fh, LOCK_UN);
    fclose($fh);
  }
  if (!isset($doc['specs'][$cls][$digest]['itemSpec']) || !is_array($doc['specs'][$cls][$digest]['itemSpec'])) return null;
  $spec = $doc['specs'][$cls][$digest]['itemSpec'];
  return atlas_item_spec_digest($spec) === $digest ? $spec : null;
}
