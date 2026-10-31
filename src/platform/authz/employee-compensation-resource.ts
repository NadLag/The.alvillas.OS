import type { Resource } from "./authorize";
import { Money } from "@/platform/money/money";
import { calendarDateStart } from "@/platform/time/calendar";

type Amount = { toString(): string };
export const employeeCompensationContractWitnessFields={occurredAt:true,sourceOn:true,eligible:true,compensation:{select:{id:true,version:true,amount:true,currency:true}},configRule:{select:{id:true,version:true}}} as const;
export const employeeCompensationAuthorityLineFields={personId:true,propertyId:true,taskId:true,recordedCompletionAt:true,currency:true,amount:true,rate:true,property:{select:{cityId:true,regionId:true}},sourceCity:{select:{id:true,regionId:true}},sourceRegion:{select:{id:true}},contractWitnesses:{orderBy:{sourceOn:"asc" as const},select:employeeCompensationContractWitnessFields}} as const;
export type EmployeeCompensationRunAuthoritySource = {
  id?: string; currency: string; createdAt: Date;
  lines: ReadonlyArray<{ personId: string; propertyId: string|null; taskId: string|null; recordedCompletionAt: Date; currency: string;
    amount: Amount; rate: Amount; property: { cityId: string | null; regionId: string | null }|null;sourceCity?:{id:string;regionId:string|null}|null;sourceRegion?:{id:string}|null;contractWitnesses?:ReadonlyArray<{occurredAt:Date;compensation:{amount:Amount;currency:string}|null}> }>;
};

/** Business views and audit views authorize the same real run total and original per-person amounts. */
export function employeeCompensationRunFacts(organizationId: string, run: EmployeeCompensationRunAuthoritySource) {
  const totals = new Map<string, Money>(); let total = Money.zero(run.currency);
  for (const line of run.lines) {
    if (line.currency !== run.currency) throw Error("Compensation run source currencies differ");
    const amount = Money.of(line.amount.toString(), run.currency);
    total = total.add(amount); totals.set(line.personId, (totals.get(line.personId) ?? Money.zero(run.currency)).add(amount));
  }
  const resource: Resource = { type: "employee_payable", organizationId, id: run.id || undefined, dataClass: "financial", amount: total.toJSON().amount, occurredAt: run.createdAt };
  const salarySources: Resource[] = run.lines.flatMap(line => {
    const source: Resource = { type: "staff_compensation", organizationId, id: line.personId, assignedPersonId: line.personId,
      propertyId: line.propertyId, city: line.property?.cityId??line.sourceCity?.id, region: line.property?.regionId??line.sourceCity?.regionId??line.sourceRegion?.id, jobId: line.taskId,
      occurredAt: line.recordedCompletionAt, dataClass: "financial" };
    return [{ ...source, amount: Money.of(line.rate.toString(), run.currency).toJSON().amount }, { ...source, amount: totals.get(line.personId)!.toJSON().amount },...(line.contractWitnesses??[]).flatMap(witness=>witness.compensation?[{...source,occurredAt:witness.occurredAt,amount:Money.of(witness.compensation.amount.toString(),witness.compensation.currency).toJSON().amount},{...source,occurredAt:witness.occurredAt,amount:totals.get(line.personId)!.toJSON().amount}]:[])];
  });
  return { resource, salarySources, total };
}

/** Submission, queued admission and historical reads retain the same actual source assignment. */
export function employeeCompensationFinancialSourceFacts(organizationId:string,createdBy:string,source:{propertyId:string|null;taskId:string|null;reservationId:string|null;
  amount:Amount;property:{cityId:string|null;regionId:string|null}|null;sourceCity?:{id:string;regionId:string|null}|null;sourceRegion?:{id:string}|null},occurredAt:Date){
  const scope={organizationId,propertyId:source.propertyId,city:source.property?.cityId??source.sourceCity?.id,region:source.property?.regionId??source.sourceCity?.regionId??source.sourceRegion?.id,reservationId:source.reservationId,
    jobId:source.taskId,assignedUserAccountId:createdBy,dataClass:"financial" as const};
  return{scope,financial:{...scope,type:"financial_transaction",amount:source.amount.toString(),occurredAt} satisfies Resource};
}

/** Historical business reads and audit views retain the same whole submitted financial source. */
export function employeeCompensationSubmittedFinancialSources(organizationId:string,row:{costOn:Date;run:{createdBy:string};costs:ReadonlyArray<{propertyId:string|null;reservationId:string|null;amount:Amount;timezone:string;
  runLine:{taskId:string|null;recordedCompletionAt:Date;sourceCity?:{id:string;regionId:string|null}|null;sourceRegion?:{id:string}|null};property:{cityId:string|null;regionId:string|null}|null}>},total:Money){
  const costOn=row.costOn.toISOString().slice(0,10),starts=new Map<string,Date>();
  return row.costs.flatMap(cost=>{
    let at=starts.get(cost.timezone);if(!at){at=calendarDateStart(costOn,cost.timezone);starts.set(cost.timezone,at);}
    const{financial}=employeeCompensationFinancialSourceFacts(organizationId,row.run.createdBy,{...cost,taskId:cost.runLine.taskId,sourceCity:cost.runLine.sourceCity,sourceRegion:cost.runLine.sourceRegion},at);
    return[financial,{...financial,amount:total.toJSON().amount},{...financial,occurredAt:cost.runLine.recordedCompletionAt}];
  });
}
