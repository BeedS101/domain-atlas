<?php
// POST /presence/moderation/roster — body {grant, request}. Lists the
// anonymous sessions of one world to a moderator whose issuer-signed grant,
// proof of possession and current issuer status all check out (see
// lib/moderation.php and docs/moderation-authorization.md). Read-only. No
// CORS: the response is not for pages to read.
//
// Success: {domain, world, generatedAt, count, participants[]}. Failure:
// {error, code} with 400 (malformed), 401 (bad or replayed proof), 403 (not
// authorized for that domain, world or operation), 429 (too many failed
// attempts from this source) or 503 (moderation not configured, or the
// issuer's current authorization status is unavailable: fail closed).
require_once __DIR__ . '/../lib/bootstrap.php';
handle_preflight();
require_post();

$addr = isset($_SERVER['REMOTE_ADDR']) ? $_SERVER['REMOTE_ADDR'] : '';
$nostore = ['Cache-Control: no-store'];

$retryAfter = moderation_failure_retry_after($addr);
if ($retryAfter) send_json(429, ['error' => 'too many failed moderation requests; try again later', 'code' => 'rate-limited', 'retryAfter' => $retryAfter], false, ['Retry-After: ' . $retryAfter, 'Cache-Control: no-store']);

try {
  $body = read_json_body(MODERATION_MAX_BODY_BYTES);
} catch (Exception $e) {
  moderation_note_failure($addr);
  send_json(400, ['error' => 'malformed request', 'code' => 'bad-request'], false, $nostore);
}

$auth = moderation_authorize($body, 'roster.view');
if (!$auth['ok']) {
  if ($auth['status'] < 500 && $auth['code'] !== 'rate-limited') moderation_note_failure($addr);
  send_json($auth['status'], ['error' => $auth['message'], 'code' => $auth['code']], false, $nostore);
}
send_json(200, moderation_build_roster($auth['domain'], $auth['world']), false, $nostore);
