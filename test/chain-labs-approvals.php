<?php
declare(strict_types=1);
// An approver of a multi authority coin never signs two different entries for one ledger position, however much time passes:
//   - two conflicting approvals from one approver for the same coin and index, more than 240 seconds apart
//   - both entries would then be fully approved on separate copies of the authority's database
//   - the approval kept as it was given, the refusal recorded, and a retry of the same entry answered again
//   - a database restored from a copy, a lost row and a damaged checkpoint: an approval is not forgotten
//   - the authority keeping the entry the partners approved, full roster and partial thresholds, and what is left unrecoverable
//
//   php test/chain-labs-approvals.php
require __DIR__ . '/support/multi-cluster.php';

echo "== an approver signs one entry per index, however much time passes\n";
cluster(3);
$D = ['a.example', 'b.example', 'c.example'];
$c = open_coin(3, 2);
open_now($c);
$alice = owner(); $bob = owner(); $carol = owner();
pay($c, $c['treasury'], $alice['key'], '1000');
$A = ndb('a.example');
$T0 = $NOW;
// An entry for the next index prepared, and its approval asked for, with the clock $dt seconds after the start.
$prepare = function (string $to, string $amount, int $dt) use ($A, $c, $alice, &$NOW, $T0) {
    $NOW = $T0 + $dt;
    $prep = ledger_prepare_transfer($A, $c['coin'], auth('a.example', $c, $alice, $to, $amount), $NOW);
    $NOW = $T0;
    return $prep;
};
$ask = function (string $partner, array $prep, int $dt) use ($c, &$NOW, $T0) {
    $NOW = $T0 + $dt;
    try { return transport($partner, peer_envelope(node('a.example'), $partner, 'approve', ['coinId' => $c['coin'], 'prepared' => $prep], $NOW)); } finally { $NOW = $T0; }
};
$P1 = $prepare($bob['key'], '10', 0);
$P3 = $prepare($carol['key'], '11', 400);
t($P1['public']['index'] === $P3['public']['index'] && $P1['hash'] !== $P3['hash'], 'two different entries compete for one index');
$first = $ask('b.example', $P1, 0);
t($first['decision'] === 'approve', 'a partner approves the first entry');
$bytes = fn(array $p) => ledger_approval_bytes($c['coin'], $p['public']['index'], $p['hash']);
$bKey = ledger_roster_key(ledger_coin($A, $c['coin'])['genesis'], 'b.example');
$late = null;
$lateReason = why(function () use ($ask, $P3, &$late) { $late = $ask('b.example', $P3, 400); });
$conflict = $late !== null && ledger_verify($bKey, $bytes($P1), $first['signature']) && ledger_verify($bKey, $bytes($P3), $late['signature']);
t(!$conflict, 'one partner holds no two valid approvals for different entries of one index, 400 seconds apart', $lateReason);
t(str_starts_with($lateReason, 'equivocation'), 'the later request is refused as equivocation', $lateReason);
// A dishonest authority could commit the first entry on one copy of its database and the second on another, each fully approved.
$copyFile = tempnam(sys_get_temp_dir(), 'approvals-copy-') . '.sqlite';
@unlink($copyFile);
$A->exec("VACUUM INTO '" . $copyFile . "'");
$B2 = ledger_open($copyFile);
$an = node('a.example');
$forked = false;
if ($late !== null) {
    ledger_commit($A, $c['coin'], $P1, ledger_sign($an['private'], $P1['hash']), [['domain' => 'b.example', 'signature' => $first['signature']]], $T0);
    ledger_commit($B2, $c['coin'], $P3, ledger_sign($an['private'], $P3['hash']), [['domain' => 'b.example', 'signature' => $late['signature']]], $T0 + 400);
    $forked = ledger_head($A, $c['coin'])['index'] === ledger_head($B2, $c['coin'])['index'] && ledger_head($A, $c['coin'])['hash'] !== ledger_head($B2, $c['coin'])['hash'];
}
t(!$forked, 'so no second fully approved entry for that index can exist next to the first');
$P4 = $prepare($carol['key'], '12', 100000);
t(refuses(fn() => $ask('b.example', $P4, 100000), 'equivocation'), 'and a day later');

