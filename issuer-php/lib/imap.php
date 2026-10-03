<?php
// Minimal hand-rolled IMAP client, PHP port of issuer-server/lib-imap.js —
// same zero-dependency philosophy as lib/smtp.php. Supports exactly what
// SPEC.md §13.3's inbound polling needs: connect (plain or TLS), LOGIN,
// SELECT INBOX, SEARCH UNSEEN, FETCH (RFC822) for a message's full raw
// text, STORE to mark a message \Seen once handled, and LOGOUT. Nothing
// here is a general-purpose IMAP library — no IDLE, no BODYSTRUCTURE-
// based partial fetch, no folder management beyond INBOX.
//
// IMAP responses are not strictly line-oriented the way SMTP's are: a
// response can embed a "literal" — `{n}` followed by exactly n raw bytes,
// which may themselves contain bare CRLFs — most commonly the full
// message body FETCH returns. atlas_imap_read_logical_line() below is
// what makes that safe: it reads an ordinary line, and if that line ends
// with `{n}`, reads exactly n raw bytes next (never scanning them for
// line breaks) before resuming ordinary line-reading for whatever
// follows the literal on the same logical response line. PHP's streams
// are blocking, so this needs no buffered-reader class the way the Node
// version's ByteReader does — fgets()/fread() already block for exactly
// what each call asks for.

function atlas_imap_read_line($socket) {
  $line = fgets($socket, 8192);
  if ($line === false) throw new Exception('IMAP socket closed unexpectedly');
  return rtrim($line, "\r\n");
}

function atlas_imap_read_raw($socket, $n) {
  $data = '';
  while (strlen($data) < $n) {
    $chunk = fread($socket, $n - strlen($data));
    if ($chunk === false || ($chunk === '' && feof($socket))) throw new Exception('IMAP socket closed unexpectedly');
    $data .= $chunk;
  }
  return $data;
}

function atlas_imap_read_logical_line($socket) {
  $acc = atlas_imap_read_line($socket);
  while (preg_match('/\{(\d+)\}$/', $acc, $m)) {
    $literal = atlas_imap_read_raw($socket, (int) $m[1]);
    $rest = atlas_imap_read_line($socket);
    $acc = $acc . $literal . $rest;
  }
  return $acc;
}

// Quotes a string for an IMAP quoted argument (LOGIN's username/password,
// most simply) — backslash-escapes the two characters that would
// otherwise break out of the quotes.
function atlas_imap_quote($s) {
  return '"' . str_replace(['\\', '"'], ['\\\\', '\\"'], (string) $s) . '"';
}

class AtlasImapClient {
  public $socket;
  private $tagCounter = 0;

  public function __construct($socket) {
    $this->socket = $socket;
  }

  private function write($line) {
    fwrite($this->socket, $line . "\r\n");
  }

  // Sends one tagged command, collects every untagged ("* ...") response
  // line until the matching tagged completion arrives, and throws unless
  // that completion is OK.
  public function command($cmd) {
    $tag = 'A' . (++$this->tagCounter);
    $this->write($tag . ' ' . $cmd);
    $untagged = [];
    while (true) {
      $line = atlas_imap_read_logical_line($this->socket);
      if (strpos($line, $tag . ' ') === 0) {
        if (!preg_match('/^\S+ OK/i', $line)) throw new Exception('IMAP command "' . $cmd . '" failed: ' . $line);
        return ['untagged' => $untagged, 'completion' => $line];
      }
      $untagged[] = $line;
    }
  }

  public function readGreeting() {
    $line = atlas_imap_read_logical_line($this->socket);
    if (!preg_match('/^\* OK/i', $line)) throw new Exception('unexpected IMAP greeting: ' . $line);
    return $line;
  }

  public function login($user, $pass) {
    $this->command('LOGIN ' . atlas_imap_quote($user) . ' ' . atlas_imap_quote($pass));
  }

  public function selectInbox() {
    $this->command('SELECT INBOX');
  }

  // Returns an array of message sequence numbers currently unseen —
  // `* SEARCH 1 2 3` (or `* SEARCH` alone, for none).
  public function searchUnseen() {
    $res = $this->command('SEARCH UNSEEN');
    $searchLine = null;
    foreach ($res['untagged'] as $l) {
      if (preg_match('/^\* SEARCH/i', $l)) { $searchLine = $l; break; }
    }
    if ($searchLine === null) return [];
    $rest = trim(preg_replace('/^\* SEARCH\s*/i', '', $searchLine));
    if ($rest === '') return [];
    return array_map('intval', preg_split('/\s+/', $rest));
  }

  // Fetches one message's full raw RFC822 text (headers + body,
  // unparsed) — deliberately the simplest possible FETCH, leaving all
  // MIME structure to lib/mime-parse.php rather than asking the server
  // for BODYSTRUCTURE and fetching parts selectively.
  public function fetchRfc822($seq) {
    $res = $this->command('FETCH ' . $seq . ' (RFC822)');
    $fetchLine = null;
    foreach ($res['untagged'] as $l) {
      if (preg_match('/^\* ' . $seq . ' FETCH/', $l)) { $fetchLine = $l; break; }
    }
    if ($fetchLine === null) throw new Exception('no FETCH response for message ' . $seq);
    $braceIdx = strpos($fetchLine, '{');
    $closeBrace = ($braceIdx === false) ? false : strpos($fetchLine, '}', $braceIdx);
    if ($braceIdx === false || $closeBrace === false) throw new Exception('FETCH response did not carry a literal: ' . $fetchLine);
    $n = (int) substr($fetchLine, $braceIdx + 1, $closeBrace - $braceIdx - 1);
    return substr($fetchLine, $closeBrace + 1, $n);
  }

  public function markSeen($seq) {
    $this->command('STORE ' . $seq . ' +FLAGS (\\Seen)');
  }

  public function logout() {
    try {
      $this->command('LOGOUT');
    } catch (Exception $e) {
      // best-effort — the mailbox state above is already durable
      // server-side regardless of how cleanly LOGOUT itself completes
    }
    fclose($this->socket);
  }
}

// atlas_imap_connect(['host', 'port', 'secure', 'user', 'pass']) —
// connects, reads the greeting, upgrades to TLS if requested, logs in,
// and selects INBOX. Returns a ready-to-use AtlasImapClient. `secure`
// follows lib/smtp.php's own convention: 'tls' | 'starttls' | 'none'.
function atlas_imap_connect($opts) {
  $transport = ($opts['secure'] === 'tls') ? 'ssl' : 'tcp';
  $socket = @stream_socket_client($transport . '://' . $opts['host'] . ':' . $opts['port'], $errno, $errstr, 10);
  if (!$socket) throw new Exception('could not connect to ' . $opts['host'] . ':' . $opts['port'] . ' (' . $errstr . ')');
  stream_set_timeout($socket, 10);

  $client = new AtlasImapClient($socket);
  $client->readGreeting();

  if ($opts['secure'] === 'starttls') {
    $client->command('STARTTLS');
    // stream_socket_enable_crypto() upgrades the SAME stream resource in
    // place — unlike the Node version, which hands the plaintext socket
    // off to a brand-new tls.connect() wrapper and so needs a fresh
    // ImapClient/ByteReader pair afterward, there is no separate resource
    // here to re-wrap, so $client stays exactly as it is.
    if (!stream_socket_enable_crypto($socket, true, STREAM_CRYPTO_METHOD_TLS_CLIENT)) {
      throw new Exception('STARTTLS upgrade to ' . $opts['host'] . ' failed');
    }
  }

  $client->login($opts['user'], $opts['pass']);
  $client->selectInbox();
  return $client;
}
