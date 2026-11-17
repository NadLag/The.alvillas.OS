import type {NextRequest} from "next/server";
import {z} from "zod";
import {inventoryCatalogHttp} from "@/modules/inventory/ui/item-http";
import {laundryBatchPage,getLaundryBatch,getLaundryBatchEvent,previewLaundryBatch,createLaundryBatch,previewLaundryBatchEvent,recordLaundryBatchEvent,recoverLaundryBatchCommand,laundrySupplierChoices} from "@/modules/inventory/application/laundry-batch-service";
export const runtime="nodejs";
const operations={page:laundryBatchPage,context:getLaundryBatch,event:getLaundryBatchEvent,createReview:previewLaundryBatch,createPublish:createLaundryBatch,eventReview:previewLaundryBatchEvent,eventPublish:recordLaundryBatchEvent,recover:recoverLaundryBatchCommand,suppliers:laundrySupplierChoices};
export async function POST(request:NextRequest,{params}:{params:Promise<{operation:string}>}){const operation=z.enum(["page","context","event","createReview","createPublish","eventReview","eventPublish","recover","suppliers"]).safeParse((await params).operation);return inventoryCatalogHttp(request,(actor,input,requestId)=>{if(!operation.success)throw new z.ZodError([]);return operations[operation.data](actor,input,{requestId});},"F-LND-03");}
