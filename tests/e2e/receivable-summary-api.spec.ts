import {randomUUID} from "node:crypto";
import {expect,test} from "@playwright/test";
import {withTenant} from "@/platform/db/tenant";
import {Money} from "@/platform/money/money";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {FinanceRepository} from "@/modules/finance/infrastructure/finance-repository";
import {receivablePolicyKey} from "@/modules/finance/domain/receivable";
import {openFieldFixture} from "./support/field-fixture";

test.use({serviceWorkers:"allow",actionTimeout:30000,navigationTimeout:60000});
for(const locale of["en","fr","ar"] as const)test(`Authenticated original receivable summary retains exact movements and private current authority in ${locale}`,async({page,browser},info)=>{
  test.skip(!process.env.DATABASE_URL,"Real local PostgreSQL required");test.setTimeout(180000);
  const f=await openFieldFixture(page,info,locale),origin=new URL(page.url()).origin,marker=randomUUID().replaceAll("-","").toUpperCase(),code="RECEIVABLE_NATIVE_"+marker;
  try{
    const source=await withTenant(f.db,f.organizationId,async tx=>{
      const task=await tx.operationTask.findUniqueOrThrow({where:{id:f.taskId}}),actor=await tx.userAccount.findUniqueOrThrow({where:{id:task.assignedToUserAccountId!}}),finance=new FinanceRepository(tx,f.organizationId),claim=await finance.ensureLedgerAccount({code,name:"Actual original ownership claim",accountType:"CLAIM_OWNERSHIP",normalSide:"DEBIT"}),counterpart=await finance.ensureLedgerAccount({code:"RECEIVABLE_NATIVE_COUNTERPART_"+marker,name:"Actual original counterpart ownership",accountType:"CLAIM_OWNERSHIP",normalSide:"CREDIT"});
      const rule=await new ConfigRuleRepository(tx,f.organizationId).createVersion({key:receivablePolicyKey,scopeType:"organization",effectiveFrom:new Date("2020-01-01"),value:{source:"POSTED_OWNERSHIP_CLAIMS",account_codes:[code]},reason:"Explicit actual original ownership source for authenticated acceptance"});
      const journals=[];for(const[amount,side]of[["1234.56","DEBIT"],["33.33","CREDIT"]]as const){const result=await finance.createFinancialTransaction({reference:"RECEIVABLE-NATIVE:"+randomUUID(),description:"Original receivable source",occurredAt:new Date("2026-03-15T12:00:00Z"),idempotencyKey:randomUUID(),createdBy:actor.id,
        postings:[{ledgerAccountId:claim.id,side,amount:Money.of(amount,"MAD"),bucket:"RECEIVABLE_NATIVE",dimensions:{}},{ledgerAccountId:counterpart.id,side:side==="DEBIT"?"CREDIT":"DEBIT",amount:Money.of(amount,"MAD"),bucket:"RECEIVABLE_NATIVE",dimensions:{}}]});
        await writeAuditEvent(tx,{organizationId:f.organizationId,actorId:actor.id,action:"finance.transaction.created",resourceType:"financial_transaction",resourceId:result.id,after:{transactionId:result.id,amount:Money.of(amount,"MAD").toJSON()},reason:"Attribute original authenticated receivable source",requestId:randomUUID(),occurredAt:await finance.clock()});journals.push(result.id);}
      const grant=await tx.roleAssignment.findFirstOrThrow({where:{organizationId:f.organizationId,userAccountId:actor.id,scopeType:"organization",archivedAt:null,role:{key:"admin"}}});return{claim,rule,journals,grant};
    });
    const facts=()=>withTenant(f.db,f.organizationId,async tx=>({journals:await tx.financialTransaction.count(),postings:await tx.posting.count(),original:await tx.$queryRaw`SELECT to_jsonb(p) AS original,p.xmin::text AS version FROM posting p WHERE p.organization_id=${f.organizationId}::uuid AND p.ledger_account_id=${source.claim.id}::uuid ORDER BY p.id`})),before=await facts(),input={fromOn:"2026-03-01",toOn:"2026-03-31",timezone:"UTC",currency:"MAD"},headers={Origin:origin},path="/api/finance/receivables/summary";
    const response=await page.request.post(path,{headers,data:input});expect(response.status()).toBe(200);expect(response.headers()["cache-control"]).toBe("private, no-store");expect(response.headers().vary).toContain("Cookie");expect(await response.json()).toMatchObject({currency:"MAD",openingBalance:"0.00",periodDebits:"1234.56",periodCredits:"33.33",closingBalance:"1201.23",rowCount:"2",configRuleId:source.rule.id,accounts:[{id:source.claim.id,closingBalance:"1201.23"}]});
    expect((await page.request.post(path,{headers:{Origin:"https://different.example.test"},data:input})).status()).toBe(403);
    expect((await page.request.post(path,{headers,data:{...input,organizationId:randomUUID()}})).status()).toBe(400);
    expect((await page.request.post(path+"?organizationId="+randomUUID(),{headers,data:input})).status()).toBe(400);
    const anonymous=await browser.newContext({baseURL:origin});try{expect((await anonymous.request.post(path,{headers,data:input})).status()).toBe(401);}finally{await anonymous.close();}
    await withTenant(f.db,f.organizationId,async tx=>tx.roleAssignment.update({where:{id:source.grant.id},data:{validTo:await new FinanceRepository(tx,f.organizationId).clock()}}));
    const denied=await page.request.post(path,{headers,data:input});expect(denied.status()).toBe(403);expect(await denied.json()).toEqual({error:"forbidden"});expect(denied.headers()["cache-control"]).toBe("private, no-store");expect(await facts()).toEqual(before);
  }finally{await f.db.$disconnect();}
});
