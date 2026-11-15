import {randomUUID} from "node:crypto";
import {execFileSync} from "node:child_process";
import {PrismaClient} from "@prisma/client";
import {afterAll,beforeAll,describe,expect,it,vi} from "vitest";
import {withTenant,type TenantTransaction} from "@/platform/db/tenant";
import {authContextForAccount} from "@/platform/authz/account-context";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {servicePricingSchema} from "@/platform/config/service-catalog-policy";
import {setSupplierArchived} from "@/modules/finance/application/supplier-service";
import {previewServiceCatalogChange,publishServiceCatalogChange,recoverServiceCatalogChange,serviceCatalogPage,serviceCatalogHistory,serviceCatalogVersion} from "@/modules/services/application/service-catalog-service";
import {ServiceCatalogAccessError,ServiceCatalogConflictError,ServiceCatalogConfigurationError} from "@/modules/services/domain/service-catalog";
import {listAuditHistory,exportAuditHistoryCsv} from "@/modules/audit/application/audit-service";
import {maskedValue} from "@/platform/authz/present";
import * as auditWriter from "@/platform/audit/audit-writer";
import {nativeServiceCatalogFixture,type NativeServiceCatalogFixture} from "./support/service-catalog-fixture";
import {provisionIntegrationRole} from "./support/database-role";

const url=process.env.TEST_DATABASE_URL;let admin:PrismaClient,db:PrismaClient;
beforeAll(async()=>{
 const target=url?new URL(url):null;if(!target||!["127.0.0.1","localhost"].includes(target.hostname)||!(target.pathname.startsWith("/alvillas_automation_")||process.env.GITHUB_ACTIONS==="true"&&target.pathname==="/alvillas_os"))throw Error("Dedicated native catalog acceptance database required");
 execFileSync(process.execPath,["node_modules/prisma/build/index.js","migrate","deploy"],{env:{...process.env,DATABASE_URL:url},stdio:"pipe"});admin=new PrismaClient({datasourceUrl:url});await provisionIntegrationRole(admin,"alvillas_ops_tests");const scoped=new URL(url!);scoped.username="alvillas_ops_tests";scoped.password="alvillas_ops_tests";db=new PrismaClient({datasourceUrl:scoped.toString()});
});
afterAll(async()=>{await db?.$disconnect();await admin?.$disconnect();});
const fixture=()=>nativeServiceCatalogFixture(admin,db);
async function command(f:NativeServiceCatalogFixture,draft=f.draft){const review=await previewServiceCatalogChange(f.ctx,draft,f.deps);return{draft,reviewFingerprint:review.reviewFingerprint,idempotencyKey:randomUUID()};}
const revoke=(f:NativeServiceCatalogFixture,key:string)=>withTenant(db,f.organizationId,tx=>tx.roleAssignment.update({where:{id:f.grants[key]},data:{archivedAt:new Date()}}));
const financial=(f:NativeServiceCatalogFixture)=>withTenant(db,f.organizationId,tx=>tx.$queryRaw`SELECT 'transaction' AS kind,id::text,xmin::text,ctid::text,to_jsonb(t) AS body FROM financial_transaction t WHERE organization_id=${f.organizationId}::uuid UNION ALL SELECT 'posting',id::text,xmin::text,ctid::text,to_jsonb(p) FROM posting p WHERE organization_id=${f.organizationId}::uuid ORDER BY kind,id`);

