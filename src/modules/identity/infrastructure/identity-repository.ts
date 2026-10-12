import type { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";

export type IdentityAccountSummary = {
  id: string;
  personId: string;
  displayName: string;
  email: string | null;
  phone: string | null;
  status: string;
  mfaRequired: boolean;
  passkeyCount: number;
  activeSessionCount: number;
  roles: string[];
  lastLoginAt: Date | null;
};

export type InvitationSummary = {
  id: string;
  personName: string;
  email: string | null;
  phone: string | null;
  roleKey: string;
  scopeType: string;
  code: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
};

export type SessionSummary = {
  id: string;
  deviceId: string;
  userAgent: string | null;
  ipAddress: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  lastSeenAt: Date;
};

type AccountRow = Prisma.UserAccountGetPayload<{
  include: {
    person: true;
    authCredentials: true;
    authSessions: true;
    roleAssignments: {
      include: {
        role: true;
      };
    };
  };
}>;

function activeNow(validFrom: Date, validTo: Date | null): boolean {
  const now = Date.now();

  return validFrom.getTime() <= now && (!validTo || validTo.getTime() > now);
}

function accountToSummary(account: AccountRow): IdentityAccountSummary {
  return {
    id: account.id,
    personId: account.personId,
    displayName: account.person.displayName,
    email: account.email,
    phone: account.phone,
    status: account.status,
    mfaRequired: account.mfaRequired,
    passkeyCount: account.authCredentials.filter(
      (credential) => credential.type === "PASSKEY" && !credential.revokedAt
    ).length,
    activeSessionCount: account.authSessions.filter(
      (session) => !session.revokedAt && session.expiresAt.getTime() > Date.now()
    ).length,
    roles: account.roleAssignments
      .filter((assignment) => !assignment.archivedAt && activeNow(assignment.validFrom, assignment.validTo))
      .map((assignment) => assignment.role.key),
    lastLoginAt: account.lastLoginAt
  };
}

export class IdentityRepository {
  constructor(
    private readonly tx: TenantTransaction,
    private readonly organizationId: string
  ) {}

  async ensurePermission(key: string): Promise<{ id: string }> {
    const [resource, action] = key.split(":");

    return this.tx.permission.upsert({
      where: {
        organizationId_key: {
          organizationId: this.organizationId,
          key
        }
      },
      update: {
        resource: resource ?? key,
        action: action ?? "view"
      },
      create: {
        organizationId: this.organizationId,
        key,
        resource: resource ?? key,
        action: action ?? "view"
      },
      select: { id: true }
    });
  }

  async ensureRole(input: {
    key: string;
    name: string;
    permissions: readonly string[];
    isSystem?: boolean;
  }): Promise<{ id: string }> {
    const role = await this.tx.role.upsert({
      where: {
        organizationId_key: {
          organizationId: this.organizationId,
          key: input.key
        }
      },
      update: {
        name: input.name,
        isSystem: input.isSystem ?? true,
        archivedAt: null
      },
      create: {
        organizationId: this.organizationId,
        key: input.key,
        name: input.name,
        isSystem: input.isSystem ?? true
      },
      select: { id: true }
    });

    for (const permissionKey of input.permissions) {
      const permission = await this.ensurePermission(permissionKey);
      await this.tx.rolePermission.upsert({
        where: {
          organizationId_roleId_permissionId: {
            organizationId: this.organizationId,
            roleId: role.id,
            permissionId: permission.id
          }
        },
        update: {},
        create: {
          organizationId: this.organizationId,
          roleId: role.id,
          permissionId: permission.id
        }
      });
    }

    return role;
  }

  findRoleByKey(key: string): Promise<{ id: string; key: string } | null> {
    return this.tx.role.findFirst({
      where: {
        organizationId: this.organizationId,
        key,
        archivedAt: null
      },
      select: { id: true, key: true }
    });
  }

  async assignRole(input: {
    personId: string;
    userAccountId?: string | null;
    roleId: string;
    scopeType: string;
    scopeId?: string | null;
    actorId?: string | null;
  }): Promise<void> {
    const existing = await this.tx.roleAssignment.findFirst({
      where: {
        organizationId: this.organizationId,
        personId: input.personId,
        userAccountId: input.userAccountId ?? null,
        roleId: input.roleId,
        scopeType: input.scopeType,
        scopeId: input.scopeId ?? null,
        archivedAt: null
      },
      select: { id: true }
    });

    if (existing) {
      return;
    }

    await this.tx.roleAssignment.create({
      data: {
        organizationId: this.organizationId,
        personId: input.personId,
        userAccountId: input.userAccountId ?? null,
        roleId: input.roleId,
        scopeType: input.scopeType,
        scopeId: input.scopeId ?? null,
        createdBy: input.actorId ?? null
      }
    });
  }

  listAccounts(): Promise<IdentityAccountSummary[]> {
    return this.tx.userAccount
      .findMany({
        where: {
          organizationId: this.organizationId
        },
        orderBy: [{ createdAt: "desc" }],
        take: 100,
        include: {
          person: true,
          authCredentials: true,
          authSessions: true,
          roleAssignments: {
            include: {
              role: true
            }
          }
        }
      })
      .then((accounts) => accounts.map(accountToSummary));
  }

  listSessions(userAccountId: string): Promise<SessionSummary[]> {
    return this.tx.authSession.findMany({
      where: {
        organizationId: this.organizationId,
        userAccountId
      },
      orderBy: [{ lastSeenAt: "desc" }],
      take: 20
    });
  }

  async createPerson(input: {
    displayName: string;
    email?: string | null;
    phone?: string | null;
  }): Promise<{ id: string }> {
    if (input.email) {
      return this.tx.person.upsert({
        where: {
          organizationId_email: {
            organizationId: this.organizationId,
            email: input.email
          }
        },
        update: {
          displayName: input.displayName,
          phone: input.phone ?? undefined
        },
        create: {
          organizationId: this.organizationId,
          displayName: input.displayName,
          email: input.email,
          phone: input.phone ?? null,
          preferredLocale: "en"
        },
        select: { id: true }
      });
    }

    return this.tx.person.create({
      data: {
        organizationId: this.organizationId,
        displayName: input.displayName,
        phone: input.phone ?? null,
        preferredLocale: "en"
      },
      select: { id: true }
    });
  }

  createInvitation(input: {
    personId: string;
    roleId: string;
    scopeType: string;
    scopeId?: string | null;
    email?: string | null;
    phone?: string | null;
    codeHash: string;
    expiresAt: Date;
    actorId: string;
  }): Promise<{ id: string }> {
    return this.tx.invitation.create({
      data: {
        organizationId: this.organizationId,
        personId: input.personId,
        roleId: input.roleId,
        scopeType: input.scopeType,
        scopeId: input.scopeId ?? null,
        email: input.email ?? null,
        phone: input.phone ?? null,
        codeHash: input.codeHash,
        expiresAt: input.expiresAt,
        createdBy: input.actorId
      },
      select: { id: true }
    });
  }

  async listOpenInvitations(codeByInvitationId: ReadonlyMap<string, string>): Promise<InvitationSummary[]> {
    const invitations = await this.tx.invitation.findMany({
      where: {
        organizationId: this.organizationId,
        acceptedAt: null,
        revokedAt: null
      },
      include: {
        person: true,
        role: true
      },
      orderBy: [{ createdAt: "desc" }],
      take: 25
    });

    return invitations.map((invitation) => ({
      id: invitation.id,
      personName: invitation.person.displayName,
      email: invitation.email,
      phone: invitation.phone,
      roleKey: invitation.role.key,
      scopeType: invitation.scopeType,
      code: codeByInvitationId.get(invitation.id) ?? "",
      expiresAt: invitation.expiresAt,
      acceptedAt: invitation.acceptedAt,
      revokedAt: invitation.revokedAt
    }));
  }
}
