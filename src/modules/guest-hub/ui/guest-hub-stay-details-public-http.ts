import type {NextRequest} from "next/server";
import type {GuestHubDependencies} from "../application/guest-hub-service";
import {viewGuestHubStayDetails,reviewGuestHubStayDetails,submitGuestHubStayDetails,recoverGuestHubStayDetails} from "../application/guest-hub-stay-details";
import {GuestHubStayDetailsValidationError} from "../domain/guest-hub-stay-details-policy";
import {guestHubStayDetailsValidationResponseSchema} from "../domain/guest-hub-stay-details-contract";
import {guestHubFormPublicHttp} from "./guest-hub-form-public-http";
export function guestHubStayDetailsPublicHttp(request:NextRequest,deps:GuestHubDependencies&{verificationOrganizationId?:string},rawLinkId:unknown,action:"view"|"review"|"admit"|"recover"){return guestHubFormPublicHttp(request,deps,rawLinkId,action,{feature:"F-GST-04",view:viewGuestHubStayDetails,review:reviewGuestHubStayDetails,admit:submitGuestHubStayDetails,recover:recoverGuestHubStayDetails,validation:error=>{if(!(error instanceof GuestHubStayDetailsValidationError))return null;const parsed=guestHubStayDetailsValidationResponseSchema.safeParse({error:"validation",fields:error.fields});return parsed.success?parsed.data:null;}});}
