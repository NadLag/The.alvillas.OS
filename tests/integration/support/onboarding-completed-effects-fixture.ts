import {createServer} from "node:http";
import {randomBytes,randomUUID} from "node:crypto";
import {Webhook} from "svix";
import type {PrismaClient} from "@prisma/client";
import {expect} from "vitest";
import {withTenant} from "@/platform/db/tenant";
import {ResendEmailProvider,type HttpTransport} from "@/platform/providers/real";
import {deliverEmail} from "@/platform/notifications/email-delivery-service";
import {verifyDigestReceipt} from "@/platform/email/digest-receipt";
import {recordDigestReceipt} from "@/platform/notifications/digest-service";
import {executeNextOnboardingActivationEffect} from "@/modules/onboarding/application/onboarding-activation-effect-worker";
import {completeActivationOwnerPackage} from "@/modules/onboarding/application/onboarding-activation-owner-effects";
import type {nativeOnboardingActivationEffectsFixture} from "./onboarding-activation-effects-fixture";
import type {nativeDocumentObjectFixture} from "./document-object-store-fixture";

/** Genuine canonical artifacts, owned HTTP acknowledgement and vendor-signed delivery; no phase row is fabricated. */
export async function completeActualOnboardingEffects(f:Awaited<ReturnType<typeof nativeOnboardingActivationEffectsFixture>>,db:PrismaClient,env:NodeJS.ProcessEnv,storage:Awaited<ReturnType<typeof nativeDocumentObjectFixture>>){
 const dependencies={db,env,objects:storage.objects,requestId:randomUUID()},next=()=>executeNextOnboardingActivationEffect(f.organizationId,f.runId,dependencies);
 expect(await next()).toMatchObject({effectKind:"WORKFLOWS",state:"SUCCEEDED"});expect(await next()).toMatchObject({effectKind:"DOCUMENTS",state:"WAITING"});expect((await completeActivationOwnerPackage(f.organizationId,f.runId,dependencies)).state).toBe("COMPLETE");expect(await next()).toMatchObject({effectKind:"DOCUMENTS",state:"SUCCEEDED"});expect(await next()).toMatchObject({effectKind:"EMAIL",state:"WAITING"});
 const original=await withTenant(db,f.organizationId,tx=>tx.ownerOnboardingDelivery.findFirstOrThrow()),event=await withTenant(db,f.organizationId,tx=>tx.outboxEvent.findUniqueOrThrow({where:{id:original.outboxEventId}})),providerId=randomUUID();let requests=0;
 const server=createServer((request,response)=>{void(async()=>{for await(const chunk of request)void chunk;requests++;response.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify({id:providerId}));})().catch(()=>response.destroy());});await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();if(!address||typeof address==="string")throw Error("Owned provider listener required");
 try{const transport:HttpTransport=(url,init)=>{expect(url).toBe("https://api.resend.com/emails");return fetch("http://127.0.0.1:"+address.port+"/emails",init);};await deliverEmail(event,{...dependencies,provider:new ResendEmailProvider({RESEND_API_KEY:"owned_loopback_only",EMAIL_FROM:"operations@example.test"},transport)});}finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
 expect(requests).toBe(1);expect(await next()).toMatchObject({effectKind:"EMAIL",state:"SUCCEEDED"});expect(await next()).toMatchObject({effectKind:"TASKS",state:"SUCCEEDED"});expect(await next()).toMatchObject({effectKind:"NOTIFICATION",state:"WAITING"});
 const accepted=await withTenant(db,f.organizationId,tx=>tx.notificationDelivery.findFirstOrThrow()),secret="whsec_"+randomBytes(32).toString("base64"),id="msg_"+randomUUID(),now=new Date(),body=JSON.stringify({type:"email.delivered",created_at:now.toISOString(),data:{email_id:accepted.providerId,tags:{template:"onboarding_owner_package",organization_id:f.organizationId,delivery_id:accepted.id}}}),receipt=verifyDigestReceipt(body,new Headers({"svix-id":id,"svix-timestamp":String(Math.floor(now.getTime()/1000)),"svix-signature":new Webhook(secret).sign(id,now,body)}),secret);expect(await recordDigestReceipt(receipt,{db})).toBe(true);expect(await next()).toMatchObject({effectKind:"NOTIFICATION",state:"SUCCEEDED"});expect(await next()).toMatchObject({state:"EFFECTS_COMPLETE"});
}