echo "\n== the approval is kept as it was given\n";
$bdb = ndb('b.example');
$row = $bdb->query("SELECT * FROM ledger_approved WHERE coin_id='" . $c['coin'] . "' AND idx=" . $P1['public']['index'])->fetch(PDO::FETCH_ASSOC);
t($row && $row['hash'] === $P1['hash'] && $row['signature'] === $first['signature'] && $row['requester'] === 'a.example' && (int) $row['approved_at'] === $T0, 'the row holds the entry, the signature as issued, who asked and when', $row);
$again = $ask('b.example', $P1, 0);
t($again['signature'] === $first['signature'], 'asking again for the same entry returns the same signature');
$again = $ask('b.example', $P1, 400);
t($again['signature'] === $first['signature'], 'also 400 seconds later, when the entry is too old to be approved for the first time');
$again = $ask('b.example', $P1, 100000);
t($again['signature'] === $first['signature'], 'and a day later');
$left = $bdb->query("SELECT hash,signature FROM ledger_approved WHERE coin_id='" . $c['coin'] . "' AND idx=" . $P1['public']['index'])->fetchAll(PDO::FETCH_ASSOC);
t(count($left) === 1 && $left[0]['hash'] === $P1['hash'] && $left[0]['signature'] === $first['signature'], 'the first approval was not replaced by any later request');
$refusals = $bdb->query("SELECT approved_hash,refused_hash,requester FROM ledger_approval_refusals WHERE coin_id='" . $c['coin'] . "'")->fetchAll(PDO::FETCH_ASSOC);
$recorded = array_values(array_filter($refusals, fn($r) => $r['refused_hash'] === $P3['hash']));
t(count($recorded) === 1 && $recorded[0]['approved_hash'] === $P1['hash'] && $recorded[0]['requester'] === 'a.example', 'the refused request is recorded beside it', $refusals);
t(ledger_coin($bdb, $c['coin'])['state'] === 'active', 'a refusal does not stop the coin');
$count = (int) $bdb->query('SELECT COUNT(*) FROM ledger_approval_refusals')->fetchColumn();
try { $ask('b.example', $P3, 400); } catch (LedgerError $e) {}
t((int) $bdb->query('SELECT COUNT(*) FROM ledger_approval_refusals')->fetchColumn() === $count, 'the same refused request is recorded once');

// ---------- scenarios on fresh clusters ----------

function fresh(int $n, ?int $threshold): array
{
    global $NOW;
    cluster($n);
    $c = open_coin($n, $threshold);
    open_now($c);
    $alice = owner();
    pay($c, $c['treasury'], $alice['key'], '1000');
    return [$c, $alice];
}
// An entry for the next index with the clock $dt seconds on; the owner's authorization is made for that time.
function entry(array $c, array $from, string $to, string $amount, int $dt): array
{
    global $NOW;
    $base = $NOW;
    $NOW = $base + $dt;
    try { return ledger_prepare_transfer(ndb('a.example'), $c['coin'], auth('a.example', $c, $from, $to, $amount), $NOW); } finally { $NOW = $base; }
}
function ask(array $c, string $partner, array $prep, int $dt = 0): array
{
    global $NOW;
    $base = $NOW;
    $NOW = $base + $dt;
    try { return transport($partner, peer_envelope(node('a.example'), $partner, 'approve', ['coinId' => $c['coin'], 'prepared' => $prep], $NOW)); } finally { $NOW = $base; }
}
function reopen(string $domain, ?string $snapshot = null): void
{
    global $CLUSTER;
    $file = $CLUSTER[$domain]['file'];
    $CLUSTER[$domain]['db'] = null;
    if ($snapshot !== null) copy($snapshot, $file);
    $CLUSTER[$domain]['db'] = ledger_open($file);
}
function snapshot(string $domain): string
{
    $file = tempnam(sys_get_temp_dir(), 'approvals-snap-') . '.sqlite';
    @unlink($file);
    ndb($domain)->exec("VACUUM INTO '" . $file . "'");
    return $file;
}

