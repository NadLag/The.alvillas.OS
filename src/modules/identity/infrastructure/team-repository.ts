import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import { authorize, type AuthContext, type Resource } from "@/platform/authz/authorize";
import { Money } from "@/platform/money/money";
import initialPolicy from "@/platform/config/defaults/staff-management.json" with { type: "json" };
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { teamPolicyKey } from "../domain/team";

export class TeamRepository {
  constructor(
    readonly tx: TenantTransaction,
    readonly organizationId: string
  ) {}
  async initializePolicy() {
    const config = new ConfigRuleRepository(this.tx, this.organizationId);
    await config.lockVersion(teamPolicyKey, "organization");
    if (
      !(await config.list({ key: teamPolicyKey, scopeType: "organization", scopeId: null, take: 1 }))
        .length
    ) {
      await config.createVersion({
        key: teamPolicyKey,
        scopeType: "organization",
        value: initialPolicy,
        effectiveFrom: new Date(0),
        reason: "Initialize configurable staff document policy"
      });
    }
  }
  async clock() {
    const [row] = await this.tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`SELECT clock_timestamp() AS now`);
    return row.now;
  }
  async flushGuards() {
    await this.tx.$executeRaw(Prisma.sql`SET CONSTRAINTS ALL IMMEDIATE`);
  }
  compensationFor(assignments: string[]) {
    return this.tx.teamCompensation.findMany({
      where: { organizationId: this.organizationId, assignmentId: { in: assignments } },
      orderBy: [{ assignmentId: "asc" }, { version: "desc" }]
    });
  }
  properties() {
    return this.tx.property.findMany({
      where: { organizationId: this.organizationId, archivedAt: null },
      select: { id: true, name: true },
      take: 1000
    });
  }
  regions() {
    return this.tx.region.findMany({
      where: { organizationId: this.organizationId, archivedAt: null },
      select: { id: true, name: true },
      take: 1000
    });
  }
  cities() {
    return this.tx.city.findMany({
      where: { organizationId: this.organizationId, archivedAt: null },
      select: { id: true, name: true },
      take: 1000
    });
  }
  organization() {
    return this.tx.organization.findUniqueOrThrow({
      where: { id: this.organizationId },
      select: { baseCurrency: true }
    });
  }
  walletAccounts() {
    return this.tx.ledgerAccount.findMany({
      where: {
        organizationId: this.organizationId,
        archivedAt: null,
        accountType: "STAFF_WALLET",
        teamWallet: null
      },
      select: { id: true, name: true, code: true },
      orderBy: { code: "asc" },
      take: 1000
    });
  }
  document(id: string) {
    return this.tx.teamDocument.findFirst({
      where: { id, organizationId: this.organizationId, archivedAt: null, confirmedAt: { not: null } }
    });
  }
  createDocument(data: Omit<Prisma.TeamDocumentUncheckedCreateInput, "organizationId">) {
    return this.tx.teamDocument.create({ data: { ...data, organizationId: this.organizationId } });
  }
  archiveDocument(id: string) {
    return this.tx.teamDocument.update({
      where: { id, organizationId: this.organizationId },
      data: { archivedAt: new Date() }
    });
  }
  dueDocuments(until: Date, cursor?: string) {
    return this.tx.teamDocument.findMany({
      where: {
        organizationId: this.organizationId,
        ...(cursor ? { id: { gt: cursor } } : {}),
        archivedAt: null,
        confirmedAt: { not: null },
        expiresOn: { lte: until },
        person: { archivedAt: null }
      },
      take: 100,
      orderBy: { id: "asc" }
    });
  }
  archiveAssignment(id: string) {
    return this.tx.roleAssignment.update({
      where: { id, organizationId: this.organizationId },
      data: { archivedAt: new Date() }
    });
  }
  currency(code: string) {
    return this.tx.currency.findUnique({ where: { code } });
  }
  createCompensation(data: Omit<Prisma.TeamCompensationUncheckedCreateInput, "organizationId">) {
    return this.tx.teamCompensation.create({ data: { ...data, organizationId: this.organizationId } });
  }
  createAvailability(data: Omit<Prisma.TeamAvailabilityUncheckedCreateInput, "organizationId">) {
    return this.tx.teamAvailability.create({ data: { ...data, organizationId: this.organizationId } });
  }
  findAvailability(id: string) {
    return this.tx.teamAvailability.findFirst({ where: { id, organizationId: this.organizationId } });
  }
  decideAvailability(id: string, status: string, actorId: string) {
    return this.tx.teamAvailability.update({
      where: { id, organizationId: this.organizationId },
      data: { status, decidedBy: actorId }
    });
  }
  ledgerAccount(id: string) {
    return this.tx.ledgerAccount.findFirst({
      where: { organizationId: this.organizationId, id, archivedAt: null, accountType: "STAFF_WALLET" }
    });
  }
  linkWallet(personId: string, ledgerAccountId: string, actorId: string) {
    return this.tx.teamWallet.create({
      data: { organizationId: this.organizationId, personId, ledgerAccountId, createdBy: actorId }
    });
  }
  async archivePerson(personId: string) {
    await this.tx.roleAssignment.updateMany({
      where: { organizationId: this.organizationId, personId, archivedAt: null },
      data: { archivedAt: new Date() }
    });
    return this.tx.person.update({
      where: { id: personId, organizationId: this.organizationId },
      data: { archivedAt: new Date() }
    });
  }
  async lock(personId: string) {
    await this.tx.$queryRaw(
      Prisma.sql`SELECT id FROM person WHERE organization_id=${this.organizationId}::uuid AND id=${personId}::uuid FOR UPDATE`
    );
  }
  async person(id: string) {
    const person = await this.tx.person.findFirst({
      where: { organizationId: this.organizationId, id },
      include: {
        userAccounts: { select: { id: true, status: true } },
        roleAssignments: {
          include: { role: { include: { rolePermissions: { include: { permission: true } } } } }
        }
      }
    });
    if (!person) return null;
    const [properties, cities] = await Promise.all([
      this.tx.property.findMany({
        where: {
          organizationId: this.organizationId,
          id: {
            in: person.roleAssignments
              .filter((a) => a.scopeType === "property")
              .flatMap((a) => (a.scopeId ? [a.scopeId] : []))
          }
        },
        select: { id: true, regionId: true, cityId: true }
      }),
      this.tx.city.findMany({
        where: {
          organizationId: this.organizationId,
          id: {
            in: person.roleAssignments
              .filter((a) => a.scopeType === "city")
              .flatMap((a) => (a.scopeId ? [a.scopeId] : []))
          }
        },
        select: { id: true, regionId: true }
      })
    ]);
    return {
      ...person,
      roleAssignments: person.roleAssignments.map((a) => ({
        ...a,
        regionId:
          properties.find((p) => p.id === a.scopeId)?.regionId ??
          cities.find((c) => c.id === a.scopeId)?.regionId ??
          null,
        cityId: properties.find((p) => p.id === a.scopeId)?.cityId ?? null
      }))
    };
  }
  resource(person: { id: string }, type = "team_member"): Resource {
    return { type, id: person.id, organizationId: this.organizationId, assignedPersonId: person.id };
  }
  async visiblePeople(ctx: AuthContext, search: string, page: number) {
    // Scope the SQL query before pagination. Property/city/region grants reach only
    // people with an assignment in that scope, never the entire tenant directory.
    const grants = (
      ctx.assignments ?? ctx.scopes.map((scope) => ({ scope, permissions: ctx.permissions }))
    ).filter((a) => a.permissions.has("team_member:view"));
    const filters: Prisma.PersonWhereInput[] = [];
    const geographicIds = grants
      .filter((a) => a.scope.scopeType === "city" || a.scope.scopeType === "region")
      .flatMap((a) => (a.scope.scopeId ? [a.scope.scopeId] : []));
    const properties = geographicIds.length
      ? await this.tx.property.findMany({
          where: {
            organizationId: this.organizationId,
            OR: [{ regionId: { in: geographicIds } }, { cityId: { in: geographicIds } }]
          },
          select: { id: true, regionId: true, cityId: true }
        })
      : [];
    const cities = geographicIds.length
      ? await this.tx.city.findMany({
          where: { organizationId: this.organizationId, regionId: { in: geographicIds } },
          select: { id: true, regionId: true }
        })
      : [];
    for (const a of grants) {
      const scope = a.scope;
      if (scope.organizationId !== this.organizationId) continue;
      if ("validFrom" in a && a.validFrom && a.validFrom > new Date()) continue;
      if ("validTo" in a && a.validTo && a.validTo <= new Date()) continue;
      if ("conditions" in a && a.conditions) {
        if (
          a.conditions.statuses?.length ||
          a.conditions.maxAmount !== undefined ||
          a.conditions.timeWindow
        )
          continue;
        if (a.conditions.assignedToMe) {
          if (ctx.personId) filters.push({ id: ctx.personId });
          continue;
        }
      }
      if (
        !scope.resourceId &&
        !scope.scopeId &&
        (!scope.scopeType || scope.scopeType === "organization")
      ) {
        filters.push({});
        continue;
      }
      if (scope.resourceType === "team_member") {
        filters.push({ id: scope.resourceId });
        continue;
      }
      if (scope.scopeType && scope.scopeId)
        filters.push({
          roleAssignments: {
            some: {
              organizationId: this.organizationId,
              AND: [
                {
                  OR: [
                    { scopeType: scope.scopeType, scopeId: scope.scopeId },
                    {
                      scopeType: "property",
                      scopeId: {
                        in: properties
                          .filter((p) => p.regionId === scope.scopeId || p.cityId === scope.scopeId)
                          .map((p) => p.id)
                      }
                    },
                    {
                      scopeType: "city",
                      scopeId: {
                        in: cities.filter((c) => c.regionId === scope.scopeId).map((c) => c.id)
                      }
                    }
                  ]
                }
              ],
              archivedAt: null,
              validFrom: { lte: new Date() },
              OR: [{ validTo: null }, { validTo: { gt: new Date() } }]
            }
          }
        });
    }
    if (!filters.length) return { people: [], total: 0 };
    const where: Prisma.PersonWhereInput = {
      organizationId: this.organizationId,
      AND: [
        { OR: filters },
        ...(search ? [{ displayName: { contains: search, mode: "insensitive" as const } }] : [])
      ]
    };
    const [people, total] = await Promise.all([
      this.tx.person.findMany({
        where,
        orderBy: [{ displayName: "asc" }, { id: "asc" }],
        skip: (page - 1) * 25,
        take: 25,
        include: {
          roleAssignments: { where: { archivedAt: null }, select: { scopeType: true, scopeId: true } }
        }
      }),
      this.tx.person.count({ where })
    ]);
    return {
      people: people.filter((person) =>
        this.can(ctx, "view", {
          ...person,
          roleAssignments: person.roleAssignments.map((a) => ({
            ...a,
            regionId:
              properties.find((p) => p.id === a.scopeId)?.regionId ??
              cities.find((c) => c.id === a.scopeId)?.regionId,
            cityId: properties.find((p) => p.id === a.scopeId)?.cityId
          }))
        })
      ),
      total
    };
  }
  can(
    ctx: AuthContext,
    action: Parameters<typeof authorize>[1],
    person: {
      id: string;
      roleAssignments?: {
        scopeType: string;
        scopeId: string | null;
        regionId?: string | null;
        cityId?: string | null;
      }[];
    },
    type = "team_member"
  ) {
    const resource = this.resource(person, type);
    return (
      authorize(ctx, action, resource) ||
      (person.roleAssignments ?? []).some((a) =>
        authorize(ctx, action, {
          ...resource,
          region: a.regionId,
          city: a.cityId,
          ...(a.scopeType === "property"
            ? { propertyId: a.scopeId }
            : a.scopeType === "city"
              ? { city: a.scopeId }
              : a.scopeType === "region"
                ? { region: a.scopeId }
                : a.scopeType === "job"
                  ? { jobId: a.scopeId }
                  : {})
        })
      )
    );
  }
  async scopeExists(type: string, id: string | null) {
    if (type === "organization") return id === null;
    const where = { id: id ?? "", organizationId: this.organizationId, archivedAt: null };
    switch (type) {
      case "property":
        return Boolean(await this.tx.property.findFirst({ where, select: { id: true } }));
      case "region":
        return Boolean(await this.tx.region.findFirst({ where, select: { id: true } }));
      case "city":
        return Boolean(await this.tx.city.findFirst({ where, select: { id: true } }));
      case "job":
        return Boolean(await this.tx.operationTask.findFirst({ where, select: { id: true } }));
      default:
        return false;
    }
  }
  assignment(id: string) {
    return this.tx.roleAssignment.findFirst({
      where: { id, organizationId: this.organizationId },
      include: { person: true }
    });
  }
  compensation(assignmentId: string) {
    return this.tx.teamCompensation.findMany({
      where: { organizationId: this.organizationId, assignmentId },
      orderBy: { version: "desc" }
    });
  }
  availability(personId: string) {
    return this.tx.teamAvailability.findMany({
      where: { organizationId: this.organizationId, personId },
      orderBy: [{ startsOn: "desc" }, { id: "desc" }],
      take: 100
    });
  }
  async tasks(personId: string, from: Date, until: Date, ctx: AuthContext) {
    const accounts = await this.tx.userAccount.findMany({
      where: { organizationId: this.organizationId, personId },
      select: { id: true }
    });
    const grants =
      ctx.assignments ?? ctx.scopes.map((scope) => ({ scope, permissions: ctx.permissions }));
    const filters: Prisma.OperationTaskWhereInput[] = [];
    for (const grant of grants) {
      if (!grant.permissions.has("task:view")) continue;
      const type = grant.scope.scopeType ?? grant.scope.resourceType ?? "organization",
        id = grant.scope.scopeId ?? grant.scope.resourceId;
      const conditions = "conditions" in grant ? grant.conditions : undefined;
      const candidate: Resource = {
        type: "task",
        organizationId: this.organizationId,
        assignedPersonId: personId,
        assignedUserAccountId: accounts.find((a) => a.id === ctx.userAccountId)?.id ?? accounts[0]?.id,
        status: conditions?.statuses?.[0],
        ...(type === "property"
          ? { propertyId: id }
          : type === "city"
            ? { city: id }
            : type === "region"
              ? { region: id }
              : type === "job" || type === "task"
                ? { id, jobId: id }
                : type === "reservation"
                  ? { reservationId: id }
                  : {})
      };
      if (
        !authorize({ ...ctx, assignments: [grant], permissions: grant.permissions }, "view", candidate)
      )
        continue;
      const scope: Prisma.OperationTaskWhereInput | null =
        !id || type === "organization"
          ? {}
          : type === "property"
            ? { propertyId: id }
            : type === "region"
              ? { property: { regionId: id } }
              : type === "city"
                ? { property: { cityId: id } }
                : type === "job" || type === "task"
                  ? { id }
                  : type === "reservation"
                    ? { reservationId: id }
                    : null;
      if (scope)
        filters.push({
          AND: [
            scope,
            ...(conditions?.statuses?.length ? [{ state: { in: [...conditions.statuses] } }] : []),
            ...(conditions?.assignedToMe
              ? [
                  {
                    OR: [
                      { assignedToPersonId: ctx.personId ?? "00000000-0000-4000-8000-000000000000" },
                      {
                        assignedToUserAccountId:
                          ctx.userAccountId ?? "00000000-0000-4000-8000-000000000000"
                      }
                    ]
                  }
                ]
              : [])
          ]
        });
    }
    if (!filters.length) return [];
    return this.tx.operationTask.findMany({
      where: {
        organizationId: this.organizationId,
        archivedAt: null,
        dueDate: { gte: from, lt: until },
        AND: [{ OR: filters }],
        OR: [
          { assignedToPersonId: personId },
          { assignedToUserAccountId: { in: accounts.map((a) => a.id) } }
        ]
      },
      include: { property: { select: { name: true, timezone: true, cityId: true, regionId: true } } },
      orderBy: [{ dueDate: "asc" }, { id: "asc" }],
      take: 501
    });
  }
  documents(personId: string) {
    return this.tx.teamDocument.findMany({
      where: {
        organizationId: this.organizationId,
        personId,
        archivedAt: null,
        confirmedAt: { not: null }
      },
      orderBy: { createdAt: "desc" },
      take: 100
    });
  }
  async wallet(personId: string) {
    const link = await this.tx.teamWallet.findFirst({
      where: { organizationId: this.organizationId, personId },
      include: { ledgerAccount: true }
    });
    if (!link) return null;
    const totals = await this.tx.posting.groupBy({
      by: ["currency", "side"],
      where: { organizationId: this.organizationId, ledgerAccountId: link.ledgerAccountId },
      _sum: { amount: true }
    });
    const balances = new Map<string, Money>();
    for (const row of totals) {
      const value = Money.of(row._sum.amount?.toString() ?? "0", row.currency);
      const current = balances.get(row.currency) ?? Money.zero(row.currency);
      balances.set(
        row.currency,
        row.side === link.ledgerAccount.normalSide ? current.add(value) : current.subtract(value)
      );
    }
    return {
      id: link.id,
      ledgerAccountId: link.ledgerAccountId,
      balances: [...balances.values()].map((v) => v.toJSON())
    };
  }
  walletMovements(ledgerAccountId: string, page: number) {
    return this.tx.posting.findMany({
      where: { organizationId: this.organizationId, ledgerAccountId },
      include: { transaction: { select: { reference: true, description: true, occurredAt: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 26,
      skip: (page - 1) * 25
    });
  }
  walletLink(personId: string) {
    return this.tx.teamWallet.findFirst({
      where: { organizationId: this.organizationId, personId },
      select: { id: true }
    });
  }
  async offboarding(personId: string) {
    const [wallet, person] = await Promise.all([this.wallet(personId), this.person(personId)]);
    const accounts = person?.userAccounts.map((a) => a.id) ?? [];
    const openTasks = await this.tx.operationTask.count({
      where: {
        organizationId: this.organizationId,
        archivedAt: null,
        state: { notIn: ["COMPLETED", "CANCELLED"] },
        OR: [{ assignedToPersonId: personId }, { assignedToUserAccountId: { in: accounts } }]
      }
    });
    return {
      openTasks,
      wallet,
      walletClear: !wallet?.balances.some(
        (b) => !Money.of(b.amount, b.currency).equals(Money.zero(b.currency))
      )
    };
  }
}
