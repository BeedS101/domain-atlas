<?php
declare(strict_types=1);
// The price adapter (see lib/purchase.php) for Gold credentials held by a Domain Atlas issuer (issuer-php/lib/gold-hold.php).
// EXPERIMENTAL and not used by any live domain: nothing in this repository loads it unless a domain's private gold-adapter.php
// does, and the issuer's hold endpoint is off unless its own config enables it.
//
//   verify   checks the credential offline: it is Gold issued by the domain named in the config, carries that issuer's raw ECDSA
//            signature (the issuer's published key, which the genesis policy names), and the buyer's intent is signed by the
//            credential's owner. Nothing here trusts the issuer's token; the issuer re-checks the owner's signature itself.
//   revoked  reads the issuer's published revocation list. An unreachable or unreadable list stops the sale; it is never read as empty.
//   lock     asks the issuer to hold the credential for this request, from the owner's signed intent (which is sent as the
//            wallet signed it, signature and key re-labelled for the issuer's envelope, not re-signed).
//   begin    tells the issuer that delivery is about to be tried; from there the hold no longer lapses.
//   finish   asks the issuer to spend the held credential: the price is burned and the rest goes back to the owner.
//   release  asks the issuer to free the hold. After delivery was begun the issuer frees it only against the closure this ledger signs
//            (lib/purchase.php purchase_closure) and that the issuer's own configuration trusts; the token alone cannot.
//   holding  every domain that approves a sale asks the issuer, not the authority, for its signed status of the hold (public, read-only,
//            answered only to someone who knows the request id) and approves only if it says this credential is held for exactly this
//            sale: same coin, price, receiving key, owner and signed intent, and delivering or already spent.
// Key encoding: a wallet key and an issuer owner key are the same thing, the raw uncompressed P-256 point (65 bytes) in base64url, and
// both sign the canonical text of a payload as raw r||s, so nothing is converted. The ledger's intent {payload, signature} becomes
// the issuer's {payload, proof: {signerRole: 'raw-ecdsa', publicKey: <owner>, signature}}.
// Include-only: a direct request gets a 404.
if (PHP_SAPI !== 'cli' && isset($_SERVER['SCRIPT_FILENAME']) && realpath($_SERVER['SCRIPT_FILENAME']) === __FILE__) { http_response_code(404); exit; }
require_once __DIR__ . '/ledger.php';

// The issuer's canonical text (issuer-php/lib/crypto.php canonicalize()), which the ledger's own would refuse for a number with a fraction.
function gold_issuer_canonical(mixed $value): string
{
    if ($value === null) return 'null';
    if (is_bool($value)) return $value ? 'true' : 'false';
    if (is_int($value)) return (string) $value;
    if (is_float($value)) {
        if ($value === 0.0) return '0';
        return (string) preg_replace('/\.0e/', 'e', json_encode($value, JSON_THROW_ON_ERROR));
    }
    if (is_string($value)) {
        $out = '"';
        for ($i = 0, $n = strlen($value); $i < $n; $i++) {
            $c = $value[$i];
            $o = ord($c);
            $out .= $c === '"' ? '\\"' : ($c === '\\' ? '\\\\' : ($o === 8 ? '\\b' : ($o === 12 ? '\\f' : ($o === 10 ? '\\n' : ($o === 13 ? '\\r' : ($o === 9 ? '\\t' : ($o < 32 ? sprintf('\\u%04x', $o) : $c)))))));
        }
        return $out . '"';
    }
    if (is_array($value)) {
        if (array_is_list($value)) return '[' . implode(',', array_map('gold_issuer_canonical', $value)) . ']';
        $keys = array_map('strval', array_keys($value));
        sort($keys, SORT_STRING);
        $parts = [];
        foreach ($keys as $k) $parts[] = gold_issuer_canonical($k) . ':' . gold_issuer_canonical($value[$k]);
        return '{' . implode(',', $parts) . '}';
    }
    ledger_fail('bad-value', 'a value that cannot be written canonically');
}

function gold_issuer_asset_payload(array $c): array
{
    return ['id' => $c['id'], 'asset' => $c['asset'], 'owner' => $c['owner'], 'quantity' => $c['quantity'], 'supersedes' => $c['supersedes'], 'issuedAt' => $c['issuedAt']];
}

