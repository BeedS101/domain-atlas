<?php
// GET /atlas/admin/is-admin?publicKey=... — mirrors issuer-server/
// server.js's same route. Ungated, boolean-only: lets a wallet decide
// whether to show its own "Admin" entry point for the identity it
// currently has active, without a full sign-a-nonce round trip just to
// render a button. Confirms membership of ONE presented key rather than
// exposing the roster itself (which stays unreachable directly — see
// atlas_admin_keys_file()'s own comment in lib/store.php) — no worse an
// information leak than every other "is this specific key/id valid" check
// already in this bundle (mail check, trade catalog lookups, and so on).
require_once __DIR__ . '/../../lib/bootstrap.php';
handle_preflight();
require_get();

$publicKey = $_GET['publicKey'] ?? null;
send_json(200, ['isAdmin' => is_string($publicKey) && $publicKey !== '' && is_admin_key($publicKey)]);
