<?php
// POST /atlas/admin/site-status — mirrors issuer-server/server.js's same route. Admin-gated (require_admin_auth()).
//
// Which features are switched on, off or misconfigured on this domain (the same reader the site doctor uses, see
// lib/site-features.php), plus how to turn each one on or off. Read-only. Only allow-listed values are returned;
// passwords, tokens, keys and mail settings are never output.
require_once __DIR__ . '/../../lib/bootstrap.php';
require_once __DIR__ . '/../../lib/site-features.php';
handle_preflight();
require_post();

$body = read_admin_json_body();

$payload = $body['payload'] ?? [];
$proof = $body['proof'] ?? null;
$token = $body['token'] ?? null;
$auth = require_admin_auth($payload, $proof, $token, '/atlas/admin/site-status');
if (isset($auth['error'])) admin_auth_fail($auth);

$root = atlas_docroot();
send_json(200, ['features' => atlas_sf_features($root, atlas_sf_registry($root), atlas_domain())]);
