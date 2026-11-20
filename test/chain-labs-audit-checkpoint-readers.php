<?php
declare(strict_types=1);
// Reproduction: a newline-terminated checkpoint record whose own sum or JSON does not hold, and which is the last complete record of its file, is
// read as if it had never been written (guard_parse and guard_each skip it, and `junk` is counted but never read). What follows from that:
//   - a closed sale is forgotten when the last .closed record is damaged and the database is put back from before the closure
//   - an approval is forgotten when the last log record is the approval and it is damaged, so a second entry can be approved for the index
// What must keep working: a write cut short (no final newline), and a cut write that a later append carried on from.
//
//   php test/chain-labs-audit-checkpoint-readers.php
require __DIR__ . '/support/multi-cluster.php';

$NOW = time();
function copy_of(PDO $db): string
{
    $dest = tempnam(sys_get_temp_dir(), 'readers-backup-');
    unlink($dest);
    $db->exec("VACUUM INTO '" . $dest . "'");
    return $dest;
}
function put_file_back(array &$w, string $backup): void
{
    $w['db'] = null;
    foreach (['', '-wal', '-shm'] as $suffix) @unlink($w['file'] . $suffix);
    copy($backup, $w['file']);
    $w['db'] = ledger_open($w['file']);
}
function single_coin(): array
{
    global $NOW;
    $file = tempnam(sys_get_temp_dir(), 'readers-') . '.sqlite';
    $db = ledger_open($file);
    $priv = ec_private();
    $treasury = owner();
    $genesis = ledger_genesis(['symbol' => 'RDR', 'name' => 'Readers coin', 'decimals' => 2, 'maxUnits' => '2000000', 'initialUnits' => '1000000', 'treasuryKey' => $treasury['key'],
        'mode' => 'single', 'visibility' => 'public', 'roster' => [['domain' => 's.example', 'key' => peer_public(['private' => $priv])]], 'createdAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW - 3600)]);
    ledger_register($db, $genesis, $treasury['key'], null);
    ledger_add_genesis_signature($db, $genesis['coinId'], 's.example', ledger_genesis_sign($genesis, $priv));
    ledger_activate($db, $genesis['coinId'], $priv);
    return ['db' => $db, 'file' => $file, 'coin' => $genesis['coinId'], 'priv' => $priv, 'treasury' => $treasury];
}
// Changes one character inside the last complete line, so its sum no longer holds. The file still ends with a newline.
function damage_last_line(string $file): void
{
    $text = (string) file_get_contents($file);
    $lines = explode("\n", rtrim($text, "\n"));
    $last = array_pop($lines);
    $lines[] = preg_replace('/"at":(\d)/', '"at":9$1', $last, 1);
    file_put_contents($file, implode("\n", $lines) . "\n");
}
$rid1 = bin2hex(random_bytes(16));
$rid2 = bin2hex(random_bytes(16));

echo "== what keeps working: a write cut short\n";
$w = single_coin();
$closed = $w['file'] . '.checkpoints/' . $w['coin'] . '.closed';
ledger_close_sale($w['db'], $w['coin'], $rid1, $NOW);
file_put_contents($closed, '{"v":1,"coinId":"' . $w['coin'] . '","kind":"clo', FILE_APPEND);
t(ledger_sale_closed($w['db'], $w['coin'], $rid1) && guard_closed_ids($w['db'], $w['coin']) === [$rid1 => true], 'a record cut short after a good one leaves the good one read');
ledger_close_sale($w['db'], $w['coin'], $rid2, $NOW);
t(array_keys(guard_closed_ids($w['db'], $w['coin'])) === [$rid1, $rid2], 'the next closure starts on a new line and both are read');

echo "\n== a closed sale, the last complete record damaged, the database put back from before the closure\n";
$w = single_coin();
$closed = $w['file'] . '.checkpoints/' . $w['coin'] . '.closed';
$before = copy_of($w['db']);
ledger_close_sale($w['db'], $w['coin'], $rid1, $NOW);
t(ledger_sale_closed($w['db'], $w['coin'], $rid1), 'the sale is closed');
damage_last_line($closed);
put_file_back($w, $before);
t((int) $w['db']->query('SELECT COUNT(*) FROM ledger_closed_sales')->fetchColumn() === 0, 'the database has no closure row any more');
$verdict = why(fn() => ledger_sale_closed($w['db'], $w['coin'], $rid1) ? 'closed' : 'open');
t($verdict !== 'no error' && !str_starts_with($verdict, 'open'), 'the sale does not reopen: the damaged record is reported (a refusal) or still counted', $verdict);

echo "\n== the same with an earlier good record and the damaged one last\n";
$w = single_coin();
$closed = $w['file'] . '.checkpoints/' . $w['coin'] . '.closed';
ledger_close_sale($w['db'], $w['coin'], $rid1, $NOW);
$before = copy_of($w['db']);
ledger_close_sale($w['db'], $w['coin'], $rid2, $NOW);
damage_last_line($closed);
put_file_back($w, $before);
$verdict2 = why(fn() => ledger_sale_closed($w['db'], $w['coin'], $rid2) ? 'closed' : 'open');
t($verdict2 !== 'no error' && !str_starts_with($verdict2, 'open'), 'the second sale does not reopen either', $verdict2);

echo "\n== the middle of the file damaged is still reported\n";
$w = single_coin();
$closed = $w['file'] . '.checkpoints/' . $w['coin'] . '.closed';
ledger_close_sale($w['db'], $w['coin'], $rid1, $NOW);
ledger_close_sale($w['db'], $w['coin'], $rid2, $NOW);
$lines = explode("\n", rtrim((string) file_get_contents($closed), "\n"));
$lines[0] = preg_replace('/"at":(\d)/', '"at":9$1', $lines[0], 1);
file_put_contents($closed, implode("\n", $lines) . "\n");
t(str_contains(why(fn() => guard_closed_ids($w['db'], $w['coin'])), 'damaged'), 'a damaged record that a later record follows is refused (this already holds)');

echo "\n== a partner's last approval record damaged, its database put back from before the approval\n";
cluster(3);
$c = open_coin(3, 2);
open_now($c);
// Two different entries for the same index, prepared on the authority.
$treasury = $c['treasury'];
$first = ledger_prepare_transfer(ndb('a.example'), $c['coin'], ledger_grant_authorization(ndb('a.example'), $c['coin'], ['key' => $treasury['key'], 'private' => $treasury['priv']], owner()['key'], '100', max($NOW, ledger_head_time(ndb('a.example'), $c['coin']))), max($NOW, ledger_head_time(ndb('a.example'), $c['coin'])));
$second = ledger_prepare_transfer(ndb('a.example'), $c['coin'], ledger_grant_authorization(ndb('a.example'), $c['coin'], ['key' => $treasury['key'], 'private' => $treasury['priv']], owner()['key'], '200', max($NOW, ledger_head_time(ndb('a.example'), $c['coin']))), max($NOW, ledger_head_time(ndb('a.example'), $c['coin'])));
t($first['hash'] !== $second['hash'] && $first['public']['index'] === $second['public']['index'], 'two different entries are prepared for one index');
$ask = function (array $prepared) use ($c) {
    global $NOW;
    $env = peer_envelope(node('a.example'), 'b.example', 'approve', ['coinId' => $c['coin'], 'prepared' => ['public' => $prepared['public'], 'private' => $prepared['private'], 'hash' => $prepared['hash']]], $NOW);
    return peer_handle(ndb('b.example'), node('b.example'), json_decode(json_encode($env), true), $NOW, 'transport');
};
$bw = ['db' => ndb('b.example'), 'file' => $CLUSTER['b.example']['file']];
$bBefore = copy_of(ndb('b.example'));
$given = $ask($first);
t(($given['decision'] ?? null) === 'approve', 'b approves the first');
$bLog = $bw['file'] . '.checkpoints/' . $c['coin'] . '.log';
$tailLine = (function () use ($bLog) { $l = explode("\n", rtrim((string) file_get_contents($bLog), "\n")); return end($l); })();
t(str_contains($tailLine, '"kind":"approve"'), 'the approval is the last line of b\'s log', $tailLine);
// Control: with the line sound, the database put back, the second entry is refused.
$bSound = copy_of(ndb('b.example'));
$logSound = (string) file_get_contents($bLog);
put_file_back($bw, $bBefore);
$CLUSTER['b.example']['db'] = $bw['db'];
$control = why(fn() => $ask($second));
t(str_starts_with($control, 'equivocation'), 'control: with its log whole, b refuses a different entry for that index', $control);
// The same, with the last line damaged.
put_file_back($bw, $bBefore);
$CLUSTER['b.example']['db'] = $bw['db'];
file_put_contents($bLog, $logSound);
damage_last_line($bLog);
$verdict3 = why(fn() => $ask($second));
t($verdict3 !== 'no error' && !str_starts_with($verdict3, 'no error'), 'with the last approval record damaged, b does not sign a second entry for the index', $verdict3);
t(str_contains($verdict3, 'equivocation') || str_contains($verdict3, 'checkpoint'), 'it refuses with the equivocation or a checkpoint error', $verdict3);

echo "\n== the floor: the last commit line damaged, the database put back by one entry\n";
$w = single_coin();
$log = $w['file'] . '.checkpoints/' . $w['coin'] . '.log';
$alice = owner();
$g = ledger_grant($w['db'], $w['coin'], ['key' => $w['treasury']['key'], 'private' => $w['treasury']['priv']], $alice['key'], '1000', $NOW);
ledger_commit($w['db'], $w['coin'], $g, ledger_sign($w['priv'], $g['hash']), [], $NOW);
$one = copy_of($w['db']);
$g2 = ledger_grant($w['db'], $w['coin'], ['key' => $w['treasury']['key'], 'private' => $w['treasury']['priv']], $alice['key'], '50', $NOW);
ledger_commit($w['db'], $w['coin'], $g2, ledger_sign($w['priv'], $g2['hash']), [], $NOW);
$journal = $w['file'] . '.checkpoints/' . $w['coin'] . '.journal';
$logSound = (string) file_get_contents($log);
put_file_back($w, $one);
$sound = ledger_guard_check($w['db'], $w['coin'], false, $NOW);
t($sound['status'] === 'halted', 'control: the database one entry back is a rollback with the log whole', $sound);
file_put_contents($log, $logSound);
damage_last_line($log);
put_file_back($w, $one);
$shown = ledger_guard_check($w['db'], $w['coin'], false, $NOW);
t($shown['status'] === 'halted' || $shown['status'] === 'checkpoint-corrupt', 'with the last log line damaged the rollback is still seen (the journal still holds the entry, so this may hold)', $shown);
// The journal is damaged in its last record as well, as one storage fault could do to both files written together.
file_put_contents($log, $logSound);
damage_last_line($log);
damage_last_line($journal);
put_file_back($w, $one);
$both = ledger_guard_check($w['db'], $w['coin'], false, $NOW);
t($both['status'] === 'halted' || ($both['status'] ?? '') === 'checkpoint-corrupt', 'with the last record of both files damaged the rollback is still seen', $both);

echo "\n== interrupted writes\n";
$w = single_coin();
$closed = $w['file'] . '.checkpoints/' . $w['coin'] . '.closed';
ledger_close_sale($w['db'], $w['coin'], $rid1, $NOW);
ledger_close_sale($w['db'], $w['coin'], $rid2, $NOW);
$whole = (string) file_get_contents($closed);
// A whole record that only lacks its newline is a record.
file_put_contents($closed, rtrim($whole, "\n"));
t(array_keys(guard_closed_ids($w['db'], $w['coin'])) === [$rid1, $rid2], 'a last record that only lacks its newline is read');
$rid3 = bin2hex(random_bytes(16));
ledger_close_sale($w['db'], $w['coin'], $rid3, $NOW);
t(array_keys(guard_closed_ids($w['db'], $w['coin'])) === [$rid1, $rid2, $rid3], 'and the next record carries on from it without breaking the chain');
// Two cut writes in a row: the second begins on a new line after the first.
file_put_contents($closed, '{"v":1,"coinId":"' . $w['coin'] . '","kind":"clo', FILE_APPEND);
file_put_contents($closed, "\n" . '{"v":1,"coinId":"' . $w['coin'] . '","kind":"cl', FILE_APPEND);
t(count(guard_closed_ids($w['db'], $w['coin'])) === 3, 'a cut write followed by another cut write is read as what came before');
$rid4 = bin2hex(random_bytes(16));
ledger_close_sale($w['db'], $w['coin'], $rid4, $NOW);
t(count(guard_closed_ids($w['db'], $w['coin'])) === 4, 'and writing goes on');
// A cut write that a newline follows and nothing else cannot be told from a damaged last record, so it is damage.
$damagedTail = $closed . '.x';
copy($closed, $damagedTail);
file_put_contents($closed, '{"v":1,"coinId":"' . $w['coin'] . '","kind":"clo' . "\n", FILE_APPEND);
t(str_contains(why(fn() => guard_closed_ids($w['db'], $w['coin'])), 'damaged'), 'a record cut short that ends with a newline and has nothing after it is damage');
t(str_contains(why(fn() => ledger_sale_closed($w['db'], $w['coin'], bin2hex(random_bytes(16)))), 'checkpoint-unavailable') && refuses(fn() => ledger_close_sale($w['db'], $w['coin'], bin2hex(random_bytes(16)), $NOW), 'checkpoint-unavailable'), 'so nothing is closed or asked about the file until it is looked at, and no new record is added to it');
copy($damagedTail, $closed);
unlink($damagedTail);
t(count(guard_closed_ids($w['db'], $w['coin'])) === 4, 'the file as it was reads again');

echo "\n== writers and a reader at the same time\n";
$w = single_coin();
$closed = $w['file'] . '.checkpoints/' . $w['coin'] . '.closed';
@mkdir(dirname($closed), 0700, true);
$procs = [];
$pipes = [];
foreach (['a', 'b', 'c'] as $tag) $procs[$tag] = proc_open([PHP_BINARY, __DIR__ . '/support/closed-append-worker.php', $closed, $w['coin'], '60', $tag], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes[$tag]);
$reads = 0;
$problems = [];
do {
    $running = false;
    foreach ($procs as $proc) if (proc_get_status($proc)['running']) $running = true;
    try { guard_closed_ids($w['db'], $w['coin']); $reads++; } catch (RuntimeException $e) { $problems[] = $e->getMessage(); }
    $status = ledger_guard_dir($w['db']) !== null ? guard_read($closed) : null;
    if ($status !== null && $status['corrupt'] !== null) $problems[] = $status['corrupt'];
} while ($running);
foreach ($procs as $tag => $proc) { stream_get_contents($pipes[$tag][1]); stream_get_contents($pipes[$tag][2]); proc_close($proc); }
t($reads > 5 && $problems === [], 'a reader never reports damage while three writers append', ['reads' => $reads, 'problems' => array_slice($problems, 0, 3)]);
t(count(guard_closed_ids($w['db'], $w['coin'])) === 180, 'and every record the writers wrote is there once they are done', count(guard_closed_ids($w['db'], $w['coin'])));

echo "\n== an approval record that is not the last record is damaged\n";
cluster(3);
$c = open_coin(3, 2);
open_now($c);
$bLog = $CLUSTER['b.example']['file'] . '.checkpoints/' . $c['coin'] . '.log';
$first = ledger_prepare_transfer(ndb('a.example'), $c['coin'], ledger_grant_authorization(ndb('a.example'), $c['coin'], ['key' => $c['treasury']['key'], 'private' => $c['treasury']['priv']], owner()['key'], '100', max($NOW, ledger_head_time(ndb('a.example'), $c['coin']))), max($NOW, ledger_head_time(ndb('a.example'), $c['coin'])));
$envelope = peer_envelope(node('a.example'), 'b.example', 'approve', ['coinId' => $c['coin'], 'prepared' => ['public' => $first['public'], 'private' => $first['private'], 'hash' => $first['hash']]], $NOW);
peer_handle(ndb('b.example'), node('b.example'), json_decode(json_encode($envelope), true), $NOW, 'transport');
$kept = (string) file_get_contents($bLog);
$rows = explode("\n", rtrim($kept, "\n"));
$idx = null;
foreach ($rows as $i => $row) if (str_contains($row, '"kind":"approve"')) $idx = $i;
$rows[$idx] = preg_replace('/"at":(\d)/', '"at":9$1', $rows[$idx], 1);
file_put_contents($bLog, implode("\n", $rows) . "\n");
t(refuses(fn() => ledger_approval_memory(ndb('b.example'), $c['coin'], $first['public']['index']), 'checkpoint-unavailable'), 'a damaged approval record that other records follow is refused (the reader already caught this)');
file_put_contents($bLog, $kept);
t(isset(ledger_approval_memory(ndb('b.example'), $c['coin'], $first['public']['index'])[$first['hash']]), 'and the file as it was gives the approval back');

echo "\n== recovery: nothing sets a partner's approvals aside\n";
cluster(3);
$c = open_coin(3, 2);
open_now($c);
foreach (['b.example', 'a.example'] as $domain) {
    $log = $CLUSTER[$domain]['file'] . '.checkpoints/' . $c['coin'] . '.log';
    $text = (string) file_get_contents($log);
    $rows = explode("\n", rtrim($text, "\n"));
    $rows[0] = preg_replace('/"at":(\d)/', '"at":9$1', $rows[0], 1);
    file_put_contents($log, implode("\n", $rows) . "\n");
    $head = ledger_head(ndb($domain), $c['coin']);
    $confirm = ['databaseIndex' => $head['index'], 'databaseHash' => $head['hash']];
    if ($domain === 'b.example') {
        t(refuses(fn() => ledger_guard_reseal(ndb($domain), $c['coin'], $confirm, $NOW, $domain), 'approvals-unrecoverable') && is_file($log) && glob($log . '.damaged-*') === [], 'a partner of a coin of several domains cannot have its damaged log replaced: the file stays where it is');
        t(refuses(fn() => ledger_guard_reseal(ndb($domain), $c['coin'], $confirm, $NOW, null), 'approvals-unrecoverable'), 'nor when the caller does not say which domain it is');
        t(refuses(fn() => ledger_approval_memory(ndb($domain), $c['coin'], 1), 'checkpoint-unavailable'), 'and it approves nothing for that coin while the file is damaged');
    } else {
        $sealed = ledger_guard_reseal(ndb($domain), $c['coin'], $confirm, $NOW, $domain);
        t(isset($sealed['keptAs']) && is_file(dirname($log) . '/' . $sealed['keptAs']), 'the authority, which gives no approvals, can still begin a new file, and the old one is kept');
    }
}

echo "\n" . ($failures === 0 ? 'ALL ' . $total . ' CHAIN-LABS CHECKPOINT READER CHECKS PASSED' : $failures . ' of ' . $total . ' checks FAILED') . "\n";
exit($failures === 0 ? 0 : 1);
