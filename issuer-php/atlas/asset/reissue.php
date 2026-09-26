<?php
// POST /atlas/asset/reissue — mirrors issuer-server/server.js's same route
// (SPEC.md §5.1.1: the supersedes-linked reissue pattern, non-fungible
// only — this is what lets an issuer publish an updated version of an
// asset a visitor already holds, e.g. a museum exhibit's properties
// changing after the visitor picked it up). Fungible classes are
// deliberately rejected: SPEC.md §5.1 requires every credential of a
// fungible class to carry identical properties/tradeScope so §5.4.1's
// consolidation can sum quantities without silently blending a differing
// fact, so a fungible credential's asset state only ever changes at the
// class level (ATLAS_ASSET_CATALOG), never by reissuing one specific
// balance.
//
// Input (inside `payload`, alongside a signed `proof`): {credential,
// properties, tradeScope} — the exact currently-held credential being
// replaced, plus at least one of a patch merged onto its asset.properties,
// or a new tradeScope. Verifies the presented credential really was
// signed by this domain and isn't already revoked before ever reissuing
// anything — an issuer can only ever reissue its own assets, never forge
// an update for a credential it didn't sign in the first place.
//
// `properties` goes through merge_properties() (lib/store.php): a key set
// to null is removed from the result entirely rather than kept as a
// literal null — the only way to actually take a fact away, since there
// was previously no way to do that at all.
//
// `tradeScope`: since tradeScope is baked into a credential's signed
// payload at mint time (mint_asset_by_class()'s tradeScope-defaulting
// logic), tightening a class's catalog entry to tradeScope => 'bound' does
// NOT retroactively change any credential of that class minted before the
// catalog entry said so — the old credential's own signature would break
// if tradeScope were edited in place, so the only honest fix is the same
// revoke-and-re-mint this endpoint already does for `properties`. See
// README.md's "Fixing a stale tradeScope on an already-issued credential"
// section for the exact command a domain operator would run.
//
// Admin-gated (require_admin_auth(), lib/store.php): rewriting an already-
// issued credential's properties or tradeScope is exactly the kind of
// action SPEC.md §10 puts on the domain's own side, never a visitor's —
// left open, anyone who could observe a credential (many are publicly
// visible via trade listings or gifts) could silently alter its
// properties or loosen/tighten its tradeScope without the owner's
// consent, under this domain's own real signature. Wire shape is
// {payload: {credential, properties, tradeScope}, proof} or {payload,
// token}, the same envelope /atlas/revoke and /atlas/mail/send already
// use.
require_once __DIR__ . '/../../lib/bootstrap.php';
handle_preflight();
require_post();
$kp = atlas_load_keys();

try {
  $requestBody = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$reissuePayload = $requestBody['payload'] ?? null;
$proof = $requestBody['proof'] ?? null;
$token = $requestBody['token'] ?? null;
$auth = require_admin_auth($reissuePayload, $proof, $token);
if (isset($auth['error'])) send_json(401, ['error' => $auth['error']]);

$credential = $reissuePayload['credential'] ?? null;
$hasProperties = array_key_exists('properties', $reissuePayload);
$properties = $reissuePayload['properties'] ?? null;
$hasTradeScope = array_key_exists('tradeScope', $reissuePayload);
$tradeScope = $reissuePayload['tradeScope'] ?? null;
if (!is_array($credential) || ($credential['credential'] ?? null) !== 'domain-atlas-asset/1.0') {
  send_json(400, ['error' => 'payload.credential must be a domain-atlas-asset/1.0 credential']);
}
if (!$hasProperties && !$hasTradeScope) {
  send_json(400, ['error' => 'at least one of properties (a patch onto asset.properties) or tradeScope is required']);
}
if ($hasProperties && !is_array($properties)) {
  send_json(400, ['error' => 'properties, when given, must be a patch object onto asset.properties']);
}
if ($hasTradeScope && $tradeScope !== 'local' && $tradeScope !== 'bound') {
  send_json(400, ['error' => "tradeScope, when given, must be 'local' or 'bound'"]);
}
if (!isset($credential['issuer']['domain']) || $credential['issuer']['domain'] !== atlas_domain()) {
  send_json(400, ['error' => 'credential was not issued by this domain']);
}
if (!isset($credential['asset']['fungible']) || $credential['asset']['fungible'] !== false) {
  send_json(400, ['error' => "reissue only applies to a non-fungible asset — a fungible class's properties/tradeScope are fixed per class (SPEC.md §5.1), not per credential"]);
}
if (is_revoked($credential['id'])) send_json(400, ['error' => 'credential is already revoked']);

$sigOk = verify_own_credential_signature($kp['publicKeyB64url'], $credential, asset_payload_of($credential));
if (!$sigOk) send_json(400, ['error' => "credential signature does not check out against this issuer's key"]);

$newAsset = $credential['asset'];
if ($hasTradeScope) $newAsset['tradeScope'] = $tradeScope;
if ($hasProperties) $newAsset['properties'] = merge_properties($newAsset['properties'] ?? [], $properties);
$newCredential = issue_asset($kp['privateKey'], $kp['publicKeyB64url'], $credential['owner']['publicKey'], $newAsset, $credential['quantity'], $credential['id']);

// Same ordering guarantee §5.4's split/consolidate already give: the new
// credential is signed FIRST, then the old one revoked — a crash between
// the two would leave an extra valid asset rather than a holder with
// neither.
atlas_revoke($credential['id'], 'superseded');
append_asset_update(['id' => $credential['id'], 'status' => 'superseded', 'reason' => 'superseded', 'newCredential' => $newCredential]);

send_json(200, ['newCredential' => $newCredential]);
