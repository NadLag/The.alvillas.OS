import { Prisma } from "@prisma/client";
import { calendarDateAt } from "@/i18n/format";
import { authorizeOrganizationSource } from "@/platform/authz/organization-authority";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { advisoryTransactionLock } from "@/platform/db/advisory-lock-repository";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { businessPersonalTransferPolicyKey, businessPersonalTransferPolicySchema } from "@/platform/ledger/business-personal-transfer-policy";
import { Money } from "@/platform/money/money";
import { presentPersonal } from "../domain/household-access";
import { dayValue } from "../domain/personal-finance";
import { transferConfirmationSchema, transferRequestSchema } from "../domain/personal-transfer";
import { PersonalAccessDenied, PersonalConflict, type HouseholdScope } from "./household-repository";

export class PersonalTransferRepository {
  constructor(private readonly scope: HouseholdScope) {}

  private get identity() {
    return this.scope.identity;
  }

  private lookup(id: string) {
    return this.scope.tx.businessPersonalTransfer.findUnique({
      where: { organizationId_householdId_id: { ...this.scope.key, id } },
      include: { resolution: true }
    });
  }

  async canConfirm() {
    const { organizationId, accountId } = this.identity;
    const current = await authContextForAccountInTransaction(this.scope.tx, organizationId, accountId);
    const now = new Date();
    const resource = { type: "financial_transaction", organizationId, dataClass: "financial" } as const;
    return authorizeOrganizationSource(current, "view", resource, now) &&
      authorizeOrganizationSource(current, "approve", resource, now);
  }

  async request(raw: unknown) {
    this.scope.require("transfers", "edit");
    const value = transferRequestSchema.parse(raw);
    const amount = Money.of(value.amount, value.currency).toJSON().amount;
    const effectiveOn = dayValue(value.effectiveOn);
    const existing = await this.scope.tx.businessPersonalTransfer.findUnique({
      where: { organizationId_householdId_commandId: { ...this.scope.key, commandId: value.id } }
    });
    if (existing) {
      if (existing.requestedBy !== this.identity.accountId || existing.direction !== value.direction
        || existing.amount.toFixed(2) !== amount || existing.currency !== value.currency
        || existing.category !== value.category || existing.effectiveOn.getTime() !== effectiveOn.getTime()) throw new PersonalConflict();
      return;
    }
    const { id: commandId, ...request } = value;
    const { id } = await this.scope.tx.businessPersonalTransfer.create({
      data: { ...this.scope.key, ...request, commandId, amount, effectiveOn, requestedBy: this.identity.accountId },
      select: { id: true }
    });
    await this.scope.audit("personal.transfer_requested", "personal_transfers", id);
  }

