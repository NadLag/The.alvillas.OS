import { Prisma } from "@prisma/client";
import { z } from "zod";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { bootstrapOrganizationId } from "@/platform/identity/bootstrap";
import { decryptSecret, encryptSecret } from "@/platform/auth/secret-encryption";
import { verifyPassword } from "@/platform/auth/password";
import { verifyTotpCode } from "@/platform/auth/totp";
import { safeLocale, type AppLocale } from "@/i18n/routing";
import { PinSecurityRepository } from "@/modules/identity/infrastructure/pin-security-repository";
import { pinLockoutState } from "@/modules/identity/domain/pin-lockout";
import { IdentityRepository } from "@/modules/identity/infrastructure/identity-repository";
import { securityEnrollment } from "@/platform/auth/security-enrollment";

export type AuthorizedIdentityUser = {
  id: string;
  personId: string;
  email: string;
  name: string;
  organizationId: string;
  preferredLocale: AppLocale;
  sessionId: string;
  sessionVersion: number;
  securitySetupRequired: boolean;
};

export type AuthSessionValidation = {
  valid: boolean;
  preferredLocale?: AppLocale;
  securitySetupRequired?: boolean;
};

type AuthAccount = Awaited<ReturnType<typeof findAccountByEmail>>;

export type PasswordMfaChallengeResult =
  | { status: "invalid" }
  | { status: "not_required" }
  | { status: "mfa_required"; challengeToken: string; email: string };

const mfaChallengeTtlMs = 5 * 60 * 1000;

const mfaChallengeSchema = z.object({
  purpose: z.enum(["password-mfa", "passkey-login"]),
  organizationId: z.string().uuid(),
  userAccountId: z.string().uuid(),
  email: z.string().email(),
  deviceId: z.string().min(1),
  sessionVersion: z.number().int().positive(),
  expiresAt: z.number().int(),
  nonce: z.string().uuid()
});

type MfaChallengePayload = z.infer<typeof mfaChallengeSchema>;

function requestIp(headers: Headers): string | null {
  return headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? headers.get("x-real-ip");
}

function userAgent(headers: Headers): string | null {
  return headers.get("user-agent");
}

function requestId(headers: Headers): string {
  return headers.get("x-request-id") ?? crypto.randomUUID();
}

async function findAccountByEmail(email: string) {
  return withTenant(prisma as unknown as TenantTransactionRunner, bootstrapOrganizationId, async (tx) =>
    tx.userAccount.findFirst({
      where: {
        organizationId: bootstrapOrganizationId,
        email,
        status: "ACTIVE"
      },
      include: {
        person: true,
        authCredentials: {
          where: {
            revokedAt: null,
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }]
          }
        },
        roleAssignments: {
          include: {
            role: true
          },
          where: {
            archivedAt: null,
            validFrom: { lte: new Date() },
            OR: [{ validTo: null }, { validTo: { gt: new Date() } }]
          }
        }
      }
    })
  );
}

async function findAccountByPhone(phone: string) {
  return withTenant(prisma as unknown as TenantTransactionRunner, bootstrapOrganizationId, async (tx) =>
    tx.userAccount.findFirst({
      where: {
        organizationId: bootstrapOrganizationId,
        phone,
        status: "ACTIVE"
      },
      include: {
        person: true,
        authCredentials: {
          where: {
            revokedAt: null,
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }]
          }
        },
        roleAssignments: {
          include: {
            role: true
          },
          where: {
            archivedAt: null,
            validFrom: { lte: new Date() },
            OR: [{ validTo: null }, { validTo: { gt: new Date() } }]
          }
        }
      }
    })
  );
}

async function findAccountById(organizationId: string, userAccountId: string) {
  return withTenant(prisma as unknown as TenantTransactionRunner, organizationId, async (tx) =>
    tx.userAccount.findFirst({
      where: {
        id: userAccountId,
        organizationId,
        status: "ACTIVE"
      },
      include: {
        person: true,
        authCredentials: {
          where: {
            revokedAt: null,
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }]
          }
        },
        roleAssignments: {
          include: {
            role: true
          },
          where: {
            archivedAt: null,
            validFrom: { lte: new Date() },
            OR: [{ validTo: null }, { validTo: { gt: new Date() } }]
          }
        }
      }
    })
  );
}

