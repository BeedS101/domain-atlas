// Checks the imported chain-labs folder: PHP unchanged from the deployed source, syntax valid, endpoints referenced by
// the pages exist, and no private material or decorative leftovers in the folder.
//
//   node test/chain-labs-import.js
'use strict';
const { execFileSync, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const DIR = path.join(__dirname, '..', 'chain-labs');
let failures = 0;
let total = 0;
function line(ok, text, detail) {
  total++;
  if (!ok) failures++;
  console.log((ok ? 'PASS ' : 'FAIL ') + text + (!ok && detail !== undefined ? ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300) : ''));
}
const files = fs.readdirSync(DIR);
const php = files.filter((f) => f.endsWith('.php')).sort();
const html = files.filter((f) => f.endsWith('.html')).sort();
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');

console.log('\n== source integrity');
const manifest = {};
for (const l of read('SOURCE.sha256').split('\n')) { const m = /^([a-f0-9]{64}) [ *](.+)$/.exec(l); if (m) manifest[m[2]] = m[1]; }
line(php.every((f) => manifest[f]) && html.every((f) => manifest[f]), 'every PHP and HTML file has a line in SOURCE.sha256', files.filter((f) => /\.(php|html)$/.test(f) && !manifest[f]));
const changedPhp = php.filter((f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(DIR, f))).digest('hex') !== manifest[f]);
line(changedPhp.length === 0, php.length + ' PHP files match the deployed source byte for byte', changedPhp);

console.log('\n== php syntax and shape');
for (const f of php) {
  let ok = true, out = '';
  try { out = execFileSync('php', ['-l', path.join(DIR, f)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { ok = false; out = String(e.stdout || e.message); }
  line(ok && /^<\?php/.test(read(f)) && /declare\(strict_types=1\)/.test(read(f)), f + ': lints, opens with <?php, strict types');
}

console.log('\n== pages');
const targets = new Set();
for (const f of html) {
  const s = read(f);
  for (const m of s.matchAll(/fetch\(\s*['"]\.\/([a-z0-9]+\.php)/g)) targets.add(m[1]);
  for (const m of s.matchAll(/href="\.\/([a-z0-9-]+\.html)"/g)) targets.add(m[1]);
  line((s.match(/<script\b/g) || []).length === (s.match(/<\/script>/g) || []).length, f + ': script tags balanced');
}
const missing = [...targets].filter((t) => !files.includes(t));
line(targets.size > 0 && missing.length === 0, 'every endpoint and page the pages call exists in the folder (' + targets.size + ' referenced)', missing);
const leftovers = [];
for (const f of html.concat(php)) {
  const s = read(f);
  if (/[\u{1F300}-\u{1FAFF}]/u.test(s) || /gopher|burrow|basement/i.test(s)) leftovers.push(f);
}
line(leftovers.length === 0, 'no emoji, mascot or joke text in any page or endpoint', leftovers);

console.log('\n== no private material in the folder');
const stray = files.filter((f) => !/\.(php|html|md|sha256)$/.test(f));
line(stray.length === 0, 'only PHP, HTML, README and the hash list are present', stray);
const secret = files.filter((f) => /BEGIN (EC |RSA )?PRIVATE KEY|"d"\s*:\s*"[A-Za-z0-9_-]{40,}"/.test(read(f)));
line(secret.length === 0, 'no private key material in any file', secret);

console.log('\n== endpoints refuse plain HTTP without side effects');
async function smoke() {
  const work = fs.mkdtempSync(path.join(require('os').tmpdir(), 'chain-labs-smoke-'));
  const root = path.join(work, 'public');
  fs.mkdirSync(root);
  for (const f of php) fs.copyFileSync(path.join(DIR, f), path.join(root, f));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = spawn('php', ['-S', '127.0.0.1:' + port, '-t', root], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 800));
  const get = (p) => new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: p, headers: { host: 'example.test' } }, (res) => {
    let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] || '', body: b }));
  }).on('error', () => resolve({ status: 0, type: '', body: '' })));
  try {
    for (const f of php.filter((x) => !/^(verify|market-login28)\.php$/.test(x))) {
      const r = await get('/' + f + '?action=list');
      let j = null; try { j = JSON.parse(r.body); } catch (e) { /* not json */ }
      line(r.status >= 400 && r.status < 500 && /json/.test(r.type) && j && j.ok === false, f + ': plain HTTP on an unknown host gets a JSON refusal (' + r.status + ')', r);
    }
    const leaked = fs.readdirSync(work).concat(fs.readdirSync(root)).filter((n) => /sqlite|\.db$/.test(n));
    line(leaked.length === 0 && fs.readdirSync(work).length === 1, 'no database or private folder was created by those requests', leaked);
  } finally {
    server.kill();
    fs.rmSync(work, { recursive: true, force: true });
  }
}
smoke().then(() => {
  console.log('\n' + (failures === 0 ? 'ALL ' + total + ' CHAIN-LABS CHECKS PASSED' : failures + ' of ' + total + ' checks FAILED'));
  process.exit(failures === 0 ? 0 : 1);
});