echo "\n== a database restored from a copy does not forget an approval\n";
[$c, $alice] = fresh(3, 2);
$bob = owner(); $carol = owner();
$P1 = entry($c, $alice, $bob['key'], '10', 0);
$P3 = entry($c, $alice, $carol['key'], '11', 400);
$before = snapshot('b.example');
$signed = ask($c, 'b.example', $P1);
reopen('b.example', $before);
t((int) ndb('b.example')->query('SELECT COUNT(*) FROM ledger_approved WHERE idx=' . $P1['public']['index'])->fetchColumn() === 0, 'the restored database holds no approval for the index');
t(refuses(fn() => ask($c, 'b.example', $P3, 400), 'equivocation'), 'a different entry for that index is still refused, from the checkpoint');
$again = ask($c, 'b.example', $P1, 400);
t($again['signature'] === $signed['signature'], 'and the same entry is answered with the signature it was given');
t(ledger_verify(peer_public(node('b.example')), ledger_approval_bytes($c['coin'], $P1['public']['index'], $P1['hash']), $again['signature']), 'which verifies');

echo "\n== an approval lost from the table is remembered by the checkpoint\n";
[$c, $alice] = fresh(3, 2);
$P1 = entry($c, $alice, $bob['key'], '10', 0);
$P3 = entry($c, $alice, $carol['key'], '11', 400);
$signed = ask($c, 'b.example', $P1);
ndb('b.example')->exec('DELETE FROM ledger_approved');
t(refuses(fn() => ask($c, 'b.example', $P3, 400), 'equivocation'), 'a different entry is refused');
t(ask($c, 'b.example', $P1, 400)['signature'] === $signed['signature'], 'the same entry gets its signature back');
// A crash after the checkpoint line and before the row.
[$c, $alice] = fresh(3, 2);
$P1 = entry($c, $alice, $bob['key'], '10', 0);
$P3 = entry($c, $alice, $carol['key'], '11', 0);
ledger_approval_note(ndb('b.example'), $c['coin'], $P1['public']['index'], $P1['hash'], 'sig', $NOW);
t(refuses(fn() => ask($c, 'b.example', $P3), 'equivocation'), 'an approval written down but not yet in the table still stops a different entry');
t(ask($c, 'b.example', $P1)['decision'] === 'approve', 'and the entry it was written down for is approved when asked again');
t(count(ndb('b.example')->query('SELECT 1 FROM ledger_approved')->fetchAll()) === 1, 'with one row');

echo "\n== an approver fails closed when its record cannot be read\n";
[$c, $alice] = fresh(3, 2);
$P1 = entry($c, $alice, $bob['key'], '10', 0);
ask($c, 'b.example', $P1);
$log = guard_file(ndb('b.example'), $c['coin'], 'log');
$lines = explode("\n", rtrim((string) file_get_contents($log), "\n"));
$lines[0] = str_replace('"kind"', '"kinD"', $lines[0]);
file_put_contents($log, implode("\n", $lines) . "\n");
$P2 = entry($c, $alice, $carol['key'], '12', 0);
t(refuses(fn() => ask($c, 'b.example', $P2), 'checkpoint-corrupt') && refuses(fn() => ask($c, 'b.example', $P1), 'checkpoint-corrupt'), 'a damaged checkpoint stops approvals, new entry and repeat alike');

