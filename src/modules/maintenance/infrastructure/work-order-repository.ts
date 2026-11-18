import {Prisma} from "@prisma/client";
import type {TenantTransaction} from "@/platform/db/tenant";
import {OutboxRepository} from "@/platform/events/outbox-repository";
import type {WorkOrderRegistrationReceipt} from "../domain/work-order";

export class WorkOrderRepository{
 readonly outbox:OutboxRepository;
 constructor(readonly tx:TenantTransaction,readonly organizationId:string){this.outbox=new OutboxRepository(tx,organizationId);}
 lockActor(actorId:string,nonce:string){return this.tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${"maintenance-work-order-command:"+this.organizationId+":"+actorId+":"+nonce},0))`);}
 lockTask(taskId:string){return this.tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${"maintenance-work-order:"+this.organizationId+":"+taskId},0))`);}
 async clock(){return(await this.tx.$queryRaw<Array<{now:Date}>>`SELECT date_trunc('milliseconds',clock_timestamp()) AS now`)[0].now;}
 async original(taskId:string):Promise<unknown>{return(await this.tx.$queryRaw<Array<{snapshot:unknown}>>(Prisma.sql`SELECT snapshot FROM maintenance_work_order WHERE organization_id=${this.organizationId}::uuid AND id=${taskId}::uuid`))[0]?.snapshot??null;}
 async nativeFingerprint(issueId:string,taskId:string){return(await this.tx.$queryRaw<Array<{fingerprint:string|null}>>(Prisma.sql`SELECT app_maintenance_work_order_fingerprint(${this.organizationId}::uuid,${issueId}::uuid,${taskId}::uuid) AS fingerprint`))[0].fingerprint;}
 candidates(propertyId:string,query:string,before?:string){const pattern="%"+query.replace(/[\\%_]/gu,value=>"\\"+value)+"%";return this.tx.$queryRaw<Array<{id:string}>>(Prisma.sql`SELECT t.id FROM operation_task t WHERE t.organization_id=${this.organizationId}::uuid AND t.property_id=${propertyId}::uuid AND t.type='MAINTENANCE' AND t.archived_at IS NULL AND t.title_translations::text ILIKE ${pattern} AND NOT EXISTS(SELECT 1 FROM maintenance_work_order w WHERE w.organization_id=t.organization_id AND w.id=t.id) ${before?Prisma.sql`AND t.id<${before}::uuid`:Prisma.empty} ORDER BY t.id DESC LIMIT 21`);}
 forIssue(issueId:string,before?:string){return this.tx.$queryRaw<Array<{id:string;createdAt:Date}>>(Prisma.sql`SELECT id,created_at AS "createdAt" FROM maintenance_work_order WHERE organization_id=${this.organizationId}::uuid AND issue_id=${issueId}::uuid ${before?Prisma.sql`AND id<${before}::uuid`:Prisma.empty} ORDER BY id DESC LIMIT 21`);}
 async insert(value:WorkOrderRegistrationReceipt){await this.tx.$executeRaw(Prisma.sql`INSERT INTO maintenance_work_order(id,organization_id,issue_id,actor_id,idempotency_key,native_fingerprint,source_fingerprint,review_fingerprint,request_hash,snapshot,reason,created_at)VALUES(${value.taskId}::uuid,${this.organizationId}::uuid,${value.intent.issueId}::uuid,${value.actorId}::uuid,${value.idempotencyKey}::uuid,${value.nativeFingerprint},${value.sourceFingerprint},${value.reviewFingerprint},${value.requestHash},${JSON.stringify(value)}::jsonb,${value.intent.reason},${new Date(value.createdAt)})`);}
}
