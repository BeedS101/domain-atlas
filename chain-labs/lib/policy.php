<?php
declare(strict_types=1);
// The Gold purchase policy of a coin as the Coin Creation Studio takes it, checks it and shows it. The policy itself is the schema
// of ledger_purchase_policy() (priceClass, issuerKey, unitsPerPrice, minPrice, perKeyUnits, perDayUnits), which goes into the
// signed genesis unchanged. The Studio asks for it in coins and Au; this turns that into ledger units, refuses anything the ledger
// would refuse (and a few things it would accept but nobody means), and writes out the whole policy for the operator to confirm.
// The registry keeps the policy and opening the coin uses that policy and nothing else.
// Include-only: a direct request gets a 404.
if (PHP_SAPI !== 'cli' && isset($_SERVER['SCRIPT_FILENAME']) && realpath($_SERVER['SCRIPT_FILENAME']) === __FILE__) { http_response_code(404); exit; }
require_once __DIR__ . '/market.php';

const POLICY_DEFAULT_CLASS = 'atlas.element.gold';
const POLICY_FIELDS = ['coinsPerAu', 'issuerKey', 'minPrice', 'perDay', 'perKey', 'priceClass'];

// The issuers this domain's operator has authorised to sign price credentials, from chainlabs-gold-issuers.json in the private folder:
//   {"issuers": [{"name": "...", "domain": "...", "key": "<the issuer's raw public key>", "classes": ["atlas.element.gold"]}]}
// No file means no list: any well-formed key is accepted for the default class, and the Studio says so. A file that exists but is
// unreadable authorises nothing.
function policy_allowlist(string $private): ?array
{
    $file = $private . '/chainlabs-gold-issuers.json';
    if (!is_file($file)) return null;
    $doc = json_decode((string) @file_get_contents($file), true);
    $out = [];
    foreach (is_array($doc['issuers'] ?? null) ? $doc['issuers'] : [] as $i) {
        if (!is_array($i) || !is_string($i['key'] ?? null) || !preg_match('/^[A-Za-z0-9_=-]{16,1500}$/D', $i['key'])) continue;
        $classes = array_values(array_filter(is_array($i['classes'] ?? null) ? $i['classes'] : [POLICY_DEFAULT_CLASS], fn($c) => is_string($c) && preg_match('/^[a-z][a-z0-9.]{2,63}$/D', $c)));
        if (!$classes) continue;
        $out[] = ['name' => is_string($i['name'] ?? null) ? substr($i['name'], 0, 60) : '', 'domain' => is_string($i['domain'] ?? null) ? substr($i['domain'], 0, 120) : '', 'key' => $i['key'], 'classes' => $classes];
    }
    return $out;
}

// Whether the class and key are ones the operator authorises. Without a list: the default class with any well-formed key.
function policy_authorised(array $policy, ?array $allow): ?string
{
    if ($allow === null) return $policy['priceClass'] === POLICY_DEFAULT_CLASS ? null : 'only ' . POLICY_DEFAULT_CLASS . ' can be a price class until an issuer list is configured';
    foreach ($allow as $i) if ($i['key'] === $policy['issuerKey'] && in_array($policy['priceClass'], $i['classes'], true)) return null;
    return 'this issuer key is not authorised for this price class on this domain';
}

// A decimal in coins with at most $decimals places, as whole ledger units, or null.
function policy_units(mixed $text, int $decimals, int $max): ?int
{
    if (!is_string($text) || !preg_match('/^(0|[1-9][0-9]{0,12})(?:\.([0-9]{1,6}))?$/D', $text, $m)) return null;
    $fraction = $m[2] ?? '';
    if (strlen($fraction) > $decimals || strlen($m[1]) > 13 - $decimals) return null;
    $units = (int) $m[1] * (10 ** $decimals) + (int) str_pad($fraction, $decimals, '0');
    return $units >= 1 && $units <= $max ? $units : null;
}

// Coins, written with the places the coin has.
function policy_coins(int $units, int $decimals): string
{
    if ($decimals === 0) return (string) $units;
    $s = str_pad((string) $units, $decimals + 1, '0', STR_PAD_LEFT);
    return substr($s, 0, -$decimals) . '.' . substr($s, -$decimals);
}

