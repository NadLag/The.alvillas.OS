import { safeLocale } from "@/i18n/routing";
import { requireOwnerLedgerAccess } from "@/modules/finance/ui/owner-ledger-access";
export const dynamic="force-dynamic";
export default async function Layout({children,params}:{children:React.ReactNode;params:Promise<{locale:string}>}){const {locale}=await params;await requireOwnerLedgerAccess(safeLocale(locale));return children}
