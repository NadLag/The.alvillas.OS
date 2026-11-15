import Link from "next/link";
import {notFound,redirect} from "next/navigation";
import {getTranslations,setRequestLocale} from "next-intl/server";
import {z} from "zod";
import {AdminShell,EmptyState,ShellHeader} from "@/design-system/shells";
import {safeLocale} from "@/i18n/routing";
import {auth} from "@/platform/auth/session";
import {accountActorContextFromSession} from "@/platform/authz/session-context";
import {coreActorContextFromSession} from "@/modules/core/application/core-access";
import {getProperty,CoreAuthorizationError,CoreNotFoundError} from "@/modules/core/application/core-service";
import {prisma} from "@/platform/db/client";
import {withTenant} from "@/platform/db/tenant";
import {serviceCatalogSourceContext} from "@/modules/services/application/service-catalog-source";
import {ServiceCatalogAccessError,ServiceCatalogConfigurationError} from "@/modules/services/domain/service-catalog";
import {ServiceCatalogManager} from "@/modules/services/ui/service-catalog-manager";

export const dynamic="force-dynamic";
export default async function ServiceCatalogPage({params}:{params:Promise<{locale:string;propertyId:string}>}){
 const{locale,propertyId}=await params;if(!z.uuid().safeParse(propertyId).success)notFound();const appLocale=safeLocale(locale);setRequestLocale(appLocale);
 const session=await auth(),actor=await accountActorContextFromSession(session),core=await coreActorContextFromSession(session);if(!actor||!core)redirect(`/${appLocale}/login`);
 const t=await getTranslations("ServiceCatalog");let property;try{property=await getProperty(core,propertyId);}catch(error){if(error instanceof CoreAuthorizationError||error instanceof CoreNotFoundError)notFound();throw error;}
 let allowed=false,canConfigure=false,configuration=false;
 try{await withTenant(prisma,actor.organizationId,async tx=>{await serviceCatalogSourceContext(actor,tx,{propertyId});allowed=true;try{await serviceCatalogSourceContext(actor,tx,{propertyId},"configure");canConfigure=true;}catch(error){if(!(error instanceof ServiceCatalogAccessError))throw error;}});}catch(error){if(error instanceof ServiceCatalogConfigurationError)configuration=true;else if(!(error instanceof ServiceCatalogAccessError))throw error;}
 return<AdminShell className="resource-page" testId="service-catalog-page"><ShellHeader eyebrow={t("eyebrow")} title={t("title")} subtitle={property.name} actions={<Link className="secondary-button" href={`/${appLocale}/app/properties/${propertyId}`}>{t("back")}</Link>}/>
  {allowed&&!configuration?<ServiceCatalogManager locale={appLocale} timezone={property.timezone} propertyId={propertyId} authorizationScope={actor.organizationId+"."+actor.actorId} canConfigure={canConfigure}/>:<EmptyState><h2>{t(configuration?"states.configuration_unavailable":"states.forbidden")}</h2><p>{t("accessHelp")}</p></EmptyState>}
 </AdminShell>;
}
