import Link from "next/link";
import {redirect,notFound} from "next/navigation";
import {getTranslations,setRequestLocale} from "next-intl/server";
import {z} from "zod";
import {AdminShell,ShellHeader} from "@/design-system/shells";
import {safeLocale} from "@/i18n/routing";
import {auth} from "@/platform/auth/session";
import {accountActorContextFromSession} from "@/platform/authz/session-context";
import {expectedLaundryInvoiceHistory} from "@/modules/inventory/application/expected-laundry-invoice-service";
import {InventoryCatalogAccessError,InventoryCatalogDefinitionError} from "@/modules/inventory/domain/catalog-errors";
import {ExpectedLaundryManager} from "@/modules/inventory/ui/expected-laundry-manager";
export const dynamic="force-dynamic";
export default async function ExpectedLaundryPage({params,searchParams}:{params:Promise<{locale:string}>;searchParams:Promise<{batch?:string}>}){const locale=safeLocale((await params).locale);setRequestLocale(locale);const session=await auth();if(session?.user?.securitySetupRequired)redirect("/"+locale+"/app/security");const actor=await accountActorContextFromSession(session);if(!actor)redirect("/"+locale+"/login");const input=z.object({batch:z.uuid()}).safeParse(await searchParams);if(!input.success)notFound();try{await expectedLaundryInvoiceHistory(actor,{batchId:input.data.batch});}catch(error){if(error instanceof InventoryCatalogAccessError||error instanceof InventoryCatalogDefinitionError)notFound();throw error;}const t=await getTranslations("ExpectedLaundry");return <AdminShell className="resource-page inventory-page" testId="expected-laundry-page"><ShellHeader eyebrow={t("eyebrow")} title={t("title")} subtitle={t("subtitle")} actions={<Link className="secondary-button" href={"/"+locale+"/app/inventory/laundry?batch="+input.data.batch}>{t("originalBatch")}</Link>}/><ExpectedLaundryManager key={actor.organizationId+"."+actor.actorId+":"+input.data.batch} locale={locale} authorizationScope={actor.organizationId+"."+actor.actorId} batchId={input.data.batch}/></AdminShell>;}
