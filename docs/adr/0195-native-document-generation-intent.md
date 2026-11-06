# 0195 — Native immutable document generation intent

F-DOC-03. Scope unchanged: all 355 features remain required.

Use the existing immutable `DocumentInstance` as the durable generation intent. Its native document and template-version links already retain tenant, source, actor and command identity. Store a versioned snapshot containing the original source fingerprints, explicit language-version contract, captured authority, configuration and authenticated encrypted render input. The existing outbox carries only the native instance reference. A second intent table or mutable render-state record is unnecessary.

Resolve values from actual native sources after independent held/current authority checks. Template variants must be explicitly authored; missing languages never fall back. Snapshot the original rendered input before PDF provider or object writes. Bind its encryption context to organization, document, instance, immutable template version, original source fingerprint, byte size and hash. Keep source clauses and bound values out of generic audits, browser persistence and outbox payloads.

Reuse the archive's admission, locks, audit writer, object encryption, conditional first ciphertext and immutable versions for the chosen PDF bytes. Persist the first admitted PDF in an authenticated encrypted admission payload before storage I/O, so recovery retains those exact bytes across process loss. Concurrent rendering may produce candidates; only the original admitted candidate can be published. Public file-upload commands continue to exclude generated instances.

Current authority, original request restrictions, original source fingerprints and configuration are rechecked before admission and after provider/storage boundaries. Source or permission changes fail closed without repricing, substituting values or rewriting the retained intent. State is derived from native admissions, versions and immutable history. No financial movement or signature outcome is created by PDF generation.

Any necessary PostgreSQL extension is additive after frozen migration191. It preserves existing source, document and financial rows and all prior migration checksums. Complete generation and provider/hosted acceptance remain required before the feature can be DONE.
