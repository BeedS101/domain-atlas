<?php
declare(strict_types=1);
// Operator authorization for the chain labs. Include-only: a direct request for this file gets a 404.
//
// An operator action is a request the operator's key signed. The signed text names the action, the domain, the HTTP method, a time and a
// nonce, and holds every argument of the action, which the endpoint then reads from the signed text and from nowhere else. The keys that
// may sign are listed in chainlabs-operators.json in the private folder, which is read on every request. Each accepted request is
// recorded, with its nonce, before it is carried out, and the outcome is recorded after, so a lost answer is repeated from the record
// and never by carrying the action out a second time. Every request, accepted or refused, is written to a hash-chained audit table.
//
// Until OPERATOR_LEGACY_UNTIL a request may instead carry the old kind of operator token, whose SHA-256 the roster file holds. That
// date is a constant of this file: no setting moves it. Once the signed path has been activated (operator_activate), a token is no
// longer accepted for any action that changes something.
if (PHP_SAPI !== 'cli' && isset($_SERVER['SCRIPT_FILENAME']) && realpath($_SERVER['SCRIPT_FILENAME']) === __FILE__) { http_response_code(404); exit; }

require_once __DIR__ . '/ledger.php';

// 1 March 2027 00:00 UTC. From this second an operator token is refused for every action.
const OPERATOR_LEGACY_UNTIL = 1803859200;

const OPERATOR_LIFETIME_SECONDS = 120;
const OPERATOR_SENSITIVE_LIFETIME_SECONDS = 60;
const OPERATOR_SKEW_SECONDS = 30;
const OPERATOR_DUPLICATE_SECONDS = 300;
const OPERATOR_PENDING_KEEP_SECONDS = 86400;
const OPERATOR_FAIL_LIMIT = 10;
const OPERATOR_FAIL_WINDOW_SECONDS = 300;
const OPERATOR_NONCE_CAP = 20000;
const OPERATOR_REFUSAL_LOG_CAP = 200000;
const OPERATOR_STORED_RESPONSE_MAX = 60000;
const OPERATOR_ROSTER_MAX_BYTES = 65536;
const OPERATOR_MAX_KEYS = 50;

// Every operator action, the name a key's `actions` list and a signed request use for it, and whether it changes something. A token
// can no longer take an action that changes something once the signed path has been activated.
const OPERATOR_ACTIONS = [
    'spend34/open' => true, 'spend34/grant' => true, 'spend34/recover' => true, 'spend34/compare' => true,
    'spend34/purchase-recover' => true, 'spend34/purchase-cancel' => true, 'spend34/restore' => true,
    'spend34/accept-rollback' => true, 'spend34/reseal' => true, 'spend34/resume' => true,
    'coin26/create' => true,
    'spend34/integrity' => false, 'spend34/evidence' => false, 'coin26/preview' => false,
    'operator/check' => false, 'operator/audit' => false,
    'operator/activate' => true,
    // A partner operator's consent to the genesis of a coin another domain proposes (lib/consent.php).
    'spend34/consent-list' => false, 'spend34/consent-accept' => true, 'spend34/consent-decline' => true,
];

// Actions that never take the operator token, not even before the token's date and before signed requests are activated: they are new, so
// nothing depends on a token for them, and a consent is the last thing to leave to the weaker credential.
const OPERATOR_SIGNED_ONLY = ['spend34/consent-list' => true, 'spend34/consent-accept' => true, 'spend34/consent-decline' => true];

final class OperatorError extends RuntimeException
{
    public function __construct(public readonly string $reason, string $message, public readonly int $status, public readonly array $extra = [])
    {
        parent::__construct($message);
    }
}

function operator_paths(string $private): array
{
    return ['roster' => $private . '/chainlabs-operators.json', 'db' => $private . '/chainlabs-operator.sqlite', 'ratchet' => $private . '/chainlabs-operator-ratchet.json'];
}

function operator_fingerprint(string $publicKey): string
{
    return substr(hash('sha256', $publicKey), 0, 16);
}

function operator_client(): string
{
    $addr = isset($_SERVER['REMOTE_ADDR']) && is_string($_SERVER['REMOTE_ADDR']) ? preg_replace('/^::ffff:/', '', $_SERVER['REMOTE_ADDR']) : 'unknown';
    return substr(hash('sha256', 'chainlabs.operator.client|' . $addr), 0, 16);
}

function operator_legacy_open(int $now): bool
{
    return $now < OPERATOR_LEGACY_UNTIL;
}

function operator_sensitive(string $action): bool
{
    return OPERATOR_ACTIONS[$action] ?? true;
}

