import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import type { AppLocale } from "@/i18n/routing";

export type IdentityAccountSummary = {
  id: string;
  personId: string;
  displayName: string;
  email: string | null;
  phone: string | null;
  status: string;
  mfaRequired: boolean;
  passkeyCount: number;
  credentials: CredentialSummary[];
  activeSessionCount: number;
  activeDeviceCount: number;
  recentSessions: SessionSummary[];
  devices: DeviceSummary[];
  roles: string[];
  lastLoginAt: Date | null;
};

export type PersonProfileSummary = {
  id: string;
  displayName: string;
  email: string | null;
  phone: string | null;
  preferredLocale: string;
  accountCount: number;
  openInvitationCount: number;
  activeAssignmentCount: number;
};

export type DuplicateContactSummary = {
  contactType: "email" | "phone";
  value: string;
  personIds: string[];
  displayNames: string[];
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

export type DeviceSummary = {
  id: string;
  deviceId: string;
  label: string | null;
  platform: string | null;
  trusted: boolean;
  registeredAt: Date;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
};

export type CredentialSummary = {
  id: string;
  type: string;
  label: string | null;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
};

export type AccountSessionSummary = SessionSummary;

export type RoleCatalogSummary = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissionKeys: string[];
  permissionCount: number;
  assignmentCount: number;
};

export type PermissionCatalogSummary = {
  id: string;
  key: string;
  resource: string;
  action: string;
  description: string | null;
};

export type RoleAssignmentSummary = {
  id: string;
  personId: string;
  userAccountId: string | null;
  displayName: string;
  email: string | null;
  roleId: string;
  roleKey: string;
  roleName: string;
  scopeType: string;
  scopeId: string | null;
  conditions: Prisma.JsonValue | null;
  validFrom: Date;
  validTo: Date | null;
  compensationRef: string | null;
};

type AccountRow = Prisma.UserAccountGetPayload<{
  include: {
    person: true;
    authCredentials: true;
    authSessions: true;
    authDevices: true;
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
  const sessions = [...account.authSessions]
    .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())
    .slice(0, 5)
    .map(sessionToSummary);
  const devices = [...account.authDevices]
    .sort((a, b) => (b.lastSeenAt ?? b.registeredAt).getTime() - (a.lastSeenAt ?? a.registeredAt).getTime())
    .slice(0, 5)
    .map(deviceToSummary);
  const credentials = [...account.authCredentials]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, 8)
    .map(credentialToSummary);

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
    credentials,
    activeSessionCount: account.authSessions.filter(
      (session) => !session.revokedAt && session.expiresAt.getTime() > Date.now()
    ).length,
    activeDeviceCount: account.authDevices.filter((device) => !device.revokedAt).length,
    recentSessions: sessions,
    devices,
    roles: account.roleAssignments
      .filter((assignment) => !assignment.archivedAt && activeNow(assignment.validFrom, assignment.validTo))
      .map((assignment) => assignment.role.key),
    lastLoginAt: account.lastLoginAt
  };
}

function credentialToSummary(credential: AccountRow["authCredentials"][number]): CredentialSummary {
  return {
    id: credential.id,
    type: credential.type,
    label: credential.label,
    lastUsedAt: credential.lastUsedAt,
    expiresAt: credential.expiresAt,
    revokedAt: credential.revokedAt,
    createdAt: credential.createdAt
  };
}

function sessionToSummary(session: AccountRow["authSessions"][number]): SessionSummary {
  return {
    id: session.id,
    deviceId: session.deviceId,
    userAgent: session.userAgent,
    ipAddress: session.ipAddress,
    expiresAt: session.expiresAt,
    revokedAt: session.revokedAt,
    lastSeenAt: session.lastSeenAt
  };
}

function deviceToSummary(device: AccountRow["authDevices"][number]): DeviceSummary {
  return {
    id: device.id,
    deviceId: device.deviceId,
    label: device.label,
    platform: device.platform,
    trusted: device.trusted,
    registeredAt: device.registeredAt,
    lastSeenAt: device.lastSeenAt,
    revokedAt: device.revokedAt
  };
}

