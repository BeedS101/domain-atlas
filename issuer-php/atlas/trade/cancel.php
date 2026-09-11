<?php
// POST /atlas/trade/cancel (v1.14, SPEC.md §7) — a poster withdraws
// their own still-open listing. Authorized the same way any other signed
// action in this spec is: a small envelope over {pendingId,
// action:'cancel'}, accepted only when the signing key matches the
// listing's own poster. Nothing to withdraw from a listing that's already
// been claimed or expired — read_pending_trades() has already dropped the
// latter by the time this looks it up.
require_once __DIR__ . '/../../lib/bootstrap.php';
handle_preflight();
require_post();

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$pendingId = $body['pendingId'] ?? null;
$intent = $body['intent'] ?? null;
if (!$pendingId || !$intent) send_json(400, ['error' => 'pendingId and intent are both required']);
if (!isset($intent['payload']) || !isset($intent['proof'])) send_json(400, ['error' => 'intent must carry payload and proof']);
if (($intent['payload']['pendingId'] ?? null) !== $pendingId || ($intent['payload']['action'] ?? null) !== 'cancel') {
  send_json(400, ['error' => 'intent does not authorize canceling this listing']);
}

$envelopeOk = verify_envelope($intent['payload'], $intent['proof']);
if (!$envelopeOk) send_json(400, ['error' => 'intent signature does not check out']);

$pendingDoc = read_pending_trades();
$posted = null;
foreach ($pendingDoc['trades'] as $t) {
  if ($t['id'] === $pendingId) { $posted = $t; break; }
}
if (!$posted) send_json(404, ['error' => 'listing not found — already claimed, withdrawn, or expired']);
if ($posted['intent']['proof']['publicKey'] !== $intent['proof']['publicKey']) {
  send_json(403, ['error' => 'only the original poster can withdraw this listing']);
}

remove_pending_trade($pendingId);
send_json(200, ['status' => 'canceled']);
