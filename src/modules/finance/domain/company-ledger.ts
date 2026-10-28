import { Money } from "@/platform/money/money";
import { z } from "zod";
import { canViewCompleteOwnerLedger } from "./owner-ledger";
import type { AuthContext, Resource, Scope } from "@/platform/authz/authorize";

export const companyLedgerFilters = z.object({
  fromOn: z.iso.date().optional(), toOn: z.iso.date().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/u).optional(),
  timezone: z.string().max(100).refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } }).optional(),
  after: z.uuid().transform(value => value.toLowerCase()).optional()
}).strict().refine(value => !value.fromOn || !value.toOn || value.fromOn <= value.toOn, { path: ["toOn"], message: "End must follow start" });

export function canViewCompleteCompanyLedger(ctx: AuthContext, resource: Resource, now: Date) {
  const organizationScope = (scope: Scope) => (scope.scopeType ?? scope.resourceType) === "organization";
  if (ctx.assignments) {
    const assignments = ctx.assignments.filter(assignment => organizationScope(assignment.scope));
    return assignments.length > 0 && canViewCompleteOwnerLedger({ ...ctx, assignments }, resource, now);
  }
  const scopes = ctx.scopes.filter(organizationScope);
  return scopes.length > 0 && canViewCompleteOwnerLedger({ ...ctx, scopes }, resource, now);
}

export type CompanyLedgerAccountTotals = {
  id: string;
  code: string;
  name: string;
  opening: string;
  credits: string;
  debits: string;
  count: string;
};

/** ALVILLAS' own net position is credits minus debits, independently of cash held. */
export function companyLedgerTotals(rows: readonly CompanyLedgerAccountTotals[], currency: string) {
  let opening = Money.zero(currency), credits = Money.zero(currency), debits = Money.zero(currency), count = 0n;
  const accounts = rows.map(row => {
    const before = Money.of(row.opening, currency), cr = Money.of(row.credits, currency), dr = Money.of(row.debits, currency);
    opening = opening.add(before);
    credits = credits.add(cr);
    debits = debits.add(dr);
    count += BigInt(row.count);
    return { id: row.id, code: row.code, name: row.name, openingBalance: before.toJSON().amount,
      periodCredits: cr.toJSON().amount, periodDebits: dr.toJSON().amount, closingBalance: before.add(cr).subtract(dr).toJSON().amount };
  });
  return { openingBalance: opening.toJSON().amount, periodCredits: credits.toJSON().amount, periodDebits: debits.toJSON().amount,
    periodResult: credits.subtract(debits).toJSON().amount, closingBalance: opening.add(credits).subtract(debits).toJSON().amount, rowCount: count.toString(), accounts };
}
