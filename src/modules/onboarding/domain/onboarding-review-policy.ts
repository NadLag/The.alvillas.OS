import {z} from "zod";
export const onboardingReviewOwnerFields=["displayName","email","phone","preferredLocale"]as const;
export const onboardingReviewPropertyFields=["name","addressLine1","addressLine2","cityId","regionId","city","region","countryCode","propertyType","bedrooms","bathrooms","livingSpaces","parkingSpaces","maxGuests","hasPool","hasGarden","timezone","amenities","photoUrls"]as const;
/** Business completeness requirements are explicit organization configuration; structural source checks are always enforced. */
export const onboardingReviewPolicySchema=z.object({modes:z.array(z.literal("VALIDATE")).length(1),required_owner_fields:z.array(z.enum(onboardingReviewOwnerFields)).max(onboardingReviewOwnerFields.length).refine(values=>new Set(values).size===values.length),required_property_fields:z.array(z.enum(onboardingReviewPropertyFields)).max(onboardingReviewPropertyFields.length).refine(values=>new Set(values).size===values.length)}).strict();
