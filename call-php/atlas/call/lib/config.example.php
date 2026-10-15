<?php
// Settings for the Domain Atlas Call Service. Copy this file to config.php in the same folder
// and edit it. Until config.php exists the service answers "calls-not-configured" and writes
// nothing. The file only returns an array, so fetching it over the web prints nothing, and the
// .htaccess in this folder refuses the request in any case. Keep it readable by your hosting
// account only (chmod 600). docs/voice-calls-deploy-php.md explains each setting.
return [
  // The address wallets use for this service: scheme and host, no path, no trailing slash.
  'origin' => 'https://example.com',

  // This domain, exactly as its issuer writes it in membership credentials (issuer.domain).
  'domain' => 'example.com',

  // The domain issuer's public key, copied from https://example.com/.well-known/atlas-key.json
  // (the raw 87-character publicKey). Up to eight, so a key can be replaced without a gap.
  'issuerKeys' => [
    // 'PASTE-THE-ISSUER-PUBLIC-KEY-HERE',
  ],

  // Where this domain's issuer publishes revoked credentials: the full path of the file, starting
  // with / (not a URL). On the same hosting account that is a file the service can read; membership checks fail closed if it cannot be read.
  'revocationsFile' => '/home/ACCOUNT/public_html/.well-known/atlas-revocations.json',
  // 'revocationsUrl' => 'https://example.com/.well-known/atlas-revocations.json',  // instead of the file

  // Where the service keeps its state (small files, deleted by the service as they expire). A full
  // path starting with /; a relative path is refused. Leave the line out to use lib/state.
  // Prefer a folder outside the web root, writable only by your hosting account.
  'stateDir' => '/home/ACCOUNT/atlas-call-state',

  // STUN servers you operate. Leave empty to try direct connections only.
  'stunUrls' => [],

  // TURN relay you operate (see docs/voice-calls-deploy-turn.md). Leave empty without one.
  'turnUrls' => [],
  // 'turnSecretFile' => '/home/ACCOUNT/atlas-turn-secret',   // chmod 600; or 'turnSecret' => '...'
  // 'turnTtlSeconds' => 3600,

  // Only behind a reverse proxy or CDN that you control: trust X-Forwarded-For and
  // X-Forwarded-Proto from these addresses.
  // 'trustProxy' => true,
  // 'proxyAddrs' => ['203.0.113.10'],

  // Troubleshooting only: record the reason an invitation was refused (for example
  // "callee-not-listening") in the PHP error log and in refusals.log inside the state folder.
  // Callers still get the same uniform reply, and the line carries no key, tag or address.
  // Turn it off again when you are done.
  // 'logRefusals' => true,

  // Web pages allowed to send call invitations from the browser (exact https origins).
  // 'inviteCorsOrigins' => [],
];