// $in is what the Studio form sends: coinsPerAu, minPrice, perKey, perDay (coins), priceClass, issuerKey, and nothing else.
// Returns ['policy' => the genesis policy, 'lines' => what the operator confirms, 'digest' => a fingerprint of it, 'warnings' => [...]]
// or throws a LedgerError with the first thing wrong.
function policy_normalize(mixed $in, int $decimals, int $maxUnits, int $initialUnits, string $symbol, ?array $allow): array
{
    if (!is_array($in) || array_is_list($in)) ledger_fail('bad-policy', 'the purchase policy must be an object');
    $keys = array_keys($in);
    sort($keys);
    if ($keys !== POLICY_FIELDS) ledger_fail('bad-policy', 'the purchase policy needs exactly: ' . implode(', ', POLICY_FIELDS));
    $rate = policy_units($in['coinsPerAu'], $decimals, $maxUnits);
    if ($rate === null) ledger_fail('bad-policy', 'coins per 1 Au must be a positive amount with at most ' . $decimals . ' decimals, within the maximum supply');
    $min = $in['minPrice'];
    if (!is_int($min) || $min < 1 || $min > 1000000) ledger_fail('bad-policy', 'the smallest purchase must be a whole number of Au from 1 to 1000000');
    $least = $rate * $min;
    $perKey = policy_units($in['perKey'], $decimals, $maxUnits);
    $perDay = policy_units($in['perDay'], $decimals, $maxUnits);
    if ($least > $maxUnits) ledger_fail('bad-policy', 'the smallest purchase is more than the maximum supply');
    if ($perKey === null) ledger_fail('bad-policy', 'the limit per receiving key must be a positive amount with at most ' . $decimals . ' decimals, within the maximum supply');
    if ($perDay === null) ledger_fail('bad-policy', 'the limit per 24 hours must be a positive amount with at most ' . $decimals . ' decimals, within the maximum supply');
    if ($perKey < $least) ledger_fail('bad-policy', 'the limit per receiving key is below the smallest purchase (' . policy_coins($least, $decimals) . ' ' . $symbol . ')');
    if ($perDay < $least) ledger_fail('bad-policy', 'the limit per 24 hours is below the smallest purchase (' . policy_coins($least, $decimals) . ' ' . $symbol . ')');
    if ($perKey > $perDay) ledger_fail('bad-policy', 'the limit per receiving key is above the limit per 24 hours, which no key could ever use');
    $policy = ['priceClass' => $in['priceClass'], 'issuerKey' => $in['issuerKey'], 'unitsPerPrice' => $rate, 'minPrice' => $min, 'perKeyUnits' => (string) $perKey, 'perDayUnits' => (string) $perDay];
    try {
        $policy = ledger_purchase_policy($policy, $maxUnits);
    } catch (LedgerError $e) {
        ledger_fail('bad-policy', $e->getMessage());
    }
    $refused = policy_authorised($policy, $allow);
    if ($refused !== null) ledger_fail('bad-policy', $refused);
    $issuer = '';
    foreach ($allow ?? [] as $i) if ($i['key'] === $policy['issuerKey']) $issuer = ($i['name'] !== '' ? $i['name'] : $i['domain']);
    $price = market_ratio(10 ** $decimals, $rate, 6);
    $lines = [
        'Price: 1 ' . $symbol . ' costs ' . $price . ' Au (' . policy_coins($rate, $decimals) . ' ' . $symbol . ' for 1 Au)',
        'Smallest purchase: ' . $min . ' Au = ' . policy_coins($least, $decimals) . ' ' . $symbol,
        'Most one receiving key can buy: ' . policy_coins($perKey, $decimals) . ' ' . $symbol,
        'Most sold in 24 hours: ' . policy_coins($perDay, $decimals) . ' ' . $symbol,
        'Price credential class: ' . $policy['priceClass'],
        'Gold issuer key: ' . $policy['issuerKey'] . ($issuer !== '' ? ' (' . $issuer . ')' : ($allow === null ? ' (not checked against an issuer list: none is configured)' : '')),
        'Demo Gold only; no monetary value. Written into the signed genesis and fixed once the coin is opened.',
    ];
    $warnings = [];
    if ($initialUnits < $least) $warnings[] = 'The starting treasury (' . policy_coins($initialUnits, $decimals) . ' ' . $symbol . ') is below the smallest purchase, so nothing can be sold until the treasury is larger.';
    return ['policy' => $policy, 'lines' => $lines, 'warnings' => $warnings,
        'digest' => hash('sha256', ledger_canonical(['decimals' => $decimals, 'maxUnits' => $maxUnits, 'policy' => $policy, 'symbol' => $symbol]))];
}

// A policy kept in a registry row, read back for opening: the stored text must be a valid policy of this coin and an authorised one.
function policy_from_row(array $row, ?array $allow): ?array
{
    $text = $row['purchase'] ?? null;
    if ($text === null || $text === '') return null;
    $policy = json_decode((string) $text, true);
    if (!is_array($policy)) ledger_fail('bad-policy', 'the registered purchase policy cannot be read');
    $policy = ledger_purchase_policy($policy, (int) $row['max_units']);
    $refused = policy_authorised($policy, $allow);
    if ($refused !== null) ledger_fail('bad-policy', $refused);
    return $policy;
}
