import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { recheckAccountAuthorization } from "@/platform/authz/current-authority";
import { authContextsForAccountsInTransaction } from "@/platform/authz/account-context";
import { identityResource } from "../domain/identity";
import { publishNotification } from "@/platform/notifications/notification-service";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON
} from "@simplewebauthn/server";
import { Prisma } from "@prisma/client";
import { IdentityRepository, type IdentityAccountSummary, type InvitationSummary, type SessionSummary } from "@/modules/identity/infrastructure/identity-repository";
import {
  activationInputSchema,
  customRoleInputSchema,
  identityActionForMutation,
  invitationInputSchema,
  pinResetInputSchema,
  personProfileInputSchema,
  recoveryInputSchema,
  roleAssignmentInputSchema,
  updatePersonProfileInputSchema,
  updateAccountEmailInputSchema,
  updateCustomRoleInputSchema,
  type ActivationInput,
  type CustomRoleInput,
  type InvitationInput,
  type PinResetInput,
  type PersonProfileInput,
  type RecoveryInput,
  type RoleAssignmentInput,
  type UpdatePersonProfileInput,
  type UpdateAccountEmailInput,
  type UpdateCustomRoleInput
} from "@/modules/identity/domain/identity";
import {
  fieldPolicyCatalog,
  permissionCatalog,
  standardRoles
} from "@/platform/authz/catalog";
import {
  coHostSpecScenarios,
  simulateAccess,
  splitSimulationResults,
  type PermissionSimulationResult
} from "@/platform/authz/simulator";
import {
  IdentityAuthorizationError,
  assertIdentityAllowed,
  type IdentityActorContext
} from "@/modules/identity/application/identity-access";
import { authorize, type Action, type Resource } from "@/platform/authz/authorize";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { hashCredentialSecret, hashPassword, verifyPassword } from "@/platform/auth/password";
import { encryptSecret, decryptSecret } from "@/platform/auth/secret-encryption";
import { generateTotpSecret, totpUri, verifyTotpCode } from "@/platform/auth/totp";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { bootstrapOrganizationId } from "@/platform/identity/bootstrap";
import {
  consumeRateLimit
} from "@/platform/rate-limit/postgres-rate-limiter";
import { safeLocale, type AppLocale } from "@/i18n/routing";
import { PinSecurityRepository } from "@/modules/identity/infrastructure/pin-security-repository";
import { TeamRepository } from "@/modules/identity/infrastructure/team-repository";
import { present, catalogFieldPolicy } from "@/platform/authz/present";

export class IdentityNotFoundError extends Error {
  constructor(message = "Identity resource was not found") {
    super(message);
    this.name = "IdentityNotFoundError";
  }
}

export class IdentityConflictError extends Error {
  constructor(message = "Identity action cannot be completed") {
    super(message);
    this.name = "IdentityConflictError";
  }
}

type IdentityServiceDeps = {
  db?: TenantTransactionRunner;
  requestId?: string;
  ipAddress?: string | null;
  origin?: string;
};

export type IdentityDashboard = {
  people: Awaited<ReturnType<IdentityRepository["listPeople"]>>;
  duplicateContacts: Awaited<ReturnType<IdentityRepository["listDuplicateContacts"]>>;
  accounts: IdentityAccountSummary[];
  invitations: InvitationSummary[];
  roles: Awaited<ReturnType<IdentityRepository["listRoles"]>>;
  permissions: Awaited<ReturnType<IdentityRepository["listPermissions"]>>;
  assignments: Awaited<ReturnType<IdentityRepository["listRoleAssignments"]>>;
  simulations: AccountPermissionSimulation[];
};

export type AccountPermissionSimulation = {
  userAccountId: string;
  displayName: string;
  roleLabels: string[];
  canSee: PermissionSimulationResult[];
  cannotSee: PermissionSimulationResult[];
};

export type CreatedInvitation = {
  invitationId: string;
  code: string;
  expiresAt: Date;
};

export type TotpEnrollment = {
  credentialId: string;
  secret: string;
  uri: string;
};

function db(deps: IdentityServiceDeps): TenantTransactionRunner {
  return deps.db ?? prisma;
}

function auditMeta(deps: IdentityServiceDeps) {
  return {
    requestId: deps.requestId ?? crypto.randomUUID(),
    ipAddress: deps.ipAddress ?? null
  };
}

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function newInviteCode(): string {
  return randomBytes(18).toString("base64url");
}

function newRecoveryCode(): string {
  return `${randomBytes(4).toString("hex")}-${randomBytes(4).toString("hex")}`;
}

function webAuthnOrigin(deps: IdentityServiceDeps): string {
  return deps.origin ?? process.env.APP_URL ?? "http://localhost:3000";
}

function identityUrl(deps: IdentityServiceDeps, path: string): string {
  const origin = webAuthnOrigin(deps).replace(/\/$/u, "");

  return `${origin}${path}`;
}

function rpIdFromOrigin(origin: string): string {
  return new URL(origin).hostname;
}

async function enqueueIdentityDelivery(
  tx: TenantTransaction,
  input: {
    organizationId: string;
    type: string;
    idempotencyKey: string;
    payload: Prisma.InputJsonObject;
  }
): Promise<void> {
  await tx.outboxEvent.upsert({
    where: {
      organizationId_idempotencyKey: {
        organizationId: input.organizationId,
        idempotencyKey: input.idempotencyKey
      }
    },
    update: {
      type: input.type,
      payload: input.payload,
      status: "PENDING",
      processedAt: null,
      attemptCount: 0,
      nextAttemptAt: null,
      lastError: null
    },
    create: {
      organizationId: input.organizationId,
      type: input.type,
      payload: input.payload,
      idempotencyKey: input.idempotencyKey
    }
  });
}

export function parseInvitationInput(input: unknown) {
  return invitationInputSchema.safeParse(input);
}

export function parseActivationInput(input: unknown) {
  return activationInputSchema.safeParse(input);
}

export function parseRecoveryInput(input: unknown) {
  return recoveryInputSchema.safeParse(input);
}

export function parsePinResetInput(input: unknown) {
  return pinResetInputSchema.safeParse(input);
}

export function parsePersonProfileInput(input: unknown) {
  return personProfileInputSchema.safeParse(input);
}

export function parseUpdatePersonProfileInput(input: unknown) {
  return updatePersonProfileInputSchema.safeParse(input);
}

export function parseCustomRoleInput(input: unknown) {
  return customRoleInputSchema.safeParse(input);
}

export function parseUpdateCustomRoleInput(input: unknown) {
  return updateCustomRoleInputSchema.safeParse(input);
}

export function parseRoleAssignmentInput(input: unknown) {
  return roleAssignmentInputSchema.safeParse(input);
}

function assertAuthorizationAllowed(
  ctx: IdentityActorContext,
  action: Parameters<typeof authorize>[1],
  resourceOrType: string | Resource,
  id?: string
): void {
  const resource =
    typeof resourceOrType === "string"
      ? {
          type: resourceOrType,
          organizationId: ctx.organizationId,
          id
        }
      : resourceOrType;

  if (
    !authorize(ctx.authContext, action, resource)
  ) {
    throw new IdentityAuthorizationError();
  }
}

function scopedRoleAssignmentResource(
  organizationId: string,
  input: Pick<RoleAssignmentInput, "roleId" | "scopeType" | "scopeId">
): Resource {
  const resource: Resource = {
    type: "role",
    organizationId,
    id: input.roleId
  };

  switch (input.scopeType) {
    case "region":
      resource.region = input.scopeId;
      break;
    case "city":
      resource.city = input.scopeId;
      break;
    case "property":
      resource.propertyId = input.scopeId;
      break;
    case "owner":
      resource.ownerId = input.scopeId;
      break;
    case "reservation":
      resource.reservationId = input.scopeId;
      break;
    case "job":
      resource.jobId = input.scopeId;
      resource.taskId = input.scopeId;
      break;
    case "service":
      resource.serviceId = input.scopeId;
      break;
    case "financial_record":
      resource.financialRecordId = input.scopeId;
      break;
    case "wallet":
      resource.walletId = input.scopeId;
      break;
    case "field_team":
      resource.fieldTeamId = input.scopeId;
      break;
    case "organization":
      break;
  }

  return resource;
}

function permissionParts(permission: string): { resourceType: string; action: Action } {
  const separator = permission.lastIndexOf(":");

  if (separator <= 0 || separator === permission.length - 1) {
    throw new IdentityAuthorizationError("Cannot grant an invalid permission");
  }

  return {
    resourceType: permission.slice(0, separator),
    action: permission.slice(separator + 1) as Action
  };
}

