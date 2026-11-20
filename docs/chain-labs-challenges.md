# Chain labs: challenges for private holdings

A wallet that asks for its private coins first asks the domain for a challenge (`POST action=challenge`), signs a
`atlas.ledger.holdings.request` over it with its key, and sends that to `action=holdings`. Asking for a challenge needs no signature,
because the wallet does not yet have anything to sign. That makes the request open to anyone, so it must not be able to use up anything
a wallet needs.

## What went wrong

A domain used to write every challenge it issued to the `ledger_challenges` table and refused to issue more once 5,000 were open
(`busy`, HTTP 429). A challenge lives 120 seconds, so about 42 requests per second kept the table full, and every wallet that asked
for its private coins was turned away for as long as the flood lasted. The flood needed no key and no signature.
`test/chain-labs-challenge-http.js` reproduces it against the real endpoint: after the flood the table holds 5,002 rows and a wallet
gets 429.

## What a challenge is now

A challenge is 16 bytes written as 32 hex characters, the same shape as before, so no wallet changes:

| bytes | what |
| --- | --- |
| 4 | the second it was issued, big endian |
| 5 | random |
| 7 | a MAC over both and the domain name |

The MAC is HMAC-SHA-256 under a key derived from the domain's private key (`hash_hmac('sha256', 'atlas.ledger.challenge.key.v1', pem)`),
over `atlas.ledger.challenge.v1`, the domain, the time and the random part, cut to 56 bits. Issuing one is arithmetic: the domain reads
no database and writes nothing, so asking for challenges, at any rate, fills nothing and refuses nobody.

## What a challenge still has to be

Redeeming a challenge in `holdings` still needs everything it needed before, and the order is unchanged:

1. The request names this domain and the key it is about, and has exactly the expected fields.
2. The key's signature over the payload verifies.
3. The challenge is one this domain issued (the MAC verifies for this domain and this domain's key).
4. It is fresh: not older than 120 seconds, and not dated more than 5 seconds ahead of the domain's clock.
5. It has not been used. The first redemption records it, in the same table, in one insert; a second one, however it arrives, fails
   the insert and is refused as `bad-challenge`. Two requests carrying the same signed request at once are answered once.

A request that fails at 1 or 2 does not use the challenge up, as before. A refused challenge is never recorded: only a challenge that
passed 3 and 4, in a request a key signed, is. The signed statement a domain returns, and the wallet's own checks of it (the domain
signature, the key and the domain named, the age of the statement), are untouched.

A record is dropped once the challenge could no longer be accepted (expiry plus 10 seconds), each time one is redeemed. Nothing
accumulates after a burst.

## What an attacker can still do

- **Issue challenges.** Free for them and for the domain. Nothing is stored, and the ones they hold are good for the same 120 seconds
  as anyone's.
- **Redeem challenges with keys of their own.** Every key is a valid wallet key, so an attacker can sign requests for keys they
  generate. Each costs them a request and costs the domain a signature check and one small row that lives about two minutes. It
  stores nothing that blocks a wallet: the table has no cap, so a wallet is never refused because of other people's rows. At
  the speed a PHP host can answer, the table stays in the tens of thousands of rows. A flood of such requests is a request
  flood, and slowing it down belongs where requests are counted (see below).
- **Guess a challenge.** A made-up challenge passes only if its 56 bit MAC is right, about 1 in 7 × 10^16 per request, and each
  guess must also carry a request signed by a key. It would let them redeem a challenge the domain never issued once, which changes
  nothing a signed request could not already do.
- **Replay a captured request.** The challenge is single use and the request names the domain, so a captured request is answered
  once at most; HTTPS keeps it from being captured on the way. Private holdings are shown only to the key that signed.

## Rate limiting

The domain does not count requests per client. On shared hosting and behind a reverse proxy, PHP sees the proxy's address, and a
forwarded-for header is whatever the client writes, so a limit keyed on either would either throttle every wallet behind one proxy
or be avoided by changing a header. A limit that is only correct with a configured list of trusted proxies is also a setting a
domain operator can get wrong in a way that blocks real wallets, which is the failure being fixed. So the domain relies on the
challenge costing nothing to issue and nothing to hold, and leaves a request-per-second limit to the web server, the proxy or the host,
which can see the real client address (for example `limit_req` in nginx or a rule in the host's firewall). Nothing in the ledger
depends on that limit being set.

## The answer

The challenge also serves as the nonce of the lookup: the domain signs it into the statement it returns, and the wallet accepts only a
statement that carries the nonce it sent (`docs/chain-labs-holdings-binding.md`).

## Upgrading

No wallet, key, table or request format changes. The old table is used as it is, only for redeemed challenges. A challenge a wallet
was given by the old code a moment before the upgrade does not verify, and that one lookup is refused as `bad-challenge`; the wallet
asks again for a new one.

## Checks

```
php test/chain-labs-spend.php           # challenges: nothing written when issued, expiry, a changed digit, another domain or key, replay, over connections, dropped records
node test/chain-labs-challenge-http.js  # the flood against the endpoint, wallets during and after it, replay, parallel requests, a transfer afterwards
node test/chain-labs-spend-http.js      # the endpoint as before
```
