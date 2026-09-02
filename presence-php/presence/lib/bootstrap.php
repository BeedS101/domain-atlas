<?php
// Domain Atlas — PHP presence (polling fallback, task #68): shared request
// handling for the poll/join, poll/sync, poll/leave routes below.
//
// Deliberately a near-duplicate of issuer-php/lib/bootstrap.php's request
// helpers (cors_headers/send_json/handle_preflight/require_post/
// read_json_body) rather than sharing code with it — presence is its own
// independently-deployable bundle, same "separate service" reasoning
// presence-server/server.js already has relative to issuer-server/
// server.js (see that file's own header comment). No signing/crypto here
// at all, unlike the issuer: presence is ephemeral "who's here right now"
// state, not a credentialed operation, so there's nothing to verify and
// nothing worth pulling in openssl for.

require_once __DIR__ . '/store.php';

function cors_headers() {
  header('Access-Control-Allow-Origin: *');
  header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
  header('Access-Control-Allow-Headers: Content-Type');
}

// Turns any uncaught exception or PHP fatal error into a JSON error
// response instead of a blank body — same reasoning as issuer-php's
// identical handler. Most production hosting has display_errors off, so
// without this a bug here (a permissions problem, a PHP version quirk)
// shows up in the extension as an opaque failed fetch with nothing to go
// on; with this, the real reason comes back in the response body instead.
set_exception_handler(function ($e) {
  if (!headers_sent()) {
    http_response_code(500);
    header('Content-Type: application/json');
    cors_headers();
  }
  echo json_encode(['error' => $e->getMessage()]);
  exit;
});
register_shutdown_function(function () {
  $err = error_get_last();
  if ($err && in_array($err['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true)) {
    if (!headers_sent()) {
      http_response_code(500);
      header('Content-Type: application/json');
      cors_headers();
    }
    echo json_encode(['error' => $err['message'] . ' in ' . basename($err['file']) . ':' . $err['line']]);
  }
});

function send_json($status, $obj) {
  http_response_code($status);
  header('Content-Type: application/json');
  cors_headers();
  echo json_encode($obj, JSON_UNESCAPED_SLASHES);
  exit;
}

// Call this FIRST in every endpoint file, before require_post() — the
// browser sends a real OPTIONS preflight ahead of the POST (cross-origin +
// JSON content-type triggers it, and this genuinely is cross-origin: the
// extension calls this from whatever page the world manifest is served
// from, not from this same origin), and it must succeed even though the
// real route only ever accepts POST.
function handle_preflight() {
  if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    cors_headers();
    exit;
  }
}

function require_post() {
  if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    cors_headers();
    echo 'Method not allowed';
    exit;
  }
}

function read_json_body() {
  $raw = file_get_contents('php://input');
  if ($raw === '' || $raw === false) return [];
  $data = json_decode($raw, true);
  if (!is_array($data)) throw new Exception('invalid JSON body');
  return $data;
}
