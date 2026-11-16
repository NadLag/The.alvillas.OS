import type {NextRequest} from "next/server";
import {z} from "zod";
import {prisma} from "@/platform/db/client";
import {serviceOrderHttp} from "@/modules/services/ui/service-order-http";
import {previewServiceOrder,createServiceOrder,recoverServiceOrderCommand,readServiceOrderMetadata} from "@/modules/services/application/service-order-service";
import {previewServiceOrderTransition,transitionServiceOrder} from "@/modules/services/application/service-order-transition";
import {serviceOrderPage,readServiceOrderOriginal,serviceOrderHistory,serviceOrderHistoryOriginal,serviceOrderReservationChoices,serviceOrderCatalogChoices,serviceOrderTaskChoices} from "@/modules/services/application/service-order-workspace";
import {ServiceOrderValidationError} from "@/modules/services/domain/service-order";
import {serviceOrderFinancialPage} from "@/modules/services/application/service-order-financial";
import {readChefCompensationContext} from "@/modules/services/application/chef-compensation-service";
import {readChefShoppingList} from "@/modules/services/application/chef-shopping-service";
import {readChefTaskRecipe} from "@/modules/services/application/chef-menu-service";

export const runtime="nodejs";
const operations={chefCompensation:readChefCompensationContext,chefShopping:readChefShoppingList,chefTask:readChefTaskRecipe,review:previewServiceOrder,create:createServiceOrder,recover:recoverServiceOrderCommand,page:serviceOrderPage,original:readServiceOrderOriginal,history:serviceOrderHistory,version:serviceOrderHistoryOriginal,reservations:serviceOrderReservationChoices,catalog:serviceOrderCatalogChoices,tasks:serviceOrderTaskChoices,financial:serviceOrderFinancialPage,reviewTransition:previewServiceOrderTransition,transition:transitionServiceOrder};
export async function POST(request:NextRequest,{params}:{params:Promise<{operation:string}>}){
 const{operation}=await params;return serviceOrderHttp(request,(actor,input,requestId)=>{
  const deps={db:prisma,requestId,ipAddress:null};if(operation==="metadata")return readServiceOrderMetadata(actor,z.object({orderId:z.uuid()}).strict().parse(input).orderId,deps);
  if(!Object.hasOwn(operations,operation))throw new ServiceOrderValidationError();return operations[operation as keyof typeof operations](actor,input,deps);
 });
}
