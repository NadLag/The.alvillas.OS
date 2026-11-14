import {randomBytes,randomUUID} from "node:crypto";
import {PrismaClient} from "@prisma/client";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {withTenant} from "@/platform/db/tenant";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {issueGuestHubLink,reviewGuestHubIssue,reviewGuestHubRevocation,revokeGuestHubLink} from "@/modules/guest-hub/application/guest-hub-service";
import {readGuestHubWorkspace} from "@/modules/guest-hub/application/guest-hub-workspace";
import {GuestHubAccessError,GuestHubConflictError,guestHubLinkPolicyKey} from "@/modules/guest-hub/domain/guest-hub-policy";
import {nativeGuestHubFixture,nativeGuestHubSecondActor} from "./support/guest-hub-fixture";
import {nativeLeadFinancialGuard} from "./support/lead-fixture";
import {provisionIntegrationRole} from "./support/database-role";

type Fixture=Awaited<ReturnType<typeof nativeGuestHubFixture>>;
let admin:PrismaClient,db:PrismaClient,f:Fixture,other:Awaited<ReturnType<typeof nativeGuestHubSecondActor>>,financial:Awaited<ReturnType<typeof nativeLeadFinancialGuard>>,firstCursor:string;
const organizations:string[]=[],env:NodeJS.ProcessEnv={NODE_ENV:"test",ENCRYPTION_KEYS:"native-guest-workspace:"+randomBytes(32).toString("base64")},saved:Array<Awaited<ReturnType<typeof issueGuestHubLink>>>=[],deps=()=>({db,env}),input=()=>({reservationId:f.reservation.id});
beforeAll(async()=>{
 const value=process.env.TEST_DATABASE_URL,url=value?new URL(value):null;if(!url||!["localhost","127.0.0.1"].includes(url.hostname)||!(url.pathname==="/alvillas_automation_guest244_links_20261114"||process.env.GITHUB_ACTIONS==="true"&&url.pathname==="/alvillas_os"))throw Error("Owned migrated244 Guest Hub history database required");admin=new PrismaClient({datasourceUrl:value});expect((await admin.$queryRaw<Array<{count:number}>>`SELECT count(*)::int AS count FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`)[0].count).toBeGreaterThanOrEqual(244);await provisionIntegrationRole(admin,"alvillas_ops_tests");url.username=url.password="alvillas_ops_tests";db=new PrismaClient({datasourceUrl:url.toString()});financial=await nativeLeadFinancialGuard(admin,db);f=await nativeGuestHubFixture(admin,db);organizations.push(f.organizationId);const draft=input(),review=await reviewGuestHubIssue(f.ctx,draft,deps());for(let index=0;index<26;index++)saved.push(await issueGuestHubLink(f.ctx,{...draft,idempotencyKey:randomUUID(),reviewFingerprint:review.reviewFingerprint,reason:"Actual native paginated guest-link history "+String(index+1)},deps()));other=await nativeGuestHubSecondActor(db,f);
},120000);
afterAll(async()=>{try{if(financial)await financial.assertPreserved(organizations);}finally{await db?.$disconnect();await admin?.$disconnect();}});

