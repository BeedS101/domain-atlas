<?php
// Domain Atlas — PHP issuer: shared request handling + the same signing/
// verification logic issuer-server/server.js has, ported function-for-
// function. Each file under atlas/ requires this, then does its own small
// bit of route-specific work — there's no framework here on purpose, to
// keep this readable and auditable on a shared host where you can't
// composer-install anything.

require_once __DIR__ . '/crypto.php';
require_once __DIR__ . '/store.php';

function cors_headers() {
  header('Access-Control-Allow-Origin: *');
  header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
  header('Access-Control-Allow-Headers: Content-Type');
}

// Turn any uncaught exception or PHP fatal error into a JSON error response
// instead of a blank body. Most production hosting has display_errors off,
// so without this, any bug here (a missing PHP extension, a permissions
// problem, a version incompatibility) shows up in the extension as
// "Issuer refused: " with nothing after the colon — impossible to diagnose
// from the browser side. With this, the real reason comes back instead.
set_exception_handler(function ($e) {
  // Task #42: an exception thrown with a specific HTTP status in mind
  // (e.g. mint_asset_by_class()'s 400 "sold out" case) carries it via the
  // Exception's own $code — getCode() is 0 when nothing set one
  // explicitly, so that falls back to 500 same as before. Mirrors
  // issuer-server/server.js's `err.statusCode || 500`.
  if (!headers_sent()) {
    http_response_code($e->getCode() ?: 500);
    header('Content-Type: application/json');
    cors_headers();
  }
  echo json_encode(['error' => $e->getMessage()]);
  exit;
});
register_shutdown_function(function () {
  $err = error_get_last();
  if ($err && in_array($err['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true)) {
    if (!headers_sent()) {
      http_response_code(500);
      header('Content-Type: application/json');
      cors_headers();
    }
    echo json_encode(['error' => $err['message'] . ' in ' . basename($err['file']) . ':' . $err['line']]);
  }
});

function send_json($status, $obj) {
  http_response_code($status);
  header('Content-Type: application/json');
  cors_headers();
  echo json_encode($obj, JSON_UNESCAPED_SLASHES);
  exit;
}

// Call this FIRST in every endpoint file, before require_post() — browsers
// send a real OPTIONS preflight ahead of the POST (cross-origin + JSON
// content-type triggers it), and it must succeed even though the real
// route only accepts POST.
function handle_preflight() {
  if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    cors_headers();
    exit;
  }
}

function require_post() {
  if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    cors_headers();
    echo 'Method not allowed';
    exit;
  }
}

// v1.14 (SPEC.md §7) — GET /atlas/trade/listings is this bundle's first
// read-only endpoint; no preflight needed ahead of it (a plain GET never
// triggers a CORS preflight the way a JSON POST does), just this guard.
function require_get() {
  if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    http_response_code(405);
    cors_headers();
    echo 'Method not allowed';
    exit;
  }
}

function read_json_body() {
  $raw = file_get_contents('php://input');
  if ($raw === '' || $raw === false) return [];
  $data = json_decode($raw, true);
  if (!is_array($data)) throw new Exception('invalid JSON body');
  return $data;
}

// Loads (or generates, on first request ever) the issuer keypair and makes
// sure .well-known/atlas-key.json + atlas-revocations.json exist. Runs on
// every request — PHP has no long-lived process to do this once at boot
// the way the Node version does — but parsing a small EC PEM key costs
// microseconds, so this is not worth avoiding at demo/small-site scale.
function atlas_load_keys() {
  $kp = load_or_create_keypair();
  ensure_well_known_files($kp['publicKeyB64url']);
  return $kp;
}

function atlas_is_positive_int($v) {
  if (is_int($v)) return $v > 0;
  if (is_float($v)) return $v == (int) $v && $v > 0;
  return false;
}

function atlas_uuid() {
  $data = random_bytes(16);
  $data[6] = chr((ord($data[6]) & 0x0f) | 0x40);
  $data[8] = chr((ord($data[8]) & 0x3f) | 0x80);
  $hex = bin2hex($data);
  return substr($hex, 0, 8) . '-' . substr($hex, 8, 4) . '-' . substr($hex, 12, 4) . '-' . substr($hex, 16, 4) . '-' . substr($hex, 20, 12);
}