export function assertPermissionGrantAllowed(
  ctx: IdentityActorContext,
  permissionKeys: readonly string[],
  roleId?: string,
  grantResource?: Resource
): void {
  const overrideResource =
    grantResource ?? {
      type: "role",
      organizationId: ctx.organizationId,
      id: roleId
    };
  const canOverride = authorize(ctx.authContext, "override", {
    ...overrideResource,
    type: "role",
    id: roleId
  });

  if (canOverride) {
    return;
  }

  for (const permissionKey of permissionKeys) {
    if (grantResource) {
      const { resourceType, action } = permissionParts(permissionKey);

      if (
        !authorize(ctx.authContext, action, {
          ...grantResource,
          type: resourceType
        })
      ) {
        throw new IdentityAuthorizationError("Cannot grant a permission the actor does not hold at this scope");
      }

      continue;
    }

    if (!ctx.authContext.permissions.has(permissionKey)) {
      throw new IdentityAuthorizationError("Cannot grant a permission the actor does not hold");
    }
  }
}

function assignmentConditions(input: RoleAssignmentInput): Prisma.InputJsonObject | null {
  const conditions: Record<string, Prisma.InputJsonValue> = {};

  if (input.assignedToMe) {
    conditions.assignedToMe = true;
  }

  if (input.statuses.length > 0) {
    conditions.statuses = input.statuses;
  }

  if (input.maxAmount) {
    conditions.maxAmount = input.maxAmount;
  }

  if (input.conditionStartsAt || input.conditionEndsAt) {
    conditions.timeWindow = {
      ...(input.conditionStartsAt ? { startsAt: input.conditionStartsAt.toISOString() } : {}),
      ...(input.conditionEndsAt ? { endsAt: input.conditionEndsAt.toISOString() } : {})
    };
  }

  return Object.keys(conditions).length > 0 ? conditions : null;
}

export async function ensureStandardIdentitySetup(
  organizationId: string,
  deps: IdentityServiceDeps = {}
): Promise<void> {
  await withTenant(db(deps), organizationId, async (tx) => {
    const expectedRoleKeys = standardRoles.map((role) => role.key);
    const expectedPermissionKeys = permissionCatalog.map((permission) => permission.key);
    const [permissionCount, fieldPolicyCount, existingRoles] = await Promise.all([
      tx.permission.count({
        where: {
          organizationId,
          key: { in: expectedPermissionKeys }
        }
      }),
      tx.fieldPolicy.count({
        where: {
          organizationId,
          OR: fieldPolicyCatalog.map((fieldPolicy) => ({
            resource: fieldPolicy.resource,
            field: fieldPolicy.field
          }))
        }
      }),
      tx.role.findMany({
        where: {
          organizationId,
          key: { in: expectedRoleKeys },
          archivedAt: null
        },
        select: {
          key: true,
          rolePermissions: {
            select: {
              permission: { select: { key: true } }
            }
          }
        }
      })
    ]);
    const rolePermissionCounts = new Map(
      existingRoles.map((role) => [
        role.key,
        new Set(role.rolePermissions.map((rolePermission) => rolePermission.permission.key))
      ])
    );
    const standardRolesReady =
      existingRoles.length === standardRoles.length &&
      standardRoles.every(
        (role) =>
          role.permissions.every((permissionKey) =>
            rolePermissionCounts.get(role.key)?.has(permissionKey)
          )
      );

    if (
      permissionCount >= permissionCatalog.length &&
      fieldPolicyCount >= fieldPolicyCatalog.length &&
      standardRolesReady
    ) {
      return;
    }

    await tx.permission.createMany({
      data: permissionCatalog.map((permission) => ({
        organizationId,
        key: permission.key,
        resource: permission.resource,
        action: permission.action,
        description: permission.description
      })),
      skipDuplicates: true
    });

    await tx.role.createMany({
      data: standardRoles.map((role) => ({
        organizationId,
        key: role.key,
        name: role.name,
        description: role.description,
        isSystem: true,
        archivedAt: null
      })),
      skipDuplicates: true
    });

    const [permissions, roles] = await Promise.all([
      tx.permission.findMany({
        where: {
          organizationId,
          key: { in: expectedPermissionKeys }
        },
        select: { id: true, key: true, resource: true, action: true, description: true }
      }),
      tx.role.findMany({
        where: {
          organizationId,
          key: { in: expectedRoleKeys }
        },
        select: { id: true, key: true, name: true, description: true, isSystem: true, archivedAt: true }
      })
    ]);
    const permissionsByKey = new Map(permissions.map((permission) => [permission.key, permission]));
    const rolesByKey = new Map(roles.map((role) => [role.key, role]));

    const permissionUpdates = permissionCatalog.filter((permission) => {
      const existing = permissionsByKey.get(permission.key);

      return (
        !existing ||
        existing.resource !== permission.resource ||
        existing.action !== permission.action ||
        existing.description !== permission.description
      );
    });
    const roleUpdates = standardRoles.filter((role) => {
      const existing = rolesByKey.get(role.key);

      return (
        !existing ||
        existing.name !== role.name ||
        existing.description !== role.description ||
        !existing.isSystem ||
        existing.archivedAt !== null
      );
    });

    await Promise.all([
      ...permissionUpdates.map((permission) =>
        tx.permission.updateMany({
          where: {
            organizationId,
            key: permission.key
          },
          data: {
            resource: permission.resource,
            action: permission.action,
            description: permission.description
          }
        })
      ),
      ...roleUpdates.map((role) =>
        tx.role.updateMany({
          where: {
            organizationId,
            key: role.key
          },
          data: {
            name: role.name,
            description: role.description,
            isSystem: true,
            archivedAt: null
          }
        })
      )
    ]);

    const permissionIdsByKey = new Map(permissions.map((permission) => [permission.key, permission.id]));
    const roleIdsByKey = new Map(roles.map((role) => [role.key, role.id]));
    const expectedRolePermissions = standardRoles.flatMap((role) => {
      const roleId = roleIdsByKey.get(role.key);

      if (!roleId) {
        return [];
      }

      return role.permissions.flatMap((permissionKey) => {
        const permissionId = permissionIdsByKey.get(permissionKey);

        return permissionId
          ? [{
              organizationId,
              roleId,
              permissionId
            }]
          : [];
      });
    });

    if (expectedRolePermissions.length > 0) {
      await tx.rolePermission.createMany({
        data: expectedRolePermissions,
        skipDuplicates: true
      });
    }

    const repository = new IdentityRepository(tx, organizationId);

    for (const fieldPolicy of fieldPolicyCatalog) {
      await repository.ensureFieldPolicy(fieldPolicy);
    }
  }, { timeout: 30000 });
}

async function buildAccountSimulations(
  organizationId: string,
  accounts: IdentityAccountSummary[],
  tx: TenantTransaction
): Promise<AccountPermissionSimulation[]> {
  const simulations: AccountPermissionSimulation[] = [];
  const selected=accounts.slice(0,12),contexts=await authContextsForAccountsInTransaction(tx,organizationId,selected.map(account=>account.id));
  for (const account of selected) {
    const ctx=contexts.get(account.id)!;
    const propertyScope = ctx.scopes.find((scope) => {
      const type = scope.scopeType ?? scope.resourceType;
      return type === "property" && (scope.scopeId || scope.resourceId);
    });
    const assignedPropertyId = propertyScope?.scopeId ?? propertyScope?.resourceId ?? "sim-assigned-property";
    const results = simulateAccess(
      ctx,
      coHostSpecScenarios({
        organizationId,
        assignedPropertyId,
        otherPropertyId: "sim-other-property",
        reservationId: "sim-reservation",
        walletId: "sim-wallet"
      })
    );
    const split = splitSimulationResults(results);

    simulations.push({
      userAccountId: account.id,
      displayName: account.displayName,
      roleLabels: account.roles,
      canSee: split.canSee,
      cannotSee: split.cannotSee
    });
  }

  return simulations;
}

export async function searchIdentityAccounts(ctx:IdentityActorContext,raw:unknown,deps:IdentityServiceDeps={}){
  const input=z.object({query:z.string().trim().max(120),after:z.uuid().optional()}).strict().parse(raw);
  return withTenant(db(deps),ctx.organizationId,async tx=>{
    const checks=[{action:"view" as const,resource:{type:identityResource,organizationId:ctx.organizationId}}];
    await recheckAccountAuthorization(ctx,tx,new Date(),checks,new IdentityAuthorizationError());
    const rows=await new IdentityRepository(tx,ctx.organizationId).listAccounts({...input,take:101});
    await recheckAccountAuthorization(ctx,tx,new Date(),checks,new IdentityAuthorizationError());
    return{accounts:rows.slice(0,100),next:rows.length>100?rows[99].id:null};
  });
}