echo "\n== an approval table from before this change\n";
[$c, $alice] = fresh(3, 2);
$P1 = entry($c, $alice, $bob['key'], '10', 0);
$P3 = entry($c, $alice, $carol['key'], '11', 0);
$old = ndb('b.example');
$old->exec('DROP TABLE ledger_approved');
$old->exec('CREATE TABLE ledger_approved(coin_id TEXT NOT NULL, idx INTEGER NOT NULL, hash TEXT NOT NULL, executed_at INTEGER NOT NULL, PRIMARY KEY(coin_id,idx))');
$old->prepare('INSERT INTO ledger_approved(coin_id,idx,hash,executed_at) VALUES(?,?,?,?)')->execute([$c['coin'], $P1['public']['index'], $P1['hash'], strtotime($P1['public']['executedAt'])]);
reopen('b.example');
$columns = array_column(ndb('b.example')->query('PRAGMA table_info(ledger_approved)')->fetchAll(PDO::FETCH_ASSOC), 'name');
t(in_array('signature', $columns, true) && in_array('requester', $columns, true), 'the table gains its columns when opened');
t(refuses(fn() => ask($c, 'b.example', $P3), 'equivocation'), 'an approval recorded before them still stops a different entry');
t(ask($c, 'b.example', $P1)['decision'] === 'approve', 'and the same entry is approved again');


// ---------- the authority ----------

function propose(array $c, array $from, string $to, string $amount): array
{
    global $NOW;
    return spend_submit(ndb('a.example'), $c['coin'], auth('a.example', $c, $from, $to, $amount), $NOW);
}
function stored(array $c, string $digest): ?array
{
    $row = spend_proposal(ndb('a.example'), $c['coin'], $digest);
    return $row && $row['prepared_json'] !== null ? json_decode($row['prepared_json'], true) : null;
}
function approved_rows(string $domain, array $c, int $index): int
{
    $q = ndb($domain)->prepare('SELECT COUNT(*) FROM ledger_approved WHERE coin_id=? AND idx=?');
    $q->execute([$c['coin'], $index]);
    return (int) $q->fetchColumn();
}

echo "\n== full roster: a partner that is down, then back in time\n";
[$c, $alice] = fresh(3, null);
$bob = owner(); $dave = owner();
$an = node('a.example'); $A = ndb('a.example');
$DOWN['c.example'] = true;
$p = propose($c, $alice, $bob['key'], '10');
t(refuses(fn() => peer_execute($A, $an, $c['coin'], $p['digest'], 'transport', $NOW), 'not-enough-approvals'), 'with a partner down the entry waits for it');
$held = stored($c, $p['digest']);
t($held !== null && approved_rows('b.example', $c, $held['public']['index']) === 1, 'the entry b approved is kept with the proposal');
$DOWN['c.example'] = false;
$NOW += 30;
$receipt = peer_execute($A, $an, $c['coin'], $p['digest'], 'transport', $NOW);
t($receipt['hash'] === $held['hash'], 'the retry writes the entry b approved, not a new one');
t(approved_rows('b.example', $c, $held['public']['index']) === 1 && approved_rows('c.example', $c, $held['public']['index']) === 1, 'each partner approved it once');
peer_catch_up(ndb('b.example'), node('b.example'), $c['coin'], 'transport', $NOW);
peer_catch_up(ndb('c.example'), node('c.example'), $c['coin'], 'transport', $NOW);
t(level($c, ['a.example', 'b.example', 'c.example']) && same_log($c, ['a.example', 'b.example', 'c.example']) && clean($c, ['a.example', 'b.example', 'c.example']), 'and every copy agrees', heads($c, ['a.example', 'b.example', 'c.example']));
$NOW = 1800000000;

