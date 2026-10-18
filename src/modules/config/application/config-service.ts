import { headers } from "next/headers";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  ConfigRuleRepository,
  type ConfigPropertyScopeOption,
  type ConfigRuleLifecycle,
  type ConfigRuleRecord,
  type ResolvedConfigRule
} from "@/platform/config/config-rule-repository";
import {
  configRuleSchemas,
  parseConfigRuleValue,
  schemaForConfigKey
} from "@/platform/config/rule-registry";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { authorize, authorizeCollection } from "@/platform/authz/authorize";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import type { ConfigActorContext } from "@/modules/config/application/config-access";
import { NotificationRepository } from "@/platform/notifications/notification-repository";
import { notificationRoutingSchema } from "@/platform/notifications/notification-routing";

export class ConfigAuthorizationError extends Error {
  constructor(message = "Configuration action is not authorized") {
    super(message);
    this.name = "ConfigAuthorizationError";
  }
}

export class ConfigNotFoundError extends Error {
  constructor(message = "Configuration rule was not found") {
    super(message);
    this.name = "ConfigNotFoundError";
  }
}

export class ConfigValidationError extends Error {
  constructor(message = "Configuration rule is invalid") {
    super(message);
    this.name = "ConfigValidationError";
  }
}

type ConfigServiceDeps = {
  db?: TenantTransactionRunner;
  requestId?: string;
  ipAddress?: string | null;
};

type AuditMeta = {
  requestId: string;
  ipAddress: string | null;
};

const uuidSchema = z.string().uuid();
const effectiveDateSchema = z.coerce.date().refine((date) => !Number.isNaN(date.getTime()));

export const configRuleInputSchema = z.object({
  key: z.string().trim().min(1).max(160),
  customFeatureFlagKey: z.string().trim().max(120).optional(),
  scopeType: z.enum(["organization", "property"]),
  scopeId: z.string().trim().optional(),
  lifecycle: z.enum(["DRAFT", "ACTIVE"]).default("ACTIVE"),
  valueJson: z.string().trim().min(2),
  effectiveFrom: effectiveDateSchema,
  effectiveTo: effectiveDateSchema.optional(),
  reason: z.string().trim().min(6).max(500)
});

export const configRuleLifecycleActionSchema = z.object({
  ruleId: uuidSchema,
  effectiveFrom: effectiveDateSchema,
  reason: z.string().trim().min(6).max(500)
});

export type ConfigRuleInput = z.infer<typeof configRuleInputSchema>;
export type ConfigRuleLifecycleActionInput = z.infer<typeof configRuleLifecycleActionSchema>;

export type ConfigRuleView = {
  id: string;
  key: string;
  scopeType: string;
  scopeId: string | null;
  scopeLabel: string;
  version: number;
  lifecycle: ConfigRuleLifecycle;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  createdAt: Date | null;
  reason: string;
  valueJson: string;
  changedPaths: string[];
};

export type ConfigPreview = {
  key: string;
  asOf: Date;
  resolved: ConfigRuleView | null;
};

export type ConfigAdminModel = {
  rules: ConfigRuleView[];
  properties: ConfigPropertyScopeOption[];
  preview: ConfigPreview | null;
  catalogKeys: string[];
};

function db(deps: ConfigServiceDeps): TenantTransactionRunner {
  return deps.db ?? prisma;
}

function assertCollectionAllowed(ctx: ConfigActorContext, action: "view" | "create" | "configure"): void {
  if (!authorizeCollection(ctx.authContext, action, "config_rule")) {
    throw new ConfigAuthorizationError();
  }
}

function assertRuleAllowed(
  ctx: ConfigActorContext,
  action: "view" | "create" | "configure",
  rule?: Pick<ConfigRuleRecord, "id" | "scopeType" | "scopeId"> & { key?: string }
): void {
  const allowed = rule
    ? authorize(ctx.authContext, action, {
        type: "config_rule",
        organizationId: ctx.organizationId,
        id: rule.id,
        propertyId: rule.scopeType === "property" ? rule.scopeId : undefined
      })
    : authorizeCollection(ctx.authContext, action, "config_rule");

  if (!allowed || (rule && !hasRuleFinancialAccess(ctx, rule.key, rule.scopeType, rule.scopeId))) {
    throw new ConfigAuthorizationError();
  }
}

