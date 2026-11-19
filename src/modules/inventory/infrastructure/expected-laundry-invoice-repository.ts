import {Prisma} from "@prisma/client";
import type {TenantTransaction} from "@/platform/db/tenant";
import {OutboxRepository} from "@/platform/events/outbox-repository";
import type {ExpectedLaundryInvoiceReceipt} from "../domain/expected-laundry-command";
export type ExpectedLaundryInvoiceHead={id:string;batchId:string;quoteVersionId:string;pricingPropertyId:string|null;createdBy:string;createdAt:Date;version:string};
/** Immutable assessments reference the native quote and custody sequence. They
 * never create a supplier invoice, financial posting or physical movement. */
export class ExpectedLaundryInvoiceRepository{
 readonly outbox:OutboxRepository;
 constructor(readonly tx:TenantTransaction,readonly organizationId:string){this.outbox=new OutboxRepository(tx,organizationId);}
 async identity(){return(await this.tx.$queryRaw<Array<{id:string;now:Date}>>(Prisma.sql`SELECT app_uuid_v7()::text AS id,date_trunc('milliseconds',clock_timestamp()) AS now`))[0];}
 lockCommand(nonce:string){return this.tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${"expected-laundry:"+this.organizationId+":"+nonce},0))`);}
 async head(id:string):Promise<ExpectedLaundryInvoiceHead|null>{return(await this.tx.$queryRaw<ExpectedLaundryInvoiceHead[]>(Prisma.sql`SELECT id,batch_id AS "batchId",quote_version_id AS "quoteVersionId",pricing_property_id AS "pricingPropertyId",created_by AS "createdBy",created_at AS "createdAt",xmin::text||':'||ctid::text AS version FROM laundry_expected_invoice WHERE organization_id=${this.organizationId}::uuid AND id=${id}::uuid`))[0]??null;}
 async original(id:string):Promise<unknown>{return(await this.tx.$queryRaw<Array<{snapshot:unknown}>>(Prisma.sql`SELECT snapshot FROM laundry_expected_invoice WHERE organization_id=${this.organizationId}::uuid AND id=${id}::uuid`))[0]?.snapshot??null;}
 page(batchId:string,before?:string){return this.tx.$queryRaw<Array<{id:string}>>(Prisma.sql`SELECT id FROM laundry_expected_invoice WHERE organization_id=${this.organizationId}::uuid AND batch_id=${batchId}::uuid ${before?Prisma.sql`AND id<${before}::uuid`:Prisma.empty} ORDER BY id DESC LIMIT 21`);}
 async insert(value:ExpectedLaundryInvoiceReceipt){const d=value.draft;return this.tx.$executeRaw(Prisma.sql`INSERT INTO laundry_expected_invoice(id,organization_id,batch_id,quote_version_id,pricing_property_id,price_at,batch_sequence,status,currency,total,source_fingerprint,request_hash,review_fingerprint,idempotency_key,snapshot,reason,created_by,created_at)VALUES(${value.assessmentId}::uuid,${this.organizationId}::uuid,${d.batchId}::uuid,${d.quoteVersionId}::uuid,${d.pricingPropertyId}::uuid,${new Date(d.priceAt)},${value.batchSequence},${value.result.status},${value.result.currency},${value.result.total}::numeric,${value.sourceFingerprint},${value.requestHash},${value.reviewFingerprint},${value.idempotencyKey}::uuid,${JSON.stringify(value)}::jsonb,${d.reason},${value.actorId}::uuid,${new Date(value.createdAt)})`);}
}
