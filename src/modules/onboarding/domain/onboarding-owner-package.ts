import {z} from "zod";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {commissionRuleValueSchema,expenseTreatmentConfigSchema,approvalThresholdsConfigSchema,payoutScheduleConfigSchema,agreementResponsibilitiesConfigSchema,agreementNoticeConfigSchema,agreementSpecialConditionsConfigSchema} from "@/platform/config/rule-registry";
import {onboardingIdSchema,onboardingFingerprintSchema} from "./onboarding-primitives";
import {onboardingConfigurationFamilies,onboardingConfigurationValidationSchema} from "./onboarding-configuration";
import {onboardingOwnerPackageContentSchema} from "./onboarding-owner-package-policy";
import {OnboardingConfigurationError} from "./onboarding-wizard";

export const onboardingOwnerAccessCapabilities=["portal","statements","approvals","documents","reports"]as const;
export const onboardingOwnerAccessCapabilitiesSchema=z.object({portal:z.boolean(),statements:z.boolean(),approvals:z.boolean(),documents:z.boolean(),reports:z.boolean()}).strict();
export const onboardingOwnerAccessFactsSchema=z.object({source:z.literal("CANONICAL_OWNER_PORTAL_ACCESS"),organizationId:onboardingIdSchema,ownerId:onboardingIdSchema,propertyId:onboardingIdSchema,asOf:z.iso.datetime(),fingerprint:onboardingFingerprintSchema,accessIds:z.array(onboardingIdSchema),accountIds:z.array(onboardingIdSchema),capabilities:onboardingOwnerAccessCapabilitiesSchema}).strict().refine(value=>!Object.values(value.capabilities).some(Boolean)||(value.accessIds.length>0&&value.accountIds.length>0),"available_owner_access_requires_actual_account_and_access_evidence");
export const onboardingOwnerPackageReviewSourceSchema=z.object({organizationId:onboardingIdSchema,sessionId:onboardingIdSchema,revisionId:onboardingIdSchema,ownerId:onboardingIdSchema,propertyId:onboardingIdSchema,sourceFingerprint:onboardingFingerprintSchema,createdAt:z.iso.datetime()}).strict();
const sourceInput=z.object({review:onboardingOwnerPackageReviewSourceSchema,validation:onboardingConfigurationValidationSchema,content:onboardingOwnerPackageContentSchema,ownerAccess:onboardingOwnerAccessFactsSchema}).strict();
export const onboardingOperatingServiceFields={cleaning:"cleaningEnabled",inspection:"inspectionEnabled",pool:"poolServiceEnabled",garden:"gardenServiceEnabled",laundry:"laundryManaged",linen:"linenManaged",maintenance:"maintenanceTrackingEnabled",mid_stay_cleaning:"midStayCleaningEnabled",breakfast:"breakfastAvailable",chef:"chefAvailable",transfers:"transfersAvailable",groceries:"groceriesAvailable",wellness:"wellnessAvailable"}as const;