function iso_now() {
  $mt = microtime(true);
  $ms = sprintf('%03d', round(($mt - floor($mt)) * 1000));
  return gmdate('Y-m-d\TH:i:s', (int) $mt) . '.' . $ms . 'Z';
}

// ---------- signing ----------

function atlas_sign($privateKey, $payload) {
  $data = canonicalize($payload);
  $rawSig = ecdsa_sign_raw($privateKey, $data);
  return b64url_encode($rawSig);
}

// Verifies a signed-payload "envelope" as produced by wallet.js's
// signWithSelf() (a real WebAuthn assertion, challenge = hash of the
// payload) or signWithCounterparty() (a direct ECDSA signature). Same
// dual-mode check server.js does, and the same canonicalize().
function verify_envelope($payload, $envelope) {
  if (!is_array($payload) || !is_array($envelope) || !isset($envelope['signerRole'])) return false;
  $dataHash = sha256_raw(canonicalize($payload));

  if ($envelope['signerRole'] === 'webauthn') {
    try {
      $clientDataJSON = b64url_decode($envelope['clientDataJSON']);
      $clientData = json_decode($clientDataJSON, true);
      if (!is_array($clientData) || !isset($clientData['challenge'])) return false;
      if ($clientData['challenge'] !== b64url_encode($dataHash)) return false;
      $authData = b64url_decode($envelope['authenticatorData']);
      $clientDataHash = sha256_raw($clientDataJSON);
      $signedData = $authData . $clientDataHash;
      // WebAuthn assertion signatures arrive DER-encoded already — unlike
      // the Node version, we don't need to convert to raw, because
      // openssl_verify() wants DER natively. (Node converts to raw because
      // Web Crypto's verify() insists on raw — PHP has the easier end of this one.)
      $derSig = b64url_decode($envelope['signature']);
      $pubPem = spki_der_to_pem(b64url_decode($envelope['publicKey']));
      return ecdsa_verify_der($pubPem, $derSig, $signedData);
    } catch (Exception $e) {
      return false;
    }
  }

  if ($envelope['signerRole'] === 'raw-ecdsa') {
    try {
      $pubPem = ec_raw_point_to_pem(b64url_decode($envelope['publicKey']));
      $data = canonicalize($payload);
      $rawSig = b64url_decode($envelope['signature']);
      return ecdsa_verify_raw($pubPem, $rawSig, $data);
    } catch (Exception $e) {
      return false;
    }
  }

  return false;
}

// Verifies an asset credential this issuer itself signed — used before
// trusting a balance presented back to us for a reissue, split,
// consolidate, or trade.
function verify_own_credential_signature($publicKeyB64url, $credential, $payload) {
  try {
    $pubPem = ec_raw_point_to_pem(b64url_decode($publicKeyB64url));
    $data = canonicalize($payload);
    $rawSig = b64url_decode($credential['signature']);
    return ecdsa_verify_raw($pubPem, $rawSig, $data);
  } catch (Exception $e) {
    return false;
  }
}

// ---------- Task #97 (SPEC.md §11.4, domain-to-domain federation) ----------
//
// This bundle has never before needed to make an OUTBOUND request to
// another domain — every other cross-domain trust check in this protocol
// has always been the CLIENT's job (extension/wallet.js's own
// verifyCredential()). Federation's relay step is the first time a SERVER
// itself needs to. No HTTP client library exists anywhere in this
// dependency-free bundle, so this uses plain file_get_contents() against an
// http(s):// stream wrapper (allow_url_fopen, on by default) rather than
// requiring the curl extension — 'ignore_errors' => true is what lets a
// non-2xx response's JSON body still be read instead of file_get_contents()
// just returning false, same as issuer-server/server.js's own fetch() calls
// read the body on a rejection.

