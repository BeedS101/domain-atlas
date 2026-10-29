<?php
// Domain Atlas - Multi-Issuer Portable Asset Lab (test only, no real value).
// Single entry point: /atlas/demo/multi-issuer/api.php?op=<operation>.
//
// Read operations (health, discovery, asset, tx) are public and hold no secrets. peer-* operations
// answer only requests signed by a roster domain's pinned key. submit-approval accepts only a
// decision signed by a roster domain. The public-* operations exist only when publicDemo is enabled
// in the private config; each is bound to one visitor session and none signs caller-supplied data.
// No administrator token exists here and no CORS headers are sent: the page talks to its own
// domain, and domains talk to each other server to server.
require_once __DIR__ . '/inc/mi.php';

header('Content-Type: application/json');
header('Cache-Control: no-store, no-cache, must-revalidate');
header('X-Content-Type-Options: nosniff');

function mi_reply($status, $obj) {
  http_response_code($status);
  echo json_encode($obj, JSON_UNESCAPED_SLASHES);
  exit;
}

function mi_body($max = MI_MAX_BODY) {
  // a JSON content type cannot be sent cross-site without a CORS preflight, which this API never grants
  if (!isset($_SERVER['CONTENT_TYPE']) || stripos($_SERVER['CONTENT_TYPE'], 'application/json') !== 0) mi_fail(415, 'send application/json');
  $declared = isset($_SERVER['CONTENT_LENGTH']) ? (int) $_SERVER['CONTENT_LENGTH'] : 0;
  if ($declared > $max) mi_fail(413, 'request body too large');
  $raw = file_get_contents('php://input', false, null, 0, $max + 1);
  if ($raw === false || strlen($raw) > $max) mi_fail(413, 'request body too large');
  $data = json_decode($raw, true);
  if (!is_array($data) || ($data !== [] && array_keys($data) === range(0, count($data) - 1))) mi_fail(400, 'the body must be a JSON object');
  return $data;
}

function mi_need($method) {
  if ($_SERVER['REQUEST_METHOD'] !== $method) mi_fail(405, 'method not allowed');
}

function mi_pick($b, $k) { return isset($b[$k]) ? $b[$k] : null; }

try {
  $op = isset($_GET['op']) && is_string($_GET['op']) ? $_GET['op'] : '';
  if ($op === 'health') mi_reply(200, mi_health());
  $id = isset($_GET['id']) && is_string($_GET['id']) ? $_GET['id'] : '';
  $nonce = isset($_GET['nonce']) && is_string($_GET['nonce']) ? $_GET['nonce'] : null;

  switch ($op) {
    case 'discovery':
      mi_need('GET');
      mi_reply(200, mi_manifest_doc());
    case 'asset':
      mi_need('GET');
      mi_gate(mi_require_config());
      mi_reply(200, mi_asset_view($id, $nonce));
    case 'tx':
      mi_need('GET');
      mi_gate(mi_require_config());
      mi_reply(200, mi_transfer_view($id));
    case 'peer-fetch':
      mi_need('POST');
      $b = mi_body();
      mi_reply(200, mi_peer_fetch(mi_pick($b, 'request'), mi_pick($b, 'signature')));
    case 'peer-issue-approve':
      mi_need('POST');
      $b = mi_body();
      mi_reply(200, mi_peer_decide(mi_pick($b, 'request'), mi_pick($b, 'signature'), 'issue'));
    case 'peer-transfer-approve':
      mi_need('POST');
      $b = mi_body();
      mi_reply(200, mi_peer_decide(mi_pick($b, 'request'), mi_pick($b, 'signature'), 'transfer'));
    case 'submit-approval':
      mi_need('POST');
      $b = mi_body();
      mi_gate(mi_require_config());
      mi_reply(200, mi_submit_approval(mi_pick($b, 'kind'), mi_pick($b, 'id'), mi_pick($b, 'approval'), mi_pick($b, 'signature')));
    case 'public-start':
      mi_need('POST');
      mi_body();
      mi_reply(200, mi_public_start());
    case 'public-session':
      mi_need('POST');
      $b = mi_body();
      mi_reply(200, mi_public_session(mi_pick($b, 'sid'), mi_pick($b, 'token')));
    case 'public-asset-create':
      mi_need('POST');
      $b = mi_body();
      mi_reply(200, mi_public_asset_create(mi_pick($b, 'sid'), mi_pick($b, 'token'), mi_pick($b, 'requestId'), mi_pick($b, 'ownerPublicKey'), mi_pick($b, 'label'), mi_pick($b, 'class')));
    case 'public-issue-approve':
      mi_need('POST');
      $b = mi_body();
      mi_reply(200, mi_public_issue_approve(mi_pick($b, 'sid'), mi_pick($b, 'token'), mi_pick($b, 'assetId'), mi_pick($b, 'domain')));
    case 'public-transfer-propose':
      mi_need('POST');
      $b = mi_body();
      mi_reply(200, mi_public_transfer_propose(mi_pick($b, 'sid'), mi_pick($b, 'token'), mi_pick($b, 'payload'), mi_pick($b, 'ownerAuthorization'), mi_pick($b, 'ownerSignature')));
    case 'public-transfer-approve':
      mi_need('POST');
      $b = mi_body();
      mi_reply(200, mi_public_transfer_approve(mi_pick($b, 'sid'), mi_pick($b, 'token'), mi_pick($b, 'txId'), mi_pick($b, 'domain')));
    case 'verify':
      mi_need('POST');
      $b = mi_body(MI_MAX_IMPORT_BYTES);
      mi_reply(200, mi_public_verify(mi_pick($b, 'asset'), !empty($b['online'])));
    default:
      mi_fail(404, 'unknown operation');
  }
} catch (TxlabError $e) {
  $body = ['error' => $e->getMessage()];
  foreach ($e->extra as $k => $v) $body[$k] = $v;
  mi_reply($e->httpStatus, $body);
} catch (Throwable $e) {
  error_log('multi-issuer: ' . $e->getMessage() . ' at ' . basename($e->getFile()) . ':' . $e->getLine());
  mi_reply(500, ['error' => 'internal error']);
}
