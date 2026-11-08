// Helpers for tests that install the verifier package the way an operator would: build the archive from the locked
// manifest, extract it into an empty directory, write a config.php, and serve it with PHP's built-in server.
'use strict';
const { execFileSync, spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const MANIFEST = path.join(ROOT, 'packages', 'atlas-verify', 'manifest.json');
const BUILDER = path.join(ROOT, 'tools', 'package', 'build-package.js');
const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildPackage(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const res = spawnSync('node', [BUILDER, MANIFEST, '--out', outDir], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error('package build failed: ' + res.stderr);
  return path.join(outDir, manifest.name + '-' + manifest.version + '.zip');
}

function extractPackage(zip, dest) {
  fs.mkdirSync(dest, { recursive: true });
  execFileSync('unzip', ['-q', zip, '-d', dest]);
  return path.join(dest, manifest.root);
}

function writeConfig(dir, config) {
  fs.writeFileSync(path.join(dir, 'config.php'), '<?php return json_decode(' + JSON.stringify(JSON.stringify(config)) + ', true);\n');
}

async function servePhp(docroot, port, options) {
  options = options || {};
  const lines = [];
  const proc = spawn('php', ['-d', 'opcache.enable=0', ...(options.args || []), '-S', 'localhost:' + port, '-t', docroot], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: Object.assign({}, process.env, options.env || {})
  });
  let started = false;
  proc.stderr.on('data', (c) => { for (const l of c.toString().split('\n')) { if (l.includes('started')) started = true; lines.push(l); } });
  for (let i = 0; i < 200 && !started; i++) await sleep(25);
  if (!started) throw new Error('php -S did not start: ' + lines.join('\n'));
  return { port, base: 'http://localhost:' + port, lines, stop: () => proc.kill() };
}

async function postJson(url, body, headers) {
  const res = await fetch(url, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}), body: typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}

module.exports = { ROOT, manifest, buildPackage, extractPackage, writeConfig, servePhp, postJson, sleep };
