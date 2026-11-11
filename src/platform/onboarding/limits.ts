/** Technical wire/storage ceilings; catalog business choices remain in config_rule. */
export const onboardingMaximumRequestBytes=65536;
export const onboardingMaximumCatalogRecordBytes=onboardingMaximumRequestBytes*64;
export const onboardingMaximumWorkflowRecordBytes=onboardingMaximumCatalogRecordBytes*8;
export const onboardingMaximumConfigurationRecordBytes=onboardingMaximumWorkflowRecordBytes*4;
export const onboardingMaximumSmallResponseBytes=1024*1024;
