#!/usr/bin/env node
// Builds a one-off "site doctor": a single PHP file that, uploaded to a domain's web root, compares the files
// on that domain with this repository and reports what is missing, different or unexpected. It is read-only,
// needs a one-time access token, stops working after a deadline and can delete itself.
//
//   node tools/site-doctor-build.js <out dir> [--hours 72] [--allow-dirty] [--trusted-groups name,name]
//
// Writes <out>/site-doctor.php (upload it; delete it when finished) and <out>/ACCESS.txt (the token; keep it
// off the server). Only a SHA-256 of the token is embedded in the PHP file. Run from a clean checkout so the
// manifest describes committed files; --allow-dirty overrides that.
//
// Manifest: every tracked file of the deployable folders listed in tools/site-doctor/components.json (issuer-php/,
// the two demo sites, the Call, Presence and directory services, Chain Labs and the verifier), as paths relative to a
// web root, with a SHA-256 of the content (text files with CRLF folded to LF, so a Windows checkout compares equal),
// a group (c code, p page/config, a asset) and the component the file belongs to. A component is a part a domain may
// or may not install: the doctor expects all of its files once any of them is there. State is never listed.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { FILES: STUDIO_FILES } = require('./lib/studio-files');

const ROOT = path.resolve(__dirname, '..');
const TEMPLATE = path.join(__dirname, 'site-doctor', 'site-doctor.template.php');
const FEATURES = path.join(ROOT, 'issuer-php', 'lib', 'site-features.json');
const FEATURE_READERS = path.join(ROOT, 'issuer-php', 'lib', 'site-features.php');
const FEATURE_TYPES = ['studio-config', 'json-enabled', 'email-tickets', 'manifest-field', 'moderation-issuer', 'presence-moderation', 'private-config-php', 'rename', 'private-dir-txt'];
const MARKER = '/*@@DOCTOR_CONFIG@@*/';
const READERS_MARKER = '/*@@SITE_FEATURES@@*/';
const REGISTRY = JSON.parse(fs.readFileSync(path.join(__dirname, 'site-doctor', 'components.json'), 'utf8'));
const SOURCES = REGISTRY.sources.map((s) => [s.dir, s.tag, s.mount || '']);
const COMPONENTS = REGISTRY.components;

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const out = args.find((a, i) => !a.startsWith('--') && (i === 0 || !['--hours', '--trusted-groups'].includes(args[i - 1])));
const hours = Number(opt('--hours', '72'));
// Groups (names or numeric ids) whose write access to sensitive files the permission checks accept without a
// warning. The account's own group and the PHP process's group are always accepted.
const trustedGroups = opt('--trusted-groups', '').split(',').map((g) => g.trim()).filter(Boolean);
if (trustedGroups.length > 16 || trustedGroups.some((g) => !/^[A-Za-z0-9._-]{1,64}$/.test(g))) {
  console.error('--trusted-groups takes up to 16 group names or numeric ids, letters, digits, dot, dash and underscore only');
  process.exit(2);
}
if (!out || !(hours > 0 && hours <= 24 * 30)) {
  console.error('usage: node tools/site-doctor-build.js <out dir> [--hours 72] [--allow-dirty] [--trusted-groups name,name]');
  process.exit(2);
}

// Files that only exist as local state or private configuration; never in a manifest even if a fallback
// directory walk finds them (git-tracked lists never contain them).
const STATE = /(^|\/)(atlas-[^/]*\.(json|lock)|[^/]*\.pem|[^/]*-lock-[^/]*|\.salt|replay|holdings|txn|state|storage-root\.php|private-dir\.php|lib\/config\.php(\.off|\.bak)?|error_log)(\/|$)/i;
const TEXT_EXT = new Set(['php', 'html', 'htm', 'js', 'css', 'json', 'md', 'txt', 'svg', 'xml', 'example']);
const isTextName = (rel) => /(^|\/)\.htaccess$/.test(rel) || TEXT_EXT.has(path.extname(rel).slice(1).toLowerCase());
const isText = (rel, buf) => isTextName(rel) && !buf.subarray(0, 8000).includes(0);

function git(...a) { return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }

function listFiles(dir) {
  try {
    const z = execFileSync('git', ['ls-files', '-z', '--', dir], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { files: z.split('\0').filter(Boolean).map((f) => f.slice(dir.length + 1)), viaGit: true };
  } catch (e) {
    const files = [];
    (function walk(d, rel) {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const r = rel ? rel + '/' + ent.name : ent.name;
        if (ent.name === '.git' || ent.name === 'node_modules' || ent.isSymbolicLink()) continue;
        if (ent.isDirectory()) walk(path.join(d, ent.name), r); else if (!STATE.test(r)) files.push(r);
      }
    })(path.join(ROOT, dir), '');
    return { files, viaGit: false };
  }
}

