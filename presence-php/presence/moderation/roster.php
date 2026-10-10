<?php
// POST /presence/moderation/roster — body {grant, request}. Lists the
// anonymous sessions of one world to a moderator whose issuer-signed grant,
// proof of possession and current issuer status all check out (see
// lib/moderation.php and docs/moderation-authorization.md). Read-only. CORS is
// answered only for the configured moderation domains' own origins.
//
// Success: {domain, world, generatedAt, count, participants[]} (each entry
// has `mutedUntil` while that visitor is muted). Failure:
// {error, code} with 400 (malformed), 401 (bad or replayed proof), 403 (not
// authorized for that domain, world or operation), 429 (too many failed
// attempts from this source) or 503 (moderation not configured, or the
// issuer's current authorization status is unavailable: fail closed).
require_once __DIR__ . '/../lib/bootstrap.php';

moderation_serve(['roster.view'], function ($auth) {
  return [200, moderation_build_roster($auth['domain'], $auth['world'])];
});
