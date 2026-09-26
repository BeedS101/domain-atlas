<?php
// POST /atlas/admin/directory — mirrors issuer-server/server.js's same
// route. Admin-gated (require_admin_auth(), above), same wire shape as
// every other admin action here: {payload, proof} or {payload, token}.
//
// atlas_subscribers_file()'s own comment already anticipated this exact
// use ("so the operator can ... message everyone by hand later ... worth
// real operator authentication before ever exposing this over HTTP") — a
// session token is that authentication. Hands back both rosters this
// domain keeps (atlas.membership subscribers and Global Mail/Post Office
// members — two different credential classes, kept as separate lists
// rather than merged so the admin panel can label them), each filtered to
// currently-unrevoked credentials only: a revoked credential id is
// exactly the kind of dead-end address the mail form's own recipient
// warning (see atlas/mail/send.php) exists to catch, so there's no reason
// to offer one as a suggestion here.
require_once __DIR__ . '/../../lib/bootstrap.php';
handle_preflight();
require_post();

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$payload = $body['payload'] ?? [];
$proof = $body['proof'] ?? null;
$token = $body['token'] ?? null;
$auth = require_admin_auth($payload, $proof, $token);
if (isset($auth['error'])) send_json(401, ['error' => $auth['error']]);

$subscribers = array_values(array_filter(
  read_subscribers()['subscribers'],
  function ($s) { return !is_revoked($s['credentialId']); }
));
$postOfficeMembers = array_values(array_filter(
  read_postoffice_members()['members'],
  function ($m) { return !is_revoked($m['credentialId']); }
));
send_json(200, ['subscribers' => $subscribers, 'postOfficeMembers' => $postOfficeMembers]);