export async function listIdentityDashboard(
  ctx: IdentityActorContext,
  deps: IdentityServiceDeps = {}
): Promise<IdentityDashboard> {
  assertIdentityAllowed(ctx, "view");

  return withTenant(db(deps), ctx.organizationId, async (tx) => {
    const repository = new IdentityRepository(tx, ctx.organizationId);
    await ensureStandardIdentitySetup(ctx.organizationId, {
      db: { $transaction: (callback) => callback(tx) }
    });
    const accounts = await repository.listAccounts();

    return {
      people: await repository.listPeople(),
      duplicateContacts: await repository.listDuplicateContacts(),
      accounts,
      invitations: await repository.listOpenInvitations(new Map()),
      roles: await repository.listRoles(),
      permissions: await repository.listPermissions(),
      assignments: await repository.listRoleAssignments(),
      simulations: await buildAccountSimulations(ctx.organizationId, accounts, tx)
    };
  });
}

export async function createPersonProfile(
  ctx: IdentityActorContext,
  input: PersonProfileInput,
  deps: IdentityServiceDeps = {}
): Promise<{ id: string }> {
  assertIdentityAllowed(ctx, "create");
  const parsed = personProfileInputSchema.parse(input);
  const meta = auditMeta(deps);

  return withTenant(db(deps), ctx.organizationId, async (tx) => {
    const repository = new IdentityRepository(tx, ctx.organizationId);

    try {
      const person = await repository.createStandalonePerson(parsed);

      await writeAuditEvent(tx, {
        organizationId: ctx.organizationId,
        actorId: ctx.actorId,
        action: "identity.person.create",
        resourceType: "identity",
        resourceId: person.id,
        ipAddress: meta.ipAddress,
        after: {
          personId: person.id,
          displayName: person.displayName,
          email: person.email,
          phone: person.phone,
          preferredLocale: person.preferredLocale
        },
        reason: "Person profile created",
        requestId: meta.requestId,
        occurredAt: new Date()
      });

      return { id: person.id };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new IdentityConflictError("Person contact already exists");
      }

      throw error;
    }
  });
}

export async function updatePersonProfile(
  ctx: IdentityActorContext,
  input: UpdatePersonProfileInput,
  deps: IdentityServiceDeps = {}
): Promise<{ id: string }> {
  assertIdentityAllowed(ctx, "edit", input.personId);
  const parsed = updatePersonProfileInputSchema.parse(input);
  const meta = auditMeta(deps);

  return withTenant(db(deps), ctx.organizationId, async (tx) => {
    const repository = new IdentityRepository(tx, ctx.organizationId);

    try {
      const update = await repository.updatePersonProfile(parsed);

      await writeAuditEvent(tx, {
        organizationId: ctx.organizationId,
        actorId: ctx.actorId,
        action: "identity.person.update",
        resourceType: "identity",
        resourceId: update.after.id,
        ipAddress: meta.ipAddress,
        before: {
          personId: update.before.id,
          displayName: update.before.displayName,
          email: update.before.email,
          phone: update.before.phone,
          preferredLocale: update.before.preferredLocale
        },
        after: {
          personId: update.after.id,
          displayName: update.after.displayName,
          email: update.after.email,
          phone: update.after.phone,
          preferredLocale: update.after.preferredLocale
        },
        reason: "Person profile updated",
        requestId: meta.requestId,
        occurredAt: new Date()
      });

      return { id: update.after.id };
    } catch (error) {
      if (error instanceof Error && error.message === "Person was not found") {
        throw new IdentityNotFoundError("Person was not found");
      }

      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new IdentityConflictError("Person contact already exists");
      }

      throw error;
    }
  });
}

