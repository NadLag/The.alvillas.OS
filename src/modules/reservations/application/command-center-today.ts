import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { authorize, authorizeCollection, type AuthContext, type Resource } from "@/platform/authz/authorize";
import { taskResource } from "@/platform/authz/task-resource";
import { present } from "@/platform/authz/present";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { localizedText, localizedTextSchema, type LocalizedText } from "@/i18n/content";
import type { AppLocale } from "@/i18n/routing";
import { CommandCenterTodayRepository, type TodayProperty } from "../infrastructure/command-center-today-repository";
import type { ReservationActorContext } from "./reservation-access";

export const commandTodayGroups = ["arrivals", "departures", "turnovers", "incomplete"] as const;

type Entry = { id: string; date: string; propertyName: string | null; reference: string; status: string };
type Job = { id: string; date: string; propertyName: string | null; state: string; title: LocalizedText | null };
type Turnover = { propertyId: string; propertyName: string | null; date: string; arrivals: Entry[]; departures: Entry[] };
export async function getCommandCenterToday(actor: ReservationActorContext, deps: { db?: TenantTransactionRunner; now?: Date } = {}) {
  if (actor.actorId !== actor.authContext.userAccountId || actor.organizationId !== actor.authContext.organizationId) return null;
  const held = actor.authContext;
  if (!["reservation", "task"].some(type => authorizeCollection(held, "view", type))) return null;
  return withTenant(deps.db ?? prisma, actor.organizationId, async tx => {
    const now = deps.now ?? new Date();
    const current = { ...await authContextForAccountInTransaction(tx, actor.organizationId, actor.actorId), personId: actor.personId };
    const contexts: AuthContext[] = [held, current];
    const has = (type: string) => contexts.every(authority => authorizeCollection(authority, "view", type));
    const canViewReservations = has("reservation"), canViewJobs = has("task");
    if (!canViewReservations && !canViewJobs) return null;
    const repository = new CommandCenterTodayRepository(tx, actor.organizationId);
    const [stays, jobs] = await Promise.all([canViewReservations ? repository.stays(now) : [], canViewJobs ? repository.jobs(now) : []]);
    const canView = (resource: Resource) => contexts.every(authority => authorize(authority, "view", resource, now));
    const place = (property: TodayProperty) => ({ organizationId: actor.organizationId, propertyId: property.id, id: property.id,
      city: property.cityId ?? property.city, region: property.regionId ?? property.region });
    const name = (property: TodayProperty) => canView({ ...place(property), type: "property" }) ? property.name : null;
    const arrivals: Entry[] = [], departures: Entry[] = [], turns = new Map<string, Turnover>();
    for (const stay of stays) {
      const scope = { ...place(stay.property), type: "reservation", id: stay.id, reservationId: stay.id, status: stay.status };
      if (!canView(scope)) continue;
      const data = { id: stay.id, date: stay.localDay, propertyName: name(stay.property), reference: stay.reference, status: stay.status };
      const entry = present({ ...held, visibleDataClasses: new Set(["operational"]) }, "view", { ...scope, data }, {}, now) as Entry;
      const turnover = turns.get(stay.property.id) ?? { propertyId: stay.property.id, propertyName: data.propertyName, date: data.date, arrivals: [], departures: [] };
      if (stay.arrival) { arrivals.push(entry); turnover.arrivals.push(entry); }
      if (stay.departure) { departures.push(entry); turnover.departures.push(entry); }
      turns.set(stay.property.id, turnover);
    }
    const turnovers = [...turns.values()].filter(turn => turn.arrivals.some(arrival => turn.departures.some(departure => arrival.id !== departure.id)));
    const incomplete = jobs.flatMap(job => {
      const scope = taskResource(job);
      if (!canView(scope)) return [];
      const parsed = localizedTextSchema.safeParse(job.title);
      const data = { id: job.id, date: job.localDay, propertyName: name(job.property), state: job.state, title: parsed.success ? parsed.data : null };
      return [present({ ...held, visibleDataClasses: new Set(["operational"]) }, "view", { ...scope, data }, {}, now) as Job];
    });
    return { arrivals, departures, turnovers, incomplete, canViewReservations, canViewJobs };
  });
}

export function commandTaskTitle(title: LocalizedText | null, locale: AppLocale, fallback: string) {
  return title ? localizedText(title, locale) || fallback : fallback;
}
