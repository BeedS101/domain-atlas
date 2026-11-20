<?php
declare(strict_types=1);
// Partner consent before a multi authority coin's genesis is signed (chain-labs/lib/consent.php, lib/peer.php), several nodes in one process:
//   - a partner records a proposal and does not sign it; the operator reviews the terms, accepts or declines
//   - consent is bound to the exact coin and genesis digest, a signature is issued only after acceptance, and a signature already issued is final
//   - a missing, damaged or ambiguous consent record never signs: every failure to read or write it refuses
//   - coins that were pending before the upgrade are the only ones that sign without consent, and only those the upgrade itself found
//   - declined proposals are bounded, and freeing a slot cannot grow storage without limit
//   - the authority is told which partners accepted and when, and says so without calling it proof
//
//   php test/chain-labs-consent.php
require __DIR__ . '/support/multi-cluster.php';

$ask = function (array $c, string $to = 'b.example', string $from = 'a.example') {
    global $NOW;
    return transport($to, peer_envelope(node($from), $to, 'genesis', ['genesis' => $c['genesis'], 'treasuryKey' => $c['treasury']['key'], 'refSecret' => $c['secret']], $NOW));
};
$digest = fn(array $c): string => ledger_genesis_digest($c['genesis']);
$consentRow = function (string $d, array $c) {
    $q = ndb($d)->prepare('SELECT * FROM ledger_consents WHERE coin_id=?');
    $q->execute([$c['coin']]);
    return $q->fetch(PDO::FETCH_ASSOC) ?: null;
};
$by = str_repeat('ab', 8);

echo "== a partner records a proposal and does not sign it\n";
cluster(3);
$c = open_coin(3, null);
t(refuses(fn() => $ask($c), 'needs-consent'), 'a partner answers a new genesis with needs-consent, not a signature');
$row = $consentRow('b.example', $c);
t($row !== null && $row['status'] === 'awaiting' && $row['genesis_digest'] === $digest($c) && $row['signed_at'] === null, 'the proposal is recorded as awaiting, bound to the genesis digest', $row);
t(ledger_coin(ndb('b.example'), $c['coin'])['state'] === 'pending', 'and the coin is held as pending, as before');
t(refuses(fn() => $ask($c), 'needs-consent'), 'asking again changes nothing: still needs-consent');
t((int) ndb('b.example')->query('SELECT COUNT(*) FROM ledger_consents')->fetchColumn() === 1, 'one record per coin, however often the authority asks');
$list = consent_list(ndb('b.example'), node('b.example'));
t(count($list) === 1 && $list[0]['coinId'] === $c['coin'] && $list[0]['status'] === 'awaiting' && $list[0]['signed'] === false && $list[0]['canAccept'] && $list[0]['canDecline'], 'the partner operator sees the proposal as awaiting', $list);
$terms = $list[0]['terms'] ?? [];
t(($terms['symbol'] ?? null) === 'MUL' && ($terms['name'] ?? null) === 'Coin MUL' && ($terms['decimals'] ?? null) === 2 && ($terms['authority'] ?? null) === 'a.example' && ($terms['threshold'] ?? null) === 3 && ($terms['mode'] ?? null) === 'multi', 'the review shows symbol, name, decimals, authority, mode and threshold', $terms);
t(($terms['maxUnits'] ?? null) === '1000000' && ($terms['initialUnits'] ?? null) === '100000' && ($terms['maxSupply'] ?? null) === '10000.00' && ($terms['initialSupply'] ?? null) === '1000.00', 'supply is shown as units and as coins', $terms);
t(($terms['treasuryRef'] ?? null) === $c['genesis']['treasuryRef'] && ($terms['visibility'] ?? null) === 'public' && ($terms['createdAt'] ?? null) === $c['genesis']['createdAt'] && array_key_exists('faucet', $terms) && array_key_exists('purchase', $terms), 'the treasury, visibility, creation time, faucet and purchase policy are in the review', array_keys($terms));
$roster = $terms['roster'] ?? [];
t(count($roster) === 3 && $roster[0]['domain'] === 'a.example' && $roster[0]['authority'] === true && count(array_filter($roster, fn($m) => ($m['thisDomain'] ?? false) === true)) === 1 && $roster[1]['thisDomain'] === true && preg_match('/^[a-f0-9]{16}$/D', $roster[0]['keyFingerprint']) === 1, 'the roster lists every domain with a key fingerprint, the authority and this domain marked', $roster);
t(($list[0]['genesisDigest'] ?? null) === $digest($c), 'the genesis digest is shown, to compare with the authority\'s');

