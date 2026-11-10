<?php
declare(strict_types=1);
// Selling units of a ledger coin for a price credential held elsewhere (Gold in the first use). This is the authority's side: it
// checks the buyer's signed intent, takes a lock on the price credential, writes its decision to a journal before anything
// changes, delivers the units with a treasury transfer through the coin's normal spend path (with approvals from the other
// domains for a multi authority coin), and only then deals with the credential. Each step can be repeated after a crash and
// only moves forward. The ledger refuses a second delivery for one request id, so a repeat can never deliver twice.
// Include-only: a direct request gets a 404.
if (PHP_SAPI !== 'cli' && isset($_SERVER['SCRIPT_FILENAME']) && realpath($_SERVER['SCRIPT_FILENAME']) === __FILE__) { http_response_code(404); exit; }
require_once __DIR__ . '/peer.php';

// The price adapter is an array of callables; the code that holds the credentials supplies it.
//   verify(intent, credential, policy, now): array|string
//       The wallet's intent is {payload: {type: 'atlas.ledger.purchase.intent', v: 1, coinId, credentialId, price, recipient,
//       requestId, expiresAt}, signature}, signed over the canonical text of the payload with the wallet key (raw r||s).
//       Checks the buyer's signature on the intent and that the credential carries the issuer's signature named in the policy
//       (issuerKey), is of the policy's class and belongs to the buyer. Returns requestId, coinId, price, recipient,
//       credentialId, quantity and expiresAt (Unix time) of what was signed, or the reason it does not check out.
//   revoked(credentialId): bool                         every domain that approves a sale asks
//   lock(requestId, credential, intent): ?string        the authority only: a refusal, or null once the credential is held for this request
//                                                       (a real issuer keeps the hold itself and checks the intent once more)
//   begin(requestId, credential): ?string               optional, the authority only: called before each attempt to deliver. Null once the
//                                                       delivery may begin, from which the hold no longer lapses by time; a string means the
//                                                       credential can no longer be used for this sale and the sale is ended
//   release(requestId, credentialId): void              the authority only: lets the credential be used elsewhere again; called only once
//                                                       the ledger has ruled the delivery out
//   finish(requestId, credential, price): array         the authority only: spends the credential and issues the remainder, once per
//                                                       request id however often it is called; returns what the buyer gets back
//   pack(credential): array                             optional: the form in which the ledger keeps the credential (journal, entry evidence,
//                                                       approvals) when the credential itself cannot be written as ledger JSON (a Gold
//                                                       credential carries numbers with fractions, which the ledger's canonical form
//                                                       refuses). It must keep `id`. Every callable above is then given this form.
//   crash(point): void                                  optional, for tests: called between steps
const PURCHASE_MAX_ATTEMPTS = 8;

function purchase_crash(array $gold, string $point): void
{
    if (isset($gold['crash'])) $gold['crash']($point);
}

