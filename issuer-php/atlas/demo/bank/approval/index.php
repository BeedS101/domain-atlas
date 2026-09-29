<?php
// GET /atlas/demo/bank/approval?id=... — mirrors issuer-server/server.js's
// same route. Ungated, same "read is open" reasoning as every other
// status/discovery read in this codebase. This is the one call every
// approver's own client is expected to make for itself before signing:
// fetching the canonical `action` straight from here, never accepting it
// as relayed by whoever assembled the request, is what makes the
// signature checked in sign.php mean anything (see store.php's
// bank_approval_payload_of() — WYSIWYS).
//
// Lives at approval/index.php, NOT a sibling approval.php next to this
// same approval/ directory (sign.php's home) — same real bug this
// project already walked back once for atlas/world/drops (see that
// directory's own index.php for the full account): a bare request for
// /atlas/demo/bank/approval on a real Apache host would collide with the
// approval/ directory sharing that exact name, and Apache's own
// directory handling wins that fight over the .htaccess rewrite that
// would otherwise map it to approval.php.
require_once __DIR__ . '/../../../../lib/bootstrap.php';
handle_preflight();
require_get();

$id = $_GET['id'] ?? null;
if (!$id) send_json(400, ['error' => 'id is required']);

$approval = find_bank_approval($id);
if (!$approval) send_json(404, ['error' => 'no such approval request (or it already expired)']);
send_json(200, ['approval' => $approval]);
