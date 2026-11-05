import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { captureAuthorizationCap, restoreAuthorizationCap } from "@/platform/authz/authorization-cap";
import { financialRuleSourceChecks } from "@/platform/config/financial-rule-authority";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { PaymentMethodRepository } from "../infrastructure/payment-method-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { paymentMethodPolicyKey, paymentMethodCatalogInputSchema, paymentMethodCatalogSchema, PaymentMethodAccessError, PaymentMethodChangedError } from "../domain/payment-method";
import { recheckFinanceAuthorization, type FinanceActorContext } from "./finance-access";

type Deps = { db?: TenantTransactionRunner; requestId?: string };

export async function readPaymentMethodCatalog(context: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  if (context.organizationId !== context.authContext.organizationId || context.actorId !== context.authContext.userAccountId) throw new PaymentMethodAccessError();
  const ctx = { ...context, authContext: restoreAuthorizationCap(captureAuthorizationCap(context.authContext)) }, input = paymentMethodCatalogInputSchema.parse(raw),
    checks = [{ action: "view" as const, resource: { type: "config_rule", organizationId: ctx.organizationId, dataClass: "financial" as const, ruleKey: paymentMethodPolicyKey } }, ...financialRuleSourceChecks(ctx.organizationId, paymentMethodPolicyKey)];
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const finance = new FinanceRepository(tx, ctx.organizationId), now = await finance.clock(), repository = new PaymentMethodRepository(tx, ctx.organizationId), scopes = [{ scopeType: "organization" as const, scopeId: null }];
    await recheckFinanceAuthorization(ctx, tx, now, checks, new PaymentMethodAccessError());
    const catalog = await repository.catalog({ ...input, scopes, at: now });
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.payment_methods.read", resourceType: "config_rule", resourceId: catalog.rule.id,
      after: { key: paymentMethodPolicyKey, policyId: catalog.rule.id, policyVersion: catalog.rule.version, currency: catalog.currency, methodKeys: catalog.methods.map(method => method.key) },
      reason: "Read currently authorized configured native payment methods", requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: now });
    if ((await repository.catalog({ ...input, scopes, at: await finance.clock() })).identity !== catalog.identity) throw new PaymentMethodChangedError();
    await recheckFinanceAuthorization(ctx, tx, await finance.clock(), checks, new PaymentMethodAccessError());
    return paymentMethodCatalogSchema.parse({ policy: { id: catalog.rule.id, version: catalog.rule.version }, currency: catalog.currency, currencies: catalog.currencies, methods: catalog.methods });
  });
}
