import type {NextRequest} from "next/server";
import {z} from "zod";
import {inventoryCatalogHttp} from "@/modules/inventory/ui/item-http";
import {expectedLaundryInvoiceContext,previewExpectedLaundryInvoice,publishExpectedLaundryInvoice,recoverExpectedLaundryInvoice,getExpectedLaundryInvoice,expectedLaundryInvoiceHistory} from "@/modules/inventory/application/expected-laundry-invoice-service";
export const runtime="nodejs";
const operations={context:expectedLaundryInvoiceContext,review:previewExpectedLaundryInvoice,publish:publishExpectedLaundryInvoice,recover:recoverExpectedLaundryInvoice,item:getExpectedLaundryInvoice,page:expectedLaundryInvoiceHistory};
export async function POST(request:NextRequest,{params}:{params:Promise<{operation:string}>}){const operation=z.enum(["context","review","publish","recover","item","page"]).safeParse((await params).operation);return inventoryCatalogHttp(request,(actor,input,requestId)=>{if(!operation.success)throw new z.ZodError([]);return operations[operation.data](actor,input,{requestId});},"F-LND-05");}
