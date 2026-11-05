import { z } from "zod";
import { guestDepositPolicySnapshot } from "./guest-deposit-snapshot";
export const externalPaymentRefundReviewSnapshot = z.object({ intentId: z.uuid(), reviewFingerprint: z.string().regex(/^[a-f0-9]{64}$/u), policy: guestDepositPolicySnapshot }).strict();
