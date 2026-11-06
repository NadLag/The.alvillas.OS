# 0194 — Authored template definitions and durable intents

F-DOC-02 and F-DOC-03. Scope unchanged: all 355 features remain required.

Use an explicit, versioned UTF-8 document definition for editable templates. Its media type is `application/vnd.alvillas.document-template+json`. The existing template root owns the organization, template key and locale; the encrypted immutable archive version owns the original definition bytes. Existing PDF, DOCX, JSON and other archive originals remain readable under their original contracts.

Definitions contain authored headings, paragraphs, bullets and declared typed variables. Tokens select exact keys from a native resolver's map. They cannot evaluate expressions, traverse objects, invoke helpers or interpret inserted values as HTML or further tokens. Money uses the existing Money and exact locale formatter; integers use BigInt. A calendar date remains a calendar date. Classification follows the native bound values and Money always carries financial protection.

EN and FR variants must be authored explicitly and share the variable contract. An Arabic variant uses the same interface; a missing translation never falls back to another language. Templates supply no invented agreement, accounting or legal text. Native source resolution and generated instances must retain the original template version, source snapshot, held/current authority and derived classification.

Generated template bytes require durable admission before storage I/O. Extend the existing archive admission with an optional authenticated encrypted payload, bound to its organization, document, admission, MIME, size and original hash. The typed-template protocol requires that payload; legacy admissions retain null. An explicit completion command can resume the original bytes after a lost response or page reload. Browser storage continues to hold only the scoped nonce. No template body is placed in URLs or generic audit payloads.

Reuse the archive's original review, locks, source permissions, configuration, object encryption, first-ciphertext immutability, append-only versions, private history and canonical audits. The additive migration must preserve every prior checksum, financial row, document row and tuple version. No competing version store, financial movement, signature assertion or provider fallback is introduced.
