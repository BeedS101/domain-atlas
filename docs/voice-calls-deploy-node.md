# Deploying and testing the Node Call Service on a server

Status: instructions and examples only. **Nothing here has been run on a real server.** The
Call Service, the deployment checker and a stand-in TLS proxy were exercised on Linux over
loopback (`docs/voice-calls-test-plan.md` section 7). The nginx, Caddy, systemd and coturn
examples in `call-server/deploy/` were written and checked only for their key settings; none
was started. Follow these steps only after you have approved a first online deployment. Do not
describe the result as production-ready or banking-grade: the service has had no independent
security review.

Goal of this stage: a Call Service reachable only over https at its own address, that two
wallets on different networks can use to place an authenticated, encrypted call. Audio goes
directly between the browsers (and through your own STUN server for address discovery if you
add one). TURN, so that calls work through strict NATs, is the next stage.

## 1. What you need

- A host with a public address, Node.js 20 or newer, and `root` access. A small VPS is enough.
  A conventional shared PHP hosting plan cannot run this service (it needs a long-running
  process); the PHP service is a later stage.
- A host name for the service, for example `calls.example.org`, with an `A` (and `AAAA`)
  record pointing at the host. It may differ from your domain's name. Wallets use exactly this
  name, and every signed message carries it, so it cannot change afterwards without people
  setting the service up again.
- The domain whose Post Office memberships admit people to receive calls, normally your own
  Domain Atlas domain (for example `example.org`), served over https with its
  `/.well-known/atlas-key.json` and `/.well-known/atlas-revocations.json`.
- Accurate clocks on the host (`timedatectl` shows `System clock synchronized: yes`).
- Your decision on firewall rules (section 6). Nothing in the repository opens a port.

Who needs what: **the person who receives a call** needs a Post Office membership from your
domain and the service address in their wallet. **The caller** needs neither: a caller uses the
callee's service, named in the callee's signed contact card. Two wallets of different domains
can therefore already call each other if the callee's domain runs a Call Service
(`docs/voice-calls-internet.md` section 6).

## 2. Put the program on the host

The service is two files and has no dependencies.

```
sudo mkdir -p /opt/domain-atlas/call-server /etc/atlas-call
sudo cp call-server/server.js call-server/protocol.js call-server/check-deployment.js /opt/domain-atlas/call-server/
node --version        # 20 or newer
```

(Cloning the whole repository works too; only these files are used.) Make `/opt/domain-atlas`
writable by root only.

## 3. Write the settings

Read your domain's public key from your own site (not from anyone else's copy):

```
curl -s https://example.org/.well-known/atlas-key.json
```

Copy the `publicKey` value of every key that is currently valid (up to 8; normally one).
Create `/etc/atlas-call/config.json` from `call-server/deploy/atlas-call.config.json.example`
and fill in:

| Setting | What to put |
|---|---|
| `origin` | `https://calls.example.org`: exactly the address wallets will use. No path, no trailing slash. |
| `domain` | `example.org`: the domain whose memberships are admitted. |
| `issuerKeys` | the `publicKey` value(s) copied above. Pinned: they are never fetched from a request. |
| `revocationsUrl` | `https://example.org/.well-known/atlas-revocations.json` so a revoked membership stops working. If it cannot be read the service refuses to create tags (it fails closed). |
| `stateFile` | `/var/lib/atlas-call/tags.json`. Keep it. Without it every restart forgets all tags and each person must press "Allow calls" again for each contact (from reading the wallet code, not tested). It holds hashes only, mode 0600. |
| `bind`, `port` | leave `127.0.0.1` and `8787`: only the proxy talks to the service. |
| `trustProxy` | `true` when a reverse proxy is in front (it always should be). Then the service reads client addresses from the proxy and requires every request to arrive from it, saying `X-Forwarded-Proto: https`. |
| `proxyAddrs` | addresses the proxy connects from; the default (`127.0.0.1`, `::1`) is right when the proxy is on the same host. |
| `stunUrls` | empty for now; section 9. |
| `inviteCorsOrigins` | empty. Browsers get no cross-origin access. |
| `limits` | the shipped values are listed in section 10; change them only for a reason. |

A wrong or missing setting leaves the service unconfigured and the console says which one. A
service with no configuration answers `503 calls-not-configured` and does nothing.

## 4. Run it under systemd

Copy `call-server/deploy/atlas-call.service.example` to `/etc/systemd/system/atlas-call.service`,
adjust the paths, then:

```
sudo systemctl daemon-reload
sudo systemctl enable --now atlas-call
sudo journalctl -u atlas-call -n 20 --no-pager
curl -s http://127.0.0.1:8787/atlas/call/info
```

