// Static audit of an extracted verifier package. Returns a list of { name, ok, detail } results.
//
// The allowlists here are the package's dependency map: the PHP functions it may call (with the extension each one comes
// from), the hosts its text may mention, and the file types it may contain. A new call, host or file type fails the audit
// until it is added here on purpose.
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TOKENS = path.join(__dirname, '..', 'verifier-php', 'audit-tokens.php');

// function -> extension, for every builtin the package may call
const ALLOWED_BUILTINS = {
  abs: 'standard', array_key_exists: 'standard', array_keys: 'standard', array_map: 'standard', array_values: 'standard',
  base64_decode: 'standard', base64_encode: 'standard', call_user_func: 'standard', chr: 'standard',
  chunk_split: 'standard', count: 'standard', file_get_contents: 'standard', floor: 'standard', gettype: 'standard',
  implode: 'standard', in_array: 'standard', ini_get: 'standard', ini_set: 'standard', is_array: 'standard',
  is_bool: 'standard', is_callable: 'standard', is_file: 'standard', is_float: 'standard', is_int: 'standard',
  is_nan: 'standard', is_infinite: 'standard', is_object: 'standard', is_string: 'standard', header: 'standard', http_response_code: 'standard', microtime: 'standard',
  min: 'standard', ord: 'standard', parse_url: 'standard', realpath: 'standard', rtrim: 'standard',
  sprintf: 'standard', str_repeat: 'standard', stream_context_create: 'standard', strtolower: 'standard', strtr: 'standard',
  substr: 'standard', trim: 'standard', usort: 'standard',
  strlen: 'Core', defined: 'Core', function_exists: 'Core', get_object_vars: 'Core', property_exists: 'Core',
  checkdate: 'date', gmdate: 'date', gmmktime: 'date',
  curl_close: 'curl', curl_error: 'curl', curl_exec: 'curl', curl_getinfo: 'curl', curl_init: 'curl', curl_setopt_array: 'curl',
  filter_var: 'filter', hash: 'hash', hash_equals: 'hash',
  json_decode: 'json', json_encode: 'json', ltrim: 'standard',
  openssl_verify: 'openssl',
  preg_match: 'pcre'
};
// guarded by function_exists() because the function only exists on PHP 8.4 and later
const GUARDED_BUILTINS = new Set(['http_get_last_response_headers']);
// the one closure called through a variable
const ALLOWED_VARIABLE_CALLS = { 'lib/atlas-verify.php': new Set(['variable-call:$malformed']) };
const ALLOWED_INCLUDES = {
  'verify.php': new Set(["__DIR__.'/lib/atlas-verify.php'", '$configFile']),
  'lib/atlas-verify.php': new Set(["__DIR__.'/atlas-verify-crypto.php'", "__DIR__.'/atlas-verify-fetch.php'"])
};
const ALLOWED_PHP_FILES = new Set(['verify.php', 'config.example.php', 'lib/atlas-verify.php', 'lib/atlas-verify-crypto.php', 'lib/atlas-verify-fetch.php']);
const ALLOWED_FILE_NAMES = new Set(['.htaccess', 'lib/.htaccess', 'LICENSE', 'PACKAGE.json', 'README.md', 'VERSION', 'config.example.php',
  'verify.php', 'lib/atlas-verify.php', 'lib/atlas-verify-crypto.php', 'lib/atlas-verify-fetch.php']);
const ALLOWED_HOSTS = new Set(['host', 'issuer.example', 'localhost', '127.0.0.1', '[::1]', 'example.com', 'example.org']);
const ALLOWED_CLASSES = new Set(['Exception', '\\stdClass', 'stdClass']);

// anything that signs, generates keys, writes, runs programs or executes dynamic code
const FORBIDDEN_CALLS = [
  /(^|_)sign($|_)/i, /^openssl_(sign|pkey_(new|export|get_private)|private_|csr|x509_(export|sign)|seal|encrypt|random|spki)/i,
  /^sodium_/i, /^random_/i, /^mt_rand$|^rand$|^uniqid$|^lcg_value$/i, /^(file_put_contents|fopen|fwrite|fputs|unlink|rename|copy|mkdir|rmdir|touch|chmod|chown|tempnam|tmpfile|symlink|link|move_uploaded_file|flock)$/i,
  /^(exec|system|shell_exec|passthru|proc_open|popen|pcntl_|eval|assert|create_function|mail|dl)$/i, /^(unserialize|extract|parse_str|putenv|setcookie|session_)/i,
  /^(mysql|mysqli|pg_|sqlite|pdo)/i, /^(fsockopen|socket_|stream_socket_|ftp_|ssh2_)/i, /^(include|require)$/i
];
const FORBIDDEN_MODULES = /issuer|private-key|\.pem$|admin|demo|studio|chest|ledger|trade|mail|moderation|calendar|presence|call-|wallet|holdings|replay|journal|store|catalog|site-features|postoffice|attestation/i;
const FORBIDDEN_STRINGS = /BEGIN (EC |RSA )?PRIVATE KEY|issuer-private|atlas-[a-z-]*-store|admin-keys|ATLAS_ASSET_CATALOG|demo-domain|elements-catalog|site-features/;

