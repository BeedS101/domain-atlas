<?php
declare(strict_types=1);
// Activating signature format 2 (chain-labs/lib/sigformat.php, applied in lib/ledger.php and lib/peer.php). What this covers:
//   - the activation is a record outside the ledger database, written and flushed before the first signature in format 2, and a database
//     restored from an older copy does not undo it
//   - a lost, damaged or unexplained record refuses every signature; it never turns back into format 1
//   - an activation cut short by a crash leaves nothing signed in the new format, and can be done again
//   - a domain asks each partner whether it can verify format 2 with a fresh challenge and samples, and counts only a signed, matching answer
//   - mixed versions: a partner that cannot verify format 2, one that still signs genesis in format 1, a partner that activates first
//   - a coin from before keeps working through activation, and a coin opened after it is in format 2 throughout
//
//   php test/chain-labs-sigformat-activation.php
require __DIR__ . '/support/multi-cluster.php';

function new_db(): PDO
{
    return ledger_open(tempnam(sys_get_temp_dir(), 'ledger-activation-') . '.sqlite');
}
function db_file(PDO $db): string
{
    return (string) $db->query('PRAGMA database_list')->fetch(PDO::FETCH_ASSOC)['file'];
}
function dom(string $domain): array
{
    static $keys = [];
    if (!isset($keys[$domain])) {
        $priv = ec_private();
        $keys[$domain] = ['domain' => $domain, 'priv' => $priv, 'pub' => openssl_pkey_get_details(openssl_pkey_get_private($priv))['key']];
    }
    return $keys[$domain];
}
// A coin of one domain on its own database, opened in format 1 as every coin was before.
function world(string $domain = 'a.example'): array
{
    global $NOW;
    $db = new_db();
    $d = dom($domain);
    $treasury = owner();
    $genesis = ledger_genesis(['symbol' => 'ACT', 'name' => 'Activation coin', 'decimals' => 2, 'maxUnits' => '2000000', 'initialUnits' => '1000000', 'treasuryKey' => $treasury['key'],
        'mode' => 'single', 'visibility' => 'public', 'roster' => [['domain' => $domain, 'key' => $d['pub']]], 'createdAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW - 3600)]);
    ledger_register($db, $genesis, $treasury['key'], null);
    ledger_add_genesis_signature($db, $genesis['coinId'], $domain, ledger_genesis_sign_own($db, $genesis, $d['priv'], $domain));
    ledger_activate($db, $genesis['coinId'], $d['priv']);
    return ['db' => $db, 'coin' => $genesis['coinId'], 'genesis' => $genesis, 'digest' => ledger_genesis_digest($genesis), 'dom' => $d, 'treasury' => $treasury, 'file' => db_file($db)];
}
function seq_of(array $w, array $from): int
{
    $row = ledger_account_row($w['db'], $w['coin'], $from['key']);
    return $row ? (int) $row['seq'] : 0;
}
function transfer_auth(array $w, array $from, string $to, string $amount): array
{
    global $NOW;
    $payload = ['type' => 'atlas.ledger.transfer', 'v' => 2, 'coinId' => $w['coin'], 'from' => $from['key'], 'to' => $to, 'amount' => $amount, 'baseSeq' => seq_of($w, $from),
        'baseHead' => ledger_head($w['db'], $w['coin'])['hash'], 'nonce' => bin2hex(random_bytes(16)), 'issuedAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW - 10), 'expiresAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW + 300),
        'authority' => $w['genesis']['authority'], 'genesis' => $w['digest']];
    return ['payload' => $payload, 'signature' => ledger_owner_sign($from['priv'], $payload)];
}
// Sends as the authority would: the format is the ledger's own choice unless one is named.
function send(array $w, string $to, string $amount, ?string $format = null): array
{
    global $NOW;
    $prepared = ledger_prepare_transfer($w['db'], $w['coin'], transfer_auth($w, $w['treasury'], $to, $amount), $NOW);
    $index = (int) $prepared['public']['index'];
    $sig = match ($format) {
        'legacy' => ledger_sign($w['dom']['priv'], $prepared['hash']),
        default => ledger_sign_entry($w['db'], $w['coin'], $w['dom']['priv'], $index, $prepared['hash']),
    };
    return ledger_commit($w['db'], $w['coin'], $prepared, $sig, [], $NOW);
}
function kinds(PDO $db, array $genesis, string $coin): array
{
    $out = [];
    foreach ($db->query("SELECT idx FROM ledger_log WHERE coin_id='" . $coin . "' ORDER BY idx")->fetchAll(PDO::FETCH_COLUMN) as $i) $out[] = ledger_stored_kind($db, $genesis, $coin, (int) $i);
    return $out;
}
function marker_path(PDO $db): string { return sigformat_marker_file($db); }
function row_count(PDO $db): int { return (int) $db->query('SELECT COUNT(*) FROM ledger_sig_format')->fetchColumn(); }
function restore(array &$w, string $backup): void
{
    $w['db'] = null;
    foreach (['', '-wal', '-shm'] as $suffix) @unlink($w['file'] . $suffix);
    copy($backup, $w['file']);
    $w['db'] = ledger_open($w['file']);
}
function snapshot(array $w): string
{
    $dest = tempnam(sys_get_temp_dir(), 'activation-backup-');
    unlink($dest);
    $w['db']->exec("VACUUM INTO '" . $dest . "'");
    return $dest;
}

$L = SIGFORMAT_LEGACY;
$N = SIGFORMAT_V2;

echo "== a domain that has not activated signs in format 1 and nothing else changes\n";
$w = world();
$state = sigformat_state($w['db'], 'a.example');
t($state['state'] === 'legacy' && !$state['marker'] && !$state['row'] && !ledger_sig_activated($w['db'], 'a.example'), 'with no record the domain is not activated', $state);
send($w, owner()['key'], '10');
t(kinds($w['db'], $w['genesis'], $w['coin']) === [$L, $L], 'entry 0 and a new entry are signed in format 1');
t(ledger_check($w['db'], $w['coin']) === [], 'the checker passes');

echo "\n== activating writes the record, then the row\n";
$done = sigformat_record_activation($w['db'], 'a.example', $NOW);
t($done['already'] === false && $done['state'] === 'active' && $done['marker'] && $done['row'], 'the record is written and the domain is active', $done);
t(ledger_sig_activated($w['db'], 'a.example') && !ledger_sig_activated($w['db'], 'b.example'), 'it is active for this domain and not for another name');
$file = marker_path($w['db']);
t(is_file($file) && (fileperms($file) & 0777) === 0600 && (fileperms(dirname($file)) & 0777) === 0700, 'the file is private (0600) in a private folder (0700)', decoct(fileperms($file) & 0777));
$lines = explode("\n", rtrim((string) file_get_contents($file), "\n"));
$first = json_decode($lines[0], true);
t(count($lines) === 1 && $first['kind'] === 'activate' && $first['format'] === 2 && $first['domain'] === 'a.example' && $first['at'] === $NOW && $first['prevSum'] === GUARD_ZERO, 'it holds one line that names the format, the domain and the time', $first);
$again = sigformat_record_activation($w['db'], 'a.example', $NOW + 60);
t($again['already'] === true && count(explode("\n", rtrim((string) file_get_contents($file), "\n"))) === 1 && $again['at'] === $NOW, 'activating again changes nothing');
t(refuses(fn() => send($w, owner()['key'], '11', 'legacy'), 'signature-downgrade') && ledger_head($w['db'], $w['coin'])['index'] === 1, 'the first entry after activation cannot be signed in format 1 either, though no entry is in format 2 yet');
send($w, owner()['key'], '11');
t(kinds($w['db'], $w['genesis'], $w['coin']) === [$L, $L, $N], 'the next entry is signed in format 2, on a coin that was in format 1');
t(refuses(fn() => send($w, owner()['key'], '12', 'legacy'), 'signature-downgrade'), 'a signature in format 1 on the next entry is refused');
t(ledger_check($w['db'], $w['coin']) === [], 'the coin of mixed history checks');

echo "\n== a coin opened after activation is in format 2 throughout\n";
$treasury = owner();
$d = $w['dom'];
$genesis = ledger_genesis(['symbol' => 'NEW', 'name' => 'New coin', 'decimals' => 2, 'maxUnits' => '2000000', 'initialUnits' => '1000', 'treasuryKey' => $treasury['key'], 'mode' => 'single', 'visibility' => 'public',
    'roster' => [['domain' => 'a.example', 'key' => $d['pub']]], 'createdAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW - 3600)]);
ledger_register($w['db'], $genesis, $treasury['key'], null);
ledger_add_genesis_signature($w['db'], $genesis['coinId'], 'a.example', ledger_genesis_sign_own($w['db'], $genesis, $d['priv'], 'a.example'));
ledger_activate($w['db'], $genesis['coinId'], $d['priv']);
t(kinds($w['db'], $genesis, $genesis['coinId']) === [$N] && ledger_check($w['db'], $genesis['coinId']) === [], 'entry 0 and its genesis signature are in format 2 and check');
t(ledger_genesis_kind($genesis, $genesis['coinId'], ledger_genesis_digest($genesis), 'a.example', $w['db']->query("SELECT signature FROM ledger_genesis_sigs WHERE coin_id='" . $genesis['coinId'] . "'")->fetchColumn()) === $N, 'the stored genesis signature is in format 2');
$g2 = ledger_genesis(['symbol' => 'OLD', 'name' => 'Old coin', 'decimals' => 2, 'maxUnits' => '2000000', 'initialUnits' => '1000', 'treasuryKey' => $treasury['key'], 'mode' => 'single', 'visibility' => 'public',
    'roster' => [['domain' => 'a.example', 'key' => $d['pub']]], 'createdAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW - 3600)]);
ledger_register($w['db'], $g2, $treasury['key'], null);
t(refuses(fn() => ledger_add_genesis_signature($w['db'], $g2['coinId'], 'a.example', ledger_genesis_sign($g2, $d['priv'])), 'partner-needs-upgrade'), 'an activated authority takes no genesis signature in format 1 for a new coin');

echo "\n== a database restored from an older copy does not undo it\n";
$w = world();
send($w, owner()['key'], '1', 'legacy');
$backup = snapshot($w);
sigformat_record_activation($w['db'], 'a.example', $NOW);
send($w, owner()['key'], '2');
send($w, owner()['key'], '3');
$head = ledger_head($w['db'], $w['coin']);
restore($w, $backup);
$state = sigformat_state($w['db'], 'a.example');
t(row_count($w['db']) === 0 && $state['state'] === 'active' && $state['marker'] && !$state['row'], 'the old copy has no row, and the domain is still active because of the record outside the database', $state);
t(ledger_head($w['db'], $w['coin'])['index'] === 1, 'the database is back at entry 1');
t(ledger_guard_check($w['db'], $w['coin'], false)['status'] === 'halted', 'and the checkpoint stops the coin, as it does for any rollback');
$res = ledger_guard_replay($w['db'], $w['coin'], $NOW);
t($res['applied'] === 2 && $res['status'] === 'ok' && ledger_head($w['db'], $w['coin']) === $head, 'the journal replays the two format 2 entries, each checked, and the head is what it was', ['applied' => $res['applied'], 'status' => $res['status'], 'error' => $res['error'] ?? null]);
t(kinds($w['db'], $w['genesis'], $w['coin']) === [$L, $L, $N, $N] && ledger_check($w['db'], $w['coin']) === [], 'the log holds format 1 and then format 2 entries and checks');
send($w, owner()['key'], '4');
t(kinds($w['db'], $w['genesis'], $w['coin'])[4] === $N && refuses(fn() => send($w, owner()['key'], '5', 'legacy'), 'signature-downgrade'), 'the next entry is in format 2, and format 1 is refused');

echo "\n== a lost record refuses every signature, and never becomes format 1\n";
$w = world();
sigformat_record_activation($w['db'], 'a.example', $NOW);
send($w, owner()['key'], '1');
$kept = file_get_contents(marker_path($w['db']));
unlink(marker_path($w['db']));
$state = sigformat_state($w['db'], 'a.example');
t($state['state'] === 'unavailable' && $state['row'] && !$state['marker'], 'with the row and no record the state is unavailable', $state);
foreach ([
    'the activation check' => fn() => ledger_sig_activated($w['db'], 'a.example'),
    'a new entry' => fn() => send($w, owner()['key'], '2'),
    'a genesis signature as the authority' => fn() => ledger_genesis_sign_own($w['db'], $w['genesis'], $w['dom']['priv'], 'a.example'),
    'a partner\'s genesis signature' => fn() => ledger_genesis_sign($w['genesis'], $w['dom']['priv'], 'a.example', ledger_sig_activated($w['db'], 'a.example')),
] as $what => $fn) t(refuses($fn, 'signature-format-unavailable'), 'is refused: ' . $what, why($fn));
t(refuses(fn() => sigformat_record_activation($w['db'], 'a.example', $NOW), 'signature-format-unavailable'), 'activating again does not quietly repair it');
$fixed = sigformat_record_activation($w['db'], 'a.example', $NOW + 5, true);
t($fixed['state'] === 'active' && is_file(marker_path($w['db'])), 'an operator repairing it writes a new record (recover) and the domain is active again', $fixed);
send($w, owner()['key'], '3');
t(ledger_check($w['db'], $w['coin']) === [] && kinds($w['db'], $w['genesis'], $w['coin']) === [$L, $N, $N], 'and signs in format 2');

echo "\n== a record with a changed line, or the wrong domain, is damaged\n";
$w = world();
sigformat_record_activation($w['db'], 'a.example', $NOW);
$file = marker_path($w['db']);
$good = file_get_contents($file);
file_put_contents($file, str_replace('"at":' . $NOW, '"at":' . ($NOW + 1), $good));
$state = sigformat_state($w['db'], 'a.example');
t($state['state'] === 'unavailable' && str_contains($state['reason'], 'damaged'), 'a line whose sum no longer holds', $state);
t(refuses(fn() => send($w, owner()['key'], '1'), 'signature-format-unavailable'), 'refuses the next entry');
file_put_contents($file, $good . "garbage that ends in a newline\n");
t(sigformat_state($w['db'], 'a.example')['state'] === 'unavailable', 'a complete line of garbage after it');
file_put_contents($file, '');
t(sigformat_state($w['db'], 'a.example')['state'] === 'unavailable', 'an emptied record while the database says activated');
file_put_contents($file, $good);
t(sigformat_state($w['db'], 'a.example')['state'] === 'active', 'put back as it was, it is active');
$w['db']->exec("UPDATE ledger_sig_format SET domain='z.example'");
$state = sigformat_state($w['db'], 'a.example');
t($state['state'] === 'unavailable' && str_contains($state['reason'], 'disagree'), 'a row that names another domain than the record', $state);
$w['db']->exec("UPDATE ledger_sig_format SET domain='a.example'");
file_put_contents($file, $good);
$bad = sigformat_record_activation($w['db'], 'a.example', $NOW, false);
t($bad['already'] === true, 'a consistent record is accepted again');
file_put_contents($file, str_replace('"format":2', '"format":3', $good));
t(sigformat_state($w['db'], 'a.example')['state'] === 'unavailable', 'a format this code does not know is not read as activated');
file_put_contents($file, "not json at all\n");
$recovered = sigformat_record_activation($w['db'], 'a.example', $NOW + 9, true);
$asides = glob($file . '.damaged-*');
t($recovered['state'] === 'active' && count($asides) === 1 && trim((string) file_get_contents($asides[0])) === 'not json at all', 'recovering a damaged record keeps the damaged file aside and writes a new one', $recovered);

echo "\n== a coin that carries format 2 with no record of activating it stops the domain\n";
$w = world();
sigformat_record_activation($w['db'], 'a.example', $NOW);
send($w, owner()['key'], '1');
unlink(marker_path($w['db']));
$w['db']->exec('DELETE FROM ledger_sig_format');
$state = sigformat_state($w['db'], 'a.example');
t($state['state'] === 'unavailable' && str_contains($state['reason'], 'no record'), 'with neither the record nor the row, format 2 signatures on this domain\'s own coin are not explained', $state);
t(refuses(fn() => send($w, owner()['key'], '2'), 'signature-format-unavailable'), 'so the domain signs nothing by itself');
t(refuses(fn() => send($w, owner()['key'], '2', 'legacy'), 'signature-downgrade'), 'and a signature in format 1 is refused all the same');
$partner = world('b.example');
$state = sigformat_state($partner['db'], 'a.example');
t($state['state'] === 'legacy', 'a domain that only holds another domain\'s coins in format 2 is not affected by them');

echo "\n== an activation that was interrupted\n";
$w = world();
$file = marker_path($w['db']);
$line = ledger_canonical(['at' => $NOW, 'domain' => 'a.example', 'format' => 2, 'kind' => 'activate', 'prevSum' => GUARD_ZERO]);
@mkdir(dirname($file), 0700, true);
file_put_contents($file, substr($line, 0, 40));
$state = sigformat_state($w['db'], 'a.example');
t($state['state'] === 'legacy' && !ledger_sig_activated($w['db'], 'a.example'), 'a write cut short before the signature of the line is not an activation', $state);
send($w, owner()['key'], '1');
t(kinds($w['db'], $w['genesis'], $w['coin']) === [$L, $L], 'nothing was signed in format 2');
$done = sigformat_record_activation($w['db'], 'a.example', $NOW);
t($done['state'] === 'active' && count(explode("\n", rtrim((string) file_get_contents($file), "\n"))) === 1, 'activating again clears the unfinished write and records it once', $done);
$w = world();
sigformat_record_activation($w['db'], 'a.example', $NOW);
$w['db']->exec('DELETE FROM ledger_sig_format');
$state = sigformat_state($w['db'], 'a.example');
t($state['state'] === 'active' && $state['marker'] && !$state['row'], 'the record written and the row not yet: the domain is active (the record is the decision)', $state);
send($w, owner()['key'], '1');
t(kinds($w['db'], $w['genesis'], $w['coin']) === [$L, $N], 'and signs in format 2');
$done = sigformat_record_activation($w['db'], 'a.example', $NOW + 30);
t($done['already'] === true && row_count($w['db']) === 1, 'running the activation again writes the row');
$mem = ledger_open(':memory:');
t(refuses(fn() => sigformat_record_activation($mem, 'a.example', $NOW), 'signature-format-unavailable'), 'a database with no private folder cannot be activated');

echo "\n== a domain asks a partner whether it can verify format 2\n";
cluster(3);
$send = 'transport';
$probe = peer_probe_sigformat(node('a.example'), 'b.example', $send, $NOW);
t($probe === ['ok' => true, 'reason' => ''], 'an upgraded partner shows it: its verdicts on fresh samples are right and signed', $probe);
$made1 = sigformat_probe_make();
$made2 = sigformat_probe_make();
t($made1['challenge'] !== $made2['challenge'] && $made1['key'] !== $made2['key'] && $made1['samples'] !== $made2['samples'], 'every probe has its own challenge, key and samples');
t(count(array_unique(array_map(fn() => json_encode(sigformat_probe_make()['expect']), range(1, 12)))) > 1, 'and the order of the right answers is not always the same');
t(sigformat_probe_verdicts($made1) === $made1['expect'], 'the verdicts this code gives on a probe are the expected ones');
$old = static function (string $to, array $envelope) { if ($to === 'b.example' && $envelope['payload']['action'] === 'sigformat') ledger_fail('unknown-action', 'unknown peer action'); return transport($to, $envelope); };
$probe = peer_probe_sigformat(node('a.example'), 'b.example', $old, $NOW);
t($probe['ok'] === false && str_contains($probe['reason'], 'not been upgraded'), 'a partner that does not know the check is not ready', $probe);
$down = static function (string $to, array $envelope) { ledger_fail('peer-down', $to . ' did not answer'); };
$probe = peer_probe_sigformat(node('a.example'), 'b.example', $down, $NOW);
t($probe['ok'] === false && str_contains($probe['reason'], 'did not answer'), 'nor is one that does not answer', $probe);
// Answers a forger or a stale replay could give.
$answerOf = static fn(string $to, array $envelope) => transport($to, $envelope);
$captured = null;
$spy = static function (string $to, array $envelope) use (&$captured) { $a = transport($to, $envelope); $captured = $a; return $a; };
peer_probe_sigformat(node('a.example'), 'b.example', $spy, $NOW);
$replayed = static fn(string $to, array $envelope) => $captured;
$probe = peer_probe_sigformat(node('a.example'), 'b.example', $replayed, $NOW);
t($probe['ok'] === false && str_contains($probe['reason'], 'not for this request'), 'an answer to an earlier probe, sent again, is refused: it repeats another challenge', $probe);
$unsigned = static function (string $to, array $envelope) { $a = transport($to, $envelope); unset($a['signature']); return $a; };
t(peer_probe_sigformat(node('a.example'), 'b.example', $unsigned, $NOW)['ok'] === false, 'an answer with no signature is refused');
$byOther = static function (string $to, array $envelope) { $a = transport($to, $envelope); $a['signature'] = ledger_sign(node('c.example')['private'], ledger_canonical($a['payload'])); return $a; };
$probe = peer_probe_sigformat(node('a.example'), 'b.example', $byOther, $NOW);
t($probe['ok'] === false && str_contains($probe['reason'], 'pinned key'), 'an answer signed by another domain\'s key is refused', $probe);
$resign = static function (callable $edit) {
    return static function (string $to, array $envelope) use ($edit) { $a = transport($to, $envelope); $edit($a['payload']); $a['signature'] = ledger_sign(node($to)['private'], ledger_canonical($a['payload'])); return $a; };
};
$probe = peer_probe_sigformat(node('a.example'), 'b.example', $resign(function (array &$p) { $p['results'] = array_map(fn($r) => $r === null ? SIGFORMAT_V2 : $r, $p['results']); }), $NOW);
t($probe['ok'] === false && str_contains($probe['reason'], 'wrong verdict'), 'a signed answer that approves every sample is refused: it cannot be told apart from one that did not look', $probe);
$probe = peer_probe_sigformat(node('a.example'), 'b.example', $resign(function (array &$p) { $p['to'] = 'c.example'; }), $NOW);
t($probe['ok'] === false && str_contains($probe['reason'], 'not for this request'), 'a signed answer that names another asker is refused', $probe);
$probe = peer_probe_sigformat(node('a.example'), 'b.example', $resign(function (array &$p) { $p['issuedAt'] = gmdate('Y-m-d\TH:i:s\Z', 1800000000 - 100000); }), $NOW);
t($probe['ok'] === false && str_contains($probe['reason'], 'not recent'), 'a signed answer that is not recent is refused', $probe);
$probe = peer_probe_sigformat(node('a.example'), 'b.example', $resign(function (array &$p) { $p['extra'] = 1; }), $NOW);
t($probe['ok'] === false, 'a signed answer with another shape is refused');
$versionOnly = static function (string $to, array $envelope) { return ['version' => 2, 'formats' => [1, 2]]; };
t(peer_probe_sigformat(node('a.example'), 'b.example', $versionOnly, $NOW)['ok'] === false, 'a plain, unsigned version number is not accepted');
t(refuses(fn() => peer_handle(ndb('b.example'), node('b.example'), peer_envelope(node('a.example'), 'b.example', 'sigformat', ['challenge' => 'x'], $NOW), $NOW, 'transport'), 'bad-request'), 'a probe with no valid challenge is refused');
t(refuses(fn() => peer_handle(ndb('b.example'), node('b.example'), peer_envelope(node('a.example'), 'b.example', 'sigformat', ['challenge' => str_repeat('a', 32), 'key' => 'k', 'samples' => array_fill(0, 40, [])], $NOW), $NOW, 'transport'), 'bad-request'), 'and one with too many samples');

echo "\n== readiness before activating\n";
cluster(3);
$c = open_coin(3, 2);
open_now($c);
$ready = peer_sigformat_readiness(ndb('a.example'), node('a.example'), 'transport', $NOW);
t($ready['ready'] === true && array_keys($ready['partners']) === ['b.example', 'c.example'] && $ready['pendingWithOlderSignatures'] === [], 'every partner of the coin proves it, and nothing is waiting', $ready);
$DOWN['c.example'] = true;
$ready = peer_sigformat_readiness(ndb('a.example'), node('a.example'), 'transport', $NOW);
t($ready['ready'] === false && $ready['partners']['b.example']['ok'] === true && $ready['partners']['c.example']['ok'] === false, 'one partner not answering means not ready, and the others are still reported', $ready);
$DOWN = [];
$oldC = static function (string $to, array $envelope) { if ($to === 'c.example' && $envelope['payload']['action'] === 'sigformat') ledger_fail('unknown-action', 'unknown peer action'); return transport($to, $envelope); };
$ready = peer_sigformat_readiness(ndb('a.example'), node('a.example'), $oldC, $NOW);
t($ready['ready'] === false && str_contains($ready['partners']['c.example']['reason'], 'not been upgraded') && $ready['partners']['b.example']['ok'], 'one partner that was not upgraded means not ready', $ready);
t(sigformat_partners(ndb('b.example'), 'b.example') === ['a.example' => [$c['coin']], 'c.example' => [$c['coin']]], 'a partner also has to hear from the authority and the other partner of its coins');

echo "\n== a pending coin with a genesis signature in format 1 is named before activation\n";
cluster(3);
$p = open_coin(3, 2, 'public', null, 'PND');
try { peer_open_multi(ndb('a.example'), node('a.example'), $p['genesis'], $p['treasury']['key'], $p['secret'], 'transport', $NOW); } catch (LedgerError $e) { $waiting = $e->detail['waiting'] ?? []; }
foreach (array_keys($waiting ?? []) as $dm) consent_accept(ndb($dm), node($dm), $p['coin'], ledger_genesis_digest($p['genesis']), 'test-operator', $NOW);
// One partner has signed and the other has not answered, so the coin stays pending with stored signatures in format 1.
$DOWN['c.example'] = true;
try { peer_open_multi(ndb('a.example'), node('a.example'), $p['genesis'], $p['treasury']['key'], $p['secret'], 'transport', $NOW); } catch (LedgerError $e) {}
$DOWN = [];
t(ledger_coin(ndb('a.example'), $p['coin'])['state'] === 'pending', 'the coin is still pending');
$named = sigformat_pending_legacy(ndb('a.example'), 'a.example');
t(isset($named[$p['coin']]) && in_array('a.example', $named[$p['coin']], true) && in_array('b.example', $named[$p['coin']], true), 'the coin and the domains whose signatures are in format 1 are named', $named);
$ready = peer_sigformat_readiness(ndb('a.example'), node('a.example'), 'transport', $NOW);
t($ready['ready'] === false && isset($ready['pendingWithOlderSignatures'][$p['coin']]), 'so activation is not ready', $ready['pendingWithOlderSignatures']);
$dropped = sigformat_discard_pending_legacy(ndb('a.example'), 'a.example');
t($dropped === count($named[$p['coin']]) && sigformat_pending_legacy(ndb('a.example'), 'a.example') === [], 'discarding forgets exactly those stored signatures', $dropped);
t(peer_sigformat_readiness(ndb('a.example'), node('a.example'), 'transport', $NOW)['ready'] === true, 'and the domain is ready');
sigformat_record_activation(ndb('a.example'), 'a.example', $NOW);
open_now($p);
$zero = ledger_records_after(ndb('a.example'), $p['coin'], -1, 1)[0];
t(ledger_stored_kind(ndb('a.example'), $p['genesis'], $p['coin'], 0) === $N, 'the coin then opens with entry 0 in format 2');
$all = true;
foreach ($zero['approvals'] as $a) if (ledger_genesis_kind($p['genesis'], $p['coin'], ledger_genesis_digest($p['genesis']), $a['domain'], $a['signature']) !== $N) $all = false;
t($all && count($zero['approvals']) === 3, 'and every genesis signature, the partners\' asked again included, is in format 2', $zero['approvals']);
foreach (['a.example', 'b.example', 'c.example'] as $dm) t(ledger_check(ndb($dm), $p['coin']) === [], $dm . ' checks the coin', ledger_check(ndb($dm), $p['coin']));

echo "\n== a coin from before keeps working through activation, on every domain\n";
cluster(3);
$c = open_coin(3, 2);
open_now($c);
$alice = owner();
pay($c, $c['treasury'], $alice['key'], '1000');
pay($c, $alice, owner()['key'], '10');
t(kinds(ndb('a.example'), $c['genesis'], $c['coin']) === [$L, $L, $L], 'it was signed in format 1');
$ready = peer_sigformat_readiness(ndb('a.example'), node('a.example'), 'transport', $NOW);
sigformat_record_activation(ndb('a.example'), 'a.example', $NOW);
t($ready['ready'] === true, 'the partners proved themselves first');
$bob = owner();
pay($c, $alice, $bob['key'], '20');
pay($c, $alice, $bob['key'], '21');
foreach (['a.example', 'b.example', 'c.example'] as $dm) {
    t(kinds(ndb($dm), $c['genesis'], $c['coin']) === [$L, $L, $L, $N, $N] && ledger_check(ndb($dm), $c['coin']) === [], $dm . ' holds format 1 entries and then format 2 entries, and checks', kinds(ndb($dm), $c['genesis'], $c['coin']));
}
t(heads($c, ['a.example', 'b.example', 'c.example']) === array_fill_keys(['a.example', 'b.example', 'c.example'], heads($c, ['a.example'])['a.example']), 'all three domains have the same head');
$prepared = ledger_prepare_transfer(ndb('a.example'), $c['coin'], auth('a.example', $c, $alice, $bob['key'], '5'), $NOW);
t(refuses(fn() => ledger_commit(ndb('a.example'), $c['coin'], $prepared, ledger_sign(node('a.example')['private'], $prepared['hash']), [], $NOW), 'signature-downgrade'), 'the authority cannot commit an entry in format 1 any more');

echo "\n== a coin opened after the authority activated is in format 2 on every domain\n";
$d = open_coin(3, 2, 'public', null, 'FRS');
open_now($d);
foreach (['a.example', 'b.example', 'c.example'] as $dm) t(kinds(ndb($dm), $d['genesis'], $d['coin']) === [$N] && ledger_check(ndb($dm), $d['coin']) === [], $dm . ': entry 0 and every genesis signature are in format 2', ledger_check(ndb($dm), $d['coin']));
pay($d, $d['treasury'], $alice['key'], '300');
t(kinds(ndb('c.example'), $d['genesis'], $d['coin']) === [$N, $N] && ledger_check(ndb('c.example'), $d['coin']) === [], 'a transfer on it is in format 2 on a partner that did not activate');

echo "\n== a partner that still signs the genesis in format 1\n";
$stale = static function (string $to, array $envelope) {
    $answer = transport($to, $envelope);
    if ($to === 'b.example' && $envelope['payload']['action'] === 'genesis') {
        $g = $envelope['payload']['body']['genesis'];
        $answer['signature'] = ledger_sign(node('b.example')['private'], ledger_genesis_digest($g));
    }
    return $answer;
};
$e = open_coin(3, 2, 'public', null, 'STL');
$err = null;
try { peer_open_multi(ndb('a.example'), node('a.example'), $e['genesis'], $e['treasury']['key'], $e['secret'], $stale, $NOW); } catch (LedgerError $x) { $err = $x; }
if ($err && $err->reason === 'needs-consent') foreach (array_keys($err->detail['waiting'] ?? []) as $dm) consent_accept(ndb($dm), node($dm), $e['coin'], ledger_genesis_digest($e['genesis']), 'test-operator', $NOW);
t(refuses(fn() => peer_open_multi(ndb('a.example'), node('a.example'), $e['genesis'], $e['treasury']['key'], $e['secret'], $stale, $NOW), 'partner-needs-upgrade'), 'an activated authority refuses it, and says which partner has to be upgraded', why(fn() => peer_open_multi(ndb('a.example'), node('a.example'), $e['genesis'], $e['treasury']['key'], $e['secret'], $stale, $NOW)));
t(ledger_coin(ndb('a.example'), $e['coin'])['state'] === 'pending' && ledger_check(ndb('a.example'), $e['coin']) === [], 'the coin stays pending and nothing was opened');
$stored = ndb('a.example')->query("SELECT domain,signature FROM ledger_genesis_sigs WHERE coin_id='" . $e['coin'] . "'")->fetchAll(PDO::FETCH_KEY_PAIR);
t(!isset($stored['b.example']), 'the signature in format 1 was not kept', array_keys($stored));
open_now($e);
t(ledger_coin(ndb('a.example'), $e['coin'])['state'] === 'active' && kinds(ndb('a.example'), $e['genesis'], $e['coin']) === [$N], 'once the partner signs as it should, the coin opens in format 2');
$bodies = [];
$spyGenesis = static function (string $to, array $envelope) use (&$bodies) { if ($envelope['payload']['action'] === 'genesis') $bodies[$to] = $envelope['payload']['body']; return transport($to, $envelope); };
$f = open_coin(3, 2, 'public', null, 'ASK');
try { peer_open_multi(ndb('a.example'), node('a.example'), $f['genesis'], $f['treasury']['key'], $f['secret'], $spyGenesis, $NOW); } catch (LedgerError $x) {}
t(($bodies['b.example']['sig'] ?? null) === 2 && ($bodies['c.example']['sig'] ?? null) === 2, 'an activated authority asks every partner for format 2 in the request');

echo "\n== a partner that activates before its authority\n";
cluster(3);
sigformat_record_activation(ndb('b.example'), 'b.example', $NOW);
$g = open_coin(3, 2, 'public', null, 'PRT');
open_now($g);
$zero = ledger_records_after(ndb('a.example'), $g['coin'], -1, 1)[0];
$kindOf = fn(string $dm) => ledger_genesis_kind($g['genesis'], $g['coin'], ledger_genesis_digest($g['genesis']), $dm, collect_sig($zero, $dm));
function collect_sig(array $zero, string $dm): ?string { foreach ($zero['approvals'] as $a) if ($a['domain'] === $dm) return $a['signature']; return null; }
t($kindOf('b.example') === $N && $kindOf('a.example') === $L && $kindOf('c.example') === $L, 'the partner signs in format 2 whatever it is asked, the others in format 1');
t(kinds(ndb('a.example'), $g['genesis'], $g['coin']) === [$L] && ledger_check(ndb('a.example'), $g['coin']) === [], 'the coin opens with entry 0 in format 1 and checks: format 2 genesis signatures are allowed under it');
foreach (['b.example', 'c.example'] as $dm) t(ledger_check(ndb($dm), $g['coin']) === [], $dm . ' checks it');
pay($g, $g['treasury'], $alice['key'], '100');
t(kinds(ndb('b.example'), $g['genesis'], $g['coin']) === [$L, $L], 'and the authority, which has not activated, still signs entries in format 1');
$prepared = ledger_prepare_transfer(ndb('a.example'), $g['coin'], auth('a.example', $g, $alice, owner()['key'], '3'), $NOW);
$stateB = sigformat_state(ndb('b.example'), 'b.example');
t($stateB['state'] === 'active' && !ledger_sig_activated(ndb('b.example'), 'a.example'), 'a partner that activated does not sign as another domain');

echo "\n== a database restored on the authority across its activation\n";
cluster(3);
$h = open_coin(3, 2, 'public', null, 'RST');
open_now($h);
pay($h, $h['treasury'], $alice['key'], '500');
$file = $CLUSTER['a.example']['file'];
$back = tempnam(sys_get_temp_dir(), 'activation-cluster-');
unlink($back);
ndb('a.example')->exec("VACUUM INTO '" . $back . "'");
sigformat_record_activation(ndb('a.example'), 'a.example', $NOW);
pay($h, $alice, owner()['key'], '7');
pay($h, $alice, owner()['key'], '8');
$headAfter = ledger_head(ndb('b.example'), $h['coin']);
$CLUSTER['a.example']['db'] = null;
foreach (['', '-wal', '-shm'] as $suffix) @unlink($file . $suffix);
copy($back, $file);
$CLUSTER['a.example']['db'] = ledger_open($file);
t(row_count(ndb('a.example')) === 0 && sigformat_state(ndb('a.example'), 'a.example')['state'] === 'active', 'the authority\'s database is back before its activation, and it is still active');
$verdict = ledger_guard_check(ndb('a.example'), $h['coin'], false);
t($verdict['status'] === 'halted' && $verdict['reason'] === 'rollback', 'the rollback protection stops the coin as before', $verdict);
$res = ledger_guard_replay(ndb('a.example'), $h['coin'], $NOW);
t($res['status'] === 'ok' && ledger_head(ndb('a.example'), $h['coin']) === $headAfter, 'the journal puts back the entries, format 2 ones included, to the head the partners hold', ['applied' => $res['applied'], 'status' => $res['status'], 'error' => $res['error'] ?? null]);
pay($h, $alice, owner()['key'], '9');
t(kinds(ndb('a.example'), $h['genesis'], $h['coin'])[count(kinds(ndb('a.example'), $h['genesis'], $h['coin'])) - 1] === $N && ledger_check(ndb('a.example'), $h['coin']) === [], 'and it signs the next entry in format 2');

echo "\n";
if ($failures === 0) echo "ALL $total CHAIN-LABS SIGNATURE FORMAT ACTIVATION CHECKS PASSED\n";
else { echo "$failures of $total checks FAILED\n"; exit(1); }
