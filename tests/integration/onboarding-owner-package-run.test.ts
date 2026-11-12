import {createHash,randomBytes,randomUUID} from "node:crypto";
import {PrismaClient} from "@prisma/client";
import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from "vitest";
import {withTenant,type TenantTransaction} from "@/platform/db/tenant";
import {authContextForAccount} from "@/platform/authz/account-context";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import * as audit from "@/platform/audit/audit-writer";
import {OutboxRepository} from "@/platform/events/outbox-repository";
import {DocumentRepository} from "@/modules/documents/infrastructure/document-repository";
import {executeDocumentGenerationReference} from "@/modules/documents/application/document-generation-worker";
import {downloadDocumentVersion} from "@/modules/documents/application/document-archive";
import {admitOnboardingOwnerPackage,completeOnboardingOwnerPackage,recoverOnboardingOwnerPackage,reviewOnboardingOwnerPackage} from "@/modules/onboarding/application/onboarding-owner-package-service";
import {OnboardingAccessError,OnboardingConflictError} from "@/modules/onboarding/domain/onboarding-wizard";
import {onboardingOwnerPackagePolicyKey} from "@/modules/onboarding/domain/onboarding-owner-package-policy";
import {OnboardingOwnerPackageRepository} from "@/modules/onboarding/infrastructure/onboarding-owner-package-repository";
import {nativeOnboardingOwnerPackageFixture} from "./support/onboarding-owner-package-fixture";
import {nativeDocumentObjectFixture} from "./support/document-object-store-fixture";
import {nativeLeadFinancialGuard} from "./support/lead-fixture";
import {provisionIntegrationRole} from "./support/database-role";

let admin:PrismaClient,db:PrismaClient,financial:Awaited<ReturnType<typeof nativeLeadFinancialGuard>>,storage:Awaited<ReturnType<typeof nativeDocumentObjectFixture>>;
const organizations:string[]=[],env:NodeJS.ProcessEnv={NODE_ENV:"test",ENCRYPTION_KEYS:"native-paired-package:"+randomBytes(32).toString("base64")};
beforeAll(async()=>{
 const value=process.env.TEST_DATABASE_URL,url=value?new URL(value):null;
 if(!url||!["localhost","127.0.0.1"].includes(url.hostname)||!(url.pathname==="/alvillas_automation_onb239_package_run_20261112"||process.env.GITHUB_ACTIONS==="true"&&url.pathname==="/alvillas_os"))throw Error("Owned migrated239 native paired-package database required");
 admin=new PrismaClient({datasourceUrl:value});
 expect((await admin.$queryRaw<Array<{count:number}>>`SELECT count(*)::int AS count FROM _prisma_migrations WHERE migration_name='20261112110000_atomic_owner_package_documents' AND finished_at IS NOT NULL AND rolled_back_at IS NULL`)[0].count).toBe(1);
 await provisionIntegrationRole(admin,"alvillas_ops_tests");url.username=url.password="alvillas_ops_tests";db=new PrismaClient({datasourceUrl:url.toString()});
 financial=await nativeLeadFinancialGuard(admin,db);storage=await nativeDocumentObjectFixture(env);
});
afterEach(()=>vi.restoreAllMocks());
afterAll(async()=>{try{if(financial)await financial.assertPreserved(organizations);}finally{await storage?.close();await db?.$disconnect();await admin?.$disconnect();}});
async function fixture(){const f=await nativeOnboardingOwnerPackageFixture(admin,db,env,storage);organizations.push(f.organizationId);return f;}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function command(f:Fixture){const draft={sessionId:f.review.sessionId,reviewRevisionId:f.review.id},review=await reviewOnboardingOwnerPackage(f.ctx,draft,f.deps);return{...draft,idempotencyKey:randomUUID(),reviewFingerprint:review.reviewFingerprint,reason:"Generate both actual approved native owner package originals"};}
async function counts(f:Fixture){return withTenant(db,f.organizationId,async tx=>({packages:await tx.ownerOnboardingPackage.count(),items:await tx.ownerOnboardingPackageItem.count(),instances:await tx.documentInstance.count(),events:await tx.outboxEvent.count({where:{type:"documents.instance.requested"}})}));}
async function withdraw(f:Fixture,key:string){await withTenant(db,f.organizationId,tx=>tx.roleAssignment.update({where:{id:f.grants[key]},data:{archivedAt:new Date()}}));}
const recovery=(f:Fixture,idempotencyKey:string)=>recoverOnboardingOwnerPackage(f.ctx,{sessionId:f.review.sessionId,idempotencyKey},f.deps);

