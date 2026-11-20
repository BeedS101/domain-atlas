<?php
declare(strict_types=1);
// Reproduction: a partner that approved a purchase entry witnesses the cancellation of the same sale after its database went back.
// `approve` lines in the checkpoint log are the memory that outlasts the database (peer_on_approve reads them through
// ledger_approval_memory), but peer_on_close_sale decides from the ledger_purchase_approvals table alone.
//
//   php test/chain-labs-audit-witness.php
require __DIR__ . '/support/multi-cluster.php';
require __DIR__ . '/../chain-labs/lib/purchase.php';
require __DIR__ . '/support/gold-stand-in.php';

$NOW = time();
$ISSUER = stand_in_issuer();
function terms(): array
{
    global $ISSUER;
    return ['priceClass' => 'atlas.element.gold', 'issuerKey' => $ISSUER['issuerKey'], 'unitsPerPrice' => 10, 'minPrice' => 5, 'perKeyUnits' => '2000', 'perDayUnits' => '3000'];
}
function gold_for(array $issuer, bool $seller): array
{
    return stand_in_gold(tempnam(sys_get_temp_dir(), 'gold-') . '.sqlite', $seller ? $issuer : ['public' => $issuer['public']]);
}
function snapshot_of(PDO $db): string
{
    $dest = tempnam(sys_get_temp_dir(), 'witness-backup-');
    unlink($dest);
    $db->exec("VACUUM INTO '" . $dest . "'");
    return $dest;
}
function put_back(string $domain, string $backup): void
{
    global $CLUSTER;
    $file = $CLUSTER[$domain]['file'];
    $CLUSTER[$domain]['db'] = null;
    foreach (['', '-wal', '-shm'] as $suffix) @unlink($file . $suffix);
    copy($backup, $file);
    $CLUSTER[$domain]['db'] = ledger_open($file);
}

echo "== a partner approved the delivery entry, the authority did not commit it\n";
cluster(3);
$c = open_coin(3, 2, 'public', null, 'MUL', terms());
open_now($c);
foreach (array_keys($CLUSTER) as $d) $CLUSTER[$d]['node']['gold'] = gold_for($ISSUER, false);
$gold = gold_for($ISSUER, true);
$CLUSTER['a.example']['node']['gold'] = $gold;
$ctx = ['db' => ndb('a.example'), 'coin' => $c['coin'], 'node' => $CLUSTER['a.example']['node'], 'treasury' => ['key' => $c['treasury']['key'], 'private' => $c['treasury']['priv']], 'gold' => $gold];
$GIVEN = [];
$release = $gold['release'];
$ctx['gold']['release'] = function (string $requestId, string $credentialId = '', ?callable $closure = null) use ($release, &$GIVEN): void {
    if ($closure !== null) $GIVEN[$requestId] = $closure();
    $release($requestId, $credentialId, $closure);
};
$buyer = owner();
$credential = stand_in_credential($ISSUER, $buyer['key'], 100);
$rid = bin2hex(random_bytes(16));
$intent = stand_in_intent($buyer, $c['coin'], $credential, 20, $rid, null, $NOW + 300, ledger_binding($ctx['db'], $c['coin']));

$bBefore = snapshot_of(ndb('b.example'));
$taken = null;
$send = function (string $to, array $env) use (&$taken) {
    $answer = transport($to, $env);
    if ($to === 'b.example' && $env['payload']['action'] === 'approve') {
        $taken = ['signature' => $answer['signature'], 'prepared' => $env['payload']['body']['prepared']];
        throw new RuntimeException('the authority stops after b approved');
    }
    return $answer;
};
try { purchase_submit($ctx['db'], $ctx['node'], $ctx['gold'], $ctx['treasury'], $c['coin'], $intent, $credential, $send, $NOW); } catch (RuntimeException $e) {}
t($taken !== null, 'b approved an entry delivering the sale and the authority holds its signature');
$rowsB = fn() => (int) ndb('b.example')->query("SELECT COUNT(*) FROM ledger_purchase_approvals WHERE request_id='" . $rid . "'")->fetchColumn();
$logB = $CLUSTER['b.example']['file'] . '.checkpoints/' . $c['coin'] . '.log';
t($rowsB() === 1 && is_file($logB) && str_contains((string) file_get_contents($logB), '"kind":"approve"'), 'b has the approval in its database and in its checkpoint log');
$aAtApproval = snapshot_of($ctx['db']);

