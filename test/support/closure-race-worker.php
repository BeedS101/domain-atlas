<?php
declare(strict_types=1);
// One process of the race in test/chain-labs-purchase-closure.php: waits for the start file, then either commits the prepared delivery of a
// sale or closes the sale, against the same database file as the other process, and prints what came of it.
//   php closure-race-worker.php <job.json>
require __DIR__ . '/../../chain-labs/lib/purchase.php';
$job = json_decode((string) file_get_contents($argv[1]), true);
$db = ledger_open($job['file']);
while (!is_file($job['go'])) usleep(100);
usleep((int) ($job['delayUs'] ?? 0));
$result = 'ok';
for ($attempt = 0; $attempt < 100; $attempt++) {
    try {
        if ($job['mode'] === 'commit') ledger_commit($db, $job['coin'], $job['prepared'], $job['signature'], [], $job['now']);
        else purchase_closure($db, $job['node'], $job['row'], null);
        break;
    } catch (LedgerError $e) {
        $result = $e->reason;
        break;
    } catch (PDOException $e) {
        $result = 'locked';
        usleep(random_int(500, 4000));
    }
}
echo json_encode(['mode' => $job['mode'], 'result' => $result]) . "\n";
