# ADR 0213: Private lead profile corrections and workspace reads

Status: accepted implementation direction for F-CRM-03.

An original acquisition capture remains immutable. Reviewed contact, property
claim, source and language corrections append a numbered profile revision.
Current details derive from the latest revision; neither an earlier profile
nor the original capture is rewritten. Stage changes and representative
assignment use their own authorized workflows.

Corrections reuse the current capture field catalogue and validation rules.
They retain the original capture channel and website acknowledgement; an
internal correction never asserts new website consent. The current approved
processing configuration and explicit profile admission configuration are
bound to each reviewed command. These references supply no legal defaults.

The platform authenticated binary envelope binds private fields and reasons to
the tenant, lead, revision, predecessor, author, command and both configuration
versions. Held and current source permissions are checked again after writes.
Native constraints require ordered history, tenant-bound references and the
actual audit and identifier-only outbox rows in the same transaction. A lost
acknowledgement recovers the original actor-bound receipt. Browser storage
needs only a command nonce, never contact details or a correction reason.

Directory queries use bounded native candidate batches and immutable creation
ordering. Every candidate passes the existing authorization helpers before
decryption and presentation. Opaque cursors bind actor, tenant, filters,
authority and creation bounds. Grants and retained source revisions are checked
again after the read audit. Denied identifiers are never published as cursors.

Profile history has no financial write path. Existing financial values, tuple
versions and migration records remain protected. Forward migration 211 adds
only profile history and its native guards. This decision grants no production
migration, hosting, owner-conversion, signature or financial acceptance.