function hasRuleFinancialAccess(
  ctx: ConfigActorContext,
  key: string | undefined,
  scopeType: string,
  scopeId: string | null
): boolean {
  // Assignment compensation is changed only through the immutable Team workflow.
  if (scopeType === "role_assignment") return false;
  if (key === "staff.compensation") return authorize(ctx.authContext, "view", {
    type: "staff_compensation", organizationId: ctx.organizationId,
    propertyId: scopeType === "property" ? scopeId : undefined
  });
  return key !== "services.pricing" || authorize(ctx.authContext, "view", {
    type: "financial_transaction",
    organizationId: ctx.organizationId,
    propertyId: scopeType === "property" ? scopeId : undefined
  });
}

async function auditMeta(deps: ConfigServiceDeps): Promise<AuditMeta> {
  if (deps.requestId) {
    return {
      requestId: deps.requestId,
      ipAddress: deps.ipAddress ?? null
    };
  }

  const requestHeaders = await headers();

  return {
    requestId: requestHeaders.get("x-request-id") ?? crypto.randomUUID(),
    ipAddress: requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null
  };
}

function parseJsonObject(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    const validationError = new ConfigValidationError("Config rule value must be valid JSON");
    validationError.cause = error;
    throw validationError;
  }
}

function assertValidRuleValue(key: string, value: unknown): void {
  try {
    parseConfigRuleValue(key, value);
  } catch (error) {
    const validationError = new ConfigValidationError("Config rule value failed schema validation");
    validationError.cause = error;
    throw validationError;
  }
}

function normalizeKey(input: ConfigRuleInput): string {
  if (input.key === "feature_flag") {
    const suffix = input.customFeatureFlagKey?.trim();
    if (!suffix) {
      throw new ConfigValidationError("Feature flag key is required");
    }

    return `feature_flag.${suffix}`;
  }

  return input.key;
}

function normalizeScope(input: ConfigRuleInput): { scopeType: string; scopeId: string | null } {
  if (input.scopeType === "organization") {
    return { scopeType: "organization", scopeId: null };
  }

  if (!input.scopeId || !uuidSchema.safeParse(input.scopeId).success) {
    throw new ConfigValidationError("Property scope is required");
  }

  return { scopeType: "property", scopeId: input.scopeId };
}

function jsonString(value: Prisma.JsonValue): string {
  return JSON.stringify(value, null, 2);
}

function valueRecord(value: Prisma.JsonValue): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function changedPaths(current: Prisma.JsonValue, previous: Prisma.JsonValue | null): string[] {
  if (!previous) {
    return [];
  }

  const currentRecord = valueRecord(current);
  const previousRecord = valueRecord(previous);
  const keys = [...new Set([...Object.keys(currentRecord), ...Object.keys(previousRecord)])].sort();

  return keys.filter(
    (key) => JSON.stringify(currentRecord[key]) !== JSON.stringify(previousRecord[key])
  );
}

function scopeLabel(
  rule: Pick<ConfigRuleRecord, "scopeType" | "scopeId">,
  properties: readonly ConfigPropertyScopeOption[]
): string {
  if (rule.scopeType === "organization") {
    return "organization";
  }

  const property = properties.find((option) => option.id === rule.scopeId);
  return property ? `${property.name} - ${property.city}` : `${rule.scopeType}:${rule.scopeId ?? ""}`;
}

function toView(
  rule: ConfigRuleRecord,
  properties: readonly ConfigPropertyScopeOption[],
  previous: ConfigRuleRecord | null
): ConfigRuleView {
  return {
    id: rule.id,
    key: rule.key,
    scopeType: rule.scopeType,
    scopeId: rule.scopeId,
    scopeLabel: scopeLabel(rule, properties),
    version: rule.version,
    lifecycle: rule.lifecycle,
    effectiveFrom: rule.effectiveFrom,
    effectiveTo: rule.effectiveTo,
    createdAt: rule.createdAt ?? null,
    reason: rule.reason,
    valueJson: jsonString(rule.value),
    changedPaths: changedPaths(rule.value, previous?.value ?? null)
  };
}

