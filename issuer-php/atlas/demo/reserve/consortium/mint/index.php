<?php
// GET /atlas/demo/reserve/consortium/mint?id=... — mirrors
// issuer-server/server.js's same route. Ungated read: the canonical
// source a sibling domain's own co-sign action (co-sign.php) fetches
// before it ever signs anything — never trusts a locally supplied action
// payload.
//
// Lives at mint/index.php, not a sibling mint.php next to this same
// mint/ directory (co-sign.php's and approve.php's home) — same real
// Apache directory-vs-rewrite collision atlas/demo/reserve/mint/index.php
// already works around; see that file's own comment for the full account.
require_once __DIR__ . '/../../../../../lib/bootstrap.php';
handle_preflight();
require_get();

$id = $_GET['id'] ?? null;
if (!$id) send_json(400, ['error' => 'id is required']);

$request = atlas_find_reserve_mint_consortium_request($id);
if (!$request) send_json(404, ['error' => 'no such consortium mint request (or it already expired)']);
send_json(200, ['request' => $request]);
