import {randomUUID} from "node:crypto";
import type {PrismaClient} from "@prisma/client";
import {expect} from "@playwright/test";
import {withTenant} from "@/platform/db/tenant";
import {ensureStandardIdentitySetup} from "@/modules/identity/application/identity-service";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {nativeLeadPolicy,nativeLeadStagePolicy} from "../../integration/support/lead-fixture";

export async function configuredCapturePolicy(db:PrismaClient,organizationId:string){
  await db.organization.upsert({where:{id:organizationId},create:{id:organizationId,name:"Actual private CRM browser tenant"},update:{}});
  await ensureStandardIdentitySetup(organizationId,{db});
  return withTenant(db,organizationId,async tx=>{
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId+":actual-browser-crm-policy"},0))`;
    const rules=new ConfigRuleRepository(tx,organizationId),existing=await rules.resolve({key:"crm.lead_capture",scopes:[{scopeType:"organization",scopeId:null}],asOf:new Date()});if(existing)return existing;
    const person=await tx.person.create({data:{organizationId,displayName:"Explicit browser public intake principal"}}),account=await tx.userAccount.create({data:{organizationId,personId:person.id}}),role=await tx.role.create({data:{organizationId,key:"public_lead_"+randomUUID(),name:"Explicit public intake configuration principal"}});
    const permissions=await tx.permission.findMany({where:{organizationId,key:{in:["lead:create","config_rule:view","config_rule:configure"]}}});expect(permissions).toHaveLength(3);
    await tx.rolePermission.createMany({data:permissions.map(permission=>({organizationId,roleId:role.id,permissionId:permission.id}))});await tx.roleAssignment.create({data:{organizationId,userAccountId:account.id,personId:person.id,roleId:role.id,scopeType:"organization",validFrom:new Date("2020-01-01")}});
    return rules.createVersion({key:"crm.lead_capture",scopeType:"organization",createdBy:account.id,effectiveFrom:new Date("2020-01-01"),value:nativeLeadPolicy({rate_limit:{requests:1000,window_seconds:3600}}),reason:"Explicit synthetic owner-approved processing and website notice references"});
  });
}

export async function configuredLeadWorkspace(db:PrismaClient,organizationId:string){
 const capture=await configuredCapturePolicy(db,organizationId);if(!capture.createdBy)throw Error("Actual explicit CRM policy author required");const creator=capture.createdBy;
 return withTenant(db,organizationId,async tx=>{await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId+":actual-browser-crm-workspace"},0))`;const config=new ConfigRuleRepository(tx,organizationId);for(const[key,value]of Object.entries({"crm.pipeline":nativeLeadStagePolicy({admission:{requests:1000,window_seconds:3600}}),"crm.lead_profile":{source:"NATIVE_IMMUTABLE_LEAD_PROFILE",history:"APPEND_ONLY_REVIEWED_PROFILE_CORRECTIONS",admission:{requests:1000,window_seconds:3600}}})){if(!await config.resolve({key,scopes:[{scopeType:"organization",scopeId:null}],asOf:new Date()}))await config.createVersion({key,scopeType:"organization",createdBy:creator,effectiveFrom:new Date("2020-01-01"),value,reason:"Explicit actual native CRM workspace browser acceptance policy"});}return capture;});
}
