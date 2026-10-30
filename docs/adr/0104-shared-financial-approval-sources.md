# ADR 0104: Preserve payout and invoice sources in shared approvals

Status: Accepted for integration; staging acceptance remains outstanding.

Owner payouts and supplier invoice submission extended the same approval engine on independent branches. Integrating them must retain expense, owner payout and supplier invoice source behavior in one repository, authorizer, resource presenter, notification path and automation engine.

The shared approval input permits exactly one financial source. Invoice headers remain organization sources with independently protected property/owner stages; payout headers retain their property and original immutable policy. Payout capacity and holdback checks, cancellation semantics, audit attribution, original caller restrictions and current stored authority remain in the composed decision path. Invoice stage history and private cost presentation retain their existing restrictions.

The merged Prisma schema includes both sources and optional invoice header property relations. The five already verified supplier migrations and all 73 previously applied payout migrations retain their exact bytes. Forward migration 79 composes the existing financial stage admission function to accept all three genuine submitted sources, prohibits combining financial source identities and extends append-only recipient history to payout approvals. Existing payout-specific lifecycle, source, capacity, journal and audit guards continue to run.

Automation keeps the shared frozen-input restoration helper, actual invoice source comparison, source-specific posting restrictions and fresh configuration/source permissions. Notification delivery keeps payout source filtering alongside invoice stage isolation and the shared database-current grant observation.

No financial rows, prior policy snapshots, approval decisions or historical migration records are rewritten. Local populated upgrade, restored readers, full verification, exact-head CI and authenticated staging acceptance are required before this payout integration can be accepted. Production migration and promotion remain owner-reserved actions.

The October 30 reconciliation retains the payout branch's 79 migrations and main's additional five supplier recognition, request, payment and reversal migrations. Both recognition relations and owner payout relations remain in the composed Prisma schema. The shared period, approval, automation and notification implementations retain their source-specific checks; source guards are verified against the combined migration order rather than replaced with parallel implementations.

Three shared supplier migration files have different applied byte checksums between the two local histories because their line endings differ. Their SQL text is identical after CRLF normalization. The integration checkout retains the payout lineage's bytes for those shared files; both original checkouts, frozen manifests and applied database checksum records remain intact. Forward deployment is rehearsed separately from each populated lineage, comparing every original column and tuple version, including every original migration record. No checksum is repaired or rewritten. A production migration remains subject to the owner's reserved approval and the actual production history.
