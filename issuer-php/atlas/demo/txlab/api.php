<?php
// Domain Atlas - Multi-Domain Transaction Authorization Lab (test only, no real value).
// Single entry point: /atlas/demo/txlab/api.php?op=<operation>. Read operations are public;
// create and decide need the demo-administrator token; submit-approval is public but
// only accepts a decision signed by a roster domain's own key. The public-* operations exist
// only when publicDemo is enabled in the private config: each is bound to one visitor
// session and offers no way to sign arbitrary data; peer-approve only answers a request
// signed by the settlement domain. No CORS headers are sent: the lab page talks to its own
// domain, and domains talk to each other server to server.
require_once __DIR__ . '/inc/txlab.php';

header('Content-Type: application/json');
header('Cache-Control: no-store, no-cache, must-revalidate');
header('X-Content-Type-Options: nosniff');

function txlab_reply($status, $obj) {
  http_response_code($status);
  echo json_encode($obj, JSON_UNESCAPED_SLASHES);
  exit;
}

function txlab_body($requireJson = false) {
  // a JSON content type cannot be sent cross-site without a CORS preflight, which this API never grants
  if ($requireJson && (!isset($_SERVER['CONTENT_TYPE']) || stripos($_SERVER['CONTENT_TYPE'], 'application/json') !== 0)) txlab_fail(415, 'send application/json');
  $declared = isset($_SERVER['CONTENT_LENGTH']) ? (int) $_SERVER['CONTENT_LENGTH'] : 0;
  if ($declared > TXLAB_MAX_BODY) txlab_fail(413, 'request body too large');
  $raw = file_get_contents('php://input', false, null, 0, TXLAB_MAX_BODY + 1);
  if ($raw === false || strlen($raw) > TXLAB_MAX_BODY) txlab_fail(413, 'request body too large');
  $data = json_decode($raw, true);
  if (!is_array($data) || ($data !== [] && array_keys($data) === range(0, count($data) - 1))) txlab_fail(400, 'the body must be a JSON object');
  return $data;
}

function txlab_need($method) {
  if ($_SERVER['REQUEST_METHOD'] !== $method) txlab_fail(405, 'method not allowed');
}

try {
  $op = isset($_GET['op']) && is_string($_GET['op']) ? $_GET['op'] : '';
  if ($op === 'health') txlab_reply(200, txlab_health());
  $id = isset($_GET['id']) && is_string($_GET['id']) ? $_GET['id'] : '';

  switch ($op) {
    case 'roster':
      txlab_need('GET');
      txlab_reply(200, txlab_roster());
    case 'state':
      txlab_need('GET');
      txlab_reply(200, txlab_state());
    case 'tx':
      txlab_need('GET');
      if (!preg_match('/^[0-9a-f-]{36}$/', $id)) txlab_fail(400, 'invalid transaction id');
      txlab_reply(200, txlab_view($id));
    case 'peers':
      txlab_need('GET');
      txlab_reply(200, ['domain' => txlab_require_config()['domain'], 'peers' => txlab_peers()]);
    case 'admin-check':
      txlab_need('POST');
      $b = txlab_body();
      $cfg = txlab_require_admin(isset($b['adminToken']) ? $b['adminToken'] : null);
      txlab_reply(200, ['ok' => true, 'domain' => $cfg['domain']]);
    case 'create':
      txlab_need('POST');
      $b = txlab_body();
      txlab_require_admin(isset($b['adminToken']) ? $b['adminToken'] : null);
      txlab_reply(200, txlab_create(
        isset($b['requestId']) ? $b['requestId'] : null,
        isset($b['from']) ? $b['from'] : null,
        isset($b['to']) ? $b['to'] : null,
        isset($b['amountMinor']) ? $b['amountMinor'] : null
      ));
    case 'decide':
      txlab_need('POST');
      $b = txlab_body();
      txlab_require_admin(isset($b['adminToken']) ? $b['adminToken'] : null);
      txlab_reply(200, txlab_decide(isset($b['id']) ? $b['id'] : null, isset($b['decision']) ? $b['decision'] : null));
    case 'submit-approval':
      txlab_need('POST');
      $b = txlab_body();
      txlab_reply(200, txlab_submit_approval(
        isset($b['id']) ? $b['id'] : null,
        isset($b['approval']) ? $b['approval'] : null,
        isset($b['signature']) ? $b['signature'] : null
      ));
    case 'public-start':
      txlab_need('POST');
      txlab_body(true);
      txlab_reply(200, txlab_public_start());
    case 'public-session':
      txlab_need('POST');
      $b = txlab_body(true);
      txlab_reply(200, txlab_public_session_state(isset($b['sid']) ? $b['sid'] : null, isset($b['token']) ? $b['token'] : null));
    case 'public-transfer':
      txlab_need('POST');
      $b = txlab_body(true);
      txlab_reply(200, txlab_public_transfer(
        isset($b['sid']) ? $b['sid'] : null,
        isset($b['token']) ? $b['token'] : null,
        isset($b['requestId']) ? $b['requestId'] : null,
        isset($b['from']) ? $b['from'] : null,
        isset($b['to']) ? $b['to'] : null,
        isset($b['amountMinor']) ? $b['amountMinor'] : null
      ));
    case 'public-approve':
      txlab_need('POST');
      $b = txlab_body(true);
      txlab_reply(200, txlab_public_approve(
        isset($b['sid']) ? $b['sid'] : null,
        isset($b['token']) ? $b['token'] : null,
        isset($b['id']) ? $b['id'] : null,
        isset($b['domain']) ? $b['domain'] : null
      ));
    case 'peer-approve':
      txlab_need('POST');
      $b = txlab_body(true);
      txlab_reply(200, txlab_public_peer_approve(isset($b['request']) ? $b['request'] : null, isset($b['signature']) ? $b['signature'] : null));
    default:
      txlab_fail(404, 'unknown operation');
  }
} catch (TxlabError $e) {
  $body = ['error' => $e->getMessage()];
  foreach ($e->extra as $k => $v) $body[$k] = $v;
  txlab_reply($e->httpStatus, $body);
} catch (Throwable $e) {
  error_log('txlab: ' . $e->getMessage() . ' at ' . basename($e->getFile()) . ':' . $e->getLine());
  txlab_reply(500, ['error' => 'internal error']);
}
