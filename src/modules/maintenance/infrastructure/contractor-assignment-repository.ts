import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";

type Assignment = {
  id: string; taskId: string; contractorId: string | null; actorId: string; requestHash: string;
  revision: number; priority: string | null; reason: string; createdAt: Date;
  responseDueAt: Date | null; completionDueAt: Date | null; supersededAt: Date | null;
};
type NewAssignment = Pick<Assignment, "taskId" | "contractorId" | "actorId" | "revision" | "priority" | "reason" |
  "requestHash" | "createdAt" | "responseDueAt" | "completionDueAt"> & { idempotencyKey: string; ruleId: string | null };
const columns = Prisma.sql`a.id, a.task_id AS "taskId", a.contractor_id AS "contractorId", a.actor_id AS "actorId",
  a.request_hash AS "requestHash", a.revision, a.priority, a.reason, a.created_at AS "createdAt",
  a.response_due_at AS "responseDueAt", a.completion_due_at AS "completionDueAt"`;

export class ContractorAssignmentRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}

  async byNonce(actorId: string, nonce: string) {
    const [row] = await this.tx.$queryRaw<Array<Pick<Assignment, "id" | "requestHash">>>(Prisma.sql`
      SELECT id, request_hash AS "requestHash" FROM maintenance_contractor_assignment
      WHERE organization_id = ${this.organizationId}::uuid AND actor_id = ${actorId}::uuid AND idempotency_key = ${nonce}::uuid`);
    return row;
  }

  history(taskId: string, take: number, before: string | undefined) {
    const cursor = before ? Prisma.sql`AND a.id < ${before}::uuid` : Prisma.empty;
    return this.tx.$queryRaw<Assignment[]>(Prisma.sql`SELECT ${columns},
      (SELECT newer.created_at FROM maintenance_contractor_assignment newer WHERE newer.organization_id = a.organization_id
       AND newer.task_id = a.task_id AND newer.revision = a.revision + 1) AS "supersededAt"
      FROM maintenance_contractor_assignment a WHERE a.organization_id = ${this.organizationId}::uuid
      AND a.task_id = ${taskId}::uuid ${cursor} ORDER BY a.revision DESC LIMIT ${take}`);
  }

  async milestones(taskId: string, assignedAt: Date, until: Date) {
    const [milestones] = await this.tx.$queryRaw<Array<{ responseAt: Date | null; closedAt: Date | null }>>(Prisma.sql`
      SELECT min(occurred_at) FILTER (WHERE after->>'state' = 'IN_PROGRESS' AND before->>'state' IS DISTINCT FROM 'IN_PROGRESS') AS "responseAt",
        min(occurred_at) FILTER (WHERE after->>'state' IN ('CANCELLED', 'SKIPPED') AND before->>'state' IS DISTINCT FROM after->>'state') AS "closedAt"
      FROM operation_task_event WHERE organization_id = ${this.organizationId}::uuid
      AND task_id = ${taskId}::uuid AND occurred_at >= ${assignedAt}::timestamptz AND occurred_at <= ${until}::timestamptz
      AND kind = 'CHANGED'`);
    return milestones;
  }

  async append(value: NewAssignment) {
    const [row] = await this.tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`INSERT INTO maintenance_contractor_assignment
      (organization_id, task_id, contractor_id, rule_id, actor_id, revision, idempotency_key, priority,
       response_due_at, completion_due_at, reason, request_hash, created_at)
      VALUES (${this.organizationId}::uuid, ${value.taskId}::uuid, ${value.contractorId}::uuid, ${value.ruleId}::uuid,
        ${value.actorId}::uuid, ${value.revision}, ${value.idempotencyKey}::uuid, ${value.priority},
        ${value.responseDueAt}, ${value.completionDueAt}, ${value.reason}, ${value.requestHash}, ${value.createdAt})
      RETURNING id`);
    return row;
  }
}
