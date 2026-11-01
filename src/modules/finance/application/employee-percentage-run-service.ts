import type {Prisma} from "@prisma/client";
import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransaction,type TenantTransactionRunner} from "@/platform/db/tenant";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {Money} from "@/platform/money/money";
import {requireCurrentTimezoneData} from "@/platform/time/timezone-data";
import {employeePercentageRunCreateInput,employeePercentageRunPolicyKey,employeePercentageRunWindow} from "../domain/employee-percentage-run";
import {employeePostedJournalAmounts} from "../domain/employee-percentage-posted-base";
import {EmployeeCompensationRunConflictError,EmployeeCompensationRunPolicyError} from "../domain/employee-compensation-run";
import {EmployeeCompensationRunRepository} from "../infrastructure/employee-compensation-run-repository";
import {EmployeePercentageSourceRepository} from "../infrastructure/employee-percentage-source-repository";
import {FinanceRepository} from "../infrastructure/finance-repository";
import {prepareEmployeePercentageSources} from "./employee-percentage-source";
import {employeeCompensationRunFacts,recheckEmployeeCompensationRun} from "./employee-compensation-run-access";
import {employeeCompensationRunModel,persistEmployeeCompensationRun} from "./employee-compensation-run-service";
import {requireCompensationCreationIntent} from "./employee-compensation-creation-intent";
import type {FinanceActorContext} from "./finance-access";

const json=(value:unknown)=>JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
type RunInput=ReturnType<typeof employeePercentageRunCreateInput.parse>;
async function prepare(ctx:FinanceActorContext,input:RunInput,tx:TenantTransaction){
 requireCurrentTimezoneData();const rules=new ConfigRuleRepository(tx,ctx.organizationId),finance=new FinanceRepository(tx,ctx.organizationId),policy=await rules.resolve({key:employeePercentageRunPolicyKey,scopes:[{scopeType:"organization",scopeId:null}],asOf:await finance.clock()});
 if(!policy||policy.scopeType!=="organization"||policy.scopeId!==null)throw new EmployeeCompensationRunPolicyError();
 const window=employeePercentageRunWindow(input.fromOn,input.toOn,policy.parsedValue),database=await new EmployeeCompensationRunRepository(tx,ctx.organizationId).window(input.fromOn,input.toOn,window.policy.timezone);
 if(database.startsAt.getTime()!==window.startsAt.getTime()||database.endsAt.getTime()!==window.endsAt.getTime())throw new EmployeeCompensationRunPolicyError();
 const source=await prepareEmployeePercentageSources(ctx,{currency:input.currency,bases:input.bases},tx);
 if(source.lines.some(line=>line.sources.some(row=>row.earnedAt<window.startsAt||row.earnedAt>=window.endsAt)))throw new EmployeeCompensationRunPolicyError();
 const fingerprint=commandFingerprint({input,policy:{id:policy.id,version:policy.version,value:policy.value},sourceFingerprint:source.sourceFingerprint});
 return{policy,window,source,fingerprint};
}

