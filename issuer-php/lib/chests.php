<?php
if (PHP_SAPI !== 'cli' && isset($_SERVER['SCRIPT_FILENAME']) && realpath($_SERVER['SCRIPT_FILENAME']) === __FILE__) { http_response_code(404); exit; } // include-only
// Reward chests opened with a Studio key (atlas/asset/open-chest.php, atlas/chest/status.php).
//
// A chest is a catalog entry here, not a stored object: the world scene only names the chest id. Opening
// one consumes a key credential and signs the chest's reward class, once per owner key per chest. The
// "once" is recorded in a private marker file (chests/) written before the key is spent; the key's
// revocation is the commit point, so a marker whose key was never revoked (a request that died before
// committing) does not count as opened.
//
// A chest marked 'reopenWhenLost' may be opened again by the same owner (with another key): the wallet
// checks that the reward is no longer held, and the issuer revokes every reward this chest earlier signed
// to that owner, so at most one stays live. The marker keeps the ids of those rewards.

const ATLAS_CHEST_KEY_CLASS = 'atlas.demo.studio.collectible';
const ATLAS_CHEST_KEY_TEMPLATE = 'key';

const ATLAS_CHEST_CATALOG = [
  'gallery-gem' => ['name' => 'Gem Chest', 'rewardClass' => 'atlas.gem.ruby'],
  'gallery-pick' => ['name' => 'Tool Chest', 'rewardClass' => 'atlas.tool.pickaxe', 'reopenWhenLost' => true],
];

function atlas_chest_entry($chestId) {
  return is_string($chestId) && isset(ATLAS_CHEST_CATALOG[$chestId]) ? ATLAS_CHEST_CATALOG[$chestId] : null;
}

function atlas_chest_marker_dir() { return atlas_private_subdir('chests'); }
function atlas_chest_marker_file($chestId, $ownerPublicKey) {
  return atlas_chest_marker_dir() . '/' . hash('sha256', $chestId . "\n" . $ownerPublicKey) . '.json';
}

// null when there is no marker; otherwise ['requestId', 'keyId', 'openedAt', 'rewardIds' (may be missing)].
function atlas_chest_marker_read($chestId, $ownerPublicKey) {
  $file = atlas_chest_marker_file($chestId, $ownerPublicKey);
  if (!is_file($file)) return null;
  $rec = json_decode((string) @file_get_contents($file), true);
  if (!is_array($rec) || !is_string($rec['keyId'] ?? null)) {
    throw new Exception('a chest record could not be read; refusing to guess whether this chest was opened', 503);
  }
  return $rec;
}

function atlas_chest_marker_write($chestId, $ownerPublicKey, $requestId, $keyId, $rewardIds) {
  atlas_private_subdir_ensure('chests');
  $text = json_encode(['requestId' => $requestId, 'keyId' => $keyId, 'openedAt' => gmdate('Y-m-d\TH:i:s\Z'), 'rewardIds' => array_values($rewardIds)], JSON_UNESCAPED_SLASHES);
  if ($text === false) throw new Exception('could not encode the chest record', 503);
  atlas_write_file_atomic(atlas_chest_marker_file($chestId, $ownerPublicKey), $text, 0600);
}

// True when this owner key has opened this chest: a marker exists and the key it names was spent.
function atlas_chest_opened($chestId, $ownerPublicKey) {
  $rec = atlas_chest_marker_read($chestId, $ownerPublicKey);
  return $rec !== null && is_revoked($rec['keyId']);
}

// Ids of rewards this chest signed to this owner that are not revoked yet.
function atlas_chest_live_reward_ids($chestId, $ownerPublicKey) {
  $rec = atlas_chest_marker_read($chestId, $ownerPublicKey);
  $live = [];
  foreach ((is_array($rec['rewardIds'] ?? null) ? $rec['rewardIds'] : []) as $id) {
    if (is_string($id) && $id !== '' && !is_revoked($id)) $live[] = $id;
  }
  return $live;
}

// Admin recovery: forgets that this owner key opened this chest, so it can be opened again with another key.
// The reward already issued is untouched (nothing is revoked). Returns whether a record existed. The caller
// holds the chest lease.
function atlas_chest_reset($chestId, $ownerPublicKey) {
  $file = atlas_chest_marker_file($chestId, $ownerPublicKey);
  if (!is_file($file)) return false;
  if (!@unlink($file)) throw new Exception('the chest record could not be removed', 503);
  return true;
}

// Why $credential cannot open a chest for $signer, or null. The caller holds the spend lock.
function atlas_chest_key_problem($publicKeyB64url, $credential, $signer) {
  if (!is_array($credential) || ($credential['credential'] ?? null) !== 'domain-atlas-asset/1.0') return 'not an asset credential';
  if (($credential['issuer']['domain'] ?? null) !== atlas_domain()) return 'this domain did not issue this key';
  if (($credential['owner']['publicKey'] ?? null) !== $signer) return 'key does not belong to this signer';
  if (($credential['asset']['class'] ?? null) !== ATLAS_CHEST_KEY_CLASS
      || ($credential['asset']['properties']['atlas.studio.template'] ?? null) !== ATLAS_CHEST_KEY_TEMPLATE) {
    return 'this item is not a key';
  }
  if (!is_string($credential['id'] ?? null)) return 'not an asset credential';
  if (is_revoked($credential['id'])) return 'asset already revoked';
  if (is_suspended($credential['id'])) return 'asset is currently suspended pending review';
  if (is_expired($credential)) return 'this key has expired';
  if (!verify_own_credential_signature($publicKeyB64url, $credential, asset_payload_of($credential))) return 'asset signature does not check out';
  return null;
}
