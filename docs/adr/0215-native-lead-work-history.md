# ADR 0215: Native lead activities, reminders and representative history

F-CRM-04 extends the existing private lead workspace. Activities, reminders and representative changes retain append-only native history; they do not create people, owners, properties or financial movements.

Use one ordered lead-work history with a tenant-bound global predecessor and exact subject predecessor. A new activity or reminder starts its own subject; a correction references the actual current revision of that subject. Representative changes share one assignment subject per lead. Review and admission must reject stale global or subject positions. Nonces bind actor, tenant, lead, kind and complete canonical intent, using the existing command fingerprint and lost-acknowledgement patterns.

Private summaries, notes and reasons reuse the platform authenticated encryption envelope. Associated data binds the actual native root, revision, predecessors, actor, command nonce and both work/capture policy versions. The original lead processing approval remains mandatory. The new `crm.lead_work` rule supplies activity types, note requirements, future/past-due decisions and admission budgets without business defaults.

Assignment does not grant access. Require independent held and current `lead:view` plus `lead:assign` authority; activities and reminders require their own held and current view/edit authority. Representative and recipient accounts must come from actual authorized tenant sources. Derive the current representative from retained work history and use that native identity consistently when evaluating existing assigned-to-me conditions. Never infer a financial grant from operational assignment.

The repository must enforce organization-scoped source relations, immutable rows, ordered revisions, exact policy snapshots and atomic identifier-only audit/outbox admission. Reminders reuse existing notification routing, preferences, current recipient authorization and delivery infrastructure. A recorded notification is not activity completion. Cancellation or completion retains the original reminder and its due instant; delivery receipts cannot silently alter the work history.

Open reminders require an active authorized recipient. An authorized editor may
complete or cancel an existing reminder after that recipient becomes inactive;
the native transition still preserves its exact original recipient and due
instant. Terminal history neither delivers a notification nor grants the former
recipient access. The correction follows applied migration 212 in a new forward
migration; applied SQL and prior work/financial rows stay unchanged.

The current checkpoint implements domain validation, canonical commands and encryption with 50 affected unit cases. Native admission, configuration wiring, current-authority fences, notification production, localized UI and complete acceptance remain outstanding. No feature is DONE and no legal, provider or production approval is implied.

Scope unchanged: all 355 features remain required.
