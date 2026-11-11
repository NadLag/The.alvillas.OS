# 0235 — Native onboarding Workflows use the canonical standard template

Date: 2026-11-11

Status: Accepted implementation direction; native admission and user acceptance remain pending.

The locked specification's ninth onboarding step applies a standard workflow template and property-specific overrides. The canonical Core WORKFLOW template already holds `ops.workflows` and `ops.reservation_task_templates`, with keyed setting identities, inherited changes, immutable APPLY/OVERRIDE revisions, authorization and audit. Referenced checklists come from the actual `ops.checklists` configuration.

The native step selects an actual active WORKFLOW template version and expected binding revision. It records an explicit override map, including an explicitly empty map when the inherited settings are intended. Native paths stay within the two workflow rules and their registered operational fields. JSON and condition/action validation rejects unsafe paths, private extensions and authority assertions before orchestration. Existing complete source values retain their canonical semantics.

Preview and application share Core's inheritance, keyed setting paths and cross-rule dependency validation. The reusable dependency validator is extracted from the existing canonical application without changing its rules. Applying a template and applying its explicit overrides use the existing immutable commands in one tenant transaction. Configuration prepares the property for the later F-ONB-04 activation workflow.

The canonical configuration writer receives actual Property geography and the explicit, validated Owner for template-owned rules. It checks held and stored authority with the database clock before configuration and after its audit. Service prices retain independent financial authority; operational workflow configuration uses operational access. The gateway checks source view/export, Property view/edit and configuration authority before canonical values and at completion. Any late withdrawal rolls the commands, configuration, audit and assignment change back together.

An explicit optional `onboarding.wizard.workflows` policy supplies TEMPLATE mode and the required workflow/task counts. Earlier policies keep this producer closed. Whole Review and Activate keep their own producers and acceptance gates. Native registration, encrypted source retention, history/recovery, paginated selectors, EN/FR/AR UI, actual PostgreSQL/browser/restore qualification and mandatory CI must finish before this step can be accepted. Hosted acceptance remains subject to the existing staging restrictions. No feature status changes to DONE.
