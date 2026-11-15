import type {NextRequest} from "next/server";
import type {GuestHubAgreementReleaseDependencies} from "../application/guest-hub-agreement-releases";
import {viewGuestHubAgreement,reviewGuestHubAgreementRequest,requestGuestHubAgreementSignature,recoverGuestHubAgreementRequest} from "../application/guest-hub-agreement-requests";
import {guestHubFormPublicHttp} from "./guest-hub-form-public-http";
export function guestHubAgreementPublicHttp(request:NextRequest,deps:GuestHubAgreementReleaseDependencies&{verificationOrganizationId?:string},rawLinkId:unknown,action:"view"|"review"|"admit"|"recover"){
 return guestHubFormPublicHttp(request,deps,rawLinkId,action,{feature:"F-GST-07",view:(cap,context)=>viewGuestHubAgreement(cap,{...context,agreementDocuments:deps.agreementDocuments}),review:(cap,input,context)=>reviewGuestHubAgreementRequest(cap,input,{...context,agreementDocuments:deps.agreementDocuments}),admit:(cap,input,context)=>requestGuestHubAgreementSignature(cap,input,{...context,agreementDocuments:deps.agreementDocuments}),recover:(cap,input,context)=>recoverGuestHubAgreementRequest(cap,input,{...context,agreementDocuments:deps.agreementDocuments})});
}
