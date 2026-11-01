import {Money} from "@/platform/money/money";
import {employeeCompensationHourlyWitnessFields,employeeCompensationRunFacts,type EmployeeCompensationRunAuthoritySource} from "./employee-compensation-resource";
import {employeePercentageAuthorityWitnessFields,type EmployeePercentageAuthorityWitness} from "./employee-percentage-resource";
export const employeeEarningRequestSourceFields={id:true,personId:true,assignmentId:true,compensationId:true,configRuleId:true,evidenceId:true,decisionId:true,recordedCompletionAt:true,currency:true,rate:true,amount:true,
 propertyId:true,taskId:true,sourceCityId:true,sourceRegionId:true,property:{select:{cityId:true,regionId:true}},sourceCity:{select:{id:true,regionId:true}},sourceRegion:{select:{id:true}},
 evidence:{select:{id:true,taskId:true,propertyId:true,completionEventId:true,property:{select:{cityId:true,regionId:true}}}},
 witnesses:{orderBy:{position:"asc" as const},select:employeeCompensationHourlyWitnessFields},percentageWitnesses:{orderBy:{position:"asc" as const},select:employeePercentageAuthorityWitnessFields}} as const;

type Amount={toString():string};
export type EmployeeEarningRequestAuthorityRecord={id:string;requestedBy:string;requestedAt:Date;earningKind:string;currency:string;amount:Amount;sources:readonly {id:string;personId:string;assignmentId:string;compensationId:string;configRuleId:string;evidenceId:string|null;decisionId:string|null;recordedCompletionAt:Date;currency:string;rate:Amount;amount:Amount;
 propertyId?:string|null;taskId?:string|null;property?:{cityId:string|null;regionId:string|null}|null;sourceCity?:{id:string;regionId:string|null}|null;sourceRegion?:{id:string}|null;
 evidence:{id:string;taskId:string;propertyId:string;completionEventId:string;property:{cityId:string|null;regionId:string|null}}|null;
 witnesses:readonly {startsAt:Date;compensation:{amount:Amount;currency:string;assignment:{personId:string;scopeType:string;scopeId:string|null}}}[];percentageWitnesses?:readonly EmployeePercentageAuthorityWitness[]}[]};
/** Pending receipts and audits retain actual original earning scopes and whole-journal financial authority. */
export function employeeEarningRequestAuthorityFacts(organizationId:string,row:EmployeeEarningRequestAuthorityRecord){
 if(!["PER_HOUR","PERCENTAGE"].includes(row.earningKind)||!row.sources.length)throw Error("Original earning request authority is unavailable");
 const lines:EmployeeCompensationRunAuthoritySource["lines"]=row.sources.map(source=>{
  if(row.earningKind==="PER_HOUR"){
   if(!source.evidence||source.evidence.id!==source.evidenceId||!source.witnesses.length||source.percentageWitnesses?.length)throw Error("Original hourly request authority is unavailable");
   return{personId:source.personId,propertyId:source.evidence.propertyId,taskId:source.evidence.taskId,recordedCompletionAt:source.recordedCompletionAt,currency:source.currency,rate:source.rate,amount:source.amount,property:source.evidence.property,hourlyWitnesses:source.witnesses};
  }
  if(source.evidenceId!==null||source.decisionId!==null||source.evidence!==null||source.witnesses.length||!("propertyId" in source)||!("taskId" in source)||!source.percentageWitnesses?.some(witness=>witness.isEarningBase))throw Error("Original posted request authority is unavailable");
  return{personId:source.personId,propertyId:source.propertyId??null,taskId:source.taskId??null,recordedCompletionAt:source.recordedCompletionAt,currency:source.currency,rate:source.rate,amount:source.amount,property:source.property??null,sourceCity:source.sourceCity,sourceRegion:source.sourceRegion,percentageWitnesses:source.percentageWitnesses};
 });
 const facts=employeeCompensationRunFacts(organizationId,{id:row.id,currency:row.currency,createdAt:row.requestedAt,lines});
 if(!facts.total.equals(Money.of(row.amount.toString(),row.currency)))throw Error("Original earning request total differs from its actual sources");
 return{...facts,sourceIdentity:JSON.stringify({id:row.id,currency:row.currency,requestedBy:row.requestedBy,amount:row.amount.toString(),sources:row.sources})};
}
