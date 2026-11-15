import {createGuestHubIdentityCaptureService} from "@/modules/guest-hub/application/guest-hub-identity-capture";
import {createGuestHubIdentityDocumentGrantService} from "@/modules/guest-hub/application/guest-hub-identity-document-grants";
import {nativeGuestIdentityDocumentAuthority} from "./native-document-authority";

export const nativeGuestIdentityCaptures=createGuestHubIdentityCaptureService(nativeGuestIdentityDocumentAuthority);
export const nativeGuestIdentityGrants=createGuestHubIdentityDocumentGrantService(nativeGuestIdentityDocumentAuthority);
