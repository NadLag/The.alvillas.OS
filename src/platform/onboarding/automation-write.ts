import {saveAutomationRule,AutomationAccessError} from "@/platform/automation/service";
import {ConfigAuthorizationError} from "@/modules/config/application/config-service";
import {OnboardingAccessError} from "@/modules/onboarding/domain/onboarding-wizard";

/** Canonical automation/configuration services own every actual version, scope check, audit and outbox. */
export async function saveOnboardingAutomation(actor:Parameters<typeof saveAutomationRule>[0],input:unknown,deps:Parameters<typeof saveAutomationRule>[2]){try{return await saveAutomationRule(actor,input,deps);}catch(error){if(error instanceof AutomationAccessError||error instanceof ConfigAuthorizationError)throw new OnboardingAccessError();throw error;}}
