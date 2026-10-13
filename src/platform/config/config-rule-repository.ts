import type { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import { parseConfigRuleValue } from "@/platform/config/rule-registry";

export type ConfigScopeType =
  | "organization"
  | "city"
  | "owner"
  | "property"
  | "agreement"
  | "booking_source_property";

export type ConfigScopeCandidate = {
  scopeType: string;
  scopeId: string | null;
};

export type ConfigRuleLifecycle = "DRAFT" | "ACTIVE" | "RETIRED";

export type ConfigRuleRecord = {
  id: string;
  key: string;
  scopeType: string;
  scopeId: string | null;
  value: Prisma.JsonValue;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  version: number;
  lifecycle: ConfigRuleLifecycle;
  createdBy: string | null;
  reason: string;
  createdAt?: Date;
};

export type ResolvedConfigRule = ConfigRuleRecord & {
  parsedValue: unknown;
};

export type ReservationConfigSnapshotRecord = {
  id: string;
  key: string;
  configRuleId: string | null;
  version: number;
  snapshotValue: Prisma.JsonValue;
  resolvedAt: Date;
};

export type ConfigPropertyScopeOption = {
  id: string;
  name: string;
  city: string;
};

const scopeSpecificity: Record<ConfigScopeType, number> = {
  organization: 1,
  city: 2,
  owner: 3,
  property: 4,
  agreement: 5,
  booking_source_property: 6
};

function specificity(scopeType: string): number {
  return scopeSpecificity[scopeType as ConfigScopeType] ?? 0;
}

function normalizedScopes(scopes: readonly ConfigScopeCandidate[]): ConfigScopeCandidate[] {
  const seen = new Set<string>();
  const output: ConfigScopeCandidate[] = [];

  for (const scope of scopes) {
    const key = `${scope.scopeType}:${scope.scopeId ?? "null"}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    output.push(scope);
  }

  return output;
}

function scopeFilter(scope: ConfigScopeCandidate): Prisma.ConfigRuleWhereInput {
  return scope.scopeId
    ? {
        scopeType: scope.scopeType,
        scopeId: scope.scopeId
      }
    : {
        scopeType: scope.scopeType,
        scopeId: null
      };
}

function inputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function inputJsonObject(value: Record<string, unknown>): Prisma.InputJsonObject {
  return inputJson(value) as Prisma.InputJsonObject;
}

function normalizeLifecycle(lifecycle: string): ConfigRuleLifecycle {
  if (lifecycle === "DRAFT" || lifecycle === "ACTIVE" || lifecycle === "RETIRED") {
    return lifecycle;
  }

  throw new Error(`Unknown config rule lifecycle: ${lifecycle}`);
}

export function configRuleSnapshotMetadata(
  rule: Pick<ConfigRuleRecord, "id" | "key" | "version" | "lifecycle" | "scopeType" | "scopeId" | "effectiveFrom" | "effectiveTo">
): Record<string, unknown> {
  return {
    key: rule.key,
    config_rule_id: rule.id,
    config_rule_version: rule.version,
    config_rule_lifecycle: rule.lifecycle,
    config_rule_scope_type: rule.scopeType,
    config_rule_scope_id: rule.scopeId,
    config_rule_effective_from: rule.effectiveFrom.toISOString(),
    config_rule_effective_to: rule.effectiveTo?.toISOString() ?? null
  };
}

function ruleSnapshotValue(rule: ResolvedConfigRule): Prisma.InputJsonObject {
  return inputJsonObject({
    ...configRuleSnapshotMetadata(rule),
    value: rule.parsedValue
  });
}

export function sortConfigRulesForResolution<T extends Pick<ConfigRuleRecord, "scopeType" | "effectiveFrom" | "version">>(
  rules: readonly T[]
): T[] {
  return [...rules].sort((left, right) => {
    const scopeOrder = specificity(right.scopeType) - specificity(left.scopeType);
    if (scopeOrder !== 0) {
      return scopeOrder;
    }

    const effectiveOrder = right.effectiveFrom.getTime() - left.effectiveFrom.getTime();
    if (effectiveOrder !== 0) {
      return effectiveOrder;
    }

    return right.version - left.version;
  });
}

export class ConfigRuleRepository {
  constructor(
    private readonly tx: TenantTransaction,
    private readonly organizationId: string
  ) {}

  async resolve(input: {
    key: string;
    scopes: readonly ConfigScopeCandidate[];
    asOf?: Date;
  }): Promise<ResolvedConfigRule | null> {
    const asOf = input.asOf ?? new Date();
    const scopes = normalizedScopes(input.scopes);

    if (scopes.length === 0) {
      return null;
    }

    const rules = await this.tx.configRule.findMany({
      where: {
        organizationId: this.organizationId,
        key: input.key,
        archivedAt: null,
        lifecycle: {
          in: ["ACTIVE", "RETIRED"]
        },
        effectiveFrom: {
          lte: asOf
        },
        OR: [
          {
            effectiveTo: null
          },
          {
            effectiveTo: {
              gt: asOf
            }
          }
        ],
        AND: [
          {
            OR: scopes.map(scopeFilter)
          }
        ]
      },
      select: {
        id: true,
        key: true,
        scopeType: true,
        scopeId: true,
        value: true,
        effectiveFrom: true,
        effectiveTo: true,
        version: true,
        lifecycle: true,
        createdBy: true,
        reason: true,
        createdAt: true
      }
    });
    const retiredScopes = new Set<string>();

    for (const rule of sortConfigRulesForResolution(rules)) {
      const scopeKey = `${rule.scopeType}:${rule.scopeId ?? "null"}`;
      const lifecycle = normalizeLifecycle(rule.lifecycle);

      if (retiredScopes.has(scopeKey)) {
        continue;
      }

      if (lifecycle === "RETIRED") {
        retiredScopes.add(scopeKey);
        continue;
      }

      return {
        ...rule,
        lifecycle,
        parsedValue: parseConfigRuleValue(rule.key, rule.value)
      };
    }

    return null;
  }

  async list(input: {
    key?: string;
    scopeType?: string;
    scopeId?: string | null;
    take?: number;
  } = {}): Promise<ConfigRuleRecord[]> {
    const rules = await this.tx.configRule.findMany({
      where: {
        organizationId: this.organizationId,
        archivedAt: null,
        key: input.key,
        scopeType: input.scopeType,
        scopeId: input.scopeId === undefined ? undefined : input.scopeId
      },
      orderBy: [
        { key: "asc" },
        { scopeType: "asc" },
        { scopeId: "asc" },
        { effectiveFrom: "desc" },
        { version: "desc" },
        { createdAt: "desc" }
      ],
      take: input.take ?? 200,
      select: {
        id: true,
        key: true,
        scopeType: true,
        scopeId: true,
        value: true,
        effectiveFrom: true,
        effectiveTo: true,
        version: true,
        lifecycle: true,
        createdBy: true,
        reason: true,
        createdAt: true
      }
    });

    return rules.map((rule) => ({
      ...rule,
      lifecycle: normalizeLifecycle(rule.lifecycle)
    }));
  }

  async findById(id: string): Promise<ConfigRuleRecord | null> {
    const rule = await this.tx.configRule.findFirst({
      where: {
        id,
        organizationId: this.organizationId,
        archivedAt: null
      },
      select: {
        id: true,
        key: true,
        scopeType: true,
        scopeId: true,
        value: true,
        effectiveFrom: true,
        effectiveTo: true,
        version: true,
        lifecycle: true,
        createdBy: true,
        reason: true,
        createdAt: true
      }
    });

    return rule
      ? {
          ...rule,
          lifecycle: normalizeLifecycle(rule.lifecycle)
        }
      : null;
  }

  async listPropertyScopeOptions(): Promise<ConfigPropertyScopeOption[]> {
    return this.tx.property.findMany({
      where: {
        organizationId: this.organizationId,
        archivedAt: null
      },
      orderBy: [{ city: "asc" }, { name: "asc" }],
      select: {
        id: true,
        name: true,
        city: true
      },
      take: 1000
    });
  }

  async createVersion(input: {
    key: string;
    scopeType: string;
    scopeId?: string | null;
    value: unknown;
    effectiveFrom: Date;
    effectiveTo?: Date | null;
    lifecycle?: ConfigRuleLifecycle;
    createdBy?: string | null;
    reason: string;
  }): Promise<ConfigRuleRecord> {
    if (input.effectiveTo && input.effectiveTo.getTime() <= input.effectiveFrom.getTime()) {
      throw new Error("Config rule effective_to must be after effective_from");
    }

    if (input.scopeType === "organization" && input.scopeId) {
      throw new Error("Organization-scoped config rules must not include scope_id");
    }

    if (input.scopeType !== "organization" && !input.scopeId) {
      throw new Error("Non-organization config rules require scope_id");
    }

    const parsedValue = parseConfigRuleValue(input.key, input.value);
    const latest = await this.tx.configRule.findFirst({
      where: {
        organizationId: this.organizationId,
        key: input.key,
        scopeType: input.scopeType,
        scopeId: input.scopeId ?? null
      },
      orderBy: {
        version: "desc"
      },
      select: {
        version: true
      }
    });

    const created = await this.tx.configRule.create({
      data: {
        organizationId: this.organizationId,
        key: input.key,
        scopeType: input.scopeType,
        scopeId: input.scopeId ?? null,
        value: inputJson(parsedValue),
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo ?? null,
        version: (latest?.version ?? 0) + 1,
        lifecycle: input.lifecycle ?? "ACTIVE",
        createdBy: input.createdBy ?? null,
        reason: input.reason
      },
      select: {
        id: true,
        key: true,
        scopeType: true,
        scopeId: true,
        value: true,
        effectiveFrom: true,
        effectiveTo: true,
        version: true,
        lifecycle: true,
        createdBy: true,
        reason: true,
        createdAt: true
      }
    });

    return {
      ...created,
      lifecycle: normalizeLifecycle(created.lifecycle)
    };
  }

  async activateVersion(input: {
    ruleId: string;
    effectiveFrom: Date;
    effectiveTo?: Date | null;
    createdBy?: string | null;
    reason: string;
  }): Promise<ConfigRuleRecord> {
    const source = await this.findById(input.ruleId);

    if (!source) {
      throw new Error("Config rule was not found");
    }

    return this.createVersion({
      key: source.key,
      scopeType: source.scopeType,
      scopeId: source.scopeId,
      value: source.value,
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo,
      lifecycle: "ACTIVE",
      createdBy: input.createdBy,
      reason: input.reason
    });
  }

  async retireVersion(input: {
    ruleId: string;
    effectiveFrom: Date;
    createdBy?: string | null;
    reason: string;
  }): Promise<ConfigRuleRecord> {
    const source = await this.findById(input.ruleId);

    if (!source) {
      throw new Error("Config rule was not found");
    }

    return this.createVersion({
      key: source.key,
      scopeType: source.scopeType,
      scopeId: source.scopeId,
      value: source.value,
      effectiveFrom: input.effectiveFrom,
      lifecycle: "RETIRED",
      createdBy: input.createdBy,
      reason: input.reason
    });
  }

  async snapshotReservationRule(input: {
    reservationId: string;
    propertyId: string;
    rule: ResolvedConfigRule;
    resolvedAt: Date;
    createdBy?: string | null;
  }): Promise<ReservationConfigSnapshotRecord> {
    const existing = await this.tx.reservationConfigSnapshot.findUnique({
      where: {
        organizationId_reservationId_key: {
          organizationId: this.organizationId,
          reservationId: input.reservationId,
          key: input.rule.key
        }
      },
      select: {
        id: true,
        key: true,
        configRuleId: true,
        version: true,
        snapshotValue: true,
        resolvedAt: true
      }
    });

    if (existing) {
      return existing;
    }

    return this.tx.reservationConfigSnapshot.create({
      data: {
        organizationId: this.organizationId,
        reservationId: input.reservationId,
        propertyId: input.propertyId,
        configRuleId: input.rule.id,
        key: input.rule.key,
        scopeType: input.rule.scopeType,
        scopeId: input.rule.scopeId,
        version: input.rule.version,
        snapshotValue: ruleSnapshotValue(input.rule),
        resolvedAt: input.resolvedAt,
        createdBy: input.createdBy ?? null
      },
      select: {
        id: true,
        key: true,
        configRuleId: true,
        version: true,
        snapshotValue: true,
        resolvedAt: true
      }
    });
  }
}
