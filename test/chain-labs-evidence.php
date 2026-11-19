<?php
declare(strict_types=1);
// What it takes to freeze a multi authority coin (chain-labs/lib/peer.php), and the way back from a freeze that was not deserved:
//   - one roster domain cannot freeze a healthy coin with head statements of its own
//   - a slow commit is not a rollback: the time an entry was prepared at says nothing about when it was written
//   - an authority that signed two entries for one index, an authority that went back, and invalid history still freeze the coin
//   - a freeze on evidence that does not prove anything can be lifted, one on proven evidence cannot
//   - the same under a full roster, 2 of 3 and 3 of 5, with a partner that lies or is down, and with an approved entry waiting
//
//   php test/chain-labs-evidence.php
require __DIR__ . '/support/multi-cluster.php';

// A coin of $n domains on level copies, with some history.
function funded(int $n = 3, ?int $threshold = 2): array
{
    cluster($n);
    $c = open_coin($n, $threshold);
    open_now($c);
    $alice = owner(); $bob = owner(); $carol = owner();
    pay($c, $c['treasury'], $alice['key'], '1000');
    pay($c, $alice, $bob['key'], '10');
    catch_up_all($c);
    return [$c, $alice, $bob, $carol];
}
// An entry both partners approved that the authority has not written yet; returns the proposal's digest.
function approved_not_written(array $c, array $from, string $to, string $amount): string
{
    global $NOW;
    $A = ndb('a.example');
    $waiting = spend_submit($A, $c['coin'], auth('a.example', $c, $from, $to, $amount), $NOW);
    $prepared = ledger_prepare_transfer($A, $c['coin'], json_decode((string) spend_proposal($A, $c['coin'], $waiting['digest'])['authorization_json'], true), $NOW);
    peer_store_entry($A, $c['coin'], $waiting['digest'], $prepared, []);
    [$approvals] = peer_collect_approvals($A, node('a.example'), $c['coin'], $prepared, [], 'transport', $NOW);
    peer_store_entry($A, $c['coin'], $waiting['digest'], $prepared, $approvals);
    return count($approvals) === count($c['roster']) - 1 ? $waiting['digest'] : '';
}
function catch_up_all(array $c): void
{
    global $NOW, $CLUSTER;
    foreach (array_keys($CLUSTER) as $d) if ($d !== 'a.example' && in_array($d, $c['roster'], true)) peer_catch_up(ndb($d), node($d), $c['coin'], 'transport', $NOW);
}
function state_of(string $d, array $c): string { return ledger_coin(ndb($d), $c['coin'])['state']; }
function states(array $c): array { global $CLUSTER; $o = []; foreach (array_keys($CLUSTER) as $d) $o[$d] = state_of($d, $c); return $o; }
function all_active(array $c): bool { return count(array_unique(states($c))) === 1 && state_of('a.example', $c) === 'active'; }
function compare(string $d, array $c): array { global $NOW; return peer_compare_heads(ndb($d), node($d), $c['coin'], 'transport', $NOW); }
function send_freeze(string $to, string $from, array $c, array $evidence): array
{
    global $NOW;
    return transport($to, peer_envelope(node($from), $to, 'freeze', ['coinId' => $c['coin'], 'evidence' => $evidence], $NOW));
}
// A head statement a domain signs for any index and hash it likes, with nothing behind it: what a dishonest roster domain can always produce.
function made_up(string $domain, array $c, int $index, string $hash, int $at): array
{
    $payload = ['type' => PEER_HEAD_TYPE, 'v' => 1, 'coinId' => $c['coin'], 'domain' => $domain, 'index' => $index, 'hash' => $hash, 'issuedAt' => gmdate('Y-m-d\TH:i:s\Z', $at)];
    return ['payload' => $payload, 'signature' => ledger_sign(node($domain)['private'], ledger_canonical($payload)), 'authoritySignature' => null, 'public' => null];
}
function refused_evidence(string $to, string $from, array $c, array $evidence): bool
{
    return str_starts_with(why(fn() => send_freeze($to, $from, $c, $evidence)), 'bad-evidence') && state_of($to, $c) === 'active';
}
function normal_operation(array $c, array $from, array $recipient): bool
{
    global $CLUSTER;
    try {
        $before = ledger_head(ndb('a.example'), $c['coin'])['index'];
        pay($c, $from, $recipient['key'], '1');
        catch_up_all($c);
        return ledger_head(ndb('a.example'), $c['coin'])['index'] === $before + 1 && level($c, array_keys($CLUSTER)) && clean($c, array_keys($CLUSTER));
    } catch (Throwable $e) {
        return false;
    }
}

