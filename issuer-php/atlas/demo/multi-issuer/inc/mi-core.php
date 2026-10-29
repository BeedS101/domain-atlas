<?php
// Multi-Issuer Portable Asset Lab: issuance, ownership registry, transfers and the peer protocol.
// Network calls are never made inside a database transaction.

// ---------------------------------------------------------------- loading and the portable document

function mi_load_asset($db, $assetId) {
  $st = $db->prepare('SELECT * FROM assets WHERE asset_id = ?');
  $st->execute([$assetId]);
  $row = mi_row($st);
  if (!$row) return null;
  $row['definition'] = json_decode($row['definition_json'], true);
  return $row;
}

function mi_stored_entries($db, $table, $col, $id) {
  $st = $db->prepare('SELECT approver, decision, approval_json, signature, stored_ms FROM ' . $table . ' WHERE ' . $col . ' = ? ORDER BY stored_ms, approver');
  $st->execute([$id]);
  $out = [];
  foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $r) $out[] = ['domain' => $r['approver'], 'approval' => json_decode($r['approval_json'], true), 'signature' => $r['signature'], 'decision' => $r['decision'], 'storedAtMs' => (int) $r['stored_ms']];
  return $out;
}

function mi_decisions($db, $table, $col, $id) {
  $st = $db->prepare('SELECT approver, decision FROM ' . $table . ' WHERE ' . $col . ' = ?');
  $st->execute([$id]);
  $out = [];
  foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $r) $out[$r['approver']] = $r['decision'];
  return $out;
}

function mi_state_row($db, $assetId) {
  $st = $db->prepare('SELECT * FROM asset_state WHERE asset_id = ?');
  $st->execute([$assetId]);
  $r = mi_row($st);
  return $r ? ['version' => (int) $r['version'], 'owner' => $r['owner_pub'], 'stateDigest' => $r['state_digest'], 'updatedAtMs' => (int) $r['updated_ms']] : null;
}

function mi_evidence($db, $assetId) {
  $st = $db->prepare('SELECT receipt_json, signature FROM transitions WHERE asset_id = ? ORDER BY version');
  $st->execute([$assetId]);
  $out = [];
  foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $r) $out[] = ['receipt' => json_decode($r['receipt_json'], true), 'signature' => $r['signature']];
  return $out;
}

// The portable document: everything a third party needs to read the asset's authorization policy and
// verify its original issuance and the ownership chain offline. Only valid approvals are attached
// (rejections are recorded separately), and nothing in it is a live claim about current ownership.
function mi_portable($db, $asset) {
  $entries = [];
  foreach (mi_stored_entries($db, 'issuance_approvals', 'asset_id', $asset['asset_id']) as $e) {
    if ($e['decision'] === 'approve') $entries[] = ['domain' => $e['domain'], 'approval' => $e['approval'], 'signature' => $e['signature']];
  }
  return [
    'format' => MI_PORTABLE_FORMAT, 'definition' => $asset['definition'], 'definitionDigest' => $asset['definition_digest'],
    'issuance' => ['signatures' => $entries],
    'ownership' => ['registry' => $asset['definition']['stateAuthority']['domain'], 'evidence' => mi_evidence($db, $asset['asset_id'])],
  ];
}

// ---------------------------------------------------------------- expiry sweep

function mi_sweep($db) {
  $now = txlab_now_ms();
  $st = $db->prepare('SELECT asset_id FROM assets WHERE status = \'pending\' AND expires_ms < ?');
  $st->execute([$now]);
  foreach ($st->fetchAll(PDO::FETCH_COLUMN) as $id) {
    $db->prepare('UPDATE assets SET status = \'expired\', fail_reason = ? WHERE asset_id = ? AND status = \'pending\'')->execute(['the issuance window closed before the policy was satisfied', $id]);
    mi_event($db, $id, 'issuance-expired', null, 'the issuance window closed before the issuance policy was satisfied');
  }
  $st = $db->prepare('SELECT tx_id FROM transfers WHERE status = \'pending\' AND expires_ms < ?');
  $st->execute([$now]);
  foreach ($st->fetchAll(PDO::FETCH_COLUMN) as $id) {
    $db->prepare('UPDATE transfers SET status = \'expired\', finished_ms = ? WHERE tx_id = ? AND status = \'pending\'')->execute([$now, $id]);
    mi_event($db, $id, 'transfer-expired', null, 'the authorization window closed before the transfer policy was satisfied');
  }
}

// ---------------------------------------------------------------- issuance (state authority)

