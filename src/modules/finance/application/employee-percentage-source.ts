import {authorizeCollection,type Resource} from "@/platform/authz/authorize";
import type {TenantTransaction} from "@/platform/db/tenant";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {Money} from "@/platform/money/money";
import {financialJournalExposure} from "@/platform/ledger/journal-exposure";
import {EmployeeCompensationRepository} from "../infrastructure/employee-compensation-repository";
import {EmployeePercentageSourceRepository} from "../infrastructure/employee-percentage-source-repository";
import {FinanceRepository} from "../infrastructure/finance-repository";
import {EmployeeCompensationRunAccessError,EmployeeCompensationRunConflictError,EmployeeCompensationRunPolicyError} from "../domain/employee-compensation-run";
import {EmployeeCompensationSourceUnavailableError} from "../domain/employee-compensation";
import {employeePercentageEarningsPolicyKey,employeePercentageEarnedAmount} from "../domain/employee-percentage-earnings";
import {employeePercentagePostedBase,employeePostedJournalAmounts} from "../domain/employee-percentage-posted-base";
import {employeePercentageSourceInput} from "../domain/employee-percentage-run";
import {employeePercentageScopeReferences,employeePercentageSourceScope} from "../domain/employee-percentage-source-scope";
import {employeeCompensationContractResource,validateEmployeeCompensationAssignment,validateEmployeeCompensationRate} from "./employee-compensation-source";
import {recheckFinanceAuthorization,type FinanceActorContext} from "./finance-access";

