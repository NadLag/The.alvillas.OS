import {recurringExpensePolicyKey} from "@/modules/finance/domain/recurring-expense";
import {recurringCompanyExpensePolicyKey} from "@/modules/finance/domain/company-expense";
export {recurringExpensePolicyKey,recurringCompanyExpensePolicyKey};
export {protectedFinancialRuleKey as protectedFinancialRecurrenceKey,financialRuleAccess as recurringExpenseRuleFinancialAccess,recheckFinancialRuleAccess as recheckRecurringExpenseRuleAccess} from "./financial-rule-authority";
export function containsRecurringExpenseRule(value:unknown):boolean{
 if(!value||typeof value!=="object")return false;
 return Object.entries(value).some(([key,item])=>key===recurringExpensePolicyKey||key.startsWith("/rules/"+recurringExpensePolicyKey+"/")||
  key==="key"&&item===recurringExpensePolicyKey||key==="source"&&item==="PROPERTY_EXPENSE_DRAFT"||containsRecurringExpenseRule(item));
}

export function containsRecurringCompanyExpenseRule(value:unknown):boolean{if(!value||typeof value!=="object")return false;return Object.entries(value).some(([key,item])=>key===recurringCompanyExpensePolicyKey||key.startsWith("/rules/"+recurringCompanyExpensePolicyKey+"/")||key==="key"&&item===recurringCompanyExpensePolicyKey||key==="source"&&item==="COMPANY_EXPENSE_PLAN"||containsRecurringCompanyExpenseRule(item));}
