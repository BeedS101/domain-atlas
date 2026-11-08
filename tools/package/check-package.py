#!/usr/bin/env python3
"""Independent check of a package built by build-package.js.

    python3 -I tools/package/check-package.py <manifest.json> <package.zip> [--repo <dir>]

It shares no code with the builder. From the manifest and the repository sources it recomputes every hash, re-reads the
ZIP structure byte by byte, compares the .zip.sha256 and .files.sha256 files, and rebuilds the archive from scratch with
its own writer; the rebuilt bytes must equal the archive. Exit code 0 only if every check passes.
"""
import hashlib
import json
import os
import struct
import sys
import zipfile
import zlib

FORMAT = 'domain-atlas-package-manifest/1'
PACKAGE_FORMAT = 'domain-atlas-package/1'
DOS_DATE = 0x0021
failures = []


def check(ok, text):
    print(('PASS ' if ok else 'FAIL ') + text)
    if not ok:
        failures.append(text)
    return ok


def sha(data):
    return hashlib.sha256(data).hexdigest()


def parse_zip(data):
    """Reads local headers and the central directory directly. Returns a list of entry dicts."""
    eocd = data.rfind(b'PK\x05\x06')
    if eocd < 0 or len(data) - eocd != 22:
        raise ValueError('end of central directory missing or has a comment')
    _, disk, cd_disk, n_disk, n_total, cd_size, cd_off, comment = struct.unpack('<IHHHHIIH', data[eocd:eocd + 22])
    if disk or cd_disk or n_disk != n_total or comment:
        raise ValueError('multi-disk or commented archive')
    if cd_off + cd_size != eocd:
        raise ValueError('central directory does not end where the end record starts')
    entries = []
    pos = cd_off
    for _ in range(n_total):
        (sig, made, need, flags, method, mtime, mdate, crc, csize, usize, nlen, xlen, clen, dstart, iattr, eattr,
         lho) = struct.unpack('<IHHHHHHIIIHHHHHII', data[pos:pos + 46])
        if sig != 0x02014B50:
            raise ValueError('bad central header')
        name = data[pos + 46:pos + 46 + nlen].decode('ascii')
        entries.append(dict(name=name, made=made, need=need, flags=flags, method=method, mtime=mtime, mdate=mdate,
                            crc=crc, csize=csize, usize=usize, xlen=xlen, clen=clen, dstart=dstart, iattr=iattr,
                            eattr=eattr, lho=lho))
        pos += 46 + nlen + xlen + clen
    if pos != eocd:
        raise ValueError('trailing bytes in central directory')
    expected_offset = 0
    for e in entries:
        if e['lho'] != expected_offset:
            raise ValueError('gap or overlap before ' + e['name'])
        (sig, need, flags, method, mtime, mdate, crc, csize, usize, nlen, xlen) = struct.unpack('<IHHHHHIIIHH', data[e['lho']:e['lho'] + 30])
        if sig != 0x04034B50:
            raise ValueError('bad local header for ' + e['name'])
        name = data[e['lho'] + 30:e['lho'] + 30 + nlen].decode('ascii')
        if name != e['name'] or (need, flags, method, mtime, mdate, crc, csize, usize, xlen) != (e['need'], e['flags'], e['method'], e['mtime'], e['mdate'], e['crc'], e['csize'], e['usize'], 0):
            raise ValueError('local header disagrees with central header for ' + e['name'])
        start = e['lho'] + 30 + nlen
        e['data'] = data[start:start + csize]
        expected_offset = start + csize
    if expected_offset != cd_off:
        raise ValueError('bytes between the last entry and the central directory')
    return entries


def build_zip(entries):
    """entries: sorted list of (name, bytes). Stored, 1980-01-01, mode 0644, no extras."""
    body = b''
    central = b''
    for name, payload in entries:
        n = name.encode('ascii')
        crc = zlib.crc32(payload) & 0xFFFFFFFF
        local = struct.pack('<IHHHHHIIIHH', 0x04034B50, 20, 0, 0, 0, DOS_DATE, crc, len(payload), len(payload), len(n), 0) + n
        central += struct.pack('<IHHHHHHIIIHHHHHII', 0x02014B50, 0x0314, 20, 0, 0, 0, DOS_DATE, crc, len(payload),
                               len(payload), len(n), 0, 0, 0, 0, (0o100644 << 16), len(body)) + n
        body += local + payload
    end = struct.pack('<IHHHHIIH', 0x06054B50, 0, 0, len(entries), len(entries), len(central), len(body), 0)
    return body + central + end


