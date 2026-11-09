<?php
declare(strict_types=1);
// Domains and peers for the chain labs. Include-only: a direct request for this file gets a 404.
if (PHP_SAPI !== 'cli' && isset($_SERVER['SCRIPT_FILENAME']) && realpath($_SERVER['SCRIPT_FILENAME']) === __FILE__) { http_response_code(404); exit; }

// The domains the labs answer for when no configuration file exists, and the only pair that peers by default.
const CHAINLABS_DEFAULT_HOSTS = ['evtec.co.za', 'domain-atlas.co.za'];
const CHAINLABS_MAX_HOSTS = 5;
const CHAINLABS_CONFIG_MAX_BYTES = 8192;

// Where the optional configuration lives: CHAINLABS_CONFIG if set, otherwise chainlabs-config.json in the private
// folder beside the web root. A private folder inside the web root is never used.
function chainlabs_config_file(): ?string
{
    $set = getenv('CHAINLABS_CONFIG');
    if (is_string($set) && $set !== '') return $set;
    $root = realpath($_SERVER['DOCUMENT_ROOT'] ?? '');
    if (!$root) return null;
    $private = realpath(dirname($root) . '/chainblock-labs-private');
    if (!$private || str_starts_with($private . '/', $root . '/')) return null;
    return $private . '/chainlabs-config.json';
}

// { "hosts": ["a.example", "b.example"], "peers": { "a.example": "b.example", "b.example": "a.example" } }
// `hosts` is one to five lower-case host names without ports. `peers` is optional; without it two hosts peer with each
// other and any other number of hosts has no peers. A file that exists but is invalid leaves no hosts at all, so every
// lab refuses every request, instead of falling back to the defaults.
function chainlabs_config(): array
{
    static $config = null;
    if ($config !== null) return $config;
    $failed = ['hosts' => [], 'peers' => []];
    $file = chainlabs_config_file();
    if ($file === null || !is_file($file)) {
        return $config = ['hosts' => CHAINLABS_DEFAULT_HOSTS, 'peers' => chainlabs_default_peers(CHAINLABS_DEFAULT_HOSTS)];
    }
    $raw = @file_get_contents($file, false, null, 0, CHAINLABS_CONFIG_MAX_BYTES + 1);
    $doc = is_string($raw) && strlen($raw) <= CHAINLABS_CONFIG_MAX_BYTES ? json_decode($raw, true) : null;
    $hosts = is_array($doc) && isset($doc['hosts']) && is_array($doc['hosts']) && array_is_list($doc['hosts']) ? $doc['hosts'] : null;
    $valid = $hosts !== null && count($hosts) >= 1 && count($hosts) <= CHAINLABS_MAX_HOSTS && count(array_unique($hosts)) === count($hosts);
    if ($valid) foreach ($hosts as $h) if (!is_string($h) || !preg_match('/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/D', $h)) { $valid = false; break; }
    $peers = null;
    if ($valid && isset($doc['peers'])) {
        $peers = is_array($doc['peers']) && !array_is_list($doc['peers']) ? $doc['peers'] : null;
        $valid = $peers !== null;
        if ($valid) foreach ($peers as $h => $p) if (!in_array((string) $h, $hosts, true) || !is_string($p) || !in_array($p, $hosts, true) || $p === (string) $h) { $valid = false; break; }
    }
    if (!$valid) {
        error_log('chain-labs: ' . $file . ' is not a valid configuration; no host will be answered');
        return $config = $failed;
    }
    return $config = ['hosts' => $hosts, 'peers' => $peers ?? chainlabs_default_peers($hosts)];
}

function chainlabs_default_peers(array $hosts): array
{
    return count($hosts) === 2 ? [$hosts[0] => $hosts[1], $hosts[1] => $hosts[0]] : [];
}

// The host names the labs answer for.
function chainlabs_hosts(): array
{
    return chainlabs_config()['hosts'];
}

function chainlabs_is_host(string $host): bool
{
    return in_array($host, chainlabs_config()['hosts'], true);
}

// Host => the one domain it exchanges messages with, for the two-domain labs. Hosts with no peer are absent.
function chainlabs_peer_map(): array
{
    return chainlabs_config()['peers'];
}
