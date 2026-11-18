import type {AccountActorContext} from "@/platform/authz/session-context";
import type {Resource} from "@/platform/authz/authorize";
import type {CurrentAuthorityCheck} from "@/platform/authz/current-authority";
import type {TenantTransaction} from "@/platform/db/tenant";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {actualLaundryAssociationInTransaction} from "@/modules/inventory/application/actual-laundry-invoice-service";
import {InventoryCatalogAccessError,InventoryCatalogConflictError} from "@/modules/inventory/domain/catalog-errors";
import {DocumentConfigurationError} from "@/modules/documents/domain/document-command";
export async function nativeActualLaundryResources(tx:TenantTransaction,organizationId:string,ids:string[],actor:AccountActorContext){
 const result=new Map<string,Resource&{sourceRecordId:string;inventorySources:Resource[];laundryCostChecks:CurrentAuthorityCheck[]}>();if(actor.organizationId!==organizationId)return result;
 for(const id of ids){try{const value=await actualLaundryAssociationInTransaction(actor,tx,id),laundryCostChecks=[...value.expected.batch.source.checks,...value.expected.quote.selected.checks,...value.source.checks];result.set(id,{type:"laundry_actual_invoice",organizationId,id,dataClass:"financial",inventorySources:[],laundryCostChecks,sourceRecordId:jsonbFingerprint({head:value.head,batch:value.expected.batch.witness,source:value.source.fingerprint,checks:laundryCostChecks})});}catch(error){if(!(error instanceof InventoryCatalogAccessError)&&!(error instanceof InventoryCatalogConflictError)&&!(error instanceof DocumentConfigurationError))throw error;}}
 return result;
}
