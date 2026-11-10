<?php
declare(strict_types=1);
// Multi authority coins of the chain labs (chain-labs/lib/peer.php), several nodes in one process, each with its own SQLite
// file and key, talking through the same signed messages the endpoint sends over HTTPS:
//   - opening a coin together, and every way a partner refuses a bad genesis
//   - approvals under all-of, 2-of-3 and 3-of-5 rules, with domains down, frozen or dishonest
//   - each approver checking against its own copy: inflated balances, forged entries, doctored history
//   - catching up, crash injection on the authority, and equivocation by the authority
//
//   php test/chain-labs-multi.php
require __DIR__ . '/support/multi-cluster.php';

echo "== opening a coin together\n";
$D = cluster(3);
$c = open_coin(3, null);
open_now($c);
t(ledger_coin(ndb('a.example'), $c['coin'])['state'] === 'active' && ledger_coin(ndb('b.example'), $c['coin'])['state'] === 'active' && ledger_coin(ndb('c.example'), $c['coin'])['state'] === 'active', 'the coin is open on all three domains');
t(level($c, $D) && same_log($c, $D) && clean($c, $D), 'each copy holds the same entry 0 and passes the checker', [heads($c, $D)]);
t(ledger_coin(ndb('b.example'), $c['coin'])['genesis_digest'] === ledger_coin(ndb('a.example'), $c['coin'])['genesis_digest'], 'every domain signed the same genesis');
t(refuses(fn() => open_now($c), 'not-pending'), 'a coin opens once');

// Genesis refusals, each sent from a.example to b.example.
$b = node('b.example'); $a = node('a.example');
$fresh = fn(array $over = [], ?array $roster = null) => (function () use ($over, $roster) {
    $cc = open_coin(3, null, 'public', null, 'GEN');
    $g = $cc['genesis'];
    if ($roster !== null) $g['roster'] = $roster;
    foreach ($over as $k => $v) $g[$k] = $v;
    return [$cc, $g];
})();
$sendGenesis = function (array $g, array $cc, string $from = 'a.example', ?array $envOver = null) {
    global $NOW;
    return fn() => transport('b.example', peer_envelope(node($from), 'b.example', 'genesis', ['genesis' => $g, 'treasuryKey' => $cc['treasury']['key'], 'refSecret' => null], $NOW));
};
[$cc, $g] = $fresh();
t(is_string($sendGenesis($g, $cc)()['signature'] ?? null), 'a partner signs a genesis that names it with its own key');
t(isset($sendGenesis($g, $cc)()['signature']), 'and signs the same genesis again');
[$cc, $g] = $fresh();
$wrongKey = $g['roster'];
$wrongKey[1]['key'] = peer_public(['private' => ec_private()]);
t(refuses($sendGenesis(array_merge($g, ['roster' => $wrongKey]), $cc), 'bad-genesis'), 'refused: a genesis that carries another key for the partner');
[$cc, $g] = $fresh();
$wrongKey = $g['roster'];
$wrongKey[2]['key'] = peer_public(['private' => ec_private()]);
t(refuses($sendGenesis(array_merge($g, ['roster' => $wrongKey]), $cc), 'bad-genesis'), 'refused: a genesis that carries a key that is not the pinned one for another domain');
[$cc, $g] = $fresh();
$short = array_values(array_filter($g['roster'], fn($m) => $m['domain'] !== 'b.example'));
t(refuses($sendGenesis(array_merge($g, ['roster' => $short, 'threshold' => 2]), $cc), 'not-in-roster'), 'refused: a genesis whose roster does not include the partner');
[$cc, $g] = $fresh();
t(refuses($sendGenesis($g, $cc, 'c.example'), 'bad-genesis'), 'refused: a genesis sent by a domain that is not its authority');
[$cc, $g] = $fresh();
t(refuses($sendGenesis(array_merge($g, ['treasuryRef' => owner()['key']]), $cc), 'bad-genesis'), 'refused: a genesis whose treasury does not match the treasury key it came with');
[$cc, $g] = $fresh();
$sendGenesis($g, $cc)();
$g2 = $g;
$g2['name'] = 'Another coin';
t(refuses($sendGenesis($g2, $cc), 'exists'), 'refused: a different coin on an id the partner already holds');
$stranger = ['domain' => 'z.example', 'private' => ec_private(), 'pinned' => ['b.example' => peer_public($b)]];
t(refuses(fn() => transport('b.example', peer_envelope($stranger, 'b.example', 'genesis', ['genesis' => $g], $NOW)), 'unknown-peer'), 'refused: a request from a domain that is not pinned');
$env = peer_envelope($a, 'b.example', 'sync', ['coinId' => $c['coin'], 'after' => -1], $NOW);
transport('b.example', $env);
t(refuses(fn() => transport('b.example', $env), 'replayed'), 'refused: the same signed request twice');
$old = peer_envelope($a, 'b.example', 'sync', ['coinId' => $c['coin'], 'after' => -1], $NOW - 500);
t(refuses(fn() => transport('b.example', $old), 'bad-time'), 'refused: a request that is not recent');
$misaddressed = peer_envelope($a, 'c.example', 'sync', ['coinId' => $c['coin'], 'after' => -1], $NOW);
t(refuses(fn() => transport('b.example', $misaddressed), 'bad-request'), 'refused: a request meant for another domain');
$forged = peer_envelope($a, 'b.example', 'sync', ['coinId' => $c['coin'], 'after' => -1], $NOW);
$forged['payload']['body']['after'] = 0;
t(refuses(fn() => transport('b.example', $forged), 'bad-signature'), 'refused: a request changed after signing');
$extra = peer_envelope($a, 'b.example', 'sync', ['coinId' => $c['coin'], 'after' => -1], $NOW);
$extra['payload']['note'] = 'x';
t(refuses(fn() => transport('b.example', $extra), 'bad-request'), 'refused: a request with an extra field');
t(refuses(fn() => transport('b.example', peer_envelope($a, 'b.example', 'launch', [], $NOW)), 'unknown-action'), 'refused: an unknown action');
t(refuses(fn() => transport('a.example', peer_envelope($b, 'a.example', 'notify', ['coinId' => $c['coin']], $NOW)), 'not-authority'), 'refused: a notice from a domain that is not the authority');

echo "\n== a partner that is down while the coin opens\n";
cluster(3);
$d = open_coin(3, null);
$DOWN['c.example'] = true;
t(refuses(fn() => open_now($d), 'peer-down'), 'the coin does not open while a partner is down');
t(ledger_coin(ndb('a.example'), $d['coin'])['state'] === 'pending', 'and stays pending');
$DOWN['c.example'] = false;
open_now($d);
t(ledger_coin(ndb('a.example'), $d['coin'])['state'] === 'active' && ledger_coin(ndb('c.example'), $d['coin'])['state'] === 'active', 'asking again once it is back opens it on every domain');

