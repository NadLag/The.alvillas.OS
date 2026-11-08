# ADR0210: Bounded private financial attachment transport

F-FIN-38 retains its existing 50 MiB file envelope and immutable original receipts,
invoices and amendments. Hosting request and buffered response limits prevent the
old single-request route from accepting that envelope. Platform guidance requires
bounded requests and streamed large responses; billing and deployment settings
remain unchanged. References: [Function limits](https://vercel.com/docs/functions/limitations)
and [large-response streaming](https://vercel.com/kb/guide/how-to-bypass-vercel-body-size-limit-serverless-functions).

Use the existing admission, nonce, source fingerprint, configured policy, audit,
object provider and authenticated encryption. A captured versioned part manifest
binds every part to its original organization, journal, admission, content type,
whole-file size/hash, index and part size/hash. Parts use the shared upload framing
constants, with one MiB requests and at most 64 parts, and conditional encrypted
object creation. Explicit configured transport budgets apply; no rate or retention
business rule is supplied by code.

Completion authenticates the original admission and fresh held/current source
authority, assembles and verifies the original file, and calls the existing final
attachment path. The final encrypted object format and original file/version
history stay unchanged. A lost part or completion acknowledgement never permits
overwriting an object or claiming an uncertain operation had no effect. No private
storage URL or decrypted part is exposed to another principal.

Forward migration208 adds a nullable manifest to the existing tenant-scoped
admission. Existing admissions, financial movements, migration records, original
columns and tuple versions are preserved; populated upgrade and rollback-only
manifest checks are required before application. Once applied, its bytes freeze.
Large downloads retain authorization and private headers and use a ReadableStream.
Private browser state clears on authority loss, offline and lifecycle transitions.
Hosted acceptance remains blocked by the Vercel restriction; this change does not
authorize production migration, promotion or a DONE status.
