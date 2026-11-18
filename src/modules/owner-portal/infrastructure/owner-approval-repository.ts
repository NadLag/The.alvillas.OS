import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";

type Candidate = { approvalId: string; stageId: string; ownerId: string; propertyId: string; propertyName: string;
  amount: string; currency: string; source: "maintenance" | "expense" | "invoice" };

export class OwnerApprovalRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}

  pending(accountId: string, propertyId: string, command?: { id: string; stageId: string }, after?: string, allowReplay = false) {
    const selected = command ? Prisma.sql`AND a.id=${command.id}::uuid AND s.id=${command.stageId}::uuid` : Prisma.empty;
    const cursor = after ? Prisma.sql`AND s.id<${after}::uuid` : Prisma.empty;
    const retry = allowReplay ? Prisma.sql`OR (s.decided_by=${accountId}::uuid AND s.state IN ('APPROVED','REJECTED'))` : Prisma.empty;
    return this.tx.$queryRaw<Candidate[]>(Prisma.sql`
      SELECT a.id AS "approvalId",s.id AS "stageId",s.owner_id AS "ownerId",p.id AS "propertyId",p.name AS "propertyName",
        s.amount::text,s.currency,CASE WHEN a.maintenance_estimate_id IS NOT NULL THEN 'maintenance'
          WHEN a.invoice_submission_id IS NOT NULL THEN 'invoice' ELSE 'expense' END AS source
      FROM approval_stage s
      JOIN approval_request a ON a.organization_id=s.organization_id AND a.id=s.approval_id
      JOIN approval_stage_recipient recipient ON recipient.organization_id=s.organization_id AND recipient.stage_id=s.id
        AND recipient.user_account_id=${accountId}::uuid
      JOIN property p ON p.organization_id=s.organization_id AND p.id=coalesce(s.property_id,a.property_id) AND p.archived_at IS NULL
      WHERE s.organization_id=${this.organizationId}::uuid AND p.id=${propertyId}::uuid AND s.kind='owner'
        AND (a.expense_id IS NOT NULL OR a.invoice_submission_id IS NOT NULL OR a.maintenance_estimate_id IS NOT NULL)
        AND ((a.state='PENDING' AND s.state='PENDING' AND NOT EXISTS (SELECT 1 FROM approval_stage prior
          WHERE prior.organization_id=s.organization_id AND prior.approval_id=s.approval_id AND prior.position<s.position AND prior.state='PENDING')) ${retry})
        AND EXISTS (SELECT 1 FROM property_owner link JOIN owner o ON o.organization_id=link.organization_id AND o.id=link.owner_id AND o.archived_at IS NULL
          JOIN active_owner_portal_access access ON access.organization_id=link.organization_id AND access.owner_id=link.owner_id AND access.can_view_finances
          WHERE link.organization_id=s.organization_id AND link.property_id=p.id AND link.owner_id=s.owner_id AND link.archived_at IS NULL
            AND access.user_account_id=${accountId}::uuid)
      ${selected} ${cursor} ORDER BY s.id DESC LIMIT 26`);
  }
}
