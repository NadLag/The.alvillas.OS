import type {NextRequest} from "next/server";
import type {GuestHubDependencies} from "../application/guest-hub-service";
import {viewGuestHubProfile,reviewGuestHubProfile,submitGuestHubProfile,recoverGuestHubProfile} from "../application/guest-hub-profile";
import {guestHubFormPublicHttp} from "./guest-hub-form-public-http";
export function guestHubProfilePublicHttp(request:NextRequest,deps:GuestHubDependencies&{verificationOrganizationId?:string},rawLinkId:unknown,action:"view"|"review"|"admit"|"recover"){return guestHubFormPublicHttp(request,deps,rawLinkId,action,{feature:"F-GST-03",view:viewGuestHubProfile,review:reviewGuestHubProfile,admit:submitGuestHubProfile,recover:recoverGuestHubProfile});}
