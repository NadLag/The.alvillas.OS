import {randomUUID} from "node:crypto";
import {expect,test} from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {withTenant} from "@/platform/db/tenant";
import {authContextForAccount} from "@/platform/authz/account-context";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {Money} from "@/platform/money/money";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {assignTeamRole,saveTeamCompensation} from "@/modules/identity/application/team-service";
import {FinanceRepository} from "@/modules/finance/infrastructure/finance-repository";
import {createEmployeePercentageCompensationRun} from "@/modules/finance/application/employee-percentage-run-service";
import {submitEmployeeCompensation,getEmployeeCompensationSubmission} from "@/modules/finance/application/employee-compensation-submission";
import {recognizeEmployeeCompensation} from "@/modules/finance/application/employee-compensation-recognition";
import {decideApproval} from "@/platform/approvals/approval-service";
import {formatCurrencyAmount} from "@/i18n/format";
import {openFieldFixture} from "./support/field-fixture";
import en from "../../messages/en.json" with {type:"json"};
import fr from "../../messages/fr.json" with {type:"json"};
import ar from "../../messages/ar.json" with {type:"json"};
test.use({serviceWorkers:"allow",timezoneId:"America/Denver",actionTimeout:30000,navigationTimeout:60000});
for(const locale of["en","fr","ar"] as const)test(`Native original percentage sources remain private and accessible across every financial panel in ${locale}`,async({page,browser},info)=>{
 test.skip(!process.env.DATABASE_URL,"Real local PostgreSQL required");test.setTimeout(180000);
 const f=await openFieldFixture(page,info,locale),messages={en,fr,ar}[locale].CompensationRuns,origin=new URL(page.url()).origin,anonymous=await browser.newContext({baseURL:origin,storageState:{cookies:[],origins:[]}});
 try{
  const source=await withTenant(f.db,f.organizationId,async tx=>{const task=await tx.operationTask.findUniqueOrThrow({where:{id:f.taskId}}),account=await tx.userAccount.findUniqueOrThrow({where:{id:task.assignedToUserAccountId!}}),role=await tx.role.create({data:{organizationId:f.organizationId,key:"native_percentage_"+randomUUID(),name:"Actual original posted percentage earnings"}});return{account,role};});
  const actor={organizationId:f.organizationId,actorId:source.account.id,personId:source.account.personId,authContext:{...await authContextForAccount(f.organizationId,source.account.id,{db:f.db}),personId:source.account.personId}},assignment=await assignTeamRole(actor,{personId:source.account.personId,roleId:source.role.id,scopeType:"organization",scopeId:null,validFrom:"2020-01-01",validTo:null,assignedToMe:false,reason:"Actual original native posted-income contract"},{db:f.db});
  await saveTeamCompensation(actor,{assignmentId:assignment.id,expectedVersion:0,mode:"PERCENTAGE",amount:"6.50",currency:"MAD",effectiveFrom:"2020-01-01",reason:"Actual original native percentage contractual rate"},{db:f.db});
  const now=await withTenant(f.db,f.organizationId,tx=>new FinanceRepository(tx,f.organizationId).clock()),on=new Date(now.getTime()-86400000).toISOString().slice(0,10),occurredAt=new Date(on+"T12:00:00Z");
  const bases=await withTenant(f.db,f.organizationId,async tx=>{
   if(!await tx.organizationProfile.findFirst({where:{organizationId:f.organizationId}}))await tx.organizationProfile.create({data:{organizationId:f.organizationId,brandName:"Native original percentage company",timezone:"UTC"}});
   const rules=new ConfigRuleRepository(tx,f.organizationId);for(const[key,value]of Object.entries({"staff.compensation_percentage_earnings":{evidence:"IMMUTABLE_POSTED_FINANCIAL_BASES",base_buckets:["PERCENTAGE_NATIVE"],base_side:"CREDIT",rate_selection:"AT_ACTUAL_BASE_INSTANT",rounding:"HALF_UP_AT_EARNING_TOTAL"},"staff.compensation_percentage_runs":{earning_date:"ACTUAL_POSTED_FINANCIAL_BASE",earning_unit:"PERSON_ASSIGNMENT_SELECTED_POSTINGS",timezone:"UTC",max_period_days:31},"finance.expense_treatment":{default_treatment:"ALVILLAS_PAID"},"finance.approval_thresholds":{thresholds:[{key:"native_percentage_review",amount:"0.01",currency:"MAD",requires_approval_from:["finance"]}],routing:{finance:{people:[source.account.personId],roles:[],assigned:false,channels:["in_app"]}}},"finance.accounting_periods":{timezone:"UTC",allow_early_close:false,max_reopen_seconds:60}}))await rules.createVersion({key,scopeType:"organization",effectiveFrom:new Date("2020-01-01"),value,reason:"Actual native original percentage earning and financial policy"});
   const finance=new FinanceRepository(tx,f.organizationId),bank=await finance.ensureLedgerAccount({code:"NATIVE_PERCENTAGE_BANK",name:"Actual native original receipt bank",accountType:"ASSET_LOCATION",normalSide:"DEBIT"}),income=await finance.ensureLedgerAccount({code:"NATIVE_PERCENTAGE_INCOME",name:"Actual native original posted income",accountType:"ALVILLAS_OWN",normalSide:"CREDIT"}),bases:Array<{postingId:string;assignmentId:string}>=[];
   for(let index=0;index<26;index++){
    const amount=Money.of("100.00","MAD"),journal=await finance.createFinancialTransaction({reference:"NATIVE-ORIGINAL-PERCENTAGE:"+randomUUID(),description:"Actual original native posted contractual income",occurredAt,idempotencyKey:randomUUID(),createdBy:actor.actorId,postings:[{ledgerAccountId:bank.id,side:"DEBIT",amount,bucket:"PERCENTAGE_NATIVE",dimensions:{}},{ledgerAccountId:income.id,side:"CREDIT",amount,bucket:"PERCENTAGE_NATIVE",dimensions:{}}]});
    await writeAuditEvent(tx,{organizationId:f.organizationId,actorId:actor.actorId,action:"finance.transaction.created",resourceType:"financial_transaction",resourceId:journal.id,after:{transactionId:journal.id,amount:amount.toJSON()},reason:"Retain attributed actual native original posted income",requestId:randomUUID(),occurredAt:await finance.clock()});bases.push({postingId:journal.postings.find(row=>row.side==="CREDIT")!.id,assignmentId:assignment.id});
   }return bases;
  });
  const run=await createEmployeePercentageCompensationRun(actor,{fromOn:on,toOn:on,currency:"MAD",purpose:"Native original posted percentage earnings",reason:"Retain actual original posted bases and exact effective contractual rate",idempotencyKey:randomUUID(),bases},{db:f.db});expect(run.total).toEqual({amount:"169.00",currency:"MAD"});
  const submitted=await submitEmployeeCompensation(actor,{runId:run.id,costOn:now.toISOString().slice(0,10),emergency:false,idempotencyKey:randomUUID(),reason:"Review actual native original percentage financial costs",costs:run.lines.map(line=>({runLineId:line.id,category:"salary",costCenter:null,note:"Actual original posted earning and contract"}))},{db:f.db}),stage=await withTenant(f.db,f.organizationId,tx=>tx.approvalStage.findFirstOrThrow({where:{approvalId:submitted.approvalId!}}));
  await decideApproval({organizationId:f.organizationId,accountId:actor.actorId,authContext:actor.authContext},{id:submitted.approvalId,stageId:stage.id,decision:"APPROVED",reason:"Approve actual native original percentage cost"},{db:f.db});const claimId=(await getEmployeeCompensationSubmission(actor,{id:submitted.id},{db:f.db})).costs[0].claimId;
  await recognizeEmployeeCompensation(actor,{id:submitted.id,claimId,idempotencyKey:randomUUID(),currentPeriod:false,reason:"Recognize actual original native percentage employee ownership"},{db:f.db});
  const routes=[`/${locale}/app/finance/compensation/${run.id}`,`/${locale}/app/finance/compensation/proposals/${submitted.id}`,`/${locale}/app/finance/compensation/proposals/${submitted.id}/claims/${claimId}`,`/${locale}/app/finance/compensation/proposals/${submitted.id}/claims/${claimId}/payments`];
  expect((await anonymous.request.get(`/api/finance/compensation/runs/${run.id}/detail`)).status()).toBe(401);expect((await anonymous.request.get(`/api/finance/compensation/submissions/${submitted.id}/detail`)).status()).toBe(401);
  for(const route of routes){
   await page.goto(route);const panel=page.getByTestId("compensation-percentage-evidence");await expect(panel).toBeVisible();await expect(panel.getByTestId("compensation-percentage-base-total")).toHaveText(formatCurrencyAmount(locale,"2600.00","MAD"));await expect(panel.getByTestId("compensation-percentage-earned-total")).toHaveText(formatCurrencyAmount(locale,"169.00","MAD"));await expect(panel.locator("ol > li")).toHaveCount(25);
   const next=panel.getByRole("button",{name:messages.percentageNext,exact:true});await next.focus();await next.press("Enter");await expect(panel.locator("ol > li")).toHaveCount(1);await panel.getByRole("button",{name:messages.percentagePrevious,exact:true}).click();await expect(panel.locator("ol > li")).toHaveCount(25);
   expect((await new AxeBuilder({page}).include('[data-testid="compensation-percentage-evidence"]').analyze()).violations).toEqual([]);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
   await page.context().setOffline(true);await expect(panel).toHaveCount(0);await page.context().setOffline(false);await expect(panel).toBeVisible();
  }
  expect(await withTenant(f.db,f.organizationId,tx=>tx.employeeCompensationPercentageWitness.count({where:{runLineId:run.lines[0].id}}))).toBe(52);
 }finally{await anonymous.close();await f.db.$disconnect();}
});
