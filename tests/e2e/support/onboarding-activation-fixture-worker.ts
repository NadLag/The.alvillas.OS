import assert from "node:assert/strict";
import {createServer} from "node:http";
import {randomBytes,randomUUID} from "node:crypto";
import {writeFile} from "node:fs/promises";
import {resolve,sep} from "node:path";
import {setTimeout as pause} from "node:timers/promises";
import {PrismaClient} from "@prisma/client";
import {Webhook} from "svix";
import {z} from "zod";
import {withTenant} from "@/platform/db/tenant";
import {OutboxRepository} from "@/platform/events/outbox-repository";
import {OnboardingRepository} from "@/modules/onboarding/infrastructure/onboarding-repository";
import {OnboardingActivationRepository} from "@/modules/onboarding/infrastructure/onboarding-activation-repository";
import {onboardingActivationPolicySchema} from "@/modules/onboarding/domain/onboarding-activation-policy";
import {executeOnboardingActivationJob} from "@/modules/onboarding/application/onboarding-activation-jobs";
import {completeActivationOwnerPackage} from "@/modules/onboarding/application/onboarding-activation-owner-effects";
import {ResendEmailProvider,type HttpTransport} from "@/platform/providers/real";
import {deliverEmail} from "@/platform/notifications/email-delivery-service";
import {verifyDigestReceipt} from "@/platform/email/digest-receipt";
import {recordDigestReceipt} from "@/platform/notifications/digest-service";
import {nativeOnboardingActivationPreparedEffectsFixture} from "../../integration/support/onboarding-activation-effects-fixture";
import {documentFixtureObjects} from "./document-fixture-objects";

