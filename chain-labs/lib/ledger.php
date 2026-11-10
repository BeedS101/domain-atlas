<?php
declare(strict_types=1);
// Ledger store for the chain labs: coins with a signed genesis, an append-only log kept in a public and a private form,
// derived accounts, per-account indexes, and an invariant checker. Include-only: a direct request gets a 404.
// Network, HTTP and the wallet's request format are not here; callers hand in verified inputs and signed material.
if (PHP_SAPI !== 'cli' && isset($_SERVER['SCRIPT_FILENAME']) && realpath($_SERVER['SCRIPT_FILENAME']) === __FILE__) { http_response_code(404); exit; }

const LEDGER_MAX_UNITS = 1000000000000;
const LEDGER_PAGE_MAX = 100;
const LEDGER_MAX_ROSTER = 5;
const LEDGER_PROPOSAL_MAX_SECONDS = 600;
const LEDGER_CLOCK_SKEW_SECONDS = 120;
const LEDGER_MAX_COOLDOWN_SECONDS = 2592000;

final class LedgerError extends RuntimeException
{
    public function __construct(public readonly string $reason, string $message)
    {
        parent::__construct($message);
    }
}

function ledger_fail(string $reason, string $message): never
{
    throw new LedgerError($reason, $message);
}

// ---------- encoding, hashing, signatures ----------

function ledger_b64u_encode(string $raw): string
{
    return rtrim(strtr(base64_encode($raw), '+/', '-_'), '=');
}

function ledger_b64u_decode(mixed $text): string|false
{
    if (!is_string($text) || !preg_match('/^[A-Za-z0-9_-]{1,512}$/D', $text)) return false;
    $raw = base64_decode(strtr($text, '-_', '+/') . str_repeat('=', (4 - strlen($text) % 4) % 4), true);
    return $raw !== false && ledger_b64u_encode($raw) === $text ? $raw : false;
}

// Sorted keys, no whitespace; amounts are strings, so no float ever reaches the encoder.
function ledger_canonical(mixed $value): string
{
    if (is_array($value)) {
        if (array_is_list($value)) return '[' . implode(',', array_map('ledger_canonical', $value)) . ']';
        ksort($value, SORT_STRING);
        $parts = [];
        foreach ($value as $key => $item) $parts[] = json_encode((string) $key, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . ':' . ledger_canonical($item);
        return '{' . implode(',', $parts) . '}';
    }
    if (is_float($value)) ledger_fail('bad-value', 'floating point values are not allowed');
    return json_encode($value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
}

function ledger_digest(mixed $value): string
{
    return hash('sha256', ledger_canonical($value));
}

// Account reference: a keyed hash of the account key. In a public coin the reference is the key itself.
function ledger_ref(string $refSecret, string $key): string
{
    return ledger_b64u_encode(hash_hmac('sha256', $key, $refSecret, true));
}

function ledger_sign(string $privatePem, string $data): string
{
    $key = openssl_pkey_get_private($privatePem);
    if (!$key || !openssl_sign($data, $signature, $key, OPENSSL_ALGO_SHA256)) ledger_fail('sign-failed', 'could not sign');
    return ledger_b64u_encode($signature);
}

function ledger_verify(string $publicPem, string $data, mixed $signature): bool
{
    $raw = ledger_b64u_decode($signature);
    $key = openssl_pkey_get_public($publicPem);
    return $raw !== false && $key !== false && openssl_verify($data, $raw, $key, OPENSSL_ALGO_SHA256) === 1;
}

// A wallet key is a raw uncompressed P-256 point, base64url; its signatures are the raw 64-byte r||s form.
function ledger_valid_owner_key(mixed $key): bool
{
    $raw = ledger_b64u_decode($key);
    return $raw !== false && strlen($raw) === 65 && ord($raw[0]) === 4;
}

function ledger_owner_verify(string $data, string $ownerKey, mixed $signature): bool
{
    $point = ledger_b64u_decode($ownerKey);
    $raw = ledger_b64u_decode($signature);
    if ($point === false || strlen($point) !== 65 || ord($point[0]) !== 4 || $raw === false || strlen($raw) !== 64) return false;
    $prefix = hex2bin('3059301306072a8648ce3d020106082a8648ce3d030107034200');
    $pem = "-----BEGIN PUBLIC KEY-----\n" . chunk_split(base64_encode($prefix . $point), 64, "\n") . "-----END PUBLIC KEY-----\n";
    $key = openssl_pkey_get_public($pem);
    $der = ledger_raw_to_der($raw);
    return $key !== false && openssl_verify($data, $der, $key, OPENSSL_ALGO_SHA256) === 1;
}

function ledger_raw_to_der(string $raw): string
{
    $integer = static function (string $part): string {
        $part = ltrim($part, "\x00");
        if ($part === '') $part = "\x00";
        if ((ord($part[0]) & 128) !== 0) $part = "\x00" . $part;
        return "\x02" . chr(strlen($part)) . $part;
    };
    $body = $integer(substr($raw, 0, 32)) . $integer(substr($raw, 32, 32));
    return "\x30" . chr(strlen($body)) . $body;
}

// ---------- storage ----------

function ledger_open(string $path): PDO
{
    $db = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_TIMEOUT => 5]);
    $db->exec('PRAGMA busy_timeout=5000');
    $db->exec('PRAGMA foreign_keys=ON');
    ledger_schema($db);
    return $db;
}

// A raw BEGIN is invisible to PDO::inTransaction(), so roll back and ignore the "no transaction" error.
function ledger_rollback(PDO $db): void
{
    try { $db->exec('ROLLBACK'); } catch (Throwable $e) {}
}

function ledger_schema(PDO $db): void
{
    $db->exec("CREATE TABLE IF NOT EXISTS ledger_coins(
        coin_id TEXT PRIMARY KEY, genesis_json TEXT NOT NULL, genesis_digest TEXT NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('single','multi')), visibility TEXT NOT NULL CHECK(visibility IN ('public','private')),
        decimals INTEGER NOT NULL, max_units INTEGER NOT NULL CHECK(max_units BETWEEN 1 AND " . LEDGER_MAX_UNITS . "),
        initial_units INTEGER NOT NULL CHECK(initial_units BETWEEN 0 AND " . LEDGER_MAX_UNITS . "), threshold INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','active','frozen')), ref_secret TEXT, treasury_key TEXT)");
    $db->exec('CREATE TABLE IF NOT EXISTS ledger_genesis_sigs(coin_id TEXT NOT NULL, domain TEXT NOT NULL, signature TEXT NOT NULL, PRIMARY KEY(coin_id,domain))');
    $db->exec('CREATE TABLE IF NOT EXISTS ledger_log(
        coin_id TEXT NOT NULL, idx INTEGER NOT NULL, hash TEXT NOT NULL, prev_hash TEXT NOT NULL, public_json TEXT NOT NULL,
        private_json TEXT NOT NULL, authority_sig TEXT NOT NULL, approvals_json TEXT NOT NULL, PRIMARY KEY(coin_id,idx))');
    $db->exec('CREATE TABLE IF NOT EXISTS ledger_accounts(
        coin_id TEXT NOT NULL, account_key TEXT NOT NULL, ref TEXT NOT NULL, units INTEGER NOT NULL CHECK(units >= 0),
        seq INTEGER NOT NULL CHECK(seq >= 0), PRIMARY KEY(coin_id,account_key), UNIQUE(coin_id,ref))');
    $db->exec('CREATE TABLE IF NOT EXISTS ledger_account_entries(
        coin_id TEXT NOT NULL, ref TEXT NOT NULL, pos INTEGER NOT NULL, idx INTEGER NOT NULL, PRIMARY KEY(coin_id,ref,pos))');
    $db->exec('CREATE TABLE IF NOT EXISTS ledger_faucet(coin_id TEXT NOT NULL, account_key TEXT NOT NULL, total INTEGER NOT NULL CHECK(total > 0), last_at INTEGER NOT NULL, PRIMARY KEY(coin_id,account_key))');
    $db->exec("CREATE TABLE IF NOT EXISTS ledger_proposals(
        coin_id TEXT NOT NULL, digest TEXT NOT NULL, from_key TEXT NOT NULL, nonce TEXT NOT NULL, authorization_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','executed','expired','rejected')), created_at INTEGER NOT NULL,
        executed_index INTEGER, reason TEXT, prepared_json TEXT, approvals_json TEXT, PRIMARY KEY(coin_id,digest), UNIQUE(coin_id,from_key,nonce))");
    // A table made before the approval columns existed gets them.
    $have = array_column($db->query('PRAGMA table_info(ledger_proposals)')->fetchAll(PDO::FETCH_ASSOC), 'name');
    foreach (['prepared_json', 'approvals_json'] as $column) if (!in_array($column, $have, true)) $db->exec('ALTER TABLE ledger_proposals ADD COLUMN ' . $column . ' TEXT');
    $db->exec("CREATE UNIQUE INDEX IF NOT EXISTS ledger_one_pending ON ledger_proposals(coin_id,from_key) WHERE status='pending'");
    $db->exec('CREATE TABLE IF NOT EXISTS ledger_approved(coin_id TEXT NOT NULL, idx INTEGER NOT NULL, hash TEXT NOT NULL, executed_at INTEGER NOT NULL, PRIMARY KEY(coin_id,idx))');
    $db->exec('CREATE TABLE IF NOT EXISTS ledger_evidence(id INTEGER PRIMARY KEY AUTOINCREMENT, coin_id TEXT NOT NULL, kind TEXT NOT NULL, detail_json TEXT NOT NULL, created_at INTEGER NOT NULL)');
    $db->exec('CREATE TABLE IF NOT EXISTS ledger_peer_nonces(sender TEXT NOT NULL, nonce TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(sender,nonce))');
    $db->exec('CREATE TABLE IF NOT EXISTS ledger_challenges(challenge TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0)');
    $db->exec('CREATE TABLE IF NOT EXISTS ledger_nonces(coin_id TEXT NOT NULL, owner_key TEXT NOT NULL, nonce TEXT NOT NULL, PRIMARY KEY(coin_id,owner_key,nonce))');
}

