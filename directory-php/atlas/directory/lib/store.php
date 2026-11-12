<?php
// The directory's storage: one SQLite database of its own (atlas-directory.sqlite), kept outside the web root and
// separate from every issuer and Chain Labs database. Three tables:
//   manifests     every submitted manifest URL and the state of its crawl
//   worlds        the discoverable worlds indexed from those manifests
//   submit_limits one row per accepted submission, keyed by a hash of the client, for the hourly limit
// Every statement is prepared. Every change runs in one BEGIN IMMEDIATE transaction, so two requests (or a request and the
// cron job) can never interleave half-written changes; a failure rolls the whole change back.

const DIRECTORY_SCHEMA_VERSION = 3;

// The folder that holds the database. It is the configured dataDir (DIRECTORY_DATA_DIR or lib/atlas-directory-config.json) or,
// failing that, an existing atlas-directory-private folder in the nearest parent folder of this code that has one; that is the
// folder beside public_html on a cPanel account. It must not be inside the web root: if the web server's document root
// contains it, the directory refuses to run rather than keep its database where it could be downloaded.
function dir_data_dir() {
  static $resolved = null;
  if ($resolved !== null) return $resolved;
  $dir = dir_config()['dataDir'];
  if ($dir === null) {
    for ($up = __DIR__; ; $up = dirname($up)) {
      if (is_dir($up . DIRECTORY_SEPARATOR . 'atlas-directory-private')) { $dir = $up . DIRECTORY_SEPARATOR . 'atlas-directory-private'; break; }
      if (dirname($up) === $up) break;
    }
    if ($dir === null) throw new DirectoryException('no data directory: create atlas-directory-private beside the web root, or set dataDir');
  }
  if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) throw new DirectoryException('the data directory could not be created');
  $real = realpath($dir);
  if ($real === false) throw new DirectoryException('the data directory could not be used');
  $root = isset($_SERVER['DOCUMENT_ROOT']) && $_SERVER['DOCUMENT_ROOT'] !== '' ? realpath($_SERVER['DOCUMENT_ROOT']) : false;
  if ($root !== false && ($real === $root || strpos($real . DIRECTORY_SEPARATOR, rtrim($root, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR) === 0)) {
    throw new DirectoryException('the data directory is inside the web root');
  }
  return $resolved = $real;
}

function dir_db() {
  static $db = null;
  if ($db !== null) return $db;
  if (!extension_loaded('pdo_sqlite')) throw new DirectoryException('this host has no pdo_sqlite extension');
  $path = dir_data_dir() . DIRECTORY_SEPARATOR . 'atlas-directory.sqlite';
  $db = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC, PDO::ATTR_EMULATE_PREPARES => false, PDO::ATTR_TIMEOUT => 5]);
  @chmod($path, 0600);
  $db->exec('PRAGMA busy_timeout=5000');
  $db->exec('PRAGMA foreign_keys=ON');
  if ((int) $db->query('PRAGMA user_version')->fetchColumn() < DIRECTORY_SCHEMA_VERSION) {
    dir_tx(function ($db) {
      $db->exec('CREATE TABLE IF NOT EXISTS manifests (
        url TEXT PRIMARY KEY,
        anchor_type TEXT,
        anchor_key TEXT,
        status TEXT NOT NULL,
        submitted_at INTEGER NOT NULL,
        last_crawled_at INTEGER,
        last_success_at INTEGER,
        next_crawl_at INTEGER NOT NULL,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        manifest_updated TEXT
      )');
      $db->exec('CREATE INDEX IF NOT EXISTS manifests_due ON manifests(next_crawl_at)');
      $db->exec('CREATE TABLE IF NOT EXISTS worlds (
        world_key TEXT PRIMARY KEY,
        manifest_url TEXT NOT NULL REFERENCES manifests(url) ON DELETE CASCADE,
        anchor_type TEXT NOT NULL,
        anchor_key TEXT NOT NULL,
        domain TEXT,
        identity_key TEXT,
        world_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        owner_name TEXT,
        genre TEXT,
        scale TEXT,
        guest_access TEXT,
        identity_required INTEGER NOT NULL,
        item_drops_allowed INTEGER NOT NULL,
        capabilities TEXT,
        accepted_item_classes TEXT NOT NULL,
        trusted_issuers TEXT,
        portals TEXT NOT NULL,
        indexed_at INTEGER NOT NULL
      )');
      $db->exec('CREATE INDEX IF NOT EXISTS worlds_manifest ON worlds(manifest_url)');
      $db->exec('CREATE INDEX IF NOT EXISTS worlds_anchor ON worlds(anchor_type, anchor_key)');
      // Version 3: what each site advertises besides its worlds (see dir_service_types()). A database from an older version
      // keeps every row and gets the empty table; its sites are due for a crawl at once so their services appear without
      // waiting out the crawl interval.
      $hadServices = (bool) $db->query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'services'")->fetchColumn();
      $db->exec('CREATE TABLE IF NOT EXISTS services (
        service_key TEXT PRIMARY KEY,
        manifest_url TEXT NOT NULL REFERENCES manifests(url) ON DELETE CASCADE,
        anchor_type TEXT NOT NULL,
        anchor_key TEXT NOT NULL,
        domain TEXT,
        identity_key TEXT,
        owner_name TEXT,
        service TEXT NOT NULL,
        url TEXT,
        indexed_at INTEGER NOT NULL
      )');
      $db->exec('CREATE INDEX IF NOT EXISTS services_manifest ON services(manifest_url)');
      $db->exec('CREATE INDEX IF NOT EXISTS services_anchor ON services(anchor_type, anchor_key)');
      if (!$hadServices) $db->prepare("UPDATE manifests SET next_crawl_at = ? WHERE status = 'ok' AND next_crawl_at > ?")->execute([time(), time()]);
      $db->exec('CREATE TABLE IF NOT EXISTS submit_limits (client TEXT NOT NULL, at INTEGER NOT NULL)');
      $db->exec('CREATE INDEX IF NOT EXISTS submit_limits_client ON submit_limits(client, at)');
      // Version 2: when the manifest was last fetched and validated successfully. A database from version 1 keeps all its rows;
      // one whose last crawl worked was last seen at that crawl, the others have no known time until their next good crawl.
      $columns = [];
      foreach ($db->query('PRAGMA table_info(manifests)')->fetchAll() as $column) $columns[] = $column['name'];
      if (!in_array('last_success_at', $columns, true)) {
        $db->exec('ALTER TABLE manifests ADD COLUMN last_success_at INTEGER');
        $db->exec('UPDATE manifests SET last_success_at = last_crawled_at WHERE status = \'ok\' AND last_crawled_at IS NOT NULL');
      }
      $db->exec('PRAGMA user_version=' . DIRECTORY_SCHEMA_VERSION);
    }, $db);
  }
  return $db;
}

