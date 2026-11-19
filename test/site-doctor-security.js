// Site doctor, "Issuer Security & Deployment Health": the security files against the repository (matching, modified,
// outdated, missing, an optional part that is not installed), the domain pin against the issuer's own
// atlas_configured_domain(), the owner-proof classes, the outbound limiter (installed, wired, configured, ready, seen in
// use) and visitor-address handling; and that none of it writes anything or shows an address, a hash, a key or a record.
// Served by PHP's built-in server over temporary document roots.
//   node test/site-doctor-security.js
'use strict';
const { execFileSync, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const assert = require('assert');

const REPO = path.resolve(__dirname, '..');
let failures = 0;
const check = (name, fn) => Promise.resolve().then(fn).then(() => console.log('ok   ' + name), (e) => { failures++; console.log('FAIL ' + name + '\n     ' + String(e.stack || e.message).split('\n').slice(0, 6).join('\n     ')); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-security-'));
const servers = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const everything = []; // every response body any step saw, searched for planted secrets at the end

const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on('error', reject); });
const tracked = (dir) => execFileSync('git', ['ls-files', '-z', '--', dir], { cwd: REPO, encoding: 'utf8' }).split('\0').filter(Boolean).map((f) => f.slice(dir.length + 1));
const historic = (commit, file) => execFileSync('git', ['show', commit + ':' + file], { cwd: REPO, encoding: 'utf8' });

// Addresses and identifiers that must never come back from the doctor.
const ADDR_PUBLIC = '203.0.113.77';
const ADDR_OTHER = '198.51.100.9';
const ADDR_PRIVATE = '10.1.2.3';
const h16 = (a) => crypto.createHash('sha256').update(a).digest('hex').slice(0, 16);
const PLANTED_ID_1 = 'aaaaaaaaaaaaaaaa';
const PLANTED_ID_2 = 'bbbbbbbbbbbbbbbb';
const SECRETS = [ADDR_PUBLIC, ADDR_OTHER, ADDR_PRIVATE, h16(ADDR_PUBLIC), h16(ADDR_OTHER), h16(ADDR_PRIVATE), h16('127.0.0.1'), PLANTED_ID_1, PLANTED_ID_2, 'PEM-SECRET-MARKER', 'WALLET-ID-MARKER', 'RECORD-MARKER'];

// A document root as an upload would produce it: the issuer, with its optional parts.
let baseRoot;
function makeBase() {
  baseRoot = path.join(tmp, 'base');
  for (const rel of tracked('issuer-php')) {
    const dest = path.join(baseRoot, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(REPO, 'issuer-php', rel), dest);
  }
}
let n = 0;
function layout() {
  const root = path.join(tmp, 'root-' + (n++));
  fs.cpSync(baseRoot, root, { recursive: true });
  fs.copyFileSync(doctorPhp, path.join(root, 'site-doctor.php'));
  fs.writeFileSync(path.join(root, 'prepend.php'),
    '<?php if (isset($_SERVER["HTTP_X_TEST_REMOTE"])) { if ($_SERVER["HTTP_X_TEST_REMOTE"] === "none") unset($_SERVER["REMOTE_ADDR"]); else $_SERVER["REMOTE_ADDR"] = $_SERVER["HTTP_X_TEST_REMOTE"]; }');
  return root;
}
const put = (root, rel, text) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };

let doctorPhp, token;
function build() {
  const out = fs.mkdtempSync(path.join(tmp, 'build-'));
  execFileSync('node', [path.join(REPO, 'tools/site-doctor-build.js'), out, '--allow-dirty'], { encoding: 'utf8' });
  token = fs.readFileSync(path.join(out, 'ACCESS.txt'), 'utf8').match(/Token:\s+([0-9a-f-]{39})/)[1];
  doctorPhp = path.join(out, 'site-doctor.php');
}

// Runs fn(api) against a PHP server over root. env adds environment variables (ATLAS_* from the parent are removed).
async function withServer(root, env, fn) {
  const port = await freePort();
  const clean = {};
  for (const k of Object.keys(process.env)) if (!/^ATLAS_/.test(k)) clean[k] = process.env[k];
  const child = spawn('php', ['-d', 'auto_prepend_file=' + path.join(root, 'prepend.php'), '-S', '127.0.0.1:' + port, '-t', root], { stdio: 'ignore', env: Object.assign(clean, env || {}) });
  servers.push(child);
  for (let i = 0; i < 100; i++) {
    if (await new Promise((r) => { const s = net.connect(port, '127.0.0.1', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); })) break;
    await sleep(50);
  }
  const base = 'http://127.0.0.1:' + port;
  const api = {
    base, host: '127.0.0.1:' + port, port,
    async call(action, extra, headers, tok) {
      const r = await fetch(base + '/site-doctor.php', { method: 'POST', headers: headers || {}, body: new URLSearchParams(Object.assign({ action, token: tok === undefined ? token : tok }, extra || {})) });
      const text = await r.text();
      everything.push(text);
      let json = null; try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
      return { status: r.status, json, text };
    },
    async security(extra, headers) {
      const r = await api.call('security', extra, headers);
      assert.strictEqual(r.status, 200, 'security answered ' + r.status + ': ' + r.text.slice(0, 200));
      assert.ok(r.json && r.json.ok, 'security ok');
      const g = {};
      for (const x of r.json.groups) g[x.id] = x;
      return { raw: r.json, g };
    }
  };
  try { return await fn(api); } finally { child.kill(); }
}

