import {z} from "zod";
import {ownerInputSchema,propertyInputSchema,propertyOperatingProfileInputSchema,operatingCadenceSchema} from "@/modules/core/domain/owner-property";
export {propertyStatusSchema as onboardingPropertyStatusSchema} from "@/modules/core/domain/owner-property";
export const onboardingOperatingCadences=operatingCadenceSchema.options;

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
