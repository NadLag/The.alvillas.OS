import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { authorize, type Resource } from "@/platform/authz/authorize";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import type { TenantTransaction } from "@/platform/db/tenant";
import { Money } from "@/platform/money/money";
import { guestPaymentProvenanceSchema, GuestPaymentProvenanceSourceError } from "../domain/guest-payment-provenance";
import { guestPaymentContextSchema } from "../domain/guest-deposit-workspace";
import { serviceAllocationOwnerSchema } from "../domain/service-allocation-snapshot-schema";
import { GuestPaymentProvenanceRepository } from "../infrastructure/guest-payment-provenance-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import type { FinanceActorContext, recheckFinanceAuthorization } from "./finance-access";
import type { readGuestDepositSourceInTransaction } from "./guest-deposit-service";

type Source = Awaited<ReturnType<typeof readGuestDepositSourceInTransaction>>;
type Check = Parameters<typeof recheckFinanceAuthorization>[3][number];
const ownersSchema = z.object({ owners: z.array(serviceAllocationOwnerSchema.strip()).min(1) }).strip();

/** Called only after canonical receipt, original funding and cash-source authorization. */
export async function readGuestPaymentContext(ctx: FinanceActorContext, tx: TenantTransaction, source: Source) {
  const row = await new GuestPaymentProvenanceRepository(tx, ctx.organizationId).presentation(source.row.id);
  if (!row) return { provenance: null, checks: source.checks };
  const parsed = guestPaymentProvenanceSchema.safeParse(row.provenance), owners = ownersSchema.safeParse(row.financialSnapshot.rules);
  if (!parsed.success || !owners.success) throw new GuestPaymentProvenanceSourceError();
  const saved = parsed.data, original = source.snapshot;
  if (saved.organizationId !== ctx.organizationId || saved.transactionId !== source.row.id || saved.depositId !== original.source.depositId ||
    saved.operation !== original.operation || saved.recordedBy.userAccountId !== source.row.createdBy || saved.accountId !== row.accountId ||
    saved.booking.reservationId !== original.source.reservationId || saved.booking.propertyId !== original.source.propertyId || saved.claim.guestId !== original.source.guestId ||
    saved.booking.financialSnapshotId !== row.financialSnapshotId || saved.booking.financialSnapshotVersion !== row.financialSnapshot.version ||
    saved.claim.liabilityAccountId !== original.liabilityAccountId || !source.amount.equals(Money.of(saved.amount.amount, saved.amount.currency)) ||
    !isDeepStrictEqual(saved.relatedOwners, row.owners.map(({ ownerId, shareBps }) => ({ ownerId, shareBps }))) ||
    !isDeepStrictEqual(saved.relatedOwners, owners.data.owners.map(({ ownerId, shareBps }) => ({ ownerId, shareBps })))) throw new GuestPaymentProvenanceSourceError();
  const now = await new FinanceRepository(tx, ctx.organizationId).clock(), current = await authContextForAccountInTransaction(tx, ctx.organizationId, ctx.actorId), checks: Check[] = [...source.checks];
  function name(resource: Resource, value: string) {
    if (![ctx.authContext, current].every(auth => authorize(auth, "view", resource, now))) return null;
    checks.push({ action: "view", resource }); return value;
  }
  const personResource = (id: string, accountId: string): Resource => ({ ...source.resource, type: "team_member", id, financialRecordId: undefined, assignedPersonId: id, assignedUserAccountId: accountId, dataClass: "personal" });
  return { provenance: guestPaymentContextSchema.parse({ organizationName: row.organization.name, accountName: row.account.name,
    collectorName: name(personResource(row.collectorPersonId, row.collectorUserAccountId), row.collectorPerson.displayName),
    recordedByName: name(personResource(row.recordedPersonId, row.createdBy), row.recordedPerson.displayName),
    owners: owners.data.owners.map(owner => ({ name: name({ ...source.resource, type: "owner", id: owner.ownerId, ownerId: owner.ownerId, financialRecordId: undefined, dataClass: "personal" }, owner.ownerName) })),
    bookingSource: saved.booking.source, receivedAt: saved.receivedAt }), checks };
}
