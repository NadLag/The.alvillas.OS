import { Prisma, type PrismaClient } from "@prisma/client";

const historyTables = [
  "_prisma_migrations", "audit_log", "financial_transaction", "posting",
  "inventory_item", "inventory_location", "inventory_movement", "inventory_stocktake", "automation_suggestion"
] as const;
type HistoryTable = (typeof historyTables)[number];
type HistoryColumn = { source: HistoryTable; name: string };
export type StagingHistoryRow = { source: HistoryTable; id: string; digest: string };

export async function captureStagingHistory(client: PrismaClient, originalColumns?: readonly HistoryColumn[]) {
  return client.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('TimeZone', 'UTC', true), set_config('DateStyle', 'ISO,YMD', true),
      set_config('IntervalStyle', 'postgres', true), set_config('bytea_output', 'hex', true),
      set_config('row_security', 'off', true)`;
    const columns = originalColumns ?? await tx.$queryRaw<HistoryColumn[]>`
      SELECT table_name AS source, column_name AS name FROM information_schema.columns
      WHERE table_schema='public' AND table_name IN (${Prisma.join(historyTables)})
    `;
    if (historyTables.some(table => !columns.some(column => column.source === table && column.name === "id"))) {
      throw new Error("The existing staging history could not be identified");
    }
    const fields = Prisma.join(columns.map(column => Prisma.sql`(${column.source}::text, ${column.name}::text)`));
    const rows = await tx.$queryRaw<StagingHistoryRow[]>`
      WITH fields(source, name) AS (VALUES ${fields}),
      records(source, id, record) AS (
        SELECT '_prisma_migrations', id::text, to_jsonb(t) FROM public._prisma_migrations t
        UNION ALL SELECT 'audit_log', id::text, to_jsonb(t) FROM public.audit_log t
        UNION ALL SELECT 'financial_transaction', id::text, to_jsonb(t) FROM public.financial_transaction t
        UNION ALL SELECT 'posting', id::text, to_jsonb(t) FROM public.posting t
        UNION ALL SELECT 'inventory_item', id::text, to_jsonb(t) FROM public.inventory_item t
        UNION ALL SELECT 'inventory_location', id::text, to_jsonb(t) FROM public.inventory_location t
        UNION ALL SELECT 'inventory_movement', id::text, to_jsonb(t) FROM public.inventory_movement t
        UNION ALL SELECT 'inventory_stocktake', id::text, to_jsonb(t) FROM public.inventory_stocktake t
        UNION ALL SELECT 'automation_suggestion', id::text, to_jsonb(t) FROM public.automation_suggestion t
      )
      SELECT r.source, r.id, encode(sha256(convert_to((
        SELECT jsonb_object_agg(f.name, r.record -> f.name) FROM fields f WHERE f.source=r.source
      )::text, 'UTF8')), 'hex') AS digest
      FROM records r
    `;
    return { columns, rows };
  }, { isolationLevel: "RepeatableRead", timeout: 30_000 });
}

export function compareStagingHistory(original: readonly StagingHistoryRow[], current: readonly StagingHistoryRow[]) {
  const present = new Set(current.map(row => `${row.source}|${row.id}|${row.digest}`));
  return historyTables.map(table => {
    const rows = original.filter(row => row.source === table);
    return { table, original: rows.length, changed: rows.filter(row => !present.has(`${row.source}|${row.id}|${row.digest}`)).length };
  });
}