echo "\n== b is put back to a copy from before it approved\n";
put_back('b.example', $bBefore);
t($rowsB() === 0, 'its database has no approval row for the request any more');
$memory = ledger_approval_memory(ndb('b.example'), $c['coin'], $taken['prepared']['public']['index']);
t(isset($memory[$taken['prepared']['hash']]), 'its checkpoint log still remembers having approved that entry (ledger_approval_memory)');
$guard = ledger_guard_check(ndb('b.example'), $c['coin']);
t(($guard['status'] ?? $guard['state'] ?? 'ok') !== 'halted' && ledger_guard_halted(ndb('b.example'), $c['coin']) === null, 'the ordinary rollback guard does not stop b: the approval is not part of the entry log', $guard);
$again = why(fn() => peer_handle(ndb('b.example'), node('b.example'), json_decode(json_encode(peer_envelope(node('a.example'), 'b.example', 'approve', ['coinId' => $c['coin'], 'prepared' => $taken['prepared']], $NOW)), true), $NOW, 'transport'));
t(true, 'for reference, asking b to approve the same entry again (idempotent): ' . $again);

echo "\n== the authority cancels the sale; b must refuse to witness\n";
$direct = why(fn() => peer_handle(ndb('b.example'), node('b.example'), json_decode(json_encode(peer_envelope(node('a.example'), 'b.example', 'close-sale', ['coinId' => $c['coin'], 'requestId' => $rid, 'credentialId' => $credential['id'], 'price' => 20], time())), true), time(), 'transport'));
t(str_starts_with($direct, 'cannot-close'), 'b refuses a close-sale for a request it approved an entry for', $direct);
t(!ledger_sale_closed(ndb('b.example'), $c['coin'], $rid) || str_starts_with($direct, 'cannot-close'), 'and does not record the sale as closed');

echo "\n== what the authority can do with that\n";
// Honest cancel on the authority: rejects the pending proposal and asks the partners for witnesses.
$cancel = why(fn() => purchase_cancel($ctx['db'], $ctx['gold'], $c['coin'], $rid, $ctx['node'], 'transport'));
t(str_starts_with($cancel, 'cannot-cancel') && !isset($GIVEN[$rid]), 'the cancel is refused, so the credential is not freed', $cancel);
if (isset($GIVEN[$rid])) {
    // The credential was freed against a closure with two witnesses. The authority, running modified code from a copy of its own database
    // made before it closed the sale, commits the entry it holds b's approval for.
    $copy = tempnam(sys_get_temp_dir(), 'witness-authority-') . '.sqlite';
    copy($aAtApproval, $copy);
    $dishonest = ledger_open($copy);
    $prepared = $taken['prepared'];
    $committed = why(fn() => ledger_commit($dishonest, $c['coin'], $prepared, ledger_sign(node('a.example')['private'], $prepared['hash']), [['domain' => 'b.example', 'signature' => $taken['signature']]], max($NOW, ledger_head_time($dishonest, $c['coin']))));
    global $ALT;
    $ALT = ['for' => 'b.example', 'db' => $dishonest];
    $applied = why(fn() => peer_catch_up(ndb('b.example'), node('b.example'), $c['coin'], 'transport', $NOW));
    $ALT = null;
    t(false, 'b took the delivery into its own ledger although it had witnessed the closure: ' . $applied . '; b head ' . ledger_head(ndb('b.example'), $c['coin'])['index']);
    t(false, 'IMPACT: the credential was freed and the authority can still commit the delivery with b\'s approval: ' . $committed);
}

