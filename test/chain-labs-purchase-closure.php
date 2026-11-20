<?php
declare(strict_types=1);
// Closing a sale for a coin of one domain (chain-labs/lib/purchase.php purchase_closure, lib/checkpoint.php ledger_close_sale), with a
// stand-in for the code that holds Gold:
//   - the closure is made in one write lock with the check that nothing was delivered, and a delivery prepared earlier is refused
//   - a closed sale is kept in a file beside the checkpoint records, so an older database put back does not reopen it
//   - two processes racing a delivery against a closure, interrupted writes, a damaged file, retries, a sale that was delivered, and a coin of
//     several domains that still needs its witnesses
//
//   php test/chain-labs-purchase-closure.php
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
    $file = tempnam(sys_get_temp_dir(), 'purchase-') . '.sqlite';
    $db = ledger_open($file);
    $domPriv = ec_private();
    $treasury = ledger_new_owner_key();
    $secret = $visibility === 'private' ? bin2hex(random_bytes(32)) : null;
    $genesis = ledger_genesis(['symbol' => 'SGL', 'name' => 'Coin SGL', 'decimals' => 2, 'maxUnits' => '1000000', 'initialUnits' => $initial, 'treasuryKey' => $treasury['key'], 'mode' => 'single',
        'visibility' => $visibility, 'roster' => [['domain' => 'a.example', 'key' => peer_public(['private' => $domPriv])]], 'createdAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW - 3600), 'refSecret' => $secret, 'purchase' => $purchase]);
    ledger_register($db, $genesis, $treasury['key'], $secret);
    ledger_add_genesis_signature($db, $genesis['coinId'], 'a.example', ledger_genesis_sign($genesis, $domPriv));
    ledger_activate($db, $genesis['coinId'], $domPriv);
    $node = ['domain' => 'a.example', 'private' => $domPriv, 'pinned' => []];
    return ['db' => $db, 'file' => $file, 'coin' => $genesis['coinId'], 'node' => $node, 'treasury' => as_treasury($treasury), 'gold' => gold_for($ISSUER, true), 'send' => null, 'genesis' => $genesis];
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
    $coinId = $over['coinId'] ?? $ctx['coin'];
    try { $binding = $over['binding'] ?? ledger_binding($ctx['db'], $coinId); } catch (Throwable $e) { $binding = []; }
    return ['credential' => $credential, 'requestId' => $rid, 'buyer' => $buyer,
        'intent' => stand_in_intent($buyer, $coinId, $credential, $price, $rid, $over['recipient'] ?? null, $over['expiresAt'] ?? $NOW + 300, $binding)];
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


function snapshot(array $ctx): string
{
    $dest = tempnam(sys_get_temp_dir(), 'closure-backup-');
    unlink($dest);
    $ctx['db']->exec("VACUUM INTO '" . $dest . "'");
    return $dest;
}
function restore(array &$ctx, string $backup): void
{
    $ctx['db'] = null;
    foreach (['', '-wal', '-shm'] as $suffix) @unlink($ctx['file'] . $suffix);
    copy($backup, $ctx['file']);
    $ctx['db'] = ledger_open($ctx['file']);
}
// The closures the code that holds the Gold was handed: what its release asked the ledger for.
$GIVEN = [];
function watch_release(array &$ctx): void
{
    $release = $ctx['gold']['release'];
    $ctx['gold']['release'] = function (string $requestId, string $credentialId = '', ?callable $closure = null) use ($release): void {
        global $GIVEN;
        if ($closure !== null) $GIVEN[$requestId][] = $closure();
        $release($requestId, $credentialId, $closure);
    };
}
function locked(array $ctx): int { return count_rows($ctx, 'SELECT COUNT(*) FROM locks'); }
function closed_lines(array $ctx, string $rid): int
{
    $file = $ctx['file'] . '.checkpoints/' . $ctx['coin'] . '.closed';
    return is_file($file) ? substr_count((string) file_get_contents($file), '"requestId":"' . $rid . '"') : 0;
}
function closed_rows(array $ctx, string $rid): int
{
    $q = $ctx['db']->prepare('SELECT COUNT(*) FROM ledger_closed_sales WHERE coin_id=? AND request_id=?');
    $q->execute([$ctx['coin'], $rid]);
    return (int) $q->fetchColumn();
}
// A sale that stopped with its transfer submitted and not yet executed; returns the entry a delivery in flight would commit.
function in_flight(array &$cx, array $buyer): array
{
    global $CRASH_AT, $NOW;
    $rq = request($cx, $buyer, 100, 20);
    $CRASH_AT = 'submitted';
    try { sell($cx, $rq); } catch (RuntimeException $e) {}
    $row = purchase_row($cx['db'], $cx['coin'], $rq['requestId']);
    $proposal = spend_proposal($cx['db'], $cx['coin'], $row['proposal_digest']);
    $prepared = ledger_prepare_transfer($cx['db'], $cx['coin'], json_decode($proposal['authorization_json'], true), max($NOW, ledger_head_time($cx['db'], $cx['coin'])));
    return [$rq, $prepared];
}
function try_commit(array $cx, array $prepared, ?PDO $via = null): string
{
    global $NOW;
    try { ledger_commit($via ?? $cx['db'], $cx['coin'], $prepared, ledger_sign($cx['node']['private'], $prepared['hash']), [], $NOW); return 'committed'; } catch (LedgerError $e) { return $e->reason; }
}

echo "== a sale that failed is closed in one step, and the closure says what the issuer needs to see\n";
$cx = single_ctx(terms());
watch_release($cx);
$b = owner();
$rq = request($cx, $b, 100, 20);
$CRASH_AT = 'journaled';
try { sell($cx, $rq); } catch (RuntimeException $e) {}
t(locked($cx) === 1 && head_index($cx) === 0, 'a sale that was journaled and delivered nothing holds its credential');
purchase_cancel($cx['db'], $cx['gold'], $cx['coin'], $rq['requestId'], $cx['node'], null);
$cl = $GIVEN[$rq['requestId']][0] ?? null;
t($cl !== null && $cl['payload']['v'] === 2 && $cl['witnesses'] === [] && $cl['payload']['requestId'] === $rq['requestId'] && locked($cx) === 0, 'the cancel frees the credential against a closure with no witnesses');
t($cl && ledger_digest($cl['payload']['genesis']) === ledger_coin($cx['db'], $cx['coin'])['genesis_digest'] && ledger_digest($cl['payload']['genesis']) === ledger_binding($cx['db'], $cx['coin'])['genesis'], 'it carries the genesis, whose digest is the one the buyer signed for');
t($cl && count($cl['payload']['genesis']['roster']) === 1 && $cl['payload']['genesis']['roster'][0]['domain'] === $cl['payload']['domain'] && $cl['payload']['genesis']['mode'] === 'single', 'which shows one domain in the roster, the one that signed');
t($cl && ledger_verify(peer_public($cx['node']), ledger_canonical($cl['payload']), $cl['signature']), 'and the authority signed it');
t(closed_rows($cx, $rq['requestId']) === 1 && closed_lines($cx, $rq['requestId']) === 1, 'the sale is closed in the database and in the file beside the checkpoint records');
t(refuses(fn() => sell($cx, $rq), 'sale-closed') && head_index($cx) === 0, 'the same request made again is refused as closed');
$fresh = request($cx, $b, 100, 20, ['credential' => $rq['credential']]);
$ok = sell($cx, $fresh);
t($ok['receipt']['entry']['amount'] === '200' && head_index($cx) === 1, 'the freed credential buys under a new request, once');

echo "\n== closing the same sale again changes nothing\n";
$row = purchase_row($cx['db'], $cx['coin'], $rq['requestId']);
$again = purchase_closure($cx['db'], $cx['node'], $row, null);
t($again['payload']['requestId'] === $rq['requestId'] && closed_lines($cx, $rq['requestId']) === 1 && closed_rows($cx, $rq['requestId']) === 1, 'a second closure is signed from the same record, with one line and one row');

echo "\n== a delivery prepared before the closure is refused when it commits\n";
$cx = single_ctx(terms());
watch_release($cx);
$b = owner();
[$rq, $prepared] = in_flight($cx, $b);
t(ledger_request_entry($cx['db'], $cx['coin'], $rq['requestId']) === null, 'a sale whose transfer is submitted, with its entry prepared');
purchase_cancel($cx['db'], $cx['gold'], $cx['coin'], $rq['requestId'], $cx['node'], null);
t(try_commit($cx, $prepared) === 'sale-closed' && head_index($cx) === 0 && held($cx, $b['key']) === 0, 'once the sale is closed that entry is refused, and nothing is delivered');
t(spend_proposal($cx['db'], $cx['coin'], purchase_row($cx['db'], $cx['coin'], $rq['requestId'])['proposal_digest'])['status'] === 'rejected', 'and the sale\'s transfer is closed too');
t(recover($cx) === [] && head_index($cx) === 0, 'recovery has nothing to deliver');

echo "\n== two connections: whichever comes first decides\n";
$cx = single_ctx(terms());
watch_release($cx);
$b = owner();
[$rq, $prepared] = in_flight($cx, $b);
$other = ledger_open($cx['file']);
$row = purchase_row($cx['db'], $cx['coin'], $rq['requestId']);
spend_reject($cx['db'], $cx['coin'], $row['proposal_digest'], 'rejected', 'cancelled');
$closure = purchase_closure($cx['db'], $cx['node'], purchase_row($cx['db'], $cx['coin'], $rq['requestId']), null);
t(try_commit($cx, $prepared, $other) === 'sale-closed' && head_index($cx) === 0, 'a second connection that commits after the closure is refused');
$cy = single_ctx(terms());
$b2 = owner();
[$rq2, $prepared2] = in_flight($cy, $b2);
$other2 = ledger_open($cy['file']);
$row2 = purchase_row($cy['db'], $cy['coin'], $rq2['requestId']);
t(try_commit($cy, $prepared2, $other2) === 'committed' && head_index($cy) === 1 && held($cy, $b2['key']) === 200, 'a delivery that commits first stands');
t(refuses(fn() => purchase_closure($cy['db'], $cy['node'], $row2, null), 'cannot-cancel') && closed_rows($cy, $rq2['requestId']) === 0 && closed_lines($cy, $rq2['requestId']) === 0, 'and no closure is made for it, in the database or the file');
t(refuses(fn() => purchase_closure($other2, $cy['node'], $row2, null), 'cannot-cancel'), 'not through the other connection either');

echo "\n== a delivered sale is never released\n";
$cx = single_ctx(terms());
watch_release($cx);
$b = owner();
$rq = request($cx, $b, 100, 20);
sell($cx, $rq);
t(refuses(fn() => purchase_cancel($cx['db'], $cx['gold'], $cx['coin'], $rq['requestId'], $cx['node'], null), 'cannot-cancel') && ($GIVEN[$rq['requestId']] ?? []) === [], 'cancelling a delivered sale is refused and no closure is made');
t(closed_rows($cx, $rq['requestId']) === 0 && closed_lines($cx, $rq['requestId']) === 0 && count_rows($cx, 'SELECT COUNT(*) FROM spent') === 1, 'nothing is recorded as closed, and the credential was spent');
$replay = sell($cx, $rq);
t($replay['receipt']['entry']['index'] === 1 && head_index($cx) === 1, 'the same request again returns the stored result');

echo "\n== an older database put back does not reopen a closed sale\n";
$cx = single_ctx(terms());
watch_release($cx);
$b = owner();
[$rq, $prepared] = in_flight($cx, $b);
$old = snapshot($cx);
purchase_cancel($cx['db'], $cx['gold'], $cx['coin'], $rq['requestId'], $cx['node'], null);
t(closed_rows($cx, $rq['requestId']) === 1 && locked($cx) === 0, 'the sale is closed after the copy was taken');
restore($cx, $old);
t(closed_rows($cx, $rq['requestId']) === 0 && purchase_row($cx['db'], $cx['coin'], $rq['requestId'])['status'] === 'decided' && ledger_guard_check($cx['db'], $cx['coin'], false)['status'] === 'ok', 'the older copy has no closed row, the sale is journaled again, and the checkpoint sees nothing wrong with the log');
t(ledger_sale_closed($cx['db'], $cx['coin'], $rq['requestId']), 'the closed sale is still known from the file');
t(refuses(fn() => sell($cx, $rq), 'sale-closed') && head_index($cx) === 0, 'the same request is refused');
t(try_commit($cx, $prepared) === 'sale-closed' && head_index($cx) === 0 && held($cx, $b['key']) === 0, 'the entry that was prepared before is refused');
$out = recover($cx);
t(($out[$rq['requestId']] ?? '') === 'sale-closed' && head_index($cx) === 0 && held($cx, $b['key']) === 0, 'recovery of the restored journal row ends it without delivering', $out);
t(purchase_row($cx['db'], $cx['coin'], $rq['requestId'])['status'] === 'abandoned' && locked($cx) === 0, 'and frees the credential, which the closure had already released');
$rows = (int) $cx['db']->query("SELECT COUNT(*) FROM ledger_proposals WHERE status='pending'")->fetchColumn();
t($rows === 0, 'no transfer of the sale is left waiting');

echo "\n== a delivery cannot sneak in after a restore: the same copy, with the sale journal and transfer lost as well\n";
$cx = single_ctx(terms());
watch_release($cx);
$b = owner();
$before = snapshot($cx);
$rq = request($cx, $b, 100, 20);
$CRASH_AT = 'journaled';
try { sell($cx, $rq); } catch (RuntimeException $e) {}
purchase_cancel($cx['db'], $cx['gold'], $cx['coin'], $rq['requestId'], $cx['node'], null);
restore($cx, $before);
t(purchase_row($cx['db'], $cx['coin'], $rq['requestId']) === null && closed_rows($cx, $rq['requestId']) === 0, 'a copy from before the sale: no journal row, no closed row');
t(refuses(fn() => sell($cx, $rq), 'sale-closed') && head_index($cx) === 0 && held($cx, $b['key']) === 0, 'the closed request cannot be sold again');
$fresh2 = request($cx, $b, 100, 20, ['credential' => $rq['credential']]);
$ok2 = sell($cx, $fresh2);
t($ok2['receipt']['entry']['amount'] === '200', 'a new request on the freed credential still works');

echo "\n== interrupted and damaged closure records\n";
$cx = single_ctx(terms());
watch_release($cx);
$b = owner();
$rq = request($cx, $b, 100, 20);
$CRASH_AT = 'journaled';
try { sell($cx, $rq); } catch (RuntimeException $e) {}
$closedFile = $cx['file'] . '.checkpoints/' . $cx['coin'] . '.closed';
@mkdir($cx['file'] . '.checkpoints', 0700, true);
mkdir($closedFile);
$caught = why(fn() => purchase_cancel($cx['db'], $cx['gold'], $cx['coin'], $rq['requestId'], $cx['node'], null));
t(str_starts_with($caught, 'checkpoint-unavailable') && ($GIVEN[$rq['requestId']] ?? []) === [] && locked($cx) === 1, 'a closure that cannot be written down is not made: nothing is signed and the credential stays held', $caught);
t(closed_rows($cx, $rq['requestId']) === 0 && purchase_row($cx['db'], $cx['coin'], $rq['requestId'])['status'] === 'decided', 'the database does not hold it either, and the sale is still journaled');
rmdir($closedFile);
$res = recover($cx);
t(str_starts_with($res[$rq['requestId']] ?? '', 'done') && head_index($cx) === 1, 'the sale, not closed, can still be delivered by recovery');

$cx = single_ctx(terms());
watch_release($cx);
$b = owner();
$rq = request($cx, $b, 100, 20);
$CRASH_AT = 'journaled';
try { sell($cx, $rq); } catch (RuntimeException $e) {}
$closedFile = $cx['file'] . '.checkpoints/' . $cx['coin'] . '.closed';
guard_append($closedFile, ['v' => 1, 'kind' => 'close', 'coinId' => $cx['coin'], 'requestId' => $rq['requestId'], 'at' => $NOW]);
t(closed_rows($cx, $rq['requestId']) === 0 && ledger_sale_closed($cx['db'], $cx['coin'], $rq['requestId']), 'a crash after the line was written and before the database row: the sale is closed');
t(refuses(fn() => sell($cx, $rq), 'sale-closed') && head_index($cx) === 0, 'and it is not delivered');
purchase_cancel($cx['db'], $cx['gold'], $cx['coin'], $rq['requestId'], $cx['node'], null);
t(closed_rows($cx, $rq['requestId']) === 1 && closed_lines($cx, $rq['requestId']) === 1 && locked($cx) === 0 && ($GIVEN[$rq['requestId']] ?? []) !== [], 'the cancel that follows finishes it: the row, no second line, and the credential freed against the closure');

$cx = single_ctx(terms());
watch_release($cx);
$b = owner();
$rq = request($cx, $b, 100, 20);
$CRASH_AT = 'journaled';
try { sell($cx, $rq); } catch (RuntimeException $e) {}
$closedFile = $cx['file'] . '.checkpoints/' . $cx['coin'] . '.closed';
@mkdir($cx['file'] . '.checkpoints', 0700, true);
file_put_contents($closedFile, '{"v":1,"kind":"close","coinId":"' . $cx['coin'] . '","requestId":"' . substr($rq['requestId'], 0, 10));
t(!ledger_sale_closed($cx['db'], $cx['coin'], $rq['requestId']), 'a line cut short by a crash says nothing');
purchase_cancel($cx['db'], $cx['gold'], $cx['coin'], $rq['requestId'], $cx['node'], null);
t(ledger_sale_closed($cx['db'], $cx['coin'], $rq['requestId']) && closed_rows($cx, $rq['requestId']) === 1 && guard_closed_ids($cx['db'], $cx['coin']) === [$rq['requestId'] => true], 'the closure after it is written whole and read back');
// A line that was changed.
$other = request($cx, owner(), 100, 20);
$CRASH_AT = 'journaled';
try { sell($cx, $other); } catch (RuntimeException $e) {}
purchase_cancel($cx['db'], $cx['gold'], $cx['coin'], $other['requestId'], $cx['node'], null);
$text = (string) file_get_contents($closedFile);
$lines = array_values(array_filter(explode("\n", $text), fn($l) => str_starts_with($l, '{') && str_ends_with($l, '}')));
t(count($lines) === 2, 'two closed sales are in the file', count($lines));
file_put_contents($closedFile, str_replace('"kind":"close"', '"kind":"cloze"', $lines[0]) . "\n" . $lines[1] . "\n");
$caught = why(fn() => ledger_sale_closed($cx['db'], $cx['coin'], bin2hex(random_bytes(16))));
t(str_starts_with($caught, 'checkpoint-unavailable'), 'a closed-sales file that was changed is read as damaged, and nothing is sold from it', $caught);
$fresh = request($cx, owner(), 100, 20);
t(str_starts_with(why(fn() => sell($cx, $fresh)), 'checkpoint-unavailable') && head_index($cx) === 0, 'so a new sale is refused until the file is looked at');

echo "\n== two processes at once: a delivery and a closure of the same sale\n";
$delivered = 0;
$closedOnly = 0;
$both = 0;
$neither = 0;
for ($round = 0; $round < 16; $round++) {
    $cz = single_ctx(terms());
    $bz = owner();
    [$rqz, $preparedz] = in_flight($cz, $bz);
    $rowz = purchase_row($cz['db'], $cz['coin'], $rqz['requestId']);
    spend_reject($cz['db'], $cz['coin'], $rowz['proposal_digest'], 'rejected', 'cancelled');
    $go = $cz['file'] . '.go';
    $procs = [];
    $pipes = [];
    foreach (['commit', 'close'] as $mode) {
        $job = tempnam(sys_get_temp_dir(), 'race-job-');
        file_put_contents($job, json_encode(['mode' => $mode, 'file' => $cz['file'], 'coin' => $cz['coin'], 'go' => $go, 'now' => $NOW, 'prepared' => $preparedz, 'delayUs' => $mode === ($round % 2 === 0 ? 'commit' : 'close') ? random_int(0, 6000) : 0,
            'signature' => ledger_sign($cz['node']['private'], $preparedz['hash']), 'node' => $cz['node'], 'row' => purchase_row($cz['db'], $cz['coin'], $rqz['requestId'])]));
        $procs[$mode] = proc_open([PHP_BINARY, __DIR__ . '/support/closure-race-worker.php', $job], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes[$mode]);
    }
    usleep(200000);
    touch($go);
    $out = [];
    foreach ($procs as $mode => $proc) {
        $out[$mode] = trim((string) stream_get_contents($pipes[$mode][1])) . trim((string) stream_get_contents($pipes[$mode][2]));
        proc_close($proc);
    }
    $fresh = ledger_open($cz['file']);
    $entry = ledger_request_entry($fresh, $cz['coin'], $rqz['requestId']) !== null;
    $closedNow = ledger_sale_closed($fresh, $cz['coin'], $rqz['requestId']);
    if ($entry && $closedNow) $both++;
    elseif ($entry) $delivered++;
    elseif ($closedNow) $closedOnly++;
    else $neither++;
    if ($entry) t(str_contains($out['close'], 'cannot-cancel') && closed_lines($cz, $rqz['requestId']) === 0, 'round ' . $round . ': the delivery won, and the closure was refused and left no record', $out);
    else t(str_contains($out['commit'], 'sale-closed') || str_contains($out['commit'], 'pending'), 'round ' . $round . ': the closure won, and the delivery was refused', $out);
}
t($both === 0 && $neither === 0, 'in no round was a sale both delivered and closed, or neither', ['both' => $both, 'neither' => $neither, 'delivered' => $delivered, 'closed' => $closedOnly]);

echo "\n== a coin of several domains keeps its witnesses and its liveness\n";
// Closing asks the partners with the real clock, so a cluster built at that time is needed.
$NOW = time();
$mx = multi_ctx(null, terms());
$mx['file'] = $CLUSTER['a.example']['file'];
$c = $mx['cluster'];
watch_release($mx);
$buyer = owner();
$rqm = request($mx, $buyer, 100, 20);
$CRASH_AT = 'journaled';
try { sell($mx, $rqm); } catch (RuntimeException $e) {}
$bSnapshot = (function () use ($CLUSTER) { $d = tempnam(sys_get_temp_dir(), 'partner-backup-'); unlink($d); $CLUSTER['b.example']['db']->exec("VACUUM INTO '" . $d . "'"); return $d; })();
purchase_cancel($mx['db'], $mx['gold'], $mx['coin'], $rqm['requestId'], $mx['node'], 'transport');
$mc = $GIVEN[$rqm['requestId']][0] ?? null;
t($mc !== null && $mc['payload']['v'] === 1 && count($mc['witnesses']) >= 1 && !array_key_exists('genesis', $mc['payload']), 'a sale of a coin of three domains is closed with its partners\' witnesses, in the form it had');
t(!ledger_sale_closed($mx['db'], $mx['coin'], $rqm['requestId']), 'the authority itself writes no closure of its own: the partners decide');
t(ledger_sale_closed(ndb('b.example'), $c['coin'], $rqm['requestId']), 'a witnessing partner has the sale closed');
// The partner is put back to a copy from before it witnessed.
$bfile = $CLUSTER['b.example']['file'];
$CLUSTER['b.example']['db'] = null;
foreach (['', '-wal', '-shm'] as $suffix) @unlink($bfile . $suffix);
copy($bSnapshot, $bfile);
$CLUSTER['b.example']['db'] = ledger_open($bfile);
t((int) ndb('b.example')->query('SELECT COUNT(*) FROM ledger_closed_sales')->fetchColumn() === 0 && ledger_sale_closed(ndb('b.example'), $c['coin'], $rqm['requestId']), 'a partner restored from a copy from before it witnessed still has the sale closed');
// The authority's partner down: the cancel waits, and the sale can still be delivered by recovery.
$my = multi_ctx(null, terms());
$my['file'] = $CLUSTER['a.example']['file'];
watch_release($my);
$rqy = request($my, owner(), 100, 20);
$CRASH_AT = 'journaled';
try { sell($my, $rqy); } catch (RuntimeException $e) {}
$down = fn(string $to, array $env) => ledger_fail('peer-down', 'down');
$verdict = why(fn() => purchase_cancel($my['db'], $my['gold'], $my['coin'], $rqy['requestId'], $my['node'], $down));
t(str_starts_with($verdict, 'busy') && !ledger_sale_closed($my['db'], $my['coin'], $rqy['requestId']), 'with the partners down the cancel waits and closes nothing at the authority', $verdict);
$res = recover($my);
t(str_starts_with($res[$rqy['requestId']] ?? '', 'done'), 'so the sale can still be delivered when they are back', $res);

echo "\n" . ($failures === 0 ? 'ALL ' . $total . ' CHAIN-LABS PURCHASE CLOSURE CHECKS PASSED' : $failures . ' of ' . $total . ' checks FAILED') . "\n";
exit($failures === 0 ? 0 : 1);