export async function updateAccountEmail(ctx: IdentityActorContext, input: UpdateAccountEmailInput, deps: IdentityServiceDeps = {}): Promise<{ id: string }> {
  const parsed = updateAccountEmailInputSchema.parse(input);
  assertIdentityAllowed(ctx, "edit", parsed.accountId);
  const meta = auditMeta(deps);
  return withTenant(db(deps), ctx.organizationId, async (tx) => {
    try {
      const update = await new IdentityRepository(tx, ctx.organizationId).updateAccountEmail(parsed);
      if (update.changed) await writeAuditEvent(tx, {
        organizationId: ctx.organizationId, actorId: ctx.actorId, action: "identity.account.email.update", resourceType: "identity", resourceId: update.after.id,
        ipAddress: meta.ipAddress, before: { email: update.before.email }, after: { email: update.after.email }, reason: parsed.reason, requestId: meta.requestId, occurredAt: new Date()
      });
      return { id: update.after.id };
    } catch (error) {
      if (error instanceof Error && error.message === "Account was not found") throw new IdentityNotFoundError();
      if ((error instanceof Error && ["Account contact changed", "Account email already exists"].includes(error.message)) || (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw new IdentityConflictError("Account email cannot be changed");
      throw error;
    }
  });
}

export async function updateOwnPreferredLocale(
  ctx: IdentityActorContext,
  preferredLocale: AppLocale,
  deps: IdentityServiceDeps = {}
): Promise<void> {
  const meta = auditMeta(deps);

  await withTenant(db(deps), ctx.organizationId, async (tx) => {
    const repository = new IdentityRepository(tx, ctx.organizationId);
    const update = await repository.updatePersonPreferredLocale(ctx.personId, preferredLocale);

    if (update.before === update.after) {
      return;
    }

    await writeAuditEvent(tx, {
      organizationId: ctx.organizationId,
      actorId: ctx.actorId,
      action: "identity.preference.update",
      resourceType: "identity",
      resourceId: ctx.actorId,
      ipAddress: meta.ipAddress,
      before: {
        personId: update.id,
        preferredLocale: update.before
      },
      after: {
        personId: update.id,
        preferredLocale: update.after
      },
      reason: "User language preference updated",
      requestId: meta.requestId,
      occurredAt: new Date()
    });
    await publishNotification(tx, ctx.organizationId, {
      kind: "language_updated", recipientId: ctx.actorId, targetId: ctx.actorId
    }, `notification:language:${ctx.actorId}:${meta.requestId}`);
  });
}

export async function createCustomRole(
  ctx: IdentityActorContext,
  input: CustomRoleInput,
  deps: IdentityServiceDeps = {}
): Promise<{ id: string }> {
  assertAuthorizationAllowed(ctx, "create", "role");
  assertPermissionGrantAllowed(ctx, input.permissionKeys);
  const meta = auditMeta(deps);

  return withTenant(db(deps), ctx.organizationId, async (tx) => {
    const repository = new IdentityRepository(tx, ctx.organizationId);
    await ensureStandardIdentitySetup(ctx.organizationId, { db: { $transaction: (callback) => callback(tx) } });

    try {
      const role = await repository.createCustomRole(input);

      await writeAuditEvent(tx, {
        organizationId: ctx.organizationId,
        actorId: ctx.actorId,
        action: "authorization.role.create",
        resourceType: "role",
        resourceId: role.id,
        ipAddress: meta.ipAddress,
        after: {
          key: role.key,
          name: role.name,
          permissionKeys: role.permissionKeys
        },
        reason: "Custom role created",
        requestId: meta.requestId,
        occurredAt: new Date()
      });

      return { id: role.id };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new IdentityConflictError("Role key already exists");
      }

      throw error;
    }
  });
}

export async function updateCustomRole(
  ctx: IdentityActorContext,
  input: UpdateCustomRoleInput,
  deps: IdentityServiceDeps = {}
): Promise<{ id: string }> {
  assertAuthorizationAllowed(ctx, "edit", "role", input.roleId);
  assertPermissionGrantAllowed(ctx, input.permissionKeys, input.roleId);
  const meta = auditMeta(deps);

  return withTenant(db(deps), ctx.organizationId, async (tx) => {
    const repository = new IdentityRepository(tx, ctx.organizationId);
    await ensureStandardIdentitySetup(ctx.organizationId, { db: { $transaction: (callback) => callback(tx) } });

    try {
      const role = await repository.updateCustomRole(input);

      await writeAuditEvent(tx, {
        organizationId: ctx.organizationId,
        actorId: ctx.actorId,
        action: "authorization.role.update",
        resourceType: "role",
        resourceId: role.id,
        ipAddress: meta.ipAddress,
        after: {
          key: role.key,
          name: role.name,
          permissionKeys: role.permissionKeys
        },
        reason: "Custom role updated",
        requestId: meta.requestId,
        occurredAt: new Date()
      });

      return { id: role.id };
    } catch (error) {
      if (error instanceof Error && error.message === "Custom role was not found") {
        throw new IdentityNotFoundError("Custom role was not found");
      }

      throw error;
    }
  });
}

export async function assignRoleToAccount(
  ctx: IdentityActorContext,
  input: RoleAssignmentInput,
  deps: IdentityServiceDeps = {}
): Promise<{ id: string; created: boolean }> {
  const assignmentResource = scopedRoleAssignmentResource(ctx.organizationId, input);

  assertAuthorizationAllowed(ctx, "assign", assignmentResource);
  const meta = auditMeta(deps);

  return withTenant(db(deps), ctx.organizationId, async (tx) => {
    const repository = new IdentityRepository(tx, ctx.organizationId);
    await ensureStandardIdentitySetup(ctx.organizationId, { db: { $transaction: (callback) => callback(tx) } });

    try {
      const role = await repository.findRoleSummaryById(input.roleId);

      if (!role) {
        throw new IdentityNotFoundError("Role was not found");
      }

      assertPermissionGrantAllowed(ctx, role.permissionKeys, role.id, assignmentResource);

      const assignment = await repository.assignRoleToAccount({
        userAccountId: input.userAccountId,
        roleId: input.roleId,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        conditions: assignmentConditions(input),
        validFrom: input.validFrom,
        validTo: input.validTo,
        compensationRef: input.compensationRef,
        actorId: ctx.actorId
      });

      if (assignment.created) {
        await writeAuditEvent(tx, {
          organizationId: ctx.organizationId,
          actorId: ctx.actorId,
          action: "authorization.role_assignment.create",
          resourceType: "role_assignment",
          resourceId: assignment.id,
          ipAddress: meta.ipAddress,
          after: {
            userAccountId: input.userAccountId,
            roleId: input.roleId,
            scopeType: input.scopeType,
            scopeId: input.scopeId ?? null,
            conditions: assignmentConditions(input),
            validFrom: input.validFrom ?? null,
            validTo: input.validTo ?? null,
            compensationRef: input.compensationRef ?? null
          },
          reason: "Scoped role assignment created",
          requestId: meta.requestId,
          occurredAt: new Date()
        });
      }

      return assignment;
    } catch (error) {
      if (error instanceof Error && error.message === "Account was not found") {
        throw new IdentityNotFoundError("Account was not found");
      }

      throw error;
    }
  });
}

export async function getInvitationProfile(ctx: IdentityActorContext, personId: string, deps: IdentityServiceDeps = {}) {
  updatePersonProfileInputSchema.shape.personId.parse(personId);
  for (const action of ["view", "create", "edit"] as const) assertIdentityAllowed(ctx, action, personId);
  return withTenant(db(deps), ctx.organizationId, async tx => {
    const person = await new IdentityRepository(tx, ctx.organizationId).invitationProfile(personId);
    if (!person) throw new IdentityNotFoundError();
    if (person.accountCount) throw new IdentityConflictError("Use the existing account for this person");
    return present({ ...ctx.authContext, visibleDataClasses: new Set() }, "view", { type: "identity", organizationId: ctx.organizationId, id: person.id, data: person }, catalogFieldPolicy<typeof person>("identity")) as typeof person;
  });
}

function invitationConflict(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new IdentityConflictError("Contact already exists; choose the existing profile or account");
  throw error;
}

export async function createInvitation(
  ctx: IdentityActorContext,
  input: InvitationInput,
  deps: IdentityServiceDeps = {}
): Promise<CreatedInvitation> {
  const value = invitationInputSchema.parse(input);
  assertIdentityAllowed(ctx, identityActionForMutation("invite"));
  const meta = auditMeta(deps);

  return withTenant(db(deps), ctx.organizationId, async (tx) => {
    const repository = new IdentityRepository(tx, ctx.organizationId);
    await ensureStandardIdentitySetup(ctx.organizationId, { db: { $transaction: (callback) => callback(tx) } });
    const role = await repository.findRoleByKey(value.roleKey);

    if (!role) {
      throw new IdentityNotFoundError("Role was not found");
    }

    const assignmentResource = scopedRoleAssignmentResource(ctx.organizationId, { roleId: role.id, scopeType: value.scopeType, scopeId: value.scopeId });
    assertAuthorizationAllowed(ctx, "assign", assignmentResource);
    const roleSummary = await repository.findRoleSummaryById(role.id);
    if (!roleSummary) throw new IdentityNotFoundError();
    assertPermissionGrantAllowed(ctx, roleSummary.permissionKeys, role.id, assignmentResource);

    const code = newInviteCode();
    if (value.personId) await new TeamRepository(tx, ctx.organizationId).lock(value.personId);
    const person = value.personId
      ? await getInvitationProfile(ctx, value.personId, { ...deps, db: { $transaction: callback => callback(tx) } })
      : await repository.createStandalonePerson({ displayName: value.displayName, email: value.email, phone: value.phone, preferredLocale: value.preferredLocale ?? "en" });
    if (person.email && await repository.accountEmailExists(person.email)) throw new IdentityConflictError("Use the existing account for this email");
    const expiresAt = new Date(Date.now() + value.expiresInHours * 60 * 60 * 1000);
    const invitation = await repository.createInvitation({
      personId: person.id,
      roleId: role.id,
      scopeType: value.scopeType,
      scopeId: value.scopeId,
      email: person.email ?? undefined,
      phone: person.phone ?? undefined,
      codeHash: hashCode(code),
      expiresAt,
      actorId: ctx.actorId
    });
    const recipientLocale = safeLocale(person.preferredLocale);
    const activationUrl = identityUrl(deps, `/${recipientLocale}/activate/${code}`);

    await enqueueIdentityDelivery(tx, {
      organizationId: ctx.organizationId,
      type: "identity.invitation.delivery_requested",
      idempotencyKey: `identity.invitation.delivery:${invitation.id}`,
      payload: {
        invitationId: invitation.id,
        personId: person.id,
        displayName: person.displayName,
        channel: person.email ? "email" : person.phone ? "manual_phone" : "manual",
        toEmail: person.email,
        toPhone: person.phone,
        roleKey: value.roleKey,
        scopeType: value.scopeType,
        scopeId: value.scopeId ?? null,
        activationCode: code,
        activationUrl,
        locale: recipientLocale,
        expiresAt: expiresAt.toISOString()
      }
    });

    await writeAuditEvent(tx, {
      organizationId: ctx.organizationId,
      actorId: ctx.actorId,
      action: "identity.invitation.create",
      resourceType: "identity",
      resourceId: invitation.id,
      ipAddress: meta.ipAddress,
      after: {
        personId: person.id,
        roleKey: value.roleKey,
        scopeType: value.scopeType,
        scopeId: value.scopeId ?? null,
        expiresAt
      },
      reason: "Identity invitation created",
      requestId: meta.requestId,
      occurredAt: new Date()
    });

    return {
      invitationId: invitation.id,
      code,
      expiresAt
    };
  }).catch(invitationConflict);
}

export async function activateInvitation(
  input: ActivationInput,
  deps: IdentityServiceDeps = {}
): Promise<{ userAccountId: string }> {
  const parsed = activationInputSchema.parse(input);
  const organizationId = bootstrapOrganizationId;
  const rateLimit = await withTenant(db(deps), organizationId, (tx) => consumeRateLimit(tx, organizationId, {
      key: `invitation:${hashCode(parsed.code)}`,
      limit: 6,
      windowSeconds: 15 * 60
  }));
  if (!rateLimit.allowed) throw new IdentityConflictError("Too many invitation attempts");

  return withTenant(db(deps), organizationId, async (tx) => {
    await new IdentityRepository(tx, organizationId).lockIdentityOperation(`invitation:${hashCode(parsed.code)}`);
    const invitation = await tx.invitation.findFirst({
      where: {
        organizationId,
        codeHash: hashCode(parsed.code)
      },
      include: {
        person: true,
        role: true
      }
    });

    if (
      !invitation ||
      invitation.acceptedAt ||
      invitation.revokedAt ||
      invitation.expiresAt.getTime() <= Date.now()
    ) {
      throw new IdentityConflictError("Invitation is expired or already used");
    }

    if (invitation.phone && invitation.phone !== parsed.phone) {
      throw new IdentityConflictError("Invitation phone verification failed");
    }

    await new TeamRepository(tx, organizationId).lock(invitation.personId);
    const repository = new IdentityRepository(tx, organizationId);
    const person = await repository.invitationProfile(invitation.personId);
    if (!person || person.accountCount || person.email !== invitation.email || person.phone !== invitation.phone) throw new IdentityConflictError("Invitation profile changed or already has an account");
    const account = await repository.createInvitationAccount({ personId: person.id, email: invitation.email, phone: parsed.phone });

    await tx.authCredential.create({
      data: {
        organizationId,
        userAccountId: account.id,
        type: "PIN",
        label: "Field PIN",
        secretHash: await hashCredentialSecret(parsed.pin)
      }
    });

    if (parsed.password) {
      const passwordHash = await hashPassword(parsed.password);
      await tx.authCredential.create({
        data: {
          organizationId,
          userAccountId: account.id,
          type: "PASSWORD",
          label: "Password",
          secretHash: passwordHash
        }
      });
      await tx.userAccount.update({
        where: { id: account.id },
        data: { passwordHash }
      });
    }

    await repository.assignRole({
      personId: invitation.personId,
      userAccountId: account.id,
      roleId: invitation.roleId,
      scopeType: invitation.scopeType,
      scopeId: invitation.scopeId,
      actorId: invitation.createdBy
    });

    await tx.invitation.update({
      where: { id: invitation.id },
      data: {
        acceptedAt: new Date(),
        userAccountId: account.id
      }
    });
    await repository.revokeOtherInvitations(person.id, invitation.id);

    await writeAuditEvent(tx, {
      organizationId,
      actorId: null,
      action: "identity.invitation.accept",
      resourceType: "identity",
      resourceId: account.id,
      ipAddress: deps.ipAddress ?? null,
      after: {
        invitationId: invitation.id,
        roleKey: invitation.role.key,
        phone: parsed.phone
      },
      reason: "Invitation accepted",
      requestId: deps.requestId ?? crypto.randomUUID(),
      occurredAt: new Date()
    });

    return { userAccountId: account.id };
  }).catch(invitationConflict);
}

export async function suspendAccount(
  ctx: IdentityActorContext,
  userAccountId: string,
  deps: IdentityServiceDeps = {}
): Promise<void> {
  assertIdentityAllowed(ctx, identityActionForMutation("suspend"), userAccountId);
  const meta = auditMeta(deps);

  await withTenant(db(deps), ctx.organizationId, async (tx) => {
    const before = await tx.userAccount.findFirst({
      where: { id: userAccountId, organizationId: ctx.organizationId },
      select: {
        status: true,
        suspendedAt: true,
        deactivatedAt: true,
        sessionVersion: true
      }
    });

    if (!before) {
      throw new IdentityNotFoundError();
    }

    const account = await tx.userAccount.update({
      where: { id: userAccountId },
      data: {
        status: "SUSPENDED",
        suspendedAt: new Date(),
        sessionVersion: { increment: 1 },
        authSessions: {
          updateMany: {
            where: { revokedAt: null },
            data: { revokedAt: new Date() }
          }
        }
      }
    });

    await writeAuditEvent(tx, {
      organizationId: ctx.organizationId,
      actorId: ctx.actorId,
      action: "identity.account.suspend",
      resourceType: "identity",
      resourceId: userAccountId,
      ipAddress: meta.ipAddress,
      before,
      after: {
        status: account.status,
        suspendedAt: account.suspendedAt,
        deactivatedAt: account.deactivatedAt,
        sessionVersion: account.sessionVersion
      },
      reason: "Account suspended",
      requestId: meta.requestId,
      occurredAt: new Date()
    });
  });
}

export async function reactivateAccount(
  ctx: IdentityActorContext,
  userAccountId: string,
  deps: IdentityServiceDeps = {}
): Promise<void> {
  assertIdentityAllowed(ctx, identityActionForMutation("recover"), userAccountId);
  const meta = auditMeta(deps);

  await withTenant(db(deps), ctx.organizationId, async (tx) => {
    const before = await tx.userAccount.findFirst({
      where: { id: userAccountId, organizationId: ctx.organizationId },
      select: {
        status: true,
        suspendedAt: true,
        deactivatedAt: true,
        sessionVersion: true
      }
    });

    if (!before) {
      throw new IdentityNotFoundError();
    }

    const account = await tx.userAccount.update({
      where: { id: userAccountId },
      data: {
        status: "ACTIVE",
        suspendedAt: null,
        deactivatedAt: null,
        sessionVersion: { increment: 1 }
      }
    });

    await writeAuditEvent(tx, {
      organizationId: ctx.organizationId,
      actorId: ctx.actorId,
      action: "identity.account.reactivate",
      resourceType: "identity",
      resourceId: userAccountId,
      ipAddress: meta.ipAddress,
      before,
      after: {
        status: account.status,
        suspendedAt: account.suspendedAt,
        deactivatedAt: account.deactivatedAt,
        sessionVersion: account.sessionVersion
      },
      reason: "Account reactivated",
      requestId: meta.requestId,
      occurredAt: new Date()
    });
  });
}

export async function deactivateAccount(
  ctx: IdentityActorContext,
  userAccountId: string,
  deps: IdentityServiceDeps = {}
): Promise<void> {
  assertIdentityAllowed(ctx, identityActionForMutation("deactivate"), userAccountId);

  if (ctx.actorId === userAccountId) {
    throw new IdentityConflictError("Accounts cannot deactivate themselves");
  }

  const meta = auditMeta(deps);

  await withTenant(db(deps), ctx.organizationId, async (tx) => {
    const before = await tx.userAccount.findFirst({
      where: { id: userAccountId, organizationId: ctx.organizationId },
      select: {
        personId: true,
        status: true,
        suspendedAt: true,
        deactivatedAt: true,
        sessionVersion: true
      }
    });

    if (!before) {
      throw new IdentityNotFoundError();
    }

    const team = new TeamRepository(tx, ctx.organizationId);
    await team.lock(before.personId);
    const offboarding = await team.offboarding(before.personId);
    if (offboarding.openTasks || !offboarding.walletClear) {
      throw new IdentityConflictError("Resolve outstanding staff obligations before deactivation");
    }

    const now = new Date();
    const account = await tx.userAccount.update({
      where: { id: userAccountId },
      data: {
        status: "DEACTIVATED",
        suspendedAt: null,
        deactivatedAt: now,
        sessionVersion: { increment: 1 }
      }
    });
    const [sessions, devices, assignments] = await Promise.all([
      tx.authSession.updateMany({
        where: {
          organizationId: ctx.organizationId,
          userAccountId,
          revokedAt: null
        },
        data: { revokedAt: now }
      }),
      tx.authDevice.updateMany({
        where: {
          organizationId: ctx.organizationId,
          userAccountId,
          revokedAt: null
        },
        data: { revokedAt: now }
      }),
      tx.roleAssignment.updateMany({
        where: {
          organizationId: ctx.organizationId,
          userAccountId,
          archivedAt: null
        },
        data: { archivedAt: now }
      })
    ]);

    await writeAuditEvent(tx, {
      organizationId: ctx.organizationId,
      actorId: ctx.actorId,
      action: "identity.account.deactivate",
      resourceType: "identity",
      resourceId: userAccountId,
      ipAddress: meta.ipAddress,
      before,
      after: {
        status: account.status,
        suspendedAt: account.suspendedAt,
        deactivatedAt: account.deactivatedAt,
        sessionVersion: account.sessionVersion,
        revokedSessionCount: sessions.count,
        revokedDeviceCount: devices.count,
        archivedAssignmentCount: assignments.count
      },
      reason: "Account deactivated and offboarded",
      requestId: meta.requestId,
      occurredAt: now
    });
  });
}

export async function resetAccountPin(
  ctx: IdentityActorContext,
  input: PinResetInput,
  deps: IdentityServiceDeps = {}
): Promise<void> {
  const parsed = pinResetInputSchema.parse(input);
  assertIdentityAllowed(ctx, identityActionForMutation("recover"), parsed.userAccountId);
  const meta = auditMeta(deps);

  await withTenant(db(deps), ctx.organizationId, async (tx) => {
    const account = await tx.userAccount.findFirst({
      where: {
        id: parsed.userAccountId,
        organizationId: ctx.organizationId
      },
      select: {
        id: true,
        phone: true,
        status: true,
        sessionVersion: true
      }
    });

    if (!account) {
      throw new IdentityNotFoundError();
    }

    const now = new Date();
    if (account.phone) {
      const pinSecurity = new PinSecurityRepository(tx, ctx.organizationId);
      await pinSecurity.lock(account.phone);
      await pinSecurity.save(account.phone, 0, now);
    }
    const existingPins = await tx.authCredential.updateMany({
      where: {
        organizationId: ctx.organizationId,
        userAccountId: account.id,
        type: "PIN",
        revokedAt: null
      },
      data: {
        revokedAt: now
      }
    });
    const credential = await tx.authCredential.create({
      data: {
        organizationId: ctx.organizationId,
        userAccountId: account.id,
        type: "PIN",
        label: "Supervisor PIN reset",
        secretHash: await hashCredentialSecret(parsed.pin)
      },
      select: { id: true }
    });
    const sessionRevoke = await tx.authSession.updateMany({
      where: {
        organizationId: ctx.organizationId,
        userAccountId: account.id,
        revokedAt: null
      },
      data: { revokedAt: now }
    });
    const updatedAccount = await tx.userAccount.update({
      where: { id: account.id },
      data: {
        sessionVersion: { increment: 1 }
      },
      select: {
        sessionVersion: true
      }
    });

    await writeAuditEvent(tx, {
      organizationId: ctx.organizationId,
      actorId: ctx.actorId,
      action: "identity.pin.reset",
      resourceType: "identity",
      resourceId: account.id,
      ipAddress: meta.ipAddress,
      before: {
        status: account.status,
        phone: account.phone,
        sessionVersion: account.sessionVersion,
        activePinCount: existingPins.count
      },
      after: {
        authCredentialRecordId: credential.id,
        sessionVersion: updatedAccount.sessionVersion,
        revokedSessionCount: sessionRevoke.count
      },
      reason: "Supervisor reset field PIN",
      requestId: meta.requestId,
      occurredAt: now
    });
  });
}

export async function issueRecoveryCode(
  ctx: IdentityActorContext,
  userAccountId: string,
  deps: IdentityServiceDeps = {}
): Promise<string> {
  assertIdentityAllowed(ctx, identityActionForMutation("recover"), userAccountId);
  const meta = auditMeta(deps);
  const code = newRecoveryCode();

  await withTenant(db(deps), ctx.organizationId, async (tx) => {
    const account = await new IdentityRepository(tx, ctx.organizationId).findRecoveryDeliveryAccount(userAccountId);

    if (!account) {
      throw new IdentityNotFoundError();
    }

    const credential = await tx.authCredential.create({
      data: {
        organizationId: ctx.organizationId,
        userAccountId,
        type: "RECOVERY_CODE",
        label: "Recovery code",
        secretHash: await hashCredentialSecret(code),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
      },
      select: { id: true, expiresAt: true }
    });

    await enqueueIdentityDelivery(tx, {
      organizationId: ctx.organizationId,
      type: "identity.recovery.delivery_requested",
      idempotencyKey: `identity.recovery.delivery:${credential.id}`,
      payload: {
        userAccountId,
        channel: account.email ? "email" : account.phone ? "manual_phone" : "manual",
        toEmail: account.email ?? null,
        toPhone: account.phone ?? null,
        recoveryCode: code,
        recoveryUrl: identityUrl(deps, `/${safeLocale(account.person.preferredLocale)}/recover`),
        locale: safeLocale(account.person.preferredLocale),
        expiresAt: credential.expiresAt?.toISOString() ?? null
      }
    });

    await writeAuditEvent(tx, {
      organizationId: ctx.organizationId,
      actorId: ctx.actorId,
      action: "identity.recovery_code.issue",
      resourceType: "identity",
      resourceId: userAccountId,
      ipAddress: meta.ipAddress,
      after: {
        userAccountId,
        authCredentialRecordId: credential.id,
        expiresAt: credential.expiresAt?.toISOString() ?? null
      },
      reason: "Recovery code issued",
      requestId: meta.requestId,
      occurredAt: new Date()
    });
  });

  return code;
}

export async function recoverPassword(input: RecoveryInput, deps: IdentityServiceDeps = {}): Promise<void> {
  const parsed = recoveryInputSchema.parse(input);
  const meta = auditMeta(deps);
  const limit = await withTenant(db(deps), bootstrapOrganizationId, (tx) => consumeRateLimit(tx, bootstrapOrganizationId, {
    key: `recovery:${parsed.email}:${deps.ipAddress ?? "local"}`, limit: 5, windowSeconds: 60
  }));
  if (!limit.allowed) throw new IdentityConflictError("Too many recovery attempts");

  await withTenant(db(deps), bootstrapOrganizationId, async (tx) => {
    if (!await new IdentityRepository(tx, bootstrapOrganizationId).lockRecoverableAccount(parsed.email)) {
      throw new IdentityNotFoundError();
    }
    const account = await tx.userAccount.findFirst({
      where: {
        organizationId: bootstrapOrganizationId,
        email: parsed.email
      },
      include: {
        authCredentials: {
          where: {
            type: "RECOVERY_CODE",
            revokedAt: null,
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }]
          }
        }
      }
    });

    if (!account || account.status === "DEACTIVATED") {
      throw new IdentityNotFoundError();
    }

    let matchedCredentialId: string | null = null;

    for (const credential of account.authCredentials) {
      if (credential.secretHash && (await verifyPassword(parsed.recoveryCode, credential.secretHash))) {
        matchedCredentialId = credential.id;
        break;
      }
    }

    if (!matchedCredentialId) {
      throw new IdentityConflictError("Recovery code is invalid");
    }

    const passwordHash = await hashPassword(parsed.newPassword);
    const consumed = await tx.authCredential.updateMany({
      where: { id: matchedCredentialId, organizationId: bootstrapOrganizationId, revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      data: { revokedAt: new Date(), lastUsedAt: new Date() }
    });
    if (consumed.count !== 1) throw new IdentityConflictError("Recovery code is invalid");
    await tx.authCredential.updateMany({
      where: {
        organizationId: bootstrapOrganizationId,
        userAccountId: account.id,
        type: "PASSWORD",
        revokedAt: null
      },
      data: { revokedAt: new Date() }
    });
    await tx.authCredential.create({
      data: {
        organizationId: bootstrapOrganizationId,
        userAccountId: account.id,
        type: "PASSWORD",
        label: "Recovered password",
        secretHash: passwordHash
      }
    });
    await tx.userAccount.update({
      where: { id: account.id },
      data: {
        status: "ACTIVE",
        passwordHash,
        sessionVersion: { increment: 1 },
        suspendedAt: null
      }
    });

    await writeAuditEvent(tx, {
      organizationId: bootstrapOrganizationId,
      actorId: account.id,
      action: "identity.account.recover",
      resourceType: "identity",
      resourceId: account.id,
      ipAddress: meta.ipAddress,
      after: {
        userAccountId: account.id,
        recoveryCredentialRecordId: matchedCredentialId,
        passwordRotated: true,
        sessionVersionIncremented: true
      },
      reason: "Password recovered",
      requestId: meta.requestId,
      occurredAt: new Date()
    });
  });
}

