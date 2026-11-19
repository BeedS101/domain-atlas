<?php
declare(strict_types=1);
// What a restored older database does to a sale that was under way. The sale journal (ledger_purchases) and the rows that record what
// a domain approved or closed are not part of the entry log, so the checkpoint journal does not bring them back. This shows what that
// costs and what stops it:
//   - a sale whose delivery entry was lost with the rollback is not abandoned, cancelled or restarted while the coin is stopped, so
//     the Gold credential is not released while the entry can still come back
//   - once the entries are replayed the sale is finished once: one delivery, one spend of the credential
//   - a request whose journal row was lost cannot be delivered a second time (the sales table is rebuilt from the log); the credential
//     stays held and the operator finishes it deliberately
//
//   php test/chain-labs-rollback-purchase.php
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
function terms(): array
{
    global $ISSUER;
    return ['priceClass' => 'atlas.element.gold', 'issuerKey' => $ISSUER['issuerKey'], 'unitsPerPrice' => 10, 'minPrice' => 5, 'perKeyUnits' => '2000', 'perDayUnits' => '3000'];
}
function single_ctx(): array
{
    global $NOW, $ISSUER;
    $file = tempnam(sys_get_temp_dir(), 'purchase-rollback-') . '.sqlite';
    $db = ledger_open($file);
    $domPriv = ec_private();
    $treasury = ledger_new_owner_key();
    $genesis = ledger_genesis(['symbol' => 'SGL', 'name' => 'Coin SGL', 'decimals' => 2, 'maxUnits' => '1000000', 'initialUnits' => '100000', 'treasuryKey' => $treasury['key'], 'mode' => 'single',
        'visibility' => 'public', 'roster' => [['domain' => 'a.example', 'key' => peer_public(['private' => $domPriv])]], 'createdAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW - 3600), 'purchase' => terms()]);
    ledger_register($db, $genesis, $treasury['key'], null);
    ledger_add_genesis_signature($db, $genesis['coinId'], 'a.example', ledger_genesis_sign($genesis, $domPriv));
    ledger_activate($db, $genesis['coinId'], $domPriv);
    $gold = stand_in_gold(tempnam(sys_get_temp_dir(), 'gold-') . '.sqlite', $ISSUER);
    $gold['crash'] = 'crash_hook';
    return ['db' => $db, 'file' => $file, 'coin' => $genesis['coinId'], 'node' => ['domain' => 'a.example', 'private' => $domPriv, 'pinned' => []],
        'treasury' => ['key' => $treasury['key'], 'private' => $treasury['private']], 'gold' => $gold, 'send' => null];
}
function request(array $ctx, array $buyer, int $quantity, int $price, ?array $credential = null): array
{
    global $ISSUER, $NOW;
    $credential ??= stand_in_credential($ISSUER, $buyer['key'], $quantity);
    $rid = bin2hex(random_bytes(16));
    return ['credential' => $credential, 'requestId' => $rid, 'buyer' => $buyer,
        'intent' => stand_in_intent($buyer, $ctx['coin'], $credential, $price, $rid, null, $NOW + 300, ledger_binding($ctx['db'], $ctx['coin']))];
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
function snapshot(array $ctx): string
{
    $dest = tempnam(sys_get_temp_dir(), 'purchase-backup-');
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
function status_of(array $ctx, string $rid): ?string
{
    $row = purchase_row($ctx['db'], $ctx['coin'], $rid);
    return $row === null ? null : $row['status'];
}
function sale_with_crash(array &$cx, array $buyer, string $point): array
{
    global $CRASH_AT;
    $rq = request($cx, $buyer, 100, 20);
    $CRASH_AT = $point;
    try { sell($cx, $rq); } catch (RuntimeException $e) { }
    return $rq;
}

echo "== a sale whose delivery was lost with the rollback is not ended while the coin is stopped\n";
$cx = single_ctx();
$b = owner();
$rq = request($cx, $b, 100, 20);
$CRASH_AT = 'journaled';
try { sell($cx, $rq); } catch (RuntimeException $e) { }
$old = snapshot($cx);
t(status_of($cx, $rq['requestId']) === 'decided' && head_index($cx) === 0, 'the copy is taken with the sale journaled and nothing delivered');
$CRASH_AT = 'credited';
try { recover($cx); } catch (RuntimeException $e) { }
t(head_index($cx) === 1 && sold_entries($cx, $rq['requestId']) === 1 && held($cx, $b['key']) === 200 && count_rows($cx, 'SELECT COUNT(*) FROM locks') === 1 && count_rows($cx, 'SELECT COUNT(*) FROM spent') === 0,
    'the sale delivers its units and stops before the credential is dealt with: the credential is held and not spent');
restore($cx, $old);
t(head_index($cx) === 0 && ledger_guard_check($cx['db'], $cx['coin'], false)['status'] === 'halted' && sold_entries($cx, $rq['requestId']) === 0, 'the older copy is put back: the delivery is gone from the database and the coin is stopped');

$out = recover($cx);
t(($out[$rq['requestId']] ?? '') === 'rollback-detected', 'recovery of the sale is refused because the coin is stopped', $out);
t(status_of($cx, $rq['requestId']) === 'decided' && count_rows($cx, 'SELECT COUNT(*) FROM locks') === 1 && count_rows($cx, 'SELECT COUNT(*) FROM spent') === 0, 'the sale is not abandoned and the credential is not released', status_of($cx, $rq['requestId']));
t(refuses(fn() => purchase_cancel($cx['db'], $cx['gold'], $cx['coin'], $rq['requestId'], $cx['node'], null), 'rollback-detected') && count_rows($cx, 'SELECT COUNT(*) FROM locks') === 1, 'an operator\'s cancel is refused too');
$other = request($cx, owner(), 100, 20);
t(refuses(fn() => sell($cx, $other), 'rollback-detected') && count_rows($cx, 'SELECT COUNT(*) FROM locks') === 1, 'a new sale is refused before any credential is locked');
t(refuses(fn() => sell($cx, $rq), 'rollback-detected') && head_index($cx) === 0, 'and so is the same request made again');

$replayed = ledger_guard_replay($cx['db'], $cx['coin'], $NOW);
t($replayed['applied'] === 1 && head_index($cx) === 1 && ledger_guard_check($cx['db'], $cx['coin'], false)['status'] === 'ok', 'the journal puts the delivery back and the coin runs again', $replayed);
t(ledger_check($cx['db'], $cx['coin']) === [] && ledger_request_entry($cx['db'], $cx['coin'], $rq['requestId']) === 1 && sold_entries($cx, $rq['requestId']) === 1, 'the stored sales are rebuilt from the replayed log and the checker finds nothing wrong', ledger_check($cx['db'], $cx['coin']));
$out = recover($cx);
t(str_starts_with($out[$rq['requestId']] ?? '', 'done') && count_rows($cx, 'SELECT COUNT(*) FROM spent') === 1 && count_rows($cx, 'SELECT COUNT(*) FROM locks') === 0 && head_index($cx) === 1 && held($cx, $b['key']) === 200,
    'the sale then finishes once: one delivery, the credential spent once', $out);
$again = sell($cx, $rq);
t($again['receipt']['entry']['index'] === 1 && head_index($cx) === 1, 'and the same request made again returns the stored result');

echo "\n== a sale whose journal row was lost with the rollback cannot deliver twice\n";
$cx = single_ctx();
$b = owner();
$before = snapshot($cx);
$rq = sale_with_crash($cx, $b, 'credited');
t(head_index($cx) === 1 && status_of($cx, $rq['requestId']) === 'credited' && count_rows($cx, 'SELECT COUNT(*) FROM locks') === 1, 'a sale delivers and stops before the credential is dealt with');
restore($cx, $before);
t(status_of($cx, $rq['requestId']) === null && head_index($cx) === 0, 'the copy from before the sale is put back: no journal row, no entry');
t(recover($cx) === [] && refuses(fn() => sell($cx, $rq), 'rollback-detected'), 'nothing runs while the coin is stopped');
ledger_guard_replay($cx['db'], $cx['coin'], $NOW);
t(head_index($cx) === 1 && ledger_check($cx['db'], $cx['coin']) === [] && status_of($cx, $rq['requestId']) === null, 'the journal brings the entry back; the sale journal row is not part of it');
t(refuses(fn() => sell($cx, $rq), 'duplicate-purchase') && head_index($cx) === 1 && sold_entries($cx, $rq['requestId']) === 1 && held($cx, $b['key']) === 200, 'the request cannot be delivered again: the units were delivered once', why(fn() => sell($cx, $rq)));
t(count_rows($cx, 'SELECT COUNT(*) FROM locks') === 1 && count_rows($cx, 'SELECT COUNT(*) FROM spent') === 0 && recover($cx) === [], 'the credential stays held, not released and not spent, and recovery has no row to finish: the operator finishes it at the issuer');

echo "\n== a coin whose loss was accepted keeps its sales held\n";
$cx = single_ctx();
$b = owner();
$old = snapshot($cx);
$rq = sale_with_crash($cx, $b, 'credited');
restore($cx, $old);
$head = ledger_head($cx['db'], $cx['coin']);
$verdict = ledger_guard_check($cx['db'], $cx['coin'], false);
ledger_guard_accept($cx['db'], $cx['coin'], ['floorIndex' => $verdict['detail']['floorIndex'], 'floorHash' => $verdict['detail']['floorHash'], 'databaseIndex' => $verdict['detail']['databaseIndex']], 'test', $NOW);
t(recover($cx) === [] && count_rows($cx, 'SELECT COUNT(*) FROM locks') === 1 && refuses(fn() => sell($cx, $rq), 'not-active'), 'nothing is delivered or released on a coin that was retired');

echo "\n== a partner that lost entries does not witness that a sale is closed\n";
cluster(3);
$c = open_coin(3, null, 'public', null, 'MUL', terms());
open_now($c);
foreach (array_keys($CLUSTER) as $d) $CLUSTER[$d]['node']['gold'] = stand_in_gold(tempnam(sys_get_temp_dir(), 'gold-') . '.sqlite', ['public' => $ISSUER['public']]);
$sellerGold = stand_in_gold(tempnam(sys_get_temp_dir(), 'gold-') . '.sqlite', $ISSUER);
$CLUSTER['a.example']['node']['gold'] = $sellerGold;
$mx = ['db' => ndb('a.example'), 'file' => $CLUSTER['a.example']['file'], 'coin' => $c['coin'], 'node' => $CLUSTER['a.example']['node'], 'treasury' => ['key' => $c['treasury']['key'], 'private' => $c['treasury']['priv']], 'gold' => $sellerGold, 'send' => 'transport'];
$buyer = owner();
$bBackup = (function () use ($CLUSTER) { $d = tempnam(sys_get_temp_dir(), 'partner-backup-'); unlink($d); $CLUSTER['b.example']['db']->exec("VACUUM INTO '" . $d . "'"); return $d; })();
$rqm = request($mx, $buyer, 100, 20);
$done = sell($mx, $rqm);
t($done['receipt']['entry']['index'] === 1 && ledger_head(ndb('b.example'), $c['coin'])['index'] === 1, 'a sale on a coin of three domains delivers and the partner holds the entry');
$file = $CLUSTER['b.example']['file'];
$CLUSTER['b.example']['db'] = null;
foreach (['', '-wal', '-shm'] as $suffix) @unlink($file . $suffix);
copy($bBackup, $file);
$CLUSTER['b.example']['db'] = ledger_open($file);
$body = ['coinId' => $c['coin'], 'requestId' => $rqm['requestId'], 'credentialId' => $rqm['credential']['id'], 'price' => 20];
t(ledger_guard_check(ndb('b.example'), $c['coin'], false)['status'] === 'halted' && ledger_request_entry(ndb('b.example'), $c['coin'], $rqm['requestId']) === null, 'the partner restored from an older copy no longer holds the delivery and is stopped');
$verdict = why(fn() => peer_on_close_sale(ndb('b.example'), node('b.example'), 'a.example', $body, $NOW + 1, fn(string $to, array $env) => ledger_fail('peer-down', 'down')));
t(str_starts_with($verdict, 'rollback-detected'), 'it refuses to witness that the sale is closed, which would have freed a credential that was already paid for', $verdict);
t((int) ndb('b.example')->query('SELECT COUNT(*) FROM ledger_closed_sales')->fetchColumn() === 0, 'and keeps no record of a closed sale');

echo "\n" . ($failures === 0 ? 'ALL ' . $total . ' CHAIN-LABS ROLLBACK PURCHASE CHECKS PASSED' : $failures . ' of ' . $total . ' checks FAILED') . "\n";
exit($failures === 0 ? 0 : 1);