The journal should say `configured for https://calls.example.org`, `proxy mode`, and
`listening on 127.0.0.1:8787`. `info` should say `"configured":true`. The unit runs the service
as a throw-away unprivileged user with a private state directory and no write access elsewhere.
`systemd-analyze security atlas-call` shows what is still open.

## 5. Put the reverse proxy and certificate in front

Pick one. Both examples need the host name changed and have not been run.

- **Caddy** (simplest; it obtains and renews the certificate): `call-server/deploy/Caddyfile.example`.
- **nginx**: `call-server/deploy/nginx-atlas-call.conf.example` plus a certificate from
  `certbot`. Test with `sudo nginx -t` before reloading.

What the examples set, and why each matters:

| Setting | Why |
|---|---|
| https only, TLS 1.2 or newer, HSTS | wallets refuse plain http for a real service |
| `proxy_read_timeout 70s` (Caddy: `read_timeout 70s`) | the service holds a listen for 25 s; a shorter proxy timeout cuts every listen with a 504 |
| `proxy_buffering off`, no compression | held responses must pass straight through |
| body cap 20 KiB | the largest signalling message is 20 KiB |
| `X-Forwarded-For $remote_addr` (overwrites) and `X-Forwarded-Proto $scheme` | the service rate-limits by the address it is given, and refuses requests that do not say they were https |
| per-source connection and request limits | a second layer in front of the service's own |
| only `/atlas/call/` is passed on; everything else on the name is 404 | nothing else is exposed |
| no access log | the proxy's default log would record every person's address and call timing, which the service itself never stores |
| nothing served on port 80 for the call routes | wallets use https directly and refuse redirects |

## 6. Firewall (your decision)

Allow inbound TCP 443 (and 80 only if your certificate method needs it) to the proxy. Do **not**
open 8787. Example with `ufw` (run only if you use it, after confirming SSH access):

```
sudo ufw allow 443/tcp
sudo ufw status
```

Check from another computer that `http://<host address>:8787/atlas/call/info` does not answer.

## 7. Check it from outside

From your own computer (not the server), with Node 20 or newer and the two files
`call-server/check-deployment.js` and `call-server/protocol.js`:

```
node call-server/check-deployment.js https://calls.example.org
```

It makes ordinary requests and one signed listen with a throwaway key. It creates no tag, uses
no real identity and leaves nothing behind. Expect `PASS` for each line and
`No failures`. A held listen takes about 25 seconds, which is the point: it proves your proxy
does not cut a long poll. What a `FAIL` means:

| Line | Cause and fix |
|---|---|
| `the service answers` | name, certificate, firewall or the proxy cannot reach `127.0.0.1:8787` |
| `GET /atlas/call/info is the Call Service` with a 5xx status | the service is not running or the proxy points at the wrong port |
| `the service is configured` | `configured:false`; read `journalctl -u atlas-call` for the setting named |
| `the service names exactly this address as its origin` | `origin` differs from the address you typed; wallets would refuse it |
| `the proxy tells the service the request was https` | the proxy does not set `X-Forwarded-Proto https` |
| `a held listen is answered` with 504/502 | the proxy's read timeout is under 30 s, or the proxy lost the service |
| `a request that is not application/json is refused` / `a request from a web page origin is refused` | something other than this service is answering, or it is an old version |
| `plain http on the same host is not served` | the service also answers on port 80/8787 from outside |
| `clock agreement` | synchronize the host or this computer |

The checker does not test audio, STUN, TURN or the membership check. The remaining warnings
(for example a missing HSTS header) are advice, not failures.

## 8. Test with two wallets

Use two computers on **different internet connections** (for example one on home broadband and
one on a phone hotspot), each with Chrome, the extension loaded, and a headset. Both wallets
need identities on domains reachable over https, so use your real domain (or two domains), not
the `localhost` demo domains.

1. On the receiving wallet: claim a Post Office membership at the domain you configured
   (Social, Mail, Join). Check the wallet can already send and receive mail.
2. On both wallets: add the other as a contact, as for mail.
3. On both: Messages, Calls, Open calling window. Under "Call service" type
   `https://calls.example.org`. Leave "Private test network" **off**. Press "Save and check". It
   should say the service admits members of your domain. If it complains about the address or
   about being unconfigured, return to section 7.
4. On both: "Allow calls" for the other person; wait for the cards to arrive (up to a minute);
   both rows show "You can call" and "They can call you". Compare the safety codes over a
   channel you trust and press "The codes match".