// ---------- the same situation again, from a fresh cluster ----------
// A sale for which partner b approved the delivery entry while the authority stopped before committing it. Returns what the scenarios need.
function approved_sale(): array
{
    global $CLUSTER, $ISSUER, $NOW;
    cluster(3);
    $c = open_coin(3, 2, 'public', null, 'MUL', terms());
    open_now($c);
    foreach (array_keys($CLUSTER) as $d) $CLUSTER[$d]['node']['gold'] = gold_for($ISSUER, false);
    $gold = gold_for($ISSUER, true);
    // The code that holds the Gold frees the credential only against the closure it asks the ledger for.
    $release = $gold['release'];
    $gold['release'] = function (string $requestId, string $credentialId = '', ?callable $closure = null) use ($release): void {
        if ($closure !== null) $closure();
        $release($requestId, $credentialId, $closure);
    };
    $CLUSTER['a.example']['node']['gold'] = $gold;
    $ctx = ['db' => ndb('a.example'), 'coin' => $c['coin'], 'node' => $CLUSTER['a.example']['node'], 'treasury' => ['key' => $c['treasury']['key'], 'private' => $c['treasury']['priv']], 'gold' => $gold];
    $buyer = owner();
    $credential = stand_in_credential($ISSUER, $buyer['key'], 100);
    $rid = bin2hex(random_bytes(16));
    $intent = stand_in_intent($buyer, $c['coin'], $credential, 20, $rid, null, $NOW + 300, ledger_binding($ctx['db'], $c['coin']));
    $bBefore = snapshot_of(ndb('b.example'));
    $taken = null;
    $send = function (string $to, array $env) use (&$taken) {
        $answer = transport($to, $env);
        if ($to === 'b.example' && $env['payload']['action'] === 'approve') {
            $taken = ['signature' => $answer['signature'], 'prepared' => $env['payload']['body']['prepared']];
            throw new RuntimeException('the authority stops after b approved');
        }
        return $answer;
    };
    try { purchase_submit($ctx['db'], $ctx['node'], $ctx['gold'], $ctx['treasury'], $c['coin'], $intent, $credential, $send, $NOW); } catch (RuntimeException $e) {}
    return ['c' => $c, 'ctx' => $ctx, 'rid' => $rid, 'credential' => $credential, 'taken' => $taken, 'bBefore' => $bBefore];
}
function close_ask(string $domain, string $coin, string $rid, array $credential): string
{
    return why(fn() => peer_handle(ndb($domain), node($domain), json_decode(json_encode(peer_envelope(node('a.example'), $domain, 'close-sale', ['coinId' => $coin, 'requestId' => $rid, 'credentialId' => $credential['id'], 'price' => 20], time())), true), time(), 'transport'));
}
function gold_count(array $ctx, string $sql): int { return (int) $ctx['gold']['db']->query($sql)->fetchColumn(); }

echo "\n== the sale is delivered once, and the credential is spent once, after the database was put back\n";
$s = approved_sale();
put_back('b.example', $s['bBefore']);
$ctx = $s['ctx'];
$verdict = why(fn() => purchase_cancel($ctx['db'], $ctx['gold'], $s['c']['coin'], $s['rid'], $ctx['node'], 'transport'));
t(str_starts_with($verdict, 'cannot-cancel') && gold_count($ctx, 'SELECT COUNT(*) FROM locks') === 1, 'the cancel is refused and the credential is still held', $verdict);
$res = purchase_recover($ctx['db'], $ctx['node'], $ctx['gold'], $ctx['treasury'], $s['c']['coin'], 'transport', $NOW);
t(str_starts_with((string) ($res[$s['rid']] ?? ''), 'done') && ledger_request_entry($ctx['db'], $s['c']['coin'], $s['rid']) !== null, 'recovery delivers the sale', $res);
t(gold_count($ctx, "SELECT COUNT(*) FROM spent WHERE credential_id='" . $s['credential']['id'] . "'") === 1 && gold_count($ctx, 'SELECT COUNT(*) FROM locks') === 0, 'and the credential is spent once');
$entries = (int) ndb('a.example')->query("SELECT COUNT(*) FROM ledger_log WHERE coin_id='" . $s['c']['coin'] . "' AND public_json LIKE '%" . $s['rid'] . "%'")->fetchColumn();
t($entries === 1, 'in one entry of the ledger', $entries);
t(close_ask('b.example', $s['c']['coin'], $s['rid'], $s['credential']) !== 'no error', 'and no witness is given for a sale that was delivered');