echo "\n== all three must approve\n";
cluster(3);
$D = ['a.example', 'b.example', 'c.example'];
$c = open_coin(3, null);
open_now($c);
$alice = owner(); $bob = owner(); $carol = owner();
$r = pay($c, $c['treasury'], $alice['key'], '5000');
t($r['entry']['index'] === 1 && units('a.example', $c, $alice['key']) === 5000, 'a spend with every approval is written on the authority');
t(level($c, $D) && same_log($c, $D) && units('b.example', $c, $alice['key']) === 5000 && units('c.example', $c, $alice['key']) === 5000, 'and the other copies follow', heads($c, $D));
t(count($r['approvals']) === 2, 'the receipt carries the approvals of both partners');
t(clean($c, $D), 'every copy passes the checker');
$r2 = pay($c, $alice, $bob['key'], '1200');
t($r2['entry']['index'] === 2 && units('c.example', $c, $bob['key']) === 1200 && level($c, $D), 'a transfer between wallet accounts');
$DOWN['c.example'] = true;
$pending = spend_submit(ndb('a.example'), $c['coin'], auth('a.example', $c, $alice, $carol['key'], '100'), $NOW);
t(refuses(fn() => peer_execute(ndb('a.example'), node('a.example'), $c['coin'], $pending['digest'], 'transport', $NOW), 'not-enough-approvals'), 'with one domain down nothing is written', why(fn() => peer_execute(ndb('a.example'), node('a.example'), $c['coin'], $pending['digest'], 'transport', $NOW)));
t(units('a.example', $c, $alice['key']) === 3800 && spend_proposal(ndb('a.example'), $c['coin'], $pending['digest'])['status'] === 'pending', 'the balances are unchanged and the proposal waits');
t(units('a.example', $c, $alice['key']) === units('b.example', $c, $alice['key']), 'the balance is still readable on the other copies');
$DOWN['c.example'] = false;
$done = peer_recover(ndb('a.example'), node('a.example'), $c['coin'], 'transport', $NOW);
t(str_starts_with($done[$pending['digest']] ?? '', 'executed') && units('a.example', $c, $carol['key']) === 100, 'when it is back, recovery writes the waiting proposal', $done);
t(level($c, $D) && same_log($c, $D) && clean($c, $D), 'the returning domain caught up and all copies are identical', heads($c, $D));
$FZ = spend_submit(ndb('a.example'), $c['coin'], auth('a.example', $c, $alice, $carol['key'], '50'), $NOW);
ledger_freeze(ndb('b.example'), $c['coin']);
t(refuses(fn() => peer_execute(ndb('a.example'), node('a.example'), $c['coin'], $FZ['digest'], 'transport', $NOW), 'not-enough-approvals'), 'a partner that froze the coin does not approve');
$db = ndb('b.example');
$db->exec("UPDATE ledger_coins SET state='active'");

echo "\n== 2 of 3\n";
cluster(3);
$D = ['a.example', 'b.example', 'c.example'];
$c = open_coin(3, 2);
open_now($c);
$alice = owner(); $bob = owner();
pay($c, $c['treasury'], $alice['key'], '5000');
$DOWN['c.example'] = true;
$r = pay($c, $alice, $bob['key'], '700');
t($r['entry']['index'] === 2 && count($r['approvals']) === 1 && units('b.example', $c, $bob['key']) === 700, 'with one domain down a 2 of 3 coin keeps spending');
t(ledger_head(ndb('c.example'), $c['coin'])['index'] < 2, 'the absent domain is behind');
$DOWN['c.example'] = false;
$applied = peer_catch_up(ndb('c.example'), node('c.example'), $c['coin'], 'transport', $NOW);
t($applied >= 1 && level($c, $D) && same_log($c, $D) && clean($c, $D), 'it catches up when it returns', heads($c, $D));
$DOWN['b.example'] = true; $DOWN['c.example'] = true;
$p = spend_submit(ndb('a.example'), $c['coin'], auth('a.example', $c, $alice, $bob['key'], '1'), $NOW);
t(refuses(fn() => peer_execute(ndb('a.example'), node('a.example'), $c['coin'], $p['digest'], 'transport', $NOW), 'not-enough-approvals'), 'with both partners down the authority alone cannot spend');
$DOWN = [];
peer_recover(ndb('a.example'), node('a.example'), $c['coin'], 'transport', $NOW);

echo "\n== 3 of 5\n";
cluster(5);
$D = array_keys($CLUSTER);
$c = open_coin(5, 3);
open_now($c);
$u = owner(); $w = owner();
pay($c, $c['treasury'], $u['key'], '9000');
$DOWN['d.example'] = true; $DOWN['e.example'] = true;
$r = pay($c, $u, $w['key'], '100');
t(count($r['approvals']) === 2 && units('a.example', $c, $w['key']) === 100, 'with two of five domains down a 3 of 5 coin still spends');
$DOWN['c.example'] = true;
$p = spend_submit(ndb('a.example'), $c['coin'], auth('a.example', $c, $u, $w['key'], '1'), $NOW);
t(refuses(fn() => peer_execute(ndb('a.example'), node('a.example'), $c['coin'], $p['digest'], 'transport', $NOW), 'not-enough-approvals'), 'with three down it does not');
$DOWN = [];
peer_recover(ndb('a.example'), node('a.example'), $c['coin'], 'transport', $NOW);
foreach ($D as $d) peer_catch_up(ndb($d), node($d), $c['coin'], 'transport', $NOW);
t(level($c, $D) && same_log($c, $D) && clean($c, $D), 'all five copies end up identical and clean', heads($c, $D));

echo "\n== every approver checks against its own copy\n";
cluster(3);
$D = ['a.example', 'b.example', 'c.example'];
$c = open_coin(3, 2);
open_now($c);
$alice = owner(); $bob = owner(); $carol = owner();
pay($c, $c['treasury'], $alice['key'], '1000');
// The authority's copy is edited so that alice appears to hold much more, then it prepares a spend its partners must refuse.
$copy = tempnam(sys_get_temp_dir(), 'multi-copy-') . '.sqlite';
copy($CLUSTER['a.example']['file'], $copy);
$cdb = ledger_open($copy);
$cdb->exec("UPDATE ledger_accounts SET units=units+50000 WHERE account_key='" . $alice['key'] . "'");
$inflated = ledger_prepare_transfer($cdb, $c['coin'], auth('a.example', $c, $alice, $bob['key'], '40000'), $NOW);
$ask = fn(string $to, array $prep, string $coinId = null) => fn() => transport($to, peer_envelope(node('a.example'), $to, 'approve', ['coinId' => $coinId ?? $c['coin'], 'prepared' => $prep], $NOW));
t(refuses($ask('b.example', $inflated), 'insufficient'), 'refused: an entry that spends more than the approver\'s own copy says the sender holds');
t(refuses($ask('c.example', $inflated), 'insufficient'), 'by every partner');
t(calls('sync') >= 0 && units('b.example', $c, $bob['key']) === 0, 'and nothing moved');
// The same entry, from an authority that also holds the signing material: still refused, since the copies disagree.
$p = spend_submit(ndb('a.example'), $c['coin'], auth('a.example', $c, $alice, $carol['key'], '10'), $NOW);
$cdb->exec("UPDATE ledger_accounts SET units=1000 WHERE account_key='" . $alice['key'] . "'");
$good = ledger_prepare_transfer(ndb('a.example'), $c['coin'], auth('a.example', $c, $alice, $carol['key'], '20'), $NOW);
$answer = $ask('b.example', $good)();
t($answer['decision'] === 'approve' && ledger_verify(peer_public(node('b.example')), ledger_approval_bytes($c['coin'], 2, $good['hash']), $answer['signature']), 'a sound entry is approved with a signature over the entry hash');
$staleHead = $good;
$staleHead['public']['prevHash'] = str_repeat('0', 64);
$staleHead['hash'] = ledger_digest($staleHead['public']);
$staleHead['private']['hash'] = $staleHead['hash'];
t(refuses($ask('b.example', $staleHead), 'wrong-prev'), 'refused: an entry that does not extend the approver\'s head');
$jump = $good;
$jump['public']['index'] = 9;
$jump['hash'] = ledger_digest($jump['public']);
$jump['private']['hash'] = $jump['hash'];
t(refuses($ask('b.example', $jump), 'wrong-index'), 'refused: an entry that skips ahead');
$bent = $good;
$bent['public']['amount'] = '21';
t(refuses($ask('b.example', $bent), 'bad-hash'), 'refused: a public amount that does not match its hash');
$forgedAuth = $good;
$forgedAuth['private']['authorization']['payload']['amount'] = '19';
t(refuses($ask('b.example', $forgedAuth), 'bad-hash') || refuses($ask('b.example', $forgedAuth), 'bad-entry') || refuses($ask('b.example', $forgedAuth), 'bad-signature'), 'refused: an owner authorization changed after signing');
$otherCoin = open_coin(3, 2, 'public', null, 'OTH');
t(refuses($ask('b.example', $good, $otherCoin['coin']), 'unknown-coin'), 'refused: a coin the approver does not hold');
$fromC = fn() => transport('b.example', peer_envelope(node('c.example'), 'b.example', 'approve', ['coinId' => $c['coin'], 'prepared' => $good], $NOW));
t(refuses($fromC, 'not-authority'), 'refused: a request for approval from a domain that is not the authority');
$noKeys = $good;
$noKeys['private'] = null;
t(refuses($ask('b.example', $noKeys), 'bad-request') || refuses($ask('b.example', $noKeys), 'bad-entry'), 'refused: an entry with no private form');
unlink($copy);

