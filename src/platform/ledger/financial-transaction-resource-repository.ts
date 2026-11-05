import type { TenantTransaction } from "@/platform/db/tenant";
import type { Resource } from "@/platform/authz/authorize";
import { Money } from "@/platform/money/money";
import { employeeCompensationAuthorityLineFields, employeeCompensationRunFacts, employeeCompensationSubmittedFinancialSources, employeeCompensationFinancialSourceFacts } from "@/platform/authz/employee-compensation-resource";
import { employeeSettlementAuditSources } from "./employee-settlement-audit";
import { expenseFundingWalletResource } from "@/modules/finance/domain/expense";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type NativeFinancialResource = Resource & { salarySources?: readonly Resource[];financialSources?:readonly Resource[];companyFinancialSources?:readonly Resource[];walletSources?:readonly Resource[];compensationRoot?:Resource & { sourceRecordId?: string };sourceRecordId?:string;organizationOnlyEmployeeSource?:boolean;
  guestPayment?: { receiptId: string; actorId: string; reason: string | null; provenance: unknown; originalCollectionId: string | null; receivedAt: Date; fundingSources: readonly Resource[]; cashSource?: Resource } };
export const employeeSubmissionFinancialSourceFields={id:true,costOn:true,run:{select:{id:true,createdBy:true,currency:true,createdAt:true,
  lines:{select:employeeCompensationAuthorityLineFields}}},
  costs:{select:{id:true,propertyId:true,reservationId:true,amount:true,timezone:true,runLine:{select:{taskId:true,recordedCompletionAt:true}},property:{select:{cityId:true,regionId:true}}}}} as const;

export function employeeFinancialSources(organizationId:string,row:Parameters<typeof employeeCompensationSubmittedFinancialSources>[1],total:Money,originalSources:readonly Resource[]=[]){const resources=employeeCompensationSubmittedFinancialSources(organizationId,row,total);return{financialSources:[...resources,...originalSources],companyFinancialSources:resources.filter(source=>!source.propertyId)};}

