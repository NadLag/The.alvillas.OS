import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";

export class CashCustodyRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}
  async clock() {
    const [row] = await this.tx.$queryRaw<Array<{ now: Date; id: string }>>(Prisma.sql`SELECT date_trunc('milliseconds', clock_timestamp()) AS now, app_uuid_v7()::text AS id`);
    return row;
  }
  async count(taskId: string, at?: Date) {
    const [row] = await this.tx.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`SELECT count(*) AS count FROM cash_collection
      WHERE organization_id=${this.organizationId}::uuid AND task_id=${taskId}::uuid ${at ? Prisma.sql`AND recorded_at < ${at}` : Prisma.empty}`);
    return row.count;
  }
  operation(deviceId: string, clientOpId: string) {
    return this.tx.cashCollection.findUnique({ where: { organizationId_deviceId_clientOpId: { organizationId: this.organizationId, deviceId, clientOpId } } });
  }
  currency(code: string) { return this.tx.currency.findUnique({ where: { code }, select: { code: true, minorUnit: true } }); }
  async currencies() {
    const [organization, currencies] = await Promise.all([
      this.tx.organization.findUniqueOrThrow({ where: { id: this.organizationId }, select: { baseCurrency: true } }),
      this.tx.currency.findMany({ where: { minorUnit: { lte: 2 } }, orderBy: { code: "asc" }, select: { code: true, minorUnit: true } })
    ]);
    return { baseCurrency: organization.baseCurrency, currencies };
  }
  receipt(id: string) {
    return this.tx.cashCollection.findFirst({ where: { organizationId: this.organizationId, id },
      include: { property: { select: { city: true, cityId: true, region: true, regionId: true } } } });
  }
  financialSnapshot(reservationId: string) {
    return this.tx.reservationFinancialSnapshot.findFirst({ where: { organizationId: this.organizationId, reservationId,
      rules: { path: ["owners"], array_contains: [] } }, orderBy: { version: "asc" }, select: { id: true, version: true, rules: true } });
  }
  record(data: Omit<Prisma.CashCollectionUncheckedCreateInput, "organizationId">) {
    return this.tx.cashCollection.create({ data: { ...data, organizationId: this.organizationId } });
  }
  async positions(taskIds: string[], at: Date) {
    if (!taskIds.length) return new Map<string, bigint>();
    const rows = await this.tx.$queryRaw<Array<{ taskId: string; count: bigint }>>(Prisma.sql`SELECT task_id AS "taskId", count(*) AS count
      FROM cash_collection WHERE organization_id=${this.organizationId}::uuid AND task_id IN (${Prisma.join(taskIds.map(id => Prisma.sql`${id}::uuid`))})
      AND recorded_at < ${at} GROUP BY task_id`);
    return new Map(rows.map(row => [row.taskId, row.count]));
  }
  async ownReceipts(taskIds: string[], actorId: string, at: Date, after?: { at: Date; id: string }) {
    if (!taskIds.length) return [];
    return this.tx.$queryRaw<Array<{ id: string; taskId: string; propertyId: string; reservationId: string | null; city: string; region: string | null;
      transactionId: string; collectorPersonId: string; amount: string; currency: string; payer: string; purpose: string; recordedAt: Date }>>(Prisma.sql`
      SELECT c.id,c.task_id AS "taskId",c.property_id AS "propertyId",c.reservation_id AS "reservationId",
        COALESCE(p.city_id::text,p.city) AS city,COALESCE(p.region_id::text,p.region) AS region,
        c.transaction_id AS "transactionId",c.collector_person_id AS "collectorPersonId",c.amount::text AS amount,
        c.currency,c.payer,c.purpose,c.recorded_at AS "recordedAt" FROM cash_collection c
      JOIN property p ON p.organization_id=c.organization_id AND p.id=c.property_id
      WHERE c.organization_id=${this.organizationId}::uuid AND c.collector_user_account_id=${actorId}::uuid
        AND c.task_id IN (${Prisma.join(taskIds.map(id => Prisma.sql`${id}::uuid`))}) AND c.recorded_at < ${at}
        ${after ? Prisma.sql`AND (c.recorded_at,c.id)<(${after.at},${after.id}::uuid)` : Prisma.empty}
      ORDER BY c.recorded_at DESC,c.id DESC LIMIT 100`);
  }
}
