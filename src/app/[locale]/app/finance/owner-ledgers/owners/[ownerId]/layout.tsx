import { safeLocale } from "@/i18n/routing";
import { requireOwnerLedgerAccess } from "@/modules/finance/ui/owner-ledger-access";
export default async function Layout({children,params}:{children:React.ReactNode;params:Promise<{locale:string;ownerId:string}>}){const {locale,ownerId}=await params;await requireOwnerLedgerAccess(safeLocale(locale),ownerId);return children}
