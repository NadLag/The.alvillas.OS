import {randomUUID} from "node:crypto";
import type {PrismaClient} from "@prisma/client";
import {withTenant} from "@/platform/db/tenant";
import {authContextForAccount} from "@/platform/authz/account-context";
import {financialRuleSourceChecks} from "@/platform/config/financial-rule-authority";
import {managementAgreementInputSchema} from "@/modules/core/domain/owner-property";
import {createManagementAgreement} from "@/modules/core/application/core-service";
import {nativeOnboardingAdmission} from "./onboarding-fixture";
import {nativeOnboardingPropertyFixture,nativeOnboardingPropertyAdmission} from "./onboarding-property-fixture";

export const coreAgreementFinancialRuleKeys=["finance.commission","finance.expense_treatment","finance.approval_thresholds","finance.payout_schedule"]as const;
export async function nativeCoreFinancialAgreementFixture(admin:PrismaClient,db:PrismaClient,env:NodeJS.ProcessEnv){
 const f=await nativeOnboardingPropertyFixture(admin,db,env),required=new Set(["config_rule:view","config_rule:export","config_rule:create","config_rule:configure",...coreAgreementFinancialRuleKeys.flatMap(key=>financialRuleSourceChecks(f.organizationId,key)).map(check=>check.resource.type+":"+check.action)]);
 await withTenant(db,f.organizationId,async tx=>{for(const key of required){const role=await tx.role.create({data:{organizationId:f.organizationId,key:"native_core_agreement_"+randomUUID(),name:"Independent canonical agreement "+key}}),permission=await tx.permission.findFirstOrThrow({where:{organizationId:f.organizationId,key}});await tx.rolePermission.create({data:{organizationId:f.organizationId,roleId:role.id,permissionId:permission.id}});f.grants[key]=(await tx.roleAssignment.create({data:{organizationId:f.organizationId,roleId:role.id,userAccountId:f.account.id,personId:f.person.id,scopeType:"organization",validFrom:new Date("2020-01-01")}})).id;}});
 f.ctx.authContext={...await authContextForAccount(f.organizationId,f.account.id,{db}),personId:f.person.id};const owner=await nativeOnboardingAdmission(f,db),property=await nativeOnboardingPropertyAdmission(f,db,owner.receipt),terms={reference:"Actual canonical financial authority "+randomUUID(),effectiveFrom:"2026-11-09T00:00:00.000Z",effectiveTo:null,commissionRateBps:1750,commissionBasis:"NET_OF_OTA_FEES",commissionAccrualEvent:"ON_RECEIPT",expenseDefaultTreatment:"OWNER_PAID",approvalThresholdKey:"explicit_canonical_approval",approvalThresholdAmount:"9999999999999999.99",approvalThresholdCurrency:"MAD",approvalRequires:["owner"],payoutCadence:"MONTHLY",payoutHoldDays:4,payoutHoldbackBps:250,noticePeriodDays:45,ownerResponsibilities:["Explicit owned owner fixture responsibility"],alvillasResponsibilities:["Explicit owned company fixture responsibility"],specialConditions:["Owned native fixture; no legal acceptance claim"]},agreement=await createManagementAgreement(f.ctx,managementAgreementInputSchema.parse({...terms,effectiveTo:undefined,propertyId:property.receipt.propertyId!,status:"DRAFT",reason:"Actual canonical financial boundary source fixture"}),{db,requestId:randomUUID()});return{...f,owner,property,terms,agreement};
}
