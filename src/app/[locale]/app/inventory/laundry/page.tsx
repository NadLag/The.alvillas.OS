import Link from "next/link";
import {redirect,notFound} from "next/navigation";
import {getTranslations,setRequestLocale} from "next-intl/server";
import {z} from "zod";
import {AdminShell,ShellHeader} from "@/design-system/shells";
import {safeLocale} from "@/i18n/routing";
import {auth} from "@/platform/auth/session";
import {accountActorContextFromSession} from "@/platform/authz/session-context";
import {assertInventoryMovementsViewer} from "@/modules/inventory/application/movement-service";
import {InventoryCatalogAccessError} from "@/modules/inventory/domain/catalog-errors";
import {LaundryBatchManager} from "@/modules/inventory/ui/laundry-batch-manager";
export const dynamic="force-dynamic";
export default async function LaundryPage({params,searchParams}:{params:Promise<{locale:string}>;searchParams:Promise<{batch?:string}>}){const locale=safeLocale((await params).locale);setRequestLocale(locale);const session=await auth();if(session?.user?.securitySetupRequired)redirect("/"+locale+"/app/security");const actor=await accountActorContextFromSession(session);if(!actor)redirect("/"+locale+"/login");try{await assertInventoryMovementsViewer(actor);}catch(error){if(error instanceof InventoryCatalogAccessError)notFound();throw error;}const input=z.object({batch:z.uuid().optional()}).safeParse(await searchParams);if(!input.success)notFound();const t=await getTranslations("LaundryBatches");return <AdminShell className="resource-page inventory-page" testId="laundry-batch-page"><ShellHeader eyebrow={t("eyebrow")} title={t("title")} subtitle={t("subtitle")} actions={<Link className="secondary-button" href={"/"+locale+"/app"}>{t("back")}</Link>}/><LaundryBatchManager key={actor.organizationId+"."+actor.actorId+":"+(input.data.batch??"")} locale={locale} authorizationScope={actor.organizationId+"."+actor.actorId} initialId={input.data.batch}/></AdminShell>;}
