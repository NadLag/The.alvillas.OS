import {randomUUID} from "node:crypto";
import type {PrismaClient} from "@prisma/client";
import {withTenant} from "@/platform/db/tenant";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {reviewOnboardingActivation,admitOnboardingActivation} from "@/modules/onboarding/application/onboarding-service";
import {nativeOnboardingOwnerPackageFixture} from "./onboarding-owner-package-fixture";
import {nativeOnboardingExecutionAuthority} from "./onboarding-execution-authority-fixture";
import {nativeWorkflowsTemplateValues} from "./onboarding-workflows-fixture";
import type {nativeDocumentObjectFixture} from "./document-object-store-fixture";
import operationDefaults from "@/platform/config/defaults/operations.json";

export async function nativeOnboardingActivationEffectsFixture(admin:PrismaClient,db:PrismaClient,env:NodeJS.ProcessEnv,storage:Awaited<ReturnType<typeof nativeDocumentObjectFixture>>){
 const base=nativeWorkflowsTemplateValues(),catalog={workflows:[{key:"approved_arrival",name:{en:"Approved native arrival",fr:"Arrivée native approuvée"},enabled:true,trigger:"ReservationConfirmed",conditions:{path:"reservation.id",op:"exists"},actions:[{key:"prepare",type:"generate_workflow"}],retry:{max_attempts:2,delay_seconds:1}}],onboarding_tasks:{minimum:2,items:[{key:"inspection",type:"INSPECTION",title:{en:"Original approved inspection",fr:"Inspection originale approuvée"},priority:"HIGH",checklistTemplateKey:"native_inspection",due:{anchor:"ACTIVATION_REQUEST",timezone:"Africa/Casablanca",offset_days:0}},{key:"handover",type:"INSPECTION",title:{en:"Original approved handover",fr:"Remise originale approuvée"},priority:"NORMAL",checklistTemplateKey:"native_inspection",due:{anchor:"ACTIVATION_REQUEST",timezone:"Africa/Casablanca",offset_days:1}}]}};
 const initial=await nativeOnboardingOwnerPackageFixture(admin,db,env,storage,undefined,{values:{rules:{...base.rules,"ops.workflows":catalog}},configuration:[{key:"ops.task_policy",value:structuredClone(operationDefaults)},{key:"ops.checklists",value:{checklists:[{key:"native_inspection",name:{en:"Original approved checklist",fr:"Liste originale approuvée"},items:[{key:"ready",label:{en:"Confirm readiness",fr:"Confirmer la préparation"}}]}]}},{key:"onboarding.owner_delivery",value:{source:"NATIVE_COMPLETED_OWNER_PACKAGE",channel:"EMAIL",template:"NATIVE_OWNER_PACKAGE_EMAIL_V1",locales:["en","fr"]}}]}),f=await nativeOnboardingExecutionAuthority(initial,db);
 await withTenant(db,f.organizationId,tx=>new ConfigRuleRepository(tx,f.organizationId).createVersion({key:"notification.email.delivery_policy",scopeType:"organization",createdBy:f.account.id,effectiveFrom:new Date("2020-01-01"),value:{maxAttempts:3,backoffSeconds:1,maxBackoffSeconds:1,retryWindowHours:23},reason:"Explicit approved canonical owner delivery retry settings"}));
 const review=await reviewOnboardingActivation(f.ctx,f.activationDraft,f.deps),runNonce=randomUUID(),run=await admitOnboardingActivation(f.ctx,{...f.activationDraft,idempotencyKey:runNonce,reviewFingerprint:review.reviewFingerprint,reason:"Actual complete native configuration before dependency-ordered effects"},f.deps);
 return{...f,runId:run.runId,runNonce,catalog};
}
