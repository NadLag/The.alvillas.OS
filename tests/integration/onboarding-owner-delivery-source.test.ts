import {createServer} from "node:http";
import {createHash,randomBytes,randomUUID} from "node:crypto";
import {PrismaClient} from "@prisma/client";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {withTenant} from "@/platform/db/tenant";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {ResendEmailProvider,type HttpTransport} from "@/platform/providers/real";
import {readOwnerDeliveryDocumentPlan} from "@/platform/documents/owner-delivery-documents";
import {downloadDocumentVersion} from "@/modules/documents/application/document-archive";
import {reviewOnboardingOwnerPackage,admitOnboardingOwnerPackage,completeOnboardingOwnerPackage} from "@/modules/onboarding/application/onboarding-owner-package-service";
import {prepareOnboardingOwnerDelivery} from "@/modules/onboarding/application/onboarding-owner-delivery-preparation";
import {onboardingOwnerDeliveryPolicyKey} from "@/modules/onboarding/domain/onboarding-owner-delivery-policy";
import {OnboardingAccessError,OnboardingConfigurationError} from "@/modules/onboarding/domain/onboarding-wizard";
import {nativeOnboardingOwnerPackageFixture} from "./support/onboarding-owner-package-fixture";
import {nativeDocumentObjectFixture} from "./support/document-object-store-fixture";
import {nativeLeadFinancialGuard} from "./support/lead-fixture";
import {provisionIntegrationRole} from "./support/database-role";

let admin:PrismaClient,db:PrismaClient,financial:Awaited<ReturnType<typeof nativeLeadFinancialGuard>>,storage:Awaited<ReturnType<typeof nativeDocumentObjectFixture>>;
const organizations:string[]=[],env:NodeJS.ProcessEnv={NODE_ENV:"test",ENCRYPTION_KEYS:"native-owner-email:"+randomBytes(32).toString("base64")};
beforeAll(async()=>{const value=process.env.TEST_DATABASE_URL,url=value?new URL(value):null;if(!url||!["localhost","127.0.0.1"].includes(url.hostname)||!(url.pathname==="/alvillas_automation_onb239_email_transport_20261112"||process.env.GITHUB_ACTIONS==="true"&&url.pathname==="/alvillas_os"))throw Error("Owned migrated239 native email transport database required");admin=new PrismaClient({datasourceUrl:value});expect((await admin.$queryRaw<Array<{count:number}>>`SELECT count(*)::int AS count FROM _prisma_migrations WHERE migration_name='20261112110000_atomic_owner_package_documents' AND finished_at IS NOT NULL AND rolled_back_at IS NULL`)[0].count).toBe(1);await provisionIntegrationRole(admin,"alvillas_ops_tests");url.username=url.password="alvillas_ops_tests";db=new PrismaClient({datasourceUrl:url.toString()});financial=await nativeLeadFinancialGuard(admin,db);storage=await nativeDocumentObjectFixture(env);});
afterAll(async()=>{try{if(financial)await financial.assertPreserved(organizations);}finally{await storage?.close();await db?.$disconnect();await admin?.$disconnect();}});
async function fixture(configured=true){
 const f=await nativeOnboardingOwnerPackageFixture(admin,db,env,storage);organizations.push(f.organizationId);
 const draft={sessionId:f.review.sessionId,reviewRevisionId:f.review.id},review=await reviewOnboardingOwnerPackage(f.ctx,draft,f.deps),pending=await admitOnboardingOwnerPackage(f.ctx,{...draft,idempotencyKey:randomUUID(),reviewFingerprint:review.reviewFingerprint,reason:"Create the actual complete bilingual original before email preparation"},f.deps),complete=await completeOnboardingOwnerPackage(f.ctx,{packageId:pending.packageId},{...f.deps,objects:storage.objects});expect(complete.state).toBe("COMPLETE");
 if(configured)await withTenant(db,f.organizationId,tx=>new ConfigRuleRepository(tx,f.organizationId).createVersion({key:onboardingOwnerDeliveryPolicyKey,scopeType:"property",scopeId:f.review.propertyId!,createdBy:f.account.id,effectiveFrom:new Date("2020-01-01"),value:{source:"NATIVE_COMPLETED_OWNER_PACKAGE",channel:"EMAIL",template:"NATIVE_OWNER_PACKAGE_EMAIL_V1",locales:["en","fr"]},reason:"Explicit actual bilingual owner email policy for completed native originals"}));
 return{...f,complete};
}

