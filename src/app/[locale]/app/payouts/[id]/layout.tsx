import { safeLocale } from "@/i18n/routing";
import { ownerPayoutPage } from "@/modules/finance/ui/owner-payout-page-access";

export default async function Layout({children,params}:{children:React.ReactNode;params:Promise<{locale:string;id:string}>}){
  const {locale,id}=await params;await ownerPayoutPage(safeLocale(locale),id);return children;
}
