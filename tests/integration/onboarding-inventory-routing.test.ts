import {randomBytes,randomUUID} from "node:crypto";
import {PrismaClient} from "@prisma/client";
import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from "vitest";
import {withTenant} from "@/platform/db/tenant";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {readOnboardingOptions,reviewOnboardingRecordStep,admitOnboardingRecordStep,readOnboardingRecord,recoverOnboardingStep} from "@/modules/onboarding/application/onboarding-service";
import {canonicalOnboardingRecordCommand,onboardingRecordReviewSchema,onboardingRecordSchema} from "@/modules/onboarding/domain/onboarding-record";
import {onboardingInventoryReadSchema,type OnboardingInventoryDraft} from "@/modules/onboarding/domain/onboarding-inventory";
import {onboardingPolicyKey} from "@/modules/onboarding/domain/onboarding-policy";
import {OnboardingAccessError,OnboardingConfigurationError,OnboardingConflictError} from "@/modules/onboarding/domain/onboarding-wizard";
import * as channelPayload from "@/modules/onboarding/domain/onboarding-booking-channels-payload";
import * as teamPayload from "@/modules/onboarding/domain/onboarding-team-payload";
import {nativeOnboardingInventoryFixture,nativeInventoryTemplate} from "./support/onboarding-inventory-fixture";
import {nativeLeadFinancialGuard} from "./support/lead-fixture";
import {provisionIntegrationRole} from "./support/database-role";

let admin:PrismaClient,db:PrismaClient,financial:Awaited<ReturnType<typeof nativeLeadFinancialGuard>>;
const organizations:string[]=[],env:NodeJS.ProcessEnv={NODE_ENV:"test",ENCRYPTION_KEYS:"native-inventory-routing:"+randomBytes(32).toString("base64")};
beforeAll(async()=>{const value=process.env.TEST_DATABASE_URL,url=value?new URL(value):null;if(!url||!["localhost","127.0.0.1"].includes(url.hostname)||!(url.pathname.startsWith("/alvillas_automation_crm_proposal_onboarding")||process.env.GITHUB_ACTIONS==="true"&&url.pathname==="/alvillas_os"))throw Error("Owned migrated228 Inventory routing database required");admin=new PrismaClient({datasourceUrl:value});await provisionIntegrationRole(admin,"alvillas_ops_tests");url.username=url.password="alvillas_ops_tests";db=new PrismaClient({datasourceUrl:url.toString()});financial=await nativeLeadFinancialGuard(admin,db);});
afterEach(()=>vi.restoreAllMocks());afterAll(async()=>{try{if(financial)await financial.assertPreserved(organizations);}finally{await db?.$disconnect();await admin?.$disconnect();}});
async function fixture(){const f=await nativeOnboardingInventoryFixture(admin,db,env);organizations.push(f.organizationId);return f;}
type Fixture=Awaited<ReturnType<typeof fixture>>;
const draft=(f:Fixture):OnboardingInventoryDraft=>({sessionId:f.book.sessionId,previousRevisionId:f.book.id,step:"INVENTORY",target:f.inventoryTarget});
const withdraw=(f:Fixture,key:string)=>withTenant(db,f.organizationId,tx=>tx.roleAssignment.update({where:{id:f.grants[key]},data:{archivedAt:new Date()}}));
async function command(f:Fixture,input=draft(f)){const review=onboardingRecordReviewSchema.parse(await reviewOnboardingRecordStep(f.ctx,input,f.deps));return canonicalOnboardingRecordCommand({...input,idempotencyKey:randomUUID(),reviewFingerprint:review.reviewFingerprint,reason:"Actual reviewed shared Inventory admission"});}

