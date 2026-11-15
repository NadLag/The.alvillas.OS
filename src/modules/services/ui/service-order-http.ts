import type {NextRequest} from "next/server";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {serviceCatalogHttp} from "./service-catalog-http";
import {ServiceOrderAccessError,ServiceOrderConflictError,ServiceOrderConfigurationError,ServiceOrderSourceUnavailableError,ServiceOrderValidationError} from "../domain/service-order";

/** Session/MFA, same-origin, account binding, exact body bounds and private
 * response policy remain in the existing native service HTTP boundary. */
export const serviceOrderHttp=(request:NextRequest,work:(actor:AccountActorContext,input:unknown,requestId:string)=>Promise<unknown>)=>serviceCatalogHttp(request,work,error=>{
 if(error instanceof ServiceOrderAccessError)return{error:"forbidden",status:403};
 if(error instanceof ServiceOrderConflictError)return{error:"conflict",status:409};
 if(error instanceof ServiceOrderSourceUnavailableError)return{error:"source_unavailable",status:409};
 if(error instanceof ServiceOrderConfigurationError)return{error:"configuration_unavailable",status:503};
 if(error instanceof ServiceOrderValidationError)return{error:"validation",status:400};return null;
});
