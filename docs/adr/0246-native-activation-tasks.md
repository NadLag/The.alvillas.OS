# Native activation uses canonical tasks

The Tasks effect consumes explicit `onboarding_tasks` settings inside the already approved `ops.workflows` catalog. The complete Review binds that actual catalog; no second business table, seed configuration or unreviewed rule supplies tasks. Each task specifies its canonical type, localized title, priority, checklist, activation-request anchor, IANA timezone and calendar offset. The catalog specifies its own required minimum. Missing settings block the effect. An explicitly empty catalog is permitted only when its approved minimum is zero.

Task commands use the original activation request time and the existing canonical automation identity algorithm, extracted without changing its outputs. Organization, property, activation and configured task key bind each stable nonce. Retries cannot move deadlines to the current date or duplicate original tasks.

The adapter checks the original creator cap and current task destination permissions before private source payloads. It then reuses the same protected Review and bounded catalog reads as workflow materialization. All task creation runs through `createOperationTask` in one tenant transaction, including configured checklists, immutable mutation receipts, audits and actual TaskCreated events. Current authority and the original complete source are rechecked before commit. Operator changes to an existing task are preserved by canonical nonce recovery.

The adapter reports actual task references. It does not append native effect success, activate Property or claim delivery. The dependency producer and additive database effect-evidence guards remain required, including actual workflow, document, email acceptance and owner notification evidence. All 355 approved features remain required.
