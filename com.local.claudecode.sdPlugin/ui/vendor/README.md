# Vendored third-party files

The Property Inspectors load these files from disk, so they work offline and never fetch anything remote.
Elgato recommends a local copy of sdpi-components over the hosted URL.

| File | Source | Version | SHA-256 | Fetched |
|---|---|---|---|---|
| `sdpi-components.js` | https://sdpi-components.dev/releases/v4/sdpi-components.js | 4.0.1 (file header: `sdpi-components v4.0.1`; server `last-modified: Wed, 21 May 2025 14:48:20 GMT`, `etag: "682de7b4-da0f"`, 55,823 bytes) | `f6c0dfd2ed68e18084b9952842b86e3850cf837d674704700c2a0718e0a24f6b` | 2026-10-01 |

License: the file's own header applies ("sdpi-components v4.0.1, Copyright Corsair Memory Inc. and other contributors"; it bundles Lit, Copyright 2019 Google LLC, BSD-3-Clause). The file is kept byte-for-byte as downloaded.

To check the file:

```sh
shasum -a 256 sdpi-components.js
```

To update it, download the new release into this folder and update the version and hash above. `npm run check-pi` (plugin/scripts/check-pi.ts) checks that the hash here matches the file.
