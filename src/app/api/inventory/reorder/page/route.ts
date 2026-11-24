import type {NextRequest} from "next/server";
import {inventoryCatalogHttp} from "@/modules/inventory/ui/item-http";
import {inventoryReorderPage} from "@/modules/inventory/application/reorder-service";
export const runtime="nodejs";
export async function POST(request:NextRequest){return inventoryCatalogHttp(request,(actor,input)=>inventoryReorderPage(actor,input),"F-INV-05");}
