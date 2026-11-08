#!/usr/bin/env node
// Builds an installation ZIP from an explicit, version-locked file manifest.
//
//   node tools/package/build-package.js <manifest.json> [--out <dir>]    verify the lock, then build
//   node tools/package/build-package.js <manifest.json> --lock           record each source file's SHA-256 and size
//   node tools/package/build-package.js <manifest.json> --check          verify the lock only, build nothing
//
// The manifest names every file in the package, where it comes from in this repository, and the SHA-256 and size it
// must have. A source file that no longer matches the lock stops the build; changing a file therefore means running
// --lock on purpose (and raising the version). Nothing outside the manifest can enter the archive.
//
// The archive is reproducible: entries are sorted by path, stored without compression, with a fixed timestamp, fixed
// permissions and no extra fields, so the same manifest and sources give byte-identical output on any machine.
// Beside the ZIP it writes <name>-<version>.zip.sha256 (the archive) and <name>-<version>.files.sha256 (every file
// inside), both in the sha256sum format. tools/package/check-package.py checks all of it independently.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..', '..');
const FORMAT = 'domain-atlas-package-manifest/1';
const PACKAGE_FORMAT = 'domain-atlas-package/1';
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;
const PATH_RE = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*(\/[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*)*$|^(\.htaccess)$|^([A-Za-z0-9_-]+\/)+\.htaccess$/;
const ALLOWED_NAME = /(^|\/)(\.htaccess|LICENSE|VERSION)$|\.(php|md|txt|json)$/;
const STATE_LOOKING = /(^|\/)(atlas-[^/]*\.(json|txt)|[^/]*\.pem|[^/]*private[^/]*|config\.php|\.salt|replay|journal|holdings)(\/|$)/i;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function fail(message) {
  const error = new Error(message);
  error.manifestProblem = true;
  throw error;
}

function readManifest(file) {
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (manifest.format !== FORMAT) fail('unknown manifest format');
  if (!/^[a-z0-9-]+$/.test(manifest.name || '')) fail('bad package name');
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version || '')) fail('bad version');
  if (manifest.root !== manifest.name) fail('root folder must equal the package name');
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) fail('no files listed');
  const seen = new Set();
  let previous = '';
  for (const f of manifest.files) {
    if (typeof f.path !== 'string' || !PATH_RE.test(f.path) || f.path.split('/').includes('..')) fail('unsafe path: ' + f.path);
    if (!ALLOWED_NAME.test(f.path)) fail('file type not allowed in a package: ' + f.path);
    if (STATE_LOOKING.test(f.path) && !/\.example\./.test(f.path)) fail('state-looking path refused: ' + f.path);
    if (f.path === 'PACKAGE.json') fail('PACKAGE.json is generated, not listed');
    if (seen.has(f.path)) fail('listed twice: ' + f.path);
    if (f.path < previous) fail('files must be sorted by path: ' + f.path);
    seen.add(f.path);
    previous = f.path;
    if (typeof f.source !== 'string' || f.source.startsWith('/') || f.source.split('/').includes('..') || f.source.split('/').includes('node_modules') || f.source.startsWith('.git/')) fail('unsafe source: ' + f.source);
    if (f.mode !== '0644') fail('mode must be 0644: ' + f.path);
  }
  return manifest;
}

// Reads a listed source file; refuses links and anything that is not a regular file inside the repository.
function readSource(f) {
  const full = path.join(REPO, f.source);
  const stat = fs.lstatSync(full);
  if (!stat.isFile()) fail('source is not a regular file: ' + f.source);
  if (!fs.realpathSync(full).startsWith(REPO + path.sep)) fail('source resolves outside the repository: ' + f.source);
  return fs.readFileSync(full);
}

function loadSources(manifest) {
  return manifest.files.map((f) => ({ f, data: readSource(f) }));
}

function lockProblems(manifest, sources) {
  const problems = [];
  for (const { f, data } of sources) {
    if (sha256(data) !== f.sha256) problems.push(f.path + ': sha256 differs from the lock (' + f.source + ')');
    if (data.length !== f.size) problems.push(f.path + ': size differs from the lock');
  }
  const total = sources.reduce((n, s) => n + s.data.length, 0);
  if (total > MAX_TOTAL_BYTES) problems.push('package larger than ' + MAX_TOTAL_BYTES + ' bytes');
  const version = sources.find((s) => s.f.path === 'VERSION');
  if (!version || version.data.toString('utf8').trim() !== manifest.version) problems.push('VERSION file does not match the manifest version');
  const core = sources.find((s) => s.f.path === 'lib/atlas-verify.php');
  const declared = core && /const VERSION = '([0-9.]+)';/.exec(core.data.toString('utf8'));
  if (manifest.name === 'atlas-verify' && (!declared || declared[1] !== manifest.version)) problems.push('lib/atlas-verify.php VERSION constant does not match the manifest version');
  return problems;
}

