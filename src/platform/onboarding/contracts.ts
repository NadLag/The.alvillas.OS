import {z} from "zod";
import {ownerInputSchema,propertyInputSchema,propertyOperatingProfileInputSchema,operatingCadenceSchema,managementAgreementDraftTermsSchema,managementAgreementInputSchema,bookingChannelInputSchema,bookingChannelSyncModeSchema,bookingChannelStatusSchema} from "@/modules/core/domain/owner-property";
import {payoutScheduleConfigSchema,approvalThresholdsConfigSchema,commissionBasisSchema,commissionAccrualEventSchema,expenseTreatmentSchema,payoutCadenceSchema,approvalStepSchema} from "@/platform/config/rule-registry";
import {teamAssignmentDraftSchema,teamAssignmentSchema} from "@/modules/identity/domain/team";
export {propertyStatusSchema as onboardingPropertyStatusSchema} from "@/modules/core/domain/owner-property";
export {managementAgreementRuleKeys as onboardingManagementAgreementRuleKeys} from "@/modules/core/domain/owner-property";
export {maskedBookingChannelEndpoint as maskedNativeOnboardingChannelEndpoint} from "@/modules/core/domain/owner-property";
export const onboardingOperatingCadences=operatingCadenceSchema.options;
export {bookingChannelSyncModeSchema as onboardingBookingChannelSyncModeSchema,bookingChannelStatusSchema as onboardingBookingChannelStatusSchema};

/** Explicit native configuration reuses Core validation; null endpoint means retain the existing encrypted endpoint. */
const nativeChannelSchema=bookingChannelInputSchema.omit({propertyId:true}).safeExtend({syncMode:bookingChannelSyncModeSchema,importEnabled:z.boolean(),exportEnabled:z.boolean(),status:bookingChannelStatusSchema}).strict();
const nativeChannelFields=["sourceKey","displayName","externalListingId","listingUrl","syncMode","importEnabled","exportEnabled","syncEndpointUrl","status"]as const;
export const onboardingBookingChannelInputSchema=z.record(z.string(),z.unknown()).transform((raw,context)=>{
 try{for(const key of nativeChannelFields)if(!Object.hasOwn(raw,key)||raw[key]===undefined)throw Error("native_onboarding_explicit_channel_required");const values={...raw};for(const key of["externalListingId","listingUrl","syncEndpointUrl"]as const)if(values[key]===null)values[key]=undefined;const value=nativeChannelSchema.parse(values);for(const url of[value.listingUrl,value.syncEndpointUrl])if(url&&!["http:","https:"].includes(new URL(url).protocol))throw Error("native_onboarding_http_channel_url_required");return{sourceKey:value.sourceKey,displayName:value.displayName,externalListingId:value.externalListingId??null,listingUrl:value.listingUrl??null,syncMode:value.syncMode,importEnabled:value.importEnabled,exportEnabled:value.exportEnabled,syncEndpointUrl:value.syncEndpointUrl??null,status:value.status};}catch{context.addIssue({code:"custom",message:"native_onboarding_explicit_channel_required"});return z.NEVER;}
});
/** Public original drafts reuse every Core constraint while rejecting any submitted credential. */
export const onboardingBookingChannelSafeInputSchema=z.record(z.string(),z.unknown()).transform((raw,context)=>{
 try{const{hasSubmittedSyncEndpoint,...configuration}=raw;if(typeof hasSubmittedSyncEndpoint!=="boolean"||Object.hasOwn(configuration,"syncEndpointUrl"))throw Error("native_onboarding_safe_channel_required");const{syncEndpointUrl,...value}=onboardingBookingChannelInputSchema.parse({...configuration,syncEndpointUrl:null});void syncEndpointUrl;return{...value,hasSubmittedSyncEndpoint};}catch{context.addIssue({code:"custom",message:"native_onboarding_safe_channel_required"});return z.NEVER;}
});

/** The wizard uses the Core Owner contract; representatives and payout setup retain their own authorization. */
export const onboardingOwnerInputSchema=ownerInputSchema.omit({representatives:true,payoutMethods:true}).strict();

