# 0158 — Actual employee costs in company expense planning

Company plans must track real salaries and contractor costs without creating a second employee liability or allocating a claim payment to an individual cost line without evidence.

An append-only association connects a company plan revision to an actual recognized `EmployeeCompensationCost` that has no property or reservation attribution. Attachment requires matching currency, category and cost center and a plan classified as `STAFF_COMPENSATION`. A source cannot be attached twice concurrently. Release and reassignment append consecutive versions; salary classification cannot be downgraded. A correction preserves the original association history and source amount, exposes the actual journal reversal and prevents a new attachment to that reversed source.

The service reuses native employee recognition and settlement inspection, including current salary, employee-payable, financial-source and funding access. Payment history and outstanding amounts come from the native employee payment workspace. They are explicitly scoped to the entire employee claim. The company estimate and immutable earned cost retain their separate original amounts. No employee claim, payment, offset or balance is synthesized or edited by an association.

Reads lock the plan, acquire native run/submission locks in deterministic order, page association history and resolve each distinct claim once. Mutations use the same native locks before the source-version lock. The database guard matches that lock order and requires the recognized company-only source, current plan revision, original unreversed journal for attachment, strict salary classification and an atomic attributed audit. Tenant foreign keys, forced RLS and append-only triggers protect every association.

The existing company and employee authorization fences remain independent and apply again before commit. Source visibility does not follow from a company plan grant or a financial profile. Original financial rows, accounting periods, claim ownership, correction evidence and payment history remain under the native Finance workflows.
