#!/usr/bin/env node
// Builds a one-off "site doctor": a single PHP file that, uploaded to a domain's web root, compares the files
// on that domain with this repository and reports what is missing, different or unexpected. It is read-only,
// needs a one-time access token, stops working after a deadline and can delete itself.
//
//   node tools/site-doctor-build.js <out dir> [--hours 72] [--allow-dirty]
//
// Writes <out>/site-doctor.php (upload it; delete it when finished) and <out>/ACCESS.txt (the token; keep it
// off the server). Only a SHA-256 of the token is embedded in the PHP file. Run from a clean checkout so the
// manifest describes committed files; --allow-dirty overrides that.
//
// Manifest: every tracked file of issuer-php/ (tag i), demo-domain-a/ (tag a) and demo-domain-b/ (tag b),
// as paths relative to a web root, with a SHA-256 of the content (text files with CRLF folded to LF, so a
// Windows checkout compares equal) and a group: c code, p page/config, a asset. State is never listed.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { FILES: STUDIO_FILES } = require('./lib/studio-files');

const ROOT = path.resolve(__dirname, '..');
const TEMPLATE = path.join(__dirname, 'site-doctor', 'site-doctor.template.php');
const MARKER = '/*@@DOCTOR_CONFIG@@*/';
const SOURCES = [['issuer-php', 'i'], ['demo-domain-a', 'a'], ['demo-domain-b', 'b']];

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const out = args.find((a, i) => !a.startsWith('--') && (i === 0 || !['--hours'].includes(args[i - 1])));
const hours = Number(opt('--hours', '72'));
if (!out || !(hours > 0 && hours <= 24 * 30)) {
  console.error('usage: node tools/site-doctor-build.js <out dir> [--hours 72] [--allow-dirty]');
  process.exit(2);
}

// Files that only exist as local state or private configuration; never in a manifest even if a fallback
// directory walk finds them (git-tracked lists never contain them).
const STATE = /(^|\/)(atlas-[^/]*\.(json|lock)|[^/]*\.pem|[^/]*-lock-[^/]*|\.salt|replay|holdings|txn|storage-root\.php|private-dir\.php|error_log)(\/|$)/i;
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
  dirty = git('status', '--porcelain', '--', ...SOURCES.map((s) => s[0])).split('\n').filter(Boolean);
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
const isOptional = (rel) => rel === 'README.txt' || rel === 'test-router.php' || rel === 'lib/atlas-cli.php' || rel.startsWith('txlab/')
  || (rel.startsWith('assets/') && !rel.startsWith('assets/studio/'));
// Site-specific by design (each live site's manifest differs from the repository's development one).
const expectDiffers = (rel) => rel === '.well-known/spatial.json';

const entries = new Map(); // path + '\0' + sha -> entry
const sizes = { i: 0, a: 0, b: 0 };
function add(rel, tag, buf) {
  const text = isText(rel, buf);
  const data = text ? Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8') : buf;
  const sha = crypto.createHash('sha256').update(data).digest('hex');
  const key = rel + '\0' + sha;
  const e = entries.get(key);
  if (e) { if (!e.tags.includes(tag)) e.tags += tag; return; }
  entries.set(key, { p: rel, h: sha, n: data.length, g: groupOf(rel), f: (isOptional(rel) ? 'o' : '') + (expectDiffers(rel) ? 'x' : ''), tags: tag });
  sizes[tag] += data.length;
}

let viaGitAll = true;
for (const [dir, tag] of SOURCES) {
  const { files, viaGit } = listFiles(dir);
  viaGitAll = viaGitAll && viaGit;
  for (const rel of files) {
    if (STATE.test(rel)) continue; // defence in depth; tracked lists never include these
    add(rel, tag, fs.readFileSync(path.join(ROOT, dir, rel)));
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

// The access token is shown once and only its hash is embedded.
const rawToken = crypto.randomBytes(16).toString('hex');
const token = rawToken.match(/.{4}/g).join('-');
const expires = Math.floor(Date.now() / 1000) + Math.round(hours * 3600);
const header = { v: 1, built: new Date().toISOString(), commit, clean: gitOk && !dirty.length, expires, tokenSha256: crypto.createHash('sha256').update(rawToken).digest('hex') };
const json = JSON.stringify(header).slice(0, -1) + ',"entries":[\n' + list.map((e) => JSON.stringify([e.p, e.h, e.n, e.g, e.f, e.tags])).join(',\n') + '\n]}';
if (json.includes('ATLAS_DOCTOR_JSON')) { console.error('manifest contains the heredoc marker'); process.exit(1); }

const template = fs.readFileSync(TEMPLATE, 'utf8');
if (template.split(MARKER).length !== 2) { console.error('template must contain the marker exactly once: ' + MARKER); process.exit(1); }
const php = template.replace(MARKER, () => '$DOCTOR = json_decode(<<<\'ATLAS_DOCTOR_JSON\'\n' + json + '\nATLAS_DOCTOR_JSON\n, true);');

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
console.log('site-doctor.php written: ' + list.length + ' manifest entries (issuer ' + count('i') + ', site A ' + count('a') + ', site B ' + count('b') + '), commit ' + commit);
console.log('output: ' + phpFile);
console.log('token:  ' + token);
console.log('valid until ' + until);
