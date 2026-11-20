<?php
declare(strict_types=1);
// One process of the race in test/chain-labs-audit-witness.php: waits for the start file, then answers one peer request (an approval of a
// delivery entry, or a request to witness that its sale is closed) against the same database file as the other process, and prints what came of it.
// The other domains of the cluster are reached through the same in-process transport the tests use, from their database files.
//   php approval-race-worker.php <job.json>
require __DIR__ . '/multi-cluster.php';
require __DIR__ . '/../../chain-labs/lib/purchase.php';
require __DIR__ . '/gold-stand-in.php';
$job = json_decode((string) file_get_contents($argv[1]), true);
$NOW = time();
foreach ($job['cluster'] as $domain => $member) {
    // The domains that only check price credentials hold the issuer's public key and nothing else.
    $member['node']['gold'] = stand_in_gold(tempnam(sys_get_temp_dir(), 'gold-') . '.sqlite', ['public' => $job['issuer']]);
    $CLUSTER[$domain] = ['node' => $member['node'], 'file' => $member['file'], 'db' => ledger_open($member['file'])];
}
$db = $CLUSTER[$job['domain']]['db'];
while (!is_file($job['go'])) usleep(100);
usleep((int) ($job['delayUs'] ?? 0));
$result = 'ok';
for ($attempt = 0; $attempt < 100; $attempt++) {
    try {
        peer_handle($db, $CLUSTER[$job['domain']]['node'], $job['envelope'], time(), 'transport');
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
