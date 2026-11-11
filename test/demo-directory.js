// tools/demo-directory.js: the demo collection on both domains is kept consistent from site-shared/demos.json.
//   node test/demo-directory.js
// The repository itself must pass --check. Then, in a throw-away copy of the pieces the tool reads, each way the collection can drift
// (a copy edited on one domain, a demo page on a domain it does not run on, an unlisted page, a stale directory) must be reported,
// and a plain run must repair what it can.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'site-shared', 'demos.json'), 'utf8'));
const SITES = Object.keys(cfg.sites);
let failures = 0, total = 0;
const line = (ok, text, detail) => { total++; if (!ok) failures++; console.log((ok ? 'PASS ' : 'FAIL ') + text + (!ok && detail !== undefined ? ' :: ' + String(detail).slice(0, 300) : '')); };
const run = (root, args) => spawnSync('node', [path.join(root, 'tools', 'demo-directory.js'), ...args], { encoding: 'utf8' });

line(run(REPO, ['--check']).status === 0, 'the repository passes --check', run(REPO, ['--check']).stdout);

// the list itself
const files = cfg.demos.map((d) => d.file);
line(new Set(files).size === files.length, 'no demo is listed twice');
line(cfg.demos.every((d) => cfg.groups.some((g) => g.id === d.group)), 'every demo is in a known group');
line(cfg.demos.every((d) => (d.runsOn || SITES).includes(d.canonical)), 'every demo is canonical on a domain it runs on');
line(cfg.demos.filter((d) => d.runsOn && d.runsOn.length < SITES.length).every((d) => typeof d.reason === 'string' && d.reason.length > 20), 'every demo that does not run on both domains says why');
line(cfg.demos.every((d) => d.summary && d.title && Array.isArray(d.backend) && d.needs), 'every demo has a title, a summary, its backend routes and its needs');
line(cfg.demos.every((d) => d.backend.every((b) => { const base = b.replace(/\/?\*$/, ''); return fs.existsSync(path.join(REPO, 'issuer-php', base + '.php')) || fs.existsSync(path.join(REPO, 'issuer-php', base)) || fs.existsSync(path.join(REPO, 'issuer-php', base, 'index.php')); })), 'every backend route a demo names exists in issuer-php');

// drift, in a throw-away copy
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-dir-'));
const copy = (rel) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.copyFileSync(path.join(REPO, rel), path.join(root, rel)); };
copy('tools/demo-directory.js'); copy('site-shared/demos.json'); copy('docs/demo-collection-deployment.md');
for (const s of SITES) for (const f of fs.readdirSync(path.join(REPO, s)).filter((n) => /\.html$/.test(n))) copy(s + '/' + f);
const fresh = () => { for (const s of SITES) for (const f of fs.readdirSync(path.join(REPO, s)).filter((n) => /\.html$/.test(n))) copy(s + '/' + f); copy('docs/demo-collection-deployment.md'); for (const s of SITES) for (const f of fs.readdirSync(path.join(root, s))) if (!fs.existsSync(path.join(REPO, s, f))) fs.rmSync(path.join(root, s, f)); };
const both = cfg.demos.find((d) => !d.runsOn && d.canonical === SITES[0]);
const aOnly = cfg.demos.find((d) => d.runsOn && d.runsOn.length === 1 && d.runsOn[0] === SITES[0]);
const bOnly = cfg.demos.find((d) => d.runsOn && d.runsOn.length === 1 && d.runsOn[0] === SITES[1]);

line(run(root, ['--check']).status === 0, 'the copy starts consistent');

fs.appendFileSync(path.join(root, SITES[1], both.file), '\n<!-- edited on one domain -->\n');
let r = run(root, ['--check']);
line(r.status === 1 && r.stdout.includes(both.file + ': ' + SITES[1] + ' copy differs'), 'a shared page edited on one domain is reported', r.stdout);
r = run(root, []);
line(r.status === 0 && run(root, ['--check']).status === 0 && fs.readFileSync(path.join(root, SITES[1], both.file)).equals(fs.readFileSync(path.join(root, SITES[0], both.file))), 'a plain run restores the copy from the canonical page');
fresh();

fs.copyFileSync(path.join(root, SITES[1], bOnly.file), path.join(root, SITES[0], bOnly.file));
r = run(root, ['--check']);
line(r.status === 1 && r.stdout.includes(bOnly.file + ': is in ' + SITES[0] + ' but does not run on that domain'), 'a page placed on a domain it does not run on is reported', r.stdout);
fresh();

fs.writeFileSync(path.join(root, SITES[1], 'surprise-demo.html'), '<!doctype html><title>x</title>');
r = run(root, ['--check']);
line(r.status === 1 && r.stdout.includes('surprise-demo.html: not listed'), 'an unlisted page is reported', r.stdout);
fresh();

const idx = path.join(root, SITES[0], 'index.html');
fs.writeFileSync(idx, fs.readFileSync(idx, 'utf8').replace('<h2 id="demosHeading">Demo directory</h2>', '<h2 id="demosHeading">Demos</h2>'));
r = run(root, ['--check']);
line(r.status === 1 && r.stdout.includes('demo directory is out of date'), 'a stale directory is reported', r.stdout);
r = run(root, []);
line(r.status === 0 && run(root, ['--check']).status === 0, 'a plain run regenerates the directory');
fresh();

fs.rmSync(path.join(root, SITES[0], aOnly.file));
r = run(root, ['--check']);
line(r.status === 1 && r.stdout.includes(aOnly.file), 'a demo page missing from the domain that runs it is reported', r.stdout);
fresh();

fs.writeFileSync(path.join(root, 'docs', 'demo-collection-deployment.md'), fs.readFileSync(path.join(root, 'docs', 'demo-collection-deployment.md'), 'utf8').replace(/\| ---/, '| xxx'));
r = run(root, ['--check']);
line(r.status === 1 && r.stdout.includes('demo table is out of date'), 'a stale table in the deployment guide is reported', r.stdout);

// what each home page links, read from the real pages
for (const s of SITES) {
  const html = fs.readFileSync(path.join(REPO, s, 'index.html'), 'utf8');
  const region = html.slice(html.indexOf('<!-- atlas-demos:start -->'), html.indexOf('<!-- atlas-demos:end -->'));
  const hrefs = [...region.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  const other = cfg.sites[SITES.find((x) => x !== s)].host;
  const expected = cfg.demos.map((d) => (d.runsOn || SITES).includes(s) ? '/' + d.file : 'https://' + cfg.sites[(d.runsOn || SITES)[0]].host + '/' + d.file);
  line(JSON.stringify(hrefs) === JSON.stringify(cfg.groups.flatMap((g) => cfg.demos.filter((d) => d.group === g.id).map((d) => expected[cfg.demos.indexOf(d)]))), s + ' home page links each demo to this domain, or to the domain that runs it', hrefs);
  const once = cfg.demos.filter((d) => (html.match(new RegExp('href="[^"]*/' + d.file.replace(/[.]/g, '[.]') + '"', 'g')) || []).length !== 1);
  line(once.length === 0, s + ' home page links each demo exactly once (no second list beside the directory)', once.map((d) => d.file));
  line(hrefs.filter((h) => h.startsWith('http')).every((h) => h.startsWith('https://' + other + '/')), s + ' home page has no external link except to ' + other);
}

fs.rmSync(root, { recursive: true, force: true });
console.log('\n' + (failures === 0 ? 'ALL ' + total + ' DEMO DIRECTORY CHECKS PASSED' : failures + ' of ' + total + ' checks FAILED'));
process.exit(failures === 0 ? 0 : 1);
