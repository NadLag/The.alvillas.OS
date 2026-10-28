import { safeLocale } from "@/i18n/routing";
import { requireSupplierAccess } from "@/modules/finance/ui/supplier-access";
export const dynamic = "force-dynamic";
export default async function Layout({ params, children }: { params: Promise<{ locale: string }>; children: React.ReactNode }) {
  const { locale } = await params; await requireSupplierAccess(safeLocale(locale)); return children;
}
