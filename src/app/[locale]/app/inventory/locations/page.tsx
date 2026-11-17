import Link from "next/link";
import {redirect,notFound} from "next/navigation";
import {getTranslations,setRequestLocale} from "next-intl/server";
import {AdminShell,ShellHeader} from "@/design-system/shells";
import {safeLocale} from "@/i18n/routing";
import {auth} from "@/platform/auth/session";
import {accountActorContextFromSession} from "@/platform/authz/session-context";
import {authorizeOrganizationSource} from "@/platform/authz/organization-authority";
import {assertInventoryLocationsViewer} from "@/modules/inventory/application/location-service";
import {InventoryCatalogAccessError} from "@/modules/inventory/domain/catalog-errors";
import {InventoryLocationManager} from "@/modules/inventory/ui/location-manager";
export const dynamic="force-dynamic";
export default async function InventoryLocationsPage({params}:{params:Promise<{locale:string}>}){
 const locale=safeLocale((await params).locale);setRequestLocale(locale);const session=await auth();if(session?.user?.securitySetupRequired)redirect("/"+locale+"/app/security");const actor=await accountActorContextFromSession(session);if(!actor)redirect("/"+locale+"/login");
 try{await assertInventoryLocationsViewer(actor);}catch(error){if(error instanceof InventoryCatalogAccessError)notFound();throw error;}const t=await getTranslations("InventoryLocations"),items=await getTranslations("InventoryItems");
 return <AdminShell className="resource-page" testId="inventory-locations-page"><ShellHeader eyebrow={t("eyebrow")} title={t("title")} subtitle={t("subtitle")} actions={<><Link className="secondary-button" href={"/"+locale+"/app"}>{t("back")}</Link>{authorizeOrganizationSource(actor.authContext,"view",{type:"inventory_item",organizationId:actor.organizationId,dataClass:"operational"},new Date())?<Link className="secondary-button" prefetch={false} href={"/"+locale+"/app/inventory/items"}>{items("title")}</Link>:null}</>}/><InventoryLocationManager locale={locale} authorizationScope={actor.organizationId+"."+actor.actorId}/></AdminShell>;
}