/** Keep Core validation and its cross-field checks; operational activation has a later native producer. */
const nativePhysicalPropertySchema=propertyInputSchema.safeExtend({ownerId:z.uuid().transform(value=>value.toLowerCase()),status:z.literal("DRAFT")}).strict();
export const onboardingPhysicalPropertyDefaults=Object.freeze({countryCode:propertyInputSchema.shape.countryCode.parse(undefined),timezone:propertyInputSchema.shape.timezone.parse(undefined),livingSpaces:propertyInputSchema.shape.livingSpaces.parse(undefined),parkingSpaces:propertyInputSchema.shape.parkingSpaces.parse(undefined),hasPool:propertyInputSchema.shape.hasPool.parse(undefined),hasGarden:propertyInputSchema.shape.hasGarden.parse(undefined)});
export const onboardingPropertyInputSchema=z.record(z.string(),z.unknown()).superRefine((value,context)=>{
 for(const key of["operatingProfile","onboardingProfile"])if(Object.hasOwn(value,key))context.addIssue({code:"custom",path:[key],message:"native_onboarding_physical_input_required"});
}).pipe(nativePhysicalPropertySchema).transform(value=>{
 const{operatingProfile,onboardingProfile,...physical}=value;void operatingProfile;void onboardingProfile;return physical;
});

/** A configured initial profile supplies its own business choices; Core defaults cannot choose them. */
export function parseConfiguredOnboardingPropertyProfile(raw:unknown){
 const value=z.record(z.string(),z.unknown()).parse(raw);
 for(const[key,field]of Object.entries(propertyOperatingProfileInputSchema.shape)){
  if((field instanceof z.ZodDefault||!field.isOptional())&&!Object.hasOwn(value,key))throw new Error("native_onboarding_operating_configuration_required");
  const underlying=field instanceof z.ZodDefault?field.unwrap():field;
  if(underlying instanceof z.ZodBoolean&&typeof value[key]!=="boolean")throw new Error("native_onboarding_operating_configuration_required");
 }
 return propertyOperatingProfileInputSchema.strict().parse(value);
}

/** A reviewed native update supplies every operational choice; Core defaults cannot select services. */
export const onboardingOperatingProfileInputSchema=z.record(z.string(),z.unknown()).transform((raw,context)=>{
 try{return parseConfiguredOnboardingPropertyProfile(raw);}catch{context.addIssue({code:"custom",message:"native_onboarding_explicit_operating_profile_required"});return z.NEVER;}
});

/** Captured Core values retain explicit nullable optional fields and never fill missing historical choices. */
export const onboardingOperatingProfileSnapshotSchema=z.record(z.string(),z.unknown()).transform((raw,context)=>{
 if(!Object.hasOwn(raw,"midStayCleaningRuleKey")||!Object.hasOwn(raw,"automationNotes")){context.addIssue({code:"custom",message:"native_onboarding_original_operating_profile_required"});return z.NEVER;}
 try{const midStayCleaningRuleKey=z.string().nullable().parse(raw.midStayCleaningRuleKey),automationNotes=z.string().nullable().parse(raw.automationNotes),otherServices=z.array(z.string()).parse(raw.otherServices),value=parseConfiguredOnboardingPropertyProfile({...raw,midStayCleaningRuleKey:midStayCleaningRuleKey??undefined,automationNotes:undefined});return{...value,otherServices,midStayCleaningRuleKey,automationNotes};}catch{context.addIssue({code:"custom",message:"native_onboarding_original_operating_profile_required"});return z.NEVER;}
});