echo "\n== full roster: the entry is written late when every approval is in\n";
[$c, $alice] = fresh(3, null);
$an = node('a.example'); $A = ndb('a.example');
$p = propose($c, $alice, $bob['key'], '10');
$row = spend_proposal($A, $c['coin'], $p['digest']);
$prep = ledger_prepare_transfer($A, $c['coin'], json_decode($row['authorization_json'], true), $NOW);
[$approvals] = peer_collect_approvals($A, $an, $c['coin'], $prep, [], 'transport', $NOW);
peer_store_entry($A, $c['coin'], $p['digest'], $prep, $approvals);
$NOW += 100000;
$done = peer_recover($A, $an, $c['coin'], 'transport', $NOW);
t(($done[$p['digest']] ?? '') === 'executed at ' . $prep['public']['index'] && ledger_head($A, $c['coin'])['hash'] === $prep['hash'], 'a day later the authority writes the approved entry', $done);
t(ledger_head_time($A, $c['coin']) === strtotime($prep['public']['executedAt']), 'at the time it was prepared for');
$next = propose($c, $alice, $dave['key'], '5');
$out = peer_execute($A, $an, $c['coin'], $next['digest'], 'transport', $NOW);
t($out['entry']['index'] === $prep['public']['index'] + 1 && ledger_check($A, $c['coin']) === [], 'and the next entry follows it with the clock where it is');
$NOW = 1800000000;

echo "\n== partial thresholds: approvals held long enough are still written\n";
foreach ([[3, 2], [5, 3]] as [$n, $k]) {
    [$c, $alice] = fresh($n, $k);
    $an = node('a.example'); $A = ndb('a.example');
    $p = propose($c, $alice, $bob['key'], '10');
    $row = spend_proposal($A, $c['coin'], $p['digest']);
    $prep = ledger_prepare_transfer($A, $c['coin'], json_decode($row['authorization_json'], true), $NOW);
    [$approvals] = peer_collect_approvals($A, $an, $c['coin'], $prep, [], 'transport', $NOW);
    peer_store_entry($A, $c['coin'], $p['digest'], $prep, $approvals);
    t(count($approvals) === $k - 1, $k . ' of ' . $n . ': the partners approved before the crash');
    $NOW += 5000;
    $done = peer_recover($A, $an, $c['coin'], 'transport', $NOW);
    t(($done[$p['digest']] ?? '') === 'executed at ' . $prep['public']['index'] && ledger_head($A, $c['coin'])['hash'] === $prep['hash'], $k . ' of ' . $n . ': recovery writes that entry later', $done);
    $NOW = 1800000000;
}

echo "\n== one entry for an index is with the partners at a time\n";
[$c, $alice] = fresh(3, null);
$u2 = owner(); $sink = owner();
pay($c, $c['treasury'], $u2['key'], '500');
$an = node('a.example'); $A = ndb('a.example');
$DOWN['c.example'] = true;
$s1 = propose($c, $alice, $sink['key'], '10');
$s2 = propose($c, $u2, $sink['key'], '20');
t(refuses(fn() => peer_execute($A, $an, $c['coin'], $s1['digest'], 'transport', $NOW), 'not-enough-approvals'), 'the first proposal waits for the partner that is down');
$held = stored($c, $s1['digest']);
t(refuses(fn() => peer_execute($A, $an, $c['coin'], $s2['digest'], 'transport', $NOW), 'busy'), 'the second is not put to the partners meanwhile');
t(stored($c, $s2['digest']) === null && approved_rows('b.example', $c, $held['public']['index']) === 1, 'it prepares nothing, and b approved one entry for the index');
$DOWN['c.example'] = false;
$out = peer_execute($A, $an, $c['coin'], $s2['digest'], 'transport', $NOW);
t($out['entry']['index'] === $held['public']['index'] + 1 && ledger_check($A, $c['coin']) === [], 'once the partner is back the first is written and the second follows it');
t(spend_proposal($A, $c['coin'], $s1['digest'])['status'] === 'executed' && ledger_head($A, $c['coin'])['index'] === $held['public']['index'] + 1, 'both proposals executed, in order');
peer_catch_up(ndb('b.example'), node('b.example'), $c['coin'], 'transport', $NOW);
peer_catch_up(ndb('c.example'), node('c.example'), $c['coin'], 'transport', $NOW);
t(level($c, ['a.example', 'b.example', 'c.example']) && same_log($c, ['a.example', 'b.example', 'c.example']), 'every copy agrees');

