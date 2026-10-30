import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Session } from "next-auth";
import {
  identityActorContextFromSession,
  IdentityAuthorizationError,
  type IdentityActorContext
} from "./identity-access";
import {
  assertPermissionGrantAllowed,
  createPersonProfile,
  updatePersonProfile,
  ensureStandardIdentitySetup
} from "./identity-service";
import { personProfileInputSchema, updatePersonProfileInputSchema } from "../domain/identity";
import {
  availabilitySchema,
  availabilityDecisionSchema,
  compensationSchema,
  compensationValue,
  teamAssignmentSchema,
  teamPageSchema,
  performance,
  walletLinkSchema,
  teamPolicyKey,
  teamPolicySchema
} from "../domain/team";
import { TeamRepository } from "../infrastructure/team-repository";
import { IdentityRepository } from "../infrastructure/identity-repository";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { authorize, type Resource, type Action } from "@/platform/authz/authorize";
import { recheckAccountAuthorization } from "@/platform/authz/current-authority";
import { present, catalogFieldPolicy } from "@/platform/authz/present";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { ensureLedgerAccount } from "@/platform/ledger/accounts";
import { fieldWalletQuerySchema, fieldWalletSnapshotSchema, walletHistoryPageSchema } from "../domain/field-wallet";

type Deps = { db?: TenantTransactionRunner; requestId?: string; propertyScopeId?: string | null };
export class TeamConflictError extends Error {}
export class TeamNotFoundError extends Error {}
export async function teamActorContextFromSession(session: Session | null, deps: Deps = {}) {
  if (session?.user?.organizationId && !session.user.securitySetupRequired) {
    await ensureStandardIdentitySetup(session.user.organizationId, deps);
    await withTenant(deps.db ?? prisma, session.user.organizationId, (tx) =>
      new TeamRepository(tx, session.user.organizationId).initializePolicy()
    );
  }
  const actor = await identityActorContextFromSession(session, deps);
  if (!actor || session?.user?.securitySetupRequired) return null;
  const scope = {
    organizationId: actor.organizationId,
    resourceType: "team_member",
    resourceId: actor.personId
  };
  const permissions = new Set(["team_member:view"]);
  return {
    ...actor,
    authContext: {
      ...actor.authContext,
      permissions: new Set([...actor.authContext.permissions, ...permissions]),
      assignments: [...(actor.authContext.assignments ?? []), { scope, permissions }],
      scopes: [...actor.authContext.scopes, scope]
    }
  };
}
export function assignmentResource(
  organizationId: string,
  assignment: {
    id?: string;
    scopeType: string;
    scopeId: string | null;
    personId?: string;
    cityId?: string | null;
    regionId?: string | null;
  },
  type = "team_member"
): Resource {
  return {
    type,
    id: assignment.personId ?? assignment.id,
    organizationId,
    region: assignment.regionId,
    city: assignment.cityId,
    ...(assignment.scopeType === "property"
      ? { propertyId: assignment.scopeId }
      : assignment.scopeType === "region"
        ? { region: assignment.scopeId }
        : assignment.scopeType === "city"
          ? { city: assignment.scopeId }
          : assignment.scopeType === "job"
            ? { jobId: assignment.scopeId }
            : {})
  };
}
function allowed(ctx: IdentityActorContext, action: Action, resource: Resource) {
  if (
    ctx.organizationId !== ctx.authContext.organizationId ||
    !authorize(ctx.authContext, action, resource)
  )
    throw new IdentityAuthorizationError();
}
export async function teamAudit(
  repository: TeamRepository,
  ctx: IdentityActorContext,
  action: string,
  resourceId: string,
  after: unknown,
  reason: string,
  deps: Deps
) {
  await writeAuditEvent(repository.tx, {
    organizationId: ctx.organizationId,
    actorId: ctx.actorId,
    action: `team.${action}`,
    resourceType: "team_member",
    resourceId,
    propertyScopeId: deps.propertyScopeId,
    after,
    reason,
    requestId: deps.requestId ?? randomUUID(),
    occurredAt: new Date()
  });
}
async function member(
  repository: TeamRepository,
  ctx: IdentityActorContext,
  personId: string,
  action: Action = "view"
) {
  const person = await repository.person(personId);
  if (!person) throw new TeamNotFoundError();
  if (!repository.can(ctx.authContext, action, person)) throw new IdentityAuthorizationError();
  return person;
}
export async function teamDirectory(ctx: IdentityActorContext, input: unknown, deps: Deps = {}) {
  const query = teamPageSchema.parse(input);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async (tx) => {
    const repository = new TeamRepository(tx, ctx.organizationId);
    const data = await repository.visiblePeople(ctx.authContext, query.search, query.page);
    return {
      ...data,
      people: data.people.map((p) => ({
        id: p.id,
        displayName: p.displayName,
        archived: Boolean(p.archivedAt)
      })),
      ...query,
      canCreate: authorize(ctx.authContext, "create", {
        type: "identity",
        organizationId: ctx.organizationId
      })
    };
  });
}
export async function saveTeamProfile(ctx: IdentityActorContext, input: unknown, deps: Deps = {}) {
  const raw = z.object({ personId: z.string().uuid().optional() }).passthrough().parse(input);
  if (raw.personId) return updatePersonProfile(ctx, updatePersonProfileInputSchema.parse(input), deps);
  return createPersonProfile(ctx, personProfileInputSchema.parse(input), deps);
}
export async function teamMember(ctx: IdentityActorContext, input: unknown, deps: Deps = {}) {
  const parsed = z
    .object({
      personId: z.string().uuid(),
      from: z.coerce.date(),
      until: z.coerce.date(),
      walletPage: walletHistoryPageSchema
    })
    .strict()
    .refine((v) => v.until > v.from && v.until.getTime() - v.from.getTime() <= 366 * 86400000)
    .parse(input);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async (tx) => {
    const repository = new TeamRepository(tx, ctx.organizationId);
    const person = await member(repository, ctx, parsed.personId);
    const resource = [
      repository.resource(person),
      ...person.roleAssignments.map((a) => assignmentResource(ctx.organizationId, a))
    ].find((r) => authorize(ctx.authContext, "view", r))!;
    const own = person.id === ctx.personId;
    const privateProfile = own || authorize(ctx.authContext, "edit", { ...resource, type: "identity" });
    const profile = present(
      { ...ctx.authContext, visibleDataClasses: new Set(privateProfile ? ["personal" as const] : []) },
      "view",
      {
        ...resource,
        data: {
          id: person.id,
          displayName: person.displayName,
          email: person.email,
          phone: person.phone,
          preferredLocale: person.preferredLocale,
          archived: Boolean(person.archivedAt)
        }
      },
      { email: { dataClass: "personal" }, phone: { dataClass: "personal" } }
    );
    const assignments = person.roleAssignments.filter(
      (a) => own || authorize(ctx.authContext, "view", assignmentResource(ctx.organizationId, a))
    );
    const financeAssignments = assignments.filter((a) =>
      authorize(ctx.authContext, "view", assignmentResource(ctx.organizationId, a, "staff_compensation"))
    );
    const canDocuments = authorize(
      ctx.authContext,
      "view",
      repository.resource(person, "staff_document")
    );
    const walletLink = await repository.walletLink(person.id);
    const walletResource = {
      ...repository.resource(person, "wallet"),
      id: walletLink?.id ?? person.id,
      walletId: walletLink?.id
    };
    const canWallet = authorize(ctx.authContext, "view", walletResource);
    const [
      compensation,
      availability,
      tasks,
      documents,
      wallet,
      roles,
      properties,
      regions,
      cities,
      organization,
      walletAccounts
    ] = await Promise.all([
      repository.compensationFor(financeAssignments.map((a) => a.id)),
      repository.availability(person.id),
      repository.tasks(person.id, parsed.from, parsed.until, ctx.authContext),
      canDocuments ? repository.documents(person.id) : [],
      canWallet ? repository.wallet(person.id) : null,
      authorize(ctx.authContext, "assign", { type: "role", organizationId: ctx.organizationId })
        ? new IdentityRepository(tx, ctx.organizationId).listRoles()
        : [],
      authorize(ctx.authContext, "assign", { type: "role", organizationId: ctx.organizationId })
        ? repository.properties()
        : [],
      authorize(ctx.authContext, "assign", { type: "role", organizationId: ctx.organizationId })
        ? repository.regions()
        : [],
      authorize(ctx.authContext, "assign", { type: "role", organizationId: ctx.organizationId })
        ? repository.cities()
        : [],
      repository.organization(),
      canWallet &&
      authorize(ctx.authContext, "view", {
        type: "financial_transaction",
        organizationId: ctx.organizationId
      })
        ? repository.walletAccounts()
        : []
    ]);
    const visibleTasks = tasks.filter((t) =>
      authorize(ctx.authContext, "view", {
        type: "task",
        organizationId: ctx.organizationId,
        id: t.id,
        jobId: t.id,
        propertyId: t.propertyId,
        city: t.property.cityId,
        region: t.property.regionId,
        reservationId: t.reservationId,
        assignedPersonId: t.assignedToPersonId,
        assignedUserAccountId: t.assignedToUserAccountId,
        status: t.state
      })
    );
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Africa/Casablanca",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(new Date());
    const walletMovements = wallet
      ? await repository.walletMovements(wallet.ledgerAccountId, parsed.walletPage)
      : [];
    const offboarding = canWallet ? await repository.offboarding(person.id) : null;
    const canUpload = authorize(
      ctx.authContext,
      "create",
      repository.resource(person, "staff_document")
    );
    const documentPolicy = canUpload
      ? await new ConfigRuleRepository(tx, ctx.organizationId).resolve({
          key: teamPolicyKey,
          scopes: [{ scopeType: "organization", scopeId: null }]
        })
      : null;
    await teamAudit(
      repository,
      ctx,
      "member.view",
      person.id,
      { privateProfile, canDocuments, canWallet },
      "Authorized staff record viewed",
      deps
    );
    return {
      profile,
      assignments: assignments.map((a) => ({
        id: a.id,
        role: a.role.name,
        scopeType: a.scopeType,
        scopeId: a.scopeId,
        validFrom: a.validFrom.toISOString(),
        validTo: a.validTo?.toISOString() ?? null,
        assignedToMe: Boolean(
          a.conditions &&
            typeof a.conditions === "object" &&
            !Array.isArray(a.conditions) &&
            a.conditions.assignedToMe === true
        ),
        canViewCompensation: authorize(
          ctx.authContext,
          "view",
          assignmentResource(ctx.organizationId, a, "staff_compensation")
        ),
        archived: Boolean(a.archivedAt),
        canCompensate:
          !a.archivedAt &&
          authorize(
            ctx.authContext,
            "view",
            assignmentResource(ctx.organizationId, a, "staff_compensation")
          ) &&
          authorize(
            ctx.authContext,
            "create",
            assignmentResource(ctx.organizationId, a, "staff_compensation")
          ),
        canRetire:
          !a.archivedAt &&
          a.userAccountId !== ctx.actorId &&
          authorize(ctx.authContext, "assign", assignmentResource(ctx.organizationId, a, "role")),
        compensation: compensation
          .filter((c) => c.assignmentId === a.id)
          .map((c) => {
            const data = {
              id: c.id,
              version: c.version,
              mode: c.mode,
              amount: c.amount.toString(),
              currency: c.currency,
              effectiveFrom: c.effectiveFrom.toISOString(),
              reason: c.reason
            };
            return present(
              { ...ctx.authContext, visibleDataClasses: new Set() },
              "view",
              { ...assignmentResource(ctx.organizationId, a, "staff_compensation"), data },
              catalogFieldPolicy<typeof data>("staff_compensation")
            ) as typeof data;
          })
      })),
      availability: availability.map((a) => ({
        id: a.id,
        kind: a.kind,
        startsOn: a.startsOn.toISOString().slice(0, 10),
        endsOn: a.endsOn.toISOString().slice(0, 10),
        status: a.status,
        reason: privateProfile ? a.reason : null
      })),
      tasks: visibleTasks.slice(0, 500).map((t) => ({
        id: t.id,
        property: t.property.name,
        dueDate: t.dueDate.toISOString().slice(0, 10),
        state: t.state,
        title: t.titleTranslations
      })),
      metrics:
        tasks.length > 500
          ? null
          : performance(
              visibleTasks.map((task) => ({
                ...task,
                today: new Intl.DateTimeFormat("en-CA", {
                  timeZone: task.property.timezone,
                  year: "numeric",
                  month: "2-digit",
                  day: "2-digit"
                }).format(new Date())
              })),
              today
            ),
      overflow: tasks.length > 500,
      documents: documents.map((d) => ({
        id: d.id,
        title: d.title,
        kind: d.kind,
        expiresOn: d.expiresOn?.toISOString().slice(0, 10) ?? null
      })),
      wallet: wallet
        ? (present(
            { ...ctx.authContext, visibleDataClasses: new Set() },
            "view",
            { ...walletResource, data: wallet },
            catalogFieldPolicy<typeof wallet>("wallet")
          ) as typeof wallet)
        : null,
      roles: roles.map((r) => ({ id: r.id, name: r.name })),
      properties,
      regions,
      cities,
      baseCurrency: organization.baseCurrency,
      walletAccounts,
      accounts: roles.length
        ? person.userAccounts.filter((a) => a.status === "ACTIVE").map((a) => ({ id: a.id }))
        : [],
      offboarding: offboarding
        ? { openTasks: offboarding.openTasks, walletClear: offboarding.walletClear }
        : null,
      walletMovements: walletMovements.slice(0, 25).map((p) => ({
        id: p.id,
        reference: p.transaction.reference,
        occurredAt: p.transaction.occurredAt.toISOString(),
        amount: p.amount.toString(),
        currency: p.currency,
        side: p.side
      })),
      walletNext: walletMovements.length > 25,
      walletPage: parsed.walletPage,
      canEdit: authorize(ctx.authContext, "edit", {
        type: "identity",
        organizationId: ctx.organizationId,
        id: person.id
      }),
      canInviteAccount: !person.archivedAt && !person.userAccounts.length && (["view", "create", "edit"] as const).every(action => authorize(ctx.authContext, action, { type: "identity", organizationId: ctx.organizationId, id: person.id })),
      canApprove: authorize(ctx.authContext, "approve", repository.resource(person)),
      canRequest: own || authorize(ctx.authContext, "edit", repository.resource(person)),
      canAssign: authorize(ctx.authContext, "assign", {
        type: "role",
        organizationId: ctx.organizationId
      }),
      canDocuments,
      canUpload,
      documentMaxBytes: documentPolicy
        ? teamPolicySchema.parse(documentPolicy.parsedValue).document_max_bytes
        : null,
      canArchiveDocument: authorize(
        ctx.authContext,
        "edit",
        repository.resource(person, "staff_document")
      ),
      canWallet,
      canLinkWallet:
        authorize(ctx.authContext, "create", repository.resource(person, "wallet")) &&
        authorize(ctx.authContext, "view", {
          type: "financial_transaction",
          organizationId: ctx.organizationId
        }),
      canCreateWalletAccount: authorize(ctx.authContext, "create", {
        type: "financial_transaction",
        organizationId: ctx.organizationId
      }),
      canOffboard:
        person.id !== ctx.personId &&
        authorize(ctx.authContext, "edit", { type: "identity", organizationId: ctx.organizationId }) &&
        canWallet
    };
  });
}

