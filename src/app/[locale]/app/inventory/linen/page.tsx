import Link from "next/link";
import {redirect,notFound} from "next/navigation";
import {getTranslations,setRequestLocale} from "next-intl/server";
import {AdminShell,ShellHeader} from "@/design-system/shells";
import {safeLocale} from "@/i18n/routing";
import {auth} from "@/platform/auth/session";
import {accountActorContextFromSession} from "@/platform/authz/session-context";
import {assertInventoryReorderViewer} from "@/modules/inventory/application/reorder-service";
import {InventoryCatalogAccessError} from "@/modules/inventory/domain/catalog-errors";
import {InventoryStockLevelManager} from "@/modules/inventory/ui/stock-level-manager";
export const dynamic="force-dynamic";
export default async function LinenPoolPage({params}:{params:Promise<{locale:string}>}){const locale=safeLocale((await params).locale);setRequestLocale(locale);const session=await auth();if(session?.user?.securitySetupRequired)redirect("/"+locale+"/app/security");const actor=await accountActorContextFromSession(session);if(!actor)redirect("/"+locale+"/login");try{await assertInventoryReorderViewer(actor);}catch(error){if(error instanceof InventoryCatalogAccessError)notFound();throw error;}const t=await getTranslations("LinenPool");return <AdminShell className="resource-page inventory-page" testId="linen-pool-page"><ShellHeader eyebrow={t("eyebrow")} title={t("title")} subtitle={t("subtitle")} actions={<Link className="secondary-button" href={"/"+locale+"/app"}>{t("back")}</Link>}/><InventoryStockLevelManager key={actor.organizationId+"."+actor.actorId} locale={locale} authorizationScope={actor.organizationId+"."+actor.actorId} linenPool/></AdminShell>;}
