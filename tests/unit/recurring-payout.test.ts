import {describe,expect,it} from "vitest";
import {recurringPayoutPolicySchema} from "@/modules/finance/domain/recurring-payout";
const policy={source:"CURRENT_APPROVED_OWNER_PAYOUTS",principal:"CURRENT_CONFIGURATION_AUTHOR",schedule:"FROZEN_APPROVED_ELIGIBILITY",batch_size:25};
describe("explicit approved-payout scheduling policy",()=>{
 it("accepts only the existing approved source and frozen eligibility",()=>expect(recurringPayoutPolicySchema.parse(policy)).toEqual(policy));
 it.each([{...policy,source:"ALL_DRAFTS"},{...policy,principal:"ADMIN_ROLE"},{...policy,schedule:"NOW"},{...policy,batch_size:undefined},{...policy,batch_size:0},{...policy,batch_size:501},{...policy,amount:"100.00"},{...policy,auto_pay:true}])("rejects bypasses and implicit business values %#",value=>expect(recurringPayoutPolicySchema.safeParse(value).success).toBe(false));
});
