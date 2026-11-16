import {randomUUID} from "node:crypto";
import {inspectNativeServiceOrderFinancialIdentity} from "@/platform/services/order-financial-source";
import {ServiceAllocationAccessError,ServiceAllocationSourceUnavailableError} from "@/modules/finance/domain/service-allocation";
import {execFileSync} from "node:child_process";
import {PrismaClient} from "@prisma/client";
import {afterAll,beforeAll,describe,expect,it,vi} from "vitest";
import {withTenant,type TenantTransaction} from "@/platform/db/tenant";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {previewServiceCatalogChange,publishServiceCatalogChange} from "@/modules/services/application/service-catalog-service";
import {previewServiceOrder,createServiceOrder} from "@/modules/services/application/service-order-service";
import {previewServiceOrderTransition,transitionServiceOrder} from "@/modules/services/application/service-order-transition";
import {ServiceOrderAccessError,ServiceOrderConflictError,ServiceOrderSourceUnavailableError} from "@/modules/services/domain/service-order";
import {assignOperationTask} from "@/modules/reservations/application/operation-scheduling";
import {proxyCompleteOperationTask} from "@/modules/reservations/application/operation-service";
import {nativeServiceOrderFixture} from "./support/service-order-fixture";
import {provisionIntegrationRole} from "./support/database-role";
import * as auditWriter from "@/platform/audit/audit-writer";

const url=process.env.TEST_DATABASE_URL;let admin:PrismaClient,db:PrismaClient;
beforeAll(async()=>{
 const target=url?new URL(url):null;if(!target||!["127.0.0.1","localhost"].includes(target.hostname)||!(target.pathname.startsWith("/alvillas_automation_")||process.env.GITHUB_ACTIONS==="true"&&target.pathname==="/alvillas_os"))throw Error("Dedicated native order lifecycle database required");
 execFileSync(process.execPath,["node_modules/prisma/build/index.js","migrate","deploy"],{env:{...process.env,DATABASE_URL:url},stdio:"pipe"});admin=new PrismaClient({datasourceUrl:url});await provisionIntegrationRole(admin,"alvillas_ops_tests");const scoped=new URL(url!);scoped.username="alvillas_ops_tests";scoped.password="alvillas_ops_tests";db=new PrismaClient({datasourceUrl:scoped.toString()});
});
afterAll(async()=>{await db?.$disconnect();await admin?.$disconnect();});
type Fixture=Awaited<ReturnType<typeof nativeServiceOrderFixture>>;
const plan={type:"TRANSFER",priority:"NORMAL",checklistTemplateKey:"owned_service"}as const;
async function request(f:Fixture){const preview=await previewServiceOrder(f.ctx,f.request,f.deps);return createServiceOrder(f.ctx,{request:f.request,reviewFingerprint:preview.reviewFingerprint,idempotencyKey:randomUUID()},f.deps);}
async function transition(f:Fixture,draft:unknown){const review=await previewServiceOrderTransition(f.ctx,draft,f.deps);return{...draft as object,reviewFingerprint:review.reviewFingerprint,idempotencyKey:randomUUID()};}
const confirmDraft=(orderId:string,expectedVersion=1)=>({orderId,expectedVersion,state:"CONFIRMED",taskPlan:plan,reason:"Private reviewed customer total 240.00 and original fulfillment terms"});
const financial=(f:Fixture)=>withTenant(db,f.organizationId,tx=>tx.$queryRaw`SELECT 'transaction' AS kind,id::text,xmin::text,ctid::text,to_jsonb(t) AS body FROM financial_transaction t WHERE organization_id=${f.organizationId}::uuid UNION ALL SELECT 'posting',id::text,xmin::text,ctid::text,to_jsonb(p) FROM posting p WHERE organization_id=${f.organizationId}::uuid ORDER BY kind,id`);

