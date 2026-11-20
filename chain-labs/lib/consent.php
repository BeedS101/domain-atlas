<?php
declare(strict_types=1);
// A partner domain's consent to the genesis of a multi authority coin. The authority proposes a coin; a partner records the proposal and does
// not sign it. Its operator reviews the terms and accepts or declines with a signed operator request (spend34 consent-list, consent-accept,
// consent-decline). The partner signs the genesis only for a coin whose record says accepted, and only for the genesis digest that was accepted.
//
// Rules that hold throughout:
//   - A pending coin with no record, a record for another digest, a missing table or marker, or a record that cannot be read or written, is
//     never signed. Each of these answers consent-unavailable. An operator's explicit acceptance of the exact coin and digest repairs a
//     single missing or mismatched record; nothing repairs it automatically.
//   - `legacy` is the one status that signs without acceptance, and only the database upgrade can give it (ledger_consent_schema): it marks
//     the coins that were already pending, and already answered with a signature, before this existed.
//   - Once a signature was issued (signed_at) the proposal cannot be declined: the authority may open the coin at any later time.
//   - Declined proposals are bounded: past CONSENT_MAX_DECLINED the oldest are forgotten completely. Nothing was ever signed for them, so an
//     authority that sends one again makes a new proposal, awaiting consent.
// Include-only: a direct request gets a 404.
if (PHP_SAPI !== 'cli' && isset($_SERVER['SCRIPT_FILENAME']) && realpath($_SERVER['SCRIPT_FILENAME']) === __FILE__) { http_response_code(404); exit; }
require_once __DIR__ . '/ledger.php';

const CONSENT_MAX_DECLINED = 25;
const CONSENT_REASON_MAX = 200;
const CONSENT_NOTE = 'Reported by the partner domain itself. It records that an operator there accepted the proposal; it is not independent evidence of who approved it.';
const CONSENT_ECHO_STATUSES = ['accepted', 'predates-upgrade'];

function consent_iso(?int $time): ?string
{
    return $time === null ? null : gmdate('Y-m-d\TH:i:s\Z', $time);
}

function consent_unavailable(string $why): never
{
    ledger_fail('consent-unavailable', 'The consent records of this domain cannot be used (' . $why . '), so nothing was signed.');
}

// Both tables and the upgrade marker must be there. A partial set is ambiguous and is never installed over by itself.
function consent_ready(PDO $db): void
{
    try {
        $have = $db->query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('ledger_consents','ledger_consent_meta')")->fetchAll(PDO::FETCH_COLUMN);
        if (count($have) !== 2) consent_unavailable('a table is missing');
        if ((int) $db->query('SELECT COUNT(*) FROM ledger_consent_meta')->fetchColumn() !== 1) consent_unavailable('the upgrade marker is missing');
    } catch (LedgerError $e) {
        throw $e;
    } catch (Throwable $e) {
        consent_unavailable('they cannot be read');
    }
}

function consent_row(PDO $db, string $coinId): ?array
{
    try {
        $q = $db->prepare('SELECT * FROM ledger_consents WHERE coin_id=?');
        $q->execute([$coinId]);
        $row = $q->fetch(PDO::FETCH_ASSOC);
        $q->closeCursor();
        return $row ?: null;
    } catch (PDOException $e) {
        consent_unavailable('a record cannot be read');
    }
}

// The decision for a genesis a partner is asked to sign again, for a coin it holds as pending. Runs inside the caller's transaction. Returns
// ['sign'|'awaiting'|'declined', the consent report for the authority or null].
function consent_decide_signature(PDO $db, string $coinId, string $digest, int $now): array
{
    $row = consent_row($db, $coinId);
    if ($row === null || $row['genesis_digest'] !== $digest) consent_unavailable('this coin has no record that matches it');
    if ($row['status'] === 'legacy') return ['sign', ['status' => 'predates-upgrade', 'recordedAt' => null]];
    if ($row['status'] === 'accepted') {
        $db->prepare('UPDATE ledger_consents SET signed_at=? WHERE coin_id=? AND signed_at IS NULL')->execute([$now, $coinId]);
        return ['sign', ['status' => 'accepted', 'recordedAt' => consent_iso((int) $row['decided_at'])]];
    }
    return [$row['status'] === 'declined' ? 'declined' : 'awaiting', null];
}

