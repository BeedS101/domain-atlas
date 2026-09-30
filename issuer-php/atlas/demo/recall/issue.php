<?php
// POST /atlas/demo/recall/issue — mirrors issuer-server/server.js's same
// route. Self-serve sibling of the real, admin-gated
// atlas/admin/class-patch.php (SPEC.md's class-wide patch mechanism, see
// the README's own "Class-wide patches" section), restricted to
// atlas_demo_recallable_classes() and a fixed allow-list of recall notice
// texts (atlas_demo_recall_reasons()) — same "plays the privileged role"
// reasoning as every other atlas/demo/* route, just standing in for the
// manufacturer's own recall authority rather than a domain operator's.
// Sets tradeScope: 'bound' alongside the notice on purpose: once a class
// is recalled, nothing here still lets it be passed on to someone else,
// which recall-demo.html's own "try to break it" step actually exercises
// against the ordinary atlas/asset/transfer.php gate, not anything new.
//
// Deliberately does NOT touch any already-issued widget credential
// directly — nothing here even asks for one. The patch only ever reaches
// a current holder the next time their own wallet checks in
// (POST /atlas/mail/check.php, same mechanism every other class patch
// already uses), which is the entire point being demonstrated: this
// domain keeps no registry of who holds what, so a mass recall is one
// flat-file write, not N credential lookups.
require_once __DIR__ . '/../../../lib/bootstrap.php';
handle_preflight();
require_post();

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$assetClass = $body['assetClass'] ?? null;
$reason = $body['reason'] ?? null;

$recallableClasses = atlas_demo_recallable_classes();
if (!in_array($assetClass, $recallableClasses, true)) {
  send_json(400, ['error' => 'this endpoint only recalls: ' . implode(', ', $recallableClasses)]);
}
$recallReasons = atlas_demo_recall_reasons();
if (!is_string($reason) || !array_key_exists($reason, $recallReasons)) {
  send_json(400, ['error' => 'reason must be one of: ' . implode(', ', array_keys($recallReasons))]);
}

$patch = set_class_patch($assetClass, ['com.example.recallNotice' => $recallReasons[$reason]], 'bound');
send_json(200, ['assetClass' => $assetClass, 'patch' => $patch]);
