import {randomUUID} from "node:crypto";
import {execFileSync} from "node:child_process";
import {PrismaClient} from "@prisma/client";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {withTenant} from "@/platform/db/tenant";
import {serviceOrderFinancialPage} from "@/modules/services/application/service-order-financial";
import {ServiceOrderAccessError} from "@/modules/services/domain/service-order";
import {serviceOrderFinancialPageSchema} from "@/modules/services/domain/service-order-view";
import {changeServiceProviderBinding} from "@/modules/finance/application/service-allocation-provider-binding";
import {reviewServiceAllocation,admitServiceAllocation} from "@/modules/finance/application/service-allocation-admission";
import {recognizeServiceAllocation,reverseServiceAllocation} from "@/modules/finance/application/service-allocation-recognition";
import {recoverServiceAllocationCommand} from "@/modules/finance/application/service-allocation-command-service";
import {readServiceAllocationWorkspace} from "@/modules/finance/application/service-allocation-workspace-service";
import {serviceAllocationCollectionsSchema} from "@/modules/finance/domain/service-allocation-workspace";
import {ServiceAllocationAccessError,ServiceAllocationSourceChangedError} from "@/modules/finance/domain/service-allocation";
import {nativeServiceOrderFinancialFixture} from "./support/service-order-financial-fixture";
import {provisionIntegrationRole} from "./support/database-role";

const url=process.env.TEST_DATABASE_URL;let admin:PrismaClient,db:PrismaClient;
beforeAll(async()=>{const target=url?new URL(url):null;if(!target||!["127.0.0.1","localhost"].includes(target.hostname)||!(target.pathname.startsWith("/alvillas_automation_")||process.env.GITHUB_ACTIONS==="true"&&target.pathname==="/alvillas_os"))throw Error("Dedicated native order financial database required");execFileSync(process.execPath,["node_modules/prisma/build/index.js","migrate","deploy"],{env:{...process.env,DATABASE_URL:url},stdio:"pipe"});admin=new PrismaClient({datasourceUrl:url});await provisionIntegrationRole(admin,"alvillas_ops_tests");const scoped=new URL(url!);scoped.username="alvillas_ops_tests";scoped.password="alvillas_ops_tests";db=new PrismaClient({datasourceUrl:scoped.toString()});});
afterAll(async()=>{await db?.$disconnect();await admin?.$disconnect();});
describe("canonical service order actual native financial effects",()=>{
 it.each(["SUPPLIER","EMPLOYEE"]as const)("recognizes actual %s costs and collected order margin exactly once, with original history and native reversals",async kind=>{
  const f=await nativeServiceOrderFinancialFixture(admin,db,kind),read=()=>serviceOrderFinancialPage(f.ctx,{orderId:f.orderId},f.deps).then(value=>serviceOrderFinancialPageSchema.parse(value)),original=await withTenant(db,f.organizationId,tx=>tx.serviceOrderEvent.findMany({where:{orderId:f.orderId},orderBy:{version:"asc"}}));
  expect((await read()).pageTotals.recognized).toBe(0);expect(serviceAllocationCollectionsSchema.parse(await readServiceAllocationWorkspace(f.ctx,{operation:"COLLECTIONS",propertyId:f.property.id,taskId:randomUUID()},{db})).items).toEqual([]);
  const binding=await changeServiceProviderBinding(f.ctx,{...f.provider.command,...f.input},{db}),input={...f.input,serviceKey:f.entry.key,providers:[{componentKey:"provider",bindingId:binding.bindingId}]};await expect(reviewServiceAllocation(f.ctx,{...input,serviceKey:"unrelated_service"},{db})).rejects.toBeInstanceOf(ServiceAllocationSourceChangedError);
  const review=await reviewServiceAllocation(f.ctx,input,{db}),admission=await admitServiceAllocation(f.ctx,{...input,expectedVersion:review.version,reviewFingerprint:review.reviewFingerprint,idempotencyKey:randomUUID(),reason:"Admit actual canonical order collections and native provider costs"},{db}),command={sourceId:admission.sourceId,admissionId:admission.admissionId,expectedPostingVersion:0,idempotencyKey:randomUUID(),reason:"Recognize actual native canonical order financial effects"},[first,replay]=await Promise.all([recognizeServiceAllocation(f.ctx,command,{db}),recognizeServiceAllocation(f.ctx,command,{db})]);
  expect(replay.postingId).toBe(first.postingId);const page=await read();expect(page.pageTotals).toEqual({recognized:1,gross:"240.00",companyRevenue:"185.25",providerCost:"30.00",ownerAmount:"51.75",taxAmount:"3.00",margin:"155.25"});expect(page.items).toHaveLength(1);expect(page.items[0].postingId).toBe(first.postingId);
  expect((await recoverServiceAllocationCommand(f.ctx,{key:command.idempotencyKey,taskId:f.taskId},{db})).request).toMatchObject({resultId:first.postingId,idempotent:true});await expect(recoverServiceAllocationCommand(f.ctx,{key:command.idempotencyKey,taskId:randomUUID()},{db})).rejects.toBeInstanceOf(ServiceAllocationAccessError);
  const held={...f.ctx,authContext:{...f.ctx.authContext,permissions:new Set<string>(),assignments:[],scopes:[]}};await expect(serviceOrderFinancialPage(held,{orderId:f.orderId},f.deps)).rejects.toBeInstanceOf(ServiceOrderAccessError);await expect(serviceOrderFinancialPage({...f.ctx,organizationId:randomUUID()},{orderId:f.orderId},f.deps)).rejects.toBeInstanceOf(ServiceOrderAccessError);
  await withTenant(db,f.organizationId,async tx=>{expect(await tx.serviceAllocationPosting.count({where:{sourceId:admission.sourceId,kind:"RECOGNITION"}})).toBe(1);expect(await tx.serviceOrderEvent.findMany({where:{orderId:f.orderId},orderBy:{version:"asc"}})).toEqual(original);});await reverseServiceAllocation(f.ctx,{postingId:first.postingId,expectedPostingVersion:1,idempotencyKey:randomUUID(),reason:"Append the actual native order allocation journal opposite"},{db});const reversed=await read();expect(reversed.pageTotals.recognized).toBe(0);expect(reversed.pageTotals.margin).toBe("0.00");expect(reversed.items[0].postingId).toBeNull();await withTenant(db,f.organizationId,async tx=>{expect(await tx.serviceOrderEvent.findMany({where:{orderId:f.orderId},orderBy:{version:"asc"}})).toEqual(original);});
 });
});