// Runs $fn($db) in one write transaction and returns what it returns. Any exception rolls everything back and is rethrown.
// (A raw BEGIN is invisible to PDO::inTransaction(), so the rollback is attempted and a "no transaction" error ignored.)
function dir_tx($fn, $db = null) {
  if ($db === null) $db = dir_db();
  $db->exec('BEGIN IMMEDIATE');
  try {
    $result = $fn($db);
    $db->exec('COMMIT');
    return $result;
  } catch (Throwable $e) {
    try { $db->exec('ROLLBACK'); } catch (Throwable $ignored) { /* nothing was open */ }
    throw $e;
  }
}

function dir_manifest_count() {
  return (int) dir_db()->query('SELECT COUNT(*) FROM manifests')->fetchColumn();
}

function dir_service_count() {
  return (int) dir_db()->query('SELECT COUNT(*) FROM services')->fetchColumn();
}

function dir_world_count() {
  return (int) dir_db()->query('SELECT COUNT(*) FROM worlds')->fetchColumn();
}

// The secret that turns a client address into the stored hash, so the table never holds an address (and the hash cannot be
// worked back to one by trying every IPv4 address). Created on first use, in the data directory, readable by this account only.
function dir_client_secret() {
  $file = dir_data_dir() . DIRECTORY_SEPARATOR . 'atlas-directory-secret';
  if (!is_file($file)) {
    $handle = @fopen($file, 'x');
    if ($handle) { fwrite($handle, bin2hex(random_bytes(32))); fclose($handle); @chmod($file, 0600); }
  }
  $secret = is_file($file) ? trim((string) file_get_contents($file)) : '';
  if ($secret === '') throw new DirectoryException('the directory could not read its client secret');
  return $secret;
}

// Submissions per client in the last hour. A refused attempt is not recorded.
function dir_submit_allowed($ip, $now = null) {
  $limit = dir_config()['submitsPerHour'];
  $now = $now === null ? time() : (int) $now;
  $client = hash_hmac('sha256', (string) $ip, dir_client_secret());
  return dir_tx(function ($db) use ($client, $limit, $now) {
    $db->prepare('DELETE FROM submit_limits WHERE at <= ?')->execute([$now - 3600]);
    $count = $db->prepare('SELECT COUNT(*) FROM submit_limits WHERE client = ?');
    $count->execute([$client]);
    if ((int) $count->fetchColumn() >= $limit) return false;
    $db->prepare('INSERT INTO submit_limits(client, at) VALUES(?, ?)')->execute([$client, $now]);
    return true;
  });
}