  async confirm(raw: unknown) {
    this.scope.require("transfers", "edit");
    const { id, businessTransactionId } = transferConfirmationSchema.parse(raw);
    const { organizationId, accountId } = this.identity;
    const { tx } = this.scope;
    // Share the original journal's lock with the database reversal guard.
    await advisoryTransactionLock(tx, `${organizationId}:journal-reversal:${businessTransactionId}`);
    if (!await this.canConfirm()) throw new PersonalAccessDenied();
    const request = await this.lookup(id);
    if (!request) throw new PersonalConflict();
    if (request.resolution) {
      if (request.resolution.kind === "CONFIRMED" && request.resolution.actorId === accountId
        && request.resolution.businessTransactionId === businessTransactionId) return;
      throw new PersonalConflict();
    }
    const rule = await new ConfigRuleRepository(tx, organizationId).resolve({
      key: businessPersonalTransferPolicyKey, scopes: [{ scopeType: "organization", scopeId: null }], asOf: new Date()
    });
    const policy = businessPersonalTransferPolicySchema.safeParse(rule?.parsedValue);
    const category = policy.success ? policy.data.categories.find((entry) => entry.category === request.category) : undefined;
    if (!rule?.createdBy || !category) throw new PersonalConflict();

    const source = await tx.financialTransaction.findUnique({
      where: { organizationId_id: { organizationId, id: businessTransactionId } },
      select: {
        sealed: true, occurredAt: true, reversesTransactionId: true,
        reversedByTransactions: { where: { organizationId }, take: 1, select: { id: true } },
        postings: { where: { organizationId }, take: 3,
          select: { amount: true, currency: true, side: true,
            ledgerAccount: { select: { organizationId: true, accountType: true, code: true } } } }
      }
    });
    const cashSide = request.direction === "TO_PERSONAL" ? "CREDIT" : "DEBIT";
    const cash = source?.postings.find((line) => line.ledgerAccount.code === category.cash_account_code
      && line.ledgerAccount.accountType === "ASSET_LOCATION" && line.side === cashSide);
    const opposite = source?.postings.find((line) => line.ledgerAccount.code === category.company_account_code
      && line.ledgerAccount.accountType === "ALVILLAS_OWN" && line.side !== cashSide);
    if (!source?.sealed || source.reversedByTransactions.length
      || source.postings.length !== 2 || !cash || !opposite
      || source.postings.some((line) => line.ledgerAccount.organizationId !== organizationId
        || !line.amount.eq(request.amount) || line.currency !== request.currency)
      || calendarDateAt(source.occurredAt, "Africa/Casablanca") !== request.effectiveOn.toISOString().slice(0, 10)) {
      throw new PersonalConflict();
    }
    let reversesTransferId: string | undefined;
    if (source.reversesTransactionId) {
      const original = await tx.personalTransferResolution.findUnique({
        where: {
          organizationId_businessTransactionId: { organizationId, businessTransactionId: source.reversesTransactionId },
          householdId: this.scope.id, kind: "CONFIRMED"
        },
        select: {
          transferId: true,
          transfer: { select: { direction: true, category: true, amount: true, currency: true } }
        }
      });
      if (!original || original.transfer.direction === request.direction || original.transfer.category !== request.category
        || !original.transfer.amount.eq(request.amount) || original.transfer.currency !== request.currency) {
        throw new PersonalConflict();
      }
      reversesTransferId = original.transferId;
    }
    if (!await this.canConfirm()) throw new PersonalAccessDenied();
    try {
      await tx.personalTransferResolution.create({ data: {
        ...this.scope.key, transferId: id, kind: "CONFIRMED", businessTransactionId, policyRuleId: rule.id,
        actorId: accountId, reversesTransferId
      } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new PersonalConflict();
      throw error;
    }
    await this.scope.audit("personal.transfer_confirmed", "personal_transfers", id, undefined, {
      policyRuleId: rule.id, reversesTransferId
    });
  }

  async cancel(id: string) {
    this.scope.require("transfers", "edit");
    const request = await this.lookup(id);
    const actorId = this.identity.accountId;
    if (!request || request.requestedBy !== actorId) throw new PersonalAccessDenied();
    if (request.resolution?.kind === "CANCELLED") return;
    if (request.resolution) throw new PersonalConflict();
    await this.scope.tx.personalTransferResolution.create({
      data: { ...this.scope.key, transferId: id, kind: "CANCELLED", actorId }
    });
    await this.scope.audit("personal.transfer_cancelled", "personal_transfers", id);
  }

  async list(after?: string) {
    this.scope.require("transfers");
    const rows = await this.scope.tx.businessPersonalTransfer.findMany({
      where: { ...this.scope.key, ...(after ? { id: { lt: after } } : {}) },
      orderBy: { id: "desc" }, take: 51,
      select: { id: true, amount: true, currency: true, direction: true, category: true,
        effectiveOn: true, requestedBy: true, resolution: { select: { kind: true, reversesTransferId: true } } }
    });
    const items = rows.slice(0, 50).map(({ requestedBy, resolution, ...row }) =>
      presentPersonal(this.scope.authority, this.scope.id, "transfers", {
        ...row, amount: row.amount.toFixed(2), status: resolution?.kind ?? "PENDING",
        isReversal: Boolean(resolution?.reversesTransferId), requestedByMe: requestedBy === this.identity.accountId
      }));
    return { items, next: rows.length > 50 ? rows[49].id : undefined };
  }

  async settledTotals(from: string, through: string) {
    this.scope.require("transfers");
    const { organizationId, householdId } = this.scope.key;
    const rows = await this.scope.tx.$queryRaw<{ currency: string; amount: Prisma.Decimal }[]>(Prisma.sql`
      SELECT request.currency, SUM(CASE WHEN request.direction = 'TO_PERSONAL' THEN request.amount ELSE -request.amount END) AS amount
      FROM business_personal_transfer request
      JOIN personal_transfer_resolution resolution
        ON (resolution.organization_id, resolution.household_id, resolution.transfer_id) =
          (request.organization_id, request.household_id, request.id)
      WHERE request.organization_id = ${organizationId}::uuid AND request.household_id = ${householdId}::uuid
        AND request.effective_on BETWEEN ${from}::date AND ${through}::date AND resolution.kind = 'CONFIRMED'
      GROUP BY request.currency ORDER BY request.currency
    `);
    return rows.map((row) => presentPersonal(this.scope.authority, this.scope.id, "transfers",
      { currency: row.currency, amount: row.amount.toFixed(2) }));
  }
}
