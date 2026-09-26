<?php
// GET /atlas/admin/session/nonce — mirrors issuer-server/server.js's same
// route. Ungated: handing out a nonce to anyone who asks is harmless, it's
// worthless without a roster key's signature over it (see start.php),
// same "the endpoint's existence isn't the secret" posture every other
// write endpoint in this bundle already has before require_admin() runs.
require_once __DIR__ . '/../../../lib/bootstrap.php';
handle_preflight();
require_get();

send_json(200, ['nonce' => issue_admin_nonce()]);