const rowFor = (group, startsWith) => {
  const r = group.rows.find((x) => x.title.startsWith(startsWith));
  assert.ok(r, 'no row starting "' + startsWith + '" in: ' + group.rows.map((x) => x.title).join(' | '));
  return r;
};

const FILES = ['lib/outbound.php', 'lib/bootstrap.php', 'atlas/world/drops/claim.php', 'atlas/world/drop.php', 'atlas/world/drops/relay-claim.php'];

(async () => {
  build();
  makeBase();

  await check('the registry names exactly the five files and the three membership classes', () => {
    const reg = JSON.parse(fs.readFileSync(path.join(REPO, 'tools/site-doctor/security.json'), 'utf8'));
    assert.deepStrictEqual(reg.files.map((f) => f.path), FILES);
    assert.deepStrictEqual(reg.ownerProofClasses, ['atlas.membership', 'atlas.postoffice.membership', 'atlas.tradingstation.membership']);
  });

  await check('the build refuses a registry text that the repository file does not contain', () => {
    const regPath = path.join(REPO, 'tools/site-doctor/security.json');
    const original = fs.readFileSync(regPath, 'utf8');
    try {
      fs.writeFileSync(regPath, original.replace('atlas_outbound_caller', 'atlas_outbound_caller_renamed'));
      let failed = false;
      try { execFileSync('node', [path.join(REPO, 'tools/site-doctor-build.js'), path.join(tmp, 'bad-build'), '--allow-dirty'], { encoding: 'utf8', stdio: 'pipe' }); } catch (e) { failed = /security registry: lib\/outbound\.php does not contain/.test(String(e.stderr)); }
      assert.ok(failed, 'build must fail naming the file');
    } finally { fs.writeFileSync(regPath, original); }
  });

  // ---- the files ----
  await check('a matching deployment: every security file matches and nothing is flagged', async () => {
    const root = layout();
    await withServer(root, {}, async (api) => {
      const { g } = await api.security();
      for (const f of FILES) assert.strictEqual(rowFor(g.files, f).label, 'MATCHING', f);
      assert.match(g.files.summary, /^5 matching, 0 outdated or modified, 0 missing/);
      assert.strictEqual(g.files.rows.filter((r) => r.status !== 'ok').length, 0);
    });
  });

  await check('older releases are reported as outdated, and say what is missing', async () => {
    const root = layout();
    put(root, 'lib/outbound.php', historic('a36ecfe^', 'issuer-php/lib/outbound.php'));
    put(root, 'lib/bootstrap.php', historic('a36ecfe^', 'issuer-php/lib/bootstrap.php'));
    put(root, 'atlas/world/drops/claim.php', historic('95393b6^', 'issuer-php/atlas/world/drops/claim.php'));
    put(root, 'atlas/world/drop.php', historic('95393b6^', 'issuer-php/atlas/world/drop.php'));
    put(root, 'atlas/world/drops/relay-claim.php', historic('7f7348a^', 'issuer-php/atlas/world/drops/relay-claim.php'));
    await withServer(root, {}, async (api) => {
      const { g } = await api.security();
      for (const f of FILES) assert.strictEqual(rowFor(g.files, f).label, 'OUTDATED', f);
      for (const f of FILES.slice(0, 4)) assert.strictEqual(rowFor(g.files, f).status, 'fail', f + ' is security-critical');
      assert.strictEqual(rowFor(g.files, 'atlas/world/drops/relay-claim.php').status, 'warn', 'relay-claim.php is not critical');
      assert.match(rowFor(g.files, 'lib/outbound.php').detail, /Lacks: caller-aware fair share/);
      assert.match(rowFor(g.files, 'lib/bootstrap.php').detail, /Lacks: revocation list lookups counted as verify.*suspension list lookups counted as verify/);
      assert.match(rowFor(g.files, 'lib/bootstrap.php').detail, /Has: drop-intent expiry rules/, 'the part of the release that is there is named too');
      assert.match(rowFor(g.files, 'lib/outbound.php').fix, /never changes a file/);
      assert.match(g.files.summary, /^0 matching, 5 outdated or modified, 0 missing/);
    });
  });

  await check('an edited copy with the current security changes is modified, not outdated, and not a failure', async () => {
    const root = layout();
    for (const f of FILES) fs.appendFileSync(path.join(root, f), '\n// local note\n');
    await withServer(root, {}, async (api) => {
      const { g } = await api.security();
      for (const f of FILES.slice(0, 4)) {
        const r = rowFor(g.files, f);
        assert.strictEqual(r.label, 'MODIFIED', f);
        assert.strictEqual(r.status, 'warn', f);
        assert.match(r.fix, /Nothing is required if you made the change/);
      }
      // relay-claim.php has a marker too (the owner-intent check), so an edit that keeps it is modified as well
      assert.strictEqual(rowFor(g.files, 'atlas/world/drops/relay-claim.php').label, 'MODIFIED');
      assert.strictEqual(g.files.rows.filter((r) => r.status === 'fail').length, 0);
    });
  });

  await check('a CRLF copy (a Windows upload) matches', async () => {
    const root = layout();
    for (const f of FILES) { const p = path.join(root, f); fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/\n/g, '\r\n')); }
    await withServer(root, {}, async (api) => {
      const { g } = await api.security();
      for (const f of FILES) assert.strictEqual(rowFor(g.files, f).label, 'MATCHING', f);
    });
  });

  await check('missing core files fail; a missing drops file fails while the drops part is installed', async () => {
    const root = layout();
    fs.unlinkSync(path.join(root, 'lib/outbound.php'));
    fs.unlinkSync(path.join(root, 'atlas/world/drops/claim.php'));
    await withServer(root, {}, async (api) => {
      const { g } = await api.security();
      assert.strictEqual(rowFor(g.files, 'lib/outbound.php').label, 'MISSING');
      assert.strictEqual(rowFor(g.files, 'lib/outbound.php').status, 'fail');
      assert.strictEqual(rowFor(g.files, 'atlas/world/drops/claim.php').label, 'MISSING', 'drop.php and others are here, so the part is installed');
      assert.strictEqual(rowFor(g.files, 'lib/bootstrap.php').label, 'MATCHING');
      assert.match(g.files.summary, /2 missing/);
      assert.strictEqual(g.outbound.status, 'fail');
    });
  });

  await check('world drops not installed: their files are NOT INSTALLED and never required', async () => {
    const root = layout();
    fs.rmSync(path.join(root, 'atlas/world'), { recursive: true });
    await withServer(root, {}, async (api) => {
      const { g } = await api.security();
      for (const f of FILES.slice(2)) { const r = rowFor(g.files, f); assert.strictEqual(r.label, 'NOT INSTALLED', f); assert.strictEqual(r.status, 'na', f); }
      assert.match(g.files.summary, /2 matching.*3 not installed \(optional\)/);
      assert.strictEqual(g.files.rows.filter((r) => r.status === 'fail' || r.status === 'warn').length, 0);
      const classes = rowFor(g.outbound, 'Request classes');
      assert.strictEqual(classes.status, 'ok', 'the drop class has no caller when drops are not installed: ' + classes.detail);
      assert.match(classes.detail, /drop: supported \(its caller is an optional part that is not installed\)/);
      assert.strictEqual(rowFor(g.outbound, 'Ready').label, 'READY');
    });
  });

  await check('ticking the drops part makes an absent one a failure (the doctor\'s own component rule)', async () => {
    const root = layout();
    fs.rmSync(path.join(root, 'atlas/world'), { recursive: true });
    await withServer(root, {}, async (api) => {
      const { g } = await api.security({ mods: 'w' });
      assert.strictEqual(rowFor(g.files, 'atlas/world/drop.php').label, 'MISSING');
    });
  });

  // ---- the domain pin ----
  const real = (root, env) => {
    const clean = {};
    for (const k of Object.keys(process.env)) if (!/^ATLAS_/.test(k)) clean[k] = process.env[k];
    const out = execFileSync('php', ['-r', 'require "lib/domain.php"; echo json_encode(atlas_configured_domain());'], { cwd: root, env: Object.assign(clean, env || {}), encoding: 'utf8' });
    return JSON.parse(out);
  };
  const MATRIX = [
    ['nothing configured', null, null],
    ['environment, mixed case', { ATLAS_DOMAIN: 'Example.COM' }, null],
    ['file only', null, '{"domain":"Foo.Example"}'],
    ['environment beats file', { ATLAS_DOMAIN: 'a.example' }, '{"domain":"b.example"}'],
    ['invalid environment value', { ATLAS_DOMAIN: 'bad domain!' }, null],
    ['file value not a string', null, '{"domain":123}'],
    ['file is not JSON', null, '{not json'],
    ['blank environment falls through to the file', { ATLAS_DOMAIN: '   ' }, '{"domain":"c.example"}'],
    ['empty file value', null, '{"domain":""}'],
    ['port out of range', { ATLAS_DOMAIN: 'host.example:99999' }, null],
    ['IPv6 literal with a port', null, '{"domain":"[::1]:8080"}'],
    ['file without a domain', null, '{"other":"x"}']
  ];
  for (const [name, env, file] of MATRIX) {
    await check('domain pin follows the issuer\'s own order: ' + name, async () => {
      const root = layout();
      if (file !== null) put(root, 'lib/atlas-domain-config.json', file);
      const truth = real(root, env);
      await withServer(root, env, async (api) => {
        const { raw } = await api.security();
        const want = truth === false ? 'invalid' : (truth === null ? 'unpinned' : 'pinned');
        assert.strictEqual(raw.domain.state, want, 'issuer says ' + JSON.stringify(truth));
        assert.strictEqual(raw.domain.effective, typeof truth === 'string' ? truth : null);
      });
    });
  }

  await check('domain pin: PASS when pinned and equal to this host; the source is named and nothing sensitive is printed', async () => {
    const root = layout();
    const port = await freePort();
    put(root, 'lib/atlas-domain-config.json', JSON.stringify({ domain: '127.0.0.1:' + port }));
    // the server must listen on that port for the Host header to match
    const clean = {};
    for (const k of Object.keys(process.env)) if (!/^ATLAS_/.test(k)) clean[k] = process.env[k];
    const child = spawn('php', ['-d', 'auto_prepend_file=' + path.join(root, 'prepend.php'), '-S', '127.0.0.1:' + port, '-t', root], { stdio: 'ignore', env: clean });
    servers.push(child);
    for (let i = 0; i < 100; i++) { if (await new Promise((r) => { const s = net.connect(port, '127.0.0.1', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); })) break; await sleep(50); }
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/site-doctor.php', { method: 'POST', body: new URLSearchParams({ action: 'security', token }) });
      const text = await r.text(); everything.push(text);
      const d = JSON.parse(text).groups.find((x) => x.id === 'domain');
      assert.strictEqual(d.rows[0].status, 'ok');
      assert.strictEqual(d.rows[0].label, 'PASS');
      assert.match(d.rows[0].detail, /Configuration source: lib\/atlas-domain-config\.json/);
      assert.match(d.rows[0].detail, new RegExp('Expected: 127\\.0\\.0\\.1:' + port));
    } finally { child.kill(); }
  });

  await check('domain pin: WARNING when it falls back to the Host header, FAIL when invalid or mismatched', async () => {
    const root = layout();
    await withServer(root, {}, async (api) => {
      const { g } = await api.security();
      assert.strictEqual(g.domain.rows[0].status, 'warn');
      assert.match(g.domain.rows[0].title, /falls back to the HTTP Host header/);
      assert.match(g.domain.rows[0].fix, /lib\/atlas-domain-config\.json/);
    });
    await withServer(root, { ATLAS_DOMAIN: 'not a host' }, async (api) => {
      const { g } = await api.security();
      assert.strictEqual(g.domain.rows[0].status, 'fail');
      assert.doesNotMatch(JSON.stringify(g.domain), /not a host/, 'a bad value is not echoed back');
    });
    await withServer(root, { ATLAS_DOMAIN: 'issuer.example' }, async (api) => {
      const { g, raw } = await api.security();
      assert.strictEqual(g.domain.rows[0].status, 'fail', 'pinned, but not to this host');
      assert.match(g.domain.rows[0].title, /does not match the expected domain/);
      assert.strictEqual(raw.domain.effective, 'issuer.example');
      const typed = await api.security({ expected: 'Issuer.Example' });
      assert.strictEqual(typed.g.domain.rows[0].status, 'ok', 'the typed expected domain is honoured and normalised');
      const typedWrong = await api.security({ expected: 'other.example' });
      assert.strictEqual(typedWrong.g.domain.rows[0].status, 'fail');
    });
  });

  await check('a lib/domain.php that cannot be pinned, or is missing, fails', async () => {
    const root = layout();
    put(root, 'lib/domain.php', '<?php function atlas_domain() { return $_SERVER["HTTP_HOST"]; }');
    await withServer(root, { ATLAS_DOMAIN: 'x.example' }, async (api) => {
      const { g } = await api.security();
      assert.strictEqual(g.domain.rows[0].status, 'fail');
      assert.match(g.domain.rows[0].title, /cannot be pinned/);
    });
    fs.unlinkSync(path.join(root, 'lib/domain.php'));
    await withServer(root, {}, async (api) => {
      const { g } = await api.security();
      assert.match(g.domain.rows[0].title, /lib\/domain\.php is missing/);
    });
  });

  // ---- owner proof ----
  const CLASSES = ['atlas.membership', 'atlas.postoffice.membership', 'atlas.tradingstation.membership'];
  await check('owner proof: enforcing in require mode with every class and its counters', async () => {
    const root = layout();
    put(root, 'lib/atlas-owner-proof-config.json', '{"mode":"require"}');
    put(root, 'lib/owner-proof/stats.json', JSON.stringify({ classes: {
      'atlas.membership': { signed: 12, unsigned: 3, refused: 7, lastUnsignedAt: '2020-01-01T00:00:00.000Z', lastWallet: 'WALLET-ID-MARKER' },
      'atlas.postoffice.membership': { signed: 4, unsigned: 0, refused: 1 },
      'atlas.tradingstation.membership': { signed: 0, unsigned: 0, refused: 0 },
      'atlas.other.class': { signed: 99, unsigned: 99, refused: 99 }
    }, records: [{ who: 'RECORD-MARKER' }] }));
    await withServer(root, {}, async (api) => {
      const { g } = await api.security();
      assert.strictEqual(g.owner.rows[0].status, 'ok');
      for (const c of CLASSES) { assert.strictEqual(rowFor(g.owner, c).label, 'ENFORCING', c); assert.strictEqual(rowFor(g.owner, c).status, 'ok'); }
      assert.match(rowFor(g.owner, 'atlas.membership').detail, /12 signed, 3 unsigned, 7 refused/);
      assert.match(rowFor(g.owner, 'atlas.postoffice.membership').detail, /4 signed, 0 unsigned, 1 refused/);
      assert.strictEqual(g.owner.rows.length, 4, 'the verdict and exactly the three membership classes');
      assert.ok(g.owner.rows[0].dup, 'the verdict is also in the services list, so the to-do list does not repeat it');
    });
  });

  await check('owner proof: accept mode says per class whether it is ready, not ready, or unproven', async () => {
    const root = layout();
    put(root, 'lib/atlas-owner-proof-config.json', '{"mode":"accept"}');
    put(root, 'lib/owner-proof/stats.json', JSON.stringify({ classes: {
      'atlas.membership': { signed: 5, unsigned: 0, refused: 0 },
      'atlas.postoffice.membership': { signed: 2, unsigned: 1, refused: 0, lastUnsignedAt: new Date().toISOString() },
      'atlas.tradingstation.membership': { signed: 0, unsigned: 0, refused: 0 }
    } }));
    await withServer(root, {}, async (api) => {
      const { g } = await api.security();
      assert.strictEqual(rowFor(g.owner, 'atlas.membership').label, 'READY');
      assert.strictEqual(rowFor(g.owner, 'atlas.postoffice.membership').label, 'NOT READY');
      assert.strictEqual(rowFor(g.owner, 'atlas.tradingstation.membership').label, 'NO SIGNED YET');
      assert.strictEqual(g.owner.rows[0].status, 'warn');
    });
  });

  await check('owner proof: off fails, an unknown value warns, an old issue.php is not installed', async () => {
    const root = layout();
    put(root, 'lib/atlas-owner-proof-config.json', '{"mode":"off"}');
    await withServer(root, {}, async (api) => {
      const { g } = await api.security();
      assert.strictEqual(g.owner.rows[0].status, 'fail');
      assert.strictEqual(rowFor(g.owner, 'atlas.membership').label, 'OFF');
    });
    put(root, 'lib/atlas-owner-proof-config.json', '{"mode":"maybe"}');
    await withServer(root, {}, async (api) => { assert.strictEqual((await api.security()).g.owner.rows[0].status, 'warn'); });
    put(root, 'lib/atlas-owner-proof-config.json', '{"mode":"require"}');
    put(root, 'atlas/asset/issue.php', '<?php echo "{}";');
    await withServer(root, {}, async (api) => {
      const { g } = await api.security();
      assert.strictEqual(g.owner.rows[0].status, 'fail');
      assert.strictEqual(rowFor(g.owner, 'atlas.membership').label, 'NOT INSTALLED');
    });
  });

  await check('owner proof: the services list and this section give the same verdict', async () => {
    const root = layout();
    put(root, 'lib/atlas-owner-proof-config.json', '{"mode":"require"}');
    await withServer(root, {}, async (api) => {
      const sv = await api.call('services', {});
      const own = sv.json.checks.find((c) => c.id === 'owner-proof');
      const { g } = await api.security();
      assert.strictEqual(own.status, g.owner.rows[0].status);
      assert.strictEqual(own.title, g.owner.rows[0].title);
      assert.strictEqual(own.detail, g.owner.rows[0].detail);
    });
  });

  // ---- outbound ----
  const hasRow = (g, start) => g.rows.some((r) => r.title.startsWith(start));
  await check('outbound: installed, wired, configured and ready on a matching deployment; defaults are shown as defaults', async () => {
    const root = layout();
    await withServer(root, {}, async (api) => {
      const { g } = await api.security();
      const o = g.outbound;
      assert.strictEqual(rowFor(o, 'Installed').status, 'ok');
      const classes = rowFor(o, 'Request classes');
      assert.strictEqual(classes.status, 'ok');
      for (const c of ['key', 'verify', 'drop', 'relay']) assert.match(classes.detail, new RegExp(c + ': supported and used'));
      assert.strictEqual(rowFor(o, 'Configured').status, 'ok');
      assert.strictEqual(rowFor(o, 'Ready').label, 'READY');
      assert.match(rowFor(o, 'Reserve fraction').title, /0\.15 \(default\)/);
      assert.match(rowFor(o, 'Fair-share fraction').title, /0\.25 \(default\)/);
      assert.match(rowFor(o, 'Per-domain budget').title, /120 \(default\)/);
      assert.match(rowFor(o, 'Overall budget').title, /600 \(default\)/);
      assert.match(rowFor(o, 'Per-domain key-lookup budget').title, /20 \(default\)/);
      assert.match(rowFor(o, 'Overall key-lookup budget').title, /120 \(default\)/);
      assert.match(rowFor(o, 'Rate window').title, /60000 ms \(default\)/);
      assert.match(rowFor(o, 'Reserve fraction').detail, /90 of 600/, 'the slice each class keeps');
      assert.strictEqual(rowFor(o, 'In use').label, 'NOT YET OBSERVED', 'nothing has run yet, and that is not called a failure');
      assert.strictEqual(rowFor(o, 'In use').status, 'info');
    });
  });

  await check('outbound: environment settings are read the way the limiter reads them', async () => {
    const root = layout();
    const env = { ATLAS_OUTBOUND_RESERVE: '0.2', ATLAS_OUTBOUND_FAIR_SHARE: '0.5', ATLAS_OUTBOUND_RATE: '50', ATLAS_OUTBOUND_RATE_ALL: '300', ATLAS_OUTBOUND_KEY_RATE: '10', ATLAS_OUTBOUND_KEY_RATE_ALL: '60', ATLAS_OUTBOUND_RATE_WINDOW_MS: '30000' };
    await withServer(root, env, async (api) => {
      const o = (await api.security()).g.outbound;
      assert.match(rowFor(o, 'Reserve fraction').title, /0\.2 \(set in the environment\)/);
      assert.match(rowFor(o, 'Fair-share fraction').title, /0\.5 \(set in the environment\)/);
      assert.match(rowFor(o, 'Per-domain budget').title, /50 \(set in the environment\)/);
      assert.match(rowFor(o, 'Overall budget').title, /300 \(set in the environment\)/);
      assert.match(rowFor(o, 'Overall key-lookup budget').title, /60 \(set in the environment\)/);
      assert.match(rowFor(o, 'Rate window').title, /30000 ms/);
      assert.match(rowFor(o, 'Reserve fraction').detail, /60 of 300/);
      assert.strictEqual(rowFor(o, 'Configured').status, 'ok');
    });
  });

  await check('outbound: the settings the limiter would ignore, or that would stop it, are called out', async () => {
    const root = layout();
    await withServer(root, { ATLAS_OUTBOUND_RESERVE: '0' }, async (api) => {
      const o = (await api.security()).g.outbound;
      const c = rowFor(o, 'Configured');
      assert.strictEqual(c.status, 'warn');
      assert.match(c.detail, /turns off both the caller fair-share rule and the floors/);
      assert.match(rowFor(o, 'Reserve fraction').title, /^Reserve fraction: 0 \(set in the environment\)/);
    });
    await withServer(root, { ATLAS_OUTBOUND_RESERVE: '0.9', ATLAS_OUTBOUND_FAIR_SHARE: 'lots' }, async (api) => {
      const c = rowFor((await api.security()).g.outbound, 'Configured');
      assert.strictEqual(c.status, 'warn');
      assert.match(c.detail, /ATLAS_OUTBOUND_RESERVE is set but is outside 0 to 0\.3/);
      assert.match(c.detail, /ATLAS_OUTBOUND_FAIR_SHARE is set but is not a number/);
      assert.doesNotMatch(c.detail, /lots/, 'an invalid value is not echoed');
    });
    await withServer(root, { ATLAS_OUTBOUND_RATE_ALL: '0.4' }, async (api) => {
      const o = (await api.security()).g.outbound;
      assert.strictEqual(rowFor(o, 'Configured').status, 'fail', 'a budget that rounds to 0 refuses everything');
      assert.match(rowFor(o, 'Configured').detail, /ATLAS_OUTBOUND_RATE_ALL works out to less than 1/);
      assert.strictEqual(rowFor(o, 'Not ready').status, 'fail');
    });
  });

  await check('outbound: a function name alone is not "installed"; an older limiter fails and is not ready', async () => {
    const root = layout();
    put(root, 'lib/outbound.php', '<?php function atlas_outbound_caller() { return null; }');
    await withServer(root, {}, async (api) => {
      const o = (await api.security()).g.outbound;
      assert.strictEqual(rowFor(o, 'Installed').status, 'fail');
      assert.match(rowFor(o, 'Installed').detail, /Lacks: separate verify, drop and relay budgets; reserve and fair-share settings/);
      assert.strictEqual(rowFor(o, 'Request classes').status, 'fail');
      assert.ok(hasRow(o, 'Not ready'));
      assert.ok(!hasRow(o, 'Ready'));
    });
    put(root, 'lib/outbound.php', historic('a36ecfe^', 'issuer-php/lib/outbound.php'));
    await withServer(root, {}, async (api) => {
      const o = (await api.security()).g.outbound;
      assert.match(rowFor(o, 'Installed').title, /an older limiter/);
      assert.strictEqual(rowFor(o, 'Request classes').status, 'fail');
    });
  });

  await check('outbound: new limiter with an old bootstrap.php is flagged as not wired', async () => {
    const root = layout();
    put(root, 'lib/bootstrap.php', historic('a36ecfe^', 'issuer-php/lib/bootstrap.php'));
    await withServer(root, {}, async (api) => {
      const c = rowFor((await api.security()).g.outbound, 'Request classes');
      assert.strictEqual(c.status, 'fail');
      assert.match(c.detail, /verify: supported, but lib\/bootstrap\.php does not use it/);
      assert.match(c.detail, /key: supported and used/);
    });
  });

  await check('outbound: records written by the real limiter show as observed, by class, with no caller shown', async () => {
    const root = layout();
    const clean = {};
    for (const k of Object.keys(process.env)) if (!/^ATLAS_/.test(k)) clean[k] = process.env[k];
    const script = (addr) => '$_SERVER["REMOTE_ADDR"]="' + addr + '"; require "lib/outbound.php"; foreach (["verify","verify","drop","relay","key"] as $k) atlas_outbound_rate_take("peer.example", $k);';
    execFileSync('php', ['-r', script(ADDR_PUBLIC)], { cwd: root, env: clean });
    execFileSync('php', ['-r', script(ADDR_OTHER)], { cwd: root, env: clean });
    await withServer(root, {}, async (api) => {
      const o = (await api.security()).g.outbound;
      const r = rowFor(o, 'In use');
      assert.strictEqual(r.label, 'OBSERVED');
      assert.match(r.detail, /key 2, verify 4, drop 2, relay 2/);
    });
  });

  await check('outbound: a rate file in the older shape is reported as such', async () => {
    const root = layout();
    put(root, 'lib/atlas-outbound-rate-store.json', JSON.stringify({ other: { all: [Date.now()], by: { 'peer.example': [Date.now()] } } }));
    await withServer(root, {}, async (api) => {
      assert.strictEqual(rowFor((await api.security()).g.outbound, 'In use').label, 'OLD RECORDS');
    });
  });

  if (process.getuid && process.getuid() !== 0) {
    await check('outbound: a lib/ the limiter cannot write to is a configuration failure (it would refuse every request)', async () => {
      const root = layout();
      fs.chmodSync(path.join(root, 'lib'), 0o555);
      try {
        await withServer(root, {}, async (api) => {
          const c = rowFor((await api.security()).g.outbound, 'Configured');
          assert.strictEqual(c.status, 'fail');
          assert.match(c.detail, /cannot write/);
        });
      } finally { fs.chmodSync(path.join(root, 'lib'), 0o755); }
    });
  } else console.log('skip outbound: unwritable lib/ (running as root, where every directory is writable)');

  // ---- visitor addresses ----
  const asVisitor = (addr, extra) => Object.assign({ 'X-Test-Remote': addr }, extra || {});
  await check('visitors: a public address with nothing recorded is "not yet verified", never a proxy guess', async () => {
    const root = layout();
    await withServer(root, {}, async (api) => {
      const v = (await api.security(undefined, asVisitor(ADDR_PUBLIC))).g.visitors;
      assert.strictEqual(v.rows[0].status, 'ok');
      assert.match(v.rows[0].title, /IPv4, public range/);
      const second = v.rows.find((r) => r.label === 'NOT YET VERIFIED');
      assert.ok(second, 'rows: ' + v.rows.map((r) => r.label).join(','));
      assert.strictEqual(second.status, 'info');
      assert.match(second.title, /no visitor records are held right now/);
      assert.match(second.detail, /not a sign of a proxy/);
      assert.match(second.detail, /open \/atlas\/moderation\/status once each/);
      assert.ok(!v.rows.some((r) => /proxy/i.test(r.title)));
    });
  });

  await check('visitors: one recorded visitor is still not verified; two distinct records are verified', async () => {
    const root = layout();
    put(root, 'lib/atlas-admin-ratelimit-store.json', JSON.stringify({ failures: {}, nonceIssues: {}, moderationStatus: { [PLANTED_ID_1]: [Date.now()] } }));
    await withServer(root, {}, async (api) => {
      const v = (await api.security(undefined, asVisitor(ADDR_PUBLIC))).g.visitors;
      const r = v.rows.find((x) => x.label === 'NOT YET VERIFIED');
      assert.ok(r); assert.match(r.title, /only one visitor has been recorded/);
    });
    put(root, 'lib/atlas-admin-ratelimit-store.json', JSON.stringify({ failures: {}, nonceIssues: {}, moderationStatus: { [PLANTED_ID_1]: [Date.now()], [PLANTED_ID_2]: [Date.now()] } }));
    await withServer(root, {}, async (api) => {
      const v = (await api.security(undefined, asVisitor(ADDR_PUBLIC))).g.visitors;
      const r = v.rows.find((x) => x.label === 'VERIFIED');
      assert.ok(r, 'rows: ' + v.rows.map((x) => x.label).join(','));
      assert.strictEqual(r.status, 'ok');
      assert.match(r.detail, /2 distinct client records/);
    });
  });

  await check('visitors: records written by the real limiter for two callers also verify', async () => {
    const root = layout();
    const clean = {};
    for (const k of Object.keys(process.env)) if (!/^ATLAS_/.test(k)) clean[k] = process.env[k];
    for (const a of [ADDR_PUBLIC, ADDR_OTHER]) execFileSync('php', ['-r', '$_SERVER["REMOTE_ADDR"]="' + a + '"; require "lib/outbound.php"; atlas_outbound_rate_take("peer.example","verify");'], { cwd: root, env: clean });
    await withServer(root, {}, async (api) => {
      const v = (await api.security(undefined, asVisitor('192.0.2.200'))).g.visitors;
      assert.ok(v.rows.some((x) => x.label === 'VERIFIED'), v.rows.map((x) => x.label).join(','));
    });
  });

  await check('visitors: a private or loopback address, or a forwarded header that disagrees, points to a proxy and blocks "verified"', async () => {
    const root = layout();
    put(root, 'lib/atlas-admin-ratelimit-store.json', JSON.stringify({ failures: {}, nonceIssues: {}, moderationStatus: { [PLANTED_ID_1]: [1], [PLANTED_ID_2]: [1] } }));
    await withServer(root, {}, async (api) => {
      let v = (await api.security(undefined, asVisitor(ADDR_PRIVATE))).g.visitors;
      assert.strictEqual(rowFor(v, 'A reverse proxy probably').status, 'warn');
      assert.match(v.rows[0].title, /private range/);
      assert.ok(!v.rows.some((r) => r.label === 'VERIFIED'));
      v = (await api.security(undefined, asVisitor('127.0.0.1'))).g.visitors;
      assert.match(v.rows[0].title, /loopback range/);
      assert.ok(v.rows.some((r) => /proxy/.test(r.title)));
      v = (await api.security(undefined, asVisitor(ADDR_PUBLIC, { 'X-Forwarded-For': ADDR_OTHER }))).g.visitors;
      const p = rowFor(v, 'A reverse proxy probably');
      assert.match(p.detail, /forwarded-address header \(X-Forwarded-For\) is present and names a different address/);
      assert.match(p.fix, /Do not set ATLAS_OUTBOUND_RESERVE=0/);
      assert.ok(!v.rows.some((r) => r.label === 'VERIFIED'));
      v = (await api.security(undefined, asVisitor(ADDR_PUBLIC, { 'X-Forwarded-For': ADDR_PUBLIC }))).g.visitors;
      assert.ok(!v.rows.some((r) => /proxy/i.test(r.title)), 'a header that agrees is not a proxy');
      assert.ok(v.rows.some((r) => r.label === 'VERIFIED'));
    });
  });

  await check('visitors: no connecting address at all is a warning', async () => {
    const root = layout();
    await withServer(root, {}, async (api) => {
      const v = (await api.security(undefined, asVisitor('none'))).g.visitors;
      assert.strictEqual(v.rows[0].status, 'warn');
      assert.match(v.rows[0].title, /cannot see a visitor address/);
      assert.strictEqual(v.rows.length, 1);
    });
  });

  // ---- what the doctor must not do ----
  const snapshot = (dir) => {
    const out = {};
    (function walk(d, rel) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const r = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) walk(path.join(d, e.name), r);
        else { const st = fs.statSync(path.join(d, e.name)); out[r] = crypto.createHash('sha256').update(fs.readFileSync(path.join(d, e.name))).digest('hex') + ':' + st.mtimeMs + ':' + st.size; }
      }
    })(dir, '');
    return out;
  };
  await check('every security check is read-only: the document root is byte- and time-identical afterwards', async () => {
    const root = layout();
    put(root, 'lib/atlas-owner-proof-config.json', '{"mode":"accept"}');
    put(root, 'lib/owner-proof/stats.json', JSON.stringify({ classes: { 'atlas.membership': { signed: 1, unsigned: 0, refused: 0 } } }));
    put(root, 'lib/atlas-admin-ratelimit-store.json', JSON.stringify({ failures: {}, nonceIssues: {}, moderationStatus: { [PLANTED_ID_1]: [1] } }));
    put(root, 'lib/atlas-outbound-rate-store.json', '{"other":[]}');
    await sleep(30);
    const before = snapshot(root);
    await withServer(root, { ATLAS_DOMAIN: 'x.example', ATLAS_OUTBOUND_RESERVE: '0' }, async (api) => {
      for (let i = 0; i < 3; i++) await api.security({ expected: 'x.example' }, asVisitor(ADDR_PUBLIC));
    });
    assert.deepStrictEqual(snapshot(root), before);
  });

  await check('the security action needs the token, honours expiry and cannot be read with GET', async () => {
    const root = layout();
    await withServer(root, {}, async (api) => {
      const bad = await api.call('security', {}, {}, 'wrong-token');
      assert.strictEqual(bad.status, 403);
      assert.ok(!bad.json || !bad.json.groups);
      const get = await fetch(api.base + '/site-doctor.php?action=security&token=' + token);
      const text = await get.text(); everything.push(text);
      assert.match(get.headers.get('content-type') || '', /text\/html/);
      assert.doesNotMatch(text, /"groups"/);
    });
    // an expired doctor refuses the check but could still delete itself
    const out = fs.mkdtempSync(path.join(tmp, 'expired-'));
    execFileSync('node', [path.join(REPO, 'tools/site-doctor-build.js'), out, '--hours', '0.0003', '--allow-dirty'], { encoding: 'utf8' });
    const tok = fs.readFileSync(path.join(out, 'ACCESS.txt'), 'utf8').match(/Token:\s+([0-9a-f-]{39})/)[1];
    const r2 = layout();
    fs.copyFileSync(path.join(out, 'site-doctor.php'), path.join(r2, 'site-doctor.php'));
    await sleep(3200);
    await withServer(r2, {}, async (api) => {
      const res = await api.call('security', {}, {}, tok);
      assert.strictEqual(res.status, 410);
      const del = await api.call('delete', {}, {}, tok);
      assert.ok(del.json.ok);
      assert.ok(!fs.existsSync(path.join(r2, 'site-doctor.php')), 'it deleted itself');
    });
  });

  await check('no address, hash, wallet or record from any fixture appears in any answer', () => {
    assert.ok(everything.length > 50, 'enough answers were collected (' + everything.length + ')');
    const text = everything.join('\n');
    for (const s of SECRETS) assert.ok(!text.includes(s), 'leaked: ' + s);
    assert.doesNotMatch(text, /\b(?:\d{1,3}\.){3}\d{1,3}\b(?<!127\.0\.0\.1)/, 'no dotted address other than this test host');
  });

  await check('the page script parses and renders the section, the expected-domain field and the report lines', () => {
    const text = fs.readFileSync(doctorPhp, 'utf8');
    const script = text.match(/<script nonce="__NONCE__">\n([\s\S]*?)<\/script>\n<\/body>/)[1];
    new Function(script); // a syntax error throws
    for (const needle of ["'Issuer Security & Deployment Health'", 'id="expectedDomain"', "call('security'", "'ISSUER SECURITY AND DEPLOYMENT HEALTH'", 'securityGroups().forEach']) assert.ok(script.includes(needle) || text.includes(needle), 'page lacks ' + needle);
  });

  servers.forEach((s) => { try { s.kill(); } catch (e) { /* already gone */ } });
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? '\n' + failures + ' FAILED' : '\nALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); servers.forEach((s) => s.kill()); process.exit(1); });
