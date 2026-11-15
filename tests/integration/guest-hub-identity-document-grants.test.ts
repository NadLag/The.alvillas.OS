import {randomBytes,randomUUID} from "node:crypto";
import {PrismaClient} from "@prisma/client";
import {beforeAll,afterAll,describe,it,expect} from "vitest";
import {withTenant,type TenantTransactionRunner} from "@/platform/db/tenant";
import {documentRetentionPolicySchema} from "@/modules/documents";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {nativeGuestIdentityDocumentAuthority} from "@/app/api/guest-hub/identity-documents/native-document-authority";
import {createGuestHubIdentityDocumentGrantService} from "@/modules/guest-hub/application/guest-hub-identity-document-grants";
import {activeGuestHubIdentityDocuments} from "@/modules/guest-hub/application/guest-hub-identity-document-source";
import {reviewGuestHubIssue,issueGuestHubLink} from "@/modules/guest-hub/application/guest-hub-service";
import {withGuestHubCapability} from "@/modules/guest-hub/application/guest-hub-visit";
import {reviewGuestHubProfileGrant,recordGuestHubProfileGrant} from "@/modules/guest-hub/application/guest-hub-profile-grants";
import {reviewGuestHubStayDetailsGrant,recordGuestHubStayDetailsGrant} from "@/modules/guest-hub/application/guest-hub-stay-details-grants";
import {viewGuestHubProfile} from "@/modules/guest-hub/application/guest-hub-profile";
import {viewGuestHubStayDetails} from "@/modules/guest-hub/application/guest-hub-stay-details";
import {guestHubIdentityDocumentPolicyKey,GuestHubIdentityDocumentAccessError,GuestHubIdentityDocumentConflictError} from "@/modules/guest-hub/domain/guest-hub-identity-document-policy";
import {GuestHubInvalidLinkError} from "@/modules/guest-hub/domain/guest-hub-policy";
import {nativeGuestHubIdentityDocumentFixture} from "./support/guest-hub-identity-document-fixture";
import {nativeLeadFinancialGuard} from "./support/lead-fixture";
import {provisionIntegrationRole} from "./support/database-role";

type Fixture=Awaited<ReturnType<typeof nativeGuestHubIdentityDocumentFixture>>;
let admin:PrismaClient,db:PrismaClient,financial:Awaited<ReturnType<typeof nativeLeadFinancialGuard>>;
const organizations:string[]=[],env:NodeJS.ProcessEnv={NODE_ENV:"test",ENCRYPTION_KEYS:"owned-identity:"+randomBytes(32).toString("base64")},service=createGuestHubIdentityDocumentGrantService(nativeGuestIdentityDocumentAuthority),deps=()=>({db,env});
async function command(f:Fixture,linkId:string,decision:"GRANTED"|"WITHDRAWN"="GRANTED"){
 const draft={linkId,decision},review=await service.review(f.ctx,draft,deps());return{...draft,idempotencyKey:randomUUID(),reviewFingerprint:review.reviewFingerprint,reason:"Explicit owned original identity document delegation"};
}
async function fresh(grant=false,changes:Parameters<typeof nativeGuestHubIdentityDocumentFixture>[2]={}){
 const f=await nativeGuestHubIdentityDocumentFixture(admin,db,changes);organizations.push(f.organizationId);const draft={reservationId:f.reservation.id},review=await reviewGuestHubIssue(f.ctx,draft,deps()),link=await issueGuestHubLink(f.ctx,{...draft,idempotencyKey:randomUUID(),reviewFingerprint:review.reviewFingerprint,reason:"Owned native identity reservation capability"},deps());
 const visit={...deps(),verificationOrganizationId:f.organizationId,clientKey:"owned-native-identity"},capability={token:link.token};if(grant)await service.record(f.ctx,await command(f,link.id),deps());return{f,link,visit,capability};
}
type Current=Awaited<ReturnType<typeof fresh>>;
const active=(current:Current,override:NodeJS.ProcessEnv=env)=>withGuestHubCapability(current.capability,{...current.visit,env:override},context=>activeGuestHubIdentityDocuments(context,nativeGuestIdentityDocumentAuthority,override));
async function archiveGrant(current:Current,key:string){await withTenant(db,current.f.organizationId,tx=>tx.roleAssignment.update({where:{id:current.f.grants[key]},data:{archivedAt:new Date()}}));}
async function identityPolicy(current:Current,changes:Partial<Fixture["identityPolicy"]>){await withTenant(db,current.f.organizationId,tx=>new ConfigRuleRepository(tx,current.f.organizationId).createVersion({key:guestHubIdentityDocumentPolicyKey,scopeType:"property",scopeId:current.f.property.id,createdBy:current.f.account.id,effectiveFrom:new Date("2020-01-01"),value:{...current.f.identityPolicy,...changes},reason:"Actual owned identity processing change"}));}
function originalMethod(target:object,key:string|symbol):unknown{
 const value:unknown=Reflect.get(target,key);if(typeof value!=="function")return value;
 const callable=value as (this:object,...args:unknown[])=>unknown;return(...args:unknown[]):unknown=>Reflect.apply<object,unknown[],unknown>(callable,target,args);
}
beforeAll(async()=>{
 const value=process.env.TEST_DATABASE_URL,url=value?new URL(value):null;if(!url||!["localhost","127.0.0.1"].includes(url.hostname)||!(url.pathname==="/alvillas_automation_guest249_identity_20261114"||process.env.GITHUB_ACTIONS==="true"&&url.pathname==="/alvillas_os"))throw Error("Owned migrated249 native identity database required");
 admin=new PrismaClient({datasourceUrl:value});expect((await admin.$queryRaw<Array<{count:number}>>`SELECT count(*)::int AS count FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`)[0].count).toBeGreaterThanOrEqual(249);await provisionIntegrationRole(admin,"alvillas_ops_tests");url.username=url.password="alvillas_ops_tests";db=new PrismaClient({datasourceUrl:url.toString()});financial=await nativeLeadFinancialGuard(admin,db);
},120000);
afterAll(async()=>{try{if(financial)await financial.assertPreserved(organizations);}finally{await db?.$disconnect();await admin?.$disconnect();}});

