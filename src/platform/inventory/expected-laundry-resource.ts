import type {Resource} from "@/platform/authz/authorize";
import type {CurrentAuthorityCheck} from "@/platform/authz/current-authority";
import type {TenantTransaction} from "@/platform/db/tenant";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {financialRuleSourceChecks} from "@/platform/config/financial-rule-authority";
import {laundrySupplierPricePolicyKey} from "@/platform/config/laundry-pricing-policy";
import {ExpectedLaundryInvoiceRepository} from "@/modules/inventory/infrastructure/expected-laundry-invoice-repository";
import {nativeLaundryBatchResources} from "./laundry-resource";
export async function nativeExpectedLaundryResources(tx:TenantTransaction,organizationId:string,ids:string[]){
 const repository=new ExpectedLaundryInvoiceRepository(tx,organizationId),config=new ConfigRuleRepository(tx,organizationId),result=new Map<string,Resource&{sourceRecordId:string;inventorySources:Resource[];laundryCostChecks:CurrentAuthorityCheck[]}>();
 for(const id of ids){const head=await repository.head(id);if(!head)continue;const batch=(await nativeLaundryBatchResources(tx,organizationId,[head.batchId],"laundry_batch")).get(head.batchId),rule=await config.sourceMetadataWitness(head.quoteVersionId);if(!batch?.laundrySupplier?.id||!rule||rule.key!==laundrySupplierPricePolicyKey(batch.laundrySupplier.id))continue;const property=rule.scopeId?batch.inventorySources.find(row=>row.type==="property"&&row.id===rule.scopeId):null;if(rule.scopeId&&!property)continue;const laundryCostChecks:CurrentAuthorityCheck[]=[...financialRuleSourceChecks(organizationId,rule.key),{action:"view",organizationOnly:rule.scopeType==="organization",resource:{...property,type:"config_rule",id:rule.key,organizationId,dataClass:"financial"}}];result.set(id,{type:"laundry_expected_invoice",id,organizationId,dataClass:"financial",inventorySources:batch.inventorySources,laundryCostChecks,sourceRecordId:jsonbFingerprint({head,batch,rule})});}
 return result;
}
