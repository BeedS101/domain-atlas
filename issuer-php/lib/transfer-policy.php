<?php
// Transfer and delivery policy, evaluated before any custody change.
// Mirrors issuer-server/lib-transfer-policy.js decision for decision; the
// two are checked against the same vectors (test/vectors/transfer-policy.json).
//
// Pure functions over plain data: the caller gathers the facts (revoked,
// suspended, expired, signature, bearer-registry membership) and these
// decide. See the Node file's header for the vocabulary (operations,
// transports, authorization models, class `transfer` policy).

const ATLAS_TRANSFER_MESSAGES = [
  'holder-send' => [
    'not-an-asset' => 'not an asset credential',
    'wrong-owner' => 'asset does not belong to this signer',
    'wrong-class' => 'asset is the wrong class',
    'bound' => 'asset is bound to its owner and cannot be sent to anyone else',
    'fungible' => 'asset class is fungible — this endpoint only transfers a unique item',
    'revoked' => 'asset already revoked',
    'suspended' => 'asset is currently suspended pending review',
    'expired' => 'asset has expired',
    'bad-signature' => 'asset signature does not check out',
  ],
  'bearer-claim:identity' => [
    'not-an-asset' => 'not an asset credential',
    'bad-signature' => 'asset signature does not check out',
  ],
  'bearer-claim:state' => [
    'revoked' => 'this file has already been claimed or withdrawn',
    'suspended' => 'this asset is currently suspended pending review',
    'expired' => 'asset has expired',
    'fungible' => 'only a unique item can be claimed from a file',
    'bound' => 'asset is bound and cannot be claimed from a file',
    'not-bearer' => 'this is not a transfer file issued by this domain',
  ],
];
const ATLAS_CLAIM_CODES = [
  'not-an-asset' => 'not-claimable',
  'bad-signature' => 'not-claimable',
  'revoked' => 'already-claimed',
  'suspended' => 'suspended',
  'expired' => 'expired',
  'fungible' => 'not-claimable',
  'bound' => 'not-claimable',
  'not-bearer' => 'not-claimable',
];

function atlas_policy_fail($profile, $code, $extra = []) {
  $table = ATLAS_TRANSFER_MESSAGES[$profile] ?? [];
  $out = ['ok' => false, 'code' => $code, 'message' => $table[$code] ?? $code];
  if (strpos($profile, 'bearer-claim') === 0 && isset(ATLAS_CLAIM_CODES[$code])) $out['wireCode'] = ATLAS_CLAIM_CODES[$code];
  return array_merge($out, $extra);
}

function atlas_is_asset_credential($credential) {
  return is_array($credential) && ($credential['credential'] ?? null) === 'domain-atlas-asset/1.0';
}

// Class policy can only narrow. Returns null when allowed, else a message.
function atlas_class_policy_problem($classPolicy, $operation, $transport) {
  if (!is_array($classPolicy)) return null;
  if (isset($classPolicy['operations']) && is_array($classPolicy['operations']) && !in_array($operation, $classPolicy['operations'], true)) {
    return 'this asset class does not permit ' . $operation;
  }
  if (isset($classPolicy['transports']) && is_array($classPolicy['transports']) && !in_array($transport, $classPolicy['transports'], true)) {
    return 'this asset class does not permit delivery by ' . $transport;
  }
  return null;
}

// $input: profile, credential, expectedOwner?, expectedClass?,
// facts{revoked,suspended,expired,signatureValid,listedBearer},
// classPolicy?, operation?, transport?
function atlas_evaluate_transfer_policy($input) {
  $profile = $input['profile'];
  $credential = $input['credential'] ?? null;
  $facts = $input['facts'] ?? [];
  $asset = (is_array($credential) && isset($credential['asset']) && is_array($credential['asset'])) ? $credential['asset'] : null;
  $f = function ($k) use ($facts) { return !empty($facts[$k]); };

  if ($profile === 'holder-send') {
    if (!atlas_is_asset_credential($credential)) return atlas_policy_fail($profile, 'not-an-asset');
    if (!isset($credential['owner']['publicKey']) || $credential['owner']['publicKey'] !== ($input['expectedOwner'] ?? null)) return atlas_policy_fail($profile, 'wrong-owner');
    if ($asset === null || !isset($asset['class']) || $asset['class'] !== ($input['expectedClass'] ?? null)) return atlas_policy_fail($profile, 'wrong-class');
    if (isset($asset['tradeScope']) && $asset['tradeScope'] === 'bound') return atlas_policy_fail($profile, 'bound');
    if (!isset($asset['fungible']) || $asset['fungible'] !== false) return atlas_policy_fail($profile, 'fungible');
    if ($f('revoked')) return atlas_policy_fail($profile, 'revoked');
    if ($f('suspended')) return atlas_policy_fail($profile, 'suspended');
    if ($f('expired')) return atlas_policy_fail($profile, 'expired');
    if (!$f('signatureValid')) return atlas_policy_fail($profile, 'bad-signature');
    $problem = atlas_class_policy_problem($input['classPolicy'] ?? null, $input['operation'] ?? 'transfer', $input['transport'] ?? 'wallet');
    if ($problem !== null) return ['ok' => false, 'code' => 'class-policy', 'message' => $problem];
    return ['ok' => true];
  }

  if ($profile === 'bearer-claim:identity') {
    if (!atlas_is_asset_credential($credential) || $asset === null) return atlas_policy_fail($profile, 'not-an-asset');
    if (!$f('signatureValid')) return atlas_policy_fail($profile, 'bad-signature');
    return ['ok' => true];
  }

  if ($profile === 'bearer-claim:state') {
    if ($f('revoked')) return atlas_policy_fail($profile, 'revoked');
    if ($f('suspended')) return atlas_policy_fail($profile, 'suspended');
    if ($f('expired')) return atlas_policy_fail($profile, 'expired');
    if ($asset === null || !isset($asset['fungible']) || $asset['fungible'] !== false) return atlas_policy_fail($profile, 'fungible');
    if (isset($asset['tradeScope']) && $asset['tradeScope'] === 'bound') return atlas_policy_fail($profile, 'bound');
    if (!$f('listedBearer')) return atlas_policy_fail($profile, 'not-bearer');
    $problem = atlas_class_policy_problem($input['classPolicy'] ?? null, $input['operation'] ?? 'transfer', $input['transport'] ?? 'file');
    if ($problem !== null) return ['ok' => false, 'code' => 'class-policy', 'message' => $problem, 'wireCode' => 'not-claimable'];
    return ['ok' => true];
  }

  throw new Exception('unknown transfer policy profile: ' . $profile);
}

