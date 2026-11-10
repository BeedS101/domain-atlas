<?php
declare(strict_types=1);
// Spending and lookups on top of the ledger store (lib/ledger.php): owner proposals kept until they execute, execution by
// the authority of a single authority coin, receipts a wallet can verify, recovery after a crash, and the signed holdings
// statement a wallet asks for. Include-only: a direct request gets a 404.
if (PHP_SAPI !== 'cli' && isset($_SERVER['SCRIPT_FILENAME']) && realpath($_SERVER['SCRIPT_FILENAME']) === __FILE__) { http_response_code(404); exit; }
require_once __DIR__ . '/ledger.php';

const SPEND_CHALLENGE_SECONDS = 120;
const SPEND_MAX_OPEN_CHALLENGES = 5000;
const SPEND_HOLDINGS_MAX_COINS = 50;

// The digest that names a proposal: the canonical payload the owner signed.
// Reasons that close a proposal for good, as opposed to failures that leave it pending for a retry.
const SPEND_FINAL_REASONS = ['expired', 'stale', 'insufficient', 'replayed', 'bad-signature', 'bad-authorization', 'no-account', 'faucet-amount', 'faucet-limit',
    'duplicate-purchase', 'purchase-key-limit', 'purchase-day-limit', 'purchase-too-small', 'bad-purchase', 'no-purchase-policy', 'revoked-credential'];

function spend_digest(array $authorization): string
{
    $payload = $authorization['payload'] ?? null;
    if (!is_array($payload)) ledger_fail('bad-authorization', 'the authorization has no payload');
    return ledger_digest($payload);
}

function spend_proposal(PDO $db, string $coinId, string $digest): ?array
{
    $row = $db->prepare('SELECT * FROM ledger_proposals WHERE coin_id=? AND digest=?');
    $row->execute([$coinId, $digest]);
    $found = $row->fetch(PDO::FETCH_ASSOC);
    return $found ?: null;
}

function spend_view(array $row): array
{
    return ['digest' => $row['digest'], 'status' => $row['status'], 'index' => $row['executed_index'] === null ? null : (int) $row['executed_index'], 'reason' => $row['reason']];
}

// Proposals that ran past their expiry stop blocking their sender.
function spend_expire(PDO $db, string $coinId, int $now): void
{
    $rows = $db->prepare("SELECT digest,authorization_json FROM ledger_proposals WHERE coin_id=? AND status='pending'");
    $rows->execute([$coinId]);
    foreach ($rows->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $auth = json_decode($row['authorization_json'], true);
        $expires = is_array($auth) ? strtotime((string) ($auth['payload']['expiresAt'] ?? '')) : false;
        if ($expires === false || $now >= $expires) {
            $db->prepare("UPDATE ledger_proposals SET status='expired', reason='expired' WHERE coin_id=? AND digest=? AND status='pending'")->execute([$coinId, $row['digest']]);
        }
    }
}

// Takes an owner's signed proposal. It is validated against the current state like a spend and stored as pending; one
// pending proposal per sender. The same proposal again is answered with the first one's state.
function spend_submit(PDO $db, string $coinId, array $authorization, int $now): array
{
    $digest = spend_digest($authorization);
    $known = spend_proposal($db, $coinId, $digest);
    if ($known) return spend_view($known);
    spend_expire($db, $coinId, $now);
    ledger_prepare_transfer($db, $coinId, $authorization, max($now, ledger_head_time($db, $coinId)));
    $payload = $authorization['payload'];
    try {
        $db->prepare("INSERT INTO ledger_proposals(coin_id,digest,from_key,nonce,authorization_json,status,created_at) VALUES(?,?,?,?,?,'pending',?)")
            ->execute([$coinId, $digest, $payload['from'], $payload['nonce'], ledger_canonical($authorization), $now]);
    } catch (PDOException $e) {
        if (!str_contains($e->getMessage(), 'UNIQUE')) throw $e;
        $raced = spend_proposal($db, $coinId, $digest);
        if ($raced) return spend_view($raced);
        if (str_contains($e->getMessage(), 'from_key') && !str_contains($e->getMessage(), 'nonce')) ledger_fail('pending-exists', 'the sender already has a proposal waiting');
        ledger_fail('replayed', 'this nonce was already used');
    }
    return spend_view(spend_proposal($db, $coinId, $digest) ?? []);
}

function spend_reject(PDO $db, string $coinId, string $digest, string $status, string $reason): void
{
    $db->prepare("UPDATE ledger_proposals SET status=?, reason=? WHERE coin_id=? AND digest=? AND status='pending'")->execute([$status, $reason, $coinId, $digest]);
}