/** An employee's financial read; operational self-profile access grants no money access. */
export async function ownFieldWallet(ctx: IdentityActorContext, input: unknown, deps: Deps = {}) {
  const { page } = fieldWalletQuerySchema.parse(input);
  if (ctx.organizationId !== ctx.authContext.organizationId || ctx.actorId !== ctx.authContext.userAccountId ||
    ctx.personId !== ctx.authContext.personId || !ctx.authContext.permissions.has("wallet:view")) throw new IdentityAuthorizationError();
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const repository = new TeamRepository(tx, ctx.organizationId), link = await repository.walletLink(ctx.personId);
    const resource = { ...repository.resource({ id: ctx.personId }, "wallet"), id: link?.id ?? ctx.personId, walletId: link?.id };
    allowed(ctx, "view", resource);
    const person = await repository.person(ctx.personId);
    if (!person || person.archivedAt) throw new TeamNotFoundError();
    const financialAssignments = person.roleAssignments.filter(assignment =>
      authorize(ctx.authContext, "view", assignmentResource(ctx.organizationId, assignment, "staff_compensation")));
    const compensationVisible = financialAssignments.length > 0 || authorize(ctx.authContext, "view", repository.resource(person, "staff_compensation"));
    const [wallet, organization, compensation] = await Promise.all([
      repository.wallet(person.id), repository.organization(), repository.compensationFor(financialAssignments.map(row => row.id)),
    ]);
    const history = wallet ? await repository.walletMovements(wallet.ledgerAccountId, page) : [];
    const data = { balances: wallet?.balances ?? [], movements: history.slice(0, 25).map(row => ({ id: row.id,
      reference: row.transaction.reference, description: row.transaction.description, occurredAt: row.transaction.occurredAt.toISOString(),
      amount: row.amount.toString(), currency: row.currency, side: row.side as "DEBIT" | "CREDIT", bucket: row.bucket })) };
    const visible = present({ ...ctx.authContext, visibleDataClasses: new Set() }, "view", { ...resource, data }, catalogFieldPolicy<typeof data>("wallet")) as typeof data;
    const now = new Date(), currentTerms = new Map<string, (typeof compensation)[number]>();
    for (const term of compensation) if (term.effectiveFrom <= now && !currentTerms.has(term.assignmentId)) currentTerms.set(term.assignmentId, term);
    const snapshot = fieldWalletSnapshotSchema.parse({ organizationId: ctx.organizationId, userId: ctx.actorId, snapshotAt: now.toISOString(), page,
      linked: Boolean(wallet), baseCurrency: organization.baseCurrency, ...visible, hasNext: history.length > 25, compensationVisible,
      compensationTerms: [...currentTerms.values()].map(term => ({ id: term.id, mode: term.mode, amount: term.amount.toString(), currency: term.currency, effectiveFrom: term.effectiveFrom.toISOString() })) });
    await teamAudit(repository, ctx, "wallet.view.own", person.id, { walletId: link?.id ?? null, page, movementCount: visible.movements.length,
      compensationVisible }, "Employee viewed their authorized wallet", deps);
    return snapshot;
  }, { isolationLevel: "RepeatableRead" });
}

