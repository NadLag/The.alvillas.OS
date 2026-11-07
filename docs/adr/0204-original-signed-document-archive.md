# 0204 — Retain signed originals and completion certificates together

A verified completion admits an immutable archive tied to the original native signature, preparation attempt, account and generated PDF. The worker uses authenticated Documenso reads to obtain the signed PDF and completion certificate, verifies the captured contract and required recipients, and retains both encrypted plaintexts in one transaction before object storage. Recovery uses those first retained bytes and conditional private object creation.

Each artifact has its own document root and first version. Signing an older generated version therefore cannot overwrite or attach to a later amendment. The native SIGNED event, both published versions, their system actions and audits commit together after the separately committed capture. Database guards preserve the completion lineage, tenant boundaries and append-only history.

Resource attribution retains the original initiating account; automatic execution has a null system actor in history and audit. Null document actors are restricted to the verified artifact’s creation, admission and publication. Existing human actions retain their actor requirement. Human recovery records its own reviewed command, authorization cap, nonce, reason and reference-only outbox.

Forward migration 201 also excludes signed artifact roots from the shared human-action branch. A rollback-only reproducer retains a genuine system action, copies it with a human actor and matching audit, and proves that the tightened guard rejects that impersonation. Migration 200 remains byte-for-byte frozen.

Artifacts remain hidden until both versions are published. Reads and downloads require the original source, template, financial, signature, recipient and field authority, plus the artifact’s retained sensitive classification. Signed artifact roots cannot be amended. Technical provider verification does not establish legal signature or certificate acceptance; those owner decisions and hosted acceptance remain required.