/** Called with authenticated native sources; public commands cannot supply these report values. */
export function buildOnboardingOwnerPackage(raw:unknown){
 const {review,validation,content,ownerAccess}=sourceInput.parse(raw),facts=validation.facts,{owner,property,operatingProfile,agreement,team,bookingChannels,inventory,services,workflows}=facts;
 if(!validation.ready||onboardingConfigurationFamilies.some(family=>facts[family]===null)||!owner||!property||!operatingProfile||!agreement||!team||!bookingChannels||!inventory||!services||!workflows||!services.settings)throw new OnboardingConfigurationError();
 if(facts.sessionId!==review.sessionId||facts.ownerId!==review.ownerId||facts.propertyId!==review.propertyId||property.id!==review.propertyId||[agreement,team,bookingChannels,inventory,services,workflows].some(source=>source.propertyId!==review.propertyId)||ownerAccess.organizationId!==review.organizationId||ownerAccess.ownerId!==review.ownerId||ownerAccess.propertyId!==review.propertyId||content.agreement_id!==agreement.id)throw new OnboardingConfigurationError();
 for(const rule of agreement.rules){const pin=content.agreement_rules.find(value=>value.key===rule.key);if(!pin||pin.id!==rule.id||pin.version!==rule.version||pin.value_fingerprint!==jsonbFingerprint(rule.value))throw new OnboardingConfigurationError();}
 const value=(key:string)=>agreement.rules.find(rule=>rule.key===key)?.value,
  commission=commissionRuleValueSchema.parse(value("finance.commission")),expense=expenseTreatmentConfigSchema.parse(value("finance.expense_treatment")),approval=approvalThresholdsConfigSchema.parse(value("finance.approval_thresholds")),payout=payoutScheduleConfigSchema.parse(value("finance.payout_schedule")),responsibilities=agreementResponsibilitiesConfigSchema.parse(value("agreement.responsibilities")),notice=agreementNoticeConfigSchema.parse(value("agreement.notice")),conditions=agreementSpecialConditionsConfigSchema.parse(value("agreement.special_conditions"));
 if(content.responsibilities.owner.en.length!==responsibilities.owner.length||content.responsibilities.alvillas.en.length!==responsibilities.alvillas.length||content.special_conditions.en.length!==conditions.conditions.length)throw new OnboardingConfigurationError();
 if((commission.basis==="CUSTOM_FORMULA"||commission.expense_treatments!==undefined||commission.approval_thresholds!==undefined||commission.payout_rule!==undefined)&&!content.commission_terms?.en.length||payout.rules?.length&&!content.payout_rules?.en.length||payout.cadence==="CUSTOM_CRON"&&!payout.cron||payout.holdback_amount!==undefined&&!payout.holdback_currency)throw new OnboardingConfigurationError();
 const members=team.assignments.map(assignment=>{const person=team.people.find(row=>row.id===assignment.personId),role=team.roles.find(row=>row.id===assignment.roleId);if(!person||!role)throw new OnboardingConfigurationError();return{personId:person.id,displayName:person.displayName,roleKey:role.key,roleName:role.name};});
 return{
  provenance:{...review,contentFingerprint:jsonbFingerprint(content),ownerAccessFingerprint:ownerAccess.fingerprint},
  owner,property:{details:property,operatingProfile,operatingRule:facts.operatingRule},
  providedServices:{operating:Object.entries(onboardingOperatingServiceFields).filter(([,field])=>operatingProfile[field]===true).map(([key])=>key),otherOperating:[...operatingProfile.otherServices],catalog:services.settings.services.filter(service=>service.available===true),additional:content.additional_services.filter(service=>service.enabled)},
  financialAgreement:{id:agreement.id,reference:agreement.reference,status:agreement.status,effectiveFrom:agreement.effectiveFrom,effectiveTo:agreement.effectiveTo,
   commission:{rate_bps:commission.rate_bps,basis:commission.basis,accrual_event:commission.accrual_event},
   expense:{default_treatment:expense.default_treatment,categories:Object.fromEntries(Object.entries(expense.categories??{}).map(([key,row])=>[key,{treatment:row.treatment,owner_share_bps:row.owner_share_bps,alvillas_share_bps:row.alvillas_share_bps,guest_share_bps:row.guest_share_bps,approval_rule_key:row.approval_rule_key}]))},
   approval:{thresholds:approval.thresholds.map(row=>({key:row.key,category:row.category,amount:row.amount,currency:row.currency,percentage_of_revenue_bps:row.percentage_of_revenue_bps,conditions:row.conditions,emergency_bypass_owner:row.emergency_bypass_owner,requires_approval_from:row.requires_approval_from}))},
   payout:{cadence:payout.cadence,hold_days:payout.hold_days,holdback_amount:payout.holdback_amount,holdback_currency:payout.holdback_currency,holdback_bps:payout.holdback_bps,cron:payout.cron},
   noticePeriodDays:notice.notice_period_days,includedCosts:content.included_costs,ownerExpenses:content.owner_expenses,alvillasExpenses:content.alvillas_expenses,guestPaidItems:content.guest_paid_items,specialConditions:content.special_conditions,commissionTerms:content.commission_terms??null,payoutRules:content.payout_rules??null},
  responsibilities:content.responsibilities,
  operatingModel:{members,workflows:workflows.settings,bookingChannels:bookingChannels.channels.map(channel=>({sourceKey:channel.sourceKey,displayName:channel.displayName,listingUrl:channel.listingUrl,syncMode:channel.syncMode,importEnabled:channel.importEnabled,exportEnabled:channel.exportEnabled,status:channel.status})),inventory:inventory.settings,serviceAvailability:services.settings.services,emergencyProcedures:content.emergency_procedures},
  ownerAccess:{capabilities:ownerAccess.capabilities,asOf:ownerAccess.asOf}
 };
}
export type OnboardingOwnerPackage=ReturnType<typeof buildOnboardingOwnerPackage>;
