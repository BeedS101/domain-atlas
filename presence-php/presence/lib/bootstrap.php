<?php
// Domain Atlas — PHP presence: shared request handling for the polling
// routes.
//
// A near-duplicate of issuer-php/lib/bootstrap.php's request helpers rather
// than shared code — presence is its own independently-deployable bundle.
// No signing or crypto here: presence is ephemeral "who's here right now"
// state with no wallet identity in it, so there is nothing to verify.

require_once __DIR__ . '/store.php';

// CORS is opened only for the read-only status route, which a content script
// on any page calls to show a participant count. Every other route is called
// from the extension's own pages and does not need it.
function cors_headers() {
  header('Access-Control-Allow-Origin: *');
  header('Access-Control-Allow-Methods: GET, OPTIONS');
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
    }
    echo json_encode(['error' => $err['message'] . ' in ' . basename($err['file']) . ':' . $err['line']]);
  }
});

function send_json($status, $obj, $cors = false) {
  http_response_code($status);
  header('Content-Type: application/json');
  if ($cors) cors_headers();
  echo json_encode($obj, JSON_UNESCAPED_SLASHES);
  exit;
}

// Call this FIRST in every endpoint file, before require_post().
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
    echo 'Method not allowed';
    exit;
  }
}

// Reads the JSON body, refusing anything over PRESENCE_MAX_BODY_BYTES.
function read_json_body() {
  $raw = file_get_contents('php://input', false, null, 0, PRESENCE_MAX_BODY_BYTES + 1);
  if ($raw === '' || $raw === false) return [];
  if (strlen($raw) > PRESENCE_MAX_BODY_BYTES) send_json(413, ['error' => 'request body too large']);
  $data = json_decode($raw, true);
  if (!is_array($data)) throw new Exception('invalid JSON body');
  return $data;
}

// Maps a failed join ('room-full' / 'server-busy') to its HTTP status.
function join_failure_response($reason) {
  send_json(503, ['error' => $reason, 'reason' => $reason]);
}
