import {authorize,type AuthContext,type Resource} from "./authorize";
import {authorizeOrganizationSource} from "./organization-authority";

/** Complete internal positions must not aggregate independently forbidden sources. */
export const propertyFinanceFinancialSources=["property_finance","financial_transaction","company_ledger","owner_statement","expense","supplier_invoice","employee_payable","staff_compensation","wallet","cash_collection"]as const;
export const propertyFinancePartySources=["owner","supplier","team_member"]as const;
export function propertyFinanceAuthorityChecks(property:Resource,action:"view"|"export"="view"){
 return[{action:"view"as const,resource:{...property,type:"property",dataClass:"operational"as const},organizationOnly:false},
  ...propertyFinanceFinancialSources.map(type=>({action,resource:{type,organizationId:property.organizationId,dataClass:"financial"as const},organizationOnly:true})),
  ...propertyFinancePartySources.map(type=>({action:"view"as const,resource:{type,organizationId:property.organizationId,dataClass:"personal"as const},organizationOnly:true}))];
}
export function canViewCompletePropertyFinance(auth:AuthContext,property:Resource,now:Date,action:"view"|"export"="view"){
 return propertyFinanceAuthorityChecks(property,action).every(check=>(check.organizationOnly?authorizeOrganizationSource:authorize)(auth,check.action,check.resource,now));
}