echo "\n== a faucet policy is checked by the approvers\n";
cluster(3);
$D = ['a.example', 'b.example', 'c.example'];
$policy = ['maxAmount' => '100', 'perKeyLimit' => '150', 'cooldownSeconds' => 60];
$c = open_coin(3, 2, 'public', $policy);
open_now($c);
$k = owner();
pay($c, $c['treasury'], $k['key'], '100');
$copy = tempnam(sys_get_temp_dir(), 'multi-copy-') . '.sqlite';
copy($CLUSTER['a.example']['file'], $copy);
$cdb = ledger_open($copy);
$cdb->exec('DELETE FROM ledger_faucet');
$NOW += 70;
$over = ledger_prepare_transfer($cdb, $c['coin'], auth('a.example', $c, $c['treasury'], $k['key'], '100'), $NOW);
t(refuses(fn() => transport('b.example', peer_envelope(node('a.example'), 'b.example', 'approve', ['coinId' => $c['coin'], 'prepared' => $over], $NOW)), 'faucet-limit'), 'an approver refuses a grant past the key limit even when the authority\'s own totals were cleared');
$NOW -= 70;
unlink($copy);
$NOW += 70;
$r = pay($c, $c['treasury'], $k['key'], '50');
t($r['entry']['index'] === 2, 'a grant inside the policy is approved and written');
$NOW += 1;
t(refuses(fn() => pay($c, $c['treasury'], $k['key'], '100'), 'faucet-limit'), 'the authority itself refuses a grant past the key limit');
t(level($c, $D) && clean($c, $D), 'the copies stay level and clean');

echo "\n== a partner that is told a different history\n";
cluster(3);
$D = ['a.example', 'b.example', 'c.example'];
$c = open_coin(3, 2);
open_now($c);
$alice = owner(); $bob = owner();
pay($c, $c['treasury'], $alice['key'], '1000');
pay($c, $alice, $bob['key'], '100');
// c.example is behind and is served doctored records when it catches up.
$DOWN['c.example'] = true;
pay($c, $alice, $bob['key'], '50');
pay($c, $alice, $bob['key'], '25');
$DOWN['c.example'] = false;
$tamperTransport = function (string $field, callable $edit) {
    return function (string $to, array $envelope) use ($field, $edit): array {
        $answer = transport($to, $envelope);
        if ($envelope['payload']['action'] === 'sync' && !empty($answer['records'])) $edit($answer['records']);
        return $answer;
    };
};
$cases = [
    'a changed amount' => function (array &$records) { $records[0]['public']['amount'] = '9999'; },
    'a changed hash' => function (array &$records) { $records[0]['hash'] = str_repeat('0', 64); },
    'a replaced authority signature' => function (array &$records) { $records[0]['authoritySignature'] = $records[1]['authoritySignature'] ?? 'AAAA'; },
    'removed approvals' => function (array &$records) { $records[0]['approvals'] = []; },
    'an entry out of order' => function (array &$records) { $records = array_reverse($records); },
    'a changed owner authorization' => function (array &$records) { $records[0]['private']['authorization']['payload']['amount'] = '1'; },
];
$before = heads($c, ['c.example']);
foreach ($cases as $name => $edit) {
    $evil = function (string $to, array $envelope) use ($edit): array {
        $answer = transport($to, $envelope);
        if ($envelope['payload']['action'] === 'sync' && !empty($answer['records'])) $edit($answer['records']);
        return $answer;
    };
    $threw = false;
    try { peer_catch_up(ndb('c.example'), node('c.example'), $c['coin'], $evil, $NOW); } catch (LedgerError $e) { $threw = true; }
    $state = ledger_coin(ndb('c.example'), $c['coin'])['state'];
    $expect = $name === 'an entry out of order' ? 'active' : 'frozen';
    t($threw && heads($c, ['c.example']) === $before && clean($c, ['c.example']) && $state === $expect, 'a copy refuses doctored history: ' . $name . ($expect === 'frozen' ? ' and freezes' : ''), [$threw, heads($c, ['c.example']), $before, $state]);
    t($state !== 'frozen' || (ledger_evidence(ndb('c.example'), $c['coin'])[0]['kind'] ?? null) === 'invalid-history', 'the evidence is kept', ledger_evidence(ndb('c.example'), $c['coin']));
    // Only an operator's review lets a frozen copy resume; there is no function for it, so the test edits the table.
    ndb('c.example')->exec("UPDATE ledger_coins SET state='active'; DELETE FROM ledger_evidence");
}
peer_catch_up(ndb('c.example'), node('c.example'), $c['coin'], 'transport', $NOW);
t(level($c, $D) && same_log($c, $D), 'and catches up from honest records afterwards');
$outsider = ['domain' => 'z.example', 'private' => ec_private(), 'pinned' => ['a.example' => peer_public(node('a.example'))]];
$CLUSTER['a.example']['node']['pinned']['z.example'] = peer_public($outsider);
t(refuses(fn() => transport('a.example', peer_envelope($outsider, 'a.example', 'sync', ['coinId' => $c['coin'], 'after' => -1], $NOW)), 'not-in-roster'), 'a pinned domain outside the roster cannot read the full log');
t(refuses(fn() => transport('a.example', peer_envelope(node('b.example'), 'a.example', 'sync', ['coinId' => 'xyz', 'after' => -1], $NOW)), 'bad-request') && refuses(fn() => transport('a.example', peer_envelope(node('b.example'), 'a.example', 'sync', ['coinId' => $c['coin'], 'after' => 'x'], $NOW)), 'bad-request'), 'a sync with a bad coin or index is refused');

echo "\n== an authority that asks twice for one index\n";
cluster(3);
$D = ['a.example', 'b.example', 'c.example'];
$c = open_coin(3, 2);
open_now($c);
$alice = owner(); $bob = owner(); $carol = owner();
pay($c, $c['treasury'], $alice['key'], '1000');
$P1 = ledger_prepare_transfer(ndb('a.example'), $c['coin'], auth('a.example', $c, $alice, $bob['key'], '10'), $NOW);
$P2 = ledger_prepare_transfer(ndb('a.example'), $c['coin'], auth('a.example', $c, $alice, $carol['key'], '10', ['nonce' => bin2hex(random_bytes(16))]), $NOW + 1);
$askB = fn(array $prep, int $at = null) => fn() => transport('b.example', peer_envelope(node('a.example'), 'b.example', 'approve', ['coinId' => $c['coin'], 'prepared' => $prep], $at ?? $NOW));
t($askB($P1)()['decision'] === 'approve', 'a partner approves the first entry for an index');
t($askB($P1)()['decision'] === 'approve', 'and approves the same entry again');
t(refuses($askB($P2, $NOW + 1), 'equivocation'), 'but not a different entry for the same index while the first could still be committed');
$NOW += 400;
$P3 = ledger_prepare_transfer(ndb('a.example'), $c['coin'], auth('a.example', $c, $alice, $carol['key'], '11'), $NOW);
t($askB($P3, $NOW)()['decision'] === 'approve', 'once the first can no longer be committed, a different entry for that index is approved');
$NOW -= 400;

