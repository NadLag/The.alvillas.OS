import { Prisma } from "@prisma/client";
import { Money } from "@/platform/money/money";
import { canUseHousehold, presentPersonal } from "../domain/household-access";
import {
  dayValue, financeAreas, financeEntrySchema, financeKindSchema, isMovement, monthStart,
  reverseEntrySchema, type FinanceKind
} from "../domain/personal-finance";
import { PersonalConflict, type HouseholdScope } from "./household-repository";

const pageSize = 50;
type Row = {
  id: string; seriesId: string; label: string; category: string; amount: Prisma.Decimal; currency: string;
  effectiveOn: Date; reversesId: string | null; goalId: string | null; withdrawal: boolean; closed: boolean;
};
type Group = { kind: string; currency: string; category: string; amount: Prisma.Decimal };
type GoalTotal = { goalId: string; amount: Prisma.Decimal };
export type FinanceCursor = { effectiveOn: string; id: string };

function financeData(row: Row) {
  return { ...row, effectiveOn: row.effectiveOn.toISOString().slice(0, 10), amount: row.amount.toFixed(2) };
}

export class PersonalFinanceRepository {
  constructor(private readonly scope: HouseholdScope) {}

  private find(id: string) {
    return this.scope.tx.personalFinanceEntry.findUnique({
      where: { organizationId_householdId_id: { ...this.scope.key, id } }
    });
  }

  private findCommand(commandId: string) {
    return this.scope.tx.personalFinanceEntry.findUnique({
      where: { organizationId_householdId_commandId: { ...this.scope.key, commandId } }
    });
  }

  async record(input: unknown) {
    const value = financeEntrySchema.parse(input);
    const area = financeAreas[value.kind];
    this.scope.require(area, "edit");
    const amount = Money.of(value.amount, value.currency).toJSON().amount;
    const effectiveOn = dayValue(value.kind === "BUDGET" ? monthStart(value.effectiveOn) : value.effectiveOn);
    const { id: commandId, seriesId, goalId = null, ...entry } = value;
    const existing = await this.findCommand(commandId);
    if (existing) {
      if (existing.createdBy !== this.scope.identity.accountId || existing.reversesId
        || existing.kind !== value.kind || existing.seriesId !== (seriesId ?? existing.id) || existing.goalId !== goalId
        || existing.label !== value.label || existing.category !== value.category || existing.currency !== value.currency
        || existing.amount.toFixed(2) !== amount || existing.effectiveOn.getTime() !== effectiveOn.getTime()
        || existing.withdrawal !== value.withdrawal || existing.closed !== value.closed) throw new PersonalConflict();
      return;
    }

    if (goalId) {
      const goal = await this.find(goalId);
      if (!goal || goal.kind !== "SAVINGS_GOAL" || goal.seriesId !== goal.id || goal.currency !== value.currency) {
        throw new PersonalConflict();
      }
      const latest = await this.scope.tx.personalFinanceEntry.findFirst({
        where: { ...this.scope.key, kind: "SAVINGS_GOAL", seriesId: goalId },
        orderBy: [{ effectiveOn: "desc" }, { createdAt: "desc" }, { id: "desc" }], select: { closed: true }
      });
      if (latest?.closed) throw new PersonalConflict();
    }

    if (value.seriesId) {
      const root = await this.find(value.seriesId);
      if (!root || root.seriesId !== root.id || root.kind !== value.kind || root.currency !== value.currency
        || value.kind === "BUDGET" && (root.category !== value.category || root.effectiveOn.getTime() !== effectiveOn.getTime())) {
        throw new PersonalConflict();
      }
      const latest = await this.scope.tx.personalFinanceEntry.findFirst({
        where: { ...this.scope.key, kind: value.kind, seriesId },
        orderBy: [{ effectiveOn: "desc" }, { createdAt: "desc" }, { id: "desc" }], select: { effectiveOn: true }
      });
      if (latest && latest.effectiveOn > effectiveOn) throw new PersonalConflict();
    } else if (value.kind === "BUDGET") {
      const budget = await this.scope.tx.personalFinanceEntry.findFirst({
        where: { ...this.scope.key, kind: value.kind, currency: value.currency, category: value.category, effectiveOn },
        select: { id: true }
      });
      if (budget) throw new PersonalConflict();
    }
    const id = await this.scope.nextId();
    await this.scope.tx.personalFinanceEntry.create({
      data: { ...this.scope.key, ...entry, id, commandId, amount, effectiveOn, seriesId: seriesId ?? id, goalId,
        createdBy: this.scope.identity.accountId }
    });
    await this.scope.audit(seriesId ? "personal.finance_revised" : "personal.finance_recorded", `personal_${area}`, id,
      undefined, { kind: value.kind, seriesId: seriesId ?? id });
  }