function mi_store_issuance_approval($cfg, $assetId, $approval, $signature) {
  if (!mi_is_uuid($assetId)) mi_fail(400, 'invalid asset id');
  $reject = null;
  try {
    mi_in_txn(function ($db) use ($cfg, $assetId, $approval, $signature, &$reject) {
      mi_sweep($db);
      $asset = mi_load_asset($db, $assetId);
      if (!$asset) mi_fail(404, 'no such asset');
      $who = is_array($approval) && isset($approval['approver']) && is_string($approval['approver']) ? substr($approval['approver'], 0, 80) : null;
      try {
        if ($asset['status'] !== 'pending') mi_fail(409, 'the asset is ' . $asset['status'] . '; issuance approvals are no longer accepted');
        mi_check_one_approval($cfg, $approval, $signature, $assetId, $asset['definition_digest'], $asset['definition']['issuancePolicy'], (int) $asset['created_ms'], (int) $asset['expires_ms']);
        $dup = $db->prepare('SELECT 1 FROM issuance_approvals WHERE asset_id = ? AND approver = ?');
        $dup->execute([$assetId, $approval['approver']]);
        if (mi_col($dup)) mi_fail(409, 'duplicate approval: ' . $approval['approver'] . ' has already decided on this issuance');
      } catch (TxlabError $e) {
        mi_event($db, $assetId, 'issuance-approval-rejected', $who, $e->getMessage());
        $reject = $e;
        return null;
      }
      $db->prepare('INSERT INTO issuance_approvals (asset_id, approver, decision, approval_json, signature, stored_ms) VALUES (?, ?, ?, ?, ?, ?)')
         ->execute([$assetId, $approval['approver'], $approval['decision'], canonicalize($approval), $signature, txlab_now_ms()]);
      mi_event($db, $assetId, $approval['decision'] === 'approve' ? 'issuance-approved' : 'issuance-rejected', $approval['approver'], 'signature verified against the pinned public key');
      mi_issuance_advance($cfg, $db, $asset);
      return true;
    });
  } catch (PDOException $e) {
    mi_fail(409, 'duplicate approval or conflicting update');
  }
  if ($reject) throw $reject;
}

// Shape, subject, digest, roster membership, pinned-key signature and time window of one decision.
function mi_check_one_approval($cfg, $approval, $signature, $refId, $digest, $policy, $createdMs, $expiresMs) {
  if (!txlab_approval_shape_ok($approval)) mi_fail(400, 'the approval is malformed');
  if (!is_string($signature) || $signature === '') mi_fail(400, 'the approval has no signature');
  if ($approval['txId'] !== $refId) mi_fail(400, 'the approval is for a different item');
  if ($approval['payloadDigest'] !== $digest) mi_fail(400, 'the approval was signed over a different digest');
  if (!in_array($approval['approver'], $policy['roster'], true) || !isset($cfg['roster'][$approval['approver']])) mi_fail(403, 'the approving domain is not in this roster');
  if (!txlab_verify_with_pinned_key($cfg, $approval['approver'], canonicalize($approval), $signature)) mi_fail(400, 'the signature does not verify against ' . $approval['approver'] . '\'s pinned public key');
  $now = txlab_now_ms();
  if ($approval['approvedAtMs'] > $now + TXLAB_CLOCK_SKEW_MS || $approval['approvedAtMs'] < $createdMs - TXLAB_CLOCK_SKEW_MS) mi_fail(400, 'the approval timestamp is outside the authorization window');
  if ($approval['approvedAtMs'] > $expiresMs + TXLAB_CLOCK_SKEW_MS) mi_fail(400, 'the approval was signed after the authorization expired');
}

function mi_issuance_advance($cfg, $db, $asset) {
  $id = $asset['asset_id'];
  $def = $asset['definition'];
  $eval = txlab_evaluate($def['issuancePolicy'], mi_decisions($db, 'issuance_approvals', 'asset_id', $id));
  $now = txlab_now_ms();
  if ($eval['satisfied']) {
    // the registry re-verifies the whole certificate itself before it admits the asset
    list($rows, $eval2) = mi_check_signatures($def, mi_stored_entries($db, 'issuance_approvals', 'asset_id', $id), $id, $asset['definition_digest'], $def['issuancePolicy']);
    if (!$eval2['satisfied']) {
      $db->prepare('UPDATE assets SET status = \'rejected\', fail_reason = ? WHERE asset_id = ? AND status = \'pending\'')->execute(['the issuance certificate did not verify', $id]);
      mi_event($db, $id, 'issuance-refused', $cfg['domain'], 'the stored approvals did not verify as a certificate');
      return;
    }
    $up = $db->prepare('UPDATE assets SET status = \'issued\', issued_ms = ? WHERE asset_id = ? AND status = \'pending\'');
    $up->execute([$now, $id]);
    if ($up->rowCount() !== 1) return;
    $owner = $def['originalOwner']['publicKey'];
    $sd = mi_state_digest($id, 0, $owner, $asset['definition_digest']);
    $db->prepare('INSERT INTO asset_state (asset_id, version, owner_pub, state_digest, updated_ms) VALUES (?, 0, ?, ?, ?)')->execute([$id, $owner, $sd, $now]);
    $reg = ['v' => MI_REGISTRATION_VERSION, 'assetId' => $id, 'definitionDigest' => $asset['definition_digest'], 'registry' => $cfg['domain'], 'owner' => $owner, 'version' => 0, 'stateDigest' => $sd, 'registeredAtMs' => $now];
    $json = canonicalize($reg);
    $db->prepare('INSERT INTO transitions (asset_id, version, tx_id, receipt_json, signature) VALUES (?, 0, NULL, ?, ?)')->execute([$id, $json, txlab_sign($cfg, $json)]);
    mi_event($db, $id, 'issued', $cfg['domain'], $eval['approved'] ? count($eval['approved']) . '/' . $eval['required'] . ' issuer signatures verified; the state authority registered ownership at version 0' : 'issued');
    return;
  }
  if ($eval['impossible']) {
    $db->prepare('UPDATE assets SET status = \'rejected\', fail_reason = ? WHERE asset_id = ? AND status = \'pending\'')->execute(['the issuance policy can no longer be satisfied', $id]);
    mi_event($db, $id, 'issuance-rejected', null, 'enough issuers rejected that the issuance policy cannot be met');
  } elseif (count($eval['approved']) >= $eval['required'] && $eval['missingMandatory']) {
    mi_event($db, $id, 'issuance-blocked', null, 'threshold reached but required issuer(s) ' . implode(', ', $eval['missingMandatory']) . ' have not signed');
  }
}