function accountRequiresMfa(account: NonNullable<AuthAccount>): boolean {
  return securityEnrollment(account).secondFactorRequired;
}

async function verifyMfa(account: NonNullable<AuthAccount>, input: {
  mfaCode?: string;
  recoveryCode?: string;
}): Promise<boolean> {
  if (!accountRequiresMfa(account)) {
    return true;
  }

  if (input.mfaCode) {
    for (const totp of account.authCredentials.filter((credential) => credential.type === "TOTP" && credential.expiresAt == null)) {
      if (totp.secretEncrypted && verifyTotpCode(decryptSecret(totp.secretEncrypted), input.mfaCode)) {
        await withTenant(prisma as unknown as TenantTransactionRunner, account.organizationId, async (tx) =>
          tx.authCredential.update({
            where: { id: totp.id },
            data: { lastUsedAt: new Date() }
          })
        );
        return true;
      }
    }
  }

  const recoveryCredentials = account.authCredentials.filter(
    (credential) => credential.type === "RECOVERY_CODE" && credential.expiresAt == null && credential.secretHash
  );

  if (input.recoveryCode) {
    for (const credential of recoveryCredentials) {
      if (credential.secretHash && (await verifyPassword(input.recoveryCode, credential.secretHash))) {
        const consumed = await withTenant(prisma as unknown as TenantTransactionRunner, account.organizationId, async (tx) =>
          tx.authCredential.updateMany({
            where: { id: credential.id, organizationId: account.organizationId, revokedAt: null },
            data: { revokedAt: new Date(), lastUsedAt: new Date() }
          })
        );

        return consumed.count === 1;
      }
    }
  }

  return false;
}

async function passwordMatchesAccount(
  account: NonNullable<AuthAccount>,
  password: string
): Promise<boolean> {
  const passwordCredential = account.authCredentials.find(
    (credential) => credential.type === "PASSWORD" && credential.secretHash
  );
  const legacyHash = account.passwordHash;

  if (!passwordCredential?.secretHash && !legacyHash) {
    return false;
  }

  return passwordCredential?.secretHash
    ? verifyPassword(password, passwordCredential.secretHash)
    : Boolean(legacyHash && (await verifyPassword(password, legacyHash)));
}

async function issueMfaChallenge(
  account: NonNullable<AuthAccount>,
  input: { email: string; deviceId: string; purpose?: MfaChallengePayload["purpose"] }
): Promise<string> {
  const nonce = crypto.randomUUID();
  const expiresAt = Date.now() + mfaChallengeTtlMs;
  const token = encryptSecret(
    JSON.stringify({
      purpose: input.purpose ?? "password-mfa",
      organizationId: account.organizationId,
      userAccountId: account.id,
      email: input.email,
      deviceId: input.deviceId,
      sessionVersion: account.sessionVersion,
      expiresAt,
      nonce
    } satisfies MfaChallengePayload)
  );
  await withTenant(prisma as unknown as TenantTransactionRunner, account.organizationId, async (tx) =>
    tx.authChallenge.create({
      data: {
        organizationId: account.organizationId, userAccountId: account.id,
        type: "PASSWORD_MFA", challenge: nonce, expiresAt: new Date(expiresAt)
      }
    })
  );
  return token;
}

function parseMfaChallenge(token: string): MfaChallengePayload | null {
  try {
    const parsed = mfaChallengeSchema.safeParse(JSON.parse(decryptSecret(token)));

    if (!parsed.success || parsed.data.expiresAt < Date.now()) {
      return null;
    }

    return parsed.data;
  } catch {
    return null;
  }
}

