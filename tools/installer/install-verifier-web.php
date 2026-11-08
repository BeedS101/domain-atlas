<?php
/**
 * Test-domain-only, authenticated front-end for verified-install.php.
 *
 * Operator must provision an OUT-OF-WEBROOT settings file and set
 * ATLAS_INSTALL_SETTINGS to its absolute path in the PHP process environment.
 * Nothing is fetched from GitHub or a user-provided URL. Delete this entrypoint
 * after a test install. Do not put it on a production/live Domain Atlas site.
 */
declare(strict_types=1);

require __DIR__ . '/verified-install.php';

header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: no-store');
header('Referrer-Policy: no-referrer');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
header("Content-Security-Policy: default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");

function atlas_install_html(string $s): string {
    return htmlspecialchars($s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

function atlas_install_exit(int $status, string $message): void {
    http_response_code($status);
    echo '<!doctype html><html lang="en"><meta charset="utf-8"><title>Verifier installer</title><body>';
    echo '<h1>Domain Atlas — verified test installer</h1><p>' . atlas_install_html($message) . '</p>';
    echo '</body></html>';
    exit;
}

$settingsPath = getenv('ATLAS_INSTALL_SETTINGS');
if (!is_string($settingsPath) || $settingsPath === '' || $settingsPath[0] !== '/' ||
    !is_file($settingsPath) || is_link($settingsPath)) {
    atlas_install_exit(503, 'Installer is not privately configured.');
}
$settings = @include $settingsPath;
if (!is_array($settings)) atlas_install_exit(503, 'Installer is not privately configured.');
$tokenHash = $settings['tokenSha256'] ?? null;
$doc = isset($settings['documentRoot']) && is_string($settings['documentRoot'])
    ? realpath($settings['documentRoot']) : false;
$settingsReal = realpath($settingsPath);
if (!is_string($tokenHash) || !preg_match('/^[0-9a-f]{64}$/', $tokenHash) ||
    $doc === false || $settingsReal === false ||
    strpos($settingsReal, rtrim($doc, '/') . '/') === 0) {
    atlas_install_exit(503, 'Installer is not privately configured.');
}
// Refuse reverse-proxy supplied headers such as X-Forwarded-Proto; only trust PHP server TLS state.
$https = isset($_SERVER['HTTPS']) && in_array(strtolower((string)$_SERVER['HTTPS']), ['on', '1'], true);
$host = strtolower((string)($_SERVER['HTTP_HOST'] ?? ''));
if (!$https || $host !== ($settings['expectedHost'] ?? '')) {
    atlas_install_exit(403, 'Installer requires HTTPS on its explicitly configured test host.');
}
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($method === 'GET') {
    echo '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">';
    echo '<title>Domain Atlas verified test installer</title><body><main>';
    echo '<h1>Domain Atlas — test-only verifier installer</h1>';
    echo '<p>This installs only pinned atlas-verify 0.1.1 on an isolated test host. ';
    echo 'It never downloads code or overwrites an existing installation. Keep this page behind hosting authentication.</p>';
    echo '<form method="post" enctype="multipart/form-data">';
    echo '<p><label>One-time operator token <input type="password" name="token" autocomplete="off" required></label></p>';
    echo '<p><label>Verified atlas-verify-0.1.1.zip <input type="file" name="package" accept=".zip" required></label></p>';
    echo '<p><button type="submit" name="intent" value="check">Preflight only</button> ';
    echo '<button type="submit" name="intent" value="install">Install once on test host</button></p>';
    echo '</form><p>Remove this installer after use. Never run it on an active issuer or production domain.</p>';
    echo '</main></body></html>';
    exit;
}
if ($method !== 'POST') atlas_install_exit(405, 'Only GET and POST are supported.');
$length = (int)($_SERVER['CONTENT_LENGTH'] ?? 0);
if ($length > 400000) atlas_install_exit(413, 'Upload too large.');
$token = $_POST['token'] ?? null;
if (!is_string($token) || strlen($token) < 32 || strlen($token) > 256 ||
    !hash_equals($tokenHash, hash('sha256', $token))) {
    atlas_install_exit(403, 'Operator authentication failed.');
}
$intent = $_POST['intent'] ?? null;
if ($intent !== 'check' && $intent !== 'install') atlas_install_exit(400, 'Unknown installer action.');
$file = $_FILES['package'] ?? null;
if (!is_array($file) || ($file['error'] ?? null) !== UPLOAD_ERR_OK ||
    !isset($file['size'], $file['tmp_name']) || (int)$file['size'] > 262144 ||
    !is_string($file['tmp_name']) || !is_uploaded_file($file['tmp_name'])) {
    atlas_install_exit(400, 'A local verifier ZIP upload is required.');
}
try {
    $outcome = atlas_install_verifier($file['tmp_name'], $settings, $intent === 'install');
    $message = $outcome['status'] === 'installed'
        ? 'The pinned verifier was installed. Remove installer files and disable installer access immediately; then verify PHP configuration, HTTP file access controls, and credential behavior.'
        : 'Pinned archive and test-host preflight passed. No files were installed. Submit the ZIP again and choose Install to proceed.';
    atlas_install_exit(200, $message);
} catch (Throwable $e) {
    atlas_install_exit(400, 'Installation refused: ' . $e->getMessage());
}