// Plain HTTP exchange for the adapter, replaceable in tests. Returns [status, decoded body or null]; status 0 when the issuer cannot be reached.
function gold_issuer_http(string $method, string $url, ?array $body, ?string $token, int $timeout): array
{
    $headers = "Accept: application/json\r\n" . ($body !== null ? "Content-Type: application/json\r\n" : '') . ($token !== null ? 'Authorization: Bearer ' . $token . "\r\n" : '');
    $context = stream_context_create(['http' => ['method' => $method, 'header' => $headers, 'content' => $body === null ? '' : json_encode($body, JSON_UNESCAPED_SLASHES),
        'timeout' => $timeout, 'ignore_errors' => true, 'follow_location' => 0]]);
    $text = @file_get_contents($url, false, $context);
    if ($text === false) return [0, null];
    $status = 0;
    foreach (($http_response_header ?? []) as $line) if (preg_match('#^HTTP/\S+ (\d{3})#', $line, $m)) $status = (int) $m[1];
    $decoded = json_decode($text, true);
    return [$status, is_array($decoded) ? $decoded : null];
}

// The ledger writes everything it keeps in a canonical form that refuses numbers with fractions, and a Gold credential has some in its
// element properties. So the ledger holds the credential as {id, gold: <its canonical text>}: the text is exactly what the issuer signed,
// and verify() checks the issuer's signature over it, so it cannot be changed on the way. A credential already unpacked is also accepted.
function gold_issuer_pack(mixed $credential): array
{
    if (!is_array($credential)) return ['id' => '', 'gold' => ''];
    if (is_string($credential['gold'] ?? null) && count($credential) === 2 && is_string($credential['id'] ?? null)) return $credential;
    try {
        return ['id' => is_string($credential['id'] ?? null) ? $credential['id'] : '', 'gold' => gold_issuer_canonical($credential)];
    } catch (Throwable $e) {
        return ['id' => '', 'gold' => ''];
    }
}

function gold_issuer_unpack(mixed $held): ?array
{
    if (!is_array($held)) return null;
    if (!is_string($held['gold'] ?? null)) return isset($held['credential']) ? $held : null;
    $credential = json_decode($held['gold'], true);
    return is_array($credential) && ($credential['id'] ?? null) === ($held['id'] ?? null) ? $credential : null;
}

