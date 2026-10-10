<?php
// POST /presence/moderation/audit — body {grant, request} with operation
// audit.view and the world to read as `world`. Returns the private audit log
// entries of that domain and world (see lib/audit.php) to a moderator whose
// issuer-signed grant, proof of possession and current issuer status all
// permit audit.view for that world. Read-only. A moderator never sees another
// domain's or another world's entries; entries no world could be attributed to
// are visible only to a moderator whose scope is every world. CORS is answered
// only for the configured moderation domains' own origins.
//
// Success: {domain, world, generatedAt, entries[], truncated, integrity
// {chain, entries, lastSeq, head, firstBadSeq}, retention}. Failures are the
// same as roster.php.
require_once __DIR__ . '/../lib/bootstrap.php';

moderation_serve(['audit.view'], function ($auth) {
  return [200, ['domain' => $auth['domain'], 'world' => $auth['world'], 'generatedAt' => moderation_iso(moderation_now_ms())] + audit_read($auth['domain'], $auth['world'], $auth['worlds'] === '*')];
});
