<?php
// The PHP issuer's mail store (issuer-php/lib/store.php): normal operations keep working, a file that cannot be read as
// a message list is never treated as empty or overwritten, a write that fails or is cut off leaves the stored file as
// it was, and concurrent requests neither lose messages nor ever read a partial file. Scratch copy of the library
// only; nothing here touches the repository's state or any server.
//
// Run: php test/mail-store-safety.php
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }

$root = dirname(__DIR__) . '/issuer-php';
$self = __FILE__;

// Child modes, run as separate processes: php mail-store-safety.php <mode> <scratch dir> [args]
if (isset($argv[1]) && in_array($argv[1], ['append', 'append-many', 'read-loop', 'delete'], true)) {
  $work = $argv[2];
  putenv('ATLAS_DOMAIN=issuer.example');
  require "$work/lib/bootstrap.php";
  $mode = $argv[1];
  try {
    if ($mode === 'append') { append_mail(['id' => $argv[3], 'credentialId' => $argv[4], 'subject' => 's', 'body' => 'b']); exit(0); }
    if ($mode === 'append-many') {
      for ($i = 0; $i < (int) $argv[5]; $i++) append_mail(['id' => $argv[3] . '-' . $i, 'credentialId' => $argv[4], 'subject' => 's', 'body' => 'b']);
      exit(0);
    }
    if ($mode === 'delete') { echo delete_mailbox($argv[3]), "\n"; exit(0); }
    if ($mode === 'read-loop') {
      $end = microtime(true) + (float) $argv[3]; $reads = 0;
      while (microtime(true) < $end) { $n = count(read_mail()['messages']); $reads++; }
      echo $reads, "\n"; exit(0);
    }
  } catch (Throwable $e) {
    fwrite(STDERR, $e->getCode() . ' ' . $e->getMessage() . "\n");
    exit($e->getCode() === 503 ? 3 : 4);
  }
}

$work = sys_get_temp_dir() . '/atlas-mail-store-' . getmypid();
mkdir($work);
mkdir("$work/lib");
foreach (glob("$root/lib/*.php") as $f) copy($f, "$work/lib/" . basename($f));
putenv('ATLAS_DOMAIN=issuer.example');
ini_set('error_log', '/dev/null'); // the store logs each refusal; keep the test output readable
require "$work/lib/bootstrap.php";

