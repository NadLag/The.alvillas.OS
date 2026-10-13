import { Prisma } from "@prisma/client";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { bootstrapOrganizationId } from "@/platform/identity/bootstrap";
import { decryptSecret } from "@/platform/auth/secret-encryption";
import { verifyPassword } from "@/platform/auth/password";
import { verifyTotpCode } from "@/platform/auth/totp";
import { safeLocale, type AppLocale } from "@/i18n/routing";

export type AuthorizedIdentityUser = {
  id: string;
  personId: string;
  email: string;
  name: string;
  organizationId: string;
  preferredLocale: AppLocale;
  sessionId: string;
  sessionVersion: number;
};

export type AuthSessionValidation = {
  valid: boolean;
  preferredLocale?: AppLocale;
};

type AuthAccount = Awaited<ReturnType<typeof findAccountByEmail>>;

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

function accountRequiresMfa(account: NonNullable<AuthAccount>): boolean {
  const hasMfaCredential = account.authCredentials.some(
    (credential) => credential.type === "TOTP" || credential.type === "RECOVERY_CODE"
  );

  return (
    account.mfaRequired ||
    (hasMfaCredential &&
      account.roleAssignments.some((assignment) =>
        assignment.role.key === "admin" || assignment.role.key === "finance"
      ))
  );
}

async function verifyMfa(account: NonNullable<AuthAccount>, input: {
  mfaCode?: string;
  recoveryCode?: string;
}): Promise<boolean> {
  if (!accountRequiresMfa(account)) {
    return true;
  }

  const totp = account.authCredentials.find((credential) => credential.type === "TOTP");

  if (totp?.secretEncrypted && input.mfaCode) {
    if (verifyTotpCode(decryptSecret(totp.secretEncrypted), input.mfaCode)) {
      await withTenant(prisma as unknown as TenantTransactionRunner, account.organizationId, async (tx) =>
        tx.authCredential.update({
          where: { id: totp.id },
          data: { lastUsedAt: new Date() }
        })
      );

      return true;
    }
  }

  const recoveryCredentials = account.authCredentials.filter(
    (credential) => credential.type === "RECOVERY_CODE" && credential.secretHash
  );

  if (input.recoveryCode) {
    for (const credential of recoveryCredentials) {
      if (credential.secretHash && (await verifyPassword(input.recoveryCode, credential.secretHash))) {
        await withTenant(prisma as unknown as TenantTransactionRunner, account.organizationId, async (tx) =>
          tx.authCredential.update({
            where: { id: credential.id },
            data: { revokedAt: new Date(), lastUsedAt: new Date() }
          })
        );

        return true;
      }
    }
  }

  return false;
}

async function createAuthSession(
  account: NonNullable<AuthAccount>,
  input: {
    method: "password" | "pin";
    deviceId: string;
    headers: Headers;
  }
): Promise<string> {
  const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const ipAddress = requestIp(input.headers);
  const userAgentValue = userAgent(input.headers);

  return withTenant(prisma as unknown as TenantTransactionRunner, account.organizationId, async (tx) => {
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
    sessionVersion: account.sessionVersion
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

export async function authenticatePassword(input: {
  email: string;
  password: string;
  mfaCode?: string;
  recoveryCode?: string;
  deviceId: string;
  headers: Headers;
}): Promise<AuthorizedIdentityUser | null> {
  const account = await findAccountByEmail(input.email);
  const passwordCredential = account?.authCredentials.find(
    (credential) => credential.type === "PASSWORD" && credential.secretHash
  );
  const legacyHash = account?.passwordHash;

  if (!account || (!passwordCredential?.secretHash && !legacyHash)) {
    return null;
  }

  const passwordMatches = passwordCredential?.secretHash
    ? await verifyPassword(input.password, passwordCredential.secretHash)
    : Boolean(legacyHash && (await verifyPassword(input.password, legacyHash)));

  if (!passwordMatches || !(await verifyMfa(account, input))) {
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
  const account = await findAccountByPhone(input.phone);
  const pinCredential = account?.authCredentials.find(
    (credential) => credential.type === "PIN" && credential.secretHash
  );

  if (!account || !pinCredential?.secretHash) {
    return null;
  }

  if (!(await verifyPassword(input.pin, pinCredential.secretHash))) {
    return null;
  }

  const sessionId = await createAuthSession(account, { ...input, method: "pin" });

  return authorizedUser(account, sessionId);
}

export async function validateAuthSession(input: {
  organizationId: string;
  userAccountId: string;
  sessionId: string;
  sessionVersion: number;
}): Promise<AuthSessionValidation> {
  return withTenant(prisma as unknown as TenantTransactionRunner, input.organizationId, async (tx) => {
    const account = await tx.userAccount.findFirst({
      where: {
        id: input.userAccountId,
        organizationId: input.organizationId,
        status: "ACTIVE"
      },
      select: {
        sessionVersion: true,
        person: {
          select: {
            preferredLocale: true
          }
        }
      }
    });

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
      ? { valid: true, preferredLocale: safeLocale(account.person.preferredLocale) }
      : { valid: false };
  }).catch((error: unknown) => {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      return { valid: false };
    }

    throw error;
  });
}
