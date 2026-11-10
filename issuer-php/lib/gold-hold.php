<?php
if (PHP_SAPI !== 'cli' && isset($_SERVER['SCRIPT_FILENAME']) && realpath($_SERVER['SCRIPT_FILENAME']) === __FILE__) { http_response_code(404); exit; } // include-only
// EXPERIMENTAL durable holds on Gold for a purchase of a Chainblock Labs coin (chain-labs/lib/purchase.php).
// Off unless lib/atlas-gold-hold-config.json says {"enabled": true, "tokenSha256": "<sha256 of the operator's token>"}.
//
// A purchase has several steps in several requests: the buyer's Gold is reserved, the coin is delivered on a ledger, and only then
// is the Gold spent. The per-request spend lock cannot span that, so a hold is a record the issuer itself enforces:
//
//   - While a hold is active, atlas_spend_lock() refuses every spend path and atlas_revoke_many() refuses every revocation of that
//     credential, whoever asks (a split, a trade, a clawback or the operator's own revoke). Only the finalize below can spend it.
//   - A hold is created only from an intent the OWNER signed (the ledger's atlas.ledger.purchase.intent, raw ECDSA). The issuer
//     verifies that signature itself and stores the signed intent; the caller's token alone can reserve nothing.
//   - It binds the credential, the owner, the price, the receiving ledger key, the ledger coin and the request id. Finalize takes none
//     of these from the caller: it spends exactly that price of exactly that credential, gives the rest back to the owner and burns
//     the price. Nobody can change the amount or the destination after the owner signed.
//
// States: held -> delivering -> finalized, or held/delivering -> cancelled.
//   held        reserved; no delivery has been attempted. Lapses by itself after ATLAS_HOLD_TTL_S, which is safe because
//               delivery starts only after `begin`.
//   delivering  the ledger is about to be asked (or has been). Never lapses on a timer: the delivery may already have committed,
//               so only finalize, or an explicit cancel by the ledger operator after it has ruled the delivery out, ends it.
//   finalized   the credential was spent in one journaled transaction (atlas_commit_replacement) that is repeatable after a crash.
//   cancelled   the Gold is free again.
// A hold survives separate requests and restarts: it is one JSON file replaced atomically under a lock. A hold list that is
// present but unreadable stops every spend (503); it is never read as empty.

require_once __DIR__ . '/replacement.php';

const ATLAS_HOLD_CLASS = 'atlas.element.gold';
const ATLAS_HOLD_TTL_S = 900;
const ATLAS_HOLD_MAX_PER_OWNER = 5;
const ATLAS_HOLD_MAX_ACTIVE = 500;
const ATLAS_HOLD_KEEP_S = 604800;
const ATLAS_HOLD_INTENT_MAX_S = 3600;

class AtlasHoldError extends Exception
{
    public $reason;
    public function __construct($reason, $message, $status)
    {
        parent::__construct($message, $status);
        $this->reason = $reason;
    }
}

function atlas_hold_config_file() { return __DIR__ . '/atlas-gold-hold-config.json'; }

// ['enabled' => bool, 'tokenSha256' => ?string]. Anything other than a clear opt-in is off.
function atlas_hold_config() {
    $cfg = ['enabled' => false, 'tokenSha256' => null];
    $file = atlas_hold_config_file();
    if (!is_file($file)) return $cfg;
    $f = json_decode((string) @file_get_contents($file), true);
    if (!is_array($f) || ($f['enabled'] ?? false) !== true) return $cfg;
    if (!is_string($f['tokenSha256'] ?? null) || !preg_match('/^[a-f0-9]{64}$/D', $f['tokenSha256'])) return $cfg;
    return ['enabled' => true, 'tokenSha256' => $f['tokenSha256']];
}

// ---------- the store ----------

function atlas_hold_dir() { return atlas_private_subdir('holds'); }
function atlas_hold_file() { return atlas_hold_dir() . '/holds.json'; }

function atlas_holds_unavailable($reason) {
    return new Exception('the Gold hold list ' . $reason . '; refusing to treat it as empty', 503);
}

// No file yet means no holds. A file that cannot be read means nothing can be said, so spends stop.
function atlas_holds_read() {
    $file = atlas_hold_file();
    clearstatcache(true, $file);
    if (!is_file($file)) return ['holds' => []];
    $text = @file_get_contents($file);
    if ($text === false) throw atlas_holds_unavailable('could not be read');
    $doc = json_decode($text, true);
    if (!is_array($doc) || !isset($doc['holds']) || !is_array($doc['holds'])) throw atlas_holds_unavailable('is not valid');
    return $doc;
}