echo "== one roster domain cannot freeze a healthy coin with statements of its own\n";
[$c, $alice, $bob, $carol] = funded();
$idx = ledger_head(ndb('a.example'), $c['coin'])['index'];
$x = str_repeat('1', 64); $y = str_repeat('2', 64);
$two = ['kind' => 'fork', 'items' => [made_up('b.example', $c, $idx, $x, $NOW), made_up('b.example', $c, $idx, $y, $NOW)]];
t(refused_evidence('c.example', 'b.example', $c, $two), 'two conflicting statements signed by one domain, with no entry behind them, freeze nothing');
t(refused_evidence('a.example', 'b.example', $c, $two), 'also on the authority');
$real = peer_head_attestation(ndb('a.example'), node('a.example'), $c['coin'], $NOW);
t(refused_evidence('c.example', 'b.example', $c, ['kind' => 'fork', 'items' => [made_up('b.example', $c, $idx, $x, $NOW), $real]]), 'nor does one made up statement against an honest one');
t(refused_evidence('c.example', 'b.example', $c, ['kind' => 'fork', 'items' => [made_up('b.example', $c, $idx, $x, $NOW), made_up('c.example', $c, $idx, $y, $NOW)]]), 'nor do statements from two domains that carry no entry');
$liar = function (string $to, array $envelope) use ($c, $idx, $x): array {
    $answer = transport($to, $envelope);
    if ($to === 'b.example' && $envelope['payload']['action'] === 'head') $answer['head'] = made_up('b.example', $c, $idx, $x, $GLOBALS['NOW']);
    return $answer;
};
$r = peer_compare_heads(ndb('c.example'), node('c.example'), $c['coin'], $liar, $NOW);
t(($r['results']['b.example'] ?? '') !== 'fork' && all_active($c), 'a partner that states another hash for an index it cannot show does not freeze the copy that compares with it', [$r, states($c)]);
t(normal_operation($c, $alice, $bob), 'and the coin goes on as before');

echo "\n== a slow commit is not a rollback\n";
// A full roster coin: both partners approve an entry, and the authority writes it later, at its own time.
[$c, $alice, $bob, $carol] = funded(3, null);
$T0 = $NOW;
$digest = approved_not_written($c, $alice, $carol['key'], '30');
t($digest !== '', 'an entry approved by both partners and not yet written');
$NOW = $T0 + 100;
$during = peer_head_attestation(ndb('a.example'), node('a.example'), $c['coin'], $NOW);
$NOW = $T0 + 700;
$done = peer_recover(ndb('a.example'), node('a.example'), $c['coin'], 'transport', $NOW);
t(str_starts_with($done[$digest] ?? '', 'executed'), 'is written later', $done);
catch_up_all($c);
$n = ledger_head(ndb('a.example'), $c['coin'])['index'];
$entry = ledger_records_after(ndb('a.example'), $c['coin'], $n - 1, 1)[0];
t(strtotime($entry['public']['executedAt']) === $T0 && $during['payload']['index'] === $n - 1 && strtotime($during['payload']['issuedAt']) > $T0, 'it carries the time it was prepared at, which is before a statement the authority made while it waited', [$entry['public']['executedAt'], $during['payload']]);
$held = peer_head_attestation(ndb('b.example'), node('b.example'), $c['coin'], $NOW);
t(refused_evidence('c.example', 'b.example', $c, ['kind' => 'rollback', 'items' => [$held, $during]]), 'that statement, kept and shown later, does not prove a rollback');
$NOW += 5;
$held = peer_head_attestation(ndb('b.example'), node('b.example'), $c['coin'], $NOW);
t(refused_evidence('c.example', 'b.example', $c, ['kind' => 'rollback', 'items' => [$held, $during]]), 'nor does it against a copy that holds the entry, whenever it is sent');
// A statement the authority made a moment before it wrote the entry, met by a copy that already holds the entry.
$NOW = $T0 + 705;
$before = $during;
$stale = function (string $to, array $envelope) use ($before): array {
    $answer = transport($to, $envelope);
    if ($to === 'a.example' && $envelope['payload']['action'] === 'head') $answer['head'] = $before;
    return $answer;
};
$NOW = strtotime($before['payload']['issuedAt']) + 60;
$r = peer_compare_heads(ndb('b.example'), node('b.example'), $c['coin'], $stale, $NOW);
t(($r['results']['a.example'] ?? '') !== 'rollback' && all_active($c), 'a copy that holds the entry and is shown an older statement of the authority does not freeze', [$r, states($c)]);
$NOW = $T0 + 700;
t(normal_operation($c, $alice, $bob), 'and the coin goes on as before');
t((int) ndb('b.example')->query("SELECT COUNT(*) FROM ledger_approved WHERE coin_id='" . $c['coin'] . "' AND idx=" . $n)->fetchColumn() === 1, 'the approval the partner gave is still the one it kept');
$NOW = $T0;

