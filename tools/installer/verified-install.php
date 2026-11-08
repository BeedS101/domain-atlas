<?php
/**
 * Domain Atlas atlas-verify 0.1.1 — pinned, one-time test-domain installer engine.
 * This file is a library: it does nothing when merely requested or included.
 *
 * It accepts ONLY the byte-locked Gen 1 verifier package; no arbitrary paths from
 * a browser, no remote URL fetching, no shell, no overwrites, no issuer writes.
 * PHP 7.4+ with ZipArchive is required for installation (not for verification).
 */
declare(strict_types=1);

function atlas_install_fail(string $message): void {
    throw new RuntimeException($message);
}

function atlas_install_pinned_files(): array {
    // The immutable v0.1.1 file locks from packages/atlas-verify/manifest.json.
    // Changing a package requires a deliberate installer version change, not a remote manifest.
    return [
        '.htaccess' => ['584c354de00dbbd0a029a885c526372d3b6ed1837d98208fb1ef10113bc6c6e7', 291],
        'LICENSE' => ['2969e207d9c404fa47af9adee059ac1c3ac06ab25fe564a3d841b88143ceda20', 1173],
        'README.md' => ['d8797f998bf76de54379d647a747d9da7cf7125371e0ba317ad331714cb21123', 4956],
        'VERSION' => ['80447316529fc62014fbaa047fb67c51ac30e32830cda370405349d8d66d196c', 6],
        'config.example.php' => ['a210edd57036487c3601a8f44676574bd0baaea3035ce55124e838a4e62ae0df', 1558],
        'lib/.htaccess' => ['2635c4f28759072aaf54159e7b0254113f64a43b194a2de2be7ffb04a1d16224', 206],
        'lib/atlas-verify-crypto.php' => ['6332afb3901779450fef620a96be834f718c00084a52f256bc895f5540104a5f', 6734],
        'lib/atlas-verify-fetch.php' => ['3b1d91f15ef7f9d12f5571a91d67abc72861a9bfd319718b51c335a772266afa', 3678],
        'lib/atlas-verify.php' => ['27845fce4ae30afa89119b99c59ad7113f3f13b4ebf70c5ddd7df6a0a1ef3b9c', 21880],
        'verify.php' => ['c1b3fc95a6258b7d3723d60b5350706e9a0dfff2949cd85c3d0dc6850b5300e4', 5163],
    ];
}

function atlas_install_verified_archive(string $zipPath): array {
    if (!class_exists('ZipArchive')) atlas_install_fail('PHP ZipArchive extension is required on the test server.');
    if (!is_file($zipPath) || is_link($zipPath)) atlas_install_fail('The ZIP must be a regular local file.');
    $zipSize = filesize($zipPath);
    if ($zipSize === false || $zipSize < 100 || $zipSize > 262144) atlas_install_fail('The ZIP is outside the allowed size.');
    $zip = new ZipArchive();
    if ($zip->open($zipPath, ZipArchive::CHECKCONS) !== true) atlas_install_fail('Cannot open a consistent ZIP archive.');
    try {
        $pins = atlas_install_pinned_files();
        if ($zip->numFiles !== count($pins) + 1) atlas_install_fail('ZIP has missing or extra entries.');
        $seen = [];
        $actual = [];
        for ($i = 0; $i < $zip->numFiles; $i++) {
            $stat = $zip->statIndex($i);
            if ($stat === false) atlas_install_fail('Unable to read ZIP entry metadata.');
            $name = $stat['name'];
            if (strpos($name, 'atlas-verify/') !== 0) atlas_install_fail('ZIP contains an entry outside the pinned package root.');
            $path = substr($name, strlen('atlas-verify/'));
            if ($path !== 'PACKAGE.json' && !array_key_exists($path, $pins)) {
                atlas_install_fail('ZIP contains an unexpected file.');
            }
            if (isset($seen[$path])) atlas_install_fail('ZIP contains a duplicate entry.');
            $seen[$path] = true;
            if (strlen($name) > 110 || substr($name, -1) === '/') atlas_install_fail('No directories or unusual entry names are accepted.');
            $platform = 0; $attrs = 0;
            if ($zip->getExternalAttributesIndex($i, $platform, $attrs)) {
                $type = ($attrs >> 16) & 0170000;
                if ($type !== 0 && $type !== 0100000) atlas_install_fail('ZIP contains a non-regular file.');
            }
            $max = $path === 'PACKAGE.json' ? 4000 : $pins[$path][1];
            if ($stat['size'] > $max) atlas_install_fail('A ZIP entry is oversized.');
            $data = $zip->getFromIndex($i);
            if (!is_string($data) || strlen($data) !== (int)$stat['size']) atlas_install_fail('Cannot read a ZIP entry.');
            if ($path !== 'PACKAGE.json') {
                if (strlen($data) !== $pins[$path][1] || !hash_equals($pins[$path][0], hash('sha256', $data))) {
                    atlas_install_fail('A ZIP file does not match the locked 0.1.1 content.');
                }
            }
            $actual[$path] = $data;
        }
        if (count($actual) !== count($pins) + 1) atlas_install_fail('A package entry is missing.');
        $package = json_decode($actual['PACKAGE.json'], true);
        if (!is_array($package) || ($package['format'] ?? null) !== 'domain-atlas-package/1' ||
            ($package['name'] ?? null) !== 'atlas-verify' || ($package['version'] ?? null) !== '0.1.1') {
            atlas_install_fail('Package metadata does not identify pinned atlas-verify 0.1.1.');
        }
        $metadata = $package['files'] ?? null;
        if (!is_array($metadata) || count($metadata) !== count($pins)) atlas_install_fail('Package file metadata does not match the pinned set.');
        $paths = array_keys($pins);
        foreach ($paths as $index => $path) {
            $item = $metadata[$index] ?? null;
            if (!is_array($item) || ($item['path'] ?? null) !== $path ||
                ($item['sha256'] ?? null) !== $pins[$path][0] ||
                ($item['size'] ?? null) !== $pins[$path][1]) {
                atlas_install_fail('Package metadata disagrees with locked file hashes.');
            }
        }
        // The verified package builder produces one deterministic byte-for-byte ZIP.
        // Pin that complete archive in addition to the per-file SHA-256 checks above.
        // Repacking the same PHP files with altered ZIP metadata is not an authorized release.
        $archiveHash = hash_file('sha256', $zipPath);
        if (!is_string($archiveHash) || !hash_equals('e3a431fdc124beba68e157845bcb2f7a6ad11751c7d92774dfbd021ef6a9b365', $archiveHash)) {
            atlas_install_fail('ZIP does not match the pinned reproducible 0.1.1 archive.');
        }
        // Preserve the validated PACKAGE.json bytes instead of rewriting its JSON.
        // Only trusted fixed names are ever used in filesystem paths.
        return $actual;
    } finally {
        $zip->close();
    }
}

