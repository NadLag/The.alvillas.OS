import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Prisma,PrismaClient } from "@prisma/client";
import { afterAll,beforeAll,describe,expect,it,vi } from "vitest";
import { provisionIntegrationRole } from "./support/database-role";
import { withTenant } from "@/platform/db/tenant";
import { authContextForAccount } from "@/platform/authz/account-context";
import { ensureStandardIdentitySetup } from "@/modules/identity/application/identity-service";
import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
import { OwnerLedgerRepository } from "@/modules/finance/infrastructure/owner-ledger-repository";
import { getOwnerLedger,listOwnerLedgerChoices,OwnerLedgerAccessError } from "@/modules/finance/application/owner-ledger-service";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { writeAuditEvent } from "@/platform/audit/audit-writer";

const url=process.env.TEST_DATABASE_URL;let admin:PrismaClient,db:PrismaClient;
async function fixture(){
  const org=randomUUID();await admin.organization.create({data:{id:org,name:"Dedicated owner ledger acceptance",baseCurrency:"MAD"}});await ensureStandardIdentitySetup(org,{db});
  return withTenant(db,org,async tx=>{
    for(const code of["MAD","EUR"])await tx.currency.upsert({where:{code},update:{},create:{code,name:code,minorUnit:2}});
    const person=await tx.person.create({data:{organizationId:org,displayName:"Dedicated ledger operator"}}),account=await tx.userAccount.create({data:{organizationId:org,personId:person.id}});
    const owner=await tx.owner.create({data:{organizationId:org,displayName:"Dedicated authorized owner"}}),otherOwner=await tx.owner.create({data:{organizationId:org,displayName:"Dedicated unrelated owner"}});
    const properties:Array<{id:string;name:string}>=[];
    for(let index=0;index<3;index++)properties.push(await tx.property.create({data:{organizationId:org,name:`Dedicated ledger villa ${index}`,addressLine1:"Local financial acceptance",city:"Marrakech",propertyType:"VILLA",bedrooms:1,bathrooms:1,maxGuests:2,amenities:[],photoUrls:[]}}));
    await tx.propertyOwner.createMany({data:properties.map((property,index)=>({organizationId:org,propertyId:property.id,ownerId:index===2?otherOwner.id:owner.id}))});
    const finance=new FinanceRepository(tx,org),bank=await finance.ensureLedgerAccount({code:"LEDGER_QA_BANK",name:"Confidential unrelated bank metadata",accountType:"ASSET_LOCATION",normalSide:"DEBIT"}),claim=await finance.ensureLedgerAccount({code:"OWNER_PAYABLE",name:"Owner claim",accountType:"CLAIM_OWNERSHIP",normalSide:"CREDIT"});
    await new ConfigRuleRepository(tx,org).createVersion({key:"finance.accounting_periods",scopeType:"organization",scopeId:null,effectiveFrom:new Date("2000-01-01"),reason:"Explicit owner ledger calendar",value:{timezone:"America/Denver",allow_early_close:false,max_reopen_seconds:60}});
    return{org,account,person,owner,otherOwner,properties,bank,claim};
  });
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function reader(f:Fixture,scopeType:"organization"|"owner"|"property"|"financial_record"="owner",scopeId:string|null=f.owner.id,conditions?:Prisma.InputJsonObject){
  const grant=await withTenant(db,f.org,async tx=>{
    const role=await tx.role.create({data:{organizationId:f.org,key:`ledger_reader_${randomUUID()}`,name:"Dedicated statement read"}}),permission=await tx.permission.findFirstOrThrow({where:{organizationId:f.org,key:"owner_statement:view"}});
    await tx.rolePermission.create({data:{organizationId:f.org,roleId:role.id,permissionId:permission.id}});
    return tx.roleAssignment.create({data:{organizationId:f.org,roleId:role.id,personId:f.person.id,userAccountId:f.account.id,scopeType,scopeId,validFrom:new Date("2020-01-01"),...(conditions?{conditions}:{})}});
  });
  return{ctx:{organizationId:f.org,actorId:f.account.id,authContext:await authContextForAccount(f.org,f.account.id,{db})},grant};
}
async function journal(f:Fixture,at:string,amount="1.00",options:{id?:string;ownerId?:string;propertyId?:string;currency?:string;side?:"CREDIT"|"DEBIT";bucket?:string}={}){
  const id=options.id??randomUUID(),ownerId=options.ownerId??f.owner.id,propertyId=options.propertyId??f.properties[0].id,currency=options.currency??"MAD",side=options.side??"CREDIT",bucket=options.bucket??"OWNER_REVENUE";
  return withTenant(db,f.org,async tx=>{
    await tx.$executeRaw(Prisma.sql`INSERT INTO financial_transaction(id,organization_id,reference,description,occurred_at,idempotency_key,created_by)
      VALUES(${id}::uuid,${f.org}::uuid,${"LEDGER_QA:"+id},'Dedicated owner ledger fixture',${at}::timestamptz,${randomUUID()},${f.account.id}::uuid)`);
    for(const [accountId,postingSide] of[[f.claim.id,side],[f.bank.id,side==="CREDIT"?"DEBIT":"CREDIT"]])await tx.$executeRaw(Prisma.sql`
      INSERT INTO posting(organization_id,transaction_id,ledger_account_id,side,amount,currency,bucket,dimensions)
      VALUES(${f.org}::uuid,${id}::uuid,${accountId}::uuid,${postingSide},${amount}::numeric,${currency},${bucket},
        jsonb_build_object('owner_id',${ownerId},'property_id',${propertyId},'source','OWNER_LEDGER_QA'))`);
    await writeAuditEvent(tx,{organizationId:f.org,actorId:f.account.id,action:"finance.owner_ledger.fixture.posted",resourceType:"financial_transaction",resourceId:id,
      after:{amount,currency},reason:"Dedicated owner ledger fixture",requestId:randomUUID(),occurredAt:new Date()});return id;
  });
}
const day={fromOn:"2026-03-08",toOn:"2026-03-08",timezone:"America/Denver",currency:"MAD"};
describe("derived owner ledger on real PostgreSQL",()=>{
  beforeAll(async()=>{if(!url||!["localhost","127.0.0.1"].includes(new URL(url).hostname))throw Error("Isolated local PostgreSQL required");
    execFileSync(process.execPath,["node_modules/prisma/build/index.js","migrate","deploy"],{env:{...process.env,DATABASE_URL:url},stdio:"pipe"});admin=new PrismaClient({datasourceUrl:url});await provisionIntegrationRole(admin,"alvillas_ops_tests");const scoped=new URL(url);scoped.username="alvillas_ops_tests";scoped.password="alvillas_ops_tests";db=new PrismaClient({datasourceUrl:scoped.toString()});
  });
  afterAll(async()=>{await db?.$disconnect();await admin?.$disconnect()});
  it("derives opening, credits, debits, buckets and closing across the exact 23-hour DST day",async()=>{
    const f=await fixture(),{ctx}=await reader(f);
    await journal(f,"2026-03-08T06:59:59.999999Z","8000");await journal(f,"2026-03-08T07:00:00Z","500");
    await journal(f,"2026-03-08T12:00:00Z","200",{side:"DEBIT",bucket:"COMMISSION"});await journal(f,"2026-03-09T05:59:59.999999Z","300",{side:"DEBIT",bucket:"OWNER_EXPENSE"});
    await journal(f,"2026-03-09T05:59:59.999999Z","150",{side:"DEBIT",bucket:"PAYOUT"});await journal(f,"2026-03-09T06:00:00Z","999");
    await journal(f,"2026-03-08T12:00:00Z","10000",{ownerId:f.otherOwner.id,propertyId:f.properties[2].id});await journal(f,"2026-03-08T12:00:00Z","1000",{currency:"EUR"});
    const result=await getOwnerLedger(ctx,{ownerId:f.owner.id,...day},{db});expect(result).toMatchObject({openingBalance:"8000.00",periodCredits:"500.00",periodDebits:"650.00",closingBalance:"7850.00",rowCount:"4"});
    expect(result.bucketTotals).toContainEqual({bucket:"COMMISSION",credits:"0.00",debits:"200.00",net:"-200.00"});expect(result.lines).toHaveLength(4);expect(result.lines.at(-1)?.runningBalance).toBe("7850.00");
    expect(JSON.stringify(result)).not.toContain(f.bank.name);expect(JSON.stringify(result)).not.toContain(f.bank.id);
    const bounds=await withTenant(db,f.org,tx=>new OwnerLedgerRepository(tx,f.org).range(day.fromOn,day.toOn,day.timezone));expect(bounds.endsAt.getTime()-bounds.startsAt.getTime()).toBe(23*60*60*1000);
    const fall=await withTenant(db,f.org,tx=>new OwnerLedgerRepository(tx,f.org).range("2026-11-01","2026-11-01",day.timezone));expect(fall.endsAt.getTime()-fall.startsAt.getTime()).toBe(25*60*60*1000);
  });
  it("keeps every cent when 500 properties exceed JavaScript and Decimal arithmetic precision",async()=>{
    const f=await fixture(),{ctx}=await reader(f),properties=Array.from({length:500},()=>({id:randomUUID(),organizationId:f.org,name:"Dedicated scaled owner villa",addressLine1:"Scaled financial acceptance",city:"Marrakech",propertyType:"VILLA",bedrooms:1,bathrooms:1,maxGuests:2,amenities:[],photoUrls:[]}));
    await withTenant(db,f.org,async tx=>{await tx.property.createMany({data:properties});await tx.propertyOwner.createMany({data:properties.map(property=>({organizationId:f.org,propertyId:property.id,ownerId:f.owner.id}))})});
    for(const property of properties)await journal(f,"2026-03-08T06:59:59Z","9999999999999999.99",{propertyId:property.id});
    await journal(f,"2026-03-08T07:00:00Z","0.01");
    const result=await getOwnerLedger(ctx,{ownerId:f.owner.id,...day},{db});expect(result.openingBalance).toBe("4999999999999999995.00");expect(result.closingBalance).toBe("4999999999999999995.01");expect(result.lines[0].runningBalance).toBe(result.closingBalance);
  },60000);
  it("pages microsecond posting timestamps without duplicate lines or losing running balances",async()=>{
    const f=await fixture(),{ctx}=await reader(f);for(let index=0;index<53;index++)await journal(f,index<51?"2026-03-08T07:00:00.000001Z":"2026-03-08T07:00:00.000002Z","0.01");
    const first=await getOwnerLedger(ctx,{ownerId:f.owner.id,...day},{db});expect(first.lines).toHaveLength(50);expect(first.next).toBe(first.lines[49].id);
    const second=await getOwnerLedger(ctx,{ownerId:f.owner.id,...day,after:first.next},{db});expect(second.lines).toHaveLength(3);expect(second.next).toBeUndefined();expect(new Set([...first.lines,...second.lines].map(row=>row.id)).size).toBe(53);expect(second.lines.at(-1)?.runningBalance).toBe("0.53");
    await expect(getOwnerLedger(ctx,{ownerId:f.owner.id,...day,after:randomUUID()},{db})).rejects.toBeInstanceOf(OwnerLedgerAccessError);
  });
  it("requires current and caller statement authority and never substitutes general financial access",async()=>{
    const f=await fixture(),{ctx,grant}=await reader(f);await journal(f,"2026-03-08T07:00:00Z","25");
    await expect(getOwnerLedger({...ctx,authContext:{...ctx.authContext,assignments:[],permissions:new Set(["financial_transaction:view"]),scopes:[]}}, {ownerId:f.owner.id,...day},{db})).rejects.toBeInstanceOf(OwnerLedgerAccessError);
    await withTenant(db,f.org,tx=>tx.roleAssignment.update({where:{id:grant.id},data:{validTo:new Date("2020-01-02")}}));
    await expect(getOwnerLedger(ctx,{ownerId:f.owner.id,...day},{db})).rejects.toBeInstanceOf(OwnerLedgerAccessError);expect(await withTenant(db,f.org,tx=>tx.auditLog.count({where:{action:"finance.owner_ledger.viewed"}}))).toBe(0);
  });
  it("denies conditional aggregates instead of presenting balances from hidden movements",async()=>{
    const f=await fixture(),{ctx}=await reader(f,"owner",f.owner.id,{maxAmount:"100"});await journal(f,"2026-03-08T07:00:00Z","150");
    await expect(getOwnerLedger(ctx,{ownerId:f.owner.id,...day},{db})).rejects.toBeInstanceOf(OwnerLedgerAccessError);expect((await listOwnerLedgerChoices(ctx,{}, {db})).owners).toEqual([]);
    const unconditional=await reader(f);expect((await getOwnerLedger(unconditional.ctx,{ownerId:f.owner.id,...day},{db})).closingBalance).toBe("150.00");
  });
  it("does not turn one journal grant into a whole-owner aggregate when entity UUIDs coincide",async()=>{
    const f=await fixture();await journal(f,"2026-03-08T07:00:00Z","10",{id:f.owner.id});await journal(f,"2026-03-08T07:00:01Z","20");const {ctx}=await reader(f,"financial_record",f.owner.id);
    await expect(getOwnerLedger(ctx,{ownerId:f.owner.id,...day},{db})).rejects.toBeInstanceOf(OwnerLedgerAccessError);
    expect((await listOwnerLedgerChoices(ctx,{}, {db})).owners).toEqual([]);
  });
  it("enforces property and tenant scope before returning names, totals or cursor data",async()=>{
    const f=await fixture(),other=await fixture(),{ctx}=await reader(f,"property",f.properties[0].id);await journal(f,"2026-03-08T07:00:00Z","25");await journal(f,"2026-03-08T07:00:00Z","70",{propertyId:f.properties[1].id});
    await expect(getOwnerLedger(ctx,{ownerId:f.owner.id,...day},{db})).rejects.toBeInstanceOf(OwnerLedgerAccessError);
    expect((await getOwnerLedger(ctx,{ownerId:f.owner.id,propertyId:f.properties[0].id,...day},{db})).closingBalance).toBe("25.00");
    await expect(getOwnerLedger(ctx,{ownerId:other.owner.id,propertyId:other.properties[0].id,...day},{db})).rejects.toBeInstanceOf(OwnerLedgerAccessError);
    const scoped=await reader(f);await expect(getOwnerLedger(scoped.ctx,{ownerId:f.owner.id,propertyId:f.properties[2].id,...day},{db})).rejects.toBeInstanceOf(OwnerLedgerAccessError);
    expect((await listOwnerLedgerChoices(ctx,{}, {db})).owners).toEqual([{id:f.owner.id,name:f.owner.displayName,propertyId:f.properties[0].id,propertyName:f.properties[0].name}]);
  });
  it("preserves archived-owner history and original financial row versions",async()=>{
    const f=await fixture(),{ctx}=await reader(f);await journal(f,"2026-03-08T07:00:00Z","0.99",{bucket:"ADJUSTMENT"});await withTenant(db,f.org,tx=>tx.owner.update({where:{id:f.owner.id},data:{archivedAt:new Date()}}));
    const facts=()=>withTenant(db,f.org,async tx=>JSON.stringify(await tx.$queryRaw(Prisma.sql`SELECT id,xmin::text AS row_version,to_jsonb(financial_transaction) AS row FROM financial_transaction WHERE organization_id=${f.org}::uuid ORDER BY id`)));
    const before=await facts(),result=await getOwnerLedger(ctx,{ownerId:f.owner.id,...day},{db});expect(result.owner.archived).toBe(true);expect(result.closingBalance).toBe("0.99");expect(result.bucketTotals).toContainEqual({bucket:"ADJUSTMENT",credits:"0.99",debits:"0.00",net:"0.99"});expect(await facts()).toBe(before);
  });
  it("retains the existing generator's rejection of an unrecognized ledger bucket",async()=>{
    const f=await fixture(),{ctx}=await reader(f);await journal(f,"2026-03-08T07:00:00Z","0.99",{bucket:"DEDICATED_UNRECOGNIZED_BUCKET"});
    await expect(getOwnerLedger(ctx,{ownerId:f.owner.id,...day},{db})).rejects.toThrow(/unsupported bucket/iu);expect(await withTenant(db,f.org,tx=>tx.financialTransaction.count())).toBe(1);
  });
  it("retains historical property selection when the original ownership link is absent",async()=>{
    const f=await fixture(),{ctx}=await reader(f);await journal(f,"2026-03-08T07:00:00Z","15",{propertyId:f.properties[2].id});
    const result=await getOwnerLedger(ctx,{ownerId:f.owner.id,propertyId:f.properties[2].id,...day},{db});expect(result.closingBalance).toBe("15.00");expect(result.properties).toContainEqual({id:f.properties[2].id,name:f.properties[2].name});
  });
  it("finds the authorized owner beyond 500 denied predecessors without publishing their names",async()=>{
    const f=await fixture(),{ctx}=await reader(f);await withTenant(db,f.org,tx=>tx.owner.createMany({data:Array.from({length:500},()=>({id:`00000000-${randomUUID().slice(9)}`,organizationId:f.org,displayName:"Restricted unrelated owner metadata"}))}));
    const result=await listOwnerLedgerChoices(ctx,{}, {db});expect(result.owners).toEqual([{id:f.owner.id,name:f.owner.displayName}]);expect(result.next).toBeUndefined();expect(JSON.stringify(result)).not.toContain("Restricted unrelated owner metadata");
  });
  it("uses the current Moroccan calendar at midnight even when PostgreSQL carries older timezone data",async()=>{
    const f=await fixture(),{ctx}=await reader(f);
    await journal(f,"2026-11-01T23:30:00Z","777.77");await journal(f,"2026-11-02T00:00:00Z","100.25");
    await journal(f,"2026-11-02T23:59:59.999999Z","0.01");await journal(f,"2026-11-03T00:00:00Z","999.99");
    const result=await getOwnerLedger(ctx,{ownerId:f.owner.id,fromOn:"2026-11-02",toOn:"2026-11-02",timezone:"Africa/Casablanca",currency:"MAD"},{db});
    expect(result.openingBalance).toBe("777.77");expect(result.periodCredits).toBe("100.26");expect(result.closingBalance).toBe("878.03");expect(result.lines).toHaveLength(2);
    await withTenant(db,f.org,async tx=>{
      const repository=new OwnerLedgerRepository(tx,f.org);
      expect(await repository.range("2026-11-02","2026-11-02","Africa/Casablanca")).toEqual({startsAt:new Date("2026-11-02T00:00:00Z"),endsAt:new Date("2026-11-03T00:00:00Z")});
      expect(await repository.defaults(new Date("2026-10-31T23:30:00Z"),"Africa/Casablanca")).toEqual({fromOn:"2026-10-01",toOn:"2026-10-31"});
    });
  });

  it("uses one PostgreSQL snapshot while another real journal commits between scope and posting reads",async()=>{
    const f=await fixture(),{ctx}=await reader(f);await journal(f,"2026-03-08T07:00:00Z","1");let observed!:()=>void,release!:()=>void;
    const reached=new Promise<void>(resolve=>observed=resolve),gate=new Promise<void>(resolve=>release=resolve);
    const original=Object.getOwnPropertyDescriptor(OwnerLedgerRepository.prototype,"range")?.value as OwnerLedgerRepository["range"];
    const spy=vi.spyOn(OwnerLedgerRepository.prototype,"range").mockImplementation(async function(this:OwnerLedgerRepository,...args){const result=await original.apply(this,args);observed();await gate;return result});
    const reading=getOwnerLedger(ctx,{ownerId:f.owner.id,...day},{db});
    try{await reached;await journal(f,"2026-03-08T07:00:01Z","1");release();const result=await reading;expect(result.closingBalance).toBe("1.00");expect(result.lines).toHaveLength(1);expect(result.rowCount).toBe("1");}
    finally{release();spy.mockRestore();await reading.catch(()=>undefined)}
    expect((await getOwnerLedger(ctx,{ownerId:f.owner.id,...day},{db})).closingBalance).toBe("2.00");
  });
});
