import { FinancialTransactionResourceRepository, employeeSubmissionFinancialSourceFields, employeeFinancialSources, type NativeFinancialResource } from "@/platform/ledger/financial-transaction-resource-repository";
import { FinancialAttachmentSourceRepository } from "@/platform/ledger/financial-attachment-source-repository";
import type { CurrentAuthorityCheck } from "@/platform/authz/current-authority";
import type { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import type { Resource } from "@/platform/authz/authorize";
import { employeeCompensationAuthorityLineFields,employeeCompensationRunFacts } from "@/platform/authz/employee-compensation-resource";
import { employeeMonthlyRequestAuthorityFacts } from "@/platform/authz/employee-monthly-request-resource";
import { employeeEarningRequestAuthorityFacts,employeeEarningRequestSourceFields } from "@/platform/authz/employee-earning-request-resource";
import { externalPaymentSourceSchema } from "@/platform/ledger/external-payment-source";
import { Money } from "@/platform/money/money";
import { externalPaymentFinancialSources, type ExternalPaymentFinancialSources } from "@/platform/authz/external-payment-resource";
import { expenseResource } from "@/platform/authz/expense-resource";

export type FinancialAuditResource = NativeFinancialResource & { attachmentSource?: NativeFinancialResource; attachmentRootId?: string; attachmentChecks?: readonly CurrentAuthorityCheck[]; externalPayment?: ExternalPaymentFinancialSources };

export type AuditHistoryFilters = {
  action?: string;
  resourceType?: string;
  actorId?: string;
  resourceId?: string;
  propertyScopeId?: string;
  from?: Date;
  to?: Date;
};

export type AuditHistoryRow = {
  id: string;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  ipAddress: string | null;
  deviceId: string | null;
  propertyScopeId: string | null;
  before: Prisma.JsonValue | null;
  after: Prisma.JsonValue | null;
  reason: string | null;
  requestId: string;
  occurredAt: Date;
  createdAt: Date;
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function uuidFilter(value: string | undefined): string | undefined {
  return value && uuidPattern.test(value) ? value : undefined;
}

function whereFor(organizationId: string, filters: AuditHistoryFilters): Prisma.AuditLogWhereInput {
  return {
    organizationId,
    ...(filters.action
      ? { action: { contains: filters.action, mode: "insensitive" as const } }
      : {}),
    ...(filters.resourceType
      ? { resourceType: { contains: filters.resourceType, mode: "insensitive" as const } }
      : {}),
    ...(uuidFilter(filters.actorId) ? { actorId: uuidFilter(filters.actorId) } : {}),
    ...(uuidFilter(filters.resourceId) ? { resourceId: uuidFilter(filters.resourceId) } : {}),
    ...(uuidFilter(filters.propertyScopeId)
      ? { propertyScopeId: uuidFilter(filters.propertyScopeId) }
      : {}),
    ...(filters.from || filters.to
      ? {
          occurredAt: {
            ...(filters.from ? { gte: filters.from } : {}),
            ...(filters.to ? { lte: filters.to } : {})
          }
        }
      : {})
  };
}

export class AuditRepository {
  constructor(
    private readonly tx: TenantTransaction,
    private readonly organizationId: string
  ) {}

  async list(filters: AuditHistoryFilters, limit: number): Promise<AuditHistoryRow[]> {
    return this.tx.auditLog.findMany({
      where: whereFor(this.organizationId, filters),
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: limit
    });
  }

  async count(filters: AuditHistoryFilters): Promise<number> {
    return this.tx.auditLog.count({
      where: whereFor(this.organizationId, filters)
    });
  }
  async employeeCompensationRunResources(ids: string[]): Promise<Map<string, FinancialAuditResource>> {
    if (!ids.length) return new Map();
    const rows = await this.tx.employeeCompensationRun.findMany({ where: { organizationId: this.organizationId, id: { in: ids } },
      select: { id: true, currency: true, createdAt: true, lines: { select: employeeCompensationAuthorityLineFields } } });
    return new Map(rows.map(row => { const facts = employeeCompensationRunFacts(this.organizationId,row);
      return [row.id,{ ...facts.resource, salarySources:facts.salarySources,...facts.financialSources?{financialSources:facts.financialSources}:{} }]; }));
  }
  async employeeMonthlyRunRequestResources(ids:string[]):Promise<Map<string,FinancialAuditResource>>{
    const rows=await this.tx.employeeMonthlyRunRequest.findMany({where:{organizationId:this.organizationId,id:{in:ids}}}),facts=await employeeMonthlyRequestAuthorityFacts(this.organizationId,rows,this.tx);
    return new Map([...facts].map(([id,source])=>[id,{...source.resource,sourceRecordId:id,salarySources:source.salarySources,organizationOnlyEmployeeSource:source.legacy}]));
  }
  async employeeEarningRunRequestResources(ids:string[]):Promise<Map<string,FinancialAuditResource>>{
    const rows=await this.tx.employeeEarningRunRequest.findMany({where:{organizationId:this.organizationId,id:{in:ids}},include:{sources:{orderBy:{id:"asc"},select:employeeEarningRequestSourceFields}}});
    return new Map(rows.map(row=>{const facts=employeeEarningRequestAuthorityFacts(this.organizationId,row);return[row.id,{...facts.resource,sourceRecordId:row.id,salarySources:facts.salarySources,...facts.financialSources?.length?{financialSources:facts.financialSources}:{}}];}));
  }
  async employeeCompensationSubmissionResources(ids:string[]):Promise<Map<string,FinancialAuditResource>>{
    if(!ids.length)return new Map();
    const rows=await this.tx.employeeCompensationSubmission.findMany({where:{organizationId:this.organizationId,id:{in:ids}},select:employeeSubmissionFinancialSourceFields});
    return new Map(rows.map(row=>{const facts=employeeCompensationRunFacts(this.organizationId,row.run);return[row.id,{...facts.resource,sourceRecordId:row.id,salarySources:facts.salarySources,...employeeFinancialSources(this.organizationId,row,facts.total,facts.financialSources)}];}));
  }
  employeeCompensationClaimResources(ids: string[]): Promise<Map<string, FinancialAuditResource>> {
    return new FinancialTransactionResourceRepository(this.tx, this.organizationId).employeeCompensationClaimResources(ids);
  }
  async cashResources(ids: string[]): Promise<Map<string, Resource>> {
    if (!ids.length) return new Map();
    const rows = await this.tx.cashCollection.findMany({ where: { organizationId: this.organizationId, id: { in: ids } },
      select: { id: true, taskId: true, propertyId: true, reservationId: true, transactionId: true, collectorUserAccountId: true, collectorPersonId: true, amount: true,
        task: { select: { state: true } }, property: { select: { city: true, cityId: true, region: true, regionId: true } } } });
    return new Map(rows.map(row => [row.id, { type: "cash_collection", organizationId: this.organizationId, id: row.id,
      financialRecordId: row.transactionId, propertyId: row.propertyId, reservationId: row.reservationId, taskId: row.taskId, jobId: row.taskId,
      assignedUserAccountId: row.collectorUserAccountId, assignedPersonId: row.collectorPersonId, amount: row.amount.toString(),
      city: row.property.cityId ?? row.property.city, region: row.property.regionId ?? row.property.region, status: row.task.state, dataClass: "financial" }]));
  }
  async ledgerAccountResources(ids: string[]): Promise<Map<string, Resource>> {
    if (!ids.length) return new Map();
    const rows = await this.tx.ledgerAccount.findMany({
      where: { organizationId: this.organizationId, id: { in: ids } }, select: { id: true }
    });
    return new Map(rows.map(row => [row.id, {
      type: "financial_transaction", organizationId: this.organizationId, id: row.id,
      financialRecordId: row.id, dataClass: "financial"
    }]));
  }
  async transactionGroupResources(ids: string[]): Promise<Map<string, Resource>> {
    if (!ids.length) return new Map();
    const rows = await this.tx.transactionGroup.findMany({ where: { organizationId: this.organizationId, id: { in: ids } }, select: { id: true } });
    return new Map(rows.map(row => [row.id, { type: "financial_transaction", organizationId: this.organizationId, id: row.id, dataClass: "financial" }]));
  }
  async accountingPeriodResources(ids: string[]): Promise<Map<string, Resource>> {
    if (!ids.length) return new Map();
    const rows = await this.tx.accountingPeriod.findMany({ where: { organizationId: this.organizationId, id: { in: ids } }, select: { id: true } });
    return new Map(rows.map(row => [row.id, { type: "financial_transaction", organizationId: this.organizationId, id: row.id, dataClass: "financial" }]));
  }
  async serviceAllocationResources(ids:string[]):Promise<Map<string,FinancialAuditResource>>{
    if(!ids.length)return new Map();const rows=await this.tx.serviceFinancialSource.findMany({where:{organizationId:this.organizationId,id:{in:[...new Set(ids)]}},select:{id:true,collection:{select:{propertyId:true,reservationId:true,taskId:true,amount:true,currency:true,property:{select:{city:true,region:true,cityId:true,regionId:true}}}}}});
    return new Map(rows.map(row=>[row.id,{type:"service_allocation",organizationId:this.organizationId,id:row.id,financialRecordId:row.id,propertyId:row.collection.propertyId,reservationId:row.collection.reservationId,jobId:row.collection.taskId,taskId:row.collection.taskId,city:row.collection.property.cityId??row.collection.property.city,region:row.collection.property.regionId??row.collection.property.region,amount:row.collection.amount.toFixed(2),dataClass:"financial"}]));
  }
  async propertyFinanceResources(ids:string[]):Promise<Map<string,FinancialAuditResource>>{
    if(!ids.length)return new Map();const rows=await this.tx.property.findMany({where:{organizationId:this.organizationId,id:{in:ids}},select:{id:true,cityId:true,regionId:true}});
    return new Map(rows.map(row=>[row.id,{type:"property_finance",organizationId:this.organizationId,id:row.id,propertyId:row.id,city:row.cityId,region:row.regionId,dataClass:"financial"}]));
  }
  async financialAttachmentResources(ids: string[]): Promise<Map<string, FinancialAuditResource>> {
    if (!ids.length) return new Map();
    const rows = await this.tx.financialAttachmentAdmission.findMany({ where: { organizationId: this.organizationId, id: { in: ids } },
      select: { id: true, transactionId: true, attachment: { select: { rootId: true } }, supersedes: { select: { rootId: true } } } });
    const repository = new FinancialAttachmentSourceRepository(this.tx, this.organizationId), result = new Map<string, FinancialAuditResource>();
    for (const row of rows) { const native = await repository.source(row.transactionId); if (native) result.set(row.id, {
      type: "financial_attachment", organizationId: this.organizationId, id: row.id, attachmentSource: native.source,
      attachmentRootId: row.attachment?.rootId ?? row.supersedes?.rootId ?? row.id, attachmentChecks: native.extraChecks }); }
    return result;
  }
  async transactionResources(ids: string[]): Promise<Map<string, FinancialAuditResource>> {
    const result: Map<string, FinancialAuditResource> = await new FinancialTransactionResourceRepository(this.tx, this.organizationId).transactionResources(ids);
    if (!ids.length) return result;
    const requests = await this.tx.externalPaymentIntent.findMany({ where: { organizationId: this.organizationId, id: { in: ids } },
      select: { id: true, requestedBy: true, reservationId: true, accountId: true, amount: true, currency: true, sourceSnapshot: true,
        capture: { select: { capturedAt: true, amount: true, currency: true, fee: { select: { expense: { select: { id: true, state: true, amount: true, currency: true, createdBy: true } } } } } } } });
    for (const request of requests) {
      const parsed = externalPaymentSourceSchema.safeParse(request.sourceSnapshot); if (!parsed.success || result.has(request.id)) continue;
      const source = parsed.data, amount = Money.of(request.amount.toString(), request.currency).toJSON().amount;
      if (source.organizationId !== this.organizationId || source.userAccountId !== request.requestedBy || source.reservationId !== request.reservationId ||
          source.accountId !== request.accountId || source.amount.amount !== amount || source.amount.currency !== request.currency ||
          request.capture && (!request.capture.capturedAt || !request.capture.amount.eq(request.amount) || request.capture.currency !== request.currency)) continue;
      const sources = externalPaymentFinancialSources(request.id, source, request.capture?.capturedAt);
      const expense = request.capture?.fee?.expense;
      if (expense && sources.capture) sources.fee = { ...sources.capture, type: "expense", id: expense.id, financialRecordId: expense.id,
        status: expense.state, assignedUserAccountId: expense.createdBy, amount: Money.of(expense.amount.toString(), expense.currency).toJSON().amount };
      result.set(request.id, { ...sources.original, externalPayment: sources });
    }
    return result;
  }
  async expenseResources(ids: string[]): Promise<Map<string, Resource>> {
    if (!ids.length) return new Map();
    const rows = await this.tx.expense.findMany({ where: { organizationId: this.organizationId, id: { in: ids } },
      select: { id: true, propertyId: true, reservationId: true, amount: true, state: true, createdBy: true, occurredOn: true, externalPaymentFee: { select: { capture: { select: { capturedAt: true } } } },
        property: { select: { city: true, cityId: true, region: true, regionId: true, timezone: true } } } });
    return new Map(rows.map(row => [row.id, expenseResource(this.organizationId, { ...row.property, id: row.propertyId }, { ...row, amount: row.amount.toString() })]));
  }
}
