import { z } from "zod";
import type { Resource } from "@/platform/authz/authorize";
import type { ResolvedConfigRule } from "@/platform/config/config-rule-repository";
import { Money } from "@/platform/money/money";
import type { EmployeeCompensationRepository } from "../infrastructure/employee-compensation-repository";
import { EmployeeCompensationAccessError, EmployeeCompensationSourceUnavailableError } from "../domain/employee-compensation";
import { employeeCompletedWorkEvidence } from "../domain/employee-completed-work";

export type CompensationSource = NonNullable<Awaited<ReturnType<EmployeeCompensationRepository["source"]>>>;
export type CompletedWorkSource = NonNullable<Awaited<ReturnType<EmployeeCompensationRepository["completedWork"]>>>;

export function validateEmployeeCompensationAssignment(source: CompensationSource, earnedAt: Date) {
  const { assignment, rate, property, job, city, region } = source;
  if (!rate) throw new EmployeeCompensationAccessError();
  if (assignment.validFrom > earnedAt || assignment.validTo && assignment.validTo <= earnedAt || assignment.archivedAt && assignment.archivedAt <= earnedAt ||
    assignment.person.archivedAt && assignment.person.archivedAt <= earnedAt || assignment.scopeType === "property" && !property || assignment.scopeType === "job" && (!job || !property) ||
    assignment.scopeType === "city" && !city || assignment.scopeType === "region" && !region ||
    !["organization", "property", "region", "city", "job"].includes(assignment.scopeType)) throw new EmployeeCompensationSourceUnavailableError();
  return rate;
}

export function validateEmployeeCompensationRate(source: CompensationSource, rule: ResolvedConfigRule | null) {
  const { assignment, rate } = source;
  if (!rate) throw new EmployeeCompensationAccessError();
  const value = z.object({ mode: z.enum(["PER_JOB", "PER_MONTH", "PER_HOUR", "PERCENTAGE"]), amount: z.string(), currency: z.string() }).safeParse(rule?.parsedValue);
  if (!rule || !value.success || rule.id !== rate.configRuleId || rule.scopeType !== "role_assignment" || rule.scopeId !== assignment.id ||
    value.data.mode !== rate.mode || value.data.currency !== rate.currency || !Money.of(value.data.amount, rate.currency).equals(Money.of(rate.amount.toString(), rate.currency)) ||
    rule.effectiveFrom.getTime() !== rate.effectiveFrom.getTime()) throw new EmployeeCompensationSourceUnavailableError();
  return rule;
}

/** Run snapshots and interactive estimates require the same actual performer and immutable completion. */
export function validateEmployeeCompletedWorkSource(task: CompletedWorkSource, source: CompensationSource) {
  const { assignment, rate } = source, event = task.events[0];
  if (task.state !== "COMPLETED" || !task.completedAt || !task.completedByPersonId || !rate || assignment.personId !== task.completedByPersonId)
    throw new EmployeeCompensationAccessError();
  if (task.events.length !== 1 || !event || rate.mode !== "PER_JOB") throw new EmployeeCompensationSourceUnavailableError();
  let evidence: ReturnType<typeof employeeCompletedWorkEvidence>;
  try { evidence = employeeCompletedWorkEvidence(event); } catch { throw new EmployeeCompensationSourceUnavailableError(); }
  const scopeMatches = assignment.scopeType === "organization" || assignment.scopeType === "property" && assignment.scopeId === task.propertyId ||
    assignment.scopeType === "city" && assignment.scopeId === task.property.cityId || assignment.scopeType === "region" && assignment.scopeId === task.property.regionId ||
    assignment.scopeType === "job" && assignment.scopeId === task.id;
  if (!scopeMatches || evidence.property_id !== task.propertyId || evidence.completed_by_person_id !== assignment.personId ||
    evidence.completed_by_person_id !== task.completedByPersonId || evidence.completed_by_user_account_id !== task.completedByUserAccountId ||
    evidence.completion_idempotency_key !== task.completionIdempotencyKey || evidence.completion_source !== task.completionSource ||
    new Date(evidence.completed_at).getTime() !== task.completedAt.getTime() || event.version > task.version ||
    evidence.required_role_key !== task.requiredRoleKey || evidence.required_role_key && evidence.required_role_key !== assignment.role.key ||
    evidence.validated_by_person_id !== task.validatedByPersonId || evidence.validated_by_user_account_id !== task.validatedByUserAccountId ||
    (evidence.validated_at ? new Date(evidence.validated_at).getTime() : null) !== (task.validatedAt?.getTime() ?? null) ||
    evidence.validation_reason !== task.validationReason) throw new EmployeeCompensationSourceUnavailableError();
  if (!task.checklistItems.length || task.checklistItems.some(item => !item.completedAt || item.completedAt > task.completedAt! ||
    item.completedByPersonId !== evidence.completed_by_person_id || item.completedByUserAccountId !== evidence.completed_by_user_account_id))
    throw new EmployeeCompensationSourceUnavailableError();
  return { evidence, event };
}

/** Estimate and earned-source preparation share the actual canonical assignment geography and rate. */
export function employeeCompensationContractResource(organizationId:string,source:CompensationSource,earnedAt:Date,taskId?:string):Resource{
  const{assignment,rate,property,job,city,region}=source;if(!rate)throw new EmployeeCompensationAccessError();
  return{type:"staff_compensation",id:assignment.personId,organizationId,dataClass:"financial",assignedPersonId:assignment.personId,amount:rate.amount.toFixed(2),occurredAt:earnedAt,propertyId:property?.id,region:region?.id??city?.regionId??property?.regionId,city:city?.id??property?.cityId,jobId:taskId??(assignment.scopeType==="job"?assignment.scopeId:undefined),reservationId:job?.reservationId};
}
