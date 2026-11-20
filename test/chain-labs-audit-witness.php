<?php
declare(strict_types=1);
// Reproduction: a partner that approved a purchase entry witnesses the cancellation of the same sale after its database went back.
// `approve` lines in the checkpoint log are the memory that outlasts the database (peer_on_approve reads them through
// ledger_approval_memory), but peer_on_close_sale decides from the ledger_purchase_approvals table alone.
//
//   php test/chain-labs-audit-witness.php
require __DIR__ . '/support/multi-cluster.php';
require __DIR__ . '/../chain-labs/lib/purchase.php';
require __DIR__ . '/support/gold-stand-in.php';

$NOW = time();
$ISSUER = stand_in_issuer();
function terms(): array
{
    global $ISSUER;
    return ['priceClass' => 'atlas.element.gold', 'issuerKey' => $ISSUER['issuerKey'], 'unitsPerPrice' => 10, 'minPrice' => 5, 'perKeyUnits' => '2000', 'perDayUnits' => '3000'];
}
function gold_for(array $issuer, bool $seller): array
{
    return stand_in_gold(tempnam(sys_get_temp_dir(), 'gold-') . '.sqlite', $seller ? $issuer : ['public' => $issuer['public']]);
}
function snapshot_of(PDO $db): string
{
    $dest = tempnam(sys_get_temp_dir(), 'witness-backup-');
    unlink($dest);
    $db->exec("VACUUM INTO '" . $dest . "'");
    return $dest;
}
function put_back(string $domain, string $backup): void
{
    global $CLUSTER;
    $file = $CLUSTER[$domain]['file'];
    $CLUSTER[$domain]['db'] = null;
    foreach (['', '-wal', '-shm'] as $suffix) @unlink($file . $suffix);
    copy($backup, $file);
    $CLUSTER[$domain]['db'] = ledger_open($file);
}

echo "== a partner approved the delivery entry, the authority did not commit it\n";
cluster(3);
$c = open_coin(3, 2, 'public', null, 'MUL', terms());
open_now($c);
foreach (array_keys($CLUSTER) as $d) $CLUSTER[$d]['node']['gold'] = gold_for($ISSUER, false);
$gold = gold_for($ISSUER, true);
$CLUSTER['a.example']['node']['gold'] = $gold;
$ctx = ['db' => ndb('a.example'), 'coin' => $c['coin'], 'node' => $CLUSTER['a.example']['node'], 'treasury' => ['key' => $c['treasury']['key'], 'private' => $c['treasury']['priv']], 'gold' => $gold];
$GIVEN = [];
$release = $gold['release'];
$ctx['gold']['release'] = function (string $requestId, string $credentialId = '', ?callable $closure = null) use ($release, &$GIVEN): void {
    if ($closure !== null) $GIVEN[$requestId] = $closure();
    $release($requestId, $credentialId, $closure);
};
$buyer = owner();
$credential = stand_in_credential($ISSUER, $buyer['key'], 100);
$rid = bin2hex(random_bytes(16));
$intent = stand_in_intent($buyer, $c['coin'], $credential, 20, $rid, null, $NOW + 300, ledger_binding($ctx['db'], $c['coin']));

$bBefore = snapshot_of(ndb('b.example'));
$taken = null;
$send = function (string $to, array $env) use (&$taken) {
    $answer = transport($to, $env);
    if ($to === 'b.example' && $env['payload']['action'] === 'approve') {
        $taken = ['signature' => $answer['signature'], 'prepared' => $env['payload']['body']['prepared']];
        throw new RuntimeException('the authority stops after b approved');
    }
    return $answer;
};
try { purchase_submit($ctx['db'], $ctx['node'], $ctx['gold'], $ctx['treasury'], $c['coin'], $intent, $credential, $send, $NOW); } catch (RuntimeException $e) {}
t($taken !== null, 'b approved an entry delivering the sale and the authority holds its signature');
$rowsB = fn() => (int) ndb('b.example')->query("SELECT COUNT(*) FROM ledger_purchase_approvals WHERE request_id='" . $rid . "'")->fetchColumn();
$logB = $CLUSTER['b.example']['file'] . '.checkpoints/' . $c['coin'] . '.log';
t($rowsB() === 1 && is_file($logB) && str_contains((string) file_get_contents($logB), '"kind":"approve"'), 'b has the approval in its database and in its checkpoint log');
$aAtApproval = snapshot_of($ctx['db']);

