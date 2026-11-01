import {randomUUID} from "node:crypto";
import {execFileSync} from "node:child_process";
import {PrismaClient} from "@prisma/client";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {withTenant} from "@/platform/db/tenant";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {Money} from "@/platform/money/money";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {assignTeamRole} from "@/modules/identity/application/team-service";
import {prepareEmployeePercentageSources} from "@/modules/finance/application/employee-percentage-source";
import {FinanceRepository} from "@/modules/finance/infrastructure/finance-repository";
import {EmployeeCompensationRunAccessError,EmployeeCompensationRunConflictError} from "@/modules/finance/domain/employee-compensation-run";
import {EmployeeCompensationSourceUnavailableError} from "@/modules/finance/domain/employee-compensation";
import {employeeCompensationFixtures} from "./support/employee-compensation";
import {provisionIntegrationRole} from "./support/database-role";

const url=process.env.TEST_DATABASE_URL;let admin:PrismaClient,db:PrismaClient;
const fixtures=employeeCompensationFixtures(()=>db,()=>admin),policy={evidence:"IMMUTABLE_POSTED_FINANCIAL_BASES",base_buckets:["PERCENTAGE_ACCEPTANCE"],base_side:"CREDIT",rate_selection:"AT_ACTUAL_BASE_INSTANT",rounding:"HALF_UP_AT_EARNING_TOTAL"};
async function fixture(){
 const f=await fixtures.fixture();await fixtures.rate(f,"PERCENTAGE","6.50");
 const actor=await fixtures.reader(f,{permissions:["employee_payable:view","employee_payable:create","staff_compensation:view","financial_transaction:view"]});
 await withTenant(db,f.org,tx=>new ConfigRuleRepository(tx,f.org).createVersion({key:"staff.compensation_percentage_earnings",scopeType:"organization",effectiveFrom:new Date("2020-01-01"),value:policy,reason:"Explicit actual retained percentage earning base acceptance"}));
 return{...f,actor:actor.ctx,grant:actor.grant};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function posting(f:Fixture,amount="1234.56",occurredAt=new Date("2026-10-01T12:00:00Z"),dimensions:Record<string,string>={property_id:f.property.id}){
 return withTenant(db,f.org,async tx=>{
  const finance=new FinanceRepository(tx,f.org),bank=await finance.ensureLedgerAccount({code:"PERCENTAGE_SOURCE_BANK",name:"Actual posted receipt location",accountType:"ASSET_LOCATION",normalSide:"DEBIT"}),income=await finance.ensureLedgerAccount({code:"PERCENTAGE_SOURCE_INCOME",name:"Actual posted contractual income base",accountType:"ALVILLAS_OWN",normalSide:"CREDIT"});
  const journal=await finance.createFinancialTransaction({reference:"PERCENTAGE-BASE:"+randomUUID(),description:"Actual posted source for original percentage contract",occurredAt,idempotencyKey:randomUUID(),createdBy:f.account.id,postings:[{ledgerAccountId:bank.id,side:"DEBIT",amount:Money.of(amount,"MAD"),bucket:"PERCENTAGE_ACCEPTANCE",dimensions},{ledgerAccountId:income.id,side:"CREDIT",amount:Money.of(amount,"MAD"),bucket:"PERCENTAGE_ACCEPTANCE",dimensions}]});
  return{journal,source:journal.postings.find(row=>row.side==="CREDIT")!};
 });
}
const input=(f:Fixture,postingIds:string[])=>({currency:"MAD",bases:postingIds.map(postingId=>({postingId,assignmentId:f.assignment.id}))});
async function originalFacts(org:string){return withTenant(db,org,async tx=>{
 const result:Record<string,unknown>={};for(const table of ["financial_transaction","posting","audit_log","employee_compensation_run","employee_compensation_claim","employee_compensation_cost"]){
  result[table]=await tx.$queryRawUnsafe('SELECT id::text AS id,md5(to_jsonb(t)::text||t.xmin::text) AS hash FROM "'+table+'" t ORDER BY id');
 }return result;
});}

describe.skipIf(!url)("actual posted percentage source preparation",()=>{
 beforeAll(async()=>{execFileSync(process.execPath,["node_modules/prisma/build/index.js","migrate","deploy"],{env:{...process.env,DATABASE_URL:url},stdio:"pipe"});admin=new PrismaClient({datasourceUrl:url});await provisionIntegrationRole(admin,"alvillas_ops_tests");const scoped=new URL(url!);scoped.username="alvillas_ops_tests";scoped.password="alvillas_ops_tests";db=new PrismaClient({datasourceUrl:scoped.toString()});});
 afterAll(async()=>{await db?.$disconnect();await admin?.$disconnect();});
 it("uses the actual original posting and contract with exact Money and zero source or financial mutations",async()=>{
  const f=await fixture(),base=await posting(f),before=await originalFacts(f.org);
  await withTenant(db,f.org,async tx=>{const prepared=await prepareEmployeePercentageSources(f.actor,input(f,[base.source.id]),tx);expect(prepared.amount).toEqual({amount:"80.25",currency:"MAD"});expect(prepared.lines[0].baseAmount.amount).toBe("1234.56");expect(prepared.lines[0].sources[0]).toMatchObject({postingId:base.source.id,scope:{propertyId:f.property.id}});expect(prepared.lines[0].sources[0].compensationId).toMatch(/^[a-f0-9-]{36}$/u);await prepared.recheck();});
  expect(await originalFacts(f.org)).toEqual(before);
 });
 it("rounds actual bases together once rather than rounding each posting",async()=>{
  const f=await fixture(),first=await posting(f,"0.07"),second=await posting(f,"0.07");
  const prepared=await withTenant(db,f.org,tx=>prepareEmployeePercentageSources(f.actor,input(f,[first.source.id,second.source.id]),tx));expect(prepared.amount.amount).toBe("0.01");expect(prepared.lines[0].baseAmount.amount).toBe("0.14");
 });
 it("retains original effective rates on independently dated posted bases",async()=>{
  const f=await fixture(),first=await posting(f);await fixtures.rate(f,"PERCENTAGE","7.25",1,"2026-10-15");const second=await posting(f,"1234.56",new Date("2026-10-20T12:00:00Z"));
  const prepared=await withTenant(db,f.org,tx=>prepareEmployeePercentageSources(f.actor,input(f,[first.source.id,second.source.id]),tx));expect(prepared.amount.amount).toBe("169.75");expect(prepared.lines[0].sources.map(row=>row.rate.toJSON().amount).sort()).toEqual(["6.50","7.25"]);
 });
 it("denies a foreign posting even when its UUID is known",async()=>{const f=await fixture(),foreign=await fixture(),base=await posting(foreign);await expect(withTenant(db,f.org,tx=>prepareEmployeePercentageSources(f.actor,input(f,[base.source.id]),tx))).rejects.toBeInstanceOf(EmployeeCompensationSourceUnavailableError);});
 it("denies an actual base outside the retained employee assignment scope",async()=>{const f=await fixture(),other=await withTenant(db,f.org,tx=>tx.property.create({data:{organizationId:f.org,name:"Other actual property",addressLine1:"Actual other address",city:"Other city",propertyType:"VILLA",bedrooms:1,bathrooms:1,maxGuests:2,amenities:[],photoUrls:[]}})),base=await posting(f,"100.00",undefined,{property_id:other.id});await expect(withTenant(db,f.org,tx=>prepareEmployeePercentageSources(f.actor,input(f,[base.source.id]),tx))).rejects.toBeInstanceOf(EmployeeCompensationSourceUnavailableError);});
 it("denies missing held financial-base access before returning private earnings",async()=>{const f=await fixture(),base=await posting(f),actor={...f.actor,authContext:{...f.actor.authContext,assignments:f.actor.authContext.assignments!.map(assignment=>({...assignment,permissions:new Set([...assignment.permissions].filter(key=>key!=="financial_transaction:view"))}))}};await expect(withTenant(db,f.org,tx=>prepareEmployeePercentageSources(actor,input(f,[base.source.id]),tx))).rejects.toBeInstanceOf(EmployeeCompensationRunAccessError);});
 it("denies stale authority after the actual stored financial grant expires",async()=>{const f=await fixture(),base=await posting(f);await withTenant(db,f.org,tx=>tx.roleAssignment.update({where:{id:f.grant.id},data:{validTo:new Date("2020-01-02")}}));await expect(withTenant(db,f.org,tx=>prepareEmployeePercentageSources(f.actor,input(f,[base.source.id]),tx))).rejects.toBeInstanceOf(EmployeeCompensationRunAccessError);});
 it("applies held amount limits to the complete original financial journal",async()=>{const f=await fixture(),base=await posting(f),actor={...f.actor,authContext:{...f.actor.authContext,assignments:f.actor.authContext.assignments!.map(assignment=>({...assignment,conditions:{...assignment.conditions,maxAmount:"100.00"}}))}};await expect(withTenant(db,f.org,tx=>prepareEmployeePercentageSources(actor,input(f,[base.source.id]),tx))).rejects.toBeInstanceOf(EmployeeCompensationRunAccessError);});
 it("detects original policy changes in the before-commit recheck",async()=>{const f=await fixture(),base=await posting(f);await withTenant(db,f.org,async tx=>{const prepared=await prepareEmployeePercentageSources(f.actor,input(f,[base.source.id]),tx);await new ConfigRuleRepository(tx,f.org).createVersion({key:"staff.compensation_percentage_earnings",scopeType:"organization",effectiveFrom:new Date("2026-10-02"),value:policy,reason:"New original percentage policy version before actual final fence"});await expect(prepared.recheck()).rejects.toBeInstanceOf(EmployeeCompensationRunConflictError);});});
 it("denies a base whose actual original journal has been reversed",async()=>{
  const f=await fixture(),base=await posting(f);await withTenant(db,f.org,async tx=>{const reversal=await new FinanceRepository(tx,f.org).createFinancialTransaction({reference:base.journal.reference+":VOID",description:"Actual opposite posted source correction",occurredAt:new Date("2026-10-02T12:00:00Z"),idempotencyKey:randomUUID(),createdBy:f.account.id,reversesTransactionId:base.journal.id,postings:base.journal.postings.map(row=>({ledgerAccountId:row.ledgerAccountId,side:row.side==="DEBIT"?"CREDIT" as const:"DEBIT" as const,amount:Money.of(row.amount.toString(),row.currency),bucket:row.bucket!,dimensions:{property_id:f.property.id}}))});await writeAuditEvent(tx,{organizationId:f.org,actorId:f.account.id,action:"finance.transaction.reversed",resourceType:"financial_transaction",resourceId:base.journal.id,after:{transactionId:base.journal.id,reversalTransactionId:reversal.id},reason:"Reverse the actual original percentage source with exact opposite movements",requestId:randomUUID(),occurredAt:await new FinanceRepository(tx,f.org).clock()});});
  await expect(withTenant(db,f.org,tx=>prepareEmployeePercentageSources(f.actor,input(f,[base.source.id]),tx))).rejects.toBeInstanceOf(EmployeeCompensationSourceUnavailableError);
 });
 it("denies an unresolved actual posting dimension rather than granting its claimed scope",async()=>{const f=await fixture(),base=await posting(f,"100.00",undefined,{property_id:randomUUID()});await expect(withTenant(db,f.org,tx=>prepareEmployeePercentageSources(f.actor,input(f,[base.source.id]),tx))).rejects.toBeInstanceOf(EmployeeCompensationSourceUnavailableError);});
 it("denies operational authority without the private contractual salary permission",async()=>{const f=await fixture(),base=await posting(f),actor={...f.actor,authContext:{...f.actor.authContext,assignments:f.actor.authContext.assignments!.map(assignment=>({...assignment,permissions:new Set([...assignment.permissions].filter(key=>key!=="staff_compensation:view"))}))}};await expect(withTenant(db,f.org,tx=>prepareEmployeePercentageSources(actor,input(f,[base.source.id]),tx))).rejects.toBeInstanceOf(EmployeeCompensationRunAccessError);});
 it("rejects entered amounts and replacement financial scope facts",async()=>{const f=await fixture(),base=await posting(f);await expect(withTenant(db,f.org,tx=>prepareEmployeePercentageSources(f.actor,{...input(f,[base.source.id]),baseAmount:"0.01",propertyId:f.property.id},tx))).rejects.toThrow();});
 it("keeps source fingerprints deterministic across input order",async()=>{const f=await fixture(),first=await posting(f),second=await posting(f,"2.00");const a=await withTenant(db,f.org,tx=>prepareEmployeePercentageSources(f.actor,input(f,[first.source.id,second.source.id]),tx)),b=await withTenant(db,f.org,tx=>prepareEmployeePercentageSources(f.actor,input(f,[second.source.id,first.source.id]),tx));expect(a.sourceFingerprint).toBe(b.sourceFingerprint);});
 it("prepares 500 actual posted property bases through bounded source reads without rewriting history",async()=>{
  const f=await fixture(),assignment=await assignTeamRole(f.ctx,{personId:f.staff.id,roleId:f.role.id,scopeType:"organization",scopeId:null,validFrom:"2020-01-01",validTo:null,assignedToMe:false,reason:"Actual company-wide percentage contract for the retained property portfolio"},{db});await fixtures.rate(f,"PERCENTAGE","6.50",0,"2020-01-01",assignment.id);
  const bases=await withTenant(db,f.org,async tx=>{
   const properties=await tx.property.createManyAndReturn({data:Array.from({length:500},(_,index)=>({organizationId:f.org,name:"Actual posted percentage property "+index,addressLine1:"Actual portfolio source",city:"Portfolio city",propertyType:"VILLA",bedrooms:1,bathrooms:1,maxGuests:2,amenities:[],photoUrls:[]}))}),finance=new FinanceRepository(tx,f.org),bank=await finance.ensureLedgerAccount({code:"PERCENTAGE_PORTFOLIO_BANK",name:"Actual portfolio receipt location",accountType:"ASSET_LOCATION",normalSide:"DEBIT"}),income=await finance.ensureLedgerAccount({code:"PERCENTAGE_PORTFOLIO_INCOME",name:"Actual portfolio income base",accountType:"ALVILLAS_OWN",normalSide:"CREDIT"});
   const journals=await finance.createFinancialTransactions(properties.map(property=>({reference:"PERCENTAGE-PORTFOLIO:"+property.id,description:"Actual posted portfolio income base",occurredAt:new Date("2026-10-01T12:00:00Z"),idempotencyKey:randomUUID(),createdBy:f.account.id,postings:[{ledgerAccountId:bank.id,side:"DEBIT" as const,amount:Money.of("0.07","MAD"),bucket:"PERCENTAGE_ACCEPTANCE",dimensions:{property_id:property.id}},{ledgerAccountId:income.id,side:"CREDIT" as const,amount:Money.of("0.07","MAD"),bucket:"PERCENTAGE_ACCEPTANCE",dimensions:{property_id:property.id}}]})),async()=>{});
   const originals=await tx.posting.findMany({where:{organizationId:f.org,transactionId:{in:journals.map(journal=>journal.id)},side:"CREDIT"},orderBy:{id:"asc"},select:{id:true}});
   return originals.map(row=>({postingId:row.id,assignmentId:assignment.id}));
  });
  const before=await originalFacts(f.org),started=performance.now(),prepared=await withTenant(db,f.org,tx=>prepareEmployeePercentageSources(f.actor,{currency:"MAD",bases},tx)),elapsed=performance.now()-started;
  expect(prepared.amount.amount).toBe("2.28");expect(prepared.lines).toHaveLength(1);expect(prepared.lines[0].baseAmount.amount).toBe("35.00");expect(prepared.lines[0].sources).toHaveLength(500);expect(new Set(prepared.lines[0].sources.map(row=>row.scope.propertyId)).size).toBe(500);expect(await originalFacts(f.org)).toEqual(before);
  console.info(JSON.stringify({actualPercentageProperties:500,actualPostedBases:500,sourcePreparationMilliseconds:Math.round(elapsed),originalFinancialAndAuditHistoriesUnchanged:true}));
 });
 it("fails closed for an actual posted instant that JavaScript cannot retain exactly",async()=>{
  const f=await fixture(),base=await posting(f),journalId=randomUUID(),source=await withTenant(db,f.org,async tx=>{
   await tx.$executeRaw`INSERT INTO financial_transaction(id,organization_id,reference,occurred_at,description,idempotency_key,created_by,sealed)
    SELECT ${journalId}::uuid,organization_id,${"PERCENTAGE-PRECISE:"+journalId},occurred_at+interval '1 microsecond',description,${randomUUID()},created_by,sealed FROM financial_transaction WHERE organization_id=${f.org}::uuid AND id=${base.journal.id}::uuid`;
   await tx.posting.createMany({data:base.journal.postings.map(row=>({organizationId:f.org,transactionId:journalId,ledgerAccountId:row.ledgerAccountId,side:row.side,amount:row.amount,currency:row.currency,bucket:row.bucket,dimensions:{property_id:f.property.id}}))});
   return tx.posting.findFirstOrThrow({where:{organizationId:f.org,transactionId:journalId,side:"CREDIT"}});
  });
  await expect(withTenant(db,f.org,tx=>prepareEmployeePercentageSources(f.actor,input(f,[source.id]),tx))).rejects.toBeInstanceOf(EmployeeCompensationSourceUnavailableError);
 });
});
