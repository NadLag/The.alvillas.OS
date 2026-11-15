import type {NextRequest} from "next/server";
import type {GuestHubDependencies} from "../application/guest-hub-service";
import {viewGuestHubHouseRules,reviewGuestHubHouseRules,acceptGuestHubHouseRules,recoverGuestHubHouseRules} from "../application/guest-hub-house-rules";
import {guestHubFormPublicHttp} from "./guest-hub-form-public-http";
export function guestHubHouseRulesPublicHttp(request:NextRequest,deps:GuestHubDependencies&{verificationOrganizationId?:string},rawLinkId:unknown,action:"view"|"review"|"admit"|"recover"){return guestHubFormPublicHttp(request,deps,rawLinkId,action,{feature:"F-GST-06",view:viewGuestHubHouseRules,review:reviewGuestHubHouseRules,admit:acceptGuestHubHouseRules,recover:recoverGuestHubHouseRules});}