// ---------------------------------------------------------------- transfers (state authority)

function mi_load_transfer($db, $txId) {
  $st = $db->prepare('SELECT * FROM transfers WHERE tx_id = ?');
  $st->execute([$txId]);
  $row = mi_row($st);
  if (!$row) return null;
  $row['payload'] = json_decode($row['payload_json'], true);
  $row['owner_auth'] = json_decode($row['owner_auth_json'], true);
  return $row;
}

function mi_store_transfer_approval($cfg, $txId, $approval, $signature) {
  if (!mi_is_uuid($txId)) mi_fail(400, 'invalid transfer id');
  $reject = null;
  try {
    mi_in_txn(function ($db) use ($cfg, $txId, $approval, $signature, &$reject) {
      mi_sweep($db);
      $tx = mi_load_transfer($db, $txId);
      if (!$tx) mi_fail(404, 'no such transfer');
      $asset = mi_load_asset($db, $tx['asset_id']);
      $who = is_array($approval) && isset($approval['approver']) && is_string($approval['approver']) ? substr($approval['approver'], 0, 80) : null;
      try {
        if ($tx['status'] !== 'pending') mi_fail(409, 'the transfer is ' . $tx['status'] . '; approvals are no longer accepted');
        mi_check_one_approval($cfg, $approval, $signature, $txId, $tx['digest'], $asset['definition']['transferPolicy'], (int) $tx['created_ms'], (int) $tx['expires_ms']);
        $dup = $db->prepare('SELECT 1 FROM transfer_approvals WHERE tx_id = ? AND approver = ?');
        $dup->execute([$txId, $approval['approver']]);
        if (mi_col($dup)) mi_fail(409, 'duplicate approval: ' . $approval['approver'] . ' has already decided on this transfer');
      } catch (TxlabError $e) {
        mi_event($db, $txId, 'approval-rejected', $who, $e->getMessage());
        $reject = $e;
        return null;
      }
      $db->prepare('INSERT INTO transfer_approvals (tx_id, approver, decision, approval_json, signature, stored_ms) VALUES (?, ?, ?, ?, ?, ?)')
         ->execute([$txId, $approval['approver'], $approval['decision'], canonicalize($approval), $signature, txlab_now_ms()]);
      mi_event($db, $txId, $approval['decision'] === 'approve' ? 'approval-accepted' : 'rejection-accepted', $approval['approver'], 'signature verified against the pinned public key; bound to digest ' . substr($tx['digest'], 0, 12));
      mi_transfer_advance($cfg, $db, $tx);
      return true;
    });
  } catch (PDOException $e) {
    mi_fail(409, 'duplicate approval or conflicting update');
  }
  if ($reject) throw $reject;
}

