<?php
declare(strict_types=1);
// Selling a ledger coin for a price credential (chain-labs/lib/purchase.php), with a stand-in for the code that holds Gold:
//   - the purchase policy in the genesis
//   - a sale on a single authority coin and on multi authority coins, retries, and every refusal before anything changes
//   - the limits per key and per day, the lock on the credential, the treasury running short
//   - crash injection at each step: after the lock, after the journal, after the transfer was submitted, after the entry was
//     written, after the credential was dealt with
//   - what each approving domain checks for itself, and what it keeps out of public reads
//
//   php test/chain-labs-purchase.php
require __DIR__ . '/support/multi-cluster.php';
require __DIR__ . '/../chain-labs/lib/purchase.php';
require __DIR__ . '/support/gold-stand-in.php';

$ISSUER = stand_in_issuer();
$CRASH_AT = null;
function crash_hook(string $point): void
{
    global $CRASH_AT;
    if ($CRASH_AT === $point) { $CRASH_AT = null; throw new RuntimeException('crash at ' . $point); }
}
function terms(array $over = []): array
{
    global $ISSUER;
    return array_merge(['priceClass' => 'atlas.element.gold', 'issuerKey' => $ISSUER['issuerKey'], 'unitsPerPrice' => 10, 'minPrice' => 5, 'perKeyUnits' => '2000', 'perDayUnits' => '3000'], $over);
}
function gold_for(array $issuer, bool $seller): array
{
    $gold = stand_in_gold(tempnam(sys_get_temp_dir(), 'gold-') . '.sqlite', $seller ? $issuer : ['public' => $issuer['public']]);
    if ($seller) $gold['crash'] = 'crash_hook';
    return $gold;
}
function as_treasury(array $t): array { return ['key' => $t['key'], 'private' => $t['priv'] ?? $t['private']]; }

