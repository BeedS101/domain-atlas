<?php
// The PHP directory's SQLite storage (directory-php/atlas/directory/lib/store.php), tested directly:
//   - the schema is the three tables and nothing else, in a file of its own, with no JSON index files
//   - the database is kept outside the web root: a data directory inside the document root is refused, and a missing one is found
//     next to the web root the way a cPanel account lays it out
//   - every change is one transaction: a failure part way leaves nothing behind
//   - values are bound, never pasted into SQL: hostile names and search terms are stored and matched as plain text
//   - removing a manifest removes its worlds; the rate limit counts per hashed client, forgets after an hour, and holds when
//     many requests arrive at once (separate PHP processes sharing the one database file)
// Everything happens in a throw-away folder and one local server on 127.0.0.1; no real domain is contacted.
//
//   php test/verify-directory-storage.php
// With DIRECTORY_EXPECT_PHP=7.4 (or 8.1 ...) it also fails unless this is that PHP.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }

$repoLib = realpath(__DIR__ . '/../directory-php/atlas/directory/lib');
$mode = isset($argv[1]) ? $argv[1] : 'main';

// ---------- child processes: each one is a separate PHP using the same database file ----------
if ($mode !== 'main') {
  require_once (getenv('DIRECTORY_TEST_LIB') ?: $repoLib) . '/bootstrap.php';
  // What a web server would put there; read from the environment explicitly, as variables_order may leave it out of $_SERVER.
  if (getenv('TEST_DOCUMENT_ROOT')) $_SERVER['DOCUMENT_ROOT'] = getenv('TEST_DOCUMENT_ROOT');
  try {
    if ($mode === 'limit') { echo dir_submit_allowed($argv[2]) ? "1\n" : "0\n"; }
    elseif ($mode === 'register') { echo dir_register_manifest('https://' . $argv[2] . '.example/.well-known/spatial.json') ? "1\n" : "0\n"; }
    elseif ($mode === 'insert') {
      for ($i = 0; $i < (int) $argv[3]; $i++) {
        dir_tx(function ($db) use ($argv, $i) {
          $db->prepare("INSERT INTO manifests(url, status, submitted_at, next_crawl_at) VALUES(?, 'pending', ?, ?)")->execute(['https://' . $argv[2] . '-' . $i . '.example/.well-known/spatial.json', time(), time() + 60]);
        });
      }
      echo "done\n";
    }
    elseif ($mode === 'datadir') { echo dir_data_dir() . "\n"; }
    exit(0);
  } catch (Throwable $e) { echo 'ERROR: ' . $e->getMessage() . "\n"; exit(2); }
}

$failures = 0;
function check($label, $ok, $detail = null) {
  global $failures;
  if ($ok) { echo "PASS $label\n"; return; }
  $failures++;
  echo "FAIL $label" . ($detail !== null ? ' :: ' . substr(json_encode($detail), 0, 300) : '') . "\n";
}

$expect = getenv('DIRECTORY_EXPECT_PHP');
echo 'Directory under test: PHP ' . PHP_VERSION . ($expect ? " (expected $expect)" : '') . "\n";
if ($expect && !(PHP_VERSION === $expect || strpos(PHP_VERSION, $expect . '.') === 0)) { echo 'FAILURE: PHP version mismatch: this is ' . PHP_VERSION . ", expected $expect\n"; exit(1); }
if (!extension_loaded('pdo_sqlite')) { echo "FAILURE: the pdo_sqlite extension is not loaded\n"; exit(1); }

$base = sys_get_temp_dir() . '/directory-storage-' . getmypid();
$data = $base . '/data';
mkdir($base);
mkdir($data);
$script = escapeshellarg(PHP_BINARY) . ' ' . escapeshellarg(__FILE__);

function rrmdir($dir) {
  if (!is_dir($dir)) return;
  foreach (scandir($dir) as $f) { if ($f === '.' || $f === '..') continue; $p = $dir . '/' . $f; is_dir($p) && !is_link($p) ? rrmdir($p) : @unlink($p); }
  @rmdir($dir);
}
// Runs this script as a child with extra environment and returns [exit code, output].
function child(array $args, array $env) {
  global $script;
  $cmd = $script . ' ' . implode(' ', array_map('escapeshellarg', $args));
  $p = proc_open($cmd, [['pipe', 'r'], ['pipe', 'w'], ['pipe', 'w']], $pipes, null, array_merge(getenv(), $env));
  fclose($pipes[0]);
  $out = stream_get_contents($pipes[1]) . stream_get_contents($pipes[2]);
  fclose($pipes[1]); fclose($pipes[2]);
  return [proc_close($p), trim($out)];
}
function children_parallel(array $jobs) {
  global $script;
  $procs = [];
  foreach ($jobs as $i => $job) {
    $procs[$i] = proc_open($script . ' ' . implode(' ', array_map('escapeshellarg', $job['args'])), [['pipe', 'r'], ['pipe', 'w'], ['pipe', 'w']], $pipes, null, array_merge(getenv(), $job['env']));
    fclose($pipes[0]);
    $procs[$i] = [$procs[$i], $pipes];
  }
  $out = [];
  foreach ($procs as $i => $pair) {
    $out[$i] = trim(stream_get_contents($pair[1][1]) . stream_get_contents($pair[1][2]));
    fclose($pair[1][1]); fclose($pair[1][2]);
    $out[$i] = [proc_close($pair[0]), $out[$i]];
  }
  return $out;
}

