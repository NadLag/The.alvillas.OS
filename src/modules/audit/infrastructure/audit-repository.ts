import type { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import type { Resource } from "@/platform/authz/authorize";
import { calendarDateStart } from "@/platform/time/calendar";
import { Money } from "@/platform/money/money";
import { employeeCompensationAuthorityLineFields,employeeCompensationRunFacts,employeeCompensationSubmittedFinancialSources } from "@/platform/authz/employee-compensation-resource";
import { employeeSettlementAuditSources } from "@/platform/ledger/employee-settlement-audit";
import { employeeMonthlyRequestAuthorityFacts } from "@/platform/authz/employee-monthly-request-resource";
import { employeeEarningRequestAuthorityFacts,employeeEarningRequestSourceFields } from "@/platform/authz/employee-earning-request-resource";

export type FinancialAuditResource = Resource & { salarySources?: readonly Resource[];financialSources?:readonly Resource[];companyFinancialSources?:readonly Resource[];walletSources?:readonly Resource[];compensationRoot?:Resource;sourceRecordId?:string;organizationOnlyEmployeeSource?:boolean };
const employeeSubmissionAuditFields={id:true,costOn:true,run:{select:{id:true,createdBy:true,currency:true,createdAt:true,
  lines:{select:employeeCompensationAuthorityLineFields}}},
  costs:{select:{propertyId:true,reservationId:true,amount:true,timezone:true,runLine:{select:{taskId:true,recordedCompletionAt:true}},property:{select:{cityId:true,regionId:true}}}}} as const;

function employeeFinancialAuditSources(organizationId:string,row:Parameters<typeof employeeCompensationSubmittedFinancialSources>[1],total:Money,originalSources:readonly Resource[]=[]){const resources=employeeCompensationSubmittedFinancialSources(organizationId,row,total);return{financialSources:[...resources,...originalSources],companyFinancialSources:resources.filter(source=>!source.propertyId)};}

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
    const rows=await this.tx.employeeCompensationSubmission.findMany({where:{organizationId:this.organizationId,id:{in:ids}},select:employeeSubmissionAuditFields});
    return new Map(rows.map(row=>{const facts=employeeCompensationRunFacts(this.organizationId,row.run);return[row.id,{...facts.resource,sourceRecordId:row.id,salarySources:facts.salarySources,...employeeFinancialAuditSources(this.organizationId,row,facts.total,facts.financialSources)}];}));
  }
  async employeeCompensationClaimResources(ids:string[]):Promise<Map<string,FinancialAuditResource>>{
    if(!ids.length)return new Map();
    const rows=await this.tx.employeeCompensationClaim.findMany({where:{organizationId:this.organizationId,id:{in:ids}},select:{id:true,submission:{select:employeeSubmissionAuditFields}}});
    return new Map(rows.map(row=>{const source=row.submission,facts=employeeCompensationRunFacts(this.organizationId,source.run);return[row.id,{...facts.resource,sourceRecordId:row.id,salarySources:facts.salarySources,...employeeFinancialAuditSources(this.organizationId,source,facts.total,facts.financialSources)}];}));
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
  async transactionResources(ids: string[]): Promise<Map<string, FinancialAuditResource>> {
    if (!ids.length) return new Map();
    const rows = await this.tx.financialTransaction.findMany({
      where: { organizationId: this.organizationId, id: { in: ids } },
      select: { id: true, createdBy: true, occurredAt: true,reversesTransactionId:true,employeeRecognitionLine:{select:{recognition:{select:{claimId:true}}}},
        postings: { select: { side: true, amount: true, currency: true, dimensions: true,ledgerAccount:{select:{id:true,code:true,accountType:true,normalSide:true,archivedAt:true,teamWallet:{select:{id:true,personId:true,person:{select:{archivedAt:true}}}}}} } } }
    });
    const employeeClaims=new Map(rows.map(row=>{const ids=new Set(row.postings.flatMap(posting=>{const value=posting.dimensions;if(!value||typeof value!=="object"||Array.isArray(value)||!["EMPLOYEE_PAYMENT","EMPLOYEE_COMPENSATION_OFFSET"].includes(typeof value.source==="string"?value.source:""))return[];const claimId=value.employee_compensation_claim_id;return typeof claimId==="string"&&uuidPattern.test(claimId)?[claimId]:[];}));return[row.id,row.employeeRecognitionLine?.recognition.claimId??(ids.size===1?[...ids][0]:undefined)];}));
    const claims=await this.employeeCompensationClaimResources([...employeeClaims.values()].filter((id):id is string=>Boolean(id))),paymentIds=rows.filter(row=>!row.employeeRecognitionLine&&employeeClaims.get(row.id)).map(row=>row.reversesTransactionId??row.id),paymentAudits=await this.tx.auditLog.findMany({where:{organizationId:this.organizationId,resourceType:"financial_transaction",resourceId:{in:paymentIds},action:"finance.employee_settlement.posted"},select:{resourceId:true,after:true}}),receipts=new Map(paymentAudits.map(audit=>[audit.resourceId,audit.after]));
    return new Map(rows.map(row => {
      const totals = new Map<string, Money>();
      for (const line of row.postings) if (line.side === "DEBIT") {
        const amount = Money.of(line.amount.toString(), line.currency);
        totals.set(line.currency, (totals.get(line.currency) ?? Money.zero(line.currency)).add(amount));
      }
      const dimension = (key: string) => {
        const ids = new Set(row.postings.flatMap(line => {
          const value = line.dimensions && typeof line.dimensions === "object" && !Array.isArray(line.dimensions)
            ? line.dimensions[key] : null;
          return typeof value === "string" && uuidPattern.test(value) ? [value] : [];
        }));
        return ids.size === 1 ? [...ids][0] : undefined;
      };
      const claimId=employeeClaims.get(row.id),claim=claimId?claims.get(claimId):undefined,settlement=Boolean(claimId&&!row.employeeRecognitionLine),sources=settlement&&claimId?employeeSettlementAuditSources({organizationId:this.organizationId,claimId,originalJournalId:row.reversesTransactionId??row.id,postedAt:row.occurredAt,receipt:receipts.get(row.reversesTransactionId??row.id),accounts:row.postings.map(posting=>posting.ledgerAccount)}):null;
      const bound=!settlement||sources?.bound,fundingSources=sources?.financialSources??[],walletSources=sources?.walletSources??[];
      // Different currencies cannot be compared with one grant amount limit.
      return [row.id, {
        type: "financial_transaction", organizationId: this.organizationId, id: row.id, financialRecordId: row.id,
        assignedUserAccountId: row.createdBy, occurredAt: row.occurredAt, status: "POSTED",
        propertyId: dimension("property_id"), ownerId: dimension("owner_id"), reservationId: dimension("reservation_id"),
        amount: totals.size === 1 ? [...totals.values()][0].amount.toString() : undefined, dataClass: "financial",
        ...(claimId?{compensationRoot:bound?claim:undefined,salarySources:claim?.salarySources??[],companyFinancialSources:claim?.companyFinancialSources??[],financialSources:[...(claim?.financialSources??[]),...fundingSources],...(settlement?{walletSources}:{})}: {})
      }];
    }));
  }
  async expenseResources(ids: string[]): Promise<Map<string, Resource>> {
    if (!ids.length) return new Map();
    const rows = await this.tx.expense.findMany({ where: { organizationId: this.organizationId, id: { in: ids } },
      select: { id: true, propertyId: true, reservationId: true, amount: true, state: true, createdBy: true, occurredOn: true,
        property: { select: { city: true, cityId: true, region: true, regionId: true, timezone: true } } } });
    return new Map(rows.map(row => [row.id, { type: "expense", organizationId: this.organizationId, id: row.id, financialRecordId: row.id,
      propertyId: row.propertyId, reservationId: row.reservationId, amount: row.amount.toString(), occurredAt: calendarDateStart(row.occurredOn.toISOString().slice(0,10), row.property.timezone),
      assignedUserAccountId: row.createdBy, city: row.property.cityId ?? row.property.city, region: row.property.regionId ?? row.property.region,
      status: row.state, dataClass: "financial" }]));
  }
}
