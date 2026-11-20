<?php
declare(strict_types=1);
// Looking after the operator keys of a chain labs domain from the command line. Not served over the web: a request for it gets a 404.
//
//   php operator-cli.php <command> [--private=DIR] [--domain=NAME] [options]
//
//   status                      the keys on the roster, the operator token, whether signed requests are activated, the audit chain
//   audit [--limit=N]           the newest lines of the audit table (at most 200)
//   audit-verify                whether the audit chain is intact
//   add-key --key=KEY [--label=TEXT] [--actions=a,b,c]
//                               adds a public key; without --actions the key may take every action
//   revoke --key=KEY|--fingerprint=FP
//                               marks a key revoked; a revoked key signs nothing and stays on the list so that it cannot be added again by mistake
//   remove-key --key=KEY|--fingerprint=FP
//                               takes a key off the list
//   set-token                   makes a new operator token for the period of compatibility, prints it once and stores only its SHA-256
//   clear-token                 removes the token from the roster
//
// The roster is rewritten whole, to a temporary file and renamed over the old one, with the permissions 0600. Nothing here prints a
// private key, and the roster holds only public keys and the SHA-256 of the token. Nothing here activates signed requests: that is a
// signed `operator/activate` request from a key that has proved itself (docs/chain-labs-operator-auth.md).
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require_once __DIR__ . '/operator.php';

function operator_cli_read(string $private, string $domain): array
{
    $file = operator_paths($private)['roster'];
    if (!is_file($file)) return ['domain' => $domain, 'keys' => []];
    $doc = json_decode((string) file_get_contents($file), true);
    if (!is_array($doc) || array_is_list($doc) || !isset($doc['keys']) || !is_array($doc['keys'])) throw new RuntimeException('the roster is not valid; fix it by hand before using this tool');
    if ($domain !== '' && ($doc['domain'] ?? null) !== $domain) throw new RuntimeException('the roster names another domain than --domain');
    return $doc;
}

function operator_cli_write(string $private, array $doc): void
{
    $file = operator_paths($private)['roster'];
    $json = json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR) . "\n";
    $tmp = $file . '.' . bin2hex(random_bytes(4)) . '.tmp';
    if (file_put_contents($tmp, $json, LOCK_EX) === false) throw new RuntimeException('the roster could not be written');
    @chmod($tmp, 0600);
    if (!rename($tmp, $file)) { @unlink($tmp); throw new RuntimeException('the roster could not be replaced'); }
}

function operator_cli_find(array $doc, ?string $key, ?string $fingerprint): int
{
    foreach ($doc['keys'] as $i => $entry) {
        if (!is_array($entry) || !is_string($entry['publicKey'] ?? null)) continue;
        if ($key !== null && $entry['publicKey'] === $key) return $i;
        if ($fingerprint !== null && operator_fingerprint($entry['publicKey']) === $fingerprint) return $i;
    }
    return -1;
}