echo "\n== a split, a rollback and an authority that signed twice still freeze the coin\n";
// An authority that shows two partners different histories.
function split(): array
{
    global $ALT, $DOWN, $NOW;
    [$c, $alice, $bob, $carol] = funded();
    $file = tempnam(sys_get_temp_dir(), 'evidence-alt-') . '.sqlite';
    ndb('a.example')->exec("VACUUM INTO '" . $file . "'");
    $alt = ledger_open($file);
    $altAuth = auth('a.example', $c, $alice, $carol['key'], '30');
    $DOWN['c.example'] = true;
    pay($c, $alice, $bob['key'], '30');
    $DOWN['c.example'] = false;
    $ALT = ['for' => 'c.example', 'db' => $alt];
    $DOWN['b.example'] = true;
    peer_submit_and_execute($alt, node('a.example'), $c['coin'], $altAuth, 'transport', $NOW);
    $DOWN['b.example'] = false;
    return [$c, $alice, $bob, $carol, $alt];
}
[$c, $alice, $bob, $carol, $alt] = split();
$r = compare('b.example', $c);
t(($r['results']['c.example'] ?? '') === 'fork' && $r['state'] === 'frozen' && state_of('a.example', $c) === 'frozen' && state_of('c.example', $c) === 'frozen', 'two entries for one index, each signed by the authority and held by a partner, freeze every domain', [$r, states($c)]);
$ev = ledger_evidence(ndb('a.example'), $c['coin']);
t(count($ev) === 1 && $ev[0]['kind'] === 'fork', 'with the evidence kept', $ev);
// An authority restored from an old copy: the partners hold entries it no longer shows.
[$c, $alice, $bob, $carol] = funded();
$file = tempnam(sys_get_temp_dir(), 'evidence-backup-') . '.sqlite';
ndb('a.example')->exec("VACUUM INTO '" . $file . "'");
pay($c, $alice, $bob['key'], '5');
pay($c, $alice, $bob['key'], '6');
catch_up_all($c);
$CLUSTER['a.example']['db'] = ledger_open($file);
$NOW += 3;
$r = compare('b.example', $c);
t(($r['results']['a.example'] ?? '') === 'rollback' && $r['state'] === 'frozen' && state_of('a.example', $c) === 'frozen' && state_of('c.example', $c) === 'frozen', 'an authority that states fewer entries than it signed freezes every domain', [$r, states($c)]);
t((ledger_evidence(ndb('c.example'), $c['coin'])[0]['kind'] ?? null) === 'rollback', 'with the rollback evidence kept');
$NOW -= 3;
// The restored authority itself, comparing with a partner that holds more.
[$c, $alice, $bob, $carol] = funded();
$file = tempnam(sys_get_temp_dir(), 'evidence-backup-') . '.sqlite';
ndb('a.example')->exec("VACUUM INTO '" . $file . "'");
pay($c, $alice, $bob['key'], '5');
catch_up_all($c);
$CLUSTER['a.example']['db'] = ledger_open($file);
$NOW += 3;
$r = compare('a.example', $c);
t(($r['results']['b.example'] ?? '') === 'rollback' && state_of('a.example', $c) === 'frozen' && state_of('b.example', $c) === 'frozen', 'and the restored authority finds it too when it compares with a partner that holds more', [$r, states($c)]);
$NOW -= 3;
// An authority that sends another entry for an index a copy already holds.
[$c, $alice, $bob, $carol, $alt] = split();
$ALT = null;
foreach (['a.example', 'b.example', 'c.example'] as $d) ndb($d)->exec("UPDATE ledger_coins SET state='active'; DELETE FROM ledger_evidence");
$n = ledger_head(ndb('b.example'), $c['coin'])['index'];
$other = ledger_records_after($alt, $c['coin'], $n - 1, 5);
$lie = function (string $to, array $envelope) use ($other): array {
    $answer = transport($to, $envelope);
    if ($envelope['payload']['action'] === 'sync') $answer['records'] = $other;
    return $answer;
};
t(refuses(fn() => peer_catch_up(ndb('b.example'), node('b.example'), $c['coin'], $lie, $NOW), 'bad-history') && state_of('b.example', $c) === 'frozen' && state_of('a.example', $c) === 'frozen', 'a second signed entry for a held index freezes the copy that was shown it, and the others');
$ev = ledger_evidence(ndb('a.example'), $c['coin']);
t(($ev[0]['kind'] ?? null) === 'authority-equivocation', 'as equivocation of the authority', $ev);
// Invalid history from the authority, and an entry that carries no valid signature, freeze nothing on a claim.
[$c, $alice, $bob, $carol, $alt] = split();
$ALT = null;
foreach (['a.example', 'b.example', 'c.example'] as $d) ndb($d)->exec("UPDATE ledger_coins SET state='active'; DELETE FROM ledger_evidence");
$n = ledger_head(ndb('b.example'), $c['coin'])['index'];
$other = ledger_records_after($alt, $c['coin'], $n - 1, 5);
$other[0]['authoritySignature'] = $other[0]['authoritySignature'] === null ? 'x' : strrev($other[0]['authoritySignature']);
$lie2 = function (string $to, array $envelope) use ($other): array {
    $answer = transport($to, $envelope);
    if ($envelope['payload']['action'] === 'sync') $answer['records'] = $other;
    return $answer;
};
t(refuses(fn() => peer_catch_up(ndb('b.example'), node('b.example'), $c['coin'], $lie2, $NOW), 'bad-history') && state_of('b.example', $c) === 'active', 'an entry for a held index that is not signed by the authority is not evidence');