async function createAuthSession(
  account: NonNullable<AuthAccount>,
  input: {
    method: "password" | "pin" | "passkey";
    deviceId: string;
    headers: Headers;
  }
): Promise<string> {
  const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const ipAddress = requestIp(input.headers);
  const userAgentValue = userAgent(input.headers);

  return withTenant(prisma as unknown as TenantTransactionRunner, account.organizationId, async (tx) => {
    if (!await new IdentityRepository(tx, account.organizationId).lockActiveAccount(account.id, account.sessionVersion)) {
      throw new Error("Account changed during authentication");
    }
    const session = await tx.authSession.create({
      data: {
        organizationId: account.organizationId,
        userAccountId: account.id,
        deviceId: input.deviceId,
        sessionVersion: account.sessionVersion,
        userAgent: userAgentValue,
        ipAddress,
        expiresAt
      },
      select: { id: true }
    });

    await tx.authDevice.upsert({
      where: {
        organizationId_userAccountId_deviceId: {
          organizationId: account.organizationId,
          userAccountId: account.id,
          deviceId: input.deviceId
        }
      },
      update: {
        lastSeenAt: new Date(),
        revokedAt: null
      },
      create: {
        organizationId: account.organizationId,
        userAccountId: account.id,
        deviceId: input.deviceId,
        label: "Browser",
        platform: userAgentValue,
        lastSeenAt: new Date()
      }
    });

    await tx.userAccount.update({
      where: { id: account.id },
      data: { lastLoginAt: new Date() }
    });

    await writeAuditEvent(tx, {
      organizationId: account.organizationId,
      actorId: account.id,
      action: "identity.account.login",
      resourceType: "identity",
      resourceId: account.id,
      ipAddress,
      deviceId: input.deviceId,
      after: {
        method: input.method,
        sessionId: session.id,
        userAgent: userAgentValue,
        expiresAt: expiresAt.toISOString()
      },
      reason: "Account access",
      requestId: requestId(input.headers),
      occurredAt: new Date()
    });

    return session.id;
  });
}

function authorizedUser(account: NonNullable<AuthAccount>, sessionId: string): AuthorizedIdentityUser {
  return {
    id: account.id,
    personId: account.personId,
    email: account.email ?? "",
    name: account.person.displayName,
    organizationId: account.organizationId,
    preferredLocale: safeLocale(account.person.preferredLocale),
    sessionId,
    sessionVersion: account.sessionVersion,
    securitySetupRequired: securityEnrollment(account).setupRequired
  };
}

export async function preferredLocaleForLogin(input: {
  email?: string;
  phone?: string;
}, fallback?: AppLocale): Promise<AppLocale> {
  const account = input.email
    ? await findAccountByEmail(input.email.trim().toLowerCase())
    : input.phone
      ? await findAccountByPhone(input.phone.trim().toLowerCase())
      : null;

  return safeLocale(account?.person.preferredLocale ?? fallback);
}

export async function beginPasswordMfaChallenge(input: {
  email: string;
  password: string;
  deviceId: string;
}): Promise<PasswordMfaChallengeResult> {
  const email = input.email.trim().toLowerCase();
  const account = await findAccountByEmail(email);

  if (!account || !(await passwordMatchesAccount(account, input.password))) {
    return { status: "invalid" };
  }

  if (!accountRequiresMfa(account)) {
    return { status: "not_required" };
  }

  return {
    status: "mfa_required",
    email,
    challengeToken: await issueMfaChallenge(account, { email, deviceId: input.deviceId })
  };
}

export async function authenticateMfaChallenge(input: {
  email: string;
  challengeToken: string;
  mfaCode?: string;
  recoveryCode?: string;
  deviceId: string;
  headers: Headers;
}): Promise<AuthorizedIdentityUser | null> {
  const email = input.email.trim().toLowerCase();
  const challenge = parseMfaChallenge(input.challengeToken);

  if (!challenge || challenge.email !== email || challenge.deviceId !== input.deviceId) {
    return null;
  }

  const account = await findAccountById(challenge.organizationId, challenge.userAccountId);

  if (
    !account ||
    account.email !== email ||
    account.sessionVersion !== challenge.sessionVersion ||
    (challenge.purpose === "password-mfa" && !accountRequiresMfa(account)) ||
    !(await verifyMfa(account, input))
  ) {
    return null;
  }

  const consumed = await withTenant(prisma as unknown as TenantTransactionRunner, account.organizationId, async (tx) =>
    tx.authChallenge.updateMany({
      where: {
        organizationId: account.organizationId, userAccountId: account.id,
        type: "PASSWORD_MFA", challenge: challenge.nonce, consumedAt: null,
        expiresAt: { gt: new Date() }
      },
      data: { consumedAt: new Date() }
    })
  );
  if (consumed.count !== 1) return null;

  const sessionId = await createAuthSession(account, { ...input, method: challenge.purpose === "passkey-login" ? "passkey" : "password" });

  return authorizedUser(account, sessionId);
}