export async function listAccountSessions(
  ctx: IdentityActorContext,
  userAccountId: string,
  deps: IdentityServiceDeps = {}
): Promise<SessionSummary[]> {
  assertIdentityAllowed(ctx, "view", userAccountId);

  return withTenant(db(deps), ctx.organizationId, async (tx) =>
    new IdentityRepository(tx, ctx.organizationId).listSessions(userAccountId)
  );
}

export async function revokeSession(
  ctx: IdentityActorContext,
  sessionId: string,
  deps: IdentityServiceDeps = {}
): Promise<void> {
  assertIdentityAllowed(ctx, identityActionForMutation("revoke"));
  const meta = auditMeta(deps);

  await withTenant(db(deps), ctx.organizationId, async (tx) => {
    const session = await tx.authSession.findFirst({
      where: {
        id: sessionId,
        organizationId: ctx.organizationId,
        revokedAt: null
      },
      select: {
        id: true,
        userAccountId: true,
        deviceId: true,
        lastSeenAt: true,
        expiresAt: true
      }
    });

    if (!session) {
      throw new IdentityNotFoundError();
    }

    const result = await tx.authSession.updateMany({
      where: {
        id: sessionId,
        organizationId: ctx.organizationId,
        revokedAt: null
      },
      data: {
        revokedAt: new Date()
      }
    });

    if (result.count !== 1) {
      throw new IdentityNotFoundError();
    }

    await writeAuditEvent(tx, {
      organizationId: ctx.organizationId,
      actorId: ctx.actorId,
      action: "identity.session.revoke",
      resourceType: "identity",
      resourceId: session.userAccountId,
      ipAddress: meta.ipAddress,
      deviceId: session.deviceId,
      before: {
        sessionId: session.id,
        userAccountId: session.userAccountId,
        deviceId: session.deviceId,
        lastSeenAt: session.lastSeenAt.toISOString(),
        expiresAt: session.expiresAt.toISOString()
      },
      after: {
        sessionId: session.id,
        revokedAt: new Date().toISOString()
      },
      reason: "Session revoked",
      requestId: meta.requestId,
      occurredAt: new Date()
    });
    await publishNotification(tx, ctx.organizationId, {
      kind: "security_session_revoked", recipientId: session.userAccountId, targetId: session.userAccountId
    }, `notification:session-revoked:${session.id}`);
  });
}

