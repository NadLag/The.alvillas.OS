import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import { terminalTaskStates } from "../domain/operation-task";

export type TodayProperty = { id: string; name: string; city: string; cityId: string | null; region: string | null; regionId: string | null };
export type TodayStay = { id: string; reference: string; status: string; localDay: string; arrival: boolean; departure: boolean; property: TodayProperty };
export type TodayTask = {
  id: string; organizationId: string; propertyId: string; localDay: string; state: string;
  title: unknown; assignedToPersonId: string | null; assignedToUserAccountId: string | null; property: TodayProperty;
};

export class CommandCenterTodayRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}

  private properties(at: Date) {
    return Prisma.sql`
      SELECT property.id, (${at}::timestamptz AT TIME ZONE property.timezone)::date AS local_day,
        jsonb_build_object('id',property.id,'name',property.name,'city',property.city,'cityId',property.city_id,
          'region',property.region,'regionId',property.region_id) AS resource
      FROM property WHERE organization_id=${this.organizationId}::uuid AND archived_at IS NULL`;
  }

  stays(at: Date) {
    return this.tx.$queryRaw<TodayStay[]>(Prisma.sql`
      WITH properties AS (${this.properties(at)})
      SELECT stay.id,stay.reference,stay.status,p.local_day::text AS "localDay",p.resource AS property,
        stay.check_in=p.local_day AS arrival,stay.check_out=p.local_day AS departure
      FROM properties p JOIN reservation stay ON stay.organization_id=${this.organizationId}::uuid AND stay.property_id=p.id
      WHERE stay.archived_at IS NULL AND stay.status NOT IN ('IMPORTED','CANCELLED','NO_SHOW')
        AND (stay.check_in=p.local_day OR stay.check_out=p.local_day)
      ORDER BY p.local_day,p.resource->>'name',stay.reference,stay.id`);
  }

  jobs(at: Date) {
    return this.tx.$queryRaw<TodayTask[]>(Prisma.sql`
      WITH properties AS (${this.properties(at)})
      SELECT task.id,task.organization_id AS "organizationId",p.id AS "propertyId",p.local_day::text AS "localDay",
        task.state,task.title_translations AS title,p.resource AS property,
        task.assigned_to_person_id AS "assignedToPersonId",task.assigned_to_user_account_id AS "assignedToUserAccountId"
      FROM properties p JOIN operation_task task ON task.organization_id=${this.organizationId}::uuid AND task.property_id=p.id
      WHERE task.archived_at IS NULL AND task.due_date=p.local_day AND task.state NOT IN (${Prisma.join(terminalTaskStates)})
      ORDER BY p.local_day,p.resource->>'name',task.scheduled_start NULLS LAST,task.id`);
  }
}
