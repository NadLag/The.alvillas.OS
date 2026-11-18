import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import type { KpiChoices, KpiDimensions, KpiLedger, KpiOperations, KpiSelectKey } from "../domain/kpi-report";

type Query = { propertyId: string | null; startsAt: Date; endsAt: Date; currency: string; fromOn: string; toOn: string };
type ChoiceRow = { kind: KpiSelectKey; id: string; name: string };

export class KpiReportRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}

  async choices(): Promise<KpiChoices> {
    const rows = await this.tx.$queryRaw<ChoiceRow[]>(Prisma.sql`
      SELECT 'ownerId' AS kind,id::text,display_name AS name FROM owner WHERE organization_id=${this.organizationId}::uuid
      UNION ALL SELECT 'personId',person.id::text,person.display_name FROM person
        WHERE person.organization_id=${this.organizationId}::uuid AND (
          EXISTS (SELECT 1 FROM role_assignment assignment JOIN role
            ON (role.organization_id,role.id)=(assignment.organization_id,assignment.role_id)
            WHERE assignment.organization_id=person.organization_id AND assignment.person_id=person.id
              AND role.key NOT IN ('owner','owner_representative','guest'))
          OR EXISTS (SELECT 1 FROM operation_task task WHERE task.organization_id=person.organization_id
            AND person.id IN (task.assigned_to_person_id,task.completed_by_person_id)))
      UNION ALL SELECT 'roleId',id::text,name FROM role WHERE organization_id=${this.organizationId}::uuid
      UNION ALL SELECT 'supplierId',id::text,display_name FROM supplier WHERE organization_id=${this.organizationId}::uuid
      UNION ALL SELECT DISTINCT 'bookingSource', source,source FROM reservation WHERE organization_id=${this.organizationId}::uuid
      ORDER BY kind,name,id`);
    const choices: KpiChoices = { ownerId: [], personId: [], roleId: [], supplierId: [], bookingSource: [] };
    for (const { kind, id, name } of rows) choices[kind].push({ id, name });
    return choices;
  }

  async operations(query: Query, scope: KpiDimensions): Promise<KpiOperations> {
    const { propertyId, fromOn, toOn, startsAt, endsAt } = query;
    const { ownerId, bookingSource, personId, roleId } = scope;
    const [row] = await this.tx.$queryRaw<KpiOperations[]>(Prisma.sql`
      WITH properties AS (
        SELECT property.id,property.timezone FROM property WHERE organization_id=${this.organizationId}::uuid
          AND (${propertyId}::uuid IS NULL OR property.id=${propertyId}::uuid)
          ${ownerId ? Prisma.sql`AND EXISTS (SELECT 1 FROM property_owner owner
             WHERE owner.organization_id=property.organization_id AND owner.property_id=property.id AND owner.owner_id=${ownerId}::uuid
               AND owner.archived_at IS NULL)` : Prisma.empty}
      ), stays AS (
        SELECT r.id,r.property_id,r.check_out FROM reservation r JOIN properties p ON p.id=r.property_id
        WHERE r.organization_id=${this.organizationId}::uuid AND r.archived_at IS NULL
          AND r.check_out BETWEEN ${fromOn}::date AND ${toOn}::date AND r.status IN ('CHECKED_OUT','FINANCIAL_RECONCILIATION','CLOSED')
          ${bookingSource ? Prisma.sql`AND r.source=${bookingSource}` : Prisma.empty}
      ), tasks AS (
        SELECT task.*,p.timezone FROM operation_task task JOIN properties p ON p.id=task.property_id
        LEFT JOIN reservation r ON (r.organization_id,r.id)=(task.organization_id,task.reservation_id)
        WHERE task.organization_id=${this.organizationId}::uuid AND task.archived_at IS NULL
          ${bookingSource ? Prisma.sql`AND r.source=${bookingSource}` : Prisma.empty}
          ${personId ? Prisma.sql`AND CASE WHEN task.state='COMPLETED' THEN task.completed_by_person_id ELSE task.assigned_to_person_id END=${personId}::uuid` : Prisma.empty}
          ${roleId ? Prisma.sql`AND EXISTS (
            SELECT 1 FROM role_assignment grant_role JOIN role ON (role.organization_id,role.id)=(grant_role.organization_id,grant_role.role_id)
            WHERE grant_role.organization_id=task.organization_id AND grant_role.role_id=${roleId}::uuid
              AND grant_role.person_id=CASE WHEN task.state='COMPLETED' THEN task.completed_by_person_id ELSE task.assigned_to_person_id END
              AND grant_role.valid_from<=coalesce(task.completed_at,${endsAt})
              AND (grant_role.valid_to IS NULL OR grant_role.valid_to>coalesce(task.completed_at,${endsAt}))
              AND (grant_role.archived_at IS NULL OR grant_role.archived_at>coalesce(task.completed_at,${endsAt}))
              AND (grant_role.scope_type='organization' OR grant_role.scope_type='property' AND grant_role.scope_id=task.property_id)
              AND (grant_role.conditions IS NULL OR grant_role.conditions='{}'::jsonb))` : Prisma.empty}
      ), completions AS (
        SELECT * FROM tasks WHERE state='COMPLETED' AND completed_at>=${startsAt} AND completed_at<${endsAt}
      ), turnovers AS (
        SELECT checkout.at,ready.at AS ready_at
        FROM stays stay
        CROSS JOIN LATERAL (
          SELECT revision.created_at AS at FROM reservation_revision revision
          WHERE revision.organization_id=${this.organizationId}::uuid AND revision.reservation_id=stay.id
            AND revision.operation IN ('TRANSITION','EARLY_CHECKOUT') AND revision.after->>'status'='CHECKED_OUT'
            AND revision.created_at<${endsAt}
          ORDER BY revision.version DESC LIMIT 1
        ) checkout
        CROSS JOIN LATERAL (
          SELECT rule.value,rule.lifecycle FROM config_rule rule
          WHERE rule.organization_id=${this.organizationId}::uuid AND rule.key='ops.task_policy'
            AND rule.archived_at IS NULL AND rule.lifecycle IN ('ACTIVE','RETIRED')
            AND rule.effective_from<=checkout.at AND (rule.effective_to IS NULL OR rule.effective_to>checkout.at)
            AND (rule.scope_type='organization' OR rule.scope_type='property' AND rule.scope_id=stay.property_id)
          ORDER BY (rule.scope_type='property') DESC,rule.effective_from DESC,rule.version DESC LIMIT 1
        ) policy
        CROSS JOIN LATERAL (
          SELECT reservation.id,reservation.check_in FROM reservation
          WHERE reservation.organization_id=${this.organizationId}::uuid AND reservation.property_id=stay.property_id
            AND reservation.id<>stay.id AND reservation.archived_at IS NULL AND reservation.check_in>=stay.check_out
            AND reservation.status NOT IN ('IMPORTED','CANCELLED','NO_SHOW')
          ORDER BY reservation.check_in,reservation.id LIMIT 1
        ) arrival
        CROSS JOIN LATERAL (
          SELECT max(task.completed_at) AS at
          FROM operation_task task
          WHERE task.organization_id=${this.organizationId}::uuid AND task.property_id=stay.property_id
            AND task.reservation_id=arrival.id AND task.due_date<=arrival.check_in AND task.archived_at IS NULL
            AND policy.value->'readiness_types' ? task.type AND task.state NOT IN ('CANCELLED','SKIPPED')
          HAVING count(*)>0 AND bool_and(task.state='COMPLETED' AND task.completed_at IS NOT NULL AND task.completed_at<${endsAt})
            AND count(DISTINCT task.type)=jsonb_array_length(policy.value->'readiness_types')
        ) ready
        WHERE ${!personId && !roleId} AND policy.lifecycle='ACTIVE' AND ready.at>=checkout.at
      ), ordered_turnovers AS (
        SELECT extract(epoch FROM ready_at-at)/60 AS minutes,
          row_number() OVER (ORDER BY ready_at-at) AS position,count(*) OVER () AS population FROM turnovers
      )
      SELECT (SELECT count(*)::text FROM stays) AS stays,
        (SELECT count(*)::text FROM completions WHERE completed_by_person_id IS NOT NULL) AS completed,
        (SELECT count(*)::text FROM completions WHERE completed_by_person_id IS NOT NULL AND
          (completed_at AT TIME ZONE timezone)::date<=due_date) AS "onTime",
        (SELECT count(*)::text FROM tasks WHERE type='MAINTENANCE' AND created_at<${endsAt}
          AND (state IN ('PLANNED','ASSIGNED','IN_PROGRESS','BLOCKED') OR state='COMPLETED' AND completed_at>=${endsAt})) AS "maintenanceOpen",
        (SELECT count(*)::text FROM completions WHERE type='MAINTENANCE') AS "maintenanceCompleted",
        (SELECT round(avg(extract(epoch FROM completed_at-created_at))/60,2)::text FROM completions
          WHERE type='MAINTENANCE' AND completed_at>=created_at) AS "maintenanceAverageMinutes",
        (SELECT round(avg(minutes),2)::text FROM ordered_turnovers
          WHERE position IN ((population+1)/2,(population+2)/2)) AS "turnaroundMedianMinutes"`);
    return row;
  }

  async ledger(query: Query, scope: KpiDimensions): Promise<KpiLedger> {
    const { propertyId, currency, startsAt, endsAt } = query;
    const { ownerId, personId, roleId, supplierId, bookingSource } = scope;
    const attributedFinancials = !ownerId && !personId && !roleId && !supplierId;
    const broad = attributedFinancials && !bookingSource;
    const [row] = await this.tx.$queryRaw<KpiLedger[]>(Prisma.sql`
      WITH recognized_service AS (
        SELECT p.amount,p.side,admission.snapshot
        FROM posting p
        JOIN financial_transaction t ON (t.organization_id,t.id)=(p.organization_id,p.transaction_id)
        JOIN service_allocation_posting allocation ON allocation.organization_id=t.organization_id
          AND allocation.transaction_id=coalesce(t.reverses_transaction_id,t.id)
        JOIN service_allocation_admission admission ON (admission.organization_id,admission.id)=(allocation.organization_id,allocation.admission_id)
        WHERE ${attributedFinancials} AND p.organization_id=${this.organizationId}::uuid AND p.currency=${currency}
          AND t.sealed AND t.occurred_at>=${startsAt} AND t.occurred_at<${endsAt} AND p.bucket='SERVICE_ALLOCATION'
          AND (${propertyId}::uuid IS NULL OR p.dimensions->>'property_id'=${propertyId})
          ${bookingSource ? Prisma.sql`AND EXISTS (SELECT 1 FROM reservation r
             WHERE r.organization_id=p.organization_id AND r.id::text=p.dimensions->>'reservation_id' AND r.source=${bookingSource})` : Prisma.empty}
      ), variances AS (
        SELECT expected_amount,variance_amount,resolved_at FROM variance WHERE ${broad} AND organization_id=${this.organizationId}::uuid
          AND currency=${currency} AND created_at>=${startsAt} AND created_at<${endsAt}
          AND (${propertyId}::uuid IS NULL OR property_id=${propertyId}::uuid)
      )
      SELECT
        (SELECT sum(CASE WHEN side='DEBIT' THEN amount ELSE -amount END)::text FROM recognized_service) AS "serviceGross",
        (SELECT sum(CASE WHEN service.side='DEBIT' THEN part.amount ELSE -part.amount END)::text
          FROM recognized_service service
          CROSS JOIN LATERAL (SELECT coalesce(sum((provider#>>'{amount,amount}')::numeric),0) AS amount
            FROM jsonb_array_elements(service.snapshot->'providerCosts') provider
            WHERE provider#>>'{amount,currency}'=${currency}) part) AS "serviceCosts",
        (SELECT sum(CASE WHEN p.side='DEBIT' THEN p.amount ELSE -p.amount END)::text
          FROM posting p JOIN financial_transaction t ON (t.organization_id,t.id)=(p.organization_id,p.transaction_id)
          WHERE ${!ownerId && !personId && !roleId && !bookingSource}
            AND p.organization_id=${this.organizationId}::uuid AND p.currency=${currency}
            AND t.sealed AND t.occurred_at>=${startsAt} AND t.occurred_at<${endsAt}
            AND p.bucket IN ('OWNER_EXPENSE','ALVILLAS_EXPENSE','GUEST_EXPENSE')
            AND EXISTS (SELECT 1 FROM maintenance_work_order_finance link
              JOIN operation_task task ON (task.organization_id,task.id)=(link.organization_id,link.task_id)
              LEFT JOIN expense ON (expense.organization_id,expense.id)=(link.organization_id,link.expense_id)
              LEFT JOIN supplier_invoice_recognition recognition ON (recognition.organization_id,recognition.invoice_id)=(link.organization_id,link.invoice_id)
              LEFT JOIN supplier_invoice_recognition_line line ON (line.organization_id,line.recognition_id)=(recognition.organization_id,recognition.id)
              LEFT JOIN supplier_invoice invoice ON (invoice.organization_id,invoice.id)=(recognition.organization_id,recognition.invoice_id)
              WHERE link.organization_id=p.organization_id
                AND coalesce(t.reverses_transaction_id,t.id) IN (expense.transaction_id,line.transaction_id)
                AND (${propertyId}::uuid IS NULL OR task.property_id=${propertyId}::uuid)
                ${supplierId ? Prisma.sql`AND invoice.supplier_id=${supplierId}::uuid` : Prisma.empty})) AS "maintenanceCost",
        (SELECT sum(CASE WHEN p.side='DEBIT' THEN p.amount ELSE -p.amount END)::text FROM posting p
          JOIN financial_transaction t ON (t.organization_id,t.id)=(p.organization_id,p.transaction_id)
          JOIN ledger_account a ON (a.organization_id,a.id)=(p.organization_id,p.ledger_account_id)
          WHERE ${broad && !propertyId} AND p.organization_id=${this.organizationId}::uuid AND p.currency=${currency}
            AND t.sealed AND t.occurred_at<${endsAt} AND a.normal_side='DEBIT' AND a.account_type='ASSET_LOCATION'
            AND (a.code ~ '^(BANK|CASH)($|[_:])' OR EXISTS (SELECT 1 FROM team_wallet w
              WHERE w.organization_id=a.organization_id AND w.ledger_account_id=a.id))) AS "cashBalances",
        CASE WHEN ${broad} THEN (SELECT count(*)::text FROM variances WHERE resolved_at IS NULL OR resolved_at>=${endsAt}) END AS "varianceOpen",
        (SELECT sum(CASE WHEN resolved_at IS NULL OR resolved_at>=${endsAt} THEN abs(variance_amount) ELSE 0 END)::text FROM variances) AS "varianceAmount",
        (SELECT sum(abs(expected_amount))::text FROM variances) AS "varianceExpected"`);
    return row;
  }
}
