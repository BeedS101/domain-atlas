/* Domain Atlas verifier setup assistant v0.1.
 * Browser-only configuration generator. No network, server writes or installer privileges.
 * Keep verification semantics in verifier-php; this only creates operator configuration.
 */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VerifierSetup = api;
})(typeof window !== 'undefined' ? window : this, function () {
  function normalizeOrigin(value) {
    if (typeof value !== 'string') throw new Error('Issuer must be an HTTPS origin.');
    const input = value.trim();
    const match = /^https:\/\/([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::([0-9]{1,5}))?\/?$/i.exec(input);
    if (!match) throw new Error('Use only an HTTPS issuer origin, such as https://issuer.example (no path, query or credentials).');
    const host = match[1].toLowerCase();
    const labels = host.split('.');
    if (host.length > 253 || labels.length < 2 || labels.some(function (s) {
      return !s || s.length > 63 || s[0] === '-' || s[s.length - 1] === '-' || !/^[a-z0-9-]+$/.test(s);
    }) || /^[0-9.]+$/.test(host)) throw new Error('Use a public DNS hostname, not localhost, an IP address or an invalid domain.');
    const port = match[2] ? Number(match[2]) : null;
    if (port !== null && (port < 1 || port > 65535)) throw new Error('Issuer port must be between 1 and 65535.');
    return 'https://' + host + (port && port !== 443 ? ':' + port : '');
  }

  function normalizePrivatePath(value) {
    if (typeof value !== 'string') throw new Error('Enter an absolute private configuration path.');
    const path = value.trim();
    if (/^\/home\/ACCOUNT\//.test(path)) throw new Error('Replace ACCOUNT with your actual hosting account name.');
    if (!/^\/[A-Za-z0-9._/-]+\/verify-config\.php$/.test(path) || path.includes('//') ||
        path.split('/').some(function (part) { return part === '..' || part === '.'; })) {
      throw new Error('Use an absolute Unix path ending in /verify-config.php, without spaces or traversal.');
    }
    if (/\/(?:public_html|htdocs|httpdocs|wwwroot|webroot|www|public)\//i.test(path)) {
      throw new Error('The private config must be outside the publicly served document root.');
    }
    return path;
  }

  function phpString(value) {
    return "'" + value.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
  }

  function generate(options) {
    options = options || {};
    const suspensionMode = options.suspensions === 'optional' ? 'optional' : 'required';
    if (options.suspensions !== undefined && options.suspensions !== 'optional' && options.suspensions !== 'required') {
      throw new Error('Invalid suspension policy.');
    }
    const origins = (typeof options.issuers === 'string' ? options.issuers : '').split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (origins.length < 1 || origins.length > 10) throw new Error('Enter between 1 and 10 trusted issuer origins.');
    const seen = new Set();
    const trusted = origins.map(function (origin) {
      const normalized = normalizeOrigin(origin);
      if (seen.has(normalized)) throw new Error('Duplicate issuer: ' + normalized);
      seen.add(normalized);
      return normalized;
    });
    const privatePath = normalizePrivatePath(options.privatePath);
    const entries = trusted.map(function (origin) {
      return '        ' + phpString(origin) + " => ['suspensions' => " + phpString(suspensionMode) + '],';
    }).join('\n');
    const privateConfig = [
      '<?php',
      '// Created by the Domain Atlas verifier setup assistant.',
      '// Keep this file OUTSIDE the document root. Never publish it over HTTP.',
      'return [',
      "    'trustedIssuers' => [",
      entries,
      '    ],',
      "    'allowedOrigins' => [],",
      "    'accessTokenSha256' => null,",
      "    'maxBodyBytes' => 262144,",
      "    'allowInsecureLoopback' => false,",
      '];',
      ''
    ].join('\n');
    const stub = '<?php\n// Install alongside verify.php as config.php.\nreturn require ' + phpString(privatePath) + ';\n';
    return { trustedIssuers: trusted, suspensionMode: suspensionMode, privatePath: privatePath,
      privateConfig: privateConfig, stub: stub };
  }
  return { normalizeOrigin: normalizeOrigin, normalizePrivatePath: normalizePrivatePath, generate: generate };
});