// One locked read-modify-write and one atomic replace. $fn receives the document by reference and may return a value.
function atlas_holds_modify($fn) {
    atlas_private_subdir_ensure('holds');
    $lock = @fopen(atlas_hold_dir() . '/holds.lock', 'c');
    if ($lock === false) throw new Exception('could not take the hold lock', 503);
    flock($lock, LOCK_EX);
    try {
        $doc = atlas_holds_read();
        $before = json_encode($doc);
        $result = $fn($doc);
        $after = json_encode($doc);
        if ($after !== $before) {
            $out = $doc;
            $out['holds'] = (object) $doc['holds'];
            $text = json_encode($out, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
            if ($text === false) throw new Exception('could not encode the hold list', 503);
            atlas_write_file_atomic(atlas_hold_file(), $text, 0600);
        }
        return $result;
    } finally {
        flock($lock, LOCK_UN);
        fclose($lock);
    }
}

// held past its time and never begun is lapsed; everything else is as recorded.
function atlas_hold_effective($rec, $now) {
    if (($rec['state'] ?? null) === 'held' && $now > (int) $rec['expiresAt']) return 'lapsed';
    return (string) ($rec['state'] ?? '');
}

function atlas_hold_is_active($rec, $now) {
    return in_array(atlas_hold_effective($rec, $now), ['held', 'delivering'], true);
}

// The active hold on a credential, or null. Reads without the lock: the list is only ever replaced whole.
function atlas_hold_blocks($credentialId) {
    $dir = atlas_hold_dir();
    if (!is_file($dir . '/holds.json')) return null;
    $rec = atlas_holds_read()['holds'][$credentialId] ?? null;
    return is_array($rec) && atlas_hold_is_active($rec, time()) ? $rec : null;
}

// Set only by finalize for the length of its own revocation; nothing a caller sends can set it.
function atlas_hold_release_permit($set = null) {
    static $permit = null;
    if ($set !== null) $permit = $set === false ? null : $set;
    return $permit;
}

// Used by atlas_revoke_many(): refuses to revoke a credential that has an active hold, unless this is the hold's own finalize.
function atlas_hold_assert_revocable($ids) {
    foreach ($ids as $id) {
        $hold = atlas_hold_blocks($id);
        if ($hold === null) continue;
        $permit = atlas_hold_release_permit();
        if (is_array($permit) && $permit['credentialId'] === $id && $permit['holdId'] === $hold['holdId']) continue;
        throw new Exception('credential ' . $id . ' is held for a ledger purchase and cannot be revoked until that purchase is finished or cancelled', 409);
    }
}

// ---------- reserving ----------

function atlas_hold_is_ledger_key($key) {
    if (!is_string($key) || !preg_match('/^[A-Za-z0-9_-]{87}$/D', $key)) return false;
    $raw = b64url_decode($key);
    return is_string($raw) && strlen($raw) === 65 && $raw[0] === "\x04";
}

// What the owner signed, checked against the credential it names. Returns a reason, or null.
function atlas_hold_intent_problem($payload, $credential, $requestId, $now) {
    if (!is_array($payload)) return 'the intent has no payload';
    $keys = array_keys($payload);
    sort($keys);
    if ($keys !== ['coinId', 'credentialId', 'expiresAt', 'price', 'recipient', 'requestId', 'type', 'v']) return 'the intent has the wrong fields';
    if ($payload['type'] !== 'atlas.ledger.purchase.intent' || $payload['v'] !== 1) return 'the intent is not a ledger purchase';
    if (!is_string($payload['coinId']) || !preg_match('/^[a-f0-9]{32}$/D', $payload['coinId'])) return 'the intent names no ledger coin';
    if ($payload['credentialId'] !== ($credential['id'] ?? null)) return 'the intent names another credential';
    if (!is_int($payload['price']) || $payload['price'] < 1 || $payload['price'] > 1000000000) return 'the price is not a whole number of Gold';
    if (!atlas_hold_is_ledger_key($payload['recipient'])) return 'the recipient is not a ledger key';
    if (!is_string($payload['requestId']) || !preg_match('/^[a-f0-9]{32,64}$/D', $payload['requestId']) || $payload['requestId'] !== $requestId) return 'the intent names another request';
    if (!is_string($payload['expiresAt']) || !preg_match('/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/D', $payload['expiresAt'])) return 'the intent has no readable expiry';
    $expires = strtotime($payload['expiresAt']);
    if ($expires === false || $expires < $now) return 'the intent has expired';
    if ($expires > $now + ATLAS_HOLD_INTENT_MAX_S) return 'the intent is valid for too long';
    return null;
}

// Derived from the credential and the request, so the caller that reserved can address the hold again without storing anything.
function atlas_hold_id($credentialId, $requestId) {
    return substr(hash('sha256', 'atlas-gold-hold|' . $credentialId . '|' . $requestId), 0, 32);
}

function atlas_hold_intent_digest($intent) {
    return hash('sha256', canonicalize(['payload' => $intent['payload'], 'proof' => $intent['proof']]));
}

function atlas_hold_view($rec, $now) {
    return ['holdId' => $rec['holdId'], 'state' => atlas_hold_effective($rec, $now), 'credentialId' => $rec['credentialId'], 'requestId' => $rec['requestId'], 'coinId' => $rec['coinId'],
        'price' => $rec['price'], 'quantity' => $rec['quantity'], 'recipient' => $rec['recipient'], 'owner' => $rec['owner'], 'createdAt' => $rec['createdAt'], 'expiresAt' => gmdate('Y-m-d\TH:i:s\Z', (int) $rec['expiresAt']),
        'result' => $rec['result'] ?? null];
}

// $body: {credential, intent: {payload, proof}, requestId}. The credential is checked by the same function every spend uses.
function atlas_hold_reserve($kp, $body, $now) {
    $credential = $body['credential'] ?? null;
    $intent = $body['intent'] ?? null;
    $requestId = $body['requestId'] ?? null;
    if (!is_array($credential) || !is_array($intent) || !is_array($intent['payload'] ?? null) || !is_array($intent['proof'] ?? null) || !is_string($requestId)) {
        throw new AtlasHoldError('bad-request', 'credential, intent and requestId are required', 400);
    }
    $credId = $credential['id'] ?? null;
    if (!is_string($credId) || $credId === '') throw new AtlasHoldError('bad-request', 'the credential has no id', 400);
    $problem = atlas_hold_intent_problem($intent['payload'], $credential, $requestId, $now);
    if ($problem !== null) throw new AtlasHoldError('bad-intent', $problem, 400);
    $proof = $intent['proof'];
    $proofKeys = array_keys($proof);
    sort($proofKeys);
    if ($proofKeys !== ['publicKey', 'signature', 'signerRole'] || $proof['signerRole'] !== 'raw-ecdsa' || !is_string($proof['publicKey']) || !is_string($proof['signature'])) {
        throw new AtlasHoldError('owner-authorization-required', 'the intent must be signed by the owner with a raw ECDSA key', 403);
    }
    $owner = $proof['publicKey'];
    if (($credential['owner']['publicKey'] ?? null) !== $owner) throw new AtlasHoldError('not-owner', 'the intent was not signed by the owner of this credential', 403);
    if (!verify_envelope($intent['payload'], $proof)) throw new AtlasHoldError('owner-signature-invalid', 'the intent signature does not check out', 403);
    if (($credential['issuer']['domain'] ?? null) !== atlas_domain()) throw new AtlasHoldError('foreign-credential', 'only Gold issued by this domain can be held', 400);
    $price = $intent['payload']['price'];

    // The same lock every spender takes, so a spend in flight finishes (and revokes) before this looks, and a spend that
    // starts after this sees the hold. Taken without the hold check: a repeat of this request must reach the existing hold.
    $busy = atlas_spend_lock_stripe($credId);
    if ($busy !== null) throw new AtlasHoldError('busy', $busy, 503);
    $problem = check_presented_asset($kp['publicKeyB64url'], $credential, $owner, ATLAS_HOLD_CLASS, $price, false);
    if ($problem !== null) throw new AtlasHoldError(strpos($problem, 'revoked') !== false ? 'revoked' : (strpos($problem, 'suspended') !== false ? 'suspended' : 'invalid-credential'), $problem, 409);
    $digest = atlas_hold_intent_digest($intent);

    $view = atlas_holds_modify(function (&$doc) use ($credential, $credId, $intent, $owner, $price, $requestId, $now, $digest) {
        $holds = &$doc['holds'];
        foreach ($holds as $id => $h) {
            if (!is_array($h) || (!atlas_hold_is_active($h, $now) && $now - (int) $h['createdAt'] > ATLAS_HOLD_KEEP_S)) unset($holds[$id]);
        }
        $existing = $holds[$credId] ?? null;
        if ($existing !== null && atlas_hold_is_active($existing, $now)) {
            if ($existing['requestId'] === $requestId && $existing['intentDigest'] === $digest) return atlas_hold_view($existing, $now);
            throw new AtlasHoldError('held', 'this credential is already held for another purchase', 409);
        }
        foreach ($holds as $h) {
            if (atlas_hold_is_active($h, $now) && $h['requestId'] === $requestId) throw new AtlasHoldError('request-reused', 'this request id already holds another credential', 409);
        }
        // A signed intent is used once: after its hold ended it cannot be replayed to freeze the Gold again. A buyer who retries signs a new one.
        foreach ($holds as $h) {
            if (($h['intentDigest'] ?? null) === $digest || in_array($digest, $h['usedIntents'] ?? [], true)) throw new AtlasHoldError('intent-used', 'this signed intent was already used', 409);
        }
        $active = 0;
        $byOwner = 0;
        foreach ($holds as $h) {
            if (!atlas_hold_is_active($h, $now)) continue;
            $active++;
            if ($h['owner'] === $owner) $byOwner++;
        }
        if ($active >= ATLAS_HOLD_MAX_ACTIVE) throw new AtlasHoldError('too-many', 'too many holds are active', 429);
        if ($byOwner >= ATLAS_HOLD_MAX_PER_OWNER) throw new AtlasHoldError('too-many', 'this owner already has too many holds', 429);
        $rec = ['holdId' => atlas_hold_id($credId, $requestId), 'credentialId' => $credId, 'requestId' => $requestId, 'coinId' => $intent['payload']['coinId'], 'owner' => $owner,
            'price' => $price, 'quantity' => $credential['quantity'], 'recipient' => $intent['payload']['recipient'], 'class' => ATLAS_HOLD_CLASS,
            'intent' => ['payload' => $intent['payload'], 'proof' => $intent['proof']], 'intentDigest' => $digest, 'state' => 'held',
            // The key of the spend's journal and stored result. Secret and random, so no request id a caller picks can occupy it.
            'txnKey' => 'gold-hold:' . bin2hex(random_bytes(16)),
            'createdAt' => $now, 'expiresAt' => $now + ATLAS_HOLD_TTL_S];
        // Terminal records of this credential keep the intents they used.
        if ($existing !== null) $rec['usedIntents'] = array_values(array_unique(array_merge($existing['usedIntents'] ?? [], [$existing['intentDigest']])));
        $holds[$credId] = $rec;
        return atlas_hold_view($rec, $now);
    });
    atlas_fault_point('hold:reserved');
    return $view;
}

// ---------- the later steps ----------

// The hold a later step names: the credential, request id and hold id must all match what was reserved.
function atlas_hold_find($credId, $requestId, $holdId) {
    $rec = atlas_holds_read()['holds'][$credId] ?? null;
    if (!is_array($rec) || $rec['requestId'] !== $requestId || $rec['holdId'] !== $holdId) throw new AtlasHoldError('unknown-hold', 'no such hold', 404);
    return $rec;
}

function atlas_hold_set(&$doc, $credId, $holdId, $changes) {
    if (($doc['holds'][$credId]['holdId'] ?? null) !== $holdId) throw new AtlasHoldError('unknown-hold', 'no such hold', 404);
    $doc['holds'][$credId] = array_merge($doc['holds'][$credId], $changes);
}

// The ledger is about to be asked to deliver. From here the hold no longer lapses.
function atlas_hold_begin($credId, $requestId, $holdId, $now) {
    $busy = atlas_spend_lock_stripe($credId);
    if ($busy !== null) throw new AtlasHoldError('busy', $busy, 503);
    $view = atlas_holds_modify(function (&$doc) use ($credId, $requestId, $holdId, $now) {
        $rec = $doc['holds'][$credId] ?? null;
        if (!is_array($rec) || $rec['requestId'] !== $requestId || $rec['holdId'] !== $holdId) throw new AtlasHoldError('unknown-hold', 'no such hold', 404);
        $state = atlas_hold_effective($rec, $now);
        if ($state === 'delivering' || $state === 'finalized') return atlas_hold_view($rec, $now);
        if ($state === 'lapsed') throw new AtlasHoldError('hold-expired', 'the hold lapsed before delivery was begun', 410);
        if ($state !== 'held') throw new AtlasHoldError('not-held', 'the hold is ' . $state, 409);
        if (is_revoked($credId)) throw new AtlasHoldError('revoked', 'the credential has been revoked', 409);
        if (is_suspended($credId)) throw new AtlasHoldError('suspended', 'the credential is suspended', 409);
        $doc['holds'][$credId]['state'] = 'delivering';
        $doc['holds'][$credId]['deliveringAt'] = $now;
        return atlas_hold_view($doc['holds'][$credId], $now);
    });
    atlas_fault_point('hold:begun');
    return $view;
}

// Spends the held credential: the price is burned and the rest goes back to the owner, in one journaled transaction keyed by the
// hold, so a repeat after any crash gives the same answer and spends nothing twice.
function atlas_hold_finalize($kp, $credId, $requestId, $holdId, $now) {
    $busy = atlas_spend_lock_stripe($credId);
    if ($busy !== null) throw new AtlasHoldError('busy', $busy, 503);
    $rec = atlas_hold_find($credId, $requestId, $holdId);
    $key = $rec['txnKey'];
    $leaseBusy = atlas_lease('rid', $key);
    if ($leaseBusy !== null) throw new AtlasHoldError('busy', $leaseBusy, 503);
    try {
        atlas_txn_recover_key($key);
        $rec = atlas_hold_find($credId, $requestId, $holdId);
        $state = atlas_hold_effective($rec, $now);
        if ($state === 'finalized') return $rec['result'];
        if ($state !== 'delivering') throw new AtlasHoldError('not-delivering', 'the hold is ' . $state . '; delivery must be begun before it can be finalized', 409);
        $params = ['holdId' => $holdId, 'price' => $rec['price'], 'recipient' => $rec['recipient'], 'coinId' => $rec['coinId']];
        $prior = atlas_replay_lookup($key, 'ledger-purchase', [$credId], $params);
        if ($prior !== null && isset($prior['conflict'])) throw new AtlasHoldError('inconsistent', 'a stored result for this hold does not match it', 409);
        if ($prior !== null) {
            $response = json_decode($prior['responseJson'], true);
        } else {
            if (is_revoked($credId)) throw new AtlasHoldError('inconsistent', 'the credential is revoked but this hold has no stored result; it must be examined', 409);
            $remainderQty = (int) $rec['quantity'] - (int) $rec['price'];
            if ($remainderQty < 0) throw new AtlasHoldError('inconsistent', 'the hold is for more than the credential holds', 409);
            $remainder = $remainderQty > 0 ? mint_asset_by_class($kp['privateKey'], $kp['publicKeyB64url'], $rec['owner'], ATLAS_HOLD_CLASS, $remainderQty, $credId, null, true) : null;
            $response = ['ok' => true, 'holdId' => $holdId, 'requestId' => $requestId, 'revoked' => $credId, 'price' => $rec['price'], 'balance' => ['quantity' => $remainderQty, 'credential' => $remainder]];
            atlas_hold_release_permit(['credentialId' => $credId, 'holdId' => $holdId]);
            try {
                $json = atlas_commit_replacement($key, 'ledger-purchase', [$credId], 'ledger-purchase', $params, $remainder === null ? [] : [$remainder], $response);
            } finally {
                atlas_hold_release_permit(false);
            }
            $response = json_decode($json, true);
        }
        atlas_fault_point('hold:spent');
        atlas_holds_modify(function (&$doc) use ($credId, $holdId, $response, $now) {
            atlas_hold_set($doc, $credId, $holdId, ['state' => 'finalized', 'finalizedAt' => $now, 'result' => $response]);
        });
        return $response;
    } finally {
        atlas_lease_release('rid', $key);
    }
}

// Ends a hold without spending. A held one may always be cancelled. One that is delivering is cancelled only on the ledger operator's
// say-so (the ledger has ruled the delivery out), never by time. A spent one cannot be cancelled.
function atlas_hold_cancel($credId, $requestId, $holdId, $now, $deliveryRuledOut = false) {
    $busy = atlas_spend_lock_stripe($credId);
    if ($busy !== null) throw new AtlasHoldError('busy', $busy, 503);
    $rec = atlas_hold_find($credId, $requestId, $holdId);
    $key = $rec['txnKey'];
    $leaseBusy = atlas_lease('rid', $key);
    if ($leaseBusy !== null) throw new AtlasHoldError('busy', $leaseBusy, 503);
    try {
        atlas_txn_recover_key($key);
        $rec = atlas_hold_find($credId, $requestId, $holdId);
        $state = atlas_hold_effective($rec, $now);
        if ($state === 'cancelled') return atlas_hold_view($rec, $now);
        if ($state === 'finalized') throw new AtlasHoldError('finalized', 'the Gold was spent', 409);
        // A spend that committed but did not get to record itself is still a spend.
        if (is_revoked($credId)) throw new AtlasHoldError('finalized', 'the credential is spent; finalize the hold to record it', 409);
        if ($state === 'delivering' && $deliveryRuledOut !== true) {
            throw new AtlasHoldError('delivery-may-have-committed', 'delivery was begun for this hold; it can be cancelled only once the ledger has ruled the delivery out', 409);
        }
        $view = atlas_holds_modify(function (&$doc) use ($credId, $holdId, $now) {
            atlas_hold_set($doc, $credId, $holdId, ['state' => 'cancelled', 'cancelledAt' => $now]);
            return atlas_hold_view($doc['holds'][$credId], $now);
        });
        atlas_fault_point('hold:cancelled');
        return $view;
    } finally {
        atlas_lease_release('rid', $key);
    }
}

function atlas_hold_status($credId, $requestId, $holdId, $now) {
    return atlas_hold_view(atlas_hold_find($credId, $requestId, $holdId), $now);
}

// ---------- the endpoint ----------

function atlas_hold_authorized() {
    $cfg = atlas_hold_config();
    if (!$cfg['enabled']) return false;
    $h = $_SERVER['HTTP_AUTHORIZATION'] ?? ($_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '');
    if (!is_string($h) || !preg_match('/^Bearer ([A-Za-z0-9._~+\/=-]{16,200})$/D', $h, $m)) return false;
    return hash_equals($cfg['tokenSha256'], hash('sha256', $m[1]));
}

// POST /atlas/ledger/gold-hold. The token says which caller may ask; it never stands in for the owner. A hold can be made only
// from an intent the owner signed, and the only spend is the one that intent describes.
function atlas_hold_endpoint() {
    require_post();
    if (!atlas_hold_config()['enabled']) send_json(404, ['error' => 'not found', 'code' => 'disabled']);
    if (!atlas_hold_authorized()) send_json(401, ['error' => 'a valid operator token is required', 'code' => 'unauthorized']);
    $body = read_json_body(65536);
    $action = $body['action'] ?? null;
    $now = time();
    try {
        $kp = atlas_load_keys();
        if ($action === 'reserve') send_json(200, ['ok' => true, 'hold' => atlas_hold_reserve($kp, $body, $now)]);
        $credId = $body['credentialId'] ?? null;
        $requestId = $body['requestId'] ?? null;
        $holdId = $body['holdId'] ?? null;
        if (!is_string($credId) || !is_string($requestId) || !is_string($holdId) || $credId === '' || $requestId === '' || $holdId === '') {
            send_json(400, ['error' => 'credentialId, requestId and holdId are required', 'code' => 'bad-request']);
        }
        if ($action === 'begin') send_json(200, ['ok' => true, 'hold' => atlas_hold_begin($credId, $requestId, $holdId, $now)]);
        if ($action === 'finalize') send_json(200, ['ok' => true, 'result' => atlas_hold_finalize($kp, $credId, $requestId, $holdId, $now)]);
        if ($action === 'cancel') send_json(200, ['ok' => true, 'hold' => atlas_hold_cancel($credId, $requestId, $holdId, $now, ($body['deliveryRuledOut'] ?? false) === true)]);
        if ($action === 'status') send_json(200, ['ok' => true, 'hold' => atlas_hold_status($credId, $requestId, $holdId, $now)]);
        send_json(400, ['error' => 'unknown action', 'code' => 'bad-request']);
    } catch (AtlasHoldError $e) {
        send_json($e->getCode(), ['error' => $e->getMessage(), 'code' => $e->reason]);
    } catch (Exception $e) {
        $c = (int) $e->getCode();
        send_json($c >= 400 && $c < 600 ? $c : 500, ['error' => $e->getMessage(), 'code' => 'unavailable']);
    }
}
