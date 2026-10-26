import { z } from "zod";
import { Money } from "@/platform/money/money";

const requestKey = z.uuid().transform(value => value.toLowerCase());
const id = z.uuid().transform(value => value.toLowerCase());
const reason = z.string().trim().min(6).max(500);
export const transactionGroupSchema = z.object({ name: z.string().trim().min(1).max(120), reason, idempotencyKey: requestKey }).strict();
export const transactionGroupEntrySchema = z.object({ groupId: id, transactionId: id,
  previousEntryId: id.nullable(), action: z.enum(["ATTACH", "DETACH"]), reason, idempotencyKey: requestKey }).strict();
export const transactionGroupFilters = z.object({ after: z.uuid().optional(), query: z.string().trim().max(120).optional() }).strict();

export function groupedAccountMovements(rows: Array<{ ledgerAccountId: string; side: string; currency: string; amount: string;
  account: { name: string; accountType: string; normalSide: string } }>) {
  const values = new Map<string, { accountId: string; name: string; accountType: string; currency: string; net: Money }>();
  for (const row of rows) {
    const key = `${row.ledgerAccountId}:${row.currency}`;
    const value = values.get(key) ?? { accountId: row.ledgerAccountId, name: row.account.name, accountType: row.account.accountType,
      currency: row.currency, net: Money.zero(row.currency) };
    const amount = Money.of(row.amount, row.currency);
    value.net = row.side === row.account.normalSide ? value.net.add(amount) : value.net.subtract(amount);
    values.set(key, value);
  }
  return [...values.values()].map(({ net, ...value }) => ({ ...value, amount: net.toJSON().amount }));
}