export async function revokeDevice(
  ctx: IdentityActorContext,
  deviceRecordId: string,
  deps: IdentityServiceDeps = {}
): Promise<void> {
  assertIdentityAllowed(ctx, identityActionForMutation("revoke"));
  const meta = auditMeta(deps);

  await withTenant(db(deps), ctx.organizationId, async (tx) => {
    const device = await tx.authDevice.findFirst({
      where: {
        id: deviceRecordId,
        organizationId: ctx.organizationId,
        revokedAt: null
      },
      select: {
        id: true,
        userAccountId: true,
        deviceId: true,
        label: true,
        platform: true,
        trusted: true,
        lastSeenAt: true,
        registeredAt: true
      }
    });

    if (!device) {
      throw new IdentityNotFoundError();
    }

    const now = new Date();
    const result = await tx.authDevice.updateMany({
      where: {
        id: deviceRecordId,
        organizationId: ctx.organizationId,
        revokedAt: null
      },
      data: {
        revokedAt: now
      }
    });

    if (result.count !== 1) {
      throw new IdentityNotFoundError();
    }

    const sessions = await tx.authSession.updateMany({
      where: {
        organizationId: ctx.organizationId,
        userAccountId: device.userAccountId,
        deviceId: device.deviceId,
        revokedAt: null
      },
      data: {
        revokedAt: now
      }
    });

    await writeAuditEvent(tx, {
      organizationId: ctx.organizationId,
      actorId: ctx.actorId,
      action: "identity.device.revoke",
      resourceType: "identity",
      resourceId: device.userAccountId,
      ipAddress: meta.ipAddress,
      deviceId: device.deviceId,
      before: {
        authDeviceRecordId: device.id,
        userAccountId: device.userAccountId,
        label: device.label,
        platform: device.platform,
        trusted: device.trusted,
        lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
        registeredAt: device.registeredAt.toISOString()
      },
      after: {
        authDeviceRecordId: device.id,
        revokedAt: now.toISOString(),
        revokedSessionCount: sessions.count
      },
      reason: "Device revoked",
      requestId: meta.requestId,
      occurredAt: now
    });
  });
}

