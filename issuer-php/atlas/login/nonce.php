<?php
// GET /atlas/login/nonce — mirrors issuer-server/server.js's same route.
// Ungated, same reasoning as admin/session/nonce.php: a nonce is worthless
// without a signature over it from someone who actually holds an
// atlas.demo.login.badge (see verify.php).
require_once __DIR__ . '/../../lib/bootstrap.php';
handle_preflight();
require_get();

send_json(200, ['nonce' => issue_login_nonce()]);
