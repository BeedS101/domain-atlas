<?php
// GET /atlas/attestation/list?assetId=... (SPEC.md §5.11) — mirrors
// issuer-server/server.js's own /atlas/attestation/list handler exactly.
// Real, protocol-level, and deliberately ungated — same "read is open"
// reasoning as GET /atlas/world/drops and GET /atlas/trade/listings: an
// attestation only ever reveals what its own issuer already chose to make
// public by signing and publishing it. Lists every attestation THIS
// domain itself has issued about the named asset id — a client wanting
// the full picture asks every domain it knows might have an opinion, the
// same domain-local discovery §5.11 itself is explicit about not
// standardizing further.
require_once __DIR__ . '/../../lib/bootstrap.php';
handle_preflight();
require_get();

$assetId = $_GET['assetId'] ?? null;
if (!$assetId) send_json(400, ['error' => 'assetId is required']);

$doc = read_attestations();
$attestations = array_values(array_filter($doc['attestations'], function ($a) use ($assetId) {
  return $a['subject']['assetId'] === $assetId;
}));
send_json(200, ['domain' => atlas_domain(), 'assetId' => $assetId, 'attestations' => $attestations]);
