# 0193 — Bounded private document transfer

Vercel Functions limit individual request and buffered response bodies to 4.5 MB. The documented options are direct uploads and streamed responses: https://vercel.com/kb/guide/how-to-bypass-vercel-body-size-limit-serverless-functions. A private archive must preserve application encryption and source authorization while supporting its configured file size.

Use the existing 256 KiB upload framing for larger documents. The original reviewed request declares a versioned manifest containing every part hash, bound to the immutable admission and command fingerprint. Each part is authenticated, size/hash checked, conditionally stored with application AEAD and reauthorized after transport and its audit. The original file, source and actor identities, part index and expected hashes are authenticated together. No signed storage URL or plaintext is returned to the client.

Finalization reads parts with bounded concurrency, verifies their exact bytes and the complete original hash, then reuses ordinary document version admission. The first complete ciphertext remains immutable across lost acknowledgements. A native additive constraint validates manifests; applied migration 189 and historical records are preserved. An explicit transport budget is required for policies that allow larger files. The browser retains only the scoped original nonce, supports exact resumption and accepts completion only from a consistent original receipt.

R2 evaluates conditional PUT headers atomically. `If-None-Match: *` admits one first writer; a conflicting request receives 412 and must verify the retained ciphertext. A negative read after an unknown write does not prove cancellation: https://developers.cloudflare.com/r2/reference/consistency/.

Downloads authorize and verify the complete original file before returning a backpressure-aware stream. They retain private response headers and attachment disposition. This changes application transport without changing hosting, deployment, production or billing configuration.
