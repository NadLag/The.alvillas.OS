import { z } from "zod";
import { captureAuthorizationCap } from "@/platform/authz/authorization-cap";
import { assertAccountAuthorization } from "@/platform/authz/current-authority";
import { signBytes } from "@/platform/auth/secret-encryption";
import { jsonbFingerprint } from "@/platform/http/command-fingerprint";
import { serviceCatalogMaximumItems } from "@/platform/config/service-catalog-policy";
import { serviceOrderPolicyKey, serviceOrderPolicySchema } from "@/platform/config/service-order-policy";
import { readNativeServiceCatalog } from "@/platform/services/guest-order-authority";
import { guestServiceOfferSchema, projectReleasedGuestServiceOffer } from "@/platform/services/guest-service-order-contracts";
import { categoryForGuestService, effectiveGuestHubServiceOrderPolicy, guestHubServiceOrderPolicyKey, guestHubServiceOrderPolicySchema,
  GuestHubServiceOrderAccessError, GuestHubServiceOrderConflictError } from "../domain/guest-hub-service-order-policy";
import { GuestHubServiceOrderRepository } from "../infrastructure/guest-hub-service-order-repository";
import { createGuestHubFormGrantService } from "./guest-hub-form-grants";
import { authenticateGuestHubFormGrant, guestHubFormSettings } from "./guest-hub-form-source";

const policyDefinition = {
  policyKey: guestHubServiceOrderPolicyKey,
  parsePolicy: (raw: unknown) => guestHubServiceOrderPolicySchema.parse(raw),
  assertPolicy: effectiveGuestHubServiceOrderPolicy,
  AccessError: GuestHubServiceOrderAccessError
};

export const guestHubServiceOrderDelegationSnapshot = z.object({
  catalogRuleId: z.uuid(),
  catalogRuleVersion: z.number().int().positive(),
  catalogFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  orderingRuleId: z.uuid(),
  orderingRuleVersion: z.number().int().positive(),
  orderingSnapshot: serviceOrderPolicySchema,
  publicOffers: z.array(guestServiceOfferSchema).min(1).max(serviceCatalogMaximumItems),
  authorizationCapFingerprint: z.string().regex(/^[a-f0-9]{64}$/u)
}).strict();

export const guestHubServiceOrderDelegationPurpose = "alvillas.guest-hub.service-order-delegation.v1";

const orderGrantDefinition = {
  formKey: "SERVICE_ORDERS",
  resourceType: "guest_hub_service_orders",
  reviewProtocol: "NATIVE_GUEST_SERVICE_ORDER_GRANT_REVIEW_V1",
  settings: (tx, organizationId, source, now) => guestHubFormSettings(tx, organizationId, source, now, policyDefinition),
  AccessError: GuestHubServiceOrderAccessError,
  ConflictError: GuestHubServiceOrderConflictError,
  extension: {
    context: async (actor, tx, source, now, settings) => {
      const policy = guestHubServiceOrderPolicySchema.parse(settings.snapshot.value);
      const catalog = await readNativeServiceCatalog(actor, tx, { propertyId: source.propertyId, source: source.bookingSource });
      const { repository, rule, witness } = catalog;
      if (!catalog.catalog || !rule || !witness || witness.lifecycle !== "ACTIVE") throw new GuestHubServiceOrderAccessError();

      const policyHead = await repository.resolveMetadata({ key: serviceOrderPolicyKey, scopes: catalog.scopes, asOf: now });
      const ordering = policyHead && await repository.sourceMetadataWitness(policyHead.id);
      if (!ordering?.createdBy || ordering.archivedAt || ordering.lifecycle !== "ACTIVE") throw new GuestHubServiceOrderAccessError();
      assertAccountAuthorization(actor, catalog.stored, catalog.now, (["view", "export"] as const).map(action => ({
        action, unconditional: true, resource: { ...catalog.scope, reservationId: source.reservationId,
          type: "config_rule", id: ordering.id, dataClass: "operational", occurredAt: ordering.createdAt }
      })), new GuestHubServiceOrderAccessError());
      const value = await repository.sourceWitness(ordering.id);
      if (!value || value.tuple !== ordering.tuple || value.xmin !== ordering.xmin) throw new GuestHubServiceOrderConflictError();

      const publicOffers = catalog.catalog.services
        .filter(item => item.available && item.order_terms && policy.allowed_service_keys.includes(item.key))
        .map(item => projectReleasedGuestServiceOffer({ key: item.key, name: item.name ?? null, description: item.description ?? null,
          available: true, pricingModel: item.pricing_model, amount: item.amount ?? null, currency: item.currency ?? null,
          orderTerms: item.order_terms ?? null }, categoryForGuestService(policy, item.key)));
      const snapshot = guestHubServiceOrderDelegationSnapshot.parse({ catalogRuleId: rule.id, catalogRuleVersion: rule.version,
        catalogFingerprint: catalog.fingerprint, orderingRuleId: ordering.id, orderingRuleVersion: ordering.version,
        orderingSnapshot: serviceOrderPolicySchema.parse(value.value), publicOffers,
        authorizationCapFingerprint: jsonbFingerprint(captureAuthorizationCap(actor.authContext)) });
      return { fingerprint: jsonbFingerprint({ snapshot, ordering }), policyIds: [rule.id, ordering.id], snapshot };
    },
    async record(actor, tx, grant, extension, deps) {
      const captured = guestHubServiceOrderDelegationSnapshot.parse(extension.snapshot);
      const policy = guestHubServiceOrderPolicySchema.parse(z.object({ value: z.unknown() }).parse(grant.policySnapshot).value);
      const original = authenticateGuestHubFormGrant(grant, deps.env ?? process.env, GuestHubServiceOrderAccessError);
      const expiresAt = new Date(Math.min(grant.expiresAt.getTime(), grant.createdAt.getTime() + policy.release_lifetime_seconds * 1000));
      const binding = { organizationId: actor.organizationId, grantId: grant.id, grantFingerprint: original.fingerprint,
        sourceFingerprint: grant.sourceFingerprint, expiresAt: expiresAt.toISOString(), ...captured };
      const signed = signBytes(Buffer.from(jsonbFingerprint(binding), "hex"), guestHubServiceOrderDelegationPurpose, deps.env);
      try {
        await new GuestHubServiceOrderRepository(tx, actor.organizationId).appendDelegation({
          grantId: grant.id, ...captured, sourceFingerprint: grant.sourceFingerprint, signatureVersion: signed.version,
          signature: signed.signature.toString("hex"), createdAt: grant.createdAt, expiresAt
        });
      } finally {
        signed.signature.fill(0);
      }
    }
  }
} satisfies Parameters<typeof createGuestHubFormGrantService>[0];

export const guestHubServiceOrderSettings = orderGrantDefinition.settings;
export const captureGuestHubServiceOrderDelegation = orderGrantDefinition.extension.context;
export const guestHubServiceOrderGrants = createGuestHubFormGrantService(orderGrantDefinition);
