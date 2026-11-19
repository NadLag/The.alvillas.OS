import { cache } from "react";
import type { Session } from "next-auth";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/platform/auth/session";
import type { AppLocale } from "@/i18n/routing";
import { canUseHousehold, householdAreas, householdIdSchema } from "../domain/household-access";
import { HouseholdRepository, PersonalAccessDenied, type HouseholdScope } from "../infrastructure/household-repository";
import { PersonalFinanceRepository } from "../infrastructure/personal-finance-repository";

const households = new HouseholdRepository();

export function personalIdentity(session: Session | null) {
  const user = session?.user;
  return user?.id && user.organizationId && !user.sessionRevoked && !user.securitySetupRequired
    ? { organizationId: user.organizationId, accountId: user.id } : null;
}

export const personalSession = cache(auth);

export async function requirePersonalSession(locale: AppLocale) {
  const session = await personalSession();
  if (session?.user?.securitySetupRequired) redirect(`/${locale}/app/security`);
  const identity = personalIdentity(session);
  if (!identity) redirect(`/${locale}/login?surface=personal`);
  return identity;
}

export async function personalHouseholdIds(session: Session | null) {
  const identity = personalIdentity(session);
  if (!identity) return [];
  try {
    return await households.listHouseholds(identity);
  } catch (error) {
    if (error instanceof PersonalAccessDenied) return [];
    throw error;
  }
}

export async function personalWorkspace<T>(
  locale: AppLocale, rawId: string,
  handle: (scope: HouseholdScope, finance: PersonalFinanceRepository) => Promise<T>
) {
  const id = householdIdSchema.safeParse(rawId);
  if (!id.success) notFound();
  const identity = await requirePersonalSession(locale);
  try {
    return await households.scoped(identity, id.data, (scope) =>
      handle(scope, new PersonalFinanceRepository(scope)));
  } catch (error) {
    if (error instanceof PersonalAccessDenied) notFound();
    throw error;
  }
}

export const personalNavigation = cache((locale: AppLocale, householdId: string) => personalWorkspace(locale, householdId, async (scope) => {
  const areas = ["members", ...householdAreas, "audit"] as const;
  return {
    name: await scope.name(), areas: areas.filter((area) => canUseHousehold(scope.authority, scope.id, area))
  };
}));

export { HouseholdRepository, PersonalAccessDenied, PersonalConflict } from "../infrastructure/household-repository";
export { PersonalFinanceRepository } from "../infrastructure/personal-finance-repository";
