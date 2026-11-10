#!/usr/bin/env node
// Keeps the public demo collection consistent across the two demo domains from one list, site-shared/demos.json.
// Development-time only: the output is plain static HTML, so shared hosting needs no Node, no PHP include and no build step.
//
//   node tools/demo-directory.js           write: copy each shared page from its canonical folder to the other domain's folder,
//                                          regenerate the "Demo directory" section of both home pages and the table in
//                                          docs/demo-collection-deployment.md
//   node tools/demo-directory.js --check   exit 1 if a shared page differs between the domains, a demo is missing from the list,
//                                          a page sits on a domain it does not run on, a link has no target, or a generated
//                                          region is out of date
//
// A demo runs on both domains unless its entry names runsOn. The page is edited only in its canonical folder; the other copy
// is overwritten by this tool and must stay byte-identical. A demo that cannot run on one domain is not copied there: that
// domain's directory links to the page on the domain that runs it, labelled with that domain's name.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CONFIG = path.join(ROOT, 'site-shared', 'demos.json');
const DOC = path.join(ROOT, 'docs', 'demo-collection-deployment.md');
const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const SITES = Object.keys(cfg.sites);
const read = (p) => fs.readFileSync(p, 'utf8');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const runsOn = (d) => d.runsOn || SITES;
const pageOf = (site, d) => path.join(ROOT, site, d.file);

const START = '<!-- atlas-demos:start -->';
const END = '<!-- atlas-demos:end -->';
const DOC_START = '<!-- demo-table:start -->';
const DOC_END = '<!-- demo-table:end -->';

function card(site, d) {
  const here = runsOn(d).includes(site);
  const host = cfg.sites[runsOn(d)[0]].host;
  const href = here ? '/' + d.file : 'https://' + host + '/' + d.file;
  const badges = '<span class="labs-badge">Experimental</span>' + (here ? '' : '<span class="labs-badge labs-cross">On ' + host + '</span>');
  const where = here ? '' : '<span class="labs-where">Opens on ' + host + '. ' + esc(d.reason) + '</span>';
  return '        <li><a class="labs-card" href="' + href + '"' + (here ? '' : ' rel="noopener"') + '><span class="labs-name">' + esc(d.title) + '</span>' +
    badges + '<span class="labs-desc">' + esc(d.summary) + '</span>' + where + '</a></li>';
}

function directory(site) {
  const out = [START,
    '  <section class="labs-dir" aria-labelledby="demosHeading">',
    '    <h2 id="demosHeading">Demo directory</h2>',
    '    <p class="labs-note"><strong>Experimental demos.</strong> Every demo here is a demonstration: its assets, tokens and credentials have no monetary value and no promise of redemption. A demo marked with a domain name opens on that domain, because it cannot run safely on this one.</p>'];
  for (const g of cfg.groups) {
    const items = cfg.demos.filter((d) => d.group === g.id);
    if (!items.length) continue;
    out.push('    <h3>' + esc(g.title) + '</h3>', '    <ul class="labs-grid">', ...items.map((d) => card(site, d)), '    </ul>');
  }
  out.push('  </section>', END);
  return out.join('\n');
}

// The directory goes straight after the Explore the Labs section.
function withDirectory(html, site) {
  const block = directory(site);
  const s = html.indexOf(START), e = html.indexOf(END);
  if (s >= 0 && e > s) return html.slice(0, s).replace(/[ \t]*$/, '') + block + html.slice(e + END.length);
  const labs = html.indexOf('<section class="labs"');
  const close = labs < 0 ? -1 : html.indexOf('</section>', labs);
  if (close < 0) throw new Error(site + '/index.html has no Explore the Labs section to follow');
  const at = close + '</section>'.length;
  return html.slice(0, at) + '\n\n' + block + html.slice(at);
}

function table() {
  const label = (d, site) => runsOn(d).includes(site) ? 'Page `' + d.file + '`' : 'Link only, to ' + cfg.sites[runsOn(d)[0]].host;
  const rows = ['| Demo | Backend (under `issuer-php/`) | ' + SITES.map((s) => cfg.sites[s].host).join(' | ') + ' | Extra configuration |',
    '| --- | --- | ' + SITES.map(() => '---').join(' | ') + ' | --- |'];
  for (const d of cfg.demos) {
    const backend = d.backend.length ? d.backend.map((b) => '`' + b + '`').join(', ') : 'none (static page)';
    rows.push('| ' + d.title + ' | ' + backend + ' | ' + SITES.map((s) => label(d, s)).join(' | ') + ' | ' + d.needs + (d.reason ? ' ' + d.reason : '') + ' |');
  }
  return DOC_START + '\n' + rows.join('\n') + '\n' + DOC_END;
}
function withTable(md) {
  const s = md.indexOf(DOC_START), e = md.indexOf(DOC_END);
  if (s < 0 || e < s) throw new Error('docs/demo-collection-deployment.md has no demo-table region');
  return md.slice(0, s) + table() + md.slice(e + DOC_END.length);
}

const write = process.argv.includes('--write') || !process.argv.includes('--check');
const problems = [];
const fail = (m) => problems.push(m);

// Pages
for (const d of cfg.demos) {
  const canonical = d.canonical;
  if (!runsOn(d).includes(canonical)) { fail(d.file + ': canonical folder ' + canonical + ' is not one of the domains it runs on'); continue; }
  if (!fs.existsSync(pageOf(canonical, d))) { fail(d.file + ': missing from ' + canonical); continue; }
  const source = fs.readFileSync(pageOf(canonical, d));
  for (const site of SITES) {
    const target = pageOf(site, d);
    if (!runsOn(d).includes(site)) { if (fs.existsSync(target)) fail(d.file + ': is in ' + site + ' but does not run on that domain (remove it, or add it to runsOn)'); continue; }
    if (site === canonical) continue;
    if (fs.existsSync(target) && fs.readFileSync(target).equals(source)) continue;
    if (write) fs.writeFileSync(target, source); else fail(d.file + ': ' + site + ' copy differs from ' + canonical + ' (run node tools/demo-directory.js)');
  }
}

// A page in a domain's root that no entry accounts for would be an unlisted demo
for (const site of SITES) {
  for (const f of fs.readdirSync(path.join(ROOT, site)).filter((n) => /\.html$/.test(n) && n !== 'index.html')) {
    if (!cfg.demos.some((d) => d.file === f && runsOn(d).includes(site))) fail(site + '/' + f + ': not listed in site-shared/demos.json');
  }
}

// Home pages and the deployment table
for (const site of SITES) {
  const file = path.join(ROOT, site, 'index.html');
  const html = read(file);
  const next = withDirectory(html, site);
  if (next !== html) { if (write) fs.writeFileSync(file, next); else fail(site + '/index.html: demo directory is out of date (run node tools/demo-directory.js)'); }
  for (const d of cfg.demos.filter((x) => runsOn(x).includes(site))) {
    if (!fs.existsSync(pageOf(site, d))) fail(site + '/index.html links /' + d.file + ' but ' + site + ' has no such page');
  }
}
if (fs.existsSync(DOC)) {
  const md = read(DOC), next = withTable(md);
  if (next !== md) { if (write) fs.writeFileSync(DOC, next); else fail('docs/demo-collection-deployment.md: demo table is out of date (run node tools/demo-directory.js)'); }
}

if (problems.length) { for (const p of problems) console.log('FAIL ' + p); process.exit(1); }
console.log(write ? 'demo pages, directories and table are up to date' : 'demo collection consistent: ' + cfg.demos.length + ' demos, ' + SITES.length + ' domains');