function duplicateContacts(people: PersonProfileSummary[]): DuplicateContactSummary[] {
  const groups = new Map<string, PersonProfileSummary[]>();

  for (const person of people) {
    for (const [contactType, value] of [
      ["email", person.email],
      ["phone", person.phone]
    ] as const) {
      if (!value) {
        continue;
      }

      const key = `${contactType}:${value}`;
      groups.set(key, [...(groups.get(key) ?? []), person]);
    }
  }

  return [...groups.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([key, group]) => {
      const [contactType, value] = key.split(":", 2) as ["email" | "phone", string];

      return {
        contactType,
        value,
        personIds: group.map((person) => person.id),
        displayNames: group.map((person) => person.displayName)
      };
    });
}

export class IdentityRepository {
  constructor(
    private readonly tx: TenantTransaction,
    private readonly organizationId: string
  ) {}

  findAccountIdByEmail(email: string) {
    return this.tx.userAccount.findUnique({
      where: { organizationId_email: { organizationId: this.organizationId, email } }, select: { id: true }
    });
  }

  async lockIdentityOperation(key: string): Promise<void> {
    await this.tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${this.organizationId}:${key}`}, 0))`);
  }

  async updateAccountEmail(input: { accountId: string; personId: string; email: string; expectedEmail: string }) {
    await this.lockIdentityOperation(`account-email:${input.email}`);
    await this.tx.$queryRaw(Prisma.sql`SELECT id FROM user_account WHERE organization_id = ${this.organizationId}::uuid AND id = ${input.accountId}::uuid FOR UPDATE`);
    const before = await this.tx.userAccount.findFirst({ where: { organizationId: this.organizationId, id: input.accountId, personId: input.personId, status: "ACTIVE", person: { archivedAt: null } }, select: { id: true, personId: true, email: true } });
    if (!before) throw new Error("Account was not found");
    if (before.email === input.email) return { before, after: before, changed: false };
    if (before.email?.toLowerCase() !== input.expectedEmail) throw new Error("Account contact changed");
    const duplicate = await this.tx.userAccount.findFirst({ where: { organizationId: this.organizationId, id: { not: input.accountId }, email: { equals: input.email, mode: "insensitive" } }, select: { id: true } });
    if (duplicate) throw new Error("Account email already exists");
    const after = await this.tx.userAccount.update({ where: { organizationId: this.organizationId, id: before.id }, data: { email: input.email }, select: { id: true, personId: true, email: true } });
    return { before, after, changed: true };
  }

  findSessionSecurityAccount(id: string, now = new Date()) {
    return this.tx.userAccount.findFirst({
      where: { id, organizationId: this.organizationId, status: "ACTIVE" },
      select: {
        sessionVersion: true, mfaRequired: true,
        person: { select: { preferredLocale: true } },
        authCredentials: { where: { revokedAt: null }, select: { type: true, expiresAt: true, revokedAt: true } },
        roleAssignments: {
          where: { archivedAt: null, validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gt: now } }] },
          select: { role: { select: { key: true } } }
        }
      }
    });
  }

  async confirmTotpCredential(id: string, userAccountId: string, now: Date) {
    const confirmed = await this.tx.authCredential.count({ where: {
      organizationId: this.organizationId, userAccountId, type: "TOTP", revokedAt: null, expiresAt: null
    } });
    await this.tx.authCredential.update({ where: { id }, data: { expiresAt: null, lastUsedAt: now } });
    await this.tx.userAccount.update({ where: { id: userAccountId }, data: {
      mfaRequired: true, ...(confirmed === 0 ? { sessionVersion: { increment: 1 } } : {})
    } });
    const revoked = confirmed === 0 ? await this.tx.authSession.updateMany({
      where: { organizationId: this.organizationId, userAccountId, revokedAt: null }, data: { revokedAt: now }
    }) : { count: 0 };
    return { firstEnrollment: confirmed === 0, revokedSessionCount: revoked.count };
  }

  findActivePinAccount(phone: string, now: Date) {
    return this.tx.userAccount.findFirst({
      where: { organizationId: this.organizationId, phone, status: "ACTIVE" },
      include: {
        person: true,
        authCredentials: { where: { revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } },
        roleAssignments: { include: { role: true }, where: {
          archivedAt: null, validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gt: now } }]
        } }
      }
    });
  }

  async lockActiveAccount(userAccountId: string, sessionVersion: number): Promise<boolean> {
    const rows = await this.tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM user_account
      WHERE organization_id = ${this.organizationId}::uuid AND id = ${userAccountId}::uuid
        AND status = 'ACTIVE' AND session_version = ${sessionVersion}
      FOR UPDATE
    `);
    return rows.length === 1;
  }

  async lockRecoverableAccount(email: string): Promise<boolean> {
    const rows = await this.tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM user_account WHERE organization_id = ${this.organizationId}::uuid
        AND email = ${email} AND status <> 'DEACTIVATED' FOR UPDATE
    `);
    return rows.length === 1;
  }

  async ensurePermission(input: string | {
    key: string;
    resource?: string;
    action?: string;
    description?: string;
  }): Promise<{ id: string }> {
    const key = typeof input === "string" ? input : input.key;
    const [parsedResource, parsedAction] = key.split(":");
    const resource = typeof input === "string" ? parsedResource : input.resource ?? parsedResource;
    const action = typeof input === "string" ? parsedAction : input.action ?? parsedAction;
    const description = typeof input === "string" ? undefined : input.description;

    return this.tx.permission.upsert({
      where: {
        organizationId_key: {
          organizationId: this.organizationId,
          key
        }
      },
      update: {
        resource: resource ?? key,
        action: action ?? "view",
        description
      },
      create: {
        organizationId: this.organizationId,
        key,
        resource: resource ?? key,
        action: action ?? "view",
        description
      },
      select: { id: true }
    });
  }

  async ensureRole(input: {
    key: string;
    name: string;
    description?: string | null;
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
        description: input.description ?? null,
        isSystem: input.isSystem ?? true,
        archivedAt: null
      },
      create: {
        organizationId: this.organizationId,
        key: input.key,
        name: input.name,
        description: input.description ?? null,
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

  async listRoles(): Promise<RoleCatalogSummary[]> {
    const roles = await this.tx.role.findMany({
      where: {
        organizationId: this.organizationId,
        archivedAt: null
      },
      orderBy: [{ isSystem: "desc" }, { name: "asc" }],
      include: {
        rolePermissions: {
          include: {
            permission: true
          }
        },
        roleAssignments: {
          where: { archivedAt: null },
          select: { id: true }
        }
      }
    });

    return roles.map((role) => ({
      id: role.id,
      key: role.key,
      name: role.name,
      description: role.description,
      isSystem: role.isSystem,
      permissionKeys: role.rolePermissions.map((rolePermission) => rolePermission.permission.key).sort(),
      permissionCount: role.rolePermissions.length,
      assignmentCount: role.roleAssignments.length
    }));
  }

  listPermissions(): Promise<PermissionCatalogSummary[]> {
    return this.tx.permission.findMany({
      where: {
        organizationId: this.organizationId
      },
      orderBy: [{ resource: "asc" }, { action: "asc" }],
      select: {
        id: true,
        key: true,
        resource: true,
        action: true,
        description: true
      }
    });
  }

  async createCustomRole(input: {
    key: string;
    name: string;
    description?: string | null;
    permissionKeys: readonly string[];
  }): Promise<RoleCatalogSummary> {
    const role = await this.tx.role.create({
      data: {
        organizationId: this.organizationId,
        key: input.key,
        name: input.name,
        description: input.description ?? null,
        isSystem: false
      },
      select: { id: true }
    });

    await this.replaceRolePermissions(role.id, input.permissionKeys);

    const created = await this.findRoleSummaryById(role.id);

    if (!created) {
      throw new Error("Created role was not found");
    }

    return created;
  }

  async updateCustomRole(input: {
    roleId: string;
    name: string;
    description?: string | null;
    permissionKeys: readonly string[];
  }): Promise<RoleCatalogSummary> {
    const role = await this.tx.role.findFirst({
      where: {
        id: input.roleId,
        organizationId: this.organizationId,
        archivedAt: null
      },
      select: { id: true, isSystem: true }
    });

    if (!role || role.isSystem) {
      throw new Error("Custom role was not found");
    }

    await this.tx.role.update({
      where: { id: input.roleId },
      data: {
        name: input.name,
        description: input.description ?? null
      }
    });
    await this.replaceRolePermissions(input.roleId, input.permissionKeys);

    const updated = await this.findRoleSummaryById(input.roleId);

    if (!updated) {
      throw new Error("Updated role was not found");
    }

    return updated;
  }

  private async replaceRolePermissions(roleId: string, permissionKeys: readonly string[]): Promise<void> {
    const permissions = await this.tx.permission.findMany({
      where: {
        organizationId: this.organizationId,
        key: { in: [...new Set(permissionKeys)] }
      },
      select: { id: true, key: true }
    });

    if (permissions.length !== new Set(permissionKeys).size) {
      throw new Error("Unknown permission");
    }

    await this.tx.rolePermission.deleteMany({
      where: {
        organizationId: this.organizationId,
        roleId,
        permissionId: { notIn: permissions.map((permission) => permission.id) }
      }
    });

    for (const permission of permissions) {
      await this.tx.rolePermission.upsert({
        where: {
          organizationId_roleId_permissionId: {
            organizationId: this.organizationId,
            roleId,
            permissionId: permission.id
          }
        },
        update: {},
        create: {
          organizationId: this.organizationId,
          roleId,
          permissionId: permission.id
        }
      });
    }
  }

  async findRoleSummaryById(roleId: string): Promise<RoleCatalogSummary | null> {
    const role = await this.tx.role.findFirst({
      where: {
        id: roleId,
        organizationId: this.organizationId,
        archivedAt: null
      },
      include: {
        rolePermissions: {
          include: {
            permission: true
          }
        },
        roleAssignments: {
          where: { archivedAt: null },
          select: { id: true }
        }
      }
    });

    return role
      ? {
          id: role.id,
          key: role.key,
          name: role.name,
          description: role.description,
          isSystem: role.isSystem,
          permissionKeys: role.rolePermissions
            .map((rolePermission) => rolePermission.permission.key)
            .sort(),
          permissionCount: role.rolePermissions.length,
          assignmentCount: role.roleAssignments.length
        }
      : null;
  }

  async ensureFieldPolicy(input: {
    resource: string;
    field: string;
    dataClass: string;
    requiredPermission: string;
    mask: string;
  }): Promise<void> {
    await this.tx.fieldPolicy.upsert({
      where: {
        organizationId_resource_field: {
          organizationId: this.organizationId,
          resource: input.resource,
          field: input.field
        }
      },
      update: {
        dataClass: input.dataClass,
        requiredPermission: input.requiredPermission,
        mask: input.mask
      },
      create: {
        organizationId: this.organizationId,
        resource: input.resource,
        field: input.field,
        dataClass: input.dataClass,
        requiredPermission: input.requiredPermission,
        mask: input.mask
      }
    });
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
    conditions?: Prisma.InputJsonValue | null;
    validFrom?: Date;
    validTo?: Date | null;
    compensationRef?: string | null;
    actorId?: string | null;
  }): Promise<{ id: string; created: boolean }> {
    const existing = await this.tx.roleAssignment.findFirst({
      where: {
        organizationId: this.organizationId,
        personId: input.personId,
        userAccountId: input.userAccountId ?? null,
        roleId: input.roleId,
        scopeType: input.scopeType,
        scopeId: input.scopeId ?? null,
        validTo: input.validTo ?? null,
        archivedAt: null
      },
      select: { id: true }
    });

    if (existing) {
      return { id: existing.id, created: false };
    }

    const created = await this.tx.roleAssignment.create({
      data: {
        organizationId: this.organizationId,
        personId: input.personId,
        userAccountId: input.userAccountId ?? null,
        roleId: input.roleId,
        scopeType: input.scopeType,
        scopeId: input.scopeId ?? null,
        conditions: input.conditions ?? undefined,
        validFrom: input.validFrom ?? undefined,
        validTo: input.validTo ?? null,
        compensationRef: input.compensationRef ?? null,
        createdBy: input.actorId ?? null
      },
      select: { id: true }
    });

    return { id: created.id, created: true };
  }

  async assignRoleToAccount(input: {
    userAccountId: string;
    roleId: string;
    scopeType: string;
    scopeId?: string | null;
    conditions?: Prisma.InputJsonValue | null;
    validFrom?: Date;
    validTo?: Date | null;
    compensationRef?: string | null;
    actorId?: string | null;
  }): Promise<{ id: string; created: boolean }> {
    const account = await this.tx.userAccount.findFirst({
      where: {
        id: input.userAccountId,
        organizationId: this.organizationId
      },
      select: {
        id: true,
        personId: true
      }
    });

    if (!account) {
      throw new Error("Account was not found");
    }

    return this.assignRole({
      personId: account.personId,
      userAccountId: account.id,
      roleId: input.roleId,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      conditions: input.conditions,
      validFrom: input.validFrom,
      validTo: input.validTo,
      compensationRef: input.compensationRef,
      actorId: input.actorId
    });
  }

  async listRoleAssignments(): Promise<RoleAssignmentSummary[]> {
    const assignments = await this.tx.roleAssignment.findMany({
      where: {
        organizationId: this.organizationId,
        archivedAt: null
      },
      orderBy: [{ createdAt: "desc" }],
      take: 100,
      include: {
        person: true,
        userAccount: true,
        role: true
      }
    });

    return assignments.map((assignment) => ({
      id: assignment.id,
      personId: assignment.personId,
      userAccountId: assignment.userAccountId,
      displayName: assignment.person.displayName,
      email: assignment.userAccount?.email ?? assignment.person.email,
      roleId: assignment.roleId,
      roleKey: assignment.role.key,
      roleName: assignment.role.name,
      scopeType: assignment.scopeType,
      scopeId: assignment.scopeId,
      conditions: assignment.conditions,
      validFrom: assignment.validFrom,
      validTo: assignment.validTo,
      compensationRef: assignment.compensationRef
    }));
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
          authDevices: true,
          roleAssignments: {
            include: {
              role: true
            }
          }
        }
      })
      .then((accounts) => accounts.map(accountToSummary));
  }

  async listPeople(): Promise<PersonProfileSummary[]> {
    const people = await this.tx.person.findMany({
      where: {
        organizationId: this.organizationId,
        archivedAt: null
      },
      orderBy: [{ updatedAt: "desc" }],
      take: 150,
      include: {
        userAccounts: {
          select: { id: true }
        },
        invitations: {
          where: {
            acceptedAt: null,
            revokedAt: null
          },
          select: { id: true }
        },
        roleAssignments: {
          where: {
            archivedAt: null,
            validFrom: { lte: new Date() },
            OR: [{ validTo: null }, { validTo: { gt: new Date() } }]
          },
          select: { id: true }
        }
      }
    });

    return people.map((person) => ({
      id: person.id,
      displayName: person.displayName,
      email: person.email,
      phone: person.phone,
      preferredLocale: person.preferredLocale,
      accountCount: person.userAccounts.length,
      openInvitationCount: person.invitations.length,
      activeAssignmentCount: person.roleAssignments.length
    }));
  }

  async listDuplicateContacts(): Promise<DuplicateContactSummary[]> {
    return duplicateContacts(await this.listPeople());
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
    preferredLocale?: AppLocale;
  }): Promise<{ id: string; preferredLocale: string }> {
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
          phone: input.phone ?? undefined,
          preferredLocale: input.preferredLocale
        },
        create: {
          organizationId: this.organizationId,
          displayName: input.displayName,
          email: input.email,
          phone: input.phone ?? null,
          preferredLocale: input.preferredLocale ?? "en"
        },
        select: { id: true, preferredLocale: true }
      });
    }

    return this.tx.person.create({
      data: {
        organizationId: this.organizationId,
        displayName: input.displayName,
        phone: input.phone ?? null,
        preferredLocale: input.preferredLocale ?? "en"
      },
      select: { id: true, preferredLocale: true }
    });
  }

  findRecoveryDeliveryAccount(id: string) {
    return this.tx.userAccount.findFirst({
      where: { id, organizationId: this.organizationId },
      include: { person: { select: { preferredLocale: true } } }
    });
  }

  createStandalonePerson(input: {
    displayName: string;
    email?: string | null;
    phone?: string | null;
    preferredLocale: string;
  }): Promise<PersonProfileSummary> {
    return this.tx.person
      .create({
        data: {
          organizationId: this.organizationId,
          displayName: input.displayName,
          email: input.email ?? null,
          phone: input.phone ?? null,
          preferredLocale: input.preferredLocale
        },
        include: {
          userAccounts: { select: { id: true } },
          invitations: { select: { id: true } },
          roleAssignments: { select: { id: true } }
        }
      })
      .then((person) => ({
        id: person.id,
        displayName: person.displayName,
        email: person.email,
        phone: person.phone,
        preferredLocale: person.preferredLocale,
        accountCount: person.userAccounts.length,
        openInvitationCount: person.invitations.length,
        activeAssignmentCount: person.roleAssignments.length
      }));
  }

  async updatePersonProfile(input: {
    personId: string;
    displayName: string;
    email?: string | null;
    phone?: string | null;
    preferredLocale: string;
  }): Promise<{
    before: PersonProfileSummary;
    after: PersonProfileSummary;
  }> {
    const before = await this.tx.person.findFirst({
      where: {
        id: input.personId,
        organizationId: this.organizationId,
        archivedAt: null
      },
      include: {
        userAccounts: { select: { id: true } },
        invitations: {
          where: {
            acceptedAt: null,
            revokedAt: null
          },
          select: { id: true }
        },
        roleAssignments: {
          where: { archivedAt: null },
          select: { id: true }
        }
      }
    });

    if (!before) {
      throw new Error("Person was not found");
    }

    const after = await this.tx.person.update({
      where: { id: input.personId },
      data: {
        displayName: input.displayName,
        email: input.email ?? null,
        phone: input.phone ?? null,
        preferredLocale: input.preferredLocale
      },
      include: {
        userAccounts: { select: { id: true } },
        invitations: {
          where: {
            acceptedAt: null,
            revokedAt: null
          },
          select: { id: true }
        },
        roleAssignments: {
          where: { archivedAt: null },
          select: { id: true }
        }
      }
    });

    const toSummary = (person: typeof before): PersonProfileSummary => ({
      id: person.id,
      displayName: person.displayName,
      email: person.email,
      phone: person.phone,
      preferredLocale: person.preferredLocale,
      accountCount: person.userAccounts.length,
      openInvitationCount: person.invitations.length,
      activeAssignmentCount: person.roleAssignments.length
    });

    return {
      before: toSummary(before),
      after: toSummary(after)
    };
  }

  async updatePersonPreferredLocale(
    personId: string,
    preferredLocale: string
  ): Promise<{ id: string; before: string; after: string }> {
    const person = await this.tx.person.findFirst({
      where: {
        id: personId,
        organizationId: this.organizationId
      },
      select: {
        id: true,
        preferredLocale: true
      }
    });

    if (!person) {
      throw new Error("Person was not found");
    }

    if (person.preferredLocale === preferredLocale) {
      return {
        id: person.id,
        before: person.preferredLocale,
        after: person.preferredLocale
      };
    }

    const updated = await this.tx.person.update({
      where: { id: person.id },
      data: { preferredLocale },
      select: {
        id: true,
        preferredLocale: true
      }
    });

    return {
      id: updated.id,
      before: person.preferredLocale,
      after: updated.preferredLocale
    };
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