echo "\n== a freeze that was not deserved can be lifted, one that was cannot\n";
// A copy frozen the way an earlier version froze on two statements of one domain.
[$c, $alice, $bob, $carol] = funded();
$idx = ledger_head(ndb('a.example'), $c['coin'])['index'];
$forged = ['kind' => 'fork', 'items' => [made_up('b.example', $c, $idx, str_repeat('1', 64), $NOW), made_up('b.example', $c, $idx, str_repeat('2', 64), $NOW)]];
foreach (['a.example', 'b.example', 'c.example'] as $d) ledger_freeze(ndb($d), $c['coin'], 'fork', $forged, $NOW);
t(!all_active($c) && state_of('c.example', $c) === 'frozen', 'a coin frozen on statements that prove nothing');
$resume = fn(string $d) => peer_resume_after_rollback(ndb($d), node($d), $c['coin'], 'transport', $NOW);
$tampered = (string) ndb('b.example')->query("SELECT public_json FROM ledger_log WHERE coin_id='" . $c['coin'] . "' AND idx=1")->fetchColumn();
ndb('b.example')->exec("UPDATE ledger_log SET public_json=replace(public_json,'\"amount\":\"1000\"','\"amount\":\"9000\"') WHERE coin_id='" . $c['coin'] . "' AND idx=1");
t(refuses(fn() => $resume('b.example'), 'not-resumable'), 'is not lifted while the copy does not pass the checker');
ndb('b.example')->prepare("UPDATE ledger_log SET public_json=? WHERE coin_id=? AND idx=1")->execute([$tampered, $c['coin']]);
$DOWN['c.example'] = true;
t(refuses(fn() => $resume('b.example'), 'not-resumable'), 'nor while a domain does not state the same history');
$DOWN['c.example'] = false;
$r = null;
$why = why(function () use (&$r, $resume) { $r = $resume('b.example'); });
t(($r['state'] ?? null) === 'active' && state_of('b.example', $c) === 'active', 'is lifted when the copy passes the checker and every domain states the same history', $why);
t(array_column(ledger_evidence(ndb('b.example'), $c['coin']), 'kind') === ['fork', 'resumed'], 'and the evidence is kept, with the resumption beside it');
foreach (['a.example', 'c.example'] as $d) why(fn() => $resume($d));
t(all_active($c) && normal_operation($c, $alice, $bob), 'once every domain is lifted the coin goes on');
// The evidence that proves a split is not dismissed, whatever the operator does.
[$c, $alice, $bob, $carol, $alt] = split();
$compared = compare('b.example', $c);
$ALT = null;
t(refuses(fn() => peer_resume_after_rollback(ndb('b.example'), node('b.example'), $c['coin'], 'transport', $NOW), 'not-resumable'), 'a coin frozen on two entries signed by the authority is not lifted');
ndb('c.example')->exec("UPDATE ledger_log SET hash=hash WHERE 0");
$b = ndb('b.example');
$b->exec("DELETE FROM ledger_log WHERE coin_id='" . $c['coin'] . "' AND idx=" . ledger_head($b, $c['coin'])['index']);
t(refuses(fn() => peer_resume_after_rollback($b, node('b.example'), $c['coin'], 'transport', $NOW), 'not-resumable'), 'not even after one copy is cut back to look level');
// A rollback freeze is lifted as before, from the same checks, and the evidence that froze it cannot be used again once the authority is back.
[$c, $alice, $bob, $carol] = funded();
$file = tempnam(sys_get_temp_dir(), 'evidence-backup-') . '.sqlite';
ndb('a.example')->exec("VACUUM INTO '" . $file . "'");
pay($c, $alice, $bob['key'], '5');
catch_up_all($c);
$full = tempnam(sys_get_temp_dir(), 'evidence-full-') . '.sqlite';
ndb('a.example')->exec("VACUUM INTO '" . $full . "'");
$CLUSTER['a.example']['db'] = ledger_open($file);
$NOW += 3;
compare('b.example', $c);
t(state_of('b.example', $c) === 'frozen', 'a rollback of the authority freezes the coin');
$proof = ledger_evidence(ndb('b.example'), $c['coin'])[0]['detail'];
t(refuses(fn() => peer_resume_after_rollback(ndb('b.example'), node('b.example'), $c['coin'], 'transport', $NOW), 'not-resumable'), 'it is not lifted while the authority is still behind');
// The operator puts the authority's database back as it was before the step back.
$CLUSTER['a.example']['db'] = ledger_open($full);
$NOW += 5;
foreach (['b.example', 'a.example', 'c.example'] as $d) why(fn() => peer_resume_after_rollback(ndb($d), node($d), $c['coin'], 'transport', $NOW));
t(all_active($c), 'and then every domain is lifted', states($c));
foreach (['b.example', 'c.example'] as $d) compare($d, $c);
$NOW += 5;
t(refused_evidence('c.example', 'b.example', $c, $proof), 'the evidence of the step back, sent again once the authority has stated as many entries, freezes nothing');
t(normal_operation($c, $alice, $bob), 'and the coin goes on as before');
$NOW -= 16;