// Executes a transfer exactly once when the policy is satisfied. The state authority re-verifies the
// owner's authorization and the whole approval certificate, and that the ownership state it was
// approved against is still the current one.
function mi_transfer_advance($cfg, $db, $tx) {
  $txId = $tx['tx_id'];
  $asset = mi_load_asset($db, $tx['asset_id']);
  $def = $asset['definition'];
  $p = $tx['payload'];
  $now = txlab_now_ms();
  $fail = function ($status, $reason, $kind, $detail) use ($db, $txId, $now, $cfg) {
    $db->prepare('UPDATE transfers SET status = ?, fail_reason = ?, finished_ms = ? WHERE tx_id = ? AND status = \'pending\'')->execute([$status, $reason, $now, $txId]);
    mi_event($db, $txId, $kind, $cfg['domain'], $detail);
  };
  if ($now > (int) $tx['expires_ms']) { $fail('expired', 'the authorization window closed before execution', 'transfer-expired', 'the authorization window closed before execution'); return; }
  $eval = txlab_evaluate($def['transferPolicy'], mi_decisions($db, 'transfer_approvals', 'tx_id', $txId));
  if ($eval['satisfied']) {
    mi_event($db, $txId, 'quorum-reached', null, count($eval['approved']) . '/' . $def['transferPolicy']['threshold'] . ' issuer approvals over the same digest; every mandatory domain has approved');
    $entries = mi_stored_entries($db, 'transfer_approvals', 'tx_id', $txId);
    list($rows, $eval2) = mi_check_signatures($def, $entries, $txId, $tx['digest'], $def['transferPolicy']);
    $oa = $tx['owner_auth'];
    if (!$eval2['satisfied'] || mi_digest($p) !== $tx['digest'] || !mi_owner_auth_ok($oa, $p, $tx['digest']) || !mi_verify_obj($p['fromOwner'], $oa, $tx['owner_signature'])) {
      $fail('failed', 'the approval certificate or the owner authorization did not verify', 'execution-refused', 'the stored approvals or owner authorization did not verify at execution time');
      return;
    }
    $st = mi_state_row($db, $tx['asset_id']);
    if ($asset['status'] !== 'issued' || $st === null || $st['version'] !== (int) $tx['base_version'] || $st['stateDigest'] !== $p['baseStateDigest'] || $st['owner'] !== $p['fromOwner']) {
      $fail('failed', 'the ownership state changed since this transfer was authorized', 'execution-refused', 'stale ownership state: the approvals were for version ' . $tx['base_version'] . ' but the registry is at ' . ($st === null ? 'none' : $st['version']));
      return;
    }
    $up = $db->prepare('UPDATE transfers SET status = \'executed\', finished_ms = ? WHERE tx_id = ? AND status = \'pending\'');
    $up->execute([$now, $txId]);
    if ($up->rowCount() !== 1) return; // someone else already finalized it: never execute twice
    $newVersion = $st['version'] + 1;
    $newDigest = mi_state_digest($tx['asset_id'], $newVersion, $p['toOwner'], $st['stateDigest']);
    $sup = $db->prepare('UPDATE asset_state SET version = ?, owner_pub = ?, state_digest = ?, updated_ms = ? WHERE asset_id = ? AND version = ?');
    $sup->execute([$newVersion, $p['toOwner'], $newDigest, $now, $tx['asset_id'], $st['version']]);
    if ($sup->rowCount() !== 1) mi_fail(409, 'competing ownership update');
    $appr = [];
    foreach ($entries as $e) if ($e['decision'] === 'approve') $appr[] = ['approver' => $e['domain'], 'approval' => $e['approval'], 'signature' => $e['signature']];
    $receipt = [
      'v' => MI_TRANSITION_VERSION, 'assetId' => $tx['asset_id'], 'txId' => $txId, 'transfer' => $p, 'transferDigest' => $tx['digest'],
      'ownerAuthorization' => ['object' => $oa, 'signature' => $tx['owner_signature']], 'approvals' => $appr,
      'fromVersion' => $st['version'], 'toVersion' => $newVersion, 'previousStateDigest' => $st['stateDigest'], 'stateDigest' => $newDigest,
      'registry' => $cfg['domain'], 'executedAtMs' => $now,
    ];
    $json = canonicalize($receipt);
    $db->prepare('INSERT INTO transitions (asset_id, version, tx_id, receipt_json, signature) VALUES (?, ?, ?, ?, ?)')->execute([$tx['asset_id'], $newVersion, $txId, $json, txlab_sign($cfg, $json)]);
    mi_event($db, $txId, 'executed', $cfg['domain'], 'ownership moved from ' . substr(mi_key_id($p['fromOwner']), 0, 8) . ' to ' . substr(mi_key_id($p['toOwner']), 0, 8) . '; version ' . $st['version'] . ' -> ' . $newVersion);
    return;
  }
  if ($eval['impossible']) {
    $fail('rejected', 'the transfer policy can no longer be satisfied', 'transfer-rejected', 'enough issuers rejected that the transfer policy cannot be met');
  } elseif (count($eval['approved']) >= $def['transferPolicy']['threshold'] && $eval['missingMandatory']) {
    mi_event($db, $txId, 'execution-blocked', null, 'threshold reached but required domain(s) ' . implode(', ', $eval['missingMandatory']) . ' have not approved; no unrelated quorum can stand in for them');
  }
}

// Recovery: a satisfied but unexecuted transfer (interrupted execution) is completed exactly once.
function mi_recover() {
  $cfg = mi_require_config();
  if (!$cfg['isState']) return;
  mi_in_txn(function ($db) use ($cfg) {
    mi_sweep($db);
    foreach ($db->query('SELECT asset_id FROM assets WHERE status = \'pending\'')->fetchAll(PDO::FETCH_COLUMN) as $id) {
      $a = mi_load_asset($db, $id);
      $e = txlab_evaluate($a['definition']['issuancePolicy'], mi_decisions($db, 'issuance_approvals', 'asset_id', $id));
      if ($e['satisfied']) mi_issuance_advance($cfg, $db, $a);
    }
    foreach ($db->query('SELECT tx_id FROM transfers WHERE status = \'pending\'')->fetchAll(PDO::FETCH_COLUMN) as $id) {
      $tx = mi_load_transfer($db, $id);
      $asset = mi_load_asset($db, $tx['asset_id']);
      $e = txlab_evaluate($asset['definition']['transferPolicy'], mi_decisions($db, 'transfer_approvals', 'tx_id', $id));
      if ($e['satisfied']) mi_transfer_advance($cfg, $db, $tx);
    }
  });
}

// ---------------------------------------------------------------- independent validation (every approving domain, including the state authority itself)

function mi_signed_row($db, $kind, $refId) {
  $st = $db->prepare('SELECT * FROM signed_log WHERE kind = ? AND ref_id = ?');
  $st->execute([$kind, $refId]);
  return mi_row($st);
}

