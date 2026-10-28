import { safeLocale } from "@/i18n/routing";
import { requireSupplierInvoiceAccess } from "@/modules/finance/ui/supplier-invoice-access";
export default async function Layout({ children, params }: { children: React.ReactNode; params: Promise<{ locale: string }> }) {
  await requireSupplierInvoiceAccess(safeLocale((await params).locale)); return children;
}
