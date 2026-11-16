import {randomUUID} from "node:crypto";
import {execFileSync} from "node:child_process";
import {PrismaClient} from "@prisma/client";
import {afterAll,beforeAll,describe,expect,it,vi} from "vitest";
import {withTenant,type TenantTransaction} from "@/platform/db/tenant";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {previewServiceCatalogChange,publishServiceCatalogChange} from "@/modules/services/application/service-catalog-service";
import {previewServiceOrder,createServiceOrder,recoverServiceOrderCommand,readServiceOrderMetadata,serviceOrderChanged} from "@/modules/services/application/service-order-service";
import {ServiceOrderAccessError,ServiceOrderConflictError} from "@/modules/services/domain/service-order";
import {ServiceCatalogAccessError} from "@/modules/services/domain/service-catalog";
import {nativeServiceOrderFixture} from "./support/service-order-fixture";
import {nativeGuestHubSecondActor} from "./support/guest-hub-fixture";
import {provisionIntegrationRole} from "./support/database-role";
import * as auditWriter from "@/platform/audit/audit-writer";
import {serviceOrderPage,readServiceOrderOriginal,serviceOrderHistory,serviceOrderHistoryOriginal,serviceOrderReservationChoices,serviceOrderCatalogChoices,serviceOrderTaskChoices} from "@/modules/services/application/service-order-workspace";
import {serviceOrderPageResponseSchema,serviceOrderOriginalResponseSchema,serviceOrderHistoryResponseSchema,serviceOrderHistoryOriginalSchema,serviceOrderReservationsResponseSchema,serviceOrderCatalogResponseSchema,serviceOrderTaskChoicesResponseSchema} from "@/modules/services/domain/service-order-view";

const url=process.env.TEST_DATABASE_URL;let admin:PrismaClient,db:PrismaClient;
beforeAll(async()=>{
 const target=url?new URL(url):null;if(!target||!["127.0.0.1","localhost"].includes(target.hostname)||!(target.pathname.startsWith("/alvillas_automation_")||process.env.GITHUB_ACTIONS==="true"&&target.pathname==="/alvillas_os"))throw Error("Dedicated native service order acceptance database required");
 execFileSync(process.execPath,["node_modules/prisma/build/index.js","migrate","deploy"],{env:{...process.env,DATABASE_URL:url},stdio:"pipe"});admin=new PrismaClient({datasourceUrl:url});await provisionIntegrationRole(admin,"alvillas_ops_tests");const scoped=new URL(url!);scoped.username="alvillas_ops_tests";scoped.password="alvillas_ops_tests";db=new PrismaClient({datasourceUrl:scoped.toString()});
});
afterAll(async()=>{await db?.$disconnect();await admin?.$disconnect();});

const fixture=()=>nativeServiceOrderFixture(admin,db);
type Fixture=Awaited<ReturnType<typeof fixture>>;
const command=async(f:Fixture)=>({request:f.request,reviewFingerprint:(await previewServiceOrder(f.ctx,f.request,f.deps)).reviewFingerprint,idempotencyKey:randomUUID()});
const financial=(f:Fixture)=>withTenant(db,f.organizationId,tx=>tx.$queryRaw`SELECT 'transaction' AS kind,id::text,xmin::text,ctid::text,to_jsonb(t) AS body FROM financial_transaction t WHERE organization_id=${f.organizationId}::uuid UNION ALL SELECT 'posting',id::text,xmin::text,ctid::text,to_jsonb(p) FROM posting p WHERE organization_id=${f.organizationId}::uuid ORDER BY kind,id`);