// Same http(s)-scheme-by-hostname convention issuer-server/server.js's own
// baseUrl() and extension/wallet.js's own baseUrl() already use — kept in
// sync on purpose, a mismatch here would mean this domain tries to relay to
// or verify another domain over the wrong scheme.
function atlas_base_url($domain) {
  if (strpos($domain, 'http') === 0) return rtrim($domain, '/');
  $isLocalHost = preg_match('/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/', $domain);
  return rtrim(($isLocalHost ? 'http://' : 'https://') . $domain, '/');
}

// POSTs JSON to another domain and returns its status + decoded body
// regardless of whether that status was 2xx — a relay attempt needs to see
// WHY the home domain rejected something, not just that it did.
function atlas_http_post_json($url, $body) {
  $context = stream_context_create([
    'http' => [
      'method' => 'POST',
      'header' => "Content-Type: application/json\r\n",
      'content' => json_encode($body),
      'ignore_errors' => true,
      'timeout' => 10,
    ],
  ]);
  $raw = @file_get_contents($url, false, $context);
  if ($raw === false) throw new Exception('could not reach ' . $url);
  $status = 0;
  if (isset($http_response_header)) {
    foreach ($http_response_header as $header) {
      if (preg_match('#^HTTP/\S+\s+(\d+)#', $header, $m)) { $status = (int) $m[1]; break; }
    }
  }
  $decoded = json_decode($raw, true);
  return ['status' => $status, 'body' => is_array($decoded) ? $decoded : []];
}

// Task #97 (SPEC.md §11.4 step 3): fetches another domain's own published
// signing key — the exact same cross-domain trust bootstrap
// verifyCredential() in extension/wallet.js already performs client-side
// (§5 step 1), mirrored here since this is now a server-to-server check
// too. Picks whichever published key is valid RIGHT NOW (an attestation is
// checked at the moment it arrives, not against some earlier issuedAt),
// same as issuer-server/server.js's fetchDomainPublicKey().
function fetch_domain_public_key($domain) {
  $context = stream_context_create(['http' => ['method' => 'GET', 'ignore_errors' => true, 'timeout' => 10]]);
  $raw = @file_get_contents(atlas_base_url($domain) . '/.well-known/atlas-key.json', false, $context);
  if ($raw === false) throw new Exception('could not fetch ' . $domain . '\'s published key');
  $keyDoc = json_decode($raw, true);
  if (!is_array($keyDoc) || empty($keyDoc['keys'])) throw new Exception($domain . ' returned no usable key document');
  $now = time();
  foreach ($keyDoc['keys'] as $k) {
    $from = strtotime($k['validFrom']);
    $until = (!empty($k['validUntil'])) ? strtotime($k['validUntil']) : PHP_INT_MAX;
    if ($now >= $from && $now <= $until) return $k['publicKey'];
  }
  throw new Exception($domain . ' has no currently-valid published key');
}

// Task #97 (SPEC.md §11.4 step 3): verifies a relaying domain's own
// attestation against a public key already fetched via
// fetch_domain_public_key() above — the raw-ecdsa half of verify_envelope(),
// but checked against an externally-supplied domain key rather than a key
// pulled out of the envelope itself. Mirrors issuer-server/server.js's
// verifyDomainSignature().
function verify_domain_signature($publicKeyB64url, $payload, $signatureB64url) {
  try {
    $pubPem = ec_raw_point_to_pem(b64url_decode($publicKeyB64url));
    $data = canonicalize($payload);
    $rawSig = b64url_decode($signatureB64url);
    return ecdsa_verify_raw($pubPem, $rawSig, $data);
  } catch (Exception $e) {
    return false;
  }
}

// The signed payload shape (SPEC.md §5: canonicalize({id, asset, owner,
// quantity, supersedes, issuedAt})) — used both to re-verify a presented
// credential's signature (before honoring a reissue/split/consolidate/
// trade request against it) and, via issue_asset() below, to build the
// payload a fresh signature covers. Mirrors issuer-server/server.js's
// assetPayloadOf().
function asset_payload_of($credential) {
  return [
    'id' => $credential['id'], 'asset' => $credential['asset'], 'owner' => $credential['owner'],
    'quantity' => $credential['quantity'], 'supersedes' => $credential['supersedes'], 'issuedAt' => $credential['issuedAt'],
  ];
}

