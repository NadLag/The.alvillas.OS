import { z } from "zod";
import { getOwnerStatement, OwnerPortalNotFoundError } from "./owner-portal-service";
import type { OwnerPortalActorContext } from "./owner-portal-access";

const activityBuckets = ["OWNER_REVENUE", "OWNER_SERVICES", "COMMISSION", "OTA_FEE", "OWNER_EXPENSE", "REIMBURSEMENT"] as const;
const activityBucket = z.enum(activityBuckets);
export const activitySelection = z.strictObject({
  from: z.iso.date().optional(), to: z.iso.date().optional(), currency: z.string().regex(/^[A-Z]{3}$/u).optional(),
  bucket: activityBucket.optional(), posting: z.uuid().optional(), page: z.coerce.number().int().positive().optional()
}).refine(input => !input.from || !input.to || input.from <= input.to);

export async function getOwnerFinancialActivity(ctx: OwnerPortalActorContext, propertyId: string, input: z.infer<typeof activitySelection>,
  deps?: Parameters<typeof getOwnerStatement>[3]) {
  const statement = await getOwnerStatement(ctx, propertyId, { from: input.from, to: input.to, currency: input.currency }, deps);
  const rows = statement.lines.flatMap(line => {
    const bucket = activityBucket.safeParse(line.bucket);
    if (!bucket.success || input.bucket && input.bucket !== bucket.data) return [];
    return [{ id: line.postingId, reference: line.reference, occurredAt: line.occurredAt, category: bucket.data,
      amount: line.signedAmount, reversal: Boolean(line.reversal), reservationId: line.reservationId ?? null,
      reservationReference: line.reservationReference }];
  }).reverse();
  const page = input.page ?? 1, size = 40;
  const detail = input.posting ? rows.find(row => row.id === input.posting) : null;
  if (input.posting && !detail) throw new OwnerPortalNotFoundError();

  return { propertyName: statement.propertyName, timezone: statement.timezone, currency: statement.currency,
    currencies: statement.currencies, from: statement.fromOn, to: statement.toOn, page, detail,
    totals: activityBuckets.map(bucket => ({ bucket, amount: statement.bucketTotals[bucket] })),
    rows: rows.slice((page - 1) * size, page * size), more: rows.length > page * size };
}
