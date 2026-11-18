import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransaction,type TenantTransactionRunner} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {recheckAccountAuthorization} from "@/platform/authz/current-authority";
import {inspectActualLaundryInvoiceSource} from "@/platform/ledger/laundry-invoice-source";
import {actualLaundryInvoiceDraftSchema} from "../domain/actual-laundry-invoice";
import {InventoryCatalogAccessError,InventoryCatalogConflictError} from "../domain/catalog-errors";
import {expectedLaundryAssessmentInTransaction} from "./expected-laundry-invoice-service";
import {verifyLaundryBatchSourcesInTransaction} from "./laundry-batch-service";
type Dependencies={db?:TenantTransactionRunner;requestId?:string};
async function prepare(actor:AccountActorContext,tx:TenantTransaction,draft:ReturnType<typeof actualLaundryInvoiceDraftSchema.parse>){
 const expected=await expectedLaundryAssessmentInTransaction(actor,tx,draft.expectedInvoiceId),batch=expected.batch;if(batch.head.id!==draft.batchId||!batch.head.supplierId)throw new InventoryCatalogAccessError();const propertyIds=[...new Set([...batch.source.stocks[0].locations.flatMap(row=>row.propertyId?[row.propertyId]:[]),...batch.source.stocks[0].reservations.map(row=>row.propertyId)])].sort(),source=await inspectActualLaundryInvoiceSource(actor,tx,draft.selection,{supplierId:batch.head.supplierId,propertyIds,reservationIds:batch.source.stocks[0].reservations.map(row=>row.id)});
 return{expected,batch,source,fingerprint:jsonbFingerprint({expected:expected.value,batch:batch.witness,source:source.fingerprint})};
}
/** A supplier's actual amount stays in its native invoice currency. Different
 * currencies remain explicit; this read never invents a conversion or a charge. */
export async function previewActualLaundryInvoice(actor:AccountActorContext,raw:unknown,deps:Dependencies={}){
 const draft=actualLaundryInvoiceDraftSchema.parse(raw);return withTenant(deps.db??prisma,actor.organizationId,async tx=>{
  const first=await prepare(actor,tx,draft),last=await prepare(actor,tx,draft);if(first.fingerprint!==last.fingerprint)throw new InventoryCatalogConflictError();await last.source.recheck();await verifyLaundryBatchSourcesInTransaction(actor,tx,last.batch);const expected=await expectedLaundryAssessmentInTransaction(actor,tx,draft.expectedInvoiceId);if(expected.batch.witness!==last.batch.witness||jsonbFingerprint(expected.value)!==jsonbFingerprint(last.expected.value))throw new InventoryCatalogConflictError();await recheckAccountAuthorization(actor,tx,await last.batch.context.inventory.catalogClock(),[...last.batch.source.checks,...last.expected.quote.selected.checks],new InventoryCatalogAccessError());await last.source.recheck();
  const{recheck,...actual}=last.source;void recheck;return{draft,reviewFingerprint:jsonbFingerprint({draft,source:last.fingerprint}),sourceFingerprint:last.fingerprint,expected:{id:last.expected.value.assessmentId,batchSequence:last.expected.value.batchSequence,currency:last.expected.value.result.currency,total:last.expected.value.result.total,status:last.expected.value.result.status},actual};
 });
}
