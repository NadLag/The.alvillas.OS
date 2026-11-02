import type {Prisma} from "@prisma/client";
import type {TenantTransaction} from "@/platform/db/tenant";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {Money} from "@/platform/money/money";
import {requireCurrentTimezoneData} from "@/platform/time/timezone-data";
import {employeePercentageRunSourceInput,employeePercentageRunPolicyKey,employeePercentageRunWindow} from "../domain/employee-percentage-run";
import {employeePostedJournalAmounts} from "../domain/employee-percentage-posted-base";
import {EmployeeCompensationRunPolicyError} from "../domain/employee-compensation-run";
import {EmployeeCompensationRunRepository} from "../infrastructure/employee-compensation-run-repository";
import {FinanceRepository} from "../infrastructure/finance-repository";
import {prepareEmployeePercentageSources} from "./employee-percentage-source";
import type {FinanceActorContext} from "./finance-access";
const json=(value:unknown)=>JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;

/** Calendar, contracts and original journal authority are shared by review, admission and the worker. */
export async function prepareEmployeePercentageRunSources(ctx:FinanceActorContext,raw:unknown,tx:TenantTransaction){
 const input=employeePercentageRunSourceInput.parse(raw);input.bases.sort((a,b)=>a.postingId.localeCompare(b.postingId)||a.assignmentId.localeCompare(b.assignmentId));
 requireCurrentTimezoneData();const rules=new ConfigRuleRepository(tx,ctx.organizationId),finance=new FinanceRepository(tx,ctx.organizationId),policy=await rules.resolve({key:employeePercentageRunPolicyKey,scopes:[{scopeType:"organization",scopeId:null}],asOf:await finance.clock()});
 if(!policy||policy.scopeType!=="organization"||policy.scopeId!==null)throw new EmployeeCompensationRunPolicyError();
 const window=employeePercentageRunWindow(input.fromOn,input.toOn,policy.parsedValue),database=await new EmployeeCompensationRunRepository(tx,ctx.organizationId).window(input.fromOn,input.toOn,window.policy.timezone);
 if(database.startsAt.getTime()!==window.startsAt.getTime()||database.endsAt.getTime()!==window.endsAt.getTime())throw new EmployeeCompensationRunPolicyError();
 const source=await prepareEmployeePercentageSources(ctx,{currency:input.currency,bases:input.bases},tx);
 if(source.lines.some(line=>line.sources.some(row=>row.earnedAt<window.startsAt||row.earnedAt>=window.endsAt)))throw new EmployeeCompensationRunPolicyError();
 const sourceFingerprint=commandFingerprint({input,policy:{id:policy.id,version:policy.version,value:policy.value},sourceFingerprint:source.earningFingerprint});
 return{policy,window,source,sourceFingerprint};
}


/** Retain the same typed original evidence for a request and its eventual run. */
export function retainEmployeePercentageRunSources(prepared:Awaited<ReturnType<typeof prepareEmployeePercentageRunSources>>,input:Pick<ReturnType<typeof employeePercentageRunSourceInput.parse>,"currency">){
 return prepared.source.lines.map(line=>{
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
}