function operator_iso(int $t): string
{
    return gmdate('Y-m-d\TH:i:s\Z', $t);
}

function operator_parse_time(mixed $text): ?int
{
    if (!is_string($text) || !preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/D', $text)) return null;
    $t = strtotime($text);
    return $t === false ? null : $t;
}

// ---------- the roster ----------

// The roster: { "domain": "a.example", "legacyTokenSha256": "<64 hex>", "keys": [ { "publicKey": "<wallet key form>", "label": "...",
// "actions": ["spend34/grant", ...], "revoked": true } ] }. `actions` is optional: a key without it may take every action. An
// `actions` list that is not a list of known action names gives that key no action at all. A key that is not valid, or one listed twice,
// makes the whole file invalid, so that a mistake locks the operator actions rather than opening them. The file is never trusted from a
// folder inside the web root, and a file anyone can write is refused.
function operator_roster(string $private, string $host): array
{
    $file = operator_paths($private)['roster'];
    if (!is_file($file)) throw new OperatorError('operator-not-configured', 'This domain has no operator keys yet. Put chainlabs-operators.json in the private folder.', 503);
    clearstatcache(true, $file);
    $perms = @fileperms($file);
    if ($perms === false || ($perms & 0002) !== 0) throw new OperatorError('operator-roster-unsafe', 'The operator roster can be written by anyone, so it is not used.', 503);
    $size = @filesize($file);
    if ($size === false || $size > OPERATOR_ROSTER_MAX_BYTES) throw new OperatorError('operator-roster-invalid', 'The operator roster is too large.', 503);
    $doc = json_decode((string) file_get_contents($file), true);
    $invalid = static fn(string $why): OperatorError => new OperatorError('operator-roster-invalid', 'The operator roster is not valid: ' . $why, 503);
    if (!is_array($doc) || array_is_list($doc)) throw $invalid('it is not an object');
    if (!is_string($doc['domain'] ?? null)) throw $invalid('it names no domain');
    $keys = $doc['keys'] ?? null;
    if (!is_array($keys) || !array_is_list($keys) || count($keys) > OPERATOR_MAX_KEYS) throw $invalid('keys must be a list');
    $legacy = $doc['legacyTokenSha256'] ?? null;
    if ($legacy !== null && (!is_string($legacy) || !preg_match('/^[a-f0-9]{64}$/D', $legacy))) throw $invalid('legacyTokenSha256 must be 64 hex characters');
    $out = [];
    foreach ($keys as $entry) {
        if (!is_array($entry) || array_is_list($entry) || !ledger_valid_owner_key($entry['publicKey'] ?? null)) throw $invalid('a key is not a wallet key');
        $key = $entry['publicKey'];
        if (isset($out[$key])) throw $invalid('a key is listed twice');
        $actions = null;
        if (array_key_exists('actions', $entry)) {
            $list = $entry['actions'];
            $good = is_array($list) && array_is_list($list);
            if ($good) foreach ($list as $a) if (!is_string($a) || !isset(OPERATOR_ACTIONS[$a])) $good = false;
            $actions = $good ? array_values(array_unique($list)) : [];
        }
        $revoked = array_key_exists('revoked', $entry) && !($entry['revoked'] === false || $entry['revoked'] === null);
        $label = is_string($entry['label'] ?? null) ? substr($entry['label'], 0, 80) : '';
        $out[$key] = ['publicKey' => $key, 'fingerprint' => operator_fingerprint($key), 'label' => $label, 'actions' => $actions, 'revoked' => $revoked];
    }
    return ['domain' => $doc['domain'], 'keys' => $out, 'legacySha' => $legacy];
}

// Whether a key may take an action. `operator/check` is open to every active key: it is how a new key proves itself.
function operator_permits(array $key, string $action): bool
{
    if ($key['revoked']) return false;
    if ($action === 'operator/check') return true;
    return $key['actions'] === null || in_array($action, $key['actions'], true);
}

// ---------- state: nonces, failures, audit ----------

function operator_db(string $private): PDO
{
    $file = operator_paths($private)['db'];
    $new = !is_file($file);
    $db = new PDO('sqlite:' . $file, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_TIMEOUT => 5]);
    $db->exec('PRAGMA busy_timeout=5000');
    $db->exec('CREATE TABLE IF NOT EXISTS operator_nonces(key_fp TEXT NOT NULL, nonce TEXT NOT NULL, digest TEXT NOT NULL, intent TEXT NOT NULL, action TEXT NOT NULL,
        status TEXT NOT NULL, http_status INTEGER, response TEXT, at INTEGER NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(key_fp, nonce))');
    $db->exec('CREATE INDEX IF NOT EXISTS operator_nonces_intent ON operator_nonces(intent, at)');
    $db->exec('CREATE TABLE IF NOT EXISTS operator_failures(client TEXT NOT NULL, at INTEGER NOT NULL)');
    $db->exec('CREATE INDEX IF NOT EXISTS operator_failures_client ON operator_failures(client, at)');
    $db->exec('CREATE TABLE IF NOT EXISTS operator_verified(key_fp TEXT PRIMARY KEY, at INTEGER NOT NULL)');
    $db->exec('CREATE TABLE IF NOT EXISTS operator_state(name TEXT PRIMARY KEY, value TEXT NOT NULL)');
    $db->exec('CREATE TABLE IF NOT EXISTS operator_audit(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, event TEXT NOT NULL, action TEXT, key_fp TEXT, nonce_fp TEXT,
        digest TEXT, client TEXT, code TEXT, status INTEGER, detail TEXT, prev TEXT NOT NULL, hash TEXT NOT NULL)');
    if ($new) @chmod($file, 0600);
    return $db;
}

