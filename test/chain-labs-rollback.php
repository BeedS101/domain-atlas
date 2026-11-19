<?php
declare(strict_types=1);
// A ledger database restored from an older copy must not bring spent balances back unnoticed. What this covers:
//   - without a checkpoint an old copy restores spent funds and they can be spent again; with one the coin is stopped
//   - what is a crash and what is a rollback: an intent without a commit, a commit without its line, a line cut short
//   - another history at the same index, a damaged checkpoint file, a lost checkpoint folder (a limit), a private folder
//   - the ways back: replaying the journal, a newer copy put back, accepting the loss (the coin stays stopped)
//   - a coin of several domains: a rolled back authority, a rolled back partner, resuming after the entries are back
//
//   php test/chain-labs-rollback.php
require __DIR__ . '/support/multi-cluster.php';

$alice = owner();
$bob = owner();
$carol = owner();
$dave = owner();

// ---------- a single authority coin in its own database file ----------

function single(string $domain = 's.example'): array
{
    global $NOW;
    $file = tempnam(sys_get_temp_dir(), 'ledger-rollback-') . '.sqlite';
    $db = ledger_open($file);
    $priv = ec_private();
    $pub = openssl_pkey_get_details(openssl_pkey_get_private($priv))['key'];
    $treasury = owner();
    $genesis = ledger_genesis(['symbol' => 'RBK', 'name' => 'Rollback coin', 'decimals' => 2, 'maxUnits' => '2000000', 'initialUnits' => '1000000', 'treasuryKey' => $treasury['key'],
        'mode' => 'single', 'visibility' => 'public', 'roster' => [['domain' => $domain, 'key' => $pub]], 'createdAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW - 3600)]);
    ledger_register($db, $genesis, $treasury['key'], null);
    ledger_add_genesis_signature($db, $genesis['coinId'], $domain, ledger_genesis_sign($genesis, $priv));
    ledger_activate($db, $genesis['coinId'], $priv);
    return ['db' => $db, 'file' => $file, 'coin' => $genesis['coinId'], 'genesis' => $genesis, 'digest' => ledger_genesis_digest($genesis), 'priv' => $priv, 'treasury' => $treasury];
}
function cp_dir(array $w): string { return $w['file'] . '.checkpoints'; }
function cp_log(array $w): string { return cp_dir($w) . '/' . $w['coin'] . '.log'; }
function cp_journal(array $w): string { return cp_dir($w) . '/' . $w['coin'] . '.journal'; }
function seq_of(array $w, array $from): int
{
    $row = ledger_account_row($w['db'], $w['coin'], $from['key']);
    return $row ? (int) $row['seq'] : 0;
}
function bal(array $w, array $o): int
{
    $row = ledger_account_row($w['db'], $w['coin'], $o['key']);
    return $row ? (int) $row['units'] : 0;
}
function head_of(array $w): array { return ledger_head($w['db'], $w['coin']); }
function authz(array $w, array $from, string $to, string $amount): array
{
    global $NOW;
    $payload = ['type' => 'atlas.ledger.transfer', 'v' => 2, 'coinId' => $w['coin'], ...ledger_binding($w['db'], $w['coin']), 'from' => $from['key'], 'to' => $to, 'amount' => $amount, 'baseSeq' => seq_of($w, $from),
        'baseHead' => head_of($w)['hash'], 'nonce' => bin2hex(random_bytes(16)), 'issuedAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW - 10), 'expiresAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW + 300)];
    return ['payload' => $payload, 'signature' => ledger_owner_sign($from['priv'], $payload)];
}
function commit_prepared(array $w, array $prepared): array
{
    global $NOW;
    return ledger_commit($w['db'], $w['coin'], $prepared, ledger_sign($w['priv'], $prepared['hash']), [], $NOW);
}
function send(array $w, array $from, string $to, string $amount): array
{
    global $NOW;
    return commit_prepared($w, ledger_prepare_transfer($w['db'], $w['coin'], authz($w, $from, $to, $amount), $NOW));
}
function grant(array $w, string $to, string $amount): array
{
    global $NOW;
    return commit_prepared($w, ledger_grant($w['db'], $w['coin'], ['key' => $w['treasury']['key'], 'private' => $w['treasury']['priv']], $to, $amount, $NOW));
}
// A backup the safe way: a consistent copy of the live database, not a copy of the file.
function snapshot(array $w): string
{
    $dest = tempnam(sys_get_temp_dir(), 'ledger-backup-');
    unlink($dest);
    $w['db']->exec("VACUUM INTO '" . $dest . "'");
    return $dest;
}
// Puts a backup in the place of the database file, as an operator or a host would, and opens it again.
function restore(array &$w, string $backup): void
{
    $w['db'] = null;
    foreach (['', '-wal', '-shm'] as $suffix) @unlink($w['file'] . $suffix);
    copy($backup, $w['file']);
    $w['db'] = ledger_open($w['file']);
}
function reopen(array &$w): void
{
    $w['db'] = null;
    $w['db'] = ledger_open($w['file']);
}
function verdict(array $w): array { return ledger_guard_check($w['db'], $w['coin'], false); }
function log_kinds(array $w): array { return array_column(guard_read(cp_log($w))['lines'], 'kind'); }
function tamper_line(string $file, int $line, callable $change): void
{
    $lines = explode("\n", rtrim((string) file_get_contents($file), "\n"));
    $lines[$line] = $change($lines[$line]);
    file_put_contents($file, implode("\n", $lines) . "\n");
}

echo "== the problem: an old copy restores spent funds\n";
$u = single();
ledger_guard_attach($u['db'], null);
grant($u, $alice['key'], '1000');
$old = snapshot($u);
send($u, $alice, $bob['key'], '400');
send($u, $alice, $carol['key'], '600');
t(bal($u, $alice) === 0 && bal($u, $bob) === 400, 'alice spent everything she had');
restore($u, $old);
ledger_guard_attach($u['db'], null);
t(bal($u, $alice) === 1000 && bal($u, $bob) === 0, 'without a checkpoint the old copy brings alice\'s 1000 back and nothing says so');
t(send($u, $alice, $dave['key'], '1000')['index'] === 2 && bal($u, $dave) === 1000, 'and she spends it again: the recipients of her first two payments hold units that no longer exist in this ledger');

echo "\n== the same sequence with a checkpoint\n";
$w = single();
grant($w, $alice['key'], '1000');
t(log_kinds($w) === ['adopt', 'intent', 'commit'], 'opening adopts the head, and every commit leaves an intent and a commit line in a private folder', log_kinds($w));
$floor = guard_state(guard_read(cp_log($w))['lines'])['floor'];
t($floor !== null && $floor['index'] === 1 && $floor['hash'] === head_of($w)['hash'], 'the floor is the head the database holds', $floor);
t(verdict($w)['status'] === 'ok', 'the database holds the floor: ok');
$perm = fileperms(cp_log($w)) & 0777;
t((fileperms(cp_dir($w)) & 0777) === 0700 && $perm === 0600, 'the folder is private to the account (0700) and its files too (0600)', decoct($perm));
$backup = snapshot($w);
t(ledger_check(ledger_open($backup), $w['coin']) === [], 'a safe backup (VACUUM INTO) is a consistent copy that passes the checker');
$first = send($w, $alice, $bob['key'], '400');
$second = send($w, $alice, $carol['key'], '600');
$spentHead = head_of($w);
t($spentHead['index'] === 3 && bal($w, $alice) === 0, 'alice spent her 1000 in two entries, to bob and carol');
$journalLast = guard_journal_last(cp_journal($w));
t($journalLast !== null && $journalLast['index'] === 3 && $journalLast['hash'] === $spentHead['hash'], 'the journal holds every committed entry, the last one included');
restore($w, $backup);
t(head_of($w)['index'] === 1 && bal($w, $alice) === 1000, 'the old copy is back: alice holds 1000 again');
$v = verdict($w);
t($v['status'] === 'halted' && $v['reason'] === 'rollback' && $v['detail']['floorIndex'] === 3 && $v['detail']['databaseIndex'] === 1, 'the checkpoint says rollback, with both heads', $v);
t(refuses(fn() => send($w, $alice, $dave['key'], '1000'), 'rollback-detected'), 'alice\'s second spend is refused, and nothing was written');
t(bal($w, $dave) === 0 && head_of($w)['index'] === 1, 'dave holds nothing and the log did not move');
t(refuses(fn() => ledger_prepare_transfer($w['db'], $w['coin'], authz($w, $alice, $dave['key'], '1'), $NOW), 'rollback-detected'), 'a proposal is refused before it is built');
t(ledger_public_coin($w['db'], $w['coin'])['state'] === 'frozen', 'wallets and scanners are shown the coin as frozen, though the database says active');
t(ledger_coin($w['db'], $w['coin'])['state'] === 'active', 'the stop is the checkpoint\'s: the database row was not changed');
t(refuses(fn() => grant($w, $dave['key'], '5'), 'rollback-detected'), 'the treasury cannot grant either');

echo "\n== a restart does not forget\n";
reopen($w);
t(verdict($w)['status'] === 'halted' && refuses(fn() => send($w, $alice, $dave['key'], '1'), 'rollback-detected'), 'a new process still finds the coin stopped');
t(in_array('halt', log_kinds($w), true), 'the verdict is written down: the checkpoint holds a halt line');

echo "\n== the way back: replay what was lost\n";
$res = ledger_guard_replay($w['db'], $w['coin'], $NOW);
t($res['applied'] === 2 && $res['status'] === 'ok', 'the journal replays the two lost entries, each with every check', ['applied' => $res['applied'], 'status' => $res['status'], 'error' => $res['error'] ?? null]);
t(head_of($w) === $spentHead && bal($w, $alice) === 0 && bal($w, $bob) === 400 && bal($w, $carol) === 600, 'the head, the hashes and the balances are exactly what they were: nothing was resurrected');
t(ledger_check($w['db'], $w['coin']) === [], 'the checker passes on the restored log');
t(in_array('restored', log_kinds($w), true), 'the checkpoint records the restore');
t(send($w, $bob, $dave['key'], '100')['index'] === 4 && bal($w, $dave) === 100, 'the coin takes new entries again');

echo "\n== crashes are not rollbacks\n";
$c = single();
grant($c, $alice['key'], '1000');
// A crash after the intent was written and before the database committed: the database is where the floor is.
$head = head_of($c);
guard_append(cp_log($c), ['v' => 1, 'kind' => 'intent', 'coinId' => $c['coin'], 'index' => $head['index'] + 1, 'hash' => hash('sha256', 'never committed'), 'at' => $NOW]);
t(verdict($c)['status'] === 'ok', 'an intent the database never committed is no rollback');
t(send($c, $alice, $bob['key'], '10')['index'] === 2 && verdict($c)['status'] === 'ok', 'the next entry takes that index and carries on');
// A crash after the database committed and before the commit line.
$before = guard_state(guard_read(cp_log($c))['lines'])['floor'];
ledger_guard_attach($c['db'], null);
send($c, $alice, $bob['key'], '20');
ledger_guard_attach($c['db'], cp_dir($c));
$mid = verdict($c);
t($mid['status'] === 'ok' && ($mid['ahead'] ?? 0) === 1, 'a database one entry ahead of the floor is not a rollback', $mid);
$fixed = ledger_guard_check($c['db'], $c['coin'], true, $NOW);
$after = guard_state(guard_read(cp_log($c))['lines'])['floor'];
t($fixed['status'] === 'repaired' && $after['index'] === $before['index'] + 1 && $after['hash'] === head_of($c)['hash'], 'the next check finishes the commit line and moves the floor', $after);
t(guard_journal_last(cp_journal($c))['index'] === head_of($c)['index'], 'and the journal has the entry too');
// A write cut short.
file_put_contents(cp_log($c), '{"v":1,"coinId":"' . $c['coin'] . '","kind":"comm', FILE_APPEND);
$read = guard_read(cp_log($c));
t($read['corrupt'] === null && $read['junk'] === 1 && verdict($c)['status'] === 'ok', 'a line cut short is ignored, not mistaken for damage', $read['corrupt']);
t(send($c, $alice, $bob['key'], '30')['index'] === 4, 'the next write starts on a new line and carries on');
$read = guard_read(cp_log($c));
t($read['corrupt'] === null && guard_state($read['lines'])['floor']['index'] === 4, 'and the chain of sums is whole', $read['corrupt']);
file_put_contents(cp_log($c), "not json at all\n", FILE_APPEND);
t(verdict($c)['status'] === 'ok' && guard_read(cp_log($c))['corrupt'] === null, 'a garbage line at the end is ignored too');
t(send($c, $alice, $bob['key'], '5')['index'] === 5, 'and writing goes on');
// The same restart after each: a new process finds the same floor.
$floorNow = guard_state(guard_read(cp_log($c))['lines'])['floor'];
reopen($c);
t(guard_state(guard_read(cp_log($c))['lines'])['floor'] === $floorNow && verdict($c)['status'] === 'ok', 'a restart finds the floor where it was');

echo "\n== another history at the same index\n";
$f = single();
grant($f, $alice['key'], '1000');
$fb = snapshot($f);
send($f, $alice, $bob['key'], '300');
send($f, $alice, $carol['key'], '300');
restore($f, $fb);
ledger_guard_attach($f['db'], null);
send($f, $alice, $dave['key'], '300');
send($f, $alice, $dave['key'], '300');
ledger_guard_attach($f['db'], cp_dir($f));
t(head_of($f)['index'] === 3, 'the restored database was taken forward by different entries to the same length');
$vf = ledger_guard_check($f['db'], $f['coin'], true, $NOW);
t($vf['status'] === 'halted' && $vf['reason'] === 'conflict', 'same index, other hash: a conflict, not a crash', $vf);
t(refuses(fn() => send($f, $alice, $dave['key'], '1'), 'checkpoint-conflict'), 'the coin takes nothing new');
t(ledger_guard_replay($f['db'], $f['coin'], $NOW)['applied'] === 0, 'and nothing is replayed over another history');

echo "\n== a newer copy of the database put back\n";
$n = single();
grant($n, $alice['key'], '1000');
send($n, $alice, $bob['key'], '100');
$nb = snapshot($n);
send($n, $alice, $bob['key'], '100');
$nowHead = head_of($n);
restore($n, $nb);
t(verdict($n)['status'] === 'halted', 'an older copy stops the coin');
// The operator has a newer copy: the old one with the lost entries replayed into it elsewhere.
$copy = tempnam(sys_get_temp_dir(), 'ledger-newer-copy-') . '.sqlite';
copy($nb, $copy);
$cdb = ledger_open($copy);
ledger_guard_attach($cdb, null);
foreach (guard_journal_after(cp_journal($n), ledger_head($cdb, $n['coin'])['index']) as $record) ledger_mirror_apply($cdb, $n['coin'], $record);
$cdb = null;
restore($n, $copy);
$vn = verdict($n);
t($vn['status'] === 'ok' && head_of($n) === $nowHead, 'a database that holds the floor again ends the stop by itself', $vn);
t(send($n, $alice, $carol['key'], '10')['index'] === $nowHead['index'] + 1, 'and the coin takes entries again');
function guard_journal_after(string $file, int $after): array
{
    $out = [];
    guard_each($file, function (array $line) use (&$out, $after) { if (($line['kind'] ?? null) === 'entry' && $line['index'] > $after) $out[] = $line['record']; return true; });
    return $out;
}

echo "\n== a database ahead of an older checkpoint folder\n";
$a = single();
grant($a, $alice['key'], '1000');
$dirCopy = sys_get_temp_dir() . '/cp-old-' . bin2hex(random_bytes(4));
mkdir($dirCopy);
foreach (glob(cp_dir($a) . '/*') as $f1) copy($f1, $dirCopy . '/' . basename($f1));
send($a, $alice, $bob['key'], '100');
send($a, $alice, $bob['key'], '100');
foreach (glob(cp_dir($a) . '/*') as $f1) unlink($f1);
foreach (glob($dirCopy . '/*') as $f1) copy($f1, cp_dir($a) . '/' . basename($f1));
$vo = verdict($a);
t($vo['status'] === 'ok' && $vo['ahead'] === 2, 'an older checkpoint folder under a newer database is harmless: the database is ahead', $vo);
t(ledger_guard_check($a['db'], $a['coin'], true, $NOW)['status'] === 'repaired' && guard_state(guard_read(cp_log($a))['lines'])['floor']['index'] === 3, 'and it catches up');

echo "\n== a damaged checkpoint file\n";
$d = single();
grant($d, $alice['key'], '1000');
send($d, $alice, $bob['key'], '10');
send($d, $alice, $bob['key'], '10');
$copyLog = file_get_contents(cp_log($d));
tamper_line(cp_log($d), 1, fn($l) => str_replace('"kind":"intent"', '"kind":"intenx"', $l));
$vd = ledger_guard_check($d['db'], $d['coin'], true, $NOW);
t($vd['status'] === 'halted' && $vd['reason'] === 'checkpoint-corrupt', 'a changed line breaks the chain and stops the coin', $vd);
t(refuses(fn() => send($d, $alice, $bob['key'], '1'), 'checkpoint-corrupt'), 'which is told apart from a rollback');
t(ledger_public_coin($d['db'], $d['coin'])['state'] === 'frozen', 'and shown as frozen');
file_put_contents(cp_log($d), $copyLog);
$lines = explode("\n", rtrim($copyLog, "\n"));
unset($lines[3]);
file_put_contents(cp_log($d), implode("\n", $lines) . "\n");
t(verdict($d)['status'] === 'halted' && verdict($d)['reason'] === 'checkpoint-corrupt', 'a line taken out of the middle does too');
t(refuses(fn() => ledger_guard_reseal($d['db'], $d['coin'], ['databaseIndex' => 0, 'databaseHash' => str_repeat('0', 64)], $NOW), 'confirm-mismatch'), 'a reseal that does not repeat the database head is refused');
$head = head_of($d);
$sealed = ledger_guard_reseal($d['db'], $d['coin'], ['databaseIndex' => $head['index'], 'databaseHash' => $head['hash']], $NOW);
t($sealed['index'] === 3 && is_file(cp_dir($d) . '/' . $sealed['keptAs']), 'a reseal sets the damaged file aside and begins a new one from the database, which passes the checker', $sealed);
t(verdict($d)['status'] === 'ok' && send($d, $alice, $bob['key'], '1')['index'] === 4, 'and the coin goes on');
t(refuses(fn() => ledger_guard_reseal($d['db'], $d['coin'], ['databaseIndex' => 4, 'databaseHash' => head_of($d)['hash']], $NOW), 'not-damaged'), 'a reseal of a sound file is refused');

echo "\n== a lost checkpoint folder: what is not caught here\n";
$l = single();
grant($l, $alice['key'], '1000');
$lb = snapshot($l);
send($l, $alice, $bob['key'], '1000');
foreach (glob(cp_dir($l) . '/*') as $f1) unlink($f1);
restore($l, $lb);
t(ledger_guard_check($l['db'], $l['coin'], true, $NOW)['status'] === 'adopted' && bal($l, $alice) === 1000, 'with the database and the checkpoint folder both restored, this domain cannot tell: it adopts the old head (a witness elsewhere must hold the newer one)');

echo "\n== accepting the loss\n";
$x = single();
grant($x, $alice['key'], '1000');
$xb = snapshot($x);
send($x, $alice, $bob['key'], '700');
send($x, $alice, $carol['key'], '300');
restore($x, $xb);
$vx = verdict($x);
t(refuses(fn() => ledger_guard_accept($x['db'], $x['coin'], ['floorIndex' => 3], 'lost', $NOW), 'confirm-mismatch'), 'accepting needs the exact heads repeated');
t(refuses(fn() => ledger_guard_accept($x['db'], $x['coin'], ['floorIndex' => $vx['detail']['floorIndex'], 'floorHash' => $vx['detail']['floorHash'], 'databaseIndex' => $vx['detail']['databaseIndex']], '  ', $NOW), 'reason-needed'), 'and a reason');
$acc = ledger_guard_accept($x['db'], $x['coin'], ['floorIndex' => $vx['detail']['floorIndex'], 'floorHash' => $vx['detail']['floorHash'], 'databaseIndex' => $vx['detail']['databaseIndex']], 'the host lost the last day', $NOW);
t($acc['lostCount'] === 2 && count($acc['lost']) === 2 && $acc['lost'][0]['index'] === 2, 'the acceptance lists the entries that are lost', $acc);
t(ledger_coin($x['db'], $x['coin'])['state'] === 'frozen' && ledger_evidence($x['db'], $x['coin'])[0]['kind'] === 'rollback-accepted', 'the coin is frozen in the database, with the lost entries as evidence');
t(refuses(fn() => send($x, $alice, $dave['key'], '1000'), 'not-active') && bal($x, $dave) === 0, 'alice\'s resurrected 1000 cannot be spent');
$again = ledger_guard_check($x['db'], $x['coin'], true, $NOW);
t($again['status'] === 'halted' && $again['accepted'] === true, 'the checkpoint keeps the coin stopped for good, even if the database row were changed back');
$x['db']->exec("UPDATE ledger_coins SET state='active' WHERE coin_id='" . $x['coin'] . "'");
t(refuses(fn() => send($x, $alice, $dave['key'], '1000'), 'rollback-detected'), 'it still takes nothing: the stop is the checkpoint\'s as well');
t(ledger_guard_replay($x['db'], $x['coin'], $NOW)['applied'] === 0, 'and the journal is no longer replayed after the loss was accepted');
t(refuses(fn() => ledger_guard_accept($w['db'], $w['coin'], [], 'x', $NOW), 'not-halted'), 'a coin that is not stopped for a rollback cannot have a loss accepted');

echo "\n== a private folder, and a folder that cannot be written\n";
$p = single();
grant($p, $alice['key'], '1000');
$_SERVER['DOCUMENT_ROOT'] = dirname(cp_dir($p));
$before = head_of($p);
t(refuses(fn() => send($p, $alice, $bob['key'], '1'), 'checkpoint-unavailable') && head_of($p) === $before, 'a checkpoint folder inside the web root is refused and nothing is committed');
unset($_SERVER['DOCUMENT_ROOT']);
t(send($p, $alice, $bob['key'], '1')['index'] === 2, 'the same folder outside it works');
$q = single();
grant($q, $alice['key'], '1000');
$beforeQ = head_of($q);
foreach (glob(cp_dir($q) . '/*') as $f1) unlink($f1);
rmdir(cp_dir($q));
file_put_contents(cp_dir($q), 'a file where the folder should be');
t(refuses(fn() => send($q, $alice, $bob['key'], '1'), 'checkpoint-unavailable') && head_of($q) === $beforeQ && bal($q, $bob) === 0, 'when the intent cannot be written nothing commits: the coin fails closed');
unlink(cp_dir($q));
t(send($q, $alice, $bob['key'], '1')['index'] === 2, 'and goes on when the folder is back');

echo "\n== the scan lists every checkpointed coin, including one the database lost\n";
$s = single();
grant($s, $alice['key'], '10');
$sb = snapshot($s);
$s2coin = $s['coin'];
$empty = tempnam(sys_get_temp_dir(), 'ledger-empty-') . '.sqlite';
$edb = ledger_open($empty);
t(ledger_guard_scan($edb) === [], 'a database with no checkpoint folder lists nothing');
$edb = null;
@mkdir($empty . '.checkpoints', 0700);
copy(cp_log($s), $empty . '.checkpoints/' . $s2coin . '.log');
$edb = ledger_open($empty);
$scan = ledger_guard_scan($edb);
t(isset($scan[$s2coin]) && $scan[$s2coin]['status'] === 'halted' && $scan[$s2coin]['reason'] === 'rollback' && ($scan[$s2coin]['detail']['coinMissing'] ?? false), 'a database restored from before a coin was opened is reported for that coin', $scan);

echo "\n== a coin of three domains\n";
cluster(3);
$m = open_coin(3, 2);
open_now($m);
$keys = ['a.example', 'b.example', 'c.example'];
$ma = owner();
$mb = owner();
$mc = owner();
$treas = ['key' => $m['treasury']['key'], 'private' => $m['treasury']['priv']];
function mgrant(array $m, string $to, string $amount): void
{
    global $NOW;
    $a = ledger_grant_authorization(ndb('a.example'), $m['coin'], ['key' => $m['treasury']['key'], 'private' => $m['treasury']['priv']], $to, $amount, $NOW);
    peer_submit_and_execute(ndb('a.example'), node('a.example'), $m['coin'], $a, 'transport', $NOW);
}
mgrant($m, $ma['key'], '1000');
t(level($m, $keys) && clean($m, $keys), 'three domains hold the same two entries');
foreach ($keys as $d) t(guard_state(guard_read(cp_dir_of($d, $m) . '/' . $m['coin'] . '.log')['lines'])['floor']['index'] === 1, $d . ' keeps its own checkpoint at the head');
function cp_dir_of(string $d, array $m): string { global $CLUSTER; return $CLUSTER[$d]['file'] . '.checkpoints'; }
function backup_of(string $d): string
{
    global $CLUSTER;
    $dest = tempnam(sys_get_temp_dir(), 'cluster-backup-');
    unlink($dest);
    $CLUSTER[$d]['db']->exec("VACUUM INTO '" . $dest . "'");
    return $dest;
}
function restore_node(string $d, string $backup): void
{
    global $CLUSTER;
    $file = $CLUSTER[$d]['file'];
    $CLUSTER[$d]['db'] = null;
    foreach (['', '-wal', '-shm'] as $suffix) @unlink($file . $suffix);
    copy($backup, $file);
    $CLUSTER[$d]['db'] = ledger_open($file);
}
$ab = backup_of('a.example');
pay($m, $ma, $mb['key'], '400');
pay($m, $ma, $mc['key'], '600');
t(level($m, $keys) && units('a.example', $m, $ma['key']) === 0, 'alice spent her 1000 across two entries on all three domains');
$lost = heads($m, ['b.example'])['b.example'];

echo "\n   - the authority is rolled back\n";
restore_node('a.example', $ab);
t(units('a.example', $m, $ma['key']) === 1000, 'the authority\'s database has alice\'s 1000 again');
t(refuses(fn() => pay($m, $ma, $mb['key'], '1000'), 'rollback-detected'), 'its checkpoint stops a new entry before any partner is asked');
t(units('b.example', $m, $mb['key']) === 400 && units('c.example', $m, $mc['key']) === 600, 'the partners still hold what was spent');
$va = ledger_guard_check(ndb('a.example'), $m['coin'], false);
t($va['status'] === 'halted' && $va['reason'] === 'rollback', 'the authority reports a rollback', $va);
$rest = peer_restore_from_partners(ndb('a.example'), node('a.example'), $m['coin'], 'transport', $NOW);
t($rest['applied'] === 2 && $rest['verdict']['status'] === 'ok', 'the authority takes the lost entries back from its partners, each one checked', $rest);
t(level($m, $keys) && same_log($m, $keys) && clean($m, $keys) && heads($m, ['a.example'])['a.example'] === $lost, 'all three hold the same log again and nothing was resurrected');
pay($m, $mb, $mc['key'], '100');
t(level($m, $keys) && units('a.example', $m, $ma['key']) === 0, 'and the coin takes entries again');

echo "\n   - a partner is rolled back\n";
$bb = backup_of('b.example');
pay($m, $mb, $ma['key'], '50');
pay($m, $mc, $ma['key'], '50');
restore_node('b.example', $bb);
$vb = ledger_guard_check(ndb('b.example'), $m['coin'], false);
t($vb['status'] === 'halted' && $vb['reason'] === 'rollback', 'a partner restored from an older copy is stopped by its own checkpoint', $vb);
t(refuses(fn() => ledger_validate_prepared(ndb('b.example'), $m['coin'], ['public' => [], 'private' => []], $NOW), 'rollback-detected'), 'and approves nothing');
pay($m, $ma, $mc['key'], '10');
t(level($m, $keys) && clean($m, $keys), 'the authority\'s next entry makes the partner pull the lost ones (history is let in) and it is level again');
t(ledger_guard_check(ndb('b.example'), $m['coin'], false)['status'] === 'ok', 'which ends its stop by itself');

echo "\n   - partners freeze on a rolled back authority, and resume once it is restored\n";
$ab2 = backup_of('a.example');
pay($m, $ma, $mb['key'], '20');
restore_node('a.example', $ab2);
$NOW += 3;
$cmp = peer_compare_heads(ndb('b.example'), node('b.example'), $m['coin'], 'transport', $NOW);
t($cmp['state'] === 'frozen' && ($cmp['results']['a.example'] ?? '') === 'rollback', 'a partner that compares heads finds the authority behind and freezes the coin', $cmp);
t(refuses(fn() => peer_resume_after_rollback(ndb('b.example'), node('b.example'), $m['coin'], 'transport', $NOW), 'not-resumable'), 'it does not resume while the authority is still behind');
$restFrozen = peer_restore_from_partners(ndb('a.example'), node('a.example'), $m['coin'], 'transport', $NOW);
t($restFrozen['applied'] === 1 && $restFrozen['verdict']['status'] === 'ok', 'the authority is restored even though it froze too: replayed history is let into a coin frozen for a rollback', $restFrozen);
$NOW -= 3;
$resumed = peer_resume_after_rollback(ndb('b.example'), node('b.example'), $m['coin'], 'transport', $NOW);
t($resumed['state'] === 'active' && $resumed['agree'] === true, 'the partner resumes when every domain states the same history', $resumed);
$resumedA = peer_resume_after_rollback(ndb('a.example'), node('a.example'), $m['coin'], 'transport', $NOW);
$resumedC = peer_resume_after_rollback(ndb('c.example'), node('c.example'), $m['coin'], 'transport', $NOW);
pay($m, $mb, $ma['key'], '5');
t($resumedA['state'] === 'active' && $resumedC['state'] === 'active' && level($m, $keys) && clean($m, $keys), 'as do the others, and the coin takes entries');
t(refuses(fn() => peer_resume_after_rollback(ndb('a.example'), node('a.example'), $m['coin'], 'transport', $NOW), 'not-frozen'), 'a coin that is not frozen is not resumed');
$ndb = ndb('c.example');
ledger_freeze($ndb, $m['coin'], 'fork', ['x' => 1], $NOW);
t(refuses(fn() => peer_resume_after_rollback($ndb, node('c.example'), $m['coin'], 'transport', $NOW), 'not-resumable'), 'a freeze for a fork is never resumed this way');

echo "\n";
echo $failures === 0 ? "ALL $total CHAIN-LABS ROLLBACK CHECKS PASSED\n" : "$failures of $total FAILED\n";
exit($failures === 0 ? 0 : 1);