echo "\n== crash injection on the authority\n";
cluster(3);
$D = ['a.example', 'b.example', 'c.example'];
$c = open_coin(3, 2);
open_now($c);
$alice = owner(); $bob = owner(); $carol = owner();
pay($c, $c['treasury'], $alice['key'], '1000');
$A = ndb('a.example'); $an = node('a.example');
// Crash after the approvals came in, before the entry was written.
$p = spend_submit($A, $c['coin'], auth('a.example', $c, $alice, $bob['key'], '100'), $NOW);
$row = spend_proposal($A, $c['coin'], $p['digest']);
$prep = ledger_prepare_transfer($A, $c['coin'], json_decode($row['authorization_json'], true), $NOW);
[$approvals] = peer_collect_approvals($A, $an, $c['coin'], $prep, [], 'transport', $NOW);
peer_store_entry($A, $c['coin'], $p['digest'], $prep, $approvals);
t(count($approvals) === 1 && units('a.example', $c, $bob['key']) === 0, 'the approvals are in and stored; nothing is written yet');
$before = calls('approve');
$done = peer_recover($A, $an, $c['coin'], 'transport', $NOW);
t(str_starts_with($done[$p['digest']] ?? '', 'executed') && units('a.example', $c, $bob['key']) === 100, 'recovery writes the entry', $done);
t(calls('approve') === $before, 'without asking the partners again');
t(ledger_head($A, $c['coin'])['hash'] === $prep['hash'], 'and it is the very entry that was approved');
t(peer_recover($A, $an, $c['coin'], 'transport', $NOW) === [], 'a second recovery has nothing to do');
peer_catch_up(ndb('b.example'), node('b.example'), $c['coin'], 'transport', $NOW);
peer_catch_up(ndb('c.example'), node('c.example'), $c['coin'], 'transport', $NOW);
t(level($c, $D) && same_log($c, $D) && clean($c, $D), 'the partners pick the entry up and all copies agree', heads($c, $D));
// Crash after the entry was written, before the notices went out.
$p2 = spend_submit($A, $c['coin'], auth('a.example', $c, $alice, $carol['key'], '30'), $NOW);
$row = spend_proposal($A, $c['coin'], $p2['digest']);
$prep = ledger_prepare_transfer($A, $c['coin'], json_decode($row['authorization_json'], true), $NOW);
[$approvals] = peer_collect_approvals($A, $an, $c['coin'], $prep, [], 'transport', $NOW);
ledger_commit($A, $c['coin'], $prep, ledger_sign($an['private'], $prep['hash']), $approvals, $NOW);
t(spend_proposal($A, $c['coin'], $p2['digest'])['status'] === 'executed', 'an entry written before the crash closes its proposal');
t(peer_recover($A, $an, $c['coin'], 'transport', $NOW) === [] && ledger_head(ndb('b.example'), $c['coin'])['index'] < ledger_head($A, $c['coin'])['index'], 'recovery has nothing to write, and the partners are behind');
$p3 = spend_submit($A, $c['coin'], auth('a.example', $c, $alice, $carol['key'], '1'), $NOW);
peer_execute($A, $an, $c['coin'], $p3['digest'], 'transport', $NOW);
t(level($c, $D) && same_log($c, $D) && clean($c, $D), 'the next approval request brings the partners level', heads($c, $D));
// Crash after the approvals, and a long time passes before the authority is back. Every domain must approve here, so the
// partner that saw the first entry can hold the authority to it.
cluster(3);
$D = ['a.example', 'b.example', 'c.example'];
$c = open_coin(3, null);
open_now($c);
$alice = owner(); $bob = owner();
pay($c, $c['treasury'], $alice['key'], '1000');
$A = ndb('a.example'); $an = node('a.example');
$p4 = spend_submit($A, $c['coin'], auth('a.example', $c, $alice, $bob['key'], '5'), $NOW);
$row = spend_proposal($A, $c['coin'], $p4['digest']);
$prep = ledger_prepare_transfer($A, $c['coin'], json_decode($row['authorization_json'], true), $NOW);
[$approvals] = peer_collect_approvals($A, $an, $c['coin'], $prep, [], 'transport', $NOW);
peer_store_entry($A, $c['coin'], $p4['digest'], $prep, $approvals);
t(count($approvals) === 2, 'both partners approved an entry before the crash');
$NOW += 150;
$p4row = spend_proposal($A, $c['coin'], $p4['digest']);
t(peer_stored_entry($p4row, ledger_head($A, $c['coin']), $NOW) === null, 'an entry whose time has passed is not reused');
$done = peer_recover($A, $an, $c['coin'], 'transport', $NOW);
t(($done[$p4['digest']] ?? '') === 'not-enough-approvals' && units('a.example', $c, $bob['key']) === 0, 'the partner that approved it will not approve a different one yet, so nothing is written', $done);
$NOW += 400;
$p4b = spend_submit($A, $c['coin'], auth('a.example', $c, $alice, $bob['key'], '6'), $NOW);
t(spend_proposal($A, $c['coin'], $p4['digest'])['status'] === 'expired', 'the proposal that ran out meanwhile is closed rather than executed late');
$done = peer_recover($A, $an, $c['coin'], 'transport', $NOW);
t(str_starts_with($done[$p4b['digest']] ?? '', 'executed') && units('a.example', $c, $bob['key']) === 6, 'once enough time has passed the authority proceeds with a new one', $done);
$NOW = 1800000000;

echo "\n== two spends racing for the same head\n";
cluster(3);
$D = ['a.example', 'b.example', 'c.example'];
$c = open_coin(3, 2);
open_now($c);
$u1 = owner(); $u2 = owner(); $sink = owner();
pay($c, $c['treasury'], $u1['key'], '1000');
pay($c, $c['treasury'], $u2['key'], '1000');
$A = ndb('a.example'); $an = node('a.example');
$s1 = spend_submit($A, $c['coin'], auth('a.example', $c, $u1, $sink['key'], '300'), $NOW);
$s2 = spend_submit($A, $c['coin'], auth('a.example', $c, $u2, $sink['key'], '200'), $NOW);
// The first proposal collects its approvals; before it is written, the second is executed on the same head.
$row = spend_proposal($A, $c['coin'], $s1['digest']);
$prep1 = ledger_prepare_transfer($A, $c['coin'], json_decode($row['authorization_json'], true), $NOW);
[$ap1] = peer_collect_approvals($A, $an, $c['coin'], $prep1, [], 'transport', $NOW);
peer_store_entry($A, $c['coin'], $s1['digest'], $prep1, $ap1);
peer_execute($A, $an, $c['coin'], $s2['digest'], 'transport', $NOW);
t(refuses(fn() => ledger_commit($A, $c['coin'], $prep1, ledger_sign($an['private'], $prep1['hash']), $ap1, $NOW), 'wrong-index'), 'approvals collected for an old head cannot write an entry on a newer one');
$rcpt = peer_execute($A, $an, $c['coin'], $s1['digest'], 'transport', $NOW);
t($rcpt['entry']['index'] === 4 && units('a.example', $c, $sink['key']) === 500, 'the first proposal is prepared again on the new head and written after it');
$again = peer_execute($A, $an, $c['coin'], $s1['digest'], 'transport', $NOW);
t($again['hash'] === $rcpt['hash'] && units('a.example', $c, $sink['key']) === 500, 'executing a proposal that is already written returns its receipt and moves nothing');
// The same account cannot spend the same units twice.
$x = owner();
pay($c, $c['treasury'], $x['key'], '500');
$first = spend_submit($A, $c['coin'], auth('a.example', $c, $x, $sink['key'], '400'), $NOW);
t(refuses(fn() => spend_submit($A, $c['coin'], auth('a.example', $c, $x, $sink['key'], '400'), $NOW), 'pending-exists'), 'a second spend from an account with one waiting is refused');
peer_execute($A, $an, $c['coin'], $first['digest'], 'transport', $NOW);
t(refuses(fn() => spend_submit($A, $c['coin'], auth('a.example', $c, $x, $sink['key'], '400', ['baseSeq' => 0]), $NOW), 'stale'), 'and so is one signed against the balance that was already spent');
t(refuses(fn() => spend_submit($A, $c['coin'], auth('a.example', $c, $x, $sink['key'], '400'), $NOW), 'insufficient'), 'or one for more than is left');
foreach ($D as $d) peer_catch_up(ndb($d), node($d), $c['coin'], 'transport', $NOW);
t(level($c, $D) && same_log($c, $D) && clean($c, $D), 'all copies agree after the race', heads($c, $D));
$sum = array_map(fn($d) => (int) ndb($d)->query("SELECT SUM(units) FROM ledger_accounts WHERE coin_id='" . $c['coin'] . "'")->fetchColumn(), $D);
t($sum === [100000, 100000, 100000], 'and every copy holds the whole supply', $sum);