export async function authenticatePassword(input: {
  email: string;
  password: string;
  mfaCode?: string;
  recoveryCode?: string;
  deviceId: string;
  headers: Headers;
}): Promise<AuthorizedIdentityUser | null> {
  const account = await findAccountByEmail(input.email);

  if (!account || !(await passwordMatchesAccount(account, input.password))) {
    return null;
  }

  if (!(await verifyMfa(account, input))) {
    return null;
  }

  const sessionId = await createAuthSession(account, { ...input, method: "password" });

  return authorizedUser(account, sessionId);
}

export async function authenticatePin(input: {
  phone: string;
  pin: string;
  deviceId: string;
  headers: Headers;
}): Promise<AuthorizedIdentityUser | null> {
  const phone = input.phone.trim().toLowerCase();
  const account = await withTenant(prisma as unknown as TenantTransactionRunner, bootstrapOrganizationId, async (tx) => {
    const repository = new PinSecurityRepository(tx, bootstrapOrganizationId);
    await repository.lock(phone);
    const now = new Date();
    const policy = await repository.policy(now, async (rule) => {
      await writeAuditEvent(tx, {
        organizationId: bootstrapOrganizationId, actorId: null, action: "config_rule.version.created",
        resourceType: "config_rule", resourceId: rule.id, requestId: requestId(input.headers), occurredAt: now,
        after: { key: rule.key, version: rule.version, value: rule.value },
        reason: "Initialize identity PIN security policy"
      });
    });
    const state = pinLockoutState(await repository.state(phone), policy, now);
    if (state.locked) return null;
    const account = await new IdentityRepository(tx, bootstrapOrganizationId).findActivePinAccount(phone, now);
    const pinCredential = account?.authCredentials.find((credential) => credential.type === "PIN" && credential.secretHash);
    const valid = Boolean(account && !securityEnrollment(account).mandatory && !accountRequiresMfa(account) && pinCredential?.secretHash &&
      await verifyPassword(input.pin, pinCredential.secretHash));
    await repository.save(phone, valid ? 0 : state.failures + 1, now);
    if (!valid && account) await writeAuditEvent(tx, {
      organizationId: account.organizationId, actorId: account.id, action: "identity.pin.login_failed",
      resourceType: "identity", resourceId: account.id, ipAddress: requestIp(input.headers),
      deviceId: input.deviceId, after: { failures: state.failures + 1 },
      reason: "PIN authentication rejected", requestId: requestId(input.headers), occurredAt: now
    });
    return valid ? account : null;
  });
  if (!account) return null;

  const sessionId = await createAuthSession(account, { ...input, method: "pin" });

  return authorizedUser(account, sessionId);
}

export async function beginVerifiedPasskeyLogin(input: {
  email: string; userAccountId: string; sessionVersion: number; deviceId: string;
}): Promise<{ challengeToken: string; mfaRequired: boolean }> {
  const account = await findAccountById(bootstrapOrganizationId, input.userAccountId);
  if (!account || account.email !== input.email.trim().toLowerCase() || account.sessionVersion !== input.sessionVersion) {
    throw new Error("Passkey account is unavailable");
  }
  return {
    challengeToken: await issueMfaChallenge(account, { email: account.email, deviceId: input.deviceId, purpose: "passkey-login" }),
    mfaRequired: accountRequiresMfa(account)
  };
}

export async function validateAuthSession(input: {
  organizationId: string;
  userAccountId: string;
  sessionId: string;
  sessionVersion: number;
}): Promise<AuthSessionValidation> {
  return withTenant(prisma as unknown as TenantTransactionRunner, input.organizationId, async (tx) => {
    const account = await new IdentityRepository(tx, input.organizationId).findSessionSecurityAccount(input.userAccountId);

    if (!account || account.sessionVersion !== input.sessionVersion) {
      return { valid: false };
    }

    const updated = await tx.authSession.updateMany({
      where: {
        id: input.sessionId,
        organizationId: input.organizationId,
        userAccountId: input.userAccountId,
        sessionVersion: input.sessionVersion,
        revokedAt: null,
        expiresAt: { gt: new Date() }
      },
      data: {
        lastSeenAt: new Date()
      }
    });

    return updated.count === 1
      ? { valid: true, preferredLocale: safeLocale(account.person.preferredLocale), securitySetupRequired: securityEnrollment(account).setupRequired }
      : { valid: false };
  }).catch((error: unknown) => {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      return { valid: false };
    }

    throw error;
  });
}
