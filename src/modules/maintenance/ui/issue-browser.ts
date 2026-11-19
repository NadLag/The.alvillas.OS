import {readBoundedResponseBytes} from "@/platform/http/read-exact-response";
export type MaintenanceBrowserState="ready"|"loading"|"offline"|"forbidden"|"unavailable"|"validation"|"conflict"|"uncertain";
export class MaintenanceBrowserError extends Error{constructor(readonly state:MaintenanceBrowserState){super(state);}}
export async function maintenanceIssueRequest(operation:"read"|"history"|"sources"|"review"|"publish"|"recover"|"status",input:unknown,signal:AbortSignal,scope:string):Promise<unknown>{
 return maintenanceRequest("issues",operation,input,signal,scope);
}
export async function maintenanceWorkOrderRequest(operation:"read"|"tasks"|"review"|"publish"|"recover"|"status"|"finance-read"|"finance-search"|"finance-review"|"finance-publish"|"finance-status"|"contractor-read"|"contractor-search"|"contractor-publish"|"assets-read"|"assets-publish",input:unknown,signal:AbortSignal,scope:string):Promise<unknown>{
 return maintenanceRequest("work-orders",operation,input,signal,scope);
}
async function maintenanceRequest(family:"issues"|"work-orders",operation:string,input:unknown,signal:AbortSignal,scope:string):Promise<unknown>{
 if(!navigator.onLine)throw new MaintenanceBrowserError("offline");
 let response:Response;
 try{response=await fetch("/api/maintenance/"+family+"/"+operation,{method:"POST",credentials:"same-origin",cache:"no-store",redirect:"error",referrerPolicy:"no-referrer",headers:{"Content-Type":"application/json","x-alvillas-inventory-scope":scope},body:JSON.stringify(input),signal});}
 catch{throw new MaintenanceBrowserError(operation.endsWith("publish")?"uncertain":"unavailable");}
 let body:unknown;
 try{body=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await readBoundedResponseBytes(response,524288)))as unknown;}
 catch{throw new MaintenanceBrowserError(operation.endsWith("publish")?"uncertain":"unavailable");}
 if(!response.ok)throw new MaintenanceBrowserError(response.status===401||response.status===403?"forbidden":response.status===409?"conflict":response.status===400?"validation":operation.endsWith("publish")?"uncertain":"unavailable");
 return body;
}
