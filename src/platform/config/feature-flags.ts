import { z } from "zod";
import {
  ConfigRuleRepository,
  configRuleSnapshotMetadata,
  type ConfigScopeCandidate,
  type ResolvedConfigRule
} from "@/platform/config/config-rule-repository";
import { featureFlagConfigSchema } from "@/platform/config/rule-registry";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";

type FeatureFlagDeps = {
  db?: TenantTransactionRunner;
};

export type ResolvedFeatureFlag = {
  key: string;
  enabled: boolean;
  variant: string | null;
  payload: Record<string, unknown>;
  configRuleId: string | null;
  version: number | null;
  snapshotValue: Record<string, unknown> | null;
};

export const featureFlagInputSchema = z.object({
  organizationId: z.string().uuid(),
  key: z.string().trim().min(1).max(120).regex(/^[a-z0-9_.-]+$/u),
  propertyId: z.string().uuid().optional(),
  asOf: z.coerce.date().optional(),
  defaultEnabled: z.boolean().default(false)
});

export type FeatureFlagInput = z.input<typeof featureFlagInputSchema>;

function db(deps: FeatureFlagDeps): TenantTransactionRunner {
  return deps.db ?? prisma;
}

function flagKey(key: string): string {
  return key.startsWith("feature_flag.") ? key : `feature_flag.${key}`;
}

function scopesFor(input: { propertyId?: string }): ConfigScopeCandidate[] {
  return [
    ...(input.propertyId ? [{ scopeType: "property", scopeId: input.propertyId }] : []),
    { scopeType: "organization", scopeId: null }
  ];
}

function snapshot(rule: ResolvedConfigRule): Record<string, unknown> {
  return {
    ...configRuleSnapshotMetadata(rule),
    value: rule.parsedValue
  };
}

export async function resolveFeatureFlag(
  rawInput: FeatureFlagInput,
  deps: FeatureFlagDeps = {}
): Promise<ResolvedFeatureFlag> {
  const input = featureFlagInputSchema.parse(rawInput);
  const key = flagKey(input.key);

  return withTenant(db(deps), input.organizationId, async (tx) => {
    const rule = await new ConfigRuleRepository(tx, input.organizationId).resolve({
      key,
      scopes: scopesFor(input),
      asOf: input.asOf ?? new Date()
    });

    if (!rule) {
      return {
        key,
        enabled: input.defaultEnabled,
        variant: null,
        payload: {},
        configRuleId: null,
        version: null,
        snapshotValue: null
      };
    }

    const value = featureFlagConfigSchema.parse(rule.value);

    return {
      key,
      enabled: value.enabled,
      variant: value.variant ?? null,
      payload: value.payload ?? {},
      configRuleId: rule.id,
      version: rule.version,
      snapshotValue: snapshot(rule)
    };
  });
}