  async reverse(kind: FinanceKind, input: unknown) {
    const value = reverseEntrySchema.parse(input);
    const area = financeAreas[kind];
    this.scope.require(area, "edit");
    if (!isMovement(kind)) throw new PersonalConflict();
    const existing = await this.findCommand(value.id);
    if (existing) {
      if (existing.reversesId !== value.sourceId || existing.createdBy !== this.scope.identity.accountId || existing.kind !== kind) {
        throw new PersonalConflict();
      }
      return;
    }
    const source = await this.find(value.sourceId);
    if (!source || source.kind !== kind || source.reversesId) throw new PersonalConflict();
    const priorReversal = await this.scope.tx.personalFinanceEntry.findFirst({
      where: { ...this.scope.key, reversesId: source.id }, select: { id: true }
    });
    if (priorReversal) throw new PersonalConflict();
    const { kind: sourceKind, label, category, amount, currency, effectiveOn, goalId, withdrawal } = source;
    const id = await this.scope.nextId();
    await this.scope.tx.personalFinanceEntry.create({ data: {
      ...this.scope.key, id, commandId: value.id, seriesId: id, kind: sourceKind, label, category,
      amount, currency, effectiveOn, goalId, withdrawal, reversesId: source.id, createdBy: this.scope.identity.accountId
    } });
    await this.scope.audit("personal.finance_reversed", `personal_${area}`, id, { sourceId: source.id }, undefined, value.reason);
  }

  async list(kind: FinanceKind, after?: FinanceCursor, historyOf?: string) {
    const area = financeAreas[kind];
    this.scope.require(area);
    const { organizationId, householdId } = this.scope.key;
    const base = Prisma.sql`SELECT id, series_id AS "seriesId", label, category, amount, currency, effective_on AS "effectiveOn",
      reverses_id AS "reversesId", goal_id AS "goalId", withdrawal, closed
      FROM personal_finance_entry
      WHERE organization_id = ${organizationId}::uuid AND household_id = ${householdId}::uuid AND kind = ${kind}`;
    const latest = historyOf ? Prisma.sql`${base} AND series_id = ${historyOf}::uuid`
      : isMovement(kind) ? base : Prisma.sql`
        SELECT DISTINCT ON (series_id) id, series_id AS "seriesId", label, category, amount, currency,
          effective_on AS "effectiveOn", reverses_id AS "reversesId", goal_id AS "goalId", withdrawal, closed
        FROM personal_finance_entry WHERE organization_id = ${organizationId}::uuid
          AND household_id = ${householdId}::uuid AND kind = ${kind}
        ORDER BY series_id, effective_on DESC, created_at DESC, id DESC
      `;
    const rows = await this.scope.tx.$queryRaw<Row[]>(Prisma.sql`
      SELECT * FROM (${latest}) AS visible
      ${after ? Prisma.sql`WHERE ("effectiveOn", id) < (${after.effectiveOn}::date, ${after.id}::uuid)` : Prisma.empty}
      ORDER BY "effectiveOn" DESC, id DESC LIMIT ${pageSize + 1}
    `);
    const items = rows.slice(0, pageSize).map((row) =>
      presentPersonal(this.scope.authority, householdId, area, financeData(row)));
    const last = items.at(-1);
    return { items, next: rows.length > pageSize && last ? { effectiveOn: last.effectiveOn, id: last.id } : undefined };
  }

