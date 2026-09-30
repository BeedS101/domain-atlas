<?php
// GET /atlas/demo/reserve/mint?id=... — mirrors issuer-server/server.js's
// same route. Ungated, same "read is open" reasoning as every other
// status/discovery read in this codebase — this is the one call every
// committee member's own client is expected to make for itself before
// signing (see store.php's reserve_mint_approval_payload_of() — WYSIWYS).
//
// Lives at mint/index.php, NOT a sibling mint.php next to this same mint/
// directory (sign.php's home) — same real Apache directory-vs-rewrite
// collision this project already worked around for atlas/world/drops and
// atlas/demo/bank/approval (see either one's own index.php for the full
// account).
require_once __DIR__ . '/../../../../lib/bootstrap.php';
handle_preflight();
require_get();

$id = $_GET['id'] ?? null;
if (!$id) send_json(400, ['error' => 'id is required']);

$approval = find_reserve_mint_approval($id);
if (!$approval) send_json(404, ['error' => 'no such mint request (or it already expired)']);
send_json(200, ['approval' => $approval]);
