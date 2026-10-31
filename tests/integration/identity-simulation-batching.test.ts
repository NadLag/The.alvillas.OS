import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { afterAll,beforeAll,describe,expect,it,vi } from "vitest";
import { withTenant } from "@/platform/db/tenant";
import { authContextForAccount,authContextsForAccountsInTransaction } from "@/platform/authz/account-context";
import { IdentityRepository } from "@/modules/identity/infrastructure/identity-repository";
import { listIdentityDashboard } from "@/modules/identity/application/identity-service";
import { employeeCompensationFixtures } from "./support/employee-compensation";
import { provisionIntegrationRole } from "./support/database-role";

const url=process.env.TEST_DATABASE_URL;let admin:PrismaClient,db:PrismaClient,queries=0;
const fixtures=employeeCompensationFixtures(()=>db,()=>admin);
async function fixture(){const f=await fixtures.fixture(),rows=[];for(let index=0;index<12;index++){
 const member=await withTenant(db,f.org,async tx=>{const person=await tx.person.create({data:{organizationId:f.org,displayName:"Scoped simulation member "+index}}),account=await tx.userAccount.create({data:{organizationId:f.org,personId:person.id}});return{person,account};});
 const reader=await fixtures.reader({org:f.org,...member},{permissions:["task:view","property:view"],scopeType:"property",scopeId:f.property.id});rows.push({...member,...reader});
 }return{...f,rows};}
function normalized(ctx:Awaited<ReturnType<typeof authContextForAccount>>){return{...ctx,permissions:[...ctx.permissions].sort(),assignments:ctx.assignments?.map(row=>({...row,permissions:[...row.permissions].sort()}))};}
describe.skipIf(!url)("fresh batched Identity permission simulations",()=>{
 beforeAll(async()=>{execFileSync(process.execPath,["node_modules/prisma/build/index.js","migrate","deploy"],{env:{...process.env,DATABASE_URL:url},stdio:"pipe"});admin=new PrismaClient({datasourceUrl:url});await provisionIntegrationRole(admin,"alvillas_ops_tests");const scoped=new URL(url!);scoped.username="alvillas_ops_tests";scoped.password="alvillas_ops_tests";const tracked=new PrismaClient({datasourceUrl:scoped.toString(),log:[{level:"query",emit:"event"}]});tracked.$on("query",()=>queries++);db=tracked;});
 afterAll(async()=>{vi.restoreAllMocks();await db?.$disconnect();await admin?.$disconnect();});
 it("retains individual scoped grants and loads twelve accounts with the same query count as one",async()=>{const f=await fixture(),ids=f.rows.map(row=>row.account.id);queries=0;await withTenant(db,f.org,tx=>authContextsForAccountsInTransaction(tx,f.org,[ids[0]]));const single=queries;queries=0;const batch=await withTenant(db,f.org,tx=>authContextsForAccountsInTransaction(tx,f.org,ids));expect(queries).toBe(single);expect(queries).toBeLessThanOrEqual(16);for(const row of f.rows)expect(normalized(batch.get(row.account.id)!)).toEqual(normalized(await authContextForAccount(f.org,row.account.id,{db})));});
 it("denies suspended accounts, incomplete MFA, expired grants and foreign tenants independently",async()=>{const f=await fixture(),foreign=await fixtures.fixture();await withTenant(db,f.org,async tx=>{await tx.userAccount.update({where:{id:f.rows[0].account.id},data:{status:"SUSPENDED"}});await tx.userAccount.update({where:{id:f.rows[1].account.id},data:{mfaRequired:true}});await tx.roleAssignment.update({where:{id:f.rows[2].grant.id},data:{validTo:new Date("2020-01-02")}});});const ids=[...f.rows.map(row=>row.account.id),foreign.account.id],batch=await withTenant(db,f.org,tx=>authContextsForAccountsInTransaction(tx,f.org,ids));for(const id of [ids[0],ids[1],ids[2],foreign.account.id])expect(batch.get(id)!.permissions.size).toBe(0);expect(batch.get(ids[3])!.permissions.has("task:view")).toBe(true);});
 it("rereads revoked grants on the next batch without caching authority",async()=>{const f=await fixture(),row=f.rows[0],first=await withTenant(db,f.org,tx=>authContextsForAccountsInTransaction(tx,f.org,[row.account.id]));expect(first.get(row.account.id)!.permissions.has("task:view")).toBe(true);await withTenant(db,f.org,tx=>tx.roleAssignment.update({where:{id:row.grant.id},data:{validTo:new Date("2020-01-02")}}));const next=await withTenant(db,f.org,tx=>authContextsForAccountsInTransaction(tx,f.org,[row.account.id]));expect(next.get(row.account.id)!.permissions.size).toBe(0);});
 it("uses one fresh batch for the existing twelve dashboard simulations",async()=>{const f=await fixture(),reader=await fixtures.reader(f,{permissions:["identity:view"]}),spy=vi.spyOn(IdentityRepository.prototype,"authorizationStates");try{const dashboard=await listIdentityDashboard({...reader.ctx,personId:f.person.id},{db});expect(dashboard.simulations).toHaveLength(12);expect(new Set(dashboard.simulations.map(row=>row.userAccountId))).toEqual(new Set(f.rows.map(row=>row.account.id)));expect(spy).toHaveBeenCalledTimes(1);}finally{spy.mockRestore();}});
});
