import Link from "next/link";
import {redirect,notFound} from "next/navigation";
import {getTranslations,setRequestLocale} from "next-intl/server";
import {AdminShell,ShellHeader} from "@/design-system/shells";
import {safeLocale} from "@/i18n/routing";
import {auth} from "@/platform/auth/session";
import {accountActorContextFromSession} from "@/platform/authz/session-context";
import {assertInventoryCatalogViewer} from "@/modules/inventory/application/item-service";
import {InventoryItemAccessError} from "@/modules/inventory/domain/item-catalog";
import {InventoryItemManager} from "@/modules/inventory/ui/item-manager";
import {authorizeOrganizationSource} from "@/platform/authz/organization-authority";
export const dynamic="force-dynamic";
export default async function InventoryItemsPage({params}:{params:Promise<{locale:string}>}){
 const locale=safeLocale((await params).locale);setRequestLocale(locale);const session=await auth();
 if(session?.user?.securitySetupRequired)redirect("/"+locale+"/app/security");
 const actor=await accountActorContextFromSession(session);if(!actor)redirect("/"+locale+"/login");
 try{await assertInventoryCatalogViewer(actor);}catch(error){if(error instanceof InventoryItemAccessError)notFound();throw error;}
 const t=await getTranslations("InventoryItems");
 return <AdminShell className="resource-page" testId="inventory-items-page"><ShellHeader eyebrow={t("eyebrow")} title={t("title")} subtitle={t("subtitle")} actions={<><Link className="secondary-button" href={"/"+locale+"/app"}>{t("back")}</Link>{authorizeOrganizationSource(actor.authContext,"view",{type:"inventory_location",organizationId:actor.organizationId,dataClass:"operational"},new Date())?<Link className="secondary-button" prefetch={false} href={"/"+locale+"/app/inventory/locations"}>{(await getTranslations("InventoryLocations"))("title")}</Link>:null}</>}/><InventoryItemManager locale={locale} authorizationScope={actor.organizationId+"."+actor.actorId}/></AdminShell>;
}
