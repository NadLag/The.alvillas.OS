import type {NextRequest} from "next/server";
import {prisma} from "@/platform/db/client";
import {serviceCatalogHttp} from "@/modules/services/ui/service-catalog-http";
import {previewServiceCatalogChange,publishServiceCatalogChange,recoverServiceCatalogChange,serviceCatalogPage,serviceCatalogHistory,serviceCatalogVersion} from "@/modules/services/application/service-catalog-service";
import {serviceCatalogFinancialChoices,serviceCatalogProviderChoices} from "@/modules/services/application/service-catalog-choices";
import {ServiceCatalogValidationError} from "@/modules/services/domain/service-catalog";

export const runtime="nodejs";
const operations={review:previewServiceCatalogChange,publish:publishServiceCatalogChange,recover:recoverServiceCatalogChange,page:serviceCatalogPage,history:serviceCatalogHistory,version:serviceCatalogVersion,financial:serviceCatalogFinancialChoices,providers:serviceCatalogProviderChoices};
export async function POST(request:NextRequest,{params}:{params:Promise<{operation:string}>}){
 const{operation}=await params;
 return serviceCatalogHttp(request,(actor,input,requestId)=>{if(!Object.hasOwn(operations,operation))throw new ServiceCatalogValidationError();return operations[operation as keyof typeof operations](actor,input,{db:prisma,requestId,ipAddress:null});});
}