let commit = 'unknown', dirty = [];
let gitOk = true;
try {
  commit = git('rev-parse', '--short=12', 'HEAD').trim();
  dirty = git('status', '--porcelain', '--', ...SOURCES.map((s) => s[0]), 'tools/site-doctor').split('\n').filter(Boolean);
} catch (e) { gitOk = false; }
if (!gitOk) console.warn('note: git is not available here; the manifest is built from the working tree and cannot be checked against a commit.');
else if (dirty.length && !flag('--allow-dirty')) {
  console.error('The working tree has uncommitted changes in issuer-php/ or the demo folders; the manifest would not match a commit:');
  dirty.slice(0, 10).forEach((l) => console.error('  ' + l));
  console.error('Commit or discard them, or pass --allow-dirty.');
  process.exit(1);
}

// Group: c code (a wrong or missing file breaks the issuer), p page or configuration, a asset.
const groupOf = (rel) => (/(^|\/)\.htaccess$/.test(rel) || /\.(php|example)$/.test(rel) ? 'c' : (rel.startsWith('assets/') || /\.(glb|png|jpg|jpeg|gif|ico|woff2?)$/i.test(rel) ? 'a' : 'p'));
// Present on a typical deployment only sometimes: absence is not a problem.
const isOptional = (rel) => rel === 'README.txt' || rel === 'test-router.php' || rel === 'chain-labs/README.md' || rel === 'chain-labs/SOURCE.sha256' || rel === 'atlas-verify/README.md' || rel === 'lib/atlas-cli.php' || rel.startsWith('txlab/') || rel.startsWith('tools/') || /\.example$/.test(rel)
  || (rel.startsWith('assets/') && !rel.startsWith('assets/studio/'));
// Site-specific by design (each live site's manifest differs from the repository's development one).
const expectDiffers = (rel) => rel === '.well-known/spatial.json';

// The component a file belongs to. Issuer files are split by folder; the other sources are one component each; the demo
// sites' own pages are 'site'.
const bySource = new Map(COMPONENTS.filter((c) => c.source && c.source !== 'i').map((c) => [c.source, c.id]));
const issuerParts = COMPONENTS.filter((c) => c.source === 'i');
function componentOf(rel, tag) {
  if (tag === 'i') {
    const part = issuerParts.find((c) => c.prefixes.some((p) => rel.startsWith(p)));
    return part ? part.id : 'core';
  }
  return bySource.get(tag) || 'site';
}

const entries = new Map(); // path + '\0' + sha -> entry
const sizes = {};
function add(rel, tag, buf) {
  const text = isText(rel, buf);
  const data = text ? Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8') : buf;
  const sha = crypto.createHash('sha256').update(data).digest('hex');
  const key = rel + '\0' + sha;
  const e = entries.get(key);
  if (e) { if (!e.tags.includes(tag)) e.tags += tag; if (tag === 'i') e.c = componentOf(rel, 'i'); return; }
  entries.set(key, { p: rel, h: sha, n: data.length, g: groupOf(rel), f: (isOptional(rel) ? 'o' : '') + (expectDiffers(rel) ? 'x' : ''), tags: tag, c: componentOf(rel, tag) });
  sizes[tag] = (sizes[tag] || 0) + data.length;
}

let viaGitAll = true;
for (const [dir, tag, mount] of SOURCES) {
  const { files, viaGit } = listFiles(dir);
  viaGitAll = viaGitAll && viaGit;
  for (const rel of files) {
    if (STATE.test(rel)) continue; // defence in depth; tracked lists never include these
    if (rel === 'README.txt' || rel === 'test-router.php') continue; // per-source documentation and a local test helper: several sources share the name, and none of it runs on a site
    add(mount + rel, tag, fs.readFileSync(path.join(ROOT, dir, rel)));
  }
}
// Studio's own models are needed on every issuer domain, whichever demo site it serves.
for (const [src, dest] of STUDIO_FILES) {
  if (!dest.startsWith('assets/studio/')) continue;
  add(dest, 'i', fs.readFileSync(path.join(ROOT, src)));
}
if (!viaGitAll) console.warn('note: git ls-files was not available; every file under issuer-php/ and the demo folders (apart from state-like names) was included.');

const list = Array.from(entries.values()).sort((x, y) => (x.p < y.p ? -1 : x.p > y.p ? 1 : (x.tags < y.tags ? -1 : 1)));
if (!list.some((e) => e.p === 'atlas/studio/inc/studio-mint.php')) { console.error('internal check failed: studio-mint.php is not in the manifest'); process.exit(1); }

// Feature switches (read-only reports): validated here so a typo cannot ship in a built file.
const features = JSON.parse(fs.readFileSync(FEATURES, 'utf8')).features;
{
  const ids = new Set();
  for (const f of features) {
    if (!/^[a-z0-9-]+$/.test(f.id) || ids.has(f.id)) { console.error('bad or duplicate feature id: ' + f.id); process.exit(1); }
    ids.add(f.id);
    if (!FEATURE_TYPES.includes(f.type)) { console.error('unknown feature type for ' + f.id + ': ' + f.type); process.exit(1); }
    if (typeof f.label !== 'string' || !Array.isArray(f.needs) || typeof f.enable !== 'string' || typeof f.disable !== 'string') { console.error('incomplete feature: ' + f.id); process.exit(1); }
  }
}