def main():
    args = sys.argv[1:]
    repo = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
    if '--repo' in args:
        i = args.index('--repo')
        repo = os.path.abspath(args[i + 1])
        del args[i:i + 2]
    if len(args) != 2:
        print(__doc__)
        return 2
    manifest_path, zip_path = args
    manifest = json.load(open(manifest_path, encoding='utf-8'))
    check(manifest.get('format') == FORMAT, 'manifest format is ' + FORMAT)
    name, version, root = manifest['name'], manifest['version'], manifest['root']
    check(root == name, 'root folder equals the package name')
    base = '%s-%s' % (name, version)
    check(os.path.basename(zip_path) == base + '.zip', 'archive is named ' + base + '.zip')

    # 1. sources match the lock, independently re-hashed
    listed = manifest['files']
    check([f['path'] for f in listed] == sorted(f['path'] for f in listed), 'manifest paths are sorted')
    check(len({f['path'] for f in listed}) == len(listed), 'manifest paths are unique')
    sources = {}
    for f in listed:
        src = os.path.realpath(os.path.join(repo, f['source']))
        inside = src.startswith(os.path.realpath(repo) + os.sep)
        data = open(src, 'rb').read() if inside and os.path.isfile(src) else b''
        sources[f['path']] = data
        check(inside and sha(data) == f['sha256'] and len(data) == f['size'], 'source matches lock: ' + f['path'])
    check(sources.get('VERSION', b'').decode().strip() == version, 'VERSION file equals the manifest version')

    # 2. archive structure, read without a ZIP library
    archive = open(zip_path, 'rb').read()
    try:
        entries = parse_zip(archive)
    except ValueError as exc:
        check(False, 'archive structure: ' + str(exc))
        return 1
    check(True, 'archive structure: contiguous entries, no extras, no comment')
    names = [e['name'] for e in entries]
    check(names == sorted(names), 'entries are sorted')
    check(all(e['method'] == 0 and e['flags'] == 0 and e['xlen'] == 0 and e['clen'] == 0 for e in entries), 'every entry is stored, with no flags, extras or comments')
    check(all(e['mdate'] == DOS_DATE and e['mtime'] == 0 for e in entries), 'every timestamp is 1980-01-01 00:00:00')
    check(all(e['eattr'] == (0o100644 << 16) for e in entries), 'every entry is a regular file with mode 0644')
    check(all(zlib.crc32(e['data']) & 0xFFFFFFFF == e['crc'] and len(e['data']) == e['usize'] for e in entries), 'CRC-32 and sizes agree with the data')
    check(all(n.startswith(root + '/') and not n.endswith('/') and '..' not in n.split('/') and not n.startswith('/') and '\\' not in n for n in names), 'every entry is a file under ' + root + '/')
    check(len(set(names)) == len(names), 'no duplicate entry names')
    try:
        check(zipfile.ZipFile(zip_path).testzip() is None, 'the standard zipfile reader accepts the archive')
    except zipfile.BadZipFile as exc:
        check(False, 'the standard zipfile reader accepts the archive: ' + str(exc))

    # 3. contents are exactly the manifest plus the generated PACKAGE.json
    expected = {root + '/' + p for p in sources} | {root + '/PACKAGE.json'}
    check(set(names) == expected, 'archive holds exactly the listed files plus PACKAGE.json')
    by_name = {e['name']: e['data'] for e in entries}
    check(all(by_name.get(root + '/' + p) == d for p, d in sources.items()), 'every archived file is byte-identical to its source')
    try:
        info = json.loads(by_name[root + '/PACKAGE.json'].decode('utf-8'))
        want = {'format': PACKAGE_FORMAT, 'name': name, 'version': version,
                'files': [{'path': p, 'sha256': sha(d), 'size': len(d)} for p, d in sources.items()]}
        check(info == want, 'PACKAGE.json lists every file with the right hash and size')
    except (KeyError, ValueError):
        check(False, 'PACKAGE.json is present and valid')

    # 4. the published SHA-256 files
    zip_line = open(zip_path + '.sha256', encoding='ascii').read()
    check(zip_line == '%s  %s.zip\n' % (sha(archive), base), '.zip.sha256 matches the archive')
    files_path = os.path.join(os.path.dirname(os.path.abspath(zip_path)), base + '.files.sha256')
    files_text = open(files_path, encoding='ascii').read()
    want_files = ''.join('%s  %s\n' % (sha(e['data']), e['name']) for e in entries)
    check(files_text == want_files, '.files.sha256 matches every file inside the archive')

    # 5. rebuild from scratch, byte for byte
    rebuilt_entries = {root + '/' + p: d for p, d in sources.items()}
    rebuilt_entries[root + '/PACKAGE.json'] = by_name.get(root + '/PACKAGE.json', b'')
    rebuilt = build_zip(sorted(rebuilt_entries.items()))
    check(rebuilt == archive, 'archive rebuilt independently is byte-identical (sha256 %s)' % sha(rebuilt)[:16])

    print('\n%d check(s) failed' % len(failures) if failures else '\nall checks passed')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