/** Original posted earnings use the existing immutable run writer; recognition remains separately approved. */
export async function createEmployeePercentageCompensationRun(ctx:FinanceActorContext,raw:unknown,deps:{db?:TenantTransactionRunner;requestId?:string}={}){
 const input=employeePercentageRunCreateInput.parse(raw);input.bases.sort((a,b)=>a.postingId.localeCompare(b.postingId)||a.assignmentId.localeCompare(b.assignmentId));const fingerprint=commandFingerprint(input);
 return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
  const runs=new EmployeeCompensationRunRepository(tx,ctx.organizationId),finance=new FinanceRepository(tx,ctx.organizationId);await runs.lockKey(input.idempotencyKey);const existing=await runs.byKey(input.idempotencyKey);
  if(existing){await recheckEmployeeCompensationRun(ctx,tx,await finance.clock(),employeeCompensationRunFacts(ctx.organizationId,existing),"create");if(existing.earningKind!=="PERCENTAGE"||existing.createdBy!==ctx.actorId||existing.requestFingerprint!==fingerprint)throw new EmployeeCompensationRunConflictError();return{...employeeCompensationRunModel(ctx,existing),idempotent:true};}
  await requireCompensationCreationIntent(tx,ctx.organizationId,input.idempotencyKey,{actorId:ctx.actorId,earningKind:"PERCENTAGE",requestFingerprint:fingerprint});
  const prepared=await prepare(ctx,input,tx);await new EmployeePercentageSourceRepository(tx,ctx.organizationId).lockJournals(prepared.source.journals.map(journal=>journal.id));
  const recheck=async()=>{if((await prepare(ctx,input,tx)).fingerprint!==prepared.fingerprint)throw new EmployeeCompensationRunConflictError();};
  const retained=prepared.source.lines.map(line=>{
   const journals=[...new Map(line.sources.map(row=>[row.original.transaction.id,row.original.transaction])).values()].sort((a,b)=>a.id.localeCompare(b.id)),baseById=new Map(line.sources.map(row=>[row.postingId,row])),byJournal=new Map(line.sources.map(row=>[row.original.transaction.id,row]));
   const journalTotals=new Map(journals.map(journal=>[journal.id,employeePostedJournalAmounts(journal.postings)]));
   const witnesses=journals.flatMap(journal=>journal.postings.map(posting=>{
    const original=byJournal.get(journal.id)!,scope=prepared.source.journalScopes.get(posting.id)!;
    const journalAmount=journalTotals.get(journal.id)!.get(posting.currency)??Money.zero(posting.currency);
    return{data:{postingId:posting.id,compensationId:original.compensationId,configRuleId:original.configRuleId,policyRuleId:prepared.source.policy.id,isEarningBase:baseById.has(posting.id),journalAmount:journalAmount.toJSON().amount,
     propertyId:scope.propertyId??null,sourceCityId:scope.city??null,sourceRegionId:scope.region??null,reservationId:scope.reservationId??null,taskId:scope.taskId??null,ownerId:scope.ownerId??null},
     slot:{postingId:posting.id,transactionId:journal.id,ledgerAccountId:posting.ledgerAccountId,compensationId:original.compensationId,configRuleId:original.configRuleId,compensationVersion:original.source.rate!.version,configVersion:original.rule.version,isEarningBase:baseById.has(posting.id),occurredAt:journal.occurredAt.toISOString(),postingAmount:Money.of(posting.amount.toString(),posting.currency).toJSON(),rate:original.rate.toJSON(),journalAmount:journalAmount.toJSON(),bucket:posting.bucket,side:posting.side,
      propertyId:scope.propertyId??null,sourceCityId:scope.city??null,sourceRegionId:scope.region??null,reservationId:scope.reservationId??null,taskId:scope.taskId??null,ownerId:scope.ownerId??null}};
   })).map((witness,position)=>({...witness,data:{...witness.data,position}}));
   const first=witnesses.find(witness=>witness.data.isEarningBase)!.data,original=baseById.get(first.postingId)!,assignment=original.source.assignment;
   return{witnesses,line:{id:crypto.randomUUID(),earningKind:"PERCENTAGE",personId:line.personId,assignmentId:line.assignmentId,compensationId:first.compensationId,configRuleId:first.configRuleId,
    taskId:assignment.scopeType==="job"?assignment.scopeId:null,propertyId:["property","job"].includes(assignment.scopeType)?original.source.property!.id:null,sourceCityId:assignment.scopeType==="city"?assignment.scopeId:null,sourceRegionId:assignment.scopeType==="region"?assignment.scopeId:null,
    recordedCompletionAt:new Date(Math.max(...line.sources.map(row=>row.earnedAt.getTime()))),rate:original.rate.toJSON().amount,amount:line.amount.amount,currency:input.currency,
    sourceSnapshot:json({schemaVersion:1,kind:"ACTUAL_POSTED_PERCENTAGE_EARNINGS",personId:line.personId,assignmentId:line.assignmentId,runPolicyRuleId:prepared.policy.id,earningPolicyRuleId:prepared.source.policy.id,earningPolicyVersion:prepared.source.policy.version,earningPolicy:prepared.source.policy.value,witnesses:witnesses.map(witness=>witness.slot)})}};
  });
  return persistEmployeeCompensationRun(ctx,tx,{earningKind:"PERCENTAGE",createdBy:ctx.actorId,idempotencyKey:input.idempotencyKey,requestFingerprint:fingerprint,fromOn:new Date(input.fromOn+"T00:00:00.000Z"),toOn:new Date(input.toOn+"T00:00:00.000Z"),timezone:prepared.window.policy.timezone,currency:input.currency,purpose:input.purpose,reason:input.reason,policyRuleId:prepared.policy.id,policySnapshot:json({schemaVersion:1,policyRuleId:prepared.policy.id,policyVersion:prepared.policy.version,value:prepared.policy.value})},retained.map(row=>row.line),Money.of(prepared.source.amount.amount,input.currency),recheck,deps,async()=>{
   const witnesses=retained.flatMap(row=>row.witnesses.map(witness=>({...witness.data,runLineId:row.line.id})));if((await runs.createPercentageWitnesses(witnesses)).count!==witnesses.length)throw new EmployeeCompensationRunConflictError();
  });
 },{timeout:120000});
}
