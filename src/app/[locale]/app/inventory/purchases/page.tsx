import Link from "next/link";
import {redirect,notFound} from "next/navigation";
import {getTranslations,setRequestLocale} from "next-intl/server";
import {AdminShell,ShellHeader} from "@/design-system/shells";
import {safeLocale} from "@/i18n/routing";
import {auth} from "@/platform/auth/session";
import {accountActorContextFromSession} from "@/platform/authz/session-context";
import {assertInventoryMovementsViewer} from "@/modules/inventory/application/movement-service";
import {InventoryCatalogAccessError} from "@/modules/inventory/domain/catalog-errors";
import {InventoryPurchaseManager} from "@/modules/inventory/ui/purchase-manager";
import {inventoryPurchaseEntrySchema} from "@/modules/inventory/domain/purchase-expense";
export const dynamic="force-dynamic";
export default async function InventoryPurchasePage({params,searchParams}:{params:Promise<{locale:string}>;searchParams:Promise<{source?:string;id?:string}>}){
 const query=await searchParams,entry=inventoryPurchaseEntrySchema.safeParse({kind:query.source,id:query.id});if((query.source||query.id)&&!entry.success)notFound();const locale=safeLocale((await params).locale);setRequestLocale(locale);const session=await auth();if(session?.user?.securitySetupRequired)redirect("/"+locale+"/app/security");const actor=await accountActorContextFromSession(session);if(!actor)redirect("/"+locale+"/login");
 try{await assertInventoryMovementsViewer(actor);}catch(error){if(error instanceof InventoryCatalogAccessError)notFound();throw error;}const t=await getTranslations("InventoryPurchases");
 return <AdminShell className="resource-page inventory-page" testId="inventory-purchase-page"><ShellHeader eyebrow={t("eyebrow")} title={t("title")} subtitle={t("subtitle")} actions={<Link className="secondary-button" href={"/"+locale+"/app"}>{t("back")}</Link>}/>{entry.success?<InventoryPurchaseManager key={actor.organizationId+"."+actor.actorId+":"+entry.data.kind+":"+entry.data.id} entry={entry.data} locale={locale} authorizationScope={actor.organizationId+"."+actor.actorId}/>:<p>{t("sourceHelp")}</p>}</AdminShell>;
}
