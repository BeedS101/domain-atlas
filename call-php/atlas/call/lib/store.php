<?php
// Domain Atlas Call Service (PHP): file-based state.
//
// Shared PHP hosting gives each request its own process and no memory that outlives it, so
// everything the Node service keeps in memory lives in small JSON files here, and every
// request that reads or changes state does so while holding one exclusive lock (flock on
// state/lock). The lock is held for milliseconds, never while a signature is verified or
// another server is contacted, and a request that cannot get it within lockWaitMs is told
// to retry (503); it never proceeds without it.
//
//   lock                           the one lock file
//   meta.json                      counters and the time of the last sweep
//   tags/<xx>/<sha256>.json        a tag, by the hash of the tag hash
//   owners/<sha256>.json           the tags one wallet holds: {tag hash: expiry}
//   listeners/<sha256>.json        a wallet's listening mailbox
//   calls/<xx>/<sha256>.json       a call, with both mailboxes
//   calls/index.json               every call still remembered: {call id hash: [created, ended]}
//   nonces/<minute>/<xx>.dat       16-byte hashes of spent request nonces, one bucket per minute
//   rate/<xx>.json                 per-second counters for the rate limits
//
// Names are SHA-256 hex of the identifying string, so a name cannot collide with another on a
// case-insensitive file system and never contains a character from a requester. Tags are held
// only as hashes, as in the Node service. Files are written to a temporary name and renamed.

final class CallStore {
  private $dir;
  private $lockHandle = null;

  function __construct($dir) { $this->dir = rtrim($dir, '/\\'); }

  // ---------- setup and locking ----------

  // Creates the state directory tree. False when it cannot be created or written.
  function ensure() {
    $made = !is_dir($this->dir);
    if ($made && !@mkdir($this->dir, 0700, true) && !is_dir($this->dir)) return false;
    if (!is_writable($this->dir)) return false;
    if ($made || !is_file($this->dir . '/.htaccess')) {
      @file_put_contents($this->dir . '/.htaccess', "Require all denied\n<IfModule !mod_authz_core.c>\nOrder deny,allow\nDeny from all\n</IfModule>\n");
      @file_put_contents($this->dir . '/index.html', '');
    }
    foreach (['tags', 'owners', 'listeners', 'calls', 'nonces', 'rate', 'cache'] as $d) {
      if (!is_dir($this->dir . '/' . $d) && !@mkdir($this->dir . '/' . $d, 0700) && !is_dir($this->dir . '/' . $d)) return false;
    }
    return true;
  }
  function writable() { return is_dir($this->dir) ? is_writable($this->dir) : is_writable(dirname($this->dir)); }

  function lock($waitMs) {
    if ($this->lockHandle) return true;
    $existed = is_file($this->dir . '/lock');
    $h = @fopen($this->dir . '/lock', 'c');
    if (!$h) return false;
    if (!$existed) @chmod($this->dir . '/lock', 0600);
    $deadline = microtime(true) + $waitMs / 1000;
    $delay = 1000;
    while (true) {
      if (flock($h, LOCK_EX | LOCK_NB)) { $this->lockHandle = $h; return true; }
      if (microtime(true) >= $deadline) { fclose($h); return false; }
      usleep($delay);
      if ($delay < 20000) $delay *= 2;
    }
  }
  function unlock() {
    if (!$this->lockHandle) return;
    flock($this->lockHandle, LOCK_UN);
    fclose($this->lockHandle);
    $this->lockHandle = null;
  }

  // ---------- JSON files ----------

