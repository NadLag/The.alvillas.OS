import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { withTenant, tenantTransactionDefaults, type TenantTransactionRunner } from "@/platform/db/tenant";
import { captureAuthorizationCap, restoreAuthorizationCap } from "@/platform/authz/authorization-cap";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { Money } from "@/platform/money/money";
import type { PaymentProvider } from "@/platform/providers";
import { PaymentMethodRepository } from "../infrastructure/payment-method-repository";
import { FinancialTransferRepository } from "../infrastructure/financial-transfer-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { configuredPaymentMethod, paymentMethodPolicyKey, paymentMethodSchema, PaymentMethodAccessError, PaymentMethodChangedError, PaymentMethodConfigurationError, PaymentMethodSourceError } from "../domain/payment-method";
import { guestDepositReceiptInput, guestDepositReviewInput, guestDepositCashAdmissionInput, guestDepositCashAdmissionReviewInput } from "../domain/guest-deposit-command";
import { importAirbnbSettlementCsvInputSchema, parseAirbnbSettlementCsv } from "../domain/airbnb-settlement";
import { postGuestDepositReceipt, reviewGuestDepositReceipt } from "./guest-deposit-service";
import { admitGuestDepositCash, reviewGuestDepositCashAdmission } from "./guest-deposit-cash-service";
import { importAirbnbSettlementCsv } from "./airbnb-settlement-service";
import { recheckFinanceAuthorization, type FinanceActorContext } from "./finance-access";

type Intent = Parameters<PaymentProvider["record"]>[0];
type Deps = { db?: TenantTransactionRunner; requestId?: string };
type Outcome = { id: string; idempotent: boolean };
type NativeSource = { adapter: "manual" | "bank_transfer" | "cash" | "airbnb_settlement"; methodKey: string; namespace: string; source: string; amount: Money; command: unknown;
  preflight: (runner: TenantTransactionRunner) => Promise<unknown>; post: (runner: TenantTransactionRunner) => Promise<Outcome> };
const acceptedSchema = z.object({ schemaVersion: z.literal(1), key: z.literal(paymentMethodPolicyKey), sourceNamespace: z.string(), source: z.string(), adapter: paymentMethodSchema.shape.adapter,
  methodKey: paymentMethodSchema.shape.key, commandHash: z.string().regex(/^[a-f0-9]{64}$/u), amount: z.object({ amount: z.string(), currency: z.string() }),
  policyId: z.uuid(), policyVersion: z.number().int().positive(), method: paymentMethodSchema }).strict();

function captured(ctx: FinanceActorContext): FinanceActorContext {
  if (ctx.organizationId !== ctx.authContext.organizationId || ctx.actorId !== ctx.authContext.userAccountId) throw new PaymentMethodAccessError();
  return { ...ctx, authContext: restoreAuthorizationCap(captureAuthorizationCap(ctx.authContext)) };
}
function assertIntent(input: Intent, source: NativeSource) {
  const amount = Money.of(guestDepositReviewInput.shape.amount.parse(input.amount), guestDepositReviewInput.shape.currency.parse(input.currency));
  if (z.string().parse(input.source) !== source.source || !amount.equals(source.amount)) throw new PaymentMethodSourceError();
}

/** Native adapters borrow one tenant transaction and delegate every monetary effect to the original producer. */
async function admitNative(ctx: FinanceActorContext, source: NativeSource, deps: Deps) {
  const hash = commandFingerprint({ actorId: ctx.actorId, adapter: source.adapter, methodKey: source.methodKey, sourceNamespace: source.namespace, source: source.source, amount: source.amount.toJSON(), command: source.command });
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const runner: TenantTransactionRunner = { $transaction: async (work, options) => {
      if (options?.isolationLevel || options?.timeout !== undefined && options.timeout !== tenantTransactionDefaults.timeout) throw new PaymentMethodConfigurationError();
      return work(tx);
    } }, repository = new PaymentMethodRepository(tx, ctx.organizationId), finance = new FinanceRepository(tx, ctx.organizationId);
    await recheckFinanceAuthorization(ctx, tx, await finance.clock(), [], new PaymentMethodAccessError());
    await new FinancialTransferRepository(tx, ctx.organizationId).lock("payment-method:" + source.namespace + ":" + source.source);
    const original = await repository.acceptance(source.namespace, source.source);
    if (original) {
      const replay = await source.post(runner), accepted = acceptedSchema.safeParse(original.after);
      if (original.actorId !== ctx.actorId) throw new PaymentMethodAccessError();
      if (!accepted.success || accepted.data.commandHash !== hash || accepted.data.adapter !== source.adapter || accepted.data.methodKey !== source.methodKey || original.resourceId !== replay.id || !replay.idempotent) throw new PaymentMethodSourceError();
      return { paymentId: replay.id };
    }
    await source.preflight(runner);
    const scopes = [{ scopeType: "organization" as const, scopeId: null }], catalog = await repository.catalog({ at: await finance.clock(), currency: source.amount.currency, scopes }),
      method = configuredPaymentMethod(catalog.policy, source.methodKey, source.amount), reference = catalog.currencies.find(row => row.code === source.amount.currency);
    if (method.adapter !== source.adapter || !reference || source.amount.amount.decimalPlaces() > reference.minorUnit) throw new PaymentMethodSourceError();
    const result = await source.post(runner);
    if (result.idempotent) throw new PaymentMethodSourceError();
    // The producer already holds its funding-account locks. Keep the established account-before-policy lock order.
    await new ConfigRuleRepository(tx, ctx.organizationId).lockVersion(paymentMethodPolicyKey, "organization", null);
    if ((await repository.catalog({ at: await finance.clock(), currency: source.amount.currency, scopes })).identity !== catalog.identity) throw new PaymentMethodChangedError();
    const evidence = acceptedSchema.parse({ schemaVersion: 1, key: paymentMethodPolicyKey, sourceNamespace: source.namespace, source: source.source, adapter: source.adapter,
      methodKey: source.methodKey, commandHash: hash, amount: source.amount.toJSON(), policyId: catalog.rule.id, policyVersion: catalog.rule.version, method });
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.payment_method.accepted", resourceType: "financial_transaction", resourceId: result.id,
      after: evidence, reason: "Admitted the original configured payment through its native financial producer", requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: await finance.clock() });
    const checked = await source.post(runner); if (checked.id !== result.id || !checked.idempotent) throw new PaymentMethodSourceError();
    return { paymentId: result.id };
  });
}

