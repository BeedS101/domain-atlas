<?php
declare(strict_types=1);
// One process of the concurrency check in test/chain-labs-rollback.php: opens the ledger database file and commits a number of grants
// from the treasury as fast as it can, trying again when another process took the index first.
//   php rollback-worker.php <job.json>
require __DIR__ . '/../../chain-labs/lib/ledger.php';
$job = json_decode((string) file_get_contents($argv[1]), true);
$db = ledger_open($job['file']);
$treasury = ['key' => $job['treasuryKey'], 'private' => $job['treasuryPrivate']];
// A reader: asks the checkpoint guard for its verdict again and again while the others commit, and reports any stop it saw.
if (($job['mode'] ?? 'commit') === 'check') {
    $stops = [];
    $checks = 0;
    while (!is_file($job['stopFile'])) {
        $v = ledger_guard_check($db, $job['coin'], true, $job['now']);
        $checks++;
        if ($v['status'] === 'halted') $stops[] = $v['reason'];
        usleep(500);
    }
    echo json_encode(['checks' => $checks, 'stops' => $stops]) . "\n";
    exit(0);
}
$done = 0;
$retries = 0;
for ($i = 0; $i < $job['count']; $i++) {
    $to = ledger_new_owner_key()['key'];
    for ($attempt = 0; $attempt < 200; $attempt++) {
        try {
            $prepared = ledger_grant($db, $job['coin'], $treasury, $to, '1', $job['now']);
            ledger_commit($db, $job['coin'], $prepared, ledger_sign($job['domainPrivate'], $prepared['hash']), [], $job['now']);
            $done++;
            break;
        } catch (LedgerError $e) {
            if (!in_array($e->reason, ['wrong-index', 'wrong-prev', 'stale', 'busy', 'pending-exists'], true)) { fwrite(STDERR, $e->reason . ': ' . $e->getMessage() . "\n"); exit(2); }
            $retries++;
            usleep(random_int(1000, 8000));
        } catch (PDOException $e) {
            $retries++;
            usleep(random_int(1000, 8000));
        }
    }
}
echo json_encode(['done' => $done, 'retries' => $retries]) . "\n";