// This process: five submissions an hour, the data directory outside any document root.
putenv('DIRECTORY_DATA_DIR=' . $data);
putenv('DIRECTORY_SUBMITS_PER_HOUR=5');
putenv('DIRECTORY_ALLOW_LOCAL=1');
putenv('DIRECTORY_CRAWL_INTERVAL_MS=3600000');
unset($_SERVER['DOCUMENT_ROOT']);
require_once $repoLib . '/bootstrap.php';

try {
  // ----- schema -----
  echo "--- one database of three tables, in a folder of its own ---\n";
  $db = dir_db();
  $tables = $db->query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")->fetchAll(PDO::FETCH_COLUMN);
  check('the tables are manifests, submit_limits and worlds, and nothing else', $tables === ['manifests', 'submit_limits', 'worlds'], $tables);
  check('foreign keys are enforced', (int) $db->query('PRAGMA foreign_keys')->fetchColumn() === 1);
  check('the schema version is recorded', (int) $db->query('PRAGMA user_version')->fetchColumn() === DIRECTORY_SCHEMA_VERSION);
  $file = $data . '/atlas-directory.sqlite';
  check('the database is a SQLite file in the data directory', is_file($file) && substr(file_get_contents($file, false, null, 0, 16), 0, 15) === 'SQLite format 3');
  if (DIRECTORY_SEPARATOR === '/') check('and only this account can read it', (fileperms($file) & 0077) === 0, decoct(fileperms($file) & 0777));
  check('no JSON index or rate-limit file is written', glob($data . '/*.json') === [] && glob($data . '/*.lock') === []);

  // ----- transactions -----
  echo "--- a failed change leaves nothing behind ---\n";
  try { dir_tx(function ($db) { $db->exec("INSERT INTO manifests(url, status, submitted_at, next_crawl_at) VALUES('https://rollback.example/x', 'pending', 1, 1)"); throw new RuntimeException('stop'); }); } catch (RuntimeException $e) { /* expected */ }
  check('an exception rolls the transaction back', dir_manifest_count() === 0);
  try {
    dir_tx(function ($db) {
      $db->exec("INSERT INTO manifests(url, status, submitted_at, next_crawl_at) VALUES('https://half.example/x', 'pending', 1, 1)");
      $db->exec("INSERT INTO worlds(world_key, manifest_url, anchor_type, anchor_key, world_id, name, identity_required, item_drops_allowed, accepted_item_classes, portals, indexed_at) VALUES('k', 'https://half.example/x', 'domain', 'half.example', 'w', NULL, 0, 0, '[]', '[]', 1)");
    });
  } catch (PDOException $e) { /* the missing name is refused */ }
  check('a statement that fails half way takes the earlier ones with it', dir_manifest_count() === 0);
  try { $db->exec("INSERT INTO worlds(world_key, manifest_url, anchor_type, anchor_key, world_id, name, identity_required, item_drops_allowed, accepted_item_classes, portals, indexed_at) VALUES('k', 'https://nobody.example/x', 'domain', 'nobody.example', 'w', 'n', 0, 0, '[]', '[]', 1)"); $orphan = true; } catch (PDOException $e) { $orphan = false; }
  check('a world cannot exist without its manifest', $orphan === false);
  check('the database still works after a rollback', dir_tx(function ($db) { return (int) $db->query('SELECT 1')->fetchColumn(); }) === 1);

  // ----- hostile text -----
  echo "--- hostile text is data, not SQL ---\n";
  $evil = "Robert'); DROP TABLE worlds;-- \"quoted\" \\ %_ ";
  $dir = $base . '/site';
  mkdir($dir);
  $sock = stream_socket_server('tcp://127.0.0.1:0');
  $port = (int) substr(strrchr(stream_socket_get_name($sock, false), ':'), 1);
  fclose($sock);
  $manifest = ['spec' => 'domain-atlas/1.0', 'domain' => '127.0.0.1:' . $port, 'owner' => ['name' => $evil],
    'worlds' => [['id' => 'one', 'name' => $evil, 'description' => $evil, 'entry' => ['scene' => '/s.json', 'renderer' => ['procedural-v1']],
      'policy' => ['guestAccess' => 'open', 'discoverable' => true, 'itemDropsAllowed' => false, 'trustedIssuers' => 'any'],
      'profile' => ['genre' => "x'; DELETE FROM manifests;--", 'scale' => 'room', 'capabilities' => ['combat' => 'none']],
      'portals' => [['kind' => 'domain', 'to' => 'linked.example']]]]];
  file_put_contents($dir . '/spatial.json', json_encode($manifest));
  file_put_contents($dir . '/router.php', '<?php header("Content-Type: application/json"); readfile(' . var_export($dir . '/spatial.json', true) . ');');
  $server = proc_open([PHP_BINARY, '-S', '127.0.0.1:' . $port, '-t', $dir, $dir . '/router.php'], [['pipe', 'r'], ['file', '/dev/null', 'w'], ['file', '/dev/null', 'w']], $serverPipes);
  for ($i = 0; $i < 50; $i++) { $c = @fsockopen('127.0.0.1', $port, $e1, $e2, 0.2); if ($c) { fclose($c); break; } usleep(100000); }
  $url = 'http://127.0.0.1:' . $port . '/.well-known/spatial.json';
  $result = dir_submit($url);
  check('a manifest full of quotes and SQL is accepted and indexed as it is', !empty($result['ok']) && $result['worldsIndexed'] === 1, $result);
  $stored = $db->query('SELECT name, description, owner_name, genre FROM worlds')->fetch();
  check('the text is stored exactly as written', $stored && $stored['name'] === dir_str($evil, 120) && $stored['genre'] === "x'; DELETE FROM manifests;--", $stored);
  check('and both tables are still there', dir_manifest_count() === 1 && dir_world_count() === 1);
  $found = dir_search(['q' => 'robert']);
  check('it is found by search', $found['count'] === 1 && $found['results'][0]['name'] === dir_str($evil, 120), $found['count']);
  $odd = 0;
  $terms = ["x' OR '1'='1", '" OR 1=1 --', "%' OR name LIKE '%", '1; DROP TABLE worlds'];
  foreach ($terms as $term) {
    foreach (['scale', 'domain', 'anchorType', 'genre', 'combat'] as $field) {
      if (dir_search([$field => $term])['count'] !== 0) $odd++;
    }
    dir_search(['q' => $term]); // words in it may match real words; what matters is that it runs
  }
  check('filter terms that look like SQL match nothing and break nothing', $odd === 0 && dir_world_count() === 1 && dir_manifest_count() === 1, $odd);
  check('a link counts for the site it points at', dir_search(['domain' => '127.0.0.1:' . $port])['results'][0]['inboundPortalCount'] === 0);

  // ----- cascade -----
  echo "--- removing a manifest removes its worlds ---\n";
  dir_drop_manifest($url);
  check('its worlds go with it', dir_manifest_count() === 0 && dir_world_count() === 0);
  check('an unreachable submission leaves nothing behind', dir_submit('http://127.0.0.1:1/.well-known/spatial.json')['ok'] === false && dir_manifest_count() === 0);

  // ----- rate limit -----
  echo "--- the rate limit ---\n";
  $now = 1000000;
  $first = [];
  for ($i = 0; $i < 7; $i++) $first[] = dir_submit_allowed('203.0.113.9', $now + $i);
  check('five submissions an hour are allowed and the rest refused', $first === [true, true, true, true, true, false, false], $first);
  check('a refused attempt is not counted', (int) $db->query('SELECT COUNT(*) FROM submit_limits')->fetchColumn() === 5);
  check('another client has its own allowance', dir_submit_allowed('203.0.113.10', $now + 10) === true);
  check('an hour later the first client may submit again', dir_submit_allowed('203.0.113.9', $now + 3700) === true);
  $rows = implode(' ', $db->query('SELECT client FROM submit_limits')->fetchAll(PDO::FETCH_COLUMN));
  check('the table holds hashes, not addresses', strpos($rows, '203.0.113') === false && preg_match('/^[0-9a-f]{64}( [0-9a-f]{64})*$/', $rows) === 1);
  $secret = $data . '/atlas-directory-secret';
  check('the key for those hashes is a separate file, readable by this account only', is_file($secret) && strlen(trim(file_get_contents($secret))) === 64 && (DIRECTORY_SEPARATOR !== '/' || (fileperms($secret) & 0077) === 0));

  // ----- many processes at once -----
  echo "--- many processes at once ---\n";
  $db->exec('DELETE FROM submit_limits');
  $jobs = [];
  for ($i = 0; $i < 12; $i++) $jobs[] = ['args' => ['limit', '198.51.100.7'], 'env' => ['DIRECTORY_DATA_DIR' => $data, 'DIRECTORY_SUBMITS_PER_HOUR' => '5']];
  $answers = children_parallel($jobs);
  $allowed = 0; $bad = 0;
  foreach ($answers as $a) { if ($a[0] !== 0) $bad++; elseif ($a[1] === '1') $allowed++; }
  check('twelve requests at once from one client get exactly five through', $bad === 0 && $allowed === 5, ['allowed' => $allowed, 'errors' => $bad, 'answers' => $answers]);
  $jobs = [];
  for ($i = 0; $i < 8; $i++) $jobs[] = ['args' => ['insert', 'p' . $i, '15'], 'env' => ['DIRECTORY_DATA_DIR' => $data]];
  $answers = children_parallel($jobs);
  $bad = 0;
  foreach ($answers as $a) if ($a[0] !== 0 || $a[1] !== 'done') $bad++;
  check('eight processes writing at once all succeed (no "database is locked") and nothing is lost', $bad === 0 && dir_manifest_count() === 120, ['failed' => $bad, 'rows' => dir_manifest_count(), 'sample' => $answers[0]]);

  $db->exec('DELETE FROM manifests');
  $jobs = [];
  for ($i = 0; $i < 14; $i++) $jobs[] = ['args' => ['register', 'site' . $i], 'env' => ['DIRECTORY_DATA_DIR' => $data, 'DIRECTORY_MAX_MANIFESTS' => '9']];
  $answers = children_parallel($jobs);
  $accepted = 0; $bad = 0;
  foreach ($answers as $a) { if ($a[0] !== 0) $bad++; elseif ($a[1] === '1') $accepted++; }
  check('fourteen submissions at once into a directory with room for nine: exactly nine are tracked', $bad === 0 && $accepted === 9 && dir_manifest_count() === 9, ['accepted' => $accepted, 'errors' => $bad, 'rows' => dir_manifest_count()]);

  // ----- where the database lives -----
  echo "--- outside the web root ---\n";
  $docroot = $base . '/acct/public_html';
  mkdir($base . '/acct', 0777, true);
  mkdir($docroot . '/atlas/directory', 0777, true);
  [$code, $out] = child(['datadir'], ['DIRECTORY_DATA_DIR' => $docroot . '/atlas/directory/data', 'TEST_DOCUMENT_ROOT' => $docroot]);
  check('a data directory inside the document root is refused', $code === 2 && strpos($out, 'inside the web root') !== false, $out);
  [$code, $out] = child(['datadir'], ['DIRECTORY_DATA_DIR' => $base . '/acct/private-data', 'TEST_DOCUMENT_ROOT' => $docroot]);
  check('one beside it is accepted (and created)', $code === 0 && $out === realpath($base . '/acct/private-data'), $out);
  // The code is copied to where it would sit on a cPanel account, with no data directory configured.
  $lib = $docroot . '/atlas/directory/lib';
  mkdir($lib);
  foreach (glob($repoLib . '/*.php') as $f) copy($f, $lib . '/' . basename($f));
  $env = ['DIRECTORY_TEST_LIB' => $lib, 'DIRECTORY_DATA_DIR' => '', 'TEST_DOCUMENT_ROOT' => $docroot];
  [$code, $out] = child(['datadir'], $env);
  check('with no data directory and no private folder it refuses to start', $code === 2 && strpos($out, 'no data directory') !== false, $out);
  mkdir($base . '/acct/atlas-directory-private');
  [$code, $out] = child(['datadir'], $env);
  check('it finds atlas-directory-private beside public_html', $code === 0 && $out === realpath($base . '/acct/atlas-directory-private'), $out);
  mkdir($docroot . '/atlas-directory-private');
  [$code, $out] = child(['datadir'], $env);
  check('a private folder that is inside the web root is refused, not used', $code === 2 && strpos($out, 'inside the web root') !== false, $out);
} finally {
  if (isset($server) && is_resource($server)) { proc_terminate($server); proc_close($server); }
  rrmdir($base);
}
echo $failures === 0 ? "\nALL DIRECTORY STORAGE CHECKS PASSED (php " . PHP_VERSION . ")\n" : "\n$failures DIRECTORY STORAGE CHECK(S) FAILED (php " . PHP_VERSION . ")\n";
exit($failures === 0 ? 0 : 1);
