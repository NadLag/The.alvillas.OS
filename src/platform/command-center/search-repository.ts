import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";

export const nativeSearchKinds = ["property", "reservation", "task", "issue", "asset", "owner", "supplier"] as const;
export type NativeSearchKind = typeof nativeSearchKinds[number];
type Candidate = { id: string; propertyId: string | null; city: string | null; region: string | null;
  title: string; labels: unknown; status: string | null; assignedPersonId: string | null; assignedUserAccountId: string | null };

export class CommandSearchRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}

  candidates(kind: NativeSearchKind, term: string, after?: string) {
    const org = this.organizationId, literal = "%" + term.replace(/[\\%_]/gu, char => "\\" + char) + "%";
    const match = (field: Prisma.Sql) => Prisma.sql`(to_tsvector('simple'::regconfig,${field}) @@ websearch_to_tsquery('simple'::regconfig,${term})
      OR (${field}) % ${term} OR (${field}) ILIKE ${literal})`;
    const cursor = after ? Prisma.sql`AND source.id<${after}::uuid` : Prisma.empty;
    const nullProperty = Prisma.sql`NULL::uuid AS "propertyId",NULL::text AS city,NULL::text AS region`;
    const geo = Prisma.sql`property.id AS "propertyId",coalesce(property.city_id::text,property.city) AS city,
      coalesce(property.region_id::text,property.region) AS region`;
    const placeholders = Prisma.sql`NULL::jsonb AS labels,NULL::text AS status,
      NULL::uuid AS "assignedPersonId",NULL::uuid AS "assignedUserAccountId"`;
    const byProperty = Prisma.sql`JOIN property ON (property.organization_id,property.id)=(source.organization_id,source.property_id)
      AND property.archived_at IS NULL`;
    const taskTitle = Prisma.sql`coalesce(source.title_translations->>'en','') || ' ' ||
      coalesce(source.title_translations->>'fr','') || ' ' || coalesce(source.title_translations->>'ar','')`;
    const source = {
      property: () => Prisma.sql`SELECT source.id,source.name AS title,source.id AS "propertyId",
        coalesce(source.city_id::text,source.city) AS city,coalesce(source.region_id::text,source.region) AS region,${placeholders}
        FROM property source WHERE source.organization_id=${org}::uuid AND source.archived_at IS NULL
          AND ${match(Prisma.sql`source.name`)} ${cursor}`,
      reservation: () => Prisma.sql`SELECT source.id,source.reference AS title,${geo},NULL::jsonb AS labels,source.status,
        NULL::uuid AS "assignedPersonId",NULL::uuid AS "assignedUserAccountId"
        FROM reservation source ${byProperty} WHERE source.organization_id=${org}::uuid AND source.archived_at IS NULL
          AND ${match(Prisma.sql`source.reference`)} ${cursor}`,
      task: () => Prisma.sql`SELECT source.id,source.type AS title,${geo},source.title_translations AS labels,source.state AS status,
        source.assigned_to_person_id AS "assignedPersonId",source.assigned_to_user_account_id AS "assignedUserAccountId"
        FROM operation_task source ${byProperty} WHERE source.organization_id=${org}::uuid AND source.archived_at IS NULL
          AND ${match(taskTitle)} ${cursor}`,
      issue: () => Prisma.sql`SELECT source.id,source.title,${geo},${placeholders}
        FROM operation_issue source ${byProperty} WHERE source.organization_id=${org}::uuid AND ${match(Prisma.sql`source.title`)} ${cursor}`,
      asset: () => Prisma.sql`SELECT source.id,revision.name AS title,${geo},${placeholders}
        FROM asset source ${byProperty}
        JOIN LATERAL (SELECT name FROM asset_revision WHERE organization_id=source.organization_id AND asset_id=source.id ORDER BY number DESC LIMIT 1) revision ON true
        WHERE source.organization_id=${org}::uuid AND (${match(Prisma.sql`source.tag`)} OR ${match(Prisma.sql`revision.name`)}) ${cursor}`,
      owner: () => Prisma.sql`SELECT source.id,source.display_name AS title,${nullProperty},${placeholders}
        FROM owner source WHERE source.organization_id=${org}::uuid AND source.archived_at IS NULL
          AND ${match(Prisma.sql`source.display_name`)} ${cursor}`,
      supplier: () => Prisma.sql`SELECT source.id,source.display_name AS title,${nullProperty},${placeholders}
        FROM supplier source WHERE source.organization_id=${org}::uuid AND source.archived_at IS NULL
          AND ${match(Prisma.sql`source.display_name`)} ${cursor}`
    };
    return this.tx.$queryRaw<Candidate[]>(Prisma.sql`${source[kind]()} ORDER BY source.id DESC LIMIT 50`);
  }
}