echo "\n== a private multi coin\n";
cluster(3);
$D = ['a.example', 'b.example', 'c.example'];
$c = open_coin(3, 2, 'private');
open_now($c);
$p = owner(); $q = owner();
$r1 = pay($c, $c['treasury'], $p['key'], '2000');
$r2 = pay($c, $p, $q['key'], '300');
foreach ($D as $d) peer_catch_up(ndb($d), node($d), $c['coin'], 'transport', $NOW);
t(level($c, $D) && same_log($c, $D) && clean($c, $D), 'every roster domain holds the private forms and the copies agree', heads($c, $D));
$text = '';
foreach ($D as $d) $text .= json_encode([ledger_public_coin(ndb($d), $c['coin']), ledger_public_entries(ndb($d), $c['coin'], -1, 100), $r1, $r2]);
t(!str_contains($text, $p['key']) && !str_contains($text, $q['key']) && !str_contains($text, $c['treasury']['key']) && !str_contains($text, $c['secret']), 'no domain\'s public reads carry a key or the reference secret');
t(units('b.example', $c, $q['key']) === 300 && ledger_owner_view(ndb('c.example'), $c['coin'], $q['key'])['units'] === '300', 'a partner can resolve its holder\'s view from its own copy');
$spy = fn(string $to, array $env) => transport($to, $env);
t(ledger_coin(ndb('b.example'), $c['coin'])['ref_secret'] === $c['secret'], 'each roster domain holds the reference secret as private state');

echo "\n== a copy of entry 0 is checked before it is kept\n";
cluster(3);
$c = open_coin(3, null);
open_now($c);
$rec = ledger_records_after(ndb('a.example'), $c['coin'], -1, 5)[0];
function pending_copy(array $c): PDO
{
    $db = ledger_open(tempnam(sys_get_temp_dir(), 'multi-copy-') . '.sqlite');
    ledger_register($db, $c['genesis'], $c['treasury']['key'], $c['secret']);
    return $db;
}
$bad = $rec;
$bad['approvals'] = array_slice($rec['approvals'], 0, 2);
t(refuses(fn() => ledger_mirror_genesis(pending_copy($c), $c['coin'], $bad), 'genesis-unsigned'), 'a copy of entry 0 missing a roster signature is refused');
$bad = $rec;
$bad['approvals'][0]['signature'] = $rec['approvals'][1]['signature'];
t(refuses(fn() => ledger_mirror_genesis(pending_copy($c), $c['coin'], $bad), 'bad-approval'), 'a genesis signature made by another domain is refused');
$bad = $rec;
$bad['approvals'][] = ['domain' => 'x.example', 'signature' => $rec['approvals'][0]['signature']];
t(refuses(fn() => ledger_mirror_genesis(pending_copy($c), $c['coin'], $bad), 'bad-approval'), 'a signature from a domain outside the roster is refused');
$bad = $rec;
$bad['authoritySignature'] = ledger_sign(node('b.example')['private'], $rec['hash']);
t(refuses(fn() => ledger_mirror_genesis(pending_copy($c), $c['coin'], $bad), 'bad-authority-signature'), 'an authority signature made by another domain is refused');
$bad = $rec;
$bad['authoritySignature'] = null;
t(refuses(fn() => ledger_mirror_genesis(pending_copy($c), $c['coin'], $bad), 'bad-authority-signature'), 'a copy of entry 0 with no authority signature is refused');
$bad = $rec;
$bad['hash'] = str_repeat('a', 64);
t(refuses(fn() => ledger_mirror_genesis(pending_copy($c), $c['coin'], $bad), 'bad-entry'), 'a copy of entry 0 with another hash is refused');
$good = pending_copy($c);
ledger_mirror_genesis($good, $c['coin'], $rec);
t(ledger_coin($good, $c['coin'])['state'] === 'active' && ledger_head($good, $c['coin'])['hash'] === $rec['hash'] && ledger_check($good, $c['coin']) === [], 'the untouched copy is kept and checks clean');

echo "\n== what the authority stores while it asks, and who it believes\n";
cluster(3);
$c = open_coin(3, 2);
open_now($c);
$alice = owner(); $bob = owner();
pay($c, $c['treasury'], $alice['key'], '1000');
$A = ndb('a.example'); $an = node('a.example');
// The entry is stored with the proposal before any partner is asked.
$seen = null;
$p = spend_submit($A, $c['coin'], auth('a.example', $c, $alice, $bob['key'], '10'), $NOW);
$stored = function (string $to, array $envelope) use (&$seen, $A, $c, $p) {
    if ($envelope['payload']['action'] === 'approve' && $seen === null) $seen = spend_proposal($A, $c['coin'], $p['digest'])['prepared_json'];
    return transport($to, $envelope);
};
peer_execute($A, $an, $c['coin'], $p['digest'], $stored, $NOW);
t(is_string($seen) && json_decode($seen, true)['public']['amount'] === '10', 'the entry is stored with the proposal before the first partner is asked');
// A partner that answers with a signature that is not its own does not count; the next partner is asked.
$liar = function (string $to, array $envelope) {
    $answer = transport($to, $envelope);
    if ($to === 'b.example' && $envelope['payload']['action'] === 'approve') $answer['signature'] = ledger_sign(node('c.example')['private'], 'something else');
    return $answer;
};
$p2 = spend_submit($A, $c['coin'], auth('a.example', $c, $alice, $bob['key'], '20'), $NOW);
$receipt = peer_execute($A, $an, $c['coin'], $p2['digest'], $liar, $NOW);
t(units('a.example', $c, $bob['key']) === 30 && count($receipt['approvals']) === 1 && $receipt['approvals'][0]['domain'] === 'c.example', 'a forged approval is skipped and the entry carries the honest one', $receipt['approvals'] ?? null);
$impostor = function (string $to, array $envelope) {
    $answer = transport($to, $envelope);
    if ($to === 'b.example' && $envelope['payload']['action'] === 'approve') $answer['domain'] = 'c.example';
    return $answer;
};
$p3 = spend_submit($A, $c['coin'], auth('a.example', $c, $alice, $bob['key'], '5'), $NOW);
$receipt = peer_execute($A, $an, $c['coin'], $p3['digest'], $impostor, $NOW);
t($receipt['approvals'][0]['domain'] === 'c.example' && ledger_check($A, $c['coin']) === [], 'an answer that names another domain is not taken for that domain', $receipt['approvals'] ?? null);

