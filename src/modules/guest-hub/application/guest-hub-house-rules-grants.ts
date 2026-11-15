import {createGuestHubFormGrantService} from "./guest-hub-form-grants";
import {guestHubHouseRulesSettings} from "./guest-hub-house-rules-source";
import {GuestHubHouseRulesAccessError,GuestHubHouseRulesConflictError} from "../domain/guest-hub-house-rules-policy";
export const {status:guestHubHouseRulesGrantStatus,review:reviewGuestHubHouseRulesGrant,record:recordGuestHubHouseRulesGrant,recover:recoverGuestHubHouseRulesGrant}=createGuestHubFormGrantService({formKey:"HOUSE_RULES",resourceType:"guest_hub_house_rules",reviewProtocol:"NATIVE_GUEST_HOUSE_RULES_GRANT_REVIEW_V1",settings:guestHubHouseRulesSettings,AccessError:GuestHubHouseRulesAccessError,ConflictError:GuestHubHouseRulesConflictError});
