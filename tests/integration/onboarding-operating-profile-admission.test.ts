import {randomBytes,randomUUID} from "node:crypto";
import {PrismaClient} from "@prisma/client";
import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from "vitest";
import {withTenant,type TenantTransaction} from "@/platform/db/tenant";
import * as auditWriter from "@/platform/audit/audit-writer";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {nativeOnboardingOperatingProfile} from "@/platform/onboarding/property-source";
import {reviewOnboardingOperatingStep,admitOnboardingOperatingStep} from "@/modules/onboarding/application/onboarding-service";
import {canonicalOnboardingOperatingDraft,canonicalOnboardingOperatingCommand,type OnboardingOperatingDraft} from "@/modules/onboarding/domain/onboarding-operating-profile";
import {decryptOnboardingOperatingPayload} from "@/modules/onboarding/domain/onboarding-operating-payload";
import {OnboardingAccessError,OnboardingConflictError} from "@/modules/onboarding/domain/onboarding-wizard";
import {onboardingPolicyKey} from "@/modules/onboarding/domain/onboarding-policy";
import {nativeOnboardingAdmission} from "./support/onboarding-fixture";
import {nativeOnboardingPropertyFixture,nativeOnboardingPropertyAdmission,nativeOnboardingPropertyProfile} from "./support/onboarding-property-fixture";
import {nativeLeadFinancialGuard} from "./support/lead-fixture";
import {provisionIntegrationRole} from "./support/database-role";

