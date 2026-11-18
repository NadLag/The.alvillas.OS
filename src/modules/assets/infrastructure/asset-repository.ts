import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import type { AssetFields } from "../domain/asset";

export type AssetProperty = { propertyId: string; propertyName: string; cityId: string | null; regionId: string | null; timezone: string };
export type AssetHead = AssetProperty & {
  id: string; tag: string; revisionId: string; number: number; actorId: string; name: string; category: string;
  description: string; condition: AssetFields["condition"]; purchaseOn: string | null; purchaseAmount: string | null;
  currency: string | null; warrantyProvider: string | null; warrantyReference: string | null; warrantyStartsOn: string | null;
  warrantyEndsOn: string | null; usefulLifeMonths: number | null; reason: string; createdAt: Date;
};
const propertyColumns = Prisma.sql`p.id AS "propertyId", p.name AS "propertyName", p.city_id AS "cityId", p.region_id AS "regionId", p.timezone`;
const columns = Prisma.sql`${propertyColumns}, a.id, a.tag, r.id AS "revisionId", r.number, r.actor_id AS "actorId", r.name, r.category,
  r.description, r.condition, r.purchase_on::text AS "purchaseOn", r.purchase_amount::text AS "purchaseAmount", r.currency,
  r.warranty_provider AS "warrantyProvider", r.warranty_reference AS "warrantyReference", r.warranty_starts_on::text AS "warrantyStartsOn",
  r.warranty_ends_on::text AS "warrantyEndsOn", r.useful_life_months AS "usefulLifeMonths", r.reason, r.created_at AS "createdAt"`;
const joins = Prisma.sql`FROM asset a
  JOIN property p ON p.organization_id = a.organization_id AND p.id = a.property_id AND p.archived_at IS NULL`;
const latest = Prisma.sql`JOIN LATERAL (SELECT * FROM asset_revision r WHERE r.organization_id=a.organization_id
  AND r.asset_id=a.id ORDER BY r.number DESC LIMIT 1) r ON TRUE`;
function pattern(query: string) { return "%" + query.replace(/[\\%_]/gu, value => "\\" + value) + "%"; }

export class AssetRepository {
  constructor(readonly tx: TenantTransaction, readonly organizationId: string) {}

  async clock() {
    const [row] = await this.tx.$queryRaw<Array<{ now: Date }>>`SELECT date_trunc('milliseconds', clock_timestamp()) AS now`;
    return row.now;
  }

  async lock(key: string) {
    await this.tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${"asset:" + this.organizationId + ":" + key}, 0))`);
  }

  async property(id: string) {
    const [row] = await this.tx.$queryRaw<AssetProperty[]>(Prisma.sql`SELECT ${propertyColumns} FROM property p
      WHERE p.organization_id=${this.organizationId}::uuid AND p.id=${id}::uuid AND p.archived_at IS NULL`);
    return row;
  }

  properties(query: string, after?: string) {
    const cursor = after ? Prisma.sql`AND p.id < ${after}::uuid` : Prisma.empty;
    return this.tx.$queryRaw<AssetProperty[]>(Prisma.sql`SELECT ${propertyColumns} FROM property p
      WHERE p.organization_id=${this.organizationId}::uuid AND p.archived_at IS NULL AND p.name ILIKE ${pattern(query)}
      ${cursor} ORDER BY p.id DESC LIMIT 41`);
  }

  async find(id: string) {
    const [row] = await this.tx.$queryRaw<AssetHead[]>(Prisma.sql`SELECT ${columns} ${joins} ${latest}
      WHERE a.organization_id=${this.organizationId}::uuid AND a.id=${id}::uuid`);
    return row;
  }

  history(id: string, before?: number) {
    const cursor = before ? Prisma.sql`AND r.number < ${before}` : Prisma.empty;
    return this.tx.$queryRaw<AssetHead[]>(Prisma.sql`SELECT ${columns} ${joins}
      JOIN asset_revision r ON r.organization_id=a.organization_id AND r.asset_id=a.id
      WHERE a.organization_id=${this.organizationId}::uuid AND a.id=${id}::uuid ${cursor}
      ORDER BY r.number DESC LIMIT 26`);
  }

  search(query: string, propertyId?: string, after?: string) {
    const property = propertyId ? Prisma.sql`AND a.property_id=${propertyId}::uuid` : Prisma.empty;
    const cursor = after ? Prisma.sql`AND a.id < ${after}::uuid` : Prisma.empty;
    const search = pattern(query);
    return this.tx.$queryRaw<AssetHead[]>(Prisma.sql`SELECT ${columns} ${joins} ${latest}
      WHERE a.organization_id=${this.organizationId}::uuid ${property} ${cursor}
        AND (a.tag ILIKE ${search} OR r.name ILIKE ${search} OR r.category ILIKE ${search})
      ORDER BY a.id DESC LIMIT 41`);
  }

  async receipt(actorId: string, nonce: string) {
    const [row] = await this.tx.$queryRaw<Array<{ assetId: string; number: number; requestHash: string }>>(Prisma.sql`
      SELECT asset_id AS "assetId", number, request_hash AS "requestHash" FROM asset_revision
      WHERE organization_id=${this.organizationId}::uuid AND actor_id=${actorId}::uuid AND idempotency_key=${nonce}::uuid`);
    return row;
  }

  async create(propertyId: string, tag: string) {
    const [asset] = await this.tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`INSERT INTO asset(organization_id,property_id,tag)
      VALUES (${this.organizationId}::uuid,${propertyId}::uuid,${tag})
      ON CONFLICT (organization_id,tag) DO NOTHING RETURNING id`);
    return asset;
  }

  async append(value: { assetId: string; number: number; actorId: string; idempotencyKey: string; requestHash: string; reason: string; fields: AssetFields; now: Date }) {
    const { fields: f } = value;
    const [revision] = await this.tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`INSERT INTO asset_revision
      (organization_id,asset_id,number,actor_id,idempotency_key,request_hash,name,category,description,condition,purchase_on,
       purchase_amount,currency,warranty_provider,warranty_reference,warranty_starts_on,warranty_ends_on,useful_life_months,reason,created_at)
      VALUES (${this.organizationId}::uuid,${value.assetId}::uuid,${value.number},${value.actorId}::uuid,${value.idempotencyKey}::uuid,
        ${value.requestHash},${f.name},${f.category},${f.description},${f.condition},${f.purchaseOn}::date,
        ${f.cost?.amount ?? null}::decimal(18,2),${f.cost?.currency ?? null},${f.warrantyProvider},${f.warrantyReference},
        ${f.warrantyStartsOn}::date,${f.warrantyEndsOn}::date,${f.usefulLifeMonths},${value.reason},${value.now}) RETURNING id`);
    return revision;
  }

  currency(code: string) {
    return this.tx.currency.findUnique({ where: { code }, select: { minorUnit: true } });
  }
}