5. The receiver presses "Available" and leaves the window open and the wallet unlocked.
6. The caller presses "Call". The receiver answers. Speak both ways, mute, unmute, hang up.
   The microphone indicator should disappear on hang up.
7. Look at the Activity box if a call fails, and at `journalctl -u atlas-call` (it records no
   identities).

Expected outcomes, stated honestly: on many home and fixed-line connections the two browsers
connect directly even without STUN. Behind some home routers, on mobile data (carrier NAT) and
on many corporate networks a direct connection fails and the call ends with a connection
failure. A STUN server (section 9) fixes some of those; the remaining ones need TURN, which is
the next stage. A failed call on a strict network is **not** a security failure; it is the
reason TURN exists. Record for each attempt: both networks' kind, whether direct, whether audio
flowed both ways, and the end reason shown.

Calling a wallet whose owner is in Do not disturb, locked or has no calling window open ends as
"not available"; that is by design.

## 9. Optional: your own STUN server

STUN lets a browser learn its public address and port. It never sees audio. Use a server you
operate; the service refuses well-known public STUN servers in its settings, and nothing in
this project uses a third-party one.

1. On a host with a public IPv4 address (not shared web hosting), install coturn and use
   `call-server/deploy/coturn-stun-only.conf.example`: STUN only, no relay, no credentials.
   Open UDP 3478 inbound and nothing else; consider rate-limiting that port.
2. Put it in `stunUrls`, for example `["stun:stun.example.org:3478"]`, restart the service and
   check `curl -s https://calls.example.org/atlas/call/info` lists it.
3. Repeat the tests of section 8 on the harder network pairs and record whether STUN made the
   difference.

The wallet passes the browser at most three plain `stun:` URLs from the service and nothing
else (no TURN, no credentials). Because a caller uses the callee's service, **the callee's
operator decides which STUN server a caller's browser contacts**; the caller's address is
visible to that server. That is the same trust the caller already places in the callee's
service, and the reason it is your own server and not a third party's.

## 10. What the service limits (and when to change it)

| Setting | Default | Meaning |
|---|---|---|
| `maxConnections` | 3000 | open connections of any kind |
| `maxConnectionsPerSource` | 100 | open sockets per address, when the service is reached directly (not behind a proxy) |
| `maxInflightPerSource` | 60 | requests being served per address, held listens included |
| `maxWaiters` | 2000 | held listens and polls in total |
| `maxWaitersPerSource` | 20 | held listens and polls per address |
| `maxStrangerWaiters` | 500 | of those, how many may belong to wallets that hold no tag (so they cannot crowd out people who can receive calls) |
| `maxListeners` | 5000 | listening mailboxes that wallets without a tag may create |
| `perSourcePerMin` | 600 | requests per address per minute |
| `invitesPerSourcePerMin` | 20 | invitations per address per minute |

Addresses are IPv4 addresses and IPv6 /64 prefixes. Several people behind one shared address
(a household, an office, a mobile carrier's shared address) share these limits: raise
`maxWaitersPerSource` if more than about twenty of your people listen from one address. The
service answers `429 too-many-connections` or `503 busy` with a `Retry-After` header; the
wallet waits and tries again. Each held connection needs a file descriptor; the unit file sets
`LimitNOFILE=8192`.

## 11. Operations

- **Logs:** `journalctl -u atlas-call`. Start-up lines and nothing else; no tag, key, call id or
  address is written.
- **Restart or update:** replace the two files, `sudo systemctl restart atlas-call`. Calls in
  progress end; people see "not available" and try again. Open calling windows keep retrying
  by themselves (and give up after ten minutes of failure).
- **Key rotation of your domain:** add the new key to `issuerKeys` (keep the old one), restart,
  and remove the old key only after memberships signed by it have expired or been re-issued.
- **Check on a schedule:** run `check-deployment.js` after any proxy or certificate change.
- **Turning it off:** `sudo systemctl disable --now atlas-call`. Wallets then show the service
  as unreachable, give up listening after ten minutes and carry on with everything else. A
  person can press "Remove" in the calling window to forget the service.
- **Backups:** the state file only holds tag hashes. Losing it means people press "Allow
  calls" again.

## 12. Not verified yet

- Everything in sections 2 to 9 on a real server: the three example configuration files for the
  proxy and the unit were not started; coturn was not run.
- A call across two real networks, with and without STUN, and the rate of direct connections.
- Behaviour behind a content-delivery network or load balancer in front of the proxy (not
  recommended for this stage; several proxies change which forwarded address is the real one).
- Rate limiting under real load; the figures in section 10 are starting points.
- Everything listed as manual in `docs/voice-calls-phase1b.md` section 3.3.
