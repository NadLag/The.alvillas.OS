import { setRequestLocale } from "next-intl/server";
import { safeLocale } from "@/i18n/routing";
import { OwnerLedgerView,type OwnerLedgerSearch } from "@/modules/finance/ui/owner-ledger-view";
export const dynamic="force-dynamic";
export default async function Page({params,searchParams}:{params:Promise<{locale:string;ownerId:string;propertyId:string}>;searchParams:Promise<OwnerLedgerSearch>}){const {locale:value,ownerId,propertyId}=await params,locale=safeLocale(value);setRequestLocale(locale);return <OwnerLedgerView locale={locale} ownerId={ownerId} propertyId={propertyId} query={await searchParams}/>}