function previousRuleFor(rule: ConfigRuleRecord, rules: readonly ConfigRuleRecord[]): ConfigRuleRecord | null {
  return (
    rules
      .filter(
        (candidate) =>
          candidate.key === rule.key &&
          candidate.scopeType === rule.scopeType &&
          candidate.scopeId === rule.scopeId &&
          candidate.version < rule.version
      )
      .sort((left, right) => right.version - left.version)[0] ?? null
  );
}

function resolvedToRecord(rule: ResolvedConfigRule): ConfigRuleRecord {
  return {
    id: rule.id,
    key: rule.key,
    scopeType: rule.scopeType,
    scopeId: rule.scopeId,
    value: rule.value,
    effectiveFrom: rule.effectiveFrom,
    effectiveTo: rule.effectiveTo,
    version: rule.version,
    lifecycle: rule.lifecycle,
    createdBy: rule.createdBy,
    reason: rule.reason,
    createdAt: rule.createdAt
  };
}

export function parseConfigRuleInput(input: unknown) {
  return configRuleInputSchema.safeParse(input);
}

export function parseConfigLifecycleActionInput(input: unknown) {
  return configRuleLifecycleActionSchema.safeParse(input);
}

export async function getConfigAdminModel(
  ctx: ConfigActorContext,
  input: {
    previewKey?: string;
    previewScopeType?: string;
    previewScopeId?: string | null;
    previewAsOf?: Date;
  } = {},
  deps: ConfigServiceDeps = {}
): Promise<ConfigAdminModel> {
  assertCollectionAllowed(ctx, "view");

  return withTenant(db(deps), ctx.organizationId, async (tx) => {
    const repository = new ConfigRuleRepository(tx, ctx.organizationId);
    const [rules, properties] = await Promise.all([
      repository.list({ take: 200, excludeScopeTypes: ["role_assignment"] }),
      repository.listPropertyScopeOptions()
    ]);
    const visibleRules = rules.filter((rule) =>
      authorize(ctx.authContext, "view", {
        type: "config_rule",
        organizationId: ctx.organizationId,
        id: rule.id,
        propertyId: rule.scopeType === "property" ? rule.scopeId : undefined
      }) && hasRuleFinancialAccess(ctx, rule.key, rule.scopeType, rule.scopeId)
    );
    if (input.previewKey) {
      const scopeType = input.previewScopeType === "property" ? "property" : "organization";
      const scopeId = scopeType === "property" ? input.previewScopeId ?? null : null;
      if (scopeType === "property" && !uuidSchema.safeParse(scopeId).success) {
        throw new ConfigValidationError();
      }
      assertRuleAllowed(ctx, "view", { id: input.previewKey, key: input.previewKey, scopeType, scopeId });
    }
    const preview =
      input.previewKey && schemaForConfigKey(input.previewKey)
        ? await previewRule(repository, visibleRules, properties, input)
        : null;

    return {
      rules: visibleRules.map((rule) => toView(rule, properties, previousRuleFor(rule, visibleRules))),
      properties,
      preview,
      catalogKeys: Object.keys(configRuleSchemas).sort()
    };
  });
}

async function previewRule(
  repository: ConfigRuleRepository,
  rules: readonly ConfigRuleRecord[],
  properties: readonly ConfigPropertyScopeOption[],
  input: {
    previewKey?: string;
    previewScopeType?: string;
    previewScopeId?: string | null;
    previewAsOf?: Date;
  }
): Promise<ConfigPreview> {
  const key = input.previewKey ?? "";
  const scopeType = input.previewScopeType === "property" ? "property" : "organization";
  const scopeId = scopeType === "property" ? input.previewScopeId ?? null : null;
  const asOf = input.previewAsOf ?? new Date();
  const resolved = await repository.resolve({
    key,
    asOf,
    scopes:
      scopeType === "property" && scopeId
        ? [
            { scopeType: "property", scopeId },
            { scopeType: "organization", scopeId: null }
          ]
        : [{ scopeType: "organization", scopeId: null }]
  });

  return {
    key,
    asOf,
    resolved: resolved
      ? toView(resolvedToRecord(resolved), properties, previousRuleFor(resolved, rules))
      : null
  };
}

