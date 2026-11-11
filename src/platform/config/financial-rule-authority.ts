import {ledgerIntegrityPolicyKey,ledgerIntegrityRoutingKey} from "@/modules/finance/domain/ledger-integrity";
import {paymentMethodPolicyKey} from "@/modules/finance/domain/payment-method";
import {financialAttachmentPolicyKey} from "@/modules/finance/domain/financial-attachment-policy";
import type {AuthContext} from "@/platform/authz/authorize";
import {authorizeOrganizationSource} from "@/platform/authz/organization-authority";
import {recheckAccountAuthorization,type CurrentAuthorityCheck} from "@/platform/authz/current-authority";
import type {TenantTransaction} from "@/platform/db/tenant";
import {FinanceRepository} from "@/modules/finance/infrastructure/finance-repository";
import {recurringExpensePolicyKey} from "@/modules/finance/domain/recurring-expense";
import {recurringCompanyExpensePolicyKey} from "@/modules/finance/domain/company-expense";
import {serviceAllocationPolicyKey} from "./service-allocation-policy";
import {guestDepositPolicyKey} from "./guest-deposit-policy";
import {accountantExportPolicyKey} from "@/modules/finance/domain/accountant-export-policy";
import {propertyFinanceFinancialSources} from "@/platform/authz/property-finance-resource";
export {recurringExpensePolicyKey,recurringCompanyExpensePolicyKey,serviceAllocationPolicyKey};

const sourceGroups:Readonly<Record<string,readonly string[]>>={
 [ledgerIntegrityPolicyKey]:[...propertyFinanceFinancialSources,"bank_statement","company_expense","receivable","financial_attachment"],
 [ledgerIntegrityRoutingKey]:[...propertyFinanceFinancialSources,"bank_statement","company_expense","receivable","financial_attachment"],
 "finance.commission":["financial_transaction","company_ledger"],
 "finance.ota_fee":["financial_transaction","company_ledger"],
 "finance.bank_statements":["bank_statement","financial_transaction"],
 "finance.expense_treatment":["expense","financial_transaction"],
 "finance.expense_allocation":["expense","financial_transaction"],
 "finance.approval_thresholds":["expense","financial_transaction"],
 "finance.payout_schedule":["owner_statement","financial_transaction"],
 "finance.accounting_periods":["financial_transaction"],
 "finance.company_expenses":["company_expense","financial_transaction","staff_compensation"],
 [financialAttachmentPolicyKey]:["financial_attachment","financial_transaction"],
 [accountantExportPolicyKey]:[...propertyFinanceFinancialSources,"bank_statement","company_expense"],
 [recurringExpensePolicyKey]:["expense","financial_transaction"],
 [recurringCompanyExpensePolicyKey]:["company_expense","financial_transaction","staff_compensation"],
 [serviceAllocationPolicyKey]:["cash_collection","financial_transaction","owner_statement","company_ledger","supplier_invoice","employee_payable","staff_compensation"],
 [guestDepositPolicyKey]:["financial_transaction"],
 [paymentMethodPolicyKey]:["financial_transaction","cash_collection","bank_statement"],
 "finance.tax":["financial_transaction","company_ledger"]
};
function financialSources(key: string): readonly string[] | undefined {
 if (Object.hasOwn(sourceGroups,key)) return sourceGroups[key];
 if (key === "finance.receivables" || key.startsWith("finance.receivable_")) return ["receivable","financial_transaction","staff_compensation"];
 if (key==="staff.compensation"||key.startsWith("staff.compensation_")) return ["staff_compensation","employee_payable","financial_transaction"];
 // Retained definitions and future financial keys remain private until their precise sources are registered.
 if (key.startsWith("finance.")) return [...propertyFinanceFinancialSources,"bank_statement","company_expense","receivable","financial_attachment"];
 return undefined;
}
export const protectedFinancialRuleKey=(key:string|undefined):key is string=>Boolean(key&&financialSources(key));
export function financialRuleSourceChecks(organizationId:string,key:string,action:"view"|"export"="view"):CurrentAuthorityCheck[]{
 const sources=financialSources(key);if(!sources)return[];return sources.flatMap(type=>[{action:"view"as const,resource:{type,organizationId,dataClass:"financial"as const},organizationOnly:true},...action==="export"?[{action:"export"as const,resource:{type,organizationId,dataClass:"financial"as const},organizationOnly:true}]:[]]);
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
  if(key==='source'&&child==='ACTUAL_GUEST_RECEIPT')found.add(guestDepositPolicyKey);
  if (protectedFinancialRuleKey(key)) found.add(key);
  if (key === "key" && typeof child === "string" && protectedFinancialRuleKey(child)) found.add(child);
  if (key.startsWith("/rules/")) { const ruleKey=key.split("/")[2]; if (protectedFinancialRuleKey(ruleKey)) found.add(ruleKey); }
  for(const protectedKey of Object.keys(sourceGroups))if(key===protectedKey||key.startsWith('/rules/'+protectedKey+'/')||key==='key'&&child===protectedKey)found.add(protectedKey);
  if(key==='source'&&child==='PROPERTY_EXPENSE_DRAFT')found.add(recurringExpensePolicyKey);if(key==='source'&&child==='COMPANY_EXPENSE_PLAN')found.add(recurringCompanyExpensePolicyKey);if(key==='source'&&child==='COMPLETED_SERVICE_COLLECTION')found.add(serviceAllocationPolicyKey);visit(child);
 }}visit(value);return[...found].sort();
}
