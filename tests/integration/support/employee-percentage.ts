import {randomUUID} from "node:crypto";
import type {PrismaClient} from "@prisma/client";
import {withTenant,type TenantTransactionRunner} from "@/platform/db/tenant";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {Money} from "@/platform/money/money";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {FinanceRepository} from "@/modules/finance/infrastructure/finance-repository";
import {assignTeamRole} from "@/modules/identity/application/team-service";
import {employeeCompensationFixtures} from "./employee-compensation";

export function employeePercentageFixtures(getDb:()=>TenantTransactionRunner,getAdmin:()=>Pick<PrismaClient,"organization">){
 const roles=employeeCompensationFixtures(getDb,getAdmin);
 async function fixture(){
  const f=await roles.fixture();await roles.rate(f,"PERCENTAGE","6.50");const actor=await roles.reader(f,{permissions:["employee_payable:view","employee_payable:create","employee_payable:void","staff_compensation:view","financial_transaction:view","audit_log:view"]});
  await withTenant(getDb(),f.org,async tx=>{const rules=new ConfigRuleRepository(tx,f.org);await rules.createVersion({key:"staff.compensation_percentage_earnings",scopeType:"organization",effectiveFrom:new Date("2020-01-01"),value:{evidence:"IMMUTABLE_POSTED_FINANCIAL_BASES",base_buckets:["PERCENTAGE_ACCEPTANCE"],base_side:"CREDIT",rate_selection:"AT_ACTUAL_BASE_INSTANT",rounding:"HALF_UP_AT_EARNING_TOTAL"},reason:"Actual retained original percentage earning policy"});await rules.createVersion({key:"staff.compensation_percentage_runs",scopeType:"organization",effectiveFrom:new Date("2020-01-01"),value:{earning_date:"ACTUAL_POSTED_FINANCIAL_BASE",earning_unit:"PERSON_ASSIGNMENT_SELECTED_POSTINGS",timezone:"Africa/Casablanca",max_period_days:31},reason:"Actual configured original posted earning calendar"});});
  return{...f,actor:actor.ctx,grant:actor.grant};
 }
 type Fixture=Awaited<ReturnType<typeof fixture>>;
 async function posting(f:Fixture,options:{amount?:string;occurredAt?:Date;dimensions?:Record<string,string>}={}){
  return withTenant(getDb(),f.org,async tx=>{const finance=new FinanceRepository(tx,f.org),bank=await finance.ensureLedgerAccount({code:"PERCENTAGE_ACTUAL_BANK",name:"Actual original posted receipt location",accountType:"ASSET_LOCATION",normalSide:"DEBIT"}),income=await finance.ensureLedgerAccount({code:"PERCENTAGE_ACTUAL_INCOME",name:"Actual original posted company income",accountType:"ALVILLAS_OWN",normalSide:"CREDIT"}),amount=Money.of(options.amount??"1234.56","MAD"),dimensions=options.dimensions??{property_id:f.property.id};
   const journal=await finance.createFinancialTransaction({reference:"PERCENTAGE-BASE:"+randomUUID(),description:"Actual original posted contractual income base",occurredAt:options.occurredAt??new Date("2026-10-01T12:00:00Z"),idempotencyKey:randomUUID(),createdBy:f.account.id,postings:[{ledgerAccountId:bank.id,side:"DEBIT",amount,bucket:"PERCENTAGE_ACCEPTANCE",dimensions},{ledgerAccountId:income.id,side:"CREDIT",amount,bucket:"PERCENTAGE_ACCEPTANCE",dimensions}]});
   await writeAuditEvent(tx,{organizationId:f.org,actorId:f.account.id,action:"finance.transaction.created",resourceType:"financial_transaction",resourceId:journal.id,after:{transactionId:journal.id,amount:amount.toJSON()},reason:"Retain the attributed actual original financial source",requestId:randomUUID(),occurredAt:await finance.clock()});
   return{journal,source:journal.postings.find(row=>row.side==="CREDIT")!};
  });
 }
 function input(f:Fixture,ids:readonly string[]){return{fromOn:"2026-10-01",toOn:"2026-10-31",currency:"MAD",purpose:"Original posted percentage earnings",reason:"Retain actual original posted bases and effective contracts",idempotencyKey:randomUUID(),bases:ids.map(postingId=>({postingId,assignmentId:f.assignment.id}))};}
 async function financialFixture(){
  const f=await fixture(),assignment=await assignTeamRole(f.ctx,{personId:f.staff.id,roleId:f.role.id,scopeType:"organization",scopeId:null,validFrom:"2020-01-01",validTo:null,assignedToMe:false,reason:"Actual original percentage company financial contract"},{db:getDb()});await roles.rate(f,"PERCENTAGE","6.50",0,"2020-01-01",assignment.id);
  const writer=await roles.reader(f,{permissions:["employee_payable:view","employee_payable:create","employee_payable:edit","employee_payable:pay","employee_payable:void","staff_compensation:view","financial_transaction:view","financial_transaction:create","financial_transaction:pay","financial_transaction:void","expense:view","expense:approve","expense:reject","audit_log:view"]});
  await withTenant(getDb(),f.org,async tx=>{await tx.organizationProfile.create({data:{organizationId:f.org,brandName:"Actual original percentage financial acceptance",timezone:"UTC"}});const rules=new ConfigRuleRepository(tx,f.org);for(const[key,value]of Object.entries({"finance.expense_treatment":{default_treatment:"ALVILLAS_PAID"},"finance.approval_thresholds":{thresholds:[{key:"actual_percentage_review",amount:"0.01",currency:"MAD",requires_approval_from:["finance"]}],routing:{finance:{people:[f.person.id],roles:[],assigned:false,channels:["in_app"]}}},"finance.accounting_periods":{timezone:"UTC",allow_early_close:false,max_reopen_seconds:60}}))await rules.createVersion({key,scopeType:"organization",effectiveFrom:new Date("2020-01-01"),value,reason:"Actual configured original percentage financial review and calendar"});});
  return{...f,assignment,writer,actor:{...writer.ctx,personId:f.person.id}};
 }
 return{fixture,financialFixture,posting,input,roles};
}