describe("genuine owner delivery preparation and original PDF transport",()=>{
 it("prepares both configured emails and transports the exact two actual archived PDF byte sequences on owned loopback",async()=>{
  const f=await fixture(),prepared=await prepareOnboardingOwnerDelivery(f.ctx,{packageId:f.complete.packageId},f.deps);
  expect(prepared.emails.variants.map(row=>row.locale)).toEqual(["en","fr"]);expect(prepared.emails.selected.locale).toBe(f.original.validation.facts.owner!.preferredLocale);expect(prepared.emails.selected.to).toBe(f.original.validation.facts.owner!.email);
  expect(prepared.source.reviewRevisionId).toBe(f.review.id);expect(prepared.source.documents.map(row=>row.versionId)).toEqual(f.complete.documents.map(row=>row.versionId));
  const plan=await withTenant(db,f.organizationId,tx=>readOwnerDeliveryDocumentPlan(f.ctx,tx,prepared.package,env));expect(plan.map(row=>row.versionId)).toEqual(f.complete.documents.map(row=>row.versionId));
  for(const mail of prepared.emails.variants)expect(mail.subject).toContain(f.original.validation.facts.property!.name);
  const attachments=[];for(const document of f.complete.documents){const file=await downloadDocumentVersion(f.ctx,{versionId:document.versionId},{...f.deps,objects:storage.objects});expect(Buffer.from(file.bytes).subarray(0,5).toString()).toBe("%PDF-");expect(plan.find(row=>row.versionId===document.versionId)).toMatchObject({sha256:createHash("sha256").update(file.bytes).digest("hex"),byteSize:file.bytes.length,contentType:"application/pdf"});attachments.push({filename:"owner-package-"+document.locale+".pdf",content:Buffer.from(file.bytes).toString("base64"),contentType:"application/pdf"as const});}
  const requests:Array<{to:string[];subject:string;attachments:Array<{filename:string;content:string}>}>=[],server=createServer((request,response)=>{void(async()=>{expect(request.method).toBe("POST");expect(request.url).toBe("/emails");const chunks:Buffer[]=[];for await(const chunk of request as AsyncIterable<Uint8Array>)chunks.push(Buffer.from(chunk));requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8"))as typeof requests[number]);response.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify({id:"actual-owned-loopback-email-acceptance"}));})().catch(()=>response.destroy());});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();if(!address||typeof address==="string")throw Error("Owned loopback address required");
  try{
   const transport:HttpTransport=async(url,init)=>{expect(url).toBe("https://api.resend.com/emails");return fetch("http://127.0.0.1:"+address.port+"/emails",init);},provider=new ResendEmailProvider({RESEND_API_KEY:"owned_loopback_transport_only",EMAIL_FROM:"operations@example.test"},transport);
   expect(await provider.send({...prepared.emails.selected,attachments,idempotencyKey:"native-package-transport:"+f.complete.packageId})).toEqual({id:"actual-owned-loopback-email-acceptance"});expect(requests).toHaveLength(1);expect(requests[0].to).toEqual([prepared.source.ownerEmail]);expect(requests[0].subject).toBe(prepared.emails.selected.subject);
   expect(requests[0].attachments.map(row=>({filename:row.filename,sha256:createHash("sha256").update(Buffer.from(row.content,"base64")).digest("hex")}))).toEqual(attachments.map(row=>({filename:row.filename,sha256:createHash("sha256").update(Buffer.from(row.content,"base64")).digest("hex")})));
  }finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
  await withTenant(db,f.organizationId,async tx=>{expect(await tx.notificationDelivery.count()).toBe(0);expect(await tx.operationTask.count()).toBe(0);expect((await tx.property.findUniqueOrThrow({where:{id:f.review.propertyId!}})).status).toBe("DRAFT");});
 },120000);
 it("requires an explicit selected delivery policy instead of inferring emails from a completed package",async()=>{const f=await fixture(false);await expect(prepareOnboardingOwnerDelivery(f.ctx,{packageId:f.complete.packageId},f.deps)).rejects.toBeInstanceOf(OnboardingConfigurationError);},120000);
 it("denies each independent financial and Team withdrawal before exposing prepared messages",async()=>{
  const f=await fixture();for(const key of["financial_transaction:export","company_ledger:export","expense:export","owner_statement:export","team_member:view"]){
   await withTenant(db,f.organizationId,tx=>tx.roleAssignment.update({where:{id:f.grants[key]},data:{archivedAt:new Date()}}));
   await expect(prepareOnboardingOwnerDelivery(f.ctx,{packageId:f.complete.packageId},f.deps)).rejects.toBeInstanceOf(OnboardingAccessError);
   await withTenant(db,f.organizationId,tx=>tx.roleAssignment.update({where:{id:f.grants[key]},data:{archivedAt:null}}));
  }
 },120000);
});
