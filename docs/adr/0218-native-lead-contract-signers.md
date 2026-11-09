# ADR0218 — Native lead contract signers

An acquisition contract precedes Owner conversion. Its signer must reference
the actual Lead rather than create an Owner early or accept a caller's name
and email as identity evidence.

Extend the existing immutable signature recipient with a nullable composite
organization/lead foreign key. The forward migration retains every original
party, cipher, snapshot, signature and financial value. A lead recipient binds
its stored native protocol identity to the same organization, signature,
recipient and lead. No backfill or financial history update is required.

The subsequent forward migration extends the latest deferred draft guard.
It retains its original provider, distribution, webhook and signed archive
assertions, and verifies the owning Lead and captured organization contract
policy before accepting native Lead recipients. Applied migrations are never
edited; original business rows and migration records retain their values and
physical tuple versions.

Use the retained capture or latest immutable profile for contact identity.
Resolve names and emails only after independent current and held lead,
document, instance and signature authorization. Missing contact values remain
unavailable. Representative assignment grants no access.

Only contract types approved in the native CRM pipeline policy may enter
lead signing. Preserve that approval with the immutable signature intent.
The referenced Lead must own the contract; unrelated leads cannot become its
signers. Existing organization counterparties retain their independent native
references and authorization.

Reuse document review, durable nonce admission and recovery, encrypted
recipient payloads, provider preparation and distribution, webhook evidence,
signed archives, history, audit and stage proof readers. Source and policy
changes stop new provider work. Historical identity stays bound to the
original cipher and intent. Hosted provider and legal acceptance remain
required; native fixtures do not substitute for them.

Scope unchanged: all 355 features remain required.
