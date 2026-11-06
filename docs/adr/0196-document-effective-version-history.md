# 0196 — Explicit document effective dates and retained version history

F-DOC-04. Scope unchanged: all 355 approved features remain required.

Retain the existing immutable linear supersession chain. A new amendment supersedes the latest recorded version, including when that version is scheduled. Recording a future amendment does not label it currently effective. At the authenticated database observation time, select the highest recorded version number whose explicit effective timestamp has arrived; a missing effective timestamp uses that version's archive timestamp. Keep every earlier original, scheduled amendment, source, reason, signature reference and audit event. These are archive metadata, without a claim of legal signature or a financial movement.

The edit fields explicitly use UTC. A blank value retains the existing null protocol and archive timestamp behavior. Validate real calendar dates; do not reinterpret a local browser value using the browser or server timezone. Dates and nonce recovery remain bound to the reviewed immutable command.

Use the existing repository, source authorization, canonical audit and root lock. Resolve the effective version independently of history pagination, then recheck current source/held authority before returning protected data. Keep the original history response for existing clients; the updated UI opts into `DOCUMENT_EFFECTIVE_HISTORY_V1` on the same authorized endpoint. This adds observation/effective-version metadata without another service or a breaking response change.

All 192 applied migrations remain frozen. Existing tenant/version indexes and native immutable supersession/effective-date guards support this change without a new business table or migration. Hosted acceptance remains required before marking F-DOC-04 DONE.