  static function key($s) { return hash('sha256', (string)$s); }
  private function path($kind, $key, $shard) {
    $name = self::key($key);
    return $this->dir . '/' . $kind . '/' . ($shard ? substr($name, 0, 2) . '/' : '') . $name . '.json';
  }
  private function readFile($file) {
    $text = @file_get_contents($file);
    if ($text === false || $text === '') return null;
    $doc = json_decode($text, true);
    return is_array($doc) ? $doc : null;
  }
  private function writeFile($file, $doc) {
    $dir = dirname($file);
    if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) throw new RuntimeException('state-unwritable');
    $tmp = $file . '.' . bin2hex(random_bytes(4)) . '.tmp';
    $text = json_encode($doc, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION);
    if ($text === false || @file_put_contents($tmp, $text) === false) { @unlink($tmp); throw new RuntimeException('state-unwritable'); }
    @chmod($tmp, 0600);
    if (!@rename($tmp, $file)) { @unlink($tmp); throw new RuntimeException('state-unwritable'); }
  }

  // A short plain-text log inside the state folder (web-denied), kept to the last 64 KB. Called
  // with the lock held; a failure to write it never affects a request.
  function appendLog($name, $line) {
    $file = $this->dir . '/' . $name;
    $old = is_file($file) ? @file_get_contents($file) : '';
    if (!is_string($old)) $old = '';
    $text = $old . $line . "\n";
    if (strlen($text) > 65536) {
      $text = substr($text, -32768);
      $cut = strpos($text, "\n");
      if ($cut !== false) $text = substr($text, $cut + 1);
    }
    if (@file_put_contents($file, $text) !== false) @chmod($file, 0600);
  }

  function get($kind, $key, $shard = true) {
    $file = $this->path($kind, $key, $shard);
    return $this->readFile($file);
  }
  function put($kind, $key, $doc, $shard = true) { $this->writeFile($this->path($kind, $key, $shard), $doc); }
  function remove($kind, $key, $shard = true) { @unlink($this->path($kind, $key, $shard)); }
  function exists($kind, $key, $shard = true) { return is_file($this->path($kind, $key, $shard)); }

  function meta() {
    $m = $this->readFile($this->dir . '/meta.json');
    return is_array($m) ? $m + ['listeners' => 0, 'tags' => 0, 'sweepAt' => 0, 'slowAt' => 0] : ['listeners' => 0, 'tags' => 0, 'sweepAt' => 0, 'slowAt' => 0];
  }
  function putMeta($m) { $this->writeFile($this->dir . '/meta.json', $m); }

  function callIndex() { $i = $this->readFile($this->dir . '/calls/index.json'); return is_array($i) ? $i : []; }
  function putCallIndex($i) { $this->writeFile($this->dir . '/calls/index.json', $i); }

  // Names of the files under a kind (a flat folder), without the extension.
  function listFlat($kind) {
    $out = [];
    $d = @scandir($this->dir . '/' . $kind);
    if ($d === false) return $out;
    foreach ($d as $f) if (substr($f, -5) === '.json') $out[] = substr($f, 0, -5);
    return $out;
  }
  function getFlat($kind, $name) {
    if (!preg_match('/^[0-9a-f]{64}\z/', $name)) return null;
    return $this->readFile($this->dir . '/' . $kind . '/' . $name . '.json');
  }
  function putFlat($kind, $name, $doc) {
    if (!preg_match('/^[0-9a-f]{64}\z/', $name)) return;
    $this->writeFile($this->dir . '/' . $kind . '/' . $name . '.json', $doc);
  }
  function fileTime($kind, $name) { $t = @filemtime($this->dir . '/' . $kind . '/' . $name . '.json'); return $t === false ? 0 : $t; }
  function removeByName($kind, $name) { if (preg_match('/^[0-9a-f]{64}\z/', $name)) @unlink($this->dir . '/' . $kind . '/' . $name . '.json'); }
  // Every shard folder of a kind (tags, calls): names of the two-hex-digit folders.
  function shards($kind) {
    $out = [];
    $d = @scandir($this->dir . '/' . $kind);
    if ($d === false) return $out;
    foreach ($d as $f) if (preg_match('/^[0-9a-f]{2}\z/', $f)) $out[] = $f;
    return $out;
  }
  function shardFiles($kind, $shard) {
    $out = [];
    $d = @scandir($this->dir . '/' . $kind . '/' . $shard);
    if ($d === false) return $out;
    foreach ($d as $f) if (substr($f, -5) === '.json') $out[] = substr($f, 0, -5);
    return $out;
  }
  function removeShardFile($kind, $shard, $name) {
    if (preg_match('/^[0-9a-f]{2}\z/', $shard) && preg_match('/^[0-9a-f]{64}\z/', $name)) @unlink($this->dir . '/' . $kind . '/' . $shard . '/' . $name . '.json');
  }
  function getShardFile($kind, $shard, $name) {
    if (!preg_match('/^[0-9a-f]{2}\z/', $shard) || !preg_match('/^[0-9a-f]{64}\z/', $name)) return null;
    return $this->readFile($this->dir . '/' . $kind . '/' . $shard . '/' . $name . '.json');
  }

  // ---------- request nonces ----------

  // Nonces are remembered by a 16-byte hash of signer and nonce, in a file per minute and per
  // first byte of the hash. A lookup opens at most one small file per minute still remembered.
  private function nonceParts($signer, $nonce) {
    $h = substr(hash('sha256', $signer . "\n" . $nonce), 0, 32);
    return [substr($h, 0, 2), substr($h, 2)];
  }
  function nonceSeen($signer, $nonce, $nowMs, $retainMs) {
    list($shard, $rest) = $this->nonceParts($signer, $nonce);
    $cur = intdiv($nowMs, 60000);
    for ($m = intdiv($nowMs - $retainMs, 60000); $m <= $cur; $m++) {
      $data = @file_get_contents($this->dir . '/nonces/' . $m . '/' . $shard . '.dat');
      if ($data === false || $data === '') continue;
      $at = 0;
      while (($pos = strpos($data, $rest, $at)) !== false) {
        if ($pos % 31 === 0) return true;
        $at = $pos + 1;
      }
    }
    return false;
  }
  // False when the bucket is full.
  function nonceAdd($signer, $nonce, $nowMs, $maxPerBucket) {
    list($shard, $rest) = $this->nonceParts($signer, $nonce);
    $dir = $this->dir . '/nonces/' . intdiv($nowMs, 60000);
    if (!is_dir($dir) && !@mkdir($dir, 0700) && !is_dir($dir)) throw new RuntimeException('state-unwritable');
    $file = $dir . '/' . $shard . '.dat';
    clearstatcache(true, $file);
    if ((int)@filesize($file) >= $maxPerBucket * 31) return false;
    $fresh = !is_file($file);
    if (@file_put_contents($file, $rest . "\n", FILE_APPEND) === false) throw new RuntimeException('state-unwritable');
    if ($fresh) @chmod($file, 0600);
    return true;
  }
  function purgeNonces($nowMs, $retainMs) {
    $oldest = intdiv($nowMs - $retainMs, 60000);
    $d = @scandir($this->dir . '/nonces');
    if ($d === false) return;
    foreach ($d as $m) {
      if (!ctype_digit($m) || (int)$m >= $oldest) continue;
      $sub = $this->dir . '/nonces/' . $m;
      foreach (@scandir($sub) ?: [] as $f) if ($f !== '.' && $f !== '..') @unlink($sub . '/' . $f);
      @rmdir($sub);
    }
  }

  // ---------- rate limits ----------

  // True when `$key` has already used `$limit` in the last 60 seconds; otherwise counts this
  // use and returns false. Counts are per second, so the window is exact to one second.
  function rateLimited($key, $limit, $nowMs) {
    $h = substr(hash('sha256', $key), 0, 18);
    $file = $this->dir . '/rate/' . substr($h, 0, 2) . '.json';
    $doc = $this->readFile($file);
    if (!is_array($doc)) $doc = [];
    $nowSec = intdiv($nowMs, 1000);
    $mine = isset($doc[$h]) && is_array($doc[$h]) ? $doc[$h] : [];
    $total = 0;
    $kept = [];
    foreach ($mine as $sec => $n) {
      if ((int)$sec > $nowSec - 60) { $kept[(string)$sec] = $n; $total += $n; }
    }
    if ($total >= $limit) {
      if (count($kept) !== count($mine)) { $doc[$h] = $kept; $this->writeFile($file, $doc); }
      return true;
    }
    $kept[(string)$nowSec] = (isset($kept[(string)$nowSec]) ? $kept[(string)$nowSec] : 0) + 1;
    $doc[$h] = $kept;
    foreach ($doc as $k => $v) {
      if ($k === $h) continue;
      $last = is_array($v) && $v ? max(array_map('intval', array_keys($v))) : 0;
      if ($last <= $nowSec - 60) unset($doc[$k]);
    }
    $this->writeFile($file, $doc);
    return false;
  }
  function purgeRate($nowMs) {
    $d = @scandir($this->dir . '/rate');
    if ($d === false) return;
    foreach ($d as $f) {
      if (substr($f, -5) !== '.json') continue;
      $t = @filemtime($this->dir . '/rate/' . $f);
      if ($t !== false && $t < intdiv($nowMs, 1000) - 75) @unlink($this->dir . '/rate/' . $f);
    }
  }
}