/** Internal compiler: actual posted sources, original contracts and held plus fresh authority; no writes. */
export async function prepareEmployeePercentageSources(ctx:FinanceActorContext,raw:unknown,tx:TenantTransaction){
 const input=employeePercentageSourceInput.parse(raw);input.bases.sort((a,b)=>a.postingId.localeCompare(b.postingId)||a.assignmentId.localeCompare(b.assignmentId));
 if(ctx.organizationId!==ctx.authContext.organizationId||ctx.actorId!==ctx.authContext.userAccountId||
  !["employee_payable","staff_compensation","financial_transaction"].every(type=>authorizeCollection(ctx.authContext,"view",type))||!authorizeCollection(ctx.authContext,"create","employee_payable"))throw new EmployeeCompensationRunAccessError();
 const repository=new EmployeePercentageSourceRepository(tx,ctx.organizationId),contracts=new EmployeeCompensationRepository(tx,ctx.organizationId),config=new ConfigRuleRepository(tx,ctx.organizationId),finance=new FinanceRepository(tx,ctx.organizationId);
 const build=async()=>{
  const now=await finance.clock(),policy=await config.resolve({key:employeePercentageEarningsPolicyKey,scopes:[{scopeType:"organization",scopeId:null}],asOf:now});
  if(!policy||policy.scopeType!=="organization"||policy.scopeId!==null)throw new EmployeeCompensationRunPolicyError();
  const originals=await repository.bases(input.bases.map(base=>base.postingId)),byPosting=new Map(originals.map(row=>[row.posting.id,row]));
  const journals=[...new Map(originals.filter(row=>row.transaction).map(row=>[row.transaction!.id,row.transaction!])).values()];
  const references=journals.flatMap(journal=>journal.postings.map(posting=>({postingId:posting.id,refs:employeePercentageScopeReferences(posting.dimensions)})));
  const refIds=(key:"reservation_id"|"owner_id"|"property_id")=>references.flatMap(row=>row.refs[key]?[row.refs[key]]:[]);
  const tasks=await repository.tasks(references.flatMap(row=>{const taskId=row.refs.task_id??row.refs.job_id;return taskId?[taskId]:[];}));
  const [reservations,owners]=await Promise.all([repository.reservations([...refIds("reservation_id"),...tasks.flatMap(task=>task.reservationId?[task.reservationId]:[])]),repository.owners(refIds("owner_id"))]);
  const properties=await repository.properties([...refIds("property_id"),...reservations.map(row=>row.propertyId),...tasks.map(row=>row.propertyId)]);
  const facts={properties:new Map(properties.map(row=>[row.id,row])),reservations:new Map(reservations.map(row=>[row.id,row])),tasks:new Map(tasks.map(row=>[row.id,row])),owners:new Map(owners.map(row=>[row.id,row]))};
  const scopes=new Map(references.map(row=>[row.postingId,employeePercentageSourceScope(row.refs,facts)]));
  const entries=input.bases.map(base=>{const original=byPosting.get(base.postingId);if(!original?.transaction||!original.account)throw new EmployeeCompensationSourceUnavailableError();
   const posted=employeePercentagePostedBase(ctx.organizationId,input.currency,policy.parsedValue,{posting:original.posting,transaction:original.transaction,account:original.account});
   if(posted.occurredAt>now)throw new EmployeeCompensationSourceUnavailableError();return{...base,key:base.postingId+":"+base.assignmentId,earnedAt:posted.occurredAt,posted,original:{...original,transaction:original.transaction,account:original.account}};});
  const [sources,rules]=await Promise.all([contracts.sources(entries),config.resolveDatedScopeGroups("staff.compensation",new Map(entries.map(entry=>[entry.key,{asOf:entry.earnedAt,scopes:[{scopeType:"role_assignment",scopeId:entry.assignmentId}]}])))]);
  const retained=entries.map(entry=>{
   const source=sources.get(entry.key);if(!source?.rate||source.rate.mode!=="PERCENTAGE"||source.rate.currency!==input.currency)throw new EmployeeCompensationSourceUnavailableError();
   const rate=validateEmployeeCompensationAssignment(source,entry.earnedAt),rule=validateEmployeeCompensationRate(source,rules.get(entry.key)??null),scope=scopes.get(entry.postingId)!;
   const assignment=source.assignment,matched=assignment.scopeType==="organization"||assignment.scopeType==="property"&&assignment.scopeId===scope.propertyId||assignment.scopeType==="city"&&assignment.scopeId===scope.city||assignment.scopeType==="region"&&assignment.scopeId===scope.region||assignment.scopeType==="job"&&assignment.scopeId===scope.taskId;
   if(!matched)throw new EmployeeCompensationSourceUnavailableError();
   return{...entry,source,rule,scope,personId:assignment.personId,compensationId:rate.id,configRuleId:rule.id,rate:Money.of(rate.amount.toString(),input.currency)};
  });
  const precise=await repository.preciseContracts(retained);if(precise.length!==retained.length)throw new EmployeeCompensationSourceUnavailableError();
  if(new Set(retained.map(row=>row.postingId+":"+row.personId)).size!==retained.length)throw new EmployeeCompensationSourceUnavailableError();
  const grouped=new Map<string,typeof retained>();for(const row of retained){const key=row.personId+":"+row.assignmentId,group=grouped.get(key)??[];group.push(row);grouped.set(key,group);}
  const lines=[...grouped.values()].map(rows=>{const amount=employeePercentageEarnedAmount(policy.parsedValue,input.currency,rows.map(row=>({...row.posted,rate:row.rate})));return{personId:rows[0].personId,assignmentId:rows[0].assignmentId,amount:amount.amount.toJSON(),baseAmount:amount.baseAmount.toJSON(),sources:rows};});
  const beneficiary=new Map<string,Money>();let total=Money.zero(input.currency);for(const line of lines){const amount=Money.of(line.amount.amount,input.currency);total=total.add(amount);beneficiary.set(line.personId,(beneficiary.get(line.personId)??Money.zero(input.currency)).add(amount));}
  const resource:Resource={type:"employee_payable",organizationId:ctx.organizationId,dataClass:"financial",amount:total.toJSON().amount,occurredAt:now};
  const checks:Parameters<typeof recheckFinanceAuthorization>[3][number][]=[{action:"view",resource},{action:"create",resource}];
  const journalTotals=new Map(journals.map(journal=>[journal.id,employeePostedJournalAmounts(journal.postings)])),exposure=financialJournalExposure([...journalTotals].flatMap(([transactionId,totals])=>[...totals].map(([currency,amount])=>({transactionId,currency,amount:amount.toJSON().amount}))));
  for(const journal of journals){
   const totals=journalTotals.get(journal.id)!;
   for(const posting of journal.postings){const original=totals.get(posting.currency)??Money.zero(posting.currency),whole=exposure.get(posting.currency)??Money.zero(posting.currency),resource:Resource={...scopes.get(posting.id),type:"financial_transaction",id:journal.id,financialRecordId:journal.id,organizationId:ctx.organizationId,dataClass:"financial",amount:original.toJSON().amount,occurredAt:journal.occurredAt,assignedUserAccountId:journal.createdBy};checks.push({action:"view",resource});if(!whole.equals(original))checks.push({action:"view",resource:{...resource,amount:whole.toJSON().amount}});}
  }
  for(const row of retained){const contract=employeeCompensationContractResource(ctx.organizationId,row.source,row.earnedAt),earned:Resource={...row.scope,type:"staff_compensation",id:row.personId,organizationId:ctx.organizationId,dataClass:"financial",assignedPersonId:row.personId,occurredAt:row.earnedAt};
   for(const scope of [contract,earned])for(const amount of [row.rate.toJSON().amount,beneficiary.get(row.personId)!.toJSON().amount])checks.push({action:"view",resource:{...scope,amount}});
  }
  await recheckFinanceAuthorization(ctx,tx,await finance.clock(),checks,new EmployeeCompensationRunAccessError());
  const journalScopes=[...scopes].sort(([a],[b])=>a.localeCompare(b)),snapshot={input,policy:{id:policy.id,version:policy.version,value:policy.value},journals,journalScopes,lines:lines.map(line=>({...line,sources:line.sources.map(row=>({posting:row.original.posting,account:row.original.account,assignment:row.source.assignment,compensation:row.source.rate,rule:{id:row.rule.id,version:row.rule.version,value:row.rule.value,effectiveFrom:row.rule.effectiveFrom},scope:row.scope}))}))};
  return{policy,lines,journals,journalScopes:new Map(journalScopes),amount:total.toJSON(),sourceFingerprint:commandFingerprint(snapshot)};
 };
 const prepared=await build();return{...prepared,recheck:async()=>{if((await build()).sourceFingerprint!==prepared.sourceFingerprint)throw new EmployeeCompensationRunConflictError();}};
}