// Executes a pending proposal of a single authority coin: checks it again against the current state, has the authority
// sign it and writes it. Executing an executed proposal returns its receipt; a proposal that can no longer succeed is
// closed with the reason. A coin with more than one domain needs the other approvals and is not executed here.
function spend_execute(PDO $db, string $coinId, string $digest, string $authorityPrivatePem, int $now): array
{
    $coin = ledger_coin($db, $coinId);
    if ($coin['mode'] !== 'single') ledger_fail('needs-approvals', 'a multi authority coin needs approvals from the other domains');
    $row = spend_proposal($db, $coinId, $digest);
    if (!$row) ledger_fail('unknown-proposal', 'no such proposal');
    if ($row['status'] === 'executed') return spend_receipt($db, $coinId, (int) $row['executed_index']);
    if ($row['status'] !== 'pending') ledger_fail('closed', 'the proposal is ' . $row['status'] . ($row['reason'] ? ': ' . $row['reason'] : ''));
    $authorization = json_decode($row['authorization_json'], true);
    // Another entry written between preparing and committing moves the head; the proposal is prepared again on the new
    // head, unless that other process has already executed this very proposal.
    for ($attempt = 0;; $attempt++) {
        try {
            // A request that started earlier than the entry just written executes at that entry's time, not before it.
            $clock = max($now, ledger_head_time($db, $coinId));
            $prepared = ledger_prepare_transfer($db, $coinId, $authorization, $clock);
            $done = ledger_commit($db, $coinId, $prepared, ledger_sign($authorityPrivatePem, $prepared['hash']), [], $clock);
            break;
        } catch (LedgerError $e) {
            $current = spend_proposal($db, $coinId, $digest);
            if ($current && $current['status'] === 'executed') return spend_receipt($db, $coinId, (int) $current['executed_index']);
            if (in_array($e->reason, ['wrong-index', 'wrong-prev'], true) && $attempt < 8) { usleep(10000 * ($attempt + 1)); continue; }
            // A transient failure leaves the proposal pending for a retry; a final one closes it.
            if (in_array($e->reason, SPEND_FINAL_REASONS, true)) {
                spend_reject($db, $coinId, $digest, $e->reason === 'expired' ? 'expired' : 'rejected', $e->reason);
            }
            throw $e;
        }
    }
    return spend_receipt($db, $coinId, $done['index']);
}

// Submits a proposal and executes it at once. The proposal stays stored if the process stops in between, and recovery
// finishes it.
function spend_submit_and_execute(PDO $db, string $coinId, array $authorization, string $authorityPrivatePem, int $now): array
{
    $state = spend_submit($db, $coinId, $authorization, $now);
    return spend_execute($db, $coinId, $state['digest'], $authorityPrivatePem, $now);
}

// After a crash: expire what ran out, then execute every proposal that is still valid, oldest first. Returns what each
// pending proposal came to.
function spend_recover(PDO $db, string $coinId, string $authorityPrivatePem, int $now): array
{
    spend_expire($db, $coinId, $now);
    $rows = $db->prepare("SELECT digest FROM ledger_proposals WHERE coin_id=? AND status='pending' ORDER BY created_at, rowid");
    $rows->execute([$coinId]);
    $out = [];
    foreach ($rows->fetchAll(PDO::FETCH_COLUMN) as $digest) {
        try {
            $receipt = spend_execute($db, $coinId, $digest, $authorityPrivatePem, $now);
            $out[$digest] = 'executed at ' . $receipt['entry']['index'];
        } catch (LedgerError $e) {
            $out[$digest] = $e->reason;
        }
    }
    return $out;
}

// The signed log entry: its public form, hash, the authority's signature and the approvals. A private coin's receipt
// carries references, never keys.
function spend_receipt(PDO $db, string $coinId, int $index): array
{
    $row = $db->prepare('SELECT * FROM ledger_log WHERE coin_id=? AND idx=?');
    $row->execute([$coinId, $index]);
    $found = $row->fetch(PDO::FETCH_ASSOC);
    if (!$found) ledger_fail('unknown-entry', 'no such entry');
    return ['coinId' => $coinId, 'entry' => json_decode($found['public_json'], true), 'hash' => $found['hash'], 'authoritySignature' => $found['authority_sig'],
        'approvals' => json_decode($found['approvals_json'], true)];
}

