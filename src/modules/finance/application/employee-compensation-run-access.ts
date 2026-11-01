import {isDeepStrictEqual} from "node:util";
import type { TenantTransaction } from "@/platform/db/tenant";
import { EmployeeCompensationRunAccessError } from "../domain/employee-compensation-run";
import { recheckFinanceAuthorization, type FinanceActorContext } from "./finance-access";
import type { employeeCompensationRunFacts } from "@/platform/authz/employee-compensation-resource";
export { employeeCompensationRunFacts } from "@/platform/authz/employee-compensation-resource";

export async function recheckEmployeeCompensationRun(ctx: FinanceActorContext, tx: TenantTransaction, now: Date,
  facts: ReturnType<typeof employeeCompensationRunFacts>, action: "view" | "create" | "edit" | "void" | "export" | "pay" = "view",additionalChecks:Parameters<typeof recheckFinanceAuthorization>[3]=[]) {
  const checks:Array<Parameters<typeof recheckFinanceAuthorization>[3][number]>=[
    { action: "view", resource: facts.resource },
    ...(action === "view" ? [] : [{ action, resource: facts.resource }]),
    ...facts.salarySources.map(resource => ({ action: "view" as const, resource })),...(facts.financialSources??[]).map(resource=>({action:"view" as const,resource})),...additionalChecks
  ];
  const distinct:typeof checks=[],buckets=new Map<string,typeof checks>();
  for(const check of checks){
    const key=JSON.stringify(check),bucket=buckets.get(key)??[];
    // JSON is only a lookup bucket: distinct values such as NaN and null must retain independent checks.
    if(bucket.some(previous=>isDeepStrictEqual(previous,check)))continue;
    bucket.push(check);buckets.set(key,bucket);distinct.push(check);
  }
  await recheckFinanceAuthorization(ctx, tx, now, distinct, new EmployeeCompensationRunAccessError());
}
