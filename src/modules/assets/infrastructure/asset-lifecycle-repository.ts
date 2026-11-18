import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import type { AssetLifecycleCommand } from "../domain/asset-lifecycle";

type EventRow = {
  id: string; number: number; kind: AssetLifecycleCommand["kind"]; effectiveOn: string | null;
  successorId: string | null; method: Extract<AssetLifecycleCommand, { kind: "DISPOSE" }>["method"] | null;
  reference: string | null; amount: string | null; currency: string | null; reason: string; createdAt: Date;
};

export class AssetLifecycleRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}

  history(assetId: string, before?: number, limit = 26) {
    const cursor = before ? Prisma.sql`AND number<${before}` : Prisma.empty;
    return this.tx.$queryRaw<EventRow[]>(Prisma.sql`SELECT id,number,kind,effective_on::text AS "effectiveOn",
      successor_id AS "successorId",method,reference,planned_amount::text AS amount,currency,reason,created_at AS "createdAt"
      FROM asset_lifecycle_event WHERE organization_id=${this.organizationId}::uuid AND asset_id=${assetId}::uuid
      ${cursor} ORDER BY number DESC LIMIT ${limit}`);
  }

  async receipt(actorId: string, key: string) {
    const [row] = await this.tx.$queryRaw<Array<{ number: number; requestHash: string }>>(Prisma.sql`
      SELECT number,request_hash AS "requestHash" FROM asset_lifecycle_event
      WHERE organization_id=${this.organizationId}::uuid AND actor_id=${actorId}::uuid AND idempotency_key=${key}::uuid`);
    return row;
  }

  async successorId(propertyId: string, tag: string) {
    const [row] = await this.tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT id FROM asset
      WHERE organization_id=${this.organizationId}::uuid AND property_id=${propertyId}::uuid AND tag=${tag}`);
    return row?.id;
  }

  async lock(ids: string[]) {
    for (const id of [...new Set(ids)].sort()) {
      const key = "asset:" + this.organizationId + ":" + id;
      await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))::text`);
    }
  }

  async hasPredecessor(id: string) {
    const [row] = await this.tx.$queryRaw<Array<{ exists: boolean }>>(Prisma.sql`SELECT EXISTS (
      SELECT 1 FROM asset_lifecycle_event WHERE organization_id=${this.organizationId}::uuid AND successor_id=${id}::uuid
    ) AS exists`);
    return row.exists;
  }

  async active(assetId: string, propertyId: string) {
    const [row] = await this.tx.$queryRaw<Array<{ active: boolean }>>(Prisma.sql`SELECT EXISTS (
      SELECT 1 FROM asset a WHERE a.organization_id=${this.organizationId}::uuid AND a.id=${assetId}::uuid
        AND a.property_id=${propertyId}::uuid AND NOT EXISTS (
          SELECT 1 FROM asset_lifecycle_event e WHERE e.organization_id=a.organization_id AND e.asset_id=a.id AND e.kind IN ('REPLACE','DISPOSE')
        )
    ) AS active`);
    return row.active;
  }

  async append(command: AssetLifecycleCommand, meta: {
    actorId: string; requestHash: string; successorId?: string; budget: { amount: string; currency: string } | null; now: Date
  }) {
    const [row] = await this.tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`INSERT INTO asset_lifecycle_event
      (organization_id,asset_id,actor_id,number,idempotency_key,request_hash,kind,effective_on,successor_id,method,reference,planned_amount,currency,reason,created_at)
      VALUES (${this.organizationId}::uuid,${command.assetId}::uuid,${meta.actorId}::uuid,${command.expectedVersion + 1},
        ${command.idempotencyKey}::uuid,${meta.requestHash},${command.kind},${"effectiveOn" in command ? command.effectiveOn : null}::date,
        ${meta.successorId ?? null}::uuid,${command.kind === "DISPOSE" ? command.method : null},${command.kind === "DISPOSE" ? command.reference : null},
        ${meta.budget?.amount ?? null}::decimal(18,2),${meta.budget?.currency ?? null},${command.reason},${meta.now})
      RETURNING id`);
    return row.id;
  }
}