/** Canonical native journal/claim facts shared by audit disclosure and financial attachments. */
export class FinancialTransactionResourceRepository {
  constructor(protected readonly tx: TenantTransaction, protected readonly organizationId: string) {}
  async employeeCompensationClaimResources(ids:string[]):Promise<Map<string,NativeFinancialResource>>{
    if(!ids.length)return new Map();
    const rows=await this.tx.employeeCompensationClaim.findMany({where:{organizationId:this.organizationId,id:{in:ids}},select:{id:true,submission:{select:employeeSubmissionFinancialSourceFields},correction:{select:{lines:{select:{costId:true,reversalTransaction:{select:{id:true,occurredAt:true,createdBy:true}}}}}}}});
    return new Map(rows.map(row=>{const source=row.submission,facts=employeeCompensationRunFacts(this.organizationId,source.run),correctionSources:Resource[]=(row.correction?.lines??[]).flatMap(line=>{
      const cost=source.costs.find(cost=>cost.id===line.costId);if(!cost)throw Error("Original employee correction cost is unavailable");
      const{financial}=employeeCompensationFinancialSourceFacts(this.organizationId,line.reversalTransaction.createdBy??source.run.createdBy,{...cost,taskId:cost.runLine.taskId},line.reversalTransaction.occurredAt);
      return[{...financial,id:line.reversalTransaction.id,financialRecordId:line.reversalTransaction.id},{...financial,amount:facts.total.toJSON().amount}];
    });const financialAudit=employeeFinancialSources(this.organizationId,source,facts.total,[...(facts.financialSources??[]),...correctionSources]);return[row.id,{...facts.resource,sourceRecordId:row.id,salarySources:facts.salarySources,...financialAudit,companyFinancialSources:[...financialAudit.companyFinancialSources,...correctionSources.filter(resource=>!resource.propertyId)]}];}));
  }
  async transactionResources(ids: string[]): Promise<Map<string, NativeFinancialResource>> {
    if (!ids.length) return new Map();
    const rows = await this.tx.financialTransaction.findMany({
      where: { organizationId: this.organizationId, id: { in: ids } },
      select: { id: true, createdBy: true, occurredAt: true,reversesTransactionId:true,employeeRecognitionLine:{select:{recognition:{select:{claimId:true}}}},employeeCorrectionOpposite:{select:{correction:{select:{claimId:true}}}},
        guestPaymentReceipt: { select: { id: true, createdBy: true, provenance: true, originalCollectionId: true, receivedAt: true, amount: true, currency: true, originalAudit: { select: { reason: true } },
          account: { select: { id: true, code: true, name: true, accountType: true, normalSide: true, archivedAt: true, teamWallet: { select: { id: true, personId: true, person: { select: { archivedAt: true } } } } } } } },
        postings: { select: { side: true, amount: true, currency: true, dimensions: true,ledgerAccount:{select:{id:true,code:true,accountType:true,normalSide:true,archivedAt:true,teamWallet:{select:{id:true,personId:true,person:{select:{archivedAt:true}}}}}} } } }
    });
    const employeeClaims=new Map(rows.map(row=>{const ids=new Set(row.postings.flatMap(posting=>{const value=posting.dimensions;if(!value||typeof value!=="object"||Array.isArray(value)||!["EMPLOYEE_PAYMENT","EMPLOYEE_COMPENSATION_OFFSET"].includes(typeof value.source==="string"?value.source:""))return[];const claimId=value.employee_compensation_claim_id;return typeof claimId==="string"&&uuidPattern.test(claimId)?[claimId]:[];}));return[row.id,row.employeeRecognitionLine?.recognition.claimId??row.employeeCorrectionOpposite?.correction.claimId??(ids.size===1?[...ids][0]:undefined)];}));
    const claims=await this.employeeCompensationClaimResources([...employeeClaims.values()].filter((id):id is string=>Boolean(id))),paymentIds=rows.filter(row=>!row.employeeRecognitionLine&&!row.employeeCorrectionOpposite&&employeeClaims.get(row.id)).map(row=>row.reversesTransactionId??row.id),paymentAudits=await this.tx.auditLog.findMany({where:{organizationId:this.organizationId,resourceType:"financial_transaction",resourceId:{in:paymentIds},action:"finance.employee_settlement.posted"},select:{resourceId:true,after:true}}),receipts=new Map(paymentAudits.map(audit=>[audit.resourceId,audit.after]));
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
      const claimId=employeeClaims.get(row.id),claim=claimId?claims.get(claimId):undefined,settlement=Boolean(claimId&&!row.employeeRecognitionLine&&!row.employeeCorrectionOpposite),sources=settlement&&claimId?employeeSettlementAuditSources({organizationId:this.organizationId,claimId,originalJournalId:row.reversesTransactionId??row.id,postedAt:row.occurredAt,receipt:receipts.get(row.reversesTransactionId??row.id),accounts:row.postings.map(posting=>posting.ledgerAccount)}):null;
      const bound=!settlement||sources?.bound,fundingSources=sources?.financialSources??[],walletSources=sources?.walletSources??[];
      const payment = row.guestPaymentReceipt, paymentAmount = payment ? Money.of(payment.amount.toString(), payment.currency).toJSON().amount : undefined,
        paymentWallet = payment ? expenseFundingWalletResource(this.organizationId, payment.account, paymentAmount!, payment.receivedAt) : null;
      // Different currencies cannot be compared with one grant amount limit.
      return [row.id, {
        type: "financial_transaction", organizationId: this.organizationId, id: row.id, financialRecordId: row.id,
        assignedUserAccountId: row.createdBy, occurredAt: row.occurredAt, status: "POSTED",
        propertyId: dimension("property_id"), ownerId: dimension("owner_id"), reservationId: dimension("reservation_id"),
        amount: totals.size === 1 ? [...totals.values()][0].amount.toString() : undefined, dataClass: "financial",
        ...payment ? { guestPayment: { receiptId: payment.id, actorId: payment.createdBy, reason: payment.originalAudit.reason, provenance: payment.provenance,
          originalCollectionId: payment.originalCollectionId, receivedAt: payment.receivedAt,
          fundingSources: [{ type: "financial_transaction", organizationId: this.organizationId, id: payment.account.id, financialRecordId: payment.account.id,
            amount: paymentAmount, occurredAt: payment.receivedAt, dataClass: "financial" }, ...paymentWallet ? [paymentWallet] : []] } } : {},
        ...(claimId?{compensationRoot:bound?claim:undefined,salarySources:claim?.salarySources??[],companyFinancialSources:claim?.companyFinancialSources??[],financialSources:[...(claim?.financialSources??[]),...fundingSources],...(settlement?{walletSources}:{})}: {})
      }];
    }));
  }
}
