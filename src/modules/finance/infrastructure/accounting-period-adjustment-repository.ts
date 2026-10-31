import type { TenantTransaction } from "@/platform/db/tenant";

export class AccountingPeriodAdjustmentRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}
  create(input: ({ expenseId: string; invoiceRecognitionLineId?: never;employeeRecognitionLineId?:never } | { expenseId?: never; invoiceRecognitionLineId: string;employeeRecognitionLineId?:never } | {expenseId?:never;invoiceRecognitionLineId?:never;employeeRecognitionLineId:string}) &
    { transactionId: string; periodId: string; periodEventId: string; sourceOccurredAt: Date; createdBy: string; reason: string }) {
    return this.tx.accountingPeriodAdjustment.create({ data: { organizationId: this.organizationId, ...input } });
  }
}