// The one issuance path for every asset credential this bundle signs —
// unique (fungible: false, quantity always 1) and fungible (quantity any
// positive integer) alike (SPEC.md §5). Shared by atlas/asset/issue.php
// (supersedes always null — a first minting), atlas/asset/reissue.php
// (supersedes names the id being replaced, non-fungible only), and the
// split/consolidate/trade endpoints (supersedes names one or more ids
// being replaced, fungible only). Keeping one signing path for all of
// them is what guarantees they can never drift out of sync on the
// payload shape the way independent inline arrays eventually would —
// mirrors issuer-server/server.js's issueAsset().
function issue_asset($privateKey, $publicKeyB64url, $ownerPublicKey, $asset, $quantity, $supersedes) {
  $payload = [
    'id' => 'urn:atlas:asset:' . atlas_uuid(),
    'asset' => $asset,
    'owner' => ['publicKey' => $ownerPublicKey],
    'quantity' => $quantity,
    'supersedes' => $supersedes,
    'issuedAt' => iso_now(),
  ];
  $signature = atlas_sign($privateKey, $payload);
  return array_merge(
    ['credential' => 'domain-atlas-asset/1.0'],
    $payload,
    ['issuer' => ['domain' => atlas_domain(), 'publicKey' => $publicKeyB64url], 'signature' => $signature]
  );
}

// Builds `asset` fresh from ATLAS_ASSET_CATALOG (via
// atlas_asset_catalog_entry() in store.php) and signs it via issue_asset()
// above — the "looked up fresh on every mint/split/consolidate/trade,
// never copied from an old balance" discipline SPEC.md §5 requires for
// `fungible`/`presentation`/`properties`. Used by every endpoint that
// mints a NEW balance of an existing class (issue, split, consolidate,
// trade); reissue is the one exception — it patches an existing
// credential's own `asset` snapshot instead, since a non-fungible asset's
// properties are deliberately per-instance rather than per-class
// (SPEC.md §5.1.1). Mirrors issuer-server/server.js's mintAssetByClass().
function mint_asset_by_class($privateKey, $publicKeyB64url, $ownerPublicKey, $cls, $quantity, $supersedes) {
  if (!isset(ATLAS_ASSET_CATALOG[$cls])) throw new Exception('unknown asset class: ' . $cls);
  $catalogEntry = ATLAS_ASSET_CATALOG[$cls];

  // Task #42: cap/serial tracking only applies to genuinely NEW supply
  // ($supersedes === null — see reserve_supply()'s comment in store.php),
  // and only when this class opted in via 'serialized' and/or 'maxSupply'.
  // A split/consolidate/trade re-mint always passes a non-null
  // $supersedes, so it skips this entirely.
  $serial = null;
  $serialized = !empty($catalogEntry['serialized']);
  $maxSupply = isset($catalogEntry['maxSupply']) ? $catalogEntry['maxSupply'] : null;
  if ($supersedes === null && ($serialized || $maxSupply !== null)) {
    $reservation = reserve_supply($cls, $quantity, $maxSupply);
    if (!$reservation['ok']) {
      $err = new Exception(
        $catalogEntry['name'] . ' (' . $cls . ') is sold out: ' . $reservation['current'] . '/' . $reservation['maxSupply'] . ' already issued',
        400
      );
      throw $err;
    }
    $serial = $reservation['serial'];
  }

  $asset = atlas_asset_catalog_entry($cls);
  if ($asset === null) throw new Exception('unknown asset class: ' . $cls);
  if ($serialized) {
    $properties = isset($asset['properties']) ? $asset['properties'] : [];
    $properties['atlas.serial'] = (string) $serial;
    $properties['atlas.editionSize'] = (string) $maxSupply;
    $asset['properties'] = $properties;
  }
  return issue_asset($privateKey, $publicKeyB64url, $ownerPublicKey, $asset, $quantity, $supersedes);
}