// ---------- genesis ----------

function ledger_valid_domain(mixed $domain): bool
{
    return is_string($domain) && (bool) preg_match('/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/D', $domain);
}

function ledger_parse_units(mixed $text, string $what): int
{
    if (!is_string($text) || !preg_match('/^(0|[1-9][0-9]{0,11})$/D', $text)) ledger_fail('bad-amount', $what . ' must be a whole number of units written without a sign or leading zeros');
    $units = (int) $text;
    if ($units > LEDGER_MAX_UNITS) ledger_fail('bad-amount', $what . ' is above the limit of ' . LEDGER_MAX_UNITS . ' units');
    return $units;
}

// $in: coinId?, symbol, name, decimals, maxUnits, initialUnits (strings), treasuryKey, mode, visibility, roster
// (list of ['domain', 'key' => public key PEM], the authority first), threshold?, createdAt, refSecret (private coins),
// faucet? (null, or ['maxAmount', 'perKeyLimit' => unit strings, 'cooldownSeconds' => int]: limits on every spend from the
// treasury; with none, treasury spends are unlimited).
// Returns the genesis to be signed by every roster domain. The treasury key and the reference secret are not in it:
// it carries the treasury's reference and a hash of the secret.
function ledger_genesis(array $in): array
{
    $symbol = $in['symbol'] ?? null;
    $name = $in['name'] ?? null;
    $decimals = $in['decimals'] ?? null;
    if (!is_string($symbol) || !preg_match('/^[A-Z][A-Z0-9]{1,9}$/D', $symbol)) ledger_fail('bad-genesis', 'symbol must be 2 to 10 capital letters or digits');
    if (!is_string($name) || !preg_match('/^[A-Za-z0-9][A-Za-z0-9 ._-]{1,39}$/D', $name)) ledger_fail('bad-genesis', 'invalid name');
    if (!is_int($decimals) || $decimals < 0 || $decimals > 6) ledger_fail('bad-genesis', 'decimals must be 0 to 6');
    $max = ledger_parse_units($in['maxUnits'] ?? null, 'maxUnits');
    $initial = ledger_parse_units($in['initialUnits'] ?? null, 'initialUnits');
    if ($max < 1 || $initial > $max) ledger_fail('bad-genesis', 'maxUnits must be at least 1 and initialUnits at most maxUnits');
    $mode = $in['mode'] ?? null;
    $visibility = $in['visibility'] ?? null;
    if ($mode !== 'single' && $mode !== 'multi') ledger_fail('bad-genesis', 'mode must be single or multi');
    if ($visibility !== 'public' && $visibility !== 'private') ledger_fail('bad-genesis', 'visibility must be public or private');
    $treasury = $in['treasuryKey'] ?? null;
    if (!ledger_valid_owner_key($treasury)) ledger_fail('bad-genesis', 'treasuryKey must be a wallet public key');
    $roster = $in['roster'] ?? null;
    if (!is_array($roster) || !array_is_list($roster) || count($roster) < 1 || count($roster) > LEDGER_MAX_ROSTER) ledger_fail('bad-genesis', 'the roster must hold one to five domains');
    $domains = [];
    $clean = [];
    foreach ($roster as $member) {
        $domain = is_array($member) ? ($member['domain'] ?? null) : null;
        $key = is_array($member) ? ($member['key'] ?? null) : null;
        if (!ledger_valid_domain($domain) || in_array($domain, $domains, true)) ledger_fail('bad-genesis', 'roster domains must be valid and distinct');
        if (!is_string($key) || openssl_pkey_get_public($key) === false) ledger_fail('bad-genesis', 'every roster domain needs a public key');
        $domains[] = $domain;
        $clean[] = ['domain' => $domain, 'key' => $key];
    }
    if ($mode === 'single') {
        if (count($clean) !== 1) ledger_fail('bad-genesis', 'a single authority coin has a roster of one');
        $threshold = 1;
    } else {
        if (count($clean) < 2) ledger_fail('bad-genesis', 'a multi authority coin needs two to five domains');
        $threshold = $in['threshold'] ?? count($clean);
        if (!is_int($threshold) || $threshold < 2 || $threshold > count($clean)) ledger_fail('bad-genesis', 'the threshold must be at least 2 and at most the roster size');
    }
    $coinId = $in['coinId'] ?? bin2hex(random_bytes(16));
    if (!is_string($coinId) || !preg_match('/^[a-f0-9]{32}$/D', $coinId)) ledger_fail('bad-genesis', 'coinId must be 32 hex characters');
    $createdAt = $in['createdAt'] ?? null;
    if (!is_string($createdAt) || !preg_match('/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/D', $createdAt)) ledger_fail('bad-genesis', 'createdAt must be a UTC time');
    $faucet = ledger_faucet_policy($in['faucet'] ?? null, $max);
    $genesis = [
        'type' => 'atlas.ledger.genesis', 'v' => 1, 'coinId' => $coinId, 'symbol' => $symbol, 'name' => $name, 'decimals' => $decimals,
        'maxUnits' => (string) $max, 'initialUnits' => (string) $initial, 'mode' => $mode, 'visibility' => $visibility,
        'authority' => $clean[0]['domain'], 'threshold' => $threshold, 'roster' => $clean, 'faucet' => $faucet, 'createdAt' => $createdAt,
    ];
    if ($visibility === 'private') {
        $secret = $in['refSecret'] ?? null;
        if (!is_string($secret) || !preg_match('/^[a-f0-9]{64}$/D', $secret)) ledger_fail('bad-genesis', 'a private coin needs a 64 hex character reference secret');
        $genesis['refSecretHash'] = hash('sha256', $secret);
        $genesis['treasuryRef'] = ledger_ref($secret, $treasury);
    } else {
        $genesis['treasuryRef'] = $treasury;
    }
    return $genesis;
}

function ledger_faucet_policy(mixed $faucet, int $max): ?array
{
    if ($faucet === null) return null;
    if (!is_array($faucet) || array_is_list($faucet)) ledger_fail('bad-genesis', 'the faucet must be null or an object');
    $keys = array_keys($faucet);
    sort($keys);
    if ($keys !== ['cooldownSeconds', 'maxAmount', 'perKeyLimit']) ledger_fail('bad-genesis', 'the faucet needs maxAmount, perKeyLimit and cooldownSeconds');
    $grant = ledger_parse_units($faucet['maxAmount'], 'maxAmount');
    $total = ledger_parse_units($faucet['perKeyLimit'], 'perKeyLimit');
    if ($grant < 1 || $grant > $max) ledger_fail('bad-genesis', 'the faucet maxAmount must be at least 1 and within the coin');
    if ($total < $grant || $total > $max) ledger_fail('bad-genesis', 'the faucet perKeyLimit must be at least maxAmount and within the coin');
    $cooldown = $faucet['cooldownSeconds'];
    if (!is_int($cooldown) || $cooldown < 0 || $cooldown > LEDGER_MAX_COOLDOWN_SECONDS) ledger_fail('bad-genesis', 'the faucet cooldownSeconds must be 0 to ' . LEDGER_MAX_COOLDOWN_SECONDS);
    return ['maxAmount' => (string) $grant, 'perKeyLimit' => (string) $total, 'cooldownSeconds' => $cooldown];
}

