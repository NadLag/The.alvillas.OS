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
import {serviceOrderPropertyAuthority} from "@/modules/services/application/service-order-source";
import {ServiceOrderAccessError} from "@/modules/services/domain/service-order";
import {calendarDateAt} from "@/i18n/format";
import {ChefShoppingList} from "@/modules/services/ui/chef-shopping-list";
import {ServiceOrderManager} from "@/modules/services/ui/service-order-manager";

export const dynamic="force-dynamic";
export default async function ServiceOrdersPage({params}:{params:Promise<{locale:string;propertyId:string}>}){
 const{locale,propertyId}=await params;if(!z.uuid().safeParse(propertyId).success)notFound();const appLocale=safeLocale(locale);setRequestLocale(appLocale);
 const session=await auth(),actor=await accountActorContextFromSession(session),core=await coreActorContextFromSession(session);if(!actor||!core)redirect(`/${appLocale}/login`);
 const t=await getTranslations("ServiceOrders");let property;try{property=await getProperty(core,propertyId);}catch(error){if(error instanceof CoreAuthorizationError||error instanceof CoreNotFoundError)notFound();throw error;}
 const allowed=await withTenant(prisma,actor.organizationId,async tx=>{await serviceOrderPropertyAuthority(actor,tx,propertyId);return true;}).catch((error:unknown)=>{if(error instanceof ServiceOrderAccessError)return false;throw error;});
 return<AdminShell className="resource-page" testId="service-orders-page"><ShellHeader eyebrow={t("eyebrow")} title={t("title")} subtitle={property.name} actions={<Link className="secondary-button" href={`/${appLocale}/app/properties/${propertyId}`}>{t("back")}</Link>}/>
  {allowed?<><ChefShoppingList locale={appLocale} timezone={property.timezone} propertyId={propertyId} scope={actor.organizationId+"."+actor.actorId} date={calendarDateAt(new Date(),property.timezone)}/><ServiceOrderManager locale={appLocale} timezone={property.timezone} propertyId={propertyId} authorizationScope={actor.organizationId+"."+actor.actorId}/></>:<EmptyState><h2>{t("states.forbidden")}</h2><p>{t("accessHelp")}</p></EmptyState>}
 </AdminShell>;
}
