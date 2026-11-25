import {randomUUID} from "node:crypto";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {z} from "zod";
import {Prisma,PrismaClient} from "@prisma/client";
import {beforeAll,afterAll,it,expect,vi} from "vitest";
import {withTenant} from "@/platform/db/tenant";
import {authContextForAccount} from "@/platform/authz/account-context";
import {nativeGuestHubFixture} from "./support/guest-hub-fixture";
import {provisionIntegrationRole} from "./support/database-role";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {InventoryStayConsumptionRepository} from "@/modules/inventory/infrastructure/stay-consumption-repository";
import {inventoryStayConsumptionPage} from "@/modules/inventory/application/stay-consumption-service";
import {previewInventoryMovement,publishInventoryMovement} from "@/modules/inventory/application/movement-service";
import {InventoryCatalogAccessError,InventoryCatalogConflictError} from "@/modules/inventory/domain/catalog-errors";
let admin:PrismaClient,db:PrismaClient;
beforeAll(async()=>{const url=new URL(process.env.TEST_DATABASE_URL!);if(!["127.0.0.1","localhost"].includes(url.hostname)||!(url.pathname.startsWith("/alvillas_automation_")||process.env.GITHUB_ACTIONS==="true"&&url.pathname==="/alvillas_os"))throw Error("Owned native stay consumption database required");admin=new PrismaClient({datasourceUrl:url.toString()});await provisionIntegrationRole(admin,"alvillas_ops_tests");url.username=url.password="alvillas_ops_tests";db=new PrismaClient({datasourceUrl:url.toString()});});
afterAll(async()=>{vi.restoreAllMocks();await db?.$disconnect();await admin?.$disconnect();});
async function fixture(){
 const f=await nativeGuestHubFixture(admin,db),grants:Record<string,string>={...f.grants},saved=await withTenant(db,f.organizationId,async tx=>{
  for(const key of["inventory_movement:view","inventory_movement:create","inventory_movement:void","inventory_item:view","inventory_location:view","config_rule:view","config_rule:configure","property:view"]){const permission=await tx.permission.findFirstOrThrow({where:{organizationId:f.organizationId,key}}),role=await tx.role.create({data:{organizationId:f.organizationId,key:"native_stay_"+randomUUID(),name:"Independent actual stay consumption "+key}});await tx.rolePermission.create({data:{organizationId:f.organizationId,roleId:role.id,permissionId:permission.id}});grants[key]=(await tx.roleAssignment.create({data:{organizationId:f.organizationId,personId:f.person.id,userAccountId:f.account.id,roleId:role.id,scopeType:"organization",validFrom:new Date("2020-01-01")}})).id;}
  const item=await tx.inventoryItem.create({data:{organizationId:f.organizationId,key:"stay.original",category:"CONSUMABLE",unit:"piece",labels:{en:"Original stay supplies",fr:"Fournitures originales du séjour",ar:"مستلزمات الإقامة الأصلية"}}}),location=await tx.inventoryLocation.create({data:{organizationId:f.organizationId,kind:"PROPERTY",propertyId:f.property.id,label:"Original stay stock"}}),rules=new ConfigRuleRepository(tx,f.organizationId),policy=await rules.createVersion({key:"inventory.minimums",scopeType:"property",scopeId:f.property.id,createdBy:f.account.id,effectiveFrom:new Date("2020-01-01"),value:{minimums:[{item:item.key,quantity:0,expected_per_stay:0}]},reason:"Actual explicit original-unit per-stay expectation"});return{item,location,policy};
 });return{...f,...saved,grants,ctx:{...f.ctx,authContext:{...await authContextForAccount(f.organizationId,f.account.id,{db}),personId:f.person.id}},deps:{db}};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function post(f:Fixture,change:Record<string,unknown>){const draft={...change.kind==="REVERSAL"?{}:{itemId:f.item.id,locationId:f.location.id,quantity:"1"},reason:"Actual native movement for original stay consumption",...change},review=await previewInventoryMovement(f.ctx,draft,f.deps);return publishInventoryMovement(f.ctx,{draft:review.draft,reviewFingerprint:review.reviewFingerprint,idempotencyKey:randomUUID()},f.deps);}
const facts=(f:Fixture)=>withTenant(db,f.organizationId,async tx=>({movements:await tx.$queryRaw(Prisma.sql`SELECT id,xmin::text,md5(to_jsonb(m)::text) AS body FROM inventory_movement m WHERE organization_id=${f.organizationId}::uuid ORDER BY id`),financial:await tx.$queryRaw(Prisma.sql`SELECT id,xmin::text,md5(to_jsonb(f)::text) AS body FROM financial_transaction f WHERE organization_id=${f.organizationId}::uuid ORDER BY id`),postings:await tx.$queryRaw(Prisma.sql`SELECT id,xmin::text,md5(to_jsonb(p)::text) AS body FROM posting p WHERE organization_id=${f.organizationId}::uuid ORDER BY id`),outbox:await tx.outboxEvent.count({where:{organizationId:f.organizationId}}),audits:await tx.auditLog.count({where:{organizationId:f.organizationId}})}));
it("compares the effective arrival policy with exact original consumption and reversals without rewriting stock or money",async()=>{
 const f=await fixture(),quantity="9007199254740993";await post(f,{kind:"PURCHASE",quantity:"9007199254741000"});await post(f,{kind:"RESERVATION",quantity,reservationId:f.reservation.id});const consumed=await post(f,{kind:"CONSUMPTION",quantity,reservationId:f.reservation.id});const before=await facts(f),page=await inventoryStayConsumptionPage(f.ctx,{reservationId:f.reservation.id},f.deps);expect(page.policy?.id).toBe(f.policy.id);expect(page.items[0]).toMatchObject({expected:"0",actual:quantity,variance:quantity,movementCount:"1"});expect(await facts(f)).toEqual(before);
 await post(f,{kind:"REVERSAL",originalGroupId:consumed.groupId});expect((await inventoryStayConsumptionPage(f.ctx,{reservationId:f.reservation.id},f.deps)).items[0]).toMatchObject({expected:"0",actual:"0",variance:"0",movementCount:"2"});
 await withTenant(db,f.organizationId,tx=>new ConfigRuleRepository(tx,f.organizationId).createVersion({key:"inventory.minimums",scopeType:"property",scopeId:f.property.id,createdBy:f.account.id,effectiveFrom:new Date(f.reservation.checkIn.getTime()+86400000),value:{minimums:[{item:f.item.key,quantity:0,expected_per_stay:999}]},reason:"Actual future policy must not rewrite arrival expectation"}));expect((await inventoryStayConsumptionPage(f.ctx,{reservationId:f.reservation.id},f.deps)).items[0].expected).toBe("0");
});
it("paginates missing catalog definitions, keeps unspecified requirements and rejects another tenant or withdrawn source access",async()=>{
 const f=await fixture(),other=await fixture();await withTenant(db,f.organizationId,tx=>new ConfigRuleRepository(tx,f.organizationId).createVersion({key:"inventory.minimums",scopeType:"property",scopeId:f.property.id,createdBy:f.account.id,effectiveFrom:new Date("2020-01-02"),value:{minimums:[{item:f.item.key,quantity:0},...Array.from({length:55},(_,index)=>({item:"stay.missing."+String(index).padStart(3,"0"),quantity:0,name:{en:"Actual missing original "+index,fr:"Article original absent "+index},unit:"piece",category:"CONSUMABLE",expected_per_stay:2}))]},reason:"Actual paged original per-stay catalog settings"}));
 const page=await inventoryStayConsumptionPage(f.ctx,{reservationId:f.reservation.id},f.deps);expect(page.items).toHaveLength(50);expect(page.next).not.toBeNull();const next=await inventoryStayConsumptionPage(f.ctx,{reservationId:f.reservation.id,after:page.next!},f.deps);expect(next.items).toHaveLength(6);expect(next.next).toBeNull();expect(new Set([...page.items,...next.items].map(row=>row.key)).size).toBe(56);expect([...page.items,...next.items].find(row=>row.key===f.item.key)?.expected).toBeNull();expect(page.items[0]).toMatchObject({condition:"MISSING",expected:"2",actual:"0"});expect((await inventoryStayConsumptionPage(f.ctx,{reservationId:f.reservation.id,query:"%"},f.deps)).items).toEqual([]);
 await expect(inventoryStayConsumptionPage(other.ctx,{reservationId:f.reservation.id},other.deps)).rejects.toBeInstanceOf(InventoryCatalogAccessError);await withTenant(db,f.organizationId,tx=>tx.roleAssignment.update({where:{id:f.grants["config_rule:view"]},data:{archivedAt:new Date()}}));await expect(inventoryStayConsumptionPage(f.ctx,{reservationId:f.reservation.id},f.deps)).rejects.toBeInstanceOf(InventoryCatalogAccessError);
});
it("rejects a stay revision or current reservation permission withdrawal during the actual source read",async()=>{
 type ReadRows = InventoryStayConsumptionRepository["rows"];
 // The service awaits rows. The spy adds an asynchronous step after the real Prisma query.
 const prototype: {
  rows: (this: InventoryStayConsumptionRepository, ...args: Parameters<ReadRows>) => Promise<Awaited<ReturnType<ReadRows>>>;
 } = InventoryStayConsumptionRepository.prototype;
 const original = prototype.rows;
 const f = await fixture();
 let changed = false;
 const spy = vi.spyOn(prototype, "rows").mockImplementation(async function(this: InventoryStayConsumptionRepository, ...args) {
  const rows = await original.apply(this, args);
  if (!changed) {
   changed = true;
   await withTenant(db, f.organizationId, tx => tx.reservation.update({
    where: { id: f.reservation.id }, data: { reference: "Revised original stay reference" }
   }));
  }
  return rows;
 });
 try {
  await expect(inventoryStayConsumptionPage(f.ctx, { reservationId: f.reservation.id }, f.deps)).rejects.toBeInstanceOf(InventoryCatalogConflictError);
 } finally {
  spy.mockRestore();
 }
 expect(changed).toBe(true);

 const second = await fixture();
 changed = false;
 const withdrawal = vi.spyOn(prototype, "rows").mockImplementation(async function(this: InventoryStayConsumptionRepository, ...args) {
  const rows = await original.apply(this, args);
  if (!changed) {
   changed = true;
   await withTenant(db, second.organizationId, tx => tx.roleAssignment.update({
    where: { id: second.grants["reservation:view"] }, data: { archivedAt: new Date() }
   }));
  }
  return rows;
 });
 try {
  await expect(inventoryStayConsumptionPage(second.ctx, { reservationId: second.reservation.id }, second.deps)).rejects.toBeInstanceOf(InventoryCatalogAccessError);
 } finally {
  withdrawal.mockRestore();
 }
 expect(changed).toBe(true);
});
it("runs the actual browser producer through configured requirements and original reserved consumption",async()=>{
 const f=await fixture(),output=resolve(".tmp/stay-consumption-browser-"+randomUUID()+"/fixture.private.json");await promisify(execFile)(process.execPath,[resolve("node_modules/tsx/dist/cli.mjs"),resolve("tests/e2e/support/inventory-movement-fixture-worker.ts"),JSON.stringify({organizationId:f.organizationId,accountId:f.account.id,personId:f.person.id,guestLocale:"ar",stay:true,output})],{env:process.env,windowsHide:true,timeout:120000,maxBuffer:2*1024*1024});const actual=z.object({reservationId:z.uuid(),itemKey:z.string(),financialCount:z.number().int()}).passthrough().parse(JSON.parse(await readFile(output,"utf8"))),ctx={...f.ctx,authContext:{...await authContextForAccount(f.organizationId,f.account.id,{db}),personId:f.person.id}},page=await inventoryStayConsumptionPage(ctx,{reservationId:actual.reservationId},f.deps);expect(page.items).toHaveLength(1);expect(page.items[0]).toMatchObject({key:actual.itemKey,expected:"2",actual:"3",variance:"1",movementCount:"1"});expect(await withTenant(db,f.organizationId,tx=>tx.financialTransaction.count({where:{organizationId:f.organizationId}}))).toBe(actual.financialCount);
});