function ledger_genesis_digest(array $genesis): string
{
    return ledger_digest($genesis);
}

function ledger_genesis_sign(array $genesis, string $privatePem): string
{
    return ledger_sign($privatePem, ledger_genesis_digest($genesis));
}

// Stores a coin as pending. The treasury key and, for a private coin, the reference secret are private state.
function ledger_register(PDO $db, array $genesis, string $treasuryKey, ?string $refSecret): void
{
    // Re-validate through the same builder so a hand-made array cannot skip a rule.
    $again = ledger_genesis([
        'coinId' => $genesis['coinId'] ?? null, 'symbol' => $genesis['symbol'] ?? null, 'name' => $genesis['name'] ?? null,
        'decimals' => $genesis['decimals'] ?? null, 'maxUnits' => $genesis['maxUnits'] ?? null, 'initialUnits' => $genesis['initialUnits'] ?? null,
        'mode' => $genesis['mode'] ?? null, 'visibility' => $genesis['visibility'] ?? null, 'treasuryKey' => $treasuryKey,
        'roster' => $genesis['roster'] ?? null, 'threshold' => $genesis['threshold'] ?? null, 'createdAt' => $genesis['createdAt'] ?? null,
        'faucet' => $genesis['faucet'] ?? null, 'refSecret' => $refSecret,
    ]);
    if (ledger_canonical($again) !== ledger_canonical($genesis)) ledger_fail('bad-genesis', 'the genesis does not match its treasury key and reference secret');
    if ($genesis['visibility'] === 'public' && $refSecret !== null) ledger_fail('bad-genesis', 'a public coin has no reference secret');
    $db->prepare("INSERT INTO ledger_coins(coin_id,genesis_json,genesis_digest,mode,visibility,decimals,max_units,initial_units,threshold,state,ref_secret,treasury_key)
        VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?)")
        ->execute([$genesis['coinId'], ledger_canonical($genesis), ledger_genesis_digest($genesis), $genesis['mode'], $genesis['visibility'], $genesis['decimals'],
            (int) $genesis['maxUnits'], (int) $genesis['initialUnits'], $genesis['threshold'], $refSecret, $treasuryKey]);
}

function ledger_coin(PDO $db, string $coinId): array
{
    $row = $db->prepare('SELECT * FROM ledger_coins WHERE coin_id=?');
    $row->execute([$coinId]);
    $coin = $row->fetch(PDO::FETCH_ASSOC);
    if (!$coin) ledger_fail('unknown-coin', 'no such coin');
    $coin['genesis'] = json_decode($coin['genesis_json'], true, 512, JSON_THROW_ON_ERROR);
    return $coin;
}

function ledger_roster_key(array $genesis, string $domain): ?string
{
    foreach ($genesis['roster'] as $member) if ($member['domain'] === $domain) return $member['key'];
    return null;
}

function ledger_add_genesis_signature(PDO $db, string $coinId, string $domain, string $signature): void
{
    $coin = ledger_coin($db, $coinId);
    if ($coin['state'] !== 'pending') ledger_fail('not-pending', 'the genesis is already complete');
    $key = ledger_roster_key($coin['genesis'], $domain);
    if ($key === null) ledger_fail('not-in-roster', 'that domain is not in the roster');
    if (!ledger_verify($key, $coin['genesis_digest'], $signature)) ledger_fail('bad-signature', 'the genesis signature does not verify');
    $db->prepare('INSERT OR REPLACE INTO ledger_genesis_sigs(coin_id,domain,signature) VALUES(?,?,?)')->execute([$coinId, $domain, $signature]);
}

// Entry 0 as every domain derives it: the initial units credited to the treasury. $approvals are the genesis signatures.
function ledger_genesis_entry(array $coin, array $approvals): array
{
    $genesis = $coin['genesis'];
    $treasuryKey = (string) $coin['treasury_key'];
    $ref = $genesis['visibility'] === 'private' ? ledger_ref((string) $coin['ref_secret'], $treasuryKey) : $treasuryKey;
    if ($ref !== $genesis['treasuryRef']) ledger_fail('bad-genesis', 'the treasury does not match the genesis');
    $public = ['type' => 'genesis', 'coinId' => $coin['coin_id'], 'index' => 0, 'prevHash' => $coin['genesis_digest'], 'executedAt' => $genesis['createdAt'],
        'amount' => $genesis['initialUnits'], 'from' => null, 'to' => $ref];
    $hash = ledger_digest($public);
    return ['public' => $public, 'private' => ['hash' => $hash, 'from' => null, 'to' => $treasuryKey, 'authorization' => null], 'hash' => $hash, 'approvals' => $approvals, 'ref' => $ref];
}

// Writes entry 0 and opens the coin. Runs inside the caller's transaction.
function ledger_write_genesis_entry(PDO $db, array $coin, array $entry, string $authoritySignature): void
{
    $coinId = $coin['coin_id'];
    $db->prepare('INSERT INTO ledger_log(coin_id,idx,hash,prev_hash,public_json,private_json,authority_sig,approvals_json) VALUES(?,?,?,?,?,?,?,?)')
        ->execute([$coinId, 0, $entry['hash'], $coin['genesis_digest'], ledger_canonical($entry['public']), ledger_canonical($entry['private']), $authoritySignature, ledger_canonical($entry['approvals'])]);
    $db->prepare('INSERT INTO ledger_accounts(coin_id,account_key,ref,units,seq) VALUES(?,?,?,?,0)')->execute([$coinId, $coin['treasury_key'], $entry['ref'], (int) $coin['genesis']['initialUnits']]);
    $db->prepare('INSERT INTO ledger_account_entries(coin_id,ref,pos,idx) VALUES(?,?,0,0)')->execute([$coinId, $entry['ref']]);
    $db->prepare("UPDATE ledger_coins SET state='active' WHERE coin_id=?")->execute([$coinId]);
}

// Opens the coin once every roster domain has signed its genesis: credits the initial units to the treasury as entry 0.
function ledger_activate(PDO $db, string $coinId, string $authorityPrivatePem): void
{
    $db->exec('BEGIN IMMEDIATE');
    try {
        $coin = ledger_coin($db, $coinId);
        if ($coin['state'] !== 'pending') ledger_fail('not-pending', 'the coin is already active');
        $sigs = $db->prepare('SELECT domain,signature FROM ledger_genesis_sigs WHERE coin_id=? ORDER BY domain');
        $sigs->execute([$coinId]);
        $have = [];
        foreach ($sigs->fetchAll(PDO::FETCH_ASSOC) as $row) $have[$row['domain']] = $row['signature'];
        foreach ($coin['genesis']['roster'] as $member) if (!isset($have[$member['domain']])) ledger_fail('genesis-unsigned', $member['domain'] . ' has not signed the genesis');
        $approvals = [];
        foreach ($have as $domain => $sig) $approvals[] = ['domain' => $domain, 'signature' => $sig];
        $entry = ledger_genesis_entry($coin, $approvals);
        ledger_write_genesis_entry($db, $coin, $entry, ledger_sign($authorityPrivatePem, $entry['hash']));
        $db->exec('COMMIT');
    } catch (Throwable $e) {
        ledger_rollback($db);
        throw $e;
    }
}

