import type {AuthContext} from "@/platform/authz/authorize";
import {authorizeOrganizationSource} from "@/platform/authz/organization-authority";
import {recheckAccountAuthorization,type CurrentAuthorityCheck} from "@/platform/authz/current-authority";
import type {TenantTransaction} from "@/platform/db/tenant";
import {FinanceRepository} from "@/modules/finance/infrastructure/finance-repository";
import {recurringExpensePolicyKey} from "@/modules/finance/domain/recurring-expense";
import {recurringCompanyExpensePolicyKey} from "@/modules/finance/domain/company-expense";
import {serviceAllocationPolicyKey} from "./service-allocation-policy";
export {recurringExpensePolicyKey,recurringCompanyExpensePolicyKey,serviceAllocationPolicyKey};

const sourceGroups:Readonly<Record<string,readonly string[]>>={
 [recurringExpensePolicyKey]:["expense","financial_transaction"],
 [recurringCompanyExpensePolicyKey]:["company_expense","financial_transaction","staff_compensation"],
 [serviceAllocationPolicyKey]:["cash_collection","financial_transaction","owner_statement","company_ledger","supplier_invoice","employee_payable","staff_compensation"],
 "finance.tax":["financial_transaction","company_ledger"]
};
export const protectedFinancialRuleKey=(key:string|undefined):key is string=>Boolean(key&&Object.hasOwn(sourceGroups,key));
export function financialRuleSourceChecks(organizationId:string,key:string,action:"view"|"export"="view"):CurrentAuthorityCheck[]{
 if(!protectedFinancialRuleKey(key))return[];return sourceGroups[key].flatMap(type=>[{action:"view"as const,resource:{type,organizationId,dataClass:"financial"as const},organizationOnly:true},...action==="export"?[{action:"export"as const,resource:{type,organizationId,dataClass:"financial"as const},organizationOnly:true}]:[]]);
}
export function financialRuleAccess(auth:AuthContext,action:"view"|"export"="view",now=new Date(),key:string=recurringExpensePolicyKey){
 return protectedFinancialRuleKey(key)&&financialRuleSourceChecks(auth.organizationId,key,action).every(check=>authorizeOrganizationSource(auth,check.action,check.resource,now));
}
export async function recheckFinancialRuleAccess(ctx:{organizationId:string;actorId:string;authContext:AuthContext},tx:TenantTransaction,key:string,checks:readonly CurrentAuthorityCheck[],denied:Error){
 if(!protectedFinancialRuleKey(key))return;const now=await new FinanceRepository(tx,ctx.organizationId).clock();await recheckAccountAuthorization(ctx,tx,now,[...checks,...financialRuleSourceChecks(ctx.organizationId,key)],denied);
}
/** Config history may contain several financial rules; every actual source group must remain authorized. */
export function financialRuleKeysIn(value:unknown):string[]{
 const found=new Set<string>();function visit(item:unknown){if(!item||typeof item!=="object")return;for(const[key,child]of Object.entries(item)){
  for(const protectedKey of Object.keys(sourceGroups))if(key===protectedKey||key.startsWith('/rules/'+protectedKey+'/')||key==='key'&&child===protectedKey)found.add(protectedKey);
  if(key==='source'&&child==='PROPERTY_EXPENSE_DRAFT')found.add(recurringExpensePolicyKey);if(key==='source'&&child==='COMPANY_EXPENSE_PLAN')found.add(recurringCompanyExpensePolicyKey);if(key==='source'&&child==='COMPLETED_SERVICE_COLLECTION')found.add(serviceAllocationPolicyKey);visit(child);
 }}visit(value);return[...found].sort();
}
