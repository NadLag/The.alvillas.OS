import { randomUUID } from "node:crypto";
import { z } from "zod";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { assertAccountAuthorization, recheckAccountAuthorization, type CurrentAuthorityCheck } from "@/platform/authz/current-authority";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { supplierPriceListKey, supplierPriceListPolicySchema } from "@/platform/config/supplier-price-list-policy";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { Money } from "@/platform/money/money";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { SupplierInvoiceRepository } from "../infrastructure/supplier-invoice-repository";
import { SupplierRepository } from "../infrastructure/supplier-repository";
import type { FinanceActorContext } from "./finance-access";
import { SupplierAccessError, SupplierConflictError } from "./supplier-service";

const commandSchema = z.strictObject({ supplierId: z.uuid(), expectedVersion: z.number().int().nonnegative(),
  effectiveOn: z.iso.date(), reason: z.string().trim().min(6).max(1000), priceList: supplierPriceListPolicySchema });
type Dependencies = { db?: TenantTransactionRunner; requestId?: string };

function supplierPriceChecks(organizationId: string, supplierId: string, edit: boolean): CurrentAuthorityCheck[] {
  const supplier = { type: "supplier", id: supplierId, organizationId, dataClass: "personal" } as const;
  return [
    { action: "view", organizationOnly: true, resource: supplier },
    { action: "view", organizationOnly: true, resource: { type: "supplier_invoice", organizationId, dataClass: "financial" } },
    ...(edit ? [
      { action: "edit", organizationOnly: true, resource: supplier },
      { action: "configure", organizationOnly: true, resource: { type: "config_rule", id: supplierPriceListKey(supplierId),
        ruleKey: supplierPriceListKey(supplierId), organizationId, dataClass: "financial" } }
    ] as const : [])
  ];
}

export async function readSupplierPriceLists(actor: FinanceActorContext, supplierId: string, cursor?: string, deps: Dependencies = {}) {
  const id = z.uuid().parse(supplierId).toLowerCase(), after = z.uuid().optional().parse(cursor);
  return withTenant(deps.db ?? prisma, actor.organizationId, async tx => {
    const now = await new FinanceRepository(tx, actor.organizationId).clock();
    const current = await authContextForAccountInTransaction(tx, actor.organizationId, actor.actorId);
    const can = (edit: boolean) => {
      try { assertAccountAuthorization(actor, current, now, supplierPriceChecks(actor.organizationId, id, edit), new SupplierAccessError()); return true; }
      catch (error) { if (error instanceof SupplierAccessError) return false; throw error; }
    };
    if (!can(false)) return null;
    const supplier = await new SupplierRepository(tx, actor.organizationId).find(id);
    if (!supplier) throw new SupplierAccessError();
    const rules = new ConfigRuleRepository(tx, actor.organizationId), key = supplierPriceListKey(id);
    const [version, active, rows] = await Promise.all([
      rules.latestVersion(key, "organization", null),
      rules.resolve({ key, scopes: [{ scopeType: "organization", scopeId: null }], asOf: now }),
      rules.list({ key, scopeType: "organization", scopeId: null, take: 26, after })
    ]);
    return { version, active: active ? supplierPriceListPolicySchema.parse(active.parsedValue) : null,
      canEdit: !supplier.archivedAt && can(true), activeVersion: active?.version,
      history: rows.slice(0, 25).map(row => ({ id: row.id, version: row.version, reason: row.reason, from: row.effectiveFrom,
        data: supplierPriceListPolicySchema.parse(row.value) })), next: rows.length > 25 ? rows[24].id : undefined };
  }, { isolationLevel: "RepeatableRead" });
}

export async function saveSupplierPriceList(actor: FinanceActorContext, raw: unknown, deps: Dependencies = {}) {
  const command = commandSchema.parse(raw);
  const id = command.supplierId.toLowerCase();
  return withTenant(deps.db ?? prisma, actor.organizationId, async tx => {
    const suppliers = new SupplierRepository(tx, actor.organizationId);
    await suppliers.lock(id);
    const supplier = await suppliers.find(id);
    if (!supplier || supplier.archivedAt) throw new SupplierAccessError();
    const finance = new FinanceRepository(tx, actor.organizationId), now = await finance.clock();
    const checks = supplierPriceChecks(actor.organizationId, id, true);
    await recheckAccountAuthorization(actor, tx, now, checks, new SupplierAccessError());
    const key = supplierPriceListKey(id), rules = new ConfigRuleRepository(tx, actor.organizationId);
    if (command.expectedVersion !== await rules.latestVersion(key, "organization", null)) throw new SupplierConflictError();
    const currency = await new SupplierInvoiceRepository(tx, actor.organizationId).currency(command.priceList.currency);
    if (!currency || currency.minorUnit > 2) throw new SupplierConflictError();
    const items = command.priceList.items.map(item => {
      const money = Money.of(item.amount, command.priceList.currency);
      if (money.amount.decimalPlaces() > currency.minorUnit) throw new SupplierConflictError();
      return { ...item, amount: money.toJSON().amount };
    });
    const saved = await rules.createVersion({ key, scopeType: "organization", value: { ...command.priceList, items },
      effectiveFrom: new Date(command.effectiveOn + "T00:00:00Z"), createdBy: actor.actorId, reason: command.reason });
    await writeAuditEvent(tx, { organizationId: actor.organizationId, actorId: actor.actorId, action: "config.supplier_price_list_recorded",
      resourceType: "config_rule", resourceId: saved.id, after: { key, supplierId: id, version: saved.version },
      requestId: deps.requestId ?? randomUUID(), occurredAt: now });
    await recheckAccountAuthorization(actor, tx, await finance.clock(), checks, new SupplierAccessError());
    return { version: saved.version };
  });
}
