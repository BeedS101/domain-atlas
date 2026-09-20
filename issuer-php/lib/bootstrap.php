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

// Every response here is either a write's result or a read of state that
// can change from one request to the next (world drops being the sharpest
// case: a client POSTs a drop, then immediately GETs the list back and
// needs to see it right away) — never something safe for a shared cache
// to reuse. Bare PHP scripts send no cache header of their own by default,
// which most bare dev setups treat as "don't cache", but a real deployed
// domain sitting behind a CDN/reverse proxy/optimization plugin (unlike
// this project's own php -S test servers, which have no such layer) can
// and does cache an uncontrolled GET differently — exactly what made a
// world drop that genuinely succeeded server-side look like it vanished
// into thin air client-side. Explicit beats implicit here.
function no_store_headers() {
  header('Cache-Control: no-store, no-cache, must-revalidate');
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
    no_store_headers();
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
      no_store_headers();
    }
    echo json_encode(['error' => $err['message'] . ' in ' . basename($err['file']) . ':' . $err['line']]);
  }
});

function send_json($status, $obj) {
  http_response_code($status);
  header('Content-Type: application/json');
  cors_headers();
  no_store_headers();
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

  // Task #250 fourth follow-up: a catalog entry's own 'randomizeProperties'
  // callable (see atlas.wearable.ring in store.php, and random_ring_
  // properties()'s own comment there for the full reasoning) gets one
  // chance to override the class's static 'properties', same "genuinely
  // new supply only" gate as the serial/cap reservation just above — a
  // reissue's own explicit 'properties' patch is a completely separate
  // mechanism (handled entirely by atlas/asset/reissue.php) and must never
  // get re-rolled by this. Mirrors issuer-server/server.js's
  // mintAssetByClass().
  if ($supersedes === null && isset($catalogEntry['randomizeProperties']) && is_callable($catalogEntry['randomizeProperties'])) {
    $randomized = call_user_func($catalogEntry['randomizeProperties']);
    $asset['properties'] = array_merge(isset($asset['properties']) ? $asset['properties'] : [], $randomized);
  }

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
  // Task #250 fourth follow-up: "or trade" dropped from this message — a
  // non-fungible asset CAN now be traded at the Trading Station, just not
  // through THIS check (see check_presented_unique_asset() below, used by
  // atlas/trade/submit.php and atlas/trade/claim.php instead whenever the
  // presented balance's own fungible flag says false).
  if (!isset($credential['asset']['fungible']) || $credential['asset']['fungible'] !== true) {
    return 'asset class is not fungible — cannot split or consolidate a unique asset';
  }
  if (!isset($credential['quantity']) || $credential['quantity'] < $minQuantity) return 'asset has insufficient quantity';
  if (is_revoked($credential['id'])) return 'asset already revoked';
  $ok = verify_own_credential_signature($publicKeyB64url, $credential, asset_payload_of($credential));
  if (!$ok) return 'asset signature does not check out';
  return null;
}

// Task #250 fourth follow-up (Bruno's own request) — check_presented_asset's
// mirror for the OTHER half of SPEC.md §5.1's fungible/non-fungible split:
// same ownership/class/tradeScope/revocation/signature checks, but requires
// fungible === false instead of true, and there is no minQuantity to check
// at all — a non-fungible credential's quantity is definitionally 1
// (SPEC.md §5.1). Mirrors issuer-server/server.js's
// checkPresentedUniqueAsset(). Lets a unique item like the Signet Ring be
// offered/claimed at the Trading Station — see atlas/trade/submit.php and
// atlas/trade/claim.php, and transfer_unique_asset() for how the actual
// instance (not a fresh catalog-derived stand-in) is what changes hands.
function check_presented_unique_asset($publicKeyB64url, $credential, $expectedOwner, $expectedClass) {
  if (!is_array($credential) || !isset($credential['credential']) || $credential['credential'] !== 'domain-atlas-asset/1.0') {
    return 'not an asset credential';
  }
  if (!isset($credential['owner']['publicKey']) || $credential['owner']['publicKey'] !== $expectedOwner) {
    return 'asset does not belong to this signer';
  }
  if (!isset($credential['asset']['class']) || $credential['asset']['class'] !== $expectedClass) {
    return 'asset is the wrong class';
  }
  if (isset($credential['asset']['tradeScope']) && $credential['asset']['tradeScope'] === 'bound') {
    return 'asset is bound to its owner and cannot be traded';
  }
  if (!isset($credential['asset']['fungible']) || $credential['asset']['fungible'] !== false) {
    return 'asset class is fungible — present it as a quantity balance, not a unique item';
  }
  if (is_revoked($credential['id'])) return 'asset already revoked';
  $ok = verify_own_credential_signature($publicKeyB64url, $credential, asset_payload_of($credential));
  if (!$ok) return 'asset signature does not check out';
  return null;
}