export async function createConfigRuleVersion(
  ctx: ConfigActorContext,
  input: ConfigRuleInput,
  deps: ConfigServiceDeps = {}
): Promise<ConfigRuleRecord> {
  assertCollectionAllowed(ctx, input.lifecycle === "DRAFT" ? "create" : "configure");
  const meta = await auditMeta(deps);
  const key = normalizeKey(input);
  const scope = normalizeScope(input);
  const rawValue = parseJsonObject(input.valueJson);
  assertValidRuleValue(key, rawValue);

  return withTenant(db(deps), ctx.organizationId, async (tx) => {
    const repository = new ConfigRuleRepository(tx, ctx.organizationId);

    assertRuleAllowed(ctx, input.lifecycle === "DRAFT" ? "create" : "configure", {
      id: key,
      key,
      scopeType: scope.scopeType,
      scopeId: scope.scopeId
    });

    if (key.startsWith("notification.routing.")) await new NotificationRepository(tx, ctx.organizationId)
      .validateRoutingReferences(notificationRoutingSchema.parse(rawValue), scope.scopeId);

    const created = await repository.createVersion({
      key,
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      value: rawValue,
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo,
      lifecycle: input.lifecycle,
      createdBy: ctx.actorId,
      reason: input.reason
    });

    await writeAuditEvent(tx, {
      organizationId: ctx.organizationId,
      actorId: ctx.actorId,
      action: "config_rule.version.created",
      resourceType: "config_rule",
      resourceId: created.id,
      ipAddress: meta.ipAddress,
      propertyScopeId: created.scopeType === "property" ? created.scopeId : null,
      after: created,
      reason: input.reason,
      requestId: meta.requestId,
      occurredAt: new Date()
    });

    return created;
  });
}

export async function activateConfigRuleVersion(
  ctx: ConfigActorContext,
  input: ConfigRuleLifecycleActionInput,
  deps: ConfigServiceDeps = {}
): Promise<ConfigRuleRecord> {
  assertCollectionAllowed(ctx, "configure");
  const meta = await auditMeta(deps);

  return withTenant(db(deps), ctx.organizationId, async (tx) => {
    const repository = new ConfigRuleRepository(tx, ctx.organizationId);
    const source = await repository.findById(input.ruleId);

    if (!source) {
      throw new ConfigNotFoundError();
    }

    assertRuleAllowed(ctx, "configure", source);
    if (source.key.startsWith("notification.routing.")) await new NotificationRepository(tx, ctx.organizationId)
      .validateRoutingReferences(notificationRoutingSchema.parse(source.value), source.scopeId);
    const created = await repository.activateVersion({
      ruleId: input.ruleId,
      effectiveFrom: input.effectiveFrom,
      createdBy: ctx.actorId,
      reason: input.reason
    });

    await writeAuditEvent(tx, {
      organizationId: ctx.organizationId,
      actorId: ctx.actorId,
      action: "config_rule.version.activated",
      resourceType: "config_rule",
      resourceId: created.id,
      ipAddress: meta.ipAddress,
      propertyScopeId: created.scopeType === "property" ? created.scopeId : null,
      before: source,
      after: created,
      reason: input.reason,
      requestId: meta.requestId,
      occurredAt: new Date()
    });

    return created;
  });
}

export async function retireConfigRuleVersion(
  ctx: ConfigActorContext,
  input: ConfigRuleLifecycleActionInput,
  deps: ConfigServiceDeps = {}
): Promise<ConfigRuleRecord> {
  assertCollectionAllowed(ctx, "configure");
  const meta = await auditMeta(deps);

  return withTenant(db(deps), ctx.organizationId, async (tx) => {
    const repository = new ConfigRuleRepository(tx, ctx.organizationId);
    const source = await repository.findById(input.ruleId);

    if (!source) {
      throw new ConfigNotFoundError();
    }

    assertRuleAllowed(ctx, "configure", source);
    const created = await repository.retireVersion({
      ruleId: input.ruleId,
      effectiveFrom: input.effectiveFrom,
      createdBy: ctx.actorId,
      reason: input.reason
    });

    await writeAuditEvent(tx, {
      organizationId: ctx.organizationId,
      actorId: ctx.actorId,
      action: "config_rule.version.retired",
      resourceType: "config_rule",
      resourceId: created.id,
      ipAddress: meta.ipAddress,
      propertyScopeId: created.scopeType === "property" ? created.scopeId : null,
      before: source,
      after: created,
      reason: input.reason,
      requestId: meta.requestId,
      occurredAt: new Date()
    });

    return created;
  });
}
