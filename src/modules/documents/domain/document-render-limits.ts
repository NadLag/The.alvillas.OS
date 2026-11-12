import {documentTemplateMaximumBytes} from "./document-template-format";

export const onboardingReportRenderProfile="NATIVE_ONBOARDING_REVIEW_V1";
// Two hundred declared 20,000 UTF-16-unit bindings require up to 12 MB of UTF-8.
// The envelope also admits JSON escaping and renderer metadata, with a fixed ceiling.
export const onboardingReportMaximumRenderedBytes=16*1024*1024;
export type DocumentRenderInputProfile=typeof onboardingReportRenderProfile;
export function documentMaximumRenderedBytes(profile?:DocumentRenderInputProfile){return profile===onboardingReportRenderProfile?onboardingReportMaximumRenderedBytes:documentTemplateMaximumBytes;}