// The component registry: validated here so a typo cannot ship in a built file.
{
  const ids = new Set(); const codes = new Set();
  for (const c of COMPONENTS) {
    if (!/^[a-z0-9-]+$/.test(c.id) || ids.has(c.id)) { console.error('bad or duplicate component id: ' + c.id); process.exit(1); }
    ids.add(c.id);
    if (c.kind === 'optional') {
      if (!/^[a-z]$/.test(c.code || '') || codes.has(c.code)) { console.error('bad or duplicate component code: ' + c.id); process.exit(1); }
      codes.add(c.code);
      if (!c.source || !SOURCES.some((s) => s[1] === c.source)) { console.error('component has no known source: ' + c.id); process.exit(1); }
      if (c.source === 'i' && !(Array.isArray(c.prefixes) && c.prefixes.length)) { console.error('issuer component needs prefixes: ' + c.id); process.exit(1); }
      if (!list.some((e) => e.c === c.id)) { console.error('component has no files in the manifest: ' + c.id); process.exit(1); }
    }
  }
}

// The access token is shown once and only its hash is embedded.
const rawToken = crypto.randomBytes(16).toString('hex');
const token = rawToken.match(/.{4}/g).join('-');
const expires = Math.floor(Date.now() / 1000) + Math.round(hours * 3600);
const publicComponents = COMPONENTS.map((c) => ({ id: c.id, label: c.label, kind: c.kind, code: c.code || '', source: c.source || '', advertisedBy: c.advertisedBy || [], stores: c.stores || [], findMount: c.findMount || null,
  mount: (SOURCES.find((s) => s[1] === c.source) || [0, 0, ''])[2] }));
const header = { v: 2, components: publicComponents, built: new Date().toISOString(), commit, clean: gitOk && !dirty.length, expires, tokenSha256: crypto.createHash('sha256').update(rawToken).digest('hex'), features, trustedGroups };
const json = JSON.stringify(header).slice(0, -1) + ',"entries":[\n' + list.map((e) => JSON.stringify([e.p, e.h, e.n, e.g, e.f, e.tags, e.c])).join(',\n') + '\n]}';
if (json.includes('ATLAS_DOCTOR_JSON')) { console.error('manifest contains the heredoc marker'); process.exit(1); }

const template = fs.readFileSync(TEMPLATE, 'utf8');
if (template.split(MARKER).length !== 2) { console.error('template must contain the marker exactly once: ' + MARKER); process.exit(1); }
if (template.split(READERS_MARKER).length !== 2) { console.error('template must contain the marker exactly once: ' + READERS_MARKER); process.exit(1); }
// The feature readers are the issuer's own library, spliced in so the doctor and the admin panel cannot disagree.
const readers = fs.readFileSync(FEATURE_READERS, 'utf8');
if (!readers.startsWith('<?php\n') || readers.includes('?>') || readers.includes('ATLAS_DOCTOR')) { console.error('lib/site-features.php must be one plain PHP block'); process.exit(1); }
const php = template.replace(MARKER, () => '$DOCTOR = json_decode(<<<\'ATLAS_DOCTOR_JSON\'\n' + json + '\nATLAS_DOCTOR_JSON\n, true);').replace(READERS_MARKER, () => readers.slice('<?php\n'.length));

fs.mkdirSync(path.resolve(out), { recursive: true });
const phpFile = path.join(path.resolve(out), 'site-doctor.php');
fs.writeFileSync(phpFile, php);
const until = new Date(expires * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
fs.writeFileSync(path.join(path.resolve(out), 'ACCESS.txt'), [
  'Site doctor access (keep this file OFF the server)',
  '',
  'Token:    ' + token,
  'Expires:  ' + until + '  (the page refuses to run after this; it can still delete itself)',
  'Built from commit ' + commit + (header.clean ? '' : ' (working tree was not clean)'),
  '',
  '1. Upload site-doctor.php into the web root of the domain you want to check (the folder that holds atlas/ and lib/).',
  '2. Open https://YOUR-DOMAIN/site-doctor.php and paste the token.',
  '3. Read the report. Nothing on the site is changed.',
  '4. Press "Delete this file" on the page, or delete site-doctor.php yourself. Do not leave it on the server.',
  '',
].join('\r\n'));

const count = (t) => list.filter((e) => e.tags.includes(t)).length;
console.log('site-doctor.php written: ' + list.length + ' manifest entries (' + SOURCES.map((s) => s[0] + ' ' + count(s[1])).join(', ') + '), commit ' + commit);
console.log('output: ' + phpFile);
console.log('token:  ' + token);
console.log('valid until ' + until);
