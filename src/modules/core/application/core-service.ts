import { headers } from "next/headers";
import { CoreRepository } from "@/modules/core/infrastructure/core-repository";
import {
  agreementNoticeConfigKey,
  agreementResponsibilitiesConfigKey,
  agreementSpecialConditionsConfigKey,
  approvalThresholdsConfigSchema,
  commissionConfigKey,
  expenseTreatmentConfigSchema,
  payoutScheduleConfigSchema
} from "@/platform/config/rule-registry";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import {
  managementAgreementInputSchema,
  ownerInputSchema,
  propertyOperatingProfileInputSchema,
  propertyInputSchema,
  propertyOwnershipInputSchema,
  type ManagementAgreementInput,
  type ManagementAgreementRuleSummary,
  type ManagementAgreementSummary,
  type OwnerInput,
  type OwnerSummary,
  type PropertyInput,
  type PropertyOperatingProfileInput,
  type PropertyOwnershipInput,
  type PropertySummary
} from "@/modules/core/domain/owner-property";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { authorize, authorizeCollection } from "@/platform/authz/authorize";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import type { CoreActorContext } from "@/modules/core/application/core-access";

export class CoreAuthorizationError extends Error {
  constructor(message = "Core action is not authorized") {
    super(message);
    this.name = "CoreAuthorizationError";
  }
}

export class CoreNotFoundError extends Error {
  constructor(message = "Core resource was not found") {
    super(message);
    this.name = "CoreNotFoundError";
  }
}

type CoreServiceDeps = {
  db?: TenantTransactionRunner;
  requestId?: string;
  ipAddress?: string | null;
};

type AuditMeta = {
  requestId: string;
  ipAddress: string | null;
};

function assertAllowed(
  ctx: CoreActorContext,
  action: "view" | "create" | "edit",
  resource: "owner" | "property",
  id?: string
): void {
  const allowed = id
    ? authorize(ctx.authContext, action, {
        type: resource,
        organizationId: ctx.organizationId,
        id,
        ownerId: resource === "owner" ? id : undefined,
        propertyId: resource === "property" ? id : undefined
      })
    : authorizeCollection(ctx.authContext, action, resource);

  if (!allowed) {
    throw new CoreAuthorizationError();
  }
}

const agreementConfigKeys = [
  commissionConfigKey,
  "finance.expense_treatment",
  "finance.approval_thresholds",
  "finance.payout_schedule",
  agreementResponsibilitiesConfigKey,
  agreementNoticeConfigKey,
  agreementSpecialConditionsConfigKey
] as const;

function assertConfigAllowed(
  ctx: CoreActorContext,
  action: "view" | "create" | "configure",
  propertyId: string
): void {
  const allowed = authorize(ctx.authContext, action, {
    type: "config_rule",
    organizationId: ctx.organizationId,
    id: `agreement:${propertyId}`,
    propertyId
  });

  if (!allowed) {
    throw new CoreAuthorizationError();
  }
}

