<?php
declare(strict_types=1);
// The read-only integrity checker for cron (chain-labs/lib/integrity-cli.php) against ledgers built here:
//   - every coin is checked and given one status; the run exits 0 when nothing is wrong, 1 on an integrity problem, 2 when it cannot run
//   - it finds a database put back to an older copy, a changed ledger, a damaged journal, a lost or damaged closed-sales file, a sale that is
//     closed and delivered, and a coin whose opening never finished
//   - it changes nothing: the database and every file beside it are byte for byte what they were, and nothing is repaired or halted
//   - it prints no path, key, secret or token, and a web request for it is refused
//
//   php test/chain-labs-integrity-cli.php
require __DIR__ . '/../chain-labs/lib/ledger.php';

$failures = 0;
$total = 0;
function t(bool $ok, string $text, mixed $detail = null): void
{
    global $failures, $total;
    $total++;
    if (!$ok) $failures++;
    echo ($ok ? 'PASS ' : 'FAIL ') . $text . (!$ok && $detail !== null ? ' :: ' . substr(is_string($detail) ? $detail : json_encode($detail), 0, 400) : '') . "\n";
}
$CLI = __DIR__ . '/../chain-labs/lib/integrity-cli.php';
$NOW = time();

function ec_pem(): string { $k = openssl_pkey_new(['curve_name' => 'prime256v1', 'private_key_type' => OPENSSL_KEYTYPE_EC]); openssl_pkey_export($k, $pem); return $pem; }
function rrm(string $dir): void
{
    foreach (is_dir($dir) ? scandir($dir) : [] as $f) {
        if ($f === '.' || $f === '..') continue;
        is_dir($dir . '/' . $f) ? rrm($dir . '/' . $f) : unlink($dir . '/' . $f);
    }
    if (is_dir($dir)) rmdir($dir);
}
// A private folder with a ledger of its own, as the endpoint keeps it, beside a web root.
function site(): array
{
    $work = sys_get_temp_dir() . '/integrity-' . bin2hex(random_bytes(6));
    mkdir($work . '/public', 0777, true);
    mkdir($work . '/chainblock-labs-private', 0700, true);
    $private = realpath($work . '/chainblock-labs-private');
    $file = $private . '/chain34.sqlite';
    return ['work' => $work, 'private' => $private, 'file' => $file, 'db' => ledger_open($file), 'priv' => ec_pem()];
}
// A single authority coin that is open, with $grants entries after its genesis.
function coin(array &$s, string $symbol, string $visibility, int $grants): array
{
    global $NOW;
    $treasury = ledger_new_owner_key();
    $secret = $visibility === 'private' ? bin2hex(random_bytes(32)) : null;
    $domainPublic = openssl_pkey_get_details(openssl_pkey_get_private($s['priv']))['key'];
    $genesis = ledger_genesis(['symbol' => $symbol, 'name' => 'Coin ' . $symbol, 'decimals' => 2, 'maxUnits' => '1000000', 'initialUnits' => '100000', 'treasuryKey' => $treasury['key'], 'mode' => 'single',
        'visibility' => $visibility, 'roster' => [['domain' => 'a.example', 'key' => $domainPublic]], 'createdAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW - 3600), 'refSecret' => $secret]);
    ledger_register($s['db'], $genesis, $treasury['key'], $secret);
    ledger_add_genesis_signature($s['db'], $genesis['coinId'], 'a.example', ledger_genesis_sign($genesis, $s['priv']));
    ledger_activate($s['db'], $genesis['coinId'], $s['priv']);
    $c = ['id' => $genesis['coinId'], 'treasury' => $treasury, 'secret' => $secret, 'genesis' => $genesis];
    for ($i = 0; $i < $grants; $i++) grant($s, $c);
    return $c;
}
function grant(array $s, array $c): void
{
    global $NOW;
    $prepared = ledger_grant($s['db'], $c['id'], $c['treasury'], ledger_new_owner_key()['key'], '10', $NOW);
    ledger_commit($s['db'], $c['id'], $prepared, ledger_sign($s['priv'], $prepared['hash']), [], $NOW);
}
function run(array $s, array $args = []): array
{
    global $CLI;
    $cmd = array_merge([PHP_BINARY, $CLI, '--private=' . $s['private']], $args);
    $p = proc_open($cmd, [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
    $out = stream_get_contents($pipes[1]);
    $err = stream_get_contents($pipes[2]);
    return ['code' => proc_close($p), 'out' => $out, 'err' => $err];
}
// Name, size, mtime and content hash of every file under the private folder.
function fingerprint(string $dir): array
{
    $all = [];
    foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS)) as $f) {
        $all[substr($f->getPathname(), strlen($dir))] = [$f->getSize(), $f->getMTime(), sha1_file($f->getPathname())];
    }
    ksort($all);
    return $all;
}
function backup(array $s): string
{
    $dest = tempnam(sys_get_temp_dir(), 'integrity-backup-');
    unlink($dest);
    $s['db']->exec("VACUUM INTO '" . $dest . "'");
    return $dest;
}

echo "== a healthy ledger\n";
$s = site();
$a = coin($s, 'AAA', 'public', 3);
$b = coin($s, 'BBB', 'private', 1);
$pending = null;
$before = fingerprint($s['private']);
$r = run($s);
t($r['code'] === 0 && substr_count($r['out'], 'ok      ') === 2 && str_contains($r['out'], '2 coins, 2 ok, 0 warnings, 0 failed'), 'every coin is reported ok and the run exits 0', $r);
t(str_contains($r['out'], $a['id'] . ' AAA single active head=3') && str_contains($r['out'], $b['id'] . ' BBB single active head=1'), 'each coin line names its id, symbol, mode, state and head', $r['out']);
t(fingerprint($s['private']) === $before, 'nothing under the private folder changed: same files, sizes, times and contents');
$q = run($s, ['--quiet']);
t($q['code'] === 0 && $q['out'] === '' && $q['err'] === '', 'quiet prints nothing when every coin is ok', $q);
$j = run($s, ['--json']);
$doc = json_decode($j['out'], true);
t($j['code'] === 0 && is_array($doc) && $doc['summary']['coins'] === 2 && $doc['summary']['failures'] === 0 && $doc['coins'][0]['status'] === 'ok', 'json carries the same result', $j['out']);
$one = run($s, ['--coin=' . $a['id']]);
t($one['code'] === 0 && str_contains($one['out'], 'AAA') && !str_contains($one['out'], 'BBB'), 'one coin can be checked alone', $one['out']);

// Run from where it is deployed, with no options: the private folder is the one beside the web root, as the endpoint finds it.
mkdir($s['work'] . '/public/chain-labs/lib', 0777, true);
foreach (['integrity-cli.php', 'ledger.php', 'checkpoint.php', 'sigformat.php'] as $f) copy(__DIR__ . '/../chain-labs/lib/' . $f, $s['work'] . '/public/chain-labs/lib/' . $f);
$p = proc_open([PHP_BINARY, $s['work'] . '/public/chain-labs/lib/integrity-cli.php'], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
$deployed = stream_get_contents($pipes[1]) . stream_get_contents($pipes[2]);
$deployedCode = proc_close($p);
t($deployedCode === 0 && str_contains($deployed, '2 coins, 2 ok'), 'run from the web root\'s chain-labs/lib with no options it finds the private folder beside the web root', $deployed);

echo "\n== what it never prints\n";
$everything = $r['out'] . $r['err'] . $j['out'] . $one['out'];
t(!str_contains($everything, $s['private']) && !str_contains($everything, $s['work']) && !str_contains($everything, sys_get_temp_dir() . '/integrity'), 'no path of this machine');
t(!str_contains($everything, $b['secret']) && !str_contains($everything, $b['treasury']['key']) && !str_contains($everything, $a['treasury']['key']) && !str_contains($everything, 'BEGIN') && !str_contains($everything, 'PRIVATE'), 'no reference secret, treasury key or PEM');

echo "\n== a database put back to an older copy\n";
$s2 = site();
$c = coin($s2, 'RBK', 'public', 2);
$other = coin($s2, 'OTH', 'public', 1);
$old = backup($s2);
grant($s2, $c); grant($s2, $c);
$s2['db'] = null;
foreach (['', '-wal', '-shm'] as $suffix) @unlink($s2['file'] . $suffix);
copy($old, $s2['file']);
$before = fingerprint($s2['private']);
$r = run($s2);
t($r['code'] === 1 && preg_match('/FAIL\s+' . $c['id'] . ' RBK/', $r['out']) && str_contains($r['out'], 'FAIL checkpoint-halted') && str_contains($r['out'], 'the checkpoint holds entry 4, the database 2'), 'the rolled back coin fails with what the checkpoint holds and the database holds', $r['out']);
t(preg_match('/ok\s+' . $other['id'] . ' OTH/', $r['out']) === 1 && str_contains($r['out'], '1 failed'), 'the other coin is still checked and reported ok', $r['out']);
t(fingerprint($s2['private']) === $before, 'it wrote no halt line and repaired nothing: the checkpoint folder and the database are as they were');
$again = run($s2);
$strip = fn(string $text) => preg_replace('/^chain labs integrity check \S+/', 'chain labs integrity check', $text);
t($again['code'] === 1 && $strip($again['out']) === $strip($r['out']), 'a second run says the same: it is not repairing, halting or accepting anything', [$again['out'], $r['out']]);

echo "\n== a changed ledger and a damaged journal\n";
$s3 = site();
$c3 = coin($s3, 'INV', 'public', 3);
$s3['db']->exec("UPDATE ledger_log SET authority_sig='AAAA' WHERE coin_id='" . $c3['id'] . "' AND idx=2");
$r = run($s3);
t($r['code'] === 1 && str_contains($r['out'], 'FAIL invariant: entry 2: authority signature does not verify'), 'a changed entry is found by the ledger check', $r['out']);
$s4 = site();
$c4 = coin($s4, 'JNL', 'public', 3);
$journal = $s4['file'] . '.checkpoints/' . $c4['id'] . '.journal';
$lines = explode("\n", rtrim((string) file_get_contents($journal), "\n"));
$lines[1] = substr($lines[1], 0, 20) . 'x' . substr($lines[1], 21);
file_put_contents($journal, implode("\n", $lines) . "\n");
$r = run($s4);
t($r['code'] === 1 && str_contains($r['out'], 'FAIL journal-damaged'), 'a damaged journal is found', $r['out']);

echo "\n== permanent sale closures\n";
$s5 = site();
$c5 = coin($s5, 'CLS', 'public', 1);
$rid = bin2hex(random_bytes(16));
ledger_close_sale($s5['db'], $c5['id'], $rid, $NOW);
$r = run($s5);
t($r['code'] === 0 && str_contains($r['out'], '1 ok'), 'a closed sale in the database and the file is ok', $r['out']);
$rid2 = bin2hex(random_bytes(16));
ledger_close_sale($s5['db'], $c5['id'], $rid2, $NOW);
$closedFile = $s5['file'] . '.checkpoints/' . $c5['id'] . '.closed';
$kept = file_get_contents($closedFile);
unlink($closedFile);
$r = run($s5);
t($r['code'] === 1 && str_contains($r['out'], 'FAIL closed-file-missing: 2 sale(s) are closed in the database but not in the closed-sales file'), 'a lost closed-sales file is found: a restored database could reopen the sale', $r['out']);
file_put_contents($closedFile, preg_replace('/"kind":"close"/', '"kind":"cloze"', $kept, 1));
$r = run($s5);
t($r['code'] === 1 && str_contains($r['out'], 'FAIL closed-file-damaged'), 'a closed-sales file that was changed is found', $r['out']);
file_put_contents($closedFile, $kept);
$s5['db']->exec("DELETE FROM ledger_closed_sales WHERE coin_id='" . $c5['id'] . "' AND request_id='" . $rid2 . "'");
$r = run($s5);
t($r['code'] === 0 && str_contains($r['out'], 'warning closed-in-file-only: 1 sale(s)') && str_contains($r['out'], '1 warnings'), 'a closure only in the file (an older database) is a warning: the sale stays closed', $r['out']);
$r = run($s5, ['--strict']);
t($r['code'] === 1, 'strict makes the warning fail the run', $r['code']);
ledger_close_sale($s5['db'], $c5['id'], $rid2, $NOW);
$s5['db']->prepare('INSERT INTO ledger_requests(coin_id,request_id,idx,to_key,units,at) VALUES(?,?,?,?,?,?)')->execute([$c5['id'], $rid, 1, 'k', 10, $NOW]);
$r = run($s5);
t($r['code'] === 1 && str_contains($r['out'], 'FAIL closed-sale-delivered: 1 sale(s) are closed and also have an entry'), 'a sale that is closed and delivered is found', $r['out']);

echo "\n== a coin whose opening never finished, and an older database\n";
$s6 = site();
$ok6 = coin($s6, 'FIN', 'public', 1);
$treasury = ledger_new_owner_key();
$domainPublic = openssl_pkey_get_details(openssl_pkey_get_private($s6['priv']))['key'];
$genesis = ledger_genesis(['symbol' => 'PND', 'name' => 'Coin PND', 'decimals' => 2, 'maxUnits' => '1000000', 'initialUnits' => '1000', 'treasuryKey' => $treasury['key'], 'mode' => 'single', 'visibility' => 'public',
    'roster' => [['domain' => 'a.example', 'key' => $domainPublic]], 'createdAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW - 60)]);
ledger_register($s6['db'], $genesis, $treasury['key'], null);
$r = run($s6);
t($r['code'] === 0 && str_contains($r['out'], 'warning opening-unfinished') && str_contains($r['out'], '1 ok, 1 warnings, 0 failed'), 'a single authority coin that is still pending is a warning that says how to finish it', $r['out']);
$s6['db']->exec('DROP TABLE ledger_closed_sales');
$schemaBefore = $s6['db']->query("SELECT group_concat(name) FROM sqlite_master")->fetchColumn();
$before = fingerprint($s6['private']);
$r = run($s6);
t($r['code'] === 0 && fingerprint($s6['private']) === $before, 'a database from before the closure table existed is read without creating it', $r);

echo "\n== when it cannot run\n";
$bad = $s['work'] . '/does-not-exist-' . bin2hex(random_bytes(3));
$p = proc_open([PHP_BINARY, $CLI, '--private=' . $bad], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
$out = stream_get_contents($pipes[1]) . stream_get_contents($pipes[2]);
$code = proc_close($p);
t($code === 2 && str_contains($out, 'could not run') && !str_contains($out, $bad) && !str_contains($out, $s['work']), 'a private folder that is not there gives exit 2 and names no path', $out);
$copy = $s['work'] . '/public/lib-copy';
$inside = $copy . '/chainblock-labs-private';
mkdir($inside, 0777, true);
copy($s['file'], $inside . '/chain34.sqlite');
mkdir($copy . '/chain-labs/lib', 0777, true);
copy($CLI, $copy . '/chain-labs/lib/integrity-cli.php');
foreach (['ledger.php', 'checkpoint.php', 'sigformat.php'] as $f) copy(__DIR__ . '/../chain-labs/lib/' . $f, $copy . '/chain-labs/lib/' . $f);
$p = proc_open([PHP_BINARY, $copy . '/chain-labs/lib/integrity-cli.php', '--private=' . $inside], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
$out = stream_get_contents($pipes[1]) . stream_get_contents($pipes[2]);
$code = proc_close($p);
t($code === 2 && str_contains($out, 'inside the web root'), 'a private folder inside the web root is refused', $out);
$u = run($s, ['--database=../../etc/passwd']);
t($u['code'] === 2 && str_contains($u['err'], 'database name'), 'a database name with a path is refused', $u);
$u = run($s, ['--bogus']);
t($u['code'] === 2, 'an unknown option is refused', $u);
$h = run($s, ['--help']);
t($h['code'] === 0 && str_contains($h['out'], 'Exit status'), 'help says what the exit codes mean', $h);

echo "\n== not served over the web\n";
$port = 39000 + random_int(0, 900);
$server = proc_open([PHP_BINARY, '-S', '127.0.0.1:' . $port, '-t', $copy], [1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']], $sp);
usleep(500000);
$ctx = stream_context_create(['http' => ['ignore_errors' => true, 'timeout' => 5]]);
$body = @file_get_contents('http://127.0.0.1:' . $port . '/chain-labs/lib/integrity-cli.php', false, $ctx);
$status = isset($http_response_header[0]) ? $http_response_header[0] : '';
proc_terminate($server);
t(str_contains($status, '404') && $body === '', 'a web request for it is a 404 with no body', [$status, $body]);

foreach ([$s, $s2, $s3, $s4, $s5, $s6] as $x) { $x['db'] = null; rrm($x['work']); }
echo "\n" . ($failures === 0 ? 'ALL ' . $total . ' CHAIN-LABS INTEGRITY CLI CHECKS PASSED' : $failures . ' of ' . $total . ' checks FAILED') . "\n";
exit($failures === 0 ? 0 : 1);
