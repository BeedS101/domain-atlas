# Running your own TURN server for wallet calls

Status: instructions, an example configuration, a probe tool and automated tests against a
**simulated** TURN server. **coturn has not been run for this project**, and no wallet has used a
real coturn server. The sections "How this was tested" and "Not verified yet" at the end say
exactly what that means. Do not describe the result as production-ready or banking-grade: nothing
here has had an independent security review.

## 1. What TURN is for, and what it costs you

Most calls connect directly between the two browsers, with a STUN server's help to learn public
addresses (`docs/voice-calls-deploy-node.md` section 9). When both people are behind strict NATs
or firewalls, or the network blocks UDP, no direct path exists. A TURN server then forwards the
encrypted packets between them.

- **It cannot read the call.** Audio is DTLS-SRTP between the two browsers. The DTLS
  fingerprints are signed by the wallets' identity keys and checked before any microphone audio
  is sent, exactly as for a direct call. A TURN server sees both wallets' network addresses, when
  packets flow and how many. It cannot substitute itself, because a different certificate fails
  the signed-fingerprint check and the call ends.
- **It costs bandwidth.** A relayed call passes both directions through your server: roughly
  0.1 Mbit/s each way per call (`docs/voice-calls-deployment.md` section 3 gives the estimate).
- **It is a second service to protect.** A relay is an open door to the network unless it is
  told where it may not go. Sections 4 and 8 cover that.
- **It is the callee's operator's server.** A caller uses the callee's Call Service, so the
  TURN server a caller's browser contacts is the one the callee's operator named. The caller's
  address is visible to it, the same trust the caller already places in the callee's service.

The Call Service stays the only party that decides who gets a relay: it hands a TURN credential
only to the two wallets of an accepted call (section 3).

## 2. What you need

- A separate host with a public IPv4 address that runs nothing else, with `root` access. It must
  not be shared hosting. It can be the same machine as the Call Service for a first trial, but a
  relay can send UDP to any address it is not told to refuse, including other services on the
  same machine's public address; keep the two apart in anything beyond a trial.
- A host name for it, for example `turn.example.org`, pointing at that address.
- For `turns:` (TURN over TLS): a certificate for that name.
- coturn from your distribution (`apt install coturn` on Debian and Ubuntu). Version 4.5 or newer.
- The Call Service from `docs/voice-calls-deploy-node.md`, already working.
- Accurate clocks on both machines. The expiry in a credential is a clock time; if the two clocks
  differ by more than a minute or so, credentials fail or last too long.

## 3. How credentials are issued

The Call Service and coturn share one secret. Neither a wallet nor anyone else ever holds it.

