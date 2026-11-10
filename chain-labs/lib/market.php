<?php
declare(strict_types=1);
// The figures of the market page, read from a domain's own ledger for the coins it is the authority of. Include-only: a direct
// request gets a 404. Nothing here writes, and nothing here is made up: a figure that has no source is null.
//   issued supply     the units the genesis put into the ledger; a coin has no other way to gain units
//   treasury          the units the treasury account holds now
//   circulating       issued minus treasury: the units held by anyone else
//   offer             the purchase policy of the genesis, when the coin has one, and whether a buyer can use it right now
//   price             what one whole coin costs under an available offer, in Gold (Au)
//   market cap        circulating supply times that price, so it exists only when the price does
//   24h volume        the price paid in the purchases (entries that carry a purchase reference) that the log dates within
//                     the last 24 hours; grants and ordinary transfers carry none and never count
// Gold (Au) is the demo price currency of the purchase policy (`atlas.element.gold`); it has no monetary value.
if (PHP_SAPI !== 'cli' && isset($_SERVER['SCRIPT_FILENAME']) && realpath($_SERVER['SCRIPT_FILENAME']) === __FILE__) { http_response_code(404); exit; }
require_once __DIR__ . '/ledger.php';

const MARKET_SCAN_MAX = 500;
const MARKET_WINDOW_SECONDS = 86400;

// $num / $den rounded half up to $places decimals, written without trailing zeros. 64 bit integers are enough for the sizes
// here (units up to 10^12 and at most 6 places).
function market_ratio(int $num, int $den, int $places): string
{
    if ($den < 1 || $num < 0 || $places < 0 || $places > 6) throw new InvalidArgumentException('bad ratio');
    $scale = 10 ** $places;
    $q = intdiv($num, $den);
    $r = $num % $den;
    $frac = intdiv($r * $scale * 2 + $den, $den * 2);
    if ($frac >= $scale) { $q++; $frac -= $scale; }
    if ($places === 0 || $frac === 0) return (string) $q;
    return $q . '.' . rtrim(str_pad((string) $frac, $places, '0', STR_PAD_LEFT), '0');
}

// Whether this domain has the code that holds price credentials. Without it no purchase can be made, whatever a genesis says.
function market_purchases_ready(string $private): bool
{
    return is_file($private . '/gold-adapter.php');
}

// The purchases the log dates within the window, newest first, from the public form of the entries. The scan stops at the
// first entry older than the window (entry times never go back), or after MARKET_SCAN_MAX entries; then `complete` is false and
// the figures are a lower bound.
function market_volume(PDO $db, string $coinId, int $now): array
{
    $cutoff = $now - MARKET_WINDOW_SECONDS;
    $q = $db->prepare('SELECT idx,public_json FROM ledger_log WHERE coin_id=? ORDER BY idx DESC LIMIT ' . MARKET_SCAN_MAX);
    $q->execute([$coinId]);
    $gold = 0;
    $units = 0;
    $count = 0;
    $seen = 0;
    $reachedOlder = false;
    $last = null;
    foreach ($q->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $seen++;
        $last = (int) $row['idx'];
        $e = json_decode($row['public_json'], true);
        $at = is_array($e) && is_string($e['executedAt'] ?? null) ? strtotime($e['executedAt']) : false;
        if ($at === false || $at < $cutoff) { $reachedOlder = true; break; }
        $p = $e['purchase'] ?? null;
        if (!is_array($p) || !is_int($p['price'] ?? null) || !is_string($e['amount'] ?? null) || !ctype_digit($e['amount'])) continue;
        $gold += $p['price'];
        $units += (int) $e['amount'];
        $count++;
    }
    return ['gold' => $gold, 'units' => $units, 'purchases' => $count, 'complete' => $reachedOlder || $last === 0 || $seen < MARKET_SCAN_MAX];
}

// The offer of a coin, or null when its genesis has no purchase policy.
function market_offer(array $coin, ?int $treasuryUnits, bool $ready, array $volume): ?array
{
    $g = $coin['genesis'];
    $policy = $g['purchase'] ?? null;
    if (!is_array($policy)) return null;
    $rate = (int) $policy['unitsPerPrice'];
    $least = $rate * (int) $policy['minPrice'];
    $left = (int) $policy['perDayUnits'] - $volume['units'];
    $why = $coin['state'] !== 'active' ? 'the coin is ' . $coin['state'] : (!$ready ? 'this domain has no Gold adapter' : ($treasuryUnits === null || $treasuryUnits < $least ? 'the treasury holds less than the smallest purchase'
        : ($left < $least ? 'the limit for 24 hours is used up' : null)));
    return ['available' => $why === null, 'unavailableBecause' => $why, 'priceClass' => $policy['priceClass'], 'unitsPerPrice' => $rate, 'minPrice' => (int) $policy['minPrice'],
        'smallestUnits' => (string) $least, 'perKeyUnits' => $policy['perKeyUnits'], 'perDayUnits' => $policy['perDayUnits'], 'perDayLeftUnits' => (string) max(0, $left)];
}

