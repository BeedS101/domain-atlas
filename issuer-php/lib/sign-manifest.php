<?php
// Domain Atlas — SPEC.md §3.7 optional domain identity pinning, PHP side.
//
// issuer-server/server.js (Node) signs and caches the pinned manifest once,
// in memory, at process boot (see preparePinnedManifest() there) — that
// works because Node has a long-lived process with an actual "startup"
// moment. PHP has neither: every endpoint script here starts fresh on each
// request (atlas_load_keys(), called at the top of each one, is proof of
// that), and .well-known/spatial.json is served as a plain static file
// straight by the webserver — no PHP script sits in front of it at all, so
// there is no per-request hook point to intercept the way Node's
// serveStatic() does.
//
// So PHP-side pinning is a deploy-time step instead of a runtime one: run
// this script once, by hand (or from a deploy script), any time you've
// created or edited your real .well-known/spatial.json. It signs that file
// IN PLACE with this domain's own persisted signing key — the same key
// atlas-key.json already publishes — adding identityKey + signature. This
// is the same idea as Node's approach (sign the manifest with the domain's
// real key, never hand-author a signature into tracked source), just moved
// to a different point in the pipeline because PHP has no boot moment to
// hook: a static-site build step signing a generated asset before upload,
// not a running server intercepting a request.
//
// Usage (from the issuer-php/ directory, or anywhere — the path is what
// matters, not the cwd):
//   php lib/sign-manifest.php [/path/to/.well-known/spatial.json]
// With no argument, defaults to the manifest expected right next to this
// bundle's own docroot (atlas_docroot(), the same folder
// ensure_well_known_files() already writes atlas-key.json into) —
// i.e. wherever you dropped this whole issuer-php bundle, since that's
// meant to be your site's document root per README.txt.
//
// Re-running this script is safe and idempotent in effect: it always signs
// fresh from the manifest's CURRENT content (minus any previous
// identityKey/signature it may have added itself), so editing the source
// worlds/portals content and re-running just re-signs the new content —
// it never accumulates stale signed layers.

require_once __DIR__ . '/crypto.php';
require_once __DIR__ . '/store.php';
require_once __DIR__ . '/bootstrap.php';

function atlas_sign_manifest_main($argv) {
  $path = isset($argv[1]) ? $argv[1] : (atlas_docroot() . '/.well-known/spatial.json');

  $raw = @file_get_contents($path);
  if ($raw === false) {
    fwrite(STDERR, "Could not read $path\n");
    exit(1);
  }
  $manifest = json_decode($raw, true);
  if (!is_array($manifest)) {
    fwrite(STDERR, "$path is not valid JSON\n");
    exit(1);
  }
  if (!isset($manifest['domain']) || !is_string($manifest['domain']) || $manifest['domain'] === '') {
    fwrite(STDERR, "$path has no \"domain\" field — SPEC.md section 3.7 pinning only applies to a domain-anchored manifest.\n");
    exit(1);
  }

  // Sign from the manifest's OWN content, not whatever this script last
  // wrote — re-running after an edit (or against a manifest this script
  // never touched before) always produces a signature over the current
  // worlds/portals/etc, never a stale leftover from a prior run.
  $unsigned = $manifest;
  unset($unsigned['identityKey'], $unsigned['signature']);

  $kp = load_or_create_keypair();
  // Same order issuer-server/server.js's main() follows (ensureWellKnownFiles
  // before preparePinnedManifest) — guarantees .well-known/atlas-key.json
  // publishes this exact key BEFORE the pinned manifest naming it is ever
  // written, rather than depending on some unrelated web request having hit
  // an atlas/*.php endpoint first (this script is meant to be runnable
  // stand-alone, right after dropping the bundle in place).
  ensure_well_known_files($kp['publicKeyB64url']);
  $unsigned['identityKey'] = $kp['publicKeyB64url'];
  $signature = atlas_sign($kp['privateKey'], $unsigned);
  $pinned = $unsigned;
  $pinned['signature'] = $signature;

  file_put_contents($path, json_encode($pinned, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n");
  fwrite(STDOUT, "Signed $path with identityKey " . substr($kp['publicKeyB64url'], 0, 24) . "...\n");
}

// Only run when invoked directly (php lib/sign-manifest.php ...), not when
// required — lets a test require this file to reuse atlas_sign_manifest_main()
// against an isolated fixture path without going through a real CLI process.
if (php_sapi_name() === 'cli' && realpath($argv[0]) === __FILE__) {
  atlas_sign_manifest_main($argv);
}