// A co-approver installs entry 0 as the authority wrote it, after checking it as the checker would: the entry is the one
// its own genesis gives, every roster domain's genesis signature is there, and the authority signed it.
function ledger_mirror_genesis(PDO $db, string $coinId, array $record): void
{
    $db->exec('BEGIN IMMEDIATE');
    try {
        $coin = ledger_coin($db, $coinId);
        if ($coin['state'] !== 'pending') ledger_fail('not-pending', 'the coin is already active');
        $genesis = $coin['genesis'];
        $approvals = $record['approvals'] ?? null;
        if (!is_array($approvals)) ledger_fail('bad-entry', 'entry 0 has no genesis signatures');
        $have = [];
        foreach ($approvals as $a) {
            $key = is_array($a) && is_string($a['domain'] ?? null) ? ledger_roster_key($genesis, $a['domain']) : null;
            if ($key === null || isset($have[$a['domain']]) || !ledger_verify($key, $coin['genesis_digest'], $a['signature'] ?? null)) ledger_fail('bad-approval', 'a genesis signature does not verify');
            $have[$a['domain']] = true;
        }
        foreach ($genesis['roster'] as $member) if (!isset($have[$member['domain']])) ledger_fail('genesis-unsigned', $member['domain'] . ' has not signed the genesis');
        $entry = ledger_genesis_entry($coin, $approvals);
        if (ledger_canonical($record['public'] ?? null) !== ledger_canonical($entry['public']) || ledger_canonical($record['private'] ?? null) !== ledger_canonical($entry['private']) || ($record['hash'] ?? null) !== $entry['hash']) ledger_fail('bad-entry', 'entry 0 is not the one the genesis gives');
        $authorityKey = ledger_roster_key($genesis, $genesis['authority']);
        if ($authorityKey === null || !ledger_verify($authorityKey, $entry['hash'], $record['authoritySignature'] ?? null)) ledger_fail('bad-authority-signature', 'the authority signature does not verify');
        ledger_write_genesis_entry($db, $coin, $entry, $record['authoritySignature']);
        $db->exec('COMMIT');
    } catch (Throwable $e) {
        ledger_rollback($db);
        throw $e;
    }
}

// A disagreement stops the coin and keeps the evidence for an operator's review; nothing here lets the coin resume by
// itself. Freezing twice keeps the first evidence and adds the second.
function ledger_freeze(PDO $db, string $coinId, string $kind = 'operator', array $detail = [], int $now = 0): void
{
    $db->exec('BEGIN IMMEDIATE');
    try {
        $db->prepare("UPDATE ledger_coins SET state='frozen' WHERE coin_id=? AND state='active'")->execute([$coinId]);
        $db->prepare('INSERT INTO ledger_evidence(coin_id,kind,detail_json,created_at) VALUES(?,?,?,?)')->execute([$coinId, $kind, json_encode($detail, JSON_UNESCAPED_SLASHES), $now]);
        $db->exec('COMMIT');
    } catch (Throwable $e) {
        ledger_rollback($db);
        throw $e;
    }
}

function ledger_evidence(PDO $db, string $coinId): array
{
    $q = $db->prepare('SELECT id,kind,detail_json,created_at FROM ledger_evidence WHERE coin_id=? ORDER BY id LIMIT 50');
    $q->execute([$coinId]);
    return array_map(fn($r) => ['id' => (int) $r['id'], 'kind' => $r['kind'], 'detail' => json_decode($r['detail_json'], true), 'createdAt' => (int) $r['created_at']], $q->fetchAll(PDO::FETCH_ASSOC));
}

// ---------- the log ----------

function ledger_head(PDO $db, string $coinId): array
{
    $row = $db->prepare('SELECT idx,hash FROM ledger_log WHERE coin_id=? ORDER BY idx DESC LIMIT 1');
    $row->execute([$coinId]);
    $head = $row->fetch(PDO::FETCH_ASSOC);
    return $head ? ['index' => (int) $head['idx'], 'hash' => $head['hash']] : ['index' => -1, 'hash' => ledger_coin($db, $coinId)['genesis_digest']];
}

// The execution time of the newest entry, as a Unix time.
function ledger_head_time(PDO $db, string $coinId): int
{
    $row = $db->prepare('SELECT public_json FROM ledger_log WHERE coin_id=? ORDER BY idx DESC LIMIT 1');
    $row->execute([$coinId]);
    $public = json_decode((string) $row->fetchColumn(), true);
    $at = is_array($public) && is_string($public['executedAt'] ?? null) ? strtotime($public['executedAt']) : false;
    return $at === false ? 0 : $at;
}

// An entry's execution time: a UTC time inside the owner's proposal window, never before the entry it follows.
function ledger_check_executed_at(mixed $executedAt, array $payload, int $previousAt): int
{
    if (!is_string($executedAt) || !preg_match('/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/D', $executedAt) || strtotime($executedAt) === false) ledger_fail('bad-time', 'executedAt must be a UTC time');
    $at = strtotime($executedAt);
    if ($at < $previousAt) ledger_fail('clock-behind', 'executedAt is before the previous entry');
    if ($at < strtotime($payload['issuedAt']) - LEDGER_CLOCK_SKEW_SECONDS || $at >= strtotime($payload['expiresAt'])) ledger_fail('bad-time', 'executedAt is outside the proposal window');
    return $at;
}

// The limits on spends from the treasury, against what each recipient has already received from it.
function ledger_faucet_check(PDO $db, array $coin, string $from, string $to, int $amount, int $at): void
{
    $policy = $coin['genesis']['faucet'] ?? null;
    if ($policy === null || $from !== $coin['treasury_key']) return;
    if ($amount > (int) $policy['maxAmount']) ledger_fail('faucet-amount', 'a grant is at most ' . $policy['maxAmount']);
    $row = $db->prepare('SELECT total,last_at FROM ledger_faucet WHERE coin_id=? AND account_key=?');
    $row->execute([$coin['coin_id'], $to]);
    $given = $row->fetch(PDO::FETCH_ASSOC) ?: ['total' => 0, 'last_at' => 0];
    ledger_faucet_rules($policy, (int) $given['total'], (int) $given['last_at'], $amount, $at);
}

function ledger_faucet_rules(array $policy, int $total, int $lastAt, int $amount, int $at): void
{
    if ($total + $amount > (int) $policy['perKeyLimit']) ledger_fail('faucet-limit', 'a key can receive at most ' . $policy['perKeyLimit'] . ' from the treasury');
    if ($total > 0 && $at < $lastAt + (int) $policy['cooldownSeconds']) ledger_fail('faucet-cooldown', 'this key received a grant too recently');
}

function ledger_account_ref(array $coin, string $key): string
{
    return $coin['visibility'] === 'private' ? ledger_ref((string) $coin['ref_secret'], $key) : $key;
}

function ledger_approval_bytes(string $coinId, int $index, string $hash): string
{
    return ledger_canonical(['type' => 'atlas.ledger.entry.approval', 'v' => 1, 'coinId' => $coinId, 'index' => $index, 'hash' => $hash]);
}

// Checks an owner's signed transfer and returns [from, to, amount, baseSeq, nonce]. No state is read except the coin's
// own genesis; the caller checks balances, the sequence number and the nonce against the store.
function ledger_check_authorization(array $coin, array $authorization, int $now): array
{
    $payload = $authorization['payload'] ?? null;
    $signature = $authorization['signature'] ?? null;
    if (!is_array($payload) || array_is_list($payload)) ledger_fail('bad-authorization', 'the authorization has no payload');
    $expected = ['type', 'v', 'coinId', 'from', 'to', 'amount', 'baseSeq', 'baseHead', 'nonce', 'issuedAt', 'expiresAt'];
    $keys = array_keys($payload);
    sort($keys);
    $sorted = $expected;
    sort($sorted);
    if ($keys !== $sorted) ledger_fail('bad-authorization', 'the payload has the wrong fields');
    if ($payload['type'] !== 'atlas.ledger.transfer' || $payload['v'] !== 1 || $payload['coinId'] !== $coin['coin_id']) ledger_fail('bad-authorization', 'the payload is not a transfer for this coin');
    if (!ledger_valid_owner_key($payload['from']) || !ledger_valid_owner_key($payload['to'])) ledger_fail('bad-authorization', 'from and to must be wallet public keys');
    if ($payload['from'] === $payload['to']) ledger_fail('bad-authorization', 'a transfer to the same account is not allowed');
    $amount = ledger_parse_units($payload['amount'], 'amount');
    if ($amount < 1 || $amount > (int) $coin['max_units']) ledger_fail('bad-amount', 'the amount must be at least 1 and within the coin');
    if (!is_int($payload['baseSeq']) || $payload['baseSeq'] < 0) ledger_fail('bad-authorization', 'baseSeq must be a non-negative integer');
    if (!is_string($payload['baseHead']) || !preg_match('/^[a-f0-9]{64}$/D', $payload['baseHead'])) ledger_fail('bad-authorization', 'baseHead must be a hash');
    if (!is_string($payload['nonce']) || !preg_match('/^[a-f0-9]{32,64}$/D', $payload['nonce'])) ledger_fail('bad-authorization', 'the nonce must be 32 to 64 hex characters');
    foreach (['issuedAt', 'expiresAt'] as $field) {
        if (!is_string($payload[$field]) || !preg_match('/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/D', $payload[$field]) || strtotime($payload[$field]) === false) ledger_fail('bad-authorization', $field . ' must be a UTC time');
    }
    $issued = strtotime($payload['issuedAt']);
    $expires = strtotime($payload['expiresAt']);
    if ($expires <= $issued || $expires - $issued > LEDGER_PROPOSAL_MAX_SECONDS) ledger_fail('bad-authorization', 'a proposal lives at most ' . LEDGER_PROPOSAL_MAX_SECONDS . ' seconds');
    if ($issued > $now + LEDGER_CLOCK_SKEW_SECONDS) ledger_fail('not-yet-valid', 'the proposal is dated in the future');
    if ($now >= $expires) ledger_fail('expired', 'the proposal has expired');
    if (!ledger_owner_verify(ledger_canonical($payload), $payload['from'], $signature)) ledger_fail('bad-signature', 'the owner signature does not verify');
    return ['from' => $payload['from'], 'to' => $payload['to'], 'amount' => $amount, 'baseSeq' => $payload['baseSeq'], 'nonce' => $payload['nonce']];
}