// What a partner tells the authority when it signs: whether consent was recorded and when. Null for a coin with no record (one that was open
// before consent existed).
function consent_echo_for(PDO $db, string $coinId): ?array
{
    $row = consent_row($db, $coinId);
    if ($row === null) return null;
    if ($row['status'] === 'legacy') return ['status' => 'predates-upgrade', 'recordedAt' => null];
    if ($row['status'] === 'accepted') return ['status' => 'accepted', 'recordedAt' => consent_iso((int) $row['decided_at'])];
    return null;
}

function consent_add_proposal(PDO $db, string $coinId, string $digest, int $now): void
{
    $db->prepare("INSERT INTO ledger_consents(coin_id,genesis_digest,status,received_at) VALUES(?,?,'awaiting',?)")->execute([$coinId, $digest, $now]);
}

// The proposals this domain holds that count toward the limit on waiting coins: every pending coin that was not declined.
function consent_waiting_count(PDO $db): int
{
    return (int) $db->query("SELECT COUNT(*) FROM ledger_coins c WHERE c.state='pending' AND NOT EXISTS (SELECT 1 FROM ledger_consents k WHERE k.coin_id=c.coin_id AND k.status='declined')")->fetchColumn();
}

// ---------- the review ----------

function consent_coins(string $units, int $decimals): string
{
    if ($decimals === 0) return $units;
    $padded = str_pad($units, $decimals + 1, '0', STR_PAD_LEFT);
    return substr($padded, 0, -$decimals) . '.' . substr($padded, -$decimals);
}

function consent_key_fingerprint(string $pem): string
{
    return substr(hash('sha256', (string) preg_replace('/\s+/', '', $pem)), 0, 16);
}

// One proposal as its operator reads it: where it stands, what can still be done, and every term of the genesis. The reference secret of a
// private coin is not in a genesis and is never added here; the review shows the hash the genesis carries.
function consent_review(array $coin, ?array $row, string $domain): array
{
    $g = $coin['genesis'];
    $usable = $row !== null && $row['genesis_digest'] === $coin['genesis_digest'];
    $status = $usable ? $row['status'] : 'unrecorded';
    $signed = $status === 'legacy' || ($usable && $row['signed_at'] !== null);
    $roster = [];
    foreach ($g['roster'] as $member) {
        $roster[] = ['domain' => $member['domain'], 'keyFingerprint' => consent_key_fingerprint($member['key']), 'authority' => $member['domain'] === $g['authority'], 'thisDomain' => $member['domain'] === $domain];
    }
    $terms = [
        'symbol' => $g['symbol'], 'name' => $g['name'], 'decimals' => $g['decimals'], 'mode' => $g['mode'], 'visibility' => $g['visibility'],
        'maxUnits' => $g['maxUnits'], 'initialUnits' => $g['initialUnits'],
        'maxSupply' => consent_coins($g['maxUnits'], (int) $g['decimals']), 'initialSupply' => consent_coins($g['initialUnits'], (int) $g['decimals']),
        'authority' => $g['authority'], 'threshold' => $g['threshold'], 'approvals' => $g['threshold'] . ' of ' . count($g['roster']),
        'roster' => $roster, 'treasuryRef' => $g['treasuryRef'], 'faucet' => $g['faucet'] ?? null, 'purchase' => $g['purchase'] ?? null,
        'createdAt' => $g['createdAt'],
    ];
    if (isset($g['refSecretHash'])) $terms['refSecretHash'] = $g['refSecretHash'];
    return [
        'coinId' => $coin['coin_id'], 'genesisDigest' => $coin['genesis_digest'], 'status' => $status, 'signed' => $signed,
        'canAccept' => in_array($status, ['awaiting', 'declined', 'unrecorded'], true),
        'canDecline' => in_array($status, ['awaiting', 'accepted', 'unrecorded'], true) && !$signed,
        'receivedAt' => $usable ? consent_iso((int) $row['received_at']) : null,
        'decidedAt' => $usable ? consent_iso($row['decided_at'] === null ? null : (int) $row['decided_at']) : null,
        'decidedBy' => $usable ? $row['decided_by'] : null, 'reason' => $usable ? $row['reason'] : null,
        'signedAt' => $usable ? consent_iso($row['signed_at'] === null ? null : (int) $row['signed_at']) : null,
        'terms' => $terms,
    ];
}