// What a wallet does with a receipt: the hash is the digest of the entry, the authority signed it, and, when the
// previous hash is known, the entry extends it.
function spend_verify_receipt(array $receipt, string $authorityPublicPem, ?string $previousHash = null): bool
{
    $entry = $receipt['entry'] ?? null;
    if (!is_array($entry) || !is_string($receipt['hash'] ?? null) || ledger_digest($entry) !== $receipt['hash']) return false;
    if (!ledger_verify($authorityPublicPem, $receipt['hash'], $receipt['authoritySignature'] ?? null)) return false;
    return $previousHash === null || ($entry['prevHash'] ?? null) === $previousHash;
}

// ---------- the holdings lookup ----------

// A fresh single-use challenge for a request that asks for private coins.
function spend_challenge_issue(PDO $db, int $now): array
{
    $db->prepare('DELETE FROM ledger_challenges WHERE expires_at < ?')->execute([$now]);
    if ((int) $db->query('SELECT COUNT(*) FROM ledger_challenges')->fetchColumn() >= SPEND_MAX_OPEN_CHALLENGES) ledger_fail('busy', 'too many open challenges');
    $challenge = bin2hex(random_bytes(16));
    $db->prepare('INSERT INTO ledger_challenges(challenge,expires_at,used) VALUES(?,?,0)')->execute([$challenge, $now + SPEND_CHALLENGE_SECONDS]);
    return ['challenge' => $challenge, 'expiresAt' => gmdate('Y-m-d\TH:i:s\Z', $now + SPEND_CHALLENGE_SECONDS)];
}

function spend_challenge_consume(PDO $db, string $challenge, int $now): void
{
    $used = $db->prepare('UPDATE ledger_challenges SET used=1 WHERE challenge=? AND used=0 AND expires_at >= ?');
    $used->execute([$challenge, $now]);
    if ($used->rowCount() !== 1) ledger_fail('bad-challenge', 'the challenge is unknown, used or expired');
}

// $request is null for a plain lookup, which sees public coins only, or the owner's signed request
// ['payload' => ['type' => 'atlas.ledger.holdings.request', 'v' => 1, 'domain', 'key', 'challenge'], 'signature'], which
// also sees the owner's private coins. Returns ['statement', 'signature'], the statement signed by the domain.
function spend_holdings(PDO $db, string $domain, string $domainPrivatePem, string $key, ?array $request, int $now): array
{
    if (!ledger_valid_owner_key($key)) ledger_fail('bad-key', 'the key is not a wallet public key');
    $proven = false;
    if ($request !== null) {
        $payload = $request['payload'] ?? null;
        if (!is_array($payload) || array_is_list($payload)) ledger_fail('bad-request', 'the request has no payload');
        $fields = array_keys($payload);
        sort($fields);
        if ($fields !== ['challenge', 'domain', 'key', 'type', 'v']) ledger_fail('bad-request', 'the request has the wrong fields');
        if ($payload['type'] !== 'atlas.ledger.holdings.request' || $payload['v'] !== 1 || $payload['domain'] !== $domain || $payload['key'] !== $key) ledger_fail('bad-request', 'the request is not for this domain and key');
        if (!is_string($payload['challenge']) || !preg_match('/^[a-f0-9]{32}$/D', $payload['challenge'])) ledger_fail('bad-challenge', 'the challenge is malformed');
        if (!ledger_owner_verify(ledger_canonical($payload), $key, $request['signature'] ?? null)) ledger_fail('bad-signature', 'the request signature does not verify');
        spend_challenge_consume($db, $payload['challenge'], $now);
        $proven = true;
    }
    $coins = [];
    $rows = $db->query("SELECT coin_id FROM ledger_coins WHERE state IN ('active','frozen') ORDER BY coin_id");
    foreach ($rows->fetchAll(PDO::FETCH_COLUMN) as $coinId) {
        $coin = ledger_coin($db, $coinId);
        if ($coin['visibility'] === 'private' && !$proven) continue;
        $account = ledger_account_row($db, $coinId, $key);
        if (!$account) continue;
        $head = ledger_head($db, $coinId);
        $genesis = $coin['genesis'];
        $coins[] = ['coinId' => $coinId, 'symbol' => $genesis['symbol'], 'decimals' => $genesis['decimals'], 'visibility' => $genesis['visibility'], 'mode' => $genesis['mode'],
            'threshold' => $genesis['threshold'], 'roster' => count($genesis['roster']), 'state' => $coin['state'], 'units' => (string) $account['units'], 'seq' => (int) $account['seq'],
            'headIndex' => $head['index'], 'headHash' => $head['hash']];
        if (count($coins) >= SPEND_HOLDINGS_MAX_COINS) break;
    }
    usort($coins, fn($a, $b) => [$a['symbol'], $a['coinId']] <=> [$b['symbol'], $b['coinId']]);
    $statement = ['type' => 'atlas.ledger.holdings', 'v' => 1, 'domain' => $domain, 'key' => $key, 'asOf' => gmdate('Y-m-d\TH:i:s\Z', $now), 'proven' => $proven, 'coins' => $coins];
    return ['statement' => $statement, 'signature' => ledger_sign($domainPrivatePem, ledger_canonical($statement))];
}

