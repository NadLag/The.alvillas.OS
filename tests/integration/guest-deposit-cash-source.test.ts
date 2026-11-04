import {randomUUID} from "node:crypto";
import {execFileSync} from "node:child_process";
import {PrismaClient} from "@prisma/client";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {withTenant} from "@/platform/db/tenant";
import {Money} from "@/platform/money/money";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {FinanceRepository} from "@/modules/finance/infrastructure/finance-repository";
import {actualServiceFixture} from "./support/service-allocation-fixture";
import {provisionIntegrationRole} from "./support/database-role";
const url=process.env.TEST_DATABASE_URL;let admin:PrismaClient,db:PrismaClient;
beforeAll(async()=>{const target=url?new URL(url):null;if(!target||!["127.0.0.1","localhost"].includes(target.hostname)||!(target.pathname.startsWith("/alvillas_automation_")||process.env.GITHUB_ACTIONS==="true"&&target.pathname==="/alvillas_os"))throw Error("Dedicated cash-source acceptance database required");execFileSync(process.execPath,["node_modules/prisma/build/index.js","migrate","deploy"],{env:{...process.env,DATABASE_URL:url},stdio:"pipe"});admin=new PrismaClient({datasourceUrl:url});await provisionIntegrationRole(admin,"alvillas_ops_tests");const scoped=new URL(url!);scoped.username="alvillas_ops_tests";scoped.password="alvillas_ops_tests";db=new PrismaClient({datasourceUrl:scoped.toString()});});
afterAll(async()=>{await db?.$disconnect();await admin?.$disconnect();});
type Fixture=Awaited<ReturnType<typeof actualServiceFixture>>;
const fixture=()=>actualServiceFixture(db,admin,false);
const originals=(f:Fixture)=>withTenant(db,f.org,tx=>tx.$queryRaw<Array<{kind:string;id:string;xmin:string;body:unknown}>>`SELECT 'journal' AS kind,id::text,xmin::text,to_jsonb(t) AS body FROM financial_transaction t WHERE organization_id=${f.org}::uuid UNION ALL SELECT 'posting',id::text,xmin::text,to_jsonb(p) FROM posting p WHERE organization_id=${f.org}::uuid UNION ALL SELECT 'audit',id::text,xmin::text,to_jsonb(a) FROM audit_log a WHERE organization_id=${f.org}::uuid ORDER BY kind,id`);
async function move(f:Fixture,amount:string,options:{collectionId?:string;omitSource?:boolean;credit?:boolean}={}){return withTenant(db,f.org,async tx=>{
 const finance=new FinanceRepository(tx,f.org),unallocated=await tx.ledgerAccount.findFirstOrThrow({where:{organizationId:f.org,code:"UNALLOCATED_COLLECTIONS"}}),claim=await finance.ensureLedgerAccount({code:"CASH_TEST_CLAIM",name:"Actual original source ownership test",accountType:"CLAIM_OWNERSHIP",normalSide:"CREDIT"}),value=Money.of(amount,"MAD"),dimensions=options.omitSource?{source:"CASH_SOURCE_TEST"}:{source:"CASH_SOURCE_TEST",cash_collection_id:options.collectionId??f.receipt.id},key=randomUUID(),row=await finance.createFinancialTransaction({reference:"CASH_SOURCE_TEST:"+key,description:"Actual original cash-source ownership allocation",occurredAt:await finance.clock(),idempotencyKey:key,createdBy:f.account.id,postings:[{ledgerAccountId:unallocated.id,side:options.credit?"CREDIT":"DEBIT",amount:value,bucket:"CASH_SOURCE_TEST",dimensions},{ledgerAccountId:claim.id,side:options.credit?"DEBIT":"CREDIT",amount:value,bucket:"CASH_SOURCE_TEST",dimensions}]});await writeAuditEvent(tx,{organizationId:f.org,actorId:f.account.id,action:"finance.cash_source_test.moved",resourceType:"financial_transaction",resourceId:row.id,after:{collectionId:options.collectionId??f.receipt.id},reason:"Actual original cash-source budget acceptance",requestId:key,occurredAt:await finance.clock()});return row.id;
 });}
describe("original cash-source ownership conservation",()=>{
 it("serializes partial ownership admissions against the one original receipt without changing physical custody or history",async()=>{
  const f=await fixture(),before=await originals(f);await move(f,"0.03");const competing=await Promise.allSettled([move(f,"0.04"),move(f,"0.04")]);expect(competing.filter(result=>result.status==="fulfilled")).toHaveLength(1);expect(competing.filter(result=>result.status==="rejected")).toHaveLength(1);const totals=await withTenant(db,f.org,tx=>tx.$queryRaw<Array<{code:string;amount:string}>>`SELECT a.code,sum(CASE p.side WHEN 'DEBIT' THEN p.amount ELSE -p.amount END)::text AS amount FROM posting p JOIN ledger_account a ON a.organization_id=p.organization_id AND a.id=p.ledger_account_id WHERE p.organization_id=${f.org}::uuid GROUP BY a.code ORDER BY a.code`);expect(totals.find(row=>row.code==="UNALLOCATED_COLLECTIONS")?.amount).toMatch(/^0(?:\.0+)?$/u);expect(totals.find(row=>row.code.startsWith("CASH_CUSTODY_"))?.amount).toBe("0.07");const keys=new Set(before.map(row=>row.kind+":"+row.id));expect((await originals(f)).filter(row=>keys.has(row.kind+":"+row.id))).toEqual(before);
 });
 it("rejects source-free, foreign, excessive and duplicate receipts without changing any original financial row",async()=>{
  const f=await fixture(),foreign=await fixture(),before=await originals(f),other=await originals(foreign);for(const[amount,options]of[["0.01",{omitSource:true}],["0.01",{collectionId:foreign.receipt.id}],["0.08",{}],["0.01",{credit:true}]]as const)await expect(move(f,amount,options)).rejects.toThrow(/cash_source_/u);expect(await originals(f)).toEqual(before);expect(await originals(foreign)).toEqual(other);
 });
});