// A coin this domain holds as a proposal from another domain's authority: pending, of several domains, naming this domain.
function consent_is_proposal(array $coin, string $domain): bool
{
    return $coin['state'] === 'pending' && $coin['mode'] === 'multi' && $coin['genesis']['authority'] !== $domain && ledger_roster_key($coin['genesis'], $domain) !== null;
}

function consent_list(PDO $db, array $node): array
{
    consent_ready($db);
    $out = [];
    try {
        $ids = $db->query("SELECT coin_id FROM ledger_coins WHERE state='pending' AND mode='multi' ORDER BY rowid")->fetchAll(PDO::FETCH_COLUMN);
        foreach ($ids as $id) {
            $coin = ledger_coin($db, (string) $id);
            if (consent_is_proposal($coin, $node['domain'])) $out[] = consent_review($coin, consent_row($db, (string) $id), $node['domain']);
        }
    } catch (PDOException $e) {
        consent_unavailable('they cannot be read');
    }
    return $out;
}

// ---------- the operator's decision ----------

function consent_decide(PDO $db, array $node, string $coinId, string $digest, string $verb, ?string $reason, string $by, int $now): array
{
    if (!preg_match('/^[a-f0-9]{32}$/D', $coinId) || !preg_match('/^[a-f0-9]{64}$/D', $digest)) ledger_fail('bad-request', 'a coin id and a genesis digest are needed');
    consent_ready($db);
    if ($reason !== null) $reason = substr((string) preg_replace('/[\x00-\x1F\x7F]/', '', $reason), 0, CONSENT_REASON_MAX);
    try {
        $db->exec('BEGIN IMMEDIATE');
        try {
            $q = $db->prepare('SELECT coin_id FROM ledger_coins WHERE coin_id=?');
            $q->execute([$coinId]);
            $held = $q->fetchColumn();
            $q->closeCursor();
            if ($held === false) ledger_fail('unknown-coin', 'this domain holds no such proposal');
            $coin = ledger_coin($db, $coinId);
            if ($coin['mode'] !== 'multi' || $coin['genesis']['authority'] === $node['domain'] || ledger_roster_key($coin['genesis'], $node['domain']) === null) ledger_fail('unknown-coin', 'this domain holds no such proposal');
            if ($coin['state'] !== 'pending') ledger_fail('not-pending', 'the coin is already open');
            if ($coin['genesis_digest'] !== $digest) ledger_fail('consent-mismatch', 'the genesis digest is not the one of this coin');
            $row = consent_row($db, $coinId);
            $usable = $row !== null && $row['genesis_digest'] === $digest;
            $status = $usable ? $row['status'] : 'unrecorded';
            if ($verb === 'accept') {
                if ($status === 'legacy' || $status === 'accepted') {
                    // Nothing to change: it was accepted, or signed before consent existed.
                } else {
                    $db->prepare("INSERT OR REPLACE INTO ledger_consents(coin_id,genesis_digest,status,received_at,decided_at,decided_by,reason,signed_at) VALUES(?,?,'accepted',?,?,?,NULL,NULL)")
                        ->execute([$coinId, $digest, $usable ? (int) $row['received_at'] : $now, $now, $by]);
                }
            } else {
                $signed = $status === 'legacy' || ($usable && $row['signed_at'] !== null);
                if ($signed) ledger_fail('already-signed', 'a signature for this genesis was already issued, so it can no longer be declined; the authority may open the coin at any time');
                if ($status !== 'declined') {
                    $db->prepare("INSERT OR REPLACE INTO ledger_consents(coin_id,genesis_digest,status,received_at,decided_at,decided_by,reason,signed_at) VALUES(?,?,'declined',?,?,?,?,NULL)")
                        ->execute([$coinId, $digest, $usable ? (int) $row['received_at'] : $now, $now, $by, $reason]);
                    consent_evict_declined($db);
                }
            }
            $review = null;
            $kept = $db->prepare('SELECT coin_id FROM ledger_coins WHERE coin_id=?');
            $kept->execute([$coinId]);
            if ($kept->fetchColumn() !== false) $review = consent_review(ledger_coin($db, $coinId), consent_row($db, $coinId), $node['domain']);
            $db->exec('COMMIT');
            return $review ?? ['coinId' => $coinId, 'genesisDigest' => $digest, 'status' => 'declined', 'signed' => false, 'canAccept' => false, 'canDecline' => false];
        } catch (Throwable $e) {
            ledger_rollback($db);
            throw $e;
        }
    } catch (PDOException $e) {
        consent_unavailable('a record cannot be written');
    }
}