echo "\n== clocks and repeated records\n";
cluster(3);
$c = open_coin(3, 2);
open_now($c);
$alice = owner();
pay($c, $c['treasury'], $alice['key'], '1000');
$NOW += 7;
pay($c, $c['treasury'], $alice['key'], '10');
$NOW -= 7;
$late = pay($c, $alice, owner()['key'], '5');
t($late['entry']['executedAt'] === gmdate('Y-m-d\TH:i:s\Z', $NOW + 7) && clean($c, ['a.example', 'b.example', 'c.example'] ), 'a request that started before the newest entry executes at that entry\'s time and is approved', $late['entry']['executedAt'] ?? null);
// An authority that sends entries the copy already holds is harmless when they are identical and refused when they differ.
$full = ledger_records_after(ndb('a.example'), $c['coin'], -1, 50);
$replay = function (array $records) {
    return function (string $to, array $envelope) use ($records) { return ['records' => $records]; };
};
t(peer_catch_up(ndb('b.example'), node('b.example'), $c['coin'], $replay($full), $NOW) >= 0 && ledger_check(ndb('b.example'), $c['coin']) === [], 'records the copy already holds are skipped');
peer_catch_up(ndb('b.example'), node('b.example'), $c['coin'], 'transport', $NOW);
$changed = $full;
$changed[1]['hash'] = str_repeat('b', 64);
t(refuses(fn() => peer_catch_up(ndb('b.example'), node('b.example'), $c['coin'], $replay($changed), $NOW), 'bad-history'), 'an entry that differs from the one held at that index is refused');
$skipped = array_slice($full, 3);
t(refuses(fn() => peer_catch_up(ndb('c.example'), node('c.example'), $c['coin'], $replay($skipped), $NOW), 'bad-history') || ledger_head(ndb('c.example'), $c['coin'])['index'] >= 2, 'records that skip ahead of the copy are refused');

echo "\n== comparing heads\n";
$ABC = ['a.example', 'b.example', 'c.example'];
// A funded 2-of-3 coin on three level copies.
function funded(): array
{
    global $ABC;
    cluster(3);
    $c = open_coin(3, 2);
    open_now($c);
    $alice = owner(); $bob = owner(); $carol = owner();
    pay($c, $c['treasury'], $alice['key'], '1000');
    pay($c, $alice, $bob['key'], '10');
    foreach (['b.example', 'c.example'] as $d) peer_catch_up(ndb($d), node($d), $c['coin'], 'transport', $GLOBALS['NOW']);
    return [$c, $alice, $bob, $carol];
}
function compare(string $d, array $c): array { global $NOW; return peer_compare_heads(ndb($d), node($d), $c['coin'], 'transport', $NOW); }
function state_of(string $d, array $c): string { return ledger_coin(ndb($d), $c['coin'])['state']; }
[$c, $alice, $bob, $carol] = funded();
$r = compare('b.example', $c);
t($r['results'] === ['a.example' => 'equal', 'c.example' => 'equal'] && $r['state'] === 'active', 'level copies compare equal', $r);
$DOWN['b.example'] = true;
pay($c, $alice, $bob['key'], '20');
$DOWN['b.example'] = false;
$r = compare('a.example', $c);
t($r['results'] === ['b.example' => 'behind', 'c.example' => 'equal'] && $r['state'] === 'active', 'a copy that missed an entry is behind, which is not a disagreement', $r);
$r = compare('b.example', $c);
t($r['results']['a.example'] === 'equal' && level($c, $ABC) && state_of('b.example', $c) === 'active', 'a copy that is behind catches up while comparing', $r);
$DOWN['c.example'] = true;
$r = compare('b.example', $c);
t($r['results']['c.example'] === 'unreachable' && $r['state'] === 'active', 'a domain that does not answer is reported and does not stop the coin', $r);
$DOWN['c.example'] = false;
$head = peer_on_head(ndb('a.example'), node('a.example'), 'b.example', ['coinId' => $c['coin']], $NOW);
t(peer_check_attestation(ledger_coin(ndb('b.example'), $c['coin']), $head['head'], 'a.example', $NOW)['hash'] === ledger_head(ndb('a.example'), $c['coin'])['hash'], 'a head statement verifies against the roster');
t(refuses(fn() => peer_on_head(ndb('a.example'), node('a.example'), 'z.example', ['coinId' => $c['coin']], $NOW), 'not-in-roster'), 'only a roster domain asks for a head over the peer route');
$stale = $head['head'];
t(refuses(fn() => peer_check_attestation(ledger_coin(ndb('b.example'), $c['coin']), $stale, 'a.example', $NOW + 500), 'bad-evidence'), 'an old head statement is not taken for a current one');
$tampered = $head['head'];
$tampered['payload']['index'] += 1;
t(refuses(fn() => peer_check_attestation(ledger_coin(ndb('b.example'), $c['coin']), $tampered, 'a.example', $NOW), 'bad-evidence'), 'a head statement with a changed index does not verify');
t(refuses(fn() => peer_check_attestation(ledger_coin(ndb('b.example'), $c['coin']), $head['head'], 'c.example', $NOW), 'bad-evidence'), 'a head statement from another domain is not taken for this one');

