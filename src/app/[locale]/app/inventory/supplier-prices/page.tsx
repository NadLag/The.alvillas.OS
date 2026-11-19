import Link from "next/link";
import {redirect,notFound} from "next/navigation";
import {getTranslations,setRequestLocale} from "next-intl/server";
import {z} from "zod";
import {AdminShell,ShellHeader} from "@/design-system/shells";
import {safeLocale} from "@/i18n/routing";
import {auth} from "@/platform/auth/session";
import {accountActorContextFromSession} from "@/platform/authz/session-context";
import {assertSupplierPricesViewer} from "@/modules/inventory/application/supplier-price-service";
import {InventoryCatalogAccessError} from "@/modules/inventory/domain/catalog-errors";
import {SupplierPriceManager} from "@/modules/inventory/ui/supplier-price-manager";
export const dynamic="force-dynamic";
export default async function SupplierPricesPage({params,searchParams}:{params:Promise<{locale:string}>;searchParams:Promise<{version?:string;association?:string}>}){const locale=safeLocale((await params).locale);setRequestLocale(locale);const session=await auth();if(session?.user?.securitySetupRequired)redirect("/"+locale+"/app/security");const actor=await accountActorContextFromSession(session);if(!actor)redirect("/"+locale+"/login");try{await assertSupplierPricesViewer(actor);}catch(error){if(error instanceof InventoryCatalogAccessError)notFound();throw error;}const input=z.object({version:z.uuid().optional(),association:z.uuid().optional()}).refine(value=>!value.version||!value.association).safeParse(await searchParams);if(!input.success)notFound();const t=await getTranslations("SupplierPrices");return <AdminShell className="resource-page inventory-page" testId="supplier-prices-page"><ShellHeader eyebrow={t("eyebrow")} title={t("title")} subtitle={t("subtitle")} actions={<Link className="secondary-button" href={"/"+locale+"/app"}>{t("back")}</Link>}/><SupplierPriceManager key={actor.organizationId+"."+actor.actorId+":"+(input.data.association??input.data.version??"")} locale={locale} authorizationScope={actor.organizationId+"."+actor.actorId} initialVersion={input.data.version} initialAssociation={input.data.association}/></AdminShell>;}