function purchase_row(PDO $db, string $coinId, string $requestId): ?array
{
    $q = $db->prepare('SELECT * FROM ledger_purchases WHERE coin_id=? AND request_id=?');
    $q->execute([$coinId, $requestId]);
    $row = $q->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

// A failure that leaves the sale to be finished later, as opposed to one that ends it.
function purchase_transient(LedgerError $e): bool
{
    return in_array($e->reason, ['not-enough-approvals', 'peer-down', 'busy', 'pending-exists', 'wrong-index', 'wrong-prev'], true);
}

// Takes a buyer's request. Answers with the stored result when it was already done. Throws a LedgerError when it is refused;
// a transient one means the request is journaled and a repeat of it, or recovery, finishes it.
function purchase_submit(PDO $db, array $node, array $gold, array $treasury, string $coinId, array $intent, array $credential, ?callable $send, int $now): array
{
    $coin = ledger_coin($db, $coinId);
    if ($coin['state'] !== 'active') ledger_fail('not-active', 'the coin is ' . $coin['state']);
    if ($coin['genesis']['authority'] !== $node['domain']) ledger_fail('not-authority', 'only the authority sells');
    if ($coin['mode'] === 'multi' && $send === null) ledger_fail('bad-node', 'a multi authority coin sells through its partners');
    // A request already journaled is answered from its journal even when its credential is spent by now (that is what a finished
    // sale looks like) or its intent has run out; only a new sale needs a live credential and a live intent.
    $v = purchase_verify($gold, $coin, $intent, $credential, $now, false, false);
    $policy = $coin['genesis']['purchase'];
    $row = purchase_row($db, $coinId, $v['requestId']);
    if ($row !== null) {
        if ($row['credential_id'] !== $v['credentialId'] || (int) $row['price'] !== $v['price'] || $row['recipient'] !== $v['recipient']) ledger_fail('request-reused', 'this request id was used for another purchase');
        if ($row['status'] !== 'abandoned') return purchase_run($db, $node, $gold, $treasury, $row, $send, $now);
        // An abandoned request left the credential untouched, so the same request may be made again.
        $db->prepare('DELETE FROM ledger_purchases WHERE coin_id=? AND request_id=?')->execute([$coinId, $v['requestId']]);
    }
    $v = purchase_verify($gold, $coin, $intent, $credential, $now, true);
    $units = $v['price'] * (int) $policy['unitsPerPrice'];
    $account = ledger_account_row($db, $coinId, $coin['treasury_key']);
    if (!$account || (int) $account['units'] < $units) ledger_fail('insufficient-treasury', 'the treasury holds fewer units than this purchase');
    ledger_purchase_rules($db, $coin, $v['requestId'], $v['recipient'], $units, max($now, ledger_head_time($db, $coinId)));
    $refused = $gold['lock']($v['requestId'], $credential, $intent);
    if ($refused !== null) ledger_fail('locked', $refused);
    purchase_crash($gold, 'locked');
    $db->prepare("INSERT INTO ledger_purchases(coin_id,request_id,status,credential_id,price,units,recipient,intent_json,credential_json,created_at) VALUES(?,?,'decided',?,?,?,?,?,?,?)")
        ->execute([$coinId, $v['requestId'], $v['credentialId'], $v['price'], $units, $v['recipient'], ledger_canonical($intent), ledger_canonical($credential), $now]);
    purchase_crash($gold, 'journaled');
    return purchase_run($db, $node, $gold, $treasury, purchase_row($db, $coinId, $v['requestId']), $send, $now);
}

// Carries a journaled purchase forward: the ledger entry if there is none, then the price credential, then the stored result.
function purchase_run(PDO $db, array $node, array $gold, array $treasury, array $row, ?callable $send, int $now): array
{
    $coinId = $row['coin_id'];
    $rid = $row['request_id'];
    if ($row['status'] === 'done') return json_decode($row['result_json'], true);
    // The credential is told that delivery is about to be tried, before anything that could deliver. From here its hold stays until
    // the sale is done or the ledger has ruled the delivery out. Skipped once an entry exists: it was begun before that.
    if ($row['status'] === 'decided' && isset($gold['begin']) && ledger_request_entry($db, $coinId, $rid) === null) {
        $refused = $gold['begin']($rid, json_decode($row['credential_json'], true));
        if ($refused !== null) {
            purchase_abandon($db, $gold, $row, 'credential-unavailable');
            ledger_fail('locked', $refused);
        }
        purchase_crash($gold, 'begun');
    }
    try {
        $index = purchase_credit($db, $node, $treasury, $row, $send, $now, $gold);
    } catch (LedgerError $e) {
        if (purchase_transient($e)) throw $e;
        // A proposal still pending must not be executable later, once the credential is released.
        $latest = purchase_row($db, $coinId, $rid);
        if ($latest !== null && $latest['proposal_digest'] !== null) spend_reject($db, $coinId, $latest['proposal_digest'], 'rejected', 'abandoned: ' . $e->reason);
        $delivered = ledger_request_entry($db, $coinId, $rid);
        if ($delivered === null) {
            purchase_abandon($db, $gold, $row, $e->reason);
            throw $e;
        }
        $index = $delivered;
    }
    $db->prepare("UPDATE ledger_purchases SET status='credited', entry_index=? WHERE coin_id=? AND request_id=? AND status='decided'")->execute([$index, $coinId, $rid]);
    purchase_crash($gold, 'credited');
    $credential = json_decode($row['credential_json'], true);
    $balance = $gold['finish']($rid, $credential, (int) $row['price']);
    purchase_crash($gold, 'finished');
    $result = ['requestId' => $rid, 'receipt' => spend_receipt($db, $coinId, $index), 'balance' => $balance];
    $db->prepare("UPDATE ledger_purchases SET status='done', result_json=?, entry_index=? WHERE coin_id=? AND request_id=? AND status IN ('decided','credited')")
        ->execute([ledger_canonical($result), $index, $coinId, $rid]);
    return $result;
}

// The treasury transfer that delivers the units. A proposal this purchase already made is finished first; otherwise a new
// one is signed with the treasury key against the current head. A concurrent treasury spend only moves the head, so the
// transfer is signed again.
function purchase_credit(PDO $db, array $node, array $treasury, array $row, ?callable $send, int $now, array $gold): int
{
    $coinId = $row['coin_id'];
    $rid = $row['request_id'];
    $execute = function (string $digest) use ($db, $node, $coinId, $send, $now): int {
        $coin = ledger_coin($db, $coinId);
        $receipt = $coin['mode'] === 'single' ? spend_execute($db, $coinId, $digest, $node['private'], $now) : peer_execute($db, $node, $coinId, $digest, $send, $now);
        return (int) $receipt['entry']['index'];
    };
    for ($attempt = 0;; $attempt++) {
        $done = ledger_request_entry($db, $coinId, $rid);
        if ($done !== null) return $done;
        $current = purchase_row($db, $coinId, $rid);
        try {
            if ($current['proposal_digest'] !== null) {
                $held = spend_proposal($db, $coinId, $current['proposal_digest']);
                if ($held && $held['status'] === 'pending') return $execute($current['proposal_digest']);
            }
            $authorization = ledger_grant_authorization($db, $coinId, $treasury, $row['recipient'], (string) $row['units'], max($now, ledger_head_time($db, $coinId)),
                ['requestId' => $rid, 'price' => (int) $row['price']], ['intent' => json_decode($row['intent_json'], true), 'credential' => json_decode($row['credential_json'], true)]);
            $state = spend_submit($db, $coinId, $authorization, $now);
            $db->prepare('UPDATE ledger_purchases SET proposal_digest=? WHERE coin_id=? AND request_id=?')->execute([$state['digest'], $coinId, $rid]);
            purchase_crash($gold, 'submitted');
            return $execute($state['digest']);
        } catch (LedgerError $e) {
            $done = ledger_request_entry($db, $coinId, $rid);
            if ($done !== null) return $done;
            if (in_array($e->reason, ['stale', 'pending-exists', 'wrong-index', 'wrong-prev', 'expired'], true) && $attempt < PURCHASE_MAX_ATTEMPTS) {
                usleep(random_int(10000, 40000) * min($attempt + 1, 4));
                continue;
            }
            throw $e;
        }
    }
}

// Ends a purchase that can no longer be delivered: the credential was never touched, so it is released.
function purchase_abandon(PDO $db, array $gold, array $row, string $reason): void
{
    // The credential is freed first: when that cannot be done the sale stays journaled and the next attempt tries again, rather
    // than being marked ended while the credential is still held.
    $gold['release']($row['request_id'], $row['credential_id']);
    $db->prepare("UPDATE ledger_purchases SET status='abandoned', reason=? WHERE coin_id=? AND request_id=? AND status IN ('decided','credited')")->execute([$reason, $row['coin_id'], $row['request_id']]);
}

// By hand: ends a journaled purchase that has no ledger entry and frees its credential. One already delivered cannot be cancelled.
function purchase_cancel(PDO $db, array $gold, string $coinId, string $requestId): void
{
    $row = purchase_row($db, $coinId, $requestId);
    if ($row === null) ledger_fail('unknown-request', 'no such purchase');
    if ($row['status'] === 'abandoned') return;
    if (ledger_request_entry($db, $coinId, $requestId) !== null || $row['status'] === 'done') ledger_fail('cannot-cancel', 'the units were delivered');
    if ($row['proposal_digest'] !== null) spend_reject($db, $coinId, $row['proposal_digest'], 'rejected', 'cancelled');
    purchase_abandon($db, $gold, $row, 'cancelled');
}

// After a crash: carries every journaled purchase of the coin forward, oldest first. Returns what each came to.
function purchase_recover(PDO $db, array $node, array $gold, array $treasury, string $coinId, ?callable $send, int $now): array
{
    $rows = $db->prepare("SELECT request_id FROM ledger_purchases WHERE coin_id=? AND status IN ('decided','credited') ORDER BY created_at, rowid");
    $rows->execute([$coinId]);
    $out = [];
    foreach ($rows->fetchAll(PDO::FETCH_COLUMN) as $rid) {
        try {
            $result = purchase_run($db, $node, $gold, $treasury, purchase_row($db, $coinId, $rid), $send, $now);
            $out[$rid] = 'done at ' . $result['receipt']['entry']['index'];
        } catch (LedgerError $e) {
            $out[$rid] = $e->reason;
        }
    }
    return $out;
}
