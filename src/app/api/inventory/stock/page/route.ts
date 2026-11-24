import type {NextRequest} from "next/server";
import {inventoryCatalogHttp} from "@/modules/inventory/ui/item-http";
import {inventoryStockPage} from "@/modules/inventory/application/stock-level-service";
export const runtime="nodejs";
export async function POST(request:NextRequest){return inventoryCatalogHttp(request,(actor,input)=>inventoryStockPage(actor,input),"F-INV-04");}