echo "== accepting is bound to the coin and the genesis\n";
t(refuses(fn() => consent_accept(ndb('b.example'), node('b.example'), $c['coin'], str_repeat('a', 64), $by, $NOW), 'consent-mismatch'), 'an acceptance naming another digest is refused');
t(refuses(fn() => consent_accept(ndb('b.example'), node('b.example'), str_repeat('c', 32), $digest($c), $by, $NOW), 'unknown-coin'), 'an acceptance naming a coin this domain does not hold is refused');
t(refuses(fn() => $ask($c), 'needs-consent') && $consentRow('b.example', $c)['status'] === 'awaiting', 'and nothing was accepted by those');
$acc = consent_accept(ndb('b.example'), node('b.example'), $c['coin'], $digest($c), $by, $NOW);
t($acc['status'] === 'accepted' && $acc['signed'] === false && $acc['decidedAt'] === gmdate('Y-m-d\TH:i:s\Z', $NOW) && $acc['decidedBy'] === $by, 'an exact acceptance is recorded with the time and the operator key', $acc);
$answer = $ask($c);
t(is_string($answer['signature'] ?? null) && ledger_verify(ledger_roster_key($c['genesis'], 'b.example'), $digest($c), $answer['signature']), 'only now the partner signs the genesis, and the signature verifies');
t(($answer['consent']['status'] ?? null) === 'accepted' && ($answer['consent']['recordedAt'] ?? null) === gmdate('Y-m-d\TH:i:s\Z', $NOW), 'the answer says that consent was recorded, and when');
$row = $consentRow('b.example', $c);
t($row['signed_at'] !== null, 'the record notes that a signature was issued');
$first = $row['signed_at'];
$NOW += 5;
$again = $ask($c);
t(isset($again['signature']) && $consentRow('b.example', $c)['signed_at'] === $first, 'asking again gives a signature again and keeps the first time it was issued');
$NOW -= 5;
t(refuses(fn() => consent_decline(ndb('b.example'), node('b.example'), $c['coin'], $digest($c), 'changed my mind', $by, $NOW), 'already-signed'), 'once a signature was issued the proposal can no longer be declined');
$after = consent_list(ndb('b.example'), node('b.example'))[0];
t($after['signed'] === true && $after['canDecline'] === false && $after['status'] === 'accepted', 'and the review no longer offers to decline it');
t(consent_accept(ndb('b.example'), node('b.example'), $c['coin'], $digest($c), $by, $NOW + 50)['decidedAt'] === gmdate('Y-m-d\TH:i:s\Z', $NOW), 'accepting again is harmless and keeps the first time');

echo "== decline, and decline then accept\n";
$d = open_coin(3, null, 'public', null, 'DEC');
try { $ask($d); } catch (LedgerError $e) {}
$dec = consent_decline(ndb('b.example'), node('b.example'), $d['coin'], $digest($d), str_repeat('x', 500), $by, $NOW);
t($dec['status'] === 'declined' && $dec['canAccept'] === true && $dec['canDecline'] === false && strlen((string) $dec['reason']) <= CONSENT_REASON_MAX, 'a decline is recorded with its reason, cut to a fixed length', $dec);
t(refuses(fn() => $ask($d), 'consent-declined'), 'a declined proposal is not signed; the authority is told it was declined');
t(refuses(fn() => consent_decline(ndb('b.example'), node('b.example'), $d['coin'], str_repeat('a', 64), null, $by, $NOW), 'consent-mismatch'), 'a decline names the exact genesis digest too');
t(consent_decline(ndb('b.example'), node('b.example'), $d['coin'], $digest($d), 'again', $by, $NOW)['status'] === 'declined', 'declining twice is harmless');
$acc = consent_accept(ndb('b.example'), node('b.example'), $d['coin'], $digest($d), $by, $NOW);
t($acc['status'] === 'accepted' && is_string($ask($d)['signature'] ?? null), 'a decline can be reversed by accepting, while no signature was issued');
$e = open_coin(3, null, 'public', null, 'WDR');
try { $ask($e); } catch (LedgerError $x) {}
consent_accept(ndb('b.example'), node('b.example'), $e['coin'], $digest($e), $by, $NOW);
t(consent_decline(ndb('b.example'), node('b.example'), $e['coin'], $digest($e), 'not yet', $by, $NOW)['status'] === 'declined' && refuses(fn() => $ask($e), 'consent-declined'), 'an acceptance can be withdrawn while no signature was issued');
t(refuses(fn() => consent_decline(ndb('a.example'), node('a.example'), $e['coin'], $digest($e), null, $by, $NOW), 'unknown-coin'), 'a domain that holds no such proposal cannot decline it');

