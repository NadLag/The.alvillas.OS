import { Money } from "@/platform/money/money";
import { employeeCompensationHourlyWitnessFields,employeeCompensationRunFacts } from "./employee-compensation-resource";
export const employeeEarningRequestSourceFields={id:true,personId:true,assignmentId:true,compensationId:true,configRuleId:true,evidenceId:true,decisionId:true,recordedCompletionAt:true,currency:true,rate:true,amount:true,
 evidence:{select:{id:true,taskId:true,propertyId:true,completionEventId:true,property:{select:{cityId:true,regionId:true}}}},
 witnesses:{orderBy:{position:"asc" as const},select:employeeCompensationHourlyWitnessFields}} as const;
type Amount={toString():string};
export type EmployeeEarningRequestAuthorityRecord={id:string;requestedBy:string;requestedAt:Date;earningKind:string;currency:string;amount:Amount;sources:readonly {id:string;personId:string;assignmentId:string;compensationId:string;configRuleId:string;evidenceId:string;decisionId:string;recordedCompletionAt:Date;currency:string;rate:Amount;amount:Amount;
 evidence:{id:string;taskId:string;propertyId:string;completionEventId:string;property:{cityId:string|null;regionId:string|null}};
 witnesses:readonly {startsAt:Date;compensation:{amount:Amount;currency:string;assignment:{personId:string;scopeType:string;scopeId:string|null}}}[]}[]};
/** Request readers and audits use original relational Money and scope, independently of captured JSON. */
export function employeeEarningRequestAuthorityFacts(organizationId:string,row:EmployeeEarningRequestAuthorityRecord){
 if(row.earningKind!=="PER_HOUR"||!row.sources.length||row.sources.some(source=>source.evidence.id!==source.evidenceId||!source.witnesses.length))throw Error("Original earning request authority is unavailable");
 const facts=employeeCompensationRunFacts(organizationId,{id:row.id,currency:row.currency,createdAt:row.requestedAt,lines:row.sources.map(source=>({personId:source.personId,propertyId:source.evidence.propertyId,taskId:source.evidence.taskId,recordedCompletionAt:source.recordedCompletionAt,currency:source.currency,rate:source.rate,amount:source.amount,property:source.evidence.property,hourlyWitnesses:source.witnesses}))});
 if(!facts.total.equals(Money.of(row.amount.toString(),row.currency)))throw Error("Original earning request total differs from its actual sources");
 return{...facts,sourceIdentity:JSON.stringify({id:row.id,currency:row.currency,requestedBy:row.requestedBy,amount:row.amount.toString(),sources:row.sources})};
}