class ReceiptPaymentProvider implements PaymentProvider {
  private readonly ctx: FinanceActorContext;
  private readonly command: z.infer<typeof guestDepositReceiptInput>;
  constructor(ctx: FinanceActorContext, raw: unknown, private readonly adapter: "manual" | "bank_transfer", private readonly deps: Deps) {
    this.ctx = captured(ctx); this.command = structuredClone(guestDepositReceiptInput.parse(raw));
  }
  async record(input: Intent) {
    const command = this.command, source: NativeSource = { adapter: this.adapter, methodKey: command.method, namespace: "GUEST_DEPOSIT_COMMAND", source: command.idempotencyKey,
      amount: Money.of(command.amount, command.currency), command, preflight: runner => reviewGuestDepositReceipt(this.ctx, guestDepositReviewInput.strip().parse(command), { db: runner, requestId: this.deps.requestId }),
      post: async runner => { const result = await postGuestDepositReceipt(this.ctx, command, { db: runner, requestId: this.deps.requestId }); return { id: result.id, idempotent: result.idempotent }; } };
    assertIntent(input, source); return admitNative(this.ctx, source, this.deps);
  }
}
export class ManualPaymentProvider extends ReceiptPaymentProvider { constructor(ctx: FinanceActorContext, input: unknown, deps: Deps = {}) { super(ctx, input, "manual", deps); } }
export class BankTransferPaymentProvider extends ReceiptPaymentProvider { constructor(ctx: FinanceActorContext, input: unknown, deps: Deps = {}) { super(ctx, input, "bank_transfer", deps); } }

export class CashPaymentProvider implements PaymentProvider {
  private readonly ctx: FinanceActorContext;
  private readonly command: z.infer<typeof guestDepositCashAdmissionInput>;
  private readonly methodKey: string;
  constructor(ctx: FinanceActorContext, methodKey: string, raw: unknown, private readonly deps: Deps = {}) { this.ctx = captured(ctx); this.methodKey = paymentMethodSchema.shape.key.parse(methodKey); this.command = structuredClone(guestDepositCashAdmissionInput.parse(raw)); }
  async record(input: Intent) {
    const command = this.command, source: NativeSource = { adapter: "cash", methodKey: this.methodKey, namespace: "GUEST_DEPOSIT_COMMAND", source: command.idempotencyKey, amount: Money.of(command.amount, command.currency), command,
      preflight: runner => reviewGuestDepositCashAdmission(this.ctx, guestDepositCashAdmissionReviewInput.strip().parse(command), { db: runner, requestId: this.deps.requestId }),
      post: async runner => { const result = await admitGuestDepositCash(this.ctx, command, { db: runner, requestId: this.deps.requestId }); return { id: result.id, idempotent: result.idempotent }; } };
    assertIntent(input, source); return admitNative(this.ctx, source, this.deps);
  }
}

export class AirbnbSettlementPaymentProvider implements PaymentProvider {
  private readonly ctx: FinanceActorContext;
  private readonly command: z.infer<typeof importAirbnbSettlementCsvInputSchema>;
  private readonly methodKey: string;
  constructor(ctx: FinanceActorContext, methodKey: string, raw: unknown, private readonly deps: Deps = {}) { this.ctx = captured(ctx); this.methodKey = paymentMethodSchema.shape.key.parse(methodKey); this.command = structuredClone(importAirbnbSettlementCsvInputSchema.parse(raw)); }
  async record(input: Intent) {
    const rows = parseAirbnbSettlementCsv(this.command.csv); if (rows.length !== 1) throw new PaymentMethodSourceError(); const row = rows[0], command = this.command,
      source: NativeSource = { adapter: "airbnb_settlement", methodKey: this.methodKey, namespace: "AIRBNB_SOURCE_TRANSACTION", source: row.sourceTransactionId, amount: Money.of(row.actualReceipt, row.currency), command,
        preflight: runner => withTenant(runner, this.ctx.organizationId, async tx => { await recheckFinanceAuthorization(this.ctx, tx, await new FinanceRepository(tx, this.ctx.organizationId).clock(), [
          { action: "view", resource: { type: "reservation", organizationId: this.ctx.organizationId } }, ...(["view", "create", "reconcile"] as const).map(action => ({ action, resource: { type: "financial_transaction", organizationId: this.ctx.organizationId, dataClass: "financial" as const } }))
        ], new PaymentMethodAccessError()); }),
        post: async runner => { const result = await importAirbnbSettlementCsv(this.ctx, command, { db: runner, requestId: this.deps.requestId ?? crypto.randomUUID() }); if (result.imported.length !== 1) throw new PaymentMethodSourceError(); return { id: result.imported[0].receiptTransactionId, idempotent: result.imported[0].idempotent }; } };
    assertIntent(input, source); return admitNative(this.ctx, source, this.deps);
  }
}