describe("native reviewed service order persistence",()=>{
 it("projects real property workspace choices, original terms and append-only history through strict private DTOs",async()=>{
  const f=await fixture(),before=await financial(f),created=await createServiceOrder(f.ctx,await command(f),f.deps),page=serviceOrderPageResponseSchema.parse(await serviceOrderPage(f.ctx,{propertyId:f.property.id},f.deps));expect(page.items).toHaveLength(1);expect(page.items[0].id).toBe(created.orderId);expect(JSON.stringify(page)).not.toContain("240.00");
  const reservations=serviceOrderReservationsResponseSchema.parse(await serviceOrderReservationChoices(f.ctx,{propertyId:f.property.id},f.deps));expect(reservations.items.find(row=>row.id===f.reservation.id)).toMatchObject({guestCapacity:f.reservation.adultCount+f.reservation.childCount});
  const catalog=serviceOrderCatalogResponseSchema.parse(await serviceOrderCatalogChoices(f.ctx,{propertyId:f.property.id,reservationId:f.reservation.id},f.deps));expect(catalog.items.find(row=>row.key===f.entry.key)).toMatchObject({amount:"120.00",orderTerms:{internal_cost:{amount:"30.00"}}});expect(catalog.policy).toEqual({maxQuantity:10,maxServiceDays:10});
  const original=serviceOrderOriginalResponseSchema.parse(await readServiceOrderOriginal(f.ctx,{orderId:created.orderId},f.deps));expect(original).toMatchObject({totalAmount:"240.00",request:f.request,catalog:{key:f.entry.key}});
  const history=serviceOrderHistoryResponseSchema.parse(await serviceOrderHistory(f.ctx,{orderId:created.orderId},f.deps));expect(history.items).toHaveLength(1);expect(JSON.stringify(history)).not.toContain(f.request.reason);expect(serviceOrderHistoryOriginalSchema.parse(await serviceOrderHistoryOriginal(f.ctx,{orderId:created.orderId,eventId:history.items[0].id},f.deps))).toMatchObject({reason:f.request.reason,snapshot:{totalAmount:"240.00"}});
  expect(serviceOrderTaskChoicesResponseSchema.parse(await serviceOrderTaskChoices(f.ctx,{orderId:created.orderId},f.deps))).toMatchObject({ruleVersion:1,checklists:[{key:"owned_service"}]});expect(await financial(f)).toEqual(before);
 });
 it("retains permitted metadata and nonce-only recovery after financial revocation while denying original values before private reads",async()=>{
  const f=await fixture(),input=await command(f),created=await createServiceOrder(f.ctx,input,f.deps);await withTenant(db,f.organizationId,tx=>tx.roleAssignment.update({where:{id:f.grants["financial_transaction:view"]},data:{archivedAt:new Date()}}));
  expect(await recoverServiceOrderCommand(f.ctx,{propertyId:f.property.id,idempotencyKey:input.idempotencyKey},f.deps)).toMatchObject({recorded:true,receipt:{orderId:created.orderId}});expect((await serviceOrderPage(f.ctx,{propertyId:f.property.id},f.deps)).items).toHaveLength(1);expect((await serviceOrderHistory(f.ctx,{orderId:created.orderId},f.deps)).items).toHaveLength(1);
  const spy=vi.spyOn(ConfigRuleRepository.prototype,"sourceWitness");try{await expect(readServiceOrderOriginal(f.ctx,{orderId:created.orderId},f.deps)).rejects.toBeInstanceOf(ServiceOrderAccessError);await expect(serviceOrderCatalogChoices(f.ctx,{propertyId:f.property.id,reservationId:f.reservation.id},f.deps)).rejects.toBeInstanceOf(ServiceCatalogAccessError);expect(spy).not.toHaveBeenCalled();}finally{spy.mockRestore();}
  const other=await fixture();await expect(serviceOrderPage(other.ctx,{propertyId:f.property.id},other.deps)).rejects.toBeInstanceOf(ServiceOrderAccessError);await expect(serviceOrderReservationChoices(other.ctx,{propertyId:f.property.id},other.deps)).rejects.toBeInstanceOf(ServiceOrderAccessError);
 });
 it("commits one exact reviewed request, event, audit and receipt under concurrent retries without financial effects",async()=>{
  const f=await fixture(),before=await financial(f),input=await command(f),review=await previewServiceOrder(f.ctx,f.request,f.deps);expect(review).toMatchObject({totalAmount:"240.00",currency:"MAD",quoteRequired:false});
  const results=await Promise.all([createServiceOrder(f.ctx,input,f.deps),createServiceOrder(f.ctx,input,f.deps)]);expect(results.map(r=>r.replayed).sort()).toEqual([false,true]);expect(results[0].orderId).toBe(results[1].orderId);
  await withTenant(db,f.organizationId,async tx=>{
   const rows=await tx.serviceOrder.findMany();expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({state:"REQUESTED",version:1,taskId:null,quantity:2n,guestCount:1});expect(rows[0].totalAmount!.toFixed(2)).toBe("240.00");expect(JSON.stringify(rows[0].catalogSnapshot)).not.toContain("owned_extension");expect(rows[0].catalogSnapshot).toMatchObject({order_terms:{availability:{value:null}}});
   expect(await tx.serviceOrderEvent.count()).toBe(1);expect(await tx.auditLog.count({where:{action:serviceOrderChanged}})).toBe(1);expect(await tx.outboxEvent.count({where:{type:serviceOrderChanged}})).toBe(1);
  });
  expect(await financial(f)).toEqual(before);const metadata=await readServiceOrderMetadata(f.ctx,results[0].orderId,f.deps);expect(metadata).toMatchObject({serviceKey:f.entry.key,quantity:2,version:1,state:"REQUESTED"});expect(JSON.stringify(metadata)).not.toMatch(/240\.00|30\.00|approval_reference|private service order reason/u);
 });
 it("rejects a stale reviewed native catalog instead of silently accepting a new price",async()=>{
  const f=await fixture(),input=await command(f),draft={...f.draft,entry:{...f.entry,amount:"140.00"}},review=await previewServiceCatalogChange(f.ctx,draft,f.deps);await publishServiceCatalogChange(f.ctx,{draft,reviewFingerprint:review.reviewFingerprint,idempotencyKey:randomUUID()},f.deps);
  await expect(createServiceOrder(f.ctx,input,f.deps)).rejects.toBeInstanceOf(ServiceOrderConflictError);await withTenant(db,f.organizationId,async tx=>expect(await tx.serviceOrder.count()).toBe(0));
 });
 it("checks both held and current operational and financial sources before private configuration reads",async()=>{
  const f=await fixture(),input=await command(f);await withTenant(db,f.organizationId,tx=>tx.roleAssignment.update({where:{id:f.grants["financial_transaction:view"]},data:{archivedAt:new Date()}}));const spy=vi.spyOn(ConfigRuleRepository.prototype,"sourceWitness");
  try{await expect(createServiceOrder(f.ctx,input,f.deps)).rejects.toBeInstanceOf(ServiceCatalogAccessError);expect(spy).not.toHaveBeenCalled();}finally{spy.mockRestore();}
  const second=await fixture(),held={...second.ctx,authContext:{...second.ctx.authContext,permissions:new Set<string>(),assignments:[],scopes:[]}};await expect(previewServiceOrder(held,second.request,second.deps)).rejects.toBeInstanceOf(ServiceOrderAccessError);
  const bounded=await fixture();await withTenant(db,bounded.organizationId,tx=>tx.roleAssignment.update({where:{id:bounded.grants["service_order:create"]},data:{conditions:{maxAmount:"300.00"}}}));
  const accepted=await command(bounded);expect(await createServiceOrder(bounded.ctx,accepted,bounded.deps)).toMatchObject({state:"REQUESTED",replayed:false});
  await withTenant(db,bounded.organizationId,tx=>tx.roleAssignment.update({where:{id:bounded.grants["service_order:create"]},data:{conditions:{maxAmount:"100.00"}}}));await expect(createServiceOrder(bounded.ctx,{...accepted,idempotencyKey:randomUUID()},bounded.deps)).rejects.toBeInstanceOf(ServiceOrderAccessError);
 });
 it("denies cross-property reservation substitution and keeps real tenant rows hidden by RLS",async()=>{
  const f=await fixture(),other=await fixture(),input=await command(f),created=await createServiceOrder(f.ctx,input,f.deps);
  await expect(previewServiceOrder(f.ctx,{...f.request,reservationId:other.reservation.id},f.deps)).rejects.toBeInstanceOf(ServiceOrderAccessError);
  await expect(readServiceOrderMetadata(other.ctx,created.orderId,other.deps)).rejects.toBeInstanceOf(ServiceOrderAccessError);await withTenant(db,other.organizationId,async tx=>{expect(await tx.serviceOrder.findUnique({where:{id:created.orderId}})).toBeNull();expect(await tx.serviceOrderEvent.count({where:{orderId:created.orderId}})).toBe(0);});
 });
 it("recovers only the creator's original operational receipt after financial access is revoked",async()=>{
  const f=await fixture(),input=await command(f),created=await createServiceOrder(f.ctx,input,f.deps),other=await nativeGuestHubSecondActor(db,f);
  await withTenant(db,f.organizationId,tx=>tx.roleAssignment.update({where:{id:f.grants["financial_transaction:view"]},data:{archivedAt:new Date()}}));
  const pointer={propertyId:f.property.id,reservationId:f.reservation.id,idempotencyKey:input.idempotencyKey};expect(await recoverServiceOrderCommand(f.ctx,pointer,f.deps)).toMatchObject({recorded:true,receipt:{orderId:created.orderId,version:1,state:"REQUESTED"}});
  await expect(recoverServiceOrderCommand(other,pointer,f.deps)).rejects.toBeInstanceOf(ServiceOrderAccessError);await expect(createServiceOrder(f.ctx,{...input,request:{...input.request,quantity:3}},f.deps)).rejects.toBeInstanceOf(ServiceOrderConflictError);
 });
 it("enforces append-only originals, complete native history and immutable receipts in PostgreSQL",async()=>{
  const f=await fixture(),created=await createServiceOrder(f.ctx,await command(f),f.deps),saved=await withTenant(db,f.organizationId,async tx=>({order:await tx.serviceOrder.findUniqueOrThrow({where:{id:created.orderId}}),event:await tx.serviceOrderEvent.findFirstOrThrow({where:{orderId:created.orderId}}),receipt:await tx.outboxEvent.findFirstOrThrow({where:{type:serviceOrderChanged}})}));
  await expect(withTenant(db,f.organizationId,tx=>tx.serviceOrder.delete({where:{id:created.orderId}}))).rejects.toThrow(/service_order_history_immutable/u);
  await expect(withTenant(db,f.organizationId,tx=>tx.serviceOrder.update({where:{id:created.orderId},data:{catalogSnapshot:{forged:true}}}))).rejects.toThrow(/service_order_original_or_transition_immutable/u);
  await expect(withTenant(db,f.organizationId,tx=>tx.serviceOrderEvent.update({where:{id:saved.event.id},data:{reason:"Rewrite original reason"}}))).rejects.toThrow(/append|immutable/u);
  await expect(withTenant(db,f.organizationId,tx=>tx.serviceOrder.update({where:{id:created.orderId},data:{state:"CANCELLED",version:2,updatedAt:new Date()}}))).rejects.toThrow(/service_order_native_history_required/u);
  await expect(withTenant(db,f.organizationId,tx=>tx.outboxEvent.update({where:{id:saved.receipt.id},data:{payload:{forged:true}}}))).rejects.toThrow(/service_order_receipt_immutable/u);
  await withTenant(db,f.organizationId,async tx=>{expect(await tx.serviceOrder.findUnique({where:{id:created.orderId}})).toEqual(saved.order);expect(await tx.serviceOrderEvent.count()).toBe(1);});
 });
 it("rolls back the entire command when current creation rights are revoked during its audit",async()=>{
  const f=await fixture(),input=await command(f),write=auditWriter.writeAuditEvent;const spy=vi.spyOn(auditWriter,"writeAuditEvent").mockImplementation(async(client,event)=>{const result=await write(client,event);if(event.action===serviceOrderChanged)await(client as unknown as TenantTransaction).roleAssignment.update({where:{id:f.grants["service_order:create"]},data:{archivedAt:new Date()}});return result;});
  try{await expect(createServiceOrder(f.ctx,input,f.deps)).rejects.toBeInstanceOf(ServiceOrderAccessError);}finally{spy.mockRestore();}
  await withTenant(db,f.organizationId,async tx=>{expect(await tx.serviceOrder.count()).toBe(0);expect(await tx.serviceOrderEvent.count()).toBe(0);expect(await tx.auditLog.count({where:{action:serviceOrderChanged}})).toBe(0);expect(await tx.outboxEvent.count({where:{type:serviceOrderChanged}})).toBe(0);expect((await tx.roleAssignment.findUniqueOrThrow({where:{id:f.grants["service_order:create"]}})).archivedAt).toBeNull();});
 });
});
