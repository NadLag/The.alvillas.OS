import {createGuestHubFormGrantService} from "./guest-hub-form-grants";
import {guestHubProfileSettings} from "./guest-hub-profile-source";
import {GuestHubProfileAccessError,GuestHubProfileConflictError} from "../domain/guest-hub-profile-policy";
export const {status:guestHubProfileGrantStatus,review:reviewGuestHubProfileGrant,record:recordGuestHubProfileGrant,recover:recoverGuestHubProfileGrant}=createGuestHubFormGrantService({formKey:"PROFILE",resourceType:"guest_hub_profile",reviewProtocol:"NATIVE_GUEST_PROFILE_GRANT_REVIEW_V1",settings:guestHubProfileSettings,AccessError:GuestHubProfileAccessError,ConflictError:GuestHubProfileConflictError});
