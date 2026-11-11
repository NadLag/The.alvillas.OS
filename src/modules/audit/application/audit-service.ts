import { financialAttachmentAuthorityChecks } from "@/platform/authz/financial-attachment-resource";
import { canReadExternalPayment } from "@/platform/authz/external-payment-resource";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import {financialRuleKeysIn,financialRuleAccess,recurringCompanyExpensePolicyKey} from "@/platform/config/financial-rule-authority";
import {
  AuditRepository,
  type AuditHistoryFilters,
  type AuditHistoryRow,
  type FinancialAuditResource
} from "@/modules/audit/infrastructure/audit-repository";
import type { AuditActorContext } from "@/modules/audit/application/audit-access";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { authorize, type Action, type Resource } from "@/platform/authz/authorize";
import { authorizeOrganizationSource, authorizeUnconditionalSource } from "@/platform/authz/organization-authority";
import {canViewCompletePropertyFinance} from "@/platform/authz/property-finance-resource";
import {canViewAccountantExport} from "@/platform/authz/accountant-export-resource";
import {canViewServiceAllocation} from "@/platform/authz/service-allocation-resource";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { present } from "@/platform/authz/present";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransaction,type TenantTransactionRunner } from "@/platform/db/tenant";

export const auditLogResource = "audit_log";

export class AuditAuthorizationError extends Error {
  constructor(message = "Audit history action is not authorized") {
    super(message);
    this.name = "AuditAuthorizationError";
  }
}

type AuditServiceDeps = {
  db?: TenantTransactionRunner;
  requestId?: string;
  ipAddress?: string | null;
};

export type AuditHistoryResult = {
  rows: AuditHistoryRow[];
  total: number;
  limit: number;
};

const optionalTrimmedString = z
  .string()
  .trim()
  .transform((value) => (value.length > 0 ? value : undefined))
  .optional();

const dateFilter = optionalTrimmedString.transform((value, ctx) => {
  if (!value) {
    return undefined;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    ctx.addIssue({ code: "custom", message: "Invalid date" });
    return z.NEVER;
  }

  return date;
});

export const auditFilterSchema = z.object({
  action: optionalTrimmedString,
  resourceType: optionalTrimmedString,
  actorId: optionalTrimmedString,
  resourceId: optionalTrimmedString,
  propertyScopeId: optionalTrimmedString,
  from: dateFilter,
  to: dateFilter
});

export type AuditFilterInput = z.input<typeof auditFilterSchema>;

function containsFinancialSetting(value: unknown, ruleKey: string): boolean {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, item]) =>
      key === ruleKey ||
      key.startsWith(`/rules/${ruleKey}/`) ||
      (ruleKey === "services.pricing" && key === "kind" && item === "SERVICE_CATALOG") ||
      (key === "key" && item === ruleKey) ||
      containsFinancialSetting(item, ruleKey)
  );
}