echo "\n== an approval written before the sale was recorded in the line cannot be ruled out while its index is open\n";
$s = approved_sale();
$bLog = $CLUSTER['b.example']['file'] . '.checkpoints/' . $s['c']['coin'] . '.log';
// Rewrite b's log as it would have been written before: the same approval, without the field that names the sale.
$lines = explode("\n", rtrim((string) file_get_contents($bLog), "\n"));
$last = json_decode(array_pop($lines), true);
t(($last['kind'] ?? '') === 'approve' && ($last['requestId'] ?? null) === $s['rid'], 'the approval line names the sale', $last);
file_put_contents($bLog, implode("\n", $lines) . "\n");
guard_append($bLog, ['v' => 1, 'kind' => 'approve', 'coinId' => $s['c']['coin'], 'index' => $last['index'], 'hash' => $last['hash'], 'signature' => $last['signature'], 'at' => $last['at']]);
put_back('b.example', $s['bBefore']);
t(str_starts_with(close_ask('b.example', $s['c']['coin'], $s['rid'], $s['credential']), 'cannot-close'), 'b refuses to witness: an approval for an index it has not committed is not ruled out');
t(str_starts_with(close_ask('b.example', $s['c']['coin'], bin2hex(random_bytes(16)), $s['credential']), 'cannot-close'), 'and refuses for any sale while that approval is open (nothing is guessed from a missing row)');
// The chain moves on: another entry takes that index, which rules the approved entry out for good.
$other = ledger_prepare_transfer(ndb('a.example'), $s['c']['coin'], ledger_grant_authorization(ndb('a.example'), $s['c']['coin'], ['key' => $s['c']['treasury']['key'], 'private' => $s['c']['treasury']['priv']], owner()['key'], '7', max($NOW, ledger_head_time(ndb('a.example'), $s['c']['coin']))), max($NOW, ledger_head_time(ndb('a.example'), $s['c']['coin'])));
$cApproval = peer_handle(ndb('c.example'), node('c.example'), json_decode(json_encode(peer_envelope(node('a.example'), 'c.example', 'approve', ['coinId' => $s['c']['coin'], 'prepared' => ['public' => $other['public'], 'private' => $other['private'], 'hash' => $other['hash']]], $NOW)), true), $NOW, 'transport');
t(($cApproval['decision'] ?? null) === 'approve', 'c approves a different entry for the index');
ledger_commit(ndb('a.example'), $s['c']['coin'], $other, ledger_sign(node('a.example')['private'], $other['hash']), [['domain' => 'c.example', 'signature' => $cApproval['signature']]], max($NOW, ledger_head_time(ndb('a.example'), $s['c']['coin'])));
peer_catch_up(ndb('b.example'), node('b.example'), $s['c']['coin'], 'transport', $NOW);
t(ledger_head(ndb('b.example'), $s['c']['coin'])['index'] === $last['index'], 'b follows the chain to that index');
$freed = close_ask('b.example', $s['c']['coin'], $s['rid'], $s['credential']);
t(!str_starts_with($freed, 'cannot-close'), 'and once another entry holds the index the old approval no longer stops the witness', $freed);

echo "\n== a damaged approval record stops the witness\n";
$s = approved_sale();
$bLog = $CLUSTER['b.example']['file'] . '.checkpoints/' . $s['c']['coin'] . '.log';
put_back('b.example', $s['bBefore']);
$text = (string) file_get_contents($bLog);
$rows = explode("\n", rtrim($text, "\n"));
$rows[count($rows) - 1] = preg_replace('/"at":(\d)/', '"at":9$1', $rows[count($rows) - 1], 1);
file_put_contents($bLog, implode("\n", $rows) . "\n");
t(str_starts_with(close_ask('b.example', $s['c']['coin'], $s['rid'], $s['credential']), 'checkpoint-unavailable') || str_starts_with(close_ask('b.example', $s['c']['coin'], $s['rid'], $s['credential']), 'checkpoint-corrupt'), 'b witnesses nothing while its approval log is damaged');

echo "\n== an honest cancel that only some partners witnessed does not split the copies\n";
$s = approved_sale();
// c witnesses, b refused (it approved). The authority then delivers with b's approval, as recovery would; b and c follow the chain.
t(!str_starts_with(close_ask('c.example', $s['c']['coin'], $s['rid'], $s['credential']), 'cannot-close'), 'c, which never approved, witnesses');
$prepared = $s['taken']['prepared'];
ledger_commit(ndb('a.example'), $s['c']['coin'], $prepared, ledger_sign(node('a.example')['private'], $prepared['hash']), [['domain' => 'b.example', 'signature' => $s['taken']['signature']]], max($NOW, ledger_head_time(ndb('a.example'), $s['c']['coin'])));
peer_catch_up(ndb('c.example'), node('c.example'), $s['c']['coin'], 'transport', $NOW);
peer_catch_up(ndb('b.example'), node('b.example'), $s['c']['coin'], 'transport', $NOW);
t(level($s['c'], ['a.example', 'b.example', 'c.example']), 'a partner that witnessed still takes the entry b approved, so the copies stay level', heads($s['c'], ['a.example', 'b.example', 'c.example']));

