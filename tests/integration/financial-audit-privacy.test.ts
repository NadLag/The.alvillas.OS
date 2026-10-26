import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { afterAll,beforeAll,describe,expect,it } from "vitest";
import { provisionIntegrationRole } from "./support/database-role";
import { withTenant } from "@/platform/db/tenant";
import { authContextForAccount } from "@/platform/authz/account-context";
import { ensureStandardIdentitySetup } from "@/modules/identity/application/identity-service";
import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
import { AuditRepository } from "@/modules/audit/infrastructure/audit-repository";
import { listAuditHistory,exportAuditHistoryCsv } from "@/modules/audit/application/audit-service";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { Money } from "@/platform/money/money";
import { maskedValue } from "@/platform/authz/present";

const url=process.env.TEST_DATABASE_URL;let admin:PrismaClient,db:PrismaClient;
async function fixture(multicurrency=false){
  const org=randomUUID();await admin.organization.create({data:{id:org,name:"Dedicated financial audit privacy",baseCurrency:"MAD"}});await ensureStandardIdentitySetup(org,{db});
  return withTenant(db,org,async tx=>{
    for(const code of ["MAD",...(multicurrency?["EUR"]:[])])await tx.currency.upsert({where:{code},update:{},create:{code,name:code,minorUnit:2}});
    const person=await tx.person.create({data:{organizationId:org,displayName:"Dedicated journal author"}}),account=await tx.userAccount.create({data:{organizationId:org,personId:person.id}});
    const property=await tx.property.create({data:{organizationId:org,name:"Dedicated financial source villa",addressLine1:"Local privacy fixture",city:"Marrakech",propertyType:"VILLA",bedrooms:1,bathrooms:1,maxGuests:2,amenities:[],photoUrls:[]}});
    const otherProperty=await tx.property.create({data:{organizationId:org,name:"Other dedicated scoped villa",addressLine1:"Local privacy fixture",city:"Marrakech",propertyType:"VILLA",bedrooms:1,bathrooms:1,maxGuests:2,amenities:[],photoUrls:[]}});
    const finance=new FinanceRepository(tx,org),bank=await finance.ensureLedgerAccount({code:"BANK_PRIVACY",name:"Dedicated private bank",accountType:"ASSET_LOCATION",normalSide:"DEBIT"}),
      claim=await finance.ensureLedgerAccount({code:"OWNER_PAYABLE",name:"Dedicated owner payable",accountType:"CLAIM_OWNERSHIP",normalSide:"CREDIT"});
    const dimensions={property_id:property.id,source:"DEDICATED_LOCAL_PRIVACY"};
    const postings=[0,1].flatMap(()=>[
      {ledgerAccountId:bank.id,side:"DEBIT" as const,amount:Money.of("4000","MAD"),bucket:"OWNER_REVENUE",dimensions},
      {ledgerAccountId:claim.id,side:"CREDIT" as const,amount:Money.of("4000","MAD"),bucket:"OWNER_REVENUE",dimensions}
    ]);
    if(multicurrency)postings.push({ledgerAccountId:bank.id,side:"DEBIT",amount:Money.of("100","EUR"),bucket:"OWNER_REVENUE",dimensions},
      {ledgerAccountId:claim.id,side:"CREDIT",amount:Money.of("100","EUR"),bucket:"OWNER_REVENUE",dimensions});
    const journal=await finance.createFinancialTransaction({reference:"Dedicated financial privacy source",description:"Dedicated immutable source",occurredAt:new Date(),idempotencyKey:randomUUID(),createdBy:account.id,postings});
    await writeAuditEvent(tx,{organizationId:org,actorId:account.id,action:"reservation.revenue.posted",resourceType:"financial_transaction",resourceId:journal.id,propertyScopeId:property.id,
      after:{grossAmount:{amount:"8000.00",currency:"MAD"},...(multicurrency?{other:{amount:"100.00",currency:"EUR"}}:{})},reason:"Dedicated confidential financial reason",requestId:randomUUID(),occurredAt:new Date()});
    return{org,property,otherProperty,journal,bank};
  });
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function reader(f:Fixture,financial?:{propertyId?:string;cap?:string;export?:boolean;organization?:boolean}){
  const identity=await withTenant(db,f.org,async tx=>{
    const person=await tx.person.create({data:{organizationId:f.org,displayName:"Dedicated scoped audit reader"}}),account=await tx.userAccount.create({data:{organizationId:f.org,personId:person.id}});
    for(const [kind,keys,scopeType,scopeId,conditions] of [
      ["audit",["audit_log:view","audit_log:export"],"organization",null,null],
      ...(financial?[["finance",["financial_transaction:view",...(financial.export?["financial_transaction:export"]:[])],financial.organization?"organization":"property",financial.organization?null:financial.propertyId??f.property.id,financial.cap?{maxAmount:financial.cap}:null] as const]:[])
    ] as const){
      const role=await tx.role.create({data:{organizationId:f.org,key:`privacy_${kind}_${randomUUID()}`,name:"Dedicated audit permission"}}),permissions=await tx.permission.findMany({where:{key:{in:[...keys]}}});expect(permissions).toHaveLength(keys.length);
      await tx.rolePermission.createMany({data:permissions.map(permission=>({organizationId:f.org,roleId:role.id,permissionId:permission.id}))});
      await tx.roleAssignment.create({data:{organizationId:f.org,userAccountId:account.id,personId:person.id,roleId:role.id,scopeType,scopeId,validFrom:new Date("2020-01-01"),...(conditions?{conditions}:{})}});
    }
    return{person,account};
  });
  return{organizationId:f.org,actorId:identity.account.id,personId:identity.person.id,authContext:await authContextForAccount(f.org,identity.account.id,{db})};
}
describe("financial audit source privacy on real PostgreSQL",()=>{
  beforeAll(async()=>{
    if(!url||!["localhost","127.0.0.1"].includes(new URL(url).hostname))throw Error("Local PostgreSQL is required");
    execFileSync(process.execPath,["node_modules/prisma/build/index.js","migrate","deploy"],{env:{...process.env,DATABASE_URL:url},stdio:"pipe"});
    admin=new PrismaClient({datasourceUrl:url});await provisionIntegrationRole(admin,"alvillas_ops_tests");const scoped=new URL(url);scoped.username="alvillas_ops_tests";scoped.password="alvillas_ops_tests";db=new PrismaClient({datasourceUrl:scoped.toString()});
  });
  afterAll(async()=>{await db?.$disconnect();await admin?.$disconnect()});
  it("masks actual immutable financial payloads and reasons in the viewer and CSV for audit-only readers",async()=>{
    const f=await fixture(),actor=await reader(f),filters={resourceId:f.journal.id};
    const page=await listAuditHistory(actor,filters,{db});expect(page.rows).toHaveLength(1);expect(page.rows[0]).toMatchObject({after:maskedValue,reason:maskedValue});
    expect(JSON.stringify(page)).not.toContain("8000.00");expect(await exportAuditHistoryCsv(actor,filters,{db})).not.toContain("8000.00");
    expect((await withTenant(db,f.org,tx=>tx.auditLog.findFirstOrThrow({where:{resourceId:f.journal.id}}))).after).toMatchObject({grossAmount:{amount:"8000.00"}});
  });
  it("authorizes actual property and aggregate journal amount, with independent financial export rights",async()=>{
    const f=await fixture(),filters={resourceId:f.journal.id},viewer=await reader(f,{cap:"9000"}),capped=await reader(f,{cap:"5000"}),wrong=await reader(f,{propertyId:f.otherProperty.id}),exporter=await reader(f,{cap:"9000",export:true});
    expect(JSON.stringify(await listAuditHistory(viewer,filters,{db}))).toContain("8000.00");
    for(const actor of [capped,wrong])expect((await listAuditHistory(actor,filters,{db})).rows[0].after).toBe(maskedValue);
    expect(await exportAuditHistoryCsv(viewer,filters,{db})).not.toContain("8000.00");expect(await exportAuditHistoryCsv(exporter,filters,{db})).toContain("8000.00");
  });
  it("does not combine currencies to satisfy a financial amount cap or cross the tenant boundary",async()=>{
    const f=await fixture(true),capped=await reader(f,{cap:"9000"}),uncapped=await reader(f,{}),other=await fixture(),foreign=await reader(other,{}),filters={resourceId:f.journal.id};
    expect((await listAuditHistory(capped,filters,{db})).rows[0].after).toBe(maskedValue);expect(JSON.stringify(await listAuditHistory(uncapped,filters,{db}))).toContain("8000.00");
    expect((await listAuditHistory(foreign,filters,{db})).rows).toHaveLength(0);
    const resources=await withTenant(db,f.org,tx=>new AuditRepository(tx,f.org).transactionResources([f.journal.id]));expect(resources.get(f.journal.id)?.amount).toBeUndefined();
  });
  it("uses the actual tenant account and does not invent an amount to satisfy a capped grant",async()=>{
    const f=await fixture(),auditOnly=await reader(f),capped=await reader(f,{organization:true,cap:"9000"}),viewer=await reader(f,{organization:true,export:true});
    await withTenant(db,f.org,tx=>writeAuditEvent(tx,{organizationId:f.org,actorId:viewer.actorId,action:"finance.account.created",resourceType:"ledger_account",resourceId:f.bank.id,
      after:{name:"Dedicated private bank"},reason:"Dedicated confidential account reason",requestId:randomUUID(),occurredAt:new Date()}));
    const filters={resourceId:f.bank.id};
    for(const actor of [auditOnly,capped]){
      expect((await listAuditHistory(actor,filters,{db})).rows[0].after).toBe(maskedValue);
      expect(await exportAuditHistoryCsv(actor,filters,{db})).not.toContain("Dedicated private bank");
    }
    expect(JSON.stringify(await listAuditHistory(viewer,filters,{db}))).toContain("Dedicated private bank");
    expect(await exportAuditHistoryCsv(viewer,filters,{db})).toContain("Dedicated private bank");
    const other=await fixture();
    expect((await withTenant(db,other.org,tx=>new AuditRepository(tx,other.org).ledgerAccountResources([f.bank.id]))).size).toBe(0);
  });
});
