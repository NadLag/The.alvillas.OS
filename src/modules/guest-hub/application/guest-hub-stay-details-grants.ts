import {createGuestHubFormGrantService} from "./guest-hub-form-grants";
import {guestHubStayDetailsSettings} from "./guest-hub-stay-details-source";
import {GuestHubStayDetailsAccessError,GuestHubStayDetailsConflictError} from "../domain/guest-hub-stay-details-policy";
export const {status:guestHubStayDetailsGrantStatus,review:reviewGuestHubStayDetailsGrant,record:recordGuestHubStayDetailsGrant,recover:recoverGuestHubStayDetailsGrant}=createGuestHubFormGrantService({formKey:"STAY_DETAILS",resourceType:"guest_hub_stay_details",reviewProtocol:"NATIVE_GUEST_STAY_DETAILS_GRANT_REVIEW_V1",settings:guestHubStayDetailsSettings,AccessError:GuestHubStayDetailsAccessError,ConflictError:GuestHubStayDetailsConflictError});
