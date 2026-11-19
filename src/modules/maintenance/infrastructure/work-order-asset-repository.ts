import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
type Edition = { id: string; assetId: string | null; number: number; reason: string; at: Date };
export class WorkOrderAssetRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}

  list(taskId: string, limit: number, before?: number) {
    const boundary = before ? Prisma.sql`AND number < ${before}` : Prisma.empty;
    return this.tx.$queryRaw<Edition[]>(Prisma.sql`SELECT id,asset_id AS "assetId",number,reason,created_at AS at
      FROM maintenance_work_order_asset WHERE organization_id=${this.organizationId}::uuid AND task_id=${taskId}::uuid
      ${boundary} ORDER BY number DESC LIMIT ${limit}`);
  }

  async receipt(actorId: string, nonce: string) {
    const [row] = await this.tx.$queryRaw<Array<{ requestHash: string }>>(Prisma.sql`SELECT request_hash AS "requestHash"
      FROM maintenance_work_order_asset WHERE organization_id=${this.organizationId}::uuid
        AND actor_id=${actorId}::uuid AND idempotency_key=${nonce}::uuid`);
    return row;
  }

  async append(value: { taskId: string; assetId: string | null; assetRevisionId: string | null; actorId: string; number: number;
    idempotencyKey: string; reason: string; requestHash: string; at: Date }) {
    const [row] = await this.tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`INSERT INTO maintenance_work_order_asset
      (organization_id,task_id,asset_id,asset_revision_id,actor_id,number,idempotency_key,reason,request_hash,created_at)
      VALUES (${this.organizationId}::uuid,${value.taskId}::uuid,${value.assetId}::uuid,${value.assetRevisionId}::uuid,
        ${value.actorId}::uuid,${value.number},${value.idempotencyKey}::uuid,${value.reason},${value.requestHash},${value.at})
      RETURNING id`);
    return row;
  }
}
