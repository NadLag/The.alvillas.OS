import { safeLocale } from "@/i18n/routing";
import { requireCompanyLedgerAccess } from "@/modules/finance/ui/company-ledger-access";
export const dynamic = "force-dynamic";
export default async function Layout({ children, params }: { children: React.ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  await requireCompanyLedgerAccess(safeLocale(locale));
  return children;
}
