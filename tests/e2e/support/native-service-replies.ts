import type {APIResponse,Page} from "@playwright/test";

/** Keep the original HTTP reply available after the client cancels a completed read.
 * Forward each observed browser POST once, with its actual cookies and headers;
 * return that exact server response to the UI without changing its body or status. */
export async function nativeServiceReplies(page:Page,family:"catalog"|"orders"){
 return nativePrivateReplies(page,family==="catalog"?"/api/services/catalog/":"/api/services/orders/");
}
export async function nativePrivateReplies(page:Page,path:"/api/services/catalog/"|"/api/services/orders/"|"/api/inventory/items/"|"/api/inventory/locations/"|"/api/inventory/movements/"|"/api/inventory/stock/"|"/api/inventory/reorder/"|"/api/inventory/stocktakes/"|"/api/inventory/purchases/"|"/api/inventory/stays/"|"/api/inventory/procurement/"){
 const pending=new Map<string,{resolve:(response:APIResponse)=>void;reject:(error:unknown)=>void}>();
 await page.route("**"+path+"*",async route=>{
  const request=route.request(),url=new URL(request.url()),operation=url.pathname.slice(path.length),consumer=pending.get(operation);
  if(request.method()!=="POST"||!consumer||!["127.0.0.1","localhost","[::1]"].includes(url.hostname)){await route.continue();return;}
  pending.delete(operation);
  try{const original=await route.fetch({maxRetries:0,maxRedirects:0});await original.body();await route.fulfill({response:original});consumer.resolve(original);}catch(error){consumer.reject(error);throw error;}
 });
 page.once("close",()=>{for(const consumer of pending.values())consumer.reject(Error("The native service page closed"));pending.clear();});
 return(operation:string)=>new Promise<APIResponse>((resolve,reject)=>{
  if(pending.has(operation)){reject(Error("A native service reply is already pending"));return;}
  const timeout=setTimeout(()=>{pending.delete(operation);reject(Error("The actual native service reply was not observed"));},30000);
  pending.set(operation,{resolve:response=>{clearTimeout(timeout);resolve(response);},reject:error=>{clearTimeout(timeout);reject(error instanceof Error?error:Error("The actual native service reply failed"));}});
 });
}