let admin:PrismaClient,db:PrismaClient,financial:Awaited<ReturnType<typeof nativeLeadFinancialGuard>>;
const organizations:string[]=[],env:NodeJS.ProcessEnv={NODE_ENV:"test",ENCRYPTION_KEYS:"operating-admission:"+randomBytes(32).toString("base64")};
beforeAll(async()=>{
 const value=process.env.TEST_DATABASE_URL,url=value?new URL(value):null;
 if(!url||!["localhost","127.0.0.1"].includes(url.hostname)||!(url.pathname.startsWith("/alvillas_automation_crm_proposal_onboarding")||process.env.GITHUB_ACTIONS==="true"&&url.pathname==="/alvillas_os"))throw Error("Owned native operating-admission database required");
 admin=new PrismaClient({datasourceUrl:value});await provisionIntegrationRole(admin,"alvillas_ops_tests");url.username=url.password="alvillas_ops_tests";db=new PrismaClient({datasourceUrl:url.toString()});financial=await nativeLeadFinancialGuard(admin,db);
});
afterEach(()=>vi.restoreAllMocks());
afterAll(async()=>{try{if(financial)await financial.assertPreserved(organizations);}finally{await db?.$disconnect();await admin?.$disconnect();}});
async function fixture(){
 const f=await nativeOnboardingPropertyFixture(admin,db,env);organizations.push(f.organizationId);
 const policy={...f.policy,operating_profile_modes:["LINK","UPDATE"]},rule=await withTenant(db,f.organizationId,tx=>new ConfigRuleRepository(tx,f.organizationId).createVersion({key:onboardingPolicyKey,scopeType:"organization",createdBy:f.account.id,effectiveFrom:new Date("2020-01-01"),value:policy,reason:"Actual explicit Operating Profile admission policy"}));
 const owner=await nativeOnboardingAdmission(f,db),property=await nativeOnboardingPropertyAdmission(f,db,owner.receipt);
 if(!property.receipt.propertyId)throw Error("Actual saved canonical Property required");
 const draft=canonicalOnboardingOperatingDraft({sessionId:owner.receipt.sessionId,previousRevisionId:property.receipt.id,step:"OPERATING_PROFILE",target:{mode:"UPDATE",propertyId:property.receipt.propertyId,input:{...nativeOnboardingPropertyProfile(),chefAvailable:false,automationNotes:"Actual explicitly reviewed operating notes"}}});
 return{...f,policy,rule,owner,property,propertyId:property.receipt.propertyId,draft,deps:{db,env}};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function operatingRecorded(event:Parameters<typeof auditWriter.writeAuditEvent>[1]){const after=event.after;return event.action==="onboarding.step_recorded"&&after!==null&&typeof after==="object"&&"step"in after&&after.step==="OPERATING_PROFILE";}
async function command(f:Fixture,target:OnboardingOperatingDraft["target"]=f.draft.target){const draft=canonicalOnboardingOperatingDraft({...f.draft,target}),review=await reviewOnboardingOperatingStep(f.ctx,draft,f.deps);return canonicalOnboardingOperatingCommand({...draft,idempotencyKey:randomUUID(),reviewFingerprint:review.reviewFingerprint,reason:"Actual reviewed operating admission reason"});}
function tuples(f:Fixture){return withTenant(db,f.organizationId,tx=>tx.$queryRaw<Array<{kind:string;id:string;xmin:string;ctid:string;body:string}>>`SELECT 'owner' AS kind,id::text,xmin::text,ctid::text,md5(to_jsonb(o)::text) AS body FROM owner o WHERE id=${f.owner.receipt.ownerId}::uuid UNION ALL SELECT 'property',id::text,xmin::text,ctid::text,md5(to_jsonb(p)::text) FROM property p WHERE id=${f.propertyId}::uuid UNION ALL SELECT 'ownership',id::text,xmin::text,ctid::text,md5(to_jsonb(po)::text) FROM property_owner po WHERE property_id=${f.propertyId}::uuid UNION ALL SELECT 'profile',id::text,xmin::text,ctid::text,md5(to_jsonb(op)::text) FROM property_operating_profile op WHERE property_id=${f.propertyId}::uuid ORDER BY kind,id`);}
function counts(f:Fixture){return withTenant(db,f.organizationId,async tx=>({owners:await tx.owner.count(),properties:await tx.property.count(),revisions:await tx.propertyOnboardingRevision.count(),events:await tx.outboxEvent.count({where:{type:"onboarding.step_recorded"}}),coreUpdates:await tx.auditLog.count({where:{action:"property.operating_profile.update"}}),agreements:await tx.managementAgreement.count(),payouts:await tx.ownerPayoutMethod.count(),portals:await tx.ownerPortalAccess.count(),journals:await tx.financialTransaction.count()}));}

describe("atomic native Operating Profile admission",()=>{
 it.each(["LINK","UPDATE"]as const)("admits %s with original private choices, canonical audit and outbox while preserving physical and financial history",async mode=>{
  const f=await fixture(),oldNotes="  Actual original operating notes  ".repeat(200);
  await withTenant(db,f.organizationId,tx=>tx.propertyOperatingProfile.update({where:{propertyId:f.propertyId},data:{automationNotes:oldNotes}}));
  const before=await tuples(f),original=await withTenant(db,f.organizationId,tx=>nativeOnboardingOperatingProfile(tx,f.organizationId,f.propertyId)),requested=await command(f,mode==="LINK"?{mode,propertyId:f.propertyId}:f.draft.target),saved=await admitOnboardingOperatingStep(f.ctx,requested,f.deps),after=await tuples(f);
  expect(saved).toMatchObject({sessionId:f.owner.receipt.sessionId,previousRevisionId:f.property.receipt.id,number:3,step:"OPERATING_PROFILE",ownerId:f.owner.receipt.ownerId,propertyId:f.propertyId,replayed:false});
  expect(after.filter(row=>row.kind!=="profile")).toEqual(before.filter(row=>row.kind!=="profile"));if(mode==="LINK")expect(after).toEqual(before);
  expect(await counts(f)).toEqual({owners:1,properties:1,revisions:3,events:3,coreUpdates:mode==="UPDATE"?1:0,agreements:0,payouts:0,portals:0,journals:0});
  await withTenant(db,f.organizationId,async tx=>{
   const row=await tx.propertyOnboardingRevision.findFirstOrThrow({where:{id:saved.id}}),payload=decryptOnboardingOperatingPayload(row.encryptedPayload,{organizationId:f.organizationId,sessionId:row.sessionId,revisionId:row.id,ownerId:row.ownerId,propertyId:f.propertyId,createdBy:row.createdBy,commandKey:row.commandKey,policyId:row.policyId,policyVersion:row.policyVersion},env);
   expect(payload.command).toEqual(requested);expect(payload.previousOperatingProfile).toEqual(original);expect(payload.previousOperatingProfile?.automationNotes).toBe(oldNotes);expect(payload.originalProperty.id).toBe(f.propertyId);expect(payload.originalOwner).toEqual(f.owner.review.owner);expect(payload.originalOperatingProfile).toEqual(await nativeOnboardingOperatingProfile(tx,f.organizationId,f.propertyId));expect(payload.operatingRule).toBeNull();
   for(const privateValue of[oldNotes,requested.reason,"Actual explicitly reviewed operating notes"]){expect(JSON.stringify(row.sourceSnapshot)).not.toContain(privateValue);expect(Buffer.from(row.encryptedPayload).toString("utf8")).not.toContain(privateValue);}
   expect(await tx.auditLog.count({where:{action:"onboarding.step_recorded",after:{path:["revisionId"],equals:saved.id}}})).toBe(1);
   expect((await tx.outboxEvent.findFirstOrThrow({where:{idempotencyKey:"onboarding.step:"+saved.id}})).payload).toEqual({sessionId:saved.sessionId,revisionId:saved.id,step:"OPERATING_PROFILE",ownerId:saved.ownerId,propertyId:f.propertyId});
  });
 });
 it("admits a concurrent duplicate once and rejects another command under its original nonce",async()=>{
  const f=await fixture(),requested=await command(f),saved=await Promise.all([admitOnboardingOperatingStep(f.ctx,requested,f.deps),admitOnboardingOperatingStep(f.ctx,requested,f.deps)]);
  expect(new Set(saved.map(row=>row.id)).size).toBe(1);expect(saved.filter(row=>row.replayed)).toHaveLength(1);await expect(admitOnboardingOperatingStep(f.ctx,{...requested,reason:"Changed original operating command"},f.deps)).rejects.toBeInstanceOf(OnboardingConflictError);expect(await counts(f)).toMatchObject({revisions:3,events:3,coreUpdates:1});
 });
 it("serializes different nonces against the same predecessor without overwriting canonical choices",async()=>{
  const f=await fixture(),first=await command(f),results=await Promise.allSettled([admitOnboardingOperatingStep(f.ctx,first,f.deps),admitOnboardingOperatingStep(f.ctx,{...first,idempotencyKey:randomUUID()},f.deps)]);
  expect(results.filter(result=>result.status==="fulfilled")).toHaveLength(1);const rejected=results.find(result=>result.status==="rejected");expect(rejected?.status==="rejected"&&rejected.reason).toBeInstanceOf(OnboardingConflictError);expect(await counts(f)).toMatchObject({revisions:3,events:3,coreUpdates:1});
 });
 it("rolls back the canonical update, its audit and native history when the onboarding audit fails",async()=>{
  const f=await fixture(),requested=await command(f),before=await tuples(f),write=auditWriter.writeAuditEvent;
  vi.spyOn(auditWriter,"writeAuditEvent").mockImplementation(async(tx,event)=>{if(operatingRecorded(event))throw Error("actual_operating_history_audit_unavailable");return write(tx,event);});
  await expect(admitOnboardingOperatingStep(f.ctx,requested,f.deps)).rejects.toThrow("actual_operating_history_audit_unavailable");expect(await tuples(f)).toEqual(before);expect(await counts(f)).toMatchObject({revisions:2,events:2,coreUpdates:0});
 });
 it.each(["onboarding:edit","onboarding:export","owner:view","property:edit"])("checks current %s again after review before any canonical mutation",async permission=>{
  const f=await fixture(),requested=await command(f),before=await tuples(f);await withTenant(db,f.organizationId,tx=>tx.roleAssignment.update({where:{id:f.grants[permission]},data:{validTo:new Date("2020-01-02")}}));
  await expect(admitOnboardingOperatingStep(f.ctx,requested,f.deps)).rejects.toBeInstanceOf(OnboardingAccessError);expect(await tuples(f)).toEqual(before);expect(await counts(f)).toMatchObject({revisions:2,events:2,coreUpdates:0});
 });
 it("rejects a new policy or actual profile tuple after review without admitting stale choices",async()=>{
  const f=await fixture(),requested=await command(f);await withTenant(db,f.organizationId,tx=>new ConfigRuleRepository(tx,f.organizationId).createVersion({key:onboardingPolicyKey,scopeType:"organization",createdBy:f.account.id,effectiveFrom:new Date("2020-01-01"),value:f.policy,reason:"Actual policy changed after Operating review"}));
  const before=await tuples(f);await expect(admitOnboardingOperatingStep(f.ctx,requested,f.deps)).rejects.toBeInstanceOf(OnboardingConflictError);expect(await tuples(f)).toEqual(before);
  const reviewed=await command(f);await withTenant(db,f.organizationId,tx=>tx.propertyOperatingProfile.update({where:{propertyId:f.propertyId},data:{chefAvailable:false}}));const changed=await tuples(f);await expect(admitOnboardingOperatingStep(f.ctx,reviewed,f.deps)).rejects.toBeInstanceOf(OnboardingConflictError);expect(await tuples(f)).toEqual(changed);expect(await counts(f)).toMatchObject({revisions:2,events:2,coreUpdates:0});
 });
 it.each(["profile","physical","permission"]as const)("rejects a post-audit %s change and rolls back all operational and history writes",async mutation=>{
  const f=await fixture(),requested=await command(f),before=await tuples(f),write=auditWriter.writeAuditEvent;
  vi.spyOn(auditWriter,"writeAuditEvent").mockImplementation(async(tx,event)=>{await write(tx,event);if(!operatingRecorded(event))return;const native=tx as unknown as TenantTransaction;if(mutation==="profile")await native.propertyOperatingProfile.update({where:{propertyId:f.propertyId},data:{chefAvailable:true}});else if(mutation==="physical")await native.property.update({where:{id:f.propertyId},data:{name:"Unreviewed physical mutation"}});else await native.roleAssignment.update({where:{id:f.grants["property:edit"]},data:{validTo:new Date("2020-01-02")}});});
  await expect(admitOnboardingOperatingStep(f.ctx,requested,f.deps)).rejects.toBeInstanceOf(mutation==="permission"?OnboardingAccessError:OnboardingConflictError);expect(await tuples(f)).toEqual(before);expect(await counts(f)).toMatchObject({revisions:2,events:2,coreUpdates:0});
 });
 it("captures the actual resolved mid-stay rule and rejects a subsequently changed version",async()=>{
  const f=await fixture(),target=canonicalOnboardingOperatingDraft({...f.draft,target:{mode:"UPDATE",propertyId:f.propertyId,input:{...nativeOnboardingPropertyProfile(),midStayCleaningEnabled:true,midStayCleaningRuleKey:"ops.mid_stay_threshold"}}}).target;
  const metadata="Original private operational rule metadata retained only in encrypted history",createRule=(nights:number)=>withTenant(db,f.organizationId,tx=>new ConfigRuleRepository(tx,f.organizationId).createVersion({key:"ops.mid_stay_threshold",scopeType:"property",scopeId:f.propertyId,createdBy:f.account.id,effectiveFrom:new Date("2020-01-01"),value:{nights,unprojectedMetadata:metadata},reason:"Actual approved Operating mid-stay rule"}));
  await createRule(7);const stale=await command(f,target);const rule=await createRule(9);await expect(admitOnboardingOperatingStep(f.ctx,stale,f.deps)).rejects.toBeInstanceOf(OnboardingConflictError);const requested=await command(f,target),saved=await admitOnboardingOperatingStep(f.ctx,requested,f.deps);
  await withTenant(db,f.organizationId,async tx=>{const row=await tx.propertyOnboardingRevision.findFirstOrThrow({where:{id:saved.id}}),payload=decryptOnboardingOperatingPayload(row.encryptedPayload,{organizationId:f.organizationId,sessionId:row.sessionId,revisionId:row.id,ownerId:row.ownerId,propertyId:f.propertyId,createdBy:row.createdBy,commandKey:row.commandKey,policyId:row.policyId,policyVersion:row.policyVersion},env);expect(payload.operatingRule).toEqual({id:rule.id,key:"ops.mid_stay_threshold",version:rule.version,value:{nights:9,unprojectedMetadata:metadata}});expect(JSON.stringify(row.sourceSnapshot)).not.toContain(metadata);expect(JSON.stringify(row.sourceSnapshot)).not.toContain("unprojectedMetadata");});
 });
});