describe("native reviewed canonical service catalogs",()=>{
 it("publishes one audited config version under concurrent retry, preserves original extensions and leaves financial history untouched",async()=>{
  const f=await fixture(),before=await financial(f),input=await command(f),results=await Promise.all([publishServiceCatalogChange(f.ctx,input,f.deps),publishServiceCatalogChange(f.ctx,input,f.deps)]);expect(new Set(results.map(row=>row.ruleId)).size).toBe(1);expect(results.map(row=>row.replayed).sort()).toEqual([false,true]);const result=results[0];
  await withTenant(db,f.organizationId,async tx=>{const rows=await tx.configRule.findMany({where:{key:"services.pricing"},orderBy:{createdAt:"asc"}});expect(rows).toHaveLength(2);const actual=rows.find(row=>row.id===result.ruleId)!;expect(actual.value).toMatchObject({owned_extension:{must:"survive unchanged"}});const catalog=servicePricingSchema.parse(actual.value);expect(catalog.services).toHaveLength(2);expect(catalog.services.find(row=>row.key==="legacy_service")).toEqual({key:"legacy_service",pricing_model:"CUSTOM",legacy_extension:{original:true}});expect(catalog.services.find(row=>row.key==="owned_transfer")).toMatchObject({amount:"120.00"});expect(await tx.auditLog.count({where:{action:"service.catalog.published",resourceId:result.ruleId}})).toBe(1);expect(await tx.outboxEvent.count({where:{type:"services.catalog.published"}})).toBe(1);});
  const page=await serviceCatalogPage(f.ctx,{scope:f.scope},f.deps),item=page.items.find(row=>row.key==="owned_transfer");expect(item).toMatchObject({amount:"120.00",orderTerms:{internal_cost:{amount:"30.00",currency:"MAD"}},financialPolicy:{providers:[expect.objectContaining({id:f.supplier.id,label:"Actual catalog fulfillment supplier"})]}});expect(JSON.stringify(page)).not.toContain("must");expect(await financial(f)).toEqual(before);
  expect(await recoverServiceCatalogChange(f.ctx,{scope:f.scope,idempotencyKey:input.idempotencyKey},f.deps)).toMatchObject({recorded:true,receipt:{ruleId:result.ruleId,serviceKey:"owned_transfer"}});
  await setSupplierArchived(f.ctx,{id:f.supplier.id,expectedVersion:0,archived:true,reason:"Archive actual catalog provider after original publication"},f.deps);expect((await serviceCatalogVersion(f.ctx,{scope:f.scope,ruleId:result.ruleId},f.deps)).items.find(row=>row.key==="owned_transfer")).toMatchObject({amount:"120.00"});await expect(previewServiceCatalogChange(f.ctx,f.draft,f.deps)).rejects.toBeInstanceOf(ServiceCatalogAccessError);
 });
 it("rejects stale reviews after actual financial policy changes without creating a publication receipt",async()=>{
  const f=await fixture(),input=await command(f);await withTenant(db,f.organizationId,tx=>new ConfigRuleRepository(tx,f.organizationId).createVersion({key:"finance.tax",scopeType:"organization",value:f.policies.tax.value,effectiveFrom:new Date("2020-01-01"),createdBy:f.account.id,reason:"Actual new separately approved tax version after catalog review"}));
  await expect(publishServiceCatalogChange(f.ctx,input,f.deps)).rejects.toBeInstanceOf(ServiceCatalogConfigurationError);await withTenant(db,f.organizationId,async tx=>expect(await tx.outboxEvent.count({where:{type:"services.catalog.published"}})).toBe(0));
 });
 it("requires both held and persisted independent financial rights before reading private catalog values",async()=>{
  const f=await fixture(),input=await command(f);await revoke(f,"financial_transaction:view");const spy=vi.spyOn(ConfigRuleRepository.prototype,"sourceWitness");try{await expect(publishServiceCatalogChange(f.ctx,input,f.deps)).rejects.toBeInstanceOf(ServiceCatalogAccessError);await expect(serviceCatalogPage(f.ctx,{scope:f.scope},f.deps)).rejects.toBeInstanceOf(ServiceCatalogAccessError);expect(spy).not.toHaveBeenCalled();}finally{spy.mockRestore();}
  const second=await fixture(),held={...second.ctx,authContext:{...second.ctx.authContext,permissions:new Set<string>(),assignments:[],scopes:[]}};await expect(serviceCatalogPage(held,{scope:second.scope},second.deps)).rejects.toBeInstanceOf(ServiceCatalogAccessError);
 });
 it("keeps foreign financial rules and suppliers out of a real tenant publication",async()=>{
  const f=await fixture(),foreign=await fixture();await expect(previewServiceCatalogChange(f.ctx,{...f.draft,entry:{...f.entry,order_terms:{...f.entry.order_terms,allocation_rule_id:foreign.policies.allocation.id}}},f.deps)).rejects.toBeInstanceOf(ServiceCatalogAccessError);await expect(previewServiceCatalogChange(f.ctx,{...f.draft,entry:{...f.entry,order_terms:{...f.entry.order_terms,providers:[{...f.entry.order_terms.providers[0],id:foreign.supplier.id}]}}},f.deps)).rejects.toBeInstanceOf(ServiceCatalogAccessError);
  await withTenant(db,foreign.organizationId,async tx=>{expect(await tx.configRule.findUnique({where:{id:f.policies.original.id}})).toBeNull();});
 });
 it("retains actual versions and masks catalog audit content and reasons after financial access is revoked",async()=>{
  const f=await fixture(),first=await publishServiceCatalogChange(f.ctx,await command(f),f.deps),draft={...f.draft,entry:{...f.entry,amount:"127.31"},reason:"Reviewed private catalog value 127.31"},second=await publishServiceCatalogChange(f.ctx,await command(f,draft),f.deps),history=await serviceCatalogHistory(f.ctx,{scope:f.scope},f.deps);expect(history.items.map(row=>row.id)).toEqual([second.ruleId,first.ruleId]);const original=await serviceCatalogVersion(f.ctx,{scope:f.scope,ruleId:first.ruleId},f.deps);expect(original.items.find(row=>row.key==="owned_transfer")).toMatchObject({amount:"120.00"});
  const filter={resourceType:"config_rule",resourceId:second.ruleId},shown=await listAuditHistory(f.ctx,filter,{db});expect(JSON.stringify(shown)).toContain("127.31");await revoke(f,"financial_transaction:view");const hidden=await listAuditHistory(f.ctx,filter,{db});expect(hidden.rows.length).toBeGreaterThan(0);for(const row of hidden.rows){expect(row.after).toBe(maskedValue);expect(row.reason).toBe(maskedValue);}expect(await exportAuditHistoryCsv(f.ctx,filter,{db})).not.toContain("127.31");await expect(serviceCatalogVersion(f.ctx,{scope:f.scope,ruleId:first.ruleId},f.deps)).rejects.toBeInstanceOf(ServiceCatalogAccessError);
 });
 it("enforces original atomic audited receipt birth and denies real receipt changes or deletion",async()=>{
  const f=await fixture(),input=await command(f),result=await publishServiceCatalogChange(f.ctx,input,f.deps),event=await withTenant(db,f.organizationId,tx=>tx.outboxEvent.findFirstOrThrow({where:{type:"services.catalog.published"}}));
  const denied=(error:unknown)=>String(error).includes("service_catalog_receipt_immutable");await expect(withTenant(db,f.organizationId,tx=>tx.outboxEvent.update({where:{id:event.id},data:{payload:{...event.payload as object,ruleVersion:999}}}))).rejects.toSatisfy(denied);await expect(withTenant(db,f.organizationId,tx=>tx.outboxEvent.delete({where:{id:event.id}}))).rejects.toSatisfy(denied);
  await expect(withTenant(db,f.organizationId,tx=>tx.outboxEvent.create({data:{organizationId:f.organizationId,type:event.type,payload:event.payload!,idempotencyKey:"service-catalog:"+randomUUID(),occurredAt:event.occurredAt}}))).rejects.toThrow(/service_catalog_atomic_audited_version_required/u);
  await expect(publishServiceCatalogChange(f.ctx,{...input,draft:{...input.draft,entry:{...f.entry,amount:"999.00"}}},f.deps)).rejects.toBeInstanceOf(ServiceCatalogConflictError);expect((await serviceCatalogVersion(f.ctx,{scope:f.scope,ruleId:result.ruleId},f.deps)).items.find(row=>row.key==="owned_transfer")?.amount).toBe("120.00");
 });
 it("rolls the version and receipt back when stored authority changes during the audited command",async()=>{
  const f=await fixture(),input=await command(f),original=auditWriter.writeAuditEvent,spy=vi.spyOn(auditWriter,"writeAuditEvent").mockImplementation(async(tx,event)=>{await original(tx,event);if(event.action==="service.catalog.published")await(tx as unknown as TenantTransaction).roleAssignment.update({where:{id:f.grants["service:configure"]},data:{archivedAt:new Date()}});});try{await expect(publishServiceCatalogChange(f.ctx,input,f.deps)).rejects.toBeInstanceOf(ServiceCatalogAccessError);}finally{spy.mockRestore();}
  await withTenant(db,f.organizationId,async tx=>{expect(await tx.configRule.count({where:{key:"services.pricing",scopeType:"property"}})).toBe(0);expect(await tx.auditLog.count({where:{action:"service.catalog.published"}})).toBe(0);expect(await tx.outboxEvent.count({where:{type:"services.catalog.published"}})).toBe(0);});const current=await authContextForAccount(f.organizationId,f.account.id,{db});expect(current.permissions.has("service:configure")).toBe(true);
 });
});
