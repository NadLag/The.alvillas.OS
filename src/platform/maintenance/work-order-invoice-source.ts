import { getSupplierInvoice } from "@/modules/finance/application/supplier-invoice-service";
import { SupplierInvoiceAccessError } from "@/modules/finance/application/supplier-invoice-access";
import { WorkOrderAccessError } from "@/modules/maintenance/domain/work-order";
import type { AccountActorContext } from "@/platform/authz/session-context";
import type { TenantTransaction } from "@/platform/db/tenant";
import { Money } from "@/platform/money/money";

export async function readWorkOrderInvoice(
  actor: AccountActorContext,
  tx: TenantTransaction,
  source: { invoiceId: string; propertyId: string; reservationId: string | null }
) {
  try {
    const invoice = await getSupplierInvoice(actor, source.invoiceId, {}, { db: { $transaction: async work => work(tx) } });
    if (!invoice.lines.length || invoice.lines.some(line =>
      line.propertyId !== source.propertyId || !line.propertyName ||
      (line.reservationId !== null && (line.reservationId !== source.reservationId || !line.reservationReference))
    )) throw new WorkOrderAccessError();
    return {
      id: invoice.id, version: invoice.version, state: invoice.state, label: invoice.reference,
      money: Money.of(invoice.amount, invoice.currency).toJSON(), approvalId: invoice.approvalId
    };
  } catch (error) {
    if (error instanceof SupplierInvoiceAccessError) throw new WorkOrderAccessError();
    throw error;
  }
}
