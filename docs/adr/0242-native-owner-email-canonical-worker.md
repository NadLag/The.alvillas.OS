# Native owner email uses canonical delivery

The immutable native owner delivery intent must become an actual email with the original archived PDFs, without introducing another provider, retry schedule or delivery-status store.

The existing outbox handler delegates the native event to the canonical email worker. A platform bridge validates the actual event and original intent, current and captured creation/export authority, current configuration and all original document identities. Archived ciphertext is downloaded and verified outside delivery transactions. The worker uses the stored original email wording and attachments, then checks current authority and source again at preparation and send. Later message-file edits cannot rewrite an admitted original.

Canonical NotificationDelivery owns the encrypted prepared request, recipient suppression lock, stable provider key, attempts, backoff and audit history. Native encryption requires the explicit document key ring. Provider acknowledgement means ACCEPTED; only a verified matching signed webhook means DELIVERED. Receipt template and native delivery kind must match. Permanent bounce and complaint suppression remain canonical.

Internal package composition reuses protected original/history functions without consuming end-user recovery quotas or writing artificial recovery audits. Public review, admission and recovery retain their own configured quota gates and audit behavior. Tenant isolation, original scope checks and held authorization caps remain mandatory at both boundaries.

Verification uses real PostgreSQL, canonical archived PDFs, the actual provider adapter against owned HTTP, genuine lost acknowledgements and the vendor signature library. No external send or hosted acceptance is authorized by these local checks. Native activation remains closed until its actual required effects and readiness gates exist.