export function presentAuditHistoryRow(
  ctx: AuditActorContext,
  row: AuditHistoryRow,
  action: "view" | "export" = "view",
  financialResource?: FinancialAuditResource
): AuditHistoryRow {
  if (row.action.startsWith("finance.external_payment.")) {
    const allowed = Boolean(row.resourceType === "financial_transaction" && financialResource?.id === row.resourceId &&
      canReadExternalPayment(ctx.authContext, financialResource, action, new Date(), row.action.startsWith("finance.external_payment.fee_")));
    return present({ ...ctx.authContext, visibleDataClasses: new Set(allowed ? ["financial"] : []) }, action,
      { type: auditLogResource, organizationId: ctx.organizationId, propertyId: row.propertyScopeId, data: row },
      { before: { dataClass: "financial" }, after: { dataClass: "financial" }, reason: { dataClass: "financial" } }) as AuditHistoryRow;
  }
  if (row.resourceType === "accountant_export") {
    const allowed = canViewAccountantExport(ctx.authContext, action, new Date());
    return present({ ...ctx.authContext, visibleDataClasses: new Set(allowed ? ["financial"] : []) }, action,
      { type: auditLogResource, organizationId: ctx.organizationId, propertyId: row.propertyScopeId, data: row },
      { before: { dataClass: "financial" }, after: { dataClass: "financial" }, reason: { dataClass: "financial" } }) as AuditHistoryRow;
  }
  if (row.resourceType === "tax_policy_hook") {
    const now = new Date(), allowed = financialRuleAccess(ctx.authContext, action, now, "finance.tax") &&
      authorizeOrganizationSource(ctx.authContext, action, { type: "config_rule", organizationId: ctx.organizationId, dataClass: "financial" }, now);
    return present({ ...ctx.authContext, visibleDataClasses: new Set(allowed ? ["financial"] : []) }, action,
      { type: auditLogResource, organizationId: ctx.organizationId, data: row },
      { before: { dataClass: "financial" }, after: { dataClass: "financial" }, reason: { dataClass: "financial" } }) as AuditHistoryRow;
  }
  // Source-specific workflow history rechecks every original financial or task restriction.
  // A broad audit grant alone cannot disclose its explanations, source details or assignees.
  if (row.resourceType === "variance_workflow_event" || row.resourceType === "variance_workflow_source" || row.resourceType === "variance_workflow_queue") {
    return present({ ...ctx.authContext, visibleDataClasses: new Set() }, action,
      { type: auditLogResource, organizationId: ctx.organizationId, propertyId: row.propertyScopeId, data: row },
      { before: { dataClass: "sensitive" }, after: { dataClass: "sensitive" }, reason: { dataClass: "sensitive" } }) as AuditHistoryRow;
  }
  if(row.resourceType==="service_allocation"){
    const allowed=Boolean(financialResource?.type==="service_allocation"&&financialResource.id===row.resourceId&&financialResource.propertyId===row.propertyScopeId&&canViewServiceAllocation(ctx.authContext,financialResource,new Date(),action));
    return present({...ctx.authContext,visibleDataClasses:new Set(allowed?["financial"]:[])},action,{type:auditLogResource,organizationId:ctx.organizationId,propertyId:row.propertyScopeId,data:row},{before:{dataClass:"financial"},after:{dataClass:"financial"},reason:{dataClass:"financial"}})as AuditHistoryRow;
  }
  if(row.resourceType==="company_expense"){
    const allowed=financialRuleAccess(ctx.authContext,action,new Date(),recurringCompanyExpensePolicyKey);
    return present({...ctx.authContext,visibleDataClasses:new Set(allowed?["financial"]:[])},action,{type:auditLogResource,organizationId:ctx.organizationId,data:row},{before:{dataClass:"financial"},after:{dataClass:"financial"},reason:{dataClass:"financial"}})as AuditHistoryRow;
  }
  if (row.action === "finance.guest_payment.provenance_retained") {
    const original = financialResource?.guestPayment, now = new Date();
    const allowed = Boolean(row.resourceType === "financial_transaction" && financialResource?.type === "financial_transaction" && financialResource.id === row.resourceId && original &&
      original.actorId === row.actorId && original.reason === row.reason && row.before == null &&
      isDeepStrictEqual(row.after, { receiptId: original.receiptId, provenance: original.provenance }) &&
      authorize(ctx.authContext, action, financialResource, now) && original.fundingSources.length && original.fundingSources.every(source => source.organizationId === ctx.organizationId &&
        authorize(ctx.authContext, "view", source, now) && authorize(ctx.authContext, action, source, now)) &&
      (!original.originalCollectionId || original.cashSource?.id === original.originalCollectionId && original.cashSource.organizationId === ctx.organizationId &&
        authorize(ctx.authContext, "view", original.cashSource, now) && authorize(ctx.authContext, action, original.cashSource, now)));
    return present({ ...ctx.authContext, visibleDataClasses: new Set(allowed ? ["financial"] : []) }, action,
      { type: auditLogResource, organizationId: ctx.organizationId, propertyId: row.propertyScopeId, data: row },
      { before: { dataClass: "financial" }, after: { dataClass: "financial" }, reason: { dataClass: "financial" } }) as AuditHistoryRow;
  }
  const financialRules=[...new Set([row.before,row.after].flatMap(financialRuleKeysIn))];
  // Staff-only historical settings use the existing scoped compensation check
  // below. Mixed rule history still requires every actual financial source.
  if(["config_rule","property_template","property_template_revision"].includes(row.resourceType)&&financialRules.some(key=>key!=="staff.compensation")){
    const allowed=financialRules.every(key=>financialRuleAccess(ctx.authContext,action,new Date(),key));
    return present({...ctx.authContext,visibleDataClasses:new Set(allowed?["financial"]:[])},action,
      {type:auditLogResource,organizationId:ctx.organizationId,data:row},
      {before:{dataClass:"financial"},after:{dataClass:"financial"},reason:{dataClass:"financial"}})as AuditHistoryRow;
  }
  if (row.resourceType === "employee_compensation_run"||row.resourceType==="employee_compensation_submission"||row.resourceType==="employee_compensation_claim"||row.resourceType==="employee_monthly_run_request"||row.resourceType==="employee_earning_run_request") {
    const now = new Date();
    const allowed = Boolean(financialResource?.type === "employee_payable" && (row.resourceType!=="employee_compensation_run"?financialResource.sourceRecordId===row.resourceId:financialResource.id === row.resourceId) &&
      financialResource.organizationId === ctx.organizationId && financialResource.salarySources?.length && (!financialResource.financialSources||financialResource.financialSources.every(source=>source.organizationId===ctx.organizationId&&source.type==="financial_transaction"&&authorize(ctx.authContext,"view",source,now)))&&(!financialResource.companyFinancialSources||financialResource.companyFinancialSources.every(source=>source.organizationId===ctx.organizationId&&source.type==="financial_transaction"&&authorizeOrganizationSource(ctx.authContext,"view",source,now)))&&
      (row.resourceType==="employee_compensation_run"||row.resourceType==="employee_monthly_run_request"||row.resourceType==="employee_earning_run_request"||Boolean(financialResource.financialSources?.length&&financialResource.financialSources.every(source=>source.organizationId===ctx.organizationId&&source.type==="financial_transaction"&&authorize(ctx.authContext,"view",source,now))))&&
      (financialResource.organizationOnlyEmployeeSource?authorizeOrganizationSource(ctx.authContext,action,financialResource,now):authorize(ctx.authContext,action,financialResource,now)) && financialResource.salarySources.every(source =>
        source.type === "staff_compensation" && source.organizationId === ctx.organizationId && (financialResource.organizationOnlyEmployeeSource?authorizeOrganizationSource(ctx.authContext,"view",source,now):authorize(ctx.authContext,"view",source,now))));
    return present({ ...ctx.authContext,visibleDataClasses:new Set(allowed?["financial"]:[]) },action,
      {type:auditLogResource,organizationId:ctx.organizationId,data:row},
      {before:{dataClass:"financial"},after:{dataClass:"financial"},reason:{dataClass:"financial"}}) as AuditHistoryRow;
  }
  if (row.resourceType === "supplier_invoice") {
    const now = new Date();
    const allowed = authorizeOrganizationSource(ctx.authContext, action, { type: "supplier_invoice", organizationId: ctx.organizationId, dataClass: "financial" }, now) &&
      authorizeOrganizationSource(ctx.authContext, "view", { type: "supplier", organizationId: ctx.organizationId, dataClass: "personal" }, now);
    return present({ ...ctx.authContext, visibleDataClasses: new Set(allowed ? ["financial"] : []) }, action,
      { type: auditLogResource, organizationId: ctx.organizationId, data: row },
      { before: { dataClass: "financial" }, after: { dataClass: "financial" }, reason: { dataClass: "financial" } }) as AuditHistoryRow;
  }
  if (row.resourceType === "supplier") {
    const allowed = authorizeOrganizationSource(ctx.authContext, action, { type: "supplier", organizationId: ctx.organizationId, dataClass: "personal" }, new Date());
    return present({ ...ctx.authContext, visibleDataClasses: new Set(allowed ? ["sensitive"] : []) }, action,
      { type: auditLogResource, organizationId: ctx.organizationId, data: row },
      { before: { dataClass: "sensitive" }, after: { dataClass: "sensitive" }, reason: { dataClass: "sensitive" } }) as AuditHistoryRow;
  }
  if (row.resourceType === "financial_attachment") {
    const source = financialResource?.attachmentSource, checks = source ? financialAttachmentAuthorityChecks(source, action, financialResource?.attachmentRootId) : null;
    const allowed = Boolean(financialResource?.id === row.resourceId && checks && [...checks, ...(financialResource?.attachmentChecks ?? [])].every(check =>
      check.resource.organizationId === ctx.organizationId && (check.organizationOnly ? authorizeOrganizationSource(ctx.authContext, check.action, check.resource, new Date()) : authorize(ctx.authContext, check.action, check.resource))));
    return present({ ...ctx.authContext, visibleDataClasses: new Set(allowed ? ["financial"] : []) }, action,
      { type: auditLogResource, organizationId: ctx.organizationId, data: row },
      { before: { dataClass: "financial" }, after: { dataClass: "financial" }, reason: { dataClass: "financial" } }) as AuditHistoryRow;
  }
  if (["cash_collection", "expense", "financial_transaction", "ledger_account", "transaction_group", "accounting_period"].includes(row.resourceType)) {
    const expectedType = ["ledger_account", "transaction_group", "accounting_period"].includes(row.resourceType) ? "financial_transaction" : row.resourceType;
    const requiresSourceId = ["financial_transaction", "ledger_account", "transaction_group", "accounting_period"].includes(row.resourceType);
    const permissionResource = ["transaction_group", "accounting_period"].includes(row.resourceType) ?
      { type: "financial_transaction", organizationId: ctx.organizationId, dataClass: "financial" as const } : financialResource;
    const allowed = Boolean(financialResource && financialResource.type === expectedType &&
      (!requiresSourceId || financialResource.id === row.resourceId) && permissionResource && authorize(ctx.authContext, action, permissionResource) &&
        (!financialResource.companyFinancialSources||financialResource.companyFinancialSources.every(source=>source.organizationId===ctx.organizationId&&source.type==="financial_transaction"&&authorizeOrganizationSource(ctx.authContext,"view",source,new Date())))&&
        (!financialResource.walletSources||financialResource.walletSources.every(source=>source.type==="wallet"&&source.organizationId===ctx.organizationId&&authorize(ctx.authContext,"view",source)))&&
        (!financialResource.salarySources||Boolean(financialResource.compensationRoot?.type==="employee_payable"&&financialResource.compensationRoot.organizationId===ctx.organizationId&&authorize(ctx.authContext,action,financialResource.compensationRoot)&&
        financialResource.salarySources.length&&financialResource.salarySources.every(source=>source.type==="staff_compensation"&&source.organizationId===ctx.organizationId&&authorize(ctx.authContext,"view",source))&&
        financialResource.financialSources?.length&&financialResource.financialSources.every(source=>source.type==="financial_transaction"&&source.organizationId===ctx.organizationId&&authorize(ctx.authContext,"view",source))))&&
      [row.before, row.after].every(value => {
        if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, "amount")) return true;
        return typeof value.amount === "string" && /^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/u.test(value.amount) &&
          authorize(ctx.authContext, action, { ...permissionResource, amount: value.amount });
      }));
    return present({ ...ctx.authContext, visibleDataClasses: new Set(allowed ? ["financial"] : []) }, action,
      { type: auditLogResource, organizationId: ctx.organizationId, propertyId: row.propertyScopeId, data: row },
      { before: { dataClass: "financial" }, after: { dataClass: "financial" }, reason: { dataClass: "financial" } }) as AuditHistoryRow;
  }
  if(row.resourceType==="property_finance"){
    const allowed=Boolean(financialResource?.type==="property_finance"&&financialResource.propertyId===row.propertyScopeId&&canViewCompletePropertyFinance(ctx.authContext,financialResource,new Date(),action==="export"?"export":"view"));
    return present({...ctx.authContext,visibleDataClasses:new Set(allowed?["financial"]:[])},action,
      {type:auditLogResource,organizationId:ctx.organizationId,propertyId:row.propertyScopeId,data:row},{before:{dataClass:"financial"},after:{dataClass:"financial"},reason:{dataClass:"financial"}})as AuditHistoryRow;
  }
  if(row.resourceType==="receivable"||row.action.startsWith("finance.receivables.")){
    const now=new Date(),allowed=authorizeOrganizationSource(ctx.authContext,action,{type:"receivable",organizationId:ctx.organizationId,dataClass:"financial"},now)&&
      ["financial_transaction","staff_compensation"].every(type=>authorizeOrganizationSource(ctx.authContext,"view",{type,organizationId:ctx.organizationId,dataClass:"financial"},now));
    return present({...ctx.authContext,visibleDataClasses:new Set(allowed?["financial"]:[])},action,
      {type:auditLogResource,organizationId:ctx.organizationId,data:row},{before:{dataClass:"financial"},after:{dataClass:"financial"},reason:{dataClass:"financial"}}) as AuditHistoryRow;
  }
  const teamResource = row.action.startsWith("team.compensation.")
    ? "staff_compensation"
    : row.action.startsWith("team.document.")
      ? "staff_document"
      : row.action.startsWith("team.wallet.")
        ? "wallet"
        : row.action.startsWith("team.assignment.")
          ? "role"
          : row.action.startsWith("team.availability.") ||
              row.action === "team.member.offboard" ||
              row.action.startsWith("identity.person.")
            ? "identity"
            : null;
  if (teamResource) {
    const subject =
      row.after &&
      typeof row.after === "object" &&
      !Array.isArray(row.after) &&
      typeof row.after.personId === "string"
        ? row.after.personId
        : row.resourceId;
    const resource = { organizationId: ctx.organizationId, propertyId: row.propertyScopeId };
    const financialTeamSource = teamResource === "staff_compensation" || teamResource === "wallet", teamAt = new Date();
    const teamSource = { ...resource, type: teamResource, id: subject ?? undefined, personId: subject ?? undefined,
      walletId: teamResource === "wallet" ? row.resourceId : undefined };
    const allowed = financialTeamSource ? authorizeUnconditionalSource(ctx.authContext, "view", teamSource, teamAt) &&
      (action !== "export" || authorizeUnconditionalSource(ctx.authContext, "export", teamSource, teamAt)) :
      (teamResource === "identity" && subject === ctx.personId) ||
      authorize(
        ctx.authContext,
        teamResource === "identity" ? "edit" : teamResource === "role" ? "assign" : "view",
        {
          ...resource,
          type: teamResource,
          id: subject ?? undefined
        }
      );
    return present(
      { ...ctx.authContext, visibleDataClasses: new Set(allowed ? [financialTeamSource ? "financial" : "sensitive"] : []) },
      action,
      { ...resource, type: auditLogResource, data: row },
      {
        ...(teamResource === "identity" && !row.action.startsWith("identity.person.")
          ? {}
          : { before: { dataClass: financialTeamSource ? "financial" as const : "sensitive" as const }, after: { dataClass: financialTeamSource ? "financial" as const : "sensitive" as const } }),
        reason: { dataClass: financialTeamSource ? "financial" : "sensitive" }
      }, teamAt
    ) as AuditHistoryRow;
  }
  if (
    !["property_template", "property_template_revision", "config_rule"].includes(row.resourceType) ||
    !["services.pricing", "staff.compensation"].some(key => containsFinancialSetting(row.before, key) || containsFinancialSetting(row.after, key))
  )
    return row;
  const resource = { organizationId: ctx.organizationId, propertyId: row.propertyScopeId,
    ...(financialResource?.propertyId === row.propertyScopeId ? { city: financialResource.city, region: financialResource.region } : {}) }, now = new Date();
  const sources = [["services.pricing", "financial_transaction"], ["staff.compensation", "staff_compensation"]].filter(([key]) =>
    containsFinancialSetting(row.before, key) || containsFinancialSetting(row.after, key)).map(([, type]) => ({ ...resource, type, dataClass: "financial" as const }));
  const financial = sources.every(source => authorizeUnconditionalSource(ctx.authContext, "view", source, now) &&
    (action !== "export" || authorizeUnconditionalSource(ctx.authContext, "export", source, now)));
  return present(
    { ...ctx.authContext, visibleDataClasses: new Set(financial ? ["financial"] : []) },
    action,
    { ...resource, type: auditLogResource, data: row },
    { before: { dataClass: "financial" }, after: { dataClass: "financial" }, reason: { dataClass: "financial" } }, now
  ) as AuditHistoryRow;
}

