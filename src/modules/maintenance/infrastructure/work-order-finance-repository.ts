import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";

type FinanceRow = {
  id: string;
  taskId: string;
  actorId: string;
  requestHash: string;
  estimateRevision: number | null;
  expenseId: string | null;
  invoiceId: string | null;
  sourceVersion: number | null;
  amount: Prisma.Decimal;
  currency: string;
  reason: string;
  snapshot: unknown;
  createdAt: Date;
};
type NewFinanceRow = Pick<FinanceRow, "taskId" | "actorId" | "requestHash" | "estimateRevision" | "expenseId" | "invoiceId" | "reason"> & {
  idempotencyKey: string;
  sourceVersion?: number;
  amount: string;
  currency: string;
  snapshot: Prisma.InputJsonObject;
};
const fields = Prisma.sql`id, task_id AS "taskId", actor_id AS "actorId", request_hash AS "requestHash",
  estimate_revision AS "estimateRevision", expense_id AS "expenseId", invoice_id AS "invoiceId",
  source_version AS "sourceVersion", amount, currency, reason, snapshot, created_at AS "createdAt"`;

export class WorkOrderFinanceRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}

  async byNonce(actorId: string, idempotencyKey: string) {
    const [result] = await this.tx.$queryRaw<FinanceRow[]>(Prisma.sql`SELECT ${fields}
      FROM maintenance_work_order_finance WHERE organization_id = ${this.organizationId}::uuid
      AND actor_id = ${actorId}::uuid AND idempotency_key = ${idempotencyKey}::uuid`);
    return result;
  }

  history(taskId: string, before?: string) {
    const cursor = before ? Prisma.sql`AND id < ${before}::uuid` : Prisma.empty;
    return this.tx.$queryRaw<FinanceRow[]>(Prisma.sql`SELECT ${fields}
      FROM maintenance_work_order_finance WHERE organization_id = ${this.organizationId}::uuid
      AND task_id = ${taskId}::uuid ${cursor} ORDER BY id DESC LIMIT 21`);
  }

  async latestEstimate(taskId: string) {
    const [result] = await this.tx.$queryRaw<Array<{ revision: number; approvalState: string | null }>>(Prisma.sql`
      SELECT f.estimate_revision AS revision, a.state AS "approvalState" FROM maintenance_work_order_finance f
      LEFT JOIN approval_request a ON a.organization_id = f.organization_id AND a.maintenance_estimate_id = f.id
      WHERE f.organization_id = ${this.organizationId}::uuid AND f.task_id = ${taskId}::uuid
        AND f.estimate_revision IS NOT NULL ORDER BY f.estimate_revision DESC LIMIT 1`);
    return result;
  }

  async linkedSource(kind: "expense" | "invoice", sourceId: string) {
    const filter = kind === "expense" ? Prisma.sql`expense_id = ${sourceId}::uuid` : Prisma.sql`invoice_id = ${sourceId}::uuid`;
    const [result] = await this.tx.$queryRaw<Array<Pick<FinanceRow, "taskId" | "sourceVersion">>>(Prisma.sql`
      SELECT task_id AS "taskId", source_version AS "sourceVersion" FROM maintenance_work_order_finance
      WHERE organization_id = ${this.organizationId}::uuid AND ${filter} ORDER BY source_version DESC LIMIT 1`);
    return result;
  }


  sourceChoices(kind: "expense" | "invoice", propertyId: string, query: string, before?: string) {
    const pattern = "%" + query.replace(/[\\%_]/gu, value => "\\" + value) + "%";
    if (kind === "expense") {
      const cursor = before ? Prisma.sql`AND e.id < ${before}::uuid` : Prisma.empty;
      return this.tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT e.id FROM expense e WHERE e.organization_id = ${this.organizationId}::uuid
        AND e.property_id = ${propertyId}::uuid AND (e.purpose ILIKE ${pattern} OR e.id::text = ${query})
        ${cursor} ORDER BY e.id DESC LIMIT 21`);
    }
    const cursor = before ? Prisma.sql`AND i.id < ${before}::uuid` : Prisma.empty;
    return this.tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT i.id FROM supplier_invoice i WHERE i.organization_id = ${this.organizationId}::uuid
      AND i.archived_at IS NULL AND (i.reference ILIKE ${pattern} OR i.invoice_number ILIKE ${pattern} OR i.id::text = ${query})
      AND EXISTS (SELECT 1 FROM supplier_invoice_line l WHERE l.organization_id = i.organization_id
        AND l.property_id = ${propertyId}::uuid AND l.revision_id = i.current_revision_id)
      ${cursor} ORDER BY i.id DESC LIMIT 21`);
  }

  currency(code: string) {
    return this.tx.currency.findUnique({ where: { code }, select: { minorUnit: true } });
  }

  lockNonce(actorId: string, nonce: string) {
    const key = ["maintenance-finance", this.organizationId, actorId, nonce].join(":");
    return this.tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
  }

  async record(value: NewFinanceRow) {
    const [result] = await this.tx.$queryRaw<Array<Pick<FinanceRow, "id" | "createdAt">>>(Prisma.sql`
      INSERT INTO maintenance_work_order_finance (organization_id, task_id, actor_id, idempotency_key,
        request_hash, estimate_revision, expense_id, invoice_id, source_version, amount, currency, reason, snapshot)
      VALUES (${this.organizationId}::uuid, ${value.taskId}::uuid, ${value.actorId}::uuid, ${value.idempotencyKey}::uuid,
        ${value.requestHash}, ${value.estimateRevision}, ${value.expenseId}::uuid, ${value.invoiceId}::uuid,
        ${value.sourceVersion ?? null}, ${value.amount}::decimal(18,2), ${value.currency}, ${value.reason}, ${JSON.stringify(value.snapshot)}::jsonb)
      RETURNING id, created_at AS "createdAt"`);
    return result;
  }
}
