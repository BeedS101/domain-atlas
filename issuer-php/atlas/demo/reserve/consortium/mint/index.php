<?php
// GET /atlas/demo/reserve/consortium/mint/?id=... — mirrors
// issuer-server/server.js's same route. Ungated read: the canonical
// source a sibling domain's own co-sign action (co-sign.php) fetches
// before it ever signs anything — never trusts a locally supplied action
// payload.
//
// Lives at mint/index.php, not a sibling mint.php next to this same
// mint/ directory (co-sign.php's and approve.php's home) — same real
// Apache directory-vs-rewrite collision atlas/demo/reserve/mint/index.php
// already works around; see that file's own comment for the full account.
//
// Every caller of this route MUST use the trailing slash
// (.../mint/?id=...) — not cosmetic here either. A real Apache docroot
// 301-redirects a request missing the trailing slash to add one; a
// same-origin GET just follows that transparently, but the admin
// panel's own cross-origin fetch to a SIBLING domain's copy of this
// route is a CORS request, and Apache's own redirect response carries
// no Access-Control-Allow-Origin header (that only comes from this
// endpoint itself, which the redirect never reaches) — so the browser
// refuses to follow it and fetch() rejects with a plain "Failed to
// fetch", not a CORS-specific message. Same root cause as
// atlas/admin/trusted-trade-peers/index.php's own trailing slash, just
// surfacing as a cross-origin failure on a GET instead of a 405 on a
// POST.
require_once __DIR__ . '/../../../../../lib/bootstrap.php';
handle_preflight();
require_get();

$id = $_GET['id'] ?? null;
if (!$id) send_json(400, ['error' => 'id is required']);

$request = atlas_find_reserve_mint_consortium_request($id);
if (!$request) send_json(404, ['error' => 'no such consortium mint request (or it already expired)']);
send_json(200, ['request' => $request]);