function tokens(file) {
  return JSON.parse(execFileSync('php', [TOKENS, file], { encoding: 'utf8' }));
}

function walk(dir, base) {
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const stat = fs.lstatSync(full);
    const rel = base ? base + '/' + name : name;
    if (stat.isDirectory()) out.push(...walk(full, rel));
    else out.push({ rel, full, stat });
  }
  return out;
}

function hostsIn(text) {
  const hosts = new Set();
  for (const m of text.matchAll(/\b(?:https?|ftp|wss?|file|data):\/\/(?:[^\s/'"<>@]*@)?(\[[0-9a-f:]+\]|[A-Za-z0-9._-]+)/gi)) hosts.add(m[1].toLowerCase());
  for (const m of text.matchAll(/\b((?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|app|co|za|me|xyz|info|eu|uk|de|nl|fr|ai|cloud|online|site|tech|page|sh|so))\b/gi)) hosts.add(m[1].toLowerCase());
  return [...hosts];
}

function auditPackage(dir, manifest) {
  const results = [];
  const add = (name, ok, detail) => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail || '') });
  const files = walk(dir, '');
  const names = files.map((f) => f.rel);
  const root = manifest.root;

  add('every path sits under the single root folder ' + root, names.every((n) => n.startsWith(root + '/')), names.filter((n) => !n.startsWith(root + '/')));
  const rels = files.map((f) => ({ ...f, rel: f.rel.slice(root.length + 1) }));
  const relNames = rels.map((f) => f.rel);
  const wanted = new Set(manifest.files.map((f) => f.path).concat(['PACKAGE.json']));
  add('the package contains exactly the manifest files plus PACKAGE.json', relNames.length === wanted.size && relNames.every((n) => wanted.has(n)), { extra: relNames.filter((n) => !wanted.has(n)), missing: [...wanted].filter((n) => !relNames.includes(n)) });
  add('every file name is on the file allowlist', relNames.every((n) => ALLOWED_FILE_NAMES.has(n)), relNames.filter((n) => !ALLOWED_FILE_NAMES.has(n)));
  add('no symbolic links, devices or directories entries beyond plain files', rels.every((f) => f.stat.isFile() && !f.stat.isSymbolicLink()));
  add('no file name matches an issuer, demo or optional-module name', relNames.every((n) => !FORBIDDEN_MODULES.test(n)), relNames.filter((n) => FORBIDDEN_MODULES.test(n)));
  add('no file types other than php, md, json, .htaccess, LICENSE and VERSION (no images, scripts, archives, keys or binaries)', relNames.every((n) => /(^|\/)(\.htaccess|LICENSE|VERSION)$|\.(php|md|json)$/.test(n)));
  add('no nested folder other than lib/', relNames.every((n) => !n.includes('/') || n.startsWith('lib/') && n.split('/').length === 2));
  add('no executable permission bits', rels.every((f) => (f.stat.mode & 0o111) === 0), rels.filter((f) => f.stat.mode & 0o111).map((f) => f.rel));

  // text content: hosts, forbidden strings
  const allHosts = new Map();
  for (const f of rels) {
    const text = fs.readFileSync(f.full, 'utf8');
    for (const h of hostsIn(text)) { if (!allHosts.has(h)) allHosts.set(h, []); allHosts.get(h).push(f.rel); }
    if (f.rel !== 'PACKAGE.json') {
      const hit = FORBIDDEN_STRINGS.exec(text);
      add('no issuer-state, key or demo reference in ' + f.rel, !hit, hit && hit[0]);
    }
  }
  const strayHosts = [...allHosts.keys()].filter((h) => !ALLOWED_HOSTS.has(h) && !/^[a-z0-9-]+\.(php|json|md|js)$/.test(h));
  add('the only hosts named anywhere are placeholders (' + [...ALLOWED_HOSTS].join(', ') + ')', strayHosts.length === 0, strayHosts.map((h) => h + ' in ' + allHosts.get(h).join(',')));

  // PHP structure
  const phpFiles = rels.filter((f) => f.rel.endsWith('.php'));
  add('every PHP file is on the PHP allowlist', phpFiles.every((f) => ALLOWED_PHP_FILES.has(f.rel)));
  const definedEverywhere = new Set();
  const infos = new Map();
  for (const f of phpFiles) { const t = tokens(f.full); infos.set(f.rel, t); t.defined.forEach((d) => definedEverywhere.add(d)); }
  const usedBuiltins = new Map();
  for (const f of phpFiles) {
    const t = infos.get(f.rel);
    const calls = t.calls.filter((c) => !definedEverywhere.has(c));
    const unknown = calls.filter((c) => !(c in ALLOWED_BUILTINS) && !GUARDED_BUILTINS.has(c));
    add('only allowlisted PHP functions are called in ' + f.rel, unknown.length === 0, unknown);
    const wrongExtension = calls.filter((c) => c in ALLOWED_BUILTINS && t.builtin[c] !== undefined && t.builtin[c] !== ALLOWED_BUILTINS[c]);
    add('allowlisted functions come from the expected extensions in ' + f.rel, wrongExtension.length === 0, wrongExtension);
    const forbidden = t.calls.concat(t.defined).filter((c) => FORBIDDEN_CALLS.some((re) => re.test(c)));
    add('no signing, key generation, randomness, file-writing, process or dynamic-code call in ' + f.rel, forbidden.length === 0, forbidden);
    add('no dynamic code constructs in ' + f.rel, t.dynamic.every((d) => (ALLOWED_VARIABLE_CALLS[f.rel] || new Set()).has(d)), t.dynamic);
    add('no syntax or function that needs PHP 8 in ' + f.rel + ' (the package targets PHP 7.4)', t.php8.filter((x) => x !== 'call to http_get_last_response_headers').length === 0, t.php8);
    add('only expected includes in ' + f.rel, t.includes.every((i) => (ALLOWED_INCLUDES[f.rel] || new Set()).has(i)), t.includes);
    add('only expected classes in ' + f.rel, t.classes.every((c) => ALLOWED_CLASSES.has(c)), t.classes);
    for (const c of calls) usedBuiltins.set(c, ALLOWED_BUILTINS[c] || 'php 8.4 (guarded)');
    const stringHits = t.strings.filter((s) => FORBIDDEN_STRINGS.test(s));
    add('no key or issuer-state literal in the strings of ' + f.rel, stringHits.length === 0, stringHits);
  }
  const unusedAllowed = Object.keys(ALLOWED_BUILTINS).filter((name) => !usedBuiltins.has(name));
  add('the function allowlist lists exactly what the package calls (no unused entries)', unusedAllowed.length === 0, unusedAllowed);
  for (const guarded of GUARDED_BUILTINS) {
    const src = phpFiles.map((f) => fs.readFileSync(f.full, 'utf8')).join('\n');
    const re = new RegExp("function_exists\\('" + guarded + "'\\)\\s*\\?\\s*" + guarded);
    add(guarded + ' is only called behind function_exists()', !src.includes(guarded) || re.test(src));
  }
  // include resolution: __DIR__-relative literal includes land on package files
  for (const [file, set] of Object.entries(ALLOWED_INCLUDES)) {
    for (const inc of set) {
      const m = /^__DIR__\.'(\/[^']+)'$/.exec(inc);
      if (!m) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1]));
      add(file + ' includes ' + target + ', which is in the package', relNames.includes(target), target);
    }
  }
  // no function name defined by the package is generic enough to collide: everything lives in one namespace
  for (const f of phpFiles) {
    if (f.rel === 'verify.php' || f.rel === 'config.example.php') continue;
    add(f.rel + ' declares the namespace DomainAtlas\\Verify', /^namespace DomainAtlas\\Verify;$/m.test(fs.readFileSync(f.full, 'utf8')));
  }
  return { results, usedBuiltins: Object.fromEntries([...usedBuiltins.entries()].sort()), hosts: [...allHosts.keys()].sort(), files: relNames };
}

module.exports = { auditPackage, ALLOWED_BUILTINS, tokens };
