# Asset Studio storage isolation (design baseline)

**Status:** Layout specification only. The current Studio does not save uploads or mint credentials.

## Two independent storage concerns

1. **Curated templates**: `asset-studio-library/` in this repository. Read-only at runtime, reviewed/versioned, never accepts arbitrary HTTP writes.
2. **User-created content**: a distinct, private directory on each PHP host **outside** the document root, with separate filesystem permissions and backup policy.

Example *host* layout (adjust for cPanel account configuration):

```text
/home/ACCOUNT/
  atlas-studio-data/          # PRIVATE: must not be directly web-served
    drafts/
    uploads-quarantine/
    mint-receipts/
    tmp/
  public_html/
    atlas/studio/             # public application, code only
    atlas/studio-public/      # approved, immutable published resources only
```

Never rely on a deny-rule in `public_html` as the primary boundary for drafts, uploads or receipts.

## Planned configuration

A server-side Studio-only environment/config setting, e.g. `ATLAS_STUDIO_STORAGE_ROOT`, resolves to an absolute path. Before enabling writes, installer must check:
- root is outside `DOCUMENT_ROOT` after resolving symlinks;
- root is writable by the intended PHP account, not publicly listed or reachable by HTTP;
- no paths are assembled from user-supplied filenames or URLs;
- files are keyed by unpredictable IDs; atomic creation; size/count limits and quotas;
- quarantine and inspect uploads before publishing; no active HTML/SVG/script content served as trusted origin content;
- approved published GLB/texture resources use immutable generated names, explicit MIME types and restrictive content policies;
- separate cleanup, retention and backup policies for drafts and signed mint receipts.

The Studio storage root is **not** the issuer store. Existing `issuer-php/lib/` state, signing keys, revocation lists, holdings and journals remain owned by the established issuer service and must not be moved into this directory.

## Rollout boundary

First test storage checks on a non-production host or isolated site configuration. Never auto-create the private directory inside the web root as a fallback. Keep mint and upload endpoints disabled until tests and security review pass. Publishing a model must not imply authorization to mint or grant asset capabilities.