describe("native service order quotes and actual fulfillment",()=>{
 it("binds native financial identity to the actual order task and invalidates the binding after canonical cancellation",async()=>{
  const f=await nativeServiceOrderFixture(admin,db),created=await request(f),before=await financial(f);await transitionServiceOrder(f.ctx,await transition(f,confirmDraft(created.orderId)),f.deps);
  const root=await withTenant(db,f.organizationId,tx=>tx.serviceOrder.findUniqueOrThrow({where:{id:created.orderId}})),selection={taskId:root.taskId!,propertyId:f.property.id,reservationId:f.reservation.id};
  await withTenant(db,f.organizationId,async tx=>{const source=await inspectNativeServiceOrderFinancialIdentity(f.ctx,tx,selection);expect(source).toMatchObject({orderId:root.id,serviceKey:f.entry.key,taskId:root.taskId});await source!.recheck();await expect(inspectNativeServiceOrderFinancialIdentity(f.ctx,tx,{...selection,propertyId:randomUUID()})).rejects.toBeInstanceOf(ServiceAllocationSourceUnavailableError);expect(await inspectNativeServiceOrderFinancialIdentity(f.ctx,tx,{...selection,taskId:randomUUID()})).toBeNull();});
  await withTenant(db,f.organizationId,async tx=>{const source=await inspectNativeServiceOrderFinancialIdentity(f.ctx,tx,selection);const cancelled={orderId:root.id,expectedVersion:2,state:"CANCELLED",reason:"Cancel the actual unperformed order before financial recognition"},deps={...f.deps,db:{$transaction:<T>(work:(inner:typeof tx)=>Promise<T>)=>work(tx)}};await transitionServiceOrder(f.ctx,{...cancelled,reviewFingerprint:(await previewServiceOrderTransition(f.ctx,cancelled,deps)).reviewFingerprint,idempotencyKey:randomUUID()},deps);await expect(source!.recheck()).rejects.toBeInstanceOf(ServiceAllocationSourceUnavailableError);});expect(await financial(f)).toEqual(before);
 });
 it("retains held restrictions and repeats current independent order authority before native financial source use",async()=>{
  const f=await nativeServiceOrderFixture(admin,db),created=await request(f);await transitionServiceOrder(f.ctx,await transition(f,confirmDraft(created.orderId)),f.deps);const root=await withTenant(db,f.organizationId,tx=>tx.serviceOrder.findUniqueOrThrow({where:{id:created.orderId}})),selection={taskId:root.taskId!,propertyId:f.property.id,reservationId:f.reservation.id},held={...f.ctx,authContext:{...f.ctx.authContext,permissions:new Set<string>(),assignments:[],scopes:[]}};
  const financialOnly={...f.ctx,authContext:{...f.ctx.authContext,permissions:new Set(["service_order:view"]),assignments:f.ctx.authContext.assignments?.filter(row=>row.permissions.has("service_order:view")).map(row=>({...row,permissions:new Set(["service_order:view"])}))}};
  await withTenant(db,f.organizationId,async tx=>{await expect(inspectNativeServiceOrderFinancialIdentity(held,tx,selection)).rejects.toBeInstanceOf(ServiceAllocationAccessError);expect(await inspectNativeServiceOrderFinancialIdentity(financialOnly,tx,selection)).toMatchObject({orderId:root.id});const source=await inspectNativeServiceOrderFinancialIdentity(f.ctx,tx,selection);await tx.roleAssignment.update({where:{id:f.grants["service_order:view"]},data:{archivedAt:new Date()}});await expect(source!.recheck()).rejects.toBeInstanceOf(ServiceAllocationAccessError);});
 });
 it("confirms once with one canonical task and its real reviewed checklist in the same transaction",async()=>{
  const f=await nativeServiceOrderFixture(admin,db),order=await request(f),before=await financial(f),input=await transition(f,confirmDraft(order.orderId));
  const results=await Promise.all([transitionServiceOrder(f.ctx,input,f.deps),transitionServiceOrder(f.ctx,input,f.deps)]);expect(results.map(row=>row.replayed).sort()).toEqual([false,true]);
  await withTenant(db,f.organizationId,async tx=>{
   const actual=await tx.serviceOrder.findUniqueOrThrow({where:{id:order.orderId}});expect(actual).toMatchObject({version:2,state:"CONFIRMED"});expect(actual.taskId).not.toBeNull();
   const tasks=await tx.operationTask.findMany({where:{type:"TRANSFER"},include:{checklistItems:true}});expect(tasks).toHaveLength(1);expect(tasks[0]).toMatchObject({id:actual.taskId,reservationId:f.reservation.id,propertyId:f.property.id,createdBy:f.account.id,checklistTemplateKey:plan.checklistTemplateKey,state:"PLANNED"});expect(tasks[0].checklistItems).toHaveLength(1);
   const original=await tx.configRule.findUniqueOrThrow({where:{id:tasks[0].checklistConfigRuleId!}});expect(original.key).toBe("ops.checklists");expect(await tx.serviceOrderEvent.count({where:{orderId:order.orderId}})).toBe(2);const operationalAudit=await tx.auditLog.findFirstOrThrow({where:{action:"task.create",resourceId:actual.taskId}});expect(operationalAudit.reason).not.toContain("240.00");expect((await tx.serviceOrderEvent.findFirstOrThrow({where:{orderId:order.orderId,version:2}})).reason).toContain("240.00");
  });expect(await financial(f)).toEqual(before);
 });
 it("requires a real custom quote before confirmation and preserves each original quoted total",async()=>{
  const f=await nativeServiceOrderFixture(admin,db),draft={...f.draft,entry:{...f.entry,pricing_model:"CUSTOM",amount:null}},review=await previewServiceCatalogChange(f.ctx,draft,f.deps);await publishServiceCatalogChange(f.ctx,{draft,reviewFingerprint:review.reviewFingerprint,idempotencyKey:randomUUID()},f.deps);const order=await request(f);
  await expect(previewServiceOrderTransition(f.ctx,confirmDraft(order.orderId),f.deps)).rejects.toBeInstanceOf(ServiceOrderSourceUnavailableError);
  const quoted=await transition(f,{orderId:order.orderId,expectedVersion:1,state:"QUOTED",quote:{amount:"225.35",currency:"MAD",approvalReference:"Actual independently reviewed owned quote"},reason:"Explicit reviewed customer total without any invented payment"});expect(await transitionServiceOrder(f.ctx,quoted,f.deps)).toMatchObject({version:2,state:"QUOTED",replayed:false});
  expect(await transitionServiceOrder(f.ctx,await transition(f,confirmDraft(order.orderId,2)),f.deps)).toMatchObject({version:3,state:"CONFIRMED"});
  await withTenant(db,f.organizationId,async tx=>{const events=await tx.serviceOrderEvent.findMany({where:{orderId:order.orderId},orderBy:{version:"asc"}});expect(events[0].snapshot).toMatchObject({totalAmount:null});expect(events[1].snapshot).toMatchObject({totalAmount:"225.35",quoteReference:"Actual independently reviewed owned quote"});expect(events[2].snapshot).toMatchObject({totalAmount:"225.35"});});
 });
 it("catches up from confirmed only after actual native assigned work and distinct proxy validation complete",async()=>{
  const f=await nativeServiceOrderFixture(admin,db),order=await request(f);await transitionServiceOrder(f.ctx,await transition(f,confirmDraft(order.orderId)),f.deps);
  const done={orderId:order.orderId,expectedVersion:2,state:"FULFILLED",reason:"Review actual immutable completed work, never an acknowledgement"};await expect(previewServiceOrderTransition(f.ctx,done,f.deps)).rejects.toBeInstanceOf(ServiceOrderSourceUnavailableError);
  const performer=await withTenant(db,f.organizationId,async tx=>{
   const person=await tx.person.create({data:{organizationId:f.organizationId,displayName:"Actual distinct native service performer"}}),role=await tx.role.findFirstOrThrow({where:{organizationId:f.organizationId,key:"driver"}});
   await tx.roleAssignment.create({data:{organizationId:f.organizationId,personId:person.id,roleId:role.id,scopeType:"property",scopeId:f.property.id,validFrom:new Date("2020-01-01")}});return person;
  }),root=await withTenant(db,f.organizationId,tx=>tx.serviceOrder.findUniqueOrThrow({where:{id:order.orderId}})),task=await withTenant(db,f.organizationId,tx=>tx.operationTask.findUniqueOrThrow({where:{id:root.taskId!}}));
  const assigned=await assignOperationTask(f.ctx,{taskId:task.id,expectedVersion:task.version,personId:performer.id,startMinute:540,reason:"Assign actual native property driver for owned fulfillment",idempotencyKey:randomUUID()},f.deps),items=await withTenant(db,f.organizationId,tx=>tx.operationTaskChecklistItem.findMany({where:{taskId:task.id}}));
  await proxyCompleteOperationTask(f.ctx,{taskId:task.id,expectedVersion:assigned.version,performedByPersonId:performer.id,checklistItemIds:items.map(item=>item.id),reason:"Actual distinct validator confirms the performed native service",idempotencyKey:randomUUID()},f.deps);
  const held={...f.ctx,authContext:{...f.ctx.authContext,permissions:new Set([...f.ctx.authContext.permissions].filter(key=>key!=="service_order:validate")),assignments:f.ctx.authContext.assignments?.filter(assignment=>!assignment.permissions.has("service_order:validate"))??[]}};
  await expect(previewServiceOrderTransition(held,done,f.deps)).rejects.toBeInstanceOf(ServiceOrderAccessError);
  const before=await financial(f),completed=await transitionServiceOrder(f.ctx,await transition(f,done),f.deps);expect(completed).toMatchObject({state:"FULFILLED",version:3});expect(await financial(f)).toEqual(before);
  await withTenant(db,f.organizationId,async tx=>{const actual=await tx.operationTask.findUniqueOrThrow({where:{id:task.id}});expect(actual.state).toBe("COMPLETED");expect(actual.completedByPersonId).toBe(performer.id);expect(actual.validatedByPersonId).toBe(f.person.id);expect(actual.completionSource).toBe("PROXY");});
 });
 it("cancels the actual native task atomically and preserves original order history",async()=>{
  const f=await nativeServiceOrderFixture(admin,db),order=await request(f);await transitionServiceOrder(f.ctx,await transition(f,confirmDraft(order.orderId)),f.deps);const before=await financial(f),input=await transition(f,{orderId:order.orderId,expectedVersion:2,state:"CANCELLED",reason:"Explicit native cancellation before performed work or collected funds"});
  expect(await transitionServiceOrder(f.ctx,input,f.deps)).toMatchObject({state:"CANCELLED",version:3});expect(await financial(f)).toEqual(before);
  await withTenant(db,f.organizationId,async tx=>{const root=await tx.serviceOrder.findUniqueOrThrow({where:{id:order.orderId}});expect((await tx.operationTask.findUniqueOrThrow({where:{id:root.taskId!}})).state).toBe("CANCELLED");expect(await tx.serviceOrderEvent.count({where:{orderId:root.id}})).toBe(3);});
 });
 it("rejects stale checklist reviews before creating a native task",async()=>{
  const f=await nativeServiceOrderFixture(admin,db),order=await request(f),input=await transition(f,confirmDraft(order.orderId));await withTenant(db,f.organizationId,async tx=>{
   const existing=await tx.configRule.findFirstOrThrow({where:{key:"ops.checklists",scopeId:f.property.id,lifecycle:"ACTIVE"}});await new ConfigRuleRepository(tx,f.organizationId).createVersion({key:existing.key,scopeType:"property",scopeId:f.property.id,createdBy:f.account.id,effectiveFrom:new Date("2020-01-01"),value:existing.value!,reason:"Actual checklist revision after original fulfillment review"});
  });await expect(transitionServiceOrder(f.ctx,input,f.deps)).rejects.toBeInstanceOf(ServiceOrderConflictError);await withTenant(db,f.organizationId,async tx=>{expect(await tx.operationTask.count({where:{type:"TRANSFER"}})).toBe(0);expect((await tx.serviceOrder.findUniqueOrThrow({where:{id:order.orderId}})).version).toBe(1);});
 });
 it("rolls back native task creation and order confirmation when approval authority changes during task audit",async()=>{
  const f=await nativeServiceOrderFixture(admin,db),order=await request(f),input=await transition(f,confirmDraft(order.orderId)),write=auditWriter.writeAuditEvent;let taskId:string|null=null;
  const spy=vi.spyOn(auditWriter,"writeAuditEvent").mockImplementation(async(client,event)=>{const result=await write(client,event);if(event.action==="task.create"){taskId=event.resourceId;await(client as unknown as TenantTransaction).roleAssignment.update({where:{id:f.grants["service_order:approve"]},data:{archivedAt:new Date()}});}return result;});
  try{await expect(transitionServiceOrder(f.ctx,input,f.deps)).rejects.toBeInstanceOf(ServiceOrderAccessError);}finally{spy.mockRestore();}
  expect(taskId).not.toBeNull();await withTenant(db,f.organizationId,async tx=>{expect(await tx.operationTask.count({where:{type:"TRANSFER"}})).toBe(0);expect(await tx.auditLog.count({where:{action:"task.create",resourceId:taskId}})).toBe(0);expect(await tx.serviceOrderEvent.count({where:{orderId:order.orderId}})).toBe(1);expect((await tx.serviceOrder.findUniqueOrThrow({where:{id:order.orderId}}))).toMatchObject({state:"REQUESTED",version:1,taskId:null});});
 });
});
