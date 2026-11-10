<?php
declare(strict_types=1);
// A stand-in for the code that holds Gold credentials, with the same interface the purchase library expects (see
// chain-labs/lib/purchase.php). Credentials are signed by an issuer key (ECDSA, DER) and owned by a wallet key; an intent is
// signed by the owner the way a wallet signs. Spend locks and the record of finished requests are kept in SQLite so a crash
// in the middle of a purchase leaves them as a real store would.
if (!function_exists('ledger_open')) require_once __DIR__ . '/../../chain-labs/lib/ledger.php';

const STAND_IN_CLASS = 'atlas.element.gold';

function stand_in_issuer(): array
{
    $key = openssl_pkey_new(['curve_name' => 'prime256v1', 'private_key_type' => OPENSSL_KEYTYPE_EC]);
    openssl_pkey_export($key, $private);
    $public = openssl_pkey_get_details($key)['key'];
    return ['private' => $private, 'public' => $public, 'issuerKey' => ledger_b64u_encode($public)];
}

function stand_in_credential(array $issuer, string $ownerKey, int $quantity, ?string $id = null): array
{
    $payload = ['id' => $id ?? bin2hex(random_bytes(12)), 'class' => STAND_IN_CLASS, 'quantity' => $quantity, 'owner' => $ownerKey];
    return $payload + ['signature' => ledger_sign($issuer['private'], ledger_canonical($payload))];
}

function stand_in_intent(array $buyer, string $coinId, array $credential, int $price, string $requestId, ?string $recipient = null, ?int $expiresAt = null): array
{
    $payload = ['type' => 'atlas.ledger.purchase.intent', 'v' => 1, 'coinId' => $coinId, 'credentialId' => $credential['id'], 'price' => $price, 'recipient' => $recipient ?? $buyer['key'],
        'requestId' => $requestId, 'expiresAt' => gmdate('Y-m-d\TH:i:s\Z', $expiresAt ?? time() + 300)];
    return ['payload' => $payload, 'signature' => ledger_owner_sign($buyer['priv'], $payload)];
}

// $statePath is this domain's own file. $issuer holds the issuer's public key, and its private key too on the domain that sells
// (it signs the remainder credential). A domain that only approves needs only verify and revoked.
function stand_in_gold(string $statePath, array $issuer): array
{
    $db = new PDO('sqlite:' . $statePath, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_TIMEOUT => 5]);
    $db->exec('PRAGMA busy_timeout=5000');
    $db->exec('CREATE TABLE IF NOT EXISTS locks(request_id TEXT PRIMARY KEY, credential_id TEXT NOT NULL UNIQUE)');
    $db->exec('CREATE TABLE IF NOT EXISTS spent(credential_id TEXT PRIMARY KEY, request_id TEXT NOT NULL)');
    $db->exec('CREATE TABLE IF NOT EXISTS finished(request_id TEXT PRIMARY KEY, balance_json TEXT NOT NULL)');
    $db->exec('CREATE TABLE IF NOT EXISTS revoked(credential_id TEXT PRIMARY KEY)');
    $issuerPem = $issuer['public'];
    $issuerPrivate = $issuer['private'] ?? null;
    return [
        'verify' => function (array $intent, array $credential, array $policy, int $now) use ($issuerPem) {
            if (ledger_b64u_decode($policy['issuerKey']) !== $issuerPem) return 'the policy names another issuer';
            $body = $credential;
            unset($body['signature']);
            $fields = array_keys($body);
            sort($fields);
            if ($fields !== ['class', 'id', 'owner', 'quantity']) return 'the credential has the wrong fields';
            if (!ledger_verify($issuerPem, ledger_canonical($body), $credential['signature'] ?? null)) return 'the credential is not signed by the issuer';
            if ($body['class'] !== $policy['priceClass']) return 'the credential is not of the price class';
            if (!is_int($body['quantity']) || $body['quantity'] < 1) return 'the credential holds nothing';
            $payload = $intent['payload'] ?? null;
            if (!is_array($payload)) return 'the intent has no payload';
            $k = array_keys($payload);
            sort($k);
            if ($k !== ['coinId', 'credentialId', 'expiresAt', 'price', 'recipient', 'requestId', 'type', 'v']) return 'the intent has the wrong fields';
            if ($payload['type'] !== 'atlas.ledger.purchase.intent' || $payload['v'] !== 1) return 'the intent is not a purchase';
            if (!ledger_owner_verify(ledger_canonical($payload), (string) $body['owner'], $intent['signature'] ?? null)) return 'the intent is not signed by the credential\'s owner';
            if ($payload['credentialId'] !== $body['id']) return 'the intent names another credential';
            if (!is_int($payload['price'])) return 'the price is not a whole number';
            $expires = strtotime((string) $payload['expiresAt']);
            return ['requestId' => $payload['requestId'], 'coinId' => $payload['coinId'], 'price' => $payload['price'], 'recipient' => $payload['recipient'],
                'credentialId' => $body['id'], 'quantity' => $body['quantity'], 'expiresAt' => $expires === false ? 0 : $expires];
        },
        'revoked' => function (string $id) use ($db): bool {
            $q = $db->prepare('SELECT 1 FROM revoked WHERE credential_id=?');
            $q->execute([$id]);
            return (bool) $q->fetchColumn();
        },
        'lock' => function (string $requestId, array $credential) use ($db): ?string {
            $spent = $db->prepare('SELECT 1 FROM spent WHERE credential_id=?');
            $spent->execute([$credential['id']]);
            if ($spent->fetchColumn()) return 'the credential was already spent';
            $mine = $db->prepare('SELECT credential_id FROM locks WHERE request_id=?');
            $mine->execute([$requestId]);
            $held = $mine->fetchColumn();
            if ($held === $credential['id']) return null;
            if ($held !== false) return 'this request holds another credential';
            try {
                $db->prepare('INSERT INTO locks(request_id,credential_id) VALUES(?,?)')->execute([$requestId, $credential['id']]);
            } catch (PDOException $e) {
                return 'the credential is held by another request';
            }
            return null;
        },
        'release' => function (string $requestId) use ($db): void {
            $db->prepare('DELETE FROM locks WHERE request_id=?')->execute([$requestId]);
        },
        'finish' => function (string $requestId, array $credential, int $price) use ($db, $issuerPrivate): array {
            $done = $db->prepare('SELECT balance_json FROM finished WHERE request_id=?');
            $done->execute([$requestId]);
            $stored = $done->fetchColumn();
            if ($stored !== false) return json_decode($stored, true);
            $balance = ['balance' => null];
            $remainder = $credential['quantity'] - $price;
            $db->exec('BEGIN IMMEDIATE');
            $db->prepare('INSERT OR IGNORE INTO spent(credential_id,request_id) VALUES(?,?)')->execute([$credential['id'], $requestId]);
            if ($remainder > 0) {
                // Issued under the id derived from the request, so a repeat issues the same credential.
                $body = ['id' => substr(hash('sha256', 'remainder' . $requestId), 0, 24), 'class' => $credential['class'], 'quantity' => $remainder, 'owner' => $credential['owner']];
                $balance = ['balance' => $body + ['signature' => ledger_sign((string) $issuerPrivate, ledger_canonical($body))]];
            }
            $db->prepare('INSERT INTO finished(request_id,balance_json) VALUES(?,?)')->execute([$requestId, json_encode($balance)]);
            $db->prepare('DELETE FROM locks WHERE request_id=?')->execute([$requestId]);
            $db->exec('COMMIT');
            return $balance;
        },
        'db' => $db,
    ];
}
