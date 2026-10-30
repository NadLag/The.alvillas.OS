import type { TenantTransaction } from "@/platform/db/tenant";
import { EmployeeCompensationRunAccessError } from "../domain/employee-compensation-run";
import { recheckFinanceAuthorization, type FinanceActorContext } from "./finance-access";
import type { employeeCompensationRunFacts } from "@/platform/authz/employee-compensation-resource";
export { employeeCompensationRunFacts } from "@/platform/authz/employee-compensation-resource";

export async function recheckEmployeeCompensationRun(ctx: FinanceActorContext, tx: TenantTransaction, now: Date,
  facts: ReturnType<typeof employeeCompensationRunFacts>, action: "view" | "create" | "edit" | "void" | "export" | "pay" = "view",additionalChecks:Parameters<typeof recheckFinanceAuthorization>[3]=[]) {
  await recheckFinanceAuthorization(ctx, tx, now, [
    { action: "view", resource: facts.resource },
    ...(action === "view" ? [] : [{ action, resource: facts.resource }]),
    ...facts.salarySources.map(resource => ({ action: "view" as const, resource })),...additionalChecks
  ], new EmployeeCompensationRunAccessError());
}