function db(deps: AuditServiceDeps): TenantTransactionRunner {
  return deps.db ?? prisma;
}

function assertAllowed(ctx: AuditActorContext, action: Action): void {
  const allowed = authorize(ctx.authContext, action, {
    type: auditLogResource,
    organizationId: ctx.organizationId
  });

  if (!allowed) {
    throw new AuditAuthorizationError();
  }
}

export function parseAuditFilters(input: AuditFilterInput): AuditHistoryFilters {
  return auditFilterSchema.parse(input);
}

async function financialAuditResources(repository: AuditRepository, rows: AuditHistoryRow[], organizationId: string): Promise<Map<string, FinancialAuditResource>> {
  const read = <T extends Resource>(type: string, load: (ids: string[]) => Promise<Map<string, T>>) => {
    const ids = [...new Set(rows.filter(row => row.resourceType === type).flatMap(row => row.resourceId ? [row.resourceId] : []))];
    return ids.length ? load(ids) : Promise.resolve(new Map<string, T>());
  };
  const settingRows = rows.filter(row => ["config_rule", "property_template", "property_template_revision"].includes(row.resourceType));
  const [cash, expenses, transactions, accounts, groups, periods, employeeRuns,employeeSubmissions,employeeClaims,monthlyRequests,earningRequests,propertyFinance,serviceAllocations,attachments,settingProperties] = await Promise.all([
    read("cash_collection", ids => repository.cashResources(ids)),
    read("expense", ids => repository.expenseResources(ids)),
    read("financial_transaction", ids => repository.transactionResources(ids)),
    read("ledger_account", ids => repository.ledgerAccountResources(ids)),
    read("transaction_group", ids => repository.transactionGroupResources(ids)),
    read("accounting_period", ids => repository.accountingPeriodResources(ids)),
    read("employee_compensation_run", ids => repository.employeeCompensationRunResources(ids)),
    read("employee_compensation_submission",ids=>repository.employeeCompensationSubmissionResources(ids)),
    read("employee_compensation_claim",ids=>repository.employeeCompensationClaimResources(ids)),
    read("employee_monthly_run_request",ids=>repository.employeeMonthlyRunRequestResources(ids)),
    read("employee_earning_run_request",ids=>repository.employeeEarningRunRequestResources(ids)),
    read("property_finance",ids=>repository.propertyFinanceResources(ids)),
    read("service_allocation",ids=>repository.serviceAllocationResources(ids)),
    read("financial_attachment", ids => repository.financialAttachmentResources(ids)),
    repository.propertyFinanceResources([...new Set(settingRows.flatMap(row => row.propertyScopeId ? [row.propertyScopeId] : []))])
  ]);
  const originalCashIds = [...new Set([...transactions.values()].flatMap(resource => resource.guestPayment?.originalCollectionId ? [resource.guestPayment.originalCollectionId] : []))];
  const originalCash = originalCashIds.length ? await repository.cashResources(originalCashIds) : new Map<string, Resource>();
  for (const [id, resource] of transactions) if (resource.guestPayment?.originalCollectionId) {
    const actual = originalCash.get(resource.guestPayment.originalCollectionId);
    transactions.set(id, { ...resource, guestPayment: { ...resource.guestPayment, cashSource: actual ? { ...actual, occurredAt: resource.guestPayment.receivedAt } : undefined } });
  }
  return new Map([
    ...settingRows.flatMap(row => row.resourceId ? [[`${row.resourceType}:${row.resourceId}`, {
      ...settingProperties.get(row.propertyScopeId ?? ""), type: row.resourceType, organizationId, id: row.resourceId, propertyId: row.propertyScopeId
    }] as const] : []),
    ...[...attachments].map(([id,resource])=>[`financial_attachment:${id}`,resource] as const),
    ...[...serviceAllocations].map(([id,resource])=>[`service_allocation:${id}`,resource]as const),
    ...[...propertyFinance].map(([id,resource])=>[`property_finance:${id}`,resource]as const),
    ...[...cash].map(([id, resource]) => [`cash_collection:${id}`, resource] as const),
    ...[...expenses].map(([id, resource]) => [`expense:${id}`, resource] as const),
    ...[...transactions].map(([id, resource]) => [`financial_transaction:${id}`, resource] as const),
    ...[...accounts].map(([id, resource]) => [`ledger_account:${id}`, resource] as const),
    ...[...groups].map(([id, resource]) => [`transaction_group:${id}`, resource] as const),
    ...[...periods].map(([id, resource]) => [`accounting_period:${id}`, resource] as const),
    ...[...employeeRuns].map(([id,resource])=>[`employee_compensation_run:${id}`,resource] as const),
    ...[...employeeSubmissions].map(([id,resource])=>[`employee_compensation_submission:${id}`,resource] as const),
    ...[...employeeClaims].map(([id,resource])=>[`employee_compensation_claim:${id}`,resource] as const),
    ...[...monthlyRequests].map(([id,resource])=>[`employee_monthly_run_request:${id}`,resource] as const),
    ...[...earningRequests].map(([id,resource])=>[`employee_earning_run_request:${id}`,resource] as const)
  ]);
}