function packageJson(manifest, sources) {
  return Buffer.from(JSON.stringify({
    format: PACKAGE_FORMAT,
    name: manifest.name,
    version: manifest.version,
    files: sources.map(({ f, data }) => ({ path: f.path, sha256: sha256(data), size: data.length }))
  }, null, 2) + '\n', 'utf8');
}

// ---------- reproducible stored ZIP ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// entries: [{ name, data }] already sorted. All timestamps are 1980-01-01 00:00:00, all files mode 0644.
function writeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    if (nameBytes.length !== name.length) throw new Error('non-ASCII path: ' + name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);        // version needed
    local.writeUInt16LE(0, 6);         // flags
    local.writeUInt16LE(0, 8);         // method: stored
    local.writeUInt16LE(0, 10);        // time 00:00:00
    local.writeUInt16LE(0x0021, 12);   // date 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);        // no extra field
    locals.push(local, nameBytes, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);  // made by: Unix, 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);      // extra
    central.writeUInt16LE(0, 32);      // comment
    central.writeUInt16LE(0, 34);      // disk
    central.writeUInt16LE(0, 36);      // internal attributes
    central.writeUInt32LE(((0o100644 << 16) >>> 0), 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBytes, end]);
}

function build(manifest, sources) {
  const files = sources.map(({ f, data }) => ({ path: f.path, data }));
  files.push({ path: 'PACKAGE.json', data: packageJson(manifest, sources) });
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const entries = files.map((x) => ({ name: manifest.root + '/' + x.path, data: x.data }));
  const zip = writeZip(entries);
  const base = manifest.name + '-' + manifest.version;
  return {
    base,
    zip,
    zipSha: sha256(zip),
    filesSha: entries.map((e) => sha256(e.data) + '  ' + e.name + '\n').join('')
  };
}

function main(argv) {
  const args = argv.slice(2);
  const outIndex = args.indexOf('--out');
  const outValue = outIndex >= 0 ? args[outIndex + 1] : null;
  const manifestFile = args.filter((a, i) => !a.startsWith('--') && !(outIndex >= 0 && i === outIndex + 1))[0];
  if (!manifestFile || (outIndex >= 0 && !outValue)) { console.error('usage: build-package.js <manifest.json> [--out dir | --lock | --check]'); return 2; }
  const outDir = path.resolve(outValue || path.join(REPO, 'dist', 'packages'));
  try {
    const manifest = readManifest(manifestFile);
    const sources = loadSources(manifest);
    if (args.includes('--lock')) {
      for (const { f, data } of sources) { f.sha256 = sha256(data); f.size = data.length; }
      const version = sources.find((s) => s.f.path === 'VERSION');
      if (!version || version.data.toString('utf8').trim() !== manifest.version) fail('VERSION file does not match the manifest version');
      fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
      console.log('locked ' + sources.length + ' files in ' + path.relative(REPO, path.resolve(manifestFile)));
      return 0;
    }
    const problems = lockProblems(manifest, sources);
    if (problems.length) { for (const p of problems) console.error('LOCK MISMATCH ' + p); console.error('Run with --lock only after reviewing the change, and raise the version.'); return 1; }
    if (args.includes('--check')) { console.log('lock OK: ' + sources.length + ' files, version ' + manifest.version); return 0; }
    const built = build(manifest, sources);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, built.base + '.zip'), built.zip);
    fs.writeFileSync(path.join(outDir, built.base + '.zip.sha256'), built.zipSha + '  ' + built.base + '.zip\n');
    fs.writeFileSync(path.join(outDir, built.base + '.files.sha256'), built.filesSha);
    console.log(built.base + '.zip  ' + built.zip.length + ' bytes  sha256 ' + built.zipSha);
    return 0;
  } catch (e) {
    console.error((e.manifestProblem ? 'MANIFEST ' : 'ERROR ') + e.message);
    return 1;
  }
}

if (require.main === module) process.exit(main(process.argv));
module.exports = { readManifest, loadSources, lockProblems, build, writeZip, crc32, sha256, packageJson };
