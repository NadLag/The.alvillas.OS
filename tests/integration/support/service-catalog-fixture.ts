import {randomUUID} from "node:crypto";
import type {PrismaClient} from "@prisma/client";
import {withTenant} from "@/platform/db/tenant";
import {authContextForAccount} from "@/platform/authz/account-context";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {createSupplier} from "@/modules/finance/application/supplier-service";
import {nativeGuestHubFixture,type NativeGuestHubFixtureIdentity} from "./guest-hub-fixture";

/** One canonical reservation/property fixture is shared with the Guest Hub
 * ordering journey. Catalog changes always run through the real application. */
export async function nativeServiceCatalogFixture(admin:PrismaClient,db:PrismaClient,identity?:NativeGuestHubFixtureIdentity){
 const f=await nativeGuestHubFixture(admin,db,{},identity),grants={...f.grants},scope={propertyId:f.property.id};
 const propertyKeys=["service:view","service:configure","config_rule:view","config_rule:configure","config_rule:export"],financialSources=["cash_collection","financial_transaction","owner_statement","company_ledger","supplier_invoice","employee_payable","staff_compensation"],keys=[...propertyKeys,...financialSources.flatMap(type=>[type+":view",type+":export"]),"supplier:view","supplier:create","audit_log:view","audit_log:export"];
 await withTenant(db,f.organizationId,async tx=>{for(const key of keys){
  const permission=await tx.permission.findFirstOrThrow({where:{organizationId:f.organizationId,key}}),role=await tx.role.create({data:{organizationId:f.organizationId,key:"catalog_"+randomUUID(),name:"Independent catalog "+key}});await tx.rolePermission.create({data:{organizationId:f.organizationId,roleId:role.id,permissionId:permission.id}});
  const assignment=await tx.roleAssignment.create({data:{organizationId:f.organizationId,personId:f.person.id,userAccountId:f.account.id,roleId:role.id,scopeType:propertyKeys.includes(key)?"property":"organization",scopeId:propertyKeys.includes(key)?f.property.id:null,validFrom:new Date("2020-01-01")}});grants[key]=assignment.id;
 }});
 const ctx={...f.ctx,authContext:{...await authContextForAccount(f.organizationId,f.account.id,{db}),personId:f.person.id}},deps={db,requestId:randomUUID(),ipAddress:null},supplier=await createSupplier(ctx,{displayName:"Actual catalog fulfillment supplier",category:"owned_service",idempotencyKey:randomUUID(),reason:"Explicit actual supplier for owned catalog acceptance"},deps);
 const policies=await withTenant(db,f.organizationId,async tx=>{
  const repository=new ConfigRuleRepository(tx,f.organizationId),common={scopeType:"organization",createdBy:f.account.id,effectiveFrom:new Date("2020-01-01"),reason:"Explicit fictional owned-test catalog financial treatment"};
  const allocation=await repository.createVersion({...common,key:"finance.service_allocation",value:{source:"COMPLETED_SERVICE_COLLECTION",rule_selection:"AT_ACTUAL_SERVICE_COMPLETION",ownership_basis:"CURRENT_PROPERTY_OWNERS_AT_ADMISSION",services:[{service_key:"owned_transfer",currency:"MAD",basis:"COLLECTED_GROSS_LESS_FIXED_COMPONENTS",rounding:"LARGEST_REMAINDER",provider_treatment:"REVENUE_WITH_EXISTING_COMPANY_COST",components:[{key:"provider",beneficiary:"SUPPLIER",mode:"FIXED",amount:"30.00"},{key:"owner",beneficiary:"OWNER",mode:"BASIS_POINTS",basis_points:2500},{key:"tax",beneficiary:"TAX",mode:"FIXED",amount:"3.00",tax_rule_key:"owned_tax"},{key:"company",beneficiary:"COMPANY",mode:"REMAINDER"}],rounding_priority:["owner","company"],tax_rule_keys:["owned_tax"]}]}}),tax=await repository.createVersion({...common,key:"finance.tax",value:{taxes:[{key:"owned_tax",amount:"3.00",currency:"MAD",service_assessment:{basis:"ACTUAL_COLLECTED_GROSS",method:"FIXED",rounding:"HALF_UP_AT_LEDGER_PRECISION"}}]}}),original=await repository.createVersion({...common,key:"services.pricing",value:{owned_extension:{must:"survive unchanged"},services:[{key:"legacy_service",pricing_model:"CUSTOM",legacy_extension:{original:true}}]}});
  return{allocation,tax,original};
 });
 const entry={key:"owned_transfer",name:{en:"Owned transfer",fr:"Transfert contrôlé",ar:"نقل معتمد"},description:{en:"Actual reviewed catalog service",fr:"Service de catalogue approuvé",ar:"خدمة معتمدة في الدليل"},available:true,pricing_model:"FIXED"as const,amount:"120.00",currency:"MAD",order_terms:{schemaVersion:1 as const,approval_reference:"Explicit owned catalog approval, no production legal default",internal_cost:{amount:"30.00",currency:"MAD"},providers:[{component_key:"provider",kind:"SUPPLIER"as const,id:supplier.id}],allocation_rule_id:policies.allocation.id,tax_rule_id:policies.tax.id,availability:{all:[]}}};
 return{...f,ctx,grants,scope,deps,supplier,policies,entry,draft:{scope,entry,reason:"Publish explicit owned catalog terms and actual financial references"}};
}
export type NativeServiceCatalogFixture=Awaited<ReturnType<typeof nativeServiceCatalogFixture>>;
