import {ownerInputSchema} from "@/modules/core/domain/owner-property";

/** The wizard uses the Core Owner contract; representatives and payout setup retain their own authorization. */
export const onboardingOwnerInputSchema=ownerInputSchema.omit({representatives:true,payoutMethods:true}).strict();
