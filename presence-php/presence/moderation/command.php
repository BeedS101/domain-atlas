<?php
// POST /presence/moderation/command — body {grant, request}. Mutes, unmutes or
// kicks one anonymous session of a world, for a moderator whose issuer-signed
// grant, proof of possession and current issuer status all check out (see
// lib/moderation.php and docs/moderation-authorization.md). The request names
// the operation (chat.mute, chat.unmute or session.kick), the target (a
// participant reference from the roster) and, optionally, params
// {durationSeconds, cause} with `cause` one of a fixed set of codes. CORS is
// answered only for the configured moderation domains' own origins.
//
// Success: {ok:true, operation, ref, world, ...}: mutedUntil / durationSeconds
// / cause for a mute, wasMuted for an unmute, removed {presence, chat} and
// rejoinAfter for a kick. Failure: {error, code} with 400 (malformed), 401
// (bad or replayed proof), 403 (not authorized for that domain, world or
// operation), 404 (no such participant in that world), 409 (not in chat), 429
// (too many failed attempts from this source, or too many commands from this
// moderator; Retry-After), or 503 (moderation not configured, the issuer's
// current authorization status unavailable, the restriction store full, or the
// audit log not writable).
require_once __DIR__ . '/../lib/bootstrap.php';

moderation_serve(['chat.mute', 'chat.unmute', 'session.kick'], function ($auth) {
  return moderation_execute_command($auth);
});
