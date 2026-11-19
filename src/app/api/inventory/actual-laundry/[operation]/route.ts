import type {NextRequest} from "next/server";
import {z} from "zod";
import {inventoryCatalogHttp} from "@/modules/inventory/ui/item-http";
import {actualLaundryInvoiceContext,actualLaundryInvoiceChoices,actualLaundryInvoiceSelection,actualLaundryInvoiceDocuments,actualLaundryInvoiceHistory,getActualLaundryInvoice,previewActualLaundryInvoice,publishActualLaundryInvoice,recoverActualLaundryInvoice} from "@/modules/inventory/application/actual-laundry-invoice-service";
export const runtime="nodejs";
const operations={context:actualLaundryInvoiceContext,invoices:actualLaundryInvoiceChoices,invoice:actualLaundryInvoiceSelection,documents:actualLaundryInvoiceDocuments,page:actualLaundryInvoiceHistory,item:getActualLaundryInvoice,review:previewActualLaundryInvoice,publish:publishActualLaundryInvoice,recover:recoverActualLaundryInvoice};
export async function POST(request:NextRequest,{params}:{params:Promise<{operation:string}>}){const operation=z.enum(["context","invoices","invoice","documents","page","item","review","publish","recover"]).safeParse((await params).operation);return inventoryCatalogHttp(request,(actor,input,requestId)=>{if(!operation.success)throw new z.ZodError([]);return operations[operation.data](actor,input,{requestId});},"F-LND-06",262144);}