export async function listAuditHistory(
  ctx: AuditActorContext,
  filters: AuditHistoryFilters,
  deps: AuditServiceDeps = {}
): Promise<AuditHistoryResult> {
  assertAllowed(ctx, "view");
  const limit = 100;

  return withTenant(db(deps), ctx.organizationId, async (tx) => {
    const repository = new AuditRepository(tx, ctx.organizationId);
    const [rows, total] = await Promise.all([
      repository.list(filters, limit),
      repository.count(filters)
    ]);

    return { rows:await presentCurrentAuditRows(ctx,tx,repository,rows,"view"), total, limit };
  });
}

/** A caller's retained restrictions and the final stored authority must both permit disclosure. */
async function presentCurrentAuditRows(ctx:AuditActorContext,tx:TenantTransaction,repository:AuditRepository,rows:AuditHistoryRow[],action:"view"|"export"){
  const resources=await financialAuditResources(repository,rows,ctx.organizationId),authContext=await authContextForAccountInTransaction(tx,ctx.organizationId,ctx.actorId),current={...ctx,authContext};
  if(authContext.organizationId!==ctx.organizationId||authContext.userAccountId!==ctx.actorId)throw new AuditAuthorizationError();assertAllowed(ctx,action);assertAllowed(current,action);
  return rows.map(row=>{const source=row.resourceId?resources.get(`${row.resourceType}:${row.resourceId}`):undefined;return presentAuditHistoryRow(current,presentAuditHistoryRow(ctx,row,action,source),action,source);});
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  const text =
    value instanceof Date
      ? value.toISOString()
      : typeof value === "string"
        ? value
        : typeof value === "number" || typeof value === "boolean" || typeof value === "bigint"
          ? String(value)
          : JSON.stringify(value);

  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function auditPayloadCell(value: unknown): string {
  return value === null || value === undefined ? "" : JSON.stringify(value);
}

export function auditHistoryCsv(rows: readonly AuditHistoryRow[]): string {
  const header = [
    "occurred_at",
    "actor_id",
    "action",
    "resource_type",
    "resource_id",
    "property_scope_id",
    "ip_address",
    "device_id",
    "reason",
    "request_id",
    "before",
    "after"
  ];
  const body = rows.map((row) =>
    [
      row.occurredAt,
      row.actorId,
      row.action,
      row.resourceType,
      row.resourceId,
      row.propertyScopeId,
      row.ipAddress,
      row.deviceId,
      row.reason,
      row.requestId,
      auditPayloadCell(row.before),
      auditPayloadCell(row.after)
    ]
      .map(csvCell)
      .join(",")
  );

  return [header.join(","), ...body].join("\r\n");
}

export async function exportAuditHistoryCsv(
  ctx: AuditActorContext,
  filters: AuditHistoryFilters,
  deps: AuditServiceDeps = {}
): Promise<string> {
  assertAllowed(ctx, "export");
  const requestId = deps.requestId ?? crypto.randomUUID();
  const limit = 1000;

  return withTenant(db(deps), ctx.organizationId, async (tx) => {
    const repository = new AuditRepository(tx, ctx.organizationId);
    const rows = await repository.list(filters, limit);

    await writeAuditEvent(tx, {
      organizationId: ctx.organizationId,
      actorId: ctx.actorId,
      action: "audit.export.generated",
      resourceType: auditLogResource,
      resourceId: null,
      ipAddress: deps.ipAddress ?? null,
      after: {
        filters: Object.fromEntries(
          Object.entries(filters).map(([key, value]) => [
            key,
            value instanceof Date ? value.toISOString() : value
          ])
        ),
        rowCount: rows.length
      },
      reason: "Audit history export",
      requestId,
      occurredAt: new Date()
    });

    return auditHistoryCsv(await presentCurrentAuditRows(ctx,tx,repository,rows,"export"));
  });
}