describe("atomic genuine owner package and canonical document workers",()=>{
 it("requires both real archived EN/FR PDFs, recovers a single completed child and retains originals after policy retirement",async()=>{
  const f=await fixture(),input=await command(f),pending=await admitOnboardingOwnerPackage(f.ctx,input,f.deps);
  expect(pending.state).toBe("PENDING");expect(pending.documents.map(row=>row.locale)).toEqual(["en","fr"]);
  expect(await counts(f)).toEqual({packages:1,items:2,instances:2,events:2});
  const events=await withTenant(db,f.organizationId,tx=>tx.outboxEvent.findMany({where:{type:"documents.instance.requested"},orderBy:{occurredAt:"asc"}}));
  expect(events.map(row=>row.payload)).toEqual(pending.documents.map(row=>({instanceId:row.instanceId})));
  const workerDeps={...f.deps,objects:storage.objects};
  const first=await executeDocumentGenerationReference({organizationId:f.organizationId,outboxEventId:events[0].id},workerDeps);
  expect(first.state).toBe("COMPLETE");const partial=await recovery(f,input.idempotencyKey);
  expect(partial.recorded&&partial.package?.state).toBe("PENDING");
  expect(partial.recorded&&partial.package?.documents.filter(row=>row.state==="COMPLETE")).toHaveLength(1);
  const complete=await completeOnboardingOwnerPackage(f.ctx,{packageId:pending.packageId},workerDeps);
  expect(complete.state).toBe("COMPLETE");expect(new Set(complete.documents.map(row=>row.versionId)).size).toBe(2);
  const hashes=[];
  for(const document of complete.documents){
   expect(document.versionId).toBeTruthy();const file=await downloadDocumentVersion(f.ctx,{versionId:document.versionId},workerDeps);
   expect(Buffer.from(file.bytes).subarray(0,5).toString()).toBe("%PDF-");hashes.push(createHash("sha256").update(file.bytes).digest("hex"));
  }
  expect(new Set(hashes).size).toBe(2);
  await withTenant(db,f.organizationId,tx=>new ConfigRuleRepository(tx,f.organizationId).createVersion({key:onboardingOwnerPackagePolicyKey,scopeType:"property",scopeId:f.review.propertyId!,createdBy:f.account.id,effectiveFrom:f.rule.effectiveFrom,value:f.packagePolicy,lifecycle:"RETIRED",reason:"Retire creation while preserving both actual historical originals"}));
  expect((await recovery(f,input.idempotencyKey))).toEqual({recorded:true,package:complete});
  expect(await admitOnboardingOwnerPackage(f.ctx,input,f.deps)).toEqual(complete);
  expect(await executeDocumentGenerationReference({organizationId:f.organizationId,outboxEventId:events[1].id},workerDeps)).toMatchObject({state:"COMPLETE"});
  expect(await counts(f)).toEqual({packages:1,items:2,instances:2,events:2});
  await withTenant(db,f.organizationId,async tx=>{expect((await tx.property.findUniqueOrThrow({where:{id:f.review.propertyId!}})).status).toBe("DRAFT");expect(await tx.operationTask.count()).toBe(0);expect(await tx.propertyOnboardingActivationRequest.count()).toBe(0);});
 },120000);
 it("serializes concurrent replay of the original nonce without duplicate children or worker events",async()=>{
  const f=await fixture(),input=await command(f),results=await Promise.all([admitOnboardingOwnerPackage(f.ctx,input,f.deps),admitOnboardingOwnerPackage(f.ctx,input,f.deps)]);
  expect(results[0].packageId).toBe(results[1].packageId);expect(results.map(row=>row.replayed).sort()).toEqual([false,true]);
  expect(await counts(f)).toEqual({packages:1,items:2,instances:2,events:2});
 });
 it("recovers a committed package after its response was lost and rejects a changed command under that nonce",async()=>{
  const f=await fixture(),input=await command(f),pending=await admitOnboardingOwnerPackage(f.ctx,input,f.deps);
  expect(await recovery(f,input.idempotencyKey)).toEqual({recorded:true,package:{...pending,replayed:true}});
  await expect(admitOnboardingOwnerPackage(f.ctx,{...input,reason:"A different actual command cannot replace the saved original"},f.deps)).rejects.toBeInstanceOf(OnboardingConflictError);
  expect(await counts(f)).toEqual({packages:1,items:2,instances:2,events:2});
 });
 it.each(["financial_transaction:export","owner_statement:export","team_member:view","onboarding:edit"])("denies withdrawn independent %s before admitting either language",async key=>{
  const f=await fixture(),input=await command(f);await withdraw(f,key);
  await expect(admitOnboardingOwnerPackage(f.ctx,input,f.deps)).rejects.toBeInstanceOf(OnboardingAccessError);
  expect(await counts(f)).toEqual({packages:0,items:0,instances:0,events:0});
 });
 it("does not enlarge the held actor cap after an independently withdrawn finance grant is restored",async()=>{
  const f=await fixture(),input=await command(f);await withdraw(f,"financial_transaction:export");
  f.ctx.authContext={...await authContextForAccount(f.organizationId,f.account.id,{db}),personId:f.person.id};
  await withTenant(db,f.organizationId,tx=>tx.roleAssignment.update({where:{id:f.grants["financial_transaction:export"]},data:{archivedAt:null}}));
  await expect(admitOnboardingOwnerPackage(f.ctx,input,f.deps)).rejects.toBeInstanceOf(OnboardingAccessError);
  expect(await counts(f)).toEqual({packages:0,items:0,instances:0,events:0});
 });
 it("rolls back both real child admissions and their outboxes when the parent audit fails",async()=>{
  const f=await fixture(),input=await command(f),write=audit.writeAuditEvent;
  vi.spyOn(audit,"writeAuditEvent").mockImplementation((tx,event)=>{if(event.action==="onboarding.owner_package_requested")throw Error("Actual parent audit failure after child admission");return write(tx,event);});
  await expect(admitOnboardingOwnerPackage(f.ctx,input,f.deps)).rejects.toThrow("Actual parent audit failure after child admission");
  expect(await counts(f)).toEqual({packages:0,items:0,instances:0,events:0});
  expect(await recovery(f,input.idempotencyKey)).toEqual({recorded:false,package:null});
 });
 it("rolls back a native Property correction while materializing a real child",async()=>{
  const f=await fixture(),input=await command(f),instance=Object.getOwnPropertyDescriptor(DocumentRepository.prototype,"instance")!.value as DocumentRepository["instance"];
  let injected=false;
  vi.spyOn(DocumentRepository.prototype,"instance").mockImplementation(async function(this:DocumentRepository,id){const row=await instance.call(this,id);if(row&&!injected){injected=true;await(this as unknown as {tx:TenantTransaction}).tx.property.update({where:{id:f.review.propertyId!},data:{name:"Rejected actual concurrent native source correction"}});}return row;});
  await expect(admitOnboardingOwnerPackage(f.ctx,input,f.deps)).rejects.toBeInstanceOf(OnboardingConflictError);expect(injected).toBe(true);
  expect(await counts(f)).toEqual({packages:0,items:0,instances:0,events:0});
  expect((await withTenant(db,f.organizationId,tx=>tx.property.findUniqueOrThrow({where:{id:f.review.propertyId!}}))).name).toBe(f.original.validation.facts.property!.name);
 });
 it.each(["MISSING_ITEM","MISSING_AUDIT","MISSING_WORKER"]as const)("rejects %s at the actual deferred package SQL boundary",async mode=>{
  const f=await fixture(),input=await command(f);
  if(mode==="MISSING_ITEM"){
   const create=Object.getOwnPropertyDescriptor(OnboardingOwnerPackageRepository.prototype,"createPackageItem")!.value as OnboardingOwnerPackageRepository["createPackageItem"];
   vi.spyOn(OnboardingOwnerPackageRepository.prototype,"createPackageItem").mockImplementation(function(this:OnboardingOwnerPackageRepository,data){
    if(data.locale!=="fr")return create.call(this,data);
    return(this as unknown as {tx:TenantTransaction}).tx.ownerOnboardingPackageItem.findFirstOrThrow({where:{packageId:data.packageId,locale:"en"}});
   });
  }else if(mode==="MISSING_AUDIT"){
   const write=audit.writeAuditEvent;
   vi.spyOn(audit,"writeAuditEvent").mockImplementation((tx,event)=>event.action==="onboarding.owner_package_requested"?Promise.resolve():write(tx,event));
  }else{
   const append=Object.getOwnPropertyDescriptor(OutboxRepository.prototype,"append")!.value as OutboxRepository["append"];let instances=0;
   vi.spyOn(OutboxRepository.prototype,"append").mockImplementation(function(this:OutboxRepository,type,payload,key,at){
    if(type!=="documents.instance.requested"||++instances!==2)return append.call(this,type,payload,key,at);
    return(this as unknown as {tx:TenantTransaction}).tx.outboxEvent.findFirstOrThrow({where:{type:"documents.instance.requested"}});
   });
  }
  await expect(admitOnboardingOwnerPackage(f.ctx,input,f.deps)).rejects.toThrow(mode==="MISSING_ITEM"?"owner package requires all actual language admissions in the same transaction":mode==="MISSING_AUDIT"?"owner package requires its exact atomic private audit":"owner package requires both canonical document worker outboxes");
  expect(await counts(f)).toEqual({packages:0,items:0,instances:0,events:0});
 });
 it("preserves a completed original and reports SOURCE_CHANGED when the remaining native child becomes stale",async()=>{
  const f=await fixture(),input=await command(f),pending=await admitOnboardingOwnerPackage(f.ctx,input,f.deps),event=await withTenant(db,f.organizationId,tx=>tx.outboxEvent.findFirstOrThrow({where:{type:"documents.instance.requested",payload:{path:["instanceId"],equals:pending.documents[0].instanceId}}}));
  const first=await executeDocumentGenerationReference({organizationId:f.organizationId,outboxEventId:event.id},{...f.deps,objects:storage.objects});
  await withTenant(db,f.organizationId,tx=>tx.property.update({where:{id:f.review.propertyId!},data:{name:"Actual subsequent corrected Property"}}));
  const current=await completeOnboardingOwnerPackage(f.ctx,{packageId:pending.packageId},{...f.deps,objects:storage.objects});
  expect(current.state).toBe("SOURCE_CHANGED");expect(current.documents[0]).toMatchObject({state:"COMPLETE",versionId:first.versionId});expect(current.documents[1]).toMatchObject({state:"SOURCE_CHANGED",versionId:null});
  expect(await counts(f)).toEqual({packages:1,items:2,instances:2,events:2});
 });
 it("hides both package tables through forced tenant RLS and denies foreign-session recovery",async()=>{
  const f=await fixture(),input=await command(f),pending=await admitOnboardingOwnerPackage(f.ctx,input,f.deps),foreign=await fixture();
  expect(await withTenant(db,foreign.organizationId,async tx=>({parent:await tx.ownerOnboardingPackage.findFirst({where:{id:pending.packageId}}),items:await tx.ownerOnboardingPackageItem.findMany({where:{packageId:pending.packageId}})}))).toEqual({parent:null,items:[]});
  await expect(recoverOnboardingOwnerPackage(foreign.ctx,{sessionId:f.review.sessionId,idempotencyKey:input.idempotencyKey},foreign.deps)).rejects.toBeInstanceOf(OnboardingAccessError);
 });
 it("rejects a nonce already used by an actual native predecessor",async()=>{
  const f=await fixture(),input=await command(f),prior=await withTenant(db,f.organizationId,tx=>tx.propertyOnboardingRevision.findUniqueOrThrow({where:{id:f.review.id}}));
  await expect(admitOnboardingOwnerPackage(f.ctx,{...input,idempotencyKey:prior.commandKey},f.deps)).rejects.toBeInstanceOf(OnboardingConflictError);
  expect(await counts(f)).toEqual({packages:0,items:0,instances:0,events:0});
 });
 it.each(["parent_update","parent_delete","item_update","item_delete"]as const)("rejects %s on committed native package lineage",async mode=>{
  const f=await fixture(),input=await command(f),pending=await admitOnboardingOwnerPackage(f.ctx,input,f.deps);
  await expect(withTenant(db,f.organizationId,async tx=>{await(mode==="parent_update"?tx.ownerOnboardingPackage.update({where:{id:pending.packageId},data:{requestId:randomUUID()}}):mode==="parent_delete"?tx.ownerOnboardingPackage.delete({where:{id:pending.packageId}}):mode==="item_update"?tx.ownerOnboardingPackageItem.updateMany({where:{packageId:pending.packageId},data:{locale:"ar"}}):tx.ownerOnboardingPackageItem.deleteMany({where:{packageId:pending.packageId}}));})).rejects.toThrow(/append.only/);
  expect(await counts(f)).toEqual({packages:1,items:2,instances:2,events:2});
 });
});
