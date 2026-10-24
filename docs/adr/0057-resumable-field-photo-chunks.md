# ADR 0057: Resumable private photo chunks

Date: 2026-10-23

Status: Accepted

The effective `ops.task_policy` continues to decide the photo byte limit. Its current schema caps evidence below four million bytes. R2 requires at least five MiB for non-final S3 multipart parts, so native multipart framing would not provide partial retry for these photos. [Cloudflare upload documentation](https://developers.cloudflare.com/r2/objects/upload-objects/).

Field uploads therefore use bounded private chunk objects through the existing R2 signed-upload adapter. An immutable manifest binds the task, original local operation key, content type, total size, whole-file digest and ordered chunk digests. Technical chunk framing does not replace the effective property policy. Server verification must precede the permanent object and native evidence operation; that operation references the upload and retains its original idempotency key.

The upload record has organization, task and actor references, forced tenant RLS, immutable provenance and guarded forward transitions. Metadata is retained. Cleanup accepts only computed temporary-part keys and cannot select a permanent evidence/document key. Signed URLs stay out of stored manifests and audit payloads.

Permanent objects use the server-generated upload ID in a separate task upload namespace. A client nonce is solely the retry identity: another account can choose the same nonce after reassignment, so it cannot identify a permanent object. The database provenance guard requires the server-owned object path. A real PostgreSQL regression first attaches evidence, reassigns the task, uploads different bytes under the same client nonce and verifies the original object and digest remain unchanged. The old key layout fails this test. These changes finalize the unreleased additive upload migration; it has not run on staging or production.

The live staging CORS preflight returns 403. Chunks therefore travel through a bounded, authenticated same-origin binary endpoint; the server rechecks ownership, assignment, effective permissions, configured size and each digest before using the existing R2 signed-upload adapter. Signed URLs remain in server memory. No bucket policy, CORS configuration, account permission or production setting changes are required. Interrupted requests retry only the original immutable chunk key. Full authenticated acceptance remains unfinished; F-FLD-14 stays IN-PROGRESS.
