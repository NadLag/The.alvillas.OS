import Link from "next/link";
import {redirect,notFound} from "next/navigation";
import {getTranslations,setRequestLocale} from "next-intl/server";
import {AdminShell,ShellHeader} from "@/design-system/shells";
import {safeLocale} from "@/i18n/routing";
import {auth} from "@/platform/auth/session";
import {accountActorContextFromSession} from "@/platform/authz/session-context";
import {assertInventoryMovementsViewer} from "@/modules/inventory/application/movement-service";
import {InventoryCatalogAccessError} from "@/modules/inventory/domain/catalog-errors";
import {InventoryStocktakeManager} from "@/modules/inventory/ui/stocktake-manager";
export const dynamic="force-dynamic";
export default async function InventoryStocktakePage({params}:{params:Promise<{locale:string}>}){
 const locale=safeLocale((await params).locale);setRequestLocale(locale);const session=await auth();if(session?.user?.securitySetupRequired)redirect("/"+locale+"/app/security");const actor=await accountActorContextFromSession(session);if(!actor)redirect("/"+locale+"/login");
 try{await assertInventoryMovementsViewer(actor);}catch(error){if(error instanceof InventoryCatalogAccessError)notFound();throw error;}const t=await getTranslations("InventoryStocktakes");
 return <AdminShell className="resource-page inventory-page" testId="inventory-stocktake-page"><ShellHeader eyebrow={t("eyebrow")} title={t("title")} subtitle={t("subtitle")} actions={<Link className="secondary-button" href={"/"+locale+"/app"}>{t("back")}</Link>}/><InventoryStocktakeManager key={actor.organizationId+"."+actor.actorId} locale={locale} authorizationScope={actor.organizationId+"."+actor.actorId}/></AdminShell>;
}