function atlas_install_origin(string $origin): string {
    if (strlen($origin) > 255 || !preg_match('~^https://([A-Za-z0-9.-]+)(?::([0-9]{1,5}))?/?$~D', $origin, $m)) {
        atlas_install_fail('Trusted issuers must be HTTPS origins with no paths, credentials or fragments.');
    }
    $host = strtolower($m[1]);
    $labels = explode('.', $host);
    if (count($labels) < 2 || strlen($host) > 253 || filter_var($host, FILTER_VALIDATE_IP)) atlas_install_fail('Invalid issuer hostname.');
    foreach ($labels as $label) {
        if (strlen($label) < 1 || strlen($label) > 63 || !preg_match('/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/', $label)) {
            atlas_install_fail('Invalid issuer hostname.');
        }
    }
    $port = isset($m[2]) ? (int)$m[2] : 443;
    if ($port < 1 || $port > 65535) atlas_install_fail('Invalid issuer HTTPS port.');
    return 'https://' . $host . ($port === 443 ? '' : ':' . $port);
}

function atlas_install_settings(array $settings): array {
    $expectedHost = strtolower((string)($settings['expectedHost'] ?? ''));
    if (!preg_match('/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/', $expectedHost) ||
        in_array($expectedHost, ['evtec.co.za', 'www.evtec.co.za', 'domain-atlas.co.za', 'www.domain-atlas.co.za'], true)) {
        atlas_install_fail('A separate test-only host must be configured.');
    }
    $docGiven = $settings['documentRoot'] ?? '';
    $privateGiven = $settings['privateDirectory'] ?? '';
    if (!is_string($docGiven) || !is_string($privateGiven) || is_link($docGiven) || is_link($privateGiven)) {
        atlas_install_fail('Document root and private directory must be real, non-symlink directories.');
    }
    $doc = realpath($docGiven);
    $private = realpath($privateGiven);
    if ($doc === false || $private === false || !is_dir($doc) || !is_dir($private)) atlas_install_fail('Configured directories do not exist.');
    if ($doc === $private || strpos($private . '/', rtrim($doc, '/') . '/') === 0 ||
        strpos($doc . '/', rtrim($private, '/') . '/') === 0) {
        atlas_install_fail('Private directory and document root must be separate, non-nested directories.');
    }
    if (!is_writable($doc) || !is_writable($private)) atlas_install_fail('Configured directories are not writable.');
    $privateMode = fileperms($private);
    if ($privateMode === false || ($privateMode & 0077) !== 0) atlas_install_fail('Private directory must have mode 0700 (no group/other access).');
    $marker = $doc . '/.atlas-isolated-test-host';
    if (!is_file($marker) || is_link($marker) ||
        trim((string)file_get_contents($marker)) !== $expectedHost) {
        atlas_install_fail('Missing or mismatched isolated test-host marker.');
    }
    $issuers = $settings['trustedIssuers'] ?? null;
    if (!is_array($issuers) || count($issuers) < 1 || count($issuers) > 10) atlas_install_fail('Configure between 1 and 10 trusted issuer origins.');
    $trusted = [];
    foreach ($issuers as $origin) {
        if (!is_string($origin)) atlas_install_fail('Invalid trusted issuer.');
        $normalized = atlas_install_origin($origin);
        if (isset($trusted[$normalized])) atlas_install_fail('Duplicate trusted issuer.');
        $trusted[$normalized] = ['suspensions' => $settings['suspensions'] ?? 'required'];
    }
    if (!in_array($settings['suspensions'] ?? 'required', ['required', 'optional'], true)) atlas_install_fail('Invalid suspension policy.');
    return ['documentRoot' => $doc, 'privateDirectory' => $private, 'expectedHost' => $expectedHost, 'trustedIssuers' => $trusted];
}