describe("actual signed native identity document delegations",()=>{
 it("keeps a read link separate from document creation and binds one immutable canonical delegation atomically",async()=>{
  const current=await fresh();await expect(active(current)).rejects.toBeInstanceOf(GuestHubInvalidLinkError);const input=await command(current.f,current.link.id),saved=await service.record(current.f.ctx,input,deps()),result=await active(current);
  expect(result.grant.id).toBe(saved.id);expect(result.policy.documents).toHaveLength(1);expect(result.policy.documents[0]).toMatchObject({kind:"PASSPORT",contentTypes:["image/jpeg"],maxBytes:1024});
  const retained=await withTenant(db,current.f.organizationId,async tx=>({grant:await tx.guestHubFormGrant.findUniqueOrThrow({where:{id:saved.id}}),delegation:await tx.guestHubIdentityDocumentDelegation.findUniqueOrThrow({where:{organizationId_grantId:{organizationId:current.f.organizationId,grantId:saved.id}}}),audit:await tx.auditLog.count({where:{resourceId:saved.id,action:"guest_hub.form_grant_recorded"}})}));
  expect(retained.delegation.createdAt).toEqual(retained.grant.createdAt);expect(retained.audit).toBe(1);expect(retained.grant.formKey).toBe("IDENTITY_DOCUMENTS");expect(await withTenant(db,current.f.organizationId,tx=>tx.document.count())).toBe(0);expect(await withTenant(db,current.f.organizationId,tx=>tx.documentAdmission.count())).toBe(0);
 });
 it.each(["property:view","document:view","document:create","document:edit","guest:edit","guest_hub_identity_documents:create"])("requires independent current %s authority before grant and collection",async key=>{
  const current=await fresh(true);await archiveGrant(current,key);if(key==="guest:edit")await expect(service.status(current.f.ctx,{linkId:current.link.id},deps())).rejects.toBeInstanceOf(GuestHubIdentityDocumentAccessError);else expect((await service.status(current.f.ctx,{linkId:current.link.id},deps())).canGrant).toBe(false);await expect(active(current)).rejects.toBeInstanceOf(GuestHubInvalidLinkError);
 });
 it("rejects another property scope even when the actor retains the named permission",async()=>{
  const current=await fresh();await withTenant(db,current.f.organizationId,tx=>tx.roleAssignment.update({where:{id:current.f.grants["document:create"]},data:{scopeId:randomUUID()}}));await expect(command(current.f,current.link.id)).rejects.toBeInstanceOf(GuestHubIdentityDocumentAccessError);expect(await withTenant(db,current.f.organizationId,tx=>tx.guestHubIdentityDocumentDelegation.count())).toBe(0);
 });
 it("recovers the original recorded decision and refuses changed commands without creating another delegation",async()=>{
  const current=await fresh(),input=await command(current.f,current.link.id),attempts=await Promise.all([service.record(current.f.ctx,input,deps()),service.record(current.f.ctx,input,deps())]),saved=attempts[0],recovered=await service.recover(current.f.ctx,{linkId:current.link.id,idempotencyKey:input.idempotencyKey},deps());expect(attempts.map(item=>item.replayed).sort()).toEqual([false,true]);expect(attempts[1].id).toBe(saved.id);expect(recovered).toMatchObject({id:saved.id,recorded:true});
  await expect(service.record(current.f.ctx,{...input,reason:input.reason+" changed"},deps())).rejects.toBeInstanceOf(GuestHubIdentityDocumentConflictError);expect(await withTenant(db,current.f.organizationId,tx=>tx.guestHubIdentityDocumentDelegation.count())).toBe(1);
 });
 it("rejects archive or retention changes admitted after review before any grant, audit or delegation is recorded",async()=>{
  const current=await fresh(),input=await command(current.f,current.link.id);await withTenant(db,current.f.organizationId,async tx=>{const rules=new ConfigRuleRepository(tx,current.f.organizationId),old=await rules.resolve({key:"documents.retention",scopes:[{scopeType:"organization",scopeId:null}],asOf:new Date()});if(!old)throw Error("Owned actual retention policy required");await rules.createVersion({key:"documents.retention",scopeType:"organization",scopeId:null,createdBy:current.f.account.id,effectiveFrom:new Date("2020-01-01"),value:old.value,reason:"Actual newer native retention revision"});});
  await expect(service.record(current.f.ctx,input,deps())).rejects.toBeInstanceOf(GuestHubIdentityDocumentConflictError);expect(await withTenant(db,current.f.organizationId,tx=>tx.guestHubFormGrant.count({where:{formKey:"IDENTITY_DOCUMENTS"}}))).toBe(0);expect(await withTenant(db,current.f.organizationId,tx=>tx.guestHubIdentityDocumentDelegation.count())).toBe(0);
 });
 it("keeps original cross-form nonces private instead of reminting document authority",async()=>{
  const current=await fresh(),draft={linkId:current.link.id,decision:"GRANTED" as const},review=await reviewGuestHubProfileGrant(current.f.ctx,draft,deps()),nonce=randomUUID();await recordGuestHubProfileGrant(current.f.ctx,{...draft,idempotencyKey:nonce,reviewFingerprint:review.reviewFingerprint,reason:"Owned original profile nonce is not document authority"},deps());
  await expect(service.recover(current.f.ctx,{linkId:current.link.id,idempotencyKey:nonce},deps())).rejects.toBeInstanceOf(GuestHubIdentityDocumentAccessError);const input=await command(current.f,current.link.id);await expect(service.record(current.f.ctx,{...input,idempotencyKey:nonce},deps())).rejects.toBeInstanceOf(GuestHubIdentityDocumentAccessError);expect(await withTenant(db,current.f.organizationId,tx=>tx.guestHubIdentityDocumentDelegation.count())).toBe(0);
 });
 it("closes collection after processing withdrawal while preserving metadata-only grant recovery without private keys",async()=>{
  const current=await fresh(),input=await command(current.f,current.link.id),saved=await service.record(current.f.ctx,input,deps());await identityPolicy(current,{enabled:false});await expect(active(current)).rejects.toBeInstanceOf(GuestHubInvalidLinkError);await archiveGrant(current,"document:create");
  expect(await service.recover(current.f.ctx,{linkId:current.link.id,idempotencyKey:input.idempotencyKey},{db,env:{NODE_ENV:"test"}})).toMatchObject({id:saved.id,recorded:true});const withdrawal=await command(current.f,current.link.id,"WITHDRAWN"),receipt=await service.record(current.f.ctx,withdrawal,deps());expect(receipt.version).toBe(2);expect(await withTenant(db,current.f.organizationId,tx=>tx.guestHubIdentityDocumentDelegation.count())).toBe(1);
 });
 it("forces native tenant isolation and never releases another tenant's original grant or delegation",async()=>{
  const current=await fresh(true),foreign=await fresh(),saved=await active(current);expect(await withTenant(db,foreign.f.organizationId,tx=>tx.guestHubIdentityDocumentDelegation.findMany({where:{grantId:saved.grant.id}}))).toEqual([]);await expect(service.status(foreign.f.ctx,{linkId:current.link.id},deps())).rejects.toBeInstanceOf(GuestHubIdentityDocumentAccessError);await expect(withGuestHubCapability(current.capability,{...current.visit,expectedLinkId:foreign.link.id},context=>activeGuestHubIdentityDocuments(context,nativeGuestIdentityDocumentAuthority,env))).rejects.toBeInstanceOf(GuestHubInvalidLinkError);
 });
 it("preserves an original delegation under retained rotated keys and denies removed signing keys",async()=>{
  const current=await fresh(true),rotated={...env,ENCRYPTION_KEYS:"new-identity:"+randomBytes(32).toString("base64")+","+env.ENCRYPTION_KEYS};expect((await active(current,rotated)).grant.formKey).toBe("IDENTITY_DOCUMENTS");await expect(active(current,{...env,ENCRYPTION_KEYS:"removed-identity:"+randomBytes(32).toString("base64")})).rejects.toThrow();
 });
 it("denies update and deletion of the original signed delegation",async()=>{
  const current=await fresh(true),saved=await active(current),where={organizationId_grantId:{organizationId:current.f.organizationId,grantId:saved.grant.id}};await expect(withTenant(db,current.f.organizationId,tx=>tx.guestHubIdentityDocumentDelegation.update({where,data:{signature:"b".repeat(64)}}))).rejects.toThrow(/native_onboarding_history_immutable/u);await expect(withTenant(db,current.f.organizationId,tx=>tx.guestHubIdentityDocumentDelegation.delete({where}))).rejects.toThrow(/native_onboarding_history_immutable/u);
 });
 it("denies an original form-grant birth when its atomic document authority delegation is omitted",async()=>{
  const current=await fresh();
  // Exercise the real generic admission and omit only its internal extension write inside a rollback-safe transaction proxy.
  const wrapped:TenantTransactionRunner={$transaction:(work,options)=>db.$transaction(tx=>work(new Proxy(tx,{get(target,key){if(key==="guestHubIdentityDocumentDelegation")return new Proxy(target.guestHubIdentityDocumentDelegation,{get(model,method){return method==="create"?()=>Promise.resolve({}):originalMethod(model,method);}});return originalMethod(target,key);}})),options)};
  const input=await command(current.f,current.link.id);await expect(service.record(current.f.ctx,input,{...deps(),db:wrapped})).rejects.toThrow(/requires_atomic_original_document_authority_delegation/u);expect(await withTenant(db,current.f.organizationId,tx=>tx.guestHubFormGrant.count({where:{formKey:"IDENTITY_DOCUMENTS"}}))).toBe(0);
 });
 it("preserves the original PROFILE and STAY_DETAILS protocols and source history after the forward migration",async()=>{
  const current=await fresh();for(const[review,record]of[[reviewGuestHubProfileGrant,recordGuestHubProfileGrant],[reviewGuestHubStayDetailsGrant,recordGuestHubStayDetailsGrant]]as const){const draft={linkId:current.link.id,decision:"GRANTED" as const},checked=await review(current.f.ctx,draft,deps());await record(current.f.ctx,{...draft,idempotencyKey:randomUUID(),reviewFingerprint:checked.reviewFingerprint,reason:"Preserve original native form grant protocol"},deps());}
  expect((await viewGuestHubProfile(current.capability,current.visit)).linkId).toBe(current.link.id);expect((await viewGuestHubStayDetails(current.capability,current.visit)).linkId).toBe(current.link.id);expect(await withTenant(db,current.f.organizationId,tx=>tx.guestHubIdentityDocumentDelegation.count())).toBe(0);
 });
 it("closes collection when a later rule repurposes the original retained legal references",async()=>{
  const current=await fresh(true);await withTenant(db,current.f.organizationId,async tx=>{const rules=new ConfigRuleRepository(tx,current.f.organizationId),old=await rules.resolve({key:"documents.retention",scopes:[{scopeType:"organization",scopeId:null}],asOf:new Date()});if(!old)throw Error("Owned original retention policy required");const policy=documentRetentionPolicySchema.parse(old.value);await rules.createVersion({key:"documents.retention",scopeType:"organization",scopeId:null,createdBy:current.f.account.id,effectiveFrom:new Date("2020-01-01"),value:{...policy,tags:policy.tags.map(tag=>({...tag,policy_references:["Different owned purpose requires a fresh grant"]}))},reason:"Actual later retention reference change"});});await expect(active(current)).rejects.toBeInstanceOf(GuestHubInvalidLinkError);expect(await withTenant(db,current.f.organizationId,tx=>tx.guestHubIdentityDocumentDelegation.count())).toBe(1);
 });
});
