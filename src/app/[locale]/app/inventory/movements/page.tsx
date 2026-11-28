import {z} from "zod";
import Link from "next/link";
import {redirect,notFound} from "next/navigation";
import {getTranslations,setRequestLocale} from "next-intl/server";
import {AdminShell,ShellHeader} from "@/design-system/shells";
import {safeLocale} from "@/i18n/routing";
import {auth} from "@/platform/auth/session";
import {accountActorContextFromSession} from "@/platform/authz/session-context";
import {assertInventoryMovementsViewer} from "@/modules/inventory/application/movement-service";
import {InventoryCatalogAccessError} from "@/modules/inventory/domain/catalog-errors";
import {InventoryMovementManager} from "@/modules/inventory/ui/movement-manager";
export const dynamic="force-dynamic";
export default async function InventoryMovementsPage({params,searchParams}:{params:Promise<{locale:string}>;searchParams:Promise<{movement?:string}>}){
 const query=await searchParams,parsed=query.movement?z.uuid().safeParse(query.movement):null;if(parsed&&!parsed.success)notFound();const initialGroupId=parsed?.success?parsed.data:undefined;const locale=safeLocale((await params).locale);setRequestLocale(locale);const session=await auth();if(session?.user?.securitySetupRequired)redirect("/"+locale+"/app/security");const actor=await accountActorContextFromSession(session);if(!actor)redirect("/"+locale+"/login");
 try{await assertInventoryMovementsViewer(actor);}catch(error){if(error instanceof InventoryCatalogAccessError)notFound();throw error;}const t=await getTranslations("InventoryMovements");
 return <AdminShell className="resource-page inventory-page" testId="inventory-movements-page"><ShellHeader eyebrow={t("eyebrow")} title={t("title")} subtitle={t("subtitle")} actions={<Link className="secondary-button" href={"/"+locale+"/app"}>{t("back")}</Link>}/><InventoryMovementManager key={actor.organizationId+"."+actor.actorId+":"+(initialGroupId??"")} initialGroupId={initialGroupId} locale={locale} authorizationScope={actor.organizationId+"."+actor.actorId}/></AdminShell>;
}