// Validates an asset credential presented back to us for a split,
// consolidate, or trade — all three of which only make sense for a
// fungible class (SPEC.md §5.4: quantity is definitionally 1 on a
// fungible:false credential, so there is nothing for this arithmetic to
// do to it). Checked directly against the credential's own SIGNED
// asset.fungible field, not re-derived from ATLAS_ASSET_CATALOG, so this
// holds even for a credential minted under a since-changed catalog entry.
// Mirrors issuer-server/server.js's checkPresentedAsset().
function check_presented_asset($publicKeyB64url, $credential, $expectedOwner, $expectedClass, $minQuantity) {
  if (!is_array($credential) || !isset($credential['credential']) || $credential['credential'] !== 'domain-atlas-asset/1.0') {
    return 'not an asset credential';
  }
  if (!isset($credential['owner']['publicKey']) || $credential['owner']['publicKey'] !== $expectedOwner) {
    return 'asset does not belong to this signer';
  }
  if (!isset($credential['asset']['class']) || $credential['asset']['class'] !== $expectedClass) {
    return 'asset is the wrong class';
  }
  // Task #160: checked ahead of the fungible rejection below so a bound
  // credential gets its own, clearer message rather than the generic
  // "not fungible" one — true for every bound class today anyway (they're
  // all fungible: false), but this is the real, deliberate reason they're
  // excluded, not a side effect of that other check. Mirrors
  // issuer-server/server.js's checkPresentedAsset().
  if (isset($credential['asset']['tradeScope']) && $credential['asset']['tradeScope'] === 'bound') {
    return 'asset is bound to its owner and cannot be split, consolidated, or traded';
  }
  if (!isset($credential['asset']['fungible']) || $credential['asset']['fungible'] !== true) {
    return 'asset class is not fungible — cannot split, consolidate, or trade a unique asset';
  }
  if (!isset($credential['quantity']) || $credential['quantity'] < $minQuantity) return 'asset has insufficient quantity';
  if (is_revoked($credential['id'])) return 'asset already revoked';
  $ok = verify_own_credential_signature($publicKeyB64url, $credential, asset_payload_of($credential));
  if (!$ok) return 'asset signature does not check out';
  return null;
}

// Task #144 Phase 1: a lighter check for a held MEMBERSHIP credential
// presented alongside a request (same shape POST /atlas/trade/submit needs
// for its "do you actually hold this domain's Trading Station card" gate)
// — deliberately NOT check_presented_asset() above, since that function's
// fungible/minQuantity checks would reject every membership class outright
// (they're all fungible: false, quantity 1). Everything else is the same
// discipline: right shape, right owner, right class, not revoked,
// signature checks out against this issuer's own key. Mirrors
// issuer-server/server.js's checkPresentedMembership().
function check_presented_membership($publicKeyB64url, $credential, $expectedOwner, $expectedClass) {
  if (!is_array($credential) || !isset($credential['credential']) || $credential['credential'] !== 'domain-atlas-asset/1.0') {
    return 'not an asset credential';
  }
  if (!isset($credential['owner']['publicKey']) || $credential['owner']['publicKey'] !== $expectedOwner) {
    return 'membership does not belong to this signer';
  }
  if (!isset($credential['asset']['class']) || $credential['asset']['class'] !== $expectedClass) {
    return 'membership is the wrong class';
  }
  if (is_revoked($credential['id'])) return 'membership already revoked';
  $ok = verify_own_credential_signature($publicKeyB64url, $credential, asset_payload_of($credential));
  if (!$ok) return 'membership signature does not check out';
  return null;
}

// Task #203: sums an owner's VERIFIED current holdings of one class, off
// whatever balance credentials the wallet chose to present alongside a
// mint request — used only by the 'holdingCap' check in
// atlas/asset/issue.php. Mirrors issuer-server/server.js's
// currentHeldQuantity() exactly, including its "nothing presented is
// trusted as 0 held" reasoning — see that function's own comment for the
// full explanation.
function current_held_quantity($publicKeyB64url, $ownerPublicKey, $cls, $presentedBalances) {
  $total = 0;
  foreach ((is_array($presentedBalances) ? $presentedBalances : []) as $cred) {
    $problem = check_presented_asset($publicKeyB64url, $cred, $ownerPublicKey, $cls, 1);
    if ($problem === null) $total += $cred['quantity'];
  }
  return $total;
}