echo "== opening through the authority\n";
cluster(3);
$o = open_coin(3, null, 'private', null, 'OPN');
$waiting = null;
try { open_now_once($o); } catch (LedgerError $x) { $waiting = $x; }
t($waiting !== null && $waiting->reason === 'needs-consent' && ($waiting->detail['waiting'] ?? null) === ['b.example' => 'awaiting', 'c.example' => 'awaiting'], 'the authority asks every partner and names those that have not accepted', $waiting ? $waiting->detail : null);
t(calls('genesis') === 2, 'both partners were asked in one attempt, so both see the proposal');
t(ledger_coin(ndb('a.example'), $o['coin'])['state'] === 'pending', 'the coin stays pending on the authority, with its genesis and reference secret kept');
consent_accept(ndb('b.example'), node('b.example'), $o['coin'], $digest($o), $by, $NOW);
$waiting = null;
try { open_now_once($o); } catch (LedgerError $x) { $waiting = $x; }
t($waiting !== null && ($waiting->detail['waiting'] ?? null) === ['c.example' => 'awaiting'], 'after one acceptance only the other partner is named');
consent_decline(ndb('c.example'), node('c.example'), $o['coin'], $digest($o), 'terms', $by, $NOW);
$waiting = null;
try { open_now_once($o); } catch (LedgerError $x) { $waiting = $x; }
t($waiting !== null && ($waiting->detail['waiting'] ?? null) === ['c.example' => 'declined'], 'a partner that declined is named as declined', $waiting ? $waiting->detail : null);
t(ledger_coin(ndb('a.example'), $o['coin'])['state'] === 'pending', 'nothing opened');
consent_accept(ndb('c.example'), node('c.example'), $o['coin'], $digest($o), $by, $NOW);
t(calls('notify') === 0, 'and no notice has gone out yet');
open_now_once($o);
t(ledger_coin(ndb('a.example'), $o['coin'])['state'] === 'active' && ledger_coin(ndb('b.example'), $o['coin'])['state'] === 'active' && ledger_coin(ndb('c.example'), $o['coin'])['state'] === 'active', 'once every partner accepted, a new attempt by the authority opens the coin on all three domains');
$reports = consent_reports(ndb('a.example'), $o['coin']);
t(($reports['b.example']['status'] ?? null) === 'accepted' && ($reports['c.example']['status'] ?? null) === 'accepted' && is_string($reports['b.example']['recordedAt'] ?? null), 'the authority holds what each partner reported: consent recorded, and when', $reports);
$view = consent_partner_view(ndb('a.example'), $o['coin']);
t(count($view) === 2 && $view[0]['domain'] === 'b.example' && $view[0]['signed'] === true && $view[0]['consent']['status'] === 'accepted' && ($view[0]['note'] ?? '') !== '', 'the operator view of the partners carries a note that this is the partner\'s own report', $view);
t(!str_contains(json_encode($view), 'proof'), 'and does not call the report proof');
t(refuses(fn() => open_now_once($o), 'not-pending'), 'a coin opens once');