echo "\n== what stays stuck: a partner that never saw the approved entry in time\n";
[$c, $alice] = fresh(3, null);
$an = node('a.example'); $A = ndb('a.example');
$DOWN['c.example'] = true;
$p = propose($c, $alice, $bob['key'], '10');
try { peer_execute($A, $an, $c['coin'], $p['digest'], 'transport', $NOW); } catch (LedgerError $e) {}
$held = stored($c, $p['digest']);
$DOWN['c.example'] = false;
$NOW += 400;
$why = why(fn() => peer_execute($A, $an, $c['coin'], $p['digest'], 'transport', $NOW));
t(str_starts_with($why, 'not-enough-approvals') && str_contains($why, 'c.example'), 'the partner that is back refuses the old entry as too old, and nothing is written', $why);
t(spend_proposal($A, $c['coin'], $p['digest'])['status'] === 'pending' && stored($c, $p['digest'])['hash'] === $held['hash'], 'the proposal stays pending with the same entry');
$other = owner();
t(refuses(fn() => pay($c, $c['treasury'], $other['key'], '50'), 'busy'), 'every later entry for the coin waits behind it: the coin is stalled until an operator decision', ledger_head($A, $c['coin']));
t(approved_rows('b.example', $c, $held['public']['index']) === 1 && ledger_check($A, $c['coin']) === [], 'no second approval was given, and the copies stay sound');
$NOW = 1800000000;

echo "\n== a single authority coin has no approvals to keep\n";
require_once __DIR__ . '/../chain-labs/lib/spend.php';
$sdb = ledger_open(tempnam(sys_get_temp_dir(), 'approvals-single-') . '.sqlite');
$authority = ec_private();
$authorityPub = openssl_pkey_get_details(openssl_pkey_get_private($authority))['key'];
$treasury = owner();
$genesis = ledger_genesis(['symbol' => 'SNG', 'name' => 'Coin SNG', 'decimals' => 2, 'maxUnits' => '1000000', 'initialUnits' => '100000', 'treasuryKey' => $treasury['key'], 'mode' => 'single', 'visibility' => 'public',
    'roster' => [['domain' => 'a.example', 'key' => $authorityPub]], 'createdAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW - 3600), 'refSecret' => null, 'faucet' => null, 'purchase' => null]);
ledger_register($sdb, $genesis, $treasury['key'], null);
ledger_add_genesis_signature($sdb, $genesis['coinId'], 'a.example', ledger_genesis_sign($genesis, $authority));
ledger_activate($sdb, $genesis['coinId'], $authority);
$payload = ['type' => 'atlas.ledger.transfer', 'v' => 2, 'coinId' => $genesis['coinId'], ...ledger_binding($sdb, $genesis['coinId']), 'from' => $treasury['key'], 'to' => owner()['key'], 'amount' => '10', 'baseSeq' => 0,
    'baseHead' => ledger_head($sdb, $genesis['coinId'])['hash'], 'nonce' => bin2hex(random_bytes(16)), 'issuedAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW - 10), 'expiresAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW + 300)];
$sp = spend_submit($sdb, $genesis['coinId'], ['payload' => $payload, 'signature' => ledger_owner_sign($treasury['priv'], $payload)], $NOW);
$receipt = spend_execute($sdb, $genesis['coinId'], $sp['digest'], $authority, $NOW);
t($receipt['entry']['index'] === 1 && ledger_check($sdb, $genesis['coinId']) === [], 'a single authority coin executes as before');
t((int) $sdb->query('SELECT COUNT(*) FROM ledger_approved')->fetchColumn() === 0 && (int) $sdb->query('SELECT COUNT(*) FROM ledger_approval_refusals')->fetchColumn() === 0, 'and keeps no approvals and no refusals');

echo "\n" . ($failures === 0 ? 'ALL ' . $total . ' CHAIN-LABS APPROVAL CHECKS PASSED' : $failures . ' of ' . $total . ' checks FAILED') . "\n";
exit($failures === 0 ? 0 : 1);
