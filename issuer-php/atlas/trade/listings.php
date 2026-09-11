<?php
// GET /atlas/trade/listings (v1.14, SPEC.md §7) — browse this station's
// own open, unexpired listings. Deliberately ungated: reading reveals
// nothing a poster didn't already choose to make public by posting (offer,
// want, and their own public key — exactly what a prospective buyer
// needs), the same "read is open, write is gated" asymmetry Post Office's
// own inbox-check already has against its send. read_pending_trades()
// already lazily prunes anything expired, so nothing extra is needed here
// beyond shaping each entry for a browsing client.
require_once __DIR__ . '/../../lib/bootstrap.php';
handle_preflight();
require_get();

$pendingDoc = read_pending_trades();
$listings = array_map(function ($t) {
  return [
    'pendingId' => $t['id'],
    'posterPublicKey' => $t['intent']['proof']['publicKey'],
    'offer' => $t['intent']['payload']['offer'],
    'want' => $t['intent']['payload']['want'],
    'expiresAt' => $t['intent']['payload']['expiresAt'],
  ];
}, $pendingDoc['trades']);

send_json(200, ['listings' => array_values($listings)]);