export const onboardingManagementAgreementReasonSchema=managementAgreementInputSchema.shape.reason;
export const onboardingManagementAgreementChoices={commissionBasis:commissionBasisSchema.options,commissionAccrualEvent:commissionAccrualEventSchema.options,expenseDefaultTreatment:expenseTreatmentSchema.options,payoutCadence:payoutCadenceSchema.options,approvalRequires:approvalStepSchema.options};
/** Every financial choice is explicit; only native admission supplies the Core lifecycle and audit reason. */
export const onboardingManagementAgreementInputSchema=z.record(z.string(),z.unknown()).transform((raw,context)=>{
 try{
  for(const key of Object.keys(managementAgreementDraftTermsSchema.shape))if(!Object.hasOwn(raw,key)||raw[key]===undefined)throw new Error("native_onboarding_explicit_agreement_terms_required");
  for(const key of["commissionRateBps","noticePeriodDays","payoutHoldDays","payoutHoldbackBps"])if(typeof raw[key]!=="number"||!Number.isSafeInteger(raw[key]))throw new Error("native_onboarding_explicit_agreement_terms_required");
  for(const key of["effectiveFrom","effectiveTo"])if(!(key==="effectiveTo"&&raw[key]===null)&&!(typeof raw[key]==="string"&&raw[key].length>0||raw[key] instanceof Date))throw new Error("native_onboarding_explicit_agreement_dates_required");
  const value=managementAgreementDraftTermsSchema.strict().parse({...raw,effectiveTo:raw.effectiveTo===null?undefined:raw.effectiveTo,approvalThresholdKey:raw.approvalThresholdKey===null?undefined:raw.approvalThresholdKey,approvalThresholdAmount:raw.approvalThresholdAmount===null?undefined:raw.approvalThresholdAmount});
  if(Boolean(value.approvalThresholdKey)!==Boolean(value.approvalThresholdAmount))throw new Error("native_onboarding_explicit_agreement_approval_required");
  payoutScheduleConfigSchema.parse({cadence:value.payoutCadence,hold_days:value.payoutHoldDays,holdback_bps:value.payoutHoldbackBps});
  approvalThresholdsConfigSchema.parse({thresholds:value.approvalThresholdAmount?[{key:value.approvalThresholdKey,amount:value.approvalThresholdAmount,currency:value.approvalThresholdCurrency,requires_approval_from:value.approvalRequires}]:[]});
  return{...value,effectiveFrom:value.effectiveFrom.toISOString(),effectiveTo:value.effectiveTo?.toISOString()??null,approvalThresholdKey:value.approvalThresholdKey??null,approvalThresholdAmount:value.approvalThresholdAmount??null,payoutHoldDays:value.payoutHoldDays!,payoutHoldbackBps:value.payoutHoldbackBps!};
 }catch{context.addIssue({code:"custom",message:"native_onboarding_explicit_agreement_terms_required"});return z.NEVER;}
});

export {managementAgreementConfigValues as nativeOnboardingManagementAgreementRuleValues} from "@/modules/core/domain/owner-property";

export const onboardingTeamAssignmentReasonSchema=teamAssignmentSchema.shape.reason;
/** Native assignment never selects an account, scope, dates or access condition by default. */
export const onboardingTeamAssignmentInputSchema=z.record(z.string(),z.unknown()).transform((raw,context)=>{
 try{
  for(const key of Object.keys(teamAssignmentDraftSchema.shape))if(!Object.hasOwn(raw,key)||raw[key]===undefined)throw Error("native_onboarding_explicit_assignment_required");
  if(typeof raw.assignedToMe!=="boolean")throw Error("native_onboarding_explicit_assignment_condition_required");
  for(const key of["validFrom","validTo"])if(!(key==="validTo"&&raw[key]===null)&&!(raw[key] instanceof Date))z.iso.datetime({offset:true}).parse(raw[key]);
  const value=teamAssignmentDraftSchema.parse(raw);return{personId:value.personId.toLowerCase(),roleId:value.roleId.toLowerCase(),userAccountId:value.userAccountId?.toLowerCase()??null,validFrom:value.validFrom.toISOString(),validTo:value.validTo?.toISOString()??null,assignedToMe:value.assignedToMe};
 }catch{context.addIssue({code:"custom",message:"native_onboarding_explicit_assignment_required"});return z.NEVER;}
});