function operator_cli_main(array $argv): int
{
    $out = static fn(string $t) => fwrite(STDOUT, $t . "\n");
    $err = static fn(string $t) => fwrite(STDERR, $t . "\n");
    $command = $argv[1] ?? '';
    if ($command === '' || $command === '--help' || $command === '-h') {
        $out("php operator-cli.php <status|audit|audit-verify|add-key|revoke|remove-key|set-token|clear-token> [--private=DIR] [--domain=NAME] [--key=KEY] [--fingerprint=FP] [--label=TEXT] [--actions=a,b] [--limit=N]");
        return $command === '' ? 2 : 0;
    }
    $opts = [];
    foreach (array_slice($argv, 2) as $arg) {
        if (!preg_match('/^--(private|domain|key|fingerprint|label|actions|limit)=(.*)$/Ds', $arg, $m)) { $err('unknown option'); return 2; }
        $opts[$m[1]] = $m[2];
    }
    $docroot = realpath(dirname(__DIR__, 2));
    $private = isset($opts['private']) && $opts['private'] !== '' ? realpath($opts['private']) : ($docroot !== false ? realpath(dirname($docroot) . '/chainblock-labs-private') : false);
    if ($private === false || !is_dir($private)) { $err('the private folder was not found'); return 2; }
    if ($docroot !== false && str_starts_with($private . '/', $docroot . '/')) { $err('the private folder is inside the web root'); return 2; }
    $domain = strtolower($opts['domain'] ?? '');
    try {
        if ($command === 'status') {
            $doc = operator_cli_read($private, $domain);
            if (!is_file(operator_paths($private)['roster'])) { $out('roster      none: operator actions answer 503 until chainlabs-operators.json is in the private folder'); return 0; }
            $status = operator_status($private, (string) ($doc['domain'] ?? $domain), time());
            $out('domain      ' . $status['domain']);
            $out('token       ' . ($status['tokenSet'] ? ($status['legacyOpen'] ? 'set, accepted until ' . $status['legacyUntil'] : 'set, no longer accepted') : 'none'));
            $out('activated   ' . ($status['activated'] ? 'yes: a token is refused for every action that changes something' : 'no'));
            $out('audit       ' . ($status['audit']['ok'] ? 'intact, ' . $status['audit']['lines'] . ' lines' : 'BROKEN at line ' . $status['audit']['brokenAt']));
            foreach ($status['keys'] as $k) {
                $out('key         ' . $k['fingerprint'] . '  ' . ($k['label'] !== '' ? $k['label'] : '-') . '  '
                    . ($k['revoked'] ? 'revoked' : ($k['verified'] ? 'verified' : 'not yet verified')) . '  '
                    . (is_array($k['actions']) ? implode(',', $k['actions']) : 'all actions'));
            }
            if ($status['uncovered']) $out('not covered by an active, verified key: ' . implode(', ', $status['uncovered']));
            return 0;
        }
        if ($command === 'audit' || $command === 'audit-verify') {
            $db = operator_db($private);
            $chain = operator_audit_verify($db);
            if ($command === 'audit-verify') {
                $out($chain['ok'] ? 'intact, ' . $chain['lines'] . ' lines' : 'BROKEN at line ' . $chain['brokenAt']);
                return $chain['ok'] ? 0 : 1;
            }
            foreach (array_reverse(operator_audit_read($db, (int) ($opts['limit'] ?? 50))) as $r) {
                $out(implode('  ', [$r['at'], str_pad((string) $r['event'], 8), str_pad((string) ($r['action'] ?? '-'), 24), (string) ($r['key_fp'] ?? '-'), (string) ($r['code'] ?? ''), (string) ($r['detail'] ?? '')]));
            }
            return $chain['ok'] ? 0 : 1;
        }
        if ($command === 'add-key') {
            $key = $opts['key'] ?? '';
            if (!ledger_valid_owner_key($key)) { $err('--key is not a public key'); return 2; }
            $doc = operator_cli_read($private, $domain);
            if ($domain === '' && !isset($doc['domain'])) { $err('--domain is needed to start a roster'); return 2; }
            $doc['domain'] = $doc['domain'] ?? $domain;
            if (operator_cli_find($doc, $key, null) >= 0) { $err('that key is on the roster already'); return 2; }
            $entry = ['publicKey' => $key, 'label' => substr($opts['label'] ?? '', 0, 80)];
            if (isset($opts['actions'])) {
                $list = array_values(array_unique(array_filter(array_map('trim', explode(',', $opts['actions'])), static fn($a) => $a !== '')));
                foreach ($list as $a) if (!isset(OPERATOR_ACTIONS[$a])) { $err('unknown action ' . substr($a, 0, 40)); return 2; }
                $entry['actions'] = $list;
            }
            $doc['keys'][] = $entry;
            operator_cli_write($private, $doc);
            $out('added ' . operator_fingerprint($key) . ($entry['label'] !== '' ? ' (' . $entry['label'] . ')' : '') . '; it takes effect on the next request');
            return 0;
        }
        if ($command === 'revoke' || $command === 'remove-key') {
            $doc = operator_cli_read($private, $domain);
            $i = operator_cli_find($doc, $opts['key'] ?? null, $opts['fingerprint'] ?? null);
            if ($i < 0) { $err('no such key on the roster'); return 2; }
            $fp = operator_fingerprint($doc['keys'][$i]['publicKey']);
            if ($command === 'revoke') $doc['keys'][$i]['revoked'] = true; else array_splice($doc['keys'], $i, 1);
            operator_cli_write($private, $doc);
            $out(($command === 'revoke' ? 'revoked ' : 'removed ') . $fp . '; it takes effect on the next request');
            return 0;
        }
        if ($command === 'set-token' || $command === 'clear-token') {
            $doc = operator_cli_read($private, $domain);
            if ($domain === '' && !isset($doc['domain'])) { $err('--domain is needed to start a roster'); return 2; }
            $doc['domain'] = $doc['domain'] ?? $domain;
            if ($command === 'clear-token') {
                unset($doc['legacyTokenSha256']);
                operator_cli_write($private, $doc);
                $out('the roster holds no token');
                return 0;
            }
            $token = bin2hex(random_bytes(32));
            $doc['legacyTokenSha256'] = hash('sha256', $token);
            operator_cli_write($private, $doc);
            $out('operator token (shown once; only its SHA-256 is stored):');
            $out($token);
            return 0;
        }
        $err('unknown command');
        return 2;
    } catch (Throwable $e) {
        $err('failed: ' . preg_replace('~(?:/[A-Za-z0-9._-]+){2,}~', '<path>', $e->getMessage()));
        return 2;
    }
}

exit(operator_cli_main($argv));