export async function revokeCredential(
  ctx: IdentityActorContext,
  credentialId: string,
  deps: IdentityServiceDeps = {}
): Promise<void> {
  assertIdentityAllowed(ctx, identityActionForMutation("revoke"));
  const meta = auditMeta(deps);

  await withTenant(db(deps), ctx.organizationId, async (tx) => {
    const credential = await tx.authCredential.findFirst({
      where: {
        id: credentialId,
        organizationId: ctx.organizationId,
        revokedAt: null
      },
      select: {
        id: true,
        userAccountId: true,
        type: true,
        label: true,
        lastUsedAt: true,
        expiresAt: true
      }
    });

    if (!credential) {
      throw new IdentityNotFoundError();
    }

    const now = new Date();
    const result = await tx.authCredential.updateMany({
      where: {
        id: credentialId,
        organizationId: ctx.organizationId,
        revokedAt: null
      },
      data: {
        revokedAt: now
      }
    });

    if (result.count !== 1) {
      throw new IdentityNotFoundError();
    }

    const [account, sessions] = await Promise.all([
      tx.userAccount.update({
        where: { id: credential.userAccountId },
        data: {
          sessionVersion: { increment: 1 },
          ...(credential.type === "PASSWORD" ? { passwordHash: null } : {})
        },
        select: {
          sessionVersion: true
        }
      }),
      tx.authSession.updateMany({
        where: {
          organizationId: ctx.organizationId,
          userAccountId: credential.userAccountId,
          revokedAt: null
        },
        data: {
          revokedAt: now
        }
      })
    ]);

    await writeAuditEvent(tx, {
      organizationId: ctx.organizationId,
      actorId: ctx.actorId,
      action: "identity.credential.revoke",
      resourceType: "identity",
      resourceId: credential.userAccountId,
      ipAddress: meta.ipAddress,
      before: {
        authCredentialRecordId: credential.id,
        type: credential.type,
        label: credential.label,
        lastUsedAt: credential.lastUsedAt?.toISOString() ?? null,
        expiresAt: credential.expiresAt?.toISOString() ?? null
      },
      after: {
        authCredentialRecordId: credential.id,
        revokedAt: now.toISOString(),
        sessionVersion: account.sessionVersion,
        revokedSessionCount: sessions.count
      },
      reason: "Credential revoked",
      requestId: meta.requestId,
      occurredAt: now
    });
  });
}

export async function startTotpEnrollment(
  ctx: IdentityActorContext,
  deps: IdentityServiceDeps = {}
): Promise<TotpEnrollment> {
  assertIdentityAllowed(ctx, identityActionForMutation("mfa"), ctx.actorId);
  const meta = auditMeta(deps);
  const secret = generateTotpSecret();

  const credential = await withTenant(db(deps), ctx.organizationId, async (tx) => {
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const created = await tx.authCredential.create({
      data: {
        organizationId: ctx.organizationId,
        userAccountId: ctx.actorId,
        type: "TOTP",
        label: "Authenticator app",
        secretEncrypted: encryptSecret(secret),
        expiresAt
      },
      select: { id: true }
    });

    await writeAuditEvent(tx, {
      organizationId: ctx.organizationId,
      actorId: ctx.actorId,
      action: "identity.mfa.totp.enrollment_started",
      resourceType: "identity",
      resourceId: ctx.actorId,
      ipAddress: meta.ipAddress,
      after: {
        authCredentialRecordId: created.id,
        expiresAt: expiresAt.toISOString()
      },
      reason: "TOTP enrollment started",
      requestId: meta.requestId,
      occurredAt: new Date()
    });

    return created;
  });

  return {
    credentialId: credential.id,
    secret,
    uri: totpUri({
      issuer: "ALVILLAS OS",
      accountName: ctx.actorId,
      secret
    })
  };
}

export async function confirmTotpEnrollment(
  ctx: IdentityActorContext,
  credentialId: string,
  code: string,
  deps: IdentityServiceDeps = {}
): Promise<string[]> {
  assertIdentityAllowed(ctx, identityActionForMutation("mfa"), ctx.actorId);
  const meta = auditMeta(deps);
  const recoveryCodes = Array.from({ length: 8 }, () => newRecoveryCode());

  await withTenant(db(deps), ctx.organizationId, async (tx) => {
    const repository = new IdentityRepository(tx, ctx.organizationId);
    await repository.lockIdentityOperation(`totp-confirm:${ctx.actorId}`);
    const credential = await tx.authCredential.findFirst({
      where: {
        id: credentialId,
        organizationId: ctx.organizationId,
        userAccountId: ctx.actorId,
        type: "TOTP",
        revokedAt: null,
        expiresAt: { gt: new Date() }
      }
    });

    if (!credential?.secretEncrypted || !verifyTotpCode(decryptSecret(credential.secretEncrypted), code)) {
      throw new IdentityConflictError("TOTP code is invalid");
    }

    const confirmation = await repository.confirmTotpCredential(credential.id, ctx.actorId, new Date());
    for (const recoveryCode of recoveryCodes) {
      await tx.authCredential.create({
        data: {
          organizationId: ctx.organizationId,
          userAccountId: ctx.actorId,
          type: "RECOVERY_CODE",
          label: "MFA recovery code",
          secretHash: await hashCredentialSecret(recoveryCode)
        }
      });
    }

    await writeAuditEvent(tx, {
      organizationId: ctx.organizationId,
      actorId: ctx.actorId,
      action: "identity.mfa.totp.confirmed",
      resourceType: "identity",
      resourceId: ctx.actorId,
      ipAddress: meta.ipAddress,
      before: {
        authCredentialRecordId: credential.id,
        expiresAt: credential.expiresAt?.toISOString() ?? null
      },
      after: {
        authCredentialRecordId: credential.id,
        mfaRequired: true,
        recoveryCodeCount: recoveryCodes.length,
        firstEnrollment: confirmation.firstEnrollment, revokedSessionCount: confirmation.revokedSessionCount
      },
      reason: "TOTP enrollment confirmed",
      requestId: meta.requestId,
      occurredAt: new Date()
    });
  });

  return recoveryCodes;
}