// A request that fails to authenticate is counted for the client that sent it. The count limits only what a client can try without
// a key on the roster: a token, a key that is not listed, a request that cannot be read. A request that is signed by a listed key is
// never turned away by the count, so a stranger cannot shut the operator out.
function operator_failure_note(PDO $db, int $now): void
{
    $db->prepare('DELETE FROM operator_failures WHERE at < ?')->execute([$now - OPERATOR_FAIL_WINDOW_SECONDS]);
    $db->prepare('INSERT INTO operator_failures(client, at) VALUES(?, ?)')->execute([operator_client(), $now]);
}

function operator_retry_after(PDO $db, int $now): int
{
    $q = $db->prepare('SELECT at FROM operator_failures WHERE client = ? AND at >= ? ORDER BY at');
    $q->execute([operator_client(), $now - OPERATOR_FAIL_WINDOW_SECONDS]);
    $times = $q->fetchAll(PDO::FETCH_COLUMN);
    if (count($times) < OPERATOR_FAIL_LIMIT) return 0;
    return max(1, (int) $times[count($times) - OPERATOR_FAIL_LIMIT] + OPERATOR_FAIL_WINDOW_SECONDS - $now);
}

// Whether a transaction opened here is running on this connection (PDO does not report one that was opened with BEGIN IMMEDIATE).
function operator_tx(PDO $db, ?bool $set = null): bool
{
    static $open = [];
    $id = spl_object_id($db);
    if ($set !== null) $open[$id] = $set;
    return $open[$id] ?? false;
}

function operator_begin(PDO $db): void
{
    $db->exec('BEGIN IMMEDIATE');
    operator_tx($db, true);
}

function operator_end(PDO $db, bool $commit): void
{
    if (!operator_tx($db)) return;
    operator_tx($db, false);
    $db->exec($commit ? 'COMMIT' : 'ROLLBACK');
}