function ledger_account_row(PDO $db, string $coinId, string $key): ?array
{
    $row = $db->prepare('SELECT * FROM ledger_accounts WHERE coin_id=? AND account_key=?');
    $row->execute([$coinId, $key]);
    $found = $row->fetch(PDO::FETCH_ASSOC);
    return $found ?: null;
}

// Builds the next entry for an owner's transfer, validating it against the current state without writing anything. The
// result is what the authority signs and the approvers sign the hash of.
function ledger_prepare_transfer(PDO $db, string $coinId, array $authorization, int $now): array
{
    $coin = ledger_coin($db, $coinId);
    if ($coin['state'] !== 'active') ledger_fail('not-active', 'the coin is ' . $coin['state']);
    $t = ledger_check_authorization($coin, $authorization, $now);
    $nonce = $db->prepare('SELECT 1 FROM ledger_nonces WHERE coin_id=? AND owner_key=? AND nonce=?');
    $nonce->execute([$coinId, $t['from'], $t['nonce']]);
    if ($nonce->fetchColumn()) ledger_fail('replayed', 'this nonce was already used');
    $from = ledger_account_row($db, $coinId, $t['from']);
    if (!$from) ledger_fail('no-account', 'the sender has no account');
    if ((int) $from['seq'] !== $t['baseSeq']) ledger_fail('stale', 'the sender account has moved on since this was signed');
    if ((int) $from['units'] < $t['amount']) ledger_fail('insufficient', 'the sender holds less than the amount');
    $head = ledger_head($db, $coinId);
    $at = ledger_check_executed_at(gmdate('Y-m-d\TH:i:s\Z', $now), $authorization['payload'], ledger_head_time($db, $coinId));
    ledger_faucet_check($db, $coin, $t['from'], $t['to'], $t['amount'], $at);
    $public = ['type' => 'transfer', 'coinId' => $coinId, 'index' => $head['index'] + 1, 'prevHash' => $head['hash'], 'executedAt' => gmdate('Y-m-d\TH:i:s\Z', $now),
        'amount' => (string) $t['amount'], 'from' => ledger_account_ref($coin, $t['from']), 'to' => ledger_account_ref($coin, $t['to'])];
    $hash = ledger_digest($public);
    return ['public' => $public, 'private' => ['hash' => $hash, 'from' => $t['from'], 'to' => $t['to'], 'authorization' => $authorization], 'hash' => $hash];
}

// The form of an entry for the next index: both forms present, extending the head, the hash matching the public form.
// Returns [public, private, hash].
function ledger_check_frame(PDO $db, array $coin, array $prepared): array
{
    $coinId = $coin['coin_id'];
    $public = $prepared['public'] ?? null;
    $private = $prepared['private'] ?? null;
    if (!is_array($public) || !is_array($private)) ledger_fail('bad-entry', 'the entry has no public and private forms');
    $head = ledger_head($db, $coinId);
    if (($public['index'] ?? null) !== $head['index'] + 1) ledger_fail('wrong-index', 'the entry does not follow the head');
    if (($public['prevHash'] ?? null) !== $head['hash']) ledger_fail('wrong-prev', 'the entry does not extend the head hash');
    if (($public['coinId'] ?? null) !== $coinId || ($public['type'] ?? null) !== 'transfer') ledger_fail('bad-entry', 'only transfers can be committed');
    $shape = array_keys($public);
    sort($shape);
    if ($shape !== ['amount', 'coinId', 'executedAt', 'from', 'index', 'prevHash', 'to', 'type']) ledger_fail('bad-entry', 'the public form has the wrong fields');
    $hash = ledger_digest($public);
    if (($private['hash'] ?? null) !== $hash || ($prepared['hash'] ?? null) !== $hash) ledger_fail('bad-hash', 'the entry hash does not match its public form');
    return [$public, $private, $hash];
}

// The state rules of an entry against the current accounts: the owner's authorization, the references, the nonce, the
// sequence number, the balance, the time and the faucet. Writes nothing. Every domain that applies or approves an entry
// runs these against its own copy.
function ledger_validate_state(PDO $db, array $coin, array $public, array $private, int $now): array
{
    $coinId = $coin['coin_id'];
    $authorization = $private['authorization'] ?? null;
    if (!is_array($authorization)) ledger_fail('bad-entry', 'the private form has no authorization');
    $t = ledger_check_authorization($coin, $authorization, $now);
    if (($private['from'] ?? null) !== $t['from'] || ($private['to'] ?? null) !== $t['to']) ledger_fail('bad-entry', 'the private form does not match the authorization');
    if ($public['amount'] !== (string) $t['amount']) ledger_fail('bad-entry', 'the public amount does not match the authorization');
    $fromRef = ledger_account_ref($coin, $t['from']);
    $toRef = ledger_account_ref($coin, $t['to']);
    if ($public['from'] !== $fromRef || $public['to'] !== $toRef) ledger_fail('bad-entry', 'the public references do not match the keys');
    $nonce = $db->prepare('SELECT 1 FROM ledger_nonces WHERE coin_id=? AND owner_key=? AND nonce=?');
    $nonce->execute([$coinId, $t['from'], $t['nonce']]);
    if ($nonce->fetchColumn()) ledger_fail('replayed', 'this nonce was already used');
    $from = ledger_account_row($db, $coinId, $t['from']);
    if (!$from) ledger_fail('no-account', 'the sender has no account');
    if ((int) $from['seq'] !== $t['baseSeq']) ledger_fail('stale', 'the sender account has moved on since this was signed');
    if ((int) $from['units'] < $t['amount']) ledger_fail('insufficient', 'the sender holds less than the amount');
    $at = ledger_check_executed_at($public['executedAt'], $authorization['payload'], ledger_head_time($db, $coinId));
    if (abs($at - $now) > LEDGER_CLOCK_SKEW_SECONDS) ledger_fail('bad-time', 'executedAt is not close to the current time');
    ledger_faucet_check($db, $coin, $t['from'], $t['to'], $t['amount'], $at);
    return ['t' => $t, 'at' => $at, 'fromRef' => $fromRef, 'toRef' => $toRef];
}

// What a co-approver runs before signing: the entry is whole, extends its own head and is valid against its own accounts.
function ledger_validate_prepared(PDO $db, string $coinId, array $prepared, int $now): array
{
    $coin = ledger_coin($db, $coinId);
    if ($coin['state'] !== 'active') ledger_fail('not-active', 'the coin is ' . $coin['state']);
    [$public, $private, $hash] = ledger_check_frame($db, $coin, $prepared);
    ledger_validate_state($db, $coin, $public, $private, $now);
    return ['public' => $public, 'private' => $private, 'hash' => $hash];
}

