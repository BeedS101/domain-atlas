<?php
// POST /atlas/asset/recover-file-export — mirrors issuer-server/server.js's
// same route (SPEC.md §13.5.1): step two of recovering an interrupted file
// export. The owner of an export, proven by a signature from the key
// recorded when the export was made over a fresh single-use challenge, gets
// the export finished or reported. Safe to repeat: while the file is
// claimable every call returns the same file; afterwards it returns the
// receipt outcome. Never mints anything.
require_once __DIR__ . '/../../lib/bootstrap.php';
handle_preflight();
require_post();

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}
$intent = $body['intent'] ?? null;
if (!is_array($intent) || !isset($intent['payload']) || !isset($intent['proof']) || !is_array($intent['payload']) || !is_array($intent['proof'])) {
  send_json(400, ['error' => 'intent must carry payload and proof']);
}
$payload = $intent['payload'];
$credentialId = $payload['credentialId'] ?? null;
if (($payload['action'] ?? null) !== 'recover-file-export' || !is_string($credentialId) || $credentialId === '') {
  send_json(400, ['error' => 'intent does not authorize recovering an export']);
}
if (!verify_envelope($payload, $intent['proof'])) send_json(400, ['error' => 'intent signature does not check out']);

// Exports, recoveries and claims run one at a time.
$lock = atlas_bearer_lock();

$checked = check_recovery_challenge($credentialId, $payload['challenge'] ?? null);
if (isset($checked['error'])) {
  send_json(400, [
    'error' => $checked['error'] === 'expired-challenge' ? 'the challenge has expired; request a new one' : 'the challenge is not valid',
    'code' => $checked['error']
  ]);
}

// An unknown id and somebody else's export answer identically.
$existing = file_export_of(read_file_exports(), $credentialId);
if ($existing === null || $existing['ownerPublicKey'] !== ($intent['proof']['publicKey'] ?? null)) {
  send_json(404, ['error' => 'no export of this credential by this key', 'code' => 'not-found']);
}
if (!consume_recovery_challenge($checked['nonce'], $checked['expiry'])) {
  send_json(400, ['error' => 'the challenge has already been used; request a new one', 'code' => 'challenge-used']);
}

$result = reconcile_file_export($credentialId);
$rec = $result['rec'];
$receipt = ['exportId' => $rec['exportId'], 'fileId' => $rec['fileId'], 'state' => $rec['state'], 'createdAt' => $rec['createdAt'], 'closedAt' => $rec['closedAt'] ?? null];
if ($result['outcome'] === 'pending') {
  if (is_suspended($rec['fileId'])) send_json(409, ['error' => 'this file is currently suspended pending review', 'code' => 'suspended', 'receipt' => $receipt]);
  send_json(200, ['status' => 'pending', 'file' => $rec['file'], 'exportId' => $rec['exportId']]);
}
if ($result['outcome'] === 'in-progress') send_json(409, ['error' => 'the file is being claimed right now', 'code' => 'in-progress', 'receipt' => $receipt]);
if ($result['outcome'] === 'claimed') send_json(409, ['error' => 'the file has been claimed', 'code' => 'already-claimed', 'receipt' => $receipt]);
if ($result['outcome'] === 'abandoned') send_json(409, ['error' => 'the export did not complete and was abandoned; the original was spent elsewhere', 'code' => 'export-abandoned', 'receipt' => $receipt]);
send_json(409, ['error' => 'the file was revoked', 'code' => 'file-revoked', 'receipt' => $receipt]);
