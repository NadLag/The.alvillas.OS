# ALVILLAS OS threat model

F-SEC-01 covers the public site, account and field sessions, Guest Hub, owner portal, business workspaces, Personal OS, integrations and release tooling. The assets are tenant-private identities and documents, source journals and audit evidence, business and household records, and service credentials. An account, a device, a tenant grant and a resource grant establish separate trust boundaries.

## Trust boundaries and controls

| Boundary | Threat and impact | Enforced control and verification surface |
| --- | --- | --- |
| Outside browser to public site and Guest Hub | Form abuse, token reuse and disclosure of another guest's stay | Policy-bound lead capture, quotas and revocable reservation links. Exercise anonymous submission and wrong-reservation denial in CRM and Guest Hub integration tests. |
| Browser or field device to identity session | Credential guessing, stolen sessions, untrusted offline mutations and lost devices | Rate-limited credentials, required MFA enrollment for sensitive roles, server-side session validation, device-bound offline commands and explicit local state clearing on logout. Verify browser enrollment, field-device and cold-offline journeys. |
| Authenticated request to tenant and resource | A valid user reads another tenant, villa, owner or financial scope | Each entry point validates, authorizes and projects data. Repositories bind organization and resource scope. PostgreSQL row policies provide a second tenant boundary. Verify with non-superuser integration roles, wrong-scope records and field-level masking checks. |
| Personal OS to company systems | A household grant reveals company money or duplicates a settlement | Household grants, records and audit history are scoped independently. The bridge requires both authorities and an approved mapping to an existing sealed journal. Verify denied confirmation, cross-household reversal denial and unchanged company postings in `personal-os.test.ts`. |
| Operator or worker to posted ledger | Duplicate or backdated commands change an earned or held balance without evidence | Server-side decimal accounting, idempotent commands, sealed journals, attributed opposites, period controls and immutable audits. Verify migration constraints and native reversal, reconciliation and ledger suites. |
| Upload, download or provider callback to stored evidence | An untrusted file is served as active content, a signed link escapes scope, or a callback is replayed | Bound upload protocols, short-lived private object authorization, validation on intake, restricted download responses, authenticated provider evidence and idempotent delivery. Verify document archive, signature provider and field photo recovery tests. |
| Source control and deployment to runtime | Dependency tampering, committed credentials or an unverified deployment reaches users | Dependency and secret checks, scoped environment secrets, exact-commit verification and promotion approval. A restore keeps business and Personal OS history and audit evidence together. |

## Incident containment

Preserve incident evidence and the original financial rows. Revoke compromised sessions, devices, provider credentials or shares at the smallest affected scope. Pause affected jobs or posting commands through existing operator controls. After correction, reproduce authorization and integrity checks with isolated fixtures, then verify the accepted commit on staging.

Independent penetration testing remains an external acceptance activity under F-SEC-02. The owner must authorize the tester and target scope before testing. Staging verification requires an accessible deployment and test accounts across the relevant scopes.