// Writes a prepared entry once the authority has signed its hash and enough approvers have signed the approval bytes.
// Everything is checked again inside one write transaction, so two commits of the same index cannot both succeed.
function ledger_commit(PDO $db, string $coinId, array $prepared, string $authoritySignature, array $approvals, int $now): array
{
    $db->exec('BEGIN IMMEDIATE');
    try {
        $coin = ledger_coin($db, $coinId);
        $genesis = $coin['genesis'];
        if ($coin['state'] !== 'active') ledger_fail('not-active', 'the coin is ' . $coin['state']);
        [$public, $private, $hash] = ledger_check_frame($db, $coin, $prepared);
        $authorityKey = ledger_roster_key($genesis, $genesis['authority']);
        if ($authorityKey === null || !ledger_verify($authorityKey, $hash, $authoritySignature)) ledger_fail('bad-authority-signature', 'the authority signature does not verify');
        // Approvals: the authority counts once through its signature above; every other approver is a distinct roster domain.
        $approvers = [$genesis['authority'] => true];
        $kept = [];
        foreach ($approvals as $approval) {
            $domain = is_array($approval) ? ($approval['domain'] ?? null) : null;
            $key = is_string($domain) ? ledger_roster_key($genesis, $domain) : null;
            if ($key === null) ledger_fail('not-in-roster', 'an approval comes from a domain outside the roster');
            if ($domain === $genesis['authority'] || isset($approvers[$domain])) ledger_fail('duplicate-approval', 'a domain approved twice');
            if (!ledger_verify($key, ledger_approval_bytes($coinId, $public['index'], $hash), $approval['signature'] ?? null)) ledger_fail('bad-approval', 'an approval signature does not verify');
            $approvers[$domain] = true;
            $kept[] = ['domain' => $domain, 'signature' => $approval['signature']];
        }
        if (count($approvers) < (int) $coin['threshold']) ledger_fail('not-enough-approvals', 'the entry has ' . count($approvers) . ' of ' . $coin['threshold'] . ' required approvals');
        $checked = ledger_validate_state($db, $coin, $public, $private, $now);
        $t = $checked['t'];
        $at = $checked['at'];
        $fromRef = $checked['fromRef'];
        $toRef = $checked['toRef'];
        // Apply. A recipient without an account gets one.
        $db->prepare('UPDATE ledger_accounts SET units=units-?, seq=seq+1 WHERE coin_id=? AND account_key=?')->execute([$t['amount'], $coinId, $t['from']]);
        $to = ledger_account_row($db, $coinId, $t['to']);
        if ($to) {
            $db->prepare('UPDATE ledger_accounts SET units=units+? WHERE coin_id=? AND account_key=?')->execute([$t['amount'], $coinId, $t['to']]);
        } else {
            $db->prepare('INSERT INTO ledger_accounts(coin_id,account_key,ref,units,seq) VALUES(?,?,?,?,0)')->execute([$coinId, $t['to'], $toRef, $t['amount']]);
        }
        $supply = $db->prepare('SELECT COALESCE(SUM(units),0) FROM ledger_accounts WHERE coin_id=?');
        $supply->execute([$coinId]);
        if ((int) $supply->fetchColumn() !== (int) $coin['initial_units']) ledger_fail('supply-changed', 'the entry would change the total supply');
        if (($genesis['faucet'] ?? null) !== null && $t['from'] === $coin['treasury_key']) {
            $db->prepare('INSERT INTO ledger_faucet(coin_id,account_key,total,last_at) VALUES(?,?,?,?) ON CONFLICT(coin_id,account_key) DO UPDATE SET total=total+excluded.total, last_at=excluded.last_at')
                ->execute([$coinId, $t['to'], $t['amount'], $at]);
        }
        $db->prepare('INSERT INTO ledger_nonces(coin_id,owner_key,nonce) VALUES(?,?,?)')->execute([$coinId, $t['from'], $t['nonce']]);
        $db->prepare('INSERT INTO ledger_log(coin_id,idx,hash,prev_hash,public_json,private_json,authority_sig,approvals_json) VALUES(?,?,?,?,?,?,?,?)')
            ->execute([$coinId, $public['index'], $hash, $public['prevHash'], ledger_canonical($public), ledger_canonical($private), $authoritySignature, ledger_canonical($kept)]);
        foreach ([$fromRef, $toRef] as $ref) {
            $pos = $db->prepare('SELECT COALESCE(MAX(pos)+1,0) FROM ledger_account_entries WHERE coin_id=? AND ref=?');
            $pos->execute([$coinId, $ref]);
            $db->prepare('INSERT INTO ledger_account_entries(coin_id,ref,pos,idx) VALUES(?,?,?,?)')->execute([$coinId, $ref, (int) $pos->fetchColumn(), $public['index']]);
        }
        $db->prepare("UPDATE ledger_proposals SET status='executed', executed_index=? WHERE coin_id=? AND from_key=? AND nonce=? AND status='pending'")
            ->execute([$public['index'], $coinId, $t['from'], $t['nonce']]);
        $db->exec('COMMIT');
        return ['index' => $public['index'], 'hash' => $hash];
    } catch (Throwable $e) {
        ledger_rollback($db);
        throw $e;
    }
}

// ---------- sharing the log between roster domains ----------

// The whole log entry, private form included: what one roster domain sends another so it can keep an identical copy.
function ledger_records_after(PDO $db, string $coinId, int $after, int $limit): array
{
    ledger_coin($db, $coinId);
    $rows = $db->prepare('SELECT * FROM ledger_log WHERE coin_id=? AND idx>? ORDER BY idx LIMIT ?');
    $rows->execute([$coinId, $after, max(1, min(LEDGER_PAGE_MAX, $limit))]);
    $out = [];
    foreach ($rows->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $out[] = ['index' => (int) $row['idx'], 'public' => json_decode($row['public_json'], true), 'private' => json_decode($row['private_json'], true), 'hash' => $row['hash'],
            'authoritySignature' => $row['authority_sig'], 'approvals' => json_decode($row['approvals_json'], true)];
    }
    return $out;
}

// Applies an entry received from the authority to this copy, with every check a commit makes: the hash chain, the
// authority's signature, enough distinct roster approvals, the owner's signature, the balances and the faucet. The time
// checks are made as of the entry's own time, since it was executed earlier.
function ledger_mirror_apply(PDO $db, string $coinId, array $record): array
{
    $index = $record['index'] ?? null;
    if (!is_int($index)) ledger_fail('bad-entry', 'the record has no index');
    if ($index === 0) {
        ledger_mirror_genesis($db, $coinId, $record);
        return ['index' => 0, 'hash' => $record['hash']];
    }
    $at = is_array($record['public'] ?? null) && is_string($record['public']['executedAt'] ?? null) ? strtotime($record['public']['executedAt']) : false;
    if ($at === false) ledger_fail('bad-time', 'the entry has no readable time');
    return ledger_commit($db, $coinId, ['public' => $record['public'], 'private' => $record['private'] ?? null, 'hash' => $record['hash'] ?? null],
        (string) ($record['authoritySignature'] ?? ''), is_array($record['approvals'] ?? null) ? $record['approvals'] : [], $at);
}

// ---------- reads for everyone: public forms only ----------

function ledger_public_coin(PDO $db, string $coinId): array
{
    $coin = ledger_coin($db, $coinId);
    $head = ledger_head($db, $coinId);
    $count = $db->prepare('SELECT COUNT(*) FROM ledger_accounts WHERE coin_id=?');
    $count->execute([$coinId]);
    return ['genesis' => $coin['genesis'], 'genesisDigest' => $coin['genesis_digest'], 'state' => $coin['state'], 'supply' => $coin['genesis']['initialUnits'],
        'head' => $head, 'entries' => $head['index'] + 1, 'accounts' => (int) $count->fetchColumn()];
}

// A page of the log, oldest first, starting after index $after. Public forms with their hashes and signatures only.
function ledger_public_entries(PDO $db, string $coinId, int $after = -1, int $limit = 25): array
{
    ledger_coin($db, $coinId);
    $limit = max(1, min(LEDGER_PAGE_MAX, $limit));
    $rows = $db->prepare('SELECT public_json,hash,authority_sig,approvals_json FROM ledger_log WHERE coin_id=? AND idx>? ORDER BY idx LIMIT ?');
    $rows->execute([$coinId, $after, $limit]);
    $out = [];
    foreach ($rows->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $out[] = ['entry' => json_decode($row['public_json'], true), 'hash' => $row['hash'], 'authoritySignature' => $row['authority_sig'], 'approvals' => json_decode($row['approvals_json'], true)];
    }
    return ['entries' => $out, 'next' => $out ? end($out)['entry']['index'] : null];
}

