<?php
declare(strict_types=1);
// For the browser test of the market page: what chain-labs/market27.php does with the answers of the domains, on JSON given on
// standard input as {"coins": [...registry entries], "stats": {"<domain>": <answer of scan35.php?action=market>}}. The page and
// the live servers are real; only the step that fetches over HTTPS from the lab hostnames is replaced by this.
require __DIR__ . '/../../chain-labs/lib/market.php';
$in = json_decode((string) stream_get_contents(STDIN), true);
$market = [];
foreach ($in['stats'] as $node => $d) {
    foreach ($d['coins'] as $m) {
        $c = market_clean($m, $node);
        if ($c !== null && !isset($market[$m['coinId']])) $market[$m['coinId']] = $c;
    }
}
[$coins, $stated] = market_attach($in['coins'], $market);
echo json_encode(['ok' => true, 'coins' => $coins, 'sources' => [['node' => 'a.example', 'available' => true], ['node' => 'b.example', 'available' => true]], 'updatedAt' => gmdate('c'), 'demo' => true, 'marketDataAvailable' => $stated > 0]);
