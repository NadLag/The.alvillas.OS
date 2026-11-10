import {describe,expect,it,vi} from "vitest";
vi.mock("next/headers",()=>{throw Error("native_source_import_must_not_load_framework_headers");});
import {CoreAuthorizationError,CoreNotFoundError,CoreValidationError} from "@/modules/core/application/core-access";
import {NativeOnboardingBookingChannelAuthorizationError,NativeOnboardingBookingChannelNotFoundError,NativeOnboardingBookingChannelValidationError} from "@/platform/onboarding/booking-channels-source";

describe("native Core error identities without framework request loading",()=>{
 it("loads the source boundary without request headers and retains each sole canonical error constructor",()=>{for(const [canonical,alias,message]of[[CoreAuthorizationError,NativeOnboardingBookingChannelAuthorizationError,"Core action is not authorized"],[CoreNotFoundError,NativeOnboardingBookingChannelNotFoundError,"Core resource was not found"],[CoreValidationError,NativeOnboardingBookingChannelValidationError,"Core input is invalid"]]as const){expect(alias).toBe(canonical);expect(new alias()).toMatchObject({name:canonical.name,message});expect(new alias("Actual retained private failure reason")).toBeInstanceOf(canonical);}});
});
