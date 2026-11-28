import type { GuestHubFormGrant } from "@prisma/client";
import type { AccountActorContext } from "@/platform/authz/session-context";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { restoreAuthorizationCap } from "@/platform/authz/authorization-cap";
import { assertAccountAuthorization } from "@/platform/authz/current-authority";
import { verifyBytes } from "@/platform/auth/secret-encryption";
import { jsonbFingerprint } from "@/platform/http/command-fingerprint";
import { effectiveGuestHubServiceOrderPolicy, guestHubServiceOrderPolicySchema, GuestHubServiceOrderAccessError }
  from "../domain/guest-hub-service-order-policy";
import { GuestHubServiceOrderRepository } from "../infrastructure/guest-hub-service-order-repository";
import { activeGuestHubForm } from "./guest-hub-form-source";
import { captureGuestHubServiceOrderDelegation, guestHubServiceOrderDelegationPurpose, guestHubServiceOrderDelegationSnapshot,
  guestHubServiceOrderSettings } from "./guest-hub-service-order-grants";
import type { GuestHubCapabilityContext } from "./guest-hub-visit";

export async function activeGuestHubServiceOrder(context: Pick<GuestHubCapabilityContext, "tx" | "actual">,
  env: NodeJS.ProcessEnv = process.env, head?: GuestHubFormGrant | null) {
  const active = await activeGuestHubForm(context, {
    formKey: "SERVICE_ORDERS", settings: guestHubServiceOrderSettings, parsePolicy: raw => guestHubServiceOrderPolicySchema.parse(raw),
    effectivePolicy: effectiveGuestHubServiceOrderPolicy, AccessError: GuestHubServiceOrderAccessError
  }, env, head);
  const { tx, actual } = context;
  const { grant, grantFingerprint, now, policy } = active;
  const repository = new GuestHubServiceOrderRepository(tx, actual.row.organizationId);
  const stored = await repository.delegation(grant.id);
  if (!stored || stored.sourceFingerprint !== grant.sourceFingerprint || !/^[a-f0-9]{64}$/u.test(stored.signature)) {
    throw new GuestHubServiceOrderAccessError();
  }
  const { catalogRuleId, catalogRuleVersion, catalogFingerprint, orderingRuleId, orderingRuleVersion,
    orderingSnapshot, publicOffers, authorizationCapFingerprint, expiresAt } = stored;
  const captured = guestHubServiceOrderDelegationSnapshot.parse({ catalogRuleId, catalogRuleVersion, catalogFingerprint,
    orderingRuleId, orderingRuleVersion, orderingSnapshot, publicOffers, authorizationCapFingerprint });
  const binding = { organizationId: grant.organizationId, grantId: grant.id, grantFingerprint,
    sourceFingerprint: grant.sourceFingerprint, expiresAt: expiresAt.toISOString(), ...captured };
  const signature = Buffer.from(stored.signature, "hex");
  if (jsonbFingerprint(grant.authorizationCap) !== authorizationCapFingerprint ||
      !verifyBytes(Buffer.from(jsonbFingerprint(binding), "hex"), signature, stored.signatureVersion, guestHubServiceOrderDelegationPurpose, env)) {
    throw new GuestHubServiceOrderAccessError();
  }
  const deadline = new Date(Math.min(expiresAt.getTime(), grant.createdAt.getTime() + policy.releaseLifetimeSeconds * 1000));
  if (now >= deadline) throw new GuestHubServiceOrderAccessError();
  const authContext = restoreAuthorizationCap(grant.authorizationCap);
  if (authContext.userAccountId !== grant.createdBy || authContext.organizationId !== grant.organizationId || !authContext.personId) {
    throw new GuestHubServiceOrderAccessError();
  }
  const actor: AccountActorContext = { organizationId: grant.organizationId, actorId: grant.createdBy, authContext };
  const current = await authContextForAccountInTransaction(tx, actor.organizationId, actor.actorId);
  assertAccountAuthorization(actor, current, now, (["view", "create"] as const).map(action => ({ action,
    resource: { organizationId: actor.organizationId, type: "guest_hub_service_orders", id: actual.row.id,
      propertyId: actual.source.propertyId, reservationId: actual.source.reservationId, dataClass: "guest" }
  })), new GuestHubServiceOrderAccessError());
  const currentDelegation = guestHubServiceOrderDelegationSnapshot.parse((await captureGuestHubServiceOrderDelegation(
    actor, tx, actual.source, now, active.settings)).snapshot);
  if (currentDelegation.catalogRuleId !== catalogRuleId || currentDelegation.catalogFingerprint !== catalogFingerprint ||
      currentDelegation.orderingRuleId !== orderingRuleId || currentDelegation.orderingRuleVersion !== orderingRuleVersion ||
      jsonbFingerprint(currentDelegation.orderingSnapshot) !== jsonbFingerprint(orderingSnapshot)) {
    throw new GuestHubServiceOrderAccessError();
  }
  return { ...active, grant: { ...grant, expiresAt: deadline }, actor, repository, captured,
    offers: captured.publicOffers.filter(offer => policy.allowedServiceKeys.includes(offer.key)),
    fingerprint: jsonbFingerprint({ form: active.fingerprint, binding, signatureVersion: stored.signatureVersion, signature: stored.signature }) };
}
