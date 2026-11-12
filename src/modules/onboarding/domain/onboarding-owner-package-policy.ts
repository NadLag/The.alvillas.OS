import {z} from "zod";
import {localizedTextSchema} from "@/i18n/content";
import {onboardingIdSchema,onboardingFingerprintSchema} from "./onboarding-primitives";
import {managementAgreementRuleKeys as onboardingManagementAgreementRuleKeys} from "@/platform/config/management-agreement-keys";

export const onboardingOwnerPackagePolicyKey="onboarding.owner_package";
export const onboardingOwnerPackageContentKey="finance.onboarding_package_content";
export const onboardingOwnerPackageSections=["PROPERTY","PROVIDED_SERVICES","FINANCIAL_AGREEMENT","RESPONSIBILITIES","OPERATING_MODEL","OWNER_ACCESS"]as const;
export const onboardingOwnerPackagePolicySchema=z.object({
 source:z.literal("NATIVE_VALIDATED_ONBOARDING_REVIEW"),
 document_type:z.string().regex(/^[a-z][a-z0-9_]{0,119}$/u),
 templates:z.object({en:onboardingIdSchema,fr:onboardingIdSchema,ar:onboardingIdSchema.optional()}).strict(),
 content_key:z.literal(onboardingOwnerPackageContentKey)
}).strict().refine(value=>new Set(Object.values(value.templates)).size===Object.values(value.templates).length,{message:"distinct_owner_package_variants_required",path:["templates"]});
const lines=(maximum:number)=>z.object({en:z.array(z.string().trim().min(1).max(240)).max(maximum),fr:z.array(z.string().trim().min(1).max(240)).max(maximum),ar:z.array(z.string().trim().min(1).max(240)).max(maximum).optional()}).strict().refine(value=>value.en.length===value.fr.length&&(value.ar===undefined||value.ar.length===value.en.length),"equal_approved_localization_item_counts_required");
export const onboardingOwnerPackageAgreementPinSchema=z.object({id:onboardingIdSchema,key:z.enum(onboardingManagementAgreementRuleKeys),version:z.number().int().positive(),value_fingerprint:onboardingFingerprintSchema}).strict();
/** Bilingual legal/business wording is approved configuration anchored to all seven actual agreement rules. */
export const onboardingOwnerPackageContentSchema=z.object({
 agreement_id:onboardingIdSchema,
 agreement_rules:z.array(onboardingOwnerPackageAgreementPinSchema).length(onboardingManagementAgreementRuleKeys.length).refine(values=>new Set(values.map(value=>value.key)).size===onboardingManagementAgreementRuleKeys.length&&new Set(values.map(value=>value.id)).size===onboardingManagementAgreementRuleKeys.length),
 responsibilities:z.object({owner:lines(40),alvillas:lines(40)}).strict(),
 special_conditions:lines(80),
 commission_terms:lines(200).optional(),payout_rules:lines(200).optional(),
 included_costs:lines(200),owner_expenses:lines(200),alvillas_expenses:lines(200),guest_paid_items:lines(200),
 additional_services:z.array(z.object({key:z.string().regex(/^[a-z][a-z0-9_]{0,119}$/u),name:localizedTextSchema.strict(),enabled:z.boolean()}).strict()).max(200).refine(values=>new Set(values.map(value=>value.key)).size===values.length),
 emergency_procedures:lines(200)
}).strict();
export type OnboardingOwnerPackagePolicy=z.infer<typeof onboardingOwnerPackagePolicySchema>;
export type OnboardingOwnerPackageContent=z.infer<typeof onboardingOwnerPackageContentSchema>;