const common={organizationId:z.uuid(),accountId:z.uuid(),origin:z.url(),output:z.string().min(1)},input=z.discriminatedUnion("mode",[z.object({...common,mode:z.literal("prepare")}).strict(),z.object({...common,mode:z.literal("complete"),sessionId:z.uuid(),idempotencyKey:z.uuid()}).strict()]).parse(JSON.parse(process.argv[2]??"null")),database=new URL(process.env.DATABASE_URL??"invalid:"),server=new URL(input.origin);
if(process.env.VERCEL||process.env.VERCEL_ENV||!["127.0.0.1","localhost"].includes(database.hostname)||!["127.0.0.1","localhost"].includes(server.hostname)||server.origin!==input.origin||!(database.pathname.startsWith("/alvillas_automation_")||process.env.GITHUB_ACTIONS==="true"&&database.pathname==="/alvillas_os")||!resolve(input.output).startsWith(resolve(process.cwd())+sep))throw Error("Owned native activation browser fixture process required");
const db=new PrismaClient(),dependencies={db,env:process.env,objects:documentFixtureObjects(input.origin,{write:true}),requestId:randomUUID()};
async function acknowledgeEmail(){
 const selected=await withTenant(db,input.organizationId,async tx=>{const original=await tx.ownerOnboardingDelivery.findFirstOrThrow({where:{propertyId:run!.propertyId}}),existing=await tx.notificationDelivery.findFirst({where:{eventId:original.outboxEventId}});return{event:await new OutboxRepository(tx,input.organizationId).event(original.outboxEventId),existing};});assert(selected.event);if(selected.existing?.providerId)return;
 const providerId=randomUUID();let requests=0;const listener=createServer((request,response)=>{void(async()=>{for await(const chunk of request)void chunk;requests++;response.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify({id:providerId}));})().catch(()=>response.destroy());});await new Promise<void>(done=>listener.listen(0,"127.0.0.1",done));const address=listener.address();assert(address&&typeof address!=="string");
 try{const transport:HttpTransport=(url,init)=>{assert.equal(url,"https://api.resend.com/emails");return fetch("http://127.0.0.1:"+address.port+"/emails",init);};await deliverEmail(selected.event,{...dependencies,provider:new ResendEmailProvider({RESEND_API_KEY:"owned_loopback_only",EMAIL_FROM:"operations@example.test"},transport)});}finally{listener.closeAllConnections();await new Promise<void>((done,reject)=>listener.close(error=>error?reject(error):done()));}assert.equal(requests,1);
}
async function confirmSignedDelivery(){const accepted=await withTenant(db,input.organizationId,async tx=>{const delivery=await tx.ownerOnboardingDelivery.findFirstOrThrow({where:{propertyId:run!.propertyId}});return tx.notificationDelivery.findFirstOrThrow({where:{eventId:delivery.outboxEventId}});});if(accepted.status==="DELIVERED")return;assert(accepted.providerId);const secret="whsec_"+randomBytes(32).toString("base64"),id="msg_"+randomUUID(),now=new Date(),body=JSON.stringify({type:"email.delivered",created_at:now.toISOString(),data:{email_id:accepted.providerId,tags:{template:"onboarding_owner_package",organization_id:input.organizationId,delivery_id:accepted.id}}}),receipt=verifyDigestReceipt(body,new Headers({"svix-id":id,"svix-timestamp":String(Math.floor(now.getTime()/1000)),"svix-signature":new Webhook(secret).sign(id,now,body)}),secret);assert.equal(await recordDigestReceipt(receipt,{db}),true);}
let run:Awaited<ReturnType<OnboardingActivationRepository["byNonce"]>>;
try{
 const migrations=await db.$queryRaw<Array<{count:number}>>`SELECT count(*)::int AS count FROM _prisma_migrations WHERE migration_name='20261113093000_native_onboarding_activation_job_continuations' AND finished_at IS NOT NULL AND rolled_back_at IS NULL`;assert.equal(migrations[0].count,1);
 if(input.mode==="prepare"){
  const f=await nativeOnboardingActivationPreparedEffectsFixture(db,db,process.env,{objects:dependencies.objects},{organizationId:input.organizationId,accountId:input.accountId,canonicalAgreementStatus:"ACTIVE",canonicalPropertyInput:{name:"Actual private queued activation villa "+randomUUID(),addressLine1:"Original approved activation address",city:"Marrakech",propertyType:"VILLA",bedrooms:3,bathrooms:2,maxGuests:6,photoUrls:["https://property-images.example.test/native-activation-villa.jpg"],onboardingProfile:{headline:"Actual approved queued activation villa",houseRules:[]}}},{max_attempts:3,backoff_seconds:1});
  await writeFile(input.output,JSON.stringify({organizationId:f.organizationId,accountId:f.account.id,sessionId:f.review.sessionId,reviewRevisionId:f.review.id,propertyId:f.review.propertyId,propertyName:f.original.validation.facts.property!.name}),{flag:"wx"});
 }else{
  run=await withTenant(db,input.organizationId,tx=>new OnboardingActivationRepository(tx,input.organizationId).byNonce(input.idempotencyKey));assert(run&&run.sessionId===input.sessionId&&run.createdBy===input.accountId);const policy=onboardingActivationPolicySchema.parse((run.policySnapshot as {value:{activation:unknown}}).value.activation),root=await withTenant(db,input.organizationId,tx=>new OutboxRepository(tx,input.organizationId).byIdempotencyKey("onboarding.activation:"+run!.id));assert(root);let sourceId=root.id,complete=false;
  for(let step=0;step<policy.effects.length*(policy.retry.max_attempts*2+2)+3;step++){
   const phases=await withTenant(db,input.organizationId,tx=>new OnboardingActivationRepository(tx,input.organizationId).phaseHeads(run!.id));
   if(phases.some(row=>row.type==="STARTED"&&row.effectKind==="DOCUMENTS"))assert.equal((await completeActivationOwnerPackage(input.organizationId,run.id,dependencies)).state,"COMPLETE");
   if(phases.some(row=>row.type==="STARTED"&&row.effectKind==="EMAIL"))await acknowledgeEmail();if(phases.some(row=>row.type==="STARTED"&&row.effectKind==="NOTIFICATION"))await confirmSignedDelivery();
   const wait=await withTenant(db,input.organizationId,async tx=>{const source=await new OutboxRepository(tx,input.organizationId).event(sourceId);assert(source);return source.nextAttemptAt?Math.max(0,source.nextAttemptAt.getTime()-(await new OnboardingRepository(tx,input.organizationId).clock()).getTime()):0;});if(wait)await pause(wait+25);
   const outcome=await executeOnboardingActivationJob({organizationId:input.organizationId,outboxEventId:sourceId},dependencies);if(outcome.state==="COMPLETE"||outcome.state==="ACTIVATED"){complete=true;break;}assert(!["FAILED","BLOCKED","SUPERSEDED"].includes(outcome.state));if(outcome.state==="SCHEDULED"){assert("outboxEventId"in outcome&&typeof outcome.outboxEventId==="string");sourceId=outcome.outboxEventId;}else assert.equal(outcome.state,"WAITING");
  }
  assert(complete);const result=await withTenant(db,input.organizationId,async tx=>({propertyStatus:(await tx.property.findUniqueOrThrow({where:{id:run!.propertyId}})).status,phaseCount:await tx.propertyOnboardingActivationEvent.count({where:{activationId:run!.id}}),completedEffects:await tx.propertyOnboardingActivationEvent.count({where:{activationId:run!.id,type:"SUCCEEDED"}}),tasks:await tx.operationTask.count({where:{propertyId:run!.propertyId}}),documents:await tx.ownerOnboardingPackageItem.count({where:{package:{propertyId:run!.propertyId}}})}));
  assert.equal(result.propertyStatus,"ACTIVE");assert.equal(result.phaseCount,13);assert.equal(result.completedEffects,5);assert.equal(result.tasks,2);assert.equal(result.documents,2);const delivery=await withTenant(db,input.organizationId,tx=>tx.ownerOnboardingDelivery.findFirstOrThrow({where:{propertyId:run!.propertyId}}));assert.equal(await withTenant(db,input.organizationId,tx=>tx.notificationDelivery.count({where:{eventId:delivery.outboxEventId,status:"DELIVERED"}})),1);await writeFile(input.output,JSON.stringify({...result,delivered:1}),{flag:"wx"});
 }
}finally{await db.$disconnect();}