echo "\n== b is put back to a copy from before it approved\n";
put_back('b.example', $bBefore);
t($rowsB() === 0, 'its database has no approval row for the request any more');
$memory = ledger_approval_memory(ndb('b.example'), $c['coin'], $taken['prepared']['public']['index']);
t(isset($memory[$taken['prepared']['hash']]), 'its checkpoint log still remembers having approved that entry (ledger_approval_memory)');
$guard = ledger_guard_check(ndb('b.example'), $c['coin']);
t(($guard['status'] ?? $guard['state'] ?? 'ok') !== 'halted' && ledger_guard_halted(ndb('b.example'), $c['coin']) === null, 'the ordinary rollback guard does not stop b: the approval is not part of the entry log', $guard);
$again = why(fn() => peer_handle(ndb('b.example'), node('b.example'), json_decode(json_encode(peer_envelope(node('a.example'), 'b.example', 'approve', ['coinId' => $c['coin'], 'prepared' => $taken['prepared']], $NOW)), true), $NOW, 'transport'));
t(true, 'for reference, asking b to approve the same entry again (idempotent): ' . $again);

echo "\n== the authority cancels the sale; b must refuse to witness\n";
$direct = why(fn() => peer_handle(ndb('b.example'), node('b.example'), json_decode(json_encode(peer_envelope(node('a.example'), 'b.example', 'close-sale', ['coinId' => $c['coin'], 'requestId' => $rid, 'credentialId' => $credential['id'], 'price' => 20], time())), true), time(), 'transport'));
t(str_starts_with($direct, 'cannot-close'), 'b refuses a close-sale for a request it approved an entry for', $direct);
t(!ledger_sale_closed(ndb('b.example'), $c['coin'], $rid) || str_starts_with($direct, 'cannot-close'), 'and does not record the sale as closed');

echo "\n== what the authority can do with that\n";
// Honest cancel on the authority: rejects the pending proposal and asks the partners for witnesses.
$cancel = why(fn() => purchase_cancel($ctx['db'], $ctx['gold'], $c['coin'], $rid, $ctx['node'], 'transport'));
t(str_starts_with($cancel, 'cannot-cancel') && !isset($GIVEN[$rid]), 'the cancel is refused, so the credential is not freed', $cancel);
if (isset($GIVEN[$rid])) {
    // The credential was freed against a closure with two witnesses. The authority, running modified code from a copy of its own database
    // made before it closed the sale, commits the entry it holds b's approval for.
    $copy = tempnam(sys_get_temp_dir(), 'witness-authority-') . '.sqlite';
    copy($aAtApproval, $copy);
    $dishonest = ledger_open($copy);
    $prepared = $taken['prepared'];
    $committed = why(fn() => ledger_commit($dishonest, $c['coin'], $prepared, ledger_sign(node('a.example')['private'], $prepared['hash']), [['domain' => 'b.example', 'signature' => $taken['signature']]], max($NOW, ledger_head_time($dishonest, $c['coin']))));
    global $ALT;
    $ALT = ['for' => 'b.example', 'db' => $dishonest];
    $applied = why(fn() => peer_catch_up(ndb('b.example'), node('b.example'), $c['coin'], 'transport', $NOW));
    $ALT = null;
    t(false, 'b took the delivery into its own ledger although it had witnessed the closure: ' . $applied . '; b head ' . ledger_head(ndb('b.example'), $c['coin'])['index']);
    t(false, 'IMPACT: the credential was freed and the authority can still commit the delivery with b\'s approval: ' . $committed);
}

echo "\n" . ($failures === 0 ? 'ALL ' . $total . ' CHAIN-LABS WITNESS CHECKS PASSED' : $failures . ' of ' . $total . ' checks FAILED') . "\n";
exit($failures === 0 ? 0 : 1);