// An account by reference: its balance, its sequence number and a page of its entries. In a private coin the reference
// is the only identifier; there is no lookup by key here.
function ledger_public_account(PDO $db, string $coinId, string $ref, int $after = -1, int $limit = 25): ?array
{
    ledger_coin($db, $coinId);
    $row = $db->prepare('SELECT units,seq FROM ledger_accounts WHERE coin_id=? AND ref=?');
    $row->execute([$coinId, $ref]);
    $account = $row->fetch(PDO::FETCH_ASSOC);
    if (!$account) return null;
    $limit = max(1, min(LEDGER_PAGE_MAX, $limit));
    $list = $db->prepare('SELECT idx,pos FROM ledger_account_entries WHERE coin_id=? AND ref=? AND pos>? ORDER BY pos LIMIT ?');
    $list->execute([$coinId, $ref, $after, $limit]);
    $entries = [];
    foreach ($list->fetchAll(PDO::FETCH_ASSOC) as $row) $entries[] = ['index' => (int) $row['idx'], 'pos' => (int) $row['pos']];
    return ['ref' => $ref, 'units' => (string) $account['units'], 'seq' => (int) $account['seq'], 'entries' => $entries, 'next' => $entries ? end($entries)['pos'] : null];
}

// ---------- reads for the key's owner ----------
// The caller has already checked a request signed by $ownerKey. The private form of every entry that involves the key.

