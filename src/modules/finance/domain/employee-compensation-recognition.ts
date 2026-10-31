import { z } from "zod";
import { employeeCompensationSourceIdentity } from "./employee-compensation-source-identity";
import { Money } from "@/platform/money/money";
import { calendarDateStart } from "@/platform/time/calendar";
import { employeeCompensationClaimCosts,employeeCompensationSubmissionViewSchema } from "./employee-compensation-claim";
import { readSubmittedCostAllocation,sameSubmittedCostPolicy } from "./submitted-cost-allocation";

export { employeeCompensationRecognitionInput,employeeCompensationRecognitionRequestViewSchema } from "./employee-compensation-recognition-command";

const money=z.object({amount:z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/u),currency:z.string().regex(/^[A-Z]{3}$/u)});
const hourlyEvidence={workTimeEvidenceId:z.uuid().optional(),workTimeDecisionId:z.uuid().optional()};
const frozenCost=z.object({...hourlyEvidence,runLineId:z.uuid(),personId:z.uuid(),propertyId:z.uuid().nullable(),reservationId:z.uuid().nullable(),taskId:z.uuid().nullable(),completionEventId:z.uuid().nullable(),earningKind:z.enum(["PER_JOB","PER_MONTH","PER_HOUR"]).optional(),assignmentId:z.uuid().optional(),earningPeriodKey:z.string().optional(),
  recordedCompletionAt:z.iso.datetime({offset:true}),costOn:z.iso.date(),timezone:z.string().min(1),category:z.string(),costCenter:z.string().nullable(),note:z.string(),amount:money,policy:z.unknown()});
const frozenSource=z.object({schemaVersion:z.literal(1),kind:z.literal("EMPLOYEE_COMPENSATION_COSTS"),runId:z.uuid(),costOn:z.iso.date(),total:employeeCompensationSubmissionViewSchema.shape.total,costs:z.array(frozenCost).min(1).max(10000)});
const policySchema=z.object({...hourlyEvidence,schemaVersion:z.literal(1),sourceKind:z.literal("employee_compensation_run_line"),runId:z.uuid(),runLineId:z.uuid(),completionEventId:z.uuid().nullable(),personId:z.uuid(),earningKind:z.enum(["PER_JOB","PER_MONTH","PER_HOUR"]).optional(),assignmentId:z.uuid().optional(),earningPeriodKey:z.string().optional(),
  recordedCompletionAt:z.iso.datetime({offset:true}),propertyId:z.uuid().nullable(),reservationId:z.uuid().nullable(),occurredOn:z.iso.date(),timezone:z.string(),category:z.string(),amount:money}).passthrough();

export type EmployeeCompensationRecognitionSource={organizationId:string;id:string;runId:string;costOn:string;currency:string;emergency:boolean;
  claims:ReadonlyArray<{id:string;organizationId:string;submissionId:string;personId:string}>;
  runLines:ReadonlyArray<{id:string;personId:string;propertyId:string|null;taskId:string|null;completionEventId:string|null;earningKind?:string;assignmentId?:string;earningPeriodKey?:string|null;workTimeEvidenceId?:string|null;workTimeDecisionId?:string|null;recordedCompletionAt:string;amount:string;currency:string}>;
  costs:ReadonlyArray<{id:string;organizationId:string;submissionId:string;claimId:string;runLineId:string;completionEventId:string|null;propertyId:string|null;reservationId:string|null;amount:string;currency:string;category:string;costCenter:string|null;note:string;timezone:string;policySnapshot:unknown}>};
export class EmployeeCompensationRecognitionSourceError extends Error{}