// $config: issuerUrl (base URL, no trailing slash), issuerDomain (the domain in the credentials), issuerKey (its raw public key),
// token (the operator token of the hold endpoint; only on the domain that sells), http (optional replacement for gold_issuer_http).
function gold_issuer_adapter(array $config): array
{
    $base = rtrim((string) $config['issuerUrl'], '/');
    $domain = (string) $config['issuerDomain'];
    $issuerKey = (string) $config['issuerKey'];
    $token = isset($config['token']) ? (string) $config['token'] : null;
    $http = $config['http'] ?? 'gold_issuer_http';
    $timeout = (int) ($config['timeout'] ?? 10);
    $holdId = static fn (string $credentialId, string $requestId): string => substr(hash('sha256', 'atlas-gold-hold|' . $credentialId . '|' . $requestId), 0, 32);
    $hold = static function (array $body) use ($http, $base, $token, $timeout): array {
        if ($token === null) ledger_fail('no-token', 'this domain holds no token for the issuer\'s hold endpoint');
        return $http('POST', $base . '/atlas/ledger/gold-hold', $body, $token, $timeout);
    };
    $reason = static fn (?array $b, string $fallback): string => is_array($b) && is_string($b['error'] ?? null) ? substr($b['error'], 0, 200) : $fallback;
    $code = static fn (?array $b): string => is_array($b) && is_string($b['code'] ?? null) ? $b['code'] : '';
    return [
        'pack' => 'gold_issuer_pack',
        'verify' => static function (array $intent, array $held, array $policy, int $now) use ($domain, $issuerKey) {
            $credential = gold_issuer_unpack($held);
            if ($credential === null) return 'the credential is malformed';
            if (($policy['issuerKey'] ?? null) !== $issuerKey) return 'the policy names another issuer';
            if (($credential['credential'] ?? null) !== 'domain-atlas-asset/1.0') return 'not an asset credential';
            foreach (['id', 'asset', 'owner', 'quantity', 'supersedes', 'issuedAt', 'issuer', 'signature'] as $field) if (!array_key_exists($field, $credential)) return 'the credential has no ' . $field;
            if (!is_string($credential['id']) || $credential['id'] === '' || !is_array($credential['asset']) || !is_array($credential['owner']) || !is_array($credential['issuer'])) return 'the credential is malformed';
            if (($credential['issuer']['domain'] ?? null) !== $domain) return 'the credential was issued by another domain';
            if (($credential['asset']['class'] ?? null) !== $policy['priceClass']) return 'the credential is not of the price class';
            if (($credential['asset']['fungible'] ?? null) !== true || ($credential['asset']['tradeScope'] ?? null) === 'bound') return 'the credential cannot be spent in a sale';
            $quantity = $credential['quantity'];
            if (!is_int($quantity) || $quantity < 1) return 'the credential holds nothing';
            $ownerKey = $credential['owner']['publicKey'] ?? null;
            if (!is_string($ownerKey) || !ledger_valid_owner_key($ownerKey)) return 'the credential has no usable owner key';
            try {
                $signed = ledger_owner_verify(gold_issuer_canonical(gold_issuer_asset_payload($credential)), $issuerKey, $credential['signature']);
            } catch (Throwable $e) {
                return 'the credential cannot be checked';
            }
            if (!$signed) return 'the credential is not signed by the issuer';
            $payload = $intent['payload'] ?? null;
            if (!is_array($payload)) return 'the intent has no payload';
            $fields = array_keys($payload);
            sort($fields);
            if ($fields !== ['coinId', 'credentialId', 'expiresAt', 'price', 'recipient', 'requestId', 'type', 'v']) return 'the intent has the wrong fields';
            if ($payload['type'] !== 'atlas.ledger.purchase.intent' || $payload['v'] !== 1) return 'the intent is not a purchase';
            if (!ledger_owner_verify(ledger_canonical($payload), $ownerKey, $intent['signature'] ?? null)) return 'the intent is not signed by the credential\'s owner';
            if ($payload['credentialId'] !== $credential['id']) return 'the intent names another credential';
            if (!is_int($payload['price'])) return 'the price is not a whole number';
            $expires = is_string($payload['expiresAt']) ? strtotime($payload['expiresAt']) : false;
            return ['requestId' => $payload['requestId'], 'coinId' => $payload['coinId'], 'price' => $payload['price'], 'recipient' => $payload['recipient'],
                'credentialId' => $credential['id'], 'quantity' => $quantity, 'expiresAt' => $expires === false ? 0 : $expires];
        },
        'revoked' => static function (string $id) use ($http, $base, $timeout): bool {
            [$status, $body] = $http('GET', $base . '/.well-known/atlas-revocations.json', null, null, $timeout);
            if ($status !== 200 || !is_array($body) || !is_array($body['revoked'] ?? null)) ledger_fail('busy', 'the issuer\'s revocation list cannot be read');
            foreach ($body['revoked'] as $entry) if (is_array($entry) && ($entry['id'] ?? null) === $id) return true;
            return false;
        },
        'lock' => static function (string $requestId, array $held, array $intent = []) use ($hold, $reason): ?string {
            $credential = gold_issuer_unpack($held);
            if ($credential === null) return 'the credential is malformed';
            [$status, $body] = $hold(['action' => 'reserve', 'requestId' => $requestId, 'credential' => $credential,
                'intent' => ['payload' => $intent['payload'] ?? null, 'proof' => ['signerRole' => 'raw-ecdsa', 'publicKey' => $credential['owner']['publicKey'] ?? null, 'signature' => $intent['signature'] ?? null]]]);
            if ($status === 200 && ($body['ok'] ?? false) === true) return null;
            return $status === 0 ? 'the issuer cannot be reached' : $reason($body, 'the issuer refused to hold the credential');
        },
        'begin' => static function (string $requestId, array $credential) use ($hold, $holdId, $reason, $code): ?string {
            $credential = ['id' => (string) ($credential['id'] ?? '')];
            [$status, $body] = $hold(['action' => 'begin', 'requestId' => $requestId, 'credentialId' => $credential['id'], 'holdId' => $holdId($credential['id'], $requestId)]);
            if ($status === 200 && ($body['ok'] ?? false) === true) return null;
            // A final no from the issuer ends the sale; anything undecided is retried.
            if (in_array($status, [404, 409, 410], true) && $code($body) !== 'busy') return $reason($body, 'the issuer no longer holds the credential');
            ledger_fail('busy', 'the issuer could not be asked to begin delivery');
        },
        'finish' => static function (string $requestId, array $credential, int $price) use ($hold, $holdId): array {
            $credential = ['id' => (string) ($credential['id'] ?? '')];
            [$status, $body] = $hold(['action' => 'finalize', 'requestId' => $requestId, 'credentialId' => $credential['id'], 'holdId' => $holdId($credential['id'], $requestId)]);
            if ($status !== 200 || ($body['ok'] ?? false) !== true || !is_array($body['result'] ?? null)) ledger_fail('busy', 'the issuer could not spend the held credential yet');
            if (($body['result']['price'] ?? null) !== $price) ledger_fail('bad-purchase', 'the issuer spent another price than the sale');
            $remainder = $body['result']['balance']['credential'] ?? null;
            return ['balance' => is_array($remainder) ? gold_issuer_pack($remainder) : null];
        },
        'release' => static function (string $requestId, string $credentialId = '', ?array $closure = null) use ($hold, $holdId): void {
            [$status, $body] = $hold(['action' => 'cancel', 'requestId' => $requestId, 'credentialId' => $credentialId, 'holdId' => $holdId($credentialId, $requestId), 'closure' => $closure]);
            if ($status !== 200) ledger_fail('busy', 'the issuer could not free the hold yet');
        },
        'holding' => static function (string $requestId, array $held, array $intent, int $now) use ($http, $base, $timeout, $domain, $issuerKey): ?string {
            $credential = gold_issuer_unpack($held);
            if ($credential === null) return 'the credential is malformed';
            $owner = $credential['owner']['publicKey'] ?? null;
            $payload = $intent['payload'] ?? null;
            if (!is_string($owner) || !is_array($payload)) return 'the sale has no owner or intent';
            $query = http_build_query(['credentialId' => $credential['id'], 'requestId' => $requestId]);
            [$status, $body] = $http('GET', $base . '/atlas/ledger/gold-hold-status?' . $query, null, null, $timeout);
            if ($status === 404) return 'the issuer holds no Gold for this sale';
            if ($status !== 200 || !is_array($body['attestation'] ?? null)) ledger_fail('busy', 'the issuer\'s hold status cannot be read yet');
            $a = $body['attestation'];
            $p = $a['payload'] ?? null;
            if (!is_array($p) || !is_string($a['signature'] ?? null)) return 'the issuer\'s hold status is malformed';
            try {
                $signed = ledger_owner_verify(gold_issuer_canonical($p), $issuerKey, $a['signature']);
            } catch (Throwable $e) {
                $signed = false;
            }
            if (!$signed) return 'the hold status is not signed by the issuer';
            $digest = hash('sha256', gold_issuer_canonical(['payload' => $payload, 'proof' => ['signerRole' => 'raw-ecdsa', 'publicKey' => $owner, 'signature' => $intent['signature'] ?? null]]));
            $expected = ['type' => 'atlas.gold.hold.status', 'v' => 1, 'issuer' => $domain, 'credentialId' => $credential['id'], 'requestId' => $requestId, 'coinId' => $payload['coinId'] ?? null,
                'price' => $payload['price'] ?? null, 'recipient' => $payload['recipient'] ?? null, 'owner' => $owner, 'intentDigest' => $digest];
            foreach ($expected as $field => $value) if (($p[$field] ?? null) !== $value) return 'the hold is not for this sale (' . $field . ')';
            $at = is_string($p['issuedAt'] ?? null) ? strtotime($p['issuedAt']) : false;
            if ($at === false || abs($now - $at) > 300) return 'the hold status is not recent';
            if (!in_array($p['state'] ?? null, ['delivering', 'finalized'], true)) return 'the issuer does not hold this credential for delivery (' . (is_string($p['state'] ?? null) ? $p['state'] : 'unknown') . ')';
            return null;
        },
    ];
}