echo "\n== a copy that never held the lost entries, and a partner that is down\n";
// b.example holds an entry that c.example missed; the authority is then restored from an older copy. c.example finds it from b.example's statement.
[$c, $alice, $bob, $carol] = funded();
$file = tempnam(sys_get_temp_dir(), 'evidence-backup-') . '.sqlite';
ndb('a.example')->exec("VACUUM INTO '" . $file . "'");
$DOWN['c.example'] = true;
pay($c, $alice, $bob['key'], '7');
$DOWN['c.example'] = false;
peer_catch_up(ndb('b.example'), node('b.example'), $c['coin'], 'transport', $NOW);
t(ledger_head(ndb('c.example'), $c['coin'])['index'] < ledger_head(ndb('b.example'), $c['coin'])['index'], 'one partner holds an entry the other missed');
$CLUSTER['a.example']['db'] = ledger_open($file);
$NOW += 3;
$r = compare('c.example', $c);
t(($r['results']['b.example'] ?? '') === 'rollback' && state_of('c.example', $c) === 'frozen', 'it takes the proof from the partner that did hold it, and freezes', $r);
$NOW -= 3;
// An authority that went back, found while one partner is down.
[$c, $alice, $bob, $carol] = funded();
$file = tempnam(sys_get_temp_dir(), 'evidence-backup-') . '.sqlite';
ndb('a.example')->exec("VACUUM INTO '" . $file . "'");
pay($c, $alice, $bob['key'], '5');
catch_up_all($c);
$CLUSTER['a.example']['db'] = ledger_open($file);
$DOWN['c.example'] = true;
$NOW += 3;
$r = compare('b.example', $c);
t(($r['results']['a.example'] ?? '') === 'rollback' && state_of('b.example', $c) === 'frozen' && state_of('a.example', $c) === 'frozen', 'a step back is found and the reachable domains freeze while a partner is down', $r);
$DOWN['c.example'] = false;
$r = compare('c.example', $c);
t(state_of('c.example', $c) === 'frozen', 'and the partner that was down freezes when it compares', $r);
$NOW -= 3;