1. A call is placed and the callee accepts (signed by the callee's identity key).
2. Each side's wallet asks the service's `ice` route for its ICE servers. The request is signed
   with that call's own key, so only the two parties of that call can ask, and only once the
   call is past ringing. A call that is ringing, declined, cancelled or over gets nothing.
3. The service answers with the operator's STUN URLs, the TURN URLs and a credential:
   `username = <unix expiry>:<random label>`, `credential = base64(HMAC-SHA1(secret, username))`.
   The label is random. It holds no identity, call id, key or domain. The two sides get
   different credentials.
4. The lifetime is `CALL_TURN_TTL_SECONDS` (default 3600), never longer than the call's remaining
   permitted length, and no credential is issued with under 30 seconds left. Each side may ask
   up to three times per call; more is answered `429`.
5. The wallet checks the answer before the browser sees it (section 8), hands the credential to
   the browser's connection and keeps it nowhere else: not in storage, not in the call record,
   not in any log. The next call asks again.
6. coturn recomputes the HMAC from the shared secret, checks the expiry in the user name and,
   if both are right, allows the request. coturn needs no user database.

### Call length

The browser keeps the credential it started the call with. coturn asks for authentication again
on every Refresh, and the browser refreshes its relay allocation before it expires (against the simulated
server's 120-second test lifetime it did so after about a minute; the interval with coturn's
defaults was not measured). Once the credential has expired, the next Refresh is
refused and the relayed path ends, so **a relayed call lasts about as long as the credential,
plus up to one refresh interval**. This was observed against the simulated server
(`test/manual-call-turn-longcall.js`); whether coturn refuses an expired credential on Refresh
the same way is for you to check (section 7). Calls that connect directly are not affected.

`CALL_TURN_TTL_SECONDS` therefore trades two things: a longer value lets long relayed calls
continue, a shorter value shortens the time a leaked credential could be used. The default of
one hour suits ordinary calls; the maximum is 24 hours, and a credential never outlives the
service's four-hour maximum for one call.

## 4. Set up coturn

1. Make the shared secret once, on the TURN host:

   ```
   openssl rand -hex 32
   ```

2. Copy `call-server/deploy/coturn-turn.conf.example` to `/etc/turnserver.conf` (check where your
   package reads it) and change at least: `static-auth-secret` (the value above), `realm`, the
   certificate paths, `external-ip` if the host's public address is not on its own interface,
   and `min-port`/`max-port` if you want a different range. The file is commented line by line.
3. Make the file readable only by root and coturn's user:

   ```
   sudo chown root:turnserver /etc/turnserver.conf
   sudo chmod 640 /etc/turnserver.conf
   ```

   coturn has no setting to read the secret from a separate file, so this file holds it.
4. Start it and read the log:

   ```
   sudo systemctl enable --now coturn
   sudo journalctl -u coturn -n 30 --no-pager
   sudo tail /var/log/turnserver/turn.log
   ```

What the example sets, and the abuse it prevents:

| Setting | Why |
|---|---|
| `use-auth-secret`, no static users | only the Call Service can produce a credential; nothing else logs in |
| expiry in the user name, `stale-nonce`, `max-allocate-lifetime` | a leaked credential stops working; allocations cannot be kept alive past the limit |
| `denied-peer-ip` for loopback, private, link-local, shared, documentation, multicast and reserved ranges, `no-loopback-peers`, `no-multicast-peers` | the relay cannot be used to reach the TURN host itself, your internal network or a cloud metadata address |
| `no-tcp-relay` | only UDP relays, which is all audio needs; no TCP connections made on a caller's behalf |
| `user-quota`, `total-quota`, `max-bps`, `bps-capacity` | one credential cannot take many allocations or much bandwidth |
| `min-port`/`max-port` | the firewall opens one known range |
| `no-cli` | no administration console |
| `no-tlsv1`, `no-tlsv1_1`, `no-dtls` | TLS 1.2 and newer only; no unused listener |
| `fingerprint`, `no-software-attribute` | standard framing; no version banner |

Keep the log short-lived. coturn writes user names (an expiry and a random label, no identity) and
the network addresses of both sides to it; delete or rotate it after a few days unless you need
it to investigate abuse.

### Ports and the firewall (your decision)

Nothing in the repository opens a port. Allow inbound:

| Port | Use |
|---|---|
| UDP and TCP 3478 | TURN (the wallet accepts 80, 443, 3478 and 5349 only) |
| TCP 5349 | TURN over TLS (`turns:`) |
| UDP `min-port` to `max-port` | relay ports |

Networks that allow only web traffic usually pass TCP 443. To offer TURN on 443, give coturn its
own address (a second IP or its own host) and set `tls-listening-port=443` and `listening-ip` to
it. Do not try to share 443 with the Call Service's reverse proxy on one address unless you know
how to multiplex them.

Wallets use the TURN server through the browser's ordinary network stack. For TCP and TLS,
Chromium honours the browser's proxy settings; in tests a browser configured with an HTTP proxy
sent its TURN connections through it, and they failed where the proxy refused the address.

## 5. Tell the Call Service

Add the URLs to `/etc/atlas-call/config.json`:

```
"turnUrls": ["turn:turn.example.org:3478", "turn:turn.example.org:3478?transport=tcp", "turns:turn.example.org:5349?transport=tcp"],
"turnTtlSeconds": 3600
```

The secret goes in a file only root can read, and reaches the service as a systemd credential, so
it is never in `config.json`, the unit file or the environment:

```
sudo install -m 600 /dev/null /etc/atlas-call/turn-secret
echo -n '<the same value as static-auth-secret>' | sudo tee /etc/atlas-call/turn-secret >/dev/null
```

Then uncomment the two `turn-secret` lines in the unit (`call-server/deploy/atlas-call.service.example`),
`sudo systemctl daemon-reload && sudo systemctl restart atlas-call` and check:

```
sudo journalctl -u atlas-call -n 10 --no-pager     # a "TURN:" line naming the URLs; never the secret
curl -s https://calls.example.org/atlas/call/info  # "turn": true and the URLs
```

The service refuses to start TURN, and says which setting is wrong, when: URLs are given without
a secret or the reverse; the secret is under 32 or over 256 characters, has spaces or is
repetitive; the secret file can be read by group or others; a URL names a private or loopback
address, a port other than 80, 443, 3478 or 5349, a STUN scheme, or a well-known public
third-party service; more than four URLs are listed; the lifetime is under 60 seconds or over a day.
`CALL_TURN_URLS`, `CALL_TURN_SECRET`, `CALL_TURN_SECRET_FILE` and `CALL_TURN_TTL_SECONDS` are the
environment-variable forms. The Call Service's `info` answer names the TURN URLs and never the
secret or a credential.

With no TURN settings the service behaves as before: it offers no TURN and issues no credential.

## 6. Check coturn with the probe

`call-server/turn-probe.js` talks to your coturn the way a wallet's browser would, using a
credential it makes from the shared secret. Run it from any computer with Node.js 20 or newer
that can reach the server, never from inside a wallet:

```
CALL_TURN_SECRET=$(sudo cat /etc/atlas-call/turn-secret) node call-server/turn-probe.js turn:turn.example.org:3478
node call-server/turn-probe.js 'turn:turn.example.org:3478?transport=tcp' --secret-file ./turn-secret
node call-server/turn-probe.js turns:turn.example.org:5349 --secret-file ./turn-secret --ca ./ca.pem
```

It prints one line per check and exits 0 with no failures, 1 when a check failed, 2 when it
could not run. It never prints the secret. It checks that:

1. a valid credential gets a relay;
2. a credential made with a different secret, an expired one, a user name without an expiry and
   an empty password are all refused;
3. a TCP relay request is refused (`no-tcp-relay`);
4. permission for 127.0.0.1, 127.8.8.8, 10.0.0.1, 172.16.0.1, 192.168.1.1, 169.254.169.254,
   100.64.0.1, 0.0.0.0 and an IPv6 peer is refused;
5. permission for an ordinary public address is granted, so the refusals above are specific
   rather than a server refusing everything;
6. data sent through one relay reaches another (fails when the relay port range is blocked or
   `external-ip` is wrong);
7. the allocation can be released.

A `WARN` line is a result the probe cannot judge, for example a quota that stopped the second
allocation. Read each one. A server that fails check 4 or 3 can be used to reach your internal
network: do not point the Call Service at it until that is fixed.

The probe does not test the Refresh behaviour in section 3, audio quality, load, or whether the
relay port range is reachable from the internet beyond the machine you ran it on. Run it from a
computer outside your network, and once more after any coturn change.

To see Refresh behave: set `CALL_TURN_TTL_SECONDS=60` temporarily, place a relayed call between two
wallets on networks that cannot connect directly, and note when it drops.

## 7. Test with two wallets

A call between two computers on one network connects directly and never touches TURN. To confirm a
relayed call you need two wallets that cannot reach each other directly: two different home or
mobile networks (a phone hotspot is often enough), or a firewall rule that blocks UDP between the
two computers.

1. Run the tests of `docs/voice-calls-deploy-node.md` section 8 first. They must already work
   without TURN.
2. Open `chrome://webrtc-internals` in a tab of the browser before the call begins. It lists the
   selected candidate pair; a relayed call shows a local or remote candidate of type `relay`.
3. Place the call. In coturn's log you should see two allocations (one per wallet) for the
   duration of the call and none afterwards.
4. Hang up, then check that the log shows both allocations ended.
5. Record, per network pair, whether the call was direct or relayed and whether audio
   flowed. Do not conclude from one pair that "TURN works".

With coturn stopped, calls that can connect directly must still work, and calls that cannot must
end as not connected. That is how the wallets are meant to behave and what the automated tests
check against the simulated server; check it against yours.

## 8. What the wallet and service refuse

The same code (`call-server/protocol.js`, with an identical copy used by the wallet) checks the
operator's settings and everything a wallet receives.

| Protection | Where |
|---|---|
| Only `stun:`, `turn:` and `turns:` URLs of an exact shape; no user info, path, fragment or odd transport | service settings and wallet |
| Private, loopback, link-local, shared-address, multicast and reserved addresses, local-only names and IPv4 written as a number or in hexadecimal are refused as TURN or STUN hosts | service settings and wallet |
| TURN only on ports 80, 443, 3478 and 5349 | service settings and wallet |
| At most three STUN URLs and four TURN URLs, from one TURN server; a second TURN server's credential is dropped | wallet |
| A TURN entry needs a user name and credential in exactly the form coturn's scheme uses, and an expiry from the service's own clock at least 15 seconds away and not more than 25 hours | wallet |
| Fields other than `urls`, `username` and `credential` are dropped | wallet |
| Nothing resolves a host name to check its address. A name that resolves to a private address cannot be told from any other | not covered; coturn's `denied-peer-ip` is the protection |
| The credential is never written to storage, the call record, history or any log; the log notes only counts, whether TURN was offered and reasons for dropping | wallet |

The private-address rule is relaxed only when the wallet's "private test network" setting is on
(the same switch that allows plain `http` for a local trial). With it off, a Call Service
cannot point a wallet's browser at a machine on the wallet's own network.

## 9. How this was tested

| Layer | What ran | What it shows |
|---|---|---|
| Shared checks, service, wallet logic | Node tests: `manual-call-ice-validation.js`, `manual-call-turn-service.js` | real code; the credential is checked against an independently computed HMAC |
| coturn stand-in | `manual-call-turn-probe.js` | the probe passes a server that enforces the rules and fails one that does not. **Simulated server** |
| Two Chromium wallets | `manual-call-turn.js` | relay-only calls over UDP, TCP and TLS, direct preferred when available, TURN down, credentials the server refuses. Real Chromium TURN client and DTLS-SRTP; **simulated TURN server** |
| Expiry during a call | `manual-call-turn-longcall.js` (about two minutes; not in the default run) | **simulated TURN server** |
| Your coturn | `TURN_URL=... TURN_SECRET=... xvfb-run -a node test/manual-call-turn.js` repeats one relayed call against it. Needs `TURN_URL` reachable from the machine running the test | **real coturn**, only if you run it |

The simulated server (`test/turn-fixture-lib.js`) was written by the same author as the probe and
the wallet logic. Where they agree, that shows they agree with each other and with the parts of
RFC 8656 and RFC 5389 the author implemented; it does not show that coturn agrees.

## 10. Operations

- **Rotate the secret:** coturn accepts more than one `static-auth-secret` line (from its
  documentation; not tried here). Add the new one, restart coturn, update the Call Service's
  file and restart it, then remove the old line and restart coturn again. Credentials already
  issued under the old secret keep working until they expire only while the old line is present.
- **If a credential leaks:** it works until its expiry, within the quotas. To end it now, rotate
  the secret. Its label holds nothing about who it was issued to.
- **If the TURN host is compromised:** the attacker sees the shared secret and the addresses of
  recent callers. Rotate the secret and rebuild the host. Audio remains unreadable to them.
- **Turning TURN off:** remove `turnUrls` and restart the Call Service. Wallets then get no TURN
  entry; calls that cannot connect directly fail.
- **Watch:** coturn's allocation count and bandwidth during the first weeks; the figures in the
  example (`user-quota`, `total-quota`, `max-bps`) are starting points, not measured values.

## 11. Not verified yet

- coturn itself: `coturn-turn.conf.example` was written from coturn's documentation and never
  started. Option names and behaviour may differ between versions. Run `turnserver -c` and read
  the log, then the probe.
- Whether coturn refuses an expired credential on Refresh and on CreatePermission, as the simulated
  server does and section 3 assumes.
- TLS and port 443 against a real certificate. The automated TLS call used a self-signed
  certificate with certificate errors ignored in the test browsers.
- A relayed call between two real networks, NAT behaviour, UDP-blocking firewalls and the
  proportion of calls that need a relay.
- The relay-to-relay hairpin on a host behind 1:1 NAT (the probe's check 6 covers it on your host).
- Audio quality, latency and bandwidth through a relay; any load or abuse testing.
- Whether `denied-peer-ip` as written blocks everything intended on your host, and any service on
  the TURN host's own public address that a relay could still reach.
- The PHP Call Service (not built yet) and anything outside Chromium.