describe("actual private native Guest Hub history",()=>{
 it("pages26 genuine original admissions without duplicates, bearer bytes or ciphertext",async()=>{
  const first=await readGuestHubWorkspace(f.ctx,input(),deps());expect(first.items).toHaveLength(25);expect(first.next).toBeTypeOf("string");firstCursor=first.next!;const second=await readGuestHubWorkspace(f.ctx,{...input(),cursor:firstCursor},deps()),ids=[...first.items,...second.items].map(row=>row.id);expect(second.items).toHaveLength(1);expect(second.next).toBeNull();expect(new Set(ids).size).toBe(26);expect(new Set(ids)).toEqual(new Set(saved.map(row=>row.id)));expect(first).toMatchObject({reservationId:f.reservation.id,propertyId:f.property.id,locale:"fr",canCreate:true,issuanceAvailable:true});for(const row of first.items){expect(row.originalCreator).toBe(true);expect(row.recoveryKey).toMatch(/^[a-f0-9-]{36}$/u);expect(row.canRevoke).toBe(true);for(const key of["token","encryptedPayload","payloadSha256","guestId","authorizationCap"])expect(row).not.toHaveProperty(key);}expect(saved.some(row=>JSON.stringify(first).includes(row.token!))).toBe(false);
 });
 it("shows authorized history to another actual operator while withholding every creator-only recovery key",async()=>{
  const result=await readGuestHubWorkspace(other,input(),deps());expect(result.items).toHaveLength(25);expect(result.items.every(row=>!row.originalCreator&&row.recoveryKey===undefined&&row.canRevoke)).toBe(true);await expect(readGuestHubWorkspace(other,{...input(),cursor:firstCursor},deps())).rejects.toBeInstanceOf(GuestHubConflictError);
 });
 it("withholds recovery keys and mutation controls under actual independent create and revoke withdrawal",async()=>{
  const keys=["guest_hub:create","guest_hub:void"];for(const key of keys)await withTenant(db,f.organizationId,tx=>tx.roleAssignment.update({where:{id:f.grants[key]},data:{archivedAt:new Date()}}));try{const result=await readGuestHubWorkspace(f.ctx,input(),deps());expect(result.canCreate).toBe(false);expect(result.items.every(row=>row.originalCreator&&row.recoveryKey===undefined&&!row.canRevoke)).toBe(true);}finally{for(const key of keys)await withTenant(db,f.organizationId,tx=>tx.roleAssignment.update({where:{id:f.grants[key]},data:{archivedAt:null}}));}
 });
 it("denies current view withdrawal and a foreign stay before touching private cursor keys",async()=>{
  await withTenant(db,f.organizationId,tx=>tx.roleAssignment.update({where:{id:f.grants["guest_hub:view"]},data:{archivedAt:new Date()}}));try{await expect(readGuestHubWorkspace(f.ctx,{...input(),cursor:firstCursor},{db,env:{NODE_ENV:"test"}})).rejects.toBeInstanceOf(GuestHubAccessError);}finally{await withTenant(db,f.organizationId,tx=>tx.roleAssignment.update({where:{id:f.grants["guest_hub:view"]},data:{archivedAt:null}}));}await expect(readGuestHubWorkspace(f.ctx,{reservationId:randomUUID(),cursor:firstCursor},{db,env:{NODE_ENV:"test"}})).rejects.toBeInstanceOf(GuestHubAccessError);
 });
 it("binds pagination to the actual current policy and closes an authentic stale cursor after correction",async()=>{
  const before=await readGuestHubWorkspace(f.ctx,input(),deps());await withTenant(db,f.organizationId,tx=>new ConfigRuleRepository(tx,f.organizationId).createVersion({key:guestHubLinkPolicyKey,scopeType:"organization",scopeId:null,createdBy:f.account.id,effectiveFrom:new Date("2020-01-01"),value:{...f.policy,checkout_grace_seconds:0},reason:"Actual policy correction after native history cursor issuance"}));await expect(readGuestHubWorkspace(f.ctx,{...input(),cursor:before.next},deps())).rejects.toBeInstanceOf(GuestHubConflictError);expect((await readGuestHubWorkspace(f.ctx,input(),deps())).items).toHaveLength(25);
 });
 it("derives final revocation from the genuine immutable head while preserving all original admissions",async()=>{
  const link=saved.at(-1)!,review=await reviewGuestHubRevocation(f.ctx,{linkId:link.id},deps());await revokeGuestHubLink(f.ctx,{linkId:link.id,idempotencyKey:randomUUID(),reviewFingerprint:review.reviewFingerprint,reason:"Actual native history final revocation"},deps());const result=await readGuestHubWorkspace(f.ctx,input(),deps());expect(result.items.find(row=>row.id===link.id)).toMatchObject({state:"REVOKED",canRevoke:false,originalCreator:true});expect(await withTenant(db,f.organizationId,tx=>tx.guestHubLink.count())).toBe(26);
 });
 it("keeps immutable history and allowed revocation visible after explicit processing enablement withdrawal",async()=>{
  await withTenant(db,f.organizationId,tx=>new ConfigRuleRepository(tx,f.organizationId).createVersion({key:guestHubLinkPolicyKey,scopeType:"organization",scopeId:null,createdBy:f.account.id,effectiveFrom:new Date("2020-01-01"),value:{...f.policy,enabled:false,processing_approval_reference:null},reason:"Explicit owned processing withdrawal before immutable history read"}));const result=await readGuestHubWorkspace(f.ctx,input(),deps());expect(result.issuanceAvailable).toBe(false);expect(result.items.every(row=>row.state==="REVOKED"||row.state==="BLOCKED")).toBe(true);expect(result.items.filter(row=>row.state==="BLOCKED").every(row=>row.canRevoke)).toBe(true);
 });
});
