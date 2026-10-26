import { z } from "zod";

export const paymentAccountKinds = ["BANK", "CASH", "OTHER"] as const;
export const paymentAccountSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(paymentAccountKinds),
  reason: z.string().trim().min(6).max(500),
  idempotencyKey: z.uuid().transform(value => value.toLowerCase())
}).strict();

export type PaymentAccountInput = z.infer<typeof paymentAccountSchema>;

// The request identity reserves a location code without colliding with claim,
// employee-wallet or cash-custody accounts maintained by their own workflows.
export function paymentAccountCode(input: Pick<PaymentAccountInput, "kind" | "idempotencyKey">): string {
  return `${input.kind}_${input.idempotencyKey.replaceAll("-", "").toUpperCase()}`;
}