echo "== the private reference secret is never shown\n";
cluster(3);
$p = open_coin(3, null, 'private', null, 'PRV');
try { $ask($p); } catch (LedgerError $x) {}
$review = json_encode(consent_list(ndb('b.example'), node('b.example')));
t($p['secret'] !== null && !str_contains($review, $p['secret']) && str_contains($review, hash('sha256', $p['secret'])), 'a private coin\'s review shows the hash of its reference secret and never the secret');
t(!str_contains($review, $p['treasury']['key']) || ($p['genesis']['treasuryRef'] === $p['treasury']['key']), 'and does not show the treasury key behind a private reference');

echo "== a policy and a faucet are part of what is reviewed\n";
cluster(3);
$issuerPem = openssl_pkey_get_details(openssl_pkey_get_private(ec_private()))['key'];
$policy = ['priceClass' => 'atlas.element.gold', 'issuerKey' => base64_encode($issuerPem), 'unitsPerPrice' => 10, 'minPrice' => 5, 'perKeyUnits' => '5000', 'perDayUnits' => '8000'];
$q = open_coin(3, 2, 'public', ['maxAmount' => '10', 'perKeyLimit' => '50', 'cooldownSeconds' => 60], 'POL', $policy);
try { $ask($q); } catch (LedgerError $x) {}
$terms = consent_list(ndb('b.example'), node('b.example'))[0]['terms'];
t(($terms['threshold'] ?? null) === 2 && ($terms['faucet']['perKeyLimit'] ?? null) === '50' && ($terms['purchase']['unitsPerPrice'] ?? null) === 10 && ($terms['purchase']['perDayUnits'] ?? null) === '8000', 'the threshold, the faucet and the purchase policy are shown as the genesis holds them', $terms);

echo "== no consent record means no signature\n";
cluster(3);
$m = open_coin(3, null);
try { $ask($m); } catch (LedgerError $x) {}
ndb('b.example')->exec('DELETE FROM ledger_consents');
t(refuses(fn() => $ask($m), 'consent-unavailable'), 'a pending coin whose consent record is missing is not signed');
$list = consent_list(ndb('b.example'), node('b.example'));
t(count($list) === 1 && $list[0]['status'] === 'unrecorded' && $list[0]['canAccept'] && $list[0]['canDecline'], 'it is listed as unrecorded, for the operator to accept or decline explicitly', $list);
t(refuses(fn() => $ask($m), 'consent-unavailable'), 'and still not signed');
consent_accept(ndb('b.example'), node('b.example'), $m['coin'], $digest($m), $by, $NOW);
t(is_string($ask($m)['signature'] ?? null), 'an explicit acceptance of an unrecorded coin restores the record and the coin can be signed');
$n = open_coin(3, null, 'public', null, 'NEW');
try { $ask($n); } catch (LedgerError $x) {}
ndb('b.example')->exec("UPDATE ledger_consents SET genesis_digest='" . str_repeat('0', 64) . "' WHERE coin_id='" . $n['coin'] . "'");
t(refuses(fn() => $ask($n), 'consent-unavailable'), 'a record that names another genesis digest is ambiguous and does not sign');
ndb('b.example')->exec("UPDATE ledger_consents SET genesis_digest='" . $digest($n) . "', status='accepted' WHERE coin_id='" . $n['coin'] . "'");
t(is_string($ask($n)['signature'] ?? null), 'and a record that is whole again signs');
ndb('b.example')->exec('DROP TABLE ledger_consents');
$z = open_coin(3, null, 'public', null, 'ZZZ');
t(refuses(fn() => $ask($z), 'consent-unavailable'), 'a missing consent table refuses a new proposal');
t((int) ndb('b.example')->query("SELECT COUNT(*) FROM ledger_coins WHERE coin_id='" . $z['coin'] . "'")->fetchColumn() === 0, 'and registers nothing');
t(refuses(fn() => $ask($n), 'consent-unavailable'), 'and refuses a coin it already holds');
ndb('b.example')->exec('CREATE TABLE ledger_consents(coin_id TEXT PRIMARY KEY, genesis_digest TEXT NOT NULL, status TEXT NOT NULL, received_at INTEGER NOT NULL, decided_at INTEGER, decided_by TEXT, reason TEXT, signed_at INTEGER)');
ndb('b.example')->exec('DROP TABLE ledger_consent_meta');
t(refuses(fn() => $ask($z), 'consent-unavailable'), 'a consent table without its upgrade marker is ambiguous and refuses too');
t(refuses(fn() => consent_list(ndb('b.example'), node('b.example')), 'consent-unavailable'), 'and so does the operator\'s list');

