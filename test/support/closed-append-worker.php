<?php
declare(strict_types=1);
// One writer of the concurrency check in test/chain-labs-audit-checkpoint-readers.php: appends closed-sale records to one file while the
// parent reads it.
//   php closed-append-worker.php <file> <coin> <count> <tag>
require __DIR__ . '/../../chain-labs/lib/checkpoint.php';
require_once __DIR__ . '/../../chain-labs/lib/ledger.php';
[, $file, $coin, $count, $tag] = $argv;
for ($i = 0; $i < (int) $count; $i++) {
    guard_append($file, ['v' => 1, 'kind' => 'close', 'coinId' => $coin, 'requestId' => $tag . str_pad((string) $i, 4, '0', STR_PAD_LEFT) . str_repeat('0', 24), 'at' => 1]);
}