// Appends one line to the audit table. Each line holds the hash of the one before it and its own fields, so a line that is changed or
// taken out of the middle shows in operator_audit_verify. The lines hold no token, no signature and no key, only the fingerprint of
// a key, and the arguments an action names (a coin, a recipient, an amount).
function operator_audit(PDO $db, string $event, array $f, int $now): void
{
    $own = !operator_tx($db);
    if ($own) operator_begin($db);
    try {
        $last = $db->query('SELECT id, hash FROM operator_audit ORDER BY id DESC LIMIT 1')->fetch(PDO::FETCH_ASSOC);
        if (in_array($event, ['refused', 'throttled'], true) && $last && (int) $last['id'] >= OPERATOR_REFUSAL_LOG_CAP) { if ($own) operator_end($db, true); return; }
        $prev = $last ? (string) $last['hash'] : str_repeat('0', 64);
        $row = [
            'at' => $now, 'event' => $event, 'action' => $f['action'] ?? null, 'key_fp' => $f['key_fp'] ?? null, 'nonce_fp' => $f['nonce_fp'] ?? null,
            'digest' => $f['digest'] ?? null, 'client' => $f['client'] ?? operator_client(), 'code' => $f['code'] ?? null, 'status' => $f['status'] ?? null,
            'detail' => isset($f['detail']) ? substr((string) $f['detail'], 0, 1000) : null,
        ];
        $hash = hash('sha256', $prev . "\n" . ledger_canonical($row));
        $db->prepare('INSERT INTO operator_audit(at,event,action,key_fp,nonce_fp,digest,client,code,status,detail,prev,hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
            ->execute([$row['at'], $row['event'], $row['action'], $row['key_fp'], $row['nonce_fp'], $row['digest'], $row['client'], $row['code'], $row['status'], $row['detail'], $prev, $hash]);
        if ($own) operator_end($db, true);
    } catch (Throwable $e) {
        if ($own) operator_end($db, false);
        throw $e;
    }
}

// Whether every line of the audit table still follows the one before it. A table with its oldest lines removed is checked from its
// first remaining line.
function operator_audit_verify(PDO $db): array
{
    $rows = $db->query('SELECT * FROM operator_audit ORDER BY id')->fetchAll(PDO::FETCH_ASSOC);
    $prev = null;
    foreach ($rows as $r) {
        if ($prev !== null && $r['prev'] !== $prev) return ['ok' => false, 'lines' => count($rows), 'brokenAt' => (int) $r['id']];
        $row = ['at' => (int) $r['at'], 'event' => $r['event'], 'action' => $r['action'], 'key_fp' => $r['key_fp'], 'nonce_fp' => $r['nonce_fp'], 'digest' => $r['digest'],
            'client' => $r['client'], 'code' => $r['code'], 'status' => $r['status'] === null ? null : (int) $r['status'], 'detail' => $r['detail']];
        if (!hash_equals(hash('sha256', $r['prev'] . "\n" . ledger_canonical($row)), (string) $r['hash'])) return ['ok' => false, 'lines' => count($rows), 'brokenAt' => (int) $r['id']];
        $prev = (string) $r['hash'];
    }
    return ['ok' => true, 'lines' => count($rows), 'brokenAt' => null];
}

function operator_audit_read(PDO $db, int $limit): array
{
    $limit = max(1, min(200, $limit));
    $rows = $db->query('SELECT id, at, event, action, key_fp, nonce_fp, digest, code, status, detail FROM operator_audit ORDER BY id DESC LIMIT ' . $limit)->fetchAll(PDO::FETCH_ASSOC);
    foreach ($rows as &$r) { $r['id'] = (int) $r['id']; $r['at'] = operator_iso((int) $r['at']); if ($r['status'] !== null) $r['status'] = (int) $r['status']; }
    return $rows;
}

// The arguments of an action that the audit line names. Free text is cut short.
function operator_detail(array $args): string
{
    $out = [];
    foreach (['coinId', 'to', 'amount', 'requestId', 'symbol', 'name', 'mode', 'reason'] as $k) {
        if (isset($args[$k]) && is_string($args[$k])) $out[$k] = substr($args[$k], 0, 200);
    }
    return $out ? ledger_canonical($out) : '';
}

function operator_refuse(PDO $db, int $now, string $action, ?string $keyFp, string $code, string $message, int $status, array $extra = [], bool $count = false): never
{
    if ($count) operator_failure_note($db, $now);
    operator_audit($db, 'refused', ['action' => $action, 'key_fp' => $keyFp, 'code' => $code, 'status' => $status], $now);
    throw new OperatorError($code, $message, $status, $extra);
}

// ---------- the signed path ----------

// Whether signed requests are required for the actions that change something. Activation is kept twice, as the marker file in the private
// folder and as a row in the operator database, and either one is enough: losing one of them (a cleaned folder, a restored copy of one file)
// does not let the token back in. A database that cannot be read counts as activated.
function operator_ratchet_active(string $private, ?PDO $db = null): bool
{
    if (is_file(operator_paths($private)['ratchet'])) return true;
    try {
        $db ??= operator_db($private);
        return $db->query("SELECT 1 FROM operator_state WHERE name = 'ratchet'")->fetchColumn() !== false;
    } catch (Throwable $e) {
        return true;
    }
}

// Authorizes one operator request. $body is the decoded request body, $method the HTTP method. Returns:
//   ['via' => 'signed'|'legacy', 'args' => the arguments to carry out, ...]  the request is accepted and, for a signed one, recorded
//   ['replay' => ['status' => int, 'body' => array]]                          the same signed request was already carried out: answer with this
// and throws OperatorError for everything else.
function operator_authorize(string $private, string $host, string $action, string $method, array $body, int $now): array
{
    try {
        return operator_authorize_checked($private, $host, $action, $method, $body, $now);
    } catch (OperatorError $e) {
        throw $e;
    } catch (Throwable $e) {
        // The operator database could not be opened, read or written (damaged, locked, not writable). Nothing is carried out without a record of it.
        throw new OperatorError('operator-state-unavailable', 'The operator records cannot be read or written, so no operator action was taken.', 503);
    }
}

function operator_authorize_checked(string $private, string $host, string $action, string $method, array $body, int $now): array
{
    if (!isset(OPERATOR_ACTIONS[$action])) throw new OperatorError('unknown-action', 'Unknown operator action.', 400);
    $roster = operator_roster($private, $host);
    $db = operator_db($private);
    // The roster names the domain it is for. A request that arrives under another name the server answers to is not accepted on it.
    if ($roster['domain'] !== $host) operator_refuse($db, $now, $action, null, 'wrong-domain', 'The operator roster is not for the host this request arrived under.', 400, [], true);
    if (array_key_exists('payload', $body) || array_key_exists('proof', $body)) return operator_signed($private, $roster, $db, $host, $action, $method, $body, $now);
    if (array_key_exists('adminToken', $body)) return operator_legacy($private, $roster, $db, $action, $body, $now);
    operator_refuse($db, $now, $action, null, 'auth-required', 'This action needs a signed operator request.', 403);
}

function operator_object(mixed $v): bool
{
    return is_array($v) && !array_is_list($v);
}

function operator_signed(string $private, array $roster, PDO $db, string $host, string $action, string $method, array $body, int $now): array
{
    $sensitive = operator_sensitive($action);
    $payload = $body['payload'] ?? null;
    $proof = $body['proof'] ?? null;
    $bad = static fn(string $m, ?string $fp = null) => operator_refuse($db, $now, $action, $fp, 'bad-request', $m, 400, [], true);
    if (!operator_object($payload) || !operator_object($proof)) $bad('A signed request is {payload, proof}.');
    $fields = array_keys($payload);
    sort($fields);
    if ($fields !== ['adminAuth', 'request', 'type', 'v'] || $payload['type'] !== 'atlas.chainlabs.operator' || $payload['v'] !== 1) $bad('The payload is not an operator request.');
    $auth = $payload['adminAuth'];
    if (!operator_object($auth)) $bad('The payload has no adminAuth.');
    $authFields = array_keys($auth);
    sort($authFields);
    $base = ['action', 'domain', 'expiresAt', 'issuedAt', 'method', 'nonce'];
    if ($authFields !== $base && $authFields !== array_merge($base, ['repeat'])) $bad('adminAuth has the wrong fields.');
    if (array_key_exists('repeat', $auth) && $auth['repeat'] !== true) $bad('adminAuth.repeat can only be true.');
    $request = $payload['request'];
    if (!is_array($request) || ($request !== [] && array_is_list($request))) $bad('The request must be an object.');
    $proofFields = array_keys($proof);
    sort($proofFields);
    if ($proofFields !== ['publicKey', 'signature', 'signerRole'] || $proof['signerRole'] !== 'raw-ecdsa' || !ledger_valid_owner_key($proof['publicKey']) || !is_string($proof['signature'])) $bad('The proof is not a raw signature.');
    $publicKey = $proof['publicKey'];
    $fp = operator_fingerprint($publicKey);

    if ($method !== 'POST' || ($auth['method'] ?? null) !== 'POST') $bad('An operator request is a POST, and says so.', $fp);
    if (($auth['action'] ?? null) !== $action) operator_refuse($db, $now, $action, $fp, 'wrong-action', 'The signature is for another action.', 400, [], true);
    if (($auth['domain'] ?? null) !== $roster['domain'] || $roster['domain'] !== $host) operator_refuse($db, $now, $action, $fp, 'wrong-domain', 'The signature is for another domain.', 400, [], true);
    $issued = operator_parse_time($auth['issuedAt'] ?? null);
    $expires = operator_parse_time($auth['expiresAt'] ?? null);
    $nonce = $auth['nonce'] ?? null;
    if ($issued === null || $expires === null || !is_string($nonce) || !preg_match('/^[A-Za-z0-9_-]{16,128}$/D', $nonce)) $bad('The time or the nonce is not in the form this domain reads.', $fp);
    $limit = $sensitive ? OPERATOR_SENSITIVE_LIFETIME_SECONDS : OPERATOR_LIFETIME_SECONDS;
    if ($expires <= $issued || $expires - $issued > $limit) operator_refuse($db, $now, $action, $fp, 'bad-lifetime', 'A request for this action may live at most ' . $limit . ' seconds.', 400, [], true);
    if ($now >= $expires || $issued > $now + OPERATOR_SKEW_SECONDS) operator_refuse($db, $now, $action, $fp, 'expired-request', 'The request has expired or is dated ahead of this domain\'s clock.', 401, ['serverTime' => operator_iso($now)]);

    $key = $roster['keys'][$publicKey] ?? null;
    if ($key === null || $key['revoked']) {
        $retry = operator_retry_after($db, $now);
        if ($retry > 0) { operator_audit($db, 'throttled', ['action' => $action, 'key_fp' => $fp, 'code' => 'rate-limited', 'status' => 429], $now); throw new OperatorError('rate-limited', 'Too many failed attempts. Try again later.', 429, ['retryAfter' => $retry]); }
        operator_refuse($db, $now, $action, $fp, 'not-operator', 'This key is not an operator key of this domain.', 401, [], true);
    }
    $signed = $payload;
    if ($signed['request'] === []) $signed['request'] = new stdClass();
    if (!ledger_owner_verify(ledger_canonical($signed), $publicKey, $proof['signature'])) operator_refuse($db, $now, $action, $fp, 'bad-signature', 'The signature does not verify.', 401, [], true);
    if (!operator_permits($key, $action)) operator_refuse($db, $now, $action, $fp, 'action-not-permitted', 'This key may not take this action.', 403);

    $digest = hash('sha256', ledger_canonical($signed));
    $intent = hash('sha256', $action . "\n" . ledger_canonical($signed['request']));
    $nonceFp = substr(hash('sha256', $nonce), 0, 16);
    $args = $request;
    $detail = operator_detail($args);

    operator_begin($db);
    try {
        $db->prepare('DELETE FROM operator_nonces WHERE expires_at < ?')->execute([$now]);
        $seen = $db->prepare('SELECT digest, status, http_status, response FROM operator_nonces WHERE key_fp = ? AND nonce = ?');
        $seen->execute([$fp, $nonce]);
        $row = $seen->fetch(PDO::FETCH_ASSOC);
        if ($row) {
            if (!hash_equals((string) $row['digest'], $digest)) {
                operator_end($db, true);
                operator_refuse($db, $now, $action, $fp, 'replayed-request', 'This nonce was used by another request.', 401, [], true);
            }
            if ($row['status'] === 'done' || $row['status'] === 'failed') {
                $stored = json_decode((string) $row['response'], true);
                operator_audit($db, 'replay', ['action' => $action, 'key_fp' => $fp, 'nonce_fp' => $nonceFp, 'digest' => $digest, 'status' => (int) $row['http_status']], $now);
                operator_end($db, true);
                return ['replay' => ['status' => (int) $row['http_status'], 'body' => is_array($stored) ? $stored : ['ok' => false, 'error' => 'The recorded answer could not be read.']]];
            }
            operator_audit($db, 'refused', ['action' => $action, 'key_fp' => $fp, 'nonce_fp' => $nonceFp, 'digest' => $digest, 'code' => 'in-progress', 'status' => 409], $now);
            operator_end($db, true);
            throw new OperatorError('in-progress', 'This request was accepted and its outcome is not recorded. It was not repeated. Look at the ledger and the audit table before signing it again.', 409, ['outcomeUnknown' => true]);
        }
        if ((int) $db->query('SELECT COUNT(*) FROM operator_nonces')->fetchColumn() >= OPERATOR_NONCE_CAP) {
            operator_end($db, true);
            throw new OperatorError('busy', 'Too many recent operator requests. Try again shortly.', 503);
        }
        if ($sensitive && !array_key_exists('repeat', $auth)) {
            // A request that was accepted and has no outcome may have been carried out, so it holds back an identical one until `repeat` is signed
            // (its record is kept a day); one that finished holds it back for the duplicate window.
            $dup = $db->prepare("SELECT status, at FROM operator_nonces WHERE intent = ? AND (status = 'started' OR (status = 'done' AND at > ?)) ORDER BY at DESC LIMIT 1");
            $dup->execute([$intent, $now - OPERATOR_DUPLICATE_SECONDS]);
            $earlier = $dup->fetch(PDO::FETCH_ASSOC);
            if ($earlier) {
                operator_audit($db, 'refused', ['action' => $action, 'key_fp' => $fp, 'nonce_fp' => $nonceFp, 'digest' => $digest, 'code' => 'duplicate-request', 'status' => 409], $now);
                operator_end($db, true);
                throw new OperatorError('duplicate-request', 'The same action with the same arguments was accepted a moment ago' . ($earlier['status'] === 'started' ? ' and its outcome is not recorded' : '') . '. It was not repeated. If you mean to repeat it, sign it again with adminAuth.repeat.', 409, ['earlier' => ['status' => $earlier['status'], 'at' => operator_iso((int) $earlier['at'])]]);
            }
        }
        $db->prepare("INSERT INTO operator_nonces(key_fp,nonce,digest,intent,action,status,at,expires_at) VALUES(?,?,?,?,?,'started',?,?)")
            ->execute([$fp, $nonce, $digest, $intent, $action, $now, $now + OPERATOR_PENDING_KEEP_SECONDS]);
        operator_audit($db, 'accepted', ['action' => $action, 'key_fp' => $fp, 'nonce_fp' => $nonceFp, 'digest' => $digest, 'detail' => $detail], $now);
        operator_end($db, true);
    } catch (OperatorError $e) {
        throw $e;
    } catch (Throwable $e) {
        operator_end($db, false);
        throw $e;
    }
    return ['via' => 'signed', 'args' => $args, 'action' => $action, 'keyFp' => $fp, 'label' => $key['label'], 'nonce' => $nonce, 'digest' => $digest];
}

function operator_legacy(string $private, array $roster, PDO $db, string $action, array $body, int $now): array
{
    if (isset(OPERATOR_SIGNED_ONLY[$action])) operator_refuse($db, $now, $action, null, 'signature-required', 'This action takes a signed operator request only; an operator token is not accepted for it.', 403);
    if (!operator_legacy_open($now)) operator_refuse($db, $now, $action, null, 'legacy-ended', 'Operator tokens are no longer accepted. Sign the request with an operator key.', 403);
    if ($roster['legacySha'] === null) operator_refuse($db, $now, $action, null, 'legacy-disabled', 'This domain does not accept an operator token. Sign the request with an operator key.', 403);
    if (operator_sensitive($action) && operator_ratchet_active($private, $db)) operator_refuse($db, $now, $action, null, 'signature-required', 'This action now needs a signed operator request; a token is no longer accepted for it.', 403);
    $retry = operator_retry_after($db, $now);
    if ($retry > 0) { operator_audit($db, 'throttled', ['action' => $action, 'code' => 'rate-limited', 'status' => 429], $now); throw new OperatorError('rate-limited', 'Too many failed attempts. Try again later.', 429, ['retryAfter' => $retry]); }
    $token = $body['adminToken'];
    if (!is_string($token) || !preg_match('/^[a-f0-9]{64}$/D', $token) || !hash_equals($roster['legacySha'], hash('sha256', $token))) {
        operator_refuse($db, $now, $action, null, 'bad-token', 'Incorrect operator token', 403, [], true);
    }
    $args = $body;
    unset($args['adminToken']);
    operator_audit($db, 'legacy', ['action' => $action, 'detail' => operator_detail($args)], $now);
    return ['via' => 'legacy', 'args' => $args, 'action' => $action, 'keyFp' => null, 'nonce' => null, 'digest' => null, 'legacyUntil' => operator_iso(OPERATOR_LEGACY_UNTIL)];
}

// Records how an accepted request ended. A signed request's answer is kept with its nonce, so the same request, sent again because the
// answer was lost, is answered from the record and carried out once.
function operator_finish(string $private, array $auth, int $status, array $body, int $now): void
{
    try {
        $db = operator_db($private);
        $code = isset($body['code']) && is_string($body['code']) ? substr($body['code'], 0, 60) : null;
        if (($auth['via'] ?? null) === 'signed') {
            $text = json_encode($body, JSON_UNESCAPED_SLASHES);
            if (!is_string($text) || strlen($text) > OPERATOR_STORED_RESPONSE_MAX) $text = json_encode(['ok' => $status < 400, 'note' => 'The answer was too large to keep. The action was carried out once.']);
            $fp = (string) $auth['keyFp'];
            // A request that was refused or failed is kept as failed: it is answered again from the record, and does not stand in the way of signing it anew.
            $db->prepare('UPDATE operator_nonces SET status=?, http_status=?, response=?, expires_at=? WHERE key_fp=? AND nonce=?')->execute([$status >= 400 ? 'failed' : 'done', $status, $text, $now + OPERATOR_DUPLICATE_SECONDS + OPERATOR_SKEW_SECONDS, $fp, $auth['nonce']]);
            operator_audit($db, 'outcome', ['action' => $auth['action'], 'key_fp' => $fp, 'nonce_fp' => substr(hash('sha256', (string) $auth['nonce']), 0, 16), 'digest' => $auth['digest'], 'code' => $code, 'status' => $status], $now);
        } elseif (($auth['via'] ?? null) === 'legacy') {
            operator_audit($db, 'outcome', ['action' => $auth['action'], 'code' => $code, 'status' => $status, 'detail' => 'legacy-token'], $now);
        }
    } catch (Throwable $e) {
        // The answer is still given; the line is missing from the record.
    }
}

// ---------- the actions of the operator layer itself ----------

// `operator/check`: the key signed a request this domain accepted. It is recorded as verified, which is what activation waits for.
function operator_check(string $private, string $host, array $auth, int $now): array
{
    $roster = operator_roster($private, $host);
    $db = operator_db($private);
    $db->prepare('INSERT OR REPLACE INTO operator_verified(key_fp, at) VALUES(?, ?)')->execute([$auth['keyFp'], $now]);
    $key = null;
    foreach ($roster['keys'] as $k) if ($k['fingerprint'] === $auth['keyFp']) $key = $k;
    return ['ok' => true, 'verified' => true, 'key' => ['fingerprint' => $auth['keyFp'], 'label' => $key['label'] ?? '', 'actions' => $key['actions'] ?? 'all'],
        'ratchet' => operator_ratchet_active($private, $db), 'legacy' => ['open' => operator_legacy_open($now), 'until' => operator_iso(OPERATOR_LEGACY_UNTIL), 'tokenSet' => $roster['legacySha'] !== null]];
}

// The actions that change something and have no active, verified key that may take them.
function operator_uncovered(string $private, array $roster, PDO $db): array
{
    $verified = array_flip($db->query('SELECT key_fp FROM operator_verified')->fetchAll(PDO::FETCH_COLUMN));
    $missing = [];
    foreach (OPERATOR_ACTIONS as $action => $changes) {
        if (!$changes) continue;
        $covered = false;
        foreach ($roster['keys'] as $key) if (isset($verified[$key['fingerprint']]) && operator_permits($key, $action)) $covered = true;
        if (!$covered) $missing[] = $action;
    }
    return $missing;
}

// `operator/activate`: from now on a token is refused for every action that changes something. It needs the signature of a verified
// key, and a verified key for every such action, so that no action is left that nobody can sign. There is no way back in code: a
// setting cannot bring the token back for these actions, and a lost key is replaced by adding another to the roster file.
function operator_activate(string $private, string $host, array $auth, array $args, int $now): array
{
    if (array_keys($args) !== ['confirm'] || $args['confirm'] !== 'activate-signed-operator') throw new OperatorError('bad-request', 'Activation needs {"confirm":"activate-signed-operator"}.', 400);
    $roster = operator_roster($private, $host);
    $db = operator_db($private);
    $verified = $db->prepare('SELECT at FROM operator_verified WHERE key_fp = ?');
    $verified->execute([$auth['keyFp']]);
    if ($verified->fetchColumn() === false) throw new OperatorError('activation-not-ready', 'This key has not been verified yet. Run operator/check with it first.', 409, ['missing' => ['verified-signer']]);
    $missing = operator_uncovered($private, $roster, $db);
    if ($missing) throw new OperatorError('activation-not-ready', 'Some actions have no verified key that may take them.', 409, ['missing' => $missing]);
    $file = operator_paths($private)['ratchet'];
    $already = operator_ratchet_active($private, $db);
    $db->prepare("INSERT OR IGNORE INTO operator_state(name, value) VALUES('ratchet', ?)")->execute([operator_iso($now)]);
    if (!is_file($file)) {
        $tmp = $file . '.tmp';
        file_put_contents($tmp, json_encode(['activatedAt' => operator_iso($now), 'key' => $auth['keyFp']], JSON_UNESCAPED_SLASHES));
        @chmod($tmp, 0600);
        rename($tmp, $file);
    }
    operator_audit($db, 'activated', ['action' => 'operator/activate', 'key_fp' => $auth['keyFp'], 'detail' => $already ? 'already active' : 'signed operator requests are now required'], $now);
    return ['ok' => true, 'activated' => true, 'already' => $already];
}

function operator_audit_answer(string $private, int $limit): array
{
    $db = operator_db($private);
    return ['ok' => true, 'chain' => operator_audit_verify($db), 'lines' => operator_audit_read($db, $limit)];
}

// What an operator running the tools wants to see: the keys, the token and the activation, from the file system alone.
function operator_status(string $private, string $host, int $now): array
{
    $roster = operator_roster($private, $host);
    $db = operator_db($private);
    $verified = array_flip($db->query('SELECT key_fp FROM operator_verified')->fetchAll(PDO::FETCH_COLUMN));
    $keys = [];
    foreach ($roster['keys'] as $k) $keys[] = ['fingerprint' => $k['fingerprint'], 'label' => $k['label'], 'actions' => $k['actions'] ?? 'all', 'revoked' => $k['revoked'], 'verified' => isset($verified[$k['fingerprint']])];
    return ['domain' => $host, 'keys' => $keys, 'tokenSet' => $roster['legacySha'] !== null, 'legacyOpen' => operator_legacy_open($now), 'legacyUntil' => operator_iso(OPERATOR_LEGACY_UNTIL),
        'activated' => operator_ratchet_active($private, $db), 'uncovered' => operator_uncovered($private, $roster, $db), 'audit' => operator_audit_verify($db)];
}
