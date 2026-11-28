import type {NextRequest} from "next/server";
import {z} from "zod";
import {inventoryCatalogHttp} from "@/modules/inventory/ui/item-http";
import {supplierPricePage,getSupplierPriceVersion,previewSupplierPrice,publishSupplierPrice,recoverSupplierPrice,supplierPriceSupplierChoices,supplierPricePropertyChoices} from "@/modules/inventory/application/supplier-price-service";
export const runtime="nodejs";
const operations={page:supplierPricePage,context:getSupplierPriceVersion,review:previewSupplierPrice,publish:publishSupplierPrice,recover:recoverSupplierPrice,suppliers:supplierPriceSupplierChoices,properties:supplierPricePropertyChoices};
export async function POST(request:NextRequest,{params}:{params:Promise<{operation:string}>}){const operation=z.enum(["page","context","review","publish","recover","suppliers","properties"]).safeParse((await params).operation);return inventoryCatalogHttp(request,(actor,input,requestId)=>{if(!operation.success)throw new z.ZodError([]);return operations[operation.data](actor,input,{requestId});},"F-LND-04",262144);}