// Returns [verdict, message]: verdict 'approve', 'reject' (sign a rejection) or 'refuse' (sign nothing).
function mi_validate_issuance($cfg, $portable, $expectDigest, $authorityStatus) {
  if (!is_array($portable) || !isset($portable['definition'], $portable['definitionDigest'])) return ['refuse', 'the authority returned a malformed asset'];
  $def = $portable['definition'];
  $p = mi_definition_problem($def);
  if ($p !== null) return ['reject', $p];
  if (mi_digest($def) !== $portable['definitionDigest']) return ['refuse', 'the definition does not match its digest'];
  if ($portable['definitionDigest'] !== $expectDigest) return ['refuse', 'the digest in the request differs from the asset\'s own digest'];
  if ($authorityStatus !== 'pending') return ['refuse', 'the asset is ' . $authorityStatus . ', not pending issuance'];
  $t = mi_definition_trust_problem($cfg, $def);
  if ($t !== null) return ['reject', $t];
  $now = txlab_now_ms();
  $window = ($cfg['public'] !== null ? $cfg['public']['issuanceWindowSeconds'] : 600) * 1000;
  if ($now > $def['createdAtMs'] + $window + TXLAB_CLOCK_SKEW_MS) return ['refuse', 'the issuance window has closed'];
  if ($def['createdAtMs'] > $now + TXLAB_CLOCK_SKEW_MS) return ['refuse', 'the asset is dated in the future'];
  return ['approve', 'valid'];
}

// $ctx = ['asset' => portable, 'transfer' => ['payload','digest','ownerAuth','ownerSignature','status'], 'live' => [version, owner, stateDigest]]
function mi_validate_transfer($cfg, $ctx, $expectDigest, $txId) {
  $portable = isset($ctx['asset']) ? $ctx['asset'] : null;
  $tr = isset($ctx['transfer']) ? $ctx['transfer'] : null;
  $live = isset($ctx['live']) ? $ctx['live'] : null;
  if (!is_array($portable) || !is_array($tr) || !is_array($live) || !isset($tr['payload'], $tr['digest'], $tr['status'], $tr['ownerAuth'], $tr['ownerSignature'])) return ['refuse', 'the authority returned incomplete evidence'];
  $p = $tr['payload'];
  if (!mi_transfer_shape_ok($p)) return ['refuse', 'the transfer payload is malformed'];
  if ($p['txId'] !== $txId) return ['refuse', 'the authority returned a different transfer'];
  $d = mi_digest($p);
  if ($d !== $tr['digest']) return ['refuse', 'the transfer does not match its digest'];
  if ($d !== $expectDigest) return ['refuse', 'the digest in the request differs from the transfer\'s own digest'];
  if ($tr['status'] !== 'pending') return ['refuse', 'the transfer is ' . $tr['status'] . ', not pending'];
  $now = txlab_now_ms();
  if ($now > $p['expiresAtMs']) return ['refuse', 'the authorization window has closed'];
  $rep = mi_verify_portable($portable);
  if (!$rep['shapeOk'] || !$rep['definitionDigestOk']) return ['reject', 'the asset definition is invalid: ' . ($rep['problem'] ?: 'digest mismatch')];
  $def = $portable['definition'];
  $t = mi_definition_trust_problem($cfg, $def);
  if ($t !== null) return ['reject', $t];
  if (!$rep['originalIssuanceVerified']) return ['reject', 'the original issuance does not verify: the asset is not validly issued'];
  if (!$rep['ownership']['chainValid']) return ['reject', 'the ownership evidence does not verify: ' . implode('; ', $rep['ownership']['problems'])];
  if ($p['assetId'] !== $def['assetId'] || $p['definitionDigest'] !== $portable['definitionDigest'] || $p['registry'] !== $cfg['stateAuthority']) return ['reject', 'the transfer does not belong to this asset or names a different registry'];
  // current authoritative state, as fetched now, must agree with the evidence and with what the owner authorized
  if (!isset($live['version'], $live['owner'], $live['stateDigest']) || $live['version'] !== $rep['ownership']['version'] || $live['owner'] !== $rep['ownership']['owner'] || $live['stateDigest'] !== $rep['ownership']['stateDigest']) return ['reject', 'the registry\'s state does not match its own signed ownership evidence'];
  if ($p['baseVersion'] !== $live['version'] || $p['baseStateDigest'] !== $live['stateDigest'] || $p['fromOwner'] !== $live['owner']) return ['reject', 'stale ownership state: the transfer was authorized against version ' . $p['baseVersion'] . ' but the current version is ' . $live['version']];
  if (!mi_owner_auth_ok($tr['ownerAuth'], $p, $d) || !mi_verify_obj($p['fromOwner'], $tr['ownerAuth'], $tr['ownerSignature'])) return ['reject', 'the current owner\'s signature on this exact transfer does not verify'];
  $window = ($cfg['public'] !== null ? $cfg['public']['transferTtlSeconds'] : 300) * 1000;
  if ($p['expiresAtMs'] - $p['createdAtMs'] > $window) return ['reject', 'the authorization window is longer than this domain allows'];
  if ($p['createdAtMs'] > $now + TXLAB_CLOCK_SKEW_MS) return ['refuse', 'the transfer is dated in the future'];
  $db = mi_db();
  // this domain's own history must agree with the chain: any approval attributed to it was really given by it
  foreach ($rep['ownership']['steps'] as $i => $s) {
    if ($i === 0 || empty($s['txId'])) continue;
    $rec = $portable['ownership']['evidence'][$i]['receipt'];
    foreach ($rec['approvals'] as $a) {
      if ($a['approver'] !== $cfg['domain']) continue;
      $row = mi_signed_row($db, 'transfer', $s['txId']);
      if (!$row || $row['decision'] !== 'approve' || $row['digest'] !== $rec['transferDigest']) return ['reject', 'the ownership chain attributes an approval to this domain for transfer ' . substr($s['txId'], 0, 8) . ' that this domain has no record of giving'];
    }
  }
  // never approve two competing transfers of the same ownership state
  $st = $db->prepare('SELECT ref_id, expires_ms FROM signed_log WHERE kind = \'transfer\' AND asset_id = ? AND base_version = ? AND decision = \'approve\' AND ref_id <> ?');
  $st->execute([$p['assetId'], $p['baseVersion'], $txId]);
  $other = mi_row($st);
  if ($other && (int) $other['expires_ms'] + TXLAB_CLOCK_SKEW_MS > $now) return ['reject', 'this domain already approved a competing transfer of the same ownership state (' . substr($other['ref_id'], 0, 8) . '); only one can execute'];
  return ['approve', 'valid'];
}

