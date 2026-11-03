import {z} from "zod";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {Money} from "@/platform/money/money";
import {serviceAllocationPolicyKey,serviceAllocationPolicySchema} from "@/platform/config/service-allocation-policy";
import {allocateServiceProceeds,ServiceAllocationConfigurationError} from "./service-allocation";
import {assessConfiguredServiceTaxes,type ServiceTaxPolicySource} from "./service-tax-assessment";
import {allocateGrossRevenueByOwnerShare} from "./reservation-revenue";
import type {ServiceProviderCost} from "./service-allocation-postings";

const identity=z.uuid().transform(value=>value.toLowerCase());
const sourceSchema=z.object({kind:z.literal("COMPLETED_SERVICE_COLLECTION"),collectionId:identity,transactionId:identity,taskId:identity,propertyId:identity,reservationId:identity.nullable(),completionEventId:identity,performedByPersonId:identity,completedAt:z.iso.datetime(),recordedAt:z.iso.datetime(),currencyMinorUnit:z.number().int().min(0).max(2)}).strict();
export const serviceAllocationOwnerSchema=z.object({ownerId:identity,ownerName:z.string().min(1),shareBps:z.number().int().min(0).max(10000)}).strict();
type PolicySource=ServiceTaxPolicySource;
type Input={source:z.input<typeof sourceSchema>;gross:Money;allocationRule:PolicySource;taxRule:PolicySource;serviceKey:string;owners:readonly z.input<typeof serviceAllocationOwnerSchema>[];providerCosts:readonly ServiceProviderCost[]};

/** Retain only the selected recipe and tax decisions, never another service's prices or private tax catalog. */
export function buildServiceAllocationSnapshot(input:Input){
 function denied():never{throw new ServiceAllocationConfigurationError("Service admission must retain its actual complete source and configured recipients");}
 const source=sourceSchema.parse(input.source),policy=serviceAllocationPolicySchema.parse(input.allocationRule.value);
 if(input.allocationRule.key!==serviceAllocationPolicyKey||!identity.safeParse(input.allocationRule.id).success||!Number.isSafeInteger(input.allocationRule.version)||input.allocationRule.version<1)denied();
 const recipe=policy.services.find(row=>row.service_key===input.serviceKey)??denied(),taxes=assessConfiguredServiceTaxes(input.gross,recipe.tax_rule_keys,input.taxRule,source.currencyMinorUnit),parts=allocateServiceProceeds(input.gross,recipe,taxes);
 const ownerTotal=parts.filter(part=>part.beneficiary==="OWNER").reduce((total,part)=>total.add(part.amount),Money.zero(input.gross.currency));
 const owners=ownerTotal.amount.gt(0)?input.owners.map(owner=>serviceAllocationOwnerSchema.parse(owner)):[];
 if(ownerTotal.amount.gt(0)){
  if(!owners.length||new Set(owners.map(owner=>owner.ownerId)).size!==owners.length)denied();
  allocateGrossRevenueByOwnerShare(ownerTotal,owners);
 }
 const providerParts=parts.filter(part=>(part.beneficiary==="PERSON"||part.beneficiary==="SUPPLIER")&&part.amount.amount.gt(0));
 if(providerParts.length!==input.providerCosts.length||new Set(input.providerCosts.map(cost=>cost.componentKey)).size!==input.providerCosts.length||new Set(input.providerCosts.map(cost=>cost.sourceKind+':'+cost.costId.toLowerCase())).size!==input.providerCosts.length||new Set(input.providerCosts.map(cost=>cost.bindingId.toLowerCase())).size!==input.providerCosts.length)denied();
 const providerCosts=providerParts.map(part=>{
  const cost=input.providerCosts.find(cost=>cost.componentKey===part.key)??denied();
  if((part.beneficiary==="PERSON"?cost.sourceKind!=="EMPLOYEE_COST":cost.sourceKind!=="SUPPLIER_INVOICE_LINE")||!(cost.amount instanceof Money)||!cost.amount.equals(part.amount))denied();
  return{componentKey:part.key,bindingId:identity.parse(cost.bindingId),sourceKind:cost.sourceKind,costId:identity.parse(cost.costId),transactionId:identity.parse(cost.transactionId),partyId:identity.parse(cost.partyId),amount:cost.amount.toJSON()};
 });
 const snapshot={schemaVersion:1,source:{...source,amount:input.gross.toJSON()},rules:{allocation:{id:input.allocationRule.id.toLowerCase(),version:input.allocationRule.version,source:policy.source,ruleSelection:policy.rule_selection,ownershipBasis:policy.ownership_basis},tax:{id:input.taxRule.id.toLowerCase(),version:input.taxRule.version}},recipe,parts:parts.map(part=>({...part,amount:part.amount.toJSON()})),taxes:taxes.map(tax=>({...tax,amount:tax.amount.toJSON()})),owners,providerCosts};
 return{snapshot,fingerprint:commandFingerprint(snapshot)};
}
