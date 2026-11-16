"use client";
import type {AppLocale} from "@/i18n/routing";
import {ServiceAllocationWorkspace} from "@/modules/finance/ui/service-allocation-workspace";
/** The existing financial editor remains responsible for independent source
 * permissions, approved costs, reviewed decisions and original acknowledgements. */
export function NativeServiceOrderFinancialWorkspace({locale,authorizationScope,propertyId,taskId,onInvalidate}:{locale:AppLocale;authorizationScope:string;propertyId:string;taskId:string;onInvalidate:()=>void}){
 return<ServiceAllocationWorkspace locale={locale} scope={authorizationScope} collectionScope={{propertyId,taskId}} onInvalidate={onInvalidate}/>;
}
