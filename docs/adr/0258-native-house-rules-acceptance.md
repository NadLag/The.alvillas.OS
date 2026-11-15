# 0258 — Native approval and acceptance of the original property house rules

F-GST-06 adds explicit guest acceptance of the house rules required by master
specification section 37. The canonical ordered source remains
`PropertyOnboardingProfile.houseRules`. Core and Guest Hub use the same canonical
input contract in the platform; its original constraints and normalization remain
unchanged. Guest acceptance never edits that property profile.

The versioned `guest_hub.house_rules` policy contains an approved source snapshot,
EN/FR wording, optional AR wording, the actual acknowledgement statement,
processing notice and separate processing/wording approval references. A release
must cover every original rule in order. The source snapshot records the approved
edition; it is not another editable property rule list. The application computes
source and edition fingerprints. An owner does not need to enter a hash.

Collection is disabled without the explicit approvals and matching source.
Editing the canonical rules, their order, approved translations, acknowledgement
or purpose closes the previous delegation. A newly reviewed grant is required.
Operational budget changes retain both captured and current limits and do not
change the accepted edition. An incomplete optional Arabic translation uses one
complete approved English edition; the original requested and displayed languages
are retained separately. The client and server use the same rendering helper.

The existing purpose-bound form grants, current/held authority, capability budgets,
private codecs, tenant transactions, audit writer and outbox remain the shared
boundaries. Original PROFILE, STAY_DETAILS and IDENTITY_DOCUMENTS signing bytes
must remain unchanged. Acceptance history is append-only and binds the original
reservation, guest, property, link, grant, edition, policy and command nonce.
Immutable encrypted payloads retain the exact displayed rules, language and
acknowledgement. Server clocks supply the actual acceptance time; metadata-only
events have no human staff actor for the guest's action.

The new flow does not activate an electronic-signature provider or decide the legal
effect of acceptance. Lawyer/owner wording and processing decisions remain the
Part L gate. Restricted hosted acceptance remains a separate gate. These blocks
keep the feature IN-PROGRESS. Scope unchanged: all 355 approved features remain
required.
