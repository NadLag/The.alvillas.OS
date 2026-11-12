import {z} from "zod";
import {onboardingIdSchema as id} from "./onboarding-primitives";
import {onboardingOwnerPackageReceiptSchema} from "./onboarding-owner-package-run";
import {onboardingOwnerDeliveryReceiptSchema} from "./onboarding-owner-delivery";
import {onboardingActivationReceiptSchema} from "./onboarding-activation";
import {onboardingActivationEffects} from "./onboarding-activation-policy";
import {OnboardingConflictError} from "./onboarding-wizard";

/** Public input selects native records; no completion flags or checklist values are accepted. */
export const onboardingReadinessInputSchema=z.object({sessionId:id,reviewRevisionId:id,packageId:id,ownerDeliveryId:id.optional()}).strict();
const configuration=z.enum(["CURRENT","SOURCE_CHANGED"]);
export const onboardingReadinessSchema=z.object({sessionId:id,reviewRevisionId:id,propertyId:id,package:onboardingOwnerPackageReceiptSchema,delivery:onboardingOwnerDeliveryReceiptSchema.nullable(),activation:onboardingActivationReceiptSchema.nullable(),configuration,checks:z.object({configuration:z.boolean(),documents:z.boolean(),email:z.boolean(),workflows:z.boolean(),tasks:z.boolean(),notification:z.boolean(),activation:z.boolean()}).strict(),ready:z.boolean(),operational:z.boolean()}).strict();
type Facts={sessionId:string;reviewRevisionId:string;propertyId:string;package:unknown;delivery:unknown;activation:unknown;configuration:z.infer<typeof configuration>;operational:boolean};
/** Only the authorized native service supplies these actual persisted facts. */
export function buildOnboardingReadiness(facts:Facts){
 const documents=onboardingOwnerPackageReceiptSchema.parse(facts.package),delivery=facts.delivery===null?null:onboardingOwnerDeliveryReceiptSchema.parse(facts.delivery),activation=facts.activation===null?null:onboardingActivationReceiptSchema.parse(facts.activation);
 if(documents.sessionId!==facts.sessionId||documents.reviewRevisionId!==facts.reviewRevisionId||documents.propertyId!==facts.propertyId||delivery&&delivery.packageId!==documents.packageId||activation&&(activation.sessionId!==facts.sessionId||activation.sourceRevisionId!==facts.reviewRevisionId||activation.propertyId!==facts.propertyId))throw new OnboardingConflictError();
 const completed=activation?.completed??[],checks={configuration:facts.configuration==="CURRENT",documents:documents.state==="COMPLETE",email:delivery?.state==="DELIVERED",workflows:completed.includes("WORKFLOWS"),tasks:completed.includes("TASKS"),notification:completed.includes("NOTIFICATION"),activation:activation?.state==="COMPLETE"&&facts.operational};
 if(facts.operational&&(!activation||activation.state!=="COMPLETE"||!onboardingActivationEffects.every(effect=>completed.includes(effect))))throw new OnboardingConflictError();
 return onboardingReadinessSchema.parse({sessionId:facts.sessionId,reviewRevisionId:facts.reviewRevisionId,propertyId:facts.propertyId,package:documents,delivery,activation,configuration:facts.configuration,checks,ready:Object.values(checks).every(Boolean),operational:facts.operational});
}