// Signs (and logs) this domain's decision. Idempotent: a repeat returns the stored decision.
function mi_sign_and_log($cfg, $kind, $refId, $assetId, $baseVersion, $digest, $decision, $expiresMs) {
  return mi_in_txn(function ($db) use ($cfg, $kind, $refId, $assetId, $baseVersion, $digest, $decision, $expiresMs) {
    $db->prepare('DELETE FROM signed_log WHERE expires_ms < ?')->execute([txlab_now_ms() - 86400000]);
    $row = mi_signed_row($db, $kind, $refId);
    if ($row) {
      if ($row['digest'] !== $digest) mi_fail(409, 'this domain already decided on that item over a different digest');
      return ['approval' => json_decode($row['approval_json'], true), 'signature' => $row['signature'], 'decision' => $row['decision'], 'repeat' => true];
    }
    $approval = mi_make_approval($cfg, $refId, $digest, $decision);
    $sig = mi_sign_obj($cfg, $approval);
    $db->prepare('INSERT INTO signed_log (kind, ref_id, asset_id, base_version, digest, decision, approval_json, signature, expires_ms, signed_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
       ->execute([$kind, $refId, $assetId, $baseVersion, $digest, $decision, canonicalize($approval), $sig, $expiresMs, txlab_now_ms()]);
    return ['approval' => $approval, 'signature' => $sig, 'decision' => $decision, 'repeat' => false];
  });
}

// ---------------------------------------------------------------- serving evidence to peers (state authority)

function mi_assert_state_authority($cfg) {
  if (!$cfg['isState']) mi_fail(400, 'evidence is served by the state authority (' . $cfg['stateAuthority'] . ')');
}

function mi_asset_evidence($db, $assetId) {
  $asset = mi_load_asset($db, $assetId);
  if (!$asset) return null;
  return ['asset' => mi_portable($db, $asset), 'status' => $asset['status'], 'live' => mi_state_row($db, $assetId), 'createdAtMs' => (int) $asset['created_ms'], 'expiresAtMs' => (int) $asset['expires_ms']];
}

function mi_transfer_evidence($db, $txId) {
  $tx = mi_load_transfer($db, $txId);
  if (!$tx) return null;
  $ev = mi_asset_evidence($db, $tx['asset_id']);
  $ev['transfer'] = ['payload' => $tx['payload'], 'digest' => $tx['digest'], 'ownerAuth' => $tx['owner_auth'], 'ownerSignature' => $tx['owner_signature'], 'status' => $tx['status'], 'expiresAtMs' => (int) $tx['expires_ms']];
  return $ev;
}

// POST ?op=peer-fetch on the state authority: a signed request from a roster domain.
function mi_peer_fetch($req, $sig) {
  $cfg = mi_require_public();
  $req = mi_verify_peer_request($cfg, $req, $sig, ['fetch-asset', 'fetch-transfer']);
  mi_in_txn(function ($db) use ($cfg) { mi_rate($db, 'peer', '*', $cfg['public']['peerRequestsPerHour'], 3600000); });
  $db = mi_db();
  $ev = $req['op'] === 'fetch-asset' ? mi_asset_evidence($db, $req['ref']) : mi_transfer_evidence($db, $req['ref']);
  if ($ev === null) mi_fail(404, 'no such ' . ($req['op'] === 'fetch-asset' ? 'asset' : 'transfer'));
  $actual = $req['op'] === 'fetch-asset' ? $ev['asset']['definitionDigest'] : $ev['transfer']['digest'];
  if ($actual !== $req['digest']) mi_fail(409, 'the requested digest does not match the stored one');
  return $ev;
}

// ---------------------------------------------------------------- approving side: validate independently, then sign

function mi_peer_get_evidence($cfg, $op, $ref, $digest) {
  $stateIssuer = ['domain' => $cfg['stateAuthority'], 'publicKey' => $cfg['roster'][$cfg['stateAuthority']]['publicKey'], 'capabilities' => mi_capabilities()];
  $url = mi_service_url($cfg, $stateIssuer, MI_CAP_STATE);
  $signed = mi_make_peer_request($cfg, $op, $ref, $cfg['stateAuthority'], $digest);
  $r = mi_http($cfg, 'POST', $url . '?op=peer-fetch', $signed, 10);
  if ($r['status'] === 0) mi_fail(502, 'cannot read the evidence from ' . $cfg['stateAuthority'] . ': ' . $r['error'], ['state' => 'peer-unavailable']);
  if ($r['status'] !== 200 || !is_array($r['body'])) mi_fail($r['status'] >= 400 && $r['status'] < 500 ? $r['status'] : 502, $cfg['stateAuthority'] . ' refused to serve the evidence: ' . $r['error']);
  return $r['body'];
}

function mi_peer_decide($req, $sig, $kind) {
  $cfg = mi_require_public(false);
  if ($cfg['isState']) mi_fail(400, 'the state authority signs through its own public flow');
  $ops = $kind === 'issue' ? ['approve-issuance'] : ['approve-transfer'];
  $req = mi_verify_peer_request($cfg, $req, $sig, $ops);
  if ($req['requester'] !== $cfg['stateAuthority']) mi_fail(403, 'only the state authority can request approvals');
  mi_in_txn(function ($db) use ($cfg) { mi_rate($db, 'peer', '*', $cfg['public']['peerRequestsPerHour'], 3600000); });
  $inf = mi_inflight_enter($cfg);
  try {
    $db = mi_db();
    $already = mi_signed_row($db, $kind === 'issue' ? 'issue' : 'transfer', $req['ref']);
    if ($already) {
      if ($already['digest'] !== $req['digest']) mi_fail(409, 'this domain already decided on that item over a different digest');
      return ['signedBy' => $cfg['domain'], 'decision' => $already['decision'], 'approval' => json_decode($already['approval_json'], true), 'signature' => $already['signature'], 'repeat' => true];
    }
    if ($kind === 'issue') {
      $ev = mi_peer_get_evidence($cfg, 'fetch-asset', $req['ref'], $req['digest']);
      if (!isset($ev['asset'], $ev['status']) || !is_array($ev['asset']) || !isset($ev['asset']['definition']['assetId']) || $ev['asset']['definition']['assetId'] !== $req['ref']) mi_fail(400, 'the authority returned a different asset');
      list($verdict, $msg) = mi_validate_issuance($cfg, $ev['asset'], $req['digest'], $ev['status']);
      $assetId = $req['ref'];
      $base = null;
      $expires = (isset($ev['asset']['definition']['createdAtMs']) ? $ev['asset']['definition']['createdAtMs'] : txlab_now_ms()) + 3600000;
    } else {
      $ev = mi_peer_get_evidence($cfg, 'fetch-transfer', $req['ref'], $req['digest']);
      list($verdict, $msg) = mi_validate_transfer($cfg, $ev, $req['digest'], $req['ref']);
      $assetId = isset($ev['transfer']['payload']['assetId']) ? $ev['transfer']['payload']['assetId'] : null;
      $base = isset($ev['transfer']['payload']['baseVersion']) ? $ev['transfer']['payload']['baseVersion'] : null;
      $expires = isset($ev['transfer']['payload']['expiresAtMs']) ? $ev['transfer']['payload']['expiresAtMs'] : txlab_now_ms();
    }
    if ($verdict === 'refuse') mi_fail(409, $msg, ['verdict' => 'refused']);
    $dec = $verdict === 'approve' ? 'approve' : 'reject';
    try {
      $res = mi_sign_and_log($cfg, $kind === 'issue' ? 'issue' : 'transfer', $req['ref'], $assetId, $base, $req['digest'], $dec, $expires);
    } catch (PDOException $e) {
      mi_fail(409, 'this domain already approved a competing transfer of the same ownership state', ['verdict' => 'refused']);
    }
    mi_in_txn(function ($db) use ($req, $cfg, $dec, $msg, $kind) { mi_event($db, $req['ref'], 'peer-' . ($dec === 'approve' ? 'approval-signed' : 'rejection-signed'), $cfg['domain'], ($kind === 'issue' ? 'issuance' : 'transfer') . ': ' . ($dec === 'approve' ? 'validated independently under this domain\'s own policy and signed with its own key' : $msg)); });
    return ['signedBy' => $cfg['domain'], 'decision' => $dec, 'approval' => $res['approval'], 'signature' => $res['signature'], 'reason' => $dec === 'reject' ? $msg : null,
      'validation' => $dec === 'approve' ? 'fetched the ' . ($kind === 'issue' ? 'asset' : 'transfer') . ' from ' . $cfg['stateAuthority'] . ' and verified issuance, ownership evidence, live state' . ($kind === 'issue' ? '' : ' and the owner\'s signature') . ' under its own pinned policy' : null];
  } finally {
    mi_inflight_leave($inf);
  }
}

// ---------------------------------------------------------------- state authority: ask a peer (or itself) to decide

// Signs this (state authority) domain's own decision after the SAME validation every approver applies.
function mi_local_decide($cfg, $kind, $refId) {
  $db = mi_db();
  mi_recover();
  if ($kind === 'issue') {
    $asset = mi_load_asset($db, $refId);
    if (!$asset) mi_fail(404, 'no such asset');
    $portable = mi_portable($db, $asset);
    list($verdict, $msg) = mi_validate_issuance($cfg, $portable, $asset['definition_digest'], $asset['status']);
    $assetId = $refId; $base = null; $digest = $asset['definition_digest']; $expires = (int) $asset['expires_ms'];
  } else {
    $tx = mi_load_transfer($db, $refId);
    if (!$tx) mi_fail(404, 'no such transfer');
    $ev = mi_transfer_evidence($db, $refId);
    list($verdict, $msg) = mi_validate_transfer($cfg, $ev, $tx['digest'], $refId);
    $assetId = $tx['asset_id']; $base = (int) $tx['base_version']; $digest = $tx['digest']; $expires = (int) $tx['expires_ms'];
  }
  if ($verdict === 'refuse') mi_fail(409, $msg);
  $dec = $verdict === 'approve' ? 'approve' : 'reject';
  try {
    $res = mi_sign_and_log($cfg, $kind === 'issue' ? 'issue' : 'transfer', $refId, $assetId, $base, $digest, $dec, $expires);
  } catch (PDOException $e) {
    mi_fail(409, 'this domain already approved a competing transfer of the same ownership state');
  }
  if ($kind === 'issue') mi_store_issuance_approval($cfg, $refId, $res['approval'], $res['signature']);
  else mi_store_transfer_approval($cfg, $refId, $res['approval'], $res['signature']);
  return ['signedBy' => $cfg['domain'], 'decision' => $dec, 'reason' => $dec === 'reject' ? $msg : null];
}

// Asks another issuer's service (found through authenticated discovery) to validate and sign.
function mi_ask_peer($cfg, $kind, $refId, $digest, $issuer) {
  $domain = $issuer['domain'];
  $cap = $kind === 'issue' ? MI_CAP_ISSUE : MI_CAP_TRANSFER;
  $inf = mi_inflight_enter($cfg);
  try {
    $url = mi_service_url($cfg, $issuer, $cap);
    $signed = mi_make_peer_request($cfg, $kind === 'issue' ? 'approve-issuance' : 'approve-transfer', $refId, $domain, $digest);
    mi_in_txn(function ($db) use ($refId, $cfg, $domain, $url) { mi_event($db, $refId, 'peer-approval-requested', $cfg['domain'], 'asked ' . $domain . ' (' . preg_replace('#^https?://#', '', $url) . ') to fetch, validate and sign under its own policy'); });
    $r = mi_http($cfg, 'POST', $url . '?op=' . ($kind === 'issue' ? 'peer-issue-approve' : 'peer-transfer-approve'), $signed, 20);
  } catch (TxlabError $e) {
    $msg = $e->getMessage();
    mi_in_txn(function ($db) use ($refId, $domain, $msg) { mi_event($db, $refId, 'peer-approval-failed', $domain, $msg); });
    throw $e;
  } finally {
    mi_inflight_leave($inf);
  }
  if ($r['status'] !== 200 || !is_array($r['body'])) {
    $msg = $domain . ($r['status'] === 0 ? ' could not be reached' : ' did not sign') . ': ' . $r['error'];
    mi_in_txn(function ($db) use ($refId, $domain, $msg) { mi_event($db, $refId, 'peer-approval-failed', $domain, $msg); });
    $code = ($r['status'] >= 400 && $r['status'] < 500) ? $r['status'] : 502;
    if ($code === 401 || $code === 403) $code = 502;
    mi_fail($code, $msg, ['state' => $r['status'] === 0 ? 'peer-unavailable' : 'peer-refused']);
  }
  $b = $r['body'];
  if (!isset($b['approval'], $b['signature'])) mi_fail(502, $domain . ' returned a malformed answer');
  $ap = $b['approval'];
  // the returned decision is verified like any other signed approval before it is stored
  if (!txlab_approval_shape_ok($ap) || $ap['approver'] !== $domain || $ap['txId'] !== $refId || $ap['payloadDigest'] !== $digest) mi_fail(502, $domain . ' returned an approval for something else');
  $said = isset($b['validation']) && is_string($b['validation']) ? substr(preg_replace('/[^A-Za-z0-9 .,:;()\'_-]/', '', $b['validation']), 0, 160) : (isset($b['reason']) && is_string($b['reason']) ? 'rejected: ' . substr(preg_replace('/[^A-Za-z0-9 .,:;()\'_-]/', '', $b['reason']), 0, 140) : '');
  mi_in_txn(function ($db) use ($refId, $domain, $said, $ap) { mi_event($db, $refId, 'peer-reply-received', $domain, 'replied with a signed ' . $ap['decision'] . ($said !== '' ? ' (' . $said . ')' : '')); });
  if ($kind === 'issue') mi_store_issuance_approval($cfg, $refId, $ap, $b['signature']);
  else mi_store_transfer_approval($cfg, $refId, $ap, $b['signature']);
  return ['signedBy' => $domain, 'decision' => $ap['decision']];
}

// Any domain's approval can also be pushed in directly; it is accepted only when it verifies.
function mi_submit_approval($kind, $id, $approval, $signature) {
  $cfg = mi_require_config();
  mi_assert_state_authority($cfg);
  if ($kind === 'issue') mi_store_issuance_approval($cfg, $id, $approval, $signature);
  elseif ($kind === 'transfer') mi_store_transfer_approval($cfg, $id, $approval, $signature);
  else mi_fail(400, 'kind must be issue or transfer');
  mi_recover();
  return $kind === 'issue' ? mi_asset_view($id) : mi_transfer_view($id);
}
