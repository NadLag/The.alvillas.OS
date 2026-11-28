import {z} from "zod";
import {readBoundedResponseBytes} from "@/platform/http/read-exact-response";
export type InventoryBrowserState="ready"|"loading"|"offline"|"forbidden"|"unavailable"|"validation"|"conflict"|"stock_held"|"uncertain";
export class InventoryBrowserError extends Error{constructor(readonly state:InventoryBrowserState){super(state);}}
const failure=z.object({error:z.string()}).strict();
export const inventoryItemRequest=(operation:"export"|"review"|"publish"|"recover"|"page"|"item",input:unknown,signal:AbortSignal,scope:string)=>inventoryCatalogRequest("items",operation,input,signal,scope);
export async function inventoryCatalogRequest(resource:"items"|"locations"|"movements"|"stock"|"reorder"|"stocktakes"|"purchases"|"stays"|"procurement"|"linen"|"laundry"|"supplier-prices",operation:"export"|"review"|"publish"|"recover"|"page"|"item"|"location"|"properties"|"movement"|"reservations"|"context"|"event"|"createReview"|"createPublish"|"eventReview"|"eventPublish"|"suppliers",input:unknown,signal:AbortSignal,scope:string){
 const publishing=operation==="publish"||operation==="createPublish"||operation==="eventPublish";
 if(!navigator.onLine)throw new InventoryBrowserError("offline");
 let response:Response;try{response=await fetch("/api/inventory/"+resource+"/"+operation,{method:"POST",credentials:"same-origin",cache:"no-store",redirect:"error",referrerPolicy:"no-referrer",headers:{"Content-Type":"application/json","x-alvillas-inventory-scope":scope},body:JSON.stringify(input),signal});}catch{throw new InventoryBrowserError(publishing?"uncertain":"unavailable");}
 let value:unknown;try{value=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await readBoundedResponseBytes(response,resource==="linen"||resource==="laundry"||resource==="supplier-prices"?2097152:resource==="reorder"||resource==="stocktakes"||resource==="purchases"||resource==="procurement"?1048576:262144)))as unknown;}catch{throw new InventoryBrowserError(publishing?"uncertain":"unavailable");}
 if(!response.ok){const parsed=failure.safeParse(value),error=parsed.success?parsed.data.error:"unavailable";throw new InventoryBrowserError(response.status===401||response.status===403?"forbidden":error==="conflict"||error==="stock_held"||error==="validation"?error:publishing?"uncertain":"unavailable");}
 return value;
}