async function auditMeta(deps: CoreServiceDeps): Promise<AuditMeta> {
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

function db(deps: CoreServiceDeps): TenantTransactionRunner {
  return deps.db ?? prisma;
}

export function parseOwnerInput(input: unknown) {
  return ownerInputSchema.safeParse(input);
}

export function parsePropertyInput(input: unknown) {
  return propertyInputSchema.safeParse(input);
}

export function parsePropertyOperatingProfileInput(input: unknown) {
  return propertyOperatingProfileInputSchema.safeParse(input);
}

export function parsePropertyOwnershipInput(input: unknown) {
  return propertyOwnershipInputSchema.safeParse(input);
}

export function parseManagementAgreementInput(input: unknown) {
  return managementAgreementInputSchema.safeParse(input);
}

function latestRule(
  agreement: ManagementAgreementSummary,
  key: string
): ManagementAgreementRuleSummary | null {
  return (
    agreement.rules
      .filter((rule) => rule.key === key)
      .sort((left, right) => right.version - left.version)[0] ?? null
  );
}

function compactAgreementSummary(agreement: ManagementAgreementSummary): Record<string, unknown> {
  const commission = latestRule(agreement, commissionConfigKey);
  const payout = latestRule(agreement, "finance.payout_schedule");
  const notice = latestRule(agreement, agreementNoticeConfigKey);

  return {
    id: agreement.id,
    propertyId: agreement.propertyId,
    reference: agreement.reference,
    status: agreement.status,
    effectiveFrom: agreement.effectiveFrom,
    effectiveTo: agreement.effectiveTo,
    commission: commission?.value ?? null,
    payout: payout?.value ?? null,
    notice: notice?.value ?? null,
    ruleIds: agreement.rules.map((rule) => ({
      id: rule.id,
      key: rule.key,
      version: rule.version
    }))
  };
}

function agreementRuleValues(input: ManagementAgreementInput): Array<{ key: string; value: unknown }> {
  const approvalThresholds = input.approvalThresholdAmount
    ? {
        thresholds: [
          {
            key: input.approvalThresholdKey ?? "owner_approval",
            amount: input.approvalThresholdAmount,
            currency: input.approvalThresholdCurrency,
            requires_approval_from: input.approvalRequires
          }
        ]
      }
    : {
        thresholds: []
      };
  const payoutSchedule = {
    cadence: input.payoutCadence,
    ...(input.payoutHoldDays === undefined ? {} : { hold_days: input.payoutHoldDays }),
    ...(input.payoutHoldbackBps === undefined ? {} : { holdback_bps: input.payoutHoldbackBps })
  };

  return [
    {
      key: commissionConfigKey,
      value: {
        rate_bps: input.commissionRateBps,
        basis: input.commissionBasis,
        accrual_event: input.commissionAccrualEvent
      }
    },
    {
      key: "finance.expense_treatment",
      value: {
        default_treatment: input.expenseDefaultTreatment,
        categories: {}
      }
    },
    {
      key: "finance.approval_thresholds",
      value: approvalThresholds
    },
    {
      key: "finance.payout_schedule",
      value: payoutSchedule
    },
    {
      key: agreementResponsibilitiesConfigKey,
      value: {
        owner: input.ownerResponsibilities,
        alvillas: input.alvillasResponsibilities
      }
    },
    {
      key: agreementNoticeConfigKey,
      value: {
        notice_period_days: input.noticePeriodDays
      }
    },
    {
      key: agreementSpecialConditionsConfigKey,
      value: {
        conditions: input.specialConditions
      }
    }
  ];
}

export async function createOwner(
  ctx: CoreActorContext,
  input: OwnerInput,
  deps: CoreServiceDeps = {}
): Promise<OwnerSummary> {
  assertAllowed(ctx, "create", "owner");
  const meta = await auditMeta(deps);

  return withTenant(db(deps), ctx.organizationId, async (tx) => {
    const repository = new CoreRepository(tx, ctx.organizationId);
    const owner = await repository.createOwner(input, ctx.actorId);

    await writeAuditEvent(tx, {
      organizationId: ctx.organizationId,
      actorId: ctx.actorId,
      action: "owner.create",
      resourceType: "owner",
      resourceId: owner.id,
      ipAddress: meta.ipAddress,
      propertyScopeId: null,
      after: owner,
      reason: "S2 owner creation",
      requestId: meta.requestId,
      occurredAt: new Date()
    });

    return owner;
  });
}

export async function listOwners(
  ctx: CoreActorContext,
  deps: CoreServiceDeps = {}
): Promise<OwnerSummary[]> {
  assertAllowed(ctx, "view", "owner");

  return withTenant(db(deps), ctx.organizationId, async (tx) =>
    (await new CoreRepository(tx, ctx.organizationId).listOwners()).filter((owner) =>
      authorize(ctx.authContext, "view", {
        type: "owner",
        organizationId: ctx.organizationId,
        id: owner.id,
        ownerId: owner.id
      })
    )
  );
}

export async function getOwner(
  ctx: CoreActorContext,
  ownerId: string,
  deps: CoreServiceDeps = {}
): Promise<OwnerSummary> {
  assertAllowed(ctx, "view", "owner", ownerId);

  const owner = await withTenant(db(deps), ctx.organizationId, async (tx) =>
    new CoreRepository(tx, ctx.organizationId).findOwner(ownerId)
  );

  if (!owner) {
    throw new CoreNotFoundError();
  }

  return owner;
}

export async function createProperty(
  ctx: CoreActorContext,
  input: PropertyInput,
  deps: CoreServiceDeps = {}
): Promise<PropertySummary> {
  assertAllowed(ctx, "create", "property");
  const meta = await auditMeta(deps);

  return withTenant(db(deps), ctx.organizationId, async (tx) => {
    const repository = new CoreRepository(tx, ctx.organizationId);
    const owner = await repository.findOwner(input.ownerId);

    if (!owner) {
      throw new CoreNotFoundError("Owner does not exist in this tenant");
    }

    const property = await repository.createProperty(input, ctx.actorId);

    await writeAuditEvent(tx, {
      organizationId: ctx.organizationId,
      actorId: ctx.actorId,
      action: "property.create",
      resourceType: "property",
      resourceId: property.id,
      ipAddress: meta.ipAddress,
      propertyScopeId: property.id,
      after: property,
      reason: "S2 property creation",
      requestId: meta.requestId,
      occurredAt: new Date()
    });

    return property;
  });
}

export async function listProperties(
  ctx: CoreActorContext,
  deps: CoreServiceDeps = {}
): Promise<PropertySummary[]> {
  assertAllowed(ctx, "view", "property");

  return withTenant(db(deps), ctx.organizationId, async (tx) =>
    (await new CoreRepository(tx, ctx.organizationId).listProperties()).filter((property) =>
      authorize(ctx.authContext, "view", {
        type: "property",
        organizationId: ctx.organizationId,
        id: property.id,
        propertyId: property.id,
        city: property.cityId,
        region: property.regionId
      })
    )
  );
}

export async function getProperty(
  ctx: CoreActorContext,
  propertyId: string,
  deps: CoreServiceDeps = {}
): Promise<PropertySummary> {
  assertAllowed(ctx, "view", "property", propertyId);

  const property = await withTenant(db(deps), ctx.organizationId, async (tx) =>
    new CoreRepository(tx, ctx.organizationId).findProperty(propertyId)
  );

  if (!property) {
    throw new CoreNotFoundError();
  }

  return property;
}

export async function listPropertyManagementAgreements(
  ctx: CoreActorContext,
  propertyId: string,
  deps: CoreServiceDeps = {}
): Promise<ManagementAgreementSummary[]> {
  assertAllowed(ctx, "view", "property", propertyId);
  assertConfigAllowed(ctx, "view", propertyId);

  return withTenant(db(deps), ctx.organizationId, async (tx) => {
    const repository = new CoreRepository(tx, ctx.organizationId);
    const property = await repository.findProperty(propertyId);

    if (!property) {
      throw new CoreNotFoundError();
    }

    return repository.listManagementAgreementsForProperty(propertyId, agreementConfigKeys);
  });
}

export async function createManagementAgreement(
  ctx: CoreActorContext,
  input: ManagementAgreementInput,
  deps: CoreServiceDeps = {}
): Promise<ManagementAgreementSummary> {
  assertAllowed(ctx, "edit", "property", input.propertyId);
  assertConfigAllowed(ctx, "create", input.propertyId);
  assertConfigAllowed(ctx, "configure", input.propertyId);
  const meta = await auditMeta(deps);

  return withTenant(db(deps), ctx.organizationId, async (tx) => {
    const repository = new CoreRepository(tx, ctx.organizationId);
    const property = await repository.findProperty(input.propertyId);

    if (!property) {
      throw new CoreNotFoundError();
    }

    const agreement = await repository.createManagementAgreement(input, ctx.actorId);
    const configRepository = new ConfigRuleRepository(tx, ctx.organizationId);

    for (const rule of agreementRuleValues(input)) {
      if (rule.key === "finance.approval_thresholds") {
        approvalThresholdsConfigSchema.parse(rule.value);
      } else if (rule.key === "finance.expense_treatment") {
        expenseTreatmentConfigSchema.parse(rule.value);
      } else if (rule.key === "finance.payout_schedule") {
        payoutScheduleConfigSchema.parse(rule.value);
      }

      await configRepository.createVersion({
        key: rule.key,
        scopeType: "agreement",
        scopeId: agreement.id,
        value: rule.value,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo,
        lifecycle: input.status === "DRAFT" ? "DRAFT" : input.status === "ENDED" ? "RETIRED" : "ACTIVE",
        createdBy: ctx.actorId,
        reason: input.reason
      });
    }

    const created = (await repository.listManagementAgreementsForProperty(input.propertyId, agreementConfigKeys)).find(
      (candidate) => candidate.id === agreement.id
    );

    if (!created) {
      throw new CoreNotFoundError("Management agreement was not created");
    }

    await writeAuditEvent(tx, {
      organizationId: ctx.organizationId,
      actorId: ctx.actorId,
      action: "owner_agreement.changed",
      resourceType: "property",
      resourceId: property.id,
      ipAddress: meta.ipAddress,
      propertyScopeId: property.id,
      after: compactAgreementSummary(created),
      reason: input.reason,
      requestId: meta.requestId,
      occurredAt: new Date()
    });

    return created;
  });
}

export async function updatePropertyOwnership(
  ctx: CoreActorContext,
  input: PropertyOwnershipInput,
  deps: CoreServiceDeps = {}
): Promise<PropertySummary> {
  assertAllowed(ctx, "edit", "property", input.propertyId);
  const meta = await auditMeta(deps);

  return withTenant(db(deps), ctx.organizationId, async (tx) => {
    const repository = new CoreRepository(tx, ctx.organizationId);
    const before = await repository.findProperty(input.propertyId);

    if (!before) {
      throw new CoreNotFoundError();
    }

    const property = await repository.replacePropertyOwnership(input, ctx.actorId);

    if (!property) {
      throw new CoreNotFoundError();
    }

    await writeAuditEvent(tx, {
      organizationId: ctx.organizationId,
      actorId: ctx.actorId,
      action: "property.ownership.update",
      resourceType: "property",
      resourceId: property.id,
      ipAddress: meta.ipAddress,
      propertyScopeId: property.id,
      before: {
        owners: before.owners
      },
      after: {
        owners: property.owners
      },
      reason: "F-ORG-05 property ownership update",
      requestId: meta.requestId,
      occurredAt: new Date()
    });

    return property;
  });
}

export async function updatePropertyOperatingProfile(
  ctx: CoreActorContext,
  propertyId: string,
  input: PropertyOperatingProfileInput,
  deps: CoreServiceDeps = {}
): Promise<PropertySummary> {
  assertAllowed(ctx, "edit", "property", propertyId);
  const meta = await auditMeta(deps);

  return withTenant(db(deps), ctx.organizationId, async (tx) => {
    const repository = new CoreRepository(tx, ctx.organizationId);
    const before = await repository.findProperty(propertyId);

    if (!before) {
      throw new CoreNotFoundError();
    }

    const property = await repository.replacePropertyOperatingProfile(propertyId, input, ctx.actorId);

    if (!property) {
      throw new CoreNotFoundError();
    }

    await writeAuditEvent(tx, {
      organizationId: ctx.organizationId,
      actorId: ctx.actorId,
      action: "property.operating_profile.update",
      resourceType: "property",
      resourceId: property.id,
      ipAddress: meta.ipAddress,
      propertyScopeId: property.id,
      before: {
        operatingProfile: before.operatingProfile
      },
      after: {
        operatingProfile: property.operatingProfile
      },
      reason: "F-ORG-06 property operating profile update",
      requestId: meta.requestId,
      occurredAt: new Date()
    });

    return property;
  });
}