/** Every claim binds its original performer and approved costs; current rules never reprice recognition. */
export function employeeCompensationRecognitionCosts(source:EmployeeCompensationRecognitionSource,claimId:string,snapshot:unknown){
  const frozen=frozenSource.parse(snapshot);function denied():never{throw new EmployeeCompensationRecognitionSourceError("Employee costs differ from their immutable submitted source");}
  if(frozen.runId!==source.runId||frozen.costOn!==source.costOn||frozen.total.currency!==source.currency||source.costs.length!==frozen.costs.length)denied();
  const claim=source.claims.find(value=>value.id===claimId);if(!claim||source.claims.some(value=>value.organizationId!==source.organizationId||value.submissionId!==source.id)||new Set(source.claims.map(value=>value.id)).size!==source.claims.length||new Set(source.claims.map(value=>value.personId)).size!==source.claims.length)denied();
  const classified=employeeCompensationClaimCosts({runId:source.runId,costOn:source.costOn,emergency:source.emergency,costs:frozen.costs.map(cost=>({runLineId:cost.runLineId,category:cost.category,costCenter:cost.costCenter,note:cost.note}))},source.runLines,source.currency);
  if(!classified.total.equals(Money.of(frozen.total.amount,source.currency)))denied();
  const actual=new Map(source.costs.map(cost=>[cost.runLineId,cost])),original=new Map(source.runLines.map(line=>[line.id,line])),claims=new Map(source.claims.map(value=>[value.id,value]));
  if(actual.size!==source.costs.length||new Set(source.costs.map(cost=>cost.id)).size!==source.costs.length||new Set(classified.costs.map(cost=>cost.source.personId)).size!==source.claims.length)denied();
  const starts=new Map<string,Date>();let amount=Money.zero(source.currency);
  const costs=frozen.costs.flatMap(line=>{
    const cost=actual.get(line.runLineId),runLine=original.get(line.runLineId),policy=policySchema.parse(line.policy);if(!cost||!runLine)denied();
    const identity=employeeCompensationSourceIdentity(runLine);if((line.earningKind??"PER_JOB")!==identity.kind||(policy.earningKind??"PER_JOB")!==identity.kind||identity.kind==="PER_MONTH"&&(line.assignmentId!==identity.assignmentId||line.earningPeriodKey!==identity.month||policy.assignmentId!==identity.assignmentId||policy.earningPeriodKey!==identity.month)||identity.kind==="PER_HOUR"&&(line.assignmentId!==identity.assignmentId||policy.assignmentId!==identity.assignmentId||line.workTimeEvidenceId!==identity.evidenceId||policy.workTimeEvidenceId!==identity.evidenceId||line.workTimeDecisionId!==identity.decisionId||policy.workTimeDecisionId!==identity.decisionId))denied();
    const beneficiary=claims.get(cost.claimId),value=Money.of(cost.amount,cost.currency);
    if(cost.organizationId!==source.organizationId||cost.submissionId!==source.id||!beneficiary||beneficiary.personId!==runLine.personId||line.personId!==runLine.personId||line.taskId!==runLine.taskId||line.propertyId!==runLine.propertyId||line.completionEventId!==runLine.completionEventId||
      line.recordedCompletionAt!==runLine.recordedCompletionAt||line.costOn!==source.costOn||line.timezone!==cost.timezone||line.category!==cost.category||line.costCenter!==cost.costCenter||line.note!==cost.note||
      cost.completionEventId!==runLine.completionEventId||cost.propertyId!==runLine.propertyId||cost.reservationId!==line.reservationId||!value.equals(Money.of(runLine.amount,runLine.currency))||!value.equals(Money.of(line.amount.amount,line.amount.currency))||
      policy.runId!==source.runId||policy.runLineId!==runLine.id||policy.completionEventId!==runLine.completionEventId||policy.personId!==runLine.personId||policy.recordedCompletionAt!==runLine.recordedCompletionAt||
      policy.propertyId!==cost.propertyId||policy.reservationId!==cost.reservationId||policy.occurredOn!==source.costOn||policy.timezone!==cost.timezone||policy.category!==cost.category||!value.equals(Money.of(policy.amount.amount,policy.amount.currency))||
      !sameSubmittedCostPolicy(cost.policySnapshot,line.policy))denied();
    const retained=readSubmittedCostAllocation({organizationId:source.organizationId,propertyId:cost.propertyId,reservationId:cost.reservationId,amount:value},line.policy,denied);
    if(cost.claimId!==claimId)return[];amount=amount.add(value);let instant=starts.get(cost.timezone);if(!instant){instant=calendarDateStart(source.costOn,cost.timezone);starts.set(cost.timezone,instant);}
    return[{...identity.kind==="PER_MONTH"?{earningKind:"PER_MONTH" as const,assignmentId:identity.assignmentId,earningPeriodKey:identity.month,taskId:runLine.taskId}:identity.kind==="PER_HOUR"?{earningKind:"PER_HOUR" as const,assignmentId:identity.assignmentId,workTimeEvidenceId:identity.evidenceId,workTimeDecisionId:identity.decisionId,taskId:runLine.taskId}:{},id:cost.id,runLineId:runLine.id,completionEventId:runLine.completionEventId,personId:beneficiary.personId,propertyId:cost.propertyId,reservationId:cost.reservationId,category:cost.category,costCenter:cost.costCenter,
      note:cost.note,amount:value,...retained,timezone:cost.timezone,sourceOccurredAt:new Date(instant.getTime())}];
  });
  if(!costs.length||!amount.amount.gt(0))denied();return{claimId,personId:claim.personId,amount,costs};
}
