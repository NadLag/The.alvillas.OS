import {z} from "zod";
import {Money} from "@/platform/money/money";
import {allocateGrossRevenueByOwnerShare,assertFinancePostingsBalanced,type FinancePostingDraft,type PropertyOwnerShare} from "./reservation-revenue";
import {ServiceAllocationConfigurationError,type ServiceAllocationPart} from "./service-allocation";
import type {ServiceAllocationRecipe} from "@/platform/config/service-allocation-policy";

export type ServiceProviderCost={componentKey:string;bindingId:string;sourceKind:"SUPPLIER_INVOICE_LINE"|"EMPLOYEE_COST";costId:string;transactionId:string;partyId:string;amount:Money};
type Source={organizationId:string;propertyId:string;reservationId:string|null;collectionId:string;taskId:string;completionEventId:string;policyRuleId:string;serviceKey:string;serviceSourceId:string;admissionId:string};
type Accounts={unallocated:string;companyRevenue:string;ownerPayable:string;taxPayable:string};
const identity=z.uuid().transform(value=>value.toLowerCase()),sourceSchema=z.object({organizationId:identity,propertyId:identity,reservationId:identity.nullable(),collectionId:identity,taskId:identity,completionEventId:identity,policyRuleId:identity,serviceSourceId:identity,admissionId:identity,serviceKey:z.string().regex(/^[a-z][a-z0-9_.-]{0,99}$/u)}).strict();
/** One provider witness rule for reviewed snapshots and their eventual native journal. */
export function assertServiceProviderCosts(parts:readonly ServiceAllocationPart[],providerCosts:readonly ServiceProviderCost[]){
 const denied=():never=>{throw new ServiceAllocationConfigurationError("Service allocation does not match its original native provider costs");},costs=new Map(providerCosts.map(cost=>[cost.componentKey,cost]));
 if(costs.size!==providerCosts.length||new Set(providerCosts.map(cost=>cost.sourceKind+':'+cost.costId.toLowerCase())).size!==providerCosts.length||new Set(providerCosts.map(cost=>cost.bindingId.toLowerCase())).size!==providerCosts.length)denied();
 const providerParts=parts.filter(part=>(part.beneficiary==="SUPPLIER"||part.beneficiary==="PERSON")&&part.amount.amount.gt(0));if(providerParts.length!==costs.size)denied();
 for(const part of providerParts){const cost=costs.get(part.key)??denied();if((part.beneficiary==="PERSON"?cost.sourceKind!=="EMPLOYEE_COST":cost.sourceKind!=="SUPPLIER_INVOICE_LINE")||!(cost.amount instanceof Money)||!cost.amount.equals(part.amount))denied();for(const id of[cost.bindingId,cost.costId,cost.transactionId,cost.partyId])identity.parse(id);}
}
/** Native provider recognition already credits the canonical payable. Revenue allocation must not credit that obligation twice. */
export function serviceAllocationPostings(input:{source:Source;accounts:Accounts;gross:Money;parts:readonly ServiceAllocationPart[];owners:readonly PropertyOwnerShare[];providerCosts:readonly ServiceProviderCost[];providerTreatment:ServiceAllocationRecipe["provider_treatment"]}):FinancePostingDraft[]{
 const source=sourceSchema.parse(input.source),{accounts,gross,parts}=input;for(const id of Object.values(accounts))identity.parse(id);
 const denied=():never=>{throw new ServiceAllocationConfigurationError("Service allocation does not match its original financial sources");};
 if(input.providerTreatment!=="REVENUE_WITH_EXISTING_COMPANY_COST")denied();
 if(!(gross instanceof Money)||!gross.amount.gt(0)||gross.amount.gt("9999999999999999.99")||!parts.length||new Set(parts.map(p=>p.key)).size!==parts.length||parts.some(p=>!(p.amount instanceof Money)||p.amount.currency!==gross.currency||p.amount.amount.lt(0)||!['OWNER','COMPANY','SUPPLIER','PERSON','TAX'].includes(p.beneficiary))||!parts.reduce((sum,p)=>sum.add(p.amount),Money.zero(gross.currency)).equals(gross))denied();
 assertServiceProviderCosts(parts,input.providerCosts);
 const dimensions={organization_id:source.organizationId,property_id:source.propertyId,...source.reservationId?{reservation_id:source.reservationId}:{},cash_collection_id:source.collectionId,task_id:source.taskId,completion_event_id:source.completionEventId,service_key:source.serviceKey,service_allocation_policy_id:source.policyRuleId,service_source_id:source.serviceSourceId,service_admission_id:source.admissionId,source:'SERVICE_ALLOCATION'};
 const postings:FinancePostingDraft[]=[{ledgerAccountId:accounts.unallocated,side:'DEBIT',amount:gross,bucket:'SERVICE_ALLOCATION',dimensions}];
 let companyRevenue=Money.zero(gross.currency);
 for(const part of parts){if(part.amount.equals(Money.zero(gross.currency)))continue;const detail={...dimensions,service_component:part.key};
  if(part.beneficiary==='OWNER'){
   if(!input.owners.length||new Set(input.owners.map(o=>o.ownerId.toLowerCase())).size!==input.owners.length)denied();for(const owner of input.owners)identity.parse(owner.ownerId);
   for(const owner of allocateGrossRevenueByOwnerShare(part.amount,[...input.owners].sort((a,b)=>a.ownerId.toLowerCase().localeCompare(b.ownerId.toLowerCase())))){if(!owner.grossAmount.equals(Money.zero(gross.currency)))postings.push({ledgerAccountId:accounts.ownerPayable,side:'CREDIT',amount:owner.grossAmount,bucket:'OWNER_SERVICES',dimensions:{...detail,owner_id:owner.ownerId.toLowerCase()}});}
  }else if(part.beneficiary==='TAX'){
   if(!part.taxRuleKey)denied();postings.push({ledgerAccountId:accounts.taxPayable,side:'CREDIT',amount:part.amount,bucket:'SERVICE_TAX',dimensions:{...detail,tax_rule_key:part.taxRuleKey}});
  }else{
   companyRevenue=companyRevenue.add(part.amount);
  }
 }
 // Provider-specific amounts and identities remain in the independently protected native-cost admission.
 if(companyRevenue.amount.gt(0))postings.push({ledgerAccountId:accounts.companyRevenue,side:'CREDIT',amount:companyRevenue,bucket:'ALVILLAS_SERVICE_REVENUE',dimensions});
 if(postings.slice(1).some(p=>p.ledgerAccountId.toLowerCase()===accounts.unallocated.toLowerCase()))denied();assertFinancePostingsBalanced(postings);return postings;
}