  async budgetSpending(budgets: readonly { seriesId: string; category: string; currency: string; effectiveOn: string }[]) {
    this.scope.require("budgets");
    if (!budgets.length || !canUseHousehold(this.scope.authority, this.scope.id, "expenses")) return null;
    const { organizationId, householdId } = this.scope.key;
    const windows = budgets.map(({ seriesId, category, currency, effectiveOn }) =>
      Prisma.sql`(${seriesId}::uuid, ${category}::text, ${currency}::char(3), ${effectiveOn}::date)`);
    const rows = await this.scope.tx.$queryRaw<{ id: string; amount: Prisma.Decimal }[]>(Prisma.sql`
      SELECT budget.id, COALESCE(SUM(CASE WHEN entry.reverses_id IS NULL THEN entry.amount ELSE -entry.amount END), 0) AS amount
      FROM (VALUES ${Prisma.join(windows)}) AS budget(id, category, currency, starts_on)
      LEFT JOIN personal_finance_entry entry ON entry.organization_id = ${organizationId}::uuid
        AND entry.household_id = ${householdId}::uuid AND entry.kind = 'EXPENSE'
        AND entry.effective_on >= budget.starts_on AND entry.effective_on < budget.starts_on + interval '1 month'
        AND entry.category = budget.category AND entry.currency = budget.currency
      GROUP BY budget.id
    `);
    return presentPersonal(this.scope.authority, this.scope.id, "expenses",
      Object.fromEntries(rows.map((row) => [row.id, row.amount.toFixed(2)])));
  }

  async savingsProgress(goalIds: string[], through: string) {
    this.scope.require("savings");
    if (!goalIds.length) return {};
    const { organizationId, householdId } = this.scope.key;
    const rows = await this.scope.tx.$queryRaw<GoalTotal[]>(Prisma.sql`
      SELECT goal_id AS "goalId", SUM(CASE WHEN (reverses_id IS NOT NULL) <> withdrawal THEN -amount ELSE amount END) AS amount
      FROM personal_finance_entry
      WHERE organization_id = ${organizationId}::uuid AND household_id = ${householdId}::uuid
        AND kind = 'SAVINGS_MOVEMENT' AND effective_on <= ${through}::date
        AND goal_id IN (${Prisma.join(goalIds.map((id) => Prisma.sql`${id}::uuid`))}) GROUP BY goal_id
    `);
    return presentPersonal(this.scope.authority, householdId, "savings",
      Object.fromEntries(rows.map((row) => [row.goalId, row.amount.toFixed(2)])));
  }

  async report(from: string, through: string, report: "reports" | "positions" = "reports") {
    this.scope.require(report);
    const { organizationId, householdId } = this.scope.key;
    const kinds = report === "positions" ? ["ASSET", "LIABILITY", "INVESTMENT"] as const : financeKindSchema.options;
    const allowed = kinds.filter((kind) => kind !== "SAVINGS_MOVEMENT"
      && canUseHousehold(this.scope.authority, householdId, financeAreas[kind]));
    if (!allowed.length) return [];
    const rows = await this.scope.tx.$queryRaw<Group[]>(Prisma.sql`
      WITH entries AS (
        SELECT * FROM personal_finance_entry
        WHERE organization_id = ${organizationId}::uuid AND household_id = ${householdId}::uuid
          AND kind IN (${Prisma.join(allowed)}) AND effective_on <= ${through}::date
      ), latest AS (
        SELECT DISTINCT ON (kind, series_id) kind, currency, category, amount, closed FROM entries
        WHERE kind NOT IN ('INCOME', 'EXPENSE') AND (kind <> 'BUDGET' OR effective_on >= ${monthStart(from)}::date)
        ORDER BY kind, series_id, effective_on DESC, created_at DESC, id DESC
      ), report_rows AS (
        SELECT kind, currency, category, CASE WHEN reverses_id IS NULL THEN amount ELSE -amount END AS amount FROM entries
        WHERE kind IN ('INCOME', 'EXPENSE') AND effective_on >= ${from}::date
        UNION ALL
        SELECT kind, currency, category, amount FROM latest WHERE NOT closed
      )
      SELECT kind, currency, category, sum(amount) AS amount FROM report_rows
      GROUP BY kind, currency, category ORDER BY kind, currency, category
    `);
    if (report === "reports") {
      await this.scope.audit("personal.report_generated", "personal_reports", null, undefined, { from, through });
    }
    return rows.map(({ amount, ...row }) => {
      const data = { ...row, amount: amount.toFixed(2) };
      return presentPersonal(this.scope.authority, householdId, report, data);
    });
  }
}