export async function assignTeamRole(ctx: IdentityActorContext, input: unknown, deps: Deps = {}) {
  const value = teamAssignmentSchema.parse(input);
  const resource = assignmentResource(ctx.organizationId, value, "role");
  allowed(ctx, "assign", resource);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async (tx) => {
    const repository = new TeamRepository(tx, ctx.organizationId);
    await repository.lock(value.personId);
    const person = await repository.person(value.personId);
    if (!person || person.archivedAt || !(await repository.scopeExists(value.scopeType, value.scopeId)))
      throw new TeamNotFoundError();
    const identity = new IdentityRepository(tx, ctx.organizationId);
    const role = await identity.findRoleSummaryById(value.roleId);
    if (!role) throw new TeamNotFoundError();
    assertPermissionGrantAllowed(ctx, role.permissionKeys, role.id, resource);
    if (
      person.roleAssignments.some(
        (a) =>
          !a.archivedAt &&
          a.roleId === value.roleId &&
          a.scopeType === value.scopeType &&
          a.scopeId === value.scopeId &&
          (!a.validTo || a.validTo > value.validFrom) &&
          (!value.validTo || a.validFrom < value.validTo)
      )
    )
      throw new TeamConflictError("Overlapping role assignment already exists");
    const activeAccounts = person.userAccounts.filter((a) => a.status === "ACTIVE");
    const account =
      value.userAccountId === null
        ? undefined
        : value.userAccountId
          ? activeAccounts.find((a) => a.id === value.userAccountId)
          : activeAccounts.length === 1
            ? activeAccounts[0]
            : undefined;
    if (
      (value.userAccountId && !account) ||
      (value.userAccountId === undefined && activeAccounts.length > 1)
    )
      throw new TeamConflictError("Select an active staff account for this person");
    const assignment = await identity.assignRole({
      ...value,
      userAccountId: account?.id,
      actorId: ctx.actorId,
      conditions: value.assignedToMe ? { assignedToMe: true } : undefined
    });
    await teamAudit(repository, ctx, "assignment.create", assignment.id, value, value.reason, deps);
    return assignment;
  });
}
export async function retireTeamRole(ctx: IdentityActorContext, input: unknown, deps: Deps = {}) {
  const value = z
    .object({ id: z.string().uuid(), reason: z.string().trim().min(6).max(500) })
    .strict()
    .parse(input);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async (tx) => {
    const repository = new TeamRepository(tx, ctx.organizationId);
    const assignment = await repository.assignment(value.id);
    if (!assignment) throw new TeamNotFoundError();
    allowed(ctx, "assign", assignmentResource(ctx.organizationId, assignment, "role"));
    if (assignment.userAccountId === ctx.actorId)
      throw new TeamConflictError("Cannot remove own access");
    await repository.lock(assignment.personId);
    const checks = await repository.offboarding(assignment.personId);
    if (checks.openTasks || !checks.walletClear)
      throw new TeamConflictError("Resolve open tasks and wallet movements before ending assignment");
    await repository.archiveAssignment(assignment.id);
    await teamAudit(
      repository,
      ctx,
      "assignment.retire",
      assignment.id,
      { archived: true },
      value.reason,
      deps
    );
  });
}
export async function saveTeamCompensation(ctx: IdentityActorContext, input: unknown, deps: Deps = {}) {
  const value = compensationSchema.parse(input);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async (tx) => {
    const repository = new TeamRepository(tx, ctx.organizationId);
    const assignment = await repository.assignment(value.assignmentId);
    if (!assignment || assignment.archivedAt || assignment.person.archivedAt)
      throw new TeamNotFoundError();
    allowed(ctx, "create", { ...assignmentResource(ctx.organizationId, assignment, "staff_compensation"), dataClass: "financial",
      assignedPersonId: assignment.personId, amount: value.amount, occurredAt: value.effectiveFrom });
    await repository.lock(assignment.personId);
    const recheck = async () => {
      const current = await repository.assignment(value.assignmentId);
      if (!current || current.personId !== assignment.personId || current.archivedAt || current.person.archivedAt ||
        current.scopeType !== assignment.scopeType || current.scopeId !== assignment.scopeId) throw new IdentityAuthorizationError();
      const resource = { ...assignmentResource(ctx.organizationId, current, "staff_compensation"), dataClass: "financial" as const,
        assignedPersonId: current.personId, amount: value.amount, occurredAt: value.effectiveFrom };
      await recheckAccountAuthorization(ctx, tx, await repository.clock(), [{ action: "create", resource }], new IdentityAuthorizationError());
    };
    await recheck();
    const previous = (await repository.compensation(assignment.id))[0];
    if (
      (previous?.version ?? 0) !== value.expectedVersion ||
      (previous && value.effectiveFrom <= previous.effectiveFrom)
    )
      throw new TeamConflictError("Compensation changed or effective date is not later");
    if (
      value.effectiveFrom < assignment.validFrom ||
      (assignment.validTo && value.effectiveFrom >= assignment.validTo)
    )
      throw new TeamConflictError("Compensation is outside assignment dates");
    if (!(await repository.currency(value.currency))) throw new TeamConflictError("Unknown currency");
    const config = await new ConfigRuleRepository(tx, ctx.organizationId).createVersion({
      key: "staff.compensation",
      scopeType: "role_assignment",
      scopeId: assignment.id,
      value: {
        compensation_type:
          value.mode === "PER_MONTH"
            ? "SALARY"
            : value.mode === "PER_JOB"
              ? "PER_TASK"
              : value.mode === "PER_HOUR"
                ? "HOURLY"
                : "CUSTOM",
        mode: value.mode,
        ...compensationValue(value)
      },
      effectiveFrom: value.effectiveFrom,
      createdBy: ctx.actorId,
      reason: value.reason
    });
    const row = await repository.createCompensation({
      assignmentId: assignment.id,
      configRuleId: config.id,
      version: value.expectedVersion + 1,
      mode: value.mode,
      ...compensationValue(value),
      effectiveFrom: value.effectiveFrom,
      createdBy: ctx.actorId,
      reason: value.reason
    });
    await teamAudit(
      repository,
      ctx,
      "compensation.create",
      row.id,
      {
        assignmentId: assignment.id,
        personId: assignment.personId,
        version: row.version,
        configRuleId: config.id
      },
      value.reason,
      { ...deps, propertyScopeId: assignment.scopeType === "property" ? assignment.scopeId : null }
    );
    await repository.flushGuards();
    await recheck();
    return { id: row.id };
  });
}
export async function requestTeamAvailability(
  ctx: IdentityActorContext,
  input: unknown,
  deps: Deps = {}
) {
  const value = availabilitySchema.parse(input);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async (tx) => {
    const repository = new TeamRepository(tx, ctx.organizationId);
    await repository.lock(value.personId);
    const person = await member(repository, ctx, value.personId);
    if (person.archivedAt) throw new TeamConflictError("Staff member has been offboarded");
    if (person.id !== ctx.personId) allowed(ctx, "edit", repository.resource(person));
    const row = await repository.createAvailability({
      ...value,
      startsOn: new Date(value.startsOn),
      endsOn: new Date(value.endsOn),
      status: "REQUESTED",
      createdBy: ctx.actorId
    });
    await teamAudit(
      repository,
      ctx,
      "availability.request",
      row.id,
      { personId: person.id, kind: row.kind, startsOn: row.startsOn, endsOn: row.endsOn },
      value.reason,
      deps
    );
    return { id: row.id };
  });
}
export async function decideTeamAvailability(
  ctx: IdentityActorContext,
  input: unknown,
  deps: Deps = {}
) {
  const value = availabilityDecisionSchema.parse(input);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async (tx) => {
    const repository = new TeamRepository(tx, ctx.organizationId);
    const row = await repository.findAvailability(value.id);
    if (!row) throw new TeamNotFoundError();
    await repository.lock(row.personId);
    const person = await member(repository, ctx, row.personId);
    if (!(value.decision === "CANCELLED" && row.status === "REQUESTED" && ctx.personId === row.personId))
      allowed(ctx, "approve", repository.resource(person));
    if (
      (value.decision !== "CANCELLED" && row.status !== "REQUESTED") ||
      ["CANCELLED", "REJECTED"].includes(row.status)
    )
      throw new TeamConflictError("Availability already decided");
    await repository.decideAvailability(row.id, value.decision, ctx.actorId);
    await teamAudit(
      repository,
      ctx,
      "availability.decide",
      row.id,
      { status: value.decision, personId: row.personId },
      value.reason,
      deps
    );
  });
}
export async function linkTeamWallet(ctx: IdentityActorContext, input: unknown, deps: Deps = {}) {
  const value = walletLinkSchema.parse(input);
  allowed(ctx, "create", { type: "wallet", organizationId: ctx.organizationId, id: value.personId });
  allowed(ctx, "view", {
    type: "financial_transaction",
    organizationId: ctx.organizationId,
    id: value.ledgerAccountId ?? undefined
  });
  if (!value.ledgerAccountId)
    allowed(ctx, "create", { type: "financial_transaction", organizationId: ctx.organizationId });
  return withTenant(deps.db ?? prisma, ctx.organizationId, async (tx) => {
    const repository = new TeamRepository(tx, ctx.organizationId);
    await repository.lock(value.personId);
    const person = await repository.person(value.personId);
    const account = value.ledgerAccountId
      ? await repository.ledgerAccount(value.ledgerAccountId)
      : await ensureLedgerAccount(tx, ctx.organizationId, {
          code: `STAFF_WALLET_${value.personId.replaceAll("-", "").toUpperCase()}`,
          name: value.accountName!,
          accountType: "STAFF_WALLET",
          normalSide: "DEBIT"
        });
    if (!person || person.archivedAt || !account) throw new TeamNotFoundError();
    const row = await repository.linkWallet(person.id, account.id, ctx.actorId);
    await teamAudit(
      repository,
      ctx,
      "wallet.link",
      row.id,
      { personId: person.id, ledgerAccountId: account.id },
      value.reason,
      deps
    );
  });
}
export async function offboardTeamMember(ctx: IdentityActorContext, input: unknown, deps: Deps = {}) {
  const value = z
    .object({ personId: z.string().uuid(), reason: z.string().trim().min(6).max(500) })
    .strict()
    .parse(input);
  allowed(ctx, "edit", { type: "identity", organizationId: ctx.organizationId });
  return withTenant(deps.db ?? prisma, ctx.organizationId, async (tx) => {
    const repository = new TeamRepository(tx, ctx.organizationId);
    await repository.lock(value.personId);
    const person = await repository.person(value.personId);
    if (!person) throw new TeamNotFoundError();
    const wallet = await repository.walletLink(person.id);
    allowed(ctx, "view", {
      type: "wallet",
      organizationId: ctx.organizationId,
      id: wallet?.id ?? person.id,
      walletId: wallet?.id
    });
    if (person.id === ctx.personId) throw new TeamConflictError("Cannot offboard yourself");
    const { deactivateAccount } = await import("./identity-service");
    const checks = await repository.offboarding(person.id);
    if (checks.openTasks || !checks.walletClear)
      throw new TeamConflictError("Resolve open tasks and wallet movements before offboarding");
    for (const account of person.userAccounts)
      await deactivateAccount(ctx, account.id, {
        ...deps,
        db: { $transaction: (callback) => callback(tx) }
      });
    await repository.archivePerson(person.id);
    await teamAudit(
      repository,
      ctx,
      "member.offboard",
      person.id,
      { archived: true },
      value.reason,
      deps
    );
  });
}