echo "== a failing write never approves\n";
cluster(3);
ndb('b.example')->exec("CREATE TRIGGER consent_fail BEFORE INSERT ON ledger_consents BEGIN SELECT RAISE(ABORT, 'disk full'); END");
$w = open_coin(3, null, 'public', null, 'WRT');
t(refuses(fn() => $ask($w), 'consent-unavailable'), 'when the proposal cannot be recorded the partner refuses');
t((int) ndb('b.example')->query('SELECT COUNT(*) FROM ledger_coins')->fetchColumn() === 0, 'and the coin is not registered either');
ndb('b.example')->exec('DROP TRIGGER consent_fail');
try { $ask($w); } catch (LedgerError $x) {}
consent_accept(ndb('b.example'), node('b.example'), $w['coin'], $digest($w), $by, $NOW);
ndb('b.example')->exec("CREATE TRIGGER consent_fail2 BEFORE UPDATE ON ledger_consents BEGIN SELECT RAISE(ABORT, 'disk full'); END");
t(refuses(fn() => $ask($w), 'consent-unavailable'), 'when the note that a signature was issued cannot be written, no signature is given');
ndb('b.example')->exec('DROP TRIGGER consent_fail2');
t(is_string($ask($w)['signature'] ?? null), 'and with storage back, it signs');

echo "== pending coins that predate the upgrade\n";
cluster(3);
$old = open_coin(3, null, 'public', null, 'OLD');
ledger_register(ndb('b.example'), $old['genesis'], $old['treasury']['key'], $old['secret']);
ndb('b.example')->exec('DROP TABLE ledger_consents');
ndb('b.example')->exec('DROP TABLE ledger_consent_meta');
$file = $GLOBALS['CLUSTER']['b.example']['file'];
$GLOBALS['CLUSTER']['b.example']['db'] = ledger_open($file);
$row = $consentRow('b.example', $old);
t($row !== null && $row['status'] === 'legacy' && $row['genesis_digest'] === $digest($old), 'opening a database made before the upgrade records the coins pending at that moment as predating it', $row);
$sig = $ask($old);
t(is_string($sig['signature'] ?? null) && ($sig['consent']['status'] ?? null) === 'predates-upgrade', 'such a coin still signs, and says that it predates the upgrade, not that consent was recorded');
$new = open_coin(3, null, 'public', null, 'NWR');
t(refuses(fn() => $ask($new), 'needs-consent') && $consentRow('b.example', $new)['status'] === 'awaiting', 'a coin proposed after the upgrade needs consent');
$sneak = open_coin(3, null, 'public', null, 'SNK');
ledger_register(ndb('b.example'), $sneak['genesis'], $sneak['treasury']['key'], $sneak['secret']);
t(refuses(fn() => $ask($sneak), 'consent-unavailable'), 'a pending coin that appeared after the upgrade without a record is not grandfathered');
$GLOBALS['CLUSTER']['b.example']['db'] = ledger_open($file);
t($consentRow('b.example', $sneak) === null, 'opening the database again does not turn it into a legacy coin');
t((int) ndb('b.example')->query("SELECT COUNT(*) FROM ledger_consents WHERE status='legacy'")->fetchColumn() === 1, 'only the one coin the upgrade found is marked as predating it');
$fresh = tempnam(sys_get_temp_dir(), 'consent-new-') . '.sqlite';
$fdb = ledger_open($fresh);
t((int) $fdb->query('SELECT COUNT(*) FROM ledger_consents')->fetchColumn() === 0 && (int) $fdb->query('SELECT COUNT(*) FROM ledger_consent_meta')->fetchColumn() === 1, 'a new database starts with no legacy coins and its upgrade marker');
$fdb = null;

