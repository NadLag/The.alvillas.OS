# ADR 0212: Immutable native lead pipeline

Status: accepted implementation direction for F-CRM-02.

The eleven handbook stages retain their canonical order. The original encrypted
lead capture stays immutable. Current stage derives from ordered, append-only
stage movements; an explicit configured correction appends another movement.
No command overwrites the original capture or a previous stage receipt.

The organization configuration selects allowed adjacent advances, explicit
backward corrections and admission budgets. Every command binds its reviewed
native previous revision, actor, tenant and configuration snapshot. Held and
current permissions apply to both source and destination stages and are checked
again after the atomic audit and identifier-only outbox writes.

Proposal and contract stages require actual source-bound document versions.
Sent, Viewed and Signed require native signature evidence; Signed also requires
the completed immutable signed archive. Onboarding requires native lead-to-owner
conversion, and Go Live requires an actual onboarding release receipt. Policy
cannot remove these minimum source requirements. Caller-supplied flags, provider
status strings and foreign-source documents never establish stage completion.

The domain boundary accepts repository-derived immutable proof snapshots;
HTTP commands accept references and never accept proof claims. Native source
reads, current source authorization, complete local acceptance, exact-head CI
and authenticated hosted acceptance must be implemented and verified before
this feature can satisfy its Definition of Done. This ADR grants no legal,
signature, owner-conversion or production approval.
