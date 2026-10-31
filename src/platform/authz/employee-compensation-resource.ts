import type { Resource } from "./authorize";
import { Money } from "@/platform/money/money";
import { calendarDateStart } from "@/platform/time/calendar";

type Amount = { toString(): string };
export type EmployeeCompensationRunAuthoritySource = {
  id?: string; currency: string; createdAt: Date;
  lines: ReadonlyArray<{ personId: string; propertyId: string; taskId: string; recordedCompletionAt: Date; currency: string;
    amount: Amount; rate: Amount; property: { cityId: string | null; regionId: string | null } }>;
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
      propertyId: line.propertyId, city: line.property.cityId, region: line.property.regionId, jobId: line.taskId,
      occurredAt: line.recordedCompletionAt, dataClass: "financial" };
    return [{ ...source, amount: Money.of(line.rate.toString(), run.currency).toJSON().amount }, { ...source, amount: totals.get(line.personId)!.toJSON().amount }];
  });
  return { resource, salarySources, total };
}

/** Submission, queued admission and historical reads retain the same actual source assignment. */
export function employeeCompensationFinancialSourceFacts(organizationId:string,createdBy:string,source:{propertyId:string;taskId:string;reservationId:string|null;
  amount:Amount;property:{cityId:string|null;regionId:string|null}},occurredAt:Date){
  const scope={organizationId,propertyId:source.propertyId,city:source.property.cityId,region:source.property.regionId,reservationId:source.reservationId,
    jobId:source.taskId,assignedUserAccountId:createdBy,dataClass:"financial" as const};
  return{scope,financial:{...scope,type:"financial_transaction",amount:source.amount.toString(),occurredAt} satisfies Resource};
}

/** Historical business reads and audit views retain the same whole submitted financial source. */
export function employeeCompensationSubmittedFinancialSources(organizationId:string,row:{costOn:Date;run:{createdBy:string};costs:ReadonlyArray<{propertyId:string;reservationId:string|null;amount:Amount;timezone:string;
  runLine:{taskId:string;recordedCompletionAt:Date};property:{cityId:string|null;regionId:string|null}}>},total:Money){
  const costOn=row.costOn.toISOString().slice(0,10),starts=new Map<string,Date>();
  return row.costs.flatMap(cost=>{
    let at=starts.get(cost.timezone);if(!at){at=calendarDateStart(costOn,cost.timezone);starts.set(cost.timezone,at);}
    const{financial}=employeeCompensationFinancialSourceFacts(organizationId,row.run.createdBy,{...cost,taskId:cost.runLine.taskId},at);
    return[financial,{...financial,amount:total.toJSON().amount},{...financial,occurredAt:cost.runLine.recordedCompletionAt}];
  });
}
