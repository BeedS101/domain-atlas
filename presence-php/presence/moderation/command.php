<?php
// POST /presence/moderation/command — body {grant, request}. Mutes, unmutes or
// kicks one anonymous session of a world, for a moderator whose issuer-signed
// grant, proof of possession and current issuer status all check out (see
// lib/moderation.php and docs/moderation-authorization.md). The request names
// the operation (chat.mute, chat.unmute or session.kick), the target (a
// participant reference from the roster) and, optionally, params
// {durationSeconds, cause} with `cause` one of a fixed set of codes. No CORS:
// the response is not for pages to read.
//
// Success: {ok:true, operation, ref, world, ...}: mutedUntil / durationSeconds
// / cause for a mute, wasMuted for an unmute, removed {presence, chat} and
// rejoinAfter for a kick. Failure: {error, code} with 400 (malformed), 401
// (bad or replayed proof), 403 (not authorized for that domain, world or
// operation), 404 (no such participant in that world), 409 (not in chat), 429
// (too many failed attempts from this source, or too many commands from this
// moderator; Retry-After), or 503 (moderation not configured, the issuer's
// current authorization status unavailable, or the restriction store full).
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

$auth = moderation_authorize($body, ['chat.mute', 'chat.unmute', 'session.kick']);
if (!$auth['ok']) {
  if ($auth['status'] < 500 && $auth['code'] !== 'rate-limited') moderation_note_failure($addr);
  if (isset($auth['retryAfter'])) send_json($auth['status'], ['error' => $auth['message'], 'code' => $auth['code'], 'retryAfter' => $auth['retryAfter']], false, ['Retry-After: ' . $auth['retryAfter'], 'Cache-Control: no-store']);
  send_json($auth['status'], ['error' => $auth['message'], 'code' => $auth['code']], false, $nostore);
}
list($status, $out) = moderation_execute_command($auth);
send_json($status, $out, false, $nostore);
