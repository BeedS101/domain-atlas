// Deployment package completeness: the files tools/studio-deploy-package.js lists are committed, together they
// satisfy every include of the Studio code, and a baseline issuer (origin/main) plus ONLY the package can serve
// the Studio API and mint a credential. Catches a Studio file that is missing from the list, uncommitted, or
// left behind in a working folder.
//   node test/studio-package-complete.js [baseline ref]
// The baseline is what a live site had before Studio: by default the last commit before Studio was added.
'use strict';
const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const assert = require('assert');
const { StudioLab, makeIdentity, DESIGN } = require('./studio-lab');

const REPO = path.resolve(__dirname, '..');
const baselineRef = process.argv[2] || '5547b10';
const sh = (cmd) => execSync(cmd, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
let failures = 0;
const check = (name, fn) => Promise.resolve().then(fn).then(() => console.log('ok   ' + name), (e) => { failures++; console.log('FAIL ' + name + '\n     ' + String(e.message).split('\n').join('\n     ')); });

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-pkg-'));
  try {
    // The package, laid out as the document root.
    const out = path.join(tmp, 'out');
    sh('node tools/studio-deploy-package.js ' + JSON.stringify(out));
    const pkgRoot = path.join(out, 'public_html');
    const pkg = [];
    (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); e.isDirectory() ? walk(f) : pkg.push(path.relative(pkgRoot, f).split(path.sep).join('/')); } })(pkgRoot);

    await check('every packaged file is committed (in HEAD) and unmodified in the working tree', () => {
      const bad = [];
      for (const rel of pkg) {
        const src = rel.startsWith('assets/') ? 'demo-domain-a/' + rel : 'issuer-php/' + rel;
        try { sh('git cat-file -e HEAD:' + src); } catch (e) { bad.push('not committed: ' + src); continue; }
        if (sh('git status --porcelain -- ' + JSON.stringify(src)).trim()) bad.push('uncommitted changes: ' + src);
        if (sh('git check-ignore ' + JSON.stringify(src) + ' || true').trim()) bad.push('ignored by .gitignore: ' + src);
      }
      assert.deepStrictEqual(bad, []);
    });

    await check('every file under issuer-php/atlas/studio/ is in the package', () => {
      // On disk, so an uncommitted or ignored new file is noticed too. storage-root.php is the operator's own file.
      const onDisk = [];
      (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); e.isDirectory() ? walk(f) : onDisk.push(path.relative(path.join(REPO, 'issuer-php'), f).split(path.sep).join('/')); } })(path.join(REPO, 'issuer-php/atlas/studio'));
      assert.deepStrictEqual(onDisk.filter((f) => f !== 'atlas/studio/inc/storage-root.php' && !pkg.includes(f)), []);
    });

    await check('the six Studio models are in assets/studio/ and nothing is directly in assets/', () => {
      for (const t of ['trophy', 'badge', 'key']) for (const e of ['glb', 'png']) assert.ok(pkg.includes('assets/studio/' + t + '.' + e), t + '.' + e);
      assert.deepStrictEqual(pkg.filter((f) => /^assets\/[^/]+$/.test(f)), []);
    });

    // Baseline: what a live site already has.
    let baseline = null;
    try { baseline = new Set(sh('git ls-tree -r --name-only ' + baselineRef + ' -- issuer-php demo-domain-a').split('\n').filter(Boolean).map((f) => f.replace(/^(issuer-php|demo-domain-a)\//, ''))); } catch (e) { /* no such ref */ }
    if (!baseline) { console.log('SKIP baseline checks: ref ' + baselineRef + ' not available'); process.exit(failures ? 1 : 0); }

    await check('every include of the Studio code resolves inside the package or the baseline issuer', () => {
      const have = new Set([...pkg, ...baseline]);
      const missing = [];
      for (const rel of pkg.filter((f) => f.endsWith('.php') && (f.startsWith('atlas/studio/') || f.startsWith('lib/')))) {
        const text = fs.readFileSync(path.join(pkgRoot, rel), 'utf8');
        const re = /(?:require|include)(?:_once)?\s*\(?\s*__DIR__\s*\.\s*'([^']+)'/g;
        let m;
        while ((m = re.exec(text))) {
          const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1].replace(/^\//, '')));
          if (!have.has(target)) missing.push(rel + ' needs ' + target);
        }
      }
      assert.deepStrictEqual(missing, []);
    });

    await check('the Studio page only references files that are in the package', () => {
      const html = fs.readFileSync(path.join(pkgRoot, 'atlas/studio/index.html'), 'utf8');
      const refs = [...html.matchAll(/(?:src|href)="([^"#?]+)"/g)].map((m) => m[1]).filter((u) => !/^(https?:)?\/\//.test(u) && !u.startsWith('/'));
      const missing = refs.filter((u) => !pkg.includes('atlas/studio/' + u));
      assert.deepStrictEqual(missing, []);
    });

    // Functional: baseline + package only.
    const root = path.join(tmp, 'site');
    const doc = path.join(root, 'docroot');
    fs.mkdirSync(doc, { recursive: true });
    sh('git archive ' + baselineRef + ' demo-domain-a issuer-php | tar -x -C ' + JSON.stringify(root));
    fs.cpSync(path.join(root, 'demo-domain-a'), doc, { recursive: true });
    fs.cpSync(path.join(root, 'issuer-php'), doc, { recursive: true });
    // The files that were on the site before must be gone from the picture only where the package replaces them.
    fs.cpSync(pkgRoot, doc, { recursive: true });
    const studio = path.join(root, 'studio-data');
    const priv = path.join(root, 'issuer-private');
    for (const b of ['drafts', 'uploads-quarantine', 'mint-receipts', 'tmp', 'rate']) fs.mkdirSync(path.join(studio, b), { recursive: true });
    fs.mkdirSync(priv);
    fs.writeFileSync(path.join(doc, 'atlas/studio/inc/storage-root.php'), '<?php\nreturn ' + JSON.stringify(studio) + ';\n');
    const free = await new Promise((r) => { const n = net.createServer(); n.listen(0, '127.0.0.1', () => { const p = n.address().port; n.close(() => r(p)); }); });
    const lab = await StudioLab.start({ reuse: { root, docroot: doc, private: priv, studio, port: free }, env: { ATLAS_STUDIO_STORAGE_ROOT: '' } });
    try {
      await check('baseline issuer + package only: status, validator and a real mint work', async () => {
        fs.writeFileSync(path.join(studio, 'studio-config.json'), JSON.stringify({ mintEnabled: true, domain: lab.host, origins: [lab.origin] }));
        const st = await lab.status();
        assert.strictEqual(st.status, 200, st.text);
        assert.strictEqual(st.json.mintEnabled, true, st.text);
        const r = await lab.mintAs(makeIdentity('raw-ecdsa'), DESIGN);
        assert.strictEqual(r.mint.status, 200, r.mint.text);
        const a = r.mint.json.credential.asset;
        assert.strictEqual(a.model, 'https://' + lab.host + '/assets/studio/trophy.glb');
        assert.strictEqual(a.thumbnail, 'https://' + lab.host + '/assets/studio/trophy.png');
      });
      await check('removing any one packaged Studio PHP file is detected (the status call fails)', async () => {
        const victim = path.join(doc, 'atlas/studio/inc/studio-mint.php');
        const keep = fs.readFileSync(victim);
        fs.unlinkSync(victim);
        const st = await lab.status();
        fs.writeFileSync(victim, keep);
        assert.strictEqual(st.status, 500, 'expected the broken install to answer 500, got ' + st.status);
        assert.deepStrictEqual(st.json, { ok: false, error: 'internal-error' });
      });
    } finally { await lab.stop(); }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(failures ? '\n' + failures + ' check(s) failed.' : '\nAll package completeness checks passed.');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
