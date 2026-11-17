import {Prisma} from "@prisma/client";
import type {TenantTransaction} from "@/platform/db/tenant";
export type TransferTaskRow={taskId:string;orderId:string;propertyId:string;reservationId:string;name:unknown;date:string;timezone:string;guests:number;transfer:unknown};
export class TransferOrderRepository{
 constructor(readonly tx:TenantTransaction,readonly organizationId:string){}
 async taskRequests(ids:readonly string[]):Promise<TransferTaskRow[]>{
  if(!ids.length)return[];
  return this.tx.$queryRaw<TransferTaskRow[]>(Prisma.sql`SELECT o.task_id AS "taskId",o.id AS "orderId",o.property_id AS "propertyId",o.reservation_id AS "reservationId",o.title_translations AS name,to_char(o.service_date,'YYYY-MM-DD') AS date,o.source_witnesses#>>'{property,timezone}' AS timezone,o.guest_count AS guests,o.request_snapshot->'transfer' AS transfer FROM service_order o JOIN operation_task t ON t.organization_id=o.organization_id AND t.id=o.task_id AND t.type='TRANSFER' JOIN property p ON p.organization_id=o.organization_id AND p.id=o.property_id WHERE o.organization_id=${this.organizationId}::uuid AND o.task_id IN (${Prisma.join(ids.map(id=>Prisma.sql`${id}::uuid`))}) AND jsonb_typeof(o.catalog_snapshot#>'{order_terms,transfer_order}')='object'`);
 }
}