function consent_accept(PDO $db, array $node, string $coinId, string $digest, string $by, int $now): array
{
    return consent_decide($db, $node, $coinId, $digest, 'accept', null, $by, $now);
}

function consent_decline(PDO $db, array $node, string $coinId, string $digest, ?string $reason, string $by, int $now): array
{
    return consent_decide($db, $node, $coinId, $digest, 'decline', $reason, $by, $now);
}

// Past the limit, the oldest declined proposals are forgotten: the coin as this domain holds it, and every row that was made for it.
// Only a pending coin that nothing was signed for is ever removed here.
function consent_evict_declined(PDO $db): void
{
    $count = (int) $db->query("SELECT COUNT(*) FROM ledger_consents WHERE status='declined'")->fetchColumn();
    if ($count <= CONSENT_MAX_DECLINED) return;
    $old = $db->prepare("SELECT k.coin_id FROM ledger_consents k JOIN ledger_coins c ON c.coin_id=k.coin_id WHERE k.status='declined' AND k.signed_at IS NULL AND c.state='pending' ORDER BY k.decided_at, k.rowid LIMIT ?");
    $old->bindValue(1, $count - CONSENT_MAX_DECLINED, PDO::PARAM_INT);
    $old->execute();
    foreach ($old->fetchAll(PDO::FETCH_COLUMN) as $coinId) {
        foreach (['ledger_genesis_sigs', 'ledger_catchup', 'ledger_authority_heads', 'ledger_consents', 'ledger_coins'] as $table) {
            $db->prepare('DELETE FROM ' . $table . ' WHERE coin_id=?')->execute([$coinId]);
        }
    }
}

// ---------- what the authority learns ----------

function consent_report_save(PDO $db, string $coinId, string $domain, mixed $echo, int $now): void
{
    $status = 'not-reported';
    $recorded = null;
    if (is_array($echo) && in_array($echo['status'] ?? null, CONSENT_ECHO_STATUSES, true)) {
        $status = $echo['status'];
        $at = is_string($echo['recordedAt'] ?? null) ? strtotime($echo['recordedAt']) : false;
        if ($at !== false) $recorded = $at;
    }
    try {
        $db->prepare('INSERT OR REPLACE INTO ledger_consent_reports(coin_id,domain,status,recorded_at,reported_at) VALUES(?,?,?,?,?)')->execute([$coinId, $domain, $status, $recorded, $now]);
    } catch (PDOException $e) {
        // What a partner reported is for the operator to read; failing to keep it does not stop a coin from opening.
    }
}

function consent_reports(PDO $db, string $coinId): array
{
    $out = [];
    try {
        $q = $db->prepare('SELECT domain,status,recorded_at,reported_at FROM ledger_consent_reports WHERE coin_id=? ORDER BY domain');
        $q->execute([$coinId]);
        foreach ($q->fetchAll(PDO::FETCH_ASSOC) as $r) {
            $out[$r['domain']] = ['status' => $r['status'], 'recordedAt' => consent_iso($r['recorded_at'] === null ? null : (int) $r['recorded_at']), 'reportedAt' => consent_iso((int) $r['reported_at'])];
        }
    } catch (PDOException $e) {
    }
    return $out;
}

// The partners of a coin as the authority's operator reads them: which signed, what each reported about its consent, and who is still waiting.
function consent_partner_view(PDO $db, string $coinId, array $waiting = []): array
{
    $coin = ledger_coin($db, $coinId);
    $sigs = $db->prepare('SELECT domain FROM ledger_genesis_sigs WHERE coin_id=?');
    $sigs->execute([$coinId]);
    $signed = array_flip($sigs->fetchAll(PDO::FETCH_COLUMN));
    $reports = consent_reports($db, $coinId);
    $view = [];
    foreach ($coin['genesis']['roster'] as $member) {
        $domain = $member['domain'];
        if ($domain === $coin['genesis']['authority']) continue;
        $has = isset($signed[$domain]);
        $view[] = ['domain' => $domain, 'signed' => $has && !isset($waiting[$domain]), 'state' => $waiting[$domain] ?? ($has ? 'signed' : 'not-asked'),
            'consent' => $has ? ($reports[$domain] ?? ['status' => 'not-reported', 'recordedAt' => null]) : null, 'note' => CONSENT_NOTE];
    }
    return $view;
}