export async function beginPasskeyRegistration(
  ctx: IdentityActorContext,
  deps: IdentityServiceDeps = {}
): Promise<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }> {
  assertIdentityAllowed(ctx, identityActionForMutation("mfa"), ctx.actorId);
  const origin = webAuthnOrigin(deps);
  const rpID = rpIdFromOrigin(origin);

  return withTenant(db(deps), ctx.organizationId, async (tx) => {
    const account = await tx.userAccount.findFirst({
      where: { id: ctx.actorId, organizationId: ctx.organizationId },
      include: { person: true, authCredentials: { where: { type: "PASSKEY", revokedAt: null } } }
    });

    if (!account) {
      throw new IdentityNotFoundError();
    }

    const options = await generateRegistrationOptions({
      rpName: "ALVILLAS OS",
      rpID,
      userID: new TextEncoder().encode(account.id),
      userName: account.email ?? account.id,
      userDisplayName: account.person.displayName,
      attestationType: "none",
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "required"
      },
      excludeCredentials: account.authCredentials
        .filter((credential) => credential.credentialId)
        .map((credential) => ({
          id: credential.credentialId ?? "",
          transports: Array.isArray(credential.transports)
            ? credential.transports.filter((transport): transport is AuthenticatorTransport =>
                typeof transport === "string"
              )
            : undefined
        }))
    });
    const challenge = await tx.authChallenge.create({
      data: {
        organizationId: ctx.organizationId,
        userAccountId: ctx.actorId,
        type: "PASSKEY_REGISTRATION",
        challenge: options.challenge,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000)
      },
      select: { id: true }
    });

    return { challengeId: challenge.id, options };
  });
}

export async function finishPasskeyRegistration(
  ctx: IdentityActorContext,
  challengeId: string,
  response: RegistrationResponseJSON,
  deps: IdentityServiceDeps = {}
): Promise<void> {
  assertIdentityAllowed(ctx, identityActionForMutation("mfa"), ctx.actorId);
  const origin = webAuthnOrigin(deps);
  const meta = auditMeta(deps);

  await withTenant(db(deps), ctx.organizationId, async (tx) => {
    await new IdentityRepository(tx, ctx.organizationId).lockIdentityOperation(`passkey-registration:${challengeId}`);
    const challenge = await tx.authChallenge.findFirst({
      where: {
        id: challengeId,
        organizationId: ctx.organizationId,
        userAccountId: ctx.actorId,
        type: "PASSKEY_REGISTRATION",
        consumedAt: null,
        expiresAt: { gt: new Date() }
      }
    });

    if (!challenge) {
      throw new IdentityConflictError("Passkey challenge expired");
    }

    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: origin,
      expectedRPID: rpIdFromOrigin(origin),
      requireUserVerification: true
    });

    if (!verification.verified || !verification.registrationInfo) {
      throw new IdentityConflictError("Passkey registration failed");
    }

    const credential = await tx.authCredential.create({
      data: {
        organizationId: ctx.organizationId,
        userAccountId: ctx.actorId,
        type: "PASSKEY",
        label: "Passkey",
        credentialId: verification.registrationInfo.credential.id,
        publicKey: Buffer.from(verification.registrationInfo.credential.publicKey),
        counter: verification.registrationInfo.credential.counter,
        transports: response.response.transports ?? Prisma.JsonNull,
        backupEligible: verification.registrationInfo.credentialDeviceType === "multiDevice",
        backedUp: verification.registrationInfo.credentialBackedUp
      },
      select: {
        id: true,
        transports: true,
        backupEligible: true,
        backedUp: true
      }
    });
    await tx.authChallenge.update({
      where: { id: challenge.id },
      data: { consumedAt: new Date() }
    });

    await writeAuditEvent(tx, {
      organizationId: ctx.organizationId,
      actorId: ctx.actorId,
      action: "identity.passkey.registered",
      resourceType: "identity",
      resourceId: ctx.actorId,
      ipAddress: meta.ipAddress,
      after: {
        authCredentialRecordId: credential.id,
        transports: credential.transports,
        backupEligible: credential.backupEligible,
        backedUp: credential.backedUp
      },
      reason: "Passkey registered",
      requestId: meta.requestId,
      occurredAt: new Date()
    });
  });
}

export async function beginPasskeyAuthentication(
  email: string,
  deps: IdentityServiceDeps = {}
): Promise<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }> {
  const origin = webAuthnOrigin(deps);

  return withTenant(db(deps), bootstrapOrganizationId, async (tx) => {
    const account = await tx.userAccount.findFirst({
      where: {
        organizationId: bootstrapOrganizationId,
        email,
        status: "ACTIVE"
      },
      include: {
        authCredentials: {
          where: {
            type: "PASSKEY",
            revokedAt: null
          }
        }
      }
    });

    if (!account) {
      throw new IdentityNotFoundError();
    }

    const options = await generateAuthenticationOptions({
      rpID: rpIdFromOrigin(origin),
      userVerification: "required",
      allowCredentials: account.authCredentials
        .filter((credential) => credential.credentialId)
        .map((credential) => ({
          id: credential.credentialId ?? "",
          transports: Array.isArray(credential.transports)
            ? credential.transports.filter((transport): transport is AuthenticatorTransport =>
                typeof transport === "string"
              )
            : undefined
        }))
    });
    const challenge = await tx.authChallenge.create({
      data: {
        organizationId: bootstrapOrganizationId,
        userAccountId: account.id,
        type: "PASSKEY_AUTHENTICATION",
        challenge: options.challenge,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000)
      },
      select: { id: true }
    });

    return { challengeId: challenge.id, options };
  });
}

export async function verifyPasskeyAuthentication(
  email: string,
  challengeId: string,
  response: AuthenticationResponseJSON,
  deps: IdentityServiceDeps = {}
): Promise<{ userAccountId: string; sessionVersion: number }> {
  const origin = webAuthnOrigin(deps);
  const meta = auditMeta(deps);

  return withTenant(db(deps), bootstrapOrganizationId, async (tx) => {
    await new IdentityRepository(tx, bootstrapOrganizationId).lockIdentityOperation(`passkey:${response.id}`);
    const account = await tx.userAccount.findFirst({
      where: {
        organizationId: bootstrapOrganizationId,
        email,
        status: "ACTIVE"
      }
    });

    if (!account) {
      throw new IdentityNotFoundError();
    }

    const challenge = await tx.authChallenge.findFirst({
      where: {
        id: challengeId,
        organizationId: bootstrapOrganizationId,
        userAccountId: account.id,
        type: "PASSKEY_AUTHENTICATION",
        consumedAt: null,
        expiresAt: { gt: new Date() }
      }
    });
    const credential = await tx.authCredential.findFirst({
      where: {
        organizationId: bootstrapOrganizationId,
        userAccountId: account.id,
        type: "PASSKEY",
        credentialId: response.id,
        revokedAt: null
      }
    });

    if (!challenge || !credential?.publicKey || !credential.credentialId) {
      throw new IdentityConflictError("Passkey verification failed");
    }

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: origin,
      expectedRPID: rpIdFromOrigin(origin),
      requireUserVerification: true,
      credential: {
        id: credential.credentialId,
        publicKey: new Uint8Array(credential.publicKey),
        counter: credential.counter,
        transports: Array.isArray(credential.transports)
          ? credential.transports.filter((transport): transport is AuthenticatorTransport =>
              typeof transport === "string"
            )
          : undefined
      }
    });

    if (!verification.verified) {
      throw new IdentityConflictError("Passkey verification failed");
    }

    await tx.authCredential.update({
      where: { id: credential.id },
      data: {
        counter: verification.authenticationInfo.newCounter,
        lastUsedAt: new Date()
      }
    });
    await tx.authChallenge.update({
      where: { id: challenge.id },
      data: { consumedAt: new Date() }
    });

    await writeAuditEvent(tx, {
      organizationId: bootstrapOrganizationId,
      actorId: account.id,
      action: "identity.passkey.authentication_verified",
      resourceType: "identity",
      resourceId: account.id,
      ipAddress: meta.ipAddress,
      after: {
        authCredentialRecordId: credential.id,
        challengeRecordId: challenge.id
      },
      reason: "Passkey authentication verified",
      requestId: meta.requestId,
      occurredAt: new Date()
    });

    return { userAccountId: account.id, sessionVersion: account.sessionVersion };
  });
}
