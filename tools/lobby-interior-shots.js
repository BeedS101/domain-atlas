#!/usr/bin/env node
// Captures the Lobby interior from fixed camera positions (real extension +
// issuer-server on a copy of demo-domain-a) so two builds can be compared.
//
// Usage (under xvfb-run): node tools/lobby-interior-shots.js <out-dir> [repo-root]
// Writes <out-dir>/<name>.png for each view below; `repo-root` defaults to this repo.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = path.resolve(process.argv[2] || 'lobby-shots');
const REPO = path.resolve(process.argv[3] || path.join(__dirname, '..'));
const EXT_PATH = path.join(REPO, 'extension');
const PORT = 8371;
const DOMAIN = 'localhost:' + PORT;
const DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-shots-docroot-'));
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-shots-state-'));
const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-shots-profile-'));

// x, y, z, yaw, pitch (yaw 0 looks toward -z, +yaw turns toward +x)
const VIEWS = {
  entrance: [3.2, 1.5, 4.9, 0, -0.05],
  centre: [0, 1.6, 0.4, -0.6, -0.12],
  nook: [-2.0, 1.5, 1.4, -1.45, -0.12],
  reception: [1.6, 1.5, -0.6, 0.15, -0.1],
  portal: [1.5, 1.5, 0.3, 3.4, -0.08],
  lounge: [1.6, 1.5, -2.6, 1.3, -0.12],
  floor: [0, 1.6, 2.4, 0, -0.95],
  facade: [3.2, 1.6, 11.5, 0, -0.05],
  eastSide: [13, 1.6, -0.5, -Math.PI / 2, -0.05],
  northSide: [-2, 1.6, -12, Math.PI, -0.05]
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.cpSync(path.join(REPO, 'demo-domain-a'), DOCROOT_DIR, { recursive: true });
  const manifestPath = path.join(DOCROOT_DIR, '.well-known', 'spatial.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.domain = DOMAIN;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const server = spawn('node', ['issuer-server/server.js'], {
    cwd: REPO,
    env: { ...process.env, PORT: String(PORT), ATLAS_DOMAIN: DOMAIN, ATLAS_STATE_DIR: STATE_DIR, ATLAS_DOCROOT: DOCROOT_DIR },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('issuer-server did not start in time')), 10000);
    server.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); resolve(); } });
    server.on('exit', (code) => reject(new Error('issuer-server exited early with code ' + code)));
  });

  let context;
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
      viewport: { width: 1280, height: 720 },
      args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox', '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist']
    });
    const page = await context.newPage();
    await page.goto('http://' + DOMAIN, { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frame = await (await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 })).contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), null, { timeout: 10000 });
    await frame.evaluate(() => { const s = document.createElement('style'); s.textContent = '#chatWidget, #hint, .hint { display: none !important; }'; document.head.appendChild(s); });
    await frame.evaluate(() => loadManifest(currentManifestUrl, 'lobby', null));
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Lobby') && !!window.__atlasActive3D, null, { timeout: 30000 });
    await frame.evaluate(() => window.__atlasActive3D.ready);
    await new Promise((r) => setTimeout(r, 2500));
    for (const [name, v] of Object.entries(VIEWS)) {
      await frame.evaluate(([x, y, z, yaw, pitch]) => { const c = window.__atlasActive3D.camera; c.pos[0] = x; c.pos[1] = y; c.pos[2] = z; c.yaw = yaw; c.pitch = pitch; }, v);
      await new Promise((r) => setTimeout(r, 700));
      fs.writeFileSync(path.join(OUT, name + '.png'), await page.locator('#domain-atlas-overlay').screenshot());
      console.log('saved', name);
    }
  } finally {
    if (context) await context.close();
    server.kill();
    for (const d of [DOCROOT_DIR, STATE_DIR, PROFILE_DIR]) fs.rmSync(d, { recursive: true, force: true });
  }
})().catch((e) => { console.error('FAILURE:', e); process.exit(1); });