// A single authority coin in its own database.
function single_ctx(?array $purchase, string $visibility = 'public', string $initial = '100000'): array
{
    global $NOW, $ISSUER;
    $db = ledger_open(tempnam(sys_get_temp_dir(), 'purchase-') . '.sqlite');
    $domPriv = ec_private();
    $treasury = ledger_new_owner_key();
    $secret = $visibility === 'private' ? bin2hex(random_bytes(32)) : null;
    $genesis = ledger_genesis(['symbol' => 'SGL', 'name' => 'Coin SGL', 'decimals' => 2, 'maxUnits' => '1000000', 'initialUnits' => $initial, 'treasuryKey' => $treasury['key'], 'mode' => 'single',
        'visibility' => $visibility, 'roster' => [['domain' => 'a.example', 'key' => peer_public(['private' => $domPriv])]], 'createdAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW - 3600), 'refSecret' => $secret, 'purchase' => $purchase]);
    ledger_register($db, $genesis, $treasury['key'], $secret);
    ledger_add_genesis_signature($db, $genesis['coinId'], 'a.example', ledger_genesis_sign($genesis, $domPriv));
    ledger_activate($db, $genesis['coinId'], $domPriv);
    $node = ['domain' => 'a.example', 'private' => $domPriv, 'pinned' => []];
    return ['db' => $db, 'coin' => $genesis['coinId'], 'node' => $node, 'treasury' => as_treasury($treasury), 'gold' => gold_for($ISSUER, true), 'send' => null, 'genesis' => $genesis];
}
// The authority of a multi coin on a cluster of three, every node able to check price credentials.
function multi_ctx(?int $threshold, ?array $purchase): array
{
    global $CLUSTER, $ISSUER;
    cluster(3);
    $c = open_coin(3, $threshold, 'public', null, 'MUL', $purchase);
    open_now($c);
    foreach (array_keys($CLUSTER) as $d) $CLUSTER[$d]['node']['gold'] = gold_for($ISSUER, false);
    $gold = gold_for($ISSUER, true);
    $CLUSTER['a.example']['node']['gold'] = $gold;
    return ['db' => ndb('a.example'), 'coin' => $c['coin'], 'node' => $CLUSTER['a.example']['node'], 'treasury' => as_treasury($c['treasury']), 'gold' => $gold, 'send' => 'transport', 'cluster' => $c];
}
function request(array $ctx, array $buyer, int $quantity, int $price, array $over = []): array
{
    global $ISSUER, $NOW;
    $credential = $over['credential'] ?? stand_in_credential($ISSUER, $buyer['key'], $quantity);
    $rid = $over['requestId'] ?? bin2hex(random_bytes(16));
    return ['credential' => $credential, 'requestId' => $rid, 'buyer' => $buyer,
        'intent' => stand_in_intent($buyer, $over['coinId'] ?? $ctx['coin'], $credential, $price, $rid, $over['recipient'] ?? null, $over['expiresAt'] ?? $NOW + 300)];
}
function sell(array $ctx, array $request): array
{
    global $NOW;
    return purchase_submit($ctx['db'], $ctx['node'], $ctx['gold'], $ctx['treasury'], $ctx['coin'], $request['intent'], $request['credential'], $ctx['send'], $NOW);
}
function recover(array $ctx): array
{
    global $NOW;
    return purchase_recover($ctx['db'], $ctx['node'], $ctx['gold'], $ctx['treasury'], $ctx['coin'], $ctx['send'], $NOW);
}
function count_rows(array $ctx, string $sql): int { return (int) $ctx['gold']['db']->query($sql)->fetchColumn(); }
function sold_entries(array $ctx, string $rid): int
{
    $q = $ctx['db']->prepare('SELECT COUNT(*) FROM ledger_requests WHERE coin_id=? AND request_id=?');
    $q->execute([$ctx['coin'], $rid]);
    return (int) $q->fetchColumn();
}
function head_index(array $ctx): int { return ledger_head($ctx['db'], $ctx['coin'])['index']; }
function held(array $ctx, string $key): int
{
    $row = ledger_account_row($ctx['db'], $ctx['coin'], $key);
    return $row ? (int) $row['units'] : 0;
}
function untouched(array $ctx, array $req, int $head): bool
{
    return head_index($ctx) === $head && count_rows($ctx, "SELECT COUNT(*) FROM locks WHERE credential_id='" . $req['credential']['id'] . "'") === 0
        && count_rows($ctx, "SELECT COUNT(*) FROM spent WHERE credential_id='" . $req['credential']['id'] . "'") === 0
        && !$ctx['db']->query("SELECT 1 FROM ledger_purchases WHERE request_id='" . $req['requestId'] . "' AND status NOT IN ('abandoned')")->fetchColumn();
}

echo "== the purchase policy in the genesis\n";
$mk = fn(?array $p) => fn() => ledger_genesis(['symbol' => 'POL', 'name' => 'Policy', 'decimals' => 0, 'maxUnits' => '100000', 'initialUnits' => '50000', 'treasuryKey' => ledger_new_owner_key()['key'], 'mode' => 'single',
    'visibility' => 'public', 'roster' => [['domain' => 'a.example', 'key' => peer_public(['private' => ec_private()])]], 'createdAt' => '2026-01-01T00:00:00Z', 'purchase' => $p]);
$good = ($mk(terms(['perKeyUnits' => '2000', 'perDayUnits' => '3000'])))();
t(($good['purchase']['unitsPerPrice'] ?? null) === 10 && $good['purchase']['perKeyUnits'] === '2000', 'a coin can carry a purchase policy');
t(!array_key_exists('purchase', ($mk(null))()), 'a coin without one has no purchase field in its genesis');
$bad = [
    'a missing field' => array_diff_key(terms(), ['minPrice' => 1]),
    'an extra field' => terms() + ['bonus' => 1],
    'a rate of zero' => terms(['unitsPerPrice' => 0]),
    'a fractional rate' => terms(['unitsPerPrice' => 1.5]),
    'a rate above the coin' => terms(['unitsPerPrice' => 100001]),
    'a minimum price of zero' => terms(['minPrice' => 0]),
    'a per key limit below the smallest purchase' => terms(['perKeyUnits' => '49']),
    'a per day limit below the smallest purchase' => terms(['perDayUnits' => '49']),
    'a per key limit above the coin' => terms(['perKeyUnits' => '100001']),
    'a class that is not a name' => terms(['priceClass' => 'Gold!']),
    'an issuer key with spaces' => terms(['issuerKey' => 'not a key at all']),
    'a policy that is a list' => [1, 2, 3],
];
foreach ($bad as $name => $policy) t(refuses(fn() => ($mk($policy))(), 'bad-genesis'), 'a genesis is refused: ' . $name);

echo "\n== a sale on a single authority coin\n";
$ctx = single_ctx(terms());
$buyer = owner();
$req = request($ctx, $buyer, 100, 20);
$head = head_index($ctx);
$result = sell($ctx, $req);
$entry = $result['receipt']['entry'];
t($entry['index'] === $head + 1 && $entry['amount'] === '200' && $entry['purchase'] == ['requestId' => $req['requestId'], 'price' => 20] && $entry['to'] === $buyer['key'], 'the buyer gets 20 times the rate in units, and the entry carries the request', $result);
t(held($ctx, $buyer['key']) === 200 && ledger_check($ctx['db'], $ctx['coin']) === [], 'the units are in the buyer\'s account and the checker passes');
t(($result['balance']['balance']['quantity'] ?? null) === 80 && $result['balance']['balance']['owner'] === $buyer['key'], 'the remainder credential comes back with the receipt', $result['balance']);
t(count_rows($ctx, 'SELECT COUNT(*) FROM locks') === 0 && count_rows($ctx, 'SELECT COUNT(*) FROM spent') === 1 && purchase_row($ctx['db'], $ctx['coin'], $req['requestId'])['status'] === 'done', 'the credential is spent once, the lock is gone and the journal says done');
$again = sell($ctx, $req);
t(ledger_canonical($again) === ledger_canonical($result) && head_index($ctx) === $head + 1, 'the same request again returns the stored result and delivers nothing more');
$other = request($ctx, $buyer, 100, 30, ['requestId' => $req['requestId'], 'credential' => $req['credential']]);
t(refuses(fn() => sell($ctx, $other), 'request-reused') && head_index($ctx) === $head + 1, 'a request id cannot be used for another price');
$sameRecipient = request($ctx, $buyer, 100, 20, ['requestId' => $req['requestId'], 'credential' => $req['credential'], 'recipient' => owner()['key']]);
t(refuses(fn() => sell($ctx, $sameRecipient), 'request-reused'), 'or for another recipient');
$whole = request($ctx, $buyer, 5, 5);
$r5 = sell($ctx, $whole);
t($r5['balance']['balance'] === null && held($ctx, $buyer['key']) === 250, 'paying with the whole credential leaves no remainder');
$friend = owner();
$gift = sell($ctx, request($ctx, $buyer, 50, 10, ['recipient' => $friend['key']]));
t(held($ctx, $friend['key']) === 100 && $gift['receipt']['entry']['to'] === $friend['key'], 'the units can be delivered to another key than the buyer\'s');

echo "\n== refusals leave everything as it was\n";
$head = head_index($ctx);
$cases = [
    'a price below the minimum' => fn() => request($ctx, $buyer, 100, 4),
    'a price above the credential' => fn() => request($ctx, $buyer, 10, 11),
    'an intent for another coin' => fn() => request($ctx, $buyer, 100, 20, ['coinId' => str_repeat('a', 32)]),
    'an expired intent' => fn() => request($ctx, $buyer, 100, 20, ['expiresAt' => $NOW - 5]),
    'delivery to the treasury' => fn() => request($ctx, $buyer, 100, 20, ['recipient' => $ctx['treasury']['key']]),
    'delivery to something that is not a key' => fn() => request($ctx, $buyer, 100, 20, ['recipient' => 'nobody']),
];
foreach ($cases as $name => $make) {
    $r = $make();
    $why = why(fn() => sell($ctx, $r));
    t($why !== 'no error' && untouched($ctx, $r, $head), 'refused and untouched: ' . $name, $why);
}
$stranger = stand_in_issuer();
$forged = stand_in_credential($stranger, $buyer['key'], 100);
$r = request($ctx, $buyer, 100, 20, ['credential' => $forged]);
t(refuses(fn() => sell($ctx, $r), 'bad-purchase') && untouched($ctx, $r, $head), 'refused and untouched: a credential another issuer signed');
$notMine = request($ctx, owner(), 100, 20);
$notMine['intent'] = stand_in_intent($buyer, $ctx['coin'], $notMine['credential'], 20, $notMine['requestId']);
t(refuses(fn() => sell($ctx, $notMine), 'bad-purchase') && untouched($ctx, $notMine, $head), 'refused and untouched: an intent signed by someone who does not own the credential');
$tampered = request($ctx, $buyer, 100, 20);
$tampered['intent']['payload']['price'] = 90;
t(refuses(fn() => sell($ctx, $tampered), 'bad-purchase') && untouched($ctx, $tampered, $head), 'refused and untouched: an intent changed after it was signed');
$revoked = request($ctx, $buyer, 100, 20);
$ctx['gold']['db']->prepare('INSERT INTO revoked(credential_id) VALUES(?)')->execute([$revoked['credential']['id']]);
t(refuses(fn() => sell($ctx, $revoked), 'revoked-credential') && untouched($ctx, $revoked, $head), 'refused and untouched: a revoked credential');
$spentAlready = request($ctx, $buyer, 100, 20, ['credential' => $req['credential']]);
t(refuses(fn() => sell($ctx, $spentAlready), 'locked') && head_index($ctx) === $head, 'refused: a credential that was already spent');
t(refuses(fn() => purchase_submit($ctx['db'], $ctx['node'], $ctx['gold'], $ctx['treasury'], $ctx['coin'], ['payload' => []], [], null, $NOW), 'bad-purchase'), 'refused: an intent that says nothing');
$poor = single_ctx(terms(), 'public', '300');
$big = request($poor, $buyer, 100, 40);
t(refuses(fn() => sell($poor, $big), 'insufficient-treasury') && untouched($poor, $big, head_index($poor)), 'refused and untouched: the treasury holds fewer units than the purchase');
$noPolicy = single_ctx(null);
$np = request($noPolicy, $buyer, 100, 20);
t(refuses(fn() => sell($noPolicy, $np), 'no-purchase-policy'), 'a coin with no purchase policy is not for sale');

echo "\n== the limits\n";
$lim = single_ctx(terms());
$k = owner();
$s1 = sell($lim, request($lim, $k, 500, 100));
$s2 = sell($lim, request($lim, $k, 500, 100));
t(held($lim, $k['key']) === 2000, 'one key can buy up to its limit');
$r3 = request($lim, $k, 500, 5);
t(refuses(fn() => sell($lim, $r3), 'purchase-key-limit') && purchase_row($lim['db'], $lim['coin'], $r3['requestId']) === null && untouched($lim, $r3, head_index($lim)), 'and not a unit more', why(fn() => sell($lim, $r3)));
$k2 = owner();
$d1 = sell($lim, request($lim, $k2, 500, 100));
$r4 = request($lim, owner(), 500, 5);
t(refuses(fn() => sell($lim, $r4), 'purchase-day-limit') && purchase_row($lim['db'], $lim['coin'], $r4['requestId']) === null && untouched($lim, $r4, head_index($lim)), 'the coin sells no more than its limit in 24 hours, whoever buys');
$NOW += 86350;
$edge = request($lim, owner(), 500, 5);
t(refuses(fn() => sell($lim, $edge), 'purchase-day-limit'), 'a sale 23 hours 59 minutes later still counts against the day');
$NOW += 50;
$r5 = sell($lim, request($lim, owner(), 500, 5));
t($r5['receipt']['entry']['amount'] === '50', 'and sells again when the 24 hours have passed');
$NOW -= 86400;
$lim['db']->exec('BEGIN');
$ids = $lim['db']->query('SELECT request_id FROM ledger_requests')->fetchAll(PDO::FETCH_COLUMN);
$lim['db']->exec("UPDATE ledger_requests SET units=units+1 WHERE request_id='" . $ids[0] . "'");
$lim['db']->exec('COMMIT');
t(ledger_check($lim['db'], $lim['coin']) !== [], 'the checker notices a stored sale that does not match the log');
$lim['db']->exec("UPDATE ledger_requests SET units=units-1 WHERE request_id='" . $ids[0] . "'");
$lim['db']->exec("DELETE FROM ledger_requests WHERE request_id='" . $ids[1] . "'");
t(ledger_check($lim['db'], $lim['coin']) !== [], 'and one that was removed');

echo "\n== the credential is locked while a purchase is under way\n";
$lk = single_ctx(terms());
$b = owner();
$first = request($lk, $b, 100, 20);
$CRASH_AT = 'journaled';
$crashed = false;
try { sell($lk, $first); } catch (RuntimeException $e) { $crashed = true; }
$second = request($lk, $b, 100, 20, ['credential' => $first['credential']]);
t($crashed && refuses(fn() => sell($lk, $second), 'locked') && head_index($lk) === 0, 'a second use of the credential is refused until the first purchase has finished');
$out = recover($lk);
t(str_starts_with($out[$first['requestId']] ?? '', 'done') && held($lk, $b['key']) === 200, 'recovery finishes the first purchase', $out);
t(refuses(fn() => sell($lk, $second), 'locked'), 'and then the credential is spent');

echo "\n== crash injection, single authority\n";
foreach (['locked', 'journaled', 'submitted', 'credited', 'finished'] as $point) {
    $cx = single_ctx(terms());
    $b = owner();
    $rq = request($cx, $b, 100, 20);
    $CRASH_AT = $point;
    $died = false;
    try { sell($cx, $rq); } catch (RuntimeException $e) { $died = $e->getMessage() === 'crash at ' . $point; }
    $mid = ['entries' => sold_entries($cx, $rq['requestId']), 'spent' => count_rows($cx, 'SELECT COUNT(*) FROM spent')];
    if ($point === 'locked') {
        // Nothing was journaled: the same request, made again, takes the lock it already holds.
        $res = sell($cx, $rq);
        $ok = $res['receipt']['entry']['amount'] === '200';
    } else {
        $res = recover($cx)[$rq['requestId']] ?? '';
        $ok = str_starts_with($res, 'done');
    }
    $row = purchase_row($cx['db'], $cx['coin'], $rq['requestId']);
    t($died && $ok && sold_entries($cx, $rq['requestId']) === 1 && held($cx, $b['key']) === 200 && count_rows($cx, 'SELECT COUNT(*) FROM spent') === 1 && $row['status'] === 'done' && count_rows($cx, 'SELECT COUNT(*) FROM locks') === 0 && ledger_check($cx['db'], $cx['coin']) === [],
        'a crash after "' . $point . '": the purchase completes once, the credential is spent once', [$mid, $res, $row['status'] ?? null]);
    $stored = sell($cx, $rq);
    t($stored['receipt']['entry']['index'] === 1 && head_index($cx) === 1, 'and a retry of the request returns the same result');
}
// A transfer submitted and then lost: the proposal waits, recovery executes it rather than signing a second one.
$cx = single_ctx(terms());
$b = owner();
$rq = request($cx, $b, 100, 20);
$CRASH_AT = 'submitted';
try { sell($cx, $rq); } catch (RuntimeException $e) {}
$pending = (int) $cx['db']->query("SELECT COUNT(*) FROM ledger_proposals WHERE status='pending'")->fetchColumn();
recover($cx);
t($pending === 1 && (int) $cx['db']->query('SELECT COUNT(*) FROM ledger_proposals')->fetchColumn() === 1, 'recovery finishes the proposal that was waiting instead of making another');
// The ledger step fails for good after the decision was journaled: the treasury is emptied in between.
$cx = single_ctx(terms(), 'public', '1000');
$b = owner();
$rq = request($cx, $b, 100, 100);
$CRASH_AT = 'journaled';
try { sell($cx, $rq); } catch (RuntimeException $e) {}
$thief = owner();
$grant = ledger_grant($cx['db'], $cx['coin'], $cx['treasury'], $thief['key'], '600', $NOW);
ledger_commit($cx['db'], $cx['coin'], $grant, ledger_sign($cx['node']['private'], $grant['hash']), [], $NOW);
$out = recover($cx);
$row = purchase_row($cx['db'], $cx['coin'], $rq['requestId']);
t(($out[$rq['requestId']] ?? '') === 'insufficient' && $row['status'] === 'abandoned' && count_rows($cx, 'SELECT COUNT(*) FROM locks') === 0 && count_rows($cx, 'SELECT COUNT(*) FROM spent') === 0, 'a refused ledger step abandons the purchase: nothing is debited and the credential is free again', [$out, $row['status']]);
$retry = request($cx, $b, 100, 40, ['credential' => $rq['credential'], 'requestId' => $rq['requestId']]);
t(refuses(fn() => sell($cx, $retry), 'request-reused'), 'a request id used for another purchase stays used');
$again = request($cx, $b, 100, 10, ['credential' => $rq['credential']]);
$ok = sell($cx, $again);
t($ok['receipt']['entry']['amount'] === '100', 'and the freed credential can be used for a new purchase');
// Cancelling a journaled purchase by hand.
$cx = single_ctx(terms());
$b = owner();
$rq = request($cx, $b, 100, 20);
$CRASH_AT = 'journaled';
try { sell($cx, $rq); } catch (RuntimeException $e) {}
purchase_cancel($cx['db'], $cx['gold'], $cx['coin'], $rq['requestId']);
t(purchase_row($cx['db'], $cx['coin'], $rq['requestId'])['status'] === 'abandoned' && count_rows($cx, 'SELECT COUNT(*) FROM locks') === 0 && recover($cx) === [], 'an operator can cancel a purchase that has no entry, which frees the credential');
$done = single_ctx(terms());
$rq = request($done, $b, 100, 20);
sell($done, $rq);
t(refuses(fn() => purchase_cancel($done['db'], $done['gold'], $done['coin'], $rq['requestId']), 'cannot-cancel'), 'and cannot cancel one that was delivered');

echo "\n== a private coin\n";
$pc = single_ctx(terms(), 'private');
$b = owner();
$rq = request($pc, $b, 100, 20);
$res = sell($pc, $rq);
$publicText = json_encode([ledger_public_coin($pc['db'], $pc['coin']), ledger_public_entries($pc['db'], $pc['coin']), $res['receipt']]);
t(!str_contains($publicText, $b['key']) && !str_contains($publicText, $rq['credential']['id']) && !str_contains($publicText, $rq['credential']['signature']), 'no public read of a private coin holds the buyer\'s key or the credential');
$priv = json_decode($pc['db']->query("SELECT private_json FROM ledger_log WHERE idx=1")->fetchColumn(), true);
t($priv['to'] === $b['key'] && $priv['purchase']['credential']['id'] === $rq['credential']['id'], 'the private form keeps both for the domains that approve');
t(ledger_check($pc['db'], $pc['coin']) === [], 'the checker passes on a private coin');

echo "\n== multi authority: 2 of 3\n";
$m = multi_ctx(2, terms());
$b = owner();
$rq = request($m, $b, 100, 20);
t(refuses(fn() => purchase_submit($m['db'], $m['node'], $m['gold'], $m['treasury'], $m['coin'], $rq['intent'], $rq['credential'], null, $NOW), 'bad-node') && purchase_row($m['db'], $m['coin'], $rq['requestId']) === null, 'a multi authority coin cannot be sold from a node with no way to reach its partners');
$res = sell($m, $rq);
t($res['receipt']['entry']['amount'] === '200' && count($res['receipt']['approvals']) === 1, 'a sale on a 2-of-3 coin carries one partner\'s approval', $res['receipt']['approvals'] ?? null);
foreach (['b.example', 'c.example'] as $d) peer_catch_up(ndb($d), node($d), $m['coin'], 'transport', $NOW);
t(level($m['cluster'], ['a.example', 'b.example', 'c.example']) && same_log($m['cluster'], ['a.example', 'b.example', 'c.example']) && clean($m['cluster'], ['a.example', 'b.example', 'c.example']), 'all three copies hold the same sale, and they check clean');
t(ledger_canonical(sell($m, $rq)) === ledger_canonical($res), 'a retry returns the stored result');
$sold = ndb('c.example')->query('SELECT COUNT(*) FROM ledger_requests')->fetchColumn();
t((int) $sold === 1, 'the partners keep the request id too, so they refuse a second delivery');

// What each approver checks for itself. An authority that skips its own checks builds the entry by hand.
function hand_made(array $m, array $b, array $over = []): array
{
    global $NOW;
    $coin = ledger_coin(ndb('a.example'), $m['coin']);
    $head = ledger_head(ndb('a.example'), $m['coin']);
    $price = $over['price'] ?? 20;
    $amount = $over['amount'] ?? $price * 10;
    $rid = $over['requestId'] ?? bin2hex(random_bytes(16));
    $request = request($m, $b, $over['quantity'] ?? 100, $price, ['requestId' => $rid] + ($over['request'] ?? []));
    $from = $over['from'] ?? $m['treasury'];
    $account = ledger_account_row(ndb('a.example'), $m['coin'], $from['key']);
    $payload = ['type' => 'atlas.ledger.transfer', 'v' => 1, 'coinId' => $m['coin'], 'from' => $from['key'], 'to' => $b['key'], 'amount' => (string) $amount, 'baseSeq' => (int) $account['seq'],
        'baseHead' => $head['hash'], 'nonce' => bin2hex(random_bytes(16)), 'issuedAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW - 5), 'expiresAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW + 200),
        'purchase' => ['requestId' => $rid, 'price' => $price]];
    $public = ['type' => 'transfer', 'coinId' => $m['coin'], 'index' => $head['index'] + 1, 'prevHash' => $head['hash'], 'executedAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW), 'amount' => (string) $amount,
        'from' => $from['key'], 'to' => $b['key'], 'purchase' => $payload['purchase']];
    if (isset($over['publicPrice'])) $public['purchase']['price'] = $over['publicPrice'];
    if (!empty($over['plain'])) { unset($payload['purchase'], $public['purchase']); }
    $hash = ledger_digest($public);
    $private = ['hash' => $hash, 'from' => $from['key'], 'to' => $b['key'], 'authorization' => ['payload' => $payload, 'signature' => ledger_owner_sign($from['priv'] ?? $from['private'], $payload)],
        'purchase' => ['intent' => $request['intent'], 'credential' => $request['credential']] + (isset($over['pad']) ? ['pad' => str_repeat('x', $over['pad'])] : [])];
    return ['public' => $public, 'private' => $private, 'hash' => $hash];
}
$ask = fn(string $d, array $prepared) => transport($d, peer_envelope(node('a.example'), $d, 'approve', ['coinId' => $prepared['public']['coinId'], 'prepared' => $prepared], $NOW));
$m = multi_ctx(2, terms());
$b = owner();
$ok = hand_made($m, $b);
t(($ask('b.example', $ok)['decision'] ?? null) === 'approve', 'an honest entry built by hand is approved, so the checks below are about what is wrong with the others');
$m = multi_ctx(2, terms());
$cases = [
    'an amount that is not the price at the coin\'s rate' => ['amount' => 201, 'reason' => 'bad-purchase: the amount'],
    'a price below the minimum' => ['price' => 4, 'amount' => 40, 'reason' => 'purchase-too-small'],
    'a credential holding less than the price' => ['price' => 20, 'quantity' => 10, 'reason' => 'bad-purchase: the credential holds less'],
    'a credential another issuer signed' => ['request' => ['credential' => stand_in_credential(stand_in_issuer(), $b['key'], 100)], 'reason' => 'bad-purchase: the credential is not signed'],
];
foreach ($cases as $name => $over) {
    $why = why(fn() => $ask('b.example', hand_made($m, $b, $over)));
    t(str_starts_with($why, $over['reason'] ?? ''), 'an approver refuses: ' . $name, $why);
}
$revokedOne = request($m, $b, 100, 20);
$hand = hand_made($m, $b, ['request' => ['credential' => $revokedOne['credential']]]);
$CLUSTER['b.example']['node']['gold']['db']->prepare('INSERT INTO revoked(credential_id) VALUES(?)')->execute([$revokedOne['credential']['id']]);
t(refuses(fn() => $ask('b.example', $hand), 'revoked-credential') && ($ask('c.example', $hand)['decision'] ?? null) === 'approve', 'an approver that has the credential on its revocation list refuses it, another approver does not');
$noVerifier = $CLUSTER['c.example']['node'];
unset($CLUSTER['c.example']['node']['gold']);
t(refuses(fn() => $ask('c.example', hand_made($m, $b)), 'no-purchase-verifier'), 'an approver with no way to check price credentials refuses every sale');
$CLUSTER['c.example']['node'] = $noVerifier;
// The same request id twice and the per-key limit, built by hand against the ledger the approver holds.
$m = multi_ctx(2, terms());
$b = owner();
$first = sell($m, request($m, $b, 500, 100));
$dup = hand_made($m, $b, ['requestId' => $first['requestId'], 'price' => 20]);
t(refuses(fn() => $ask('b.example', $dup), 'duplicate-purchase'), 'an approver refuses a second delivery of one request id');
sell($m, request($m, $b, 500, 100));
$over = hand_made($m, $b, ['price' => 6, 'amount' => 60]);
t(refuses(fn() => $ask('b.example', $over), 'purchase-key-limit'), 'an approver refuses a sale past the limit for one key');
$other = owner();
$spree = hand_made($m, $other, ['price' => 101, 'amount' => 1010]);
t(refuses(fn() => $ask('b.example', $spree), 'purchase-day-limit'), 'and a sale past the limit for the day');
// A transfer from the treasury that claims to be a sale but is not for sale on this coin.
$closed = multi_ctx(2, null);
$sneaky = hand_made($closed, $b);
t(refuses(fn() => $ask('b.example', $sneaky), 'no-purchase-policy'), 'an approver refuses a sale on a coin that has no purchase policy');

// The same rules in the ledger itself, without the credential check, so a verifier that is wrong or missing cannot let these through.
$m = multi_ctx(2, terms());
$b = owner();
$holder = owner();
sell($m, request($m, $holder, 100, 20));
$valid = fn(array $prepared) => ledger_validate_prepared(ndb('b.example'), $m['coin'], $prepared, $NOW);
t(refuses(fn() => $valid(hand_made($m, $b, ['price' => 4, 'amount' => 40])), 'purchase-too-small'), 'the ledger refuses a price below the minimum');
t(refuses(fn() => $valid(hand_made($m, $b, ['from' => $holder, 'price' => 10, 'amount' => 100])), 'bad-purchase'), 'the ledger refuses a sale that does not come from the treasury');
t(refuses(fn() => $valid(hand_made($m, $b, ['pad' => 17000])), 'bad-purchase'), 'the ledger refuses purchase evidence over 16 KB');
t(refuses(fn() => $valid(hand_made($m, $b, ['publicPrice' => 21])), 'bad-entry'), 'the ledger refuses a public purchase reference that differs from the authorization');
t(refuses(fn() => $valid(hand_made($m, $b, ['plain' => true])), 'bad-entry'), 'the ledger refuses purchase evidence on a plain transfer');

echo "\n== multi authority: all must approve, partners down, crash injection\n";
$m = multi_ctx(null, terms());
$b = owner();
$rq = request($m, $b, 100, 20);
$DOWN['c.example'] = true;
$why = why(fn() => sell($m, $rq));
$row = purchase_row($m['db'], $m['coin'], $rq['requestId']);
t(str_starts_with($why, 'not-enough-approvals') && $row['status'] === 'decided' && count_rows($m, 'SELECT COUNT(*) FROM locks') === 1 && sold_entries($m, $rq['requestId']) === 0, 'with a domain down the sale waits, journaled, and the credential stays locked', $why);
$DOWN['c.example'] = false;
$out = recover($m);
t(str_starts_with($out[$rq['requestId']] ?? '', 'done') && sold_entries($m, $rq['requestId']) === 1 && count_rows($m, 'SELECT COUNT(*) FROM spent') === 1, 'recovery finishes it once the domain is back', $out);
foreach (['journaled', 'submitted', 'credited', 'finished'] as $point) {
    $m = multi_ctx(2, terms());
    $b = owner();
    $rq = request($m, $b, 100, 20);
    $CRASH_AT = $point;
    try { sell($m, $rq); } catch (RuntimeException $e) {}
    $res = recover($m)[$rq['requestId']] ?? '';
    foreach (['b.example', 'c.example'] as $d) peer_catch_up(ndb($d), node($d), $m['coin'], 'transport', $NOW);
    $ids = ['a.example', 'b.example', 'c.example'];
    t(str_starts_with($res, 'done') && sold_entries($m, $rq['requestId']) === 1 && count_rows($m, 'SELECT COUNT(*) FROM spent') === 1 && level($m['cluster'], $ids) && clean($m['cluster'], $ids),
        'a crash after "' . $point . '" on a multi coin: completes once and the partners agree', $res);
}
// A long time passes: the intent and the transfer have both expired, and the approvers still approve the sale.
$m = multi_ctx(2, terms());
$b = owner();
$rq = request($m, $b, 100, 20);
$CRASH_AT = 'submitted';
try { sell($m, $rq); } catch (RuntimeException $e) {}
$NOW += 1000;
$out = recover($m);
t(str_starts_with($out[$rq['requestId']] ?? '', 'done') && sold_entries($m, $rq['requestId']) === 1, 'a sale journaled long before is completed after its intent and transfer have expired', $out);
$NOW -= 1000;
// Two sales racing for the treasury's sequence number are both delivered.
$m = multi_ctx(2, terms());
$b1 = owner(); $b2 = owner();
$r1 = request($m, $b1, 100, 20);
$r2 = request($m, $b2, 100, 20);
$CRASH_AT = 'submitted';
try { sell($m, $r1); } catch (RuntimeException $e) {}
$busy = why(fn() => sell($m, $r2));
$out = recover($m);
t(str_starts_with($busy, 'pending-exists') && str_starts_with($out[$r1['requestId']] ?? '', 'done') && str_starts_with($out[$r2['requestId']] ?? '', 'done') && sold_entries($m, $r1['requestId']) === 1 && sold_entries($m, $r2['requestId']) === 1,
    'a second sale meets the treasury\'s waiting transfer, is journaled, and recovery delivers both in order', [$busy, $out]);
t(ledger_check($m['db'], $m['coin']) === [], 'the checker passes after the mix');

echo "\n" . ($failures === 0 ? 'ALL ' . $total . ' CHAIN-LABS PURCHASE CHECKS PASSED' : $failures . ' of ' . $total . ' checks FAILED') . "\n";
exit($failures === 0 ? 0 : 1);
