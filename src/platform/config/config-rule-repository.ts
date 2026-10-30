import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import { parseConfigRuleValue } from "@/platform/config/rule-registry";

export type ConfigScopeType =
  | "organization"
  | "role_assignment"
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
  role_assignment: 6,
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

function scopeIdentity(scopes: readonly ConfigScopeCandidate[]) {
  return JSON.stringify(normalizedScopes(scopes).map(scope => JSON.stringify([scope.scopeType, scope.scopeId])).sort());
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

export function resolveConfigCandidates(rules: Array<Omit<ConfigRuleRecord, "lifecycle"> & { lifecycle: string }>): ResolvedConfigRule | null {
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

export class ConfigRuleRepository {
  constructor(
    private readonly tx: TenantTransaction,
    private readonly organizationId: string
  ) {}

  async lockVersion(key: string, scopeType: string, scopeId?: string | null): Promise<void> {
    await this.tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`config:${this.organizationId}:${key}:${scopeType}:${scopeId ?? ""}`}, 0))`);
  }

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
    return resolveConfigCandidates(rules);
  }

  async resolveForProperties(key: string, propertyIds: string[], asOf: Date) {
    const rules = await this.tx.configRule.findMany({ where: { organizationId: this.organizationId, key, archivedAt: null, lifecycle: { in: ["ACTIVE", "RETIRED"] }, effectiveFrom: { lte: asOf },
      AND: [{ OR: [{ effectiveTo: null }, { effectiveTo: { gt: asOf } }] }, { OR: [{ scopeType: "organization", scopeId: null }, { scopeType: "property", scopeId: { in: propertyIds } }] }] } });
    return new Map(propertyIds.map(id => [id, resolveConfigCandidates(rules.filter(rule => rule.scopeType === "organization" || rule.scopeId === id))]));
  }
  async scopedSnapshot(scopes: readonly ConfigScopeCandidate[], asOf: Date) {
    const wanted = normalizedScopes(scopes);
    const transaction = this.tx, organizationId = this.organizationId, point = asOf.getTime(), identity = scopeIdentity(wanted);
    const rules = wanted.length ? await this.tx.configRule.findMany({ where: { organizationId: this.organizationId, archivedAt: null,
      lifecycle: { in: ["ACTIVE", "RETIRED"] }, effectiveFrom: { lte: asOf }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: asOf } }],
      AND: [{ OR: wanted.map(scopeFilter) }] } }) : [];
    const selected = new Map<string, ResolvedConfigRule | null>();
    // Resolve base policies and their references from one PostgreSQL snapshot.
    // Parse only requested keys, preserving unrelated legacy configuration.
    return { appliesTo(tx: TenantTransaction, organization: string, candidates: readonly ConfigScopeCandidate[], at: Date) {
      return tx === transaction && organization === organizationId && at.getTime() === point && scopeIdentity(candidates) === identity;
    }, resolve(key: string) {
      if (!selected.has(key)) selected.set(key, resolveConfigCandidates(rules.filter(rule => rule.key === key)));
      return selected.get(key) ?? null;
    } };
  }
  async resolveScopeGroups(key:string,groups:Map<string,ConfigScopeCandidate[]>,asOf:Date,options:{recordedAt?:Date;recordedBefore?:Date}={}){
    const candidates=[...new Map([...groups.values()].flat().map(s=>[`${s.scopeType}:${s.scopeId}`,s])).values()];
    const rules=await this.tx.configRule.findMany({where:{organizationId:this.organizationId,key,archivedAt:null,lifecycle:{in:['ACTIVE','RETIRED']},effectiveFrom:{lte:asOf},...(options.recordedBefore?{createdAt:{lt:options.recordedBefore}}:options.recordedAt?{createdAt:{lte:options.recordedAt}}:{}),AND:[{OR:[{effectiveTo:null},{effectiveTo:{gt:asOf}}]},{OR:candidates}]}});
    return new Map([...groups].map(([id,scopes])=>[id,resolveConfigCandidates(rules.filter(r=>scopes.some(s=>s.scopeType===r.scopeType&&s.scopeId===r.scopeId)))]));
  }

  async list(input: {
    key?: string;
    scopeType?: string;
    scopeId?: string | null;
    take?: number;
    excludeScopeTypes?: string[];
    after?: string;
    before?: string;
  } = {}): Promise<ConfigRuleRecord[]> {
    const rules = await this.tx.configRule.findMany({
      where: {
        organizationId: this.organizationId,
        archivedAt: null,
        key: input.key,
        scopeType: input.scopeType ?? (input.excludeScopeTypes ? { notIn: input.excludeScopeTypes } : undefined),
        scopeId: input.scopeId === undefined ? undefined : input.scopeId
      },
      orderBy: [
        { key: input.before ? "desc" : "asc" },
        { scopeType: input.before ? "desc" : "asc" },
        { scopeId: { sort: input.before ? "desc" : "asc", nulls: input.before ? "first" : "last" } },
        { effectiveFrom: input.before ? "asc" : "desc" },
        { version: input.before ? "asc" : "desc" },
        { createdAt: input.before ? "asc" : "desc" },
        { id: input.before ? "desc" : "asc" }
      ],
      ...((input.after || input.before) ? { cursor: { id: input.after ?? input.before }, skip: 1 } : {}),
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

  async previousVersions(rules: readonly ConfigRuleRecord[]): Promise<Map<string, ConfigRuleRecord>> {
    if (!rules.length) return new Map();
    const inputs = JSON.stringify(rules.map(rule => ({ id: rule.id, key: rule.key, scope_type: rule.scopeType, scope_id: rule.scopeId, version: rule.version })));
    const rows = await this.tx.$queryRaw<Array<ConfigRuleRecord & { sourceId: string }>>(Prisma.sql`
      SELECT s.id AS "sourceId", p.id, p.key, p.scope_type AS "scopeType", p.scope_id AS "scopeId", p.value,
        p.effective_from AS "effectiveFrom", p.effective_to AS "effectiveTo", p.version, p.lifecycle,
        p.created_by AS "createdBy", p.reason, p.created_at AS "createdAt"
      FROM jsonb_to_recordset(${inputs}::jsonb) AS s(id uuid, key text, scope_type text, scope_id uuid, version integer)
      JOIN LATERAL (
        SELECT r.* FROM config_rule r WHERE r.organization_id = ${this.organizationId}::uuid AND r.archived_at IS NULL
          AND r.key = s.key AND r.scope_type = s.scope_type AND r.scope_id IS NOT DISTINCT FROM s.scope_id AND r.version < s.version
        ORDER BY r.version DESC LIMIT 1
      ) p ON true`);
    return new Map(rows.map(({ sourceId, ...row }) => [sourceId, { ...row, lifecycle: normalizeLifecycle(row.lifecycle) }]));
  }

  async listPropertyScopeOptions(): Promise<ConfigPropertyScopeOption[]> {
    return this.tx.property.findMany({
      where: {
        organizationId: this.organizationId,
        archivedAt: null
      },
      orderBy: [{ city: "asc" }, { name: "asc" }, { id: "asc" }],
      select: {
        id: true,
        name: true,
        city: true
      }
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
    await this.lockVersion(input.key, input.scopeType, input.scopeId);
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
