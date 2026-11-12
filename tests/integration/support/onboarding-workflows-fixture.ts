import type {NativeOnboardingFixtureIdentity} from "./onboarding-fixture";
import {randomUUID} from "node:crypto";
import type {PrismaClient} from "@prisma/client";
import {withTenant} from "@/platform/db/tenant";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {savePropertyTemplate} from "@/modules/core/application/property-template-service";
import {reviewOnboardingServicesStep,admitOnboardingServicesStep} from "@/modules/onboarding/application/onboarding-service";
import {onboardingPolicyKey,onboardingPolicySchema} from "@/modules/onboarding/domain/onboarding-policy";
import {nativeOnboardingServicesFixture} from "./onboarding-services-fixture";

/** Eight genuine canonical admissions; the standard workflow template is separate from operational activation. */
export async function nativeOnboardingWorkflowsFixture(admin:PrismaClient,db:PrismaClient,env:NodeJS.ProcessEnv,identity?:NativeOnboardingFixtureIdentity){
 const f=await nativeOnboardingServicesFixture(admin,db,env,identity),draft={sessionId:f.inventory.sessionId,previousRevisionId:f.inventory.id,step:"SERVICES"as const,target:f.servicesTarget},review=await reviewOnboardingServicesStep(f.ctx,draft,f.deps),services=await admitOnboardingServicesStep(f.ctx,{...draft,idempotencyKey:randomUUID(),reviewFingerprint:review.reviewFingerprint,reason:"Actual Services predecessor for native standard Workflows"},f.deps),policy=onboardingPolicySchema.parse({...f.policy,workflows:{modes:["TEMPLATE"],minimum_workflows:1,minimum_tasks:1}});
 await withTenant(db,f.organizationId,tx=>new ConfigRuleRepository(tx,f.organizationId).createVersion({key:onboardingPolicyKey,scopeType:"organization",createdBy:f.account.id,effectiveFrom:new Date("2020-01-01"),value:policy,reason:"Explicit required standard Workflow and task configuration"}));return{...f,services,policy};
}
export type NativeOnboardingWorkflowsFixture=Awaited<ReturnType<typeof nativeOnboardingWorkflowsFixture>>;
export const nativeWorkflowsTemplateValues=()=>({rules:{"ops.reservation_task_templates":{tasks:[{key:"arrival",type:"INSPECTION",title:{en:"Actual arrival inspection",fr:"Inspection réelle avant arrivée"},due:"CHECK_IN",dueOffsetDays:0,priority:"NORMAL",checklist:[]}]},"ops.workflows":{workflows:[{key:"arrival",trigger:"ReservationConfirmed",conditions:{path:"reservation.nights",op:">=",value:{config:"ops.mid_stay_threshold"}},actions:[{type:"create_task",task_type:"INSPECTION"}]}]}}});
export const nativeWorkflowsTemplate=(f:NativeOnboardingWorkflowsFixture,db:PrismaClient,propertyId:string|null=null)=>withTenant(db,f.organizationId,tx=>savePropertyTemplate({...f.ctx,personId:f.person.id},{key:"native_workflows_"+randomUUID(),kind:"WORKFLOW",propertyId,name:{en:"Original standard Workflows",fr:"Flux de travail standard originaux"},values:nativeWorkflowsTemplateValues(),status:"ACTIVE",expectedVersion:0,reason:"Actual independently configured reusable standard Workflows"},{db:{$transaction:work=>work(tx)},requestId:randomUUID()}));
