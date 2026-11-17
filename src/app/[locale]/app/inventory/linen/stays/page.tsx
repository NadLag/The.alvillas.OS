import Link from "next/link";
import {z} from "zod";
import {redirect,notFound} from "next/navigation";
import {getTranslations,setRequestLocale} from "next-intl/server";
import {AdminShell,ShellHeader} from "@/design-system/shells";
import {safeLocale} from "@/i18n/routing";
import {auth} from "@/platform/auth/session";
import {accountActorContextFromSession} from "@/platform/authz/session-context";
import {assertInventoryMovementsViewer} from "@/modules/inventory/application/movement-service";
import {InventoryCatalogAccessError} from "@/modules/inventory/domain/catalog-errors";
import {InventoryStayConsumptionManager} from "@/modules/inventory/ui/stay-consumption-manager";
export const dynamic="force-dynamic";
export default async function StayLinenPage({params,searchParams}:{params:Promise<{locale:string}>;searchParams:Promise<{reservation?:string}>}){const query=await searchParams;if(query.reservation&&!z.uuid().safeParse(query.reservation).success)notFound();const locale=safeLocale((await params).locale);setRequestLocale(locale);const session=await auth();if(session?.user?.securitySetupRequired)redirect("/"+locale+"/app/security");const actor=await accountActorContextFromSession(session);if(!actor)redirect("/"+locale+"/login");try{await assertInventoryMovementsViewer(actor);}catch(error){if(error instanceof InventoryCatalogAccessError)notFound();throw error;}const t=await getTranslations("LinenPool");return <AdminShell className="resource-page inventory-page" testId="stay-linen-page"><ShellHeader eyebrow={t("eyebrow")} title={t("stayTitle")} subtitle={t("staySubtitle")} actions={<Link className="secondary-button" href={"/"+locale+"/app/inventory/linen"}>{t("title")}</Link>}/><InventoryStayConsumptionManager key={actor.organizationId+"."+actor.actorId+":"+(query.reservation??"")} locale={locale} authorizationScope={actor.organizationId+"."+actor.actorId} initialReservationId={query.reservation} linenOnly/></AdminShell>;}
