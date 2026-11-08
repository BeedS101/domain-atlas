# Protocol limitations seen by the verifier

Status: documented, not changed. The credential format `domain-atlas-asset/1.0` is as the issuers produce it. This note
records what the signature covers, what it does not, what that allows, and how the verifier compensates today. The
behaviour is pinned by `node test/verifier-protocol-limits.js`; a future format change has to update those checks on
purpose.

## What is signed

The signature is a raw 64-byte P-256 signature over the canonical JSON of exactly six fields:

```
{ id, asset, owner, quantity, supersedes, issuedAt }
```

These fields are not signed:

| Field | Role | Consequence |
|---|---|---|
| `credential` (type label, e.g. `domain-atlas-asset/1.0`) | tells a reader how to interpret the credential | can be changed without invalidating the signature |
| `issuer.domain` | names where to look for the key and the revocation and suspension lists | can be changed without invalidating the signature |
| `issuer.publicKey` | names the key that signed | cannot usefully be changed: the verifier requires it to be published by the issuer and to verify the signature |

## Consequences

1. **A credential is portable between issuers that share a key.** If two domains publish the same issuer key (a staging
   copy, a restored backup, a mirror, a migrated site), a credential issued by the first verifies at the second after only
   `issuer.domain` is edited. Each domain has its own revocation and suspension lists, so revoking at one does not revoke
   the relabelled copy at the other. The test shows both effects.
2. **The type label is advisory.** A different label does not break the signature. The verifier accepts only
   `domain-atlas-asset/1.0` and answers `unsupported` for anything else, so a relabelled credential is never read as a
   different type. A future format that reuses the same six fields under a new label would have signatures valid under both
   labels. Until the label or a format version is signed, no verifier should treat the label as an authenticated statement.
3. **The signed `id` is the only stable identity.** Revocation and suspension lists are keyed by `id`, per issuer domain.

## What the verifier does about it

The issuer is bound to the verifier's configuration, never to the credential:

- A credential is only checked against an issuer listed in `config.php`, chosen by `issuer.domain`; nothing in the
  credential adds an issuer or a URL.
- The key must be published by that same domain, and valid at `issuedAt`.
- `pinnedKeys` restricts a domain to named keys. With a pin, a domain that publishes a clone of another issuer's key
  is refused (`key-not-pinned`).
- A verifier that lists only domain A refuses a relabelled copy for domain B (`untrusted-issuer`).

## Operator guidance

- Never let two live domains share an issuer private key. Staging and restored copies should be given their own key
  (the issuer generates one on first use) or must not be reachable with real credentials.
- When a site is migrated to a new domain, treat the old domain's credentials as a separate set: either retire the old
  domain's lists deliberately or revoke at both.
- Pin keys for any issuer whose key is known in advance. A wizard-installed verifier should write the pin when it also
  configured the issuer.
- Do not rely on `issuer.domain` or the type label for anything a verifier decides outside `config.php`.

## Not changed here, and why

Signing the issuer domain and the type label would close this, but it changes the signed payload, so every existing
credential, the browser wallet, both issuers and any outside verifier would need to move together, and credentials already
in circulation would have to be re-signed or accepted under the old rule. That is a format revision (a new version string
and a documented transition), not a patch. Options for that later decision, none implemented:

1. A new version, `domain-atlas-asset/1.1`, whose signed payload also includes the type string and the issuer domain.
   Verifiers accept 1.0 for a transition period with the pinning mitigations above.
2. Keep 1.0 and add a separate signed envelope around it for new uses.
3. Bind the domain through the key document instead, by publishing the domain inside `atlas-key.json` and requiring a
   match. That does not stop a cloned key and its document from being served by a second domain.

Possession is also out of scope: the credential names an `owner` key, but the verifier does not ask the presenter to prove
it holds that key. A copied credential verifies exactly like the original.
