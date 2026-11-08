<?php
// Copy to config.php and edit. config.php is private: the .htaccess in this folder refuses to serve it.
//
// The verifier trusts only the issuers listed here. A credential is checked against the key, revocation list
// and suspension list that the listed origin publishes, and a credential naming any other issuer is refused.
return [
    // Required. Each entry is an issuer origin: https://host (no path). Use the plain list form below, or an
    // origin => options map:
    //   'https://issuer.example' => [
    //       'pinnedKeys'  => ['base64url-p256-public-key'],  // optional: the credential's key must be one of these
    //       'suspensions' => 'required',                      // or 'optional': an issuer that has never suspended
    //                                                         // anything may not publish the list yet; HTTP 404
    //                                                         // then counts as "nothing suspended"
    //   ],
    'trustedIssuers' => [
        'https://issuer.example',
    ],

    // Optional. Browser origins that may call verify.php from a web page.
    'allowedOrigins' => [],

    // Optional. SHA-256 (hex) of an access token callers must send as "Authorization: Bearer <token>".
    // Generate with: echo -n "your-token" | sha256sum
    'accessTokenSha256' => null,

    // Optional. Largest request body accepted, in bytes (at most 1048576).
    'maxBodyBytes' => 262144,

    // Testing only. Allows an http://localhost issuer origin.
    'allowInsecureLoopback' => false,
];