// Task #250 fourth follow-up — transfers a non-fungible credential to a new
// owner while preserving its exact per-instance asset state (serial,
// editionSize, a Signet Ring's randomly-rolled enchantments/stats) rather
// than rebuilding it fresh from ATLAS_ASSET_CATALOG the way
// mint_asset_by_class() does. Mirrors issuer-server/server.js's
// transferUniqueAsset() — see its own comment for the World Drops bug this
// also fixes (a serialized item was nominally droppable in the plaza's own
// acceptedItemClasses before this, so re-deriving it fresh on claim was a
// live gap, not just theoretical).
function transfer_unique_asset($privateKey, $publicKeyB64url, $newOwnerPublicKey, $credential) {
  return issue_asset($privateKey, $publicKeyB64url, $newOwnerPublicKey, $credential['asset'], $credential['quantity'], $credential['id']);
}

// Task #250 fourth follow-up — validates a trade intent's one side
// ({class, quantity}) shape: class must be a known string, quantity a
// positive integer, and — the actual new-this-follow-up rule — a class
// ATLAS_ASSET_CATALOG marks fungible => false must be offered/wanted in
// quantity exactly 1, since there is no partial share of a unique item to
// negotiate. Mirrors issuer-server/server.js's validateTradeSideShape().
function validate_trade_side_shape($side, $label) {
  if (!is_array($side) || !isset($side['class']) || !is_string($side['class']) || $side['class'] === '') {
    return $label . ': class is required';
  }
  if (!isset($side['quantity']) || !is_int($side['quantity']) || $side['quantity'] < 1) {
    return $label . ': quantity must be a positive integer';
  }
  $catalogEntry = isset(ATLAS_ASSET_CATALOG[$side['class']]) ? ATLAS_ASSET_CATALOG[$side['class']] : null;
  if ($catalogEntry !== null && isset($catalogEntry['fungible']) && $catalogEntry['fungible'] === false && $side['quantity'] !== 1) {
    return $label . ': ' . $side['class'] . ' is not fungible — quantity must be 1';
  }
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

// Task #250 — dropping is the FIRST case in this bundle where a server has
// to validate a credential it did NOT itself issue: a wearable minted by
// domain A, carried into and dropped in domain B's plaza, is fully
// supported (SPEC.md §5.5), and domain B obviously doesn't hold domain A's
// private key to check it the fast, local way. Mirrors exactly what
// extension/wallet.js's own verifyCredential() already does client-side for
// any credential from a domain other than "self" — fetch THAT domain's own
// published key + revocation ledger (never trust credential.issuer.publicKey
// blindly — it isn't part of the signed payload, see asset_payload_of()
// above, so nothing stops someone stamping a fake issuer.publicKey onto an
// otherwise-unrelated signature), confirm a key matching it was valid at
// credential.issuedAt, verify the signature against THAT key, then check
// THAT domain's own revocation list — never this server's own is_revoked(),
// which only knows about ids this server itself minted. Mirrors
// issuer-server/server.js's verifyForeignAssetCredential().
function verify_foreign_asset_credential($credential) {
  try {
    $issuerDomain = $credential['issuer']['domain'];
    $context = stream_context_create(['http' => ['method' => 'GET', 'ignore_errors' => true, 'timeout' => 10]]);
    $keyRaw = @file_get_contents(atlas_base_url($issuerDomain) . '/.well-known/atlas-key.json', false, $context);
    if ($keyRaw === false) return false;
    $keyDoc = json_decode($keyRaw, true);
    if (!is_array($keyDoc) || empty($keyDoc['keys'])) return false;
    $revRaw = @file_get_contents(atlas_base_url($issuerDomain) . '/.well-known/atlas-revocations.json', false, $context);
    $revDoc = $revRaw !== false ? json_decode($revRaw, true) : null;
    $revoked = is_array($revDoc) && isset($revDoc['revoked']) ? $revDoc['revoked'] : [];

    $issuedAt = strtotime($credential['issuedAt']);
    $activeKey = null;
    foreach ($keyDoc['keys'] as $k) {
      if (($k['publicKey'] ?? null) !== ($credential['issuer']['publicKey'] ?? null)) continue;
      $from = strtotime($k['validFrom']);
      $until = !empty($k['validUntil']) ? strtotime($k['validUntil']) : PHP_INT_MAX;
      if ($issuedAt >= $from && $issuedAt <= $until) { $activeKey = $k; break; }
    }
    if ($activeKey === null) return false;

    $sigOk = verify_domain_signature($activeKey['publicKey'], asset_payload_of($credential), $credential['signature']);
    if (!$sigOk) return false;

    foreach ($revoked as $r) {
      if (($r['id'] ?? null) === $credential['id']) return false;
    }
    return true;
  } catch (Exception $e) {
    return false;
  }
}

// Task #250 (World Drops, SPEC.md §5.5): a third sibling to
// check_presented_asset()/check_presented_membership() above, for the one
// case neither fits — presenting a credential to DROP it, which unlike
// split/consolidate/trade is equally valid for a fungible stack or a
// one-of-one wearable (check_presented_asset()'s fungible-must-be-true and
// minQuantity checks would wrongly reject the latter), and unlike a
// membership presentation, still has to exclude 'bound' assets — a
// subscription card is exactly the kind of thing that must NOT become
// droppable-and-takeable by a stranger. No quantity check at all: the
// client is responsible for calling POST /atlas/asset/split first if it
// wants to drop less than a fungible stack's full amount (see wallet.js's
// splitForDrop/dropItem) — by the time a credential reaches this check,
// whatever quantity it carries is the whole of what's being dropped. Also
// unlike check_presented_asset()/check_presented_membership() (which only
// ever run against credentials THIS domain itself issued, since split/
// consolidate/trade/membership can only ever apply to a domain's own
// credentials): branches on credential.issuer.domain, since a drop's
// credential may well have come from somewhere else entirely — see
// verify_foreign_asset_credential() just above. Mirrors issuer-server/
// server.js's checkPresentedTransferableAsset().
function check_presented_transferable_asset($publicKeyB64url, $credential, $expectedOwner, $expectedClass) {
  if (!is_array($credential) || !isset($credential['credential']) || $credential['credential'] !== 'domain-atlas-asset/1.0') {
    return 'not an asset credential';
  }
  if (!isset($credential['owner']['publicKey']) || $credential['owner']['publicKey'] !== $expectedOwner) {
    return 'asset does not belong to this signer';
  }
  if (!isset($credential['asset']['class']) || $credential['asset']['class'] !== $expectedClass) {
    return 'asset is the wrong class';
  }
  if (isset($credential['asset']['tradeScope']) && $credential['asset']['tradeScope'] === 'bound') {
    return 'asset is bound to its owner and cannot be dropped for someone else to take';
  }
  if (empty($credential['issuer']['domain'])) return 'asset has no issuer domain';
  if ($credential['issuer']['domain'] === atlas_domain()) {
    if (is_revoked($credential['id'])) return 'asset already revoked';
    $ok = verify_own_credential_signature($publicKeyB64url, $credential, asset_payload_of($credential));
    if (!$ok) return 'asset signature does not check out';
    return null;
  }
  $foreignOk = verify_foreign_asset_credential($credential);
  if (!$foreignOk) return 'could not verify this asset against its issuer (' . $credential['issuer']['domain'] . ')';
  return null;
}

// Shared by both the same-domain claim path (atlas/world/drops/claim.php)
// and the cross-domain relay-claim handler
// (atlas/world/drops/relay-claim.php) — the real ownership-transfer
// primitive this whole protocol always uses (revoke the old credential,
// mint a fresh one naming the new owner), same as trade settlement/split/
// consolidate. Mirrors issuer-server/server.js's fulfillWorldDropClaim().
//
// Fungible drops still go through mint_asset_by_class() — re-deriving from
// the catalog is correct there (every balance of a fungible class is
// identical by definition). A non-fungible drop instead goes through
// transfer_unique_asset() (task #250 fourth follow-up) so its actual
// per-instance state survives the claim — see that function's own comment
// for the bug this fixes.
function fulfill_world_drop_claim($kp, $credential, $claimantPublicKey) {
  if (isset($credential['asset']['fungible']) && $credential['asset']['fungible'] === false) {
    $received = transfer_unique_asset($kp['privateKey'], $kp['publicKeyB64url'], $claimantPublicKey, $credential);
  } else {
    $received = mint_asset_by_class($kp['privateKey'], $kp['publicKeyB64url'], $claimantPublicKey, $credential['asset']['class'], $credential['quantity'], $credential['id']);
  }
  atlas_revoke($credential['id'], 'claimed from a world drop');
  return $received;
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