function ledger_owner_view(PDO $db, string $coinId, string $ownerKey, int $after = -1, int $limit = 25): ?array
{
    $coin = ledger_coin($db, $coinId);
    $account = ledger_account_row($db, $coinId, $ownerKey);
    if (!$account) return null;
    $limit = max(1, min(LEDGER_PAGE_MAX, $limit));
    $list = $db->prepare('SELECT e.idx AS idx,e.pos AS pos,l.private_json AS private_json,l.public_json AS public_json FROM ledger_account_entries e
        JOIN ledger_log l ON l.coin_id=e.coin_id AND l.idx=e.idx WHERE e.coin_id=? AND e.ref=? AND e.pos>? ORDER BY e.pos LIMIT ?');
    $list->execute([$coinId, $account['ref'], $after, $limit]);
    $entries = [];
    foreach ($list->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $entries[] = ['pos' => (int) $row['pos'], 'entry' => json_decode($row['public_json'], true), 'private' => json_decode($row['private_json'], true)];
    }
    return ['coinId' => $coinId, 'ref' => $account['ref'], 'units' => (string) $account['units'], 'seq' => (int) $account['seq'], 'visibility' => $coin['visibility'], 'entries' => $entries];
}

// ---------- the invariant checker ----------

// Recomputes everything from the log alone and compares it with the stored accounts and indexes. Returns a list of
// problems; an empty list means the store is consistent.
function ledger_check(PDO $db, string $coinId): array
{
    $problems = [];
    $coin = ledger_coin($db, $coinId);
    $genesis = $coin['genesis'];
    if (ledger_genesis_digest($genesis) !== $coin['genesis_digest']) $problems[] = 'the stored genesis does not match its digest';
    if ($coin['state'] === 'pending') return $problems;
    $authorityKey = ledger_roster_key($genesis, $genesis['authority']);
    $rows = $db->prepare('SELECT * FROM ledger_log WHERE coin_id=? ORDER BY idx');
    $rows->execute([$coinId]);
    $prev = $coin['genesis_digest'];
    $expectedIndex = 0;
    $units = [];
    $seq = [];
    $refOf = [];
    $positions = [];
    $nonces = [];
    $treasury = null;
    $given = [];
    $previousAt = 0;
    $private = $genesis['visibility'] === 'private';
    $refFor = static fn(string $key): string => $private ? ledger_ref((string) $coin['ref_secret'], $key) : $key;
    foreach ($rows->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $i = (int) $row['idx'];
        $where = 'entry ' . $i . ': ';
        if ($i !== $expectedIndex) { $problems[] = $where . 'index is not ' . $expectedIndex; $expectedIndex = $i; }
        $expectedIndex++;
        $public = json_decode($row['public_json'], true);
        $priv = json_decode($row['private_json'], true);
        $approvals = json_decode($row['approvals_json'], true);
        if (!is_array($public) || !is_array($priv) || !is_array($approvals)) { $problems[] = $where . 'unreadable record'; continue; }
        if ($row['prev_hash'] !== $prev || ($public['prevHash'] ?? null) !== $prev) $problems[] = $where . 'does not extend the previous hash';
        $hash = ledger_digest($public);
        if ($hash !== $row['hash'] || ($priv['hash'] ?? null) !== $hash) $problems[] = $where . 'hash does not match the public form';
        $prev = $row['hash'];
        if ($authorityKey === null || !ledger_verify($authorityKey, $row['hash'], $row['authority_sig'])) $problems[] = $where . 'authority signature does not verify';
        if ($i === 0) {
            if (($public['type'] ?? null) !== 'genesis' || ($public['amount'] ?? null) !== $genesis['initialUnits'] || ($public['to'] ?? null) !== $genesis['treasuryRef']) $problems[] = $where . 'does not credit the treasury with the initial units';
            foreach ($genesis['roster'] as $member) {
                $sig = null;
                foreach ($approvals as $a) if (($a['domain'] ?? null) === $member['domain']) $sig = $a['signature'] ?? null;
                if ($sig === null || !ledger_verify($member['key'], $coin['genesis_digest'], $sig)) $problems[] = $where . $member['domain'] . ' has no valid genesis signature';
            }
            $treasuryKey = $priv['to'] ?? null;
            if (!is_string($treasuryKey) || $refFor($treasuryKey) !== $genesis['treasuryRef']) $problems[] = $where . 'the treasury key does not match its reference';
            else { $treasury = $treasuryKey; $previousAt = strtotime($genesis['createdAt']); $units[$treasuryKey] = (int) $genesis['initialUnits']; $seq[$treasuryKey] = 0; $refOf[$treasuryKey] = $genesis['treasuryRef']; $positions[$genesis['treasuryRef']] = [0]; }
            continue;
        }
        $seen = [$genesis['authority'] => true];
        foreach ($approvals as $a) {
            $domain = $a['domain'] ?? null;
            $key = is_string($domain) ? ledger_roster_key($genesis, $domain) : null;
            if ($key === null || isset($seen[$domain]) || !ledger_verify($key, ledger_approval_bytes($coinId, $i, $row['hash']), $a['signature'] ?? null)) { $problems[] = $where . 'an approval is invalid'; continue; }
            $seen[$domain] = true;
        }
        if (count($seen) < (int) $coin['threshold']) $problems[] = $where . 'has too few approvals';
        $authorization = $priv['authorization'] ?? null;
        $payload = is_array($authorization) ? ($authorization['payload'] ?? null) : null;
        if (!is_array($payload) || !ledger_owner_verify(ledger_canonical($payload), (string) ($payload['from'] ?? ''), $authorization['signature'] ?? null)) { $problems[] = $where . 'the owner signature does not verify'; continue; }
        $from = $payload['from'];
        $to = $payload['to'];
        $amount = (int) $payload['amount'];
        if (($priv['from'] ?? null) !== $from || ($priv['to'] ?? null) !== $to || ($public['amount'] ?? null) !== $payload['amount']) $problems[] = $where . 'the private and public forms disagree';
        if (($public['from'] ?? null) !== $refFor($from) || ($public['to'] ?? null) !== $refFor($to)) $problems[] = $where . 'the public references do not match the keys';
        try {
            $at = ledger_check_executed_at($public['executedAt'] ?? null, $payload, $previousAt);
            $previousAt = $at;
            $policy = $genesis['faucet'] ?? null;
            if ($policy !== null && $from === $treasury) {
                if ($amount > (int) $policy['maxAmount']) throw new LedgerError('faucet-amount', 'over the grant limit');
                $g = $given[$to] ?? ['total' => 0, 'last' => 0];
                ledger_faucet_rules($policy, $g['total'], $g['last'], $amount, $at);
                $given[$to] = ['total' => $g['total'] + $amount, 'last' => $at];
            }
        } catch (LedgerError $e) {
            $problems[] = $where . $e->reason . ': ' . $e->getMessage();
        }
        if (isset($nonces[$from . '|' . $payload['nonce']])) $problems[] = $where . 'repeats a nonce';
        $nonces[$from . '|' . $payload['nonce']] = true;
        if (($seq[$from] ?? -1) !== $payload['baseSeq']) $problems[] = $where . 'is not signed against the sender\'s sequence number';
        if (($units[$from] ?? 0) < $amount) { $problems[] = $where . 'overdraws the sender'; continue; }
        $units[$from] -= $amount;
        $seq[$from]++;
        $units[$to] = ($units[$to] ?? 0) + $amount;
        $seq[$to] = $seq[$to] ?? 0;
        $refOf[$from] = $refFor($from);
        $refOf[$to] = $refFor($to);
        foreach ([$refOf[$from], $refOf[$to]] as $r) $positions[$r][] = $i;
    }
    if (array_sum($units) !== (int) $coin['initial_units']) $problems[] = 'the derived supply is not the initial supply';
    $stored = $db->prepare('SELECT account_key,ref,units,seq FROM ledger_accounts WHERE coin_id=?');
    $stored->execute([$coinId]);
    $storedKeys = [];
    foreach ($stored->fetchAll(PDO::FETCH_ASSOC) as $a) {
        $storedKeys[$a['account_key']] = true;
        if (!isset($units[$a['account_key']])) { $problems[] = 'account ' . $a['ref'] . ' is not derived from the log'; continue; }
        if ((int) $a['units'] !== $units[$a['account_key']]) $problems[] = 'account ' . $a['ref'] . ' holds ' . $a['units'] . ' but the log gives ' . $units[$a['account_key']];
        if ((int) $a['seq'] !== $seq[$a['account_key']]) $problems[] = 'account ' . $a['ref'] . ' has the wrong sequence number';
        if ($a['ref'] !== ($refOf[$a['account_key']] ?? null)) $problems[] = 'account ' . $a['ref'] . ' has the wrong reference';
    }
    foreach ($units as $key => $_) if (!isset($storedKeys[$key])) $problems[] = 'the log creates an account that is not stored: ' . ($refOf[$key] ?? '?');
    foreach ($positions as $ref => $list) {
        $idx = $db->prepare('SELECT idx FROM ledger_account_entries WHERE coin_id=? AND ref=? ORDER BY pos');
        $idx->execute([$coinId, $ref]);
        $have = array_map('intval', $idx->fetchAll(PDO::FETCH_COLUMN));
        if ($have !== $list) $problems[] = 'the entry index of account ' . $ref . ' does not match the log';
    }
    $extra = $db->prepare('SELECT COUNT(DISTINCT ref) FROM ledger_account_entries WHERE coin_id=?');
    $extra->execute([$coinId]);
    if ((int) $extra->fetchColumn() !== count($positions)) $problems[] = 'the entry index holds an account the log does not';
    $faucetRows = $db->prepare('SELECT account_key,total,last_at FROM ledger_faucet WHERE coin_id=?');
    $faucetRows->execute([$coinId]);
    $storedGiven = [];
    foreach ($faucetRows->fetchAll(PDO::FETCH_ASSOC) as $r) $storedGiven[$r['account_key']] = ['total' => (int) $r['total'], 'last' => (int) $r['last_at']];
    ksort($storedGiven);
    ksort($given);
    if ($storedGiven !== $given) $problems[] = 'the stored faucet totals do not match the log';
    $stored = $db->prepare('SELECT COUNT(*) FROM ledger_nonces WHERE coin_id=?');
    $stored->execute([$coinId]);
    if ((int) $stored->fetchColumn() !== count($nonces)) $problems[] = 'the stored nonces do not match the log';
    return $problems;
}

// ---------- the treasury key and operator grants ----------

// A new wallet-format key pair: the public key as the wallet gives it (65 raw bytes, base64url) and the private key PEM.
function ledger_new_owner_key(): array
{
    $key = openssl_pkey_new(['curve_name' => 'prime256v1', 'private_key_type' => OPENSSL_KEYTYPE_EC]);
    if ($key === false) ledger_fail('no-key', 'a key could not be generated');
    openssl_pkey_export($key, $private);
    $d = openssl_pkey_get_details($key);
    $point = "\x04" . str_pad($d['ec']['x'], 32, "\x00", STR_PAD_LEFT) . str_pad($d['ec']['y'], 32, "\x00", STR_PAD_LEFT);
    return ['key' => ledger_b64u_encode($point), 'private' => $private];
}

// Signs a payload the way a wallet does: canonical bytes, raw r||s.
function ledger_owner_sign(string $privatePem, array $payload): string
{
    if (!openssl_sign(ledger_canonical($payload), $der, $privatePem, OPENSSL_ALGO_SHA256)) ledger_fail('no-signature', 'signing failed');
    $offset = 2;
    $raw = '';
    for ($i = 0; $i < 2; $i++) {
        $len = ord($der[$offset + 1]);
        $raw .= str_pad(ltrim(substr($der, $offset + 2, $len), "\x00"), 32, "\x00", STR_PAD_LEFT);
        $offset += 2 + $len;
    }
    return ledger_b64u_encode($raw);
}

// Creates the treasury key file for a coin: readable by its owner only, never overwritten. $dir is the private folder.
function ledger_treasury_key_create(string $dir, string $coinId): array
{
    if (!preg_match('/^[a-f0-9]{32}$/D', $coinId) || !is_dir($dir)) ledger_fail('bad-key-file', 'a coin id and an existing folder are needed');
    $file = rtrim($dir, '/\\') . '/treasury-' . $coinId . '.json';
    $pair = ledger_new_owner_key();
    $handle = @fopen($file, 'x');
    if ($handle === false) ledger_fail('key-exists', 'a treasury key already exists for this coin');
    chmod($file, 0600);
    fwrite($handle, json_encode($pair, JSON_UNESCAPED_SLASHES));
    fclose($handle);
    return $pair;
}

function ledger_treasury_key_load(string $dir, string $coinId): array
{
    if (!preg_match('/^[a-f0-9]{32}$/D', $coinId)) ledger_fail('bad-key-file', 'a coin id is needed');
    $raw = @file_get_contents(rtrim($dir, '/\\') . '/treasury-' . $coinId . '.json');
    $pair = is_string($raw) ? json_decode($raw, true) : null;
    if (!is_array($pair) || !ledger_valid_owner_key($pair['key'] ?? null) || !is_string($pair['private'] ?? null) || openssl_pkey_get_private($pair['private']) === false) ledger_fail('bad-key-file', 'the treasury key file is missing or unreadable');
    return ['key' => $pair['key'], 'private' => $pair['private']];
}

// An operator grant: a transfer from the treasury, signed by the treasury key. It is prepared and checked like any other
// transfer, including the faucet limits; the authority and approvers then sign and commit it. A multi authority coin
// submits the signed authorization as a proposal instead.
function ledger_grant_authorization(PDO $db, string $coinId, array $treasury, string $recipientKey, string $amount, int $now): array
{
    $coin = ledger_coin($db, $coinId);
    if (($treasury['key'] ?? null) !== $coin['treasury_key']) ledger_fail('not-treasury', 'that is not the coin\'s treasury key');
    $row = ledger_account_row($db, $coinId, $coin['treasury_key']);
    if (!$row) ledger_fail('no-account', 'the treasury has no account yet');
    $payload = ['type' => 'atlas.ledger.transfer', 'v' => 1, 'coinId' => $coinId, 'from' => $coin['treasury_key'], 'to' => $recipientKey, 'amount' => $amount,
        'baseSeq' => (int) $row['seq'], 'baseHead' => ledger_head($db, $coinId)['hash'], 'nonce' => bin2hex(random_bytes(16)),
        'issuedAt' => gmdate('Y-m-d\TH:i:s\Z', $now), 'expiresAt' => gmdate('Y-m-d\TH:i:s\Z', $now + 300)];
    return ['payload' => $payload, 'signature' => ledger_owner_sign($treasury['private'], $payload)];
}

function ledger_grant(PDO $db, string $coinId, array $treasury, string $recipientKey, string $amount, int $now): array
{
    return ledger_prepare_transfer($db, $coinId, ledger_grant_authorization($db, $coinId, $treasury, $recipientKey, $amount, $now), $now);
}
