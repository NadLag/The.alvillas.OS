import type {AuthContext} from "@/platform/authz/authorize";
import {authorizeOrganizationSource} from "@/platform/authz/organization-authority";
import {recheckAccountAuthorization,type CurrentAuthorityCheck} from "@/platform/authz/current-authority";
import type {TenantTransaction} from "@/platform/db/tenant";
import {FinanceRepository} from "@/modules/finance/infrastructure/finance-repository";
import {recurringExpensePolicyKey} from "@/modules/finance/domain/recurring-expense";
export {recurringExpensePolicyKey};

export function recurringExpenseRuleFinancialAccess(auth:AuthContext,action:"view"|"export"="view",now=new Date()){
 const source={organizationId:auth.organizationId,dataClass:"financial"as const};
 return["expense","financial_transaction"].every(type=>authorizeOrganizationSource(auth,"view",{...source,type},now)&&
  (action==="view"||authorizeOrganizationSource(auth,"export",{...source,type},now)));
}
export async function recheckRecurringExpenseRuleAccess(ctx:{organizationId:string;actorId:string;authContext:AuthContext},tx:TenantTransaction,key:string,checks:readonly CurrentAuthorityCheck[],denied:Error){
 if(key!==recurringExpensePolicyKey)return;
 const now=await new FinanceRepository(tx,ctx.organizationId).clock(),required=[...checks,...["expense","financial_transaction"].map(type=>({action:"view"as const,resource:{type,organizationId:ctx.organizationId,dataClass:"financial"as const},organizationOnly:true}))];
 await recheckAccountAuthorization(ctx,tx,now,required,denied);
}
export function containsRecurringExpenseRule(value:unknown):boolean{
 if(!value||typeof value!=="object")return false;
 return Object.entries(value).some(([key,item])=>key===recurringExpensePolicyKey||key.startsWith("/rules/"+recurringExpensePolicyKey+"/")||
  key==="key"&&item===recurringExpensePolicyKey||key==="source"&&item==="PROPERTY_EXPENSE_DRAFT"||containsRecurringExpenseRule(item));
}
