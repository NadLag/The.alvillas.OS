import Link from "next/link";
import {redirect,notFound} from "next/navigation";
import {getTranslations,setRequestLocale} from "next-intl/server";
import {z} from "zod";
import {AdminShell,ShellHeader} from "@/design-system/shells";
import {safeLocale} from "@/i18n/routing";
import {auth} from "@/platform/auth/session";
import {accountActorContextFromSession} from "@/platform/authz/session-context";
import {actualLaundryInvoiceContext} from "@/modules/inventory/application/actual-laundry-invoice-service";
import {InventoryCatalogAccessError} from "@/modules/inventory/domain/catalog-errors";
import {ActualLaundryManager} from "@/modules/inventory/ui/actual-laundry-manager";
export const dynamic="force-dynamic";
export default async function ActualLaundryPage({params,searchParams}:{params:Promise<{locale:string}>;searchParams:Promise<{batch?:string;expected?:string}>}){const locale=safeLocale((await params).locale);setRequestLocale(locale);const session=await auth();if(session?.user?.securitySetupRequired)redirect("/"+locale+"/app/security");const actor=await accountActorContextFromSession(session);if(!actor)redirect("/"+locale+"/login");const input=z.object({batch:z.uuid(),expected:z.uuid()}).safeParse(await searchParams);if(!input.success)notFound();try{await actualLaundryInvoiceContext(actor,{batchId:input.data.batch,expectedInvoiceId:input.data.expected});}catch(error){if(error instanceof InventoryCatalogAccessError)notFound();throw error;}const t=await getTranslations("ActualLaundry");return <AdminShell className="resource-page inventory-page" testId="actual-laundry-page"><ShellHeader eyebrow={t("eyebrow")} title={t("title")} subtitle={t("subtitle")} actions={<Link className="secondary-button" href={"/"+locale+"/app/inventory/expected-laundry?batch="+input.data.batch}>{t("expectedInvoice")}</Link>}/><ActualLaundryManager key={actor.organizationId+"."+actor.actorId+":"+input.data.batch+":"+input.data.expected} locale={locale} authorizationScope={actor.organizationId+"."+actor.actorId} batchId={input.data.batch} expectedInvoiceId={input.data.expected}/></AdminShell>;}
