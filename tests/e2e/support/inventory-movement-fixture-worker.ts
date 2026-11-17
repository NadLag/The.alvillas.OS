import {mkdir,writeFile} from "node:fs/promises";
import {dirname,resolve,sep} from "node:path";
import {randomUUID} from "node:crypto";
import {PrismaClient} from "@prisma/client";
import {z} from "zod";
import {withTenant} from "@/platform/db/tenant";
import {nativeGuestHubFixture} from "../../integration/support/guest-hub-fixture";
import {previewInventoryMovement,publishInventoryMovement} from "@/modules/inventory/application/movement-service";
const input=z.object({organizationId:z.uuid(),accountId:z.uuid(),personId:z.uuid(),guestLocale:z.enum(["en","fr","ar"]),stock:z.boolean().optional(),reorder:z.boolean().optional(),output:z.string().min(1)}).strict().parse(JSON.parse(process.argv[2]??"null")),target=new URL(process.env.DATABASE_URL??"invalid:");
if(process.env.VERCEL||process.env.VERCEL_ENV||!["127.0.0.1","localhost"].includes(target.hostname)||!(target.pathname.startsWith("/alvillas_automation_")||process.env.GITHUB_ACTIONS==="true"&&target.pathname==="/alvillas_os")||!resolve(input.output).startsWith(resolve(process.cwd())+sep))throw Error("Owned inventory movement browser fixture required");
const db=new PrismaClient();try{
 const f=await nativeGuestHubFixture(db,db,{},input),result=await withTenant(db,f.organizationId,async tx=>{
  const item=await tx.inventoryItem.create({data:{organizationId:f.organizationId,key:"original.browser.stock."+randomUUID(),category:"LINEN",unit:"piece",labels:{en:"Original browser linen "+randomUUID(),fr:"Linge original du navigateur "+randomUUID(),ar:"كتان أصلي للمتصفح "+randomUUID()}}}),source=await tx.inventoryLocation.create({data:{organizationId:f.organizationId,kind:"PROPERTY",propertyId:f.property.id,label:"Actual original source "+randomUUID()}}),destination=await tx.inventoryLocation.create({data:{organizationId:f.organizationId,kind:"STORE",label:"Actual original destination "+randomUUID()}});return{itemId:item.id,itemKey:item.key,itemName:item.labels,sourceId:source.id,sourceLabel:source.label,destinationId:destination.id,destinationLabel:destination.label,reservationId:f.reservation.id,reservationReference:f.reservation.reference,financialCount:await tx.financialTransaction.count({where:{organizationId:f.organizationId}})};
 });
 if(input.stock||input.reorder)for(const change of[{kind:"PURCHASE",quantity:"20"},{kind:"TRANSFER",quantity:"4",destinationLocationId:result.destinationId},{kind:"DAMAGE",quantity:"2"}]){const draft={itemId:result.itemId,locationId:result.sourceId,reason:"Actual original movements for private derived stock acceptance",...change},review=await previewInventoryMovement(f.ctx,draft,{db});await publishInventoryMovement(f.ctx,{draft,reviewFingerprint:review.reviewFingerprint,idempotencyKey:randomUUID()},{db});}
 if(input.reorder){
  const {createConfigRuleVersion}=await import("@/modules/config/application/config-service"),{saveAutomationRule,enqueueAutomationEvent,executeAutomationRun}=await import("@/platform/automation/service"),{consumeInventoryReorderConfiguration}=await import("@/platform/inventory/reorder-configuration");
  const deps={db,requestId:randomUUID(),ipAddress:null},minimum=await createConfigRuleVersion(f.ctx,{key:"inventory.minimums",scopeType:"property",scopeId:f.property.id,lifecycle:"ACTIVE",effectiveFrom:new Date("2020-01-01"),valueJson:JSON.stringify({minimums:[{item:result.itemKey,quantity:15,reorder:{basis:"AVAILABLE",target:20}}]}),reason:"Review effective original-item minimum and target for actual browser acceptance"},deps);
  const automation=await saveAutomationRule(f.ctx,{key:"owned_reorder_"+randomUUID(),propertyId:f.property.id,lifecycle:"ACTIVE",effectiveFrom:new Date("2020-01-01"),reason:"Review original configured reorder automation for the actual property",rule:{name:{en:"Original reorder review",fr:"Réapprovisionnement d’origine",ar:"مراجعة إعادة الطلب الأصلية"},event:"InventoryBelowMinimum",enabled:true,conditions:{all:[]},actions:[{type:"reorder_suggestion",key:"suggest",title:{en:"Review actual original linen replenishment",fr:"Vérifier le réapprovisionnement du linge original",ar:"مراجعة إعادة طلب الكتان الأصلي"}}],retry:{max_attempts:2,delay_seconds:1}}},deps);
  const reference=await withTenant(db,f.organizationId,tx=>tx.outboxEvent.findFirstOrThrow({where:{type:"inventory.reorder.configuration.requested",payload:{path:["configRuleId"],equals:minimum.id}}}));await consumeInventoryReorderConfiguration(f.organizationId,reference.id,deps);
  const signal=await withTenant(db,f.organizationId,tx=>tx.outboxEvent.findFirstOrThrow({where:{type:"InventoryBelowMinimum",payload:{path:["inventorySource","minimumRule","id"],equals:minimum.id}}})),runs=await enqueueAutomationEvent(f.organizationId,signal.id,deps);let executed=false;
  for(const id of runs){const run=await withTenant(db,f.organizationId,tx=>tx.automationRun.findUniqueOrThrow({where:{id}}));if(run.configRuleId===automation.id){if(await executeAutomationRun(f.organizationId,id,deps)!=="SUCCEEDED")throw Error("Actual original reorder browser effect failed");executed=true;}}
  if(!executed)throw Error("Actual original reorder automation was not admitted");
 }
 await mkdir(dirname(resolve(input.output)),{recursive:true,mode:0o700});
 await writeFile(input.output,JSON.stringify(result),{flag:"wx",mode:0o600});
}finally{await db.$disconnect();}
