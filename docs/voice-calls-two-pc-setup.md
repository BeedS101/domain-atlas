# Calling between two Windows PCs: local test setup

Status: instructions only. Nothing here has been run on Windows by the author of this
document. The Call Service and the demo domains were run on Linux (Node 22, Chromium
under Xvfb, loopback only). Where this guide depends on an untested Windows behavior it
says so. Following it makes no change to either live domain and exposes nothing to the
internet.

Goal: two Domain Atlas wallets, one in Chrome on each of two PCs, place a call to each
other and exchange audio, with each side seeing the other's identity verified.

## 1. What you need

- Two Windows PCs on the same local network (same router; not a guest Wi-Fi with client
  isolation), each with a microphone and headphones. Headphones avoid speaker-to-
  microphone echo, which this phase does not address.
- Google Chrome on both. The extension is loaded unpacked (Chrome menu, Extensions,
  Manage extensions, Developer mode, Load unpacked, choose the repository's `extension`
  folder).
- Node.js 20 or newer on PC A (the author's runs used Node 22).
- The repository checked out on PC A (`C:\domain_atlas\domain-atlas`).
- Permission to add a Windows Firewall rule on PC A. The software never opens a port
  itself; allowing the ports below is your decision (section 6).

Call these PC A (runs the local services) and PC B (only the browser).

## 2. Topology

```
PC A                                   PC B
Chrome + wallet 1                      Chrome + wallet 2
local Domain B   :8002  <------------  portproxy 127.0.0.1:8002 -> PC A :8002
local Domain A   :8001  <------------  portproxy 127.0.0.1:8001 -> PC A :8001
Call Service     :8787  <------------  wallet 2 uses http://<PC A address>:8787
audio: direct WebRTC between the two browsers (no relay, no TURN)
```

The wallet turns the name `localhost:8002` into `http://localhost:8002`, and refuses
plain http for any other host. Both wallets must therefore reach the demo Post Office
under the same name `localhost:8002`. On PC B that name is forwarded to PC A with a
Windows port proxy (section 5). The Call Service is reached by its private LAN address,
which the "Private test network" box in the calling window allows over plain http.

An alternative that avoids port proxies is an existing Post Office that already serves
https. That is your decision; it changes nothing in this repository, but it means
choosing which domain's members may create call tags and copying that domain's public key
(from its `/.well-known/atlas-key.json`) into `CALL_ISSUER_KEYS`. This guide covers the
local demo domains only.

## 3. Start the local services on PC A

Use three PowerShell windows in the repository folder. Replace `192.168.1.20` with PC A's
LAN address (`ipconfig`, the IPv4 address of the adapter on your network).

Domain A (so that the world pages load):

```powershell
$env:PORT="8001"; $env:ATLAS_DOMAIN="localhost:8001"; node issuer-server\server.js
```

Domain B, the demo Post Office:

```powershell
$env:PORT="8002"; $env:ATLAS_DOMAIN="localhost:8002"; $env:ATLAS_DOCROOT="demo-domain-b"; $env:ATLAS_STATE_DIR="issuer-server\domain-b-state"; node issuer-server\server.js
```

Check that Domain B works and read its public key:

```powershell
curl.exe http://localhost:8002/.well-known/atlas-key.json
```

Copy the `publicKey` value. Then the Call Service:

```powershell
$env:CALL_ORIGIN="http://192.168.1.20:8787"
$env:CALL_DOMAIN="localhost:8002"
$env:CALL_ISSUER_KEYS="<publicKey from the previous step>"
$env:CALL_BIND="0.0.0.0"
$env:CALL_DEV_ALLOW_HTTP="1"
$env:CALL_REVOCATIONS_URL="http://localhost:8002/.well-known/atlas-revocations.json"
$env:CALL_DEV_ALLOW_PRIVATE_FETCH="1"
node call-server\server.js
```

Optional: `$env:CALL_STATE_FILE="C:\domain_atlas\call-state.json"` keeps tags across a
restart; `$env:CALL_STUN_URLS="stun:stun.example.org:3478"` only if you choose a STUN
server (section 9). Leaving STUN empty keeps connection attempts to local addresses.

If calling is not configured the console says which setting is wrong. `CALL_ORIGIN` must
be exactly the address wallets will use, with no path and no trailing slash, because every
signed message names it as its audience.

`CALL_BIND=0.0.0.0` listens on every adapter of PC A; without a firewall rule other
machines still cannot reach it. Use PC A's LAN address instead if you want it narrower.

## 4. Load the extension and create identities

On both PCs: load the unpacked extension, open the Domain Atlas side panel, and create a
wallet identity. Each PC has its own wallet.

## 5. Make `localhost:8002` mean PC A, on PC B

Only for PC B. In an administrator PowerShell on PC B:

```powershell
netsh interface portproxy add v4tov4 listenaddress=127.0.0.1 listenport=8002 connectaddress=192.168.1.20 connectport=8002
netsh interface portproxy add v4tov4 listenaddress=127.0.0.1 listenport=8001 connectaddress=192.168.1.20 connectport=8001
netsh interface portproxy show v4tov4
```

Remove them when finished:

```powershell
netsh interface portproxy delete v4tov4 listenaddress=127.0.0.1 listenport=8002
netsh interface portproxy delete v4tov4 listenaddress=127.0.0.1 listenport=8001
```

Stop anything already using port 8001 or 8002 on PC B first. Chrome may try `localhost`
as `::1` before `127.0.0.1`; if the page does not load, test the proxy with
`http://127.0.0.1:8002/.well-known/atlas-key.json` in the address bar. This portproxy
approach has not been exercised on Windows by the author.

## 6. Allow the ports on PC A (your decision)

PC B can only reach PC A if Windows Firewall on PC A admits TCP 8001, 8002 and 8787 from
your local network. Create the rule yourself, scoped to the local subnet and the Private
profile, for example in an administrator PowerShell:

```powershell
New-NetFirewallRule -DisplayName "Domain Atlas local test" -Direction Inbound -Protocol TCP -LocalPort 8001,8002,8787 -RemoteAddress LocalSubnet -Profile Private -Action Allow
```

Remove it afterwards: `Remove-NetFirewallRule -DisplayName "Domain Atlas local test"`.
Nothing in this repository creates or changes a firewall rule.

Audio does not use these ports. Chrome opens its own UDP ports directly between the two
PCs. Windows may show a Defender Firewall prompt for `chrome.exe` the first time; allow it
on the Private network only. If you decline, signaling works but the audio connection
fails and the call ends.

## 7. Join the Post Office and become contacts

On each PC, with the side panel on a Domain B world (the Neighbor Workshop, served from
`http://localhost:8002`), claim the Post Office membership (the Post Office stall, or
Social, Mail, Join). Both wallets need this membership, both to exchange contact cards and
to create call tags.

Then on each wallet:

1. Add the other wallet as a contact in Messages (paste the other's public key, the same
   way mail is exchanged today).
2. Messages, Calls tab, "Open calling window". It opens as a small Chrome window.
3. Under "Call service" type the Call Service address (`http://192.168.1.20:8787`), tick
   "Private test network", and press "Save and check". The note under it should read that
   the service admits members of `localhost:8002`'s Post Office.
4. Under "Contacts" press "Allow calls" for the other person. Each side sends a signed
   contact card to the other. The row shows "You can call" and "They can call you" once
   both cards have arrived (the Post Office delivers on its normal check interval, so this
   can take up to a minute).
5. Press "Verify" on the contact. Both people read the code to each other over a channel
   you already trust (a phone call you place yourself, or in person). If the codes are
   identical, press "The codes match". Until then the call window marks that contact as
   not verified.

A call to a contact whose code you have not compared still works, but is shown as
unverified. That is intentional.

## 8. Place a call

1. On PC B press "Available" (the window must stay open and the wallet unlocked).
2. On PC A press "Call" next to the contact.
3. PC B shows the incoming call with the caller's verified or unverified label. Press
   "Answer".
4. Chrome may ask for microphone permission. Allow it. This prompt inside the extension
   window has not been exercised by the automated tests; whether it appears, and how, is
   one of the real-hardware checks in the Phase 1B results document.
5. Speak. Try Mute and Unmute, then Hang up. Chrome's microphone indicator should go away
   after hang up.

## 9. Connectivity limitations

- Same local network only. There is no TURN relay in this phase, and STUN is off unless you
  set `CALL_STUN_URLS`. Without it the browsers can only connect over addresses each can
  reach on the local network.
- Different networks, mobile data, symmetric NAT, carrier-grade NAT and many corporate or
  guest networks will fail. Supporting them needs a TURN relay, which is deliberately not
  part of this phase.
- Chrome hides local addresses behind random `.local` names (mDNS). If your network blocks
  multicast DNS the browsers may be unable to find each other even on one network. The call
  then ends with a connection failure, and microphone audio is not sent.
- The signaling service is plain http in this setup. Signed messages carry no audio, but
  anyone on that network can see which routing tags are in use and when calls happen.
  Use it only on a network you control. A real deployment needs https in front of the
  Call Service.
- A VPN client, a virtual network adapter, or a "Public" network profile commonly blocks or
  hides the right address. Disable the VPN or switch to a Private profile for the test.
- If another application holds the microphone exclusively, the call ends because the
  microphone cannot be started.

## 10. Troubleshooting

- "The call service is not configured.": the service has no valid `CALL_*` settings; read
  its PowerShell window.
- Saving the service address fails with "That call service is running but not configured
  yet." or "...identifies itself as <address>, not the address you typed.": the service's
  `CALL_ORIGIN` must equal the address typed in the window exactly.
- Pressing Available shows "Could not start listening: ...": the wallet has no Post Office
  membership from `CALL_DOMAIN`, or the service could not read the revocation list (it
  fails closed).
- "You do not have permission to call this contact.": their contact card has not arrived,
  or they pressed "Stop allowing".
- "Not available right now.": the other wallet is in Do not disturb, is locked, or has no
  calling window open. There is no background listening in this phase.
- "Your computer's clock is out of step with the call service.": synchronize the Windows
  clock on both PCs (they must agree within about 30 seconds).
- "Cannot reach the call service. Still trying…": firewall, wrong address, or the service
  is not running.
- The Activity box at the bottom of the window lists the steps of each call.

## 11. Cleanup

When the test is over, put the computer and the wallet back to normal:

1. In each calling window press "Do not disturb", then under "Call service" press "Remove".
   This forgets the service address, switches "Private test network" off, and removes the
   cards and permissions that name a plain-http address. Contacts, safety-code
   verification, mail and assets are not touched. Then close the calling window (this hangs
   up and releases the microphone).
2. Stop the three Node windows with Ctrl+C.
3. On PC A remove the firewall rule (section 6); on PC B remove the port proxies (section 5).
   A port proxy left behind keeps sending `localhost:8001` and `localhost:8002` to a
   computer that may no longer be there, so anything in the wallet that still points at the
   demo Post Office will wait for it to answer.
4. The wallet keeps its demo Post Office membership at `localhost:8002`. That is harmless
   when the demo server is gone: the wallet gives up on a domain that does not answer after
   30 seconds, then skips it for a while, so it cannot hold up mail, assets or login.

The Call Service keeps only hashes of routing tags, and only in the state file if you named
one.