echo "\n== approving and closing at the same moment\n";
$rounds = ['approved' => 0, 'closed' => 0, 'both' => 0, 'neither' => 0];
for ($round = 0; $round < 16; $round++) {
    cluster(3);
    $c = open_coin(3, 2, 'public', null, 'MUL', terms());
    open_now($c);
    foreach (array_keys($CLUSTER) as $d) $CLUSTER[$d]['node']['gold'] = gold_for($ISSUER, false);
    $gold = gold_for($ISSUER, true);
    $CLUSTER['a.example']['node']['gold'] = $gold;
    $buyer = owner();
    $credential = stand_in_credential($ISSUER, $buyer['key'], 100);
    $rid = bin2hex(random_bytes(16));
    $intent = stand_in_intent($buyer, $c['coin'], $credential, 20, $rid, null, time() + 300, ledger_binding(ndb('a.example'), $c['coin']));
    $taken = null;
    $send = function (string $to, array $env) use (&$taken) {
        if ($to === 'b.example' && $env['payload']['action'] === 'approve') { $taken = $env; throw new RuntimeException('captured'); }
        return transport($to, $env);
    };
    try { purchase_submit(ndb('a.example'), $CLUSTER['a.example']['node'], $gold, ['key' => $c['treasury']['key'], 'private' => $c['treasury']['priv']], $c['coin'], $intent, $credential, $send, time()); } catch (RuntimeException $e) {}
    $closeEnv = json_decode(json_encode(peer_envelope(node('a.example'), 'b.example', 'close-sale', ['coinId' => $c['coin'], 'requestId' => $rid, 'credentialId' => $credential['id'], 'price' => 20], time())), true);
    $go = tempnam(sys_get_temp_dir(), 'approval-go-');
    unlink($go);
    $procs = [];
    $pipes = [];
    foreach (['approve' => $taken, 'close' => $closeEnv] as $mode => $env) {
        $job = tempnam(sys_get_temp_dir(), 'approval-job-');
        file_put_contents($job, json_encode(['mode' => $mode, 'domain' => 'b.example', 'cluster' => array_map(fn($m) => ['node' => $m['node'], 'file' => $m['file']], $CLUSTER), 'issuer' => $ISSUER['public'], 'envelope' => $env, 'go' => $go, 'delayUs' => $mode === ($round % 2 === 0 ? 'approve' : 'close') ? random_int(0, 80000) : 0]));
        $procs[$mode] = proc_open([PHP_BINARY, __DIR__ . '/support/approval-race-worker.php', $job], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes[$mode]);
    }
    usleep(250000);
    touch($go);
    $out = [];
    foreach ($procs as $mode => $proc) { $out[$mode] = trim((string) stream_get_contents($pipes[$mode][1])) . trim((string) stream_get_contents($pipes[$mode][2])); proc_close($proc); }
    $answered = str_contains($out['approve'], '"result":"') && str_contains($out['close'], '"result":"');
    if (!$answered) { $rounds['neither']++; continue; }
    $okApprove = str_contains($out['approve'], '"result":"ok"');
    $okClose = str_contains($out['close'], '"result":"ok"');
    if ($okApprove && $okClose) $rounds['both']++; elseif ($okApprove) $rounds['approved']++; elseif ($okClose) $rounds['closed']++; else $rounds['neither']++;
}
t($rounds['both'] === 0 && $rounds['neither'] === 0 && $rounds['approved'] + $rounds['closed'] === 16, 'in no round did b both approve the delivery and witness the closure, or do neither (' . json_encode($rounds) . ')', $rounds);

echo "\n" . ($failures === 0 ? 'ALL ' . $total . ' CHAIN-LABS WITNESS CHECKS PASSED' : $failures . ' of ' . $total . ' checks FAILED') . "\n";
exit($failures === 0 ? 0 : 1);