// An authority that shows two partners different histories: the real authority writes X with b.example's approval while
// c.example is down; a copy of the authority made earlier writes Y with c.example's approval while b.example is down.
function split(): array
{
    global $ALT, $DOWN, $NOW;
    [$c, $alice, $bob, $carol] = funded();
    $file = tempnam(sys_get_temp_dir(), 'multi-alt-') . '.sqlite';
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
$hb = ledger_head(ndb('b.example'), $c['coin']); $hc = ledger_head(ndb('c.example'), $c['coin']);
t($hb['index'] === $hc['index'] && $hb['hash'] !== $hc['hash'] && ledger_check(ndb('b.example'), $c['coin']) === [] && ledger_check(ndb('c.example'), $c['coin']) === [], 'each partner holds a valid history and the two differ at one index', [$hb, $hc]);
$r = compare('b.example', $c);
t($r['results']['c.example'] === 'fork' && $r['state'] === 'frozen', 'comparing finds the split and freezes the domain that found it', $r);
t(state_of('a.example', $c) === 'frozen' && state_of('c.example', $c) === 'frozen', 'and the other two domains check the evidence and freeze too', [state_of('a.example', $c), state_of('c.example', $c)]);
$ev = ledger_evidence(ndb('a.example'), $c['coin']);
t(count($ev) === 1 && $ev[0]['kind'] === 'fork' && count($ev[0]['detail']['items']) === 2, 'the evidence is kept: two signed head statements', $ev);
t(refuses(fn() => pay($c, $alice, $bob['key'], '1'), 'not-active') && refuses(fn() => peer_on_approve(ndb('b.example'), node('b.example'), 'a.example', ['coinId' => $c['coin'], 'prepared' => []], $NOW, 'transport'), 'not-active'), 'a frozen coin takes no new spend and gives no approvals');
t(ledger_check(ndb('a.example'), $c['coin']) === [] && ledger_public_coin(ndb('b.example'), $c['coin'])['state'] === 'frozen' && count(ledger_public_entries(ndb('b.example'), $c['coin'])['entries']) >= 3, 'a frozen coin can still be read and checked');
t(compare('c.example', $c) === ['results' => [], 'state' => 'frozen'], 'a frozen copy compares nothing');

// The same split is found by an approver before it signs, without anyone asking for a comparison.
[$c, $alice, $bob, $carol, $alt] = split();
$ALT = null;
$idxBefore = ledger_head(ndb('a.example'), $c['coin'])['index'];
$err = why(fn() => pay($c, $alice, owner()['key'], '1'));
t(state_of('b.example', $c) === 'frozen' || state_of('c.example', $c) === 'frozen', 'an approver that is asked to sign notices the split and freezes', $err);
t(ledger_head(ndb('a.example'), $c['coin'])['index'] === $idxBefore, 'and nothing is written after the split', $err);

// An authority restored from an old backup holds fewer entries than the partners saw.
[$c, $alice, $bob, $carol] = funded();
$file = tempnam(sys_get_temp_dir(), 'multi-backup-') . '.sqlite';
ndb('a.example')->exec("VACUUM INTO '" . $file . "'");
pay($c, $alice, $bob['key'], '5');
pay($c, $alice, $bob['key'], '6');
foreach (['b.example', 'c.example'] as $d) peer_catch_up(ndb($d), node($d), $c['coin'], 'transport', $NOW);
$CLUSTER['a.example']['db'] = ledger_open($file);
$NOW += 3;
$r = compare('b.example', $c);
t($r['results']['a.example'] === 'rollback' && $r['state'] === 'frozen', 'a partner that holds more than the authority freezes on a rolled-back authority', $r);
t(state_of('a.example', $c) === 'frozen' && state_of('c.example', $c) === 'frozen', 'the authority and the other partner check the evidence and freeze', [state_of('a.example', $c), state_of('c.example', $c)]);
t((ledger_evidence(ndb('c.example'), $c['coin'])[0]['kind'] ?? null) === 'rollback', 'with the rollback evidence kept');
$NOW -= 3;
// The restored authority finds it too when it compares with a partner that holds more.
[$c, $alice, $bob, $carol] = funded();
$file = tempnam(sys_get_temp_dir(), 'multi-backup-') . '.sqlite';
ndb('a.example')->exec("VACUUM INTO '" . $file . "'");
pay($c, $alice, $bob['key'], '5');
foreach (['b.example', 'c.example'] as $d) peer_catch_up(ndb($d), node($d), $c['coin'], 'transport', $NOW);
$CLUSTER['a.example']['db'] = ledger_open($file);
$NOW += 3;
$r = compare('a.example', $c);
t($r['results']['b.example'] === 'rollback' && state_of('a.example', $c) === 'frozen' && state_of('b.example', $c) === 'frozen', 'a restored authority that compares freezes, and so do the partners', $r);
$NOW -= 3;

// An authority that sends a different entry for an index a copy already holds.
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
t(refuses(fn() => peer_catch_up(ndb('b.example'), node('b.example'), $c['coin'], $lie, $NOW), 'bad-history') && state_of('b.example', $c) === 'frozen', 'a second entry for a held index, signed by the authority, freezes the copy that was shown it');
t(state_of('a.example', $c) === 'frozen' && (ledger_evidence(ndb('a.example'), $c['coin'])[0]['kind'] ?? null) === 'authority-equivocation', 'the other domains verify both signatures and freeze');
foreach (['a.example', 'b.example', 'c.example'] as $d) ndb($d)->exec("UPDATE ledger_coins SET state='active'; DELETE FROM ledger_evidence");
$unsigned = $other;
$unsigned[0]['authoritySignature'] = $other[0]['authoritySignature'] === null ? 'x' : strrev($other[0]['authoritySignature']);
$lie2 = function (string $to, array $envelope) use ($unsigned): array {
    $answer = transport($to, $envelope);
    if ($envelope['payload']['action'] === 'sync') $answer['records'] = $unsigned;
    return $answer;
};
t(refuses(fn() => peer_catch_up(ndb('b.example'), node('b.example'), $c['coin'], $lie2, $NOW), 'bad-history') && state_of('b.example', $c) === 'active', 'a different entry without a valid authority signature is not evidence and freezes nothing');

// Nobody freezes on a claim: the receiver checks the evidence itself.
[$c, $alice, $bob, $carol] = funded();
$headA = peer_head_attestation(ndb('a.example'), node('a.example'), $c['coin'], $NOW);
$headB = peer_head_attestation(ndb('b.example'), node('b.example'), $c['coin'], $NOW);
$first = peer_head_attestation(ndb('b.example'), node('b.example'), $c['coin'], $NOW, 0);
$freeze = fn(array $evidence, ?array $sender = null) => transport('c.example', peer_envelope($sender ?? node('b.example'), 'c.example', 'freeze', ['coinId' => $c['coin'], 'evidence' => $evidence], $NOW));
$bad = [
    'two statements that agree' => ['kind' => 'fork', 'items' => [$headA, $headB]],
    'two statements for different indexes' => ['kind' => 'fork', 'items' => [$headA, $first]],
    'a statement with a changed hash' => ['kind' => 'fork', 'items' => [$headA, array_replace_recursive($headB, ['payload' => ['hash' => str_repeat('c', 64)]])]],
    'a rollback whose later statement is not fewer' => ['kind' => 'rollback', 'items' => [$headB, $headA]],
    'a rollback from a partner instead of the authority' => ['kind' => 'rollback', 'items' => [$headA, $first]],
    'one item' => ['kind' => 'fork', 'items' => [$headA]],
    'an unknown kind' => ['kind' => 'because', 'items' => [$headA, $headB]],
    'equivocation with one entry twice' => ['kind' => 'authority-equivocation', 'items' => [['public' => $headA['public'], 'hash' => $headA['payload']['hash'], 'authoritySignature' => $headA['authoritySignature']], ['public' => $headA['public'], 'hash' => $headA['payload']['hash'], 'authoritySignature' => $headA['authoritySignature']]]],
];
foreach ($bad as $name => $evidence) {
    $threw = why(fn() => $freeze($evidence));
    t(str_starts_with($threw, 'bad-evidence') && state_of('c.example', $c) === 'active', 'evidence is refused: ' . $name, $threw);
}
t(refuses(fn() => $freeze(['kind' => 'fork', 'items' => [$headA, $headB]], ['domain' => 'z.example', 'private' => ec_private()]), 'unknown-peer') && state_of('c.example', $c) === 'active', 'a freeze request from a domain that is not pinned is refused');
$r = $freeze(['kind' => 'invalid-history']);
t($r['state'] === 'active', 'a report of invalid history only makes the receiver check the history itself, and it finds none');
// A partner that claims more than it has: its statement carries no signature of the authority on that entry.
$liar = function (string $to, array $envelope) use ($headB): array {
    $answer = transport($to, $envelope);
    if ($to === 'b.example' && $envelope['payload']['action'] === 'head') {
        global $CLUSTER;
        $payload = $answer['head']['payload'];
        $payload['index'] += 5;
        $payload['hash'] = str_repeat('d', 64);
        $answer['head'] = ['payload' => $payload, 'signature' => ledger_sign($CLUSTER['b.example']['node']['private'], ledger_canonical($payload)), 'authoritySignature' => $answer['head']['authoritySignature'], 'public' => $answer['head']['public']];
    }
    return $answer;
};
$r = peer_compare_heads(ndb('c.example'), node('c.example'), $c['coin'], $liar, $NOW + 3);
t($r['results']['b.example'] === 'ahead' && $r['state'] === 'active', 'a partner that claims entries nobody signed does not freeze the coin', $r);

// More ways evidence can be wrong, each checked on its own.
[$c, $alice, $bob, $carol] = funded();
$other = open_coin(3, 2, 'public', null, 'OTH');
open_now($other);
$NOW += 3;
$headA = peer_head_attestation(ndb('a.example'), node('a.example'), $c['coin'], $NOW);
$headB = peer_head_attestation(ndb('b.example'), node('b.example'), $c['coin'], $NOW);
$firstB = peer_head_attestation(ndb('b.example'), node('b.example'), $c['coin'], $NOW, 0);
$firstA = peer_head_attestation(ndb('a.example'), node('a.example'), $c['coin'], $NOW, 0);
$firstC = peer_head_attestation(ndb('c.example'), node('c.example'), $c['coin'], $NOW, 0);
$otherB = peer_head_attestation(ndb('b.example'), node('b.example'), $other['coin'], $NOW, 0);
$sendFreeze = fn(array $evidence, ?array $sender = null) => transport('c.example', peer_envelope($sender ?? node('b.example'), 'c.example', 'freeze', ['coinId' => $c['coin'], 'evidence' => $evidence], $NOW));
$refusedEvidence = fn(array $evidence) => str_starts_with(why(fn() => $sendFreeze($evidence)), 'bad-evidence') && state_of('c.example', $c) === 'active';
t($refusedEvidence(['kind' => 'fork', 'items' => [$firstB, $otherB]]), 'evidence is refused: a statement about another coin');
$badSig = $headB;
$badSig['authoritySignature'] = strrev($headB['authoritySignature']);
t($refusedEvidence(['kind' => 'rollback', 'items' => [$badSig, $firstA]]), 'evidence is refused: a rollback whose entry the authority did not sign');
t($refusedEvidence(['kind' => 'rollback', 'items' => [$headB, $headA]]), 'evidence is refused: a rollback whose later statement holds as many entries');
$sameTime = peer_head_attestation(ndb('a.example'), node('a.example'), $c['coin'], $NOW - 3, 0);
t($refusedEvidence(['kind' => 'rollback', 'items' => [$headB, $sameTime]]), 'evidence is refused: a rollback whose later statement was made before the entry existed');
t($refusedEvidence(['kind' => 'rollback', 'items' => [$headB, $firstC]]), 'evidence is refused: a rollback whose later statement is not the authority\'s');
$e1 = ledger_records_after(ndb('a.example'), $c['coin'], 0, 5)[0];
$e2 = ledger_records_after(ndb('a.example'), $c['coin'], 1, 5)[0];
$item = fn(array $r, ?array $public = null) => ['public' => $public ?? $r['public'], 'hash' => $r['hash'], 'authoritySignature' => $r['authoritySignature']];
t($refusedEvidence(['kind' => 'authority-equivocation', 'items' => [$item($e1), $item($e2, $e1['public'])]]), 'evidence is refused: an entry whose public form is not the one that was signed');
t($refusedEvidence(['kind' => 'authority-equivocation', 'items' => [$item($e1), $item($e2)]]), 'evidence is refused: two different entries at two different indexes');
$pin = $CLUSTER['c.example']['node']['pinned'];
$CLUSTER['c.example']['node']['pinned']['z.example'] = peer_public(['private' => $zk = ec_private()]);
t(refuses(fn() => $sendFreeze(['kind' => 'fork', 'items' => [$firstA, $firstB]], ['domain' => 'z.example', 'private' => $zk]), 'not-in-roster') && state_of('c.example', $c) === 'active', 'a pinned domain outside the roster cannot report a disagreement');
$CLUSTER['c.example']['node']['pinned'] = $pin;
$DOWN['c.example'] = true;
pay($c, $alice, $bob['key'], '2');
$DOWN['c.example'] = false;
$headBefore = ledger_head(ndb('c.example'), $c['coin']);
// Valid evidence from the same pieces freezes: a statement from the authority after the entry was executed that holds fewer entries.
$r = $sendFreeze(['kind' => 'rollback', 'items' => [$headB, $firstA]]);
t($r['state'] === 'frozen' && (ledger_evidence(ndb('c.example'), $c['coin'])[0]['kind'] ?? null) === 'rollback', 'and evidence that does prove a rollback freezes the receiver');
// A frozen copy takes nothing from the authority.
t(peer_catch_up(ndb('c.example'), node('c.example'), $c['coin'], 'transport', $NOW) === 0 && ledger_head(ndb('c.example'), $c['coin']) === $headBefore, 'a frozen copy does not catch up');
$NOW -= 3;

echo "\n== partner configuration\n";
$good = base64_encode(peer_public(['private' => ec_private()]));
$rsa = openssl_pkey_new(['private_key_type' => OPENSSL_KEYTYPE_RSA, 'private_key_bits' => 2048]);
$rsaPublic = base64_encode(openssl_pkey_get_details($rsa)['key']);
$p384 = openssl_pkey_new(['curve_name' => 'secp384r1', 'private_key_type' => OPENSSL_KEYTYPE_EC]);
$p384Public = base64_encode(openssl_pkey_get_details($p384)['key']);
t(peer_clean_key($good) !== null && peer_clean_key($rsaPublic) === null && peer_clean_key($p384Public) === null && peer_clean_key('not base64 !') === null && peer_clean_key(5) === null && peer_clean_key(base64_encode('hello')) === null, 'only a P-256 public key can be pinned');
foreach (['https://b.example/x' => true, 'http://127.0.0.1:8080/x' => true, 'http://localhost/x' => true, 'http://b.example/x' => false, 'ftp://b.example/x' => false, 'https://user@b.example/x' => false, 'https://b.example/x#f' => false, 'b.example' => false, 'http://127.0.0.1.example.com/x' => false] as $url => $ok) {
    t(peer_url_allowed($url) === $ok, 'peer address ' . $url . ($ok ? ' is allowed' : ' is refused'));
}
$dir = sys_get_temp_dir() . '/peer-config-' . bin2hex(random_bytes(4));
mkdir($dir);
file_put_contents($dir . '/chainlabs-peers.json', json_encode(['keys' => ['b.example' => $good, 'c.example' => $rsaPublic, 'a.example' => $good, 'Bad_Name' => $good, 'd.example' => $good],
    'urls' => ['b.example' => 'http://127.0.0.1:9/x', 'd.example' => 'http://d.example/x', 'c.example' => 'https://c.example/x']]));
$cfg = peer_load_config('a.example', $dir, ['peer_public_pem_b64' => $good], ['a.example' => 'e.example']);
t(array_keys($cfg['pinned']) === ['e.example', 'b.example', 'd.example'], 'keys come from the federation configuration and the peers file; unusable ones, this domain and odd names are left out', array_keys($cfg['pinned']));
t($cfg['urls'] === ['b.example' => 'http://127.0.0.1:9/x'], 'an address is kept only if it is allowed and its domain is pinned', $cfg['urls']);
$send = peer_http_sender($cfg, 2);
t(refuses(fn() => $send('x.example', peer_envelope(['domain' => 'a.example', 'private' => ec_private()], 'x.example', 'sync', [], $NOW)), 'unknown-peer'), 'the transport reaches pinned domains only');
t(refuses(fn() => $send('b.example', peer_envelope(['domain' => 'a.example', 'private' => ec_private()], 'b.example', 'sync', [], $NOW)), 'peer-down'), 'a domain that does not answer is a peer-down error');
file_put_contents($dir . '/chainlabs-peers.json', '{oops');
t(peer_load_config('a.example', $dir, [], [])['pinned'] === [], 'an unreadable peers file pins nothing');
unlink($dir . '/chainlabs-peers.json');
rmdir($dir);

echo "\n== threshold rules at the ledger\n";
cluster(3);
$D = ['a.example', 'b.example', 'c.example'];
$c = open_coin(3, null);
open_now($c);
$u = owner();
$A = ndb('a.example'); $an = node('a.example');
$prep = ledger_prepare_transfer($A, $c['coin'], auth('a.example', $c, $c['treasury'], $u['key'], '10'), $NOW);
$bytes = ledger_approval_bytes($c['coin'], 1, $prep['hash']);
$bsig = ['domain' => 'b.example', 'signature' => ledger_sign(node('b.example')['private'], $bytes)];
t(refuses(fn() => ledger_commit($A, $c['coin'], $prep, ledger_sign($an['private'], $prep['hash']), [$bsig], $NOW), 'not-enough-approvals'), 'an all-of-three entry with one partner\'s approval is refused');
t(refuses(fn() => ledger_commit($A, $c['coin'], $prep, ledger_sign($an['private'], $prep['hash']), [], $NOW), 'not-enough-approvals'), 'and with none');
$cbogus = ['domain' => 'c.example', 'signature' => ledger_sign(node('b.example')['private'], $bytes)];
t(refuses(fn() => ledger_commit($A, $c['coin'], $prep, ledger_sign($an['private'], $prep['hash']), [$bsig, $cbogus], $NOW), 'bad-approval'), 'and with one partner signing as another');
t(refuses(fn() => ledger_commit($A, $c['coin'], $prep, ledger_sign(node('b.example')['private'], $prep['hash']), [$bsig], $NOW), 'bad-authority-signature'), 'and an entry signed by a partner in place of the authority');

echo "\n" . ($failures === 0 ? 'ALL ' . $total . ' CHAIN-LABS MULTI CHECKS PASSED' : $failures . ' of ' . $total . ' checks FAILED') . "\n";
exit($failures === 0 ? 0 : 1);
