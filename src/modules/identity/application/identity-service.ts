import { createHash, randomBytes } from "node:crypto";
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
} from "@simplewebauthn/types";
import { Prisma } from "@prisma/client";
import { IdentityRepository, type IdentityAccountSummary, type InvitationSummary, type SessionSummary } from "@/modules/identity/infrastructure/identity-repository";
import {
  activationInputSchema,
  identityActionForMutation,
  invitationInputSchema,
  recoveryInputSchema,
  standardRoles,
  type ActivationInput,
  type InvitationInput,
  type RecoveryInput
} from "@/modules/identity/domain/identity";
import {
  assertIdentityAllowed,
  type IdentityActorContext
} from "@/modules/identity/application/identity-access";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { hashCredentialSecret, hashPassword, verifyPassword } from "@/platform/auth/password";
import { encryptSecret, decryptSecret } from "@/platform/auth/secret-encryption";
import { generateTotpSecret, totpUri, verifyTotpCode } from "@/platform/auth/totp";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { bootstrapOrganizationId } from "@/platform/identity/bootstrap";
import {
  consumeRateLimit
} from "@/platform/rate-limit/postgres-rate-limiter";

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
  accounts: IdentityAccountSummary[];
  invitations: InvitationSummary[];
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

function rpIdFromOrigin(origin: string): string {
  return new URL(origin).hostname;
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

export async function ensureStandardIdentitySetup(
  organizationId: string,
  deps: IdentityServiceDeps = {}
): Promise<void> {
  await withTenant(db(deps), organizationId, async (tx) => {
    const repository = new IdentityRepository(tx, organizationId);

    for (const role of standardRoles) {
      await repository.ensureRole({
        key: role.key,
        name: role.name,
        permissions: role.permissions,
        isSystem: true
      });
    }
  });
}

export async function listIdentityDashboard(
  ctx: IdentityActorContext,
  deps: IdentityServiceDeps = {}
): Promise<IdentityDashboard> {
  assertIdentityAllowed(ctx, "view");

  return withTenant(db(deps), ctx.organizationId, async (tx) => {
    const repository = new IdentityRepository(tx, ctx.organizationId);

    return {
      accounts: await repository.listAccounts(),
      invitations: await repository.listOpenInvitations(new Map())
    };
  });
}

export async function createInvitation(
  ctx: IdentityActorContext,
  input: InvitationInput,
  deps: IdentityServiceDeps = {}
): Promise<CreatedInvitation> {
  assertIdentityAllowed(ctx, identityActionForMutation("invite"));
  const meta = auditMeta(deps);

  return withTenant(db(deps), ctx.organizationId, async (tx) => {
    const repository = new IdentityRepository(tx, ctx.organizationId);
    await ensureStandardIdentitySetup(ctx.organizationId, { db: { $transaction: (callback) => callback(tx) } });
    const role = await repository.findRoleByKey(input.roleKey);

    if (!role) {
      throw new IdentityNotFoundError("Role was not found");
    }

    const code = newInviteCode();
    const person = await repository.createPerson({
      displayName: input.displayName,
      email: input.email,
      phone: input.phone
    });
    const expiresAt = new Date(Date.now() + input.expiresInHours * 60 * 60 * 1000);
    const invitation = await repository.createInvitation({
      personId: person.id,
      roleId: role.id,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      email: input.email,
      phone: input.phone,
      codeHash: hashCode(code),
      expiresAt,
      actorId: ctx.actorId
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
        roleKey: input.roleKey,
        scopeType: input.scopeType,
        scopeId: input.scopeId ?? null,
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
  });
}

export async function activateInvitation(
  input: ActivationInput,
  deps: IdentityServiceDeps = {}
): Promise<{ userAccountId: string }> {
  const parsed = activationInputSchema.parse(input);
  const organizationId = bootstrapOrganizationId;

  return withTenant(db(deps), organizationId, async (tx) => {
    const rateLimit = await consumeRateLimit(tx, organizationId, {
      key: `invitation:${hashCode(parsed.code)}`,
      limit: 6,
      windowSeconds: 15 * 60
    });

    if (!rateLimit.allowed) {
      throw new IdentityConflictError("Too many invitation attempts");
    }

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

    const account = await tx.userAccount.upsert({
      where: {
        organizationId_email: {
          organizationId,
          email: invitation.email ?? `${invitation.id}@activation.local`
        }
      },
      update: {
        personId: invitation.personId,
        email: invitation.email,
        phone: parsed.phone,
        status: "ACTIVE",
        suspendedAt: null,
        deactivatedAt: null
      },
      create: {
        organizationId,
        personId: invitation.personId,
        email: invitation.email,
        phone: parsed.phone,
        status: "ACTIVE"
      }
    });

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

    const repository = new IdentityRepository(tx, organizationId);
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
  });
}

export async function suspendAccount(
  ctx: IdentityActorContext,
  userAccountId: string,
  deps: IdentityServiceDeps = {}
): Promise<void> {
  assertIdentityAllowed(ctx, identityActionForMutation("suspend"), userAccountId);
  const meta = auditMeta(deps);

  await withTenant(db(deps), ctx.organizationId, async (tx) => {
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
      after: { status: account.status },
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

  await withTenant(db(deps), ctx.organizationId, async (tx) => {
    await tx.userAccount.update({
      where: { id: userAccountId },
      data: {
        status: "ACTIVE",
        suspendedAt: null,
        deactivatedAt: null,
        sessionVersion: { increment: 1 }
      }
    });
  });
}

export async function issueRecoveryCode(
  ctx: IdentityActorContext,
  userAccountId: string,
  deps: IdentityServiceDeps = {}
): Promise<string> {
  assertIdentityAllowed(ctx, identityActionForMutation("recover"), userAccountId);
  const code = newRecoveryCode();

  await withTenant(db(deps), ctx.organizationId, async (tx) => {
    const account = await tx.userAccount.findFirst({
      where: { id: userAccountId, organizationId: ctx.organizationId }
    });

    if (!account) {
      throw new IdentityNotFoundError();
    }

    await tx.authCredential.create({
      data: {
        organizationId: ctx.organizationId,
        userAccountId,
        type: "RECOVERY_CODE",
        label: "Recovery code",
        secretHash: await hashCredentialSecret(code),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
      }
    });
  });

  return code;
}

export async function recoverPassword(input: RecoveryInput, deps: IdentityServiceDeps = {}): Promise<void> {
  const parsed = recoveryInputSchema.parse(input);

  await withTenant(db(deps), bootstrapOrganizationId, async (tx) => {
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

    if (!account) {
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
    await tx.authCredential.update({
      where: { id: matchedCredentialId },
      data: { revokedAt: new Date(), lastUsedAt: new Date() }
    });
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

  await withTenant(db(deps), ctx.organizationId, async (tx) => {
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
  });
}

export async function startTotpEnrollment(
  ctx: IdentityActorContext,
  deps: IdentityServiceDeps = {}
): Promise<TotpEnrollment> {
  assertIdentityAllowed(ctx, identityActionForMutation("mfa"), ctx.actorId);
  const secret = generateTotpSecret();

  const credential = await withTenant(db(deps), ctx.organizationId, async (tx) =>
    tx.authCredential.create({
      data: {
        organizationId: ctx.organizationId,
        userAccountId: ctx.actorId,
        type: "TOTP",
        label: "Authenticator app",
        secretEncrypted: encryptSecret(secret),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000)
      },
      select: { id: true }
    })
  );

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
  const recoveryCodes = Array.from({ length: 8 }, () => newRecoveryCode());

  await withTenant(db(deps), ctx.organizationId, async (tx) => {
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

    await tx.authCredential.update({
      where: { id: credential.id },
      data: { expiresAt: null, lastUsedAt: new Date() }
    });
    await tx.userAccount.update({
      where: { id: ctx.actorId },
      data: { mfaRequired: true }
    });
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
      userID: account.id,
      userName: account.email ?? account.id,
      userDisplayName: account.person.displayName,
      attestationType: "none",
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "preferred"
      },
      excludeCredentials: account.authCredentials
        .filter((credential) => credential.credentialId)
        .map((credential) => ({
          id: Buffer.from(credential.credentialId ?? "", "base64url"),
          type: "public-key",
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

  await withTenant(db(deps), ctx.organizationId, async (tx) => {
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
      requireUserVerification: false
    });

    if (!verification.verified || !verification.registrationInfo) {
      throw new IdentityConflictError("Passkey registration failed");
    }

    await tx.authCredential.create({
      data: {
        organizationId: ctx.organizationId,
        userAccountId: ctx.actorId,
        type: "PASSKEY",
        label: "Passkey",
        credentialId: Buffer.from(verification.registrationInfo.credentialID).toString("base64url"),
        publicKey: Buffer.from(verification.registrationInfo.credentialPublicKey),
        counter: verification.registrationInfo.counter,
        transports: response.response.transports ?? Prisma.JsonNull,
        backupEligible: verification.registrationInfo.credentialDeviceType === "multiDevice",
        backedUp: verification.registrationInfo.credentialBackedUp
      }
    });
    await tx.authChallenge.update({
      where: { id: challenge.id },
      data: { consumedAt: new Date() }
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
      userVerification: "preferred",
      allowCredentials: account.authCredentials
        .filter((credential) => credential.credentialId)
        .map((credential) => ({
          id: Buffer.from(credential.credentialId ?? "", "base64url"),
          type: "public-key",
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
): Promise<{ userAccountId: string }> {
  const origin = webAuthnOrigin(deps);

  return withTenant(db(deps), bootstrapOrganizationId, async (tx) => {
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
      requireUserVerification: false,
      authenticator: {
        credentialID: Buffer.from(credential.credentialId, "base64url"),
        credentialPublicKey: Buffer.from(credential.publicKey),
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

    return { userAccountId: account.id };
  });
}
