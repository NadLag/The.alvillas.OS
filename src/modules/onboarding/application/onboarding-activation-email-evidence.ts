import {activationOwnerEmailMilestones} from "../domain/onboarding-activation-effect-evidence";
import {admitActivationOwnerDelivery} from "./onboarding-activation-owner-effects";

/** The existing adapter authenticates the actual creator, cap, complete sources and canonical child identity. */
export async function advanceActivationOwnerEmailEvidence(organizationId:string,activationId:string,deps:Parameters<typeof admitActivationOwnerDelivery>[2]){
 const receipt=await admitActivationOwnerDelivery(organizationId,activationId,deps);
 return activationOwnerEmailMilestones(activationId,receipt);
}