echo "== active and frozen coins are untouched\n";
cluster(3);
$act = open_coin(3, null);
open_now($act);
t(ledger_coin(ndb('b.example'), $act['coin'])['state'] === 'active', 'the coin is open on a partner');
t(array_filter(consent_list(ndb('b.example'), node('b.example')), fn($r) => $r['coinId'] === $act['coin'] && $r['status'] === 'awaiting') === [], 'and is never listed as one awaiting consent');
$pay = pay($act, $act['treasury'], owner()['key'], '10');
t(is_array($pay) && units('b.example', $act, ledger_coin(ndb('b.example'), $act['coin'])['treasury_key']) < 100000, 'and it spends as it did, and the partner copy follows', $pay);

echo "== declined proposals are bounded\n";
cluster(3);
$ids = [];
for ($i = 0; $i < CONSENT_MAX_DECLINED + 5; $i++) {
    $x = open_coin(3, null, 'public', null, 'DC' . ($i % 90 + 10));
    try { $ask($x); } catch (LedgerError $e) {}
    consent_decline(ndb('b.example'), node('b.example'), $x['coin'], $digest($x), 'no', $by, $NOW + $i);
    $ids[] = $x;
}
$declined = (int) ndb('b.example')->query("SELECT COUNT(*) FROM ledger_consents WHERE status='declined'")->fetchColumn();
t($declined === CONSENT_MAX_DECLINED, 'only the newest ' . CONSENT_MAX_DECLINED . ' declined proposals are kept', $declined);
t((int) ndb('b.example')->query('SELECT COUNT(*) FROM ledger_coins')->fetchColumn() === CONSENT_MAX_DECLINED, 'and the older ones leave no coin record behind');
t((int) ndb('b.example')->query('SELECT COUNT(*) FROM ledger_consents')->fetchColumn() === CONSENT_MAX_DECLINED, 'nor a consent record');
t(ledger_head_exists_none(ndb('b.example'), $ids[0]['coin']), 'nothing of an evicted proposal remains in the ledger tables');
$evicted = $ids[0];
t(refuses(fn() => $ask($evicted), 'needs-consent') && $consentRow('b.example', $evicted)['status'] === 'awaiting', 'an evicted proposal that the authority sends again is a new proposal, awaiting consent; nothing was ever signed for it');
t(refuses(fn() => $ask($ids[CONSENT_MAX_DECLINED + 4]), 'consent-declined'), 'a recent declined proposal is still declined');

echo "== waiting proposals are bounded, and declining frees a slot\n";
cluster(3);
$held = [];
for ($i = 0; $i < PEER_MAX_PENDING_COINS; $i++) {
    $x = open_coin(3, null, 'public', null, 'WT' . ($i % 90 + 10));
    try { $ask($x); } catch (LedgerError $e) {}
    $held[] = $x;
}
$over = open_coin(3, null, 'public', null, 'OVR');
t(refuses(fn() => $ask($over), 'busy'), 'a partner holds at most ' . PEER_MAX_PENDING_COINS . ' proposals that are waiting');
consent_decline(ndb('b.example'), node('b.example'), $held[0]['coin'], $digest($held[0]), 'free a slot', $by, $NOW);
t(refuses(fn() => $ask($over), 'needs-consent'), 'declining one frees its slot');
t((int) ndb('b.example')->query('SELECT COUNT(*) FROM ledger_coins')->fetchColumn() <= PEER_MAX_PENDING_COINS + CONSENT_MAX_DECLINED, 'and the rows kept are bounded by both limits');

echo "\n" . ($failures === 0 ? 'ALL ' . $total . ' CHECKS PASSED' : $failures . ' of ' . $total . ' checks FAILED') . "\n";
exit($failures === 0 ? 0 : 1);

// A coin's rows in every table the proposal could have touched are gone.
function ledger_head_exists_none(PDO $db, string $coinId): bool
{
    foreach (['ledger_coins', 'ledger_consents', 'ledger_genesis_sigs', 'ledger_catchup', 'ledger_authority_heads', 'ledger_log'] as $table) {
        $q = $db->prepare('SELECT COUNT(*) FROM ' . $table . ' WHERE coin_id=?');
        $q->execute([$coinId]);
        if ((int) $q->fetchColumn() !== 0) return false;
    }
    return true;
}
function open_now_once(array $c): void
{
    global $NOW;
    peer_open_multi(ndb('a.example'), node('a.example'), $c['genesis'], $c['treasury']['key'], $c['secret'], 'transport', $NOW);
}