// What a wallet does with the answer: the statement is signed by the pinned domain key, names the domain and the key it
// asked about, is not older than $maxAge seconds and is not dated in the future.
function spend_verify_holdings(array $answer, string $domainPublicPem, string $domain, string $key, int $now, int $maxAge = 300): bool
{
    $statement = $answer['statement'] ?? null;
    if (!is_array($statement) || ($statement['type'] ?? null) !== 'atlas.ledger.holdings' || ($statement['domain'] ?? null) !== $domain || ($statement['key'] ?? null) !== $key) return false;
    if (!ledger_verify($domainPublicPem, ledger_canonical($statement), $answer['signature'] ?? null)) return false;
    $at = strtotime((string) ($statement['asOf'] ?? ''));
    return $at !== false && $at <= $now + LEDGER_CLOCK_SKEW_SECONDS && $now - $at <= $maxAge;
}

// ---------- checking a purchase ----------

// Checks a buyer's intent and price credential through the price adapter and against the coin's purchase policy. The adapter
// ($gold) is a set of callables, documented in lib/purchase.php. Returns what the intent asks for:
// requestId, coinId, price, recipient, credentialId, quantity.
function purchase_verify(?array $gold, array $coin, mixed $intent, mixed $credential, int $now, bool $checkExpiry): array
{
    $policy = $coin['genesis']['purchase'] ?? null;
    if ($policy === null) ledger_fail('no-purchase-policy', 'this coin is not for sale');
    if ($gold === null) ledger_fail('no-purchase-verifier', 'this domain cannot check price credentials');
    if (!is_array($intent) || !is_array($credential)) ledger_fail('bad-purchase', 'a purchase needs an intent and a credential');
    $v = $gold['verify']($intent, $credential, $policy, $now);
    if (is_string($v)) ledger_fail('bad-purchase', $v);
    $need = ['requestId', 'coinId', 'price', 'recipient', 'credentialId', 'quantity', 'expiresAt'];
    foreach ($need as $field) if (!array_key_exists($field, $v)) ledger_fail('bad-purchase', 'the price adapter answered without ' . $field);
    if ($v['coinId'] !== $coin['coin_id']) ledger_fail('bad-purchase', 'the intent is for another coin');
    if (!is_string($v['requestId']) || !preg_match('/^[a-f0-9]{32,64}$/D', $v['requestId'])) ledger_fail('bad-purchase', 'the request id is malformed');
    if (!is_int($v['price']) || $v['price'] < (int) $policy['minPrice']) ledger_fail('purchase-too-small', 'the price is below ' . $policy['minPrice']);
    if (!is_int($v['quantity']) || $v['price'] > $v['quantity']) ledger_fail('bad-purchase', 'the credential holds less than the price');
    if (!ledger_valid_owner_key($v['recipient']) || $v['recipient'] === $coin['treasury_key']) ledger_fail('bad-purchase', 'the recipient is not a wallet key that can receive');
    if ($checkExpiry && (!is_int($v['expiresAt']) || $v['expiresAt'] <= $now)) ledger_fail('expired', 'the intent has expired');
    if ($gold['revoked']((string) $v['credentialId'])) ledger_fail('revoked-credential', 'the price credential is revoked');
    return $v;
}

// What every approving domain runs on a sale before it signs: the buyer's intent and the price credential in the entry check
// out, and they are the ones the entry sells against. An intent's own expiry is not rechecked, since an approval may come
// after a crash long after the buyer signed.
function purchase_check_entry(?array $gold, array $coin, array $public, array $private, int $now): void
{
    if (!isset($public['purchase'])) return;
    $evidence = $private['purchase'] ?? null;
    $v = purchase_verify($gold, $coin, $evidence['intent'] ?? null, $evidence['credential'] ?? null, $now, false);
    if ($v['requestId'] !== $public['purchase']['requestId'] || $v['price'] !== $public['purchase']['price']) ledger_fail('bad-purchase', 'the entry is not the sale the buyer asked for');
    if ($v['recipient'] !== ($private['to'] ?? null)) ledger_fail('bad-purchase', 'the entry delivers to another key than the buyer named');
}