echo "\n== the same under a full roster, 2 of 3 and 3 of 5, with partners that lie or are down\n";
foreach ([[3, null, 'a full roster of 3'], [3, 2, '2 of 3'], [5, 3, '3 of 5']] as [$n, $threshold, $label]) {
    [$c, $alice, $bob, $carol] = funded($n, $threshold);
    $idx = ledger_head(ndb('a.example'), $c['coin'])['index'];
    $bad = 'b.example';
    $statements = [made_up($bad, $c, $idx, str_repeat('3', 64), $NOW), made_up($bad, $c, $idx, str_repeat('4', 64), $NOW)];
    $refusedBy = [];
    foreach (array_keys($CLUSTER) as $to) if ($to !== $bad) $refusedBy[$to] = refused_evidence($to, $bad, $c, ['kind' => 'fork', 'items' => $statements]);
    t(!in_array(false, $refusedBy, true) && all_active($c), $label . ': one partner\'s made up statements freeze no other domain', $refusedBy);
    $down = $n === 5 ? ['d.example', 'e.example'] : ['c.example'];
    foreach ($down as $d) $DOWN[$d] = true;
    $r = compare('a.example', $c);
    t(all_active($c) && !in_array('fork', $r['results'], true) && !in_array('rollback', $r['results'], true), $label . ': domains that are down are reported, not taken for a disagreement', $r);
    $ok = true;
    try { pay($c, $alice, $bob['key'], '1'); } catch (LedgerError $e) { $ok = $e->reason === 'not-enough-approvals' && ($threshold === null); }
    t($ok, $label . ': the coin takes entries while the threshold can still be met, and waits when it cannot', $threshold);
    foreach ($down as $d) $DOWN[$d] = false;
    $r = compare('a.example', $c);
    t(all_active($c) && !in_array('fork', $r['results'], true), $label . ': and the domains compare level again when they are back', $r);
}

echo "\n== an approved entry that waits for the authority\n";
[$c, $alice, $bob, $carol] = funded(3, null);
$T0 = $NOW;
$digest = approved_not_written($c, $alice, $carol['key'], '30');
$idx = ledger_head(ndb('a.example'), $c['coin'])['index'];
$approved = (int) ndb('b.example')->query("SELECT COUNT(*) FROM ledger_approved WHERE coin_id='" . $c['coin'] . "' AND idx=" . ($idx + 1))->fetchColumn();
t($approved === 1, 'a partner approved an entry the authority has not written');
$NOW = $T0 + 300;
$r = compare('b.example', $c);
t(all_active($c) && !in_array('fork', $r['results'], true) && !in_array('rollback', $r['results'], true), 'comparing heads while it waits finds nothing wrong', $r);
t(refused_evidence('c.example', 'b.example', $c, ['kind' => 'fork', 'items' => [made_up('b.example', $c, $idx + 1, str_repeat('5', 64), $NOW), made_up('b.example', $c, $idx + 1, str_repeat('6', 64), $NOW)]]), 'two statements for the waiting index do not freeze it');
$NOW = $T0 + 600;
$done = peer_recover(ndb('a.example'), node('a.example'), $c['coin'], 'transport', $NOW);
catch_up_all($c);
t(str_starts_with($done[$digest] ?? '', 'executed') && level($c, ['a.example', 'b.example', 'c.example']) && all_active($c), 'the authority writes it later and every copy follows', $done);
t((int) ndb('b.example')->query("SELECT COUNT(*) FROM ledger_approved WHERE coin_id='" . $c['coin'] . "' AND idx=" . ($idx + 1))->fetchColumn() === 1, 'the partner still holds exactly the one approval it gave');
$NOW = $T0;

echo "\n" . ($failures === 0 ? 'ALL ' . $total . ' CHAIN-LABS EVIDENCE CHECKS PASSED' : $failures . ' of ' . $total . ' checks FAILED') . "\n";
exit($failures === 0 ? 0 : 1);
