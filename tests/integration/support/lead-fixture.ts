import {randomUUID} from "node:crypto";
import type {PrismaClient} from "@prisma/client";
import {withTenant} from "@/platform/db/tenant";
import {authContextForAccount} from "@/platform/authz/account-context";
import {ensureStandardIdentitySetup} from "@/modules/identity/application/identity-service";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {leadCapturePolicyKey,type LeadCaptureInput,type LeadCapturePolicy} from "@/modules/crm/domain/lead-capture";

const label={en:"Actual assessment",fr:"Évaluation réelle",ar:"تقييم فعلي"};
export function nativeLeadPolicy(changes:Partial<LeadCapturePolicy>={}):LeadCapturePolicy{return{
  source:"NATIVE_PRIVATE_LEAD_CAPTURE",channels:["WEBSITE","MANUAL","REFERRAL"],sources:[{key:"assessment",label,channels:["WEBSITE","MANUAL","REFERRAL"]}],
  required_fields:["ownerContact","location"],contact_requirement:"PHONE_OR_EMAIL",referral_contact_required:false,
  property_types:[{key:"villa",label}],rental_statuses:[{key:"available",label}],otas:[],
  processing_approval_reference:"explicit-native-test-processing-approval",website_notice:{approval_reference:"explicit-native-test-notice",notice_sha256:"a".repeat(64)},
  encryption:"APP_MANAGED_AUTHENTICATED_ENCRYPTION",history:"APPEND_ONLY_ORIGINAL_CAPTURE",rate_limit:{requests:100,window_seconds:3600},...changes
};}
export function nativeLeadInput(changes:Partial<LeadCaptureInput>={}):LeadCaptureInput{return{
  idempotencyKey:randomUUID(),channel:"MANUAL",sourceKey:"assessment",locale:"fr",
  fields:{ownerContact:"Propriétaire privé",email:"private-lead@example.test",location:"Marrakech",propertyTypeKey:"villa",bedrooms:3,currentRentalStatusKey:"available",currentOtaKeys:[],objectives:"Actual acquisition assessment",notes:"Private original acquisition details"},...changes
};}
export function nativeWebsiteLeadInput():LeadCaptureInput{return nativeLeadInput({channel:"WEBSITE",websiteAcknowledgement:{approvalReference:"explicit-native-test-notice",noticeSha256:"a".repeat(64),affirmed:true}});}

export async function nativeLeadFixture(admin:PrismaClient,db:PrismaClient,changes:Partial<LeadCapturePolicy>={}){
  const organizationId=randomUUID();await admin.organization.create({data:{id:organizationId,name:"Actual private lead acceptance"}});
  await ensureStandardIdentitySetup(organizationId,{db:admin});
  const saved=await withTenant(admin,organizationId,async tx=>{
    const person=await tx.person.create({data:{organizationId,displayName:"Actual lead operator"}}),account=await tx.userAccount.create({data:{organizationId,personId:person.id}});
    const assignments:Record<string,string>={};
    for(const[name,keys]of Object.entries({create:["lead:create"],view:["lead:view"],configure:["config_rule:view","config_rule:configure"]})){
      const role=await tx.role.create({data:{organizationId,key:"actual_lead_"+name+"_"+randomUUID(),name:"Actual independent lead "+name}}),permissions=await tx.permission.findMany({where:{organizationId,key:{in:keys}}});
      if(permissions.length!==keys.length)throw Error("Actual native lead permissions must exist");
      await tx.rolePermission.createMany({data:permissions.map(permission=>({organizationId,roleId:role.id,permissionId:permission.id}))});
      const assignment=await tx.roleAssignment.create({data:{organizationId,userAccountId:account.id,personId:person.id,roleId:role.id,scopeType:"organization",validFrom:new Date("2020-01-01")}});assignments[name]=assignment.id;
    }
    const policy=nativeLeadPolicy(changes),rule=await new ConfigRuleRepository(tx,organizationId).createVersion({key:leadCapturePolicyKey,scopeType:"organization",effectiveFrom:new Date("2020-01-01"),createdBy:account.id,value:policy,reason:"Explicit approved native CRM acquisition policy"});
    return{person,account,assignments,policy,rule};
  });
  const ctx={organizationId,actorId:saved.account.id,authContext:{...await authContextForAccount(organizationId,saved.account.id,{db}),personId:saved.person.id}};
  return{organizationId,...saved,ctx};
}