function atlas_install_remove_stage(string $stage): void {
    if (!is_dir($stage) || is_link($stage)) return;
    foreach (['.htaccess', 'LICENSE', 'README.md', 'VERSION', 'config.example.php', 'verify.php',
        'PACKAGE.json', 'config.php', 'lib/.htaccess', 'lib/atlas-verify-crypto.php',
        'lib/atlas-verify-fetch.php', 'lib/atlas-verify.php'] as $file) {
        if (is_file($stage . '/' . $file)) unlink($stage . '/' . $file);
    }
    if (is_dir($stage . '/lib')) rmdir($stage . '/lib');
    rmdir($stage);
}

/**
 * @param bool $execute false = full read-only preflight; true = one-time install
 * @return array fixed, safe status metadata; never returns config paths or secret tokens to a browser
 */
function atlas_install_verifier(string $zipPath, array $settings, bool $execute = false): array {
    $cfg = atlas_install_settings($settings);
    $contents = atlas_install_verified_archive($zipPath);
    $target = $cfg['documentRoot'] . '/atlas-verify';
    $privateFile = $cfg['privateDirectory'] . '/verify-config.php';
    if (file_exists($target) || is_link($target) || file_exists($privateFile) || is_link($privateFile)) {
        atlas_install_fail('Installation refused: verifier directory or private configuration already exists; no overwrites.');
    }
    if (!$execute) return ['status' => 'ready', 'package' => 'atlas-verify', 'version' => '0.1.1', 'fileCount' => count($contents) + 1];

    $lock = $cfg['privateDirectory'] . '/.atlas-verify-install.lock';
    $fp = fopen($lock, 'c');
    if ($fp === false) atlas_install_fail('Unable to acquire installer lock.');
    chmod($lock, 0600);
    if (!flock($fp, LOCK_EX)) { fclose($fp); atlas_install_fail('Unable to lock installer.'); }
    $stage = '';
    $madePrivate = false;
    try {
        if (file_exists($target) || is_link($target) || file_exists($privateFile) || is_link($privateFile)) {
            atlas_install_fail('Another installation exists; nothing overwritten.');
        }
        $stage = $cfg['documentRoot'] . '/.atlas-verify-stage-' . bin2hex(random_bytes(16));
        if (!mkdir($stage, 0700)) atlas_install_fail('Cannot create installation staging directory.');
        if (!mkdir($stage . '/lib', 0700)) atlas_install_fail('Cannot create library directory.');
        foreach ($contents as $path => $data) {
            $dest = $stage . '/' . $path;
            if (file_put_contents($dest, $data, LOCK_EX) !== strlen($data)) atlas_install_fail('Writing a staged package file failed.');
            chmod($dest, 0644);
        }
        $config = [
            'trustedIssuers' => $cfg['trustedIssuers'],
            'allowedOrigins' => [],
            'accessTokenSha256' => null,
            'maxBodyBytes' => 262144,
            'allowInsecureLoopback' => false,
        ];
        $privateText = "<?php\n// Generated by the verified one-time test-domain installer.\nreturn " . var_export($config, true) . ";\n";
        $stubText = "<?php\nreturn require " . var_export($privateFile, true) . ";\n";
        $stub = $stage . '/config.php';
        if (file_put_contents($stub, $stubText, LOCK_EX) !== strlen($stubText)) atlas_install_fail('Writing staged config stub failed.');
        chmod($stub, 0644);
        $oldMask = umask(0077);
        try { $out = fopen($privateFile, 'x'); } finally { umask($oldMask); }
        if ($out === false) atlas_install_fail('Cannot exclusively create private configuration.');
        $madePrivate = true;
        $n = fwrite($out, $privateText);
        fclose($out);
        chmod($privateFile, 0600);
        if ($n !== strlen($privateText)) atlas_install_fail('Private configuration write failed.');
        // Same directory/volume for staging and target: one atomic rename, never overlay existing target.
        if (file_exists($target) || is_link($target)) atlas_install_fail('Target appeared during installation.');
        if (!rename($stage, $target)) atlas_install_fail('Cannot atomically publish the verified package.');
        $stage = '';
        return ['status' => 'installed', 'package' => 'atlas-verify', 'version' => '0.1.1', 'fileCount' => count($contents) + 1];
    } catch (Throwable $e) {
        if ($stage !== '') atlas_install_remove_stage($stage);
        if ($madePrivate && is_file($privateFile)) unlink($privateFile);
        throw $e;
    } finally {
        flock($fp, LOCK_UN);
        fclose($fp);
    }
}
