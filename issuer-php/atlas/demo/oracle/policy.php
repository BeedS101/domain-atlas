<?php
// GET /atlas/demo/oracle/policy?id=... — mirrors issuer-server/server.js's
// same route. Ungated, same "read is open" reasoning as GET
// /atlas/demo/governance/proposal: a policy's own claim status is exactly
// what a holder (or anyone helping them) needs to check before attempting
// a claim.
require_once __DIR__ . '/../../../lib/bootstrap.php';
handle_preflight();
require_get();

$id = $_GET['id'] ?? null;
if (!$id) send_json(400, ['error' => 'id is required']);

$policy = find_oracle_policy($id);
if (!$policy) send_json(404, ['error' => 'no such policy']);

send_json(200, ['policy' => $policy]);