describe("shared native Inventory producer after actual228 admission guards",()=>{
 it.each(["TEMPLATE","CUSTOM"]as const)("records actual %s through the shared dispatcher and recovers its original operational history",async mode=>{
  const f=await fixture(),template=mode==="TEMPLATE"?await nativeInventoryTemplate(f,db):null,input:OnboardingInventoryDraft=template?{...draft(f),target:{mode:"TEMPLATE",propertyId:f.book.propertyId!,templateVersionId:template.id,expectedRevision:0}}:draft(f);
  for(const key of["financial_transaction:export","team_member:view","role:view","identity:view"])await withdraw(f,key);
  const channels=vi.spyOn(channelPayload,"decryptOnboardingBookingChannelsPayload"),team=vi.spyOn(teamPayload,"decryptOnboardingTeamPayload");
  expect((await readOnboardingOptions(f.ctx,{sessionId:f.book.sessionId},f.deps)).inventory).toMatchObject({revisionId:f.book.id,propertyId:f.book.propertyId,modes:["TEMPLATE","CUSTOM"],minimumItems:1});
  const reviewed=await command(f,input),receipt=await admitOnboardingRecordStep(f.ctx,reviewed,f.deps),read=()=>readOnboardingRecord(f.ctx,{sessionId:f.book.sessionId},f.deps),original=onboardingInventoryReadSchema.parse(onboardingRecordSchema.parse(await read()));
  expect(original).toMatchObject({selected:{id:receipt.id,step:"INVENTORY"},draft:input,reason:reviewed.reason,nextStep:"SERVICES",inventory:{settings:{minimums:[{item:"bath_towel",quantity:2,unit:"piece",category:"LINEN",expected_per_stay:null}]}}});
  expect(await recoverOnboardingStep(f.ctx,{sessionId:f.book.sessionId,idempotencyKey:reviewed.idempotencyKey},f.deps)).toMatchObject({recorded:true,revision:{id:receipt.id,replayed:true}});
  expect(channels).not.toHaveBeenCalled();expect(team).not.toHaveBeenCalled();
  await expect(readOnboardingRecord(f.ctx,{sessionId:f.book.sessionId,revisionId:f.book.id},f.deps)).rejects.toBeInstanceOf(OnboardingAccessError);
  await withTenant(db,f.organizationId,tx=>new ConfigRuleRepository(tx,f.organizationId).createVersion({key:"inventory.minimums",scopeType:"property",scopeId:f.book.propertyId!,createdBy:f.account.id,effectiveFrom:new Date("2020-01-01"),value:{minimums:[{item:"later_towel",quantity:77}]},reason:"Later actual configuration cannot replace the original Inventory capture"}));
  expect(onboardingInventoryReadSchema.parse(await read()).inventory).toEqual(original.inventory);
  for(const key of["property:edit","onboarding:edit"])await withdraw(f,key);
  expect(await recoverOnboardingStep(f.ctx,{sessionId:f.book.sessionId,idempotencyKey:reviewed.idempotencyKey},f.deps)).toMatchObject({recorded:true,revision:{id:receipt.id,replayed:true}});
  expect(await withTenant(db,f.organizationId,async tx=>({native:await tx.propertyOnboardingRevision.count({where:{step:"INVENTORY"}}),events:await tx.outboxEvent.count({where:{type:"onboarding.step_recorded",payload:{path:["revisionId"],equals:receipt.id}}}),audits:await tx.auditLog.count({where:{action:"onboarding.step_recorded",after:{path:["revisionId"],equals:receipt.id}}}),stock:await tx.inventoryMovement.count()}))).toEqual({native:1,events:1,audits:1,stock:0});
 });
 it("requires an explicitly approved Inventory policy before shared review",async()=>{const f=await fixture(),old={...f.policy};delete old.inventory;await withTenant(db,f.organizationId,tx=>new ConfigRuleRepository(tx,f.organizationId).createVersion({key:onboardingPolicyKey,scopeType:"organization",createdBy:f.account.id,effectiveFrom:new Date("2020-01-01"),value:old,reason:"Actual earlier policy without an approved Inventory producer"}));expect((await readOnboardingOptions(f.ctx,{sessionId:f.book.sessionId},f.deps)).inventory).toBeUndefined();await expect(reviewOnboardingRecordStep(f.ctx,draft(f),f.deps)).rejects.toBeInstanceOf(OnboardingConfigurationError);});
 it.each(["onboarding:export","property:view","owner:view"])("withholds shared Inventory options after current %s withdrawal",async key=>{const f=await fixture();await withdraw(f,key);expect((await readOnboardingOptions(f.ctx,{sessionId:f.book.sessionId},f.deps)).inventory).toBeUndefined();await expect(reviewOnboardingRecordStep(f.ctx,draft(f),f.deps)).rejects.toBeInstanceOf(OnboardingAccessError);});
 it("rejects an actual predecessor nonce reused for Inventory without modifying its original source",async()=>{const f=await fixture(),reviewed=await command(f),original=await withTenant(db,f.organizationId,tx=>tx.propertyOnboardingRevision.findUniqueOrThrow({where:{id:f.book.id}}));await expect(admitOnboardingRecordStep(f.ctx,{...reviewed,idempotencyKey:original.commandKey},f.deps)).rejects.toBeInstanceOf(OnboardingConflictError);expect(await withTenant(db,f.organizationId,tx=>tx.propertyOnboardingRevision.findUniqueOrThrow({where:{id:f.book.id}}))).toEqual(original);expect(await withTenant(db,f.organizationId,tx=>tx.propertyOnboardingRevision.count({where:{step:"INVENTORY"}}))).toBe(0);});
 it("keeps the Services, Workflows, whole-review and activation producers closed",async()=>{const f=await fixture(),reviewed=await command(f);for(const step of["SERVICES","WORKFLOWS","REVIEW","ACTIVATE"])expect(()=>canonicalOnboardingRecordCommand({...reviewed,step})).toThrow();expect(await withTenant(db,f.organizationId,tx=>tx.propertyOnboardingRevision.count())).toBe(6);});
});