$failures = 0; $passes = 0;
function check($name, $ok, $detail = null) {
  global $failures, $passes;
  if ($ok) { $passes++; echo "PASS $name\n"; }
  else { $failures++; echo "FAIL $name" . ($detail === null ? '' : ' :: ' . substr(json_encode($detail), 0, 300)) . "\n"; }
}
function msg($id, $cred) { return ['id' => $id, 'credentialId' => $cred, 'subject' => 'subject ' . $id, 'body' => 'body ' . $id, 'sentAt' => '2026-01-01T00:00:00Z']; }
function stored() { return @file_get_contents(atlas_mail_file()); }
function ids() { return array_map(function ($m) { return $m['id']; }, read_mail()['messages']); }
function refused($fn) { try { $fn(); return null; } catch (Exception $e) { return $e; } }
function temps() { return array_values(array_filter(scandir(dirname(atlas_mail_file())), function ($n) { return preg_match('/\.tmp$/', $n); })); }
function run_child($args, $env = [], $as = null) {
  global $self;
  $cmd = ($as ? 'runuser -u ' . escapeshellarg($as) . ' -- ' : '') . 'php ' . escapeshellarg($self) . ' ' . implode(' ', array_map('escapeshellarg', $args));
  $p = proc_open($cmd, [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, null, array_merge($_ENV, getenv(), $env));
  $out = stream_get_contents($pipes[1]); $err = stream_get_contents($pipes[2]);
  fclose($pipes[1]); fclose($pipes[2]);
  return ['code' => proc_close($p), 'out' => trim($out), 'err' => trim($err)];
}
function spawn_child($args) {
  global $self;
  $cmd = 'php ' . escapeshellarg($self) . ' ' . implode(' ', array_map('escapeshellarg', $args));
  $p = proc_open($cmd, [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
  return [$p, $pipes];
}
function finish_child($c) {
  $out = stream_get_contents($c[1][1]); $err = stream_get_contents($c[1][2]);
  fclose($c[1][1]); fclose($c[1][2]);
  return ['code' => proc_close($c[0]), 'out' => trim($out), 'err' => trim($err)];
}

echo "--- normal operation ---\n";
check('no file yet reads as an empty mailbox set', read_mail() === ['messages' => []]);
append_mail(msg('a1', 'cred-a'));
append_mail(msg('b1', 'cred-b'));
append_mail(msg('a2', 'cred-a'));
check('messages are stored in order', ids() === ['a1', 'b1', 'a2'], ids());
$text = stored();
check('stored as pretty JSON with a messages list (format unchanged)', json_decode($text, true)['messages'][0]['id'] === 'a1' && $text === json_encode(json_decode($text, true), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), substr($text, 0, 80));
check('a new file is private to the account', (fileperms(atlas_mail_file()) & 0777) === 0600, decoct(fileperms(atlas_mail_file()) & 0777));
check('no temporary file is left behind', temps() === [], temps());
append_mail_once(msg('a2', 'cred-a'));
append_mail_once(msg('a3', 'cred-a'));
check('append_mail_once adds a new id and skips a stored one', ids() === ['a1', 'b1', 'a2', 'a3'], ids());
check('deleting a message needs the right mailbox', delete_mail_messages(['b1'], ['cred-a']) === 0 && in_array('b1', ids(), true));
check('deleting a message in the right mailbox removes it', delete_mail_messages(['b1', 'nope'], ['cred-b']) === 1 && !in_array('b1', ids(), true));
check('delete_mailbox removes every message of one mailbox only', delete_mailbox('cred-a') === 3 && ids() === []);
check('delete_mailbox on an empty store removes nothing', delete_mailbox('cred-a') === 0);
for ($i = 0; $i < ATLAS_MAILBOX_CAP + 5; $i++) append_mail(msg('c' . $i, 'cred-c'));
append_mail(msg('d1', 'cred-d'));
check('a mailbox keeps its newest ' . ATLAS_MAILBOX_CAP . ' and other mailboxes are untouched', count(array_filter(ids(), function ($i) { return $i[0] === 'c'; })) === ATLAS_MAILBOX_CAP && in_array('d1', ids(), true) && !in_array('c0', ids(), true) && in_array('c204', ids(), true));
check('the stored file is still valid JSON after all of that', is_array(json_decode(stored(), true)));
file_put_contents(atlas_mail_file(), '');
check('a zero-length file (left by an older version) is an empty mailbox set', read_mail() === ['messages' => []]);
append_mail(msg('z1', 'cred-z'));
check('and the next message replaces it with a proper file', ids() === ['z1']);
file_put_contents(atlas_mail_file(), "{\"messages\": []}\n");
append_mail(msg('y1', 'cred-y'));
check('a file in the older compact layout is read and kept', ids() === ['y1']);

echo "--- a file that cannot be read as a message list ---\n";
$bad = [
  'garbage' => 'this is not json',
  'cut short' => substr(json_encode(['messages' => [msg('k1', 'cred-k'), msg('k2', 'cred-k')]], JSON_PRETTY_PRINT), 0, 70),
  'a number' => '42',
  'a string' => '"messages"',
  'messages is not a list' => '{"messages": "oops"}',
  'no messages key' => '{"other": [1,2,3]}',
];
foreach ($bad as $label => $content) {
  file_put_contents(atlas_mail_file(), $content);
  $before = stored();
  $r1 = refused(function () { read_mail(); });
  $r2 = refused(function () { append_mail(msg('new', 'cred-n')); });
  $r3 = refused(function () { append_mail_once(msg('new', 'cred-n')); });
  $r4 = refused(function () { delete_mail_messages(['k1'], ['cred-k']); });
  $r5 = refused(function () { delete_mailbox('cred-k'); });
  check("$label: read, append, append once and both deletes refuse with 503", $r1 && $r2 && $r3 && $r4 && $r5 && $r1->getCode() === 503 && $r2->getCode() === 503 && $r3->getCode() === 503 && $r4->getCode() === 503 && $r5->getCode() === 503);
  check("$label: the file is byte for byte what it was", stored() === $before);
  check("$label: no temporary file is left", temps() === [], temps());
  check("$label: the refusal does not echo file contents", !$r2 || strpos($r2->getMessage(), $content) === false);
}
file_put_contents(atlas_mail_file(), '{"messages": []}');
append_mail(msg('ok1', 'cred-ok'));
check('once the file is restored, mail works again', ids() === ['ok1']);

echo "--- a write that is cut off or fails ---\n";
file_put_contents(atlas_mail_file(), json_encode(['messages' => [msg('keep1', 'cred-k'), msg('keep2', 'cred-k')]], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
$before = stored();
$r = run_child(['append', $work, 'new1', 'cred-k'], ['ATLAS_TEST_CRASH_AT' => 'mail:tmp-written']);
check('a request stopped after writing the temporary file (before the rename) exits as a crash', $r['code'] === 86, $r);
check('the stored file is exactly as it was', stored() === $before);
check('the interrupted write left only a temporary file, which the stale-file cleanup knows', count(temps()) === 1 && preg_match('/^atlas-mail-store\.json\.[0-9a-f]{12}\.tmp$/', temps()[0]) === 1, temps());
foreach (temps() as $t) unlink(dirname(atlas_mail_file()) . '/' . $t);
$r = run_child(['append', $work, 'new1', 'cred-k']);
check('the next ordinary request succeeds', $r['code'] === 0 && ids() === ['keep1', 'keep2', 'new1'], $r);

$canRunAs = trim((string) @shell_exec('id -u nobody 2>/dev/null')) !== '' && function_exists('posix_geteuid') && posix_geteuid() === 0 && trim((string) @shell_exec('command -v runuser 2>/dev/null')) !== '';
if ($canRunAs) {
  // An unprivileged account in a folder it cannot write to: the real "disk or permissions" failure, not a simulation.
  $ro = sys_get_temp_dir() . '/atlas-mail-store-ro-' . getmypid();
  mkdir($ro); mkdir("$ro/lib");
  foreach (glob("$work/lib/*.php") as $f) copy($f, "$ro/lib/" . basename($f));
  file_put_contents("$ro/lib/atlas-mail-store.json", json_encode(['messages' => [msg('keep1', 'cred-k')]], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
  file_put_contents("$ro/lib/atlas-mail-store.lock", '');
  chmod("$ro/lib/atlas-mail-store.json", 0666); chmod("$ro/lib/atlas-mail-store.lock", 0666);
  chmod("$ro/lib", 0555); chmod($ro, 0755);
  $before = file_get_contents("$ro/lib/atlas-mail-store.json");
  $r = run_child(['append', $ro, 'x1', 'cred-k'], [], 'nobody');
  check('a folder that cannot take a new file: append refuses with 503', $r['code'] === 3 && strpos($r['err'], '503') === 0, $r);
  check('...and the stored file is unchanged (the old code would have rewritten it in place)', file_get_contents("$ro/lib/atlas-mail-store.json") === $before);
  $r = run_child(['delete', $ro, 'cred-k'], [], 'nobody');
  check('the same for deleting a mailbox', $r['code'] === 3 && file_get_contents("$ro/lib/atlas-mail-store.json") === $before, $r);
  chmod("$ro/lib", 0755);
} else {
  echo "SKIP unwritable-folder case: needs root with an unprivileged 'nobody' account and runuser\n";
}

echo "--- concurrent requests ---\n";
file_put_contents(atlas_mail_file(), '{"messages": []}');
$kids = [];
for ($i = 0; $i < 10; $i++) $kids[] = spawn_child(['append-many', $work, 'p' . $i, 'cred-' . ($i % 3), '12']);
$readers = [];
for ($i = 0; $i < 3; $i++) $readers[] = spawn_child(['read-loop', $work, '2.5']);
$codes = array_map('finish_child', $kids);
$reads = array_map('finish_child', $readers);
check('ten writers finished without error', count(array_filter($codes, function ($c) { return $c['code'] === 0; })) === 10, $codes);
check('every one of the 120 messages was stored exactly once', count(ids()) === 120 && count(array_unique(ids())) === 120, count(ids()));
check('readers running alongside never saw a partial or empty file', count(array_filter($reads, function ($c) { return $c['code'] === 0 && (int) $c['out'] > 0; })) === 3, $reads);
check('no temporary file is left after the concurrent run', temps() === [], temps());

$kids = [];
for ($i = 0; $i < 4; $i++) $kids[] = spawn_child(['append-many', $work, 'q' . $i, 'cred-keep', '10']);
$kids[] = spawn_child(['delete', $work, 'cred-0']);
$kids[] = spawn_child(['delete', $work, 'cred-1']);
$codes = array_map('finish_child', $kids);
$after = ids();
check('appends racing deletes of other mailboxes lose nothing', count(array_filter($codes, function ($c) { return $c['code'] === 0; })) === 6 && count(array_filter($after, function ($i) { return $i[0] === 'q'; })) === 40, array_map(function ($c) { return $c['code']; }, $codes));
check('the file is valid JSON at the end', is_array(json_decode(stored(), true)));

// cleanup
function rrmdir($d) { foreach (glob("$d/*") ?: [] as $f) is_dir($f) ? rrmdir($f) : @unlink($f); @rmdir($d); }
@chmod($work . '/lib', 0755);
rrmdir($work);
if (isset($ro)) { @chmod("$ro/lib", 0755); rrmdir($ro); }
echo $failures ? "\n$failures check(s) failed, $passes passed.\n" : "\nAll mail store safety checks passed ($passes).\n";
exit($failures ? 1 : 0);