// $input: transport, stage ('enabled'|'actor'), config{fileTransfer:null|{classes:null|[..]},
// emailConfigured}, actor{isAdmin}, assetClass
function atlas_evaluate_delivery_gate($input) {
  $transport = $input['transport'];
  $stage = $input['stage'];
  $config = $input['config'] ?? [];
  $actor = $input['actor'] ?? [];
  $assetClass = $input['assetClass'] ?? null;
  if ($stage === 'enabled') {
    if ($transport === 'file') {
      if (($config['fileTransfer'] ?? null) === null) return ['ok' => false, 'code' => 'not-enabled', 'message' => 'this domain has not enabled file transfers (SPEC.md §13.5)'];
      return ['ok' => true];
    }
    if ($transport === 'email') {
      if (empty($config['emailConfigured'])) return ['ok' => false, 'code' => 'not-configured', 'message' => 'this domain has not configured email-delivered tickets (SPEC.md §13)'];
      return ['ok' => true];
    }
    return ['ok' => true];
  }
  if ($stage === 'class') {
    $ft = $config['fileTransfer'] ?? null;
    if ($transport === 'file' && is_array($ft) && isset($ft['classes']) && is_array($ft['classes']) && !in_array($assetClass, $ft['classes'], true)) {
      return ['ok' => false, 'code' => 'class-not-allowed', 'message' => 'this domain does not allow ' . $assetClass . ' to be exported to a file'];
    }
    return ['ok' => true];
  }
  if ($stage === 'actor') {
    if ($transport === 'email' && empty($actor['isAdmin'])) {
      return ['ok' => false, 'code' => 'not-admin', 'status' => 403, 'message' => 'only a domain admin can send a ticket to an email address'];
    }
    return ['ok' => true];
  }
  throw new Exception('unknown delivery gate stage: ' . $stage);
}

// Catalog-level eligibility for minting straight into a bearer delivery.
function atlas_evaluate_mint_for_delivery($input) {
  $entry = $input['catalogEntry'];
  if (!empty($entry['fungible'])) return ['ok' => false, 'code' => 'fungible', 'message' => 'only a unique (non-fungible) item can be sent as an email ticket'];
  if (($entry['tradeScope'] ?? null) === 'bound') return ['ok' => false, 'code' => 'bound', 'message' => 'a bound item cannot be sent as an email ticket'];
  $problem = atlas_class_policy_problem($entry['transfer'] ?? null, 'transfer', $input['transport'] ?? 'email');
  if ($problem !== null) return ['ok' => false, 'code' => 'class-policy', 'message' => $problem];
  return ['ok' => true];
}

// Facts for a well-formed credential, gathered from this issuer's own state.
function atlas_gather_transfer_facts($publicKeyB64url, $credential) {
  $wellFormed = is_array($credential) && ($credential['credential'] ?? null) === 'domain-atlas-asset/1.0' && isset($credential['asset']) && is_array($credential['asset']) && !empty($credential['id']);
  if (!$wellFormed) return ['revoked' => false, 'suspended' => false, 'expired' => false, 'signatureValid' => false, 'listedBearer' => false];
  $sig = false;
  try { $sig = (bool) verify_own_credential_signature($publicKeyB64url, $credential, asset_payload_of($credential)); } catch (Throwable $e) { $sig = false; }
  return [
    'revoked' => (bool) is_revoked($credential['id']),
    'suspended' => (bool) is_suspended($credential['id']),
    'expired' => (bool) is_expired($credential),
    'signatureValid' => $sig,
    'listedBearer' => (bool) has_bearer($credential['id']),
  ];
}

function atlas_class_transfer_policy($assetClass) {
  if (!is_string($assetClass) || !isset(ATLAS_ASSET_CATALOG[$assetClass])) return null;
  return ATLAS_ASSET_CATALOG[$assetClass]['transfer'] ?? null;
}