// All figures of one coin. $now is the time the window ends at.
function market_coin(PDO $db, string $coinId, bool $ready, int $now): array
{
    $coin = ledger_coin($db, $coinId);
    $g = $coin['genesis'];
    $t = $db->prepare('SELECT units FROM ledger_accounts WHERE coin_id=? AND ref=?');
    $t->execute([$coinId, $g['treasuryRef']]);
    $held = $t->fetchColumn();
    $treasury = $held === false ? null : (int) $held;
    $issued = (int) $g['initialUnits'];
    $circulating = $treasury === null || $treasury > $issued ? null : $issued - $treasury;
    $hasPolicy = is_array($g['purchase'] ?? null);
    $volume = $hasPolicy ? market_volume($db, $coinId, $now) : null;
    $offer = market_offer($coin, $treasury, $ready, $volume ?? ['units' => 0]);
    $price = null;
    $cap = null;
    if ($offer !== null && $offer['available']) {
        $rate = $offer['unitsPerPrice'];
        $price = ['gold' => market_ratio(10 ** (int) $g['decimals'], $rate, 6)];
        if ($circulating !== null) $cap = ['gold' => market_ratio($circulating, $rate, 2)];
    }
    return ['coinId' => $coinId, 'symbol' => $g['symbol'], 'name' => $g['name'], 'decimals' => (int) $g['decimals'], 'mode' => $g['mode'], 'visibility' => $g['visibility'],
        'state' => $coin['state'], 'authority' => $g['authority'], 'unit' => 'Au',
        'issuedUnits' => (string) $issued, 'treasuryUnits' => $treasury === null ? null : (string) $treasury, 'circulatingUnits' => $circulating === null ? null : (string) $circulating,
        'offer' => $offer, 'price' => $price, 'marketCap' => $cap,
        'volume24h' => $volume === null ? null : ['gold' => (string) $volume['gold'], 'units' => (string) $volume['units'], 'purchases' => $volume['purchases'], 'complete' => $volume['complete']]];
}

// ---------- the page's side: what a domain states about its coins, checked before it is shown ----------

function market_digits(mixed $v, int $max = 13): ?string
{
    return is_string($v) && preg_match('/^(0|[1-9][0-9]{0,' . ($max - 1) . '})$/D', $v) ? $v : null;
}

function market_gold(mixed $v): ?string
{
    return is_string($v) && preg_match('/^(0|[1-9][0-9]{0,12})(?:\.[0-9]{1,6})?$/D', $v) ? $v : null;
}

// One coin as stated by $node, or null when it is not acceptable: it must be the authority's own statement, and each figure
// must have the shape this page can show. A price exists only under an offer the authority says is available, a market cap only
// next to a price, and a figure that fails its shape check is dropped rather than repaired.
function market_clean(array $m, string $node): ?array
{
    if (!is_string($m['coinId'] ?? null) || !preg_match('/^[a-f0-9]{32}$/D', $m['coinId']) || ($m['authority'] ?? null) !== $node || !in_array($m['state'] ?? null, ['active', 'frozen'], true)) return null;
    $issued = market_digits($m['issuedUnits'] ?? null);
    if ($issued === null) return null;
    $out = ['authority' => $node, 'state' => $m['state'], 'mode' => in_array($m['mode'] ?? null, ['single', 'multi'], true) ? $m['mode'] : null, 'issuedUnits' => $issued,
        'treasuryUnits' => market_digits($m['treasuryUnits'] ?? null), 'circulatingUnits' => market_digits($m['circulatingUnits'] ?? null), 'unit' => 'Au',
        'offer' => null, 'price' => null, 'marketCap' => null, 'volume24h' => null];
    $o = $m['offer'] ?? null;
    if (is_array($o) && is_bool($o['available'] ?? null)) {
        $out['offer'] = ['available' => $o['available'], 'unavailableBecause' => is_string($o['unavailableBecause'] ?? null) ? substr($o['unavailableBecause'], 0, 80) : null,
            'smallestUnits' => market_digits($o['smallestUnits'] ?? null), 'minPrice' => is_int($o['minPrice'] ?? null) ? $o['minPrice'] : null,
            'unitsPerPrice' => is_int($o['unitsPerPrice'] ?? null) ? $o['unitsPerPrice'] : null];
        if ($o['available'] === true) {
            $price = is_array($m['price'] ?? null) ? market_gold($m['price']['gold'] ?? null) : null;
            $cap = is_array($m['marketCap'] ?? null) ? market_gold($m['marketCap']['gold'] ?? null) : null;
            if ($price !== null) $out['price'] = ['gold' => $price];
            if ($price !== null && $cap !== null) $out['marketCap'] = ['gold' => $cap];
            // An offer the page cannot price is not offered.
            if ($price === null || $out['offer']['smallestUnits'] === null || $out['offer']['minPrice'] === null) $out['offer']['available'] = false;
        }
    }
    $v = $m['volume24h'] ?? null;
    if (is_array($v)) {
        $gold = market_gold($v['gold'] ?? null);
        $units = market_digits($v['units'] ?? null);
        if ($gold !== null && $units !== null && is_int($v['purchases'] ?? null) && $v['purchases'] >= 0 && is_bool($v['complete'] ?? null)) {
            $out['volume24h'] = ['gold' => $gold, 'units' => $units, 'purchases' => $v['purchases'], 'complete' => $v['complete']];
        }
    }
    return $out;
}

// Puts each coin's figures next to its registry entry: only when the coin's issuing domain is the one that states them.
// Returns the coins and how many have figures.
function market_attach(array $coins, array $byId): array
{
    $stated = 0;
    foreach ($coins as &$c) {
        $m = $byId[$c['id']] ?? null;
        $c['market'] = $m !== null && $m['authority'] === $c['domain'] ? $m : null;
        if ($c['market'] !== null) $stated++;
    }
    unset($c);
    return [$coins, $stated];
}
